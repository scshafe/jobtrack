'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  IDENTITY_SCHEMA_VERSION,
  assignMissingUuids,
  listIdentityTables,
  sweepUuidIdentity
} = require('../lib/identity');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('a full store gains uuid identity on every table with no NULLs or duplicates', () => {
  const home = makeHome('jobtrack-identity-full-');
  runCli(home, ['init']);

  const db = openReadOnly(home);
  const tables = listIdentityTables(db);
  assert.ok(tables.length > 100, `full store enumerates the real table set (${tables.length})`);
  for (const table of tables) {
    const columns = db.pragma(`table_info("${table}")`).map((column) => column.name);
    assert.ok(columns.includes('uuid'), `${table} has a uuid column`);
    const index = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='index' AND tbl_name=? AND name=?"
    ).get(table, `idx_${table}_uuid`);
    assert.ok(index, `${table} has its unique uuid index`);
    const gaps = db.prepare(`SELECT count(*) AS count FROM "${table}" WHERE uuid IS NULL`).get().count;
    assert.equal(gaps, 0, `${table} has no NULL uuids`);
    const dupes = db.prepare(
      `SELECT count(*) AS count FROM (SELECT uuid FROM "${table}" GROUP BY uuid HAVING count(*)>1)`
    ).get().count;
    assert.equal(dupes, 0, `${table} has no duplicate uuids`);
  }
  db.close();
});

test('CLI commands leave every inserted row uuid-complete, append-only tables included', () => {
  const home = makeHome('jobtrack-identity-cli-');
  runCli(home, ['add-application', '--company', 'TestCo', '--role', 'Systems Engineer']);
  runCli(home, ['record-outcome', '--application-id', '1', '--status', 'rejected', '--notes', 'closed']);

  const db = openReadOnly(home);
  const application = db.prepare('SELECT uuid FROM applications WHERE id=1').get();
  assert.match(application.uuid, UUID_V4, 'application row carries a v4 uuid');

  // application_status_events is guarded append-only; the same-transaction
  // assignment must still have covered its rows.
  const events = db.prepare('SELECT uuid FROM application_status_events').all();
  assert.ok(events.length >= 1, 'status events were recorded');
  for (const event of events) assert.match(event.uuid, UUID_V4);

  const totalGaps = listIdentityTables(db).reduce(
    (sum, table) => sum + db.prepare(`SELECT count(*) AS count FROM "${table}" WHERE uuid IS NULL`).get().count,
    0
  );
  assert.equal(totalGaps, 0, 'no table anywhere holds a NULL uuid after CLI commands');
  db.close();
});

test('sweep is idempotent, self-heals late tables, and preserves existing uuids', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE alpha (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL);
    INSERT INTO alpha (label) VALUES ('one'), ('two');
  `);

  sweepUuidIdentity(db);
  const firstPass = db.prepare('SELECT id, uuid FROM alpha ORDER BY id').all();
  for (const row of firstPass) assert.match(row.uuid, UUID_V4);

  sweepUuidIdentity(db);
  assert.deepEqual(
    db.prepare('SELECT id, uuid FROM alpha ORDER BY id').all(),
    firstPass,
    'second sweep changes nothing'
  );
  assert.equal(
    db.prepare('SELECT count(*) AS count FROM jobtrack_schema_migrations WHERE version=?')
      .get(IDENTITY_SCHEMA_VERSION).count,
    1
  );

  db.exec(`
    CREATE TABLE gamma (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL);
    INSERT INTO gamma (label) VALUES ('late');
  `);
  sweepUuidIdentity(db);
  assert.match(db.prepare('SELECT uuid FROM gamma').get().uuid, UUID_V4, 'late table self-heals');
  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_gamma_uuid'").get(),
    'late table gains its unique index'
  );
  db.close();
});

test('guarded append-only tables are backfilled and their guards survive intact', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE beta (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL);
    CREATE TRIGGER beta_append_only_update BEFORE UPDATE ON beta
    BEGIN SELECT RAISE(ABORT, 'beta is immutable'); END;
    INSERT INTO beta (content) VALUES ('frozen');
  `);

  sweepUuidIdentity(db);
  assert.match(db.prepare('SELECT uuid FROM beta').get().uuid, UUID_V4, 'guarded row backfilled');
  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='beta_append_only_update'").get(),
    'guard trigger restored after backfill'
  );
  assert.throws(
    () => db.prepare("UPDATE beta SET content='thawed' WHERE id=1").run(),
    /beta is immutable/,
    'guard still enforces immutability'
  );

  // New guarded rows are covered by the per-command assignment pass.
  db.exec("INSERT INTO beta (content) VALUES ('appended')");
  assignMissingUuids(db);
  const uuids = db.prepare('SELECT uuid FROM beta ORDER BY id').all().map((row) => row.uuid);
  for (const uuid of uuids) assert.match(uuid, UUID_V4);
  assert.equal(new Set(uuids).size, uuids.length, 'uuids stay unique');
  db.close();
});

function makeHome(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(home, 'tmp'));
  return home;
}

function runCli(home, args) {
  execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home },
    stdio: 'pipe'
  });
}

function openReadOnly(home) {
  return new Database(path.join(home, 'jobtrack.db'), { readonly: true });
}
