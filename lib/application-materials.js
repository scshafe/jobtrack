'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isProtectedApplicationField } = require('./application-field-safety');
const { assertUploadsVerified } = require('./upload-verification');
// resume-lint requires nothing from this module at load time (its path helper
// pull is lazy), so this top-level import is cycle-safe.
const { assertRenderLintPassed, latestRenderLintSummary } = require('./resume-lint');
const { listMaterialMasters } = require('./profile-material-masters');
const { listCitableWorkDetails } = require('./profile-work-details');
const { readEffectiveApplicationInformationRequests } = require('./profile-normalization');
// The submission lane digests intents with the same canonical-JSON digest the
// email lane uses; record-submission recomputes it to prove a settled attempt
// covered THIS package's bytes. Leaf module, cycle-safe.
const { digestCanonicalJson } = require('./email-outgoing-v2-contracts');

const APPLICATION_MATERIALS_SCHEMA_VERSION = 2026071716;
const APPLICATION_MATERIALS_MIGRATION_NAME = 'versioned_application_materials_and_readiness';
const APPLICATION_FIELD_FULFILLMENT_SCHEMA_VERSION = 2026071717;
const APPLICATION_FIELD_FULFILLMENT_MIGRATION_NAME = 'exact_application_field_fulfillment';
const LATEX_APPLICATION_MATERIALS_SCHEMA_VERSION = 2026071803;
const LATEX_APPLICATION_MATERIALS_MIGRATION_NAME = 'latex_application_material_rendering';
const APPLICATION_MATERIALS_USER_VERSION = 11;
const MAX_MATERIAL_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_PINNED_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_RENDERED_DOCUMENT_BYTES = 16 * 1024 * 1024;
const LATEX_DOCUMENT_CONTRACT_VERSION = 'jobtrack-latex-document-v1';
const FORM_ANSWER_CONTRACT_VERSION = 'jobtrack-form-answer-v1';
const LATEX_RENDERER_PROFILE = 'jobtrack-latex-pdf-v1';
const PDF_ACTIVE_CONTENT_POLICY = 'jobtrack-pdf-active-content.v1';
const MATERIAL_KINDS = new Set(['resume', 'cover-letter', 'form-answer']);
const AUTHORSHIP_KINDS = new Set(['model', 'human', 'imported']);
const REVIEW_DECISIONS = new Set(['approved', 'revision-requested', 'rejected']);
const PREPARATION_MODES = new Set(['managed', 'legacy-import']);
const BLOCKING_REQUIREDNESS = new Set(['required', 'conditional']);
const RESOLVED_INFORMATION_STATES = new Set(['available', 'not_applicable']);
const FORM_FIELD_RESOLUTION_STATES = new Set(['applicable', 'fulfilled', 'not-applicable', 'blocked']);

class ApplicationMaterialsError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ApplicationMaterialsError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function migrateApplicationMaterials(db) {
  const apply = () => {
    for (const dependency of [
      'applications', 'application_artifacts', 'application_assessments', 'assessment_review_gates',
      'application_packages', 'profile_entries', 'profile_story_uses', 'information_requiredness_levels',
      'application_form_revisions', 'application_form_fields', 'application_form_field_options', 'application_form_surfaces',
      'application_application_form_surfaces', 'opportunity_application_form_surfaces'
    ]) {
      if (!tableExists(db, dependency)) {
        throw new ApplicationMaterialsError('SCHEMA_DEPENDENCY_MISSING', `Run the base migrations before application-materials migration (${dependency} is missing)`);
      }
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobtrack_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS application_preparation_modes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        CHECK (trim(slug)<>''), CHECK (trim(label)<>'')
      );
      CREATE TABLE IF NOT EXISTS application_material_kinds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        is_baseline INTEGER NOT NULL CHECK (is_baseline IN (0,1)),
        sort_rank INTEGER NOT NULL,
        CHECK (trim(slug)<>''), CHECK (trim(label)<>'')
      );
      CREATE TABLE IF NOT EXISTS application_material_authorship_kinds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        CHECK (trim(slug)<>''), CHECK (trim(label)<>'')
      );
      CREATE TABLE IF NOT EXISTS application_material_review_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        is_approved INTEGER NOT NULL CHECK (is_approved IN (0,1)),
        CHECK (trim(slug)<>''), CHECK (trim(label)<>'')
      );
      CREATE TABLE IF NOT EXISTS application_material_revision_stages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        sort_rank INTEGER NOT NULL,
        CHECK (trim(slug)<>''), CHECK (trim(label)<>'')
      );

      CREATE TABLE IF NOT EXISTS application_preparation_plans (
        application_id INTEGER PRIMARY KEY REFERENCES applications(id) ON DELETE RESTRICT,
        mode_id INTEGER NOT NULL REFERENCES application_preparation_modes(id) ON DELETE RESTRICT,
        lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version>=0),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS application_preparation_plan_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
        from_mode_id INTEGER REFERENCES application_preparation_modes(id) ON DELETE RESTRICT,
        to_mode_id INTEGER NOT NULL REFERENCES application_preparation_modes(id) ON DELETE RESTRICT,
        expected_plan_version INTEGER NOT NULL CHECK (expected_plan_version>=0),
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(actor)<>''), CHECK (trim(reason)<>'')
      );
      CREATE TABLE IF NOT EXISTS application_material_requirements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
        material_kind_id INTEGER NOT NULL REFERENCES application_material_kinds(id) ON DELETE RESTRICT,
        form_field_id INTEGER REFERENCES application_form_fields(id) ON DELETE RESTRICT,
        requiredness_id INTEGER NOT NULL REFERENCES information_requiredness_levels(id) ON DELETE RESTRICT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(source)<>''),
        CHECK ((form_field_id IS NULL) = (source='baseline-policy'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_application_material_requirements_baseline
        ON application_material_requirements(application_id,material_kind_id)
        WHERE form_field_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_application_material_requirements_form
        ON application_material_requirements(application_id,material_kind_id,form_field_id)
        WHERE form_field_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS application_materials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
        material_kind_id INTEGER NOT NULL REFERENCES application_material_kinds(id) ON DELETE RESTRICT,
        form_field_id INTEGER REFERENCES application_form_fields(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_application_materials_baseline
        ON application_materials(application_id,material_kind_id)
        WHERE form_field_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_application_materials_form
        ON application_materials(application_id,material_kind_id,form_field_id)
        WHERE form_field_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS application_material_source_manifests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
        assessment_id INTEGER REFERENCES application_assessments(id) ON DELETE RESTRICT,
        assessment_gate_id INTEGER REFERENCES assessment_review_gates(id) ON DELETE RESTRICT,
        form_capture_id INTEGER REFERENCES application_form_revisions(id) ON DELETE RESTRICT,
        form_state_sha256 TEXT NOT NULL CHECK (length(form_state_sha256)=64),
        application_snapshot_json TEXT NOT NULL CHECK (json_valid(application_snapshot_json)),
        assessment_snapshot_json TEXT CHECK (assessment_snapshot_json IS NULL OR json_valid(assessment_snapshot_json)),
        form_snapshot_json TEXT NOT NULL CHECK (json_valid(form_snapshot_json)),
        profile_snapshot_json TEXT NOT NULL CHECK (json_valid(profile_snapshot_json)),
        source_manifest_sha256 TEXT NOT NULL CHECK (length(source_manifest_sha256)=64),
        created_by TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(created_by)<>'')
      );
      CREATE TABLE IF NOT EXISTS application_material_manifest_artifacts (
        manifest_id INTEGER NOT NULL REFERENCES application_material_source_manifests(id) ON DELETE RESTRICT,
        artifact_id INTEGER NOT NULL REFERENCES application_artifacts(id) ON DELETE RESTRICT,
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64),
        PRIMARY KEY(manifest_id,artifact_id)
      );
      CREATE TABLE IF NOT EXISTS application_material_manifest_profile_entries (
        manifest_id INTEGER NOT NULL REFERENCES application_material_source_manifests(id) ON DELETE RESTRICT,
        profile_entry_id INTEGER NOT NULL REFERENCES profile_entries(id) ON DELETE RESTRICT,
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64),
        PRIMARY KEY(manifest_id,profile_entry_id)
      );
      CREATE TABLE IF NOT EXISTS application_material_manifest_story_uses (
        manifest_id INTEGER NOT NULL REFERENCES application_material_source_manifests(id) ON DELETE RESTRICT,
        story_use_id INTEGER NOT NULL REFERENCES profile_story_uses(id) ON DELETE RESTRICT,
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64),
        PRIMARY KEY(manifest_id,story_use_id)
      );

      CREATE TABLE IF NOT EXISTS application_material_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        material_id INTEGER NOT NULL REFERENCES application_materials(id) ON DELETE RESTRICT,
        revision_number INTEGER NOT NULL CHECK (revision_number>0),
        parent_revision_id INTEGER REFERENCES application_material_revisions(id) ON DELETE RESTRICT,
        source_manifest_id INTEGER NOT NULL REFERENCES application_material_source_manifests(id) ON DELETE RESTRICT,
        content TEXT NOT NULL,
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64),
        revision_stage_id INTEGER NOT NULL REFERENCES application_material_revision_stages(id) ON DELETE RESTRICT,
        authorship_kind_id INTEGER NOT NULL REFERENCES application_material_authorship_kinds(id) ON DELETE RESTRICT,
        authored_by TEXT NOT NULL,
        change_note TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(material_id,revision_number),
        CHECK (length(content)>0), CHECK (length(CAST(content AS BLOB))<=${MAX_MATERIAL_CONTENT_BYTES}),
        CHECK (trim(authored_by)<>''), CHECK (change_note IS NULL OR length(change_note)<=20000)
      );
      CREATE TABLE IF NOT EXISTS application_material_revision_form_options (
        revision_id INTEGER NOT NULL REFERENCES application_material_revisions(id) ON DELETE RESTRICT,
        form_field_id INTEGER NOT NULL REFERENCES application_form_fields(id) ON DELETE RESTRICT,
        option_id INTEGER NOT NULL REFERENCES application_form_field_options(id) ON DELETE RESTRICT,
        selection_position INTEGER NOT NULL CHECK (selection_position>0),
        PRIMARY KEY(revision_id,option_id),
        UNIQUE(revision_id,selection_position)
      );
      CREATE TABLE IF NOT EXISTS application_material_heads (
        material_id INTEGER PRIMARY KEY REFERENCES application_materials(id) ON DELETE RESTRICT,
        revision_id INTEGER NOT NULL UNIQUE REFERENCES application_material_revisions(id) ON DELETE RESTRICT,
        lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version>=0),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS application_material_review_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        revision_id INTEGER NOT NULL REFERENCES application_material_revisions(id) ON DELETE RESTRICT,
        decision_id INTEGER NOT NULL REFERENCES application_material_review_decisions(id) ON DELETE RESTRICT,
        expected_prior_review_id INTEGER REFERENCES application_material_review_events(id) ON DELETE RESTRICT,
        reviewed_by TEXT NOT NULL,
        notes TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        reviewed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(reviewed_by)<>''), CHECK (notes IS NULL OR length(notes)<=20000)
      );
      CREATE TABLE IF NOT EXISTS application_material_selections (
        material_id INTEGER PRIMARY KEY REFERENCES application_materials(id) ON DELETE RESTRICT,
        revision_id INTEGER NOT NULL UNIQUE REFERENCES application_material_revisions(id) ON DELETE RESTRICT,
        lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version>=0),
        selected_by TEXT NOT NULL,
        selected_at TEXT NOT NULL,
        CHECK (trim(selected_by)<>'')
      );
      CREATE TABLE IF NOT EXISTS application_material_selection_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        material_id INTEGER NOT NULL REFERENCES application_materials(id) ON DELETE RESTRICT,
        previous_revision_id INTEGER REFERENCES application_material_revisions(id) ON DELETE RESTRICT,
        revision_id INTEGER NOT NULL REFERENCES application_material_revisions(id) ON DELETE RESTRICT,
        expected_selection_version INTEGER NOT NULL CHECK (expected_selection_version>=0),
        selected_by TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        selected_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(selected_by)<>'')
      );

      CREATE TABLE IF NOT EXISTS application_preparation_uncertainty_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
        form_capture_id INTEGER REFERENCES application_form_revisions(id) ON DELETE RESTRICT,
        form_state_sha256 TEXT NOT NULL CHECK (length(form_state_sha256)=64),
        accepted_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        accepted_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(accepted_by)<>''), CHECK (trim(reason)<>'')
      );

      CREATE TABLE IF NOT EXISTS application_package_preparation_snapshots (
        application_package_id INTEGER PRIMARY KEY REFERENCES application_packages(id) ON DELETE RESTRICT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
        resume_revision_id INTEGER NOT NULL REFERENCES application_material_revisions(id) ON DELETE RESTRICT,
        cover_letter_revision_id INTEGER NOT NULL REFERENCES application_material_revisions(id) ON DELETE RESTRICT,
        form_capture_id INTEGER REFERENCES application_form_revisions(id) ON DELETE RESTRICT,
        form_state_sha256 TEXT NOT NULL CHECK (length(form_state_sha256)=64),
        assessment_id INTEGER REFERENCES application_assessments(id) ON DELETE RESTRICT,
        assessment_gate_id INTEGER REFERENCES assessment_review_gates(id) ON DELETE RESTRICT,
        readiness_manifest_json TEXT NOT NULL CHECK (json_valid(readiness_manifest_json)),
        readiness_sha256 TEXT NOT NULL CHECK (length(readiness_sha256)=64),
        package_snapshot_json TEXT NOT NULL CHECK (json_valid(package_snapshot_json)),
        package_snapshot_sha256 TEXT NOT NULL CHECK (length(package_snapshot_sha256)=64),
        package_attachment_sha256 TEXT CHECK (package_attachment_sha256 IS NULL OR length(package_attachment_sha256)=64),
        package_build_intent_sha256 TEXT NOT NULL CHECK (length(package_build_intent_sha256)=64),
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS application_package_answer_bindings (
        application_package_id INTEGER NOT NULL REFERENCES application_package_preparation_snapshots(application_package_id) ON DELETE RESTRICT,
        form_field_id INTEGER NOT NULL REFERENCES application_form_fields(id) ON DELETE RESTRICT,
        answer_revision_id INTEGER NOT NULL REFERENCES application_material_revisions(id) ON DELETE RESTRICT,
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64),
        PRIMARY KEY(application_package_id,form_field_id)
      );
      CREATE TABLE IF NOT EXISTS application_package_answer_option_bindings (
        application_package_id INTEGER NOT NULL,
        form_field_id INTEGER NOT NULL,
        option_id INTEGER NOT NULL REFERENCES application_form_field_options(id) ON DELETE RESTRICT,
        option_label TEXT NOT NULL,
        selection_position INTEGER NOT NULL CHECK (selection_position>0),
        PRIMARY KEY(application_package_id,form_field_id,option_id),
        UNIQUE(application_package_id,form_field_id,selection_position),
        FOREIGN KEY(application_package_id,form_field_id)
          REFERENCES application_package_answer_bindings(application_package_id,form_field_id) ON DELETE RESTRICT,
        CHECK (trim(option_label)<>'')
      );

      CREATE TABLE IF NOT EXISTS application_material_submission_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL UNIQUE REFERENCES applications(id) ON DELETE RESTRICT,
        application_package_id INTEGER NOT NULL UNIQUE REFERENCES application_packages(id) ON DELETE RESTRICT,
        readiness_sha256 TEXT NOT NULL CHECK (length(readiness_sha256)=64),
        package_snapshot_sha256 TEXT NOT NULL CHECK (length(package_snapshot_sha256)=64),
        package_attachment_sha256 TEXT CHECK (package_attachment_sha256 IS NULL OR length(package_attachment_sha256)=64),
        submitted_by TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        notes TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(submitted_by)<>''),
        CHECK (notes IS NULL OR length(notes)<=20000)
      );

      CREATE TABLE IF NOT EXISTS application_material_operations (
        idempotency_key TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(command)<>'')
      );

      CREATE INDEX IF NOT EXISTS idx_application_materials_application ON application_materials(application_id,material_kind_id,id);
      CREATE INDEX IF NOT EXISTS idx_application_material_revisions_material ON application_material_revisions(material_id,revision_number DESC);
      CREATE INDEX IF NOT EXISTS idx_application_material_revision_options ON application_material_revision_form_options(revision_id,selection_position);
      CREATE INDEX IF NOT EXISTS idx_application_material_reviews_revision ON application_material_review_events(revision_id,id DESC);
      CREATE INDEX IF NOT EXISTS idx_application_material_manifests_application ON application_material_source_manifests(application_id,id DESC);
      CREATE INDEX IF NOT EXISTS idx_application_uncertainty_state ON application_preparation_uncertainty_events(application_id,form_state_sha256,id DESC);
      CREATE INDEX IF NOT EXISTS idx_application_material_submissions_time ON application_material_submission_events(submitted_at,id);
    `);

    seedVocabulary(db, 'application_preparation_modes', ['slug', 'label'], [
      ['managed', 'Managed preparation'], ['legacy-import', 'Legacy / materials not recorded']
    ]);
    seedVocabulary(db, 'application_material_kinds', ['slug', 'label', 'is_baseline', 'sort_rank'], [
      ['resume', 'Tailored resume', 1, 10], ['cover-letter', 'Tailored cover letter', 1, 20], ['form-answer', 'Application form answer', 0, 30]
    ]);
    seedVocabulary(db, 'application_material_authorship_kinds', ['slug', 'label'], [
      ['model', 'Agent/model authored'], ['human', 'Human authored'], ['imported', 'Imported legacy material']
    ]);
    seedVocabulary(db, 'application_material_review_decisions', ['slug', 'label', 'is_approved'], [
      ['approved', 'Approved', 1], ['revision-requested', 'Revision requested', 0], ['rejected', 'Rejected', 0]
    ]);
    seedVocabulary(db, 'application_material_revision_stages', ['slug', 'label', 'sort_rank'], [
      ['rough-draft', 'Rough draft', 10], ['revised', 'Revised draft', 20], ['final-candidate', 'Final candidate', 30]
    ]);
    createApplicationMaterialGuards(db);
    backfillApplicationPreparation(db);
    createApplicationInsertTrigger(db);

    const versionRow = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?').get(APPLICATION_MATERIALS_SCHEMA_VERSION);
    if (versionRow && versionRow.name !== APPLICATION_MATERIALS_MIGRATION_NAME) {
      throw new ApplicationMaterialsError('MIGRATION_CONFLICT', `Schema version ${APPLICATION_MATERIALS_SCHEMA_VERSION} is already named ${versionRow.name}`);
    }
    const nameRow = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?').get(APPLICATION_MATERIALS_MIGRATION_NAME);
    if (nameRow && nameRow.version !== APPLICATION_MATERIALS_SCHEMA_VERSION) {
      throw new ApplicationMaterialsError('MIGRATION_CONFLICT', `Migration ${APPLICATION_MATERIALS_MIGRATION_NAME} is already registered as ${nameRow.version}`);
    }
    if (!versionRow) db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)')
      .run(APPLICATION_MATERIALS_SCHEMA_VERSION, APPLICATION_MATERIALS_MIGRATION_NAME);
    applyApplicationFieldFulfillmentMigration(db);
    applyLatexApplicationMaterialsMigration(db);
    require('./resume-editorial-review').migrateResumeEditorialReviews(db);
    if (db.pragma('user_version', { simple: true }) < APPLICATION_MATERIALS_USER_VERSION) {
      db.pragma(`user_version = ${APPLICATION_MATERIALS_USER_VERSION}`);
    }
  };
  if (db.inTransaction) apply();
  else db.transaction(apply).immediate();
}

function applyLatexApplicationMaterialsMigration(db) {
  const versionRow = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
    .get(LATEX_APPLICATION_MATERIALS_SCHEMA_VERSION);
  if (versionRow && versionRow.name !== LATEX_APPLICATION_MATERIALS_MIGRATION_NAME) {
    throw new ApplicationMaterialsError(
      'MIGRATION_CONFLICT',
      `Schema version ${LATEX_APPLICATION_MATERIALS_SCHEMA_VERSION} is already named ${versionRow.name}`
    );
  }
  const nameRow = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?')
    .get(LATEX_APPLICATION_MATERIALS_MIGRATION_NAME);
  if (nameRow && nameRow.version !== LATEX_APPLICATION_MATERIALS_SCHEMA_VERSION) {
    throw new ApplicationMaterialsError(
      'MIGRATION_CONFLICT',
      `Migration ${LATEX_APPLICATION_MATERIALS_MIGRATION_NAME} is already registered as ${nameRow.version}`
    );
  }

  ensureTableColumn(
    db,
    'application_material_revisions',
    'source_format',
    "TEXT NOT NULL DEFAULT 'legacy-text' CHECK (source_format IN ('legacy-text','plain-text','latex'))"
  );
  ensureTableColumn(
    db,
    'application_material_revisions',
    'generation_contract_version',
    "TEXT NOT NULL DEFAULT 'legacy-unversioned'"
  );
  // Standardized-template provenance (2026-08-05): when a revision's LaTeX
  // was expanded from a versioned template + structured payload, both are
  // recorded so the content is reproducible and reviews can diff SUBSTANCE.
  ensureTableColumn(db, 'application_material_revisions', 'template_key', 'TEXT');
  ensureTableColumn(db, 'application_material_revisions', 'template_payload', "TEXT CHECK (template_payload IS NULL OR json_valid(template_payload))");
  db.exec(`
    CREATE TABLE IF NOT EXISTS application_material_renders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      revision_id INTEGER NOT NULL REFERENCES application_material_revisions(id) ON DELETE RESTRICT,
      source_format TEXT NOT NULL CHECK (source_format='latex'),
      output_format TEXT NOT NULL CHECK (output_format='pdf'),
      source_sha256 TEXT NOT NULL CHECK (length(source_sha256)=64),
      renderer_profile TEXT NOT NULL CHECK (renderer_profile='${LATEX_RENDERER_PROFILE}'),
      renderer_image_digest TEXT NOT NULL CHECK (length(renderer_image_digest)>=12),
      renderer_version TEXT NOT NULL,
      bundle_sha256 TEXT NOT NULL CHECK (length(bundle_sha256)=64),
      output_attachment_path TEXT NOT NULL,
      output_sha256 TEXT NOT NULL CHECK (length(output_sha256)=64),
      output_bytes INTEGER NOT NULL CHECK (output_bytes>0 AND output_bytes<=${MAX_RENDERED_DOCUMENT_BYTES}),
      page_count INTEGER NOT NULL CHECK (page_count>0 AND page_count<=20),
      extracted_text_sha256 TEXT NOT NULL CHECK (length(extracted_text_sha256)=64),
      active_content_policy TEXT NOT NULL CHECK (active_content_policy='${PDF_ACTIVE_CONTENT_POLICY}'),
      active_content_scan_sha256 TEXT NOT NULL CHECK (length(active_content_scan_sha256)=64),
      rendered_by TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(renderer_version)<>''),
      CHECK (trim(output_attachment_path)<>''),
      CHECK (trim(rendered_by)<>'')
    );
    CREATE INDEX IF NOT EXISTS idx_application_material_renders_revision
      ON application_material_renders(revision_id,id DESC);
    CREATE INDEX IF NOT EXISTS idx_application_material_renders_application
      ON application_material_renders(application_id,id DESC);
  `);
  // Lint-gate provenance (plan §3.1): the renderer's document.txt is persisted
  // beside the PDF so extraction audits run host-side and stay verifiable
  // against extracted_text_sha256. Nullable: renders that predate persistence
  // fail lint with MATERIAL_LINT_TEXT_MISSING and are re-rendered.
  ensureTableColumn(db, 'application_material_renders', 'extracted_text_attachment_path', 'TEXT');
  // Optional linkage from the recorded submission fact to the settled
  // application-submission-lane attempt that carried it (lib/application-submission).
  // Nullable: manual submissions Cole performs himself have no lane attempt.
  ensureTableColumn(db, 'application_material_submission_events', 'submission_attempt_id', 'TEXT');
  ensureTableColumn(
    db,
    'application_material_review_events',
    'render_id',
    'INTEGER REFERENCES application_material_renders(id) ON DELETE RESTRICT'
  );
  ensureTableColumn(
    db,
    'application_package_preparation_snapshots',
    'resume_render_id',
    'INTEGER REFERENCES application_material_renders(id) ON DELETE RESTRICT'
  );
  ensureTableColumn(
    db,
    'application_package_preparation_snapshots',
    'cover_letter_render_id',
    'INTEGER REFERENCES application_material_renders(id) ON DELETE RESTRICT'
  );
  createLatexApplicationMaterialGuards(db);
  createApplicationMaterialViews(db);
  if (!versionRow) {
    db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)')
      .run(LATEX_APPLICATION_MATERIALS_SCHEMA_VERSION, LATEX_APPLICATION_MATERIALS_MIGRATION_NAME);
  }
}

function createLatexApplicationMaterialGuards(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_application_material_render_scope
    BEFORE INSERT ON application_material_renders
    WHEN NOT EXISTS (
      SELECT 1
      FROM application_material_revisions revision
      JOIN application_materials material ON material.id=revision.material_id
      JOIN application_material_kinds kind ON kind.id=material.material_kind_id
      WHERE revision.id=NEW.revision_id
        AND material.application_id=NEW.application_id
        AND kind.slug IN ('resume','cover-letter')
        AND revision.source_format='latex'
        AND revision.generation_contract_version='${LATEX_DOCUMENT_CONTRACT_VERSION}'
        AND revision.content_sha256=NEW.source_sha256
    ) OR NEW.output_attachment_path LIKE '/%'
      OR instr(NEW.output_attachment_path,'\\')>0
      OR instr(NEW.output_attachment_path,'..')>0
      OR substr(
        NEW.output_attachment_path,
        1,
        length('attachments/material-renders/' || NEW.application_id || '/' || NEW.revision_id || '/')
      ) <> ('attachments/material-renders/' || NEW.application_id || '/' || NEW.revision_id || '/')
    BEGIN SELECT RAISE(ABORT,'material render scope or source mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_application_material_review_render_scope
    BEFORE INSERT ON application_material_review_events
    WHEN (
      EXISTS (
        SELECT 1 FROM application_material_revisions revision
        JOIN application_materials material ON material.id=revision.material_id
        JOIN application_material_kinds kind ON kind.id=material.material_kind_id
        JOIN application_material_review_decisions decision ON decision.id=NEW.decision_id
        WHERE revision.id=NEW.revision_id
          AND kind.slug IN ('resume','cover-letter')
          AND revision.source_format='latex'
          AND decision.is_approved=1
      ) AND NEW.render_id IS NULL
    ) OR (
      NEW.render_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM application_material_renders render
        WHERE render.id=NEW.render_id AND render.revision_id=NEW.revision_id
      )
    ) OR (
      NEW.render_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM application_material_revisions revision
        JOIN application_materials material ON material.id=revision.material_id
        JOIN application_material_kinds kind ON kind.id=material.material_kind_id
        WHERE revision.id=NEW.revision_id AND kind.slug='form-answer'
      )
    ) BEGIN SELECT RAISE(ABORT,'material review render mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_package_preparation_render_scope
    BEFORE INSERT ON application_package_preparation_snapshots
    WHEN NEW.resume_render_id IS NULL OR NEW.cover_letter_render_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM application_material_renders render
        JOIN application_material_review_events review ON review.render_id=render.id
        JOIN application_material_review_decisions decision ON decision.id=review.decision_id AND decision.is_approved=1
        WHERE render.id=NEW.resume_render_id AND render.revision_id=NEW.resume_revision_id
          AND render.application_id=NEW.application_id
          AND review.revision_id=NEW.resume_revision_id
          AND review.id=(SELECT max(latest.id) FROM application_material_review_events latest WHERE latest.revision_id=NEW.resume_revision_id)
      ) OR NOT EXISTS (
        SELECT 1 FROM application_material_renders render
        JOIN application_material_review_events review ON review.render_id=render.id
        JOIN application_material_review_decisions decision ON decision.id=review.decision_id AND decision.is_approved=1
        WHERE render.id=NEW.cover_letter_render_id AND render.revision_id=NEW.cover_letter_revision_id
          AND render.application_id=NEW.application_id
          AND review.revision_id=NEW.cover_letter_revision_id
          AND review.id=(SELECT max(latest.id) FROM application_material_review_events latest WHERE latest.revision_id=NEW.cover_letter_revision_id)
      ) OR json_extract(NEW.readiness_manifest_json,'$.resumeRenderId') IS NOT NEW.resume_render_id
        OR json_extract(NEW.readiness_manifest_json,'$.coverLetterRenderId') IS NOT NEW.cover_letter_render_id
    BEGIN SELECT RAISE(ABORT,'package document render ownership or review mismatch'); END;
  `);
  createImmutableTriggers(db, 'application_material_renders');
}

function ensureTableColumn(db, table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function applyApplicationFieldFulfillmentMigration(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS application_form_field_resolution_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      CHECK (trim(slug)<>''), CHECK (trim(label)<>'')
    );
    CREATE TABLE IF NOT EXISTS application_form_field_resolution_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      form_field_id INTEGER NOT NULL REFERENCES application_form_fields(id) ON DELETE RESTRICT,
      state_id INTEGER NOT NULL REFERENCES application_form_field_resolution_states(id) ON DELETE RESTRICT,
      form_state_sha256 TEXT NOT NULL CHECK (length(form_state_sha256)=64),
      evidence_artifact_id INTEGER REFERENCES application_artifacts(id) ON DELETE RESTRICT,
      evidence_sha256 TEXT CHECK (evidence_sha256 IS NULL OR length(evidence_sha256)=64),
      expected_current_resolution_id INTEGER REFERENCES application_form_field_resolution_events(id) ON DELETE RESTRICT,
      actor TEXT NOT NULL,
      rationale TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
      resolved_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(actor)<>'' AND length(CAST(actor AS BLOB))<=200),
      CHECK (trim(rationale)<>'' AND length(CAST(rationale AS BLOB))<=20000)
    );
    CREATE INDEX IF NOT EXISTS idx_application_form_field_resolution_current
      ON application_form_field_resolution_events(application_id,form_field_id,id DESC);
  `);
  seedVocabulary(db, 'application_form_field_resolution_states', ['slug', 'label'], [
    ['applicable', 'Applicable; use the normal field workflow'],
    ['fulfilled', 'Fulfilled with pinned application evidence'],
    ['not-applicable', 'Not applicable for this application form state'],
    ['blocked', 'Blocked pending human action']
  ]);
  createApplicationFieldFulfillmentGuards(db);
  const versionRow = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
    .get(APPLICATION_FIELD_FULFILLMENT_SCHEMA_VERSION);
  if (versionRow && versionRow.name !== APPLICATION_FIELD_FULFILLMENT_MIGRATION_NAME) {
    throw new ApplicationMaterialsError(
      'MIGRATION_CONFLICT',
      `Schema version ${APPLICATION_FIELD_FULFILLMENT_SCHEMA_VERSION} is already named ${versionRow.name}`
    );
  }
  const nameRow = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?')
    .get(APPLICATION_FIELD_FULFILLMENT_MIGRATION_NAME);
  if (nameRow && nameRow.version !== APPLICATION_FIELD_FULFILLMENT_SCHEMA_VERSION) {
    throw new ApplicationMaterialsError(
      'MIGRATION_CONFLICT',
      `Migration ${APPLICATION_FIELD_FULFILLMENT_MIGRATION_NAME} is already registered as ${nameRow.version}`
    );
  }
  if (!versionRow) {
    db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)')
      .run(APPLICATION_FIELD_FULFILLMENT_SCHEMA_VERSION, APPLICATION_FIELD_FULFILLMENT_MIGRATION_NAME);
  }
}

function createApplicationFieldFulfillmentGuards(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_form_field_resolution_state_vocab_insert
    BEFORE INSERT ON application_form_field_resolution_states
    WHEN NEW.slug NOT IN ('applicable','fulfilled','not-applicable','blocked')
    BEGIN SELECT RAISE(ABORT,'unknown form field resolution state'); END;

    CREATE TRIGGER IF NOT EXISTS trg_form_field_resolution_state_shape
    BEFORE INSERT ON application_form_field_resolution_events
    WHEN (
      EXISTS (
        SELECT 1 FROM application_form_field_resolution_states s
        WHERE s.id=NEW.state_id AND s.slug='fulfilled'
      ) AND (NEW.evidence_artifact_id IS NULL OR NEW.evidence_sha256 IS NULL)
    ) OR (
      EXISTS (
        SELECT 1 FROM application_form_field_resolution_states s
        WHERE s.id=NEW.state_id AND s.slug IN ('applicable','not-applicable','blocked')
      ) AND (NEW.evidence_artifact_id IS NOT NULL OR NEW.evidence_sha256 IS NOT NULL)
    ) BEGIN SELECT RAISE(ABORT,'form field resolution state and evidence are inconsistent'); END;

    CREATE TRIGGER IF NOT EXISTS trg_form_field_resolution_scope
    BEFORE INSERT ON application_form_field_resolution_events
    WHEN NOT EXISTS (
      SELECT 1
      FROM applications a
      JOIN application_form_fields f ON f.id=NEW.form_field_id
      JOIN application_form_revisions r ON r.id=f.revision_id
      JOIN application_form_surfaces s ON s.id=r.surface_id
      WHERE a.id=NEW.application_id
        AND (a.primary_job_posting_id IS NULL OR s.job_posting_id=a.primary_job_posting_id)
        AND (
          EXISTS (
            SELECT 1 FROM application_application_form_surfaces direct
            WHERE direct.application_id=a.id AND direct.surface_id=s.id
          )
          OR EXISTS (
            SELECT 1 FROM opportunity_application_form_surfaces source
            WHERE source.opportunity_id=a.source_opportunity_id AND source.surface_id=s.id
          )
        )
    ) BEGIN SELECT RAISE(ABORT,'form field resolution belongs to another application route'); END;

    CREATE TRIGGER IF NOT EXISTS trg_form_field_resolution_expected_current
    BEFORE INSERT ON application_form_field_resolution_events
    WHEN COALESCE(NEW.expected_current_resolution_id,0)<>COALESCE((
      SELECT prior.id FROM application_form_field_resolution_events prior
      WHERE prior.application_id=NEW.application_id AND prior.form_field_id=NEW.form_field_id
      ORDER BY prior.id DESC LIMIT 1
    ),0) BEGIN SELECT RAISE(ABORT,'stale form field resolution expectation'); END;

    CREATE TRIGGER IF NOT EXISTS trg_form_field_resolution_evidence_scope
    BEFORE INSERT ON application_form_field_resolution_events
    WHEN NEW.evidence_artifact_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM application_artifacts artifact
      WHERE artifact.id=NEW.evidence_artifact_id AND artifact.application_id=NEW.application_id
    ) BEGIN SELECT RAISE(ABORT,'form field resolution evidence belongs to another application'); END;

    CREATE TRIGGER IF NOT EXISTS trg_form_field_resolution_fulfilled_kind
    BEFORE INSERT ON application_form_field_resolution_events
    WHEN EXISTS (
      SELECT 1 FROM application_form_field_resolution_states state
      WHERE state.id=NEW.state_id AND state.slug='fulfilled'
    ) AND NOT EXISTS (
      SELECT 1
      FROM application_form_fields field
      JOIN application_form_input_kinds input_kind ON input_kind.id=field.input_kind_id
      JOIN information_sensitivity_levels sensitivity ON sensitivity.id=field.sensitivity_level_id
      WHERE field.id=NEW.form_field_id
        AND input_kind.slug IN ('file','file-upload')
        AND sensitivity.slug='standard'
        AND field.profile_information_field_id IS NULL
    ) BEGIN SELECT RAISE(ABORT,'fulfilled form field resolution requires a non-generated human file field'); END;

    CREATE TRIGGER IF NOT EXISTS trg_form_field_resolution_not_applicable_kind
    BEFORE INSERT ON application_form_field_resolution_events
    WHEN EXISTS (
      SELECT 1 FROM application_form_field_resolution_states state
      WHERE state.id=NEW.state_id AND state.slug='not-applicable'
    ) AND NOT EXISTS (
      SELECT 1
      FROM application_form_fields field
      JOIN information_requiredness_levels requiredness ON requiredness.id=field.requiredness_id
      JOIN application_form_observation_states observation ON observation.id=field.observation_state_id
      WHERE field.id=NEW.form_field_id
        AND (
          requiredness.slug='conditional'
          OR observation.slug IN ('known-unobserved','unobserved','declared-unobserved','hidden')
          OR field.visibility_condition IS NOT NULL
        )
    ) BEGIN SELECT RAISE(ABORT,'not-applicable requires a conditional or inactive form field'); END;

    CREATE TRIGGER IF NOT EXISTS trg_form_field_resolution_file_evidence
    BEFORE INSERT ON application_form_field_resolution_events
    WHEN EXISTS (
      SELECT 1 FROM application_form_field_resolution_states state
      WHERE state.id=NEW.state_id AND state.slug='fulfilled'
    ) AND EXISTS (
      SELECT 1 FROM application_artifacts artifact
      WHERE artifact.id=NEW.evidence_artifact_id AND artifact.application_id=NEW.application_id
    ) AND NOT EXISTS (
      SELECT 1 FROM application_artifacts artifact
      WHERE artifact.id=NEW.evidence_artifact_id
        AND artifact.application_id=NEW.application_id
        AND artifact.attachment_path IS NOT NULL
        AND trim(artifact.attachment_path)<>''
    ) BEGIN SELECT RAISE(ABORT,'file-upload fulfillment requires a managed application artifact attachment'); END;
  `);
  for (const table of [
    'application_form_field_resolution_states',
    'application_form_field_resolution_events'
  ]) createImmutableTriggers(db, table);
}

function seedVocabulary(db, table, columns, rows) {
  const select = db.prepare(`SELECT ${columns.join(',')} FROM ${table} WHERE slug=?`);
  const insert = db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  for (const row of rows) {
    const existing = select.get(row[0]);
    if (!existing) {
      insert.run(...row);
      continue;
    }
    for (let index = 0; index < columns.length; index += 1) {
      if (existing[columns[index]] !== row[index]) {
        throw new ApplicationMaterialsError('MIGRATION_CONFLICT', `${table}.${row[0]} has unexpected ${columns[index]}`);
      }
    }
  }
}

function createApplicationMaterialGuards(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_application_material_requirement_kind
    BEFORE INSERT ON application_material_requirements
    WHEN (NEW.form_field_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM application_material_kinds k WHERE k.id=NEW.material_kind_id AND k.slug IN ('resume','cover-letter')
    )) OR (NEW.form_field_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM application_material_kinds k WHERE k.id=NEW.material_kind_id AND k.slug='form-answer'
    )) BEGIN SELECT RAISE(ABORT,'material requirement kind and form field are inconsistent'); END;

    CREATE TRIGGER IF NOT EXISTS trg_application_material_kind
    BEFORE INSERT ON application_materials
    WHEN (NEW.form_field_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM application_material_kinds k WHERE k.id=NEW.material_kind_id AND k.slug IN ('resume','cover-letter')
    )) OR (NEW.form_field_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM application_material_kinds k WHERE k.id=NEW.material_kind_id AND k.slug='form-answer'
    )) BEGIN SELECT RAISE(ABORT,'material kind and form field are inconsistent'); END;

    CREATE TRIGGER IF NOT EXISTS trg_application_material_requirement_form_scope
    BEFORE INSERT ON application_material_requirements
    WHEN NEW.form_field_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM application_form_fields f
      JOIN application_form_revisions r ON r.id=f.revision_id
      WHERE f.id=NEW.form_field_id AND (
        EXISTS (SELECT 1 FROM application_application_form_surfaces l WHERE l.application_id=NEW.application_id AND l.surface_id=r.surface_id)
        OR EXISTS (
          SELECT 1 FROM applications a
          JOIN opportunity_application_form_surfaces l ON l.opportunity_id=a.source_opportunity_id
          WHERE a.id=NEW.application_id AND l.surface_id=r.surface_id
        )
      )
    ) BEGIN SELECT RAISE(ABORT,'form field belongs to another application route'); END;

    CREATE TRIGGER IF NOT EXISTS trg_application_material_form_scope
    BEFORE INSERT ON application_materials
    WHEN NEW.form_field_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM application_form_fields f
      JOIN application_form_revisions r ON r.id=f.revision_id
      WHERE f.id=NEW.form_field_id AND (
        EXISTS (SELECT 1 FROM application_application_form_surfaces l WHERE l.application_id=NEW.application_id AND l.surface_id=r.surface_id)
        OR EXISTS (
          SELECT 1 FROM applications a
          JOIN opportunity_application_form_surfaces l ON l.opportunity_id=a.source_opportunity_id
          WHERE a.id=NEW.application_id AND l.surface_id=r.surface_id
        )
      )
    ) BEGIN SELECT RAISE(ABORT,'form field belongs to another application route'); END;

    CREATE TRIGGER IF NOT EXISTS trg_material_manifest_assessment_scope
    BEFORE INSERT ON application_material_source_manifests
    WHEN (NEW.assessment_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM application_assessments a WHERE a.id=NEW.assessment_id AND a.application_id=NEW.application_id
    )) OR (NEW.assessment_gate_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM assessment_review_gates g WHERE g.id=NEW.assessment_gate_id AND g.application_id=NEW.application_id
    )) OR (NEW.assessment_gate_id IS NOT NULL AND NEW.assessment_id IS NULL)
      OR (NEW.assessment_gate_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM application_assessments a
        JOIN assessment_review_gates g ON g.id=NEW.assessment_gate_id
        WHERE a.id=NEW.assessment_id AND a.application_id=NEW.application_id
          AND g.application_id=NEW.application_id AND g.artifact_id=a.artifact_id
      ))
    BEGIN SELECT RAISE(ABORT,'material manifest assessment scope mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_material_manifest_form_scope
    BEFORE INSERT ON application_material_source_manifests
    WHEN NEW.form_capture_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM application_form_revisions r WHERE r.id=NEW.form_capture_id AND (
        EXISTS (SELECT 1 FROM application_application_form_surfaces l WHERE l.application_id=NEW.application_id AND l.surface_id=r.surface_id)
        OR EXISTS (
          SELECT 1 FROM applications a
          JOIN opportunity_application_form_surfaces l ON l.opportunity_id=a.source_opportunity_id
          WHERE a.id=NEW.application_id AND l.surface_id=r.surface_id
        )
      )
    ) BEGIN SELECT RAISE(ABORT,'form capture belongs to another application route'); END;

    CREATE TRIGGER IF NOT EXISTS trg_material_manifest_artifact_scope
    BEFORE INSERT ON application_material_manifest_artifacts
    WHEN NOT EXISTS (
      SELECT 1 FROM application_material_source_manifests m
      JOIN application_artifacts a ON a.id=NEW.artifact_id
      WHERE m.id=NEW.manifest_id AND a.application_id=m.application_id
    ) BEGIN SELECT RAISE(ABORT,'material artifact belongs to another application'); END;

    CREATE TRIGGER IF NOT EXISTS trg_material_manifest_story_use_scope
    BEFORE INSERT ON application_material_manifest_story_uses
    WHEN NOT EXISTS (
      SELECT 1 FROM application_material_source_manifests m
      JOIN profile_story_uses u ON u.id=NEW.story_use_id
      WHERE m.id=NEW.manifest_id AND u.application_id=m.application_id
    ) BEGIN SELECT RAISE(ABORT,'material story use belongs to another application'); END;

    CREATE TRIGGER IF NOT EXISTS trg_material_revision_parent_scope
    BEFORE INSERT ON application_material_revisions
    WHEN NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM application_material_revisions p WHERE p.id=NEW.parent_revision_id AND p.material_id=NEW.material_id
    ) BEGIN SELECT RAISE(ABORT,'parent revision belongs to another material'); END;

    CREATE TRIGGER IF NOT EXISTS trg_material_revision_manifest_scope
    BEFORE INSERT ON application_material_revisions
    WHEN NOT EXISTS (
      SELECT 1 FROM application_materials m
      JOIN application_material_source_manifests s ON s.id=NEW.source_manifest_id
      WHERE m.id=NEW.material_id AND s.application_id=m.application_id
    ) BEGIN SELECT RAISE(ABORT,'source manifest belongs to another application'); END;

    CREATE TRIGGER IF NOT EXISTS trg_material_revision_form_option_scope
    BEFORE INSERT ON application_material_revision_form_options
    WHEN NOT EXISTS (
      SELECT 1 FROM application_material_revisions r
      JOIN application_materials m ON m.id=r.material_id
      JOIN application_material_kinds k ON k.id=m.material_kind_id AND k.slug='form-answer'
      JOIN application_form_fields f ON f.id=m.form_field_id AND f.id=NEW.form_field_id
      JOIN application_form_input_kinds ik ON ik.id=f.input_kind_id AND ik.slug IN ('single-choice','multi-choice')
      JOIN application_form_field_options o ON o.id=NEW.option_id AND o.field_id=f.id
      WHERE r.id=NEW.revision_id
    ) BEGIN SELECT RAISE(ABORT,'form option must belong to the exact choice field and answer revision'); END;

    CREATE TRIGGER IF NOT EXISTS trg_material_revision_form_option_cardinality
    BEFORE INSERT ON application_material_revision_form_options
    WHEN EXISTS (
      SELECT 1 FROM application_form_fields f
      JOIN application_form_input_kinds ik ON ik.id=f.input_kind_id
      WHERE f.id=NEW.form_field_id AND (
        (ik.slug='single-choice' AND (SELECT count(*) FROM application_material_revision_form_options x WHERE x.revision_id=NEW.revision_id)>=1)
        OR (
          json_extract(f.constraints_json,'$.maxSelections') IS NOT NULL
          AND (SELECT count(*) FROM application_material_revision_form_options x WHERE x.revision_id=NEW.revision_id)>=json_extract(f.constraints_json,'$.maxSelections')
        )
      )
    ) BEGIN SELECT RAISE(ABORT,'form option selection exceeds captured cardinality'); END;

    CREATE TRIGGER IF NOT EXISTS trg_material_head_scope_insert
    BEFORE INSERT ON application_material_heads
    WHEN NOT EXISTS (SELECT 1 FROM application_material_revisions r WHERE r.id=NEW.revision_id AND r.material_id=NEW.material_id)
    BEGIN SELECT RAISE(ABORT,'material head revision belongs to another material'); END;
    CREATE TRIGGER IF NOT EXISTS trg_material_head_scope_update
    BEFORE UPDATE ON application_material_heads
    WHEN NOT EXISTS (SELECT 1 FROM application_material_revisions r WHERE r.id=NEW.revision_id AND r.material_id=NEW.material_id)
    BEGIN SELECT RAISE(ABORT,'material head revision belongs to another material'); END;

    CREATE TRIGGER IF NOT EXISTS trg_material_review_expected_prior
    BEFORE INSERT ON application_material_review_events
    WHEN COALESCE(NEW.expected_prior_review_id,0)<>COALESCE((
      SELECT id FROM application_material_review_events WHERE revision_id=NEW.revision_id ORDER BY id DESC LIMIT 1
    ),0) BEGIN SELECT RAISE(ABORT,'stale material review expectation'); END;

    CREATE TRIGGER IF NOT EXISTS trg_material_review_choice_cardinality
    BEFORE INSERT ON application_material_review_events
    WHEN EXISTS (
      SELECT 1 FROM application_material_revisions r
      JOIN application_materials m ON m.id=r.material_id
      JOIN application_form_fields f ON f.id=m.form_field_id
      JOIN application_form_input_kinds ik ON ik.id=f.input_kind_id AND ik.slug IN ('single-choice','multi-choice')
      JOIN information_requiredness_levels req ON req.id=f.requiredness_id
      JOIN application_material_review_decisions d ON d.id=NEW.decision_id AND d.is_approved=1
      WHERE r.id=NEW.revision_id AND (
        (ik.slug='single-choice' AND (SELECT count(*) FROM application_material_revision_form_options x WHERE x.revision_id=r.id)<>1)
        OR (ik.slug='multi-choice' AND (
          (SELECT count(*) FROM application_material_revision_form_options x WHERE x.revision_id=r.id)
            < COALESCE(json_extract(f.constraints_json,'$.minSelections'),CASE WHEN req.slug IN ('required','conditional') THEN 1 ELSE 0 END)
          OR (
            json_extract(f.constraints_json,'$.maxSelections') IS NOT NULL
            AND (SELECT count(*) FROM application_material_revision_form_options x WHERE x.revision_id=r.id)>json_extract(f.constraints_json,'$.maxSelections')
          )
        ))
      )
    ) BEGIN SELECT RAISE(ABORT,'approved choice answer violates captured option cardinality'); END;

    CREATE TRIGGER IF NOT EXISTS trg_material_selection_event_scope
    BEFORE INSERT ON application_material_selection_events
    WHEN NOT EXISTS (
      SELECT 1 FROM application_material_revisions r WHERE r.id=NEW.revision_id AND r.material_id=NEW.material_id
    ) OR (NEW.previous_revision_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM application_material_revisions p WHERE p.id=NEW.previous_revision_id AND p.material_id=NEW.material_id
    )) BEGIN SELECT RAISE(ABORT,'material selection revision belongs to another material'); END;

    CREATE TRIGGER IF NOT EXISTS trg_material_selection_scope_insert
    BEFORE INSERT ON application_material_selections
    WHEN NOT EXISTS (
      SELECT 1 FROM application_material_revisions r WHERE r.id=NEW.revision_id AND r.material_id=NEW.material_id
    ) OR NOT EXISTS (
      SELECT 1 FROM application_material_review_events e
      JOIN application_material_review_decisions d ON d.id=e.decision_id
      WHERE e.revision_id=NEW.revision_id AND d.is_approved=1
        AND e.id=(SELECT max(e2.id) FROM application_material_review_events e2 WHERE e2.revision_id=NEW.revision_id)
    ) BEGIN SELECT RAISE(ABORT,'only an approved revision can be selected'); END;
    CREATE TRIGGER IF NOT EXISTS trg_material_selection_scope_update
    BEFORE UPDATE ON application_material_selections
    WHEN NOT EXISTS (
      SELECT 1 FROM application_material_revisions r WHERE r.id=NEW.revision_id AND r.material_id=NEW.material_id
    ) OR NOT EXISTS (
      SELECT 1 FROM application_material_review_events e
      JOIN application_material_review_decisions d ON d.id=e.decision_id
      WHERE e.revision_id=NEW.revision_id AND d.is_approved=1
        AND e.id=(SELECT max(e2.id) FROM application_material_review_events e2 WHERE e2.revision_id=NEW.revision_id)
    ) BEGIN SELECT RAISE(ABORT,'only an approved revision can be selected'); END;

    CREATE TRIGGER IF NOT EXISTS trg_application_package_evidence_scope_insert
    BEFORE INSERT ON application_packages
    WHEN (NEW.assessment_id IS NULL) <> (NEW.assessment_gate_id IS NULL)
      OR (NEW.assessment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM application_assessments a
        JOIN assessment_review_gates g
          ON g.id=NEW.assessment_gate_id AND g.application_id=a.application_id
          AND g.artifact_id=a.artifact_id AND g.decision='approved'
        WHERE a.id=NEW.assessment_id AND a.application_id=NEW.application_id
      ))
      OR (NEW.cover_letter_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM cover_letters c WHERE c.id=NEW.cover_letter_id AND c.application_id=NEW.application_id
      ))
      OR (NEW.resume_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM resume_versions r WHERE r.id=NEW.resume_id AND r.application_id=NEW.application_id
      ))
    BEGIN SELECT RAISE(ABORT,'application package evidence belongs to another application or is not approved'); END;
    CREATE TRIGGER IF NOT EXISTS trg_application_package_evidence_scope_update
    BEFORE UPDATE OF application_id,assessment_id,assessment_gate_id,cover_letter_id,resume_id ON application_packages
    WHEN (NEW.assessment_id IS NULL) <> (NEW.assessment_gate_id IS NULL)
      OR (NEW.assessment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM application_assessments a
        JOIN assessment_review_gates g
          ON g.id=NEW.assessment_gate_id AND g.application_id=a.application_id
          AND g.artifact_id=a.artifact_id AND g.decision='approved'
        WHERE a.id=NEW.assessment_id AND a.application_id=NEW.application_id
      ))
      OR (NEW.cover_letter_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM cover_letters c WHERE c.id=NEW.cover_letter_id AND c.application_id=NEW.application_id
      ))
      OR (NEW.resume_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM resume_versions r WHERE r.id=NEW.resume_id AND r.application_id=NEW.application_id
      ))
    BEGIN SELECT RAISE(ABORT,'application package evidence belongs to another application or is not approved'); END;

    CREATE TRIGGER IF NOT EXISTS trg_package_preparation_scope
    BEFORE INSERT ON application_package_preparation_snapshots
    WHEN NOT EXISTS (
      SELECT 1 FROM application_packages p WHERE p.id=NEW.application_package_id AND p.application_id=NEW.application_id
        AND p.package_status='ready'
        AND p.assessment_id=NEW.assessment_id AND p.assessment_gate_id=NEW.assessment_gate_id
    ) OR NOT EXISTS (
      SELECT 1 FROM application_assessments a
      JOIN assessment_review_gates g
        ON g.id=NEW.assessment_gate_id AND g.application_id=a.application_id
        AND g.artifact_id=a.artifact_id AND g.decision='approved'
      WHERE a.id=NEW.assessment_id AND a.application_id=NEW.application_id
    ) OR NOT EXISTS (
      SELECT 1 FROM application_material_revisions r JOIN application_materials m ON m.id=r.material_id
      JOIN application_material_kinds k ON k.id=m.material_kind_id
      JOIN application_material_revision_stages st ON st.id=r.revision_stage_id AND st.slug='final-candidate'
      JOIN application_material_selections sel ON sel.material_id=m.id AND sel.revision_id=r.id
      JOIN application_material_review_events rev ON rev.revision_id=r.id
      JOIN application_material_review_decisions dec ON dec.id=rev.decision_id AND dec.is_approved=1
      WHERE r.id=NEW.resume_revision_id AND m.application_id=NEW.application_id AND k.slug='resume'
        AND rev.id=(SELECT max(latest.id) FROM application_material_review_events latest WHERE latest.revision_id=r.id)
    ) OR NOT EXISTS (
      SELECT 1 FROM application_material_revisions r JOIN application_materials m ON m.id=r.material_id
      JOIN application_material_kinds k ON k.id=m.material_kind_id
      JOIN application_material_revision_stages st ON st.id=r.revision_stage_id AND st.slug='final-candidate'
      JOIN application_material_selections sel ON sel.material_id=m.id AND sel.revision_id=r.id
      JOIN application_material_review_events rev ON rev.revision_id=r.id
      JOIN application_material_review_decisions dec ON dec.id=rev.decision_id AND dec.is_approved=1
      WHERE r.id=NEW.cover_letter_revision_id AND m.application_id=NEW.application_id AND k.slug='cover-letter'
        AND rev.id=(SELECT max(latest.id) FROM application_material_review_events latest WHERE latest.revision_id=r.id)
    ) OR (NEW.form_capture_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM application_form_revisions fr
      JOIN application_form_surfaces fs ON fs.id=fr.surface_id
      JOIN applications app ON app.id=NEW.application_id
      LEFT JOIN application_application_form_surfaces afs
        ON afs.surface_id=fs.id AND afs.application_id=app.id
      LEFT JOIN opportunity_application_form_surfaces ofs
        ON ofs.surface_id=fs.id AND ofs.opportunity_id=app.source_opportunity_id
      WHERE fr.id=NEW.form_capture_id AND (afs.application_id IS NOT NULL OR ofs.opportunity_id IS NOT NULL)
    )) OR json_extract(NEW.readiness_manifest_json,'$.applicationId') IS NOT NEW.application_id
      OR json_extract(NEW.readiness_manifest_json,'$.planMode') IS NOT 'managed'
      OR json_extract(NEW.readiness_manifest_json,'$.assessmentId') IS NOT NEW.assessment_id
      OR json_extract(NEW.readiness_manifest_json,'$.assessmentGateId') IS NOT NEW.assessment_gate_id
      OR json_extract(NEW.readiness_manifest_json,'$.formCaptureId') IS NOT NEW.form_capture_id
      OR json_extract(NEW.readiness_manifest_json,'$.formStateSha256') IS NOT NEW.form_state_sha256
      OR json_extract(NEW.readiness_manifest_json,'$.resumeRevisionId') IS NOT NEW.resume_revision_id
      OR json_extract(NEW.readiness_manifest_json,'$.coverLetterRevisionId') IS NOT NEW.cover_letter_revision_id
      OR json_type(NEW.readiness_manifest_json,'$.blockerCodes') IS NOT 'array'
      OR json_array_length(json_extract(NEW.readiness_manifest_json,'$.blockerCodes'))<>0
      OR json_extract(NEW.package_snapshot_json,'$.packageId') IS NOT NEW.application_package_id
      OR json_extract(NEW.package_snapshot_json,'$.applicationId') IS NOT NEW.application_id
    BEGIN SELECT RAISE(ABORT,'package material ownership or readiness selection mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_package_answer_scope
    BEFORE INSERT ON application_package_answer_bindings
    WHEN NOT EXISTS (
      SELECT 1 FROM application_package_preparation_snapshots p
      JOIN application_material_revisions r ON r.id=NEW.answer_revision_id
      JOIN application_materials m ON m.id=r.material_id
      JOIN application_material_kinds k ON k.id=m.material_kind_id
      JOIN application_material_revision_stages st ON st.id=r.revision_stage_id AND st.slug='final-candidate'
      JOIN application_material_selections sel ON sel.material_id=m.id AND sel.revision_id=r.id
      JOIN application_material_review_events rev ON rev.revision_id=r.id
      JOIN application_material_review_decisions dec ON dec.id=rev.decision_id AND dec.is_approved=1
      WHERE p.application_package_id=NEW.application_package_id AND m.application_id=p.application_id
        AND k.slug='form-answer' AND m.form_field_id=NEW.form_field_id
        AND r.content_sha256=NEW.content_sha256
        AND rev.id=(SELECT max(latest.id) FROM application_material_review_events latest WHERE latest.revision_id=r.id)
    ) BEGIN SELECT RAISE(ABORT,'package answer ownership mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_package_answer_option_scope
    BEFORE INSERT ON application_package_answer_option_bindings
    WHEN NOT EXISTS (
      SELECT 1 FROM application_package_answer_bindings b
      JOIN application_material_revision_form_options ro
        ON ro.revision_id=b.answer_revision_id AND ro.form_field_id=b.form_field_id AND ro.option_id=NEW.option_id
      JOIN application_form_field_options o
        ON o.id=ro.option_id AND o.field_id=b.form_field_id AND o.label=NEW.option_label
      WHERE b.application_package_id=NEW.application_package_id
        AND b.form_field_id=NEW.form_field_id AND ro.selection_position=NEW.selection_position
    ) BEGIN SELECT RAISE(ABORT,'package option must match the exact selected answer option and label'); END;

    CREATE TRIGGER IF NOT EXISTS trg_application_material_submission_scope
    BEFORE INSERT ON application_material_submission_events
    WHEN NOT EXISTS (
      SELECT 1
      FROM applications a
      JOIN application_preparation_plans pp ON pp.application_id=a.id
      JOIN application_preparation_modes pm ON pm.id=pp.mode_id AND pm.slug='managed'
      JOIN application_packages p ON p.id=NEW.application_package_id AND p.application_id=a.id
      JOIN application_package_preparation_snapshots s
        ON s.application_package_id=p.id AND s.application_id=a.id AND s.readiness_sha256=NEW.readiness_sha256
        AND s.package_snapshot_sha256=NEW.package_snapshot_sha256
        AND s.package_attachment_sha256 IS NEW.package_attachment_sha256
      WHERE a.id=NEW.application_id AND a.workflow_stage='package_ready' AND p.package_status='ready'
    ) BEGIN SELECT RAISE(ABORT,'manual submission requires the exact ready bound package for a managed package-ready application'); END;

    CREATE TRIGGER IF NOT EXISTS trg_application_material_submission_project
    AFTER INSERT ON application_material_submission_events
    BEGIN
      UPDATE application_packages
      SET package_status='submitted',updated_at=datetime('now')
      WHERE id=NEW.application_package_id AND application_id=NEW.application_id AND package_status='ready';
      UPDATE applications
      SET workflow_stage='submitted',
          applied_date=COALESCE(applied_date,substr(NEW.submitted_at,1,10)),
          updated_at=datetime('now'),lock_version=lock_version+1
      WHERE id=NEW.application_id AND workflow_stage='package_ready';
      INSERT INTO application_lifecycle_events(application_id,from_stage,to_stage,event_kind,notes)
      VALUES (
        NEW.application_id,'package_ready','submitted','manual_submission_recorded',
        'Recorded manual submission of reviewed package #' || NEW.application_package_id ||
          ' by ' || NEW.submitted_by || CASE WHEN NEW.notes IS NULL THEN '' ELSE ': ' || NEW.notes END
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_application_package_bound_immutable_update
    BEFORE UPDATE ON application_packages
    WHEN EXISTS (
      SELECT 1 FROM application_package_preparation_snapshots s WHERE s.application_package_id=OLD.id
    ) AND (
      NEW.application_id IS NOT OLD.application_id
      OR NEW.notes IS NOT OLD.notes
      OR NEW.attachment_path IS NOT OLD.attachment_path
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.content IS NOT OLD.content
      OR NEW.cover_letter_id IS NOT OLD.cover_letter_id
      OR NEW.resume_id IS NOT OLD.resume_id
      OR NEW.assessment_id IS NOT OLD.assessment_id
      OR NEW.assessment_gate_id IS NOT OLD.assessment_gate_id
      OR NEW.profile_snapshot IS NOT OLD.profile_snapshot
      OR NEW.application_snapshot IS NOT OLD.application_snapshot
      OR NEW.artifact_refs IS NOT OLD.artifact_refs
      OR NEW.checklist IS NOT OLD.checklist
      OR NEW.export_policy IS NOT OLD.export_policy
      OR NEW.content_sha256 IS NOT OLD.content_sha256
      OR (
        (NEW.package_status IS NOT OLD.package_status OR NEW.updated_at IS NOT OLD.updated_at)
        AND NOT (
          OLD.package_status='ready' AND NEW.package_status='submitted'
          AND EXISTS (
            SELECT 1 FROM application_material_submission_events e
            WHERE e.application_package_id=OLD.id AND e.application_id=OLD.application_id
          )
        )
      )
    ) BEGIN SELECT RAISE(ABORT,'bound application package is immutable outside audited submission projection'); END;

    CREATE TRIGGER IF NOT EXISTS trg_application_package_bound_immutable_delete
    BEFORE DELETE ON application_packages
    WHEN EXISTS (
      SELECT 1 FROM application_package_preparation_snapshots s WHERE s.application_package_id=OLD.id
    ) BEGIN SELECT RAISE(ABORT,'bound application package is immutable'); END;
  `);

  for (const table of [
    'application_preparation_plan_events', 'application_material_requirements', 'application_materials',
    'application_material_source_manifests', 'application_material_manifest_artifacts',
    'application_material_manifest_profile_entries', 'application_material_manifest_story_uses',
    'application_material_revisions', 'application_material_revision_form_options', 'application_material_review_events',
    'application_material_selection_events', 'application_preparation_uncertainty_events',
    'application_package_preparation_snapshots', 'application_package_answer_bindings',
    'application_package_answer_option_bindings',
    'application_material_submission_events',
    'application_material_operations'
  ]) createImmutableTriggers(db, table);
}

function createImmutableTriggers(db, table) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_${table}_immutable_update
    BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'${table} is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_${table}_immutable_delete
    BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'${table} is immutable'); END;
  `);
}

function backfillApplicationPreparation(db) {
  const managed = db.prepare("SELECT id FROM application_preparation_modes WHERE slug='managed'").get().id;
  const legacy = db.prepare("SELECT id FROM application_preparation_modes WHERE slug='legacy-import'").get().id;
  const resume = db.prepare("SELECT id FROM application_material_kinds WHERE slug='resume'").get().id;
  const letter = db.prepare("SELECT id FROM application_material_kinds WHERE slug='cover-letter'").get().id;
  const insertPlan = db.prepare(`
    INSERT INTO application_preparation_plans(application_id,mode_id)
    VALUES (?,?) ON CONFLICT(application_id) DO NOTHING
  `);
  const insertRequirement = db.prepare(`
    INSERT INTO application_material_requirements(application_id,material_kind_id,form_field_id,requiredness_id,source)
    SELECT ?,?,NULL,id,'baseline-policy' FROM information_requiredness_levels WHERE slug='required'
    ON CONFLICT DO NOTHING
  `);
  const insertMaterial = db.prepare(`
    INSERT INTO application_materials(application_id,material_kind_id,form_field_id)
    VALUES (?,?,NULL) ON CONFLICT DO NOTHING
  `);
  for (const application of db.prepare('SELECT id,workflow_stage FROM applications ORDER BY id').all()) {
    insertPlan.run(application.id, application.workflow_stage === 'submitted' ? legacy : managed);
    for (const kindId of [resume, letter]) {
      insertRequirement.run(application.id, kindId);
      insertMaterial.run(application.id, kindId);
    }
  }
}

function createApplicationInsertTrigger(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_application_preparation_after_insert
    AFTER INSERT ON applications
    BEGIN
      INSERT INTO application_preparation_plans(application_id,mode_id)
      SELECT NEW.id,id FROM application_preparation_modes
      WHERE slug=CASE WHEN NEW.workflow_stage='submitted' THEN 'legacy-import' ELSE 'managed' END;
      INSERT INTO application_material_requirements(application_id,material_kind_id,form_field_id,requiredness_id,source)
      SELECT NEW.id,k.id,NULL,r.id,'baseline-policy'
      FROM application_material_kinds k,information_requiredness_levels r
      WHERE k.is_baseline=1 AND r.slug='required';
      INSERT INTO application_materials(application_id,material_kind_id,form_field_id)
      SELECT NEW.id,id,NULL FROM application_material_kinds WHERE is_baseline=1;
    END;
  `);
}

function createApplicationMaterialViews(db) {
  db.exec(`
    DROP VIEW IF EXISTS application_material_revision_current_state;
    CREATE VIEW application_material_revision_current_state AS
      SELECT r.*,m.application_id,m.form_field_id,k.slug AS material_kind,k.label AS material_kind_label,
        rs.slug AS revision_stage,rs.label AS revision_stage_label,ak.slug AS authorship,
        h.revision_id=r.id AS is_head,s.revision_id=r.id AS is_selected,
        e.id AS latest_review_id,e.render_id AS latest_review_render_id,
        d.slug AS latest_review_decision,d.is_approved AS latest_review_approved,
        sm.form_capture_id,sm.form_state_sha256,sm.source_manifest_sha256
      FROM application_material_revisions r
      JOIN application_materials m ON m.id=r.material_id
      JOIN application_material_kinds k ON k.id=m.material_kind_id
      JOIN application_material_revision_stages rs ON rs.id=r.revision_stage_id
      JOIN application_material_authorship_kinds ak ON ak.id=r.authorship_kind_id
      JOIN application_material_source_manifests sm ON sm.id=r.source_manifest_id
      LEFT JOIN application_material_heads h ON h.material_id=m.id
      LEFT JOIN application_material_selections s ON s.material_id=m.id
      LEFT JOIN application_material_review_events e ON e.id=(
        SELECT e2.id FROM application_material_review_events e2 WHERE e2.revision_id=r.id ORDER BY e2.id DESC LIMIT 1
      )
      LEFT JOIN application_material_review_decisions d ON d.id=e.decision_id;

    DROP VIEW IF EXISTS application_material_baseline_status;
    CREATE VIEW application_material_baseline_status AS
      SELECT p.application_id,pm.slug AS preparation_mode,k.slug AS material_kind,
        req.id AS requirement_id,m.id AS material_id,h.revision_id AS head_revision_id,
        s.revision_id AS selected_revision_id,
        CASE WHEN s.revision_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM application_material_review_events e
          JOIN application_material_review_decisions d ON d.id=e.decision_id
          WHERE e.revision_id=s.revision_id AND d.is_approved=1
            AND e.id=(SELECT max(e2.id) FROM application_material_review_events e2 WHERE e2.revision_id=s.revision_id)
        ) THEN 1 ELSE 0 END AS has_approved_selection
      FROM application_preparation_plans p
      JOIN application_preparation_modes pm ON pm.id=p.mode_id
      JOIN application_material_requirements req ON req.application_id=p.application_id AND req.form_field_id IS NULL
      JOIN application_material_kinds k ON k.id=req.material_kind_id
      LEFT JOIN application_materials m ON m.application_id=p.application_id AND m.material_kind_id=k.id AND m.form_field_id IS NULL
      LEFT JOIN application_material_heads h ON h.material_id=m.id
      LEFT JOIN application_material_selections s ON s.material_id=m.id;
  `);
}

function ensureApplicationPreparationPlan(db, applicationId, options = {}) {
  const application = requireApplication(db, applicationId);
  let plan = readPreparationPlan(db, application.id);
  if (!plan) {
    const mode = options.mode || (application.workflow_stage === 'submitted' ? 'legacy-import' : 'managed');
    const modeId = vocabularyId(db, 'application_preparation_modes', mode, 'preparation mode');
    db.prepare('INSERT INTO application_preparation_plans(application_id,mode_id) VALUES (?,?)').run(application.id, modeId);
    ensureBaselineMaterialRows(db, application.id);
    plan = readPreparationPlan(db, application.id);
  }
  ensureBaselineMaterialRows(db, application.id);
  if (options.mode && plan.mode !== options.mode) {
    return setApplicationPreparationMode(db, {
      applicationId: application.id,
      mode: options.mode,
      expectedPlanVersion: plan.lock_version,
      actor: options.actor || 'jobtrack',
      reason: options.reason || `Set preparation mode to ${options.mode}`,
      idempotencyKey: options.idempotencyKey || `preparation-mode:${application.id}:${options.mode}:${plan.lock_version}`
    }).plan;
  }
  return plan;
}

function ensureBaselineMaterialRows(db, applicationId) {
  const requirednessId = vocabularyId(db, 'information_requiredness_levels', 'required', 'requiredness');
  const kinds = db.prepare("SELECT id FROM application_material_kinds WHERE slug IN ('resume','cover-letter') ORDER BY sort_rank").all();
  for (const kind of kinds) {
    db.prepare(`
      INSERT INTO application_material_requirements(application_id,material_kind_id,form_field_id,requiredness_id,source)
      VALUES (?,?,NULL,?,'baseline-policy') ON CONFLICT DO NOTHING
    `).run(applicationId, kind.id, requirednessId);
    db.prepare(`
      INSERT INTO application_materials(application_id,material_kind_id,form_field_id)
      VALUES (?,?,NULL) ON CONFLICT DO NOTHING
    `).run(applicationId, kind.id);
  }
}

function readPreparationPlan(db, applicationId) {
  return db.prepare(`
    SELECT p.*,m.slug AS mode,m.label AS mode_label
    FROM application_preparation_plans p JOIN application_preparation_modes m ON m.id=p.mode_id
    WHERE p.application_id=?
  `).get(applicationId) || null;
}

function setApplicationPreparationMode(db, input) {
  const applicationId = positiveId(input.applicationId, 'application id');
  requireApplication(db, applicationId);
  const mode = enumText(input.mode, PREPARATION_MODES, 'preparation mode');
  const actor = requiredText(input.actor, 'actor', 200);
  const reason = requiredText(input.reason, 'reason', 20000);
  const expected = nonnegativeInteger(input.expectedPlanVersion, 'expected plan version');
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key', 200);
  const intent = { applicationId, mode, actor, reason, expected };
  return idempotentOperation(db, 'set-preparation-mode', idempotencyKey, intent, () => {
    const plan = ensureApplicationPreparationPlan(db, applicationId);
    if (plan.lock_version !== expected) {
      throw new ApplicationMaterialsError('STALE_PREPARATION_PLAN', `Expected preparation plan version ${expected}, found ${plan.lock_version}`);
    }
    if (plan.mode === mode) return { plan, changed: false };
    const toModeId = vocabularyId(db, 'application_preparation_modes', mode, 'preparation mode');
    const intentSha = sha256(stableJson(intent));
    db.prepare(`
      INSERT INTO application_preparation_plan_events(
        application_id,from_mode_id,to_mode_id,expected_plan_version,actor,reason,idempotency_key,intent_sha256
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(applicationId, plan.mode_id, toModeId, expected, actor, reason, `${idempotencyKey}:event`, intentSha);
    const updated = db.prepare(`
      UPDATE application_preparation_plans SET mode_id=?,lock_version=lock_version+1,updated_at=datetime('now')
      WHERE application_id=? AND lock_version=?
    `).run(toModeId, applicationId, expected);
    if (updated.changes !== 1) throw new ApplicationMaterialsError('STALE_PREPARATION_PLAN', 'Preparation plan changed concurrently');
    return { plan: readPreparationPlan(db, applicationId), changed: true };
  });
}

function buildApplicationMaterialsContext(db, applicationId, options = {}) {
  const application = requireApplication(db, applicationId);
  const plan = readPreparationPlan(db, application.id);
  if (!plan) throw new ApplicationMaterialsError('PREPARATION_PLAN_MISSING', `Application ${application.id} has not been migrated for preparation`);
  const kind = options.kind ? enumText(options.kind, MATERIAL_KINDS, 'material kind') : null;
  const form = readApplicationFormState(db, application.id);
  const assessment = readCurrentAssessmentState(db, application.id);
  const eligibleProfileEntries = readEligibleProfileEntries(db, kind).filter((entry) => entry.category !== 'story');
  const eligibleArtifacts = db.prepare(`
    SELECT id,application_id,kind,title,source_url,source_name,citation,notes,content,attachment_path,
      opportunity_snapshot_id,captured_at,created_at
    FROM application_artifacts WHERE application_id=? ORDER BY id
  `).all(application.id);
  const artifactIds = parseIdList(options.artifactIds);
  const profileEntryIds = parseIdList(options.profileEntryIds);
  const storyUseIds = parseIdList(options.storyUseIds);
  const formFieldId = options.formFieldId === undefined || options.formFieldId === null || options.formFieldId === ''
    ? null
    : positiveId(options.formFieldId, 'form field id');
  if (formFieldId && kind !== 'form-answer') {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', 'A form field may be selected only for form-answer generation');
  }
  if (kind === 'form-answer' && !formFieldId) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', 'Form-answer generation context requires an exact form field id');
  }
  const selectedFormField = formFieldId ? getFormFieldDescriptorForApplication(db, application.id, formFieldId) : null;
  const parentRevisionId = parseExpectedId(options.parentRevisionId, 'parent revision id');
  const parentRevision = parentRevisionId ? getMaterialRevision(db, parentRevisionId, application.id) : null;
  if (parentRevision && (parentRevision.material_kind !== kind || (parentRevision.form_field_id || null) !== formFieldId)) {
    throw new ApplicationMaterialsError('SOURCE_SCOPE_MISMATCH', 'Parent revision must belong to the exact material kind and form field being generated');
  }
  const artifacts = selectManifestRows({ rows: eligibleArtifacts, ids: artifactIds, label: 'artifact' });
  const profileEntries = selectManifestRows({ rows: eligibleProfileEntries, ids: profileEntryIds, label: 'profile entry' });
  const storyUses = readStoryUses(db, application.id, kind, storyUseIds);
  const selectedGeneration = Boolean(
    options.selectedGeneration || formFieldId || parentRevisionId
      || artifactIds.length || profileEntryIds.length || storyUseIds.length
  );
  if (!selectedGeneration) {
    return {
      mode: 'source-catalog',
      application: generationApplication(application),
      plan: pick(plan, ['application_id', 'mode', 'lock_version']),
      form: generationFormCatalog(form),
      assessment: {
        assessmentId: assessment.assessment?.id || null,
        assessmentGateId: assessment.finalEvidenceApproved ? assessment.gate.id : null,
        finalEvidenceApproved: assessment.finalEvidenceApproved
      },
      availableSources: {
        artifacts: eligibleArtifacts.map((row) => pick(row, ['id', 'kind', 'title', 'source_name', 'captured_at', 'created_at'])),
        profileEntries: eligibleProfileEntries.map((row) => ({
          ...pick(row, ['id', 'category', 'title', 'source', 'recency', 'confidence', 'tags']),
          ...(row.workDetails ? { workDetailCount: row.workDetails.length } : {})
        })),
        storyUses: listAvailableStoryUses(db, application.id, kind),
        formFields: form.fields.map(generationFormFieldCatalogRecord),
        // Optional masters: metadata only here; read the payload via
        // `jobtrack profile show-material-master`. A recorded master is a
        // curated bullet library, not a script — language is generated per
        // application from the pool.
        materialMasters: listMaterialMasters(db).map((row) => pick(row, [
          'kind', 'version', 'template_key', 'payload_sha256', 'authored_by', 'created_at'
        ])),
        // Tailoring input: the linked posting's captured skill requirements.
        // Work required/preferred skills into the payload wherever real
        // evidence exists — never keyword-stuff without evidence.
        postingSkillRequirements: readPostingSkillRequirements(db, application)
      },
      informationRequests: readInformationRequests(db, application).map(generationInformationRequestCatalogRecord),
      materials: listMaterialCatalog(db, application.id),
      outputContract: materialOutputContract(kind),
      sourceStateSha256: null
    };
  }
  const sourceState = canonicalSourceState({
    application, plan, materialKind: kind, formFieldId, assessment, form, selectedFormField,
    parentRevision, profileEntries, artifacts, storyUses, db
  });
  return {
    mode: 'selected-generation',
    application: sourceState.application,
    plan: sourceState.plan,
    materialKind: kind,
    formFieldId,
    form: sourceState.form,
    assessment: sourceState.assessment,
    parentRevision: sourceState.parentRevision,
    profileEntries,
    artifacts,
    storyUses,
    outputContract: materialOutputContract(kind),
    sourceStateSha256: sha256(stableJson(sourceState))
  };
}

/** The linked posting's captured skill requirements — the keyword side of
 * tailoring. Empty until `catalog posting add-skill-requirement` populates
 * the posting; catalog metadata, deliberately not pinned into source state. */
function readPostingSkillRequirements(db, application) {
  if (!application.primary_job_posting_id) return [];
  if (!tableExists(db, 'posting_skill_requirements') || !tableExists(db, 'skills')) return [];
  return db.prepare(`
    SELECT r.id, s.canonical_name AS skill, s.slug AS skill_slug,
      k.slug AS requirement_kind, r.raw_phrase, r.minimum_years
    FROM posting_skill_requirements r
    JOIN skills s ON s.id=r.skill_id
    JOIN requirement_kinds k ON k.id=r.requirement_kind_id
    WHERE r.job_posting_id=?
    ORDER BY k.sort_rank DESC, s.canonical_name
  `).all(application.primary_job_posting_id);
}

function materialOutputContract(kind) {
  if (kind === 'resume' || kind === 'cover-letter') {
    return {
      sourceFormat: 'latex',
      contractVersion: LATEX_DOCUMENT_CONTRACT_VERSION,
      completeDocument: true,
      selfContained: true,
      outputFormat: 'pdf',
      externalInputsAllowed: false
    };
  }
  if (kind === 'form-answer') {
    return {
      sourceFormat: 'plain-text',
      contractVersion: FORM_ANSWER_CONTRACT_VERSION,
      completeDocument: false,
      selfContained: true,
      outputFormat: 'text',
      externalInputsAllowed: false
    };
  }
  return null;
}

function generationApplication(application) {
  return pick(application, [
    'id', 'company', 'role', 'job_url', 'source_opportunity_id',
    'job_opening_id', 'primary_job_posting_id'
  ]);
}

function generationFormCatalog(form) {
  return pick(form, ['available', 'currentCaptureId', 'coverageState', 'reviewed', 'stale', 'stateSha256']);
}

function generationFormFieldCatalogRecord(field) {
  const record = pick(field, [
    'id', 'surfaceId', 'jobPostingId', 'revisionId', 'input_kind', 'requiredness',
    'observation_state', 'is_repeatable', 'fulfillment', 'protected'
  ]);
  if (!field.protected) record.information_field_slug = field.information_field_slug || null;
  return record;
}

function generationInformationRequestCatalogRecord(request) {
  const record = pick(request, [
    'id', 'request_scope', 'information_field_id', 'requiredness', 'assessment_state',
    'job_posting_id', 'effective_job_posting_id', 'opportunity_snapshot_id', 'resolution_current'
  ]);
  record.protected = request.protected === true || informationRequestIsProtected(request);
  if (record.protected) record.information_field = 'protected-profile-information';
  else record.information_field_slug = request.information_field_slug;
  return record;
}

function listMaterialCatalog(db, applicationId) {
  return db.prepare(`
    SELECT m.id,m.form_field_id,k.slug AS kind,h.revision_id AS head_revision_id,
      hr.revision_number AS head_revision_number,hr.revision_stage_id,hr.content_sha256 AS head_content_sha256,
      s.revision_id AS selected_revision_id,s.lock_version AS selection_lock_version
    FROM application_materials m
    JOIN application_material_kinds k ON k.id=m.material_kind_id
    LEFT JOIN application_material_heads h ON h.material_id=m.id
    LEFT JOIN application_material_revisions hr ON hr.id=h.revision_id
    LEFT JOIN application_material_selections s ON s.material_id=m.id
    WHERE m.application_id=? ORDER BY k.sort_rank,m.form_field_id,m.id
  `).all(applicationId);
}

function readApplicationFormState(db, applicationId) {
  const application = requireApplication(db, applicationId);
  const surfaces = db.prepare(`
    SELECT DISTINCT s.*
    FROM application_form_surfaces s
    LEFT JOIN application_application_form_surfaces al
      ON al.surface_id=s.id AND al.application_id=@applicationId
    LEFT JOIN opportunity_application_form_surfaces ol
      ON ol.surface_id=s.id AND ol.opportunity_id=@sourceOpportunityId
    WHERE al.application_id IS NOT NULL OR ol.opportunity_id IS NOT NULL
    ORDER BY CASE WHEN s.job_posting_id=@primaryPostingId THEN 0 ELSE 1 END,s.id
  `).all({
    applicationId: application.id,
    sourceOpportunityId: application.source_opportunity_id || null,
    primaryPostingId: application.primary_job_posting_id || null
  });
  const selectedSurfaces = application.primary_job_posting_id
    ? surfaces.filter((surface) => surface.job_posting_id === application.primary_job_posting_id)
    : surfaces;
  const scopedSurfaces = application.primary_job_posting_id ? selectedSurfaces : surfaces;
  const models = scopedSurfaces.map((surface) => readFormSurfaceState(db, surface));
  const fields = models.flatMap((surface) => surface.fields);
  const coverageComplete = models.length > 0 && models.every((surface) => surface.coverageState === 'complete');
  const reviewed = models.length > 0 && models.every((surface) => surface.reviewDecision === 'approved' && surface.pendingRevisionIds.length === 0);
  const stale = models.some((surface) => surface.coverageAttestation?.attestation_kind === 'stale');
  const snapshot = {
    surfaces: models.map((surface) => ({
      id: surface.id,
      postingId: surface.jobPostingId,
      revisionId: surface.revisionId,
      observationSha256: surface.observationSha256,
      coverageState: surface.coverageState,
      reviewDecision: surface.reviewDecision,
      pendingRevisionIds: surface.pendingRevisionIds,
      coverageAttestation: surface.coverageAttestation
    })),
    fields: fields.map(formFieldDigestRecord)
  };
  return {
    available: models.some((model) => model.revisionId !== null),
    surfaces: models,
    currentCaptureId: models.length === 1 ? models[0].revisionId : null,
    coverageState: models.length === 0 ? 'unknown' : coverageComplete ? 'complete' : 'partial',
    reviewed,
    stale,
    fields,
    snapshot,
    stateSha256: sha256(stableJson(snapshot))
  };
}

function readFormSurfaceState(db, surface) {
  const selection = db.prepare('SELECT * FROM application_form_revision_selections WHERE surface_id=? ORDER BY id DESC LIMIT 1').get(surface.id);
  const selectedRevisionId = selection && (selection.revision_id || selection.selected_revision_id);
  const revision = selectedRevisionId
    ? db.prepare('SELECT * FROM application_form_revisions WHERE id=? AND surface_id=?').get(selectedRevisionId, surface.id)
    : db.prepare('SELECT * FROM application_form_revisions WHERE surface_id=? ORDER BY observed_at DESC,id DESC LIMIT 1').get(surface.id);
  if (!revision) {
    return {
      id: surface.id, jobPostingId: surface.job_posting_id, revisionId: null,
      observationSha256: null, coverageState: 'unknown', reviewDecision: null,
      pendingRevisionIds: [], coverageAttestation: null, fields: []
    };
  }
  const coverage = db.prepare('SELECT slug FROM application_form_coverage_states WHERE id=?').get(revision.coverage_state_id);
  const review = db.prepare(`
    SELECT rr.*,d.slug AS decision
    FROM application_form_revision_reviews rr
    JOIN application_form_review_decisions d ON d.id=rr.decision_id
    WHERE rr.revision_id=? ORDER BY rr.id DESC LIMIT 1
  `).get(revision.id);
  const attestation = tableExists(db, 'application_form_coverage_attestations')
    ? db.prepare('SELECT * FROM application_form_coverage_attestations WHERE revision_id=? ORDER BY id DESC LIMIT 1').get(revision.id)
    : null;
  const pendingRevisionIds = selectedRevisionId
    ? db.prepare(`
      SELECT candidate.id
      FROM application_form_revisions candidate
      WHERE candidate.surface_id=? AND candidate.id>?
        AND NOT EXISTS (
          SELECT 1
          FROM application_form_revision_reviews latest
          JOIN application_form_review_decisions decision ON decision.id=latest.decision_id
          WHERE latest.revision_id=candidate.id
            AND latest.id=(SELECT max(review.id) FROM application_form_revision_reviews review WHERE review.revision_id=candidate.id)
            AND decision.slug='rejected'
        )
      ORDER BY candidate.id
    `).all(surface.id, selectedRevisionId).map((row) => row.id)
    : [];
  const fields = db.prepare(`
    SELECT f.*,ik.slug AS input_kind,req.slug AS requiredness,sens.slug AS sensitivity,
      obs.slug AS observation_state,pif.slug AS information_field_slug
    FROM application_form_fields f
    JOIN application_form_input_kinds ik ON ik.id=f.input_kind_id
    JOIN information_requiredness_levels req ON req.id=f.requiredness_id
    JOIN information_sensitivity_levels sens ON sens.id=f.sensitivity_level_id
    JOIN application_form_observation_states obs ON obs.id=f.observation_state_id
    LEFT JOIN profile_information_fields pif ON pif.id=f.profile_information_field_id
    WHERE f.revision_id=? ORDER BY f.step_id,f.position,f.id
  `).all(revision.id).map((field) => ({
    ...field,
    surfaceId: surface.id,
    jobPostingId: surface.job_posting_id,
    revisionId: revision.id,
    protected: isProtectedApplicationField(field),
    fulfillment: classifyFormField(field)
  }));
  return {
    id: surface.id,
    jobPostingId: surface.job_posting_id,
    revisionId: revision.id,
    observationSha256: revision.observation_sha256,
    coverageState: coverage?.slug || 'unknown',
    reviewDecision: review?.decision || null,
    pendingRevisionIds,
    coverageAttestation: attestation ? pick(attestation, ['id', 'attestation_kind', 'attested_by', 'attested_at']) : null,
    fields
  };
}

function classifyFormField(field) {
  if (field.information_field_slug === 'resume') return 'resume';
  if (field.information_field_slug === 'cover-letter') return 'cover-letter';
  if (field.protected || isProtectedApplicationField(field)) return 'protected-human-only';
  if (field.profile_information_field_id) return 'profile-information';
  if (['file', 'file-upload', 'hidden', 'system'].includes(field.input_kind)) return 'human-response';
  return 'generated-answer';
}

function formFieldDigestRecord(field) {
  return pick(field, [
    'id', 'surfaceId', 'revisionId', 'step_id', 'position', 'provider_field_key', 'label', 'help_text',
    'input_kind', 'requiredness', 'sensitivity', 'profile_information_field_id', 'information_field_slug',
    'observation_state', 'is_repeatable', 'fulfillment', 'protected'
  ]);
}

function getFormFieldDescriptorForApplication(db, applicationId, formFieldId) {
  const form = readApplicationFormState(db, applicationId);
  const field = form.fields.find((candidate) => candidate.id === Number(formFieldId));
  if (!field) {
    throw new ApplicationMaterialsError(
      'FORM_FIELD_SCOPE_MISMATCH',
      `Form field ${formFieldId} is not part of the current application-form state for application ${applicationId}`
    );
  }
  return field;
}

function readCurrentAssessmentState(db, applicationId) {
  const assessment = db.prepare('SELECT * FROM application_assessments WHERE application_id=? ORDER BY id DESC LIMIT 1').get(applicationId) || null;
  if (!assessment) return { assessment: null, gate: null, currentApproved: false, finalEvidenceApproved: false };
  const gate = db.prepare('SELECT * FROM assessment_review_gates WHERE application_id=? ORDER BY id DESC LIMIT 1').get(applicationId) || null;
  return {
    assessment,
    gate,
    currentApproved: Boolean(gate && gate.decision === 'approved' && gate.artifact_id === assessment.artifact_id),
    finalEvidenceApproved: Boolean(gate && gate.decision === 'approved' && gate.artifact_id === assessment.artifact_id)
  };
}

function readEligibleProfileEntries(db, kind) {
  const purpose = kind === 'resume' ? 'resume' : kind === 'cover-letter' ? 'cover_letter' : kind === 'form-answer' ? 'application_form' : null;
  const rows = db.prepare('SELECT * FROM profile_entries ORDER BY id').all();
  return rows.filter((entry) => {
    // Operator-hidden entries are never material: absent from the catalog,
    // and selecting their id fails closed via selectManifestRows. Their ledger
    // nodes vanish with them, because nodes ride on the entry below.
    if (entry.generation_hidden) return false;
    if (entry.category !== 'story') return true;
    if (!purpose || !tableExists(db, 'profile_stories')) return false;
    return Boolean(db.prepare(`
      SELECT 1 FROM profile_stories s
      LEFT JOIN profile_story_permissions p ON p.story_id=s.id AND p.purpose=?
      WHERE s.profile_entry_id=? AND s.status='ready'
        AND COALESCE(CASE WHEN p.expires_at IS NULL OR datetime(p.expires_at)>datetime('now') THEN p.decision END,s.default_use_decision)='allow'
    `).get(purpose, entry.id));
  }).map((entry) => {
    const parsed = { ...entry, tags: parseJson(entry.tags, []) };
    // Citable fact-ledger nodes (human-authored, non-confidential) travel with
    // their work entry: the generation context exposes them as `workDetails`
    // and hashProfileEntry pins their content, so a new or edited node makes
    // every earlier selection stale. Attached only when present, so entries
    // without nodes keep their historical digest byte-for-byte.
    if (entry.category === 'work') {
      const workDetails = listCitableWorkDetails(db, entry.id);
      if (workDetails.length) parsed.workDetails = workDetails;
    }
    return parsed;
  });
}

function readInformationRequests(db, application) {
  if (!tableExists(db, 'application_information_request_current')) return [];
  return readEffectiveApplicationInformationRequests(db, application.id).map((request) => ({
    ...request,
    information_sensitivity: request.sensitivity,
    protected: informationRequestIsProtected(request),
    resolution_current: request.resolution_current === true
  }));
}

function informationRequestIsProtected(request) {
  return isProtectedApplicationField({
    providerFieldKey: request.information_field_slug,
    label: request.requested_label || request.information_field_label,
    helpText: request.raw_prompt,
    sensitivity: request.information_sensitivity
  });
}

function sanitizeGenerationInformationRequest(request) {
  const protectedRequest = request.protected === true || informationRequestIsProtected(request);
  const common = pick(request, [
    'id', 'request_scope', 'information_field_id', 'requiredness', 'assessment_state', 'is_gap',
    'job_posting_id', 'opportunity_snapshot_id', 'observed_at', 'resolution_current'
  ]);
  if (protectedRequest) {
    return { ...common, protected: true, information_field: 'protected-profile-information' };
  }
  return {
    ...common,
    protected: false,
    information_field_slug: request.information_field_slug,
    information_field_label: request.information_field_label,
    requested_label: request.requested_label,
    raw_prompt: request.raw_prompt,
    source: request.source,
    source_url: request.source_url
  };
}

function sanitizeGenerationFormState(form) {
  const sanitizeField = (field) => {
    if (!field?.protected) return field;
    return {
      ...field,
      provider_field_key: null,
      label: 'Protected application field',
      help_text: null,
      visibility_condition: null,
      constraints_json: '{}',
      information_field_slug: null
    };
  };
  return {
    ...form,
    fields: form.fields.map(sanitizeField),
    surfaces: form.surfaces.map((surface) => ({
      ...surface,
      fields: surface.fields.map(sanitizeField)
    })),
    snapshot: {
      ...form.snapshot,
      fields: form.snapshot.fields.map(sanitizeField)
    }
  };
}

function canonicalSourceState(input) {
  return {
    application: generationApplication(input.application),
    plan: pick(input.plan, ['application_id', 'mode', 'lock_version']),
    materialKind: input.materialKind,
    formFieldId: input.formFieldId || null,
    assessment: input.assessment,
    form: {
      ...generationFormCatalog(input.form),
      field: generationFormFieldContext(input.db, input.selectedFormField)
    },
    parentRevision: generationParentRevision(input.parentRevision, Boolean(input.selectedFormField?.protected)),
    artifacts: input.artifacts.map((row) => ({ id: row.id, sha256: hashArtifact(row) })),
    profileEntries: input.profileEntries.filter((entry) => entry.category !== 'story').map((row) => ({ id: row.id, sha256: hashProfileEntry(row) })),
    storyUses: input.storyUses.map((row) => ({ id: row.id, sha256: hashStoryUse(row) }))
  };
}

function generationFormFieldContext(db, field) {
  if (!field) return null;
  if (field.protected) return generationFormFieldCatalogRecord(field);
  return {
    ...pick(field, [
      'id', 'surfaceId', 'jobPostingId', 'revisionId', 'step_id', 'position', 'provider_field_key',
      'label', 'help_text', 'input_kind', 'requiredness', 'sensitivity', 'profile_information_field_id',
      'information_field_slug', 'observation_state', 'is_repeatable', 'visibility_condition',
      'constraints_json', 'fulfillment', 'protected'
    ]),
    options: db.prepare(`
      SELECT id,provider_option_key,label,position
      FROM application_form_field_options WHERE field_id=? ORDER BY position,id
    `).all(field.id)
  };
}

function generationParentRevision(revision, protectedField) {
  if (!revision) return null;
  const metadata = pick(revision, [
    'id', 'material_id', 'application_id', 'material_kind', 'form_field_id', 'revision_number',
    'revision_stage', 'content_sha256', 'source_manifest_id', 'authorship', 'authored_by', 'created_at'
  ]);
  return protectedField ? metadata : { ...metadata, content: revision.content };
}

function createMaterialDraft(db, input) {
  const applicationId = positiveId(input.applicationId, 'application id');
  const application = requireApplication(db, applicationId);
  ensureApplicationPreparationPlan(db, applicationId);
  const kind = enumText(input.kind, MATERIAL_KINDS, 'material kind');
  const formFieldId = kind === 'form-answer' ? positiveId(input.formFieldId, 'form field id') : null;
  if (kind !== 'form-answer' && input.formFieldId !== undefined && input.formFieldId !== null && input.formFieldId !== '') {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', 'Only form-answer materials accept a form field id');
  }
  const field = formFieldId ? getFormFieldDescriptorForApplication(db, applicationId, formFieldId) : null;
  const content = requiredText(input.content, 'content', MAX_MATERIAL_CONTENT_BYTES);
  if (field) {
    const constraintViolation = formAnswerConstraintViolation(field, content);
    if (constraintViolation) {
      throw new ApplicationMaterialsError('FORM_ANSWER_CONSTRAINT_VIOLATION', constraintViolation, { formFieldId: field.id });
    }
  }
  const authoredBy = requiredText(input.authoredBy, 'authored by', 200);
  const authorship = enumText(input.authorship || 'model', AUTHORSHIP_KINDS, 'authorship');
  if (field?.protected && authorship !== 'human') {
    throw new ApplicationMaterialsError('PROTECTED_FIELD', 'Consent, signature, password, EEO, demographic, and sensitive fields cannot be model-generated or imported');
  }
  if (field && ['resume', 'cover-letter', 'profile-information', 'human-response'].includes(field.fulfillment)) {
    throw new ApplicationMaterialsError('INVALID_FULFILLMENT', `Form field ${formFieldId} is fulfilled as ${field.fulfillment}, not as a versioned application answer`);
  }
  const formOptionIds = parseIdList(input.formOptionIds);
  if (!field && formOptionIds.length) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', 'Only form-answer revisions for choice fields accept form option ids');
  }
  const selectedFormOptions = field ? resolveFormOptionSelection(db, field, formOptionIds) : [];
  if (field && ['single-choice', 'multi-choice'].includes(field.input_kind)) {
    const canonicalChoiceContent = selectedFormOptions.map((option) => option.label).join(', ');
    if (content !== canonicalChoiceContent) {
      throw new ApplicationMaterialsError(
        'FORM_CHOICE_CONTENT_MISMATCH',
        `Choice answer content for form field ${field.id} must exactly match the selected option label(s): ${canonicalChoiceContent}`,
        { formFieldId: field.id, optionIds: selectedFormOptions.map((option) => option.id) }
      );
    }
  }
  const stage = enumText(input.stage || (input.parentRevisionId ? 'revised' : 'rough-draft'), new Set(['rough-draft', 'revised', 'final-candidate']), 'revision stage');
  const expectedHead = parseExpectedId(input.expectedHeadRevisionId, 'expected head revision id');
  const parentRevisionId = input.parentRevisionId === undefined || input.parentRevisionId === null || input.parentRevisionId === ''
    ? expectedHead
    : positiveId(input.parentRevisionId, 'parent revision id');
  const storyUseIds = parseIdList(input.storyUseIds);
  const artifactIds = parseIdList(input.artifactIds);
  const profileEntryIds = parseIdList(input.profileEntryIds);
  const expectedSourceStateSha256 = sha256Text(input.expectedSourceStateSha256, 'expected source-state SHA-256');
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key', 200);
  const changeNote = optionalText(input.changeNote, 'change note', 20000);
  // Template provenance: content arrives already expanded (the command layer
  // owns expansion); the template key + canonical payload ride along so the
  // revision is reproducible and reviewable at the CONTENT level.
  const templateKey = optionalText(input.templateKey, 'template key', 100);
  const templatePayload = input.templatePayloadJson === undefined || input.templatePayloadJson === null
    ? null
    : requiredText(input.templatePayloadJson, 'template payload', 128 * 1024);
  if (templatePayload !== null && templateKey === null) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', 'A template payload requires a template key');
  }
  const contentSha = sha256(content);
  const outputContract = materialOutputContract(kind);
  const sourceFormat = outputContract.sourceFormat;
  const generationContractVersion = outputContract.contractVersion;
  const intent = {
    applicationId, kind, formFieldId, contentSha, authoredBy, authorship, stage,
    expectedHead, parentRevisionId, storyUseIds, artifactIds, profileEntryIds,
    formOptionIds: selectedFormOptions.map((option) => option.id), expectedSourceStateSha256, changeNote,
    sourceFormat, generationContractVersion, templateKey, templatePayload
  };
  return idempotentOperation(db, 'create-material-draft', idempotencyKey, intent, () => {
    const currentContext = buildApplicationMaterialsContext(db, applicationId, {
      kind, formFieldId, parentRevisionId, artifactIds, profileEntryIds, storyUseIds,
      selectedGeneration: true
    });
    if (currentContext.sourceStateSha256 !== expectedSourceStateSha256) {
      throw new ApplicationMaterialsError(
        'STALE_GENERATION_CONTEXT',
        `Expected source state ${expectedSourceStateSha256}, found ${currentContext.sourceStateSha256}`
      );
    }
    const material = ensureMaterialIdentity(db, applicationId, kind, field);
    const head = db.prepare('SELECT * FROM application_material_heads WHERE material_id=?').get(material.id) || null;
    if ((head?.revision_id || null) !== expectedHead) {
      throw new ApplicationMaterialsError('STALE_MATERIAL_HEAD', `Expected material head ${expectedHead || 'none'}, found ${head?.revision_id || 'none'}`);
    }
    if (parentRevisionId !== (head?.revision_id || null)) {
      throw new ApplicationMaterialsError('STALE_MATERIAL_HEAD', 'A refinement must name the current head as its parent');
    }
    if (!head && stage !== 'rough-draft') {
      throw new ApplicationMaterialsError('INVALID_STAGE', 'The first material revision must be rough-draft');
    }
    if (head && stage === 'rough-draft') {
      throw new ApplicationMaterialsError('INVALID_STAGE', 'A subsequent material revision must be revised or final-candidate');
    }
    const manifest = createSourceManifest(db, {
      application,
      kind,
      formFieldId,
      parentRevisionId,
      authorship,
      storyUseIds,
      artifactIds,
      profileEntryIds,
      createdBy: authoredBy,
      idempotencyKey: `${idempotencyKey}:manifest`
    });
    if (manifest.source_manifest_sha256 !== expectedSourceStateSha256) {
      throw new ApplicationMaterialsError('STALE_GENERATION_CONTEXT', 'Pinned source evidence changed while the material revision was being created');
    }
    const revisionNumber = db.prepare('SELECT COALESCE(max(revision_number),0)+1 AS n FROM application_material_revisions WHERE material_id=?').get(material.id).n;
    const revisionStageId = vocabularyId(db, 'application_material_revision_stages', stage, 'revision stage');
    const authorshipId = vocabularyId(db, 'application_material_authorship_kinds', authorship, 'authorship');
    const revisionInfo = db.prepare(`
      INSERT INTO application_material_revisions(
        material_id,revision_number,parent_revision_id,source_manifest_id,content,content_sha256,
        revision_stage_id,authorship_kind_id,authored_by,change_note,idempotency_key,intent_sha256,
        source_format,generation_contract_version,template_key,template_payload
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      material.id, revisionNumber, parentRevisionId, manifest.id, content, contentSha,
      revisionStageId, authorshipId, authoredBy, changeNote, `${idempotencyKey}:revision`, sha256(stableJson(intent)),
      sourceFormat, generationContractVersion, templateKey, templatePayload
    );
    const revisionId = Number(revisionInfo.lastInsertRowid);
    const insertOption = db.prepare(`
      INSERT INTO application_material_revision_form_options(revision_id,form_field_id,option_id,selection_position)
      VALUES (?,?,?,?)
    `);
    selectedFormOptions.forEach((option, index) => insertOption.run(revisionId, formFieldId, option.id, index + 1));
    if (head) {
      const updated = db.prepare(`
        UPDATE application_material_heads SET revision_id=?,lock_version=lock_version+1,updated_at=datetime('now')
        WHERE material_id=? AND revision_id=? AND lock_version=?
      `).run(revisionId, material.id, expectedHead, head.lock_version);
      if (updated.changes !== 1) throw new ApplicationMaterialsError('STALE_MATERIAL_HEAD', 'Material head changed concurrently');
    } else {
      db.prepare('INSERT INTO application_material_heads(material_id,revision_id,lock_version) VALUES (?,?,0)').run(material.id, revisionId);
    }
    return {
      material: readMaterial(db, material.id),
      revision: getMaterialRevision(db, revisionId, applicationId),
      selectionUnchanged: true
    };
  });
}

function resolveFormOptionSelection(db, field, ids) {
  const isChoice = ['single-choice', 'multi-choice'].includes(field.input_kind);
  if (!isChoice) {
    if (ids.length) {
      throw new ApplicationMaterialsError('FORM_OPTIONS_NOT_ALLOWED', `Form field ${field.id} is ${field.input_kind}, not a choice field`);
    }
    return [];
  }
  const available = db.prepare(`
    SELECT * FROM application_form_field_options WHERE field_id=? ORDER BY position,id
  `).all(field.id);
  if (!available.length) {
    throw new ApplicationMaterialsError('FORM_OPTIONS_NOT_CAPTURED', `Choice field ${field.id} has no normalized options to bind`);
  }
  const constraints = parseJson(field.constraints_json, {});
  const capturedMin = constraints.minSelections !== null && constraints.minSelections !== undefined
    && Number.isSafeInteger(Number(constraints.minSelections)) ? Number(constraints.minSelections) : null;
  const capturedMax = constraints.maxSelections !== null && constraints.maxSelections !== undefined
    && Number.isSafeInteger(Number(constraints.maxSelections)) ? Number(constraints.maxSelections) : null;
  const minimum = field.input_kind === 'single-choice'
    ? 1
    : capturedMin ?? (BLOCKING_REQUIREDNESS.has(normalizeRequiredness(field.requiredness)) ? 1 : 0);
  const maximum = field.input_kind === 'single-choice' ? 1 : capturedMax ?? available.length;
  if (ids.length < minimum || ids.length > maximum) {
    throw new ApplicationMaterialsError(
      'FORM_OPTION_CARDINALITY',
      `Choice field ${field.id} requires ${minimum === maximum ? minimum : `${minimum}–${maximum}`} selected option(s)`
    );
  }
  const byId = new Map(available.map((option) => [option.id, option]));
  const selected = ids.map((id) => byId.get(id));
  if (selected.some((option) => !option)) {
    throw new ApplicationMaterialsError('FORM_OPTION_SCOPE_MISMATCH', `Every selected option must belong to form field ${field.id}`);
  }
  return selected;
}

function formAnswerConstraintViolation(field, content) {
  const constraints = parseJson(field.constraints_json, {});
  const length = Array.from(String(content)).length;
  const minLength = constraints.minLength !== null && constraints.minLength !== undefined
    && Number.isSafeInteger(Number(constraints.minLength)) ? Number(constraints.minLength) : null;
  const maxLength = constraints.maxLength !== null && constraints.maxLength !== undefined
    && Number.isSafeInteger(Number(constraints.maxLength)) ? Number(constraints.maxLength) : null;
  if (minLength !== null && length < minLength) {
    return `Answer for form field ${field.id} has ${length} characters; captured minimum is ${minLength}`;
  }
  if (maxLength !== null && length > maxLength) {
    return `Answer for form field ${field.id} has ${length} characters; captured maximum is ${maxLength}`;
  }
  return null;
}

function collectFormAnswerConstraintBlocker(field, state, blockers) {
  if (!state?.revision) return;
  const violation = formAnswerConstraintViolation(field, state.revision.content);
  if (violation) {
    blockers.push(blocker('FORM_ANSWER_CONSTRAINT_VIOLATION', violation, {
      formFieldId: field.id,
      revisionId: state.revision.id
    }));
  }
  if (['single-choice', 'multi-choice'].includes(field.input_kind)) {
    const canonicalChoiceContent = (state.revision.formOptions || []).map((option) => option.label).join(', ');
    if (state.revision.content !== canonicalChoiceContent) {
      blockers.push(blocker(
        'FORM_CHOICE_CONTENT_MISMATCH',
        `Choice answer for form field ${field.id} does not exactly match its bound option label(s).`,
        { formFieldId: field.id, revisionId: state.revision.id }
      ));
    }
  }
}

function ensureMaterialIdentity(db, applicationId, kind, field = null) {
  const kindId = vocabularyId(db, 'application_material_kinds', kind, 'material kind');
  const fieldId = field?.id || null;
  let material = fieldId
    ? db.prepare('SELECT * FROM application_materials WHERE application_id=? AND material_kind_id=? AND form_field_id=?').get(applicationId, kindId, fieldId)
    : db.prepare('SELECT * FROM application_materials WHERE application_id=? AND material_kind_id=? AND form_field_id IS NULL').get(applicationId, kindId);
  if (material) return material;
  if (fieldId) {
    const requirednessId = vocabularyId(db, 'information_requiredness_levels', normalizeRequiredness(field.requiredness), 'requiredness');
    db.prepare(`
      INSERT INTO application_material_requirements(application_id,material_kind_id,form_field_id,requiredness_id,source)
      VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING
    `).run(applicationId, kindId, fieldId, requirednessId, `application-form-revision:${field.revisionId}`);
  }
  const info = db.prepare('INSERT INTO application_materials(application_id,material_kind_id,form_field_id) VALUES (?,?,?)')
    .run(applicationId, kindId, fieldId);
  material = db.prepare('SELECT * FROM application_materials WHERE id=?').get(info.lastInsertRowid);
  return material;
}

function createSourceManifest(db, input) {
  const application = input.application;
  const plan = readPreparationPlan(db, application.id);
  const form = readApplicationFormState(db, application.id);
  const assessment = readCurrentAssessmentState(db, application.id);
  const selectedFormField = input.formFieldId ? getFormFieldDescriptorForApplication(db, application.id, input.formFieldId) : null;
  const parentRevision = input.parentRevisionId ? getMaterialRevision(db, input.parentRevisionId, application.id) : null;
  const eligibleArtifacts = db.prepare(`
    SELECT id,application_id,kind,title,source_url,source_name,citation,notes,content,attachment_path,
      opportunity_snapshot_id,captured_at,created_at
    FROM application_artifacts WHERE application_id=? ORDER BY id
  `).all(application.id);
  const eligibleProfileEntries = readEligibleProfileEntries(db, input.kind).filter((entry) => entry.category !== 'story');
  const storyUses = readStoryUses(db, application.id, input.kind, input.storyUseIds);
  const artifactIds = input.artifactIds || [];
  const profileEntryIds = input.profileEntryIds || [];
  const artifacts = selectManifestRows({
    rows: eligibleArtifacts,
    ids: artifactIds,
    label: 'artifact'
  });
  const profileEntries = selectManifestRows({
    rows: eligibleProfileEntries,
    ids: profileEntryIds,
    label: 'profile entry'
  });
  if (artifacts.length > 32 || profileEntries.length > 64 || storyUses.length > 32) {
    throw new ApplicationMaterialsError('SOURCE_MANIFEST_TOO_LARGE', 'A material manifest is limited to 32 artifacts, 64 profile entries, and 32 approved story uses');
  }
  const tailoredEvidence = artifacts.some((artifact) => ['posting', 'research'].includes(String(artifact.kind).toLowerCase()))
    || (input.kind === 'form-answer' && Boolean(selectedFormField));
  if (!tailoredEvidence) {
    throw new ApplicationMaterialsError('CUSTOMIZATION_EVIDENCE_REQUIRED', 'A custom material requires a same-application posting/research artifact or exact linked application-form capture');
  }
  const exactProtectedHumanAnswer = input.kind === 'form-answer'
    && selectedFormField?.protected === true
    && input.authorship === 'human';
  if (!profileEntries.length && !storyUses.length && !exactProtectedHumanAnswer) {
    throw new ApplicationMaterialsError('PROFILE_EVIDENCE_REQUIRED', 'A custom material requires at least one bounded profile or approved story-use input');
  }
  const sourceState = canonicalSourceState({
    application, plan, materialKind: input.kind, formFieldId: input.formFieldId || null,
    assessment, form, selectedFormField, parentRevision, profileEntries, artifacts, storyUses, db
  });
  const applicationSnapshot = sourceState.application;
  const assessmentSnapshot = assessment.assessment ? sourceState.assessment : null;
  const profileSnapshot = {
    entries: profileEntries.map((entry) => ({
      id: entry.id,
      sha256: hashProfileEntry(entry),
      // Per-node pins (plan §5 rule 1): cite pinned content, not live rows.
      ...(entry.workDetails ? { workDetails: entry.workDetails.map((node) => ({ id: node.id, sha256: sha256(stableJson(node)) })) } : {})
    })),
    storyUses: storyUses.map((use) => ({ id: use.id, sha256: hashStoryUse(use) }))
  };
  const manifestSha = sha256(stableJson(sourceState));
  const intent = {
    applicationId: application.id,
    kind: input.kind,
    formFieldId: input.formFieldId,
    parentRevisionId: input.parentRevisionId || null,
    authorship: input.authorship,
    manifestSha,
    createdBy: input.createdBy
  };
  const existing = db.prepare('SELECT * FROM application_material_source_manifests WHERE idempotency_key=?').get(input.idempotencyKey);
  if (existing) {
    if (existing.intent_sha256 !== sha256(stableJson(intent))) {
      throw new ApplicationMaterialsError('IDEMPOTENCY_CONFLICT', 'Source-manifest idempotency key was used for different inputs');
    }
    return existing;
  }
  const info = db.prepare(`
    INSERT INTO application_material_source_manifests(
      application_id,assessment_id,assessment_gate_id,form_capture_id,form_state_sha256,
      application_snapshot_json,assessment_snapshot_json,form_snapshot_json,profile_snapshot_json,
      source_manifest_sha256,created_by,idempotency_key,intent_sha256
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    application.id,
    assessment.assessment?.id || null,
    assessment.gate && assessment.gate.artifact_id === assessment.assessment?.artifact_id ? assessment.gate.id : null,
    form.currentCaptureId,
    form.stateSha256,
    stableJson(applicationSnapshot),
    assessmentSnapshot ? stableJson(assessmentSnapshot) : null,
    stableJson(sourceState.form),
    stableJson(profileSnapshot),
    manifestSha,
    input.createdBy,
    input.idempotencyKey,
    sha256(stableJson(intent))
  );
  const manifestId = Number(info.lastInsertRowid);
  const insertArtifact = db.prepare('INSERT INTO application_material_manifest_artifacts(manifest_id,artifact_id,content_sha256) VALUES (?,?,?)');
  for (const artifact of artifacts) insertArtifact.run(manifestId, artifact.id, hashArtifact(artifact));
  const insertProfile = db.prepare('INSERT INTO application_material_manifest_profile_entries(manifest_id,profile_entry_id,content_sha256) VALUES (?,?,?)');
  for (const entry of profileEntries) insertProfile.run(manifestId, entry.id, hashProfileEntry(entry));
  const insertUse = db.prepare('INSERT INTO application_material_manifest_story_uses(manifest_id,story_use_id,content_sha256) VALUES (?,?,?)');
  for (const use of storyUses) insertUse.run(manifestId, use.id, hashStoryUse(use));
  return db.prepare('SELECT * FROM application_material_source_manifests WHERE id=?').get(manifestId);
}

function readStoryUses(db, applicationId, kind, ids) {
  if (!ids.length) return [];
  const purpose = kind === 'resume' ? 'resume' : kind === 'cover-letter' ? 'cover_letter' : 'application_form';
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT u.*,r.canonical_text,v.content AS variant_content
    FROM profile_story_uses u
    JOIN profile_story_revisions r ON r.id=u.revision_id
    LEFT JOIN profile_story_variants v ON v.id=u.variant_id
    WHERE u.id IN (${placeholders}) AND u.application_id=? AND u.purpose=? ORDER BY u.id
  `).all(...ids, applicationId, purpose);
  if (rows.length !== ids.length) {
    throw new ApplicationMaterialsError('STORY_USE_SCOPE_MISMATCH', `Every story use must belong to application ${applicationId} and purpose ${purpose}`);
  }
  return rows;
}

function listAvailableStoryUses(db, applicationId, kind) {
  const purpose = kind === 'resume' ? 'resume' : kind === 'cover-letter' ? 'cover_letter' : 'application_form';
  return db.prepare(`
    SELECT u.id,u.story_id,u.revision_id,u.variant_id,u.purpose,u.target_kind,u.target_id,u.used_at,u.created_at
    FROM profile_story_uses u WHERE u.application_id=? AND u.purpose=? ORDER BY u.id
  `).all(applicationId, purpose);
}

function createMaterialRender(db, input) {
  const applicationId = positiveId(input.applicationId, 'application id');
  const revisionId = positiveId(input.revisionId, 'revision id');
  const revision = getMaterialRevision(db, revisionId, applicationId);
  if (!['resume', 'cover-letter'].includes(revision.material_kind)) {
    throw new ApplicationMaterialsError('INVALID_MATERIAL_KIND', 'Only resume and cover-letter revisions can be rendered');
  }
  if (revision.source_format !== 'latex'
    || revision.generation_contract_version !== LATEX_DOCUMENT_CONTRACT_VERSION) {
    throw new ApplicationMaterialsError('INVALID_SOURCE_FORMAT', 'Document rendering requires a v1 complete LaTeX material revision');
  }
  const expectedContentSha256 = sha256Text(input.expectedContentSha256, 'expected content SHA-256');
  if (revision.content_sha256 !== expectedContentSha256) {
    throw new ApplicationMaterialsError(
      'STALE_MATERIAL_SOURCE',
      `Expected material content ${expectedContentSha256}, found ${revision.content_sha256}`
    );
  }
  const renderedBy = requiredText(input.renderedBy, 'rendered by', 200);
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key', 200);
  const intent = { applicationId, revisionId, expectedContentSha256, renderedBy };
  const result = idempotentOperation(db, 'create-material-render', idempotencyKey, intent, () => {
    const rendered = typeof input.renderMaterial === 'function'
      ? input.renderMaterial({
        applicationId,
        revisionId,
        content: revision.content,
        contentSha256: revision.content_sha256,
        materialKind: revision.material_kind
      })
      : input.renderResult;
    return persistMaterialRenderRecord(db, {
      applicationId,
      revisionId,
      expectedContentSha256,
      renderedBy,
      idempotencyKey,
      intentSha256: sha256(stableJson(intent)),
      rendered
    });
  });
  const render = getMaterialRender(db, result.render.id, applicationId);
  assertMaterialRenderIntegrity(db, render.id, applicationId);
  return { ...result, render };
}

function persistMaterialRenderRecord(db, input) {
  const {
    applicationId, revisionId, expectedContentSha256, renderedBy,
    idempotencyKey, intentSha256, rendered
  } = input;
  if (!rendered || typeof rendered !== 'object' || Array.isArray(rendered)) {
    throw new ApplicationMaterialsError('RENDER_RESULT_INVALID', 'The fixed renderer did not return a render result');
  }
  const rendererProfile = requiredText(rendered.rendererProfile, 'renderer profile', 100);
  if (rendererProfile !== LATEX_RENDERER_PROFILE) {
    throw new ApplicationMaterialsError('RENDERER_PROFILE_MISMATCH', `Renderer profile must be ${LATEX_RENDERER_PROFILE}`);
  }
  const rendererImageDigest = requiredText(rendered.rendererImageDigest, 'renderer image digest', 200);
  if (!/^(?:sha256:)?[a-f0-9]{12,64}$/.test(rendererImageDigest)) {
    throw new ApplicationMaterialsError('RENDER_RESULT_INVALID', 'Renderer image digest must be a lowercase image digest');
  }
  const rendererVersion = requiredText(rendered.rendererVersion, 'renderer version', 200);
  const bundleSha256 = sha256Text(rendered.bundleSha256, 'renderer bundle SHA-256');
  const outputSha256 = sha256Text(rendered.outputSha256, 'rendered PDF SHA-256');
  const extractedTextSha256 = sha256Text(rendered.extractedTextSha256, 'rendered text SHA-256');
  const activeContentPolicy = requiredText(rendered.activeContentPolicy, 'PDF active-content policy', 100);
  const activeContentScanSha256 = sha256Text(rendered.activeContentScanSha256, 'PDF active-content scan SHA-256');
  if (activeContentPolicy !== PDF_ACTIVE_CONTENT_POLICY
    || activeContentScanSha256 !== expectedActiveContentScanSha256(outputSha256)) {
    throw new ApplicationMaterialsError(
      'RENDER_OUTPUT_ACTIVE_CONTENT_SCAN_INVALID',
      'Rendered PDF does not carry a valid byte-bound active-content scan result'
    );
  }
  const outputBytes = positiveId(rendered.outputBytes, 'rendered PDF byte count');
  if (outputBytes > MAX_RENDERED_DOCUMENT_BYTES) {
    throw new ApplicationMaterialsError('RENDER_OUTPUT_TOO_LARGE', `Rendered PDF exceeds ${MAX_RENDERED_DOCUMENT_BYTES} bytes`);
  }
  const pageCount = positiveId(rendered.pageCount, 'rendered PDF page count');
  if (pageCount > 20) throw new ApplicationMaterialsError('RENDER_OUTPUT_INVALID', 'Rendered PDF exceeds 20 pages');
  const outputAbsolutePath = managedMaterialRenderPath(rendered.outputAttachmentPath, db);
  const outputAttachmentPath = relativeMaterialRenderPath(outputAbsolutePath, db);
  const stat = fs.statSync(outputAbsolutePath);
  if (stat.size !== outputBytes) {
    throw new ApplicationMaterialsError('RENDER_OUTPUT_SIZE_MISMATCH', 'Rendered PDF byte count changed before it could be recorded');
  }
  const descriptor = fs.openSync(outputAbsolutePath, 'r');
  try {
    const magic = Buffer.alloc(5);
    if (fs.readSync(descriptor, magic, 0, magic.length, 0) !== magic.length || magic.toString('ascii') !== '%PDF-') {
      throw new ApplicationMaterialsError('RENDER_OUTPUT_INVALID', 'Rendered output is not a PDF');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const computedSha256 = hashFileLimited(outputAbsolutePath, MAX_RENDERED_DOCUMENT_BYTES, 'rendered application document');
  if (computedSha256 !== outputSha256) {
    throw new ApplicationMaterialsError('RENDER_OUTPUT_DIGEST_MISMATCH', 'Rendered PDF bytes do not match the renderer digest');
  }
  // The extracted text is part of the render contract now: the lint gate reads
  // it host-side, and its bytes must hash to the digest the renderer recorded.
  if (!rendered.extractedTextAttachmentPath) {
    throw new ApplicationMaterialsError('RENDER_RESULT_INVALID', 'The renderer must persist its extracted document text beside the PDF');
  }
  const textAbsolutePath = managedMaterialRenderPath(rendered.extractedTextAttachmentPath, db);
  const extractedTextAttachmentPath = relativeMaterialRenderPath(textAbsolutePath, db);
  const computedTextSha256 = hashFileLimited(textAbsolutePath, MAX_RENDERED_DOCUMENT_BYTES, 'rendered document text');
  if (computedTextSha256 !== extractedTextSha256) {
    throw new ApplicationMaterialsError('RENDER_TEXT_DIGEST_MISMATCH', 'Persisted extracted text does not match the renderer text digest');
  }
  const info = db.prepare(`
    INSERT INTO application_material_renders(
      application_id,revision_id,source_format,output_format,source_sha256,
      renderer_profile,renderer_image_digest,renderer_version,bundle_sha256,
      output_attachment_path,output_sha256,output_bytes,page_count,extracted_text_sha256,
      active_content_policy,active_content_scan_sha256,rendered_by,idempotency_key,intent_sha256,
      extracted_text_attachment_path
    ) VALUES (?,?,'latex','pdf',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    applicationId, revisionId, expectedContentSha256,
    rendererProfile, rendererImageDigest, rendererVersion, bundleSha256,
    outputAttachmentPath, outputSha256, outputBytes, pageCount, extractedTextSha256,
    activeContentPolicy, activeContentScanSha256,
    renderedBy, `${idempotencyKey}:render`, intentSha256,
    extractedTextAttachmentPath
  );
  return { render: getMaterialRender(db, Number(info.lastInsertRowid), applicationId), reused: false };
}

function getMaterialRender(db, renderId, applicationId = null) {
  const id = positiveId(renderId, 'material render id');
  const row = db.prepare(`
    SELECT render.*,material.material_id,material.material_kind,material.content_sha256 AS revision_content_sha256,
      material.source_format AS revision_source_format,
      material.generation_contract_version AS revision_contract_version
    FROM application_material_renders render
    JOIN application_material_revision_current_state material ON material.id=render.revision_id
    WHERE render.id=?
  `).get(id);
  if (!row || (applicationId && row.application_id !== Number(applicationId))) {
    throw new ApplicationMaterialsError('NOT_FOUND', `Application material render ${id} not found`);
  }
  return row;
}

function listMaterialRenders(db, revisionId, applicationId = null) {
  const revision = getMaterialRevision(db, revisionId, applicationId);
  return db.prepare('SELECT id FROM application_material_renders WHERE revision_id=? ORDER BY id DESC')
    .all(revision.id).map((row) => getMaterialRender(db, row.id, revision.application_id));
}

function assertMaterialRenderIntegrity(db, renderId, applicationId = null) {
  const render = typeof renderId === 'object' && renderId
    ? renderId
    : getMaterialRender(db, renderId, applicationId);
  if (applicationId && render.application_id !== Number(applicationId)) {
    throw new ApplicationMaterialsError('NOT_FOUND', `Application material render ${render.id} not found`);
  }
  if (render.source_sha256 !== render.revision_content_sha256
    || render.revision_source_format !== 'latex'
    || render.revision_contract_version !== LATEX_DOCUMENT_CONTRACT_VERSION) {
    throw new ApplicationMaterialsError('MATERIAL_RENDER_SOURCE_STALE', 'Rendered PDF no longer matches its immutable LaTeX revision');
  }
  const absolutePath = managedMaterialRenderPath(render.output_attachment_path, db);
  const stat = fs.statSync(absolutePath);
  if (stat.size !== render.output_bytes) {
    throw new ApplicationMaterialsError('MATERIAL_PDF_INTEGRITY_MISMATCH', 'Rendered PDF byte count changed after rendering');
  }
  const actualSha256 = hashFileLimited(absolutePath, MAX_RENDERED_DOCUMENT_BYTES, 'rendered application document');
  if (actualSha256 !== render.output_sha256) {
    throw new ApplicationMaterialsError('MATERIAL_PDF_INTEGRITY_MISMATCH', 'Rendered PDF bytes changed after rendering');
  }
  if (render.active_content_policy !== PDF_ACTIVE_CONTENT_POLICY
    || render.active_content_scan_sha256 !== expectedActiveContentScanSha256(actualSha256)) {
    throw new ApplicationMaterialsError(
      'MATERIAL_PDF_ACTIVE_CONTENT_SCAN_MISMATCH',
      'Rendered PDF active-content scan provenance is missing or does not match its bytes'
    );
  }
  return { render, current: true, actualSha256 };
}

function projectPublicMaterialRender(render) {
  if (!render) return null;
  return {
    ...pick(render, [
      'id', 'application_id', 'revision_id', 'source_format', 'output_format', 'source_sha256',
      'renderer_profile', 'renderer_image_digest', 'renderer_version', 'bundle_sha256',
      'output_sha256', 'output_bytes', 'page_count', 'extracted_text_sha256',
      'active_content_policy', 'active_content_scan_sha256', 'rendered_by', 'created_at'
    ]),
    has_attachment: Boolean(render.output_attachment_path),
    protected_payload_redacted: true
  };
}

function reviewMaterialRevision(db, input) {
  const revisionId = positiveId(input.revisionId, 'revision id');
  const revision = getMaterialRevision(db, revisionId, input.applicationId ? positiveId(input.applicationId, 'application id') : null);
  const decision = enumText(input.decision, REVIEW_DECISIONS, 'review decision');
  const reviewedBy = requiredText(input.reviewedBy, 'reviewed by', 200);
  const notes = optionalText(input.notes, 'notes', 20000);
  const expectedReviewId = parseExpectedId(input.expectedReviewId, 'expected review id');
  const renderId = input.renderId === undefined || input.renderId === null || input.renderId === ''
    ? null
    : positiveId(input.renderId, 'material render id');
  const render = renderId ? getMaterialRender(db, renderId, revision.application_id) : null;
  if (render && render.revision_id !== revision.id) {
    throw new ApplicationMaterialsError('MATERIAL_RENDER_SCOPE_MISMATCH', 'Material render belongs to another revision');
  }
  if (revision.material_kind === 'form-answer' && render) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', 'Form-answer reviews cannot bind a PDF render');
  }
  if (decision === 'approved' && ['resume', 'cover-letter'].includes(revision.material_kind)
    && revision.source_format === 'latex' && !render) {
    throw new ApplicationMaterialsError('MATERIAL_RENDER_REQUIRED', 'Approving a LaTeX document revision requires its exact rendered PDF');
  }
  if (render) assertMaterialRenderIntegrity(db, render.id, revision.application_id);
  if (decision === 'approved' && render) {
    // Plan §3.2: findings bind where renders bind. Approval requires a
    // passing, current lint report for the exact render being pinned.
    assertRenderLintPassed(db, render.id);
    const editorial = require('./application-resume-editorial').applicationResumeEditorialReadiness(db, revision, render.id);
    if (!editorial.ready) throw new ApplicationMaterialsError(editorial.blockerCodes[0], 'Independent evidence-bound resume editorial approval is required before material approval');
  }
  const reviewedAtInput = input.reviewedAt ? normalizedTimestamp(input.reviewedAt, 'reviewed at') : null;
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key', 200);
  const intent = { revisionId, decision, reviewedBy, notes, expectedReviewId, renderId, reviewedAt: reviewedAtInput };
  return idempotentOperation(db, 'review-material-revision', idempotencyKey, intent, () => {
    const reviewedAt = reviewedAtInput || new Date().toISOString();
    const current = db.prepare('SELECT * FROM application_material_review_events WHERE revision_id=? ORDER BY id DESC LIMIT 1').get(revisionId) || null;
    if ((current?.id || null) !== expectedReviewId) {
      throw new ApplicationMaterialsError('STALE_MATERIAL_REVIEW', `Expected review ${expectedReviewId || 'none'}, found ${current?.id || 'none'}`);
    }
    const decisionId = vocabularyId(db, 'application_material_review_decisions', decision, 'review decision');
    const info = db.prepare(`
      INSERT INTO application_material_review_events(
        revision_id,decision_id,expected_prior_review_id,reviewed_by,notes,idempotency_key,intent_sha256,reviewed_at,render_id
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `).run(revisionId, decisionId, expectedReviewId, reviewedBy, notes, `${idempotencyKey}:event`, sha256(stableJson(intent)), reviewedAt, renderId);
    return { revision: getMaterialRevision(db, revisionId, revision.application_id), review: db.prepare('SELECT * FROM application_material_review_events WHERE id=?').get(info.lastInsertRowid) };
  });
}

function selectMaterialRevision(db, input) {
  const revisionId = positiveId(input.revisionId, 'revision id');
  const revision = getMaterialRevision(db, revisionId, input.applicationId ? positiveId(input.applicationId, 'application id') : null);
  const selectedBy = requiredText(input.selectedBy, 'selected by', 200);
  const expectedSelectedRevisionId = parseExpectedId(input.expectedSelectedRevisionId, 'expected selected revision id');
  const selectedAtInput = input.selectedAt ? normalizedTimestamp(input.selectedAt, 'selected at') : null;
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key', 200);
  const intent = { revisionId, selectedBy, expectedSelectedRevisionId, selectedAt: selectedAtInput };
  return idempotentOperation(db, 'select-material-revision', idempotencyKey, intent, () => {
    const selectedAt = selectedAtInput || new Date().toISOString();
    const review = db.prepare(`
      SELECT e.*,d.slug AS decision FROM application_material_review_events e
      JOIN application_material_review_decisions d ON d.id=e.decision_id
      WHERE e.revision_id=? ORDER BY e.id DESC LIMIT 1
    `).get(revisionId);
    if (!review || review.decision !== 'approved') {
      throw new ApplicationMaterialsError('MATERIAL_NOT_APPROVED', 'Only a revision whose latest review is approved can be selected');
    }
    const editorial = require('./application-resume-editorial').applicationResumeEditorialReadiness(db, revision, review.render_id);
    if (!editorial.ready) throw new ApplicationMaterialsError(editorial.blockerCodes[0], 'Selection requires current independent resume editorial approval');
    const selection = db.prepare('SELECT * FROM application_material_selections WHERE material_id=?').get(revision.material_id) || null;
    if ((selection?.revision_id || null) !== expectedSelectedRevisionId) {
      throw new ApplicationMaterialsError('STALE_MATERIAL_SELECTION', `Expected selection ${expectedSelectedRevisionId || 'none'}, found ${selection?.revision_id || 'none'}`);
    }
    const version = selection?.lock_version || 0;
    db.prepare(`
      INSERT INTO application_material_selection_events(
        material_id,previous_revision_id,revision_id,expected_selection_version,selected_by,idempotency_key,intent_sha256,selected_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(revision.material_id, selection?.revision_id || null, revisionId, version, selectedBy, `${idempotencyKey}:event`, sha256(stableJson(intent)), selectedAt);
    if (selection) {
      const updated = db.prepare(`
        UPDATE application_material_selections
        SET revision_id=?,lock_version=lock_version+1,selected_by=?,selected_at=?
        WHERE material_id=? AND revision_id=? AND lock_version=?
      `).run(revisionId, selectedBy, selectedAt, revision.material_id, selection.revision_id, version);
      if (updated.changes !== 1) throw new ApplicationMaterialsError('STALE_MATERIAL_SELECTION', 'Material selection changed concurrently');
    } else {
      db.prepare(`
        INSERT INTO application_material_selections(material_id,revision_id,lock_version,selected_by,selected_at)
        VALUES (?,?,0,?,?)
      `).run(revision.material_id, revisionId, selectedBy, selectedAt);
    }
    return { material: readMaterial(db, revision.material_id), selectedRevision: getMaterialRevision(db, revisionId, revision.application_id) };
  });
}

function acceptApplicationFormUncertainty(db, input) {
  const applicationId = positiveId(input.applicationId, 'application id');
  requireApplication(db, applicationId);
  const acceptedBy = requiredText(input.acceptedBy, 'accepted by', 200);
  const reason = requiredText(input.reason, 'reason', 20000);
  const expectedFormStateSha256 = sha256Text(input.expectedFormStateSha256, 'expected form state SHA-256');
  const acceptedAtInput = input.acceptedAt ? normalizedTimestamp(input.acceptedAt, 'accepted at') : null;
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key', 200);
  const intent = { applicationId, acceptedBy, reason, expectedFormStateSha256, acceptedAt: acceptedAtInput };
  return idempotentOperation(db, 'accept-form-uncertainty', idempotencyKey, intent, () => {
    const acceptedAt = acceptedAtInput || new Date().toISOString();
    const form = readApplicationFormState(db, applicationId);
    if (form.stateSha256 !== expectedFormStateSha256) {
      throw new ApplicationMaterialsError('STALE_FORM_STATE', `Expected form state ${expectedFormStateSha256}, found ${form.stateSha256}`);
    }
    const info = db.prepare(`
      INSERT INTO application_preparation_uncertainty_events(
        application_id,form_capture_id,form_state_sha256,accepted_by,reason,idempotency_key,intent_sha256,accepted_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(applicationId, form.currentCaptureId, form.stateSha256, acceptedBy, reason, `${idempotencyKey}:event`, sha256(stableJson(intent)), acceptedAt);
    return { acceptance: db.prepare('SELECT * FROM application_preparation_uncertainty_events WHERE id=?').get(info.lastInsertRowid), form };
  });
}

function resolveApplicationFormField(db, input) {
  const applicationId = positiveId(input.applicationId, 'application id');
  requireApplication(db, applicationId);
  const formFieldId = positiveId(input.formFieldId, 'form field id');
  const state = enumText(input.state, FORM_FIELD_RESOLUTION_STATES, 'form field resolution state');
  const expectedFormStateSha256 = sha256Text(input.expectedFormStateSha256, 'expected form state SHA-256');
  const expectedCurrentResolutionId = parseExpectedId(
    input.expectedCurrentResolutionId,
    'expected current form field resolution id'
  );
  const actor = requiredText(input.actor, 'actor', 200);
  const rationale = requiredText(input.rationale, 'rationale', 20000);
  const artifactId = input.artifactId === undefined || input.artifactId === null || input.artifactId === ''
    ? null
    : positiveId(input.artifactId, 'artifact id');
  const resolvedAtInput = input.resolvedAt ? normalizedTimestamp(input.resolvedAt, 'resolved at') : null;
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key', 200);
  const intent = {
    applicationId,
    formFieldId,
    state,
    expectedFormStateSha256,
    expectedCurrentResolutionId,
    artifactId,
    actor,
    rationale,
    resolvedAt: resolvedAtInput
  };
  return idempotentOperation(db, 'resolve-application-form-field', idempotencyKey, intent, () => {
    const form = readApplicationFormState(db, applicationId);
    if (form.stateSha256 !== expectedFormStateSha256) {
      throw new ApplicationMaterialsError(
        'STALE_FORM_STATE',
        `Expected form state ${expectedFormStateSha256}, found ${form.stateSha256}`
      );
    }
    const field = form.fields.find((candidate) => candidate.id === formFieldId);
    if (!field) {
      throw new ApplicationMaterialsError(
        'FORM_FIELD_SCOPE_MISMATCH',
        `Form field ${formFieldId} is not part of the current application-form state for application ${applicationId}`
      );
    }
    if (['resume', 'cover-letter'].includes(field.fulfillment)) {
      throw new ApplicationMaterialsError(
        'INVALID_FIELD_RESOLUTION',
        `Form field ${formFieldId} is governed by the mandatory custom ${field.fulfillment} workflow`
      );
    }
    if (state === 'fulfilled' && field.fulfillment !== 'human-response') {
      throw new ApplicationMaterialsError(
        'INVALID_FIELD_RESOLUTION',
        `Only a non-generated human-response field can be fulfilled with a pinned artifact; field ${formFieldId} uses ${field.fulfillment}`
      );
    }
    if (state === 'not-applicable'
      && normalizeRequiredness(field.requiredness) !== 'conditional'
      && isObservedFormField(field)
      && field.visibility_condition === null) {
      throw new ApplicationMaterialsError(
        'INVALID_FIELD_RESOLUTION',
        `Form field ${formFieldId} must be conditional or inactive before it can be marked not applicable`
      );
    }
    if (state === 'fulfilled' && !artifactId) {
      throw new ApplicationMaterialsError('FIELD_EVIDENCE_REQUIRED', 'A fulfilled form field must bind a same-application artifact');
    }
    if (state !== 'fulfilled' && artifactId) {
      throw new ApplicationMaterialsError('FIELD_EVIDENCE_NOT_ALLOWED', `${state} form field resolutions do not accept artifact evidence`);
    }
    const current = db.prepare(`
      SELECT id FROM application_form_field_resolution_events
      WHERE application_id=? AND form_field_id=? ORDER BY id DESC LIMIT 1
    `).get(applicationId, formFieldId) || null;
    if ((current?.id || null) !== expectedCurrentResolutionId) {
      throw new ApplicationMaterialsError(
        'STALE_FIELD_RESOLUTION',
        `Expected current form field resolution ${expectedCurrentResolutionId || 'none'}, found ${current?.id || 'none'}`
      );
    }
    let evidenceSha256 = null;
    if (artifactId) {
      const artifact = readResolutionArtifact(db, applicationId, artifactId);
      if (['file', 'file-upload'].includes(field.input_kind)
        && (artifact.attachment_path === null || String(artifact.attachment_path).trim() === '')) {
        throw new ApplicationMaterialsError(
          'FIELD_ATTACHMENT_REQUIRED',
          `File-upload form field ${formFieldId} requires an artifact with a managed attachment`
        );
      }
      evidenceSha256 = hashArtifact(artifact);
    }
    const resolvedAt = resolvedAtInput || new Date().toISOString();
    const stateId = vocabularyId(db, 'application_form_field_resolution_states', state, 'form field resolution state');
    const info = db.prepare(`
      INSERT INTO application_form_field_resolution_events(
        application_id,form_field_id,state_id,form_state_sha256,evidence_artifact_id,evidence_sha256,
        expected_current_resolution_id,actor,rationale,idempotency_key,intent_sha256,resolved_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      applicationId, formFieldId, stateId, form.stateSha256, artifactId, evidenceSha256,
      expectedCurrentResolutionId, actor, rationale, `${idempotencyKey}:event`, sha256(stableJson(intent)), resolvedAt
    );
    const resolution = readFormFieldResolution(db, Number(info.lastInsertRowid), form);
    return {
      resolution: projectPublicFormFieldResolution(resolution),
      field: generationFormFieldCatalogRecord(field),
      formStateSha256: form.stateSha256
    };
  });
}

function readResolutionArtifact(db, applicationId, artifactId) {
  const artifact = db.prepare(`
    SELECT id,application_id,kind,title,source_url,source_name,citation,notes,content,attachment_path,
      opportunity_snapshot_id,captured_at,created_at
    FROM application_artifacts WHERE id=? AND application_id=?
  `).get(artifactId, applicationId);
  if (!artifact) {
    throw new ApplicationMaterialsError(
      'FIELD_EVIDENCE_SCOPE_MISMATCH',
      `Artifact ${artifactId} is not same-application evidence for application ${applicationId}`
    );
  }
  return artifact;
}

function readFormFieldResolution(db, resolutionId, form = null) {
  const row = db.prepare(`
    SELECT event.*,state.slug AS state,state.label AS state_label
    FROM application_form_field_resolution_events event
    JOIN application_form_field_resolution_states state ON state.id=event.state_id
    WHERE event.id=?
  `).get(resolutionId);
  if (!row) return null;
  const currentForm = form || readApplicationFormState(db, row.application_id);
  let evidenceCurrent = null;
  if (row.state === 'fulfilled') {
    try {
      const artifact = readResolutionArtifact(db, row.application_id, row.evidence_artifact_id);
      evidenceCurrent = hashArtifact(artifact) === row.evidence_sha256;
    } catch (error) {
      if (error instanceof ApplicationMaterialsError) evidenceCurrent = false;
      else throw error;
    }
  }
  const resolutionCurrent = row.form_state_sha256 === currentForm.stateSha256
    && (row.state !== 'fulfilled' || evidenceCurrent === true);
  return { ...row, evidence_current: evidenceCurrent, resolution_current: resolutionCurrent };
}

function readCurrentFormFieldResolutions(db, applicationId, form) {
  const result = [];
  for (const field of form.fields) {
    const latest = db.prepare(`
      SELECT id FROM application_form_field_resolution_events
      WHERE application_id=? AND form_field_id=? ORDER BY id DESC LIMIT 1
    `).get(applicationId, field.id);
    if (!latest) continue;
    result.push({ field, resolution: readFormFieldResolution(db, latest.id, form) });
  }
  return result.sort((left, right) => left.field.id - right.field.id);
}

function projectPublicFormFieldResolution(row) {
  if (!row) return null;
  return {
    ...pick(row, [
      'id', 'application_id', 'form_field_id', 'state', 'form_state_sha256',
      'evidence_artifact_id', 'evidence_sha256', 'expected_current_resolution_id',
      'actor', 'resolved_at', 'created_at', 'evidence_current', 'resolution_current'
    ]),
    has_rationale: Boolean(row.rationale),
    protected_payload_redacted: true
  };
}

function getApplicationReadiness(db, applicationId, options = {}) {
  const application = requireApplication(db, applicationId);
  const plan = readPreparationPlan(db, application.id);
  if (!plan) throw new ApplicationMaterialsError('PREPARATION_PLAN_MISSING', `Application ${application.id} has not been migrated for preparation`);
  const form = readApplicationFormState(db, application.id);
  const assessment = readCurrentAssessmentState(db, application.id);
  const informationRequests = readInformationRequests(db, application);
  const formFieldResolutions = readCurrentFormFieldResolutions(db, application.id, form);
  const formFieldResolutionById = new Map(
    formFieldResolutions.map((item) => [item.field.id, item.resolution])
  );
  const blockers = [];
  const signals = [];

  if (plan.mode !== 'managed') {
    blockers.push(blocker('LEGACY_PREPARATION_NOT_MANAGED', 'This historical application is labeled legacy / materials not recorded. Activate managed preparation before building a new package.'));
  }
  if (!assessment.assessment) {
    blockers.push(blocker('ASSESSMENT_MISSING', 'Create and review an application assessment before final package readiness.'));
  } else if (!assessment.finalEvidenceApproved) {
    blockers.push(blocker('ASSESSMENT_NOT_APPROVED', 'The latest application assessment does not have a matching current approval.'));
  }

  const uncertainty = db.prepare(`
    SELECT * FROM application_preparation_uncertainty_events
    WHERE application_id=? AND form_state_sha256=? ORDER BY id DESC LIMIT 1
  `).get(application.id, form.stateSha256) || null;
  const pendingFormRevisionIds = [...new Set(
    form.surfaces.flatMap((surface) => surface.pendingRevisionIds || [])
  )].sort((left, right) => left - right);
  const formReady = form.available && form.coverageState === 'complete' && form.reviewed && !form.stale;
  if (pendingFormRevisionIds.length) {
    blockers.push(blocker(
      'FORM_REVISION_REVIEW_PENDING',
      'A newer application-form observation is awaiting an explicit approve or reject decision; uncertainty acceptance cannot bypass review.',
      { pendingRevisionIds: pendingFormRevisionIds }
    ));
  }
  if (form.stale) {
    blockers.push(blocker(
      'FORM_CAPTURE_STALE',
      'The latest coverage attestation marks the selected application-form capture stale; import and review a current capture before packaging.'
    ));
  }
  if (!formReady && !uncertainty) {
    blockers.push(blocker(
      'FORM_COVERAGE_UNCERTAIN',
      form.available
        ? 'The selected application form is not both complete and approved; record an explicit human uncertainty acceptance for this exact form state if proceeding.'
        : 'No application-form capture is linked; record an explicit human uncertainty acceptance for this exact unknown form state if proceeding.'
    ));
  }

  const baseline = {};
  for (const kind of ['resume', 'cover-letter']) {
    const state = selectedMaterialState(db, application.id, kind, null);
    baseline[kind] = state;
    collectMaterialBlockers(db, application, kind, state, blockers, signals);
  }

  const answerStates = [];
  for (const field of form.fields) {
    const required = BLOCKING_REQUIREDNESS.has(normalizeRequiredness(field.requiredness));
    const fieldResolution = formFieldResolutionById.get(field.id) || null;
    if (fieldResolution) {
      if (!fieldResolution.resolution_current) {
        blockers.push(blocker(
          'FORM_FIELD_RESOLUTION_STALE',
          'A recorded application-form field resolution is stale because the form state or its pinned evidence changed.',
          { formFieldId: field.id, resolutionId: fieldResolution.id, state: fieldResolution.state }
        ));
        continue;
      }
      if (fieldResolution.state === 'blocked') {
        blockers.push(blocker(
          'FORM_FIELD_BLOCKED',
          'A human-marked application-form field remains blocked.',
          { formFieldId: field.id, resolutionId: fieldResolution.id, state: fieldResolution.state }
        ));
        continue;
      }
      if (fieldResolution.state === 'not-applicable') {
        signals.push({
          code: 'FORM_FIELD_NOT_APPLICABLE',
          message: 'A human explicitly marked an application-form field not applicable for this exact form state.',
          formFieldId: field.id,
          resolutionId: fieldResolution.id
        });
        continue;
      }
      if (fieldResolution.state === 'fulfilled') {
        signals.push({
          code: 'FORM_FIELD_FULFILLED',
          message: 'A non-generated application-form field is fulfilled by current pinned application evidence.',
          formFieldId: field.id,
          resolutionId: fieldResolution.id,
          artifactId: fieldResolution.evidence_artifact_id
        });
        continue;
      }
    }
    if (normalizeRequiredness(field.requiredness) === 'conditional' && !fieldResolution) {
      blockers.push(blocker(
        'FORM_FIELD_APPLICABILITY_UNKNOWN',
        'A conditional application-form field needs an explicit current applicable or not-applicable decision.',
        { formFieldId: field.id }
      ));
      continue;
    }
    if (!isObservedFormField(field)) {
      if (required) {
        blockers.push(blocker(
          'FORM_REQUIRED_FIELD_UNOBSERVED',
          `Required field “${field.label}” was declared but not observed and cannot be treated as answered.`,
          { formFieldId: field.id }
        ));
      }
      continue;
    }
    if (field.fulfillment === 'resume' || field.fulfillment === 'cover-letter') continue;
    if (field.fulfillment === 'generated-answer') {
      const state = selectedMaterialState(db, application.id, 'form-answer', field.id);
      if (required || state?.revision) {
        answerStates.push({ field: formFieldDigestRecord(field), material: state });
        collectMaterialBlockers(
          db, application, `answer for “${field.label}”`, state, blockers, signals,
          { formFieldId: field.id }
        );
        collectFormAnswerConstraintBlocker(field, state, blockers);
      }
      continue;
    }
    if (field.fulfillment === 'profile-information') {
      if (required && !hasResolvedInformationRequest(informationRequests, field.profile_information_field_id)) {
        blockers.push(blocker('FORM_INFORMATION_UNRESOLVED', `Required field “${field.label}” has no available or not-applicable information assessment.`, { formFieldId: field.id }));
      }
      continue;
    }
    if (field.fulfillment === 'protected-human-only') {
      const state = selectedMaterialState(db, application.id, 'form-answer', field.id);
      if (state?.revision) {
        answerStates.push({ field: formFieldDigestRecord(field), material: state });
        collectMaterialBlockers(
          db, application, 'human answer for a protected application field', state, blockers, signals,
          { formFieldId: field.id }
        );
        collectFormAnswerConstraintBlocker(field, state, blockers);
        if (state.revision.authorship !== 'human') {
          blockers.push(blocker('PROTECTED_RESPONSE_NOT_HUMAN', `Protected field “${field.label}” is not bound to a human-authored response.`, { formFieldId: field.id, revisionId: state.revision.id }));
        }
      } else if (required) {
        answerStates.push({ field: formFieldDigestRecord(field), material: state });
        blockers.push(blocker('PROTECTED_RESPONSE_REQUIRES_HUMAN', `Protected field “${field.label}” requires an explicitly human-authored, reviewed answer.`, { formFieldId: field.id }));
      }
      continue;
    }
    if (required) {
      blockers.push(blocker('FORM_RESPONSE_NOT_RECORDED', `Required field “${field.label}” requires a non-generated response that has not been resolved.`, { formFieldId: field.id }));
    }
  }

  const notApplicableInformationFieldIds = new Set();
  const activeInformationFieldIds = new Set();
  for (const field of form.fields) {
    if (!field.profile_information_field_id) continue;
    const resolution = formFieldResolutionById.get(field.id);
    if (resolution?.resolution_current && resolution.state === 'not-applicable') {
      notApplicableInformationFieldIds.add(field.profile_information_field_id);
    } else {
      activeInformationFieldIds.add(field.profile_information_field_id);
    }
  }
  for (const request of informationRequests) {
    if (!BLOCKING_REQUIREDNESS.has(normalizeRequiredness(request.requiredness))) continue;
    if (['resume', 'cover-letter'].includes(request.information_field_slug)) continue;
    if (String(request.source || '').toLowerCase().includes('application-form')
      && notApplicableInformationFieldIds.has(request.information_field_id)
      && !activeInformationFieldIds.has(request.information_field_id)) continue;
    if (!informationRequestIsResolved(request)) {
      const staleResolution = request.assessment_state === 'available' && !request.resolution_current;
      const requestLabel = request.protected ? 'protected profile information' : request.information_field_label || request.information_field_slug;
      blockers.push(blocker(staleResolution ? 'REQUIRED_INFORMATION_RESOLUTION_STALE' : 'REQUIRED_INFORMATION_UNRESOLVED', `Required information “${requestLabel}” is ${staleResolution ? 'stale because its pinned profile value changed or disappeared' : request.assessment_state}.`, {
        requestScope: request.request_scope,
        requestId: request.id,
        state: staleResolution ? 'stale' : request.assessment_state
      }));
    }
  }

  const manifest = {
    applicationId: application.id,
    // Compact templates (v3/v4) only, so historical v1/v2 package digests
    // remain unchanged. A new editorial decision binds a new readiness state
    // even if both approve.
    ...(require('./material-templates').isCompactResumeTemplate(baseline.resume?.revision?.template_key) ? {
      resumeEditorial: require('./application-resume-editorial').applicationResumeEditorialReadiness(db, baseline.resume.revision, baseline.resume.reviewedRenderId)
    } : {}),
    planMode: plan.mode,
    assessmentId: assessment.assessment?.id || null,
    assessmentGateId: assessment.finalEvidenceApproved ? assessment.gate.id : null,
    formStateSha256: form.stateSha256,
    formCaptureId: form.currentCaptureId,
    formReady,
    pendingFormRevisionIds,
    uncertaintyAcceptanceId: uncertainty?.id || null,
    resumeRevisionId: baseline.resume?.revision?.id || null,
    resumeSha256: baseline.resume?.revision?.content_sha256 || null,
    resumeRenderId: baseline.resume?.reviewedRenderId || null,
    resumePdfSha256: baseline.resume?.reviewedRender?.output_sha256 || null,
    resumePdfBytes: baseline.resume?.reviewedRender?.output_bytes || null,
    resumePageCount: baseline.resume?.reviewedRender?.page_count || null,
    resumeRendererProfile: baseline.resume?.reviewedRender?.renderer_profile || null,
    resumeRendererImageDigest: baseline.resume?.reviewedRender?.renderer_image_digest || null,
    resumeRendererVersion: baseline.resume?.reviewedRender?.renderer_version || null,
    resumeRendererBundleSha256: baseline.resume?.reviewedRender?.bundle_sha256 || null,
    resumeActiveContentPolicy: baseline.resume?.reviewedRender?.active_content_policy || null,
    resumeActiveContentScanSha256: baseline.resume?.reviewedRender?.active_content_scan_sha256 || null,
    coverLetterRevisionId: baseline['cover-letter']?.revision?.id || null,
    coverLetterSha256: baseline['cover-letter']?.revision?.content_sha256 || null,
    coverLetterRenderId: baseline['cover-letter']?.reviewedRenderId || null,
    coverLetterPdfSha256: baseline['cover-letter']?.reviewedRender?.output_sha256 || null,
    coverLetterPdfBytes: baseline['cover-letter']?.reviewedRender?.output_bytes || null,
    coverLetterPageCount: baseline['cover-letter']?.reviewedRender?.page_count || null,
    coverLetterRendererProfile: baseline['cover-letter']?.reviewedRender?.renderer_profile || null,
    coverLetterRendererImageDigest: baseline['cover-letter']?.reviewedRender?.renderer_image_digest || null,
    coverLetterRendererVersion: baseline['cover-letter']?.reviewedRender?.renderer_version || null,
    coverLetterRendererBundleSha256: baseline['cover-letter']?.reviewedRender?.bundle_sha256 || null,
    coverLetterActiveContentPolicy: baseline['cover-letter']?.reviewedRender?.active_content_policy || null,
    coverLetterActiveContentScanSha256: baseline['cover-letter']?.reviewedRender?.active_content_scan_sha256 || null,
    answers: answerStates.map((item) => ({
      formFieldId: item.field.id,
      revisionId: item.material?.revision?.id || null,
      contentSha256: item.material?.revision?.content_sha256 || null,
      optionIds: (item.material?.revision?.formOptions || []).map((option) => option.option_id),
      optionLabels: (item.material?.revision?.formOptions || []).map((option) => option.label)
    })).sort((a, b) => a.formFieldId - b.formFieldId),
    informationResolutions: informationRequests.map((request) => ({
      requestScope: request.request_scope,
      requestId: request.id,
      latestAssessmentId: request.latest_assessment_id || null,
      informationFieldId: request.information_field_id,
      requiredness: request.requiredness,
      assessmentState: request.assessment_state,
      resolutionKind: request.resolution_kind || null,
      resolutionKey: request.resolution_key || null,
      resolutionSha256: request.resolution_sha256 || null,
      resolutionCurrent: request.resolution_current === true,
      effectiveJobPostingId: request.effective_job_posting_id || null
    })).sort((left, right) => left.requestScope.localeCompare(right.requestScope) || left.requestId - right.requestId),
    formFieldResolutions: formFieldResolutions.map(({ field, resolution }) => ({
      formFieldId: field.id,
      resolutionId: resolution.id,
      state: resolution.state,
      formStateSha256: resolution.form_state_sha256,
      evidenceArtifactId: resolution.evidence_artifact_id || null,
      evidenceSha256: resolution.evidence_sha256 || null,
      actorSha256: sha256(resolution.actor),
      rationaleSha256: sha256(resolution.rationale),
      evidenceCurrent: resolution.evidence_current,
      resolutionCurrent: resolution.resolution_current
    })),
    blockerCodes: blockers.map((item) => item.code).sort(),
    signalCodes: signals.map((item) => item.code).sort()
  };
  const readinessSha256 = sha256(stableJson(manifest));
  const result = {
    application: pick(application, ['id', 'company', 'role', 'workflow_stage', 'status']),
    plan,
    ready: blockers.length === 0,
    canDraft: true,
    finalEvidenceApproved: assessment.finalEvidenceApproved,
    blockers,
    signals,
    form: sanitizeGenerationFormState(form),
    uncertaintyAcceptance: uncertainty,
    assessment,
    baseline,
    answers: answerStates,
    fieldResolutions: formFieldResolutions.map(({ field, resolution }) => ({
      field: generationFormFieldCatalogRecord(field),
      resolution: projectPublicFormFieldResolution(resolution)
    })),
    informationRequests: informationRequests.map(sanitizeGenerationInformationRequest),
    manifest,
    readinessSha256
  };
  return options.includeProtectedContent === true ? result : sanitizePublicReadiness(result);
}

function sanitizePublicReadiness(readiness) {
  const protectedFieldIds = new Set([
    ...(readiness.form?.fields || [])
      .filter((field) => field?.protected)
      .map((field) => field.id),
    ...readiness.answers
      .filter((answer) => answer.field?.protected)
      .map((answer) => answer.field.id)
  ]);
  const protectedRevisionIds = new Set(readiness.answers
    .filter((answer) => answer.field?.protected && answer.material?.revision)
    .map((answer) => answer.material.revision.id));
  const sanitizeDiagnostic = (item) => {
    if (!protectedFieldIds.has(item.formFieldId) && !protectedRevisionIds.has(item.revisionId)) return item;
    return {
      ...pick(item, ['code', 'formFieldId', 'revisionId', 'otherRevisionId', 'requestScope', 'requestId', 'state']),
      message: 'Protected application response requires operator review.',
      protected: true
    };
  };
  return {
    ...readiness,
    baseline: Object.fromEntries(
      Object.entries(readiness.baseline || {}).map(([kind, state]) => [kind, projectPublicMaterialState(state)])
    ),
    uncertaintyAcceptance: projectPublicUncertaintyAcceptance(readiness.uncertaintyAcceptance),
    blockers: readiness.blockers.map(sanitizeDiagnostic),
    signals: readiness.signals.map(sanitizeDiagnostic),
    manifest: {
      ...readiness.manifest,
      answers: readiness.manifest.answers.map((answer) => protectedFieldIds.has(answer.formFieldId)
        ? {
          formFieldId: answer.formFieldId,
          revisionId: answer.revisionId,
          contentSha256: answer.contentSha256,
          optionCount: Array.isArray(answer.optionIds) ? answer.optionIds.length : 0,
          protected: true
        }
        : answer)
    },
    answers: readiness.answers.map((answer) => ({
      field: answer.field?.protected ? generationFormFieldCatalogRecord(answer.field) : answer.field,
      material: answer.field?.protected
        ? projectPublicProtectedAnswerState(answer.material)
        : projectPublicMaterialState(answer.material),
      ...(answer.field?.protected ? { protected: true } : {})
    }))
  };
}

function projectPublicProtectedAnswerState(state) {
  const projected = projectPublicMaterialState(state);
  if (!projected?.revision) return projected;
  return {
    ...projected,
    revision: pickPackageProtectedRevisionMetadata(projected.revision)
  };
}

function projectPublicMaterialState(state) {
  if (!state) return null;
  return {
    material: state.material ? pick(state.material, [
      'id', 'application_id', 'material_kind_id', 'form_field_id', 'created_at'
    ]) : null,
    selection: state.selection ? pick(state.selection, [
      'material_id', 'revision_id', 'lock_version', 'selected_by', 'selected_at'
    ]) : null,
    revision: state.revision ? pickPackageRevisionMetadata(state.revision) : null,
    reviewDecision: state.reviewDecision,
    latestReviewId: state.latestReviewId,
    reviewedRender: state.reviewedRender,
    reviewedRenderId: state.reviewedRenderId,
    renderIntegrityCurrent: state.renderIntegrityCurrent,
    renderIntegrityErrorCode: state.renderIntegrityErrorCode,
    fresh: state.fresh
  };
}

function projectPublicUncertaintyAcceptance(row) {
  if (!row) return null;
  return {
    ...pick(row, [
      'id', 'application_id', 'form_capture_id', 'form_state_sha256', 'accepted_by',
      'accepted_at', 'created_at'
    ]),
    hasReason: Boolean(row.reason),
    protectedPayloadRedacted: true
  };
}

function collectMaterialBlockers(db, application, label, state, blockers, signals, diagnosticDetails = {}) {
  if (!state || !state.revision) {
    blockers.push(blocker('MATERIAL_SELECTION_MISSING', `No approved ${label} revision is selected.`, {
      materialKind: label,
      ...diagnosticDetails
    }));
    return;
  }
  if (state.reviewDecision !== 'approved') {
    blockers.push(blocker('MATERIAL_SELECTION_NOT_APPROVED', `The selected ${label} revision is not currently approved.`, {
      revisionId: state.revision.id,
      ...diagnosticDetails
    }));
  }
  if (state.revision.revision_stage !== 'final-candidate') {
    blockers.push(blocker('MATERIAL_NOT_FINAL_CANDIDATE', `The selected ${label} revision is ${state.revision.revision_stage}; mark a reviewed final-candidate before packaging.`, {
      revisionId: state.revision.id,
      ...diagnosticDetails
    }));
  }
  if (!state.fresh) {
    blockers.push(blocker('MATERIAL_SOURCES_STALE', `The selected ${label} was generated from stale application, assessment, form, artifact, or profile evidence.`, {
      revisionId: state.revision.id,
      ...diagnosticDetails
    }));
  }
  if (['resume', 'cover-letter'].includes(state.revision.material_kind)) {
    if (state.revision.source_format !== 'latex'
      || state.revision.generation_contract_version !== LATEX_DOCUMENT_CONTRACT_VERSION) {
      blockers.push(blocker(
        'MATERIAL_LATEX_SOURCE_REQUIRED',
        `The selected ${label} is not a complete v1 LaTeX document.`,
        { revisionId: state.revision.id, ...diagnosticDetails }
      ));
    } else if (!state.reviewedRenderId) {
      blockers.push(blocker(
        'MATERIAL_LATEX_RENDER_NOT_REVIEWED',
        `The selected ${label} approval does not pin an exact rendered PDF.`,
        { revisionId: state.revision.id, ...diagnosticDetails }
      ));
    } else if (state.renderIntegrityCurrent !== true) {
      blockers.push(blocker(
        state.renderIntegrityErrorCode || 'MATERIAL_PDF_INTEGRITY_MISMATCH',
        `The selected ${label} rendered PDF is missing, stale, or no longer byte-identical.`,
        { revisionId: state.revision.id, renderId: state.reviewedRenderId, ...diagnosticDetails }
      ));
    } else {
      // Plan §3.2: an unresolved error-class lint finding is a readiness
      // blocker, and a linter upgrade makes an old pass stale.
      const lint = latestRenderLintSummary(db, state.reviewedRenderId);
      if (!lint || lint.stale) {
        blockers.push(blocker(
          'MATERIAL_LINT_REPORT_MISSING',
          `The selected ${label} render has no current lint report; run application-material lint against it.`,
          { revisionId: state.revision.id, renderId: state.reviewedRenderId, ...diagnosticDetails }
        ));
      } else if (lint.verdict !== 'pass') {
        blockers.push(blocker(
          'MATERIAL_LINT_FAILED',
          `The selected ${label} render failed its lint report; fix the revision and re-render.`,
          { revisionId: state.revision.id, renderId: state.reviewedRenderId, ...diagnosticDetails }
        ));
      }
      const editorial = require('./application-resume-editorial').applicationResumeEditorialReadiness(db, state.revision, state.reviewedRenderId);
      if (!editorial.ready) blockers.push(blocker(editorial.blockerCodes[0], 'The selected resume needs a current independent editorial approval.', { revisionId: state.revision.id, renderId: state.reviewedRenderId }));
    }
  }
  const duplicate = db.prepare(`
    SELECT other.id,om.application_id FROM application_material_revisions other
    JOIN application_materials om ON om.id=other.material_id
    WHERE other.content_sha256=? AND om.application_id<>? LIMIT 1
  `).get(state.revision.content_sha256, application.id);
  if (duplicate) {
    if (['resume', 'cover-letter'].includes(state.revision.material_kind)) {
      blockers.push(blocker(
        'DUPLICATE_BASELINE_MATERIAL_ACROSS_APPLICATIONS',
        `The selected ${label} exactly duplicates material from another application; every resume and cover letter must be customized for this application.`,
        { revisionId: state.revision.id, otherRevisionId: duplicate.id, ...diagnosticDetails }
      ));
    }
    signals.push({
      code: 'DUPLICATE_CONTENT_ACROSS_APPLICATIONS',
      message: `The selected ${label} has the same content hash as material for another application and needs customization review.`,
      revisionId: state.revision.id,
      otherRevisionId: duplicate.id,
      ...diagnosticDetails
    });
  }
}

function selectedMaterialState(db, applicationId, kind, formFieldId) {
  const kindId = db.prepare('SELECT id FROM application_material_kinds WHERE slug=?').get(kind)?.id;
  if (!kindId) return null;
  const material = formFieldId
    ? db.prepare('SELECT * FROM application_materials WHERE application_id=? AND material_kind_id=? AND form_field_id=?').get(applicationId, kindId, formFieldId)
    : db.prepare('SELECT * FROM application_materials WHERE application_id=? AND material_kind_id=? AND form_field_id IS NULL').get(applicationId, kindId);
  if (!material) return null;
  const selection = db.prepare('SELECT * FROM application_material_selections WHERE material_id=?').get(material.id) || null;
  if (!selection) return { material, selection: null, revision: null, reviewDecision: null, fresh: false };
  const revision = getMaterialRevision(db, selection.revision_id, applicationId);
  const review = db.prepare(`
    SELECT e.id,e.render_id,d.slug AS decision FROM application_material_review_events e
    JOIN application_material_review_decisions d ON d.id=e.decision_id
    WHERE e.revision_id=? ORDER BY e.id DESC LIMIT 1
  `).get(revision.id);
  let reviewedRender = null;
  let renderIntegrityCurrent = null;
  let renderIntegrityErrorCode = null;
  if (review?.render_id) {
    reviewedRender = getMaterialRender(db, review.render_id, applicationId);
    try {
      assertMaterialRenderIntegrity(db, reviewedRender, applicationId);
      renderIntegrityCurrent = true;
    } catch (error) {
      renderIntegrityCurrent = false;
      renderIntegrityErrorCode = error instanceof ApplicationMaterialsError
        ? error.code
        : 'MATERIAL_PDF_INTEGRITY_CHECK_FAILED';
    }
  }
  return {
    material,
    selection,
    revision,
    reviewDecision: review?.decision || null,
    latestReviewId: review?.id || null,
    reviewedRender: projectPublicMaterialRender(reviewedRender),
    reviewedRenderId: review?.render_id || null,
    renderIntegrityCurrent,
    renderIntegrityErrorCode,
    fresh: materialRevisionIsFresh(db, revision)
  };
}

function materialRevisionIsFresh(db, revision) {
  const manifest = db.prepare('SELECT * FROM application_material_source_manifests WHERE id=?').get(revision.source_manifest_id);
  if (!manifest) return false;
  const material = db.prepare(`
    SELECT m.*,k.slug AS kind FROM application_materials m JOIN application_material_kinds k ON k.id=m.material_kind_id WHERE m.id=?
  `).get(revision.material_id);
  const application = requireApplication(db, material.application_id);
  const plan = readPreparationPlan(db, application.id);
  const form = readApplicationFormState(db, application.id);
  const assessment = readCurrentAssessmentState(db, application.id);
  const artifactBindings = db.prepare('SELECT * FROM application_material_manifest_artifacts WHERE manifest_id=? ORDER BY artifact_id').all(manifest.id);
  const artifacts = artifactBindings.map((binding) => db.prepare(`
    SELECT id,application_id,kind,title,source_url,source_name,citation,notes,content,attachment_path,
      opportunity_snapshot_id,captured_at,created_at FROM application_artifacts WHERE id=? AND application_id=?
  `).get(binding.artifact_id, application.id)).filter(Boolean);
  const profileBindings = db.prepare('SELECT * FROM application_material_manifest_profile_entries WHERE manifest_id=? ORDER BY profile_entry_id').all(manifest.id);
  const eligibleProfileEntries = readEligibleProfileEntries(db, material.kind).filter((entry) => entry.category !== 'story');
  const profileEntries = profileBindings.map((binding) => eligibleProfileEntries.find((entry) => entry.id === binding.profile_entry_id)).filter(Boolean);
  const storyUseIds = db.prepare('SELECT story_use_id FROM application_material_manifest_story_uses WHERE manifest_id=? ORDER BY story_use_id').all(manifest.id).map((row) => row.story_use_id);
  let storyUses;
  let selectedFormField;
  let parentRevision;
  try {
    storyUses = readStoryUses(db, application.id, material.kind, storyUseIds);
    selectedFormField = material.form_field_id
      ? getFormFieldDescriptorForApplication(db, application.id, material.form_field_id)
      : null;
    parentRevision = revision.parent_revision_id
      ? getMaterialRevision(db, revision.parent_revision_id, application.id)
      : null;
  }
  catch { return false; }
  try {
    const currentSha = sha256(stableJson(canonicalSourceState({
      application, plan, materialKind: material.kind, formFieldId: material.form_field_id || null,
      assessment, form, selectedFormField, parentRevision, profileEntries, artifacts, storyUses, db
    })));
    if (currentSha !== manifest.source_manifest_sha256) return false;
    for (const binding of artifactBindings) {
      const artifact = artifacts.find((row) => row.id === binding.artifact_id);
      if (!artifact || hashArtifact(artifact) !== binding.content_sha256) return false;
    }
    for (const binding of profileBindings) {
      const entry = profileEntries.find((row) => row.id === binding.profile_entry_id);
      if (!entry || hashProfileEntry(entry) !== binding.content_sha256) return false;
    }
    return true;
  } catch (error) {
    if (error instanceof ApplicationMaterialsError && error.code.startsWith('ATTACHMENT_')) return false;
    throw error;
  }
}

function hasResolvedInformationRequest(requests, informationFieldId) {
  if (!informationFieldId) return false;
  return requests.some((request) => request.information_field_id === informationFieldId && informationRequestIsResolved(request));
}

function informationRequestIsResolved(request) {
  if (!RESOLVED_INFORMATION_STATES.has(request.assessment_state)) return false;
  return request.assessment_state === 'not_applicable' || request.resolution_current === true;
}

function isObservedFormField(field) {
  return !['known-unobserved', 'unobserved', 'declared-unobserved', 'hidden'].includes(String(field.observation_state || '').toLowerCase());
}

function buildPackageSelectionSnapshot(db, applicationId, options = {}) {
  const includeProtectedContent = options.includeProtectedContent === true;
  const readiness = getApplicationReadiness(db, applicationId, { includeProtectedContent: true });
  if (options.expectedReadinessSha256 && readiness.readinessSha256 !== options.expectedReadinessSha256) {
    throw new ApplicationMaterialsError('STALE_READINESS', `Expected readiness ${options.expectedReadinessSha256}, found ${readiness.readinessSha256}`);
  }
  if (!readiness.ready) {
    throw new ApplicationMaterialsError('APPLICATION_NOT_READY', 'Application preparation is not ready for packaging', { blockers: readiness.blockers });
  }
  const formFieldResolutions = readiness.fieldResolutions.map((item) => {
    const field = readiness.form.fields.find((candidate) => candidate.id === item.field.id) || item.field;
    const artifact = item.resolution.evidence_artifact_id
      ? readResolutionArtifact(db, applicationId, item.resolution.evidence_artifact_id)
      : null;
    return {
      formFieldId: item.field.id,
      label: field.protected ? 'Protected application field' : field.label,
      protected: Boolean(field.protected),
      resolution: item.resolution,
      evidenceArtifact: artifact
        ? (includeProtectedContent
          ? {
            ...pick(artifact, ['id', 'kind', 'title', 'attachment_path']),
            evidenceSha256: item.resolution.evidence_sha256
          }
          : {
            id: artifact.id,
            kind: artifact.kind,
            hasAttachment: Boolean(artifact.attachment_path),
            evidenceSha256: item.resolution.evidence_sha256,
            protectedPayloadRedacted: true
          })
        : null
    };
  });
  return {
    applicationId: readiness.application.id,
    resumeRevision: includeProtectedContent
      ? pickPackageRevision(readiness.baseline.resume.revision)
      : pickPackageRevisionMetadata(readiness.baseline.resume.revision),
    resumeRender: readiness.baseline.resume.reviewedRender,
    coverLetterRevision: includeProtectedContent
      ? pickPackageRevision(readiness.baseline['cover-letter'].revision)
      : pickPackageRevisionMetadata(readiness.baseline['cover-letter'].revision),
    coverLetterRender: readiness.baseline['cover-letter'].reviewedRender,
    answers: readiness.answers.map((item) => ({
      formFieldId: item.field.id,
      label: item.field.protected ? 'Protected application question' : item.field.label,
      protected: Boolean(item.field.protected),
      revision: includeProtectedContent
        ? pickPackageRevision(item.material.revision)
        : (item.field.protected
          ? pickPackageProtectedRevisionMetadata(item.material.revision)
          : pickPackageRevisionMetadata(item.material.revision))
    })),
    fieldResolutions: formFieldResolutions,
    formCaptureId: readiness.form.currentCaptureId,
    formStateSha256: readiness.form.stateSha256,
    assessmentId: readiness.assessment.assessment.id,
    assessmentGateId: readiness.assessment.gate.id,
    readinessManifest: includeProtectedContent ? readiness.manifest : sanitizePublicReadiness(readiness).manifest,
    readinessSha256: readiness.readinessSha256
  };
}

function computeApplicationPackageIntegrity(packageRow) {
  if (!packageRow) throw new ApplicationMaterialsError('NOT_FOUND', 'Application package not found');
  const content = packageRow.content === undefined || packageRow.content === null ? null : String(packageRow.content);
  const storedContentSha = packageRow.content_sha256 || null;
  const computedContentSha = content === null ? null : sha256(content);
  if (storedContentSha !== computedContentSha) {
    throw new ApplicationMaterialsError(
      'PACKAGE_CONTENT_DIGEST_MISMATCH',
      'Application package content does not match its stored content SHA-256'
    );
  }
  const attachmentSha256 = hashManagedAttachment(packageRow.attachment_path, 'application package attachment');
  const snapshot = {
    packageId: packageRow.id,
    applicationId: packageRow.application_id,
    notes: packageRow.notes || null,
    attachmentPath: packageRow.attachment_path || null,
    attachmentSha256,
    content,
    contentSha256: storedContentSha,
    coverLetterId: packageRow.cover_letter_id || null,
    resumeId: packageRow.resume_id || null,
    assessmentId: packageRow.assessment_id || null,
    assessmentGateId: packageRow.assessment_gate_id || null,
    profileSnapshot: packageRow.profile_snapshot || null,
    applicationSnapshot: packageRow.application_snapshot || null,
    artifactRefs: packageRow.artifact_refs || null,
    checklist: packageRow.checklist || null,
    exportPolicy: packageRow.export_policy || null,
    createdAt: packageRow.created_at
  };
  const snapshotJson = stableJson(snapshot);
  return {
    snapshot,
    snapshotJson,
    snapshotSha256: sha256(snapshotJson),
    attachmentSha256
  };
}

const PROFILE_CONTACT_EXPORT_COLUMNS = Object.freeze({
  name: 'name',
  email: 'email',
  phone: 'phone',
  location: 'location',
  headline: 'headline',
  summary: 'professional_summary',
  work_authorization: 'work_authorization',
  sponsorship: 'visa_sponsorship',
  relocation: 'relocation_willingness',
  remote_preference: 'remote_preference',
  compensation: 'compensation_expectations',
  notice_period: 'notice_period',
  start_date: 'earliest_start_date'
});

const MANAGED_PROFILE_SNAPSHOT_NOTE = 'Managed packages include only explicitly selected custom material revisions. Reusable profile entries and answers are source evidence, not bulk package output.';

function assertExportedProfileSnapshotCurrent(db, packageRow) {
  if (!packageRow.profile_snapshot && !packageRow.export_policy) {
    return { snapshot: null, snapshotSha256: null };
  }
  if (!packageRow.profile_snapshot || !packageRow.export_policy) {
    throw new ApplicationMaterialsError('EXPORTED_PROFILE_SNAPSHOT_INVALID', 'Application package profile snapshot and export policy must be stored together');
  }
  const exportPolicy = parsePackageObject(packageRow.export_policy, 'application package export policy');
  const storedSnapshot = parsePackageObject(packageRow.profile_snapshot, 'application package profile snapshot');
  if (exportPolicy.defaultDeny !== true || !Array.isArray(exportPolicy.contactFields)) {
    throw new ApplicationMaterialsError('EXPORTED_PROFILE_SNAPSHOT_INVALID', 'Managed profile exports require a default-deny policy and explicit contact field list');
  }
  const contactFields = exportPolicy.contactFields.map((field) => String(field));
  const unknownContactFields = contactFields.filter((field) => !Object.hasOwn(PROFILE_CONTACT_EXPORT_COLUMNS, field));
  if (unknownContactFields.length || new Set(contactFields).size !== contactFields.length) {
    throw new ApplicationMaterialsError('EXPORTED_PROFILE_SNAPSHOT_INVALID', 'Managed profile export policy contains unknown or duplicate contact fields');
  }
  const contactRow = db.prepare('SELECT * FROM profile_contact WHERE id=1').get() || null;
  const contact = contactRow
    ? Object.fromEntries(contactFields.map((field) => {
      const column = PROFILE_CONTACT_EXPORT_COLUMNS[field];
      return [column, contactRow[column]];
    }))
    : null;
  const references = exportPolicy.includeReferences === true
    ? db.prepare('SELECT * FROM profile_references ORDER BY datetime(updated_at) DESC,id DESC').all()
      .map((row) => ({ ...row, tags: parseJson(row.tags, []) }))
    : [];
  const eeoRow = exportPolicy.includeEeo === true
    ? db.prepare('SELECT * FROM profile_eeo WHERE id=1').get() || null
    : null;
  const eeo = eeoRow ? { ...eeoRow, tags: parseJson(eeoRow.tags, []) } : null;
  const currentSnapshot = {
    contact,
    references,
    eeo,
    entries: [],
    exportPolicy,
    note: MANAGED_PROFILE_SNAPSHOT_NOTE
  };
  const storedCanonical = stableJson(storedSnapshot);
  const currentCanonical = stableJson(currentSnapshot);
  if (storedCanonical !== currentCanonical) {
    throw new ApplicationMaterialsError(
      'EXPORTED_PROFILE_SOURCE_STALE',
      'Profile data explicitly exported into the application package changed after the package was built'
    );
  }
  return { snapshot: currentSnapshot, snapshotSha256: sha256(currentCanonical) };
}

function parsePackageObject(value, label) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new ApplicationMaterialsError('EXPORTED_PROFILE_SNAPSHOT_INVALID', `${label} is not a valid JSON object`);
  }
}

function assertApplicationPackageIntegrity(db, packageId, boundSnapshot = null) {
  const id = positiveId(packageId, 'application package id');
  const packageRow = db.prepare('SELECT * FROM application_packages WHERE id=?').get(id);
  if (!packageRow) throw new ApplicationMaterialsError('NOT_FOUND', `Application package ${id} not found`);
  const binding = boundSnapshot || db.prepare(`
    SELECT * FROM application_package_preparation_snapshots WHERE application_package_id=?
  `).get(id);
  if (!binding) throw new ApplicationMaterialsError('PACKAGE_NOT_BOUND', `Application package ${id} has no preparation snapshot`);
  let storedCanonical;
  try { storedCanonical = stableJson(JSON.parse(binding.package_snapshot_json)); }
  catch { throw new ApplicationMaterialsError('PACKAGE_SNAPSHOT_INVALID', 'Stored package snapshot is not valid JSON'); }
  if (sha256(storedCanonical) !== binding.package_snapshot_sha256) {
    throw new ApplicationMaterialsError('PACKAGE_SNAPSHOT_DIGEST_MISMATCH', 'Stored package snapshot does not match its SHA-256');
  }
  const integrity = computeApplicationPackageIntegrity(packageRow);
  if (integrity.snapshotJson !== storedCanonical
    || integrity.snapshotSha256 !== binding.package_snapshot_sha256
    || integrity.attachmentSha256 !== binding.package_attachment_sha256) {
    throw new ApplicationMaterialsError('PACKAGE_INTEGRITY_MISMATCH', 'Application package row or attachment bytes changed after preparation binding');
  }
  if (!binding.resume_render_id || !binding.cover_letter_render_id) {
    throw new ApplicationMaterialsError('PACKAGE_DOCUMENT_RENDER_BINDING_MISSING', 'Application package does not bind both reviewed document PDFs');
  }
  const resumeRenderIntegrity = assertMaterialRenderIntegrity(db, binding.resume_render_id, binding.application_id);
  const coverLetterRenderIntegrity = assertMaterialRenderIntegrity(db, binding.cover_letter_render_id, binding.application_id);
  if (resumeRenderIntegrity.render.revision_id !== binding.resume_revision_id
    || coverLetterRenderIntegrity.render.revision_id !== binding.cover_letter_revision_id) {
    throw new ApplicationMaterialsError('PACKAGE_DOCUMENT_RENDER_BINDING_MISMATCH', 'Application package document PDFs do not belong to its bound revisions');
  }
  const exportedProfile = assertExportedProfileSnapshotCurrent(db, packageRow);
  return { package: packageRow, binding, exportedProfile, resumeRenderIntegrity, coverLetterRenderIntegrity, ...integrity };
}

function assertBoundPreparationMatchesCurrent(db, binding, currentSelection) {
  let readinessManifest;
  try { readinessManifest = JSON.parse(binding.readiness_manifest_json); }
  catch { throw new ApplicationMaterialsError('READINESS_SNAPSHOT_INVALID', 'Stored readiness manifest is not valid JSON'); }
  const canonicalManifest = stableJson(readinessManifest);
  if (sha256(canonicalManifest) !== binding.readiness_sha256) {
    throw new ApplicationMaterialsError('READINESS_SNAPSHOT_DIGEST_MISMATCH', 'Stored readiness manifest does not match its SHA-256');
  }
  const scalarCurrent = {
    applicationId: currentSelection.applicationId,
    resumeRevisionId: currentSelection.resumeRevision.id,
    resumeRenderId: currentSelection.resumeRender.id,
    resumePdfSha256: currentSelection.resumeRender.output_sha256,
    resumePdfBytes: currentSelection.resumeRender.output_bytes,
    resumePageCount: currentSelection.resumeRender.page_count,
    resumeRendererProfile: currentSelection.resumeRender.renderer_profile,
    resumeRendererImageDigest: currentSelection.resumeRender.renderer_image_digest,
    resumeRendererVersion: currentSelection.resumeRender.renderer_version,
    resumeRendererBundleSha256: currentSelection.resumeRender.bundle_sha256,
    resumeActiveContentPolicy: currentSelection.resumeRender.active_content_policy,
    resumeActiveContentScanSha256: currentSelection.resumeRender.active_content_scan_sha256,
    coverLetterRevisionId: currentSelection.coverLetterRevision.id,
    coverLetterRenderId: currentSelection.coverLetterRender.id,
    coverLetterPdfSha256: currentSelection.coverLetterRender.output_sha256,
    coverLetterPdfBytes: currentSelection.coverLetterRender.output_bytes,
    coverLetterPageCount: currentSelection.coverLetterRender.page_count,
    coverLetterRendererProfile: currentSelection.coverLetterRender.renderer_profile,
    coverLetterRendererImageDigest: currentSelection.coverLetterRender.renderer_image_digest,
    coverLetterRendererVersion: currentSelection.coverLetterRender.renderer_version,
    coverLetterRendererBundleSha256: currentSelection.coverLetterRender.bundle_sha256,
    coverLetterActiveContentPolicy: currentSelection.coverLetterRender.active_content_policy,
    coverLetterActiveContentScanSha256: currentSelection.coverLetterRender.active_content_scan_sha256,
    formCaptureId: currentSelection.formCaptureId,
    formStateSha256: currentSelection.formStateSha256,
    assessmentId: currentSelection.assessmentId,
    assessmentGateId: currentSelection.assessmentGateId,
    readinessSha256: currentSelection.readinessSha256
  };
  const scalarBound = {
    applicationId: binding.application_id,
    resumeRevisionId: binding.resume_revision_id,
    resumeRenderId: binding.resume_render_id,
    resumePdfSha256: readinessManifest.resumePdfSha256,
    resumePdfBytes: readinessManifest.resumePdfBytes,
    resumePageCount: readinessManifest.resumePageCount,
    resumeRendererProfile: readinessManifest.resumeRendererProfile,
    resumeRendererImageDigest: readinessManifest.resumeRendererImageDigest,
    resumeRendererVersion: readinessManifest.resumeRendererVersion,
    resumeRendererBundleSha256: readinessManifest.resumeRendererBundleSha256,
    resumeActiveContentPolicy: readinessManifest.resumeActiveContentPolicy,
    resumeActiveContentScanSha256: readinessManifest.resumeActiveContentScanSha256,
    coverLetterRevisionId: binding.cover_letter_revision_id,
    coverLetterRenderId: binding.cover_letter_render_id,
    coverLetterPdfSha256: readinessManifest.coverLetterPdfSha256,
    coverLetterPdfBytes: readinessManifest.coverLetterPdfBytes,
    coverLetterPageCount: readinessManifest.coverLetterPageCount,
    coverLetterRendererProfile: readinessManifest.coverLetterRendererProfile,
    coverLetterRendererImageDigest: readinessManifest.coverLetterRendererImageDigest,
    coverLetterRendererVersion: readinessManifest.coverLetterRendererVersion,
    coverLetterRendererBundleSha256: readinessManifest.coverLetterRendererBundleSha256,
    coverLetterActiveContentPolicy: readinessManifest.coverLetterActiveContentPolicy,
    coverLetterActiveContentScanSha256: readinessManifest.coverLetterActiveContentScanSha256,
    formCaptureId: binding.form_capture_id,
    formStateSha256: binding.form_state_sha256,
    assessmentId: binding.assessment_id,
    assessmentGateId: binding.assessment_gate_id,
    readinessSha256: binding.readiness_sha256
  };
  if (stableJson(scalarCurrent) !== stableJson(scalarBound)) {
    throw new ApplicationMaterialsError('STALE_READINESS', 'Current approved selections no longer match the bound package preparation snapshot');
  }
  const currentAnswers = currentSelection.answers.map((answer) => ({
    formFieldId: answer.formFieldId,
    revisionId: answer.revision.id,
    contentSha256: answer.revision.content_sha256,
    optionIds: (answer.revision.formOptions || []).map((option) => option.option_id),
    optionLabels: (answer.revision.formOptions || []).map((option) => option.label)
  })).sort((a, b) => a.formFieldId - b.formFieldId);
  const boundAnswers = readPackageAnswerBindings(db, binding.application_package_id).map((answer) => ({
    formFieldId: answer.form_field_id,
    revisionId: answer.answer_revision_id,
    contentSha256: answer.content_sha256,
    optionIds: answer.options.map((option) => option.option_id),
    optionLabels: answer.options.map((option) => option.option_label)
  })).sort((a, b) => a.formFieldId - b.formFieldId);
  const manifestAnswers = Array.isArray(readinessManifest.answers) ? readinessManifest.answers : [];
  if (stableJson(currentAnswers) !== stableJson(boundAnswers)
    || stableJson(currentAnswers) !== stableJson(manifestAnswers)) {
    throw new ApplicationMaterialsError('PACKAGE_ANSWER_BINDING_MISMATCH', 'Bound application answers/options are incomplete or no longer match current readiness');
  }
}

function bindPackagePreparationSnapshot(db, input) {
  const applicationId = positiveId(input.applicationId, 'application id');
  const packageId = positiveId(input.packageId || input.applicationPackageId, 'application package id');
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key', 200);
  const snapshot = buildPackageSelectionSnapshot(db, applicationId, {
    expectedReadinessSha256: input.expectedReadinessSha256,
    includeProtectedContent: true
  });
  const packageBuildIntentSha256 = input.packageBuildIntentSha256
    ? sha256Text(input.packageBuildIntentSha256, 'package build intent SHA-256')
    : sha256(stableJson({ packageId, applicationId, readinessSha256: snapshot.readinessSha256 }));
  const intent = { packageId, applicationId, readinessSha256: snapshot.readinessSha256, packageBuildIntentSha256 };
  const result = idempotentOperation(db, 'bind-package-preparation', idempotencyKey, intent, () => {
    const packageRow = db.prepare('SELECT * FROM application_packages WHERE id=? AND application_id=?').get(packageId, applicationId);
    if (!packageRow) throw new ApplicationMaterialsError('NOT_FOUND', `Application package ${packageId} not found for application ${applicationId}`);
    if (packageRow.package_status !== 'ready') {
      throw new ApplicationMaterialsError('PACKAGE_NOT_READY', `Application package ${packageId} must be ready before preparation is bound`);
    }
    if ((packageRow.assessment_id !== null && packageRow.assessment_id !== snapshot.assessmentId)
      || (packageRow.assessment_gate_id !== null && packageRow.assessment_gate_id !== snapshot.assessmentGateId)) {
      throw new ApplicationMaterialsError('PACKAGE_EVIDENCE_MISMATCH', 'Application package is already bound to different assessment evidence');
    }
    const projected = db.prepare(`
      UPDATE application_packages SET assessment_id=?,assessment_gate_id=?,updated_at=datetime('now')
      WHERE id=? AND application_id=?
        AND (assessment_id IS NULL OR assessment_id=?)
        AND (assessment_gate_id IS NULL OR assessment_gate_id=?)
    `).run(
      snapshot.assessmentId, snapshot.assessmentGateId, packageId, applicationId,
      snapshot.assessmentId, snapshot.assessmentGateId
    );
    if (projected.changes !== 1) {
      throw new ApplicationMaterialsError('PACKAGE_EVIDENCE_MISMATCH', 'Application package assessment evidence changed concurrently');
    }
    const projectedPackage = db.prepare('SELECT * FROM application_packages WHERE id=? AND application_id=?').get(packageId, applicationId);
    const packageIntegrity = computeApplicationPackageIntegrity(projectedPackage);
    const info = db.prepare(`
      INSERT INTO application_package_preparation_snapshots(
        application_package_id,application_id,resume_revision_id,cover_letter_revision_id,form_capture_id,
        form_state_sha256,assessment_id,assessment_gate_id,readiness_manifest_json,readiness_sha256,
        package_snapshot_json,package_snapshot_sha256,package_attachment_sha256,package_build_intent_sha256,
        idempotency_key,intent_sha256,resume_render_id,cover_letter_render_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      packageId, applicationId, snapshot.resumeRevision.id, snapshot.coverLetterRevision.id,
      snapshot.formCaptureId, snapshot.formStateSha256, snapshot.assessmentId, snapshot.assessmentGateId,
      stableJson(snapshot.readinessManifest), snapshot.readinessSha256,
      packageIntegrity.snapshotJson, packageIntegrity.snapshotSha256, packageIntegrity.attachmentSha256, packageBuildIntentSha256,
      `${idempotencyKey}:snapshot`, sha256(stableJson(intent)),
      snapshot.resumeRender.id, snapshot.coverLetterRender.id
    );
    const insertAnswer = db.prepare(`
      INSERT INTO application_package_answer_bindings(application_package_id,form_field_id,answer_revision_id,content_sha256)
      VALUES (?,?,?,?)
    `);
    const insertAnswerOption = db.prepare(`
      INSERT INTO application_package_answer_option_bindings(
        application_package_id,form_field_id,option_id,option_label,selection_position
      ) VALUES (?,?,?,?,?)
    `);
    for (const answer of snapshot.answers) {
      insertAnswer.run(packageId, answer.formFieldId, answer.revision.id, answer.revision.content_sha256);
      for (const option of answer.revision.formOptions || []) {
        insertAnswerOption.run(packageId, answer.formFieldId, option.option_id, option.label, option.selection_position);
      }
    }
    const storedSnapshot = db.prepare('SELECT * FROM application_package_preparation_snapshots WHERE application_package_id=?').get(packageId);
    assertApplicationPackageIntegrity(db, packageId, storedSnapshot);
    assertBoundPreparationMatchesCurrent(db, storedSnapshot, snapshot);
    return {
      snapshot: storedSnapshot,
      answers: readPackageAnswerBindings(db, packageId),
      answerOptions: db.prepare(`
        SELECT * FROM application_package_answer_option_bindings
        WHERE application_package_id=? ORDER BY form_field_id,selection_position
      `).all(packageId),
      selection: snapshot,
      inserted: info.changes === 1
    };
  });
  assertApplicationPackageIntegrity(db, packageId);
  return result;
}

function readPackageAnswerBindings(db, packageId) {
  return db.prepare(`
    SELECT * FROM application_package_answer_bindings WHERE application_package_id=? ORDER BY form_field_id
  `).all(packageId).map((answer) => ({
    ...answer,
    options: db.prepare(`
      SELECT * FROM application_package_answer_option_bindings
      WHERE application_package_id=? AND form_field_id=? ORDER BY selection_position
    `).all(packageId, answer.form_field_id)
  }));
}

/**
 * The canonical facts a submission intent digests for a prepared package:
 * `documents` maps material-kind slug -> rendered PDF SHA-256 (the exact bytes
 * verify-uploads checks), and `answers` maps bound form-field id -> the
 * answer's content digest plus its selected options. Propose a submission
 * intent from these (application-submission propose --package-id) and the
 * signed approval covers precisely what the package carries;
 * record-submission recomputes the documents map to prove a cited attempt did.
 */
function readPackageSubmissionFacts(db, input) {
  const applicationId = positiveId(input.applicationId, 'application id');
  const packageId = positiveId(input.packageId || input.applicationPackageId, 'application package id');
  const integrity = assertApplicationPackageIntegrity(db, packageId);
  if (integrity.binding.application_id !== applicationId) {
    throw new ApplicationMaterialsError('PACKAGE_NOT_BOUND', `Package ${packageId} is not a preparation-bound package for application ${applicationId}`);
  }
  if (input.expectedReadinessSha256 !== undefined && input.expectedReadinessSha256 !== null) {
    const expected = sha256Text(input.expectedReadinessSha256, 'expected readiness SHA-256');
    if (integrity.binding.readiness_sha256 !== expected) {
      throw new ApplicationMaterialsError(
        'STALE_READINESS',
        `Expected package readiness ${expected}, found ${integrity.binding.readiness_sha256}`
      );
    }
  }
  return {
    applicationId,
    packageId,
    packageStatus: integrity.package.package_status,
    readinessSha256: integrity.binding.readiness_sha256,
    documents: packageSubmissionDocuments(integrity),
    answers: packageSubmissionAnswers(db, packageId)
  };
}

function packageSubmissionDocuments(integrity) {
  return {
    resume: integrity.resumeRenderIntegrity.render.output_sha256,
    'cover-letter': integrity.coverLetterRenderIntegrity.render.output_sha256
  };
}

function packageSubmissionAnswers(db, packageId) {
  const answers = {};
  for (const row of readPackageAnswerBindings(db, packageId)) {
    answers[String(row.form_field_id)] = {
      contentSha256: row.content_sha256,
      optionIds: row.options.map((option) => option.option_id),
      optionLabels: row.options.map((option) => option.option_label)
    };
  }
  return answers;
}

/**
 * A submission event may cite the lane attempt that carried it only when that
 * attempt (a) belongs to this application, (b) settled as accepted, and (c)
 * was approved over EXACTLY this package's document bytes — the intent's
 * documents digest must equal the digest of the package's rendered PDFs.
 * Anything less would launder an approval that covered different content.
 * The answer set is deliberately NOT re-checked here: a wire form may carry
 * fields beyond the package's bound answers, and the signed intent remains
 * the authority on what answer set was approved.
 */
function assertRecordableSubmissionAttempt(db, { attemptId, applicationId, packageIntegrity }) {
  // Lazy: the submission lane is a sibling, not a dependency of this module's
  // load graph, and only this citation path reads it.
  const { migrateApplicationSubmissions } = require('./application-submission');
  migrateApplicationSubmissions(db);
  const attempt = db.prepare(`
    SELECT t.attempt_id, t.outcome, t.settled_at, a.approval_id, a.approver_kind, a.approver_id,
           i.intent_id, i.application_id AS intent_application_id, i.documents_digest
    FROM application_submission_attempts t
    JOIN application_submission_approvals a ON a.approval_id=t.approval_id
    JOIN application_submission_intents i ON i.intent_id=a.intent_id
    WHERE t.attempt_id=?
  `).get(attemptId);
  if (!attempt) {
    throw new ApplicationMaterialsError('SUBMISSION_ATTEMPT_NOT_FOUND', `Submission attempt ${attemptId} not found`);
  }
  if (attempt.intent_application_id !== applicationId) {
    throw new ApplicationMaterialsError(
      'SUBMISSION_ATTEMPT_WRONG_APPLICATION',
      `Submission attempt ${attemptId} belongs to application ${attempt.intent_application_id}, not ${applicationId}`
    );
  }
  if (attempt.outcome === null) {
    throw new ApplicationMaterialsError(
      'SUBMISSION_ATTEMPT_UNRECONCILED',
      `Submission attempt ${attemptId} has no settled outcome; settle it definitively (application-submission settle) before recording the submission`
    );
  }
  if (attempt.outcome !== 'accepted') {
    throw new ApplicationMaterialsError(
      'SUBMISSION_ATTEMPT_NOT_ACCEPTED',
      `Submission attempt ${attemptId} settled as ${attempt.outcome}; only an accepted attempt can record a submission`
    );
  }
  const documents = packageSubmissionDocuments(packageIntegrity);
  if (digestCanonicalJson(documents) !== attempt.documents_digest) {
    throw new ApplicationMaterialsError(
      'SUBMISSION_ATTEMPT_DOCUMENTS_MISMATCH',
      `Submission attempt ${attemptId} was approved over different document bytes than this package renders; `
      + 'propose the intent from this package (application-submission propose --package-id) so the approval covers the delivered files'
    );
  }
  return attempt;
}

function recordApplicationSubmission(db, input) {
  const applicationId = positiveId(input.applicationId, 'application id');
  const packageId = positiveId(input.packageId || input.applicationPackageId, 'application package id');
  const attemptId = optionalText(input.attemptId, 'submission attempt id', 200);
  const submittedBy = requiredText(input.submittedBy, 'submitted by', 200);
  const expectedReadinessSha256 = sha256Text(input.expectedReadinessSha256, 'expected readiness SHA-256');
  const submittedAtInput = input.submittedAt ? normalizedTimestamp(input.submittedAt, 'submitted at') : null;
  const notes = optionalText(input.notes, 'notes', 20000);
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key', 200);
  const intent = {
    applicationId,
    packageId,
    submittedBy,
    submittedAt: submittedAtInput,
    expectedReadinessSha256,
    notes,
    // Only present when a lane attempt is cited, so pre-existing recorded
    // intents replay byte-identically under their idempotency keys.
    ...(attemptId ? { attemptId } : {})
  };
  return idempotentOperation(db, 'record-application-submission', idempotencyKey, intent, () => {
    const application = requireApplication(db, applicationId);
    const plan = readPreparationPlan(db, applicationId);
    if (!plan || plan.mode !== 'managed') {
      throw new ApplicationMaterialsError('PREPARATION_NOT_MANAGED', 'Manual submission recording requires a managed application preparation plan');
    }
    const prior = db.prepare('SELECT * FROM application_material_submission_events WHERE application_id=?').get(applicationId);
    if (prior) {
      throw new ApplicationMaterialsError(
        'SUBMISSION_ALREADY_RECORDED',
        `Application ${applicationId} already has manual submission event ${prior.id}`,
        { submissionEventId: prior.id, applicationPackageId: prior.application_package_id }
      );
    }
    const boundSnapshot = db.prepare(`
      SELECT s.* FROM application_package_preparation_snapshots s
      JOIN application_packages p ON p.id=s.application_package_id AND p.application_id=s.application_id
      WHERE s.application_package_id=? AND s.application_id=?
    `).get(packageId, applicationId);
    if (!boundSnapshot) {
      throw new ApplicationMaterialsError('PACKAGE_NOT_BOUND', `Package ${packageId} is not an exact preparation-bound package for application ${applicationId}`);
    }
    if (boundSnapshot.readiness_sha256 !== expectedReadinessSha256) {
      throw new ApplicationMaterialsError(
        'STALE_READINESS',
        `Expected package readiness ${expectedReadinessSha256}, found ${boundSnapshot.readiness_sha256}`
      );
    }
    const packageIntegrity = assertApplicationPackageIntegrity(db, packageId, boundSnapshot);
    if (packageIntegrity.package.package_status !== 'ready') {
      throw new ApplicationMaterialsError('PACKAGE_NOT_READY', `Package ${packageId} is ${packageIntegrity.package.package_status}, not ready`);
    }
    if (application.workflow_stage !== 'package_ready') {
      throw new ApplicationMaterialsError(
        'APPLICATION_NOT_PACKAGE_READY',
        `Application ${applicationId} is ${application.workflow_stage}, not package_ready`
      );
    }
    const currentSelection = buildPackageSelectionSnapshot(db, applicationId, {
      expectedReadinessSha256,
      includeProtectedContent: true
    });
    assertBoundPreparationMatchesCurrent(db, boundSnapshot, currentSelection);
    // The chain has to reach the bytes that were actually carried. Everything
    // above this line describes a PDF in the store; drill r2608050256bb3f
    // uploaded a resume that was byte-corrupt in transit while every upstream
    // gate stayed green. Recording a submission asserts the delivered file was
    // the selected render.
    assertUploadsVerified(db, applicationId);
    const attemptBinding = attemptId
      ? assertRecordableSubmissionAttempt(db, { attemptId, applicationId, packageIntegrity })
      : null;
    const submittedAt = submittedAtInput || new Date().toISOString();
    const eventInfo = db.prepare(`
      INSERT INTO application_material_submission_events(
        application_id,application_package_id,readiness_sha256,package_snapshot_sha256,package_attachment_sha256,
        submitted_by,submitted_at,notes,submission_attempt_id,
        idempotency_key,intent_sha256
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      applicationId,
      packageId,
      expectedReadinessSha256,
      packageIntegrity.snapshotSha256,
      packageIntegrity.attachmentSha256,
      submittedBy,
      submittedAt,
      notes,
      attemptId,
      `${idempotencyKey}:event`,
      sha256(stableJson(intent))
    );
    const eventId = Number(eventInfo.lastInsertRowid);
    return {
      submission: db.prepare('SELECT * FROM application_material_submission_events WHERE id=?').get(eventId),
      package: db.prepare('SELECT * FROM application_packages WHERE id=?').get(packageId),
      application: db.prepare('SELECT * FROM applications WHERE id=?').get(applicationId),
      lifecycleEvent: db.prepare(`
        SELECT * FROM application_lifecycle_events
        WHERE application_id=? AND event_kind='manual_submission_recorded' ORDER BY id DESC LIMIT 1
      `).get(applicationId),
      submissionAttempt: attemptBinding
        ? {
          attemptId: attemptBinding.attempt_id,
          intentId: attemptBinding.intent_id,
          approvalId: attemptBinding.approval_id,
          approverKind: attemptBinding.approver_kind,
          approverId: attemptBinding.approver_id,
          settledAt: attemptBinding.settled_at,
          outcome: attemptBinding.outcome
        }
        : null,
      recorded: true
    };
  });
}

function pickPackageRevision(revision) {
  return {
    ...pick(revision, [
      'id', 'material_id', 'revision_number', 'revision_stage', 'content', 'content_sha256',
      'source_format', 'generation_contract_version', 'source_manifest_id', 'authored_by', 'created_at'
    ]),
    formOptions: revision.formOptions || []
  };
}

function pickPackageRevisionMetadata(revision) {
  return {
    ...pick(revision, [
      'id', 'material_id', 'application_id', 'material_kind', 'form_field_id',
      'revision_number', 'parent_revision_id', 'revision_stage', 'content_sha256', 'source_format',
      'generation_contract_version', 'source_manifest_id', 'authorship', 'authored_by', 'created_at',
      'is_head', 'is_selected', 'latest_review_id', 'latest_review_render_id',
      'latest_review_decision', 'latest_review_approved'
    ]),
    formOptions: (revision.formOptions || []).map((option) => pick(option, [
      'form_field_id', 'option_id', 'selection_position', 'provider_option_key', 'label'
    ])),
    renders: Array.isArray(revision.renders)
      ? revision.renders.map((render) => render.protected_payload_redacted
        ? { ...render }
        : projectPublicMaterialRender(render))
      : []
  };
}

function pickPackageProtectedRevisionMetadata(revision) {
  return {
    ...pick(revision, [
      'id', 'material_id', 'application_id', 'material_kind', 'form_field_id',
      'revision_number', 'revision_stage', 'content_sha256', 'source_format',
      'generation_contract_version', 'source_manifest_id', 'authorship', 'authored_by', 'created_at'
    ]),
    selectedOptionCount: Array.isArray(revision.formOptions) ? revision.formOptions.length : 0,
    protectedPayloadRedacted: true
  };
}

function projectPublicApplicationPackage(row) {
  if (!row) return null;
  return {
    ...pick(row, [
      'id', 'application_id', 'package_status', 'cover_letter_id', 'resume_id',
      'assessment_id', 'assessment_gate_id', 'content_sha256', 'created_at', 'updated_at',
      'readiness_sha256', 'form_state_sha256', 'resume_revision_id', 'cover_letter_revision_id',
      'resume_render_id', 'cover_letter_render_id',
      'package_integrity_current', 'package_integrity_error_code',
      'preparation_snapshot_current', 'preparation_snapshot_stale'
    ]),
    has_content: row.content !== undefined ? row.content !== null : undefined,
    has_attachment: row.attachment_path !== undefined ? row.attachment_path !== null : undefined,
    protected_payload_redacted: true
  };
}

function projectPublicPackagePreparationSnapshot(row) {
  if (!row) return null;
  return pick(row, [
    'id', 'application_package_id', 'application_id', 'resume_revision_id',
    'cover_letter_revision_id', 'resume_render_id', 'cover_letter_render_id',
    'form_capture_id', 'form_state_sha256', 'assessment_id',
    'assessment_gate_id', 'readiness_sha256', 'package_snapshot_sha256',
    'package_attachment_sha256', 'package_build_intent_sha256', 'created_at'
  ]);
}

function projectPublicPackageAnswerOptionBinding(db, row) {
  if (!row) return null;
  if (!storedFormFieldIsProtected(db, row.form_field_id)) return row;
  return {
    application_package_id: row.application_package_id,
    form_field_id: row.form_field_id,
    selection_position: row.selection_position,
    protected: true
  };
}

function getApplicationMaterialsReadModel(db, applicationId) {
  const application = requireApplication(db, applicationId);
  const readiness = getApplicationReadiness(db, application.id);
  return {
    application,
    plan: readiness.plan,
    readiness,
    requirements: db.prepare(`
      SELECT r.*,k.slug AS material_kind,k.label AS material_kind_label,q.slug AS requiredness
      FROM application_material_requirements r
      JOIN application_material_kinds k ON k.id=r.material_kind_id
      JOIN information_requiredness_levels q ON q.id=r.requiredness_id
      WHERE r.application_id=? ORDER BY k.sort_rank,r.id
    `).all(application.id),
    materials: listApplicationMaterials(db, application.id),
    packages: db.prepare(`
      SELECT p.*,s.readiness_sha256,s.form_state_sha256,s.resume_revision_id,s.cover_letter_revision_id,
        s.resume_render_id,s.cover_letter_render_id
      FROM application_packages p LEFT JOIN application_package_preparation_snapshots s ON s.application_package_id=p.id
      WHERE p.application_id=? ORDER BY p.id DESC
    `).all(application.id).map((row) => {
      let packageIntegrityCurrent = null;
      let packageIntegrityErrorCode = null;
      if (row.readiness_sha256) {
        try {
          const integrity = assertApplicationPackageIntegrity(db, row.id);
          if (row.readiness_sha256 === readiness.readinessSha256 && readiness.ready) {
            const currentSelection = buildPackageSelectionSnapshot(db, application.id, {
              expectedReadinessSha256: readiness.readinessSha256,
              includeProtectedContent: true
            });
            assertBoundPreparationMatchesCurrent(db, integrity.binding, currentSelection);
          }
          packageIntegrityCurrent = 1;
        }
        catch (error) {
          packageIntegrityCurrent = 0;
          packageIntegrityErrorCode = error instanceof ApplicationMaterialsError ? error.code : 'PACKAGE_INTEGRITY_CHECK_FAILED';
        }
      }
      const readinessCurrent = row.readiness_sha256 ? row.readiness_sha256 === readiness.readinessSha256 : null;
      return projectPublicApplicationPackage({
        ...row,
        package_integrity_current: packageIntegrityCurrent,
        package_integrity_error_code: packageIntegrityErrorCode,
        preparation_snapshot_current: row.readiness_sha256 ? Number(readinessCurrent && packageIntegrityCurrent === 1) : null,
        preparation_snapshot_stale: row.readiness_sha256 ? Number(!readinessCurrent || packageIntegrityCurrent !== 1) : null
      });
    }),
    submissions: db.prepare(`
      SELECT * FROM application_material_submission_events WHERE application_id=? ORDER BY submitted_at DESC,id DESC
    `).all(application.id),
    packageAnswerOptions: db.prepare(`
      SELECT b.*,o.provider_option_key
      FROM application_package_answer_option_bindings b
      JOIN application_packages p ON p.id=b.application_package_id
      JOIN application_form_field_options o ON o.id=b.option_id
      WHERE p.application_id=? ORDER BY b.application_package_id,b.form_field_id,b.selection_position
    `).all(application.id).map((row) => projectPublicPackageAnswerOptionBinding(db, row))
  };
}

function listApplicationMaterials(db, applicationId) {
  return db.prepare(`
    SELECT m.*,k.slug AS kind,k.label AS kind_label,h.revision_id AS head_revision_id,h.lock_version AS head_lock_version,
      s.revision_id AS selected_revision_id,s.lock_version AS selection_lock_version
    FROM application_materials m JOIN application_material_kinds k ON k.id=m.material_kind_id
    LEFT JOIN application_material_heads h ON h.material_id=m.id
    LEFT JOIN application_material_selections s ON s.material_id=m.id
    WHERE m.application_id=? ORDER BY k.sort_rank,m.form_field_id,m.id
  `).all(applicationId).map((material) => {
    const revisions = db.prepare('SELECT id FROM application_material_revision_current_state WHERE material_id=? ORDER BY revision_number DESC').all(material.id)
      .map((row) => getMaterialRevision(db, row.id, applicationId));
    const protectedField = material.form_field_id ? storedFormFieldIsProtected(db, material.form_field_id) : false;
    const publicRevision = (revision) => !revision
      ? null
      : (protectedField
        ? pickPackageProtectedRevisionMetadata(revision)
        : { ...pickPackageRevisionMetadata(revision), protectedPayloadRedacted: true });
    return {
      ...material,
      protected: protectedField,
      revisions: revisions.map(publicRevision),
      selectedRevision: material.selected_revision_id
        ? publicRevision(revisions.find((revision) => revision.id === material.selected_revision_id)
          || getMaterialRevision(db, material.selected_revision_id, applicationId))
        : null
    };
  });
}

function storedFormFieldIsProtected(db, formFieldId) {
  const field = db.prepare(`
    SELECT f.*,ik.slug AS input_kind,sens.slug AS sensitivity,pif.slug AS information_field_slug
    FROM application_form_fields f
    JOIN application_form_input_kinds ik ON ik.id=f.input_kind_id
    JOIN information_sensitivity_levels sens ON sens.id=f.sensitivity_level_id
    LEFT JOIN profile_information_fields pif ON pif.id=f.profile_information_field_id
    WHERE f.id=?
  `).get(formFieldId);
  return field ? isProtectedApplicationField(field) : true;
}

function readMaterial(db, materialId, applicationId = null) {
  const id = positiveId(materialId, 'material id');
  const material = db.prepare(`
    SELECT m.*,k.slug AS kind,k.label AS kind_label,h.revision_id AS head_revision_id,h.lock_version AS head_lock_version,
      s.revision_id AS selected_revision_id,s.lock_version AS selection_lock_version
    FROM application_materials m JOIN application_material_kinds k ON k.id=m.material_kind_id
    LEFT JOIN application_material_heads h ON h.material_id=m.id
    LEFT JOIN application_material_selections s ON s.material_id=m.id
    WHERE m.id=?
  `).get(id);
  if (!material || (applicationId && material.application_id !== Number(applicationId))) {
    throw new ApplicationMaterialsError('NOT_FOUND', `Application material ${id} not found`);
  }
  return {
    ...material,
    revisions: db.prepare('SELECT id FROM application_material_revision_current_state WHERE material_id=? ORDER BY revision_number DESC').all(id)
      .map((row) => getMaterialRevision(db, row.id, material.application_id)),
    reviews: db.prepare(`
      SELECT e.*,d.slug AS decision,d.label AS decision_label FROM application_material_review_events e
      JOIN application_material_review_decisions d ON d.id=e.decision_id
      JOIN application_material_revisions r ON r.id=e.revision_id WHERE r.material_id=? ORDER BY e.id DESC
    `).all(id),
    selectionEvents: db.prepare('SELECT * FROM application_material_selection_events WHERE material_id=? ORDER BY id DESC').all(id)
  };
}

function getMaterialRevision(db, revisionId, applicationId = null) {
  const id = positiveId(revisionId, 'revision id');
  const revision = db.prepare('SELECT * FROM application_material_revision_current_state WHERE id=?').get(id);
  if (!revision || (applicationId && revision.application_id !== Number(applicationId))) {
    throw new ApplicationMaterialsError('NOT_FOUND', `Application material revision ${id} not found`);
  }
  return {
    ...revision,
    sourceManifest: db.prepare('SELECT * FROM application_material_source_manifests WHERE id=?').get(revision.source_manifest_id),
    artifactSources: db.prepare('SELECT * FROM application_material_manifest_artifacts WHERE manifest_id=? ORDER BY artifact_id').all(revision.source_manifest_id),
    profileSources: db.prepare('SELECT * FROM application_material_manifest_profile_entries WHERE manifest_id=? ORDER BY profile_entry_id').all(revision.source_manifest_id),
    storyUses: db.prepare('SELECT * FROM application_material_manifest_story_uses WHERE manifest_id=? ORDER BY story_use_id').all(revision.source_manifest_id),
    formOptions: db.prepare(`
      SELECT ro.form_field_id,ro.option_id,ro.selection_position,o.provider_option_key,o.label
      FROM application_material_revision_form_options ro
      JOIN application_form_field_options o ON o.id=ro.option_id
      WHERE ro.revision_id=? ORDER BY ro.selection_position
    `).all(id),
    renders: db.prepare('SELECT id FROM application_material_renders WHERE revision_id=? ORDER BY id DESC')
      .all(id).map((row) => projectPublicMaterialRender(getMaterialRender(db, row.id, revision.application_id))),
    reviews: db.prepare(`
      SELECT e.*,d.slug AS decision,d.label AS decision_label FROM application_material_review_events e
      JOIN application_material_review_decisions d ON d.id=e.decision_id
      WHERE e.revision_id=? ORDER BY e.id DESC
    `).all(id)
  };
}

function selectManifestRows({ rows, ids, label }) {
  if (!ids.length) return [];
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const selected = ids.map((id) => byId.get(id));
  if (selected.some((row) => !row)) {
    const missing = ids.filter((id) => !byId.has(id));
    throw new ApplicationMaterialsError(
      'SOURCE_SCOPE_MISMATCH',
      `Every ${label} must exist and be eligible for this application; missing or ineligible ids: ${missing.join(', ')}`
    );
  }
  return selected;
}

function tableExists(db, name) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE name=? AND type IN ('table','view')
  `).get(name));
}

function requireApplication(db, applicationId) {
  const id = positiveId(applicationId, 'application id');
  const application = db.prepare('SELECT * FROM applications WHERE id=?').get(id);
  if (!application) throw new ApplicationMaterialsError('NOT_FOUND', `Application ${id} not found`);
  return application;
}

function positiveId(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', `${label} must be a positive integer`);
  }
  return number;
}

function nonnegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', `${label} must be a non-negative integer`);
  }
  return number;
}

function parseExpectedId(value, label) {
  if (value === undefined || value === null || value === '' || value === 'none') return null;
  return positiveId(value, label);
}

function parseIdList(value) {
  if (value === undefined || value === null || value === '') return [];
  const raw = Array.isArray(value)
    ? value
    : String(value).split(',').map((part) => part.trim()).filter(Boolean);
  const ids = raw.map((item) => positiveId(item, 'source id'));
  return [...new Set(ids)].sort((left, right) => left - right);
}

function requiredText(value, label, maxBytes) {
  if (value === undefined || value === null) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', `${label} is required`);
  }
  const text = String(value);
  if (!text.trim()) throw new ApplicationMaterialsError('INVALID_ARGUMENT', `${label} cannot be empty`);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', `${label} exceeds the ${maxBytes}-byte limit`);
  }
  return text;
}

function optionalText(value, label, maxBytes) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, label, maxBytes);
}

function enumText(value, allowed, label) {
  const text = requiredText(value, label, 200).trim();
  if (!allowed.has(text)) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', `${label} must be one of: ${[...allowed].join(', ')}`);
  }
  return text;
}

function vocabularyId(db, table, slug, label) {
  const row = db.prepare(`SELECT id FROM ${table} WHERE slug=?`).get(slug);
  if (!row) throw new ApplicationMaterialsError('INVALID_ARGUMENT', `Unknown ${label}: ${slug}`);
  return row.id;
}

function normalizedTimestamp(value, label) {
  const text = requiredText(value, label, 100).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(text);
  if (!match) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', `${label} must be an ISO-8601 timestamp with a timezone`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(fraction.slice(0, 3).padEnd(3, '0'));
  const offsetHour = zone === 'Z' ? 0 : Number(offsetHourText);
  const offsetMinute = zone === 'Z' ? 0 : Number(offsetMinuteText);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, millisecond);
  const validCalendar = year >= 1 && month >= 1 && month <= 12 && day >= 1
    && calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day
    && hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 14 && offsetMinute <= 59 && (offsetHour < 14 || offsetMinute === 0);
  const milliseconds = Date.parse(text);
  if (!validCalendar || !Number.isFinite(milliseconds)) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', `${label} is not a valid timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function sha256Text(value, label) {
  const text = requiredText(value, label, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', `${label} must be a 64-character hexadecimal digest`);
  }
  return text;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function expectedActiveContentScanSha256(outputSha256) {
  return sha256(`${PDF_ACTIVE_CONTENT_POLICY}\n${outputSha256}\nclean\n`);
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalSha256(value) {
  return sha256(stableJson(value));
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new ApplicationMaterialsError('INVALID_ARGUMENT', 'Non-finite numbers cannot be hashed');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : canonicalize(item));
  const result = {};
  for (const key of Object.keys(value).sort()) {
    // `uuid` columns are identity metadata maintained by the universal uuid
    // sweep, assigned after row insertion; content digests must exclude them
    // or the backfill would invalidate previously bound immutable manifests.
    if (key === 'uuid') continue;
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
  }
  return result;
}

function parseJson(value, fallback) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); }
  catch { return fallback; }
}

function pick(object, keys) {
  const result = {};
  for (const key of keys) {
    if (object && object[key] !== undefined) result[key] = object[key];
  }
  return result;
}

function managedAttachmentPath(attachmentPath, label) {
  if (attachmentPath === undefined || attachmentPath === null || String(attachmentPath).trim() === '') return null;
  const raw = String(attachmentPath);
  if (raw.includes('\0')) throw new ApplicationMaterialsError('ATTACHMENT_PATH_INVALID', `${label} contains a null byte`);
  const storeRoot = path.resolve(process.env.JOBTRACK_HOME || path.join(os.homedir(), '.jobtrack'));
  let realRoot;
  try { realRoot = fs.realpathSync(storeRoot); }
  catch { throw new ApplicationMaterialsError('ATTACHMENT_STORE_UNAVAILABLE', `Cannot resolve the JobTrack store for ${label}`); }
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(storeRoot, raw);
  const lexicalRelative = path.relative(storeRoot, candidate);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
    throw new ApplicationMaterialsError('ATTACHMENT_SCOPE_VIOLATION', `${label} must stay inside JOBTRACK_HOME`);
  }
  let linkStat;
  let realCandidate;
  try {
    linkStat = fs.lstatSync(candidate);
    realCandidate = fs.realpathSync(candidate);
  } catch {
    throw new ApplicationMaterialsError('ATTACHMENT_NOT_FOUND', `${label} is missing from the managed store`);
  }
  const realRelative = path.relative(realRoot, realCandidate);
  if (linkStat.isSymbolicLink() || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new ApplicationMaterialsError('ATTACHMENT_SCOPE_VIOLATION', `${label} cannot use a symlink or escape JOBTRACK_HOME`);
  }
  const stat = fs.statSync(realCandidate);
  if (!stat.isFile()) throw new ApplicationMaterialsError('ATTACHMENT_NOT_FILE', `${label} must be a regular file`);
  if (stat.size > MAX_PINNED_ATTACHMENT_BYTES) {
    throw new ApplicationMaterialsError('ATTACHMENT_TOO_LARGE', `${label} exceeds ${MAX_PINNED_ATTACHMENT_BYTES} bytes`);
  }
  return realCandidate;
}

function managedMaterialRenderPath(attachmentPath, db) {
  if (attachmentPath === undefined || attachmentPath === null || String(attachmentPath).trim() === '') {
    throw new ApplicationMaterialsError('ATTACHMENT_NOT_FOUND', 'Rendered application document path is required');
  }
  const raw = String(attachmentPath);
  if (raw.includes('\0')) throw new ApplicationMaterialsError('ATTACHMENT_PATH_INVALID', 'Rendered application document path contains a null byte');
  // Each containment test must compare like-normalized paths: the configured root against the
  // lexical candidate for the pre-check, then the realpath'd root against the realpath'd candidate.
  // Comparing a realpath'd root against a lexical candidate makes a symlinked JOBTRACK_HOME prefix
  // (e.g. macOS /var -> /private/var) read as a false escape. Mirrors managedAttachmentPath.
  const configuredRoot = materialStoreConfiguredRoot(db);
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(configuredRoot, raw);
  const lexicalRelative = path.relative(configuredRoot, candidate);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
    throw new ApplicationMaterialsError('ATTACHMENT_SCOPE_VIOLATION', 'Rendered application document must stay inside JOBTRACK_HOME');
  }
  let linkStat;
  let absolutePath;
  try {
    linkStat = fs.lstatSync(candidate);
    absolutePath = fs.realpathSync(candidate);
  } catch {
    throw new ApplicationMaterialsError('ATTACHMENT_NOT_FOUND', 'Rendered application document is missing from the managed store');
  }
  const storeRoot = fs.realpathSync(configuredRoot);
  const realRelative = path.relative(storeRoot, absolutePath);
  if (linkStat.isSymbolicLink() || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new ApplicationMaterialsError('ATTACHMENT_SCOPE_VIOLATION', 'Rendered application document cannot use a symlink or escape JOBTRACK_HOME');
  }
  const fileStat = fs.statSync(absolutePath);
  if (!fileStat.isFile()) throw new ApplicationMaterialsError('ATTACHMENT_NOT_FILE', 'Rendered application document must be a regular file');
  if (fileStat.size > MAX_RENDERED_DOCUMENT_BYTES) {
    throw new ApplicationMaterialsError('RENDER_OUTPUT_TOO_LARGE', `Rendered application document exceeds ${MAX_RENDERED_DOCUMENT_BYTES} bytes`);
  }
  const renderRoot = path.join(storeRoot, 'attachments', 'material-renders');
  const relative = path.relative(renderRoot, absolutePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ApplicationMaterialsError(
      'ATTACHMENT_SCOPE_VIOLATION',
      'Rendered application documents must stay inside JOBTRACK_HOME/attachments/material-renders'
    );
  }
  return absolutePath;
}

function relativeMaterialRenderPath(absolutePath, db) {
  const storeRoot = materialStoreRoot(db);
  const relative = path.relative(storeRoot, fs.realpathSync(absolutePath));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ApplicationMaterialsError('ATTACHMENT_SCOPE_VIOLATION', 'Rendered application document escaped JOBTRACK_HOME');
  }
  return relative.split(path.sep).join('/');
}

function materialStoreConfiguredRoot(db) {
  const databaseFilename = db && typeof db.name === 'string' && db.name !== ':memory:' ? db.name : null;
  return databaseFilename
    ? path.dirname(path.resolve(databaseFilename))
    : path.resolve(process.env.JOBTRACK_HOME || path.join(os.homedir(), '.jobtrack'));
}

function materialStoreRoot(db) {
  return fs.realpathSync(materialStoreConfiguredRoot(db));
}

function hashFileLimited(filename, maximumBytes, label) {
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(filename, 'r');
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (true) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, offset);
      if (!read) break;
      digest.update(chunk.subarray(0, read));
      offset += read;
      if (offset > maximumBytes) {
        throw new ApplicationMaterialsError('ATTACHMENT_TOO_LARGE', `${label} changed while hashing and exceeds ${maximumBytes} bytes`);
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest('hex');
}

function hashManagedAttachment(attachmentPath, label) {
  const absolutePath = managedAttachmentPath(attachmentPath, label);
  if (!absolutePath) return null;
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(absolutePath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (true) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, offset);
      if (!read) break;
      digest.update(chunk.subarray(0, read));
      offset += read;
      if (offset > MAX_PINNED_ATTACHMENT_BYTES) {
        throw new ApplicationMaterialsError('ATTACHMENT_TOO_LARGE', `${label} changed while hashing and exceeds ${MAX_PINNED_ATTACHMENT_BYTES} bytes`);
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest('hex');
}

function hashArtifact(artifact) {
  return sha256(stableJson({
    ...pick(artifact, [
    'id', 'application_id', 'kind', 'title', 'source_url', 'source_name', 'citation', 'notes',
    'content', 'attachment_path', 'opportunity_snapshot_id', 'captured_at', 'created_at'
    ]),
    attachment_content_sha256: hashManagedAttachment(artifact.attachment_path, 'artifact attachment')
  }));
}

function hashProfileEntry(entry) {
  return sha256(stableJson({
    ...pick(entry, [
    'id', 'category', 'title', 'content', 'source', 'source_url', 'evidence', 'attachment_path',
    'recency', 'confidence', 'tags', 'created_at', 'updated_at'
    ]),
    attachment_content_sha256: hashManagedAttachment(entry.attachment_path, 'profile attachment'),
    // Citable ledger nodes are part of the entry's evidence: their content is
    // pinned here so freshness checks and manifests cover them. Omitted when
    // absent, so entries without nodes keep their historical digest.
    ...(Array.isArray(entry.workDetails) && entry.workDetails.length
      ? { work_details: entry.workDetails.map((node) => pick(node, ['id', 'parentDetailId', 'kind', 'myRole', 'baseline', 'result', 'evidenceUrl', 'text', 'authoredBy', 'updatedAt'])) }
      : {})
  }));
}

function hashStoryUse(use) {
  return sha256(stableJson(pick(use, [
    'id', 'story_id', 'application_id', 'revision_id', 'variant_id', 'purpose', 'target_kind',
    'target_id', 'prompt_text', 'content_sha256', 'approved_by', 'used_at', 'created_at',
    'canonical_text', 'variant_content'
  ])));
}

function normalizeRequiredness(value) {
  const text = String(value || 'unknown').trim().toLowerCase().replace(/_/g, '-');
  return new Set(['unknown', 'required', 'preferred', 'optional', 'conditional']).has(text) ? text : 'unknown';
}

function blocker(code, message, details = undefined) {
  return details === undefined ? { code, message } : { code, message, ...details };
}

function idempotentOperation(db, command, idempotencyKey, intent, work) {
  const intentSha256 = sha256(stableJson(intent));
  const execute = () => {
    const existing = db.prepare('SELECT * FROM application_material_operations WHERE idempotency_key=?').get(idempotencyKey);
    if (existing) {
      if (existing.command !== command || existing.intent_sha256 !== intentSha256) {
        throw new ApplicationMaterialsError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for different material inputs');
      }
      return parseJson(existing.result_json, null);
    }
    const result = work();
    db.prepare(`
      INSERT INTO application_material_operations(idempotency_key,command,intent_sha256,result_json)
      VALUES (?,?,?,?)
    `).run(idempotencyKey, command, intentSha256, stableJson(result));
    return result;
  };
  return db.inTransaction ? execute() : db.transaction(execute).immediate();
}

module.exports = {
  APPLICATION_MATERIALS_SCHEMA_VERSION,
  APPLICATION_MATERIALS_MIGRATION_NAME,
  APPLICATION_FIELD_FULFILLMENT_SCHEMA_VERSION,
  APPLICATION_FIELD_FULFILLMENT_MIGRATION_NAME,
  LATEX_APPLICATION_MATERIALS_SCHEMA_VERSION,
  LATEX_APPLICATION_MATERIALS_MIGRATION_NAME,
  APPLICATION_MATERIALS_USER_VERSION,
  MAX_MATERIAL_CONTENT_BYTES,
  MAX_RENDERED_DOCUMENT_BYTES,
  LATEX_DOCUMENT_CONTRACT_VERSION,
  LATEX_RENDERER_PROFILE,
  ApplicationMaterialsError,
  migrateApplicationMaterials,
  ensureApplicationPreparationPlan,
  setApplicationPreparationMode,
  buildApplicationMaterialsContext,
  createMaterialDraft,
  createMaterialRender,
  getMaterialRender,
  listMaterialRenders,
  assertMaterialRenderIntegrity,
  projectPublicMaterialRender,
  reviewMaterialRevision,
  selectMaterialRevision,
  acceptApplicationFormUncertainty,
  resolveApplicationFormField,
  getApplicationReadiness,
  buildPackageSelectionSnapshot,
  bindPackagePreparationSnapshot,
  assertApplicationPackageIntegrity,
  canonicalSha256,
  readPackageSubmissionFacts,
  recordApplicationSubmission,
  getApplicationMaterialsReadModel,
  listApplicationMaterials,
  readMaterial,
  getMaterialRevision,
  materialRevisionIsFresh,
  managedMaterialRenderPath,
  projectPublicApplicationPackage,
  projectPublicPackagePreparationSnapshot,
  projectPublicPackageAnswerOptionBinding
};
