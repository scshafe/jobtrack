'use strict';

const PROFILE_PRESENTATION_MIGRATION_NAME = 'profile_presentation_controls';
const PROFILE_PRESENTATION_SCHEMA_VERSION = 2026072803;
const DISPLAY_STATUSES = Object.freeze(['pinned', 'visible', 'hidden']);

class ProfilePresentationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ProfilePresentationError';
    this.code = code;
    this.details = details;
  }
}

// Curation lives on the profile spine: one status + one order column covers
// every entry type uniformly. Hidden entries stay visible in the private web
// view; only the public export (contract v2) excludes them.
function migrateProfilePresentation(db) {
  const apply = () => {
    ensureColumn(
      db, 'profile_entries', 'display_status',
      "TEXT NOT NULL DEFAULT 'visible' CHECK (display_status IN ('pinned','visible','hidden'))"
    );
    ensureColumn(db, 'profile_entries', 'display_order', 'INTEGER');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_entries_display
        ON profile_entries(display_status, display_order);
    `);
    const migration = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
      .get(PROFILE_PRESENTATION_SCHEMA_VERSION);
    if (migration && migration.name !== PROFILE_PRESENTATION_MIGRATION_NAME) {
      throw new ProfilePresentationError(
        'MIGRATION_CONFLICT',
        `Schema version ${PROFILE_PRESENTATION_SCHEMA_VERSION} is already named ${migration.name}`
      );
    }
    if (!migration) {
      db.prepare('INSERT INTO jobtrack_schema_migrations (version, name) VALUES (?, ?)')
        .run(PROFILE_PRESENTATION_SCHEMA_VERSION, PROFILE_PRESENTATION_MIGRATION_NAME);
    }
  };
  if (db.inTransaction) apply();
  else db.transaction(apply).immediate();
}

function setProfileDisplay(db, flags) {
  const entryId = requiredId(flags.entryId ?? flags.id, '--entry-id');
  const entry = db.prepare(
    'SELECT id, category, title, display_status, display_order FROM profile_entries WHERE id=?'
  ).get(entryId);
  if (!entry) throw new ProfilePresentationError('NOT_FOUND', `Profile entry ${entryId} not found`);

  const hasStatus = flags.status !== undefined;
  const hasOrder = flags.order !== undefined;
  const hasClear = Boolean(flags.clearOrder);
  if (!hasStatus && !hasOrder && !hasClear) {
    throw new ProfilePresentationError('VALIDATION_ERROR', 'Provide --status, --order, or --clear-order');
  }
  if (hasOrder && hasClear) {
    throw new ProfilePresentationError('VALIDATION_ERROR', '--order and --clear-order are mutually exclusive');
  }

  let status = entry.display_status;
  if (hasStatus) {
    status = String(flags.status).trim().toLowerCase();
    if (!DISPLAY_STATUSES.includes(status)) {
      throw new ProfilePresentationError(
        'VALIDATION_ERROR',
        `--status must be one of: ${DISPLAY_STATUSES.join(', ')}`
      );
    }
  }

  let order = entry.display_order;
  if (hasOrder) {
    const parsed = Number(flags.order);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new ProfilePresentationError('VALIDATION_ERROR', '--order must be a non-negative integer');
    }
    order = parsed;
  }
  if (hasClear) order = null;

  // Curation is presentation state, not content freshness: updated_at is
  // deliberately untouched so recency ordering and evidence trails survive.
  db.prepare('UPDATE profile_entries SET display_status=?, display_order=? WHERE id=?')
    .run(status, order, entryId);
  return {
    entry: {
      id: entry.id,
      category: entry.category,
      title: entry.title,
      displayStatus: status,
      displayOrder: order ?? null
    }
  };
}

// Shared ordering for the web view now and the v2 export later:
// pinned -> visible -> hidden, then explicit display_order (NULLs last),
// then recency, then id.
/**
 * The operator's explicit curation, and only that: pinned before visible before
 * hidden, then an explicit display_order with unordered entries last. Returns 0
 * when two entries are curated identically, leaving the caller to decide what
 * "most recent" means for its own records.
 *
 * Split out because the web profile sorts entries by the date they DESCRIBE
 * (a job's end date, a talk's publication date), which is only knowable after
 * the structured sub-records are attached — later than this comparator runs.
 * Both callers must nonetheless honour the same curation rules, so they live
 * here once.
 */
function compareCuration(a, b) {
  const byStatus = displayRank(a.display_status) - displayRank(b.display_status);
  if (byStatus) return byStatus;
  const aOrder = a.display_order ?? null;
  const bOrder = b.display_order ?? null;
  if (aOrder !== null || bOrder !== null) {
    if (aOrder === null) return 1;
    if (bOrder === null) return -1;
    if (aOrder !== bOrder) return aOrder - bOrder;
  }
  return 0;
}

function compareDisplay(a, b) {
  const byCuration = compareCuration(a, b);
  if (byCuration) return byCuration;
  const aTime = Date.parse(a.updated_at || a.created_at || '') || 0;
  const bTime = Date.parse(b.updated_at || b.created_at || '') || 0;
  if (bTime !== aTime) return bTime - aTime;
  return Number(b.id || 0) - Number(a.id || 0);
}

function sortByDisplay(rows) {
  return [...rows].sort(compareDisplay);
}

function displayRank(status) {
  if (status === 'pinned') return 0;
  if (status === 'hidden') return 2;
  return 1;
}

function requiredId(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ProfilePresentationError('VALIDATION_ERROR', `${label} must be a positive integer`);
  }
  return parsed;
}

function columnExists(db, table, column) {
  return db.pragma(`table_info(${table})`).some((info) => info.name === column);
}

function ensureColumn(db, table, column, definition) {
  if (columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

module.exports = {
  DISPLAY_STATUSES,
  PROFILE_PRESENTATION_MIGRATION_NAME,
  PROFILE_PRESENTATION_SCHEMA_VERSION,
  ProfilePresentationError,
  compareCuration,
  compareDisplay,
  migrateProfilePresentation,
  setProfileDisplay,
  sortByDisplay
};
