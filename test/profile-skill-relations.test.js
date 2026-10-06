'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { migrateCatalog, resolveOrCreateSkill } = require('../lib/catalog');
const { freePort } = require('../test-support/free-port');
const {
  PROFILE_SKILL_RELATIONS_SCHEMA_VERSION,
  attachProfileSkillLinks,
  linkProfileEntrySkill,
  listProfileSkillLinks,
  migrateProfileSkillRelations,
  unlinkProfileEntrySkill
} = require('../lib/profile-skill-relations');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('migration is idempotent, registers once, and augments the legacy project-skills shape', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  baseTables(db);
  migrateCatalog(db);
  // The legacy shape profile normalization created, before this module existed.
  db.exec(`
    CREATE TABLE profile_project_skills (
      profile_project_id INTEGER NOT NULL REFERENCES profile_projects(id) ON DELETE CASCADE,
      skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
      raw_value TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position>=0),
      source TEXT NOT NULL DEFAULT 'legacy_stack_exact',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(profile_project_id,skill_id), CHECK (trim(raw_value)<>'')
    );
  `);

  migrateProfileSkillRelations(db);
  migrateProfileSkillRelations(db);

  const projectColumns = db.pragma('table_info(profile_project_skills)').map((column) => column.name);
  assert.ok(projectColumns.includes('confidence'), 'legacy table gains confidence');
  assert.ok(projectColumns.includes('evidence'), 'legacy table gains evidence');
  for (const table of ['profile_work_entry_skills', 'profile_education_skills']) {
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
      `${table} exists`
    );
  }
  assert.equal(
    db.prepare('SELECT count(*) AS count FROM jobtrack_schema_migrations WHERE version=?')
      .get(PROFILE_SKILL_RELATIONS_SCHEMA_VERSION).count,
    1
  );
});

test('linking resolves slug, exact name, and alias without ever creating catalog rows', () => {
  const db = makeDb();
  const skill = seedSkill(db, 'TypeScript');
  db.prepare('INSERT INTO skill_aliases (skill_id, alias, normalized_alias) VALUES (?,?,?)').run(skill.id, 'TS', 'ts');
  const work = addWorkEntry(db);
  const skillCountBefore = count(db, 'skills');

  linkProfileEntrySkill(db, { entryId: work.entryId, skill: 'typescript' });
  unlinkProfileEntrySkill(db, { entryId: work.entryId, skill: 'TypeScript' });
  linkProfileEntrySkill(db, {
    entryId: work.entryId, skill: 'TS', source: 'repo_mining', confidence: '0.9', evidence: 'Shipped the demo'
  });

  assert.equal(count(db, 'skills'), skillCountBefore, 'no catalog rows created by linking');
  const { links } = listProfileSkillLinks(db, { entryId: work.entryId });
  assert.equal(links.length, 1);
  assert.equal(links[0].skillSlug, 'typescript');
  assert.equal(links[0].source, 'repo_mining');
  assert.equal(links[0].confidence, 0.9);
  assert.equal(links[0].rawValue, 'TS');

  assert.throws(
    () => linkProfileEntrySkill(db, { entryId: work.entryId, skill: 'TypeScrip' }),
    (error) => error.code === 'NOT_FOUND'
      && /Unknown skill 'TypeScrip'/.test(error.message)
      && /TypeScript/.test(error.message)
      && /add-skill/.test(error.message)
  );
  assert.equal(count(db, 'skills'), skillCountBefore, 'failed resolution creates nothing');
});

test('duplicate links update provenance instead of duplicating rows', () => {
  const db = makeDb();
  seedSkill(db, 'SQLite', 'databases');
  const work = addWorkEntry(db);

  linkProfileEntrySkill(db, { entryId: work.entryId, skill: 'sqlite' });
  linkProfileEntrySkill(db, { entryId: work.entryId, skill: 'SQLite', source: 'repo_mining', confidence: '0.75' });

  const rows = db.prepare('SELECT * FROM profile_work_entry_skills').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'repo_mining');
  assert.equal(rows[0].confidence, 0.75);
  assert.equal(rows[0].position, 0, 'position is stable across relinks');
});

test('skill links reject entries outside work, education, and project', () => {
  const db = makeDb();
  seedSkill(db, 'Go');
  const info = db.prepare("INSERT INTO profile_entries (category, title, content) VALUES ('skill','Go','seed')").run();
  assert.throws(
    () => linkProfileEntrySkill(db, { entryId: Number(info.lastInsertRowid), skill: 'go' }),
    (error) => error.code === 'VALIDATION_ERROR' && /work, education, and project/.test(error.message)
  );
  assert.throws(
    () => linkProfileEntrySkill(db, { entryId: 9999, skill: 'go' }),
    (error) => error.code === 'NOT_FOUND'
  );
});

test('links cascade with their entries and RESTRICT protects catalog skills', () => {
  const db = makeDb();
  const skill = seedSkill(db, 'Rust');
  const work = addWorkEntry(db);
  const education = addEducationEntry(db);

  linkProfileEntrySkill(db, { entryId: work.entryId, skill: 'rust' });
  linkProfileEntrySkill(db, { entryId: education.entryId, skill: 'rust' });
  assert.equal(count(db, 'profile_work_entry_skills') + count(db, 'profile_education_skills'), 2);

  db.prepare('DELETE FROM profile_entries WHERE id=?').run(work.entryId);
  assert.equal(count(db, 'profile_work_entry_skills'), 0, 'work link cascaded away with its entry');

  assert.throws(
    () => db.prepare('DELETE FROM skills WHERE id=?').run(skill.id),
    /FOREIGN KEY/
  );
});

test('unresolved stack values are reported exactly and never guessed into links', () => {
  const db = makeDb();
  seedSkill(db, 'TypeScript');
  addProjectEntry(db, 'Demo Pipeline', '["TypeScript","MadeUpTech"]');

  const { unresolvedStack } = listProfileSkillLinks(db, { unresolved: true });
  assert.deepEqual(unresolvedStack.map((row) => row.rawValue), ['MadeUpTech']);
  assert.equal(count(db, 'profile_project_skills'), 0, 'reporting creates no links');
});

test('attachProfileSkillLinks decorates structured rows for the web read model', () => {
  const db = makeDb();
  seedSkill(db, 'TypeScript');
  const work = addWorkEntry(db);
  linkProfileEntrySkill(db, { entryId: work.entryId, skill: 'typescript', source: 'repo_mining' });

  const byId = new Map([[work.entryId, { id: work.entryId, work: { id: work.satelliteId } }]]);
  attachProfileSkillLinks(db, byId);

  const links = byId.get(work.entryId).work.skillLinks;
  assert.equal(links.length, 1);
  assert.equal(links[0].name, 'TypeScript');
  assert.equal(links[0].source, 'repo_mining');
});

test('CLI skill-link lifecycle and web rendering land end to end', async (t) => {
  const home = makeHome('jobtrack-skill-rel-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  cliJson(home, ['profile', 'add-skill', '--name', 'TypeScript', '--group', 'language', '--source', 'test']);
  const work = cliJson(home, ['profile', 'add-work', '--company', 'TestCo', '--role', 'Systems Engineer', '--start-date', '2024-01', '--end-date', '2025-01', '--source', 'test']);
  cliJson(home, ['profile', 'add-project', '--name', 'Demo Pipeline', '--stack', 'TypeScript,MadeUpTech', '--source', 'test']);

  const linked = cliJson(home, ['profile', 'skill-link', '--entry-id', String(work.entry.id), '--skill', 'typescript', '--source', 'repo_mining', '--evidence', 'Built the demo']);
  assert.equal(linked.link.skillSlug, 'typescript');
  assert.equal(linked.link.source, 'repo_mining');

  const all = cliJson(home, ['profile', 'skill-links']);
  assert.equal(all.work.length, 1);
  assert.ok(
    all.projects.some((link) => link.skillSlug === 'typescript' && link.source === 'legacy_stack_exact'),
    'stack sync links resolvable stack entries automatically'
  );
  assert.deepEqual(all.unresolvedStack.map((row) => row.rawValue), ['MadeUpTech']);

  const failure = spawnSync(
    process.execPath,
    [cli, 'profile', 'skill-link', '--entry-id', String(work.entry.id), '--skill', 'Rust'],
    { cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8' }
  );
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /Unknown skill 'Rust'/);

  await withServer(home, async (baseUrl) => {
    const profile = await request(`${baseUrl}/profile`);
    assert.equal(profile.status, 200, profile.text);
    assert.match(profile.text, /Linked skills/);
    assert.match(profile.text, /TypeScript \(repo_mining\)/);
    assert.match(profile.text, /TypeScript \(legacy_stack_exact\)/);
  });

  const removed = cliJson(home, ['profile', 'skill-unlink', '--entry-id', String(work.entry.id), '--skill', 'TypeScript']);
  assert.equal(removed.removed.skillSlug, 'typescript');
  assert.equal(cliJson(home, ['profile', 'skill-links', '--entry-id', String(work.entry.id)]).links.length, 0);
});

function baseTables(db) {
  db.exec(`
    CREATE TABLE applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT NOT NULL, role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'applied', workflow_stage TEXT NOT NULL DEFAULT 'submitted',
      applied_date TEXT, job_url TEXT, notes TEXT, status_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      source_opportunity_id INTEGER
    );
    CREATE TABLE discovery_sources (
      id INTEGER PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, adapter TEXT NOT NULL,
      label TEXT NOT NULL, base_url TEXT
    );
    CREATE TABLE opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT NOT NULL, company_name TEXT NOT NULL,
      title TEXT NOT NULL, canonical_url TEXT NOT NULL, canonical_url_sha256 TEXT NOT NULL UNIQUE,
      primary_source_id INTEGER REFERENCES discovery_sources(id), provider TEXT, board_key TEXT,
      external_id TEXT, dedupe_fingerprint TEXT NOT NULL, posted_at TEXT, first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE opportunity_snapshots (
      id INTEGER PRIMARY KEY, opportunity_id INTEGER NOT NULL REFERENCES opportunities(id), normalized_text TEXT
    );
    CREATE TABLE opportunity_observations (
      id INTEGER PRIMARY KEY, opportunity_id INTEGER NOT NULL REFERENCES opportunities(id),
      snapshot_id INTEGER REFERENCES opportunity_snapshots(id), observed_url TEXT NOT NULL
    );
    CREATE TABLE profile_skills (id INTEGER PRIMARY KEY, profile_entry_id INTEGER, name TEXT NOT NULL, skill_group TEXT);
    CREATE TABLE profile_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT 'seed'
    );
    CREATE TABLE profile_work_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_entry_id INTEGER NOT NULL UNIQUE REFERENCES profile_entries(id) ON DELETE CASCADE,
      company TEXT NOT NULL, role_title TEXT NOT NULL, start_date TEXT, end_date TEXT,
      is_present INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE profile_education_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_entry_id INTEGER NOT NULL UNIQUE REFERENCES profile_entries(id) ON DELETE CASCADE,
      institution TEXT NOT NULL, degree TEXT, field_of_study TEXT
    );
    CREATE TABLE profile_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_entry_id INTEGER NOT NULL UNIQUE REFERENCES profile_entries(id) ON DELETE CASCADE,
      name TEXT NOT NULL, stack TEXT NOT NULL DEFAULT '[]'
    );
  `);
}

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  baseTables(db);
  migrateCatalog(db);
  migrateProfileSkillRelations(db);
  return db;
}

function seedSkill(db, name, categorySlug = 'languages') {
  const category = db.prepare('SELECT id FROM skill_categories WHERE slug=?').get(categorySlug);
  assert.ok(category, `seeded skill category ${categorySlug}`);
  return resolveOrCreateSkill(db, name, category.id);
}

function addWorkEntry(db, title = 'Systems Engineer at TestCo') {
  const entry = db.prepare("INSERT INTO profile_entries (category, title, content) VALUES ('work',?, 'seed')").run(title);
  const satellite = db.prepare(`
    INSERT INTO profile_work_entries (profile_entry_id, company, role_title, start_date, end_date)
    VALUES (?, 'TestCo', 'Systems Engineer', '2024-01', '2025-01')
  `).run(entry.lastInsertRowid);
  return { entryId: Number(entry.lastInsertRowid), satelliteId: Number(satellite.lastInsertRowid) };
}

function addEducationEntry(db, title = 'BS in CS at State U') {
  const entry = db.prepare("INSERT INTO profile_entries (category, title, content) VALUES ('education',?, 'seed')").run(title);
  const satellite = db.prepare(`
    INSERT INTO profile_education_entries (profile_entry_id, institution, degree, field_of_study)
    VALUES (?, 'State University', 'BS', 'Computer Science')
  `).run(entry.lastInsertRowid);
  return { entryId: Number(entry.lastInsertRowid), satelliteId: Number(satellite.lastInsertRowid) };
}

function addProjectEntry(db, name, stackJson) {
  const entry = db.prepare("INSERT INTO profile_entries (category, title, content) VALUES ('project',?, 'seed')").run(name);
  const satellite = db.prepare('INSERT INTO profile_projects (profile_entry_id, name, stack) VALUES (?,?,?)')
    .run(entry.lastInsertRowid, name, stackJson);
  return { entryId: Number(entry.lastInsertRowid), satelliteId: Number(satellite.lastInsertRowid) };
}

function count(db, table) {
  return db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
}

function makeHome(prefix) {
  const home = require('../test-support/migrated-store').createTestHome(prefix);
  fs.mkdirSync(path.join(home, 'tmp'));
  return home;
}

function cliJson(home, args) {
  const stdout = execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    encoding: 'utf8'
  });
  return JSON.parse(stdout);
}

async function withServer(home, fn) {
  const port = await freePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db'), HOST: '127.0.0.1', PORT: String(port), TMPDIR: path.join(home, 'tmp') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl, server, () => stderr);
    await fn(baseUrl);
  } finally {
    if (!server.killed) server.kill('SIGTERM');
    await once(server, 'exit').catch(() => {});
  }
}

async function waitForServer(baseUrl, server, getStderr) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early: ${getStderr()}`);
    try {
      const response = await fetch(`${baseUrl}/profile`, { signal: AbortSignal.timeout(250) });
      await response.text();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`server did not become ready: ${getStderr()}`);
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}
