'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createMaterialRender } = require('../lib/application-materials');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('legacy-import drafting still uses the current assessment revision, not caller-controlled timestamps', () => {
  const home = makeHome('jobtrack-gates-');
  const applicationId = seedLegacyAssessedApplication(home);
  assert.equal(preparationMode(home, applicationId), 'legacy-import');

  const unattributed = runFailure(home, ['review-assessment', '--application-id', applicationId, '--decision', 'approved']);
  assert.match(unattributed.stderr, /--decided-by/);

  run(home, ['review-assessment', '--application-id', applicationId, '--decision', 'approved', '--decided-by', 'Cole', '--decided-at', '2099-01-01']);
  run(home, ['review-assessment', '--application-id', applicationId, '--decision', 'revision_requested', '--decided-by', 'Cole', '--decided-at', '2000-01-01']);
  const staleByTime = runFailure(home, ['draft-cover-letter', '--application-id', applicationId, '--content', 'Should not store']);
  assert.match(staleByTime.stderr, /latest assessment gate is approved/);

  run(home, ['review-assessment', '--application-id', applicationId, '--decision', 'approved', '--decided-by', 'Cole']);
  run(home, ['draft-cover-letter', '--application-id', applicationId, '--content', 'Approved current letter']);
  run(home, [
    'assess-application', '--application-id', applicationId,
    '--company-assessment', 'Revised company assessment', '--role-fit', 'Revised fit',
    '--risks', 'Revised risk', '--approach', 'Revised approach'
  ]);
  const staleByRevision = runFailure(home, ['draft-cover-letter', '--application-id', applicationId, '--content', 'Should also not store']);
  assert.match(staleByRevision.stderr, /current assessment revision has not been approved|latest assessment gate is approved/);
});

test('legacy-import package artifacts are immutable and profile export is explicit and default-deny', () => {
  const home = makeHome('jobtrack-package-');
  const applicationId = seedLegacyAssessedApplication(home);
  assert.equal(preparationMode(home, applicationId), 'legacy-import');
  run(home, ['review-assessment', '--application-id', applicationId, '--decision', 'approved', '--decided-by', 'Cole']);
  run(home, ['profile', 'set-contact', '--name', 'Private Name', '--email', 'private@example.test', '--phone', '555-PRIVATE', '--work-authorization', 'Private authorization', '--source', 'operator', '--confidence', 'high']);
  run(home, ['profile', 'add-reference', '--name', 'Private Ref', '--contact', 'ref-private@example.test']);
  run(home, ['profile', 'set-eeo', '--disability', 'private-eeo-value']);
  const letter = run(home, ['draft-cover-letter', '--application-id', applicationId, '--content', 'A tailored letter']);
  const resume = run(home, ['draft-resume', '--application-id', applicationId, '--content', 'A tailored resume']);
  for (const snapshot of [letter.coverLetter.profile_snapshot, resume.resume.profile_snapshot]) {
    assert.equal(snapshot.includes('private@example.test'), false);
    assert.equal(snapshot.includes('555-PRIVATE'), false);
    assert.equal(snapshot.includes('Private authorization'), false);
    assert.equal(snapshot.includes('ref-private@example.test'), false);
    assert.equal(snapshot.includes('private-eeo-value'), false);
  }

  const first = run(home, ['build-package', '--application-id', applicationId]);
  const second = run(home, ['build-package', '--application-id', applicationId]);
  assert.notEqual(first.package.id, second.package.id);
  const exactPackages = run(home, ['show-package', '--application-id', applicationId, '--exact']).packages;
  const exactFirst = exactPackages.find((record) => record.id === first.package.id);
  const exactSecond = exactPackages.find((record) => record.id === second.package.id);
  assert.notEqual(exactFirst.attachment_path, exactSecond.attachment_path);
  for (const record of [exactFirst, exactSecond]) {
    assert.equal(record.content.includes('private@example.test'), false);
    assert.equal(record.content.includes('555-PRIVATE'), false);
    assert.equal(record.content.includes('Private authorization'), false);
    assert.match(record.content, /## Tailored Resume\nA tailored resume/);
    assert.ok(record.resume_id);
    assert.match(record.content_sha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(path.join(home, record.attachment_path)), true);
  }

  const unapproved = runFailure(home, ['build-package', '--application-id', applicationId, '--include-contact-fields', 'name,email']);
  assert.match(unapproved.stderr, /requires --approved-by/);
  const approved = run(home, ['build-package', '--application-id', applicationId, '--include-contact-fields', 'name,email', '--approved-by', 'Cole']);
  const exactApproved = run(home, ['show-package', '--application-id', applicationId, '--exact']).packages
    .find((record) => record.id === approved.package.id);
  assert.match(exactApproved.content, /Private Name/);
  assert.match(exactApproved.content, /private@example\.test/);
  assert.equal(exactApproved.content.includes('555-PRIVATE'), false);

  run(home, [
    'assess-application', '--application-id', applicationId,
    '--company-assessment', 'Updated company view', '--role-fit', 'Updated fit',
    '--risks', 'Updated risk', '--approach', 'Updated approach'
  ]);
  run(home, ['review-assessment', '--application-id', applicationId, '--decision', 'approved', '--decided-by', 'Cole']);
  run(home, ['draft-cover-letter', '--application-id', applicationId, '--content', 'New current letter']);
  const staleResume = runFailure(home, ['build-package', '--application-id', applicationId]);
  assert.match(staleResume.stderr, /Draft a new tailored resume from the current approved assessment/);
});

test('managed applications cannot bypass versioned review, selection, readiness, or package idempotency', () => {
  const home = makeHome('jobtrack-managed-package-');
  const prospect = run(home, [
    'add-prospect', '--company', 'ManagedCo', '--role', 'Platform Engineer',
    '--url', 'https://example.test/jobs/managed'
  ]);
  const applicationId = String(prospect.application.id);
  assert.equal(preparationMode(home, applicationId), 'managed');

  const posting = run(home, [
    'capture-posting', '--application-id', applicationId,
    '--source-url', 'https://example.test/jobs/managed', '--content', 'Managed platform role posting'
  ]);
  run(home, [
    'add-research', '--application-id', applicationId,
    '--source-url', 'https://example.test/about', '--citation', 'ManagedCo about page',
    '--content', 'ManagedCo builds reliable platform systems.'
  ]);
  const profile = run(home, [
    'profile', 'add', '--category', 'work', '--title', 'Relevant platform work',
    '--content', 'Built reliable platform systems.', '--source', 'operator'
  ]);
  run(home, [
    'assess-application', '--application-id', applicationId,
    '--company-assessment', 'Promising company', '--role-fit', 'Strong platform fit',
    '--risks', 'Review scope', '--approach', 'Tailor to reliability work'
  ]);
  run(home, [
    'review-assessment', '--application-id', applicationId, '--decision', 'approved',
    '--decided-by', 'Cole'
  ]);

  const legacyDraft = runFailure(home, [
    'draft-cover-letter', '--application-id', applicationId, '--content', 'Bypass attempt'
  ]);
  assert.match(legacyDraft.stderr, /Managed applications use application-material draft/);
  const forcedStage = runFailure(home, [
    'set-workflow-stage', '--application-id', applicationId, '--stage', 'package_ready'
  ]);
  assert.match(forcedStage.stderr, /derived from normalized preparation readiness/);

  const sourceFlags = [
    '--artifact-ids', String(posting.artifact.id),
    '--profile-entry-ids', String(profile.entry.id)
  ];
  const resume = finalizeManagedMaterial(home, applicationId, 'resume', 'Tailored resume', sourceFlags);
  const letter = finalizeManagedMaterial(home, applicationId, 'cover-letter', 'Tailored cover letter', sourceFlags);
  assert.notEqual(resume.finalRevisionId, letter.finalRevisionId);

  const beforeAcceptance = run(home, ['application-material', 'readiness', '--application-id', applicationId]);
  assert.equal(beforeAcceptance.ready, false);
  assert(beforeAcceptance.blockers.some((blocker) => blocker.code === 'FORM_COVERAGE_UNCERTAIN'));
  const prematurePackage = runFailure(home, [
    'build-package', '--application-id', applicationId,
    '--idempotency-key', 'managed-package-v1',
    '--expected-readiness-sha256', beforeAcceptance.readinessSha256
  ]);
  assert.match(prematurePackage.stderr, /not ready for packaging/i);

  run(home, [
    'application-material', 'accept-uncertainty', '--application-id', applicationId,
    '--accepted-by', 'Cole',
    '--reason', 'The application form is inaccessible; Cole will review it before manual submission.',
    '--expected-form-state-sha256', beforeAcceptance.form.stateSha256,
    '--idempotency-key', 'managed-form-uncertainty-v1'
  ]);
  const readiness = run(home, ['application-material', 'readiness', '--application-id', applicationId]);
  assert.equal(readiness.ready, true, JSON.stringify(readiness.blockers));
  assert.equal(JSON.stringify(readiness).includes('Tailored resume final'), false);
  assert.equal(JSON.stringify(readiness).includes('Tailored cover letter final'), false);
  const publicPackageSnapshot = run(home, [
    'application-material', 'package-snapshot', '--application-id', applicationId,
    '--expected-readiness-sha256', readiness.readinessSha256
  ]);
  assert.equal(JSON.stringify(publicPackageSnapshot).includes('Tailored resume final'), false);
  assert.equal(JSON.stringify(publicPackageSnapshot).includes('Tailored cover letter final'), false);

  const built = run(home, [
    'build-package', '--application-id', applicationId,
    '--idempotency-key', 'managed-package-v1',
    '--expected-readiness-sha256', readiness.readinessSha256
  ]);
  const replayed = run(home, [
    'build-package', '--application-id', applicationId,
    '--idempotency-key', 'managed-package-v1',
    '--expected-readiness-sha256', readiness.readinessSha256
  ]);
  assert.equal(built.replayed, false);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.package.id, built.package.id);
  const exactPackageView = run(home, ['show-package', '--application-id', applicationId, '--exact']);
  const exactBuilt = exactPackageView.packages.find((record) => record.id === built.package.id);
  const exactDocuments = exactPackageView.documentRenders
    .find((record) => record.applicationPackageId === built.package.id);
  assert.match(exactBuilt.content, /## Tailored Resume PDF/);
  assert.match(exactBuilt.content, /## Cover Letter PDF/);
  assert.match(exactBuilt.content, /PDF SHA-256/);
  assert.doesNotMatch(exactBuilt.content, /Tailored resume final|Tailored cover letter final/,
    'managed package manifest must not embed raw LaTeX source');
  assert.match(exactDocuments.resume.output_attachment_path, /attachments[\\/]material-renders/);
  assert.match(exactDocuments.coverLetter.output_attachment_path, /attachments[\\/]material-renders/);
  assert.equal(exactBuilt.content.includes('Built reliable platform systems.'), false, 'profile evidence must not be bulk-exported');
  assert.equal(fs.existsSync(path.join(home, exactBuilt.attachment_path)), true);

  const wrongSubmissionBinding = runFailure(home, [
    'application-material', 'record-submission', '--application-id', applicationId,
    '--package-id', String(built.package.id), '--submitted-by', 'Cole',
    '--expected-readiness-sha256', '0'.repeat(64),
    '--idempotency-key', 'managed-submission-wrong-v1'
  ]);
  assert.match(wrongSubmissionBinding.stderr, /Expected package readiness .* found/);

  // The gate chain reaches the carried bytes: a submission cannot be recorded
  // until the exact files that will be attached are verified against their
  // renders. Structural inspection is skipped here so no container runs in the
  // invariant suite; the digest leg is what this asserts.
  const unverifiedSubmission = runFailure(home, [
    'application-material', 'record-submission', '--application-id', applicationId,
    '--package-id', String(built.package.id), '--submitted-by', 'Cole',
    '--expected-readiness-sha256', readiness.readinessSha256,
    '--idempotency-key', 'managed-submission-unverified-v1'
  ]);
  assert.match(unverifiedSubmission.stderr, /never verified against their render/);

  const verified = run(home, [
    'application-material', 'verify-uploads', '--application-id', applicationId,
    '--resume-file', path.join(home, exactDocuments.resume.output_attachment_path),
    '--cover-letter-file', path.join(home, exactDocuments.coverLetter.output_attachment_path),
    '--verified-by', 'Cole', '--skip-structural-check',
    '--idempotency-key', 'managed-uploads-v1'
  ]);
  assert.equal(verified.allVerified, true, 'staged store bytes must verify against their renders');

  const submissionArgs = [
    'application-material', 'record-submission', '--application-id', applicationId,
    '--package-id', String(built.package.id), '--submitted-by', 'Cole',
    '--submitted-at', '2026-07-18T04:00:00Z',
    '--expected-readiness-sha256', readiness.readinessSha256,
    '--notes', 'Cole confirmed the external form submission completed.',
    '--idempotency-key', 'managed-submission-v1'
  ];
  const submitted = run(home, submissionArgs);
  const submittedReplay = run(home, submissionArgs);
  assert.equal(submittedReplay.submission.id, submitted.submission.id);
  assert.equal(submitted.package.package_status, 'submitted');
  assert.equal(submitted.application.workflow_stage, 'submitted');
  assert.equal(submitted.lifecycleEvent.event_kind, 'manual_submission_recorded');
  assert.equal(submitted.submission.readiness_sha256, readiness.readinessSha256);

  const duplicateSubmission = runFailure(home, [
    'application-material', 'record-submission', '--application-id', applicationId,
    '--package-id', String(built.package.id), '--submitted-by', 'Cole',
    '--expected-readiness-sha256', readiness.readinessSha256,
    '--idempotency-key', 'managed-submission-v2'
  ]);
  assert.match(duplicateSubmission.stderr, /already has manual submission event/);
});

test('partial summary updates preserve contact provenance and tags', () => {
  const home = makeHome('jobtrack-contact-');
  run(home, ['init']);
  run(home, ['profile', 'set-contact', '--name', 'Cole', '--source', 'operator interview', '--confidence', 'high', '--tags', 'verified,contact']);
  run(home, ['profile', 'set-summary', '--headline', 'Platform engineer']);
  const profile = run(home, ['profile', 'show']);
  assert.equal(profile.contact.source, 'operator interview');
  assert.equal(profile.contact.confidence, 'high');
  assert.deepEqual(profile.contact.tags, ['verified', 'contact']);
});

test('schema initialization is transactional and versioned', () => {
  const home = makeHome('jobtrack-schema-');
  run(home, ['init']);
  const db = new Database(path.join(home, 'jobtrack.db'), { readonly: true });
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  assert.equal(db.pragma('user_version', { simple: true }), 11);
  // REVIEWED REPIN (2026-09-02): R1 added the provenance-backed identity
  // registry and R3 adds immutable correlation policy revisions.
  assert.deepEqual(db.prepare('SELECT version, name FROM jobtrack_schema_migrations ORDER BY version').all(), [
    { version: 1, name: 'baseline_transactional_registry' },
    { version: 2026071701, name: 'first_class_story_library' },
    { version: 2026071702, name: 'opportunity_discovery_inbox' },
    { version: 2026071703, name: 'core_safety_hardening' },
    { version: 2026071704, name: 'story_revision_bound_use_audit' },
    { version: 2026071705, name: 'opportunity_state_and_run_guards' },
    { version: 2026071706, name: 'package_resume_binding' },
    { version: 2026071707, name: 'opportunity_observation_retrieval_provenance' },
    { version: 2026071708, name: 'normalized_job_catalog' },
    { version: 2026071710, name: 'versioned_interview_preparation' },
    { version: 2026071711, name: 'job_email_integration_foundation' },
    { version: 2026071712, name: 'trusted_discovery_proposal_import' },
    { version: 2026071713, name: 'reviewed_application_external_identifiers' },
    { version: 2026071714, name: 'normalized_profile_facets_and_information_gaps' },
    { version: 2026071715, name: 'application_form_reconnaissance' },
    { version: 2026071716, name: 'versioned_application_materials_and_readiness' },
    { version: 2026071717, name: 'exact_application_field_fulfillment' },
    { version: 2026071801, name: 'application_strategy_control_plane' },
    { version: 2026071802, name: 'recipient_aware_email_communication_style' },
    { version: 2026071803, name: 'latex_application_material_rendering' },
    { version: 2026071901, name: 'email_draft_reply_work_kind' },
    { version: 2026072001, name: 'email_send_receipt_correlation' },
    { version: 2026072801, name: 'profile_skill_relations' },
    { version: 2026072802, name: 'universal_uuid_identity' },
    { version: 2026072803, name: 'profile_presentation_controls' },
    { version: 2026072804, name: 'repo_graph' },
    { version: 2026072805, name: 'project_kinds_and_relations' },
    { version: 2026072806, name: 'mc_sync_mapping' },
    { version: 2026080101, name: 'provider_neutral_email_outgoing_core' },
    { version: 2026080102, name: 'provider_neutral_email_outgoing_authority_guards' },
    { version: 2026080501, name: 'story_facet_claims' },
    { version: 2026080502, name: 'story_gate_checks' },
    { version: 2026090201, name: 'email_correlation_registry' },
    { version: 2026090202, name: 'email_correlation_policy_revisions' },
    { version: 2026090203, name: 'email_clarifications' },
    { version: 2026090204, name: 'email_registry_operator_controls' },
    { version: 2026090205, name: 'reversible_application_external_identifiers' }
  ]);
  db.close();
});

test('CLI repairs private store permissions and keeps copied evidence owner-only', () => {
  const home = makeHome('jobtrack-permissions-');
  run(home, ['init']);
  fs.chmodSync(home, 0o755);
  fs.chmodSync(path.join(home, 'attachments'), 0o755);
  fs.chmodSync(path.join(home, 'jobtrack.db'), 0o644);

  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-evidence-'));
  const source = path.join(sourceRoot, 'resume.txt');
  fs.writeFileSync(source, 'Private resume evidence\n', { mode: 0o644 });
  const imported = run(home, ['profile', 'import-resume', '--file', source, '--source', 'test']);

  assert.equal(mode(home), 0o700);
  assert.equal(mode(path.join(home, 'attachments')), 0o700);
  assert.equal(mode(path.join(home, 'jobtrack.db')), 0o600);
  assert.equal(mode(path.join(home, imported.entry.attachment_path)), 0o600);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = path.join(home, `jobtrack.db${suffix}`);
    if (fs.existsSync(sidecar)) assert.equal(mode(sidecar), 0o600);
  }
  fs.rmSync(sourceRoot, { recursive: true, force: true });
});

test('copied evidence paths are collision-safe and never overwrite prior bytes', () => {
  const home = makeHome('jobtrack-attachment-collision-');
  run(home, ['init']);
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-evidence-a-'));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-evidence-b-'));
  const firstSource = path.join(firstRoot, 'evidence.txt');
  const secondSource = path.join(secondRoot, 'evidence.txt');
  fs.writeFileSync(firstSource, 'first immutable evidence\n');
  fs.writeFileSync(secondSource, 'second immutable evidence\n');

  const first = run(home, ['profile', 'import-resume', '--file', firstSource, '--source', 'test']);
  const second = run(home, ['profile', 'import-resume', '--file', secondSource, '--source', 'test']);
  assert.notEqual(first.entry.attachment_path, second.entry.attachment_path);
  assert.equal(fs.readFileSync(path.join(home, first.entry.attachment_path), 'utf8'), 'first immutable evidence\n');
  assert.equal(fs.readFileSync(path.join(home, second.entry.attachment_path), 'utf8'), 'second immutable evidence\n');
  assert.equal(mode(path.join(home, first.entry.attachment_path)), 0o600);
  assert.equal(mode(path.join(home, second.entry.attachment_path)), 0o600);

  fs.rmSync(firstRoot, { recursive: true, force: true });
  fs.rmSync(secondRoot, { recursive: true, force: true });
});

test('CLI validates command-scoped flags and values before any mutation or file copy', () => {
  const home = makeHome('jobtrack-cli-contract-');
  run(home, ['init']);

  const wrongScope = runFailure(home, [
    'add-prospect', '--company', 'ExampleCo', '--role', 'Engineer',
    '--url', 'https://example.test/jobs/contract', '--sensitivity', 'private'
  ]);
  assert.match(wrongScope.stderr, /Unknown flag\(s\) for add-prospect: --sensitivity/);

  const missingValue = runFailure(home, [
    'opportunity', 'ingest', '--source', 'manual', '--company',
    '--role', 'Engineer', '--url', 'https://example.test/jobs/missing-value'
  ]);
  assert.match(missingValue.stderr, /Missing value for --company/);

  const duplicate = runFailure(home, [
    'add-prospect', '--company', 'First', '--company', 'Second',
    '--role', 'Engineer', '--url', 'https://example.test/jobs/duplicate'
  ]);
  assert.match(duplicate.stderr, /Duplicate flag: --company/);

  const typo = runFailure(home, [
    'add-prospect', '--company', 'ExampleCo', '--role', 'Engineer',
    '--url', 'https://example.test/jobs/typo', '--sorce', 'agent'
  ]);
  assert.match(typo.stderr, /Unknown flag: --sorce/);

  const malformedId = runFailure(home, ['show', '1oops']);
  assert.match(malformedId.stderr, /Provide a valid application id/);

  const scanAliasWrongScope = runFailure(home, [
    'discovery', 'scan-start', '--source', 'manual', '--sensitivity', 'private'
  ]);
  assert.match(scanAliasWrongScope.stderr, /Unknown flag\(s\) for discovery scan-start: --sensitivity/);

  const proposalWrongScope = runFailure(home, [
    'discovery', 'proposal', 'list', '--sensitivity', 'private'
  ]);
  assert.match(proposalWrongScope.stderr, /Unknown flag\(s\) for discovery proposal list: --sensitivity/);
  assert.deepEqual(run(home, ['discovery', 'proposal', 'list']).proposals, []);

  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-invalid-copy-'));
  const source = path.join(sourceRoot, 'resume.txt');
  fs.writeFileSync(source, 'must not be copied\n');
  const invalidImport = runFailure(home, [
    'profile', 'import-resume', '--file', source, '--sensitivity', 'private'
  ]);
  assert.match(invalidImport.stderr, /Unknown flag\(s\) for profile import-resume: --sensitivity/);

  const semanticFailureAfterCopy = runFailure(home, [
    'profile', 'add', '--category', 'evidence', '--title', 'Rejected evidence',
    '--content', 'Claim without required traceability', '--file', source
  ]);
  assert.match(semanticFailureAfterCopy.stderr, /Provide --source or --confidence/i);

  const applications = run(home, ['search']).applications;
  assert.equal(applications.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(home, 'attachments')), []);
  const db = new Database(path.join(home, 'jobtrack.db'), { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM opportunities').get().count, 0);
  db.close();
  fs.rmSync(sourceRoot, { recursive: true, force: true });
});

test('CLI preserves supported aliases, boolean flags, and exact leading-dash values', () => {
  const home = makeHome('jobtrack-cli-supported-');
  const prospect = run(home, [
    'add-prospect', '--company', 'AliasCo', '--role', 'Engineer',
    '--job-url', 'https://example.test/jobs/alias'
  ]);
  assert.equal(prospect.application.job_url, 'https://example.test/jobs/alias');

  const work = run(home, [
    'profile', 'add-work', '--company', 'AliasCo', '--role', 'Engineer',
    '--start-date', '2025-01', '--present', '--source', 'operator',
    '--description=-built a strict parser'
  ]);
  assert.equal(work.entry.work.is_present, true);
  assert.equal(work.entry.work.description, '-built a strict parser');

  const explicitFalse = run(home, [
    'profile', 'add-work', '--company', 'PriorCo', '--role', 'Engineer',
    '--start-date', '2024-01', '--end-date', '2024-12', '--present=false',
    '--source', 'operator'
  ]);
  assert.equal(explicitFalse.entry.work.is_present, false);

  const duplicateJson = runFailure(home, ['search', '--json=false']);
  assert.match(duplicateJson.stderr, /Duplicate flag: --json/);

  const jsonEqualsError = runRaw(home, ['add-prospect', '--role', 'Engineer', '--url=https://example.test/jobs/json', '--json=true']);
  assert.notEqual(jsonEqualsError.status, 0);
  assert.equal(JSON.parse(jsonEqualsError.stderr).error.code, 'JOBTRACK_ERROR');
  const plainError = runRaw(home, ['add-prospect', '--role', 'Engineer', '--url=https://example.test/jobs/plain', '--json=false']);
  assert.notEqual(plainError.status, 0);
  assert.match(plainError.stderr, /^jobtrack:/);
});

function seedLegacyAssessedApplication(home) {
  const submitted = run(home, [
    'add-application', '--company', 'ExampleCo', '--role', 'Platform Engineer',
    '--status', 'applied', '--applied-date', '2026-07-01',
    '--job-url', 'https://example.test/jobs/1'
  ]);
  const applicationId = submitted.application.id;
  run(home, ['capture-posting', '--application-id', applicationId, '--source-url', 'https://example.test/jobs/1', '--content', 'Platform role posting']);
  run(home, ['add-research', '--application-id', applicationId, '--source-url', 'https://example.test/about', '--citation', 'ExampleCo about page', '--notes', 'Builds infrastructure']);
  run(home, [
    'assess-application', '--application-id', applicationId,
    '--company-assessment', 'Promising company', '--role-fit', 'Strong platform fit',
    '--risks', 'Unknown compensation', '--approach', 'Lead with platform delivery'
  ]);
  return String(applicationId);
}

function finalizeManagedMaterial(home, applicationId, kind, contentPrefix, sourceFlags) {
  const context = run(home, [
    'application-material', 'context', '--application-id', applicationId, '--kind', kind, ...sourceFlags
  ]).context;
  const roughSourceStateFlags = ['--expected-source-state-sha256', context.sourceStateSha256];
  const rough = run(home, [
    'application-material', 'draft', '--application-id', applicationId, '--kind', kind,
    '--content', `${contentPrefix} rough`, '--authored-by', 'test-generator',
    '--stage', 'rough-draft', '--expected-head-revision-id', 'none',
    ...sourceFlags, ...roughSourceStateFlags, '--idempotency-key', `${kind}-rough-v1`
  ]);
  const roughRevisionId = String(rough.revision.id);
  const finalContext = run(home, [
    'application-material', 'context', '--application-id', applicationId, '--kind', kind,
    '--parent-revision-id', roughRevisionId, ...sourceFlags
  ]).context;
  const finalSourceStateFlags = ['--expected-source-state-sha256', finalContext.sourceStateSha256];
  const final = run(home, [
    'application-material', 'draft', '--application-id', applicationId, '--kind', kind,
    '--content', `${contentPrefix} final`, '--authored-by', 'test-generator',
    '--stage', 'final-candidate', '--parent-revision-id', roughRevisionId,
    '--expected-head-revision-id', roughRevisionId,
    ...sourceFlags, ...finalSourceStateFlags, '--idempotency-key', `${kind}-final-v1`
  ]);
  const finalRevisionId = String(final.revision.id);
  const renderId = createSyntheticManagedRender(home, applicationId, Number(finalRevisionId), kind);
  run(home, [
    'application-material', 'review', '--application-id', applicationId,
    '--revision-id', finalRevisionId, '--render-id', String(renderId),
    '--decision', 'approved', '--reviewed-by', 'Cole',
    '--expected-review-id', 'none', '--idempotency-key', `${kind}-review-v1`
  ]);
  run(home, [
    'application-material', 'select', '--application-id', applicationId,
    '--revision-id', finalRevisionId, '--selected-by', 'Cole',
    '--expected-selected-revision-id', 'none', '--idempotency-key', `${kind}-select-v1`
  ]);
  return { roughRevisionId, finalRevisionId };
}

function createSyntheticManagedRender(home, applicationId, revisionId, kind) {
  const db = new Database(path.join(home, 'jobtrack.db'));
  try {
    db.pragma('foreign_keys = ON');
    const revision = db.prepare('SELECT * FROM application_material_revision_current_state WHERE id=?').get(revisionId);
    const application = db.prepare('SELECT company, role FROM applications WHERE id=?').get(Number(applicationId));
    const directory = path.join(home, 'attachments', 'material-renders', String(applicationId), String(revisionId));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const pdf = Buffer.from(`%PDF-1.4\n% ${kind} test render\n%%EOF\n`);
    const outputSha256 = crypto.createHash('sha256').update(pdf).digest('hex');
    const outputAttachmentPath = path.join(directory, `${outputSha256}.pdf`);
    fs.writeFileSync(outputAttachmentPath, pdf, { mode: 0o600 });
    const extractedText = [
      'Cole Example',
      `${application?.company || 'Example Co'} — ${application?.role || 'Engineer'}`,
      '',
      `Synthetic ${kind} extraction for revision ${revision.content_sha256}.`,
      'Deterministic body text that stands in for a rendered document during tests. '.repeat(6)
    ].join('\n');
    const extractedTextAttachmentPath = path.join(directory, `${outputSha256}.txt`);
    fs.writeFileSync(extractedTextAttachmentPath, extractedText, { mode: 0o600 });
    const renderId = createMaterialRender(db, {
      applicationId: Number(applicationId),
      revisionId,
      expectedContentSha256: revision.content_sha256,
      renderedBy: 'core-invariant-test-renderer',
      idempotencyKey: `core-render:${revisionId}`,
      renderResult: {
        rendererProfile: 'jobtrack-latex-pdf-v1',
        rendererImageDigest: `sha256:${'e'.repeat(64)}`,
        rendererVersion: 'core-test-renderer-v1',
        bundleSha256: 'f'.repeat(64),
        outputAttachmentPath,
        extractedTextAttachmentPath,
        outputSha256,
        outputBytes: pdf.length,
        pageCount: 1,
        extractedTextSha256: crypto.createHash('sha256').update(extractedText).digest('hex'),
        activeContentPolicy: 'jobtrack-pdf-active-content.v1',
        activeContentScanSha256: crypto.createHash('sha256')
          .update(`jobtrack-pdf-active-content.v1\n${outputSha256}\nclean\n`).digest('hex')
      }
    }).render.id;
    const { recordMaterialLintReport } = require('../lib/resume-lint');
    recordMaterialLintReport(db, {
      applicationId: Number(applicationId),
      renderId,
      lintedBy: 'core-invariant-test-lint',
      idempotencyKey: `core-lint:${renderId}`
    });
    return renderId;
  } finally {
    db.close();
  }
}

function preparationMode(home, applicationId) {
  const db = new Database(path.join(home, 'jobtrack.db'), { readonly: true });
  try {
    return db.prepare(`
      SELECT m.slug FROM application_preparation_plans p
      JOIN application_preparation_modes m ON m.id=p.mode_id
      WHERE p.application_id=?
    `).get(applicationId).slug;
  } finally {
    db.close();
  }
}

function run(home, args) {
  const stdout = execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home },
    encoding: 'utf8'
  });
  return JSON.parse(stdout);
}

function runFailure(home, args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0, `expected failure, got stdout: ${result.stdout}`);
  return result;
}

function runRaw(home, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home },
    encoding: 'utf8'
  });
}

function makeHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}
