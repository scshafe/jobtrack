'use strict';

// The application-submission lane: approval-bound authority to submit ONCE,
// and the reconciliation fence between an ambiguous outcome and a duplicate.
// This is the v2 email lane's design applied to a second outward-facing act,
// so these tests pin the same properties: an approval covers one exact
// intent, yields one attempt, cannot be re-claimed while an attempt is
// unreconciled, and is spent forever once something landed.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  SubmissionError,
  approveSubmission,
  claimSubmissionAttempt,
  proposeSubmission,
  readSubmissionState,
  settleSubmissionAttempt
} = require('../lib/application-submission');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-submission-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      role TEXT NOT NULL
    );
    INSERT INTO applications (company, role) VALUES ('Drove', 'Staff Software Engineer');
  `);
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { db, home };
}

// Every clock in this file is INJECTED. An assertion that falls back to the
// wall clock silently becomes time-dependent: the fixture's approval expires
// an hour after its approved-at, so such a test passes when written and fails
// later the same afternoon. Found exactly that way on 2026-08-06.
const AT = () => '2026-08-06T12:05:00.000Z';

const ANSWERS = { first_name: 'Alex', last_name: 'Example', why_company: 'The routing work.' };
const DOCUMENTS = { resume: 'a'.repeat(64), cover_letter: 'b'.repeat(64) };

function propose(db, overrides = {}) {
  return proposeSubmission(db, {
    intentId: 'intent-1', applicationId: 1, surfaceId: 'drove/demo-multi-page',
    answers: ANSWERS, documents: DOCUMENTS, ...overrides
  }, { now: () => '2026-08-06T12:00:00.000Z' });
}

function approve(db, home, overrides = {}, deps = {}) {
  const intent = propose(db, overrides.proposal ?? {});
  return {
    intent,
    ...approveSubmission(db, {
      intentId: intent.intent.intentId,
      expectedIntentDigest: intent.intentDigest,
      approvalId: overrides.approvalId ?? 'approval-1',
      approver: overrides.approver ?? { kind: 'human', id: 'Alex' }
    }, { home, now: () => '2026-08-06T12:01:00.000Z', ...deps })
  };
}

test('an intent digests the exact company, answers, and documents; a changed answer is a different intent', (t) => {
  const { db } = fixture(t);
  const first = propose(db);
  assert.equal(first.intent.company, 'Drove');
  assert.equal(first.intent.role, 'Staff Software Engineer');
  assert.equal(first.intentDigest.length, 64);
  assert.equal(propose(db).intentDigest, first.intentDigest, 'proposing the same thing is idempotent');

  // The digest is order-independent but content-sensitive.
  const reordered = proposeSubmission(db, {
    intentId: 'intent-reordered', applicationId: 1, surfaceId: 'drove/demo-multi-page',
    answers: { why_company: ANSWERS.why_company, last_name: 'Example', first_name: 'Alex' },
    documents: { cover_letter: DOCUMENTS.cover_letter, resume: DOCUMENTS.resume }
  }, { now: () => '2026-08-06T12:00:00.000Z' });
  assert.equal(reordered.intent.answersDigest, first.intent.answersDigest, 'key order does not change the digest');
  assert.equal(reordered.intent.documentsDigest, first.intent.documentsDigest);

  const edited = proposeSubmission(db, {
    intentId: 'intent-edited', applicationId: 1, surfaceId: 'drove/demo-multi-page',
    answers: { ...ANSWERS, why_company: 'Different words.' }, documents: DOCUMENTS
  }, { now: () => '2026-08-06T12:00:00.000Z' });
  assert.notEqual(edited.intent.answersDigest, first.intent.answersDigest);

  assert.throws(() => proposeSubmission(db, {
    intentId: 'intent-1', applicationId: 1, surfaceId: 'other', answers: ANSWERS, documents: DOCUMENTS
  }, { now: () => '2026-08-06T12:00:00.000Z' }), (error) => error.code === 'INTENT_CONFLICT');

  assert.throws(() => proposeSubmission(db, {
    intentId: 'intent-bad-doc', applicationId: 1, surfaceId: 's', answers: {}, documents: { resume: 'not-a-digest' }
  }, {}), (error) => error.code === 'INVALID_INPUT');
});

test('an approval binds one intent digest, is signed, and says whether a human or a policy decided', (t) => {
  const { db, home } = fixture(t);
  const { intent, approval, signature, keyId } = approve(db, home);
  assert.equal(approval.intentDigest, intent.intentDigest);
  assert.equal(approval.approver.kind, 'human');
  assert.equal(approval.oneSubmitIdempotencyKey, 'approval-1-once');
  assert.ok(signature.length > 40, 'the approval is signed');
  assert.match(keyId, /application-submission-approval/);
  assert.notEqual(keyId, 'auto-approval-key-v1', 'a submission key is not the email approval key');

  // Approving a digest that is not the recorded one is refused.
  const other = propose(db, { intentId: 'intent-2' });
  assert.throws(() => approveSubmission(db, {
    intentId: other.intent.intentId, expectedIntentDigest: 'f'.repeat(64),
    approvalId: 'approval-2', approver: { kind: 'human', id: 'Alex' }
  }, { home, now: AT }), (error) => error.code === 'INTENT_DIGEST_MISMATCH');

  // A policy approval says so rather than masquerading as a person.
  const policy = approve(db, home, {
    proposal: { intentId: 'intent-policy' }, approvalId: 'approval-policy',
    approver: { kind: 'policy', id: 'submission-policy.v1' }
  });
  assert.equal(policy.approval.approver.kind, 'policy');
  assert.throws(() => approveSubmission(db, {
    intentId: 'intent-2', expectedIntentDigest: other.intentDigest,
    approvalId: 'approval-bad', approver: { kind: 'robot', id: 'x' }
  }, { home, now: AT }), (error) => error.code === 'INVALID_INPUT');
});

test('one approval authorizes exactly one LANDED submission', (t) => {
  const { db, home } = fixture(t);
  approve(db, home);
  const claimed = claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-1' },
    { home, now: () => '2026-08-06T12:02:00.000Z' });
  assert.equal(claimed.attemptId, 'attempt-1');
  assert.equal(claimed.priorAttempts, 0);

  settleSubmissionAttempt(db, { attemptId: 'attempt-1', outcome: 'accepted', externalReference: 'ATS-123' },
    { now: () => '2026-08-06T12:03:00.000Z' });

  assert.throws(() => claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-2' }, { home, now: AT }),
    (error) => error.code === 'APPROVAL_SPENT');

  const state = readSubmissionState(db, 1);
  assert.equal(state.landed.external_reference, 'ATS-123');
  assert.equal(state.maySubmit, false);
  assert.equal(state.attempts.length, 1);
});

test('THE FENCE: an unreconciled attempt cannot be retried, and an indeterminate settlement still holds it', (t) => {
  const { db, home } = fixture(t);
  approve(db, home);
  claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-1' },
    { home, now: () => '2026-08-06T12:02:00.000Z' });

  // The attempt is claimed and its outcome is unknown — the exact shape of a
  // request that timed out after the server may have committed.
  assert.throws(
    () => claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-2' }, { home, now: AT }),
    (error) => error.code === 'ATTEMPT_UNRECONCILED' && /never retry an ambiguous submission/.test(error.message)
  );
  assert.equal(readSubmissionState(db, 1).maySubmit, false);

  // Settling INDETERMINATE is honest — and still fences, because nothing was
  // learned about whether the submission landed.
  settleSubmissionAttempt(db, { attemptId: 'attempt-1', outcome: 'indeterminate' }, { now: () => '2026-08-06T12:03:00.000Z' });
  assert.equal(readSubmissionState(db, 1).maySubmit, false, 'not knowing is not the same as knowing it failed');
  assert.throws(
    () => claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-3' }, { home, now: AT }),
    (error) => error.code === 'ATTEMPT_UNRECONCILED',
    'an indeterminate settlement fences exactly like an unsettled one'
  );
});

test('definitively failed and rejected attempts each free the approval for another try', (t) => {
  const { db, home } = fixture(t);
  approve(db, home);
  claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-1' },
    { home, now: () => '2026-08-06T12:02:00.000Z' });
  settleSubmissionAttempt(db, { attemptId: 'attempt-1', outcome: 'failed' }, { now: () => '2026-08-06T12:03:00.000Z' });

  const retried = claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-2' },
    { home, now: () => '2026-08-06T12:04:00.000Z' });
  assert.equal(retried.priorAttempts, 1, 'the retry knows it is not the first');
  settleSubmissionAttempt(db, { attemptId: 'attempt-2', outcome: 'rejected' }, { now: () => '2026-08-06T12:05:00.000Z' });
  assert.equal(readSubmissionState(db, 1).maySubmit, true, 'a rejection proves nothing landed and permits v3');

  const third = claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-3' },
    { home, now: () => '2026-08-06T12:06:00.000Z' });
  assert.equal(third.priorAttempts, 2);
  settleSubmissionAttempt(db, { attemptId: 'attempt-3', outcome: 'accepted' }, { now: () => '2026-08-06T12:07:00.000Z' });
  assert.equal(readSubmissionState(db, 1).attempts.length, 3);
});

test('a duplicate settlement spends the approval and never exposes a retry', (t) => {
  const { db, home } = fixture(t);
  approve(db, home);
  claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-1' },
    { home, now: () => '2026-08-06T12:02:00.000Z' });
  settleSubmissionAttempt(db, { attemptId: 'attempt-1', outcome: 'duplicate' },
    { now: () => '2026-08-06T12:03:00.000Z' });
  const state = readSubmissionState(db, 1);
  assert.equal(state.landed.outcome, 'duplicate');
  assert.equal(state.maySubmit, false);
  assert.throws(
    () => claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-2' }, { home, now: AT }),
    (error) => error.code === 'APPROVAL_SPENT'
  );
});

test('settlements are immutable and attempts are append-only', (t) => {
  const { db, home } = fixture(t);
  approve(db, home);
  claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-1' }, { home, now: () => '2026-08-06T12:02:00.000Z' });
  settleSubmissionAttempt(db, { attemptId: 'attempt-1', outcome: 'accepted' }, { now: () => '2026-08-06T12:03:00.000Z' });

  // Replaying the same settlement is fine; changing it is not.
  assert.equal(settleSubmissionAttempt(db, { attemptId: 'attempt-1', outcome: 'accepted' }, { now: AT }).reused, true);
  assert.throws(() => settleSubmissionAttempt(db, { attemptId: 'attempt-1', outcome: 'failed' }, { now: AT }),
    (error) => error.code === 'ATTEMPT_SETTLED');
  assert.throws(() => db.prepare('DELETE FROM application_submission_attempts WHERE attempt_id=?').run('attempt-1'),
    /append-only/);
  assert.throws(() => db.prepare("UPDATE application_submission_attempts SET outcome='failed' WHERE attempt_id=?").run('attempt-1'),
    /immutable/);
});

test('the approval expiry boundary is exact, and lateness beats every other fence', (t) => {
  const { db, home } = fixture(t);
  // approve() stamps approvedAt 12:01:00; a 60s TTL expires at 12:02:00.
  approve(db, home, {}, { ttlMs: 60_000 });
  const at = (iso) => () => iso;

  // One millisecond before expiry the approval still works…
  const claimed = claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-early' },
    { home, now: at('2026-08-06T12:01:59.999Z') });
  assert.equal(claimed.attemptId, 'attempt-early');
  settleSubmissionAttempt(db, { attemptId: 'attempt-early', outcome: 'failed' }, { now: at('2026-08-06T12:01:59.999Z') });

  // …and one millisecond after it, nothing does.
  assert.throws(() => claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-late' },
    { home, now: at('2026-08-06T12:02:00.001Z') }), (error) => error.code === 'APPROVAL_EXPIRED');

  // Lateness is checked before the intent even matters: a drifted intent on
  // an expired approval still reads as expired, so an agent is told the
  // cheapest true thing first.
  db.prepare('UPDATE application_submission_intents SET intent_digest=? WHERE intent_id=?')
    .run('c'.repeat(64), 'intent-1');
  assert.throws(() => claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-later' },
    { home, now: at('2026-08-06T14:00:00.000Z') }), (error) => error.code === 'APPROVAL_EXPIRED');
});

test('a tampered approval authorizes nothing', (t) => {
  const { db, home } = fixture(t);
  approve(db, home);
  db.prepare('UPDATE application_submission_approvals SET signature=? WHERE approval_id=?')
    .run(Buffer.from('forged-signature-bytes-for-the-test').toString('base64'), 'approval-1');
  assert.throws(() => claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-1' }, { home, now: AT }),
    (error) => error.code === 'APPROVAL_SIGNATURE_INVALID');
});

test('an intent that drifts after approval voids it', (t) => {
  const { db, home } = fixture(t);
  approve(db, home);
  db.prepare('UPDATE application_submission_intents SET intent_digest=? WHERE intent_id=?')
    .run('c'.repeat(64), 'intent-1');
  assert.throws(() => claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-1' }, { home, now: AT }),
    (error) => error.code === 'INTENT_DRIFTED');
});

test('readSubmissionState answers the only question a caller has', (t) => {
  const { db, home } = fixture(t);
  assert.equal(readSubmissionState(db, 1).maySubmit, true, 'nothing proposed yet');
  approve(db, home);
  assert.equal(readSubmissionState(db, 1).maySubmit, true, 'approved but not attempted');
  claimSubmissionAttempt(db, { approvalId: 'approval-1', attemptId: 'attempt-1' }, { home, now: () => '2026-08-06T12:02:00.000Z' });
  assert.equal(readSubmissionState(db, 1).maySubmit, false, 'an in-flight attempt fences');
});
