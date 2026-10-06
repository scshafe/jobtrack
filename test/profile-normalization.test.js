'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  PROFILE_NORMALIZATION_SCHEMA_VERSION,
  migrateProfileNormalization
} = require('../lib/profile-normalization');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('copied v8 profile bytes normalize conservatively and replay without projection churn', () => {
  const db = makeV8ProfileDb();
  const before = legacyBytes(db);

  migrateProfileNormalization(db);
  const firstProjection = db.prepare(`
    SELECT profile_entry_id,tag_id,source,created_at FROM profile_entry_tags ORDER BY profile_entry_id,tag_id
  `).all();
  const firstProjectSkills = db.prepare('SELECT * FROM profile_project_skills ORDER BY profile_project_id,skill_id').all();
  const counts = normalizedCounts(db);
  migrateProfileNormalization(db);

  assert.equal(db.pragma('user_version', { simple: true }), 9);
  assert.deepEqual(legacyBytes(db), before, 'legacy strings and JSON bytes remain exact');
  assert.deepEqual(normalizedCounts(db), counts);
  assert.deepEqual(db.prepare('SELECT profile_entry_id,tag_id,source,created_at FROM profile_entry_tags ORDER BY profile_entry_id,tag_id').all(), firstProjection);
  assert.deepEqual(db.prepare('SELECT * FROM profile_project_skills ORDER BY profile_project_id,skill_id').all(), firstProjectSkills);
  assert.equal(db.prepare('SELECT count(*) count FROM jobtrack_schema_migrations WHERE version=?').get(PROFILE_NORMALIZATION_SCHEMA_VERSION).count, 1);
  assert.equal(db.prepare('SELECT count(*) count FROM profile_entries WHERE profile_section_type_id IS NOT NULL AND profile_confidence_level_id IS NOT NULL').get().count, 3);
  assert.equal(db.prepare('SELECT count(*) count FROM profile_work_entries WHERE organization_id IS NOT NULL AND company_id IS NOT NULL').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) count FROM profile_project_skills').get().count, 1, 'unknown stack terms are preserved but not guessed');
  assert.equal(db.prepare(`
    SELECT count(*) count FROM profile_contact_tags j JOIN tags t ON t.id=j.tag_id
    JOIN tag_namespaces n ON n.id=t.tag_namespace_id WHERE n.slug='profile-private'
  `).get().count, 1);
  assert.equal(db.prepare(`
    SELECT count(*) count FROM profile_contact_tags j JOIN tags t ON t.id=j.tag_id
    JOIN tag_namespaces n ON n.id=t.tag_namespace_id WHERE n.slug='general'
  `).get().count, 0);
  assert.equal(db.prepare('SELECT count(*) count FROM opportunity_tag_links').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) count FROM opening_tags').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) count FROM application_tags').get().count, 1);
  const native = db.prepare("SELECT id FROM profile_proficiency_levels WHERE slug='native'").get().id;
  assert.throws(
    () => db.prepare('INSERT INTO profile_skills(id,profile_entry_id,name,proficiency,profile_proficiency_level_id) VALUES (1,3,\'Wrong\',\'native\',?)').run(native),
    /invalid for skill/
  );
  const expert = db.prepare("SELECT id FROM profile_proficiency_levels WHERE slug='expert'").get().id;
  assert.throws(
    () => db.prepare('INSERT INTO profile_languages(id,profile_entry_id,language,proficiency,profile_proficiency_level_id) VALUES (1,3,\'German\',\'expert\',?)').run(expert),
    /invalid for language/
  );
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  db.close();
});

test('CLI information requests replay default timestamps and enforce optimistic, typed resolutions', (t) => {
  const home = require('../test-support/migrated-store').createTestHome('jobtrack-profile-gaps-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  run(home, ['add-prospect', '--company', 'Example', '--role', 'Engineer', '--url', 'https://example.test/job']);
  const sibling = run(home, [
    'catalog', 'posting', 'create', '--opening-id', '1', '--url', 'https://board.example.test/sibling',
    '--platform', 'other', '--venue-key', 'sibling-board'
  ]);
  const siblingPostingId = String(sibling.posting.id);
  const siblingScope = fail(home, [
    'profile', 'info-request', 'mark', '--application-id', '1', '--field', 'email', '--requiredness', 'required',
    '--raw-prompt', 'Email?', '--source', 'sibling-form', '--posting-id', siblingPostingId, '--idempotency-key', 'sibling-request'
  ]);
  assert.match(siblingScope.stderr, /Posting must be explicitly linked/);
  let scopeDb = new Database(path.join(home, 'jobtrack.db'));
  const emailField = scopeDb.prepare("SELECT id FROM profile_information_fields WHERE slug='email'").get().id;
  const required = scopeDb.prepare("SELECT id FROM information_requiredness_levels WHERE slug='required'").get().id;
  assert.throws(() => scopeDb.prepare(`
    INSERT INTO application_information_requests(
      application_id,information_field_id,requiredness_id,raw_prompt,source,job_posting_id,
      request_sha256,intent_sha256,idempotency_key,observed_at
    ) VALUES (1,?,?, 'Email?','direct-test',?, ?,?,'direct-sibling','2026-01-01T00:00:00.000Z')
  `).run(emailField, required, Number(siblingPostingId), 'a'.repeat(64), 'b'.repeat(64)), /evidence scope mismatch/);
  scopeDb.close();

  const markArgs = [
    'profile', 'info-request', 'mark', '--application-id', '1', '--field', 'work-authorization',
    '--requiredness', 'required', '--raw-prompt', 'Are you authorized?', '--source', 'application-form',
    '--posting-id', '1', '--idempotency-key', 'request-1'
  ];
  assert.equal(run(home, markArgs).replayed, false);
  assert.equal(run(home, markArgs).replayed, true, 'omitted server timestamp must not break request replay');

  const assessArgs = [
    'profile', 'info-request', 'assess', '--application-id', '1', '--request-id', '1',
    '--state', 'confirmed_missing', '--assessed-by', 'Cole', '--expected-assessment-id', 'none',
    '--rationale', 'No stored answer', '--idempotency-key', 'assessment-1'
  ];
  assert.equal(run(home, assessArgs).replayed, false);
  assert.equal(run(home, assessArgs).replayed, true, 'omitted server timestamp must not break assessment replay');
  const gap = run(home, ['profile', 'gaps', '--application-id', '1']);
  assert.equal(gap.summary.has_blocking_gap, 1);
  assert.equal(gap.summary.blocking_missing_count, 1);

  const stale = fail(home, [
    'profile', 'info-request', 'assess', '--application-id', '1', '--request-id', '1',
    '--state', 'needs_review', '--assessed-by', 'Cole', '--expected-assessment-id', 'none',
    '--idempotency-key', 'assessment-stale'
  ]);
  assert.match(stale.stderr, /Expected current assessment none, found 1/);

  run(home, ['profile', 'set-contact', '--work-authorization-type', 'authorized', '--source', 'Cole']);
  run(home, [
    'profile', 'info-request', 'mark', '--application-id', '1', '--field', 'work-authorization',
    '--requiredness', 'required', '--raw-prompt', 'Authorization again?', '--source', 'second-form',
    '--idempotency-key', 'request-2'
  ]);
  const resolved = run(home, [
    'profile', 'info-request', 'resolve', '--application-id', '1', '--request-id', '2',
    '--assessed-by', 'Cole', '--expected-assessment-id', 'none', '--idempotency-key', 'assessment-2'
  ]);
  assert.equal(resolved.request.resolution_kind, 'contact-field');
  assert.match(resolved.request.resolution_sha256, /^[a-f0-9]{64}$/);
  assert.equal(resolved.request.resolved_profile_entry_id, null);

  run(home, ['profile', 'add', '--category', 'work', '--title', 'Unrelated', '--content', 'Unrelated', '--source', 'Cole']);
  const unrelated = fail(home, [
    'profile', 'info-request', 'resolve', '--application-id', '1', '--request-id', '2', '--profile-entry-id', '1',
    '--assessed-by', 'Cole', '--expected-assessment-id', '2', '--idempotency-key', 'assessment-unrelated'
  ]);
  assert.match(unrelated.stderr, /must resolve from profile contact/);

  const invalidTypedContact = fail(home, ['profile', 'set-contact', '--work-authorization-type', 'probably', '--source', 'Cole']);
  assert.match(invalidTypedContact.stderr, /must be one of/);

  run(home, ['profile', 'set-contact', '--work-authorization-type', 'limited', '--source', 'Cole']);
  const effectiveGap = run(home, ['profile', 'gaps', '--application-id', '1']);
  assert.equal(effectiveGap.summary.confirmed_missing_count, 2, 'a stale available resolution is an effective gap');
  assert.equal(effectiveGap.summary.blocking_missing_count, 2, 'a stale required resolution blocks the application');
  assert.equal(effectiveGap.summary.needs_review_count, 1);
  assert.equal(effectiveGap.summary.stale_resolution_count, 1);
  const staleResolution = effectiveGap.requests.find((request) => request.id === 2);
  assert.equal(staleResolution.stored_assessment_state, 'available');
  assert.equal(staleResolution.assessment_state, 'needs_review');
  assert.equal(staleResolution.effective_assessment_state, 'needs_review');
  assert.equal(staleResolution.resolution_stale, true);
});

test('tag writes synchronize compatibility projections and enforce scope, lifecycle, and provenance', (t) => {
  const home = require('../test-support/migrated-store').createTestHome('jobtrack-profile-tags-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  run(home, ['profile', 'add', '--category', 'preference', '--title', 'Preferences', '--content', 'Stored', '--source', 'Cole', '--tags', 'remote']);
  run(home, ['tag', 'assign', '--profile-entry-id', '1', '--tag', 'founder-led', '--source', 'Cole', '--confidence', '0.9', '--evidence', 'manual review']);
  let db = new Database(path.join(home, 'jobtrack.db'), { readonly: true });
  assert.equal(db.prepare('SELECT tags FROM profile_entries WHERE id=1').get().tags, '["remote","founder-led"]');
  assert.deepEqual(db.prepare(`
    SELECT t.label,j.source,j.confidence,j.evidence FROM profile_entry_tags j JOIN tags t ON t.id=j.tag_id
    WHERE j.profile_entry_id=1 ORDER BY t.label
  `).all(), [
    { label: 'founder-led', source: 'Cole', confidence: 0.9, evidence: 'manual review' },
    { label: 'remote', source: 'legacy_projection', confidence: null, evidence: null }
  ]);
  db.close();

  run(home, ['tag', 'remove', '--profile-entry-id', '1', '--tag', 'remote']);
  run(home, ['profile', 'update', '--entry-id', '1', '--tags', 'hardware', '--source', 'Cole']);
  db = new Database(path.join(home, 'jobtrack.db'));
  assert.equal(db.prepare('SELECT tags FROM profile_entries WHERE id=1').get().tags, '["hardware"]');
  assert.deepEqual(db.prepare(`SELECT t.label FROM profile_entry_tags j JOIN tags t ON t.id=j.tag_id WHERE j.profile_entry_id=1 ORDER BY t.label`).all(), [{ label: 'hardware' }]);
  const tag = db.prepare("SELECT id FROM tags WHERE normalized_label='hardware'").get();
  const deprecated = db.prepare("SELECT id FROM tag_lifecycle_statuses WHERE slug='deprecated'").get();
  db.prepare('UPDATE tags SET status_id=? WHERE id=?').run(deprecated.id, tag.id);
  db.close();
  const listed = run(home, ['tag', 'list', '--profile-entry-id', '1']);
  assert.deepEqual(listed.tags, [], 'inactive terms are not exposed as facets');
  const assignDeprecated = fail(home, ['tag', 'assign', '--profile-entry-id', '1', '--tag', 'hardware', '--source', 'Cole']);
  assert.match(assignDeprecated.stderr, /deprecated/);

  run(home, ['profile', 'set-contact', '--name', 'Private', '--source', 'Cole', '--tags', 'private-trait']);
  db = new Database(path.join(home, 'jobtrack.db'), { readonly: true });
  assert.equal(db.prepare(`
    SELECT n.slug FROM profile_contact_tags j JOIN tags t ON t.id=j.tag_id
    JOIN tag_namespaces n ON n.id=t.tag_namespace_id
  `).get().slug, 'profile-private');
  db.close();
});

function makeV8ProfileDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(`
    CREATE TABLE jobtrack_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,applied_at TEXT);
    INSERT INTO jobtrack_schema_migrations VALUES(2026071708,'normalized_job_catalog','2026-01-01');
    PRAGMA user_version=8;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,canonical_name TEXT,normalized_name TEXT UNIQUE);
    CREATE TABLE company_aliases(id INTEGER PRIMARY KEY,company_id INTEGER,alias TEXT,normalized_alias TEXT UNIQUE);
    CREATE TABLE job_openings(id INTEGER PRIMARY KEY,company_id INTEGER,canonical_title TEXT);
    CREATE TABLE job_postings(id INTEGER PRIMARY KEY,job_opening_id INTEGER);
    CREATE TABLE applications(id INTEGER PRIMARY KEY,job_opening_id INTEGER,primary_job_posting_id INTEGER,source_opportunity_id INTEGER);
    CREATE TABLE application_postings(application_id INTEGER,job_posting_id INTEGER,PRIMARY KEY(application_id,job_posting_id));
    CREATE TABLE opportunities(id INTEGER PRIMARY KEY,job_opening_id INTEGER,primary_job_posting_id INTEGER);
    CREATE TABLE opportunity_snapshots(id INTEGER PRIMARY KEY,opportunity_id INTEGER,job_posting_id INTEGER);
    CREATE TABLE opportunity_tags(opportunity_id INTEGER,tag TEXT COLLATE NOCASE,tag_source TEXT,created_at TEXT,PRIMARY KEY(opportunity_id,tag));
    CREATE TABLE discovery_import_proposals(id INTEGER PRIMARY KEY,proposal_id TEXT UNIQUE);
    CREATE TABLE skill_categories(id INTEGER PRIMARY KEY,slug TEXT);
    CREATE TABLE skills(id INTEGER PRIMARY KEY,skill_category_id INTEGER,slug TEXT,canonical_name TEXT,normalized_name TEXT UNIQUE);
    CREATE TABLE skill_aliases(id INTEGER PRIMARY KEY,skill_id INTEGER,alias TEXT,normalized_alias TEXT UNIQUE);
    CREATE TABLE profile_entries(id INTEGER PRIMARY KEY,category TEXT,title TEXT,content TEXT,source TEXT,source_url TEXT,evidence TEXT,attachment_path TEXT,recency TEXT,confidence TEXT,tags TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE profile_contact(id INTEGER PRIMARY KEY,name TEXT,email TEXT,phone TEXT,location TEXT,work_authorization TEXT,visa_sponsorship TEXT,relocation_willingness TEXT,remote_preference TEXT,compensation_expectations TEXT,notice_period TEXT,earliest_start_date TEXT,headline TEXT,professional_summary TEXT,confidence TEXT,tags TEXT);
    CREATE TABLE profile_references(id INTEGER PRIMARY KEY,name TEXT,company TEXT,confidence TEXT,tags TEXT);
    CREATE TABLE profile_work_entries(id INTEGER PRIMARY KEY,profile_entry_id INTEGER,company TEXT);
    CREATE TABLE profile_education_entries(id INTEGER PRIMARY KEY,profile_entry_id INTEGER,institution TEXT);
    CREATE TABLE profile_skills(id INTEGER PRIMARY KEY,profile_entry_id INTEGER,name TEXT,proficiency TEXT);
    CREATE TABLE profile_languages(id INTEGER PRIMARY KEY,profile_entry_id INTEGER,language TEXT,proficiency TEXT);
    CREATE TABLE profile_links(id INTEGER PRIMARY KEY,profile_entry_id INTEGER,kind TEXT,label TEXT,url TEXT,username TEXT);
    CREATE TABLE profile_credentials(id INTEGER PRIMARY KEY,profile_entry_id INTEGER,kind TEXT,issuer TEXT);
    CREATE TABLE profile_recognitions(id INTEGER PRIMARY KEY,profile_entry_id INTEGER,kind TEXT,issuer TEXT);
    CREATE TABLE profile_publications(id INTEGER PRIMARY KEY,profile_entry_id INTEGER,kind TEXT,publisher TEXT);
    CREATE TABLE profile_volunteer_entries(id INTEGER PRIMARY KEY,profile_entry_id INTEGER,organization TEXT);
    CREATE TABLE profile_answers(id INTEGER PRIMARY KEY,profile_entry_id INTEGER,answer_category TEXT);
    CREATE TABLE profile_projects(id INTEGER PRIMARY KEY,profile_entry_id INTEGER,stack TEXT);
    CREATE TABLE profile_eeo(id INTEGER PRIMARY KEY,confidence TEXT,tags TEXT);
    INSERT INTO companies VALUES(1,'Case Mark','case mark');
    INSERT INTO job_openings VALUES(1,1,'Engineer');
    INSERT INTO opportunities VALUES(1,1,NULL);
    INSERT INTO applications VALUES(1,1,NULL,1);
    INSERT INTO opportunity_tags VALUES(1,'fast-growth','operator','2026-01-01');
    INSERT INTO skills VALUES(1,NULL,'rust','Rust','rust');
    INSERT INTO profile_entries VALUES(1,'work','Engineer','bytes','resume',NULL,NULL,NULL,NULL,'high','["Remote","ML"]','2026-01-01','2026-01-01');
    INSERT INTO profile_entries VALUES(2,'project','Agent','project bytes','resume',NULL,NULL,NULL,NULL,'medium','[]','2026-01-01','2026-01-01');
    INSERT INTO profile_entries VALUES(3,'skill','Orphan skill','orphan bytes','resume',NULL,NULL,NULL,NULL,'low','[]','2026-01-01','2026-01-01');
    INSERT INTO profile_work_entries VALUES(1,1,'Case Mark');
    INSERT INTO profile_projects VALUES(1,2,'["Rust","Unknown"]');
    INSERT INTO profile_contact VALUES(1,'Cole',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'high','["private-trait"]');
  `);
  return db;
}

function legacyBytes(db) {
  return {
    entries: db.prepare('SELECT id,category,title,content,confidence,tags FROM profile_entries ORDER BY id').all(),
    contact: db.prepare('SELECT id,name,confidence,tags FROM profile_contact').all(),
    work: db.prepare('SELECT id,profile_entry_id,company FROM profile_work_entries').all(),
    projects: db.prepare('SELECT id,profile_entry_id,stack FROM profile_projects').all(),
    opportunityTags: db.prepare('SELECT * FROM opportunity_tags ORDER BY opportunity_id,tag').all()
  };
}

function normalizedCounts(db) {
  return Object.fromEntries([
    'organizations', 'organization_aliases', 'tags', 'profile_entry_tags', 'profile_contact_tags',
    'opportunity_tag_links', 'opening_tags', 'application_tags', 'profile_project_skills'
  ].map((table) => [table, db.prepare(`SELECT count(*) count FROM ${table}`).get().count]));
}

function run(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8'
  }));
}

function fail(home, args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8'
  });
  assert.notEqual(result.status, 0, `expected failure: ${args.join(' ')}`);
  return result;
}

test('voluntary self-identification fields seed with protected-class sensitivity and safety classification', () => {
  const db = makeV8ProfileDb();
  migrateProfileNormalization(db);
  const rows = db.prepare(`
    SELECT f.slug, s.slug AS sensitivity, v.slug AS value_kind, f.profile_source_kind, f.profile_source_key
    FROM profile_information_fields f
    JOIN information_sensitivity_levels s ON s.id=f.sensitivity_level_id
    JOIN information_value_kinds v ON v.id=f.value_kind_id
    WHERE f.slug IN ('english-fluency','gender','pronouns','race-ethnicity','veteran-status','disability-status')
    ORDER BY f.slug
  `).all();
  assert.equal(rows.length, 6, 'all six self-identification fields seeded');
  const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]));
  for (const slug of ['gender', 'race-ethnicity', 'veteran-status', 'disability-status']) {
    assert.equal(bySlug[slug].sensitivity, 'highly-sensitive', `${slug} is highly-sensitive`);
    assert.equal(bySlug[slug].profile_source_key, 'eeo', `${slug} sources from the eeo record`);
  }
  assert.equal(bySlug['english-fluency'].profile_source_key, 'languages');

  // The application-field safety pattern must classify the protected-class
  // questions as protected regardless of a form's own claimed sensitivity.
  const { PROTECTED_APPLICATION_FIELD_PATTERN } = require('../lib/application-field-safety');
  for (const label of [
    'What is your race or ethnicity?',
    'Do you identify as one or more classifications of protected veteran?',
    'Gender identity',
    'Disability status',
    'Pronouns'
  ]) {
    assert.match(label, PROTECTED_APPLICATION_FIELD_PATTERN, `protected: ${label}`);
  }
  // Fluency is a bona fide qualification question — NOT protected-class.
  assert.doesNotMatch('Are you fluent in English?', PROTECTED_APPLICATION_FIELD_PATTERN);
});
