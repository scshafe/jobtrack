'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createTestStore } = require('../test-support/migrated-store');

const repositoryRoot = path.resolve(__dirname, '..');

for (const existingOverride of [false, true]) {
  test(`export gate confines writes to its disposable copy with ${existingOverride ? 'existing' : 'absent'} inherited database override`, (t) => {
    const { root, home } = createTestStore('jobtrack-export-gate-test-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const scratchParent = path.join(root, 'gate-tmp');
    fs.mkdirSync(scratchParent, { mode: 0o700 });
    const inheritedHome = path.join(root, 'unrelated-home');
    const inheritedDb = path.join(root, 'unrelated.db');
    const sentinel = 'synthetic non-database sentinel; must remain untouched';
    if (existingOverride) fs.writeFileSync(inheritedDb, sentinel, { mode: 0o600 });
    const replicaDb = path.join(home, 'jobtrack.db');
    const replicaBytes = fs.readFileSync(replicaDb);
    fs.chmodSync(replicaDb, 0o400);
    const result = spawnSync('/bin/sh', ['scripts/conductor-gate.sh', 'export-contract', home], {
      cwd: repositoryRoot,
      env: { ...process.env, NODE_ENV: 'production',
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
        JOBTRACK_HOME: inheritedHome, JOBTRACK_DB: inheritedDb,
        TMPDIR: scratchParent, TMP: scratchParent, TEMP: scratchParent },
      encoding: 'utf8', timeout: 60_000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /conductor-gate: export contract ok/);
    assert.match(result.stdout, /"contract":"public-profile"/);
    assert.doesNotMatch(result.stdout, /synthetic non-database sentinel/);
    assert.deepEqual(fs.readFileSync(replicaDb), replicaBytes, 'the supplied replica is never migrated or written');
    assert.equal(fs.statSync(replicaDb).mode & 0o777, 0o400, 'the replica remains read-only');
    assert.deepEqual(fs.readdirSync(home).sort(), ['attachments', 'jobtrack.db']);
    assert.equal(fs.existsSync(inheritedHome), false);
    if (existingOverride) assert.equal(fs.readFileSync(inheritedDb, 'utf8'), sentinel);
    else assert.equal(fs.existsSync(inheritedDb), false);
    assert.equal(fs.existsSync(`${inheritedDb}-wal`), false);
    assert.equal(fs.existsSync(`${inheritedDb}-shm`), false);
    assert.deepEqual(fs.readdirSync(scratchParent), [], 'the gate removes only its own temporary copy');
  });
}

test('export gate rejects a protected original source before inspecting or copying it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-export-boundary-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // This lexical-only negative must never inspect or open the named source.
  const prohibited = path.join(os.homedir(), '.openclaw', 'workspace-private-journal', 'never-open-store');
  const result = spawnSync('/bin/sh', ['scripts/conductor-gate.sh', 'export-contract', prohibited], {
    cwd: repositoryRoot,
    env: { ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
      JOBTRACK_HOME: path.join(root, 'unused-home'), JOBTRACK_DB: path.join(root, 'unused.db'),
      TMPDIR: root, TMP: root, TEMP: root },
    encoding: 'utf8', timeout: 10_000
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PRIVATE_JOURNAL_SOURCE_PROHIBITED/);
  assert.doesNotMatch(result.stderr, /conductor-gate: no store/);
  assert.deepEqual(fs.readdirSync(root), [], 'neither store nor gate staging is created');
});
