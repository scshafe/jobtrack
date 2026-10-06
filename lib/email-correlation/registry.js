'use strict';
// lib/email-correlation/registry.js — schema/seed support and read-only sender
// identity registry access for S2. All runtime projection mutations, including
// operator facts and S6 learning/retraction, are owned by learn.js.

const { domainMatches, normalizeDomain, RULE_SET } = require('./domain-classes');
const { createCorrelationStore } = require('./candidates');
const { identifySender: identifySenderSignals } = require('./identity');
const { normalizeMentionText } = require('./normalize');
const { extractSignals } = require('./signals');

const REGISTRY_SCHEMA_VERSION = 2026090201;
const REGISTRY_MIGRATION_NAME = 'email_correlation_registry';
const REGISTRY_CONTROLS_SCHEMA_VERSION = 2026090204;
const REGISTRY_CONTROLS_MIGRATION_NAME = 'email_registry_operator_controls';
const LEARNING_KINDS = new Set(['contact', 'domain', 'title_alias']);

class EmailCorrelationRegistryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'EmailCorrelationRegistryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function relationExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name));
}

function tableColumns(db, name) {
  return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name));
}

// ---------------------------------------------------------------------------
// Migration

function migrateEmailCorrelationRegistry(db) {
  if (!tableExists(db, 'jobtrack_schema_migrations')) {
    throw new EmailCorrelationRegistryError('STORE_NOT_INITIALIZED', 'jobtrack_schema_migrations is missing; run the email integration migration first');
  }
  const migration = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?').get(REGISTRY_SCHEMA_VERSION);
  if (migration && migration.name !== REGISTRY_MIGRATION_NAME) {
    throw new EmailCorrelationRegistryError('MIGRATION_CONFLICT', `Schema version ${REGISTRY_SCHEMA_VERSION} is already named ${migration.name}`);
  }
  if (!migration) {
    const nameConflict = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?').get(REGISTRY_MIGRATION_NAME);
    if (nameConflict) {
      throw new EmailCorrelationRegistryError('MIGRATION_CONFLICT', `Migration ${REGISTRY_MIGRATION_NAME} is already registered as version ${nameConflict.version}`);
    }
    db.exec(`
      CREATE TABLE email_identity_learnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('contact','domain','title_alias')),
        company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
        application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
        value TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        source_message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
        source_correlation_id INTEGER REFERENCES job_email_correlations(id) ON DELETE SET NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        retracted_at TEXT,
        retracted_by TEXT,
        CHECK (trim(value) <> ''),
        CHECK (trim(normalized_value) <> ''),
        CHECK (trim(actor) <> ''),
        CHECK ((kind='title_alias' AND application_id IS NOT NULL) OR (kind<>'title_alias' AND company_id IS NOT NULL))
      );
      -- NULL-safe uniqueness (a UNIQUE constraint treats NULLs as distinct).
      CREATE UNIQUE INDEX idx_email_identity_learnings_identity
        ON email_identity_learnings(kind, normalized_value, COALESCE(company_id, 0), COALESCE(application_id, 0), source_message_ref_id);
      CREATE INDEX idx_email_identity_learnings_source ON email_identity_learnings(source_message_ref_id);
      CREATE INDEX idx_email_identity_learnings_value ON email_identity_learnings(kind, normalized_value);

      CREATE TABLE application_title_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        normalized_alias TEXT NOT NULL,
        source_learning_id INTEGER REFERENCES email_identity_learnings(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(alias) <> ''),
        UNIQUE(application_id, normalized_alias)
      );

      CREATE TABLE email_domain_classes (
        domain TEXT PRIMARY KEY,
        class TEXT NOT NULL CHECK (class IN ('corporate','ats','consumer')),
        source TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (domain = lower(trim(domain)) AND domain <> '')
      );
    `);
    db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)').run(REGISTRY_SCHEMA_VERSION, REGISTRY_MIGRATION_NAME);
  }
  seedDomainClasses(db);
  migrateRegistryOperatorControls(db);
}

function migrateRegistryOperatorControls(db) {
  const migration = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?').get(REGISTRY_CONTROLS_SCHEMA_VERSION);
  if (migration && migration.name !== REGISTRY_CONTROLS_MIGRATION_NAME) {
    throw new EmailCorrelationRegistryError('MIGRATION_CONFLICT', `Schema version ${REGISTRY_CONTROLS_SCHEMA_VERSION} is already named ${migration.name}`);
  }
  if (migration) return;
  const nameConflict = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?').get(REGISTRY_CONTROLS_MIGRATION_NAME);
  if (nameConflict) {
    throw new EmailCorrelationRegistryError('MIGRATION_CONFLICT', `Migration ${REGISTRY_CONTROLS_MIGRATION_NAME} is already registered as version ${nameConflict.version}`);
  }
  db.exec(`
    CREATE TABLE email_identity_registry_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL CHECK (operation IN ('add','retract')),
      target_fact_id INTEGER REFERENCES email_identity_registry_facts(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK (kind IN ('domain_class','domain','contact')),
      company_id INTEGER REFERENCES companies(id) ON DELETE RESTRICT,
      value TEXT NOT NULL,
      normalized_value TEXT NOT NULL,
      domain_class TEXT CHECK (domain_class IN ('corporate','ats','consumer')),
      display_name TEXT,
      source TEXT NOT NULL CHECK (source='operator'),
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      owns_projection INTEGER NOT NULL DEFAULT 0 CHECK (owns_projection IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(value) <> '' AND trim(normalized_value) <> ''),
      CHECK (trim(actor) <> '' AND trim(reason) <> ''),
      CHECK ((operation='add' AND target_fact_id IS NULL) OR (operation='retract' AND target_fact_id IS NOT NULL)),
      CHECK ((kind='domain_class' AND company_id IS NULL AND domain_class IS NOT NULL)
          OR (kind IN ('domain','contact') AND company_id IS NOT NULL AND domain_class IS NULL))
    );
    CREATE UNIQUE INDEX idx_email_identity_registry_fact_retraction
      ON email_identity_registry_facts(target_fact_id) WHERE operation='retract';
    CREATE INDEX idx_email_identity_registry_fact_lookup
      ON email_identity_registry_facts(kind,normalized_value,company_id,id DESC);
    CREATE TRIGGER email_identity_registry_facts_append_only_update
      BEFORE UPDATE ON email_identity_registry_facts
      BEGIN SELECT RAISE(ABORT, 'email identity registry facts are append-only'); END;
    CREATE TRIGGER email_identity_registry_facts_append_only_delete
      BEFORE DELETE ON email_identity_registry_facts
      BEGIN SELECT RAISE(ABORT, 'email identity registry facts are append-only'); END;

    CREATE TABLE email_link_retractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
      application_id INTEGER REFERENCES applications(id) ON DELETE RESTRICT,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(actor) <> '' AND trim(reason) <> '')
    );
    CREATE UNIQUE INDEX idx_email_link_retractions_pair
      ON email_link_retractions(message_ref_id,COALESCE(application_id,0));
    CREATE INDEX idx_email_link_retractions_application
      ON email_link_retractions(application_id,created_at DESC);
    CREATE TRIGGER email_link_retractions_append_only_update
      BEFORE UPDATE ON email_link_retractions
      BEGIN SELECT RAISE(ABORT, 'email link retractions are append-only'); END;
    CREATE TRIGGER email_link_retractions_append_only_delete
      BEFORE DELETE ON email_link_retractions
      BEGIN SELECT RAISE(ABORT, 'email link retractions are append-only'); END;

    CREATE VIEW active_job_email_application_links AS
      SELECT link.* FROM job_email_application_links link
      WHERE NOT EXISTS (
        SELECT 1 FROM email_link_retractions retraction
        WHERE retraction.message_ref_id=link.message_ref_id
          AND (retraction.application_id IS NULL OR retraction.application_id=link.application_id)
      );
    CREATE VIEW active_job_email_linked_correlations AS
      SELECT correlation.* FROM job_email_correlations correlation
      WHERE correlation.resolution='linked'
        AND correlation.resolved_application_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM email_link_retractions retraction
          WHERE retraction.message_ref_id=correlation.message_ref_id
            AND (retraction.application_id IS NULL OR retraction.application_id=correlation.resolved_application_id)
        );
  `);
  db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)')
    .run(REGISTRY_CONTROLS_SCHEMA_VERSION, REGISTRY_CONTROLS_MIGRATION_NAME);
}

/** Idempotent: every rule-set domain is present; operator rows are never overwritten. */
function seedDomainClasses(db) {
  const insert = db.prepare("INSERT OR IGNORE INTO email_domain_classes(domain, class, source) VALUES (?, ?, ?)");
  const source = `rule-set:${RULE_SET.ruleSetVersion}`;
  const seed = db.transaction(() => {
    for (const domain of RULE_SET.ats) insert.run(normalizeDomain(domain), 'ats', source);
    for (const domain of RULE_SET.consumer) insert.run(normalizeDomain(domain), 'consumer', source);
  });
  seed();
}

// ---------------------------------------------------------------------------
// Normalization shared with the catalog

function normalizeName(value) {
  return normalizeMentionText(String(value ?? ''));
}

function normalizeTitleForAlias(db, value) {
  return normalizeMentionText(String(value ?? ''));
}

// ---------------------------------------------------------------------------
// Reading the registry

function companyForApplication(db, applicationId) {
  const row = db.prepare(`
    SELECT o.company_id AS company_id FROM applications a
    JOIN job_openings o ON o.id = a.job_opening_id
    WHERE a.id=?
  `).get(applicationId);
  return row ? row.company_id : null;
}

function companiesByContact(db, address) {
  if (!tableExists(db, 'company_contacts') || !address) return [];
  return db.prepare("SELECT DISTINCT company_id AS id FROM company_contacts WHERE email IS NOT NULL AND lower(email)=lower(?)").all(address).map((row) => row.id);
}

function companiesByDomain(db, domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return [];
  const matched = new Set();
  if (tableExists(db, 'companies') && tableColumns(db, 'companies').has('website_domain')) {
    for (const row of db.prepare("SELECT id, website_domain FROM companies WHERE website_domain IS NOT NULL AND trim(website_domain) <> ''").all()) {
      const companyDomain = normalizeDomain(row.website_domain);
      if (companyDomain && domainMatches(normalized, companyDomain)) matched.add(row.id);
    }
  }
  if (tableExists(db, 'company_aliases') && tableColumns(db, 'company_aliases').has('alias_kind')) {
    for (const row of db.prepare("SELECT company_id AS id, alias FROM company_aliases WHERE alias_kind='domain'").all()) {
      const aliasDomain = normalizeDomain(row.alias);
      if (aliasDomain && domainMatches(normalized, aliasDomain)) matched.add(row.id);
    }
  }
  return [...matched];
}

function companiesByName(db, name) {
  const normalized = normalizeName(name);
  if (!normalized || !tableExists(db, 'companies')) return [];
  const matched = new Set();
  for (const row of db.prepare('SELECT id, normalized_name FROM companies').all()) {
    if (normalizeName(row.normalized_name) === normalized) matched.add(row.id);
  }
  if (tableExists(db, 'company_aliases')) {
    for (const row of db.prepare("SELECT company_id AS id, normalized_alias FROM company_aliases WHERE alias_kind <> 'domain'").all()) {
      if (normalizeName(row.normalized_alias) === normalized) matched.add(row.id);
    }
  }
  return [...matched];
}

/**
 * Who sent this? The ladder from the design: known contact address, employer
 * domain (registry or catalog), then the company named in the facts. Returns
 * every company the evidence supports; the bases decide what to do with them.
 * @returns {{ companyIds: number[], basis: 'contact'|'domain'|'mention'|'none', confidence: number, domainClass: string }}
 */
function identifySender(db, facts) {
  return identifySenderSignals(extractSignals(facts), createCorrelationStore(db));
}

// Learning writes live exclusively in learn.js.

const REGISTRY_FACT_KINDS = new Set(['domain_class', 'domain', 'contact']);
const DOMAIN_CLASSES = new Set(['corporate', 'ats', 'consumer']);
const ADDRESS_PATTERN = /^[^\s@,<>()]+@[^\s@,<>()]+$/;

function requiredEditText(value, label, maxLength) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength) throw new EmailCorrelationRegistryError('INVALID_INPUT', `${label} must contain 1 to ${maxLength} characters`);
  return text;
}

function normalizedAddress(value) {
  const address = String(value ?? '').trim().toLowerCase();
  if (!ADDRESS_PATTERN.test(address)) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'address must be one canonical mailbox address');
  const parts = address.split('@');
  const domain = parts.length === 2 ? normalizeDomain(parts[1]) : '';
  if (!domain) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'address must contain a valid domain');
  return `${parts[0]}@${domain}`;
}

function requireCompany(db, raw) {
  const companyId = Number(raw);
  if (!Number.isInteger(companyId) || companyId < 1) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'companyId must be a positive integer');
  if (!db.prepare('SELECT 1 FROM companies WHERE id=?').get(companyId)) throw new EmailCorrelationRegistryError('NOT_FOUND', `company ${companyId} not found`);
  return companyId;
}

function normalizeRegistryFactInput(db, input) {
  const kind = String(input.kind ?? '').trim().replace('-', '_');
  if (!REGISTRY_FACT_KINDS.has(kind)) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'kind must be domain-class, domain, or contact');
  const actor = requiredEditText(input.actor, 'actor', 120);
  const reason = requiredEditText(input.reason, 'reason', 1000);
  if (kind === 'domain_class') {
    if (input.companyId !== undefined || input.address !== undefined || input.name !== undefined) {
      throw new EmailCorrelationRegistryError('INVALID_INPUT', 'domain-class facts accept only domain and class identity fields');
    }
    const domain = normalizeDomain(input.domain);
    if (!domain) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'domain must be a valid DNS domain');
    const domainClass = input.class === undefined ? null : String(input.class).trim();
    if (domainClass !== null && !DOMAIN_CLASSES.has(domainClass)) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'class must be corporate, ats, or consumer');
    return { kind, companyId: null, value: domain, normalizedValue: domain, domainClass, displayName: null, actor, reason };
  }
  const companyId = requireCompany(db, input.companyId);
  if (kind === 'domain') {
    if (input.address !== undefined || input.name !== undefined || input.class !== undefined) {
      throw new EmailCorrelationRegistryError('INVALID_INPUT', 'domain facts accept only companyId and domain identity fields');
    }
    const domain = normalizeDomain(input.domain);
    if (!domain) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'domain must be a valid DNS domain');
    return { kind, companyId, value: domain, normalizedValue: domain, domainClass: null, displayName: null, actor, reason };
  }
  if (input.domain !== undefined || input.class !== undefined) {
    throw new EmailCorrelationRegistryError('INVALID_INPUT', 'contact facts accept only companyId, address, and name identity fields');
  }
  const address = normalizedAddress(input.address);
  const displayName = String(input.name ?? '').trim() || address.split('@')[0];
  if (displayName.length > 200) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'name must contain at most 200 characters');
  return { kind, companyId, value: address, normalizedValue: address, domainClass: null, displayName, actor, reason };
}

function activeOperatorFact(db, fact) {
  return db.prepare(`
    SELECT addition.* FROM email_identity_registry_facts addition
    WHERE addition.operation='add' AND addition.kind=? AND addition.normalized_value=?
      AND addition.company_id IS ?
      AND NOT EXISTS (
        SELECT 1 FROM email_identity_registry_facts retraction
        WHERE retraction.operation='retract' AND retraction.target_fact_id=addition.id
      )
    ORDER BY addition.id DESC LIMIT 1
  `).get(fact.kind, fact.normalizedValue, fact.companyId);
}

function listRegistryFacts(db, { kind, companyId, domain, address, includeRetracted = true } = {}) {
  if (!tableExists(db, 'email_identity_registry_facts')) return [];
  const clauses = ["addition.operation='add'"];
  const params = [];
  if (kind) { clauses.push('addition.kind=?'); params.push(String(kind).replace('-', '_')); }
  if (companyId !== undefined) { clauses.push('addition.company_id=?'); params.push(Number(companyId)); }
  let normalizedValue = domain ? normalizeDomain(domain) : '';
  if (address) {
    try { normalizedValue = normalizedAddress(address); } catch { return []; }
  }
  if (normalizedValue) { clauses.push('addition.normalized_value=?'); params.push(normalizedValue); }
  if (!includeRetracted) clauses.push('retraction.id IS NULL');
  return db.prepare(`
    SELECT addition.*,retraction.id AS retraction_id,retraction.actor AS retracted_by,
      retraction.reason AS retraction_reason,retraction.created_at AS retracted_at
    FROM email_identity_registry_facts addition
    LEFT JOIN email_identity_registry_facts retraction
      ON retraction.operation='retract' AND retraction.target_fact_id=addition.id
    WHERE ${clauses.join(' AND ')} ORDER BY addition.id
  `).all(...params);
}

function listLearnings(db, { messageRefId, companyId, applicationId } = {}) {
  if (!tableExists(db, 'email_identity_learnings')) return [];
  const clauses = ['1=1'];
  const params = [];
  if (messageRefId !== undefined) { clauses.push('source_message_ref_id=?'); params.push(Number(messageRefId)); }
  if (companyId !== undefined) { clauses.push('company_id=?'); params.push(Number(companyId)); }
  if (applicationId !== undefined) { clauses.push('application_id=?'); params.push(Number(applicationId)); }
  return db.prepare(`SELECT * FROM email_identity_learnings WHERE ${clauses.join(' AND ')} ORDER BY id`).all(...params);
}

module.exports = {
  EmailCorrelationRegistryError,
  LEARNING_KINDS,
  REGISTRY_CONTROLS_MIGRATION_NAME,
  REGISTRY_CONTROLS_SCHEMA_VERSION,
  REGISTRY_MIGRATION_NAME,
  REGISTRY_SCHEMA_VERSION,
  companiesByContact,
  companiesByDomain,
  companiesByName,
  companyForApplication,
  activeOperatorFact,
  identifySender,
  listLearnings,
  listRegistryFacts,
  migrateEmailCorrelationRegistry,
  normalizeRegistryFactInput,
  normalizeTitleForAlias,
  relationExists,
  seedDomainClasses,
  tableExists
};
