'use strict';

// Assembles the reply-drafting graph on the pinned Mission Pipeline v2 engine
// and runs exactly one request through it (docs/V2-ENGINE-PORT.md §7).
//
// The engine supplies what a hand-rolled loop would not: a digest-sealed graph
// whose identity changes if any node, contract, or model binding changes;
// per-turn idempotency keys and a bounded attempt budget; append-only journey
// evidence with the usage receipts that ride the same settle as the turn that
// earned them; and replay from committed evidence — a re-run of the same
// request is answered from its unit's journey, the composer is not called
// again, and the receipts of the run that earned them survive the process.
//
// Five nodes in a chain — verify_request → classify_event → select_evidence →
// compose_reply (the one MODEL node) → seal_proposal — each reading and
// extending ONE state artifact (`jobtrack-email-reply-draft-state.v1`). A
// stage refusal is a DECLARED terminal outcome (`refused`), recorded on the
// state with its code and reason: a conclusive decision about one item that
// the engine never retries into a different answer. Evidence lives in its own
// database — never the canonical JobTrack store, which this runner is
// forbidden to open.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');

const { digestCanonicalJson } = require('../email-outgoing-v2-contracts');
const {
  COMPOSITION_CONTRACT,
  DRAFT_REQUEST_CONTRACT,
  EVIDENCE_CONTRACT,
  INTENT_CONTRACT,
  OUTCOME_CONTRACT,
  POLICY_CONTRACT,
  createDraftRunnerContracts,
  validateDraftRequest
} = require('./contracts');
const {
  DraftRefusal,
  createClassifyEventStage,
  createDeterministicComposerResolver,
  createSealProposalStage,
  createSelectEvidenceStage,
  createVerifyRequestStage
} = require('./stages');
const { VENDOR_PACKAGE_VERSION, VENDOR_SOURCE_COMMIT, loadMissionPipeline } = require('./vendor-pin');
const {
  REFUSED,
  SqliteUnitStore,
  createCodePort,
  createModelPort,
  defineLinearGraph,
  refusalOf,
  runUnitToCompletion
} = require('../engine-v2');

const GRAPH_ID = 'jobtrack.email.reply_draft';
const GRAPH_VERSION = 2;
const STATE_CONTRACT = 'jobtrack-email-reply-draft-state.v1';
const RESULT_VERSION = 'jobtrack-email-reply-draft-result.v1';
const PROVENANCE_VERSION = 'jobtrack-draft-runner-provenance.v2';
const RUNNER_KIND = 'standalone_out_of_process';
const PRINCIPAL = 'jobtrack.draft.runner';
/** Node refs bump together with the graph version (outcome vocabularies are versioned per node ref). */
const NODE_VERSION = 2;
const NODE_IDS = Object.freeze(['verify_request', 'classify_event', 'select_evidence', 'compose_reply', 'seal_proposal']);
const COMPOSER_STAGE = Object.freeze({ id: 'jobtrack.draft.compose_reply', version: 1 });

// The composer's recorded inference parameters. They are part of the sealed
// binding, so changing any of them changes the binding digest, the graph digest,
// and every downstream turn idempotency key.
const COMPOSER_PARAMETERS = Object.freeze({
  temperature: 0,
  seed: 1,
  thinking: 'off',
  timeoutMs: 30_000,
  maxOutputTokens: 4096,
  maxOutputBytes: 262_144,
  maxConcurrency: 1,
  toolPolicy: 'none',
  responseContract: COMPOSITION_CONTRACT
});

class DraftRunnerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DraftRunnerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const isRefusal = (error) => error instanceof DraftRefusal || (error?.name === 'DraftRefusal' && typeof error.code === 'string');

// Pipeline evidence is the engine's domain, not JobTrack's, so it lives in its
// own database rather than the canonical store — whose schema is governed by a
// migration ledger and rehearsed against a restored backup before any change.
// `JOBTRACK_PIPELINE_DB` overrides the location; ':memory:' is accepted so a
// caller can opt out of durability deliberately rather than by default.
function runnerStorePath(options) {
  if (options.storePath) return options.storePath;
  const home = process.env.JOBTRACK_PIPELINE_DB;
  if (home) return home;
  return path.join(os.homedir(), '.jobtrack', 'pipeline-evidence.db');
}

// The runner owns a database for PIPELINE EVIDENCE only. Opening the canonical
// store would be exactly the boundary violation the out-of-process split exists
// to prevent, so it is refused by name rather than by convention.
const CANONICAL_STORE_BASENAMES = new Set(['jobtrack.db', 'jobtrack.db-wal', 'jobtrack.db-shm']);

function openRunnerDatabase(options) {
  const target = runnerStorePath(options);
  if (target === ':memory:') return new Database(target);
  const resolved = path.resolve(target);
  if (CANONICAL_STORE_BASENAMES.has(path.basename(resolved))) {
    throw new DraftRunnerError('STORE_PATH_FORBIDDEN', 'The draft runner must not open the canonical JobTrack store');
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  return db;
}

function buildComposerBinding(mp) {
  return mp.createModelStageBinding({
    schemaVersion: 'model-stage-binding.v2',
    bindingId: 'jobtrack.reply_composer',
    version: 1,
    kind: 'model',
    modelRevisionRef: {
      id: 'jobtrack.deterministic_composer',
      version: 1,
      digest: mp.digest({ composer: 'jobtrack.deterministic_composer', version: 1 })
    },
    inferenceProfileRef: mp.createInferenceProfileRef({
      id: 'jobtrack.reply_composer.toolless',
      version: 1,
      parameters: { ...COMPOSER_PARAMETERS }
    })
  });
}

function buildGraph(mp, binding) {
  return defineLinearGraph(mp, {
    graphId: GRAPH_ID,
    version: GRAPH_VERSION,
    description: 'Compose one reviewed, provider-neutral job-application email reply from a digest-pinned request.',
    principalId: PRINCIPAL,
    stateContract: STATE_CONTRACT,
    leaseMs: 600_000,
    maxAttempts: 2,
    nodes: [
      { nodeId: 'verify_request', ref: { id: 'jobtrack.draft.verify_request', version: NODE_VERSION }, kind: 'code' },
      { nodeId: 'classify_event', ref: { id: 'jobtrack.draft.classify_event', version: NODE_VERSION }, kind: 'code' },
      { nodeId: 'select_evidence', ref: { id: 'jobtrack.draft.select_evidence', version: NODE_VERSION }, kind: 'code' },
      { nodeId: 'compose_reply', ref: { id: 'jobtrack.draft.compose_reply', version: NODE_VERSION }, kind: 'model', binding },
      { nodeId: 'seal_proposal', ref: { id: 'jobtrack.draft.seal_proposal', version: NODE_VERSION }, kind: 'code' }
    ]
  });
}

// Identities are derived from the request so a replayed request produces a
// byte-identical result. Nothing here consults a clock or a random source.
function proposalIdFor(request) { return `${request.requestId}:proposal`; }
function contentIdFor(request) { return `${request.requestId}:content`; }
function resultIdFor(request) { return `${request.requestId}:result`; }
function unitIdFor(request) { return `${request.requestId}:unit`; }

function fixedClock(value) {
  return () => value;
}

/**
 * Compile the drafting graph. Exposed separately so a caller (or a test) can
 * inspect the sealed graph digest without executing anything.
 */
async function compileDraftPipeline() {
  const mp = await loadMissionPipeline();
  const binding = buildComposerBinding(mp);
  const { graph, compiled } = buildGraph(mp, binding);
  return { mp, binding, graph, compiled, stateContract: STATE_CONTRACT };
}

/**
 * The per-section contract validators, applied by the host on each node's edge.
 * The frozen v1 contract ids stay the vocabulary; the state artifact is the
 * transport.
 */
function sectionValidators() {
  const contracts = createDraftRunnerContracts();
  const validate = (contractId, value) => {
    const verdict = contracts.validate(contractId, value);
    if (!verdict.ok) {
      throw new Error(`${contractId}: ${verdict.issues.map((issue) => issue.message).join('; ')}`);
    }
    return verdict.value;
  };
  return {
    policy: (value) => validate(POLICY_CONTRACT, value),
    intent: (value) => validate(INTENT_CONTRACT, value),
    evidence: (value) => validate(EVIDENCE_CONTRACT, value),
    composition: (value) => validate(COMPOSITION_CONTRACT, value),
    outcome: (value) => validate(OUTCOME_CONTRACT, value)
  };
}

function buildPorts({ mp, binding, stages, resolver }) {
  const validators = sectionValidators();
  // Each code stage keeps its v1 signature; the port hands it the sections it
  // consumed before and validates the section it produced against its contract.
  const codeStages = {
    verify_request: {
      async run(state) {
        return { policy: validators.policy(await stages.verifyRequest.run(state.request)) };
      }
    },
    classify_event: {
      async run(state) {
        return { intent: validators.intent(await stages.classifyEvent.run(state.policy)) };
      }
    },
    select_evidence: {
      async run(state) {
        return { evidence: validators.evidence(await stages.selectEvidence.run({ policy: state.policy, intent: state.intent })) };
      }
    },
    seal_proposal: {
      async run(state) {
        return {
          outcome: validators.outcome(await stages.sealProposal.run({
            policy: state.policy, intent: state.intent, evidence: state.evidence, composition: state.composition
          }))
        };
      }
    }
  };
  return {
    code: createCodePort({ mp, stateContract: STATE_CONTRACT, stages: codeStages, isRefusal }),
    model: createModelPort({
      mp,
      stateContract: STATE_CONTRACT,
      resolver,
      bindings: [binding],
      isRefusal,
      nodes: {
        compose_reply: {
          stageId: COMPOSER_STAGE.id,
          stageVersion: COMPOSER_STAGE.version,
          inputFor: (state) => ({ intent: state.intent, evidence: state.evidence }),
          validateOutput: validators.composition,
          merge: (state, composition) => ({ ...state, composition })
        }
      }
    })
  };
}

/**
 * Execute exactly one draft request and return the
 * `jobtrack-email-reply-draft-result.v1` document the JobTrack CLI records.
 *
 * @param {unknown} rawRequest the digest-pinned request emitted by
 *   `jobtrack email outgoing-draft-issue`
 * @param {object} [options]
 * @param {() => string} [options.now] injected clock (RFC 3339)
 * @param {object} [options.modelResolver] a ModelBindingResolver; defaults to
 *   the local deterministic composer, which reaches no network or credential
 * @param {object} [options.store] a host-supplied UnitStore (outlives this call)
 * @param {string} [options.storePath] the evidence database to open instead
 */
async function runDraftRequest(rawRequest, options = {}) {
  const request = validateDraftRequest(rawRequest);
  const mp = await loadMissionPipeline();
  const unitId = unitIdFor(request);
  const db = options.store ? null : openRunnerDatabase(options);
  try {
    const store = options.store || new SqliteUnitStore({ db, mp, scope: unitId });
    return await executeDraftRequest(request, options, mp, store, unitId);
  } finally {
    if (db) db.close();
  }
}

async function executeDraftRequest(request, options, mp, store, unitId) {
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const startedAt = now();

  const stages = {
    verifyRequest: createVerifyRequestStage({ now }),
    classifyEvent: createClassifyEventStage(),
    selectEvidence: createSelectEvidenceStage(),
    sealProposal: createSealProposalStage({ now, proposalIdFor, contentIdFor })
  };
  const binding = buildComposerBinding(mp);
  const { graph } = buildGraph(mp, binding);
  const ports = buildPorts({
    mp, binding, stages,
    resolver: options.modelResolver || createDeterministicComposerResolver()
  });

  const run = await runUnitToCompletion({
    mp,
    store,
    graph,
    unitId,
    seedArtifact: mp.createArtifactEnvelope(STATE_CONTRACT, { request }),
    principalId: PRINCIPAL,
    ports,
    leaseOwner: `jobtrack-draft-runner:${process.pid}`,
    now
  });

  const refusal = refusalOf(run.terminal);
  if (refusal) {
    // A stage refusal is a decision, so surface the refusing node's own reason
    // rather than a generic engine status; the journey is its durable record.
    throw new DraftRunnerError(
      'DRAFT_NOT_COMPOSED',
      `${refusal.nodeId ?? run.terminal.nodeId} declined to compose a draft: ${refusal.message}`,
      { status: REFUSED, nodeId: refusal.nodeId ?? run.terminal.nodeId, errorCode: refusal.code, reason: refusal.message, replayed: run.replayed }
    );
  }
  if (!run.terminal) {
    // Dead-lettered: a typed engine failure (contract violation, exhausted
    // retryable failure). The dead letter names the node and the code.
    const letter = run.deadLetter;
    throw new DraftRunnerError(
      'DRAFT_NOT_COMPOSED',
      letter ? `${letter.nodeId} could not compose a draft: ${letter.errorCode}` : 'The drafting graph did not complete',
      { status: 'dead_lettered', nodeId: letter?.nodeId, errorCode: letter?.errorCode, replayed: run.replayed }
    );
  }
  const outcome = run.terminal.artifact?.payload?.outcome;
  if (!outcome) {
    throw new DraftRunnerError('DRAFT_OUTPUT_MISSING', 'The graph completed without a sealed outcome on the terminal artifact');
  }
  const completedAt = now();

  const provenance = {
    schemaVersion: PROVENANCE_VERSION,
    engine: {
      name: 'mission-pipeline',
      version: VENDOR_PACKAGE_VERSION,
      sourceCommit: VENDOR_SOURCE_COMMIT
    },
    graph: {
      id: graph.graphId,
      version: graph.version,
      graphDigest: graph.graphDigest,
      unitId
    },
    composerBindingDigest: binding.bindingDigest,
    requestDigest: digestCanonicalJson(request),
    nodes: graph.nodes.map((node) => ({
      nodeId: node.nodeId,
      ref: `${node.ref.id}@${node.ref.version}`,
      kind: node.kind,
      ...(node.binding ? { bindingDigest: node.binding.bindingDigest } : {})
    })),
    // Receipts are read back from durable evidence (the journey), not from an
    // in-process ledger. On a replay no composer ran — but the receipts the
    // original run committed are still there, which is exactly what makes them
    // worth persisting.
    modelReceipts: run.receipts
      .filter((entry) => entry.nodeId === 'compose_reply')
      .map((entry) => ({
        nodeId: entry.nodeId,
        attempt: entry.attemptIndex,
        bindingDigest: binding.bindingDigest,
        receipt: entry.receipt
      })),
    replayed: run.replayed,
    startedAt,
    completedAt
  };

  return {
    result: {
      schemaVersion: RESULT_VERSION,
      resultId: resultIdFor(request),
      requestId: request.requestId,
      requestDigest: provenance.requestDigest,
      proposal: outcome.proposal,
      approvedContent: outcome.approvedContent,
      usage: {
        runner: RUNNER_KIND,
        toolCalls: 0,
        toolsUsed: [],
        sideEffects: []
      },
      completedAt,
      idempotencyKey: `${request.requestId}:record`
    },
    provenance,
    safety: outcome.safety
  };
}

module.exports = Object.freeze({
  COMPOSER_PARAMETERS,
  DraftRefusal,
  DraftRunnerError,
  GRAPH_ID,
  GRAPH_VERSION,
  PROVENANCE_VERSION,
  RESULT_VERSION,
  STATE_CONTRACT,
  compileDraftPipeline,
  contentIdFor,
  fixedClock,
  proposalIdFor,
  resultIdFor,
  runDraftRequest,
  unitIdFor
});
