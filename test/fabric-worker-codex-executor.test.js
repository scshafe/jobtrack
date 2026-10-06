'use strict';

// The codex agent-step executor: the frozen agent-step-result.v1 seam over a
// fake `codex exec --json` child. No codex binary, no network — the spawn is
// injected, and the JSONL it emits is the shape codex-cli 0.150 prints.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  codexArgs,
  createCodexAgentStepExecutor,
  parseCodexEvents,
  usageReceiptFromCodexEvents
} = require('../lib/fabric-worker-runner/codex-executor');
const { validateWorkerRequest } = require('../lib/fabric-worker-runner/contracts');

const DIGEST = 'a'.repeat(64);

function workerRequest(extra = {}) {
  return {
    schemaVersion: 'jobtrack-fabric-worker-request.v1',
    requestId: 'fw:test:codex-0001',
    node: 'opportunity.triage',
    subjectKind: 'opportunity',
    subjectId: 1,
    brief: 'You are the TRIAGE worker for a deterministic test. Do the deterministic thing.',
    harness: 'codex',
    model: 'gpt-5.6-sol',
    ...extra
  };
}

const stepRequest = () => ({ brief: { instructions: 'Static instructions.', inputArtifacts: [{ digest: DIGEST }] } });

/** A fake child: stdin captured, the scripted stdout lines emitted, then close(code). */
function fakeSpawn({ lines = [], stderr = '', code = 0, hang = false } = {}) {
  const calls = [];
  const spawn = (bin, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    let stdin = '';
    child.stdin.on('data', (chunk) => { stdin += chunk; });
    child.killed = null;
    child.kill = (sig) => { child.killed = sig; };
    calls.push({ bin, args, options, get stdin() { return stdin; } });
    if (!hang) {
      setImmediate(() => {
        for (const line of lines) child.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
        if (stderr) child.stderr.write(stderr);
        child.stdout.end(); child.stderr.end();
        setImmediate(() => child.emit('close', code));
      });
    }
    return child;
  };
  return { spawn, calls };
}

const HAPPY = [
  { type: 'thread.started', thread_id: '01a05f41-1e35-70e2-ad84-460e920b0e45' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'jobtrack --version' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Triage recorded: 1 opportunity advanced.' } },
  { type: 'turn.completed', usage: { input_tokens: 14345, cached_input_tokens: 9984, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 7 } }
];

test('codex: a completed turn yields the last agent message, the thread id, and a provider-reported receipt', async () => {
  const { spawn, calls } = fakeSpawn({ lines: HAPPY });
  const request = workerRequest();
  const executor = createCodexAgentStepExecutor(request, { spawn, expectedDigest: DIGEST, codexBin: '/opt/fake/codex' });
  const result = await executor.execute(stepRequest(), undefined);
  assert.equal(result.status, 'completed');
  assert.equal(result.output.schemaVersion, 'jobtrack-fabric-worker-report.v1');
  assert.equal(result.output.report, 'Triage recorded: 1 opportunity advanced.');
  assert.equal(result.output.agentSessionId, '01a05f41-1e35-70e2-ad84-460e920b0e45');
  assert.equal(result.usage.length, 1);
  const receipt = result.usage[0];
  assert.equal(receipt.trust, 'provider_reported');
  assert.equal(receipt.observedInputTokens, 14345);
  assert.equal(receipt.observedOutputTokens, 12, 'output + reasoning tokens');
  assert.equal(receipt.chargedTokens, 14357);
  assert.equal(receipt.observedCostMicroUsd, null, 'a subscription login reports no cost');
  assert.equal(receipt.chargedCostMicroUsd, 0);
  // The spawn: codex exec, JSONL, ephemeral, model pinned, prompt on stdin.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/opt/fake/codex');
  assert.equal(calls[0].args[0], 'exec');
  assert.ok(calls[0].args.includes('--json'));
  assert.ok(calls[0].args.includes('--ephemeral'));
  assert.ok(calls[0].args.includes('--skip-git-repo-check'));
  assert.deepEqual(calls[0].args.slice(-3), ['-m', 'gpt-5.6-sol', '-']);
  assert.match(calls[0].stdin, /^Static instructions\.\n\nYou are the TRIAGE worker/);
  assert.equal(calls[0].options.stdio[0], 'pipe');
  const configIndex = calls[0].args.indexOf('-c');
  assert.equal(calls[0].args.filter(arg => arg === '-c').length, 1);
  assert.equal(calls[0].args[configIndex + 1], `shell_environment_policy.set.PATH=${JSON.stringify(calls[0].options.env.PATH)}`);
  assert.equal(calls[0].options.env.PATH.split(path.delimiter)[0], path.resolve(__dirname, '../tools/gog/umich-bin'));
});

test('codex: no model pin means no -m flag; the argv is the whole statement of what the spawn permits', () => {
  const args = codexArgs({ scratch: '/tmp/s', lastMessagePath: '/tmp/s/last.txt', model: undefined, workerPath: '/reviewed/bin:/usr/bin' });
  assert.ok(!args.includes('-m'));
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.deepEqual(args.slice(0, 2), ['exec', '--json']);
  assert.equal(args[args.length - 1], '-');
});

test('codex: shell PATH is one JSON-encoded per-invocation config value, not another shell command or config override', () => {
  const workerPath = '/reviewed/quote"/back\\slash:/odd\npath:/usr/bin';
  const args = codexArgs({ scratch: '/tmp/s', lastMessagePath: '/tmp/s/last.txt', model: 'gpt-5.6-sol', workerPath });
  const configs = args.filter((_, index) => index > 0 && args[index - 1] === '-c');
  assert.deepEqual(configs, [`shell_environment_policy.set.PATH=${JSON.stringify(workerPath)}`]);
  assert.equal(JSON.parse(configs[0].slice('shell_environment_policy.set.PATH='.length)), workerPath);
  assert.deepEqual(args.slice(-3), ['-m', 'gpt-5.6-sol', '-']);
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
  for (const bad of [undefined, null, '', 3]) assert.throws(() => codexArgs({ scratch: '/tmp/s', lastMessagePath: '/tmp/l', workerPath: bad }), /GOG_SHARED_ROUTE_UNAVAILABLE/);
});

test('codex: checked environment is prepared once inside the caught spawn path; missing route cannot launch a child', async () => {
  const script = path.resolve(__dirname, '../lib/fabric-worker-runner/codex-executor.js');
  const source = fs.readFileSync(script, 'utf8');
  for (const missingRoute of [false, true]) {
    let environments = 0;
    const { spawn, calls } = fakeSpawn({ lines: HAPPY });
    const mod = { exports: {} };
    vm.runInNewContext(source, { module: mod, process, Date, setTimeout, clearTimeout,
      require(name) {
        if (name === '../../scripts/lib/gog-environment.cjs') return { gogWorkerEnvironment() {
          environments++;
          if (missingRoute) throw new Error('GOG_SHARED_ROUTE_UNAVAILABLE');
          return { PATH: '/checked/route:/usr/bin', GOG_KEYRING_BACKEND: 'keychain' };
        } };
        if (name.startsWith('.')) return require(path.resolve(path.dirname(script), name));
        return require(name);
      }
    });
    const executor = mod.exports.createCodexAgentStepExecutor(workerRequest(), { spawn, expectedDigest: DIGEST });
    const result = await executor.execute(stepRequest(), undefined);
    assert.equal(environments, 1);
    assert.equal(calls.length, missingRoute ? 0 : 1);
    assert.equal(result.status, missingRoute ? 'infra_error' : 'completed');
    if (missingRoute) assert.equal(result.failure.detail, 'GOG_SHARED_ROUTE_UNAVAILABLE');
    else {
      const index = calls[0].args.indexOf('-c');
      assert.equal(calls[0].args[index + 1], `shell_environment_policy.set.PATH=${JSON.stringify(calls[0].options.env.PATH)}`);
    }
  }
});

test('codex: junk stdout with exit 0 is a TERMINAL failed turn (unusable_output), receipt unavailable', async () => {
  const { spawn } = fakeSpawn({ lines: ['not json at all', '{"type":"turn.started"}'], code: 0 });
  const executor = createCodexAgentStepExecutor(workerRequest(), { spawn, expectedDigest: DIGEST });
  const result = await executor.execute(stepRequest(), undefined);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.kind, 'unusable_output');
  assert.equal(result.usage[0].trust, 'unavailable');
  assert.equal(result.usage[0].chargedTokens, 1, 'never a silent zero');
});

test('codex: an error event (or a non-zero exit) is agent_error with the message as detail', async () => {
  const { spawn } = fakeSpawn({
    lines: [
      { type: 'thread.started', thread_id: 't-1' },
      { type: 'error', message: 'stream disconnected before completion: 401 Unauthorized' }
    ],
    code: 1
  });
  const executor = createCodexAgentStepExecutor(workerRequest(), { spawn, expectedDigest: DIGEST });
  const result = await executor.execute(stepRequest(), undefined);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.kind, 'agent_error');
  assert.match(result.failure.detail, /401 Unauthorized/);
});

test('codex: a message with a non-zero exit is still failed, never completed', async () => {
  const { spawn } = fakeSpawn({ lines: HAPPY, code: 2 });
  const executor = createCodexAgentStepExecutor(workerRequest(), { spawn, expectedDigest: DIGEST });
  const result = await executor.execute(stepRequest(), undefined);
  assert.equal(result.status, 'failed');
  assert.equal(result.usage[0].observedInputTokens, 14345, 'the receipt survives the failure');
});

test('codex: the turn deadline kills the child and reports timed_out (retryable in the port taxonomy)', async () => {
  const { spawn, calls } = fakeSpawn({ hang: true });
  const executor = createCodexAgentStepExecutor(workerRequest(), { spawn, expectedDigest: DIGEST });
  const controller = new AbortController();
  const pending = executor.execute(stepRequest(), controller.signal);
  setImmediate(() => controller.abort());
  const result = await pending;
  assert.equal(result.status, 'timed_out');
  assert.equal(result.failure.kind, 'deadline');
  assert.equal(calls.length, 1);
});

test('codex: a sealed-input digest mismatch is refused before any spawn', async () => {
  const { spawn, calls } = fakeSpawn({ lines: HAPPY });
  const executor = createCodexAgentStepExecutor(workerRequest(), { spawn, expectedDigest: 'b'.repeat(64) });
  const result = await executor.execute(stepRequest(), undefined);
  assert.equal(result.status, 'infra_error');
  assert.equal(result.failure.kind, 'input_artifact_mismatch');
  assert.equal(calls.length, 0);
});

test('codex: a spawn that throws (binary missing) is infra_error spawn_failed', async () => {
  const spawn = () => { throw new Error('spawn codex ENOENT'); };
  const executor = createCodexAgentStepExecutor(workerRequest(), { spawn, expectedDigest: DIGEST });
  const result = await executor.execute(stepRequest(), undefined);
  assert.equal(result.status, 'infra_error');
  assert.match(result.failure.detail, /ENOENT/);
});

test('codex: event parsing ignores junk lines; a receipt without turn.completed is unavailable', () => {
  const events = parseCodexEvents('garbage\n{"type":"turn.started"}\n{"type":"item.completed","item":{"type":"agent_message","text":"x"}}\n');
  assert.equal(events.length, 2);
  assert.equal(usageReceiptFromCodexEvents(events, 42).trust, 'unavailable');
  assert.equal(usageReceiptFromCodexEvents([{ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } }], 42).chargedTokens, 5);
});

test('request contract: harness is optional and closed (claude | codex)', () => {
  assert.equal(validateWorkerRequest(workerRequest()).harness, 'codex');
  assert.equal(validateWorkerRequest(workerRequest({ harness: 'claude' })).harness, 'claude');
  const { harness, ...withoutHarness } = workerRequest();
  assert.equal(validateWorkerRequest(withoutHarness).harness, undefined);
  assert.throws(() => validateWorkerRequest(workerRequest({ harness: 'gemini' })), /harness must be one of claude\|codex/);
});
