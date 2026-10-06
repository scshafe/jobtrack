#!/usr/bin/env node
'use strict';

// Deliberately imports no HTTP, browser, SQLite, JobTrack CLI, or dynamic module loader.
// Network retrieval and durable writes belong to trusted processes outside this worker.
const { readJsonInput } = require('./bounded-io');
const { executeWorkRequest } = require('./controller');
const { validatePluginManifest } = require('./contracts');

const HARD_MAX_INPUT = 32 * 1024 * 1024;
const HELP = `Usage:
  discovery-strategy-worker [--input FILE] [--max-input-bytes N]

Reads one bounded strategy-work-request JSON value and writes exactly one validated,
content-addressed proposal-bundle JSON value to stdout. Version 2 requests parse exact
retrieval envelopes with the closed Ashby, Greenhouse, Lever, or funding JSON Feed
registry. Imported LinkedIn leads remain data-only version 1 inputs. This worker never
visits LinkedIn or any other network service.
`;

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    if (argv.length !== 1) throw new Error('--help cannot be combined with other flags');
    process.stdout.write(HELP);
    return { mode: 'help' };
  }
  const flags = parseFlags(argv);
  const maxInputBytes = boundedInteger(flags.maxInputBytes, 8 * 1024 * 1024, '--max-input-bytes', 1024, HARD_MAX_INPUT);
  const startedAt = Date.now();
  const request = await readJsonInput({ file: flags.input || null, maxBytes: maxInputBytes });
  const manifest = validatePluginManifest(request && request.manifest, 'request.manifest');
  const requestBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
  if (requestBytes > manifest.limits.maxInputBytes) {
    throw new Error(`request exceeds manifest maxInputBytes (${requestBytes})`);
  }
  const result = executeWorkRequest(request);
  if (Date.now() - startedAt > manifest.limits.maxRuntimeMs) throw new Error('strategy work exceeded manifest maxRuntimeMs');
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output, 'utf8') > manifest.limits.maxOutputBytes) throw new Error('proposal bundle exceeds manifest maxOutputBytes');
  process.stdout.write(`${output}\n`);
  return result;
}

function parseFlags(argv) {
  const aliases = new Map([['input', 'input'], ['max-input-bytes', 'maxInputBytes']]);
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

function boundedInteger(value, fallback, label, min, max) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label} must be ${min}..${max}`);
  return number;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`discovery-strategy-worker: ${String(error && error.message || error).replace(/[\r\n]+/g, ' ').slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseFlags };
