'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const {
  acceptApplicationFormUncertainty,
  bindPackagePreparationSnapshot,
  buildApplicationMaterialsContext,
  migrateApplicationMaterials,
  createMaterialRender,
  createMaterialDraft,
  getMaterialRevision,
  getApplicationReadiness,
  reviewMaterialRevision: reviewMaterialRevisionRaw,
  selectMaterialRevision
} = require('../lib/application-materials');
const {
  importApplicationFormObservation,
  stableJson
} = require('../lib/application-form');
const { assessInformationRequest, markInformationRequest } = require('../lib/profile-normalization');
const { freePort } = require('../test-support/free-port');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('application workspace is primary, read-only, redacts route tokens, and keeps unknown form coverage explicit', async (t) => {
  const fixture = makeFixture('jobtrack-materials-web-base-');
  t.after(async () => {
    await stopServer(fixture.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  const prospect = runCli(fixture.home, [
    'add-prospect', '--company', 'Workspace Co', '--role', 'Systems Builder',
    '--url', 'https://jobs.example.test/apply/123?token=SENSITIVE_FORM_TOKEN#private',
    '--notes', 'Prospective material-workspace fixture'
  ]);
  const historical = runCli(fixture.home, [
    'add-application', '--company', 'Legacy Co', '--role', 'Previously Submitted Engineer',
    '--status', 'applied', '--applied-date', '2026-06-20'
  ]);
  const applicationId = prospect.application.id;
  const instance = await startServer(fixture);

  const applications = await request(`${instance.baseUrl}/applications`);
  assert.equal(applications.status, 200, applications.text);
  assert.match(applications.text, new RegExp(`href="/applications/${applicationId}"`));
  assert.match(applications.text, /Opening #/);

  const workspace = await request(`${instance.baseUrl}/applications/${applicationId}`);
  assert.equal(workspace.status, 200, workspace.text);
  assert.match(workspace.text, /Application workspace section index/);
  assert.match(workspace.text, /<meta name="viewport"/);
  assert.match(workspace.text, /@media\(max-width:760px\)/);
  assert.match(workspace.text, /id="materials"/);
  for (const section of ['overview', 'reconnaissance', 'requirements', 'resume', 'cover-letter', 'questions', 'reviews', 'packages', 'history']) {
    assert.match(workspace.text, new RegExp(`id="${section}"`));
  }
  assert.match(workspace.text, /Custom resume revisions/);
  assert.match(workspace.text, /Custom cover-letter revisions/);
  assert.match(workspace.text, /Coverage unknown|coverage is unknown/i);
  assert.doesNotMatch(workspace.text, /SENSITIVE_FORM_TOKEN|#private/);
  // Coverage must never be badged "complete" — unassessed is not complete. Now
  // asserted against the badge marker rather than a class name, so the class can
  // change without silently turning this guard into a tautology.
  assert.doesNotMatch(workspace.text, /data-jt-tone="[a-z]+">complete</i);
  assert.match(workspace.text, /Human-final submission/);
  assertPrivateHeaders(workspace.headers);

  const historicalWorkspace = await request(`${instance.baseUrl}/applications/${historical.application.id}`);
  assert.equal(historicalWorkspace.status, 200, historicalWorkspace.text);
  assert.match(historicalWorkspace.text, /Legacy \/ materials not recorded/);
  assert.match(historicalWorkspace.text, /legacy coverage unknown, not evidence/i);

  const alias = await request(`${instance.baseUrl}/applications/${applicationId}/materials`, { redirect: 'manual' });
  assert.equal(alias.status, 302);
  assert.equal(alias.headers.get('location'), `/applications/${applicationId}#materials`);

  const head = await request(`${instance.baseUrl}/applications/${applicationId}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assertPrivateHeaders(head.headers);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await request(`${instance.baseUrl}/applications/${applicationId}`, { method });
    assert.equal(response.status, 405, `${method}: ${response.text}`);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assertPrivateHeaders(response.headers);
  }
  assert.equal((await request(`${instance.baseUrl}/applications/not-an-id`)).status, 404);
  assert.equal((await request(`${instance.baseUrl}/applications/999999`)).status, 404);

  await stopServer(instance);
});

test('application workspace history keeps uncertainty reasons in the private audit record', async (t) => {
  const fixture = makeFixture('jobtrack-materials-web-uncertainty-history-');
  t.after(async () => {
    await stopServer(fixture.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  const prospect = runCli(fixture.home, [
    'add-prospect', '--company', 'Private Audit Co', '--role', 'Trust Engineer',
    '--url', 'https://jobs.example.test/private-audit/trust'
  ]);
  const applicationId = prospect.application.id;
  const db = new Database(path.join(fixture.home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  const readiness = getApplicationReadiness(db, applicationId);
  const privateReason = 'PRIVATE_UNCERTAINTY_REASON_4F91_MUST_NOT_RENDER_IN_WORKSPACE';
  const accepted = acceptApplicationFormUncertainty(db, {
    applicationId,
    acceptedBy: 'Cole',
    reason: privateReason,
    expectedFormStateSha256: readiness.form.stateSha256,
    acceptedAt: '2026-07-18T07:05:00.000Z',
    idempotencyKey: 'web-private-uncertainty-history'
  });
  assert.equal(accepted.acceptance.reason, privateReason);
  assert.equal(
    db.prepare('SELECT reason FROM application_preparation_uncertainty_events WHERE id=?').get(accepted.acceptance.id).reason,
    privateReason,
    'the exact reason remains available in the private audit store'
  );
  db.close();

  const instance = await startServer(fixture);
  const workspace = await request(`${instance.baseUrl}/applications/${applicationId}`);
  assert.equal(workspace.status, 200, workspace.text);
  assert.match(workspace.text, /form uncertainty accepted/i);
  assert.match(
    workspace.text,
    /Human accepted the recorded uncertainty for this exact form state; reason retained in the private audit log\./
  );
  assert.doesNotMatch(workspace.text, new RegExp(privateReason));
  assertPrivateHeaders(workspace.headers);

  await stopServer(instance);
});

test('full-visibility portal: protected classification holds while the private web surface shows everything', async (t) => {
  const fixture = makeFixture('jobtrack-materials-web-sensitive-');
  t.after(async () => {
    await stopServer(fixture.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  const opportunity = runCli(fixture.home, [
    'opportunity', 'ingest', '--source', 'manual', '--company', 'Sensitive Co',
    '--role', 'Hardware Engineer', '--url', 'https://jobs.example.test/sensitive-co/hardware'
  ]);
  const first = runCli(fixture.home, [
    'opportunity', 'promote', '--opportunity-id', opportunity.opportunityId,
    '--notes', 'Promoted to exercise source-opportunity request redaction.'
  ]);
  const second = runCli(fixture.home, [
    'add-prospect', '--company', 'Boundary Co', '--role', 'Web Engineer',
    '--url', 'https://jobs.example.test/boundary-co/web'
  ]);
  runCli(fixture.home, [
    'profile', 'add', '--category', 'evidence', '--title', 'Human response provenance',
    '--content', 'Operator-confirmed application response source.', '--source', 'test', '--confidence', 'high'
  ]);
  const applicationId = first.application.id;
  const db = new Database(path.join(fixture.home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  const postingId = db.prepare('SELECT primary_job_posting_id FROM applications WHERE id=?').get(applicationId).primary_job_posting_id;
  const sourceOpportunityId = db.prepare('SELECT source_opportunity_id FROM applications WHERE id=?').get(applicationId).source_opportunity_id;
  assert(sourceOpportunityId, 'sensitive fixture must retain its source opportunity');
  const profileEntryId = db.prepare("SELECT id FROM profile_entries WHERE title='Human response provenance'").get().id;
  const sensitiveRequests = [
    {
      applicationId,
      field: 'name',
      requestedLabel: 'Legal name SENSITIVE_APPLICATION_NAME_LABEL_SENTINEL',
      rawPrompt: 'Enter your legal name SENSITIVE_APPLICATION_NAME_PROMPT_SENTINEL',
      idempotencyKey: 'web-sensitive-application-name'
    },
    {
      applicationId,
      field: 'phone',
      requestedLabel: 'Phone number SENSITIVE_APPLICATION_PHONE_LABEL_SENTINEL',
      rawPrompt: 'Enter your phone number SENSITIVE_APPLICATION_PHONE_PROMPT_SENTINEL',
      idempotencyKey: 'web-sensitive-application-phone'
    },
    {
      opportunityId: sourceOpportunityId,
      field: 'email',
      requestedLabel: 'Email address SENSITIVE_OPPORTUNITY_EMAIL_LABEL_SENTINEL',
      rawPrompt: 'Enter your email address SENSITIVE_OPPORTUNITY_EMAIL_PROMPT_SENTINEL',
      idempotencyKey: 'web-sensitive-opportunity-email'
    },
    {
      opportunityId: sourceOpportunityId,
      field: 'location',
      requestedLabel: 'Current location SENSITIVE_OPPORTUNITY_LOCATION_LABEL_SENTINEL',
      rawPrompt: 'Enter your current location SENSITIVE_OPPORTUNITY_LOCATION_PROMPT_SENTINEL',
      idempotencyKey: 'web-sensitive-opportunity-location'
    }
  ];
  for (const request of sensitiveRequests) {
    markInformationRequest(db, {
      ...request,
      requiredness: 'required',
      source: 'web-redaction-regression',
      observedAt: '2026-07-17T20:04:00.000Z'
    });
  }
  const bundle = makeSensitiveFormBundle({ applicationId, postingId });
  const imported = importApplicationFormObservation(db, JSON.stringify(bundle), {
    importedBy: 'web-security-test',
    idempotencyKey: 'web-sensitive-form-import'
  });
  insertMisclassifiedProtectedFields(db, imported.revisionId);
  const fields = db.prepare('SELECT id,provider_field_key,label FROM application_form_fields WHERE revision_id=? ORDER BY position').all(imported.revisionId);
  const fieldId = fields.find((field) => field.label.includes('Social Security Number')).id;
  const sourceKeyProtectedFieldId = fields.find((field) => field.provider_field_key === 'bank-routing-account-number').id;
  const helpProtectedFieldId = fields.find((field) => field.provider_field_key === 'eligibility-detail').id;
  const ordinaryFieldId = fields.find((field) => field.label === 'Why do you want this role?').id;
  const importedSensitivity = db.prepare(`
    SELECT s.slug FROM application_form_fields f
    JOIN information_sensitivity_levels s ON s.id=f.sensitivity_level_id WHERE f.id=?
  `).get(fieldId).slug;
  assert.equal(importedSensitivity, 'standard', 'fixture must exercise the web defense-in-depth override');
  const answer = createWebMaterialDraft(db, {
    applicationId,
    kind: 'form-answer',
    formFieldId: fieldId,
    content: 'SENSITIVE_ANSWER_SENTINEL token=SENSITIVE_TOKEN_SENTINEL /home/user/private-answer.txt',
    authoredBy: 'Cole',
    authorship: 'human',
    stage: 'rough-draft',
    expectedHeadRevisionId: null,
    profileEntryIds: [profileEntryId],
    changeNote: 'SENSITIVE_CHANGE_NOTE_SENTINEL',
    idempotencyKey: 'web-sensitive-answer-v1'
  });
  reviewMaterialRevision(db, {
    applicationId,
    revisionId: answer.revision.id,
    decision: 'approved',
    reviewedBy: 'Cole',
    expectedReviewId: null,
    notes: 'SENSITIVE_REVIEW_NOTE_SENTINEL',
    reviewedAt: '2026-07-17T20:10:00.000Z',
    idempotencyKey: 'web-sensitive-answer-review'
  });
  selectMaterialRevision(db, {
    applicationId,
    revisionId: answer.revision.id,
    selectedBy: 'Cole',
    expectedSelectedRevisionId: null,
    selectedAt: '2026-07-17T20:11:00.000Z',
    idempotencyKey: 'web-sensitive-answer-select'
  });
  db.close();

  const instance = await startServer(fixture);

  // Full-visibility directive (2026-08-05): the private, read-only portal
  // shows EVERYTHING — protected classification still gates authorship and
  // capture, never display.
  const workspace = await request(`${instance.baseUrl}/applications/${applicationId}`);
  assert.equal(workspace.status, 200, workspace.text);
  assert.match(workspace.text, /protected application field still requires human review or resolution/i);
  assert.match(workspace.text, /Why do you want this role\?/);
  assert.doesNotMatch(workspace.text, /Sensitive application question/);
  assert.doesNotMatch(workspace.text, /sensitive response metadata only/i);
  assertPrivateHeaders(workspace.headers);

  const question = await request(`${instance.baseUrl}/applications/${applicationId}/questions/${fieldId}`);
  assert.equal(question.status, 200, question.text);
  assert.match(question.text, /SENSITIVE_ANSWER_SENTINEL/, 'protected answer content is visible');
  assert.doesNotMatch(question.text, /Sensitive response content hidden/);
  assertPrivateHeaders(question.headers);

  for (const protectedFieldId of [sourceKeyProtectedFieldId, helpProtectedFieldId]) {
    const protectedQuestion = await request(`${instance.baseUrl}/applications/${applicationId}/questions/${protectedFieldId}`);
    assert.equal(protectedQuestion.status, 200, protectedQuestion.text);
    assert.doesNotMatch(protectedQuestion.text, /Sensitive application question/);
  }

  const ordinaryQuestion = await request(`${instance.baseUrl}/applications/${applicationId}/questions/${ordinaryFieldId}`);
  assert.equal(ordinaryQuestion.status, 200, ordinaryQuestion.text);
  assert.match(ordinaryQuestion.text, /Why do you want this role\?/);
  assert.match(ordinaryQuestion.text, /Keep the response specific to this opening\./);
  assert.doesNotMatch(ordinaryQuestion.text, /Sensitive application question/);

  const material = await request(`${instance.baseUrl}/applications/${applicationId}/materials/${answer.revision.id}`);
  assert.equal(material.status, 200, material.text);
  assert.match(material.text, /SENSITIVE_ANSWER_SENTINEL/, 'material content is visible');
  assert.match(material.text, /SENSITIVE_REVIEW_NOTE_SENTINEL/, 'review notes are visible');
  assert.match(material.text, /SENSITIVE_CHANGE_NOTE_SENTINEL/, 'change note is visible');
  assert.doesNotMatch(material.text, /intentionally not rendered/);

  const crossApplication = await request(`${instance.baseUrl}/applications/${second.application.id}/questions/${fieldId}`);
  assert.equal(crossApplication.status, 404);
  assertSensitiveSentinelsAbsent(crossApplication.text);

  const questionHead = await request(`${instance.baseUrl}/applications/${applicationId}/questions/${fieldId}`, { method: 'HEAD' });
  assert.equal(questionHead.status, 200);
  assert.equal(questionHead.text, '');
  assertPrivateHeaders(questionHead.headers);
  const questionPost = await request(`${instance.baseUrl}/applications/${applicationId}/questions/${fieldId}`, { method: 'POST' });
  assert.equal(questionPost.status, 405);
  assert.equal(questionPost.headers.get('allow'), 'GET, HEAD');

  await stopServer(instance);
});

test('material revisions keep approved selection stable, enforce route ownership, and render generated text inertly', async (t) => {
  const fixture = makeFixture('jobtrack-materials-web-revisions-');
  t.after(async () => {
    await stopServer(fixture.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  const first = runCli(fixture.home, [
    'add-prospect', '--company', 'Revision Co', '--role', 'Platform Engineer',
    '--url', 'https://jobs.example.test/revision-co/platform'
  ]);
  const second = runCli(fixture.home, [
    'add-prospect', '--company', 'Other Co', '--role', 'Frontend Engineer',
    '--url', 'https://jobs.example.test/other-co/frontend'
  ]);
  const applicationId = first.application.id;
  runCli(fixture.home, [
    'capture-posting', '--application-id', applicationId,
    '--source-url', 'https://jobs.example.test/revision-co/platform',
    '--content', 'Build secure Node.js systems and reliable operator tooling.'
  ]);
  runCli(fixture.home, [
    'profile', 'add', '--category', 'evidence', '--title', 'Platform evidence',
    '--content', 'Built reliable agent-operated systems.', '--source', 'test', '--confidence', 'high'
  ]);

  const db = new Database(path.join(fixture.home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  seedEmptyFormBoundary(db);
  migrateApplicationMaterials(db);
  const artifactId = db.prepare("SELECT id FROM application_artifacts WHERE application_id=? AND kind='posting' ORDER BY id DESC LIMIT 1").get(applicationId).id;
  const profileEntryId = db.prepare("SELECT id FROM profile_entries WHERE title='Platform evidence'").get().id;

  const resumeV1 = createWebMaterialDraft(db, {
    applicationId, kind: 'resume',
    content: 'CUSTOM RESUME V1\n&lt;already escaped?&gt;\n<script>resumeAttack()</script>',
    authoredBy: 'test-agent', authorship: 'model', stage: 'rough-draft',
    expectedHeadRevisionId: null, artifactIds: [artifactId], profileEntryIds: [profileEntryId],
    idempotencyKey: 'web-resume-v1'
  });
  reviewMaterialRevision(db, {
    applicationId, revisionId: resumeV1.revision.id, decision: 'approved', reviewedBy: 'Cole',
    expectedReviewId: null, notes: 'Approved first custom pass.',
    reviewedAt: '2026-07-17T20:00:00.000Z', idempotencyKey: 'web-resume-v1-review'
  });
  selectMaterialRevision(db, {
    applicationId, revisionId: resumeV1.revision.id, selectedBy: 'Cole',
    expectedSelectedRevisionId: null, selectedAt: '2026-07-17T20:01:00.000Z',
    idempotencyKey: 'web-resume-v1-select'
  });
  const resumeV2 = createWebMaterialDraft(db, {
    applicationId, kind: 'resume', content: 'CUSTOM RESUME V2 — rough refinement',
    authoredBy: 'test-agent', authorship: 'model', stage: 'revised',
    expectedHeadRevisionId: resumeV1.revision.id, parentRevisionId: resumeV1.revision.id,
    artifactIds: [artifactId], profileEntryIds: [profileEntryId],
    changeNote: 'Refined without replacing the approved selection.', idempotencyKey: 'web-resume-v2'
  });
  createWebMaterialDraft(db, {
    applicationId, kind: 'cover-letter', content: 'CUSTOM COVER LETTER V1',
    authoredBy: 'test-agent', authorship: 'model', stage: 'rough-draft',
    expectedHeadRevisionId: null, artifactIds: [artifactId], profileEntryIds: [profileEntryId],
    idempotencyKey: 'web-letter-v1'
  });
  db.close();

  const instance = await startServer(fixture);

  const workspace = await request(`${instance.baseUrl}/applications/${applicationId}`);
  assert.equal(workspace.status, 200, workspace.text);
  assert.match(workspace.text, /resume revision 2[\s\S]*Latest draft/);
  assert.match(workspace.text, /resume revision 1[\s\S]*Selected current/);
  assert.match(workspace.text, /Draftable, not package-ready/);
  assert.doesNotMatch(workspace.text, /package-ready<\/strong>/i);

  const approved = await request(`${instance.baseUrl}/applications/${applicationId}/materials/${resumeV1.revision.id}`);
  assert.equal(approved.status, 200, approved.text);
  assert.match(approved.text, /selected current/);
  assert.match(approved.text, /Approved first custom pass/);
  assert.match(approved.text, /CUSTOM RESUME V1/);
  assert.match(approved.text, /&lt;script&gt;resumeAttack\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(approved.text, /<script>resumeAttack\(\)<\/script>/);
  assert.doesNotMatch(approved.text, /application_snapshot_json|profile_snapshot_json|attachment_path/);

  const newest = await request(`${instance.baseUrl}/applications/${applicationId}/materials/${resumeV2.revision.id}`);
  assert.equal(newest.status, 200, newest.text);
  assert.match(newest.text, /unreviewed/);
  assert.doesNotMatch(newest.text, /selected current/);

  const crossApplication = await request(`${instance.baseUrl}/applications/${second.application.id}/materials/${resumeV1.revision.id}`);
  assert.equal(crossApplication.status, 404);
  assert.doesNotMatch(crossApplication.text, /CUSTOM RESUME V1|Approved first custom pass/);

  const materialPost = await request(`${instance.baseUrl}/applications/${applicationId}/materials/${resumeV1.revision.id}`, { method: 'POST' });
  assert.equal(materialPost.status, 405);
  assert.equal(materialPost.headers.get('allow'), 'GET, HEAD');
  assertPrivateHeaders(materialPost.headers);

  await stopServer(instance);
});

test('a preparation package visibly reports when its pinned sources become stale', async (t) => {
  const fixture = makeFixture('jobtrack-materials-web-stale-package-');
  t.after(async () => {
    await stopServer(fixture.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  const prospect = runCli(fixture.home, [
    'add-prospect', '--company', 'Package Co', '--role', 'Reliability Engineer',
    '--url', 'https://jobs.example.test/package-co/reliability'
  ]);
  const applicationId = prospect.application.id;
  const db = new Database(path.join(fixture.home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  migrateApplicationMaterials(db);
  const artifactId = addWebArtifact(db, applicationId, 'posting', 'Reliability Engineer exact opening evidence.');
  const profileEntryId = addWebProfileEntry(db, 'Reliability evidence', 'Built and operated reliable production systems.');
  addWebApprovedAssessment(db, applicationId, artifactId);
  finalizeWebMaterial(db, applicationId, 'resume', artifactId, profileEntryId, 'web-stale-resume');
  finalizeWebMaterial(db, applicationId, 'cover-letter', artifactId, profileEntryId, 'web-stale-letter');
  let readiness = getApplicationReadiness(db, applicationId);
  acceptApplicationFormUncertainty(db, {
    applicationId,
    acceptedBy: 'Cole',
    reason: 'No public form schema is available; manually review the exact form before submission.',
    expectedFormStateSha256: readiness.form.stateSha256,
    idempotencyKey: 'web-stale-form-uncertainty'
  });
  readiness = getApplicationReadiness(db, applicationId);
  assert.equal(readiness.ready, true, JSON.stringify(readiness.blockers));
  const packageId = Number(db.prepare("INSERT INTO application_packages(application_id,package_status) VALUES (?,'ready')").run(applicationId).lastInsertRowid);
  bindPackagePreparationSnapshot(db, {
    applicationId,
    packageId,
    expectedReadinessSha256: readiness.readinessSha256,
    idempotencyKey: 'web-stale-package-binding'
  });
  db.prepare("UPDATE applications SET role='Reliability Engineer — materially changed' WHERE id=?").run(applicationId);
  const staleReadiness = getApplicationReadiness(db, applicationId);
  assert.notEqual(staleReadiness.readinessSha256, readiness.readinessSha256);
  db.close();

  const instance = await startServer(fixture);
  const workspace = await request(`${instance.baseUrl}/applications/${applicationId}`);
  assert.equal(workspace.status, 200, workspace.text);
  assert.match(workspace.text, new RegExp(`Package #${packageId}[\\s\\S]*?stale`, 'i'));
  assertPrivateHeaders(workspace.headers);

  await stopServer(instance);
});

test('application workspace and missing-profile signal honor the exact primary posting route', async (t) => {
  const fixture = makeFixture('jobtrack-materials-web-exact-route-');
  t.after(async () => {
    await stopServer(fixture.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  const opportunity = runCli(fixture.home, [
    'opportunity', 'ingest', '--source', 'manual', '--company', 'Exact Route Co',
    '--role', 'Route Reliability Engineer', '--url', 'https://jobs.example.test/exact-route/primary'
  ]);
  const promoted = runCli(fixture.home, [
    'opportunity', 'promote', '--opportunity-id', opportunity.opportunityId,
    '--notes', 'Exact-route information-request regression.'
  ]);
  const applicationId = promoted.application.id;
  const openingId = promoted.application.job_opening_id;
  const primaryPostingId = promoted.application.primary_job_posting_id;
  const sibling = runCli(fixture.home, [
    'catalog', 'posting', 'create', '--opening-id', openingId,
    '--url', 'https://jobs.example.test/exact-route/sibling', '--platform', 'direct',
    '--venue-key', 'jobs.example.test', '--external-id', 'exact-route-sibling'
  ]).posting;
  runCli(fixture.home, [
    'catalog', 'posting', 'link-application', '--application-id', applicationId,
    '--posting-id', sibling.id, '--relation', 'alternate'
  ]);

  const db = new Database(path.join(fixture.home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  const sourceId = db.prepare('SELECT source_id FROM opportunity_snapshots WHERE id=?').get(opportunity.snapshotId).source_id;
  const siblingSnapshotText = 'Sibling posting snapshot used only to prove exact-route exclusion.';
  const siblingSnapshotSha256 = sha256(siblingSnapshotText);
  const siblingSnapshotId = Number(db.prepare(`
    INSERT INTO opportunity_snapshots(
      opportunity_id,source_id,observed_url,fetched_at,parser_name,parser_version,
      normalized_json,normalized_text,normalized_sha256,job_posting_id
    ) VALUES (?,?,?,'2026-07-17T21:00:00.000Z','exact-route-regression','1',?,?,?,?)
  `).run(
    opportunity.opportunityId,
    sourceId,
    'https://jobs.example.test/exact-route/sibling',
    stableJson({ title: 'Sibling route only' }),
    siblingSnapshotText,
    siblingSnapshotSha256,
    sibling.id
  ).lastInsertRowid);

  const siblingApplication = markMissingInformationRequest(db, {
    applicationId,
    field: 'notice-period',
    requiredness: 'required',
    requestedLabel: 'ROUTE_SIBLING_APPLICATION_MUST_NOT_RENDER_7F3A_SENTINEL',
    rawPrompt: 'ROUTE_SIBLING_APPLICATION_PROMPT_MUST_NOT_RENDER_7F3A_SENTINEL',
    snapshotId: siblingSnapshotId,
    idempotencyKey: 'web-exact-route-sibling-application'
  });
  assert.equal(siblingApplication.request.job_posting_id, null, 'fixture must rely only on the sibling snapshot route');
  assert.equal(siblingApplication.request.opportunity_snapshot_id, siblingSnapshotId);

  const siblingSource = markMissingInformationRequest(db, {
    opportunityId: opportunity.opportunityId,
    field: 'education-history',
    requiredness: 'conditional',
    requestedLabel: 'ROUTE_SIBLING_SOURCE_MUST_NOT_RENDER_8B42_SENTINEL',
    rawPrompt: 'ROUTE_SIBLING_SOURCE_PROMPT_MUST_NOT_RENDER_8B42_SENTINEL',
    snapshotId: siblingSnapshotId,
    idempotencyKey: 'web-exact-route-sibling-source'
  });
  assert.equal(siblingSource.request.job_posting_id, null, 'source fixture must also rely only on the sibling snapshot route');

  markMissingInformationRequest(db, {
    applicationId,
    field: 'earliest-start-date',
    requiredness: 'required',
    requestedLabel: 'ROUTE_PRIMARY_APPLICATION_INCLUDED_1A2B_SENTINEL',
    rawPrompt: 'ROUTE_PRIMARY_APPLICATION_PROMPT_INCLUDED_1A2B_SENTINEL',
    snapshotId: opportunity.snapshotId,
    idempotencyKey: 'web-exact-route-primary-application'
  });
  markMissingInformationRequest(db, {
    applicationId,
    field: 'professional-summary',
    requiredness: 'optional',
    requestedLabel: 'ROUTE_GLOBAL_APPLICATION_INCLUDED_2C3D_SENTINEL',
    rawPrompt: 'ROUTE_GLOBAL_APPLICATION_PROMPT_INCLUDED_2C3D_SENTINEL',
    idempotencyKey: 'web-exact-route-global-application'
  });
  markMissingInformationRequest(db, {
    opportunityId: opportunity.opportunityId,
    field: 'remote-preference',
    requiredness: 'conditional',
    requestedLabel: 'ROUTE_PRIMARY_SOURCE_INCLUDED_4E5F_SENTINEL',
    rawPrompt: 'ROUTE_PRIMARY_SOURCE_PROMPT_INCLUDED_4E5F_SENTINEL',
    snapshotId: opportunity.snapshotId,
    idempotencyKey: 'web-exact-route-primary-source'
  });
  assert.equal(
    db.prepare('SELECT job_posting_id FROM opportunity_snapshots WHERE id=?').get(opportunity.snapshotId).job_posting_id,
    primaryPostingId,
    'control snapshot must belong to the application primary route'
  );
  importApplicationFormObservation(db, makeRouteFormBundle({
    applicationId,
    postingId: sibling.id,
    applyUrl: 'https://jobs.example.test/exact-route/sibling/apply',
    providerFormKey: 'exact-route-sibling-form',
    providerFieldKey: 'sibling_route_question',
    fieldLabel: 'ROUTE_SIBLING_FORM_MUST_NOT_RENDER_5D7E_SENTINEL',
    observedAt: '2026-07-17T21:10:00.000Z'
  }), {
    importedBy: 'web-exact-route-regression',
    idempotencyKey: 'web-exact-route-sibling-form'
  });
  importApplicationFormObservation(db, makeRouteFormBundle({
    applicationId,
    postingId: primaryPostingId,
    applyUrl: 'https://jobs.example.test/exact-route/primary/apply',
    providerFormKey: 'exact-route-primary-form',
    providerFieldKey: 'primary_route_question',
    fieldLabel: 'ROUTE_PRIMARY_FORM_INCLUDED_6F8A_SENTINEL',
    observedAt: '2026-07-17T21:11:00.000Z'
  }), {
    importedBy: 'web-exact-route-regression',
    idempotencyKey: 'web-exact-route-primary-form'
  });
  db.close();

  const instance = await startServer(fixture);

  const workspace = await request(`${instance.baseUrl}/applications/${applicationId}`);
  assert.equal(workspace.status, 200, workspace.text);
  for (const included of [
    'ROUTE_PRIMARY_APPLICATION_INCLUDED_1A2B_SENTINEL',
    'ROUTE_PRIMARY_APPLICATION_PROMPT_INCLUDED_1A2B_SENTINEL',
    'ROUTE_GLOBAL_APPLICATION_INCLUDED_2C3D_SENTINEL',
    'ROUTE_GLOBAL_APPLICATION_PROMPT_INCLUDED_2C3D_SENTINEL',
    'ROUTE_PRIMARY_SOURCE_INCLUDED_4E5F_SENTINEL',
    'ROUTE_PRIMARY_SOURCE_PROMPT_INCLUDED_4E5F_SENTINEL'
  ]) assert.match(workspace.text, new RegExp(included));
  assert.doesNotMatch(workspace.text, /ROUTE_SIBLING_(?:APPLICATION|SOURCE)(?:_PROMPT)?_MUST_NOT_RENDER_[A-Z0-9_]+_SENTINEL/);
  assert.match(workspace.text, /ROUTE_PRIMARY_FORM_INCLUDED_6F8A_SENTINEL/);
  assert.doesNotMatch(workspace.text, /ROUTE_SIBLING_FORM_MUST_NOT_RENDER_5D7E_SENTINEL/);
  assert.match(workspace.text, /<span class="label">Known requirements<\/span><span>4<\/span>/);
  assert.match(workspace.text, /<span class="label">Profile blockers<\/span><span>2<\/span>/);
  assertPrivateHeaders(workspace.headers);

  for (const route of ['/', '/applications']) {
    const collection = await request(`${instance.baseUrl}${route}`);
    assert.equal(collection.status, 200, `${route}: ${collection.text}`);
    assert.match(collection.text, /Profile information blocker · 2 required\/conditional field\(s\) · 1 other confirmed missing/);
    assert.doesNotMatch(collection.text, /Profile information blocker · [34] required\/conditional field\(s\)/);
    assert.doesNotMatch(collection.text, /ROUTE_SIBLING_/);
    assertPrivateHeaders(collection.headers);
  }

  await stopServer(instance);
});

function markMissingInformationRequest(db, input) {
  const target = input.applicationId
    ? { applicationId: input.applicationId }
    : { opportunityId: input.opportunityId };
  const marked = markInformationRequest(db, {
    ...target,
    field: input.field,
    requiredness: input.requiredness,
    requestedLabel: input.requestedLabel,
    rawPrompt: input.rawPrompt,
    source: 'web-exact-route-regression',
    snapshotId: input.snapshotId,
    observedAt: '2026-07-17T21:05:00.000Z',
    idempotencyKey: `${input.idempotencyKey}:request`
  });
  assessInformationRequest(db, {
    ...target,
    requestId: marked.request.id,
    state: 'confirmed_missing',
    assessedBy: 'web-exact-route-regression',
    rationale: 'Exact-route regression fixture intentionally marks this field missing.',
    evidence: 'Synthetic inert regression evidence.',
    expectedAssessmentId: 'none',
    assessedAt: '2026-07-17T21:06:00.000Z',
    idempotencyKey: `${input.idempotencyKey}:assessment`
  });
  return marked;
}

function createWebMaterialDraft(db, input) {
  return createMaterialDraft(db, {
    ...input,
    expectedSourceStateSha256: input.expectedSourceStateSha256
      || buildApplicationMaterialsContext(db, input.applicationId, {
        kind: input.kind,
        formFieldId: input.formFieldId,
        parentRevisionId: input.parentRevisionId,
        artifactIds: input.artifactIds,
        profileEntryIds: input.profileEntryIds,
        storyUseIds: input.storyUseIds
      }).sourceStateSha256
  });
}

function reviewMaterialRevision(db, input) {
  let renderId = input.renderId || null;
  if (input.decision === 'approved' && !renderId) {
    const revision = getMaterialRevision(db, input.revisionId, input.applicationId || null);
    if (['resume', 'cover-letter'].includes(revision.material_kind) && revision.source_format === 'latex') {
      renderId = createWebSyntheticRender(db, revision).id;
    }
  }
  return reviewMaterialRevisionRaw(db, { ...input, renderId });
}

function createWebSyntheticRender(db, revision) {
  const { recordMaterialLintReport } = require('../lib/resume-lint');
  const existing = db.prepare('SELECT id FROM application_material_renders WHERE revision_id=? ORDER BY id LIMIT 1').get(revision.id);
  if (existing) {
    const render = db.prepare('SELECT * FROM application_material_renders WHERE id=?').get(existing.id);
    recordMaterialLintReport(db, {
      applicationId: revision.application_id,
      renderId: render.id,
      lintedBy: 'web-test-lint',
      idempotencyKey: `web-test-lint:${render.id}`
    });
    return render;
  }
  const application = db.prepare('SELECT company, role FROM applications WHERE id=?').get(revision.application_id);
  const directory = path.join(path.dirname(db.name), 'attachments', 'material-renders', String(revision.application_id), String(revision.id));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const pdf = Buffer.from(`%PDF-1.4\n% synthetic web render ${revision.content_sha256}\n%%EOF\n`);
  const outputSha256 = crypto.createHash('sha256').update(pdf).digest('hex');
  const outputPath = path.join(directory, `${outputSha256}.pdf`);
  fs.writeFileSync(outputPath, pdf, { mode: 0o600 });
  const extractedText = [
    'Cole Example',
    `${application?.company || 'Example Co'} — ${application?.role || 'Engineer'}`,
    '',
    `Synthetic web extraction for revision ${revision.content_sha256}.`,
    'Deterministic body text that stands in for a rendered document during tests. '.repeat(6)
  ].join('\n');
  const textPath = path.join(directory, `${outputSha256}.txt`);
  fs.writeFileSync(textPath, extractedText, { mode: 0o600 });
  const render = createMaterialRender(db, {
    applicationId: revision.application_id,
    revisionId: revision.id,
    expectedContentSha256: revision.content_sha256,
    renderedBy: 'web-test-fixed-renderer',
    idempotencyKey: `web-test-render:${revision.id}`,
    renderResult: {
      rendererProfile: 'jobtrack-latex-pdf-v1',
      rendererImageDigest: `sha256:${'c'.repeat(64)}`,
      rendererVersion: 'web-test-renderer-v1',
      bundleSha256: 'd'.repeat(64),
      outputAttachmentPath: outputPath,
      extractedTextAttachmentPath: textPath,
      outputSha256,
      outputBytes: pdf.length,
      pageCount: 1,
      extractedTextSha256: crypto.createHash('sha256').update(extractedText).digest('hex'),
      activeContentPolicy: 'jobtrack-pdf-active-content.v1',
      activeContentScanSha256: crypto.createHash('sha256')
        .update(`jobtrack-pdf-active-content.v1\n${outputSha256}\nclean\n`).digest('hex')
    }
  }).render;
  recordMaterialLintReport(db, {
    applicationId: revision.application_id,
    renderId: render.id,
    lintedBy: 'web-test-lint',
    idempotencyKey: `web-test-lint:${render.id}`
  });
  return render;
}

function addWebArtifact(db, applicationId, kind, content) {
  return Number(db.prepare(`
    INSERT INTO application_artifacts(application_id,kind,title,content)
    VALUES (?,?,?,?)
  `).run(applicationId, kind, `${kind} evidence`, content).lastInsertRowid);
}

function addWebProfileEntry(db, title, content) {
  return Number(db.prepare(`
    INSERT INTO profile_entries(category,title,content,source,confidence,tags)
    VALUES ('work',?,?,'test','high','[]')
  `).run(title, content).lastInsertRowid);
}

function addWebApprovedAssessment(db, applicationId, artifactId) {
  db.prepare(`
    INSERT INTO application_assessments(
      application_id,artifact_id,company_assessment,role_fit,risks,evidence,open_questions,approach,profile_entry_refs
    ) VALUES (?,?,'sound','strong','review','posting','none','apply','[]')
  `).run(applicationId, artifactId);
  db.prepare(`
    INSERT INTO assessment_review_gates(application_id,artifact_id,decision,decided_by)
    VALUES (?,?,'approved','Cole')
  `).run(applicationId, artifactId);
}

function finalizeWebMaterial(db, applicationId, kind, artifactId, profileEntryId, key) {
  const rough = createWebMaterialDraft(db, {
    applicationId,
    kind,
    content: `${kind} application-specific rough draft`,
    authoredBy: 'test-generator',
    authorship: 'model',
    stage: 'rough-draft',
    expectedHeadRevisionId: null,
    artifactIds: [artifactId],
    profileEntryIds: [profileEntryId],
    idempotencyKey: `${key}:rough`
  });
  const finalCandidate = createWebMaterialDraft(db, {
    applicationId,
    kind,
    content: `${kind} application-specific final candidate`,
    authoredBy: 'test-generator',
    authorship: 'model',
    stage: 'final-candidate',
    parentRevisionId: rough.revision.id,
    expectedHeadRevisionId: rough.revision.id,
    artifactIds: [artifactId],
    profileEntryIds: [profileEntryId],
    idempotencyKey: `${key}:final`
  });
  reviewMaterialRevision(db, {
    applicationId,
    revisionId: finalCandidate.revision.id,
    decision: 'approved',
    reviewedBy: 'Cole',
    expectedReviewId: null,
    idempotencyKey: `${key}:review`
  });
  selectMaterialRevision(db, {
    applicationId,
    revisionId: finalCandidate.revision.id,
    selectedBy: 'Cole',
    expectedSelectedRevisionId: null,
    idempotencyKey: `${key}:select`
  });
  return finalCandidate;
}

function seedEmptyFormBoundary(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS application_form_surfaces(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_posting_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS application_form_revisions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface_id INTEGER NOT NULL,
      coverage_state_id INTEGER,
      observation_sha256 TEXT,
      observed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS application_form_fields(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision_id INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS application_application_form_surfaces(
      application_id INTEGER NOT NULL,
      surface_id INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opportunity_application_form_surfaces(
      opportunity_id INTEGER NOT NULL,
      surface_id INTEGER NOT NULL
    );
  `);
}

function makeSensitiveFormBundle({ applicationId, postingId }) {
  const observationWithoutDigest = {
    captureMethod: 'human-observation',
    observedAt: '2026-07-17T20:05:00.000Z',
    evidenceSha256: 'a'.repeat(64),
    coverage: {
      state: 'entry-step-observed',
      declaredStepCount: 1,
      knownUnobservedStepCount: 0,
      possibleUnobservedBranches: true,
      preSubmitBoundaryObserved: false,
      blocker: null
    },
    steps: [{
      position: 1,
      providerStepKey: 'self-identification',
      label: 'Sensitive details',
      observationState: 'observed-visible',
      fields: [
        {
          position: 1,
          providerFieldKey: 'motivation',
          label: 'Why do you want this role?',
          helpText: 'Keep the response specific to this opening.',
          inputKind: 'long-text',
          requiredness: 'required',
          sensitivity: 'standard',
          profileInformationField: null,
          observationState: 'observed-visible',
          isRepeatable: false,
          constraints: {
            minLength: null, maxLength: 500, minSelections: null, maxSelections: null,
            maxFileBytes: null, acceptedMimeTypes: [], acceptedExtensions: []
          },
          options: []
        }
      ]
    }]
  };
  const observation = {
    ...observationWithoutDigest,
    observationSha256: sha256(stableJson(observationWithoutDigest))
  };
  const withoutBundleId = {
    schemaVersion: 1,
    kind: 'application-form-observation-bundle',
    trust: 'untrusted_external',
    target: { jobPostingId: postingId, opportunityId: null, applicationId },
    surface: { applyUrl: 'https://jobs.example.test/sensitive-co/hardware', providerFormKey: 'sensitive-co-hardware' },
    observation
  };
  return { ...withoutBundleId, bundleId: `sha256:${sha256(stableJson(withoutBundleId))}` };
}

function makeRouteFormBundle({
  applicationId,
  postingId,
  applyUrl,
  providerFormKey,
  providerFieldKey,
  fieldLabel,
  observedAt
}) {
  const observationWithoutDigest = {
    captureMethod: 'provider-schema',
    observedAt,
    evidenceSha256: sha256(`${providerFormKey}:evidence`),
    coverage: {
      state: 'complete',
      declaredStepCount: 1,
      knownUnobservedStepCount: 0,
      possibleUnobservedBranches: false,
      preSubmitBoundaryObserved: false,
      blocker: null
    },
    steps: [{
      position: 1,
      providerStepKey: 'questions',
      label: 'Application questions',
      observationState: 'observed-visible',
      fields: [{
        position: 1,
        providerFieldKey,
        label: fieldLabel,
        helpText: null,
        inputKind: 'long-text',
        requiredness: 'optional',
        sensitivity: 'standard',
        profileInformationField: null,
        observationState: 'observed-visible',
        isRepeatable: false,
        constraints: {
          minLength: 1,
          maxLength: 1000,
          minSelections: null,
          maxSelections: null,
          maxFileBytes: null,
          acceptedMimeTypes: [],
          acceptedExtensions: []
        },
        options: []
      }]
    }]
  };
  const observation = {
    ...observationWithoutDigest,
    observationSha256: sha256(stableJson(observationWithoutDigest))
  };
  const withoutBundleId = {
    schemaVersion: 1,
    kind: 'application-form-observation-bundle',
    trust: 'untrusted_external',
    target: { jobPostingId: postingId, opportunityId: null, applicationId },
    surface: { applyUrl, providerFormKey },
    observation
  };
  return { ...withoutBundleId, bundleId: `sha256:${sha256(stableJson(withoutBundleId))}` };
}

function insertMisclassifiedProtectedFields(db, revisionId) {
  // The current importer rejects these rows. Seed them below its boundary to
  // model a legacy/corrupted store and prove the read-only UI still fails shut.
  const stepId = db.prepare('SELECT id FROM application_form_steps WHERE revision_id=? ORDER BY position LIMIT 1').get(revisionId).id;
  const surfaceId = db.prepare('SELECT surface_id FROM application_form_revisions WHERE id=?').get(revisionId).surface_id;
  const inputKindId = db.prepare("SELECT id FROM application_form_input_kinds WHERE slug='long-text'").get().id;
  const requirednessId = db.prepare("SELECT id FROM information_requiredness_levels WHERE slug='required'").get().id;
  const sensitivityId = db.prepare("SELECT id FROM information_sensitivity_levels WHERE slug='standard'").get().id;
  const observationStateId = db.prepare("SELECT id FROM application_form_observation_states WHERE slug='observed-visible'").get().id;
  const constraints = stableJson({
    minLength: null, maxLength: 500, minSelections: null, maxSelections: null,
    maxFileBytes: null, acceptedMimeTypes: [], acceptedExtensions: []
  });
  const insert = db.prepare(`
    INSERT INTO application_form_fields(
      revision_id,step_id,field_identity_id,position,provider_field_key,label,help_text,input_kind_id,requiredness_id,
      sensitivity_level_id,profile_information_field_id,observation_state_id,is_repeatable,constraints_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,0,?)
  `);
  const insertLegacyField = (position, providerFieldKey, label, helpText) => {
    db.prepare(`
      INSERT OR IGNORE INTO application_form_field_identities(surface_id,provider_field_key)
      VALUES (?,?)
    `).run(surfaceId, providerFieldKey);
    const identityId = db.prepare(`
      SELECT id FROM application_form_field_identities WHERE surface_id=? AND provider_field_key=?
    `).get(surfaceId, providerFieldKey).id;
    insert.run(
      revisionId, stepId, identityId, position, providerFieldKey, label, helpText,
      inputKindId, requirednessId, sensitivityId, observationStateId, constraints
    );
  };
  insertLegacyField(
    2,
    'applicant-identifier',
    'Social Security Number SENSITIVE_PROMPT_SENTINEL',
    'Enter the requested value. SENSITIVE_HELP_SENTINEL'
  );
  insertLegacyField(
    3,
    'bank-routing-account-number',
    'Payment destination SENSITIVE_SOURCE_LABEL_SENTINEL',
    'Enter the requested value. SENSITIVE_SOURCE_HELP_SENTINEL'
  );
  insertLegacyField(
    4,
    'eligibility-detail',
    'Eligibility detail SENSITIVE_BIRTH_LABEL_SENTINEL',
    'Enter your birth date. SENSITIVE_BIRTH_HELP_SENTINEL'
  );
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function assertSensitiveSentinelsAbsent(text) {
  const match = text.match(/SENSITIVE_[A-Z_]+_SENTINEL/);
  assert.equal(match, null, match ? `leaked sensitive sentinel: ${match[0]}` : undefined);
  assert.doesNotMatch(text, /\/Users\/cole\/private-answer\.txt/);
}

function makeFixture(prefix) {
  const { root: rootPath, home } = require('../test-support/migrated-store').createTestStore(prefix);
  const tmp = path.join(rootPath, 'tmp');
  fs.mkdirSync(tmp);
  return { root: rootPath, home, tmp };
}

function runCli(home, args) {
  const stdout = execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return JSON.parse(stdout);
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
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not exit: ${instance.stderr()}`)), 3000))
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
  assert.match(headers.get('permissions-policy') || '', /camera=\(\)/);
}
