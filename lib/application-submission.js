'use strict';

// The APPLICATION-SUBMISSION lane: approval-bound authority to submit one
// application, and the reconciliation fence that stands between an ambiguous
// outcome and a duplicate submission.
//
// This is the v2 EMAIL lane's design, applied to a second outward-facing act.
// The research arrived at the same requirements independently — an approval
// bound to the exact company, job, normalized answer set, document hashes,
// expiration, and one landed submission — which is exactly what
// lib/email-outgoing-v2.js already enforces for a send. So the shape is
// deliberately mirrored rather than reinvented:
//
//   propose  -> a submission INTENT digesting the exact answers + documents
//   approve  -> an Ed25519-signed approval receipt binding that exact digest,
//               with a stable one-submit idempotency key and an expiry
//   claim    -> one attempt at a time; another is allowed only after a
//               definitive non-landed settlement
//   settle   -> the attempt's outcome is recorded; one landed submission
//               spends the approval permanently
//
// The fences, in the order they bite:
//   1. an approval covers ONE intent digest — edit an answer and it is void;
//   2. an approval yields ONE active attempt at a time (a concurrent second
//      claim is refused, not queued); definitive failed/rejected evidence may
//      free it for another attempt;
//   3. an UNSETTLED attempt CANNOT be re-claimed until it is reconciled —
//      this is the "never retry until reconciliation proves the original did
//      not commit" rule, enforced structurally rather than by convention;
//   4. an expired approval submits nothing.
//
// Nothing here performs network I/O. Submitting is somebody else's job; this
// module decides whether they may, and records what happened.

const crypto = require('node:crypto');
const { digestCanonicalJson, publicKeyFingerprint } = require('./email-outgoing-v2-contracts');
const { ensureSigningKey, signingKeyOptions } = require('./signing-keys');

const SUBMISSION_SCHEMA_VERSION = 2026080601;
const INTENT_SCHEMA = 'jobtrack-application-submission-intent.v1';
const APPROVAL_SCHEMA = 'jobtrack-application-submission-approval.v1';
const RECEIPT_SCHEMA = 'jobtrack-application-submission-receipt.v1';
const SIGNING_IDENTITY = { fileName: 'application-submission-approval.json', keyId: 'application-submission-approval-v1' };
const APPROVAL_TTL_MS = 60 * 60 * 1000;

const OUTCOMES = new Set(['accepted', 'rejected', 'duplicate', 'failed', 'indeterminate']);
/** Outcomes that mean the submission LANDED. A spent approval never re-claims. */
const LANDED = new Set(['accepted', 'duplicate']);

class SubmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SubmissionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SubmissionError(code, message);
}

function migrateApplicationSubmissions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobtrack_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  if (db.prepare('SELECT 1 FROM jobtrack_schema_migrations WHERE version = ?').get(SUBMISSION_SCHEMA_VERSION)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS application_submission_intents (
      intent_id TEXT PRIMARY KEY,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      surface_id TEXT NOT NULL,
      intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
      intent_digest TEXT NOT NULL UNIQUE CHECK (length(intent_digest)=64),
      answers_digest TEXT NOT NULL CHECK (length(answers_digest)=64),
      documents_digest TEXT NOT NULL CHECK (length(documents_digest)=64),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS application_submission_approvals (
      approval_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL UNIQUE REFERENCES application_submission_intents(intent_id) ON DELETE RESTRICT,
      intent_digest TEXT NOT NULL CHECK (length(intent_digest)=64),
      approver_kind TEXT NOT NULL CHECK (approver_kind IN ('human','policy')),
      approver_id TEXT NOT NULL,
      approval_json TEXT NOT NULL CHECK (json_valid(approval_json)),
      approval_digest TEXT NOT NULL UNIQUE CHECK (length(approval_digest)=64),
      one_submit_idempotency_key TEXT NOT NULL UNIQUE,
      key_id TEXT NOT NULL,
      public_key_sha256 TEXT NOT NULL CHECK (length(public_key_sha256)=64),
      signature TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS application_submission_attempts (
      attempt_id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL REFERENCES application_submission_approvals(approval_id) ON DELETE RESTRICT,
      intent_digest TEXT NOT NULL CHECK (length(intent_digest)=64),
      claimed_at TEXT NOT NULL,
      settled_at TEXT,
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('accepted','rejected','duplicate','failed','indeterminate')),
      external_reference TEXT,
      evidence_digest TEXT CHECK (evidence_digest IS NULL OR length(evidence_digest)=64),
      CHECK ((settled_at IS NULL) = (outcome IS NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_submission_attempts_approval
      ON application_submission_attempts(approval_id, claimed_at);

    CREATE TRIGGER IF NOT EXISTS trg_submission_attempt_immutable_delete
    BEFORE DELETE ON application_submission_attempts
    BEGIN SELECT RAISE(ABORT, 'submission attempts are append-only'); END;

    CREATE TRIGGER IF NOT EXISTS trg_submission_attempt_settle_once
    BEFORE UPDATE OF outcome, settled_at ON application_submission_attempts
    WHEN OLD.outcome IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'a settled submission attempt is immutable'); END;
  `);
  db.prepare(`
    INSERT INTO jobtrack_schema_migrations (version, name)
    VALUES (?, 'application_submission_approvals')
  `).run(SUBMISSION_SCHEMA_VERSION);
}

/**
 * Record the exact thing an agent proposes to submit. The intent digest binds
 * the company, the job, the normalized answers, and the document hashes —
 * change any of them and the approval that covered it no longer applies.
 */
function proposeSubmission(db, input, deps = {}) {
  migrateApplicationSubmissions(db);
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const applicationId = requiredInt(input.applicationId, 'applicationId');
  const application = db.prepare('SELECT id, company, role FROM applications WHERE id=?').get(applicationId);
  if (!application) fail('APPLICATION_NOT_FOUND', `Application ${applicationId} not found`);
  const surfaceId = requiredText(input.surfaceId, 'surfaceId');
  const answers = plainRecord(input.answers, 'answers');
  const documents = plainRecord(input.documents, 'documents');
  for (const [name, digest] of Object.entries(documents)) {
    if (!/^[0-9a-f]{64}$/.test(digest)) fail('INVALID_INPUT', `documents.${name} must be a sha256 hex digest`);
  }

  const answersDigest = digestCanonicalJson(answers);
  const documentsDigest = digestCanonicalJson(documents);
  const intent = {
    schemaVersion: INTENT_SCHEMA,
    intentId: requiredText(input.intentId, 'intentId'),
    applicationId,
    company: application.company,
    role: application.role,
    surfaceId,
    answersDigest,
    documentsDigest,
    createdAt: now
  };
  const intentDigest = digestCanonicalJson(intent);

  const existing = db.prepare('SELECT * FROM application_submission_intents WHERE intent_id=?').get(intent.intentId);
  if (existing) {
    // Replay comparison must be time-independent: the same propose re-run a
    // minute later is a reuse, not a conflict. Only createdAt is allowed to
    // differ, so recompute the digest with the STORED timestamp — every
    // semantic field still has to match the recorded intent exactly.
    const stored = JSON.parse(existing.intent_json);
    const replayDigest = digestCanonicalJson({ ...intent, createdAt: stored.createdAt });
    if (existing.intent_digest !== replayDigest) {
      fail('INTENT_CONFLICT', `Intent ${intent.intentId} already exists with different content`);
    }
    return { intent: stored, intentDigest: existing.intent_digest, reused: true };
  }
  db.prepare(`
    INSERT INTO application_submission_intents
      (intent_id, application_id, surface_id, intent_json, intent_digest, answers_digest, documents_digest, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(intent.intentId, applicationId, surfaceId, JSON.stringify(intent), intentDigest, answersDigest, documentsDigest, now);
  return { intent, intentDigest, reused: false };
}

/**
 * Sign an approval for ONE intent digest. `approver.kind` is 'human' or
 * 'policy' — the same additive widening the email lane made, so a policy
 * approval says so rather than masquerading as a person.
 */
function approveSubmission(db, input, deps = {}) {
  migrateApplicationSubmissions(db);
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const intentId = requiredText(input.intentId, 'intentId');
  const row = db.prepare('SELECT * FROM application_submission_intents WHERE intent_id=?').get(intentId);
  if (!row) fail('INTENT_NOT_FOUND', `Intent ${intentId} not found`);
  if (requiredText(input.expectedIntentDigest, 'expectedIntentDigest') !== row.intent_digest) {
    fail('INTENT_DIGEST_MISMATCH', 'The approved intent is not the recorded one; re-propose before approving');
  }
  const approver = plainRecord(input.approver, 'approver');
  if (!['human', 'policy'].includes(approver.kind)) fail('INVALID_INPUT', "approver.kind must be 'human' or 'policy'");
  requiredText(approver.id, 'approver.id');

  const existing = db.prepare('SELECT * FROM application_submission_approvals WHERE intent_id=?').get(intentId);
  if (existing) {
    return { approval: JSON.parse(existing.approval_json), approvalDigest: existing.approval_digest, reused: true };
  }

  const key = ensureSigningKey(requiredText(deps.home ?? input.home, 'home'), SIGNING_IDENTITY);
  const approvalId = requiredText(input.approvalId, 'approvalId');
  const expiresAt = new Date(Date.parse(now) + (deps.ttlMs ?? APPROVAL_TTL_MS)).toISOString();
  const approval = {
    schemaVersion: APPROVAL_SCHEMA,
    approvalId,
    intentId,
    intentDigest: row.intent_digest,
    applicationId: row.application_id,
    surfaceId: row.surface_id,
    answersDigest: row.answers_digest,
    documentsDigest: row.documents_digest,
    approver: { kind: approver.kind, id: approver.id },
    oneSubmitIdempotencyKey: `${approvalId}-once`,
    approvedAt: now,
    expiresAt
  };
  const approvalDigest = digestCanonicalJson(approval);
  const signature = crypto
    .sign(null, Buffer.from(approvalDigest, 'utf8'), crypto.createPrivateKey(key.privateKeyPem))
    .toString('base64');

  db.prepare(`
    INSERT INTO application_submission_approvals
      (approval_id, intent_id, intent_digest, approver_kind, approver_id, approval_json, approval_digest,
       one_submit_idempotency_key, key_id, public_key_sha256, signature, approved_at, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    approvalId, intentId, row.intent_digest, approver.kind, approver.id,
    JSON.stringify(approval), approvalDigest, approval.oneSubmitIdempotencyKey,
    key.keyId, key.publicKeySha256, signature, now, expiresAt
  );
  return { approval, approvalDigest, signature, keyId: key.keyId, reused: false };
}

/**
 * Claim the ONE submission attempt an approval authorizes. Every fence lives
 * here, and the important one is the third: an UNSETTLED attempt blocks a new
 * claim, because a request whose outcome nobody knows may already have
 * created an application. Reconcile it first (settleAttempt) — retrying blind
 * is how duplicates happen.
 */
function claimSubmissionAttempt(db, input, deps = {}) {
  migrateApplicationSubmissions(db);
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const approvalId = requiredText(input.approvalId, 'approvalId');
  const approval = db.prepare('SELECT * FROM application_submission_approvals WHERE approval_id=?').get(approvalId);
  if (!approval) fail('APPROVAL_NOT_FOUND', `Approval ${approvalId} not found`);

  // The approval must still verify against the pinned key: a tampered receipt
  // authorizes nothing.
  const verified = crypto.verify(
    null,
    Buffer.from(approval.approval_digest, 'utf8'),
    crypto.createPublicKey(ensureSigningKey(requiredText(deps.home ?? input.home, 'home'), SIGNING_IDENTITY).publicKeyPem),
    Buffer.from(approval.signature, 'base64')
  );
  if (!verified) fail('APPROVAL_SIGNATURE_INVALID', 'The approval signature does not verify');

  if (Date.parse(now) > Date.parse(approval.expires_at)) {
    fail('APPROVAL_EXPIRED', `Approval ${approvalId} expired at ${approval.expires_at}; re-approve before submitting`);
  }

  // The intent must not have moved under the approval.
  const intent = db.prepare('SELECT intent_digest, application_id FROM application_submission_intents WHERE intent_id=?').get(approval.intent_id);
  if (!intent || intent.intent_digest !== approval.intent_digest) {
    fail('INTENT_DRIFTED', 'The intent changed after approval; re-propose and re-approve');
  }

  const attempts = db.prepare('SELECT * FROM application_submission_attempts WHERE approval_id=? ORDER BY claimed_at, rowid').all(approvalId);
  // Unreconciled means "we do not know whether this landed", and that covers
  // BOTH an unsettled attempt and one honestly settled as indeterminate.
  // Recording that you don't know is not the same as learning it failed, so
  // both fence identically — this is the rule that prevents a duplicate
  // application after an ambiguous outcome.
  const unreconciled = attempts.find((attempt) => attempt.outcome === null || attempt.outcome === 'indeterminate');
  if (unreconciled) {
    fail('ATTEMPT_UNRECONCILED',
      `Attempt ${unreconciled.attempt_id} is unreconciled (${unreconciled.outcome ?? 'no outcome recorded'}): `
      + 'it may already have submitted. Determine what actually happened and settle it definitively; '
      + 'never retry an ambiguous submission.');
  }
  if (attempts.some((attempt) => LANDED.has(attempt.outcome))) {
    fail('APPROVAL_SPENT', `Approval ${approvalId} already produced a landed submission; one approval, one submission`);
  }

  // One application, one landed submission — across EVERY approval, not just
  // this one. A fresh intent + fresh approval must not open a second path to
  // the same destination; the fence lives at the claim, where authority to
  // act is actually issued. (Legitimately reapplying later is a NEW
  // application row, which this does not touch.)
  const applicationLanded = db.prepare(`
    SELECT t.attempt_id, t.outcome FROM application_submission_attempts t
    JOIN application_submission_approvals a ON a.approval_id = t.approval_id
    JOIN application_submission_intents i ON i.intent_id = a.intent_id
    WHERE i.application_id = ? AND t.outcome IN ('accepted','duplicate')
    ORDER BY t.claimed_at, t.rowid LIMIT 1
  `).get(intent.application_id);
  if (applicationLanded) {
    fail('APPLICATION_ALREADY_SUBMITTED',
      `Application ${intent.application_id} already landed a submission via attempt ${applicationLanded.attempt_id} `
      + `(${applicationLanded.outcome}); one application, one submission`);
  }

  const attemptId = requiredText(input.attemptId, 'attemptId');
  db.prepare(`
    INSERT INTO application_submission_attempts (attempt_id, approval_id, intent_digest, claimed_at)
    VALUES (?,?,?,?)
  `).run(attemptId, approvalId, approval.intent_digest, now);
  return {
    attemptId,
    approvalId,
    intentDigest: approval.intent_digest,
    oneSubmitIdempotencyKey: approval.one_submit_idempotency_key,
    priorAttempts: attempts.length
  };
}

/**
 * Record what an attempt turned out to be. This is the reconciliation act:
 * an `indeterminate` settlement is honest and still blocks a retry (nothing
 * was learned); `failed` or `rejected` frees the approval for one more
 * attempt; `accepted` or `duplicate` spends it forever.
 */
function settleSubmissionAttempt(db, input, deps = {}) {
  migrateApplicationSubmissions(db);
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const attemptId = requiredText(input.attemptId, 'attemptId');
  const outcome = requiredText(input.outcome, 'outcome');
  if (!OUTCOMES.has(outcome)) fail('INVALID_INPUT', `outcome must be one of ${[...OUTCOMES].join(', ')}`);

  const attempt = db.prepare('SELECT * FROM application_submission_attempts WHERE attempt_id=?').get(attemptId);
  if (!attempt) fail('ATTEMPT_NOT_FOUND', `Attempt ${attemptId} not found`);
  if (attempt.outcome !== null) {
    if (attempt.outcome !== outcome) fail('ATTEMPT_SETTLED', `Attempt ${attemptId} is already settled as ${attempt.outcome}`);
    return { attemptId, outcome, reused: true };
  }
  // An indeterminate settlement is a RECORD of not knowing, not a resolution:
  // it keeps the approval fenced until something definite is learned.
  const evidenceDigest = input.evidence === undefined ? null : digestCanonicalJson(input.evidence);
  db.prepare(`
    UPDATE application_submission_attempts
    SET settled_at=?, outcome=?, external_reference=?, evidence_digest=?
    WHERE attempt_id=?
  `).run(now, outcome, input.externalReference ?? null, evidenceDigest, attemptId);
  return { attemptId, outcome, evidenceDigest, reused: false };
}

/** The lane's view of one application: what was approved, tried, and landed. */
function readSubmissionState(db, applicationId) {
  migrateApplicationSubmissions(db);
  const intents = db.prepare(`
    SELECT intent_id, intent_digest, surface_id, created_at
    FROM application_submission_intents WHERE application_id=? ORDER BY created_at, rowid
  `).all(applicationId);
  const approvals = db.prepare(`
    SELECT a.approval_id, a.intent_id, a.approver_kind, a.approver_id, a.approved_at, a.expires_at
    FROM application_submission_approvals a
    JOIN application_submission_intents i ON i.intent_id = a.intent_id
    WHERE i.application_id=? ORDER BY a.approved_at, a.rowid
  `).all(applicationId);
  const attempts = db.prepare(`
    SELECT t.attempt_id, t.approval_id, t.claimed_at, t.settled_at, t.outcome, t.external_reference
    FROM application_submission_attempts t
    JOIN application_submission_approvals a ON a.approval_id = t.approval_id
    JOIN application_submission_intents i ON i.intent_id = a.intent_id
    WHERE i.application_id=? ORDER BY t.claimed_at, t.rowid
  `).all(applicationId);
  const landed = attempts.find((attempt) => LANDED.has(attempt.outcome)) ?? null;
  const unreconciled = attempts.find((attempt) => attempt.outcome === null || attempt.outcome === 'indeterminate') ?? null;
  return {
    schemaVersion: RECEIPT_SCHEMA,
    applicationId,
    intents,
    approvals,
    attempts,
    landed,
    unreconciled,
    // The single question a caller actually asks.
    maySubmit: landed === null && unreconciled === null
  };
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail('INVALID_INPUT', `${label} is required`);
  return value;
}

function requiredInt(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail('INVALID_INPUT', `${label} must be a positive integer`);
  return parsed;
}

function plainRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_INPUT', `${label} must be a plain object`);
  }
  return value;
}

module.exports = {
  APPROVAL_SCHEMA,
  INTENT_SCHEMA,
  SUBMISSION_SCHEMA_VERSION,
  SubmissionError,
  approveSubmission,
  claimSubmissionAttempt,
  migrateApplicationSubmissions,
  proposeSubmission,
  readSubmissionState,
  settleSubmissionAttempt,
  signingKeyOptions
};
