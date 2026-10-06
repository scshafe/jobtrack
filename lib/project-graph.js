'use strict';

const PROJECT_GRAPH_MIGRATION_NAME = 'project_kinds_and_relations';
const PROJECT_GRAPH_SCHEMA_VERSION = 2026072805;
const PROJECT_KINDS = Object.freeze(['application', 'library', 'service', 'site', 'tool', 'experiment']);
const PROJECT_RELATIONS = Object.freeze(['uses', 'extracted_from', 'part_of', 'successor_of']);

class ProjectGraphError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ProjectGraphError';
    this.code = code;
    this.details = details;
  }
}

// Libraries and applications stay in one profile spine; the distinction is a
// kind enum plus an explicit dependency graph, so an entry can change identity
// (library grows into a product) without a table migration.
function migrateProjectGraph(db) {
  const apply = () => {
    ensureColumn(
      db, 'profile_projects', 'project_kind',
      "TEXT NOT NULL DEFAULT 'application' CHECK (project_kind IN ('application','library','service','site','tool','experiment'))"
    );
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_project_relations (
        from_profile_project_id INTEGER NOT NULL REFERENCES profile_projects(id) ON DELETE CASCADE,
        to_profile_project_id INTEGER NOT NULL REFERENCES profile_projects(id) ON DELETE CASCADE,
        relation TEXT NOT NULL CHECK (relation IN ('uses','extracted_from','part_of','successor_of')),
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(from_profile_project_id, to_profile_project_id, relation),
        CHECK (from_profile_project_id <> to_profile_project_id)
      );
      CREATE INDEX IF NOT EXISTS idx_profile_project_relations_to
        ON profile_project_relations(to_profile_project_id, relation);
    `);
    const migration = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
      .get(PROJECT_GRAPH_SCHEMA_VERSION);
    if (migration && migration.name !== PROJECT_GRAPH_MIGRATION_NAME) {
      throw new ProjectGraphError(
        'MIGRATION_CONFLICT',
        `Schema version ${PROJECT_GRAPH_SCHEMA_VERSION} is already named ${migration.name}`
      );
    }
    if (!migration) {
      db.prepare('INSERT INTO jobtrack_schema_migrations (version, name) VALUES (?, ?)')
        .run(PROJECT_GRAPH_SCHEMA_VERSION, PROJECT_GRAPH_MIGRATION_NAME);
    }
  };
  if (db.inTransaction) apply();
  else db.transaction(apply).immediate();
}

function setProjectKind(db, flags) {
  const { entry, satellite } = resolveProjectEntry(db, flags.entryId ?? flags.id);
  const kind = String(flags.kind ?? '').trim().toLowerCase();
  if (!PROJECT_KINDS.includes(kind)) {
    throw new ProjectGraphError('VALIDATION_ERROR', `--kind must be one of: ${PROJECT_KINDS.join(', ')}`);
  }
  db.prepare('UPDATE profile_projects SET project_kind=? WHERE id=?').run(kind, satellite.id);
  return { entry: { id: entry.id, title: entry.title, projectKind: kind } };
}

function relateProjects(db, flags) {
  const from = resolveProjectEntry(db, flags.entryId ?? flags.id, '--entry-id');
  const to = resolveProjectEntry(db, flags.toEntryId, '--to-entry-id');
  const relation = requiredRelation(flags.relation);
  if (from.satellite.id === to.satellite.id) {
    throw new ProjectGraphError('VALIDATION_ERROR', 'A project cannot relate to itself');
  }
  db.prepare(`
    INSERT INTO profile_project_relations (from_profile_project_id, to_profile_project_id, relation, notes)
    VALUES (?,?,?,?)
    ON CONFLICT(from_profile_project_id, to_profile_project_id, relation)
    DO UPDATE SET notes=excluded.notes
  `).run(from.satellite.id, to.satellite.id, relation, optionalText(flags.notes));
  return {
    relation: {
      from: { entryId: from.entry.id, name: from.satellite.name },
      relation,
      to: { entryId: to.entry.id, name: to.satellite.name },
      notes: optionalText(flags.notes)
    }
  };
}

function unrelateProjects(db, flags) {
  const from = resolveProjectEntry(db, flags.entryId ?? flags.id, '--entry-id');
  const to = resolveProjectEntry(db, flags.toEntryId, '--to-entry-id');
  const relation = requiredRelation(flags.relation);
  const info = db.prepare(`
    DELETE FROM profile_project_relations
    WHERE from_profile_project_id=? AND to_profile_project_id=? AND relation=?
  `).run(from.satellite.id, to.satellite.id, relation);
  if (info.changes === 0) {
    throw new ProjectGraphError(
      'NOT_FOUND',
      `No '${relation}' relation from entry ${from.entry.id} to entry ${to.entry.id}`
    );
  }
  return { removed: { fromEntryId: from.entry.id, relation, toEntryId: to.entry.id } };
}

function listProjectRelations(db, flags = {}) {
  const rows = db.prepare(`
    SELECT rel.relation, rel.notes,
           pf.profile_entry_id AS from_entry_id, pf.name AS from_name,
           pt.profile_entry_id AS to_entry_id, pt.name AS to_name
    FROM profile_project_relations rel
    JOIN profile_projects pf ON pf.id=rel.from_profile_project_id
    JOIN profile_projects pt ON pt.id=rel.to_profile_project_id
    ORDER BY pf.name, rel.relation, pt.name
  `).all();
  const entryId = flags.entryId ?? flags.id;
  const filtered = entryId === undefined
    ? rows
    : rows.filter((row) => row.from_entry_id === Number(entryId) || row.to_entry_id === Number(entryId));
  return {
    relations: filtered.map((row) => ({
      from: { entryId: row.from_entry_id, name: row.from_name },
      relation: row.relation,
      to: { entryId: row.to_entry_id, name: row.to_name },
      notes: row.notes ?? null
    }))
  };
}

// Web read model: relationsOut/relationsIn on project structured rows.
function attachProjectRelations(db, byId) {
  if (!tableExists(db, 'profile_project_relations')) return;
  const rows = db.prepare(`
    SELECT rel.relation,
           pf.profile_entry_id AS from_entry_id, pf.name AS from_name,
           pt.profile_entry_id AS to_entry_id, pt.name AS to_name
    FROM profile_project_relations rel
    JOIN profile_projects pf ON pf.id=rel.from_profile_project_id
    JOIN profile_projects pt ON pt.id=rel.to_profile_project_id
    ORDER BY rel.relation, pt.name
  `).all();
  for (const row of rows) {
    const fromEntry = byId.get(row.from_entry_id);
    if (fromEntry?.project) {
      if (!fromEntry.project.relationsOut) fromEntry.project.relationsOut = [];
      fromEntry.project.relationsOut.push({ relation: row.relation, name: row.to_name, entryId: row.to_entry_id });
    }
    const toEntry = byId.get(row.to_entry_id);
    if (toEntry?.project) {
      if (!toEntry.project.relationsIn) toEntry.project.relationsIn = [];
      toEntry.project.relationsIn.push({ relation: row.relation, name: row.from_name, entryId: row.from_entry_id });
    }
  }
}

function resolveProjectEntry(db, value, label = '--entry-id') {
  const entryId = requiredId(value, label);
  const entry = db.prepare('SELECT id, category, title FROM profile_entries WHERE id=?').get(entryId);
  if (!entry) throw new ProjectGraphError('NOT_FOUND', `Profile entry ${entryId} not found`);
  if (entry.category !== 'project') {
    throw new ProjectGraphError('VALIDATION_ERROR', `Project relations apply to project entries; entry ${entryId} is category '${entry.category}'`);
  }
  const satellite = db.prepare('SELECT * FROM profile_projects WHERE profile_entry_id=?').get(entryId);
  if (!satellite) {
    throw new ProjectGraphError('INVARIANT_VIOLATION', `Structured project row is missing for profile entry ${entryId}`);
  }
  return { entry, satellite };
}

function requiredRelation(value) {
  const relation = String(value ?? '').trim().toLowerCase();
  if (!PROJECT_RELATIONS.includes(relation)) {
    throw new ProjectGraphError('VALIDATION_ERROR', `--relation must be one of: ${PROJECT_RELATIONS.join(', ')}`);
  }
  return relation;
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function requiredId(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ProjectGraphError('VALIDATION_ERROR', `${label} must be a positive integer`);
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
  if (columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

module.exports = {
  PROJECT_GRAPH_MIGRATION_NAME,
  PROJECT_GRAPH_SCHEMA_VERSION,
  PROJECT_KINDS,
  PROJECT_RELATIONS,
  ProjectGraphError,
  attachProjectRelations,
  listProjectRelations,
  migrateProjectGraph,
  relateProjects,
  setProjectKind,
  unrelateProjects
};
