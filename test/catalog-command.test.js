'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const { migrateCatalog } = require('../lib/catalog');
const {
  CatalogCommandError,
  runCatalogCommand,
  syncLegacyApplicationCatalog,
  syncLegacyOpportunityCatalog
} = require('../lib/catalog-command');

test('catalog dispatcher is strict and company identity operations are exact and idempotent', () => {
  const db = makeDb();
  assert.throws(() => runCatalogCommand(db, ['unknown'], {}), errorCode('UNKNOWN_COMMAND'));
  assert.throws(() => runCatalogCommand(db, ['company', 'list'], { fuzzy: true }), errorCode('INVALID_ARGUMENT'));
  assert.throws(() => runCatalogCommand(db, ['opening', 'show'], { openingId: '1oops' }), errorCode('VALIDATION_ERROR'));
  assert.throws(
    () => runCatalogCommand(db, ['opening', 'create'], { companyId: 1, company: 'Other', title: 'Engineer' }),
    errorCode('INVALID_ARGUMENT')
  );

  const first = command(db, 'company upsert', { name: 'Example Co', websiteDomain: 'example.test' }).company;
  const replay = command(db, 'company upsert', { name: '  example   co ' }).company;
  assert.equal(replay.id, first.id);
  command(db, 'company alias', { companyId: first.id, alias: 'Example Incorporated' });
  const byAlias = command(db, 'company show', { name: 'example incorporated' }).company;
  assert.equal(byAlias.id, first.id);
  assert.equal(command(db, 'companies list', { text: 'Incorporated' }).companies.length, 1);
  assert.equal(db.prepare('SELECT count(*) count FROM companies').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) count FROM company_aliases').get().count, 2);
  db.close();
});

test('commands preserve cross-posting, classifications, skill requirements, exact filters, and mismatch guards', () => {
  const db = makeDb();
  const company = command(db, 'company upsert', { name: 'Systems Lab' }).company;
  const opening = command(db, 'opening create', {
    companyId: company.id, title: 'Senior Platform Engineer', status: 'open',
    identifierNamespace: 'company-requisition', identifierValue: 'REQ-42'
  }).opening;
  const replay = command(db, 'opening create', {
    companyId: company.id, title: 'Senior Platform Engineer', status: 'open',
    identifierNamespace: 'company-requisition', identifierValue: 'REQ-42'
  }).opening;
  assert.equal(replay.id, opening.id);
  const distinct = command(db, 'opening create', { companyId: company.id, title: 'Senior Platform Engineer', status: 'open' }).opening;
  assert.notEqual(distinct.id, opening.id, 'same-title openings are not fuzzy merged');

  const direct = command(db, 'posting create', {
    openingId: opening.id, platform: 'direct', venueKey: 'careers.systems.test',
    url: 'https://careers.systems.test/jobs/42', externalId: 'REQ-42', state: 'open'
  }).posting;
  const directReplay = command(db, 'posting create', {
    openingId: opening.id, platform: 'direct', venueKey: 'careers.systems.test',
    url: 'https://careers.systems.test/jobs/42?utm_source=agent', externalId: 'REQ-42', state: 'open'
  }).posting;
  assert.equal(directReplay.id, direct.id);
  const linkedin = command(db, 'posting create', {
    openingId: opening.id, platform: 'linkedin', venueKey: 'systems-lab',
    url: 'https://linkedin.example/jobs/900', externalId: '900', state: 'open'
  }).posting;
  assert.notEqual(linkedin.id, direct.id);
  const otherPosting = command(db, 'posting create', {
    openingId: distinct.id, platform: 'direct', venueKey: 'careers.systems.test',
    url: 'https://careers.systems.test/jobs/43', externalId: 'REQ-43', state: 'open'
  }).posting;

  command(db, 'role-type assign', { openingId: opening.id, roleType: 'platform', primary: true, confidence: 1 });
  command(db, 'seniority assign', { openingId: opening.id, seniority: 'senior', primary: true, confidence: 1 });
  const skill = command(db, 'skill upsert', {
    name: 'Node.js', category: 'platforms', aliases: ['Node', 'nodejs']
  }).skill;
  const skillReplay = command(db, 'skill upsert', { name: 'node.js', category: 'platforms', aliases: 'Node,nodejs' }).skill;
  assert.equal(skillReplay.id, skill.id);
  const required = command(db, 'posting add-skill-requirement', {
    postingId: direct.id, skillId: skill.id, requirementKind: 'required', rawPhrase: 'Node.js required', confidence: 0.99
  }).requirement;
  const requiredReplay = command(db, 'posting add-skill-requirement', {
    postingId: direct.id, skill: 'Node', requirementKind: 'required', rawPhrase: 'Strong Node.js', minimumYears: 3
  }).requirement;
  assert.equal(requiredReplay.id, required.id);
  command(db, 'posting add-skill-requirement', {
    postingId: linkedin.id, skill: 'nodejs', requirementKind: 'preferred', rawPhrase: 'Node.js preferred'
  });

  assert.deepEqual(command(db, 'opening list', { company: 'systems lab', roleType: 'platform' }).openings.map((row) => row.id), [opening.id]);
  assert.deepEqual(command(db, 'opening list', { seniority: 'senior', skill: 'Node' }).openings.map((row) => row.id), [opening.id]);
  assert.deepEqual(command(db, 'opening list', { openingId: distinct.id }).openings.map((row) => row.id), [distinct.id]);
  assert.deepEqual(command(db, 'posting list', { skill: 'nodejs', requirementKind: 'required' }).postings.map((row) => row.id), [direct.id]);
  assert.equal(command(db, 'posting show', { postingId: linkedin.id }).posting.skillRequirements[0].requirement_kind, 'preferred');
  assert.equal(command(db, 'taxonomy list', { type: 'role-types' }).roleTypes.some((row) => row.slug === 'platform'), true);
  assert.equal(command(db, 'taxonomy list', { type: 'requirement-kinds' }).requirementKinds.length, 3);

  const application = insertApplication(db, { company: 'Systems Lab', role: 'Senior Platform Engineer', openingId: opening.id });
  command(db, 'posting link-application', {
    applicationId: application.id, postingId: direct.id, relation: 'submitted_via', primary: true
  });
  command(db, 'posting link-application', {
    applicationId: application.id, postingId: linkedin.id, relation: 'alternate', primary: true
  });
  command(db, 'posting link-application', {
    applicationId: application.id, postingId: linkedin.id, relation: 'submitted_via'
  });
  assert.equal(db.prepare('SELECT count(*) count FROM application_postings WHERE application_id=? AND is_primary=1').get(application.id).count, 1);
  assert.equal(db.prepare('SELECT primary_job_posting_id FROM applications WHERE id=?').get(application.id).primary_job_posting_id, linkedin.id);
  assert.throws(
    () => command(db, 'posting link-application', { applicationId: application.id, postingId: otherPosting.id }),
    errorCode('OPENING_MISMATCH')
  );
  assert.throws(
    () => command(db, 'posting add-skill-requirement', { postingId: direct.id, skill: 'missing', requirementKind: 'required' }),
    errorCode('NOT_FOUND')
  );

  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  db.close();
});

test('dual-write helpers link exact legacy identities and fail closed on wrong write order', () => {
  const db = makeDb();
  db.prepare(`
    INSERT INTO discovery_sources (id,source_key,adapter,label,base_url)
    VALUES (1,'greenhouse-durable','greenhouse','Durable Greenhouse','https://boards.example.test')
  `).run();
  const opportunityId = db.prepare(`
    INSERT INTO opportunities (
      state,company_name,title,canonical_url,canonical_url_sha256,primary_source_id,
      provider,board_key,external_id,dedupe_fingerprint,first_seen_at,last_seen_at,created_at,updated_at
    ) VALUES ('inbox','Durable Co','Backend Engineer','https://boards.example.test/jobs/77',?,1,
      'greenhouse','durable','77','fp-77','2026-01-01','2026-01-02','2026-01-01','2026-01-02')
  `).run('7'.repeat(64)).lastInsertRowid;
  const first = syncLegacyOpportunityCatalog(db, opportunityId);
  const second = syncLegacyOpportunityCatalog(db, opportunityId);
  assert.equal(second.opening.id, first.opening.id);
  assert.equal(second.posting.id, first.posting.id);
  assert.equal(first.evidenceLink.jobPostingId, first.posting.id);

  db.prepare('INSERT INTO opportunity_snapshots (id,opportunity_id,normalized_text,job_posting_id) VALUES (1,?,?,?)')
    .run(opportunityId, 'posting', first.posting.id);
  db.prepare('INSERT INTO opportunity_observations (id,opportunity_id,snapshot_id,observed_url,job_posting_id) VALUES (1,?,?,?,?)')
    .run(opportunityId, 1, 'https://boards.example.test/jobs/77', first.posting.id);

  const application = insertApplication(db, {
    company: 'Durable Co', role: 'Backend Engineer', sourceOpportunityId: opportunityId,
    status: 'interviewing', jobUrl: 'https://boards.example.test/jobs/77'
  });
  const linked = syncLegacyApplicationCatalog(db, application.id);
  const linkedReplay = syncLegacyApplicationCatalog(db, application.id);
  assert.equal(linked.opening.id, first.opening.id);
  assert.equal(linked.posting.id, first.posting.id);
  assert.equal(linkedReplay.posting.id, first.posting.id);
  assert.equal(db.prepare('SELECT count(*) count FROM application_status_events WHERE application_id=?').get(application.id).count, 1);

  const lateOpportunityId = db.prepare(`
    INSERT INTO opportunities (
      state,company_name,title,canonical_url,canonical_url_sha256,dedupe_fingerprint,
      first_seen_at,last_seen_at,created_at,updated_at
    ) VALUES ('inbox','Late Co','Engineer','https://late.example/jobs/1',?,'late-fp',
      '2026-01-01','2026-01-02','2026-01-01','2026-01-02')
  `).run('8'.repeat(64)).lastInsertRowid;
  db.prepare('INSERT INTO opportunity_snapshots (id,opportunity_id,normalized_text) VALUES (2,?,?)').run(lateOpportunityId, 'already immutable');
  assert.throws(() => syncLegacyOpportunityCatalog(db, lateOpportunityId), errorCode('WRITE_ORDER_CONFLICT'));
  assert.equal(db.prepare('SELECT job_opening_id FROM opportunities WHERE id=?').get(lateOpportunityId).job_opening_id, null);

  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

function command(db, route, flags = {}) {
  return runCatalogCommand(db, ['catalog', ...route.split(' ')], flags);
}

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT NOT NULL, role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'applied', workflow_stage TEXT NOT NULL DEFAULT 'submitted',
      applied_date TEXT, job_url TEXT, notes TEXT, status_changed_at TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source_opportunity_id INTEGER
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
    CREATE TABLE profile_skills (id INTEGER PRIMARY KEY, name TEXT NOT NULL, skill_group TEXT);
  `);
  migrateCatalog(db);
  return db;
}

function insertApplication(db, input) {
  const info = db.prepare(`
    INSERT INTO applications (
      company,role,status,workflow_stage,job_url,status_changed_at,created_at,updated_at,
      source_opportunity_id,job_opening_id
    ) VALUES (?,?,?,'submitted',?,'2026-01-10','2026-01-01','2026-01-10',?,?)
  `).run(
    input.company, input.role, input.status || 'applied', input.jobUrl || null,
    input.sourceOpportunityId || null, input.openingId || null
  );
  return db.prepare('SELECT * FROM applications WHERE id=?').get(info.lastInsertRowid);
}

function errorCode(code) {
  return (error) => error instanceof CatalogCommandError && error.code === code;
}
