'use strict';

// External draft-only half of the clarification lane. The pure CLI chooses
// and freezes the question. This adapter supplies actual source headers and
// native draft evidence. Approval/transmission remain separate CLI actions.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createGogDraftAdapter } = require('./lib/gog-draft-adapter.cjs');
const { writePrivateJson, readPrivateJson, ensurePrivateDirectory } = require('./prepare-reply-draft.cjs');
const { assertPathNotPrivateJournalSource } = require('../lib/private-source-boundary');
const { assertRecipientAllowed } = require('../lib/email-send-live');
const { digestCanonicalJson, NORMALIZATION_VERSION } = require('../lib/email-outgoing-v2-contracts');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json' && !args.json) { args.json = true; continue; }
    const key = { '--message-ref-id': 'messageRefId', '--candidates': 'candidates' }[flag];
    if (!key || args[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('INVALID_ARGUMENT');
    args[key] = argv[++i];
  }
  if (!/^[1-9][0-9]*$/.test(args.messageRefId || '') || !/^[1-9][0-9]*(?:,[1-9][0-9]*)+$/.test(args.candidates || '')) {
    throw new Error('CLARIFICATION_IDS_REQUIRED');
  }
  return args;
}

async function prepareClarification(args, deps = {}) {
  const home = path.resolve(deps.home || process.env.JOBTRACK_HOME || path.join(os.homedir(), '.jobtrack'));
  assertPathNotPrivateJournalSource(home, 'JOBTRACK_HOME');
  const runCli = deps.runCli || ((argv) => {
    try { return JSON.parse(execFileSync(process.execPath, [path.resolve(__dirname, '../bin/jobtrack.js'), ...argv, '--json'],
      { env: { ...process.env, JOBTRACK_HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
    catch (error) {
      let code = 'CLARIFICATION_CLI_REFUSED';
      try { const value = JSON.parse(String(error.stderr)).error?.code;
        if (/^[A-Z][A-Z0-9_]{0,99}$/.test(value)) code = value; } catch { /* no raw private output */ }
      throw new Error(code);
    }
  });
  const base = ['email', 'clarify', '--message-ref-id', String(args.messageRefId), '--candidates', args.candidates];
  let entry = runCli(base);
  if (!entry) throw new Error('CLARIFICATION_PROJECTION_MISSING');
  if (entry.deliveryState === 'sent' || ['answered', 'expired'].includes(entry.status)) return entry;
  let source = entry.source;
  if (!source && entry.proposalId) source = runCli(['email', 'outgoing-review', '--proposal-id', entry.proposalId]).projection.proposal.source;
  if (!source || source.provider !== 'gmail_gog') throw new Error('CLARIFICATION_SOURCE_UNSUPPORTED');
  assertRecipientAllowed(home, source.replyToAddress);
  const adapter = (deps.adapterFactory || createGogDraftAdapter)({ accountId: source.accountId,
    recipient: source.replyToAddress, journalDir: path.join(home, 'native-draft-operations') });
  const native = await adapter.readSource({ providerMessageId: source.messageId, expectedThreadId: source.threadId });
  if ((native.replyToAddress || native.fromAddress) !== source.replyToAddress) throw new Error('NATIVE_SOURCE_MISMATCH');
  if (!entry.proposalId) {
    const replySubject = /^re:/i.test(native.subject) ? native.subject : `Re: ${native.subject}`;
    entry = runCli([...base, '--in-reply-to', native.rfcMessageId, '--references', JSON.stringify(native.references),
      '--reply-subject', replySubject,
      '--preparation-digest', entry.preparationDigest]);
  }
  if (!entry?.proposalId) throw new Error('CLARIFICATION_PROPOSAL_MISSING');
  const projection = runCli(['email', 'outgoing-review', '--proposal-id', entry.proposalId]).projection;
  const content = projection.approvedContent;
  const operationId = `clarification-native-${digestCanonicalJson({ proposalId: entry.proposalId }).slice(0, 32)}`;
  const nativeEvidence = await adapter.ensureDraft({ operationId, approvedContent: content,
    contentDigest: digestCanonicalJson(content), replyToProviderMessageId: source.messageId });
  const directory = path.join(home, 'outgoing-clarification-operations', operationId);
  assertPathNotPrivateJournalSource(directory);
  ensurePrivateDirectory(path.dirname(directory));
  ensurePrivateDirectory(directory);
  const file = path.join(directory, 'receipt.json');
  let capture;
  if (projection.draftReceipt) {
    if (projection.draftReceipt.providerDraftId !== nativeEvidence.providerDraftId) throw new Error('NATIVE_DRAFT_ID_DRIFT');
  } else {
    capture = fs.existsSync(file) ? readPrivateJson(file, true) : {
      schemaVersion: 'jobtrack-email-draft-receipt-capture.v1', idempotencyKey: `${operationId}-capture`,
      receipt: { schemaVersion: 'email-draft-receipt.v1', normalizationVersion: NORMALIZATION_VERSION,
        receiptId: `${operationId}-receipt`, draftProposalId: entry.proposalId,
        draftProposalDigest: digestCanonicalJson(projection.proposal), contentDigest: digestCanonicalJson(content),
        generationId: content.generationId, manifestDigest: content.manifestDigest, provider: content.provider,
        accountId: content.accountId, recipient: content.recipient, threadId: content.thread.threadId,
        providerDraftId: nativeEvidence.providerDraftId, providerThreadId: nativeEvidence.providerThreadId,
        outcome: 'created', transmission: 'not_sent', sendFidelity: 'content_equivalent', observedAt: nativeEvidence.observedAt }
    };
    if (capture.receipt.providerDraftId !== nativeEvidence.providerDraftId) throw new Error('NATIVE_DRAFT_ID_DRIFT');
    writePrivateJson(file, capture);
    runCli(['email', 'outgoing-draft-receipt', '--input', file]);
  }
  return { ...runCli(base), nativeDraftId: nativeEvidence.providerDraftId };
}
if (require.main === module) {
  Promise.resolve().then(() => prepareClarification(parseArgs(process.argv.slice(2))))
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${error.code || 'CLARIFICATION_PREPARATION_FAILED'}: ${error.message}\n`); process.exitCode = 2; });
}
module.exports = { prepareClarification, parseArgs };
