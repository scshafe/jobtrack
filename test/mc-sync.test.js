'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

// The sandboxed test environment blackholes child-process connects to
// arbitrary loopback ports, so these tests drive the CLI through the
// documented fixture seam (JOBTRACK_MC_SYNC_FIXTURE) instead of a stub HTTP
// server. The real fetch path is exercised against the live MC manually.

test('map-mc resolves against the MC project list, stores the id, and fails loud on unknowns', (t) => {
  const home = makeHome('jobtrack-mcsync-map-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = cliJson(home, null, ['profile', 'add-project', '--name', 'Mapped Project', '--stack', 'Go', '--source', 'test']);
  const fixture = writeFixture(home, [{ id: 'mc-uuid-1', slug: 'mapped-project', title: 'Mapped Project', status: 'active' }]);

  const mapped = cliJson(home, fixture, ['profile', 'map-mc', '--entry-id', String(project.entry.id), '--mc-project', 'mapped-project']);
  assert.equal(mapped.mapped.mcProjectId, 'mc-uuid-1');
  assert.equal(mapped.mapped.mcStatus, 'active');

  const db = new Database(path.join(home, 'jobtrack.db'), { readonly: true });
  assert.equal(db.prepare('SELECT mc_project_id FROM profile_projects LIMIT 1').get().mc_project_id, 'mc-uuid-1');
  db.close();

  const failure = spawnSync(process.execPath, [cli, 'profile', 'map-mc', '--entry-id', String(project.entry.id), '--mc-project', 'nope'],
    { cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db'), JOBTRACK_MC_SYNC_FIXTURE: fixture }, encoding: 'utf8' });
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /No Mission Control project matches 'nope'/);
  assert.match(failure.stderr, /mapped-project/, 'known slugs listed');
});

test('sync-mc dry-runs drift, applies only the stale end_date clear, and never renames', (t) => {
  const home = makeHome('jobtrack-mcsync-drift-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = cliJson(home, null, ['profile', 'add-project', '--name', 'Drift Project',
    '--start-date', '2026-01', '--end-date', '2026-06', '--stack', 'Go', '--source', 'test']);
  const fixture = writeFixture(home, [{ id: 'mc-uuid-2', slug: 'drift-project', title: 'Drift Project (MC name)', status: 'active' }]);

  cliJson(home, fixture, ['profile', 'map-mc', '--entry-id', String(project.entry.id), '--mc-project', 'drift-project']);

  const dry = cliJson(home, fixture, ['profile', 'sync-mc']);
  assert.equal(dry.apply, false);
  assert.equal(dry.applied, 0);
  assert.equal(dry.results.length, 1);
  assert.deepEqual(
    dry.results[0].drift.map((entry) => entry.field).sort(),
    ['end_date', 'title'],
    'reports title drift and stale end date'
  );

  const wet = cliJson(home, fixture, ['profile', 'sync-mc', '--apply']);
  assert.equal(wet.applied, 1);
  const db = new Database(path.join(home, 'jobtrack.db'), { readonly: true });
  const row = db.prepare('SELECT name, end_date FROM profile_projects LIMIT 1').get();
  db.close();
  assert.equal(row.end_date, null, 'stale end date cleared');
  assert.equal(row.name, 'Drift Project', 'curated name never auto-renamed');

  const after = cliJson(home, fixture, ['profile', 'sync-mc']);
  assert.deepEqual(after.results[0].drift.map((entry) => entry.field), ['title'], 'end_date drift gone after apply');
});

test('sync-mc fails soft when MC is unreachable and reports archived recommendations without writing', (t) => {
  const home = makeHome('jobtrack-mcsync-soft-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = cliJson(home, null, ['profile', 'add-project', '--name', 'Archived Project', '--stack', 'Go', '--source', 'test']);

  const down = cliJson(home, path.join(home, 'missing-fixture.json'), ['profile', 'sync-mc']);
  assert.equal(down.mcUnreachable, true, 'unreachable MC is a soft outcome, exit 0');

  const fixture = writeFixture(home, [{ id: 'mc-uuid-3', slug: 'archived-project', title: 'Archived Project', status: 'archived' }]);
  cliJson(home, fixture, ['profile', 'map-mc', '--entry-id', String(project.entry.id), '--mc-project', 'archived-project']);
  const report = cliJson(home, fixture, ['profile', 'sync-mc', '--apply']);
  assert.equal(report.applied, 0, 'archived recommendations are never auto-applied');
  assert.deepEqual(
    report.results[0].drift.map((entry) => entry.field).sort(),
    ['display_status', 'end_date'],
    'recommends end date and visibility review'
  );

  const db = new Database(path.join(home, 'jobtrack.db'), { readonly: true });
  const row = db.prepare(`
    SELECT p.end_date, e.display_status FROM profile_projects p
    JOIN profile_entries e ON e.id=p.profile_entry_id LIMIT 1
  `).get();
  db.close();
  assert.equal(row.end_date, null);
  assert.equal(row.display_status, 'visible', 'no writes happened');
});

function writeFixture(home, projects) {
  const fixture = path.join(home, 'tmp', `mc-fixture-${projects[0]?.id || 'empty'}.json`);
  fs.writeFileSync(fixture, JSON.stringify({ projects }));
  return fixture;
}

function makeHome(prefix) {
  const home = require('../test-support/migrated-store').createTestHome(prefix);
  fs.mkdirSync(path.join(home, 'tmp'));
  return home;
}

function cliJson(home, fixturePath, args) {
  const env = { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') };
  if (fixturePath) env.JOBTRACK_MC_SYNC_FIXTURE = fixturePath;
  const stdout = execFileSync(process.execPath, [cli, ...args, '--json'], { cwd: root, env, encoding: 'utf8' });
  return JSON.parse(stdout);
}
