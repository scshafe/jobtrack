#!/usr/bin/env node
'use strict';

// A consistent copy of one JobTrack database that never writes beside the
// source. Used by scripts/conductor-gate.sh (export-contract), whose source is
// the LIVE store once the write side runs on the release gate's host
// (docs/move-write-side-to-lubuntu.md), and a read-only replica before that.
//
//   node scripts/lib/store-snapshot.cjs <source.db> <destination.db>
//
// Two cases, decided by the source's write-ahead log:
//   * `<db>-wal` exists: some connection has the database open in WAL mode
//     (SQLite creates the log on open and removes it when the last connection
//     closes cleanly). Copy through SQLite's online backup API, a read
//     transaction against the live writers; the sidecars already exist, so
//     the read-only connection creates nothing new.
//   * no `<db>-wal`: nothing has it open, and the main file holds every
//     committed transaction. Copy its bytes, then prove nothing opened it
//     meanwhile (no log appeared, size and mtime unchanged); otherwise retry,
//     which takes the first path. Opening it through SQLite instead would
//     leave -wal/-shm files beside a store that must not be written.
// The copy is quick_checked and left as one self-contained file in rollback
// journal mode. The destination must not exist yet.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const MAX_ATTEMPTS = 6;

function fingerprint(file) {
  const stat = fs.statSync(file);
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

async function copyOnce(source, destination) {
  if (fs.existsSync(`${source}-wal`)) {
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try { await db.backup(destination); } finally { db.close(); }
    return true;
  }
  const before = fingerprint(source);
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  if (!fs.existsSync(`${source}-wal`) && fingerprint(source) === before) return true;
  fs.rmSync(destination, { force: true });
  return false;
}

async function snapshotStore(source, destination) {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination)) {
    throw new Error('STORE_SNAPSHOT_PATHS_MUST_BE_ABSOLUTE');
  }
  if (!fs.statSync(source).isFile()) throw new Error('STORE_SNAPSHOT_SOURCE_NOT_A_FILE');
  if (fs.existsSync(destination)) throw new Error('STORE_SNAPSHOT_DESTINATION_EXISTS');
  let copied = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !copied; attempt += 1) {
    copied = await copyOnce(source, destination);
  }
  if (!copied) throw new Error('STORE_SNAPSHOT_SOURCE_KEPT_CHANGING');
  fs.chmodSync(destination, 0o600);
  const copy = new Database(destination, { fileMustExist: true });
  try {
    copy.pragma('journal_mode = DELETE');
    if (copy.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('STORE_SNAPSHOT_QUICK_CHECK_FAILED');
  } finally {
    copy.close();
  }
  return { destination, bytes: fs.statSync(destination).size };
}

if (require.main === module) {
  const [source, destination] = process.argv.slice(2);
  snapshotStore(path.resolve(source ?? ''), path.resolve(destination ?? ''))
    .then(() => { process.exitCode = 0; })
    .catch((error) => { process.stderr.write(`store-snapshot: ${error.message}\n`); process.exitCode = 1; });
}

module.exports = { snapshotStore };
