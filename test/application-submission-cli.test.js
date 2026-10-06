'use strict';

// The application-submission lane through the CLI itself: propose from files,
// approve, claim, settle, state — and every fence biting through spawned
// processes exactly as it bites in-process. The applysim cycle orchestrator
// will drive this surface, so the CLI contract (flags, JSON errors with codes,
// idempotent replays) is what these tests pin.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

function createStore(t) {
  const { root: rootDir, home } = require('../test-support/migrated-store').createTestStore('jobtrack-submission-cli-');
  const fixture = { root: rootDir, home };
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return fixture;
}

/** Run the CLI with --json; return parsed stdout. */
function run(home, args) {
  const stdout = execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return JSON.parse(stdout);
}

/** Run the CLI expecting failure; return the structured error payload. */
function runExpectingError(home, args) {
  try {
    run(home, args);
  } catch (error) {
    const stderr = String(error.stderr || '');
    try {
      return JSON.parse(stderr).error;
    } catch {
      throw new Error(`CLI failed without a structured error payload: ${stderr.slice(0, 400)}`);
    }
  }
  throw new Error(`Expected the CLI to fail: jobtrack ${args.join(' ')}`);
}

function addProspect(home, company, role) {
  return run(home, [
    'add-prospect', '--company', company, '--role', role,
    '--url', `https://${company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example.test/jobs/1`
  ]).application;
}

function writeJson(dir, name, value) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  return filePath;
}

test('the CLI lane arc: propose, approve, claim, settle, state — idempotent and digest-bound', (t) => {
  const fixture = createStore(t);
  const application = addProspect(fixture.home, 'Arc Robotics', 'Platform Engineer');
  const answersFile = writeJson(fixture.root, 'answers.json', { availability: 'two weeks', relocation: 'no' });
  const documentsFile = writeJson(fixture.root, 'documents.json', {
    resume: 'a'.repeat(64),
    'cover-letter': 'b'.repeat(64)
  });
  const propose = [
    'application-submission', 'propose',
    '--application-id', String(application.id),
    '--surface-id', 'https://careers.arc.test/apply/7',
    '--intent-id', 'arc-intent',
    '--answers-file', answersFile,
    '--documents-file', documentsFile
  ];

  const proposed = run(fixture.home, propose);
  assert.match(proposed.intentDigest, /^[0-9a-f]{64}$/);
  assert.equal(proposed.source.mode, 'files');
  assert.equal(proposed.reused, false);
  assert.equal(run(fixture.home, propose).reused, true, 'same intent id + same content replays');

  // Same intent id with different content is a conflict, not an overwrite.
  const editedAnswers = writeJson(fixture.root, 'answers-edited.json', { availability: 'immediately' });
  const conflict = runExpectingError(fixture.home, [
    'application-submission', 'propose',
    '--application-id', String(application.id),
    '--surface-id', 'https://careers.arc.test/apply/7',
    '--intent-id', 'arc-intent',
    '--answers-file', editedAnswers,
    '--documents-file', documentsFile
  ]);
  assert.equal(conflict.code, 'INTENT_CONFLICT');

  const badDigest = runExpectingError(fixture.home, [
    'application-submission', 'approve',
    '--intent-id', 'arc-intent',
    '--expected-intent-digest', 'f'.repeat(64),
    '--approver-kind', 'human',
    '--approver-id', 'Cole',
    '--approval-id', 'arc-approval'
  ]);
  assert.equal(badDigest.code, 'INTENT_DIGEST_MISMATCH');

  const approved = run(fixture.home, [
    'application-submission', 'approve',
    '--intent-id', 'arc-intent',
    '--expected-intent-digest', proposed.intentDigest,
    '--approver-kind', 'human',
    '--approver-id', 'Cole',
    '--approval-id', 'arc-approval'
  ]);
  assert.equal(approved.approval.approver.kind, 'human');
  assert.ok(approved.signature, 'the approval is signed');

  const claimed = run(fixture.home, [
    'application-submission', 'claim',
    '--approval-id', 'arc-approval',
    '--attempt-id', 'arc-attempt-1'
  ]);
  assert.equal(claimed.oneSubmitIdempotencyKey, 'arc-approval-once');

  // An unsettled attempt fences the next claim...
  const fencedOpen = runExpectingError(fixture.home, [
    'application-submission', 'claim', '--approval-id', 'arc-approval', '--attempt-id', 'arc-attempt-2'
  ]);
  assert.equal(fencedOpen.code, 'ATTEMPT_UNRECONCILED');

  // ...and settling FAILED frees exactly one more, which lands.
  run(fixture.home, ['application-submission', 'settle', '--attempt-id', 'arc-attempt-1', '--outcome', 'failed']);
  run(fixture.home, ['application-submission', 'claim', '--approval-id', 'arc-approval', '--attempt-id', 'arc-attempt-2']);
  const settled = run(fixture.home, [
    'application-submission', 'settle',
    '--attempt-id', 'arc-attempt-2',
    '--outcome', 'accepted',
    '--external-reference', 'confirmation #ARC-9',
    '--evidence-file', writeJson(fixture.root, 'evidence.json', { confirmationPage: 'Thanks for applying' })
  ]);
  assert.match(settled.evidenceDigest, /^[0-9a-f]{64}$/);

  const spent = runExpectingError(fixture.home, [
    'application-submission', 'claim', '--approval-id', 'arc-approval', '--attempt-id', 'arc-attempt-3'
  ]);
  assert.equal(spent.code, 'APPROVAL_SPENT');

  const state = run(fixture.home, ['application-submission', 'state', '--application-id', String(application.id)]);
  assert.equal(state.landed.attempt_id, 'arc-attempt-2');
  assert.equal(state.maySubmit, false);
  assert.equal(state.attempts.length, 2);
});

test('an indeterminate settlement is honest not-knowing: everything stays fenced', (t) => {
  const fixture = createStore(t);
  const application = addProspect(fixture.home, 'Fog Systems', 'Reliability Engineer');
  const answersFile = writeJson(fixture.root, 'fog-answers.json', { start: 'March' });
  const documentsFile = writeJson(fixture.root, 'fog-documents.json', { resume: 'c'.repeat(64) });

  const proposed = run(fixture.home, [
    'application-submission', 'propose',
    '--application-id', String(application.id),
    '--surface-id', 'https://careers.fog.test/apply/2',
    '--intent-id', 'fog-intent',
    '--answers-file', answersFile,
    '--documents-file', documentsFile
  ]);
  run(fixture.home, [
    'application-submission', 'approve',
    '--intent-id', 'fog-intent',
    '--expected-intent-digest', proposed.intentDigest,
    '--approver-kind', 'policy',
    '--approver-id', 'cycle-orchestrator',
    '--approval-id', 'fog-approval'
  ]);
  run(fixture.home, ['application-submission', 'claim', '--approval-id', 'fog-approval', '--attempt-id', 'fog-attempt-1']);
  run(fixture.home, ['application-submission', 'settle', '--attempt-id', 'fog-attempt-1', '--outcome', 'indeterminate']);

  const fenced = runExpectingError(fixture.home, [
    'application-submission', 'claim', '--approval-id', 'fog-approval', '--attempt-id', 'fog-attempt-2'
  ]);
  assert.equal(fenced.code, 'ATTEMPT_UNRECONCILED');

  const state = run(fixture.home, ['application-submission', 'state', '--application-id', String(application.id)]);
  assert.equal(state.landed, null);
  assert.equal(state.unreconciled.attempt_id, 'fog-attempt-1');
  assert.equal(state.maySubmit, false);

  // A settled attempt is immutable: re-settling differently is refused.
  const resettle = runExpectingError(fixture.home, [
    'application-submission', 'settle', '--attempt-id', 'fog-attempt-1', '--outcome', 'failed'
  ]);
  assert.equal(resettle.code, 'ATTEMPT_SETTLED');
});

test('CLI hygiene: unknown actions, unknown flags, and mixed propose sources are refused', (t) => {
  const fixture = createStore(t);
  const application = addProspect(fixture.home, 'Hygiene Labs', 'Backend Engineer');

  assert.equal(runExpectingError(fixture.home, ['application-submission', 'transmit']).code, 'UNKNOWN_COMMAND');

  // Flags outside an action's schema are rejected by the shared registry
  // before any code runs (--outcome is a KNOWN flag, wrong action here).
  const wrongFlag = runExpectingError(fixture.home, [
    'application-submission', 'approve', '--outcome', 'accepted'
  ]);
  assert.equal(wrongFlag.code, 'INVALID_ARGUMENT');

  const mixed = runExpectingError(fixture.home, [
    'application-submission', 'propose',
    '--application-id', String(application.id),
    '--surface-id', 'https://careers.hygiene.test/apply/1',
    '--intent-id', 'hygiene-intent',
    '--package-id', '1',
    '--answers-file', writeJson(fixture.root, 'h-answers.json', {}),
    '--documents-file', writeJson(fixture.root, 'h-documents.json', {})
  ]);
  assert.equal(mixed.code, 'INVALID_ARGUMENT');

  const missingReadiness = runExpectingError(fixture.home, [
    'application-submission', 'propose',
    '--application-id', String(application.id),
    '--surface-id', 'https://careers.hygiene.test/apply/1',
    '--intent-id', 'hygiene-intent',
    '--package-id', '1'
  ]);
  assert.match(missingReadiness.message, /--expected-readiness-sha256/);

  const badFile = runExpectingError(fixture.home, [
    'application-submission', 'propose',
    '--application-id', String(application.id),
    '--surface-id', 'https://careers.hygiene.test/apply/1',
    '--intent-id', 'hygiene-intent',
    '--answers-file', path.join(fixture.root, 'does-not-exist.json'),
    '--documents-file', writeJson(fixture.root, 'h-documents2.json', {})
  ]);
  assert.equal(badFile.code, 'INVALID_ARGUMENT');
  assert.match(badFile.message, /--answers-file unreadable/);
});
