'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  digest,
  stableJson,
  validateApplicationStrategyPlan,
  validateApplicationStrategyWorkResult,
  validateRoutingPolicy
} = require('./application-strategy-contracts');

const APPLICATION_STRATEGY_SCHEMA_VERSION = 2026071801;
const APPLICATION_STRATEGY_MIGRATION_NAME = 'application_strategy_control_plane';
const APPLICATION_STRATEGY_USER_VERSION = 11;
const MAX_CONTEXT_SOURCES = 200;
const MAX_CONTEXT_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENT_HASH_BYTES = 25 * 1024 * 1024;
const MAX_CONTEXT_ATTACHMENT_HASH_BYTES = 100 * 1024 * 1024;
const MAX_WORK_REQUEST_BYTES = 6 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const REVIEW_DECISIONS = new Set(['approved', 'revision-requested', 'rejected']);
const WORK_REVIEW_DECISIONS = new Set(['accepted', 'rejected', 'escalated']);
const SELECTOR_KEYS = Object.freeze([
  'artifactIds', 'snapshotIds', 'materialRevisionIds', 'emailMessageRefIds', 'interviewIds',
  'profileEntryIds', 'storyUseIds'
]);
const CAPABILITIES = Object.freeze([
  ['application-strategy', 'Application strategy', 'analysis'],
  ['application-reconcile', 'Application strategy reconciliation', 'analysis'],
  ['company-research', 'Company research', 'draft-proposal'],
  ['job-posting-analysis', 'Job-posting analysis', 'draft-proposal'],
  ['email-signal-analysis', 'Email signal analysis', 'analysis'],
  ['email-tone-analysis', 'Email tone analysis', 'analysis'],
  ['email-draft', 'Email draft', 'draft-proposal'],
  ['application-material-draft', 'Application material draft', 'draft-proposal'],
  ['interview-prep', 'Interview preparation', 'draft-proposal'],
  ['latex-render', 'LaTeX rendering', 'deterministic']
]);
const MODEL_CLASS_ROWS = Object.freeze([
  ['deterministic', 'Deterministic runtime', 0],
  ['economy', 'Economy model', 10],
  ['strong', 'Strong model', 20],
  ['frontier', 'Frontier coordinator', 30]
]);
const CAPABILITY_OUTPUT_KINDS = Object.freeze({
  'application-strategy': 'analysis',
  'application-reconcile': 'analysis',
  'company-research': 'research-proposal',
  'job-posting-analysis': 'assessment-proposal',
  'email-signal-analysis': 'analysis',
  'email-tone-analysis': 'analysis',
  'email-draft': 'email-reply-draft-proposal',
  'application-material-draft': 'application-material-draft-proposal',
  'interview-prep': 'interview-prep-proposal',
  'latex-render': 'render-result'
});
const OUTPUT_BINDING_TARGETS = Object.freeze({
  'research-proposal': { kind: 'artifact', inputKey: 'artifactId', column: 'artifact_id' },
  'assessment-proposal': { kind: 'assessment', inputKey: 'assessmentId', column: 'assessment_id' },
  'application-material-draft-proposal': {
    kind: 'material-revision', inputKey: 'materialRevisionId', column: 'material_revision_id'
  },
  'email-reply-draft-proposal': {
    kind: 'email-reply-proposal', inputKey: 'emailReplyProposalId', column: 'email_reply_proposal_id'
  },
  'interview-prep-proposal': {
    kind: 'interview-prep-analysis', inputKey: 'interviewPrepAnalysisId', column: 'interview_prep_analysis_id'
  },
  'render-result': { kind: 'material-render', inputKey: 'materialRenderId', column: 'material_render_id' }
});

class ApplicationStrategyError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ApplicationStrategyError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function migrateApplicationStrategy(db) {
  const apply = () => {
    if (!tableExists(db, 'applications')) {
      throw new ApplicationStrategyError('SCHEMA_DEPENDENCY_MISSING', 'Run the base JobTrack migration before application strategy');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobtrack_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const versionRow = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
      .get(APPLICATION_STRATEGY_SCHEMA_VERSION);
    if (versionRow && versionRow.name !== APPLICATION_STRATEGY_MIGRATION_NAME) {
      throw new ApplicationStrategyError(
        'MIGRATION_CONFLICT',
        `Schema version ${APPLICATION_STRATEGY_SCHEMA_VERSION} is already named ${versionRow.name}`
      );
    }
    const nameRow = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?')
      .get(APPLICATION_STRATEGY_MIGRATION_NAME);
    if (nameRow && nameRow.version !== APPLICATION_STRATEGY_SCHEMA_VERSION) {
      throw new ApplicationStrategyError(
        'MIGRATION_CONFLICT',
        `Migration ${APPLICATION_STRATEGY_MIGRATION_NAME} is already registered as ${nameRow.version}`
      );
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS strategy_model_classes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        rank INTEGER NOT NULL UNIQUE,
        CHECK (trim(slug)<>''), CHECK (trim(label)<>'')
      );
      CREATE TABLE IF NOT EXISTS strategy_capabilities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        effect_kind TEXT NOT NULL CHECK (effect_kind IN ('analysis','draft-proposal','deterministic')),
        CHECK (trim(slug)<>''), CHECK (trim(label)<>'')
      );

      CREATE TABLE IF NOT EXISTS strategy_routing_policy_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        policy_key TEXT NOT NULL,
        version TEXT NOT NULL,
        policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
        policy_sha256 TEXT NOT NULL UNIQUE CHECK (length(policy_sha256)=64),
        imported_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(policy_key,version),
        CHECK (trim(policy_key)<>''), CHECK (trim(version)<>''), CHECK (trim(imported_by)<>'')
      );
      CREATE TABLE IF NOT EXISTS strategy_routing_policy_review_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        policy_revision_id INTEGER NOT NULL REFERENCES strategy_routing_policy_revisions(id) ON DELETE RESTRICT,
        decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
        expected_prior_review_id INTEGER REFERENCES strategy_routing_policy_review_events(id) ON DELETE RESTRICT,
        reviewed_by TEXT NOT NULL,
        notes TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        reviewed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(reviewed_by)<>'')
      );
      CREATE TABLE IF NOT EXISTS strategy_routing_policy_current (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id=1),
        policy_revision_id INTEGER NOT NULL UNIQUE REFERENCES strategy_routing_policy_revisions(id) ON DELETE RESTRICT,
        lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version>=0),
        selected_by TEXT NOT NULL,
        selected_at TEXT NOT NULL,
        CHECK (trim(selected_by)<>'')
      );
      CREATE TABLE IF NOT EXISTS strategy_routing_policy_selection_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        previous_policy_revision_id INTEGER REFERENCES strategy_routing_policy_revisions(id) ON DELETE RESTRICT,
        policy_revision_id INTEGER NOT NULL REFERENCES strategy_routing_policy_revisions(id) ON DELETE RESTRICT,
        expected_current_policy_revision_id INTEGER REFERENCES strategy_routing_policy_revisions(id) ON DELETE RESTRICT,
        selected_by TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        selected_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(selected_by)<>'')
      );

      CREATE TABLE IF NOT EXISTS application_strategy_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
        revision_number INTEGER NOT NULL CHECK (revision_number>0),
        parent_revision_id INTEGER REFERENCES application_strategy_revisions(id) ON DELETE RESTRICT,
        routing_policy_revision_id INTEGER NOT NULL REFERENCES strategy_routing_policy_revisions(id) ON DELETE RESTRICT,
        source_manifest_json TEXT NOT NULL CHECK (json_valid(source_manifest_json)),
        source_state_sha256 TEXT NOT NULL CHECK (length(source_state_sha256)=64),
        plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
        plan_sha256 TEXT NOT NULL UNIQUE CHECK (length(plan_sha256)=64),
        coordinator_run_id TEXT NOT NULL,
        coordinator_route_alias TEXT NOT NULL,
        coordinator_provider TEXT NOT NULL,
        coordinator_model TEXT NOT NULL,
        coordinator_model_version TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(application_id,revision_number),
        CHECK (trim(coordinator_run_id)<>''), CHECK (trim(coordinator_route_alias)<>''),
        CHECK (trim(coordinator_provider)<>''), CHECK (trim(coordinator_model)<>'')
      );
      CREATE TABLE IF NOT EXISTS application_strategy_work_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_revision_id INTEGER NOT NULL REFERENCES application_strategy_revisions(id) ON DELETE RESTRICT,
        item_key TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position>0),
        capability_id INTEGER NOT NULL REFERENCES strategy_capabilities(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
        acceptance_criteria_json TEXT NOT NULL CHECK (json_valid(acceptance_criteria_json)),
        source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
        output_kind TEXT NOT NULL CHECK (output_kind IN (
          'analysis','research-proposal','assessment-proposal','email-reply-draft-proposal',
          'application-material-draft-proposal','interview-prep-proposal','render-result'
        )),
        review_gate TEXT NOT NULL CHECK (review_gate IN ('frontier','human','domain')),
        created_at TEXT NOT NULL,
        UNIQUE(strategy_revision_id,item_key),
        UNIQUE(strategy_revision_id,position),
        CHECK (trim(item_key)<>''), CHECK (trim(title)<>''), CHECK (trim(goal)<>'')
      );
      CREATE TABLE IF NOT EXISTS application_strategy_work_dependencies (
        work_item_id INTEGER NOT NULL REFERENCES application_strategy_work_items(id) ON DELETE RESTRICT,
        depends_on_work_item_id INTEGER NOT NULL REFERENCES application_strategy_work_items(id) ON DELETE RESTRICT,
        PRIMARY KEY(work_item_id,depends_on_work_item_id),
        CHECK (work_item_id<>depends_on_work_item_id)
      );
      CREATE TABLE IF NOT EXISTS application_strategy_review_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_revision_id INTEGER NOT NULL REFERENCES application_strategy_revisions(id) ON DELETE RESTRICT,
        decision TEXT NOT NULL CHECK (decision IN ('approved','revision-requested','rejected')),
        expected_prior_review_id INTEGER REFERENCES application_strategy_review_events(id) ON DELETE RESTRICT,
        reviewed_by TEXT NOT NULL,
        notes TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        reviewed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(reviewed_by)<>'')
      );
      CREATE TABLE IF NOT EXISTS application_strategy_current (
        application_id INTEGER PRIMARY KEY REFERENCES applications(id) ON DELETE RESTRICT,
        strategy_revision_id INTEGER NOT NULL UNIQUE REFERENCES application_strategy_revisions(id) ON DELETE RESTRICT,
        lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version>=0),
        selected_by TEXT NOT NULL,
        selected_at TEXT NOT NULL,
        CHECK (trim(selected_by)<>'')
      );
      CREATE TABLE IF NOT EXISTS application_strategy_selection_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
        previous_strategy_revision_id INTEGER REFERENCES application_strategy_revisions(id) ON DELETE RESTRICT,
        strategy_revision_id INTEGER NOT NULL REFERENCES application_strategy_revisions(id) ON DELETE RESTRICT,
        expected_current_strategy_revision_id INTEGER REFERENCES application_strategy_revisions(id) ON DELETE RESTRICT,
        selected_by TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        selected_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(selected_by)<>'')
      );

      CREATE TABLE IF NOT EXISTS application_strategy_work_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id INTEGER NOT NULL REFERENCES application_strategy_work_items(id) ON DELETE RESTRICT,
        strategy_revision_id INTEGER NOT NULL REFERENCES application_strategy_revisions(id) ON DELETE RESTRICT,
        routing_policy_revision_id INTEGER NOT NULL REFERENCES strategy_routing_policy_revisions(id) ON DELETE RESTRICT,
        attempt_number INTEGER NOT NULL CHECK (attempt_number>0),
        route_alias TEXT NOT NULL,
        required_model_class_id INTEGER NOT NULL REFERENCES strategy_model_classes(id) ON DELETE RESTRICT,
        source_state_sha256 TEXT NOT NULL CHECK (length(source_state_sha256)=64),
        max_input_tokens INTEGER NOT NULL CHECK (max_input_tokens>=0),
        max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens>=0),
        max_cost_micros INTEGER NOT NULL CHECK (max_cost_micros>=0),
        max_duration_ms INTEGER NOT NULL CHECK (max_duration_ms>0),
        request_json TEXT NOT NULL CHECK (json_valid(request_json)),
        request_sha256 TEXT NOT NULL UNIQUE CHECK (length(request_sha256)=64),
        issued_by TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        created_at TEXT NOT NULL,
        UNIQUE(work_item_id,attempt_number),
        CHECK (trim(route_alias)<>''), CHECK (trim(issued_by)<>'')
      );
      CREATE TABLE IF NOT EXISTS application_strategy_work_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_request_id INTEGER NOT NULL UNIQUE REFERENCES application_strategy_work_requests(id) ON DELETE RESTRICT,
        result_status TEXT NOT NULL CHECK (result_status IN ('succeeded','failed','blocked')),
        worker_run_id TEXT NOT NULL,
        worker_route_alias TEXT NOT NULL,
        worker_model_class_id INTEGER NOT NULL REFERENCES strategy_model_classes(id) ON DELETE RESTRICT,
        worker_provider TEXT NOT NULL,
        worker_model TEXT NOT NULL,
        worker_model_version TEXT,
        input_tokens INTEGER NOT NULL CHECK (input_tokens>=0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens>=0),
        cost_micros INTEGER NOT NULL CHECK (cost_micros>=0),
        duration_ms INTEGER NOT NULL CHECK (duration_ms>=0),
        over_budget INTEGER NOT NULL CHECK (over_budget IN (0,1)),
        confidence REAL NOT NULL CHECK (confidence>=0 AND confidence<=1),
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        result_sha256 TEXT NOT NULL UNIQUE CHECK (length(result_sha256)=64),
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        created_at TEXT NOT NULL,
        CHECK (trim(worker_run_id)<>''), CHECK (trim(worker_route_alias)<>''),
        CHECK (trim(worker_provider)<>''), CHECK (trim(worker_model)<>'')
      );
      CREATE TABLE IF NOT EXISTS application_strategy_work_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id INTEGER NOT NULL REFERENCES application_strategy_work_items(id) ON DELETE RESTRICT,
        work_request_id INTEGER REFERENCES application_strategy_work_requests(id) ON DELETE RESTRICT,
        work_result_id INTEGER REFERENCES application_strategy_work_results(id) ON DELETE RESTRICT,
        event_kind TEXT NOT NULL CHECK (event_kind IN (
          'issued','result-recorded','accepted','rejected','escalated','blocked','superseded'
        )),
        actor TEXT NOT NULL,
        review_authority TEXT CHECK (
          review_authority IS NULL OR review_authority IN ('frontier','human','domain')
        ),
        notes TEXT,
        idempotency_key TEXT UNIQUE,
        intent_sha256 TEXT CHECK (intent_sha256 IS NULL OR length(intent_sha256)=64),
        created_at TEXT NOT NULL,
        CHECK (trim(actor)<>'')
      );
      CREATE TABLE IF NOT EXISTS application_strategy_work_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_result_id INTEGER NOT NULL UNIQUE
          REFERENCES application_strategy_work_results(id) ON DELETE RESTRICT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
        target_kind TEXT NOT NULL CHECK (target_kind IN (
          'artifact','assessment','material-revision','email-reply-proposal',
          'interview-prep-analysis','material-render'
        )),
        -- Target domains are optional/additive migrations. The CLI binder resolves
        -- and scope-checks the one non-null typed target before this audit row.
        artifact_id INTEGER,
        assessment_id INTEGER,
        material_revision_id INTEGER,
        email_reply_proposal_id TEXT,
        interview_prep_analysis_id INTEGER,
        material_render_id INTEGER,
        target_digest TEXT NOT NULL CHECK (length(target_digest)=64),
        bound_by TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        bound_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(bound_by)<>''),
        CHECK (
          (artifact_id IS NOT NULL)+(assessment_id IS NOT NULL)+
          (material_revision_id IS NOT NULL)+(email_reply_proposal_id IS NOT NULL)+
          (interview_prep_analysis_id IS NOT NULL)+(material_render_id IS NOT NULL)=1
        ),
        CHECK (
          (target_kind='artifact' AND artifact_id IS NOT NULL) OR
          (target_kind='assessment' AND assessment_id IS NOT NULL) OR
          (target_kind='material-revision' AND material_revision_id IS NOT NULL) OR
          (target_kind='email-reply-proposal' AND email_reply_proposal_id IS NOT NULL
            AND trim(email_reply_proposal_id)<>'') OR
          (target_kind='interview-prep-analysis' AND interview_prep_analysis_id IS NOT NULL) OR
          (target_kind='material-render' AND material_render_id IS NOT NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS application_strategy_source_checkpoint_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
        strategy_revision_id INTEGER NOT NULL
          REFERENCES application_strategy_revisions(id) ON DELETE RESTRICT,
        work_request_id INTEGER NOT NULL
          REFERENCES application_strategy_work_requests(id) ON DELETE RESTRICT,
        work_result_id INTEGER NOT NULL
          REFERENCES application_strategy_work_results(id) ON DELETE RESTRICT,
        binding_id INTEGER NOT NULL UNIQUE
          REFERENCES application_strategy_work_bindings(id) ON DELETE RESTRICT,
        plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256)=64),
        work_request_sha256 TEXT NOT NULL CHECK (length(work_request_sha256)=64),
        prior_source_state_sha256 TEXT NOT NULL CHECK (length(prior_source_state_sha256)=64),
        current_source_state_sha256 TEXT NOT NULL CHECK (length(current_source_state_sha256)=64),
        target_kind TEXT NOT NULL,
        target_digest TEXT NOT NULL CHECK (length(target_digest)=64),
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        checkpointed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(actor)<>''), CHECK (trim(reason)<>'')
      );
      CREATE TABLE IF NOT EXISTS application_strategy_operations (
        idempotency_key TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(command)<>'')
      );

      CREATE INDEX IF NOT EXISTS idx_strategy_revisions_application
        ON application_strategy_revisions(application_id,revision_number DESC);
      CREATE INDEX IF NOT EXISTS idx_strategy_work_items_revision
        ON application_strategy_work_items(strategy_revision_id,position);
      CREATE INDEX IF NOT EXISTS idx_strategy_work_requests_item
        ON application_strategy_work_requests(work_item_id,attempt_number DESC);
      CREATE INDEX IF NOT EXISTS idx_strategy_work_events_item
        ON application_strategy_work_events(work_item_id,id DESC);
      CREATE INDEX IF NOT EXISTS idx_strategy_work_bindings_application
        ON application_strategy_work_bindings(application_id,id DESC);
      CREATE INDEX IF NOT EXISTS idx_strategy_source_checkpoints_revision
        ON application_strategy_source_checkpoint_events(strategy_revision_id,id DESC);
    `);

    seedRows(db, 'strategy_model_classes', ['slug', 'label', 'rank'], MODEL_CLASS_ROWS);
    seedRows(db, 'strategy_capabilities', ['slug', 'label', 'effect_kind'], CAPABILITIES);
    assertSeedCatalog(db);
    createStrategyGuards(db);
    for (const table of [
      'strategy_routing_policy_revisions', 'strategy_routing_policy_review_events',
      'strategy_routing_policy_selection_events', 'application_strategy_revisions',
      'application_strategy_work_items', 'application_strategy_work_dependencies',
      'application_strategy_review_events', 'application_strategy_selection_events',
      'application_strategy_work_requests', 'application_strategy_work_results',
      'application_strategy_work_events', 'application_strategy_work_bindings',
      'application_strategy_source_checkpoint_events',
      'application_strategy_operations'
    ]) createAppendOnlyTriggers(db, table);

    if (!versionRow) {
      db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)')
        .run(APPLICATION_STRATEGY_SCHEMA_VERSION, APPLICATION_STRATEGY_MIGRATION_NAME);
    }
    if (db.pragma('user_version', { simple: true }) < APPLICATION_STRATEGY_USER_VERSION) {
      db.pragma(`user_version = ${APPLICATION_STRATEGY_USER_VERSION}`);
    }
  };
  if (db.inTransaction) apply();
  else db.transaction(apply).immediate();
}

function createStrategyGuards(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_strategy_policy_review_expected
    BEFORE INSERT ON strategy_routing_policy_review_events
    WHEN COALESCE(NEW.expected_prior_review_id,0)<>COALESCE((
      SELECT id FROM strategy_routing_policy_review_events
      WHERE policy_revision_id=NEW.policy_revision_id ORDER BY id DESC LIMIT 1
    ),0)
    BEGIN SELECT RAISE(ABORT,'stale strategy policy review expectation'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_policy_selection_expected
    BEFORE INSERT ON strategy_routing_policy_selection_events
    WHEN COALESCE(NEW.expected_current_policy_revision_id,0)<>COALESCE((
      SELECT policy_revision_id FROM strategy_routing_policy_current WHERE singleton_id=1
    ),0)
    BEGIN SELECT RAISE(ABORT,'stale strategy policy selection expectation'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_policy_selection_previous
    BEFORE INSERT ON strategy_routing_policy_selection_events
    WHEN COALESCE(NEW.previous_policy_revision_id,0)<>COALESCE((
      SELECT policy_revision_id FROM strategy_routing_policy_current WHERE singleton_id=1
    ),0)
    BEGIN SELECT RAISE(ABORT,'strategy policy previous selection mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_policy_selection_approved
    BEFORE INSERT ON strategy_routing_policy_selection_events
    WHEN COALESCE((
      SELECT decision FROM strategy_routing_policy_review_events
      WHERE policy_revision_id=NEW.policy_revision_id ORDER BY id DESC LIMIT 1
    ),'')<>'approved'
    BEGIN SELECT RAISE(ABORT,'strategy routing policy selection requires approval'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_policy_current_approved_insert
    BEFORE INSERT ON strategy_routing_policy_current
    WHEN COALESCE((
      SELECT decision FROM strategy_routing_policy_review_events
      WHERE policy_revision_id=NEW.policy_revision_id ORDER BY id DESC LIMIT 1
    ),'')<>'approved'
    BEGIN SELECT RAISE(ABORT,'current strategy policy requires approval'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_policy_current_approved_update
    BEFORE UPDATE OF policy_revision_id ON strategy_routing_policy_current
    WHEN COALESCE((
      SELECT decision FROM strategy_routing_policy_review_events
      WHERE policy_revision_id=NEW.policy_revision_id ORDER BY id DESC LIMIT 1
    ),'')<>'approved'
    BEGIN SELECT RAISE(ABORT,'current strategy policy requires approval'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_parent_scope
    BEFORE INSERT ON application_strategy_revisions
    WHEN NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM application_strategy_revisions parent
      WHERE parent.id=NEW.parent_revision_id AND parent.application_id=NEW.application_id
    )
    BEGIN SELECT RAISE(ABORT,'strategy parent belongs to another application'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_dependency_scope
    BEFORE INSERT ON application_strategy_work_dependencies
    WHEN NOT EXISTS (
      SELECT 1 FROM application_strategy_work_items item
      JOIN application_strategy_work_items dependency
        ON dependency.id=NEW.depends_on_work_item_id
       AND dependency.strategy_revision_id=item.strategy_revision_id
      WHERE item.id=NEW.work_item_id
    )
    BEGIN SELECT RAISE(ABORT,'strategy dependency belongs to another plan'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_review_expected
    BEFORE INSERT ON application_strategy_review_events
    WHEN COALESCE(NEW.expected_prior_review_id,0)<>COALESCE((
      SELECT id FROM application_strategy_review_events
      WHERE strategy_revision_id=NEW.strategy_revision_id ORDER BY id DESC LIMIT 1
    ),0)
    BEGIN SELECT RAISE(ABORT,'stale application strategy review expectation'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_selection_expected
    BEFORE INSERT ON application_strategy_selection_events
    WHEN COALESCE(NEW.expected_current_strategy_revision_id,0)<>COALESCE((
      SELECT strategy_revision_id FROM application_strategy_current
      WHERE application_id=NEW.application_id
    ),0)
    BEGIN SELECT RAISE(ABORT,'stale application strategy selection expectation'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_selection_previous
    BEFORE INSERT ON application_strategy_selection_events
    WHEN COALESCE(NEW.previous_strategy_revision_id,0)<>COALESCE((
      SELECT strategy_revision_id FROM application_strategy_current
      WHERE application_id=NEW.application_id
    ),0)
    BEGIN SELECT RAISE(ABORT,'application strategy previous selection mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_selection_scope
    BEFORE INSERT ON application_strategy_selection_events
    WHEN NOT EXISTS (
      SELECT 1 FROM application_strategy_revisions revision
      WHERE revision.id=NEW.strategy_revision_id AND revision.application_id=NEW.application_id
    )
    BEGIN SELECT RAISE(ABORT,'selected strategy belongs to another application'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_selection_approved
    BEFORE INSERT ON application_strategy_selection_events
    WHEN COALESCE((
      SELECT decision FROM application_strategy_review_events
      WHERE strategy_revision_id=NEW.strategy_revision_id ORDER BY id DESC LIMIT 1
    ),'')<>'approved'
    BEGIN SELECT RAISE(ABORT,'application strategy selection requires approval'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_current_scope_insert
    BEFORE INSERT ON application_strategy_current
    WHEN NOT EXISTS (
      SELECT 1 FROM application_strategy_revisions revision
      WHERE revision.id=NEW.strategy_revision_id AND revision.application_id=NEW.application_id
    )
    BEGIN SELECT RAISE(ABORT,'current strategy belongs to another application'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_current_approved_insert
    BEFORE INSERT ON application_strategy_current
    WHEN COALESCE((
      SELECT decision FROM application_strategy_review_events
      WHERE strategy_revision_id=NEW.strategy_revision_id ORDER BY id DESC LIMIT 1
    ),'')<>'approved'
    BEGIN SELECT RAISE(ABORT,'current strategy requires approval'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_current_scope_update
    BEFORE UPDATE ON application_strategy_current
    WHEN NOT EXISTS (
      SELECT 1 FROM application_strategy_revisions revision
      WHERE revision.id=NEW.strategy_revision_id AND revision.application_id=NEW.application_id
    )
    BEGIN SELECT RAISE(ABORT,'current strategy belongs to another application'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_current_approved_update
    BEFORE UPDATE OF strategy_revision_id ON application_strategy_current
    WHEN COALESCE((
      SELECT decision FROM application_strategy_review_events
      WHERE strategy_revision_id=NEW.strategy_revision_id ORDER BY id DESC LIMIT 1
    ),'')<>'approved'
    BEGIN SELECT RAISE(ABORT,'current strategy requires approval'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_request_scope
    BEFORE INSERT ON application_strategy_work_requests
    WHEN NOT EXISTS (
      SELECT 1 FROM application_strategy_work_items item
      WHERE item.id=NEW.work_item_id AND item.strategy_revision_id=NEW.strategy_revision_id
    )
    BEGIN SELECT RAISE(ABORT,'strategy work request plan mismatch'); END;

    DROP TRIGGER IF EXISTS trg_strategy_request_revision_guard;
    CREATE TRIGGER trg_strategy_request_revision_guard
    BEFORE INSERT ON application_strategy_work_requests
    WHEN NOT EXISTS (
      SELECT 1 FROM application_strategy_revisions revision
      JOIN application_strategy_current current
        ON current.application_id=revision.application_id
       AND current.strategy_revision_id=revision.id
      WHERE revision.id=NEW.strategy_revision_id
        AND revision.routing_policy_revision_id=NEW.routing_policy_revision_id
        AND NEW.source_state_sha256=COALESCE((
          SELECT checkpoint.current_source_state_sha256
          FROM application_strategy_source_checkpoint_events checkpoint
          WHERE checkpoint.strategy_revision_id=revision.id
          ORDER BY checkpoint.id DESC LIMIT 1
        ),revision.source_state_sha256)
        AND COALESCE((
          SELECT decision FROM application_strategy_review_events review
          WHERE review.strategy_revision_id=revision.id ORDER BY review.id DESC LIMIT 1
        ),'')='approved'
        AND COALESCE((
          SELECT decision FROM strategy_routing_policy_review_events policy_review
          WHERE policy_review.policy_revision_id=revision.routing_policy_revision_id
          ORDER BY policy_review.id DESC LIMIT 1
        ),'')='approved'
    )
    BEGIN SELECT RAISE(ABORT,'strategy work request revision is not issuable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_request_attempt_sequence
    BEFORE INSERT ON application_strategy_work_requests
    WHEN NEW.attempt_number<>COALESCE((
      SELECT MAX(attempt_number) FROM application_strategy_work_requests
      WHERE work_item_id=NEW.work_item_id
    ),0)+1
    BEGIN SELECT RAISE(ABORT,'strategy work request attempt is out of sequence'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_result_route_and_budget_guard
    BEFORE INSERT ON application_strategy_work_results
    WHEN NOT EXISTS (
      SELECT 1 FROM application_strategy_work_requests request
      JOIN strategy_model_classes required_class ON required_class.id=request.required_model_class_id
      JOIN strategy_model_classes worker_class ON worker_class.id=NEW.worker_model_class_id
      WHERE request.id=NEW.work_request_id
        AND request.route_alias=NEW.worker_route_alias
        AND (
          (required_class.slug='deterministic' AND worker_class.slug='deterministic')
          OR (required_class.slug<>'deterministic' AND worker_class.rank>=required_class.rank)
        )
        AND NEW.over_budget=(
          NEW.input_tokens>request.max_input_tokens
          OR NEW.output_tokens>request.max_output_tokens
          OR NEW.cost_micros>request.max_cost_micros
          OR NEW.duration_ms>request.max_duration_ms
        )
    )
    BEGIN SELECT RAISE(ABORT,'strategy work result violates route or budget binding'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_event_scope
    BEFORE INSERT ON application_strategy_work_events
    WHEN (NEW.work_request_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM application_strategy_work_requests request
      WHERE request.id=NEW.work_request_id AND request.work_item_id=NEW.work_item_id
    )) OR (NEW.work_result_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM application_strategy_work_results result
      JOIN application_strategy_work_requests request ON request.id=result.work_request_id
      WHERE result.id=NEW.work_result_id AND request.work_item_id=NEW.work_item_id
    ))
    BEGIN SELECT RAISE(ABORT,'strategy work event scope mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_event_shape
    BEFORE INSERT ON application_strategy_work_events
    WHEN (NEW.event_kind='issued' AND (NEW.work_request_id IS NULL OR NEW.work_result_id IS NOT NULL))
      OR (NEW.event_kind IN ('result-recorded','blocked','accepted','rejected','escalated')
        AND (NEW.work_request_id IS NULL OR NEW.work_result_id IS NULL))
    BEGIN SELECT RAISE(ABORT,'strategy work event has an invalid shape'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_event_acceptance_guard
    BEFORE INSERT ON application_strategy_work_events
    WHEN NEW.event_kind='accepted' AND NOT EXISTS (
      SELECT 1 FROM application_strategy_work_results result
      JOIN application_strategy_work_requests request ON request.id=result.work_request_id
      WHERE result.id=NEW.work_result_id AND request.id=NEW.work_request_id
        AND request.work_item_id=NEW.work_item_id
        AND result.result_status='succeeded' AND result.over_budget=0
    )
    BEGIN SELECT RAISE(ABORT,'strategy acceptance requires a successful in-budget result'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_event_review_authority
    BEFORE INSERT ON application_strategy_work_events
    WHEN NEW.event_kind IN ('accepted','rejected','escalated') AND NOT EXISTS (
      SELECT 1 FROM application_strategy_work_items item
      WHERE item.id=NEW.work_item_id AND item.review_gate=NEW.review_authority
    )
    BEGIN SELECT RAISE(ABORT,'strategy work review authority mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_binding_scope
    BEFORE INSERT ON application_strategy_work_bindings
    WHEN NOT EXISTS (
      SELECT 1 FROM application_strategy_work_results result
      JOIN application_strategy_work_requests request ON request.id=result.work_request_id
      JOIN application_strategy_work_items item ON item.id=request.work_item_id
      JOIN application_strategy_revisions revision ON revision.id=item.strategy_revision_id
      WHERE result.id=NEW.work_result_id AND revision.application_id=NEW.application_id
        AND EXISTS (
          SELECT 1 FROM application_strategy_work_events event
          WHERE event.work_result_id=result.id AND event.event_kind='accepted'
        )
        AND item.output_kind<>'analysis'
        AND NEW.target_kind=CASE item.output_kind
          WHEN 'research-proposal' THEN 'artifact'
          WHEN 'assessment-proposal' THEN 'assessment'
          WHEN 'application-material-draft-proposal' THEN 'material-revision'
          WHEN 'email-reply-draft-proposal' THEN 'email-reply-proposal'
          WHEN 'interview-prep-proposal' THEN 'interview-prep-analysis'
          WHEN 'render-result' THEN 'material-render'
        END
    )
    BEGIN SELECT RAISE(ABORT,'strategy domain binding scope mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_checkpoint_scope
    BEFORE INSERT ON application_strategy_source_checkpoint_events
    WHEN NOT EXISTS (
      SELECT 1 FROM application_strategy_work_bindings binding
      JOIN application_strategy_work_results result ON result.id=binding.work_result_id
      JOIN application_strategy_work_requests request ON request.id=result.work_request_id
      JOIN application_strategy_revisions revision ON revision.id=request.strategy_revision_id
      WHERE binding.id=NEW.binding_id
        AND binding.application_id=NEW.application_id
        AND binding.target_kind=NEW.target_kind
        AND binding.target_digest=NEW.target_digest
        AND result.id=NEW.work_result_id
        AND request.id=NEW.work_request_id
        AND request.request_sha256=NEW.work_request_sha256
        AND revision.id=NEW.strategy_revision_id
        AND revision.plan_sha256=NEW.plan_sha256
    )
    BEGIN SELECT RAISE(ABORT,'strategy source checkpoint scope mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_checkpoint_previous
    BEFORE INSERT ON application_strategy_source_checkpoint_events
    WHEN NEW.prior_source_state_sha256<>COALESCE((
      SELECT current_source_state_sha256
      FROM application_strategy_source_checkpoint_events checkpoint
      WHERE checkpoint.strategy_revision_id=NEW.strategy_revision_id
      ORDER BY checkpoint.id DESC LIMIT 1
    ),(
      SELECT source_state_sha256 FROM application_strategy_revisions
      WHERE id=NEW.strategy_revision_id
    ))
    BEGIN SELECT RAISE(ABORT,'stale strategy source checkpoint expectation'); END;
  `);
}

function buildApplicationStrategyContext(db, applicationId, selectors = {}, contextOptions = {}) {
  requireSchema(db);
  applicationId = positiveId(applicationId, 'application id');
  const application = db.prepare('SELECT * FROM applications WHERE id=?').get(applicationId);
  if (!application) throw new ApplicationStrategyError('NOT_FOUND', `Application not found: ${applicationId}`);
  rejectUnknownKeys(selectors, [...SELECTOR_KEYS], 'strategy context selectors');
  rejectUnknownKeys(contextOptions, ['priorStrategyRevisionId'], 'strategy context options');
  const selected = SELECTOR_KEYS.some((key) => Object.prototype.hasOwnProperty.call(selectors, key));
  const normalizedSelectors = Object.fromEntries(SELECTOR_KEYS.map((key) => [key, normalizeIdList(selectors[key], key)]));
  const core = buildStrategyCoreContext(db, application);
  if (!selected) {
    const availableSources = buildAvailableStrategySources(db, application);
    return boundedStrategyContext({
      schemaVersion: 'application-strategy-context.v1',
      mode: 'catalog',
      trust: 'mixed_trusted_and_untrusted_data',
      application: core.application,
      domainState: core.domainState,
      availableSources,
      selectionRequired: true,
      safety: strategyContextSafety()
    });
  }
  for (const [key, ids] of Object.entries(normalizedSelectors)) {
    if (ids.length > MAX_CONTEXT_SOURCES) {
      throw new ApplicationStrategyError('SOURCE_LIMIT', `${key} may contain at most ${MAX_CONTEXT_SOURCES} IDs`);
    }
  }
  const selectedCount = Object.values(normalizedSelectors)
    .reduce((total, ids) => total + ids.length, 0);
  if (selectedCount > MAX_CONTEXT_SOURCES) {
    throw new ApplicationStrategyError(
      'SOURCE_LIMIT',
      `Strategy context may select at most ${MAX_CONTEXT_SOURCES} sources in total`
    );
  }
  const selectedSources = selectStrategySources(db, application, normalizedSelectors);
  const priorStrategy = resolvePriorStrategySource(db, application.id, contextOptions);
  const manifest = {
    schemaVersion: 'application-strategy-source-manifest.v1',
    application: core.application,
    // The active strategy is output state, not source state. Hashing it would
    // make a plan stale merely because that same plan became current.
    domainState: sourceDomainState(core.domainState),
    priorStrategy,
    selectors: normalizedSelectors,
    selectedSourceDigests: selectedSourceDigests(selectedSources)
  };
  const sourceStateSha256 = digest(manifest);
  return boundedStrategyContext({
    schemaVersion: 'application-strategy-context.v1',
    mode: 'selected',
    trust: 'mixed_trusted_and_untrusted_data',
    application: core.application,
    domainState: core.domainState,
    priorStrategy,
    selectors: normalizedSelectors,
    selectedSources,
    sourceManifest: manifest,
    sourceStateSha256,
    safety: strategyContextSafety()
  });
}

function buildStrategyCoreContext(db, application) {
  const applicationProjection = pick(application, [
    'id', 'company', 'role', 'status', 'workflow_stage', 'applied_date', 'job_url',
    'job_opening_id', 'primary_job_posting_id', 'source_opportunity_id', 'lock_version',
    'status_changed_at', 'created_at', 'updated_at'
  ]);
  const opening = application.job_opening_id && tableExists(db, 'job_openings')
    ? (tableExists(db, 'companies')
      ? db.prepare(`
          SELECT jo.id,jo.company_id,jo.canonical_title,jo.status,c.canonical_name AS company_name
          FROM job_openings jo LEFT JOIN companies c ON c.id=jo.company_id WHERE jo.id=?
        `).get(application.job_opening_id) || null
      : db.prepare('SELECT id,company_id,canonical_title,status FROM job_openings WHERE id=?')
        .get(application.job_opening_id) || null)
    : null;
  const postings = tableExists(db, 'application_postings') && tableExists(db, 'job_postings')
    ? db.prepare(`
        SELECT p.id,p.job_opening_id,p.canonical_url,p.external_id,p.state,
          link.relation,link.is_primary
        FROM application_postings link JOIN job_postings p ON p.id=link.job_posting_id
        WHERE link.application_id=? ORDER BY link.is_primary DESC,p.id
      `).all(application.id)
    : [];
  const latestAssessment = tableExists(db, 'application_assessments')
    ? db.prepare('SELECT id,artifact_id,created_at FROM application_assessments WHERE application_id=? ORDER BY id DESC LIMIT 1').get(application.id) || null
    : null;
  const latestAssessmentReview = tableExists(db, 'assessment_review_gates')
    ? db.prepare('SELECT id,artifact_id,decision,decided_by,decided_at FROM assessment_review_gates WHERE application_id=? ORDER BY id DESC LIMIT 1').get(application.id) || null
    : null;
  const materialReadiness = safeMaterialReadiness(db, application.id);
  const interviews = tableExists(db, 'interviews')
    ? db.prepare(`
        SELECT id,round,scheduled_at,format,outcome,scheduling_status,lock_version
        FROM interviews WHERE application_id=? ORDER BY datetime(scheduled_at),id
      `).all(application.id)
    : [];
  const emailSummary = buildEmailSummary(db, application.id);
  const currentStrategy = tableExists(db, 'application_strategy_current')
    ? db.prepare(`
        SELECT current.strategy_revision_id,current.lock_version,revision.revision_number,
          revision.plan_sha256,revision.source_state_sha256
        FROM application_strategy_current current
        JOIN application_strategy_revisions revision ON revision.id=current.strategy_revision_id
        WHERE current.application_id=?
      `).get(application.id) || null
    : null;
  return {
    application: applicationProjection,
    domainState: {
      opening,
      postings,
      assessment: latestAssessment,
      assessmentReview: latestAssessmentReview,
      materialReadiness,
      interviews,
      email: emailSummary,
      currentStrategy
    }
  };
}

function resolvePriorStrategySource(db, applicationId, contextOptions) {
  const explicit = Object.prototype.hasOwnProperty.call(contextOptions, 'priorStrategyRevisionId');
  let revisionId;
  if (explicit) {
    revisionId = contextOptions.priorStrategyRevisionId === null
      ? null
      : positiveId(contextOptions.priorStrategyRevisionId, 'prior strategy revision id');
  } else {
    revisionId = tableExists(db, 'application_strategy_current')
      ? db.prepare('SELECT strategy_revision_id FROM application_strategy_current WHERE application_id=?')
        .get(applicationId)?.strategy_revision_id || null
      : null;
  }
  if (revisionId === null) return null;
  const revision = requireStrategyRevision(db, revisionId, applicationId);
  // A child strategy treats its pinned predecessor's accepted domain outputs as
  // evidence. Revalidate those typed outputs whenever the child context is
  // built so mutable or deleted parent targets fail the child closed as well.
  validateStrategyBindingsCurrent(db, revision);
  const plan = validateApplicationStrategyPlan(JSON.parse(revision.plan_json));
  const review = latestStrategyReview(db, revision.id);
  const selection = db.prepare(`
    SELECT id,selected_by,selected_at FROM application_strategy_selection_events
    WHERE application_id=? AND strategy_revision_id=? ORDER BY id DESC LIMIT 1
  `).get(applicationId, revision.id) || null;
  return {
    id: revision.id,
    revisionNumber: revision.revision_number,
    parentRevisionId: revision.parent_revision_id,
    planSha256: revision.plan_sha256,
    sourceStateSha256: effectiveStrategySourceStateSha256(db, revision),
    routingPolicyRevisionId: revision.routing_policy_revision_id,
    strategy: {
      objective: plan.objective,
      thesis: plan.thesis,
      assumptions: plan.assumptions,
      risks: plan.risks,
      stopConditions: plan.stopConditions
    },
    workProgress: readPriorStrategyWorkProgress(db, revision.id),
    review: review ? { id: review.id, decision: review.decision, reviewedAt: review.reviewed_at } : null,
    selection: selection ? {
      id: selection.id,
      selectedBy: selection.selected_by,
      selectedAt: selection.selected_at
    } : null
  };
}

function readPriorStrategyWorkProgress(db, strategyRevisionId) {
  return readWorkItems(db, strategyRevisionId).map((item) => {
    const event = db.prepare(`
      SELECT * FROM application_strategy_work_events
      WHERE work_item_id=? ORDER BY id DESC LIMIT 1
    `).get(item.id) || null;
    const result = event?.work_result_id
      ? db.prepare('SELECT * FROM application_strategy_work_results WHERE id=?').get(event.work_result_id) || null
      : null;
    const parsedResult = result ? validateApplicationStrategyWorkResult(JSON.parse(result.result_json)) : null;
    const binding = result
      ? db.prepare('SELECT * FROM application_strategy_work_bindings WHERE work_result_id=?').get(result.id) || null
      : null;
    return {
      id: item.id,
      key: item.item_key,
      capability: item.capability,
      outputKind: item.output_kind,
      latestEvent: event ? {
        id: event.id,
        kind: event.event_kind,
        reviewAuthority: event.review_authority,
        createdAt: event.created_at
      } : null,
      result: result ? {
        id: result.id,
        status: result.result_status,
        resultSha256: result.result_sha256,
        confidence: result.confidence,
        overBudget: Boolean(result.over_budget),
        summary: parsedResult.summary
      } : null,
      binding: binding ? serializeWorkBinding(binding) : null
    };
  });
}

function buildAvailableStrategySources(db, application) {
  const artifacts = tableExists(db, 'application_artifacts')
    ? db.prepare(`
        SELECT id,kind,title,source_url,source_name,citation,captured_at,
          content IS NOT NULL AS has_content,attachment_path IS NOT NULL AS has_attachment
        FROM application_artifacts WHERE application_id=? ORDER BY id
      `).all(application.id)
    : [];
  const snapshots = availableSnapshots(db, application);
  const materialRevisions = tableExists(db, 'application_material_revisions')
    && tableExists(db, 'application_materials') && tableExists(db, 'application_material_kinds')
    ? db.prepare(`
        SELECT revision.id,revision.revision_number,revision.content_sha256,revision.created_at,
          material.id AS material_id,kind.slug AS kind
        FROM application_material_revisions revision
        JOIN application_materials material ON material.id=revision.material_id
        JOIN application_material_kinds kind ON kind.id=material.material_kind_id
        WHERE material.application_id=? AND kind.slug IN ('resume','cover-letter')
        ORDER BY material.id,revision.revision_number
      `).all(application.id)
    : [];
  const emailMessages = tableExists(db, 'job_email_application_links') && tableExists(db, 'job_email_message_refs')
    ? db.prepare(`
        SELECT DISTINCT message.id,message.provider,message.account_id,message.message_id,message.thread_id,
          message.received_at,message.from_domain,message.content_completeness,message.event_kind,
          message.security_risk,message.requires_review,message.facts_digest
        FROM ${activeEmailLinkSource(db)} link
        JOIN job_email_message_refs message ON message.id=link.message_ref_id
        WHERE link.application_id=? ORDER BY datetime(message.received_at),message.id
      `).all(application.id)
    : [];
  const interviews = tableExists(db, 'interviews')
    ? db.prepare(`
        SELECT id,round,scheduled_at,format,outcome,scheduling_status,lock_version
        FROM interviews WHERE application_id=? ORDER BY datetime(scheduled_at),id
      `).all(application.id)
    : [];
  const profileEntries = tableExists(db, 'profile_entries')
    ? db.prepare(`
        SELECT id,category,title,source,source_url,recency,confidence,tags,created_at,updated_at,
          attachment_path IS NOT NULL AS has_attachment
        FROM profile_entries WHERE category<>'story' ORDER BY id
      `).all()
    : [];
  const storyUses = tableExists(db, 'profile_story_uses')
    ? db.prepare(`
        SELECT id,story_id,revision_id,variant_id,purpose,target_kind,target_id,
          content_sha256,approved_by,used_at,created_at
        FROM profile_story_uses WHERE application_id=? ORDER BY id
      `).all(application.id)
    : [];
  const catalogs = {
    artifacts,
    snapshots,
    materialRevisions,
    emailMessages,
    interviews,
    profileEntries,
    storyUses
  };
  const truncated = Object.fromEntries(Object.entries(catalogs).map(([key, rows]) => [
    key,
    rows.length > MAX_CONTEXT_SOURCES
  ]));
  return {
    ...Object.fromEntries(Object.entries(catalogs).map(([key, rows]) => [
      key,
      rows.slice(0, MAX_CONTEXT_SOURCES)
    ])),
    bounds: { perTypeLimit: MAX_CONTEXT_SOURCES, truncated }
  };
}

function selectStrategySources(db, application, selectors) {
  const attachmentHashBudget = { bytes: 0 };
  const artifacts = selectors.artifactIds.map((id) => {
    if (!tableExists(db, 'application_artifacts')) sourceNotFound('artifact', id);
    const row = db.prepare('SELECT * FROM application_artifacts WHERE id=? AND application_id=?').get(id, application.id);
    if (!row) sourceNotFound('artifact', id);
    const { attachment_path: _attachmentPath, ...safeRow } = row;
    return { ...safeRow, recordSha256: hashArtifact(row, attachmentHashBudget) };
  });
  const snapshots = selectors.snapshotIds.map((id) => {
    const row = selectApplicationSnapshot(db, application, id);
    const projected = { ...row, trust: 'untrusted_external_inert_data' };
    return { ...projected, recordSha256: digest(projected) };
  });
  const materialRevisions = selectors.materialRevisionIds.map((id) => {
    if (!tableExists(db, 'application_material_revisions') || !tableExists(db, 'application_materials') || !tableExists(db, 'application_material_kinds')) {
      sourceNotFound('material revision', id);
    }
    const row = db.prepare(`
      SELECT revision.*,material.application_id,material.form_field_id,kind.slug AS kind
      FROM application_material_revisions revision
      JOIN application_materials material ON material.id=revision.material_id
      JOIN application_material_kinds kind ON kind.id=material.material_kind_id
      WHERE revision.id=? AND material.application_id=? AND kind.slug IN ('resume','cover-letter')
    `).get(id, application.id);
    if (!row) sourceNotFound('material revision', id);
    return { ...row, recordSha256: digest(row) };
  });
  const emailMessages = selectors.emailMessageRefIds.map((id) => {
    if (!tableExists(db, 'job_email_application_links') || !tableExists(db, 'job_email_message_refs')) sourceNotFound('email message', id);
    const row = db.prepare(`
      SELECT message.* FROM job_email_message_refs message
      JOIN ${activeEmailLinkSource(db)} link ON link.message_ref_id=message.id
      WHERE message.id=? AND link.application_id=?
    `).get(id, application.id);
    if (!row) sourceNotFound('email message', id);
    return projectSelectedEmailMessage(row);
  });
  const interviews = selectors.interviewIds.map((id) => {
    if (!tableExists(db, 'interviews')) sourceNotFound('interview', id);
    const row = db.prepare('SELECT * FROM interviews WHERE id=? AND application_id=?').get(id, application.id);
    if (!row) sourceNotFound('interview', id);
    const prep = tableExists(db, 'interview_prep_current') && tableExists(db, 'interview_prep_analyses')
      ? db.prepare(`
          SELECT analysis.id,analysis.version,analysis.status,analysis.source_digest,
            analysis.generated_by,analysis.generator_version
          FROM interview_prep_current current
          JOIN interview_prep_analyses analysis ON analysis.id=current.analysis_id
          WHERE current.interview_id=?
        `).get(id) || null
      : null;
    const projected = { ...row, currentPrep: prep };
    return { ...projected, recordSha256: digest(projected) };
  });
  const profileEntries = selectors.profileEntryIds.map((id) => {
    if (!tableExists(db, 'profile_entries')) sourceNotFound('profile entry', id);
    const row = db.prepare(`
      SELECT * FROM profile_entries WHERE id=? AND category<>'story'
    `).get(id);
    if (!row) sourceNotFound('profile entry', id);
    const { attachment_path: _attachmentPath, ...safeRow } = row;
    return { ...safeRow, recordSha256: hashProfileEntry(row, attachmentHashBudget) };
  });
  const storyUses = selectors.storyUseIds.map((id) => {
    if (!tableExists(db, 'profile_story_uses') || !tableExists(db, 'profile_story_revisions')) {
      sourceNotFound('story use', id);
    }
    const hasVariants = tableExists(db, 'profile_story_variants');
    const row = hasVariants
      ? db.prepare(`
          SELECT use.*,revision.canonical_text,variant.content AS variant_content
          FROM profile_story_uses use
          JOIN profile_story_revisions revision ON revision.id=use.revision_id
          LEFT JOIN profile_story_variants variant ON variant.id=use.variant_id
          WHERE use.id=? AND use.application_id=?
        `).get(id, application.id)
      : db.prepare(`
          SELECT use.*,revision.canonical_text,NULL AS variant_content
          FROM profile_story_uses use
          JOIN profile_story_revisions revision ON revision.id=use.revision_id
          WHERE use.id=? AND use.application_id=?
        `).get(id, application.id);
    if (!row) sourceNotFound('story use', id);
    return { ...row, recordSha256: digest(row) };
  });
  return {
    artifacts,
    snapshots,
    materialRevisions,
    emailMessages,
    interviews,
    profileEntries,
    storyUses
  };
}

function selectedSourceDigests(selectedSources) {
  return Object.fromEntries(Object.entries(selectedSources).map(([key, rows]) => [
    key,
    rows.map((row) => ({ id: row.id, recordSha256: row.recordSha256 }))
  ]));
}

function importRoutingPolicy(db, rawPolicy, options = {}) {
  requireSchema(db);
  const policy = validateRoutingPolicy(rawPolicy);
  const importedBy = boundedText(options.importedBy || 'agent:strategy-policy', 'importedBy', 200);
  const idempotencyKey = idempotencyKeyValue(options.idempotencyKey);
  const createdAt = isoTimestamp(options.now || new Date().toISOString(), 'createdAt');
  const intent = { policy, importedBy };
  return idempotentOperation(db, 'strategy-policy-import', idempotencyKey, intent, () => {
    validatePolicyAgainstCatalog(db, policy);
    const policySha256 = digest(policy);
    const existing = db.prepare('SELECT * FROM strategy_routing_policy_revisions WHERE policy_key=? AND version=?')
      .get(policy.policyId, policy.version);
    if (existing) {
      if (existing.policy_sha256 !== policySha256) {
        throw new ApplicationStrategyError('POLICY_CONFLICT', 'Policy ID/version was already imported with different content');
      }
      return { policyRevision: serializePolicyRevision(existing), reused: true };
    }
    const info = db.prepare(`
      INSERT INTO strategy_routing_policy_revisions(
        policy_key,version,policy_json,policy_sha256,imported_by,created_at
      ) VALUES (?,?,?,?,?,?)
    `).run(policy.policyId, policy.version, stableJson(policy), policySha256, importedBy, createdAt);
    return {
      policyRevision: serializePolicyRevision(db.prepare('SELECT * FROM strategy_routing_policy_revisions WHERE id=?').get(info.lastInsertRowid)),
      reused: false
    };
  });
}

function reviewRoutingPolicy(db, input) {
  requireSchema(db);
  const policyRevisionId = positiveId(input.policyRevisionId, 'policy revision id');
  const decision = enumeration(input.decision, new Set(['approved', 'rejected']), 'decision');
  const reviewedBy = boundedText(input.reviewedBy, 'reviewedBy', 200);
  const expectedReviewId = nullableExpectedId(input.expectedReviewId, 'expectedReviewId');
  const notes = optionalBoundedText(input.notes, 'notes', 20_000);
  const reviewedAtInput = input.reviewedAt ? isoTimestamp(input.reviewedAt, 'reviewedAt') : null;
  const idempotencyKey = idempotencyKeyValue(input.idempotencyKey);
  const intent = { policyRevisionId, decision, reviewedBy, expectedReviewId, notes, reviewedAt: reviewedAtInput };
  return idempotentOperation(db, 'strategy-policy-review', idempotencyKey, intent, () => {
    const reviewedAt = reviewedAtInput || new Date().toISOString();
    requirePolicyRevision(db, policyRevisionId);
    const latest = latestPolicyReview(db, policyRevisionId);
    if ((latest?.id || null) !== expectedReviewId) stale('policy review', expectedReviewId, latest?.id || null);
    const info = db.prepare(`
      INSERT INTO strategy_routing_policy_review_events(
        policy_revision_id,decision,expected_prior_review_id,reviewed_by,notes,
        idempotency_key,intent_sha256,reviewed_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(policyRevisionId, decision, expectedReviewId, reviewedBy, notes, idempotencyKey, digest(intent), reviewedAt);
    return { policyRevisionId, review: db.prepare('SELECT * FROM strategy_routing_policy_review_events WHERE id=?').get(info.lastInsertRowid) };
  });
}

function selectRoutingPolicy(db, input) {
  requireSchema(db);
  const policyRevisionId = positiveId(input.policyRevisionId, 'policy revision id');
  const selectedBy = boundedText(input.selectedBy, 'selectedBy', 200);
  const expectedCurrentPolicyRevisionId = nullableExpectedId(input.expectedCurrentPolicyRevisionId, 'expectedCurrentPolicyRevisionId');
  const selectedAtInput = input.selectedAt ? isoTimestamp(input.selectedAt, 'selectedAt') : null;
  const idempotencyKey = idempotencyKeyValue(input.idempotencyKey);
  const intent = { policyRevisionId, selectedBy, expectedCurrentPolicyRevisionId, selectedAt: selectedAtInput };
  return idempotentOperation(db, 'strategy-policy-select', idempotencyKey, intent, () => {
    const selectedAt = selectedAtInput || new Date().toISOString();
    requirePolicyRevision(db, policyRevisionId);
    const latest = latestPolicyReview(db, policyRevisionId);
    if (latest?.decision !== 'approved') throw new ApplicationStrategyError('APPROVAL_REQUIRED', 'Routing policy requires approval before selection');
    const current = db.prepare('SELECT * FROM strategy_routing_policy_current WHERE singleton_id=1').get();
    if ((current?.policy_revision_id || null) !== expectedCurrentPolicyRevisionId) {
      stale('current routing policy', expectedCurrentPolicyRevisionId, current?.policy_revision_id || null);
    }
    db.prepare(`
      INSERT INTO strategy_routing_policy_selection_events(
        previous_policy_revision_id,policy_revision_id,expected_current_policy_revision_id,
        selected_by,idempotency_key,intent_sha256,selected_at
      ) VALUES (?,?,?,?,?,?,?)
    `).run(current?.policy_revision_id || null, policyRevisionId, expectedCurrentPolicyRevisionId, selectedBy, idempotencyKey, digest(intent), selectedAt);
    db.prepare(`
      INSERT INTO strategy_routing_policy_current(singleton_id,policy_revision_id,lock_version,selected_by,selected_at)
      VALUES (1,?,0,?,?)
      ON CONFLICT(singleton_id) DO UPDATE SET policy_revision_id=excluded.policy_revision_id,
        lock_version=strategy_routing_policy_current.lock_version+1,
        selected_by=excluded.selected_by,selected_at=excluded.selected_at
    `).run(policyRevisionId, selectedBy, selectedAt);
    return getCurrentRoutingPolicy(db);
  });
}

function getCurrentRoutingPolicy(db) {
  requireSchema(db);
  const row = db.prepare(`
    SELECT current.*,revision.policy_key,revision.version,revision.policy_json,
      revision.policy_sha256,revision.imported_by,revision.created_at
    FROM strategy_routing_policy_current current
    JOIN strategy_routing_policy_revisions revision ON revision.id=current.policy_revision_id
    WHERE current.singleton_id=1
  `).get();
  if (!row) return null;
  const review = latestPolicyReview(db, row.policy_revision_id);
  return {
    ...row,
    policy: validateRoutingPolicy(JSON.parse(row.policy_json)),
    review,
    isApproved: review?.decision === 'approved'
  };
}

function importApplicationStrategyPlan(db, rawPlan, options = {}) {
  requireSchema(db);
  const plan = validateApplicationStrategyPlan(rawPlan);
  const idempotencyKey = idempotencyKeyValue(options.idempotencyKey);
  const createdAt = isoTimestamp(options.now || new Date().toISOString(), 'createdAt');
  const selectors = normalizeSelectorsForWrite(options.selectors);
  const parentRevisionId = options.parentRevisionId === undefined
    ? null
    : nullableExpectedId(options.parentRevisionId, 'parentRevisionId');
  const intent = { plan, selectors, parentRevisionId };
  return idempotentOperation(db, 'strategy-plan-import', idempotencyKey, intent, () => {
    const policy = getCurrentRoutingPolicy(db);
    if (!policy) throw new ApplicationStrategyError('ROUTING_POLICY_REQUIRED', 'Select an approved routing policy before importing a strategy plan');
    if (!policy.isApproved) {
      throw new ApplicationStrategyError(
        'ROUTING_POLICY_APPROVAL_REQUIRED',
        'The selected routing policy is no longer approved; review or replace it before importing a plan'
      );
    }
    assertFrontierCoordinatorPolicy(policy.policy, plan);
    const context = buildApplicationStrategyContext(db, plan.applicationId, selectors);
    if (context.mode !== 'selected' || context.sourceStateSha256 !== plan.sourceStateSha256) {
      throw new ApplicationStrategyError('SOURCE_STATE_STALE', 'Plan source digest does not match the selected current strategy context', {
        expected: plan.sourceStateSha256,
        actual: context.sourceStateSha256
      });
    }
    validatePlanCapabilities(db, plan, policy.policy);
    validatePlanSourceRefs(plan, selectors);
    if (parentRevisionId !== null) requireStrategyRevision(db, parentRevisionId, plan.applicationId);
    const priorStrategyRevisionId = context.priorStrategy?.id || null;
    if (parentRevisionId !== priorStrategyRevisionId) {
      throw new ApplicationStrategyError(
        'PARENT_STRATEGY_MISMATCH',
        `Plan parent must match the currently selected prior strategy ${priorStrategyRevisionId || 'none'}`
      );
    }
    const nextVersion = db.prepare('SELECT COALESCE(MAX(revision_number),0)+1 AS value FROM application_strategy_revisions WHERE application_id=?')
      .get(plan.applicationId).value;
    const planSha256 = digest(plan);
    const existing = db.prepare('SELECT id FROM application_strategy_revisions WHERE plan_sha256=?').get(planSha256);
    if (existing) throw new ApplicationStrategyError('PLAN_CONFLICT', 'The exact plan is already stored under another operation');
    const info = db.prepare(`
      INSERT INTO application_strategy_revisions(
        application_id,revision_number,parent_revision_id,routing_policy_revision_id,
        source_manifest_json,source_state_sha256,plan_json,plan_sha256,
        coordinator_run_id,coordinator_route_alias,coordinator_provider,coordinator_model,
        coordinator_model_version,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      plan.applicationId, nextVersion, parentRevisionId, policy.policy_revision_id,
      stableJson(context.sourceManifest), context.sourceStateSha256, stableJson(plan), planSha256,
      plan.coordinator.runId, plan.coordinator.routeAlias, plan.coordinator.provider,
      plan.coordinator.model, plan.coordinator.modelVersion || null, createdAt
    );
    const strategyRevisionId = Number(info.lastInsertRowid);
    insertPlanWorkItems(db, strategyRevisionId, plan.workItems, createdAt);
    return getApplicationStrategyRevision(db, strategyRevisionId);
  });
}

function reviewApplicationStrategyPlan(db, input) {
  requireSchema(db);
  const strategyRevisionId = positiveId(input.strategyRevisionId, 'strategy revision id');
  const decision = enumeration(input.decision, REVIEW_DECISIONS, 'decision');
  const reviewedBy = boundedText(input.reviewedBy, 'reviewedBy', 200);
  const expectedReviewId = nullableExpectedId(input.expectedReviewId, 'expectedReviewId');
  const notes = optionalBoundedText(input.notes, 'notes', 20_000);
  const reviewedAtInput = input.reviewedAt ? isoTimestamp(input.reviewedAt, 'reviewedAt') : null;
  const idempotencyKey = idempotencyKeyValue(input.idempotencyKey);
  const intent = { strategyRevisionId, decision, reviewedBy, expectedReviewId, notes, reviewedAt: reviewedAtInput };
  return idempotentOperation(db, 'strategy-plan-review', idempotencyKey, intent, () => {
    const reviewedAt = reviewedAtInput || new Date().toISOString();
    requireStrategyRevision(db, strategyRevisionId);
    const latest = latestStrategyReview(db, strategyRevisionId);
    if ((latest?.id || null) !== expectedReviewId) stale('strategy review', expectedReviewId, latest?.id || null);
    const info = db.prepare(`
      INSERT INTO application_strategy_review_events(
        strategy_revision_id,decision,expected_prior_review_id,reviewed_by,notes,
        idempotency_key,intent_sha256,reviewed_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(strategyRevisionId, decision, expectedReviewId, reviewedBy, notes, idempotencyKey, digest(intent), reviewedAt);
    return { strategyRevisionId, review: db.prepare('SELECT * FROM application_strategy_review_events WHERE id=?').get(info.lastInsertRowid) };
  });
}

function selectApplicationStrategyPlan(db, input) {
  requireSchema(db);
  const strategyRevisionId = positiveId(input.strategyRevisionId, 'strategy revision id');
  const selectedBy = boundedText(input.selectedBy, 'selectedBy', 200);
  const expectedCurrentStrategyRevisionId = nullableExpectedId(input.expectedCurrentStrategyRevisionId, 'expectedCurrentStrategyRevisionId');
  const selectedAtInput = input.selectedAt ? isoTimestamp(input.selectedAt, 'selectedAt') : null;
  const idempotencyKey = idempotencyKeyValue(input.idempotencyKey);
  const intent = { strategyRevisionId, selectedBy, expectedCurrentStrategyRevisionId, selectedAt: selectedAtInput };
  return idempotentOperation(db, 'strategy-plan-select', idempotencyKey, intent, () => {
    const selectedAt = selectedAtInput || new Date().toISOString();
    const revision = requireStrategyRevision(db, strategyRevisionId);
    const latest = latestStrategyReview(db, strategyRevisionId);
    if (latest?.decision !== 'approved') throw new ApplicationStrategyError('APPROVAL_REQUIRED', 'Strategy plan requires approval before selection');
    assertStrategyRevisionFresh(db, revision);
    const current = db.prepare('SELECT * FROM application_strategy_current WHERE application_id=?').get(revision.application_id);
    if ((current?.strategy_revision_id || null) !== expectedCurrentStrategyRevisionId) {
      stale('current strategy', expectedCurrentStrategyRevisionId, current?.strategy_revision_id || null);
    }
    db.prepare(`
      INSERT INTO application_strategy_selection_events(
        application_id,previous_strategy_revision_id,strategy_revision_id,
        expected_current_strategy_revision_id,selected_by,idempotency_key,intent_sha256,selected_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(
      revision.application_id, current?.strategy_revision_id || null, strategyRevisionId,
      expectedCurrentStrategyRevisionId, selectedBy, idempotencyKey, digest(intent), selectedAt
    );
    db.prepare(`
      INSERT INTO application_strategy_current(application_id,strategy_revision_id,lock_version,selected_by,selected_at)
      VALUES (?,?,0,?,?)
      ON CONFLICT(application_id) DO UPDATE SET strategy_revision_id=excluded.strategy_revision_id,
        lock_version=application_strategy_current.lock_version+1,
        selected_by=excluded.selected_by,selected_at=excluded.selected_at
    `).run(revision.application_id, strategyRevisionId, selectedBy, selectedAt);
    return getApplicationStrategyStatus(db, revision.application_id);
  });
}

function getApplicationStrategyRevision(db, strategyRevisionId, expectedApplicationId = null) {
  requireSchema(db);
  const revision = requireStrategyRevision(db, strategyRevisionId, expectedApplicationId);
  const workItems = readWorkItems(db, revision.id);
  return {
    revision: serializeStrategyRevision(revision),
    workItems,
    reviews: db.prepare('SELECT * FROM application_strategy_review_events WHERE strategy_revision_id=? ORDER BY id').all(revision.id),
    isCurrent: Boolean(db.prepare('SELECT 1 FROM application_strategy_current WHERE strategy_revision_id=?').get(revision.id)),
    isStale: strategyRevisionIsStale(db, revision)
  };
}

function getApplicationStrategyStatus(db, applicationId) {
  requireSchema(db);
  applicationId = positiveId(applicationId, 'application id');
  const application = db.prepare('SELECT id,company,role,status,workflow_stage FROM applications WHERE id=?').get(applicationId);
  if (!application) throw new ApplicationStrategyError('NOT_FOUND', `Application not found: ${applicationId}`);
  const current = db.prepare(`
    SELECT revision.*,pointer.lock_version AS selection_lock_version,
      pointer.selected_by,pointer.selected_at
    FROM application_strategy_current pointer
    JOIN application_strategy_revisions revision ON revision.id=pointer.strategy_revision_id
    WHERE pointer.application_id=?
  `).get(applicationId);
  if (!current) {
    return {
      schemaVersion: 'application-strategy-status.v1',
      application,
      strategy: null,
      state: 'unplanned',
      workItems: [],
      counts: { total: 0, ready: 0, active: 0, completed: 0, blocked: 0 }
    };
  }
  const currentSourceStateSha256 = effectiveStrategySourceStateSha256(db, current);
  let observedCurrentSourceStateSha256 = null;
  let stalePlan = true;
  try {
    validateStrategyBindingsCurrent(db, current);
    observedCurrentSourceStateSha256 = strategyRevisionSourceContext(db, current).sourceStateSha256;
    stalePlan = observedCurrentSourceStateSha256 !== currentSourceStateSha256;
  } catch (error) {
    if (!['SOURCE_NOT_FOUND', 'BINDING_TARGET_STALE', 'DOMAIN_TARGET_SCOPE_MISMATCH',
      'DOMAIN_TARGET_UNAVAILABLE', 'ATTACHMENT_UNVERIFIABLE', 'ATTACHMENT_BYTES_LIMIT',
      'ATTACHMENT_HASH_BUDGET_EXCEEDED', 'UNSAFE_ATTACHMENT_PATH', 'CONTEXT_BYTES_LIMIT']
      .includes(error?.code)) throw error;
  }
  const sourceCheckpoint = db.prepare(`
    SELECT * FROM application_strategy_source_checkpoint_events
    WHERE strategy_revision_id=? ORDER BY id DESC LIMIT 1
  `).get(current.id) || null;
  const planReview = latestStrategyReview(db, current.id);
  const planApproved = planReview?.decision === 'approved';
  const routingPolicyReview = latestPolicyReview(db, current.routing_policy_revision_id);
  const routingPolicyApproved = routingPolicyReview?.decision === 'approved';
  const workItems = readWorkItems(db, current.id).map((item) => {
    if (stalePlan) return deriveWorkItemState(db, item, current, true);
    if (!planApproved) {
      return { ...item, state: 'blocked-plan-review', blockers: ['Selected strategy is not approved'] };
    }
    if (!routingPolicyApproved) {
      return { ...item, state: 'blocked-routing-policy', blockers: ['Pinned routing policy is not approved'] };
    }
    return deriveWorkItemState(db, item, current, false);
  });
  const counts = {
    total: workItems.length,
    ready: workItems.filter((item) => item.state === 'ready' || item.state === 'escalation-ready').length,
    active: workItems.filter((item) => [
      'issued', 'result-recorded', 'accepted-awaiting-binding'
    ].includes(item.state)).length,
    completed: workItems.filter((item) => item.state === 'completed').length,
    blocked: workItems.filter((item) => item.state.startsWith('blocked') || item.state === 'stale-plan').length
  };
  const revisionRequired = workItems.some((item) => [
    'blocked-revision-required', 'blocked-source-checkpoint'
  ].includes(item.state));
  return {
    schemaVersion: 'application-strategy-status.v1',
    application,
    strategy: {
      ...serializeStrategyRevision(current),
      selectedBy: current.selected_by,
      selectedAt: current.selected_at,
      selectionLockVersion: current.selection_lock_version,
      review: planReview,
      routingPolicyReview,
      currentSourceStateSha256,
      observedCurrentSourceStateSha256,
      sourceCheckpoint: sourceCheckpoint ? serializeSourceCheckpoint(sourceCheckpoint) : null,
      isStale: stalePlan
    },
    state: stalePlan
      ? 'stale'
      : !planApproved
        ? 'review-required'
        : !routingPolicyApproved
          ? 'routing-policy-review-required'
          : counts.completed === counts.total
            ? 'complete'
            : revisionRequired && counts.ready === 0 && counts.active === 0
              ? 'revision-required'
              : counts.ready === 0 && counts.active === 0 && counts.blocked > 0
                ? 'blocked'
                : 'active',
    workItems,
    counts
  };
}

function listApplicationStrategyQueue(db, filters = {}) {
  requireSchema(db);
  rejectUnknownKeys(filters, ['applicationId', 'state', 'capability'], 'strategy queue filters');
  const applicationIds = filters.applicationId
    ? [positiveId(filters.applicationId, 'application id')]
    : db.prepare('SELECT application_id FROM application_strategy_current ORDER BY application_id').all().map((row) => row.application_id);
  const rows = [];
  for (const applicationId of applicationIds) {
    const status = getApplicationStrategyStatus(db, applicationId);
    for (const item of status.workItems) {
      if (filters.state && item.state !== filters.state) continue;
      if (filters.capability && item.capability !== filters.capability) continue;
      rows.push({ application: status.application, strategyRevisionId: status.strategy?.id || null, ...item });
    }
  }
  return { schemaVersion: 'application-strategy-queue.v1', workItems: rows };
}

function issueApplicationStrategyWork(db, input) {
  requireSchema(db);
  const workItemId = positiveId(input.workItemId, 'work item id');
  const issuedBy = boundedText(input.issuedBy, 'issuedBy', 200);
  const expectedSourceStateSha256 = sha256Value(input.expectedSourceStateSha256, 'expectedSourceStateSha256');
  const idempotencyKey = idempotencyKeyValue(input.idempotencyKey);
  const createdAt = isoTimestamp(input.createdAt || new Date().toISOString(), 'createdAt');
  const intent = { workItemId, issuedBy, expectedSourceStateSha256 };
  return idempotentOperation(db, 'strategy-work-issue', idempotencyKey, intent, () => {
    const item = requireWorkItem(db, workItemId);
    const revision = requireStrategyRevision(db, item.strategy_revision_id);
    const current = db.prepare('SELECT strategy_revision_id FROM application_strategy_current WHERE application_id=?').get(revision.application_id);
    if (current?.strategy_revision_id !== revision.id) throw new ApplicationStrategyError('PLAN_NOT_CURRENT', 'Work may be issued only from the selected current strategy');
    if (latestStrategyReview(db, revision.id)?.decision !== 'approved') throw new ApplicationStrategyError('APPROVAL_REQUIRED', 'Selected strategy is not currently approved');
    const currentContext = currentStrategyRevisionContext(db, revision);
    const actualSourceState = currentContext.sourceStateSha256;
    if (actualSourceState !== expectedSourceStateSha256) {
      throw new ApplicationStrategyError('SOURCE_STATE_STALE', 'Expected source state differs from the current selected plan state', {
        expected: expectedSourceStateSha256, actual: actualSourceState
      });
    }
    const derived = deriveWorkItemState(db, readWorkItem(db, item.id), revision, false);
    if (!['ready', 'escalation-ready'].includes(derived.state)) {
      throw new ApplicationStrategyError('WORK_NOT_READY', `Work item ${item.id} is ${derived.state}`);
    }
    const policyRecord = requirePolicyRevision(db, revision.routing_policy_revision_id);
    if (latestPolicyReview(db, policyRecord.id)?.decision !== 'approved') {
      throw new ApplicationStrategyError(
        'ROUTING_POLICY_APPROVAL_REQUIRED',
        'The strategy routing policy is no longer approved'
      );
    }
    const policy = validateRoutingPolicy(JSON.parse(policyRecord.policy_json));
    const rule = policy.rules.find((candidate) => candidate.capability === item.capability);
    if (!rule) throw new ApplicationStrategyError('ROUTE_NOT_FOUND', `No route policy exists for ${item.capability}`);
    const previousRequests = db.prepare('SELECT count(*) AS count FROM application_strategy_work_requests WHERE work_item_id=?').get(item.id).count;
    const attemptNumber = previousRequests + 1;
    if (attemptNumber > rule.maxAttempts) throw new ApplicationStrategyError('ATTEMPT_LIMIT', `Work item ${item.id} exhausted ${rule.maxAttempts} attempts`);
    const escalated = attemptNumber > 1;
    const requiredModelClass = escalated ? rule.escalationModelClass : rule.minimumModelClass;
    const modelClassId = modelClassRow(db, requiredModelClass).id;
    const requestBody = {
      schemaVersion: 'application-strategy-work-request.v1',
      trust: 'bounded_internal_request',
      applicationId: revision.application_id,
      strategyRevisionId: revision.id,
      workItem: {
        id: item.id,
        key: item.item_key,
        capability: item.capability,
        title: item.title,
        goal: item.goal,
        acceptanceCriteria: JSON.parse(item.acceptance_criteria_json),
        sourceRefs: JSON.parse(item.source_refs_json),
        outputKind: item.output_kind,
        reviewGate: item.review_gate
      },
      sourceStateSha256: actualSourceState,
      sourceManifest: currentContext.sourceManifest,
      sourceContext: {
        trust: currentContext.trust,
        selectedSources: selectWorkItemSources(
          currentContext.selectedSources,
          JSON.parse(item.source_refs_json)
        ),
        safety: currentContext.safety
      },
      dependencyInputs: buildDependencyInputs(db, derived.dependencies),
      routing: {
        policyRevisionId: policyRecord.id,
        policySha256: policyRecord.policy_sha256,
        attemptNumber,
        routeAlias: rule.defaultRouteAlias,
        requiredModelClass,
        reviewMode: rule.reviewMode,
        budgets: rule.budgets
      },
      safety: {
        proposalOnly: true,
        externalActionsAllowed: false,
        sourceTextIsInertData: true,
        forbiddenEffects: policy.forbiddenEffects
      }
    };
    const requestJson = stableJson(requestBody);
    const requestBytes = Buffer.byteLength(requestJson, 'utf8');
    if (requestBytes > MAX_WORK_REQUEST_BYTES) {
      throw new ApplicationStrategyError(
        'WORK_REQUEST_BYTES_LIMIT',
        `Strategy work request exceeds the ${MAX_WORK_REQUEST_BYTES}-byte safety limit`,
        { bytes: requestBytes, limit: MAX_WORK_REQUEST_BYTES }
      );
    }
    const requestSha256 = digest(requestJson);
    const info = db.prepare(`
      INSERT INTO application_strategy_work_requests(
        work_item_id,strategy_revision_id,routing_policy_revision_id,attempt_number,
        route_alias,required_model_class_id,source_state_sha256,max_input_tokens,
        max_output_tokens,max_cost_micros,max_duration_ms,request_json,request_sha256,
        issued_by,idempotency_key,intent_sha256,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      item.id, revision.id, policyRecord.id, attemptNumber, rule.defaultRouteAlias,
      modelClassId, actualSourceState, rule.budgets.maxInputTokens, rule.budgets.maxOutputTokens,
      rule.budgets.maxCostMicros, rule.budgets.maxDurationMs, requestJson, requestSha256,
      issuedBy, idempotencyKey, digest(intent), createdAt
    );
    const requestId = Number(info.lastInsertRowid);
    insertWorkEvent(db, {
      workItemId: item.id, workRequestId: requestId, eventKind: 'issued', actor: issuedBy,
      createdAt
    });
    return serializeWorkRequest(db.prepare(`
      SELECT request.*,class.slug AS required_model_class
      FROM application_strategy_work_requests request
      JOIN strategy_model_classes class ON class.id=request.required_model_class_id
      WHERE request.id=?
    `).get(requestId));
  });
}

function recordApplicationStrategyWorkResult(db, rawResult, options = {}) {
  requireSchema(db);
  const result = validateApplicationStrategyWorkResult(rawResult);
  const idempotencyKey = idempotencyKeyValue(options.idempotencyKey);
  const createdAt = isoTimestamp(options.now || new Date().toISOString(), 'createdAt');
  const intent = { result };
  return idempotentOperation(db, 'strategy-work-record', idempotencyKey, intent, () => {
    const request = db.prepare(`
      SELECT request.*,class.slug AS required_model_class,item.output_kind,item.capability_id,
        capability.slug AS capability,item.strategy_revision_id AS item_strategy_revision_id
      FROM application_strategy_work_requests request
      JOIN strategy_model_classes class ON class.id=request.required_model_class_id
      JOIN application_strategy_work_items item ON item.id=request.work_item_id
      JOIN strategy_capabilities capability ON capability.id=item.capability_id
      WHERE request.id=?
    `).get(result.requestId);
    if (!request) throw new ApplicationStrategyError('NOT_FOUND', `Strategy work request not found: ${result.requestId}`);
    if (request.request_sha256 !== result.requestDigest) throw new ApplicationStrategyError('REQUEST_DIGEST_MISMATCH', 'Work result does not bind the exact request');
    if (request.source_state_sha256 !== result.sourceStateSha256) throw new ApplicationStrategyError('SOURCE_DIGEST_MISMATCH', 'Work result source state differs from its request');
    if (request.route_alias !== result.worker.routeAlias) throw new ApplicationStrategyError('ROUTE_MISMATCH', 'Worker route alias differs from the issued request');
    if ((request.required_model_class === 'deterministic' && result.worker.modelClass !== 'deterministic')
      || (request.required_model_class !== 'deterministic'
        && modelClassRank(result.worker.modelClass) < modelClassRank(request.required_model_class))) {
      throw new ApplicationStrategyError('MODEL_CLASS_TOO_WEAK', `Work request requires ${request.required_model_class}`);
    }
    if (result.status === 'succeeded' && result.output.kind !== request.output_kind) {
      throw new ApplicationStrategyError('OUTPUT_KIND_MISMATCH', `Work result must produce ${request.output_kind}`);
    }
    const resultSha256 = digest(result);
    const existing = db.prepare('SELECT id,result_sha256 FROM application_strategy_work_results WHERE work_request_id=?').get(request.id);
    if (existing) {
      if (existing.result_sha256 !== resultSha256) throw new ApplicationStrategyError('RESULT_CONFLICT', 'Work request already has a different result');
      return getWorkResult(db, existing.id);
    }
    const overBudget = Number(
      result.usage.inputTokens > request.max_input_tokens
      || result.usage.outputTokens > request.max_output_tokens
      || result.usage.costMicros > request.max_cost_micros
      || result.usage.durationMs > request.max_duration_ms
    );
    const modelClassId = modelClassRow(db, result.worker.modelClass).id;
    const info = db.prepare(`
      INSERT INTO application_strategy_work_results(
        work_request_id,result_status,worker_run_id,worker_route_alias,worker_model_class_id,
        worker_provider,worker_model,worker_model_version,input_tokens,output_tokens,cost_micros,
        duration_ms,over_budget,confidence,result_json,result_sha256,idempotency_key,intent_sha256,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      request.id, result.status, result.worker.runId, result.worker.routeAlias, modelClassId,
      result.worker.provider, result.worker.model, result.worker.modelVersion || null,
      result.usage.inputTokens, result.usage.outputTokens, result.usage.costMicros,
      result.usage.durationMs, overBudget, result.confidence, stableJson(result), resultSha256,
      idempotencyKey, digest(intent), createdAt
    );
    const resultId = Number(info.lastInsertRowid);
    insertWorkEvent(db, {
      workItemId: request.work_item_id, workRequestId: request.id, workResultId: resultId,
      eventKind: result.status === 'blocked' ? 'blocked' : 'result-recorded', actor: result.worker.runId,
      createdAt
    });
    return getWorkResult(db, resultId);
  });
}

function reviewApplicationStrategyWorkResult(db, input) {
  requireSchema(db);
  const resultId = positiveId(input.resultId, 'work result id');
  const decision = enumeration(input.decision, WORK_REVIEW_DECISIONS, 'decision');
  const reviewedBy = boundedText(input.reviewedBy, 'reviewedBy', 200);
  const reviewedAs = enumeration(input.reviewedAs, new Set(['frontier', 'human', 'domain']), 'reviewedAs');
  const notes = optionalBoundedText(input.notes, 'notes', 20_000);
  const reviewedAtInput = input.reviewedAt ? isoTimestamp(input.reviewedAt, 'reviewedAt') : null;
  const idempotencyKey = idempotencyKeyValue(input.idempotencyKey);
  const intent = { resultId, decision, reviewedBy, reviewedAs, notes, reviewedAt: reviewedAtInput };
  return idempotentOperation(db, 'strategy-work-review', idempotencyKey, intent, () => {
    const reviewedAt = reviewedAtInput || new Date().toISOString();
    const result = db.prepare(`
      SELECT result.*,request.work_item_id,request.attempt_number,
        request.source_state_sha256 AS request_source_state_sha256,item.strategy_revision_id,
        item.review_gate,item.output_kind,capability.slug AS capability
      FROM application_strategy_work_results result
      JOIN application_strategy_work_requests request ON request.id=result.work_request_id
      JOIN application_strategy_work_items item ON item.id=request.work_item_id
      JOIN strategy_capabilities capability ON capability.id=item.capability_id
      WHERE result.id=?
    `).get(resultId);
    if (!result) throw new ApplicationStrategyError('NOT_FOUND', `Strategy work result not found: ${resultId}`);
    const latestDecision = db.prepare(`
      SELECT * FROM application_strategy_work_events
      WHERE work_result_id=? AND event_kind IN ('accepted','rejected','escalated')
      ORDER BY id DESC LIMIT 1
    `).get(resultId);
    if (latestDecision) throw new ApplicationStrategyError('RESULT_ALREADY_REVIEWED', `Work result is already ${latestDecision.event_kind}`);
    if (reviewedAs !== result.review_gate) {
      throw new ApplicationStrategyError(
        'REVIEW_AUTHORITY_MISMATCH',
        `Work result requires ${result.review_gate} review authority`
      );
    }
    const revision = requireStrategyRevision(db, result.strategy_revision_id);
    const current = db.prepare('SELECT strategy_revision_id FROM application_strategy_current WHERE application_id=?')
      .get(revision.application_id);
    if (decision !== 'rejected' && current?.strategy_revision_id !== revision.id) {
      throw new ApplicationStrategyError('PLAN_NOT_CURRENT', 'Only results from the current strategy may advance application work');
    }
    if (decision !== 'rejected' && latestStrategyReview(db, revision.id)?.decision !== 'approved') {
      throw new ApplicationStrategyError('APPROVAL_REQUIRED', 'The strategy plan is not currently approved');
    }
    if (decision !== 'rejected') {
      const currentSourceStateSha256 = assertStrategyRevisionFresh(db, revision);
      if (result.request_source_state_sha256 !== currentSourceStateSha256) {
        throw new ApplicationStrategyError(
          'WORK_REQUEST_SOURCE_STALE',
          'The work result was produced from a source checkpoint that is no longer current',
          { expected: currentSourceStateSha256, actual: result.request_source_state_sha256 }
        );
      }
      if (latestPolicyReview(db, revision.routing_policy_revision_id)?.decision !== 'approved') {
        throw new ApplicationStrategyError(
          'ROUTING_POLICY_APPROVAL_REQUIRED',
          'The strategy routing policy is no longer approved'
        );
      }
    }
    if (decision === 'accepted' && result.result_status !== 'succeeded') {
      throw new ApplicationStrategyError('RESULT_NOT_SUCCESSFUL', 'Only a successful result can be accepted');
    }
    if (decision === 'accepted' && result.over_budget) {
      throw new ApplicationStrategyError('BUDGET_EXCEEDED', 'An over-budget result cannot be accepted; reject or escalate it');
    }
    if (decision === 'escalated') {
      const item = requireWorkItem(db, result.work_item_id);
      const revision = requireStrategyRevision(db, item.strategy_revision_id);
      const policy = validateRoutingPolicy(JSON.parse(requirePolicyRevision(db, revision.routing_policy_revision_id).policy_json));
      const rule = policy.rules.find((candidate) => candidate.capability === item.capability);
      if (result.attempt_number >= rule.maxAttempts) throw new ApplicationStrategyError('ATTEMPT_LIMIT', 'No escalation attempts remain');
    }
    insertWorkEvent(db, {
      workItemId: result.work_item_id, workRequestId: result.work_request_id, workResultId: result.id,
      eventKind: decision, actor: reviewedBy, reviewAuthority: reviewedAs, notes,
      idempotencyKey, intentSha256: digest(intent), createdAt: reviewedAt
    });
    return deriveWorkItemState(
      db,
      readWorkItem(db, result.work_item_id),
      revision,
      false
    );
  });
}

function bindApplicationStrategyWorkResult(db, input) {
  requireSchema(db);
  rejectUnknownKeys(input, [
    'resultId', 'applicationId', 'artifactId', 'assessmentId', 'materialRevisionId',
    'emailReplyProposalId', 'interviewPrepAnalysisId', 'materialRenderId',
    'expectedCurrentSourceStateSha256', 'boundBy', 'reason', 'boundAt', 'idempotencyKey'
  ], 'strategy work binding');
  const resultId = positiveId(input.resultId, 'work result id');
  const applicationId = positiveId(input.applicationId, 'application id');
  const expectedCurrentSourceStateSha256 = sha256Value(
    input.expectedCurrentSourceStateSha256,
    'expectedCurrentSourceStateSha256'
  );
  const boundBy = boundedText(input.boundBy, 'boundBy', 200);
  const reason = boundedText(input.reason, 'reason', 2_000);
  const boundAtInput = input.boundAt ? isoTimestamp(input.boundAt, 'boundAt') : null;
  const idempotencyKey = idempotencyKeyValue(input.idempotencyKey);
  const providedTargets = Object.values(OUTPUT_BINDING_TARGETS)
    .filter((target) => input[target.inputKey] !== undefined
      && input[target.inputKey] !== null && input[target.inputKey] !== '');
  if (providedTargets.length !== 1) {
    throw new ApplicationStrategyError(
      'BINDING_TARGET_REQUIRED',
      'Provide exactly one typed strategy binding target'
    );
  }
  const requestedTarget = providedTargets[0];
  const rawTargetId = requestedTarget.kind === 'email-reply-proposal'
    ? boundedText(input[requestedTarget.inputKey], requestedTarget.inputKey, 500)
    : positiveId(input[requestedTarget.inputKey], requestedTarget.inputKey);
  const intent = {
    resultId,
    applicationId,
    targetKind: requestedTarget.kind,
    targetId: rawTargetId,
    expectedCurrentSourceStateSha256,
    boundBy,
    reason,
    boundAt: boundAtInput
  };
  return idempotentOperation(db, 'strategy-work-bind', idempotencyKey, intent, () => {
    const boundAt = boundAtInput || new Date().toISOString();
    const result = db.prepare(`
      SELECT result.id,result.result_sha256,request.id AS work_request_id,request.request_json,
        request.request_sha256,request.source_state_sha256 AS work_request_source_state_sha256,
        request.work_item_id,item.output_kind,
        revision.id AS strategy_revision_id,revision.application_id,
        revision.plan_sha256,revision.source_state_sha256,revision.source_manifest_json
      FROM application_strategy_work_results result
      JOIN application_strategy_work_requests request ON request.id=result.work_request_id
      JOIN application_strategy_work_items item ON item.id=request.work_item_id
      JOIN application_strategy_revisions revision ON revision.id=item.strategy_revision_id
      WHERE result.id=?
    `).get(resultId);
    if (!result || result.application_id !== applicationId) {
      throw new ApplicationStrategyError('NOT_FOUND', `Accepted strategy result not found for application ${applicationId}`);
    }
    const current = db.prepare('SELECT strategy_revision_id FROM application_strategy_current WHERE application_id=?')
      .get(applicationId);
    if (current?.strategy_revision_id !== result.strategy_revision_id) {
      throw new ApplicationStrategyError('PLAN_NOT_CURRENT', 'Only results from the current strategy may be domain-bound');
    }
    const acceptance = db.prepare(`
      SELECT id FROM application_strategy_work_events
      WHERE work_result_id=? AND event_kind='accepted' ORDER BY id DESC LIMIT 1
    `).get(resultId);
    if (!acceptance) {
      throw new ApplicationStrategyError('RESULT_ACCEPTANCE_REQUIRED', 'A work result must be accepted before domain binding');
    }
    const expectedTarget = OUTPUT_BINDING_TARGETS[result.output_kind];
    if (!expectedTarget) {
      throw new ApplicationStrategyError('BINDING_NOT_REQUIRED', 'Pure analysis completes on acceptance and cannot be domain-bound');
    }
    if (requestedTarget.kind !== expectedTarget.kind) {
      throw new ApplicationStrategyError(
        'BINDING_TARGET_MISMATCH',
        `${result.output_kind} must bind a ${expectedTarget.kind} target`
      );
    }
    const priorSourceStateSha256 = effectiveStrategySourceStateSha256(db, {
      id: result.strategy_revision_id,
      source_state_sha256: result.source_state_sha256
    });
    if (result.work_request_source_state_sha256 !== priorSourceStateSha256) {
      throw new ApplicationStrategyError(
        'WORK_REQUEST_SOURCE_STALE',
        'The accepted work result was produced before the current strategy source checkpoint',
        { expected: priorSourceStateSha256, actual: result.work_request_source_state_sha256 }
      );
    }
    const target = resolveDomainBindingTarget(db, applicationId, requestedTarget.kind, rawTargetId);
    const sourceManifest = JSON.parse(result.source_manifest_json);
    const currentContext = buildApplicationStrategyContext(db, applicationId, sourceManifest.selectors, {
      priorStrategyRevisionId: sourceManifest.priorStrategy?.id || null
    });
    assertBindingCheckpointDeltaAllowed(
      JSON.parse(result.request_json),
      currentContext.sourceManifest,
      requestedTarget.kind,
      target
    );
    if (currentContext.sourceStateSha256 !== expectedCurrentSourceStateSha256) {
      throw new ApplicationStrategyError(
        'SOURCE_STATE_STALE',
        'Current post-domain-write strategy context differs from the binding checkpoint expectation',
        { expected: expectedCurrentSourceStateSha256, actual: currentContext.sourceStateSha256 }
      );
    }
    const existing = db.prepare('SELECT * FROM application_strategy_work_bindings WHERE work_result_id=?')
      .get(resultId);
    if (existing) {
      throw new ApplicationStrategyError(
        'BINDING_CONFLICT',
        'Work result is already bound; replay with its original idempotency key'
      );
    }
    const values = {
      artifact_id: null,
      assessment_id: null,
      material_revision_id: null,
      email_reply_proposal_id: null,
      interview_prep_analysis_id: null,
      material_render_id: null
    };
    values[requestedTarget.column] = rawTargetId;
    const info = db.prepare(`
      INSERT INTO application_strategy_work_bindings(
        work_result_id,application_id,target_kind,artifact_id,assessment_id,
        material_revision_id,email_reply_proposal_id,interview_prep_analysis_id,
        material_render_id,target_digest,bound_by,idempotency_key,intent_sha256,bound_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      resultId, applicationId, requestedTarget.kind, values.artifact_id, values.assessment_id,
      values.material_revision_id, values.email_reply_proposal_id,
      values.interview_prep_analysis_id, values.material_render_id, target.targetDigest,
      boundBy, idempotencyKey, digest(intent), boundAt
    );
    const binding = db.prepare('SELECT * FROM application_strategy_work_bindings WHERE id=?')
      .get(info.lastInsertRowid);
    const checkpointInfo = db.prepare(`
      INSERT INTO application_strategy_source_checkpoint_events(
        application_id,strategy_revision_id,work_request_id,work_result_id,binding_id,
        plan_sha256,work_request_sha256,prior_source_state_sha256,current_source_state_sha256,
        target_kind,target_digest,actor,reason,idempotency_key,intent_sha256,checkpointed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      applicationId, result.strategy_revision_id, result.work_request_id, resultId, binding.id,
      result.plan_sha256, result.request_sha256, priorSourceStateSha256,
      expectedCurrentSourceStateSha256, requestedTarget.kind, target.targetDigest,
      boundBy, reason, idempotencyKey, digest(intent), boundAt
    );
    const checkpoint = db.prepare(`
      SELECT * FROM application_strategy_source_checkpoint_events WHERE id=?
    `).get(checkpointInfo.lastInsertRowid);
    if (priorSourceStateSha256 !== expectedCurrentSourceStateSha256) {
      supersedeOutstandingStrategyRequests(db, {
        strategyRevisionId: result.strategy_revision_id,
        boundWorkRequestId: result.work_request_id,
        currentSourceStateSha256: expectedCurrentSourceStateSha256,
        actor: boundBy,
        checkpointId: checkpoint.id,
        createdAt: boundAt
      });
    }
    return {
      binding: serializeWorkBinding(binding),
      checkpoint: serializeSourceCheckpoint(checkpoint)
    };
  });
}

function getApplicationStrategyReadModel(db, applicationId) {
  const status = getApplicationStrategyStatus(db, applicationId);
  const routingPolicy = status.strategy
    ? validateRoutingPolicy(JSON.parse(
        requirePolicyRevision(db, status.strategy.routingPolicyRevisionId).policy_json
      ))
    : null;
  const history = tableExists(db, 'application_strategy_revisions')
    ? db.prepare(`
        SELECT revision.id,revision.revision_number,revision.parent_revision_id,
          revision.plan_sha256,revision.source_state_sha256,revision.created_at,
          (SELECT decision FROM application_strategy_review_events review
           WHERE review.strategy_revision_id=revision.id ORDER BY review.id DESC LIMIT 1) AS review_decision,
          EXISTS(SELECT 1 FROM application_strategy_current current
                 WHERE current.strategy_revision_id=revision.id) AS is_current
        FROM application_strategy_revisions revision
        WHERE revision.application_id=? ORDER BY revision.revision_number DESC
      `).all(applicationId).map((row) => ({ ...row, is_current: Boolean(row.is_current) }))
    : [];
  return {
    schemaVersion: 'application-strategy-read-model.v1',
    application: status.application,
    strategy: projectSafeStrategy(status.strategy),
    state: status.state,
    counts: status.counts,
    workItems: status.workItems.map((item) => projectSafeWorkItem(
      item,
      routingPolicy?.rules.find((rule) => rule.capability === item.capability) || null
    )),
    history
  };
}

function insertPlanWorkItems(db, strategyRevisionId, workItems, createdAt) {
  const capabilityLookup = db.prepare('SELECT id FROM strategy_capabilities WHERE slug=?');
  const insert = db.prepare(`
    INSERT INTO application_strategy_work_items(
      strategy_revision_id,item_key,position,capability_id,title,goal,priority,
      acceptance_criteria_json,source_refs_json,output_kind,review_gate,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const ids = new Map();
  for (const [index, item] of workItems.entries()) {
    const capability = capabilityLookup.get(item.capability);
    if (!capability) throw new ApplicationStrategyError('UNKNOWN_CAPABILITY', `Unknown strategy capability: ${item.capability}`);
    const info = insert.run(
      strategyRevisionId, item.key, index + 1, capability.id, item.title, item.goal,
      item.priority, stableJson(item.acceptanceCriteria), stableJson(item.sourceRefs),
      item.outputKind, item.reviewGate, createdAt
    );
    ids.set(item.key, Number(info.lastInsertRowid));
  }
  const dependencyInsert = db.prepare(`
    INSERT INTO application_strategy_work_dependencies(work_item_id,depends_on_work_item_id)
    VALUES (?,?)
  `);
  for (const item of workItems) {
    for (const dependency of item.dependsOn) dependencyInsert.run(ids.get(item.key), ids.get(dependency));
  }
}

function deriveWorkItemState(db, item, revision, stalePlan) {
  if (stalePlan) return { ...item, state: 'stale-plan', blockers: ['Strategy source evidence changed'] };
  const current = db.prepare('SELECT strategy_revision_id FROM application_strategy_current WHERE application_id=?').get(revision.application_id);
  if (current?.strategy_revision_id !== revision.id) return { ...item, state: 'superseded', blockers: ['Strategy revision is not current'] };
  const dependencies = item.dependencies || [];
  const unmet = dependencies.filter((dependencyId) => {
    return !completedDependencyResult(db, dependencyId);
  });
  if (unmet.length) return { ...item, state: 'blocked-dependencies', blockers: unmet.map((id) => `Work item ${id} is not accepted`) };
  const request = db.prepare(`
    SELECT request.*,class.slug AS required_model_class
    FROM application_strategy_work_requests request
    JOIN strategy_model_classes class ON class.id=request.required_model_class_id
    WHERE request.work_item_id=? ORDER BY request.attempt_number DESC LIMIT 1
  `).get(item.id);
  if (!request) return { ...item, state: 'ready', blockers: [] };
  const result = db.prepare('SELECT * FROM application_strategy_work_results WHERE work_request_id=?').get(request.id);
  const sourceSuperseded = db.prepare(`
    SELECT id,created_at FROM application_strategy_work_events
    WHERE work_request_id=? AND event_kind='superseded' ORDER BY id DESC LIMIT 1
  `).get(request.id);
  if (sourceSuperseded) {
    return {
      ...item,
      state: 'blocked-source-checkpoint',
      blockers: ['The request predates a later accepted domain-output checkpoint; revise the strategy before retrying'],
      latestRequest: serializeWorkRequest(request),
      ...(result ? { latestResult: serializeWorkResult(result) } : {}),
      sourceSuperseded
    };
  }
  if (!result) return { ...item, state: 'issued', blockers: [], latestRequest: serializeWorkRequest(request) };
  const decision = db.prepare(`
    SELECT * FROM application_strategy_work_events
    WHERE work_result_id=? AND event_kind IN ('accepted','rejected','escalated')
    ORDER BY id DESC LIMIT 1
  `).get(result.id);
  if (!decision) return {
    ...item,
    state: result.result_status === 'blocked' ? 'blocked-result' : 'result-recorded',
    blockers: result.over_budget ? ['Result exceeded its issued budget'] : [],
    latestRequest: serializeWorkRequest(request),
    latestResult: serializeWorkResult(result)
  };
  if (decision.event_kind === 'accepted') {
    if (item.output_kind === 'analysis') {
      return {
        ...item, state: 'completed', blockers: [], latestRequest: serializeWorkRequest(request),
        latestResult: serializeWorkResult(result), decision
      };
    }
    const binding = db.prepare('SELECT * FROM application_strategy_work_bindings WHERE work_result_id=?')
      .get(result.id);
    if (binding) {
      return {
        ...item,
        state: 'completed',
        blockers: [],
        latestRequest: serializeWorkRequest(request),
        latestResult: serializeWorkResult(result),
        decision,
        binding: serializeWorkBinding(binding)
      };
    }
    return {
      ...item,
      state: 'accepted-awaiting-binding',
      blockers: ['Accepted proposal has not been bound to its domain record'],
      latestRequest: serializeWorkRequest(request),
      latestResult: serializeWorkResult(result),
      decision
    };
  }
  if (decision.event_kind === 'escalated') return {
    ...item, state: 'escalation-ready', blockers: [], latestRequest: serializeWorkRequest(request),
    latestResult: serializeWorkResult(result), decision
  };
  return {
    ...item,
    state: 'blocked-revision-required',
    blockers: ['Latest result was rejected; the strategy requires revision'],
    latestRequest: serializeWorkRequest(request),
    latestResult: serializeWorkResult(result),
    decision
  };
}

function completedDependencyResult(db, workItemId) {
  const accepted = db.prepare(`
    SELECT result.id,item.output_kind
    FROM application_strategy_work_events event
    JOIN application_strategy_work_results result ON result.id=event.work_result_id
    JOIN application_strategy_work_requests request ON request.id=result.work_request_id
    JOIN application_strategy_work_items item ON item.id=request.work_item_id
    WHERE event.work_item_id=? AND event.event_kind='accepted'
      AND request.work_item_id=? AND result.result_status='succeeded' AND result.over_budget=0
    ORDER BY event.id DESC LIMIT 1
  `).get(workItemId, workItemId);
  if (!accepted) return null;
  if (accepted.output_kind === 'analysis') return { resultId: accepted.id, binding: null };
  const binding = db.prepare('SELECT * FROM application_strategy_work_bindings WHERE work_result_id=?')
    .get(accepted.id);
  return binding ? { resultId: accepted.id, binding: serializeWorkBinding(binding) } : null;
}

function buildDependencyInputs(db, dependencyIds) {
  return dependencyIds.map((workItemId) => {
    const completed = completedDependencyResult(db, workItemId);
    if (!completed) {
      throw new ApplicationStrategyError(
        'WORK_NOT_READY',
        `Dependency work item ${workItemId} has no completed accepted result`
      );
    }
    const row = db.prepare('SELECT * FROM application_strategy_work_results WHERE id=?')
      .get(completed.resultId);
    const result = validateApplicationStrategyWorkResult(JSON.parse(row.result_json));
    return {
      workItemId,
      resultId: row.id,
      resultSha256: row.result_sha256,
      confidence: row.confidence,
      summary: result.summary,
      claims: result.claims,
      output: result.output || null,
      binding: completed.binding
    };
  });
}

function readWorkItems(db, strategyRevisionId) {
  return db.prepare(`
    SELECT item.*,capability.slug AS capability,capability.effect_kind
    FROM application_strategy_work_items item
    JOIN strategy_capabilities capability ON capability.id=item.capability_id
    WHERE item.strategy_revision_id=? ORDER BY item.position
  `).all(strategyRevisionId).map((row) => ({
    ...row,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json),
    sourceRefs: JSON.parse(row.source_refs_json),
    dependencies: db.prepare(`
      SELECT depends_on_work_item_id FROM application_strategy_work_dependencies
      WHERE work_item_id=? ORDER BY depends_on_work_item_id
    `).all(row.id).map((item) => item.depends_on_work_item_id)
  }));
}

function readWorkItem(db, workItemId) {
  const item = db.prepare(`
    SELECT item.*,capability.slug AS capability,capability.effect_kind
    FROM application_strategy_work_items item
    JOIN strategy_capabilities capability ON capability.id=item.capability_id
    WHERE item.id=?
  `).get(workItemId);
  if (!item) throw new ApplicationStrategyError('NOT_FOUND', `Strategy work item not found: ${workItemId}`);
  return {
    ...item,
    acceptanceCriteria: JSON.parse(item.acceptance_criteria_json),
    sourceRefs: JSON.parse(item.source_refs_json),
    dependencies: db.prepare('SELECT depends_on_work_item_id FROM application_strategy_work_dependencies WHERE work_item_id=? ORDER BY depends_on_work_item_id')
      .all(workItemId).map((row) => row.depends_on_work_item_id)
  };
}

function requireWorkItem(db, workItemId) {
  const item = db.prepare(`
    SELECT item.*,capability.slug AS capability FROM application_strategy_work_items item
    JOIN strategy_capabilities capability ON capability.id=item.capability_id WHERE item.id=?
  `).get(workItemId);
  if (!item) throw new ApplicationStrategyError('NOT_FOUND', `Strategy work item not found: ${workItemId}`);
  return item;
}

function assertStrategyRevisionFresh(db, revision) {
  return currentStrategyRevisionContext(db, revision).sourceStateSha256;
}

function currentStrategyRevisionContext(db, revision) {
  validateStrategyBindingsCurrent(db, revision);
  const current = strategyRevisionSourceContext(db, revision);
  const expectedSourceStateSha256 = effectiveStrategySourceStateSha256(db, revision);
  if (current.sourceStateSha256 !== expectedSourceStateSha256) {
    throw new ApplicationStrategyError('SOURCE_STATE_STALE', 'Strategy source evidence changed; create a new plan revision', {
      expected: expectedSourceStateSha256, actual: current.sourceStateSha256
    });
  }
  return current;
}

function strategyRevisionSourceContext(db, revision) {
  const manifest = JSON.parse(revision.source_manifest_json);
  return buildApplicationStrategyContext(db, revision.application_id, manifest.selectors, {
    priorStrategyRevisionId: manifest.priorStrategy?.id || null
  });
}

function strategyRevisionIsStale(db, revision) {
  try { assertStrategyRevisionFresh(db, revision); return false; }
  catch (error) {
    if (['SOURCE_STATE_STALE', 'SOURCE_NOT_FOUND', 'BINDING_TARGET_STALE',
      'DOMAIN_TARGET_SCOPE_MISMATCH', 'DOMAIN_TARGET_UNAVAILABLE', 'ATTACHMENT_UNVERIFIABLE',
      'ATTACHMENT_BYTES_LIMIT', 'ATTACHMENT_HASH_BUDGET_EXCEEDED',
      'UNSAFE_ATTACHMENT_PATH', 'CONTEXT_BYTES_LIMIT'].includes(error?.code)) return true;
    throw error;
  }
}

function validatePolicyAgainstCatalog(db, policy) {
  if (policy.coordinator.requiredModelClass !== 'frontier') {
    throw new ApplicationStrategyError('FRONTIER_REQUIRED', 'Routing policy coordinator must require the frontier model class');
  }
  const knownCapabilities = new Set(db.prepare('SELECT slug FROM strategy_capabilities').all().map((row) => row.slug));
  for (const rule of policy.rules) {
    if (!knownCapabilities.has(rule.capability)) throw new ApplicationStrategyError('UNKNOWN_CAPABILITY', `Unknown strategy capability: ${rule.capability}`);
    if (['application-strategy', 'application-reconcile'].includes(rule.capability)
      && (rule.minimumModelClass !== 'frontier' || rule.escalationModelClass !== 'frontier')) {
      throw new ApplicationStrategyError('FRONTIER_REQUIRED', `${rule.capability} must remain frontier-routed`);
    }
    if (rule.capability === 'latex-render'
      && (rule.minimumModelClass !== 'deterministic' || rule.escalationModelClass !== 'deterministic')) {
      throw new ApplicationStrategyError('DETERMINISTIC_ROUTE_REQUIRED', 'LaTeX rendering must remain deterministic');
    }
  }
  for (const required of ['execute', 'send-email', 'submit-application', 'external-mutation']) {
    if (!policy.forbiddenEffects.includes(required)) {
      throw new ApplicationStrategyError('UNSAFE_POLICY', `Routing policy must forbid ${required}`);
    }
  }
}

function assertFrontierCoordinatorPolicy(policy, plan) {
  if (policy.coordinator.requiredModelClass !== 'frontier' || plan.coordinator.modelClass !== 'frontier') {
    throw new ApplicationStrategyError('FRONTIER_REQUIRED', 'Application strategy plans require a frontier coordinator');
  }
  if (plan.coordinator.routeAlias !== policy.coordinator.routeAlias) {
    throw new ApplicationStrategyError('COORDINATOR_ROUTE_MISMATCH', 'Plan coordinator route differs from the selected policy');
  }
}

function validatePlanCapabilities(db, plan, policy) {
  const ruleByCapability = new Map(policy.rules.map((rule) => [rule.capability, rule]));
  for (const item of plan.workItems) {
    if (!db.prepare('SELECT 1 FROM strategy_capabilities WHERE slug=?').get(item.capability)) {
      throw new ApplicationStrategyError('UNKNOWN_CAPABILITY', `Unknown strategy capability: ${item.capability}`);
    }
    if (!ruleByCapability.has(item.capability)) {
      throw new ApplicationStrategyError('ROUTE_NOT_FOUND', `Selected policy has no rule for ${item.capability}`);
    }
    const rule = ruleByCapability.get(item.capability);
    const requiredOutputKind = CAPABILITY_OUTPUT_KINDS[item.capability];
    if (item.outputKind !== requiredOutputKind) {
      throw new ApplicationStrategyError(
        'OUTPUT_KIND_MISMATCH',
        `${item.capability} work must produce ${requiredOutputKind}`
      );
    }
    if (item.reviewGate !== rule.reviewMode) {
      throw new ApplicationStrategyError(
        'REVIEW_GATE_MISMATCH',
        `${item.capability} work must use the routing policy review mode ${rule.reviewMode}`
      );
    }
  }
}

const SOURCE_REF_CONFIG = Object.freeze({
  artifact: { selector: 'artifactIds', collection: 'artifacts' },
  snapshot: { selector: 'snapshotIds', collection: 'snapshots' },
  'material-revision': { selector: 'materialRevisionIds', collection: 'materialRevisions' },
  'email-message': { selector: 'emailMessageRefIds', collection: 'emailMessages' },
  interview: { selector: 'interviewIds', collection: 'interviews' },
  'profile-entry': { selector: 'profileEntryIds', collection: 'profileEntries' },
  'story-use': { selector: 'storyUseIds', collection: 'storyUses' }
});

function validatePlanSourceRefs(plan, selectors) {
  const selected = Object.fromEntries(Object.entries(SOURCE_REF_CONFIG).map(([kind, config]) => [
    kind,
    new Set(selectors[config.selector])
  ]));
  for (const item of plan.workItems) {
    for (const ref of item.sourceRefs) {
      if (!selected[ref.kind]?.has(ref.id)) {
        throw new ApplicationStrategyError(
          'WORK_SOURCE_NOT_SELECTED',
          `Work item ${item.key} references unselected source ${ref.kind}:${ref.id}`
        );
      }
    }
  }
}

function selectWorkItemSources(selectedSources, sourceRefs) {
  const identities = new Set(sourceRefs.map((ref) => `${ref.kind}:${ref.id}`));
  return Object.fromEntries(Object.entries(SOURCE_REF_CONFIG).map(([kind, config]) => [
    config.collection,
    (selectedSources[config.collection] || []).filter((row) => identities.has(`${kind}:${row.id}`))
  ]));
}

function buildEmailSummary(db, applicationId) {
  if (!tableExists(db, 'job_email_application_links') || !tableExists(db, 'job_email_message_refs')) {
    return { messageCount: 0, pendingTransitionCount: 0, pendingReplyCount: 0 };
  }
  const messageCount = db.prepare(`SELECT count(DISTINCT message_ref_id) AS count FROM ${activeEmailLinkSource(db)} WHERE application_id=?`).get(applicationId).count;
  const correlationSource = activeEmailCorrelationSource(db);
  const pendingTransitionCount = tableExists(db, 'job_email_transition_proposals') && correlationSource
    ? db.prepare(`
        SELECT count(*) AS count FROM job_email_transition_proposals proposal
        WHERE proposal.application_id=? AND NOT EXISTS (
          SELECT 1 FROM job_email_transition_events event
          WHERE event.proposal_id=proposal.proposal_id AND event.event_kind IN ('rejected','applied')
        ) AND EXISTS (
          SELECT 1 FROM ${correlationSource} correlation
          WHERE correlation.id=proposal.correlation_id
        )
      `).get(applicationId).count
    : 0;
  const pendingReplyCount = tableExists(db, 'job_email_reply_draft_proposals')
    ? db.prepare(`
        SELECT count(*) AS count FROM job_email_reply_draft_proposals proposal
        JOIN ${activeEmailLinkSource(db)} link ON link.message_ref_id=proposal.message_ref_id
        WHERE link.application_id=? AND NOT EXISTS (
          SELECT 1 FROM job_email_reply_draft_events event
          WHERE event.proposal_id=proposal.proposal_id AND event.event_kind='rejected'
        )
      `).get(applicationId).count
    : 0;
  return { messageCount, pendingTransitionCount, pendingReplyCount };
}

function safeMaterialReadiness(db, applicationId) {
  if (!tableExists(db, 'application_preparation_plans')) return null;
  try {
    const { getApplicationReadiness } = require('./application-materials');
    const value = getApplicationReadiness(db, applicationId);
    return {
      ready: Boolean(value.ready),
      canDraft: Boolean(value.canDraft),
      readinessSha256: value.readinessSha256 || null,
      formStateSha256: value.form?.stateSha256 || value.form?.formStateSha256 || null,
      blockerCodes: (value.blockers || []).map((item) => item.code || 'UNKNOWN').sort()
    };
  } catch (error) {
    return { unavailable: true, reason: error?.code || 'READINESS_UNAVAILABLE' };
  }
}

function availableSnapshots(db, application, includeDigestFields = false) {
  if (!tableExists(db, 'opportunity_snapshots')) return [];
  const columns = tableColumns(db, 'opportunity_snapshots');
  const fields = [
    'id', 'opportunity_id', 'job_posting_id', 'observed_url', 'fetched_at', 'parser_name',
    'parser_version', 'raw_sha256', 'normalized_sha256', 'created_at'
  ].filter((column) => columns.has(column));
  if (!fields.includes('id')) return [];
  const rows = [];
  const seen = new Set();
  const add = (values) => {
    for (const row of values) {
      if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
    }
  };
  if (columns.has('opportunity_id') && application.source_opportunity_id) {
    add(db.prepare(`SELECT ${fields.join(',')} FROM opportunity_snapshots WHERE opportunity_id=? ORDER BY id`).all(application.source_opportunity_id));
  }
  if (columns.has('job_posting_id') && tableExists(db, 'application_postings')) {
    add(db.prepare(`
      SELECT ${fields.map((field) => `snapshot.${field}`).join(',')}
      FROM opportunity_snapshots snapshot
      JOIN application_postings link ON link.job_posting_id=snapshot.job_posting_id
      WHERE link.application_id=? ORDER BY snapshot.id
    `).all(application.id));
  }
  if (columns.has('id') && tableExists(db, 'application_artifacts') && tableColumns(db, 'application_artifacts').has('opportunity_snapshot_id')) {
    add(db.prepare(`
      SELECT ${fields.map((field) => `snapshot.${field}`).join(',')}
      FROM opportunity_snapshots snapshot
      JOIN application_artifacts artifact ON artifact.opportunity_snapshot_id=snapshot.id
      WHERE artifact.application_id=? ORDER BY snapshot.id
    `).all(application.id));
  }
  return rows.map((row) => includeDigestFields ? row : pick(row, fields));
}

function selectApplicationSnapshot(db, application, snapshotId) {
  if (!tableExists(db, 'opportunity_snapshots')) sourceNotFound('snapshot', snapshotId);
  const columns = tableColumns(db, 'opportunity_snapshots');
  const fields = [
    'id', 'opportunity_id', 'job_posting_id', 'observed_url', 'fetched_at', 'parser_name',
    'parser_version', 'raw_sha256', 'normalized_sha256', 'normalized_json',
    'normalized_text', 'created_at'
  ].filter((column) => columns.has(column));
  if (!fields.includes('id')) sourceNotFound('snapshot', snapshotId);
  const row = db.prepare(`SELECT ${fields.join(',')} FROM opportunity_snapshots WHERE id=?`).get(snapshotId);
  if (!row) sourceNotFound('snapshot', snapshotId);

  let belongs = Boolean(
    columns.has('opportunity_id')
    && application.source_opportunity_id
    && row.opportunity_id === application.source_opportunity_id
  );
  if (!belongs && columns.has('job_posting_id') && row.job_posting_id && tableExists(db, 'application_postings')) {
    belongs = Boolean(db.prepare(`
      SELECT 1 FROM application_postings WHERE application_id=? AND job_posting_id=?
    `).get(application.id, row.job_posting_id));
  }
  if (!belongs && tableExists(db, 'application_artifacts')
    && tableColumns(db, 'application_artifacts').has('opportunity_snapshot_id')) {
    belongs = Boolean(db.prepare(`
      SELECT 1 FROM application_artifacts
      WHERE application_id=? AND opportunity_snapshot_id=?
    `).get(application.id, snapshotId));
  }
  if (!belongs) sourceNotFound('snapshot', snapshotId);
  return row;
}

function projectSelectedEmailMessage(row) {
  let facts = {};
  try { facts = JSON.parse(row.facts_json); } catch { facts = {}; }
  const projectedFacts = pick(facts, [
    'schemaVersion', 'trust', 'contentCompleteness', 'eventKind', 'company', 'postingRefs',
    'applicationRefs', 'interview', 'requestedAction', 'replyRequested', 'evidence',
    'extraction', 'security'
  ]);
  const projected = {
    id: row.id,
    provider: row.provider,
    accountId: row.account_id,
    messageId: row.message_id,
    threadId: row.thread_id,
    receivedAt: row.received_at,
    fromDomain: row.from_domain,
    contentCompleteness: row.content_completeness,
    eventKind: row.event_kind,
    securityRisk: row.security_risk,
    requiresReview: Boolean(row.requires_review),
    factsDigest: row.facts_digest,
    facts: projectedFacts,
    trust: 'untrusted_external_inert_data'
  };
  return { ...projected, recordSha256: digest(projected) };
}

function hashArtifact(row, attachmentHashBudget = null) {
  const projected = pick(row, [
    'id', 'application_id', 'kind', 'title', 'source_url', 'source_name', 'citation', 'notes',
    'content', 'attachment_path', 'opportunity_snapshot_id', 'captured_at', 'created_at'
  ]);
  return digest({
    ...projected,
    attachmentContentSha256: hashManagedAttachment(row.attachment_path, attachmentHashBudget)
  });
}

function hashProfileEntry(row, attachmentHashBudget = null) {
  const projected = pick(row, [
    'id', 'category', 'title', 'content', 'source', 'source_url', 'evidence', 'attachment_path',
    'recency', 'confidence', 'tags', 'created_at', 'updated_at'
  ]);
  return digest({
    ...projected,
    attachmentContentSha256: hashManagedAttachment(row.attachment_path, attachmentHashBudget)
  });
}

function hashManagedAttachment(relativePath, attachmentHashBudget = null) {
  if (!relativePath) return null;
  const root = path.resolve(process.env.JOBTRACK_HOME || path.join(os.homedir(), '.jobtrack'));
  const absolute = path.resolve(root, String(relativePath));
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new ApplicationStrategyError('UNSAFE_ATTACHMENT_PATH', 'Managed attachment path escapes JOBTRACK_HOME');
  }
  let descriptor;
  try {
    const realRoot = fs.realpathSync(root);
    const realAbsolute = fs.realpathSync(absolute);
    if (realAbsolute !== realRoot && !realAbsolute.startsWith(`${realRoot}${path.sep}`)) {
      throw new ApplicationStrategyError(
        'UNSAFE_ATTACHMENT_PATH',
        'Managed attachment resolves outside JOBTRACK_HOME'
      );
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(absolute, flags);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > MAX_ATTACHMENT_HASH_BYTES) {
      throw new ApplicationStrategyError(
        'ATTACHMENT_BYTES_LIMIT',
        `Selected attachment exceeds ${MAX_ATTACHMENT_HASH_BYTES} bytes`
      );
    }
    if (attachmentHashBudget) {
      attachmentHashBudget.bytes += stat.size;
      if (attachmentHashBudget.bytes > MAX_CONTEXT_ATTACHMENT_HASH_BYTES) {
        throw new ApplicationStrategyError(
          'ATTACHMENT_HASH_BUDGET_EXCEEDED',
          `Selected attachments exceed ${MAX_CONTEXT_ATTACHMENT_HASH_BYTES} total bytes`
        );
      }
    }
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes;
    let total = 0;
    do {
      bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      total += bytes;
      if (total > MAX_ATTACHMENT_HASH_BYTES) {
        throw new ApplicationStrategyError(
          'ATTACHMENT_BYTES_LIMIT',
          `Selected attachment exceeds ${MAX_ATTACHMENT_HASH_BYTES} bytes while reading`
        );
      }
      if (bytes) hash.update(buffer.subarray(0, bytes));
    } while (bytes);
    return hash.digest('hex');
  } catch (error) {
    if (error instanceof ApplicationStrategyError) throw error;
    throw new ApplicationStrategyError(
      'ATTACHMENT_UNVERIFIABLE',
      `Selected managed attachment could not be verified (${error.code || 'invalid'})`
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function strategyContextSafety() {
  return {
    externalTextIsInertData: true,
    sourceExpansionForbidden: true,
    credentialsForbidden: true,
    protectedAnswersExcluded: true,
    externalActionsAllowed: false,
    proposalOnly: true
  };
}

function boundedStrategyContext(context) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(context), 'utf8'); }
  catch {
    throw new ApplicationStrategyError('CONTEXT_ENCODING_ERROR', 'Strategy context must contain JSON-safe source data');
  }
  if (bytes > MAX_CONTEXT_BYTES) {
    throw new ApplicationStrategyError(
      'CONTEXT_BYTES_LIMIT',
      `Strategy context exceeds the ${MAX_CONTEXT_BYTES}-byte safety limit`,
      { bytes, limit: MAX_CONTEXT_BYTES }
    );
  }
  return context;
}

function normalizeSelectorsForWrite(value) {
  const selectors = value || {};
  rejectUnknownKeys(selectors, [...SELECTOR_KEYS], 'strategy selectors');
  return Object.fromEntries(SELECTOR_KEYS.map((key) => [key, normalizeIdList(selectors[key], key)]));
}

function normalizeIdList(value, label) {
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : String(value).split(',');
  const ids = values.map((item) => positiveId(String(item).trim(), label));
  if (new Set(ids).size !== ids.length) throw new ApplicationStrategyError('VALIDATION_ERROR', `${label} contains duplicate IDs`);
  return ids.sort((left, right) => left - right);
}

function latestPolicyReview(db, policyRevisionId) {
  return db.prepare('SELECT * FROM strategy_routing_policy_review_events WHERE policy_revision_id=? ORDER BY id DESC LIMIT 1').get(policyRevisionId) || null;
}

function latestStrategyReview(db, strategyRevisionId) {
  return db.prepare('SELECT * FROM application_strategy_review_events WHERE strategy_revision_id=? ORDER BY id DESC LIMIT 1').get(strategyRevisionId) || null;
}

function requirePolicyRevision(db, id) {
  const row = db.prepare('SELECT * FROM strategy_routing_policy_revisions WHERE id=?').get(id);
  if (!row) throw new ApplicationStrategyError('NOT_FOUND', `Strategy routing policy revision not found: ${id}`);
  return row;
}

function requireStrategyRevision(db, id, expectedApplicationId = null) {
  const row = db.prepare('SELECT * FROM application_strategy_revisions WHERE id=?').get(id);
  if (!row || (expectedApplicationId !== null && row.application_id !== expectedApplicationId)) {
    throw new ApplicationStrategyError('NOT_FOUND', `Application strategy revision not found: ${id}`);
  }
  return row;
}

function serializePolicyRevision(row) {
  return { ...row, policy: validateRoutingPolicy(JSON.parse(row.policy_json)) };
}

function serializeStrategyRevision(row) {
  return {
    id: row.id,
    applicationId: row.application_id,
    revisionNumber: row.revision_number,
    parentRevisionId: row.parent_revision_id,
    routingPolicyRevisionId: row.routing_policy_revision_id,
    sourceStateSha256: row.source_state_sha256,
    planSha256: row.plan_sha256,
    plan: validateApplicationStrategyPlan(JSON.parse(row.plan_json)),
    coordinator: {
      runId: row.coordinator_run_id,
      routeAlias: row.coordinator_route_alias,
      modelClass: 'frontier',
      provider: row.coordinator_provider,
      model: row.coordinator_model,
      modelVersion: row.coordinator_model_version
    },
    createdAt: row.created_at
  };
}

function serializeWorkRequest(row) {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    strategyRevisionId: row.strategy_revision_id,
    routingPolicyRevisionId: row.routing_policy_revision_id,
    attemptNumber: row.attempt_number,
    routeAlias: row.route_alias,
    requiredModelClass: row.required_model_class || null,
    sourceStateSha256: row.source_state_sha256,
    budgets: {
      maxInputTokens: row.max_input_tokens,
      maxOutputTokens: row.max_output_tokens,
      maxCostMicros: row.max_cost_micros,
      maxDurationMs: row.max_duration_ms
    },
    request: JSON.parse(row.request_json),
    requestSha256: row.request_sha256,
    issuedBy: row.issued_by,
    createdAt: row.created_at
  };
}

function serializeWorkResult(row) {
  return {
    id: row.id,
    workRequestId: row.work_request_id,
    status: row.result_status,
    overBudget: Boolean(row.over_budget),
    confidence: row.confidence,
    resultSha256: row.result_sha256,
    result: JSON.parse(row.result_json),
    createdAt: row.created_at
  };
}

function getWorkResult(db, resultId) {
  const row = db.prepare('SELECT * FROM application_strategy_work_results WHERE id=?').get(resultId);
  if (!row) throw new ApplicationStrategyError('NOT_FOUND', `Strategy work result not found: ${resultId}`);
  return serializeWorkResult(row);
}

function resolveDomainBindingTarget(db, applicationId, kind, targetId) {
  if (kind === 'artifact') {
    requireTargetTable(db, 'application_artifacts', kind);
    const row = db.prepare('SELECT * FROM application_artifacts WHERE id=? AND application_id=?')
      .get(targetId, applicationId);
    if (!row) domainTargetNotFound(kind, targetId, applicationId);
    if (row.kind !== 'research') {
      throw new ApplicationStrategyError(
        'BINDING_TARGET_MISMATCH',
        'Company-research work must bind an application artifact whose kind is research'
      );
    }
    return { targetDigest: hashArtifact(row), targetId: row.id, artifactKind: row.kind };
  }
  if (kind === 'assessment') {
    requireTargetTable(db, 'application_assessments', kind);
    const row = db.prepare('SELECT * FROM application_assessments WHERE id=? AND application_id=?')
      .get(targetId, applicationId);
    if (!row) domainTargetNotFound(kind, targetId, applicationId);
    return { targetDigest: digest(row), targetId: row.id };
  }
  if (kind === 'material-revision') {
    requireTargetTable(db, 'application_material_revisions', kind);
    requireTargetTable(db, 'application_materials', kind);
    const row = db.prepare(`
      SELECT revision.*,material.application_id,material.material_kind_id,material.form_field_id
      FROM application_material_revisions revision
      JOIN application_materials material ON material.id=revision.material_id
      WHERE revision.id=? AND material.application_id=?
    `).get(targetId, applicationId);
    if (!row) domainTargetNotFound(kind, targetId, applicationId);
    return { targetDigest: digest(row), targetId: row.id };
  }
  if (kind === 'email-reply-proposal') {
    requireTargetTable(db, 'job_email_reply_draft_proposals', kind);
    requireTargetTable(db, 'job_email_application_links', kind);
    const row = db.prepare('SELECT * FROM job_email_reply_draft_proposals WHERE proposal_id=?')
      .get(targetId);
    if (!row) domainTargetNotFound(kind, targetId, applicationId);
    const applicationIds = db.prepare(`
      SELECT DISTINCT application_id FROM ${activeEmailLinkSource(db)}
      WHERE message_ref_id=? ORDER BY application_id
    `).all(row.message_ref_id).map((item) => item.application_id);
    if (applicationIds.length !== 1 || applicationIds[0] !== applicationId) {
      domainTargetNotFound(kind, targetId, applicationId);
    }
    return {
      targetDigest: sha256Value(row.proposal_digest, 'email reply proposal digest'),
      targetId: row.proposal_id,
      messageRefId: row.message_ref_id
    };
  }
  if (kind === 'interview-prep-analysis') {
    requireTargetTable(db, 'interview_prep_analyses', kind);
    requireTargetTable(db, 'interviews', kind);
    const row = db.prepare(`
      SELECT analysis.*,interview.application_id
      FROM interview_prep_analyses analysis
      JOIN interviews interview ON interview.id=analysis.interview_id
      WHERE analysis.id=? AND interview.application_id=?
    `).get(targetId, applicationId);
    if (!row) domainTargetNotFound(kind, targetId, applicationId);
    return { targetDigest: digest(row), targetId: row.id, interviewId: row.interview_id };
  }
  if (kind === 'material-render') {
    requireTargetTable(db, 'application_material_renders', kind);
    const row = db.prepare('SELECT * FROM application_material_renders WHERE id=? AND application_id=?')
      .get(targetId, applicationId);
    if (!row) domainTargetNotFound(kind, targetId, applicationId);
    try {
      const { assertMaterialRenderIntegrity } = require('./application-materials');
      const integrity = assertMaterialRenderIntegrity(db, targetId, applicationId);
      return {
        targetDigest: sha256Value(integrity.actualSha256, 'material render output digest'),
        targetId: integrity.render.id,
        revisionId: integrity.render.revision_id
      };
    } catch (error) {
      throw new ApplicationStrategyError(
        'DOMAIN_TARGET_INTEGRITY_MISMATCH',
        `material-render target ${targetId} failed managed PDF integrity verification`,
        { cause: error?.code || error?.name || 'UNKNOWN' }
      );
    }
  }
  throw new ApplicationStrategyError('BINDING_TARGET_MISMATCH', `Unsupported strategy binding target: ${kind}`);
}

function validateStrategyBindingsCurrent(db, revision) {
  const bindings = db.prepare(`
    SELECT binding.*
    FROM application_strategy_work_bindings binding
    JOIN application_strategy_work_results result ON result.id=binding.work_result_id
    JOIN application_strategy_work_requests request ON request.id=result.work_request_id
    WHERE request.strategy_revision_id=?
    ORDER BY binding.id
  `).all(revision.id);
  for (const binding of bindings) {
    let currentTarget;
    try {
      currentTarget = resolveDomainBindingTarget(
        db,
        revision.application_id,
        binding.target_kind,
        bindingTargetValue(binding)
      );
    } catch (error) {
      if (['DOMAIN_TARGET_SCOPE_MISMATCH', 'DOMAIN_TARGET_UNAVAILABLE',
        'ATTACHMENT_UNVERIFIABLE', 'ATTACHMENT_BYTES_LIMIT',
        'ATTACHMENT_HASH_BUDGET_EXCEEDED', 'UNSAFE_ATTACHMENT_PATH',
        'DOMAIN_TARGET_INTEGRITY_MISMATCH'].includes(error?.code)) {
        throw new ApplicationStrategyError(
          'BINDING_TARGET_STALE',
          `Bound ${binding.target_kind} target ${bindingTargetValue(binding)} is no longer verifiable`,
          { bindingId: binding.id, cause: error.code }
        );
      }
      throw error;
    }
    if (currentTarget.targetDigest !== binding.target_digest) {
      throw new ApplicationStrategyError(
        'BINDING_TARGET_STALE',
        `Bound ${binding.target_kind} target ${bindingTargetValue(binding)} changed after checkpoint`,
        {
          bindingId: binding.id,
          expected: binding.target_digest,
          actual: currentTarget.targetDigest
        }
      );
    }
  }
}

function requireTargetTable(db, table, kind) {
  if (!tableExists(db, table)) {
    throw new ApplicationStrategyError(
      'DOMAIN_TARGET_UNAVAILABLE',
      `The ${kind} domain target is not available in this JobTrack store`
    );
  }
}

function domainTargetNotFound(kind, targetId, applicationId) {
  throw new ApplicationStrategyError(
    'DOMAIN_TARGET_SCOPE_MISMATCH',
    `${kind} target ${targetId} does not belong exclusively to application ${applicationId}`
  );
}

function bindingTargetValue(row) {
  return row.artifact_id ?? row.assessment_id ?? row.material_revision_id
    ?? row.email_reply_proposal_id ?? row.interview_prep_analysis_id ?? row.material_render_id;
}

function serializeWorkBinding(row) {
  return {
    id: row.id,
    workResultId: row.work_result_id,
    applicationId: row.application_id,
    targetKind: row.target_kind,
    targetId: bindingTargetValue(row),
    targetDigest: row.target_digest,
    boundBy: row.bound_by,
    boundAt: row.bound_at,
    createdAt: row.created_at
  };
}

function serializeSourceCheckpoint(row) {
  return {
    id: row.id,
    applicationId: row.application_id,
    strategyRevisionId: row.strategy_revision_id,
    workRequestId: row.work_request_id,
    workResultId: row.work_result_id,
    bindingId: row.binding_id,
    planSha256: row.plan_sha256,
    workRequestSha256: row.work_request_sha256,
    priorSourceStateSha256: row.prior_source_state_sha256,
    currentSourceStateSha256: row.current_source_state_sha256,
    targetKind: row.target_kind,
    targetDigest: row.target_digest,
    actor: row.actor,
    reason: row.reason,
    checkpointedAt: row.checkpointed_at,
    createdAt: row.created_at
  };
}

function effectiveStrategySourceStateSha256(db, revision) {
  return db.prepare(`
    SELECT current_source_state_sha256 FROM application_strategy_source_checkpoint_events
    WHERE strategy_revision_id=? ORDER BY id DESC LIMIT 1
  `).get(revision.id)?.current_source_state_sha256 || revision.source_state_sha256;
}

function assertBindingCheckpointDeltaAllowed(request, currentManifest, targetKind, target) {
  const baseline = request?.sourceManifest;
  if (!baseline || digest(baseline) !== request.sourceStateSha256) {
    throw new ApplicationStrategyError(
      'WORK_REQUEST_MANIFEST_INVALID',
      'The issued work request does not carry its exact source-state manifest'
    );
  }
  for (const key of ['priorStrategy', 'selectors', 'selectedSourceDigests']) {
    if (stableJson(baseline[key] ?? null) !== stableJson(currentManifest[key] ?? null)) {
      throw new ApplicationStrategyError(
        'CHECKPOINT_DELTA_OUT_OF_SCOPE',
        `Binding checkpoint cannot absorb a concurrent change to ${key}`,
        { changedSection: key, targetKind }
      );
    }
  }
  assertBindingApplicationDeltaAllowed(
    baseline.application || {},
    currentManifest.application || {},
    targetKind
  );
  const allowedDomainKeys = new Set({
    artifact: [],
    assessment: ['assessment'],
    'material-revision': ['materialReadiness'],
    'email-reply-proposal': ['email'],
    'interview-prep-analysis': [],
    'material-render': ['materialReadiness']
  }[targetKind] || []);
  const beforeDomain = baseline.domainState || {};
  const afterDomain = currentManifest.domainState || {};
  if (targetKind === 'assessment' && afterDomain.assessment?.id !== target.targetId) {
    throw new ApplicationStrategyError(
      'CHECKPOINT_DELTA_OUT_OF_SCOPE',
      `Assessment checkpoint target ${target.targetId} is not the current application assessment`
    );
  }
  if (targetKind === 'email-reply-proposal') {
    assertEmailCheckpointDelta(beforeDomain.email || {}, afterDomain.email || {});
  }
  for (const key of new Set([...Object.keys(beforeDomain), ...Object.keys(afterDomain)])) {
    if (allowedDomainKeys.has(key)) continue;
    if (stableJson(beforeDomain[key] ?? null) !== stableJson(afterDomain[key] ?? null)) {
      throw new ApplicationStrategyError(
        'CHECKPOINT_DELTA_OUT_OF_SCOPE',
        `Binding checkpoint cannot absorb a concurrent ${key} domain change`,
        { changedSection: `domainState.${key}`, targetKind }
      );
    }
  }
}

function assertBindingApplicationDeltaAllowed(before, after, targetKind) {
  if (stableJson(before) === stableJson(after)) return;
  const mayTouchApplication = targetKind === 'artifact' || targetKind === 'assessment';
  const allowedKeys = mayTouchApplication
    ? new Set(['workflow_stage', 'lock_version', 'updated_at'])
    : new Set();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (allowedKeys.has(key)) continue;
    if (stableJson(before[key] ?? null) !== stableJson(after[key] ?? null)) {
      throw new ApplicationStrategyError(
        'CHECKPOINT_DELTA_OUT_OF_SCOPE',
        `Binding checkpoint cannot absorb a concurrent application.${key} change`,
        { changedSection: `application.${key}`, targetKind }
      );
    }
  }
  if (!mayTouchApplication
    || !Number.isSafeInteger(before.lock_version)
    || after.lock_version !== before.lock_version + 1) {
    throw new ApplicationStrategyError(
      'CHECKPOINT_DELTA_OUT_OF_SCOPE',
      'Binding checkpoint cannot absorb an unrelated application revision change',
      { changedSection: 'application.lock_version', targetKind }
    );
  }
  const workflowAllowed = targetKind === 'assessment'
    ? after.workflow_stage === 'assessment_ready'
    : after.workflow_stage === before.workflow_stage
      || (['discovered', 'prospective'].includes(before.workflow_stage)
        && after.workflow_stage === 'researched');
  if (!workflowAllowed) {
    throw new ApplicationStrategyError(
      'CHECKPOINT_DELTA_OUT_OF_SCOPE',
      'Binding checkpoint cannot absorb an unrelated workflow-stage transition',
      { changedSection: 'application.workflow_stage', targetKind }
    );
  }
}

function assertEmailCheckpointDelta(before, after) {
  const integer = (value) => Number.isSafeInteger(value) && value >= 0;
  const beforeMessages = before.messageCount;
  const afterMessages = after.messageCount;
  const beforeReplies = before.pendingReplyCount;
  const afterReplies = after.pendingReplyCount;
  if (![beforeMessages, afterMessages, beforeReplies, afterReplies].every(integer)
    || after.pendingTransitionCount !== before.pendingTransitionCount
    || afterMessages < beforeMessages || afterMessages > beforeMessages + 1
    || afterReplies < beforeReplies || afterReplies > beforeReplies + 1) {
    throw new ApplicationStrategyError(
      'CHECKPOINT_DELTA_OUT_OF_SCOPE',
      'Email reply checkpoint includes changes beyond one target message/proposal',
      { changedSection: 'domainState.email', targetKind: 'email-reply-proposal' }
    );
  }
}

function supersedeOutstandingStrategyRequests(db, input) {
  const rows = db.prepare(`
    SELECT request.id,request.work_item_id,result.id AS work_result_id
    FROM application_strategy_work_requests request
    JOIN application_strategy_work_items item ON item.id=request.work_item_id
    LEFT JOIN application_strategy_work_results result ON result.work_request_id=request.id
    WHERE request.strategy_revision_id=?
      AND request.id<>?
      AND request.source_state_sha256<>?
      AND NOT EXISTS (
        SELECT 1 FROM application_strategy_work_events superseded
        WHERE superseded.work_request_id=request.id AND superseded.event_kind='superseded'
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM application_strategy_work_events decision
          WHERE decision.work_result_id=result.id
            AND decision.event_kind IN ('accepted','rejected','escalated')
        )
        OR (
          item.output_kind<>'analysis'
          AND EXISTS (
            SELECT 1 FROM application_strategy_work_events accepted
            WHERE accepted.work_result_id=result.id AND accepted.event_kind='accepted'
          )
          AND NOT EXISTS (
            SELECT 1 FROM application_strategy_work_bindings binding
            WHERE binding.work_result_id=result.id
          )
        )
      )
    ORDER BY request.id
  `).all(
    input.strategyRevisionId,
    input.boundWorkRequestId,
    input.currentSourceStateSha256
  );
  for (const row of rows) {
    insertWorkEvent(db, {
      workItemId: row.work_item_id,
      workRequestId: row.id,
      workResultId: row.work_result_id || null,
      eventKind: 'superseded',
      actor: input.actor,
      notes: `Superseded by strategy source checkpoint ${input.checkpointId}`,
      createdAt: input.createdAt
    });
  }
}

function projectSafeWorkItem(item, routeRule = null) {
  const projected = pick(item, [
    'id', 'item_key', 'position', 'capability', 'effect_kind', 'priority', 'output_kind',
    'review_gate', 'dependencies', 'state', 'blockers', 'binding'
  ]);
  projected.proposalTextRedacted = true;
  if (routeRule) {
    projected.routing = {
      requestId: null,
      attemptNumber: null,
      routeAlias: routeRule.defaultRouteAlias,
      requiredModelClass: routeRule.minimumModelClass,
      escalationModelClass: routeRule.escalationModelClass,
      maxAttempts: routeRule.maxAttempts,
      budgets: routeRule.budgets
    };
  }
  if (item.latestRequest) {
    projected.routing = {
      ...(projected.routing || {}),
      requestId: item.latestRequest.id,
      attemptNumber: item.latestRequest.attemptNumber,
      routeAlias: item.latestRequest.routeAlias,
      requiredModelClass: item.latestRequest.requiredModelClass
        || item.latestRequest.request?.routing?.requiredModelClass
        || null,
      budgets: item.latestRequest.budgets
    };
  }
  projected.resultState = {
    status: 'not-recorded',
    reviewRequiredAs: item.review_gate,
    reviewDecision: null,
    reviewAuthority: null
  };
  if (item.latestResult) {
    const declaredWorker = item.latestResult.result?.worker || null;
    projected.resultState = {
      resultId: item.latestResult.id,
      status: item.latestResult.status,
      overBudget: item.latestResult.overBudget,
      confidence: item.latestResult.confidence,
      resultSha256: item.latestResult.resultSha256,
      reviewDecision: item.decision?.event_kind || null,
      reviewAuthority: item.decision?.review_authority || null,
      worker: declaredWorker ? {
        routeAlias: declaredWorker.routeAlias,
        modelClass: declaredWorker.modelClass,
        provider: declaredWorker.provider,
        model: declaredWorker.model,
        provenanceTrust: 'declared-unverified'
      } : null
    };
  }
  return projected;
}

function projectSafeStrategy(strategy) {
  if (!strategy) return null;
  return {
    id: strategy.id,
    applicationId: strategy.applicationId,
    revisionNumber: strategy.revisionNumber,
    parentRevisionId: strategy.parentRevisionId,
    routingPolicyRevisionId: strategy.routingPolicyRevisionId,
    sourceStateSha256: strategy.sourceStateSha256,
    currentSourceStateSha256: strategy.currentSourceStateSha256,
    observedCurrentSourceStateSha256: strategy.observedCurrentSourceStateSha256,
    planSha256: strategy.planSha256,
    coordinator: {
      routeAlias: strategy.coordinator.routeAlias,
      modelClass: strategy.coordinator.modelClass,
      provenanceTrust: 'declared-unverified'
    },
    plan: {
      schemaVersion: strategy.plan.schemaVersion,
      trust: strategy.plan.trust,
      workItemCount: strategy.plan.workItems.length,
      proposalTextRedacted: true
    },
    review: strategy.review ? {
      id: strategy.review.id,
      decision: strategy.review.decision,
      reviewedAt: strategy.review.reviewed_at
    } : null,
    routingPolicyReview: strategy.routingPolicyReview ? {
      id: strategy.routingPolicyReview.id,
      decision: strategy.routingPolicyReview.decision,
      reviewedAt: strategy.routingPolicyReview.reviewed_at
    } : null,
    selectedAt: strategy.selectedAt,
    selectionLockVersion: strategy.selectionLockVersion,
    sourceCheckpoint: strategy.sourceCheckpoint ? {
      id: strategy.sourceCheckpoint.id,
      bindingId: strategy.sourceCheckpoint.bindingId,
      priorSourceStateSha256: strategy.sourceCheckpoint.priorSourceStateSha256,
      currentSourceStateSha256: strategy.sourceCheckpoint.currentSourceStateSha256,
      targetKind: strategy.sourceCheckpoint.targetKind,
      targetDigest: strategy.sourceCheckpoint.targetDigest,
      checkpointedAt: strategy.sourceCheckpoint.checkpointedAt
    } : null,
    isStale: strategy.isStale
  };
}

function insertWorkEvent(db, input) {
  db.prepare(`
    INSERT INTO application_strategy_work_events(
      work_item_id,work_request_id,work_result_id,event_kind,actor,review_authority,
      notes,idempotency_key,intent_sha256,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    input.workItemId, input.workRequestId || null, input.workResultId || null,
    input.eventKind, input.actor, input.reviewAuthority || null, input.notes || null,
    input.idempotencyKey || null,
    input.intentSha256 || null, input.createdAt || new Date().toISOString()
  );
}

function idempotentOperation(db, command, idempotencyKey, intent, action) {
  const intentSha256 = digest(intent);
  const execute = () => {
    const existing = db.prepare('SELECT * FROM application_strategy_operations WHERE idempotency_key=?').get(idempotencyKey);
    if (existing) {
      if (existing.command !== command || existing.intent_sha256 !== intentSha256) {
        throw new ApplicationStrategyError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for different strategy inputs');
      }
      return JSON.parse(existing.result_json);
    }
    const result = action();
    db.prepare(`
      INSERT INTO application_strategy_operations(idempotency_key,command,intent_sha256,result_json)
      VALUES (?,?,?,?)
    `).run(idempotencyKey, command, intentSha256, stableJson(result));
    return result;
  };
  return db.inTransaction ? execute() : db.transaction(execute).immediate();
}

function requireSchema(db) {
  const row = tableExists(db, 'jobtrack_schema_migrations')
    ? db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?').get(APPLICATION_STRATEGY_SCHEMA_VERSION)
    : null;
  if (!row || row.name !== APPLICATION_STRATEGY_MIGRATION_NAME) {
    throw new ApplicationStrategyError('SCHEMA_REQUIRED', 'Run migrateApplicationStrategy before using strategy operations');
  }
}

function seedRows(db, table, columns, rows) {
  const placeholders = columns.map(() => '?').join(',');
  const statement = db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`);
  for (const row of rows) statement.run(...row);
}

function assertSeedCatalog(db) {
  for (const [slug, label, rank] of MODEL_CLASS_ROWS) {
    const row = db.prepare('SELECT label,rank FROM strategy_model_classes WHERE slug=?').get(slug);
    if (!row || row.label !== label || row.rank !== rank) {
      throw new ApplicationStrategyError(
        'MIGRATION_CONFLICT',
        `Strategy model class ${slug} conflicts with migration ${APPLICATION_STRATEGY_SCHEMA_VERSION}`
      );
    }
  }
  for (const [slug, label, effectKind] of CAPABILITIES) {
    const row = db.prepare('SELECT label,effect_kind FROM strategy_capabilities WHERE slug=?').get(slug);
    if (!row || row.label !== label || row.effect_kind !== effectKind) {
      throw new ApplicationStrategyError(
        'MIGRATION_CONFLICT',
        `Strategy capability ${slug} conflicts with migration ${APPLICATION_STRATEGY_SCHEMA_VERSION}`
      );
    }
  }
}

function createAppendOnlyTriggers(db, table) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_append_only_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT,'${table} is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_append_only_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT,'${table} is append-only'); END;
  `);
}

function modelClassRow(db, slug) {
  const row = db.prepare('SELECT * FROM strategy_model_classes WHERE slug=?').get(slug);
  if (!row) throw new ApplicationStrategyError('UNKNOWN_MODEL_CLASS', `Unknown strategy model class: ${slug}`);
  return row;
}

function modelClassRank(value) {
  const order = new Map([['deterministic', 0], ['economy', 10], ['strong', 20], ['frontier', 30]]);
  if (!order.has(value)) throw new ApplicationStrategyError('UNKNOWN_MODEL_CLASS', `Unknown strategy model class: ${value}`);
  return order.get(value);
}

function sourceDomainState(domainState) {
  const { currentStrategy: _currentStrategy, ...sourceState } = domainState;
  return sourceState;
}

function sourceNotFound(kind, id) {
  throw new ApplicationStrategyError('SOURCE_NOT_FOUND', `Selected ${kind} ${id} does not belong to this application`);
}

function stale(label, expected, actual) {
  throw new ApplicationStrategyError('STALE_EXPECTATION', `Expected ${label} ${expected ?? 'none'}, found ${actual ?? 'none'}`, { expected, actual });
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function activeEmailLinkSource(db) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name='active_job_email_application_links'").get()
    ? 'active_job_email_application_links'
    : 'job_email_application_links';
}

function activeEmailCorrelationSource(db) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name='active_job_email_linked_correlations'").get()) {
    return 'active_job_email_linked_correlations';
  }
  return tableExists(db, 'job_email_correlations') ? 'job_email_correlations' : null;
}

function tableColumns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function rejectUnknownKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApplicationStrategyError('VALIDATION_ERROR', `${label} must be an object`);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw new ApplicationStrategyError('VALIDATION_ERROR', `${label} has unknown fields: ${unknown.sort().join(', ')}`);
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
}

function positiveId(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new ApplicationStrategyError('VALIDATION_ERROR', `${label} must be a positive integer`);
  return number;
}

function nullableExpectedId(value, label) {
  if (value === null || value === 'none') return null;
  if (value === undefined || value === '') throw new ApplicationStrategyError('VALIDATION_ERROR', `${label} is required; use none when no value is current`);
  return positiveId(value, label);
}

function boundedText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new ApplicationStrategyError('VALIDATION_ERROR', `${label} must contain 1 to ${max} printable characters`);
  }
  return value.trim();
}

function optionalBoundedText(value, label, max) {
  return value === undefined || value === null || value === '' ? null : boundedText(String(value), label, max);
}

function enumeration(value, allowed, label) {
  if (!allowed.has(value)) throw new ApplicationStrategyError('VALIDATION_ERROR', `${label} has an unsupported value`);
  return value;
}

function idempotencyKeyValue(value) {
  return boundedText(value, 'idempotencyKey', 500);
}

function sha256Value(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new ApplicationStrategyError('VALIDATION_ERROR', `${label} must be a lowercase SHA-256 digest`);
  return value;
}

function isoTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ApplicationStrategyError('VALIDATION_ERROR', `${label} must be an ISO-8601 timestamp`);
  }
  return value;
}

module.exports = {
  APPLICATION_STRATEGY_SCHEMA_VERSION,
  APPLICATION_STRATEGY_MIGRATION_NAME,
  APPLICATION_STRATEGY_USER_VERSION,
  ApplicationStrategyError,
  migrateApplicationStrategy,
  buildApplicationStrategyContext,
  importRoutingPolicy,
  reviewRoutingPolicy,
  selectRoutingPolicy,
  getCurrentRoutingPolicy,
  importApplicationStrategyPlan,
  reviewApplicationStrategyPlan,
  selectApplicationStrategyPlan,
  getApplicationStrategyRevision,
  getApplicationStrategyStatus,
  listApplicationStrategyQueue,
  issueApplicationStrategyWork,
  recordApplicationStrategyWorkResult,
  reviewApplicationStrategyWorkResult,
  bindApplicationStrategyWorkResult,
  getApplicationStrategyReadModel
};
