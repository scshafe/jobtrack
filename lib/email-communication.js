'use strict';
const {
  validateJobApplicationEmailFacts,
  validateDemeanorObservation,
  validateRecipientStyleProfile,
  validateWritingVoiceRevision,
  validateToneDecision,
  digest,
  stableJson
} = require('./email-contracts');
const {
  REGISTER_POLICY_VERSION,
  STYLE_PROFILE_FRESHNESS_POLICY,
  TONE_POLICY,
  aggregateStyleObservations,
  evaluateStyleProfileFreshness,
  resolveRegisterAdaptation
} = require('./email-style-policy');
const { recordContactFromMessage } = require('./email-correlation/learn');

const EMAIL_COMMUNICATION_SCHEMA_VERSION = 2026071802;
const EMAIL_COMMUNICATION_MIGRATION_NAME = 'recipient_aware_email_communication_style';
const EMAIL_COMMUNICATION_USER_VERSION = 11;
const MAX_INPUT_BYTES = 1024 * 1024;

class EmailCommunicationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'EmailCommunicationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function migrateEmailCommunication(db) {
  const apply = () => {
    for (const dependency of [
      'jobtrack_schema_migrations', 'job_email_message_refs', 'job_email_reply_draft_proposals',
      'company_contacts'
    ]) {
      if (!tableExists(db, dependency)) {
        throw new EmailCommunicationError('SCHEMA_DEPENDENCY_MISSING', `Email communication migration requires ${dependency}`);
      }
    }
    const byVersion = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
      .get(EMAIL_COMMUNICATION_SCHEMA_VERSION);
    if (byVersion && byVersion.name !== EMAIL_COMMUNICATION_MIGRATION_NAME) {
      throw new EmailCommunicationError('MIGRATION_CONFLICT', `Schema version ${EMAIL_COMMUNICATION_SCHEMA_VERSION} is already named ${byVersion.name}`);
    }
    const byName = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?')
      .get(EMAIL_COMMUNICATION_MIGRATION_NAME);
    if (byName && byName.version !== EMAIL_COMMUNICATION_SCHEMA_VERSION) {
      throw new EmailCommunicationError('MIGRATION_CONFLICT', `Migration ${EMAIL_COMMUNICATION_MIGRATION_NAME} is already registered as ${byName.version}`);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS job_email_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(provider)<>''), CHECK (trim(account_id)<>''), CHECK (trim(thread_id)<>''),
        UNIQUE(provider,account_id,thread_id)
      );

      CREATE TABLE IF NOT EXISTS job_email_thread_messages (
        thread_ref_id INTEGER NOT NULL REFERENCES job_email_threads(id) ON DELETE RESTRICT,
        message_ref_id INTEGER NOT NULL UNIQUE REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(thread_ref_id,message_ref_id)
      );

      CREATE TABLE IF NOT EXISTS job_email_contact_binding_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_contact_id INTEGER NOT NULL REFERENCES company_contacts(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        normalized_email TEXT NOT NULL COLLATE NOCASE,
        source_message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
        decision TEXT NOT NULL CHECK (decision IN ('bind','unbind')),
        expected_prior_event_id INTEGER REFERENCES job_email_contact_binding_events(id) ON DELETE RESTRICT,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(normalized_email)<>''), CHECK (normalized_email=lower(trim(normalized_email))),
        CHECK (trim(actor)<>''), CHECK (trim(reason)<>'')
      );

      CREATE TABLE IF NOT EXISTS job_email_demeanor_observations (
        observation_id TEXT PRIMARY KEY,
        message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
        facts_digest TEXT NOT NULL CHECK (length(facts_digest)=64),
        content_digest TEXT NOT NULL CHECK (length(content_digest)=64),
        profile_eligible INTEGER NOT NULL CHECK (profile_eligible IN (0,1)),
        requires_review INTEGER NOT NULL CHECK (requires_review IN (0,1)),
        observation_json TEXT NOT NULL CHECK (json_valid(observation_json)),
        observation_digest TEXT NOT NULL CHECK (length(observation_digest)=64),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(message_ref_id,observation_digest)
      );

      CREATE TABLE IF NOT EXISTS job_email_recipient_style_profiles (
        profile_id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('thread','contact')),
        thread_ref_id INTEGER REFERENCES job_email_threads(id) ON DELETE RESTRICT,
        company_contact_id INTEGER REFERENCES company_contacts(id) ON DELETE RESTRICT,
        version INTEGER NOT NULL CHECK (version>0),
        confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
        source_state_sha256 TEXT NOT NULL CHECK (length(source_state_sha256)=64),
        profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
        profile_digest TEXT NOT NULL CHECK (length(profile_digest)=64),
        requires_review INTEGER NOT NULL CHECK (requires_review=1),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK ((scope_kind='thread' AND thread_ref_id IS NOT NULL AND company_contact_id IS NULL)
          OR (scope_kind='contact' AND thread_ref_id IS NULL AND company_contact_id IS NOT NULL)),
        UNIQUE(scope_kind,thread_ref_id,company_contact_id,version)
      );

      CREATE TABLE IF NOT EXISTS job_email_style_profile_observations (
        profile_id TEXT NOT NULL REFERENCES job_email_recipient_style_profiles(profile_id) ON DELETE RESTRICT,
        observation_id TEXT NOT NULL REFERENCES job_email_demeanor_observations(observation_id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position>0 AND position<=8),
        PRIMARY KEY(profile_id,observation_id),
        UNIQUE(profile_id,position)
      );

      CREATE TABLE IF NOT EXISTS job_email_style_profile_review_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL REFERENCES job_email_recipient_style_profiles(profile_id) ON DELETE RESTRICT,
        event_kind TEXT NOT NULL CHECK (event_kind IN ('proposed','approved','rejected')),
        actor TEXT NOT NULL,
        notes TEXT,
        idempotency_key TEXT UNIQUE,
        intent_sha256 TEXT CHECK (intent_sha256 IS NULL OR length(intent_sha256)=64),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(actor)<>'')
      );

      CREATE TABLE IF NOT EXISTS job_email_style_profile_selections (
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('thread','contact')),
        scope_key TEXT NOT NULL,
        profile_id TEXT NOT NULL UNIQUE REFERENCES job_email_recipient_style_profiles(profile_id) ON DELETE RESTRICT,
        lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version>=0),
        selected_by TEXT NOT NULL,
        selected_at TEXT NOT NULL,
        PRIMARY KEY(scope_kind,scope_key),
        CHECK (trim(scope_key)<>''), CHECK (trim(selected_by)<>'')
      );

      CREATE TABLE IF NOT EXISTS job_email_style_profile_selection_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('thread','contact')),
        scope_key TEXT NOT NULL,
        previous_profile_id TEXT REFERENCES job_email_recipient_style_profiles(profile_id) ON DELETE RESTRICT,
        profile_id TEXT NOT NULL REFERENCES job_email_recipient_style_profiles(profile_id) ON DELETE RESTRICT,
        expected_lock_version INTEGER NOT NULL CHECK (expected_lock_version>=0),
        selected_by TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        selected_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(scope_key)<>''), CHECK (trim(selected_by)<>'')
      );

      CREATE TABLE IF NOT EXISTS profile_email_writing_voices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        voice_key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        owner TEXT NOT NULL CHECK (owner='Cole'),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(voice_key)<>''), CHECK (trim(label)<>'')
      );

      CREATE TABLE IF NOT EXISTS profile_email_writing_voice_revisions (
        revision_id TEXT PRIMARY KEY,
        voice_id INTEGER NOT NULL REFERENCES profile_email_writing_voices(id) ON DELETE RESTRICT,
        version INTEGER NOT NULL CHECK (version>0),
        revision_json TEXT NOT NULL CHECK (json_valid(revision_json)),
        revision_digest TEXT NOT NULL CHECK (length(revision_digest)=64),
        requires_review INTEGER NOT NULL CHECK (requires_review=1),
        created_at TEXT NOT NULL,
        UNIQUE(voice_id,version)
      );

      CREATE TABLE IF NOT EXISTS profile_email_writing_voice_review_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        revision_id TEXT NOT NULL REFERENCES profile_email_writing_voice_revisions(revision_id) ON DELETE RESTRICT,
        event_kind TEXT NOT NULL CHECK (event_kind IN ('proposed','approved','rejected')),
        actor TEXT NOT NULL,
        notes TEXT,
        idempotency_key TEXT UNIQUE,
        intent_sha256 TEXT CHECK (intent_sha256 IS NULL OR length(intent_sha256)=64),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(actor)<>'')
      );

      CREATE TABLE IF NOT EXISTS profile_email_writing_voice_current (
        voice_id INTEGER PRIMARY KEY REFERENCES profile_email_writing_voices(id) ON DELETE RESTRICT,
        revision_id TEXT NOT NULL UNIQUE REFERENCES profile_email_writing_voice_revisions(revision_id) ON DELETE RESTRICT,
        lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version>=0),
        selected_by TEXT NOT NULL,
        selected_at TEXT NOT NULL,
        CHECK (trim(selected_by)<>'')
      );

      CREATE TABLE IF NOT EXISTS profile_email_writing_voice_selection_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        voice_id INTEGER NOT NULL REFERENCES profile_email_writing_voices(id) ON DELETE RESTRICT,
        previous_revision_id TEXT REFERENCES profile_email_writing_voice_revisions(revision_id) ON DELETE RESTRICT,
        revision_id TEXT NOT NULL REFERENCES profile_email_writing_voice_revisions(revision_id) ON DELETE RESTRICT,
        expected_lock_version INTEGER NOT NULL CHECK (expected_lock_version>=0),
        selected_by TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
        selected_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(selected_by)<>'')
      );

      CREATE TABLE IF NOT EXISTS job_email_tone_decisions (
        decision_id TEXT PRIMARY KEY,
        message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
        style_profile_id TEXT REFERENCES job_email_recipient_style_profiles(profile_id) ON DELETE RESTRICT,
        voice_revision_id TEXT NOT NULL REFERENCES profile_email_writing_voice_revisions(revision_id) ON DELETE RESTRICT,
        purpose TEXT NOT NULL,
        source_state_sha256 TEXT NOT NULL CHECK (length(source_state_sha256)=64),
        decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
        decision_digest TEXT NOT NULL CHECK (length(decision_digest)=64),
        requires_review INTEGER NOT NULL CHECK (requires_review=1),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS job_email_reply_draft_style_bindings (
        proposal_id TEXT PRIMARY KEY REFERENCES job_email_reply_draft_proposals(proposal_id) ON DELETE RESTRICT,
        tone_decision_id TEXT NOT NULL REFERENCES job_email_tone_decisions(decision_id) ON DELETE RESTRICT,
        style_profile_id TEXT REFERENCES job_email_recipient_style_profiles(profile_id) ON DELETE RESTRICT,
        voice_revision_id TEXT NOT NULL REFERENCES profile_email_writing_voice_revisions(revision_id) ON DELETE RESTRICT,
        source_state_sha256 TEXT NOT NULL CHECK (length(source_state_sha256)=64),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS job_email_communication_operations (
        idempotency_key TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64),
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(command)<>'')
      );

      CREATE INDEX IF NOT EXISTS idx_job_email_threads_identity
        ON job_email_threads(provider,account_id,thread_id);
      CREATE INDEX IF NOT EXISTS idx_job_email_thread_messages_thread
        ON job_email_thread_messages(thread_ref_id,message_ref_id);
      CREATE INDEX IF NOT EXISTS idx_job_email_contact_binding_endpoint
        ON job_email_contact_binding_events(provider,account_id,normalized_email,id DESC);
      CREATE INDEX IF NOT EXISTS idx_job_email_observation_message
        ON job_email_demeanor_observations(message_ref_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_job_email_style_profile_thread
        ON job_email_recipient_style_profiles(thread_ref_id,version DESC);
      CREATE INDEX IF NOT EXISTS idx_job_email_style_profile_contact
        ON job_email_recipient_style_profiles(company_contact_id,version DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_job_email_style_profile_thread_version
        ON job_email_recipient_style_profiles(thread_ref_id,version) WHERE scope_kind='thread';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_job_email_style_profile_contact_version
        ON job_email_recipient_style_profiles(company_contact_id,version) WHERE scope_kind='contact';
      CREATE INDEX IF NOT EXISTS idx_job_email_tone_message
        ON job_email_tone_decisions(message_ref_id,created_at DESC);

      CREATE TRIGGER IF NOT EXISTS trg_job_email_thread_message_identity
      BEFORE INSERT ON job_email_thread_messages
      WHEN NOT EXISTS (
        SELECT 1 FROM job_email_threads t JOIN job_email_message_refs m
          ON m.provider=t.provider AND m.account_id=t.account_id AND m.thread_id=t.thread_id
        WHERE t.id=NEW.thread_ref_id AND m.id=NEW.message_ref_id
      ) BEGIN SELECT RAISE(ABORT, 'email thread/message identity mismatch'); END;

      CREATE TRIGGER IF NOT EXISTS trg_job_email_contact_binding_source_identity
      BEFORE INSERT ON job_email_contact_binding_events
      WHEN NOT EXISTS (
        SELECT 1 FROM job_email_message_refs message
        WHERE message.id=NEW.source_message_ref_id
          AND message.provider=NEW.provider
          AND message.account_id=NEW.account_id
          AND (
            lower(message.from_address)=NEW.normalized_email COLLATE NOCASE
            OR lower(COALESCE(message.reply_to_address,''))=NEW.normalized_email COLLATE NOCASE
          )
      ) BEGIN SELECT RAISE(ABORT, 'email contact binding source identity mismatch'); END;

      CREATE TRIGGER IF NOT EXISTS trg_job_email_contact_binding_expected
      BEFORE INSERT ON job_email_contact_binding_events
      WHEN COALESCE(NEW.expected_prior_event_id,0)<>COALESCE((
        SELECT latest.id FROM job_email_contact_binding_events latest
        WHERE latest.provider=NEW.provider AND latest.account_id=NEW.account_id
          AND latest.normalized_email=NEW.normalized_email COLLATE NOCASE
        ORDER BY latest.id DESC LIMIT 1
      ),0)
      BEGIN SELECT RAISE(ABORT, 'stale email contact binding event'); END;

      CREATE TRIGGER IF NOT EXISTS trg_job_email_contact_binding_transition
      BEFORE INSERT ON job_email_contact_binding_events
      WHEN (NEW.decision='unbind' AND NOT EXISTS (
        SELECT 1 FROM job_email_contact_binding_events current
        WHERE current.id=NEW.expected_prior_event_id AND current.decision='bind'
          AND current.company_contact_id=NEW.company_contact_id
      )) OR (NEW.decision='bind' AND EXISTS (
        SELECT 1 FROM job_email_contact_binding_events current
        WHERE current.id=NEW.expected_prior_event_id AND current.decision='bind'
          AND current.company_contact_id<>NEW.company_contact_id
      ))
      BEGIN SELECT RAISE(ABORT, 'invalid email contact binding transition'); END;

      CREATE TRIGGER IF NOT EXISTS trg_job_email_style_profile_review_state
      BEFORE INSERT ON job_email_style_profile_review_events
      WHEN (NEW.event_kind='proposed' AND EXISTS (
        SELECT 1 FROM job_email_style_profile_review_events prior WHERE prior.profile_id=NEW.profile_id
      )) OR (NEW.event_kind IN ('approved','rejected') AND COALESCE((
        SELECT prior.event_kind FROM job_email_style_profile_review_events prior
        WHERE prior.profile_id=NEW.profile_id ORDER BY prior.id DESC LIMIT 1
      ),'')<>'proposed')
      BEGIN SELECT RAISE(ABORT, 'invalid email style profile review transition'); END;

      CREATE TRIGGER IF NOT EXISTS trg_profile_email_writing_voice_review_state
      BEFORE INSERT ON profile_email_writing_voice_review_events
      WHEN (NEW.event_kind='proposed' AND EXISTS (
        SELECT 1 FROM profile_email_writing_voice_review_events prior WHERE prior.revision_id=NEW.revision_id
      )) OR (NEW.event_kind IN ('approved','rejected') AND COALESCE((
        SELECT prior.event_kind FROM profile_email_writing_voice_review_events prior
        WHERE prior.revision_id=NEW.revision_id ORDER BY prior.id DESC LIMIT 1
      ),'')<>'proposed')
      BEGIN SELECT RAISE(ABORT, 'invalid email writing voice review transition'); END;

      CREATE TRIGGER IF NOT EXISTS trg_job_email_style_profile_selection_scope_insert
      BEFORE INSERT ON job_email_style_profile_selections
      WHEN NOT EXISTS (
        SELECT 1 FROM job_email_recipient_style_profiles profile
        WHERE profile.profile_id=NEW.profile_id AND profile.scope_kind=NEW.scope_kind
          AND NEW.scope_key=CAST(CASE WHEN profile.scope_kind='thread'
            THEN profile.thread_ref_id ELSE profile.company_contact_id END AS TEXT)
      ) OR COALESCE((
        SELECT review.event_kind FROM job_email_style_profile_review_events review
        WHERE review.profile_id=NEW.profile_id ORDER BY review.id DESC LIMIT 1
      ),'')<>'approved'
      BEGIN SELECT RAISE(ABORT, 'email style profile selection scope or approval mismatch'); END;

      CREATE TRIGGER IF NOT EXISTS trg_job_email_style_profile_selection_scope_update
      BEFORE UPDATE ON job_email_style_profile_selections
      WHEN NOT EXISTS (
        SELECT 1 FROM job_email_recipient_style_profiles profile
        WHERE profile.profile_id=NEW.profile_id AND profile.scope_kind=NEW.scope_kind
          AND NEW.scope_key=CAST(CASE WHEN profile.scope_kind='thread'
            THEN profile.thread_ref_id ELSE profile.company_contact_id END AS TEXT)
      ) OR COALESCE((
        SELECT review.event_kind FROM job_email_style_profile_review_events review
        WHERE review.profile_id=NEW.profile_id ORDER BY review.id DESC LIMIT 1
      ),'')<>'approved'
      BEGIN SELECT RAISE(ABORT, 'email style profile selection scope or approval mismatch'); END;

      CREATE TRIGGER IF NOT EXISTS trg_job_email_style_profile_selection_event_scope
      BEFORE INSERT ON job_email_style_profile_selection_events
      WHEN NOT EXISTS (
        SELECT 1 FROM job_email_recipient_style_profiles profile
        WHERE profile.profile_id=NEW.profile_id AND profile.scope_kind=NEW.scope_kind
          AND NEW.scope_key=CAST(CASE WHEN profile.scope_kind='thread'
            THEN profile.thread_ref_id ELSE profile.company_contact_id END AS TEXT)
      ) OR (NEW.previous_profile_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM job_email_recipient_style_profiles previous
        WHERE previous.profile_id=NEW.previous_profile_id AND previous.scope_kind=NEW.scope_kind
          AND NEW.scope_key=CAST(CASE WHEN previous.scope_kind='thread'
            THEN previous.thread_ref_id ELSE previous.company_contact_id END AS TEXT)
      )) OR COALESCE((
        SELECT review.event_kind FROM job_email_style_profile_review_events review
        WHERE review.profile_id=NEW.profile_id ORDER BY review.id DESC LIMIT 1
      ),'')<>'approved'
      BEGIN SELECT RAISE(ABORT, 'email style profile selection event scope or approval mismatch'); END;

      CREATE TRIGGER IF NOT EXISTS trg_job_email_style_profile_selection_event_expected
      BEFORE INSERT ON job_email_style_profile_selection_events
      WHEN NEW.expected_lock_version<>COALESCE((
        SELECT current.lock_version FROM job_email_style_profile_selections current
        WHERE current.scope_kind=NEW.scope_kind AND current.scope_key=NEW.scope_key
      ),0) OR NEW.previous_profile_id IS NOT (
        SELECT current.profile_id FROM job_email_style_profile_selections current
        WHERE current.scope_kind=NEW.scope_kind AND current.scope_key=NEW.scope_key
      )
      BEGIN SELECT RAISE(ABORT, 'stale email style profile selection event'); END;

      CREATE TRIGGER IF NOT EXISTS trg_profile_email_writing_voice_current_scope_insert
      BEFORE INSERT ON profile_email_writing_voice_current
      WHEN NOT EXISTS (
        SELECT 1 FROM profile_email_writing_voice_revisions revision
        WHERE revision.revision_id=NEW.revision_id AND revision.voice_id=NEW.voice_id
      ) OR COALESCE((
        SELECT review.event_kind FROM profile_email_writing_voice_review_events review
        WHERE review.revision_id=NEW.revision_id ORDER BY review.id DESC LIMIT 1
      ),'')<>'approved'
      BEGIN SELECT RAISE(ABORT, 'email writing voice current scope or approval mismatch'); END;

      CREATE TRIGGER IF NOT EXISTS trg_profile_email_writing_voice_current_scope_update
      BEFORE UPDATE ON profile_email_writing_voice_current
      WHEN NOT EXISTS (
        SELECT 1 FROM profile_email_writing_voice_revisions revision
        WHERE revision.revision_id=NEW.revision_id AND revision.voice_id=NEW.voice_id
      ) OR COALESCE((
        SELECT review.event_kind FROM profile_email_writing_voice_review_events review
        WHERE review.revision_id=NEW.revision_id ORDER BY review.id DESC LIMIT 1
      ),'')<>'approved'
      BEGIN SELECT RAISE(ABORT, 'email writing voice current scope or approval mismatch'); END;

      CREATE TRIGGER IF NOT EXISTS trg_profile_email_writing_voice_selection_event_scope
      BEFORE INSERT ON profile_email_writing_voice_selection_events
      WHEN NOT EXISTS (
        SELECT 1 FROM profile_email_writing_voice_revisions revision
        WHERE revision.revision_id=NEW.revision_id AND revision.voice_id=NEW.voice_id
      ) OR (NEW.previous_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM profile_email_writing_voice_revisions previous
        WHERE previous.revision_id=NEW.previous_revision_id AND previous.voice_id=NEW.voice_id
      )) OR COALESCE((
        SELECT review.event_kind FROM profile_email_writing_voice_review_events review
        WHERE review.revision_id=NEW.revision_id ORDER BY review.id DESC LIMIT 1
      ),'')<>'approved'
      BEGIN SELECT RAISE(ABORT, 'email writing voice selection event scope or approval mismatch'); END;

      CREATE TRIGGER IF NOT EXISTS trg_profile_email_writing_voice_selection_event_expected
      BEFORE INSERT ON profile_email_writing_voice_selection_events
      WHEN NEW.expected_lock_version<>COALESCE((
        SELECT current.lock_version FROM profile_email_writing_voice_current current
        WHERE current.voice_id=NEW.voice_id
      ),0) OR NEW.previous_revision_id IS NOT (
        SELECT current.revision_id FROM profile_email_writing_voice_current current
        WHERE current.voice_id=NEW.voice_id
      )
      BEGIN SELECT RAISE(ABORT, 'stale email writing voice selection event'); END;

      CREATE TRIGGER IF NOT EXISTS trg_job_email_reply_style_binding_scope
      BEFORE INSERT ON job_email_reply_draft_style_bindings
      WHEN NOT EXISTS (
        SELECT 1
        FROM job_email_reply_draft_proposals proposal
        JOIN job_email_tone_decisions tone ON tone.decision_id=NEW.tone_decision_id
        WHERE proposal.proposal_id=NEW.proposal_id
          AND proposal.message_ref_id=tone.message_ref_id
          AND tone.style_profile_id IS NEW.style_profile_id
          AND tone.voice_revision_id=NEW.voice_revision_id
          AND tone.source_state_sha256=NEW.source_state_sha256
      ) BEGIN SELECT RAISE(ABORT, 'email reply style binding scope mismatch'); END;
    `);

    for (const table of [
      'job_email_threads', 'job_email_thread_messages', 'job_email_contact_binding_events',
      'job_email_demeanor_observations', 'job_email_recipient_style_profiles',
      'job_email_style_profile_observations', 'job_email_style_profile_review_events',
      'job_email_style_profile_selection_events', 'profile_email_writing_voices',
      'profile_email_writing_voice_revisions', 'profile_email_writing_voice_review_events',
      'profile_email_writing_voice_selection_events', 'job_email_tone_decisions',
      'job_email_reply_draft_style_bindings', 'job_email_communication_operations'
    ]) createImmutableTriggers(db, table);

    backfillEmailThreads(db);
    if (!byVersion) {
      db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)')
        .run(EMAIL_COMMUNICATION_SCHEMA_VERSION, EMAIL_COMMUNICATION_MIGRATION_NAME);
    }
    if (db.pragma('user_version', { simple: true }) < EMAIL_COMMUNICATION_USER_VERSION) {
      db.pragma(`user_version = ${EMAIL_COMMUNICATION_USER_VERSION}`);
    }
  };
  if (db.inTransaction) apply();
  else db.transaction(apply).immediate();
}

function backfillEmailThreads(db) {
  const messages = db.prepare('SELECT id,provider,account_id,thread_id FROM job_email_message_refs ORDER BY id').all();
  for (const message of messages) projectMessageThread(db, message);
}

function projectMessageThread(db, messageOrId) {
  if (!tableExists(db, 'job_email_threads')) return null;
  const message = typeof messageOrId === 'object'
    ? messageOrId
    : db.prepare('SELECT id,provider,account_id,thread_id FROM job_email_message_refs WHERE id=?').get(messageOrId);
  if (!message) throw new EmailCommunicationError('MESSAGE_NOT_FOUND', `Message not found: ${messageOrId}`);
  db.prepare(`
    INSERT INTO job_email_threads(provider,account_id,thread_id) VALUES (?,?,?)
    ON CONFLICT(provider,account_id,thread_id) DO NOTHING
  `).run(message.provider, message.account_id, message.thread_id);
  const thread = db.prepare('SELECT * FROM job_email_threads WHERE provider=? AND account_id=? AND thread_id=?')
    .get(message.provider, message.account_id, message.thread_id);
  db.prepare('INSERT INTO job_email_thread_messages(thread_ref_id,message_ref_id) VALUES (?,?) ON CONFLICT DO NOTHING')
    .run(thread.id, message.id);
  return thread;
}

function importDemeanorObservation(db, rawObservation, idempotencyKey) {
  const observation = validateDemeanorObservation(rawObservation);
  return idempotentOperation(db, 'import-demeanor', idempotencyKey, observation, () => {
    const message = requireMessage(db, observation.source);
    if (message.facts_digest !== observation.factsDigest || message.content_digest !== observation.contentDigest) {
      throw new EmailCommunicationError('SOURCE_DIGEST_MISMATCH', 'Demeanor observation does not match the imported message facts/content digests');
    }
    const facts = JSON.parse(message.facts_json);
    for (const evidence of observation.evidence) {
      if (!facts.evidence?.[evidence.factsEvidenceIndex]) {
        throw new EmailCommunicationError('EVIDENCE_MISMATCH', `Facts evidence index ${evidence.factsEvidenceIndex} does not exist`);
      }
    }
    const sourceEligible = message.content_completeness === 'sanitized_plain_text'
      && message.security_risk === 'low'
      && message.requires_review === 0;
    if (observation.profileEligible && !sourceEligible) {
      throw new EmailCommunicationError('OBSERVATION_INELIGIBLE', 'Incomplete or security-gated messages cannot produce profile-eligible demeanor observations');
    }
    const observationDigest = digest(observation);
    const existing = db.prepare('SELECT * FROM job_email_demeanor_observations WHERE observation_id=?').get(observation.observationId);
    if (existing) {
      if (existing.observation_digest !== observationDigest) {
        throw new EmailCommunicationError('OBSERVATION_CONFLICT', 'Observation ID was reused with different content');
      }
      return result('import-demeanor', { observationId: observation.observationId, observationDigest, reused: true });
    }
    projectMessageThread(db, message);
    db.prepare(`
      INSERT INTO job_email_demeanor_observations(
        observation_id,message_ref_id,facts_digest,content_digest,profile_eligible,
        requires_review,observation_json,observation_digest
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(
      observation.observationId, message.id, observation.factsDigest, observation.contentDigest,
      observation.profileEligible && sourceEligible ? 1 : 0, observation.security.requiresReview ? 1 : 0,
      stableJson(observation), observationDigest
    );
    return result('import-demeanor', { observationId: observation.observationId, observationDigest, reused: false });
  });
}

function recordContactBinding(db, input) {
  const messageRefId = positiveId(input.messageRefId, 'message ref id');
  const companyContactId = positiveId(input.companyContactId, 'company contact id');
  const decision = enumeration(input.decision || 'bind', new Set(['bind', 'unbind']), 'contact binding decision');
  const actor = requiredText(input.actor, 'actor', 200);
  const reason = requiredText(input.reason, 'reason', 20_000);
  const expectedPriorEventId = optionalExpectedId(input.expectedPriorEventId, 'expected prior event id');
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key', 500);
  const message = db.prepare('SELECT * FROM job_email_message_refs WHERE id=?').get(messageRefId);
  if (!message) throw new EmailCommunicationError('MESSAGE_NOT_FOUND', `Message not found: ${messageRefId}`);
  if (!db.prepare('SELECT 1 FROM company_contacts WHERE id=?').get(companyContactId)) {
    throw new EmailCommunicationError('CONTACT_NOT_FOUND', `Company contact not found: ${companyContactId}`);
  }
  const normalizedEmail = normalizeEmail(input.email || message.from_address);
  const permitted = new Set([message.from_address, message.reply_to_address].filter(Boolean).map(normalizeEmail));
  if (!permitted.has(normalizedEmail)) {
    throw new EmailCommunicationError('CONTACT_ENDPOINT_MISMATCH', 'Contact binding address must be an exact From or Reply-To address on the source message');
  }
  const intent = { messageRefId, companyContactId, decision, actor, reason, expectedPriorEventId, normalizedEmail };
  return idempotentOperation(db, 'contact-binding', idempotencyKey, intent, () => {
    const current = latestEndpointBinding(db, message.provider, message.account_id, normalizedEmail);
    const currentId = current?.id || null;
    if (currentId !== expectedPriorEventId) {
      throw new EmailCommunicationError('STALE_CONTACT_BINDING', `Expected contact binding event ${expectedPriorEventId ?? 'none'}, found ${currentId ?? 'none'}`);
    }
    if (decision === 'bind' && current?.decision === 'bind' && current.company_contact_id !== companyContactId) {
      throw new EmailCommunicationError('CONTACT_BINDING_CONFLICT', 'Email endpoint is currently bound to a different company contact');
    }
    if (decision === 'unbind' && (!current || current.decision !== 'bind' || current.company_contact_id !== companyContactId)) {
      throw new EmailCommunicationError('CONTACT_BINDING_CONFLICT', 'Only the currently bound contact can be unbound');
    }
    const inserted = db.prepare(`
      INSERT INTO job_email_contact_binding_events(
        company_contact_id,provider,account_id,normalized_email,source_message_ref_id,decision,
        expected_prior_event_id,actor,reason,idempotency_key,intent_sha256
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      companyContactId, message.provider, message.account_id, normalizedEmail, message.id, decision,
      expectedPriorEventId, actor, reason, idempotencyKey, digest(intent)
    );
    return result('contact-binding', {
      eventId: Number(inserted.lastInsertRowid), companyContactId, normalizedEmail, decision
    });
  });
}

// Create a company_contacts row from an inbound sender, so a name that arrived
// with the email facts becomes a durable, queryable contact rather than living
// only inside the message's facts_json. The name defaults to the imported
// facts' source.fromDisplayName and the email to the message's From; both may
// be overridden explicitly. The email must be an exact From or Reply-To on the
// source message, matching the endpoint discipline `bind-contact` enforces, so
// a contact can never be attached to an address the message did not use. The
// company is supplied explicitly — this verb records a contact, it does not
// guess which company a sender belongs to.
function recordCompanyContact(db, input) {
  const messageRefId = positiveId(input.messageRefId, 'message ref id');
  const companyId = positiveId(input.companyId, 'company id');
  const source = requiredText(input.source, 'source', 100);
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key', 500);
  const message = db.prepare('SELECT * FROM job_email_message_refs WHERE id=?').get(messageRefId);
  if (!message) throw new EmailCommunicationError('MESSAGE_NOT_FOUND', `Message not found: ${messageRefId}`);
  if (!db.prepare('SELECT 1 FROM companies WHERE id=?').get(companyId)) {
    throw new EmailCommunicationError('COMPANY_NOT_FOUND', `Company not found: ${companyId}`);
  }

  let facts = {};
  try { facts = message.facts_json ? JSON.parse(message.facts_json) : {}; } catch { facts = {}; }
  const name = requiredText(input.name || facts?.source?.fromDisplayName, 'contact name', 300);

  const normalizedEmail = normalizeEmail(input.email || message.from_address);
  const permitted = new Set([message.from_address, message.reply_to_address].filter(Boolean).map(normalizeEmail));
  if (!permitted.has(normalizedEmail)) {
    throw new EmailCommunicationError('CONTACT_ENDPOINT_MISMATCH', 'Contact email must be an exact From or Reply-To address on the source message');
  }
  const roleTitle = input.roleTitle !== undefined && input.roleTitle !== null && `${input.roleTitle}`.length
    ? requiredText(input.roleTitle, 'role title', 300)
    : null;

  const intent = { messageRefId, companyId, name, normalizedEmail, roleTitle, source };
  return idempotentOperation(db, 'record-contact', idempotencyKey, intent, () => {
    const recorded = recordContactFromMessage(db, {
      messageRefId, companyId, name, email: normalizedEmail, roleTitle,
      actor: `email-record-contact:${source}`
    });
    return result('record-contact', {
      contactId: recorded.contactId, companyId, name, email: normalizedEmail,
      created: recorded.created, sourceMessageRefId: messageRefId
    });
  });
}

function buildEmailCommunicationContext(db, input, options = {}) {
  const evaluatedAt = options.now || new Date();
  const source = normalizeSource(input.source || input);
  const message = requireMessage(db, source);
  const thread = requireThread(db, message);
  const selectedObservationIds = normalizeIdList(input.observationIds);
  const styleProfileId = optionalText(input.styleProfileId);
  const voiceRevisionId = optionalText(input.voiceRevisionId);
  const requestedContactId = optionalPositiveId(input.contactId, 'contact id');
  const boundContact = currentContactForMessage(db, message);
  const contactId = requestedContactId || boundContact?.company_contact_id || null;
  if (requestedContactId && boundContact?.company_contact_id !== requestedContactId) {
    throw new EmailCommunicationError('CONTACT_SCOPE_MISMATCH', 'Message endpoint is not currently bound to the requested contact');
  }
  const threadObservations = listEligibleThreadObservations(db, thread.id);
  const contactObservations = contactId ? listEligibleContactObservations(db, contactId) : [];
  const availableById = new Map([...threadObservations, ...contactObservations].map((entry) => [entry.observationId, entry]));
  const observations = selectedObservationIds.map((id) => {
    const entry = availableById.get(id);
    if (!entry) throw new EmailCommunicationError('OBSERVATION_SCOPE_MISMATCH', `Observation ${id} is not eligible in this thread/contact context`);
    return entry;
  });
  const styleProfile = styleProfileId
    ? requireCurrentApprovedStyleProfileForMessage(db, styleProfileId, message, thread, evaluatedAt)
    : null;
  const voiceRevision = voiceRevisionId ? requireCurrentApprovedVoiceRevision(db, voiceRevisionId) : null;
  const selected = selectedObservationIds.length > 0 || styleProfile || voiceRevision;
  const catalog = {
    schemaVersion: 'email-communication-context.v1',
    mode: selected ? 'selected-generation' : 'source-catalog',
    message: publicMessageContext(message),
    thread: publicThread(thread),
    contact: boundContact ? { companyContactId: boundContact.company_contact_id, bindingEventId: boundContact.id } : null,
    availableSources: {
      threadObservations: threadObservations.map(publicObservationCatalog),
      contactObservations: contactObservations.map(publicObservationCatalog),
      styleProfiles: listCurrentStyleProfilesForMessage(db, message, thread, evaluatedAt),
      writingVoices: listCurrentWritingVoices(db)
    },
    observations: observations.map(publicObservation),
    styleProfile: styleProfile
      ? publicStyleProfile(styleProfile, styleProfileStatus(db, styleProfile, evaluatedAt))
      : null,
    writingVoice: voiceRevision ? publicVoiceRevision(voiceRevision) : null,
    policyVersion: REGISTER_POLICY_VERSION,
    styleProfileFreshnessPolicy: STYLE_PROFILE_FRESHNESS_POLICY,
    sourceStateSha256: null
  };
  if (!selected) return catalog;
  const state = canonicalCommunicationSourceState(catalog);
  return { ...catalog, sourceStateSha256: digest(state) };
}

function createStyleProfile(db, rawProfile, idempotencyKey) {
  const profile = validateRecipientStyleProfile(rawProfile);
  return idempotentOperation(db, 'propose-style-profile', idempotencyKey, profile, () => {
    const scope = resolveProfileScope(db, profile.scope);
    if (profile.scope.kind === 'thread' && (
      profile.source.provider !== profile.scope.provider
      || profile.source.accountId !== profile.scope.accountId
      || profile.source.threadId !== profile.scope.threadId
    )) {
      throw new EmailCommunicationError(
        'PROFILE_SOURCE_SCOPE_MISMATCH',
        'Thread style profile source must belong to the exact profiled provider/account/thread'
      );
    }
    const context = buildEmailCommunicationContext(db, {
      source: profile.source,
      observationIds: profile.observationIds,
      contactId: profile.scope.kind === 'contact' ? profile.scope.contactId : undefined
    });
    if (context.sourceStateSha256 !== profile.sourceStateSha256) {
      throw new EmailCommunicationError('SOURCE_STATE_STALE', 'Style profile source state does not match the current selected communication context');
    }
    const observations = profile.observationIds.map((id) => requireObservationModel(db, id));
    verifyObservationScope(db, profile.scope, observations);
    assertExactStyleObservationWindow(db, scope, profile.observationIds);
    const aggregate = aggregateStyleObservations(observations);
    for (const key of ['dimensions', 'delivery', 'confidence', 'sample', 'safeguards']) {
      if (stableJson(profile[key]) !== stableJson(aggregate[key])) {
        throw new EmailCommunicationError('STYLE_PROFILE_MISMATCH', `Style profile ${key} differs from conservative deterministic aggregation`);
      }
    }
    const profileDigest = digest(profile);
    const existing = db.prepare('SELECT profile_digest FROM job_email_recipient_style_profiles WHERE profile_id=?').get(profile.profileId);
    if (existing) {
      if (existing.profile_digest !== profileDigest) throw new EmailCommunicationError('PROFILE_CONFLICT', 'Style profile ID was reused with different content');
      return result('propose-style-profile', { profileId: profile.profileId, profileDigest, reused: true });
    }
    const nextVersion = db.prepare(`
      SELECT COALESCE(MAX(version),0)+1 value FROM job_email_recipient_style_profiles
      WHERE scope_kind=? AND COALESCE(thread_ref_id,0)=? AND COALESCE(company_contact_id,0)=?
    `).get(scope.kind, scope.threadRefId || 0, scope.companyContactId || 0).value;
    if (profile.version !== nextVersion) {
      throw new EmailCommunicationError('PROFILE_VERSION_CONFLICT', `Expected style profile version ${nextVersion}, received ${profile.version}`);
    }
    db.prepare(`
      INSERT INTO job_email_recipient_style_profiles(
        profile_id,scope_kind,thread_ref_id,company_contact_id,version,confidence,
        source_state_sha256,profile_json,profile_digest,requires_review
      ) VALUES (?,?,?,?,?,?,?,?,?,1)
    `).run(
      profile.profileId, scope.kind, scope.threadRefId, scope.companyContactId, profile.version,
      profile.confidence, profile.sourceStateSha256, stableJson(profile), profileDigest
    );
    const insertObservation = db.prepare(`
      INSERT INTO job_email_style_profile_observations(profile_id,observation_id,position) VALUES (?,?,?)
    `);
    profile.observationIds.forEach((id, index) => insertObservation.run(profile.profileId, id, index + 1));
    insertProfileReviewEvent(db, profile.profileId, 'proposed', `generator:${profile.generatedBy.provider}`, null, null, null);
    return result('propose-style-profile', { profileId: profile.profileId, profileDigest, version: profile.version, reused: false });
  });
}

function reviewStyleProfile(db, input) {
  const profileId = requiredText(input.profileId, 'profile id', 200);
  const decision = enumeration(input.decision, new Set(['approved', 'rejected']), 'review decision');
  const reviewedBy = requiredText(input.reviewedBy, 'reviewed by', 200);
  const notes = optionalText(input.notes);
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key', 500);
  const request = { profileId, decision, reviewedBy, notes };
  return idempotentOperation(db, 'review-style-profile', idempotencyKey, request, () => {
    requireStyleProfileRecord(db, profileId);
    const latest = latestProfileReview(db, profileId);
    if (!latest || latest.event_kind !== 'proposed') {
      throw new EmailCommunicationError('INVALID_PROFILE_STATE', `Style profile is already ${latest?.event_kind || 'unknown'}`);
    }
    insertProfileReviewEvent(db, profileId, decision, reviewedBy, notes, idempotencyKey, digest(request));
    return result('review-style-profile', { profileId, decision, reviewedBy });
  });
}

function selectStyleProfile(db, input, options = {}) {
  const profileId = requiredText(input.profileId, 'profile id', 200);
  const selectedBy = requiredText(input.selectedBy, 'selected by', 200);
  const expectedCurrentProfileId = optionalExpectedText(input.expectedCurrentProfileId);
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key', 500);
  const profile = requireStyleProfileRecord(db, profileId);
  const scope = scopeForProfileRecord(profile);
  const request = { profileId, selectedBy, expectedCurrentProfileId, scope };
  return idempotentOperation(db, 'select-style-profile', idempotencyKey, request, () => {
    const review = latestProfileReview(db, profileId);
    if (!review || review.event_kind !== 'approved') throw new EmailCommunicationError('APPROVAL_REQUIRED', 'Style profile must be approved before selection');
    assertStyleProfileEvidenceCurrent(db, profile, options.now || new Date());
    const current = db.prepare('SELECT * FROM job_email_style_profile_selections WHERE scope_kind=? AND scope_key=?')
      .get(scope.kind, scope.key);
    const currentId = current?.profile_id || null;
    if (currentId !== expectedCurrentProfileId) {
      throw new EmailCommunicationError('STALE_PROFILE_SELECTION', `Expected current profile ${expectedCurrentProfileId ?? 'none'}, found ${currentId ?? 'none'}`);
    }
    const expectedVersion = current?.lock_version || 0;
    const selectedAt = new Date().toISOString();
    const intentSha = digest(request);
    db.prepare(`
      INSERT INTO job_email_style_profile_selection_events(
        scope_kind,scope_key,previous_profile_id,profile_id,expected_lock_version,selected_by,
        idempotency_key,intent_sha256,selected_at
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `).run(scope.kind, scope.key, currentId, profileId, expectedVersion, selectedBy, idempotencyKey, intentSha, selectedAt);
    if (current) {
      const updated = db.prepare(`
        UPDATE job_email_style_profile_selections
        SET profile_id=?,lock_version=lock_version+1,selected_by=?,selected_at=?
        WHERE scope_kind=? AND scope_key=? AND lock_version=?
      `).run(profileId, selectedBy, selectedAt, scope.kind, scope.key, expectedVersion);
      if (updated.changes !== 1) throw new EmailCommunicationError('STALE_PROFILE_SELECTION', 'Style profile selection changed concurrently');
    } else {
      db.prepare(`
        INSERT INTO job_email_style_profile_selections(scope_kind,scope_key,profile_id,lock_version,selected_by,selected_at)
        VALUES (?,?,?,0,?,?)
      `).run(scope.kind, scope.key, profileId, selectedBy, selectedAt);
    }
    return result('select-style-profile', { profileId, selectedBy, previousProfileId: currentId, scope });
  });
}

function createWritingVoiceRevision(db, rawRevision, idempotencyKey) {
  const revision = validateWritingVoiceRevision(rawRevision);
  return idempotentOperation(db, 'create-writing-voice', idempotencyKey, revision, () => {
    let voice = db.prepare('SELECT * FROM profile_email_writing_voices WHERE voice_key=?').get(revision.voiceKey);
    if (!voice) {
      const inserted = db.prepare(`
        INSERT INTO profile_email_writing_voices(voice_key,label,owner) VALUES (?,?,'Cole')
      `).run(revision.voiceKey, revision.label);
      voice = db.prepare('SELECT * FROM profile_email_writing_voices WHERE id=?').get(inserted.lastInsertRowid);
    } else if (voice.owner !== 'Cole') {
      throw new EmailCommunicationError('VOICE_OWNERSHIP_MISMATCH', 'Writing voice is not Cole-owned');
    }
    const revisionDigest = digest(revision);
    const existing = db.prepare('SELECT revision_digest FROM profile_email_writing_voice_revisions WHERE revision_id=?').get(revision.revisionId);
    if (existing) {
      if (existing.revision_digest !== revisionDigest) throw new EmailCommunicationError('VOICE_CONFLICT', 'Voice revision ID was reused with different content');
      return result('create-writing-voice', { revisionId: revision.revisionId, revisionDigest, reused: true });
    }
    const nextVersion = db.prepare('SELECT COALESCE(MAX(version),0)+1 value FROM profile_email_writing_voice_revisions WHERE voice_id=?')
      .get(voice.id).value;
    if (revision.version !== nextVersion) {
      throw new EmailCommunicationError('VOICE_VERSION_CONFLICT', `Expected writing voice version ${nextVersion}, received ${revision.version}`);
    }
    db.prepare(`
      INSERT INTO profile_email_writing_voice_revisions(
        revision_id,voice_id,version,revision_json,revision_digest,requires_review,created_at
      ) VALUES (?,?,?,?,?,1,?)
    `).run(revision.revisionId, voice.id, revision.version, stableJson(revision), revisionDigest, revision.createdAt);
    insertVoiceReviewEvent(db, revision.revisionId, 'proposed', revision.authoredBy, null, null, null);
    return result('create-writing-voice', { revisionId: revision.revisionId, voiceKey: revision.voiceKey, revisionDigest, reused: false });
  });
}

function reviewWritingVoiceRevision(db, input) {
  const revisionId = requiredText(input.revisionId, 'revision id', 200);
  const decision = enumeration(input.decision, new Set(['approved', 'rejected']), 'review decision');
  const reviewedBy = requiredText(input.reviewedBy, 'reviewed by', 200);
  const notes = optionalText(input.notes);
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key', 500);
  const request = { revisionId, decision, reviewedBy, notes };
  return idempotentOperation(db, 'review-writing-voice', idempotencyKey, request, () => {
    requireVoiceRevisionRecord(db, revisionId);
    const latest = latestVoiceReview(db, revisionId);
    if (!latest || latest.event_kind !== 'proposed') {
      throw new EmailCommunicationError('INVALID_VOICE_STATE', `Writing voice revision is already ${latest?.event_kind || 'unknown'}`);
    }
    insertVoiceReviewEvent(db, revisionId, decision, reviewedBy, notes, idempotencyKey, digest(request));
    return result('review-writing-voice', { revisionId, decision, reviewedBy });
  });
}

function selectWritingVoiceRevision(db, input) {
  const revisionId = requiredText(input.revisionId, 'revision id', 200);
  const selectedBy = requiredText(input.selectedBy, 'selected by', 200);
  const expectedCurrentRevisionId = optionalExpectedText(input.expectedCurrentRevisionId);
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key', 500);
  const revision = requireVoiceRevisionRecord(db, revisionId);
  const request = { revisionId, selectedBy, expectedCurrentRevisionId, voiceId: revision.voice_id };
  return idempotentOperation(db, 'select-writing-voice', idempotencyKey, request, () => {
    const review = latestVoiceReview(db, revisionId);
    if (!review || review.event_kind !== 'approved') throw new EmailCommunicationError('APPROVAL_REQUIRED', 'Writing voice revision must be approved before selection');
    const current = db.prepare('SELECT * FROM profile_email_writing_voice_current WHERE voice_id=?').get(revision.voice_id);
    const currentId = current?.revision_id || null;
    if (currentId !== expectedCurrentRevisionId) {
      throw new EmailCommunicationError('STALE_VOICE_SELECTION', `Expected current voice revision ${expectedCurrentRevisionId ?? 'none'}, found ${currentId ?? 'none'}`);
    }
    const expectedVersion = current?.lock_version || 0;
    const selectedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO profile_email_writing_voice_selection_events(
        voice_id,previous_revision_id,revision_id,expected_lock_version,selected_by,
        idempotency_key,intent_sha256,selected_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(revision.voice_id, currentId, revisionId, expectedVersion, selectedBy, idempotencyKey, digest(request), selectedAt);
    if (current) {
      const updated = db.prepare(`
        UPDATE profile_email_writing_voice_current
        SET revision_id=?,lock_version=lock_version+1,selected_by=?,selected_at=?
        WHERE voice_id=? AND lock_version=?
      `).run(revisionId, selectedBy, selectedAt, revision.voice_id, expectedVersion);
      if (updated.changes !== 1) throw new EmailCommunicationError('STALE_VOICE_SELECTION', 'Writing voice selection changed concurrently');
    } else {
      db.prepare(`
        INSERT INTO profile_email_writing_voice_current(voice_id,revision_id,lock_version,selected_by,selected_at)
        VALUES (?,?,0,?,?)
      `).run(revision.voice_id, revisionId, selectedBy, selectedAt);
    }
    return result('select-writing-voice', { revisionId, selectedBy, previousRevisionId: currentId, voiceKey: revision.voice_key });
  });
}

function createToneDecision(db, rawDecision, idempotencyKey, options = {}) {
  const decision = validateToneDecision(rawDecision);
  return idempotentOperation(db, 'propose-tone', idempotencyKey, decision, () => {
    const message = requireMessage(db, decision.source);
    if (message.facts_digest !== decision.factsDigest) throw new EmailCommunicationError('FACTS_DIGEST_MISMATCH', 'Tone decision facts digest does not match the imported message');
    const style = decision.styleProfileId
      ? requireCurrentApprovedStyleProfileForMessage(
        db,
        decision.styleProfileId,
        message,
        requireThread(db, message),
        options.now || new Date()
      )
      : null;
    const voice = requireCurrentApprovedVoiceRevision(db, decision.voiceRevisionId);
    if (voice.revision_digest !== decision.voiceRevisionDigest) throw new EmailCommunicationError('VOICE_DIGEST_MISMATCH', 'Tone decision voice digest is stale');
    if (style && style.profile_digest !== decision.styleProfileDigest) throw new EmailCommunicationError('PROFILE_DIGEST_MISMATCH', 'Tone decision style profile digest is stale');
    const context = buildEmailCommunicationContext(db, {
      source: decision.source,
      styleProfileId: decision.styleProfileId,
      voiceRevisionId: decision.voiceRevisionId
    }, options);
    if (context.sourceStateSha256 !== decision.sourceStateSha256) {
      throw new EmailCommunicationError('SOURCE_STATE_STALE', 'Tone decision source state is stale');
    }
    const facts = validateJobApplicationEmailFacts(JSON.parse(message.facts_json));
    const conservative = requiresConservativeTone(facts);
    const voiceModel = JSON.parse(voice.revision_json);
    const styleModel = style ? JSON.parse(style.profile_json) : null;
    const selected = resolveRegisterAdaptation({
      voice: voiceModel,
      recipientProfile: styleModel,
      purpose: decision.purpose,
      conservative
    });
    if (stableJson(selected) !== stableJson(decision.selected)) {
      throw new EmailCommunicationError('TONE_POLICY_MISMATCH', 'Tone decision differs from the conservative register-adaptation policy');
    }
    const requiredRationaleCodes = toneRationaleRequirements(styleModel, decision.purpose, conservative);
    const missingRationaleCodes = requiredRationaleCodes.filter((code) => !decision.rationaleCodes.includes(code));
    const unexpectedRationaleCodes = decision.rationaleCodes.filter((code) => !requiredRationaleCodes.includes(code));
    if (missingRationaleCodes.length > 0 || unexpectedRationaleCodes.length > 0) {
      throw new EmailCommunicationError(
        'TONE_RATIONALE_MISMATCH',
        `Tone decision rationale must equal the deterministic policy trace; missing [${missingRationaleCodes.join(', ')}], unexpected [${unexpectedRationaleCodes.join(', ')}]`
      );
    }
    if (stableJson(decision.policy) !== stableJson({ ...TONE_POLICY, maxBandShift: voiceModel.delivery.maxBandShift })) {
      throw new EmailCommunicationError('TONE_POLICY_MISMATCH', 'Tone decision policy does not match the selected Cole voice bounds');
    }
    const decisionDigest = digest(decision);
    const existing = db.prepare('SELECT decision_digest FROM job_email_tone_decisions WHERE decision_id=?').get(decision.decisionId);
    if (existing) {
      if (existing.decision_digest !== decisionDigest) throw new EmailCommunicationError('TONE_DECISION_CONFLICT', 'Tone decision ID was reused with different content');
      return result('propose-tone', { decisionId: decision.decisionId, decisionDigest, reused: true });
    }
    db.prepare(`
      INSERT INTO job_email_tone_decisions(
        decision_id,message_ref_id,style_profile_id,voice_revision_id,purpose,source_state_sha256,
        decision_json,decision_digest,requires_review
      ) VALUES (?,?,?,?,?,?,?,?,1)
    `).run(
      decision.decisionId, message.id, decision.styleProfileId || null, decision.voiceRevisionId,
      decision.purpose, decision.sourceStateSha256, stableJson(decision), decisionDigest
    );
    return result('propose-tone', { decisionId: decision.decisionId, decisionDigest, reused: false });
  });
}

function toneRationaleRequirements(styleProfile, purpose, conservative = false) {
  const required = ['cole_voice_baseline', 'identity_mimicry_guard'];
  if (!styleProfile || styleProfile.confidence === 'low') required.push('low_confidence_fallback');
  else if (styleProfile.scope.kind === 'thread') required.push('thread_register');
  else required.push('reviewed_contact_register');
  if (purpose === 'scheduling') required.push('scheduling_clarity');
  if (purpose === 'information_response') required.push('information_clarity');
  if (purpose === 'follow_up') required.push('follow_up_brevity');
  if (conservative) required.push('conservative_context');
  return required;
}

function requiresConservativeTone(facts) {
  return facts.contentCompleteness !== 'sanitized_plain_text'
    || facts.security.risk !== 'low'
    || facts.security.requiresReview
    || ['offer', 'rejection'].includes(facts.eventKind)
    || facts.requestedAction?.kind === 'review_offer';
}

function persistReplyStyleBinding(db, proposal, message, options = {}) {
  if (proposal.schemaVersion !== 'email-reply-draft-proposal.v2') return null;
  const tone = db.prepare('SELECT * FROM job_email_tone_decisions WHERE decision_id=?').get(proposal.toneDecisionId);
  if (!tone) throw new EmailCommunicationError('TONE_DECISION_NOT_FOUND', `Tone decision not found: ${proposal.toneDecisionId}`);
  const decision = validateToneDecision(JSON.parse(tone.decision_json));
  if (tone.message_ref_id !== message.id || decision.factsDigest !== proposal.factsDigest) {
    throw new EmailCommunicationError('TONE_SOURCE_MISMATCH', 'Reply and tone decision must bind the same imported message');
  }
  if (tone.decision_digest !== proposal.toneDecisionDigest) throw new EmailCommunicationError('TONE_DIGEST_MISMATCH', 'Reply tone decision digest is stale');
  if (decision.purpose !== proposal.purpose) throw new EmailCommunicationError('TONE_PURPOSE_MISMATCH', 'Reply purpose differs from its tone decision');
  if (decision.voiceRevisionId !== proposal.voiceRevisionId || decision.voiceRevisionDigest !== proposal.voiceRevisionDigest) {
    throw new EmailCommunicationError('VOICE_BINDING_MISMATCH', 'Reply voice binding differs from its tone decision');
  }
  if ((decision.styleProfileId || null) !== (proposal.styleProfileId || null)
    || (decision.styleProfileDigest || null) !== (proposal.styleProfileDigest || null)) {
    throw new EmailCommunicationError('STYLE_BINDING_MISMATCH', 'Reply style binding differs from its tone decision');
  }
  if (decision.sourceStateSha256 !== proposal.sourceStateSha256) {
    throw new EmailCommunicationError('SOURCE_STATE_STALE', 'Reply source state differs from its tone decision');
  }
  const currentContext = buildEmailCommunicationContext(db, {
    source: decision.source,
    styleProfileId: decision.styleProfileId,
    voiceRevisionId: decision.voiceRevisionId
  }, options);
  if (currentContext.sourceStateSha256 !== decision.sourceStateSha256) {
    throw new EmailCommunicationError('SOURCE_STATE_STALE', 'Reply tone inputs are no longer the current reviewed communication state');
  }
  assertDraftMatchesTonePolicy(proposal.body, decision.selected.delivery);
  db.prepare(`
    INSERT INTO job_email_reply_draft_style_bindings(
      proposal_id,tone_decision_id,style_profile_id,voice_revision_id,source_state_sha256
    ) VALUES (?,?,?,?,?)
  `).run(
    proposal.proposalId, proposal.toneDecisionId, proposal.styleProfileId || null,
    proposal.voiceRevisionId, proposal.sourceStateSha256
  );
  return {
    toneDecisionId: proposal.toneDecisionId,
    styleProfileId: proposal.styleProfileId || null,
    voiceRevisionId: proposal.voiceRevisionId,
    sourceStateSha256: proposal.sourceStateSha256
  };
}

function assertDraftMatchesTonePolicy(body, delivery) {
  const exclamationCount = (String(body).match(/!/g) || []).length;
  const maximumExclamations = delivery.exclamationPolicy === 'at_most_one' ? 1 : 0;
  if (exclamationCount > maximumExclamations) {
    throw new EmailCommunicationError('DRAFT_STYLE_POLICY_VIOLATION', `Reply exceeds the tone decision's ${maximumExclamations}-exclamation limit`);
  }
  if (delivery.emojiPolicy === 'none' && /\p{Extended_Pictographic}/u.test(String(body))) {
    throw new EmailCommunicationError('DRAFT_STYLE_POLICY_VIOLATION', 'Reply contains emoji forbidden by the register-adaptation policy');
  }
}

function resolveProfileScope(db, scope) {
  if (scope.kind === 'thread') {
    const thread = db.prepare('SELECT * FROM job_email_threads WHERE provider=? AND account_id=? AND thread_id=?')
      .get(scope.provider, scope.accountId, scope.threadId);
    if (!thread) throw new EmailCommunicationError('THREAD_NOT_FOUND', 'Style profile thread is not present in JobTrack');
    return { kind: 'thread', threadRefId: thread.id, companyContactId: null, key: String(thread.id) };
  }
  if (!db.prepare('SELECT 1 FROM company_contacts WHERE id=?').get(scope.contactId)) {
    throw new EmailCommunicationError('CONTACT_NOT_FOUND', `Company contact not found: ${scope.contactId}`);
  }
  return { kind: 'contact', threadRefId: null, companyContactId: scope.contactId, key: String(scope.contactId) };
}

function verifyObservationScope(db, scope, observations) {
  if (scope.kind === 'thread') {
    if (observations.some((entry) => entry.source.provider !== scope.provider
      || entry.source.accountId !== scope.accountId || entry.source.threadId !== scope.threadId)) {
      throw new EmailCommunicationError('OBSERVATION_SCOPE_MISMATCH', 'Thread style profile contains an observation from another thread');
    }
    return;
  }
  for (const observation of observations) {
    const message = requireMessage(db, observation.source);
    const binding = currentContactForMessage(db, message);
    if (!binding || binding.company_contact_id !== scope.contactId) {
      throw new EmailCommunicationError('OBSERVATION_SCOPE_MISMATCH', 'Contact style profile contains an observation without a current reviewed endpoint binding');
    }
  }
}

function listEligibleThreadObservations(db, threadRefId) {
  return readObservationRows(db, `
    WHERE o.profile_eligible=1 AND tm.thread_ref_id=@scopeId
      AND o.observation_id=(
        SELECT latest.observation_id FROM job_email_demeanor_observations latest
        WHERE latest.message_ref_id=o.message_ref_id AND latest.profile_eligible=1
        ORDER BY datetime(latest.created_at) DESC,latest.rowid DESC LIMIT 1
      )
    ORDER BY datetime(m.received_at) DESC,o.observation_id DESC LIMIT 8
  `, { scopeId: threadRefId });
}

function listEligibleContactObservations(db, contactId) {
  const bindings = currentBoundEndpointsForContact(db, contactId);
  const rows = [];
  for (const binding of bindings) {
    rows.push(...readObservationRows(db, `
      WHERE o.profile_eligible=1 AND m.provider=@provider AND m.account_id=@accountId
        AND lower(COALESCE(m.reply_to_address,m.from_address))=@normalizedEmail
        AND o.observation_id=(
          SELECT latest.observation_id FROM job_email_demeanor_observations latest
          WHERE latest.message_ref_id=o.message_ref_id AND latest.profile_eligible=1
          ORDER BY datetime(latest.created_at) DESC,latest.rowid DESC LIMIT 1
        )
      ORDER BY datetime(m.received_at) DESC,o.observation_id DESC LIMIT 8
    `, {
      provider: binding.provider,
      accountId: binding.account_id,
      normalizedEmail: binding.normalized_email
    }));
  }
  return [...new Map(rows.map((entry) => [entry.observationId, entry])).values()]
    .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt) || right.observationId.localeCompare(left.observationId))
    .slice(0, 8);
}

function eligibleObservationsForResolvedScope(db, scope) {
  return scope.kind === 'thread'
    ? listEligibleThreadObservations(db, scope.threadRefId)
    : listEligibleContactObservations(db, scope.companyContactId);
}

function assertExactStyleObservationWindow(db, scope, observationIds) {
  const expected = eligibleObservationsForResolvedScope(db, scope).map((entry) => entry.observationId);
  if (!sameIdentifierSet(expected, observationIds)) {
    throw new EmailCommunicationError(
      'STYLE_PROFILE_SOURCE_WINDOW_MISMATCH',
      'Style profiles must aggregate the exact current latest-eight eligible observation window for their scope'
    );
  }
}

function styleProfileObservationWindowIsCurrent(db, profile) {
  const stored = validateRecipientStyleProfile(JSON.parse(profile.profile_json));
  const scope = scopeForProfileRecord(profile);
  const resolved = profile.scope_kind === 'thread'
    ? { ...scope, threadRefId: profile.thread_ref_id, companyContactId: null }
    : { ...scope, threadRefId: null, companyContactId: profile.company_contact_id };
  const expected = eligibleObservationsForResolvedScope(db, resolved).map((entry) => entry.observationId);
  return sameIdentifierSet(expected, stored.observationIds);
}

function styleProfileStatus(db, profile, evaluatedAt = new Date()) {
  const stored = validateRecipientStyleProfile(JSON.parse(profile.profile_json));
  const freshness = evaluateStyleProfileFreshness(stored, evaluatedAt);
  const observationWindowCurrent = styleProfileObservationWindowIsCurrent(db, profile);
  const staleReasons = [];
  if (!observationWindowCurrent) staleReasons.push('newer_evidence_available');
  if (freshness.isStale) staleReasons.push('time_horizon_elapsed');
  return {
    isStale: staleReasons.length > 0,
    staleReasons,
    observationWindowCurrent,
    freshness
  };
}

function styleProfileEvidenceIsCurrent(db, profile, evaluatedAt = new Date()) {
  return !styleProfileStatus(db, profile, evaluatedAt).isStale;
}

function assertStyleProfileEvidenceCurrent(db, profile, evaluatedAt = new Date()) {
  const status = styleProfileStatus(db, profile, evaluatedAt);
  if (status.isStale) {
    throw new EmailCommunicationError(
      'STYLE_PROFILE_STALE',
      `Style profile evidence is stale (${status.staleReasons.join(', ')}); aggregate, review, and select a new profile before drafting`,
      status
    );
  }
}

function sameIdentifierSet(left, right) {
  return left.length === right.length
    && left.every((identifier) => right.includes(identifier));
}

function readObservationRows(db, whereSql, params) {
  return db.prepare(`
    SELECT o.*,m.provider,m.account_id,m.message_id,m.thread_id,m.received_at
    FROM job_email_demeanor_observations o
    JOIN job_email_message_refs m ON m.id=o.message_ref_id
    JOIN job_email_thread_messages tm ON tm.message_ref_id=m.id
    ${whereSql}
  `).all(params).map((row) => observationRowModel(row));
}

function requireObservationModel(db, observationId) {
  const row = db.prepare(`
    SELECT o.*,m.provider,m.account_id,m.message_id,m.thread_id,m.received_at
    FROM job_email_demeanor_observations o JOIN job_email_message_refs m ON m.id=o.message_ref_id
    WHERE o.observation_id=? AND o.profile_eligible=1
  `).get(observationId);
  if (!row) throw new EmailCommunicationError('OBSERVATION_NOT_FOUND', `Eligible observation not found: ${observationId}`);
  return observationRowModel(row);
}

function observationRowModel(row) {
  const observation = validateDemeanorObservation(JSON.parse(row.observation_json));
  return {
    ...observation,
    observationDigest: row.observation_digest,
    receivedAt: row.received_at,
    source: {
      provider: row.provider,
      accountId: row.account_id,
      messageId: row.message_id,
      threadId: row.thread_id
    }
  };
}

function requireCurrentApprovedStyleProfileForMessage(db, profileId, message, thread, evaluatedAt = new Date()) {
  const profile = requireStyleProfileRecord(db, profileId);
  const scope = scopeForProfileRecord(profile);
  const selection = db.prepare('SELECT * FROM job_email_style_profile_selections WHERE scope_kind=? AND scope_key=?')
    .get(scope.kind, scope.key);
  if (!selection || selection.profile_id !== profileId) throw new EmailCommunicationError('PROFILE_NOT_CURRENT', 'Style profile is not the current selected profile for its scope');
  const review = latestProfileReview(db, profileId);
  if (!review || review.event_kind !== 'approved') throw new EmailCommunicationError('APPROVAL_REQUIRED', 'Style profile is not approved');
  assertStyleProfileEvidenceCurrent(db, profile, evaluatedAt);
  if (profile.scope_kind === 'thread' && profile.thread_ref_id !== thread.id) {
    throw new EmailCommunicationError('PROFILE_SCOPE_MISMATCH', 'Style profile belongs to another thread');
  }
  if (profile.scope_kind === 'contact') {
    const current = currentContactForMessage(db, message);
    if (!current || current.company_contact_id !== profile.company_contact_id) {
      throw new EmailCommunicationError('PROFILE_SCOPE_MISMATCH', 'Message endpoint is not bound to the style profile contact');
    }
  }
  return profile;
}

function requireCurrentApprovedVoiceRevision(db, revisionId) {
  const revision = requireVoiceRevisionRecord(db, revisionId);
  const current = db.prepare('SELECT * FROM profile_email_writing_voice_current WHERE voice_id=?').get(revision.voice_id);
  if (!current || current.revision_id !== revisionId) throw new EmailCommunicationError('VOICE_NOT_CURRENT', 'Writing voice revision is not current');
  const review = latestVoiceReview(db, revisionId);
  if (!review || review.event_kind !== 'approved') throw new EmailCommunicationError('APPROVAL_REQUIRED', 'Writing voice revision is not approved');
  return revision;
}

function listCurrentStyleProfilesForMessage(db, message, thread, evaluatedAt = new Date()) {
  const profiles = [];
  const threadSelection = db.prepare("SELECT profile_id FROM job_email_style_profile_selections WHERE scope_kind='thread' AND scope_key=?")
    .get(String(thread.id));
  if (threadSelection) {
    const profile = requireStyleProfileRecord(db, threadSelection.profile_id);
    profiles.push(publicStyleProfile(profile, styleProfileStatus(db, profile, evaluatedAt)));
  }
  const contact = currentContactForMessage(db, message);
  if (contact) {
    const selection = db.prepare("SELECT profile_id FROM job_email_style_profile_selections WHERE scope_kind='contact' AND scope_key=?")
      .get(String(contact.company_contact_id));
    if (selection) {
      const profile = requireStyleProfileRecord(db, selection.profile_id);
      profiles.push(publicStyleProfile(profile, styleProfileStatus(db, profile, evaluatedAt)));
    }
  }
  return profiles;
}

function listCurrentWritingVoices(db) {
  return db.prepare(`
    SELECT r.*,v.voice_key,v.label
    FROM profile_email_writing_voice_current c
    JOIN profile_email_writing_voice_revisions r ON r.revision_id=c.revision_id
    JOIN profile_email_writing_voices v ON v.id=r.voice_id
    ORDER BY v.voice_key
  `).all().map(publicVoiceRevision);
}

function requireStyleProfileRecord(db, profileId) {
  const profile = db.prepare('SELECT * FROM job_email_recipient_style_profiles WHERE profile_id=?').get(profileId);
  if (!profile) throw new EmailCommunicationError('PROFILE_NOT_FOUND', `Style profile not found: ${profileId}`);
  return profile;
}

function requireVoiceRevisionRecord(db, revisionId) {
  const revision = db.prepare(`
    SELECT r.*,v.voice_key,v.label,v.owner FROM profile_email_writing_voice_revisions r
    JOIN profile_email_writing_voices v ON v.id=r.voice_id WHERE r.revision_id=?
  `).get(revisionId);
  if (!revision) throw new EmailCommunicationError('VOICE_NOT_FOUND', `Writing voice revision not found: ${revisionId}`);
  return revision;
}

function scopeForProfileRecord(profile) {
  return profile.scope_kind === 'thread'
    ? { kind: 'thread', key: String(profile.thread_ref_id) }
    : { kind: 'contact', key: String(profile.company_contact_id) };
}

function latestProfileReview(db, profileId) {
  return db.prepare('SELECT * FROM job_email_style_profile_review_events WHERE profile_id=? ORDER BY id DESC LIMIT 1').get(profileId);
}

function latestVoiceReview(db, revisionId) {
  return db.prepare('SELECT * FROM profile_email_writing_voice_review_events WHERE revision_id=? ORDER BY id DESC LIMIT 1').get(revisionId);
}

function insertProfileReviewEvent(db, profileId, kind, actor, notes, idempotencyKey, intentSha) {
  db.prepare(`
    INSERT INTO job_email_style_profile_review_events(profile_id,event_kind,actor,notes,idempotency_key,intent_sha256)
    VALUES (?,?,?,?,?,?)
  `).run(profileId, kind, actor, notes, idempotencyKey, intentSha);
}

function insertVoiceReviewEvent(db, revisionId, kind, actor, notes, idempotencyKey, intentSha) {
  db.prepare(`
    INSERT INTO profile_email_writing_voice_review_events(revision_id,event_kind,actor,notes,idempotency_key,intent_sha256)
    VALUES (?,?,?,?,?,?)
  `).run(revisionId, kind, actor, notes, idempotencyKey, intentSha);
}

function latestEndpointBinding(db, provider, accountId, normalizedEmail) {
  return db.prepare(`
    SELECT * FROM job_email_contact_binding_events
    WHERE provider=? AND account_id=? AND normalized_email=? COLLATE NOCASE
    ORDER BY id DESC LIMIT 1
  `).get(provider, accountId, normalizedEmail) || null;
}

function currentBoundEndpointsForContact(db, contactId) {
  return db.prepare(`
    SELECT event.* FROM job_email_contact_binding_events event
    WHERE event.company_contact_id=? AND event.decision='bind'
      AND event.id=(
        SELECT max(latest.id) FROM job_email_contact_binding_events latest
        WHERE latest.provider=event.provider AND latest.account_id=event.account_id
          AND latest.normalized_email=event.normalized_email COLLATE NOCASE
      )
    ORDER BY event.id
  `).all(contactId);
}

function currentContactForMessage(db, message) {
  const replyEndpoint = normalizeEmail(message.reply_to_address || message.from_address);
  const binding = latestEndpointBinding(db, message.provider, message.account_id, replyEndpoint);
  return binding?.decision === 'bind' ? binding : null;
}

function requireMessage(db, source) {
  const message = db.prepare(`
    SELECT * FROM job_email_message_refs WHERE provider=? AND account_id=? AND message_id=?
  `).get(source.provider, source.accountId, source.messageId);
  if (!message) throw new EmailCommunicationError('MESSAGE_NOT_FOUND', 'Import email facts before using communication style features');
  if (message.thread_id !== source.threadId) throw new EmailCommunicationError('MESSAGE_CONFLICT', 'Message thread ID differs from the imported message');
  return message;
}

function requireThread(db, message) {
  const thread = db.prepare('SELECT * FROM job_email_threads WHERE provider=? AND account_id=? AND thread_id=?')
    .get(message.provider, message.account_id, message.thread_id);
  if (!thread) throw new EmailCommunicationError('THREAD_NOT_FOUND', 'Email thread projection is missing; run the communication migration');
  return thread;
}

function publicMessageContext(message) {
  return {
    id: message.id,
    provider: message.provider,
    accountId: message.account_id,
    messageId: message.message_id,
    threadId: message.thread_id,
    receivedAt: message.received_at,
    fromAddress: message.from_address,
    replyToAddress: message.reply_to_address || message.from_address,
    factsDigest: message.facts_digest,
    contentDigest: message.content_digest,
    contentCompleteness: message.content_completeness,
    securityRisk: message.security_risk,
    sourceRequiresReview: Boolean(message.requires_review)
  };
}

function publicThread(thread) {
  return { id: thread.id, provider: thread.provider, accountId: thread.account_id, threadId: thread.thread_id };
}

function publicObservationCatalog(observation) {
  return {
    observationId: observation.observationId,
    observationDigest: observation.observationDigest,
    receivedAt: observation.receivedAt,
    source: observation.source,
    confidence: observation.confidence
  };
}

function publicObservation(observation) {
  return {
    ...publicObservationCatalog(observation),
    dimensions: observation.dimensions,
    surfaceSignals: observation.surfaceSignals
  };
}

function publicStyleProfile(record, status = null) {
  const profile = validateRecipientStyleProfile(JSON.parse(record.profile_json));
  const fallbackFreshness = status ? null : evaluateStyleProfileFreshness(profile);
  const resolvedStatus = status || {
    isStale: fallbackFreshness.isStale,
    staleReasons: fallbackFreshness.staleReason ? [fallbackFreshness.staleReason] : [],
    observationWindowCurrent: true,
    freshness: fallbackFreshness
  };
  return {
    profileId: record.profile_id,
    profileDigest: record.profile_digest,
    scope: profile.scope,
    version: profile.version,
    dimensions: profile.dimensions,
    delivery: profile.delivery,
    confidence: profile.confidence,
    sample: profile.sample,
    freshness: resolvedStatus.freshness,
    observationWindowCurrent: resolvedStatus.observationWindowCurrent,
    isStale: resolvedStatus.isStale,
    staleReasons: resolvedStatus.staleReasons
  };
}

function publicVoiceRevision(record) {
  const revision = validateWritingVoiceRevision(JSON.parse(record.revision_json));
  return {
    revisionId: record.revision_id,
    revisionDigest: record.revision_digest,
    voiceKey: revision.voiceKey,
    label: revision.label,
    version: revision.version,
    dimensions: revision.dimensions,
    delivery: revision.delivery,
    ownership: revision.ownership
  };
}

function canonicalCommunicationSourceState(context) {
  return {
    schemaVersion: 'email-communication-source-state.v1',
    message: context.message,
    thread: context.thread,
    contact: context.contact,
    observations: context.observations,
    styleProfile: context.styleProfile,
    writingVoice: context.writingVoice,
    availableSources: context.availableSources,
    policyVersion: context.policyVersion,
    styleProfileFreshnessPolicy: context.styleProfileFreshnessPolicy
  };
}

function normalizeSource(source) {
  return {
    provider: requiredText(source.provider, 'provider', 100),
    accountId: requiredText(source.accountId, 'account id', 320),
    messageId: requiredText(source.messageId, 'message id', 500),
    threadId: requiredText(source.threadId, 'thread id', 500)
  };
}

function normalizeIdList(value) {
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : String(value).split(',');
  const normalized = values.map((entry) => requiredText(entry, 'observation id', 200));
  if (new Set(normalized).size !== normalized.length) throw new EmailCommunicationError('INVALID_ARGUMENT', 'Observation IDs must be unique');
  if (normalized.length > 8) throw new EmailCommunicationError('INVALID_ARGUMENT', 'At most eight observations may be selected');
  return normalized;
}

function normalizeEmail(value) {
  const email = requiredText(value, 'email', 320).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new EmailCommunicationError('INVALID_ARGUMENT', 'Email address is invalid');
  return email;
}

function idempotentOperation(db, command, idempotencyKey, request, action) {
  const key = requiredText(idempotencyKey, 'idempotency key', 500);
  const requestSha = digest(request);
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM job_email_communication_operations WHERE idempotency_key=?').get(key);
    if (existing) {
      if (existing.command !== command || existing.request_sha256 !== requestSha) {
        throw new EmailCommunicationError('IDEMPOTENCY_CONFLICT', `Idempotency key ${key} was already used for a different request`);
      }
      return JSON.parse(existing.result_json);
    }
    const value = action();
    db.prepare(`
      INSERT INTO job_email_communication_operations(idempotency_key,command,request_sha256,result_json)
      VALUES (?,?,?,?)
    `).run(key, command, requestSha, stableJson(value));
    return value;
  }).immediate();
}

function createImmutableTriggers(db, table) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_${table}_immutable_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_${table}_immutable_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
  `);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function positiveId(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new EmailCommunicationError('INVALID_ARGUMENT', `${label} must be a positive integer`);
  return number;
}

function optionalPositiveId(value, label) {
  return value === undefined || value === null || value === '' ? null : positiveId(value, label);
}

function optionalExpectedId(value, label) {
  if (value === undefined || value === null || value === '' || value === 'none') return null;
  return positiveId(value, label);
}

function optionalExpectedText(value) {
  if (value === undefined || value === null || value === '' || value === 'none') return null;
  return requiredText(value, 'expected current identifier', 200);
}

function requiredText(value, label, maximum) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new EmailCommunicationError('INVALID_ARGUMENT', `${label} is required`);
  }
  const text = String(value).trim();
  if (text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new EmailCommunicationError('INVALID_ARGUMENT', `${label} exceeds its safe printable bound`);
  }
  return text;
}

function optionalText(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

function enumeration(value, allowed, label) {
  const normalized = requiredText(value, label, 100);
  if (!allowed.has(normalized)) throw new EmailCommunicationError('INVALID_ARGUMENT', `${label} has an unsupported value`);
  return normalized;
}

function result(command, fields) {
  return { schemaVersion: 'job-email-communication-command-result.v1', command, ...fields };
}

module.exports = {
  EMAIL_COMMUNICATION_MIGRATION_NAME,
  EMAIL_COMMUNICATION_SCHEMA_VERSION,
  EMAIL_COMMUNICATION_USER_VERSION,
  MAX_INPUT_BYTES,
  EmailCommunicationError,
  migrateEmailCommunication,
  projectMessageThread,
  importDemeanorObservation,
  recordContactBinding,
  recordCompanyContact,
  buildEmailCommunicationContext,
  createStyleProfile,
  reviewStyleProfile,
  selectStyleProfile,
  createWritingVoiceRevision,
  reviewWritingVoiceRevision,
  selectWritingVoiceRevision,
  createToneDecision,
  persistReplyStyleBinding
};
