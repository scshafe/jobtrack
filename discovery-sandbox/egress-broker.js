'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const { PassThrough, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const zlib = require('node:zlib');
const { digest, validateFetchIntent, validateRetrievalEnvelope } = require('./contracts');
const {
  NetworkPolicyError,
  matchAllowedUrl,
  normalizeHostname,
  resolvePublicAddresses,
  validateIntentAgainstPolicy,
  validateNetworkPolicy
} = require('./network-policy');

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const EMPTY_SHA256 = digest(Buffer.alloc(0));

class BrokerError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'BrokerError';
    this.code = code;
    this.details = details;
  }
}

class EgressBroker {
  constructor({ policy, lookup, transport, hooks = {}, clock = Date } = {}) {
    validateNetworkPolicy(policy);
    this.policy = policy;
    this.lookup = lookup;
    this.transport = transport || httpsTransport;
    this.hooks = {
      beforeRequest: hooks.beforeRequest || (async () => {}),
      afterResponse: hooks.afterResponse || (async () => {}),
      onBackoff: hooks.onBackoff || (async () => {})
    };
    this.clock = clock;
  }

  async fetch(intent) {
    const controller = new AbortController();
    const timeoutError = new BrokerError('TIMEOUT', 'Egress request exceeded its absolute wall-clock deadline');
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, this.policy.limits.timeoutMs);
    });
    try {
      return await Promise.race([this.fetchWithinDeadline(intent, controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchWithinDeadline(intent, signal) {
    validateFetchIntent(intent);
    validateIntentAgainstPolicy(intent, this.policy);
    const startedAtMs = this.clock.now();
    const deadlineMs = startedAtMs + this.policy.limits.timeoutMs;
    const requestedUrl = intent.url;
    let current = new URL(intent.url);
    const redirects = [];
    let forwardCacheValidators = true;

    while (true) {
      matchAllowedUrl(current, this.policy);
      const dnsRemainingMs = deadlineMs - this.clock.now();
      if (dnsRemainingMs <= 0) throw new BrokerError('TIMEOUT', 'Egress request exceeded its total timeout');
      const addresses = await withTimeout(
        resolvePublicAddresses(current.hostname, this.lookup),
        dnsRemainingMs,
        'DNS resolution exceeded the total timeout'
      );
      const target = preferAddress(addresses);
      const remainingMs = deadlineMs - this.clock.now();
      if (remainingMs <= 0) throw new BrokerError('TIMEOUT', 'Egress request exceeded its total timeout');
      const requestMeta = Object.freeze({
        policyId: this.policy.policyId,
        requestId: intent.requestId,
        sourceKey: intent.sourceKey,
        method: intent.method,
        url: current.href,
        origin: current.origin,
        redirectCount: redirects.length,
        address: target.address,
        family: target.family
      });
      await this.hooks.beforeRequest(requestMeta);
      let response;
      try {
        response = await this.transport({
          url: current,
          method: intent.method,
          headers: requestHeaders(intent, this.policy, forwardCacheValidators),
          address: target.address,
          family: target.family,
          timeoutMs: remainingMs,
          signal
        });
      } catch (error) {
        if (error instanceof BrokerError || error instanceof NetworkPolicyError) throw error;
        throw new BrokerError('NETWORK_FAILED', 'HTTPS request failed', { cause: safeMessage(error) });
      }
      validateTransportResponse(response);
      const headers = normalizeHeaders(response.headers);
      await this.hooks.afterResponse(Object.freeze({
        ...requestMeta,
        status: response.statusCode,
        retryAfter: headerValue(headers, 'retry-after')
      }));

      if (REDIRECTS.has(response.statusCode)) {
        discardResponse(response);
        if (redirects.length >= this.policy.limits.maxRedirects) {
          throw new BrokerError('REDIRECT_LIMIT', 'Response exceeded the redirect limit');
        }
        const location = headerValue(headers, 'location');
        if (!location) throw new BrokerError('INVALID_REDIRECT', 'Redirect response omitted Location');
        let next;
        try { next = new URL(location, current); } catch { throw new BrokerError('INVALID_REDIRECT', 'Redirect Location is invalid'); }
        matchAllowedUrl(next, this.policy);
        if (next.origin !== current.origin) forwardCacheValidators = false;
        redirects.push({ status: response.statusCode, fromUrl: current.href, toUrl: next.href });
        current = next;
        continue;
      }

      const retryAfter = headerValue(headers, 'retry-after');
      if (response.statusCode === 429 || response.statusCode === 503) {
        await this.hooks.onBackoff(Object.freeze({
          policyId: this.policy.policyId,
          requestId: intent.requestId,
          sourceKey: intent.sourceKey,
          url: current.href,
          status: response.statusCode,
          retryAfter,
          retryAfterMs: parseRetryAfter(retryAfter, this.clock.now())
        }));
      }

      const contentType = headerValue(headers, 'content-type');
      const contentEncoding = normalizeContentEncoding(headerValue(headers, 'content-encoding'));
      const hasBody = intent.method !== 'HEAD' && ![204, 205, 304].includes(response.statusCode);
      if (hasBody && !contentTypeAllowed(contentType, intent.acceptedContentTypes)) {
        discardResponse(response);
        throw new BrokerError('CONTENT_TYPE_DENIED', `Response Content-Type is not accepted: ${contentType || '(missing)'}`);
      }
      const declaredLength = parseContentLength(headerValue(headers, 'content-length'));
      if (declaredLength !== null && declaredLength > this.policy.limits.maxCompressedBytes) {
        discardResponse(response);
        throw new BrokerError('COMPRESSED_LIMIT', 'Response Content-Length exceeds the compressed byte limit');
      }
      const bodyResult = hasBody
        ? await collectBody(response.body, contentEncoding, this.policy.limits, Math.max(1, deadlineMs - this.clock.now()), signal)
        : emptyBody(response);
      const envelope = {
        schemaVersion: 1,
        kind: 'retrieval-envelope',
        requestId: intent.requestId,
        sourceKey: intent.sourceKey,
        networkPolicyId: intent.networkPolicyId,
        method: intent.method,
        requestedUrl,
        finalUrl: current.href,
        status: response.statusCode,
        headers: {
          contentType: contentType || null,
          contentEncoding: contentEncoding === 'identity' ? null : contentEncoding,
          etag: headerValue(headers, 'etag') || null,
          lastModified: headerValue(headers, 'last-modified') || null,
          retryAfter: retryAfter || null
        },
        fetchedAt: new Date(this.clock.now()).toISOString(),
        durationMs: Math.max(0, this.clock.now() - startedAtMs),
        redirects,
        compressedBytes: bodyResult.compressedBytes,
        decompressedBytes: bodyResult.body.length,
        compressedSha256: bodyResult.compressedSha256,
        bodySha256: digest(bodyResult.body),
        bodyBase64: bodyResult.body.toString('base64')
      };
      return validateRetrievalEnvelope(envelope);
    }
  }
}

function requestHeaders(intent, policy, includeCacheValidators = true) {
  const headers = {
    accept: intent.acceptedContentTypes.join(', '),
    'accept-encoding': 'gzip, deflate, br',
    'user-agent': policy.userAgent
  };
  if (includeCacheValidators && intent.cacheValidators.etag) headers['if-none-match'] = intent.cacheValidators.etag;
  if (includeCacheValidators && intent.cacheValidators.lastModified) headers['if-modified-since'] = intent.cacheValidators.lastModified;
  return headers;
}

function preferAddress(addresses) {
  return addresses.find((item) => item.family === 4) || addresses[0];
}

function validateTransportResponse(response) {
  if (!response || !Number.isInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599) {
    throw new BrokerError('TRANSPORT_INVALID', 'Transport returned an invalid HTTP status');
  }
  if (!response.body || typeof response.body.on !== 'function') {
    throw new BrokerError('TRANSPORT_INVALID', 'Transport returned no readable body stream');
  }
}

function normalizeHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrokerError('TRANSPORT_INVALID', 'Transport returned invalid headers');
  const result = Object.create(null);
  for (const [name, item] of Object.entries(value)) result[String(name).toLowerCase()] = item;
  return result;
}

function headerValue(headers, name) {
  const value = headers[name];
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new BrokerError('HEADER_INVALID', `Response contained multiple ${name} headers`);
    return String(value[0]);
  }
  return String(value);
}

function normalizeContentEncoding(value) {
  if (!value) return 'identity';
  const normalized = String(value).trim().toLowerCase();
  if (!['identity', 'gzip', 'deflate', 'br'].includes(normalized)) {
    throw new BrokerError('ENCODING_DENIED', `Unsupported Content-Encoding: ${normalized}`);
  }
  return normalized;
}

function contentTypeAllowed(value, accepted) {
  if (!value) return false;
  const mime = String(value).split(';', 1)[0].trim().toLowerCase();
  return accepted.some((rule) => rule.endsWith('/*') ? mime.startsWith(`${rule.slice(0, -1)}`) : mime === rule);
}

function parseContentLength(value) {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw new BrokerError('HEADER_INVALID', 'Content-Length is invalid');
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new BrokerError('HEADER_INVALID', 'Content-Length is too large');
  return result;
}

async function collectBody(body, encoding, limits, timeoutMs, signal = null) {
  const compressedHash = crypto.createHash('sha256');
  let compressedBytes = 0;
  let decompressedBytes = 0;
  const chunks = [];
  const compressedGuard = new Transform({
    transform(chunk, _encoding, callback) {
      compressedBytes += chunk.length;
      if (compressedBytes > limits.maxCompressedBytes) {
        callback(new BrokerError('COMPRESSED_LIMIT', 'Response exceeded the compressed byte limit'));
        return;
      }
      compressedHash.update(chunk);
      callback(null, chunk);
    }
  });
  const decoder = decoderFor(encoding);
  const collector = new Transform({
    transform(chunk, _encoding, callback) {
      decompressedBytes += chunk.length;
      if (decompressedBytes > limits.maxDecompressedBytes) {
        callback(new BrokerError('DECOMPRESSED_LIMIT', 'Response exceeded the decompressed byte limit'));
        return;
      }
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  let timer;
  const onAbort = () => body.destroy(signal.reason instanceof Error ? signal.reason : new BrokerError('TIMEOUT', 'Request aborted'));
  try {
    if (signal && signal.aborted) throw signal.reason;
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => body.destroy(new BrokerError('TIMEOUT', 'Response body exceeded the total timeout')), timeoutMs);
    await pipeline(body, compressedGuard, decoder, collector);
  } catch (error) {
    if (error instanceof BrokerError) throw error;
    throw new BrokerError('BODY_FAILED', 'Failed to read or decode response body', { cause: safeMessage(error) });
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  return { compressedBytes, compressedSha256: compressedHash.digest('hex'), body: Buffer.concat(chunks, decompressedBytes) };
}

function decoderFor(encoding) {
  if (encoding === 'identity') return new PassThrough();
  if (encoding === 'gzip') return zlib.createGunzip();
  if (encoding === 'deflate') return zlib.createInflate();
  if (encoding === 'br') return zlib.createBrotliDecompress();
  throw new BrokerError('ENCODING_DENIED', `Unsupported Content-Encoding: ${encoding}`);
}

function emptyBody(response) {
  discardResponse(response);
  return { compressedBytes: 0, compressedSha256: EMPTY_SHA256, body: Buffer.alloc(0) };
}

function discardResponse(response) {
  if (response && response.body && typeof response.body.destroy === 'function') response.body.destroy();
  if (response && typeof response.abort === 'function') response.abort();
}

function parseRetryAfter(value, nowMs = Date.now()) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, 7 * 24 * 60 * 60 * 1000);
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, Math.min(timestamp - nowMs, 7 * 24 * 60 * 60 * 1000));
}

function createMemoryRateHooks({ minIntervalMs, clock = Date } = {}) {
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0) throw new TypeError('minIntervalMs must be a nonnegative integer');
  const nextByOrigin = new Map();
  return {
    async beforeRequest(meta) {
      const nextAt = nextByOrigin.get(meta.origin) || 0;
      const current = clock.now();
      if (current < nextAt) throw new BrokerError('RATE_LIMITED', 'Origin is inside its minimum interval', { retryAfterMs: nextAt - current });
      nextByOrigin.set(meta.origin, Math.max(nextAt, current + minIntervalMs));
    },
    async onBackoff(meta) {
      const origin = new URL(meta.url).origin;
      const current = clock.now();
      const existing = nextByOrigin.get(origin) || 0;
      const backoffFloor = meta.status === 429 ? 6 * 60 * 60 * 1000 : 5 * 60 * 1000;
      const requestedBackoff = meta.retryAfterMs === null ? backoffFloor : meta.retryAfterMs;
      nextByOrigin.set(origin, Math.max(
        existing,
        current + minIntervalMs,
        current + backoffFloor,
        current + requestedBackoff
      ));
    }
  };
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new BrokerError('TIMEOUT', message)), Math.max(1, timeoutMs));
    })
  ]).finally(() => clearTimeout(timer));
}

function httpsTransport({
  url, method, headers, address, family, timeoutMs, signal = null,
  connectPort = 443, ca = undefined
}) {
  return new Promise((resolve, reject) => {
    const hostname = normalizeHostname(url.hostname);
    let settled = false;
    const request = https.request({
      protocol: 'https:',
      hostname,
      port: connectPort,
      method,
      path: `${url.pathname}${url.search}`,
      headers,
      agent: false,
      rejectUnauthorized: true,
      ca,
      servername: hostname,
      family,
      autoSelectFamily: false,
      lookup(_hostname, _options, callback) { callback(null, address, family); }
    }, (response) => {
      settled = true;
      if (signal) response.once('close', () => signal.removeEventListener('abort', onAbort));
      resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: response,
        abort() {
          if (signal) signal.removeEventListener('abort', onAbort);
          request.destroy();
        }
      });
    });
    const onAbort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new BrokerError('TIMEOUT', 'HTTPS request aborted'));
    request.on('error', (error) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (settled) return;
      if (error instanceof BrokerError || error instanceof NetworkPolicyError) reject(error);
      else reject(new BrokerError('NETWORK_FAILED', 'HTTPS request failed', { cause: safeMessage(error) }));
    });
    if (signal && signal.aborted) {
      onAbort();
      return;
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    request.setTimeout(timeoutMs, () => request.destroy(new BrokerError('TIMEOUT', 'HTTPS request timed out')));
    request.end();
  });
}

function safeMessage(error) {
  return String(error && error.message || 'unknown error').replace(/[\r\n]+/g, ' ').slice(0, 300);
}

module.exports = {
  BrokerError,
  EgressBroker,
  collectBody,
  contentTypeAllowed,
  createMemoryRateHooks,
  httpsTransport,
  parseRetryAfter
};
