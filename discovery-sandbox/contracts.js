'use strict';

const crypto = require('node:crypto');

const CONTRACT_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const STRATEGY_KINDS = new Set(['direct-board', 'funding-signal', 'imported-leads']);
const CANDIDATE_KINDS = new Set(['job-posting', 'funding-signal', 'imported-lead']);
const METHODS = new Set(['GET', 'HEAD']);
const CAPABILITIES = new Set(['fetch', 'parse', 'import-leads']);
const EVIDENCE_KINDS = new Set(['retrieval', 'imported-lead', 'public-citation']);
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 20_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLE_IO_BYTES = 32 * 1024 * 1024;

class ContractError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'ContractError';
    this.code = 'CONTRACT_INVALID';
    this.path = path;
  }
}

function validatePluginManifest(value, path = 'manifest') {
  strictObject(value, [
    'schemaVersion', 'kind', 'pluginId', 'pluginVersion', 'strategyKind', 'parserName',
    'parserVersion', 'networkPolicyId', 'capabilities', 'inputSchemaId', 'outputSchemaId', 'limits'
  ], path);
  literal(value.schemaVersion, CONTRACT_VERSION, `${path}.schemaVersion`);
  literal(value.kind, 'plugin-manifest', `${path}.kind`);
  identifier(value.pluginId, `${path}.pluginId`);
  string(value.pluginVersion, `${path}.pluginVersion`, { max: 100, pattern: SEMVER });
  enumValue(value.strategyKind, STRATEGY_KINDS, `${path}.strategyKind`);
  identifier(value.parserName, `${path}.parserName`);
  string(value.parserVersion, `${path}.parserVersion`, { max: 100 });
  nullableIdentifier(value.networkPolicyId, `${path}.networkPolicyId`);
  uniqueStringArray(value.capabilities, `${path}.capabilities`, CAPABILITIES, 3);
  identifier(value.inputSchemaId, `${path}.inputSchemaId`);
  identifier(value.outputSchemaId, `${path}.outputSchemaId`);
  validateLimits(value.limits, `${path}.limits`);

  const capabilities = new Set(value.capabilities);
  if (value.strategyKind === 'imported-leads') {
    if (value.networkPolicyId !== null) fail(`${path}.networkPolicyId`, 'must be null for imported-leads');
    if (!capabilities.has('import-leads')) fail(`${path}.capabilities`, 'must include import-leads');
    if (capabilities.has('fetch')) fail(`${path}.capabilities`, 'must not include fetch for imported-leads');
    if (value.limits.maxRequests !== 0) fail(`${path}.limits.maxRequests`, 'must be 0 for imported-leads');
  } else {
    if (value.networkPolicyId === null) fail(`${path}.networkPolicyId`, 'is required for network-backed strategies');
    if (!capabilities.has('fetch') || !capabilities.has('parse')) {
      fail(`${path}.capabilities`, 'network-backed strategies require fetch and parse');
    }
    if (value.limits.maxRequests < 1) fail(`${path}.limits.maxRequests`, 'must be at least 1');
  }
  return value;
}

function validateLimits(value, path) {
  strictObject(value, [
    'maxRequests', 'maxCompressedBytes', 'maxDecompressedBytes', 'maxInputBytes',
    'maxOutputBytes', 'maxRuntimeMs'
  ], path);
  integer(value.maxRequests, `${path}.maxRequests`, 0, 1000);
  integer(value.maxCompressedBytes, `${path}.maxCompressedBytes`, 1, MAX_BODY_BYTES);
  integer(value.maxDecompressedBytes, `${path}.maxDecompressedBytes`, 1, MAX_BODY_BYTES);
  integer(value.maxInputBytes, `${path}.maxInputBytes`, 1024, MAX_BUNDLE_IO_BYTES);
  integer(value.maxOutputBytes, `${path}.maxOutputBytes`, 1024, MAX_BUNDLE_IO_BYTES);
  integer(value.maxRuntimeMs, `${path}.maxRuntimeMs`, 100, 15 * 60 * 1000);
  return value;
}

function validateFetchIntent(value, path = 'intent') {
  strictObject(value, [
    'schemaVersion', 'kind', 'requestId', 'sourceKey', 'networkPolicyId', 'method', 'url',
    'acceptedContentTypes', 'cacheValidators'
  ], path);
  literal(value.schemaVersion, CONTRACT_VERSION, `${path}.schemaVersion`);
  literal(value.kind, 'fetch-intent', `${path}.kind`);
  identifier(value.requestId, `${path}.requestId`);
  identifier(value.sourceKey, `${path}.sourceKey`);
  identifier(value.networkPolicyId, `${path}.networkPolicyId`);
  enumValue(value.method, METHODS, `${path}.method`);
  httpsUrl(value.url, `${path}.url`);
  uniqueContentTypeArray(value.acceptedContentTypes, `${path}.acceptedContentTypes`);
  strictObject(value.cacheValidators, ['etag', 'lastModified'], `${path}.cacheValidators`);
  nullableHeaderString(value.cacheValidators.etag, `${path}.cacheValidators.etag`, 1024);
  nullableHeaderString(value.cacheValidators.lastModified, `${path}.cacheValidators.lastModified`, 1024);
  return value;
}

function validateRetrievalEnvelope(value, path = 'retrieval') {
  strictObject(value, [
    'schemaVersion', 'kind', 'requestId', 'sourceKey', 'networkPolicyId', 'method',
    'requestedUrl', 'finalUrl', 'status', 'headers', 'fetchedAt', 'durationMs', 'redirects',
    'compressedBytes', 'decompressedBytes', 'compressedSha256', 'bodySha256', 'bodyBase64'
  ], path);
  literal(value.schemaVersion, CONTRACT_VERSION, `${path}.schemaVersion`);
  literal(value.kind, 'retrieval-envelope', `${path}.kind`);
  identifier(value.requestId, `${path}.requestId`);
  identifier(value.sourceKey, `${path}.sourceKey`);
  identifier(value.networkPolicyId, `${path}.networkPolicyId`);
  enumValue(value.method, METHODS, `${path}.method`);
  httpsUrl(value.requestedUrl, `${path}.requestedUrl`);
  httpsUrl(value.finalUrl, `${path}.finalUrl`);
  integer(value.status, `${path}.status`, 100, 599);
  strictObject(value.headers, [
    'contentType', 'contentEncoding', 'etag', 'lastModified', 'retryAfter'
  ], `${path}.headers`);
  nullableString(value.headers.contentType, `${path}.headers.contentType`, { max: 512 });
  nullableString(value.headers.contentEncoding, `${path}.headers.contentEncoding`, { max: 100 });
  nullableString(value.headers.etag, `${path}.headers.etag`, { max: 1024 });
  nullableString(value.headers.lastModified, `${path}.headers.lastModified`, { max: 1024 });
  nullableString(value.headers.retryAfter, `${path}.headers.retryAfter`, { max: 1024 });
  timestamp(value.fetchedAt, `${path}.fetchedAt`);
  integer(value.durationMs, `${path}.durationMs`, 0, 24 * 60 * 60 * 1000);
  array(value.redirects, `${path}.redirects`, 0, 10);
  value.redirects.forEach((item, index) => validateRedirect(item, `${path}.redirects[${index}]`));
  integer(value.compressedBytes, `${path}.compressedBytes`, 0, MAX_BODY_BYTES);
  integer(value.decompressedBytes, `${path}.decompressedBytes`, 0, MAX_BODY_BYTES);
  sha256(value.compressedSha256, `${path}.compressedSha256`);
  sha256(value.bodySha256, `${path}.bodySha256`);
  string(value.bodyBase64, `${path}.bodyBase64`, { max: 24 * 1024 * 1024, allowEmpty: true });
  let decoded;
  try { decoded = Buffer.from(value.bodyBase64, 'base64'); } catch { fail(`${path}.bodyBase64`, 'must be base64'); }
  if (decoded.toString('base64') !== value.bodyBase64) fail(`${path}.bodyBase64`, 'must be canonical base64');
  if (decoded.length !== value.decompressedBytes) fail(`${path}.decompressedBytes`, 'does not match bodyBase64');
  if (digest(decoded) !== value.bodySha256) fail(`${path}.bodySha256`, 'does not match bodyBase64');
  return value;
}

function validateRedirect(value, path) {
  strictObject(value, ['status', 'fromUrl', 'toUrl'], path);
  integer(value.status, `${path}.status`, 300, 399);
  httpsUrl(value.fromUrl, `${path}.fromUrl`);
  httpsUrl(value.toUrl, `${path}.toUrl`);
  return value;
}

function validateCandidateObservation(value, path = 'observation') {
  strictObject(value, [
    'schemaVersion', 'kind', 'observationId', 'sourceFingerprint', 'observationFingerprint',
    'candidateKind', 'sourceKey', 'observedAt',
    'companyName', 'title', 'canonicalUrl', 'provider', 'boardKey', 'externalId',
    'locationText', 'workplaceType', 'employmentType', 'postedAt', 'descriptionText',
    'attributes', 'parser', 'evidence'
  ], path);
  literal(value.schemaVersion, CONTRACT_VERSION, `${path}.schemaVersion`);
  literal(value.kind, 'candidate-observation', `${path}.kind`);
  identifier(value.observationId, `${path}.observationId`);
  sha256(value.sourceFingerprint, `${path}.sourceFingerprint`);
  sha256(value.observationFingerprint, `${path}.observationFingerprint`);
  enumValue(value.candidateKind, CANDIDATE_KINDS, `${path}.candidateKind`);
  identifier(value.sourceKey, `${path}.sourceKey`);
  timestamp(value.observedAt, `${path}.observedAt`);
  nullableString(value.companyName, `${path}.companyName`, { max: 500 });
  nullableString(value.title, `${path}.title`, { max: 1000 });
  httpsUrl(value.canonicalUrl, `${path}.canonicalUrl`);
  nullableString(value.provider, `${path}.provider`, { max: 100 });
  nullableString(value.boardKey, `${path}.boardKey`, { max: 500 });
  nullableString(value.externalId, `${path}.externalId`, { max: 1000 });
  nullableString(value.locationText, `${path}.locationText`, { max: 2000 });
  nullableString(value.workplaceType, `${path}.workplaceType`, { max: 100 });
  nullableString(value.employmentType, `${path}.employmentType`, { max: 100 });
  if (value.postedAt !== null) timestamp(value.postedAt, `${path}.postedAt`);
  nullableString(value.descriptionText, `${path}.descriptionText`, { max: 5 * 1024 * 1024 });
  validateJsonValue(value.attributes, `${path}.attributes`);
  strictObject(value.parser, ['name', 'version'], `${path}.parser`);
  identifier(value.parser.name, `${path}.parser.name`);
  string(value.parser.version, `${path}.parser.version`, { max: 100 });
  array(value.evidence, `${path}.evidence`, 1, 100);
  value.evidence.forEach((item, index) => validateEvidence(item, `${path}.evidence[${index}]`));

  if (value.candidateKind === 'job-posting' && (!value.companyName || !value.title)) {
    fail(path, 'job-posting requires companyName and title');
  }
  if (value.candidateKind === 'imported-lead') {
    if (!value.evidence.some((item) => item.evidenceKind === 'imported-lead')) {
      fail(`${path}.evidence`, 'imported-lead requires imported-lead evidence');
    }
  }
  const expectedSourceFingerprint = sourceFingerprintFor(value);
  if (value.sourceFingerprint !== expectedSourceFingerprint) {
    fail(`${path}.sourceFingerprint`, 'does not match stable source identity');
  }
  const expectedObservationFingerprint = observationFingerprintFor(value);
  if (value.observationFingerprint !== expectedObservationFingerprint) {
    fail(`${path}.observationFingerprint`, 'does not match stable observation content');
  }
  return value;
}

function validateEvidence(value, path) {
  strictObject(value, [
    'evidenceKind', 'requestId', 'url', 'bodySha256', 'capturedAt', 'label'
  ], path);
  enumValue(value.evidenceKind, EVIDENCE_KINDS, `${path}.evidenceKind`);
  nullableIdentifier(value.requestId, `${path}.requestId`);
  httpsUrl(value.url, `${path}.url`);
  if (value.bodySha256 !== null) sha256(value.bodySha256, `${path}.bodySha256`);
  timestamp(value.capturedAt, `${path}.capturedAt`);
  nullableString(value.label, `${path}.label`, { max: 1000 });
  if (value.evidenceKind === 'retrieval' && (!value.requestId || !value.bodySha256)) {
    fail(path, 'retrieval evidence requires requestId and bodySha256');
  }
  if (value.evidenceKind !== 'retrieval' && (value.requestId !== null || value.bodySha256 !== null)) {
    fail(path, 'non-retrieval evidence must not claim a request or response body');
  }
  return value;
}

function validateProposalBundle(value, path = 'bundle') {
  strictObject(value, [
    'schemaVersion', 'kind', 'bundleId', 'contentSha256', 'manifestSha256', 'manifest',
    'run', 'retrievals', 'observations'
  ], path);
  literal(value.schemaVersion, CONTRACT_VERSION, `${path}.schemaVersion`);
  literal(value.kind, 'proposal-bundle', `${path}.kind`);
  string(value.bundleId, `${path}.bundleId`, { max: 80, pattern: /^sha256:[a-f0-9]{64}$/ });
  sha256(value.contentSha256, `${path}.contentSha256`);
  sha256(value.manifestSha256, `${path}.manifestSha256`);
  validatePluginManifest(value.manifest, `${path}.manifest`);
  if (digest(stableJson(value.manifest)) !== value.manifestSha256) {
    fail(`${path}.manifestSha256`, 'does not match manifest');
  }
  validateRun(value.run, `${path}.run`);
  if (value.run.strategyKind !== value.manifest.strategyKind) {
    fail(`${path}.run.strategyKind`, 'does not match manifest.strategyKind');
  }
  array(value.retrievals, `${path}.retrievals`, 0, value.manifest.limits.maxRequests);
  const requestIds = new Set();
  const retrievalByRequestId = new Map();
  value.retrievals.forEach((item, index) => {
    validateRetrievalEnvelope(item, `${path}.retrievals[${index}]`);
    if (requestIds.has(item.requestId)) fail(`${path}.retrievals[${index}].requestId`, 'must be unique');
    requestIds.add(item.requestId);
    retrievalByRequestId.set(item.requestId, item);
    if (item.sourceKey !== value.run.sourceKey) {
      fail(`${path}.retrievals[${index}].sourceKey`, 'does not match run.sourceKey');
    }
    if (item.networkPolicyId !== value.manifest.networkPolicyId) {
      fail(`${path}.retrievals[${index}].networkPolicyId`, 'does not match manifest');
    }
    if (item.compressedBytes > value.manifest.limits.maxCompressedBytes) {
      fail(`${path}.retrievals[${index}].compressedBytes`, 'exceeds manifest limit');
    }
    if (item.decompressedBytes > value.manifest.limits.maxDecompressedBytes) {
      fail(`${path}.retrievals[${index}].decompressedBytes`, 'exceeds manifest limit');
    }
  });
  if (value.manifest.strategyKind === 'imported-leads' && value.retrievals.length !== 0) {
    fail(`${path}.retrievals`, 'imported-leads bundles must not contain network retrievals');
  }
  array(value.observations, `${path}.observations`, 0, 10_000);
  const observationIds = new Set();
  const observationFingerprints = new Set();
  value.observations.forEach((item, index) => {
    validateCandidateObservation(item, `${path}.observations[${index}]`);
    if (observationIds.has(item.observationId)) fail(`${path}.observations[${index}].observationId`, 'must be unique');
    observationIds.add(item.observationId);
    if (observationFingerprints.has(item.observationFingerprint)) {
      fail(`${path}.observations[${index}].observationFingerprint`, 'must be unique within the bundle');
    }
    observationFingerprints.add(item.observationFingerprint);
    if (item.sourceKey !== value.run.sourceKey) {
      fail(`${path}.observations[${index}].sourceKey`, 'does not match run.sourceKey');
    }
    if (item.parser.name !== value.manifest.parserName || item.parser.version !== value.manifest.parserVersion) {
      fail(`${path}.observations[${index}].parser`, 'does not match manifest parser revision');
    }
    for (const evidence of item.evidence) {
      if (evidence.evidenceKind === 'retrieval' && !requestIds.has(evidence.requestId)) {
        fail(`${path}.observations[${index}].evidence`, `references missing retrieval ${evidence.requestId}`);
      }
      if (evidence.evidenceKind === 'retrieval') {
        const retrieval = retrievalByRequestId.get(evidence.requestId);
        if (evidence.url !== retrieval.finalUrl) {
          fail(`${path}.observations[${index}].evidence`, `URL does not match retrieval ${evidence.requestId} finalUrl`);
        }
        if (evidence.bodySha256 !== retrieval.bodySha256) {
          fail(`${path}.observations[${index}].evidence`, `bodySha256 does not match retrieval ${evidence.requestId}`);
        }
      }
    }
  });
  const expected = proposalContentSha256(value);
  if (expected !== value.contentSha256) fail(`${path}.contentSha256`, 'does not match bundle content');
  if (value.bundleId !== `sha256:${expected}`) fail(`${path}.bundleId`, 'does not match contentSha256');
  const outputBytes = Buffer.byteLength(stableJson(value), 'utf8');
  if (outputBytes > value.manifest.limits.maxOutputBytes) {
    fail(path, `serialized bundle exceeds manifest maxOutputBytes (${outputBytes})`);
  }
  return value;
}

function validateRun(value, path = 'run') {
  strictObject(value, ['runId', 'sourceKey', 'strategyKind', 'startedAt', 'completedAt'], path);
  identifier(value.runId, `${path}.runId`);
  identifier(value.sourceKey, `${path}.sourceKey`);
  enumValue(value.strategyKind, STRATEGY_KINDS, `${path}.strategyKind`);
  timestamp(value.startedAt, `${path}.startedAt`);
  timestamp(value.completedAt, `${path}.completedAt`);
  if (Date.parse(value.completedAt) < Date.parse(value.startedAt)) {
    fail(`${path}.completedAt`, 'must not precede startedAt');
  }
  return value;
}

function createProposalBundle({ manifest, run, retrievals = [], observations = [] }) {
  validatePluginManifest(manifest);
  validateRun(run);
  retrievals.forEach((item, index) => validateRetrievalEnvelope(item, `retrievals[${index}]`));
  observations.forEach((item, index) => validateCandidateObservation(item, `observations[${index}]`));
  const base = {
    schemaVersion: CONTRACT_VERSION,
    kind: 'proposal-bundle',
    manifestSha256: digest(stableJson(manifest)),
    manifest,
    run,
    retrievals,
    observations
  };
  const contentSha256 = digest(stableJson(base));
  const bundle = {
    schemaVersion: CONTRACT_VERSION,
    kind: 'proposal-bundle',
    bundleId: `sha256:${contentSha256}`,
    contentSha256,
    manifestSha256: base.manifestSha256,
    manifest,
    run,
    retrievals,
    observations
  };
  return validateProposalBundle(bundle);
}

function proposalContentSha256(bundle) {
  return digest(stableJson({
    schemaVersion: bundle.schemaVersion,
    kind: bundle.kind,
    manifestSha256: bundle.manifestSha256,
    manifest: bundle.manifest,
    run: bundle.run,
    retrievals: bundle.retrievals,
    observations: bundle.observations
  }));
}

function sourceFingerprintFor(observation) {
  const identity = observation.externalId
    ? {
        provider: observation.provider,
        boardKey: observation.boardKey,
        externalId: observation.externalId
      }
    : { canonicalUrl: observation.canonicalUrl };
  return digest(stableJson({
    schemaVersion: CONTRACT_VERSION,
    candidateKind: observation.candidateKind,
    sourceKey: observation.sourceKey,
    identity
  }));
}

function observationFingerprintFor(observation) {
  const evidence = observation.evidence.map((item) => ({
    evidenceKind: item.evidenceKind,
    url: item.url,
    bodySha256: item.bodySha256
  })).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  return digest(stableJson({
    schemaVersion: CONTRACT_VERSION,
    sourceFingerprint: observation.sourceFingerprint,
    facts: {
      candidateKind: observation.candidateKind,
      companyName: observation.companyName,
      title: observation.title,
      canonicalUrl: observation.canonicalUrl,
      provider: observation.provider,
      boardKey: observation.boardKey,
      externalId: observation.externalId,
      locationText: observation.locationText,
      workplaceType: observation.workplaceType,
      employmentType: observation.employmentType,
      postedAt: observation.postedAt,
      descriptionText: observation.descriptionText,
      attributes: observation.attributes
    },
    parser: observation.parser,
    evidence
  }));
}

function withObservationFingerprints(observation) {
  const sourceFingerprint = sourceFingerprintFor(observation);
  const result = { ...observation, sourceFingerprint };
  return { ...result, observationFingerprint: observationFingerprintFor(result) };
}

function validateJsonValue(value, path = 'value') {
  const state = { nodes: 0 };
  walkJson(value, path, 0, state);
  return value;
}

function walkJson(value, path, depth, state) {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) fail(path, `exceeds ${MAX_JSON_NODES} JSON nodes`);
  if (depth > MAX_JSON_DEPTH) fail(path, `exceeds maximum JSON depth ${MAX_JSON_DEPTH}`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { string(value, path, { max: 5 * 1024 * 1024, allowEmpty: true }); return; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must be a finite JSON number');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) fail(path, 'array is too large');
    value.forEach((item, index) => walkJson(item, `${path}[${index}]`, depth + 1, state));
    return;
  }
  if (!plainObject(value)) fail(path, 'must be JSON-compatible');
  for (const key of Object.keys(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${path}.${key}`, 'unsafe key');
    if (key.length > 500) fail(path, 'object key is too long');
    walkJson(value[key], `${path}.${key}`, depth + 1, state);
  }
}

function strictObject(value, keys, path) {
  if (!plainObject(value)) fail(path, 'must be an object');
  const expected = new Set(keys);
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) fail(path, `missing fields: ${missing.join(', ')}`);
  const extra = Object.keys(value).filter((key) => !expected.has(key));
  if (extra.length) fail(path, `unknown fields: ${extra.sort().join(', ')}`);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function literal(value, expected, path) {
  if (value !== expected) fail(path, `must equal ${JSON.stringify(expected)}`);
}

function identifier(value, path) {
  string(value, path, { max: 128, pattern: IDENTIFIER });
}

function nullableIdentifier(value, path) {
  if (value === null) return;
  identifier(value, path);
}

function string(value, path, { min = 1, max = 10_000, pattern = null, allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail(path, 'must be a string');
  const minimum = allowEmpty ? 0 : min;
  if (value.length < minimum || value.length > max) fail(path, `length must be ${minimum}..${max}`);
  if (pattern && !pattern.test(value)) fail(path, 'has an invalid format');
}

function nullableString(value, path, options) {
  if (value === null) return;
  string(value, path, options);
}

function nullableHeaderString(value, path, max) {
  nullableString(value, path, { max });
  if (value !== null && /[\u0000-\u001f\u007f]/.test(value)) fail(path, 'must not contain HTTP control characters');
}

function integer(value, path, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(path, `must be an integer from ${min} to ${max}`);
}

function enumValue(value, allowed, path) {
  if (!allowed.has(value)) fail(path, `must be one of: ${[...allowed].join(', ')}`);
}

function array(value, path, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path, `must be an array with ${min}..${max} items`);
}

function uniqueStringArray(value, path, allowed, max) {
  array(value, path, 0, max);
  const seen = new Set();
  value.forEach((item, index) => {
    enumValue(item, allowed, `${path}[${index}]`);
    if (seen.has(item)) fail(`${path}[${index}]`, 'must be unique');
    seen.add(item);
  });
}

function uniqueContentTypeArray(value, path) {
  array(value, path, 1, 20);
  const seen = new Set();
  value.forEach((item, index) => {
    string(item, `${path}[${index}]`, { max: 200, pattern: /^[a-z0-9!#$&^_.+*-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/ });
    if (seen.has(item)) fail(`${path}[${index}]`, 'must be unique');
    seen.add(item);
  });
}

function httpsUrl(value, path) {
  string(value, path, { max: 16_384 });
  let url;
  try { url = new URL(value); } catch { fail(path, 'must be a valid URL'); }
  if (url.protocol !== 'https:') fail(path, 'must use HTTPS');
  if (url.username || url.password) fail(path, 'must not contain credentials');
  if (url.hash) fail(path, 'must not contain a fragment');
  if (url.port && url.port !== '443') fail(path, 'must use port 443');
  return url;
}

function timestamp(value, path) {
  string(value, path, { max: 100 });
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) fail(path, 'must be an ISO-8601 timestamp');
}

function sha256(value, path) {
  string(value, path, { max: 64, pattern: SHA256 });
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fail(path, message) {
  throw new ContractError(path, message);
}

module.exports = {
  CONTRACT_VERSION,
  ContractError,
  createProposalBundle,
  digest,
  observationFingerprintFor,
  proposalContentSha256,
  sourceFingerprintFor,
  stableJson,
  validateCandidateObservation,
  validateFetchIntent,
  validateJsonValue,
  validatePluginManifest,
  validateProposalBundle,
  validateRetrievalEnvelope,
  validateRun,
  withObservationFingerprints
};
