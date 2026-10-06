'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { freePort } = require('../test-support/free-port');

const {
  REPO_GRAPH_SCHEMA_VERSION,
  linkProjectRepo,
  migrateRepoGraph,
  unlinkProjectRepo
} = require('../lib/repos');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('migration is idempotent and constraints hold', () => {
  const db = makeDb();
  migrateRepoGraph(db);
  assert.equal(
    db.prepare('SELECT count(*) AS count FROM jobtrack_schema_migrations WHERE version=?')
      .get(REPO_GRAPH_SCHEMA_VERSION).count,
    1
  );

  db.prepare("INSERT INTO repos (name, url) VALUES ('a', 'https://example.com/a')").run();
  assert.throws(
    () => db.prepare("INSERT INTO repos (name, url) VALUES ('dup', 'https://example.com/a')").run(),
    /UNIQUE/i
  );
  assert.throws(
    () => db.prepare("INSERT INTO repos (name, url) VALUES ('bad', 'http://example.com/insecure')").run(),
    /CHECK/i,
    'non-https urls rejected at the SQL layer'
  );
  assert.throws(
    () => db.prepare("INSERT INTO repos (name, url, visibility) VALUES ('bad', 'https://example.com/b', 'secret')").run(),
    /CHECK/i
  );

  const project = addProjectEntry(db, 'Constraint Project');
  const repoId = db.prepare('SELECT id FROM repos LIMIT 1').get().id;
  db.prepare('INSERT INTO profile_project_repos (profile_project_id, repo_id, is_primary) VALUES (?,?,1)')
    .run(project.satelliteId, repoId);
  db.prepare("INSERT INTO repos (name, url) VALUES ('b', 'https://example.com/b')").run();
  const secondRepoId = db.prepare("SELECT id FROM repos WHERE url='https://example.com/b'").get().id;
  assert.throws(
    () => db.prepare('INSERT INTO profile_project_repos (profile_project_id, repo_id, is_primary) VALUES (?,?,1)')
      .run(project.satelliteId, secondRepoId),
    /UNIQUE/i,
    'one primary per project enforced by partial unique index'
  );
  assert.throws(
    () => db.prepare('DELETE FROM repos WHERE id=?').run(repoId),
    /FOREIGN KEY/,
    'RESTRICT protects linked repos'
  );
  db.close();
});

test('link lifecycle: auto-create, first-link primary, promote, unlink, wrong category', () => {
  const db = makeDb();
  const project = addProjectEntry(db, 'Linked Project');

  const first = linkProjectRepo(db, { entryId: project.entryId, url: 'https://github.com/example/one' });
  assert.equal(first.link.repoName, 'one', 'repo auto-created with url-derived name');
  assert.equal(first.link.isPrimary, true, 'first link becomes primary');

  const second = linkProjectRepo(db, { entryId: project.entryId, url: 'https://github.com/example/two', role: 'mirror' });
  assert.equal(second.link.isPrimary, false);
  assert.equal(second.link.role, 'mirror');

  const promoted = linkProjectRepo(db, { entryId: project.entryId, url: 'https://github.com/example/two', primary: true });
  assert.equal(promoted.link.isPrimary, true);
  const primaries = db.prepare(
    'SELECT count(*) AS count FROM profile_project_repos WHERE profile_project_id=? AND is_primary=1'
  ).get(project.satelliteId).count;
  assert.equal(primaries, 1, 'promotion demotes the previous primary');

  unlinkProjectRepo(db, { entryId: project.entryId, url: 'https://github.com/example/one' });
  assert.equal(db.prepare('SELECT count(*) AS count FROM profile_project_repos').get().count, 1);
  assert.throws(
    () => unlinkProjectRepo(db, { entryId: project.entryId, url: 'https://github.com/example/one' }),
    (error) => error.code === 'NOT_FOUND'
  );

  const info = db.prepare("INSERT INTO profile_entries (category, title, content) VALUES ('skill','Go','seed')").run();
  assert.throws(
    () => linkProjectRepo(db, { entryId: Number(info.lastInsertRowid), url: 'https://github.com/example/three' }),
    (error) => error.code === 'VALIDATION_ERROR' && /project entries/.test(error.message)
  );
  db.close();
});

test('backfill converts url and links to repo joins idempotently', () => {
  const db = makeDb();
  const project = addProjectEntry(db, 'Backfilled Project', {
    url: 'https://github.com/example/main-repo',
    links: JSON.stringify(['https://github.com/example/main-repo', 'https://github.com/example/side-repo', 'not-a-url'])
  });
  migrateRepoGraph(db);
  migrateRepoGraph(db);

  const repos = db.prepare('SELECT url FROM repos ORDER BY url').all().map((row) => row.url);
  assert.deepEqual(repos, ['https://github.com/example/main-repo', 'https://github.com/example/side-repo']);
  const links = db.prepare(`
    SELECT r.url, j.role, j.is_primary FROM profile_project_repos j JOIN repos r ON r.id=j.repo_id
    WHERE j.profile_project_id=? ORDER BY j.is_primary DESC, r.url
  `).all(project.satelliteId);
  assert.equal(links.length, 2, 'duplicate and non-https strings skipped');
  assert.equal(links[0].url, 'https://github.com/example/main-repo');
  assert.equal(links[0].is_primary, 1);
  assert.equal(links[0].role, 'primary');
  assert.equal(links[1].role, 'component');

  // Operator demotion sticks across re-migration (backfill only sets primary
  // at link creation).
  db.prepare('UPDATE profile_project_repos SET is_primary=0 WHERE profile_project_id=?').run(project.satelliteId);
  migrateRepoGraph(db);
  assert.equal(
    db.prepare('SELECT count(*) AS count FROM profile_project_repos WHERE profile_project_id=? AND is_primary=1')
      .get(project.satelliteId).count,
    0
  );
  db.close();
});

test('CLI repo lifecycle, live backfill, and web rendering land end to end', async (t) => {
  const home = makeHome('jobtrack-repos-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = cliJson(home, ['profile', 'add-project', '--name', 'Repo Demo',
    '--url', 'https://github.com/example/demo', '--links', 'https://github.com/example/demo-docs',
    '--stack', 'Go', '--source', 'test']);

  // The migration backfill on the NEXT open converts url/links into joins.
  const listed = cliJson(home, ['repo', 'list']);
  assert.deepEqual(
    listed.repos.map((repo) => repo.url).sort(),
    ['https://github.com/example/demo', 'https://github.com/example/demo-docs']
  );

  const added = cliJson(home, ['repo', 'add', '--url', 'https://github.com/example/private-tool', '--visibility', 'private', '--notes', 'internal only']);
  assert.equal(added.repo.visibility, 'private');
  const dup = spawnSync(process.execPath, [cli, 'repo', 'add', '--url', 'https://github.com/example/private-tool'],
    { cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8' });
  assert.notEqual(dup.status, 0);
  assert.match(dup.stderr, /already exists/);

  const linked = cliJson(home, ['profile', 'link-repo', '--entry-id', String(project.entry.id),
    '--url', 'https://github.com/example/private-tool', '--role', 'component']);
  assert.equal(linked.link.visibility, 'private');
  assert.equal(linked.link.isPrimary, false, 'backfilled primary already exists');

  await withServer(home, async (baseUrl) => {
    const profile = await request(`${baseUrl}/profile`);
    assert.equal(profile.status, 200, profile.text);
    assert.match(profile.text, /Repos/);
    assert.match(profile.text, /demo \(primary\)/);
    assert.match(profile.text, /private-tool \(component, private\)/);
  });
});

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE jobtrack_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE profile_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT 'seed');
    CREATE TABLE profile_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_entry_id INTEGER NOT NULL UNIQUE REFERENCES profile_entries(id) ON DELETE CASCADE,
      name TEXT NOT NULL, stack TEXT NOT NULL DEFAULT '[]', url TEXT, links TEXT NOT NULL DEFAULT '[]'
    );
  `);
  migrateRepoGraph(db);
  return db;
}

function addProjectEntry(db, name, { url = null, links = '[]' } = {}) {
  const entry = db.prepare("INSERT INTO profile_entries (category, title, content) VALUES ('project',?, 'seed')").run(name);
  const satellite = db.prepare('INSERT INTO profile_projects (profile_entry_id, name, url, links) VALUES (?,?,?,?)')
    .run(entry.lastInsertRowid, name, url, links);
  return { entryId: Number(entry.lastInsertRowid), satelliteId: Number(satellite.lastInsertRowid) };
}

function makeHome(prefix) {
  const home = require('../test-support/migrated-store').createTestHome(prefix);
  fs.mkdirSync(path.join(home, 'tmp'));
  return home;
}

function cliJson(home, args) {
  const stdout = execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    encoding: 'utf8'
  });
  return JSON.parse(stdout);
}

async function withServer(home, fn) {
  const port = await freePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db'), HOST: '127.0.0.1', PORT: String(port), TMPDIR: path.join(home, 'tmp') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 5000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
      try {
        const response = await fetch(`${baseUrl}/profile`, { signal: AbortSignal.timeout(250) });
        await response.text();
        break;
      } catch {
        if (Date.now() > deadline) throw new Error(`server did not become ready: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await fn(baseUrl);
  } finally {
    if (!server.killed) server.kill('SIGTERM');
    await once(server, 'exit').catch(() => {});
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}
