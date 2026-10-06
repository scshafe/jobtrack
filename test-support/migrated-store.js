'use strict';

// Test-only, outside node --test's filename patterns. Initialize this checkout
// once per process, then copy its closed, checkpointed database into new private
// directories. No caller-supplied source or destination, shared writable database,
// or production migration bypass.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const repositoryRoot = path.resolve(__dirname, '..');
let templateRoot;
let templateDbPath;

function getTemplateDbPath() {
  if (templateDbPath) return templateDbPath;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-test-template-'));
  const home = path.join(directory, 'store');
  const dbPath = path.join(home, 'jobtrack.db');
  try {
    execFileSync(process.execPath, [path.join(repositoryRoot, 'bin/jobtrack.js'), 'init', '--json'], {
      cwd: repositoryRoot,
      env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000
    });
    const db = new Database(dbPath, { fileMustExist: true });
    try {
      const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)')[0];
      if (checkpoint.busy !== 0) throw new Error('Test store template checkpoint was busy');
      if (db.pragma('quick_check', { simple: true }) !== 'ok') {
        throw new Error('Test store template failed SQLite quick_check');
      }
    } finally {
      db.close();
    }
    // Copy only a self-contained database, never a live WAL or SHM file.
    if (fs.existsSync(`${dbPath}-wal`) && fs.statSync(`${dbPath}-wal`).size !== 0) {
      throw new Error('Test store template still has uncheckpointed WAL bytes');
    }
    if (fs.readdirSync(path.join(home, 'attachments')).length !== 0) {
      throw new Error('Test store template must have no attachments');
    }
    fs.chmodSync(dbPath, 0o400);
    templateRoot = directory;
    templateDbPath = dbPath;
    process.once('exit', () => fs.rmSync(templateRoot, { recursive: true, force: true }));
    return templateDbPath;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function createFixture(prefix, nested) {
  if (typeof prefix !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}-$/.test(prefix)) {
    throw new Error('Test store prefix must be a simple directory prefix ending in a hyphen');
  }
  const source = getTemplateDbPath();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = nested ? path.join(root, 'store') : root;
  try {
    if (nested) fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(path.join(home, 'attachments'), { mode: 0o700 });
    const dbPath = path.join(home, 'jobtrack.db');
    fs.copyFileSync(source, dbPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dbPath, 0o600);
    return { root, home };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Caller owns root cleanup, after closing any database handles or servers. */
function createTestStore(prefix = 'jobtrack-test-store-') {
  return createFixture(prefix, true);
}

/** Flat layout for existing fixtures whose cleanup owns only their home. */
function createTestHome(prefix = 'jobtrack-test-home-') {
  return createFixture(prefix, false).home;
}

module.exports = { createTestHome, createTestStore };
