'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

const METADATA = { schemaVersion: 'jobtrack-gog-account-metadata.v1', email: 'scshafe@umich.edu',
  client: 'default', services: ['gmail'], scopes: ['https://www.googleapis.com/auth/gmail.send'],
  auth: 'oauth', credentialValuesIncluded: false };

function readinessHarness({ response = JSON.stringify(METADATA), pinError = false, providerError = false } = {}) {
  const file = path.join(__dirname, '../lib/email-agent-lane.js');
  const nativeRequire = createRequire(file);
  const subprocesses = [];
  const resolutions = [];
  const sandbox = { module: { exports: {} }, __dirname: path.dirname(file), Buffer,
    process: { env: { PATH: '/unreviewed/bin', HOME: '/test/home', GOG_ACCOUNT: 'other@example.test',
      GOG_AUTH_MODE: 'adc', GOG_CONFIG_DIR: '/unreviewed/config', GOG_KEYRING_BACKEND: 'file',
      GOG_KEYRING_SERVICE_NAME: 'wrong', GOG_ACCESS_TOKEN: 'fixture-secret', GOG_GMAIL_NO_SEND: '0' } },
    require(name) {
      if (name === '../scripts/lib/pinned-gog.cjs') return { resolvePinnedGog() {
        resolutions.push(true);
        if (pinError) throw new Error('private pin details');
        return '/test/pinned-gog-v2';
      } };
      if (name === 'node:child_process' || name === 'child_process') {
        return Object.fromEntries(['execFileSync', 'spawnSync', 'spawn', 'exec', 'execSync', 'execFile'].map(method => [method, (...args) => {
          subprocesses.push({ method, args });
          if (providerError) throw new Error('private provider details');
          return response;
        }]));
      }
      return nativeRequire(name);
    } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return { ...sandbox.module.exports, subprocesses, resolutions };
}

test('readiness uses only the pinned, exact university/default non-migrating metadata command', () => {
  const h = readinessHarness();
  assert.equal(h.transmitReadiness('scshafe@umich.edu').ready, true);
  assert.equal(h.subprocesses.length, 1);
  assert.equal(h.resolutions.length, 1);
  const { method, args: [executable, argv, options] } = h.subprocesses[0];
  assert.equal(method, 'execFileSync');
  assert.equal(executable, '/test/pinned-gog-v2');
  assert.deepEqual([...argv], ['--account', 'scshafe@umich.edu', '--client=default', '--json', '--no-input',
    '--gmail-no-send', '--enable-commands-exact=auth.inspect-account', 'auth', 'inspect-account', 'scshafe@umich.edu']);
  assert.equal(options.shell, false);
  assert.equal(options.timeout, 8000);
  assert.equal(options.maxBuffer, 65536);
  assert.deepEqual([...options.stdio], ['ignore', 'pipe', 'ignore']);
  assert.equal(options.env.GOG_GMAIL_NO_SEND, '1');
  assert.equal(options.env.GOG_KEYRING_BACKEND, 'keychain');
  assert.equal(options.env.GOG_KEYRING_SERVICE_NAME, 'gogcli');
  for (const key of ['GOG_ACCOUNT', 'GOG_AUTH_MODE', 'GOG_CONFIG_DIR', 'GOG_ACCESS_TOKEN']) assert.equal(options.env[key], undefined);
  assert.equal(h.transmitReadiness('SCSHAFE@UMICH.EDU').ready, true);
  assert.equal(h.subprocesses.length, 1, 'one exact-account check per process, preserving the existing cache');
});

test('readiness never opens unrelated or absent accounts and has no PATH fallback when the pin is missing', () => {
  const h = readinessHarness();
  assert.equal(h.transmitReadiness('').detail, 'no transmitting account');
  for (const account of ['other@example.test', 'default', 'auto']) {
    assert.equal(h.transmitReadiness(account).ready, false);
    assert.equal(h.transmitReadiness(account).detail, 'GOG_READINESS_ACCOUNT_OUT_OF_SCOPE');
  }
  assert.deepEqual(h.subprocesses, []);
  assert.deepEqual(h.resolutions, []);
  const missing = readinessHarness({ pinError: true });
  assert.equal(missing.transmitReadiness('scshafe@umich.edu').detail, 'GOG_PINNED_BINARY_UNAVAILABLE');
  assert.deepEqual(missing.subprocesses, []);
});

test('readiness preserves the send-capable scope gate rather than accepting read access or scope lookalikes', () => {
  for (const scope of ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.compose', 'https://mail.google.com/']) {
    const h = readinessHarness({ response: JSON.stringify({ ...METADATA, scopes: [scope] }) });
    assert.equal(h.transmitReadiness('scshafe@umich.edu').ready, true);
  }
  for (const scopes of [[], ['https://www.googleapis.com/auth/gmail.readonly'], ['https://www.googleapis.com/auth/gmail.labels'],
    ['https://attacker.example/auth/gmail.send'], ['https://mail.google.com/evil'], ['prefix:https://www.googleapis.com/auth/gmail.modify']]) {
    const result = readinessHarness({ response: JSON.stringify({ ...METADATA, scopes }) }).transmitReadiness('scshafe@umich.edu');
    assert.equal(result.ready, false);
    assert.equal(result.detail, 'GOG_SEND_CAPABLE_SCOPE_MISSING');
  }
});

test('readiness validates exact metadata shape, scope, credential exclusion and bounded arrays without leaking output', () => {
  const { credentialValuesIncluded, ...missing } = METADATA;
  const variants = [missing, { ...METADATA, token: 'fixture-secret' }, { ...METADATA, email: 'other@example.test' },
    { ...METADATA, client: 'other' }, { ...METADATA, schemaVersion: 'other' }, { ...METADATA, auth: 'adc' },
    { ...METADATA, credentialValuesIncluded: true }, { ...METADATA, scopes: 'gmail.send' },
    { ...METADATA, scopes: [false] }, { ...METADATA, scopes: ['https://www.googleapis.com/auth/gmail.send\n'] },
    { ...METADATA, scopes: Array(257).fill('scope') }, { ...METADATA, services: null },
    { ...METADATA, services: ['a'.repeat(2049)] }, null, []];
  for (const response of [...variants.map(value => JSON.stringify(value)), 'private invalid provider response', 'x'.repeat(65537), Buffer.from('private bytes')]) {
    const result = readinessHarness({ response }).transmitReadiness('scshafe@umich.edu');
    assert.equal(result.ready, false);
    assert.equal(result.detail, 'SCOPED_GOG_AUTH_METADATA_INVALID');
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret|private|other@example/u);
  }
  const failure = readinessHarness({ providerError: true }).transmitReadiness('scshafe@umich.edu');
  assert.equal(failure.ready, false);
  assert.equal(failure.detail, 'SCOPED_GOG_AUTH_METADATA_UNAVAILABLE');
});

test('resetting the test seam clears cached scope proof and restores exact scoped metadata verification', () => {
  const h = readinessHarness();
  h.setTransmitReadinessProbe(() => ({ ready: false, detail: 'fixture-only denied' }));
  assert.equal(h.transmitReadiness('scshafe@umich.edu').ready, false);
  assert.equal(h.subprocesses.length, 0);
  h.setTransmitReadinessProbe(null);
  assert.equal(h.transmitReadiness('scshafe@umich.edu').ready, true);
  assert.equal(h.subprocesses.length, 1);
  h.setTransmitReadinessProbe(() => { throw new Error('private fixture exception'); });
  assert.equal(h.transmitReadiness('scshafe@umich.edu').detail, 'GOG_READINESS_PROBE_FAILED');
});
