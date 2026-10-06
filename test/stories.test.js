'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  RESPONSE_SCHEMA_VERSION,
  STORY_FACETS_SCHEMA_VERSION,
  STORY_GATE_SCHEMA_VERSION,
  STORY_HARDENING_SCHEMA_VERSION,
  STORY_SCHEMA_VERSION,
  getStory,
  migrateStories,
  runStoryCommand
} = require('../lib/stories');

function createDb(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      notes TEXT,
      job_url TEXT
    );
    CREATE TABLE profile_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT,
      source_url TEXT,
      evidence TEXT,
      attachment_path TEXT,
      recency TEXT,
      confidence TEXT NOT NULL DEFAULT 'unverified',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE profile_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_entry_id INTEGER NOT NULL UNIQUE REFERENCES profile_entries(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      answer_category TEXT
    );
  `);
  t.after(() => db.close());
  return db;
}

function run(db, command, flags = {}, context = {}) {
  return runStoryCommand(db, [command], flags, context);
}

function capture(db, key, overrides = {}) {
  return run(db, 'capture', {
    title: overrides.title || `Story ${key}`,
    raw: overrides.raw || `Raw narration for ${key}`,
    source: overrides.source || 'Cole conversation',
    confidence: overrides.confidence || 'high',
    idempotencyKey: key,
    ...overrides
  });
}

function polish(db, story, key, overrides = {}) {
  return run(db, 'polish', {
    storyId: story.id,
    expectedVersion: story.lock_version,
    canonical: overrides.canonical || `Canonical story for ${key}`,
    summary: overrides.summary || `Summary for ${key}`,
    takeaway: overrides.takeaway || `Takeaway for ${key}`,
    idempotencyKey: `${key}-polish`,
    ...overrides
  });
}

test('migration is idempotent, preserves legacy story bytes, and excludes reusable answers', (t) => {
  const db = createDb(t);
  const raw = '  Exact legacy narration.\nSecond line.  ';
  const legacyId = db.prepare(`
    INSERT INTO profile_entries (category, title, content, source, confidence, tags)
    VALUES ('story', 'Legacy story', ?, 'Cole', 'high', '["leadership"]')
  `).run(raw).lastInsertRowid;
  const answerId = db.prepare(`
    INSERT INTO profile_entries (category, title, content, source, confidence)
    VALUES ('story', 'Application answer', 'Not an anecdote', 'Cole', 'high')
  `).run().lastInsertRowid;
  db.prepare("INSERT INTO profile_answers (profile_entry_id, question, answer) VALUES (?, 'Why us?', 'Because')").run(answerId);

  migrateStories(db);
  migrateStories(db);

  assert.equal(db.prepare('SELECT count(*) AS n FROM jobtrack_schema_migrations WHERE version = ?').get(STORY_SCHEMA_VERSION).n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM profile_stories').get().n, 1);
  const story = db.prepare('SELECT * FROM profile_stories WHERE profile_entry_id = ?').get(legacyId);
  assert.equal(story.status, 'needs_review');
  assert.equal(story.default_use_decision, 'ask');
  assert.equal(story.lock_version, 1);
  assert.equal(db.prepare('SELECT raw_text FROM profile_story_captures WHERE story_id = ?').get(story.id).raw_text, raw);
  assert.equal(db.prepare('SELECT canonical_text FROM profile_story_revisions WHERE story_id = ?').get(story.id).canonical_text, raw);
  assert.equal(db.prepare('SELECT content FROM profile_entries WHERE id = ?').get(legacyId).content, raw);
  assert.equal(db.prepare('SELECT count(*) AS n FROM profile_stories WHERE profile_entry_id = ?').get(answerId).n, 0);
});

test('migration composes with the existing registry and an outer transaction', (t) => {
  const db = createDb(t);
  db.exec(`
    CREATE TABLE jobtrack_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO jobtrack_schema_migrations (version, name)
    VALUES (1, 'baseline_transactional_registry');
  `);
  db.transaction(() => migrateStories(db))();
  assert.deepEqual(
    db.prepare('SELECT version, name FROM jobtrack_schema_migrations ORDER BY version').all(),
    [
      { version: 1, name: 'baseline_transactional_registry' },
      { version: STORY_SCHEMA_VERSION, name: 'first_class_story_library' },
      { version: STORY_HARDENING_SCHEMA_VERSION, name: 'story_revision_bound_use_audit' },
      { version: STORY_FACETS_SCHEMA_VERSION, name: 'story_facet_claims' },
      { version: STORY_GATE_SCHEMA_VERSION, name: 'story_gate_checks' }
    ]
  );
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'profile_stories'").get());
});

test('1704 upgrade preserves old use audits, protects legacy answers, and enables app-less use', (t) => {
  const db = createDb(t);
  let result = capture(db, 'upgrade-1704', { raw: 'Exact source story.' });
  result = polish(db, result.story, 'upgrade-1704', { canonical: 'Canonical version one.' });
  const applicationId = Number(db.prepare("INSERT INTO applications (company, role) VALUES ('Acme', 'Engineer')").run().lastInsertRowid);
  result = run(db, 'set-permission', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    purpose: 'interview', decision: 'allow', approvedBy: 'Cole', idempotencyKey: 'upgrade-permission'
  });
  result = run(db, 'record-use', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    applicationId, purpose: 'interview', approvedBy: 'Cole', idempotencyKey: 'upgrade-use'
  });
  const useId = result.useId;
  result = run(db, 'add-question', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    question: 'What changed?', idempotencyKey: 'upgrade-question'
  });
  const questionId = result.questionId;
  const answerFlags = {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    questionId, answer: 'Legacy exact answer.', source: 'Cole conversation',
    idempotencyKey: 'upgrade-answer'
  };
  result = run(db, 'answer-question', answerFlags);

  // Recreate the exact earlier shape and leakage so the durable migration—not
  // fresh-schema behavior—is under test.
  db.transaction(() => {
    db.prepare("UPDATE profile_story_questions SET answer_capture_id=NULL, answer_text='Legacy exact answer.' WHERE id=?").run(questionId);
    const operation = db.prepare("SELECT result_json FROM profile_story_operations WHERE idempotency_key='upgrade-answer'").get();
    const storedResult = JSON.parse(operation.result_json);
    storedResult.story.questions.find((question) => question.id === questionId).answer_text = 'Legacy exact answer.';
    db.prepare("UPDATE profile_story_operations SET result_json=? WHERE idempotency_key='upgrade-answer'").run(JSON.stringify(storedResult));
    db.exec(`
      DROP TRIGGER IF EXISTS trg_story_use_immutable_update;
      DROP TRIGGER IF EXISTS trg_story_use_immutable_delete;
      DROP TRIGGER IF EXISTS trg_story_use_variant_same_story;
      DROP TRIGGER IF EXISTS trg_story_use_revision_same_story;
      DROP TRIGGER IF EXISTS trg_story_use_revision_required;
      DROP INDEX IF EXISTS idx_story_use_application;
      ALTER TABLE profile_story_uses RENAME TO profile_story_uses_new_shape;
      CREATE TABLE profile_story_uses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        story_id INTEGER NOT NULL REFERENCES profile_stories(id) ON DELETE RESTRICT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
        variant_id INTEGER REFERENCES profile_story_variants(id) ON DELETE RESTRICT,
        purpose TEXT NOT NULL,
        target_kind TEXT,
        target_id INTEGER,
        prompt_text TEXT,
        approved_by TEXT NOT NULL,
        used_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO profile_story_uses
        (id, story_id, application_id, variant_id, purpose, target_kind, target_id, prompt_text, approved_by, used_at, created_at)
      SELECT id, story_id, application_id, variant_id, purpose, target_kind, target_id, prompt_text, approved_by, used_at, created_at
      FROM profile_story_uses_new_shape;
      DROP TABLE profile_story_uses_new_shape;
      DELETE FROM jobtrack_schema_migrations WHERE version=2026071704;
    `);
  }).immediate();

  migrateStories(db);
  const upgradedUse = db.prepare('SELECT * FROM profile_story_uses WHERE id=?').get(useId);
  assert.equal(upgradedUse.application_id, applicationId);
  assert.equal(upgradedUse.revision_id, result.story.currentRevision.id);
  assert.match(upgradedUse.content_sha256, /^[a-f0-9]{64}$/);
  assert.equal(db.prepare("PRAGMA table_info(profile_story_uses)").all().find((column) => column.name === 'application_id').notnull, 0);
  const protectedQuestion = run(db, 'show', { storyId: result.story.id }).story.questions.find((question) => question.id === questionId);
  assert.equal(protectedQuestion.answer_text, undefined);
  assert.equal(run(db, 'show', { storyId: result.story.id, includeRaw: true }).story.questions.find((question) => question.id === questionId).answer_text, 'Legacy exact answer.');
  assert.equal(run(db, 'answer-question', answerFlags).story.questions.find((question) => question.id === questionId).answer_text, undefined);

  result = polish(db, run(db, 'show', { storyId: result.story.id }).story, 'upgrade-repolish', { canonical: 'Canonical version two.' });
  result = run(db, 'set-permission', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    purpose: 'networking', decision: 'allow', approvedBy: 'Cole', idempotencyKey: 'upgrade-networking-permission'
  });
  result = run(db, 'record-use', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    purpose: 'networking', targetKind: 'conversation', approvedBy: 'Cole', idempotencyKey: 'upgrade-networking-use'
  });
  assert.equal(result.story.uses.at(-1).application_id, null);
  assert.match(result.story.uses.at(-1).content_sha256, /^[a-f0-9]{64}$/);
});

test('capture preserves raw bytes, redacts raw by default, and provides replay-safe idempotency', (t) => {
  const db = createDb(t);
  const raw = '\n  I paused, then rebuilt it.\nNothing here is trimmed.  \n';
  const flags = {
    title: 'Rebuilt after failure', raw, source: 'Cole conversation 2026-07-17',
    confidence: 'high', tags: 'resilience, Leadership,resilience', idempotencyKey: 'capture-1'
  };
  const first = run(db, 'capture', flags);
  const replay = run(db, 'capture', flags);

  assert.deepEqual(replay, first);
  assert.equal(first.schemaVersion, RESPONSE_SCHEMA_VERSION);
  assert.equal(first.story.lock_version, 0);
  assert.deepEqual(first.story.tags, ['leadership', 'resilience']);
  assert.equal(first.story.captures[0].raw_text, undefined);
  assert.equal(db.prepare('SELECT raw_text FROM profile_story_captures WHERE id = ?').get(first.captureId).raw_text, raw);
  assert.equal(db.prepare('SELECT content FROM profile_entries WHERE id = ?').get(first.story.profile_entry_id).content, '[Captured story awaiting canonical revision]');
  assert.throws(
    () => run(db, 'capture', { ...flags, raw: 'different' }),
    /already used for a different request/
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM profile_stories').get().n, 1);

  const shown = run(db, 'show', { storyId: first.story.id, includeRaw: true });
  assert.equal(shown.story.captures[0].raw_text, raw);
});

test('capture idempotency binds evidence, recency, and capture time while dates fail closed', (t) => {
  const db = createDb(t);
  const base = {
    title: 'Bound request', raw: 'Exact story bytes.', source: 'Cole conversation', confidence: 'high',
    evidence: 'Calendar note', recency: 'recent', capturedAt: '2026-07-17T12:00:00Z',
    occurredStart: '2025-01-01', occurredEnd: '2025-02-01', idempotencyKey: 'bound-capture'
  };
  run(db, 'capture', base);
  assert.throws(() => run(db, 'capture', { ...base, evidence: 'Different evidence' }), /different request/);
  assert.throws(() => run(db, 'capture', { ...base, recency: 'older' }), /different request/);
  assert.throws(() => run(db, 'capture', { ...base, capturedAt: '2026-07-17T12:01:00Z' }), /different request/);

  assert.throws(() => capture(db, 'bad-capture-time', { capturedAt: 'not-a-date' }), /valid date/);
  assert.throws(() => capture(db, 'bad-occurred-start', { occurredStart: 'not-a-date' }), /valid date/);
  assert.throws(() => capture(db, 'reversed-story-dates', {
    occurredStart: '2025-03-01', occurredEnd: '2025-02-01'
  }), /must not be earlier/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM profile_stories').get().n, 1);
});

test('append and polish use optimistic locking while canonical revisions remain historical', (t) => {
  const db = createDb(t);
  const created = capture(db, 'locking', { raw: 'Original raw text.' });
  const appendedRaw = 'Correction with exact trailing space. ';
  const appended = run(db, 'append-capture', {
    storyId: created.story.id,
    expectedVersion: 0,
    raw: appendedRaw,
    source: 'Cole correction',
    captureKind: 'correction',
    supersedesCaptureId: created.captureId,
    idempotencyKey: 'locking-append'
  });
  assert.equal(appended.story.lock_version, 1);
  assert.equal(db.prepare('SELECT raw_text FROM profile_story_captures WHERE id = ?').get(appended.captureId).raw_text, appendedRaw);
  assert.throws(() => run(db, 'append-capture', {
    storyId: created.story.id, expectedVersion: 0, raw: 'stale', source: 'Cole', idempotencyKey: 'stale-append'
  }), /version conflict/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM profile_story_operations WHERE idempotency_key = 'stale-append'").get().n, 0);

  const polished = polish(db, appended.story, 'locking', {
    canonical: 'I encountered a failure, rebuilt the system, and learned to make recovery observable.',
    structure: 'star',
    situation: 'The system failed.',
    action: 'I rebuilt it with observable recovery.',
    reflection: 'Recovery design matters as much as the happy path.'
  });
  assert.equal(polished.story.lock_version, 2);
  assert.equal(polished.story.currentRevision.revision_number, 1);
  assert.deepEqual(polished.story.currentRevision.beats.map((beat) => beat.kind), ['situation', 'action', 'reflection']);

  const second = polish(db, polished.story, 'locking-v2', {
    canonical: 'When a system failed, I rebuilt it around observable recovery and clearer operator control.',
    changeNote: 'Tightened the point.'
  });
  assert.equal(second.story.currentRevision.revision_number, 2);
  const revisions = db.prepare('SELECT revision_number, canonical_text, is_current FROM profile_story_revisions WHERE story_id = ? ORDER BY revision_number').all(created.story.id);
  assert.equal(revisions.length, 2);
  assert.match(revisions[0].canonical_text, /learned to make recovery observable/);
  assert.equal(revisions[0].is_current, 0);
  assert.equal(revisions[1].is_current, 1);
  assert.equal(db.prepare('SELECT raw_text FROM profile_story_captures WHERE id = ?').get(created.captureId).raw_text, 'Original raw text.');
  assert.throws(() => db.prepare("UPDATE profile_story_captures SET raw_text = 'changed' WHERE id = ?").run(created.captureId), /append-only/);
  assert.throws(() => db.prepare("UPDATE profile_story_revisions SET canonical_text = 'changed' WHERE story_id = ? AND revision_number = 1").run(created.story.id), /immutable/);
});

test('variants are versioned, approval is explicit, and old content remains immutable', (t) => {
  const db = createDb(t);
  let result = capture(db, 'variants');
  result = polish(db, result.story, 'variants');
  const added = run(db, 'add-variant', {
    storyId: result.story.id,
    expectedVersion: result.story.lock_version,
    key: 'interview-60s', purpose: 'interview', medium: 'spoken', length: '60_seconds',
    audience: 'engineering manager', content: 'First concise spoken version.',
    idempotencyKey: 'variant-add'
  });
  const firstId = added.variantId;
  assert.equal(added.story.variants.find((variant) => variant.id === firstId).status, 'draft');

  const approved = run(db, 'approve-variant', {
    storyId: result.story.id,
    expectedVersion: added.story.lock_version,
    variantId: firstId,
    approvedBy: 'Cole',
    idempotencyKey: 'variant-approve'
  });
  assert.equal(approved.story.variants.find((variant) => variant.id === firstId).status, 'approved');

  const revised = run(db, 'revise-variant', {
    storyId: result.story.id,
    expectedVersion: approved.story.lock_version,
    key: 'interview-60s', purpose: 'interview', medium: 'spoken', length: '60_seconds',
    audience: 'engineering manager', content: 'Second concise spoken version.',
    idempotencyKey: 'variant-revise'
  });
  const rows = db.prepare('SELECT * FROM profile_story_variants WHERE story_id = ? ORDER BY version').all(result.story.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].content, 'First concise spoken version.');
  assert.equal(rows[0].is_current, 0);
  assert.equal(rows[1].content, 'Second concise spoken version.');
  assert.equal(rows[1].version, 2);
  assert.equal(rows[1].status, 'draft');
  assert.equal(revised.story.lock_version, 4);
});

test('a new canonical revision invalidates prior consent and variant approval', (t) => {
  const db = createDb(t);
  const appId = db.prepare("INSERT INTO applications (company, role) VALUES ('Acme', 'Engineer')").run().lastInsertRowid;
  let result = capture(db, 'revision-consent');
  result = polish(db, result.story, 'revision-consent', { canonical: 'Revision one meaning.' });
  result = run(db, 'add-variant', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    key: 'interview', purpose: 'interview', medium: 'spoken', length: 'short',
    content: 'Approved variant for revision one.', idempotencyKey: 'revision-consent-variant'
  });
  const variantId = result.variantId;
  result = run(db, 'approve-variant', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    variantId, approvedBy: 'Cole', idempotencyKey: 'revision-consent-variant-approve'
  });
  result = run(db, 'set-permission', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    purpose: 'interview', decision: 'allow', approvedBy: 'Cole',
    idempotencyKey: 'revision-consent-allow'
  });
  assert.equal(run(db, 'match', { purpose: 'interview' }).candidates[0].variant.id, variantId);

  result = polish(db, result.story, 'revision-consent-v2', { canonical: 'Revision two materially changed meaning.' });
  const permission = result.story.permissions.find((row) => row.purpose === 'interview');
  const variant = result.story.variants.find((row) => row.id === variantId);
  assert.equal(permission.decision, 'ask');
  assert.match(permission.reason, /reapproval required/);
  assert.equal(variant.status, 'draft');
  const matched = run(db, 'match', { purpose: 'interview' });
  assert.equal(matched.candidates.length, 0);
  assert.equal(matched.needsApproval.length, 1);
  assert.throws(() => run(db, 'approve-variant', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    variantId, approvedBy: 'Cole', idempotencyKey: 'stale-variant-reapprove'
  }), /older canonical revision/);
  assert.throws(() => run(db, 'record-use', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    applicationId: appId, purpose: 'interview', variantId, approvedBy: 'Cole',
    idempotencyKey: 'stale-variant-use'
  }), /not allowed|older canonical revision/);
});

test('story metadata is optimistic, tagged, and sensitivity changes revoke allow', (t) => {
  const db = createDb(t);
  let result = capture(db, 'metadata', { tags: 'initial' });
  result = polish(db, result.story, 'metadata');
  result = run(db, 'set-permission', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    purpose: 'networking', decision: 'allow', approvedBy: 'Cole',
    idempotencyKey: 'metadata-allow'
  });
  result = run(db, 'update-metadata', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    tags: 'leadership,incident', sensitivity: 'sensitive', setting: 'production incident',
    idempotencyKey: 'metadata-update'
  });
  assert.deepEqual(result.story.tags, ['incident', 'leadership']);
  assert.equal(result.story.setting, 'production incident');
  assert.equal(result.story.sensitivity, 'sensitive');
  assert.equal(result.story.permissions.find((row) => row.purpose === 'networking').decision, 'ask');
  assert.throws(() => run(db, 'update-metadata', {
    storyId: result.story.id, expectedVersion: result.story.lock_version - 1,
    tags: 'stale', idempotencyKey: 'metadata-stale'
  }), /version conflict/);
});

test('match emits prose only for allow, metadata only for ask, and nothing for deny', (t) => {
  const db = createDb(t);
  const appId = db.prepare("INSERT INTO applications (company, role, notes, job_url) VALUES ('ExampleCo', 'Platform Engineer', 'migration leadership', 'https://example.test/job')").run().lastInsertRowid;
  const stories = [];
  for (const [name, decision] of [['allow', 'allow'], ['ask', 'ask'], ['deny', 'deny']]) {
    let result = capture(db, `match-${name}`, { raw: `Raw ${name} migration story`, title: `${name} migration` });
    result = polish(db, result.story, `match-${name}`, { canonical: `I led a platform migration with ${name} controls.` });
    result = run(db, 'set-permission', {
      storyId: result.story.id,
      expectedVersion: result.story.lock_version,
      purpose: 'interview', decision,
      approvedBy: decision === 'allow' ? 'Cole' : undefined,
      idempotencyKey: `permission-${name}`
    });
    stories.push(result.story);
  }

  const matched = run(db, 'match', {
    applicationId: appId,
    purpose: 'interview',
    question: 'Tell me about migration leadership',
    limit: 10
  });
  assert.equal(matched.candidates.length, 1);
  assert.match(matched.candidates[0].story.canonical.text, /allow controls/);
  assert.equal(matched.needsApproval.length, 1);
  // facets carries retrieval SLUGS only — claims stay behind the approval,
  // pinned by the facet tests below.
  assert.deepEqual(Object.keys(matched.needsApproval[0].story).sort(), ['facets', 'id', 'lock_version', 'profile_entry_id', 'sensitivity', 'status']);
  assert.equal(JSON.stringify(matched.needsApproval).includes('ask controls'), false);
  assert.equal(JSON.stringify(matched).includes('deny controls'), false);
  assert.equal(matched.deniedCount, 1);
  assert.equal(stories.length, 3);
});

test('expired permission becomes ask without leaking prose', (t) => {
  const db = createDb(t);
  let result = capture(db, 'expired');
  result = polish(db, result.story, 'expired', { canonical: 'Private canonical expiration story.' });
  result = run(db, 'set-permission', {
    storyId: result.story.id,
    expectedVersion: result.story.lock_version,
    purpose: 'resume', decision: 'allow', approvedBy: 'Cole', expiresAt: '2025-01-01T00:00:00Z',
    idempotencyKey: 'expired-permission'
  });
  const matched = runStoryCommand(db, ['match'], { purpose: 'resume' }, { now: '2026-01-01T00:00:00Z' });
  assert.equal(matched.candidates.length, 0);
  assert.equal(matched.needsApproval.length, 1);
  assert.equal(matched.needsApproval[0].permission.source, 'expired_override');
  assert.equal(JSON.stringify(matched).includes('Private canonical'), false);
});

test('questions, application links, and immutable use audit enforce ownership and permission', (t) => {
  const db = createDb(t);
  const appId = db.prepare("INSERT INTO applications (company, role) VALUES ('Northwind', 'Engineer')").run().lastInsertRowid;
  let result = capture(db, 'audit');
  result = polish(db, result.story, 'audit');
  result = run(db, 'add-question', {
    storyId: result.story.id,
    expectedVersion: result.story.lock_version,
    kind: 'metric', question: 'What changed measurably?', priority: 10,
    idempotencyKey: 'question-add'
  });
  const questionId = result.questionId;
  result = run(db, 'answer-question', {
    storyId: result.story.id,
    expectedVersion: result.story.lock_version,
    questionId,
    answer: 'Recovery time fell from hours to minutes.',
    idempotencyKey: 'question-answer'
  });
  assert.equal(result.story.questions[0].status, 'answered');
  assert.equal(result.story.questions[0].answer_text, undefined);
  assert.equal(result.story.questions[0].has_answer, true);
  assert.equal(run(db, 'show', { storyId: result.story.id, includeRaw: true }).story.questions[0].answer_text, 'Recovery time fell from hours to minutes.');
  assert.equal(result.story.status, 'developing');
  assert.equal(result.story.captures.length, 2);
  assert.equal(db.prepare('SELECT raw_text FROM profile_story_captures WHERE id=?').get(result.captureId).raw_text, 'Recovery time fell from hours to minutes.');
  assert.throws(() => run(db, 'answer-question', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    questionId, answer: 'Overwrite attempt', idempotencyKey: 'question-reanswer'
  }), /already answered/);
  assert.throws(() => run(db, 'defer-question', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    questionId, idempotencyKey: 'question-defer-after-answer'
  }), /already answered/);
  assert.throws(() => run(db, 'dismiss-question', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    questionId, idempotencyKey: 'question-dismiss-after-answer'
  }), /already answered/);
  result = polish(db, result.story, 'audit-after-answer', { canonical: 'Canonical audit story with the confirmed recovery metric.' });

  result = run(db, 'link-application', {
    storyId: result.story.id,
    expectedVersion: result.story.lock_version,
    applicationId: appId, relation: 'candidate', promptText: 'Tell me about reliability.',
    idempotencyKey: 'app-link'
  });
  assert.equal(result.story.applicationLinks.length, 1);
  assert.throws(() => run(db, 'link-application', {
    storyId: result.story.id,
    expectedVersion: result.story.lock_version,
    applicationId: appId, relation: 'used',
    idempotencyKey: 'app-link-false-use'
  }), /reserved for permission\/use workflows/);
  assert.throws(() => run(db, 'record-use', {
    storyId: result.story.id,
    expectedVersion: result.story.lock_version,
    applicationId: appId, purpose: 'interview', approvedBy: 'Cole',
    idempotencyKey: 'use-denied-by-default'
  }), /not allowed/);

  result = run(db, 'set-permission', {
    storyId: result.story.id,
    expectedVersion: result.story.lock_version,
    purpose: 'interview', decision: 'allow', approvedBy: 'Cole',
    idempotencyKey: 'use-permission'
  });
  result = run(db, 'record-use', {
    storyId: result.story.id,
    expectedVersion: result.story.lock_version,
    applicationId: appId, purpose: 'interview', approvedBy: 'Cole',
    targetKind: 'interview_plan', targetId: 7, promptText: 'Tell me about reliability.',
    idempotencyKey: 'use-record'
  });
  assert.equal(result.story.uses.length, 1);
  assert.equal(result.story.uses[0].application_id, appId);
  assert.equal(result.story.uses[0].revision_id, result.story.currentRevision.id);
  assert.match(result.story.uses[0].content_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.story.uses[0].approved_by, 'Cole');
  assert.equal(result.story.applicationLinks.some((link) => link.relation === 'used'), true);
  assert.throws(() => db.prepare("UPDATE profile_story_uses SET approved_by = 'Other' WHERE id = ?").run(result.useId), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM profile_story_uses WHERE id = ?').run(result.useId), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM profile_stories WHERE id = ?').run(result.story.id), /append-only|FOREIGN KEY constraint failed/);
});

test('failed mutations are atomic and do not consume idempotency keys', (t) => {
  const db = createDb(t);
  const result = capture(db, 'atomic');
  assert.throws(() => run(db, 'polish', {
    storyId: result.story.id,
    expectedVersion: result.story.lock_version,
    canonical: 'Canonical text',
    captureIds: '999',
    idempotencyKey: 'atomic-failure'
  }), /Capture 999 not found/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM profile_story_revisions WHERE story_id = ?').get(result.story.id).n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM profile_story_operations WHERE idempotency_key = 'atomic-failure'").get().n, 0);
  assert.equal(getStory(db, result.story.id).lock_version, 0);
});

test('facet claims: claim, restate with --replace, retract, and slug/weight validation', (t) => {
  const db = createDb(t);
  let result = capture(db, 'facet-basics');
  result = run(db, 'claim-facet', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    facet: 'Leading-Without-Authority', claim: 'Coordinated the incident response without being the tech lead',
    beatAnchor: 'beat-2', weight: 3, idempotencyKey: 'facet-claim-1'
  });
  assert.equal(result.story.facets.length, 1);
  assert.equal(result.story.facets[0].facet, 'leading-without-authority', 'slug normalizes to lowercase');
  assert.equal(result.story.facets[0].weight, 3);
  assert.equal(result.story.facets[0].beat_anchor, 'beat-2');

  // One claim per (story, facet): a duplicate is an explicit restatement.
  assert.throws(() => run(db, 'claim-facet', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    facet: 'leading-without-authority', claim: 'Different wording', idempotencyKey: 'facet-claim-dup'
  }), /already claims/);
  result = run(db, 'claim-facet', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    facet: 'leading-without-authority', claim: 'Restated claim', weight: 2, replace: true,
    idempotencyKey: 'facet-claim-2'
  });
  assert.equal(result.story.facets[0].claim, 'Restated claim');
  assert.equal(result.story.facets[0].weight, 2);

  // Multi-faceted: one story carries several claims, ordered weight-first.
  result = run(db, 'claim-facet', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    facet: 'debugging-under-pressure', claim: 'Bisected the outage to a config push in 40 minutes', weight: 3,
    idempotencyKey: 'facet-claim-3'
  });
  assert.deepEqual(result.story.facets.map((facet) => facet.facet),
    ['debugging-under-pressure', 'leading-without-authority']);

  result = run(db, 'retract-facet', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    facet: 'debugging-under-pressure', idempotencyKey: 'facet-retract-1'
  });
  assert.deepEqual(result.story.facets.map((facet) => facet.facet), ['leading-without-authority']);
  assert.throws(() => run(db, 'retract-facet', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    facet: 'debugging-under-pressure', idempotencyKey: 'facet-retract-2'
  }), /does not claim/);

  assert.throws(() => run(db, 'claim-facet', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    facet: 'Bad Slug!', claim: 'x', idempotencyKey: 'facet-bad-slug'
  }), /lower-kebab/);
  assert.throws(() => run(db, 'claim-facet', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    facet: 'ownership', claim: 'x', weight: 9, idempotencyKey: 'facet-bad-weight'
  }), /--weight/);
  assert.throws(() => run(db, 'claim-facet', {
    storyId: result.story.id, expectedVersion: 999,
    facet: 'ownership', claim: 'x', idempotencyKey: 'facet-bad-version'
  }), /version conflict/);

  // Idempotent replay returns the stored result without a second write.
  const replay = run(db, 'retract-facet', {
    storyId: result.story.id, expectedVersion: result.story.lock_version - 1,
    facet: 'debugging-under-pressure', idempotencyKey: 'facet-retract-1'
  });
  assert.equal(replay.command, 'retract-facet');
});

test('match lands a story through its facet when the question shares no prose words', (t) => {
  const db = createDb(t);
  // The story's prose never says "mentoring": the facet claim is what makes
  // the question findable. This is the framing-robustness the table exists for.
  let result = capture(db, 'facet-mentor', { title: 'Onboarding season' });
  result = polish(db, result.story, 'facet-mentor', {
    canonical: 'I paired with two new grads through their first on-call rotation and wrote the runbook they asked for.',
    summary: 'Two new grads, one on-call rotation',
    takeaway: 'Write the runbook people wish existed'
  });
  result = run(db, 'set-permission', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    purpose: 'application_form', decision: 'allow', approvedBy: 'Cole',
    idempotencyKey: 'facet-mentor-allow'
  });
  result = run(db, 'claim-facet', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    facet: 'mentoring-junior-engineers', claim: 'Coached two new grads through on-call', weight: 3,
    idempotencyKey: 'facet-mentor-claim'
  });

  // Control: a ready story with no facet and no word overlap must not match.
  let other = capture(db, 'facet-control', { title: 'Billing cutover' });
  other = polish(db, other.story, 'facet-control', {
    canonical: 'Migrated the billing database with zero downtime.',
    summary: 'Billing cutover', takeaway: 'Rehearse the rollback'
  });
  run(db, 'set-permission', {
    storyId: other.story.id, expectedVersion: other.story.lock_version,
    purpose: 'application_form', decision: 'allow', approvedBy: 'Cole',
    idempotencyKey: 'facet-control-allow'
  });

  const matched = run(db, 'match', {
    purpose: 'application_form',
    question: 'Tell me about mentoring someone junior'
  });
  assert.equal(matched.candidates.length, 1, JSON.stringify(matched.candidates.map((c) => c.story.title)));
  const [candidate] = matched.candidates;
  assert.equal(candidate.story.title, 'Onboarding season');
  assert.ok(candidate.reasons.includes('facet:mentoring-junior-engineers'), candidate.reasons.join(','));
  assert.equal(candidate.story.facets[0].claim, 'Coached two new grads through on-call');
});

test('facet weight ranks stories sharing a facet, and ask-gated matches expose slugs but never claims', (t) => {
  const db = createDb(t);
  let central = capture(db, 'facet-central', { title: 'Central story' });
  central = polish(db, central.story, 'facet-central', { canonical: 'Alpha narrative text.' });
  central = run(db, 'set-permission', {
    storyId: central.story.id, expectedVersion: central.story.lock_version,
    purpose: 'application_form', decision: 'allow', approvedBy: 'Cole', idempotencyKey: 'facet-central-allow'
  });
  run(db, 'claim-facet', {
    storyId: central.story.id, expectedVersion: central.story.lock_version,
    facet: 'ownership', claim: 'Owned the service end to end', weight: 3, idempotencyKey: 'facet-central-claim'
  });
  let passing = capture(db, 'facet-passing', { title: 'Passing story' });
  passing = polish(db, passing.story, 'facet-passing', { canonical: 'Beta narrative text.' });
  passing = run(db, 'set-permission', {
    storyId: passing.story.id, expectedVersion: passing.story.lock_version,
    purpose: 'application_form', decision: 'allow', approvedBy: 'Cole', idempotencyKey: 'facet-passing-allow'
  });
  run(db, 'claim-facet', {
    storyId: passing.story.id, expectedVersion: passing.story.lock_version,
    facet: 'ownership', claim: 'Ownership appears briefly', weight: 1, idempotencyKey: 'facet-passing-claim'
  });
  const ranked = run(db, 'match', { purpose: 'application_form', question: 'Describe a time you took ownership' });
  assert.deepEqual(ranked.candidates.map((c) => c.story.title), ['Central story', 'Passing story'],
    'the defining facet outranks the passing one');

  // An ask-gated story surfaces its facet SLUGS for triage, but the claim
  // text stays behind the approval, like every other gated field.
  let gated = capture(db, 'facet-gated', { title: 'Gated story' }); // default ask
  gated = polish(db, gated.story, 'facet-gated', { canonical: 'Gamma narrative text.' });
  run(db, 'claim-facet', {
    storyId: gated.story.id, expectedVersion: gated.story.lock_version,
    facet: 'ownership', claim: 'SECRET_CLAIM_SENTINEL detail', weight: 2, idempotencyKey: 'facet-gated-claim'
  });
  const withGated = run(db, 'match', { purpose: 'application_form', question: 'Describe a time you took ownership' });
  assert.equal(withGated.needsApproval.length, 1);
  assert.deepEqual(withGated.needsApproval[0].story.facets, ['ownership']);
  assert.doesNotMatch(JSON.stringify(withGated.needsApproval), /SECRET_CLAIM_SENTINEL/);
});
