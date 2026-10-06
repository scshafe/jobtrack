'use strict';

// The opportunity-triage panel on the Mission Pipeline v2 engine: N model
// nodes, one per personality, each judging the same digest-pinned posting, and
// a deterministic synthesis node combining their verdicts
// (docs/V2-ENGINE-PORT.md §7).
//
// The shape is deliberate. Each panellist is a `kind: "model"` node bound to
// its own sealed model-stage binding carrying a sealed persona and prompt
// stack, so a change to one personality's decision rule changes that binding's
// digest, the node's binding reference, the graph's digest, and every
// downstream idempotency key. "Which panel produced this score" is therefore
// provable from the score's provenance rather than asserted.
//
// In v2 the panellists run as a CHAIN over one accumulating state artifact
// (`jobtrack-triage-panel-state.v1`): each model node reads the request, adds
// its verdict, and passes the state on; the last node synthesises. Their
// judgments stay independent — a panellist's prompt sees the posting and
// nothing another panellist said. A v2 join would only synchronise the five
// turns and hand the synthesis one selected artifact (node bodies hold no
// store authority to read the rest), which is why the chain is the honest
// shape today.
//
// Synthesis is a code node, not a model. Combining verdicts is arithmetic over
// a published rubric, and asking a model to do arithmetic it can get subtly
// wrong would put the one number a human acts on outside the auditable path.

const { loadMissionPipeline } = require('../draft-runner/vendor-pin');
const {
  OUTCOME_CONTRACT,
  VERDICT_CONTRACT,
  createTriagePanelContracts,
  validatePanelRequest,
  validateVerdict
} = require('./contracts');
const { PANELLISTS, sealPanel } = require('./personas');
const {
  DIMENSIONS,
  MINIMUM_COVERAGE,
  RUBRIC_VERSION,
  coverageOf,
  decisionOf,
  scoreOf
} = require('./rubric');
const {
  SqliteUnitStore,
  createCodePort,
  createModelPort,
  defineLinearGraph,
  refusalOf,
  runUnitToCompletion
} = require('../engine-v2');

const GRAPH_ID = 'jobtrack.opportunity.triage_panel';
const GRAPH_VERSION = 2;
const STATE_CONTRACT = 'jobtrack-triage-panel-state.v1';
const PROVENANCE_VERSION = 'jobtrack-triage-panel-provenance.v2';
const PRINCIPAL = 'jobtrack.triage.panel';
const SYNTHESIS_STAGE = Object.freeze({ id: 'jobtrack.triage.synthesize', version: 2 });

// Recorded inference parameters shared by the panel. They are part of every
// panellist's sealed binding, so changing one changes the graph identity.
// Temperature is deliberately non-zero: a panel of identical deterministic
// readers would be one reader, and the diversity is the point.
const PANEL_PARAMETERS = Object.freeze({
  temperature: 0.3,
  seed: 7,
  thinking: 'off',
  timeoutMs: 120_000,
  maxOutputTokens: 2048,
  maxOutputBytes: 131_072,
  maxConcurrency: 4,
  toolPolicy: 'none',
  responseContract: VERDICT_CONTRACT
});

class TriagePanelError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TriagePanelError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function panellistNodeId(panellistId) {
  return `panellist_${panellistId.split('.').pop()}`;
}

function buildPanelBinding(mp, sealed) {
  return mp.createModelStageBinding({
    schemaVersion: 'model-stage-binding.v2',
    bindingId: `${sealed.panellist.id}.binding`,
    version: sealed.panellist.version,
    kind: 'model',
    modelRevisionRef: {
      id: 'jobtrack.triage.panel_model',
      version: 1,
      digest: mp.digest({ panel: 'jobtrack.triage', version: 1 })
    },
    inferenceProfileRef: mp.createInferenceProfileRef({
      id: `${sealed.panellist.id}.profile`,
      version: sealed.panellist.version,
      parameters: { ...PANEL_PARAMETERS }
    }),
    personaRef: mp.personaRef(sealed.persona),
    promptStackRef: mp.promptStackRef(sealed.stack)
  });
}

// Synthesis. Every number a human sees is produced here, from published rules.
function synthesize(request, verdictsByPanellist) {
  const verdicts = Object.values(verdictsByPanellist)
    .sort((left, right) => left.panellistId.localeCompare(right.panellistId));

  // A dimension's score is the mean of the panellists who answered it.
  // Panellists who abstained are absent, never zero — an unanswered question
  // is not a bad answer.
  const dimensions = {};
  for (const dimension of DIMENSIONS) {
    const answers = verdicts
      .map((verdict) => verdict.dimensionScores[dimension.key])
      .filter((entry) => entry && typeof entry.score === 'number');
    if (!answers.length) continue;
    const mean = answers.reduce((sum, entry) => sum + entry.score, 0) / answers.length;
    const spread = answers.length > 1
      ? Math.max(...answers.map((a) => a.score)) - Math.min(...answers.map((a) => a.score))
      : 0;
    dimensions[dimension.key] = {
      score: Math.round(mean * 100) / 100,
      panellists: answers.length,
      // Disagreement is reported rather than averaged away: a 50 from two
      // panellists who said 20 and 80 is not the same finding as a 50 both
      // agreed on, and a reviewer should be able to see which it was.
      spread: Math.round(spread * 100) / 100
    };
  }

  const scoredKeys = Object.keys(dimensions);
  const perDimensionScores = Object.fromEntries(scoredKeys.map((key) => [key, dimensions[key].score]));
  const score = scoreOf(perDimensionScores);
  const coverage = coverageOf(scoredKeys);

  // Any single panellist may raise a blocker; blockers are not voted on.
  const hardBlockers = [...new Set(verdicts.flatMap((verdict) => verdict.hardBlockers))].sort();
  const decision = decisionOf({ score, coverage, hardBlockers });

  const rationale = [
    `${verdicts.length} panellists scored ${scoredKeys.length} of ${DIMENSIONS.length} dimensions `
      + `(coverage ${(coverage * 100).toFixed(0)}%).`,
    hardBlockers.length ? `Hard blockers raised: ${hardBlockers.join(', ')}.` : 'No hard blockers raised.',
    coverage < MINIMUM_COVERAGE
      ? `Coverage is below the ${(MINIMUM_COVERAGE * 100).toFixed(0)}% floor, so the panel declines to call it.`
      : `Weighted score ${score === null ? 'unavailable' : score} under ${RUBRIC_VERSION}.`,
    ...verdicts.map((verdict) => `${verdict.panellistId}: ${verdict.summary}`)
  ].join('\n');

  return {
    schemaVersion: OUTCOME_CONTRACT,
    decision,
    score: score === null ? null : score,
    scoreCoverage: score === null ? 0 : Math.round(coverage * 1000) / 1000,
    dimensions,
    hardBlockers,
    verdicts,
    rationale: rationale.slice(0, 4000),
    snapshotDigest: request.snapshotDigest,
    rubricVersion: RUBRIC_VERSION
  };
}

function buildGraph(mp, panel, bindings) {
  return defineLinearGraph(mp, {
    graphId: GRAPH_ID,
    version: GRAPH_VERSION,
    description: 'Score one job opportunity with a panel of distinct personalities and synthesize a triage decision.',
    principalId: PRINCIPAL,
    stateContract: STATE_CONTRACT,
    leaseMs: 900_000,
    maxAttempts: 2,
    nodes: [
      ...panel.map((sealed, index) => ({
        nodeId: panellistNodeId(sealed.panellist.id),
        // The node ref version tracks the panellist version; the outcome
        // vocabulary is versioned with it.
        ref: { id: `${sealed.panellist.id}.node`, version: sealed.panellist.version },
        kind: 'model',
        binding: bindings[index]
      })),
      { nodeId: 'synthesize', ref: { id: SYNTHESIS_STAGE.id, version: SYNTHESIS_STAGE.version }, kind: 'code' }
    ]
  });
}

/**
 * Compile the panel graph without executing it, so a caller can inspect the
 * sealed graph digest and the per-panellist binding digests.
 */
async function compileTriagePanel(options = {}) {
  const mp = await loadMissionPipeline();
  const panel = sealPanel(mp, options.panellists || PANELLISTS);
  const bindings = panel.map((sealed) => buildPanelBinding(mp, sealed));
  const { graph, compiled } = buildGraph(mp, panel, bindings);
  return { mp, panel, bindings, graph, compiled, stateContract: STATE_CONTRACT };
}

/** The panel descriptor a request must carry, derived from the sealed panel. */
function panelManifest(panel) {
  return panel.map((sealed) => ({
    panellistId: sealed.panellist.id,
    personaDigest: sealed.persona.personaDigest,
    stackDigest: sealed.stack.stackDigest,
    dimensions: [...sealed.panellist.dimensions]
  }));
}

function unitIdFor(request) {
  return `${request.requestId}:unit`;
}

const isRefusal = (error) => error?.name === 'TriagePanelRefusal' && typeof error?.code === 'string';

function buildPorts({ mp, panel, bindings, resolver }) {
  const contracts = createTriagePanelContracts();
  const validateOutcome = (value) => {
    const verdict = contracts.validate(OUTCOME_CONTRACT, value);
    if (!verdict.ok) throw new Error(`${OUTCOME_CONTRACT}: ${verdict.issues.map((issue) => issue.message).join('; ')}`);
    return verdict.value;
  };
  const modelNodes = {};
  panel.forEach((sealed) => {
    modelNodes[panellistNodeId(sealed.panellist.id)] = {
      stageId: `${sealed.panellist.id}.stage`,
      stageVersion: sealed.panellist.version,
      // A panellist sees the posting, never another panellist's verdict.
      inputFor: (state) => state.request,
      validateOutput: (output) => validateVerdict(output),
      merge: (state, verdict) => ({ ...state, verdicts: { ...(state.verdicts ?? {}), [sealed.panellist.id]: verdict } })
    };
  });
  return {
    model: createModelPort({ mp, stateContract: STATE_CONTRACT, resolver, bindings, nodes: modelNodes, isRefusal }),
    code: createCodePort({
      mp,
      stateContract: STATE_CONTRACT,
      isRefusal,
      stages: {
        synthesize: {
          async run(state) {
            return { outcome: validateOutcome(synthesize(state.request, state.verdicts ?? {})) };
          }
        }
      }
    })
  };
}

/**
 * Run one triage panel.
 *
 * @param {unknown} rawRequest a jobtrack-triage-panel-request.v1
 * @param {object} [options]
 * @param {object} [options.modelResolver] a ModelBindingResolver; without one
 *   the panel cannot reach a model and fails closed rather than inventing
 *   scores
 * @param {object} [options.store] a UnitStore (outlives this call); defaults to
 *   a unit-scoped SqliteUnitStore over `options.db`
 */
async function runTriagePanel(rawRequest, options = {}) {
  const request = validatePanelRequest(rawRequest);
  const { mp, panel, bindings, graph } = await compileTriagePanel(options);

  // The request must name the exact panel that is about to judge it. A request
  // built against a different panel would otherwise be scored by this one and
  // recorded as though the named panellists had spoken.
  const expected = JSON.stringify(panelManifest(panel));
  const supplied = JSON.stringify(request.panel.map((member) => ({
    panellistId: member.panellistId,
    personaDigest: member.personaDigest,
    stackDigest: member.stackDigest,
    dimensions: [...member.dimensions]
  })));
  if (expected !== supplied) {
    throw new TriagePanelError('PANEL_MISMATCH', 'The request names a different panel than the one compiled here');
  }

  if (!options.modelResolver) {
    throw new TriagePanelError('NO_MODEL_RESOLVER', 'The triage panel requires an injected model resolver; it will not invent scores');
  }
  if (!options.store && !options.db) {
    throw new TriagePanelError('NO_EVIDENCE_STORE', 'The triage panel needs a UnitStore (options.store) or a database (options.db) for its evidence');
  }

  const unitId = unitIdFor(request);
  const store = options.store || new SqliteUnitStore({ db: options.db, mp, scope: unitId });
  const ports = buildPorts({ mp, panel, bindings, resolver: options.modelResolver });

  const run = await runUnitToCompletion({
    mp,
    store,
    graph,
    unitId,
    seedArtifact: mp.createArtifactEnvelope(STATE_CONTRACT, { request }),
    principalId: PRINCIPAL,
    ports,
    leaseOwner: `jobtrack-triage-panel:${process.pid}`
  });

  const refusal = refusalOf(run.terminal);
  if (refusal) {
    throw new TriagePanelError(
      'PANEL_INCOMPLETE',
      `${refusal.nodeId ?? run.terminal.nodeId} declined to produce a verdict: ${refusal.message}`,
      { status: 'refused', nodeId: refusal.nodeId ?? run.terminal.nodeId, errorCode: refusal.code }
    );
  }
  const outcome = run.terminal?.artifact?.payload?.outcome;
  if (!outcome) {
    const letter = run.deadLetter;
    throw new TriagePanelError(
      'PANEL_INCOMPLETE',
      letter ? `${letter.nodeId} could not produce a verdict: ${letter.errorCode}` : 'The triage panel did not complete',
      { status: letter ? 'dead_lettered' : 'incomplete', nodeId: letter?.nodeId, errorCode: letter?.errorCode }
    );
  }

  const bindingByNode = new Map(panel.map((sealed, index) => [panellistNodeId(sealed.panellist.id), bindings[index]]));
  return {
    outcome,
    provenance: {
      schemaVersion: PROVENANCE_VERSION,
      graph: { id: graph.graphId, version: graph.version, graphDigest: graph.graphDigest, unitId },
      rubricVersion: RUBRIC_VERSION,
      panel: panelManifest(panel).map((member, index) => ({ ...member, bindingDigest: bindings[index].bindingDigest })),
      requestDigest: mp.digest(request),
      snapshotDigest: request.snapshotDigest,
      replayed: run.replayed,
      modelReceipts: run.receipts
        .filter((entry) => bindingByNode.has(entry.nodeId))
        .map((entry) => ({
          nodeId: entry.nodeId,
          attempt: entry.attemptIndex,
          bindingDigest: bindingByNode.get(entry.nodeId).bindingDigest,
          receipt: entry.receipt
        }))
    }
  };
}

module.exports = Object.freeze({
  GRAPH_ID,
  GRAPH_VERSION,
  PANEL_PARAMETERS,
  PROVENANCE_VERSION,
  STATE_CONTRACT,
  TriagePanelError,
  compileTriagePanel,
  panelManifest,
  panellistNodeId,
  runTriagePanel,
  synthesize,
  unitIdFor
});
