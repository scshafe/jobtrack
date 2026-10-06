'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('opportunity closure projects posting and opening availability without hiding live support', (t) => {
  const home = makeHome(t, 'jobtrack-opportunity-projection-');
  const first = runCli(home, [
    'opportunity', 'add', '--source', 'manual', '--company', 'Projection Co',
    '--role', 'Platform Engineer', '--url', 'https://projection.example/jobs/platform-a'
  ]);
  const second = runCli(home, [
    'opportunity', 'add', '--source', 'manual', '--company', 'Projection Co',
    '--role', 'Platform Engineer', '--url', 'https://projection.example/jobs/platform-b'
  ]);
  const openingId = first.opportunity.job_opening_id;
  const firstPostingId = first.opportunity.primary_job_posting_id;
  const secondPostingId = second.opportunity.primary_job_posting_id;

  let db = openDb(home);
  db.transaction(() => {
    db.prepare("DELETE FROM opening_identifiers WHERE namespace='legacy-opportunity' AND identifier_value=?")
      .run(String(second.opportunityId));
    db.prepare('UPDATE job_postings SET job_opening_id=? WHERE id=?').run(openingId, secondPostingId);
    db.prepare('UPDATE opportunities SET job_opening_id=? WHERE id=?').run(openingId, second.opportunityId);
    db.prepare(`
      INSERT INTO opening_identifiers(job_opening_id,namespace,identifier_value)
      VALUES (?,'legacy-opportunity',?)
    `).run(openingId, String(second.opportunityId));
  }).immediate();
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();

  runCli(home, ['opportunity', 'close', '--opportunity-id', first.opportunityId, '--reason', 'First source closed']);
  db = openDb(home);
  assert.equal(postingState(db, firstPostingId), 'closed');
  assert.equal(postingState(db, secondPostingId), 'open');
  assert.equal(openingStatus(db, openingId), 'open', 'another active posting/opportunity keeps the opening open');
  db.close();

  runCli(home, ['opportunity', 'close', '--opportunity-id', second.opportunityId, '--reason', 'Second source closed']);
  db = openDb(home);
  assert.equal(postingState(db, secondPostingId), 'closed');
  assert.equal(openingStatus(db, openingId), 'closed', 'the opening closes after its last support closes');
  db.close();

  runCli(home, ['opportunity', 'reopen', '--opportunity-id', second.opportunityId]);
  const alternate = runCli(home, [
    'catalog', 'posting', 'create', '--opening-id', openingId, '--platform', 'direct',
    '--venue-key', 'alternate.projection.example', '--url', 'https://alternate.projection.example/jobs/platform',
    '--state', 'open'
  ]).posting;
  runCli(home, ['opportunity', 'close', '--opportunity-id', second.opportunityId, '--reason', 'Discovery source closed again']);
  db = openDb(home);
  assert.equal(postingState(db, secondPostingId), 'closed');
  assert.equal(openingStatus(db, openingId), 'open', 'an independently active cross-post keeps the opening open');

  // Simulate a copied store whose normalized projection was stale. Migration
  // replay must drive it back from the authoritative opportunity states.
  db.prepare("UPDATE job_postings SET state='open' WHERE id IN (?,?,?)")
    .run(firstPostingId, secondPostingId, alternate.id);
  db.prepare("UPDATE job_postings SET state='closed' WHERE id=?").run(alternate.id);
  db.prepare("UPDATE job_openings SET status='open' WHERE id=?").run(openingId);
  db.close();

  runCli(home, ['init']);
  db = openDb(home);
  assert.equal(postingState(db, firstPostingId), 'closed');
  assert.equal(postingState(db, secondPostingId), 'closed');
  assert.equal(openingStatus(db, openingId), 'closed');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  db.close();
});

test('profile add-skill atomically creates its normalized catalog link', (t) => {
  const home = makeHome(t, 'jobtrack-profile-skill-link-');
  const first = runCli(home, [
    'profile', 'add-skill', '--name', 'SQLite', '--group', 'Data', '--confidence', 'high'
  ]);
  const second = runCli(home, [
    'profile', 'add-skill', '--name', 'sqlite', '--group', 'Data', '--confidence', 'high'
  ]);

  const db = openDb(home);
  const links = db.prepare(`
    SELECT ps.profile_entry_id, ps.name, s.id AS skill_id, s.canonical_name, sc.slug AS category
    FROM profile_skills ps
    JOIN profile_skill_catalog_links link ON link.profile_skill_id=ps.id
    JOIN skills s ON s.id=link.skill_id
    JOIN skill_categories sc ON sc.id=s.skill_category_id
    ORDER BY ps.id
  `).all();
  assert.deepEqual(links.map((row) => row.profile_entry_id), [first.entry.id, second.entry.id]);
  assert.deepEqual(links.map((row) => row.category), ['data', 'data']);
  assert.equal(new Set(links.map((row) => row.skill_id)).size, 1, 'case-only profile skills share one normalized skill');
  assert.equal(db.prepare('SELECT count(*) count FROM profile_skill_catalog_links').get().count, 2);
  assert.equal(db.prepare('SELECT count(*) count FROM skills').get().count, 1);
  db.close();
});

test('manual application status events derive evidence completeness from canonical records', (t) => {
  const home = makeHome(t, 'jobtrack-status-evidence-');
  const importedInterviewing = runCli(home, [
    'add-application', '--company', 'Evidence Co', '--role', 'Engineer I', '--status', 'interviewing'
  ]);
  const importedOffer = runCli(home, [
    'add-application', '--company', 'Evidence Co', '--role', 'Engineer II', '--status', 'offer'
  ]);
  const manualOutcome = runCli(home, [
    'add-application', '--company', 'Evidence Co', '--role', 'Engineer III', '--status', 'applied'
  ]);
  runCli(home, ['record-outcome', '--application-id', manualOutcome.application.id, '--status', 'interviewing']);
  const manualUpdate = runCli(home, [
    'add-application', '--company', 'Evidence Co', '--role', 'Engineer IV', '--status', 'applied'
  ]);
  runCli(home, ['update-application', '--application-id', manualUpdate.application.id, '--status', 'offer']);

  const evidencedInterview = runCli(home, [
    'add-application', '--company', 'Evidence Co', '--role', 'Engineer V', '--status', 'applied'
  ]);
  runCli(home, [
    'log-interview', '--application-id', evidencedInterview.application.id, '--round-type', 'technical-screen',
    '--scheduled-at', '2026-07-25T17:00:00Z', '--timezone', 'UTC', '--format', 'video'
  ]);
  const evidencedOffer = runCli(home, [
    'add-application', '--company', 'Evidence Co', '--role', 'Engineer VI', '--status', 'applied'
  ]);
  runCli(home, [
    'record-offer', '--application-id', evidencedOffer.application.id, '--details', 'Written offer received'
  ]);

  const db = openDb(home);
  assert.equal(latestStatusEvent(db, importedInterviewing.application.id).evidence_incomplete, 1);
  assert.equal(latestStatusEvent(db, importedOffer.application.id).evidence_incomplete, 1);
  assert.deepEqual(latestStatusEvent(db, manualOutcome.application.id), {
    event_kind: 'outcome_recorded', to_status: 'interviewing', evidence_incomplete: 1
  });
  assert.deepEqual(latestStatusEvent(db, manualUpdate.application.id), {
    event_kind: 'application_updated', to_status: 'offer', evidence_incomplete: 1
  });
  assert.deepEqual(latestStatusEvent(db, evidencedInterview.application.id), {
    event_kind: 'interview_logged', to_status: 'interviewing', evidence_incomplete: 0
  });
  assert.deepEqual(latestStatusEvent(db, evidencedOffer.application.id), {
    event_kind: 'offer_recorded', to_status: 'offer', evidence_incomplete: 0
  });
  db.close();
});

function runCli(home, args) {
  const stdout = execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return JSON.parse(stdout);
}

function makeHome(t, prefix) {
  const { root: fixture, home } = require('../test-support/migrated-store').createTestStore(prefix);
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  return home;
}

function openDb(home) {
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  return db;
}

function postingState(db, postingId) {
  return db.prepare('SELECT state FROM job_postings WHERE id=?').get(postingId).state;
}

function openingStatus(db, openingId) {
  return db.prepare('SELECT status FROM job_openings WHERE id=?').get(openingId).status;
}

function latestStatusEvent(db, applicationId) {
  return db.prepare(`
    SELECT event_kind,to_status,evidence_incomplete FROM application_status_events
    WHERE application_id=? ORDER BY id DESC LIMIT 1
  `).get(applicationId);
}
