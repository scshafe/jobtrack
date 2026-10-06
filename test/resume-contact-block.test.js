'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { readProfileContactBlock, injectProfileContact, WORKER_FORBIDDEN_KEYS } = require('../lib/resume-contact-block');
const { expandMaterialTemplate } = require('../lib/material-templates');
const { migrateApplicationForm } = require('../lib/application-form');
const { migrateApplicationMaterials } = require('../lib/application-materials');
const { runApplicationMaterialsCommand } = require('../lib/application-materials-command');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');
const DENSE = require('./fixtures/material-templates-v4/dense-resume.json');
const { contact: FIXTURE_CONTACT, ...WORKER_PAYLOAD } = DENSE;

function cliStore(t, seed = true) {
  const { root: rootDir, home } = require('../test-support/migrated-store').createTestStore('jobtrack-contact-block-');
  const run = (args) => execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, stdio: ['ignore', 'pipe', 'pipe']
  });
  if (seed) {
    // The private fields (phone, street address) exist in the record and must never reach a payload.
    run(['profile', 'set-contact', '--name', 'Alex Example', '--email', 'alex_example+jobs@example.test',
      '--phone', '555-0100', '--location', 'Portland, OR', '--address-street', '1 Private Way', '--source', 'test']);
    run(['profile', 'add-link', '--kind', 'personal-website', '--url', 'https://alex.example.test', '--source', 'test']);
    run(['profile', 'add-link', '--kind', 'github', '--url', 'https://github.com/alex-example', '--source', 'test']);
    run(['profile', 'add-link', '--kind', 'linkedin', '--url', 'https://www.linkedin.com/in/alex-example', '--source', 'test']);
  }
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  migrateApplicationForm(db);
  migrateApplicationMaterials(db);
  t.after(() => { if (db.open) db.close(); fs.rmSync(rootDir, { recursive: true, force: true }); });
  return { rootDir, home, db };
}

test('the contact block is read from the approved profile record and profile links only', (t) => {
  const { db } = cliStore(t);
  const block = readProfileContactBlock(db);
  assert.deepEqual(block, FIXTURE_CONTACT);
  assert.deepEqual(Object.keys(block), ['name', 'email', 'location', 'github', 'linkedin']);
  assert.equal(JSON.stringify(block).includes('555-0100'), false, 'phone never enters the block');
  assert.equal(JSON.stringify(block).includes('Private Way'), false, 'street address never enters the block');
  assert.equal(JSON.stringify(block).includes('alex.example.test'), false, 'only GitHub and LinkedIn links are header links');
});

test('v4 injection replaces nothing the worker wrote: header keys are rejected, other templates pass through', (t) => {
  const { db } = cliStore(t);
  const injected = injectProfileContact(db, 'resume.standard.v4', WORKER_PAYLOAD);
  assert.deepEqual(injected, { contact: FIXTURE_CONTACT, ...WORKER_PAYLOAD });
  assert.equal(expandMaterialTemplate('resume.standard.v4', injected, 'resume'),
    fs.readFileSync(path.join(__dirname, 'fixtures', 'material-templates-v4', 'resume.standard.v4.golden.tex'), 'utf8'),
    'the injected payload reproduces the golden bytes');
  assert.deepEqual(WORKER_FORBIDDEN_KEYS, ['contact', 'name', 'contactLine', 'contactLinks']);
  for (const key of WORKER_FORBIDDEN_KEYS) {
    assert.throws(() => injectProfileContact(db, 'resume.standard.v4', { ...WORKER_PAYLOAD, [key]: 'worker wrote this' }),
      (error) => error.code === 'TEMPLATE_CONTACT_NOT_AUTHORED' && error.message.includes(key), key);
  }
  const v3 = { ...WORKER_PAYLOAD, name: 'Alex Example', contactLine: 'Portland, OR' };
  assert.equal(injectProfileContact(db, 'resume.standard.v3', v3), v3, 'v3 keeps its worker-authored header');
  assert.equal(injectProfileContact(db, 'resume.standard.v2', v3), v3);
});

test('a store without an approved contact record fails closed instead of drafting a headerless page', (t) => {
  const { db } = cliStore(t, false);
  assert.throws(() => injectProfileContact(db, 'resume.standard.v4', WORKER_PAYLOAD), (error) => error.code === 'PROFILE_CONTACT_MISSING');
});

test('lint-payload preflights a v4 worker payload with the injected header and rejects an authored one', (t) => {
  const { rootDir, db } = cliStore(t);
  const payloadPath = path.join(rootDir, 'payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify(WORKER_PAYLOAD));
  const result = runApplicationMaterialsCommand(db, ['lint-payload'], { template: 'resume.standard.v4', kind: 'resume', payloadFile: payloadPath });
  assert.equal(result.payloadValid, true);
  assert.equal(result.errorCount, 0);
  fs.writeFileSync(payloadPath, JSON.stringify({ ...WORKER_PAYLOAD, name: 'Alex Example' }));
  assert.throws(() => runApplicationMaterialsCommand(db, ['lint-payload'], { template: 'resume.standard.v4', kind: 'resume', payloadFile: payloadPath }),
    (error) => error.code === 'TEMPLATE_CONTACT_NOT_AUTHORED');
});
