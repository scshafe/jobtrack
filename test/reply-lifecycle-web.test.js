'use strict';

// JT-4: the read-only web surface for the reply-draft -> approval -> send-request
// -> send-receipt lifecycle. It must render the COLLAPSED METADATA (state/status,
// draftProposalDigest / approvedArtifactDigest / requestDigest, recipient-locked
// flag, thread/contact register, timestamps, correlated receipt status) while
// leaking NO raw draft prose, message body, evidence excerpt, or exact private
// address, and staying query_only (GET/HEAD).

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { digest } = require('../lib/email-contracts');
const {
  importFacts,
  buildDraftReplyContext,
  issueDraftReplyRequest,
  approveDraftReplySend,
  correlateSendReceipt,
  idempotentOperation
} = require('../lib/email-integration');
const { recordDraftReplyResult, readReplyLifecycleSummary } = require('../lib/email-draft-reply');
const { freePort } = require('../test-support/free-port');

// Isolated reply-state-machine double: persists exactly the recipient-locked,
// auto_send_eligible=0 proposal row + `proposed` event the draft-reply record
// path reads back, without the orthogonal tone/voice/style binding (which is
// exercised exhaustively elsewhere). Mirrors the draft-reply unit test double.
function fakeProposeReplyDraft(db, proposal, idempotencyKey) {
  const proposalDigest = digest(proposal);
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
    .run(proposal.proposalId, 'proposed', 'reply-web-test', null);
  return { proposalId: proposal.proposalId, proposalDigest, reused: false, autoSendEnabled: false };
}
const RECORD_DEPS = { proposeReplyDraft: fakeProposeReplyDraft, idempotentOperation };

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

// Private sentinels that must NEVER surface in the rendered HTML.
const PRIVATE_LOCAL = 'private.reply+REPLY_LOCALPART_SENTINEL';
const PRIVATE_ADDRESS = `${PRIVATE_LOCAL}@acme.example`;
const FROM_ADDRESS = 'recruiter+REPLY_FROM_SENTINEL@acme.example';
const PRIVATE_EVIDENCE = 'REPLY_EVIDENCE_SENTINEL <script>window.replyEvidenceLeaked=true</script>';
const PRIVATE_BODY = 'REPLY_BODY_SENTINEL Dear hiring team, <img src=x onerror=window.replyBodyLeaked=true> /home/user/private-reply.pdf';

test('reply-send lifecycle surface renders collapsed metadata and never leaks prose, bodies, or exact addresses', async (t) => {
  const fixture = makeFixture();
  t.after(async () => {
    await stopServer(fixture.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const app = runCli(fixture.home, [
    'add-application', '--company', 'Acme', '--role', 'Platform Engineer',
    '--status', 'interviewing', '--applied-date', '2026-07-17'
  ]);

  const db = new Database(path.join(fixture.home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  let expected;
  try {
    expected = seedLifecycle(db, app.application.id);
  } finally {
    db.close();
  }

  const instance = await startServer(fixture);

  // 1. The canonical route renders the lifecycle as collapsed metadata. The
  // page now leads with the live v2 lane; this store's v1-era rows render in
  // the clearly-marked historical section below it.
  const page = await request(`${instance.baseUrl}/communications/replies`);
  assert.equal(page.status, 200, `${page.text}\n${instance.stderr()}`);
  assert.match(page.text, /Outgoing replies/);
  assert.match(page.text, /Historical v1 \(dry-run era\)/);
  assert.match(page.text, /Reply draft reply-web-1/);
  // Lifecycle state/status metadata is present.
  assert.match(page.text, /Send receipt: sent/);
  assert.match(page.text, /Send-request emitted|Send-request/i);
  assert.match(page.text, /Recipient-locked/);
  assert.match(page.text, /auto-send disabled/i);
  assert.match(page.text, /Auto-send<\/span><span>Never granted/);
  // The issuing request's route + provenance usage trust render as metadata.
  assert.match(page.text, /route frontier-default/);
  assert.match(page.text, /usage trust provider reported/i);
  // The correlated application register (safe company/role metadata) is shown.
  assert.match(page.text, /Acme/);
  assert.match(page.text, /Platform Engineer/);
  // The thread/contact register collapses the address to a domain only.
  assert.match(page.text, /acme\.example/);
  // The pinned digests appear (truncated), proving the metadata spine renders.
  assert.match(page.text, new RegExp(escapeRegExp(expected.draftProposalDigest.slice(0, 16))));
  assert.match(page.text, new RegExp(escapeRegExp(expected.approvedArtifactDigest.slice(0, 16))));
  assert.match(page.text, new RegExp(escapeRegExp(expected.requestDigest.slice(0, 16))));
  assertPrivateHeaders(page.headers);

  // 2. NO raw prose / body / evidence / exact address leaks — omitted, not merely escaped.
  for (const secret of [
    PRIVATE_ADDRESS,
    PRIVATE_LOCAL,
    'REPLY_LOCALPART_SENTINEL',
    'REPLY_FROM_SENTINEL',
    'REPLY_EVIDENCE_SENTINEL',
    'REPLY_BODY_SENTINEL',
    'Dear hiring team',
    '/home/user/private-reply.pdf',
    'REPLY_APPROVER_SENTINEL'
  ]) assert.doesNotMatch(page.text, new RegExp(escapeRegExp(secret), 'i'), `leaked: ${secret}`);
  assert.doesNotMatch(page.text, /window\.(replyEvidenceLeaked|replyBodyLeaked)/);
  assert.doesNotMatch(page.text, /<script|<img|<svg/i);
  assert.doesNotMatch(page.text, /&lt;(script|img|svg)/i, 'private payloads must be omitted, not merely escaped');
  // The full send-request / approval JSON (which embeds nothing private, but is
  // still not for this surface) must not be dumped verbatim.
  assert.doesNotMatch(page.text, /send_request_json|approval_receipt_json|proposal_json/);

  // 3. The bare /communications alias redirects to the canonical lifecycle route.
  const alias = await request(`${instance.baseUrl}/communications`, { redirect: 'manual' });
  assert.equal(alias.status, 302);
  assert.equal(alias.headers.get('location'), '/communications/replies');

  // 4. The surface is query_only: writes are refused with GET/HEAD only.
  const post = await request(`${instance.baseUrl}/communications/replies`, { method: 'POST' });
  assert.equal(post.status, 405, post.text);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  assertPrivateHeaders(post.headers);

  // 5. HEAD is allowed (read-only), and carries the same private headers.
  const head = await request(`${instance.baseUrl}/communications/replies`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assertPrivateHeaders(head.headers);

  await stopServer(instance);
});

test('the lifecycle projection is collapsed metadata only and encodes the security invariants', (t) => {
  const { root: dir, home } = require('../test-support/migrated-store').createTestStore('jobtrack-reply-lifecycle-unit-');
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const applicationId = db.prepare("INSERT INTO applications(company, role, status) VALUES ('Acme','Platform Engineer','interviewing')").run().lastInsertRowid;
  const expected = seedLifecycle(db, applicationId);

  const summary = readReplyLifecycleSummary(db);
  assert.ok(summary, 'summary is available on a migrated store');
  assert.equal(summary.autoSendEnabled, false);
  assert.equal(summary.sink, 'dry-run');
  assert.equal(summary.protectedPayloadRedacted, true);
  assert.equal(summary.counts.total, 1);
  assert.equal(summary.counts.approved, 1);
  assert.equal(summary.counts.emitted, 1);
  assert.equal(summary.counts.sent, 1);

  const [item] = summary.lifecycle;
  // State / status metadata.
  assert.equal(item.proposalId, 'reply-web-1');
  assert.equal(item.state, 'receipt-sent');
  assert.equal(item.reviewState, 'approved');
  assert.equal(item.receipt.status, 'sent');
  // The security invariants are surfaced explicitly.
  assert.equal(item.recipientLocked, true);
  assert.equal(item.autoSendEligible, false);
  assert.equal(item.send.delivered, false);
  assert.equal(item.send.sink, 'dry-run');
  // The digests are the exact pinned SHA-256 values.
  assert.equal(item.digests.draftProposalDigest, expected.draftProposalDigest);
  assert.equal(item.digests.approvedArtifactDigest, expected.approvedArtifactDigest);
  assert.equal(item.digests.requestDigest, expected.requestDigest);
  assert.equal(item.digests.receiptDigest.length, 64);
  assert.equal(item.digests.issuedRequestDigest.length, 64);
  assert.equal(item.digests.sourceStateSha256, expected.sourceStateSha256);
  // The issuing bounded_internal_request binds through the provenance receipt.
  assert.equal(item.routeAlias, 'frontier-default');
  assert.equal(item.provenance.usageTrust, 'provider_reported');
  // The thread/contact register is collapsed to a domain, never an exact address.
  assert.equal(item.recipientDomain, 'acme.example');
  assert.equal(item.thread.senderDomain, 'acme.example');
  assert.equal(item.application.company, 'Acme');
  assert.equal(item.application.role, 'Platform Engineer');

  // The whole projection is inspected: NO field carries a raw address, body, or
  // evidence excerpt anywhere in the structure.
  const serialized = JSON.stringify(summary);
  for (const secret of [
    PRIVATE_ADDRESS, PRIVATE_LOCAL, 'REPLY_LOCALPART_SENTINEL', 'REPLY_FROM_SENTINEL',
    'REPLY_EVIDENCE_SENTINEL', 'REPLY_BODY_SENTINEL', 'Dear hiring team', '/home/user/private-reply.pdf'
  ]) assert.doesNotMatch(serialized, new RegExp(escapeRegExp(secret), 'i'), `projection leaked: ${secret}`);

  // A store without the schema returns null so callers render an empty section.
  const bare = new Database(':memory:');
  t.after(() => bare.close());
  assert.equal(readReplyLifecycleSummary(bare), null);
});

test('a failed send receipt on an unlinked thread renders as failed metadata without an application', (t) => {
  const { root: dir, home } = require('../test-support/migrated-store').createTestStore('jobtrack-reply-lifecycle-failed-');
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // No application link, and a `failed` correlated receipt.
  const facts = makeFacts();
  importFacts(db, facts, 'reply-web:facts');
  const messageRefId = db.prepare('SELECT id FROM job_email_message_refs WHERE message_id=?').get('reply-web-message-1').id;
  const context = buildDraftReplyContext(db, SOURCE);
  issueDraftReplyRequest(db, {
    requestId: 'reply-web-req-1', issuedBy: 'Cole', expectedSourceStateSha256: context.sourceStateSha256,
    idempotencyKey: 'reply-web:issue', source: SOURCE
  });
  const proposal = makeReplyProposal(facts, context.sourceStateSha256);
  const proposalDigest = digest(proposal);
  db.prepare(`
    INSERT INTO job_email_reply_draft_proposals (
      proposal_id, message_ref_id, recipient, authorship, requires_review, auto_send_eligible, proposal_json, proposal_digest
    ) VALUES (?,?,?,?,?,0,?,?)
  `).run(proposal.proposalId, messageRefId, proposal.recipient, proposal.authorship, proposal.requiresReview ? 1 : 0, JSON.stringify(proposal), proposalDigest);
  db.prepare('INSERT INTO job_email_reply_draft_events(proposal_id,event_kind,actor,notes) VALUES (?,?,?,?)')
    .run(proposal.proposalId, 'proposed', 'reply-web-test', null);
  const approved = approveDraftReplySend(db, {
    proposalId: proposal.proposalId, expectedProposalDigest: proposalDigest,
    approvedBy: 'owner@example.test', approvedAt: '2026-07-19T16:00:00.000Z', idempotencyKey: 'reply-web:approve'
  });
  correlateSendReceipt(db, {
    schemaVersion: 'email-send-receipt.v1', receiptId: 'reply-web-rcpt-failed',
    requestId: approved.sendRequestId, idempotencyKey: approved.idempotencyKey,
    requestDigest: approved.sendRequestDigest, status: 'failed',
    provider: 'fixture', observedAt: '2026-07-19T16:05:00.000Z',
    failureReason: 'REPLY_FAILURE_SENTINEL provider rejected the send'
  });

  const summary = readReplyLifecycleSummary(db);
  const [item] = summary.lifecycle;
  assert.equal(item.state, 'receipt-failed');
  assert.equal(item.receipt.status, 'failed');
  assert.equal(item.receipt.hasProviderMessageId, false);
  assert.equal(item.application, null);
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.counts.sent, 0);
  // No failure-reason free text is carried into the projection.
  assert.doesNotMatch(JSON.stringify(summary), /REPLY_FAILURE_SENTINEL/);
});

test('a skipped_duplicate receipt maps to the frozen enum state and skipped count', (t) => {
  const { root: dir, home } = require('../test-support/migrated-store').createTestStore('jobtrack-reply-lifecycle-skip-');
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const facts = makeFacts();
  importFacts(db, facts, 'reply-web:facts');
  const messageRefId = db.prepare('SELECT id FROM job_email_message_refs WHERE message_id=?').get('reply-web-message-1').id;
  const context = buildDraftReplyContext(db, SOURCE);
  issueDraftReplyRequest(db, {
    requestId: 'reply-web-req-1', issuedBy: 'Cole', expectedSourceStateSha256: context.sourceStateSha256,
    idempotencyKey: 'reply-web:issue', source: SOURCE
  });
  const proposal = makeReplyProposal(facts, context.sourceStateSha256);
  const proposalDigest = digest(proposal);
  db.prepare(`
    INSERT INTO job_email_reply_draft_proposals (
      proposal_id, message_ref_id, recipient, authorship, requires_review, auto_send_eligible, proposal_json, proposal_digest
    ) VALUES (?,?,?,?,?,0,?,?)
  `).run(proposal.proposalId, messageRefId, proposal.recipient, proposal.authorship, proposal.requiresReview ? 1 : 0, JSON.stringify(proposal), proposalDigest);
  db.prepare('INSERT INTO job_email_reply_draft_events(proposal_id,event_kind,actor,notes) VALUES (?,?,?,?)')
    .run(proposal.proposalId, 'proposed', 'reply-web-test', null);
  const approved = approveDraftReplySend(db, {
    proposalId: proposal.proposalId, expectedProposalDigest: proposalDigest,
    approvedBy: 'owner@example.test', approvedAt: '2026-07-19T16:00:00.000Z', idempotencyKey: 'reply-web:approve'
  });
  correlateSendReceipt(db, {
    schemaVersion: 'email-send-receipt.v1', receiptId: 'reply-web-rcpt-skip',
    requestId: approved.sendRequestId, idempotencyKey: approved.idempotencyKey,
    requestDigest: approved.sendRequestDigest, status: 'skipped_duplicate',
    provider: 'fixture', providerMessageId: 'provider-msg-prior', observedAt: '2026-07-19T16:05:00.000Z'
  });

  const summary = readReplyLifecycleSummary(db);
  const [item] = summary.lifecycle;
  assert.equal(item.state, 'receipt-skipped_duplicate');
  assert.equal(item.receipt.status, 'skipped_duplicate');
  assert.equal(summary.counts.skipped, 1);
  assert.equal(summary.counts.sent, 0);
  assert.equal(summary.counts.failed, 0);
});

test('the lifecycle surface renders an empty section on a store with no reply drafts', async (t) => {
  const fixture = makeFixture();
  t.after(async () => {
    await stopServer(fixture.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const instance = await startServer(fixture);

  const page = await request(`${instance.baseUrl}/communications/replies`);
  assert.equal(page.status, 200, `${page.text}\n${instance.stderr()}`);
  assert.match(page.text, /Outgoing replies/);
  assert.match(page.text, /No outgoing replies are recorded yet/);
  // An empty dry-run era renders nothing — no empty historical section.
  assert.doesNotMatch(page.text, /Historical v1/);
  assertPrivateHeaders(page.headers);
  await stopServer(instance);
});

// -------------------------------------------------------------------------
// Seed a complete draft -> approval -> send-request -> send-receipt lifecycle by
// driving the real draft-reply lib approval/send/correlation code. The reply
// proposal row + `proposed` event are seeded directly (exactly like the isolated
// draft-reply unit test double), which lets us bind a private body/recipient
// without standing up the orthogonal tone/voice/style binding machinery.
// -------------------------------------------------------------------------

function seedLifecycle(db, applicationId) {
  const facts = makeFacts();
  importFacts(db, facts, 'reply-web:facts');
  const messageRefId = db.prepare('SELECT id FROM job_email_message_refs WHERE message_id=?').get('reply-web-message-1').id;

  // Link the inbound message to the application, exactly as a `linked`
  // correlation would, so the lifecycle binds the application register.
  db.prepare(`
    INSERT INTO job_email_correlations(message_ref_id, facts_digest, resolution, resolved_application_id, correlation_json, correlation_digest)
    VALUES (?,?,?,?,?,?)
  `).run(messageRefId, digest(facts), 'linked', applicationId, JSON.stringify({ resolution: 'linked' }), sha256('linked-correlation'));
  db.prepare(`
    INSERT INTO job_email_application_links(message_ref_id, application_id, relation, proposal_id)
    VALUES (?,?,?,NULL)
  `).run(messageRefId, applicationId, 'reviewed-test-link');

  const context = buildDraftReplyContext(db, SOURCE);
  issueDraftReplyRequest(db, {
    requestId: 'reply-web-req-1', issuedBy: 'Cole', expectedSourceStateSha256: context.sourceStateSha256,
    idempotencyKey: 'reply-web:issue', source: SOURCE
  });

  // Real record: writes the recipient-locked reply proposal (carrying a PRIVATE
  // body) AND the mandatory draft-provenance receipt bound to the issue request,
  // driving the real draft-reply record path (with the isolated proposal double).
  const proposal = makeReplyProposal(facts, context.sourceStateSha256);
  const proposalDigest = digest(proposal);
  const provenance = makeProvenance(facts, proposal, context.sourceStateSha256);
  recordDraftReplyResult(db, { requestId: 'reply-web-req-1', proposal, provenance }, 'reply-web:record', RECORD_DEPS);

  // Real approval: binds the exact digest and emits email-send-request.v1 to the
  // DRY-RUN sink (drives the real reviewReplyDraft state machine, proposed->approved).
  const approved = approveDraftReplySend(db, {
    proposalId: proposal.proposalId,
    expectedProposalDigest: proposalDigest,
    approvedBy: 'owner+REPLY_APPROVER_SENTINEL@example.test',
    approvedAt: '2026-07-19T16:00:00.000Z',
    idempotencyKey: 'reply-web:approve'
  });

  // Real correlation: record a returned email-send-receipt.v1 (status: sent).
  correlateSendReceipt(db, {
    schemaVersion: 'email-send-receipt.v1', receiptId: 'reply-web-rcpt-1',
    requestId: approved.sendRequestId, idempotencyKey: approved.idempotencyKey,
    requestDigest: approved.sendRequestDigest, status: 'sent',
    provider: 'fixture', providerMessageId: 'provider-msg-web-1',
    observedAt: '2026-07-19T16:05:00.000Z'
  });

  return {
    draftProposalDigest: proposalDigest,
    approvedArtifactDigest: approved.approvedArtifactDigest,
    requestDigest: approved.sendRequestDigest,
    sourceStateSha256: context.sourceStateSha256
  };
}

const SOURCE = { provider: 'fixture', accountId: 'cole@example.test', messageId: 'reply-web-message-1', threadId: 'reply-web-thread-1' };

function makeFacts() {
  return {
    schemaVersion: 'job-application-email-facts.v1',
    trust: 'untrusted_external',
    source: {
      provider: 'fixture',
      accountId: 'cole@example.test',
      messageId: 'reply-web-message-1',
      threadId: 'reply-web-thread-1',
      receivedAt: '2026-07-17T18:00:00.000Z',
      fromAddress: FROM_ADDRESS,
      fromDomain: 'acme.example',
      replyToAddress: PRIVATE_ADDRESS,
      contentDigest: sha256('sanitized source content')
    },
    contentCompleteness: 'sanitized_plain_text',
    eventKind: 'recruiter_followup',
    company: { name: 'Acme', domain: 'acme.example' },
    postingRefs: [{ roleTitle: 'Platform Engineer' }],
    applicationRefs: [],
    replyRequested: true,
    evidence: [{ field: 'body', excerpt: PRIVATE_EVIDENCE }],
    extraction: { provider: 'fixture', version: '1', confidence: 0.95 },
    security: { risk: 'low', requiresReview: false }
  };
}

function makeReplyProposal(facts, sourceStateSha256) {
  return {
    schemaVersion: 'email-reply-draft-proposal.v2',
    proposalId: 'reply-web-1',
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
    body: PRIVATE_BODY,
    bodyDigest: sha256(PRIVATE_BODY),
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
    receiptId: 'reply-web-prov-1',
    draftProposalId: proposal.proposalId,
    draftProposalDigest: digest(proposal),
    factsDigest: digest(facts),
    sourceStateSha256,
    generatedBy: { provider: 'local-ubuntu', model: 'qwen', version: 'draft-reply.v1', routeAlias: 'frontier-default' },
    corpusSources: [
      { kind: 'inbox-facts', digest: digest(facts) },
      { kind: 'inbound-thread', ref: 'reply-web-thread-1', digest: sha256('thread') }
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

function makeFixture() {
  const { root: rootPath, home } = require('../test-support/migrated-store').createTestStore('jobtrack-reply-lifecycle-web-');
  const tmp = path.join(rootPath, 'tmp');
  fs.mkdirSync(tmp);
  return { root: rootPath, home, tmp };
}

function runCli(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }));
}

async function startServer(fixture) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      JOBTRACK_HOME: fixture.home,
      JOBTRACK_DB: path.join(fixture.home, 'jobtrack.db'),
      TMPDIR: fixture.tmp,
      HOST: '127.0.0.1',
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  fixture.server = { child, baseUrl, stderr: () => stderr };
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(250) });
      if (response.status === 200) return { child, baseUrl, stderr: () => stderr };
    } catch { /* listener not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start: ${stderr}`);
}

async function stopServer(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  const exited = once(instance.child, 'exit');
  instance.child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not exit: ${instance.stderr()}`)), 3000))
  ]);
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

function assertPrivateHeaders(headers) {
  assert.match(headers.get('cache-control') || '', /no-store/);
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.match(headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
