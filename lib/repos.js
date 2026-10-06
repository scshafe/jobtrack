'use strict';

const REPO_GRAPH_MIGRATION_NAME = 'repo_graph';
const REPO_GRAPH_SCHEMA_VERSION = 2026072804;
const REPO_VISIBILITIES = Object.freeze(['public', 'private']);
const REPO_LINK_ROLES = Object.freeze(['primary', 'component', 'deploy-target', 'mirror', 'docs']);

class RepoGraphError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'RepoGraphError';
    this.code = code;
    this.details = details;
  }
}

// Repositories are entities identified by unique https URL; visibility gates
// what the public export may ever carry (private repos exist, linked and
// queryable, but never leave the store). Projects link to any number of
// repos through role-bearing joins with at most one primary.
function migrateRepoGraph(db) {
  const apply = () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL CHECK (trim(name)<>''),
        url TEXT NOT NULL UNIQUE CHECK (url LIKE 'https://%'),
        visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS profile_project_repos (
        profile_project_id INTEGER NOT NULL REFERENCES profile_projects(id) ON DELETE CASCADE,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE RESTRICT,
        role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary','component','deploy-target','mirror','docs')),
        position INTEGER NOT NULL DEFAULT 0 CHECK (position>=0),
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(profile_project_id, repo_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_project_repos_one_primary
        ON profile_project_repos(profile_project_id) WHERE is_primary=1;
      CREATE INDEX IF NOT EXISTS idx_profile_project_repos_repo
        ON profile_project_repos(repo_id, profile_project_id);
    `);
    backfillProjectRepos(db);
    const migration = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
      .get(REPO_GRAPH_SCHEMA_VERSION);
    if (migration && migration.name !== REPO_GRAPH_MIGRATION_NAME) {
      throw new RepoGraphError(
        'MIGRATION_CONFLICT',
        `Schema version ${REPO_GRAPH_SCHEMA_VERSION} is already named ${migration.name}`
      );
    }
    if (!migration) {
      db.prepare('INSERT INTO jobtrack_schema_migrations (version, name) VALUES (?, ?)')
        .run(REPO_GRAPH_SCHEMA_VERSION, REPO_GRAPH_MIGRATION_NAME);
    }
  };
  if (db.inTransaction) apply();
  else db.transaction(apply).immediate();
}

// Conservative, idempotent: existing profile_projects.url becomes the primary
// repo link (only at link-creation time, so operator demotions stick), and
// each https entry in profile_projects.links becomes a component link.
// Non-https strings are skipped, never guessed.
function backfillProjectRepos(db) {
  if (!tableExists(db, 'profile_projects')) return;
  for (const project of db.prepare('SELECT id, url, links FROM profile_projects ORDER BY id').all()) {
    if (isHttpsUrl(project.url)) {
      ensureLink(db, project.id, project.url, { role: 'primary', wantPrimary: true, position: 0 });
    }
    parseJsonList(project.links).filter(isHttpsUrl).forEach((url, index) => {
      if (url === project.url) return;
      ensureLink(db, project.id, url, { role: 'component', wantPrimary: false, position: index + 1 });
    });
  }
}

function ensureLink(db, projectId, url, { role, wantPrimary, position }) {
  const repo = ensureRepo(db, url);
  const existing = db.prepare(
    'SELECT 1 FROM profile_project_repos WHERE profile_project_id=? AND repo_id=?'
  ).get(projectId, repo.id);
  if (existing) return;
  const hasPrimary = Boolean(db.prepare(
    'SELECT 1 FROM profile_project_repos WHERE profile_project_id=? AND is_primary=1'
  ).get(projectId));
  db.prepare(`
    INSERT INTO profile_project_repos (profile_project_id, repo_id, role, position, is_primary)
    VALUES (?,?,?,?,?)
  `).run(projectId, repo.id, role, position, wantPrimary && !hasPrimary ? 1 : 0);
}

function ensureRepo(db, url, { name, visibility, notes } = {}) {
  const normalizedUrl = requiredHttpsUrl(url);
  const existing = db.prepare('SELECT * FROM repos WHERE url=?').get(normalizedUrl);
  if (existing) return existing;
  const info = db.prepare(`
    INSERT INTO repos (name, url, visibility, notes) VALUES (?,?,?,?)
  `).run(
    name || repoNameFromUrl(normalizedUrl),
    normalizedUrl,
    visibility || 'public',
    notes ?? null
  );
  return db.prepare('SELECT * FROM repos WHERE id=?').get(info.lastInsertRowid);
}

function runRepoCommand(db, args, flags) {
  const action = args[0];
  switch (action) {
    case 'add': {
      assertFlags(flags, ['name', 'url', 'visibility', 'notes'], 'repo add');
      const url = requiredHttpsUrl(flags.url);
      if (db.prepare('SELECT id FROM repos WHERE url=?').get(url)) {
        throw new RepoGraphError('CONFLICT', `A repo with url ${url} already exists (repo list to inspect)`);
      }
      const visibility = optionalText(flags.visibility) || 'public';
      if (!REPO_VISIBILITIES.includes(visibility)) {
        throw new RepoGraphError('VALIDATION_ERROR', `--visibility must be one of: ${REPO_VISIBILITIES.join(', ')}`);
      }
      const repo = ensureRepo(db, url, {
        name: optionalText(flags.name),
        visibility,
        notes: optionalText(flags.notes)
      });
      return { repo: serializeRepo(db, repo) };
    }
    case 'list': {
      assertFlags(flags, [], 'repo list');
      return {
        repos: db.prepare('SELECT * FROM repos ORDER BY name, id').all()
          .map((repo) => serializeRepo(db, repo))
      };
    }
    case 'update': {
      assertFlags(flags, ['url', 'name', 'visibility', 'notes'], 'repo update');
      const url = requiredHttpsUrl(flags.url);
      const repo = db.prepare('SELECT * FROM repos WHERE url=?').get(url);
      if (!repo) throw new RepoGraphError('NOT_FOUND', `No repo with url ${url}`);
      const name = optionalText(flags.name) ?? repo.name;
      const visibility = optionalText(flags.visibility) ?? repo.visibility;
      if (!REPO_VISIBILITIES.includes(visibility)) {
        throw new RepoGraphError('VALIDATION_ERROR', `--visibility must be one of: ${REPO_VISIBILITIES.join(', ')}`);
      }
      const notes = flags.notes !== undefined ? optionalText(flags.notes) : repo.notes;
      db.prepare("UPDATE repos SET name=?, visibility=?, notes=?, updated_at=datetime('now') WHERE id=?")
        .run(name, visibility, notes, repo.id);
      return { repo: serializeRepo(db, db.prepare('SELECT * FROM repos WHERE id=?').get(repo.id)) };
    }
    default:
      throw new RepoGraphError('UNKNOWN_COMMAND', 'Unknown repo command. Use: add, list, update.');
  }
}

function linkProjectRepo(db, flags) {
  const { entry, satellite } = resolveProjectEntry(db, flags);
  const url = requiredHttpsUrl(flags.url);
  const role = optionalText(flags.role) || 'component';
  if (!REPO_LINK_ROLES.includes(role)) {
    throw new RepoGraphError('VALIDATION_ERROR', `--role must be one of: ${REPO_LINK_ROLES.join(', ')}`);
  }
  const repo = ensureRepo(db, url, { name: optionalText(flags.name) });
  const hasPrimary = Boolean(db.prepare(
    'SELECT 1 FROM profile_project_repos WHERE profile_project_id=? AND is_primary=1'
  ).get(satellite.id));
  const makePrimary = Boolean(flags.primary) || !hasPrimary;
  if (flags.primary && hasPrimary) {
    db.prepare('UPDATE profile_project_repos SET is_primary=0 WHERE profile_project_id=? AND is_primary=1')
      .run(satellite.id);
  }
  const position = db.prepare(
    'SELECT COALESCE(MAX(position)+1,0) AS next FROM profile_project_repos WHERE profile_project_id=?'
  ).get(satellite.id).next;
  db.prepare(`
    INSERT INTO profile_project_repos (profile_project_id, repo_id, role, position, is_primary)
    VALUES (?,?,?,?,?)
    ON CONFLICT(profile_project_id, repo_id) DO UPDATE SET
      role=excluded.role,
      is_primary=CASE WHEN excluded.is_primary=1 THEN 1 ELSE profile_project_repos.is_primary END
  `).run(satellite.id, repo.id, role, position, makePrimary ? 1 : 0);
  return {
    link: {
      entryId: entry.id,
      entryTitle: entry.title,
      repoId: repo.id,
      repoName: repo.name,
      url: repo.url,
      visibility: repo.visibility,
      role,
      isPrimary: makePrimary
    }
  };
}

function unlinkProjectRepo(db, flags) {
  const { entry, satellite } = resolveProjectEntry(db, flags);
  const url = requiredHttpsUrl(flags.url);
  const repo = db.prepare('SELECT * FROM repos WHERE url=?').get(url);
  const info = repo
    ? db.prepare('DELETE FROM profile_project_repos WHERE profile_project_id=? AND repo_id=?').run(satellite.id, repo.id)
    : { changes: 0 };
  if (info.changes === 0) {
    throw new RepoGraphError('NOT_FOUND', `No repo link between entry ${entry.id} and ${url}`);
  }
  return { removed: { entryId: entry.id, entryTitle: entry.title, url } };
}

// Web read model: attaches repoLinks arrays onto project structured rows.
function attachProjectRepos(db, byId) {
  if (!tableExists(db, 'profile_project_repos') || !tableExists(db, 'repos')) return;
  const rows = db.prepare(`
    SELECT j.*, p.profile_entry_id AS profile_entry_id, r.name, r.url, r.visibility
    FROM profile_project_repos j
    JOIN profile_projects p ON p.id=j.profile_project_id
    JOIN repos r ON r.id=j.repo_id
    ORDER BY j.is_primary DESC, j.position, r.id
  `).all();
  for (const row of rows) {
    const entry = byId.get(row.profile_entry_id);
    if (!entry?.project) continue;
    if (!entry.project.repoLinks) entry.project.repoLinks = [];
    entry.project.repoLinks.push({
      name: row.name,
      url: row.url,
      role: row.role,
      visibility: row.visibility,
      isPrimary: Boolean(row.is_primary)
    });
  }
}

function serializeRepo(db, repo) {
  const linkCount = tableExists(db, 'profile_project_repos')
    ? db.prepare('SELECT count(*) AS count FROM profile_project_repos WHERE repo_id=?').get(repo.id).count
    : 0;
  return {
    id: repo.id,
    name: repo.name,
    url: repo.url,
    visibility: repo.visibility,
    notes: repo.notes ?? null,
    projectLinks: linkCount,
    createdAt: repo.created_at
  };
}

function resolveProjectEntry(db, flags) {
  const entryId = requiredId(flags.entryId ?? flags.id, '--entry-id');
  const entry = db.prepare('SELECT id, category, title FROM profile_entries WHERE id=?').get(entryId);
  if (!entry) throw new RepoGraphError('NOT_FOUND', `Profile entry ${entryId} not found`);
  if (entry.category !== 'project') {
    throw new RepoGraphError('VALIDATION_ERROR', `Repo links apply to project entries; entry ${entryId} is category '${entry.category}'`);
  }
  const satellite = db.prepare('SELECT * FROM profile_projects WHERE profile_entry_id=?').get(entryId);
  if (!satellite) {
    throw new RepoGraphError('INVARIANT_VIOLATION', `Structured project row is missing for profile entry ${entryId}`);
  }
  return { entry, satellite };
}

function repoNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || parsed.hostname;
    return last.replace(/\.git$/, '');
  } catch {
    return url;
  }
}

function requiredHttpsUrl(value, label = '--url') {
  const text = String(value ?? '').trim();
  if (!text) throw new RepoGraphError('VALIDATION_ERROR', `${label} is required`);
  if (!/^https:\/\/\S+$/.test(text)) {
    throw new RepoGraphError('VALIDATION_ERROR', `${label} must be an https:// URL`);
  }
  return text.replace(/\/+$/, '');
}

function isHttpsUrl(value) {
  return typeof value === 'string' && /^https:\/\/\S+$/.test(value.trim());
}

function parseJsonList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed.map((item) => String(item ?? '').trim()).filter(Boolean);
  } catch { /* legacy comma fallback below */ }
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function assertFlags(flags, allowed, scope) {
  const allowedSet = new Set(allowed);
  const invalid = Object.keys(flags).filter((key) => !allowedSet.has(key));
  if (invalid.length) {
    throw new RepoGraphError('INVALID_ARGUMENT', `Unknown flag(s) for ${scope}: ${invalid.sort().map((key) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(', ')}`);
  }
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function requiredId(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RepoGraphError('VALIDATION_ERROR', `${label} must be a positive integer`);
  }
  return parsed;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

module.exports = {
  REPO_GRAPH_MIGRATION_NAME,
  REPO_GRAPH_SCHEMA_VERSION,
  REPO_LINK_ROLES,
  REPO_VISIBILITIES,
  RepoGraphError,
  attachProjectRepos,
  ensureRepo,
  linkProjectRepo,
  migrateRepoGraph,
  runRepoCommand,
  unlinkProjectRepo
};
