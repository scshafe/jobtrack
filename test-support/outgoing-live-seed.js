'use strict';

// Shared seeding for outgoing-v2 live tests: a temp store with one imported
// message and one rendered, receipt-captured draft proposal (approval-ready).

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { after } = require('node:test');
const Database = require('better-sqlite3');
const { createTestHome } = require('./migrated-store');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');
const { issueDraftRequest, recordDraftResult, captureDraftReceipt } = require('../lib/email-outgoing-v2');
const { projectApprovedContentFromProposal, digestCanonicalJson } = require('../lib/email-outgoing-v2-contracts');
const { emailFixtures } = require('../test-support/outgoing-v2-fixtures');
const ownedStores = new Set();

// Some callers clean up per test; close and remove any helper-owned remainder
// after the file finishes, without changing the flat home layout they expect.
after(() => {
  for (const { home, db } of ownedStores) {
    if (db.open) db.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  ownedStores.clear();
});

function makeStore() {
  const home = createTestHome('jobtrack-auto-approval-');
  try {
    const env = { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') };
    execFileSync(process.execPath, [cli, 'add-application', '--company', 'Drove', '--role', 'Engineer', '--status', 'applied'],
      { cwd: root, env, stdio: 'pipe' });
    // Preserve the real email dispatch and its domain-specific migrations.
    execFileSync(process.execPath, [cli, 'email', 'approval-policy', '--json'],
      { cwd: root, env, stdio: 'pipe' });
    const fixture = { home, db: new Database(path.join(home, 'jobtrack.db')) };
    ownedStores.add(fixture);
    return fixture;
  } catch (error) {
    fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

function idFrom(seed, suffix) {
  return `t-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)}-${suffix}`;
}

/** Mirror of scripts/synthesize-welcome-draft.cjs: import the fixture facts,
 *  then issue + record one draft against that imported source. */
function seedDraft(home, db, seed, { deliveryProvider = 'apple_mail_automation', sourceMessageId = '18fa1', sourceThreadId = '18fa0' } = {}) {
  const facts = JSON.parse(fs.readFileSync(path.join(emailFixtures, 'job-application-email-facts.v2.json'), 'utf8'));
  if (deliveryProvider === 'gog_gmail') {
    facts.source.provider = 'gmail_gog';
    facts.source.messageId = sourceMessageId;
    facts.source.threadId = sourceThreadId;
  }
  const factsFile = path.join(home, `facts-${seed}.json`);
  fs.writeFileSync(factsFile, JSON.stringify(facts));
  execFileSync(process.execPath, [cli, 'email', 'import-facts', '--input', factsFile, '--idempotency-key', idFrom(seed, 'import'), '--json'],
    { cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, stdio: 'pipe' });

  const generationId = idFrom(seed, 'gen');
  const proposalId = idFrom(seed, 'proposal');
  // Baseline one minute in the past: every draft artifact (created, completed,
  // natively observed) must precede the wall-clock approval instant.
  const now = Date.now() - 60_000;
  const iso = (ms) => new Date(ms).toISOString();
  const issueInput = {
    schemaVersion: 'jobtrack-email-reply-draft-issue.v1',
    requestId: idFrom(seed, 'req'),
    idempotencyKey: idFrom(seed, 'issue'),
    generationId,
    manifestDigest: 'd'.repeat(64),
    source: {
      provider: facts.source.provider,
      accountId: facts.source.accountId,
      messageId: facts.source.messageId,
      threadId: facts.source.threadId,
      replyToAddress: facts.source.fromAddress,
      inReplyTo: `<${facts.source.messageId}@example.test>`,
      references: [`<${facts.source.messageId}@example.test>`]
    },
    delivery: { provider: deliveryProvider, accountId: facts.source.accountId },
    toneDecisionId: idFrom(seed, 'tone'),
    toneDecisionDigest: 'b'.repeat(64),
    voiceRevisionId: idFrom(seed, 'voice'),
    voiceRevisionDigest: 'c'.repeat(64),
    expiresAt: iso(now + 3 * 24 * 60 * 60 * 1000)
  };
  const issued = issueDraftRequest(db, issueInput);
  const proposal = JSON.parse(fs.readFileSync(path.join(emailFixtures, 'email-reply-draft-proposal.v3.json'), 'utf8'));
  proposal.proposalId = proposalId;
  proposal.generationId = generationId;
  proposal.manifestDigest = issued.request.manifestDigest;
  proposal.toneDecisionId = issueInput.toneDecisionId;
  proposal.toneDecisionDigest = issued.request.toneDecisionDigest;
  proposal.voiceRevisionId = issueInput.voiceRevisionId;
  proposal.voiceRevisionDigest = issued.request.voiceRevisionDigest;
  proposal.sourceStateSha256 = issued.request.sourceStateSha256;
  proposal.factsDigest = issued.request.factsDigest;
  proposal.expiresAt = issued.request.expiresAt;
  proposal.source = issued.request.source;
  proposal.delivery = issued.request.delivery;
  proposal.recipient = issued.request.source.replyToAddress;
  const content = projectApprovedContentFromProposal(proposal, {
    contentId: idFrom(seed, 'content'),
    createdAt: iso(now)
  });
  recordDraftResult(db, {
    schemaVersion: 'jobtrack-email-reply-draft-result.v1',
    resultId: idFrom(seed, 'result'),
    requestId: issued.request.requestId,
    requestDigest: issued.requestDigest,
    proposal,
    approvedContent: content,
    usage: { runner: 'standalone_out_of_process', toolCalls: 0, toolsUsed: [], sideEffects: [] },
    completedAt: iso(now + 1000),
    idempotencyKey: idFrom(seed, 'record')
  });
  // Positive approval requires captured native draft evidence.
  const receipt = JSON.parse(fs.readFileSync(path.join(emailFixtures, 'email-draft-receipt.v1.json'), 'utf8'));
  receipt.receiptId = idFrom(seed, 'receipt');
  receipt.draftProposalId = proposalId;
  receipt.draftProposalDigest = digestCanonicalJson(proposal);
  receipt.contentDigest = digestCanonicalJson(content);
  receipt.generationId = content.generationId;
  receipt.manifestDigest = content.manifestDigest;
  receipt.provider = content.provider;
  receipt.accountId = content.accountId;
  receipt.recipient = content.recipient;
  receipt.threadId = content.thread.threadId;
  receipt.observedAt = iso(now + 2000);
  captureDraftReceipt(db, {
    schemaVersion: 'jobtrack-email-draft-receipt-capture.v1',
    receipt,
    idempotencyKey: idFrom(seed, 'capture')
  });
  return proposalId;
}


module.exports = { makeStore, seedDraft, idFrom };
