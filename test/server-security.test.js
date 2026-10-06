const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { freePort } = require('../test-support/free-port');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('compose makes container binding and private-store ownership explicit', () => {
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(compose, /user:\s*"\$\{JOBTRACK_UID:\?[^}]+\}:\$\{JOBTRACK_GID:\?[^}]+\}"/);
  assert.match(compose, /JOBTRACK_ALLOW_NON_LOOPBACK:\s*"1"/);
  assert.match(compose, /127\.0\.0\.1:\$\{JOBTRACK_WEB_PORT:-3000\}:3000/);
  assert.match(compose, /read_only:\s*true/);
  assert.match(dockerfile, /COPY\s+lib\s+\.\/lib/, 'the runtime image must include server-side library modules');
  assert.match(dockerfile, /COPY\s+contracts\s+\.\/contracts/, 'the runtime image must include schemas required by server-side modules');
  assert.match(
    dockerfile,
    /COPY\s+discovery-sandbox\s+\.\/discovery-sandbox/,
    'the runtime image must include policy modules required by the email and discovery read models'
  );
  assert.match(
    dockerfile,
    /chmod\s+-R\s+a\+rX\s+\/app/,
    'private host source modes must not prevent the host-owner runtime UID from reading the image'
  );
});

test('web server refuses non-loopback binding unless explicitly overridden', (t) => {
  const { root: fixtureRoot, home } = require('../test-support/migrated-store').createTestStore('jobtrack-server-bind-');
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const tmp = path.join(fixtureRoot, 'tmp');
  fs.mkdirSync(tmp);
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db'), TMPDIR: tmp, HOST: '0.0.0.0', PORT: '0' },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing non-loopback JobTrack web binding/);
  assert.deepEqual(fs.readdirSync(tmp), [], 'rejected binding must not create a private snapshot cache');
});

test('parallel servers sharing TMPDIR keep their private stores isolated and clean up snapshots', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-server-isolation-'));
  const sharedTmp = path.join(fixtureRoot, 'tmp');
  const alphaHome = path.join(fixtureRoot, 'alpha');
  const bravoHome = path.join(fixtureRoot, 'bravo');
  fs.mkdirSync(sharedTmp);
  fs.mkdirSync(alphaHome);
  fs.mkdirSync(bravoHome);

  // Retain explicit sibling stores: this regression exercises both servers
  // sharing one exact TMPDIR, including first-command initialization.
  runCli(alphaHome, ['profile', 'add', '--category', 'evidence', '--title', 'ALPHA_PRIVATE_PROFILE', '--content', 'alpha', '--source', 'test']);
  runCli(bravoHome, ['profile', 'add', '--category', 'evidence', '--title', 'BRAVO_PRIVATE_PROFILE', '--content', 'bravo', '--source', 'test']);

  let alpha;
  let bravo;
  try {
    alpha = await startServer(alphaHome, sharedTmp, { useDefaultHost: true });
    bravo = await startServer(bravoHome, sharedTmp);

    // Make Bravo populate its cache before Alpha reads any profile pages. With
    // the former global cache path, Alpha would now render Bravo's profile.
    const bravoProfile = await request(`${bravo.baseUrl}/profile`);
    assert.equal(bravoProfile.status, 200, bravoProfile.text);
    assert.match(bravoProfile.text, /BRAVO_PRIVATE_PROFILE/);
    assert.doesNotMatch(bravoProfile.text, /ALPHA_PRIVATE_PROFILE/);

    const alphaProfile = await request(`${alpha.baseUrl}/profile`);
    assert.equal(alphaProfile.status, 200, alphaProfile.text);
    assert.match(alphaProfile.text, /ALPHA_PRIVATE_PROFILE/);
    assert.doesNotMatch(alphaProfile.text, /BRAVO_PRIVATE_PROFILE/);
    assertPrivateHeaders(alphaProfile.headers);

    const head = await request(`${alpha.baseUrl}/profile`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');

    const post = await request(`${alpha.baseUrl}/profile`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    assertPrivateHeaders(post.headers);

    assert.match(alpha.stdout(), /listening on http:\/\/127\.0\.0\.1:/, 'HOST should default to loopback');
  } finally {
    await Promise.all([stopServer(alpha), stopServer(bravo)]);
  }

  assert.deepEqual(
    fs.readdirSync(sharedTmp).filter((name) => name.startsWith('jobtrack-readcache-')),
    [],
    'private snapshot directories should be removed on graceful shutdown'
  );
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('read snapshot includes committed WAL frames without writing the source store', async () => {
  const { root: fixtureRoot, home } = require('../test-support/migrated-store').createTestStore('jobtrack-server-wal-');
  const tmp = path.join(fixtureRoot, 'tmp');
  fs.mkdirSync(tmp);

  const databasePath = path.join(home, 'jobtrack.db');
  const writer = new Database(databasePath);
  writer.pragma('journal_mode = WAL');
  writer.pragma('wal_autocheckpoint = 0');
  writer.pragma('wal_checkpoint(TRUNCATE)');
  writer.prepare(`
    INSERT INTO profile_entries (category, title, content, source, confidence, tags)
    VALUES ('evidence', 'WAL_ONLY_PRIVATE_PROFILE', 'wal frame', 'test', 'high', '[]')
  `).run();
  assert.equal(fs.existsSync(`${databasePath}-wal`), true);
  assert.ok(fs.statSync(`${databasePath}-wal`).size > 0);
  const sourceBefore = [fileStamp(databasePath), fileStamp(`${databasePath}-wal`)];

  let instance;
  try {
    instance = await startServer(home, tmp);
    const profile = await request(`${instance.baseUrl}/profile`);
    assert.equal(profile.status, 200, profile.text);
    assert.match(profile.text, /WAL_ONLY_PRIVATE_PROFILE/);
    assert.deepEqual(
      [fileStamp(databasePath), fileStamp(`${databasePath}-wal`)],
      sourceBefore,
      'the web server must not checkpoint or otherwise write the source database/WAL'
    );
  } finally {
    await stopServer(instance);
    writer.close();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('500 responses are generic and retain private-data security headers', async () => {
  // The missing database is the condition under test; do not migrate this home.
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-server-error-'));
  const missingHome = path.join(fixtureRoot, 'private-missing-store');
  const tmp = path.join(fixtureRoot, 'tmp');
  fs.mkdirSync(missingHome);
  fs.mkdirSync(tmp);

  let instance;
  try {
    instance = await startServer(missingHome, tmp, { expectedHealthStatus: 500 });
    const response = await request(`${instance.baseUrl}/profile`);
    assert.equal(response.status, 500);
    assert.match(response.text, /private read-only view could not be rendered/i);
    assert.doesNotMatch(response.text, /ENOENT|no such file|jobtrack\.db|private-missing-store/i);
    assert.equal(response.text.includes(missingHome), false);
    assertPrivateHeaders(response.headers);
  } finally {
    await stopServer(instance);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function runCli(home, args) {
  execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    stdio: 'pipe'
  });
}

async function startServer(home, tmp, options = {}) {
  const port = await freePort();
  const env = {
    ...process.env,
    JOBTRACK_HOME: home,
    JOBTRACK_DB: path.join(home, 'jobtrack.db'),
    PORT: String(port),
    TMPDIR: tmp
  };
  if (options.useDefaultHost) delete env.HOST;
  else env.HOST = '127.0.0.1';

  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;

  await waitForServer(baseUrl, child, () => stderr, options.expectedHealthStatus || 200);
  return { child, baseUrl, stdout: () => stdout, stderr: () => stderr };
}

async function stopServer(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server did not exit: ${instance.stderr()}`)), 3000);
    instance.child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    instance.child.kill('SIGTERM');
  });
}

async function waitForServer(baseUrl, child, getStderr, expectedStatus) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${getStderr()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(250) });
      await response.text();
      if (response.status === expectedStatus) return;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become ready: ${getStderr()}`);
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

function assertPrivateHeaders(headers) {
  assert.match(headers.get('cache-control') || '', /no-store/);
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.match(headers.get('content-security-policy') || '', /style-src 'unsafe-inline'/);
  assert.match(headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.match(headers.get('permissions-policy') || '', /camera=\(\)/);
}

function fileStamp(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
