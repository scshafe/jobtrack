'use strict';

// The claude turn executor behind the fabric worker's agent node: a fresh
// headless `claude -p` session fed ONE brief, with tools, against the drill store
// and the loopback site. It speaks the frozen `agent-step-{request,result}.v1`
// executor seam — the same seam the test/stub executors speak — so the engine
// port above it (lib/fabric-worker-runner/pipeline.js) never knows which one it
// is talking to. Moved out of the v1 runner verbatim (docs/V2-ENGINE-PORT.md).

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { gogWorkerEnvironment } = require('../../scripts/lib/gog-environment.cjs');

const { REPORT_CONTRACT, MAX_REPORT_CHARS } = require('./contracts');

/**
 * The environment posture this turn DECLARES. mission-pipeline carries it;
 * nothing local enforces a container today — the descriptor is an honest
 * statement of what the claude spawn permits (model endpoint + local shell
 * tools + workspace writes), not a pretended sandbox. When the EAL's
 * descriptor⊆granted adapter is bound in front of a real environment, this is
 * the posture it will check.
 */
const WORKER_ENVIRONMENT = Object.freeze({
  schemaVersion: 'environment-descriptor.v1',
  network: 'egress-allowlist',
  capabilities: Object.freeze(['network:model', 'os:automation', 'filesystem:workspace']),
  mounts: Object.freeze([]),
  secretRefs: Object.freeze([]),
  io: Object.freeze({ mode: 'batch' })
});

const STATIC_INSTRUCTIONS = [
  'You are a JobTrack fabric stage worker. Your entire mission — identity,',
  'rules, protocol, and this item\'s specifics — is the briefing document',
  'carried as this step\'s input. Execute it exactly as written, then print',
  'a short factual report; the ledgers are the record, not your narration.'
].join(' ');

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 15)}\n…[truncated]` : value;
}

/** No trustworthy telemetry (a killed or junk turn): the schema's
 * 'unavailable' trust tier, charged at the frozen UNAVAILABLE_USAGE_FLOOR (1 token / 1 micro-USD — never a silent zero). */
function unavailableReceipt(elapsedMs) {
  return {
    schemaVersion: 'usage-receipt.v1',
    trust: 'unavailable',
    observedInputTokens: null,
    observedOutputTokens: null,
    chargedTokens: 1,
    observedCostMicroUsd: null,
    chargedCostMicroUsd: 1,
    durationMs: Math.max(1, Math.round(elapsedMs))
  };
}

function usageReceiptFrom(parsed, elapsedMs) {
  const usage = parsed?.usage ?? {};
  const observedInput = Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens : null;
  const observedOutput = Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens : null;
  const costMicro = Number.isFinite(parsed?.total_cost_usd)
    ? Math.max(0, Math.round(parsed.total_cost_usd * 1_000_000))
    : null;
  return {
    schemaVersion: 'usage-receipt.v1',
    trust: 'provider_reported',
    observedInputTokens: observedInput,
    observedOutputTokens: observedOutput,
    chargedTokens: (observedInput ?? 0) + (observedOutput ?? 0),
    observedCostMicroUsd: costMicro,
    chargedCostMicroUsd: costMicro ?? 0,
    durationMs: Number.isSafeInteger(parsed?.duration_ms) ? parsed.duration_ms : Math.max(1, Math.round(elapsedMs))
  };
}

/**
 * The AgentStepExecutor over a headless claude spawn. The step request
 * carries the brief only as a content-addressed artifact ref; this executor
 * is constructed WITH the request payload and proves the ref matches before
 * executing — content-addressing honored, not bypassed.
 */
function createClaudeAgentStepExecutor(workerRequest, options = {}) {
  const claudeBin = options.claudeBin ?? 'claude';
  const spawnFn = options.spawn ?? spawn;
  const expectedDigest = options.expectedDigest;
  return Object.freeze({
    async execute(stepRequest, signal) {
      const expected = expectedDigest;
      const ref = stepRequest.brief.inputArtifacts[0];
      if (!ref || ref.digest !== expected) {
        return {
          schemaVersion: 'agent-step-result.v1',
          status: 'infra_error',
          usage: [],
          failure: { kind: 'input_artifact_mismatch', detail: `sealed input digest ${ref?.digest ?? '(none)'} != payload digest ${expected}` }
        };
      }
      const prompt = `${stepRequest.brief.instructions}\n\n${workerRequest.brief}`;
      const started = Date.now();
      const args = ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'json',
        ...(workerRequest.model ? ['--model', workerRequest.model] : [])];
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-worker-turn-'));

      return await new Promise((resolve) => {
        let settled = false;
        const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
        let child;
        try {
          child = spawnFn(claudeBin, args, { cwd: scratch, env: gogWorkerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
          finish({ schemaVersion: 'agent-step-result.v1', status: 'infra_error', usage: [], failure: { kind: 'spawn_failed', detail: String(error.message) } });
          return;
        }
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const onAbort = () => {
          child.kill('SIGKILL');
          finish({ schemaVersion: 'agent-step-result.v1', status: 'timed_out', usage: [unavailableReceipt(Date.now() - started)], failure: { kind: 'deadline', detail: 'aborted by invoker deadline' } });
        };
        if (signal) {
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener('abort', onAbort, { once: true });
        }
        child.on('error', (error) => {
          finish({ schemaVersion: 'agent-step-result.v1', status: 'infra_error', usage: [], failure: { kind: 'spawn_failed', detail: String(error.message) } });
        });
        child.on('close', (code) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          const elapsedMs = Date.now() - started;
          let parsed = null;
          try { parsed = JSON.parse(stdout); } catch { /* junk output handled below */ }
          if (parsed && parsed.is_error !== true && typeof parsed.result === 'string' && code === 0) {
            finish({
              schemaVersion: 'agent-step-result.v1',
              status: 'completed',
              output: {
                schemaVersion: REPORT_CONTRACT,
                report: truncate(parsed.result || '(empty report)', MAX_REPORT_CHARS) || '(empty report)',
                ...(typeof parsed.session_id === 'string' ? { agentSessionId: parsed.session_id } : {}),
                ...(Number.isSafeInteger(parsed.num_turns) ? { numTurns: parsed.num_turns } : {})
              },
              usage: [usageReceiptFrom(parsed, elapsedMs)]
            });
            return;
          }
          // The agent ran and produced junk (or declared its own error):
          // TERMINAL per the port taxonomy — re-briefing is dispatcher judgment.
          finish({
            schemaVersion: 'agent-step-result.v1',
            status: 'failed',
            usage: parsed ? [usageReceiptFrom(parsed, elapsedMs)] : [unavailableReceipt(elapsedMs)],
            failure: {
              kind: parsed?.is_error ? 'agent_error' : 'unusable_output',
              detail: truncate(parsed?.result ?? stderr ?? `exit ${code}`, 4000) || `exit ${code}`
            }
          });
        });
      });
    }
  });
}

module.exports = Object.freeze({
  STATIC_INSTRUCTIONS,
  WORKER_ENVIRONMENT,
  createClaudeAgentStepExecutor,
  truncate,
  unavailableReceipt,
  usageReceiptFrom
});
