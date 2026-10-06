'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { checkGogAccess, parseArgs, persistenceEvidence, runCli } = require('../scripts/check-gog-access.cjs');

const PREFIX = 'time=2026-09-08T21:29:07.123-07:00';
const SUCCESS = `${PREFIX} level=DEBUG msg="persisted refreshed token metadata" email=scshafe@umich.edu client=default`;
const WARNING = `${PREFIX} level=WARN msg="persist refreshed token metadata failed" email=scshafe@umich.edu client=default err="private credential failure detail"`;
const RESPONSE = { status: 0, stdout: JSON.stringify({ labels: [{ id: 'INBOX', name: 'private label name', type: 'system' }] }), stderr: '' };

function fixture(response = RESPONSE) {
  const calls = [];
  return { calls, resolveBinary() { return '/test/approved-gog'; },
    environment: { PATH: '/untrusted/bin', HOME: '/test/home', GOG_ACCESS_TOKEN: 'fixture-secret-token',
      GOG_AUTH_MODE: 'adc', GOG_ACCOUNT: 'other@example.test', GOG_CLIENT: 'other',
      GOG_HOME: '/wrong', GOG_CONFIG_DIR: '/wrong/config', GOG_KEYRING_BACKEND: 'file',
      GOG_KEYRING_SERVICE_NAME: 'wrong', GOG_GMAIL_NO_SEND: '0', GOOGLE_APPLICATION_CREDENTIALS: '/wrong/adc' },
    runCommand(...args) { calls.push(args); return response; } };
}

test('access check accepts only explicit JSON and no account, binary, credential or backend overrides', () => {
  assert.doesNotThrow(() => parseArgs(['--json']));
  for (const args of [[], ['--json', '--json'], ['--account', 'other@example.test', '--json'],
    ['--binary', '/other/gog', '--json'], ['--refresh', '--json'], ['--access-token', 'fixture-secret', '--json']]) {
    const f = fixture();
    const result = runCli(args, f);
    assert.equal(result.exitCode, 2);
    assert.equal(result.result.errorCode, 'GOG_ACCESS_ARGUMENTS_INVALID');
    assert.equal(f.calls.length, 0);
  }
});

test('one pinned university/default read is fenced to labels.list, no-send and sanitized environment', () => {
  const f = fixture();
  const { result, exitCode } = runCli(['--json'], f);
  assert.equal(exitCode, 0);
  assert.deepEqual(result, { schemaVersion: 'jobtrack-gog-access-check.v1', readOnly: true,
    pinnedBinaryVerified: true, providerReadSucceeded: true, refreshPersisted: false,
    persistenceFailed: false, errorCode: null });
  assert.equal(f.calls.length, 1);
  const [executable, args, options] = f.calls[0];
  assert.equal(executable, '/test/approved-gog');
  assert.deepEqual(args, ['--account', 'scshafe@umich.edu', '--client=default', '--json', '--no-input',
    '--gmail-no-send', '--verbose', '--color=never', '--enable-commands-exact=gmail.labels.list', 'gmail', 'labels', 'list']);
  assert.equal(options.env.GOG_GMAIL_NO_SEND, '1');
  assert.equal(options.env.GOG_KEYRING_BACKEND, 'keychain');
  assert.equal(options.env.GOG_KEYRING_SERVICE_NAME, 'gogcli');
  for (const name of ['GOG_ACCESS_TOKEN', 'GOG_AUTH_MODE', 'GOG_ACCOUNT', 'GOG_CLIENT', 'GOG_HOME', 'GOG_CONFIG_DIR', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    assert.equal(options.env[name], undefined);
  }
  assert.equal(options.shell, false);
  assert.equal(options.timeout, 30000);
  assert.equal(options.maxBuffer, 1024 * 1024);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.doesNotMatch(JSON.stringify(result), /private label|fixture-secret/u);
});

test('refresh is witnessed only by exact post-SetToken DEBUG event in stderr for the fixed identity', () => {
  const f = fixture({ ...RESPONSE, stderr: `${SUCCESS}\n` });
  assert.equal(checkGogAccess(f).refreshPersisted, true);
  for (const stderr of [SUCCESS.replace('level=DEBUG', 'level=INFO'), SUCCESS.replace('scshafe@umich.edu', 'other@example.test'),
    SUCCESS.replace('client=default', 'client=other'), `provider body mentions ${SUCCESS}`, `${SUCCESS} extra=unreviewed`,
    'persisted refreshed token metadata', SUCCESS.replace('persisted refreshed', 'persist refreshed')]) {
    assert.equal(checkGogAccess(fixture({ ...RESPONSE, stderr })).refreshPersisted, false);
  }
  assert.equal(checkGogAccess(fixture({ ...RESPONSE, stdout: JSON.stringify({ labels: [{ id: 'x', name: SUCCESS }] }) })).refreshPersisted, false);
});

test('persistence warning fails even after successful Google read and suppresses complete-refresh claims', () => {
  for (const stderr of [WARNING, `${SUCCESS}\n${WARNING}\n`, `${WARNING}\n${SUCCESS}\n`]) {
    const { result, exitCode } = runCli(['--json'], fixture({ ...RESPONSE, stderr }));
    assert.equal(exitCode, 2);
    assert.equal(result.providerReadSucceeded, true);
    assert.equal(result.persistenceFailed, true);
    assert.equal(result.refreshPersisted, false);
    assert.equal(result.errorCode, 'GOG_ACCESS_PERSISTENCE_FAILED');
    assert.doesNotMatch(JSON.stringify(result), /credential failure|private label/u);
  }
  assert.deepEqual(persistenceEvidence(SUCCESS.replace('client=default', 'client=other')),
    { refreshPersisted: false, persistenceFailed: false, invalid: true });
});

test('pin, process, malformed or oversized response failures exit nonzero without leaking raw material', () => {
  const f = fixture();
  f.resolveBinary = () => { throw new Error('private pin diagnostic'); };
  assert.equal(runCli(['--json'], f).result.errorCode, 'GOG_PINNED_BINARY_UNAVAILABLE');
  assert.equal(f.calls.length, 0);
  for (const response of [{ ...RESPONSE, status: 1, stderr: 'private credential detail' },
    { ...RESPONSE, error: new Error('private subprocess detail') }, { ...RESPONSE, signal: 'SIGTERM' },
    { ...RESPONSE, stdout: 'private malformed response' }, { ...RESPONSE, stdout: '{"labels":[{}]}' },
    { ...RESPONSE, stdout: 'x'.repeat(1024 * 1024 + 1) }, { ...RESPONSE, stderr: 'x'.repeat(1024 * 1024 + 1) },
    { ...RESPONSE, stderr: SUCCESS.replace('client=default', 'client=other') }, null]) {
    const { result, exitCode } = runCli(['--json'], fixture(response));
    assert.equal(exitCode, 2);
    assert.doesNotMatch(JSON.stringify(result), /private|subprocess|credential|malformed response/u);
  }
  const throwing = fixture();
  throwing.runCommand = () => { throw new Error('private provider exception'); };
  assert.equal(runCli(['--json'], throwing).result.errorCode, 'GOG_ACCESS_PROVIDER_FAILED');
});
