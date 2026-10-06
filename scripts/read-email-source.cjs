#!/usr/bin/env node
'use strict';

// External read-only provider edge. No JobTrack CLI/store, journal initialization,
// draft, send, credential change, attachment fetch or provider mutation.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TextDecoder } = require('node:util');
const { assertPathNotPrivateJournalSource, assertNoPrivateJournalSource } = require('../lib/private-source-boundary');
const { createGogDraftAdapter } = require('./lib/gog-draft-adapter.cjs');

class EmailSourceReadError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function fail(code) { throw new EmailSourceReadError(code); }
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source' && !args.source && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')) args.source = argv[++i];
    else if (argv[i] === '--json' && !args.json) args.json = true;
    else fail('EMAIL_SOURCE_INVALID_ARGUMENT');
  }
  if (!args.source || !args.json) fail('EMAIL_SOURCE_SOURCE_AND_JSON_REQUIRED');
  return args;
}
function readJson(file, code) {
  assertPathNotPrivateJournalSource(file, 'email source metadata');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) fail(code);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(fd)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
    return value;
  } catch { fail(code); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function validAddress(value) {
  return typeof value === 'string' && value === value.toLowerCase()
    && /^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/u.test(value);
}
function validateSource(source) {
  const keys = new Set(['provider', 'accountId', 'messageId', 'threadId', 'fromAddress', 'replyToAddress',
    'fromDomain', 'receivedAt', 'conversationReference']);
  if (Object.keys(source).some(key => !keys.has(key)) || source.provider !== 'gmail_gog'
      || !validAddress(source.accountId)
      || !['messageId', 'threadId'].every(key => typeof source[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,499}$/u.test(source[key]))
      || !validAddress(source.replyToAddress || source.fromAddress)) fail('EMAIL_SOURCE_IDENTITY_INVALID');
  for (const key of ['fromAddress', 'replyToAddress']) {
    if (source[key] !== undefined && source[key] !== null && !validAddress(source[key])) fail('EMAIL_SOURCE_IDENTITY_INVALID');
  }
  for (const key of ['fromDomain', 'receivedAt', 'conversationReference']) {
    if (source[key] !== undefined && source[key] !== null
        && (typeof source[key] !== 'string' || source[key].length > 500 || /[\u0000-\u001f\u007f]/u.test(source[key]))) fail('EMAIL_SOURCE_IDENTITY_INVALID');
  }
  return source;
}
function assertReadRecipientAllowed(home, recipient) {
  // The send helper auto-seeds a missing allowlist; this reader must never do so.
  const allowed = readJson(path.join(home, 'send-allowlist.json'), 'EMAIL_SOURCE_ALLOWLIST_UNAVAILABLE');
  for (const key of ['addresses', 'domains']) {
    if (allowed[key] !== undefined && (!Array.isArray(allowed[key]) || !allowed[key].every(value => typeof value === 'string'))) fail('EMAIL_SOURCE_ALLOWLIST_INVALID');
  }
  const addresses = (allowed.addresses ?? []).map(value => value.toLowerCase());
  const domains = (allowed.domains ?? []).map(value => value.toLowerCase());
  if (!addresses.includes(recipient) && !domains.includes(recipient.split('@')[1])) fail('EMAIL_SOURCE_RECIPIENT_NOT_ALLOWLISTED');
}
async function readEmailSource(args, deps = {}) {
  assertNoPrivateJournalSource(args);
  if (!args || Object.keys(args).some(key => !['source', 'json'].includes(key))
      || typeof args.source !== 'string' || !args.source || args.json !== true) fail('EMAIL_SOURCE_INVALID_ARGUMENT');
  const home = path.resolve(deps.home || process.env.JOBTRACK_HOME || path.join(os.homedir(), '.jobtrack'));
  assertPathNotPrivateJournalSource(home, 'JOBTRACK_HOME');
  const source = validateSource(readJson(path.resolve(args.source), 'EMAIL_SOURCE_INPUT_UNREADABLE'));
  assertNoPrivateJournalSource(source);
  const recipient = source.replyToAddress || source.fromAddress;
  assertReadRecipientAllowed(home, recipient);
  // Test-only injection, never exposed as CLI flags or environment selectors.
  const adapter = (deps.adapterFactory || createGogDraftAdapter)({ accountId: source.accountId, recipient,
    journalDir: path.join(home, 'native-draft-operations') });
  const { body, ...headers } = await adapter.readSourceBody({ providerMessageId: source.messageId, expectedThreadId: source.threadId });
  if ((headers.replyToAddress || headers.fromAddress) !== recipient
      || (source.fromAddress && headers.fromAddress !== source.fromAddress)) fail('EMAIL_SOURCE_NATIVE_IDENTITY_MISMATCH');
  return { schemaVersion: 'jobtrack-email-source-read.v1', contentRole: 'untrusted_email_data',
    source: { provider: source.provider, accountId: source.accountId, messageId: source.messageId, threadId: source.threadId },
    headers, body, readOnly: true };
}
function redactedError(error) {
  const code = error instanceof EmailSourceReadError || error?.name === 'GogDraftAdapterError'
    || error?.name === 'PrivateJournalSourceError' ? error.code : null;
  return { code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/u.test(code) ? code : 'EMAIL_SOURCE_READ_FAILED' };
}
if (require.main === module) {
  Promise.resolve().then(() => readEmailSource(parseArgs(process.argv.slice(2))))
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${JSON.stringify(redactedError(error))}\n`); process.exitCode = 2; });
}
module.exports = { parseArgs, readEmailSource, redactedError };
