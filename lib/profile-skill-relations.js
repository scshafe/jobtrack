'use strict';

const { normalizeCatalogText } = require('./catalog');

const PROFILE_SKILL_RELATIONS_MIGRATION_NAME = 'profile_skill_relations';
const PROFILE_SKILL_RELATIONS_SCHEMA_VERSION = 2026072801;

class ProfileSkillRelationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ProfileSkillRelationError';
    this.code = code;
    this.details = details;
  }
}

// Skill links attach to the structured satellite rows, keyed here by the
// profile_entries category the CLI already uses to address entries.
const ENTRY_TARGETS = Object.freeze({
  work: {
    key: 'work',
    table: 'profile_work_entry_skills',
    column: 'profile_work_entry_id',
    satellite: 'profile_work_entries',
    label: 'work entry'
  },
  education: {
    key: 'education',
    table: 'profile_education_skills',
    column: 'profile_education_entry_id',
    satellite: 'profile_education_entries',
    label: 'education entry'
  },
  project: {
    key: 'project',
    table: 'profile_project_skills',
    column: 'profile_project_id',
    satellite: 'profile_projects',
    label: 'project'
  }
});

function migrateProfileSkillRelations(db) {
  const apply = () => {
    // profile_project_skills predates this module (profile normalization owns
    // its conservative stack sync); the CREATE below only fires on stores that
    // never ran that migration, and the ensureColumn calls upgrade both paths
    // to the shared source/confidence/evidence shape.
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_project_skills (
        profile_project_id INTEGER NOT NULL REFERENCES profile_projects(id) ON DELETE CASCADE,
        skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
        raw_value TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position>=0),
        source TEXT NOT NULL DEFAULT 'legacy_stack_exact',
        confidence REAL CHECK (confidence IS NULL OR (confidence>=0 AND confidence<=1)),
        evidence TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(profile_project_id,skill_id), CHECK (trim(raw_value)<>'')
      );

      CREATE TABLE IF NOT EXISTS profile_work_entry_skills (
        profile_work_entry_id INTEGER NOT NULL REFERENCES profile_work_entries(id) ON DELETE CASCADE,
        skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
        raw_value TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0 CHECK (position>=0),
        source TEXT NOT NULL DEFAULT 'manual',
        confidence REAL CHECK (confidence IS NULL OR (confidence>=0 AND confidence<=1)),
        evidence TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(profile_work_entry_id,skill_id),
        CHECK (trim(raw_value)<>''), CHECK (trim(source)<>''),
        CHECK (evidence IS NULL OR length(evidence)<=20000)
      );

      CREATE TABLE IF NOT EXISTS profile_education_skills (
        profile_education_entry_id INTEGER NOT NULL REFERENCES profile_education_entries(id) ON DELETE CASCADE,
        skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
        raw_value TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0 CHECK (position>=0),
        source TEXT NOT NULL DEFAULT 'manual',
        confidence REAL CHECK (confidence IS NULL OR (confidence>=0 AND confidence<=1)),
        evidence TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(profile_education_entry_id,skill_id),
        CHECK (trim(raw_value)<>''), CHECK (trim(source)<>''),
        CHECK (evidence IS NULL OR length(evidence)<=20000)
      );

      CREATE INDEX IF NOT EXISTS idx_profile_work_entry_skills_skill
        ON profile_work_entry_skills(skill_id,profile_work_entry_id);
      CREATE INDEX IF NOT EXISTS idx_profile_education_skills_skill
        ON profile_education_skills(skill_id,profile_education_entry_id);
      CREATE INDEX IF NOT EXISTS idx_profile_project_skills_skill
        ON profile_project_skills(skill_id,profile_project_id);
    `);
    ensureColumn(db, 'profile_project_skills', 'confidence', 'REAL CHECK (confidence IS NULL OR (confidence>=0 AND confidence<=1))');
    ensureColumn(db, 'profile_project_skills', 'evidence', 'TEXT');

    const migration = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
      .get(PROFILE_SKILL_RELATIONS_SCHEMA_VERSION);
    if (migration && migration.name !== PROFILE_SKILL_RELATIONS_MIGRATION_NAME) {
      throw new ProfileSkillRelationError(
        'MIGRATION_CONFLICT',
        `Schema version ${PROFILE_SKILL_RELATIONS_SCHEMA_VERSION} is already named ${migration.name}`
      );
    }
    if (!migration) {
      db.prepare('INSERT INTO jobtrack_schema_migrations (version, name) VALUES (?, ?)')
        .run(PROFILE_SKILL_RELATIONS_SCHEMA_VERSION, PROFILE_SKILL_RELATIONS_MIGRATION_NAME);
    }
  };
  if (db.inTransaction) apply();
  else db.transaction(apply).immediate();
}

function linkProfileEntrySkill(db, flags) {
  const { entry, target, satellite } = resolveEntryTarget(db, flags);
  const rawSkill = requiredText(flags.skill, '--skill');
  const skill = resolveSkillRef(db, rawSkill);
  const source = optionalText(flags.source) || 'manual';
  const confidence = parseConfidence(flags.confidence);
  const evidence = optionalText(flags.evidence);
  if (evidence && evidence.length > 20000) {
    throw new ProfileSkillRelationError('VALIDATION_ERROR', '--evidence must be 20000 characters or fewer');
  }
  const position = db.prepare(
    `SELECT COALESCE(MAX(position)+1,0) AS next FROM ${target.table} WHERE ${target.column}=?`
  ).get(satellite.id).next;
  db.prepare(`
    INSERT INTO ${target.table} (${target.column}, skill_id, raw_value, position, source, confidence, evidence)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(${target.column}, skill_id) DO UPDATE SET
      raw_value=excluded.raw_value, source=excluded.source,
      confidence=excluded.confidence, evidence=excluded.evidence
  `).run(satellite.id, skill.id, rawSkill, position, source, confidence, evidence);
  return { link: readLink(db, target, entry, satellite.id, skill.id) };
}

function unlinkProfileEntrySkill(db, flags) {
  const { entry, target, satellite } = resolveEntryTarget(db, flags);
  const skill = resolveSkillRef(db, requiredText(flags.skill, '--skill'));
  const info = db.prepare(
    `DELETE FROM ${target.table} WHERE ${target.column}=? AND skill_id=?`
  ).run(satellite.id, skill.id);
  if (info.changes === 0) {
    throw new ProfileSkillRelationError(
      'NOT_FOUND',
      `No skill link between entry ${entry.id} (${target.label}) and ${skill.canonical_name}`
    );
  }
  return {
    removed: {
      entryId: entry.id,
      category: entry.category,
      entryTitle: entry.title,
      skillId: skill.id,
      skillSlug: skill.slug,
      skillName: skill.canonical_name
    }
  };
}

function listProfileSkillLinks(db, flags = {}) {
  if (flags.unresolved) {
    return { unresolvedStack: listUnresolvedStack(db) };
  }
  if (flags.entryId !== undefined || flags.id !== undefined) {
    const { entry, target, satellite } = resolveEntryTarget(db, flags);
    return {
      entry: { id: entry.id, category: entry.category, title: entry.title },
      links: linksForTargetRow(db, target, satellite.id)
    };
  }
  if (flags.skill !== undefined) {
    const skill = resolveSkillRef(db, requiredText(flags.skill, '--skill'));
    const links = [];
    for (const target of Object.values(ENTRY_TARGETS)) {
      if (!tableExists(db, target.table) || !tableExists(db, target.satellite)) continue;
      links.push(...db.prepare(`
        SELECT j.*, sat.profile_entry_id AS profile_entry_id, e.title AS entry_title, e.category AS entry_category
        FROM ${target.table} j
        JOIN ${target.satellite} sat ON sat.id=j.${target.column}
        JOIN profile_entries e ON e.id=sat.profile_entry_id
        WHERE j.skill_id=?
        ORDER BY j.position, sat.id
      `).all(skill.id).map((row) => serializeLinkRow(row, target, skill)));
    }
    return {
      skill: { id: skill.id, slug: skill.slug, name: skill.canonical_name, category: skill.category_slug },
      links
    };
  }
  return {
    work: allLinksFor(db, ENTRY_TARGETS.work),
    education: allLinksFor(db, ENTRY_TARGETS.education),
    projects: allLinksFor(db, ENTRY_TARGETS.project),
    unresolvedStack: listUnresolvedStack(db)
  };
}

// Read model for the web server: attaches skillLinks arrays onto the
// structured rows listProfileCorpus has already placed on each entry.
function attachProfileSkillLinks(db, byId) {
  for (const target of Object.values(ENTRY_TARGETS)) {
    if (!tableExists(db, target.table) || !tableExists(db, target.satellite)) continue;
    const rows = db.prepare(`
      SELECT j.*, sat.profile_entry_id AS profile_entry_id,
             s.slug AS skill_slug, s.canonical_name AS skill_name, c.slug AS skill_category
      FROM ${target.table} j
      JOIN ${target.satellite} sat ON sat.id=j.${target.column}
      JOIN skills s ON s.id=j.skill_id
      JOIN skill_categories c ON c.id=s.skill_category_id
      ORDER BY j.position, s.id
    `).all();
    for (const row of rows) {
      const entry = byId.get(row.profile_entry_id);
      const structured = entry?.[target.key];
      if (!structured) continue;
      if (!structured.skillLinks) structured.skillLinks = [];
      structured.skillLinks.push({
        skillId: row.skill_id,
        slug: row.skill_slug,
        name: row.skill_name,
        category: row.skill_category,
        source: row.source,
        confidence: row.confidence ?? null,
        evidence: row.evidence ?? null,
        rawValue: row.raw_value
      });
    }
  }
}

function resolveEntryTarget(db, flags) {
  const entryId = requiredId(flags.entryId ?? flags.id, '--entry-id');
  const entry = db.prepare('SELECT id, category, title FROM profile_entries WHERE id=?').get(entryId);
  if (!entry) throw new ProfileSkillRelationError('NOT_FOUND', `Profile entry ${entryId} not found`);
  const target = ENTRY_TARGETS[entry.category];
  if (!target) {
    throw new ProfileSkillRelationError(
      'VALIDATION_ERROR',
      `Skill links apply to work, education, and project entries; entry ${entryId} is category '${entry.category}'`
    );
  }
  const satellite = db.prepare(`SELECT * FROM ${target.satellite} WHERE profile_entry_id=?`).get(entryId);
  if (!satellite) {
    throw new ProfileSkillRelationError(
      'INVARIANT_VIOLATION',
      `Structured ${target.label} row is missing for profile entry ${entryId}`
    );
  }
  return { entry, target, satellite };
}

// Resolution is strictly read-only: slug, exact normalized name, or alias.
// Unknown skills are reported with suggestions, never auto-created.
function resolveSkillRef(db, ref) {
  const text = requiredText(ref, '--skill');
  const normalized = normalizeCatalogText(text);
  const select = `
    SELECT s.id, s.slug, s.canonical_name, s.normalized_name, c.slug AS category_slug
    FROM skills s JOIN skill_categories c ON c.id=s.skill_category_id
  `;
  const skill = db.prepare(`${select} WHERE s.slug=?`).get(text.trim().toLowerCase())
    || db.prepare(`${select} WHERE s.normalized_name=?`).get(normalized)
    || db.prepare(`
      SELECT s.id, s.slug, s.canonical_name, s.normalized_name, c.slug AS category_slug
      FROM skill_aliases sa
      JOIN skills s ON s.id=sa.skill_id
      JOIN skill_categories c ON c.id=s.skill_category_id
      WHERE sa.normalized_alias=?
    `).get(normalized);
  if (skill) return skill;
  const pattern = `%${normalized}%`;
  const suggestions = db.prepare(`
    SELECT canonical_name AS suggestion FROM skills WHERE normalized_name LIKE ? OR slug LIKE ?
    UNION
    SELECT alias AS suggestion FROM skill_aliases WHERE normalized_alias LIKE ?
    ORDER BY suggestion LIMIT 5
  `).all(pattern, pattern, pattern).map((row) => row.suggestion);
  throw new ProfileSkillRelationError(
    'NOT_FOUND',
    `Unknown skill '${text}'.` +
      (suggestions.length ? ` Closest catalog matches: ${suggestions.join(', ')}.` : '') +
      ' Skill links never create catalog entries; add the skill deliberately first' +
      ' (e.g. `jobtrack profile add-skill --name ...`).',
    { suggestions }
  );
}

function linksForTargetRow(db, target, satelliteId) {
  return db.prepare(`
    SELECT j.*, s.slug AS skill_slug, s.canonical_name AS skill_name, c.slug AS skill_category
    FROM ${target.table} j
    JOIN skills s ON s.id=j.skill_id
    JOIN skill_categories c ON c.id=s.skill_category_id
    WHERE j.${target.column}=?
    ORDER BY j.position, s.id
  `).all(satelliteId).map((row) => ({
    skillId: row.skill_id,
    skillSlug: row.skill_slug,
    skillName: row.skill_name,
    skillCategory: row.skill_category,
    rawValue: row.raw_value,
    source: row.source,
    confidence: row.confidence ?? null,
    evidence: row.evidence ?? null,
    createdAt: row.created_at
  }));
}

function allLinksFor(db, target) {
  if (!tableExists(db, target.table) || !tableExists(db, target.satellite)) return [];
  return db.prepare(`
    SELECT j.*, sat.profile_entry_id AS profile_entry_id, e.title AS entry_title, e.category AS entry_category,
           s.slug AS skill_slug, s.canonical_name AS skill_name, c.slug AS skill_category
    FROM ${target.table} j
    JOIN ${target.satellite} sat ON sat.id=j.${target.column}
    JOIN profile_entries e ON e.id=sat.profile_entry_id
    JOIN skills s ON s.id=j.skill_id
    JOIN skill_categories c ON c.id=s.skill_category_id
    ORDER BY sat.id, j.position, s.id
  `).all().map((row) => serializeLinkRow(row, target, {
    id: row.skill_id, slug: row.skill_slug, canonical_name: row.skill_name, category_slug: row.skill_category
  }));
}

function serializeLinkRow(row, target, skill) {
  return {
    entryId: row.profile_entry_id,
    entryTitle: row.entry_title,
    category: target.key,
    skillId: skill.id,
    skillSlug: skill.slug,
    skillName: skill.canonical_name,
    skillCategory: skill.category_slug,
    rawValue: row.raw_value,
    source: row.source,
    confidence: row.confidence ?? null,
    evidence: row.evidence ?? null,
    createdAt: row.created_at
  };
}

function readLink(db, target, entry, satelliteId, skillId) {
  const row = db.prepare(`
    SELECT j.*, s.slug AS skill_slug, s.canonical_name AS skill_name, c.slug AS skill_category
    FROM ${target.table} j
    JOIN skills s ON s.id=j.skill_id
    JOIN skill_categories c ON c.id=s.skill_category_id
    WHERE j.${target.column}=? AND j.skill_id=?
  `).get(satelliteId, skillId);
  return {
    entryId: entry.id,
    entryTitle: entry.title,
    category: target.key,
    skillId: row.skill_id,
    skillSlug: row.skill_slug,
    skillName: row.skill_name,
    skillCategory: row.skill_category,
    rawValue: row.raw_value,
    position: row.position,
    source: row.source,
    confidence: row.confidence ?? null,
    evidence: row.evidence ?? null,
    createdAt: row.created_at
  };
}

// Stack strings a strict resolver cannot place in the catalog. Reported, never
// guessed — mirrors the conservative legacy stack sync.
function listUnresolvedStack(db) {
  if (!tableExists(db, 'profile_projects')) return [];
  const unresolved = [];
  for (const project of db.prepare('SELECT id, profile_entry_id, name, stack FROM profile_projects ORDER BY id').all()) {
    for (const rawValue of parseStackList(project.stack)) {
      const resolved = (() => {
        try { return resolveSkillRef(db, rawValue); } catch { return null; }
      })();
      if (!resolved) unresolved.push({ entryId: project.profile_entry_id, projectName: project.name, rawValue });
    }
  }
  return unresolved;
}

function parseStackList(value) {
  if (Array.isArray(value)) return dedupeStrings(value);
  if (value === undefined || value === null || value === '') return [];
  const text = String(value);
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return dedupeStrings(parsed);
  } catch { /* legacy comma-separated fallback below */ }
  return dedupeStrings(text.split(','));
}

function dedupeStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    result.push(text);
  }
  return result;
}

function parseConfidence(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new ProfileSkillRelationError('VALIDATION_ERROR', '--confidence must be a number between 0 and 1');
  }
  return parsed;
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new ProfileSkillRelationError('VALIDATION_ERROR', `${label} is required`);
  return text;
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function requiredId(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ProfileSkillRelationError('VALIDATION_ERROR', `${label} must be a positive integer`);
  }
  return parsed;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function columnExists(db, table, column) {
  return db.pragma(`table_info(${table})`).some((info) => info.name === column);
}

function ensureColumn(db, table, column, definition) {
  if (!tableExists(db, table) || columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

module.exports = {
  PROFILE_SKILL_RELATIONS_MIGRATION_NAME,
  PROFILE_SKILL_RELATIONS_SCHEMA_VERSION,
  ProfileSkillRelationError,
  attachProfileSkillLinks,
  linkProfileEntrySkill,
  listProfileSkillLinks,
  migrateProfileSkillRelations,
  resolveSkillRef,
  unlinkProfileEntrySkill
};
