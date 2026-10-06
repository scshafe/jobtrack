'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { requestWakeQuietly } = require('./fabric-wake');
const {
  syncLegacyApplicationCatalog,
  syncLegacyOpportunityCatalog
} = require('./catalog-command');

const OPPORTUNITY_SCHEMA_VERSION = 2026071702;
const OPPORTUNITY_HARDENING_SCHEMA_VERSION = 2026071705;
const OPPORTUNITY_PROVENANCE_SCHEMA_VERSION = 2026071707;

const SOURCE_ADAPTERS = new Set(['manual', 'greenhouse', 'lever', 'ashby', 'rss', 'remoteok', 'hn', 'api', 'web']);
const SOURCE_POLICY_STATES = new Set(['unreviewed', 'allowed', 'blocked']);
const RUN_STATUSES = new Set(['running', 'succeeded', 'partial', 'failed']);
const OPPORTUNITY_STATES = new Set(['inbox', 'shortlisted', 'watching', 'dismissed', 'promoted', 'closed']);
const TRIAGE_DECISIONS = new Set(['shortlist', 'watch', 'dismiss', 'revisit', 'note']);
const TRACKING_PARAMETERS = new Set(['gclid', 'dclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid']);
const SECRET_KEY_PATTERN = /(?:^|_)(?:api_?key|secret|password|passwd|token|authorization|cookie|credential)(?:$|_)/i;
const PROVIDER_BOUND_ADAPTERS = new Set(['ashby', 'greenhouse', 'lever', 'remoteok']);
const SORTS = {
  score: '(ts.score IS NULL) ASC, ts.score DESC, datetime(o.last_seen_at) DESC, o.id DESC',
  freshness: 'datetime(o.last_seen_at) DESC, o.id DESC',
  posted: '(o.posted_at IS NULL) ASC, datetime(o.posted_at) DESC, o.id DESC',
  company: 'lower(o.company_name) ASC, lower(o.title) ASC, o.id ASC',
  title: 'lower(o.title) ASC, lower(o.company_name) ASC, o.id ASC'
};
const DISCOVERY_SOURCE_FLAGS = {
  add: ['key', 'sourceKey', 'adapter', 'label', 'baseUrl', 'url', 'config', 'configJson', 'enabled', 'policyState', 'termsUrl', 'attributionText', 'attribution', 'minIntervalSeconds', 'freshnessTtlHours'],
  update: ['id', 'sourceId', 'key', 'sourceKey', 'adapter', 'label', 'baseUrl', 'url', 'config', 'configJson', 'enabled', 'policyState', 'termsUrl', 'attributionText', 'attribution', 'minIntervalSeconds', 'freshnessTtlHours'],
  edit: ['id', 'sourceId', 'key', 'sourceKey', 'adapter', 'label', 'baseUrl', 'url', 'config', 'configJson', 'enabled', 'policyState', 'termsUrl', 'attributionText', 'attribution', 'minIntervalSeconds', 'freshnessTtlHours'],
  enable: ['id', 'sourceId', 'key', 'sourceKey'],
  disable: ['id', 'sourceId', 'key', 'sourceKey'],
  show: ['id', 'sourceId', 'key', 'sourceKey'],
  list: ['enabled', 'adapter', 'policyState']
};
const DISCOVERY_QUERY_FLAGS = {
  add: ['key', 'queryKey', 'name', 'criteria', 'criteriaJson', 'enabled'],
  update: ['id', 'queryId', 'key', 'queryKey', 'name', 'criteria', 'criteriaJson', 'enabled'],
  edit: ['id', 'queryId', 'key', 'queryKey', 'name', 'criteria', 'criteriaJson', 'enabled'],
  enable: ['id', 'queryId', 'key', 'queryKey'],
  disable: ['id', 'queryId', 'key', 'queryKey'],
  show: ['id', 'queryId', 'key', 'queryKey'],
  list: ['enabled']
};
const DISCOVERY_RUN_FLAGS = {
  start: ['source', 'sourceId', 'sourceKey', 'query', 'queryId', 'queryKey', 'cursor', 'cursorBefore', 'effectiveCriteria', 'effectiveCriteriaJson'],
  finish: ['runId', 'id', 'status', 'cursorAfter', 'etag', 'lastModified', 'requestCount', 'seenCount', 'newCount', 'updatedCount', 'closedCount', 'errorCode', 'errorMessage'],
  show: ['runId', 'id'],
  list: ['source', 'sourceId', 'sourceKey', 'status', 'limit', 'offset']
};
const OPPORTUNITY_COMMAND_FLAGS = {
  add: ['source', 'sourceId', 'sourceKey', 'url', 'jobUrl', 'observedUrl', 'company', 'companyName', 'role', 'title', 'observedAt', 'fetchedAt', 'runId', 'externalId', 'providerJobId', 'provider', 'board', 'boardKey', 'identityNamespace', 'compensation', 'compensationJson', 'location', 'locationText', 'workplaceType', 'employmentType', 'description', 'content', 'descriptionFile', 'postedAt', 'payload', 'payloadJson', 'rawSha256', 'state', 'idempotencyKey', 'httpStatus', 'contentType', 'etag', 'lastModified', 'parserName', 'parserVersion', 'attachmentPath', 'rawAttachmentPath'],
  ingest: null,
  upsert: null,
  list: ['state', 'source', 'sourceId', 'sourceKey', 'tag', 'text', 'q', 'minScore', 'staleBefore', 'sort', 'limit', 'offset'],
  search: null,
  show: ['opportunityId', 'id'],
  read: ['opportunityId', 'id'],
  triage: ['opportunityId', 'id', 'decision', 'rationale', 'notes', 'dimensions', 'dimensionsJson', 'hardBlockers', 'hardBlockersJson', 'profileEntryRefs', 'score', 'scoreCoverage', 'coverage', 'snapshotId', 'evidenceSnapshotId', 'scorerKind', 'scorerId', 'rubricVersion'],
  tag: ['opportunityId', 'id', 'tags', 'tag', 'tagSource'],
  close: ['opportunityId', 'id', 'reason', 'confidence'],
  reopen: ['opportunityId', 'id', 'reason'],
  promote: ['opportunityId', 'id', 'notes']
};
OPPORTUNITY_COMMAND_FLAGS.ingest = OPPORTUNITY_COMMAND_FLAGS.add;
OPPORTUNITY_COMMAND_FLAGS.upsert = OPPORTUNITY_COMMAND_FLAGS.add;
OPPORTUNITY_COMMAND_FLAGS.search = OPPORTUNITY_COMMAND_FLAGS.list;

class OpportunityError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'OpportunityError';
    this.code = code;
    this.details = details;
  }
}

function migrateOpportunities(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobtrack_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const applyMigration = () => {
    if (!db.prepare('SELECT 1 FROM jobtrack_schema_migrations WHERE version = ?').get(OPPORTUNITY_SCHEMA_VERSION)) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS discovery_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT NOT NULL COLLATE NOCASE UNIQUE,
      adapter TEXT NOT NULL CHECK (adapter IN ('manual','greenhouse','lever','ashby','rss','remoteok','hn','api','web')),
      label TEXT NOT NULL,
      base_url TEXT,
      config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      policy_state TEXT NOT NULL DEFAULT 'unreviewed' CHECK (policy_state IN ('unreviewed','allowed','blocked')),
      terms_url TEXT,
      attribution_text TEXT,
      min_interval_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (min_interval_seconds >= 0),
      freshness_ttl_hours INTEGER NOT NULL DEFAULT 72 CHECK (freshness_ttl_hours >= 1),
      last_success_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS discovery_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_key TEXT NOT NULL COLLATE NOCASE UNIQUE,
      name TEXT NOT NULL,
      criteria_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(criteria_json)),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS discovery_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES discovery_sources(id) ON DELETE RESTRICT,
      query_id INTEGER REFERENCES discovery_queries(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','partial','failed')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      cursor_before TEXT,
      cursor_after TEXT,
      etag TEXT,
      last_modified TEXT,
      request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
      seen_count INTEGER NOT NULL DEFAULT 0 CHECK (seen_count >= 0),
      new_count INTEGER NOT NULL DEFAULT 0 CHECK (new_count >= 0),
      updated_count INTEGER NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
      closed_count INTEGER NOT NULL DEFAULT 0 CHECK (closed_count >= 0),
      error_code TEXT,
      error_message TEXT,
      source_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(source_snapshot_json)),
      query_snapshot_json TEXT CHECK (query_snapshot_json IS NULL OR json_valid(query_snapshot_json)),
      effective_criteria_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(effective_criteria_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state TEXT NOT NULL DEFAULT 'inbox' CHECK (state IN ('inbox','shortlisted','watching','dismissed','promoted','closed')),
      company_name TEXT NOT NULL,
      title TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      canonical_url_sha256 TEXT NOT NULL UNIQUE CHECK (length(canonical_url_sha256) = 64),
      primary_source_id INTEGER REFERENCES discovery_sources(id) ON DELETE SET NULL,
      provider TEXT,
      board_key TEXT,
      external_id TEXT,
      dedupe_fingerprint TEXT NOT NULL,
      location_text TEXT,
      workplace_type TEXT,
      employment_type TEXT,
      compensation_json TEXT CHECK (compensation_json IS NULL OR json_valid(compensation_json)),
      description_text TEXT,
      posted_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_verified_at TEXT,
      latest_snapshot_id INTEGER,
      closed_at TEXT,
      closed_reason TEXT,
      close_confidence TEXT,
      promoted_application_id INTEGER UNIQUE REFERENCES applications(id) ON DELETE SET NULL,
      promoted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS opportunity_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      namespace TEXT NOT NULL,
      identity_value TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(namespace, identity_value)
    );

    CREATE TABLE IF NOT EXISTS opportunity_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      source_id INTEGER REFERENCES discovery_sources(id) ON DELETE SET NULL,
      observed_url TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      http_status INTEGER,
      content_type TEXT,
      etag TEXT,
      last_modified TEXT,
      parser_name TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      raw_attachment_path TEXT,
      raw_sha256 TEXT CHECK (raw_sha256 IS NULL OR length(raw_sha256) = 64),
      normalized_json TEXT NOT NULL CHECK (json_valid(normalized_json)),
      normalized_text TEXT,
      normalized_sha256 TEXT NOT NULL CHECK (length(normalized_sha256) = 64),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(opportunity_id, normalized_sha256)
    );

    CREATE TABLE IF NOT EXISTS opportunity_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      source_id INTEGER REFERENCES discovery_sources(id) ON DELETE SET NULL,
      run_id INTEGER REFERENCES discovery_runs(id) ON DELETE SET NULL,
      snapshot_id INTEGER REFERENCES opportunity_snapshots(id) ON DELETE SET NULL,
      ingestion_key TEXT NOT NULL UNIQUE CHECK (length(ingestion_key) = 64),
      external_id TEXT,
      observed_url TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS opportunity_triage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK (decision IN ('shortlist','watch','dismiss','revisit','note')),
      score REAL CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
      score_coverage REAL CHECK (score_coverage IS NULL OR (score_coverage >= 0 AND score_coverage <= 1)),
      dimensions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(dimensions_json)),
      hard_blockers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hard_blockers_json)),
      rationale TEXT NOT NULL,
      evidence_snapshot_id INTEGER REFERENCES opportunity_snapshots(id) ON DELETE SET NULL,
      profile_entry_refs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(profile_entry_refs)),
      scorer_kind TEXT NOT NULL DEFAULT 'agent',
      scorer_id TEXT,
      rubric_version TEXT NOT NULL DEFAULT '1',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS opportunity_tags (
      opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      tag TEXT NOT NULL COLLATE NOCASE,
      tag_source TEXT NOT NULL DEFAULT 'agent',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(opportunity_id, tag)
    );

    CREATE TABLE IF NOT EXISTS opportunity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      event_kind TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TRIGGER IF NOT EXISTS trg_opportunity_snapshots_immutable_update
    BEFORE UPDATE ON opportunity_snapshots
    BEGIN SELECT RAISE(ABORT, 'opportunity snapshots are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_opportunity_snapshots_immutable_delete
    BEFORE DELETE ON opportunity_snapshots
    BEGIN SELECT RAISE(ABORT, 'opportunity snapshots are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_opportunity_observations_immutable_update
    BEFORE UPDATE ON opportunity_observations
    BEGIN SELECT RAISE(ABORT, 'opportunity observations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_opportunity_observations_immutable_delete
    BEFORE DELETE ON opportunity_observations
    BEGIN SELECT RAISE(ABORT, 'opportunity observations are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_opportunity_triage_immutable_update
    BEFORE UPDATE ON opportunity_triage
    BEGIN SELECT RAISE(ABORT, 'opportunity triage records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_opportunity_triage_immutable_delete
    BEFORE DELETE ON opportunity_triage
    BEGIN SELECT RAISE(ABORT, 'opportunity triage records are append-only'); END;

    CREATE TRIGGER IF NOT EXISTS trg_opportunity_events_immutable_update
    BEFORE UPDATE ON opportunity_events
    BEGIN SELECT RAISE(ABORT, 'opportunity events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_opportunity_events_immutable_delete
    BEFORE DELETE ON opportunity_events
    BEGIN SELECT RAISE(ABORT, 'opportunity events are append-only'); END;

    CREATE INDEX IF NOT EXISTS idx_discovery_runs_source_started ON discovery_runs(source_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_opportunities_state_seen ON opportunities(state, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_opportunities_company_title ON opportunities(company_name, title);
    CREATE INDEX IF NOT EXISTS idx_opportunities_fingerprint ON opportunities(dedupe_fingerprint);
    CREATE INDEX IF NOT EXISTS idx_opportunity_identities_opportunity ON opportunity_identities(opportunity_id);
    CREATE INDEX IF NOT EXISTS idx_opportunity_observations_opportunity ON opportunity_observations(opportunity_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_opportunity_snapshots_opportunity ON opportunity_snapshots(opportunity_id, fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_opportunity_triage_opportunity ON opportunity_triage(opportunity_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_opportunity_events_opportunity ON opportunity_events(opportunity_id, created_at DESC);
  `);

    ensureColumn(db, 'applications', 'source_opportunity_id', 'INTEGER');
    ensureColumn(db, 'application_artifacts', 'opportunity_snapshot_id', 'INTEGER');
    db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_source_opportunity
      ON applications(source_opportunity_id) WHERE source_opportunity_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_application_artifacts_opportunity_snapshot
      ON application_artifacts(opportunity_snapshot_id) WHERE opportunity_snapshot_id IS NOT NULL;
  `);
    db.prepare(`
    INSERT INTO discovery_sources (source_key, adapter, label, base_url, enabled, policy_state, min_interval_seconds, freshness_ttl_hours)
    VALUES ('manual', 'manual', 'Manual capture', NULL, 1, 'allowed', 0, 720)
    ON CONFLICT(source_key) DO NOTHING
    `).run();
    db.prepare(`
      INSERT INTO jobtrack_schema_migrations (version, name)
      VALUES (?, 'opportunity_discovery_inbox')
    `).run(OPPORTUNITY_SCHEMA_VERSION);
    }
    applyOpportunityHardeningMigration(db);
    applyOpportunityProvenanceMigration(db);
  };
  if (db.inTransaction) applyMigration();
  else db.transaction(applyMigration).immediate();
}

function applyOpportunityHardeningMigration(db) {
  if (db.prepare('SELECT 1 FROM jobtrack_schema_migrations WHERE version = ?').get(OPPORTUNITY_HARDENING_SCHEMA_VERSION)) return;
  const duplicateRun = db.prepare(`
    SELECT source_id, count(*) AS count FROM discovery_runs
    WHERE status='running' GROUP BY source_id HAVING count(*) > 1 LIMIT 1
  `).get();
  if (duplicateRun) throw new OpportunityError('MIGRATION_CONFLICT', `Source ${duplicateRun.source_id} has ${duplicateRun.count} active discovery runs`);
  const invalidTerminal = db.prepare(`
    SELECT id, state FROM opportunities
    WHERE (state='promoted' AND (promoted_application_id IS NULL OR promoted_at IS NULL))
       OR (state<>'promoted' AND (promoted_application_id IS NOT NULL OR promoted_at IS NOT NULL))
       OR (state='closed' AND (closed_at IS NULL OR trim(COALESCE(closed_reason,''))=''))
       OR (state<>'closed' AND (closed_at IS NOT NULL OR closed_reason IS NOT NULL OR close_confidence IS NOT NULL))
    LIMIT 1
  `).get();
  if (invalidTerminal) throw new OpportunityError('MIGRATION_CONFLICT', `Opportunity ${invalidTerminal.id} has invalid ${invalidTerminal.state} provenance`);
  ensureColumn(db, 'discovery_runs', 'source_snapshot_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'discovery_runs', 'query_snapshot_json', 'TEXT');
  ensureColumn(db, 'discovery_runs', 'effective_criteria_json', "TEXT NOT NULL DEFAULT '{}'");
  const sources = db.prepare('SELECT * FROM discovery_sources').all();
  const sourceById = new Map(sources.map((row) => [row.id, stableJson(sourceRunSnapshot(row))]));
  const queries = new Map(db.prepare('SELECT * FROM discovery_queries').all().map((row) => [row.id, row]));
  const runs = db.prepare("SELECT id, source_id, query_id, source_snapshot_json, query_snapshot_json, effective_criteria_json FROM discovery_runs").all();
  const backfill = db.prepare(`
    UPDATE discovery_runs SET source_snapshot_json=?, query_snapshot_json=?, effective_criteria_json=? WHERE id=?
  `);
  for (const run of runs) {
    const query = run.query_id ? queries.get(run.query_id) : null;
    backfill.run(
      run.source_snapshot_json && run.source_snapshot_json !== '{}' ? run.source_snapshot_json : sourceById.get(run.source_id) || '{}',
      run.query_snapshot_json || (query ? stableJson(queryRunSnapshot(query)) : null),
      run.effective_criteria_json && run.effective_criteria_json !== '{}'
        ? run.effective_criteria_json
        : query ? query.criteria_json : '{}',
      run.id
    );
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_runs_one_active_source
      ON discovery_runs(source_id) WHERE status='running';

    CREATE TRIGGER IF NOT EXISTS trg_opportunity_promoted_provenance_insert
    BEFORE INSERT ON opportunities
    WHEN NEW.state='promoted' AND (NEW.promoted_application_id IS NULL OR NEW.promoted_at IS NULL)
    BEGIN SELECT RAISE(ABORT, 'promoted opportunity requires application provenance'); END;

    CREATE TRIGGER IF NOT EXISTS trg_opportunity_promoted_provenance_update
    BEFORE UPDATE OF state, promoted_application_id, promoted_at ON opportunities
    WHEN NEW.state='promoted' AND (NEW.promoted_application_id IS NULL OR NEW.promoted_at IS NULL)
    BEGIN SELECT RAISE(ABORT, 'promoted opportunity requires application provenance'); END;

    CREATE TRIGGER IF NOT EXISTS trg_opportunity_promotion_cannot_be_demoted
    BEFORE UPDATE OF state, promoted_application_id, promoted_at ON opportunities
    WHEN (NEW.promoted_application_id IS NOT NULL OR NEW.promoted_at IS NOT NULL) AND NEW.state <> 'promoted'
    BEGIN SELECT RAISE(ABORT, 'linked promoted opportunity cannot leave promoted state'); END;

    CREATE TRIGGER IF NOT EXISTS trg_opportunity_promotion_requires_state_insert
    BEFORE INSERT ON opportunities
    WHEN (NEW.promoted_application_id IS NOT NULL OR NEW.promoted_at IS NOT NULL) AND NEW.state <> 'promoted'
    BEGIN SELECT RAISE(ABORT, 'linked promoted opportunity must be in promoted state'); END;

    CREATE TRIGGER IF NOT EXISTS trg_opportunity_closed_provenance_insert
    BEFORE INSERT ON opportunities
    WHEN NEW.state='closed' AND (NEW.closed_at IS NULL OR trim(COALESCE(NEW.closed_reason,''))='')
    BEGIN SELECT RAISE(ABORT, 'closed opportunity requires closure provenance'); END;

    CREATE TRIGGER IF NOT EXISTS trg_opportunity_closed_provenance_update
    BEFORE UPDATE OF state, closed_at, closed_reason ON opportunities
    WHEN NEW.state='closed' AND (NEW.closed_at IS NULL OR trim(COALESCE(NEW.closed_reason,''))='')
    BEGIN SELECT RAISE(ABORT, 'closed opportunity requires closure provenance'); END;

    CREATE TRIGGER IF NOT EXISTS trg_opportunity_closure_cannot_be_bypassed_insert
    BEFORE INSERT ON opportunities
    WHEN NEW.state<>'closed' AND (NEW.closed_at IS NOT NULL OR NEW.closed_reason IS NOT NULL OR NEW.close_confidence IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'closure provenance requires closed state'); END;

    CREATE TRIGGER IF NOT EXISTS trg_opportunity_closure_cannot_be_bypassed_update
    BEFORE UPDATE OF state, closed_at, closed_reason, close_confidence ON opportunities
    WHEN NEW.state<>'closed' AND (NEW.closed_at IS NOT NULL OR NEW.closed_reason IS NOT NULL OR NEW.close_confidence IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'closure provenance requires closed state'); END;
  `);
  db.prepare(`
    INSERT INTO jobtrack_schema_migrations (version, name)
    VALUES (?, 'opportunity_state_and_run_guards')
  `).run(OPPORTUNITY_HARDENING_SCHEMA_VERSION);
}

function applyOpportunityProvenanceMigration(db) {
  if (db.prepare('SELECT 1 FROM jobtrack_schema_migrations WHERE version = ?').get(OPPORTUNITY_PROVENANCE_SCHEMA_VERSION)) return;

  ensureColumn(db, 'opportunity_observations', 'parser_name', "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn(db, 'opportunity_observations', 'parser_version', "TEXT NOT NULL DEFAULT '1'");
  ensureColumn(db, 'opportunity_observations', 'http_status', 'INTEGER');
  ensureColumn(db, 'opportunity_observations', 'content_type', 'TEXT');
  ensureColumn(db, 'opportunity_observations', 'etag', 'TEXT');
  ensureColumn(db, 'opportunity_observations', 'last_modified', 'TEXT');
  ensureColumn(db, 'opportunity_observations', 'raw_attachment_path', 'TEXT');
  ensureColumn(db, 'opportunity_observations', 'raw_sha256', "TEXT CHECK (raw_sha256 IS NULL OR length(raw_sha256) = 64)");

  // The table is append-only at runtime. Temporarily remove the update guard only
  // inside this migration transaction so historical observations can inherit the
  // retrieval facts that previously lived solely on their normalized snapshot.
  db.exec('DROP TRIGGER IF EXISTS trg_opportunity_observations_immutable_update');
  db.exec(`
    UPDATE opportunity_observations
    SET parser_name = COALESCE((
          SELECT os.parser_name FROM opportunity_snapshots os
          WHERE os.id = opportunity_observations.snapshot_id
        ), parser_name),
        parser_version = COALESCE((
          SELECT os.parser_version FROM opportunity_snapshots os
          WHERE os.id = opportunity_observations.snapshot_id
        ), parser_version),
        http_status = COALESCE((
          SELECT os.http_status FROM opportunity_snapshots os
          WHERE os.id = opportunity_observations.snapshot_id
        ), http_status),
        content_type = COALESCE((
          SELECT os.content_type FROM opportunity_snapshots os
          WHERE os.id = opportunity_observations.snapshot_id
        ), content_type),
        etag = COALESCE((
          SELECT os.etag FROM opportunity_snapshots os
          WHERE os.id = opportunity_observations.snapshot_id
        ), etag),
        last_modified = COALESCE((
          SELECT os.last_modified FROM opportunity_snapshots os
          WHERE os.id = opportunity_observations.snapshot_id
        ), last_modified),
        raw_attachment_path = COALESCE((
          SELECT os.raw_attachment_path FROM opportunity_snapshots os
          WHERE os.id = opportunity_observations.snapshot_id
        ), raw_attachment_path),
        raw_sha256 = COALESCE((
          SELECT os.raw_sha256 FROM opportunity_snapshots os
          WHERE os.id = opportunity_observations.snapshot_id
        ), raw_sha256)
    WHERE snapshot_id IS NOT NULL;

    CREATE TRIGGER trg_opportunity_observations_immutable_update
    BEFORE UPDATE ON opportunity_observations
    BEGIN SELECT RAISE(ABORT, 'opportunity observations are immutable'); END;

    -- These inverse guards were missing from some databases that had already
    -- recorded migration 1705. Reassert them under a new append-only version.
    CREATE TRIGGER IF NOT EXISTS trg_opportunity_closure_cannot_be_bypassed_insert
    BEFORE INSERT ON opportunities
    WHEN NEW.state<>'closed' AND (NEW.closed_at IS NOT NULL OR NEW.closed_reason IS NOT NULL OR NEW.close_confidence IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'closure provenance requires closed state'); END;

    CREATE TRIGGER IF NOT EXISTS trg_opportunity_closure_cannot_be_bypassed_update
    BEFORE UPDATE OF state, closed_at, closed_reason, close_confidence ON opportunities
    WHEN NEW.state<>'closed' AND (NEW.closed_at IS NOT NULL OR NEW.closed_reason IS NOT NULL OR NEW.close_confidence IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'closure provenance requires closed state'); END;
  `);

  db.prepare(`
    INSERT INTO jobtrack_schema_migrations (version, name)
    VALUES (?, 'opportunity_observation_retrieval_provenance')
  `).run(OPPORTUNITY_PROVENANCE_SCHEMA_VERSION);
}

function ensureColumn(db, table, column, definition) {
  if (!tableExists(db, table)) {
    throw new OpportunityError('SCHEMA_MISSING', `Required downstream table is missing: ${table}`);
  }
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function canonicalizeUrl(input) {
  let url;
  try {
    url = new URL(required(input, 'URL'));
  } catch {
    throw new OpportunityError('INVALID_URL', `Invalid opportunity URL: ${input}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new OpportunityError('INVALID_URL', 'Opportunity URLs must use http or https');
  }
  if (url.username || url.password) {
    throw new OpportunityError('INVALID_URL', 'Opportunity URLs must not contain credentials');
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  return url.toString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function parseJson(value, label, fallback, expected = 'object') {
  if (value === undefined || value === null || value === '') return fallback;
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { throw new OpportunityError('INVALID_JSON', `${label} must be valid JSON`); }
  }
  if (expected === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new OpportunityError('INVALID_JSON', `${label} must be a JSON object`);
  }
  if (expected === 'array' && !Array.isArray(parsed)) {
    throw new OpportunityError('INVALID_JSON', `${label} must be a JSON array`);
  }
  return parsed;
}

function assertNoSecrets(value, path = 'config') {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key.replace(/-/g, '_'))) {
      throw new OpportunityError('SECRET_REJECTED', `${path}.${key} looks like a credential; store credentials outside JobTrack`);
    }
    assertNoSecrets(nested, `${path}.${key}`);
  }
}

function required(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new OpportunityError('VALIDATION_ERROR', `Missing required ${label}`);
  }
  return String(value).trim();
}

function optional(value) {
  return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim();
}

function positiveId(value, label) {
  if (!/^[1-9]\d*$/.test(String(value))) throw new OpportunityError('VALIDATION_ERROR', `Provide a valid ${label}`);
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new OpportunityError('VALIDATION_ERROR', `Provide a valid ${label}`);
  return id;
}

function boundedNumber(value, label, min, max, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new OpportunityError('VALIDATION_ERROR', `${label} must be between ${min} and ${max}`);
  }
  return number;
}

function nonnegativeInteger(value, label, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new OpportunityError('VALIDATION_ERROR', `${label} must be a nonnegative integer`);
  return number;
}

function booleanFlag(value, fallback = true) {
  if (value === undefined) return fallback;
  if (value === true || value === 1 || value === '1' || value === 'true' || value === 'yes') return true;
  if (value === false || value === 0 || value === '0' || value === 'false' || value === 'no') return false;
  throw new OpportunityError('VALIDATION_ERROR', 'Boolean flag must be true or false');
}

function enumValue(value, allowed, label) {
  if (!allowed.has(value)) throw new OpportunityError('VALIDATION_ERROR', `${label} must be one of: ${[...allowed].join(', ')}`);
  return value;
}

function now(context) {
  const value = context && typeof context.now === 'function' ? context.now() : new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new OpportunityError('VALIDATION_ERROR', 'context.now() returned an invalid timestamp');
  return parsed.toISOString();
}

function addDiscoverySource(db, flags) {
  const sourceKey = required(flags.key || flags.sourceKey, '--key');
  const adapter = enumValue(required(flags.adapter, '--adapter').toLowerCase(), SOURCE_ADAPTERS, 'adapter');
  const config = parseJson(flags.config || flags.configJson, '--config', {});
  assertNoSecrets(config);
  const baseUrl = optional(flags.baseUrl || flags.url);
  if (adapter !== 'manual') {
    if (!baseUrl) throw new OpportunityError('VALIDATION_ERROR', '--base-url is required for non-manual sources');
    const canonical = canonicalizeUrl(baseUrl);
    if (!canonical.startsWith('https://')) throw new OpportunityError('INVALID_URL', 'Discovery source base URLs must use HTTPS');
  }
  const policyState = enumValue(flags.policyState || 'unreviewed', SOURCE_POLICY_STATES, 'policy state');
  const info = db.prepare(`
    INSERT INTO discovery_sources (
      source_key, adapter, label, base_url, config_json, enabled, policy_state, terms_url,
      attribution_text, min_interval_seconds, freshness_ttl_hours, updated_at
    ) VALUES (
      @sourceKey, @adapter, @label, @baseUrl, @configJson, @enabled, @policyState, @termsUrl,
      @attributionText, @minIntervalSeconds, @freshnessTtlHours, @updatedAt
    )
  `).run({
    sourceKey,
    adapter,
    label: flags.label || sourceKey,
    baseUrl,
    configJson: stableJson(config),
    enabled: booleanFlag(flags.enabled, true) ? 1 : 0,
    policyState,
    termsUrl: optional(flags.termsUrl),
    attributionText: optional(flags.attributionText || flags.attribution),
    minIntervalSeconds: nonnegativeInteger(flags.minIntervalSeconds, '--min-interval-seconds', 3600),
    freshnessTtlHours: nonnegativeInteger(flags.freshnessTtlHours, '--freshness-ttl-hours', 72) || 1,
    updatedAt: new Date().toISOString()
  });
  return serializeSource(db.prepare('SELECT * FROM discovery_sources WHERE id = ?').get(info.lastInsertRowid));
}

function updateDiscoverySource(db, flags) {
  const source = resolveSource(db, flags.id || flags.sourceId || flags.key || flags.sourceKey);
  const set = [];
  const params = { id: source.id, updatedAt: new Date().toISOString() };
  const textFields = { label: 'label', termsUrl: 'terms_url', attributionText: 'attribution_text' };
  for (const [flag, column] of Object.entries(textFields)) {
    const alternate = flag === 'attributionText' ? flags.attribution : undefined;
    if (flags[flag] !== undefined || alternate !== undefined) {
      set.push(`${column} = @${flag}`);
      params[flag] = optional(flags[flag] === undefined ? alternate : flags[flag]);
    }
  }
  if (flags.baseUrl !== undefined || flags.url !== undefined) {
    const baseUrl = required(flags.baseUrl || flags.url, '--base-url');
    const canonical = canonicalizeUrl(baseUrl);
    if (!canonical.startsWith('https://')) throw new OpportunityError('INVALID_URL', 'Discovery source base URLs must use HTTPS');
    set.push('base_url = @baseUrl');
    params.baseUrl = baseUrl;
  }
  if (flags.adapter !== undefined) {
    set.push('adapter = @adapter');
    params.adapter = enumValue(String(flags.adapter).toLowerCase(), SOURCE_ADAPTERS, 'adapter');
  }
  if (flags.policyState !== undefined) {
    set.push('policy_state = @policyState');
    params.policyState = enumValue(flags.policyState, SOURCE_POLICY_STATES, 'policy state');
  }
  if (flags.enabled !== undefined) { set.push('enabled = @enabled'); params.enabled = booleanFlag(flags.enabled) ? 1 : 0; }
  if (flags.config !== undefined || flags.configJson !== undefined) {
    const config = parseJson(flags.config || flags.configJson, '--config', {});
    assertNoSecrets(config);
    set.push('config_json = @configJson');
    params.configJson = stableJson(config);
  }
  if (flags.minIntervalSeconds !== undefined) {
    set.push('min_interval_seconds = @minIntervalSeconds');
    params.minIntervalSeconds = nonnegativeInteger(flags.minIntervalSeconds, '--min-interval-seconds');
  }
  if (flags.freshnessTtlHours !== undefined) {
    set.push('freshness_ttl_hours = @freshnessTtlHours');
    params.freshnessTtlHours = Math.max(1, nonnegativeInteger(flags.freshnessTtlHours, '--freshness-ttl-hours'));
  }
  if (!set.length) throw new OpportunityError('VALIDATION_ERROR', 'Provide at least one source field to update');
  set.push('updated_at = @updatedAt');
  db.prepare(`UPDATE discovery_sources SET ${set.join(', ')} WHERE id = @id`).run(params);
  return serializeSource(db.prepare('SELECT * FROM discovery_sources WHERE id = ?').get(source.id));
}

function serializeSource(row) {
  if (!row) return null;
  return { ...row, enabled: Boolean(row.enabled), config: parseStoredJson(row.config_json, {}) };
}

function resolveSource(db, value = 'manual') {
  let row;
  if (/^\d+$/.test(String(value))) row = db.prepare('SELECT * FROM discovery_sources WHERE id = ?').get(Number(value));
  else row = db.prepare('SELECT * FROM discovery_sources WHERE source_key = ? COLLATE NOCASE').get(String(value));
  if (!row) throw new OpportunityError('NOT_FOUND', `Discovery source not found: ${value}`);
  return row;
}

function listDiscoverySources(db, filters = {}) {
  const where = [];
  const params = {};
  if (filters.enabled !== undefined) { where.push('enabled = @enabled'); params.enabled = booleanFlag(filters.enabled) ? 1 : 0; }
  if (filters.adapter) { where.push('adapter = @adapter'); params.adapter = filters.adapter; }
  if (filters.policyState) { where.push('policy_state = @policyState'); params.policyState = filters.policyState; }
  return db.prepare(`SELECT * FROM discovery_sources ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY lower(source_key), id`).all(params).map(serializeSource);
}

function addDiscoveryQuery(db, flags) {
  const queryKey = required(flags.key || flags.queryKey, '--key');
  const criteria = parseJson(flags.criteria || flags.criteriaJson, '--criteria', {});
  const info = db.prepare(`
    INSERT INTO discovery_queries (query_key, name, criteria_json, enabled, updated_at)
    VALUES (@queryKey, @name, @criteriaJson, @enabled, @updatedAt)
  `).run({
    queryKey,
    name: flags.name || queryKey,
    criteriaJson: stableJson(criteria),
    enabled: booleanFlag(flags.enabled, true) ? 1 : 0,
    updatedAt: new Date().toISOString()
  });
  return serializeQuery(db.prepare('SELECT * FROM discovery_queries WHERE id = ?').get(info.lastInsertRowid));
}

function updateDiscoveryQuery(db, flags) {
  const query = resolveQuery(db, flags.id || flags.queryId || flags.key || flags.queryKey);
  const set = [];
  const params = { id: query.id, updatedAt: new Date().toISOString() };
  if (flags.name !== undefined) { set.push('name = @name'); params.name = required(flags.name, '--name'); }
  if (flags.enabled !== undefined) { set.push('enabled = @enabled'); params.enabled = booleanFlag(flags.enabled) ? 1 : 0; }
  if (flags.criteria !== undefined || flags.criteriaJson !== undefined) {
    set.push('criteria_json = @criteriaJson');
    params.criteriaJson = stableJson(parseJson(flags.criteria || flags.criteriaJson, '--criteria', {}));
  }
  if (!set.length) throw new OpportunityError('VALIDATION_ERROR', 'Provide at least one query field to update');
  set.push('updated_at = @updatedAt');
  db.prepare(`UPDATE discovery_queries SET ${set.join(', ')} WHERE id = @id`).run(params);
  return serializeQuery(db.prepare('SELECT * FROM discovery_queries WHERE id = ?').get(query.id));
}

function serializeQuery(row) {
  if (!row) return null;
  return { ...row, enabled: Boolean(row.enabled), criteria: parseStoredJson(row.criteria_json, {}) };
}

function resolveQuery(db, value) {
  if (value === undefined || value === null || value === '') return null;
  let row;
  if (/^\d+$/.test(String(value))) row = db.prepare('SELECT * FROM discovery_queries WHERE id = ?').get(Number(value));
  else row = db.prepare('SELECT * FROM discovery_queries WHERE query_key = ? COLLATE NOCASE').get(String(value));
  if (!row) throw new OpportunityError('NOT_FOUND', `Discovery query not found: ${value}`);
  return row;
}

function listDiscoveryQueries(db, filters = {}) {
  const where = [];
  const params = {};
  if (filters.enabled !== undefined) { where.push('enabled = @enabled'); params.enabled = booleanFlag(filters.enabled) ? 1 : 0; }
  return db.prepare(`SELECT * FROM discovery_queries ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY lower(query_key), id`).all(params).map(serializeQuery);
}

function startDiscoveryRun(db, flags, context = {}) {
  return db.transaction(() => {
    const source = resolveSource(db, flags.source || flags.sourceId || flags.sourceKey);
    if (!source.enabled) throw new OpportunityError('SOURCE_DISABLED', `Discovery source is disabled: ${source.source_key}`);
    if (source.policy_state !== 'allowed') {
      throw new OpportunityError('SOURCE_POLICY_DENIED', `Discovery source policy is ${source.policy_state}: ${source.source_key}`);
    }
    const startedAt = now(context);
    const active = db.prepare("SELECT id FROM discovery_runs WHERE source_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1").get(source.id);
    if (active) throw new OpportunityError('RUN_CONFLICT', `Source already has a running discovery run: ${active.id}`);
    const latestRun = db.prepare('SELECT started_at FROM discovery_runs WHERE source_id=? ORDER BY datetime(started_at) DESC, id DESC LIMIT 1').get(source.id);
    const intervalAnchor = [source.last_success_at, latestRun && latestRun.started_at]
      .filter(Boolean)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    if (intervalAnchor && source.min_interval_seconds > 0) {
      const elapsedSeconds = (Date.parse(startedAt) - Date.parse(intervalAnchor)) / 1000;
      if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < source.min_interval_seconds) {
        const retryAfterSeconds = Number.isFinite(elapsedSeconds)
          ? Math.max(1, Math.ceil(source.min_interval_seconds - elapsedSeconds))
          : source.min_interval_seconds;
        throw new OpportunityError('SOURCE_RATE_LIMIT', `Source ${source.source_key} is inside its minimum scan interval; retry after ${retryAfterSeconds} seconds`, { retryAfterSeconds });
      }
    }
    const query = resolveQuery(db, flags.query || flags.queryId || flags.queryKey);
    if (query && !query.enabled) throw new OpportunityError('QUERY_DISABLED', `Discovery query is disabled: ${query.query_key}`);
    const effectiveCriteria = parseJson(flags.effectiveCriteria || flags.effectiveCriteriaJson, '--effective-criteria', query ? parseStoredJson(query.criteria_json, {}) : {});
    try {
      const info = db.prepare(`
        INSERT INTO discovery_runs
          (source_id, query_id, status, started_at, cursor_before, source_snapshot_json, query_snapshot_json, effective_criteria_json)
        VALUES (?, ?, 'running', ?, ?, ?, ?, ?)
      `).run(
        source.id,
        query ? query.id : null,
        startedAt,
        optional(flags.cursor || flags.cursorBefore),
        stableJson(sourceRunSnapshot(source)),
        query ? stableJson(queryRunSnapshot(query)) : null,
        stableJson(effectiveCriteria)
      );
      return getDiscoveryRun(db, info.lastInsertRowid);
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
        throw new OpportunityError('RUN_CONFLICT', `Source already has a running discovery run: ${source.source_key}`);
      }
      throw error;
    }
  }).immediate();
}

function sourceRunSnapshot(source) {
  return {
    sourceKey: source.source_key,
    adapter: source.adapter,
    label: source.label,
    baseUrl: source.base_url,
    config: parseStoredJson(source.config_json, {}),
    policyState: source.policy_state,
    termsUrl: source.terms_url,
    attributionText: source.attribution_text,
    minIntervalSeconds: source.min_interval_seconds,
    freshnessTtlHours: source.freshness_ttl_hours,
    updatedAt: source.updated_at
  };
}

function queryRunSnapshot(query) {
  return {
    queryKey: query.query_key,
    name: query.name,
    criteria: parseStoredJson(query.criteria_json, {}),
    updatedAt: query.updated_at
  };
}

function finishDiscoveryRun(db, flags, context = {}) {
  const runId = positiveId(flags.runId || flags.id, '--run-id');
  const status = enumValue(required(flags.status, '--status'), new Set(['succeeded', 'partial', 'failed']), 'run status');
  const counts = {
    requestCount: nonnegativeInteger(flags.requestCount, '--request-count'),
    seenCount: nonnegativeInteger(flags.seenCount, '--seen-count'),
    newCount: nonnegativeInteger(flags.newCount, '--new-count'),
    updatedCount: nonnegativeInteger(flags.updatedCount, '--updated-count'),
    closedCount: nonnegativeInteger(flags.closedCount, '--closed-count')
  };
  return db.transaction(() => {
    const run = db.prepare('SELECT * FROM discovery_runs WHERE id = ?').get(runId);
    if (!run) throw new OpportunityError('NOT_FOUND', `Discovery run not found: ${runId}`);
    if (run.status !== 'running') {
      const exactReplay = run.status === status
        && run.request_count === counts.requestCount && run.seen_count === counts.seenCount
        && run.new_count === counts.newCount && run.updated_count === counts.updatedCount
        && run.closed_count === counts.closedCount
        && (run.error_code || null) === optional(flags.errorCode)
        && (run.error_message || null) === optional(flags.errorMessage);
      if (exactReplay) return getDiscoveryRun(db, runId);
      throw new OpportunityError('RUN_CONFLICT', `Discovery run ${runId} is already ${run.status}`);
    }
    const update = db.prepare(`
      UPDATE discovery_runs SET status=@status, completed_at=@completedAt, cursor_after=@cursorAfter,
        etag=@etag, last_modified=@lastModified, request_count=@requestCount, seen_count=@seenCount,
        new_count=@newCount, updated_count=@updatedCount, closed_count=@closedCount,
        error_code=@errorCode, error_message=@errorMessage WHERE id=@runId AND status='running'
    `).run({
      runId, status, completedAt: now(context), cursorAfter: optional(flags.cursorAfter), etag: optional(flags.etag),
      lastModified: optional(flags.lastModified), errorCode: optional(flags.errorCode), errorMessage: optional(flags.errorMessage), ...counts
    });
    if (update.changes !== 1) throw new OpportunityError('RUN_CONFLICT', `Discovery run ${runId} was finished concurrently`);
    if (status === 'succeeded') {
      db.prepare("UPDATE discovery_sources SET last_success_at = ?, updated_at = ? WHERE id = ?").run(now(context), now(context), run.source_id);
    }
    return getDiscoveryRun(db, runId);
  }).immediate();
}

function getDiscoveryRun(db, id) {
  const row = db.prepare(`
    SELECT r.*, s.source_key, q.query_key
    FROM discovery_runs r
    JOIN discovery_sources s ON s.id = r.source_id
    LEFT JOIN discovery_queries q ON q.id = r.query_id
    WHERE r.id = ?
  `).get(id);
  if (!row) throw new OpportunityError('NOT_FOUND', `Discovery run not found: ${id}`);
  return serializeDiscoveryRun(row);
}

function listDiscoveryRuns(db, filters = {}) {
  const where = [];
  const params = { limit: normalizeLimit(filters.limit, 50), offset: normalizeOffset(filters.offset) };
  if (filters.source || filters.sourceId || filters.sourceKey) {
    const source = resolveSource(db, filters.source || filters.sourceId || filters.sourceKey);
    where.push('r.source_id = @sourceId'); params.sourceId = source.id;
  }
  if (filters.status) { enumValue(filters.status, RUN_STATUSES, 'run status'); where.push('r.status = @status'); params.status = filters.status; }
  return db.prepare(`
    SELECT r.*, s.source_key, q.query_key FROM discovery_runs r
    JOIN discovery_sources s ON s.id=r.source_id LEFT JOIN discovery_queries q ON q.id=r.query_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY datetime(r.started_at) DESC, r.id DESC LIMIT @limit OFFSET @offset
  `).all(params).map(serializeDiscoveryRun);
}

function serializeDiscoveryRun(row) {
  if (!row) return null;
  return {
    ...row,
    sourceSnapshot: parseStoredJson(row.source_snapshot_json, {}),
    querySnapshot: row.query_snapshot_json === null ? null : parseStoredJson(row.query_snapshot_json, {}),
    effectiveCriteria: parseStoredJson(row.effective_criteria_json, {})
  };
}

function parseStoredJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeLimit(value, fallback = 50) {
  const limit = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new OpportunityError('VALIDATION_ERROR', '--limit must be an integer from 1 to 200');
  return limit;
}

function normalizeOffset(value) {
  if (value === undefined) return 0;
  const offset = Number(value);
  if (!Number.isInteger(offset) || offset < 0) throw new OpportunityError('VALIDATION_ERROR', '--offset must be a nonnegative integer');
  return offset;
}

function ingestOpportunity(db, flags, context = {}) {
  let source = resolveSource(db, flags.source || flags.sourceId || flags.sourceKey || 'manual');
  if (!source.enabled) throw new OpportunityError('SOURCE_DISABLED', `Discovery source is disabled: ${source.source_key}`);
  if (source.policy_state !== 'allowed') throw new OpportunityError('SOURCE_POLICY_DENIED', `Discovery source policy is ${source.policy_state}: ${source.source_key}`);
  const canonicalUrl = canonicalizeUrl(required(flags.url || flags.jobUrl || flags.observedUrl, '--url'));
  const canonicalHash = sha256(canonicalUrl);
  const companyName = required(flags.company || flags.companyName, '--company');
  const title = required(flags.role || flags.title, '--role or --title');
  const observedAt = timestamp(flags.observedAt || flags.fetchedAt, now(context), '--observed-at');
  let run = flags.runId ? getDiscoveryRun(db, positiveId(flags.runId, '--run-id')) : null;
  if (run && run.source_id !== source.id) throw new OpportunityError('PROVENANCE_CONFLICT', 'Discovery run and source do not match');
  if (run && run.status !== 'running') throw new OpportunityError('RUN_CONFLICT', `Cannot ingest into ${run.status} discovery run ${run.id}`);
  const externalId = optional(flags.externalId || flags.providerJobId);
  const provider = optional(flags.provider || (source.adapter === 'manual' ? null : source.adapter));
  if (flags.provider && PROVIDER_BOUND_ADAPTERS.has(source.adapter) && provider !== source.adapter) {
    throw new OpportunityError('PROVENANCE_CONFLICT', `Provider ${provider} does not match source adapter ${source.adapter}`);
  }
  const boardKey = optional(flags.board || flags.boardKey);
  const identityNamespace = externalId ? required(flags.identityNamespace || `${provider || source.adapter}:${boardKey || source.source_key}`, 'identity namespace').toLowerCase() : null;
  const compensation = flags.compensation === undefined && flags.compensationJson === undefined
    ? null
    : parseJson(flags.compensation || flags.compensationJson, '--compensation', {});
  const normalized = {
    company: companyName,
    title,
    canonicalUrl,
    provider,
    boardKey,
    externalId,
    location: optional(flags.location || flags.locationText),
    workplaceType: optional(flags.workplaceType),
    employmentType: optional(flags.employmentType),
    compensation,
    description: optional(readText(flags.description || flags.content, flags.descriptionFile, '--description or --description-file')),
    postedAt: optional(flags.postedAt)
  };
  const normalizedJson = stableJson(normalized);
  const normalizedSha = sha256(normalizedJson);
  const payload = flags.payload === undefined && flags.payloadJson === undefined
    ? normalized
    : parseAnyJson(flags.payload === undefined ? flags.payloadJson : flags.payload, '--payload');
  const payloadSha = sha256(stableJson(payload));
  const rawSha = flags.rawSha256 ? validateSha256(flags.rawSha256, '--raw-sha256') : null;
  const retrieval = {
    httpStatus: nullableInteger(flags.httpStatus, '--http-status'),
    contentType: optional(flags.contentType),
    etag: optional(flags.etag),
    lastModified: optional(flags.lastModified),
    parserName: required(flags.parserName || source.adapter, '--parser-name'),
    parserVersion: required(String(flags.parserVersion === undefined ? '1' : flags.parserVersion), '--parser-version'),
    rawAttachmentPath: optional(flags.attachmentPath || flags.rawAttachmentPath),
    rawSha256: rawSha
  };
  const fingerprint = sha256([companyName, title, normalized.location || ''].map(normalizeFingerprintPart).join('|'));
  const requestedState = enumValue(flags.state || 'inbox', OPPORTUNITY_STATES, 'opportunity state');
  if (requestedState !== 'inbox') {
    throw new OpportunityError('STATE_CONFLICT', 'New opportunities must enter the inbox; use triage, close, or promote for later state changes');
  }
  const state = 'inbox';
  const ingestionKey = sha256(String(flags.idempotencyKey || [source.id, run ? run.id : '', externalId || '', canonicalHash, payloadSha].join('|')));
  const result = db.transaction(() => {
    const freshSource = db.prepare('SELECT * FROM discovery_sources WHERE id=?').get(source.id);
    if (!freshSource) throw new OpportunityError('NOT_FOUND', `Discovery source disappeared: ${source.source_key}`);
    if (!freshSource.enabled) throw new OpportunityError('SOURCE_DISABLED', `Discovery source is disabled: ${freshSource.source_key}`);
    if (freshSource.policy_state !== 'allowed') throw new OpportunityError('SOURCE_POLICY_DENIED', `Discovery source policy is ${freshSource.policy_state}: ${freshSource.source_key}`);
    if (freshSource.adapter !== source.adapter || freshSource.source_key !== source.source_key) {
      throw new OpportunityError('PROVENANCE_CONFLICT', `Discovery source changed during ingestion: ${source.source_key}`);
    }
    source = freshSource;
    if (run) {
      const freshRun = getDiscoveryRun(db, run.id);
      if (freshRun.source_id !== source.id) throw new OpportunityError('PROVENANCE_CONFLICT', 'Discovery run and source do not match');
      if (freshRun.status !== 'running') throw new OpportunityError('RUN_CONFLICT', `Cannot ingest into ${freshRun.status} discovery run ${freshRun.id}`);
      run = freshRun;
    }
    const urlMatch = db.prepare(`
      SELECT o.id FROM opportunities o WHERE o.canonical_url_sha256 = @canonicalHash
      UNION
      SELECT oi.opportunity_id AS id FROM opportunity_identities oi
        WHERE oi.namespace = 'url' AND oi.identity_value = @canonicalHash
      LIMIT 1
    `).get({ canonicalHash });
    const externalMatch = externalId
      ? db.prepare('SELECT opportunity_id AS id FROM opportunity_identities WHERE namespace = ? AND identity_value = ?').get(identityNamespace, externalId)
      : null;
    if (urlMatch && externalMatch && urlMatch.id !== externalMatch.id) {
      throw new OpportunityError('IDENTITY_CONFLICT', 'Canonical URL and provider identity resolve to different opportunities', {
        canonicalOpportunityId: urlMatch.id, identityOpportunityId: externalMatch.id
      });
    }
    const existingId = (externalMatch || urlMatch || {}).id || null;
    const replay = db.prepare(`
      SELECT oo.*, os.normalized_sha256
      FROM opportunity_observations oo
      JOIN opportunity_snapshots os ON os.id=oo.snapshot_id
      WHERE oo.ingestion_key=?
    `).get(ingestionKey);
    if (replay) {
      const sameRequest = replay.source_id === source.id
        && (replay.run_id || null) === (run ? run.id : null)
        && (replay.external_id || null) === (externalId || null)
        && replay.observed_url === canonicalUrl
        && replay.payload_sha256 === payloadSha
        && replay.normalized_sha256 === normalizedSha
        && replay.parser_name === retrieval.parserName
        && replay.parser_version === retrieval.parserVersion
        && (replay.http_status ?? null) === (retrieval.httpStatus ?? null)
        && (replay.content_type || null) === (retrieval.contentType || null)
        && (replay.etag || null) === (retrieval.etag || null)
        && (replay.last_modified || null) === (retrieval.lastModified || null)
        && (replay.raw_attachment_path || null) === (retrieval.rawAttachmentPath || null)
        && (replay.raw_sha256 || null) === (retrieval.rawSha256 || null);
      if (!sameRequest) {
        throw new OpportunityError('IDEMPOTENCY_CONFLICT', 'The idempotency key was already used for a different opportunity observation');
      }
      return {
        opportunityId: replay.opportunity_id,
        snapshotId: replay.snapshot_id,
        observationCreated: false,
        projectionAdvanced: false,
        replayed: true,
        created: false
      };
    }
    let opportunityId = existingId;
    let created = false;
    let projectionAdvanced = false;
    if (!opportunityId) {
      const inserted = db.prepare(`
        INSERT INTO opportunities (
          state, company_name, title, canonical_url, canonical_url_sha256, primary_source_id, provider, board_key, external_id,
          dedupe_fingerprint, location_text, workplace_type, employment_type, compensation_json, description_text, posted_at,
          first_seen_at, last_seen_at, last_verified_at, created_at, updated_at
        ) VALUES (
          @state, @companyName, @title, @canonicalUrl, @canonicalHash, @sourceId, @provider, @boardKey, @externalId,
          @fingerprint, @location, @workplaceType, @employmentType, @compensationJson, @description, @postedAt,
          @observedAt, @observedAt, @observedAt, @observedAt, @observedAt
        )
      `).run({
        state, companyName, title, canonicalUrl, canonicalHash, sourceId: source.id, provider, boardKey, externalId, fingerprint,
        location: normalized.location, workplaceType: normalized.workplaceType, employmentType: normalized.employmentType,
        compensationJson: compensation ? stableJson(compensation) : null, description: normalized.description,
        postedAt: normalized.postedAt, observedAt
      });
      opportunityId = inserted.lastInsertRowid;
      created = true;
      projectionAdvanced = true;
    } else {
      const currentProjection = db.prepare('SELECT last_verified_at FROM opportunities WHERE id=?').get(opportunityId);
      projectionAdvanced = !currentProjection.last_verified_at || Date.parse(observedAt) >= Date.parse(currentProjection.last_verified_at);
      if (projectionAdvanced) {
        db.prepare(`
          UPDATE opportunities SET
            company_name=@companyName, title=@title, canonical_url=@canonicalUrl, canonical_url_sha256=@canonicalHash,
            primary_source_id=COALESCE(primary_source_id,@sourceId), provider=COALESCE(@provider,provider),
            board_key=COALESCE(@boardKey,board_key), external_id=COALESCE(@externalId,external_id),
            dedupe_fingerprint=@fingerprint, location_text=COALESCE(@location,location_text),
            workplace_type=COALESCE(@workplaceType,workplace_type), employment_type=COALESCE(@employmentType,employment_type),
            compensation_json=COALESCE(@compensationJson,compensation_json), description_text=COALESCE(@description,description_text),
            posted_at=COALESCE(@postedAt,posted_at), last_seen_at=@observedAt, last_verified_at=@observedAt, updated_at=@observedAt
          WHERE id=@opportunityId
        `).run({
          opportunityId, companyName, title, canonicalUrl, canonicalHash, sourceId: source.id, provider, boardKey, externalId,
          fingerprint, location: normalized.location, workplaceType: normalized.workplaceType, employmentType: normalized.employmentType,
          compensationJson: compensation ? stableJson(compensation) : null, description: normalized.description,
          postedAt: normalized.postedAt, observedAt
        });
      }
    }

    ensureIdentity(db, opportunityId, 'url', canonicalHash, 1);
    if (externalId) ensureIdentity(db, opportunityId, identityNamespace, externalId, 1);

    const catalogLink = tableExists(db, 'job_postings')
      ? syncLegacyOpportunityCatalog(db, opportunityId)
      : null;
    const jobPostingId = catalogLink ? catalogLink.posting.id : null;
    const postingColumn = jobPostingId ? ', job_posting_id' : '';
    const postingValue = jobPostingId ? ', @jobPostingId' : '';

    db.prepare(`
      INSERT INTO opportunity_snapshots (
        opportunity_id, source_id, observed_url, fetched_at, http_status, content_type, etag, last_modified,
        parser_name, parser_version, raw_attachment_path, raw_sha256, normalized_json, normalized_text, normalized_sha256${postingColumn}
      ) VALUES (
        @opportunityId, @sourceId, @observedUrl, @fetchedAt, @httpStatus, @contentType, @etag, @lastModified,
        @parserName, @parserVersion, @rawAttachmentPath, @rawSha256, @normalizedJson, @normalizedText, @normalizedSha256${postingValue}
      ) ON CONFLICT(opportunity_id, normalized_sha256) DO NOTHING
    `).run({
      opportunityId, sourceId: source.id, observedUrl: canonicalUrl, fetchedAt: observedAt,
      ...retrieval, normalizedJson, normalizedText: normalized.description, normalizedSha256: normalizedSha,
      ...(jobPostingId ? { jobPostingId } : {})
    });
    const snapshot = db.prepare('SELECT * FROM opportunity_snapshots WHERE opportunity_id = ? AND normalized_sha256 = ?').get(opportunityId, normalizedSha);
    const observation = db.prepare(`
      INSERT INTO opportunity_observations (
        opportunity_id, source_id, run_id, snapshot_id, ingestion_key, external_id, observed_url, observed_at, payload_sha256,
        parser_name, parser_version, http_status, content_type, etag, last_modified, raw_attachment_path, raw_sha256${postingColumn}
      ) VALUES (
        @opportunityId, @sourceId, @runId, @snapshotId, @ingestionKey, @externalId, @observedUrl, @observedAt, @payloadSha256,
        @parserName, @parserVersion, @httpStatus, @contentType, @etag, @lastModified, @rawAttachmentPath, @rawSha256${postingValue}
      )
    `).run({
      opportunityId, sourceId: source.id, runId: run ? run.id : null, snapshotId: snapshot.id, ingestionKey,
      externalId, observedUrl: canonicalUrl, observedAt, payloadSha256: payloadSha,
      ...(jobPostingId ? { jobPostingId } : {}), ...retrieval
    });
    if (projectionAdvanced) db.prepare('UPDATE opportunities SET latest_snapshot_id = ? WHERE id = ?').run(snapshot.id, opportunityId);
    if (created) recordOpportunityEvent(db, opportunityId, 'created', null, state, { source: source.source_key, snapshotId: snapshot.id }, observedAt);
    else if (observation.changes) recordOpportunityEvent(db, opportunityId, 'observed', null, null, { source: source.source_key, runId: run ? run.id : null, snapshotId: snapshot.id, projectionAdvanced }, observedAt);
    return { opportunityId, snapshotId: snapshot.id, observationCreated: Boolean(observation.changes), projectionAdvanced, replayed: false, created };
  }).immediate();
  return {
    ...result,
    opportunity: getOpportunity(db, result.opportunityId),
    possibleDuplicateIds: db.prepare('SELECT id FROM opportunities WHERE dedupe_fingerprint = ? AND id <> ? ORDER BY id').all(fingerprint, result.opportunityId).map((row) => row.id)
  };
}

function parseAnyJson(value, label) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { throw new OpportunityError('INVALID_JSON', `${label} must be valid JSON`); }
}

function readText(inline, file, label) {
  if (inline !== undefined && file !== undefined) {
    throw new OpportunityError('INVALID_ARGUMENT', `Use only one of ${label}`);
  }
  if (file === undefined) return inline;
  const resolved = path.resolve(required(file, '--description-file'));
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new OpportunityError('INVALID_ARGUMENT', '--description-file must name a regular file');
  if (stat.size > 5 * 1024 * 1024) throw new OpportunityError('INPUT_TOO_LARGE', '--description-file exceeds 5 MiB');
  return fs.readFileSync(resolved, 'utf8');
}

function validateSha256(value, label) {
  const normalized = String(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new OpportunityError('VALIDATION_ERROR', `${label} must be a SHA-256 hex digest`);
  return normalized;
}

function timestamp(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new OpportunityError('VALIDATION_ERROR', `${label} must be a valid date/time`);
  return date.toISOString();
}

function nullableInteger(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new OpportunityError('VALIDATION_ERROR', `${label} must be an integer`);
  return number;
}

function normalizeFingerprintPart(value) {
  return String(value || '').toLowerCase().normalize('NFKC').replace(/[^a-z0-9+#.]+/g, ' ').trim();
}

function ensureIdentity(db, opportunityId, namespace, identityValue, isPrimary = 0) {
  db.prepare(`
    INSERT INTO opportunity_identities (opportunity_id, namespace, identity_value, is_primary)
    VALUES (?, ?, ?, ?) ON CONFLICT(namespace, identity_value) DO NOTHING
  `).run(opportunityId, namespace, identityValue, isPrimary ? 1 : 0);
  const identity = db.prepare('SELECT opportunity_id FROM opportunity_identities WHERE namespace = ? AND identity_value = ?').get(namespace, identityValue);
  if (identity.opportunity_id !== opportunityId) {
    throw new OpportunityError('IDENTITY_CONFLICT', `Identity ${namespace}:${identityValue} already belongs to opportunity ${identity.opportunity_id}`);
  }
}

function recordOpportunityEvent(db, opportunityId, eventKind, fromState, toState, details, createdAt = new Date().toISOString()) {
  db.prepare(`
    INSERT INTO opportunity_events (opportunity_id, event_kind, from_state, to_state, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(opportunityId, eventKind, fromState, toState, stableJson(details || {}), createdAt);
}

function listOpportunities(db, filters = {}) {
  const where = [];
  const params = { limit: normalizeLimit(filters.limit, 50), offset: normalizeOffset(filters.offset) };
  if (filters.state) { enumValue(filters.state, OPPORTUNITY_STATES, 'opportunity state'); where.push('o.state = @state'); params.state = filters.state; }
  if (filters.source || filters.sourceId || filters.sourceKey) {
    const source = resolveSource(db, filters.source || filters.sourceId || filters.sourceKey);
    where.push('EXISTS (SELECT 1 FROM opportunity_observations oo WHERE oo.opportunity_id=o.id AND oo.source_id=@sourceId)');
    params.sourceId = source.id;
  }
  if (filters.tag) { where.push('EXISTS (SELECT 1 FROM opportunity_tags ot WHERE ot.opportunity_id=o.id AND ot.tag=@tag COLLATE NOCASE)'); params.tag = filters.tag; }
  if (filters.text || filters.q) {
    where.push('(o.company_name LIKE @text OR o.title LIKE @text OR o.location_text LIKE @text OR o.description_text LIKE @text OR o.canonical_url LIKE @text)');
    params.text = `%${filters.text || filters.q}%`;
  }
  if (filters.minScore !== undefined) { where.push('ts.score >= @minScore'); params.minScore = boundedNumber(filters.minScore, '--min-score', 0, 100); }
  if (filters.staleBefore) { where.push('datetime(o.last_verified_at) < datetime(@staleBefore)'); params.staleBefore = timestamp(filters.staleBefore, null, '--stale-before'); }
  const sort = filters.sort || 'freshness';
  if (!SORTS[sort]) throw new OpportunityError('VALIDATION_ERROR', `sort must be one of: ${Object.keys(SORTS).join(', ')}`);
  return db.prepare(`
    SELECT o.*, s.source_key, tl.decision AS latest_decision, ts.score, ts.score_coverage, tl.rationale AS latest_rationale,
      (SELECT count(*) FROM opportunities d WHERE d.dedupe_fingerprint=o.dedupe_fingerprint AND d.id<>o.id) AS possible_duplicate_count,
      (SELECT json_group_array(tag) FROM (
        SELECT tag FROM opportunity_tags WHERE opportunity_id=o.id ORDER BY lower(tag)
      )) AS tags_json
    FROM opportunities o
    LEFT JOIN discovery_sources s ON s.id=o.primary_source_id
    LEFT JOIN opportunity_triage tl ON tl.id=(
      SELECT id FROM opportunity_triage WHERE opportunity_id=o.id
      ORDER BY datetime(created_at) DESC, id DESC LIMIT 1
    )
    LEFT JOIN opportunity_triage ts ON ts.id=(
      SELECT id FROM opportunity_triage WHERE opportunity_id=o.id AND score IS NOT NULL
      ORDER BY datetime(created_at) DESC, id DESC LIMIT 1
    )
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${SORTS[sort]} LIMIT @limit OFFSET @offset
  `).all(params).map(serializeOpportunityRow);
}

function serializeOpportunityRow(row) {
  const { tags_json: tagsJson, ...serialized } = row;
  return {
    ...serialized,
    compensation: parseStoredJson(row.compensation_json, null),
    tags: parseStoredJson(tagsJson, [])
  };
}

function getOpportunity(db, id) {
  const opportunityId = positiveId(id, 'opportunity id');
  const opportunity = db.prepare(`
    SELECT o.*, s.source_key FROM opportunities o
    LEFT JOIN discovery_sources s ON s.id=o.primary_source_id WHERE o.id=?
  `).get(opportunityId);
  if (!opportunity) throw new OpportunityError('NOT_FOUND', `Opportunity not found: ${opportunityId}`);
  return {
    ...serializeOpportunityRow(opportunity),
    identities: db.prepare('SELECT * FROM opportunity_identities WHERE opportunity_id=? ORDER BY is_primary DESC, namespace, identity_value').all(opportunityId),
    observations: db.prepare(`
      SELECT oo.*, s.source_key FROM opportunity_observations oo
      LEFT JOIN discovery_sources s ON s.id=oo.source_id WHERE oo.opportunity_id=?
      ORDER BY datetime(oo.observed_at) DESC, oo.id DESC
    `).all(opportunityId),
    snapshots: db.prepare(`
      SELECT id, opportunity_id, source_id, observed_url, fetched_at, http_status, content_type, etag, last_modified,
        parser_name, parser_version, raw_attachment_path, raw_sha256, normalized_json, normalized_text, normalized_sha256, created_at
      FROM opportunity_snapshots WHERE opportunity_id=? ORDER BY datetime(fetched_at) DESC, id DESC
    `).all(opportunityId),
    triage: db.prepare('SELECT * FROM opportunity_triage WHERE opportunity_id=? ORDER BY datetime(created_at) DESC, id DESC').all(opportunityId).map(serializeTriage),
    tags: db.prepare('SELECT tag, tag_source, created_at FROM opportunity_tags WHERE opportunity_id=? ORDER BY lower(tag)').all(opportunityId),
    events: db.prepare('SELECT * FROM opportunity_events WHERE opportunity_id=? ORDER BY datetime(created_at) DESC, id DESC').all(opportunityId).map((row) => ({ ...row, details: parseStoredJson(row.details_json, {}) }))
  };
}

function serializeTriage(row) {
  return {
    ...row,
    dimensions: parseStoredJson(row.dimensions_json, {}),
    hardBlockers: parseStoredJson(row.hard_blockers_json, []),
    profileEntryRefs: parseStoredJson(row.profile_entry_refs, [])
  };
}

function triageOpportunity(db, flags, context = {}) {
  const opportunityId = positiveId(flags.opportunityId || flags.id, '--opportunity-id');
  const decision = enumValue(required(flags.decision, '--decision'), TRIAGE_DECISIONS, 'triage decision');
  const rationale = required(flags.rationale || flags.notes, '--rationale');
  const dimensions = parseJson(flags.dimensions || flags.dimensionsJson, '--dimensions', {});
  const hardBlockers = parseJson(flags.hardBlockers || flags.hardBlockersJson, '--hard-blockers', [], 'array');
  const profileEntryRefs = parseProfileEntryRefs(flags.profileEntryRefs);
  const score = boundedNumber(flags.score, '--score', 0, 100);
  const coverage = boundedNumber(flags.scoreCoverage || flags.coverage, '--score-coverage', 0, 1);
  if ((score === null) !== (coverage === null)) {
    throw new OpportunityError('VALIDATION_ERROR', '--score and --score-coverage must be provided together');
  }
  const requestedSnapshotId = flags.snapshotId || flags.evidenceSnapshotId
    ? positiveId(flags.snapshotId || flags.evidenceSnapshotId, '--snapshot-id')
    : null;
  const createdAt = now(context);
  const triageId = db.transaction(() => {
    const opportunity = db.prepare('SELECT * FROM opportunities WHERE id=?').get(opportunityId);
    if (!opportunity) throw new OpportunityError('NOT_FOUND', `Opportunity not found: ${opportunityId}`);
    if (opportunity.state === 'promoted' && decision !== 'note') {
      throw new OpportunityError('STATE_CONFLICT', `Opportunity ${opportunityId} is promoted; update the linked application instead`);
    }
    if (opportunity.state === 'closed' && decision !== 'note') {
      throw new OpportunityError('STATE_CONFLICT', `Opportunity ${opportunityId} is closed; reopen it before triage`);
    }
    if (profileEntryRefs.length) {
      if (!tableExists(db, 'profile_entries')) throw new OpportunityError('PROVENANCE_CONFLICT', 'Profile references are unavailable in this store');
      for (const entryId of profileEntryRefs) {
        if (!db.prepare('SELECT 1 FROM profile_entries WHERE id=?').get(entryId)) {
          throw new OpportunityError('PROVENANCE_CONFLICT', `Profile entry ${entryId} does not exist`);
        }
      }
    }
    const evidenceSnapshotId = requestedSnapshotId || opportunity.latest_snapshot_id;
    if (evidenceSnapshotId) {
      const snapshot = db.prepare('SELECT 1 FROM opportunity_snapshots WHERE id=? AND opportunity_id=?').get(evidenceSnapshotId, opportunityId);
      if (!snapshot) throw new OpportunityError('PROVENANCE_CONFLICT', `Snapshot ${evidenceSnapshotId} does not belong to opportunity ${opportunityId}`);
    }
    const nextState = { shortlist: 'shortlisted', watch: 'watching', dismiss: 'dismissed', revisit: 'inbox', note: opportunity.state }[decision];
    const info = db.prepare(`
      INSERT INTO opportunity_triage (
        opportunity_id, decision, score, score_coverage, dimensions_json, hard_blockers_json, rationale,
        evidence_snapshot_id, profile_entry_refs, scorer_kind, scorer_id, rubric_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opportunityId, decision, score, coverage, stableJson(dimensions), stableJson(hardBlockers), rationale,
      evidenceSnapshotId || null, stableJson(profileEntryRefs), flags.scorerKind || 'agent', optional(flags.scorerId),
      String(flags.rubricVersion || '1'), createdAt
    );
    if (nextState !== opportunity.state) {
      db.prepare('UPDATE opportunities SET state=?, updated_at=? WHERE id=?').run(nextState, createdAt, opportunityId);
    }
    recordOpportunityEvent(db, opportunityId, 'triaged', opportunity.state, nextState, { decision, score, coverage, triageId: info.lastInsertRowid }, createdAt);
    return info.lastInsertRowid;
  }).immediate();
  const triage = db.prepare('SELECT * FROM opportunity_triage WHERE id=?').get(triageId);
  return { triage: serializeTriage(triage), opportunity: getOpportunity(db, opportunityId) };
}

function parseProfileEntryRefs(value) {
  if (value === undefined || value === null || value === '') return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(raw.map((item) => positiveId(String(item).trim(), 'profile entry id')))];
}

function tagOpportunity(db, flags, context = {}) {
  const opportunityId = positiveId(flags.opportunityId || flags.id, '--opportunity-id');
  getOpportunity(db, opportunityId);
  const tags = Array.isArray(flags.tags) ? flags.tags : String(flags.tags || flags.tag || '').split(',');
  const normalized = [...new Set(tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))];
  if (!normalized.length) throw new OpportunityError('VALIDATION_ERROR', 'Provide --tag or --tags');
  const createdAt = now(context);
  db.transaction(() => {
    for (const tag of normalized) {
      db.prepare('INSERT INTO opportunity_tags (opportunity_id, tag, tag_source, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(opportunity_id, tag) DO NOTHING')
        .run(opportunityId, tag, flags.tagSource || 'agent', createdAt);
    }
    recordOpportunityEvent(db, opportunityId, 'tagged', null, null, { tags: normalized }, createdAt);
  })();
  return getOpportunity(db, opportunityId);
}

function setOpportunityClosed(db, flags, closed, context = {}) {
  const opportunityId = positiveId(flags.opportunityId || flags.id, '--opportunity-id');
  const createdAt = now(context);
  const nextState = closed ? 'closed' : 'inbox';
  db.transaction(() => {
    const opportunity = db.prepare('SELECT * FROM opportunities WHERE id=?').get(opportunityId);
    if (!opportunity) throw new OpportunityError('NOT_FOUND', `Opportunity not found: ${opportunityId}`);
    if (opportunity.state === 'promoted') throw new OpportunityError('STATE_CONFLICT', 'A promoted opportunity cannot be closed or reopened; update the application instead');
    if (closed && opportunity.state === 'closed') throw new OpportunityError('STATE_CONFLICT', `Opportunity ${opportunityId} is already closed`);
    if (!closed && opportunity.state !== 'closed') throw new OpportunityError('STATE_CONFLICT', `Only a closed opportunity can be reopened; current state is ${opportunity.state}`);
    const update = db.prepare(`
      UPDATE opportunities SET state=@state, closed_at=@closedAt, closed_reason=@closedReason,
        close_confidence=@closeConfidence, updated_at=@updatedAt WHERE id=@id AND state=@expectedState
    `).run({
      id: opportunityId, state: nextState, closedAt: closed ? createdAt : null,
      closedReason: closed ? required(flags.reason, '--reason') : null,
      closeConfidence: closed ? optional(flags.confidence) : null, updatedAt: createdAt,
      expectedState: opportunity.state
    });
    if (update.changes !== 1) throw new OpportunityError('STATE_CONFLICT', `Opportunity ${opportunityId} changed concurrently`);
    recordOpportunityEvent(db, opportunityId, closed ? 'closed' : 'reopened', opportunity.state, nextState, { reason: optional(flags.reason) }, createdAt);
  }).immediate();
  return getOpportunity(db, opportunityId);
}

function promoteOpportunity(db, flags, context = {}) {
  const opportunityId = positiveId(flags.opportunityId || flags.id, '--opportunity-id');
  const createdAt = now(context);
  const notice = 'Promoted from the discovery inbox for consideration; this opportunity has not been submitted or applied to.';
  const notes = [notice, optional(flags.notes)].filter(Boolean).join('\n');
  const result = db.transaction(() => {
    const current = db.prepare('SELECT * FROM opportunities WHERE id=?').get(opportunityId);
    if (!current) throw new OpportunityError('NOT_FOUND', `Opportunity not found: ${opportunityId}`);
    const linked = current.promoted_application_id
      ? db.prepare('SELECT * FROM applications WHERE id=?').get(current.promoted_application_id)
      : db.prepare('SELECT * FROM applications WHERE source_opportunity_id=?').get(opportunityId);
    if (linked) {
      if (!current.promoted_application_id || current.state !== 'promoted' || !current.promoted_at) {
        db.prepare("UPDATE opportunities SET promoted_application_id=?, promoted_at=COALESCE(promoted_at,?), state='promoted', updated_at=? WHERE id=?")
          .run(linked.id, createdAt, createdAt, opportunityId);
      }
      return { created: false, applicationId: linked.id, artifactId: null };
    }
    if (current.state === 'dismissed' || current.state === 'closed') {
      throw new OpportunityError('STATE_CONFLICT', `Revisit or reopen opportunity ${opportunityId} before promotion`);
    }
    const snapshot = current.latest_snapshot_id
      ? db.prepare('SELECT * FROM opportunity_snapshots WHERE id=? AND opportunity_id=?').get(current.latest_snapshot_id, opportunityId)
      : null;
    if (!snapshot) throw new OpportunityError('PROVENANCE_MISSING', 'Cannot promote an opportunity without an immutable snapshot');
    const source = current.primary_source_id ? db.prepare('SELECT * FROM discovery_sources WHERE id=?').get(current.primary_source_id) : null;
    const app = db.prepare(`
      INSERT INTO applications (
        company, role, status, workflow_stage, applied_date, job_url, notes, source_opportunity_id,
        status_changed_at, created_at, updated_at
      ) VALUES (?, ?, 'applied', 'prospective', NULL, ?, ?, ?, ?, ?, ?)
    `).run(current.company_name, current.title, current.canonical_url, notes, opportunityId, createdAt, createdAt, createdAt);
    const applicationId = app.lastInsertRowid;
    if (tableExists(db, 'job_postings')) {
      syncLegacyApplicationCatalog(db, applicationId, {
        openingId: current.job_opening_id,
        postingId: current.primary_job_posting_id,
        relation: 'discovered_via'
      });
    }
    const artifact = db.prepare(`
      INSERT INTO application_artifacts (
        application_id, kind, title, source_url, source_name, citation, notes, content, attachment_path,
        captured_at, created_at, opportunity_snapshot_id
      ) VALUES (?, 'posting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      applicationId, `Job posting snapshot: ${current.title}`, snapshot.observed_url,
      source ? source.label : 'Opportunity discovery',
      `Opportunity #${opportunityId}; immutable snapshot #${snapshot.id}; SHA-256 ${snapshot.normalized_sha256}`,
      notice, snapshot.normalized_text || current.description_text || snapshot.normalized_json,
      snapshot.raw_attachment_path, snapshot.fetched_at, createdAt, snapshot.id
    );
    db.prepare(`
      INSERT INTO application_lifecycle_events (application_id, from_stage, to_stage, event_kind, notes, created_at)
      VALUES (?, NULL, 'prospective', 'opportunity_promoted', ?, ?)
    `).run(applicationId, `${notice} Source opportunity #${opportunityId}; posting artifact #${artifact.lastInsertRowid}.`, createdAt);
    db.prepare(`
      UPDATE opportunities SET state='promoted', promoted_application_id=?, promoted_at=?, updated_at=? WHERE id=?
    `).run(applicationId, createdAt, createdAt, opportunityId);
    recordOpportunityEvent(db, opportunityId, 'promoted', current.state, 'promoted', { applicationId, artifactId: artifact.lastInsertRowid, snapshotId: snapshot.id, submitted: false }, createdAt);
    return { created: true, applicationId, artifactId: artifact.lastInsertRowid };
  }).immediate();
  return {
    created: result.created,
    application: db.prepare('SELECT * FROM applications WHERE id=?').get(result.applicationId),
    ...(result.artifactId ? { postingArtifact: db.prepare('SELECT * FROM application_artifacts WHERE id=?').get(result.artifactId) } : {}),
    opportunity: getOpportunity(db, opportunityId)
  };
}

function sourceCommand(db, args, flags) {
  const action = args[0] || 'list';
  assertAllowedFlags(flags, DISCOVERY_SOURCE_FLAGS[action], `discovery source ${action}`);
  if (action === 'add') return { source: addDiscoverySource(db, flags) };
  if (action === 'update' || action === 'edit') return { source: updateDiscoverySource(db, flags) };
  if (action === 'enable' || action === 'disable') return { source: updateDiscoverySource(db, { ...flags, enabled: action === 'enable' }) };
  if (action === 'show') return { source: serializeSource(resolveSource(db, flags.id || flags.sourceId || flags.key || flags.sourceKey || args[1])) };
  if (action === 'list') return { sources: listDiscoverySources(db, flags) };
  throw new OpportunityError('UNKNOWN_COMMAND', `Unknown discovery source action: ${action}`);
}

function queryCommand(db, args, flags) {
  const action = args[0] || 'list';
  assertAllowedFlags(flags, DISCOVERY_QUERY_FLAGS[action], `discovery query ${action}`);
  if (action === 'add') return { query: addDiscoveryQuery(db, flags) };
  if (action === 'update' || action === 'edit') return { query: updateDiscoveryQuery(db, flags) };
  if (action === 'enable' || action === 'disable') return { query: updateDiscoveryQuery(db, { ...flags, enabled: action === 'enable' }) };
  if (action === 'show') return { query: serializeQuery(resolveQuery(db, flags.id || flags.queryId || flags.key || flags.queryKey || args[1])) };
  if (action === 'list') return { queries: listDiscoveryQueries(db, flags) };
  throw new OpportunityError('UNKNOWN_COMMAND', `Unknown discovery query action: ${action}`);
}

function runCommandGroup(db, args, flags, context) {
  const action = args[0] || 'list';
  assertAllowedFlags(flags, DISCOVERY_RUN_FLAGS[action], `discovery run ${action}`);
  if (action === 'start') return { run: startDiscoveryRun(db, flags, context) };
  if (action === 'finish') return { run: finishDiscoveryRun(db, flags, context) };
  if (action === 'show') return { run: getDiscoveryRun(db, positiveId(flags.runId || flags.id || args[1], '--run-id')) };
  if (action === 'list') return { runs: listDiscoveryRuns(db, flags) };
  throw new OpportunityError('UNKNOWN_COMMAND', `Unknown discovery run action: ${action}`);
}

function discoveryCommand(db, args, flags, context) {
  const group = args[0];
  if (group === 'source' || group === 'sources') return sourceCommand(db, args.slice(1), flags);
  if (group === 'query' || group === 'queries') return queryCommand(db, args.slice(1), flags);
  if (group === 'run' || group === 'runs') return runCommandGroup(db, args.slice(1), flags, context);
  if (group === 'scan-start') return { run: startDiscoveryRun(db, flags, context) };
  if (group === 'scan-finish') return { run: finishDiscoveryRun(db, flags, context) };
  throw new OpportunityError('UNKNOWN_COMMAND', 'Use discovery source, discovery query, or discovery run');
}

function opportunityCommand(db, args, flags, context) {
  const action = args[0] || 'list';
  assertAllowedFlags(flags, OPPORTUNITY_COMMAND_FLAGS[action], `opportunity ${action}`);
  if (action === 'add' || action === 'ingest' || action === 'upsert') {
    const result = ingestOpportunity(db, flags, context);
    // A posting arriving from outside the loop is exactly what the fabric
    // should wake for (lib/fabric-wake.js); the ping is best-effort.
    requestWakeQuietly(db, { reason: `opportunity ${action}: ${result.opportunityId}`, source: 'jobtrack-cli' });
    return result;
  }
  if (action === 'list' || action === 'search') return { opportunities: listOpportunities(db, flags) };
  if (action === 'show' || action === 'read') return { opportunity: getOpportunity(db, flags.opportunityId || flags.id || args[1]) };
  if (action === 'triage') return triageOpportunity(db, flags, context);
  if (action === 'tag') return { opportunity: tagOpportunity(db, flags, context) };
  if (action === 'close') return { opportunity: setOpportunityClosed(db, flags, true, context) };
  if (action === 'reopen') return { opportunity: setOpportunityClosed(db, flags, false, context) };
  if (action === 'promote') return promoteOpportunity(db, flags, context);
  throw new OpportunityError('UNKNOWN_COMMAND', `Unknown opportunity action: ${action}`);
}

function assertAllowedFlags(flags, allowed, label) {
  if (!allowed) return;
  const accepted = new Set(allowed);
  const unknown = Object.keys(flags).filter((key) => !accepted.has(key));
  if (unknown.length) {
    throw new OpportunityError('INVALID_ARGUMENT', `Unknown flag(s) for ${label}: ${unknown.sort().map(toFlagName).join(', ')}`);
  }
  const aliases = [
    ['source', 'sourceId', 'sourceKey'], ['query', 'queryId', 'queryKey'], ['id', 'opportunityId'],
    ['url', 'jobUrl', 'observedUrl'], ['company', 'companyName'], ['role', 'title'],
    ['externalId', 'providerJobId'], ['board', 'boardKey'], ['compensation', 'compensationJson'],
    ['location', 'locationText'], ['description', 'content'], ['payload', 'payloadJson'],
    ['scoreCoverage', 'coverage'], ['snapshotId', 'evidenceSnapshotId']
  ];
  for (const group of aliases) {
    const supplied = group.filter((key) => flags[key] !== undefined);
    if (supplied.length > 1) throw new OpportunityError('INVALID_ARGUMENT', `Conflicting aliases for ${label}: ${supplied.map(toFlagName).join(', ')}`);
  }
}

function toFlagName(key) {
  return `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

function runOpportunityCommand(db, args, flags = {}, context = {}) {
  if (!Array.isArray(args) || !args.length) throw new OpportunityError('UNKNOWN_COMMAND', 'Provide discovery or opportunity command arguments');
  const namespace = args[0];
  if (namespace === 'discovery') return discoveryCommand(db, args.slice(1), flags, context);
  if (namespace === 'opportunity' || namespace === 'opportunities') return opportunityCommand(db, args.slice(1), flags, context);
  if (context.namespace === 'discovery') return discoveryCommand(db, args, flags, context);
  if (context.namespace === 'opportunity') return opportunityCommand(db, args, flags, context);
  throw new OpportunityError('UNKNOWN_COMMAND', 'First command argument must be discovery or opportunity');
}

module.exports = {
  OPPORTUNITY_HARDENING_SCHEMA_VERSION,
  OPPORTUNITY_PROVENANCE_SCHEMA_VERSION,
  OPPORTUNITY_SCHEMA_VERSION,
  OpportunityError,
  canonicalizeUrl,
  getDiscoveryRun,
  getOpportunity,
  ingestOpportunity,
  listDiscoveryQueries,
  listDiscoveryRuns,
  listDiscoverySources,
  listOpportunities,
  migrateOpportunities,
  promoteOpportunity,
  runOpportunityCommand
};
