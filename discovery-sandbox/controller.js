'use strict';

const {
  ContractError,
  createProposalBundle,
  validateCandidateObservation,
  validatePluginManifest,
  validateRetrievalEnvelope,
  validateRun,
  withObservationFingerprints
} = require('./contracts');
const { executeBuiltInParser, WORK_REQUEST_SCHEMA_VERSION } = require('./built-in-parsers');

function executeWorkRequest(value) {
  strictObject(value, ['schemaVersion', 'kind', 'manifest', 'run', 'retrievals', 'input'], 'request');
  if (value.schemaVersion !== 1 && value.schemaVersion !== WORK_REQUEST_SCHEMA_VERSION) {
    fail('request.schemaVersion', `must equal 1 or ${WORK_REQUEST_SCHEMA_VERSION}`);
  }
  literal(value.kind, 'strategy-work-request', 'request.kind');
  const manifest = validatePluginManifest(value.manifest, 'request.manifest');
  const run = validateRun(value.run, 'request.run');
  if (run.strategyKind !== manifest.strategyKind) fail('request.run.strategyKind', 'does not match manifest');
  if (!Array.isArray(value.retrievals)) fail('request.retrievals', 'must be an array');
  if (value.retrievals.length > manifest.limits.maxRequests) fail('request.retrievals', 'exceeds manifest maxRequests');
  value.retrievals.forEach((item, index) => validateRetrievalEnvelope(item, `request.retrievals[${index}]`));
  let observations;
  let observationPath;
  if (value.schemaVersion === WORK_REQUEST_SCHEMA_VERSION) {
    strictObject(value.input, ['parserConfig'], 'request.input');
    observations = executeBuiltInParser({
      manifest,
      run,
      retrievals: value.retrievals,
      parserConfig: value.input.parserConfig
    });
    observationPath = 'parser.observations';
  } else if (manifest.strategyKind === 'imported-leads') {
    strictObject(value.input, ['leads'], 'request.input');
    if (value.retrievals.length) fail('request.retrievals', 'imported-leads cannot contain network retrievals');
    observations = importedLeadObservations(value.input.leads, manifest, run);
    observationPath = 'request.input.leads';
  } else {
    strictObject(value.input, ['observations'], 'request.input');
    if (!Array.isArray(value.input.observations) || value.input.observations.length > 10_000) {
      fail('request.input.observations', 'must be an array with at most 10000 items');
    }
    observations = value.input.observations.map((item, index) => validateCandidateObservation(item, `request.input.observations[${index}]`));
    observationPath = 'request.input.observations';
  }
  for (const [index, retrieval] of value.retrievals.entries()) {
    if (retrieval.sourceKey !== run.sourceKey) fail(`request.retrievals[${index}].sourceKey`, 'does not match run.sourceKey');
    if (retrieval.networkPolicyId !== manifest.networkPolicyId) fail(`request.retrievals[${index}].networkPolicyId`, 'does not match manifest');
    if (retrieval.compressedBytes > manifest.limits.maxCompressedBytes) fail(`request.retrievals[${index}].compressedBytes`, 'exceeds manifest limit');
    if (retrieval.decompressedBytes > manifest.limits.maxDecompressedBytes) fail(`request.retrievals[${index}].decompressedBytes`, 'exceeds manifest limit');
  }
  for (const [index, observation] of observations.entries()) {
    if (observation.sourceKey !== run.sourceKey) fail(`${observationPath}[${index}].sourceKey`, 'does not match run.sourceKey');
    if (observation.parser.name !== manifest.parserName || observation.parser.version !== manifest.parserVersion) {
      fail(`${observationPath}[${index}].parser`, 'does not match manifest parser revision');
    }
  }
  return createProposalBundle({ manifest, run, retrievals: value.retrievals, observations });
}

function importedLeadObservations(leads, manifest, run) {
  if (!Array.isArray(leads) || leads.length > 10_000) fail('request.input.leads', 'must be an array with at most 10000 items');
  return leads.map((lead, index) => {
    const path = `request.input.leads[${index}]`;
    validateImportedLead(lead, path);
    if (lead.sourceKey !== run.sourceKey) fail(`${path}.sourceKey`, 'does not match run.sourceKey');
    if (lead.provider === 'linkedin') assertLinkedInUrl(lead.url, `${path}.url`);
    const observation = withObservationFingerprints({
      schemaVersion: 1,
      kind: 'candidate-observation',
      observationId: lead.leadId,
      candidateKind: 'imported-lead',
      sourceKey: lead.sourceKey,
      observedAt: lead.observedAt,
      companyName: lead.companyName,
      title: lead.title,
      canonicalUrl: lead.url,
      provider: lead.provider,
      boardKey: null,
      externalId: lead.externalId,
      locationText: null,
      workplaceType: null,
      employmentType: null,
      postedAt: null,
      descriptionText: null,
      attributes: { importedOnly: true, note: lead.note },
      parser: { name: manifest.parserName, version: manifest.parserVersion },
      evidence: [{
        evidenceKind: 'imported-lead',
        requestId: null,
        url: lead.url,
        bodySha256: null,
        capturedAt: lead.observedAt,
        label: lead.note
      }]
    });
    return validateCandidateObservation(observation, `observations[${index}]`);
  });
}

function validateImportedLead(value, path) {
  strictObject(value, [
    'leadId', 'sourceKey', 'provider', 'url', 'companyName', 'title', 'externalId', 'observedAt', 'note'
  ], path);
  identifier(value.leadId, `${path}.leadId`);
  identifier(value.sourceKey, `${path}.sourceKey`);
  if (!['linkedin', 'manual', 'email-alert', 'licensed-api'].includes(value.provider)) {
    fail(`${path}.provider`, 'must be linkedin, manual, email-alert, or licensed-api');
  }
  httpsUrl(value.url, `${path}.url`);
  nullableText(value.companyName, `${path}.companyName`, 500);
  nullableText(value.title, `${path}.title`, 1000);
  nullableText(value.externalId, `${path}.externalId`, 1000);
  timestamp(value.observedAt, `${path}.observedAt`);
  nullableText(value.note, `${path}.note`, 2000);
  return value;
}

function assertLinkedInUrl(value, path) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) {
    fail(path, 'linkedin imported leads must use a linkedin.com URL');
  }
}

function strictObject(value, fields, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  const expected = new Set(fields);
  const missing = fields.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length) fail(path, `missing fields: ${missing.join(', ')}`);
  const extra = Object.keys(value).filter((field) => !expected.has(field));
  if (extra.length) fail(path, `unknown fields: ${extra.sort().join(', ')}`);
}

function literal(value, expected, path) {
  if (value !== expected) fail(path, `must equal ${JSON.stringify(expected)}`);
}

function identifier(value, path) {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(value)) fail(path, 'has an invalid identifier format');
}

function nullableText(value, path, max) {
  if (value === null) return;
  if (typeof value !== 'string' || value.length < 1 || value.length > max) fail(path, `must be null or a string of length 1..${max}`);
}

function httpsUrl(value, path) {
  let url;
  try { url = new URL(value); } catch { fail(path, 'must be a valid URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    fail(path, 'must be a credential-free HTTPS URL on port 443 with no fragment');
  }
}

function timestamp(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
    fail(path, 'must be an ISO-8601 timestamp');
  }
}

function fail(path, message) {
  throw new ContractError(path, message);
}

module.exports = { executeWorkRequest, importedLeadObservations, validateImportedLead };
