'use strict';

const crypto = require('node:crypto');
const { isProtectedApplicationField } = require('./application-field-safety');

const APPLICATION_FORM_SCHEMA_VERSION = 2026071715;
const APPLICATION_FORM_MIGRATION_NAME = 'application_form_reconnaissance';
const APPLICATION_FORM_USER_VERSION = 10;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_STEPS = 100;
const MAX_FIELDS = 1000;
const MAX_OPTIONS = 5000;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTENT_ID = /^sha256:[a-f0-9]{64}$/;
const SECRET_KEY = /(?:csrf|xsrf|token|cookie|session|password|passwd|secret)/i;

const CAPTURE_METHODS = [
  ['provider-schema', 'Reviewed provider schema'],
  ['public-retrieval', 'Public retrieval'],
  ['human-observation', 'Human-observed form'],
  ['operator-report', 'Operator report']
];
const COVERAGE_STATES = [
  ['unknown', 'Unknown', 0],
  ['listing-only', 'Listing only', 0],
  ['entry-step-observed', 'Entry step observed', 0],
  ['partial', 'Partial', 0],
  ['blocked', 'Blocked before complete observation', 0],
  ['complete', 'Complete provider schema or all reachable pre-submit steps', 1]
];
const INPUT_KINDS = [
  ['short-text', 'Short text'], ['long-text', 'Long text'], ['email', 'Email'],
  ['phone', 'Phone'], ['url', 'URL'], ['number', 'Number'], ['date', 'Date'],
  ['boolean', 'Boolean'], ['single-choice', 'Single choice'], ['multi-choice', 'Multiple choice'],
  ['file-upload', 'File upload'], ['consent', 'Consent'], ['signature', 'Signature'],
  ['address-group', 'Address group'], ['repeater', 'Repeatable group'], ['unknown', 'Unknown']
];
const OBSERVATION_STATES = [
  ['observed-visible', 'Observed visible'],
  ['observed-conditional', 'Observed after a condition'],
  ['declared-unobserved', 'Declared but not observed']
];
const REVIEW_DECISIONS = [['approved', 'Approved'], ['rejected', 'Rejected']];
const BLOCKER_KINDS = new Set([
  'login-required', 'captcha', 'required-input', 'session-required', 'terms-restricted',
  'access-denied', 'rate-limited', 'unsupported-provider', 'unknown'
]);

class ApplicationFormError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ApplicationFormError';
    this.code = code;
    this.details = details;
  }
}

function migrateApplicationForm(db) {
  const existing = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?').get(APPLICATION_FORM_SCHEMA_VERSION);
  if (existing) {
    if (existing.name !== APPLICATION_FORM_MIGRATION_NAME) {
      throw new ApplicationFormError('MIGRATION_CONFLICT', `Migration ${APPLICATION_FORM_SCHEMA_VERSION} is already ${existing.name}`);
    }
    if (db.pragma('user_version', { simple: true }) < APPLICATION_FORM_USER_VERSION) db.pragma(`user_version = ${APPLICATION_FORM_USER_VERSION}`);
    ensureDependsOnFieldKeyColumn(db);
    return;
  }
  const nameConflict = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?').get(APPLICATION_FORM_MIGRATION_NAME);
  if (nameConflict) throw new ApplicationFormError('MIGRATION_CONFLICT', `${APPLICATION_FORM_MIGRATION_NAME} is already version ${nameConflict.version}`);
  for (const table of ['job_postings', 'opportunities', 'applications', 'information_requiredness_levels', 'information_sensitivity_levels', 'profile_information_fields']) {
    if (!tableExists(db, table)) throw new ApplicationFormError('MIGRATION_DEPENDENCY', `Missing required table: ${table}`);
  }

  db.transaction(() => {
    db.exec(`
      CREATE TABLE application_form_capture_methods (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE application_form_coverage_states (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
        is_complete INTEGER NOT NULL CHECK (is_complete IN (0,1))
      );
      CREATE TABLE application_form_input_kinds (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE application_form_observation_states (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );
      CREATE TABLE application_form_review_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
      );

      CREATE TABLE application_form_surfaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_posting_id INTEGER NOT NULL REFERENCES job_postings(id) ON DELETE RESTRICT,
        canonical_apply_url TEXT NOT NULL,
        provider_form_key TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(canonical_apply_url)<>''),
        CHECK (provider_form_key IS NULL OR (trim(provider_form_key)<>'' AND length(provider_form_key)<=500)),
        UNIQUE(job_posting_id,canonical_apply_url)
      );
      CREATE TABLE opportunity_application_form_surfaces (
        opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE RESTRICT,
        surface_id INTEGER NOT NULL REFERENCES application_form_surfaces(id) ON DELETE RESTRICT,
        linked_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(opportunity_id,surface_id), CHECK (trim(linked_by)<>'')
      );
      CREATE TABLE application_application_form_surfaces (
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
        surface_id INTEGER NOT NULL REFERENCES application_form_surfaces(id) ON DELETE RESTRICT,
        linked_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(application_id,surface_id), CHECK (trim(linked_by)<>'')
      );

      CREATE TABLE application_form_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        surface_id INTEGER NOT NULL REFERENCES application_form_surfaces(id) ON DELETE RESTRICT,
        bundle_id TEXT NOT NULL UNIQUE CHECK (length(bundle_id)=71 AND substr(bundle_id,1,7)='sha256:'),
        observation_sha256 TEXT NOT NULL CHECK (length(observation_sha256)=64),
        capture_method_id INTEGER NOT NULL REFERENCES application_form_capture_methods(id) ON DELETE RESTRICT,
        coverage_state_id INTEGER NOT NULL REFERENCES application_form_coverage_states(id) ON DELETE RESTRICT,
        blocker_kind TEXT,
        blocker_detail TEXT,
        source_url TEXT NOT NULL,
        evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256)=64),
        declared_step_count INTEGER CHECK (declared_step_count IS NULL OR declared_step_count>=0),
        known_unobserved_step_count INTEGER NOT NULL DEFAULT 0 CHECK (known_unobserved_step_count>=0),
        possible_unobserved_branches INTEGER NOT NULL DEFAULT 1 CHECK (possible_unobserved_branches IN (0,1)),
        pre_submit_boundary_observed INTEGER NOT NULL DEFAULT 0 CHECK (pre_submit_boundary_observed IN (0,1)),
        trust TEXT NOT NULL CHECK (trust='untrusted_external'),
        observed_at TEXT NOT NULL,
        imported_by TEXT NOT NULL,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (length(idempotency_key)<=300), CHECK (length(imported_by)<=200),
        CHECK (blocker_kind IS NULL OR blocker_kind IN ('login-required','captcha','required-input','session-required','terms-restricted','access-denied','rate-limited','unsupported-provider','unknown')),
        CHECK ((blocker_kind IS NULL AND blocker_detail IS NULL) OR blocker_kind IS NOT NULL),
        CHECK (blocker_detail IS NULL OR length(blocker_detail)<=2000),
        UNIQUE(surface_id,observation_sha256)
      );
      CREATE TABLE application_form_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        revision_id INTEGER NOT NULL REFERENCES application_form_revisions(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position>=1),
        provider_step_key TEXT,
        label TEXT,
        observation_state_id INTEGER NOT NULL REFERENCES application_form_observation_states(id) ON DELETE RESTRICT,
        CHECK (provider_step_key IS NULL OR length(provider_step_key)<=500),
        CHECK (label IS NULL OR length(label)<=2000),
        UNIQUE(revision_id,position)
      );
      CREATE TABLE application_form_field_identities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        surface_id INTEGER NOT NULL REFERENCES application_form_surfaces(id) ON DELETE RESTRICT,
        provider_field_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(provider_field_key)<>'' AND length(provider_field_key)<=500),
        UNIQUE(surface_id,provider_field_key)
      );
      CREATE TABLE application_form_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        revision_id INTEGER NOT NULL REFERENCES application_form_revisions(id) ON DELETE RESTRICT,
        step_id INTEGER NOT NULL REFERENCES application_form_steps(id) ON DELETE RESTRICT,
        field_identity_id INTEGER NOT NULL REFERENCES application_form_field_identities(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position>=1),
        provider_field_key TEXT NOT NULL,
        label TEXT NOT NULL,
        help_text TEXT,
        visibility_condition TEXT,
        input_kind_id INTEGER NOT NULL REFERENCES application_form_input_kinds(id) ON DELETE RESTRICT,
        requiredness_id INTEGER NOT NULL REFERENCES information_requiredness_levels(id) ON DELETE RESTRICT,
        sensitivity_level_id INTEGER NOT NULL REFERENCES information_sensitivity_levels(id) ON DELETE RESTRICT,
        profile_information_field_id INTEGER REFERENCES profile_information_fields(id) ON DELETE RESTRICT,
        observation_state_id INTEGER NOT NULL REFERENCES application_form_observation_states(id) ON DELETE RESTRICT,
        is_repeatable INTEGER NOT NULL DEFAULT 0 CHECK (is_repeatable IN (0,1)),
        constraints_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(constraints_json)),
        depends_on_field_key TEXT,
        CHECK (trim(label)<>'' AND length(label)<=5000),
        CHECK (trim(provider_field_key)<>'' AND length(provider_field_key)<=500),
        CHECK (help_text IS NULL OR length(help_text)<=20000),
        CHECK (visibility_condition IS NULL OR length(visibility_condition)<=10000),
        UNIQUE(step_id,position),
        UNIQUE(revision_id,field_identity_id)
      );
      CREATE TABLE application_form_field_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        field_id INTEGER NOT NULL REFERENCES application_form_fields(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position>=1),
        provider_option_key TEXT,
        label TEXT NOT NULL,
        CHECK (trim(label)<>'' AND length(label)<=2000),
        CHECK (provider_option_key IS NULL OR length(provider_option_key)<=500),
        UNIQUE(field_id,position)
      );

      CREATE TABLE application_form_revision_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        revision_id INTEGER NOT NULL REFERENCES application_form_revisions(id) ON DELETE RESTRICT,
        decision_id INTEGER NOT NULL REFERENCES application_form_review_decisions(id) ON DELETE RESTRICT,
        expected_review_id INTEGER REFERENCES application_form_revision_reviews(id) ON DELETE RESTRICT,
        reviewed_by TEXT NOT NULL,
        rationale TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64),
        idempotency_key TEXT NOT NULL UNIQUE,
        reviewed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(reviewed_by)<>'' AND length(reviewed_by)<=200),
        CHECK (trim(rationale)<>'' AND length(rationale)<=4000), CHECK (length(idempotency_key)<=300)
      );
      CREATE TABLE application_form_revision_selections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        surface_id INTEGER NOT NULL REFERENCES application_form_surfaces(id) ON DELETE RESTRICT,
        revision_id INTEGER NOT NULL REFERENCES application_form_revisions(id) ON DELETE RESTRICT,
        review_id INTEGER NOT NULL UNIQUE REFERENCES application_form_revision_reviews(id) ON DELETE RESTRICT,
        expected_revision_id INTEGER REFERENCES application_form_revisions(id) ON DELETE RESTRICT,
        selected_by TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64),
        idempotency_key TEXT NOT NULL UNIQUE,
        selected_at TEXT NOT NULL,
        CHECK (trim(selected_by)<>'' AND length(selected_by)<=200), CHECK (length(idempotency_key)<=300)
      );
      CREATE TABLE application_form_coverage_attestations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        revision_id INTEGER NOT NULL REFERENCES application_form_revisions(id) ON DELETE RESTRICT,
        attestation_kind TEXT NOT NULL CHECK (attestation_kind IN ('partial-confirmed','pre-submit-reviewed','provider-schema-confirmed','stale')),
        attested_by TEXT NOT NULL,
        rationale TEXT NOT NULL,
        expected_attestation_id INTEGER REFERENCES application_form_coverage_attestations(id) ON DELETE RESTRICT,
        request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64),
        idempotency_key TEXT NOT NULL UNIQUE,
        attested_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(attested_by)<>'' AND length(attested_by)<=200),
        CHECK (trim(rationale)<>'' AND length(rationale)<=4000), CHECK (length(idempotency_key)<=300)
      );

      CREATE INDEX idx_application_form_revisions_surface ON application_form_revisions(surface_id,observed_at DESC,id DESC);
      CREATE INDEX idx_application_form_fields_revision ON application_form_fields(revision_id,step_id,position);
      CREATE INDEX idx_application_form_field_identity_surface ON application_form_field_identities(surface_id,provider_field_key);
      CREATE INDEX idx_application_form_options_field ON application_form_field_options(field_id,position);
      CREATE VIEW application_form_field_constraint_values AS
      SELECT id AS field_id,revision_id,step_id,
        json_extract(constraints_json,'$.minLength') AS min_length,
        json_extract(constraints_json,'$.maxLength') AS max_length,
        json_extract(constraints_json,'$.minSelections') AS min_selections,
        json_extract(constraints_json,'$.maxSelections') AS max_selections,
        json_extract(constraints_json,'$.maxFileBytes') AS max_file_bytes,
        json_extract(constraints_json,'$.acceptedMimeTypes') AS accepted_mime_types_json,
        json_extract(constraints_json,'$.acceptedExtensions') AS accepted_extensions_json
      FROM application_form_fields;
    `);
    seed(db, 'application_form_capture_methods', ['slug', 'label'], CAPTURE_METHODS);
    seed(db, 'application_form_coverage_states', ['slug', 'label', 'is_complete'], COVERAGE_STATES);
    seed(db, 'application_form_input_kinds', ['slug', 'label'], INPUT_KINDS);
    seed(db, 'application_form_observation_states', ['slug', 'label'], OBSERVATION_STATES);
    seed(db, 'application_form_review_decisions', ['slug', 'label'], REVIEW_DECISIONS);
    createGuards(db);
    db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)').run(APPLICATION_FORM_SCHEMA_VERSION, APPLICATION_FORM_MIGRATION_NAME);
    if (db.pragma('user_version', { simple: true }) < APPLICATION_FORM_USER_VERSION) db.pragma(`user_version = ${APPLICATION_FORM_USER_VERSION}`);
  })();
}

function createGuards(db) {
  db.exec(`
    CREATE TRIGGER trg_opportunity_application_form_surface_scope
    BEFORE INSERT ON opportunity_application_form_surfaces
    WHEN NOT EXISTS (
      SELECT 1 FROM opportunities o JOIN application_form_surfaces s ON s.id=NEW.surface_id
      WHERE o.id=NEW.opportunity_id AND (
        o.primary_job_posting_id=s.job_posting_id OR EXISTS (
          SELECT 1 FROM opportunity_snapshots os WHERE os.opportunity_id=o.id AND os.job_posting_id=s.job_posting_id
        )
      )
    ) BEGIN SELECT RAISE(ABORT,'application form surface belongs to another opportunity posting'); END;
    CREATE TRIGGER trg_application_application_form_surface_scope
    BEFORE INSERT ON application_application_form_surfaces
    WHEN NOT EXISTS (
      SELECT 1 FROM applications a JOIN application_form_surfaces s ON s.id=NEW.surface_id
      LEFT JOIN application_postings ap ON ap.application_id=a.id AND ap.job_posting_id=s.job_posting_id
      WHERE a.id=NEW.application_id AND (a.primary_job_posting_id=s.job_posting_id OR ap.job_posting_id IS NOT NULL)
    ) BEGIN SELECT RAISE(ABORT,'application form surface belongs to another application posting'); END;
    CREATE TRIGGER trg_application_form_field_step_scope
    BEFORE INSERT ON application_form_fields
    WHEN NOT EXISTS (SELECT 1 FROM application_form_steps st WHERE st.id=NEW.step_id AND st.revision_id=NEW.revision_id)
    BEGIN SELECT RAISE(ABORT,'application form field step belongs to another revision'); END;
    CREATE TRIGGER trg_application_form_field_identity_scope
    BEFORE INSERT ON application_form_fields
    WHEN NOT EXISTS (
      SELECT 1 FROM application_form_revisions r
      JOIN application_form_field_identities i
        ON i.id=NEW.field_identity_id AND i.surface_id=r.surface_id
        AND i.provider_field_key=NEW.provider_field_key
      WHERE r.id=NEW.revision_id
    ) BEGIN SELECT RAISE(ABORT,'application form field identity belongs to another surface'); END;
    CREATE TRIGGER trg_application_form_review_expected
    BEFORE INSERT ON application_form_revision_reviews
    WHEN COALESCE(NEW.expected_review_id,0) <> COALESCE((
      SELECT max(prior.id) FROM application_form_revision_reviews prior WHERE prior.revision_id=NEW.revision_id
    ),0) BEGIN SELECT RAISE(ABORT,'stale application form review expectation'); END;
    CREATE TRIGGER trg_application_form_selection_scope
    BEFORE INSERT ON application_form_revision_selections
    WHEN COALESCE(NEW.expected_revision_id,0) <> COALESCE((
      SELECT prior.revision_id FROM application_form_revision_selections prior
      WHERE prior.surface_id=NEW.surface_id ORDER BY prior.id DESC LIMIT 1
    ),0) OR NOT EXISTS (
      SELECT 1 FROM application_form_revisions r
      JOIN application_form_revision_reviews rr ON rr.id=NEW.review_id AND rr.revision_id=r.id
      JOIN application_form_review_decisions d ON d.id=rr.decision_id
      WHERE r.id=NEW.revision_id AND r.surface_id=NEW.surface_id AND d.slug='approved'
        AND rr.id=(SELECT max(latest.id) FROM application_form_revision_reviews latest WHERE latest.revision_id=r.id)
    ) BEGIN SELECT RAISE(ABORT,'selected form revision is not approved for this surface'); END;
    CREATE TRIGGER trg_application_form_stale_attestation_terminal
    BEFORE INSERT ON application_form_coverage_attestations
    WHEN EXISTS (
      SELECT 1 FROM application_form_coverage_attestations prior
      WHERE prior.revision_id=NEW.revision_id AND prior.attestation_kind='stale'
    ) BEGIN SELECT RAISE(ABORT,'stale application form evidence requires a new revision'); END;
    CREATE TRIGGER trg_application_form_attestation_current_scope
    BEFORE INSERT ON application_form_coverage_attestations
    WHEN NOT EXISTS (
      SELECT 1 FROM application_form_revisions r
      JOIN application_form_revision_selections sel
        ON sel.revision_id=r.id AND sel.surface_id=r.surface_id
        AND sel.id=(SELECT max(current_sel.id) FROM application_form_revision_selections current_sel WHERE current_sel.surface_id=r.surface_id)
      JOIN application_form_revision_reviews review
        ON review.revision_id=r.id
        AND review.id=(SELECT max(current_review.id) FROM application_form_revision_reviews current_review WHERE current_review.revision_id=r.id)
      JOIN application_form_review_decisions decision ON decision.id=review.decision_id AND decision.slug='approved'
      WHERE r.id=NEW.revision_id
    ) BEGIN SELECT RAISE(ABORT,'coverage attestation requires the current approved form revision'); END;
    CREATE TRIGGER trg_application_form_attestation_expected
    BEFORE INSERT ON application_form_coverage_attestations
    WHEN COALESCE(NEW.expected_attestation_id,0) <> COALESCE((
      SELECT prior.id FROM application_form_coverage_attestations prior
      WHERE prior.revision_id=NEW.revision_id ORDER BY prior.id DESC LIMIT 1
    ),0) BEGIN SELECT RAISE(ABORT,'stale application form attestation expectation'); END;
  `);
  for (const table of [
    'application_form_surfaces', 'opportunity_application_form_surfaces', 'application_application_form_surfaces',
    'application_form_revisions', 'application_form_steps', 'application_form_field_identities', 'application_form_fields', 'application_form_field_options',
    'application_form_revision_reviews', 'application_form_revision_selections', 'application_form_coverage_attestations'
  ]) {
    db.exec(`
      CREATE TRIGGER trg_${table}_immutable_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'${table} is immutable'); END;
      CREATE TRIGGER trg_${table}_immutable_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'${table} is immutable'); END;
    `);
  }
}

function importApplicationFormObservation(db, raw, options = {}) {
  const bundle = parseAndValidateBundle(raw);
  const importedBy = bounded(options.importedBy, 'importedBy', 200);
  const idempotencyKey = bounded(options.idempotencyKey, 'idempotencyKey', 300);
  const intentSha = sha256(stableJson({ bundleId: bundle.bundleId, importedBy }));
  const existing = db.prepare('SELECT * FROM application_form_revisions WHERE idempotency_key=?').get(idempotencyKey);
  if (existing) {
    if (existing.intent_sha256 !== intentSha || existing.bundle_id !== bundle.bundleId) conflict('Import idempotency key was reused with different input');
    return { replayed: true, form: readApplicationFormSurface(db, { surfaceId: existing.surface_id }), revisionId: existing.id };
  }
  const result = db.transaction(() => {
    validateTarget(db, bundle.target);
    const url = safeApplyUrl(bundle.surface.applyUrl);
    let surface = db.prepare('SELECT * FROM application_form_surfaces WHERE job_posting_id=? AND canonical_apply_url=?').get(bundle.target.jobPostingId, url);
    if (!surface) {
      const info = db.prepare('INSERT INTO application_form_surfaces(job_posting_id,canonical_apply_url,provider_form_key) VALUES (?,?,?)')
        .run(bundle.target.jobPostingId, url, nullable(bundle.surface.providerFormKey));
      surface = db.prepare('SELECT * FROM application_form_surfaces WHERE id=?').get(Number(info.lastInsertRowid));
    } else if ((surface.provider_form_key || null) !== (bundle.surface.providerFormKey || null)) {
      throw new ApplicationFormError('SURFACE_CONFLICT', 'Provider form key conflicts with the existing posting surface');
    }
    linkTargets(db, surface.id, bundle.target, importedBy);
    const capture = vocab(db, 'application_form_capture_methods', bundle.observation.captureMethod, 'capture method');
    const coverage = vocab(db, 'application_form_coverage_states', bundle.observation.coverage.state, 'coverage state');
    validateCoverage(bundle.observation, coverage.slug);
    const revisionInfo = db.prepare(`
      INSERT INTO application_form_revisions(
        surface_id,bundle_id,observation_sha256,capture_method_id,coverage_state_id,blocker_kind,blocker_detail,
        source_url,evidence_sha256,declared_step_count,known_unobserved_step_count,possible_unobserved_branches,
        pre_submit_boundary_observed,trust,observed_at,imported_by,intent_sha256,idempotency_key
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      surface.id, bundle.bundleId, bundle.observation.observationSha256, capture.id, coverage.id,
      bundle.observation.coverage.blocker?.kind || null, bundle.observation.coverage.blocker?.detail || null,
      url, bundle.observation.evidenceSha256, bundle.observation.coverage.declaredStepCount,
      bundle.observation.coverage.knownUnobservedStepCount, Number(bundle.observation.coverage.possibleUnobservedBranches),
      Number(bundle.observation.coverage.preSubmitBoundaryObserved), bundle.trust, bundle.observation.observedAt,
      importedBy, intentSha, idempotencyKey
    );
    const revisionId = Number(revisionInfo.lastInsertRowid);
    insertStructure(db, surface.id, revisionId, bundle.observation.steps);
    return { surfaceId: surface.id, revisionId };
  })();
  return { replayed: false, ...result, form: readApplicationFormSurface(db, { surfaceId: result.surfaceId }) };
}

function reviewApplicationFormRevision(db, input) {
  const revisionId = positiveId(input.revisionId, 'revisionId');
  const revision = db.prepare('SELECT * FROM application_form_revisions WHERE id=?').get(revisionId);
  if (!revision) notFound(`Application form revision ${revisionId} not found`);
  const decision = vocab(db, 'application_form_review_decisions', input.decision, 'review decision');
  const reviewedBy = bounded(input.reviewedBy, 'reviewedBy', 200);
  const rationale = bounded(input.rationale, 'rationale', 4000);
  const expected = expectedId(input.expectedCurrentRevisionId, 'expectedCurrentRevisionId');
  const expectedReview = expectedId(input.expectedReviewId, 'expectedReviewId');
  const idempotencyKey = bounded(input.idempotencyKey, 'idempotencyKey', 300);
  const requestSha = sha256(stableJson({ revisionId, decision: decision.slug, reviewedBy, rationale, expected, expectedReview }));
  const replay = db.prepare('SELECT * FROM application_form_revision_reviews WHERE idempotency_key=?').get(idempotencyKey);
  if (replay) {
    if (replay.request_sha256 !== requestSha) conflict('Review idempotency key was reused with different input');
    return { replayed: true, form: readApplicationFormSurface(db, { surfaceId: revision.surface_id }) };
  }
  return db.transaction(() => {
    const current = currentSelection(db, revision.surface_id);
    if ((current?.revision_id || null) !== expected) stale(`Expected current revision ${expected || 'none'}, found ${current?.revision_id || 'none'}`);
    const currentReview = db.prepare('SELECT * FROM application_form_revision_reviews WHERE revision_id=? ORDER BY id DESC LIMIT 1').get(revisionId);
    if ((currentReview?.id || null) !== expectedReview) stale(`Expected form review ${expectedReview || 'none'}, found ${currentReview?.id || 'none'}`);
    const now = normalizedTimestamp(input.reviewedAt || new Date().toISOString(), 'reviewedAt');
    const info = db.prepare(`INSERT INTO application_form_revision_reviews
      (revision_id,decision_id,expected_review_id,reviewed_by,rationale,request_sha256,idempotency_key,reviewed_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(revisionId, decision.id, expectedReview, reviewedBy, rationale, requestSha, idempotencyKey, now);
    const reviewId = Number(info.lastInsertRowid);
    if (decision.slug === 'approved') {
      db.prepare(`INSERT INTO application_form_revision_selections
        (surface_id,revision_id,review_id,expected_revision_id,selected_by,request_sha256,idempotency_key,selected_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(revision.surface_id, revisionId, reviewId, expected, reviewedBy, requestSha, `selection:${idempotencyKey}`, now);
    }
    return { replayed: false, reviewId, form: readApplicationFormSurface(db, { surfaceId: revision.surface_id }) };
  })();
}

function attestApplicationFormCoverage(db, input) {
  const revisionId = positiveId(input.revisionId, 'revisionId');
  const revision = db.prepare('SELECT * FROM application_form_revisions WHERE id=?').get(revisionId);
  if (!revision) notFound(`Application form revision ${revisionId} not found`);
  const kind = oneOf(input.attestationKind, ['partial-confirmed', 'pre-submit-reviewed', 'provider-schema-confirmed', 'stale'], 'attestationKind');
  const by = bounded(input.attestedBy, 'attestedBy', 200);
  const rationale = bounded(input.rationale, 'rationale', 4000);
  const expected = expectedId(input.expectedAttestationId, 'expectedAttestationId');
  const key = bounded(input.idempotencyKey, 'idempotencyKey', 300);
  const requestSha = sha256(stableJson({ revisionId, kind, by, rationale, expected }));
  const replay = db.prepare('SELECT * FROM application_form_coverage_attestations WHERE idempotency_key=?').get(key);
  if (replay) {
    if (replay.request_sha256 !== requestSha) conflict('Coverage idempotency key was reused with different input');
    return { replayed: true, form: readApplicationFormSurface(db, { surfaceId: revision.surface_id }) };
  }
  return db.transaction(() => {
    const current = db.prepare('SELECT * FROM application_form_coverage_attestations WHERE revision_id=? ORDER BY id DESC LIMIT 1').get(revisionId);
    if ((current?.id || null) !== expected) stale(`Expected coverage attestation ${expected || 'none'}, found ${current?.id || 'none'}`);
    if (current?.attestation_kind === 'stale') {
      throw new ApplicationFormError('INVALID_ATTESTATION', 'A stale attestation is terminal for that form revision; import and review new evidence');
    }
    const selection = currentSelection(db, revision.surface_id);
    if (!selection || selection.revision_id !== revisionId) throw new ApplicationFormError('NOT_CURRENT', 'Coverage may be attested only for the selected approved revision');
    if (kind === 'pre-submit-reviewed' && !revision.pre_submit_boundary_observed) throw new ApplicationFormError('INVALID_ATTESTATION', 'Pre-submit review boundary was not observed');
    const capture = db.prepare('SELECT slug FROM application_form_capture_methods WHERE id=?').get(revision.capture_method_id);
    if (kind === 'provider-schema-confirmed' && capture.slug !== 'provider-schema') throw new ApplicationFormError('INVALID_ATTESTATION', 'Provider-schema confirmation requires a provider-schema capture');
    const now = normalizedTimestamp(input.attestedAt || new Date().toISOString(), 'attestedAt');
    const info = db.prepare(`INSERT INTO application_form_coverage_attestations
      (revision_id,attestation_kind,attested_by,rationale,expected_attestation_id,request_sha256,idempotency_key,attested_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(revisionId, kind, by, rationale, expected, requestSha, key, now);
    return { replayed: false, attestationId: Number(info.lastInsertRowid), form: readApplicationFormSurface(db, { surfaceId: revision.surface_id }) };
  })();
}

function readApplicationFormSurface(db, input) {
  const provided = ['surfaceId', 'postingId'].filter((key) => input[key] !== undefined && input[key] !== null && input[key] !== '');
  if (provided.length !== 1) throw new ApplicationFormError('INVALID_TARGET', 'Provide exactly one surfaceId or postingId');
  let surface;
  if (input.surfaceId) surface = db.prepare('SELECT * FROM application_form_surfaces WHERE id=?').get(positiveId(input.surfaceId, 'surfaceId'));
  else if (input.postingId) {
    const surfaces = db.prepare('SELECT * FROM application_form_surfaces WHERE job_posting_id=? ORDER BY id').all(positiveId(input.postingId, 'postingId'));
    if (surfaces.length > 1) throw new ApplicationFormError('AMBIGUOUS_TARGET', 'Posting has multiple application-form surfaces; select one by surfaceId');
    surface = surfaces[0];
  }
  if (!surface) notFound('Application form surface not found');
  const revisions = db.prepare(`
    SELECT r.*,cm.slug AS capture_method,cs.slug AS coverage_state,
      (SELECT count(*) FROM application_form_steps st WHERE st.revision_id=r.id) AS step_count,
      (SELECT count(*) FROM application_form_fields f WHERE f.revision_id=r.id) AS field_count
    FROM application_form_revisions r
    JOIN application_form_capture_methods cm ON cm.id=r.capture_method_id
    JOIN application_form_coverage_states cs ON cs.id=r.coverage_state_id
    WHERE r.surface_id=? ORDER BY datetime(r.observed_at) DESC,r.id DESC
  `).all(surface.id);
  const selection = currentSelection(db, surface.id);
  const currentRevision = selection ? readRevision(db, selection.revision_id) : null;
  return {
    surface,
    opportunityLinks: db.prepare('SELECT * FROM opportunity_application_form_surfaces WHERE surface_id=? ORDER BY opportunity_id').all(surface.id),
    applicationLinks: db.prepare('SELECT * FROM application_application_form_surfaces WHERE surface_id=? ORDER BY application_id').all(surface.id),
    revisions,
    selection: selection || null,
    currentRevision
  };
}

function readApplicationFormsForTarget(db, input) {
  const keys = ['applicationId', 'opportunityId', 'postingId'].filter((key) => input[key] !== undefined && input[key] !== null && input[key] !== '');
  if (keys.length !== 1) throw new ApplicationFormError('INVALID_TARGET', 'Provide exactly one applicationId, opportunityId, or postingId');
  let rows;
  if (keys[0] === 'postingId') rows = db.prepare('SELECT id FROM application_form_surfaces WHERE job_posting_id=? ORDER BY id').all(positiveId(input.postingId, 'postingId'));
  else if (keys[0] === 'opportunityId') rows = db.prepare('SELECT surface_id id FROM opportunity_application_form_surfaces WHERE opportunity_id=? ORDER BY surface_id').all(positiveId(input.opportunityId, 'opportunityId'));
  else {
    const applicationId = positiveId(input.applicationId, 'applicationId');
    rows = db.prepare(`
      SELECT DISTINCT s.id FROM application_form_surfaces s
      LEFT JOIN application_application_form_surfaces al ON al.surface_id=s.id AND al.application_id=@id
      LEFT JOIN applications a ON a.id=@id
      LEFT JOIN opportunity_application_form_surfaces ol ON ol.surface_id=s.id AND ol.opportunity_id=a.source_opportunity_id
      WHERE (al.application_id IS NOT NULL OR ol.opportunity_id IS NOT NULL)
        AND (a.primary_job_posting_id IS NULL OR s.job_posting_id=a.primary_job_posting_id)
      ORDER BY s.id
    `).all({ id: applicationId });
  }
  return rows.map((row) => readApplicationFormSurface(db, { surfaceId: row.id }));
}

function readRevision(db, revisionId) {
  const revision = db.prepare(`SELECT r.*,cm.slug capture_method,cs.slug coverage_state
    FROM application_form_revisions r JOIN application_form_capture_methods cm ON cm.id=r.capture_method_id
    JOIN application_form_coverage_states cs ON cs.id=r.coverage_state_id WHERE r.id=?`).get(revisionId);
  if (!revision) return null;
  const steps = db.prepare(`SELECT st.*,os.slug observation_state FROM application_form_steps st
    JOIN application_form_observation_states os ON os.id=st.observation_state_id WHERE st.revision_id=? ORDER BY st.position`).all(revisionId);
  for (const step of steps) {
    step.fields = db.prepare(`
      SELECT f.*,ik.slug input_kind,req.slug requiredness,sens.slug sensitivity,obs.slug observation_state,pif.slug information_field_slug
      FROM application_form_fields f JOIN application_form_input_kinds ik ON ik.id=f.input_kind_id
      JOIN information_requiredness_levels req ON req.id=f.requiredness_id
      JOIN information_sensitivity_levels sens ON sens.id=f.sensitivity_level_id
      JOIN application_form_observation_states obs ON obs.id=f.observation_state_id
      LEFT JOIN profile_information_fields pif ON pif.id=f.profile_information_field_id
      WHERE f.step_id=? ORDER BY f.position
    `).all(step.id);
    for (const field of step.fields) {
      field.constraints = JSON.parse(field.constraints_json);
      field.options = db.prepare('SELECT * FROM application_form_field_options WHERE field_id=? ORDER BY position').all(field.id);
    }
  }
  return {
    ...revision,
    steps,
    review: db.prepare(`SELECT rr.*,d.slug decision FROM application_form_revision_reviews rr
      JOIN application_form_review_decisions d ON d.id=rr.decision_id
      WHERE rr.revision_id=? ORDER BY rr.id DESC LIMIT 1`).get(revisionId) || null,
    coverageAttestations: db.prepare('SELECT * FROM application_form_coverage_attestations WHERE revision_id=? ORDER BY id').all(revisionId)
  };
}

function parseAndValidateBundle(raw) {
  let text;
  if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
  else if (typeof raw === 'string') text = raw;
  else text = JSON.stringify(raw);
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_BUNDLE_BYTES) throw new ApplicationFormError('BUNDLE_INVALID', 'Application-form bundle is empty or too large');
  let value;
  try { value = JSON.parse(text); } catch { throw new ApplicationFormError('BUNDLE_INVALID', 'Application-form bundle must be valid JSON'); }
  assertNoDuplicateJsonObjectKeys(text);
  rejectUnsafeKeys(value, 'bundle');
  exact(value, ['schemaVersion', 'kind', 'trust', 'bundleId', 'target', 'surface', 'observation'], 'bundle');
  if (value.schemaVersion !== 1 || value.kind !== 'application-form-observation-bundle' || value.trust !== 'untrusted_external') invalid('Invalid application-form bundle envelope');
  if (!CONTENT_ID.test(value.bundleId)) invalid('bundleId must be a sha256 content ID');
  exact(value.target, ['jobPostingId', 'opportunityId', 'applicationId'], 'target');
  value.target.jobPostingId = positiveId(value.target.jobPostingId, 'target.jobPostingId');
  value.target.opportunityId = nullableId(value.target.opportunityId, 'target.opportunityId');
  value.target.applicationId = nullableId(value.target.applicationId, 'target.applicationId');
  if (!value.target.opportunityId && !value.target.applicationId) invalid('Target requires an opportunityId or applicationId');
  exact(value.surface, ['applyUrl', 'providerFormKey'], 'surface');
  safeApplyUrl(value.surface.applyUrl);
  value.surface.providerFormKey = safeProviderKey(value.surface.providerFormKey, 'surface.providerFormKey');
  exact(value.observation, ['captureMethod', 'observedAt', 'evidenceSha256', 'observationSha256', 'coverage', 'steps'], 'observation');
  oneOf(value.observation.captureMethod, CAPTURE_METHODS.map((item) => item[0]), 'observation.captureMethod');
  value.observation.observedAt = normalizedTimestamp(value.observation.observedAt, 'observation.observedAt');
  hex(value.observation.evidenceSha256, 'observation.evidenceSha256');
  hex(value.observation.observationSha256, 'observation.observationSha256');
  validateCoverageObject(value.observation.coverage);
  if (!Array.isArray(value.observation.steps) || value.observation.steps.length > MAX_STEPS) invalid(`steps must have at most ${MAX_STEPS} items`);
  let fieldCount = 0;
  let optionCount = 0;
  const providerFieldKeys = new Set();
  value.observation.steps.forEach((step, index) => {
    exact(step, ['position', 'providerStepKey', 'label', 'observationState', 'fields'], `steps[${index}]`);
    if (step.position !== index + 1) invalid('Step positions must be contiguous and ordered');
    step.providerStepKey = safeProviderKey(step.providerStepKey, `steps[${index}].providerStepKey`);
    step.label = nullableBounded(step.label, `steps[${index}].label`, 2000);
    oneOf(step.observationState, OBSERVATION_STATES.map((item) => item[0]), `steps[${index}].observationState`);
    if (!Array.isArray(step.fields)) invalid(`steps[${index}].fields must be an array`);
    fieldCount += step.fields.length;
    if (fieldCount > MAX_FIELDS) invalid(`Bundle exceeds ${MAX_FIELDS} fields`);
    step.fields.forEach((field, fieldIndex) => {
      exactOptional(
        field,
        ['position', 'providerFieldKey', 'label', 'helpText', 'inputKind', 'requiredness', 'sensitivity', 'profileInformationField', 'observationState', 'isRepeatable', 'constraints', 'options'],
        ['visibilityCondition', 'dependsOnFieldKey'],
        'field'
      );
      if (field.position !== fieldIndex + 1) invalid('Field positions must be contiguous and ordered');
      field.providerFieldKey = safeProviderKey(field.providerFieldKey, 'providerFieldKey');
      if (!field.providerFieldKey) invalid('providerFieldKey is required for stable field identity');
      if (providerFieldKeys.has(field.providerFieldKey)) invalid(`Duplicate providerFieldKey in one form revision: ${field.providerFieldKey}`);
      providerFieldKeys.add(field.providerFieldKey);
      // Declared multi-part dependency: the ONLY legitimate inter-field edge.
      // Must name an EARLIER field in the same revision — order is observation
      // order, so an answer can only follow from something already asked.
      // Never introduce the key when absent: the canonical observation (and
      // its sha) must stay byte-identical for bundles that predate it.
      if (field.dependsOnFieldKey !== undefined && field.dependsOnFieldKey !== null) {
        field.dependsOnFieldKey = safeProviderKey(field.dependsOnFieldKey, 'dependsOnFieldKey');
        if (field.dependsOnFieldKey === field.providerFieldKey) invalid('dependsOnFieldKey cannot reference the field itself');
        if (!providerFieldKeys.has(field.dependsOnFieldKey)) invalid(`dependsOnFieldKey must reference an earlier field in this revision: ${field.dependsOnFieldKey}`);
      }
      field.label = bounded(field.label, 'field.label', 5000);
      field.helpText = nullableBounded(field.helpText, 'field.helpText', 20000);
      if (field.visibilityCondition !== undefined) {
        field.visibilityCondition = nullableBounded(field.visibilityCondition, 'field.visibilityCondition', 10000);
      }
      oneOf(field.inputKind, INPUT_KINDS.map((item) => item[0]), 'field.inputKind');
      oneOf(field.requiredness, ['unknown', 'required', 'preferred', 'optional', 'conditional'], 'field.requiredness');
      oneOf(field.sensitivity, ['standard', 'personal', 'sensitive', 'highly-sensitive'], 'field.sensitivity');
      field.profileInformationField = nullableBounded(field.profileInformationField, 'field.profileInformationField', 200);
      oneOf(field.observationState, OBSERVATION_STATES.map((item) => item[0]), 'field.observationState');
      if (field.sensitivity === 'standard' && isProtectedApplicationField(field)) {
        invalid('A protected-looking application field cannot declare standard sensitivity');
      }
      if (typeof field.isRepeatable !== 'boolean') invalid('field.isRepeatable must be boolean');
      field.constraints = validateConstraints(field.constraints);
      if (!Array.isArray(field.options)) invalid('field.options must be an array');
      optionCount += field.options.length;
      if (optionCount > MAX_OPTIONS) invalid(`Bundle exceeds ${MAX_OPTIONS} options`);
      field.options.forEach((option, optionIndex) => {
        exact(option, ['position', 'providerOptionKey', 'label'], 'option');
        if (option.position !== optionIndex + 1) invalid('Option positions must be contiguous and ordered');
        option.providerOptionKey = safeProviderKey(option.providerOptionKey, 'providerOptionKey');
        option.label = bounded(option.label, 'option.label', 2000);
      });
    });
  });
  validateCoverage(value.observation, value.observation.coverage.state);
  const observationContent = structuredClone(value.observation);
  delete observationContent.observationSha256;
  if (value.observation.observationSha256 !== sha256(stableJson(observationContent))) {
    invalid('observationSha256 does not match the canonical observation');
  }
  const claimed = value.bundleId;
  const content = structuredClone(value);
  delete content.bundleId;
  const expected = `sha256:${sha256(stableJson(content))}`;
  if (claimed !== expected) invalid('bundleId does not match canonical bundle content');
  return value;
}

function validateCoverageObject(value) {
  exact(value, ['state', 'declaredStepCount', 'knownUnobservedStepCount', 'possibleUnobservedBranches', 'preSubmitBoundaryObserved', 'blocker'], 'coverage');
  oneOf(value.state, COVERAGE_STATES.map((item) => item[0]), 'coverage.state');
  if (value.declaredStepCount !== null && (!Number.isSafeInteger(value.declaredStepCount) || value.declaredStepCount < 0 || value.declaredStepCount > MAX_STEPS)) invalid('coverage.declaredStepCount is invalid');
  if (!Number.isSafeInteger(value.knownUnobservedStepCount) || value.knownUnobservedStepCount < 0 || value.knownUnobservedStepCount > MAX_STEPS) invalid('coverage.knownUnobservedStepCount is invalid');
  if (typeof value.possibleUnobservedBranches !== 'boolean' || typeof value.preSubmitBoundaryObserved !== 'boolean') invalid('Coverage booleans are invalid');
  if (value.blocker !== null) {
    exact(value.blocker, ['kind', 'detail'], 'coverage.blocker');
    if (!BLOCKER_KINDS.has(value.blocker.kind)) invalid('Unknown coverage blocker kind');
    value.blocker.detail = nullableBounded(value.blocker.detail, 'coverage.blocker.detail', 2000);
  }
}

function validateCoverage(observation, state) {
  const c = observation.coverage;
  const observed = observation.steps.filter((step) => step.observationState !== 'declared-unobserved').length;
  const declaredUnobserved = observation.steps.length - observed;
  if (c.declaredStepCount !== null && c.declaredStepCount < observation.steps.length) invalid('Declared step count is smaller than captured steps');
  if (c.knownUnobservedStepCount < declaredUnobserved) invalid('Known unobserved count is smaller than declared-unobserved steps');
  if (state === 'listing-only' && observation.steps.length) invalid('listing-only coverage cannot contain form steps');
  if (state === 'entry-step-observed' && observed < 1) invalid('entry-step-observed requires an observed step');
  if (state === 'partial' && observed < 1) invalid('partial coverage requires an observed step');
  if (state === 'blocked' && !c.blocker) invalid('blocked coverage requires blocker metadata');
  if (state === 'complete') {
    const providerComplete = observation.captureMethod === 'provider-schema' && c.declaredStepCount === observation.steps.length;
    const traversedComplete = c.preSubmitBoundaryObserved;
    if ((!providerComplete && !traversedComplete) || c.blocker || c.knownUnobservedStepCount || c.possibleUnobservedBranches || declaredUnobserved) {
      invalid('Complete coverage requires complete provider evidence or an observed pre-submit boundary with no unknown remainder');
    }
  }
}

function insertStructure(db, surfaceId, revisionId, steps) {
  for (const step of steps) {
    const observationState = vocab(db, 'application_form_observation_states', step.observationState, 'observation state');
    const stepId = Number(db.prepare(`INSERT INTO application_form_steps
      (revision_id,position,provider_step_key,label,observation_state_id) VALUES (?,?,?,?,?)`)
      .run(revisionId, step.position, step.providerStepKey, step.label, observationState.id).lastInsertRowid);
    for (const field of step.fields) {
      db.prepare(`
        INSERT INTO application_form_field_identities(surface_id,provider_field_key)
        VALUES (?,?) ON CONFLICT(surface_id,provider_field_key) DO NOTHING
      `).run(surfaceId, field.providerFieldKey);
      const identity = db.prepare(`
        SELECT id FROM application_form_field_identities WHERE surface_id=? AND provider_field_key=?
      `).get(surfaceId, field.providerFieldKey);
      const input = vocab(db, 'application_form_input_kinds', field.inputKind, 'input kind');
      const req = vocab(db, 'information_requiredness_levels', field.requiredness, 'requiredness');
      const sensitivity = vocab(db, 'information_sensitivity_levels', field.sensitivity, 'sensitivity');
      const observed = vocab(db, 'application_form_observation_states', field.observationState, 'observation state');
      const infoField = field.profileInformationField
        ? db.prepare('SELECT id FROM profile_information_fields WHERE slug=?').get(field.profileInformationField)
        : null;
      if (field.profileInformationField && !infoField) invalid(`Unknown profile information field: ${field.profileInformationField}`);
      const fieldId = Number(db.prepare(`INSERT INTO application_form_fields(
        revision_id,step_id,field_identity_id,position,provider_field_key,label,help_text,visibility_condition,input_kind_id,requiredness_id,
        sensitivity_level_id,profile_information_field_id,observation_state_id,is_repeatable,constraints_json,depends_on_field_key
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        revisionId, stepId, identity.id, field.position, field.providerFieldKey, field.label, field.helpText,
        field.visibilityCondition ?? null, input.id, req.id,
        sensitivity.id, infoField?.id || null, observed.id, Number(field.isRepeatable), stableJson(field.constraints),
        field.dependsOnFieldKey ?? null
      ).lastInsertRowid);
      for (const option of field.options) db.prepare(`INSERT INTO application_form_field_options
        (field_id,position,provider_option_key,label) VALUES (?,?,?,?)`).run(fieldId, option.position, option.providerOptionKey, option.label);
    }
  }
}

function validateTarget(db, target) {
  if (!db.prepare('SELECT 1 FROM job_postings WHERE id=?').get(target.jobPostingId)) notFound(`Posting ${target.jobPostingId} not found`);
  if (target.opportunityId) {
    const ok = db.prepare(`SELECT 1 FROM opportunities o WHERE o.id=? AND (
      o.primary_job_posting_id=? OR EXISTS (SELECT 1 FROM opportunity_snapshots s WHERE s.opportunity_id=o.id AND s.job_posting_id=?))`)
      .get(target.opportunityId, target.jobPostingId, target.jobPostingId);
    if (!ok) throw new ApplicationFormError('TARGET_SCOPE_MISMATCH', 'Posting is not linked to the target opportunity');
  }
  if (target.applicationId) {
    const ok = db.prepare(`SELECT 1 FROM applications a LEFT JOIN application_postings ap
      ON ap.application_id=a.id AND ap.job_posting_id=? WHERE a.id=? AND (a.primary_job_posting_id=? OR ap.job_posting_id IS NOT NULL)`)
      .get(target.jobPostingId, target.applicationId, target.jobPostingId);
    if (!ok) throw new ApplicationFormError('TARGET_SCOPE_MISMATCH', 'Posting is not linked to the target application');
  }
  if (target.applicationId && target.opportunityId) {
    const app = db.prepare('SELECT source_opportunity_id FROM applications WHERE id=?').get(target.applicationId);
    if (app.source_opportunity_id && app.source_opportunity_id !== target.opportunityId) throw new ApplicationFormError('TARGET_SCOPE_MISMATCH', 'Application belongs to another source opportunity');
  }
}

function linkTargets(db, surfaceId, target, linkedBy) {
  if (target.opportunityId) db.prepare(`INSERT INTO opportunity_application_form_surfaces(opportunity_id,surface_id,linked_by)
    VALUES (?,?,?) ON CONFLICT(opportunity_id,surface_id) DO NOTHING`).run(target.opportunityId, surfaceId, linkedBy);
  if (target.applicationId) db.prepare(`INSERT INTO application_application_form_surfaces(application_id,surface_id,linked_by)
    VALUES (?,?,?) ON CONFLICT(application_id,surface_id) DO NOTHING`).run(target.applicationId, surfaceId, linkedBy);
}

function currentSelection(db, surfaceId) {
  return db.prepare('SELECT * FROM application_form_revision_selections WHERE surface_id=? ORDER BY id DESC LIMIT 1').get(surfaceId) || null;
}

function validateConstraints(value) {
  exact(value, ['minLength', 'maxLength', 'minSelections', 'maxSelections', 'maxFileBytes', 'acceptedMimeTypes', 'acceptedExtensions'], 'constraints');
  const result = {};
  for (const key of ['minLength', 'maxLength', 'minSelections', 'maxSelections', 'maxFileBytes']) {
    const item = value[key];
    if (item !== null && (!Number.isSafeInteger(item) || item < 0 || item > 1_000_000_000)) invalid(`constraints.${key} is invalid`);
    result[key] = item;
  }
  for (const key of ['acceptedMimeTypes', 'acceptedExtensions']) {
    if (!Array.isArray(value[key]) || value[key].length > 100) invalid(`constraints.${key} is invalid`);
    result[key] = [...new Set(value[key].map((item) => bounded(item, `constraints.${key}`, 200)))];
  }
  if (result.minLength !== null && result.maxLength !== null && result.minLength > result.maxLength) invalid('minLength exceeds maxLength');
  if (result.minSelections !== null && result.maxSelections !== null && result.minSelections > result.maxSelections) invalid('minSelections exceeds maxSelections');
  return result;
}

function safeApplyUrl(value) {
  const text = bounded(value, 'surface.applyUrl', 2048);
  let url;
  try { url = new URL(text); } catch { invalid('surface.applyUrl must be a valid URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) invalid('surface.applyUrl must be credential-free HTTPS without a fragment');
  if (url.search) invalid('surface.applyUrl must be a credential-free canonical HTTPS endpoint without query parameters');
  return url.toString();
}

function assertNoDuplicateJsonObjectKeys(text) {
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(text[index] || '')) index += 1;
  };
  const parseString = () => {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2;
        continue;
      }
      if (text[index] === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      index += 1;
    }
    invalid('Application-form bundle contains an unterminated JSON string');
  };
  const parseValue = () => {
    skipWhitespace();
    if (text[index] === '{') return parseObject();
    if (text[index] === '[') return parseArray();
    if (text[index] === '"') return parseString();
    while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
  };
  const parseObject = () => {
    index += 1;
    skipWhitespace();
    const keys = new Set();
    if (text[index] === '}') {
      index += 1;
      return;
    }
    while (index < text.length) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) invalid(`Application-form bundle contains duplicate JSON object key: ${key}`);
      keys.add(key);
      skipWhitespace();
      index += 1; // JSON.parse already established that this byte is a colon.
      parseValue();
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      index += 1; // JSON.parse already established that this byte is a comma.
    }
  };
  const parseArray = () => {
    index += 1;
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return;
    }
    while (index < text.length) {
      parseValue();
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      index += 1; // JSON.parse already established that this byte is a comma.
    }
  };
  parseValue();
}

function rejectUnsafeKeys(value, path) {
  if (Array.isArray(value)) return value.forEach((item, index) => rejectUnsafeKeys(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (['__proto__', 'prototype', 'constructor', 'value', 'token', 'cookie', 'action', 'rawDom', 'rawHtml', 'inputValue', 'defaultValue'].includes(key)) invalid(`${path}.${key} is forbidden`);
    rejectUnsafeKeys(value[key], `${path}.${key}`);
  }
}

function safeProviderKey(value, label) {
  const text = nullableBounded(value, label, 500);
  if (text && SECRET_KEY.test(text)) invalid(`${label} looks like a secret-bearing field and must not be captured`);
  return text;
}

function seed(db, table, columns, rows) {
  const insert = db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  for (const row of rows) insert.run(...row);
}

function vocab(db, table, slug, label) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE slug=?`).get(slug);
  if (!row) invalid(`Unknown ${label}: ${slug}`);
  return row;
}

function exact(value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${path} must be an object`);
  const expected = new Set(keys);
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extra = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length || extra.length) invalid(`${path} fields mismatch; missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`);
}

function exactOptional(value, requiredKeys, optionalKeys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${path} must be an object`);
  const expected = new Set([...requiredKeys, ...optionalKeys]);
  const missing = requiredKeys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extra = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length || extra.length) invalid(`${path} fields mismatch; missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function tableExists(db, table) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }

/** Additive column for declared multi-part field dependencies (2026-08-04).
 * Guarded ALTER so stores created before the column pick it up idempotently. */
function ensureDependsOnFieldKeyColumn(db) {
  if (!tableExists(db, 'application_form_fields')) return;
  const exists = db.prepare("SELECT 1 FROM pragma_table_info('application_form_fields') WHERE name='depends_on_field_key'").get();
  if (!exists) db.exec('ALTER TABLE application_form_fields ADD COLUMN depends_on_field_key TEXT');
}
function bounded(value, label, max) { if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${label} must be a non-empty string up to ${max} characters`); return value.trim(); }
function nullableBounded(value, label, max) { return value === null ? null : bounded(value, label, max); }
function nullable(value) { return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim(); }
function positiveId(value, label) { const id = Number(value); if (!Number.isSafeInteger(id) || id < 1) invalid(`${label} must be a positive integer`); return id; }
function nullableId(value, label) { return value === null ? null : positiveId(value, label); }
function expectedId(value, label) { if (value === 'none' || value === null) return null; if (value === undefined || value === '') invalid(`${label} is required; use none for no current value`); return positiveId(value, label); }
function oneOf(value, allowed, label) { if (!allowed.includes(value)) invalid(`${label} must be one of: ${allowed.join(', ')}`); return value; }
function hex(value, label) { if (typeof value !== 'string' || !SHA256.test(value)) invalid(`${label} must be a SHA-256 digest`); }
function normalizedTimestamp(value, label) {
  const text = bounded(value, label, 100);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(text);
  if (!match) invalid(`${label} must be an offset-bearing ISO-8601 timestamp`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(fraction.padEnd(3, '0'));
  const offsetHour = zone === 'Z' ? 0 : Number(offsetHourText);
  const offsetMinute = zone === 'Z' ? 0 : Number(offsetMinuteText);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, millisecond);
  const validCalendar = year >= 1 && month >= 1 && month <= 12 && day >= 1
    && calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day
    && hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 14 && offsetMinute <= 59 && (offsetHour < 14 || offsetMinute === 0);
  const parsed = new Date(text);
  if (!validCalendar || Number.isNaN(parsed.getTime())) invalid(`${label} must be a valid offset-bearing ISO-8601 timestamp`);
  return parsed.toISOString();
}
function invalid(message) { throw new ApplicationFormError('BUNDLE_INVALID', message); }
function conflict(message) { throw new ApplicationFormError('IDEMPOTENCY_CONFLICT', message); }
function stale(message) { throw new ApplicationFormError('STALE_CURRENT', message); }
function notFound(message) { throw new ApplicationFormError('NOT_FOUND', message); }

module.exports = {
  APPLICATION_FORM_MIGRATION_NAME,
  APPLICATION_FORM_SCHEMA_VERSION,
  APPLICATION_FORM_USER_VERSION,
  ApplicationFormError,
  attestApplicationFormCoverage,
  importApplicationFormObservation,
  migrateApplicationForm,
  parseAndValidateBundle,
  readApplicationFormSurface,
  readApplicationFormsForTarget,
  reviewApplicationFormRevision,
  stableJson
};
