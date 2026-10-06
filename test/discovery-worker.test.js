'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { executeWorkRequest } = require('../discovery-sandbox/controller');
const { validateProposalBundle } = require('../discovery-sandbox/contracts');

const root = path.resolve(__dirname, '..');
const worker = path.join(root, 'discovery-sandbox', 'strategy-worker.js');
const fixturePath = path.join(__dirname, 'fixtures', 'discovery', 'imported-leads-work-request.json');
const composePath = path.join(root, 'docker-compose.discovery.yml');
const dockerComposeAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

function requestFixture() {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

test('networkless worker reads one JSON value and writes only one validated proposal to stdout', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-worker-store-'));
  const sentinel = path.join(store, 'must-not-touch');
  fs.writeFileSync(sentinel, 'unchanged', { mode: 0o600 });
  try {
    const result = spawnSync(process.execPath, [worker], {
      cwd: root,
      env: { ...process.env, JOBTRACK_HOME: store },
      input: JSON.stringify(requestFixture()),
      encoding: 'utf8',
      timeout: 5000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim().split('\n').length, 1);
    const bundle = JSON.parse(result.stdout);
    validateProposalBundle(bundle);
    assert.equal(bundle.retrievals.length, 0);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
    assert.deepEqual(fs.readdirSync(store), ['must-not-touch']);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('imported LinkedIn leads are data-only and must point at linkedin.com', () => {
  const request = requestFixture();
  request.input.leads[0].url = 'https://evil.example/jobs/view/123';
  assert.throws(() => executeWorkRequest(request), /linkedin imported leads must use a linkedin.com URL/);
  const source = fs.readFileSync(worker, 'utf8');
  assert.doesNotMatch(source, /require\(['"](?:node:)?(?:http|https|net|dns|tls|better-sqlite3)['"]\)/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /jobtrack\.db|JOBTRACK_HOME/);
});

test('worker output is deterministic and content addressed', () => {
  const left = executeWorkRequest(requestFixture());
  const right = executeWorkRequest(requestFixture());
  assert.equal(left.contentSha256, right.contentSha256);
  assert.equal(left.bundleId, `sha256:${left.contentSha256}`);
});

test('worker enforces a hard input limit before parsing or strategy execution', () => {
  const result = spawnSync(process.execPath, [worker, '--max-input-bytes=1024'], {
    cwd: root,
    input: JSON.stringify(requestFixture()),
    encoding: 'utf8',
    timeout: 5000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Input exceeds 1024 bytes/);
  assert.equal(result.stdout, '');
});

test('compose topology keeps worker internal-only and hardens both processes', () => {
  const compose = fs.readFileSync(composePath, 'utf8');
  const dockerfile = fs.readFileSync(path.join(root, 'discovery-sandbox', 'Dockerfile.worker'), 'utf8');
  const dockerignore = fs.readFileSync(path.join(root, 'discovery-sandbox', '.dockerignore'), 'utf8');
  const workerBlock = compose.slice(compose.indexOf('  worker:'), compose.indexOf('\nconfigs:'));
  assert.match(workerBlock, /networks:\n\s+- discovery_internal/);
  assert.doesNotMatch(workerBlock, /discovery_egress/);
  assert.doesNotMatch(workerBlock, /volumes:|\/var\/run\/docker\.sock|JOBTRACK_HOME|\.ssh|browser/i);
  assert.match(compose, /read_only: true/g);
  assert.match(dockerfile, /built-in-parsers\.js/, 'worker image must include the closed built-in parser registry');
  assert.match(dockerignore, /^!built-in-parsers\.js$/m, 'worker parser registry must be present in the Docker build context');
  assert.match(compose, /cap_drop:\n\s+- ALL/g);
  assert.match(compose, /no-new-privileges:true/g);
  assert.match(compose, /pids_limit: 64/g);
  assert.match(compose, /mem_limit: 256m/g);
  assert.match(compose, /discovery_internal:\n\s+internal: true/);
  const brokerBlock = compose.slice(compose.indexOf('  broker:'), compose.indexOf('\n  worker:'));
  assert.match(brokerBlock, /- discovery_internal\n\s+- discovery_egress/);
});

test('rendered Compose model gives only the broker an egress network', { skip: !dockerComposeAvailable }, () => {
  const rendered = spawnSync('docker', [
    'compose', '-f', composePath, '--profile', 'worker', 'config', '--format', 'json'
  ], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  assert.equal(rendered.status, 0, rendered.stderr);
  const model = JSON.parse(rendered.stdout);
  assert.deepEqual(Object.keys(model.services.worker.networks), ['discovery_internal']);
  assert.deepEqual(Object.keys(model.services.broker.networks).sort(), ['discovery_egress', 'discovery_internal']);
  assert.equal(model.networks.discovery_internal.internal, true);
  assert.equal(model.services.worker.read_only, true);
  assert.deepEqual(model.services.worker.cap_drop, ['ALL']);
  assert.ok(model.services.worker.security_opt.includes('no-new-privileges:true'));
  assert.equal(model.services.worker.volumes, undefined);
  assert.equal(model.services.worker.configs, undefined);
  assert.equal(model.services.worker.ports, undefined);
});

test('containerized worker cannot reach a live host-local listener', {
  skip: process.env.JOBTRACK_RUN_CONTAINER_TESTS !== '1'
}, async (context) => {
  assert.equal(dockerComposeAvailable, true, 'explicit container acceptance requires Docker Compose');
  // Never run cleanup against the standing project's fixed Compose name or an
  // inherited project selector. Every created resource belongs to this test.
  const projectName = `jobtrack-discovery-test-${randomUUID()}`;
  const composeArgs = ['compose', '-p', projectName, '-f', composePath, '--profile', 'worker'];
  let reached = false;
  const server = http.createServer((_request, response) => {
    reached = true;
    response.end('unexpected');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const probe = `
    const http = require('node:http');
    const guard = setTimeout(() => process.exit(0), 2500);
    const request = http.get('http://host.docker.internal:${port}/', () => process.exit(9));
    request.setTimeout(1500, () => request.destroy(new Error('timeout')));
    request.on('error', () => { clearTimeout(guard); process.exit(0); });
  `;
  try {
    const result = await spawnResult('docker', [
      ...composeArgs, 'run', '--rm', '--no-deps', '-T',
      '--entrypoint', 'node', 'worker', '-e', probe
    ], { cwd: root, timeoutMs: 15_000 });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(reached, false, 'worker reached the host despite internal-only networking');
  } finally {
    const cleanup = await spawnResult('docker', [
      ...composeArgs, 'down', '--remove-orphans', '--rmi', 'local'
    ], { cwd: root, timeoutMs: 15_000 });
    assert.equal(cleanup.code, 0, `test-only Compose cleanup failed: ${cleanup.stderr}`);
  }
});

function spawnResult(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
    });
  });
}
