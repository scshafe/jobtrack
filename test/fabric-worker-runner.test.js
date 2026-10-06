'use strict';

// The fabric worker runner on the pinned Mission Pipeline engine: durable
// evidence, idempotent replay, and the frozen agent-step retry taxonomy —
// proven with deterministic executors, no model calls.
//
// The suite is parametrised by engine so a second runner could be checked for
// parity; today there is one — mission-pipeline 1.0.0 (docs/V2-ENGINE-PORT.md).

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const v2 = require('../lib/fabric-worker-runner/pipeline');

const root = path.resolve(__dirname, '..');

function freshHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-fwr-'));
  const previous = process.env.JOBTRACK_HOME;
  process.env.JOBTRACK_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.JOBTRACK_HOME;
    else process.env.JOBTRACK_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function request(id, extra = {}) {
  return {
    schemaVersion: 'jobtrack-fabric-worker-request.v1',
    requestId: id,
    node: 'opportunity.triage',
    subjectKind: 'opportunity',
    subjectId: 1,
    brief: 'You are the TRIAGE worker for a deterministic test. Do the deterministic thing.',
    ...extra
  };
}

const completedResult = (report) => ({
  schemaVersion: 'agent-step-result.v1',
  status: 'completed',
  output: { schemaVersion: 'jobtrack-fabric-worker-report.v1', report },
  usage: [{
    schemaVersion: 'usage-receipt.v1', trust: 'provider_reported',
    observedInputTokens: 10, observedOutputTokens: 5, chargedTokens: 15,
    observedCostMicroUsd: 100, chargedCostMicroUsd: 100, durationMs: 50
  }]
});

function suite(label, { runFabricWorkerRequest, engineEnv, evidenceCheck }) {
  test(`${label}: a completed turn commits durable evidence and replays without a second agent`, async (t) => {
    const home = freshHome(t);
    let calls = 0;
    const executor = { async execute() { calls += 1; return completedResult('turn one'); } };

    const first = await runFabricWorkerRequest(request('replay-0001'), { executor });
    assert.equal(first.status, 'completed');
    assert.equal(first.report, 'turn one');
    assert.equal(first.evidence.replayed, false);
    assert.equal(first.usage.length, 1);
    assert.ok(fs.existsSync(path.join(home, 'pipeline-evidence.db')), 'evidence database exists beside the store');

    const replay = await runFabricWorkerRequest(request('replay-0001'), {
      executor: { async execute() { throw new Error('replay must not spawn a second agent'); } }
    });
    assert.equal(replay.status, 'completed');
    assert.equal(replay.report, 'turn one');
    assert.equal(replay.evidence.replayed, true);
    assert.equal(calls, 1);
  });

  test(`${label}: failed is TERMINAL: the agent ran and produced junk, and the engine never retries it`, async (t) => {
    freshHome(t);
    let calls = 0;
    const executor = {
      async execute() {
        calls += 1;
        return { schemaVersion: 'agent-step-result.v1', status: 'failed', usage: [{ schemaVersion: 'usage-receipt.v1', trust: 'unavailable', observedInputTokens: null, observedOutputTokens: null, chargedTokens: 1, observedCostMicroUsd: null, chargedCostMicroUsd: 1, durationMs: 5 }], failure: { kind: 'agent_error', detail: 'produced junk' } };
      }
    };
    const result = await runFabricWorkerRequest(request('terminal-001'), { executor, maxAttempts: 3 });
    assert.equal(result.status, 'failed');
    assert.equal(result.failure.kind, 'agent_step_failed');
    assert.equal(calls, 1, 'a terminal failure is never blindly retried, whatever the attempt budget says');
  });

  test(`${label}: infra_error is RETRYABLE within the attempt budget, then surfaces as failure`, async (t) => {
    freshHome(t);
    let calls = 0;
    const executor = {
      async execute() {
        calls += 1;
        if (calls === 1) {
          return { schemaVersion: 'agent-step-result.v1', status: 'infra_error', usage: [], failure: { kind: 'spawn_failed', detail: 'transient' } };
        }
        return completedResult('second attempt landed');
      }
    };
    const recovered = await runFabricWorkerRequest(request('retry-00001'), { executor, maxAttempts: 2 });
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.report, 'second attempt landed');
    assert.equal(calls, 2, 'the retryable failure earned exactly one more attempt');

    let always = 0;
    const exhausted = await runFabricWorkerRequest(request('retry-00002'), {
      executor: { async execute() { always += 1; return { schemaVersion: 'agent-step-result.v1', status: 'infra_error', usage: [], failure: { kind: 'spawn_failed', detail: 'still down' } }; } },
      maxAttempts: 2
    });
    assert.equal(exhausted.status, 'infra_error', 'exhausted retryable failures keep their typed status');
    assert.equal(exhausted.failure.kind, 'agent_step_infra_error');
    assert.equal(always, 2, 'the budget bounds retries');
  });

  test(`${label}: timed_out is retryable, and exhaustion surfaces as timed_out for the dispatcher`, async (t) => {
    freshHome(t);
    let calls = 0;
    const exhausted = await runFabricWorkerRequest(request('timeout-001'), {
      executor: {
        async execute() {
          calls += 1;
          return { schemaVersion: 'agent-step-result.v1', status: 'timed_out', usage: [{ schemaVersion: 'usage-receipt.v1', trust: 'unavailable', observedInputTokens: null, observedOutputTokens: null, chargedTokens: 1, observedCostMicroUsd: null, chargedCostMicroUsd: 1, durationMs: 5 }], failure: { kind: 'deadline', detail: 'too slow' } };
        }
      },
      maxAttempts: 2
    });
    assert.equal(exhausted.status, 'timed_out');
    assert.equal(exhausted.failure.kind, 'agent_step_timed_out');
    assert.equal(calls, 2, 'the timeout earned its bounded retry before surfacing');
  });

  test(`${label}: a report that violates the output contract is a terminal contract rejection, not a silent pass`, async (t) => {
    freshHome(t);
    const executor = {
      async execute() {
        return { schemaVersion: 'agent-step-result.v1', status: 'completed', output: { schemaVersion: 'jobtrack-fabric-worker-report.v1', report: '' }, usage: [{ schemaVersion: 'usage-receipt.v1', trust: 'unavailable', observedInputTokens: null, observedOutputTokens: null, chargedTokens: 1, observedCostMicroUsd: null, chargedCostMicroUsd: 1, durationMs: 5 }] };
      }
    };
    const result = await runFabricWorkerRequest(request('contract-001'), { executor });
    assert.equal(result.status, 'failed');
  });

  test(`${label}: the out-of-process runner speaks stdin/stdout with honest exit codes`, (t) => {
    const home = freshHome(t);
    const stub = path.join(home, 'stub-executor.js');
    fs.writeFileSync(stub, `
      'use strict';
      module.exports = {
        createExecutor(request) {
          return { async execute() {
            const receipt = { schemaVersion: 'usage-receipt.v1', trust: 'unavailable', observedInputTokens: null,
              observedOutputTokens: null, chargedTokens: 1, observedCostMicroUsd: null, chargedCostMicroUsd: 1, durationMs: 5 };
            if (request.requestId.includes('junk')) {
              return { schemaVersion: 'agent-step-result.v1', status: 'failed', usage: [receipt], failure: { kind: 'agent_error', detail: 'junk' } };
            }
            return { schemaVersion: 'agent-step-result.v1', status: 'completed',
              output: { schemaVersion: 'jobtrack-fabric-worker-report.v1', report: 'bin ok: ' + request.node }, usage: [receipt] };
          } };
        }
      };
    `);
    const env = { ...process.env, ...engineEnv, JOBTRACK_HOME: home, JOBTRACK_FABRIC_WORKER_EXECUTOR_MODULE: stub };
    const bin = path.join(root, 'bin', 'jobtrack-fabric-worker.js');

    const good = JSON.parse(execFileSync(process.execPath, [bin], {
      input: JSON.stringify(request('bin-00001')), env, encoding: 'utf8'
    }));
    assert.equal(good.status, 'completed');
    assert.equal(good.report, 'bin ok: opportunity.triage');

    let failedExit = null;
    let failedOut = '';
    try {
      execFileSync(process.execPath, [bin], { input: JSON.stringify(request('bin-junk-1')), env, encoding: 'utf8' });
    } catch (error) {
      failedExit = error.status;
      failedOut = String(error.stdout);
    }
    assert.equal(failedExit, 4, 'terminal agent junk exits 4');
    assert.equal(JSON.parse(failedOut).status, 'failed');

    let badExit = null;
    try {
      execFileSync(process.execPath, [bin], { input: '{"nope": true}', env, encoding: 'utf8' });
    } catch (error) {
      badExit = error.status;
    }
    assert.equal(badExit, 2, 'a bad request exits 2');
  });

}

suite('v2', {
  runFabricWorkerRequest: v2.runFabricWorkerRequest,
  engineEnv: {},
  evidenceCheck: (home) => {
    const db = new Database(path.join(home, 'pipeline-evidence.db'), { readonly: true });
    try {
      return {
        journey: db.prepare('SELECT unit_id, kind, node_id, outcome, error_code FROM engine_journey ORDER BY unit_id, sequence').all(),
        deadLetters: db.prepare('SELECT unit_id, error_code FROM engine_dead_letters').all(),
        graphs: db.prepare('SELECT graph_id, version FROM engine_graphs').all()
      };
    } finally {
      db.close();
    }
  }
});

// --- v2-only: the engine ledger the runner leaves behind ---------------------------

test('v2: the evidence database holds the sealed graph, the unit journey, and dead letters in engine_* tables', async (t) => {
  const home = freshHome(t);
  await v2.runFabricWorkerRequest(request('ledger-0001'), { executor: { async execute() { return completedResult('ledger ok'); } } });
  await v2.runFabricWorkerRequest(request('ledger-0002'), {
    executor: { async execute() { return { schemaVersion: 'agent-step-result.v1', status: 'infra_error', usage: [], failure: { kind: 'spawn_failed', detail: 'down' } }; } }
  });
  const db = new Database(path.join(home, 'pipeline-evidence.db'), { readonly: true });
  try {
    const graphs = db.prepare('SELECT graph_id, version, digest FROM engine_graphs').all();
    assert.deepEqual(graphs.map((row) => [row.graph_id, row.version]), [[v2.GRAPH_ID, v2.GRAPH_VERSION]]);
    assert.match(graphs[0].digest, /^[a-f0-9]{64}$/);
    const journey = db.prepare('SELECT unit_id, kind, outcome, error_code FROM engine_journey ORDER BY unit_id, sequence').all();
    assert.deepEqual(journey.filter((row) => row.unit_id === 'fabric-worker:ledger-0001').map((row) => [row.kind, row.outcome]),
      [['unit_admitted', null], ['turn_settled', 'completed']]);
    const failed = journey.filter((row) => row.unit_id === 'fabric-worker:ledger-0002');
    assert.equal(failed[0].kind, 'unit_admitted');
    assert.deepEqual(failed.slice(1).map((row) => [row.kind, row.error_code]),
      [['turn_failed', 'agent_step_infra_error'], ['turn_failed', 'agent_step_infra_error']], 'two attempts, both recorded');
    const dead = db.prepare('SELECT unit_id, error_code FROM engine_dead_letters').all();
    assert.deepEqual(dead, [{ unit_id: 'fabric-worker:ledger-0002', error_code: 'agent_step_infra_error' }]);
    const scopes = db.prepare('SELECT scope FROM engine_unit_state ORDER BY scope').all().map((row) => row.scope);
    assert.deepEqual(scopes, ['fabric-worker:ledger-0001', 'fabric-worker:ledger-0002'], 'one partition per unit — a runner can only claim its own');
  } finally {
    db.close();
  }
});

test('v2: the sealed graph is the same graph every run (identity is the digest, not the process)', async () => {
  const mp = await v2.loadEngine();
  const a = v2.buildWorkerGraph(mp);
  const b = v2.buildWorkerGraph(mp);
  assert.equal(a.graphDigest, b.graphDigest);
  assert.equal(a.graphId, v2.GRAPH_ID);
  assert.equal(a.version, v2.GRAPH_VERSION);
  assert.deepEqual(a.nodes.map((node) => [node.nodeId, node.kind, node.turn.maxAttempts]), [[v2.NODE_ID, 'agent', v2.MAX_ATTEMPTS]]);
  assert.deepEqual(a.terminals.map((terminal) => terminal.outcome).sort(), ['completed', 'failed']);
});
