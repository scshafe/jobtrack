'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  createProposalBundle,
  digest,
  validateCandidateObservation,
  validateFetchIntent,
  validatePluginManifest,
  validateProposalBundle,
  validateRetrievalEnvelope,
  withObservationFingerprints
} = require('../discovery-sandbox/contracts');
const { executeWorkRequest } = require('../discovery-sandbox/controller');

const fixtures = path.join(__dirname, 'fixtures', 'discovery');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
}

function directManifest() {
  return {
    schemaVersion: 1,
    kind: 'plugin-manifest',
    pluginId: 'fixture-board',
    pluginVersion: '1.2.3',
    strategyKind: 'direct-board',
    parserName: 'fixture-board',
    parserVersion: '2',
    networkPolicyId: 'fixture-public-board',
    capabilities: ['fetch', 'parse'],
    inputSchemaId: 'jobtrack.discovery.board.v1',
    outputSchemaId: 'jobtrack.discovery.proposal-bundle.v1',
    limits: {
      maxRequests: 2,
      maxCompressedBytes: 1024 * 1024,
      maxDecompressedBytes: 1024 * 1024,
      maxInputBytes: 2 * 1024 * 1024,
      maxOutputBytes: 4 * 1024 * 1024,
      maxRuntimeMs: 20_000
    }
  };
}

function retrieval(body = Buffer.from('{"jobs":[]}')) {
  return {
    schemaVersion: 1,
    kind: 'retrieval-envelope',
    requestId: 'request-1',
    sourceKey: 'fixture-source',
    networkPolicyId: 'fixture-public-board',
    method: 'GET',
    requestedUrl: 'https://jobs.example.test/board/acme?content=true',
    finalUrl: 'https://jobs.example.test/board/acme?content=true',
    status: 200,
    headers: {
      contentType: 'application/json', contentEncoding: null, etag: null,
      lastModified: null, retryAfter: null
    },
    fetchedAt: '2026-07-17T20:00:00.000Z',
    durationMs: 10,
    redirects: [],
    compressedBytes: body.length,
    decompressedBytes: body.length,
    compressedSha256: digest(body),
    bodySha256: digest(body),
    bodyBase64: body.toString('base64')
  };
}

function observation(bodySha256) {
  return withObservationFingerprints({
    schemaVersion: 1,
    kind: 'candidate-observation',
    observationId: 'observation-1',
    candidateKind: 'job-posting',
    sourceKey: 'fixture-source',
    observedAt: '2026-07-17T20:00:00.000Z',
    companyName: 'Example AI',
    title: 'Platform Engineer',
    canonicalUrl: 'https://jobs.example.test/jobs/123',
    provider: 'fixture',
    boardKey: 'acme',
    externalId: '123',
    locationText: 'Remote',
    workplaceType: 'remote',
    employmentType: 'full-time',
    postedAt: null,
    descriptionText: 'Build platforms.',
    attributes: { requisitionId: 'REQ-123' },
    parser: { name: 'fixture-board', version: '2' },
    evidence: [{
      evidenceKind: 'retrieval',
      requestId: 'request-1',
      url: 'https://jobs.example.test/board/acme?content=true',
      bodySha256,
      capturedAt: '2026-07-17T20:00:00.000Z',
      label: 'Official public board fixture'
    }]
  });
}

test('versioned manifests are strict and imported leads are network-disabled', () => {
  const manifest = fixture('imported-leads-manifest.json');
  assert.equal(validatePluginManifest(manifest), manifest);
  assert.throws(
    () => validatePluginManifest({ ...manifest, networkPolicyId: 'linkedin', capabilities: ['fetch', 'import-leads'] }),
    /must be null for imported-leads/
  );
  assert.throws(() => validatePluginManifest({ ...manifest, surprise: true }), /unknown fields: surprise/);
  assert.throws(() => validatePluginManifest({ ...directManifest(), capabilities: ['parse'] }), /require fetch and parse/);
  assert.throws(
    () => validatePluginManifest({
      ...directManifest(),
      limits: { ...directManifest().limits, maxDecompressedBytes: 16 * 1024 * 1024 + 1 }
    }),
    /maxDecompressedBytes: must be an integer/
  );
});

test('fetch intents and retrieval envelopes reject unknown fields and body digest drift', () => {
  const intent = {
    schemaVersion: 1,
    kind: 'fetch-intent',
    requestId: 'request-1',
    sourceKey: 'fixture-source',
    networkPolicyId: 'fixture-public-board',
    method: 'GET',
    url: 'https://jobs.example.test/board/acme?content=true',
    acceptedContentTypes: ['application/json'],
    cacheValidators: { etag: null, lastModified: null }
  };
  assert.equal(validateFetchIntent(intent), intent);
  assert.throws(() => validateFetchIntent({ ...intent, headers: { cookie: 'secret' } }), /unknown fields: headers/);
  assert.equal(validateRetrievalEnvelope(retrieval()).status, 200);
  assert.throws(() => validateRetrievalEnvelope({ ...retrieval(), bodySha256: '0'.repeat(64) }), /does not match bodyBase64/);
});

test('candidate observations require explicit evidence and bounded JSON attributes', () => {
  const item = observation(retrieval().bodySha256);
  assert.equal(validateCandidateObservation(item), item);
  assert.throws(
    () => validateCandidateObservation({ ...item, evidence: [{ ...item.evidence[0], requestId: null }] }),
    /retrieval evidence requires requestId/
  );
  assert.throws(
    () => validateCandidateObservation({
      ...item,
      evidence: [{ ...item.evidence[0], evidenceKind: 'public-citation' }]
    }),
    /non-retrieval evidence must not claim/
  );
  const unsafe = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => validateCandidateObservation({ ...item, attributes: unsafe }), /unsafe key/);
});

test('proposal bundles are content-addressed and provenance references are closed', () => {
  const manifest = directManifest();
  const fetched = retrieval();
  const bundle = createProposalBundle({
    manifest,
    run: {
      runId: 'run-1', sourceKey: 'fixture-source', strategyKind: 'direct-board',
      startedAt: '2026-07-17T20:00:00.000Z', completedAt: '2026-07-17T20:00:01.000Z'
    },
    retrievals: [fetched],
    observations: [observation(fetched.bodySha256)]
  });
  assert.equal(bundle.bundleId, `sha256:${bundle.contentSha256}`);
  assert.equal(validateProposalBundle(bundle), bundle);
  assert.throws(
    () => validateProposalBundle({ ...bundle, observations: [{ ...bundle.observations[0], title: 'Tampered' }] }),
    /observationFingerprint: does not match stable observation content/
  );
  assert.throws(
    () => validateProposalBundle({ ...bundle, run: { ...bundle.run, completedAt: '2026-07-17T20:00:02.000Z' } }),
    /does not match bundle content/
  );
  assert.throws(
    () => createProposalBundle({ ...bundle, observations: [{ ...bundle.observations[0], evidence: [{ ...bundle.observations[0].evidence[0], requestId: 'missing' }] }] }),
    /references missing retrieval/
  );
  const wrongUrl = withObservationFingerprints({
    ...bundle.observations[0],
    evidence: [{ ...bundle.observations[0].evidence[0], url: 'https://jobs.example.test/other' }]
  });
  assert.throws(
    () => createProposalBundle({ ...bundle, observations: [wrongUrl] }),
    /URL does not match retrieval request-1 finalUrl/
  );
  const wrongBody = withObservationFingerprints({
    ...bundle.observations[0],
    evidence: [{ ...bundle.observations[0].evidence[0], bodySha256: '0'.repeat(64) }]
  });
  assert.throws(
    () => createProposalBundle({ ...bundle, observations: [wrongBody] }),
    /bodySha256 does not match retrieval request-1/
  );
});

test('source and observation fingerprints are stable outside volatile run metadata', () => {
  const first = observation(retrieval().bodySha256);
  const later = withObservationFingerprints({
    ...first,
    observationId: 'run-specific-observation-2',
    observedAt: '2026-07-18T20:00:00.000Z',
    evidence: first.evidence.map((item) => ({ ...item, capturedAt: '2026-07-18T20:00:00.000Z' }))
  });
  assert.equal(later.sourceFingerprint, first.sourceFingerprint);
  assert.equal(later.observationFingerprint, first.observationFingerprint);
  const changed = withObservationFingerprints({ ...first, title: 'Senior Platform Engineer' });
  assert.equal(changed.sourceFingerprint, first.sourceFingerprint);
  assert.notEqual(changed.observationFingerprint, first.observationFingerprint);
});

test('fixture-backed imported-lead work creates a proposal with zero retrievals', () => {
  const request = fixture('imported-leads-work-request.json');
  const bundle = executeWorkRequest(request);
  assert.equal(bundle.manifest.strategyKind, 'imported-leads');
  assert.equal(bundle.retrievals.length, 0);
  assert.equal(bundle.observations[0].provider, 'linkedin');
  assert.equal(bundle.observations[0].attributes.importedOnly, true);
  assert.equal(bundle.observations[0].evidence[0].evidenceKind, 'imported-lead');
});
