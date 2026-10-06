'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('strategy CLI drives reviewed frontier plans through dependency work and exact domain binding', (t) => {
  const home = require('../test-support/migrated-store').createTestHome('jobtrack-strategy-command-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const application = run(home, [
    'add-prospect', '--company', 'Acme', '--role', 'Platform Engineer',
    '--url', 'https://jobs.example.test/platform'
  ]).application;
  const postingText = 'Build reliable distributed systems and lead incident response.';
  const posting = run(home, [
    'capture-posting', '--application-id', application.id,
    '--source-url', 'https://jobs.example.test/platform', '--content', postingText
  ]).artifact;

  const policyPath = writeJson(home, 'strategy-policy.json', routingPolicy());
  const importedPolicy = run(home, [
    'strategy', 'policy', 'import', '--input', policyPath,
    '--imported-by', 'cli-test', '--idempotency-key', 'strategy-cli:policy:import'
  ]);
  const policyRevisionId = importedPolicy.policyRevision.id;
  run(home, [
    'strategy', 'policy', 'review', '--policy-revision-id', policyRevisionId,
    '--decision', 'approved', '--reviewed-by', 'policy-reviewer',
    '--expected-review-id', 'none', '--idempotency-key', 'strategy-cli:policy:review'
  ]);
  const selectedPolicy = run(home, [
    'strategy', 'policy', 'select', '--policy-revision-id', policyRevisionId,
    '--selected-by', 'policy-owner', '--expected-current-policy-revision-id', 'none',
    '--idempotency-key', 'strategy-cli:policy:select'
  ]);
  assert.equal(selectedPolicy.policy_revision_id, policyRevisionId);
  assert.equal(run(home, ['strategy', 'policy', 'show']).policy.isApproved, true);

  const catalog = run(home, [
    'strategy', 'context', '--application-id', application.id
  ]).context;
  assert.equal(catalog.mode, 'catalog');
  assert.equal(catalog.selectionRequired, true);
  assert.equal(catalog.availableSources.artifacts.some((row) => row.id === posting.id), true);
  assert.equal(JSON.stringify(catalog).includes(postingText), false);

  const selectedContext = run(home, [
    'strategy', 'context', '--application-id', application.id,
    '--artifact-ids', posting.id
  ]).context;
  assert.equal(selectedContext.mode, 'selected');
  assert.deepEqual(selectedContext.sourceManifest.selectors.artifactIds, [posting.id]);
  assert.equal(selectedContext.selectedSources.artifacts[0].content, postingText);
  assert.match(selectedContext.sourceStateSha256, /^[a-f0-9]{64}$/);

  const planPath = writeJson(home, 'strategy-plan.json', strategyPlan({
    applicationId: application.id,
    postingId: posting.id,
    sourceStateSha256: selectedContext.sourceStateSha256
  }));
  const importedPlan = run(home, [
    'strategy', 'plan', 'import', '--input', planPath,
    '--artifact-ids', posting.id, '--idempotency-key', 'strategy-cli:plan:import'
  ]);
  assert.equal(importedPlan.revision.plan.coordinator.modelClass, 'frontier');
  const strategyRevisionId = importedPlan.revision.id;
  run(home, [
    'strategy', 'plan', 'review', '--strategy-revision-id', strategyRevisionId,
    '--decision', 'approved', '--reviewed-by', 'strategy-reviewer',
    '--expected-review-id', 'none', '--idempotency-key', 'strategy-cli:plan:review'
  ]);
  const selectedPlan = run(home, [
    'strategy', 'plan', 'select', '--strategy-revision-id', strategyRevisionId,
    '--selected-by', 'strategy-owner', '--expected-current-strategy-revision-id', 'none',
    '--idempotency-key', 'strategy-cli:plan:select'
  ]);
  assert.equal(selectedPlan.strategy.coordinator.modelClass, 'frontier');

  const initialQueue = run(home, [
    'strategy', 'queue', '--application-id', application.id
  ]).workItems;
  assert.deepEqual(initialQueue.map((item) => item.state), ['ready', 'blocked-dependencies']);
  const researchItem = initialQueue.find((item) => item.item_key === 'research-company');
  assert(researchItem);

  const issued = run(home, [
    'strategy', 'work', 'issue', '--work-item-id', researchItem.id,
    '--issued-by', 'frontier-coordinator',
    '--expected-source-state-sha256', selectedPlan.strategy.currentSourceStateSha256,
    '--idempotency-key', 'strategy-cli:work:issue'
  ]);
  assert.equal(issued.request.safety.externalActionsAllowed, false);
  assert.equal(issued.request.safety.proposalOnly, true);
  const resultPath = writeJson(home, 'strategy-result.json', successfulResearchResult(issued));
  const recorded = run(home, [
    'strategy', 'work', 'record', '--input', resultPath,
    '--idempotency-key', 'strategy-cli:work:record'
  ]);
  const reviewed = run(home, [
    'strategy', 'work', 'review', '--result-id', recorded.id,
    '--decision', 'accepted', '--reviewed-by', 'frontier-reviewer',
    '--reviewed-as', 'frontier', '--idempotency-key', 'strategy-cli:work:review'
  ]);
  assert.equal(reviewed.state, 'accepted-awaiting-binding');
  assert.equal(run(home, [
    'strategy', 'status', '--application-id', application.id
  ]).workItems[0].state, 'accepted-awaiting-binding');

  const researchArtifact = run(home, [
    'add-research', '--application-id', application.id,
    '--source-url', 'https://www.example.test/about',
    '--citation', 'Example company page', '--content', 'Bound domain research output.'
  ]).artifact;
  const postWriteStatus = run(home, [
    'strategy', 'status', '--application-id', application.id
  ]);
  const postWriteDigest = postWriteStatus.strategy.observedCurrentSourceStateSha256;
  assert.notEqual(postWriteDigest, issued.sourceStateSha256);

  const staleBind = fail(home, [
    'strategy', 'work', 'bind', '--result-id', recorded.id,
    '--application-id', application.id, '--artifact-id', researchArtifact.id,
    '--expected-current-source-state-sha256', issued.sourceStateSha256,
    '--bound-by', 'research-importer', '--reason', 'Bind reviewed research.',
    '--idempotency-key', 'strategy-cli:work:bind:stale'
  ]);
  assert.equal(staleBind.error.code, 'SOURCE_STATE_STALE');

  setApplicationStatus(home, application.id, 'withdrawn');
  const unrelatedDigest = run(home, [
    'strategy', 'status', '--application-id', application.id
  ]).strategy.observedCurrentSourceStateSha256;
  const unrelatedBind = fail(home, [
    'strategy', 'work', 'bind', '--result-id', recorded.id,
    '--application-id', application.id, '--artifact-id', researchArtifact.id,
    '--expected-current-source-state-sha256', unrelatedDigest,
    '--bound-by', 'research-importer', '--reason', 'Do not absorb lifecycle drift.',
    '--idempotency-key', 'strategy-cli:work:bind:unrelated'
  ]);
  assert.equal(unrelatedBind.error.code, 'CHECKPOINT_DELTA_OUT_OF_SCOPE');
  setApplicationStatus(home, application.id, application.status);

  const restoredDigest = run(home, [
    'strategy', 'status', '--application-id', application.id
  ]).strategy.observedCurrentSourceStateSha256;
  assert.equal(restoredDigest, postWriteDigest);
  const bound = run(home, [
    'strategy', 'work', 'bind', '--result-id', recorded.id,
    '--application-id', application.id, '--artifact-id', researchArtifact.id,
    '--expected-current-source-state-sha256', restoredDigest,
    '--bound-by', 'research-importer',
    '--reason', 'Bind the reviewed proposal to the exact immutable research artifact.',
    '--idempotency-key', 'strategy-cli:work:bind'
  ]);
  assert.equal(bound.binding.targetKind, 'artifact');
  assert.equal(bound.binding.targetId, researchArtifact.id);
  assert.equal(bound.checkpoint.priorSourceStateSha256, issued.sourceStateSha256);
  assert.equal(bound.checkpoint.currentSourceStateSha256, restoredDigest);
  assert.equal(bound.checkpoint.workRequestSha256, issued.requestSha256);

  const finalQueue = run(home, [
    'strategy', 'queue', '--application-id', application.id
  ]).workItems;
  assert.deepEqual(finalQueue.map((item) => item.state), ['completed', 'ready']);

  const scopedUnknown = fail(home, [
    'strategy', 'work', 'issue', '--work-item-id', researchItem.id,
    '--issued-by', 'frontier-coordinator', '--expected-source-state-sha256', restoredDigest,
    '--selected-by', 'not-valid-here', '--idempotency-key', 'strategy-cli:unknown-flag'
  ]);
  assert.equal(scopedUnknown.error.code, 'INVALID_ARGUMENT');
  assert.match(scopedUnknown.error.message, /--selected-by/);

  const duplicate = fail(home, [
    'strategy', 'work', 'issue', '--work-item-id', researchItem.id,
    '--work-item-id', researchItem.id, '--issued-by', 'frontier-coordinator',
    '--expected-source-state-sha256', restoredDigest,
    '--idempotency-key', 'strategy-cli:duplicate-flag'
  ]);
  assert.equal(duplicate.error.code, 'JOBTRACK_ERROR');
  assert.match(duplicate.error.message, /Duplicate flag: --work-item-id/);

  const operationCount = strategyOperationCount(home);
  for (const effect of ['execute', 'send', 'apply', 'submit']) {
    for (const command of [
      ['strategy', effect],
      ['strategy', 'work', effect]
    ]) {
      const rejected = fail(home, command);
      assert.equal(rejected.error.code, 'UNKNOWN_COMMAND');
    }
  }
  assert.equal(strategyOperationCount(home), operationCount);
});

function routingPolicy() {
  const budgets = {
    maxInputTokens: 1_000,
    maxOutputTokens: 1_000,
    maxCostMicros: 10_000,
    maxDurationMs: 10_000
  };
  return {
    schemaVersion: 'application-strategy-routing-policy.v1',
    policyId: 'strategy-cli-policy',
    version: 1,
    coordinator: {
      capability: 'application-strategy',
      requiredModelClass: 'frontier',
      routeAlias: 'frontier-coordinator'
    },
    rules: [
      {
        capability: 'company-research',
        defaultRouteAlias: 'research-worker',
        minimumModelClass: 'strong',
        escalationModelClass: 'frontier',
        maxAttempts: 2,
        reviewMode: 'frontier',
        budgets
      },
      {
        capability: 'email-tone-analysis',
        defaultRouteAlias: 'tone-worker',
        minimumModelClass: 'strong',
        escalationModelClass: 'frontier',
        maxAttempts: 2,
        reviewMode: 'frontier',
        budgets
      }
    ],
    forbiddenEffects: ['execute', 'send-email', 'submit-application', 'external-mutation']
  };
}

function strategyPlan({ applicationId, postingId, sourceStateSha256 }) {
  return {
    schemaVersion: 'application-strategy-plan.v1',
    trust: 'model_proposal',
    applicationId,
    sourceStateSha256,
    coordinator: {
      runId: 'strategy-cli-frontier-run',
      routeAlias: 'frontier-coordinator',
      modelClass: 'frontier',
      provider: 'test-provider',
      model: 'test-frontier-model',
      modelVersion: '2026-07-18'
    },
    objective: 'Advance the application through reviewed, evidence-bound proposals.',
    thesis: 'Research the company before performing the dependent posting analysis.',
    assumptions: ['The selected posting is current.'],
    risks: ['The public evidence may be incomplete.'],
    stopConditions: ['Stop when the application is withdrawn.'],
    workItems: [
      {
        key: 'research-company',
        capability: 'company-research',
        title: 'Research the company',
        goal: 'Produce an evidence-backed research proposal.',
        priority: 1,
        dependsOn: [],
        acceptanceCriteria: ['Every material claim cites selected evidence.'],
        sourceRefs: [{ kind: 'artifact', id: postingId }],
        outputKind: 'research-proposal',
        reviewGate: 'frontier'
      },
      {
        key: 'analyze-tone',
        capability: 'email-tone-analysis',
        title: 'Analyze communication tone',
        goal: 'Produce bounded communication guidance after research is domain-bound.',
        priority: 2,
        dependsOn: ['research-company'],
        acceptanceCriteria: ['The analysis remains a proposal with no external effect.'],
        sourceRefs: [{ kind: 'artifact', id: postingId }],
        outputKind: 'analysis',
        reviewGate: 'frontier'
      }
    ]
  };
}

function successfulResearchResult(request) {
  return {
    schemaVersion: 'application-strategy-work-result.v1',
    trust: 'model_proposal',
    requestId: request.id,
    requestDigest: request.requestSha256,
    sourceStateSha256: request.sourceStateSha256,
    status: 'succeeded',
    worker: {
      runId: 'strategy-cli-research-run',
      routeAlias: request.routeAlias,
      modelClass: request.request.routing.requiredModelClass,
      provider: 'test-provider',
      model: 'test-research-model',
      modelVersion: '2026-07-18'
    },
    usage: { inputTokens: 20, outputTokens: 20, costMicros: 100, durationMs: 100 },
    confidence: 0.9,
    summary: 'Produced an evidence-bound research proposal.',
    claims: [{
      statement: 'The proposal is grounded in the selected posting.',
      evidenceRefs: ['selected-artifact']
    }],
    output: {
      kind: 'research-proposal',
      payload: { summary: 'Immutable company research artifact proposed for domain review.' }
    }
  };
}

function run(home, args) {
  const stdout = execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return JSON.parse(stdout);
}

function fail(home, args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0, `expected failure, got stdout: ${result.stdout}`);
  assert.equal(result.signal, null);
  return JSON.parse(result.stderr);
}

function writeJson(home, filename, value) {
  const target = path.join(home, filename);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return target;
}

function setApplicationStatus(home, applicationId, status) {
  const db = new Database(path.join(home, 'jobtrack.db'));
  try {
    db.prepare('UPDATE applications SET status=? WHERE id=?').run(status, applicationId);
  } finally {
    db.close();
  }
}

function strategyOperationCount(home) {
  const db = new Database(path.join(home, 'jobtrack.db'), { readonly: true });
  try {
    return db.prepare('SELECT count(*) AS count FROM application_strategy_operations').get().count;
  } finally {
    db.close();
  }
}
