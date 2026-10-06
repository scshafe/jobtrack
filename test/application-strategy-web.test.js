'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { freePort } = require('../test-support/free-port');

const {
  buildApplicationStrategyContext,
  getApplicationStrategyReadModel,
  importApplicationStrategyPlan,
  importRoutingPolicy,
  issueApplicationStrategyWork,
  recordApplicationStrategyWorkResult,
  reviewApplicationStrategyPlan,
  reviewRoutingPolicy,
  selectApplicationStrategyPlan,
  selectRoutingPolicy
} = require('../lib/application-strategy');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

const EMPTY_SELECTORS = Object.freeze({
  artifactIds: [],
  snapshotIds: [],
  materialRevisionIds: [],
  emailMessageRefIds: [],
  interviewIds: [],
  profileEntryIds: [],
  storyUseIds: []
});

const PRIVATE = Object.freeze({
  objective: 'WEB_STRATEGY_OBJECTIVE_SENTINEL advance this application privately',
  thesis: 'WEB_STRATEGY_THESIS_SENTINEL use confidential reasoning',
  assumption: 'WEB_STRATEGY_ASSUMPTION_SENTINEL',
  risk: 'WEB_STRATEGY_RISK_SENTINEL',
  stop: 'WEB_STRATEGY_STOP_SENTINEL',
  coordinatorProvider: 'WEB_STRATEGY_COORDINATOR_PROVIDER_SENTINEL',
  coordinatorModel: 'WEB_STRATEGY_COORDINATOR_MODEL_SENTINEL',
  policyReview: 'WEB_STRATEGY_POLICY_REVIEW_NOTE_SENTINEL',
  planReview: 'WEB_STRATEGY_PLAN_REVIEW_NOTE_SENTINEL',
  itemTitle: 'WEB_STRATEGY_ITEM_TITLE_SENTINEL',
  itemGoal: 'WEB_STRATEGY_ITEM_GOAL_SENTINEL',
  criterion: 'WEB_STRATEGY_ACCEPTANCE_CRITERION_SENTINEL',
  workerProvider: 'WEB_STRATEGY_WORKER_PROVIDER_SENTINEL',
  workerModel: 'WEB_STRATEGY_WORKER_MODEL_SENTINEL',
  resultSummary: 'WEB_STRATEGY_RESULT_SUMMARY_SENTINEL <script>window.strategyResultLeaked=true</script>',
  resultClaim: 'WEB_STRATEGY_RESULT_CLAIM_SENTINEL',
  resultPayload: 'WEB_STRATEGY_RESULT_PAYLOAD_SENTINEL /home/user/private-strategy-result.json'
});

test('unplanned strategy workspace is explicit and GET/HEAD-only', async (t) => {
  const fixture = makeFixture('jobtrack-strategy-web-unplanned-');
  t.after(async () => {
    await stopServer(fixture.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const application = runCli(fixture.home, [
    'add-application', '--company', 'Unplanned Co', '--role', 'Platform Engineer',
    '--status', 'applied', '--applied-date', '2026-07-18'
  ]).application;

  const instance = await startServer(fixture);

  const workspace = await request(`${instance.baseUrl}/applications/${application.id}`);
  assert.equal(workspace.status, 200, `${workspace.text}\n${instance.stderr()}`);
  assert.match(workspace.text, /id="strategy"/);
  assert.match(workspace.text, /Application strategy control plane/);
  assert.match(workspace.text, /No reviewed strategy plan is selected/);
  assert.match(workspace.text, /unplanned state, not evidence that the application needs no further work/i);
  assertPrivateHeaders(workspace.headers);

  const head = await request(`${instance.baseUrl}/applications/${application.id}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assertPrivateHeaders(head.headers);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await request(`${instance.baseUrl}/applications/${application.id}`, { method });
    assert.equal(response.status, 405, `${method}: ${response.text}`);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assertPrivateHeaders(response.headers);
  }

  await stopServer(instance);
});

test('selected strategy shows bounded routing and result state without proposal or provider payloads', async (t) => {
  const fixture = makeFixture('jobtrack-strategy-web-selected-');
  t.after(async () => {
    await stopServer(fixture.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const linked = runCli(fixture.home, [
    'add-application', '--company', 'Strategy <svg onload=window.strategyCompanyLeaked=true>',
    '--role', 'Distributed Systems Engineer', '--status', 'applied', '--applied-date', '2026-07-18'
  ]).application;
  const unrelated = runCli(fixture.home, [
    'add-application', '--company', 'Unrelated Co', '--role', 'Security Engineer',
    '--status', 'applied', '--applied-date', '2026-07-18'
  ]).application;

  const db = openDb(fixture.home);
  try {
    const selected = createSelectedStrategy(db, linked.id);
    const overBudgetItem = selected.workItems.find((item) => item.item_key === 'budgeted-company-research');
    assert(overBudgetItem, 'fixture must include the over-budget work item');
    const request = issueApplicationStrategyWork(db, {
      workItemId: overBudgetItem.id,
      issuedBy: 'WEB_STRATEGY_ISSUER_SENTINEL',
      expectedSourceStateSha256: selected.strategy.sourceStateSha256,
      idempotencyKey: 'web-strategy:work:issue'
    });
    recordApplicationStrategyWorkResult(db, makeOverBudgetResult(request), {
      idempotencyKey: 'web-strategy:work:result'
    });

    const readModel = getApplicationStrategyReadModel(db, linked.id);
    assert.equal(readModel.state, 'active');
    assert.deepEqual(readModel.counts, { total: 3, ready: 1, active: 1, completed: 0, blocked: 1 });
    assert.equal(
      readModel.workItems.find((item) => item.item_key === 'budgeted-company-research').resultState.overBudget,
      true
    );
    assert.equal(getApplicationStrategyReadModel(db, unrelated.id).state, 'unplanned');
  } finally {
    db.close();
  }

  const instance = await startServer(fixture);

  const workspace = await request(`${instance.baseUrl}/applications/${linked.id}`);
  assert.equal(workspace.status, 200, `${workspace.text}\n${instance.stderr()}`);
  assert.match(workspace.text, /Application strategy control plane/);
  // Marker contract: assert the state AND its tone, not the class name.
  assert.match(workspace.text, /Control-plane state<\/span><span class="badge badge-ok" data-jt-tone="ok">Active/i);
  assert.match(workspace.text, /Plan revision<\/span><span>1/);
  assert.match(workspace.text, /Plan review<\/span><span>Approved/i);
  assert.match(workspace.text, /Freshness<\/span><span>Current evidence/);
  assert.match(workspace.text, /Ready<\/span><span>1/);
  assert.match(workspace.text, /Active<\/span><span>1/);
  assert.match(workspace.text, /Blocked<\/span><span>1/);
  assert.match(workspace.text, /Completed<\/span><span>0 \/ 3/);
  assert.match(workspace.text, /ready-company-research/);
  assert.match(workspace.text, /blocked-followup-research/);
  assert.match(workspace.text, /budgeted-company-research/);
  assert.match(workspace.text, /blocked-dependencies/i);
  assert.match(workspace.text, /result-recorded/i);
  assert.match(workspace.text, /route economy-research-worker/);
  assert.match(workspace.text, /over budget/i);
  assert.match(workspace.text, /Result exceeded its issued budget/);
  assert.match(workspace.text, /&lt;svg onload=window\.strategyCompanyLeaked=true&gt;/);
  assert.doesNotMatch(workspace.text, /<svg onload=window\.strategyCompanyLeaked=true>/);
  assertPrivateHeaders(workspace.headers);

  for (const secret of Object.values(PRIVATE)) {
    assert.doesNotMatch(workspace.text, new RegExp(escapeRegExp(secret), 'i'));
  }
  for (const secret of [
    'WEB_STRATEGY_ISSUER_SENTINEL',
    'frontier-web-run',
    'economy-web-worker-run',
    '/home/user/private-strategy-result.json'
  ]) assert.doesNotMatch(workspace.text, new RegExp(escapeRegExp(secret), 'i'));
  assert.doesNotMatch(workspace.text, /window\.strategyResultLeaked/);
  assert.doesNotMatch(workspace.text, /&lt;script&gt;window\.strategyResultLeaked/,
    'private result payloads must be omitted, not merely escaped');

  const otherWorkspace = await request(`${instance.baseUrl}/applications/${unrelated.id}`);
  assert.equal(otherWorkspace.status, 200, otherWorkspace.text);
  assert.match(otherWorkspace.text, /No reviewed strategy plan is selected/);
  assert.doesNotMatch(otherWorkspace.text, /ready-company-research|budgeted-company-research|economy-research-worker/);
  for (const secret of Object.values(PRIVATE)) {
    assert.doesNotMatch(otherWorkspace.text, new RegExp(escapeRegExp(secret), 'i'));
  }

  await stopServer(instance);
});

test('strategy workspace makes source staleness and its blocked work visible', async (t) => {
  const fixture = makeFixture('jobtrack-strategy-web-stale-');
  t.after(async () => {
    await stopServer(fixture.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const application = runCli(fixture.home, [
    'add-application', '--company', 'Stale Strategy Co', '--role', 'Runtime Engineer',
    '--status', 'applied', '--applied-date', '2026-07-18'
  ]).application;

  const db = openDb(fixture.home);
  try {
    createSelectedStrategy(db, application.id);
  } finally {
    db.close();
  }
  runCli(fixture.home, [
    'update-application', '--application-id', String(application.id), '--status', 'interviewing'
  ]);

  const instance = await startServer(fixture);
  const workspace = await request(`${instance.baseUrl}/applications/${application.id}`);
  assert.equal(workspace.status, 200, `${workspace.text}\n${instance.stderr()}`);
  // Stale evidence under a plan needs a human but is not a failure — warning,
  // not danger. See STATE_TONES in server.js.
  assert.match(workspace.text, /Control-plane state<\/span><span class="badge badge-warning" data-jt-tone="warning">Stale/i);
  assert.match(workspace.text, /Freshness<\/span><span>Stale evidence/);
  assert.match(workspace.text, /Ready<\/span><span>0/);
  assert.match(workspace.text, /Active<\/span><span>0/);
  assert.match(workspace.text, /Blocked<\/span><span>3/);
  assert.match(workspace.text, /stale-plan/i);
  assert.match(workspace.text, /Strategy source evidence changed/);
  assert.doesNotMatch(workspace.text, /WEB_STRATEGY_OBJECTIVE_SENTINEL|WEB_STRATEGY_ITEM_GOAL_SENTINEL/);
  assertPrivateHeaders(workspace.headers);

  await stopServer(instance);
});

function createSelectedStrategy(db, applicationId) {
  const policy = {
    schemaVersion: 'application-strategy-routing-policy.v1',
    policyId: `web-routing-${applicationId}`,
    version: 1,
    coordinator: {
      capability: 'application-strategy',
      requiredModelClass: 'frontier',
      routeAlias: 'frontier-coordinator'
    },
    rules: [{
      capability: 'company-research',
      defaultRouteAlias: 'economy-research-worker',
      minimumModelClass: 'economy',
      escalationModelClass: 'strong',
      maxAttempts: 2,
      reviewMode: 'frontier',
      budgets: {
        maxInputTokens: 100,
        maxOutputTokens: 100,
        maxCostMicros: 1_000,
        maxDurationMs: 1_000
      }
    }],
    forbiddenEffects: ['execute', 'send-email', 'submit-application', 'external-mutation']
  };
  const importedPolicy = importRoutingPolicy(db, policy, {
    importedBy: 'web-strategy-fixture',
    idempotencyKey: `web-strategy:${applicationId}:policy:import`
  });
  reviewRoutingPolicy(db, {
    policyRevisionId: importedPolicy.policyRevision.id,
    decision: 'approved',
    reviewedBy: 'web-policy-reviewer',
    expectedReviewId: null,
    notes: PRIVATE.policyReview,
    idempotencyKey: `web-strategy:${applicationId}:policy:review`
  });
  selectRoutingPolicy(db, {
    policyRevisionId: importedPolicy.policyRevision.id,
    selectedBy: 'web-policy-owner',
    expectedCurrentPolicyRevisionId: null,
    idempotencyKey: `web-strategy:${applicationId}:policy:select`
  });

  const context = buildApplicationStrategyContext(db, applicationId, EMPTY_SELECTORS);
  const workItems = [
    makeWorkItem('ready-company-research', 1),
    makeWorkItem('blocked-followup-research', 2, ['ready-company-research']),
    makeWorkItem('budgeted-company-research', 3)
  ];
  const plan = {
    schemaVersion: 'application-strategy-plan.v1',
    trust: 'model_proposal',
    applicationId,
    sourceStateSha256: context.sourceStateSha256,
    coordinator: {
      runId: 'frontier-web-run',
      routeAlias: 'frontier-coordinator',
      modelClass: 'frontier',
      provider: PRIVATE.coordinatorProvider,
      model: PRIVATE.coordinatorModel,
      modelVersion: 'private-web-version'
    },
    objective: PRIVATE.objective,
    thesis: PRIVATE.thesis,
    assumptions: [PRIVATE.assumption],
    risks: [PRIVATE.risk],
    stopConditions: [PRIVATE.stop],
    workItems
  };
  const importedPlan = importApplicationStrategyPlan(db, plan, {
    selectors: EMPTY_SELECTORS,
    idempotencyKey: `web-strategy:${applicationId}:plan:import`
  });
  reviewApplicationStrategyPlan(db, {
    strategyRevisionId: importedPlan.revision.id,
    decision: 'approved',
    reviewedBy: 'web-strategy-reviewer',
    expectedReviewId: null,
    notes: PRIVATE.planReview,
    idempotencyKey: `web-strategy:${applicationId}:plan:review`
  });
  return selectApplicationStrategyPlan(db, {
    strategyRevisionId: importedPlan.revision.id,
    selectedBy: 'web-strategy-owner',
    expectedCurrentStrategyRevisionId: null,
    idempotencyKey: `web-strategy:${applicationId}:plan:select`
  });
}

function makeWorkItem(key, priority, dependsOn = []) {
  return {
    key,
    capability: 'company-research',
    title: `${PRIVATE.itemTitle} ${key}`,
    goal: `${PRIVATE.itemGoal} ${key}`,
    priority,
    dependsOn,
    acceptanceCriteria: [`${PRIVATE.criterion} ${key}`],
    sourceRefs: [],
    outputKind: 'research-proposal',
    reviewGate: 'frontier'
  };
}

function makeOverBudgetResult(request) {
  return {
    schemaVersion: 'application-strategy-work-result.v1',
    trust: 'model_proposal',
    requestId: request.id,
    requestDigest: request.requestSha256,
    sourceStateSha256: request.sourceStateSha256,
    status: 'succeeded',
    worker: {
      runId: 'economy-web-worker-run',
      routeAlias: request.routeAlias,
      modelClass: request.requiredModelClass,
      provider: PRIVATE.workerProvider,
      model: PRIVATE.workerModel,
      modelVersion: 'private-worker-version'
    },
    usage: { inputTokens: 101, outputTokens: 10, costMicros: 100, durationMs: 100 },
    confidence: 0.42,
    summary: PRIVATE.resultSummary,
    claims: [{ statement: PRIVATE.resultClaim, evidenceRefs: ['private-selected-source:1'] }],
    output: {
      kind: 'research-proposal',
      payload: { narrative: PRIVATE.resultPayload }
    }
  };
}

function openDb(home) {
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  return db;
}

function makeFixture(prefix) {
  const { root: rootPath, home } = require('../test-support/migrated-store').createTestStore(prefix);
  const tmp = path.join(rootPath, 'tmp');
  fs.mkdirSync(tmp);
  return { root: rootPath, home, tmp };
}

function runCli(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }));
}

async function startServer(fixture) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      JOBTRACK_HOME: fixture.home,
      JOBTRACK_DB: path.join(fixture.home, 'jobtrack.db'),
      TMPDIR: fixture.tmp,
      HOST: '127.0.0.1',
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  fixture.server = { child, baseUrl, stderr: () => stderr };
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(250) });
      if (response.status === 200) return { child, baseUrl, stderr: () => stderr };
    } catch { /* listener not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start: ${stderr}`);
}

async function stopServer(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  const exited = once(instance.child, 'exit');
  instance.child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`server did not exit: ${instance.stderr()}`)),
      3000
    ))
  ]);
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

function assertPrivateHeaders(headers) {
  assert.match(headers.get('cache-control') || '', /no-store/);
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.match(headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
