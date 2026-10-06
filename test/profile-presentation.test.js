'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { freePort } = require('../test-support/free-port');

const {
  PROFILE_PRESENTATION_SCHEMA_VERSION,
  compareDisplay,
  migrateProfilePresentation,
  setProfileDisplay,
  sortByDisplay
} = require('../lib/profile-presentation');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('migration is idempotent and adds spine columns with the visible default', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE jobtrack_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE profile_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT 'seed', created_at TEXT, updated_at TEXT);
    INSERT INTO profile_entries (category, title) VALUES ('project', 'Existing Row');
  `);

  migrateProfilePresentation(db);
  migrateProfilePresentation(db);

  const row = db.prepare('SELECT display_status, display_order FROM profile_entries WHERE id=1').get();
  assert.equal(row.display_status, 'visible', 'existing rows default to visible');
  assert.equal(row.display_order, null);
  assert.equal(
    db.prepare('SELECT count(*) AS count FROM jobtrack_schema_migrations WHERE version=?')
      .get(PROFILE_PRESENTATION_SCHEMA_VERSION).count,
    1
  );
  assert.throws(
    () => db.prepare("UPDATE profile_entries SET display_status='sideways' WHERE id=1").run(),
    /CHECK/i,
    'status check constraint enforces the vocabulary'
  );
  db.close();
});

test('setProfileDisplay validates inputs and preserves updated_at', () => {
  const db = makeDb();
  const before = db.prepare('SELECT updated_at FROM profile_entries WHERE id=1').get().updated_at;

  setProfileDisplay(db, { entryId: 1, status: 'pinned', order: '2' });
  let row = db.prepare('SELECT display_status, display_order, updated_at FROM profile_entries WHERE id=1').get();
  assert.equal(row.display_status, 'pinned');
  assert.equal(row.display_order, 2);
  assert.equal(row.updated_at, before, 'curation never touches content freshness');

  setProfileDisplay(db, { entryId: 1, clearOrder: true });
  row = db.prepare('SELECT display_status, display_order FROM profile_entries WHERE id=1').get();
  assert.equal(row.display_status, 'pinned', 'status untouched when only clearing order');
  assert.equal(row.display_order, null);

  assert.throws(() => setProfileDisplay(db, { entryId: 1 }), (error) => error.code === 'VALIDATION_ERROR');
  assert.throws(() => setProfileDisplay(db, { entryId: 1, status: 'sideways' }), (error) => error.code === 'VALIDATION_ERROR');
  assert.throws(() => setProfileDisplay(db, { entryId: 1, order: '3', clearOrder: true }), (error) => error.code === 'VALIDATION_ERROR');
  assert.throws(() => setProfileDisplay(db, { entryId: 1, order: '-1' }), (error) => error.code === 'VALIDATION_ERROR');
  assert.throws(() => setProfileDisplay(db, { entryId: 999, status: 'hidden' }), (error) => error.code === 'NOT_FOUND');
  db.close();
});

test('compareDisplay orders pinned, explicit order NULLs-last, recency, id', () => {
  const rows = [
    { id: 1, display_status: 'visible', display_order: null, updated_at: '2026-07-01' },
    { id: 2, display_status: 'pinned', display_order: 5, updated_at: '2026-01-01' },
    { id: 3, display_status: 'hidden', display_order: 0, updated_at: '2026-07-28' },
    { id: 4, display_status: 'pinned', display_order: 1, updated_at: '2026-01-01' },
    { id: 5, display_status: 'visible', display_order: 3, updated_at: '2026-02-01' },
    { id: 6, display_status: 'visible', display_order: null, updated_at: '2026-07-01' },
    { id: 7, display_status: 'pinned', display_order: null, updated_at: '2026-06-01' }
  ];
  const ordered = sortByDisplay(rows).map((row) => row.id);
  // pinned: explicit orders 1,5 then unordered by recency; visible: order 3 first,
  // then unordered by recency (tie -> higher id first); hidden last.
  assert.deepEqual(ordered, [4, 2, 7, 5, 6, 1, 3]);
  assert.equal(compareDisplay(rows[0], rows[0]), 0);
});

test('CLI set-display lifecycle and web ordering plus chips land end to end', async (t) => {
  const home = makeHome('jobtrack-presentation-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const alpha = cliJson(home, ['profile', 'add-project', '--name', 'Alpha Project', '--stack', 'Go', '--source', 'test']);
  const beta = cliJson(home, ['profile', 'add-project', '--name', 'Beta Project', '--stack', 'Go', '--source', 'test']);
  const gamma = cliJson(home, ['profile', 'add-project', '--name', 'Gamma Project', '--stack', 'Go', '--source', 'test']);

  const pinned = cliJson(home, ['profile', 'set-display', '--entry-id', String(gamma.entry.id), '--status', 'pinned', '--order', '1']);
  assert.equal(pinned.entry.displayStatus, 'pinned');
  assert.equal(pinned.entry.displayOrder, 1);
  cliJson(home, ['profile', 'set-display', '--entry-id', String(beta.entry.id), '--status', 'hidden']);

  const failure = spawnSync(
    process.execPath,
    [cli, 'profile', 'set-display', '--entry-id', String(alpha.entry.id), '--status', 'sideways'],
    { cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8' }
  );
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /--status must be one of/);

  await withServer(home, async (baseUrl) => {
    const profile = await request(`${baseUrl}/profile`);
    assert.equal(profile.status, 200, profile.text);
    const gammaAt = profile.text.indexOf('Gamma Project');
    const alphaAt = profile.text.indexOf('Alpha Project');
    const betaAt = profile.text.indexOf('Beta Project');
    assert.ok(gammaAt !== -1 && alphaAt !== -1 && betaAt !== -1, 'all three render in the private view');
    assert.ok(gammaAt < alphaAt, 'pinned project sorts before visible');
    assert.ok(alphaAt < betaAt, 'hidden project sorts last');
    assert.match(profile.text, /pinned/);
    assert.match(profile.text, /hidden/);
  });
});

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE jobtrack_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE profile_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT 'seed', created_at TEXT DEFAULT '2026-07-01', updated_at TEXT DEFAULT '2026-07-01');
    INSERT INTO profile_entries (category, title) VALUES ('project', 'Seed Project');
  `);
  migrateProfilePresentation(db);
  return db;
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
