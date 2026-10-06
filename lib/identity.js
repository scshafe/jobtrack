'use strict';

const crypto = require('node:crypto');

const IDENTITY_MIGRATION_NAME = 'universal_uuid_identity';
const IDENTITY_SCHEMA_VERSION = 2026072802;

// SQLite internals never carry external identity; the migration registry is
// bookkeeping, not an entity.
const EXCLUDED_TABLES = new Set(['jobtrack_schema_migrations']);

const uuidFunctionRegistered = new WeakSet();

// Every durable table carries `uuid` as its stable external identifier while
// integer primary keys stay internal. The sweep runs last inside migrate() on
// every open, so tables created by newer migrations self-heal on the next
// boot. Assignment happens through UPDATE, which collides with the append-only
// / immutability BEFORE UPDATE guards many tables carry — those guards are
// dropped and restored atomically around the backfill (same maneuver as
// catalog.js dropOpportunityUpdateGuards), always inside the caller's
// transaction.
function sweepUuidIdentity(db) {
  const apply = () => {
    registerUuidFunction(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobtrack_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    for (const table of listIdentityTables(db)) {
      if (!columnExists(db, table, 'uuid')) {
        db.exec(`ALTER TABLE "${table}" ADD COLUMN uuid TEXT`);
      }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_${table}_uuid" ON "${table}"(uuid)`);
    }
    assignMissingUuids(db);
    const migration = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
      .get(IDENTITY_SCHEMA_VERSION);
    if (migration && migration.name !== IDENTITY_MIGRATION_NAME) {
      throw new Error(`Schema version ${IDENTITY_SCHEMA_VERSION} is already named ${migration.name}`);
    }
    if (!migration) {
      db.prepare('INSERT INTO jobtrack_schema_migrations (version, name) VALUES (?, ?)')
        .run(IDENTITY_SCHEMA_VERSION, IDENTITY_MIGRATION_NAME);
    }
  };
  if (db.inTransaction) apply();
  else db.transaction(apply).immediate();
}

// Runs at the end of every CLI command transaction: the CLI is the sole
// writer, so no commit leaves a NULL uuid behind, including rows inserted
// into guarded append-only tables during the command.
function assignMissingUuids(db) {
  registerUuidFunction(db);
  for (const table of listIdentityTables(db)) {
    if (!columnExists(db, table, 'uuid')) continue;
    if (!db.prepare(`SELECT 1 FROM "${table}" WHERE uuid IS NULL LIMIT 1`).get()) continue;
    withUpdateGuardsDropped(db, table, () => {
      db.prepare(`UPDATE "${table}" SET uuid=jobtrack_uuid() WHERE uuid IS NULL`).run();
    });
  }
}

function withUpdateGuardsDropped(db, table, fn) {
  const guards = db.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type='trigger' AND tbl_name=? AND sql IS NOT NULL AND upper(sql) LIKE '%BEFORE UPDATE%'
  `).all(table);
  for (const guard of guards) db.exec(`DROP TRIGGER "${guard.name}"`);
  try {
    fn();
  } finally {
    for (const guard of guards) db.exec(guard.sql);
  }
}

function listIdentityTables(db) {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
    ORDER BY name
  `).all().map((row) => row.name).filter((name) => !EXCLUDED_TABLES.has(name));
}

function registerUuidFunction(db) {
  if (uuidFunctionRegistered.has(db)) return;
  db.function('jobtrack_uuid', () => crypto.randomUUID());
  uuidFunctionRegistered.add(db);
}

function columnExists(db, table, column) {
  return db.pragma(`table_info("${table}")`).some((info) => info.name === column);
}

module.exports = {
  IDENTITY_MIGRATION_NAME,
  IDENTITY_SCHEMA_VERSION,
  assignMissingUuids,
  listIdentityTables,
  sweepUuidIdentity
};
