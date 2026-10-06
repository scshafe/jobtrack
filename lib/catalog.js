'use strict';

const crypto = require('node:crypto');

const CATALOG_SCHEMA_VERSION = 2026071708;
const CATALOG_USER_VERSION = 8;
const URL_TRACKING_PARAMETERS = new Set([
  'gclid', 'dclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid'
]);

const PLATFORM_SEEDS = [
  ['direct', 'Direct company careers', 'company'],
  ['linkedin', 'LinkedIn', 'job_board'],
  ['greenhouse', 'Greenhouse', 'ats'],
  ['ashby', 'Ashby', 'ats'],
  ['lever', 'Lever', 'ats'],
  ['wellfound', 'Wellfound', 'job_board'],
  ['indeed', 'Indeed', 'job_board'],
  ['remoteok', 'Remote OK', 'job_board'],
  ['hn', 'Hacker News', 'community'],
  ['rss', 'RSS/Atom feed', 'feed'],
  ['api', 'Public API', 'api'],
  ['other', 'Other', 'other']
];

const ROLE_TYPE_SEEDS = [
  ['engineering', 'Engineering', null],
  ['software-engineering', 'Software Engineering', 'engineering'],
  ['hardware-engineering', 'Hardware Engineering', 'engineering'],
  ['backend', 'Backend', 'software-engineering'],
  ['frontend', 'Frontend', 'software-engineering'],
  ['fullstack', 'Full-stack', 'software-engineering'],
  ['platform', 'Platform', 'software-engineering'],
  ['infrastructure', 'Infrastructure', 'software-engineering'],
  ['developer-productivity', 'Developer Productivity', 'software-engineering'],
  ['solutions-engineering', 'Solutions Engineering', 'software-engineering'],
  ['forward-deployed', 'Forward Deployed', 'software-engineering'],
  ['machine-learning', 'Machine Learning', 'software-engineering'],
  ['data-engineering', 'Data Engineering', 'software-engineering'],
  ['fpga', 'FPGA', 'hardware-engineering']
];

const SENIORITY_SEEDS = [
  ['intern', 'Intern', 10, 'general'],
  ['junior', 'Junior / Entry', 20, 'general'],
  ['regular', 'Regular / Mid-level', 30, 'general'],
  ['senior', 'Senior', 40, 'general'],
  ['lead', 'Lead', 45, 'general'],
  ['staff', 'Staff', 50, 'individual_contributor'],
  ['senior-staff', 'Senior Staff', 60, 'individual_contributor'],
  ['principal', 'Principal', 70, 'individual_contributor'],
  ['distinguished', 'Distinguished', 80, 'individual_contributor'],
  ['manager', 'Manager', 50, 'management'],
  ['director', 'Director', 70, 'management'],
  ['vice-president', 'Vice President', 90, 'management']
];

const SKILL_CATEGORY_SEEDS = [
  ['languages', 'Languages'],
  ['frameworks', 'Frameworks and libraries'],
  ['databases', 'Databases'],
  ['cloud', 'Cloud platforms'],
  ['infrastructure', 'Infrastructure'],
  ['platforms', 'Platforms'],
  ['data', 'Data'],
  ['concepts', 'Concepts'],
  ['tools', 'Tools'],
  ['other', 'Other']
];

const REQUIREMENT_KIND_SEEDS = [
  ['required', 'Required', 30],
  ['preferred', 'Preferred', 20],
  ['mentioned', 'Mentioned', 10]
];

class CatalogError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
    this.details = details;
  }
}

function migrateCatalog(db) {
  const apply = () => {
    createCatalogSchema(db);
    addLegacyLinkColumns(db);
    createOpportunityAvailabilityTriggers(db);
    seedCatalogTaxonomies(db);
    backfillCatalog(db);
    const migration = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?').get(CATALOG_SCHEMA_VERSION);
    if (migration && migration.name !== 'normalized_job_catalog') {
      throw new CatalogError('MIGRATION_CONFLICT', `Schema version ${CATALOG_SCHEMA_VERSION} is already named ${migration.name}`);
    }
    if (!migration) {
      db.prepare(`
        INSERT INTO jobtrack_schema_migrations (version, name)
        VALUES (?, 'normalized_job_catalog')
      `).run(CATALOG_SCHEMA_VERSION);
    }
    const currentVersion = db.pragma('user_version', { simple: true });
    if (currentVersion < CATALOG_USER_VERSION) db.pragma(`user_version = ${CATALOG_USER_VERSION}`);
  };
  if (db.inTransaction) apply();
  else db.transaction(apply).immediate();
}

function createCatalogSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobtrack_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      website_domain TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(canonical_name) <> ''),
      CHECK (trim(normalized_name) <> '')
    );

    CREATE TABLE IF NOT EXISTS company_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL UNIQUE,
      alias_kind TEXT NOT NULL DEFAULT 'name',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(alias) <> ''),
      CHECK (trim(normalized_alias) <> ''),
      UNIQUE(company_id, normalized_alias)
    );

    CREATE TABLE IF NOT EXISTS job_openings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      canonical_title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','open','closed')),
      origin_kind TEXT NOT NULL DEFAULT 'manual' CHECK (origin_kind IN ('manual','opportunity','application')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(canonical_title) <> ''),
      CHECK (trim(normalized_title) <> '')
    );

    CREATE TABLE IF NOT EXISTS opening_identifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_opening_id INTEGER NOT NULL REFERENCES job_openings(id) ON DELETE CASCADE,
      namespace TEXT NOT NULL,
      identifier_value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(namespace) <> ''),
      CHECK (trim(identifier_value) <> ''),
      UNIQUE(namespace, identifier_value),
      UNIQUE(job_opening_id, namespace, identifier_value)
    );

    CREATE TABLE IF NOT EXISTS posting_platforms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      platform_kind TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(slug) <> ''),
      CHECK (trim(name) <> '')
    );

    CREATE TABLE IF NOT EXISTS posting_venues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      posting_platform_id INTEGER NOT NULL REFERENCES posting_platforms(id) ON DELETE RESTRICT,
      company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      venue_key TEXT NOT NULL,
      label TEXT NOT NULL,
      board_key TEXT,
      base_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(venue_key) <> ''),
      CHECK (trim(label) <> ''),
      UNIQUE(posting_platform_id, venue_key)
    );

    CREATE TABLE IF NOT EXISTS job_postings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_opening_id INTEGER NOT NULL REFERENCES job_openings(id) ON DELETE RESTRICT,
      posting_venue_id INTEGER NOT NULL REFERENCES posting_venues(id) ON DELETE RESTRICT,
      canonical_url TEXT NOT NULL,
      canonical_url_sha256 TEXT NOT NULL UNIQUE CHECK (length(canonical_url_sha256) = 64),
      external_id TEXT,
      state TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('unknown','open','closed','removed')),
      posted_at TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(canonical_url) <> ''),
      UNIQUE(posting_venue_id, external_id)
    );

    CREATE TABLE IF NOT EXISTS application_postings (
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      job_posting_id INTEGER NOT NULL REFERENCES job_postings(id) ON DELETE RESTRICT,
      relation TEXT NOT NULL CHECK (relation IN ('discovered_via','submitted_via','alternate')),
      is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(application_id, job_posting_id)
    );

    CREATE TABLE IF NOT EXISTS role_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      parent_role_type_id INTEGER REFERENCES role_types(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(slug) <> ''),
      CHECK (trim(label) <> '')
    );

    CREATE TABLE IF NOT EXISTS opening_role_types (
      job_opening_id INTEGER NOT NULL REFERENCES job_openings(id) ON DELETE CASCADE,
      role_type_id INTEGER NOT NULL REFERENCES role_types(id) ON DELETE RESTRICT,
      is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
      source TEXT NOT NULL DEFAULT 'manual',
      confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      evidence_snapshot_id INTEGER REFERENCES opportunity_snapshots(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(job_opening_id, role_type_id)
    );

    CREATE TABLE IF NOT EXISTS seniority_levels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      sort_rank INTEGER NOT NULL,
      career_track TEXT NOT NULL DEFAULT 'general',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(slug) <> ''),
      CHECK (trim(label) <> '')
    );

    CREATE TABLE IF NOT EXISTS opening_seniority_levels (
      job_opening_id INTEGER NOT NULL REFERENCES job_openings(id) ON DELETE CASCADE,
      seniority_level_id INTEGER NOT NULL REFERENCES seniority_levels(id) ON DELETE RESTRICT,
      is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
      source TEXT NOT NULL DEFAULT 'manual',
      confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      evidence_snapshot_id INTEGER REFERENCES opportunity_snapshots(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(job_opening_id, seniority_level_id)
    );

    CREATE TABLE IF NOT EXISTS skill_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(slug) <> ''),
      CHECK (trim(label) <> '')
    );

    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_category_id INTEGER NOT NULL REFERENCES skill_categories(id) ON DELETE RESTRICT,
      slug TEXT NOT NULL UNIQUE,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(slug) <> ''),
      CHECK (trim(canonical_name) <> ''),
      CHECK (trim(normalized_name) <> '')
    );

    CREATE TABLE IF NOT EXISTS skill_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(alias) <> ''),
      CHECK (trim(normalized_alias) <> ''),
      UNIQUE(skill_id, normalized_alias)
    );

    CREATE TABLE IF NOT EXISTS profile_skill_catalog_links (
      profile_skill_id INTEGER PRIMARY KEY REFERENCES profile_skills(id) ON DELETE CASCADE,
      skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS requirement_kinds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      sort_rank INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(slug) <> ''),
      CHECK (trim(label) <> '')
    );

    CREATE TABLE IF NOT EXISTS posting_skill_requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_posting_id INTEGER NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
      opportunity_snapshot_id INTEGER REFERENCES opportunity_snapshots(id) ON DELETE CASCADE,
      skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
      requirement_kind_id INTEGER NOT NULL REFERENCES requirement_kinds(id) ON DELETE RESTRICT,
      raw_phrase TEXT,
      minimum_years REAL CHECK (minimum_years IS NULL OR minimum_years >= 0),
      confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS application_status_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      from_status TEXT CHECK (from_status IS NULL OR from_status IN ('applied','interviewing','offer','rejected','withdrawn')),
      to_status TEXT NOT NULL CHECK (to_status IN ('applied','interviewing','offer','rejected','withdrawn')),
      event_kind TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT,
      evidence_incomplete INTEGER NOT NULL DEFAULT 0 CHECK (evidence_incomplete IN (0,1)),
      occurred_at TEXT NOT NULL,
      notes TEXT,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(event_kind) <> ''),
      CHECK (trim(source) <> '')
    );

    CREATE INDEX IF NOT EXISTS idx_company_aliases_company ON company_aliases(company_id);
    CREATE INDEX IF NOT EXISTS idx_job_openings_company ON job_openings(company_id, normalized_title);
    CREATE INDEX IF NOT EXISTS idx_job_postings_opening ON job_postings(job_opening_id);
    CREATE INDEX IF NOT EXISTS idx_job_postings_venue ON job_postings(posting_venue_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_application_postings_one_primary
      ON application_postings(application_id) WHERE is_primary=1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_opening_role_types_one_primary
      ON opening_role_types(job_opening_id) WHERE is_primary=1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_opening_seniority_one_primary
      ON opening_seniority_levels(job_opening_id) WHERE is_primary=1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_posting_skill_snapshot
      ON posting_skill_requirements(job_posting_id, opportunity_snapshot_id, skill_id)
      WHERE opportunity_snapshot_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_posting_skill_manual
      ON posting_skill_requirements(job_posting_id, skill_id)
      WHERE opportunity_snapshot_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_application_status_events_application
      ON application_status_events(application_id, occurred_at, id);

    CREATE TRIGGER IF NOT EXISTS trg_application_posting_opening_insert
    BEFORE INSERT ON application_postings
    WHEN NOT EXISTS (
      SELECT 1 FROM applications a
      JOIN job_postings p ON p.id=NEW.job_posting_id
      WHERE a.id=NEW.application_id AND a.job_opening_id=p.job_opening_id
    )
    BEGIN SELECT RAISE(ABORT, 'application and posting must belong to the same opening'); END;

    CREATE TRIGGER IF NOT EXISTS trg_application_posting_opening_update
    BEFORE UPDATE OF application_id, job_posting_id ON application_postings
    WHEN NOT EXISTS (
      SELECT 1 FROM applications a
      JOIN job_postings p ON p.id=NEW.job_posting_id
      WHERE a.id=NEW.application_id AND a.job_opening_id=p.job_opening_id
    )
    BEGIN SELECT RAISE(ABORT, 'application and posting must belong to the same opening'); END;

    CREATE TRIGGER IF NOT EXISTS trg_application_posting_primary_insert
    AFTER INSERT ON application_postings
    WHEN NEW.is_primary=1
    BEGIN
      UPDATE applications SET primary_job_posting_id=NEW.job_posting_id
      WHERE id=NEW.application_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_application_posting_primary_update
    AFTER UPDATE OF is_primary, job_posting_id ON application_postings
    WHEN NEW.is_primary=1
    BEGIN
      UPDATE applications SET primary_job_posting_id=NEW.job_posting_id
      WHERE id=NEW.application_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_application_posting_primary_demote
    AFTER UPDATE OF is_primary ON application_postings
    WHEN OLD.is_primary=1 AND NEW.is_primary=0
    BEGIN
      UPDATE applications SET primary_job_posting_id=NULL
      WHERE id=OLD.application_id AND primary_job_posting_id=OLD.job_posting_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_application_posting_primary_delete
    AFTER DELETE ON application_postings
    WHEN OLD.is_primary=1
    BEGIN
      UPDATE applications SET primary_job_posting_id=NULL
      WHERE id=OLD.application_id AND primary_job_posting_id=OLD.job_posting_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_posting_skill_snapshot_insert
    BEFORE INSERT ON posting_skill_requirements
    WHEN NEW.opportunity_snapshot_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM opportunity_snapshots s
      WHERE s.id=NEW.opportunity_snapshot_id AND s.job_posting_id=NEW.job_posting_id
    )
    BEGIN SELECT RAISE(ABORT, 'skill requirement snapshot must belong to the same posting'); END;

    CREATE TRIGGER IF NOT EXISTS trg_posting_skill_snapshot_update
    BEFORE UPDATE OF job_posting_id, opportunity_snapshot_id ON posting_skill_requirements
    WHEN NEW.opportunity_snapshot_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM opportunity_snapshots s
      WHERE s.id=NEW.opportunity_snapshot_id AND s.job_posting_id=NEW.job_posting_id
    )
    BEGIN SELECT RAISE(ABORT, 'skill requirement snapshot must belong to the same posting'); END;

    CREATE TRIGGER IF NOT EXISTS trg_application_status_events_immutable_update
    BEFORE UPDATE ON application_status_events
    BEGIN SELECT RAISE(ABORT, 'application status events are append-only'); END;

    CREATE TRIGGER IF NOT EXISTS trg_application_status_events_immutable_delete
    BEFORE DELETE ON application_status_events
    BEGIN SELECT RAISE(ABORT, 'application status events are append-only'); END;
  `);
}

function addLegacyLinkColumns(db) {
  ensureColumn(db, 'opportunities', 'job_opening_id', 'INTEGER REFERENCES job_openings(id) ON DELETE RESTRICT');
  ensureColumn(db, 'opportunities', 'primary_job_posting_id', 'INTEGER REFERENCES job_postings(id) ON DELETE RESTRICT');
  ensureColumn(db, 'applications', 'job_opening_id', 'INTEGER REFERENCES job_openings(id) ON DELETE RESTRICT');
  ensureColumn(db, 'applications', 'primary_job_posting_id', 'INTEGER REFERENCES job_postings(id) ON DELETE RESTRICT');
  ensureColumn(db, 'opportunity_snapshots', 'job_posting_id', 'INTEGER REFERENCES job_postings(id) ON DELETE RESTRICT');
  ensureColumn(db, 'opportunity_observations', 'job_posting_id', 'INTEGER REFERENCES job_postings(id) ON DELETE RESTRICT');
}

function createOpportunityAvailabilityTriggers(db) {
  if (!tableExists(db, 'opportunities')
      || !columnExists(db, 'opportunities', 'job_opening_id')
      || !columnExists(db, 'opportunities', 'primary_job_posting_id')) return;
  db.exec(`
    DROP TRIGGER IF EXISTS trg_opportunity_catalog_availability_insert;
    DROP TRIGGER IF EXISTS trg_opportunity_catalog_availability_update;
    DROP TRIGGER IF EXISTS trg_opportunity_catalog_availability_delete;

    CREATE TRIGGER IF NOT EXISTS trg_opportunity_catalog_availability_insert
    AFTER INSERT ON opportunities
    WHEN NEW.job_opening_id IS NOT NULL
    BEGIN
      UPDATE job_postings SET
        state=CASE WHEN EXISTS (
          SELECT 1 FROM opportunities support
          WHERE support.primary_job_posting_id=job_postings.id
            AND support.state<>'closed'
        ) THEN 'open' ELSE 'closed' END,
        updated_at=COALESCE(NEW.updated_at, datetime('now'))
      WHERE id=NEW.primary_job_posting_id;

      UPDATE job_openings SET
        status=CASE WHEN
          EXISTS (
            SELECT 1 FROM job_postings posting
            WHERE posting.job_opening_id=job_openings.id
              AND posting.state IN ('unknown','open')
          ) OR EXISTS (
            SELECT 1 FROM opportunities support
            WHERE support.job_opening_id=job_openings.id
              AND support.state<>'closed'
          )
          THEN 'open' ELSE 'closed' END,
        updated_at=COALESCE(NEW.updated_at, datetime('now'))
      WHERE id=NEW.job_opening_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_opportunity_catalog_availability_update
    AFTER UPDATE OF state, job_opening_id, primary_job_posting_id ON opportunities
    BEGIN
      UPDATE job_postings SET
        state=CASE WHEN EXISTS (
          SELECT 1 FROM opportunities support
          WHERE support.primary_job_posting_id=job_postings.id
            AND support.state<>'closed'
        ) THEN 'open' ELSE 'closed' END,
        updated_at=COALESCE(NEW.updated_at, datetime('now'))
      WHERE id IN (OLD.primary_job_posting_id, NEW.primary_job_posting_id);

      UPDATE job_openings SET
        status=CASE WHEN
          EXISTS (
            SELECT 1 FROM job_postings posting
            WHERE posting.job_opening_id=job_openings.id
              AND posting.state IN ('unknown','open')
          ) OR EXISTS (
            SELECT 1 FROM opportunities support
            WHERE support.job_opening_id=job_openings.id
              AND support.state<>'closed'
          )
          THEN 'open' ELSE 'closed' END,
        updated_at=COALESCE(NEW.updated_at, datetime('now'))
      WHERE id IN (OLD.job_opening_id, NEW.job_opening_id);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_opportunity_catalog_availability_delete
    AFTER DELETE ON opportunities
    WHEN OLD.job_opening_id IS NOT NULL
    BEGIN
      UPDATE job_postings SET
        state=CASE WHEN EXISTS (
          SELECT 1 FROM opportunities support
          WHERE support.primary_job_posting_id=job_postings.id
            AND support.state<>'closed'
        ) THEN 'open' ELSE 'closed' END,
        updated_at=datetime('now')
      WHERE id=OLD.primary_job_posting_id;

      UPDATE job_openings SET
        status=CASE WHEN
          EXISTS (
            SELECT 1 FROM job_postings posting
            WHERE posting.job_opening_id=job_openings.id
              AND posting.state IN ('unknown','open')
          ) OR EXISTS (
            SELECT 1 FROM opportunities support
            WHERE support.job_opening_id=job_openings.id
              AND support.state<>'closed'
          )
          THEN 'open' ELSE 'closed' END,
        updated_at=datetime('now')
      WHERE id=OLD.job_opening_id;
    END;
  `);
}

function seedCatalogTaxonomies(db) {
  const insertPlatform = db.prepare(`
    INSERT INTO posting_platforms (slug, name, platform_kind) VALUES (?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET name=excluded.name, platform_kind=excluded.platform_kind
  `);
  for (const seed of PLATFORM_SEEDS) insertPlatform.run(...seed);

  const insertRoleType = db.prepare(`
    INSERT INTO role_types (slug, label, parent_role_type_id) VALUES (?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET label=excluded.label, parent_role_type_id=excluded.parent_role_type_id
  `);
  for (const [slug, label, parentSlug] of ROLE_TYPE_SEEDS) {
    const parent = parentSlug ? db.prepare('SELECT id FROM role_types WHERE slug=?').get(parentSlug) : null;
    insertRoleType.run(slug, label, parent ? parent.id : null);
  }

  const insertSeniority = db.prepare(`
    INSERT INTO seniority_levels (slug, label, sort_rank, career_track) VALUES (?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET label=excluded.label, sort_rank=excluded.sort_rank, career_track=excluded.career_track
  `);
  for (const seed of SENIORITY_SEEDS) insertSeniority.run(...seed);

  const insertSkillCategory = db.prepare(`
    INSERT INTO skill_categories (slug, label) VALUES (?, ?)
    ON CONFLICT(slug) DO UPDATE SET label=excluded.label
  `);
  for (const seed of SKILL_CATEGORY_SEEDS) insertSkillCategory.run(...seed);

  const insertRequirement = db.prepare(`
    INSERT INTO requirement_kinds (slug, label, sort_rank) VALUES (?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET label=excluded.label, sort_rank=excluded.sort_rank
  `);
  for (const seed of REQUIREMENT_KIND_SEEDS) insertRequirement.run(...seed);
}

function backfillCatalog(db) {
  const opportunityRows = tableExists(db, 'opportunities')
    ? db.prepare('SELECT * FROM opportunities ORDER BY id').all()
    : [];
  const immutableRelink = opportunityRows.length && (
    countNullLinks(db, 'opportunity_snapshots') > 0 || countNullLinks(db, 'opportunity_observations') > 0
  );
  if (immutableRelink) dropOpportunityUpdateGuards(db);
  try {
    for (const opportunity of opportunityRows) backfillOpportunity(db, opportunity);
  } finally {
    // Reassert known guards even on an already-linked replay so a copied or
    // partially repaired v7 store cannot silently lose immutability.
    restoreOpportunityUpdateGuards(db);
  }

  if (tableExists(db, 'applications')) {
    for (const application of db.prepare('SELECT * FROM applications ORDER BY id').all()) {
      backfillApplication(db, application);
      ensureImportedStatusEvent(db, application);
    }
  }

  if (tableExists(db, 'profile_skills')) {
    for (const profileSkill of db.prepare('SELECT * FROM profile_skills ORDER BY id').all()) {
      linkProfileSkill(db, profileSkill);
    }
  }
}

function backfillOpportunity(db, opportunity) {
  let openingId = opportunity.job_opening_id || null;
  const legacyIdentifier = resolveOpeningIdentifier(db, 'legacy-opportunity', String(opportunity.id));
  if (openingId && legacyIdentifier && legacyIdentifier.id !== openingId) {
    throw new CatalogError('MIGRATION_CONFLICT', `Opportunity ${opportunity.id} resolves to two openings`);
  }
  if (!openingId) openingId = legacyIdentifier ? legacyIdentifier.id : null;
  if (!openingId) {
    const company = resolveOrCreateCompany(db, requiredText(opportunity.company_name, 'opportunity company'));
    const opening = createOpening(db, {
      companyId: company.id,
      title: requiredText(opportunity.title, 'opportunity title'),
      status: opportunity.state === 'closed' ? 'closed' : 'open',
      originKind: 'opportunity',
      identifierNamespace: 'legacy-opportunity',
      identifierValue: String(opportunity.id)
    });
    openingId = opening.id;
  } else {
    ensureOpeningIdentifier(db, openingId, 'legacy-opportunity', String(opportunity.id));
  }
  db.prepare('UPDATE opportunities SET job_opening_id=? WHERE id=?').run(openingId, opportunity.id);

  const company = db.prepare(`
    SELECT c.* FROM job_openings jo JOIN companies c ON c.id=jo.company_id WHERE jo.id=?
  `).get(openingId);
  const source = tableExists(db, 'discovery_sources') && opportunity.primary_source_id
    ? db.prepare('SELECT * FROM discovery_sources WHERE id=?').get(opportunity.primary_source_id)
    : null;
  const provider = optionalText(opportunity.provider) || optionalText(source && source.adapter) || inferPlatformSlug(opportunity.canonical_url);
  const platform = resolvePlatform(db, provider);
  const venueKey = optionalText(opportunity.board_key)
    || optionalText(source && source.source_key)
    || urlHostname(opportunity.canonical_url)
    || `legacy-opportunity-${opportunity.id}`;
  const venue = resolveOrCreateVenue(db, {
    platformId: platform.id,
    companyId: company.id,
    venueKey,
    label: optionalText(source && source.label) || `${company.canonical_name} on ${platform.name}`,
    boardKey: optionalText(opportunity.board_key),
    baseUrl: optionalText(source && source.base_url)
  });
  const posting = resolveOrCreatePosting(db, {
    openingId,
    venueId: venue.id,
    url: requiredText(opportunity.canonical_url, 'opportunity canonical URL'),
    externalId: optionalText(opportunity.external_id),
    state: opportunity.state === 'closed' ? 'closed' : 'open',
    postedAt: optionalText(opportunity.posted_at),
    firstSeenAt: optionalText(opportunity.first_seen_at),
    lastSeenAt: optionalText(opportunity.last_seen_at)
  });
  db.prepare(`
    UPDATE opportunities SET job_opening_id=?, primary_job_posting_id=? WHERE id=?
  `).run(openingId, posting.id, opportunity.id);
  if (tableExists(db, 'opportunity_snapshots')) {
    db.prepare(`UPDATE opportunity_snapshots SET job_posting_id=? WHERE opportunity_id=? AND job_posting_id IS NULL`)
      .run(posting.id, opportunity.id);
  }
  if (tableExists(db, 'opportunity_observations')) {
    db.prepare(`UPDATE opportunity_observations SET job_posting_id=? WHERE opportunity_id=? AND job_posting_id IS NULL`)
      .run(posting.id, opportunity.id);
  }
}

function backfillApplication(db, application) {
  let openingId = application.job_opening_id || null;
  let postingId = application.primary_job_posting_id || null;
  if (application.source_opportunity_id && tableExists(db, 'opportunities')) {
    const source = db.prepare(`
      SELECT job_opening_id, primary_job_posting_id FROM opportunities WHERE id=?
    `).get(application.source_opportunity_id);
    if (source) {
      if (openingId && source.job_opening_id && openingId !== source.job_opening_id) {
        throw new CatalogError('MIGRATION_CONFLICT', `Application ${application.id} disagrees with its source opportunity opening`);
      }
      openingId = openingId || source.job_opening_id;
      postingId = postingId || source.primary_job_posting_id;
    }
  }

  const legacyIdentifier = resolveOpeningIdentifier(db, 'legacy-application', String(application.id));
  if (!openingId && legacyIdentifier) openingId = legacyIdentifier.id;
  if (!openingId) {
    const company = resolveOrCreateCompany(db, requiredText(application.company, 'application company'));
    openingId = createOpening(db, {
      companyId: company.id,
      title: requiredText(application.role, 'application role'),
      status: 'unknown',
      originKind: 'application',
      identifierNamespace: 'legacy-application',
      identifierValue: String(application.id)
    }).id;
  } else {
    ensureOpeningIdentifier(db, openingId, 'legacy-application', String(application.id));
  }

  if (!postingId && optionalText(application.job_url)) {
    const opening = getOpening(db, openingId);
    const canonicalUrl = canonicalizeCatalogUrl(application.job_url);
    const existingPosting = db.prepare('SELECT * FROM job_postings WHERE canonical_url_sha256=?').get(sha256(canonicalUrl));
    // An unlinked legacy application intentionally owns a distinct opening. A
    // shared URL is evidence worth retaining in the legacy projection, but is
    // not enough authority to merge that opening with a discovered one.
    if (!existingPosting || existingPosting.job_opening_id === openingId) {
      const platform = resolvePlatform(db, inferPlatformSlug(application.job_url));
      const venue = resolveOrCreateVenue(db, {
        platformId: platform.id,
        companyId: opening.company_id,
        venueKey: urlHostname(application.job_url) || `legacy-application-${application.id}`,
        label: `${opening.company_name} via ${platform.name}`
      });
      postingId = resolveOrCreatePosting(db, {
        openingId,
        venueId: venue.id,
        url: application.job_url,
        state: 'unknown',
        firstSeenAt: application.created_at,
        lastSeenAt: application.updated_at
      }).id;
    }
  }

  db.prepare(`UPDATE applications SET job_opening_id=?, primary_job_posting_id=? WHERE id=?`)
    .run(openingId, postingId, application.id);
  if (postingId) {
    linkApplicationPosting(db, {
      applicationId: application.id,
      postingId,
      relation: application.workflow_stage === 'prospective' ? 'discovered_via' : 'submitted_via',
      primary: true
    });
  }
}

function ensureImportedStatusEvent(db, application) {
  const key = `catalog-v8:legacy-application:${application.id}:status`;
  const evidenceIncomplete = applicationStatusEvidenceIncomplete(db, application.id, application.status);
  db.prepare(`
    INSERT INTO application_status_events (
      application_id, from_status, to_status, event_kind, source, source_ref,
      evidence_incomplete, occurred_at, notes, idempotency_key
    ) VALUES (?, NULL, ?, 'legacy_status_imported', 'catalog_migration', ?, ?, ?, ?, ?)
    ON CONFLICT(idempotency_key) DO NOTHING
  `).run(
    application.id,
    application.status,
    `applications:${application.id}`,
    evidenceIncomplete,
    optionalText(application.status_changed_at) || optionalText(application.updated_at) || optionalText(application.created_at) || new Date(0).toISOString(),
    evidenceIncomplete
      ? `Legacy ${application.status} status has no canonical ${application.status === 'offer' ? 'offer' : 'interview'} evidence.`
      : null,
    key
  );
}

function applicationStatusEvidenceIncomplete(db, applicationId, status) {
  const id = requirePositiveId(applicationId, 'application id');
  if (status === 'interviewing') {
    return tableExists(db, 'interviews')
      && db.prepare('SELECT 1 FROM interviews WHERE application_id=? LIMIT 1').get(id) ? 0 : 1;
  }
  if (status === 'offer') {
    return tableExists(db, 'offers')
      && db.prepare('SELECT 1 FROM offers WHERE application_id=? LIMIT 1').get(id) ? 0 : 1;
  }
  return 0;
}

function resolveOrCreateCompany(db, name, options = {}) {
  const canonicalName = requiredText(name, 'company name');
  const normalizedName = normalizeCatalogText(canonicalName);
  let company = db.prepare('SELECT * FROM companies WHERE normalized_name=?').get(normalizedName);
  if (!company) {
    company = db.prepare(`
      SELECT c.* FROM company_aliases ca JOIN companies c ON c.id=ca.company_id
      WHERE ca.normalized_alias=?
    `).get(normalizedName);
  }
  if (!company) {
    const inserted = db.prepare(`
      INSERT INTO companies (canonical_name, normalized_name, website_domain)
      VALUES (?, ?, ?)
    `).run(canonicalName, normalizedName, optionalText(options.websiteDomain));
    company = db.prepare('SELECT * FROM companies WHERE id=?').get(inserted.lastInsertRowid);
  }
  ensureCompanyAlias(db, company.id, canonicalName, options.aliasKind || 'name');
  return company;
}

function ensureCompanyAlias(db, companyId, alias, aliasKind = 'name') {
  requirePositiveId(companyId, 'company id');
  const rawAlias = requiredText(alias, 'company alias');
  const normalizedAlias = normalizeCatalogText(rawAlias);
  const existing = db.prepare('SELECT * FROM company_aliases WHERE normalized_alias=?').get(normalizedAlias);
  if (existing && existing.company_id !== companyId) {
    throw new CatalogError('IDENTITY_CONFLICT', `Company alias ${rawAlias} already belongs to company ${existing.company_id}`);
  }
  db.prepare(`
    INSERT INTO company_aliases (company_id, alias, normalized_alias, alias_kind)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(normalized_alias) DO NOTHING
  `).run(companyId, rawAlias, normalizedAlias, requiredText(aliasKind, 'alias kind'));
  return db.prepare('SELECT * FROM company_aliases WHERE normalized_alias=?').get(normalizedAlias);
}

function createOpening(db, input) {
  const companyId = requirePositiveId(input.companyId, 'company id');
  if (!db.prepare('SELECT 1 FROM companies WHERE id=?').get(companyId)) {
    throw new CatalogError('NOT_FOUND', `Company not found: ${companyId}`);
  }
  const title = requiredText(input.title, 'opening title');
  const status = enumValue(input.status || 'unknown', ['unknown', 'open', 'closed'], 'opening status');
  const originKind = enumValue(input.originKind || 'manual', ['manual', 'opportunity', 'application'], 'opening origin');
  const namespace = optionalText(input.identifierNamespace);
  const identifierValue = optionalText(input.identifierValue);
  if (Boolean(namespace) !== Boolean(identifierValue)) {
    throw new CatalogError('VALIDATION_ERROR', 'Opening identifier namespace and value must be provided together');
  }
  if (namespace) {
    const existing = resolveOpeningIdentifier(db, namespace, identifierValue);
    if (existing) {
      if (existing.company_id !== companyId) {
        throw new CatalogError('IDENTITY_CONFLICT', `Opening identifier ${namespace}:${identifierValue} belongs to another company`);
      }
      return existing;
    }
  }
  const inserted = db.prepare(`
    INSERT INTO job_openings (company_id, canonical_title, normalized_title, status, origin_kind)
    VALUES (?, ?, ?, ?, ?)
  `).run(companyId, title, normalizeCatalogText(title), status, originKind);
  const openingId = Number(inserted.lastInsertRowid);
  if (namespace) ensureOpeningIdentifier(db, openingId, namespace, identifierValue);
  return getOpening(db, openingId);
}

function ensureOpeningIdentifier(db, openingId, namespace, value) {
  requirePositiveId(openingId, 'opening id');
  const normalizedNamespace = normalizeNamespace(namespace);
  const identifierValue = requiredText(value, 'opening identifier value');
  db.prepare(`
    INSERT INTO opening_identifiers (job_opening_id, namespace, identifier_value)
    VALUES (?, ?, ?) ON CONFLICT(namespace, identifier_value) DO NOTHING
  `).run(openingId, normalizedNamespace, identifierValue);
  const identity = db.prepare(`
    SELECT * FROM opening_identifiers WHERE namespace=? AND identifier_value=?
  `).get(normalizedNamespace, identifierValue);
  if (identity.job_opening_id !== openingId) {
    throw new CatalogError('IDENTITY_CONFLICT', `Opening identifier ${normalizedNamespace}:${identifierValue} belongs to opening ${identity.job_opening_id}`);
  }
  return identity;
}

function resolveOpeningIdentifier(db, namespace, value) {
  const identity = db.prepare(`
    SELECT oi.*, jo.company_id, jo.canonical_title, jo.normalized_title, jo.status, jo.origin_kind,
      jo.created_at, jo.updated_at
    FROM opening_identifiers oi JOIN job_openings jo ON jo.id=oi.job_opening_id
    WHERE oi.namespace=? AND oi.identifier_value=?
  `).get(normalizeNamespace(namespace), requiredText(value, 'opening identifier value'));
  return identity ? { ...identity, id: identity.job_opening_id } : null;
}

function getOpening(db, openingId) {
  const id = requirePositiveId(openingId, 'opening id');
  const row = db.prepare(`
    SELECT jo.*, c.canonical_name AS company_name, c.normalized_name AS company_normalized_name
    FROM job_openings jo JOIN companies c ON c.id=jo.company_id WHERE jo.id=?
  `).get(id);
  if (!row) throw new CatalogError('NOT_FOUND', `Opening not found: ${id}`);
  return row;
}

function resolvePlatform(db, slug) {
  const requested = slugify(slug || 'other');
  const normalized = ['manual', 'web'].includes(requested) ? 'direct' : requested;
  const platform = db.prepare('SELECT * FROM posting_platforms WHERE slug=?').get(normalized)
    || db.prepare("SELECT * FROM posting_platforms WHERE slug='other'").get();
  if (!platform) throw new CatalogError('SCHEMA_MISSING', 'Posting platform seeds are missing');
  return platform;
}

function resolveOrCreateVenue(db, input) {
  const platformId = requirePositiveId(input.platformId, 'posting platform id');
  const platform = db.prepare('SELECT * FROM posting_platforms WHERE id=?').get(platformId);
  if (!platform) throw new CatalogError('NOT_FOUND', `Posting platform not found: ${platformId}`);
  const venueKey = normalizeCatalogText(requiredText(input.venueKey, 'venue key'));
  let venue = db.prepare(`
    SELECT * FROM posting_venues WHERE posting_platform_id=? AND venue_key=?
  `).get(platformId, venueKey);
  const requestedCompanyId = input.companyId === undefined || input.companyId === null
    ? null
    : requirePositiveId(input.companyId, 'company id');
  // A direct company careers origin is company-owned. ATS hosts, aggregators,
  // communities, feeds, and generic APIs are shared publication venues; the
  // opening carries company identity, so binding a shared Greenhouse, Lever,
  // LinkedIn, or similar host to the first company seen creates false conflicts.
  const companyId = platform.platform_kind === 'company'
    ? requestedCompanyId
    : null;
  if (venue) {
    if (companyId && venue.company_id && venue.company_id !== companyId) {
      throw new CatalogError('IDENTITY_CONFLICT', `Venue ${platform.slug}:${venueKey} belongs to another company`);
    }
    if (!companyId && venue.company_id) {
      db.prepare('UPDATE posting_venues SET company_id=NULL, updated_at=datetime(\'now\') WHERE id=?').run(venue.id);
      venue = db.prepare('SELECT * FROM posting_venues WHERE id=?').get(venue.id);
    }
    if (!venue.company_id && companyId) {
      db.prepare('UPDATE posting_venues SET company_id=?, updated_at=datetime(\'now\') WHERE id=?').run(companyId, venue.id);
      venue = db.prepare('SELECT * FROM posting_venues WHERE id=?').get(venue.id);
    }
    return venue;
  }
  const inserted = db.prepare(`
    INSERT INTO posting_venues (
      posting_platform_id, company_id, venue_key, label, board_key, base_url
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    platformId,
    companyId,
    venueKey,
    requiredText(input.label, 'venue label'),
    optionalText(input.boardKey),
    optionalText(input.baseUrl)
  );
  return db.prepare('SELECT * FROM posting_venues WHERE id=?').get(inserted.lastInsertRowid);
}

function resolveOrCreatePosting(db, input) {
  const openingId = requirePositiveId(input.openingId, 'opening id');
  getOpening(db, openingId);
  const venueId = requirePositiveId(input.venueId, 'posting venue id');
  if (!db.prepare('SELECT 1 FROM posting_venues WHERE id=?').get(venueId)) {
    throw new CatalogError('NOT_FOUND', `Posting venue not found: ${venueId}`);
  }
  const canonicalUrl = canonicalizeCatalogUrl(input.url);
  const urlHash = sha256(canonicalUrl);
  const externalId = optionalText(input.externalId);
  const urlMatch = findPostingByCanonicalIdentity(db, canonicalUrl, urlHash);
  const externalMatch = externalId
    ? db.prepare('SELECT * FROM job_postings WHERE posting_venue_id=? AND external_id=?').get(venueId, externalId)
    : null;
  if (urlMatch && externalMatch && urlMatch.id !== externalMatch.id) {
    throw new CatalogError('IDENTITY_CONFLICT', 'Posting URL and venue external id resolve to different postings');
  }
  const match = externalMatch || urlMatch;
  if (match) {
    if (match.job_opening_id !== openingId) {
      throw new CatalogError('IDENTITY_CONFLICT', `Posting ${match.id} belongs to opening ${match.job_opening_id}`);
    }
    db.prepare(`
      UPDATE job_postings SET
        first_seen_at=COALESCE(first_seen_at, ?),
        last_seen_at=CASE
          WHEN last_seen_at IS NULL THEN ?
          WHEN ? IS NULL THEN last_seen_at
          WHEN datetime(?) >= datetime(last_seen_at) THEN ?
          ELSE last_seen_at END,
        updated_at=datetime('now')
      WHERE id=?
    `).run(
      optionalText(input.firstSeenAt),
      optionalText(input.lastSeenAt), optionalText(input.lastSeenAt),
      optionalText(input.lastSeenAt), optionalText(input.lastSeenAt),
      match.id
    );
    return db.prepare('SELECT * FROM job_postings WHERE id=?').get(match.id);
  }
  const state = enumValue(input.state || 'unknown', ['unknown', 'open', 'closed', 'removed'], 'posting state');
  const inserted = db.prepare(`
    INSERT INTO job_postings (
      job_opening_id, posting_venue_id, canonical_url, canonical_url_sha256, external_id,
      state, posted_at, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    openingId, venueId, canonicalUrl, urlHash, externalId, state,
    optionalText(input.postedAt), optionalText(input.firstSeenAt), optionalText(input.lastSeenAt)
  );
  return db.prepare('SELECT * FROM job_postings WHERE id=?').get(inserted.lastInsertRowid);
}

function findPostingByCanonicalIdentity(db, canonicalUrl, urlHash) {
  const exact = db.prepare('SELECT * FROM job_postings WHERE canonical_url_sha256=?').get(urlHash);
  if (exact) return exact;

  // Catalog v8 originally removed tracking parameters but did not sort retained
  // query parameters or normalize a trailing slash. A lazy compatibility scan
  // lets old rows participate in the same identity without creating a duplicate.
  const legacyMatches = db.prepare('SELECT * FROM job_postings ORDER BY id').all().filter((posting) => {
    try { return canonicalizeCatalogUrl(posting.canonical_url) === canonicalUrl; }
    catch { return false; }
  });
  if (legacyMatches.length > 1) {
    throw new CatalogError(
      'IDENTITY_CONFLICT',
      `Canonical posting URL resolves to multiple legacy postings: ${legacyMatches.map((posting) => posting.id).join(', ')}`
    );
  }
  if (legacyMatches.length === 0) return null;

  const match = legacyMatches[0];
  const hashConflict = db.prepare('SELECT id FROM job_postings WHERE canonical_url_sha256=? AND id<>?').get(urlHash, match.id);
  if (hashConflict) {
    throw new CatalogError('IDENTITY_CONFLICT', `Canonical posting URL conflicts with posting ${hashConflict.id}`);
  }
  db.prepare(`
    UPDATE job_postings
    SET canonical_url=?, canonical_url_sha256=?, updated_at=datetime('now')
    WHERE id=?
  `).run(canonicalUrl, urlHash, match.id);
  return db.prepare('SELECT * FROM job_postings WHERE id=?').get(match.id);
}

function linkApplicationPosting(db, input) {
  const applicationId = requirePositiveId(input.applicationId, 'application id');
  const postingId = requirePositiveId(input.postingId, 'posting id');
  const relation = enumValue(input.relation || 'alternate', ['discovered_via', 'submitted_via', 'alternate'], 'application posting relation');
  const primarySpecified = input.primary !== undefined && input.primary !== null;
  const isPrimary = input.primary ? 1 : 0;
  const application = db.prepare('SELECT * FROM applications WHERE id=?').get(applicationId);
  if (!application) throw new CatalogError('NOT_FOUND', `Application not found: ${applicationId}`);
  const posting = db.prepare('SELECT * FROM job_postings WHERE id=?').get(postingId);
  if (!posting) throw new CatalogError('NOT_FOUND', `Posting not found: ${postingId}`);
  if (!application.job_opening_id || application.job_opening_id !== posting.job_opening_id) {
    throw new CatalogError('OPENING_MISMATCH', 'Application and posting must belong to the same opening');
  }
  if (isPrimary) {
    db.prepare('UPDATE application_postings SET is_primary=0 WHERE application_id=? AND job_posting_id<>?')
      .run(applicationId, postingId);
  }
  if (primarySpecified) {
    db.prepare(`
      INSERT INTO application_postings (application_id, job_posting_id, relation, is_primary)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(application_id, job_posting_id) DO UPDATE SET
        relation=excluded.relation, is_primary=excluded.is_primary
    `).run(applicationId, postingId, relation, isPrimary);
  } else {
    db.prepare(`
      INSERT INTO application_postings (application_id, job_posting_id, relation, is_primary)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(application_id, job_posting_id) DO UPDATE SET relation=excluded.relation
    `).run(applicationId, postingId, relation);
  }
  if (isPrimary) db.prepare('UPDATE applications SET primary_job_posting_id=? WHERE id=?').run(postingId, applicationId);
  return db.prepare('SELECT * FROM application_postings WHERE application_id=? AND job_posting_id=?')
    .get(applicationId, postingId);
}

function linkProfileSkill(db, profileSkill) {
  const groupSlug = mapSkillCategory(profileSkill.skill_group);
  const category = db.prepare('SELECT * FROM skill_categories WHERE slug=?').get(groupSlug)
    || db.prepare("SELECT * FROM skill_categories WHERE slug='other'").get();
  const skill = resolveOrCreateSkill(db, profileSkill.name, category.id);
  db.prepare(`
    INSERT INTO profile_skill_catalog_links (profile_skill_id, skill_id)
    VALUES (?, ?) ON CONFLICT(profile_skill_id) DO UPDATE SET skill_id=excluded.skill_id
  `).run(profileSkill.id, skill.id);
  return db.prepare('SELECT * FROM profile_skill_catalog_links WHERE profile_skill_id=?').get(profileSkill.id);
}

function resolveOrCreateSkill(db, name, categoryId) {
  const canonicalName = requiredText(name, 'skill name');
  const normalizedName = normalizeCatalogText(canonicalName);
  let skill = db.prepare('SELECT * FROM skills WHERE normalized_name=?').get(normalizedName);
  if (!skill) {
    skill = db.prepare(`
      SELECT s.* FROM skill_aliases sa JOIN skills s ON s.id=sa.skill_id
      WHERE sa.normalized_alias=?
    `).get(normalizedName);
  }
  if (!skill) {
    const resolvedCategoryId = requirePositiveId(categoryId, 'skill category id');
    if (!db.prepare('SELECT 1 FROM skill_categories WHERE id=?').get(resolvedCategoryId)) {
      throw new CatalogError('NOT_FOUND', `Skill category not found: ${resolvedCategoryId}`);
    }
    const slug = uniqueSkillSlug(db, canonicalName, normalizedName);
    const inserted = db.prepare(`
      INSERT INTO skills (skill_category_id, slug, canonical_name, normalized_name)
      VALUES (?, ?, ?, ?)
    `).run(resolvedCategoryId, slug, canonicalName, normalizedName);
    skill = db.prepare('SELECT * FROM skills WHERE id=?').get(inserted.lastInsertRowid);
  }
  const alias = db.prepare('SELECT * FROM skill_aliases WHERE normalized_alias=?').get(normalizedName);
  if (alias && alias.skill_id !== skill.id) {
    throw new CatalogError('IDENTITY_CONFLICT', `Skill alias ${canonicalName} belongs to another skill`);
  }
  db.prepare(`
    INSERT INTO skill_aliases (skill_id, alias, normalized_alias)
    VALUES (?, ?, ?) ON CONFLICT(normalized_alias) DO NOTHING
  `).run(skill.id, canonicalName, normalizedName);
  return skill;
}

function mapSkillCategory(group) {
  const normalized = normalizeCatalogText(group || 'other');
  const mapping = new Map([
    ['language', 'languages'], ['languages', 'languages'],
    ['framework', 'frameworks'], ['frameworks', 'frameworks'],
    ['database', 'databases'], ['databases', 'databases'],
    ['cloud', 'cloud'],
    ['infrastructure', 'infrastructure'],
    ['platform', 'platforms'], ['platforms', 'platforms'],
    ['data', 'data'],
    ['concept', 'concepts'], ['concepts', 'concepts'],
    ['tool', 'tools'], ['tools', 'tools']
  ]);
  return mapping.get(normalized) || 'other';
}

function countNullLinks(db, table) {
  if (!tableExists(db, table) || !columnExists(db, table, 'job_posting_id')) return 0;
  return db.prepare(`SELECT count(*) AS count FROM ${table} WHERE job_posting_id IS NULL`).get().count;
}

function dropOpportunityUpdateGuards(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_opportunity_snapshots_immutable_update;
    DROP TRIGGER IF EXISTS trg_opportunity_observations_immutable_update;
  `);
}

function restoreOpportunityUpdateGuards(db) {
  if (tableExists(db, 'opportunity_snapshots')) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_opportunity_snapshots_immutable_update
      BEFORE UPDATE ON opportunity_snapshots
      BEGIN SELECT RAISE(ABORT, 'opportunity snapshots are immutable'); END;
    `);
  }
  if (tableExists(db, 'opportunity_observations')) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_opportunity_observations_immutable_update
      BEFORE UPDATE ON opportunity_observations
      BEGIN SELECT RAISE(ABORT, 'opportunity observations are immutable'); END;
    `);
  }
}

function ensureColumn(db, table, column, definition) {
  if (!tableExists(db, table) || columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function normalizeCatalogText(value) {
  return requiredText(value, 'catalog text').normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

function normalizeNamespace(value) {
  return normalizeCatalogText(value).replace(/[^a-z0-9._-]+/g, '-');
}

function slugify(value) {
  const prepared = requiredText(value, 'slug value')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/c\+\+/g, 'cpp')
    .replace(/c#/g, 'c-sharp')
    .replace(/\.net/g, 'dotnet');
  return prepared.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
}

function uniqueSkillSlug(db, name, normalizedName) {
  const base = slugify(name);
  const row = db.prepare('SELECT normalized_name FROM skills WHERE slug=?').get(base);
  if (!row || row.normalized_name === normalizedName) return base;
  return `${base}-${sha256(normalizedName).slice(0, 8)}`;
}

function canonicalizeCatalogUrl(value) {
  let url;
  try { url = new URL(requiredText(value, 'posting URL')); }
  catch { throw new CatalogError('INVALID_URL', `Invalid posting URL: ${value}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new CatalogError('INVALID_URL', 'Posting URLs must use http or https and contain no credentials');
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || URL_TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

function inferPlatformSlug(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('linkedin.')) return 'linkedin';
  if (text.includes('greenhouse.')) return 'greenhouse';
  if (text.includes('ashbyhq.')) return 'ashby';
  if (text.includes('lever.co')) return 'lever';
  if (text.includes('wellfound.')) return 'wellfound';
  if (text.includes('indeed.')) return 'indeed';
  if (PLATFORM_SEEDS.some(([slug]) => slug === text)) return text;
  return text === 'manual' || text === 'web' ? 'direct' : 'other';
}

function urlHostname(value) {
  try { return new URL(value).hostname.toLowerCase(); }
  catch { return null; }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function requiredText(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new CatalogError('VALIDATION_ERROR', `Missing ${label}`);
  }
  return String(value).trim();
}

function optionalText(value) {
  return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim();
}

function requirePositiveId(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new CatalogError('VALIDATION_ERROR', `${label} must be a positive integer`);
  return number;
}

function enumValue(value, allowed, label) {
  const text = requiredText(value, label);
  if (!allowed.includes(text)) throw new CatalogError('VALIDATION_ERROR', `${label} must be one of: ${allowed.join(', ')}`);
  return text;
}

module.exports = {
  CATALOG_SCHEMA_VERSION,
  CATALOG_USER_VERSION,
  CatalogError,
  applicationStatusEvidenceIncomplete,
  canonicalizeCatalogUrl,
  createOpening,
  ensureCompanyAlias,
  ensureOpeningIdentifier,
  getOpening,
  linkApplicationPosting,
  linkProfileSkill,
  migrateCatalog,
  normalizeCatalogText,
  resolveOrCreateCompany,
  resolveOrCreateOpening: createOpening,
  resolveOrCreatePosting,
  resolveOrCreateSkill,
  resolveOrCreateVenue,
  resolveOpeningIdentifier,
  resolvePlatform
};
