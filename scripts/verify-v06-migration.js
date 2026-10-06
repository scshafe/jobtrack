#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');
const sourcePath = path.resolve(process.argv[2] || process.env.JOBTRACK_DB || path.join(os.homedir(), '.jobtrack', 'jobtrack.db'));

main().catch((error) => {
  process.stderr.write(`v0.6 migration verification failed: ${error.message}\n`);
  process.exitCode = 1;
});

async function main() {
  const rehearsalHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-v06-migration-'));
  fs.chmodSync(rehearsalHome, 0o700);
  const rehearsalDb = path.join(rehearsalHome, 'jobtrack.db');
  try {
    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      await source.backup(rehearsalDb);
    } finally {
      source.close();
    }
    fs.chmodSync(rehearsalDb, 0o600);

    const before = new Database(rehearsalDb, { readonly: true, fileMustExist: true });
    const inherited = snapshotTables(before, { exclude: new Set(['jobtrack_schema_migrations']) });
    const sourceQuickCheck = before.pragma('quick_check', { simple: true });
    const sourceForeignKeys = before.pragma('foreign_key_check');
    const sourceUserVersion = before.pragma('user_version', { simple: true });
    before.close();
    assert(sourceQuickCheck === 'ok', `source quick_check returned ${sourceQuickCheck}`);
    assert(sourceForeignKeys.length === 0, `source has ${sourceForeignKeys.length} foreign-key violation(s)`);

    runMigration(rehearsalHome);
    const migrated = new Database(rehearsalDb, { readonly: true, fileMustExist: true });
    assertInheritedUnchanged(migrated, inherited);
    const afterFirst = snapshotTables(migrated);
    const firstQuickCheck = migrated.pragma('quick_check', { simple: true });
    const firstForeignKeys = migrated.pragma('foreign_key_check');
    const userVersion = migrated.pragma('user_version', { simple: true });
    const migrations = migrated.prepare(`
      SELECT version,name FROM jobtrack_schema_migrations
      WHERE version IN (2026071801,2026071802,2026071803) ORDER BY version
    `).all();
    const invented = inventedStateCounts(migrated);
    const unexpectedBindings = unexpectedBindingCounts(migrated);
    migrated.close();

    assert(firstQuickCheck === 'ok', `migrated quick_check returned ${firstQuickCheck}`);
    assert(firstForeignKeys.length === 0, `migrated store has ${firstForeignKeys.length} foreign-key violation(s)`);
    assert(userVersion === 11, `expected user_version 11, found ${userVersion}`);
    assert(stableJson(migrations) === stableJson([
      { version: 2026071801, name: 'application_strategy_control_plane' },
      { version: 2026071802, name: 'recipient_aware_email_communication_style' },
      { version: 2026071803, name: 'latex_application_material_rendering' }
    ]), 'v0.6 migration ledger is not exact');
    for (const [table, count] of Object.entries(invented)) {
      assert(count === 0, `${table} unexpectedly contains ${count} invented row(s)`);
    }
    for (const [binding, count] of Object.entries(unexpectedBindings)) {
      assert(count === 0, `${binding} unexpectedly contains ${count} migrated binding(s)`);
    }

    runMigration(rehearsalHome);
    const replayed = new Database(rehearsalDb, { readonly: true, fileMustExist: true });
    const afterSecond = snapshotTables(replayed);
    const replayQuickCheck = replayed.pragma('quick_check', { simple: true });
    const replayForeignKeys = replayed.pragma('foreign_key_check');
    replayed.close();
    assert(stableJson(afterSecond) === stableJson(afterFirst), 'migration replay changed table data');
    assert(replayQuickCheck === 'ok', `replayed quick_check returned ${replayQuickCheck}`);
    assert(replayForeignKeys.length === 0, `replayed store has ${replayForeignKeys.length} foreign-key violation(s)`);

    process.stdout.write(`${JSON.stringify({
      source: { userVersion: sourceUserVersion, inheritedTables: Object.keys(inherited).length },
      migrated: { userVersion, migrations, invented, unexpectedBindings, quickCheck: firstQuickCheck, foreignKeyViolations: 0 },
      replay: { byteStableTableProjections: true, quickCheck: replayQuickCheck, foreignKeyViolations: 0 }
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(rehearsalHome, { recursive: true, force: true });
  }
}

function runMigration(home) {
  const result = spawnSync(process.execPath, [cli, 'init', '--json'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr || result.stdout || result.error?.message || 'JobTrack migration command failed');
  }
}

function snapshotTables(db, options = {}) {
  const excluded = options.exclude || new Set();
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all().map((row) => row.name).filter((name) => !excluded.has(name));
  return Object.fromEntries(tables.map((table) => {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => row.name);
    const projection = columns.map(quoteIdentifier).join(',');
    const rows = db.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table)}`).all()
      .map(stableJson).sort();
    return [table, { columns, count: rows.length, sha256: sha256(rows.join('\n')) }];
  }));
}

function assertInheritedUnchanged(db, inherited) {
  for (const [table, baseline] of Object.entries(inherited)) {
    const projection = baseline.columns.map(quoteIdentifier).join(',');
    const rows = db.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table)}`).all()
      .map(stableJson).sort();
    const current = { count: rows.length, sha256: sha256(rows.join('\n')) };
    assert(current.count === baseline.count && current.sha256 === baseline.sha256,
      `inherited table ${table} changed during migration`);
  }
}

function inventedStateCounts(db) {
  const tables = [
    'strategy_routing_policy_revisions', 'strategy_routing_policy_review_events',
    'strategy_routing_policy_current', 'strategy_routing_policy_selection_events',
    'application_strategy_revisions', 'application_strategy_review_events',
    'application_strategy_current', 'application_strategy_selection_events',
    'application_strategy_work_items', 'application_strategy_work_dependencies',
    'application_strategy_work_requests', 'application_strategy_work_results',
    'application_strategy_work_events', 'application_strategy_work_bindings',
    'application_strategy_source_checkpoint_events', 'application_strategy_operations',
    'job_email_contact_binding_events', 'job_email_demeanor_observations',
    'job_email_recipient_style_profiles', 'job_email_style_profile_observations',
    'job_email_style_profile_review_events', 'job_email_style_profile_selections',
    'job_email_style_profile_selection_events', 'profile_email_writing_voices',
    'profile_email_writing_voice_revisions', 'profile_email_writing_voice_review_events',
    'profile_email_writing_voice_current', 'profile_email_writing_voice_selection_events',
    'job_email_tone_decisions', 'job_email_reply_draft_style_bindings',
    'job_email_communication_operations', 'application_material_renders'
  ];
  return Object.fromEntries(tables.map((table) => [
    table,
    Number(db.prepare(`SELECT count(*) AS count FROM ${quoteIdentifier(table)}`).get().count)
  ]));
}

function unexpectedBindingCounts(db) {
  return {
    materialReviewRenderIds: Number(db.prepare(`
      SELECT count(*) AS count FROM application_material_review_events WHERE render_id IS NOT NULL
    `).get().count),
    packageSnapshotRenderIds: Number(db.prepare(`
      SELECT count(*) AS count FROM application_package_preparation_snapshots
      WHERE resume_render_id IS NOT NULL OR cover_letter_render_id IS NOT NULL
    `).get().count),
    nonLegacyMaterialContracts: Number(db.prepare(`
      SELECT count(*) AS count FROM application_material_revisions
      WHERE source_format<>'legacy-text' OR generation_contract_version<>'legacy-unversioned'
    `).get().count)
  };
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Buffer.isBuffer(value)) return { $buffer: value.toString('hex') };
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
