'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  INPUT_SCHEMA_ID,
  OUTPUT_SCHEMA_ID,
  htmlToText,
  listBuiltInParsers
} = require('../discovery-sandbox/built-in-parsers');
const { executeWorkRequest } = require('../discovery-sandbox/controller');
const { digest, validateProposalBundle } = require('../discovery-sandbox/contracts');

const root = path.resolve(__dirname, '..');
const fixtures = path.join(__dirname, 'fixtures', 'discovery');
const definitions = Object.fromEntries(listBuiltInParsers().map((item) => [item.parserName, item]));

function fixtureBuffer(name) {
  return fs.readFileSync(path.join(fixtures, name));
}

function manifestFor(parserName, overrides = {}) {
  const definition = definitions[parserName];
  if (!definition) throw new Error(`unknown test parser ${parserName}`);
  return {
    schemaVersion: 1,
    kind: 'plugin-manifest',
    pluginId: definition.pluginId,
    pluginVersion: '0.3.0',
    strategyKind: definition.strategyKind,
    parserName: definition.parserName,
    parserVersion: definition.parserVersion,
    networkPolicyId: `${definition.parserName}-policy`,
    capabilities: ['fetch', 'parse'],
    inputSchemaId: INPUT_SCHEMA_ID,
    outputSchemaId: OUTPUT_SCHEMA_ID,
    limits: {
      maxRequests: 1,
      maxCompressedBytes: 2 * 1024 * 1024,
      maxDecompressedBytes: 2 * 1024 * 1024,
      maxInputBytes: 4 * 1024 * 1024,
      maxOutputBytes: 4 * 1024 * 1024,
      maxRuntimeMs: 20_000
    },
    ...overrides
  };
}

function retrievalFor(parserName, body, overrides = {}) {
  const manifest = manifestFor(parserName);
  const finalUrl = {
    'ashby-json': 'https://api.ashbyhq.com/posting-api/job-board/acme',
    'greenhouse-json': 'https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true',
    'lever-json': 'https://api.lever.co/v0/postings/example?mode=json',
    'funding-json-feed': 'https://funding.example.test/signals.json'
  }[parserName];
  return {
    schemaVersion: 1,
    kind: 'retrieval-envelope',
    requestId: `${parserName}-request`,
    sourceKey: `${parserName}-source`,
    networkPolicyId: manifest.networkPolicyId,
    method: 'GET',
    requestedUrl: finalUrl,
    finalUrl,
    status: 200,
    headers: {
      contentType: parserName === 'funding-json-feed' ? 'application/feed+json; charset=utf-8' : 'application/json',
      contentEncoding: null,
      etag: null,
      lastModified: null,
      retryAfter: null
    },
    fetchedAt: '2026-07-17T22:00:00.000Z',
    durationMs: 25,
    redirects: [],
    compressedBytes: body.length,
    decompressedBytes: body.length,
    compressedSha256: digest(body),
    bodySha256: digest(body),
    bodyBase64: body.toString('base64'),
    ...overrides
  };
}

function requestFor(parserName, fixtureName, parserConfig, overrides = {}) {
  const body = fixtureBuffer(fixtureName);
  const manifest = manifestFor(parserName);
  return {
    schemaVersion: 2,
    kind: 'strategy-work-request',
    manifest,
    run: {
      runId: `${parserName}-run`,
      sourceKey: `${parserName}-source`,
      strategyKind: manifest.strategyKind,
      startedAt: '2026-07-17T21:59:59.000Z',
      completedAt: '2026-07-17T22:00:01.000Z'
    },
    retrievals: [retrievalFor(parserName, body)],
    input: { parserConfig },
    ...overrides
  };
}

const cases = [
  {
    parserName: 'ashby-json',
    fixtureName: 'ashby-board-response.json',
    parserConfig: { companyName: 'Acme Software', boardKey: 'acme', maxItems: 10 },
    expected: { provider: 'ashby', company: 'Acme Software', title: 'Senior Platform Engineer', kind: 'job-posting' }
  },
  {
    parserName: 'greenhouse-json',
    fixtureName: 'greenhouse-board-response.json',
    parserConfig: { companyName: 'Example Hardware', boardKey: 'example', maxItems: 10 },
    expected: { provider: 'greenhouse', company: 'Example Hardware', title: 'FPGA Engineer', kind: 'job-posting' }
  },
  {
    parserName: 'lever-json',
    fixtureName: 'lever-board-response.json',
    parserConfig: { companyName: 'Example Product', boardKey: 'example', maxItems: 10 },
    expected: { provider: 'lever', company: 'Example Product', title: 'Frontend Engineer', kind: 'job-posting' }
  },
  {
    parserName: 'funding-json-feed',
    fixtureName: 'funding-json-feed-response.json',
    parserConfig: { feedName: 'reviewed-funding', maxItems: 10 },
    expected: { provider: 'funding-feed', company: 'Acme Robotics', title: 'Acme Robotics raises a Series B', kind: 'funding-signal' }
  }
];

test('closed registry contains only the four reviewed parser identities', () => {
  assert.deepEqual(listBuiltInParsers(), [
    { pluginId: 'jobtrack.ashby-public-board', parserName: 'ashby-json', parserVersion: '1', strategyKind: 'direct-board', configKind: 'board' },
    { pluginId: 'jobtrack.greenhouse-public-board', parserName: 'greenhouse-json', parserVersion: '1', strategyKind: 'direct-board', configKind: 'board' },
    { pluginId: 'jobtrack.lever-public-board', parserName: 'lever-json', parserVersion: '1', strategyKind: 'direct-board', configKind: 'board' },
    { pluginId: 'jobtrack.funding-json-feed', parserName: 'funding-json-feed', parserVersion: '1', strategyKind: 'funding-signal', configKind: 'funding-feed' }
  ]);
  assert.equal(listBuiltInParsers().some((item) => /linkedin/i.test(`${item.pluginId}/${item.parserName}`)), false);
});

for (const scenario of cases) {
  test(`${scenario.parserName} turns one exact retrieval into evidence-bound candidate facts`, () => {
    const request = requestFor(scenario.parserName, scenario.fixtureName, scenario.parserConfig);
    const bundle = executeWorkRequest(request);
    validateProposalBundle(bundle);
    assert.equal(bundle.retrievals.length, 1);
    assert.equal(bundle.observations.length, 1);
    const observation = bundle.observations[0];
    assert.equal(observation.provider, scenario.expected.provider);
    assert.equal(observation.companyName, scenario.expected.company);
    assert.equal(observation.title, scenario.expected.title);
    assert.equal(observation.candidateKind, scenario.expected.kind);
    assert.deepEqual(observation.attributes.parserConfig, scenario.parserConfig);
    assert.deepEqual(observation.evidence, [{
      evidenceKind: 'retrieval',
      requestId: request.retrievals[0].requestId,
      url: request.retrievals[0].finalUrl,
      bodySha256: request.retrievals[0].bodySha256,
      capturedAt: request.retrievals[0].fetchedAt,
      label: `${scenario.parserName} public JSON retrieval`
    }]);
  });
}

test('provider HTML becomes inert normalized text and blocked markup content is discarded', () => {
  const ashby = executeWorkRequest(requestFor(
    'ashby-json', 'ashby-board-response.json',
    { companyName: 'Acme Software', boardKey: 'acme', maxItems: 10 }
  )).observations[0];
  assert.match(ashby.descriptionText, /Build safely/);
  assert.match(ashby.descriptionText, /Own APIs & infrastructure/);
  assert.doesNotMatch(ashby.descriptionText, /<[^>]*>|ignoreMe|onerror|steal/);

  const greenhouse = executeWorkRequest(requestFor(
    'greenhouse-json', 'greenhouse-board-response.json',
    { companyName: 'Example Hardware', boardKey: 'example', maxItems: 10 }
  )).observations[0];
  assert.match(greenhouse.descriptionText, /Design & verify FPGA systems/);
  assert.doesNotMatch(greenhouse.descriptionText, /<[^>]*>|do-not-run|script/i);

  const lever = executeWorkRequest(requestFor(
    'lever-json', 'lever-board-response.json',
    { companyName: 'Example Product', boardKey: 'example', maxItems: 10 }
  )).observations[0];
  assert.match(lever.descriptionText, /Build accessible interfaces/);
  assert.match(lever.descriptionText, /Ship UI/);
  assert.doesNotMatch(lever.descriptionText, /<[^>]*>|onerror|run\(\)/i);

  assert.equal(htmlToText('<p>Hello &amp; goodbye</p><script>bad()</script>'), 'Hello & goodbye');
});

test('funding feed emits a review signal, not a fabricated job posting or application', () => {
  const signal = executeWorkRequest(requestFor(
    'funding-json-feed', 'funding-json-feed-response.json',
    { feedName: 'reviewed-funding', maxItems: 10 }
  )).observations[0];
  assert.equal(signal.candidateKind, 'funding-signal');
  assert.equal(signal.attributes.round, 'Series B');
  assert.equal(signal.attributes.amount, '$40M');
  assert.equal(signal.attributes.careersUrl, 'https://www.acmerobotics.example/careers');
  assert.doesNotMatch(JSON.stringify(signal), /applicationId|applied|autoApply/i);
});

test('v2 output is byte-for-byte deterministic for frozen run and retrieval facts', () => {
  for (const scenario of cases) {
    const request = requestFor(scenario.parserName, scenario.fixtureName, scenario.parserConfig);
    const first = executeWorkRequest(request);
    const second = executeWorkRequest(structuredClone(request));
    assert.deepEqual(second, first);
    assert.equal(second.contentSha256, first.contentSha256);
    assert.equal(second.bundleId, `sha256:${second.contentSha256}`);
  }
});

test('the one-shot networkless worker executes a v2 parser request on stdin', () => {
  const request = requestFor('ashby-json', 'ashby-board-response.json', {
    companyName: 'Acme Software', boardKey: 'acme', maxItems: 10
  });
  const result = spawnSync(process.execPath, [path.join(root, 'discovery-sandbox', 'strategy-worker.js')], {
    cwd: root,
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 5000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const bundle = JSON.parse(result.stdout);
  validateProposalBundle(bundle);
  assert.equal(bundle.observations[0].provider, 'ashby');
  assert.equal(bundle.observations[0].evidence[0].bodySha256, request.retrievals[0].bodySha256);
});

test('unknown parser identities, revisions, and dynamic-looking names fail closed', () => {
  const request = requestFor('ashby-json', 'ashby-board-response.json', {
    companyName: 'Acme Software', boardKey: 'acme', maxItems: 10
  });
  assert.throws(
    () => executeWorkRequest({ ...request, manifest: { ...request.manifest, pluginId: 'attacker.module' } }),
    /unsupported built-in parser identity/
  );
  assert.throws(
    () => executeWorkRequest({ ...request, manifest: { ...request.manifest, parserName: '..\/evil' } }),
    /invalid format/
  );
  assert.throws(
    () => executeWorkRequest({ ...request, manifest: { ...request.manifest, parserVersion: '2' } }),
    /unsupported revision/
  );
  const linkedIn = {
    ...request,
    manifest: {
      ...request.manifest,
      pluginId: 'jobtrack.linkedin-crawler',
      parserName: 'linkedin-json'
    }
  };
  assert.throws(() => executeWorkRequest(linkedIn), /unsupported built-in parser identity/);
});

test('parser configs are strict, bounded data and cannot supply code or field mappings', () => {
  const request = requestFor('lever-json', 'lever-board-response.json', {
    companyName: 'Example Product', boardKey: 'example', maxItems: 10
  });
  assert.throws(
    () => executeWorkRequest({ ...request, input: { parserConfig: { ...request.input.parserConfig, module: './evil.js' } } }),
    /unknown fields: module/
  );
  assert.throws(
    () => executeWorkRequest({ ...request, input: { parserConfig: { ...request.input.parserConfig, maxItems: 1001 } } }),
    /maxItems: must be an integer/
  );
  assert.throws(
    () => executeWorkRequest({ ...request, input: { parserConfig: { ...request.input.parserConfig, boardKey: '../private' } } }),
    /invalid board key format/
  );
});

test('unknown provider fields and schemas fail closed instead of being guessed', () => {
  const request = requestFor('ashby-json', 'ashby-board-response.json', {
    companyName: 'Acme Software', boardKey: 'acme', maxItems: 10
  });
  const document = JSON.parse(Buffer.from(request.retrievals[0].bodyBase64, 'base64'));
  document.jobs[0].instructions = 'load a plugin';
  const body = Buffer.from(JSON.stringify(document));
  request.retrievals = [retrievalFor('ashby-json', body)];
  assert.throws(() => executeWorkRequest(request), /unknown fields: instructions/);

  const unknownVersion = structuredClone(request);
  delete document.jobs[0].instructions;
  document.apiVersion = '2';
  const versionBody = Buffer.from(JSON.stringify(document));
  unknownVersion.retrievals = [retrievalFor('ashby-json', versionBody)];
  assert.throws(() => executeWorkRequest(unknownVersion), /ashby.apiVersion: must equal "1"/);
});

test('unsafe JSON keys, oversized collections, and oversized description fields are rejected', () => {
  const config = { companyName: 'Acme Software', boardKey: 'acme', maxItems: 10 };
  const unsafeBody = Buffer.from('{"apiVersion":"1","jobs":[],"__proto__":{"polluted":true}}');
  const unsafe = requestFor('ashby-json', 'ashby-board-response.json', config);
  unsafe.retrievals = [retrievalFor('ashby-json', unsafeBody)];
  assert.throws(() => executeWorkRequest(unsafe), /unsafe key/);
  assert.equal({}.polluted, undefined);

  const lever = JSON.parse(fixtureBuffer('lever-board-response.json'));
  lever.push(structuredClone(lever[0]));
  lever[1].id = 'second-job';
  lever[1].hostedUrl = 'https://jobs.lever.co/example/second-job';
  const tooMany = requestFor('lever-json', 'lever-board-response.json', {
    companyName: 'Example Product', boardKey: 'example', maxItems: 1
  });
  tooMany.retrievals = [retrievalFor('lever-json', Buffer.from(JSON.stringify(lever)))];
  assert.throws(() => executeWorkRequest(tooMany), /lever: must be an array with at most 1 items/);

  const ashby = JSON.parse(fixtureBuffer('ashby-board-response.json'));
  ashby.jobs[0].descriptionPlain = 'x'.repeat(512 * 1024 + 1);
  const oversizedBody = Buffer.from(JSON.stringify(ashby));
  const oversized = requestFor('ashby-json', 'ashby-board-response.json', config);
  oversized.retrievals = [retrievalFor('ashby-json', oversizedBody)];
  assert.throws(() => executeWorkRequest(oversized), /descriptionPlain: must be null or a string/);
});

test('parsers require one successful UTF-8 JSON retrieval with an exact declared media type', () => {
  const request = requestFor('greenhouse-json', 'greenhouse-board-response.json', {
    companyName: 'Example Hardware', boardKey: 'example', maxItems: 10
  });
  assert.throws(() => executeWorkRequest({ ...request, retrievals: [] }), /require exactly one retrieval/);

  const badStatus = { ...request.retrievals[0], status: 304 };
  assert.throws(() => executeWorkRequest({ ...request, retrievals: [badStatus] }), /require HTTP 200/);

  const badType = {
    ...request.retrievals[0],
    headers: { ...request.retrievals[0].headers, contentType: 'text/html' }
  };
  assert.throws(() => executeWorkRequest({ ...request, retrievals: [badType] }), /must declare a JSON media type/);

  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]);
  assert.throws(
    () => executeWorkRequest({ ...request, retrievals: [retrievalFor('greenhouse-json', invalidUtf8)] }),
    /valid UTF-8 JSON/
  );
});

test('networkless parser dependency chain has no network, DB, execution, or dynamic loading primitive', () => {
  const files = [
    'discovery-sandbox/strategy-worker.js',
    'discovery-sandbox/controller.js',
    'discovery-sandbox/built-in-parsers.js',
    'discovery-sandbox/contracts.js'
  ];
  const source = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert.doesNotMatch(source, /require\(['"](?:node:)?(?:http|https|http2|net|dns|tls|dgram|child_process|cluster|vm|module|worker_threads|better-sqlite3|sqlite3)['"]\)/);
  assert.doesNotMatch(source, /\b(?:fetch|eval)\s*\(|new\s+Function\s*\(|process\.binding\s*\(/);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /require\s*\(\s*[^'"\s]/);
  assert.doesNotMatch(source, /jobtrack\.db|JOBTRACK_HOME|docker\.sock/i);
});
