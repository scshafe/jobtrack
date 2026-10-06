'use strict';

// CLI surface for the fabric read model (docs/FABRIC_PLAN.md, Phase A):
//   fabric next            what is the next required act, per subject
//   fabric gates           every configurable node's resolved behavior
//   fabric gates set       append a gate policy revision (expected-current)
//   fabric gates override  per-subject behavior override (or --clear)
//   fabric wake            record a wake request (and ping the daemon)  — lib/fabric-wake.js
//   fabric wakes           the pending wake journal
//   fabric daemon          run the loop: pass on wake / due-at / safety tick
//   fabric dispatch        one production dispatch pass: staff agent work — lib/fabric-dispatch.js
//   fabric notify          tell a person what newly waits on them (ntfy) — lib/fabric-notify.js

const {
  FabricError,
  deriveFabricNext,
  listGateConfiguration,
  runFabricTick,
  setGateOverride,
  setGatePolicy
} = require('./fabric');
const { listPendingWakes, requestWake, runFabricDaemon, DEFAULT_SAFETY_TICK_MS } = require('./fabric-wake');
const { runDispatchCommand } = require('./fabric-dispatch');
const { runNotifyCommand } = require('./fabric-notify');

const FABRIC_FLAG_SCHEMAS = Object.freeze({
  next: ['applicationId', 'id', 'opportunityId', 'parked'],
  tick: ['applicationId', 'id', 'opportunityId'],
  wake: ['reason', 'source'],
  wakes: [],
  daemon: ['passCommand', 'safetyTickMs', 'socket', 'passTimeoutMs'],
  dispatch: ['maxWorkers', 'workerMinutes', 'maxMinutes', 'harness', 'model', 'nodes', 'dryRun', 'resetBudgets', 'notify'],
  notify: [],
  gates: [],
  'gates:set': [
    'gateId', 'mode', 'rulesJson', 'constraintsJson', 'notifyJson',
    'setBy', 'setAuthorship', 'expectedCurrentRevisionId', 'note'
  ],
  'gates:override': [
    'gateId', 'applicationId', 'opportunityId', 'id', 'mode', 'clear',
    'constraintsJson', 'reason', 'setBy', 'setAuthorship'
  ]
});

function fabricSchemaKey(args) {
  const action = args[0] || 'next';
  if (action === 'next') return 'next';
  if (action === 'tick') return 'tick';
  if (action === 'wake') return 'wake';
  if (action === 'wakes') return 'wakes';
  if (action === 'daemon') return 'daemon';
  if (action === 'dispatch') return 'dispatch';
  if (action === 'notify') return 'notify';
  if (action === 'gates' || action === 'gate') {
    const sub = args[1];
    if (!sub || sub === 'list') return 'gates';
    if (sub === 'set') return 'gates:set';
    if (sub === 'override') return 'gates:override';
    throw new FabricError('UNKNOWN_COMMAND', `Unknown fabric gates action: ${sub} (use list, set, or override)`);
  }
  throw new FabricError('UNKNOWN_COMMAND', `Unknown fabric action: ${action} (use next, tick, wake, wakes, daemon, dispatch, notify, or gates)`);
}

function assertFabricCommandFlags(args, flags) {
  const key = fabricSchemaKey(args);
  const allowed = new Set(FABRIC_FLAG_SCHEMAS[key]);
  const unknown = Object.keys(flags).filter((flag) => !allowed.has(flag));
  if (unknown.length) {
    throw new FabricError(
      'INVALID_ARGUMENT',
      `Unknown flag(s) for fabric ${key.replace(':', ' ')}: ${unknown.sort().map(toFlag).join(', ')}`
    );
  }
}

function runFabricCommand(db, args, flags = {}, services = {}) {
  const key = fabricSchemaKey(args);
  assertFabricCommandFlags(args, flags);

  if (key === 'next') {
    return deriveFabricNext(db, {
      applicationId: flags.applicationId ?? flags.id,
      opportunityId: flags.opportunityId,
      parked: flags.parked === true || flags.parked === 'true' || flags.parked === '1'
    });
  }
  if (key === 'tick') {
    return runFabricTick(db, {
      applicationId: flags.applicationId ?? flags.id,
      opportunityId: flags.opportunityId
    }, services);
  }
  if (key === 'wake') {
    // Async (the socket ping); the CLI awaits fabric wake/daemon like mc-sync.
    return requestWake(db, { reason: flags.reason, source: flags.source ?? 'jobtrack-cli', home: services.home });
  }
  if (key === 'wakes') {
    return { pending: listPendingWakes(db) };
  }
  if (key === 'daemon') {
    const safetyTickMs = flags.safetyTickMs === undefined ? DEFAULT_SAFETY_TICK_MS : Number(flags.safetyTickMs);
    if (!Number.isInteger(safetyTickMs) || safetyTickMs < 10_000) throw new FabricError('INVALID_ARGUMENT', '--safety-tick-ms must be an integer of at least 10000');
    const passTimeoutMs = flags.passTimeoutMs === undefined ? undefined : Number(flags.passTimeoutMs);
    if (passTimeoutMs !== undefined && (!Number.isInteger(passTimeoutMs) || passTimeoutMs < 1000)) throw new FabricError('INVALID_ARGUMENT', '--pass-timeout-ms must be an integer of at least 1000');
    const abort = new AbortController();
    const onSignal = () => { if (!abort.signal.aborted) abort.abort(); };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    return runFabricDaemon({
      db,
      home: services.home,
      passCommand: flags.passCommand,
      deriveNext: () => deriveFabricNext(db),
      log: (event) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`),
      safetyTickMs,
      passTimeoutMs,
      socketPath: flags.socket,
      signal: abort.signal
    }).finally(() => { process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal); });
  }
  if (key === 'dispatch') {
    // The production dispatcher shells out to this CLI for tick/next and to
    // the engine-backed worker runner; the open db here is only the routing
    // handle, the pass never writes through it.
    const notifyAfter = flags.notify === true || flags.notify === 'true' || flags.notify === '1';
    return runDispatchCommand({ home: services.home, flags, env: process.env, nodePath: process.execPath })
      .then(async (pass) => {
        if (!notifyAfter) return pass;
        const notify = await runNotifyCommand({ home: services.home, deriveNext: () => deriveFabricNext(db), env: process.env });
        return { ...pass, notify };
      });
  }
  if (key === 'notify') {
    return runNotifyCommand({ home: services.home, deriveNext: () => deriveFabricNext(db), env: process.env });
  }
  if (key === 'gates') {
    return { gates: listGateConfiguration(db) };
  }
  if (key === 'gates:set') {
    return setGatePolicy(db, {
      gateId: flags.gateId,
      mode: flags.mode,
      rules: flags.rulesJson,
      constraints: flags.constraintsJson,
      notify: flags.notifyJson,
      setBy: flags.setBy,
      setAuthorship: flags.setAuthorship,
      expectedCurrentRevisionId: flags.expectedCurrentRevisionId,
      note: flags.note
    });
  }
  // gates:override
  return setGateOverride(db, {
    gateId: flags.gateId,
    subjectId: flags.applicationId ?? flags.opportunityId ?? flags.id,
    mode: flags.mode,
    clear: flags.clear === true || flags.clear === 'true' || flags.clear === '1',
    constraints: flags.constraintsJson,
    reason: flags.reason,
    setBy: flags.setBy,
    setAuthorship: flags.setAuthorship
  });
}

function toFlag(key) {
  return `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

module.exports = {
  FABRIC_FLAG_SCHEMAS,
  assertFabricCommandFlags,
  runFabricCommand
};
