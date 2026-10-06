'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeArgs, run } = require('../scripts/gog-umich.cjs');
const { sanitizedGogEnvironment, gogWorkerEnvironment } = require('../scripts/lib/gog-environment.cjs');
const path = require('node:path');
const fs = require('node:fs');
test('scoped route fixes account/client and strips only identical selectors', () => {
  assert.deepEqual(routeArgs(['gmail','labels','list','--account','scshafe@umich.edu','--client=default']),
    ['--account','scshafe@umich.edu','--client=default','--no-input','gmail','labels','list']);
});
test('unrelated accounts, alternate clients and credential commands fail before resolution', () => {
  for (const args of [['auth','list'], ['config','set'], ['gmail','labels','list','-aother@example.org'],
    ['gmail','labels','list','--account=other@example.org'], ['gmail','labels','list','--client','other'],
    ['--account','scshafe@umich.edu','gmail','labels','list'],
    ...['--home=/unsafe','--access-token=fixture-only','-jaother@example.org','--acct=other@example.org',
      '--acct','--no-input=false','--non-interactive=false','--noninteractive=false','--verbose','--gmail-no-send=false'].map(flag => ['gmail','labels','list',flag])]) {
    assert.throws(() => run(args, { resolve: () => assert.fail('must not resolve') }), /SCOPE_REFUSED/);
  }
});
test('missing or untrusted worker shim stops launch instead of exposing Homebrew fallback', () => {
  const vm = require('node:vm');
  const script = path.join(__dirname,'../scripts/lib/gog-environment.cjs');
  for (const mode of ['missing','nonexecutable','writable','symlink']) {
    const module = {exports:{}};
    vm.runInNewContext(fs.readFileSync(script,'utf8'), {module,__dirname:path.dirname(script),process,
      require(name) {
        if (name !== 'node:fs') return require(name);
        return {realpathSync:p=>p,lstatSync() {
          if (mode === 'missing') throw new Error('ENOENT');
          return {isSymbolicLink:()=>mode==='symlink',uid:process.getuid(),mode:mode==='nonexecutable'?0o600:mode==='writable'?0o777:0o755,
            isDirectory:()=>true,isFile:()=>true};
        }};
      }});
    assert.throws(()=>module.exports.gogWorkerEnvironment({PATH:'/opt/homebrew/bin'}),/GOG_SHARED_ROUTE_UNAVAILABLE/);
  }
});
test('route verifies on every call and never uses PATH or fallback on pin failure', () => {
  let resolutions = 0;
  const deps = { env: { PATH:'/unsafe',GOG_ACCESS_TOKEN:'fixture-only',GOG_HOME:'/unsafe',GOG_KEYRING_BACKEND:'file',GOG_GMAIL_NO_SEND:'1' },
    resolve: () => { resolutions++; return '/approved/gog'; },
    spawn: (binary,args,opts) => {
      assert.equal(binary,'/approved/gog'); assert.equal(opts.env.GOG_ACCESS_TOKEN,undefined);
      assert.equal(opts.env.GOG_HOME,undefined); assert.equal(opts.env.GOG_GMAIL_NO_SEND,'1');
      assert.equal(opts.env.GOG_KEYRING_BACKEND,'keychain'); assert.equal(opts.env.GOG_KEYRING_SERVICE_NAME,'gogcli');
      return { status:0 };
    } };
  assert.equal(run(['calendar','colors'],deps),0); assert.equal(run(['calendar','colors'],deps),0);
  assert.equal(resolutions,2);
  assert.throws(() => run(['calendar','colors'], { resolve: () => { throw new Error('pin'); },spawn:()=>assert.fail('fallback') }), /pin/);
});
test('native environment fixes backend/service and preserves no-send fence', () => {
  assert.deepEqual(sanitizedGogEnvironment({GOG_KEYRING_SERVICE_NAME:'other',GOG_KEYRING_BACKEND:'auto',GOG_GMAIL_NO_SEND:'1'}),
    {GOG_GMAIL_NO_SEND:'1',GOG_KEYRING_BACKEND:'keychain',GOG_KEYRING_SERVICE_NAME:'gogcli'});
});
test('both actual model executor paths opt into the same route without a daemon PATH dependency', () => {
  const route = path.resolve(__dirname, '../tools/gog/umich-bin');
  const env = gogWorkerEnvironment({PATH:'/opt/homebrew/bin:/usr/bin',GOG_HOME:'/unsafe',JOBTRACK_HOME:'/fixture'});
  assert.equal(env.PATH,`${route}:/opt/homebrew/bin:/usr/bin`);
  assert.equal(gogWorkerEnvironment(env).PATH,env.PATH);
  assert.equal(env.JOBTRACK_HOME,'/fixture'); assert.equal(env.GOG_HOME,undefined);
  for (const executor of ['claude','codex']) {
    const source = fs.readFileSync(path.join(__dirname,`../lib/fabric-worker-runner/${executor}-executor.js`),'utf8');
    if (executor === 'codex') {
      assert.match(source,/const environment = gogWorkerEnvironment\(\)/);
      assert.match(source,/workerPath: environment\.PATH/);
      assert.match(source,/env: environment/);
      assert.match(source,/shell_environment_policy\.set\.PATH=/);
    } else {
      assert.match(source,/env: gogWorkerEnvironment\(\)/);
    }
    assert.doesNotMatch(source,/env: process\.env/);
  }
});

test('main deployment covers legacy exec and native Codex shell without global routing', () => {
  const root = path.resolve(__dirname, '..');
  // Deployment artifacts target the reviewed Mac installation, even when this
  // repository test runs from a different checkout or on the Conductor laptop.
  const route = '/Users/cole/.mission-control/projects/jobtrack/tools/gog/main-bin';
  const legacy = JSON.parse(fs.readFileSync(path.join(root, 'deploy/openclaw/gog-main.patch.json'), 'utf8'));
  assert.deepEqual(legacy, { agents: { entries: { main: { tools: { exec: { pathPrepend: [route] } } } } } });
  const native = fs.readFileSync(path.join(root, 'deploy/openclaw/gog-main.codex.toml'), 'utf8');
  const active = native.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  assert.equal(active.length, 2, 'only one additive PATH setting, not a replacement config');
  assert.equal(active[0], '[shell_environment_policy.set]');
  const selectedPath = JSON.parse(active[1].replace(/^PATH = /, ''));
  assert.equal(selectedPath.split(':')[0], route);
  assert.doesNotMatch(selectedPath, /codex-home\/tmp|node_modules|private-journal/);
});
