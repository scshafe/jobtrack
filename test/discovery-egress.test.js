'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const zlib = require('node:zlib');
const { EgressBroker, createMemoryRateHooks, httpsTransport, parseRetryAfter } = require('../discovery-sandbox/egress-broker');
const {
  isForbiddenIp,
  matchAllowedUrl,
  resolvePublicAddresses,
  validateNetworkPolicy
} = require('../discovery-sandbox/network-policy');

const discoveryFixtures = path.join(__dirname, 'fixtures', 'discovery');
const policyFixture = path.join(discoveryFixtures, 'public-egress-policy.json');

function policy(overrides = {}) {
  const value = JSON.parse(fs.readFileSync(policyFixture, 'utf8'));
  return { ...value, ...overrides, limits: { ...value.limits, ...(overrides.limits || {}) } };
}

function intent(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'fetch-intent',
    requestId: 'request-1',
    sourceKey: 'fixture-source',
    networkPolicyId: 'fixture-public-board',
    method: 'GET',
    url: 'https://jobs.example.test/board/acme?content=true',
    acceptedContentTypes: ['application/json'],
    cacheValidators: { etag: null, lastModified: null },
    ...overrides
  };
}

function response(statusCode, headers = {}, body = Buffer.alloc(0)) {
  return { statusCode, headers, body: Readable.from([body]) };
}

function publicLookup(hostname) {
  return Promise.resolve([{ address: hostname === 'redirect.example.test' ? '93.184.216.35' : '93.184.216.34', family: 4 }]);
}

test('network policy uses exact hosts, explicit path rules, and query allowlists', () => {
  const value = validateNetworkPolicy(policy());
  assert.equal(matchAllowedUrl('https://jobs.example.test/board/acme?content=true', value).hostname, 'jobs.example.test');
  assert.throws(() => matchAllowedUrl('https://jobs.example.test/board/acme/extra?content=true', value), /Path is not allowlisted/);
  assert.throws(() => matchAllowedUrl('https://evil.example.test/board/acme?content=true', value), /Origin is not allowlisted/);
  assert.throws(() => matchAllowedUrl('https://jobs.example.test/board/acme?content=false', value), /Required query does not match/);
  assert.throws(() => matchAllowedUrl('https://jobs.example.test/board/acme?content=true&token=x', value), /Query key is not allowlisted/);
  assert.throws(
    () => matchAllowedUrl('https://jobs.example.test/api/jobs/%2e%2e/private?content=true', value),
    /Path is not allowlisted|encoded separators/
  );
});

test('IPv4, IPv6, metadata, and Tailscale/private address classes fail closed', async () => {
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '100.127.255.254', '127.0.0.1',
    '169.254.169.254', '172.16.0.1', '192.168.1.1', '224.0.0.1',
    '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fd7a:115c:a1e0::1',
    'fe80::1', 'ff02::1', '2001:db8::1', '2002::1'
  ]) assert.equal(isForbiddenIp(address), true, address);
  for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.equal(isForbiddenIp(address), false, address);
  }
  await assert.rejects(
    resolvePublicAddresses('jobs.example.test', async () => [
      { address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }
    ]),
    (error) => error.code === 'ADDRESS_DENIED'
  );
});

test('broker pins validated DNS and emits a provenance-complete envelope without forwarding secrets', async () => {
  let transportCall;
  const broker = new EgressBroker({
    policy: policy(),
    lookup: publicLookup,
    transport: async (options) => {
      transportCall = options;
      return response(200, { 'content-type': 'application/json; charset=utf-8', etag: '"v1"' }, Buffer.from('{"jobs":[]}'));
    }
  });
  const result = await broker.fetch(intent({ cacheValidators: { etag: '"old"', lastModified: null } }));
  assert.equal(transportCall.address, '93.184.216.34');
  assert.equal(transportCall.family, 4);
  assert.equal(transportCall.headers['if-none-match'], '"old"');
  assert.equal(transportCall.headers.cookie, undefined);
  assert.equal(transportCall.headers.authorization, undefined);
  assert.equal(transportCall.headers['proxy-authorization'], undefined);
  assert.equal(result.status, 200);
  assert.equal(Buffer.from(result.bodyBase64, 'base64').toString(), '{"jobs":[]}');
  assert.match(result.bodySha256, /^[a-f0-9]{64}$/);
  assert.equal(result.headers.etag, '"v1"');
});

// A throwaway self-signed certificate for jobs.example.test, minted per run so
// no private key is checked in. Returns null when no openssl CLI is available.
function selfSignedCertificate(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-egress-tls-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const result = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', keyFile, '-out', certFile, '-days', '1',
    '-subj', '/CN=jobs.example.test', '-addext', 'subjectAltName=DNS:jobs.example.test'
  ], { encoding: 'utf8', timeout: 20000 });
  if (result.error || result.status !== 0) return null;
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

test('default HTTPS transport pins the validated address while preserving TLS SNI and Host', async (context) => {
  const material = selfSignedCertificate(context);
  if (!material) {
    context.skip('openssl is not available to mint a test certificate');
    return;
  }
  const { key, cert } = material;
  let seen;
  const server = https.createServer({ key, cert }, (request, response) => {
    seen = { host: request.headers.host, servername: request.socket.servername, path: request.url };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"pinned":true}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await httpsTransport({
    url: new URL('https://jobs.example.test/pinned?fixture=true'),
    method: 'GET',
    headers: { accept: 'application/json' },
    address: '127.0.0.1',
    family: 4,
    timeoutMs: 2000,
    connectPort: server.address().port,
    ca: cert
  });
  const chunks = [];
  for await (const chunk of result.body) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), '{"pinned":true}');
  assert.equal(seen.host, `jobs.example.test:${server.address().port}`);
  assert.equal(seen.servername, 'jobs.example.test');
  assert.equal(seen.path, '/pinned?fixture=true');
});

test('every redirect is rechecked against policy and DNS before transport', async () => {
  const calls = [];
  const broker = new EgressBroker({
    policy: policy(),
    lookup: publicLookup,
    transport: async (options) => {
      calls.push({ url: options.url.href, headers: options.headers });
      if (calls.length === 1) return response(302, { location: 'https://redirect.example.test/final' });
      return response(200, { 'content-type': 'application/json' }, Buffer.from('{}'));
    }
  });
  const result = await broker.fetch(intent({ cacheValidators: { etag: '"private-to-origin"', lastModified: 'Fri, 17 Jul 2026 20:00:00 GMT' } }));
  assert.deepEqual(calls.map((item) => item.url), [
    'https://jobs.example.test/board/acme?content=true',
    'https://redirect.example.test/final'
  ]);
  assert.equal(calls[0].headers['if-none-match'], '"private-to-origin"');
  assert.equal(calls[1].headers['if-none-match'], undefined);
  assert.equal(calls[1].headers['if-modified-since'], undefined);
  assert.equal(result.redirects.length, 1);

  let transported = false;
  const privateRedirect = new EgressBroker({
    policy: policy(),
    lookup: async (hostname) => [{ address: hostname === 'redirect.example.test' ? '127.0.0.1' : '93.184.216.34', family: 4 }],
    transport: async () => {
      if (transported) throw new Error('must not reach private redirect target');
      transported = true;
      return response(302, { location: 'https://redirect.example.test/final' });
    }
  });
  await assert.rejects(privateRedirect.fetch(intent()), (error) => error.code === 'ADDRESS_DENIED');

  const insecureRedirect = new EgressBroker({
    policy: policy(), lookup: publicLookup,
    transport: async () => response(302, { location: 'http://redirect.example.test/final' })
  });
  await assert.rejects(insecureRedirect.fetch(intent()), (error) => error.code === 'INVALID_URL');
});

test('absolute wall-clock deadline stops transports that ignore socket timeout', async () => {
  const broker = new EgressBroker({
    policy: policy({ limits: { timeoutMs: 100 } }),
    lookup: publicLookup,
    transport: async () => new Promise(() => {})
  });
  const started = Date.now();
  await assert.rejects(broker.fetch(intent()), (error) => error.code === 'TIMEOUT' && /absolute wall-clock/.test(error.message));
  assert.ok(Date.now() - started < 1000);
});

test('content type and compressed/decompressed limits are enforced on streams', async () => {
  const wrongType = new EgressBroker({
    policy: policy(), lookup: publicLookup,
    transport: async () => response(200, { 'content-type': 'text/html' }, Buffer.from('<html>no</html>'))
  });
  await assert.rejects(wrongType.fetch(intent()), (error) => error.code === 'CONTENT_TYPE_DENIED');

  const compressedPolicy = policy({ limits: { maxCompressedBytes: 8 } });
  const compressed = new EgressBroker({
    policy: compressedPolicy, lookup: publicLookup,
    transport: async () => response(200, { 'content-type': 'application/json' }, Buffer.from('{"long":true}'))
  });
  await assert.rejects(compressed.fetch(intent()), (error) => error.code === 'COMPRESSED_LIMIT');

  const bomb = zlib.gzipSync(Buffer.from('x'.repeat(1000)));
  const decompressed = new EgressBroker({
    policy: policy({ limits: { maxDecompressedBytes: 100 } }), lookup: publicLookup,
    transport: async () => response(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }, bomb)
  });
  await assert.rejects(decompressed.fetch(intent()), (error) => error.code === 'DECOMPRESSED_LIMIT');
});

test('429/503 responses surface Retry-After through backoff hooks without automatic retry', async () => {
  const events = [];
  let calls = 0;
  const broker = new EgressBroker({
    policy: policy(), lookup: publicLookup,
    hooks: { onBackoff: async (event) => events.push(event) },
    transport: async () => {
      calls += 1;
      return response(429, { 'content-type': 'application/json', 'retry-after': '120' }, Buffer.from('{}'));
    }
  });
  const result = await broker.fetch(intent());
  assert.equal(result.status, 429);
  assert.equal(calls, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].retryAfterMs, 120_000);
  assert.equal(parseRetryAfter('bogus'), null);
});

test('memory rate hook is an optional fail-fast scheduler seam', async () => {
  let now = 1000;
  const clock = { now: () => now };
  const hooks = createMemoryRateHooks({ minIntervalMs: 5000, clock });
  const meta = { origin: 'https://jobs.example.test' };
  await hooks.beforeRequest(meta);
  await assert.rejects(hooks.beforeRequest(meta), (error) => error.code === 'RATE_LIMITED' && error.details.retryAfterMs === 5000);
  now += 5000;
  await hooks.beforeRequest(meta);

  await hooks.onBackoff({ ...meta, url: meta.origin, status: 429, retryAfterMs: 0 });
  await assert.rejects(
    hooks.beforeRequest(meta),
    (error) => error.code === 'RATE_LIMITED' && error.details.retryAfterMs === 6 * 60 * 60 * 1000
  );
  await hooks.onBackoff({ ...meta, url: meta.origin, status: 503, retryAfterMs: 0 });
  await assert.rejects(
    hooks.beforeRequest(meta),
    (error) => error.code === 'RATE_LIMITED' && error.details.retryAfterMs === 6 * 60 * 60 * 1000
  );
});
