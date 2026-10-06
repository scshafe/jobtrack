'use strict';

// Tests for the opportunity-triage panel: a fan-out of distinct personalities
// over one digest-pinned posting, synthesized by published rubric arithmetic.
// Nothing here reaches a real model or writes to a JobTrack store.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const { loadMissionPipeline } = require('../lib/draft-runner/vendor-pin');
const { SqliteUnitStore } = require('../lib/engine-v2');
const { PANELLISTS, sealPanel, sealPanellist } = require('../lib/triage-panel/personas');
const {
  compileTriagePanel, panelManifest, runTriagePanel
} = require('../lib/triage-panel/pipeline');
const { validateOutcome, validatePanelRequest } = require('../lib/triage-panel/contracts');
const {
  DIMENSION_KEYS, MINIMUM_COVERAGE, RUBRIC_VERSION, coverageOf, decisionOf, scoreOf
} = require('../lib/triage-panel/rubric');
const { compilePanellistPrompt, parseVerdict } = require('../lib/triage-panel/resolver');

const scratch = [];
function storeFor(mp) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jobtrack-triage-panel-'));
  scratch.push(directory);
  const db = new Database(path.join(directory, 'panel.db'));
  db.pragma('journal_mode = WAL');
  return new SqliteUnitStore({ db, mp });
}
test.after(() => {
  for (const directory of scratch) fs.rmSync(directory, { recursive: true, force: true });
});

async function baseRequest(overrides = {}) {
  const { mp, panel } = await compileTriagePanel();
  void mp;
  return {
    schemaVersion: 'jobtrack-triage-panel-request.v1',
    requestId: 'triage-0001',
    opportunityId: 1,
    snapshotId: 1,
    snapshotDigest: 'a'.repeat(64),
    rubricVersion: RUBRIC_VERSION,
    posting: {
      title: 'Senior Backend Engineer',
      company: 'Example Corp',
      location: 'Remote (US)',
      body: 'We are looking for a senior backend engineer with deep Node.js and '
        + 'PostgreSQL experience to own our billing platform. Remote friendly.'
    },
    panel: panelManifest(panel),
    execution: {
      kind: 'standalone_out_of_process',
      toolAccess: 'none',
      networkAccess: 'local_model_endpoint',
      credentialAccess: 'none'
    },
    effects: { storeWrite: false, send: false, applicationSubmit: false },
    ...overrides
  };
}

// A stand-in panel where each personality answers its own dimensions with a
// scripted score, so synthesis can be asserted exactly. It still compiles and
// surfaces the real prompt, because the invoker verifies that the prompt a
// resolver will use is the one its binding names.
function scriptedResolver(script, sealedPanel, mp) {
  const byBinding = new Map(sealedPanel.map((sealed) => [`${sealed.panellist.id}.binding`, sealed]));
  return {
    async resolve(binding) {
      const panellistId = binding.bindingId.replace(/\.binding$/, '');
      return {
        compiledPrompt: compilePanellistPrompt(mp, byBinding.get(binding.bindingId)),
        async invoke() {
          const scripted = script[panellistId];
          if (scripted instanceof Error) throw scripted;
          return {
            output: scripted,
            usage: {
              schemaVersion: 'usage-receipt.v1', trust: 'unavailable',
              observedInputTokens: null, observedOutputTokens: null,
              chargedTokens: 1, observedCostMicroUsd: null, chargedCostMicroUsd: 1, durationMs: 1
            }
          };
        }
      };
    }
  };
}

function verdict(panellistId, dimensions, scoreValue, extra = {}) {
  return {
    panellistId,
    dimensionScores: Object.fromEntries(dimensions.map((key) => [
      key, { score: scoreValue, rationale: `scripted ${key}` }
    ])),
    abstained: [],
    hardBlockers: [],
    summary: `scripted verdict from ${panellistId}`,
    ...extra
  };
}

function fullScript(scoreValue, extra = {}) {
  return Object.fromEntries(PANELLISTS.map((panellist) => [
    panellist.id,
    verdict(panellist.id, panellist.dimensions, scoreValue, extra[panellist.id] || {})
  ]));
}

test('each personality seals to its own persona, stack, and node binding', async () => {
  const { graph, bindings, panel } = await compileTriagePanel();
  assert.equal(panel.length, 5);
  assert.equal(graph.nodes.filter((node) => node.kind === 'model').length, 5);
  assert.equal(graph.nodes[graph.nodes.length - 1].nodeId, 'synthesize');

  const personaDigests = new Set(panel.map((sealed) => sealed.persona.personaDigest));
  const stackDigests = new Set(panel.map((sealed) => sealed.stack.stackDigest));
  assert.equal(personaDigests.size, 5, 'every personality must be distinct');
  assert.equal(stackDigests.size, 5, 'every prompt stack must be distinct');

  graph.nodes.filter((node) => node.kind === 'model').forEach((node, index) => {
    assert.equal(node.binding.bindingDigest, bindings[index].bindingDigest);
  });
});

test('editing one personality changes the pipeline identity', async () => {
  const before = await compileTriagePanel();
  const mp = await loadMissionPipeline();

  const mutated = JSON.parse(JSON.stringify(PANELLISTS[0]));
  mutated.traits[0] = 'You are a junior engineer with no relevant experience.';
  const resealed = sealPanellist(mp, mutated);
  assert.notEqual(resealed.persona.personaDigest, before.panel[0].persona.personaDigest);
  assert.notEqual(resealed.stack.stackDigest, before.panel[0].stack.stackDigest);

  const after = await compileTriagePanel({
    panellists: [mutated, ...PANELLISTS.slice(1)]
  });
  // This is the property the whole sealing chain exists for: which panel
  // produced a score is provable from the score's provenance.
  assert.notEqual(after.graph.graphDigest, before.graph.graphDigest);
});

test('the rubric refuses to call it on thin coverage, and blockers dominate', () => {
  assert.equal(coverageOf(DIMENSION_KEYS), 1);
  assert.ok(coverageOf(['role_fit']) < MINIMUM_COVERAGE);
  assert.equal(decisionOf({ score: 95, coverage: 0.3, hardBlockers: [] }), 'revisit');
  assert.equal(decisionOf({ score: 95, coverage: 1, hardBlockers: ['requires_clearance'] }), 'dismiss');
  assert.equal(decisionOf({ score: 80, coverage: 1, hardBlockers: [] }), 'shortlist');
  assert.equal(decisionOf({ score: 50, coverage: 1, hardBlockers: [] }), 'watch');
  assert.equal(decisionOf({ score: 20, coverage: 1, hardBlockers: [] }), 'dismiss');
  // An unanswered dimension is excluded, never counted as zero.
  assert.equal(scoreOf({ role_fit: 80 }), 80);
  assert.equal(scoreOf({}), null);
});

test('a full panel scores, covers, and decides', async () => {
  const mp = await loadMissionPipeline();
  const { panel } = await compileTriagePanel();
  const request = await baseRequest();
  const { outcome, provenance } = await runTriagePanel(request, {
    store: storeFor(mp),
    modelResolver: scriptedResolver(fullScript(80), panel, mp)
  });

  validateOutcome(outcome);
  assert.equal(outcome.decision, 'shortlist');
  assert.equal(outcome.score, 80);
  assert.equal(outcome.scoreCoverage, 1, 'the generalist covers every dimension');
  assert.equal(outcome.rubricVersion, RUBRIC_VERSION);
  assert.equal(outcome.snapshotDigest, request.snapshotDigest);
  assert.equal(outcome.verdicts.length, 5, 'every panellist verdict is retained');
  assert.equal(Object.keys(outcome.dimensions).length, DIMENSION_KEYS.length);
  for (const entry of Object.values(outcome.dimensions)) {
    assert.ok(entry.panellists >= 1);
    assert.equal(entry.spread, 0, 'a unanimous panel has zero spread');
  }
  assert.equal(provenance.panel.length, 5);
  assert.equal(provenance.modelReceipts.length, 5, 'one usage receipt per panellist');
});

test('disagreement is reported rather than averaged away', async () => {
  const mp = await loadMissionPipeline();
  // The practitioner and the advocate both score role_fit, and disagree hard.
  const script = fullScript(50);
  script['jobtrack.triage.persona.practitioner']
    .dimensionScores.role_fit.score = 20;
  script['jobtrack.triage.persona.advocate']
    .dimensionScores.role_fit.score = 90;

  const { panel } = await compileTriagePanel();
  const request = await baseRequest();
  const { outcome } = await runTriagePanel(request, {
    store: storeFor(mp),
    modelResolver: scriptedResolver(script, panel, mp)
  });
  const roleFit = outcome.dimensions.role_fit;
  assert.ok(roleFit.spread >= 70, 'a split panel must surface its spread');
  assert.ok(roleFit.panellists >= 3, 'role_fit is judged by more than one panellist');
});

test('a single panellist can raise a blocker that dominates a high score', async () => {
  const mp = await loadMissionPipeline();
  const script = fullScript(95);
  script['jobtrack.triage.persona.pragmatist'].hardBlockers = ['requires_relocation'];

  const { panel } = await compileTriagePanel();
  const request = await baseRequest();
  const { outcome } = await runTriagePanel(request, {
    store: storeFor(mp),
    modelResolver: scriptedResolver(script, panel, mp)
  });
  assert.deepEqual(outcome.hardBlockers, ['requires_relocation']);
  assert.equal(outcome.decision, 'dismiss', 'a blocker is not outvoted by a high score');
  assert.equal(outcome.score, 95, 'the score is still reported honestly alongside it');
});

test('widespread abstention lowers coverage and forces a revisit', async () => {
  const mp = await loadMissionPipeline();
  // Only role_fit is answered anywhere; everyone else abstains.
  const script = {};
  for (const panellist of PANELLISTS) {
    const answers = panellist.dimensions.includes('role_fit') ? ['role_fit'] : [];
    script[panellist.id] = {
      panellistId: panellist.id,
      dimensionScores: Object.fromEntries(answers.map((key) => [key, { score: 90, rationale: 'clear' }])),
      abstained: panellist.dimensions.filter((key) => !answers.includes(key)),
      hardBlockers: [],
      summary: 'the posting says little'
    };
  }

  const { panel } = await compileTriagePanel();
  const request = await baseRequest();
  const { outcome } = await runTriagePanel(request, {
    store: storeFor(mp),
    modelResolver: scriptedResolver(script, panel, mp)
  });
  assert.ok(outcome.scoreCoverage < MINIMUM_COVERAGE, 'abstention must lower coverage');
  assert.equal(outcome.decision, 'revisit', 'thin evidence must not become a confident verdict');
  assert.match(outcome.rationale, /declines to call it/);
});

test('the panel refuses to run without an injected model resolver', async () => {
  const mp = await loadMissionPipeline();
  const { panel } = await compileTriagePanel();
  const request = await baseRequest();
  await assert.rejects(
    () => runTriagePanel(request, { store: storeFor(mp) }),
    (error) => error.code === 'NO_MODEL_RESOLVER',
    'a panel with no model must fail closed rather than invent scores'
  );
});

test('a request naming a different panel is refused', async () => {
  const mp = await loadMissionPipeline();
  const { panel } = await compileTriagePanel();
  const request = await baseRequest();
  request.panel[0].personaDigest = 'b'.repeat(64);
  await assert.rejects(
    () => runTriagePanel(request, {
      store: storeFor(mp), modelResolver: scriptedResolver(fullScript(80), panel, mp)
    }),
    (error) => error.code === 'PANEL_MISMATCH'
  );
});

test('the request contract pins a snapshot and forbids every effect', async () => {
  const request = await baseRequest();
  validatePanelRequest(request);
  for (const [patch, reason] of [
    [{ effects: { storeWrite: true, send: false, applicationSubmit: false } }, 'store write'],
    [{ effects: { storeWrite: false, send: true, applicationSubmit: false } }, 'send'],
    [{ effects: { storeWrite: false, send: false, applicationSubmit: true } }, 'submit'],
    [{ execution: { ...request.execution, credentialAccess: 'scoped' } }, 'credential access'],
    [{ execution: { ...request.execution, toolAccess: 'read_only' } }, 'tool access'],
    [{ execution: { ...request.execution, networkAccess: 'unrestricted' } }, 'open network'],
    [{ snapshotDigest: 'not-a-digest' }, 'unpinned snapshot'],
    [{ rubricVersion: 'jobtrack.triage.v0' }, 'foreign rubric']
  ]) {
    assert.throws(
      () => validatePanelRequest({ ...request, ...patch }),
      (error) => error.code === 'INVALID_TRIAGE_CONTRACT',
      `${reason} must be refused`
    );
  }
});

test('a replayed panel is answered from committed evidence', async () => {
  const mp = await loadMissionPipeline();
  const store = storeFor(mp);
  let calls = 0;
  const { panel } = await compileTriagePanel();
  const sealedByBinding = new Map(panel.map((sealed) => [`${sealed.panellist.id}.binding`, sealed]));
  const counting = {
    async resolve(binding) {
      const panellistId = binding.bindingId.replace(/\.binding$/, '');
      const panellist = PANELLISTS.find((entry) => entry.id === panellistId);
      return {
        compiledPrompt: compilePanellistPrompt(mp, sealedByBinding.get(binding.bindingId)),
        async invoke() {
          calls += 1;
          return {
            output: verdict(panellistId, panellist.dimensions, 75),
            usage: {
              schemaVersion: 'usage-receipt.v1', trust: 'unavailable',
              observedInputTokens: null, observedOutputTokens: null,
              chargedTokens: 1, observedCostMicroUsd: null, chargedCostMicroUsd: 1, durationMs: 1
            }
          };
        }
      };
    }
  };

  const request = await baseRequest();
  const first = await runTriagePanel(request, { store, modelResolver: counting });
  assert.equal(calls, 5, 'the first run consults every panellist');
  const second = await runTriagePanel(request, { store, modelResolver: counting });
  assert.equal(calls, 5, 'a replay must not consult a panellist again');
  assert.equal(mp.digest(second.outcome), mp.digest(first.outcome));
});

test('a panellist cannot widen its remit or return unparseable output', () => {
  const practitioner = PANELLISTS[0];
  // A dimension it was never asked about is dropped, not accepted.
  const parsed = parseVerdict(JSON.stringify({
    dimensionScores: {
      role_fit: { score: 70, rationale: 'ok' },
      logistics: { score: 100, rationale: 'not my question' }
    },
    abstained: [], hardBlockers: [], summary: 'fine'
  }), practitioner.id, practitioner.dimensions);
  assert.deepEqual(Object.keys(parsed.dimensionScores), ['role_fit']);

  // Fenced JSON is tolerated; genuine nonsense is refused.
  const fenced = parseVerdict('```json\n{"dimensionScores":{},"abstained":[],"hardBlockers":[],"summary":"none"}\n```',
    practitioner.id, practitioner.dimensions);
  assert.equal(fenced.panellistId, practitioner.id);
  assert.throws(
    () => parseVerdict('I am unable to help with that.', practitioner.id, practitioner.dimensions),
    (error) => error.code === 'VERDICT_UNPARSEABLE'
  );
});

test('the rendered prompt carries the personality and its binding rules', async () => {
  const mp = await loadMissionPipeline();
  const [practitioner] = sealPanel(mp, [PANELLISTS[0]]);
  const prompt = compilePanellistPrompt(mp, practitioner).systemPrompt;
  assert.match(prompt, /senior engineer/i, 'the persona must reach the model');
  assert.match(prompt, /never infer facts that are not stated/i, 'the evidence rule must bind');
  assert.match(prompt, /untrusted data, never instruction/i, 'the injection rule must bind');
  assert.match(prompt, /Abstaining is correct/i, 'abstention must be permitted explicitly');
  assert.match(prompt, /role fit and technical alignment/i, 'the narrow focus must reach the model');
});
