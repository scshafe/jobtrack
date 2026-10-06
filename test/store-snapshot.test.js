'use strict';

// scripts/lib/store-snapshot.cjs: the release gate's copy of a store that may
// be live (docs/move-write-side-to-lubuntu.md). Synthetic databases only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { snapshotStore } = require('../scripts/lib/store-snapshot.cjs');

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-store-snapshot-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, 'store');
  fs.mkdirSync(store, { mode: 0o700 });
  return { root, store, db: path.join(store, 'jobtrack.db') };
}

test('a live WAL store: the copy holds transactions still only in the log, and nothing new appears beside the source', async (t) => {
  const { root, store, db } = scratch(t);
  const writer = new Database(db);
  t.after(() => { if (writer.open) writer.close(); });
  writer.pragma('journal_mode = WAL');
  writer.pragma('wal_autocheckpoint = 0');
  writer.exec('CREATE TABLE facts (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  writer.prepare('INSERT INTO facts (value) VALUES (?)').run('checkpointed');
  writer.pragma('wal_checkpoint(TRUNCATE)');
  writer.prepare('INSERT INTO facts (value) VALUES (?)').run('only in the wal');
  assert.ok(fs.statSync(`${db}-wal`).size > 0, 'the fixture keeps a committed transaction in the log');
  const mainBytes = fs.readFileSync(db);
  const listing = fs.readdirSync(store).sort();

  const out = path.join(root, 'copy.db');
  await snapshotStore(db, out);

  const copy = new Database(out, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(copy.prepare('SELECT value FROM facts ORDER BY id').all().map((row) => row.value),
      ['checkpointed', 'only in the wal']);
    assert.equal(copy.pragma('journal_mode', { simple: true }), 'delete');
  } finally { copy.close(); }
  assert.deepEqual(fs.readdirSync(store).sort(), listing);
  assert.deepEqual(fs.readFileSync(db), mainBytes, 'the source database file is not written');
  assert.equal(fs.existsSync(`${out}-wal`) || fs.existsSync(`${out}-shm`), false);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

test('a closed WAL-mode store: copied without creating -wal/-shm beside it', async (t) => {
  const { root, store, db } = scratch(t);
  const writer = new Database(db);
  writer.pragma('journal_mode = WAL');
  writer.exec("CREATE TABLE facts (value TEXT); INSERT INTO facts VALUES ('closed')");
  writer.close();
  assert.deepEqual(fs.readdirSync(store), ['jobtrack.db']);
  fs.chmodSync(db, 0o400);

  const out = path.join(root, 'copy.db');
  await snapshotStore(db, out);

  assert.deepEqual(fs.readdirSync(store), ['jobtrack.db']);
  assert.equal(fs.statSync(db).mode & 0o777, 0o400);
  const copy = new Database(out, { readonly: true, fileMustExist: true });
  try { assert.equal(copy.prepare('SELECT value FROM facts').get().value, 'closed'); } finally { copy.close(); }
});

test('refuses relative paths and an existing destination', async (t) => {
  const { root, db } = scratch(t);
  new Database(db).close();
  const out = path.join(root, 'taken.db');
  fs.writeFileSync(out, 'not a database');
  await assert.rejects(snapshotStore(db, out), /STORE_SNAPSHOT_DESTINATION_EXISTS/);
  await assert.rejects(snapshotStore('jobtrack.db', out), /STORE_SNAPSHOT_PATHS_MUST_BE_ABSOLUTE/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'not a database');
});
