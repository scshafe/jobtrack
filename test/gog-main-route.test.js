'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { routeArgs, run } = require('../scripts/gog-main.cjs');
const ACCOUNT = 'scshafe@umich.edu';

test('main requires one explicit approved account before or after the service', () => {
  for (const selector of [['--account', ACCOUNT], [`--account=${ACCOUNT}`], ['-a', ACCOUNT]]) {
    for (const args of [[...selector, 'gmail', 'labels', 'list', '--json'],
      ['gmail', 'labels', 'list', ...selector, '--json']]) {
      assert.deepEqual(routeArgs(args), ['gmail', 'labels', 'list', '--json']);
      let delegated = 0;
      assert.equal(run(args, { delegate(routed) {
        delegated++;
        assert.deepEqual(routed, ['gmail', 'labels', 'list', '--json']);
        return 0;
      } }), 0);
      assert.equal(delegated, 1);
    }
  }
});

test('missing and unapproved accounts fail before any delegation and never infer environment account', () => {
  const cases = [
    { args: ['gmail', 'labels', 'list'], code: 'GOG_MAIN_EXPLICIT_ACCOUNT_REQUIRED' },
    ...['other@example.org', 'personal@example.net', 'default', 'alias', ACCOUNT.toUpperCase()]
      .map(account => ({ args: ['gmail', 'labels', 'list', '--account', account], code: 'GOG_MAIN_ACCOUNT_NOT_APPROVED' }))
  ];
  for (const { args, code } of cases) {
    assert.throws(() => run(args, { env: { GOG_ACCOUNT: ACCOUNT },
      delegate: () => assert.fail('must not delegate'), resolve: () => assert.fail('must not resolve'),
      spawn: () => assert.fail('must not spawn') }), error => error.code === code && error.message === code);
  }
});

test('duplicate, malformed, aliased, joined and separator selectors fail closed before delegation', () => {
  const cases = [
    ['--account', ACCOUNT, 'gmail', 'labels', 'list', '--account', ACCOUNT],
    ['gmail', '--account', ACCOUNT, 'labels', '-a', 'other@example.org', 'list'],
    ['--account', ACCOUNT, `--account=${ACCOUNT}`, 'calendar', 'colors'],
    ['gmail', 'labels', 'list', '--account'],
    ['gmail', 'labels', 'list', '--account='],
    ['gmail', 'labels', 'list', '--account', '--home'],
    ['gmail', 'labels', 'list', '--acct', ACCOUNT],
    ['gmail', 'labels', 'list', `-a=${ACCOUNT}`],
    ['gmail', 'labels', 'list', `-a${ACCOUNT}`],
    ['gmail', 'labels', 'list', '--account', ACCOUNT, '--', '--json'],
    ['gmail', 'labels', 'list', '--account', `${ACCOUNT}\0`],
    ['gmail', 'labels', 'list', '--account', null],
    null
  ];
  for (const args of cases) assert.throws(() => run(args, {
    delegate: () => assert.fail('must not delegate')
  }), /GOG_SHARED_ROUTE_SCOPE_REFUSED/);
});

test('main delegates service and sensitive-selector validation to the university policy before execution', () => {
  for (const remainder of [
    ['auth', 'list'], ['config', 'set'], ['auth', 'tokens', 'export'],
    ['--json', 'gmail', 'labels', 'list'],
    ...['--home=/fixture', '--access-token=fixture-only', '--client=other', '--no-input=false',
      '--non-interactive=false', '--verbose', '-v', '--gmail-no-send=false', '-jaother@example.org']
      .map(flag => ['gmail', 'labels', 'list', flag])
  ]) assert.throws(() => run(['--account', ACCOUNT, ...remainder], {
    delegate: () => assert.fail('must not delegate')
  }), /GOG_SHARED_ROUTE_SCOPE_REFUSED/);
});

test('main university route preserves exact execution, sanitization, pins and pause without fallback', () => {
  let resolutions = 0;
  let spawns = 0;
  const args = ['--account', ACCOUNT, 'calendar', 'colors', '--client=default'];
  const deps = {
    env: { PATH: '/opt/homebrew/bin', GOG_ACCOUNT: 'other@example.org', GOG_HOME: '/fixture',
      GOG_ACCESS_TOKEN: 'fixture-only', GOG_GMAIL_NO_SEND: '1' },
    resolve() { resolutions++; return '/approved/pinned/gog'; },
    spawn(binary, forwarded, options) {
      spawns++;
      assert.equal(binary, '/approved/pinned/gog');
      assert.deepEqual(forwarded, ['--account', ACCOUNT, '--client=default', '--no-input', 'calendar', 'colors']);
      assert.equal(options.env.GOG_ACCOUNT, undefined);
      assert.equal(options.env.GOG_HOME, undefined);
      assert.equal(options.env.GOG_ACCESS_TOKEN, undefined);
      assert.equal(options.env.GOG_GMAIL_NO_SEND, '1');
      assert.equal(options.env.GOG_KEYRING_BACKEND, 'keychain');
      assert.equal(options.env.GOG_KEYRING_SERVICE_NAME, 'gogcli');
      return { status: 0 };
    }
  };
  assert.equal(run(args, deps), 0);
  assert.equal(run(args, deps), 0);
  assert.equal(resolutions, 2);
  assert.equal(spawns, 2);
  for (const code of ['GOG_PINNED_BINARY_UNAVAILABLE', 'GOG_KEYCHAIN_ACCESS_PAUSED']) {
    assert.throws(() => run(args, { resolve() { const error = new Error(code); error.code = code; throw error; },
      spawn: () => assert.fail('no fallback') }), error => error.code === code);
  }
});

test('main CLI emits closed missing/unknown errors without account output or credential calls', () => {
  const script = path.join(__dirname, '../scripts/gog-main.cjs');
  for (const [args, code] of [
    [['gmail', 'labels', 'list'], 'GOG_MAIN_EXPLICIT_ACCOUNT_REQUIRED'],
    [['gmail', 'labels', 'list', '--account', 'fixture-personal@example.net'], 'GOG_MAIN_ACCOUNT_NOT_APPROVED']
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8', env: { PATH: '/fixture/nonexistent', GOG_ACCOUNT: ACCOUNT }
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${code}\n`);
  }
});

test('main launcher is executable and selects only the fixed Node alias and main router', () => {
  const launcher = path.join(__dirname, '../tools/gog/main-bin/gog');
  const source = fs.readFileSync(launcher, 'utf8');
  assert.equal(fs.lstatSync(launcher).isSymbolicLink(), false);
  assert.notEqual(fs.statSync(launcher).mode & 0o111, 0);
  assert.equal(fs.statSync(launcher).mode & 0o022, 0);
  assert.match(source, /exec \/Users\/cole\/\.openclaw\/tools\/node\/bin\/node "\$GOG_ROUTE_ROOT\/scripts\/gog-main\.cjs" "\$@"/);
  assert.doesNotMatch(source, /homebrew|\/usr\/bin\/env|gog-umich\.cjs/);
});
