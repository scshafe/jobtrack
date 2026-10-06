'use strict';

// The codex turn executor behind the fabric worker's agent node: a fresh
// headless `codex exec` session fed ONE brief, against the drill store and the
// loopback site, authenticated by the operator's ChatGPT (OAuth) login — no API
// key, no metered spend. It speaks the frozen `agent-step-{request,result}.v1`
// executor seam exactly like lib/fabric-worker-runner/claude-executor.js, so
// the engine port above it never knows which harness ran the turn. The worker
// request's `harness` field ('claude' | 'codex') picks the executor.
//
// Transport: `codex exec --json` prints JSONL events to stdout. The events this
// executor reads (codex-cli 0.150):
//   thread.started  {thread_id}                       -> agentSessionId
//   item.completed  {item:{type:'agent_message',text}} -> the report (last wins)
//   turn.completed  {usage:{input_tokens,cached_input_tokens,output_tokens,
//                           reasoning_output_tokens}}  -> the usage receipt
//   error           {message}                          -> agent_error detail
// The brief travels on stdin (`-` prompt), never argv: briefs run to tens of
// kilobytes and argv is neither private nor unbounded.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { gogWorkerEnvironment } = require('../../scripts/lib/gog-environment.cjs');

const { REPORT_CONTRACT, MAX_REPORT_CHARS } = require('./contracts');
const { STATIC_INSTRUCTIONS, WORKER_ENVIRONMENT, truncate, unavailableReceipt } = require('./claude-executor');

/** Parse the JSONL event stream; junk lines are ignored, never fatal. */
function parseCodexEvents(stdout) {
  const events = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { events.push(JSON.parse(trimmed)); } catch { /* not an event */ }
  }
  return events;
}

/** The turn's receipt from codex's turn.completed usage; cost is never
 * reported on a subscription login, so it is observed-null and charged 0 —
 * the tokens are still provider-reported and charged in full. */
function usageReceiptFromCodexEvents(events, elapsedMs) {
  const completed = events.filter((event) => event?.type === 'turn.completed').pop();
  const usage = completed?.usage;
  if (!usage || typeof usage !== 'object') return unavailableReceipt(elapsedMs);
  const int = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const observedInput = int(usage.input_tokens);
  const output = int(usage.output_tokens);
  const reasoning = int(usage.reasoning_output_tokens) ?? 0;
  const observedOutput = output === null ? null : output + reasoning;
  return {
    schemaVersion: 'usage-receipt.v1',
    trust: 'provider_reported',
    observedInputTokens: observedInput,
    observedOutputTokens: observedOutput,
    chargedTokens: (observedInput ?? 0) + (observedOutput ?? 0),
    observedCostMicroUsd: null,
    chargedCostMicroUsd: 0,
    durationMs: Math.max(1, Math.round(elapsedMs))
  };
}

function lastAgentMessage(events) {
  let text = null;
  for (const event of events) {
    if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      text = event.item.text;
    }
  }
  return text;
}

function errorDetail(events) {
  const errors = events.filter((event) => event?.type === 'error' || event?.type === 'turn.failed');
  if (!errors.length) return null;
  return errors.map((event) => event.message ?? event.error?.message ?? JSON.stringify(event)).join('\n');
}

/** Build the argv for one headless codex turn. Exported for the tests and for
 * the operator's eyes: this is the whole statement of what the spawn permits. */
function codexArgs({ scratch, lastMessagePath, model, workerPath }) {
  if (typeof workerPath !== 'string' || workerPath.length === 0) throw new Error('GOG_SHARED_ROUTE_UNAVAILABLE');
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--color', 'never',
    '-C', scratch,
    '-o', lastMessagePath,
    // Codex's tool shell need not preserve its own process PATH. Bind only
    // this invocation's shell PATH to the same checked route as spawn.env.
    '-c', `shell_environment_policy.set.PATH=${JSON.stringify(workerPath)}`,
    // Same posture as the claude executor's --dangerously-skip-permissions: the
    // brief drives the JobTrack CLI (writes OUTSIDE the scratch cwd) and reaches
    // the loopback site, which codex's workspace-write sandbox forbids. The
    // WORKER_ENVIRONMENT descriptor states this honestly.
    '--dangerously-bypass-approvals-and-sandbox',
    ...(model ? ['-m', model] : []),
    '-'
  ];
}

/**
 * The AgentStepExecutor over a headless codex spawn. Constructed WITH the
 * request payload and proves the sealed input ref matches before executing —
 * content-addressing honored, not bypassed (mirrors the claude executor).
 */
function createCodexAgentStepExecutor(workerRequest, options = {}) {
  const codexBin = options.codexBin ?? 'codex';
  const spawnFn = options.spawn ?? spawn;
  const expectedDigest = options.expectedDigest;
  return Object.freeze({
    async execute(stepRequest, signal) {
      const ref = stepRequest.brief.inputArtifacts[0];
      if (!ref || ref.digest !== expectedDigest) {
        return {
          schemaVersion: 'agent-step-result.v1',
          status: 'infra_error',
          usage: [],
          failure: { kind: 'input_artifact_mismatch', detail: `sealed input digest ${ref?.digest ?? '(none)'} != payload digest ${expectedDigest}` }
        };
      }
      const prompt = `${stepRequest.brief.instructions}\n\n${workerRequest.brief}`;
      const started = Date.now();
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-worker-turn-'));
      const lastMessagePath = path.join(scratch, 'last-message.txt');
      return await new Promise((resolve) => {
        let settled = false;
        const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
        let child;
        try {
          const environment = gogWorkerEnvironment();
          const args = codexArgs({ scratch, lastMessagePath, model: workerRequest.model, workerPath: environment.PATH });
          child = spawnFn(codexBin, args, { cwd: scratch, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
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
          finish({ schemaVersion: 'agent-step-result.v1', status: 'timed_out', usage: [unavailableReceipt(Date.now() - started)], failure: { kind: 'deadline', detail: 'aborted by the turn deadline' } });
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
          const events = parseCodexEvents(stdout);
          const receipt = usageReceiptFromCodexEvents(events, elapsedMs);
          let message = lastAgentMessage(events);
          if (message === null) {
            try { message = fs.readFileSync(lastMessagePath, 'utf8'); } catch { /* no last message written */ }
          }
          const errors = errorDetail(events);
          const threadId = events.find((event) => event?.type === 'thread.started')?.thread_id;
          if (code === 0 && errors === null && typeof message === 'string' && message.trim() !== '') {
            finish({
              schemaVersion: 'agent-step-result.v1',
              status: 'completed',
              output: {
                schemaVersion: REPORT_CONTRACT,
                report: truncate(message, MAX_REPORT_CHARS),
                ...(typeof threadId === 'string' ? { agentSessionId: threadId } : {})
              },
              usage: [receipt]
            });
            return;
          }
          // The agent ran and produced junk (or declared its own error):
          // TERMINAL per the port taxonomy — re-briefing is dispatcher judgment.
          finish({
            schemaVersion: 'agent-step-result.v1',
            status: 'failed',
            usage: [receipt],
            failure: {
              kind: errors !== null ? 'agent_error' : 'unusable_output',
              detail: truncate(errors ?? (message || stderr || `exit ${code}`), 4000) || `exit ${code}`
            }
          });
        });
        // The brief goes down stdin; EPIPE on an early exit is reported by 'close'.
        child.stdin.on('error', () => {});
        child.stdin.end(prompt);
      });
    }
  });
}

module.exports = Object.freeze({
  STATIC_INSTRUCTIONS,
  WORKER_ENVIRONMENT,
  codexArgs,
  createCodexAgentStepExecutor,
  parseCodexEvents,
  usageReceiptFromCodexEvents
});
