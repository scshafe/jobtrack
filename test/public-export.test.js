'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { UUID_V4, validatePublicProfile, PublicExportError } = require('../lib/public-export');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('public-profile export is allowlisted, uuid-keyed, and leaks nothing sensitive', (t) => {
  const home = seededHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = cliJson(home, ['export', 'public-profile']);
  const artifact = result.artifact;

  assert.doesNotThrow(() => validatePublicProfile(artifact), 'artifact validates against the contract');

  const serialized = JSON.stringify(artifact);
  assert.doesNotMatch(
    serialized,
    /cole-secret|123-4567|185,000|She\/They|Riley Referee|SECRET-ANSWER-TEXT|H-1B|two weeks/,
    'no seeded sensitive value survives projection'
  );

  assert.deepEqual(Object.keys(artifact.contact).sort(), ['headline', 'name', 'professionalSummary']);
  assert.equal(artifact.contact.name, 'Cole S');
  assert.equal(result.counts.workEntries, 1);
  assert.equal(result.counts.education, 1);
  assert.equal(result.counts.projects, 1);
  assert.equal(result.counts.languages, 1);
  assert.equal(result.counts.publications, 1);
  assert.equal(result.counts.recognitions, 1);
  assert.equal(result.counts.links, 1);
  assert.equal(result.counts.volunteer, 1);
  assert.equal(result.counts.stories, 0);

  for (const section of ['workEntries', 'education', 'projects', 'skills', 'links', 'publications', 'recognitions', 'languages', 'volunteer']) {
    for (const entity of artifact[section]) assert.match(entity.uuid, UUID_V4, `${section} entity is uuid-keyed`);
  }
  const skillUuids = new Set(artifact.skills.map((skill) => skill.uuid));
  assert.equal(artifact.projects[0].skills.length, 1, 'project carries its linked skill');
  assert.ok(artifact.projects[0].skills.every((uuid) => skillUuids.has(uuid)), 'project skill refs resolve');
  assert.equal(artifact.workEntries[0].skills.length, 1, 'work entry carries its linked skill');

  assertNoRowIdKeys(artifact, '$');
});

test('export --out writes an owner-only file whose digest matches the report', (t) => {
  const home = seededHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const outPath = path.join(home, 'tmp', 'public-profile.json');
  const result = cliJson(home, ['export', 'public-profile', '--out', outPath]);

  assert.equal(result.written, outPath);
  const written = fs.readFileSync(outPath, 'utf8');
  assert.equal(result.bytes, Buffer.byteLength(written));
  assert.equal(
    result.sha256,
    require('node:crypto').createHash('sha256').update(written).digest('hex')
  );
  assert.equal(fs.statSync(outPath).mode & 0o777, 0o600, 'artifact file is owner-only');
  assert.doesNotThrow(() => validatePublicProfile(JSON.parse(written)));
});

test('validation fails closed on forbidden keys, leaked values, and unknown properties', (t) => {
  const home = seededHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { artifact } = cliJson(home, ['export', 'public-profile']);

  const withForbiddenKey = structuredClone(artifact);
  withForbiddenKey.contact.email = 'x@example.com';
  assert.throws(() => validatePublicProfile(withForbiddenKey), (error) =>
    error instanceof PublicExportError && error.code === 'CONTRACT_VIOLATION');

  const withLeakedValue = structuredClone(artifact);
  withLeakedValue.projects[0].highlights = 'Reach me at leaked@example.com for details';
  assert.throws(() => validatePublicProfile(withLeakedValue), (error) =>
    error instanceof PublicExportError && error.code === 'REDACTION_VIOLATION');

  const withPhoneValue = structuredClone(artifact);
  withPhoneValue.contact.professionalSummary = 'Call (415) 555-0123 4567 anytime';
  assert.throws(() => validatePublicProfile(withPhoneValue), (error) =>
    error instanceof PublicExportError && error.code === 'REDACTION_VIOLATION');

  const withExtraSection = structuredClone(artifact);
  withExtraSection.internalNotes = ['not public'];
  assert.throws(() => validatePublicProfile(withExtraSection), (error) =>
    error instanceof PublicExportError && error.code === 'CONTRACT_VIOLATION');

  const withRowId = structuredClone(artifact);
  withRowId.projects[0].applicationId = 7;
  assert.throws(() => validatePublicProfile(withRowId), (error) =>
    error instanceof PublicExportError && error.code === 'CONTRACT_VIOLATION');
});

test('v2 curation: hidden entries vanish, pinned sorts first, private repos never export, uses cross-refs resolve', (t) => {
  const home = seededHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const alpha = cliJson(home, ['profile', 'add-project', '--name', 'Alpha Uses', '--stack', 'TypeScript', '--source', 'test']);
  const bravo = cliJson(home, ['profile', 'add-project', '--name', 'Bravo Lib', '--stack', 'TypeScript', '--source', 'test']);
  const hidden = cliJson(home, ['profile', 'add-project', '--name', 'Hidden Secret Project', '--stack', 'TypeScript', '--source', 'test']);
  cliJson(home, ['profile', 'relate', '--entry-id', String(alpha.entry.id), '--to-entry-id', String(bravo.entry.id), '--relation', 'uses']);
  cliJson(home, ['profile', 'relate', '--entry-id', String(alpha.entry.id), '--to-entry-id', String(hidden.entry.id), '--relation', 'uses']);
  cliJson(home, ['profile', 'set-display', '--entry-id', String(hidden.entry.id), '--status', 'hidden']);
  cliJson(home, ['profile', 'set-display', '--entry-id', String(bravo.entry.id), '--status', 'pinned', '--order', '1']);
  cliJson(home, ['profile', 'project-kind', '--entry-id', String(bravo.entry.id), '--kind', 'library']);
  cliJson(home, ['repo', 'add', '--url', 'https://github.com/example/secret-repo', '--visibility', 'private']);
  cliJson(home, ['profile', 'link-repo', '--entry-id', String(alpha.entry.id), '--url', 'https://github.com/example/secret-repo', '--role', 'component']);
  cliJson(home, ['profile', 'link-repo', '--entry-id', String(alpha.entry.id), '--url', 'https://github.com/example/alpha-public', '--role', 'mirror']);

  const { artifact } = cliJson(home, ['export', 'public-profile']);
  assert.equal(artifact.contractVersion, 2);
  assert.ok(!JSON.stringify(artifact).includes('Hidden Secret Project'), 'hidden project fully absent');
  assert.equal(artifact.projects[0].name, 'Bravo Lib', 'pinned project sorts first');
  assert.equal(artifact.projects[0].pinned, true);
  assert.equal(artifact.projects[0].kind, 'library');

  const alphaOut = artifact.projects.find((project) => project.name === 'Alpha Uses');
  assert.deepEqual(alphaOut.uses, [artifact.projects[0].uuid], 'hidden target dropped from uses');
  assert.ok(!JSON.stringify(artifact).includes('secret-repo'), 'private repo url appears nowhere in the artifact');
  assert.ok(alphaOut.repos.some((repo) => repo.url === 'https://github.com/example/alpha-public'));
  assert.doesNotThrow(() => validatePublicProfile(artifact));
});

test('legacy url/links fields are scrubbed of private repo urls', (t) => {
  const home = seededHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = cliJson(home, ['profile', 'add-project', '--name', 'Legacy Link Project',
    '--url', 'https://github.com/example/private-legacy',
    '--links', 'https://github.com/example/private-legacy,https://example.com/public-page',
    '--stack', 'TypeScript', '--source', 'test']);
  cliJson(home, ['repo', 'update', '--url', 'https://github.com/example/private-legacy', '--visibility', 'private']);

  const { artifact } = cliJson(home, ['export', 'public-profile']);
  const out = artifact.projects.find((entry) => entry.name === 'Legacy Link Project');
  assert.equal(out.url, null, 'private url field scrubbed');
  assert.deepEqual(out.links, ['https://example.com/public-page'], 'private link scrubbed, public kept');
  assert.ok(!JSON.stringify(artifact).includes('private-legacy'), 'private repo url absent everywhere');
  assert.ok(project.entry.id, 'seed sanity');
});

test('stories cross only through the full public_bio permission chain', (t) => {
  const home = seededHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');

  seedStory(db, {
    title: 'Public Bio Story', content: 'A story cleared for the public site.',
    decision: 'allow', variantStatus: 'approved', sensitivity: 'normal'
  });
  seedStory(db, {
    title: 'Denied Story', content: 'Never leaves the store.',
    decision: 'deny', variantStatus: 'approved', sensitivity: 'normal'
  });
  seedStory(db, {
    title: 'Draft Story', content: 'Approved permission but unapproved variant.',
    decision: 'allow', variantStatus: 'draft', sensitivity: 'normal'
  });
  seedStory(db, {
    title: 'Sensitive Story', content: 'Allowed but sensitive.',
    decision: 'allow', variantStatus: 'approved', sensitivity: 'sensitive'
  });
  db.close();

  // Any CLI command backfills uuids for the directly seeded fixture rows.
  cliJson(home, ['search']);
  const { artifact } = cliJson(home, ['export', 'public-profile']);

  assert.equal(artifact.stories.length, 1, 'only the fully cleared story exports');
  assert.equal(artifact.stories[0].title, 'Public Bio Story');
  assert.match(artifact.stories[0].uuid, UUID_V4);
  const serialized = JSON.stringify(artifact);
  assert.doesNotMatch(serialized, /Never leaves the store|unapproved variant|Allowed but sensitive/);
  assert.doesNotThrow(() => validatePublicProfile(artifact));
});

function assertNoRowIdKeys(value, at) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRowIdKeys(item, `${at}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'uuid') {
        assert.ok(!/id$/i.test(key), `${at}.${key} must not expose row identifiers`);
      }
      assertNoRowIdKeys(child, `${at}.${key}`);
    }
  }
}

function seedStory(db, { title, content, decision, variantStatus, sensitivity }) {
  const entry = db.prepare(
    "INSERT INTO profile_entries (category, title, content, source, confidence) VALUES ('story', ?, ?, 'test', 'high')"
  ).run(title, content);
  const story = db.prepare(
    "INSERT INTO profile_stories (profile_entry_id, status, sensitivity) VALUES (?, 'ready', ?)"
  ).run(entry.lastInsertRowid, sensitivity);
  const revision = db.prepare(`
    INSERT INTO profile_story_revisions (story_id, revision_number, title, canonical_text)
    VALUES (?, 1, ?, ?)
  `).run(story.lastInsertRowid, title, content);
  db.prepare(`
    INSERT INTO profile_story_variants (
      story_id, variant_key, version, based_on_revision_id, purpose, medium, length_class,
      content, word_count, status, is_current
    ) VALUES (?, 'public-bio', 1, ?, 'public_bio', 'written', 'short', ?, ?, ?, 1)
  `).run(story.lastInsertRowid, revision.lastInsertRowid, content, content.split(/\s+/).length, variantStatus);
  db.prepare(`
    INSERT INTO profile_story_permissions (story_id, purpose, decision, approved_by)
    VALUES (?, 'public_bio', ?, 'cole')
  `).run(story.lastInsertRowid, decision);
}

function seededHome() {
  const home = makeHome('jobtrack-public-export-');
  runCli(home, ['profile', 'set-contact',
    '--name', 'Cole S', '--headline', 'Systems engineer', '--summary', 'Builds durable agent systems.',
    '--email', 'cole-secret@example.com', '--phone', '+1 (555) 123-4567',
    '--compensation', '185,000 USD base', '--notice-period', 'two weeks',
    '--work-authorization', 'US Citizen', '--sponsorship', 'H-1B not required',
    '--source', 'test']);
  runCli(home, ['profile', 'add-skill', '--name', 'TypeScript', '--group', 'language', '--proficiency', 'advanced', '--source', 'test']);
  const work = cliJson(home, ['profile', 'add-work',
    '--company', 'TestCo', '--role', 'Systems Engineer', '--start-date', '2024-01', '--end-date', '2025-01',
    '--location', 'Remote', '--highlights', 'Shipped the widget pipeline end to end', '--source', 'test']);
  runCli(home, ['profile', 'add-education',
    '--institution', 'State University', '--degree', 'BS', '--field', 'Computer Science',
    '--start-date', '2016-09', '--end-date', '2020-05', '--honors', 'magna cum laude', '--source', 'test']);
  const project = cliJson(home, ['profile', 'add-project',
    '--name', 'Demo Pipeline', '--description', 'A demonstration data pipeline.', '--stack', 'TypeScript',
    '--role', 'Builder', '--url', 'https://example.com/demo', '--links', 'https://github.com/example/demo',
    '--start-date', '2025-02', '--highlights', 'Processed the demo corpus deterministically', '--source', 'test']);
  runCli(home, ['profile', 'add-language', '--language', 'Spanish', '--proficiency', 'Conversational', '--source', 'test']);
  runCli(home, ['profile', 'add-publication', '--title', 'SQLite at Scale', '--publisher', 'ExampleConf', '--published-at', '2025-03', '--source', 'test']);
  runCli(home, ['profile', 'add-award', '--title', 'Launch Award', '--issuer', 'TestCo', '--awarded-at', '2024-12', '--source', 'test']);
  runCli(home, ['profile', 'add-link', '--kind', 'github', '--url', 'https://github.com/example', '--username', 'example', '--source', 'test']);
  runCli(home, ['profile', 'add-volunteer', '--organization', 'Open Source Guild', '--role', 'Mentor', '--start-date', '2023-01', '--end-date', '2023-12', '--source', 'test']);
  runCli(home, ['profile', 'add-answer', '--question', 'Why this role?', '--answer', 'SECRET-ANSWER-TEXT do not export', '--source', 'test']);
  runCli(home, ['profile', 'add-reference', '--name', 'Riley Referee', '--contact', 'riley-ref@example.com', '--company', 'TestCo', '--source', 'test']);
  runCli(home, ['profile', 'set-eeo', '--gender', 'Female', '--pronouns', 'She/They', '--veteran', 'No', '--disability', 'No', '--source', 'test']);

  runCli(home, ['profile', 'skill-link', '--entry-id', String(work.entry.id), '--skill', 'typescript', '--source', 'repo_mining', '--evidence', 'Shipped in TypeScript']);
  runCli(home, ['profile', 'skill-link', '--entry-id', String(project.entry.id), '--skill', 'typescript', '--source', 'repo_mining', '--evidence', 'Project implemented in TypeScript']);
  return home;
}

function makeHome(prefix) {
  const home = require('../test-support/migrated-store').createTestHome(prefix);
  fs.mkdirSync(path.join(home, 'tmp'));
  return home;
}

function runCli(home, args) {
  execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    stdio: 'pipe'
  });
}

function cliJson(home, args) {
  const stdout = execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    encoding: 'utf8'
  });
  return JSON.parse(stdout);
}
