'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeStore } = require('../test-support/outgoing-live-seed');
const { importFacts, recordCorrelation, correlateEmailReadOnly } = require('../lib/email-integration');
const { readReviewProjection } = require('../lib/email-outgoing-v2');
const { prepareClarification, parseArgs } = require('../scripts/prepare-clarification-draft.cjs');

test('external clarification recipe records genuine-adapter draft evidence, never approves/sends, and replays', async (t) => {
  const { home, db } = makeStore();
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const cli = (args) => JSON.parse(execFileSync(process.execPath,
    [path.resolve(__dirname, '../bin/jobtrack.js'), ...args, '--json'],
    { env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8', stdio: 'pipe' }));
  cli(['profile', 'set-contact', '--name', 'Test Applicant', '--source', 'test']);
  const second = cli(['add-application', '--company', 'Drove', '--role', 'Designer', '--status', 'applied']).application.id;
  db.prepare("UPDATE companies SET website_domain='mydrove.com' WHERE normalized_name='drove'").run();
  const facts = {
    schemaVersion: 'job-application-email-facts.v2', trust: 'untrusted_external',
    source: { provider: 'gmail_gog', accountId: 'applicant@example.test', messageId: '18abcdef001',
      threadId: '18abcdef002', receivedAt: new Date().toISOString(), fromAddress: 'careers@mydrove.com',
      fromDomain: 'mydrove.com', contentDigest: 'a'.repeat(64) },
    contentCompleteness: 'sanitized_plain_text', eventKind: 'recruiter_followup',
    company: { name: 'Drove', domain: 'mydrove.com' }, postingRefs: [], applicationRefs: [], replyRequested: true,
    evidence: [{ field: 'subject', excerpt: 'Quick question' }, { field: 'body', excerpt: 'Please send your availability.' }],
    extraction: { provider: 'inbox-pipeline', version: 'test', confidence: 0.95 },
    security: { risk: 'medium', requiresReview: true }
  };
  const imported = importFacts(db, facts, 'external-clarify-import');
  recordCorrelation(db, correlateEmailReadOnly(db, facts), 'external-clarify-correlate');
  fs.writeFileSync(path.join(home, 'send-allowlist.json'), JSON.stringify({ addresses: ['careers@mydrove.com'], domains: [] }));
  const native = { rfcMessageId: '<actual@mydrove.com>', references: ['<actual@mydrove.com>'],
    fromAddress: 'careers@mydrove.com', replyToAddress: null, subject: 'Quick question' };
  let calls = 0;
  const adapter = { readSource: async () => native, ensureDraft: async ({ approvedContent }) => {
    calls += 1;
    assert.equal(approvedContent.thread.inReplyTo, native.rfcMessageId);
    return { providerDraftId: 'r-987', providerThreadId: facts.source.threadId, observedAt: new Date().toISOString() };
  } };
  const args = { messageRefId: String(imported.messageRefId), candidates: `1,${second}` };
  const first = await prepareClarification(args, { home, adapterFactory: () => adapter });
  assert.equal(first.deliveryState, 'awaiting_review');
  const replay = await prepareClarification(args, { home, adapterFactory: () => adapter });
  assert.equal(first.proposalId, replay.proposalId);
  assert.equal(calls, 2);
  assert.equal(readReviewProjection(db, first.proposalId).draftReceipt.providerDraftId, 'r-987');
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_approval_receipts_v2').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM job_email_send_requests_v2').get().n, 0);
});

test('clarification recipe validates CLI flags and positive candidate identifiers', () => {
  assert.deepEqual(parseArgs(['--message-ref-id', '1', '--candidates', '2,3', '--json']),
    { messageRefId: '1', candidates: '2,3', json: true });
  for (const args of [[], ['--wat'], ['--message-ref-id', '1', '--candidates', '2'],
    ['--message-ref-id', '1', '--candidates', '0,3'], ['--message-ref-id', '1', '--message-ref-id', '2']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('terminal clarifications never touch the mailbox or produce another draft', async () => {
  for (const status of ['answered', 'expired']) {
    const result = await prepareClarification({ messageRefId: '1', candidates: '2,3' }, {
      home: '/tmp/jobtrack-terminal-clarification-test',
      runCli: () => ({ status, proposalId: 'already-terminal' }),
      adapterFactory: () => assert.fail('terminal clarification cannot access provider')
    });
    assert.equal(result.status, status);
  }
});
