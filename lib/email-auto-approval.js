'use strict';

// AUTO-APPROVAL for the outgoing reply lane (operator directive, 2026-08-05):
// the DEFAULT approval mode is 'auto'; a per-application override switches an
// application back to 'manual' (interactive review). Nothing in the lane is
// bypassed — an auto-approval is a real recordReviewDecision call carrying:
//
//   - approver { kind: 'policy', id: 'auto-approval-policy.v1' } — receipts
//     say what decided (the contracts were widened additively for 'policy';
//     a policy never masquerades as a human),
//   - an authenticated channel (kind jobtrack_fixed_command, channelId
//     jobtrack-auto-approval-policy.v1) whose verify re-reads the POLICY at
//     decision time and digest-binds the exact decision context,
//   - a real Ed25519 signer whose keypair is minted once per store at
//     $JOBTRACK_HOME/keys/approval-signing.v1.json (0600) and pinned by the
//     same SPKI-DER sha256 fingerprint the lane verifies.
//
// Digest locks, expiries, sole-positive-review, and one-send-per-approval all
// continue to apply exactly as for a human approval.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { recordReviewDecision, readReviewProjection } = require('./email-outgoing-v2');
const { digestCanonicalJson } = require('./email-outgoing-v2-contracts');
const { ensureSigningKey, signingKeyOptions } = require('./signing-keys');

const DEFAULT_MODE = 'auto';
const POLICY_ACTOR = 'auto-approval-policy.v1';
const CHANNEL_ID = 'jobtrack-auto-approval-policy.v1';
const KEY_ID = 'jobtrack-auto-approval-ed25519.v1';
const APPROVAL_TTL_MS = 2 * 60 * 60 * 1000;

class EmailAutoApprovalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmailAutoApprovalError';
    this.code = code;
  }
}

function migrateApprovalPolicy(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS job_email_approval_policy (
    application_id INTEGER PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('auto','manual')),
    set_by TEXT NOT NULL,
    set_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

/** The effective mode for an application (absent row / absent id => default).
 *  JOBTRACK_APPROVAL_DEFAULT=manual flips the code default fleet-wide. */
function approvalPolicyFor(db, applicationId) {
  const fallback = process.env.JOBTRACK_APPROVAL_DEFAULT === 'manual' ? 'manual' : DEFAULT_MODE;
  if (applicationId === undefined || applicationId === null) {
    return { mode: fallback, source: 'default' };
  }
  const row = db.prepare('SELECT mode FROM job_email_approval_policy WHERE application_id=?').get(applicationId);
  return row ? { mode: row.mode, source: 'override' } : { mode: fallback, source: 'default' };
}

function proposalApprovalPolicy(db, proposalId, applicationId) {
  const hasClarifications = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_clarifications'").get();
  const clarification = hasClarifications
    ? db.prepare('SELECT candidate_application_ids_json FROM email_clarifications WHERE outgoing_proposal_id=?').get(proposalId)
    : null;
  if (!clarification) return approvalPolicyFor(db, applicationId);
  let candidates;
  try { candidates = JSON.parse(clarification.candidate_application_ids_json); } catch { /* fail closed below */ }
  if (!Array.isArray(candidates) || candidates.length < 2
    || candidates.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new EmailAutoApprovalError('CLARIFICATION_POLICY_INVALID', 'Clarification candidate policy scope is corrupt');
  }
  // Before the sender identifies the role, every frozen candidate owns this
  // question. Choosing one candidate (or omitting it) cannot evade another's
  // manual override. A supplied additional application's policy also still wins.
  if (applicationId !== undefined && applicationId !== null) candidates.push(applicationId);
  const manual = candidates.find((id) => approvalPolicyFor(db, id).mode !== 'auto');
  return manual === undefined ? { mode: 'auto', source: 'clarification-candidates' }
    : { mode: 'manual', source: `clarification-candidate-${manual}` };
}

function setApprovalPolicy(db, { applicationId, mode, setBy }) {
  if (!['auto', 'manual'].includes(mode)) {
    throw new EmailAutoApprovalError('INVALID_MODE', 'mode must be auto or manual');
  }
  const application = db.prepare('SELECT id FROM applications WHERE id=?').get(applicationId);
  if (!application) throw new EmailAutoApprovalError('APPLICATION_NOT_FOUND', `Application ${applicationId} not found`);
  db.prepare(`INSERT INTO job_email_approval_policy(application_id, mode, set_by)
    VALUES (?,?,?)
    ON CONFLICT(application_id) DO UPDATE SET mode=excluded.mode, set_by=excluded.set_by, set_at=datetime('now')`)
    .run(applicationId, mode, setBy || 'operator');
  return { applicationId, mode, source: 'override' };
}

/** Mint (once) or load the store's approval signing keypair. */
function ensureApprovalSigningKey(home) {
  return ensureSigningKey(home, { fileName: 'approval-signing.v1.json', keyId: KEY_ID });
}

function shortDigest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

/**
 * Auto-approve one rendered proposal per the policy. The caller supplies the
 * applicationId it believes the proposal belongs to (applysim's bridge knows
 * it exactly); with none supplied, the DEFAULT policy governs.
 */
function autoApproveProposal(db, { proposalId, applicationId, home, now }) {
  if (typeof proposalId !== 'string' || proposalId.length === 0) {
    throw new EmailAutoApprovalError('INVALID_INPUT', '--proposal-id is required');
  }
  const storeHome = home || path.dirname(db.name);
  const clock = now || (() => new Date().toISOString());

  const policy = proposalApprovalPolicy(db, proposalId, applicationId);
  if (policy.mode !== 'auto') {
    throw new EmailAutoApprovalError('APPROVAL_POLICY_MANUAL',
      `Application ${applicationId} requires manual review (policy ${policy.source}); refusing to auto-approve`);
  }

  // Replay-idempotent at the semantic level: a proposal approves once. The
  // lane's idempotentWrite cannot serve replays here because each attempt
  // reads a fresh clock (decidedAt differs), so return the stored receipt.
  const existing = db.prepare('SELECT approval_json, approval_digest FROM job_email_approval_receipts_v2 WHERE proposal_id=?').get(proposalId);
  if (existing) {
    return {
      reviewId: null,
      decision: 'approve',
      approvalReceipt: JSON.parse(existing.approval_json),
      approvalDigest: existing.approval_digest,
      sendAuthority: 'one-send-request-only',
      reused: true
    };
  }

  const projection = readReviewProjection(db, proposalId);
  const decidedAt = clock();
  const proposalExpiryMs = Date.parse(projection.proposal.expiresAt);
  const expiresAt = new Date(Math.min(Date.parse(decidedAt) + APPROVAL_TTL_MS, proposalExpiryMs)).toISOString();

  const tag = shortDigest(proposalId);
  const reviewId = `auto-review-${tag}`;
  const approvalId = `auto-approval-${tag}`;
  const approver = { kind: 'policy', id: POLICY_ACTOR };
  const approvalIntent = { approvalId, idempotencyKey: `${approvalId}-once`, expiresAt };

  // Mirror of the lane's channelContext, digest-bound into the channel. The
  // canonical digest sorts keys, so construction order is irrelevant.
  const context = {
    schemaVersion: 'jobtrack-email-authenticated-review-context.v1',
    reviewId,
    proposalId,
    decision: 'approve',
    approver,
    decidedAt,
    expectedProjectionDigest: projection.projectionDigest,
    expectedApprovedContentDigest: projection.approvedContentDigest,
    approvalIntent
  };
  const authenticatedChannel = {
    kind: 'jobtrack_fixed_command',
    channelId: CHANNEL_ID,
    authenticated: true,
    authenticationReceiptDigest: digestCanonicalJson(context)
  };

  const key = ensureApprovalSigningKey(storeHome);
  const privateKey = crypto.createPrivateKey(key.privateKeyPem);

  return recordReviewDecision(db, {
    schemaVersion: 'jobtrack-email-outgoing-review-decision.v1',
    reviewId,
    proposalId,
    decision: 'approve',
    approver,
    decidedAt,
    expectedProjectionDigest: projection.projectionDigest,
    expectedApprovedContentDigest: projection.approvedContentDigest,
    authenticatedChannel,
    operationIdempotencyKey: `${approvalId}-op`,
    approval: approvalIntent
  }, {
    approvalChannel: {
      verify: (channel, verifyContext) =>
        channel.kind === 'jobtrack_fixed_command'
        && channel.channelId === CHANNEL_ID
        && channel.authenticationReceiptDigest === digestCanonicalJson(verifyContext)
        // The policy is re-read at decision time: a manual override that
        // landed between drafting and approval wins.
        && proposalApprovalPolicy(db, proposalId, applicationId).mode === 'auto'
    },
    signer: {
      keyRef: key.file,
      keyId: key.keyId,
      signerIdentity: POLICY_ACTOR,
      sign: (bytes) => crypto.sign(null, bytes, privateKey)
    },
    approvalKey: {
      expectedKeyId: key.keyId,
      expectedPublicKeySha256: key.publicKeySha256,
      resolvePublicKey: () => key.publicKeyPem
    }
  });
}

/** The key material the send executor needs to re-verify the approval. */
function approvalKeyOptions(home) {
  return signingKeyOptions(ensureApprovalSigningKey(home));
}

module.exports = {
  EmailAutoApprovalError,
  migrateApprovalPolicy,
  approvalPolicyFor,
  setApprovalPolicy,
  ensureApprovalSigningKey,
  approvalKeyOptions,
  autoApproveProposal
};
