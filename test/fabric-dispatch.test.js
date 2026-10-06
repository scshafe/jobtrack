'use strict';
// The production dispatcher (lib/fabric-dispatch.js): a pass over fakes —
// tick, staff, budget, lock — with no store, model or runner involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MAX_DISPATCHES_PER_ITEM, acquireLock, buildWorkerRequest, exitCodeFor, itemKey, readBudgets, runDispatchPass, summarizeWorkerResult, DEFAULT_MODELS } = require('../lib/fabric-dispatch');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-dispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake store: the dispatchable list shrinks as workers "complete" items. */
function fakeStore(items) {
  const pending = [...items];
  const performedOnce = { done: false };
  const jt = (args) => {
    if (args[0] === 'fabric' && args[1] === 'tick') {
      const performed = performedOnce.done ? [] : [];
      return {
        summary: { performed: performed.length, held: 0, parked: 0, dispatchable: pending.length, failed: 0 },
        performed, held: [], parked: [], failed: [],
        dispatchable: pending.map((item) => ({ node: item.node, subjectKind: item.subjectKind, subjectId: item.subjectId, instance: item.instance, reason: item.reason, blocked: item.blocked === true }))
      };
    }
    if (args[0] === 'fabric' && args[1] === 'next') {
      const subjectKind = args[2] === '--application-id' ? 'application' : 'opportunity';
      const subjectId = Number(args[3]);
      const rows = pending.filter((item) => item.subjectKind === subjectKind && item.subjectId === subjectId);
      return { subjects: rows.length ? [{ subjectKind, subjectId, label: `subject ${subjectId}`, items: rows.map((item) => ({ ...item, commands: [`jobtrack x --json`] })) }] : [] };
    }
    throw new Error(`unexpected jt ${args.join(' ')}`);
  };
  return { jt, pending };
}

const triage = (id) => ({ node: 'opportunity.triage', subjectKind: 'opportunity', subjectId: id, reason: `triage ${id}` });

test('a pass staffs eligible agent items in FIFO order through the runner, ticks between them, and records evidence', async (t) => {
  const passDir = tempDir(t);
  const store = fakeStore([triage(1), triage(2), { node: 'application.apply', subjectKind: 'application', subjectId: 9, reason: 'manual' }]);
  const requests = [];
  const runWorker = ({ request, shimDir, briefPath }) => {
    requests.push({ request, shimDir, briefPath });
    // The worker "did" the item: it leaves the dispatchable list.
    const index = store.pending.findIndex((item) => item.subjectId === request.subjectId && item.node === request.node);
    store.pending.splice(index, 1);
    return { status: 0, stdout: `${JSON.stringify({ schemaVersion: 'jobtrack-fabric-worker-result.v1', status: 'completed' })}\n`, stderr: '' };
  };
  const budgetsFile = path.join(passDir, 'budgets.json');
  const pass = await runDispatchPass({ storeHome: '/store', passDir, passKey: 'dispatch-1', jt: store.jt, runWorker, shimDir: '/shim', budgetsFile, log: () => {}, now: Date.now, harness: 'codex' });
  assert.equal(pass.outcome, 'waiting', 'the apply item stays dispatchable but unstaffed: someone must act');
  assert.deepEqual(pass.workers.map((worker) => [worker.node, worker.subjectId, worker.status, worker.attempt]), [['opportunity.triage', 1, 'completed', 1], ['opportunity.triage', 2, 'completed', 1]]);
  assert.equal(requests[0].request.schemaVersion, 'jobtrack-fabric-worker-request.v1');
  assert.equal(requests[0].request.requestId, 'fw:dispatch-1:01-opportunity.triage');
  assert.equal(requests[0].request.harness, 'codex');
  assert.equal(requests[0].request.model, 'gpt-6-astra', 'quality over speed: the codex harness defaults to its most capable model');
  assert.equal(DEFAULT_MODELS.claude, 'claude-fable-5-1', 'quality over speed: the claude harness defaults to the most capable model');
  assert.equal(requests[0].request.deadlineMs, 20 * 60_000);
  assert.match(requests[0].request.brief, /You are the TRIAGE worker for one discovered opportunity \(id 1\)/u);
  assert.equal(requests[0].shimDir, '/shim');
  assert.ok(fs.existsSync(path.join(passDir, 'workers', '01-opportunity.triage.md')));
  assert.match(fs.readFileSync(path.join(passDir, 'workers', '01-opportunity.triage.log'), 'utf8'), /engine completed/u);
  const budgets = readBudgets(budgetsFile);
  assert.equal(budgets['opportunity.triage:opportunity:1'].attempts, 1);
  assert.equal(budgets['opportunity.triage:opportunity:1'].lastStatus, 'completed');
  assert.equal(exitCodeFor(pass.outcome), 0);
});

test('the per-pass worker cap, the durable per-item budget, and a dry run', async (t) => {
  const passDir = tempDir(t);
  const budgetsFile = path.join(passDir, 'budgets.json');
  const failing = fakeStore([triage(5), triage(6)]);
  const runWorker = ({ request }) => ({ status: 4, stdout: `${JSON.stringify({ status: 'failed', failure: { kind: 'unusable_output', detail: 'junk' } })}\n`, stderr: '' });
  // Cap 1: one worker per pass, the second item waits for the next pass.
  const first = await runDispatchPass({ storeHome: '/store', passDir, passKey: 'p1', jt: failing.jt, runWorker, budgetsFile, log: () => {}, maxWorkers: 1 });
  assert.equal(first.outcome, 'capped');
  assert.equal(first.workers.length, 1);
  assert.equal(first.workers[0].status, 'failed');
  assert.equal(first.workers[0].failure.kind, 'unusable_output');
  // Second pass: item 5 gets its second (last) attempt, item 6 both of its
  // attempts (a failed item is re-briefed within the pass until its budget),
  // then everything staffable is exhausted → stalled, exit 3.
  const second = await runDispatchPass({ storeHome: '/store', passDir, passKey: 'p2', jt: failing.jt, runWorker, budgetsFile, log: () => {}, maxWorkers: 5 });
  assert.deepEqual(second.workers.map((worker) => [worker.subjectId, worker.attempt]), [[5, 2], [6, 1], [6, 2]]);
  assert.equal(second.outcome, 'stalled');
  // Third pass: nothing is staffed; the exhausted items are reported, not retried.
  const third = await runDispatchPass({ storeHome: '/store', passDir, passKey: 'p3', jt: failing.jt, runWorker, budgetsFile, log: () => {}, maxWorkers: 5 });
  assert.deepEqual(third.workers, []);
  assert.equal(third.outcome, 'stalled');
  assert.equal(third.skipped.length, 2);
  assert.match(third.skipped[0].reason, new RegExp(`budget exhausted \\(${MAX_DISPATCHES_PER_ITEM}/${MAX_DISPATCHES_PER_ITEM}\\)`));
  assert.equal(exitCodeFor(third.outcome), 3);
  // A dry run lists what it would staff without touching budgets or the runner.
  const before = fs.readFileSync(budgetsFile, 'utf8');
  const dry = await runDispatchPass({ storeHome: '/store', passDir, passKey: 'p4', jt: fakeStore([triage(7), triage(8)]).jt, runWorker: () => { throw new Error('never'); }, budgetsFile: path.join(passDir, 'other.json'), log: () => {}, dryRun: true });
  assert.deepEqual(dry.workers.map((worker) => [worker.subjectId, worker.status]), [[7, 'dry-run'], [8, 'dry-run']]);
  assert.equal(dry.outcome, 'dry-run');
  assert.equal(fs.existsSync(path.join(passDir, 'other.json')), false, 'a dry run persists no budget');
  assert.equal(fs.readFileSync(budgetsFile, 'utf8'), before);
});

test('a pass reports parked gates and stops on repeated tick failures', async (t) => {
  const passDir = tempDir(t);
  const parkedJt = (args) => args[1] === 'tick'
    ? { summary: { performed: 0, held: 0, parked: 1, dispatchable: 0, failed: 0 }, performed: [], held: [], failed: [], dispatchable: [], parked: [{ node: 'opportunity.pursue', subjectKind: 'opportunity', subjectId: 1 }] }
    : { subjects: [] };
  const parked = await runDispatchPass({ storeHome: '/store', passDir, passKey: 'p', jt: parkedJt, runWorker: () => { throw new Error('never'); }, budgetsFile: path.join(passDir, 'b.json'), log: () => {} });
  assert.equal(parked.outcome, 'parked');
  assert.deepEqual(parked.tick.parked, [{ node: 'opportunity.pursue', subjectKind: 'opportunity', subjectId: 1 }]);
  assert.equal(exitCodeFor('parked'), 3);
  let ticks = 0;
  const failingJt = (args) => {
    ticks += 1;
    return { summary: { performed: 0, held: 0, parked: 0, dispatchable: 0, failed: 1 }, performed: [], held: [], parked: [], dispatchable: [], failed: [{ node: 'application.package', subjectId: 2, error: { code: 'RENDER_FAILED', message: 'no docker' } }] };
  };
  const failed = await runDispatchPass({ storeHome: '/store', passDir, passKey: 'p', jt: failingJt, runWorker: () => { throw new Error('never'); }, budgetsFile: path.join(passDir, 'c.json'), log: () => {} });
  assert.equal(failed.outcome, 'failed');
  assert.equal(ticks, 3, 'three repeated failures of one item end the pass');
  assert.equal(exitCodeFor('failed'), 1);
});

test('the lock reclaims dead holders and refuses live ones; requests and results are shaped honestly', (t) => {
  const dir = tempDir(t);
  const release = acquireLock(dir, 60, { pid: 4242, isAlive: () => true });
  assert.equal(typeof release, 'function');
  assert.equal(acquireLock(dir, 60, { pid: 4343, isAlive: () => true }), null, 'a live holder keeps the lock');
  release();
  const dead = acquireLock(dir, 60, { pid: 5151, isAlive: () => true });
  assert.equal(typeof dead, 'function');
  const reclaimed = acquireLock(dir, 60, { pid: 6161, isAlive: () => false });
  assert.equal(typeof reclaimed, 'function', 'a dead holder is reclaimed at once');
  reclaimed();
  const request = buildWorkerRequest({ passKey: 'k', name: '01-x', item: { node: 'opportunity.triage', subjectKind: 'opportunity', subjectId: 1 }, brief: 'b'.repeat(50), harness: 'claude', model: 'claude-sonnet-5', workerMinutes: 5 });
  assert.equal(request.requestId, 'fw:k:01-x');
  assert.equal(request.deadlineMs, 300_000);
  assert.deepEqual(summarizeWorkerResult({ status: 5, stdout: 'noise\n{"status":"timed_out","failure":{"kind":"deadline","detail":"x"}}\n', stderr: '' }), { exitCode: 5, signal: null, engineStatus: 'timed_out', failure: { kind: 'deadline', detail: 'x' } });
  assert.equal(itemKey({ node: 'a.b', subjectKind: 'application', subjectId: 3, instance: 'resume' }), 'a.b:application:3:resume');
});
