'use strict';

const MC_SYNC_MIGRATION_NAME = 'mc_sync_mapping';
const MC_SYNC_SCHEMA_VERSION = 2026072806;
const DEFAULT_MC_BASE = 'http://127.0.0.1:18792';

class McSyncError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'McSyncError';
    this.code = code;
    this.details = details;
  }
}

// Mission Control is an ENRICHMENT FEED, never a public source and never an
// authority over curated prose. The sync reads MC's loopback API (read-only
// GETs), reports drift, and --apply writes exactly one narrow field: clearing
// a stale end_date when MC says the project is still active. Everything else
// stays a report for the operator.
function migrateMcSync(db) {
  const apply = () => {
    if (!db.pragma('table_info(profile_projects)').some((info) => info.name === 'mc_project_id')) {
      db.exec('ALTER TABLE profile_projects ADD COLUMN mc_project_id TEXT');
    }
    const migration = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
      .get(MC_SYNC_SCHEMA_VERSION);
    if (migration && migration.name !== MC_SYNC_MIGRATION_NAME) {
      throw new McSyncError(
        'MIGRATION_CONFLICT',
        `Schema version ${MC_SYNC_SCHEMA_VERSION} is already named ${migration.name}`
      );
    }
    if (!migration) {
      db.prepare('INSERT INTO jobtrack_schema_migrations (version, name) VALUES (?, ?)')
        .run(MC_SYNC_SCHEMA_VERSION, MC_SYNC_MIGRATION_NAME);
    }
  };
  if (db.inTransaction) apply();
  else db.transaction(apply).immediate();
}

async function runMcSyncCommand(db, args, flags) {
  switch (args[0]) {
    case 'map-mc':
      return mapMcProject(db, flags);
    case 'sync-mc':
      return syncFromMc(db, flags);
    default:
      throw new McSyncError('UNKNOWN_COMMAND', 'Unknown MC sync command. Use: profile map-mc, profile sync-mc.');
  }
}

// Explicit mapping is fail-loud: resolving against a down or unknown MC is an
// operator error worth surfacing.
async function mapMcProject(db, flags) {
  const entryId = requiredId(flags.entryId ?? flags.id, '--entry-id');
  const entry = db.prepare('SELECT id, category, title FROM profile_entries WHERE id=?').get(entryId);
  if (!entry) throw new McSyncError('NOT_FOUND', `Profile entry ${entryId} not found`);
  if (entry.category !== 'project') {
    throw new McSyncError('VALIDATION_ERROR', `MC mappings apply to project entries; entry ${entryId} is category '${entry.category}'`);
  }
  const satellite = db.prepare('SELECT * FROM profile_projects WHERE profile_entry_id=?').get(entryId);
  const ref = String(flags.mcProject ?? '').trim();
  if (!ref) throw new McSyncError('VALIDATION_ERROR', '--mc-project is required (slug or uuid)');

  const projects = await fetchMcProjects();
  if (!projects) throw new McSyncError('MC_UNREACHABLE', `Mission Control read API is unreachable at ${mcBase()}`);
  const match = projects.find((project) => project.slug === ref || project.id === ref);
  if (!match) {
    throw new McSyncError('NOT_FOUND', `No Mission Control project matches '${ref}'. Known slugs: ${projects.map((p) => p.slug).sort().join(', ')}`);
  }
  db.transaction(() => {
    db.prepare('UPDATE profile_projects SET mc_project_id=? WHERE id=?').run(match.id, satellite.id);
  }).immediate();
  return {
    mapped: {
      entryId: entry.id,
      name: satellite.name,
      mcProjectId: match.id,
      mcSlug: match.slug,
      mcTitle: match.title,
      mcStatus: match.status
    }
  };
}

// Sync is fail-soft: an offline MC is a normal condition, not an error.
async function syncFromMc(db, flags) {
  const apply = Boolean(flags.apply);
  const projects = await fetchMcProjects();
  if (!projects) {
    return { mcUnreachable: true, base: mcBase(), applied: 0, results: [] };
  }
  const mcById = new Map(projects.map((project) => [project.id, project]));
  const mapped = db.prepare(`
    SELECT p.id AS satellite_id, p.profile_entry_id AS entry_id, p.name, p.end_date, p.mc_project_id,
           e.display_status
    FROM profile_projects p JOIN profile_entries e ON e.id=p.profile_entry_id
    WHERE p.mc_project_id IS NOT NULL
    ORDER BY p.id
  `).all();

  const results = [];
  let applied = 0;
  for (const row of mapped) {
    const mc = mcById.get(row.mc_project_id);
    if (!mc) {
      results.push({ entryId: row.entry_id, name: row.name, mcProjectId: row.mc_project_id, drift: [{ field: 'mapping', note: 'MC project no longer exists' }] });
      continue;
    }
    const drift = [];
    if (mc.title !== row.name) {
      drift.push({ field: 'title', profile: row.name, mc: mc.title, note: 'report only — curated names are never auto-renamed' });
    }
    if (mc.status === 'active' && row.end_date) {
      const entry = { field: 'end_date', profile: row.end_date, mc: 'active', note: 'MC says active; end date looks stale' };
      if (apply) {
        db.transaction(() => {
          db.prepare('UPDATE profile_projects SET end_date=NULL WHERE id=?').run(row.satellite_id);
        }).immediate();
        entry.applied = true;
        applied += 1;
      }
      drift.push(entry);
    }
    if (mc.status !== 'active' && !row.end_date) {
      drift.push({ field: 'end_date', profile: null, mc: mc.status, note: `MC status is '${mc.status}'; consider setting an end date (never auto-invented)` });
    }
    if (mc.status !== 'active' && row.display_status !== 'hidden') {
      drift.push({ field: 'display_status', profile: row.display_status, mc: mc.status, note: 'consider set-display if this should leave the public site (operator call)' });
    }
    results.push({ entryId: row.entry_id, name: row.name, mcSlug: mc.slug, mcStatus: mc.status, drift });
  }
  return {
    base: mcBase(),
    mapped: mapped.length,
    driftCount: results.filter((result) => result.drift.length).length,
    applied,
    apply,
    results
  };
}

function mcBase() {
  return (process.env.MISSION_CONTROL_WEB_URL || DEFAULT_MC_BASE).replace(/\/+$/, '');
}

async function fetchMcProjects() {
  // Test seam: the sandboxed test environment blackholes child-process
  // connects to arbitrary loopback ports, so tests inject the MC project
  // list through a fixture file instead of a stub HTTP server. Production
  // never sets this; the live fetch path is exercised against the real MC.
  const fixture = process.env.JOBTRACK_MC_SYNC_FIXTURE;
  if (fixture) {
    try {
      const body = JSON.parse(require('node:fs').readFileSync(fixture, 'utf8'));
      return Array.isArray(body.projects) ? body.projects : null;
    } catch {
      return null;
    }
  }
  try {
    const response = await fetch(`${mcBase()}/api/projects`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    const body = await response.json();
    return Array.isArray(body.projects) ? body.projects : null;
  } catch {
    return null;
  }
}

function requiredId(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new McSyncError('VALIDATION_ERROR', `${label} must be a positive integer`);
  }
  return parsed;
}

module.exports = {
  MC_SYNC_MIGRATION_NAME,
  MC_SYNC_SCHEMA_VERSION,
  McSyncError,
  migrateMcSync,
  runMcSyncCommand
};
