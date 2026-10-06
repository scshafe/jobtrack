'use strict';

// Auto-approval (2026-08-05 directive): default policy 'auto', per-application
// 'manual' override. These tests drive the REAL outgoing-v2 lane end to end —
// draft issue -> draft record -> autoApproveProposal -> createSendRequest —
// so the policy signature is verified by the lane's own Ed25519 attestation
// checks, not by test doubles.

const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');
const { createSendRequest } = require('../lib/email-outgoing-v2');
const { makeStore, seedDraft } = require('../test-support/outgoing-live-seed');
const {
  approvalPolicyFor,
  setApprovalPolicy,
  autoApproveProposal,
  approvalKeyOptions,
  EmailAutoApprovalError
} = require('../lib/email-auto-approval');

test('default policy is auto; per-application override flips to manual', () => {
  const { db } = makeStore();
  assert.deepEqual(approvalPolicyFor(db, undefined), { mode: 'auto', source: 'default' });
  assert.deepEqual(approvalPolicyFor(db, 1), { mode: 'auto', source: 'default' });
  setApprovalPolicy(db, { applicationId: 1, mode: 'manual', setBy: 'test' });
  assert.deepEqual(approvalPolicyFor(db, 1), { mode: 'manual', source: 'override' });
  setApprovalPolicy(db, { applicationId: 1, mode: 'auto', setBy: 'test' });
  assert.deepEqual(approvalPolicyFor(db, 1), { mode: 'auto', source: 'override' });
});

test('auto-approval mints a policy-signed receipt the REAL send lane accepts', () => {
  const { home, db } = makeStore();
  const proposalId = seedDraft(home, db, 'auto-ok');
  const outcome = autoApproveProposal(db, { proposalId, applicationId: 1, home });
  assert.equal(outcome.decision, 'approve');
  assert.equal(outcome.sendAuthority, 'one-send-request-only');
  assert.equal(outcome.approvalReceipt.approver.kind, 'policy', 'the receipt says a policy decided');
  assert.equal(outcome.approvalReceipt.approver.id, 'auto-approval-policy.v1');
  assert.equal(outcome.approvalReceipt.authenticatedChannel.channelId, 'jobtrack-auto-approval-policy.v1');

  // The strongest proof: the lane's own attestation verification accepts the
  // policy signature when minting the one send request.
  let request;
  try {
    request = createSendRequest(db, {
    schemaVersion: 'jobtrack-email-send-request-issue.v1',
    requestId: 'send-req-auto-ok',
    approvalId: outcome.approvalReceipt.approvalId,
    operationIdempotencyKey: 'send-req-auto-ok-op'
  }, { approvalKey: approvalKeyOptions(home) });
  } catch (err) {
    console.error('CLAIM ERRORS:', JSON.stringify(err.details ?? null));
    throw err;
  }
  assert.equal(request.request.recipient, 'recruiter@example.test');
  assert.equal(request.request.approval.approver.kind, 'policy');
});

test('a manual-policy application refuses auto-approval', () => {
  const { home, db } = makeStore();
  setApprovalPolicy(db, { applicationId: 1, mode: 'manual', setBy: 'test' });
  const proposalId = seedDraft(home, db, 'manual-blocked');
  assert.throws(
    () => autoApproveProposal(db, { proposalId, applicationId: 1, home }),
    (err) => err instanceof EmailAutoApprovalError && err.code === 'APPROVAL_POLICY_MANUAL'
  );
});

test('auto-approval is idempotent per proposal', () => {
  const { home, db } = makeStore();
  const proposalId = seedDraft(home, db, 'idem');
  const first = autoApproveProposal(db, { proposalId, applicationId: 1, home });
  const second = autoApproveProposal(db, { proposalId, applicationId: 1, home });
  assert.equal(second.approvalReceipt.approvalId, first.approvalReceipt.approvalId);
});

test('the signing key mints once with 0600 permissions and a pinned fingerprint', () => {
  const { home } = makeStore();
  const options = approvalKeyOptions(home);
  const again = approvalKeyOptions(home);
  assert.equal(options.expectedPublicKeySha256, again.expectedPublicKeySha256, 'stable across loads');
  const file = path.join(home, 'keys', 'approval-signing.v1.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
