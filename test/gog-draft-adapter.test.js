'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGogDraftAdapter } = require('../scripts/lib/gog-draft-adapter.cjs');
const { digestCanonicalJson, digestUtf8Text } = require('../lib/email-outgoing-v2-contracts.js');

const ACCOUNT = 'applicant@example.com';
const RECIPIENT = 'careers@example.org';
const THREAD = '19abc123';
const SOURCE = '19abc456';
const RFC = '<invite-123@example.org>';
const ROOT_RFC = '<application-123@example.org>';

function approved(overrides = {}) {
  const body = 'Thank you. Tuesday at 10:00 AM Pacific works for me.';
  return {
    schemaVersion: 'email-approved-content.v1', normalizationVersion: 'email-text-nfc-lf.v1',
    contentId: 'content-0001', generationId: 'generation-0001', manifestDigest: 'a'.repeat(64),
    provider: 'gog_gmail', accountId: ACCOUNT, recipient: RECIPIENT,
    thread: { threadId: THREAD, inReplyTo: RFC, references: [ROOT_RFC, RFC] },
    subject: 'Re: Interview scheduling', body: { mediaType: 'text/plain', text: body, digest: digestUtf8Text(body) },
    attachments: [], sendFidelity: 'content_equivalent', requiresHumanApproval: true,
    createdAt: '2026-09-08T01:00:00.000Z', ...overrides
  };
}
function source() {
  return { message: { id: SOURCE, threadId: THREAD, labelIds: ['INBOX'], payload: { headers: [
    { name: 'From', value: `Recruiting <${RECIPIENT}>` }, { name: 'To', value: ACCOUNT },
    { name: 'Subject', value: 'Interview scheduling' }, { name: 'Message-ID', value: RFC },
    { name: 'References', value: ROOT_RFC }
  ] } } };
}
function fullSource(body = 'Cafe\u0301\r\nTuesday at 10:00 AM.\rThank you.') {
  const result = source();
  result.body = body;
  Object.assign(result.message.payload, { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') } },
    { mimeType: 'application/pdf', filename: 'private-attachment.pdf', body: { attachmentId: 'never-fetch' } }
  ] });
  result.attachments = [{ attachmentId: 'never-return', filename: 'private-attachment.pdf' }];
  return result;
}
function nativeDraft(content, id = 'r-draft-1') {
  return { draft: { id, message: { id: '19abc789', threadId: THREAD, labelIds: ['DRAFT'], payload: {
    mimeType: 'text/plain', headers: [
      { name: 'From', value: `Applicant <${ACCOUNT}>` }, { name: 'To', value: RECIPIENT },
      { name: 'Subject', value: content.subject }, { name: 'In-Reply-To', value: RFC },
      { name: 'References', value: content.thread.references.join(' ') },
      { name: 'Content-Type', value: 'text/plain; charset=utf-8' }
    ], body: { data: Buffer.from(`${content.body.text}\r\n`).toString('base64url') }
  } } } };
}
function harness(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-gog-draft-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journalDir = path.join(directory, 'operations');
  const content = options.content ?? approved();
  const input = { operationId: 'operation-0001', approvedContent: content,
    contentDigest: digestCanonicalJson(content), replyToProviderMessageId: SOURCE };
  const calls = []; const drafts = new Map();
  const runCommand = async (exe, argv, opts) => {
    calls.push({ exe, argv, opts });
    assert.equal(exe, '/test/gog');
    assert.equal(argv[argv.indexOf('--account') + 1], ACCOUNT);
    assert.ok(argv.includes('--gmail-no-send'));
    assert.equal(opts.shell, false);
    assert.ok(!argv.some(v => v === 'send' || v === 'update' || v === 'delete'));
    const command = argv.slice(argv.indexOf('gmail'));
    if (options.intercept) {
      const intercepted = await options.intercept({ command, opts, drafts, content, calls });
      if (intercepted !== undefined) return intercepted;
    }
    let out;
    if (command[1] === 'get') out = source();
    else if (command[2] === 'list') out = { drafts: [...drafts.keys()].map(id => ({ id, threadId: THREAD })), nextPageToken: '' };
    else if (command[2] === 'create') {
      assert.equal(opts.input, content.body.text);
      assert.ok(command.includes('--body-file=-'));
      assert.ok(command.includes(`--reply-to-message-id=${SOURCE}`));
      assert.ok(!command.some(v => v.startsWith('--thread-id') || v.startsWith('--reply-all') || v.startsWith('--cc') || v.startsWith('--bcc')));
      drafts.set('r-draft-1', nativeDraft(content));
      out = { draftId: 'r-draft-1', threadId: THREAD, message: { id: '19abc789', threadId: THREAD } };
    } else if (command[2] === 'get') out = drafts.get(command[3]);
    else assert.fail(`unexpected command ${command[1]}`);
    return { status: 0, stdout: JSON.stringify(out), stderr: '' };
  };
  const factoryOptions = { accountId: ACCOUNT, recipient: RECIPIENT, journalDir, gogPath: '/test/gog', runCommand };
  const adapter = createGogDraftAdapter(factoryOptions);
  return { directory, journalDir, content, input, calls, drafts, adapter, factoryOptions };
}
function replaceHeader(message, name, value) {
  message.payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase()).value = value;
}
function json(out) { return { status: 0, stdout: JSON.stringify(out), stderr: '' }; }
function creates(h) { return h.calls.filter(c => c.argv.includes('create')).length; }

test('native source metadata is recipient/thread bound and derives real RFC references', async t => {
  const h = harness(t);
  assert.deepEqual(await h.adapter.readSource({ providerMessageId: SOURCE, expectedThreadId: THREAD }), {
    rfcMessageId: RFC, references: [ROOT_RFC, RFC], subject: 'Interview scheduling', threadId: THREAD,
    fromAddress: RECIPIENT, replyToAddress: null, toAddress: ACCOUNT
  });
  assert.equal(creates(h), 0);
  assert.ok(h.calls[0].argv.includes('--format=metadata'));
  assert.equal(fs.existsSync(h.journalDir), false);
});

test('full source uses one read-only native command and returns normalized body without attachment/provider payload', async t => {
  const h = harness(t, { intercept({ command }) { if (command[1] === 'get') return json(fullSource()); } });
  const result = await h.adapter.readSourceBody({ providerMessageId: SOURCE, expectedThreadId: THREAD });
  assert.deepEqual(result, { rfcMessageId: RFC, references: [ROOT_RFC, RFC], subject: 'Interview scheduling',
    threadId: THREAD, fromAddress: RECIPIENT, replyToAddress: null, toAddress: ACCOUNT,
    body: 'Café\nTuesday at 10:00 AM.\nThank you.' });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].argv.slice(h.calls[0].argv.indexOf('gmail')), ['gmail', 'get', SOURCE, '--format=full']);
  assert.ok(h.calls[0].argv.includes('--enable-commands-exact=gmail.get'));
  assert.ok(h.calls[0].argv.includes('--client=default'));
  assert.ok(h.calls[0].argv.includes('--no-input'));
  assert.equal(h.calls[0].opts.maxBuffer, 2 * 1024 * 1024);
  assert.equal(h.calls[0].opts.input, undefined);
  assert.equal(fs.existsSync(h.journalDir), false);
  assert.ok(!JSON.stringify(result).includes('private-attachment'));
});

test('full source shares all metadata identity gates before returning body', async t => {
  for (const mutate of [
    m => { m.id = 'wrong'; }, m => { m.threadId = 'wrong'; },
    m => replaceHeader(m, 'From', 'other@example.org'), m => replaceHeader(m, 'To', 'other@example.com'),
    m => m.payload.headers.push({ name: 'Reply-To', value: 'other@example.org' }),
    m => m.payload.headers.push({ name: 'Cc', value: 'other@example.org' }),
    m => m.payload.headers.push({ name: 'Bcc', value: 'other@example.org' }),
    m => m.payload.headers.push({ name: 'From', value: RECIPIENT }),
    m => replaceHeader(m, 'Message-ID', SOURCE),
    m => { m.labelIds = ['DRAFT']; }, m => { m.labelIds = ['SENT']; }
  ]) {
    const h = harness(t, { intercept() { const out = fullSource(); mutate(out.message); return json(out); } });
    await assert.rejects(h.adapter.readSourceBody({ providerMessageId: SOURCE, expectedThreadId: THREAD }));
    assert.equal(h.calls.length, 1); assert.equal(fs.existsSync(h.journalDir), false);
  }
});

test('full source rejects unavailable/oversized/attachment bodies and redacts provider failures', async t => {
  for (const mutate of [
    r => { delete r.body; }, r => { r.body = ''; }, r => { r.body = '\ud800'; },
    r => { r.body = 'x'.repeat(2 * 1024 * 1024); },
    r => { r.message.payload.parts[0].filename = 'attached.txt'; },
    r => { r.message.payload.parts[0].headers = [{ name: 'Content-Disposition', value: 'attachment' }]; },
    r => { r.message.payload.mimeType = 'message/rfc822'; }
  ]) {
    const h = harness(t, { intercept() { const out = fullSource(); mutate(out); return json(out); } });
    await assert.rejects(h.adapter.readSourceBody({ providerMessageId: SOURCE, expectedThreadId: THREAD }));
    assert.equal(creates(h), 0);
  }
  for (const result of [{ status: 1, stdout: 'private provider body', stderr: 'private token' },
    { status: 0, stdout: 'private not-json', stderr: '' }]) {
    const h = harness(t, { intercept() { return result; } });
    await assert.rejects(h.adapter.readSourceBody({ providerMessageId: SOURCE, expectedThreadId: THREAD }), error => {
      assert.ok(!String(error).includes('private')); return true;
    });
  }
});

test('full source rejects invalid preceding MIME candidates and attached fallback, and binds body to exact inline bytes', async t => {
  for (const firstData of ['%%%not-base64%%%', '====', ' ', 'YQ', Buffer.from('different inline body').toString('base64url')]) {
    const h = harness(t, { intercept() {
      const out = fullSource('attached fallback content');
      out.message.payload.parts = [
        { mimeType: 'text/plain', body: { data: firstData } },
        { mimeType: 'text/plain', filename: 'attached.txt', headers: [{ name: 'Content-Disposition', value: 'attachment' }],
          body: { data: Buffer.from(out.body).toString('base64url') } }
      ];
      return json(out);
    } });
    await assert.rejects(h.adapter.readSourceBody({ providerMessageId: SOURCE, expectedThreadId: THREAD }));
    assert.equal(h.calls.length, 1); assert.equal(fs.existsSync(h.journalDir), false);
  }
  const h = harness(t, { intercept() {
    const out = fullSource('plain body');
    out.body = 'provider projection does not match inline bytes';
    return json(out);
  } });
  await assert.rejects(h.adapter.readSourceBody({ providerMessageId: SOURCE, expectedThreadId: THREAD }),
    { code: 'GOG_DRAFT_SOURCE_BODY_PROVENANCE_MISMATCH' });
});

test('source permits only the exact base mailbox or its nonempty plus tag, never other aliases', async t => {
  for (const to of ['applicant+cycle-123@example.com', ACCOUNT]) {
    const h = harness(t, { intercept({ command }) {
      if (command[1] === 'get') { const out = source(); replaceHeader(out.message, 'To', to); return json(out); }
    } });
    assert.equal((await h.adapter.readSource({ providerMessageId: SOURCE, expectedThreadId: THREAD })).toAddress, to);
  }
  for (const to of ['applicant+@example.com', 'applicant+tag@other.com', 'applicant.other@example.com', 'other+applicant@example.com', 'applicant@example.com, other@example.com']) {
    const h = harness(t, { intercept({ command }) {
      if (command[1] === 'get') { const out = source(); replaceHeader(out.message, 'To', to); return json(out); }
    } });
    await assert.rejects(h.adapter.readSource({ providerMessageId: SOURCE, expectedThreadId: THREAD }));
  }
});

test('repeated Received and DKIM headers do not relax singular identity headers', async t => {
  const h = harness(t, { intercept({ command, drafts }) {
    const out = command[1] === 'get' ? source() : command[2] === 'get' ? structuredClone(drafts.get(command[3])) : null;
    if (!out) return undefined;
    const message = out.message ?? out.draft.message;
    message.payload.headers.push(...['Received', 'Received', 'DKIM-Signature', 'DKIM-Signature'].map(name => ({ name, value: 'transport-metadata' })));
    return json(out);
  } });
  await h.adapter.ensureDraft(h.input);
});

test('one draft create, private durable journal, verified readback, and replay without another create', async t => {
  const h = harness(t);
  const evidence = await h.adapter.ensureDraft(h.input);
  assert.equal(evidence.provider, 'gog_gmail');
  assert.equal(evidence.providerDraftId, 'r-draft-1');
  assert.equal(evidence.providerThreadId, THREAD);
  assert.equal(evidence.contentDigest, h.input.contentDigest);
  assert.match(evidence.operationJournalEvidenceDigest, /^[a-f0-9]{64}$/);
  assert.match(evidence.providerEvidenceDigest, /^[a-f0-9]{64}$/);
  const replay = await createGogDraftAdapter(h.factoryOptions).ensureDraft(h.input);
  assert.equal(replay.providerDraftId, evidence.providerDraftId);
  assert.equal(creates(h), 1);
  assert.equal(fs.statSync(h.journalDir).mode & 0o777, 0o700);
  const files = fs.readdirSync(h.journalDir);
  assert.equal(files.length, 1);
  const recordPath = path.join(h.journalDir, files[0]);
  assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(recordPath)).state, 'verified');
  assert.ok(!fs.readFileSync(recordPath, 'utf8').includes(h.content.body.text));
  assert.ok(h.calls.every(c => !c.argv.some(a => a.includes(h.content.body.text))));
});

test('opaque colon draft IDs work at baseline, create ACK, readback and replay only', async t => {
  const draftId = 'r:9876543210123456789';
  const h = harness(t, { intercept({ command, content, drafts }) {
    if (command[2] === 'list') return json({ drafts: [{ id: 'r:1111111111111111111', threadId: 'other-thread' }], nextPageToken: '' });
    if (command[2] === 'create') {
      drafts.set(draftId, nativeDraft(content, draftId));
      return json({ draftId });
    }
    if (command[2] === 'get') assert.equal(command[3], draftId);
  } });
  assert.equal((await h.adapter.ensureDraft(h.input)).providerDraftId, draftId);
  assert.equal((await h.adapter.ensureDraft(h.input)).providerDraftId, draftId);
  assert.equal(creates(h), 1);
  for (const overrides of [{ operationId: 'operation:1' }, { replyToProviderMessageId: 'message:1' }]) {
    const count = h.calls.length;
    await assert.rejects(h.adapter.ensureDraft({ ...h.input, ...overrides }), { code: 'GOG_DRAFT_INVALID_ID' });
    assert.equal(h.calls.length, count);
  }
  await assert.rejects(h.adapter.readSource({ providerMessageId: SOURCE, expectedThreadId: 'thread:1' }), { code: 'GOG_DRAFT_INVALID_ID' });
});

test('draft ID validation rejects options, paths, whitespace, controls and overlong IDs before create', async t => {
  for (const id of [':starts-with-colon', '-option', '_prefix', 'r/path', 'r\\path', 'r id', 'r\nheader', 'r\0nul', '', 'r'.repeat(501)]) {
    const h = harness(t, { intercept({ command }) {
      if (command[2] === 'list') return json({ drafts: [{ id, threadId: THREAD }] });
    } });
    await assert.rejects(h.adapter.ensureDraft(h.input), { code: 'GOG_DRAFT_INVALID_ID' });
    assert.equal(creates(h), 0);
    assert.deepEqual(fs.readdirSync(h.journalDir), []);
  }
});

test('reusing an operation ID for different approved content is rejected before provider access', async t => {
  const h = harness(t);
  await h.adapter.ensureDraft(h.input);
  const count = h.calls.length;
  const changed = approved({ subject: 'A different subject' });
  await assert.rejects(h.adapter.ensureDraft({ ...h.input, approvedContent: changed, contentDigest: digestCanonicalJson(changed) }), { code: 'GOG_DRAFT_OPERATION_CONFLICT' });
  assert.equal(h.calls.length, count);
});

test('account/recipient/content digest and native source reply bindings fail before create', async t => {
  const variants = [
    { accountId: 'other@example.com' }, { recipient: 'stranger@example.org' },
    { thread: { threadId: THREAD, inReplyTo: '<invented@example.org>', references: [ROOT_RFC, RFC] } }
  ];
  for (const changes of variants) {
    const h = harness(t, { content: approved(changes) });
    await assert.rejects(h.adapter.ensureDraft(h.input));
    assert.equal(creates(h), 0);
  }
  const h = harness(t);
  await assert.rejects(h.adapter.ensureDraft({ ...h.input, contentDigest: 'f'.repeat(64) }), { code: 'GOG_DRAFT_CONTENT_BINDING_MISMATCH' });
  assert.equal(h.calls.length, 0);
});

test('source rejects wrong thread, sender, reply-to, To, extra recipients, duplicate headers, missing RFC ID and sent/draft labels', async t => {
  for (const mutate of [
    m => { m.threadId = 'wrong'; }, m => replaceHeader(m, 'From', 'other@example.org'),
    m => m.payload.headers.push({ name: 'Reply-To', value: 'other@example.org' }),
    m => replaceHeader(m, 'To', 'other@example.com'),
    m => m.payload.headers.push({ name: 'Cc', value: 'other@example.com' }),
    m => m.payload.headers.push({ name: 'Message-ID', value: RFC }),
    m => replaceHeader(m, 'Message-ID', SOURCE),
    m => { m.labelIds = ['DRAFT']; }, m => { m.labelIds = ['SENT']; }
  ]) {
    const h = harness(t, { intercept({ command }) { if (command[1] === 'get') { const out = source(); mutate(out.message); return json(out); } } });
    await assert.rejects(h.adapter.ensureDraft(h.input));
    assert.equal(creates(h), 0);
  }
});

test('readback rejects changed headers, added recipients/attachments, wrong thread, wrong bytes, missing DRAFT, and sent labels', async t => {
  for (const mutate of [
    m => replaceHeader(m, 'Subject', 'Changed'), m => replaceHeader(m, 'To', 'other@example.org'),
    m => replaceHeader(m, 'From', 'other@example.com'),
    m => replaceHeader(m, 'In-Reply-To', '<wrong@example.org>'),
    m => replaceHeader(m, 'References', RFC),
    m => m.payload.headers.push({ name: 'Bcc', value: 'other@example.org' }),
    m => m.payload.headers.push({ name: 'Content-Disposition', value: 'attachment' }),
    m => m.payload.headers.push({ name: 'To', value: RECIPIENT }),
    m => { m.payload.filename = 'file.pdf'; }, m => { m.payload.parts = [{}]; },
    m => { m.payload.mimeType = 'text/html'; }, m => { m.threadId = 'wrong'; },
    m => { m.payload.body.data = Buffer.from('Different text').toString('base64url'); },
    m => { m.labelIds = ['SENT']; }, m => { m.labelIds = []; }
  ]) {
    const h = harness(t, { intercept({ command, drafts }) {
      if (command[2] === 'get') { const out = structuredClone(drafts.get(command[3])); mutate(out.draft.message); return json(out); }
    } });
    await assert.rejects(h.adapter.ensureDraft(h.input));
    await assert.rejects(h.adapter.ensureDraft(h.input));
    assert.equal(creates(h), 1);
  }
});

test('input parent/content bindings are snapshotted before asynchronous native reads', async t => {
  let h;
  h = harness(t, { intercept({ command }) {
    if (command[1] === 'get') {
      h.input.replyToProviderMessageId = 'different-parent';
      h.input.contentDigest = 'f'.repeat(64);
      h.input.operationId = 'different-operation';
    }
  } });
  const originalDigest = h.input.contentDigest;
  const evidence = await h.adapter.ensureDraft(h.input);
  assert.equal(evidence.contentDigest, originalDigest);
  assert.ok(h.calls.find(c => c.argv.includes('create')).argv.includes(`--reply-to-message-id=${SOURCE}`));
});

test('allows only deterministic MIME terminal CRLF framing, not trimmed whitespace', async t => {
  for (const suffix of [' ', '\n\n', '\t']) {
    const h = harness(t, { intercept({ command, drafts, content }) {
      if (command[2] === 'get') { const out = structuredClone(drafts.get(command[3])); out.draft.message.payload.body.data = Buffer.from(content.body.text + suffix).toString('base64url'); return json(out); }
    } });
    await assert.rejects(h.adapter.ensureDraft(h.input), { code: 'GOG_DRAFT_READBACK_MISMATCH' });
  }
  const body = 'Thank you.\n';
  const h = harness(t, { content: approved({ body: { mediaType: 'text/plain', text: body, digest: digestUtf8Text(body) } }), intercept({ command, drafts, content }) {
    if (command[2] === 'get') { const out = structuredClone(drafts.get(command[3])); out.draft.message.payload.body.data = Buffer.from(content.body.text.replace(/\n/g, '\r\n')).toString('base64url'); return json(out); }
  } });
  await h.adapter.ensureDraft(h.input);
});

test('RFC2047 UTF-8 subject readback is decoded without altering approved content', async t => {
  const content = approved({ subject: 'Re: Café scheduling' });
  const h = harness(t, { content, intercept({ command, drafts }) {
    if (command[2] === 'get') { const out = structuredClone(drafts.get(command[3])); replaceHeader(out.draft.message, 'Subject', `=?UTF-8?B?${Buffer.from(content.subject).toString('base64')}?=`); return json(out); }
  } });
  await h.adapter.ensureDraft(h.input);
});

test('create ACK loss remains reconcile-only even with one or no matching native candidates', async t => {
  for (const physicalCreate of [true, false]) {
    const h = harness(t, { intercept({ command, drafts, content }) {
      if (command[2] === 'create') {
        if (physicalCreate) drafts.set('r-uncertain', nativeDraft(content, 'r-uncertain'));
        return { status: 1, stdout: '', stderr: 'SECRET transport details should never escape' };
      }
    } });
    await assert.rejects(h.adapter.ensureDraft(h.input), { code: 'GOG_DRAFT_CREATE_UNCERTAIN', message: 'GOG_DRAFT_CREATE_UNCERTAIN' });
    await assert.rejects(createGogDraftAdapter(h.factoryOptions).ensureDraft(h.input), error => {
      assert.equal(error.code, 'GOG_DRAFT_RECONCILE_REQUIRED');
      assert.deepEqual(error.candidateDraftIds, physicalCreate ? ['r-uncertain'] : []);
      return true;
    });
    assert.equal(creates(h), 1);
  }
});

test('readback timeout after known create ID is recoverable only by reread', async t => {
  let unavailable = true;
  const h = harness(t, { intercept({ command }) {
    if (command[2] === 'get' && unavailable) return { status: 1, stderr: 'unavailable' };
  } });
  await assert.rejects(h.adapter.ensureDraft(h.input), { code: 'GOG_DRAFT_PROVIDER_COMMAND_FAILED' });
  unavailable = false;
  const evidence = await h.adapter.ensureDraft(h.input);
  assert.equal(evidence.providerDraftId, 'r-draft-1');
  assert.equal(creates(h), 1);
});

test('concurrent operations share an exclusive journal lock', async t => {
  let unblock; let entered;
  const inCreate = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { unblock = resolve; });
  const h = harness(t, { async intercept({ command }) { if (command[2] === 'create') { entered(); await blocked; } } });
  const first = h.adapter.ensureDraft(h.input);
  await inCreate;
  await assert.rejects(h.adapter.ensureDraft({ ...h.input, operationId: 'operation-0002' }), { code: 'GOG_DRAFT_OPERATION_BUSY' });
  unblock(); await first;
  assert.equal(creates(h), 1);
});

test('fail closed on private-source paths, unsafe journal permissions, symlinks and crash-owned locks', async t => {
  const h = harness(t);
  assert.throws(() => createGogDraftAdapter({ ...h.factoryOptions, journalDir: path.join(os.homedir(), '.openclaw', 'workspace-private-journal', 'drafts') }), { code: 'PRIVATE_JOURNAL_SOURCE_PROHIBITED' });
  fs.mkdirSync(h.journalDir, { mode: 0o755 });
  await assert.rejects(h.adapter.ensureDraft(h.input), { code: 'GOG_DRAFT_JOURNAL_NOT_PRIVATE' });
  fs.chmodSync(h.journalDir, 0o700);
  fs.writeFileSync(path.join(h.journalDir, '.gog-draft.lock'), '{}', { mode: 0o600 });
  await assert.rejects(h.adapter.ensureDraft(h.input), { code: 'GOG_DRAFT_OPERATION_BUSY' });
  assert.equal(h.calls.length, 0);
  const other = path.join(h.directory, 'link'); fs.symlinkSync(h.journalDir, other);
  await assert.rejects(createGogDraftAdapter({ ...h.factoryOptions, journalDir: other }).ensureDraft(h.input), { code: 'GOG_DRAFT_JOURNAL_NOT_PRIVATE' });
});

test('bounded pagination fails before any create and subprocess failures never leak output', async t => {
  const h = harness(t, { intercept({ command, calls }) {
    if (command[2] === 'list') return json({ drafts: [], nextPageToken: `page-${calls.length}` });
  } });
  await assert.rejects(h.adapter.ensureDraft(h.input), { code: 'GOG_DRAFT_RECONCILIATION_LIMIT' });
  assert.equal(creates(h), 0);
  const failed = harness(t, { intercept() { throw new Error('SECRET arbitrary provider diagnostics'); } });
  await assert.rejects(failed.adapter.readSource({ providerMessageId: SOURCE, expectedThreadId: THREAD }), { code: 'GOG_DRAFT_PROVIDER_COMMAND_FAILED', message: 'GOG_DRAFT_PROVIDER_COMMAND_FAILED' });
});
