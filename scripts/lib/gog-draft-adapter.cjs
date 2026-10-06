'use strict';

// External Gmail source-read/draft adapter. JobTrack's store never imports this
// module. Native evidence is returned only after Gmail readback; uncertain
// create is reconciliation-only, never a second physical create.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { assertPathNotPrivateJournalSource } = require('../../lib/private-source-boundary.js');
const { validateEmailApprovedContentV1, digestCanonicalJson, stableJson, copyInertData } = require('../../lib/email-outgoing-v2-contracts.js');
const { resolvePinnedGog } = require('./pinned-gog.cjs');
const { sanitizedGogEnvironment } = require('./gog-environment.cjs');

const SCHEMA = 'jobtrack-gog-draft-operation.v1';
const MAX_PAGES = 5;
const MAX_DRAFTS = 500;
const MAX_PROVIDER_BYTES = 2 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const IDENTITY_HEADERS = new Set(['from', 'to', 'cc', 'bcc', 'reply-to', 'subject', 'message-id',
  'in-reply-to', 'references', 'content-type', 'content-disposition', 'mime-version']);

class GogDraftAdapterError extends Error {
  constructor(code) { super(code); this.name = 'GogDraftAdapterError'; this.code = code; }
}
function fail(code) { throw new GogDraftAdapterError(code); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,500}$/.test(value)) fail('GOG_DRAFT_INVALID_ID');
  return value;
}
function draftIdentifier(value) {
  // Native Gmail draft IDs are opaque and may contain ':' (unlike the
  // message/thread IDs). Keep them a bounded, non-option argv value; do not
  // widen operation or source identity validation to accommodate draft IDs.
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,499}$/.test(value)) fail('GOG_DRAFT_INVALID_ID');
  return value;
}
function address(value) {
  if (typeof value !== 'string' || value !== value.toLowerCase()
      || !/^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(value)) {
    fail('GOG_DRAFT_INVALID_ADDRESS');
  }
  return value;
}
function header(value) {
  if (typeof value !== 'string' || value.length > 10000) fail('GOG_DRAFT_INVALID_HEADER');
  const unfolded = value.replace(/\r\n[ \t]+/g, ' ');
  if (/[\u0000-\u001f\u007f]/.test(unfolded)) fail('GOG_DRAFT_INVALID_HEADER');
  return unfolded.trim();
}
function mailbox(value) {
  const text = header(value);
  const match = /^[^<>,;]*<([^<>\s,;]+)>$/.exec(text);
  return address((match ? match[1] : text).toLowerCase());
}
function isAccountDeliveryAddress(delivery, account) {
  if (delivery === account) return true;
  const [local, domain] = delivery.split('@');
  const [accountLocal, accountDomain] = account.split('@');
  // Only the exact account or a non-empty plus tag on its exact localpart and
  // domain. No dot-folding, alternate domains, send-as aliases or reply-all.
  return domain === accountDomain && local.startsWith(`${accountLocal}+`) && local.length > accountLocal.length + 1;
}
function rfcId(value) {
  const id = header(value);
  if (!/^<[^\s<>@]+@[^\s<>@]+>$/.test(id)) fail('GOG_DRAFT_INVALID_RFC_MESSAGE_ID');
  return id;
}
function references(value) {
  const text = header(value);
  const refs = text ? text.split(/ +/).map(rfcId) : [];
  if (refs.length > 50 || new Set(refs).size !== refs.length) fail('GOG_DRAFT_INVALID_REFERENCES');
  return refs;
}
function headersOf(message) {
  const result = new Map();
  if (!Array.isArray(message?.payload?.headers)) fail('GOG_DRAFT_MISSING_HEADERS');
  for (const h of message.payload.headers) {
    const key = header(h.name).toLowerCase();
    // Even identical duplicate identity headers are not one unambiguous binding.
    if (result.has(key)) {
      if (IDENTITY_HEADERS.has(key) || key.startsWith('resent-')) fail('GOG_DRAFT_DUPLICATE_HEADER');
      continue; // Received/DKIM/ARC transport headers may legitimately repeat.
    }
    result.set(key, header(h.value));
  }
  return result;
}
function decodeSubject(value) {
  const text = header(value);
  // RFC2047 folding between adjacent encoded words is not visible whitespace.
  const decoded = text.replace(/\?= +(?==\?)/g, '?=').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_all, charset, encoding, encoded) => {
    if (!/^(?:utf-8|us-ascii)$/i.test(charset)) fail('GOG_DRAFT_UNSUPPORTED_CHARSET');
    let bytes;
    if (encoding.toLowerCase() === 'b') {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('GOG_DRAFT_INVALID_HEADER_ENCODING');
      bytes = Buffer.from(encoded, 'base64');
    } else {
      const q = encoded.replace(/_/g, ' ');
      if (/=(?![A-Fa-f0-9]{2})/.test(q) || /[^\x20-\x7e]/.test(q)) fail('GOG_DRAFT_INVALID_HEADER_ENCODING');
      bytes = Buffer.from(q.replace(/=([A-Fa-f0-9]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
    }
    try { return utf8.decode(bytes); } catch { fail('GOG_DRAFT_INVALID_UTF8'); }
  });
  if (decoded.includes('=?')) fail('GOG_DRAFT_INVALID_HEADER_ENCODING');
  return header(decoded).normalize('NFC');
}
function plainBody(message) {
  const part = message.payload;
  if (part.mimeType !== 'text/plain' || (part.parts?.length ?? 0) !== 0 || part.filename
      || part.body?.attachmentId || typeof part.body?.data !== 'string') fail('GOG_DRAFT_UNEXPECTED_MIME');
  const data = part.body.data;
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(data) || data.length > 200000) fail('GOG_DRAFT_INVALID_BODY_ENCODING');
  const bytes = Buffer.from(data, 'base64url');
  if (bytes.toString('base64url') !== data.replace(/=+$/, '')) fail('GOG_DRAFT_INVALID_BODY_ENCODING');
  try { return utf8.decode(bytes).replace(/\r\n/g, '\n').normalize('NFC'); }
  catch { fail('GOG_DRAFT_INVALID_UTF8'); }
}

function sourceBody(result) {
  if (typeof result?.body !== 'string' || !result.body.trim()
      || Buffer.byteLength(result.body, 'utf8') > MAX_PROVIDER_BYTES
      || /[\u0000\u000b\u000c\u000e-\u001f\u007f]/u.test(result.body)
      || !result.body.isWellFormed()) fail('GOG_DRAFT_SOURCE_BODY_UNAVAILABLE');
  // The pinned CLI's BestBodyText selects the first plain part, then HTML.
  // Ensure that selected part is inline body, never an attached text document
  // or a forwarded message. Other attachments are neither fetched nor returned.
  let count = 0;
  function find(part, wanted, attachment = false, depth = 0) {
    if (!part || typeof part !== 'object' || ++count > 1000 || depth > 20) fail('GOG_DRAFT_SOURCE_MIME_INVALID');
    const mime = String(part.mimeType ?? '').split(';')[0].trim().toLowerCase();
    const dispositions = (Array.isArray(part.headers) ? part.headers : [])
      .filter(h => String(h?.name).toLowerCase() === 'content-disposition');
    const attached = attachment || Boolean(part.filename || part.body?.attachmentId)
      || mime === 'message/rfc822' || dispositions.length > 1
      || dispositions.some(h => !/^inline(?:\s*;|$)/i.test(header(h.value)));
    if (mime === wanted && typeof part.body?.data === 'string' && part.body.data) {
      // Gog skips undecodable/empty candidates and may fall through to an
      // attachment. We deliberately refuse that ambiguity instead. Support
      // Gmail's normalized UTF-8 body; unsupported transfer/charset conversion
      // must not be mistaken for proof that the CLI selected this inline part.
      const data = part.body.data;
      if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(data)) fail('GOG_DRAFT_SOURCE_MIME_INVALID');
      const bytes = Buffer.from(data, 'base64url');
      if (bytes.toString('base64url') !== data.replace(/=+$/, '')) fail('GOG_DRAFT_SOURCE_MIME_INVALID');
      let decoded;
      try { decoded = utf8.decode(bytes); } catch { fail('GOG_DRAFT_SOURCE_MIME_INVALID'); }
      if (!decoded) fail('GOG_DRAFT_SOURCE_MIME_INVALID');
      return { attached, decoded };
    }
    if (part.parts !== undefined && !Array.isArray(part.parts)) fail('GOG_DRAFT_SOURCE_MIME_INVALID');
    for (const child of part.parts ?? []) { const selected = find(child, wanted, attached, depth + 1); if (selected) return selected; }
    return null;
  }
  const selected = find(result.message.payload, 'text/plain') ?? find(result.message.payload, 'text/html');
  if (!selected || selected.attached) fail('GOG_DRAFT_SOURCE_BODY_UNAVAILABLE');
  if (selected.decoded !== result.body) fail('GOG_DRAFT_SOURCE_BODY_PROVENANCE_MISMATCH');
  return result.body.replace(/\r\n?/g, '\n').normalize('NFC');
}

function checkedMetadata(file, directory) {
  assertPathNotPrivateJournalSource(file, 'Gmail draft journal');
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) fail('GOG_DRAFT_JOURNAL_NOT_PRIVATE');
  return stat;
}
function syncDirectory(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readJournal(file) {
  checkedMetadata(file, false);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 300000) fail('GOG_DRAFT_JOURNAL_INVALID');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error instanceof GogDraftAdapterError) throw error;
    fail('GOG_DRAFT_JOURNAL_INVALID');
  } finally { fs.closeSync(fd); }
}
function writeJournal(file, value) {
  assertPathNotPrivateJournalSource(file, 'Gmail draft journal');
  if (fs.existsSync(file)) checkedMetadata(file, false);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${stableJson(value)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  syncDirectory(path.dirname(file));
}

/** Factory seals the only account and recipient this external adapter can use.
 * runCommand is a test seam with spawnSync's (executable, argv, options) shape;
 * it may return a Promise. No subprocess output/errors are copied into errors.
 */
function createGogDraftAdapter({ accountId, recipient, journalDir, gogPath, runCommand = spawnSync } = {}) {
  address(accountId); address(recipient);
  for (const [label, value] of [['draft journal directory', journalDir], ['gog executable', gogPath]]) {
    if (label === 'gog executable' && value === undefined) continue;
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail('GOG_DRAFT_ABSOLUTE_PATH_REQUIRED');
    assertPathNotPrivateJournalSource(value, label);
  }
  const directory = path.resolve(journalDir);

  async function command(args, input, capabilities = 'gmail.get,gmail.drafts.list,gmail.drafts.get,gmail.drafts.create') {
    // Injectable subprocesses are tests only. Native execution never accepts
    // an installed/PATH/custom binary in place of the reviewed transport.
    const executable = runCommand === spawnSync ? resolvePinnedGog() : (gogPath ?? resolvePinnedGog());
    if (runCommand === spawnSync && gogPath !== undefined && gogPath !== executable) fail('GOG_DRAFT_UNPINNED_EXECUTABLE');
    let result;
    try {
      result = await runCommand(executable, ['--account', accountId, '--client=default', '--json', '--no-input', '--gmail-no-send',
        `--enable-commands-exact=${capabilities}`, ...args], {
        encoding: 'utf8', input, timeout: 30000, maxBuffer: MAX_PROVIDER_BYTES,
        env: sanitizedGogEnvironment(), shell: false
      });
    } catch { fail('GOG_DRAFT_PROVIDER_COMMAND_FAILED'); }
    if (!result || result.status !== 0 || result.error || result.signal) fail('GOG_DRAFT_PROVIDER_COMMAND_FAILED');
    if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout, 'utf8') > MAX_PROVIDER_BYTES) fail('GOG_DRAFT_PROVIDER_RESPONSE_INVALID');
    try { return JSON.parse(result.stdout); } catch { fail('GOG_DRAFT_PROVIDER_RESPONSE_INVALID'); }
  }

  function sourceMetadata(result, providerMessageId, expectedThreadId) {
    const message = result?.message;
    if (message?.id !== providerMessageId || message.threadId !== expectedThreadId
        || !Array.isArray(message.labelIds) || message.labelIds.includes('DRAFT') || message.labelIds.includes('SENT')) fail('GOG_DRAFT_SOURCE_IDENTITY_MISMATCH');
    const headers = headersOf(message);
    const fromAddress = mailbox(headers.get('from'));
    const replyToAddress = headers.has('reply-to') ? mailbox(headers.get('reply-to')) : null;
    const toAddress = mailbox(headers.get('to'));
    if (fromAddress !== recipient || (replyToAddress !== null && replyToAddress !== recipient)
        || !isAccountDeliveryAddress(toAddress, accountId) || headers.get('cc') || headers.get('bcc')) fail('GOG_DRAFT_SOURCE_RECIPIENT_MISMATCH');
    const rfcMessageId = rfcId(headers.get('message-id'));
    const refs = references(headers.get('references') ?? '');
    if (!refs.includes(rfcMessageId)) refs.push(rfcMessageId);
    return Object.freeze({ rfcMessageId, references: Object.freeze(refs), subject: decodeSubject(headers.get('subject')),
      threadId: expectedThreadId, fromAddress, replyToAddress, toAddress });
  }

  async function readSource({ providerMessageId, expectedThreadId }) {
    identifier(providerMessageId); identifier(expectedThreadId);
    const result = await command(['gmail', 'get', providerMessageId, '--format=metadata',
      '--headers=Message-ID,References,Subject,From,Reply-To,To,Cc,Bcc']);
    return sourceMetadata(result, providerMessageId, expectedThreadId);
  }

  async function readSourceBody({ providerMessageId, expectedThreadId }) {
    identifier(providerMessageId); identifier(expectedThreadId);
    const result = await command(['gmail', 'get', providerMessageId, '--format=full'], undefined, 'gmail.get');
    const metadata = sourceMetadata(result, providerMessageId, expectedThreadId);
    return Object.freeze({ ...metadata, body: sourceBody(result) });
  }

  async function listDrafts(threadId) {
    const found = []; const pages = new Set(); let page;
    for (let count = 0; count < MAX_PAGES; count += 1) {
      const result = await command(['gmail', 'drafts', 'list', '--max=100', ...(page ? [`--page=${page}`] : [])]);
      if (!Array.isArray(result?.drafts) || result.drafts.length > 100) fail('GOG_DRAFT_LIST_INVALID');
      for (const draft of result.drafts) {
        draftIdentifier(draft.id);
        if (draft.threadId === threadId) found.push(draft.id);
      }
      if (found.length > MAX_DRAFTS) fail('GOG_DRAFT_RECONCILIATION_LIMIT');
      page = result.nextPageToken;
      if (!page) return [...new Set(found)];
      if (typeof page !== 'string' || page.length > 1000 || /[\u0000-\u001f\u007f]/.test(page) || pages.has(page)) fail('GOG_DRAFT_LIST_INVALID');
      pages.add(page);
    }
    fail('GOG_DRAFT_RECONCILIATION_LIMIT');
  }

  async function readDraft(draftId, content) {
    draftIdentifier(draftId);
    const result = await command(['gmail', 'drafts', 'get', draftId]);
    const draft = result?.draft; const message = draft?.message;
    if (draft?.id !== draftId || message?.threadId !== content.thread.threadId
        || !Array.isArray(message.labelIds) || !message.labelIds.includes('DRAFT') || message.labelIds.includes('SENT')) fail('GOG_DRAFT_READBACK_MISMATCH');
    identifier(message.id);
    const headers = headersOf(message);
    const refs = references(headers.get('references') ?? '');
    if (mailbox(headers.get('from')) !== accountId || mailbox(headers.get('to')) !== recipient
        || headers.get('cc') || headers.get('bcc') || headers.get('reply-to')
        || (headers.has('content-disposition') && headers.get('content-disposition').toLowerCase() !== 'inline')
        || [...headers.keys()].some(key => key.startsWith('resent-'))
        || decodeSubject(headers.get('subject')) !== content.subject
        || rfcId(headers.get('in-reply-to')) !== content.thread.inReplyTo
        || stableJson(refs) !== stableJson(content.thread.references)) fail('GOG_DRAFT_READBACK_MISMATCH');
    const text = plainBody(message);
    // gog's MIME encoder appends exactly one CRLF only if no terminal newline
    // exists. Do not trim arbitrary whitespace or alter the approved body.
    if (text !== content.body.text && (content.body.text.endsWith('\n') || text !== `${content.body.text}\n`)) fail('GOG_DRAFT_READBACK_MISMATCH');
    return { providerDraftId: draftId, providerMessageId: message.id, providerThreadId: message.threadId,
      providerEvidenceDigest: digestCanonicalJson({ provider: 'gog_gmail', accountId, recipient, draftId,
        messageId: message.id, threadId: message.threadId, subject: content.subject,
        bodyDigest: content.body.digest, inReplyTo: content.thread.inReplyTo, references: refs,
        labelIds: [...message.labelIds].sort(), mimeType: message.payload.mimeType }) };
  }

  async function ensureDraft(input) {
    input = copyInertData(input, 'Gmail draft input');
    identifier(input?.operationId); identifier(input?.replyToProviderMessageId);
    const content = validateEmailApprovedContentV1(input.approvedContent);
    if (content.provider !== 'gog_gmail' || content.accountId !== accountId || content.recipient !== recipient
        || digestCanonicalJson(content) !== input.contentDigest) fail('GOG_DRAFT_CONTENT_BINDING_MISMATCH');
    identifier(content.thread.threadId);
    const binding = { operationId: input.operationId, contentDigest: input.contentDigest, replyToProviderMessageId: input.replyToProviderMessageId,
      accountId, recipient, providerThreadId: content.thread.threadId };
    const bindingDigest = digestCanonicalJson(binding);
    // Check protected boundaries BEFORE mkdir/read/lock, including symlink
    // resolution performed by the existing mandatory provenance boundary.
    assertPathNotPrivateJournalSource(directory, 'Gmail draft journal directory');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    checkedMetadata(directory, true);
    const file = path.join(directory, `${hash(input.operationId)}.json`);
    // One lock per adapter journal serializes distinct operation IDs too.
    // A crash-owned lock is never automatically stolen: reconcile explicitly.
    const lock = path.join(directory, '.gog-draft.lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch (error) {
      if (error.code === 'EEXIST') fail('GOG_DRAFT_OPERATION_BUSY');
      fail('GOG_DRAFT_LOCK_FAILED');
    }
    const owned = fs.fstatSync(fd);
    try {
      fs.writeFileSync(fd, `${stableJson({ pid: process.pid, operationDigest: bindingDigest })}\n`); fs.fsyncSync(fd); syncDirectory(directory);
      let record = fs.existsSync(file) ? readJournal(file) : null;
      if (record && (record.schemaVersion !== SCHEMA || record.bindingDigest !== bindingDigest
          || !['prepared', 'creating', 'identified', 'verified'].includes(record.state))) fail('GOG_DRAFT_OPERATION_CONFLICT');
      const source = await readSource({ providerMessageId: input.replyToProviderMessageId, expectedThreadId: content.thread.threadId });
      if (source.rfcMessageId !== content.thread.inReplyTo || stableJson(source.references) !== stableJson(content.thread.references)
          || (input.replyToRfcMessageId !== undefined && source.rfcMessageId !== input.replyToRfcMessageId)
          || (input.providerThreadId !== undefined && source.threadId !== input.providerThreadId)) fail('GOG_DRAFT_SOURCE_CONTENT_MISMATCH');

      if (record?.state === 'creating') {
        const candidates = [];
        for (const id of await listDrafts(content.thread.threadId)) {
          if (record.baselineDraftIds.includes(id)) continue;
          try { await readDraft(id, content); candidates.push(id); }
          catch (error) {
            if (!(error instanceof GogDraftAdapterError) || error.code.startsWith('GOG_DRAFT_PROVIDER_')) throw error;
          }
        }
        record = { ...record, reconciledAt: new Date().toISOString(), candidateDraftIds: candidates };
        writeJournal(file, record);
        // The CLI cannot stamp an operation header. Matching prose/thread is
        // not proof that this operation created a draft; do not adopt it.
        const error = new GogDraftAdapterError('GOG_DRAFT_RECONCILE_REQUIRED');
        error.candidateDraftIds = Object.freeze(candidates);
        throw error;
      }
      if (!record || record.state === 'prepared') {
        record = { schemaVersion: SCHEMA, bindingDigest, ...binding, state: 'prepared',
          baselineDraftIds: await listDrafts(content.thread.threadId), preparedAt: new Date().toISOString() };
        writeJournal(file, record);
        record = { ...record, state: 'creating', createIntentAt: new Date().toISOString() };
        writeJournal(file, record);
        let created;
        try {
          created = await command(['gmail', 'drafts', 'create', `--to=${recipient}`, `--from=${accountId}`,
            `--subject=${content.subject}`, '--body-file=-', `--reply-to-message-id=${input.replyToProviderMessageId}`], content.body.text);
          draftIdentifier(created?.draftId);
        } catch { fail('GOG_DRAFT_CREATE_UNCERTAIN'); }
        record = { ...record, state: 'identified', providerDraftId: created.draftId, identifiedAt: new Date().toISOString() };
        writeJournal(file, record);
      }
      const native = await readDraft(record.providerDraftId, content);
      const observedAt = new Date().toISOString();
      const evidence = { provider: 'gog_gmail', accountId, recipient, ...native, contentDigest: input.contentDigest, observedAt };
      record = { ...record, state: 'verified', evidence };
      writeJournal(file, record);
      return Object.freeze({ ...evidence, operationJournalEvidenceDigest: digestCanonicalJson(record) });
    } finally {
      fs.closeSync(fd);
      const current = fs.lstatSync(lock);
      if (current.dev === owned.dev && current.ino === owned.ino && !current.isSymbolicLink()) {
        fs.unlinkSync(lock); syncDirectory(directory);
      }
    }
  }

  return Object.freeze({ readSource, readSourceBody, ensureDraft });
}

module.exports = { createGogDraftAdapter, GogDraftAdapterError };
