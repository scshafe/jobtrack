'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  APPLICATION_FORM_SCHEMA_VERSION,
  parseAndValidateBundle,
  readApplicationFormsForTarget,
  stableJson
} = require('../lib/application-form');
const { runApplicationFormCommand } = require('../lib/application-form-command');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('posting-owned opportunity reconnaissance imports, replays, reviews, selects, and reads inert structure', (t) => {
  const home = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const opportunity = seedOpportunity(home, 'https://jobs.example.test/roles/platform');
  const postingId = opportunity.opportunity.primary_job_posting_id;
  const bundle = makeBundle({ postingId, opportunityId: opportunity.opportunityId });
  bundle.observation.steps[0].fields[0].visibilityCondition = 'shown when the applicant selects engineering';
  rehash(bundle);
  const file = writeBundle(home, 'form-1.json', bundle);

  const imported = form(home, 'import', { input: file, importedBy: 'fixture', idempotencyKey: 'form-import-1' });
  assert.equal(imported.replayed, false);
  assert.equal(imported.form.currentRevision, null, 'unreviewed observations are not current');
  assert.equal(form(home, 'import', { input: file, importedBy: 'fixture', idempotencyKey: 'form-import-1' }).replayed, true);

  const approved = form(home, 'review', {
    revisionId: imported.revisionId, decision: 'approved', reviewedBy: 'Cole', rationale: 'Public schema verified',
    expectedCurrentRevisionId: 'none', expectedReviewId: 'none', idempotencyKey: 'form-review-1'
  });
  assert.equal(approved.form.currentRevision.id, imported.revisionId);
  assert.equal(approved.form.currentRevision.steps[0].fields[0].label, 'Why are you interested?');
  assert.equal(approved.form.currentRevision.steps[0].fields[1].protected, true);
  assert.equal(approved.form.currentRevision.steps[0].fields[1].label, 'Protected application field');
  assert.equal(approved.form.currentRevision.steps[0].fields[1].optionCount, 2);
  const exactForm = form(home, 'show', { surfaceId: approved.form.surface.id, exact: true });
  assert.deepEqual(exactForm.currentRevision.steps[0].fields[1].options.map((row) => row.label), ['Yes', 'No']);
  assert.equal(approved.form.currentRevision.steps[0].fields[0].constraints.maxLength, 500);
  assert.equal(approved.form.currentRevision.steps[0].fields[0].visibility_condition, 'shown when the applicant selects engineering');

  const rejectedCorrection = form(home, 'review', {
    revisionId: imported.revisionId, decision: 'rejected', reviewedBy: 'Cole', rationale: 'Needs another evidence check',
    expectedCurrentRevisionId: imported.revisionId, expectedReviewId: approved.reviewId,
    idempotencyKey: 'form-review-1-correction'
  });
  assert.equal(rejectedCorrection.form.currentRevision.review.decision, 'rejected');
  const reviewGuardDb = new Database(path.join(home, 'jobtrack.db'));
  const surfaceId = rejectedCorrection.form.surface.id;
  assert.throws(() => reviewGuardDb.prepare(`
    INSERT INTO application_form_revision_selections(
      surface_id,revision_id,review_id,expected_revision_id,selected_by,request_sha256,idempotency_key,selected_at
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    surfaceId, imported.revisionId, approved.reviewId, imported.revisionId, 'attacker',
    'd'.repeat(64), 'old-review-selection', '2026-07-17T22:00:00.000Z'
  ), /selected form revision is not approved/);
  reviewGuardDb.close();
  const approvedCorrection = form(home, 'review', {
    revisionId: imported.revisionId, decision: 'approved', reviewedBy: 'Cole', rationale: 'Evidence rechecked',
    expectedCurrentRevisionId: imported.revisionId, expectedReviewId: rejectedCorrection.reviewId,
    idempotencyKey: 'form-review-1-corrected'
  });
  assert.equal(approvedCorrection.form.currentRevision.review.decision, 'approved');

  const listed = form(home, 'list', { opportunityId: opportunity.opportunityId });
  assert.equal(listed.forms.length, 1);
  assert.equal(listed.forms[0].surface.job_posting_id, postingId);
  const db = new Database(path.join(home, 'jobtrack.db'));
  assert.equal(db.pragma('user_version', { simple: true }), 11);
  assert.equal(db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?').get(APPLICATION_FORM_SCHEMA_VERSION).name, 'application_form_reconnaissance');
  assert.throws(() => db.prepare('UPDATE application_form_fields SET label=? WHERE id=1').run('tampered'), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM application_form_revisions WHERE id=1').run(), /immutable/);
  assert.equal(readApplicationFormsForTarget(db, { opportunityId: opportunity.opportunityId }).length, 1);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

test('cross-posting evidence, unsafe secrets, hostile keys, and unsupported completeness fail atomically', (t) => {
  const home = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const opportunity = seedOpportunity(home, 'https://jobs.example.test/roles/platform');
  const openingId = opportunity.opportunity.job_opening_id;
  const sibling = run(home, [
    'catalog', 'posting', 'create', '--opening-id', String(openingId), '--platform', 'other',
    '--venue-key', 'sibling.example', '--url', 'https://sibling.example.test/roles/platform'
  ]);
  const siblingBundle = makeBundle({ postingId: sibling.posting.id, opportunityId: opportunity.opportunityId });
  assert.throws(() => form(home, 'import', {
    input: writeBundle(home, 'sibling.json', siblingBundle), importedBy: 'fixture', idempotencyKey: 'sibling'
  }), /not linked to the target opportunity/i);

  const secretUrl = makeBundle({ postingId: opportunity.opportunity.primary_job_posting_id, opportunityId: opportunity.opportunityId });
  secretUrl.surface.applyUrl += '?session_token=secret';
  rehash(secretUrl);
  assert.throws(() => parseAndValidateBundle(secretUrl), /without query parameters/);

  for (const query of [
    'apiKey=secret', 'accessToken=secret', 'authCode=secret', 'SAMLResponse=secret',
    'ticket=secret', 'assertion=secret', 'credential=secret', 'otp=secret', 'jobId=public-looking'
  ]) {
    const camelCaseSecretUrl = makeBundle({ postingId: opportunity.opportunity.primary_job_posting_id, opportunityId: opportunity.opportunityId });
    camelCaseSecretUrl.surface.applyUrl += `?${query}`;
    rehash(camelCaseSecretUrl);
    assert.throws(() => parseAndValidateBundle(camelCaseSecretUrl), /without query parameters/);
  }

  const duplicateKeyBundle = makeBundle({ postingId: opportunity.opportunity.primary_job_posting_id, opportunityId: opportunity.opportunityId });
  const duplicateKeyJson = JSON.stringify(duplicateKeyBundle).replace(
    '"trust":"untrusted_external"',
    '"trust":"untrusted_external","trust":"untrusted_external"'
  );
  assert.throws(() => parseAndValidateBundle(duplicateKeyJson), /duplicate JSON object key: trust/);

  const hostile = makeBundle({ postingId: opportunity.opportunity.primary_job_posting_id, opportunityId: opportunity.opportunityId });
  hostile.observation.steps[0].fields[0].value = 'private answer';
  rehash(hostile);
  assert.throws(() => parseAndValidateBundle(hostile), /forbidden/);

  const tokenField = makeBundle({ postingId: opportunity.opportunity.primary_job_posting_id, opportunityId: opportunity.opportunityId });
  tokenField.observation.steps[0].fields[0].providerFieldKey = 'csrf_token';
  rehash(tokenField);
  assert.throws(() => parseAndValidateBundle(tokenField), /secret-bearing field/);

  const understatedSensitiveField = makeBundle({ postingId: opportunity.opportunity.primary_job_posting_id, opportunityId: opportunity.opportunityId });
  understatedSensitiveField.observation.steps[0].fields[0].providerFieldKey = 'passportNumber';
  understatedSensitiveField.observation.steps[0].fields[0].label = 'Passport number';
  understatedSensitiveField.observation.steps[0].fields[0].sensitivity = 'standard';
  rehash(understatedSensitiveField);
  assert.throws(() => parseAndValidateBundle(understatedSensitiveField), /cannot declare standard sensitivity/);

  const understatedTypedContact = makeBundle({ postingId: opportunity.opportunity.primary_job_posting_id, opportunityId: opportunity.opportunityId });
  understatedTypedContact.observation.steps[0].fields[0].providerFieldKey = 'contact';
  understatedTypedContact.observation.steps[0].fields[0].label = 'Contact';
  understatedTypedContact.observation.steps[0].fields[0].inputKind = 'email';
  understatedTypedContact.observation.steps[0].fields[0].sensitivity = 'standard';
  rehash(understatedTypedContact);
  assert.throws(() => parseAndValidateBundle(understatedTypedContact), /cannot declare standard sensitivity/);

  const duplicateStableIdentity = makeBundle({ postingId: opportunity.opportunity.primary_job_posting_id, opportunityId: opportunity.opportunityId });
  duplicateStableIdentity.observation.steps[0].fields[1].providerFieldKey = duplicateStableIdentity.observation.steps[0].fields[0].providerFieldKey;
  rehash(duplicateStableIdentity);
  assert.throws(() => parseAndValidateBundle(duplicateStableIdentity), /Duplicate providerFieldKey/);

  const falseComplete = makeBundle({ postingId: opportunity.opportunity.primary_job_posting_id, opportunityId: opportunity.opportunityId });
  falseComplete.observation.captureMethod = 'human-observation';
  falseComplete.observation.coverage.state = 'complete';
  falseComplete.observation.coverage.preSubmitBoundaryObserved = false;
  falseComplete.observation.coverage.possibleUnobservedBranches = true;
  rehash(falseComplete);
  assert.throws(() => parseAndValidateBundle(falseComplete), /Complete coverage requires/);

  const impossibleDate = makeBundle({
    postingId: opportunity.opportunity.primary_job_posting_id,
    opportunityId: opportunity.opportunityId,
    observedAt: '2026-02-30T12:00:00Z'
  });
  assert.throws(() => parseAndValidateBundle(impossibleDate), /valid offset-bearing ISO-8601/);
  const missingZone = makeBundle({
    postingId: opportunity.opportunity.primary_job_posting_id,
    opportunityId: opportunity.opportunityId,
    observedAt: '2026-07-17T12:00:00'
  });
  assert.throws(() => parseAndValidateBundle(missingZone), /offset-bearing ISO-8601/);

  const blockedWithoutReason = makeBundle({ postingId: opportunity.opportunity.primary_job_posting_id, opportunityId: opportunity.opportunityId });
  blockedWithoutReason.observation.coverage.state = 'blocked';
  blockedWithoutReason.observation.coverage.blocker = null;
  rehash(blockedWithoutReason);
  assert.throws(() => parseAndValidateBundle(blockedWithoutReason), /blocked coverage requires blocker metadata/);

  const db = new Database(path.join(home, 'jobtrack.db'), { readonly: true });
  assert.equal(db.prepare('SELECT count(*) count FROM application_form_revisions').get().count, 0);
  db.close();
});

test('partial hidden-step coverage stays explicit and review/attestation optimistic guards fail closed', (t) => {
  const home = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const opportunity = seedOpportunity(home, 'https://jobs.example.test/roles/platform');
  const postingId = opportunity.opportunity.primary_job_posting_id;
  const first = makeBundle({
    postingId,
    opportunityId: opportunity.opportunityId,
    coverage: {
      state: 'partial', declaredStepCount: 3, knownUnobservedStepCount: 2,
      possibleUnobservedBranches: true, preSubmitBoundaryObserved: false,
      blocker: { kind: 'required-input', detail: 'Human input is needed to reveal later steps.' }
    }
  });
  const imported = form(home, 'import', { input: writeBundle(home, 'partial.json', first), importedBy: 'fixture', idempotencyKey: 'partial-import' });
  assert.equal(imported.form.revisions[0].known_unobserved_step_count, 2);
  assert.equal(imported.form.revisions[0].possible_unobserved_branches, 1);
  form(home, 'review', {
    revisionId: imported.revisionId, decision: 'approved', reviewedBy: 'Cole', rationale: 'Partial capture is useful',
    expectedCurrentRevisionId: 'none', expectedReviewId: 'none', idempotencyKey: 'partial-review'
  });
  const attested = form(home, 'coverage-attest', {
    revisionId: imported.revisionId, attestationKind: 'partial-confirmed', attestedBy: 'Cole',
    rationale: 'Later steps remain unknown', expectedAttestationId: 'none', idempotencyKey: 'partial-attest'
  });
  assert.equal(attested.attestationId, 1);
  assert.equal(form(home, 'coverage-attest', {
    revisionId: imported.revisionId, attestationKind: 'partial-confirmed', attestedBy: 'Cole',
    rationale: 'Later steps remain unknown', expectedAttestationId: 'none', idempotencyKey: 'partial-attest'
  }).replayed, true);

  const staleGuardDb = new Database(path.join(home, 'jobtrack.db'));
  assert.throws(() => staleGuardDb.prepare(`
    INSERT INTO application_form_coverage_attestations(
      revision_id,attestation_kind,attested_by,rationale,expected_attestation_id,
      request_sha256,idempotency_key,attested_at
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    imported.revisionId, 'partial-confirmed', 'attacker', 'Stale expected state', null,
    'f'.repeat(64), 'direct-stale-expected', '2026-07-17T23:00:00.000Z'
  ), /stale application form attestation expectation/);
  staleGuardDb.close();

  const staleAttestation = form(home, 'coverage-attest', {
    revisionId: imported.revisionId, attestationKind: 'stale', attestedBy: 'Cole',
    rationale: 'Provider form changed', expectedAttestationId: attested.attestationId,
    idempotencyKey: 'partial-stale'
  });
  assert.throws(() => form(home, 'coverage-attest', {
    revisionId: imported.revisionId, attestationKind: 'partial-confirmed', attestedBy: 'Cole',
    rationale: 'Attempted revival without new evidence', expectedAttestationId: staleAttestation.attestationId,
    idempotencyKey: 'partial-revive'
  }), /stale attestation is terminal|new evidence/i);
  const guardDb = new Database(path.join(home, 'jobtrack.db'));
  assert.throws(() => guardDb.prepare(`
    INSERT INTO application_form_coverage_attestations(
      revision_id,attestation_kind,attested_by,rationale,expected_attestation_id,
      request_sha256,idempotency_key,attested_at
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    imported.revisionId, 'partial-confirmed', 'attacker', 'Direct revival', staleAttestation.attestationId,
    'a'.repeat(64), 'direct-stale-revival', '2026-07-18T01:00:00.000Z'
  ), /stale application form evidence requires a new revision/);
  guardDb.close();

  const second = makeBundle({ postingId, opportunityId: opportunity.opportunityId, observedAt: '2026-07-18T00:00:00.000Z' });
  second.observation.steps[0].fields[0].visibilityCondition = 'visible after route choice';
  rehash(second);
  const importedSecond = form(home, 'import', { input: writeBundle(home, 'form-2.json', second), importedBy: 'fixture', idempotencyKey: 'form-import-2' });
  const identityDb = new Database(path.join(home, 'jobtrack.db'), { readonly: true });
  const identities = identityDb.prepare(`
    SELECT f.provider_field_key,count(DISTINCT f.field_identity_id) AS identities,count(*) AS revisions
    FROM application_form_fields f WHERE f.revision_id IN (?,?)
    GROUP BY f.provider_field_key ORDER BY f.provider_field_key
  `).all(imported.revisionId, importedSecond.revisionId);
  assert(identities.every((row) => row.identities === 1 && row.revisions === 2));
  assert.equal(identityDb.prepare(`
    SELECT visibility_condition FROM application_form_fields
    WHERE revision_id=? AND provider_field_key='motivation'
  `).get(importedSecond.revisionId).visibility_condition, 'visible after route choice');
  identityDb.close();
  assert.throws(() => form(home, 'review', {
    revisionId: importedSecond.revisionId, decision: 'approved', reviewedBy: 'Cole', rationale: 'New schema',
    expectedCurrentRevisionId: 'none', expectedReviewId: 'none', idempotencyKey: 'form-review-2-stale'
  }), /Expected current revision none, found/);
  assert.throws(() => form(home, 'coverage-attest', {
    revisionId: importedSecond.revisionId, attestationKind: 'partial-confirmed', attestedBy: 'Cole',
    rationale: 'Not selected', expectedAttestationId: 'none', idempotencyKey: 'wrong-attestation'
  }), /selected approved revision/);
});

function makeHome() {
  return require('../test-support/migrated-store').createTestHome('jobtrack-form-');
}

function seedOpportunity(home, url) {
  return run(home, [
    'opportunity', 'ingest', '--source', 'manual', '--company', 'Example Co', '--role', 'Platform Engineer',
    '--url', url, '--description', 'Public role', '--idempotency-key', crypto.randomUUID()
  ]);
}

function makeBundle({ postingId, opportunityId, applicationId = null, coverage = null, observedAt = '2026-07-17T20:00:00.000Z' }) {
  const bundle = {
    schemaVersion: 1,
    kind: 'application-form-observation-bundle',
    trust: 'untrusted_external',
    bundleId: `sha256:${'0'.repeat(64)}`,
    target: { jobPostingId: postingId, opportunityId, applicationId },
    surface: { applyUrl: 'https://apply.example.test/jobs/platform/application', providerFormKey: 'platform-application' },
    observation: {
      captureMethod: 'provider-schema',
      observedAt,
      evidenceSha256: 'e'.repeat(64),
      observationSha256: '0'.repeat(64),
      coverage: coverage || {
        state: 'complete', declaredStepCount: 1, knownUnobservedStepCount: 0,
        possibleUnobservedBranches: false, preSubmitBoundaryObserved: false, blocker: null
      },
      steps: [{
        position: 1,
        providerStepKey: 'questions',
        label: 'Application questions',
        observationState: 'observed-visible',
        fields: [
          {
            position: 1, providerFieldKey: 'motivation', label: 'Why are you interested?',
            helpText: 'Keep your answer concise.', inputKind: 'long-text', requiredness: 'required',
            sensitivity: 'standard', profileInformationField: null, observationState: 'observed-visible',
            isRepeatable: false,
            constraints: { minLength: 20, maxLength: 500, minSelections: null, maxSelections: null, maxFileBytes: null, acceptedMimeTypes: [], acceptedExtensions: [] },
            options: []
          },
          {
            position: 2, providerFieldKey: 'authorization', label: 'Authorized to work?', helpText: null,
            inputKind: 'single-choice', requiredness: 'required', sensitivity: 'sensitive',
            profileInformationField: 'work-authorization', observationState: 'observed-visible', isRepeatable: false,
            constraints: { minLength: null, maxLength: null, minSelections: 1, maxSelections: 1, maxFileBytes: null, acceptedMimeTypes: [], acceptedExtensions: [] },
            options: [
              { position: 1, providerOptionKey: 'yes', label: 'Yes' },
              { position: 2, providerOptionKey: 'no', label: 'No' }
            ]
          }
        ]
      }]
    }
  };
  return rehash(bundle);
}

function rehash(bundle) {
  const observation = structuredClone(bundle.observation);
  delete observation.observationSha256;
  bundle.observation.observationSha256 = digest(stableJson(observation));
  const content = structuredClone(bundle);
  delete content.bundleId;
  bundle.bundleId = `sha256:${digest(stableJson(content))}`;
  return bundle;
}

function writeBundle(home, name, bundle) {
  const filename = path.join(home, name);
  fs.writeFileSync(filename, JSON.stringify(bundle), { mode: 0o600 });
  return filename;
}

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function run(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, ...(args.includes('--json') ? [] : ['--json'])], {
    cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8'
  }));
}

function fail(home, args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8'
  });
  assert.notEqual(result.status, 0, result.stdout);
  return result;
}

function form(home, action, flags) {
  const db = new Database(path.join(home, 'jobtrack.db'));
  try { return runApplicationFormCommand(db, [action], flags); } finally { db.close(); }
}
