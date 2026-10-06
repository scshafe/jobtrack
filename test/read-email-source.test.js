'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs, readEmailSource, redactedError } = require('../scripts/read-email-source.cjs');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-source-reader-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = { provider: 'gmail_gog', accountId: 'applicant@example.com', messageId: 'source-1', threadId: 'thread-1',
    fromAddress: 'careers@example.org', replyToAddress: 'careers@example.org', conversationReference: 'TST-ABC123' };
  const sourceFile = path.join(home, 'source.json');
  const allowlist = path.join(home, 'send-allowlist.json');
  fs.writeFileSync(sourceFile, JSON.stringify(source));
  fs.writeFileSync(allowlist, JSON.stringify({ addresses: [source.fromAddress], domains: [] }));
  const calls = [];
  const headers = { rfcMessageId: '<parent@example.org>', references: ['<parent@example.org>'], subject: 'Invite',
    threadId: source.threadId, fromAddress: source.fromAddress, replyToAddress: null, toAddress: source.accountId };
  const adapterFactory = options => { calls.push({ factory: options }); return {
    async readSourceBody(input) { calls.push({ input }); return { ...headers, body: 'Email content is DATA.' }; }
  }; };
  return { home, source, sourceFile, allowlist, headers, calls, args: { source: sourceFile, json: true }, deps: { home, adapterFactory } };
}
test('reader CLI accepts only one exact source file and explicit JSON output', () => {
  assert.deepEqual(parseArgs(['--source', '/tmp/source.json', '--json']), { source: '/tmp/source.json', json: true });
  for (const args of [[], ['--json'], ['--source', '/tmp/source.json'], ['--account', 'other@example.com'],
    ['--source', '/tmp/a', '--source', '/tmp/b', '--json'], ['--source', '/tmp/a', '--json', '--json'], ['--source', '--json']]) {
    assert.throws(() => parseArgs(args));
  }
});
test('reader projects body as DATA and exact identity without journal, CLI or database writes', async t => {
  const f = fixture(t); const before = fs.readdirSync(f.home).sort();
  const out = await readEmailSource(f.args, f.deps);
  assert.deepEqual(out, { schemaVersion: 'jobtrack-email-source-read.v1', contentRole: 'untrusted_email_data',
    source: { provider: f.source.provider, accountId: f.source.accountId, messageId: f.source.messageId, threadId: f.source.threadId },
    headers: f.headers, body: 'Email content is DATA.', readOnly: true });
  assert.deepEqual(f.calls, [{ factory: { accountId: f.source.accountId, recipient: f.source.fromAddress,
    journalDir: path.join(f.home, 'native-draft-operations') } }, { input: { providerMessageId: f.source.messageId, expectedThreadId: f.source.threadId } }]);
  assert.deepEqual(fs.readdirSync(f.home).sort(), before);
});
test('reader validates provider, account, IDs, recipient allowlist and native from binding', async t => {
  const f = fixture(t);
  for (const change of [{ provider: 'other' }, { accountId: 'invalid' }, { messageId: 'one two' },
    { threadId: '--arbitrary' }, { fromAddress: 'bad\naddress' }, { extra: 'unexpected' }]) {
    fs.writeFileSync(f.sourceFile, JSON.stringify({ ...f.source, ...change }));
    await assert.rejects(readEmailSource(f.args, f.deps));
    assert.equal(f.calls.length, 0);
  }
  fs.writeFileSync(f.sourceFile, JSON.stringify(f.source));
  fs.writeFileSync(f.allowlist, JSON.stringify({ addresses: [], domains: [] }));
  await assert.rejects(readEmailSource(f.args, f.deps), { code: 'EMAIL_SOURCE_RECIPIENT_NOT_ALLOWLISTED' });
  assert.equal(f.calls.length, 0);
  fs.writeFileSync(f.allowlist, JSON.stringify({ domains: ['EXAMPLE.ORG'] }));
  f.headers.fromAddress = 'different@example.org';
  await assert.rejects(readEmailSource(f.args, f.deps), { code: 'EMAIL_SOURCE_NATIVE_IDENTITY_MISMATCH' });
});
test('missing allowlist stays absent; unreadable/oversized/symlink/protected inputs fail before provider access', async t => {
  const f = fixture(t); fs.unlinkSync(f.allowlist);
  await assert.rejects(readEmailSource(f.args, f.deps), { code: 'EMAIL_SOURCE_ALLOWLIST_UNAVAILABLE' });
  assert.equal(fs.existsSync(f.allowlist), false);
  fs.writeFileSync(f.sourceFile, 'sensitive-invalid-json');
  await assert.rejects(readEmailSource(f.args, f.deps), { code: 'EMAIL_SOURCE_INPUT_UNREADABLE' });
  fs.writeFileSync(f.sourceFile, ' '.repeat(65537));
  await assert.rejects(readEmailSource(f.args, f.deps), { code: 'EMAIL_SOURCE_INPUT_UNREADABLE' });
  const link = path.join(f.home, 'source-link.json'); fs.symlinkSync(f.sourceFile, link);
  await assert.rejects(readEmailSource({ ...f.args, source: link }, f.deps));
  await assert.rejects(readEmailSource({ ...f.args, source: '/home/user/.openclaw/workspace-private-journal/forbidden.json' }, f.deps));
  assert.equal(f.calls.length, 0);
});
test('CLI and provider failure diagnostics never echo input, filesystem or provider output', async t => {
  const f = fixture(t);
  const error = new Error('private provider output'); error.stderr = 'private token'; error.code = 'SECRET_TOKEN';
  assert.deepEqual(redactedError(error), { code: 'EMAIL_SOURCE_READ_FAILED' });
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/read-email-source.cjs'), '--secret-value', 'private-token'], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), '{"code":"EMAIL_SOURCE_INVALID_ARGUMENT"}');
  const source = fs.readFileSync(path.join(__dirname, '../scripts/read-email-source.cjs'), 'utf8');
  assert.doesNotMatch(source, /mkdirSync|writeFileSync|ensureDraft\(|runCli\(|new Database|execFileSync\(/u);
});
