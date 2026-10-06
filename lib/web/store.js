'use strict';

// The read-only store: where the web surface gets a database it can never
// write to.
//
// The source store is a bind mount that may be read-only, while a WAL database
// needs writable sidecars to open at all. So nothing here opens the source: it
// is stat'ed and COPIED into a private per-process directory, and the copy is
// opened query_only. Fingerprints taken before the copy, after the copy, and
// after validation reject any snapshot captured across a concurrent writer
// update, so a page never renders a torn read.
//
// Each server/store pair owns its own snapshot directory (the name carries a
// digest of the resolved DB path) — a shared cache filename would let parallel
// servers read one another's private stores.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const JOBTRACK_HOME = process.env.JOBTRACK_HOME || path.join(os.homedir(), '.jobtrack');
const DB_PATH = process.env.JOBTRACK_DB || path.join(JOBTRACK_HOME, 'jobtrack.db');
const STORE_CACHE_KEY = crypto.createHash('sha256').update(path.resolve(DB_PATH)).digest('hex').slice(0, 12);
const SNAPSHOT_RETRIES = 6;

// Each server/store pair owns a private writable snapshot directory. A global
// cache filename can make parallel servers read one another's private stores.
//
// It is created on FIRST READ, not at require time. Requiring this module must
// allocate nothing: the server refuses a non-loopback binding before it serves
// anything, and a refused start must leave no snapshot cache behind (it exits
// before any cleanup hook is registered, so anything allocated at require time
// leaks). Laziness makes that hold structurally instead of by the order of two
// statements in server.js — pinned by test/server-security.test.js.
let readCacheDir = null;
function ensureReadCacheDir() {
  if (readCacheDir === null) {
    readCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), `jobtrack-readcache-${process.pid}-${STORE_CACHE_KEY}-`));
    fs.chmodSync(readCacheDir, 0o700);
  }
  return readCacheDir;
}

// The source bind mount is read-only, while a WAL database may require writable
// sidecars to open. Capture the main database plus any WAL into our private
// writable directory. Fingerprints before/after the copy (and after validation)
// prevent publishing a snapshot taken across a concurrent writer update. The
// source files are stat'ed and copied only; they are never opened for writing.
let cachedDb = null; // { fingerprint, database, path }
let snapshotSequence = 0;
function getDb() {
  const currentFingerprint = sourceFingerprint(); // ENOENT -> generic 500 via the error handler
  if (!cachedDb || cachedDb.fingerprint !== currentFingerprint.key) {
    const next = captureStableSnapshot();
    const previous = cachedDb;
    cachedDb = next;
    disposeSnapshot(previous);
  }
  return cachedDb.database;
}

function captureStableSnapshot() {
  let lastError = null;

  for (let attempt = 1; attempt <= SNAPSHOT_RETRIES; attempt += 1) {
    const before = sourceFingerprint();
    const snapshotPath = path.join(ensureReadCacheDir(), `snapshot-${process.pid}-${snapshotSequence++}.db`);
    let database = null;

    try {
      fs.copyFileSync(DB_PATH, snapshotPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(snapshotPath, 0o600);
      if (before.wal !== null) {
        fs.copyFileSync(`${DB_PATH}-wal`, `${snapshotPath}-wal`, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(`${snapshotPath}-wal`, 0o600);
      }

      if (sourceFingerprint().key !== before.key) {
        removeSnapshotFiles(snapshotPath);
        continue;
      }

      database = new Database(snapshotPath);
      database.pragma('foreign_keys = ON');
      database.pragma('query_only = ON');
      if (database.pragma('quick_check', { simple: true }) !== 'ok') {
        throw new Error('SQLite quick_check rejected the read snapshot');
      }

      if (sourceFingerprint().key !== before.key) {
        database.close();
        database = null;
        removeSnapshotFiles(snapshotPath);
        continue;
      }

      return { fingerprint: before.key, database, path: snapshotPath };
    } catch (error) {
      lastError = error;
      if (database) {
        try { database.close(); } catch { /* best-effort */ }
      }
      removeSnapshotFiles(snapshotPath);
    }
  }

  throw new Error(`Unable to capture a stable JobTrack read snapshot after ${SNAPSHOT_RETRIES} attempts`, { cause: lastError });
}

function sourceFingerprint() {
  const database = fileFingerprint(DB_PATH, false);
  const wal = fileFingerprint(`${DB_PATH}-wal`, true);
  return {
    database,
    wal,
    key: `${database}|wal:${wal === null ? 'missing' : wal}`
  };
}

function fileFingerprint(filePath, optional) {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    if (!stat.isFile()) throw new Error(`Expected a regular SQLite file: ${filePath}`);
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
}

function disposeSnapshot(snapshot) {
  if (!snapshot) return;
  try { snapshot.database.close(); } catch { /* best-effort */ }
  removeSnapshotFiles(snapshot.path);
}

function removeSnapshotFiles(snapshotPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${snapshotPath}${suffix}`, { force: true }); } catch { /* best-effort */ }
  }
}

function cleanupReadCache() {
  if (cachedDb) {
    try { cachedDb.database.close(); } catch { /* best-effort */ }
    cachedDb = null;
  }
  if (readCacheDir === null) return; // nothing was ever read; nothing to remove
  try { fs.rmSync(readCacheDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  readCacheDir = null;
}

/** Table/JSON helpers every read model needs. A store predating a
 *  migration simply lacks the table, which must read as 'no rows' rather
 *  than a 500: the web surface stays readable across schema versions. */
function safeJson(value, fallback) {
  try { return value === null || value === undefined ? fallback : JSON.parse(value); } catch { return fallback; }
}

function tableRows(db, table) {
  if (!tableExists(db, table)) return [];
  return db.prepare(`SELECT * FROM ${table}`).all();
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table));
}

module.exports = {
  JOBTRACK_HOME,
  DB_PATH,
  getDb,
  cleanupReadCache,
  safeJson,
  tableRows,
  tableExists
};
