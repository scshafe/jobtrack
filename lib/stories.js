'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STORY_SCHEMA_VERSION = 2026071701;
const STORY_HARDENING_SCHEMA_VERSION = 2026071704;
const STORY_FACETS_SCHEMA_VERSION = 2026080501;
const STORY_GATE_SCHEMA_VERSION = 2026080502;
const GATE_QUESTIONS_SCHEMA_VERSION = 'jobtrack-story-gate-questions.v1';
const RESPONSE_SCHEMA_VERSION = 1;
const PROTECTED_ANSWER_PLACEHOLDER = '[Protected raw answer capture]';
const STORY_STATUSES = new Set(['captured', 'developing', 'ready', 'needs_review', 'retired']);
const SENSITIVITIES = new Set(['normal', 'private', 'sensitive', 'highly_sensitive']);
const USE_DECISIONS = new Set(['allow', 'ask', 'deny']);
const PURPOSES = new Set(['general', 'cover_letter', 'resume', 'application_form', 'interview', 'networking', 'public_bio']);
const CONFIDENCE = new Set(['low', 'medium', 'high', 'unverified']);
const CAPTURE_KINDS = new Set(['conversation', 'voice_transcript', 'document', 'note', 'legacy_import', 'correction']);
const QUESTION_KINDS = new Set(['clarification', 'timeline', 'evidence', 'metric', 'meaning', 'impact', 'sensitivity', 'audience']);
const QUESTION_STATUSES = new Set(['open', 'answered', 'deferred', 'dismissed']);
const APPLICATION_RELATIONS = new Set(['candidate', 'prompted', 'approved', 'used', 'avoid']);
const VARIANT_PURPOSES = PURPOSES;
const VARIANT_MEDIA = new Set(['spoken', 'written']);
const VARIANT_LENGTHS = new Set(['one_line', '30_seconds', '60_seconds', '2_minutes', 'short', 'medium', 'long', 'custom']);
const VARIANT_STATUSES = new Set(['draft', 'approved', 'retired']);
const STORY_COMMAND_FLAGS = {
  capture: ['title', 'raw', 'rawFile', 'source', 'confidence', 'sensitivity', 'defaultUseDecision', 'defaultUse', 'captureKind', 'tags', 'tag', 'summary', 'occurredStart', 'occurredEnd', 'datePrecision', 'setting', 'sourceUrl', 'attachmentPath', 'capturedBy', 'capturedAt', 'evidence', 'recency', 'idempotencyKey'],
  'append-capture': ['storyId', 'expectedVersion', 'raw', 'rawFile', 'source', 'captureKind', 'sourceUrl', 'attachmentPath', 'capturedBy', 'capturedAt', 'supersedesCaptureId', 'idempotencyKey'],
  polish: ['storyId', 'expectedVersion', 'canonical', 'canonicalFile', 'title', 'status', 'structure', 'beatsJson', 'beatsFile', 'situation', 'task', 'action', 'result', 'reflection', 'captureIds', 'summary', 'takeaway', 'whyItMatters', 'changeNote', 'authoredBy', 'idempotencyKey'],
  'add-variant': ['storyId', 'expectedVersion', 'key', 'variantKey', 'content', 'contentFile', 'purpose', 'medium', 'length', 'lengthClass', 'status', 'audience', 'targetWords', 'targetSeconds', 'authoredBy', 'idempotencyKey'],
  'revise-variant': ['storyId', 'expectedVersion', 'key', 'variantKey', 'content', 'contentFile', 'purpose', 'medium', 'length', 'lengthClass', 'status', 'audience', 'targetWords', 'targetSeconds', 'authoredBy', 'idempotencyKey'],
  'approve-variant': ['storyId', 'expectedVersion', 'variantId', 'approvedBy', 'idempotencyKey'],
  'set-permission': ['storyId', 'expectedVersion', 'purpose', 'decision', 'reason', 'approvedBy', 'expiresAt', 'idempotencyKey'],
  'update-metadata': ['storyId', 'expectedVersion', 'title', 'occurredStart', 'occurredEnd', 'datePrecision', 'setting', 'sensitivity', 'defaultUseDecision', 'defaultUse', 'confidence', 'source', 'sourceUrl', 'evidence', 'attachmentPath', 'recency', 'tags', 'tag', 'idempotencyKey'],
  'add-question': ['storyId', 'expectedVersion', 'kind', 'questionKind', 'question', 'priority', 'askedBy', 'idempotencyKey'],
  'answer-question': ['storyId', 'expectedVersion', 'questionId', 'answer', 'answerFile', 'source', 'capturedBy', 'idempotencyKey'],
  'defer-question': ['storyId', 'expectedVersion', 'questionId', 'idempotencyKey'],
  'dismiss-question': ['storyId', 'expectedVersion', 'questionId', 'idempotencyKey'],
  'claim-facet': ['storyId', 'expectedVersion', 'facet', 'claim', 'beatAnchor', 'weight', 'replace', 'idempotencyKey'],
  'retract-facet': ['storyId', 'expectedVersion', 'facet', 'idempotencyKey'],
  'link-application': ['storyId', 'expectedVersion', 'applicationId', 'relation', 'variantId', 'promptText', 'notes', 'idempotencyKey'],
  'record-use': ['storyId', 'expectedVersion', 'applicationId', 'purpose', 'variantId', 'approvedBy', 'targetKind', 'targetId', 'promptText', 'idempotencyKey'],
  show: ['storyId', 'includeRaw'],
  list: ['status', 'limit'],
  match: ['purpose', 'applicationId', 'text', 'question', 'limit'],
  gate: ['questions', 'questionsFile', 'applicationId', 'purpose', 'runKey']
};

function migrateStories(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobtrack_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const applyMigration = () => {
    if (!db.prepare('SELECT 1 FROM jobtrack_schema_migrations WHERE version = ?').get(STORY_SCHEMA_VERSION)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_entry_id INTEGER NOT NULL UNIQUE REFERENCES profile_entries(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'captured' CHECK (status IN ('captured', 'developing', 'ready', 'needs_review', 'retired')),
        occurred_start TEXT,
        occurred_end TEXT,
        date_precision TEXT,
        setting TEXT,
        sensitivity TEXT NOT NULL DEFAULT 'private' CHECK (sensitivity IN ('normal', 'private', 'sensitive', 'highly_sensitive')),
        default_use_decision TEXT NOT NULL DEFAULT 'ask' CHECK (default_use_decision IN ('allow', 'ask', 'deny')),
        lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (occurred_end IS NULL OR occurred_start IS NOT NULL)
      );

      CREATE TABLE IF NOT EXISTS profile_story_captures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        story_id INTEGER NOT NULL REFERENCES profile_stories(id) ON DELETE CASCADE,
        capture_kind TEXT NOT NULL CHECK (capture_kind IN ('conversation', 'voice_transcript', 'document', 'note', 'legacy_import', 'correction')),
        raw_text TEXT NOT NULL CHECK (length(raw_text) > 0),
        source_label TEXT NOT NULL,
        source_url TEXT,
        attachment_path TEXT,
        captured_by TEXT,
        captured_at TEXT NOT NULL DEFAULT (datetime('now')),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        supersedes_capture_id INTEGER REFERENCES profile_story_captures(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS profile_story_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        story_id INTEGER NOT NULL REFERENCES profile_stories(id) ON DELETE CASCADE,
        revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
        title TEXT NOT NULL,
        canonical_text TEXT NOT NULL CHECK (length(canonical_text) > 0),
        one_line_summary TEXT,
        takeaway TEXT,
        why_it_matters TEXT,
        structure_style TEXT NOT NULL DEFAULT 'freeform' CHECK (structure_style IN ('freeform', 'star', 'car', 'soar', 'mixed')),
        beats_json TEXT NOT NULL DEFAULT '[]',
        change_note TEXT,
        authored_by TEXT,
        is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (story_id, revision_number)
      );

      CREATE TABLE IF NOT EXISTS profile_story_revision_captures (
        revision_id INTEGER NOT NULL REFERENCES profile_story_revisions(id) ON DELETE CASCADE,
        capture_id INTEGER NOT NULL REFERENCES profile_story_captures(id) ON DELETE RESTRICT,
        PRIMARY KEY (revision_id, capture_id)
      );

      CREATE TABLE IF NOT EXISTS profile_story_variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        story_id INTEGER NOT NULL REFERENCES profile_stories(id) ON DELETE CASCADE,
        variant_key TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        based_on_revision_id INTEGER NOT NULL REFERENCES profile_story_revisions(id) ON DELETE RESTRICT,
        purpose TEXT NOT NULL CHECK (purpose IN ('general', 'cover_letter', 'resume', 'application_form', 'interview', 'networking', 'public_bio')),
        audience TEXT,
        medium TEXT NOT NULL CHECK (medium IN ('spoken', 'written')),
        length_class TEXT NOT NULL CHECK (length_class IN ('one_line', '30_seconds', '60_seconds', '2_minutes', 'short', 'medium', 'long', 'custom')),
        target_words INTEGER CHECK (target_words IS NULL OR target_words > 0),
        target_seconds INTEGER CHECK (target_seconds IS NULL OR target_seconds > 0),
        content TEXT NOT NULL CHECK (length(content) > 0),
        word_count INTEGER NOT NULL CHECK (word_count >= 0),
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
        supersedes_variant_id INTEGER REFERENCES profile_story_variants(id) ON DELETE SET NULL,
        is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
        authored_by TEXT,
        approved_by TEXT,
        approved_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (story_id, variant_key, version)
      );

      CREATE TABLE IF NOT EXISTS profile_story_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        story_id INTEGER NOT NULL REFERENCES profile_stories(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('general', 'cover_letter', 'resume', 'application_form', 'interview', 'networking', 'public_bio')),
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
        reason TEXT,
        approved_by TEXT,
        approved_at TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (story_id, purpose)
      );

      CREATE TABLE IF NOT EXISTS profile_story_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        story_id INTEGER NOT NULL REFERENCES profile_stories(id) ON DELETE CASCADE,
        question_kind TEXT NOT NULL CHECK (question_kind IN ('clarification', 'timeline', 'evidence', 'metric', 'meaning', 'impact', 'sensitivity', 'audience')),
        question TEXT NOT NULL CHECK (length(question) > 0),
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'deferred', 'dismissed')),
        answer_capture_id INTEGER REFERENCES profile_story_captures(id) ON DELETE RESTRICT,
        answer_text TEXT,
        asked_by TEXT,
        answered_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (status <> 'answered' OR answer_text IS NOT NULL)
      );

      CREATE TABLE IF NOT EXISTS profile_story_application_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        story_id INTEGER NOT NULL REFERENCES profile_stories(id) ON DELETE CASCADE,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        relation TEXT NOT NULL CHECK (relation IN ('candidate', 'prompted', 'approved', 'used', 'avoid')),
        variant_id INTEGER REFERENCES profile_story_variants(id) ON DELETE SET NULL,
        prompt_text TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (story_id, application_id, relation)
      );

      CREATE TABLE IF NOT EXISTS profile_story_uses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        story_id INTEGER NOT NULL REFERENCES profile_stories(id) ON DELETE RESTRICT,
        application_id INTEGER REFERENCES applications(id) ON DELETE RESTRICT,
        revision_id INTEGER NOT NULL REFERENCES profile_story_revisions(id) ON DELETE RESTRICT,
        variant_id INTEGER REFERENCES profile_story_variants(id) ON DELETE RESTRICT,
        purpose TEXT NOT NULL CHECK (purpose IN ('general', 'cover_letter', 'resume', 'application_form', 'interview', 'networking', 'public_bio')),
        target_kind TEXT,
        target_id INTEGER,
        prompt_text TEXT,
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        approved_by TEXT NOT NULL,
        used_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS profile_story_operations (
        idempotency_key TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_story_current_revision
        ON profile_story_revisions(story_id) WHERE is_current = 1;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_story_current_variant
        ON profile_story_variants(story_id, variant_key) WHERE is_current = 1;
      CREATE INDEX IF NOT EXISTS idx_story_status ON profile_stories(status);
      CREATE INDEX IF NOT EXISTS idx_story_capture_story ON profile_story_captures(story_id, id);
      CREATE INDEX IF NOT EXISTS idx_story_variant_purpose ON profile_story_variants(story_id, purpose, status);
      CREATE INDEX IF NOT EXISTS idx_story_permission_purpose ON profile_story_permissions(story_id, purpose);
      CREATE INDEX IF NOT EXISTS idx_story_question_open ON profile_story_questions(story_id, status, priority);
      CREATE INDEX IF NOT EXISTS idx_story_application ON profile_story_application_links(application_id, story_id);
      CREATE INDEX IF NOT EXISTS idx_story_use_application ON profile_story_uses(application_id, story_id);

      CREATE TRIGGER IF NOT EXISTS trg_story_captures_append_only_update
      BEFORE UPDATE ON profile_story_captures
      BEGIN SELECT RAISE(ABORT, 'story captures are append-only'); END;

      CREATE TRIGGER IF NOT EXISTS trg_story_captures_append_only_delete
      BEFORE DELETE ON profile_story_captures
      BEGIN SELECT RAISE(ABORT, 'story captures are append-only'); END;

      CREATE TRIGGER IF NOT EXISTS trg_story_capture_supersedes_same_story
      BEFORE INSERT ON profile_story_captures
      WHEN NEW.supersedes_capture_id IS NOT NULL
        AND (SELECT story_id FROM profile_story_captures WHERE id = NEW.supersedes_capture_id) IS NOT NEW.story_id
      BEGIN SELECT RAISE(ABORT, 'superseded capture belongs to another story'); END;

      CREATE TRIGGER IF NOT EXISTS trg_story_revision_content_immutable
      BEFORE UPDATE ON profile_story_revisions
      WHEN OLD.story_id IS NOT NEW.story_id
        OR OLD.revision_number IS NOT NEW.revision_number
        OR OLD.title IS NOT NEW.title
        OR OLD.canonical_text IS NOT NEW.canonical_text
        OR OLD.one_line_summary IS NOT NEW.one_line_summary
        OR OLD.takeaway IS NOT NEW.takeaway
        OR OLD.why_it_matters IS NOT NEW.why_it_matters
        OR OLD.structure_style IS NOT NEW.structure_style
        OR OLD.beats_json IS NOT NEW.beats_json
        OR OLD.change_note IS NOT NEW.change_note
        OR OLD.authored_by IS NOT NEW.authored_by
        OR OLD.created_at IS NOT NEW.created_at
      BEGIN SELECT RAISE(ABORT, 'story revision content is immutable'); END;

      CREATE TRIGGER IF NOT EXISTS trg_story_revision_capture_same_story
      BEFORE INSERT ON profile_story_revision_captures
      WHEN (SELECT story_id FROM profile_story_revisions WHERE id = NEW.revision_id)
        IS NOT (SELECT story_id FROM profile_story_captures WHERE id = NEW.capture_id)
      BEGIN SELECT RAISE(ABORT, 'revision and capture belong to different stories'); END;

      CREATE TRIGGER IF NOT EXISTS trg_story_variant_content_immutable
      BEFORE UPDATE ON profile_story_variants
      WHEN OLD.story_id IS NOT NEW.story_id
        OR OLD.variant_key IS NOT NEW.variant_key
        OR OLD.version IS NOT NEW.version
        OR OLD.based_on_revision_id IS NOT NEW.based_on_revision_id
        OR OLD.purpose IS NOT NEW.purpose
        OR OLD.audience IS NOT NEW.audience
        OR OLD.medium IS NOT NEW.medium
        OR OLD.length_class IS NOT NEW.length_class
        OR OLD.target_words IS NOT NEW.target_words
        OR OLD.target_seconds IS NOT NEW.target_seconds
        OR OLD.content IS NOT NEW.content
        OR OLD.word_count IS NOT NEW.word_count
        OR OLD.supersedes_variant_id IS NOT NEW.supersedes_variant_id
        OR OLD.authored_by IS NOT NEW.authored_by
        OR OLD.created_at IS NOT NEW.created_at
      BEGIN SELECT RAISE(ABORT, 'story variant content is immutable'); END;

      CREATE TRIGGER IF NOT EXISTS trg_story_variant_revision_same_story
      BEFORE INSERT ON profile_story_variants
      WHEN (SELECT story_id FROM profile_story_revisions WHERE id = NEW.based_on_revision_id) IS NOT NEW.story_id
      BEGIN SELECT RAISE(ABORT, 'variant revision belongs to another story'); END;

      CREATE TRIGGER IF NOT EXISTS trg_story_application_variant_same_story_insert
      BEFORE INSERT ON profile_story_application_links
      WHEN NEW.variant_id IS NOT NULL
        AND (SELECT story_id FROM profile_story_variants WHERE id = NEW.variant_id) IS NOT NEW.story_id
      BEGIN SELECT RAISE(ABORT, 'application-link variant belongs to another story'); END;

      CREATE TRIGGER IF NOT EXISTS trg_story_application_variant_same_story_update
      BEFORE UPDATE OF variant_id, story_id ON profile_story_application_links
      WHEN NEW.variant_id IS NOT NULL
        AND (SELECT story_id FROM profile_story_variants WHERE id = NEW.variant_id) IS NOT NEW.story_id
      BEGIN SELECT RAISE(ABORT, 'application-link variant belongs to another story'); END;

      CREATE TRIGGER IF NOT EXISTS trg_story_use_immutable_update
      BEFORE UPDATE ON profile_story_uses
      BEGIN SELECT RAISE(ABORT, 'story use records are immutable'); END;

      CREATE TRIGGER IF NOT EXISTS trg_story_use_immutable_delete
      BEFORE DELETE ON profile_story_uses
      BEGIN SELECT RAISE(ABORT, 'story use records are immutable'); END;

      CREATE TRIGGER IF NOT EXISTS trg_story_use_variant_same_story
      BEFORE INSERT ON profile_story_uses
      WHEN NEW.variant_id IS NOT NULL
        AND (SELECT story_id FROM profile_story_variants WHERE id = NEW.variant_id) IS NOT NEW.story_id
      BEGIN SELECT RAISE(ABORT, 'story-use variant belongs to another story'); END;

      CREATE TRIGGER IF NOT EXISTS trg_story_use_revision_same_story
      BEFORE INSERT ON profile_story_uses
      WHEN (SELECT story_id FROM profile_story_revisions WHERE id = NEW.revision_id) IS NOT NEW.story_id
      BEGIN SELECT RAISE(ABORT, 'story-use revision belongs to another story'); END;
    `);

    backfillLegacyStories(db);
    db.prepare(`
      INSERT INTO jobtrack_schema_migrations (version, name)
      VALUES (?, 'first_class_story_library')
    `).run(STORY_SCHEMA_VERSION);
    }
    applyStoryHardeningMigration(db);
    applyStoryFacetsMigration(db);
    applyStoryGateMigration(db);
  };
  if (db.inTransaction) applyMigration();
  else db.transaction(applyMigration).immediate();
}

/**
 * The story-mapping GATE's check ledger. One row per question per gate run:
 * what was asked, which facets were sought, and what the gate decided —
 * mapped (a ready, permitted story qualifies), needs_approval (a story
 * qualifies but its use awaits Cole), or blocked (no story exists; the
 * application must not be submitted until Cole authors one). The rows are the
 * durable escalation record the retry loop works from.
 */
function applyStoryGateMigration(db) {
  if (db.prepare('SELECT 1 FROM jobtrack_schema_migrations WHERE version = ?').get(STORY_GATE_SCHEMA_VERSION)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_story_gate_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER REFERENCES applications(id) ON DELETE RESTRICT,
      purpose TEXT NOT NULL CHECK (purpose IN ('general', 'cover_letter', 'resume', 'application_form', 'interview', 'networking', 'public_bio')),
      question_key TEXT NOT NULL,
      prompt_text TEXT NOT NULL CHECK (length(prompt_text) > 0),
      prompt_digest TEXT NOT NULL CHECK (length(prompt_digest) = 64),
      facets_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(facets_json)),
      required INTEGER NOT NULL CHECK (required IN (0, 1)),
      decision TEXT NOT NULL CHECK (decision IN ('mapped', 'needs_approval', 'blocked')),
      story_id INTEGER REFERENCES profile_stories(id) ON DELETE RESTRICT,
      match_score INTEGER,
      reasons_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons_json)),
      run_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK ((decision = 'blocked') = (story_id IS NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_story_gate_checks_application ON profile_story_gate_checks(application_id, run_key, id);
    CREATE INDEX IF NOT EXISTS idx_story_gate_checks_run ON profile_story_gate_checks(run_key, id);
  `);
  db.prepare(`
    INSERT INTO jobtrack_schema_migrations (version, name)
    VALUES (?, 'story_gate_checks')
  `).run(STORY_GATE_SCHEMA_VERSION);
}

/**
 * Facet CLAIMS: one story is multi-faceted, and a tag alone cannot say what
 * the story actually demonstrates. A facet claim binds a retrieval slug to a
 * one-sentence claim the story supports ("demonstrates: leading without
 * authority"), optionally anchored to the beat that supports it, with a
 * weight for how central the facet is (1 present, 2 central, 3 defining).
 * Claims make `story match` framing-robust: a question phrased in words the
 * canonical text never uses still lands through its facets.
 */
function applyStoryFacetsMigration(db) {
  if (db.prepare('SELECT 1 FROM jobtrack_schema_migrations WHERE version = ?').get(STORY_FACETS_SCHEMA_VERSION)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_story_facets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      story_id INTEGER NOT NULL REFERENCES profile_stories(id) ON DELETE CASCADE,
      facet TEXT NOT NULL CHECK (
        length(facet) BETWEEN 2 AND 48
        AND facet GLOB '[a-z]*'
        AND facet NOT GLOB '*[^a-z0-9_-]*'
      ),
      claim TEXT NOT NULL CHECK (length(claim) > 0),
      beat_anchor TEXT,
      weight INTEGER NOT NULL DEFAULT 2 CHECK (weight BETWEEN 1 AND 3),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (story_id, facet)
    );

    CREATE INDEX IF NOT EXISTS idx_story_facets_facet ON profile_story_facets(facet, story_id);
  `);
  db.prepare(`
    INSERT INTO jobtrack_schema_migrations (version, name)
    VALUES (?, 'story_facet_claims')
  `).run(STORY_FACETS_SCHEMA_VERSION);
}

function applyStoryHardeningMigration(db) {
  if (db.prepare('SELECT 1 FROM jobtrack_schema_migrations WHERE version = ?').get(STORY_HARDENING_SCHEMA_VERSION)) return;
  if (!tableExists(db, 'profile_story_uses')) throw new Error('Story use audit table is missing');

  // The first development version of the story schema required an application
  // and did not bind use events to exact prose. Rebuild transactionally so
  // non-application uses can be audited and every historical row gains an
  // immutable revision/content identity.
  const useColumns = db.prepare('PRAGMA table_info(profile_story_uses)').all();
  const needsUseRebuild = !useColumns.some((row) => row.name === 'revision_id')
    || !useColumns.some((row) => row.name === 'content_sha256')
    || useColumns.find((row) => row.name === 'application_id').notnull === 1;
  if (needsUseRebuild) rebuildStoryUses(db);
  ensureStoryColumn(db, 'profile_story_questions', 'answer_capture_id', 'INTEGER REFERENCES profile_story_captures(id) ON DELETE RESTRICT');

  const legacyAnswers = db.prepare(`
    SELECT id, story_id, answer_text, answered_at, updated_at
    FROM profile_story_questions
    WHERE status = 'answered' AND answer_text IS NOT NULL AND answer_capture_id IS NULL
    ORDER BY id
  `).all();
  for (const question of legacyAnswers) {
    const captureId = db.prepare(`
      INSERT INTO profile_story_captures
        (story_id, capture_kind, raw_text, source_label, captured_by, captured_at, sha256)
      VALUES (?, 'conversation', ?, 'Legacy question answer migration', 'jobtrack migration', COALESCE(?, ?), ?)
    `).run(
      question.story_id,
      question.answer_text,
      question.answered_at,
      question.updated_at,
      sha256(question.answer_text)
    ).lastInsertRowid;
    db.prepare('UPDATE profile_story_questions SET answer_capture_id = ?, answer_text = ? WHERE id = ?')
      .run(captureId, PROTECTED_ANSWER_PLACEHOLDER, question.id);
  }
  sanitizeStoredStoryOperationResults(db);

  const unresolved = db.prepare(`
    SELECT id FROM profile_story_uses
    WHERE revision_id IS NULL OR content_sha256 IS NULL OR length(content_sha256) <> 64
    LIMIT 1
  `).get();
  if (unresolved) throw new Error(`Story use ${unresolved.id} could not be bound to immutable content`);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_story_use_application ON profile_story_uses(application_id, story_id);

    CREATE TRIGGER IF NOT EXISTS trg_story_use_immutable_update
    BEFORE UPDATE ON profile_story_uses
    BEGIN SELECT RAISE(ABORT, 'story use records are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_story_use_immutable_delete
    BEFORE DELETE ON profile_story_uses
    BEGIN SELECT RAISE(ABORT, 'story use records are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_story_use_variant_same_story
    BEFORE INSERT ON profile_story_uses
    WHEN NEW.variant_id IS NOT NULL
      AND (SELECT story_id FROM profile_story_variants WHERE id = NEW.variant_id) IS NOT NEW.story_id
    BEGIN SELECT RAISE(ABORT, 'story-use variant belongs to another story'); END;

    CREATE TRIGGER IF NOT EXISTS trg_story_use_revision_required
    BEFORE INSERT ON profile_story_uses
    WHEN NEW.revision_id IS NULL
      OR NEW.content_sha256 IS NULL
      OR length(NEW.content_sha256) <> 64
    BEGIN SELECT RAISE(ABORT, 'story use must bind an immutable revision and content hash'); END;

    CREATE TRIGGER IF NOT EXISTS trg_story_use_revision_same_story
    BEFORE INSERT ON profile_story_uses
    WHEN (SELECT story_id FROM profile_story_revisions WHERE id = NEW.revision_id) IS NOT NEW.story_id
    BEGIN SELECT RAISE(ABORT, 'story-use revision belongs to another story'); END;

    CREATE TRIGGER IF NOT EXISTS trg_story_question_answer_capture_same_story
    BEFORE INSERT ON profile_story_questions
    WHEN NEW.answer_capture_id IS NOT NULL
      AND (SELECT story_id FROM profile_story_captures WHERE id = NEW.answer_capture_id) IS NOT NEW.story_id
    BEGIN SELECT RAISE(ABORT, 'question answer capture belongs to another story'); END;

    CREATE TRIGGER IF NOT EXISTS trg_story_question_answer_capture_same_story_update
    BEFORE UPDATE OF answer_capture_id, story_id ON profile_story_questions
    WHEN NEW.answer_capture_id IS NOT NULL
      AND (SELECT story_id FROM profile_story_captures WHERE id = NEW.answer_capture_id) IS NOT NEW.story_id
    BEGIN SELECT RAISE(ABORT, 'question answer capture belongs to another story'); END;
  `);
  db.prepare(`
    INSERT INTO jobtrack_schema_migrations (version, name)
    VALUES (?, 'story_revision_bound_use_audit')
  `).run(STORY_HARDENING_SCHEMA_VERSION);
}

function sanitizeStoredStoryOperationResults(db) {
  const rows = db.prepare("SELECT idempotency_key, result_json FROM profile_story_operations WHERE command='answer-question'").all();
  const update = db.prepare('UPDATE profile_story_operations SET result_json = ? WHERE idempotency_key = ?');
  for (const row of rows) {
    let result;
    try { result = JSON.parse(row.result_json); } catch { throw new Error(`Stored story operation ${row.idempotency_key} has invalid JSON`); }
    if (!result || !result.story || !Array.isArray(result.story.questions)) continue;
    let changed = false;
    result.story.questions = result.story.questions.map((question) => {
      if (!question || typeof question !== 'object' || question.answer_text === undefined) return question;
      const { answer_text: _rawAnswer, ...safe } = question;
      changed = true;
      return { ...safe, has_answer: question.status === 'answered' };
    });
    if (changed) update.run(JSON.stringify(result), row.idempotency_key);
  }
}

function rebuildStoryUses(db) {
  const rows = db.prepare('SELECT * FROM profile_story_uses ORDER BY id').all();
  const preserved = rows.map((row) => ({ ...row, ...resolveLegacyUseBinding(db, row) }));
  db.exec(`
    DROP TRIGGER IF EXISTS trg_story_use_immutable_update;
    DROP TRIGGER IF EXISTS trg_story_use_immutable_delete;
    DROP TRIGGER IF EXISTS trg_story_use_variant_same_story;
    DROP TRIGGER IF EXISTS trg_story_use_revision_same_story;
    DROP TRIGGER IF EXISTS trg_story_use_revision_required;
    DROP INDEX IF EXISTS idx_story_use_application;
    ALTER TABLE profile_story_uses RENAME TO profile_story_uses_legacy_1704;

    CREATE TABLE profile_story_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      story_id INTEGER NOT NULL REFERENCES profile_stories(id) ON DELETE RESTRICT,
      application_id INTEGER REFERENCES applications(id) ON DELETE RESTRICT,
      revision_id INTEGER NOT NULL REFERENCES profile_story_revisions(id) ON DELETE RESTRICT,
      variant_id INTEGER REFERENCES profile_story_variants(id) ON DELETE RESTRICT,
      purpose TEXT NOT NULL CHECK (purpose IN ('general', 'cover_letter', 'resume', 'application_form', 'interview', 'networking', 'public_bio')),
      target_kind TEXT,
      target_id INTEGER,
      prompt_text TEXT,
      content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
      approved_by TEXT NOT NULL,
      used_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const insert = db.prepare(`
    INSERT INTO profile_story_uses
      (id, story_id, application_id, revision_id, variant_id, purpose, target_kind, target_id,
       prompt_text, content_sha256, approved_by, used_at, created_at)
    VALUES
      (@id, @story_id, @application_id, @revision_id, @variant_id, @purpose, @target_kind, @target_id,
       @prompt_text, @content_sha256, @approved_by, @used_at, @created_at)
  `);
  for (const row of preserved) insert.run(row);
  db.exec('DROP TABLE profile_story_uses_legacy_1704');
}

function resolveLegacyUseBinding(db, row) {
  const variant = row.variant_id
    ? db.prepare('SELECT story_id, based_on_revision_id, content FROM profile_story_variants WHERE id = ?').get(row.variant_id)
    : null;
  if (row.variant_id && (!variant || variant.story_id !== row.story_id)) {
    throw new Error(`Cannot bind legacy story use ${row.id}: its variant is missing or belongs to another story`);
  }
  let revision;
  if (variant) {
    revision = db.prepare('SELECT id, canonical_text FROM profile_story_revisions WHERE id = ? AND story_id = ?')
      .get(variant.based_on_revision_id, row.story_id);
  } else if (row.revision_id) {
    revision = db.prepare('SELECT id, canonical_text FROM profile_story_revisions WHERE id = ? AND story_id = ?')
      .get(row.revision_id, row.story_id);
  } else {
    revision = db.prepare(`
      SELECT id, canonical_text FROM profile_story_revisions
      WHERE story_id = ? AND datetime(created_at) <= datetime(?)
      ORDER BY datetime(created_at) DESC, revision_number DESC, id DESC LIMIT 1
    `).get(row.story_id, row.used_at);
  }
  if (!revision) throw new Error(`Cannot bind legacy story use ${row.id}: no contemporaneous canonical revision exists`);
  return { revision_id: revision.id, content_sha256: sha256(variant ? variant.content : revision.canonical_text) };
}

function ensureStoryColumn(db, table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function backfillLegacyStories(db) {
  const answerFilter = tableExists(db, 'profile_answers')
    ? 'AND NOT EXISTS (SELECT 1 FROM profile_answers pa WHERE pa.profile_entry_id = pe.id)'
    : '';
  const rows = db.prepare(`
    SELECT pe.* FROM profile_entries pe
    WHERE pe.category = 'story'
      ${answerFilter}
      AND NOT EXISTS (SELECT 1 FROM profile_stories ps WHERE ps.profile_entry_id = pe.id)
    ORDER BY pe.id
  `).all();

  for (const entry of rows) {
    const storyId = db.prepare(`
      INSERT INTO profile_stories
        (profile_entry_id, status, sensitivity, default_use_decision, lock_version, created_at, updated_at)
      VALUES (?, 'needs_review', 'private', 'ask', 1, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
    `).run(entry.id, entry.created_at, entry.updated_at).lastInsertRowid;
    const raw = entry.content;
    const captureId = db.prepare(`
      INSERT INTO profile_story_captures
        (story_id, capture_kind, raw_text, source_label, source_url, attachment_path, captured_at, sha256, created_at)
      VALUES (?, 'legacy_import', ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, COALESCE(?, datetime('now')))
    `).run(storyId, raw, entry.source || 'legacy profile entry', entry.source_url || null, entry.attachment_path || null, entry.created_at, sha256(raw), entry.created_at).lastInsertRowid;
    const revisionId = db.prepare(`
      INSERT INTO profile_story_revisions
        (story_id, revision_number, title, canonical_text, one_line_summary, structure_style, beats_json, change_note, authored_by, is_current, created_at)
      VALUES (?, 1, ?, ?, NULL, 'freeform', '[]', 'Migrated from flat profile story without changing source text.', 'jobtrack migration', 1, COALESCE(?, datetime('now')))
    `).run(storyId, entry.title, raw, entry.updated_at || entry.created_at).lastInsertRowid;
    db.prepare('INSERT INTO profile_story_revision_captures (revision_id, capture_id) VALUES (?, ?)').run(revisionId, captureId);
  }
}

function runStoryCommand(db, args, flags = {}, context = {}) {
  migrateStories(db);
  const command = normalizeCommand(args);
  assertCommandFlags(flags, STORY_COMMAND_FLAGS[command], `story ${command || '(missing)'}`);
  switch (command) {
    case 'capture': return captureStory(db, flags, context);
    case 'append-capture': return appendCapture(db, flags, context);
    case 'polish': return polishStory(db, flags, context);
    case 'add-variant': return addVariant(db, flags, context, false);
    case 'revise-variant': return addVariant(db, flags, context, true);
    case 'approve-variant': return approveVariant(db, flags, context);
    case 'set-permission': return setPermission(db, flags, context);
    case 'update-metadata': return updateStoryMetadata(db, flags, context);
    case 'add-question': return addQuestion(db, flags, context);
    case 'answer-question': return resolveQuestion(db, flags, context, 'answered');
    case 'defer-question': return resolveQuestion(db, flags, context, 'deferred');
    case 'dismiss-question': return resolveQuestion(db, flags, context, 'dismissed');
    case 'claim-facet': return claimFacet(db, flags, context);
    case 'retract-facet': return retractFacet(db, flags, context);
    case 'link-application': return linkApplication(db, flags, context);
    case 'record-use': return recordUse(db, flags, context);
    case 'show': return storyResponse('show', getStory(db, requiredId(flags.storyId || args[1], 'story id'), { includeRaw: booleanFlag(flags.includeRaw) }));
    case 'list': return listStories(db, flags);
    case 'match': return matchStories(db, flags, context);
    case 'gate': return runGate(db, flags, context);
    default: throw new Error(`Unknown story command: ${command || '(missing)'}`);
  }
}

function assertCommandFlags(flags, allowed, label) {
  if (!allowed) return;
  const accepted = new Set(allowed);
  const unknown = Object.keys(flags).filter((key) => !accepted.has(key));
  if (unknown.length) throw new Error(`Unknown flag(s) for ${label}: ${unknown.sort().map((key) => `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`).join(', ')}`);
}

function captureStory(db, flags, context) {
  const raw = readExact(flags.raw, flags.rawFile, '--raw or --raw-file', context);
  const source = requiredText(flags.source, '--source');
  const title = requiredText(flags.title, '--title');
  const confidence = enumValue(flags.confidence || 'unverified', CONFIDENCE, 'confidence');
  const sensitivity = enumValue(flags.sensitivity || 'private', SENSITIVITIES, 'sensitivity');
  const defaultUse = enumValue(flags.defaultUseDecision || flags.defaultUse || 'ask', USE_DECISIONS, 'default-use-decision');
  if (defaultUse === 'allow') throw new Error('New stories cannot default to allow; grant each external purpose with set-permission');
  const captureKind = enumValue(flags.captureKind || 'conversation', CAPTURE_KINDS, 'capture-kind');
  const tags = normalizeTags(flags.tags || flags.tag);
  validateOptionalDate(flags.occurredStart, '--occurred-start');
  validateOptionalDate(flags.occurredEnd, '--occurred-end');
  validateOptionalDate(flags.capturedAt, '--captured-at');
  validateDateRange(flags.occurredStart, flags.occurredEnd, '--occurred-start', '--occurred-end');
  const request = { raw, source, title, confidence, sensitivity, defaultUse, captureKind, tags, summary: nullable(flags.summary), occurredStart: nullable(flags.occurredStart), occurredEnd: nullable(flags.occurredEnd), datePrecision: nullable(flags.datePrecision), setting: nullable(flags.setting), sourceUrl: nullable(flags.sourceUrl), attachmentPath: nullable(flags.attachmentPath), capturedBy: nullable(flags.capturedBy), capturedAt: nullable(flags.capturedAt), evidence: nullable(flags.evidence), recency: nullable(flags.recency) };
  return idempotentMutation(db, 'capture', flags, request, () => {
    const entryId = db.prepare(`
      INSERT INTO profile_entries
        (category, title, content, source, source_url, evidence, attachment_path, recency, confidence, tags, updated_at)
      VALUES ('story', @title, @content, @source, @sourceUrl, @evidence, @attachmentPath, @recency, @confidence, @tags, datetime('now'))
    `).run({
      title,
      content: nullable(flags.summary) || '[Captured story awaiting canonical revision]',
      source,
      sourceUrl: nullable(flags.sourceUrl),
      evidence: nullable(flags.evidence),
      attachmentPath: nullable(flags.attachmentPath),
      recency: nullable(flags.recency),
      confidence,
      tags: JSON.stringify(tags)
    }).lastInsertRowid;
    const storyId = db.prepare(`
      INSERT INTO profile_stories
        (profile_entry_id, status, occurred_start, occurred_end, date_precision, setting, sensitivity, default_use_decision, lock_version, updated_at)
      VALUES (?, 'captured', ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    `).run(entryId, nullable(flags.occurredStart), nullable(flags.occurredEnd), nullable(flags.datePrecision), nullable(flags.setting), sensitivity, defaultUse).lastInsertRowid;
    const captureId = insertCapture(db, storyId, raw, {
      kind: captureKind,
      source,
      sourceUrl: nullable(flags.sourceUrl),
      attachmentPath: nullable(flags.attachmentPath),
      capturedBy: nullable(flags.capturedBy),
      capturedAt: nullable(flags.capturedAt),
      supersedesCaptureId: null
    });
    return storyResponse('capture', getStory(db, storyId), { captureId });
  });
}

function appendCapture(db, flags, context) {
  const storyId = requiredId(flags.storyId, '--story-id');
  const expectedVersion = requiredVersion(flags.expectedVersion);
  const raw = readExact(flags.raw, flags.rawFile, '--raw or --raw-file', context);
  const source = requiredText(flags.source, '--source');
  const kind = enumValue(flags.captureKind || 'correction', CAPTURE_KINDS, 'capture-kind');
  validateOptionalDate(flags.capturedAt, '--captured-at');
  const request = { storyId, expectedVersion, raw, source, kind, sourceUrl: nullable(flags.sourceUrl), attachmentPath: nullable(flags.attachmentPath), capturedBy: nullable(flags.capturedBy), capturedAt: nullable(flags.capturedAt), supersedesCaptureId: optionalId(flags.supersedesCaptureId, '--supersedes-capture-id') };
  return idempotentMutation(db, 'append-capture', flags, request, () => {
    const story = assertStoryVersion(db, storyId, expectedVersion);
    if (request.supersedesCaptureId) assertCaptureBelongs(db, request.supersedesCaptureId, storyId);
    const captureId = insertCapture(db, storyId, raw, {
      kind, source, sourceUrl: request.sourceUrl, attachmentPath: request.attachmentPath,
      capturedBy: request.capturedBy, capturedAt: nullable(flags.capturedAt), supersedesCaptureId: request.supersedesCaptureId
    });
    bumpStory(db, story, 'developing');
    return storyResponse('append-capture', getStory(db, storyId), { captureId });
  });
}

function polishStory(db, flags, context) {
  const storyId = requiredId(flags.storyId, '--story-id');
  const expectedVersion = requiredVersion(flags.expectedVersion);
  const canonical = readExact(flags.canonical, flags.canonicalFile, '--canonical or --canonical-file', context);
  const title = requiredText(flags.title || getProfileTitle(db, storyId), '--title');
  const status = enumValue(flags.status || 'ready', STORY_STATUSES, 'status');
  const structure = enumValue(flags.structure || 'freeform', new Set(['freeform', 'star', 'car', 'soar', 'mixed']), 'structure');
  const beats = normalizeBeats(flags, context);
  const captureIds = normalizeIds(flags.captureIds);
  const request = { storyId, expectedVersion, canonical, title, status, structure, beats, captureIds, summary: nullable(flags.summary), takeaway: nullable(flags.takeaway), whyItMatters: nullable(flags.whyItMatters), changeNote: nullable(flags.changeNote), authoredBy: nullable(flags.authoredBy) };
  return idempotentMutation(db, 'polish', flags, request, () => {
    const story = assertStoryVersion(db, storyId, expectedVersion);
    for (const captureId of captureIds) assertCaptureBelongs(db, captureId, storyId);
    const revisionNumber = db.prepare('SELECT COALESCE(MAX(revision_number), 0) + 1 AS n FROM profile_story_revisions WHERE story_id = ?').get(storyId).n;
    db.prepare('UPDATE profile_story_revisions SET is_current = 0 WHERE story_id = ? AND is_current = 1').run(storyId);
    const revisionId = db.prepare(`
      INSERT INTO profile_story_revisions
        (story_id, revision_number, title, canonical_text, one_line_summary, takeaway, why_it_matters, structure_style, beats_json, change_note, authored_by, is_current)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(storyId, revisionNumber, title, canonical, nullable(flags.summary), nullable(flags.takeaway), nullable(flags.whyItMatters), structure, JSON.stringify(beats), nullable(flags.changeNote), nullable(flags.authoredBy)).lastInsertRowid;
    db.prepare(`
      UPDATE profile_story_permissions
      SET decision='ask', reason='Canonical revision changed; explicit reapproval required.',
        approved_by=NULL, approved_at=NULL, expires_at=NULL, updated_at=datetime('now')
      WHERE story_id=? AND decision='allow'
    `).run(storyId);
    db.prepare(`
      UPDATE profile_story_variants
      SET status='draft', approved_by=NULL, approved_at=NULL
      WHERE story_id=? AND is_current=1 AND status='approved'
    `).run(storyId);
    const sources = captureIds.length ? captureIds : db.prepare('SELECT id FROM profile_story_captures WHERE story_id = ? ORDER BY id').all(storyId).map((row) => row.id);
    const link = db.prepare('INSERT INTO profile_story_revision_captures (revision_id, capture_id) VALUES (?, ?)');
    for (const captureId of sources) link.run(revisionId, captureId);
    db.prepare("UPDATE profile_entries SET title = ?, content = ?, updated_at = datetime('now') WHERE id = ?").run(title, canonical, story.profile_entry_id);
    bumpStory(db, story, status);
    return storyResponse('polish', getStory(db, storyId), { revisionId });
  });
}

function addVariant(db, flags, context, revise) {
  const storyId = requiredId(flags.storyId, '--story-id');
  const expectedVersion = requiredVersion(flags.expectedVersion);
  const key = requiredText(flags.key || flags.variantKey, '--key');
  const content = readExact(flags.content, flags.contentFile, '--content or --content-file', context);
  const current = db.prepare('SELECT * FROM profile_story_variants WHERE story_id = ? AND variant_key = ? AND is_current = 1').get(storyId, key) || null;
  if (revise && !current) throw new Error(`Current variant ${key} not found for story ${storyId}`);
  if (!revise && current) throw new Error(`Current variant ${key} already exists for story ${storyId}; use revise-variant`);
  const purpose = enumValue(flags.purpose || (current && current.purpose) || 'general', VARIANT_PURPOSES, 'purpose');
  const medium = enumValue(flags.medium || (current && current.medium) || 'written', VARIANT_MEDIA, 'medium');
  const lengthClass = enumValue(flags.length || flags.lengthClass || (current && current.length_class) || 'custom', VARIANT_LENGTHS, 'length');
  const status = enumValue(flags.status || 'draft', VARIANT_STATUSES, 'status');
  if (status === 'approved') throw new Error('Create variants as draft, then use approve-variant with --approved-by');
  const request = { storyId, expectedVersion, key, revise, content, purpose, medium, lengthClass, status, audience: nullable(flags.audience !== undefined ? flags.audience : current && current.audience), targetWords: optionalPositiveInt(flags.targetWords, '--target-words'), targetSeconds: optionalPositiveInt(flags.targetSeconds, '--target-seconds'), authoredBy: nullable(flags.authoredBy) };
  return idempotentMutation(db, revise ? 'revise-variant' : 'add-variant', flags, request, () => {
    const story = assertStoryVersion(db, storyId, expectedVersion);
    const revision = currentRevision(db, storyId);
    if (!revision) throw new Error(`Story ${storyId} must have a canonical revision before adding variants`);
    if (current) db.prepare('UPDATE profile_story_variants SET is_current = 0 WHERE id = ?').run(current.id);
    const version = current ? current.version + 1 : 1;
    const variantId = db.prepare(`
      INSERT INTO profile_story_variants
        (story_id, variant_key, version, based_on_revision_id, purpose, audience, medium, length_class, target_words, target_seconds, content, word_count, status, supersedes_variant_id, is_current, authored_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(storyId, key, version, revision.id, purpose, request.audience, medium, lengthClass, request.targetWords, request.targetSeconds, content, wordCount(content), status, current ? current.id : null, request.authoredBy).lastInsertRowid;
    bumpStory(db, story, story.status);
    return storyResponse(revise ? 'revise-variant' : 'add-variant', getStory(db, storyId), { variantId });
  });
}

function approveVariant(db, flags) {
  const storyId = requiredId(flags.storyId, '--story-id');
  const expectedVersion = requiredVersion(flags.expectedVersion);
  const variantId = requiredId(flags.variantId, '--variant-id');
  const approvedBy = requiredText(flags.approvedBy, '--approved-by');
  const request = { storyId, expectedVersion, variantId, approvedBy };
  return idempotentMutation(db, 'approve-variant', flags, request, () => {
    const story = assertStoryVersion(db, storyId, expectedVersion);
    const variant = assertVariantBelongs(db, variantId, storyId);
    if (!variant.is_current) throw new Error(`Variant ${variantId} is not current`);
    const revision = currentRevision(db, storyId);
    if (!revision || variant.based_on_revision_id !== revision.id) {
      throw new Error(`Variant ${variantId} is based on an older canonical revision; revise it before approval`);
    }
    db.prepare("UPDATE profile_story_variants SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ?").run(approvedBy, variantId);
    bumpStory(db, story, story.status);
    return storyResponse('approve-variant', getStory(db, storyId), { variantId });
  });
}

function setPermission(db, flags) {
  const storyId = requiredId(flags.storyId, '--story-id');
  const expectedVersion = requiredVersion(flags.expectedVersion);
  const purpose = enumValue(flags.purpose, PURPOSES, 'purpose');
  const decision = enumValue(flags.decision, USE_DECISIONS, 'decision');
  if (decision === 'allow' && !flags.approvedBy) throw new Error('--approved-by is required when allowing story use');
  validateOptionalDate(flags.expiresAt, '--expires-at');
  const request = { storyId, expectedVersion, purpose, decision, reason: nullable(flags.reason), approvedBy: nullable(flags.approvedBy), expiresAt: nullable(flags.expiresAt) };
  return idempotentMutation(db, 'set-permission', flags, request, () => {
    const story = assertStoryVersion(db, storyId, expectedVersion);
    if (decision === 'allow' && story.status !== 'ready') throw new Error(`Story ${storyId} must be ready before use can be allowed`);
    db.prepare(`
      INSERT INTO profile_story_permissions
        (story_id, purpose, decision, reason, approved_by, approved_at, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END, ?, datetime('now'))
      ON CONFLICT(story_id, purpose) DO UPDATE SET
        decision = excluded.decision, reason = excluded.reason, approved_by = excluded.approved_by,
        approved_at = excluded.approved_at, expires_at = excluded.expires_at, updated_at = datetime('now')
    `).run(storyId, purpose, decision, request.reason, request.approvedBy, request.approvedBy, request.expiresAt);
    bumpStory(db, story, story.status);
    return storyResponse('set-permission', getStory(db, storyId), { purpose, decision });
  });
}

function updateStoryMetadata(db, flags) {
  const storyId = requiredId(flags.storyId, '--story-id');
  const expectedVersion = requiredVersion(flags.expectedVersion);
  const provided = [
    'title', 'occurredStart', 'occurredEnd', 'datePrecision', 'setting', 'sensitivity',
    'defaultUseDecision', 'defaultUse', 'confidence', 'source', 'sourceUrl', 'evidence',
    'attachmentPath', 'recency', 'tags', 'tag'
  ].some((key) => flags[key] !== undefined);
  if (!provided) throw new Error('Provide at least one story metadata field to update');
  const sensitivity = flags.sensitivity === undefined ? null : enumValue(flags.sensitivity, SENSITIVITIES, 'sensitivity');
  const defaultUse = flags.defaultUseDecision === undefined && flags.defaultUse === undefined
    ? null
    : enumValue(flags.defaultUseDecision || flags.defaultUse, USE_DECISIONS, 'default-use-decision');
  if (defaultUse === 'allow') throw new Error('Story defaults cannot be allow; grant each purpose explicitly');
  const confidence = flags.confidence === undefined ? null : enumValue(flags.confidence, CONFIDENCE, 'confidence');
  validateOptionalDate(flags.occurredStart, '--occurred-start');
  validateOptionalDate(flags.occurredEnd, '--occurred-end');
  const tags = flags.tags === undefined && flags.tag === undefined ? null : normalizeTags(flags.tags || flags.tag);
  const request = {
    storyId, expectedVersion,
    title: nullable(flags.title), occurredStart: nullable(flags.occurredStart), occurredEnd: nullable(flags.occurredEnd),
    datePrecision: nullable(flags.datePrecision), setting: nullable(flags.setting), sensitivity,
    defaultUse, confidence, source: nullable(flags.source), sourceUrl: nullable(flags.sourceUrl),
    evidence: nullable(flags.evidence), attachmentPath: nullable(flags.attachmentPath),
    recency: nullable(flags.recency), tags
  };
  return idempotentMutation(db, 'update-metadata', flags, request, () => {
    const story = assertStoryVersion(db, storyId, expectedVersion);
    const effectiveStart = flags.occurredStart !== undefined ? request.occurredStart : story.occurred_start;
    const effectiveEnd = flags.occurredEnd !== undefined ? request.occurredEnd : story.occurred_end;
    validateDateRange(effectiveStart, effectiveEnd, '--occurred-start', '--occurred-end');
    const storySet = [];
    const entrySet = [];
    const params = { storyId, entryId: story.profile_entry_id };
    const storyFields = {
      occurredStart: 'occurred_start', occurredEnd: 'occurred_end', datePrecision: 'date_precision',
      setting: 'setting', sensitivity: 'sensitivity', defaultUse: 'default_use_decision'
    };
    const entryFields = {
      title: 'title', confidence: 'confidence', source: 'source', sourceUrl: 'source_url',
      evidence: 'evidence', attachmentPath: 'attachment_path', recency: 'recency'
    };
    for (const [key, column] of Object.entries(storyFields)) {
      const flagWasProvided = key === 'defaultUse'
        ? flags.defaultUseDecision !== undefined || flags.defaultUse !== undefined
        : flags[key] !== undefined;
      if (flagWasProvided) { storySet.push(`${column}=@${key}`); params[key] = request[key]; }
    }
    for (const [key, column] of Object.entries(entryFields)) {
      if (flags[key] !== undefined) { entrySet.push(`${column}=@${key}`); params[key] = request[key]; }
    }
    if (tags !== null) { entrySet.push('tags=@tags'); params.tags = JSON.stringify(tags); }
    if (request.occurredEnd && !(request.occurredStart || story.occurred_start)) {
      throw new Error('--occurred-end requires an existing or supplied --occurred-start');
    }
    if (storySet.length) db.prepare(`UPDATE profile_stories SET ${storySet.join(', ')} WHERE id=@storyId`).run(params);
    if (entrySet.length) db.prepare(`UPDATE profile_entries SET ${entrySet.join(', ')}, updated_at=datetime('now') WHERE id=@entryId`).run(params);
    if (sensitivity !== null && sensitivity !== story.sensitivity) {
      db.prepare(`
        UPDATE profile_story_permissions
        SET decision='ask', reason='Story sensitivity changed; explicit reapproval required.',
          approved_by=NULL, approved_at=NULL, expires_at=NULL, updated_at=datetime('now')
        WHERE story_id=? AND decision='allow'
      `).run(storyId);
    }
    bumpStory(db, story, story.status);
    return storyResponse('update-metadata', getStory(db, storyId));
  });
}

function addQuestion(db, flags) {
  const storyId = requiredId(flags.storyId, '--story-id');
  const expectedVersion = requiredVersion(flags.expectedVersion);
  const kind = enumValue(flags.kind || flags.questionKind || 'clarification', QUESTION_KINDS, 'question-kind');
  const question = requiredText(flags.question, '--question');
  const priority = integer(flags.priority, 0, '--priority');
  const request = { storyId, expectedVersion, kind, question, priority, askedBy: nullable(flags.askedBy) };
  return idempotentMutation(db, 'add-question', flags, request, () => {
    const story = assertStoryVersion(db, storyId, expectedVersion);
    const questionId = db.prepare(`
      INSERT INTO profile_story_questions (story_id, question_kind, question, priority, status, asked_by)
      VALUES (?, ?, ?, ?, 'open', ?)
    `).run(storyId, kind, question, priority, request.askedBy).lastInsertRowid;
    bumpStory(db, story, story.status);
    return storyResponse('add-question', getStory(db, storyId), { questionId });
  });
}

function resolveQuestion(db, flags, _context, status) {
  const storyId = requiredId(flags.storyId, '--story-id');
  const expectedVersion = requiredVersion(flags.expectedVersion);
  const questionId = requiredId(flags.questionId, '--question-id');
  const answer = status === 'answered' ? readExact(flags.answer, flags.answerFile, '--answer or --answer-file', _context) : null;
  const source = status === 'answered' ? requiredText(flags.source || `Answer to story question ${questionId}`, '--source') : null;
  const request = { storyId, expectedVersion, questionId, status, answer, source, capturedBy: nullable(flags.capturedBy) };
  const command = status === 'answered' ? 'answer-question' : `${status}-question`;
  return idempotentMutation(db, command, flags, request, () => {
    const story = assertStoryVersion(db, storyId, expectedVersion);
    const row = db.prepare('SELECT * FROM profile_story_questions WHERE id = ? AND story_id = ?').get(questionId, storyId);
    if (!row) throw new Error(`Question ${questionId} not found for story ${storyId}`);
    if (row.status === 'answered') throw new Error(`Question ${questionId} is already answered; append a correction capture instead of changing Cole's recorded answer`);
    if (row.status === 'dismissed') throw new Error(`Question ${questionId} is dismissed and cannot be changed`);
    if (row.status === status) throw new Error(`Question ${questionId} is already ${status}`);
    const captureId = status === 'answered' ? insertCapture(db, storyId, answer, {
      kind: 'conversation', source, sourceUrl: null, attachmentPath: null,
      capturedBy: request.capturedBy, capturedAt: null, supersedesCaptureId: null
    }) : null;
    db.prepare(`
      UPDATE profile_story_questions
      SET status = ?, answer_capture_id = ?, answer_text = ?,
        answered_at = CASE WHEN ? = 'answered' THEN datetime('now') ELSE NULL END,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(status, captureId, status === 'answered' ? PROTECTED_ANSWER_PLACEHOLDER : answer, status, questionId);
    bumpStory(db, story, status === 'answered' ? 'developing' : story.status);
    return storyResponse(command, getStory(db, storyId), { questionId, ...(captureId ? { captureId } : {}) });
  });
}

function claimFacet(db, flags) {
  const storyId = requiredId(flags.storyId, '--story-id');
  const expectedVersion = requiredVersion(flags.expectedVersion);
  const facet = facetSlug(flags.facet);
  const claim = requiredText(flags.claim, '--claim');
  const beatAnchor = nullable(flags.beatAnchor);
  const weight = flags.weight === undefined ? 2 : integer(flags.weight, 2, '--weight');
  if (weight < 1 || weight > 3) throw new Error('--weight must be 1 (present), 2 (central), or 3 (defining)');
  const replace = booleanFlag(flags.replace);
  const request = { storyId, expectedVersion, facet, claim, beatAnchor, weight, replace };
  return idempotentMutation(db, 'claim-facet', flags, request, () => {
    const story = assertStoryVersion(db, storyId, expectedVersion);
    const existing = db.prepare('SELECT id FROM profile_story_facets WHERE story_id = ? AND facet = ?').get(storyId, facet);
    if (existing && !replace) {
      throw new Error(`Story ${storyId} already claims facet "${facet}"; pass --replace to restate the claim`);
    }
    const facetId = existing
      ? (db.prepare(`
          UPDATE profile_story_facets
          SET claim = ?, beat_anchor = ?, weight = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(claim, beatAnchor, weight, existing.id), existing.id)
      : db.prepare(`
          INSERT INTO profile_story_facets (story_id, facet, claim, beat_anchor, weight)
          VALUES (?, ?, ?, ?, ?)
        `).run(storyId, facet, claim, beatAnchor, weight).lastInsertRowid;
    bumpStory(db, story, story.status);
    return storyResponse('claim-facet', getStory(db, storyId), { facetId });
  });
}

function retractFacet(db, flags) {
  const storyId = requiredId(flags.storyId, '--story-id');
  const expectedVersion = requiredVersion(flags.expectedVersion);
  const facet = facetSlug(flags.facet);
  const request = { storyId, expectedVersion, facet };
  return idempotentMutation(db, 'retract-facet', flags, request, () => {
    const story = assertStoryVersion(db, storyId, expectedVersion);
    const info = db.prepare('DELETE FROM profile_story_facets WHERE story_id = ? AND facet = ?').run(storyId, facet);
    if (!info.changes) throw new Error(`Story ${storyId} does not claim facet "${facet}"`);
    bumpStory(db, story, story.status);
    return storyResponse('retract-facet', getStory(db, storyId), { facet });
  });
}

function facetSlug(value) {
  const facet = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,47}$/.test(facet)) {
    throw new Error('--facet must be a lower-kebab slug of 2-48 chars (e.g. leading-without-authority)');
  }
  return facet;
}

function linkApplication(db, flags) {
  const storyId = requiredId(flags.storyId, '--story-id');
  const expectedVersion = requiredVersion(flags.expectedVersion);
  const applicationId = requiredId(flags.applicationId, '--application-id');
  const relation = enumValue(flags.relation || 'candidate', APPLICATION_RELATIONS, 'relation');
  if (relation === 'used' || relation === 'approved') {
    throw new Error(`Relation ${relation} is reserved for permission/use workflows; link stories as candidate, prompted, or avoid.`);
  }
  const variantId = optionalId(flags.variantId, '--variant-id');
  const request = { storyId, expectedVersion, applicationId, relation, variantId, promptText: nullable(flags.promptText), notes: nullable(flags.notes) };
  return idempotentMutation(db, 'link-application', flags, request, () => {
    const story = assertStoryVersion(db, storyId, expectedVersion);
    assertApplication(db, applicationId);
    if (variantId) assertVariantBelongs(db, variantId, storyId);
    const info = db.prepare(`
      INSERT INTO profile_story_application_links
        (story_id, application_id, relation, variant_id, prompt_text, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(story_id, application_id, relation) DO UPDATE SET
        variant_id = excluded.variant_id, prompt_text = excluded.prompt_text,
        notes = excluded.notes, updated_at = datetime('now')
      RETURNING id
    `).get(storyId, applicationId, relation, variantId, request.promptText, request.notes);
    bumpStory(db, story, story.status);
    return storyResponse('link-application', getStory(db, storyId), { applicationLinkId: info.id });
  });
}

function recordUse(db, flags) {
  const storyId = requiredId(flags.storyId, '--story-id');
  const expectedVersion = requiredVersion(flags.expectedVersion);
  const applicationId = optionalId(flags.applicationId, '--application-id');
  const purpose = enumValue(flags.purpose, PURPOSES, 'purpose');
  const variantId = optionalId(flags.variantId, '--variant-id');
  const approvedBy = requiredText(flags.approvedBy, '--approved-by');
  const request = { storyId, expectedVersion, applicationId, purpose, variantId, approvedBy, targetKind: nullable(flags.targetKind), targetId: optionalId(flags.targetId, '--target-id'), promptText: nullable(flags.promptText) };
  return idempotentMutation(db, 'record-use', flags, request, () => {
    const story = assertStoryVersion(db, storyId, expectedVersion);
    if (applicationId) assertApplication(db, applicationId);
    if (!applicationId && !new Set(['general', 'networking', 'public_bio']).has(purpose)) {
      throw new Error(`--application-id is required for ${purpose} use`);
    }
    if (!applicationId && !request.targetKind) throw new Error('--target-kind is required when recording use without an application');
    if (story.status !== 'ready') throw new Error(`Story ${storyId} must be ready before external use`);
    if (permissionFor(db, story, purpose).decision !== 'allow') throw new Error(`Story ${storyId} is not allowed for ${purpose}`);
    const revision = currentRevision(db, storyId);
    if (!revision) throw new Error(`Story ${storyId} has no current canonical revision`);
    let content = revision.canonical_text;
    if (variantId) {
      const variant = assertVariantBelongs(db, variantId, storyId);
      if (!variant.is_current || variant.status !== 'approved') throw new Error(`Variant ${variantId} must be current and approved before use`);
      if (variant.purpose !== purpose) throw new Error(`Variant ${variantId} is for ${variant.purpose}, not ${purpose}`);
      if (variant.based_on_revision_id !== revision.id) throw new Error(`Variant ${variantId} is based on an older canonical revision`);
      content = variant.content;
    }
    const contentSha256 = sha256(content);
    const useId = db.prepare(`
      INSERT INTO profile_story_uses
        (story_id, application_id, revision_id, variant_id, purpose, target_kind, target_id, prompt_text, content_sha256, approved_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(storyId, applicationId, revision.id, variantId, purpose, request.targetKind, request.targetId, request.promptText, contentSha256, approvedBy).lastInsertRowid;
    if (applicationId) {
      db.prepare(`
        INSERT INTO profile_story_application_links (story_id, application_id, relation, variant_id, prompt_text, notes, updated_at)
        VALUES (?, ?, 'used', ?, ?, 'Recorded by story record-use', datetime('now'))
        ON CONFLICT(story_id, application_id, relation) DO UPDATE SET
          variant_id = excluded.variant_id, prompt_text = excluded.prompt_text,
          notes = excluded.notes, updated_at = datetime('now')
      `).run(storyId, applicationId, variantId, request.promptText);
    }
    bumpStory(db, story, story.status);
    return storyResponse('record-use', getStory(db, storyId), { useId });
  });
}

function listStories(db, flags) {
  const status = flags.status ? enumValue(flags.status, STORY_STATUSES, 'status') : null;
  const rows = db.prepare(`
    SELECT id FROM profile_stories
    WHERE (@status IS NULL OR status = @status)
    ORDER BY datetime(updated_at) DESC, id DESC
    LIMIT @limit
  `).all({ status, limit: limitValue(flags.limit, 50) });
  return {
    schemaVersion: RESPONSE_SCHEMA_VERSION,
    command: 'list',
    stories: rows.map((row) => getStory(db, row.id, { includeRaw: false }))
  };
}

function matchStories(db, flags, context) {
  const purpose = enumValue(flags.purpose, PURPOSES, 'purpose');
  const application = flags.applicationId ? assertApplication(db, requiredId(flags.applicationId, '--application-id')) : null;
  const text = [flags.text, flags.question, application && application.company, application && application.role, application && application.notes, application && application.job_url].filter(Boolean).join(' ');
  const tokens = tokenize(text);
  const stories = db.prepare(`
    SELECT ps.*, pe.title, pe.tags, pr.id AS revision_id, pr.canonical_text, pr.one_line_summary, pr.takeaway, pr.why_it_matters
    FROM profile_stories ps
    JOIN profile_entries pe ON pe.id = ps.profile_entry_id
    LEFT JOIN profile_story_revisions pr ON pr.story_id = ps.id AND pr.is_current = 1
    WHERE ps.status <> 'retired'
    ORDER BY datetime(ps.updated_at) DESC, ps.id DESC
  `).all();
  const facetsByStory = new Map();
  for (const facetRow of db.prepare('SELECT story_id, facet, claim, beat_anchor, weight FROM profile_story_facets ORDER BY weight DESC, facet').all()) {
    if (!facetsByStory.has(facetRow.story_id)) facetsByStory.set(facetRow.story_id, []);
    facetsByStory.get(facetRow.story_id).push(facetRow);
  }
  const candidates = [];
  const needsApproval = [];
  let deniedCount = 0;
  let unreadyCount = 0;

  for (const row of stories) {
    if (!row.revision_id || row.status !== 'ready') { unreadyCount += 1; continue; }
    const variants = db.prepare("SELECT * FROM profile_story_variants WHERE story_id = ? AND purpose = ? AND based_on_revision_id = ? AND is_current = 1 AND status = 'approved' ORDER BY version DESC, id DESC").all(row.id, purpose, row.revision_id);
    const facets = facetsByStory.get(row.id) || [];
    // Facet slugs and claims join the haystack so a question phrased in words
    // the canonical text never uses can still land through what the story
    // DEMONSTRATES, not just what it says.
    const haystack = [row.title, row.canonical_text, row.one_line_summary, row.takeaway, row.why_it_matters, row.tags, ...facets.map((facet) => `${facet.facet.replace(/[-_]/g, ' ')} ${facet.claim}`), ...variants.map((variant) => `${variant.audience || ''} ${variant.content}`)].filter(Boolean).join(' ').toLowerCase();
    const reasons = tokens.filter((token) => haystack.includes(token));
    // An explicit facet hit outranks incidental prose overlap: weight says how
    // central the facet is to the story (1 present, 2 central, 3 defining).
    const facetHits = facets.filter((facet) => facet.facet.split(/[-_]/).some((word) => word.length >= 3 && tokens.includes(word)));
    let score = reasons.length + (variants.length ? 2 : 0) + (row.status === 'ready' ? 1 : 0);
    for (const hit of facetHits) {
      score += hit.weight + 1;
      reasons.push(`facet:${hit.facet}`);
    }
    if (tokens.length && reasons.length === 0) continue;
    const permission = permissionFor(db, row, purpose, context.now);
    if (permission.decision === 'deny') { deniedCount += 1; continue; }
    if (permission.decision === 'ask') {
      needsApproval.push({
        score,
        reasons,
        story: {
          id: row.id,
          profile_entry_id: row.profile_entry_id,
          status: row.status,
          sensitivity: row.sensitivity,
          lock_version: row.lock_version,
          // Slugs only: the claims stay gated until the ask is approved.
          facets: facets.map((facet) => facet.facet)
        },
        permission
      });
      continue;
    }
    candidates.push({
      score,
      reasons,
      story: {
        id: row.id,
        profile_entry_id: row.profile_entry_id,
        title: row.title,
        status: row.status,
        sensitivity: row.sensitivity,
        lock_version: row.lock_version,
        canonical: {
          revision_id: row.revision_id,
          text: row.canonical_text,
          summary: row.one_line_summary,
          takeaway: row.takeaway,
          why_it_matters: row.why_it_matters
        },
        facets: facets.map(({ facet, claim, weight, beat_anchor }) => ({ facet, claim, weight, beat_anchor }))
      },
      variant: variants[0] ? serializeVariant(variants[0]) : null,
      permission
    });
  }
  const compare = (left, right) => right.score - left.score || right.story.id - left.story.id;
  candidates.sort(compare);
  needsApproval.sort(compare);
  const limit = limitValue(flags.limit, 10);
  return {
    schemaVersion: RESPONSE_SCHEMA_VERSION,
    command: 'match',
    context: { applicationId: application ? application.id : null, purpose, text: flags.text || null, question: flags.question || null },
    candidates: candidates.slice(0, limit),
    needsApproval: needsApproval.slice(0, limit),
    deniedCount,
    unreadyCount
  };
}

// ---------------------------------------------------------------------------
// The story-mapping GATE (docs: applysim/docs/FLOWS.md, "the story-mapping
// gate"). Given an application's behavioral questions — each with the story
// facets it is really asking about — decide per question whether a ready,
// permitted story honestly maps. The verdict is the submission gate: any
// REQUIRED question without a mapped story means the application must NOT be
// submitted; the blocked question escalates to Cole, who authors the FULL
// story (never the narrowed projection), and the gate re-runs under a new run
// key. A deliberate veto here is the gate working, not failing.
//
// The gate never writes an answer and never widens a permission: mapped
// results hand the agent a canonical story (and its closest approved variant)
// to ADAPT — compression and register only, never invented facts.
// ---------------------------------------------------------------------------

function runGate(db, flags, context) {
  const raw = readExact(flags.questions, flags.questionsFile, '--questions or --questions-file', context);
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Gate questions must be valid JSON: ${error.message}`);
  }
  const parsed = validateGateQuestions(document);
  const purpose = enumValue(flags.purpose || parsed.purpose || 'application_form', PURPOSES, 'purpose');
  const applicationId = optionalId(flags.applicationId, '--application-id') ?? parsed.applicationId;
  const runKey = requiredText(flags.runKey, '--run-key');
  const request = { purpose, applicationId, runKey, questions: parsed.questions };

  return idempotentMutation(db, 'gate', { idempotencyKey: runKey }, request, () => {
    if (applicationId !== null) assertApplication(db, applicationId);
    const insertCheck = db.prepare(`
      INSERT INTO profile_story_gate_checks
        (application_id, purpose, question_key, prompt_text, prompt_digest, facets_json,
         required, decision, story_id, match_score, reasons_json, run_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let unreadyStories = 0;
    let deniedStories = 0;
    const questions = parsed.questions.map((question) => {
      // The facet slugs join the match text as words, so retrieval leans on
      // what stories CLAIM, not only on the question's phrasing.
      const matchText = [question.prompt, ...question.facets.map((facet) => facet.replace(/[-_]/g, ' '))].join(' ');
      const matched = matchStories(db, {
        purpose,
        question: matchText,
        ...(applicationId === null ? {} : { applicationId })
      }, context);
      unreadyStories = Math.max(unreadyStories, matched.unreadyCount);
      deniedStories = Math.max(deniedStories, matched.deniedCount);
      const outcome = decideGateQuestion(question, matched, purpose);
      insertCheck.run(
        applicationId, purpose, question.key, question.prompt, sha256(question.prompt),
        JSON.stringify(question.facets), question.required ? 1 : 0,
        outcome.decision, outcome.storyId, outcome.score, JSON.stringify(outcome.reasons), runKey
      );
      return { key: question.key, prompt: question.prompt, required: question.required, facets: question.facets, ...outcome.payload };
    });

    const required = questions.filter((question) => question.required);
    const verdict = {
      // submitEligible means only that THIS gate does not block; every other
      // submission gate still applies.
      submitEligible: required.every((question) => question.decision === 'mapped'),
      requiredTotal: required.length,
      requiredMapped: required.filter((question) => question.decision === 'mapped').length,
      requiredNeedsApproval: required.filter((question) => question.decision === 'needs_approval').length,
      requiredBlocked: required.filter((question) => question.decision === 'blocked').length,
      // An optional question with no story does not veto: the honest move is
      // to leave it blank, and the gate says so rather than inventing.
      optionalBlocked: questions.filter((question) => !question.required && question.decision === 'blocked').length,
      unreadyStories,
      deniedStories
    };
    return { schemaVersion: RESPONSE_SCHEMA_VERSION, command: 'gate', runKey, applicationId, purpose, verdict, questions };
  });
}

function validateGateQuestions(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Gate questions must be a JSON object');
  }
  if (document.schemaVersion !== GATE_QUESTIONS_SCHEMA_VERSION) {
    throw new Error(`Gate questions schemaVersion must be ${GATE_QUESTIONS_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(document.questions) || document.questions.length === 0) {
    throw new Error('Gate questions need a non-empty questions list');
  }
  const seen = new Set();
  const questions = document.questions.map((raw, index) => {
    const at = `questions[${index}]`;
    const key = String(raw?.key ?? '').trim();
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key)) throw new Error(`${at}: key must be a lower_snake/kebab slug`);
    if (seen.has(key)) throw new Error(`${at}: duplicate key "${key}"`);
    seen.add(key);
    const prompt = String(raw?.prompt ?? '').trim();
    if (!prompt) throw new Error(`${at}: prompt is required`);
    const facets = raw?.facets ?? [];
    if (!Array.isArray(facets) || !facets.every((facet) => typeof facet === 'string' && /^[a-z][a-z0-9_-]{1,47}$/.test(facet))) {
      throw new Error(`${at}: facets must be lower-kebab slugs`);
    }
    return { key, prompt, required: raw?.required === true, facets: [...new Set(facets)] };
  });
  const applicationId = document.applicationId === undefined || document.applicationId === null
    ? null
    : Number(document.applicationId);
  if (applicationId !== null && (!Number.isSafeInteger(applicationId) || applicationId < 1)) {
    throw new Error('Gate questions applicationId must be a positive integer when present');
  }
  return { questions, applicationId, purpose: document.purpose };
}

/**
 * A candidate QUALIFIES for a question only through facets: when the question
 * names facets, a candidate must CLAIM at least one of them; when it names
 * none, a candidate must at least have landed an explicit facet hit on the
 * prompt. Prose overlap alone never maps a story — under-matching escalates
 * to Cole, which is the safe failure mode; over-matching submits a stretched
 * answer, which is the failure the gate exists to prevent.
 */
function qualifyGateCandidates(entries, questionFacets, slugsOnly) {
  return entries
    .map((entry) => {
      const slugs = slugsOnly
        ? (entry.story.facets || [])
        : (entry.story.facets || []).map((facet) => facet.facet);
      const overlap = questionFacets.filter((facet) => slugs.includes(facet));
      const facetReasonHits = entry.reasons.filter((reason) => String(reason).startsWith('facet:'));
      const qualifies = questionFacets.length > 0 ? overlap.length > 0 : facetReasonHits.length > 0;
      return { candidate: entry, overlap, qualifies };
    })
    .filter((entry) => entry.qualifies)
    .sort((left, right) => right.overlap.length - left.overlap.length || right.candidate.score - left.candidate.score);
}

function decideGateQuestion(question, matched, purpose) {
  const allowed = qualifyGateCandidates(matched.candidates, question.facets, false);
  if (allowed.length > 0) {
    const best = allowed[0];
    const story = best.candidate.story;
    const matchedClaims = (story.facets || []).filter((facet) => best.overlap.includes(facet.facet));
    return {
      decision: 'mapped',
      storyId: story.id,
      score: best.candidate.score,
      reasons: best.candidate.reasons,
      payload: {
        decision: 'mapped',
        story: {
          id: story.id,
          title: story.title,
          lock_version: story.lock_version,
          sensitivity: story.sensitivity,
          matchedFacets: best.overlap,
          matchedClaims,
          canonical: story.canonical,
          score: best.candidate.score,
          reasons: best.candidate.reasons
        },
        // Adapt-only: select and condense from the canonical (or the closest
        // approved variant); never add facts to Cole's life.
        variant: best.candidate.variant,
        alternates: allowed.slice(1, 3).map((entry) => ({
          storyId: entry.candidate.story.id,
          title: entry.candidate.story.title,
          matchedFacets: entry.overlap,
          score: entry.candidate.score
        }))
      }
    };
  }

  const askGated = qualifyGateCandidates(matched.needsApproval, question.facets, true);
  if (askGated.length > 0) {
    const best = askGated[0];
    const story = best.candidate.story;
    return {
      decision: 'needs_approval',
      storyId: story.id,
      score: best.candidate.score,
      reasons: best.candidate.reasons,
      payload: {
        decision: 'needs_approval',
        story: { id: story.id, sensitivity: story.sensitivity, facets: story.facets, lock_version: story.lock_version },
        escalation: {
          kind: 'grant_permission',
          note: `A story matching this question exists, but its use for ${purpose} awaits Cole's decision. Do not answer until it is granted.`,
          command: `jobtrack story permission set --story-id ${story.id} --expected-version ${story.lock_version} --purpose ${purpose} --decision allow --approved-by Cole --idempotency-key permission-<stable-key> --json`
        }
      }
    };
  }

  return {
    decision: 'blocked',
    storyId: null,
    score: null,
    reasons: [],
    payload: {
      decision: 'blocked',
      escalation: {
        kind: 'author_story',
        facetsSought: question.facets,
        note: 'No ready story claims what this question asks for. Do NOT answer from thin air: capture the FULL story with Cole, polish it on its own terms, claim its facets, then re-run the gate under a new run key.',
        commands: [
          'jobtrack story capture --title "…" --raw-file story.txt --source "Cole conversation <date>" --idempotency-key story-<stable-key> --json',
          'jobtrack story polish --story-id N --expected-version V --canonical-file polished.md --takeaway "…" --idempotency-key polish-<stable-key> --json',
          `jobtrack story facet claim --story-id N --expected-version V --facet ${question.facets[0] ?? '<facet>'} --claim "…" --idempotency-key facet-<stable-key> --json`,
          `jobtrack story permission set --story-id N --expected-version V --purpose ${purpose} --decision allow --approved-by Cole --idempotency-key permission-<stable-key> --json`
        ]
      }
    }
  };
}

function getStory(db, storyId, options = {}) {
  const story = db.prepare(`
    SELECT ps.*, pe.title, pe.source, pe.source_url,
           pe.evidence, pe.attachment_path, pe.recency, pe.confidence, pe.tags
    FROM profile_stories ps JOIN profile_entries pe ON pe.id = ps.profile_entry_id
    WHERE ps.id = ?
  `).get(storyId);
  if (!story) throw new Error(`Story ${storyId} not found`);
  const revision = currentRevision(db, storyId);
  const captures = options.includeRaw
    ? db.prepare('SELECT * FROM profile_story_captures WHERE story_id = ? ORDER BY id').all(storyId)
    : db.prepare('SELECT id, story_id, capture_kind, source_label, source_url, attachment_path, captured_by, captured_at, sha256, supersedes_capture_id, created_at FROM profile_story_captures WHERE story_id = ? ORDER BY id').all(storyId);
  const questions = db.prepare('SELECT * FROM profile_story_questions WHERE story_id = ? ORDER BY status, priority DESC, id').all(storyId)
    .map((question) => {
      const { answer_text: _protectedAnswer, ...safe } = question;
      const answer = options.includeRaw && question.answer_capture_id
        ? db.prepare('SELECT raw_text FROM profile_story_captures WHERE id = ? AND story_id = ?').get(question.answer_capture_id, storyId)
        : null;
      return { ...safe, has_answer: question.status === 'answered', ...(answer ? { answer_text: answer.raw_text } : {}) };
    });
  return {
    ...story,
    tags: parseTags(story.tags),
    currentRevision: revision ? serializeRevision(revision) : null,
    captures,
    facets: db.prepare('SELECT * FROM profile_story_facets WHERE story_id = ? ORDER BY weight DESC, facet').all(storyId),
    variants: db.prepare('SELECT * FROM profile_story_variants WHERE story_id = ? ORDER BY variant_key, version DESC').all(storyId).map(serializeVariant),
    permissions: db.prepare('SELECT * FROM profile_story_permissions WHERE story_id = ? ORDER BY purpose').all(storyId),
    questions,
    applicationLinks: db.prepare('SELECT * FROM profile_story_application_links WHERE story_id = ? ORDER BY id').all(storyId),
    uses: db.prepare('SELECT * FROM profile_story_uses WHERE story_id = ? ORDER BY id').all(storyId)
  };
}

function idempotentMutation(db, command, flags, request, action) {
  const key = requiredText(flags.idempotencyKey, '--idempotency-key');
  const requestSha = sha256(stableJson(request));
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM profile_story_operations WHERE idempotency_key = ?').get(key);
    if (existing) {
      if (existing.command !== command || existing.request_sha256 !== requestSha) throw new Error(`Idempotency key ${key} was already used for a different request`);
      return JSON.parse(existing.result_json);
    }
    const result = action();
    db.prepare('INSERT INTO profile_story_operations (idempotency_key, command, request_sha256, result_json) VALUES (?, ?, ?, ?)').run(key, command, requestSha, JSON.stringify(result));
    return result;
  }).immediate();
}

function insertCapture(db, storyId, raw, metadata) {
  return db.prepare(`
    INSERT INTO profile_story_captures
      (story_id, capture_kind, raw_text, source_label, source_url, attachment_path, captured_by, captured_at, sha256, supersedes_capture_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?)
  `).run(storyId, metadata.kind, raw, metadata.source, metadata.sourceUrl, metadata.attachmentPath, metadata.capturedBy, metadata.capturedAt, sha256(raw), metadata.supersedesCaptureId).lastInsertRowid;
}

function bumpStory(db, story, status) {
  const info = db.prepare(`
    UPDATE profile_stories SET status = ?, lock_version = lock_version + 1, updated_at = datetime('now')
    WHERE id = ? AND lock_version = ?
  `).run(status, story.id, story.lock_version);
  if (!info.changes) throw new Error(`Story ${story.id} changed concurrently`);
}

function assertStoryVersion(db, storyId, expectedVersion) {
  const story = db.prepare('SELECT * FROM profile_stories WHERE id = ?').get(storyId);
  if (!story) throw new Error(`Story ${storyId} not found`);
  if (story.lock_version !== expectedVersion) throw new Error(`Story ${storyId} version conflict: expected ${expectedVersion}, current ${story.lock_version}`);
  return story;
}

function assertCaptureBelongs(db, captureId, storyId) {
  const row = db.prepare('SELECT * FROM profile_story_captures WHERE id = ? AND story_id = ?').get(captureId, storyId);
  if (!row) throw new Error(`Capture ${captureId} not found for story ${storyId}`);
  return row;
}

function assertVariantBelongs(db, variantId, storyId) {
  const row = db.prepare('SELECT * FROM profile_story_variants WHERE id = ? AND story_id = ?').get(variantId, storyId);
  if (!row) throw new Error(`Variant ${variantId} not found for story ${storyId}`);
  return row;
}

function assertApplication(db, applicationId) {
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
  if (!row) throw new Error(`Application ${applicationId} not found`);
  return row;
}

function currentRevision(db, storyId) {
  return db.prepare('SELECT * FROM profile_story_revisions WHERE story_id = ? AND is_current = 1').get(storyId) || null;
}

function getProfileTitle(db, storyId) {
  const row = db.prepare('SELECT pe.title FROM profile_stories ps JOIN profile_entries pe ON pe.id = ps.profile_entry_id WHERE ps.id = ?').get(storyId);
  if (!row) throw new Error(`Story ${storyId} not found`);
  return row.title;
}

function permissionFor(db, story, purpose, nowOverride) {
  const row = db.prepare('SELECT * FROM profile_story_permissions WHERE story_id = ? AND purpose = ?').get(story.id, purpose);
  const now = nowOverride ? new Date(nowOverride) : new Date();
  if (row && row.expires_at && new Date(row.expires_at) <= now) {
    return { purpose, decision: 'ask', source: 'expired_override', permissionId: row.id, expiresAt: row.expires_at };
  }
  if (row) return { purpose, decision: row.decision, source: 'explicit', permissionId: row.id, expiresAt: row.expires_at };
  return { purpose, decision: story.default_use_decision, source: 'default', permissionId: null, expiresAt: null };
}

function serializeRevision(row) {
  return { ...row, is_current: Boolean(row.is_current), beats: parseJsonArray(row.beats_json) };
}

function serializeVariant(row) {
  return { ...row, is_current: Boolean(row.is_current) };
}

function storyResponse(command, story, extra = {}) {
  return { schemaVersion: RESPONSE_SCHEMA_VERSION, command, story, ...extra };
}

function normalizeCommand(args) {
  const first = args && args[0];
  if (first === 'variant') return `${args[1] || ''}-variant`;
  if (first === 'permission' && args[1] === 'set') return 'set-permission';
  if (first === 'update' || first === 'edit' || first === 'metadata') return 'update-metadata';
  if (first === 'question') return `${args[1] || ''}-question`;
  if (first === 'facet') return `${args[1] || ''}-facet`;
  return first;
}

function normalizeBeats(flags, context) {
  if (flags.beatsJson !== undefined || flags.beatsFile !== undefined) {
    const raw = flags.beatsFile ? readFile(flags.beatsFile, context) : flags.beatsJson;
    let parsed;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (error) { throw new Error(`--beats-json must be valid JSON: ${error.message}`); }
    if (!Array.isArray(parsed)) throw new Error('--beats-json must be an array');
    return parsed.map((beat, index) => {
      if (!beat || typeof beat !== 'object' || Array.isArray(beat)) throw new Error(`Beat ${index} must be an object`);
      return { kind: requiredText(beat.kind, `beat ${index} kind`), content: requiredExact(beat.content, `beat ${index} content`) };
    });
  }
  return [['situation', flags.situation], ['task', flags.task], ['action', flags.action], ['result', flags.result], ['reflection', flags.reflection]]
    .filter(([, content]) => content !== undefined && content !== null && String(content).trim() !== '')
    .map(([kind, content]) => ({ kind, content: String(content) }));
}

function readExact(value, file, label, context) {
  if (value !== undefined && file !== undefined) throw new Error(`Provide only one of ${label}`);
  const content = file !== undefined ? readFile(file, context) : value;
  return requiredExact(content, label);
}

function readFile(file, context) {
  if (context.readFile) return context.readFile(file);
  return fs.readFileSync(path.resolve(String(file)), 'utf8');
}

function requiredExact(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') throw new Error(`${label} is required`);
  return String(value);
}

function requiredText(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') throw new Error(`${label} is required`);
  return String(value).trim();
}

function nullable(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

function requiredId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`${label} must be a positive integer`);
  return id;
}

function optionalId(value, label) {
  return value === undefined || value === null || value === '' ? null : requiredId(value, label);
}

function requiredVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('--expected-version must be a non-negative integer');
  return version;
}

function integer(value, fallback, label) {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} must be an integer`);
  return result;
}

function optionalPositiveInt(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}

function validateOptionalDate(value, label) {
  if (value === undefined || value === null || value === '') return;
  if (Number.isNaN(Date.parse(String(value)))) throw new Error(`${label} must be a valid date or date-time`);
}

function validateDateRange(start, end, startLabel, endLabel) {
  if (end && !start) throw new Error(`${endLabel} requires ${startLabel}`);
  if (start && end && Date.parse(String(end)) < Date.parse(String(start))) {
    throw new Error(`${endLabel} must not be earlier than ${startLabel}`);
  }
}

function limitValue(value, fallback) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > 100) throw new Error('--limit must be an integer from 1 to 100');
  return result;
}

function enumValue(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`${label} must be one of: ${[...allowed].join(', ')}`);
  return value;
}

function normalizeIds(value) {
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(values.map((item) => requiredId(String(item).trim(), 'capture id')))];
}

function normalizeTags(value) {
  if (value === undefined || value === null || value === '') return [];
  const tags = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].sort();
}

function parseTags(value) {
  if (!value) return [];
  try { const result = JSON.parse(value); return Array.isArray(result) ? result : []; } catch { return []; }
}

function parseJsonArray(value) {
  try { const result = JSON.parse(value); return Array.isArray(result) ? result : []; } catch { return []; }
}

function tokenize(value) {
  return [...new Set(String(value || '').toLowerCase().split(/[^a-z0-9+#.]+/).filter((token) => token.length >= 3))];
}

function wordCount(value) {
  const words = String(value).trim().match(/\S+/g);
  return words ? words.length : 0;
}

function booleanFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'yes';
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

module.exports = {
  GATE_QUESTIONS_SCHEMA_VERSION,
  RESPONSE_SCHEMA_VERSION,
  STORY_FACETS_SCHEMA_VERSION,
  STORY_GATE_SCHEMA_VERSION,
  STORY_HARDENING_SCHEMA_VERSION,
  STORY_SCHEMA_VERSION,
  getStory,
  migrateStories,
  runStoryCommand
};
