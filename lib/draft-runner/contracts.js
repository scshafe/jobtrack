'use strict';

// The ContractValidator port Mission Pipeline calls around every stage
// execution. JobTrack owns the vocabulary: the pipeline input is the exact
// digest-pinned draft request the CLI issued, the intermediate contracts are
// runner-internal, and the terminal contract carries the provider-neutral
// proposal/content pair the CLI will re-validate. Unknown contracts and unknown
// fields fail closed; nothing here reaches the JobTrack store or the network.

const {
  NORMALIZATION_VERSION,
  parseTime,
  validateEmailApprovedContentV1,
  validateReplyDraftProposalV3
} = require('../email-outgoing-v2-contracts');

const DRAFT_REQUEST_CONTRACT = 'jobtrack-email-reply-draft-request.v1';
const POLICY_CONTRACT = 'jobtrack-draft-runner-policy.v1';
const INTENT_CONTRACT = 'jobtrack-draft-runner-intent.v1';
const EVIDENCE_CONTRACT = 'jobtrack-draft-runner-evidence.v1';
const COMPOSITION_CONTRACT = 'jobtrack-draft-runner-composition.v1';
const OUTCOME_CONTRACT = 'jobtrack-draft-runner-outcome.v1';

const REPLY_PURPOSES = ['acknowledgement', 'scheduling', 'information_response', 'follow_up', 'other'];
const AUTHORSHIP_KINDS = ['template', 'model'];
const EVIDENCE_FIELDS = ['from', 'subject', 'body', 'url', 'header'];
const IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const BODY_CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f]/;

class ContractIssue extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContractIssue';
    this.code = 'INVALID_DRAFT_REQUEST';
  }
}

function bad(path, message) {
  throw new ContractIssue(`${path} ${message}`);
}

function plain(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) bad(path, 'must be an object');
  return value;
}

function exact(value, path, keys) {
  const present = Object.keys(value);
  const unknown = present.filter((key) => !keys.includes(key));
  if (unknown.length) bad(path, `contains unknown field(s): ${unknown.sort().join(', ')}`);
  return value;
}

function required(value, path, keys) {
  for (const key of keys) if (value[key] === undefined) bad(`${path}.${key}`, 'is required');
}

function str(value, path, max) {
  if (typeof value !== 'string' || !value.length || value.length > max) bad(path, `must be a 1..${max} character string`);
  if (CONTROL_CHARACTERS.test(value)) bad(path, 'must not contain control characters');
  return value;
}

// Body text is the one field that legitimately carries line feeds; every other
// string in this vocabulary is a header-shaped value.
function bodyText(value, path, max) {
  if (typeof value !== 'string' || !value.length || value.length > max) bad(path, `must be a 1..${max} character string`);
  if (BODY_CONTROL_CHARACTERS.test(value)) bad(path, 'must not contain control characters other than line feed');
  return value;
}

function id(value, path) {
  str(value, path, 200);
  if (!IDENTIFIER.test(value)) bad(path, 'must be a stable identifier');
  return value;
}

function sha256(value, path) {
  if (typeof value !== 'string' || !SHA256.test(value)) bad(path, 'must be a lowercase SHA-256 digest');
  return value;
}

function bool(value, path) {
  if (typeof value !== 'boolean') bad(path, 'must be a boolean');
  return value;
}

function oneOf(value, allowed, path) {
  if (!allowed.includes(value)) bad(path, `must be one of ${allowed.join(', ')}`);
  return value;
}

function list(value, path, max) {
  if (!Array.isArray(value)) bad(path, 'must be an array');
  if (value.length > max) bad(path, `must contain at most ${max} items`);
  return value;
}

function dateTime(value, path) {
  if (parseTime(value) === null) bad(path, 'must be an RFC 3339 date-time');
  return value;
}

// --- the digest-pinned request the JobTrack CLI issued ---------------------

function validateDraftRequest(value) {
  const root = plain(value, 'request');
  required(root, 'request', [
    'schemaVersion', 'normalizationVersion', 'requestId', 'generationId', 'manifestDigest',
    'factsDigest', 'source', 'delivery', 'toneDecisionId', 'toneDecisionDigest',
    'voiceRevisionId', 'voiceRevisionDigest', 'sourceStateSha256', 'expiresAt', 'context',
    'outputContracts', 'execution', 'effects', 'requiresReview', 'autoSendEligible'
  ]);
  if (root.schemaVersion !== DRAFT_REQUEST_CONTRACT) bad('request.schemaVersion', `must equal ${DRAFT_REQUEST_CONTRACT}`);
  if (root.normalizationVersion !== NORMALIZATION_VERSION) bad('request.normalizationVersion', 'must equal the pinned normalization version');
  for (const key of ['requestId', 'generationId', 'toneDecisionId', 'voiceRevisionId']) id(root[key], `request.${key}`);
  for (const key of ['manifestDigest', 'factsDigest', 'sourceStateSha256', 'toneDecisionDigest', 'voiceRevisionDigest']) sha256(root[key], `request.${key}`);
  dateTime(root.expiresAt, 'request.expiresAt');

  const source = plain(root.source, 'request.source');
  required(source, 'request.source', ['provider', 'accountId', 'messageId', 'threadId', 'replyToAddress', 'inReplyTo', 'references']);
  str(source.provider, 'request.source.provider', 64);
  str(source.accountId, 'request.source.accountId', 500);
  str(source.messageId, 'request.source.messageId', 500);
  str(source.threadId, 'request.source.threadId', 500);
  str(source.replyToAddress, 'request.source.replyToAddress', 320);
  str(source.inReplyTo, 'request.source.inReplyTo', 998);
  const references = list(source.references, 'request.source.references', 50);
  if (!references.length) bad('request.source.references', 'must contain at least one item');
  references.forEach((entry, index) => str(entry, `request.source.references[${index}]`, 998));

  const delivery = plain(root.delivery, 'request.delivery');
  required(delivery, 'request.delivery', ['provider', 'accountId', 'sendFidelity']);
  str(delivery.provider, 'request.delivery.provider', 64);
  str(delivery.accountId, 'request.delivery.accountId', 500);
  if (delivery.sendFidelity !== 'content_equivalent') bad('request.delivery.sendFidelity', 'must equal content_equivalent');

  const context = plain(root.context, 'request.context');
  required(context, 'request.context', ['trust', 'contentCompleteness', 'eventKind', 'evidence', 'security']);
  if (context.trust !== 'untrusted_external') bad('request.context.trust', 'must equal untrusted_external');
  oneOf(context.contentCompleteness, ['metadata_only', 'sanitized_plain_text'], 'request.context.contentCompleteness');
  str(context.eventKind, 'request.context.eventKind', 64);
  const evidence = list(context.evidence, 'request.context.evidence', 20);
  evidence.forEach((entry, index) => {
    const item = plain(entry, `request.context.evidence[${index}]`);
    exact(item, `request.context.evidence[${index}]`, ['field', 'excerpt']);
    required(item, `request.context.evidence[${index}]`, ['field', 'excerpt']);
    oneOf(item.field, EVIDENCE_FIELDS, `request.context.evidence[${index}].field`);
    str(item.excerpt, `request.context.evidence[${index}].excerpt`, 500);
  });
  const security = plain(context.security, 'request.context.security');
  required(security, 'request.context.security', ['risk', 'requiresReview']);
  oneOf(security.risk, ['low', 'medium', 'high'], 'request.context.security.risk');
  bool(security.requiresReview, 'request.context.security.requiresReview');

  const outputContracts = plain(root.outputContracts, 'request.outputContracts');
  exact(outputContracts, 'request.outputContracts', ['proposal', 'approvedContent']);
  if (outputContracts.proposal !== 'email-reply-draft-proposal.v3') bad('request.outputContracts.proposal', 'must equal email-reply-draft-proposal.v3');
  if (outputContracts.approvedContent !== 'email-approved-content.v1') bad('request.outputContracts.approvedContent', 'must equal email-approved-content.v1');

  const execution = plain(root.execution, 'request.execution');
  exact(execution, 'request.execution', ['kind', 'processIsolation', 'toolAccess', 'networkAccess', 'credentialAccess']);
  if (execution.kind !== 'standalone_out_of_process') bad('request.execution.kind', 'must equal standalone_out_of_process');
  if (execution.processIsolation !== 'required') bad('request.execution.processIsolation', 'must equal required');
  for (const key of ['toolAccess', 'networkAccess', 'credentialAccess']) {
    if (execution[key] !== 'none') bad(`request.execution.${key}`, 'must equal none');
  }

  const effects = plain(root.effects, 'request.effects');
  exact(effects, 'request.effects', ['mailboxRead', 'nativeDraft', 'send']);
  for (const key of ['mailboxRead', 'nativeDraft', 'send']) {
    if (effects[key] !== false) bad(`request.effects.${key}`, 'must equal false');
  }
  if (root.requiresReview !== true) bad('request.requiresReview', 'must equal true');
  if (root.autoSendEligible !== false) bad('request.autoSendEligible', 'must equal false');

  if (root.styleProfileId !== undefined || root.styleProfileDigest !== undefined) {
    id(root.styleProfileId, 'request.styleProfileId');
    sha256(root.styleProfileDigest, 'request.styleProfileDigest');
  }
  return root;
}

// --- runner-internal stage contracts ---------------------------------------

function validatePolicy(value) {
  const root = plain(value, 'policy');
  exact(root, 'policy', ['request', 'requestDigest', 'evaluatedAt', 'replyPermitted', 'refusals']);
  required(root, 'policy', ['request', 'requestDigest', 'evaluatedAt', 'replyPermitted', 'refusals']);
  validateDraftRequest(root.request);
  sha256(root.requestDigest, 'policy.requestDigest');
  dateTime(root.evaluatedAt, 'policy.evaluatedAt');
  bool(root.replyPermitted, 'policy.replyPermitted');
  list(root.refusals, 'policy.refusals', 20).forEach((entry, index) => str(entry, `policy.refusals[${index}]`, 200));
  return root;
}

function validateIntent(value) {
  const root = plain(value, 'intent');
  exact(root, 'intent', ['purpose', 'eventKind', 'replyPermitted', 'requiresReview', 'refusals']);
  required(root, 'intent', ['purpose', 'eventKind', 'replyPermitted', 'requiresReview', 'refusals']);
  oneOf(root.purpose, REPLY_PURPOSES, 'intent.purpose');
  str(root.eventKind, 'intent.eventKind', 64);
  bool(root.replyPermitted, 'intent.replyPermitted');
  bool(root.requiresReview, 'intent.requiresReview');
  list(root.refusals, 'intent.refusals', 20).forEach((entry, index) => str(entry, `intent.refusals[${index}]`, 200));
  return root;
}

function validateEvidence(value) {
  const root = plain(value, 'evidence');
  exact(root, 'evidence', ['admitted', 'subjectExcerpt', 'guardedPhrases', 'evidenceDigest']);
  required(root, 'evidence', ['admitted', 'guardedPhrases', 'evidenceDigest']);
  list(root.admitted, 'evidence.admitted', 20).forEach((entry, index) => {
    const item = plain(entry, `evidence.admitted[${index}]`);
    exact(item, `evidence.admitted[${index}]`, ['field', 'excerpt']);
    oneOf(item.field, EVIDENCE_FIELDS, `evidence.admitted[${index}].field`);
    str(item.excerpt, `evidence.admitted[${index}].excerpt`, 500);
  });
  if (root.subjectExcerpt !== undefined) str(root.subjectExcerpt, 'evidence.subjectExcerpt', 500);
  list(root.guardedPhrases, 'evidence.guardedPhrases', 500).forEach((entry, index) => str(entry, `evidence.guardedPhrases[${index}]`, 200));
  sha256(root.evidenceDigest, 'evidence.evidenceDigest');
  return root;
}

function validateComposition(value) {
  const root = plain(value, 'composition');
  exact(root, 'composition', ['subject', 'body', 'authorship', 'templateId', 'registerAdaptationOnly']);
  required(root, 'composition', ['subject', 'body', 'authorship', 'registerAdaptationOnly']);
  str(root.subject, 'composition.subject', 998);
  bodyText(root.body, 'composition.body', 20_000);
  oneOf(root.authorship, AUTHORSHIP_KINDS, 'composition.authorship');
  if (root.authorship === 'template') id(root.templateId, 'composition.templateId');
  else if (root.templateId !== undefined) id(root.templateId, 'composition.templateId');
  if (root.registerAdaptationOnly !== true) bad('composition.registerAdaptationOnly', 'must equal true');
  return root;
}

function validateOutcome(value) {
  const root = plain(value, 'outcome');
  exact(root, 'outcome', ['proposal', 'approvedContent', 'safety']);
  required(root, 'outcome', ['proposal', 'approvedContent', 'safety']);
  validateReplyDraftProposalV3(root.proposal);
  validateEmailApprovedContentV1(root.approvedContent);
  const safety = plain(root.safety, 'outcome.safety');
  exact(safety, 'outcome.safety', ['recipientLocked', 'phraseReuseChecked', 'sensitiveDataScan', 'checks']);
  required(safety, 'outcome.safety', ['recipientLocked', 'phraseReuseChecked', 'sensitiveDataScan', 'checks']);
  if (safety.recipientLocked !== true) bad('outcome.safety.recipientLocked', 'must equal true');
  if (safety.phraseReuseChecked !== true) bad('outcome.safety.phraseReuseChecked', 'must equal true');
  oneOf(safety.sensitiveDataScan, ['passed', 'requires_review'], 'outcome.safety.sensitiveDataScan');
  list(safety.checks, 'outcome.safety.checks', 50).forEach((entry, index) => str(entry, `outcome.safety.checks[${index}]`, 200));
  return root;
}

const VALIDATORS = new Map([
  [DRAFT_REQUEST_CONTRACT, validateDraftRequest],
  [POLICY_CONTRACT, validatePolicy],
  [INTENT_CONTRACT, validateIntent],
  [EVIDENCE_CONTRACT, validateEvidence],
  [COMPOSITION_CONTRACT, validateComposition],
  [OUTCOME_CONTRACT, validateOutcome]
]);

// Mission Pipeline composes several slots into one object under this contract
// when a node takes more than one input. It is the engine's own shape, so the
// validator only checks that each named slot carries a payload this catalog
// knows how to describe; the per-slot contracts are enforced on the edges.
const COMPOSITE_INPUT_CONTRACT = 'pipeline-node-input.v1';

function createDraftRunnerContracts() {
  return Object.freeze({
    knows(contractId) {
      return VALIDATORS.has(contractId) || contractId === COMPOSITE_INPUT_CONTRACT;
    },
    validate(contractId, value) {
      if (contractId === COMPOSITE_INPUT_CONTRACT) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          return { ok: false, issues: [{ message: 'composite stage input must be an object of named slots' }] };
        }
        return { ok: true, value };
      }
      const validator = VALIDATORS.get(contractId);
      if (!validator) return { ok: false, issues: [{ message: `unknown contract ${contractId}` }] };
      try { return { ok: true, value: validator(value) }; }
      catch (error) { return { ok: false, issues: [{ message: String(error.message || error) }] }; }
    }
  });
}

module.exports = Object.freeze({
  COMPOSITE_INPUT_CONTRACT,
  COMPOSITION_CONTRACT,
  DRAFT_REQUEST_CONTRACT,
  EVIDENCE_CONTRACT,
  INTENT_CONTRACT,
  OUTCOME_CONTRACT,
  POLICY_CONTRACT,
  REPLY_PURPOSES,
  createDraftRunnerContracts,
  validateDraftRequest
});
