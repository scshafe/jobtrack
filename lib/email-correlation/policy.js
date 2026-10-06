'use strict';

const crypto = require('node:crypto');

const POLICY_SCHEMA_VERSION = 2026090202;
const POLICY_MIGRATION_NAME = 'email_correlation_policy_revisions';
// v2 (2026-09-05) dropped `clarify.secondNudge`: the knob was validated and
// seeded but never read, and the design decision it pretended to offer is
// fixed — a clarification is asked once and never nudged again (DECISIONS
// D-031). Revisions written under v1 stay loadable: their stored bytes and
// digests are untouched, and the legacy key is projected away at load.
const POLICY_DOCUMENT_VERSION = 'email-correlation-policy.v2';
const LEGACY_POLICY_DOCUMENT_VERSION = 'email-correlation-policy.v1';
const BASIS_NAMES = Object.freeze([
  'provider_application_id', 'previously_linked_message', 'previously_linked_thread',
  'exact_posting_occurrence', 'exact_posting_url', 'clarification_reply',
  'body_role_title', 'company_single_open', 'company_and_role', 'sender_contact',
  'company_mention', 'company_domain', 'company_only', 'fuzzy'
]);

const DEFAULT_POLICY = deepFreeze({
  schemaVersion: POLICY_DOCUMENT_VERSION,
  policyKey: 'default',
  priorities: {
    provider_application_id: 100,
    clarification_reply: 100,
    previously_linked_message: 99,
    previously_linked_thread: 98,
    exact_posting_occurrence: 97,
    exact_posting_url: 90,
    body_role_title: 70,
    company_single_open: 60,
    company_and_role: 50,
    sender_contact: 45,
    company_mention: 42,
    company_domain: 40,
    company_only: 30,
    fuzzy: 10
  },
  exactBases: [
    'provider_application_id', 'clarification_reply', 'previously_linked_message',
    'previously_linked_thread', 'exact_posting_occurrence', 'exact_posting_url'
  ],
  thresholds: {
    titleSimilarity: 0.6,
    preferredConfidence: 0.65,
    preferredMargin: 0.15,
    recencyDays: 90,
    recencyBoost: 0.04,
    stageBoost: 0.05,
    stagePenalty: 0.05
  },
  autoLink: {
    normalizedExact: true,
    companySingleOpen: true
  },
  clarify: {
    enabled: true,
    minimumCandidates: 2,
    sameCompany: true,
    expiryDays: 3
  }
});

/** The default document exactly as stores seeded before 2026-09-05 hold it
 * (revision 1 under v1). Its digest is what `seedDefaultPolicy` must keep
 * accepting, because revision 1 is append-only and cannot be rewritten. */
const LEGACY_DEFAULT_POLICY = deepFreeze({
  ...DEFAULT_POLICY,
  schemaVersion: LEGACY_POLICY_DOCUMENT_VERSION,
  clarify: { ...DEFAULT_POLICY.clarify, secondNudge: false }
});

class EmailCorrelationPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmailCorrelationPolicyError';
    this.code = code;
  }
}

function migrateCorrelationPolicy(db) {
  if (!tableExists(db, 'jobtrack_schema_migrations')) {
    throw new EmailCorrelationPolicyError('STORE_NOT_INITIALIZED', 'jobtrack_schema_migrations is missing');
  }
  const existing = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?').get(POLICY_SCHEMA_VERSION);
  if (existing && existing.name !== POLICY_MIGRATION_NAME) {
    throw new EmailCorrelationPolicyError('MIGRATION_CONFLICT', `Schema version ${POLICY_SCHEMA_VERSION} is already named ${existing.name}`);
  }
  if (!existing) {
    const nameConflict = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?').get(POLICY_MIGRATION_NAME);
    if (nameConflict) throw new EmailCorrelationPolicyError('MIGRATION_CONFLICT', `Migration ${POLICY_MIGRATION_NAME} is already version ${nameConflict.version}`);
    createPolicyRevisionsTable(db);
    db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)').run(POLICY_SCHEMA_VERSION, POLICY_MIGRATION_NAME);
  }
  seedDefaultPolicy(db);
}

function createPolicyRevisionsTable(db) {
  db.exec(`
      CREATE TABLE email_correlation_policy_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        policy_key TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
        policy_digest TEXT NOT NULL CHECK (length(policy_digest)=64),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(policy_key) <> '' AND trim(created_by) <> ''),
        UNIQUE(policy_key, revision),
        UNIQUE(policy_digest)
      );
      CREATE TRIGGER email_correlation_policy_revisions_no_update
      BEFORE UPDATE ON email_correlation_policy_revisions BEGIN
        SELECT RAISE(ABORT, 'email correlation policy revisions are append-only');
      END;
      CREATE TRIGGER email_correlation_policy_revisions_no_delete
      BEFORE DELETE ON email_correlation_policy_revisions BEGIN
        SELECT RAISE(ABORT, 'email correlation policy revisions are append-only');
      END;
  `);
}

function seedDefaultPolicy(db) {
  const json = canonicalJson(validatePolicy(DEFAULT_POLICY));
  const digest = crypto.createHash('sha256').update(json).digest('hex');
  const existing = db.prepare(`
    SELECT policy_digest FROM email_correlation_policy_revisions
    WHERE policy_key='default' AND revision=1
  `).get();
  if (existing) {
    // A store seeded before v2 holds the v1 default as its immutable
    // revision 1; that is the same policy, so it is accepted as-is.
    if (existing.policy_digest !== digest && existing.policy_digest !== LEGACY_DEFAULT_POLICY_DIGEST) {
      throw new EmailCorrelationPolicyError(
        'POLICY_DIGEST_MISMATCH',
        'Seeded email correlation policy revision 1 does not match the built-in default'
      );
    }
    return;
  }
  // Check before inserting instead of relying on INSERT OR IGNORE. Replaying
  // migrations is intentionally allocation-free so a policyRevisionId remains
  // a stable, unsurprising replay token.
  db.prepare(`
    INSERT INTO email_correlation_policy_revisions
      (policy_key,revision,policy_json,policy_digest,created_by)
    VALUES ('default',1,?,?,?)
  `).run(json, digest, 'jobtrack:default');
}

function loadPolicy(storeOrDb, revisionId) {
  const db = storeOrDb.db || storeOrDb;
  if (!tableExists(db, 'email_correlation_policy_revisions')) {
    throw new EmailCorrelationPolicyError('STORE_NOT_MIGRATED', 'email_correlation_policy_revisions is missing');
  }
  let row;
  if (revisionId !== undefined && revisionId !== null) {
    row = db.prepare('SELECT * FROM email_correlation_policy_revisions WHERE id=?').get(Number(revisionId));
  } else {
    row = db.prepare("SELECT * FROM email_correlation_policy_revisions WHERE policy_key='default' ORDER BY revision DESC,id DESC LIMIT 1").get();
  }
  if (!row) throw new EmailCorrelationPolicyError('POLICY_NOT_FOUND', `Email correlation policy revision not found: ${revisionId ?? 'default'}`);
  const stored = validatePolicy(JSON.parse(row.policy_json));
  const expected = crypto.createHash('sha256').update(canonicalJson(stored)).digest('hex');
  if (row.policy_digest !== expected) throw new EmailCorrelationPolicyError('POLICY_DIGEST_MISMATCH', `Email correlation policy revision ${row.id} failed its digest check`);
  // The digest covers the bytes as written; the runtime sees one shape.
  return deepFreeze({ ...upgradePolicyDocument(stored), revisionId: row.id, revision: row.revision, digest: row.policy_digest });
}

/** The current document shape for any valid document: a v1 document loses
 * the never-read `clarify.secondNudge` key and is stamped v2; a v2 document
 * is returned unchanged. Pure; the input is not mutated. */
function upgradePolicyDocument(rawPolicy) {
  const policy = validatePolicy(rawPolicy);
  if (policy.schemaVersion === POLICY_DOCUMENT_VERSION) return policy;
  const { secondNudge, ...clarify } = policy.clarify;
  return { ...policy, schemaVersion: POLICY_DOCUMENT_VERSION, clarify };
}

function insertPolicyRevision(storeOrDb, rawPolicy, createdBy = 'operator') {
  const db = storeOrDb.db || storeOrDb;
  // New revisions are always written in the current shape, so a caller that
  // starts from an older revision's document does not carry the dead key on.
  const policy = upgradePolicyDocument(rawPolicy);
  const actor = String(createdBy).trim();
  if (!actor) throw new EmailCorrelationPolicyError('INVALID_POLICY', 'createdBy is required');
  const json = canonicalJson(policy);
  const policyDigest = crypto.createHash('sha256').update(json).digest('hex');
  const latest = db.prepare('SELECT max(revision) AS revision FROM email_correlation_policy_revisions WHERE policy_key=?').get(policy.policyKey);
  const revision = Number(latest?.revision || 0) + 1;
  const info = db.prepare(`
    INSERT INTO email_correlation_policy_revisions
      (policy_key,revision,policy_json,policy_digest,created_by)
    VALUES (?,?,?,?,?)
  `).run(policy.policyKey, revision, json, policyDigest, actor);
  return loadPolicy(db, Number(info.lastInsertRowid));
}

function validatePolicy(value) {
  if (!plainObject(value)) throw new EmailCorrelationPolicyError('INVALID_POLICY', 'policy must be an object');
  exactKeys(value, ['schemaVersion', 'policyKey', 'priorities', 'exactBases', 'thresholds', 'autoLink', 'clarify'], 'policy');
  const legacy = value.schemaVersion === LEGACY_POLICY_DOCUMENT_VERSION;
  if (!legacy && value.schemaVersion !== POLICY_DOCUMENT_VERSION) throw new EmailCorrelationPolicyError('INVALID_POLICY', `policy.schemaVersion must be ${POLICY_DOCUMENT_VERSION}`);
  if (typeof value.policyKey !== 'string' || !value.policyKey.trim()) throw new EmailCorrelationPolicyError('INVALID_POLICY', 'policy.policyKey is required');
  exactKeys(value.priorities, BASIS_NAMES, 'policy.priorities');
  for (const basis of BASIS_NAMES) integerRange(value.priorities[basis], 0, 1000, `policy.priorities.${basis}`);
  if (!Array.isArray(value.exactBases) || new Set(value.exactBases).size !== value.exactBases.length
    || value.exactBases.some((basis) => !BASIS_NAMES.includes(basis))) {
    throw new EmailCorrelationPolicyError('INVALID_POLICY', 'policy.exactBases must be unique known bases');
  }
  exactKeys(value.thresholds, ['titleSimilarity', 'preferredConfidence', 'preferredMargin', 'recencyDays', 'recencyBoost', 'stageBoost', 'stagePenalty'], 'policy.thresholds');
  for (const key of ['titleSimilarity', 'preferredConfidence', 'preferredMargin', 'recencyBoost', 'stageBoost', 'stagePenalty']) range(value.thresholds[key], 0, 1, `policy.thresholds.${key}`);
  integerRange(value.thresholds.recencyDays, 1, 3650, 'policy.thresholds.recencyDays');
  exactKeys(value.autoLink, ['normalizedExact', 'companySingleOpen'], 'policy.autoLink');
  for (const key of ['normalizedExact', 'companySingleOpen']) bool(value.autoLink[key], `policy.autoLink.${key}`);
  // v1 documents carried `secondNudge`, a switch nothing ever read; it stays
  // valid there only so stored revisions keep verifying against their digest.
  exactKeys(value.clarify, legacy
    ? ['enabled', 'minimumCandidates', 'sameCompany', 'expiryDays', 'secondNudge']
    : ['enabled', 'minimumCandidates', 'sameCompany', 'expiryDays'], 'policy.clarify');
  bool(value.clarify.enabled, 'policy.clarify.enabled');
  bool(value.clarify.sameCompany, 'policy.clarify.sameCompany');
  if (legacy) bool(value.clarify.secondNudge, 'policy.clarify.secondNudge');
  integerRange(value.clarify.minimumCandidates, 2, 50, 'policy.clarify.minimumCandidates');
  integerRange(value.clarify.expiryDays, 1, 30, 'policy.clarify.expiryDays');
  return JSON.parse(JSON.stringify(value));
}

function exactKeys(value, expected, path) {
  if (!plainObject(value)) throw new EmailCorrelationPolicyError('INVALID_POLICY', `${path} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new EmailCorrelationPolicyError('INVALID_POLICY', `${path} has unexpected keys`);
  }
}

function range(value, min, max, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new EmailCorrelationPolicyError('INVALID_POLICY', `${path} must be between ${min} and ${max}`);
}

function integerRange(value, min, max, path) {
  if (!Number.isInteger(value) || value < min || value > max) throw new EmailCorrelationPolicyError('INVALID_POLICY', `${path} must be an integer between ${min} and ${max}`);
}

function bool(value, path) {
  if (typeof value !== 'boolean') throw new EmailCorrelationPolicyError('INVALID_POLICY', `${path} must be boolean`);
}

function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function tableExists(db, name) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const LEGACY_DEFAULT_POLICY_DIGEST = crypto.createHash('sha256')
  .update(canonicalJson(validatePolicy(LEGACY_DEFAULT_POLICY))).digest('hex');

module.exports = {
  BASIS_NAMES,
  DEFAULT_POLICY,
  EmailCorrelationPolicyError,
  LEGACY_DEFAULT_POLICY,
  LEGACY_DEFAULT_POLICY_DIGEST,
  LEGACY_POLICY_DOCUMENT_VERSION,
  POLICY_DOCUMENT_VERSION,
  POLICY_MIGRATION_NAME,
  POLICY_SCHEMA_VERSION,
  createPolicyRevisionsTable,
  insertPolicyRevision,
  loadPolicy,
  migrateCorrelationPolicy,
  upgradePolicyDocument,
  validatePolicy
};
