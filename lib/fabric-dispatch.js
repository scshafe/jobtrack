'use strict';
// lib/fabric-dispatch.js — the PRODUCTION dispatcher (docs/FABRIC_PLAN.md §4):
// one bounded pass that turns the fabric's `dispatchable` agent work on the
// real store into worker turns. Tick, then staff the first eligible item the
// dispatcher staffs, then tick again — until nothing performs and nothing is
// staffable, or the per-pass worker cap or the deadline is reached. Every
// worker runs through the engine-backed runner (bin/jobtrack-fabric-worker.js:
// durable evidence, replay, the frozen taxonomy) on the codex harness by
// default, exactly as applysim's arcs do.
//
// What a pass never does: change a gate, approve anything, staff the apply
// node (it is `manual` on the real store until the operator says otherwise),
// or retry an item past its budget — a budget is durable across passes
// (<home>/fabric/dispatch-budgets.json) so a standing daemon cannot re-brief
// the same failing item forever.
//
// Every effect is behind a port (jt · runWorker · clock · fs) so the pass is
// provable without a store, a model, or a runner.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { STAFFED_NODES, briefFor } = require('./fabric-briefs');

const DISPATCH_SCHEMA_VERSION = 'jobtrack-fabric-dispatch-pass.v1';
const DEFAULT_MAX_WORKERS = 3;
const DEFAULT_WORKER_MINUTES = 20;
const DEFAULT_MAX_MINUTES = 60;
const DEFAULT_HARNESS = 'codex';
// Quality over speed for judgment nodes (operator directive, 2026-09-09): each
// harness defaults to its most capable model; pass --model to override either.
const DEFAULT_MODELS = Object.freeze({ codex: 'gpt-6-astra', claude: 'claude-fable-5-1' });
const MAX_DISPATCHES_PER_ITEM = 2;
const MAX_DISPATCHES_DRAFT = 4;
const MAX_REPEATED_TICK_FAILURES = 3;

class FabricDispatchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FabricDispatchError';
    this.code = code;
  }
}

function itemKey(item) {
  return `${item.node}:${item.subjectKind}:${item.subjectId}${item.instance ? `:${item.instance}` : ''}`;
}

function budgetFor(item) {
  return item.node === 'application.materials.draft' ? MAX_DISPATCHES_DRAFT : MAX_DISPATCHES_PER_ITEM;
}

/** The durable per-item dispatch ledger: attempts so far and the last outcome. */
function readBudgets(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeBudgets(file, budgets) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(budgets, null, 2)}\n`);
}

/**
 * An atomic directory lock so passes never overlap. The holder records its
 * pid; a lock whose holder is gone is reclaimed at once, one with no owner
 * record older than a minute is broken, and one held by a live process is
 * reclaimed only past 2× the pass budget.
 */
function acquireLock(dir, maxMinutes, { pid = process.pid, isAlive = processAlive, now = Date.now } = {}) {
  const lock = path.join(dir, '.dispatch-lock');
  try {
    fs.mkdirSync(lock, { recursive: false });
    fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify({ pid, startedAt: new Date(now()).toISOString() })}\n`);
    return () => fs.rmSync(lock, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const age = now() - fs.statSync(lock).mtimeMs;
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); } catch { owner = null; }
    const stale = owner
      ? (!isAlive(owner.pid) || age > maxMinutes * 2 * 60 * 1000)
      : age > 60 * 1000;
    if (!stale) return null;
    fs.rmSync(lock, { recursive: true, force: true });
    return acquireLock(dir, maxMinutes, { pid, isAlive, now });
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Run the jobtrack CLI against the store and parse its JSON; retries SQLITE_BUSY. */
function makeJt({ storeHome, nodePath, cliPath, env = process.env, spawn = spawnSync, sleep = (ms) => spawnSync('sleep', [String(ms / 1000)]) }) {
  return (args) => {
    for (let attempt = 1; ; attempt += 1) {
      const result = spawn(nodePath, [cliPath, ...args, '--json'], {
        env: { ...env, JOBTRACK_HOME: storeHome },
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 16 * 1024 * 1024
      });
      if (result.error) throw new FabricDispatchError('JOBTRACK_SPAWN_FAILED', `jobtrack ${args[0]} spawn failed: ${result.error.message}`);
      if (result.status !== 0) {
        if (attempt < 6 && /SQLITE_BUSY|database is locked/.test(String(result.stderr))) { sleep(2000); continue; }
        throw new FabricDispatchError('JOBTRACK_COMMAND_FAILED', `jobtrack ${args.join(' ')} failed: ${String(result.stderr).slice(0, 400)}`);
      }
      try {
        return JSON.parse(result.stdout);
      } catch {
        throw new FabricDispatchError('JOBTRACK_NON_JSON', `jobtrack ${args[0]} returned non-JSON: ${String(result.stdout).slice(0, 200)}`);
      }
    }
  };
}

/** A `jobtrack` shim on the worker PATH, so briefs read exactly as the operator docs do. */
function ensureJobtrackShim(passDir, { nodePath, cliPath }) {
  const binDir = path.join(passDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'jobtrack'), `#!/bin/sh\nexec ${JSON.stringify(nodePath)} ${JSON.stringify(cliPath)} "$@"\n`, { mode: 0o755 });
  return binDir;
}

/** The engine-backed worker request; requestId is unique per dispatch. */
function buildWorkerRequest({ passKey, name, item, brief, harness, model, workerMinutes }) {
  return {
    schemaVersion: 'jobtrack-fabric-worker-request.v1',
    requestId: `fw:${passKey}:${name}`,
    node: item.node,
    subjectKind: item.subjectKind ?? 'unknown',
    subjectId: item.subjectId ?? 0,
    ...(item.instance ? { instance: item.instance } : {}),
    brief,
    model,
    harness,
    deadlineMs: workerMinutes * 60 * 1000
  };
}

/** The real worker spawn: one engine-backed turn through bin/jobtrack-fabric-worker.js. */
function makeWorkerRunner({ storeHome, nodePath, runnerPath, env = process.env, spawn = spawnSync }) {
  return ({ request, shimDir }) => spawn(nodePath, [runnerPath], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: request.deadlineMs + 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...env, JOBTRACK_HOME: storeHome, PATH: `${shimDir}:${env.PATH ?? ''}` }
  });
}

function summarizeWorkerResult(result) {
  const lines = String(result.stdout ?? '').trim().split('\n').filter(Boolean);
  let document = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { document = JSON.parse(lines[index]); break; } catch { /* not the result line */ }
  }
  return {
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    engineStatus: document?.status ?? null,
    failure: document?.failure ? { kind: document.failure.kind ?? null, detail: String(document.failure.detail ?? '').slice(0, 300) } : null
  };
}

/**
 * One pass. Options:
 *   storeHome, passDir (evidence for this pass), budgetsFile, jt(args),
 *   runWorker({request, shimDir, briefPath}), shimDir, harness, model,
 *   maxWorkers, workerMinutes, maxMinutes, dryRun, staffedNodes, log, now,
 *   jobtrackRoot (for briefs that name repo scripts).
 */
async function runDispatchPass(options) {
  const {
    storeHome, passDir, passKey, jt, runWorker, log = () => {},
    now = Date.now, dryRun = false
  } = options;
  const staffedNodes = options.staffedNodes ?? STAFFED_NODES;
  const harness = options.harness ?? DEFAULT_HARNESS;
  const model = options.model ?? DEFAULT_MODELS[harness] ?? DEFAULT_MODELS.codex;
  const maxWorkers = options.maxWorkers ?? DEFAULT_MAX_WORKERS;
  const workerMinutes = options.workerMinutes ?? DEFAULT_WORKER_MINUTES;
  const maxMinutes = options.maxMinutes ?? DEFAULT_MAX_MINUTES;
  const budgetsFile = options.budgetsFile ?? path.join(storeHome, 'fabric', 'dispatch-budgets.json');
  const budgets = readBudgets(budgetsFile);
  const startedAt = new Date(now()).toISOString();
  const deadline = now() + maxMinutes * 60 * 1000;
  const workers = [];
  const skipped = [];
  const tickFailures = new Map();
  let iterations = 0;
  let outcome = 'quiescent';
  let stalledOn = null;
  let lastTick = null;
  const shimDir = options.shimDir ?? null;
  // A dry run plans each staffable item once; the store never moves under it.
  const planned = new Set();

  while (now() < deadline) {
    iterations += 1;
    const tick = jt(['fabric', 'tick']);
    lastTick = tick;
    const s = tick.summary ?? {};
    log(`[dispatch] tick ${iterations}: performed ${s.performed ?? 0}, held ${s.held ?? 0}, parked ${s.parked ?? 0}, dispatchable ${s.dispatchable ?? 0}, failed ${s.failed ?? 0}`);
    for (const done of tick.performed ?? []) {
      log(`[dispatch]   done ${done.node}${done.instance ? ` (${done.instance})` : ''} — ${done.summary ?? ''} [${done.actor ?? ''}]`);
    }
    let repeated = false;
    for (const failure of tick.failed ?? []) {
      const key = `${failure.node}:${failure.subjectId}:${failure.error?.code}`;
      const count = (tickFailures.get(key) ?? 0) + 1;
      tickFailures.set(key, count);
      log(`[dispatch]   tick failure ${failure.node ?? '(subject)'} (${count}×): ${String(failure.error?.message ?? '').slice(0, 160)}`);
      if (count >= MAX_REPEATED_TICK_FAILURES) repeated = { failure };
    }
    if (repeated) { outcome = 'failed'; stalledOn = repeated.failure; break; }
    if ((tick.performed ?? []).length > 0) continue;
    if ((tick.failed ?? []).length > 0) continue;

    const candidates = (tick.dispatchable ?? []).filter((entry) => staffedNodes.includes(entry.node) && !entry.blocked && !planned.has(itemKey(entry)));
    let staffable = null;
    for (const entry of candidates) {
      const key = itemKey(entry);
      const attempts = budgets[key]?.attempts ?? 0;
      if (attempts >= budgetFor(entry)) {
        if (!skipped.some((row) => row.key === key)) {
          skipped.push({ key, node: entry.node, subjectKind: entry.subjectKind, subjectId: entry.subjectId, reason: `budget exhausted (${attempts}/${budgetFor(entry)}); reset with fabric dispatch --reset-budgets` });
        }
        continue;
      }
      staffable = entry;
      break;
    }
    if (staffable === null) {
      if (dryRun && planned.size > 0) outcome = 'dry-run';
      else if ((tick.parked ?? []).length > 0) outcome = 'parked';
      else if (skipped.length > 0 && candidates.length > 0) outcome = 'stalled';
      else if ((tick.dispatchable ?? []).length > 0) outcome = 'waiting';
      else outcome = 'quiescent';
      if (outcome === 'stalled') stalledOn = skipped[0];
      break;
    }
    if (workers.length >= maxWorkers) { outcome = 'capped'; break; }

    // The tick's derivation is a summary; the worker needs the full item.
    const next = jt(['fabric', 'next', staffable.subjectKind === 'application' ? '--application-id' : '--opportunity-id', String(staffable.subjectId)]);
    const subject = (next.subjects ?? []).find((row) => row.subjectId === staffable.subjectId && row.subjectKind === staffable.subjectKind);
    const item = subject?.items?.find((row) => row.node === staffable.node && (staffable.instance ? row.instance === staffable.instance : true));
    if (!item) continue; // state moved; re-tick
    const full = { ...item, subjectKind: staffable.subjectKind, subjectId: staffable.subjectId };
    const sequence = workers.length + 1;
    const name = `${String(sequence).padStart(2, '0')}-${full.node.replace(/[^a-z.-]/gi, '_')}${full.instance ? `-${String(full.instance).replace(/[^a-z-]/gi, '_')}` : ''}`;
    const key = itemKey(full);
    const attempt = (budgets[key]?.attempts ?? 0) + 1;
    const brief = briefFor(full, { storeHome, jobtrackRoot: options.jobtrackRoot ?? '<jobtrack-root>' }, { dispatch: attempt });
    const record = { name, key, node: full.node, subjectKind: full.subjectKind, subjectId: full.subjectId, instance: full.instance ?? null, attempt, reason: String(full.reason ?? '').slice(0, 200) };
    if (dryRun) {
      planned.add(key);
      workers.push({ ...record, status: 'dry-run' });
      log(`[dispatch] would dispatch ${name} (${full.subjectKind} ${full.subjectId}, attempt ${attempt}): ${record.reason.slice(0, 100)}`);
      continue;
    }
    fs.mkdirSync(path.join(passDir, 'workers'), { recursive: true });
    const briefPath = path.join(passDir, 'workers', `${name}.md`);
    fs.writeFileSync(briefPath, brief);
    const request = buildWorkerRequest({ passKey, name, item: full, brief, harness, model, workerMinutes });
    log(`[dispatch] dispatch ${name} (${full.subjectKind} ${full.subjectId}, attempt ${attempt}): ${record.reason.slice(0, 100)}`);
    const started = now();
    const result = runWorker({ request, shimDir, briefPath });
    const summary = summarizeWorkerResult(result);
    const ms = now() - started;
    fs.writeFileSync(path.join(passDir, 'workers', `${name}.log`),
      `exit ${summary.exitCode} signal ${summary.signal} engine ${summary.engineStatus} in ${ms}ms\n\n--- stdout ---\n${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}\n`);
    const worker = { ...record, ...summary, ms, status: summary.exitCode === 0 ? 'completed' : 'failed' };
    workers.push(worker);
    budgets[key] = { attempts: attempt, lastAt: new Date(now()).toISOString(), lastStatus: worker.status, lastEngineStatus: summary.engineStatus, passKey };
    log(`[dispatch] worker ${name} exited ${summary.exitCode} (${summary.engineStatus ?? 'no result'}) in ${Math.round(ms / 1000)}s`);
  }
  if (now() >= deadline && outcome === 'quiescent' && workers.length > 0) outcome = 'timeout';
  if (!dryRun) writeBudgets(budgetsFile, budgets);
  const pass = {
    schemaVersion: DISPATCH_SCHEMA_VERSION,
    passKey,
    storeHome,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    dryRun,
    harness,
    model,
    outcome,
    iterations,
    workers,
    skipped,
    ...(stalledOn ? { stalledOn } : {}),
    tick: lastTick ? { summary: lastTick.summary ?? null, parked: (lastTick.parked ?? []).map((row) => ({ node: row.node ?? row.gateId ?? null, subjectKind: row.subjectKind ?? null, subjectId: row.subjectId ?? null })) } : null
  };
  return pass;
}

/** Exit codes: 0 quiescent/capped/waiting/dry-run · 3 parked or stalled (a person is needed) · 1 machinery failure. */
function exitCodeFor(outcome) {
  if (['quiescent', 'capped', 'waiting', 'timeout', 'dry-run'].includes(outcome)) return 0;
  if (['parked', 'stalled'].includes(outcome)) return 3;
  return 1;
}

/**
 * The CLI verb: resolve paths, take the lock, run one pass against the real
 * store, journal it under <home>/fabric/dispatch/, return the pass document.
 */
async function runDispatchCommand({ home, flags = {}, env = process.env, jobtrackRoot, nodePath = process.execPath, log }) {
  if (!home) throw new FabricDispatchError('INVALID_INPUT', 'a store home is required');
  const root = jobtrackRoot ?? path.resolve(__dirname, '..');
  const cliPath = path.join(root, 'bin', 'jobtrack.js');
  const runnerPath = path.join(root, 'bin', 'jobtrack-fabric-worker.js');
  const fabricDir = path.join(home, 'fabric');
  fs.mkdirSync(fabricDir, { recursive: true });
  const budgetsFile = path.join(fabricDir, 'dispatch-budgets.json');
  if (flags.resetBudgets === true || flags.resetBudgets === 'true' || flags.resetBudgets === '1') {
    writeBudgets(budgetsFile, {});
  }
  const maxMinutes = flags.maxMinutes === undefined ? DEFAULT_MAX_MINUTES : Number(flags.maxMinutes);
  const passStamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const passKey = `dispatch-${passStamp}`;
  const passDir = path.join(fabricDir, 'dispatch', passStamp);
  const dryRun = flags.dryRun === true || flags.dryRun === 'true' || flags.dryRun === '1';
  const release = dryRun ? () => {} : acquireLock(fabricDir, maxMinutes);
  if (release === null) {
    return { schemaVersion: DISPATCH_SCHEMA_VERSION, passKey, storeHome: home, outcome: 'locked', workers: [], skipped: [], note: 'another pass holds the dispatch lock' };
  }
  try {
    const logLine = log ?? ((line) => process.stderr.write(`${line}\n`));
    const jt = makeJt({ storeHome: home, nodePath, cliPath, env });
    const shimDir = dryRun ? null : ensureJobtrackShim(passDir, { nodePath, cliPath });
    const runWorker = makeWorkerRunner({ storeHome: home, nodePath, runnerPath, env });
    const harness = flags.harness ?? DEFAULT_HARNESS;
    if (!['codex', 'claude'].includes(harness)) throw new FabricDispatchError('INVALID_ARGUMENT', '--harness must be codex or claude');
    const pass = await runDispatchPass({
      storeHome: home, passDir, passKey, jt, runWorker, shimDir, log: logLine, dryRun, budgetsFile, jobtrackRoot: root,
      harness,
      ...(flags.model ? { model: String(flags.model) } : {}),
      ...(flags.maxWorkers !== undefined ? { maxWorkers: Number(flags.maxWorkers) } : {}),
      ...(flags.workerMinutes !== undefined ? { workerMinutes: Number(flags.workerMinutes) } : {}),
      maxMinutes,
      ...(flags.nodes ? { staffedNodes: String(flags.nodes).split(',').map((node) => node.trim()).filter(Boolean) } : {})
    });
    if (!dryRun) {
      fs.mkdirSync(passDir, { recursive: true });
      fs.writeFileSync(path.join(passDir, 'pass.json'), `${JSON.stringify(pass, null, 2)}\n`);
      fs.appendFileSync(path.join(fabricDir, 'dispatch-log.jsonl'), `${JSON.stringify({ at: pass.finishedAt, passKey, outcome: pass.outcome, workers: pass.workers.length, completed: pass.workers.filter((worker) => worker.status === 'completed').length, skipped: pass.skipped.length })}\n`);
    }
    return pass;
  } finally {
    release();
  }
}

module.exports = Object.freeze({
  DEFAULT_HARNESS,
  DEFAULT_MAX_WORKERS,
  DEFAULT_MODELS,
  DISPATCH_SCHEMA_VERSION,
  FabricDispatchError,
  MAX_DISPATCHES_DRAFT,
  MAX_DISPATCHES_PER_ITEM,
  acquireLock,
  buildWorkerRequest,
  ensureJobtrackShim,
  exitCodeFor,
  itemKey,
  makeJt,
  makeWorkerRunner,
  readBudgets,
  runDispatchCommand,
  runDispatchPass,
  summarizeWorkerResult
});
