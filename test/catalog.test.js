'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  CATALOG_SCHEMA_VERSION,
  CatalogError,
  canonicalizeCatalogUrl,
  createOpening,
  linkApplicationPosting,
  migrateCatalog,
  resolveOrCreateCompany,
  resolveOrCreatePosting,
  resolveOrCreateVenue,
  resolvePlatform
} = require('../lib/catalog');

const REQUIRED_TABLES = [
  'companies', 'company_aliases', 'job_openings', 'opening_identifiers',
  'posting_platforms', 'posting_venues', 'job_postings', 'application_postings',
  'role_types', 'opening_role_types', 'seniority_levels', 'opening_seniority_levels',
  'skill_categories', 'skills', 'skill_aliases', 'profile_skill_catalog_links',
  'requirement_kinds', 'posting_skill_requirements', 'application_status_events'
];

test('fresh migration creates the complete v8 catalog and replays idempotently', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  migrateCatalog(db);
  migrateCatalog(db);

  assert.equal(db.pragma('user_version', { simple: true }), 8);
  for (const table of REQUIRED_TABLES) {
    assert.equal(tableExists(db, table), true, `missing ${table}`);
  }
  assert.equal(db.prepare('SELECT count(*) count FROM jobtrack_schema_migrations WHERE version=?').get(CATALOG_SCHEMA_VERSION).count, 1);
  assert.ok(db.prepare('SELECT count(*) count FROM posting_platforms').get().count >= 10);
  assert.ok(db.prepare('SELECT count(*) count FROM role_types').get().count >= 10);
  assert.ok(db.prepare('SELECT count(*) count FROM seniority_levels').get().count >= 10);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  db.close();
});

test('copied v7-shaped store backfills conservatively, preserves rows, and replays exactly', () => {
  const db = makeV7Db();
  const beforeTags = db.prepare('SELECT * FROM opportunity_tags ORDER BY opportunity_id, tag').all();

  migrateCatalog(db);

  assert.equal(db.prepare('SELECT count(*) count FROM companies').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) count FROM job_openings').get().count, 3);
  assert.equal(db.prepare('SELECT count(*) count FROM job_postings').get().count, 2);
  assert.equal(db.prepare('SELECT count(*) count FROM opportunities').get().count, 2);
  assert.equal(db.prepare('SELECT count(*) count FROM applications').get().count, 2);
  assert.deepEqual(db.prepare('SELECT * FROM opportunity_tags ORDER BY opportunity_id, tag').all(), beforeTags);

  const opportunity1 = db.prepare('SELECT * FROM opportunities WHERE id=1').get();
  const opportunity2 = db.prepare('SELECT * FROM opportunities WHERE id=2').get();
  assert.notEqual(opportunity1.job_opening_id, opportunity2.job_opening_id, 'same company/title must not auto-merge');
  assert.ok(opportunity1.primary_job_posting_id);
  assert.ok(opportunity2.primary_job_posting_id);

  const sourcedApplication = db.prepare('SELECT * FROM applications WHERE id=1').get();
  const unlinkedApplication = db.prepare('SELECT * FROM applications WHERE id=2').get();
  assert.equal(sourcedApplication.job_opening_id, opportunity1.job_opening_id);
  assert.equal(sourcedApplication.primary_job_posting_id, opportunity1.primary_job_posting_id);
  assert.notEqual(unlinkedApplication.job_opening_id, opportunity1.job_opening_id);
  assert.notEqual(unlinkedApplication.job_opening_id, opportunity2.job_opening_id);
  assert.equal(unlinkedApplication.primary_job_posting_id, null, 'missing posting must not be inferred');

  assert.equal(db.prepare('SELECT count(*) count FROM opportunity_snapshots WHERE job_posting_id IS NOT NULL').get().count, 2);
  assert.equal(db.prepare('SELECT count(*) count FROM opportunity_observations WHERE job_posting_id IS NOT NULL').get().count, 2);
  assertForeignKey(db, 'opportunities', 'job_opening_id', 'job_openings');
  assertForeignKey(db, 'opportunities', 'primary_job_posting_id', 'job_postings');
  assertForeignKey(db, 'applications', 'job_opening_id', 'job_openings');
  assertForeignKey(db, 'applications', 'primary_job_posting_id', 'job_postings');
  assertForeignKey(db, 'opportunity_snapshots', 'job_posting_id', 'job_postings');
  assertForeignKey(db, 'opportunity_observations', 'job_posting_id', 'job_postings');
  assert.throws(() => db.prepare('UPDATE opportunity_snapshots SET normalized_text=? WHERE id=1').run('tamper'), /immutable/);
  assert.throws(() => db.prepare('UPDATE opportunity_observations SET observed_url=? WHERE id=1').run('https://tamper.test'), /immutable/);

  const statusEvents = db.prepare('SELECT application_id, to_status, evidence_incomplete FROM application_status_events ORDER BY application_id').all();
  assert.deepEqual(statusEvents, [
    { application_id: 1, to_status: 'interviewing', evidence_incomplete: 1 },
    { application_id: 2, to_status: 'offer', evidence_incomplete: 1 }
  ]);
  assert.equal(db.prepare('SELECT count(*) count FROM interviews').get().count, 0);
  assert.equal(db.prepare('SELECT count(*) count FROM offers').get().count, 0);

  assert.equal(db.prepare('SELECT count(*) count FROM profile_skills').get().count, 2);
  assert.equal(db.prepare('SELECT count(*) count FROM profile_skill_catalog_links').get().count, 2);
  assert.equal(db.prepare('SELECT count(*) count FROM skills').get().count, 1, 'case-only aliases share one skill');

  const counts = catalogCounts(db);
  migrateCatalog(db);
  assert.deepEqual(catalogCounts(db), counts);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  db.close();
});

test('helpers support cross-posting without merging same-title openings and reject mismatches', () => {
  const db = makeV7Db({ seed: false });
  migrateCatalog(db);
  const company = resolveOrCreateCompany(db, 'Example Co');
  assert.equal(resolveOrCreateCompany(db, '  example   co ').id, company.id, 'exact normalized company is canonical');
  const opening = createOpening(db, { companyId: company.id, title: 'Platform Engineer' });
  const distinct = createOpening(db, { companyId: company.id, title: 'Platform Engineer' });
  assert.notEqual(opening.id, distinct.id, 'same title remains a distinct opening without an explicit identity');

  const direct = resolvePlatform(db, 'direct');
  const linkedin = resolvePlatform(db, 'linkedin');
  const directVenue = resolveOrCreateVenue(db, {
    platformId: direct.id, companyId: company.id, venueKey: 'careers.example.test', label: 'Example careers'
  });
  const linkedinVenue = resolveOrCreateVenue(db, {
    platformId: linkedin.id, companyId: company.id, venueKey: 'example-co', label: 'Example on LinkedIn'
  });
  const otherCompany = resolveOrCreateCompany(db, 'Other Co');
  const sharedLinkedinVenue = resolveOrCreateVenue(db, {
    platformId: linkedin.id, companyId: otherCompany.id, venueKey: 'example-co', label: 'LinkedIn'
  });
  assert.equal(sharedLinkedinVenue.id, linkedinVenue.id, 'shared boards must not become owned by the first company seen');
  assert.equal(sharedLinkedinVenue.company_id, null);
  const greenhouse = resolvePlatform(db, 'greenhouse');
  const firstSharedAtsVenue = resolveOrCreateVenue(db, {
    platformId: greenhouse.id, companyId: company.id, venueKey: 'boards.greenhouse.io', label: 'Greenhouse'
  });
  const secondSharedAtsVenue = resolveOrCreateVenue(db, {
    platformId: greenhouse.id, companyId: otherCompany.id, venueKey: 'boards.greenhouse.io', label: 'Greenhouse'
  });
  assert.equal(secondSharedAtsVenue.id, firstSharedAtsVenue.id, 'shared ATS hosts must support different companies');
  assert.equal(secondSharedAtsVenue.company_id, null);
  const directPosting = resolveOrCreatePosting(db, {
    openingId: opening.id,
    venueId: directVenue.id,
    url: 'HTTPS://careers.example.test:443/jobs/42/?b=2&utm_source=first&a=1#apply'
  });
  const linkedinPosting = resolveOrCreatePosting(db, {
    openingId: opening.id, venueId: linkedinVenue.id, url: 'https://linkedin.example.test/jobs/900', externalId: '900'
  });
  assert.notEqual(directPosting.id, linkedinPosting.id);
  assert.equal(db.prepare('SELECT count(*) count FROM job_postings WHERE job_opening_id=?').get(opening.id).count, 2);
  const replay = resolveOrCreatePosting(db, {
    openingId: opening.id,
    venueId: directVenue.id,
    url: 'https://careers.example.test/jobs/42?a=1&utm_medium=replay&b=2'
  });
  assert.equal(replay.id, directPosting.id, 'query order, tracking, default port, fragment, and trailing slash share one URL identity');
  assert.equal(replay.canonical_url, 'https://careers.example.test/jobs/42?a=1&b=2');

  const otherPosting = resolveOrCreatePosting(db, {
    openingId: distinct.id, venueId: directVenue.id, url: 'https://careers.example.test/jobs/43', externalId: '43'
  });
  const application = db.prepare(`
    INSERT INTO applications (
      company, role, status, workflow_stage, status_changed_at, created_at, updated_at, job_opening_id
    ) VALUES ('Example Co','Platform Engineer','applied','submitted',datetime('now'),datetime('now'),datetime('now'),?)
  `).run(opening.id);
  linkApplicationPosting(db, { applicationId: application.lastInsertRowid, postingId: directPosting.id, relation: 'submitted_via', primary: true });
  linkApplicationPosting(db, { applicationId: application.lastInsertRowid, postingId: linkedinPosting.id, relation: 'alternate', primary: true });
  linkApplicationPosting(db, { applicationId: application.lastInsertRowid, postingId: linkedinPosting.id, relation: 'submitted_via' });
  assert.equal(db.prepare('SELECT count(*) count FROM application_postings WHERE application_id=? AND is_primary=1').get(application.lastInsertRowid).count, 1);
  assert.equal(db.prepare('SELECT primary_job_posting_id FROM applications WHERE id=?').get(application.lastInsertRowid).primary_job_posting_id, linkedinPosting.id);
  assert.throws(
    () => linkApplicationPosting(db, { applicationId: application.lastInsertRowid, postingId: otherPosting.id }),
    (error) => error instanceof CatalogError && error.code === 'OPENING_MISMATCH'
  );
  assert.throws(
    () => db.prepare("INSERT INTO application_postings (application_id,job_posting_id,relation) VALUES (?,?,'alternate')").run(application.lastInsertRowid, otherPosting.id),
    /same opening/
  );

  const backend = db.prepare("SELECT id FROM role_types WHERE slug='backend'").get();
  const frontend = db.prepare("SELECT id FROM role_types WHERE slug='frontend'").get();
  db.prepare('INSERT INTO opening_role_types (job_opening_id,role_type_id,is_primary) VALUES (?,?,1)').run(opening.id, backend.id);
  assert.throws(
    () => db.prepare('INSERT INTO opening_role_types (job_opening_id,role_type_id,is_primary) VALUES (?,?,1)').run(opening.id, frontend.id),
    /UNIQUE/
  );
  const senior = db.prepare("SELECT id FROM seniority_levels WHERE slug='senior'").get();
  const staff = db.prepare("SELECT id FROM seniority_levels WHERE slug='staff'").get();
  db.prepare('INSERT INTO opening_seniority_levels (job_opening_id,seniority_level_id,is_primary) VALUES (?,?,1)').run(opening.id, senior.id);
  assert.throws(
    () => db.prepare('INSERT INTO opening_seniority_levels (job_opening_id,seniority_level_id,is_primary) VALUES (?,?,1)').run(opening.id, staff.id),
    /UNIQUE/
  );

  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  db.close();
});

test('catalog URL identity is shared, conservative, and upgrades legacy variants lazily', () => {
  assert.equal(
    canonicalizeCatalogUrl('HTTPS://Example.TEST:443/jobs/42/?b=2&mc_eid=click&a=1&utm_campaign=x#apply'),
    'https://example.test/jobs/42?a=1&b=2'
  );
  assert.notEqual(
    canonicalizeCatalogUrl('https://example.test/jobs/42?department=platform'),
    canonicalizeCatalogUrl('https://example.test/jobs/42?department=hardware'),
    'non-tracking query parameters remain part of posting identity'
  );

  const db = makeV7Db({ seed: false });
  migrateCatalog(db);
  const company = resolveOrCreateCompany(db, 'Legacy URL Co');
  const opening = createOpening(db, { companyId: company.id, title: 'Platform Engineer' });
  const venue = resolveOrCreateVenue(db, {
    platformId: resolvePlatform(db, 'direct').id,
    companyId: company.id,
    venueKey: 'legacy-url-co',
    label: 'Legacy URL Co careers'
  });
  const legacyUrl = 'https://legacy.example.test/jobs/7/?z=9&utm_source=old&a=1';
  const info = db.prepare(`
    INSERT INTO job_postings (
      job_opening_id,posting_venue_id,canonical_url,canonical_url_sha256,state
    ) VALUES (?,?,?,?, 'open')
  `).run(opening.id, venue.id, legacyUrl, 'a'.repeat(64));

  const resolved = resolveOrCreatePosting(db, {
    openingId: opening.id,
    venueId: venue.id,
    url: 'https://legacy.example.test/jobs/7?a=1&z=9&utm_medium=new#top'
  });
  assert.equal(resolved.id, Number(info.lastInsertRowid));
  assert.equal(resolved.canonical_url, 'https://legacy.example.test/jobs/7?a=1&z=9');
  assert.equal(db.prepare('SELECT count(*) count FROM job_postings').get().count, 1);
  db.close();
});

function makeV7Db({ seed = true } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('applied','interviewing','offer','rejected','withdrawn')),
      workflow_stage TEXT NOT NULL,
      applied_date TEXT,
      job_url TEXT,
      notes TEXT,
      status_changed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_opportunity_id INTEGER
    );
    CREATE TABLE discovery_sources (
      id INTEGER PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      adapter TEXT NOT NULL,
      label TEXT NOT NULL,
      base_url TEXT
    );
    CREATE TABLE opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state TEXT NOT NULL,
      company_name TEXT NOT NULL,
      title TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      canonical_url_sha256 TEXT NOT NULL UNIQUE,
      primary_source_id INTEGER REFERENCES discovery_sources(id),
      provider TEXT,
      board_key TEXT,
      external_id TEXT,
      dedupe_fingerprint TEXT NOT NULL,
      posted_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE opportunity_snapshots (
      id INTEGER PRIMARY KEY,
      opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      normalized_text TEXT
    );
    CREATE TABLE opportunity_observations (
      id INTEGER PRIMARY KEY,
      opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      snapshot_id INTEGER REFERENCES opportunity_snapshots(id),
      observed_url TEXT NOT NULL
    );
    CREATE TRIGGER trg_opportunity_snapshots_immutable_update BEFORE UPDATE ON opportunity_snapshots
      BEGIN SELECT RAISE(ABORT, 'opportunity snapshots are immutable'); END;
    CREATE TRIGGER trg_opportunity_observations_immutable_update BEFORE UPDATE ON opportunity_observations
      BEGIN SELECT RAISE(ABORT, 'opportunity observations are immutable'); END;
    CREATE TABLE opportunity_tags (
      opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY(opportunity_id, tag)
    );
    CREATE TABLE profile_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);
    CREATE TABLE profile_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_entry_id INTEGER NOT NULL UNIQUE REFERENCES profile_entries(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      skill_group TEXT
    );
    CREATE TABLE interviews (id INTEGER PRIMARY KEY, application_id INTEGER REFERENCES applications(id));
    CREATE TABLE offers (id INTEGER PRIMARY KEY, application_id INTEGER REFERENCES applications(id));
    PRAGMA user_version=7;
  `);
  if (!seed) return db;
  db.exec(`
    INSERT INTO discovery_sources VALUES (1,'greenhouse-example','greenhouse','Example Greenhouse','https://boards.example.test');
    INSERT INTO opportunities (
      id,state,company_name,title,canonical_url,canonical_url_sha256,primary_source_id,
      provider,board_key,external_id,dedupe_fingerprint,posted_at,first_seen_at,last_seen_at,created_at,updated_at
    ) VALUES
      (1,'inbox','Example Co','Platform Engineer','https://boards.example.test/jobs/1','${'1'.repeat(64)}',1,'greenhouse','example','job-1','fp-same',NULL,'2026-01-01','2026-01-02','2026-01-01','2026-01-02'),
      (2,'inbox','Example Co','Platform Engineer','https://boards.example.test/jobs/2','${'2'.repeat(64)}',1,'greenhouse','example','job-2','fp-same',NULL,'2026-01-01','2026-01-02','2026-01-01','2026-01-02');
    INSERT INTO opportunity_snapshots VALUES (1,1,'one'),(2,2,'two');
    INSERT INTO opportunity_observations VALUES (1,1,1,'https://boards.example.test/jobs/1'),(2,2,2,'https://boards.example.test/jobs/2');
    INSERT INTO opportunity_tags VALUES (1,'platform'),(2,'platform');
    INSERT INTO applications (
      id,company,role,status,workflow_stage,job_url,status_changed_at,created_at,updated_at,source_opportunity_id
    ) VALUES
      (1,'Example Co','Platform Engineer','interviewing','submitted','https://boards.example.test/jobs/1','2026-01-10','2026-01-03','2026-01-10',1),
      (2,'Example Co','Platform Engineer','offer','submitted','https://boards.example.test/jobs/1','2026-01-11','2026-01-04','2026-01-11',NULL);
    INSERT INTO profile_entries VALUES (1,'Python'),(2,'python');
    INSERT INTO profile_skills VALUES (1,1,'Python','Languages'),(2,2,'python','languages');
  `);
  return db;
}

function catalogCounts(db) {
  return Object.fromEntries(REQUIRED_TABLES.map((table) => [table, db.prepare(`SELECT count(*) count FROM ${table}`).get().count]));
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function assertForeignKey(db, table, column, target) {
  assert.ok(
    db.pragma(`foreign_key_list(${table})`).some((row) => row.from === column && row.table === target),
    `${table}.${column} must reference ${target}`
  );
}
