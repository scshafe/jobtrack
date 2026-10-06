'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  assertNoPrivateJournalSource,
  assertPathNotPrivateJournalSource,
  defaultPrivateJournalBoundaries
} = require('../lib/private-source-boundary');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-private-boundary-'));
  const home = path.join(root, 'home');
  const protectedRoot = path.join(home, '.openclaw', 'workspace-private-journal');
  const safeRoot = path.join(root, 'safe');
  fs.mkdirSync(protectedRoot, { recursive: true });
  fs.mkdirSync(safeRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, protectedRoot, safeRoot };
}

test('default boundaries cover private agent state and shared Telegram payload stores', () => {
  const roots = defaultPrivateJournalBoundaries('/example/home');
  assert.ok(roots.includes('/example/home/.openclaw/workspace-private-journal'));
  assert.ok(roots.includes('/example/home/.openclaw/agents/private-journal'));
  assert.ok(roots.includes('/example/home/.openclaw/state'));
  assert.ok(roots.includes('/example/home/.openclaw/telegram'));
  assert.ok(roots.includes('/example/home/.openclaw/media'));
});

test('rejects a direct path beneath the protected journal before reading it', (t) => {
  const f = fixture(t);
  const entry = path.join(f.protectedRoot, 'journal', 'entries', '2026', 'entry.md');
  assert.throws(
    () => assertPathNotPrivateJournalSource(entry, '--file', { home: f.home }),
    (error) => error.code === 'PRIVATE_JOURNAL_SOURCE_PROHIBITED'
  );
});

test('rejects a safe-looking symlink that resolves into the protected journal', (t) => {
  const f = fixture(t);
  const entry = path.join(f.protectedRoot, 'entry.md');
  fs.writeFileSync(entry, 'sentinel only');
  const link = path.join(f.safeRoot, 'linked-entry.md');
  fs.symlinkSync(entry, link);
  assert.throws(
    () => assertPathNotPrivateJournalSource(link, '--content-file', { home: f.home }),
    (error) => error.code === 'PRIVATE_JOURNAL_SOURCE_PROHIBITED'
  );
});

test('rejects protected provenance markers and permits unrelated files', (t) => {
  const f = fixture(t);
  const safe = path.join(f.safeRoot, 'approved.md');
  fs.writeFileSync(safe, 'approved source');
  assert.doesNotThrow(() => assertNoPrivateJournalSource({ contentFile: safe }, { home: f.home }));
  assert.throws(
    () => assertNoPrivateJournalSource({ source: 'Chloe Private Journal' }, { home: f.home }),
    (error) => error.code === 'PRIVATE_JOURNAL_SOURCE_PROHIBITED'
  );
});

test('jobtrack CLI rejects a protected file before creating its store', (t) => {
  const f = fixture(t);
  const entry = path.join(f.protectedRoot, 'entry.md');
  fs.writeFileSync(entry, 'sentinel only');
  const store = path.join(f.root, 'jobtrack-store');
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'jobtrack.js'),
    'capture-posting', '--application-id', '1', '--content-file', entry
  ], {
    encoding: 'utf8',
    env: { ...process.env, HOME: f.home, JOBTRACK_HOME: store }
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /PRIVATE_JOURNAL_SOURCE_PROHIBITED/);
  assert.equal(fs.existsSync(store), false);
});

test('story-tool rejects a protected narrative before reading or importing it', (t) => {
  const f = fixture(t);
  const entry = path.join(f.protectedRoot, 'entry.md');
  fs.writeFileSync(entry, 'This sentinel is long enough to look like a narrative but must never be read.');
  const store = path.join(f.root, 'jobtrack-store');
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'story-tool.js'),
    'add', '--title', 'Forbidden sentinel', '--file', entry,
    '--facet', 'communication=sentinel'
  ], {
    encoding: 'utf8',
    env: { ...process.env, HOME: f.home, JOBTRACK_HOME: store }
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /PRIVATE_JOURNAL_SOURCE_PROHIBITED/);
  assert.equal(fs.existsSync(store), false);
});

