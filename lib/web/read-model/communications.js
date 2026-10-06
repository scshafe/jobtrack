'use strict';

// The communications read models: both outgoing lanes, collapsed to metadata.
//
// v2 (`job_email_outgoing_proposals_v3` and its satellites) is the lane that
// runs — every real send goes through it — so it is the primary projection.
// v1 (`job_email_reply_draft_proposals` et al.) is frozen dry-run history and
// renders only when rows exist. The lanes share no tables (docs/EMAIL_LANES.md),
// so the two projections never join across each other.
//
// The collapse discipline is identical for both lanes and is pinned by
// test/reply-lifecycle-web.test.js and test/email-outgoing-v2-cli.test.js:
// recipients appear as a domain only, approvers as a KIND ('human'/'policy')
// only — never an id, address, or signer identity — artifacts as truncated
// digests, and no draft prose, subject lines, rejection reasons, or provider
// payloads ever enter the projection. Exact-content review stays CLI-only.

const { getDb, tableExists } = require('../store');
const { readReplyLifecycleSummary } = require('../../email-draft-reply');

const OUTGOING_PROPOSAL_LIMIT = 500;

const V2_TABLES = [
  'job_email_outgoing_proposals_v3',
  'job_email_outgoing_review_events',
  'job_email_approval_receipts_v2',
  'job_email_send_requests_v2',
  'job_email_send_receipt_correlations_v2',
  'job_email_outgoing_invalidation_events',
  'job_email_message_refs'
];

function readCommunicationsModel() {
  const db = getDb();
  return {
    v2: readOutgoingLifecycleV2(db),
    v1: readV1ReplyLifecycle(db)
  };
}

// ---------------------------------------------------------------------------
// v2: the live lane.
// ---------------------------------------------------------------------------

function readOutgoingLifecycleV2(db, options = {}) {
  if (!V2_TABLES.every((table) => tableExists(db, table))) {
    return { available: false, counts: null, lifecycle: [] };
  }
  const limit = Math.min(
    Number.isInteger(options.limit) && options.limit > 0 ? options.limit : OUTGOING_PROPOSAL_LIMIT,
    OUTGOING_PROPOSAL_LIMIT
  );

  const proposals = db.prepare(`
    SELECT
      proposal.proposal_id     AS proposalId,
      proposal.message_ref_id  AS messageRefId,
      proposal.proposal_digest AS proposalDigest,
      proposal.recipient       AS recipientAddress,
      proposal.expires_at      AS proposalExpiresAt,
      proposal.created_at      AS draftedAt,
      ref.provider             AS provider,
      ref.thread_id            AS threadId,
      ref.from_domain          AS senderDomain
    FROM job_email_outgoing_proposals_v3 proposal
    JOIN job_email_message_refs ref ON ref.id=proposal.message_ref_id
    ORDER BY proposal.created_at DESC, proposal.rowid DESC
    LIMIT ?
  `).all(limit);

  const satellites = loadV2Satellites(db);
  const applicationCache = new Map();
  const counts = emptyV2Counts();
  const lifecycle = proposals.map((proposal) => projectV2Proposal(db, proposal, satellites, applicationCache, counts));
  return { available: true, counts, lifecycle };
}

// The workspace's per-application slice of the same projection, plus the
// approval-policy mode that governs this application.
function readApplicationOutgoingSummary(db, applicationId) {
  if (!V2_TABLES.every((table) => tableExists(db, table))) return null;
  const refIds = linkedMessageRefIds(db, applicationId);
  const policy = approvalPolicyMode(db, applicationId);
  if (!refIds.length) return { policy, counts: emptyV2Counts(), proposals: [] };

  const placeholders = refIds.map(() => '?').join(',');
  const proposals = db.prepare(`
    SELECT
      proposal.proposal_id     AS proposalId,
      proposal.message_ref_id  AS messageRefId,
      proposal.proposal_digest AS proposalDigest,
      proposal.recipient       AS recipientAddress,
      proposal.expires_at      AS proposalExpiresAt,
      proposal.created_at      AS draftedAt,
      ref.provider             AS provider,
      ref.thread_id            AS threadId,
      ref.from_domain          AS senderDomain
    FROM job_email_outgoing_proposals_v3 proposal
    JOIN job_email_message_refs ref ON ref.id=proposal.message_ref_id
    WHERE proposal.message_ref_id IN (${placeholders})
    ORDER BY proposal.created_at DESC, proposal.rowid DESC
    LIMIT ?
  `).all(...refIds, OUTGOING_PROPOSAL_LIMIT);

  const satellites = loadV2Satellites(db);
  const counts = emptyV2Counts();
  const projected = proposals.map((proposal) => {
    const item = projectV2Proposal(db, proposal, satellites, new Map(), counts);
    // The workspace already IS the application; drop the register echo.
    return { ...item, application: undefined };
  });
  return { policy, counts, proposals: projected };
}

function emptyV2Counts() {
  return {
    proposals: 0, awaitingReview: 0,
    approved: 0, approvedByPolicy: 0, approvedByHuman: 0,
    rejected: 0, invalidated: 0,
    sendRequests: 0, sent: 0, duplicate: 0, failed: 0, indeterminate: 0
  };
}

function loadV2Satellites(db) {
  // Latest terminal review per proposal (the lane guards a sole terminal
  // review, so "latest" is defensive, not semantic).
  const reviewByProposal = new Map();
  for (const row of db.prepare(`
    SELECT proposal_id AS proposalId, decision,
      json_extract(decision_json,'$.approver.kind') AS approverKind,
      decided_at AS decidedAt
    FROM job_email_outgoing_review_events
    ORDER BY decided_at DESC, rowid DESC
  `).all()) {
    if (!reviewByProposal.has(row.proposalId)) reviewByProposal.set(row.proposalId, row);
  }

  const approvalByProposal = new Map();
  for (const row of db.prepare(`
    SELECT proposal_id AS proposalId, approval_id AS approvalId,
      approval_digest AS approvalDigest, approved_at AS approvedAt, expires_at AS expiresAt
    FROM job_email_approval_receipts_v2
  `).all()) approvalByProposal.set(row.proposalId, row);

  const contentDigestByProposal = new Map();
  if (tableExists(db, 'job_email_approved_contents_v1')) {
    for (const row of db.prepare(`
      SELECT proposal_id AS proposalId, content_digest AS contentDigest
      FROM job_email_approved_contents_v1
    `).all()) contentDigestByProposal.set(row.proposalId, row.contentDigest);
  }

  const invalidationByApproval = new Map();
  for (const row of db.prepare(`
    SELECT approval_id AS approvalId, reason, invalidated_at AS invalidatedAt
    FROM job_email_outgoing_invalidation_events
    ORDER BY invalidated_at DESC, rowid DESC
  `).all()) {
    if (!invalidationByApproval.has(row.approvalId)) invalidationByApproval.set(row.approvalId, row);
  }

  const sendByProposal = new Map();
  for (const row of db.prepare(`
    SELECT proposal_id AS proposalId, request_id AS requestId,
      request_digest AS requestDigest, requested_at AS requestedAt
    FROM job_email_send_requests_v2
  `).all()) sendByProposal.set(row.proposalId, row);

  // Latest receipt per send request; a request can carry several attempts
  // (failed -> sent, indeterminate -> resolved), so the newest one is the
  // current word on what happened.
  const receiptByRequest = new Map();
  const attemptCountByRequest = new Map();
  for (const row of db.prepare(`
    SELECT send_request_id AS requestId, receipt_id AS receiptId,
      outcome, classification, receipt_digest AS receiptDigest,
      (json_extract(receipt_json,'$.providerMessageId') IS NOT NULL) AS hasProviderMessageId,
      observed_at AS observedAt
    FROM job_email_send_receipt_correlations_v2
    ORDER BY observed_at DESC, rowid DESC
  `).all()) {
    attemptCountByRequest.set(row.requestId, (attemptCountByRequest.get(row.requestId) || 0) + 1);
    if (!receiptByRequest.has(row.requestId)) receiptByRequest.set(row.requestId, row);
  }

  return { reviewByProposal, approvalByProposal, contentDigestByProposal, invalidationByApproval, sendByProposal, receiptByRequest, attemptCountByRequest };
}

function projectV2Proposal(db, proposal, satellites, applicationCache, counts) {
  const review = satellites.reviewByProposal.get(proposal.proposalId) || null;
  const approval = satellites.approvalByProposal.get(proposal.proposalId) || null;
  const invalidation = approval ? satellites.invalidationByApproval.get(approval.approvalId) || null : null;
  const send = satellites.sendByProposal.get(proposal.proposalId) || null;
  const receipt = send ? satellites.receiptByRequest.get(send.requestId) || null : null;
  const attempts = send ? satellites.attemptCountByRequest.get(send.requestId) || 0 : 0;

  const approverKind = review && (review.approverKind === 'policy' || review.approverKind === 'human')
    ? review.approverKind
    : null;
  const state = deriveOutgoingState({
    decision: review ? review.decision : null,
    invalidated: Boolean(invalidation),
    hasSendRequest: Boolean(send),
    receiptOutcome: receipt ? receipt.outcome : null
  });

  counts.proposals += 1;
  if (!review) counts.awaitingReview += 1;
  if (review && review.decision === 'approve') {
    counts.approved += 1;
    if (approverKind === 'policy') counts.approvedByPolicy += 1;
    if (approverKind === 'human') counts.approvedByHuman += 1;
  }
  if (review && review.decision === 'reject') counts.rejected += 1;
  if (invalidation) counts.invalidated += 1;
  if (send) counts.sendRequests += 1;
  if (receipt) {
    if (receipt.outcome === 'sent') counts.sent += 1;
    if (receipt.outcome === 'duplicate') counts.duplicate += 1;
    if (receipt.outcome === 'failed') counts.failed += 1;
    if (receipt.outcome === 'indeterminate') counts.indeterminate += 1;
  }

  return {
    proposalId: proposal.proposalId,
    state,
    thread: {
      threadId: proposal.threadId,
      provider: proposal.provider,
      senderDomain: proposal.senderDomain || null
    },
    recipientDomain: addressDomain(proposal.recipientAddress),
    application: resolveLinkedApplication(db, proposal.messageRefId, applicationCache),
    review: review ? { decision: review.decision, approverKind, decidedAt: review.decidedAt } : null,
    approval: approval
      ? {
          approvalId: approval.approvalId,
          approvedAt: approval.approvedAt,
          expiresAt: approval.expiresAt,
          invalidated: Boolean(invalidation),
          invalidationReason: invalidation ? invalidation.reason : null,
          invalidatedAt: invalidation ? invalidation.invalidatedAt : null
        }
      : null,
    send: send ? { requestId: send.requestId, requestedAt: send.requestedAt } : null,
    receipt: receipt
      ? {
          receiptId: receipt.receiptId,
          outcome: receipt.outcome,
          classification: receipt.classification,
          hasProviderMessageId: Boolean(receipt.hasProviderMessageId),
          attempts,
          observedAt: receipt.observedAt
        }
      : null,
    digests: {
      proposalDigest: proposal.proposalDigest,
      contentDigest: satellites.contentDigestByProposal.get(proposal.proposalId) || null,
      approvalDigest: approval ? approval.approvalDigest : null,
      requestDigest: send ? send.requestDigest : null,
      receiptDigest: receipt ? receipt.receiptDigest : null
    },
    timestamps: {
      draftedAt: proposal.draftedAt,
      decidedAt: review ? review.decidedAt : null,
      requestedAt: send ? send.requestedAt : null,
      observedAt: receipt ? receipt.observedAt : null,
      proposalExpiresAt: proposal.proposalExpiresAt
    }
  };
}

// Receipt outcome outranks everything (it is what actually happened on the
// wire); then the claim chain in reverse order of authority.
function deriveOutgoingState({ decision, invalidated, hasSendRequest, receiptOutcome }) {
  if (receiptOutcome === 'sent') return 'sent';
  if (receiptOutcome === 'duplicate') return 'send-duplicate';
  if (receiptOutcome === 'failed') return 'send-failed';
  if (receiptOutcome === 'indeterminate') return 'send-indeterminate';
  if (hasSendRequest) return 'send-requested';
  if (invalidated) return 'approval-invalidated';
  if (decision === 'approve') return 'approved';
  if (decision === 'reject') return 'rejected';
  return 'draft-recorded';
}

// Application register: the correlation lane's `linked` resolution is the
// authoritative binding; a reviewed application link is the fallback.
function resolveLinkedApplication(db, messageRefId, cache) {
  if (messageRefId === null || messageRefId === undefined) return null;
  if (cache.has(messageRefId)) return cache.get(messageRefId);
  let applicationId = null;
  const correlationSource = activeCorrelationSource(db);
  if (correlationSource) {
    const row = db.prepare(`
      SELECT correlation.resolved_application_id AS id FROM ${correlationSource} correlation
      WHERE correlation.message_ref_id=? AND correlation.resolution='linked'
        AND correlation.resolved_application_id IS NOT NULL
      ORDER BY correlation.id DESC LIMIT 1
    `).get(messageRefId);
    if (row) applicationId = row.id;
  }
  const linkSource = activeApplicationLinkSource(db);
  if (applicationId === null && linkSource) {
    const row = db.prepare(`
      SELECT link.application_id AS id FROM ${linkSource} link
      WHERE link.message_ref_id=? ORDER BY link.id DESC LIMIT 1
    `).get(messageRefId);
    if (row) applicationId = row.id;
  }
  let label = null;
  if (applicationId !== null) {
    const app = db.prepare('SELECT id, company, role, status FROM applications WHERE id=?').get(applicationId) || null;
    label = app ? { id: app.id, company: app.company, role: app.role, status: app.status } : null;
  }
  cache.set(messageRefId, label);
  return label;
}

function linkedMessageRefIds(db, applicationId) {
  const ids = new Set();
  const correlationSource = activeCorrelationSource(db);
  if (correlationSource) {
    for (const row of db.prepare(`
      SELECT DISTINCT message_ref_id AS id FROM ${correlationSource}
      WHERE resolution='linked' AND resolved_application_id=?
    `).all(applicationId)) ids.add(row.id);
  }
  const linkSource = activeApplicationLinkSource(db);
  if (linkSource) {
    for (const row of db.prepare(`
      SELECT DISTINCT message_ref_id AS id FROM ${linkSource}
      WHERE application_id=?
    `).all(applicationId)) ids.add(row.id);
  }
  return [...ids];
}

function relationExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name));
}

function activeCorrelationSource(db) {
  if (relationExists(db, 'active_job_email_linked_correlations')) return 'active_job_email_linked_correlations';
  return relationExists(db, 'job_email_correlations') ? 'job_email_correlations' : null;
}

function activeApplicationLinkSource(db) {
  if (relationExists(db, 'active_job_email_application_links')) return 'active_job_email_application_links';
  return relationExists(db, 'job_email_application_links') ? 'job_email_application_links' : null;
}

// Mirrors lib/email-auto-approval.js approvalPolicyFor: no override row means
// the DEFAULT policy (auto) governs.
function approvalPolicyMode(db, applicationId) {
  if (!tableExists(db, 'job_email_approval_policy')) return { mode: 'auto', source: 'default' };
  const row = db.prepare('SELECT mode FROM job_email_approval_policy WHERE application_id=?').get(applicationId);
  return row ? { mode: row.mode, source: 'override' } : { mode: 'auto', source: 'default' };
}

function addressDomain(address) {
  if (typeof address !== 'string') return null;
  const at = address.lastIndexOf('@');
  return at > 0 && at < address.length - 1 ? address.slice(at + 1).toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// v1: frozen dry-run history.
// ---------------------------------------------------------------------------

function readV1ReplyLifecycle(db) {
  const summary = readReplyLifecycleSummary(db);
  if (!summary) return { available: false, counts: null, lifecycle: [] };
  return { available: true, ...summary };
}

module.exports = {
  readCommunicationsModel,
  readOutgoingLifecycleV2,
  readApplicationOutgoingSummary,
  readV1ReplyLifecycle
};
