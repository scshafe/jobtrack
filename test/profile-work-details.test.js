'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  addWorkDetail, updateWorkDetail, removeWorkDetail, listWorkOutline,
  parseOutlineText, importWorkOutline, WorkDetailError
} = require('../lib/profile-work-details');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

function makeStoreWithWorkEntry(t) {
  const home = require('../test-support/migrated-store').createTestHome('jobtrack-outline-');
  const env = { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') };
  execFileSync(process.execPath, [cli, 'profile', 'add-work', '--company', 'Acme', '--role', 'Engineer',
    '--start-date', '2020-01', '--present', 'true', '--highlights', 'Did things', '--source', 'outline-test', '--confidence', 'high'], { cwd: root, env, stdio: 'ignore' });
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const workEntryId = db.prepare('SELECT id FROM profile_work_entries LIMIT 1').get().id;
  return { db, workEntryId };
}

test('outline: add, nest, reorder-free positions, show as tree', (t) => {
  const { db, workEntryId } = makeStoreWithWorkEntry(t);
  const a = addWorkDetail(db, { workEntryId, detail: 'Owned rollout' });
  const b = addWorkDetail(db, { workEntryId, parentDetailId: a.id, detail: 'Carrier provisioning' });
  addWorkDetail(db, { workEntryId, parentDetailId: b.id, detail: 'Porting runbooks' });
  addWorkDetail(db, { workEntryId, detail: 'Integration layer' });
  const outline = listWorkOutline(db, workEntryId);
  assert.equal(outline.nodeCount, 4);
  assert.equal(outline.nodes.length, 2);
  assert.equal(outline.nodes[0].children[0].children[0].detail, 'Porting runbooks');

  // Scope guard: a parent from another entry is refused.
  assert.throws(() => addWorkDetail(db, { workEntryId: workEntryId + 999, detail: 'x' }), /not found/);
  updateWorkDetail(db, { detailId: b.id, detail: 'Carrier provisioning at scale' });
  assert.equal(listWorkOutline(db, workEntryId).nodes[0].children[0].detail, 'Carrier provisioning at scale');
});

test('outline: leaf-only removal with position re-pack', (t) => {
  const { db, workEntryId } = makeStoreWithWorkEntry(t);
  const a = addWorkDetail(db, { workEntryId, detail: 'one' });
  const b = addWorkDetail(db, { workEntryId, detail: 'two' });
  const c = addWorkDetail(db, { workEntryId, detail: 'three' });
  addWorkDetail(db, { workEntryId, parentDetailId: a.id, detail: 'child' });
  assert.throws(() => removeWorkDetail(db, { detailId: a.id }), WorkDetailError);
  removeWorkDetail(db, { detailId: b.id });
  const roots = listWorkOutline(db, workEntryId).nodes;
  assert.deepEqual(roots.map((node) => [node.detail, node.position]), [['one', 1], ['three', 2]]);
  assert.equal(c.id > 0, true);
});

test('outline text parsing: indentation levels, bullets optional, level-skip rejected', () => {
  const nodes = parseOutlineText([
    '- Top A',
    '  - Child A1',
    '\t- Child A2 (tab)',
    '    deeper via four spaces',
    'Top B'
  ].join('\n'));
  assert.deepEqual(nodes.map((node) => node.depth), [0, 1, 1, 2, 0]);
  assert.equal(nodes[3].detail, 'deeper via four spaces');
  assert.throws(() => parseOutlineText('- a\n        - way too deep'), /skips levels/);
});

test('import outline: builds tree; replace clears previous', (t) => {
  const { db, workEntryId } = makeStoreWithWorkEntry(t);
  const first = importWorkOutline(db, { workEntryId, text: '- a\n  - a1\n- b' });
  assert.equal(first.added, 3);
  const second = importWorkOutline(db, { workEntryId, text: '- fresh\n  - child\n    - grandchild', replace: true });
  assert.equal(second.added, 3);
  const outline = listWorkOutline(db, workEntryId);
  assert.equal(outline.nodeCount, 3);
  assert.equal(outline.nodes[0].detail, 'fresh');
  assert.equal(outline.nodes[0].children[0].children[0].detail, 'grandchild');
});

// ---------------------------------------------------------- fact ledger ----

const { workEntryInterview } = require('../lib/profile-work-details');

test('fact ledger: typed fact nodes round-trip with authorship', (t) => {
  const { db, workEntryId } = makeStoreWithWorkEntry(t);
  const anchor = addWorkDetail(db, {
    workEntryId, detail: 'Owned rollout across sites',
    kind: 'action', authorshipKind: 'imported', authoredBy: 'profile-highlights'
  });
  const outcome = addWorkDetail(db, {
    workEntryId, parentDetailId: anchor.id, detail: 'Cut go-live time',
    kind: 'outcome', baseline: '3 weeks per site', result: '4 days per site',
    authorshipKind: 'human', authoredBy: 'Cole'
  });
  assert.equal(outcome.kind, 'outcome');
  assert.equal(outcome.baseline, '3 weeks per site');
  assert.equal(outcome.authorship_kind, 'human');
  const outline = listWorkOutline(db, workEntryId);
  const node = outline.nodes.find((item) => item.id === anchor.id);
  assert.equal(node.kind, 'action');
  assert.equal(node.children[0].result, '4 days per site');
  assert.equal(node.children[0].authoredBy, 'Cole');
});

test('fact ledger: facts require a kind, and a kind requires authorship', (t) => {
  const { db, workEntryId } = makeStoreWithWorkEntry(t);
  assert.throws(
    () => addWorkDetail(db, { workEntryId, detail: 'x', baseline: '10 rps' }),
    (error) => error.code === 'FACT_KIND_REQUIRED'
  );
  assert.throws(
    () => addWorkDetail(db, { workEntryId, detail: 'x', kind: 'scale' }),
    (error) => error.code === 'FACT_AUTHORSHIP_REQUIRED'
  );
  assert.throws(
    () => addWorkDetail(db, { workEntryId, detail: 'x', kind: 'scale', authorshipKind: 'human' }),
    (error) => error.code === 'FACT_AUTHORSHIP_REQUIRED'
  );
  assert.throws(
    () => addWorkDetail(db, { workEntryId, detail: 'x', kind: 'nonsense', authorshipKind: 'human', authoredBy: 'Cole' }),
    (error) => error.code === 'INVALID_ARGUMENT'
  );
});

test('fact ledger: editing a human-authored node requires restating authorship', (t) => {
  const { db, workEntryId } = makeStoreWithWorkEntry(t);
  const node = addWorkDetail(db, {
    workEntryId, detail: 'Measured fact', kind: 'scale',
    authorshipKind: 'human', authoredBy: 'Cole'
  });
  assert.throws(
    () => updateWorkDetail(db, { detailId: node.id, detail: 'Different fact' }),
    (error) => error.code === 'FACT_AUTHORSHIP_REQUIRED'
  );
  const updated = updateWorkDetail(db, {
    detailId: node.id, detail: 'Different fact',
    authorshipKind: 'agent', authoredBy: 'assistant'
  });
  assert.equal(updated.detail, 'Different fact');
  assert.equal(updated.authorship_kind, 'agent', 'authorship records who last vouched, truthfully');
});

test('interview: anchors first, then required facts, complete when facts exist', (t) => {
  const { db, workEntryId } = makeStoreWithWorkEntry(t);
  const opening = workEntryInterview(db, { workEntryId });
  assert.equal(opening.complete, false);
  assert.equal(opening.questions[0].step, 'anchor');
  assert.match(opening.questions[0].recordWith, /--kind action --authorship-kind imported/);

  const anchor = addWorkDetail(db, {
    workEntryId, detail: 'Did things',
    kind: 'action', authorshipKind: 'imported', authoredBy: 'profile-highlights'
  });
  const afterAnchor = workEntryInterview(db, { workEntryId, limit: 10 });
  assert.equal(afterAnchor.questions.some((question) => question.step === 'anchor'), false);
  const kinds = afterAnchor.questions.map((question) => question.kind);
  assert.deepEqual(kinds.slice(0, 3), ['my_role', 'scale', 'outcome']);
  assert.equal(afterAnchor.questions.find((question) => question.kind === 'constraint').required, false);

  updateWorkDetail(db, {
    detailId: anchor.id, kind: 'action', myRole: 'owned',
    authorshipKind: 'human', authoredBy: 'Cole'
  });
  addWorkDetail(db, {
    workEntryId, parentDetailId: anchor.id, detail: '40 sites in production',
    kind: 'scale', authorshipKind: 'human', authoredBy: 'Cole'
  });
  addWorkDetail(db, {
    workEntryId, parentDetailId: anchor.id, detail: 'Go-live effort dropped',
    kind: 'outcome', baseline: '3 weeks', result: '4 days',
    authorshipKind: 'human', authoredBy: 'Cole'
  });
  const done = workEntryInterview(db, { workEntryId });
  assert.equal(done.complete, true);
  assert.equal(done.requiredRemaining, 0);
  assert.ok(done.optionalRemaining >= 1, 'constraint/decision stay available as optional depth');
});

test('interview: CLI surface returns questions as JSON', (t) => {
  const { db, workEntryId } = makeStoreWithWorkEntry(t);
  const home = path.dirname(db.name);
  const result = JSON.parse(execFileSync(process.execPath, [
    cli, 'profile', 'work-detail-interview', '--work-entry-id', String(workEntryId), '--json'
  ], { cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8' }));
  assert.equal(result.workEntryId, workEntryId);
  assert.ok(Array.isArray(result.questions));
  assert.equal(result.questions[0].step, 'anchor');
});
