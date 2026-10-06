'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { ContractError } = require('./contracts');

const POLICY_VERSION = 1;
const ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const MIME = /^[a-z0-9!#$&^_.+*-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/;
const UNSAFE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.onion'];
const MAX_BODY_BYTES = 16 * 1024 * 1024;

class NetworkPolicyError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'NetworkPolicyError';
    this.code = code;
    this.details = details;
  }
}

function validateNetworkPolicy(value, path = 'policy') {
  strictObject(value, [
    'schemaVersion', 'policyId', 'userAgent', 'allowedOrigins', 'allowedContentTypes', 'limits'
  ], path);
  literal(value.schemaVersion, POLICY_VERSION, `${path}.schemaVersion`);
  identifier(value.policyId, `${path}.policyId`);
  text(value.userAgent, `${path}.userAgent`, 10, 500);
  if (/[\u0000-\u001f\u007f]/.test(value.userAgent)) fail(`${path}.userAgent`, 'must not contain HTTP control characters');
  list(value.allowedOrigins, `${path}.allowedOrigins`, 1, 100);
  const origins = new Set();
  value.allowedOrigins.forEach((origin, index) => {
    validateOrigin(origin, `${path}.allowedOrigins[${index}]`);
    const key = `${normalizeHostname(origin.hostname)}:443`;
    if (origins.has(key)) fail(`${path}.allowedOrigins[${index}]`, 'duplicate origin');
    origins.add(key);
  });
  uniqueStrings(value.allowedContentTypes, `${path}.allowedContentTypes`, 1, 50, MIME);
  strictObject(value.limits, [
    'maxRedirects', 'timeoutMs', 'maxCompressedBytes', 'maxDecompressedBytes'
  ], `${path}.limits`);
  integer(value.limits.maxRedirects, `${path}.limits.maxRedirects`, 0, 10);
  integer(value.limits.timeoutMs, `${path}.limits.timeoutMs`, 100, 120_000);
  integer(value.limits.maxCompressedBytes, `${path}.limits.maxCompressedBytes`, 1, MAX_BODY_BYTES);
  integer(value.limits.maxDecompressedBytes, `${path}.limits.maxDecompressedBytes`, 1, MAX_BODY_BYTES);
  return value;
}

function validateOrigin(value, path) {
  strictObject(value, ['hostname', 'port', 'paths', 'allowedQueryKeys', 'requiredQuery'], path);
  text(value.hostname, `${path}.hostname`, 1, 253);
  const normalized = normalizeHostname(value.hostname);
  if (normalized !== value.hostname) fail(`${path}.hostname`, `must be normalized as ${normalized}`);
  if (!isValidHostname(normalized)) fail(`${path}.hostname`, 'must be an exact DNS name or IP literal');
  literal(value.port, 443, `${path}.port`);
  list(value.paths, `${path}.paths`, 1, 100);
  value.paths.forEach((rule, index) => validatePathRule(rule, `${path}.paths[${index}]`));
  uniqueStrings(value.allowedQueryKeys, `${path}.allowedQueryKeys`, 0, 100, /^[A-Za-z0-9._~-]{1,200}$/);
  if (!plainObject(value.requiredQuery)) fail(`${path}.requiredQuery`, 'must be an object');
  const allowed = new Set(value.allowedQueryKeys);
  for (const [key, item] of Object.entries(value.requiredQuery)) {
    if (!allowed.has(key)) fail(`${path}.requiredQuery.${key}`, 'key must also appear in allowedQueryKeys');
    text(item, `${path}.requiredQuery.${key}`, 0, 2000);
  }
}

function validatePathRule(value, path) {
  strictObject(value, ['match', 'value'], path);
  if (!['exact', 'prefix'].includes(value.match)) fail(`${path}.match`, 'must be exact or prefix');
  text(value.value, `${path}.value`, 1, 4096);
  if (!value.value.startsWith('/')) fail(`${path}.value`, 'must begin with /');
  if (/[?#]/.test(value.value)) fail(`${path}.value`, 'must contain only a URL pathname');
  if (/%(?:2f|5c|2e|00)/i.test(value.value)) fail(`${path}.value`, 'must not contain encoded separators, dots, or NUL');
  if (value.match === 'prefix' && !value.value.endsWith('/')) fail(`${path}.value`, 'prefix rules must end with /');
}

function validateIntentAgainstPolicy(intent, policy) {
  validateNetworkPolicy(policy);
  if (intent.networkPolicyId !== policy.policyId) {
    throw new NetworkPolicyError('POLICY_MISMATCH', `Intent policy ${intent.networkPolicyId} does not match ${policy.policyId}`);
  }
  const url = parseHttpsUrl(intent.url);
  const origin = matchAllowedUrl(url, policy);
  for (const mime of intent.acceptedContentTypes) {
    if (!policy.allowedContentTypes.includes(mime)) {
      throw new NetworkPolicyError('CONTENT_TYPE_DENIED', `Intent content type is not allowed by policy: ${mime}`);
    }
  }
  return { url, origin };
}

function matchAllowedUrl(input, policy) {
  // URL objects are not trusted merely because they were parsed. Redirects may
  // change scheme, credentials, port, or fragment, so apply the full URL gate
  // on every hop.
  const url = parseHttpsUrl(input);
  const hostname = normalizeHostname(url.hostname);
  assertSafeHostname(hostname);
  if (/%(?:2f|5c|2e|00)/i.test(url.pathname)) {
    throw new NetworkPolicyError('PATH_DENIED', 'URL path contains encoded separators, dots, or NUL');
  }
  const origin = policy.allowedOrigins.find((item) => normalizeHostname(item.hostname) === hostname && item.port === 443);
  if (!origin) throw new NetworkPolicyError('ORIGIN_DENIED', `Origin is not allowlisted: ${hostname}:443`);
  const pathAllowed = origin.paths.some((rule) => rule.match === 'exact'
    ? url.pathname === rule.value
    : url.pathname.startsWith(rule.value));
  if (!pathAllowed) throw new NetworkPolicyError('PATH_DENIED', `Path is not allowlisted for ${hostname}: ${url.pathname}`);
  const allowedKeys = new Set(origin.allowedQueryKeys);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key)) throw new NetworkPolicyError('QUERY_DENIED', `Query key is not allowlisted: ${key}`);
  }
  for (const [key, expected] of Object.entries(origin.requiredQuery)) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || values[0] !== expected) {
      throw new NetworkPolicyError('QUERY_DENIED', `Required query does not match: ${key}`);
    }
  }
  return origin;
}

function parseHttpsUrl(value) {
  let url;
  try { url = new URL(value instanceof URL ? value.href : value); } catch { throw new NetworkPolicyError('INVALID_URL', 'Fetch URL is invalid'); }
  if (url.protocol !== 'https:') throw new NetworkPolicyError('INVALID_URL', 'Only HTTPS URLs are allowed');
  if (url.username || url.password) throw new NetworkPolicyError('INVALID_URL', 'URL credentials are forbidden');
  if (url.hash) throw new NetworkPolicyError('INVALID_URL', 'URL fragments are forbidden');
  if (url.port && url.port !== '443') throw new NetworkPolicyError('INVALID_URL', 'Only HTTPS port 443 is allowed');
  return url;
}

async function resolvePublicAddresses(hostname, lookup = defaultLookup) {
  const normalized = normalizeHostname(hostname);
  assertSafeHostname(normalized);
  let answers;
  try {
    answers = await lookup(normalized);
  } catch (error) {
    throw new NetworkPolicyError('DNS_FAILED', `DNS resolution failed for ${normalized}`, { cause: safeMessage(error) });
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new NetworkPolicyError('DNS_FAILED', `DNS returned no addresses for ${normalized}`);
  }
  const unique = new Map();
  for (const answer of answers) {
    const address = typeof answer === 'string' ? answer : answer && answer.address;
    const family = typeof answer === 'string' ? net.isIP(answer) : Number(answer && answer.family) || net.isIP(address);
    if (!address || ![4, 6].includes(family) || net.isIP(address) !== family) {
      throw new NetworkPolicyError('DNS_FAILED', `DNS returned an invalid address for ${normalized}`);
    }
    if (isForbiddenIp(address)) {
      throw new NetworkPolicyError('ADDRESS_DENIED', `DNS resolved ${normalized} to a non-public address`, { address });
    }
    unique.set(`${family}:${address}`, { address, family });
  }
  return [...unique.values()];
}

async function defaultLookup(hostname) {
  if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) }];
  return dns.lookup(hostname, { all: true, verbatim: true });
}

function assertSafeHostname(hostname) {
  const lower = normalizeHostname(hostname);
  if (lower === 'localhost' || UNSAFE_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    throw new NetworkPolicyError('HOST_DENIED', `Local/private hostname is forbidden: ${lower}`);
  }
}

function isForbiddenIp(address) {
  const family = net.isIP(address);
  if (family === 4) return isForbiddenIpv4(address);
  if (family === 6) return isForbiddenIpv6(address);
  return true;
}

function isForbiddenIpv4(address) {
  const value = ipv4ToNumber(address);
  if (value === null) return true;
  return [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
  ].some(([base, prefix]) => inIpv4Range(value, ipv4ToNumber(base), prefix));
}

function ipv4ToNumber(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value >>> 0;
}

function inIpv4Range(value, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function isForbiddenIpv6(address) {
  const value = ipv6ToBigInt(address);
  if (value === null) return true;
  // Only globally routable 2000::/3 addresses are accepted. Explicit tunnel,
  // documentation, benchmarking, and translation ranges inside that space are denied.
  if (!inIpv6Range(value, ipv6ToBigInt('2000::'), 3)) return true;
  return [
    ['2001::', 32],
    ['2001:2::', 48],
    ['2001:10::', 28],
    ['2001:20::', 28],
    ['2001:db8::', 32],
    ['2002::', 16]
  ].some(([base, prefix]) => inIpv6Range(value, ipv6ToBigInt(base), prefix));
}

function ipv6ToBigInt(address) {
  let input = String(address).toLowerCase();
  if (input.includes('%')) return null;
  if (input.startsWith('[') && input.endsWith(']')) input = input.slice(1, -1);
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    const ipv4 = ipv4ToNumber(input.slice(lastColon + 1));
    if (ipv4 === null) return null;
    input = `${input.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(parseInt(group, 16)), 0n);
}

function inIpv6Range(value, base, prefix) {
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (base >> shift);
}

function normalizeHostname(value) {
  let hostname = String(value || '').trim().toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  return hostname;
}

function isValidHostname(value) {
  if (net.isIP(value)) return true;
  if (value.length > 253 || !value.includes('.')) return false;
  return value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function safeMessage(error) {
  return String(error && error.message || 'unknown error').replace(/[\r\n]+/g, ' ').slice(0, 300);
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
  text(value, path, 1, 128);
  if (!ID.test(value)) fail(path, 'has an invalid identifier format');
}

function text(value, path, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(path, `must be a string of length ${min}..${max}`);
}

function integer(value, path, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(path, `must be an integer from ${min} to ${max}`);
}

function list(value, path, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path, `must be an array with ${min}..${max} items`);
}

function uniqueStrings(value, path, min, max, pattern) {
  list(value, path, min, max);
  const seen = new Set();
  value.forEach((item, index) => {
    text(item, `${path}[${index}]`, 1, 200);
    if (!pattern.test(item)) fail(`${path}[${index}]`, 'has an invalid format');
    if (seen.has(item)) fail(`${path}[${index}]`, 'must be unique');
    seen.add(item);
  });
}

function fail(path, message) {
  throw new ContractError(path, message);
}

module.exports = {
  NetworkPolicyError,
  assertSafeHostname,
  isForbiddenIp,
  matchAllowedUrl,
  normalizeHostname,
  parseHttpsUrl,
  resolvePublicAddresses,
  validateIntentAgainstPolicy,
  validateNetworkPolicy
};
