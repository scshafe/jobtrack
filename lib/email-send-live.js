'use strict';

// LIVE SEND EXECUTOR — turns one signed approval into (at most) one real
// transmitted email, through the outgoing-v2 lane's own gates:
//
//   createSendRequest  (re-verifies the approval attestation; one per approval)
//     -> ALLOWLIST gate ($JOBTRACK_HOME/send-allowlist.json — seeded with
//        {"domains":["mydrove.com"]}; a recipient outside it is REFUSED and
//        nothing transmits; the file is never auto-widened)
//     -> durable, exclusive per-approval filesystem fence BEFORE the wire
//     -> provider transmit (gog_gmail; Apple is closed pending real evidence)
//     -> a SIGNED send receipt (per-store native-receipt Ed25519 key), fed to
//        correlateSendReceipt so the store records exactly what happened.
//
// Nothing here weakens the lane: no approval => createSendRequest refuses; a
// second send on the same approval never retries transmission. A persisted,
// authenticated receipt may be reconciled; an ambiguous attempt stays fenced.
// The journal is outside SQLite because the CLI transaction can roll back
// after a real send. Never delete/reclaim a fence based on age or process death.

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createSendRequest, correlateSendReceipt, readReviewProjection } = require('./email-outgoing-v2');
const { digestCanonicalJson, stableJson, publicKeyFingerprint, validateOutgoingV2Consistency, verifyNativeReceiptAttestation } = require('./email-outgoing-v2-contracts');
const { approvalKeyOptions } = require('./email-auto-approval');
const { ensureSigningKey, signingKeyOptions } = require('./signing-keys');
const { assertPathNotPrivateJournalSource } = require('./private-source-boundary');
const { sanitizedGogEnvironment } = require('../scripts/lib/gog-environment.cjs');

const NATIVE_KEY_ID = 'jobtrack-native-receipt-ed25519.v1';

class EmailSendLiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmailSendLiveError';
    this.code = code;
  }
}

function ensureNativeReceiptKey(home) {
  return ensureSigningKey(home, { fileName: 'native-receipt-signing.v1.json', keyId: NATIVE_KEY_ID });
}

function nativeReceiptKeyOptions(home) {
  return signingKeyOptions(ensureNativeReceiptKey(home));
}

/** The recipient allowlist: domains + exact addresses. Seeded restrictive. */
function loadAllowlist(home) {
  const file = path.join(home, 'send-allowlist.json');
  if (!fs.existsSync(file)) {
    const seeded = { domains: ['mydrove.com'], addresses: [] };
    fs.writeFileSync(file, `${JSON.stringify(seeded, null, 2)}\n`, { mode: 0o600 });
    return { ...seeded, file };
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    domains: Array.isArray(parsed.domains) ? parsed.domains.map((d) => String(d).toLowerCase()) : [],
    addresses: Array.isArray(parsed.addresses) ? parsed.addresses.map((a) => String(a).toLowerCase()) : [],
    file
  };
}

function assertRecipientAllowed(home, recipient) {
  const allowlist = loadAllowlist(home);
  const address = String(recipient).toLowerCase();
  const domain = address.split('@')[1] ?? '';
  if (allowlist.addresses.includes(address)) return;
  if (allowlist.domains.includes(domain)) return;
  throw new EmailSendLiveError('RECIPIENT_NOT_ALLOWLISTED',
    `Refusing to transmit: ${recipient} is outside ${allowlist.file} (domains: ${allowlist.domains.join(', ') || 'none'})`);
}

// --- Providers -------------------------------------------------------------

/** The transmitting account must have a send-capable Gmail grant. */
/**
 * gog's send arguments. gog threads a reply from EXACTLY ONE of
 * --reply-to-message-id (sets In-Reply-To/References; the thread follows) or
 * --thread-id (headers from the thread's latest message) — passing both is
 * refused ("use only one", arc 2, 2026-09-02, the first live reply). The
 * message id is the more precise anchor, so it wins. The exact approved
 * subject is always explicit, including replies.
 */
function gogSendArgs({ account, recipient, subject, gmailThreadId, replyToMessageId }) {
  const args = ['gmail', 'send', '-a', account, '--to', recipient, '--body-file', '-', '--json', '--no-input',
    '--enable-commands-exact=gmail.send', '--client=default', '--subject', subject];
  if (replyToMessageId) args.push('--reply-to-message-id', replyToMessageId);
  else if (gmailThreadId) args.push('--thread-id', gmailThreadId);
  return args;
}

function gogGmailTransmit({ account, recipient, subject, bodyText, gmailThreadId, replyToMessageId, executable }) {
  const args = gogSendArgs({ account, recipient, subject, gmailThreadId, replyToMessageId });
  const stdout = execFileSync(executable, args, {
    input: bodyText, encoding: 'utf8', timeout: 60_000,
    env: sanitizedGogEnvironment(), shell: false
  });
  return parseGogSendEvidence(stdout);
}

function validateProviderEvidence(evidence) {
  const result = {};
  for (const field of ['providerMessageId', 'providerThreadId']) {
    const value = evidence?.[field];
    if (typeof value !== 'string' || !value || value.length > 500
      || value.trim() !== value || /[\s\x00-\x1f\x7f]/u.test(value)
      || /^(unknown|undefined|null|none|n\/a|subject-threaded)$/iu.test(value)
      || /^apple-osascript-/iu.test(value)) {
      throw new EmailSendLiveError('PROVIDER_EVIDENCE_INVALID', `Provider did not return a real ${field}; reconcile the fenced attempt, do not retry.`);
    }
    result[field] = value;
  }
  return result;
}

function parseGogSendEvidence(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch { throw new EmailSendLiveError('PROVIDER_EVIDENCE_INVALID', 'Gmail response was not JSON; reconcile the fenced attempt, do not retry.'); }
  const message = parsed?.message ?? parsed;
  const nativeId = (aliases) => {
    const values = aliases.filter((key) => message != null && Object.hasOwn(message, key)).map((key) => message[key]);
    const outer = message === parsed ? [] : aliases.filter((key) => Object.hasOwn(parsed, key)).map((key) => parsed[key]);
    if ([...values, ...outer].some((value) => value !== values[0])) {
      throw new EmailSendLiveError('PROVIDER_EVIDENCE_INVALID', 'Gmail response contained conflicting native resource IDs.');
    }
    return values[0];
  };
  const evidence = validateProviderEvidence({
    // Pinned gog's gmailMessageResultJSON emits messageId/threadId. Retain
    // older native/raw forms, but contradictory aliases are not evidence.
    providerMessageId: nativeId(['messageId', 'id', 'message_id']),
    providerThreadId: nativeId(['threadId', 'thread_id'])
  });
  // Gmail resource IDs are hexadecimal. Never substitute the requested thread
  // or a local timestamp for the result of the actual provider operation.
  if (!Object.values(evidence).every((value) => /^[a-f0-9]+$/iu.test(value))) {
    throw new EmailSendLiveError('PROVIDER_EVIDENCE_INVALID', 'Gmail response did not contain native resource IDs.');
  }
  return evidence;
}

/** Apple Mail readiness: Mail.app scriptable within a short timeout. */
function appleMailReady() {
  try {
    execFileSync('osascript', ['-e', 'tell application "Mail" to get name'], { encoding: 'utf8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function appleMailTransmit() {
  throw new EmailSendLiveError('APPLE_MAIL_EVIDENCE_UNAVAILABLE',
    'Apple Mail transmission is disabled until an adapter can capture authentic sent-message and threading evidence. No message was transmitted.');
}

const PROVIDERS = { gog_gmail: gogGmailTransmit, apple_mail_automation: appleMailTransmit };
// The CLI documents the short names; the registry keys are the delivery
// provider ids the approval scope pins. Both spellings resolve (arc 2,
// 2026-09-02: the first live reply died on `--provider gog`).
const PROVIDER_ALIASES = Object.freeze({
  gog: 'gog_gmail', 'gog-gmail': 'gog_gmail', gog_gmail: 'gog_gmail',
  'apple-mail': 'apple_mail_automation', apple_mail: 'apple_mail_automation', apple_mail_automation: 'apple_mail_automation'
});
function resolveProviderName(value) {
  const key = String(value || 'gog_gmail').trim().toLowerCase();
  return PROVIDER_ALIASES[key] || key;
}

// --- The executor ----------------------------------------------------------

function shortDigest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function attemptDirectory(home, approvalId) {
  assertPathNotPrivateJournalSource(home, 'send operation store');
  const directory = path.join(home, 'email-send-attempts', crypto.createHash('sha256').update(approvalId).digest('hex'));
  assertPathNotPrivateJournalSource(directory, 'send operation journal');
  return directory;
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeJournalFile(directory, name, value) {
  const fd = fs.openSync(path.join(directory, name), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${stableJson(value)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  syncDirectory(directory);
}

function assertJournalDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe send journal directory');
}

function readJournalFile(directory, name) {
  const file = path.join(directory, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unsafe send journal file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Read-only inspection: creates neither keys, directories nor DB records.
 *  Only a native-signed receipt authenticates recovery evidence. Bare provider
 *  output, partial writes, missing keys and corrupt files remain reconcile-only.
 */
function readSendAttempt(home, approvalId) {
  const directory = attemptDirectory(home, approvalId);
  try { fs.lstatSync(directory); }
  catch (err) { if (err.code === 'ENOENT') return { status: 'not_attempted' }; throw err; }
  try {
    assertJournalDirectory(path.dirname(directory));
    assertJournalDirectory(directory);
    const claim = readJournalFile(directory, 'claim.json');
    const receipt = readJournalFile(directory, 'receipt.json');
    const evidence = validateProviderEvidence(readJournalFile(directory, 'provider-evidence.json'));
    // Do not mint a replacement identity while inspecting old evidence.
    const key = JSON.parse(fs.readFileSync(path.join(home, 'keys', 'native-receipt-signing.v1.json'), 'utf8'));
    if (key.keyId !== NATIVE_KEY_ID) throw new Error('Unexpected native receipt identity');
    verifyNativeReceiptAttestation(receipt, signingKeyOptions(key));
    if (claim.schemaVersion !== 'jobtrack-email-send-attempt.v1' || claim.approvalId !== approvalId
      || claim.request?.approval?.approvalId !== approvalId || receipt.outcome !== 'sent'
      || receipt.attemptId !== claim.attemptId || receipt.requestId !== claim.request.requestId
      || receipt.requestDigest !== digestCanonicalJson(claim.request)
      || receipt.operationJournalEvidenceDigest !== digestCanonicalJson(claim)
      || receipt.providerEvidenceDigest !== digestCanonicalJson(evidence)
      || receipt.providerMessageId !== evidence.providerMessageId || receipt.providerThreadId !== evidence.providerThreadId) {
      throw new Error('Send journal binding mismatch');
    }
    return { status: 'receipt_persisted', claim, receipt, evidence };
  } catch {
    return { status: 'reconcile_only' };
  }
}

function reconciliationRequired(cause) {
  const error = new EmailSendLiveError('SEND_RECONCILIATION_REQUIRED',
    'This approval has a durable send-attempt fence. Reconcile provider evidence; never retry transmission or remove the fence.');
  // Only a bounded local code, never a provider error body or mail contents.
  if (cause instanceof EmailSendLiveError) error.reasonCode = cause.reasonCode || cause.code;
  return error;
}

function claimJournalDirectory(home, directory, claim) {
  assertPathNotPrivateJournalSource(directory, 'send operation journal');
  const root = path.dirname(directory);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertJournalDirectory(root);
  syncDirectory(home);
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (err) { if (err.code === 'EEXIST') throw reconciliationRequired(); throw err; }
  // mkdir is the cross-process exclusive claim; even an empty directory left
  // by a crash is never reclaimed. Both name and content are durable pre-wire.
  syncDirectory(root);
  writeJournalFile(directory, 'claim.json', claim);
  return directory;
}

function claimSourceReply(db, home, projection, approvalId) {
  const { provider, accountId, messageId } = projection.proposal.source;
  const source = { provider, accountId, messageId };
  const prior = db.prepare(`SELECT c.receipt_id FROM job_email_send_receipt_correlations_v2 c
    JOIN job_email_send_requests_v2 r ON r.request_id=c.send_request_id
    JOIN job_email_outgoing_proposals_v3 p ON p.proposal_id=r.proposal_id
    WHERE p.provider=? AND p.account_id=? AND p.message_id=?
      AND c.outcome IN ('sent','duplicate','indeterminate') LIMIT 1`).get(provider, accountId, messageId);
  if (prior) throw reconciliationRequired();
  // A newly generated approval must not evade a previous uncertain attempt.
  // This lane permits one reply per source message, including after success;
  // deliberate additional replies require a separate explicit policy, not TTLs.
  const directory = path.join(home, 'email-send-source-fences', digestCanonicalJson(source));
  claimJournalDirectory(home, directory, {
    schemaVersion: 'jobtrack-email-source-reply-fence.v1', source, approvalId,
    observedAt: new Date().toISOString()
  });
}

function correlateReceipt(db, home, receipt, nativeKey) {
  return correlateSendReceipt(db, {
    schemaVersion: 'jobtrack-email-send-receipt-correlation.v1', receipt,
    operationIdempotencyKey: `${receipt.receiptId}-op`
  }, {
    nativeReceiptKey: signingKeyOptions(nativeKey),
    resolveApprovalPublicKey: approvalKeyOptions(home).resolvePublicKey
  });
}

function recoverSendAttempt(db, home, attempt) {
  if (attempt.status !== 'receipt_persisted') throw reconciliationRequired();
  try {
    return db.transaction(() => {
      const { request } = attempt.claim;
      let row = db.prepare('SELECT request_json FROM job_email_send_requests_v2 WHERE approval_id=?').get(attempt.claim.approvalId);
      if (!row) {
        // Restore an authenticated historical claim, not permission to send.
        // The kernel still verifies the approval and immutable current source;
        // a changed/invalidated source can refuse restoration. No wire is here.
        const restored = createSendRequest(db, {
          schemaVersion: 'jobtrack-email-send-request-issue.v1', requestId: request.requestId,
          approvalId: attempt.claim.approvalId, operationIdempotencyKey: `${request.requestId}-op`
        }, { approvalKey: approvalKeyOptions(home), now: () => request.requestedAt }).request;
        row = { request_json: stableJson(restored) };
      }
      if (digestCanonicalJson(JSON.parse(row.request_json)) !== attempt.receipt.requestDigest) throw reconciliationRequired();
      const key = JSON.parse(fs.readFileSync(path.join(home, 'keys', 'native-receipt-signing.v1.json'), 'utf8'));
      const correlated = correlateReceipt(db, home, attempt.receipt, key);
      return { reused: true, alreadySent: true, reconciled: true, request, receipt: correlated.receipt,
        outcome: correlated.outcome, ...attempt.evidence };
    })();
  } catch (cause) { throw reconciliationRequired(cause); }
}

function deliveryArguments(request, projection, opts, providerName) {
  if (providerName !== request.provider
    || (opts.transmitAccount !== undefined && opts.transmitAccount !== request.accountId)
    || (opts.gmailThreadId !== undefined && opts.gmailThreadId !== request.threadId)
    || (opts.replyToMessageId !== undefined && opts.replyToMessageId !== projection.proposal.source.messageId)
    || (providerName === 'gog_gmail' && (projection.proposal.source.provider !== 'gmail_gog'
      || projection.proposal.source.accountId !== request.accountId))) {
    throw new EmailSendLiveError('DELIVERY_SCOPE_MISMATCH', 'Provider, account, thread and source message must exactly match the signed approval; overrides cannot redirect a send.');
  }
  // gog trims the subject flag. Refuse a noncanonical value instead of signing
  // content_equivalent for a silently altered approved header.
  if (projection.approvedContent.subject !== projection.approvedContent.subject.trim()) {
    throw new EmailSendLiveError('DELIVERY_SCOPE_MISMATCH', 'Approved subject must not contain leading or trailing whitespace.');
  }
  return {
    account: request.accountId, recipient: request.recipient,
    subject: projection.approvedContent.subject, bodyText: projection.approvedContent.body.text,
    gmailThreadId: request.threadId, replyToMessageId: projection.proposal.source.messageId
  };
}

/**
 * Execute one approved send.
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {string} opts.approvalId
 * @param {string} [opts.provider='gog_gmail']
 * @param {string} [opts.transmitAccount] must equal the approved delivery account
 * @param {string} [opts.gmailThreadId]    Gmail thread to reply within
 * @param {string} [opts.replyToMessageId] Gmail message id being replied to
 * @param {string} [opts.home]
 * @param {Function} [opts.transmit]       injectable for tests
 */
function sendApproved(db, opts) {
  const { approvalId } = opts;
  if (typeof approvalId !== 'string' || approvalId.length === 0) {
    throw new EmailSendLiveError('INVALID_INPUT', '--approval-id is required');
  }
  const home = opts.home || path.dirname(db.name);
  assertPathNotPrivateJournalSource(home, 'send operation store');
  const providerName = resolveProviderName(opts.provider);
  let transmit = opts.transmit || PROVIDERS[providerName];
  if (!transmit) throw new EmailSendLiveError('UNKNOWN_PROVIDER', `Unknown provider: ${providerName}`);

  const tag = shortDigest(approvalId);
  const requestId = `send-req-${tag}`;

  // Already-sent guard FIRST: createSendRequest replays silently under its
  // own idempotency for identical inputs, so it cannot be the re-send fence.
  // Receipt ids are deterministic per approval; a 'sent' receipt ends it.
  const priorSent = db.prepare(`SELECT receipt_json FROM job_email_send_receipt_correlations_v2
    WHERE receipt_id=? AND outcome='sent'`).get(`send-receipt-${tag}`);
  if (priorSent) {
    const priorRequest = db.prepare('SELECT request_json FROM job_email_send_requests_v2 WHERE approval_id=?').get(approvalId);
    return {
      reused: true,
      alreadySent: true,
      receipt: JSON.parse(priorSent.receipt_json),
      request: priorRequest ? JSON.parse(priorRequest.request_json) : null
    };
  }

  const attempt = readSendAttempt(home, approvalId);
  if (attempt.status !== 'not_attempted') return recoverSendAttempt(db, home, attempt);

  // Read-only veto for explicitly managed reply intents. Existing signed-receipt
  // reconciliation above remains available even if the reply became obsolete.
  require('./email-reply-intents').assertReplyIntentAllowsSend(db, approvalId);

  // Mint (or resume) the one send request for this approval.
  let request;
  try {
    request = createSendRequest(db, {
      schemaVersion: 'jobtrack-email-send-request-issue.v1',
      requestId,
      approvalId,
      operationIdempotencyKey: `${requestId}-op`
    }, { approvalKey: approvalKeyOptions(home) }).request;
  } catch (err) {
    if (err && err.code === 'SEND_REQUEST_ALREADY_ISSUED') {
      const row = db.prepare('SELECT request_json FROM job_email_send_requests_v2 WHERE approval_id=?').get(approvalId);
      if (!row) throw err;
      request = JSON.parse(row.request_json);
      // Receipt ids are deterministic per approval, so the already-sent guard
      // needs no joins: if this approval's receipt landed 'sent', never
      // transmit again.
      const sent = db.prepare(`SELECT receipt_json FROM job_email_send_receipt_correlations_v2
        WHERE receipt_id=? AND outcome='sent'`).get(`send-receipt-${tag}`);
      if (sent) {
        return { reused: true, alreadySent: true, receipt: JSON.parse(sent.receipt_json), request };
      }
    } else {
      throw err;
    }
  }

  // The blast-radius gate. Refusal here means NOTHING transmitted.
  assertRecipientAllowed(home, request.recipient);

  const requestRow = db.prepare('SELECT proposal_id FROM job_email_send_requests_v2 WHERE request_id=?').get(request.requestId);
  const projection = readReviewProjection(db, requestRow.proposal_id);
  const args = deliveryArguments(request, projection, opts, providerName);
  // An idempotently returned request must not bypass a now-expired or revoked
  // approval. Recheck the whole signed bundle immediately before the fence.
  const errors = validateOutgoingV2Consistency({
    proposal: projection.proposal, content: projection.approvedContent,
    draftReceipt: projection.draftReceipt, approval: request.approval, request
  }, { phase: 'claim', now: new Date().toISOString(), approvalKey: approvalKeyOptions(home) });
  const source = projection.proposal.source;
  const currentSource = db.prepare(`SELECT facts_digest,reply_to_address,from_address,thread_id
    FROM job_email_message_refs WHERE provider=? AND account_id=? AND message_id=?`).get(
    source.provider, source.accountId, source.messageId
  );
  if (errors.length || projection.invalidations.length || !currentSource
    || currentSource.facts_digest !== projection.proposal.factsDigest
    || currentSource.thread_id !== source.threadId
    || String(currentSource.reply_to_address || currentSource.from_address).toLowerCase() !== request.recipient.toLowerCase()) {
    throw new EmailSendLiveError('SEND_AUTHORITY_NOT_CURRENT', 'The signed send authority is expired, invalidated or inconsistent.');
  }
  if (!opts.transmit && providerName === 'apple_mail_automation') appleMailTransmit();
  if (!opts.transmit && providerName === 'gog_gmail') {
    // The PATH-installed gog retries mutation POSTs internally. Only the
    // app-local audited no-mutation-retry build may cross this boundary.
    // Resolve before fencing so a missing build performs no attempt at all.
    const executable = require('../scripts/lib/pinned-gog.cjs').resolvePinnedGog();
    transmit = (boundArgs) => gogGmailTransmit({ ...boundArgs, executable });
  }

  const journalEvidence = {
    schemaVersion: 'jobtrack-email-send-attempt.v1',
    executor: 'jobtrack-email-send-live.v1', approvalId,
    attemptId: `send-attempt-${tag}-1`, request,
    provider: providerName, transmitAccount: args.account,
    gmailThreadId: args.gmailThreadId, replyToMessageId: args.replyToMessageId,
    observedAt: new Date().toISOString()
  };
  claimSourceReply(db, home, projection, approvalId);
  const directory = claimJournalDirectory(home, attemptDirectory(home, approvalId), journalEvidence);
  try {
    return finishFencedSend(db, { home, directory, journalEvidence, request, projection, tag, args, providerName, transmit });
  } catch (cause) { throw reconciliationRequired(cause); }
}

function finishFencedSend(db, { home, directory, journalEvidence, request, projection, tag, args, providerName, transmit }) {
  // Key preparation is after the exclusive claim but before the wire: a
  // competing invocation of this approval cannot race its key creation.
  const nativeKey = ensureNativeReceiptKey(home);
  const privateKey = crypto.createPrivateKey(nativeKey.privateKeyPem);
  const derivedFingerprint = crypto.createHash('sha256').update(
    crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  ).digest('hex');
  if (derivedFingerprint !== nativeKey.publicKeySha256
    || publicKeyFingerprint(nativeKey.publicKeyPem) !== nativeKey.publicKeySha256) {
    throw new EmailSendLiveError('KEY_INVALID', 'Native receipt signing identity is inconsistent; no message was transmitted.');
  }
  const keyFd = fs.openSync(nativeKey.file, 'r');
  try { fs.fsyncSync(keyFd); } finally { fs.closeSync(keyFd); }
  syncDirectory(path.dirname(nativeKey.file));
  syncDirectory(home);
  let evidence;
  try {
    evidence = validateProviderEvidence(transmit(args));
    writeJournalFile(directory, 'provider-evidence.json', evidence);
    if (providerName === 'gog_gmail' && evidence.providerThreadId !== request.threadId) {
      throw new EmailSendLiveError('PROVIDER_THREAD_MISMATCH', 'Provider returned a different thread from the approved one.');
    }
  } catch (cause) { throw reconciliationRequired(cause); }

  // Build + sign the receipt (native attestation = payload minus the
  // attestation itself, exactly like the approval receipt).
  const observedAt = new Date().toISOString();
  const unsigned = {
    schemaVersion: 'email-send-receipt.v2',
    normalizationVersion: 'email-text-nfc-lf.v1',
    receiptId: `send-receipt-${tag}`,
    attemptId: `send-attempt-${tag}-1`,
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    requestDigest: digestCanonicalJson(request),
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
    operationJournalEvidenceDigest: digestCanonicalJson(journalEvidence),
    providerEvidenceDigest: digestCanonicalJson({ providerMessageId: evidence.providerMessageId, providerThreadId: evidence.providerThreadId }),
    providerDraftId: projection.draftReceipt.providerDraftId,
    providerMessageId: evidence.providerMessageId,
    providerThreadId: evidence.providerThreadId,
    observedAt
  };
  const payloadDigest = digestCanonicalJson(unsigned);
  // The verifier recomputes bytes via the lane's stableJson over the receipt
  // minus nativeAttestation — sign exactly those bytes.
  const signature = crypto.sign(null, Buffer.from(stableJson(unsigned), 'utf8'), privateKey);
  const receipt = {
    ...unsigned,
    nativeAttestation: {
      algorithm: 'Ed25519',
      keyId: nativeKey.keyId,
      payloadDigest,
      signatureEncoding: 'base64',
      signature: signature.toString('base64')
    }
  };

  // Persist the signature before any DB correlation. If the outer transaction
  // rolls back, only this authenticated receipt can take the recovery path.
  writeJournalFile(directory, 'receipt.json', receipt);
  const correlated = correlateReceipt(db, home, receipt, nativeKey);

  return {
    reused: false,
    request,
    receipt: correlated.receipt,
    outcome: correlated.outcome,
    providerMessageId: evidence.providerMessageId,
    providerThreadId: evidence.providerThreadId
  };
}

module.exports = {
  gogSendArgs,
  parseGogSendEvidence,
  readSendAttempt,
  resolveProviderName,
  EmailSendLiveError,
  ensureNativeReceiptKey,
  nativeReceiptKeyOptions,
  loadAllowlist,
  assertRecipientAllowed,
  appleMailReady,
  sendApproved
};
