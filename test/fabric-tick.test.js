'use strict';

// Phase B: `fabric tick` executes what deterministic code may execute and
// fires policy gates whose rules hold — everything else is classified, never
// touched. The exit criterion test advances a prepared application from
// drafted final-candidates to a proposed, approved, recorded submission BY
// policy ticks after the required independent/manual resume gate, with every
// act attributed to an auditable actor.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { runFabricTick, setGateOverride, setGatePolicy } = require('../lib/fabric');
const { migrateApplicationMaterials } = require('../lib/application-materials');
const { migrateApplicationForm } = require('../lib/application-form');
const { runOpportunityCommand } = require('../lib/opportunities');
const { runApplicationSubmissionCommand } = require('../lib/application-submission-command');
const { listExpectedUploads, verifyApplicationUploads } = require('../lib/upload-verification');
const { finalCandidateWithRender } = require('../test-support/fabric-fixtures');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

function createStore(t) {
  const { root: rootDir, home } = require('../test-support/migrated-store').createTestStore('jobtrack-fabric-tick-');
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  migrateApplicationForm(db);
  migrateApplicationMaterials(db);
  const previousHome = process.env.JOBTRACK_HOME;
  process.env.JOBTRACK_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.JOBTRACK_HOME;
    else process.env.JOBTRACK_HOME = previousHome;
    if (db.open) db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  return { root: rootDir, home, db };
}

function runCli(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }));
}

/** Real executors for in-process ticks: build-package and review-assessment
 * live in bin, so the test's services run them through spawned CLI calls —
 * the same code path production uses, just across a process boundary. */
function cliBackedServices(home) {
  return {
    home,
    buildPackage: (db, input) => runCli(home, [
      'build-package', '--application-id', String(input.applicationId),
      '--expected-readiness-sha256', input.expectedReadinessSha256,
      '--idempotency-key', input.idempotencyKey, '--checklist', input.checklist
    ]),
    reviewAssessment: (db, input) => runCli(home, [
      'review-assessment', '--application-id', String(input.applicationId),
      '--decision', input.decision, '--decided-by', input.decidedBy, '--notes', input.notes
    ])
  };
}

function ingestTriaged(db, { company, role, url, score = '0.8', coverage = '0.9' }) {
  const ingested = runOpportunityCommand(db, ['opportunity', 'ingest'], {
    source: 'manual', company, role, url,
    description: `${role} at ${company}. Requirements: systems, judgment.`,
    observedAt: '2026-08-20T00:00:00Z', parserName: 'manual-web-result', parserVersion: '1',
    idempotencyKey: `tick-ingest-${company}`
  });
  runOpportunityCommand(db, ['opportunity', 'triage'], {
    opportunityId: ingested.opportunity.id, decision: 'shortlist', rationale: 'Fits',
    score, coverage, scorerKind: 'agent', scorerId: 'triage-worker'
  });
  return ingested.opportunity.id;
}

const performedNodes = (tick) => tick.performed.map((entry) => entry.node).sort();

test('ticks preserve the manual legacy-resume boundary then advance reviewed materials, every act attributed', (t) => {
  const fixture = createStore(t);
  const db = fixture.db;
  const services = cliBackedServices(fixture.home);

  const opportunityId = ingestTriaged(db, {
    company: 'Loomworks', role: 'Fabric Engineer', url: 'https://careers.loomworks.test/jobs/7'
  });
  setGatePolicy(db, {
    gateId: 'opportunity.pursue', mode: 'policy', rules: '{"minScore":0.6}',
    setBy: 'drill-setup', setAuthorship: 'agent', expectedCurrentRevisionId: 'none'
  });

  let tick = runFabricTick(db, {}, services);
  assert.deepEqual(performedNodes(tick), ['opportunity.pursue']);
  assert.equal(tick.performed[0].actor, 'policy:fabric/opportunity.pursue@rev1');
  const applicationId = db.prepare('SELECT id FROM applications ORDER BY id DESC LIMIT 1').get().id;

  // Agent work stays agent work: the tick reports it dispatchable, untouched.
  tick = runFabricTick(db, {}, services);
  assert.deepEqual(performedNodes(tick), []);
  assert.deepEqual(tick.dispatchable.map((entry) => entry.node), ['application.research']);

  db.prepare(`
    INSERT INTO application_artifacts(application_id,kind,title,source_url,citation,notes)
    VALUES (?,?,?,?,?,?)
  `).run(applicationId, 'research', 'Loomworks research', 'https://loomworks.test/about', 'About page', 'Tools company');
  runCli(fixture.home, [
    'assess-application', '--application-id', String(applicationId),
    '--company-assessment', 'Healthy', '--role-fit', 'Strong', '--risks', 'None material',
    '--evidence', 'Posting + research', '--open-questions', 'Team size', '--approach', 'Direct'
  ]);
  setGatePolicy(db, {
    gateId: 'application.assessment-review', mode: 'policy',
    setBy: 'drill-setup', setAuthorship: 'agent', expectedCurrentRevisionId: 'none'
  });
  tick = runFabricTick(db, {}, services);
  assert.deepEqual(performedNodes(tick), ['application.assessment-review']);
  assert.match(tick.performed[0].actor, /^policy:fabric\/application\.assessment-review@rev/);

  // Prepared materials: final-candidates rendered and lint-passed by fixture;
  // the gates that remain are exactly what policy mode should clear.
  const artifactId = db.prepare("SELECT id FROM application_artifacts WHERE application_id=? AND kind='posting'").get(applicationId).id;
  const profileEntryId = Number(db.prepare(`
    INSERT INTO profile_entries(category,title,content,source,confidence,tags)
    VALUES ('work','Loom evidence','Built looms','test','high','[]')
  `).run().lastInsertRowid);
  const resume = finalCandidateWithRender(db, applicationId, 'resume', artifactId, profileEntryId, 'tick:resume');
  finalCandidateWithRender(db, applicationId, 'cover-letter', artifactId, profileEntryId, 'tick:letter');
  for (const gateId of ['application.uncertainty-accept', 'application.materials.review', 'application.materials.select']) {
    setGatePolicy(db, {
      gateId, mode: 'policy',
      setBy: 'drill-setup', setAuthorship: 'agent', expectedCurrentRevisionId: 'none'
    });
  }

  // A strict maxWarnCount holds the reviews when the lint pass carried warns;
  // fail-closed means the rule refuses rather than approving anyway.
  const strictReview = setGatePolicy(db, {
    gateId: 'application.materials.review', mode: 'policy', rules: '{"maxWarnCount":-1}',
    setBy: 'drill-setup', setAuthorship: 'agent',
    expectedCurrentRevisionId: String(db.prepare(
      "SELECT id FROM fabric_gate_policy_revisions WHERE gate_id='application.materials.review' ORDER BY id DESC LIMIT 1"
    ).get().id)
  });
  tick = runFabricTick(db, {}, services);
  assert.deepEqual(performedNodes(tick), ['application.uncertainty-accept']);
  assert.equal(tick.held.filter((entry) => entry.node === 'application.materials.review').length, 2);

  setGatePolicy(db, {
    gateId: 'application.materials.review', mode: 'policy',
    setBy: 'drill-setup', setAuthorship: 'agent', expectedCurrentRevisionId: String(strictReview.revision.id)
  });
  tick = runFabricTick(db, {}, services);
  assert.deepEqual(performedNodes(tick), ['application.materials.review'], 'only the cover letter can be policy-approved without the v3 editorial contract');
  assert.ok(tick.held.some((entry) => entry.node === 'application.materials.review' && /resume.standard.v3/.test(entry.reason)));
  runCli(fixture.home, ['application-material', 'review', '--application-id', String(applicationId), '--revision-id', String(resume.final.id), '--render-id', String(resume.render.id), '--decision', 'approved', '--reviewed-by', 'independent-legacy-reviewer', '--expected-review-id', 'none', '--idempotency-key', 'tick:manual-legacy-review']);
  tick = runFabricTick(db, {}, services);
  assert.deepEqual(performedNodes(tick), ['application.materials.select', 'application.materials.select']);
  tick = runFabricTick(db, {}, services);
  assert.deepEqual(performedNodes(tick), ['application.package'], 'readiness went green, the package builds');
  tick = runFabricTick(db, {}, services);
  assert.deepEqual(performedNodes(tick), ['application.submission.propose'],
    'the intent digests the package facts, surface from the application URL');

  // The outward gate: parked by default, and constraints bite at FIRE time.
  tick = runFabricTick(db, {}, services);
  assert.deepEqual(performedNodes(tick), []);
  assert.ok(tick.parked.some((entry) => entry.node === 'application.submission.approve' && entry.owner === 'human'));

  const wrongSurface = setGatePolicy(db, {
    gateId: 'application.submission.approve', mode: 'policy',
    constraints: '{"surfaceAllowlist":["https://elsewhere.test"],"expiresAt":"2027-01-01T00:00:00Z"}',
    setBy: 'Cole', setAuthorship: 'human', expectedCurrentRevisionId: 'none'
  });
  tick = runFabricTick(db, {}, services);
  assert.match(tick.held.find((entry) => entry.node === 'application.submission.approve').reason, /not on the allowlist/);

  const expired = setGatePolicy(db, {
    gateId: 'application.submission.approve', mode: 'policy',
    constraints: '{"surfaceAllowlist":["https://careers.loomworks.test"],"expiresAt":"2020-01-01T00:00:00Z"}',
    setBy: 'Cole', setAuthorship: 'human', expectedCurrentRevisionId: String(wrongSurface.revision.id)
  });
  tick = runFabricTick(db, {}, services);
  assert.match(tick.held.find((entry) => entry.node === 'application.submission.approve').reason, /expired/);

  const live = setGatePolicy(db, {
    gateId: 'application.submission.approve', mode: 'policy',
    constraints: '{"surfaceAllowlist":["https://careers.loomworks.test"],"expiresAt":"2030-01-01T00:00:00Z"}',
    setBy: 'Cole', setAuthorship: 'human', expectedCurrentRevisionId: String(expired.revision.id)
  });
  tick = runFabricTick(db, {}, services);
  assert.deepEqual(performedNodes(tick), ['application.submission.approve']);
  assert.equal(tick.performed[0].actor, `policy:fabric/application.submission.approve@rev${live.revision.id}`);

  // The apply executor: manual parks; the drill override makes it dispatchable
  // (the tick NEVER drives a surface — that is the dispatcher's worker).
  tick = runFabricTick(db, {}, services);
  assert.ok(tick.parked.some((entry) => entry.node === 'application.apply' && entry.mode === 'manual'));
  setGateOverride(db, {
    gateId: 'application.apply', subjectId: applicationId, mode: 'agent',
    reason: 'drill: worker drives the loopback surface', setBy: 'drill-setup', setAuthorship: 'agent'
  });
  tick = runFabricTick(db, {}, services);
  assert.ok(tick.dispatchable.some((entry) => entry.node === 'application.apply'));
  assert.deepEqual(performedNodes(tick), []);

  const approvalId = db.prepare('SELECT approval_id FROM application_submission_approvals ORDER BY approved_at DESC LIMIT 1').get().approval_id;
  runApplicationSubmissionCommand(db, ['claim'], { approvalId, attemptId: 'tick-attempt' }, { home: fixture.home });
  runApplicationSubmissionCommand(db, ['settle'], {
    attemptId: 'tick-attempt', outcome: 'accepted', externalReference: 'confirmation #LOOM-7'
  }, { home: fixture.home });

  tick = runFabricTick(db, {}, services);
  const verifyEntry = tick.dispatchable.find((entry) => entry.node === 'application.verify-record');
  assert.match(verifyEntry.reason, /not verified yet/);

  const files = {};
  for (const upload of listExpectedUploads(db, applicationId)) {
    files[upload.materialKind] = path.resolve(path.dirname(db.name), upload.attachmentPath);
  }
  verifyApplicationUploads(db, { applicationId, files, verifiedBy: 'apply-worker', idempotencyKey: 'tick:verify' });

  tick = runFabricTick(db, {}, services);
  assert.deepEqual(performedNodes(tick), ['application.verify-record']);
  assert.equal(db.prepare('SELECT workflow_stage FROM applications WHERE id=?').get(applicationId).workflow_stage, 'submitted');

  // Quiescence: a submitted application leaves nothing to perform, park, or hold.
  tick = runFabricTick(db, {}, services);
  assert.deepEqual(tick.summary, { performed: 0, held: 0, parked: 0, dispatchable: 0, failed: 0 });
});

test('policy rules are fail-closed and a failing executor is isolated, retried on the next tick', (t) => {
  const fixture = createStore(t);
  const db = fixture.db;
  const services = cliBackedServices(fixture.home);

  const opportunityId = ingestTriaged(db, {
    company: 'Warpline', role: 'Systems Engineer', url: 'https://careers.warpline.test/jobs/3',
    score: '0.8', coverage: '0.9'
  });

  const strict = setGatePolicy(db, {
    gateId: 'opportunity.pursue', mode: 'policy', rules: '{"minScore":0.9}',
    setBy: 'drill-setup', setAuthorship: 'agent', expectedCurrentRevisionId: 'none'
  });
  let tick = runFabricTick(db, {}, services);
  assert.match(tick.held.find((entry) => entry.node === 'opportunity.pursue').reason, /0\.8 < minScore 0\.9/);

  const typo = setGatePolicy(db, {
    gateId: 'opportunity.pursue', mode: 'policy', rules: '{"minScore":0.5,"bogusKnob":1}',
    setBy: 'drill-setup', setAuthorship: 'agent', expectedCurrentRevisionId: String(strict.revision.id)
  });
  tick = runFabricTick(db, {}, services);
  assert.match(tick.held.find((entry) => entry.node === 'opportunity.pursue').reason,
    /unrecognized rule 'bogusKnob'/, 'a typo must never silently widen behavior');

  const sane = setGatePolicy(db, {
    gateId: 'opportunity.pursue', mode: 'policy', rules: '{"minScore":0.5}',
    setBy: 'drill-setup', setAuthorship: 'agent', expectedCurrentRevisionId: String(typo.revision.id)
  });
  tick = runFabricTick(db, {}, services);
  assert.deepEqual(performedNodes(tick), ['opportunity.pursue']);
  assert.equal(tick.performed[0].actor, `policy:fabric/opportunity.pursue@rev${sane.revision.id}`);
  const applicationId = db.prepare('SELECT id FROM applications ORDER BY id DESC LIMIT 1').get().id;

  db.prepare(`
    INSERT INTO application_artifacts(application_id,kind,title,source_url,citation,notes)
    VALUES (?,?,?,?,?,?)
  `).run(applicationId, 'research', 'Warpline research', 'https://warpline.test/about', 'About', 'Notes');
  runCli(fixture.home, [
    'assess-application', '--application-id', String(applicationId),
    '--company-assessment', 'Fine', '--role-fit', 'Good', '--risks', 'None',
    '--evidence', 'Artifacts', '--open-questions', 'None', '--approach', 'Direct'
  ]);
  setGatePolicy(db, {
    gateId: 'application.assessment-review', mode: 'policy',
    setBy: 'drill-setup', setAuthorship: 'agent', expectedCurrentRevisionId: 'none'
  });

  const broken = {
    ...services,
    reviewAssessment: () => { throw new Error('simulated executor outage'); }
  };
  tick = runFabricTick(db, {}, broken);
  const failure = tick.failed.find((entry) => entry.node === 'application.assessment-review');
  assert.match(failure.error.message, /simulated executor outage/);
  assert.deepEqual(performedNodes(tick), [], 'nothing half-happens');

  tick = runFabricTick(db, {}, services);
  assert.deepEqual(performedNodes(tick), ['application.assessment-review'], 'the next tick simply retries');

  // A missing capability degrades to held with a reason, never a crash.
  const withoutReview = { home: fixture.home };
  setGatePolicy(db, {
    gateId: 'application.assessment-review', mode: 'human',
    setBy: 'Cole', setAuthorship: 'human',
    expectedCurrentRevisionId: String(db.prepare(
      "SELECT id FROM fabric_gate_policy_revisions WHERE gate_id='application.assessment-review' ORDER BY id DESC LIMIT 1"
    ).get().id)
  });
  const quiet = runFabricTick(db, {}, withoutReview);
  assert.equal(quiet.failed.length, 0);
});
