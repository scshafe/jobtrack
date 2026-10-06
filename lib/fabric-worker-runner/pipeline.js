'use strict';

// The FABRIC WORKER runner on the Mission Pipeline v2 node-graph engine
// (mission-pipeline 1.0.0, vendored byte-pinned as vendor/mission-pipeline).
// docs/V2-ENGINE-PORT.md holds the gap list, the shape decision and the diagram.
//
// One dispatch = one MissionPipelineUnit admitted into the sealed one-node graph
// `jobtrack-fabric-worker@2` and run through its single agent turn:
//
//   - the graph's digest changes whenever the node, its contracts or its
//     declared environment posture change (sealed identity, as v1);
//   - the engine owns the append-only journey (turn_settled / turn_failed
//     records with usage receipts), cached-attempt reuse, the retryable-vs-
//     terminal taxonomy with a bounded attempt budget, and dead letters;
//   - REPLAY: a re-run of the same requestId finds its unit already settled
//     and answers from the journey without spawning a second agent;
//   - evidence lives in `<JOBTRACK_HOME>/pipeline-evidence.db` through
//     SqliteUnitStore (engine_* tables) — the same database the v1 runner used
//     for its runs/attempts tables, never the canonical JobTrack store.
//
// The worker itself is unchanged in kind: a fresh headless claude session fed
// ONE brief, with tools, against the drill store and the loopback site. The
// request/report contracts live in ./contracts.js and the claude executor in
// ./claude-executor.js (the frozen agent-step seam the stub executors also speak).

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const vendorPin = require('../draft-runner/vendor-pin');
const { SqliteUnitStore } = require('../engine-v2/sqlite-unit-store');
const {
  DEFAULT_DEADLINE_MS,
  FabricWorkerError,
  REPORT_CONTRACT,
  REQUEST_CONTRACT,
  validateWorkerReport,
  validateWorkerRequest
} = require('./contracts');
const { STATIC_INSTRUCTIONS, WORKER_ENVIRONMENT, createClaudeAgentStepExecutor, truncate } = require('./claude-executor');
const { createCodexAgentStepExecutor } = require('./codex-executor');

const FAILURE_CONTRACT = 'jobtrack-fabric-worker-failure.v1';
const GRAPH_ID = 'jobtrack-fabric-worker';
const GRAPH_VERSION = 2;
const NODE_ID = 'worker_turn';
const NODE_REF = Object.freeze({ id: 'jobtrack.fabric.worker_turn', version: 2 });
const WORKER_PRINCIPAL = 'jobtrack.fabric.worker';
const OUTCOMES = Object.freeze(['completed', 'failed']);
/** Attempt budget is a SEALED node property in v2 (v1 took it per run). */
const MAX_ATTEMPTS = 2;
/** The claude turn is bounded by request.deadlineMs (≤ 24h); the lease must outlive it. */
const LEASE_MS = 86_400_000;
const ENGINE_LABEL = 'mission-pipeline@1.0.0';

// The engine arrives ONLY through the byte-pinned vendored load (single-copy
// topology: instanceof failure classification needs exactly one engine).
let enginePromise = null;
function loadEngine() {
  if (!enginePromise) enginePromise = vendorPin.loadMissionPipeline();
  return enginePromise;
}

// ---------------------------------------------------------------------------
// the sealed one-node graph
// ---------------------------------------------------------------------------

/** The sealed graph one worker turn runs in. Pure: same engine, same digest. */
function buildWorkerGraph(mp) {
  return mp.createGraphDefinition({
    graphId: GRAPH_ID,
    version: GRAPH_VERSION,
    description: 'Run one fabric worker brief as a durably-evidenced agent turn (v2 node graph).',
    entry: NODE_ID,
    nodes: [{
      nodeId: NODE_ID,
      ref: NODE_REF,
      kind: 'agent',
      input: REQUEST_CONTRACT,
      // The vocabulary version must equal the node ref version (an outcome change is a new node version).
      outcomes: { version: NODE_REF.version, outcomes: [...OUTCOMES] },
      principal: { id: WORKER_PRINCIPAL },
      turn: {
        idempotency: mp.NODE_TURN_IDEMPOTENCY,
        leaseMs: LEASE_MS,
        maxAttempts: MAX_ATTEMPTS,
        retryTaxonomy: mp.NODE_TURN_RETRY_TAXONOMY
      }
    }],
    edges: [],
    terminals: OUTCOMES.map((outcome) => ({ nodeId: NODE_ID, outcome }))
  });
}

function unitIdFor(request) {
  return `fabric-worker:${request.requestId}`;
}

// ---------------------------------------------------------------------------
// the agent port: the frozen agent-step executor seam, hosted as a v2 agent node
// ---------------------------------------------------------------------------

/**
 * The v2 AgentNodePort over an `agent-step-{request,result}.v1` executor (the
 * same executor seam the v1 runner and the test/stub executors speak). The two
 * port calls are keyed by the engine's idempotency key: submit starts the turn,
 * await settles it into an outcome — or throws the engine's typed failure so the
 * retry taxonomy applies (timed_out / infra_error retry within MAX_ATTEMPTS,
 * then dead-letter; a contract-violating report is terminal).
 */
function createAgentPort({ mp, executor, request, receipts, onFailure }) {
  const pending = new Map();
  return Object.freeze({
    async submitTurnIntent(input, context) {
      const stepRequest = {
        schemaVersion: 'agent-step-request.v1',
        stage: { id: NODE_REF.id, version: NODE_REF.version },
        environment: WORKER_ENVIRONMENT,
        brief: { instructions: STATIC_INSTRUCTIONS, inputArtifacts: [context.inputArtifact] },
        idempotencyKey: context.idempotencyKey,
        deadlineMs: request.deadlineMs ?? DEFAULT_DEADLINE_MS
      };
      pending.set(context.idempotencyKey, Promise.resolve().then(() => executor.execute(stepRequest, context.signal)));
    },
    async awaitSettledResult(context) {
      const turn = pending.get(context.idempotencyKey);
      if (!turn) {
        throw new mp.ExecutionFailureError('agent_turn_not_submitted', false);
      }
      pending.delete(context.idempotencyKey);
      let result;
      try {
        result = mp.validateAgentStepResult(await turn);
      } catch (error) {
        onFailure?.({ kind: 'agent_executor_threw', detail: String(error?.message ?? error) });
        throw new mp.ExecutionFailureError('agent_executor_threw', true, error);
      }
      for (const receipt of result.usage ?? []) receipts.push(receipt);
      if (result.status === 'completed') {
        let output;
        try {
          output = validateWorkerReport(result.output);
        } catch (error) {
          onFailure?.({ kind: 'output_contract_rejected', detail: String(error?.message ?? error) });
          throw new mp.ExecutionFailureError('output_contract_rejected', false, error);
        }
        return {
          outcome: 'completed',
          outputArtifact: mp.createArtifactEnvelope(REPORT_CONTRACT, output),
          usage: result.usage
        };
      }
      if (result.status === 'failed') {
        // The agent ran and produced junk (or declared its own error): a
        // DECLARED terminal outcome — re-briefing is dispatcher judgment.
        const failure = { kind: result.failure?.kind ?? 'agent_error', detail: truncate(result.failure?.detail ?? '', 4000) };
        onFailure?.({ kind: 'agent_step_failed', detail: failure.detail });
        return {
          outcome: 'failed',
          outputArtifact: mp.createArtifactEnvelope(FAILURE_CONTRACT, { schemaVersion: FAILURE_CONTRACT, ...failure }),
          usage: result.usage
        };
      }
      // timed_out / infra_error: RETRYABLE within the sealed attempt budget.
      const code = result.status === 'timed_out' ? 'agent_step_timed_out' : 'agent_step_infra_error';
      onFailure?.({ kind: code, detail: truncate(result.failure?.detail ?? '', 4000) });
      throw new mp.ExecutionFailureError(code, true);
    }
  });
}

// ---------------------------------------------------------------------------
// evidence store (same DB and guard as the draft runner; never the canonical store)
// ---------------------------------------------------------------------------

const CANONICAL_STORE_BASENAMES = new Set(['jobtrack.db', 'jobtrack.db-wal', 'jobtrack.db-shm']);

function evidenceDatabasePath() {
  const home = process.env.JOBTRACK_HOME || path.join(os.homedir(), '.jobtrack');
  const file = path.join(home, 'pipeline-evidence.db');
  if (CANONICAL_STORE_BASENAMES.has(path.basename(file))) {
    throw new FabricWorkerError('EVIDENCE_PATH_FORBIDDEN', 'evidence database must never be the canonical JobTrack store');
  }
  return file;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

const STATUS_BY_ERROR_CODE = Object.freeze({
  agent_step_timed_out: 'timed_out',
  agent_step_infra_error: 'infra_error',
  agent_executor_threw: 'infra_error',
  agent_turn_not_submitted: 'infra_error'
});

function settledTurnRecord(journey) {
  return journey.find((record) => record.kind === 'turn_settled' && record.nodeId === NODE_ID);
}

async function replayFromEvidence({ store, unitId, graphRef, databasePath }) {
  const journey = await store.readJourney({ unitId });
  const settled = settledTurnRecord(journey);
  if (settled) {
    const artifact = settled.outputArtifact ? await store.getArtifact({ artifact: settled.outputArtifact }) : undefined;
    const payload = artifact?.payload;
    if (settled.outcome === 'completed') {
      return {
        status: 'completed',
        report: payload?.report,
        output: payload,
        usage: [],
        evidence: { engine: ENGINE_LABEL, unitId, graph: graphRef, databasePath, replayed: true }
      };
    }
    return {
      status: 'failed',
      usage: [],
      failure: { kind: 'agent_step_failed', detail: payload?.detail ?? 'a prior run of this requestId failed terminally' },
      evidence: { engine: ENGINE_LABEL, unitId, graph: graphRef, databasePath, replayed: true }
    };
  }
  const deadLetters = await store.listDeadLetters({ unitId });
  if (deadLetters.length > 0) {
    const letter = deadLetters[deadLetters.length - 1];
    return {
      status: STATUS_BY_ERROR_CODE[letter.errorCode] ?? 'failed',
      usage: [],
      failure: { kind: 'replayed_failure', detail: `a prior run of this requestId dead-lettered (${letter.errorCode}); a fresh dispatch needs a fresh requestId` },
      evidence: { engine: ENGINE_LABEL, unitId, graph: graphRef, databasePath, replayed: true }
    };
  }
  return null; // admitted but never settled (a crashed predecessor): run it now
}

/**
 * Execute one fabric worker request through the v2 engine. Returns
 * `{ status, report?, output?, usage, evidence, failure? }` where status is the
 * agent step's word: completed | failed | timed_out | infra_error. A replayed
 * requestId answers from committed evidence (`evidence.replayed: true`)
 * without spawning a second agent.
 */
async function runFabricWorkerRequest(request, options = {}) {
  validateWorkerRequest(request);
  const mp = await loadEngine();
  const graph = buildWorkerGraph(mp);
  const graphRef = mp.graphDefinitionRef(graph);
  const unitId = unitIdFor(request);

  const databasePath = options.databasePath ?? evidenceDatabasePath();
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = options.store ? null : (options.db ?? new Database(databasePath));
  const ownDb = !options.db && !options.store;
  try {
    const store = options.store ?? new SqliteUnitStore({ db, mp, scope: unitId });
    await store.publishGraph(graph);
    const seed = mp.createArtifactEnvelope(REQUEST_CONTRACT, request);
    // Admission is immutable evidence (its digest covers the admission instant),
    // so a re-run of the same requestId must not re-admit: an existing unit is
    // replayed from its journey, or — if a predecessor crashed before settling —
    // run now. Two runners racing to admit the same request resolve the same way.
    let existing = await store.readUnit({ unitId });
    if (!existing) {
      try {
        await store.admitUnit({
          unitId,
          graph: graphRef,
          seedArtifact: seed,
          admittedAt: new Date().toISOString(),
          principalId: WORKER_PRINCIPAL
        });
      } catch (error) {
        if (error?.name !== 'TurnEvidenceConflictError') throw error;
        existing = await store.readUnit({ unitId });
      }
    }
    if (existing) {
      if (existing.seedArtifact.digest !== seed.digest) {
        throw new FabricWorkerError('REQUEST_ID_REUSED', `requestId ${request.requestId} was already admitted with a different request (seed ${existing.seedArtifact.digest.slice(0, 12)} != ${seed.digest.slice(0, 12)}); a different brief needs a fresh requestId`);
      }
      const replayed = await replayFromEvidence({ store, unitId, graphRef, databasePath });
      if (replayed) return replayed;
    }

    const receipts = [];
    let lastFailure = null;
    const executor = options.executor
      ?? (request.harness === 'codex'
        ? createCodexAgentStepExecutor(request, { ...options, expectedDigest: seed.digest })
        : createClaudeAgentStepExecutor(request, { ...options, expectedDigest: seed.digest }));
    const ports = {
      agent: createAgentPort({
        mp, executor, request, receipts,
        onFailure: (failure) => {
          lastFailure = failure;
          if (options.debug) console.error('[fabric-worker] turn failure:', failure.kind, '|', failure.detail?.slice(0, 200));
        }
      })
    };

    const run = await mp.runNextUnitTurn({
      store,
      principalId: WORKER_PRINCIPAL,
      ports,
      leaseOwner: `jobtrack-fabric-worker:${process.pid}`,
      nodeId: NODE_ID,
      ...(options.signal ? { signal: options.signal } : {})
    });

    if (run === undefined) {
      return {
        status: 'infra_error',
        usage: receipts,
        failure: { kind: 'unit_not_claimable', detail: 'the unit is admitted but not claimable (another runner holds its lease); retry after the lease expires' },
        evidence: { engine: ENGINE_LABEL, unitId, graph: graphRef, databasePath, replayed: false }
      };
    }
    if (run.status === 'succeeded') {
      const payload = run.completion.outputArtifact?.payload;
      const evidence = {
        engine: ENGINE_LABEL, unitId, graph: graphRef, databasePath, replayed: false,
        attemptNumber: run.attemptNumber, attemptIndex: run.attemptIndex, reused: run.reused
      };
      if (run.completion.outcome === 'completed') {
        return { status: 'completed', report: payload?.report, output: payload, usage: receipts, evidence };
      }
      return {
        status: 'failed',
        usage: receipts,
        failure: { kind: 'agent_step_failed', detail: payload?.detail ?? lastFailure?.detail ?? 'the agent ran and produced junk' },
        evidence
      };
    }
    // Exhausted RETRYABLE kinds surface as their own statuses (the dispatcher may
    // redispatch under a fresh requestId); terminal kinds are `failed`.
    return {
      status: STATUS_BY_ERROR_CODE[run.errorCode] ?? 'failed',
      usage: receipts,
      failure: {
        kind: run.errorCode,
        detail: truncate(lastFailure?.detail ?? `dead-lettered after ${run.attempts} attempt(s)`, 4000),
        attempts: run.attempts
      },
      evidence: { engine: ENGINE_LABEL, unitId, graph: graphRef, databasePath, replayed: false }
    };
  } finally {
    if (ownDb) db.close();
  }
}

module.exports = Object.freeze({
  DEFAULT_DEADLINE_MS,
  ENGINE_LABEL,
  FabricWorkerError,
  GRAPH_ID,
  GRAPH_VERSION,
  MAX_ATTEMPTS,
  NODE_ID,
  REPORT_CONTRACT,
  REQUEST_CONTRACT,
  SqliteUnitStore,
  WORKER_PRINCIPAL,
  buildWorkerGraph,
  createAgentPort,
  createClaudeAgentStepExecutor,
  createCodexAgentStepExecutor,
  loadEngine,
  runFabricWorkerRequest,
  unitIdFor,
  validateWorkerReport,
  validateWorkerRequest
});
