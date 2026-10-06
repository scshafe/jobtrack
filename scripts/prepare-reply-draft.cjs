'use strict';

// Authorized external provider edge. All domain writes go through JobTrack's
// CLI. Composition sealing runs separately, with no inherited credentials.
// This command creates a native draft; it NEVER approves or sends it.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { digestCanonicalJson, digestUtf8Text, NORMALIZATION_VERSION } = require('../lib/email-outgoing-v2-contracts');
const { assertPathNotPrivateJournalSource, assertNoPrivateJournalSource } = require('../lib/private-source-boundary');
const { assertRecipientAllowed } = require('../lib/email-send-live');

const CLI = path.resolve(__dirname, '../bin/jobtrack.js');
const SEALER = path.join(__dirname, 'seal-reply-draft.cjs');
const POLICY = Object.freeze({
  schemaVersion: 'jobtrack-external-reply-policy.v1',
  tone: 'concise professional; no recipient identity imitation',
  voice: 'externally supplied applicant text; no learned voice profile asserted',
  provenance: 'caller-supplied composition, not independently attested model execution'
});

function parseArgs(argv) {
  const names = { '--source': 'source', '--kind': 'kind', '--body-file': 'bodyFile',
    '--reply-subject': 'replySubject', '--applicant-name': 'applicantName',
    '--scheduled-at': 'scheduledAt', '--delivery-provider': 'deliveryProvider',
    '--delivery-account': 'deliveryAccount' };
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json' && !args.json) { args.json = true; continue; }
    const key = names[flag];
    if (!key || args[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`INVALID_ARGUMENT: ${flag}`);
    }
    args[key] = argv[++index];
  }
  return args;
}

function assertPrivateMetadata(file, directory = false) {
  assertPathNotPrivateJournalSource(file);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('DRAFT_JOURNAL_NOT_PRIVATE');
  }
}
function ensurePrivateDirectory(directory) {
  assertPathNotPrivateJournalSource(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivateMetadata(directory, true);
}
function readPrivateJson(file, journal = false) {
  assertPathNotPrivateJournalSource(file);
  if (journal) assertPrivateMetadata(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (journal ? fs.constants.O_NOFOLLOW : 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1_048_576) throw new Error('DRAFT_INPUT_INVALID');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
function writePrivateJson(file, value) {
  assertPathNotPrivateJournalSource(file);
  assertPrivateMetadata(path.dirname(file), true);
  if (fs.existsSync(file)) assertPrivateMetadata(file);
  const temporary = `${file}.${process.pid}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function withReference(body, reference) {
  if (!reference) return body;
  if (!/^[A-Z]{2,6}-[0-9A-Z]{3,12}$/.test(reference)) throw new Error('INVALID_CONVERSATION_REFERENCE');
  const line = `Conversation reference: [${reference}]`;
  return body.includes(line) ? body : `${body}\n\n${line}`;
}
function compositionFrom(args, source, native) {
  if (args.kind !== 'agent' || !args.bodyFile) {
    throw new Error('EXPLICIT_BODY_REQUIRED: supply --kind agent --body-file; live template/fixture fallback retired');
  }
  assertPathNotPrivateJournalSource(args.bodyFile, '--body-file');
  const body = withReference(fs.readFileSync(args.bodyFile, 'utf8').replace(/\r\n/g, '\n').normalize('NFC').trim(), source.conversationReference);
  if (!body.trim()) throw new Error('EMPTY_BODY');
  const subject = /^re:/i.test(native.subject) ? native.subject : `Re: ${native.subject}`;
  if (args.replySubject && args.replySubject !== native.subject && args.replySubject !== subject) {
    throw new Error('NATIVE_SUBJECT_MISMATCH');
  }
  return { subject, body, authorship: 'model', registerAdaptationOnly: true };
}

async function prepareReply(args, deps = {}) {
  assertNoPrivateJournalSource(args);
  if (!args.source) throw new Error('SOURCE_REQUIRED');
  const home = path.resolve(deps.home || process.env.JOBTRACK_HOME || path.join(os.homedir(), '.jobtrack'));
  assertPathNotPrivateJournalSource(home, 'JOBTRACK_HOME');
  const source = readPrivateJson(args.source);
  for (const key of ['provider', 'accountId', 'messageId', 'threadId']) {
    if (typeof source[key] !== 'string' || !source[key]) throw new Error(`SOURCE_FIELD_REQUIRED: ${key}`);
  }
  const recipient = source.replyToAddress || source.fromAddress;
  if (source.provider !== 'gmail_gog'
      || (args.deliveryProvider && args.deliveryProvider !== 'gog_gmail')
      || (args.deliveryAccount && args.deliveryAccount !== source.accountId)) throw new Error('DELIVERY_BINDING_MISMATCH');
  assertRecipientAllowed(home, recipient);
  const factory = deps.adapterFactory || require('./lib/gog-draft-adapter.cjs').createGogDraftAdapter;
  const adapter = factory({ accountId: source.accountId, recipient,
    journalDir: path.join(home, 'native-draft-operations') });
  const native = await adapter.readSource({ providerMessageId: source.messageId, expectedThreadId: source.threadId });
  if ((native.replyToAddress || native.fromAddress) !== recipient || (source.fromAddress && native.fromAddress !== source.fromAddress)) {
    throw new Error('NATIVE_SOURCE_MISMATCH');
  }
  const composition = compositionFrom(args, source, native);
  const manifest = {
    schemaVersion: 'jobtrack-external-composition-manifest.v1',
    operation: 'seal_external_composition', compositionDigest: digestCanonicalJson(composition),
    policy: POLICY, toneDigest: digestCanonicalJson({ tone: POLICY.tone }),
    voiceDigest: digestCanonicalJson({ voice: POLICY.voice }),
    sealerDigest: digestUtf8Text(fs.readFileSync(SEALER, 'utf8')),
    safetyStagesDigest: digestUtf8Text(fs.readFileSync(path.resolve(__dirname, '../lib/draft-runner/stages.js'), 'utf8'))
  };
  const key = digestCanonicalJson({ source, manifest });
  const directory = path.join(home, 'outgoing-draft-operations', key);
  assertPathNotPrivateJournalSource(directory);
  ensurePrivateDirectory(path.dirname(directory));
  ensurePrivateDirectory(directory);
  const lock = path.join(directory, 'lock');
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error('DRAFT_OPERATION_LOCKED: reconcile before resuming'); }
  try {
    const stateFile = path.join(directory, 'operation.json');
    const id = `external-reply-${key.slice(0, 32)}`;
    const state = fs.existsSync(stateFile) ? readPrivateJson(stateFile, true) : {
      key, manifest, composition,
      issue: {
        schemaVersion: 'jobtrack-email-reply-draft-issue.v1',
        requestId: `${id}:request`, idempotencyKey: `${id}:issue`, generationId: `${id}:generation`,
        manifestDigest: digestCanonicalJson(manifest),
        source: { provider: source.provider, accountId: source.accountId, messageId: source.messageId,
          threadId: source.threadId, replyToAddress: recipient, inReplyTo: native.rfcMessageId, references: native.references },
        delivery: { provider: 'gog_gmail', accountId: source.accountId },
        toneDecisionId: 'external-reply-neutral-tone.v1', toneDecisionDigest: manifest.toneDigest,
        voiceRevisionId: 'external-reply-supplied-voice.v1', voiceRevisionDigest: manifest.voiceDigest,
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString()
      }
    };
    if (state.key !== key) throw new Error('DRAFT_OPERATION_CONFLICT');
    writePrivateJson(stateFile, state);
    const runCli = deps.runCli || ((argv) => {
      try { return JSON.parse(execFileSync(process.execPath, [CLI, ...argv, '--json'], {
        env: { ...process.env, JOBTRACK_HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
      })); }
      catch (error) {
        let code = 'JOBTRACK_CLI_REFUSED';
        try { const value = JSON.parse(String(error.stderr)).error?.code;
          if (/^[A-Z][A-Z0-9_]{0,99}$/.test(value)) code = value; } catch { /* no private provider output */ }
        throw new Error(code);
      }
    });
    const mutation = (verb, document) => {
      const input = path.join(directory, `${verb}.json`);
      writePrivateJson(input, document);
      return runCli(['email', verb, '--input', input]);
    };
    const issued = mutation('outgoing-draft-issue', state.issue);
    if (!state.sealed) {
      const input = { request: issued.request, manifest, composition,
        proposalId: `${id}:proposal`, contentId: `${id}:content` };
      state.sealed = deps.seal ? deps.seal(input) : JSON.parse(execFileSync(process.execPath, [SEALER], {
        input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        env: { TZ: 'UTC', LANG: 'en_US.UTF-8' }, timeout: 30_000
      }));
      writePrivateJson(stateFile, state);
    }
    mutation('outgoing-draft-record', state.sealed.result);
    const { proposal, approvedContent } = state.sealed.result;
    const nativeEvidence = await adapter.ensureDraft({ operationId: `${id}-native`,
      approvedContent, contentDigest: digestCanonicalJson(approvedContent),
      replyToProviderMessageId: source.messageId });
    if (!state.receipt) {
      state.receipt = {
        schemaVersion: 'email-draft-receipt.v1', normalizationVersion: NORMALIZATION_VERSION,
        receiptId: `${id}:native-receipt`, draftProposalId: proposal.proposalId,
        draftProposalDigest: digestCanonicalJson(proposal), contentDigest: digestCanonicalJson(approvedContent),
        generationId: approvedContent.generationId, manifestDigest: approvedContent.manifestDigest,
        provider: approvedContent.provider, accountId: approvedContent.accountId, recipient: approvedContent.recipient,
        threadId: approvedContent.thread.threadId, providerDraftId: nativeEvidence.providerDraftId,
        providerThreadId: nativeEvidence.providerThreadId, outcome: 'created', transmission: 'not_sent',
        sendFidelity: 'content_equivalent', observedAt: nativeEvidence.observedAt
      };
      writePrivateJson(stateFile, state);
    }
    if (state.receipt.providerDraftId !== nativeEvidence.providerDraftId) throw new Error('NATIVE_DRAFT_ID_DRIFT');
    mutation('outgoing-draft-receipt', { schemaVersion: 'jobtrack-email-draft-receipt-capture.v1',
      receipt: state.receipt, idempotencyKey: `${id}:capture` });
    const projection = runCli(['email', 'outgoing-review', '--proposal-id', proposal.proposalId]).projection;
    return { proposalId: proposal.proposalId, subject: approvedContent.subject, bodyText: approvedContent.body.text,
      projectionDigest: projection.projectionDigest, approvedContentDigest: projection.approvedContentDigest,
      nativeDraftId: nativeEvidence.providerDraftId, awaitingReview: true };
  } finally { fs.unlinkSync(lock); }
}

if (require.main === module) {
  Promise.resolve().then(() => prepareReply(parseArgs(process.argv.slice(2))))
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${error.code || 'DRAFT_PREPARATION_FAILED'}: ${error.message}\n`); process.exitCode = 2; });
}
module.exports = { prepareReply, parseArgs, compositionFrom, writePrivateJson, readPrivateJson, ensurePrivateDirectory };
