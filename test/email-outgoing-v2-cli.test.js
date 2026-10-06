'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createTestStore } = require('../test-support/migrated-store');
const { freePort } = require('../test-support/free-port');

const {
  digestCanonicalJson,
  projectApprovedContentFromProposal
} = require('../lib/email-outgoing-v2-contracts');
const {
  emailFixtures: fixtureRoot,
  verifyPinnedOutgoingV2Fixtures
} = require('../test-support/outgoing-v2-fixtures');

const cli = path.resolve(__dirname, '../bin/jobtrack.js');
verifyPinnedOutgoingV2Fixtures();

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, `${name}.json`), 'utf8'));
}

function writeJson(directory, name, value) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function runCli(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], {
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    encoding: 'utf8'
  }));
}

function failCli(home, args) {
  return spawnSync(process.execPath, [cli, ...args, '--json'], {
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    encoding: 'utf8'
  });
}

test('CLI is the bounded writer while approval/send/native-key operations fail closed without injected runtime', async (t) => {
  const { root: directory, home } = createTestStore('jobtrack-outgoing-cli-');
  let server;
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const facts = fixture('job-application-email-facts.v2');
  const factsFile = writeJson(directory, 'facts.json', facts);
  runCli(home, ['email', 'import-facts', '--input', factsFile, '--idempotency-key', 'outgoing-cli-import']);

  const issueInput = {
    schemaVersion: 'jobtrack-email-reply-draft-issue.v1',
    requestId: 'outgoing-cli-draft-request',
    idempotencyKey: 'outgoing-cli-draft-issue',
    generationId: 'outgoing-cli-generation',
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
    toneDecisionId: 'outgoing-cli-tone',
    toneDecisionDigest: 'b'.repeat(64),
    voiceRevisionId: 'outgoing-cli-voice',
    voiceRevisionDigest: 'c'.repeat(64),
    expiresAt: '2026-08-02T05:30:00.000Z'
  };
  const issueFile = writeJson(directory, 'issue.json', issueInput);
  const issued = runCli(home, ['email', 'outgoing-draft-issue', '--input', issueFile]);
  assert.equal(issued.request.execution.kind, 'standalone_out_of_process');
  assert.equal(issued.request.execution.toolAccess, 'none');
  assert.deepEqual(issued.request.effects, { mailboxRead: false, nativeDraft: false, send: false });
  assert.deepEqual(runCli(home, ['email', 'outgoing-draft-issue', '--input', issueFile]), issued);

  const proposal = fixture('email-reply-draft-proposal.v3');
  proposal.proposalId = 'outgoing-cli-proposal';
  proposal.generationId = issueInput.generationId;
  proposal.toneDecisionId = issueInput.toneDecisionId;
  proposal.voiceRevisionId = issueInput.voiceRevisionId;
  proposal.sourceStateSha256 = issued.request.sourceStateSha256;
  const content = projectApprovedContentFromProposal(proposal, {
    contentId: 'outgoing-cli-content',
    createdAt: '2026-08-01T05:30:00.000Z'
  });
  const resultInput = {
    schemaVersion: 'jobtrack-email-reply-draft-result.v1',
    resultId: 'outgoing-cli-result',
    requestId: issued.request.requestId,
    requestDigest: issued.requestDigest,
    proposal,
    approvedContent: content,
    usage: { runner: 'standalone_out_of_process', toolCalls: 0, toolsUsed: [], sideEffects: [] },
    completedAt: '2026-08-01T05:31:00.000Z',
    idempotencyKey: 'outgoing-cli-draft-record'
  };
  const resultFile = writeJson(directory, 'result.json', resultInput);
  const recorded = runCli(home, ['email', 'outgoing-draft-record', '--input', resultFile]);
  assert.equal(recorded.proposalId, proposal.proposalId);

  const receipt = fixture('email-draft-receipt.v1');
  receipt.receiptId = 'outgoing-cli-draft-receipt';
  receipt.draftProposalId = proposal.proposalId;
  receipt.draftProposalDigest = digestCanonicalJson(proposal);
  receipt.contentDigest = digestCanonicalJson(content);
  receipt.generationId = content.generationId;
  const captureFile = writeJson(directory, 'capture.json', {
    schemaVersion: 'jobtrack-email-draft-receipt-capture.v1',
    receipt,
    idempotencyKey: 'outgoing-cli-draft-capture'
  });
  const captured = runCli(home, ['email', 'outgoing-draft-receipt', '--input', captureFile]);
  assert.equal(captured.transmission, 'not_sent');

  const projection = runCli(home, [
    'email', 'outgoing-review', '--proposal-id', proposal.proposalId
  ]).projection;
  assert.equal(projection.approvedContent.body.text, proposal.body);
  assert.equal(projection.approvedContentDigest, digestCanonicalJson(content));

  const positive = {
    schemaVersion: 'jobtrack-email-outgoing-review-decision.v1',
    reviewId: 'outgoing-cli-positive-review',
    proposalId: proposal.proposalId,
    decision: 'approve',
    approver: { kind: 'human', id: 'synthetic-cli-human@example.test' },
    decidedAt: '2026-08-01T05:40:00.000Z',
    expectedProjectionDigest: projection.projectionDigest,
    expectedApprovedContentDigest: projection.approvedContentDigest,
    authenticatedChannel: {
      kind: 'jobtrack_fixed_command',
      channelId: 'jobtrack-owner-cli.v1',
      authenticated: true,
      authenticationReceiptDigest: '0'.repeat(64)
    },
    operationIdempotencyKey: 'outgoing-cli-positive-operation',
    approval: {
      approvalId: 'outgoing-cli-approval',
      idempotencyKey: 'outgoing-cli-one-send',
      expiresAt: '2026-08-01T06:40:00.000Z'
    }
  };
  const positiveFailure = failCli(home, [
    'email', 'outgoing-review-record', '--input', writeJson(directory, 'positive.json', positive)
  ]);
  assert.notEqual(positiveFailure.status, 0);
  assert.match(positiveFailure.stderr, /signer.*injected/i);

  const rejection = {
    schemaVersion: 'jobtrack-email-outgoing-review-decision.v1',
    reviewId: 'outgoing-cli-rejection',
    proposalId: proposal.proposalId,
    decision: 'reject',
    approver: { kind: 'human', id: 'synthetic-cli-human@example.test' },
    decidedAt: '2026-08-01T05:40:00.000Z',
    expectedProjectionDigest: projection.projectionDigest,
    expectedApprovedContentDigest: projection.approvedContentDigest,
    authenticatedChannel: {
      kind: 'jobtrack_fixed_command',
      channelId: 'jobtrack-owner-cli.v1',
      authenticated: true,
      authenticationReceiptDigest: '0'.repeat(64)
    },
    operationIdempotencyKey: 'outgoing-cli-rejection-operation',
    reason: 'Synthetic CLI rejection for a no-authority regression.'
  };
  rejection.authenticatedChannel.authenticationReceiptDigest = digestCanonicalJson({
    schemaVersion: 'jobtrack-email-authenticated-review-context.v1',
    reviewId: rejection.reviewId,
    proposalId: rejection.proposalId,
    decision: rejection.decision,
    approver: rejection.approver,
    decidedAt: rejection.decidedAt,
    expectedProjectionDigest: rejection.expectedProjectionDigest,
    expectedApprovedContentDigest: rejection.expectedApprovedContentDigest,
    rejectionReason: rejection.reason
  });
  const rejected = runCli(home, [
    'email', 'outgoing-review-record', '--input', writeJson(directory, 'rejection.json', rejection)
  ]);
  assert.equal(rejected.decision, 'reject');
  assert.equal(rejected.approvalReceipt, null);
  assert.equal(rejected.sendAuthority, false);

  const unavailableSend = failCli(home, [
    'email', 'outgoing-send-request', '--input', writeJson(directory, 'send-issue.json', {
      schemaVersion: 'jobtrack-email-send-request-issue.v1',
      requestId: 'outgoing-cli-send-request',
      approvalId: 'outgoing-cli-approval',
      operationIdempotencyKey: 'outgoing-cli-send-operation'
    })
  ]);
  assert.notEqual(unavailableSend.status, 0);
  assert.match(unavailableSend.stderr, /approvalKey.*injected/i);

  const db = new Database(path.join(home, 'jobtrack.db'), { readonly: true });
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_outgoing_review_events').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_approval_receipts_v2').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_send_requests_v2').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_send_receipt_correlations_v2').get().n, 0);
  db.close();

  server = await startServer(home, directory);
  const page = await fetch(`${server.baseUrl}/communications/replies`);
  const html = await page.text();
  assert.equal(page.status, 200, `${html}\n${server.stderr()}`);
  assert.match(html, /Current provider-neutral G03 exact review stays CLI-only/);
  // The page reads the LIVE lane now (2026-08-05): the proposal's lifecycle
  // METADATA renders — id, rejected state — while its content stays private.
  assert.match(html, new RegExp(`Outgoing reply ${escapeRegExp(proposal.proposalId)}`));
  assert.match(html, /Rejected/);
  for (const privateValue of [
    proposal.body,
    content.recipient,
    rejection.approver.id,
    rejection.reason
  ]) assert.doesNotMatch(html, new RegExp(escapeRegExp(privateValue), 'i'));
  const post = await fetch(`${server.baseUrl}/communications/replies`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});


async function startServer(home, directory) {
  const port = await freePort();
  const temporary = path.join(directory, `web-tmp-${port}`);
  fs.mkdirSync(temporary);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      JOBTRACK_HOME: home,
      JOBTRACK_DB: path.join(home, 'jobtrack.db'),
      TMPDIR: temporary,
      HOST: '127.0.0.1',
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
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

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  const exited = once(server.child, 'exit');
  server.child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not exit: ${server.stderr()}`)), 3000))
  ]);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
