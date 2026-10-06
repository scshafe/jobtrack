'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createTestStore } = require('../test-support/migrated-store');

const {
  validateEmailSendRequest,
  validateApprovalReceipt,
  validateDraftProvenanceReceipt,
  validateUsageReceipt,
  EmailContractError,
  digest
} = require('../lib/email-contracts');
const {
  importFacts,
  buildDraftReplyContext,
  issueDraftReplyRequest,
  recordDraftReplyResult,
  approveDraftReplySend,
  correlateSendReceipt
} = require('../lib/email-integration');
const { digest: contractDigest } = require('../lib/email-contracts');
const { EmailDraftReplyError, FORBIDDEN_EFFECTS } = require('../lib/email-draft-reply');

// Test doubles for the reply state machine collaborators. The full tone/voice/
// style binding that proposeReplyDraft enforces for v2 proposals is exercised
// exhaustively by email-communication.test.js; here we isolate the draft-reply
// request/record/approve machinery. The doubles persist exactly the rows the
// draft-reply approval path reads back (recipient-locked, auto_send_eligible=0).
function fakeProposeReplyDraft(db, proposal, idempotencyKey) {
  const proposalDigest = contractDigest(proposal);
  const message = db.prepare('SELECT id FROM job_email_message_refs WHERE provider=? AND account_id=? AND message_id=?')
    .get(proposal.source.provider, proposal.source.accountId, proposal.source.messageId);
  const existing = db.prepare('SELECT proposal_digest FROM job_email_reply_draft_proposals WHERE proposal_id=?').get(proposal.proposalId);
  if (existing) return { proposalId: proposal.proposalId, proposalDigest, reused: true, autoSendEnabled: false };
  db.prepare(`
    INSERT INTO job_email_reply_draft_proposals (
      proposal_id, message_ref_id, recipient, authorship, requires_review, auto_send_eligible, proposal_json, proposal_digest
    ) VALUES (?,?,?,?,?,0,?,?)
  `).run(proposal.proposalId, message.id, proposal.recipient, proposal.authorship, proposal.requiresReview ? 1 : 0, JSON.stringify(proposal), proposalDigest);
  db.prepare('INSERT INTO job_email_reply_draft_events(proposal_id,event_kind,actor,notes) VALUES (?,?,?,?)')
    .run(proposal.proposalId, 'proposed', 'draft-reply-test', null);
  return { proposalId: proposal.proposalId, proposalDigest, reused: false, autoSendEnabled: false };
}
function fakeReviewReplyDraft(db, flags) {
  db.prepare('INSERT INTO job_email_reply_draft_events(proposal_id,event_kind,actor,notes) VALUES (?,?,?,?)')
    .run(flags.proposalId, flags.decision, flags.decidedBy, null);
  return { proposalId: flags.proposalId, decision: flags.decision, autoSendEnabled: false };
}
const RECORD_DEPS = { proposeReplyDraft: fakeProposeReplyDraft };
const APPROVE_DEPS = { reviewReplyDraft: fakeReviewReplyDraft };

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeStore(t) {
  const { root: dir, home } = createTestStore('jobtrack-draft-reply-');
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

function makeFacts() {
  return {
    schemaVersion: 'job-application-email-facts.v1',
    trust: 'untrusted_external',
    source: {
      provider: 'fixture',
      accountId: 'cole@example.test',
      messageId: 'message-1',
      threadId: 'thread-1',
      receivedAt: '2026-07-17T18:00:00.000Z',
      fromAddress: 'recruiter@acme.example',
      fromDomain: 'acme.example',
      replyToAddress: 'recruiter@acme.example',
      contentDigest: sha256('sanitized source content')
    },
    contentCompleteness: 'sanitized_plain_text',
    eventKind: 'recruiter_followup',
    company: { name: 'Acme', domain: 'acme.example' },
    postingRefs: [{ roleTitle: 'Platform Engineer' }],
    applicationRefs: [],
    replyRequested: true,
    evidence: [{ field: 'subject', excerpt: 'Interview scheduling' }],
    extraction: { provider: 'fixture', version: '1', confidence: 0.95 },
    security: { risk: 'low', requiresReview: false }
  };
}

function makeReplyProposal(facts, sourceStateSha256) {
  const body = 'Thank you for the invitation. Tuesday afternoon works well for me.';
  return {
    schemaVersion: 'email-reply-draft-proposal.v2',
    proposalId: 'draft-reply-1',
    factsDigest: digest(facts),
    source: {
      provider: facts.source.provider,
      accountId: facts.source.accountId,
      messageId: facts.source.messageId,
      threadId: facts.source.threadId,
      replyToAddress: facts.source.replyToAddress
    },
    recipient: facts.source.replyToAddress,
    subject: 'Re: Interview scheduling',
    body,
    bodyDigest: sha256(body),
    purpose: 'scheduling',
    authorship: 'model',
    expiresAt: '2026-08-01T00:00:00.000Z',
    sensitiveDataScan: 'passed',
    toneDecisionId: 'tone-1',
    toneDecisionDigest: sha256('tone'),
    voiceRevisionId: 'voice-1',
    voiceRevisionDigest: sha256('voice'),
    sourceStateSha256,
    registerAdaptationOnly: true,
    distinctivePhraseReuse: false,
    requiresReview: true,
    autoSendEligible: false
  };
}

function makeProvenance(facts, proposal, sourceStateSha256) {
  return {
    schemaVersion: 'draft-provenance-receipt.v1',
    receiptId: 'prov-1',
    draftProposalId: proposal.proposalId,
    draftProposalDigest: digest(proposal),
    factsDigest: digest(facts),
    sourceStateSha256,
    generatedBy: { provider: 'local-ubuntu', model: 'qwen', version: 'draft-reply.v1', routeAlias: 'frontier-default' },
    corpusSources: [
      { kind: 'inbox-facts', digest: digest(facts) },
      { kind: 'inbound-thread', ref: 'thread-1', digest: sha256('thread') }
    ],
    companyResearch: { used: false, brokered: false },
    usage: {
      schemaVersion: 'usage-receipt.v1',
      trust: 'provider_reported',
      observedInputTokens: 1200,
      observedOutputTokens: 340,
      chargedTokens: 1540,
      observedCostMicroUsd: 4200,
      chargedCostMicroUsd: 4200,
      durationMs: 5300,
      routeAlias: 'frontier-default'
    },
    createdAt: '2026-07-19T15:00:00.000Z'
  };
}

const SOURCE = { provider: 'fixture', accountId: 'cole@example.test', messageId: 'message-1', threadId: 'thread-1' };

test('draft-reply context is read-only, recipient-locked, and digest-pinned', (t) => {
  const db = makeStore(t);
  const facts = importFactsHelper(db);
  const context = buildDraftReplyContext(db, SOURCE);
  assert.equal(context.recipient, 'recruiter@acme.example');
  assert.match(context.sourceStateSha256, /^[a-f0-9]{64}$/);
  assert.equal(context.inboundThread.factsDigest, digest(facts));
  // The projection carries only sanitized, inert facts — no body/evidence text.
  assert.equal(context.inboxFacts.eventKind, 'recruiter_followup');
  assert.equal(context.inboxFacts.replyRequested, true);
  assert.ok(!('body' in context.inboxFacts));
  // Building it twice is stable (pure read).
  assert.equal(buildDraftReplyContext(db, SOURCE).sourceStateSha256, context.sourceStateSha256);
});

test('draft-reply issue writes a bounded_internal_request and does NOT execute it', (t) => {
  const db = makeStore(t);
  importFactsHelper(db);
  const context = buildDraftReplyContext(db, SOURCE);
  const result = issueDraftReplyRequest(db, {
    requestId: 'req-1',
    issuedBy: 'Cole',
    expectedSourceStateSha256: context.sourceStateSha256,
    idempotencyKey: 'draft:issue:1',
    source: SOURCE
  });
  assert.equal(result.executed, false);
  assert.equal(result.routeAlias, 'frontier-default');
  const request = result.request;
  assert.equal(request.trust, 'bounded_internal_request');
  assert.equal(request.safety.proposalOnly, true);
  assert.equal(request.safety.externalActionsAllowed, false);
  assert.equal(request.safety.sourceTextIsInertData, true);
  assert.deepEqual(request.safety.forbiddenEffects, [...FORBIDDEN_EFFECTS]);
  assert.ok(request.safety.forbiddenEffects.includes('send-email'));
  assert.equal(request.route.alias, 'frontier-default');
  assert.equal(request.output.contractId, 'email-reply-draft-proposal.v2');
  assert.equal(request.sourceStateSha256, context.sourceStateSha256);
  assert.ok(request.budget.maxInputTokens > 0 && request.budget.maxCostMicros > 0);
  // Persisted request is content-addressed.
  const row = db.prepare('SELECT request_digest FROM job_email_draft_reply_requests WHERE request_id=?').get('req-1');
  assert.equal(row.request_digest, result.requestDigest);
  // Idempotent replay returns the same digest.
  const replay = issueDraftReplyRequest(db, {
    requestId: 'req-1', issuedBy: 'Cole', expectedSourceStateSha256: context.sourceStateSha256,
    idempotencyKey: 'draft:issue:1', source: SOURCE
  });
  assert.equal(replay.requestDigest, result.requestDigest);
});

test('draft-reply issue fails closed on a stale corpus checkpoint', (t) => {
  const db = makeStore(t);
  importFactsHelper(db);
  assert.throws(() => issueDraftReplyRequest(db, {
    requestId: 'req-stale', issuedBy: 'Cole', expectedSourceStateSha256: sha256('stale'),
    idempotencyKey: 'draft:issue:stale', source: SOURCE
  }), (error) => error instanceof EmailDraftReplyError && error.code === 'SOURCE_STATE_STALE');
});

test('draft-reply issue folds budget into the idempotency intent (no silent collision)', (t) => {
  const db = makeStore(t);
  importFactsHelper(db);
  const context = buildDraftReplyContext(db, SOURCE);
  const budgetA = { maxInputTokens: 120000, maxOutputTokens: 4000, maxCostMicros: 2000000, maxDurationMs: 120000 };
  const budgetB = { ...budgetA, maxCostMicros: 9000000 };
  const first = issueDraftReplyRequest(db, {
    requestId: 'req-budget', issuedBy: 'Cole', expectedSourceStateSha256: context.sourceStateSha256,
    idempotencyKey: 'draft:issue:budget', source: SOURCE, budget: budgetA
  });
  assert.equal(first.request.budget.maxCostMicros, 2000000);
  // Same idempotency key + intent but a DIFFERENT budget must NOT dedupe silently
  // to the first (budgetA) result — it is a genuinely different request. Budget is
  // part of the idempotency intent, so this fails closed with a conflict.
  assert.throws(() => issueDraftReplyRequest(db, {
    requestId: 'req-budget', issuedBy: 'Cole', expectedSourceStateSha256: context.sourceStateSha256,
    idempotencyKey: 'draft:issue:budget', source: SOURCE, budget: budgetB
  }), (error) => /IDEMPOTENCY_CONFLICT/.test(error.message) || error.code === 'IDEMPOTENCY_CONFLICT');
  // Exactly one request persisted (the second issue never wrote a row).
  assert.equal(db.prepare('SELECT count(*) count FROM job_email_draft_reply_requests').get().count, 1);
  // A replay with the SAME budget still dedupes idempotently to the same result.
  const replay = issueDraftReplyRequest(db, {
    requestId: 'req-budget', issuedBy: 'Cole', expectedSourceStateSha256: context.sourceStateSha256,
    idempotencyKey: 'draft:issue:budget', source: SOURCE, budget: budgetA
  });
  assert.equal(replay.requestDigest, first.requestDigest);
  assert.equal(db.prepare('SELECT count(*) count FROM job_email_draft_reply_requests').get().count, 1);
});

test('draft-reply record validates the proposal + mandatory provenance receipt with a trust tier', (t) => {
  const db = makeStore(t);
  const facts = importFactsHelper(db);
  const context = buildDraftReplyContext(db, SOURCE);
  issueDraftReplyRequest(db, {
    requestId: 'req-1', issuedBy: 'Cole', expectedSourceStateSha256: context.sourceStateSha256,
    idempotencyKey: 'draft:issue:1', source: SOURCE
  });
  const proposal = makeReplyProposal(facts, context.sourceStateSha256);
  const provenance = makeProvenance(facts, proposal, context.sourceStateSha256);
  const recorded = recordDraftReplyResult(db, { requestId: 'req-1', proposal, provenance }, 'draft:record:1', RECORD_DEPS);
  assert.equal(recorded.proposalId, 'draft-reply-1');
  assert.equal(recorded.usageTrust, 'provider_reported');
  assert.equal(recorded.usageTrustBelowFloor, false);
  assert.equal(recorded.autoSendEnabled, false);
  // The reply proposal is recorded through the existing state machine.
  assert.deepEqual(
    db.prepare('SELECT event_kind FROM job_email_reply_draft_events ORDER BY id').all().map((r) => r.event_kind),
    ['proposed']
  );
  // A below-floor (unavailable) usage receipt is surfaced, not silently accepted.
  const weakProvenance = {
    ...makeProvenance(facts, proposal, context.sourceStateSha256),
    receiptId: 'prov-weak',
    usage: {
      schemaVersion: 'usage-receipt.v1', trust: 'unavailable',
      observedInputTokens: null, observedOutputTokens: null, chargedTokens: 1,
      observedCostMicroUsd: null, chargedCostMicroUsd: 1, durationMs: 100
    }
  };
  // Recording the first draft added a past-communication to this thread, so the
  // read-only corpus projection has legitimately moved; re-pin against it.
  const context2 = buildDraftReplyContext(db, SOURCE);
  assert.notEqual(context2.sourceStateSha256, context.sourceStateSha256);
  issueDraftReplyRequest(db, {
    requestId: 'req-2', issuedBy: 'Cole', expectedSourceStateSha256: context2.sourceStateSha256,
    idempotencyKey: 'draft:issue:2', source: SOURCE
  });
  const proposal2 = { ...makeReplyProposal(facts, context2.sourceStateSha256), proposalId: 'draft-reply-2' };
  const weak = { ...weakProvenance, sourceStateSha256: context2.sourceStateSha256, draftProposalId: 'draft-reply-2', draftProposalDigest: digest(proposal2) };
  const weakResult = recordDraftReplyResult(db, { requestId: 'req-2', proposal: proposal2, provenance: weak }, 'draft:record:2', RECORD_DEPS);
  assert.equal(weakResult.usageTrust, 'unavailable');
  assert.equal(weakResult.usageTrustBelowFloor, true);
});

test('draft-reply record rejects a result bound to a different source state', (t) => {
  const db = makeStore(t);
  const facts = importFactsHelper(db);
  const context = buildDraftReplyContext(db, SOURCE);
  issueDraftReplyRequest(db, {
    requestId: 'req-1', issuedBy: 'Cole', expectedSourceStateSha256: context.sourceStateSha256,
    idempotencyKey: 'draft:issue:1', source: SOURCE
  });
  const proposal = makeReplyProposal(facts, sha256('other-state'));
  const provenance = makeProvenance(facts, proposal, sha256('other-state'));
  assert.throws(
    () => recordDraftReplyResult(db, { requestId: 'req-1', proposal, provenance }, 'draft:record:bad', RECORD_DEPS),
    (error) => error instanceof EmailDraftReplyError && error.code === 'SOURCE_DIGEST_MISMATCH'
  );
});

test('approval binds the exact draft digest and emits email-send-request.v1 to the DRY-RUN sink', (t) => {
  const db = makeStore(t);
  const facts = importFactsHelper(db);
  const context = buildDraftReplyContext(db, SOURCE);
  issueDraftReplyRequest(db, {
    requestId: 'req-1', issuedBy: 'Cole', expectedSourceStateSha256: context.sourceStateSha256,
    idempotencyKey: 'draft:issue:1', source: SOURCE
  });
  const proposal = makeReplyProposal(facts, context.sourceStateSha256);
  const provenance = makeProvenance(facts, proposal, context.sourceStateSha256);
  recordDraftReplyResult(db, { requestId: 'req-1', proposal, provenance }, 'draft:record:1', RECORD_DEPS);
  const proposalDigest = digest(proposal);

  // Approval must bind the exact recorded digest.
  assert.throws(() => approveDraftReplySend(db, {
    proposalId: 'draft-reply-1', expectedProposalDigest: sha256('wrong'),
    approvedBy: 'owner@example.test', idempotencyKey: 'draft:approve:bad'
  }, APPROVE_DEPS), (error) => error instanceof EmailDraftReplyError && error.code === 'PROPOSAL_DIGEST_MISMATCH');

  const approved = approveDraftReplySend(db, {
    proposalId: 'draft-reply-1',
    expectedProposalDigest: proposalDigest,
    approvedBy: 'owner@example.test',
    approvedAt: '2026-07-19T16:00:00.000Z',
    idempotencyKey: 'draft:approve:1'
  }, APPROVE_DEPS);
  assert.equal(approved.delivered, false);
  assert.equal(approved.sink, 'dry-run');
  assert.equal(approved.approvedArtifactDigest, proposalDigest);
  // The reply state machine advanced proposed -> approved.
  assert.deepEqual(
    db.prepare('SELECT event_kind FROM job_email_reply_draft_events ORDER BY id').all().map((r) => r.event_kind),
    ['proposed', 'approved']
  );
  // Exactly one send-request landed in the dry-run sink (and nowhere else).
  const sink = db.prepare('SELECT * FROM job_email_send_request_sink').all();
  assert.equal(sink.length, 1);
  const emitted = validateEmailSendRequest(JSON.parse(sink[0].send_request_json));
  assert.equal(emitted.schemaVersion, 'email-send-request.v1');
  assert.equal(emitted.content.mode, 'draft_artifact');
  // FROZEN v1: content is the draft-artifact digest reference; no bytes inline.
  assert.equal(emitted.content.digest, proposalDigest);
  assert.equal(emitted.approval.approvedArtifactDigest, proposalDigest);
  assert.equal(emitted.recipient, 'recruiter@acme.example');
  assert.equal(emitted.approval.scope.action, 'send-once');
  assert.equal(emitted.approval.approver.kind, 'human');
  validateApprovalReceipt(JSON.parse(sink[0].approval_receipt_json));

  // Idempotent re-approval does not double-emit.
  const replay = approveDraftReplySend(db, {
    proposalId: 'draft-reply-1', expectedProposalDigest: proposalDigest,
    approvedBy: 'owner@example.test', approvedAt: '2026-07-19T16:00:00.000Z', idempotencyKey: 'draft:approve:1'
  }, APPROVE_DEPS);
  assert.equal(replay.sendRequestDigest, approved.sendRequestDigest);
  assert.equal(db.prepare('SELECT count(*) count FROM job_email_send_request_sink').get().count, 1);

  // A returned send receipt correlates back against the exact emitted request.
  const receipt = {
    schemaVersion: 'email-send-receipt.v1',
    receiptId: 'rcpt-1',
    requestId: emitted.requestId,
    idempotencyKey: emitted.idempotencyKey,
    requestDigest: approved.sendRequestDigest,
    status: 'sent',
    provider: 'fixture',
    providerMessageId: 'provider-msg-1',
    observedAt: '2026-07-19T16:05:00.000Z'
  };
  const correlated = correlateSendReceipt(db, receipt);
  assert.equal(correlated.receipt.status, 'sent');
  // Closing the loop: the correlated receipt is PERSISTED append-only against the
  // sink row + proposal + thread (application is null here — the thread was not
  // linked to an application in this fixture).
  assert.equal(correlated.correlation.recorded, true);
  assert.equal(correlated.correlation.applicationId, null);
  assert.equal(correlated.correlation.threadId, 'thread-1');
  const stored = db.prepare('SELECT * FROM job_email_send_receipt_correlations WHERE request_id=?').get(emitted.requestId);
  assert.ok(stored, 'the send receipt must be recorded in the correlation ledger');
  assert.equal(stored.receipt_id, 'rcpt-1');
  assert.equal(stored.proposal_id, 'draft-reply-1');
  assert.equal(stored.thread_id, 'thread-1');
  assert.equal(stored.status, 'sent');
  assert.equal(stored.provider_message_id, 'provider-msg-1');
  // Idempotent replay of the exact same receipt returns the recorded state and
  // does NOT append a second row.
  const replayCorrelate = correlateSendReceipt(db, receipt);
  assert.equal(replayCorrelate.correlation.recorded, false);
  assert.equal(db.prepare('SELECT count(*) count FROM job_email_send_receipt_correlations').get().count, 1);
  // The ledger is append-only: no UPDATE / DELETE is permitted.
  assert.throws(() => db.prepare('UPDATE job_email_send_receipt_correlations SET status=? WHERE receipt_id=?').run('failed', 'rcpt-1'), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM job_email_send_receipt_correlations WHERE receipt_id=?').run('rcpt-1'), /append-only/);
  // A conflicting receipt for the SAME emitted send request (different bytes) fails
  // closed rather than overwriting the recorded correlation.
  assert.throws(
    () => correlateSendReceipt(db, { ...receipt, receiptId: 'rcpt-2', providerMessageId: 'provider-msg-2' }),
    (error) => error instanceof EmailDraftReplyError && error.code === 'RECEIPT_CONFLICT'
  );
  assert.throws(
    () => correlateSendReceipt(db, { ...receipt, requestDigest: sha256('forged') }),
    (error) => error instanceof EmailDraftReplyError && error.code === 'REQUEST_DIGEST_MISMATCH'
  );
});

test('correlate persists the send receipt against the correlated application (closing the loop)', (t) => {
  const db = makeStore(t);
  const facts = importFactsHelper(db);
  const context = buildDraftReplyContext(db, SOURCE);
  issueDraftReplyRequest(db, {
    requestId: 'req-1', issuedBy: 'Cole', expectedSourceStateSha256: context.sourceStateSha256,
    idempotencyKey: 'draft:issue:1', source: SOURCE
  });
  const proposal = makeReplyProposal(facts, context.sourceStateSha256);
  const provenance = makeProvenance(facts, proposal, context.sourceStateSha256);
  recordDraftReplyResult(db, { requestId: 'req-1', proposal, provenance }, 'draft:record:1', RECORD_DEPS);
  const proposalDigest = digest(proposal);
  const approved = approveDraftReplySend(db, {
    proposalId: 'draft-reply-1', expectedProposalDigest: proposalDigest,
    approvedBy: 'owner@example.test', approvedAt: '2026-07-19T16:00:00.000Z', idempotencyKey: 'draft:approve:1'
  }, APPROVE_DEPS);

  // Link this thread's inbound message to an application, exactly as a `linked`
  // correlation would, so the closed-loop receipt binds the application.
  const applicationId = db.prepare("INSERT INTO applications(company, role, status) VALUES ('Acme','Platform Engineer','interviewing')").run().lastInsertRowid;
  const messageRefId = db.prepare('SELECT id FROM job_email_message_refs WHERE message_id=?').get('message-1').id;
  const correlationDigest = sha256('linked-correlation');
  db.prepare(`
    INSERT INTO job_email_correlations(message_ref_id, facts_digest, resolution, resolved_application_id, correlation_json, correlation_digest)
    VALUES (?,?,?,?,?,?)
  `).run(messageRefId, digest(facts), 'linked', applicationId, JSON.stringify({ resolution: 'linked' }), correlationDigest);

  const receipt = {
    schemaVersion: 'email-send-receipt.v1', receiptId: 'rcpt-linked',
    requestId: approved.sendRequestId, idempotencyKey: approved.idempotencyKey,
    requestDigest: approved.sendRequestDigest, status: 'sent',
    provider: 'fixture', providerMessageId: 'provider-msg-linked',
    observedAt: '2026-07-19T16:05:00.000Z'
  };
  const correlated = correlateSendReceipt(db, receipt);
  assert.equal(correlated.correlation.applicationId, applicationId);
  assert.equal(correlated.correlation.threadId, 'thread-1');
  const stored = db.prepare('SELECT application_id, thread_id, status FROM job_email_send_receipt_correlations WHERE receipt_id=?').get('rcpt-linked');
  assert.equal(stored.application_id, applicationId);
  assert.equal(stored.thread_id, 'thread-1');
  assert.equal(stored.status, 'sent');
});

test('the emitted send-request and provenance receipt validate against the frozen schemas', (t) => {
  const db = makeStore(t);
  const facts = importFactsHelper(db);
  const context = buildDraftReplyContext(db, SOURCE);
  const proposal = makeReplyProposal(facts, context.sourceStateSha256);
  const provenance = makeProvenance(facts, proposal, context.sourceStateSha256);
  // Provenance receipt is self-consistent and passes the frozen validator.
  assert.equal(validateDraftProvenanceReceipt(provenance).receiptId, 'prov-1');
});

// -------------------------------------------------------------------------
// E3: usage-receipt non-zero-floor invariant (code-side, CONVENTIONS §5).
// -------------------------------------------------------------------------

test('usage receipt rejects a charged-0 floor for untelemetered trust tiers', () => {
  const floorless = (trust) => ({
    schemaVersion: 'usage-receipt.v1', trust,
    observedInputTokens: null, observedOutputTokens: null, chargedTokens: 0,
    observedCostMicroUsd: null, chargedCostMicroUsd: 0, durationMs: 100
  });
  // A charged-0 `unavailable` receipt is a silent zero by another name — rejected.
  assert.throws(
    () => validateUsageReceipt(floorless('unavailable')),
    (error) => error instanceof EmailContractError && /chargedTokens must be at least 1/.test(error.message)
  );
  // Same floor applies to estimated_tier_ceiling.
  assert.throws(
    () => validateUsageReceipt(floorless('estimated_tier_ceiling')),
    (error) => error instanceof EmailContractError && /chargedTokens must be at least 1/.test(error.message)
  );
  // A zero token count but zero cost is still rejected (both must clear the floor).
  assert.throws(
    () => validateUsageReceipt({ ...floorless('unavailable'), chargedTokens: 1 }),
    (error) => error instanceof EmailContractError && /chargedCostMicroUsd must be at least 1/.test(error.message)
  );
});

test('usage receipt accepts the non-zero floor for untelemetered trust tiers', () => {
  for (const trust of ['unavailable', 'estimated_tier_ceiling']) {
    const accepted = validateUsageReceipt({
      schemaVersion: 'usage-receipt.v1', trust,
      observedInputTokens: null, observedOutputTokens: null, chargedTokens: 1,
      observedCostMicroUsd: null, chargedCostMicroUsd: 1, durationMs: 100
    });
    assert.equal(accepted.trust, trust);
    assert.equal(accepted.chargedTokens, 1);
    assert.equal(accepted.chargedCostMicroUsd, 1);
  }
});

test('the non-zero-floor rule is scoped to untelemetered tiers, not observed ones', () => {
  // provider_reported carries real telemetry, so charged-0 is legitimate there
  // (e.g. a cached completion). The floor rule must NOT reject it.
  const observed = validateUsageReceipt({
    schemaVersion: 'usage-receipt.v1', trust: 'provider_reported',
    observedInputTokens: 0, observedOutputTokens: 0, chargedTokens: 0,
    observedCostMicroUsd: 0, chargedCostMicroUsd: 0, durationMs: 100
  });
  assert.equal(observed.chargedTokens, 0);
});

test('draft-reply record rejects a charged-0 unavailable provenance receipt', (t) => {
  const db = makeStore(t);
  const facts = importFactsHelper(db);
  const context = buildDraftReplyContext(db, SOURCE);
  issueDraftReplyRequest(db, {
    requestId: 'req-1', issuedBy: 'Cole', expectedSourceStateSha256: context.sourceStateSha256,
    idempotencyKey: 'draft:issue:1', source: SOURCE
  });
  const proposal = makeReplyProposal(facts, context.sourceStateSha256);
  const provenance = {
    ...makeProvenance(facts, proposal, context.sourceStateSha256),
    usage: {
      schemaVersion: 'usage-receipt.v1', trust: 'unavailable',
      observedInputTokens: null, observedOutputTokens: null, chargedTokens: 0,
      observedCostMicroUsd: null, chargedCostMicroUsd: 0, durationMs: 100
    }
  };
  // The mandatory provenance receipt runs validateUsageReceipt, so a charged-0
  // unavailable receipt fails closed at record time — never silently accepted.
  assert.throws(
    () => recordDraftReplyResult(db, { requestId: 'req-1', proposal, provenance }, 'draft:record:floor', RECORD_DEPS),
    (error) => error instanceof EmailContractError && /chargedTokens must be at least 1/.test(error.message)
  );
});

// -------------------------------------------------------------------------
// B4: a max-length proposalId still yields a valid (<=200-char) requestId
// and approvalId — `send:`/`approval:` prefixing must not overflow the bound.
// -------------------------------------------------------------------------

test('approval bounds requestId and approvalId for a max-length proposalId', (t) => {
  const db = makeStore(t);
  const facts = importFactsHelper(db);
  const context = buildDraftReplyContext(db, SOURCE);
  // A proposalId at the 200-char identifier bound: `send:${id}` / `approval:${id}`
  // would be 205 / 209 chars and fail the frozen validators without bounding.
  const longProposalId = 'p'.repeat(200);
  assert.equal(longProposalId.length, 200);
  issueDraftReplyRequest(db, {
    requestId: 'req-long', issuedBy: 'Cole', expectedSourceStateSha256: context.sourceStateSha256,
    idempotencyKey: 'draft:issue:long', source: SOURCE
  });
  const proposal = { ...makeReplyProposal(facts, context.sourceStateSha256), proposalId: longProposalId };
  const proposalDigest = digest(proposal);
  const provenance = {
    ...makeProvenance(facts, proposal, context.sourceStateSha256),
    draftProposalId: longProposalId,
    draftProposalDigest: proposalDigest
  };
  recordDraftReplyResult(db, { requestId: 'req-long', proposal, provenance }, 'draft:record:long', RECORD_DEPS);

  const approved = approveDraftReplySend(db, {
    proposalId: longProposalId,
    expectedProposalDigest: proposalDigest,
    approvedBy: 'owner@example.test',
    approvedAt: '2026-07-19T16:00:00.000Z',
    idempotencyKey: 'draft:approve:long'
  }, APPROVE_DEPS);
  assert.equal(approved.sink, 'dry-run');
  assert.equal(approved.delivered, false);

  // The emitted send-request + embedded approval-receipt validate against the
  // frozen schemas (which enforce the 200-char identifier bound). Without the
  // bounding fix, validateEmailSendRequest / validateApprovalReceipt would throw.
  const sink = db.prepare('SELECT * FROM job_email_send_request_sink').all();
  assert.equal(sink.length, 1);
  const emitted = validateEmailSendRequest(JSON.parse(sink[0].send_request_json));
  assert.ok(emitted.requestId.length <= 200, 'requestId must respect the 200-char identifier bound');
  assert.ok(emitted.requestId.startsWith('send:'));
  const approval = validateApprovalReceipt(JSON.parse(sink[0].approval_receipt_json));
  assert.ok(approval.approvalId.length <= 200, 'approvalId must respect the 200-char identifier bound');
  assert.ok(approval.approvalId.startsWith('approval:'));
  // Both are derived deterministically from the (hashed) proposalId, so a replay
  // produces the exact same identifiers.
  const replay = approveDraftReplySend(db, {
    proposalId: longProposalId, expectedProposalDigest: proposalDigest,
    approvedBy: 'owner@example.test', approvedAt: '2026-07-19T16:00:00.000Z', idempotencyKey: 'draft:approve:long'
  }, APPROVE_DEPS);
  assert.equal(replay.sendRequestId, approved.sendRequestId);
  assert.equal(db.prepare('SELECT count(*) count FROM job_email_send_request_sink').get().count, 1);
});

function importFactsHelper(db) {
  const facts = makeFacts();
  importFacts(db, facts, 'facts:draft-reply');
  return facts;
}
