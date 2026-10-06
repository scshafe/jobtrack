'use strict';

// lib/fabric-wake.js — the fabric's WAKE SPINE (event-driven increment 2).
//
// The applicant loop used to run on a ten-minute timer: derive, dispatch,
// sleep, repeat, whether or not anything had changed. This module gives a
// store the two things a loop needs to be event-driven instead:
//
//   1. a durable wake journal (`fabric_wakeups`): any writer that changes the
//      store from OUTSIDE the pass — the relay delivering mail, the operator
//      ingesting a posting — records "wake me", and pings the daemon's local
//      socket so the pass starts within a second. The row is the truth; the
//      ping is only latency. A daemon that was down consumes the rows it finds
//      when it starts.
//   2. a due-at: derivation already knows when time alone will change the
//      picture (a retry window ending, an approval expiring, a transmit probe
//      worth repeating). deriveFabricNext reports the earliest such instant as
//      `nextWakeAt`; the daemon sleeps until then, or until a wake, or until
//      its slow safety tick — the level-triggered backstop that turns a lost
//      wake into latency, never a stall.
//
// The controller is pure (timers, pass, journal access injected) and tested
// with fakes; runFabricDaemon binds it to the socket, the store and a spawned
// pass command (the consumer owns the pass — for applysim, agent-loop.mjs).

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const FABRIC_WAKE_SCHEMA = 'jobtrack-fabric-wake.v1';
const DEFAULT_SAFETY_TICK_MS = 20 * 60 * 1000;
const DEFAULT_STORE_WATCH_MS = 15 * 1000;
const DEFAULT_COALESCE_MS = 500;

class FabricWakeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FabricWakeError';
    this.code = code;
  }
}

function migrateFabricWake(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fabric_wakeups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      consumed_at TEXT,
      uuid TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16))))
    );
    CREATE INDEX IF NOT EXISTS idx_fabric_wakeups_pending ON fabric_wakeups(consumed_at, requested_at);
  `);
}

/** The daemon's local socket for a store: beside the database, owner-only directory. */
function wakeSocketPath(home) {
  return path.join(home, 'fabric.sock');
}

function storeHome(db) {
  return path.dirname(db.name);
}

/** Best-effort ping: connect, say wake, hang up. Never throws; resolves to whether a daemon answered. */
function pingWakeSocket(socketPath, { timeoutMs = 750 } = {}) {
  return new Promise((resolvePing) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolvePing(value); } };
    let client;
    try {
      client = net.createConnection(socketPath);
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => { client.destroy(); finish(false); }, timeoutMs);
    client.on('connect', () => { client.end('wake\n'); });
    client.on('close', () => { clearTimeout(timer); finish(true); });
    client.on('error', () => { clearTimeout(timer); finish(false); });
  });
}

/**
 * Record a wake request and ping the daemon. The row survives a daemon that is
 * not running; the ping just makes it fast.
 * @returns {Promise<{ schemaVersion: string, wakeId: number, pinged: boolean, socketPath: string }>}
 */
async function requestWake(db, { reason, source = 'jobtrack-cli', home } = {}) {
  const text = String(reason ?? '').trim();
  if (!text || text.length > 200) throw new FabricWakeError('INVALID_INPUT', '--reason is required (at most 200 characters)');
  migrateFabricWake(db);
  const info = db.prepare('INSERT INTO fabric_wakeups(reason, source) VALUES (?, ?)').run(text, String(source).slice(0, 100));
  const socketPath = wakeSocketPath(home ?? storeHome(db));
  const pinged = await pingWakeSocket(socketPath);
  return { schemaVersion: FABRIC_WAKE_SCHEMA, wakeId: Number(info.lastInsertRowid), pinged, socketPath };
}

/** Fire-and-forget variant for command layers: never throws, never delays the caller's result. */
function requestWakeQuietly(db, input) {
  try {
    const pending = requestWake(db, input);
    pending.catch(() => undefined);
  } catch {
    /* the store change stands; a missed wake costs one safety tick */
  }
}

function listPendingWakes(db) {
  migrateFabricWake(db);
  return db.prepare('SELECT id, reason, source, requested_at FROM fabric_wakeups WHERE consumed_at IS NULL ORDER BY id').all()
    .map((row) => ({ wakeId: row.id, reason: row.reason, source: row.source, requestedAt: row.requested_at }));
}

/** Mark every pending wake requested at or before `upTo` as consumed by a pass. */
function consumeWakes(db, { upTo }) {
  migrateFabricWake(db);
  const info = db.prepare("UPDATE fabric_wakeups SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE consumed_at IS NULL AND requested_at <= ?").run(upTo);
  return { consumed: info.changes };
}

/** The earliest future instant named by a derivation's items (or null). */
function nextWakeAt(derivation, now = Date.now()) {
  let earliest = null;
  for (const subject of derivation?.subjects ?? []) {
    for (const item of subject.items ?? []) {
      const candidate = item.wakeAt ?? item.act?.wakeAt ?? null;
      const ms = candidate ? Date.parse(candidate) : NaN;
      if (!Number.isFinite(ms) || ms <= now) continue;
      if (earliest === null || ms < earliest) earliest = ms;
    }
  }
  return earliest === null ? null : new Date(earliest).toISOString();
}

/**
 * The daemon's policy, pure.
 * @param {{
 *   runPass: (reason: string) => Promise<{ ok: boolean, summary?: string }>,
 *   timers: { setTimer(cb: () => void, ms: number): unknown, clearTimer(handle: unknown): void },
 *   log: (event: object) => void,
 *   now?: () => number,
 *   safetyTickMs?: number, coalesceMs?: number,
 *   pendingWakes?: () => number,        // journal rows requested since the last consume
 *   consumeWakes?: (upTo: string) => void,
 *   nextWakeAt?: () => (string | null)  // the derivation's due-at after a pass
 * }} options
 */
function createFabricDaemonController(options) {
  const safetyTickMs = options.safetyTickMs ?? DEFAULT_SAFETY_TICK_MS;
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  const now = options.now ?? (() => Date.now());
  let stopped = false;
  let running = false;
  let pendingReason = null;
  let coalesceHandle = null;
  let safetyHandle = null;
  let dueHandle = null;
  let passes = 0;

  const clear = (handle) => { if (handle !== null) options.timers.clearTimer(handle); };

  const armTimers = () => {
    if (stopped) return;
    clear(safetyHandle);
    safetyHandle = options.timers.setTimer(() => { safetyHandle = null; schedule('safety-tick', 0); }, safetyTickMs);
    clear(dueHandle);
    dueHandle = null;
    const due = options.nextWakeAt ? options.nextWakeAt() : null;
    const dueMs = due ? Date.parse(due) - now() : NaN;
    if (Number.isFinite(dueMs)) {
      dueHandle = options.timers.setTimer(() => { dueHandle = null; schedule(`due-at ${due}`, 0); }, Math.max(0, dueMs));
    }
  };

  const runPass = async (reason) => {
    if (stopped) return;
    running = true;
    passes += 1;
    const startedAt = new Date(now()).toISOString();
    try {
      const result = await options.runPass(reason);
      options.log({ schemaVersion: 'jobtrack-fabric-daemon-pass.v1', reason, startedAt, ok: result?.ok !== false, summary: result?.summary ?? null });
    } catch (error) {
      options.log({ schemaVersion: 'jobtrack-fabric-daemon-pass-failure.v1', reason, startedAt, name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 300) });
    } finally {
      running = false;
      // Wakes requested before this pass began are answered by it; later ones
      // (or ones the ping never carried) start one more pass.
      try { options.consumeWakes?.(startedAt); } catch { /* journal hiccup: the safety tick covers it */ }
      const pendingRows = options.pendingWakes ? options.pendingWakes() : 0;
      armTimers();
      if (!stopped && (pendingReason !== null || pendingRows > 0)) {
        const next = pendingReason ?? `journal (${pendingRows} pending)`;
        pendingReason = null;
        schedule(next, 0);
      }
    }
  };

  const schedule = (reason, delayMs) => {
    if (stopped) return;
    if (running) {
      pendingReason = pendingReason ?? reason;
      return;
    }
    if (coalesceHandle !== null) return;
    coalesceHandle = options.timers.setTimer(() => { coalesceHandle = null; void runPass(reason); }, delayMs);
  };

  return {
    start() {
      stopped = false;
      const pendingRows = options.pendingWakes ? options.pendingWakes() : 0;
      schedule(pendingRows > 0 ? `startup (${pendingRows} pending wake(s))` : 'startup', 0);
    },
    wake(reason = 'wake') {
      schedule(reason, coalesceMs);
    },
    stop() {
      stopped = true;
      clear(coalesceHandle); clear(safetyHandle); clear(dueHandle);
      coalesceHandle = safetyHandle = dueHandle = null;
      pendingReason = null;
    },
    get running() { return running; },
    get passes() { return passes; }
  };
}

/** Run the consumer's pass command; resolve with its exit code and the last stdout line (the pass's JSON summary). */
function spawnPassCommand(command, { timeoutMs = 90 * 60 * 1000, env = process.env } = {}) {
  return new Promise((resolvePass) => {
    // Its own process group: a daemon restart must never kill a pass mid-worker
    // (that leaves the consumer's loop lock stale). The timeout signals the group.
    const child = spawn('/bin/bash', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'], env, detached: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-20000); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    const killGroup = (signal) => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } } };
    const timer = setTimeout(() => killGroup('SIGTERM'), timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const lines = stdout.trim().split('\n').filter(Boolean);
      resolvePass({ ok: code === 0 || code === 3, exitCode: code, signal: signal ?? null, summary: (lines[lines.length - 1] ?? '').slice(0, 600), stderr: stderr.trim().slice(-600) });
    });
    child.on('error', (error) => { clearTimeout(timer); resolvePass({ ok: false, exitCode: null, signal: null, summary: `spawn failed: ${error.message}`, stderr: '' }); });
  });
}

/**
 * The daemon process body: socket + journal + due-at + safety tick around a
 * pass command. Resolves when `signal` aborts.
 */
async function runFabricDaemon({ db, home, passCommand, deriveNext, log, safetyTickMs, coalesceMs, socketPath, signal, passTimeoutMs, env, storeWatchMs }) {
  if (!passCommand || typeof passCommand !== 'string') throw new FabricWakeError('INVALID_INPUT', '--pass-command is required');
  migrateFabricWake(db);
  const sock = socketPath ?? wakeSocketPath(home);
  try { fs.unlinkSync(sock); } catch { /* no stale socket */ }
  // The store can be replaced under a running daemon (an arc reset archives
  // ~/.jobtrack-applysim and re-creates it): the socket inode and the journal
  // this process holds then live in the archived directory, and every wake
  // recorded in the fresh store goes unheard until the safety tick. Watch for
  // it — socket path gone, or jobtrack.db no longer the file we opened — and
  // exit cleanly; the supervisor (launchd KeepAlive) restarts the daemon,
  // which re-binds and answers the pending wakes in its startup pass.
  const dbFile = path.join(home, 'jobtrack.db');
  const storeIdentity = () => { try { return fs.statSync(dbFile).ino; } catch { return null; } };
  const startIdentity = storeIdentity();
  const replaced = new AbortController();
  const storeReplaced = () => !fs.existsSync(sock) || storeIdentity() !== startIdentity;
  const noticeReplaced = (where) => {
    if (replaced.signal.aborted) return true;
    if (!storeReplaced()) return false;
    log({ schemaVersion: 'jobtrack-fabric-daemon-store-replaced.v1', socketPath: sock, dbFile, noticedBy: where });
    replaced.abort();
    return true;
  };
  const controller = createFabricDaemonController({
    runPass: async (reason) => {
      if (noticeReplaced('pass')) return { ok: true, summary: `${reason}: store replaced — exiting for a restart` };
      const result = await spawnPassCommand(passCommand, { timeoutMs: passTimeoutMs, env });
      return { ok: result.ok, summary: `${reason}: exit ${result.exitCode ?? result.signal} ${result.summary}`.slice(0, 700) };
    },
    timers: { setTimer: (callback, ms) => setTimeout(callback, ms), clearTimer: (handle) => clearTimeout(handle) },
    log,
    safetyTickMs,
    coalesceMs,
    pendingWakes: () => listPendingWakes(db).length,
    consumeWakes: (upTo) => consumeWakes(db, { upTo }),
    nextWakeAt: () => {
      try { return nextWakeAt(deriveNext()); } catch { return null; }
    }
  });
  const server = net.createServer((connection) => {
    connection.on('data', () => controller.wake('socket'));
    connection.on('error', () => undefined);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(sock, () => { server.off('error', rejectListen); resolveListen(); });
  });
  try { fs.chmodSync(sock, 0o600); } catch { /* best-effort */ }
  log({ schemaVersion: 'jobtrack-fabric-daemon-started.v1', socketPath: sock, safetyTickMs: safetyTickMs ?? DEFAULT_SAFETY_TICK_MS, passCommand: passCommand.slice(0, 200) });
  controller.start();
  const watchdog = setInterval(() => { noticeReplaced('watchdog'); }, storeWatchMs ?? DEFAULT_STORE_WATCH_MS);
  if (typeof watchdog.unref === 'function') watchdog.unref();
  await new Promise((resolveStop) => {
    if (signal.aborted || replaced.signal.aborted) { resolveStop(); return; }
    signal.addEventListener('abort', () => resolveStop(), { once: true });
    replaced.signal.addEventListener('abort', () => resolveStop(), { once: true });
  });
  clearInterval(watchdog);
  controller.stop();
  while (controller.running) await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
  await new Promise((resolveClose) => server.close(() => resolveClose()));
  try { fs.unlinkSync(sock); } catch { /* already gone */ }
  log({ schemaVersion: 'jobtrack-fabric-daemon-stopped.v1', passes: controller.passes, storeReplaced: replaced.signal.aborted });
  return { schemaVersion: 'jobtrack-fabric-daemon-exit.v1', passes: controller.passes, storeReplaced: replaced.signal.aborted };
}

module.exports = {
  DEFAULT_SAFETY_TICK_MS,
  FABRIC_WAKE_SCHEMA,
  FabricWakeError,
  consumeWakes,
  createFabricDaemonController,
  listPendingWakes,
  migrateFabricWake,
  nextWakeAt,
  pingWakeSocket,
  requestWake,
  requestWakeQuietly,
  runFabricDaemon,
  spawnPassCommand,
  wakeSocketPath
};
