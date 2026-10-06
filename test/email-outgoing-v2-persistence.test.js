'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createTestStore } = require('../test-support/migrated-store');

const { importFacts } = require('../lib/email-integration');
const {
  EMAIL_OUTGOING_V2_AUTHORITY_GUARDS_SCHEMA_VERSION,
  EMAIL_OUTGOING_V2_SCHEMA_VERSION,
  captureDraftReceipt,
  correlateSendReceipt,
  createSendRequest,
  issueDraftRequest,
  migrateEmailOutgoingV2AuthorityGuards,
  readReviewProjection,
  recordDraftResult,
  recordReviewDecision
} = require('../lib/email-outgoing-v2');
const {
  digestCanonicalJson,
  digestUtf8Text,
  projectApprovedContentFromProposal,
  publicKeyFingerprint,
  stableJson
} = require('../lib/email-outgoing-v2-contracts');
const {
  emailFixtures: publishedFixtures,
  verifyPinnedOutgoingV2Fixtures
} = require('../test-support/outgoing-v2-fixtures');

const cli = path.resolve(__dirname, '../bin/jobtrack.js');
verifyPinnedOutgoingV2Fixtures();

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(publishedFixtures, `${name}.json`), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeStore(t, { cold = false } = {}) {
  const copied = cold ? null : createTestStore('jobtrack-outgoing-v2-');
  const directory = copied?.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-outgoing-v2-'));
  const home = copied?.home ?? path.join(directory, 'store');
  if (cold) {
    execFileSync(process.execPath, [cli, 'init', '--json'], {
      env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
      encoding: 'utf8'
    });
  }
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

function issueInput(overrides = {}) {
  return {
    schemaVersion: 'jobtrack-email-reply-draft-issue.v1',
    requestId: 'draft-request-0001',
    idempotencyKey: 'outgoing-draft-issue-0001',
    generationId: 'job-platform-gen-0001',
    manifestDigest: 'd'.repeat(64),
    source: {
      provider: 'apple_mail_emlx',
      accountId: 'jobs@example.test',
      messageId: 'apple-message-1',
      threadId: 'apple-thread-1',
      replyToAddress: 'recruiter@example.test',
      inReplyTo: '<apple-message-1@example.test>',
      references: ['<apple-message-1@example.test>']
    },
    delivery: { provider: 'apple_mail_automation', accountId: 'jobs@example.test' },
    toneDecisionId: 'tone-apple-0001',
    toneDecisionDigest: 'b'.repeat(64),
    voiceRevisionId: 'voice-0001',
    voiceRevisionDigest: 'c'.repeat(64),
    expiresAt: '2026-08-02T05:30:00.000Z',
    ...overrides
  };
}

function draftResultFromIssue(issued, overrides = {}) {
  const proposal = fixture('email-reply-draft-proposal.v3');
  proposal.sourceStateSha256 = issued.request.sourceStateSha256;
  const content = fixture('email-approved-content.v1');
  return {
    schemaVersion: 'jobtrack-email-reply-draft-result.v1',
    resultId: 'draft-result-0001',
    requestId: issued.request.requestId,
    requestDigest: issued.requestDigest,
    proposal,
    approvedContent: content,
    usage: {
      runner: 'standalone_out_of_process',
      toolCalls: 0,
      toolsUsed: [],
      sideEffects: []
    },
    completedAt: '2026-08-01T05:31:00.000Z',
    idempotencyKey: 'outgoing-draft-record-0001',
    ...overrides
  };
}

function draftReceiptFor(resultInput) {
  const receipt = fixture('email-draft-receipt.v1');
  receipt.draftProposalDigest = digestCanonicalJson(resultInput.proposal);
  receipt.contentDigest = digestCanonicalJson(resultInput.approvedContent);
  return receipt;
}

function channel() {
  return {
    kind: 'jobtrack_fixed_command',
    channelId: 'jobtrack-approval-ingress-0001',
    authenticated: true,
    authenticationReceiptDigest: '9'.repeat(64)
  };
}

function keyPair(id) {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    id,
    reference: crypto.randomUUID(),
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    fingerprint: publicKeyFingerprint(pair.publicKey.export({ type: 'spki', format: 'pem' }))
  };
}

function approvalDependencies(key, extras = {}) {
  return {
    approvalChannel: { verify: () => true },
    signer: {
      keyRef: key.reference,
      keyId: key.id,
      signerIdentity: 'owner-local-signer',
      sign(bytes, keyRef) {
        assert.equal(keyRef, key.reference);
        return crypto.sign(null, bytes, key.privateKey);
      }
    },
    approvalKey: {
      expectedKeyId: key.id,
      expectedPublicKeySha256: key.fingerprint,
      resolvePublicKey: (id) => id === key.id ? key.publicKeyPem : null
    },
    now: () => '2026-08-01T05:40:00.000Z',
    ...extras
  };
}

function reviewProjection(db, proposalId, now = '2026-08-01T05:39:00.000Z') {
  return readReviewProjection(db, proposalId, { now: () => now });
}

function approveInput(projection, overrides = {}) {
  return {
    schemaVersion: 'jobtrack-email-outgoing-review-decision.v1',
    reviewId: 'review-0001',
    proposalId: projection.proposal.proposalId,
    decision: 'approve',
    approver: { kind: 'human', id: 'synthetic-human@example.test' },
    decidedAt: '2026-08-01T05:40:00.000Z',
    expectedProjectionDigest: projection.projectionDigest,
    expectedApprovedContentDigest: projection.approvedContentDigest,
    authenticatedChannel: channel(),
    operationIdempotencyKey: 'outgoing-review-operation-0001',
    approval: {
      approvalId: 'approval-0001',
      idempotencyKey: 'one-send-key-0001',
      expiresAt: '2026-08-01T06:40:00.000Z'
    },
    ...overrides
  };
}

function seedProposal(db, options = {}) {
  const facts = fixture('job-application-email-facts.v2');
  importFacts(db, facts, options.importKey || 'import-outgoing-source-0001');
  const issued = issueDraftRequest(db, issueInput(options.issueOverrides));
  const resultInput = draftResultFromIssue(issued, options.resultOverrides);
  const recorded = recordDraftResult(db, resultInput, options.recordDeps);
  const receipt = draftReceiptFor(resultInput);
  const captured = captureDraftReceipt(db, {
    schemaVersion: 'jobtrack-email-draft-receipt-capture.v1',
    receipt,
    idempotencyKey: options.receiptKey || 'capture-draft-receipt-0001'
  });
  return { facts, issued, resultInput, recorded, receipt, captured };
}

function recordReplacement(db, suffix = '0002') {
  const issued = issueDraftRequest(db, issueInput({
    requestId: `draft-request-${suffix}`,
    idempotencyKey: `outgoing-draft-issue-${suffix}`,
    generationId: `job-platform-gen-${suffix}`,
    manifestDigest: 'e'.repeat(64),
    toneDecisionId: `tone-${suffix}`,
    toneDecisionDigest: '1'.repeat(64),
    voiceRevisionId: `voice-${suffix}`,
    voiceRevisionDigest: '2'.repeat(64)
  }));
  const proposal = fixture('email-reply-draft-proposal.v3');
  proposal.proposalId = `draft-apple-${suffix}`;
  proposal.generationId = issued.request.generationId;
  proposal.manifestDigest = issued.request.manifestDigest;
  proposal.toneDecisionId = issued.request.toneDecisionId;
  proposal.toneDecisionDigest = issued.request.toneDecisionDigest;
  proposal.voiceRevisionId = issued.request.voiceRevisionId;
  proposal.voiceRevisionDigest = issued.request.voiceRevisionDigest;
  proposal.sourceStateSha256 = issued.request.sourceStateSha256;
  proposal.body = 'Thank you for the update. I will send the requested information shortly.';
  proposal.bodyDigest = digestUtf8Text(proposal.body);
  const content = projectApprovedContentFromProposal(proposal, {
    contentId: `approved-content-${suffix}`,
    createdAt: '2026-08-01T05:50:00.000Z'
  });
  const input = {
    schemaVersion: 'jobtrack-email-reply-draft-result.v1',
    resultId: `draft-result-${suffix}`,
    requestId: issued.request.requestId,
    requestDigest: issued.requestDigest,
    proposal,
    approvedContent: content,
    usage: { runner: 'standalone_out_of_process', toolCalls: 0, toolsUsed: [], sideEffects: [] },
    completedAt: '2026-08-01T05:51:00.000Z',
    idempotencyKey: `outgoing-draft-record-${suffix}`
  };
  return { issued, input, recorded: recordDraftResult(db, input) };
}

function approveProposal(db, seeded, key = keyPair('approval-key-test-0001'), overrides = {}) {
  const projection = reviewProjection(db, seeded.resultInput.proposal.proposalId);
  const input = approveInput(projection, overrides.input);
  const approved = recordReviewDecision(db, input, approvalDependencies(key, overrides.deps));
  return { projection, input, approved, key };
}

function issueSend(db, approvedFlow, overrides = {}) {
  return createSendRequest(db, {
    schemaVersion: 'jobtrack-email-send-request-issue.v1',
    requestId: 'send-request-0001',
    approvalId: approvedFlow.approved.approvalReceipt.approvalId,
    operationIdempotencyKey: 'issue-send-request-0001',
    ...overrides.input
  }, {
    approvalKey: {
      expectedKeyId: approvedFlow.key.id,
      expectedPublicKeySha256: approvedFlow.key.fingerprint,
      resolvePublicKey: (id) => id === approvedFlow.key.id ? approvedFlow.key.publicKeyPem : null
    },
    now: () => '2026-08-01T05:41:00.000Z',
    ...overrides.deps
  });
}

function signReceipt(unsigned, key) {
  const payloadDigest = digestCanonicalJson(unsigned);
  const signature = crypto.sign(null, Buffer.from(stableJson(unsigned), 'utf8'), key.privateKey).toString('base64');
  return {
    ...unsigned,
    nativeAttestation: {
      algorithm: 'Ed25519',
      keyId: key.id,
      payloadDigest,
      signatureEncoding: 'base64',
      signature
    }
  };
}

function sentReceipt(send, nativeKey, overrides = {}) {
  const request = send.request;
  const unsigned = {
    schemaVersion: 'email-send-receipt.v2',
    normalizationVersion: 'email-text-nfc-lf.v1',
    receiptId: 'send-receipt-0001',
    attemptId: 'send-attempt-0001',
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    requestDigest: send.requestDigest,
    generationId: request.generationId,
    manifestDigest: request.manifestDigest,
    provider: request.provider,
    accountId: request.accountId,
    recipient: request.recipient,
    threadId: request.threadId,
    contentDigest: request.content.digest,
    sendFidelity: 'content_equivalent',
    outcome: 'sent',
    classification: 'applied',
    operationJournalEvidenceDigest: '4'.repeat(64),
    providerEvidenceDigest: '5'.repeat(64),
    providerDraftId: 'provider-draft-0001',
    providerMessageId: 'provider-message-0001',
    providerThreadId: request.threadId,
    observedAt: '2026-08-01T05:42:00.000Z',
    ...overrides
  };
  return signReceipt(unsigned, nativeKey);
}

function mutateAndResign(receipt, nativeKey, mutate) {
  const unsigned = clone(receipt);
  delete unsigned.nativeAttestation;
  mutate(unsigned);
  return signReceipt(unsigned, nativeKey);
}

function receiptDependencies(approved, nativeKey, now) {
  return {
    nativeReceiptKey: {
      expectedKeyId: nativeKey.id,
      expectedPublicKeySha256: nativeKey.fingerprint,
      resolvePublicKey: (id) => id === nativeKey.id ? nativeKey.publicKeyPem : null
    },
    resolveApprovalPublicKey: (id) => id === approved.key.id ? approved.key.publicKeyPem : null,
    now: () => now
  };
}

function correlationInput(receipt, key) {
  return {
    schemaVersion: 'jobtrack-email-send-receipt-correlation.v1',
    receipt,
    operationIdempotencyKey: key
  };
}

test('migration creates the additive immutable provider-neutral store without altering frozen v1 tables', (t) => {
  // Keep schema creation and authority-guard replay on a cold CLI store.
  const db = makeStore(t, { cold: true });
  assert.equal(
    db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?').get(EMAIL_OUTGOING_V2_SCHEMA_VERSION).name,
    'provider_neutral_email_outgoing_core'
  );
  assert.equal(
    db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
      .get(EMAIL_OUTGOING_V2_AUTHORITY_GUARDS_SCHEMA_VERSION).name,
    'provider_neutral_email_outgoing_authority_guards'
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='index' AND name='uq_job_email_outgoing_terminal_review_proposal'").get().n,
    1
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name='job_email_outgoing_receipt_attempt_transition_guard'").get().n,
    1
  );
  const guardSchema = db.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE name IN (
      'uq_job_email_outgoing_terminal_review_proposal',
      'job_email_outgoing_receipt_attempt_transition_guard',
      'job_email_outgoing_approval_requires_sole_terminal_review'
    ) ORDER BY type,name`).all();
  migrateEmailOutgoingV2AuthorityGuards(db);
  migrateEmailOutgoingV2AuthorityGuards(db);
  assert.deepEqual(db.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE name IN (
      'uq_job_email_outgoing_terminal_review_proposal',
      'job_email_outgoing_receipt_attempt_transition_guard',
      'job_email_outgoing_approval_requires_sole_terminal_review'
    ) ORDER BY type,name`).all(), guardSchema);
  assert.equal(
    db.prepare('SELECT count(*) n FROM jobtrack_schema_migrations WHERE version=?')
      .get(EMAIL_OUTGOING_V2_AUTHORITY_GUARDS_SCHEMA_VERSION).n,
    1
  );
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'job_email_%' ORDER BY name`).all().map((row) => row.name);
  for (const table of [
    'job_email_outgoing_draft_requests', 'job_email_outgoing_draft_results',
    'job_email_outgoing_proposals_v3', 'job_email_approved_contents_v1',
    'job_email_draft_receipts_v1', 'job_email_outgoing_review_events',
    'job_email_approval_receipts_v2', 'job_email_send_requests_v2',
    'job_email_send_receipt_correlations_v2', 'job_email_outgoing_invalidation_events'
  ]) assert.ok(tables.includes(table), table);
  assert.ok(tables.includes('job_email_draft_reply_requests'), 'frozen historical v1 request table remains present');
  assert.ok(tables.includes('job_email_send_receipt_correlations'), 'frozen historical v1 correlation table remains present');
});

test('deterministic request/result, capture-only draft evidence, exact review, approval, and one-send request are append-only', (t) => {
  const db = makeStore(t);
  const seeded = seedProposal(db);
  assert.deepEqual(issueDraftRequest(db, issueInput()), seeded.issued);
  assert.throws(
    () => issueDraftRequest(db, issueInput({ requestId: 'draft-request-idempotency-drift' })),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT'
  );
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_outgoing_draft_requests').get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM job_email_outgoing_operations WHERE command='outgoing-draft-issue'").get().n, 1);
  assert.equal(seeded.issued.request.execution.toolAccess, 'none');
  assert.deepEqual(seeded.issued.request.effects, { mailboxRead: false, nativeDraft: false, send: false });
  assert.equal(seeded.recorded.proposalId, 'draft-apple-0001');
  assert.equal(seeded.captured.transmission, 'not_sent');

  const projection = reviewProjection(db, 'draft-apple-0001');
  assert.equal(projection.canApprove, true);
  assert.equal(projection.approvedContent.body.text, seeded.resultInput.approvedContent.body.text);
  assert.equal(projection.approvedContentDigest, digestCanonicalJson(projection.approvedContent));
  const repeatedProjection = reviewProjection(db, 'draft-apple-0001');
  assert.deepEqual(repeatedProjection, projection);

  const approved = approveProposal(db, seeded);
  assert.equal(approved.approved.sendAuthority, 'one-send-request-only');
  assert.equal(approved.approved.approvalReceipt.approver.id, 'synthetic-human@example.test');
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_outgoing_review_events').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_approval_receipts_v2').get().n, 1);
  assert.throws(() => db.prepare("UPDATE job_email_outgoing_review_events SET approver_id='other' WHERE review_id='review-0001'").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM job_email_approval_receipts_v2 WHERE approval_id='approval-0001'").run(), /append-only/);

  const send = issueSend(db, approved);
  assert.equal(send.maximumSends, 1);
  assert.equal(send.effectPerformed, false);
  assert.equal(send.request.content.mode, 'approved_content');
  assert.throws(() => issueSend(db, approved, {
    input: { requestId: 'send-request-0002', operationIdempotencyKey: 'issue-send-request-0002' }
  }), (error) => error.code === 'SEND_REQUEST_ALREADY_ISSUED');
});

test('rejection is an authenticated append-only event and never creates approval or send authority', (t) => {
  const db = makeStore(t);
  const seeded = seedProposal(db);
  const projection = reviewProjection(db, 'draft-apple-0001');
  const rejected = recordReviewDecision(db, {
    schemaVersion: 'jobtrack-email-outgoing-review-decision.v1',
    reviewId: 'review-reject-0001',
    proposalId: 'draft-apple-0001',
    decision: 'reject',
    approver: { kind: 'human', id: 'synthetic-human@example.test' },
    decidedAt: '2026-08-01T05:40:00.000Z',
    expectedProjectionDigest: projection.projectionDigest,
    expectedApprovedContentDigest: projection.approvedContentDigest,
    authenticatedChannel: channel(),
    operationIdempotencyKey: 'outgoing-review-reject-0001',
    reason: 'Synthetic reviewer rejected the wording.'
  }, { approvalChannel: { verify: () => true }, now: () => '2026-08-01T05:40:00.000Z' });
  assert.equal(rejected.decision, 'reject');
  assert.equal(rejected.approvalReceipt, null);
  assert.equal(rejected.sendAuthority, false);
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_approval_receipts_v2').get().n, 0);
});

test('owner-private key reference and private bytes never enter rows, command output, source, or fixtures', (t) => {
  const db = makeStore(t);
  const seeded = seedProposal(db);
  const key = keyPair('approval-key-leak-test');
  const privateBytes = key.privateKey.export({ format: 'der', type: 'pkcs8' });
  const privateBase64 = privateBytes.toString('base64');
  const approved = approveProposal(db, seeded, key);
  const serializedOutput = JSON.stringify(approved.approved);
  assert.equal(serializedOutput.includes(key.reference), false);
  assert.equal(serializedOutput.includes(privateBase64), false);
  const row = db.prepare('SELECT key_id,public_key_sha256,signer_identity,approval_json FROM job_email_approval_receipts_v2').get();
  assert.deepEqual(
    { keyId: row.key_id, publicKeySha256: row.public_key_sha256, signerIdentity: row.signer_identity },
    { keyId: key.id, publicKeySha256: key.fingerprint, signerIdentity: 'owner-local-signer' }
  );
  const storedText = db.prepare(`
    SELECT group_concat(value,'') text FROM (
      SELECT request_json value FROM job_email_outgoing_draft_requests
      UNION ALL SELECT result_json FROM job_email_outgoing_draft_results
      UNION ALL SELECT proposal_json FROM job_email_outgoing_proposals_v3
      UNION ALL SELECT content_json FROM job_email_approved_contents_v1
      UNION ALL SELECT receipt_json FROM job_email_draft_receipts_v1
      UNION ALL SELECT decision_json FROM job_email_outgoing_review_events
      UNION ALL SELECT approval_json FROM job_email_approval_receipts_v2
      UNION ALL SELECT result_json FROM job_email_outgoing_operations
    )
  `).get().text;
  assert.equal(storedText.includes(key.reference), false);
  assert.equal(storedText.includes(privateBase64), false);
  const databaseBytes = db.serialize();
  assert.equal(databaseBytes.includes(Buffer.from(key.reference, 'utf8')), false);
  assert.equal(databaseBytes.includes(privateBytes), false);
  assert.equal(databaseBytes.includes(Buffer.from(privateBase64, 'utf8')), false);
  const sourceAndFixtures = [
    fs.readFileSync(path.resolve(__dirname, '../lib/email-outgoing-v2.js'), 'utf8'),
    fs.readFileSync(path.resolve(__dirname, '../lib/email-outgoing-v2-contracts.js'), 'utf8'),
    ...fs.readdirSync(publishedFixtures)
      .filter((name) => name.endsWith('.json'))
      .map((name) => fs.readFileSync(path.join(publishedFixtures, name), 'utf8'))
  ].join('\n');
  assert.equal(sourceAndFixtures.includes(key.reference), false);
  assert.equal(sourceAndFixtures.includes(privateBase64), false);
  assert.equal(Buffer.from(sourceAndFixtures, 'utf8').includes(privateBytes), false);
  assert.deepEqual(
    db.pragma('table_info(job_email_approval_receipts_v2)').map((column) => column.name)
      .filter((name) => /private|key_ref|key_path/.test(name)),
    []
  );
});

test('signed sent receipt correlation is append-only, replay-safe, and grants no retry authority', (t) => {
  const db = makeStore(t);
  const seeded = seedProposal(db);
  const approved = approveProposal(db, seeded);
  const send = issueSend(db, approved);
  const nativeKey = keyPair('native-receipt-key-0001');
  const receipt = sentReceipt(send, nativeKey);
  const input = {
    schemaVersion: 'jobtrack-email-send-receipt-correlation.v1',
    receipt,
    operationIdempotencyKey: 'correlate-send-receipt-0001'
  };
  const deps = {
    nativeReceiptKey: {
      expectedKeyId: nativeKey.id,
      expectedPublicKeySha256: nativeKey.fingerprint,
      resolvePublicKey: (id) => id === nativeKey.id ? nativeKey.publicKeyPem : null
    },
    resolveApprovalPublicKey: (id) => id === approved.key.id ? approved.key.publicKeyPem : null,
    now: () => '2026-08-01T05:43:00.000Z'
  };
  const correlated = correlateSendReceipt(db, input, deps);
  assert.equal(correlated.outcome, 'sent');
  assert.equal(correlated.retryAuthority, false);
  assert.equal(correlateSendReceipt(db, input, deps).receiptDigest, correlated.receiptDigest);
  assert.throws(() => db.prepare("UPDATE job_email_send_receipt_correlations_v2 SET outcome='failed'").run(), /append-only/);

  const second = sentReceipt(send, nativeKey, {
    receiptId: 'send-receipt-0002',
    attemptId: 'send-attempt-0002',
    observedAt: '2026-08-01T05:44:00.000Z'
  });
  assert.throws(() => correlateSendReceipt(db, {
    ...input,
    receipt: second,
    operationIdempotencyKey: 'correlate-send-receipt-0002'
  }, deps), (error) => error.code === 'RETRY_AUTHORITY_DENIED');
});

test('failed, indeterminate resolution, and duplicate outcomes are correlated without retry authority', (t) => {
  const failedDb = makeStore(t);
  const failedSeed = seedProposal(failedDb, {
    importKey: 'failed-outcome-import',
    issueOverrides: { requestId: 'failed-outcome-draft-request', idempotencyKey: 'failed-outcome-issue' },
    resultOverrides: { resultId: 'failed-outcome-result', idempotencyKey: 'failed-outcome-record' },
    receiptKey: 'failed-outcome-capture'
  });
  const failedApproval = approveProposal(failedDb, failedSeed, keyPair('failed-outcome-approval-key'), {
    input: {
      reviewId: 'failed-outcome-review',
      operationIdempotencyKey: 'failed-outcome-review-operation',
      approval: { approvalId: 'failed-outcome-approval', idempotencyKey: 'failed-outcome-send-key', expiresAt: '2026-08-01T06:40:00.000Z' }
    }
  });
  const failedSend = issueSend(failedDb, failedApproval, {
    input: { requestId: 'failed-outcome-send-request', operationIdempotencyKey: 'failed-outcome-send-operation' }
  });
  const failedNative = keyPair('failed-outcome-native-key');
  const failedReceipt = mutateAndResign(sentReceipt(failedSend, failedNative), failedNative, (value) => {
    value.receiptId = 'failed-outcome-receipt';
    value.outcome = 'failed';
    value.classification = 'unapplied';
    delete value.providerMessageId;
    value.nonSendEvidence = { kind: 'terminal_pre_effect', conclusive: true, digest: '6'.repeat(64) };
    value.failure = { code: 'provider_rejected', message: 'Conclusive synthetic pre-effect failure.', retryDisposition: 'terminal' };
  });
  const failed = correlateSendReceipt(
    failedDb,
    correlationInput(failedReceipt, 'failed-outcome-correlation'),
    receiptDependencies(failedApproval, failedNative, '2026-08-01T05:43:00.000Z')
  );
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.classification, 'unapplied');
  assert.equal(failed.retryAuthority, false);
  const sentAfterFailure = sentReceipt(failedSend, failedNative, {
    receiptId: 'sent-after-failure-receipt',
    observedAt: '2026-08-01T05:44:00.000Z'
  });
  assert.throws(() => correlateSendReceipt(
    failedDb,
    correlationInput(sentAfterFailure, 'sent-after-failure-correlation'),
    receiptDependencies(failedApproval, failedNative, '2026-08-01T05:45:00.000Z')
  ), (error) => error.code === 'RECEIPT_TERMINAL');

  const indeterminateDb = makeStore(t);
  const indeterminateSeed = seedProposal(indeterminateDb, {
    importKey: 'indeterminate-import',
    issueOverrides: { requestId: 'indeterminate-draft-request', idempotencyKey: 'indeterminate-issue' },
    resultOverrides: { resultId: 'indeterminate-result', idempotencyKey: 'indeterminate-record' },
    receiptKey: 'indeterminate-capture'
  });
  const indeterminateApproval = approveProposal(indeterminateDb, indeterminateSeed, keyPair('indeterminate-approval-key'), {
    input: {
      reviewId: 'indeterminate-review',
      operationIdempotencyKey: 'indeterminate-review-operation',
      approval: { approvalId: 'indeterminate-approval', idempotencyKey: 'indeterminate-send-key', expiresAt: '2026-08-01T06:40:00.000Z' }
    }
  });
  const indeterminateSend = issueSend(indeterminateDb, indeterminateApproval, {
    input: { requestId: 'indeterminate-send-request', operationIdempotencyKey: 'indeterminate-send-operation' }
  });
  const indeterminateNative = keyPair('indeterminate-native-key');
  const indeterminateReceipt = mutateAndResign(sentReceipt(indeterminateSend, indeterminateNative), indeterminateNative, (value) => {
    value.receiptId = 'indeterminate-receipt';
    value.outcome = 'indeterminate';
    value.classification = 'indeterminate';
    delete value.providerMessageId;
    value.failure = { code: 'provider_outcome_unknown', message: 'Synthetic outcome requires reconciliation.', retryDisposition: 'reconcile_only' };
  });
  const indeterminate = correlateSendReceipt(
    indeterminateDb,
    correlationInput(indeterminateReceipt, 'indeterminate-correlation'),
    receiptDependencies(indeterminateApproval, indeterminateNative, '2026-08-01T05:43:00.000Z')
  );
  assert.equal(indeterminate.outcome, 'indeterminate');
  assert.equal(indeterminate.retryAuthority, false);
  const resolvedReceipt = sentReceipt(indeterminateSend, indeterminateNative, {
    receiptId: 'indeterminate-resolved-sent',
    attemptId: indeterminateReceipt.attemptId,
    observedAt: '2026-08-01T05:44:00.000Z'
  });
  const resolved = correlateSendReceipt(
    indeterminateDb,
    correlationInput(resolvedReceipt, 'indeterminate-resolution-correlation'),
    receiptDependencies(indeterminateApproval, indeterminateNative, '2026-08-01T05:45:00.000Z')
  );
  assert.equal(resolved.outcome, 'sent');
  assert.equal(resolved.retryAuthority, false);
  assert.equal(indeterminateDb.prepare('SELECT count(*) n FROM job_email_send_receipt_correlations_v2').get().n, 2);

  const duplicateDb = makeStore(t);
  const duplicateSeed = seedProposal(duplicateDb, {
    importKey: 'duplicate-import',
    issueOverrides: { requestId: 'duplicate-draft-request', idempotencyKey: 'duplicate-issue' },
    resultOverrides: { resultId: 'duplicate-result', idempotencyKey: 'duplicate-record' },
    receiptKey: 'duplicate-capture'
  });
  const duplicateApproval = approveProposal(duplicateDb, duplicateSeed, keyPair('duplicate-approval-key'), {
    input: {
      reviewId: 'duplicate-review',
      operationIdempotencyKey: 'duplicate-review-operation',
      approval: { approvalId: 'duplicate-approval', idempotencyKey: 'duplicate-send-key', expiresAt: '2026-08-01T06:40:00.000Z' }
    }
  });
  const duplicateSend = issueSend(duplicateDb, duplicateApproval, {
    input: { requestId: 'duplicate-send-request', operationIdempotencyKey: 'duplicate-send-operation' }
  });
  const duplicateNative = keyPair('duplicate-native-key');
  const original = sentReceipt(duplicateSend, duplicateNative, { receiptId: 'duplicate-original-sent' });
  correlateSendReceipt(
    duplicateDb,
    correlationInput(original, 'duplicate-original-correlation'),
    receiptDependencies(duplicateApproval, duplicateNative, '2026-08-01T05:43:00.000Z')
  );
  const duplicateReceipt = mutateAndResign(original, duplicateNative, (value) => {
    value.receiptId = 'duplicate-evidence-receipt';
    value.outcome = 'duplicate';
    value.duplicateOfReceiptId = original.receiptId;
    value.priorAppliedReceiptDigest = digestCanonicalJson(original);
    value.observedAt = '2026-08-01T05:44:00.000Z';
  });
  const duplicate = correlateSendReceipt(
    duplicateDb,
    correlationInput(duplicateReceipt, 'duplicate-evidence-correlation'),
    receiptDependencies(duplicateApproval, duplicateNative, '2026-08-01T05:45:00.000Z')
  );
  assert.equal(duplicate.outcome, 'duplicate');
  assert.equal(duplicate.classification, 'applied');
  assert.equal(duplicate.retryAuthority, false);
});

test('hostile inputs/dependencies, stale review bytes, expiry, and invalid signatures fail closed', (t) => {
  const db = makeStore(t);
  const facts = fixture('job-application-email-facts.v2');
  importFacts(db, facts, 'import-hostile-source');
  let traps = 0;
  const proxy = new Proxy(issueInput({ idempotencyKey: 'hostile-proxy' }), {
    ownKeys() { traps += 1; return []; }
  });
  assert.throws(() => issueDraftRequest(db, proxy), /Proxy/);
  assert.equal(traps, 0, 'proxy is rejected before invoking traps');
  const accessor = issueInput({ idempotencyKey: 'hostile-accessor' });
  Object.defineProperty(accessor, 'requestId', { enumerable: true, get() { throw new Error('getter ran'); } });
  assert.throws(() => issueDraftRequest(db, accessor), /accessor/);

  const seeded = seedProposal(db, {
    importKey: 'import-hostile-source',
    issueOverrides: { requestId: 'hostile-flow-request', idempotencyKey: 'hostile-flow-issue' },
    resultOverrides: { resultId: 'hostile-flow-result', idempotencyKey: 'hostile-flow-record' },
    receiptKey: 'hostile-flow-capture'
  });
  const projection = reviewProjection(db, 'draft-apple-0001');
  const stale = approveInput(projection, {
    reviewId: 'hostile-review-stale',
    operationIdempotencyKey: 'hostile-review-stale-operation',
    expectedApprovedContentDigest: '0'.repeat(64)
  });
  assert.throws(() => recordReviewDecision(db, stale, approvalDependencies(keyPair('hostile-key'))),
    (error) => error.code === 'CONTENT_DIGEST_MISMATCH');

  const privateResolverKey = keyPair('private-resolver-key');
  assert.throws(() => recordReviewDecision(db, approveInput(projection, {
    reviewId: 'private-resolver-review',
    operationIdempotencyKey: 'private-resolver-operation',
    approval: { approvalId: 'private-resolver-approval', idempotencyKey: 'private-resolver-send', expiresAt: '2026-08-01T06:40:00.000Z' }
  }), approvalDependencies(privateResolverKey, {
    approvalKey: {
      expectedKeyId: privateResolverKey.id,
      expectedPublicKeySha256: privateResolverKey.fingerprint,
      resolvePublicKey: () => privateResolverKey.privateKey.export({ type: 'pkcs8', format: 'pem' })
    }
  })), /PEM string primitive/);
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_outgoing_review_events').get().n, 0, 'failed signing/key verification rolls back review event');

  const approved = approveProposal(db, seeded, keyPair('exclusive-expiry-key'));
  assert.throws(() => issueSend(db, approved, {
    input: {
      requestId: 'expired-send-request',
      operationIdempotencyKey: 'expired-send-operation'
    },
    deps: { now: () => approved.approved.approvalReceipt.expiresAt }
  }), (error) => error.code === 'APPROVAL_EXPIRED');
  assert.equal(db.prepare("SELECT count(*) n FROM job_email_send_requests_v2 WHERE request_id='expired-send-request'").get().n, 0);
  assert.throws(() => createSendRequest(db, {
    schemaVersion: 'jobtrack-email-send-request-issue.v1',
    requestId: 'backdated-send-request',
    approvalId: approved.approved.approvalReceipt.approvalId,
    requestedAt: '2026-08-01T05:41:00.000Z',
    operationIdempotencyKey: 'backdated-send-operation'
  }, {
    approvalKey: {
      expectedKeyId: approved.key.id,
      expectedPublicKeySha256: approved.key.fingerprint,
      resolvePublicKey: () => approved.key.publicKeyPem
    },
    now: () => '2026-08-01T07:00:00.000Z'
  }), /unknown fields/);
});

test('positive review uses observed freshness: expired/backdated and superseded proposals create zero authority rows', (t) => {
  const expiredDb = makeStore(t);
  const expiredSeed = seedProposal(expiredDb, {
    importKey: 'expired-review-import',
    issueOverrides: { requestId: 'expired-review-request', idempotencyKey: 'expired-review-issue' },
    resultOverrides: { resultId: 'expired-review-result', idempotencyKey: 'expired-review-record' },
    receiptKey: 'expired-review-capture'
  });
  const expiredProjection = reviewProjection(expiredDb, 'draft-apple-0001', '2026-08-02T05:31:00.000Z');
  assert.equal(expiredProjection.canApprove, false);
  assert.throws(() => recordReviewDecision(expiredDb, approveInput(expiredProjection, {
    reviewId: 'expired-review',
    decidedAt: '2026-08-01T05:40:00.000Z',
    operationIdempotencyKey: 'expired-review-operation',
    approval: { approvalId: 'expired-approval', idempotencyKey: 'expired-send-key', expiresAt: '2026-08-02T05:29:00.000Z' }
  }), approvalDependencies(keyPair('expired-review-key'), {
    now: () => '2026-08-02T05:31:00.000Z'
  })), (error) => error.code === 'PROPOSAL_EXPIRED');
  assert.equal(expiredDb.prepare('SELECT count(*) n FROM job_email_outgoing_review_events').get().n, 0);
  assert.equal(expiredDb.prepare('SELECT count(*) n FROM job_email_approval_receipts_v2').get().n, 0);

  const supersededDb = makeStore(t);
  const first = seedProposal(supersededDb, {
    importKey: 'superseded-review-import',
    issueOverrides: { requestId: 'superseded-first-request', idempotencyKey: 'superseded-first-issue' },
    resultOverrides: { resultId: 'superseded-first-result', idempotencyKey: 'superseded-first-record' },
    receiptKey: 'superseded-first-capture'
  });
  recordReplacement(supersededDb, '0002');
  const oldProjection = reviewProjection(supersededDb, first.resultInput.proposal.proposalId, '2026-08-01T05:52:00.000Z');
  assert.equal(oldProjection.canApprove, false);
  assert.throws(() => recordReviewDecision(supersededDb, approveInput(oldProjection, {
    reviewId: 'superseded-review',
    decidedAt: '2026-08-01T05:39:00.000Z',
    operationIdempotencyKey: 'superseded-review-operation',
    approval: { approvalId: 'superseded-approval', idempotencyKey: 'superseded-send-key', expiresAt: '2026-08-01T06:40:00.000Z' }
  }), approvalDependencies(keyPair('superseded-review-key'), {
    now: () => '2026-08-01T05:52:00.000Z'
  })), (error) => error.code === 'APPROVAL_SUPERSEDED');
  assert.equal(supersededDb.prepare('SELECT count(*) n FROM job_email_outgoing_review_events').get().n, 0);
  assert.equal(supersededDb.prepare('SELECT count(*) n FROM job_email_approval_receipts_v2').get().n, 0);
});

test('regeneration appends invalidation for existing approval and prevents later send-request minting', (t) => {
  const db = makeStore(t);
  const seeded = seedProposal(db);
  const approved = approveProposal(db, seeded, keyPair('regeneration-approval-key'));
  recordReplacement(db, '0002');
  const invalidation = db.prepare('SELECT * FROM job_email_outgoing_invalidation_events WHERE approval_id=?')
    .get(approved.approved.approvalReceipt.approvalId);
  assert.equal(invalidation.reason, 'regenerated');
  assert.equal(invalidation.replacement_proposal_id, 'draft-apple-0002');
  assert.throws(() => issueSend(db, approved, {
    input: { requestId: 'invalidated-send', operationIdempotencyKey: 'invalidated-send-operation' },
    deps: { now: () => '2026-08-01T05:52:00.000Z' }
  }), (error) => error.code === 'APPROVAL_INVALIDATED');
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_send_requests_v2').get().n, 0);
});

test('injected crash points roll back partial result, review, and receipt writes atomically', (t) => {
  const db = makeStore(t);
  const facts = fixture('job-application-email-facts.v2');
  importFacts(db, facts, 'crash-import');
  const issued = issueDraftRequest(db, issueInput({ requestId: 'crash-request', idempotencyKey: 'crash-issue' }));
  const draftInput = draftResultFromIssue(issued, {
    resultId: 'crash-result',
    idempotencyKey: 'crash-record'
  });
  assert.throws(() => recordDraftResult(db, draftInput, {
    failpoint(name) { if (name === 'after-result-insert') throw new Error('synthetic crash'); }
  }), /synthetic crash/);
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_outgoing_draft_results').get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM job_email_outgoing_operations WHERE idempotency_key='crash-record'").get().n, 0);
  recordDraftResult(db, draftInput);
  captureDraftReceipt(db, {
    schemaVersion: 'jobtrack-email-draft-receipt-capture.v1',
    receipt: draftReceiptFor(draftInput),
    idempotencyKey: 'crash-capture'
  });
  const projection = reviewProjection(db, 'draft-apple-0001');
  const approvalKey = keyPair('crash-approval-key');
  assert.throws(() => recordReviewDecision(db, approveInput(projection, {
    reviewId: 'crash-review',
    operationIdempotencyKey: 'crash-review-operation',
    approval: { approvalId: 'crash-approval', idempotencyKey: 'crash-one-send', expiresAt: '2026-08-01T06:40:00.000Z' }
  }), approvalDependencies(approvalKey, {
    failpoint(name) { if (name === 'after-review-event-insert') throw new Error('synthetic review crash'); }
  })), /synthetic review crash/);
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_outgoing_review_events').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_approval_receipts_v2').get().n, 0);
});

function rejectInput(projection, suffix) {
  return {
    schemaVersion: 'jobtrack-email-outgoing-review-decision.v1',
    reviewId: `review-reject-${suffix}`,
    proposalId: projection.proposal.proposalId,
    decision: 'reject',
    approver: { kind: 'human', id: 'synthetic-human@example.test' },
    decidedAt: '2026-08-01T05:40:00.000Z',
    expectedProjectionDigest: projection.projectionDigest,
    expectedApprovedContentDigest: projection.approvedContentDigest,
    authenticatedChannel: channel(),
    operationIdempotencyKey: `review-reject-operation-${suffix}`,
    reason: 'Synthetic deterministic rejection.'
  };
}

function assertZeroReviewAuthority(db) {
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_outgoing_review_events').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_approval_receipts_v2').get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM job_email_outgoing_operations WHERE command='outgoing-review-record'").get().n, 0);
}

test('re-entrant authenticated review callbacks cannot commit either contradictory terminal-review direction', (t) => {
  {
    const db = makeStore(t);
    const seeded = seedProposal(db);
    const projection = reviewProjection(db, seeded.resultInput.proposal.proposalId);
    const key = keyPair('outer-approve-reentrant-key');
    const outer = approveInput(projection, {
      reviewId: 'outer-approve-review',
      operationIdempotencyKey: 'outer-approve-operation',
      approval: { approvalId: 'outer-approve-authority', idempotencyKey: 'outer-approve-send', expiresAt: '2026-08-01T06:40:00.000Z' }
    });
    const inner = rejectInput(projection, 'inside-outer-approve');
    let entered = false;
    assert.throws(() => recordReviewDecision(db, outer, approvalDependencies(key, {
      approvalChannel: {
        verify() {
          if (!entered) {
            entered = true;
            recordReviewDecision(db, inner, {
              approvalChannel: { verify: () => true },
              now: () => '2026-08-01T05:40:00.000Z'
            });
          }
          return true;
        }
      }
    })), (error) => error.code === 'REVIEW_STATE_CONFLICT');
    assert.equal(entered, true);
    assertZeroReviewAuthority(db);
  }

  {
    const db = makeStore(t);
    const seeded = seedProposal(db);
    const projection = reviewProjection(db, seeded.resultInput.proposal.proposalId);
    const key = keyPair('inner-approve-reentrant-key');
    const outer = rejectInput(projection, 'outer-reject');
    const inner = approveInput(projection, {
      reviewId: 'inner-approve-review',
      operationIdempotencyKey: 'inner-approve-operation',
      approval: { approvalId: 'inner-approve-authority', idempotencyKey: 'inner-approve-send', expiresAt: '2026-08-01T06:40:00.000Z' }
    });
    let entered = false;
    assert.throws(() => recordReviewDecision(db, outer, {
      approvalChannel: {
        verify() {
          if (!entered) {
            entered = true;
            recordReviewDecision(db, inner, approvalDependencies(key));
          }
          return true;
        }
      },
      now: () => '2026-08-01T05:40:00.000Z'
    }), (error) => error.code === 'REVIEW_STATE_CONFLICT');
    assert.equal(entered, true);
    assertZeroReviewAuthority(db);
  }
});

test('post-approval callbacks cannot mint downstream authority before the review operation completes', (t) => {
  const db = makeStore(t);
  const seeded = seedProposal(db);
  const projection = reviewProjection(db, seeded.resultInput.proposal.proposalId);
  const key = keyPair('post-approval-reentrant-key');
  const input = approveInput(projection, {
    reviewId: 'post-approval-reentrant-review',
    operationIdempotencyKey: 'post-approval-reentrant-operation',
    approval: { approvalId: 'post-approval-reentrant-authority', idempotencyKey: 'post-approval-reentrant-send-key', expiresAt: '2026-08-01T06:40:00.000Z' }
  });
  let entered = false;
  assert.throws(() => recordReviewDecision(db, input, approvalDependencies(key, {
    failpoint(name) {
      if (name !== 'after-approval-receipt-insert' || entered) return;
      entered = true;
      createSendRequest(db, {
        schemaVersion: 'jobtrack-email-send-request-issue.v1',
        requestId: 'post-approval-reentrant-request',
        approvalId: input.approval.approvalId,
        operationIdempotencyKey: 'post-approval-reentrant-send-operation'
      }, {
        approvalKey: {
          expectedKeyId: key.id,
          expectedPublicKeySha256: key.fingerprint,
          resolvePublicKey: () => key.publicKeyPem
        },
        now: () => '2026-08-01T05:41:00.000Z'
      });
    }
  })), (error) => error.code === 'REVIEW_STATE_CONFLICT');
  assert.equal(entered, true);
  assertZeroReviewAuthority(db);
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_send_requests_v2').get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM job_email_outgoing_operations WHERE command='outgoing-send-request'").get().n, 0);
});

test('approval clock linearizes after channel, signer, and key callbacks with an exclusive boundary', (t) => {
  const crossingCases = [
    ['channel', (deps, setExpired) => {
      deps.approvalChannel = { verify() { setExpired(); return true; } };
    }],
    ['signer', (deps, setExpired, key) => {
      deps.signer = {
        keyRef: key.reference,
        keyId: key.id,
        signerIdentity: 'owner-local-signer',
        sign(bytes, keyRef) {
          assert.equal(keyRef, key.reference);
          setExpired();
          return crypto.sign(null, bytes, key.privateKey);
        }
      };
    }],
    ['key-resolution', (deps, setExpired, key) => {
      deps.approvalKey = {
        expectedKeyId: key.id,
        expectedPublicKeySha256: key.fingerprint,
        resolvePublicKey(id) {
          setExpired();
          return id === key.id ? key.publicKeyPem : null;
        }
      };
    }]
  ];
  for (const [name, configure] of crossingCases) {
    const db = makeStore(t);
    const seeded = seedProposal(db);
    const projection = reviewProjection(db, seeded.resultInput.proposal.proposalId);
    const key = keyPair(`expiry-${name}-key`);
    const expiry = '2026-08-01T05:40:00.001Z';
    let now = '2026-08-01T05:40:00.000Z';
    const input = approveInput(projection, {
      reviewId: `expiry-${name}-review`,
      operationIdempotencyKey: `expiry-${name}-operation`,
      approval: { approvalId: `expiry-${name}-approval`, idempotencyKey: `expiry-${name}-send`, expiresAt: expiry }
    });
    const deps = approvalDependencies(key, { now: () => now });
    configure(deps, () => { now = expiry; }, key);
    assert.throws(() => recordReviewDecision(db, input, deps),
      (error) => ['APPROVAL_EXPIRY_INVALID', 'PROPOSAL_EXPIRED'].includes(error.code), name);
    assertZeroReviewAuthority(db);
  }

  const beforeDb = makeStore(t);
  const beforeSeed = seedProposal(beforeDb);
  const beforeProjection = reviewProjection(beforeDb, beforeSeed.resultInput.proposal.proposalId);
  const beforeKey = keyPair('one-ms-before-key');
  const before = recordReviewDecision(beforeDb, approveInput(beforeProjection, {
    reviewId: 'one-ms-before-review',
    operationIdempotencyKey: 'one-ms-before-operation',
    approval: { approvalId: 'one-ms-before-approval', idempotencyKey: 'one-ms-before-send', expiresAt: '2026-08-01T05:40:00.001Z' }
  }), approvalDependencies(beforeKey));
  assert.equal(before.approvalReceipt.expiresAt, '2026-08-01T05:40:00.001Z');

  const equalDb = makeStore(t);
  const equalSeed = seedProposal(equalDb);
  const equalProjection = reviewProjection(equalDb, equalSeed.resultInput.proposal.proposalId);
  assert.throws(() => recordReviewDecision(equalDb, approveInput(equalProjection, {
    reviewId: 'exact-expiry-review',
    operationIdempotencyKey: 'exact-expiry-operation',
    approval: { approvalId: 'exact-expiry-approval', idempotencyKey: 'exact-expiry-send', expiresAt: '2026-08-01T05:40:00.001Z' }
  }), approvalDependencies(keyPair('exact-expiry-key'), {
    now: () => '2026-08-01T05:40:00.001Z'
  })), (error) => error.code === 'APPROVAL_EXPIRY_INVALID');
  assertZeroReviewAuthority(equalDb);
});

test('send-request issuance samples its timestamp only after key resolution and rejects equality', (t) => {
  const crossingDb = makeStore(t);
  const crossingSeed = seedProposal(crossingDb);
  const crossingApproval = approveProposal(crossingDb, crossingSeed, keyPair('send-crossing-approval-key'));
  let now = '2026-08-01T06:39:59.999Z';
  assert.throws(() => issueSend(crossingDb, crossingApproval, {
    input: { requestId: 'send-crossing-request', operationIdempotencyKey: 'send-crossing-operation' },
    deps: {
      approvalKey: {
        expectedKeyId: crossingApproval.key.id,
        expectedPublicKeySha256: crossingApproval.key.fingerprint,
        resolvePublicKey(id) {
          now = '2026-08-01T06:40:00.000Z';
          return id === crossingApproval.key.id ? crossingApproval.key.publicKeyPem : null;
        }
      },
      now: () => now
    }
  }), (error) => error.code === 'APPROVAL_EXPIRED');
  assert.equal(crossingDb.prepare('SELECT count(*) n FROM job_email_send_requests_v2').get().n, 0);
  assert.equal(crossingDb.prepare("SELECT count(*) n FROM job_email_outgoing_operations WHERE command='outgoing-send-request'").get().n, 0);

  const beforeDb = makeStore(t);
  const beforeSeed = seedProposal(beforeDb);
  const beforeApproval = approveProposal(beforeDb, beforeSeed, keyPair('send-before-approval-key'));
  const beforeTimes = ['2026-08-01T06:39:59.998Z', '2026-08-01T06:39:59.999Z'];
  const issued = issueSend(beforeDb, beforeApproval, {
    input: { requestId: 'send-before-request', operationIdempotencyKey: 'send-before-operation' },
    deps: { now: () => beforeTimes.shift() }
  });
  assert.equal(issued.request.requestedAt, '2026-08-01T06:39:59.999Z');
  assert.equal(beforeTimes.length, 0);
});

test('signer byte snapshots reject hostile prototypes, accessors, shared memory, and detached views before traps or authority', (t) => {
  const trapPrototype = (target, state) => new Proxy(target, {
    get(original, property, receiver) {
      state.traps += 1;
      return Reflect.get(original, property, receiver);
    },
    getPrototypeOf(original) {
      state.traps += 1;
      return Reflect.getPrototypeOf(original);
    }
  });
  const cases = [
    ['proxy-buffer', (signature, state) => new Proxy(signature, {
      get() { state.traps += 1; throw new Error('trap must not run'); },
      getPrototypeOf() { state.traps += 1; throw new Error('trap must not run'); }
    })],
    ['proxy-uint8array', (signature, state) => new Proxy(new Uint8Array(signature), {
      get() { state.traps += 1; throw new Error('trap must not run'); },
      getPrototypeOf() { state.traps += 1; throw new Error('trap must not run'); }
    })],
    ['revoked-proxy', (signature) => {
      const revocable = Proxy.revocable(signature, {});
      revocable.revoke();
      return revocable.proxy;
    }],
    ['uint8array-subclass', (signature) => {
      class SignatureBytes extends Uint8Array {}
      return new SignatureBytes(signature);
    }],
    ['buffer-custom-prototype', (signature) => {
      Object.setPrototypeOf(signature, Object.create(Buffer.prototype));
      return signature;
    }],
    ['buffer-proxy-prototype', (signature, state) => {
      Object.setPrototypeOf(signature, trapPrototype(Buffer.prototype, state));
      return signature;
    }],
    ['uint8array-proxy-prototype', (signature, state) => {
      const value = new Uint8Array(signature);
      Object.setPrototypeOf(value, trapPrototype(Uint8Array.prototype, state));
      return value;
    }],
    ['buffer-deeper-proxy-prototype', (signature, state) => {
      Object.setPrototypeOf(signature, Object.create(trapPrototype(Buffer.prototype, state)));
      return signature;
    }],
    ['uint8array-deeper-proxy-prototype', (signature, state) => {
      const value = new Uint8Array(signature);
      Object.setPrototypeOf(value, Object.create(trapPrototype(Uint8Array.prototype, state)));
      return value;
    }],
    ['buffer-revoked-prototype', (signature) => {
      const revocable = Proxy.revocable(Buffer.prototype, {});
      Object.setPrototypeOf(signature, revocable.proxy);
      revocable.revoke();
      return signature;
    }],
    ['uint8array-revoked-prototype', (signature) => {
      const value = new Uint8Array(signature);
      const revocable = Proxy.revocable(Uint8Array.prototype, {});
      Object.setPrototypeOf(value, revocable.proxy);
      revocable.revoke();
      return value;
    }],
    ['buffer-own-accessor', (signature, state) => {
      Object.defineProperty(signature, 'hostile', {
        configurable: true,
        get() { state.traps += 1; throw new Error('accessor must not run'); }
      });
      return signature;
    }],
    ['uint8array-own-accessor', (signature, state) => {
      const value = new Uint8Array(signature);
      Object.defineProperty(value, 'hostile', {
        configurable: true,
        get() { state.traps += 1; throw new Error('accessor must not run'); }
      });
      return value;
    }],
    ['shared-uint8array', (signature) => {
      const value = new Uint8Array(new SharedArrayBuffer(64));
      value.set(signature);
      return value;
    }],
    ['detached-uint8array', (signature) => {
      const value = new Uint8Array(signature);
      structuredClone(value.buffer, { transfer: [value.buffer] });
      return value;
    }],
    ['shared-buffer', (signature) => {
      const value = Buffer.from(new SharedArrayBuffer(64));
      value.set(signature);
      return value;
    }],
    ['float64array-masquerading-as-uint8array', (signature) => {
      const value = new Float64Array(8);
      new Uint8Array(value.buffer).set(signature);
      Object.setPrototypeOf(value, Uint8Array.prototype);
      return value;
    }],
    ['dataview-masquerading-as-uint8array', (signature) => {
      const value = new DataView(new ArrayBuffer(64));
      new Uint8Array(value.buffer).set(signature);
      Object.setPrototypeOf(value, Uint8Array.prototype);
      return value;
    }],
    ['uint8clampedarray-masquerading-as-uint8array', (signature) => {
      const value = new Uint8ClampedArray(signature);
      Object.setPrototypeOf(value, Uint8Array.prototype);
      return value;
    }],
    ['base64-signature-text', (signature) => signature.toString('base64')],
    ['hex-signature-text', (signature) => signature.toString('hex')],
    ['plain-array-of-bytes', (signature) => Array.from(signature)],
    ['null-signature', () => null],
    ['undefined-signature', () => undefined],
    ['short-uint8array', (signature) => new Uint8Array(signature.subarray(0, 63))],
    ['long-uint8array', (signature) => {
      const value = new Uint8Array(65);
      value.set(signature);
      return value;
    }],
    ['buffer-symbol-accessor', (signature, state) => {
      Object.defineProperty(signature, Symbol('hostile'), {
        configurable: true,
        get() { state.traps += 1; throw new Error('accessor must not run'); }
      });
      return signature;
    }]
  ];
  for (const [name, wrap] of cases) {
    const db = makeStore(t);
    const seeded = seedProposal(db);
    const projection = reviewProjection(db, seeded.resultInput.proposal.proposalId);
    const key = keyPair(`${name}-key`);
    const state = { traps: 0 };
    const deps = approvalDependencies(key, {
      signer: {
        keyRef: key.reference,
        keyId: key.id,
        signerIdentity: 'owner-local-signer',
        sign(bytes) { return wrap(crypto.sign(null, bytes, key.privateKey), state); }
      }
    });
    assert.throws(() => recordReviewDecision(db, approveInput(projection, {
      reviewId: `${name}-review`,
      operationIdempotencyKey: `${name}-operation`,
      approval: { approvalId: `${name}-approval`, idempotencyKey: `${name}-send`, expiresAt: '2026-08-01T06:40:00.000Z' }
    }), deps), (error) => error.code === 'SIGNING_FAILED', name);
    assert.equal(state.traps, 0, `${name} must execute zero traps`);
    assertZeroReviewAuthority(db);
  }
});

test('public-key resolvers accept only PEM string primitives and reject hostile KeyObjects before traps or authority', (t) => {
  const trapPrototype = (target, state) => new Proxy(target, {
    get(original, property, receiver) {
      state.traps += 1;
      return Reflect.get(original, property, receiver);
    },
    getPrototypeOf(original) {
      state.traps += 1;
      return Reflect.getPrototypeOf(original);
    }
  });
  const cases = [
    ['raw-keyobject', (key) => key],
    ['proxy-keyobject', (key, state) => new Proxy(key, {
      get() { state.traps += 1; throw new Error('trap must not run'); },
      getPrototypeOf() { state.traps += 1; throw new Error('trap must not run'); }
    })],
    ['keyobject-proxy-prototype', (key, state) => {
      Object.setPrototypeOf(key, trapPrototype(Object.getPrototypeOf(key), state));
      return key;
    }],
    ['keyobject-deeper-proxy-prototype', (key, state) => {
      Object.setPrototypeOf(key, Object.create(trapPrototype(Object.getPrototypeOf(key), state)));
      return key;
    }],
    ['keyobject-revoked-prototype', (key) => {
      const revocable = Proxy.revocable(Object.getPrototypeOf(key), {});
      Object.setPrototypeOf(key, revocable.proxy);
      revocable.revoke();
      return key;
    }],
    ['keyobject-own-accessor', (key, state) => {
      Object.defineProperty(key, 'publicKey', {
        configurable: true,
        get() { state.traps += 1; throw new Error('accessor must not run'); }
      });
      return key;
    }],
    ['wrapper-own-accessor', (_key, state) => {
      const wrapper = {};
      Object.defineProperty(wrapper, 'publicKey', {
        enumerable: true,
        get() { state.traps += 1; throw new Error('accessor must not run'); }
      });
      return wrapper;
    }]
  ];
  for (const [name, wrap] of cases) {
    const db = makeStore(t);
    const seeded = seedProposal(db);
    const projection = reviewProjection(db, seeded.resultInput.proposal.proposalId);
    const key = keyPair(`${name}-key`);
    const state = { traps: 0 };
    const deps = approvalDependencies(key);
    deps.approvalKey.resolvePublicKey = (id) => id === key.id ? wrap(key.publicKey, state) : null;
    assert.throws(() => recordReviewDecision(db, approveInput(projection, {
      reviewId: `${name}-review`,
      operationIdempotencyKey: `${name}-operation`,
      approval: { approvalId: `${name}-approval`, idempotencyKey: `${name}-send`, expiresAt: '2026-08-01T06:40:00.000Z' }
    }), deps), (error) => error.code === 'PUBLIC_KEY_RESOLUTION_FAILED', name);
    assert.equal(state.traps, 0, `${name} must execute zero traps`);
    assertZeroReviewAuthority(db);
  }
});

function failedReceiptFromSent(sent, nativeKey, suffix) {
  return mutateAndResign(sent, nativeKey, (value) => {
    value.receiptId = `reentrant-failed-${suffix}`;
    value.outcome = 'failed';
    value.classification = 'unapplied';
    delete value.providerMessageId;
    value.nonSendEvidence = { kind: 'terminal_pre_effect', conclusive: true, digest: '6'.repeat(64) };
    value.failure = { code: 'provider_rejected', message: 'Synthetic conclusive pre-effect failure.', retryDisposition: 'terminal' };
  });
}

test('receipt key-resolution and failpoint re-entrancy cannot commit contradictory attempt outcomes', (t) => {
  for (const site of ['approval-key', 'native-key', 'failpoint']) {
    const db = makeStore(t);
    const seeded = seedProposal(db);
    const approved = approveProposal(db, seeded, keyPair(`${site}-approval-key`));
    const send = issueSend(db, approved);
    const nativeKey = keyPair(`${site}-native-key`);
    const outerReceipt = sentReceipt(send, nativeKey, { receiptId: `${site}-outer-sent` });
    const innerReceipt = failedReceiptFromSent(outerReceipt, nativeKey, site);
    let entered = false;
    const enter = () => {
      if (entered) return;
      entered = true;
      correlateSendReceipt(
        db,
        correlationInput(innerReceipt, `${site}-inner-operation`),
        receiptDependencies(approved, nativeKey, '2026-08-01T05:43:00.000Z')
      );
    };
    const deps = receiptDependencies(approved, nativeKey, '2026-08-01T05:43:00.000Z');
    if (site === 'approval-key') {
      deps.resolveApprovalPublicKey = (id) => {
        enter();
        return id === approved.key.id ? approved.key.publicKeyPem : null;
      };
    } else if (site === 'native-key') {
      deps.nativeReceiptKey.resolvePublicKey = (id) => {
        enter();
        return id === nativeKey.id ? nativeKey.publicKeyPem : null;
      };
    } else {
      deps.failpoint = (name) => { if (name === 'before-send-receipt-insert') enter(); };
    }
    assert.throws(() => correlateSendReceipt(
      db,
      correlationInput(outerReceipt, `${site}-outer-operation`),
      deps
    ), (error) => ['RECEIPT_TERMINAL', 'RECEIPT_STATE_CONFLICT'].includes(error.code), site);
    assert.equal(entered, true);
    assert.equal(db.prepare('SELECT count(*) n FROM job_email_send_receipt_correlations_v2').get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM job_email_outgoing_operations WHERE command='outgoing-receipt'").get().n, 0);
  }
});

test('post-insert receipt callbacks cannot append even a valid terminal successor before the outer operation completes', (t) => {
  const db = makeStore(t);
  const seeded = seedProposal(db);
  const approved = approveProposal(db, seeded, keyPair('post-receipt-approval-key'));
  const send = issueSend(db, approved);
  const nativeKey = keyPair('post-receipt-native-key');
  const sent = sentReceipt(send, nativeKey, { receiptId: 'post-receipt-outer-sent' });
  const duplicate = mutateAndResign(sent, nativeKey, (value) => {
    value.receiptId = 'post-receipt-inner-duplicate';
    value.outcome = 'duplicate';
    value.duplicateOfReceiptId = sent.receiptId;
    value.priorAppliedReceiptDigest = digestCanonicalJson(sent);
    value.observedAt = '2026-08-01T05:44:00.000Z';
  });
  let entered = false;
  const deps = receiptDependencies(approved, nativeKey, '2026-08-01T05:45:00.000Z');
  deps.failpoint = (name) => {
    if (name !== 'after-send-receipt-insert' || entered) return;
    entered = true;
    correlateSendReceipt(
      db,
      correlationInput(duplicate, 'post-receipt-inner-operation'),
      receiptDependencies(approved, nativeKey, '2026-08-01T05:45:00.000Z')
    );
  };
  assert.throws(() => correlateSendReceipt(
    db,
    correlationInput(sent, 'post-receipt-outer-operation'),
    deps
  ), (error) => error.code === 'RECEIPT_STATE_CONFLICT');
  assert.equal(entered, true);
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_send_receipt_correlations_v2').get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM job_email_outgoing_operations WHERE command='outgoing-receipt'").get().n, 0);
});

test('SQLite itself rejects contradictory receipt transitions outside the command-layer snapshot', (t) => {
  const db = makeStore(t);
  const seeded = seedProposal(db);
  const approved = approveProposal(db, seeded, keyPair('sqlite-transition-approval-key'));
  const send = issueSend(db, approved);
  const nativeKey = keyPair('sqlite-transition-native-key');
  const sent = sentReceipt(send, nativeKey, { receiptId: 'sqlite-transition-sent' });
  correlateSendReceipt(
    db,
    correlationInput(sent, 'sqlite-transition-sent-operation'),
    receiptDependencies(approved, nativeKey, '2026-08-01T05:43:00.000Z')
  );
  const failed = failedReceiptFromSent(sent, nativeKey, 'sqlite-direct');
  assert.throws(() => db.prepare(`INSERT INTO job_email_send_receipt_correlations_v2(
    receipt_id,send_request_id,attempt_id,outcome,classification,receipt_json,
    receipt_digest,native_key_id,native_public_key_sha256,observed_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    failed.receiptId, failed.requestId, failed.attemptId, failed.outcome,
    failed.classification, stableJson(failed), digestCanonicalJson(failed),
    nativeKey.id, nativeKey.fingerprint, failed.observedAt
  ), /receipt attempt transition is not admitted/);
  assert.deepEqual(
    db.prepare('SELECT outcome FROM job_email_send_receipt_correlations_v2 ORDER BY rowid').all(),
    [{ outcome: 'sent' }]
  );
});

test('SQLite itself serializes exactly one terminal human review per proposal', (t) => {
  const db = makeStore(t);
  const seeded = seedProposal(db);
  const projection = reviewProjection(db, seeded.resultInput.proposal.proposalId);
  recordReviewDecision(db, rejectInput(projection, 'sqlite-sole-review'), {
    approvalChannel: { verify: () => true },
    now: () => '2026-08-01T05:40:00.000Z'
  });
  assert.throws(() => db.prepare(`INSERT INTO job_email_outgoing_review_events(
    review_id,proposal_id,content_id,draft_receipt_id,decision,approver_id,
    review_projection_digest,approved_content_digest,authenticated_channel_digest,
    decision_json,decision_digest,operation_idempotency_key,decided_at
  ) SELECT ?,proposal_id,content_id,NULL,'reject',approver_id,
    review_projection_digest,approved_content_digest,authenticated_channel_digest,
    decision_json,?, ?,decided_at
    FROM job_email_outgoing_review_events WHERE proposal_id=?`).run(
    'sqlite-contradictory-review', '7'.repeat(64), 'sqlite-contradictory-operation',
    seeded.resultInput.proposal.proposalId
  ), /UNIQUE constraint failed: job_email_outgoing_review_events\.proposal_id/);
  assert.deepEqual(
    db.prepare('SELECT decision FROM job_email_outgoing_review_events').all(),
    [{ decision: 'reject' }]
  );
});

// %TypedArray%.prototype owns the `length` accessor that Buffer.prototype
// .toString consults. A signer that replaces the realm's Uint8Array.prototype
// prototype could therefore run a trap while the module encoded its OWN copy,
// after every check on the untrusted value had passed. Both privileged modules
// now encode and decode base64 by index arithmetic, so no such lookup happens.
test('poisoning the shared typed-array prototype cannot execute a trap inside the signer boundary', (t) => {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  for (const [name, lie] of [['truncating-length', 32], ['oversized-length', 8192], ['honest-forward', null]]) {
    const db = makeStore(t);
    const seeded = seedProposal(db);
    const projection = reviewProjection(db, seeded.resultInput.proposal.proposalId);
    const key = keyPair(`${name}-key`);
    const state = { traps: 0 };
    let restore = () => {};
    const deps = approvalDependencies(key, {
      signer: {
        keyRef: key.reference,
        keyId: key.id,
        signerIdentity: 'owner-local-signer',
        sign(bytes) {
          const signature = new Uint8Array(64);
          signature.set(crypto.sign(null, bytes, key.privateKey));
          const poisoned = new Proxy(typedArrayPrototype, {
            get(target, property, receiver) {
              state.traps += 1;
              if (lie !== null && (property === 'length' || property === 'byteLength')) return lie;
              return Reflect.get(target, property, receiver);
            }
          });
          Object.setPrototypeOf(Uint8Array.prototype, poisoned);
          restore = () => Object.setPrototypeOf(Uint8Array.prototype, typedArrayPrototype);
          return signature;
        }
      }
    });
    try {
      const input = approveInput(projection, {
        reviewId: `${name}-review`,
        operationIdempotencyKey: `${name}-operation`,
        approval: { approvalId: `${name}-approval`, idempotencyKey: `${name}-send`, expiresAt: '2026-08-01T06:40:00.000Z' }
      });
      // A replaced chain is refused even when the proxy forwards honestly:
      // there is no safe way to handle key material in a tampered realm, and
      // the refusal happens before anything the proxy could observe.
      assert.throws(
        () => recordReviewDecision(db, input, deps),
        (error) => error.code === 'SIGNING_FAILED' && /prototype chain was replaced/.test(error.message),
        name
      );
    } finally {
      restore();
    }
    assert.equal(state.traps, 0, `${name} must execute zero traps inside the signer boundary`);
    assert.equal(Object.getPrototypeOf(Uint8Array.prototype), typedArrayPrototype);
    assertZeroReviewAuthority(db);
  }
});
