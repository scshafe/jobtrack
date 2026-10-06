#!/usr/bin/env node
'use strict';

// Read-only Google access witness for the deliberately shared university token.
// Labels and diagnostics remain in memory and are never printed or persisted.
// No token export, cache deletion, artificial expiry, account enumeration, draft
// creation or send is part of this check. A cached-token success is explicitly
// NOT a refresh/persistence witness.
const { spawnSync } = require('node:child_process');
const { resolvePinnedGog } = require('./lib/pinned-gog.cjs');
const { sanitizedGogEnvironment } = require('./lib/gog-environment.cjs');

const ACCOUNT = 'scshafe@umich.edu';
const CLIENT = 'default';
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TIME = 'time=\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})';
const SUCCESS = new RegExp(`^${TIME} level=DEBUG msg="persisted refreshed token metadata" email=scshafe@umich\\.edu client=default$`, 'u');
const FAILURE = new RegExp(`^${TIME} level=WARN msg="persist refreshed token metadata failed" email=scshafe@umich\\.edu client=default err=(?:"(?:[^"\\\\]|\\\\.)*"|[^ \\t]+)$`, 'u');
const PERSISTENCE_EVENT = new RegExp(`^${TIME} level=(?:DEBUG|WARN) msg="(?:persisted refreshed token metadata|persist refreshed token metadata failed)"(?: |$)`, 'u');

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== '--json') throw new Error('GOG_ACCESS_ARGUMENTS_INVALID');
}

function persistenceEvidence(stderr) {
  let refreshed = false;
  let failed = false;
  let invalid = false;
  for (const line of stderr.split('\n')) {
    if (SUCCESS.test(line)) refreshed = true;
    else if (FAILURE.test(line)) failed = true;
    else if (PERSISTENCE_EVENT.test(line)) invalid = true;
  }
  // A warning may mean only some aliases were persisted. Never call that a
  // complete refresh witness even if another success event is present.
  return { refreshPersisted: refreshed && !failed && !invalid, persistenceFailed: failed, invalid };
}

function emptyResult(errorCode = null) {
  return { schemaVersion: 'jobtrack-gog-access-check.v1', readOnly: true,
    pinnedBinaryVerified: false, providerReadSucceeded: false,
    refreshPersisted: false, persistenceFailed: false, errorCode };
}

function checkGogAccess(deps = {}) {
  const result = emptyResult();
  let executable;
  try { executable = (deps.resolveBinary || resolvePinnedGog)(); }
  catch (error) { return { ...result, errorCode: error?.code === 'GOG_KEYCHAIN_ACCESS_PAUSED'
    ? 'GOG_KEYCHAIN_ACCESS_PAUSED' : 'GOG_PINNED_BINARY_UNAVAILABLE' }; }
  result.pinnedBinaryVerified = true;
  let command;
  try {
    command = (deps.runCommand || spawnSync)(executable, [
      '--account', ACCOUNT, `--client=${CLIENT}`, '--json', '--no-input',
      '--gmail-no-send', '--verbose', '--color=never',
      '--enable-commands-exact=gmail.labels.list', 'gmail', 'labels', 'list'
    ], { encoding: 'utf8', timeout: 30000, maxBuffer: MAX_OUTPUT_BYTES, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...sanitizedGogEnvironment(deps.environment || process.env), GOG_GMAIL_NO_SEND: '1' } });
  } catch { return { ...result, errorCode: 'GOG_ACCESS_PROVIDER_FAILED' }; }

  // Never copy subprocess fields, thrown errors or provider text into a result.
  if (typeof command?.stderr !== 'string' || typeof command?.stdout !== 'string'
      || Buffer.byteLength(command.stderr, 'utf8') > MAX_OUTPUT_BYTES
      || Buffer.byteLength(command.stdout, 'utf8') > MAX_OUTPUT_BYTES) {
    return { ...result, errorCode: 'GOG_ACCESS_RESPONSE_INVALID' };
  }
  const persistence = persistenceEvidence(command.stderr);
  result.refreshPersisted = persistence.refreshPersisted;
  result.persistenceFailed = persistence.persistenceFailed;
  if (command.status === 0 && !command.error && !command.signal) {
    try {
      const response = JSON.parse(command.stdout);
      result.providerReadSucceeded = response !== null && typeof response === 'object'
        && !Array.isArray(response) && Array.isArray(response.labels)
        && response.labels.length <= 10000
        && response.labels.every(label => label !== null && typeof label === 'object'
          && !Array.isArray(label) && typeof label.id === 'string' && label.id.length > 0);
    } catch { /* Invalid response is reported without its content. */ }
  }
  result.errorCode = result.persistenceFailed ? 'GOG_ACCESS_PERSISTENCE_FAILED'
    : persistence.invalid ? 'GOG_ACCESS_PERSISTENCE_EVIDENCE_INVALID'
      : command.status !== 0 || command.error || command.signal ? 'GOG_ACCESS_PROVIDER_FAILED'
        : !result.providerReadSucceeded ? 'GOG_ACCESS_RESPONSE_INVALID' : null;
  return result;
}

function runCli(argv, deps = {}) {
  let result;
  try { parseArgs(argv); result = checkGogAccess(deps); }
  catch { result = emptyResult('GOG_ACCESS_ARGUMENTS_INVALID'); }
  return { result, exitCode: result.errorCode === null ? 0 : 2 };
}

if (require.main === module) {
  const { result, exitCode } = runCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}

module.exports = { checkGogAccess, parseArgs, persistenceEvidence, runCli };
