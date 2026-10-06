'use strict';

// The fabric read model (docs/FABRIC_PLAN.md, Phase A): gate configuration
// lanes with their fail-closed invariants, and the derivation walked across a
// real store — opportunity ingest through recorded submission — asserting at
// every stage that `fabric next` names exactly the right next act.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  FABRIC_NODES,
  FabricError,
  deriveFabricNext,
  listGateConfiguration,
  resolveGateBehavior,
  setGateOverride,
  setGatePolicy,
  _test: { deriveSubmissionLane, nextFabricAttemptIdentity }
} = require('../lib/fabric');
const { assertFabricCommandFlags, runFabricCommand } = require('../lib/fabric-command');
const {
  acceptApplicationFormUncertainty,
  getApplicationReadiness,
  migrateApplicationMaterials,
  reviewMaterialRevision,
  selectMaterialRevision
} = require('../lib/application-materials');
const { draft, finishMaterial, recordFailingLint, recordPassingLint, syntheticRender } = require('../test-support/fabric-fixtures');
const { migrateApplicationForm } = require('../lib/application-form');
const { runOpportunityCommand } = require('../lib/opportunities');
const { runApplicationSubmissionCommand } = require('../lib/application-submission-command');
const {
  approveSubmission,
  claimSubmissionAttempt,
  proposeSubmission,
  settleSubmissionAttempt
} = require('../lib/application-submission');
const { runApplicationMaterialsCommand } = require('../lib/application-materials-command');
const { listExpectedUploads, verifyApplicationUploads } = require('../lib/upload-verification');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

function createStore(t) {
  const { root: rootDir, home } = require('../test-support/migrated-store').createTestStore('jobtrack-fabric-');
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  migrateApplicationForm(db);
  migrateApplicationMaterials(db);
  const fixture = { root: rootDir, home, db };
  t.after(() => { if (db.open) db.close(); fs.rmSync(rootDir, { recursive: true, force: true }); });
  return fixture;
}

function runCli(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }));
}

/** `node:status` list for one subject in a derivation result. */
function nodesOf(result, subjectKind, subjectId) {
  const subject = result.subjects.find(
    (row) => row.subjectKind === subjectKind && row.subjectId === subjectId
  );
  return (subject?.items ?? []).map((item) => `${item.node}:${item.status}`).sort();
}

function itemOf(result, subjectId, nodeId) {
  const subject = result.subjects.find((row) => row.subjectId === subjectId && row.subjectKind === 'application');
  return subject?.items.find((item) => item.node === nodeId) ?? null;
}

test('fabric attempt identities advance across all append-only approval history', () => {
  assert.deepEqual(nextFabricAttemptIdentity(7, []), {
    attemptId: 'fabric-attempt-7-v1',
    attemptVersion: 1,
    idempotencyKey: 'fabric-application.apply-7-v1'
  });
  assert.equal(nextFabricAttemptIdentity(7, [
    { attempt_id: 'fabric-attempt-7-v1', approval_id: 'older-approval' },
    { attempt_id: 'manual-recovery-attempt', approval_id: 'current-approval' }
  ]).attemptId, 'fabric-attempt-7-v2', 'an older approval still owns the application-scoped v1 id');
  assert.equal(nextFabricAttemptIdentity(7, [
    { attempt_id: 'fabric-attempt-7-v1' },
    { attempt_id: 'fabric-attempt-7-v2' }
  ]).attemptId, 'fabric-attempt-7-v3', 'two definitive failures advance to v3');
  assert.equal(nextFabricAttemptIdentity(7, [
    { attempt_id: 'fabric-attempt-7-v1' },
    { attempt_id: 'fabric-attempt-7-v3' }
  ]).attemptId, 'fabric-attempt-7-v4', 'generated identities are monotonic even if older history has a gap');
});

test('fabric derives only a blocked reconcile item for unsettled and indeterminate attempts', (t) => {
  const fixture = createStore(t);
  const applicationId = Number(fixture.db.prepare(`
    INSERT INTO applications(company,role,status,workflow_stage,job_url)
    VALUES ('Drove','Product Engineer','applied','package_ready','https://careers.example.test/apply')
  `).run().lastInsertRowid);
  const proposed = proposeSubmission(fixture.db, {
    intentId: 'reconcile-intent', applicationId,
    surfaceId: 'https://careers.example.test/apply',
    answers: { name: 'Cole' }, documents: { resume: 'a'.repeat(64) }
  }, { now: () => '2026-08-06T12:00:00.000Z' });
  approveSubmission(fixture.db, {
    intentId: 'reconcile-intent', expectedIntentDigest: proposed.intentDigest,
    approvalId: 'reconcile-approval', approver: { kind: 'human', id: 'Cole' }
  }, { home: fixture.home, now: () => '2026-08-06T12:01:00.000Z' });
  claimSubmissionAttempt(fixture.db, {
    approvalId: 'reconcile-approval', attemptId: `fabric-attempt-${applicationId}-v1`
  }, { home: fixture.home, now: () => '2026-08-06T12:02:00.000Z' });

  const derive = () => {
    const subject = { packageId: 99, items: [] };
    deriveSubmissionLane(fixture.db, { id: applicationId }, subject);
    assert.equal(subject.items.length, 1);
    assert.equal(subject.items[0].node, 'application.apply');
    assert.equal(subject.items[0].status, 'blocked');
    assert.match(subject.items[0].reason, /unreconciled/);
    assert.match(subject.items[0].commands[0], new RegExp(`--attempt-id fabric-attempt-${applicationId}-v1`));
    assert.doesNotMatch(subject.items[0].commands[0], /claim/u);
  };

  derive();
  settleSubmissionAttempt(fixture.db, {
    attemptId: `fabric-attempt-${applicationId}-v1`, outcome: 'indeterminate'
  }, { now: () => '2026-08-06T12:03:00.000Z' });
  derive();
});

// ---------------------------------------------------------------------------
// gate configuration
// ---------------------------------------------------------------------------

test('gate configuration: fail-closed defaults, allowed modes, expected-current, precedence', (t) => {
  const fixture = createStore(t);
  const db = fixture.db;

  const gates = listGateConfiguration(db);
  for (const gate of gates) {
    assert.equal(gate.resolved.source, 'default');
    assert.equal(gate.resolved.mode, gate.gateId === 'application.apply' ? 'manual' : 'human');
  }
  assert.equal(gates.filter((gate) => gate.outward).map((gate) => gate.gateId).join(','), 'application.submission.approve');

  assert.throws(() => setGatePolicy(db, { gateId: 'application.package', mode: 'policy', setBy: 'x', setAuthorship: 'agent', expectedCurrentRevisionId: 'none' }),
    (error) => error.code === 'NOT_CONFIGURABLE');
  assert.throws(() => setGatePolicy(db, { gateId: 'nope', mode: 'human', setBy: 'x', setAuthorship: 'agent', expectedCurrentRevisionId: 'none' }),
    (error) => error.code === 'UNKNOWN_GATE');
  assert.throws(() => setGatePolicy(db, { gateId: 'application.materials.review', mode: 'agent', setBy: 'x', setAuthorship: 'agent', expectedCurrentRevisionId: 'none' }),
    (error) => error.code === 'INVALID_MODE', 'agent is an executor mode, not a gate mode');
  assert.throws(() => setGatePolicy(db, { gateId: 'application.apply', mode: 'policy', setBy: 'x', setAuthorship: 'agent', expectedCurrentRevisionId: 'none' }),
    (error) => error.code === 'INVALID_MODE', 'policy is a gate mode, not an executor mode');

  const first = setGatePolicy(db, {
    gateId: 'application.materials.review', mode: 'policy',
    rules: '{"requireLintPass":true}', setBy: 'drill-setup', setAuthorship: 'agent',
    expectedCurrentRevisionId: 'none'
  });
  assert.equal(first.revision.mode, 'policy');
  assert.throws(() => setGatePolicy(db, {
    gateId: 'application.materials.review', mode: 'human', setBy: 'x', setAuthorship: 'human',
    expectedCurrentRevisionId: 'none'
  }), (error) => error.code === 'STALE_GATE_REVISION');

  // Precedence: subject override beats the revision; clearing restores it.
  const application = db.prepare("INSERT INTO applications(company,role,status,workflow_stage) VALUES ('P','R','applied','prospective')").run();
  const subjectId = Number(application.lastInsertRowid);
  setGateOverride(db, {
    gateId: 'application.materials.review', subjectId, mode: 'withhold',
    reason: 'hold this one', setBy: 'Cole', setAuthorship: 'human'
  });
  assert.equal(resolveGateBehavior(db, 'application.materials.review', { id: subjectId }).mode, 'withhold');
  assert.equal(resolveGateBehavior(db, 'application.materials.review', { id: subjectId + 1 }).mode, 'policy', 'other subjects keep the revision');
  setGateOverride(db, {
    gateId: 'application.materials.review', subjectId, clear: true,
    reason: 'release', setBy: 'Cole', setAuthorship: 'human'
  });
  assert.equal(resolveGateBehavior(db, 'application.materials.review', { id: subjectId }).mode, 'policy');

  // Append-only: revisions and overrides refuse UPDATE/DELETE.
  assert.throws(() => db.prepare('DELETE FROM fabric_gate_policy_revisions').run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE fabric_gate_overrides SET mode='human'").run(), /append-only/);
});

test('the outward gate refuses automated behavior an agent configured, or any without constraints', (t) => {
  const fixture = createStore(t);
  const db = fixture.db;

  assert.throws(() => setGatePolicy(db, {
    gateId: 'application.submission.approve', mode: 'policy',
    setBy: 'worker', setAuthorship: 'agent', expectedCurrentRevisionId: 'none',
    constraints: '{"surfaceAllowlist":["http://127.0.0.1"]}'
  }), (error) => error.code === 'OUTWARD_POLICY_REQUIRES_HUMAN');

  assert.throws(() => setGatePolicy(db, {
    gateId: 'application.submission.approve', mode: 'policy',
    setBy: 'Cole', setAuthorship: 'human', expectedCurrentRevisionId: 'none'
  }), (error) => error.code === 'OUTWARD_POLICY_REQUIRES_CONSTRAINTS');

  const ok = setGatePolicy(db, {
    gateId: 'application.submission.approve', mode: 'policy',
    constraints: '{"surfaceAllowlist":["http://127.0.0.1"],"expiresAt":"2026-08-21T00:00:00Z"}',
    setBy: 'Cole', setAuthorship: 'human', expectedCurrentRevisionId: 'none'
  });
  assert.equal(ok.revision.set_authorship, 'human');
  const resolved = resolveGateBehavior(db, 'application.submission.approve');
  assert.equal(resolved.mode, 'policy');
  assert.equal(resolved.revisionId, ok.revision.id, 'the decision cites the revision that allows it');

  // Per-subject overrides can NARROW an outward gate but never open it.
  const application = db.prepare("INSERT INTO applications(company,role,status,workflow_stage) VALUES ('P','R','applied','prospective')").run();
  const subjectId = Number(application.lastInsertRowid);
  assert.throws(() => setGateOverride(db, {
    gateId: 'application.submission.approve', subjectId, mode: 'policy',
    constraints: '{"surfaceAllowlist":["http://127.0.0.1"]}',
    reason: 'try to open per-subject', setBy: 'Cole', setAuthorship: 'human'
  }), (error) => error.code === 'OUTWARD_POLICY_REQUIRES_REVISION');
  assert.throws(() => setGateOverride(db, {
    gateId: 'application.submission.approve', subjectId, mode: 'policy',
    reason: 'agent attempt', setBy: 'worker', setAuthorship: 'agent'
  }), (error) => error.code === 'OUTWARD_POLICY_REQUIRES_HUMAN');
  const hold = setGateOverride(db, {
    gateId: 'application.submission.approve', subjectId, mode: 'withhold',
    reason: 'T10: authorization withheld', setBy: 'Cole', setAuthorship: 'human'
  });
  assert.equal(hold.override.mode, 'withhold');
});

test('fabric command flags are schema-checked and unknown actions are named', (t) => {
  const fixture = createStore(t);
  assert.throws(() => assertFabricCommandFlags(['next'], { gateId: 'x' }),
    (error) => error instanceof FabricError && error.code === 'INVALID_ARGUMENT');
  assert.throws(() => assertFabricCommandFlags(['transmit'], {}),
    (error) => error.code === 'UNKNOWN_COMMAND');
  assert.throws(() => assertFabricCommandFlags(['gates', 'open'], {}),
    (error) => error.code === 'UNKNOWN_COMMAND');
  const listed = runFabricCommand(fixture.db, ['gates'], {});
  assert.equal(listed.gates.length, FABRIC_NODES.filter((node) => node.configurable).length);
});

// ---------------------------------------------------------------------------
// the golden walk
// ---------------------------------------------------------------------------

test('the derivation names the correct next act at every stage, ingest through recorded submission', (t) => {
  const fixture = createStore(t);
  const db = fixture.db;
  const services = { home: fixture.home };
  // In-process package-integrity checks resolve managed attachments through
  // JOBTRACK_HOME, exactly as the CLI process does.
  const previousHome = process.env.JOBTRACK_HOME;
  process.env.JOBTRACK_HOME = fixture.home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.JOBTRACK_HOME;
    else process.env.JOBTRACK_HOME = previousHome;
  });

  // Mocked discovery front: the same verb the discovery agent performs.
  const ingested = runOpportunityCommand(db, ['opportunity', 'ingest'], {
    source: 'manual', company: 'Loomworks', role: 'Fabric Engineer',
    url: 'https://careers.loomworks.test/jobs/7',
    description: 'Weave the reconciler. Requirements: Go, SQLite, patience.',
    observedAt: '2026-08-20T00:00:00Z', parserName: 'manual-web-result', parserVersion: '1',
    idempotencyKey: 'fabric-walk-ingest-v1'
  });
  const opportunityId = ingested.opportunity.id;

  let next = deriveFabricNext(db);
  assert.deepEqual(nodesOf(next, 'opportunity', opportunityId), ['opportunity.triage:eligible']);

  runOpportunityCommand(db, ['opportunity', 'triage'], {
    opportunityId, decision: 'shortlist', rationale: 'Strong platform fit',
    score: '0.8', coverage: '0.9', scorerKind: 'agent', scorerId: 'triage-worker'
  });
  next = deriveFabricNext(db);
  assert.deepEqual(nodesOf(next, 'opportunity', opportunityId), ['opportunity.pursue:parked'], 'pursue is a human gate by default');

  setGatePolicy(db, {
    gateId: 'opportunity.pursue', mode: 'policy', rules: '{"minScore":0.6}',
    setBy: 'drill-setup', setAuthorship: 'agent', expectedCurrentRevisionId: 'none'
  });
  next = deriveFabricNext(db);
  assert.deepEqual(nodesOf(next, 'opportunity', opportunityId), ['opportunity.pursue:eligible']);
  assert.equal(next.subjects[0].items[0].mode, 'policy');

  const promoted = runOpportunityCommand(db, ['opportunity', 'promote'], { opportunityId });
  const applicationId = promoted.application.id;

  // Promote attached the posting artifact itself; research is next.
  next = deriveFabricNext(db);
  assert.equal(next.subjects.some((subject) => subject.subjectKind === 'opportunity'), false, 'promoted opportunities leave the derivation');
  assert.deepEqual(nodesOf(next, 'application', applicationId), ['application.research:eligible']);

  db.prepare(`
    INSERT INTO application_artifacts(application_id,kind,title,source_url,citation,notes)
    VALUES (?,?,?,?,?,?)
  `).run(applicationId, 'research', 'Loomworks research', 'https://loomworks.test/about', 'About page', 'Build tools company');
  next = deriveFabricNext(db);
  assert.deepEqual(nodesOf(next, 'application', applicationId), ['application.assess:eligible']);

  runCli(fixture.home, [
    'assess-application', '--application-id', String(applicationId),
    '--company-assessment', 'Healthy platform company', '--role-fit', 'Strong',
    '--risks', 'None material', '--evidence', 'Posting + research artifacts',
    '--open-questions', 'Team size', '--approach', 'Tailored resume, direct apply'
  ]);
  next = deriveFabricNext(db);
  assert.deepEqual(nodesOf(next, 'application', applicationId), ['application.assessment-review:parked']);

  runCli(fixture.home, [
    'review-assessment', '--application-id', String(applicationId),
    '--decision', 'approved', '--decided-by', 'Cole', '--notes', 'Proceed'
  ]);

  // Assessment approved. The CLI acts above already backfilled the managed
  // preparation plan (migrations classify existing applications), so the
  // readiness view is live: two baseline drafts plus the form-coverage pair.
  next = deriveFabricNext(db);
  let nodes = nodesOf(next, 'application', applicationId);
  assert.deepEqual(nodes, [
    'application.form-recon:eligible',
    'application.materials.draft:eligible',
    'application.materials.draft:eligible',
    'application.uncertainty-accept:parked'
  ]);

  const artifactId = db.prepare("SELECT id FROM application_artifacts WHERE application_id=? AND kind='posting'").get(applicationId).id;
  const profileEntryId = Number(db.prepare(`
    INSERT INTO profile_entries(category,title,content,source,confidence,tags)
    VALUES ('work','Loom evidence','Built looms','test','high','[]')
  `).run().lastInsertRowid);

  const resumeRough = draft(db, applicationId, 'resume', 'resume rough', null, artifactId, profileEntryId, 'walk:resume:rough');
  next = deriveFabricNext(db);
  nodes = nodesOf(next, 'application', applicationId);
  assert.ok(nodes.includes('application.form-recon:eligible'), 'plan exists now: uncertain form coverage surfaces recon');
  assert.ok(nodes.includes('application.uncertainty-accept:parked'));
  assert.ok(nodes.includes('application.materials.draft:eligible'), 'cover letter still needs drafting');
  const resumeDraftItem = next.subjects.find((s) => s.subjectId === applicationId).items
    .find((item) => item.node === 'application.materials.draft' && item.instance === 'resume');
  assert.match(resumeDraftItem.reason, /rough-draft — refine to final-candidate/);

  // Accepting uncertainty is an explicit gate act with the pinned form sha.
  const formSha = getApplicationReadiness(db, applicationId).form.stateSha256;
  acceptApplicationFormUncertainty(db, {
    applicationId, acceptedBy: 'Cole',
    reason: 'No public form; will review at submission time.',
    expectedFormStateSha256: formSha, idempotencyKey: 'walk:uncertainty'
  });
  next = deriveFabricNext(db);
  nodes = nodesOf(next, 'application', applicationId);
  assert.equal(nodes.includes('application.form-recon:eligible'), false, 'acceptance clears the form work');
  assert.equal(nodes.includes('application.uncertainty-accept:parked'), false);

  const resumeFinalFirst = draft(db, applicationId, 'resume', 'resume final', resumeRough.revision.id, artifactId, profileEntryId, 'walk:resume:final', 'final-candidate');
  next = deriveFabricNext(db);
  assert.ok(nodesOf(next, 'application', applicationId).includes('application.materials.render-lint:eligible'));
  assert.match(itemOf(next, applicationId, 'application.materials.render-lint').reason, /no render/);

  // A two-page render fails the one-page policy: the fabric hands the draft
  // back for revision AND names the finding on the item (2026-09-02 — workers
  // told only "1 error(s)" revised blind until the drill stalled).
  const twoPageRender = syntheticRender(db, resumeFinalFirst.revision, { pageCount: 2 });
  next = deriveFabricNext(db);
  assert.match(itemOf(next, applicationId, 'application.materials.render-lint').reason, /lint is missing/);
  recordFailingLint(db, applicationId, twoPageRender.id, 'PAGE_COUNT_EXCEEDS_POLICY');
  next = deriveFabricNext(db);
  const reviseItem = next.subjects.find((s) => s.subjectId === applicationId).items
    .find((item) => item.node === 'application.materials.draft' && item.instance === 'resume');
  assert.match(reviseItem.reason, /failed lint \(1 error\(s\)\)/);
  assert.match(reviseItem.reason, /Findings: PAGE_COUNT_EXCEEDS_POLICY: Rendered PDF has 2 pages/);
  assert.equal(reviseItem.act.renderId, twoPageRender.id);
  assert.equal(reviseItem.act.lintFindings[0].code, 'PAGE_COUNT_EXCEEDS_POLICY');
  assert.equal(reviseItem.act.lintFindings[0].severity, 'error');
  assert.ok(typeof reviseItem.act.lintFindings[0].message === 'string' && reviseItem.act.lintFindings[0].message.length > 0, 'the finding carries its message');
  assert.ok(!('evidence' in reviseItem.act.lintFindings[0]) || typeof reviseItem.act.lintFindings[0].evidence === 'string', 'evidence is optional but bounded text when present');

  // The worker revises on the head (a second rough-draft is refused), then a
  // fresh final-candidate renders to one page and lints clean.
  const resumeRevised = draft(db, applicationId, 'resume', 'resume revised shorter', resumeFinalFirst.revision.id, artifactId, profileEntryId, 'walk:resume:revised', 'revised');
  const resumeFinal = draft(db, applicationId, 'resume', 'resume final shorter', resumeRevised.revision.id, artifactId, profileEntryId, 'walk:resume:final-2', 'final-candidate');
  const resumeRender = syntheticRender(db, resumeFinal.revision);
  next = deriveFabricNext(db);
  assert.match(itemOf(next, applicationId, 'application.materials.render-lint').reason, /lint is missing/);
  recordPassingLint(db, applicationId, resumeRender.id);
  next = deriveFabricNext(db);
  const reviewItem = itemOf(next, applicationId, 'application.materials.review');
  assert.equal(reviewItem.status, 'parked', 'materials review is a human gate by default');
  assert.match(reviewItem.reason, /lint pass/);

  reviewMaterialRevision(db, {
    applicationId, revisionId: resumeFinal.revision.id, renderId: resumeRender.id,
    decision: 'approved', reviewedBy: 'Cole', expectedReviewId: null, idempotencyKey: 'walk:resume:review'
  });
  next = deriveFabricNext(db);
  assert.equal(itemOf(next, applicationId, 'application.materials.select').status, 'parked');

  selectMaterialRevision(db, {
    applicationId, revisionId: resumeFinal.revision.id, selectedBy: 'Cole',
    expectedSelectedRevisionId: null, idempotencyKey: 'walk:resume:select'
  });
  finishMaterial(db, applicationId, 'cover-letter', artifactId, profileEntryId, 'walk:letter');

  // Both materials selected + uncertainty accepted => readiness green => package.
  next = deriveFabricNext(db);
  const packageItem = itemOf(next, applicationId, 'application.package');
  assert.equal(packageItem.status, 'eligible');
  assert.match(packageItem.commands[0], /--expected-readiness-sha256 [0-9a-f]{64}/, 'the act carries the real readiness sha');

  const readinessSha = getApplicationReadiness(db, applicationId).readinessSha256;
  runCli(fixture.home, [
    'build-package', '--application-id', String(applicationId),
    '--expected-readiness-sha256', readinessSha,
    '--idempotency-key', 'walk:package', '--checklist', 'Cole reviews final answers'
  ]);
  next = deriveFabricNext(db);
  const proposeItem = itemOf(next, applicationId, 'application.submission.propose');
  assert.equal(proposeItem.status, 'eligible');

  const packageId = next.subjects.find((subject) => subject.subjectId === applicationId).packageId;
  runApplicationSubmissionCommand(db, ['propose'], {
    applicationId, packageId, expectedReadinessSha256: readinessSha,
    surfaceId: 'https://careers.loomworks.test/apply/7', intentId: 'walk-intent'
  }, services);
  next = deriveFabricNext(db);
  const approveItem = itemOf(next, applicationId, 'application.submission.approve');
  assert.equal(approveItem.status, 'parked', 'the outward gate parks by default');
  assert.match(approveItem.commands[0], /--expected-intent-digest [0-9a-f]{64}/);

  setGatePolicy(db, {
    gateId: 'application.submission.approve', mode: 'policy',
    constraints: '{"surfaceAllowlist":["https://careers.loomworks.test"],"expiresAt":"2027-01-01T00:00:00Z"}',
    setBy: 'Cole', setAuthorship: 'human', expectedCurrentRevisionId: 'none'
  });
  next = deriveFabricNext(db);
  assert.equal(itemOf(next, applicationId, 'application.submission.approve').status, 'eligible');

  const intentDigest = db.prepare('SELECT intent_digest FROM application_submission_intents WHERE intent_id=?').get('walk-intent').intent_digest;
  runApplicationSubmissionCommand(db, ['approve'], {
    intentId: 'walk-intent', expectedIntentDigest: intentDigest,
    approverKind: 'policy', approverId: 'policy:fabric/application.submission.approve@rev1',
    approvalId: 'walk-approval'
  }, services);

  next = deriveFabricNext(db);
  let applyItem = itemOf(next, applicationId, 'application.apply');
  assert.equal(applyItem.status, 'parked');
  assert.equal(applyItem.executor, 'manual', 'the apply executor defaults to manual');

  setGateOverride(db, {
    gateId: 'application.apply', subjectId: applicationId, mode: 'agent',
    reason: 'drill: the worker drives the loopback surface', setBy: 'drill-setup', setAuthorship: 'agent'
  });
  next = deriveFabricNext(db);
  applyItem = itemOf(next, applicationId, 'application.apply');
  assert.equal(applyItem.status, 'eligible');
  assert.equal(applyItem.executor, 'agent');
  assert.equal(applyItem.act.attemptId, `fabric-attempt-${applicationId}-v1`);
  assert.match(applyItem.commands[0], new RegExp(`--attempt-id fabric-attempt-${applicationId}-v1`));

  // A definitive pre-submit failure keeps its append-only evidence but frees
  // the approval. Fabric must advance both attempt identity and dispatcher
  // idempotency, rather than replaying the settled v1 attempt forever.
  runApplicationSubmissionCommand(db, ['claim'], {
    approvalId: 'walk-approval', attemptId: applyItem.act.attemptId
  }, services);
  runApplicationSubmissionCommand(db, ['settle'], {
    attemptId: applyItem.act.attemptId, outcome: 'failed', externalReference: 'session null: surface unavailable'
  }, services);
  next = deriveFabricNext(db);
  applyItem = itemOf(next, applicationId, 'application.apply');
  assert.equal(applyItem.status, 'eligible');
  assert.equal(applyItem.act.attemptId, `fabric-attempt-${applicationId}-v2`);
  assert.equal(applyItem.idempotencyKey, `fabric-application.apply-${applicationId}-v2`);
  assert.match(applyItem.commands[0], new RegExp(`--attempt-id fabric-attempt-${applicationId}-v2`));
  assert.match(applyItem.commands[1], new RegExp(`--attempt-id fabric-attempt-${applicationId}-v2`));

  runApplicationSubmissionCommand(db, ['claim'], {
    approvalId: 'walk-approval', attemptId: applyItem.act.attemptId
  }, services);
  runApplicationSubmissionCommand(db, ['settle'], {
    attemptId: applyItem.act.attemptId, outcome: 'accepted', externalReference: 'confirmation #LOOM-7'
  }, services);
  next = deriveFabricNext(db);
  const verifyItem = itemOf(next, applicationId, 'application.verify-record');
  assert.equal(verifyItem.status, 'eligible');
  assert.match(verifyItem.commands[1], new RegExp(`--attempt-id fabric-attempt-${applicationId}-v2`));

  const files = {};
  for (const upload of listExpectedUploads(db, applicationId)) {
    files[upload.materialKind] = path.resolve(path.dirname(db.name), upload.attachmentPath);
  }
  verifyApplicationUploads(db, { applicationId, files, verifiedBy: 'test-harness', idempotencyKey: 'walk:verify' });
  runApplicationMaterialsCommand(db, ['record-submission'], {
    applicationId: String(applicationId), packageId: String(packageId),
    submittedBy: 'apply-worker', expectedReadinessSha256: readinessSha,
    attemptId: `fabric-attempt-${applicationId}-v2`, idempotencyKey: 'walk:record'
  });

  next = deriveFabricNext(db);
  assert.deepEqual(nodesOf(next, 'application', applicationId), ['application.watch:standing']);
  assert.equal(next.summary.parked, 0);

  // The parked filter is the operator queue: nothing parked at the end.
  const parked = runFabricCommand(db, ['next'], { parked: 'true' });
  assert.equal(parked.subjects.filter((subject) => subject.items.length > 0).length, 0);
});

test('non-managed applications are excluded with a note, and a sick subject never kills the derivation', (t) => {
  const fixture = createStore(t);
  const db = fixture.db;
  const legacyId = Number(db.prepare(`
    INSERT INTO applications(company,role,status,workflow_stage) VALUES ('Old Co','Engineer','applied','submitted')
  `).run().lastInsertRowid);
  migrateApplicationMaterials(db); // classifies the submitted application as legacy-import

  const next = deriveFabricNext(db, { applicationId: legacyId });
  const subject = next.subjects.find((row) => row.subjectId === legacyId);
  assert.match(subject.note, /legacy-import/);
  assert.equal(subject.items.length, 0);
});

test('a posting observed again after its triage is re-triaged, not judged on stale evidence', (t) => {
  const fixture = createStore(t);
  const db = fixture.db;
  {
    const ingested = runOpportunityCommand(db, ['opportunity', 'ingest'], {
      source: 'manual', company: 'Drove', role: 'Platform Engineer',
      url: 'https://applysim.example.test/sites/drove/flow',
      description: 'thin', observedAt: '2026-09-02T02:55:00Z', parserName: 'manual-web-result', parserVersion: '1',
      idempotencyKey: 'retriage-ingest-1'
    });
    const opportunityId = ingested.opportunity.id;
    runOpportunityCommand(db, ['opportunity', 'triage'], {
      opportunityId, decision: 'watch', rationale: 'title conflicts with the page', score: '0.48', coverage: '0.2', scorerKind: 'agent', scorerId: 'triage-worker'
    });
    let next = deriveFabricNext(db);
    assert.ok(nodesOf(next, 'opportunity', opportunityId).some((n) => n.startsWith('opportunity.pursue:')), 'triaged: the pursue gate judges it');
    // The operator corrects the record (same URL → same opportunity, observed again, new
    // title). Triage rows are append-only, so the observation is what moves forward in time.
    const observedAgainAt = new Date(Date.now() + 1500).toISOString();
    runOpportunityCommand(db, ['opportunity', 'ingest'], {
      source: 'manual', company: 'Drove', role: 'Staff Software Engineer',
      url: 'https://applysim.example.test/sites/drove/flow',
      description: 'the page text', observedAt: observedAgainAt, parserName: 'manual-web-result', parserVersion: '1',
      idempotencyKey: 'retriage-ingest-2'
    });
    next = deriveFabricNext(db);
    const opportunityItem = (nodeId) => next.subjects.find((row) => row.subjectKind === 'opportunity' && row.subjectId === opportunityId)?.items.find((i) => i.node === nodeId) ?? null;
    const item = opportunityItem('opportunity.triage');
    assert.ok(item, 'a fresh triage is asked for');
    assert.match(item.reason, /observed again .* re-triage on the current posting/);
    assert.match(item.reason, /Staff Software Engineer/);
    assert.match(item.idempotencyKey, /^fabric-opportunity\.triage-\d+-seen-\d{14}$/, 'a distinct key per observation, so a re-dispatch never collides');
    // A new triage (recorded after the observation) settles it again.
    execFileSync('sleep', ['1.6']);
    runOpportunityCommand(db, ['opportunity', 'triage'], {
      opportunityId, decision: 'shortlist', rationale: 'strong fit on the corrected posting', score: '0.9', coverage: '0.9', scorerKind: 'agent', scorerId: 'triage-worker'
    });
    next = deriveFabricNext(db);
    assert.ok(!next.subjects.find((row) => row.subjectKind === 'opportunity' && row.subjectId === opportunityId)?.items.some((i) => i.node === 'opportunity.triage'), 'no re-triage once the triage is newer than the observation');
    assert.ok(nodesOf(next, 'opportunity', opportunityId).some((n) => n.startsWith('opportunity.pursue:')));
  }
});
