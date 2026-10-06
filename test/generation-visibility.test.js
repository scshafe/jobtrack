'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { buildApplicationMaterialsContext, migrateApplicationMaterials } = require('../lib/application-materials');
const { migrateApplicationForm } = require('../lib/application-form');
const { setGenerationVisibility, ProfileNormalizationError } = require('../lib/profile-normalization');
const { runCatalogCommand, syncLegacyApplicationCatalog } = require('../lib/catalog-command');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

function createStore(t) {
  const { root: rootDir, home } = require('../test-support/migrated-store').createTestStore('jobtrack-genvis-');
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  migrateApplicationForm(db);
  migrateApplicationMaterials(db);
  const fixture = { root: rootDir, home, db };
  t.after(() => { if (db.open) db.close(); fs.rmSync(rootDir, { recursive: true, force: true }); });
  return fixture;
}

function addProspect(home, company, role) {
  return JSON.parse(execFileSync(process.execPath, [
    cli, 'add-prospect', '--company', company, '--role', role,
    '--url', `https://${company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example.test/jobs/1`, '--json'
  ], { cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).application;
}

function addEntry(db, title) {
  return Number(db.prepare(`
    INSERT INTO profile_entries(category,title,content,source,confidence,tags)
    VALUES ('work',?,?,'test','high','[]')
  `).run(title, `${title} content`).lastInsertRowid);
}

test('hidden entries vanish from the catalog and fail closed on selection', (t) => {
  const fixture = createStore(t);
  const application = addProspect(fixture.home, 'Acme Robotics', 'Platform Engineer');
  const artifactId = Number(fixture.db.prepare(`
    INSERT INTO application_artifacts(application_id,kind,title,content) VALUES (?,?,?,?)
  `).run(application.id, 'posting', 'posting evidence', 'Posting content').lastInsertRowid);
  const visibleId = addEntry(fixture.db, 'Visible role');
  const secretId = addEntry(fixture.db, 'Sensitive role');

  const before = buildApplicationMaterialsContext(fixture.db, application.id, { kind: 'resume' });
  const catalogIds = before.availableSources.profileEntries.map((entry) => entry.id);
  assert.ok(catalogIds.includes(visibleId) && catalogIds.includes(secretId));

  const hiddenResult = JSON.parse(execFileSync(process.execPath, [
    cli, 'profile', 'set-generation-visibility', '--entry-id', String(secretId), '--hidden', 'true', '--json'
  ], { cwd: root, env: { ...process.env, JOBTRACK_HOME: fixture.home, JOBTRACK_DB: path.join(fixture.home, 'jobtrack.db') }, encoding: 'utf8' }));
  assert.equal(hiddenResult.entry.generation_hidden, 1);
  assert.equal(hiddenResult.changed, true);

  const after = buildApplicationMaterialsContext(fixture.db, application.id, { kind: 'resume' });
  const afterIds = after.availableSources.profileEntries.map((entry) => entry.id);
  assert.ok(afterIds.includes(visibleId));
  assert.equal(afterIds.includes(secretId), false, 'hidden entries must not be offered as material');

  assert.throws(() => buildApplicationMaterialsContext(fixture.db, application.id, {
    kind: 'resume', artifactIds: [artifactId], profileEntryIds: [secretId]
  }), (error) => error.code === 'SOURCE_SCOPE_MISMATCH', 'selecting a hidden entry must fail closed');

  setGenerationVisibility(fixture.db, { entryId: secretId, hidden: false });
  const restored = buildApplicationMaterialsContext(fixture.db, application.id, { kind: 'resume' });
  assert.ok(restored.availableSources.profileEntries.some((entry) => entry.id === secretId));

  assert.throws(
    () => setGenerationVisibility(fixture.db, { entryId: secretId, hidden: 'yes' }),
    (error) => error instanceof ProfileNormalizationError && error.code === 'INVALID_INPUT'
  );
  assert.throws(() => execFileSync(process.execPath, [
    cli, 'profile', 'set-generation-visibility', '--entry-id', String(secretId), '--json'
  ], { cwd: root, env: { ...process.env, JOBTRACK_HOME: fixture.home, JOBTRACK_DB: path.join(fixture.home, 'jobtrack.db') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
});

test('the context catalog exposes the linked posting skill requirements for tailoring', (t) => {
  const fixture = createStore(t);
  const application = addProspect(fixture.home, 'Systems Lab', 'Senior Platform Engineer');

  // The legacy sync materializes the opening + posting from the application's
  // job URL and sets the primary posting link — the same path real
  // applications take into the normalized catalog.
  syncLegacyApplicationCatalog(fixture.db, application.id);
  const postingId = fixture.db.prepare('SELECT primary_job_posting_id AS id FROM applications WHERE id=?')
    .get(application.id).id;
  assert.ok(postingId, 'sync must set the primary posting');

  const go = runCatalogCommand(fixture.db, ['skill', 'upsert'], { name: 'Go', category: 'languages' }).skill;
  const tf = runCatalogCommand(fixture.db, ['skill', 'upsert'], { name: 'Terraform', category: 'infrastructure' }).skill;
  runCatalogCommand(fixture.db, ['posting', 'add-skill-requirement'], {
    postingId, skillId: go.id, requirementKind: 'required', rawPhrase: 'Expert Go'
  });
  runCatalogCommand(fixture.db, ['posting', 'add-skill-requirement'], {
    postingId, skillId: tf.id, requirementKind: 'preferred', rawPhrase: 'Terraform a plus'
  });

  const context = buildApplicationMaterialsContext(fixture.db, application.id, { kind: 'resume' });
  const requirements = context.availableSources.postingSkillRequirements;
  assert.equal(requirements.length, 2);
  assert.equal(requirements[0].requirement_kind, 'required', 'required skills sort first');
  assert.equal(requirements[0].skill, 'Go');
  assert.equal(requirements[0].raw_phrase, 'Expert Go');
  assert.equal(requirements[1].requirement_kind, 'preferred');

  const unlinked = addProspect(fixture.home, 'Northwind Labs', 'Staff Engineer');
  const bare = buildApplicationMaterialsContext(fixture.db, unlinked.id, { kind: 'resume' });
  assert.deepEqual(bare.availableSources.postingSkillRequirements, [], 'no linked posting means no requirements');
});
