'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createTestHome, createTestStore } = require('../test-support/migrated-store');
const { listIdentityTables } = require('../lib/identity');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin/jobtrack.js');

function fixture(t) {
  const store = createTestStore();
  t.after(() => fs.rmSync(store.root, { recursive: true, force: true }));
  return store;
}

function runCli(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }));
}

function inspectStore(home, inspect) {
  const db = new Database(path.join(home, 'jobtrack.db'), { readonly: true, fileMustExist: true });
  try { return inspect(db); } finally { db.close(); }
}

function schemaProjection(home) {
  return inspectStore(home, (db) => ({
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    migrations: db.prepare('SELECT version, name FROM jobtrack_schema_migrations ORDER BY version').all(),
    userVersion: db.pragma('user_version', { simple: true }),
    journalMode: db.pragma('journal_mode', { simple: true }),
    counts: listIdentityTables(db).map((table) => ({
      table, count: db.prepare(`SELECT count(*) AS count FROM "${table}"`).get().count
    }))
  }));
}

test('a copied fixture matches a fresh CLI initialization, including seeds, migrations and UUID guards', (t) => {
  const copy = fixture(t);
  const coldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-test-cold-'));
  t.after(() => fs.rmSync(coldRoot, { recursive: true, force: true }));
  const coldHome = path.join(coldRoot, 'store');
  runCli(coldHome, ['init']);
  assert.deepEqual(schemaProjection(copy.home), schemaProjection(coldHome));
  inspectStore(copy.home, (db) => {
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    const tables = listIdentityTables(db);
    assert.ok(tables.length > 100, 'uses the full CLI schema');
    for (const table of tables) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE uuid IS NULL`).get().n, 0, table);
    }
  });
});

test('database, active WAL writes and attachment changes never leak to another fixture or the template', (t) => {
  const first = fixture(t);
  const second = fixture(t);
  const firstPath = path.join(first.home, 'jobtrack.db');
  const secondPath = path.join(second.home, 'jobtrack.db');
  assert.notEqual(fs.statSync(firstPath).ino, fs.statSync(secondPath).ino, 'copies are not hard links');
  assert.deepEqual(fs.readFileSync(firstPath), fs.readFileSync(secondPath), 'same pristine template');
  const db = new Database(firstPath);
  try {
    db.pragma('wal_autocheckpoint = 0');
    db.exec("CREATE TABLE fixture_probe (value TEXT); INSERT INTO fixture_probe VALUES ('only-first')");
    assert.ok(fs.statSync(`${firstPath}-wal`).size > 0, 'mutation is present in an active WAL');
    fs.writeFileSync(path.join(first.home, 'attachments', 'synthetic.txt'), 'only-first');
    const third = fixture(t);
    for (const other of [second, third]) {
      assert.deepEqual(fs.readdirSync(other.home).sort(), ['attachments', 'jobtrack.db']);
      assert.deepEqual(fs.readdirSync(path.join(other.home, 'attachments')), []);
      inspectStore(other.home, (otherDb) => {
        assert.equal(otherDb.prepare("SELECT name FROM sqlite_schema WHERE name='fixture_probe'").get(), undefined);
        assert.equal(otherDb.pragma('journal_mode', { simple: true }), 'wal');
      });
    }
  } finally {
    db.close();
  }
});

test('copied stores support real CLI writes, interview readback and UUID assignment', (t) => {
  const store = fixture(t);
  const added = runCli(store.home, ['add-application', '--company', 'Synthetic Template Co', '--role', 'Engineer']);
  const id = String(added.application.id);
  const interview = runCli(store.home, [
    'log-interview', '--application-id', id, '--round-type', 'technical-screen',
    '--scheduled-at', '2026-10-01T17:00:00Z', '--timezone', 'UTC', '--format', 'video'
  ]);
  assert.equal(String(interview.interview.application_id), id);
  assert.equal(runCli(store.home, ['search', '--company', 'Synthetic Template Co']).applications.length, 1);
  const shown = runCli(store.home, ['show', id]);
  assert.equal(shown.application.company, 'Synthetic Template Co');
  assert.equal(shown.interviews.length, 1);
  inspectStore(store.home, (db) => {
    for (const table of ['applications', 'interviews', 'application_status_events']) {
      const rows = db.prepare(`SELECT uuid FROM "${table}"`).all();
      assert.ok(rows.length > 0, table);
      for (const row of rows) assert.match(row.uuid, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    }
  });
});

test('copied fixture directories and database keep private permissions', (t) => {
  const store = fixture(t);
  for (const directory of [store.root, store.home, path.join(store.home, 'attachments')]) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
  assert.equal(fs.statSync(path.join(store.home, 'jobtrack.db')).mode & 0o777, 0o600);
});

test('flat homes share the pristine template with nested stores while owning all their cleanup', (t) => {
  const nested = fixture(t);
  const first = createTestHome('jobtrack-flat-first-');
  const second = createTestHome('jobtrack-flat-second-');
  t.after(() => {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  });
  for (const home of [first, second]) {
    assert.deepEqual(fs.readdirSync(home).sort(), ['attachments', 'jobtrack.db']);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(home, 'attachments')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(home, 'jobtrack.db')).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(path.join(home, 'jobtrack.db')), fs.readFileSync(path.join(nested.home, 'jobtrack.db')));
  }
  runCli(first, ['add-application', '--company', 'Flat Synthetic Co', '--role', 'Engineer']);
  fs.writeFileSync(path.join(first, 'attachments', 'synthetic.txt'), 'first-only');
  fs.rmSync(first, { recursive: true, force: true });
  for (const home of [second, nested.home]) {
    assert.deepEqual(runCli(home, ['search']).applications, []);
    assert.deepEqual(fs.readdirSync(path.join(home, 'attachments')), []);
  }
});

test('each process initializes once, ignores inherited store paths, and cleans its template on exit', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-template-lifetime-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const program = `
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { createTestHome, createTestStore } = require('./test-support/migrated-store');
    const flatHome = createTestHome();
    const stores = [createTestStore(), { root: flatHome, home: flatHome }, createTestStore()];
    const templates = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('jobtrack-test-template-'));
    const Database = require('better-sqlite3');
    const db = new Database(path.join(stores[0].home, 'jobtrack.db'));
    const seedUuid = db.prepare("SELECT uuid FROM discovery_sources WHERE source_key='manual'").get().uuid;
    db.close();
    for (const store of stores) fs.rmSync(store.root, { recursive: true, force: true });
    process.stdout.write(JSON.stringify({ templates, seedUuid }));
  `;
  const run = (name) => {
    const directory = path.join(scratch, name);
    fs.mkdirSync(directory);
    const forbiddenHome = path.join(directory, 'inherited-store-must-not-exist');
    const result = spawnSync(process.execPath, ['-e', program], {
      cwd: root,
      env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory,
        JOBTRACK_HOME: forbiddenHome, JOBTRACK_DB: path.join(forbiddenHome, 'jobtrack.db') },
      encoding: 'utf8', timeout: 60_000
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.templates.length, 1, 'only one template for flat and nested fixtures');
    assert.deepEqual(fs.readdirSync(directory), [], 'template removed and inherited store untouched');
    return output;
  };
  assert.notEqual(run('first-process').seedUuid, run('second-process').seedUuid, 'no cross-process cache');
});

test('fixture prefixes cannot select a source store or escape the temporary directory', () => {
  for (const prefix of ['../escape-', '/tmp/escape-', '', '.', 'invalid', null, { source: '/unused' }]) {
    assert.throws(() => createTestStore(prefix), /simple directory prefix/);
    assert.throws(() => createTestHome(prefix), /simple directory prefix/);
  }
});
