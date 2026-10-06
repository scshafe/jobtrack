#!/usr/bin/env node
'use strict';

const http = require('node:http');
const { EgressBroker } = require('./egress-broker');
const { readJsonInput, readStream } = require('./bounded-io');
const { validateFetchIntent } = require('./contracts');
const { validateNetworkPolicy } = require('./network-policy');

const DEFAULT_MAX_INPUT = 2 * 1024 * 1024;
const HELP = `Usage:
  discovery-egress once --policy FILE [--intent FILE] [--max-input-bytes N]
  discovery-egress serve --policy FILE [--host HOST] [--port N] [--max-input-bytes N]

The broker permits only strict fetch-intent JSON. Serve mode exposes POST /v1/fetch
and GET /healthz on the container-internal network. It never accepts caller-supplied
network policy or arbitrary HTTP headers.
`;

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const command = argv[0];
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const flags = parseFlags(argv.slice(1));
  const maxInputBytes = positiveInteger(flags.maxInputBytes, DEFAULT_MAX_INPUT, '--max-input-bytes', 128 * 1024 * 1024);
  const policyFile = required(flags.policy, '--policy');
  const policy = validateNetworkPolicy(await readJsonInput({ file: policyFile, maxBytes: maxInputBytes }));
  const broker = dependencies.broker || new EgressBroker({ policy });
  if (command === 'once') {
    const intent = validateFetchIntent(await readJsonInput({ file: flags.intent || null, maxBytes: maxInputBytes }));
    const result = await broker.fetch(intent);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  if (command === 'serve') {
    if (flags.intent) throw new Error('--intent is only valid in once mode');
    const host = flags.host || '127.0.0.1';
    const port = positiveInteger(flags.port, 8787, '--port', 65535);
    return serve({ broker, policy, host, port, maxInputBytes, createServer: dependencies.createServer });
  }
  throw new Error(`Unknown command: ${command}`);
}

function serve({ broker, policy, host, port, maxInputBytes, createServer = http.createServer }) {
  let active = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method === 'GET' && request.url === '/healthz') {
      writeJson(response, 200, { ok: true, policyId: policy.policyId });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/fetch') {
      writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
      return;
    }
    const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      writeJson(response, 415, { error: { code: 'CONTENT_TYPE_REQUIRED', message: 'Use application/json' } });
      return;
    }
    const declared = request.headers['content-length'];
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxInputBytes)) {
      writeJson(response, 413, { error: { code: 'INPUT_TOO_LARGE', message: 'Request body is too large' } });
      request.destroy();
      return;
    }
    if (active >= 4) {
      writeJson(response, 503, { error: { code: 'BROKER_BUSY', message: 'Broker concurrency limit reached' } });
      return;
    }
    active += 1;
    try {
      const raw = await readStream(request, maxInputBytes);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw Object.assign(new Error('Request body must be valid JSON'), { code: 'INPUT_INVALID' }); }
      const result = await broker.fetch(validateFetchIntent(parsed));
      writeJson(response, 200, result);
    } catch (error) {
      const status = error.code === 'INPUT_TOO_LARGE' ? 413 : 400;
      writeJson(response, status, publicError(error));
    } finally {
      active -= 1;
    }
  });
  server.requestTimeout = Math.max(1000, policy.limits.timeoutMs + 5000);
  server.headersTimeout = 5000;
  server.listen(port, host, () => {
    process.stderr.write(`discovery-egress: listening on ${host}:${port} with policy ${policy.policyId}\n`);
  });
  return server;
}

function writeJson(response, status, value) {
  if (response.headersSent) return;
  const body = `${JSON.stringify(value)}\n`;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function publicError(error) {
  return {
    error: {
      code: String(error && error.code || 'BROKER_FAILED').slice(0, 100),
      message: String(error && error.message || 'Broker failed').replace(/[\r\n]+/g, ' ').slice(0, 500),
      ...(error && error.details ? { details: error.details } : {})
    }
  };
}

function parseFlags(argv) {
  const aliases = new Map([
    ['policy', 'policy'], ['intent', 'intent'], ['host', 'host'], ['port', 'port'],
    ['max-input-bytes', 'maxInputBytes']
  ]);
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected positional argument: ${token}`);
    const equal = token.indexOf('=');
    const raw = token.slice(2, equal === -1 ? undefined : equal);
    const key = aliases.get(raw);
    if (!key) throw new Error(`Unknown flag: --${raw}`);
    if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error(`Duplicate flag: --${raw}`);
    if (equal !== -1) result[key] = token.slice(equal + 1);
    else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`--${raw} requires a value`);
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function positiveInteger(value, fallback, label, max) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new Error(`${label} is outside the allowed range`);
  return number;
}

function required(value, label) {
  if (!value) throw new Error(`Missing required ${label}`);
  return value;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`discovery-egress: ${String(error && error.message || error).replace(/[\r\n]+/g, ' ').slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseFlags, publicError, serve };
