'use strict';

// The fabric wake spine (lib/fabric-wake.js): a durable wake journal + socket
// ping, due-at hints from derivation, and the daemon controller that turns
// wakes, due-ats and a safety tick into passes.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  consumeWakes, createFabricDaemonController, listPendingWakes, migrateFabricWake, nextWakeAt, pingWakeSocket, requestWake, runFabricDaemon, wakeSocketPath
} = require('../lib/fabric-wake');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

function runCli(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], { env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8' }));
}

function fakeTimers() {
  let now = 0; let sequence = 0; const timers = new Map();
  return {
    setTimer(callback, ms) { const id = ++sequence; timers.set(id, { at: now + ms, callback }); return id; },
    clearTimer(handle) { timers.delete(handle); },
    now: () => now,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, timer] = due[0]; timers.delete(id); now = timer.at; timer.callback();
        await new Promise((r) => setImmediate(r));
      }
      now = target;
    },
    pending: () => timers.size
  };
}

test('the wake journal records requests, lists what is pending, and consumes by time; the socket ping is best-effort and round-trips to a listening daemon', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-wake-'));
  const home = path.join(dir, 'store'); fs.mkdirSync(home);
  const db = new Database(path.join(home, 'jobtrack.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  migrateFabricWake(db);
  const first = await requestWake(db, { reason: 'test wake', source: 'unit', home });
  assert.equal(first.pinged, false, 'no daemon listening: the row still stands');
  assert.equal(first.socketPath, wakeSocketPath(home));
  assert.equal(listPendingWakes(db).length, 1);
  await assert.rejects(requestWake(db, { reason: '', home }), /reason is required/);
  // A daemon listening on the socket gets the ping.
  const pings = [];
  const server = net.createServer((c) => c.on('data', (d) => pings.push(String(d).trim())));
  await new Promise((r) => server.listen(wakeSocketPath(home), r));
  const second = await requestWake(db, { reason: 'ping me', source: 'unit', home });
  assert.equal(second.pinged, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(pings, ['wake']);
  await new Promise((r) => server.close(r));
  assert.equal(await pingWakeSocket(wakeSocketPath(home)), false, 'after the daemon is gone the ping fails quietly');
  // Consume everything requested so far; a later request stays pending.
  const upTo = new Date(Date.now() + 1000).toISOString();
  assert.equal(consumeWakes(db, { upTo }).consumed, 2);
  assert.equal(listPendingWakes(db).length, 0);
});

test('the daemon controller: a pass at start, wakes coalesce and queue exactly one follow-up, journal rows after a pass trigger another, due-at and safety tick fire, stop clears everything', async () => {
  const timers = fakeTimers();
  const passes = [];
  let release = null;
  let pendingRows = 0;
  let due = null;
  const consumed = [];
  const controller = createFabricDaemonController({
    runPass: async (reason) => { passes.push(reason); await new Promise((r) => { release = r; }); return { ok: true, summary: reason }; },
    timers, log: () => {}, now: () => Date.parse('2026-09-02T08:00:00Z') + timers.now(),
    safetyTickMs: 60_000, coalesceMs: 500,
    pendingWakes: () => pendingRows,
    consumeWakes: (upTo) => { consumed.push(upTo); pendingRows = 0; },
    nextWakeAt: () => due
  });
  controller.start();
  await timers.advance(0);
  assert.deepEqual(passes, ['startup']);
  assert.equal(controller.running, true);
  controller.wake('socket'); controller.wake('socket'); controller.wake('socket');
  release(); await new Promise((r) => setImmediate(r)); await timers.advance(0);
  assert.equal(passes.length, 2, 'three wakes during a pass → one follow-up pass');
  assert.equal(passes[1], 'socket');
  assert.equal(consumed.length, 1, 'the first pass consumed the journal up to its start');
  release(); await new Promise((r) => setImmediate(r));
  // Journal rows found after a pass (a ping that never arrived) start a pass.
  pendingRows = 2;
  controller.wake('socket');
  await timers.advance(500);
  assert.equal(passes.length, 3);
  // A due-at appears while pass 3 runs (derivation reads it when the pass ends
  // and re-arms its timers): 10 s later it fires a pass; nothing else pending.
  pendingRows = 0;
  due = new Date(Date.parse('2026-09-02T08:00:00Z') + timers.now() + 10_000).toISOString();
  release(); await new Promise((r) => setImmediate(r));
  const before = passes.length;
  await timers.advance(10_000);
  assert.equal(passes.length, before + 1);
  assert.match(passes[passes.length - 1], /^due-at /);
  due = null; release(); await new Promise((r) => setImmediate(r));
  // The idle safety tick.
  const beforeTick = passes.length;
  await timers.advance(60_000);
  assert.equal(passes.length, beforeTick + 1);
  assert.equal(passes[passes.length - 1], 'safety-tick');
  release(); await new Promise((r) => setImmediate(r));
  controller.stop();
  assert.equal(timers.pending(), 0);
  assert.equal(controller.passes, passes.length);
});

test('nextWakeAt picks the earliest future wakeAt across items and ignores the past', () => {
  const now = Date.parse('2026-09-02T08:00:00Z');
  const derivation = { subjects: [
    { items: [{ node: 'a', wakeAt: '2026-09-02T09:00:00.000Z' }, { node: 'b', act: { wakeAt: '2026-09-02T08:30:00.000Z' } }] },
    { items: [{ node: 'c', wakeAt: '2026-09-02T07:00:00.000Z' }, { node: 'd' }] }
  ] };
  assert.equal(nextWakeAt(derivation, now), '2026-09-02T08:30:00.000Z');
  assert.equal(nextWakeAt({ subjects: [{ items: [{ node: 'x' }] }] }, now), null);
});

test('the CLI: fabric wake records and reports; fabric wakes lists; an opportunity ingest wakes the fabric on its own', (t) => {
  const { root: dir, home } = require('../test-support/migrated-store').createTestStore('jt-wake-cli-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wake = runCli(home, ['fabric', 'wake', '--reason', 'relay-delivery', '--source', 'relay-listen']);
  assert.equal(wake.schemaVersion, 'jobtrack-fabric-wake.v1');
  assert.equal(wake.pinged, false);
  assert.ok(wake.wakeId >= 1);
  runCli(home, ['opportunity', 'ingest', '--source', 'manual', '--company', 'Drove', '--role', 'Platform Engineer', '--url', 'https://applysim.example.test/sites/drove/apply', '--description', 'x', '--observed-at', '2026-09-02T02:00:00Z', '--parser-name', 'manual-web-result', '--parser-version', '1', '--idempotency-key', 'wake-ingest-1']);
  const wakes = runCli(home, ['fabric', 'wakes']);
  assert.deepEqual(wakes.pending.map((w) => w.reason), ['relay-delivery', 'opportunity ingest: 1']);
  const next = runCli(home, ['fabric', 'next']);
  assert.equal(next.nextWakeAt ?? null, null, 'nothing time-bound is pending on a fresh store');
});

test('the daemon notices its store being replaced (archived + re-created under it) and exits on its own, so the supervisor restart re-binds the socket and journal to the fresh store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-wake-daemon-'));
  const home = path.join(dir, 'store');
  fs.mkdirSync(home);
  const db = new Database(path.join(home, 'jobtrack.db'));
  migrateFabricWake(db);
  const events = [];
  const stop = new AbortController();
  const run = runFabricDaemon({
    db, home, passCommand: 'true', deriveNext: () => ({ subjects: [] }), log: (event) => events.push(event),
    safetyTickMs: 60_000, coalesceMs: 10, signal: stop.signal, storeWatchMs: 20
  });
  const deadline = Date.now() + 5000;
  while (!events.some((event) => event.schemaVersion === 'jobtrack-fabric-daemon-started.v1') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(fs.existsSync(path.join(home, 'fabric.sock')), 'the daemon bound its socket in the store');
  // What an arc reset does: archive the store directory and create a fresh one.
  fs.renameSync(home, `${home}.prev`);
  fs.mkdirSync(home);
  new Database(path.join(home, 'jobtrack.db')).close();
  const exit = await Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(new Error('daemon did not exit after the store was replaced')), 5000))]);
  assert.equal(exit.schemaVersion, 'jobtrack-fabric-daemon-exit.v1');
  assert.equal(exit.storeReplaced, true);
  const notice = events.find((event) => event.schemaVersion === 'jobtrack-fabric-daemon-store-replaced.v1');
  assert.ok(notice, 'the exit is announced with the store-replaced event');
  assert.ok(['watchdog', 'pass'].includes(notice.noticedBy));
  assert.equal(fs.existsSync(path.join(home, 'fabric.sock')), false, 'the fresh store is left for the next daemon to bind');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
