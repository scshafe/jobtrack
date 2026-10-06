'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeStore } = require('../test-support/outgoing-live-seed');
const { emailFixtures } = require('../test-support/outgoing-v2-fixtures');
const { prepareReply, parseArgs } = require('../scripts/prepare-reply-draft.cjs');
const { autoApproveProposal } = require('../lib/email-auto-approval');
const { digestCanonicalJson } = require('../lib/email-outgoing-v2-contracts');
const { createGogDraftAdapter } = require('../scripts/lib/gog-draft-adapter.cjs');

function setup(t) {
  const { home, db } = makeStore();
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const facts = JSON.parse(fs.readFileSync(path.join(emailFixtures, 'job-application-email-facts.v2.json'), 'utf8'));
  Object.assign(facts.source, { provider: 'gmail_gog', messageId: '18abcdef001', threadId: '18abcdef002' });
  const input = path.join(home, 'facts.json');
  fs.writeFileSync(input, JSON.stringify(facts));
  execFileSync(process.execPath, [path.resolve(__dirname, '../bin/jobtrack.js'), 'email', 'import-facts',
    '--input', input, '--idempotency-key', 'prepare-test-import', '--json'],
  { env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, stdio: 'pipe' });
  const sourceFile = path.join(home, 'source.json');
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(sourceFile, JSON.stringify(facts.source));
  fs.writeFileSync(bodyFile, 'Tuesday, September 15 at 10:00 AM CDT works for me.\n\nCole');
  fs.writeFileSync(path.join(home, 'send-allowlist.json'), JSON.stringify({ addresses: [facts.source.fromAddress], domains: [] }));
  let ensureCalls = 0;
  let observedAt;
  const native = { rfcMessageId: '<actual-message@example.test>', references: ['<actual-message@example.test>'],
    subject: 'Interview invitation', threadId: facts.source.threadId,
    fromAddress: facts.source.fromAddress, replyToAddress: facts.source.fromAddress };
  const adapter = {
    readSource: () => native,
    ensureDraft: ({ approvedContent, contentDigest }) => {
      ensureCalls += 1;
      assert.equal(approvedContent.thread.inReplyTo, native.rfcMessageId);
      assert.equal(contentDigest, digestCanonicalJson(approvedContent));
      observedAt ||= new Date().toISOString();
      return { providerDraftId: 'r-987654321', providerThreadId: facts.source.threadId, observedAt };
    }
  };
  return { home, db, adapter, native, calls: () => ensureCalls,
    args: { source: sourceFile, kind: 'agent', bodyFile, deliveryProvider: 'gog_gmail' } };
}

test('real CLI + separate sealer bind supplied prose, genuine-adapter evidence, and replay exactly', async (t) => {
  const s = setup(t);
  const first = await prepareReply(s.args, { home: s.home, adapterFactory: () => s.adapter });
  const second = await prepareReply(s.args, { home: s.home, adapterFactory: () => s.adapter });
  assert.equal(first.proposalId, second.proposalId);
  assert.equal(first.projectionDigest, second.projectionDigest);
  assert.equal(s.calls(), 2, 'every resume asks adapter to revalidate; adapter owns native create dedupe');
  const row = s.db.prepare('SELECT receipt_json FROM job_email_draft_receipts_v1 WHERE proposal_id=?').get(first.proposalId);
  const receipt = JSON.parse(row.receipt_json);
  assert.equal(receipt.providerDraftId, 'r-987654321');
  assert.equal(receipt.provider, 'gog_gmail');
  const approval = autoApproveProposal(s.db, { proposalId: first.proposalId, applicationId: 1, home: s.home });
  assert.equal(approval.approvalReceipt.scope.provider, 'gog_gmail');
  const directories = fs.readdirSync(path.join(s.home, 'outgoing-draft-operations'));
  const state = JSON.parse(fs.readFileSync(path.join(s.home, 'outgoing-draft-operations', directories[0], 'operation.json')));
  assert.equal(state.sealed.provenance.modelInvocations, 0);
  assert.equal(state.sealed.provenance.operation, 'seal_external_composition');
  assert.equal(state.issue.manifestDigest, digestCanonicalJson(state.manifest));
  assert.ok(Date.parse(receipt.observedAt) >= Date.parse(state.sealed.result.completedAt));
});

test('real CLI and sealer feed the real native adapter; colon draft IDs survive bounded list, create and readback', async (t) => {
  const s = setup(t);
  const source = JSON.parse(fs.readFileSync(s.args.source, 'utf8'));
  const draftId = 'r:9876543210123456789';
  const calls = [];
  let created;
  const adapterFactory = (options) => createGogDraftAdapter({ ...options, gogPath: '/test/gog',
    runCommand(executable, argv, opts) {
      assert.equal(executable, '/test/gog');
      assert.equal(argv[argv.indexOf('--account') + 1], source.accountId);
      assert.ok(argv.includes('--client=default') && argv.includes('--gmail-no-send'));
      assert.equal(opts.shell, false);
      const command = argv.slice(argv.indexOf('gmail'));
      calls.push(command);
      let output;
      if (command[1] === 'get') {
        assert.equal(command[2], source.messageId);
        output = { message: { id: source.messageId, threadId: source.threadId, labelIds: ['INBOX'], payload: {
          headers: [
            { name: 'From', value: source.fromAddress }, { name: 'To', value: source.accountId },
            { name: 'Subject', value: s.native.subject }, { name: 'Message-ID', value: s.native.rfcMessageId }
          ]
        } } };
      } else if (command[2] === 'list') {
        const secondPage = command.includes('--page=second-page');
        output = { drafts: [{ id: secondPage ? 'r:2222222222222222222' : 'r:1111111111111111111', threadId: 'other-thread' }],
          nextPageToken: secondPage ? '' : 'second-page' };
      } else if (command[2] === 'create') {
        assert.equal(created, undefined, 'only one physical create across replay');
        assert.ok(command.includes(`--reply-to-message-id=${source.messageId}`));
        assert.ok(command.includes('--body-file=-'));
        const subject = command.find(value => value.startsWith('--subject=')).slice('--subject='.length);
        created = { draft: { id: draftId, message: { id: '19abcdef003', threadId: source.threadId, labelIds: ['DRAFT'], payload: {
          mimeType: 'text/plain', headers: [
            { name: 'From', value: source.accountId }, { name: 'To', value: source.fromAddress },
            { name: 'Subject', value: subject }, { name: 'In-Reply-To', value: s.native.rfcMessageId },
            { name: 'References', value: s.native.rfcMessageId },
            { name: 'Content-Type', value: 'text/plain; charset=utf-8' }
          ], body: { data: Buffer.from(`${opts.input}\r\n`).toString('base64url') }
        } } } };
        output = { draftId, threadId: source.threadId };
      } else if (command[2] === 'get') {
        assert.equal(command[3], draftId);
        output = created;
      } else assert.fail('unexpected provider command');
      return { status: 0, stdout: JSON.stringify(output), stderr: '' };
    }
  });
  const first = await prepareReply(s.args, { home: s.home, adapterFactory });
  const second = await prepareReply(s.args, { home: s.home, adapterFactory });
  assert.equal(first.nativeDraftId, draftId);
  assert.equal(second.nativeDraftId, draftId);
  assert.equal(first.proposalId, second.proposalId);
  assert.equal(calls.filter(command => command[2] === 'create').length, 1);
  assert.equal(calls.filter(command => command[2] === 'list').length, 2);
  const receipt = JSON.parse(s.db.prepare('SELECT receipt_json FROM job_email_draft_receipts_v1 WHERE proposal_id=?').get(first.proposalId).receipt_json);
  assert.equal(receipt.provider, 'gog_gmail', 'the real sealer retains the delivery provider binding');
  assert.equal(receipt.providerDraftId, draftId);
  assert.equal(s.db.prepare('SELECT count(*) n FROM job_email_approval_receipts_v2').get().n, 0);
});

test('native failure records no receipt and grants no approval', async (t) => {
  const s = setup(t);
  s.adapter.ensureDraft = () => { throw new Error('NATIVE_DRAFT_RECONCILIATION_REQUIRED'); };
  await assert.rejects(() => prepareReply(s.args, { home: s.home, adapterFactory: () => s.adapter }), /RECONCILIATION_REQUIRED/);
  assert.equal(s.db.prepare('SELECT count(*) n FROM job_email_draft_receipts_v1').get().n, 0);
  assert.equal(s.db.prepare('SELECT count(*) n FROM job_email_approval_receipts_v2').get().n, 0);
});

test('source mismatch refuses before any domain draft or provider draft mutation', async (t) => {
  const s = setup(t);
  s.native.replyToAddress = 'attacker@example.test';
  await assert.rejects(() => prepareReply(s.args, { home: s.home, adapterFactory: () => s.adapter }), /NATIVE_SOURCE_MISMATCH/);
  assert.equal(s.db.prepare('SELECT count(*) n FROM job_email_outgoing_draft_requests').get().n, 0);
  assert.equal(s.calls(), 0);
});

test('unknown/duplicate flags, protected files, and implicit template fallback are refused', async (t) => {
  assert.throws(() => parseArgs(['--wat']), /INVALID_ARGUMENT/);
  assert.throws(() => parseArgs(['--kind', 'agent', '--kind', 'agent']), /INVALID_ARGUMENT/);
  await assert.rejects(() => prepareReply({ source: '/home/user/.openclaw/workspace-private-journal/forbidden' }), /PRIVATE_JOURNAL_SOURCE_PROHIBITED/);
  const s = setup(t);
  await assert.rejects(() => prepareReply({ ...s.args, kind: 'interview_invite' }, { home: s.home, adapterFactory: () => s.adapter }), /EXPLICIT_BODY_REQUIRED/);
});

test('old fixture helper fails closed instead of recording fictitious native evidence', () => {
  // This negative must refuse before store creation, so keep its home absent.
  assert.throws(() => execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/synthesize-welcome-draft.cjs')],
    { env: { ...process.env, JOBTRACK_HOME: '/nonexistent/never-created-jobtrack-test-store',
      JOBTRACK_DB: '/nonexistent/never-created-jobtrack-test-store/jobtrack.db' }, stdio: 'pipe' }),
  (error) => error.status === 2 && /FIXTURE_DRAFT_RECIPE_RETIRED/.test(String(error.stderr)));
});

test('existing recovery journals must stay owner-private and cannot be symlink inputs', async (t) => {
  const s = setup(t);
  await prepareReply(s.args, { home: s.home, adapterFactory: () => s.adapter });
  const directory = path.join(s.home, 'outgoing-draft-operations', fs.readdirSync(path.join(s.home, 'outgoing-draft-operations'))[0]);
  const stateFile = path.join(directory, 'operation.json');
  fs.chmodSync(stateFile, 0o644);
  await assert.rejects(() => prepareReply(s.args, { home: s.home, adapterFactory: () => s.adapter }), /DRAFT_JOURNAL_NOT_PRIVATE/);
  fs.chmodSync(stateFile, 0o600);
  const original = path.join(directory, 'saved-operation.json');
  fs.renameSync(stateFile, original);
  fs.symlinkSync(original, stateFile);
  await assert.rejects(() => prepareReply(s.args, { home: s.home, adapterFactory: () => s.adapter }), /DRAFT_JOURNAL_NOT_PRIVATE/);
});
