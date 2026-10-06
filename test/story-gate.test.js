'use strict';

// The story-mapping gate: every REQUIRED behavioral question must map to a
// ready, permitted story through its FACETS, or the application is blocked
// and escalates. These tests pin the three decisions (mapped / needs_approval
// / blocked), the facet-only qualification rule (prose overlap alone never
// maps), the optional-question non-veto, the durable check ledger, and run
// idempotency.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const { GATE_QUESTIONS_SCHEMA_VERSION, runStoryCommand } = require('../lib/stories');

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

function run(db, command, flags = {}) {
  return runStoryCommand(db, [command], flags, {});
}

/** Seed one polished story; returns { id, lock_version } after the last step. */
function seedStory(db, key, { title, canonical, facet, claim, weight = 3, allow = true }) {
  let result = run(db, 'capture', {
    title, raw: `Raw narration for ${key}`, source: 'Cole conversation',
    confidence: 'high', idempotencyKey: key
  });
  result = run(db, 'polish', {
    storyId: result.story.id, expectedVersion: result.story.lock_version,
    canonical, summary: `Summary for ${key}`, takeaway: `Takeaway for ${key}`,
    idempotencyKey: `${key}-polish`
  });
  if (allow) {
    result = run(db, 'set-permission', {
      storyId: result.story.id, expectedVersion: result.story.lock_version,
      purpose: 'application_form', decision: 'allow', approvedBy: 'Cole',
      idempotencyKey: `${key}-allow`
    });
  }
  if (facet) {
    result = run(db, 'claim-facet', {
      storyId: result.story.id, expectedVersion: result.story.lock_version,
      facet, claim, weight, idempotencyKey: `${key}-facet`
    });
  }
  return result.story;
}

function gateDocument(questions, extra = {}) {
  return JSON.stringify({ schemaVersion: GATE_QUESTIONS_SCHEMA_VERSION, questions, ...extra });
}

test('a required question maps through a claimed facet; the verdict clears and the ledger records it', (t) => {
  const db = createDb(t);
  const applicationId = Number(db.prepare("INSERT INTO applications (company, role) VALUES ('Acme', 'Engineer')").run().lastInsertRowid);
  const story = seedStory(db, 'gate-mentor', {
    title: 'Onboarding season',
    canonical: 'I paired with two new grads through their first on-call rotation.',
    facet: 'mentoring-junior-engineers',
    claim: 'Coached two new grads through on-call'
  });

  const result = run(db, 'gate', {
    questions: gateDocument([
      { key: 'behavioral_mentor', prompt: 'Tell us about mentoring someone junior.', required: true, facets: ['mentoring-junior-engineers'] }
    ]),
    applicationId, runKey: 'gate-run-1'
  });

  assert.equal(result.command, 'gate');
  assert.equal(result.verdict.submitEligible, true);
  assert.equal(result.verdict.requiredMapped, 1);
  const [question] = result.questions;
  assert.equal(question.decision, 'mapped');
  assert.equal(question.story.id, story.id);
  assert.deepEqual(question.story.matchedFacets, ['mentoring-junior-engineers']);
  assert.equal(question.story.matchedClaims[0].claim, 'Coached two new grads through on-call');
  assert.ok(question.story.canonical.text.includes('on-call rotation'), 'the canonical rides along for adaptation');

  const checks = db.prepare('SELECT * FROM profile_story_gate_checks WHERE run_key = ?').all('gate-run-1');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].decision, 'mapped');
  assert.equal(checks[0].story_id, story.id);
  assert.equal(checks[0].application_id, applicationId);
  assert.equal(checks[0].required, 1);
});

test('prose overlap alone never maps: a faceted question with no claiming story blocks and escalates', (t) => {
  const db = createDb(t);
  // The canonical prose CONTAINS the question's words, but claims a different
  // facet — the gate must still block, because nothing claims what the
  // question asks about. Under-matching escalates; over-matching stretches.
  seedStory(db, 'gate-prose', {
    title: 'Deadline crunch',
    canonical: 'We had a conflict about the deadline and I struggled with the tradeoff.',
    facet: 'prioritization',
    claim: 'Cut scope to hit the date'
  });

  const result = run(db, 'gate', {
    questions: gateDocument([
      { key: 'behavioral_conflict', prompt: 'Describe a conflict you struggled with on a team.', required: true, facets: ['conflict-resolution'] }
    ]),
    runKey: 'gate-run-block'
  });

  assert.equal(result.verdict.submitEligible, false);
  assert.equal(result.verdict.requiredBlocked, 1);
  const [question] = result.questions;
  assert.equal(question.decision, 'blocked');
  assert.equal(question.story, undefined, 'no story is suggested for a blocked question');
  assert.equal(question.escalation.kind, 'author_story');
  assert.deepEqual(question.escalation.facetsSought, ['conflict-resolution']);
  assert.match(question.escalation.commands.join('\n'), /story capture/);
  assert.match(question.escalation.commands.join('\n'), /facet claim/);

  const check = db.prepare('SELECT * FROM profile_story_gate_checks WHERE run_key = ?').get('gate-run-block');
  assert.equal(check.decision, 'blocked');
  assert.equal(check.story_id, null);
  assert.equal(check.application_id, null, 'a preflight run records without an application');
});

test('an ask-gated story yields needs_approval with the grant command, never its claims or prose', (t) => {
  const db = createDb(t);
  const story = seedStory(db, 'gate-ask', {
    title: 'Sensitive save',
    canonical: 'SECRET_PROSE_SENTINEL narrative.',
    facet: 'ownership',
    claim: 'SECRET_CLAIM_SENTINEL owned it',
    allow: false // stays at the story default: ask
  });

  const result = run(db, 'gate', {
    questions: gateDocument([
      { key: 'behavioral_ownership', prompt: 'Describe a time you took ownership.', required: true, facets: ['ownership'] }
    ]),
    runKey: 'gate-run-ask'
  });

  assert.equal(result.verdict.submitEligible, false);
  assert.equal(result.verdict.requiredNeedsApproval, 1);
  const [question] = result.questions;
  assert.equal(question.decision, 'needs_approval');
  assert.equal(question.story.id, story.id);
  assert.deepEqual(question.story.facets, ['ownership'], 'facet slugs only');
  assert.equal(question.escalation.kind, 'grant_permission');
  assert.match(question.escalation.command, new RegExp(`--story-id ${story.id} .*--purpose application_form --decision allow`));
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /SECRET_PROSE_SENTINEL/, 'gated prose never leaves the gate');
  assert.doesNotMatch(serialized, /SECRET_CLAIM_SENTINEL/, 'gated claims never leave the gate');

  const check = db.prepare('SELECT * FROM profile_story_gate_checks WHERE run_key = ?').get('gate-run-ask');
  assert.equal(check.decision, 'needs_approval');
  assert.equal(check.story_id, story.id);
});

test('an optional question with no story reports blocked but does not veto submission', (t) => {
  const db = createDb(t);
  seedStory(db, 'gate-optional', {
    title: 'Onboarding season',
    canonical: 'I paired with two new grads through their first on-call rotation.',
    facet: 'mentoring-junior-engineers',
    claim: 'Coached two new grads through on-call'
  });

  const result = run(db, 'gate', {
    questions: gateDocument([
      { key: 'behavioral_mentor', prompt: 'Tell us about mentoring someone junior.', required: true, facets: ['mentoring-junior-engineers'] },
      { key: 'behavioral_speaking', prompt: 'Tell us about public speaking.', required: false, facets: ['public-speaking'] }
    ]),
    runKey: 'gate-run-optional'
  });

  assert.equal(result.verdict.submitEligible, true, 'the honest move for the optional is to leave it blank');
  assert.equal(result.verdict.optionalBlocked, 1);
  assert.equal(result.questions[1].decision, 'blocked');
});

test('the gate run is idempotent per run key, and a reused key with different questions refuses', (t) => {
  const db = createDb(t);
  seedStory(db, 'gate-idem', {
    title: 'Onboarding season',
    canonical: 'I paired with two new grads through their first on-call rotation.',
    facet: 'mentoring-junior-engineers',
    claim: 'Coached two new grads through on-call'
  });
  const questions = gateDocument([
    { key: 'behavioral_mentor', prompt: 'Tell us about mentoring someone junior.', required: true, facets: ['mentoring-junior-engineers'] }
  ]);

  const first = run(db, 'gate', { questions, runKey: 'gate-run-idem' });
  const replay = run(db, 'gate', { questions, runKey: 'gate-run-idem' });
  assert.deepEqual(replay, first);
  assert.equal(db.prepare('SELECT count(*) AS n FROM profile_story_gate_checks WHERE run_key = ?').get('gate-run-idem').n, 1,
    'a replay writes no second check row');

  assert.throws(() => run(db, 'gate', {
    questions: gateDocument([
      { key: 'behavioral_other', prompt: 'Different question.', required: true, facets: ['ownership'] }
    ]),
    runKey: 'gate-run-idem'
  }), /already used for a different request/);
});

test('the questions document is validated strictly', (t) => {
  const db = createDb(t);
  assert.throws(() => run(db, 'gate', { questions: 'not-json', runKey: 'k1' }), /valid JSON/);
  assert.throws(() => run(db, 'gate', { questions: '{}', runKey: 'k2' }), /schemaVersion/);
  assert.throws(() => run(db, 'gate', {
    questions: JSON.stringify({ schemaVersion: GATE_QUESTIONS_SCHEMA_VERSION, questions: [] }), runKey: 'k3'
  }), /non-empty/);
  assert.throws(() => run(db, 'gate', {
    questions: gateDocument([{ key: 'Bad Key', prompt: 'x' }]), runKey: 'k4'
  }), /key must be/);
  assert.throws(() => run(db, 'gate', {
    questions: gateDocument([{ key: 'ok', prompt: 'x', facets: ['Bad Facet'] }]), runKey: 'k5'
  }), /facets must be/);
  assert.throws(() => run(db, 'gate', {
    questions: gateDocument([{ key: 'ok', prompt: 'x' }]), applicationId: 999, runKey: 'k6'
  }), /Application 999 not found/);
  // A failed run consumes nothing: no ledger rows, no idempotency record.
  assert.equal(db.prepare('SELECT count(*) AS n FROM profile_story_gate_checks').get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM profile_story_operations WHERE command = 'gate'").get().n, 0);
});
