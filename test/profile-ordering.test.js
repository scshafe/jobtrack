'use strict';

// Profile ordering: newest first, everywhere.
//
// The store holds FOUR date shapes, one per capture path — "Feb 2026" (work),
// a bare "2015" (education), "2026-05" (projects), and ISO datetimes
// (created_at/updated_at). The first cut of this compared them as strings,
// which sorts by month NAME and put Jan 2014 above Jun 2021. These tests exist
// because that bug was invisible until the rendered order was read by eye.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { freePort } = require('../test-support/free-port');

const root = path.join(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

// These were once lifted out of server.js as source text and re-evaluated in a
// vm — which meant compareCuration had to be injected separately, because a
// text lift drops the closure it needs. The ordering now lives in its own
// module, so the test imports it and gets the real closure for free.
const {
  profileDateValue,
  sortProfileEntriesDesc,
  PROFILE_ONGOING
} = require('../lib/web/profile-order');

test('every date shape the store actually holds parses to a comparable number', () => {
  assert.equal(profileDateValue('Feb 2026'), 20260201, 'Mon YYYY (work entries)');
  assert.equal(profileDateValue('February 2026'), 20260201, 'full month name');
  assert.equal(profileDateValue('2026-05'), 20260501, 'YYYY-MM (projects)');
  assert.equal(profileDateValue('2026-05-31'), 20260531, 'YYYY-MM-DD');
  assert.equal(profileDateValue('2026-06-27 01:56:11'), 20260627, 'ISO datetime (created_at)');
  assert.equal(profileDateValue('2015'), 20150101, 'bare year (education)');
});

test('month NAMES do not sort alphabetically', () => {
  // The exact regression: "Jan 2014" sorts above "Jun 2021" as a string.
  assert.ok(profileDateValue('Jun 2021') > profileDateValue('Jan 2014'));
  assert.ok(profileDateValue('May 2023') > profileDateValue('Jun 2021'));
  assert.ok(profileDateValue('Dec 2020') > profileDateValue('Apr 2021') === false, 'Apr 2021 is later than Dec 2020');
});

test('absent or unparseable dates sort last instead of throwing', () => {
  for (const value of [null, undefined, '', '   ', 'sometime', 'n/a']) {
    assert.equal(profileDateValue(value), 0, JSON.stringify(value));
  }
});

test('an ongoing role outranks every finished one, independent of today', () => {
  const ongoing = { id: 1, work: { start_date: 'Feb 2020', is_present: 1 } };
  const recent = { id: 2, work: { start_date: 'Apr 2025', end_date: 'Feb 2026' } };
  const [first] = sortProfileEntriesDesc([recent, ongoing]);
  assert.equal(first.id, 1, 'present beats a later end date');
  assert.equal(profileDateValue(PROFILE_ONGOING), PROFILE_ONGOING);
});

test('entries sort newest first across mixed kinds and shapes', () => {
  const entries = [
    { id: 1, work: { start_date: 'Jan 2014', end_date: 'May 2014' } },
    { id: 2, education: { start_date: '2015', graduation_year: '2019' } },
    { id: 3, project: { start_date: '2026-05' } },
    { id: 4, work: { start_date: 'Jun 2021', end_date: 'Jun 2022' } },
    { id: 5, updated_at: '2026-06-27 01:56:11' }
  ];
  assert.equal(sortProfileEntriesDesc(entries).map((entry) => entry.id).join(','), '5,3,4,2,1');
});

test('ordering is stable when two entries share a date', () => {
  const entries = [
    { id: 7, work: { end_date: 'Jun 2022' } },
    { id: 9, work: { end_date: 'Jun 2022' } }
  ];
  assert.equal(sortProfileEntriesDesc(entries).map((e) => e.id).join(','), '9,7', 'ties break on id, descending');
});

test('the profile renders one column, not a grid of cards', () => {
  const css = require('../lib/web/styles').baseStyles();
  assert.match(css, /\.profile-shell \.entry-grid \{ grid-template-columns:minmax\(0,1fr\); \}/);
  assert.match(css, /\.profile-shell \.kv, \.profile-shell \.meta \{ grid-template-columns:minmax\(0,1fr\); \}/);
  // The application workspace is a dashboard and keeps its denser grids.
  assert.match(css, /\.entry-grid \{ display:grid; grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test('rendered work history is reverse chronological end to end', async () => {
  const home = require('../test-support/migrated-store').createTestHome('jobtrack-order-');
  fs.mkdirSync(path.join(home, 'tmp'));
  const run = (args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, stdio: 'pipe' });
  run(['profile', 'add-work', '--company', 'Oldest', '--role', 'Tutor', '--start-date', 'Jan 2014', '--end-date', 'May 2014', '--confidence', 'high']);
  run(['profile', 'add-work', '--company', 'Middle', '--role', 'Engineer', '--start-date', 'Jun 2021', '--end-date', 'Jun 2022', '--confidence', 'high']);
  run(['profile', 'add-work', '--company', 'Current', '--role', 'Staff Engineer', '--start-date', 'Feb 2026', '--present', '--confidence', 'high']);

  const port = await freePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db'), HOST: '127.0.0.1', PORT: String(port), TMPDIR: path.join(home, 'tmp') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await (await fetch(`${baseUrl}/profile`, { signal: AbortSignal.timeout(250) })).text(); break; }
      catch { if (Date.now() > deadline) throw new Error('server did not start'); await new Promise((r) => setTimeout(r, 50)); }
    }
    const html = await (await fetch(`${baseUrl}/profile`)).text();
    const section = /data-jt-section="work"[\s\S]*?<\/section>/.exec(html)[0];
    const order = ['Current', 'Middle', 'Oldest'].map((name) => section.indexOf(name));
    assert.ok(order.every((index) => index >= 0), 'all three roles rendered');
    assert.ok(order[0] < order[1] && order[1] < order[2], `newest first, got offsets ${order}`);
  } finally {
    if (!server.killed) server.kill('SIGTERM');
    await once(server, 'exit').catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});
