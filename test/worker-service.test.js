'use strict';

// The write side as a container (Dockerfile.worker, scripts/fabric-worker-
// service.sh, scripts/fabric-heartbeat.sh; docs/move-write-side-to-lubuntu.md).
// Static contract checks plus the entrypoints' refusals, run against synthetic
// directories with a stand-in node so nothing starts a daemon.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { rendererDisabled } = require('../lib/host-capabilities');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('the worker image shares the web image base digest and keeps the worker runtime', () => {
  const web = read('Dockerfile');
  const worker = read('Dockerfile.worker');
  const base = (text) => text.match(/^FROM (node:\S+@sha256:[a-f0-9]{64})/m)?.[1];
  assert.ok(base(web), 'the web image pins its base by digest');
  assert.equal(base(worker), base(web));
  assert.match(worker, /^ARG CODEX_VERSION=\d+\.\d+\.\d+$/m, 'the Codex CLI is pinned to an exact version');
  assert.match(worker, /"@openai\/codex@\$\{CODEX_VERSION\}"/);
  for (const tree of ['bin', 'lib', 'contracts', 'discovery-sandbox', 'scripts', 'vendor', 'deploy/worker']) {
    assert.match(worker, new RegExp(`^COPY ${tree.replace('/', '\\/')} \\./${tree.replace('/', '\\/')}$`, 'm'), `copies ${tree}/`);
  }
  assert.doesNotMatch(worker, /rm -rf \.\/lib\/draft-runner/, 'the worker runner needs lib/draft-runner');
  assert.match(worker, /^COPY --chown=1000:1000 tools \.\/tools$/m, 'the gog route belongs to the runtime uid');
  assert.match(worker, /^USER 1000:1000$/m);
  assert.match(worker, /JOBTRACK_RENDERER=off/);
  assert.match(worker, /^ENTRYPOINT \["\/bin\/sh", "\/app\/scripts\/fabric-worker-service\.sh"\]$/m);
  assert.doesNotMatch(worker, /docker\.sock|GOG_KEYRING|gogcli/i, 'no Docker socket or Gmail credential is baked in');
});

test('the worker Codex config names the dispatcher model and nothing host-specific', () => {
  const config = read('deploy/worker/codex-config.toml');
  const { DEFAULT_MODELS } = require('../lib/fabric-dispatch');
  const settings = config.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
  assert.deepEqual(settings.map((line) => line.split('=')[0].trim()).sort(), ['model', 'model_reasoning_effort', 'service_tier']);
  assert.ok(settings.includes(`model = "${DEFAULT_MODELS.codex}"`));
  assert.doesNotMatch(config, /^\s*\[/m, 'no tables: no projects, plugins or MCP servers');
});

test('JOBTRACK_RENDERER=off withholds the renderer from the fabric tick, and only that value does', () => {
  assert.equal(rendererDisabled({ JOBTRACK_RENDERER: 'off' }), true);
  assert.equal(rendererDisabled({ JOBTRACK_RENDERER: ' OFF ' }), true);
  for (const value of [undefined, '', 'on', '0', 'false']) assert.equal(rendererDisabled({ JOBTRACK_RENDERER: value }), false);
  assert.match(read('bin/jobtrack.js'), /renderLatexMaterial: rendererDisabled\(\) \? undefined : createLatexRenderer\(/);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-worker-service-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, 'store');
  const codexHome = path.join(dir, 'codex-home');
  fs.mkdirSync(store, { mode: 0o700 });
  fs.mkdirSync(codexHome, { mode: 0o700 });
  // A stand-in for node that records its argv instead of starting the daemon.
  const fakeNode = path.join(dir, 'node');
  const argvLog = path.join(dir, 'argv');
  fs.writeFileSync(fakeNode, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${JSON.stringify(argvLog)}\n`, { mode: 0o755 });
  return { dir, store, codexHome, fakeNode, argvLog };
}

function runService(script, env) {
  return spawnSync('/bin/sh', [path.join(root, 'scripts', script)], {
    env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8', timeout: 10_000
  });
}

test('the worker entrypoint refuses a store without jobtrack.db rather than initialising one', (t) => {
  const f = fixture(t);
  const result = runService('fabric-worker-service.sh', { JOBTRACK_HOME: f.store, CODEX_HOME: f.codexHome, JOBTRACK_NODE_PATH: f.fakeNode });
  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /refusing to initialise a new store/);
  assert.deepEqual(fs.readdirSync(f.store), []);
  assert.equal(fs.existsSync(f.argvLog), false);
});

test('the worker entrypoint refuses to staff workers without a Codex login, but a dry-run pass needs none', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.store, 'jobtrack.db'), '');
  const refused = runService('fabric-worker-service.sh', { JOBTRACK_HOME: f.store, CODEX_HOME: f.codexHome, JOBTRACK_NODE_PATH: f.fakeNode });
  assert.equal(refused.status, 78, refused.stderr);
  assert.match(refused.stderr, /no Codex login/);
  assert.equal(fs.existsSync(f.argvLog), false);

  const dry = runService('fabric-worker-service.sh', {
    JOBTRACK_HOME: f.store, JOBTRACK_NODE_PATH: f.fakeNode, JOBTRACK_DISPATCH_ARGS: '--dry-run --json'
  });
  assert.equal(dry.status, 0, dry.stderr);
  const argv = fs.readFileSync(f.argvLog, 'utf8').trim().split('\n');
  assert.deepEqual(argv, ['/app/bin/jobtrack.js', 'fabric', 'daemon',
    '--pass-command', `cd /app && ${f.fakeNode} bin/jobtrack.js fabric dispatch --dry-run --json`,
    '--safety-tick-ms', '1200000']);
});

test('with a login the entrypoint execs the production pass and rewrites only config.toml in CODEX_HOME', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.store, 'jobtrack.db'), '');
  fs.writeFileSync(path.join(f.codexHome, 'auth.json'), '{"synthetic":true}', { mode: 0o600 });
  fs.writeFileSync(path.join(f.codexHome, 'config.toml'), 'model = "stale"\n');
  // The entrypoint copies /app/deploy/worker/codex-config.toml; outside the
  // image that path is absent, so prove the refusal-free path up to the copy
  // by pointing a private copy of the script at this checkout.
  const script = read('scripts/fabric-worker-service.sh').replace(/^ROOT=\/app$/m, `ROOT=${root}`);
  const local = path.join(f.dir, 'fabric-worker-service.sh');
  fs.writeFileSync(local, script);
  const result = spawnSync('/bin/sh', [local], {
    env: { PATH: '/usr/bin:/bin', JOBTRACK_HOME: f.store, CODEX_HOME: f.codexHome, JOBTRACK_NODE_PATH: f.fakeNode },
    encoding: 'utf8', timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'), read('deploy/worker/codex-config.toml'));
  assert.equal(fs.statSync(path.join(f.codexHome, 'config.toml')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'), '{"synthetic":true}');
  assert.deepEqual(fs.readdirSync(f.codexHome).sort(), ['auth.json', 'config.toml']);
  const argv = fs.readFileSync(f.argvLog, 'utf8').trim().split('\n');
  assert.equal(argv[4], `cd ${root} && ${f.fakeNode} bin/jobtrack.js fabric dispatch --max-workers 3 --notify --json`);
});

test('the heartbeat refuses a store without jobtrack.db and a malformed interval', (t) => {
  const f = fixture(t);
  const noStore = runService('fabric-heartbeat.sh', { JOBTRACK_HOME: f.store });
  assert.equal(noStore.status, 78, noStore.stderr);
  assert.deepEqual(fs.readdirSync(f.store), []);
  fs.writeFileSync(path.join(f.store, 'jobtrack.db'), '');
  const badInterval = runService('fabric-heartbeat.sh', { JOBTRACK_HOME: f.store, JOBTRACK_HEARTBEAT_SECONDS: '1h' });
  assert.equal(badInterval.status, 78, badInterval.stderr);
  assert.match(badInterval.stderr, /whole number/);
});
