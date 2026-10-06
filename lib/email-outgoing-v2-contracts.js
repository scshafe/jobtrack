'use strict';

// Product validators and consistency checks for the additive provider-neutral
// outgoing family adopted at G03. The JSON schemas remain the source of truth;
// this dependency-free module enforces their shape plus the cross-document,
// normalization, digest, chronology, and Ed25519 rules JSON Schema cannot
// express. Frozen v1/v2 validators and artifacts are intentionally untouched.

const crypto = require('node:crypto');
const { types: utilTypes } = require('node:util');

// Cryptographic verification runs after injected key resolvers return. Capture
// every intrinsic used in that post-callback path at module initialization so
// resolver-side mutation cannot substitute executable getters or methods.
const REFLECT_APPLY = Reflect.apply;
const OBJECT_FREEZE = Object.freeze;
const freeze = OBJECT_FREEZE;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const REGEXP_TEST = RegExp.prototype.test;
const IS_PROXY = utilTypes.isProxy;
const BUILTIN_BUFFER = Buffer;
const BUFFER_FROM = BUILTIN_BUFFER.from;
const BUFFER_TO_STRING = BUILTIN_BUFFER.prototype.toString;
const BUILTIN_MAP = Map;
const MAP_GET = BUILTIN_MAP.prototype.get;
const MAP_SET = BUILTIN_MAP.prototype.set;
const CRYPTO_CREATE_PUBLIC_KEY = crypto.createPublicKey;
const CRYPTO_HASH = crypto.hash;
const CRYPTO_VERIFY = crypto.verify;
const ED25519_PUBLIC_KEY_PEM = /^-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=\n-----END PUBLIC KEY-----\n$/;
const CANONICAL_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
const PUBLIC_KEY_INTRINSIC_PROBE = REFLECT_APPLY(CRYPTO_CREATE_PUBLIC_KEY, undefined, [
  '-----BEGIN PUBLIC KEY-----\n'
  + 'MCowBQYDK2VwAyEA0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc=\n'
  + '-----END PUBLIC KEY-----\n'
]);
const PUBLIC_KEY_EXPORT = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  OBJECT_GET_PROTOTYPE_OF(PUBLIC_KEY_INTRINSIC_PROBE),
  'export'
).value;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_KEYS = Object.keys;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_FILTER = Array.prototype.filter;
const ARRAY_INCLUDES = Array.prototype.includes;
const ARRAY_JOIN = Array.prototype.join;
const ARRAY_MAP = Array.prototype.map;
const ARRAY_SOME = Array.prototype.some;
const ARRAY_SORT = Array.prototype.sort;
const HAS_OWN_PROPERTY = Object.prototype.hasOwnProperty;
const BUILTIN_SET = Set;
const SET_ADD = BUILTIN_SET.prototype.add;
const SET_DELETE = BUILTIN_SET.prototype.delete;
const SET_HAS = BUILTIN_SET.prototype.has;
const JSON_STRINGIFY = JSON.stringify;
const NUMBER_IS_FINITE = Number.isFinite;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_REPLACE = String.prototype.replace;
const BUFFER_ALLOC_UNSAFE = BUILTIN_BUFFER.allocUnsafe;
const BUILTIN_UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(BUILTIN_UINT8_ARRAY_PROTOTYPE);
const BUFFER_PROTOTYPE_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(BUILTIN_BUFFER.prototype);
// Character code -> 6-bit value, built once at load so decoding consults no
// prototype-resident lookup an injected callback could replace.
const BASE64_ALPHABET_INDEX = (() => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const table = { __proto__: null };
  for (let index = 0; index < alphabet.length; index += 1) table[alphabet.charCodeAt(index)] = index;
  return OBJECT_FREEZE(table);
})();
const STRING_NORMALIZE = String.prototype.normalize;
const SPKI_PEM_EXPORT_OPTIONS = freeze({ type: 'spki', format: 'pem' });
const SPKI_DER_EXPORT_OPTIONS = freeze({ type: 'spki', format: 'der' });

const NORMALIZATION_VERSION = 'email-text-nfc-lf.v1';
const IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const KEY_OR_IDEMPOTENCY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PROVIDER_CODE = /^[a-z][a-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FAILURE_CODE = /^[a-z][a-z0-9._-]{0,99}$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_INERT_ARRAY_ITEMS = 100_000;

class OutgoingContractError extends Error {
  constructor(message) {
    super(message);
    defineOwn(this, 'name', 'OutgoingContractError');
    defineOwn(this, 'code', 'INVALID_EMAIL_CONTRACT');
  }
}

// Define an own data property without consulting the prototype chain, so an
// inherited accessor can neither observe nor rewrite what is being recorded.
function defineOwn(target, key, value) {
  REFLECT_APPLY(OBJECT_DEFINE_PROPERTY, undefined, [target, key, {
    value,
    writable: true,
    enumerable: false,
    configurable: true
  }]);
}

function serializeCanonical(value) {
  if (value === null || typeof value !== 'object') return REFLECT_APPLY(JSON_STRINGIFY, undefined, [value]);
  if (REFLECT_APPLY(ARRAY_IS_ARRAY, undefined, [value])) {
    return `[${REFLECT_APPLY(ARRAY_JOIN, REFLECT_APPLY(ARRAY_MAP, value, [serializeCanonical]), [','])}]`;
  }
  const keys = REFLECT_APPLY(ARRAY_SORT, REFLECT_APPLY(OBJECT_KEYS, undefined, [value]), []);
  const pairs = REFLECT_APPLY(ARRAY_MAP, keys, [(key) => `${REFLECT_APPLY(JSON_STRINGIFY, undefined, [key])}:${serializeCanonical(value[key])}`]);
  return `{${REFLECT_APPLY(ARRAY_JOIN, pairs, [','])}}`;
}

function stableJson(value) {
  return serializeCanonical(copyInertData(value, 'canonical value'));
}

function digestUtf8Text(value) {
  if (typeof value !== 'string') fail('digestUtf8Text requires a string');
  assertUnicodeScalarString(value, 'digestUtf8Text input');
  return REFLECT_APPLY(CRYPTO_HASH, undefined, ['sha256', value, 'hex']);
}

function digestCanonicalJson(value) {
  if (value === null || typeof value !== 'object') fail('digestCanonicalJson requires an object or array root');
  return REFLECT_APPLY(CRYPTO_HASH, undefined, ['sha256', stableJson(value), 'hex']);
}

function normalizeNfc(value) {
  if (typeof value !== 'string') fail('normalizeNfc requires a string');
  assertUnicodeScalarString(value, 'normalizeNfc input');
  return REFLECT_APPLY(STRING_NORMALIZE, value, ['NFC']);
}

function normalizeBodyV1(value) {
  if (typeof value !== 'string') fail('normalizeBodyV1 requires a string');
  assertUnicodeScalarString(value, 'normalizeBodyV1 input');
  const lineFed = REFLECT_APPLY(STRING_REPLACE, value, [/\r\n?/g, '\n']);
  return REFLECT_APPLY(STRING_NORMALIZE, lineFed, ['NFC']);
}

// Copy only inert JSON-compatible data without invoking an accessor. This is a
// trust-boundary validator, so prototypes, symbols, non-enumerable properties,
// accessors, cycles, bigint, undefined, and non-finite numbers all fail closed.
function copyInertData(value, path = 'value', seen = new BUILTIN_SET()) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, path);
    return value;
  }
  if (typeof value === 'number') {
    if (!REFLECT_APPLY(NUMBER_IS_FINITE, undefined, [value])) fail(`${path} must not contain a non-finite number`);
    return value;
  }
  if (typeof value !== 'object') fail(`${path} must contain JSON-compatible data only`);
  if (IS_PROXY(value)) fail(`${path} must not be a Proxy`);
  if (REFLECT_APPLY(SET_HAS, seen, [value])) fail(`${path} must not contain a cycle`);
  REFLECT_APPLY(SET_ADD, seen, [value]);
  try {
    const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, undefined, [value]);
    const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, undefined, [descriptors]);
    if (REFLECT_APPLY(ARRAY_SOME, keys, [(key) => typeof key === 'symbol'])) fail(`${path} must not contain symbol properties`);
    for (const key of keys) {
      if (typeof key === 'string') assertUnicodeScalarString(key, `${path} property name`);
    }
    if (REFLECT_APPLY(ARRAY_IS_ARRAY, undefined, [value])) {
      const dataKeys = REFLECT_APPLY(ARRAY_FILTER, keys, [(key) => key !== 'length']);
      if (value.length > MAX_INERT_ARRAY_ITEMS) fail(`${path} exceeds the inert-data array limit`);
      if (dataKeys.length !== value.length || REFLECT_APPLY(ARRAY_SOME, dataKeys, [(key, index) => key !== String(index)])) {
        fail(`${path} must be a dense array without named properties`);
      }
      for (const key of dataKeys) {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || 'get' in descriptor || 'set' in descriptor) fail(`${path}[${key}] must be an enumerable data property`);
      }
      const out = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        out[index] = copyInertData(descriptors[String(index)].value, `${path}[${index}]`, seen);
      }
      return freeze(out);
    }
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable) fail(`${path}.${key} must be enumerable`);
      if ('get' in descriptor || 'set' in descriptor) fail(`${path}.${key} must not be an accessor`);
    }
    const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, undefined, [value]);
    if (prototype !== Object.prototype && prototype !== null) fail(`${path} must be a plain object`);
    const out = {};
    for (const key of keys) {
      REFLECT_APPLY(OBJECT_DEFINE_PROPERTY, undefined, [out, key, {
        value: copyInertData(descriptors[key].value, `${path}.${key}`, seen),
        enumerable: true,
        writable: true,
        configurable: true
      }]);
    }
    return freeze(out);
  } finally {
    REFLECT_APPLY(SET_DELETE, seen, [value]);
  }
}

function validateReplyDraftProposalV3(input) {
  const root = object(copyInertData(input, 'replyDraft'), 'replyDraft');
  exactKeys(root, 'replyDraft', [
    'schemaVersion', 'normalizationVersion', 'proposalId', 'generationId', 'manifestDigest',
    'factsDigest', 'source', 'recipient', 'subject', 'body', 'bodyDigest', 'purpose',
    'authorship', 'templateId', 'expiresAt', 'sensitiveDataScan', 'toneDecisionId',
    'toneDecisionDigest', 'styleProfileId', 'styleProfileDigest', 'voiceRevisionId',
    'voiceRevisionDigest', 'sourceStateSha256', 'delivery', 'registerAdaptationOnly',
    'distinctivePhraseReuse', 'requiresReview', 'autoSendEligible'
  ], [
    'schemaVersion', 'normalizationVersion', 'proposalId', 'generationId', 'manifestDigest',
    'factsDigest', 'source', 'recipient', 'subject', 'body', 'bodyDigest', 'purpose',
    'authorship', 'expiresAt', 'sensitiveDataScan', 'toneDecisionId', 'toneDecisionDigest',
    'voiceRevisionId', 'voiceRevisionDigest', 'sourceStateSha256', 'delivery',
    'registerAdaptationOnly', 'distinctivePhraseReuse', 'requiresReview', 'autoSendEligible'
  ]);
  literal(root.schemaVersion, 'email-reply-draft-proposal.v3', 'replyDraft.schemaVersion');
  literal(root.normalizationVersion, NORMALIZATION_VERSION, 'replyDraft.normalizationVersion');
  identifier(root.proposalId, 'replyDraft.proposalId');
  identifier(root.generationId, 'replyDraft.generationId');
  sha256(root.manifestDigest, 'replyDraft.manifestDigest');
  sha256(root.factsDigest, 'replyDraft.factsDigest');
  const source = validateProposalSource(root.source, 'replyDraft.source');
  email(root.recipient, 'replyDraft.recipient');
  normalizedNfc(root.recipient, 'replyDraft.recipient');
  safeHeader(root.subject, 'replyDraft.subject', 998);
  normalizedNfc(root.subject, 'replyDraft.subject');
  boundedString(root.body, 'replyDraft.body', 1, 20_000);
  normalizedBody(root.body, 'replyDraft.body');
  sha256(root.bodyDigest, 'replyDraft.bodyDigest');
  if (digestUtf8Text(root.body) !== root.bodyDigest) {
    fail('replyDraft.bodyDigest must equal SHA-256 of the normalized UTF-8 body');
  }
  if (root.recipient !== source.replyToAddress) fail('replyDraft.recipient must exactly equal replyDraft.source.replyToAddress');
  enumeration(root.purpose, ['acknowledgement', 'scheduling', 'information_response', 'follow_up', 'other'], 'replyDraft.purpose');
  enumeration(root.authorship, ['template', 'model', 'human'], 'replyDraft.authorship');
  if (root.templateId !== undefined) identifier(root.templateId, 'replyDraft.templateId');
  if (root.authorship === 'template' && root.templateId === undefined) fail('template-authored reply drafts require templateId');
  dateTime(root.expiresAt, 'replyDraft.expiresAt');
  enumeration(root.sensitiveDataScan, ['passed', 'requires_review'], 'replyDraft.sensitiveDataScan');
  identifier(root.toneDecisionId, 'replyDraft.toneDecisionId');
  sha256(root.toneDecisionDigest, 'replyDraft.toneDecisionDigest');
  paired(root, 'styleProfileId', 'styleProfileDigest', 'replyDraft');
  if (root.styleProfileId !== undefined) identifier(root.styleProfileId, 'replyDraft.styleProfileId');
  if (root.styleProfileDigest !== undefined) sha256(root.styleProfileDigest, 'replyDraft.styleProfileDigest');
  identifier(root.voiceRevisionId, 'replyDraft.voiceRevisionId');
  sha256(root.voiceRevisionDigest, 'replyDraft.voiceRevisionDigest');
  sha256(root.sourceStateSha256, 'replyDraft.sourceStateSha256');
  validateDelivery(root.delivery, 'replyDraft.delivery');
  literal(root.registerAdaptationOnly, true, 'replyDraft.registerAdaptationOnly');
  literal(root.distinctivePhraseReuse, false, 'replyDraft.distinctivePhraseReuse');
  literal(root.requiresReview, true, 'replyDraft.requiresReview');
  literal(root.autoSendEligible, false, 'replyDraft.autoSendEligible');
  return root;
}

function validateEmailApprovedContentV1(input) {
  const root = object(copyInertData(input, 'approvedContent'), 'approvedContent');
  exactKeys(root, 'approvedContent', [
    'schemaVersion', 'normalizationVersion', 'contentId', 'generationId', 'manifestDigest',
    'provider', 'accountId', 'recipient', 'thread', 'subject', 'body', 'attachments',
    'sendFidelity', 'requiresHumanApproval', 'createdAt'
  ], [
    'schemaVersion', 'normalizationVersion', 'contentId', 'generationId', 'manifestDigest',
    'provider', 'accountId', 'recipient', 'thread', 'subject', 'body', 'attachments',
    'sendFidelity', 'requiresHumanApproval', 'createdAt'
  ]);
  literal(root.schemaVersion, 'email-approved-content.v1', 'approvedContent.schemaVersion');
  literal(root.normalizationVersion, NORMALIZATION_VERSION, 'approvedContent.normalizationVersion');
  identifier(root.contentId, 'approvedContent.contentId');
  identifier(root.generationId, 'approvedContent.generationId');
  sha256(root.manifestDigest, 'approvedContent.manifestDigest');
  providerCode(root.provider, 'approvedContent.provider');
  safeHeader(root.accountId, 'approvedContent.accountId', 500);
  email(root.recipient, 'approvedContent.recipient');
  normalizedNfc(root.recipient, 'approvedContent.recipient');
  validateThread(root.thread, 'approvedContent.thread');
  safeHeader(root.subject, 'approvedContent.subject', 998);
  normalizedNfc(root.subject, 'approvedContent.subject');
  const body = object(root.body, 'approvedContent.body');
  exactKeys(body, 'approvedContent.body', ['mediaType', 'text', 'digest'], ['mediaType', 'text', 'digest']);
  literal(body.mediaType, 'text/plain', 'approvedContent.body.mediaType');
  boundedString(body.text, 'approvedContent.body.text', 1, 20_000);
  normalizedBody(body.text, 'approvedContent.body.text');
  sha256(body.digest, 'approvedContent.body.digest');
  if (digestUtf8Text(body.text) !== body.digest) fail('approvedContent.body.digest must equal SHA-256 of the normalized UTF-8 body');
  const attachments = array(root.attachments, 'approvedContent.attachments', 0);
  if (attachments.length !== 0) fail('approvedContent.attachments must be empty');
  literal(root.sendFidelity, 'content_equivalent', 'approvedContent.sendFidelity');
  literal(root.requiresHumanApproval, true, 'approvedContent.requiresHumanApproval');
  dateTime(root.createdAt, 'approvedContent.createdAt');
  return root;
}

function validateEmailDraftReceiptV1(input) {
  const root = object(copyInertData(input, 'draftReceipt'), 'draftReceipt');
  exactKeys(root, 'draftReceipt', [
    'schemaVersion', 'normalizationVersion', 'receiptId', 'draftProposalId',
    'draftProposalDigest', 'contentDigest', 'generationId', 'manifestDigest', 'provider',
    'accountId', 'recipient', 'threadId', 'providerDraftId', 'providerThreadId', 'outcome',
    'transmission', 'sendFidelity', 'observedAt'
  ], [
    'schemaVersion', 'normalizationVersion', 'receiptId', 'draftProposalId',
    'draftProposalDigest', 'contentDigest', 'generationId', 'manifestDigest', 'provider',
    'accountId', 'recipient', 'threadId', 'providerDraftId', 'outcome', 'transmission',
    'sendFidelity', 'observedAt'
  ]);
  literal(root.schemaVersion, 'email-draft-receipt.v1', 'draftReceipt.schemaVersion');
  literal(root.normalizationVersion, NORMALIZATION_VERSION, 'draftReceipt.normalizationVersion');
  identifier(root.receiptId, 'draftReceipt.receiptId');
  identifier(root.draftProposalId, 'draftReceipt.draftProposalId');
  sha256(root.draftProposalDigest, 'draftReceipt.draftProposalDigest');
  sha256(root.contentDigest, 'draftReceipt.contentDigest');
  identifier(root.generationId, 'draftReceipt.generationId');
  sha256(root.manifestDigest, 'draftReceipt.manifestDigest');
  providerCode(root.provider, 'draftReceipt.provider');
  safeHeader(root.accountId, 'draftReceipt.accountId', 500);
  email(root.recipient, 'draftReceipt.recipient');
  normalizedNfc(root.recipient, 'draftReceipt.recipient');
  safeHeader(root.threadId, 'draftReceipt.threadId', 500);
  safeHeader(root.providerDraftId, 'draftReceipt.providerDraftId', 500);
  if (root.providerThreadId !== undefined) safeHeader(root.providerThreadId, 'draftReceipt.providerThreadId', 500);
  literal(root.outcome, 'created', 'draftReceipt.outcome');
  literal(root.transmission, 'not_sent', 'draftReceipt.transmission');
  literal(root.sendFidelity, 'content_equivalent', 'draftReceipt.sendFidelity');
  dateTime(root.observedAt, 'draftReceipt.observedAt');
  return root;
}

function validateApprovalReceiptV2(input) {
  const root = object(copyInertData(input, 'approval'), 'approval');
  exactKeys(root, 'approval', [
    'schemaVersion', 'normalizationVersion', 'approvalId', 'decision', 'idempotencyKey',
    'generationId', 'manifestDigest', 'approvedContentContractId', 'approvedContentDigest',
    'approver', 'approvedAt', 'expiresAt', 'scope', 'authenticatedChannel', 'attestation'
  ], [
    'schemaVersion', 'normalizationVersion', 'approvalId', 'decision', 'idempotencyKey',
    'generationId', 'manifestDigest', 'approvedContentContractId', 'approvedContentDigest',
    'approver', 'approvedAt', 'expiresAt', 'scope', 'authenticatedChannel', 'attestation'
  ]);
  literal(root.schemaVersion, 'approval-receipt.v2', 'approval.schemaVersion');
  literal(root.normalizationVersion, NORMALIZATION_VERSION, 'approval.normalizationVersion');
  identifier(root.approvalId, 'approval.approvalId');
  literal(root.decision, 'approve', 'approval.decision');
  idempotencyKey(root.idempotencyKey, 'approval.idempotencyKey');
  identifier(root.generationId, 'approval.generationId');
  sha256(root.manifestDigest, 'approval.manifestDigest');
  literal(root.approvedContentContractId, 'email-approved-content.v1', 'approval.approvedContentContractId');
  sha256(root.approvedContentDigest, 'approval.approvedContentDigest');
  const approver = object(root.approver, 'approval.approver');
  exactKeys(approver, 'approval.approver', ['kind', 'id'], ['kind', 'id']);
  // Widened 2026-08-05 (additive): 'policy' marks an auto-approval decided by
  // a standing operator policy (see lib/email-auto-approval.js). A policy
  // receipt never claims a human decided; everything else is identical.
  if (approver.kind !== 'human' && approver.kind !== 'policy') {
    fail("approval.approver.kind must be 'human' or 'policy'");
  }
  boundedString(approver.id, 'approval.approver.id', 1, 320);
  dateTime(root.approvedAt, 'approval.approvedAt');
  dateTime(root.expiresAt, 'approval.expiresAt');
  if (!(parseTime(root.approvedAt) < parseTime(root.expiresAt))) fail('approval.expiresAt must be strictly after approval.approvedAt');
  const scope = object(root.scope, 'approval.scope');
  exactKeys(scope, 'approval.scope', [
    'action', 'maximumSends', 'sendFidelity', 'provider', 'accountId', 'recipient', 'threadId'
  ], ['action', 'maximumSends', 'sendFidelity', 'provider', 'accountId', 'recipient', 'threadId']);
  literal(scope.action, 'send-once', 'approval.scope.action');
  literal(scope.maximumSends, 1, 'approval.scope.maximumSends');
  literal(scope.sendFidelity, 'content_equivalent', 'approval.scope.sendFidelity');
  providerCode(scope.provider, 'approval.scope.provider');
  safeHeader(scope.accountId, 'approval.scope.accountId', 500);
  email(scope.recipient, 'approval.scope.recipient');
  normalizedNfc(scope.recipient, 'approval.scope.recipient');
  safeHeader(scope.threadId, 'approval.scope.threadId', 500);
  validateAuthenticatedChannel(root.authenticatedChannel, 'approval.authenticatedChannel');
  validateAttestation(root.attestation, 'approval.attestation');
  return root;
}

function validateEmailSendRequestV2(input) {
  const root = object(copyInertData(input, 'sendRequest'), 'sendRequest');
  exactKeys(root, 'sendRequest', [
    'schemaVersion', 'normalizationVersion', 'requestId', 'idempotencyKey', 'generationId',
    'manifestDigest', 'provider', 'accountId', 'recipient', 'threadId', 'inReplyTo',
    'references', 'threadEvidenceDigest', 'sendFidelity', 'content', 'approvalDigest',
    'approval', 'requestedAt', 'expiresAt'
  ], [
    'schemaVersion', 'normalizationVersion', 'requestId', 'idempotencyKey', 'generationId',
    'manifestDigest', 'provider', 'accountId', 'recipient', 'threadId', 'inReplyTo',
    'references', 'threadEvidenceDigest', 'sendFidelity', 'content', 'approvalDigest',
    'approval', 'requestedAt', 'expiresAt'
  ]);
  literal(root.schemaVersion, 'email-send-request.v2', 'sendRequest.schemaVersion');
  literal(root.normalizationVersion, NORMALIZATION_VERSION, 'sendRequest.normalizationVersion');
  identifier(root.requestId, 'sendRequest.requestId');
  idempotencyKey(root.idempotencyKey, 'sendRequest.idempotencyKey');
  identifier(root.generationId, 'sendRequest.generationId');
  sha256(root.manifestDigest, 'sendRequest.manifestDigest');
  providerCode(root.provider, 'sendRequest.provider');
  safeHeader(root.accountId, 'sendRequest.accountId', 500);
  email(root.recipient, 'sendRequest.recipient');
  normalizedNfc(root.recipient, 'sendRequest.recipient');
  safeHeader(root.threadId, 'sendRequest.threadId', 500);
  safeHeader(root.inReplyTo, 'sendRequest.inReplyTo', 998);
  normalizedNfc(root.inReplyTo, 'sendRequest.inReplyTo');
  validateReferences(root.references, 'sendRequest.references');
  sha256(root.threadEvidenceDigest, 'sendRequest.threadEvidenceDigest');
  literal(root.sendFidelity, 'content_equivalent', 'sendRequest.sendFidelity');
  const content = object(root.content, 'sendRequest.content');
  exactKeys(content, 'sendRequest.content', ['mode', 'contractId', 'digest'], ['mode', 'contractId', 'digest']);
  literal(content.mode, 'approved_content', 'sendRequest.content.mode');
  literal(content.contractId, 'email-approved-content.v1', 'sendRequest.content.contractId');
  sha256(content.digest, 'sendRequest.content.digest');
  sha256(root.approvalDigest, 'sendRequest.approvalDigest');
  const approval = validateApprovalReceiptV2(root.approval);
  if (digestCanonicalJson(approval) !== root.approvalDigest) fail('sendRequest.approvalDigest must equal the canonical approval digest');
  if (root.idempotencyKey !== approval.idempotencyKey) fail('sendRequest.idempotencyKey must equal approval.idempotencyKey');
  if (content.digest !== approval.approvedContentDigest) fail('sendRequest.content.digest must equal approval.approvedContentDigest');
  for (const field of ['generationId', 'manifestDigest']) {
    if (root[field] !== approval[field]) fail(`sendRequest.${field} must equal approval.${field}`);
  }
  for (const field of ['provider', 'accountId', 'recipient', 'threadId']) {
    if (root[field] !== approval.scope[field]) fail(`sendRequest.${field} must equal approval.scope.${field}`);
  }
  dateTime(root.requestedAt, 'sendRequest.requestedAt');
  dateTime(root.expiresAt, 'sendRequest.expiresAt');
  if (root.expiresAt !== approval.expiresAt) fail('sendRequest.expiresAt must equal approval.expiresAt');
  if (!(parseTime(root.requestedAt) < parseTime(root.expiresAt))) fail('sendRequest.requestedAt must be strictly before sendRequest.expiresAt');
  if (parseTime(root.requestedAt) < parseTime(approval.approvedAt)) fail('sendRequest.requestedAt must not precede approval.approvedAt');
  return root;
}

function validateEmailSendReceiptV2(input) {
  const root = object(copyInertData(input, 'sendReceipt'), 'sendReceipt');
  exactKeys(root, 'sendReceipt', [
    'schemaVersion', 'normalizationVersion', 'receiptId', 'attemptId', 'requestId',
    'idempotencyKey', 'requestDigest', 'generationId', 'manifestDigest', 'provider',
    'accountId', 'recipient', 'threadId', 'contentDigest', 'sendFidelity', 'outcome',
    'classification', 'operationJournalEvidenceDigest', 'providerEvidenceDigest',
    'providerDraftId', 'providerMessageId', 'providerThreadId', 'duplicateOfReceiptId',
    'priorAppliedReceiptDigest', 'nonSendEvidence', 'failure', 'nativeAttestation', 'observedAt'
  ], [
    'schemaVersion', 'normalizationVersion', 'receiptId', 'attemptId', 'requestId',
    'idempotencyKey', 'requestDigest', 'generationId', 'manifestDigest', 'provider',
    'accountId', 'recipient', 'threadId', 'contentDigest', 'sendFidelity', 'outcome',
    'classification', 'operationJournalEvidenceDigest', 'providerEvidenceDigest',
    'nativeAttestation', 'observedAt'
  ]);
  literal(root.schemaVersion, 'email-send-receipt.v2', 'sendReceipt.schemaVersion');
  literal(root.normalizationVersion, NORMALIZATION_VERSION, 'sendReceipt.normalizationVersion');
  for (const field of ['receiptId', 'attemptId', 'requestId']) identifier(root[field], `sendReceipt.${field}`);
  idempotencyKey(root.idempotencyKey, 'sendReceipt.idempotencyKey');
  sha256(root.requestDigest, 'sendReceipt.requestDigest');
  identifier(root.generationId, 'sendReceipt.generationId');
  sha256(root.manifestDigest, 'sendReceipt.manifestDigest');
  providerCode(root.provider, 'sendReceipt.provider');
  safeHeader(root.accountId, 'sendReceipt.accountId', 500);
  email(root.recipient, 'sendReceipt.recipient');
  normalizedNfc(root.recipient, 'sendReceipt.recipient');
  safeHeader(root.threadId, 'sendReceipt.threadId', 500);
  sha256(root.contentDigest, 'sendReceipt.contentDigest');
  literal(root.sendFidelity, 'content_equivalent', 'sendReceipt.sendFidelity');
  enumeration(root.outcome, ['sent', 'duplicate', 'failed', 'indeterminate'], 'sendReceipt.outcome');
  enumeration(root.classification, ['applied', 'unapplied', 'indeterminate'], 'sendReceipt.classification');
  sha256(root.operationJournalEvidenceDigest, 'sendReceipt.operationJournalEvidenceDigest');
  sha256(root.providerEvidenceDigest, 'sendReceipt.providerEvidenceDigest');
  for (const field of ['providerDraftId', 'providerMessageId', 'providerThreadId']) {
    if (root[field] !== undefined) safeHeader(root[field], `sendReceipt.${field}`, 500);
  }
  if (root.duplicateOfReceiptId !== undefined) identifier(root.duplicateOfReceiptId, 'sendReceipt.duplicateOfReceiptId');
  if (root.priorAppliedReceiptDigest !== undefined) sha256(root.priorAppliedReceiptDigest, 'sendReceipt.priorAppliedReceiptDigest');
  if (root.nonSendEvidence !== undefined) validateNonSendEvidence(root.nonSendEvidence, 'sendReceipt.nonSendEvidence');
  if (root.failure !== undefined) validateFailure(root.failure, 'sendReceipt.failure');
  validateAttestation(root.nativeAttestation, 'sendReceipt.nativeAttestation');
  dateTime(root.observedAt, 'sendReceipt.observedAt');

  if (root.outcome === 'sent') {
    requirePresent(root, ['providerMessageId'], 'sendReceipt');
    requireAbsent(root, ['failure', 'duplicateOfReceiptId', 'priorAppliedReceiptDigest', 'nonSendEvidence'], 'sendReceipt');
    literal(root.classification, 'applied', 'sendReceipt.classification');
  } else if (root.outcome === 'duplicate') {
    requirePresent(root, ['duplicateOfReceiptId', 'priorAppliedReceiptDigest', 'providerMessageId'], 'sendReceipt');
    requireAbsent(root, ['failure', 'nonSendEvidence'], 'sendReceipt');
    literal(root.classification, 'applied', 'sendReceipt.classification');
    if (root.duplicateOfReceiptId === root.receiptId) fail('sendReceipt.duplicateOfReceiptId cannot self-reference');
  } else if (root.outcome === 'failed') {
    requirePresent(root, ['failure', 'nonSendEvidence'], 'sendReceipt');
    requireAbsent(root, ['providerMessageId', 'duplicateOfReceiptId', 'priorAppliedReceiptDigest'], 'sendReceipt');
    literal(root.classification, 'unapplied', 'sendReceipt.classification');
    literal(root.failure.retryDisposition, 'terminal', 'sendReceipt.failure.retryDisposition');
  } else {
    requirePresent(root, ['failure'], 'sendReceipt');
    requireAbsent(root, ['providerMessageId', 'duplicateOfReceiptId', 'priorAppliedReceiptDigest', 'nonSendEvidence'], 'sendReceipt');
    literal(root.classification, 'indeterminate', 'sendReceipt.classification');
    literal(root.failure.retryDisposition, 'reconcile_only', 'sendReceipt.failure.retryDisposition');
  }
  return root;
}

function projectApprovedContentFromProposal(proposal, contentIdentity) {
  const draft = validateReplyDraftProposalV3(proposal);
  const identity = object(copyInertData(contentIdentity, 'contentIdentity'), 'contentIdentity');
  exactKeys(identity, 'contentIdentity', ['contentId', 'createdAt'], ['contentId', 'createdAt']);
  identifier(identity.contentId, 'contentIdentity.contentId');
  dateTime(identity.createdAt, 'contentIdentity.createdAt');
  return validateEmailApprovedContentV1({
    schemaVersion: 'email-approved-content.v1',
    normalizationVersion: NORMALIZATION_VERSION,
    contentId: identity.contentId,
    generationId: draft.generationId,
    manifestDigest: draft.manifestDigest,
    provider: draft.delivery.provider,
    accountId: draft.delivery.accountId,
    recipient: draft.recipient,
    thread: {
      threadId: draft.source.threadId,
      inReplyTo: draft.source.inReplyTo,
      references: [...draft.source.references]
    },
    subject: draft.subject,
    body: { mediaType: 'text/plain', text: draft.body, digest: draft.bodyDigest },
    attachments: [],
    sendFidelity: 'content_equivalent',
    requiresHumanApproval: true,
    createdAt: identity.createdAt
  });
}

function assertProposalContentProjection(proposal, content) {
  const expected = projectApprovedContentFromProposal(proposal, {
    contentId: content.contentId,
    createdAt: content.createdAt
  });
  if (stableJson(expected) !== stableJson(content)) fail('approvedContent is not the exact projection of replyDraft');
  return true;
}

function approvalAttestationPayload(approval) {
  const value = object(copyInertData(approval, 'approval'), 'approval');
  const { attestation: _attestation, ...payload } = value;
  return freeze(payload);
}

function nativeReceiptAttestationPayload(receipt) {
  const value = object(copyInertData(receipt, 'sendReceipt'), 'sendReceipt');
  const { nativeAttestation: _nativeAttestation, ...payload } = value;
  return freeze(payload);
}

function approvalAttestationPayloadDigest(approval) {
  return digestCanonicalJson(approvalAttestationPayload(approval));
}

function nativeReceiptAttestationPayloadDigest(receipt) {
  return digestCanonicalJson(nativeReceiptAttestationPayload(receipt));
}

function publicKeyFingerprint(publicKeyInput) {
  return fingerprintDecodedPublicKey(decodePublicKey(publicKeyInput, 'public key'));
}

function fingerprintDecodedPublicKey(key) {
  const spkiDer = REFLECT_APPLY(PUBLIC_KEY_EXPORT, key, [SPKI_DER_EXPORT_OPTIONS]);
  return REFLECT_APPLY(CRYPTO_HASH, undefined, ['sha256', spkiDer, 'hex']);
}

function verifyApprovalAttestation(approval, options) {
  const settings = snapshotVerificationOptions(options, 'approval verification options');
  return verifyAttestationSnapshot({
    document: validateApprovalReceiptV2(approval),
    property: 'attestation',
    payload: approvalAttestationPayload,
    settings,
    label: 'approval',
    keyCache: new BUILTIN_MAP()
  });
}

function verifyNativeReceiptAttestation(receipt, options) {
  const settings = snapshotVerificationOptions(options, 'native receipt verification options');
  return verifyAttestationSnapshot({
    document: validateEmailSendReceiptV2(receipt),
    property: 'nativeAttestation',
    payload: nativeReceiptAttestationPayload,
    settings,
    label: 'native receipt',
    keyCache: new BUILTIN_MAP()
  });
}

// The exact prototype chain this module was loaded against. Node's own byte
// routines resolve `length` and `byteLength` through it, so a replacement is
// not a hostile value to reject but a hostile environment to refuse.
function assertRealmIntegrity() {
  if (REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, undefined, [BUILTIN_UINT8_ARRAY_PROTOTYPE]) !== TYPED_ARRAY_PROTOTYPE
    || BUFFER_PROTOTYPE_PROTOTYPE !== BUILTIN_UINT8_ARRAY_PROTOTYPE
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, undefined, [BUILTIN_BUFFER.prototype]) !== BUILTIN_UINT8_ARRAY_PROTOTYPE) {
    fail('the typed-array prototype chain was replaced; refusing to verify key material');
  }
}

function verifyAttestationSnapshot({ document, property, payload, settings, label, keyCache }) {
  // The resolver below is injected, untrusted code, and so is anything that ran
  // before this call. Refuse outright if the realm itself was altered.
  assertRealmIntegrity();
  const attestation = document[property];
  if (attestation.keyId !== settings.expectedKeyId) fail(`${label} keyId does not match the pinned identity`);
  const expectedPayloadDigest = digestCanonicalJson(payload(document));
  if (attestation.payloadDigest !== expectedPayloadDigest) fail(`${label} payloadDigest mismatch`);
  const cacheKey = `${settings.expectedKeyId}:${settings.expectedPublicKeySha256}`;
  let key = REFLECT_APPLY(MAP_GET, keyCache, [cacheKey]);
  if (!key) {
    let resolved;
    try { resolved = settings.resolvePublicKey(attestation.keyId); }
    catch { fail(`${label} public key resolution failed`); }
    if (!resolved) fail(`${label} public key was not found`);
    key = snapshotResolvedPublicKey(resolved, `${label} resolved public key`);
    const actualFingerprint = fingerprintDecodedPublicKey(key);
    if (actualFingerprint !== settings.expectedPublicKeySha256) fail(`${label} public key does not match the pinned fingerprint`);
    REFLECT_APPLY(MAP_SET, keyCache, [cacheKey, key]);
  }
  const signature = canonicalSignature(attestation.signature, `${label} signature`);
  const bytes = REFLECT_APPLY(BUFFER_FROM, BUILTIN_BUFFER, [stableJson(payload(document)), 'utf8']);
  if (!REFLECT_APPLY(CRYPTO_VERIFY, undefined, [null, bytes, key, signature])) fail(`${label} signature is invalid`);
  return true;
}

// Complete shared five-document pre-effect consistency check. Reconciliation
// extends it with a signed native receipt and, for duplicate, an independently
// resolved prior applied receipt. An empty array is success.
function validateOutgoingV2Consistency(bundleInput, options = {}) {
  const errors = [];
  const check = (condition, code) => { if (!condition) errors.push(code); };
  let settings;
  try { settings = snapshotConsistencyOptions(options); }
  catch (error) { return [`validation_options_invalid:${String(error.message || error)}`]; }
  const phase = settings.phase;
  if (!['claim', 'reconciliation'].includes(phase)) return [phase === undefined ? 'validation_phase_required' : 'validation_phase_invalid'];
  let proposal;
  let content;
  let draftReceipt;
  let approval;
  let request;
  let sendReceipt;
  try {
    const bundle = object(copyInertData(bundleInput, 'bundle'), 'bundle');
    if (phase === 'claim') {
      exactKeys(bundle, 'bundle', ['proposal', 'content', 'draftReceipt', 'approval', 'request'], ['proposal', 'content', 'draftReceipt', 'approval', 'request']);
    } else {
      exactKeys(bundle, 'bundle', ['proposal', 'content', 'draftReceipt', 'approval', 'request', 'sendReceipt'], ['proposal', 'content', 'draftReceipt', 'approval', 'request', 'sendReceipt']);
    }
    proposal = validateReplyDraftProposalV3(bundle.proposal);
    content = validateEmailApprovedContentV1(bundle.content);
    draftReceipt = validateEmailDraftReceiptV1(bundle.draftReceipt);
    approval = validateApprovalReceiptV2(bundle.approval);
    request = validateEmailSendRequestV2(bundle.request);
    if (phase === 'reconciliation') {
      sendReceipt = validateEmailSendReceiptV2(bundle.sendReceipt);
    }
  } catch (error) {
    return [`schema_or_contract_invalid:${String(error.message || error)}`];
  }

  const contentDigest = digestCanonicalJson(content);
  const proposalDigest = digestCanonicalJson(proposal);
  const approvalDigest = digestCanonicalJson(approval);
  const requestDigest = digestCanonicalJson(request);
  check(stableJson(projectApprovedContentFromProposal(proposal, { contentId: content.contentId, createdAt: content.createdAt })) === stableJson(content), 'proposal_content_projection_mismatch');
  check(draftReceipt.draftProposalId === proposal.proposalId, 'draft_receipt_proposal_id_mismatch');
  check(draftReceipt.draftProposalDigest === proposalDigest, 'draft_receipt_proposal_digest_mismatch');
  check(draftReceipt.contentDigest === contentDigest, 'draft_receipt_content_digest_mismatch');
  for (const field of ['generationId', 'manifestDigest', 'provider', 'accountId', 'recipient']) {
    check(draftReceipt[field] === content[field], `draft_receipt_${field}_mismatch`);
  }
  check(draftReceipt.threadId === content.thread.threadId, 'draft_receipt_thread_mismatch');
  check(draftReceipt.transmission === 'not_sent', 'draft_receipt_transmission_mismatch');
  check(approval.approvedContentDigest === contentDigest, 'approval_content_digest_mismatch');
  check(approval.generationId === content.generationId, 'approval_generation_mismatch');
  check(approval.manifestDigest === content.manifestDigest, 'approval_manifest_mismatch');
  for (const field of ['provider', 'accountId', 'recipient']) {
    check(approval.scope[field] === content[field], `approval_${field}_mismatch`);
  }
  check(approval.scope.threadId === content.thread.threadId, 'approval_thread_mismatch');
  check(request.approvalDigest === approvalDigest, 'request_approval_digest_mismatch');
  check(stableJson(request.approval) === stableJson(approval), 'request_embedded_approval_mismatch');
  check(request.content.digest === contentDigest, 'request_content_digest_mismatch');
  for (const field of ['generationId', 'manifestDigest', 'provider', 'accountId', 'recipient']) {
    check(request[field] === content[field], `request_${field}_mismatch`);
  }
  check(request.threadId === content.thread.threadId, 'request_thread_mismatch');
  check(request.inReplyTo === content.thread.inReplyTo, 'request_in_reply_to_mismatch');
  check(stableJson(request.references) === stableJson(content.thread.references), 'request_references_mismatch');
  check(request.idempotencyKey === approval.idempotencyKey, 'request_approval_idempotency_mismatch');
  check(request.expiresAt === approval.expiresAt, 'request_expiry_mismatch');
  chronologyCheck(content.createdAt, draftReceipt.observedAt, 'content_created_after_draft', check);
  chronologyCheck(draftReceipt.observedAt, approval.approvedAt, 'draft_observed_after_approval', check);
  chronologyCheck(content.createdAt, approval.approvedAt, 'content_created_after_approval', check);
  chronologyBefore(approval.approvedAt, approval.expiresAt, 'approval_expiry_not_after_approval', check);
  chronologyBefore(content.createdAt, proposal.expiresAt, 'proposal_expired_before_content', check);
  chronologyBefore(draftReceipt.observedAt, proposal.expiresAt, 'proposal_expired_before_draft', check);
  chronologyBefore(approval.approvedAt, proposal.expiresAt, 'proposal_expired_before_approval', check);
  chronologyBefore(request.requestedAt, proposal.expiresAt, 'proposal_expired_before_request', check);
  chronologyCheck(approval.expiresAt, proposal.expiresAt, 'approval_expiry_exceeds_proposal_expiry', check);
  chronologyCheck(approval.approvedAt, request.requestedAt, 'request_precedes_approval', check);
  chronologyBefore(request.requestedAt, request.expiresAt, 'request_after_expiry', check);
  const approvalKeyCache = new BUILTIN_MAP();
  const nativeKeyCache = new BUILTIN_MAP();
  try {
    verifyAttestationSnapshot({
      document: approval,
      property: 'attestation',
      payload: approvalAttestationPayload,
      settings: settings.approvalKey,
      label: 'approval',
      keyCache: approvalKeyCache
    });
  } catch { check(false, 'approval_attestation_invalid'); }

  if (phase === 'claim') {
    if (parseTime(settings.now) === null) check(false, settings.now === undefined ? 'claim_now_required' : 'claim_now_invalid');
    else {
      chronologyCheck(request.requestedAt, settings.now, 'claim_precedes_request', check);
      chronologyBefore(settings.now, request.expiresAt, 'approval_expired', check);
      chronologyBefore(settings.now, proposal.expiresAt, 'proposal_expired', check);
    }
  } else {
    check(sendReceipt.requestDigest === requestDigest, 'send_receipt_request_digest_mismatch');
    for (const field of ['requestId', 'idempotencyKey', 'generationId', 'manifestDigest', 'provider', 'accountId', 'recipient', 'threadId']) {
      check(sendReceipt[field] === request[field], `send_receipt_${field}_mismatch`);
    }
    check(sendReceipt.contentDigest === contentDigest, 'send_receipt_content_digest_mismatch');
    chronologyCheck(request.requestedAt, sendReceipt.observedAt, 'receipt_precedes_request', check);
    try {
      verifyAttestationSnapshot({
        document: sendReceipt,
        property: 'nativeAttestation',
        payload: nativeReceiptAttestationPayload,
        settings: settings.nativeReceiptKey,
        label: 'native receipt',
        keyCache: nativeKeyCache
      });
    }
    catch { check(false, 'native_receipt_attestation_invalid'); }
    if (settings.now !== undefined) chronologyCheck(sendReceipt.observedAt, settings.now, 'reconciliation_precedes_receipt', check);
    if (sendReceipt.outcome === 'duplicate') {
      let prior;
      if (!settings.resolvePriorAppliedReceipt) {
        check(false, 'duplicate_prior_receipt_resolver_required');
      } else {
        try {
          prior = settings.resolvePriorAppliedReceipt(freeze({
            receiptId: sendReceipt.duplicateOfReceiptId,
            receiptDigest: sendReceipt.priorAppliedReceiptDigest
          }));
        } catch { check(false, 'duplicate_prior_receipt_resolution_failed'); }
      }
      if (!prior) check(false, 'duplicate_prior_receipt_not_found');
      else {
        try {
          prior = validateEmailSendReceiptV2(prior);
          check(digestCanonicalJson(prior) === sendReceipt.priorAppliedReceiptDigest, 'duplicate_prior_digest_mismatch');
          check(prior.receiptId === sendReceipt.duplicateOfReceiptId, 'duplicate_prior_receipt_id_mismatch');
          check(prior.outcome === 'sent' && prior.classification === 'applied', 'duplicate_prior_not_original_applied_sent');
          for (const field of ['requestId', 'idempotencyKey', 'requestDigest', 'generationId', 'manifestDigest', 'provider', 'accountId', 'recipient', 'threadId', 'contentDigest', 'sendFidelity', 'providerMessageId']) {
            check(prior[field] === sendReceipt[field], `duplicate_prior_${field}_mismatch`);
          }
          chronologyCheck(request.requestedAt, prior.observedAt, 'duplicate_prior_precedes_request', check);
          chronologyCheck(prior.observedAt, sendReceipt.observedAt, 'duplicate_precedes_prior_receipt', check);
          verifyAttestationSnapshot({
            document: prior,
            property: 'nativeAttestation',
            payload: nativeReceiptAttestationPayload,
            settings: settings.nativeReceiptKey,
            label: 'duplicate prior native receipt',
            keyCache: nativeKeyCache
          });
        } catch { check(false, 'duplicate_prior_receipt_invalid'); }
      }
    }
  }
  return [...new Set(errors)];
}

function validateProposalSource(value, path) {
  const root = object(value, path);
  exactKeys(root, path, ['provider', 'accountId', 'messageId', 'threadId', 'replyToAddress', 'inReplyTo', 'references'], ['provider', 'accountId', 'messageId', 'threadId', 'replyToAddress', 'inReplyTo', 'references']);
  providerCode(root.provider, `${path}.provider`);
  safeHeader(root.accountId, `${path}.accountId`, 500);
  safeHeader(root.messageId, `${path}.messageId`, 500);
  safeHeader(root.threadId, `${path}.threadId`, 500);
  email(root.replyToAddress, `${path}.replyToAddress`);
  normalizedNfc(root.replyToAddress, `${path}.replyToAddress`);
  safeHeader(root.inReplyTo, `${path}.inReplyTo`, 998);
  normalizedNfc(root.inReplyTo, `${path}.inReplyTo`);
  validateReferences(root.references, `${path}.references`);
  return root;
}

function validateThread(value, path) {
  const root = object(value, path);
  exactKeys(root, path, ['threadId', 'inReplyTo', 'references'], ['threadId', 'inReplyTo', 'references']);
  safeHeader(root.threadId, `${path}.threadId`, 500);
  safeHeader(root.inReplyTo, `${path}.inReplyTo`, 998);
  normalizedNfc(root.inReplyTo, `${path}.inReplyTo`);
  validateReferences(root.references, `${path}.references`);
}

function validateReferences(value, path) {
  const refs = array(value, path, 50);
  if (refs.length < 1) fail(`${path} requires at least one item`);
  const seen = new BUILTIN_SET();
  for (let index = 0; index < refs.length; index += 1) {
    const entry = refs[index];
    safeHeader(entry, `${path}[${index}]`, 998);
    normalizedNfc(entry, `${path}[${index}]`);
    if (REFLECT_APPLY(SET_HAS, seen, [entry])) fail(`${path} must contain unique items`);
    REFLECT_APPLY(SET_ADD, seen, [entry]);
  }
}

function validateDelivery(value, path) {
  const root = object(value, path);
  exactKeys(root, path, ['provider', 'accountId', 'sendFidelity'], ['provider', 'accountId', 'sendFidelity']);
  providerCode(root.provider, `${path}.provider`);
  safeHeader(root.accountId, `${path}.accountId`, 500);
  literal(root.sendFidelity, 'content_equivalent', `${path}.sendFidelity`);
}

function validateAuthenticatedChannel(value, path) {
  const root = object(value, path);
  exactKeys(root, path, ['kind', 'channelId', 'authenticated', 'authenticationReceiptDigest'], ['kind', 'channelId', 'authenticated', 'authenticationReceiptDigest']);
  enumeration(root.kind, ['jobtrack_fixed_command', 'signed_local_bridge'], `${path}.kind`);
  identifier(root.channelId, `${path}.channelId`);
  literal(root.authenticated, true, `${path}.authenticated`);
  sha256(root.authenticationReceiptDigest, `${path}.authenticationReceiptDigest`);
}

function validateAttestation(value, path) {
  const root = object(value, path);
  exactKeys(root, path, ['algorithm', 'keyId', 'payloadDigest', 'signatureEncoding', 'signature'], ['algorithm', 'keyId', 'payloadDigest', 'signatureEncoding', 'signature']);
  literal(root.algorithm, 'Ed25519', `${path}.algorithm`);
  keyId(root.keyId, `${path}.keyId`);
  sha256(root.payloadDigest, `${path}.payloadDigest`);
  literal(root.signatureEncoding, 'base64', `${path}.signatureEncoding`);
  canonicalSignature(root.signature, `${path}.signature`);
}

function validateNonSendEvidence(value, path) {
  const root = object(value, path);
  exactKeys(root, path, ['kind', 'conclusive', 'digest'], ['kind', 'conclusive', 'digest']);
  enumeration(root.kind, ['terminal_pre_effect', 'provider_declared_non_send'], `${path}.kind`);
  literal(root.conclusive, true, `${path}.conclusive`);
  sha256(root.digest, `${path}.digest`);
}

function validateFailure(value, path) {
  const root = object(value, path);
  exactKeys(root, path, ['code', 'message', 'retryDisposition'], ['code', 'message', 'retryDisposition']);
  boundedString(root.code, `${path}.code`, 1, 100);
  if (!FAILURE_CODE.test(root.code)) fail(`${path}.code has an unsupported form`);
  boundedString(root.message, `${path}.message`, 1, 1000);
  enumeration(root.retryDisposition, ['terminal', 'reconcile_only'], `${path}.retryDisposition`);
}

function snapshotVerificationOptions(value, path) {
  const fields = snapshotDataProperties(value, path, [
    'expectedKeyId', 'expectedPublicKeySha256', 'resolvePublicKey'
  ], ['expectedKeyId', 'expectedPublicKeySha256', 'resolvePublicKey']);
  keyId(fields.expectedKeyId, `${path}.expectedKeyId`);
  sha256(fields.expectedPublicKeySha256, `${path}.expectedPublicKeySha256`);
  assertPlainFunction(fields.resolvePublicKey, `${path}.resolvePublicKey`);
  return freeze({
    expectedKeyId: fields.expectedKeyId,
    expectedPublicKeySha256: fields.expectedPublicKeySha256,
    resolvePublicKey: fields.resolvePublicKey
  });
}

function snapshotConsistencyOptions(value) {
  const path = 'consistency options';
  const fields = snapshotDataProperties(value, path, [
    'phase', 'now', 'approvalKey', 'nativeReceiptKey', 'resolvePriorAppliedReceipt'
  ], []);
  if (fields.phase !== undefined && typeof fields.phase !== 'string') fail(`${path}.phase must be a string`);
  if (fields.now !== undefined && typeof fields.now !== 'string') fail(`${path}.now must be a string`);
  if (fields.resolvePriorAppliedReceipt !== undefined) {
    assertPlainFunction(fields.resolvePriorAppliedReceipt, `${path}.resolvePriorAppliedReceipt`);
  }
  return freeze({
    phase: fields.phase,
    now: fields.now,
    approvalKey: fields.approvalKey === undefined
      ? null
      : snapshotVerificationOptions(fields.approvalKey, `${path}.approvalKey`),
    nativeReceiptKey: fields.nativeReceiptKey === undefined
      ? null
      : snapshotVerificationOptions(fields.nativeReceiptKey, `${path}.nativeReceiptKey`),
    resolvePriorAppliedReceipt: fields.resolvePriorAppliedReceipt || null
  });
}

function snapshotDataProperties(value, path, allowed, required) {
  if (value === null || typeof value !== 'object' || REFLECT_APPLY(ARRAY_IS_ARRAY, undefined, [value])) fail(`${path} must be an object`);
  if (IS_PROXY(value)) fail(`${path} must not be a Proxy`);
  const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, undefined, [value]);
  if (prototype !== Object.prototype && prototype !== null) fail(`${path} must be a plain object`);
  const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, undefined, [value]);
  const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, undefined, [descriptors]);
  if (REFLECT_APPLY(ARRAY_SOME, keys, [(key) => typeof key === 'symbol'])) fail(`${path} must not contain symbol properties`);
  const unknown = REFLECT_APPLY(ARRAY_FILTER, keys, [(key) => !REFLECT_APPLY(ARRAY_INCLUDES, allowed, [key])]);
  if (unknown.length) fail(`${path} contains unknown field(s): ${REFLECT_APPLY(ARRAY_JOIN, REFLECT_APPLY(ARRAY_SORT, unknown, []), [', '])}`);
  for (const key of required) if (!REFLECT_APPLY(HAS_OWN_PROPERTY, descriptors, [key])) fail(`${path}.${key} is required`);
  const out = { __proto__: null };
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || 'get' in descriptor || 'set' in descriptor) fail(`${path}.${key} must be an enumerable data property`);
    REFLECT_APPLY(OBJECT_DEFINE_PROPERTY, undefined, [out, key, {
      value: descriptor.value,
      writable: true,
      enumerable: true,
      configurable: true
    }]);
  }
  return out;
}

function assertPlainFunction(value, path) {
  if (typeof value !== 'function') fail(`${path} must be injected`);
  if (IS_PROXY(value)) fail(`${path} must not be a Proxy`);
}

function snapshotResolvedPublicKey(value, path) {
  if (typeof value === 'string') return decodePublicKey(value, path);
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && IS_PROXY(value)) {
    fail(`${path} must not be a Proxy`);
  }
  fail(`${path} must be a canonical public-key-only PEM string primitive`);
}

// Only a string primitive is ever inspected: a KeyObject, wrapper object, or
// any other object shape fails before a single property read, so a hostile
// resolved value can never execute a trap here. The strict pattern pins the
// exact single-line Ed25519 SPKI PEM that Node itself emits, and the
// re-export round trip proves the input was that canonical encoding.
function decodePublicKey(value, path) {
  if (typeof value !== 'string'
    || !REFLECT_APPLY(REGEXP_TEST, ED25519_PUBLIC_KEY_PEM, [value])) {
    fail(`${path} must be a canonical public-key-only PEM string primitive`);
  }
  let key;
  try { key = REFLECT_APPLY(CRYPTO_CREATE_PUBLIC_KEY, undefined, [value]); }
  catch { fail(`${path} cannot be decoded`); }
  let canonical;
  try { canonical = REFLECT_APPLY(PUBLIC_KEY_EXPORT, key, [SPKI_PEM_EXPORT_OPTIONS]); }
  catch { fail(`${path} cannot be re-encoded`); }
  if (canonical !== value) fail(`${path} must be the canonical SPKI PEM encoding of its Ed25519 key`);
  return key;
}

function object(value, path) {
  if (value === null || typeof value !== 'object' || REFLECT_APPLY(ARRAY_IS_ARRAY, undefined, [value])) fail(`${path} must be an object`);
  return value;
}

function exactKeys(value, path, allowed, required) {
  const present = REFLECT_APPLY(OBJECT_KEYS, undefined, [value]);
  const unknown = REFLECT_APPLY(ARRAY_FILTER, present, [(key) => !REFLECT_APPLY(ARRAY_INCLUDES, allowed, [key])]);
  if (unknown.length) fail(`${path} contains unknown field(s): ${REFLECT_APPLY(ARRAY_JOIN, REFLECT_APPLY(ARRAY_SORT, unknown, []), [', '])}`);
  for (const key of required) if (!REFLECT_APPLY(HAS_OWN_PROPERTY, value, [key])) fail(`${path}.${key} is required`);
}

function array(value, path, maximum) {
  if (!REFLECT_APPLY(ARRAY_IS_ARRAY, undefined, [value])) fail(`${path} must be an array`);
  if (value.length > maximum) fail(`${path} exceeds ${maximum} items`);
  return value;
}

function boundedString(value, path, minimum, maximum) {
  if (typeof value !== 'string') fail(`${path} must be a string`);
  const length = [...value].length;
  if (length < minimum || length > maximum) fail(`${path} must contain ${minimum} to ${maximum} Unicode characters`);
}

function safeHeader(value, path, maximum) {
  boundedString(value, path, 1, maximum);
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${path} must not contain control characters`);
}

function identifier(value, path) {
  boundedString(value, path, 1, 200);
  if (!IDENTIFIER.test(value)) fail(`${path} must be a stable identifier`);
}

function keyId(value, path) {
  boundedString(value, path, 1, 200);
  if (!KEY_OR_IDEMPOTENCY_ID.test(value)) fail(`${path} must be a stable key identifier`);
}

function idempotencyKey(value, path) {
  boundedString(value, path, 1, 200);
  if (!KEY_OR_IDEMPOTENCY_ID.test(value)) fail(`${path} must be a stable idempotency key`);
}

function providerCode(value, path) {
  boundedString(value, path, 1, 64);
  if (!PROVIDER_CODE.test(value)) fail(`${path} must be a lowercase provider code`);
}

function sha256(value, path) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${path} must be a lowercase SHA-256 digest`);
}

function email(value, path) {
  boundedString(value, path, 3, 320);
  if (/\s|[\u0000-\u001f\u007f]/.test(value)) fail(`${path} must be an email address without controls`);
  const at = value.lastIndexOf('@');
  if (at < 1 || at !== value.indexOf('@') || at === value.length - 1) fail(`${path} must be an email address`);
}

function normalizedNfc(value, path) {
  if (value !== REFLECT_APPLY(STRING_NORMALIZE, value, ['NFC'])) fail(`${path} must already be Unicode NFC`);
}

function normalizedBody(value, path) {
  if (value !== normalizeBodyV1(value)) fail(`${path} must already be LF + Unicode NFC normalized`);
}

function parseTime(value) {
  if (typeof value !== 'string') return null;
  const match = DATE_TIME_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > days[month - 1]) return null;
  if (match[7] !== 'Z') {
    const offsetHour = Number(match[7].slice(1, 3));
    const offsetMinute = Number(match[7].slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function dateTime(value, path) {
  boundedString(value, path, 1, 100);
  if (parseTime(value) === null) fail(`${path} must be a valid RFC 3339 date-time`);
}

function chronologyCheck(left, right, code, check) {
  const a = parseTime(left);
  const b = parseTime(right);
  check(a !== null && b !== null && a <= b, code);
}

function chronologyBefore(left, right, code, check) {
  const a = parseTime(left);
  const b = parseTime(right);
  check(a !== null && b !== null && a < b, code);
}

function enumeration(value, allowed, path) {
  if (!REFLECT_APPLY(ARRAY_INCLUDES, allowed, [value])) fail(`${path} has an unsupported value`);
}

function literal(value, expected, path) {
  if (value !== expected) fail(`${path} must equal ${JSON.stringify(expected)}`);
}

function paired(value, left, right, path) {
  if ((value[left] === undefined) !== (value[right] === undefined)) fail(`${path}.${left} and ${path}.${right} must be supplied together`);
}

function requirePresent(value, fields, path) {
  for (const field of fields) if (value[field] === undefined) fail(`${path}.${field} is required for ${value.outcome}`);
}

function requireAbsent(value, fields, path) {
  for (const field of fields) if (value[field] !== undefined) fail(`${path}.${field} must be absent for ${value.outcome}`);
}

// The pattern admits only 86 base64 characters plus '==', which always encodes
// exactly 64 bytes. Canonicality is then proved arithmetically rather than by a
// re-encode round trip: the final character carries just the low two bits of the
// last byte, so its remaining four bits must be zero. Decoding is done here by
// index arithmetic instead of Buffer.from/toString, because those read `length`
// through %TypedArray%.prototype and a caller that replaced that intrinsic could
// otherwise run a trap while this module handles its own trusted bytes.
function canonicalSignature(value, path) {
  if (typeof value !== 'string' || value.length !== 88 || !REFLECT_APPLY(REGEXP_TEST, CANONICAL_SIGNATURE_BASE64, [value])) {
    fail(`${path} must be canonical padded base64 for a 64-byte Ed25519 signature`);
  }
  const bytes = REFLECT_APPLY(BUFFER_ALLOC_UNSAFE, BUILTIN_BUFFER, [64]);
  let byteIndex = 0;
  for (let index = 0; index < 84; index += 4) {
    const quad = (base64Value(value, index, path) << 18)
      | (base64Value(value, index + 1, path) << 12)
      | (base64Value(value, index + 2, path) << 6)
      | base64Value(value, index + 3, path);
    bytes[byteIndex] = (quad >> 16) & 0xff;
    bytes[byteIndex + 1] = (quad >> 8) & 0xff;
    bytes[byteIndex + 2] = quad & 0xff;
    byteIndex += 3;
  }
  const high = base64Value(value, 84, path);
  const low = base64Value(value, 85, path);
  if ((low & 0x0f) !== 0) fail(`${path} must be canonical padded base64 for a 64-byte Ed25519 signature`);
  bytes[63] = ((high << 2) | (low >> 4)) & 0xff;
  return bytes;
}

function base64Value(text, index, path) {
  const position = BASE64_ALPHABET_INDEX[REFLECT_APPLY(STRING_CHAR_CODE_AT, text, [index])];
  if (position === undefined) fail(`${path} must be canonical padded base64 for a 64-byte Ed25519 signature`);
  return position;
}

// Node's UTF-8 encoder replaces an unpaired UTF-16 surrogate with U+FFFD.
// Reject those code units before canonicalization, hashing, or signing so two
// distinct in-memory strings can never collapse to the same authenticated
// bytes. Valid supplementary-plane scalar values remain accepted as pairs.
function assertUnicodeScalarString(value, path) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [index]);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [index + 1]);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) fail(`${path} must not contain an unpaired UTF-16 surrogate`);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail(`${path} must not contain an unpaired UTF-16 surrogate`);
    }
  }
  return value;
}

function fail(message) {
  throw new OutgoingContractError(message);
}

module.exports = {
  NORMALIZATION_VERSION,
  OutgoingContractError,
  approvalAttestationPayload,
  approvalAttestationPayloadDigest,
  assertProposalContentProjection,
  copyInertData,
  digestCanonicalJson,
  digestUtf8Text,
  nativeReceiptAttestationPayload,
  nativeReceiptAttestationPayloadDigest,
  normalizeBodyV1,
  normalizeNfc,
  parseTime,
  projectApprovedContentFromProposal,
  publicKeyFingerprint,
  stableJson,
  validateApprovalReceiptV2,
  validateEmailApprovedContentV1,
  validateEmailDraftReceiptV1,
  validateEmailSendReceiptV2,
  validateEmailSendRequestV2,
  validateOutgoingV2Consistency,
  validateReplyDraftProposalV3,
  verifyApprovalAttestation,
  verifyNativeReceiptAttestation
};
