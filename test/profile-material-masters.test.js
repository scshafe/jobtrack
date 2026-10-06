'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  MaterialMasterError,
  setMaterialMaster,
  getMaterialMaster,
  listMaterialMasters,
  masterBulletTexts
} = require('../lib/profile-material-masters');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

const MASTER_PAYLOAD = Object.freeze({
  name: 'Alex Example',
  contactLine: 'Springfield Metro Area | alex@example.test',
  summary: null,
  experience: [
    {
      title: 'Software Engineer',
      org: 'Example Docs Inc',
      location: 'Springfield Metro Area',
      dates: 'Mar 2025 - present',
      context: null,
      bullets: [
        'Built a typed schema registry spanning seven service domains with generated clients.',
        'Shipped a streaming job-status feed with durable event history persistence.'
      ]
    }
  ],
  projects: [],
  education: [],
  skills: [{ group: 'Languages', items: ['TypeScript', 'Go'] }]
});

function makeStore(t) {
  const home = require('../test-support/migrated-store').createTestHome('jobtrack-masters-');
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, db };
}

test('masters: human-authored, template-validated, dense append-only versions', (t) => {
  const { db } = makeStore(t);
  assert.equal(getMaterialMaster(db, 'resume'), null);

  assert.throws(
    () => setMaterialMaster(db, { kind: 'resume', templateKey: 'resume.standard.v2', payload: MASTER_PAYLOAD, authoredBy: '' }),
    (error) => error.code === 'MASTER_REQUIRES_HUMAN'
  );
  assert.throws(
    () => setMaterialMaster(db, { kind: 'resume', templateKey: 'resume.standard.v2', payload: MASTER_PAYLOAD, authoredBy: 'Alex', authorshipKind: 'agent' }),
    (error) => error.code === 'MASTER_REQUIRES_HUMAN'
  );
  assert.throws(
    () => setMaterialMaster(db, {
      kind: 'resume', templateKey: 'resume.standard.v2',
      payload: { ...MASTER_PAYLOAD, unknownKey: true }, authoredBy: 'Alex'
    }),
    /unknown key/
  );

  const first = setMaterialMaster(db, {
    kind: 'resume', templateKey: 'resume.standard.v2', payload: MASTER_PAYLOAD,
    authoredBy: 'Alex', changeNote: 'initial master'
  });
  assert.equal(first.master.version, 1);
  assert.equal(first.unchanged, false);
  assert.ok(Array.isArray(first.payloadLint));

  const replay = setMaterialMaster(db, {
    kind: 'resume', templateKey: 'resume.standard.v2', payload: MASTER_PAYLOAD, authoredBy: 'Alex'
  });
  assert.equal(replay.unchanged, true);
  assert.equal(replay.master.version, 1, 'an identical payload must not mint a new version');

  const second = setMaterialMaster(db, {
    kind: 'resume', templateKey: 'resume.standard.v2',
    payload: {
      ...MASTER_PAYLOAD,
      skills: [{ group: 'Languages', items: ['TypeScript', 'Go', 'Python'] }]
    },
    authoredBy: 'Alex', changeNote: 'added Python'
  });
  assert.equal(second.master.version, 2);
  assert.equal(getMaterialMaster(db, 'resume').version, 2);
  assert.equal(getMaterialMaster(db, 'resume', 1).version, 1);
  assert.equal(listMaterialMasters(db).length, 2);

  assert.throws(
    () => db.prepare('UPDATE profile_material_masters SET payload_json=? WHERE version=1').run('{}'),
    /immutable/
  );
});

test('masters: bullet texts extract whitespace-normalized for divergence checks', () => {
  const bullets = masterBulletTexts({ payload: MASTER_PAYLOAD });
  assert.equal(bullets.length, 2);
  assert.equal(bullets[0], 'Built a typed schema registry spanning seven service domains with generated clients.');
});

test('masters: CLI set/show/list round-trip', (t) => {
  const { home } = makeStore(t);
  const payloadPath = path.join(home, 'master.json');
  fs.writeFileSync(payloadPath, JSON.stringify(MASTER_PAYLOAD));
  const env = { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') };
  const set = JSON.parse(execFileSync(process.execPath, [
    cli, 'profile', 'set-material-master', '--kind', 'resume',
    '--template', 'resume.standard.v2', '--payload-file', payloadPath,
    '--authored-by', 'Alex', '--change-note', 'initial', '--json'
  ], { cwd: root, env, encoding: 'utf8' }));
  assert.equal(set.master.version, 1);

  const shown = JSON.parse(execFileSync(process.execPath, [
    cli, 'profile', 'show-material-master', '--kind', 'resume', '--json'
  ], { cwd: root, env, encoding: 'utf8' }));
  assert.equal(shown.master.payload.name, 'Alex Example');

  const listed = JSON.parse(execFileSync(process.execPath, [
    cli, 'profile', 'list-material-masters', '--json'
  ], { cwd: root, env, encoding: 'utf8' }));
  assert.equal(listed.masters.length, 1);
  assert.equal(listed.masters[0].kind, 'resume');
});
