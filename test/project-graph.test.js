'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { freePort } = require('../test-support/free-port');

const {
  PROJECT_GRAPH_SCHEMA_VERSION,
  listProjectRelations,
  migrateProjectGraph,
  relateProjects,
  setProjectKind,
  unrelateProjects
} = require('../lib/project-graph');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('migration is idempotent; kind and relation constraints hold', () => {
  const db = makeDb();
  migrateProjectGraph(db);
  assert.equal(
    db.prepare('SELECT count(*) AS count FROM jobtrack_schema_migrations WHERE version=?')
      .get(PROJECT_GRAPH_SCHEMA_VERSION).count,
    1
  );
  const alpha = addProjectEntry(db, 'Alpha');
  assert.equal(
    db.prepare('SELECT project_kind FROM profile_projects WHERE id=?').get(alpha.satelliteId).project_kind,
    'application',
    'kind defaults to application'
  );
  assert.throws(
    () => db.prepare("UPDATE profile_projects SET project_kind='framework' WHERE id=?").run(alpha.satelliteId),
    /CHECK/i
  );
  assert.throws(
    () => db.prepare("INSERT INTO profile_project_relations (from_profile_project_id, to_profile_project_id, relation) VALUES (?,?, 'uses')")
      .run(alpha.satelliteId, alpha.satelliteId),
    /CHECK/i,
    'self-relations rejected at the SQL layer'
  );
  db.close();
});

test('kind and relation lifecycle with both-direction listing', () => {
  const db = makeDb();
  const app = addProjectEntry(db, 'App');
  const lib = addProjectEntry(db, 'Lib');

  setProjectKind(db, { entryId: lib.entryId, kind: 'library' });
  assert.equal(
    db.prepare('SELECT project_kind FROM profile_projects WHERE id=?').get(lib.satelliteId).project_kind,
    'library'
  );
  assert.throws(() => setProjectKind(db, { entryId: lib.entryId, kind: 'framework' }), (error) => error.code === 'VALIDATION_ERROR');

  relateProjects(db, { entryId: app.entryId, toEntryId: lib.entryId, relation: 'uses', notes: 'git-pinned' });
  relateProjects(db, { entryId: app.entryId, toEntryId: lib.entryId, relation: 'uses', notes: 'updated note' });
  assert.equal(db.prepare('SELECT count(*) AS count FROM profile_project_relations').get().count, 1, 'relate is idempotent per (from,to,relation)');
  assert.equal(db.prepare('SELECT notes FROM profile_project_relations').get().notes, 'updated note');

  assert.throws(() => relateProjects(db, { entryId: app.entryId, toEntryId: app.entryId, relation: 'uses' }), (error) => error.code === 'VALIDATION_ERROR');
  assert.throws(() => relateProjects(db, { entryId: app.entryId, toEntryId: lib.entryId, relation: 'depends' }), (error) => error.code === 'VALIDATION_ERROR');

  const fromSide = listProjectRelations(db, { entryId: app.entryId }).relations;
  const toSide = listProjectRelations(db, { entryId: lib.entryId }).relations;
  assert.equal(fromSide.length, 1);
  assert.deepEqual(fromSide, toSide, 'relation visible from both entries');
  assert.equal(fromSide[0].relation, 'uses');
  assert.equal(fromSide[0].to.name, 'Lib');

  unrelateProjects(db, { entryId: app.entryId, toEntryId: lib.entryId, relation: 'uses' });
  assert.equal(listProjectRelations(db).relations.length, 0);
  assert.throws(() => unrelateProjects(db, { entryId: app.entryId, toEntryId: lib.entryId, relation: 'uses' }), (error) => error.code === 'NOT_FOUND');

  const info = db.prepare("INSERT INTO profile_entries (category, title, content) VALUES ('skill','Go','seed')").run();
  assert.throws(
    () => relateProjects(db, { entryId: app.entryId, toEntryId: Number(info.lastInsertRowid), relation: 'uses' }),
    (error) => error.code === 'VALIDATION_ERROR' && /project entries/.test(error.message)
  );
  db.close();
});

test('CLI graph lifecycle and web rendering land end to end', async (t) => {
  const home = makeHome('jobtrack-graph-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const app = cliJson(home, ['profile', 'add-project', '--name', 'Host App', '--stack', 'Go', '--source', 'test']);
  const lib = cliJson(home, ['profile', 'add-project', '--name', 'Widget Lib', '--stack', 'Go', '--source', 'test']);

  const kinded = cliJson(home, ['profile', 'project-kind', '--entry-id', String(lib.entry.id), '--kind', 'library']);
  assert.equal(kinded.entry.projectKind, 'library');
  const related = cliJson(home, ['profile', 'relate', '--entry-id', String(app.entry.id), '--to-entry-id', String(lib.entry.id), '--relation', 'uses', '--notes', 'pinned dep']);
  assert.equal(related.relation.to.name, 'Widget Lib');

  const listed = cliJson(home, ['profile', 'relations', '--entry-id', String(lib.entry.id)]);
  assert.equal(listed.relations.length, 1);
  assert.equal(listed.relations[0].from.name, 'Host App');

  await withServer(home, async (baseUrl) => {
    const profile = await request(`${baseUrl}/profile`);
    assert.equal(profile.status, 200, profile.text);
    assert.match(profile.text, /library/);
    assert.match(profile.text, /uses: Widget Lib/);
    assert.match(profile.text, /used by: Host App/);
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
  migrateProjectGraph(db);
  return db;
}

function addProjectEntry(db, name) {
  const entry = db.prepare("INSERT INTO profile_entries (category, title, content) VALUES ('project',?, 'seed')").run(name);
  const satellite = db.prepare('INSERT INTO profile_projects (profile_entry_id, name) VALUES (?,?)')
    .run(entry.lastInsertRowid, name);
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
