'use strict';
// The post-submitted lifecycle as fabric work (FABRIC_PLAN A17, 2026-09-05):
// an interview the store records walks prep → review → select → upcoming →
// outcome by derivation alone, with a person at every gate by default; an
// offer parks at a decision gate no policy may fire.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { FABRIC_NODES, deriveFabricNext, runFabricTick, setGatePolicy } = require('../lib/fabric');
const { createInterviewPrepAnalysis, createScheduledInterview, migrateInterviewPrep, reviewInterviewPrepAnalysis, selectCurrentInterviewPrep, updateScheduledInterview } = require('../lib/interview-prep');
const { STAFFED_NODES, briefFor } = require('../lib/fabric-briefs');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

function runCli(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], { cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8' }));
}

function createStore(t) {
  const { root: rootDir, home } = require('../test-support/migrated-store').createTestStore('jobtrack-fabric-lifecycle-');
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  migrateInterviewPrep(db);
  t.after(() => { if (db.open) db.close(); fs.rmSync(rootDir, { recursive: true, force: true }); });
  return { home, db };
}

function analysisInput(interviewId, overrides = {}) {
  return {
    interviewId,
    status: 'ready',
    title: 'Evidence-bound interview preparation',
    executiveSummary: 'A concise evidence-backed preparation plan.',
    strategy: 'Practice relevant examples and verify every factual claim.',
    generatedBy: 'fabric-worker',
    generatorVersion: 'fabric-worker.v1',
    sections: [{ kind: 'role_focus', heading: 'Role focus', content: 'Prepare for the role using only linked evidence.' }],
    questions: [],
    skillFocus: [],
    storyLinks: [],
    evidence: { snapshots: [], artifacts: [], profiles: [] },
    ...overrides
  };
}

const items = (next, applicationId, nodeId) => (next.subjects.find((row) => row.subjectKind === 'application' && row.subjectId === applicationId)?.items ?? []).filter((item) => item.node === nodeId);
const only = (next, applicationId, nodeId) => {
  const rows = items(next, applicationId, nodeId);
  assert.equal(rows.length, 1, `exactly one ${nodeId} item expected, got ${rows.length}`);
  return rows[0];
};

test('the interview and offer nodes are registered with the plan\'s shapes', () => {
  const byId = new Map(FABRIC_NODES.map((node) => [node.id, node]));
  assert.equal(byId.get('interview.prep.generate').executor, 'deterministic');
  assert.equal(byId.get('interview.prep.author').executor, 'agent');
  assert.equal(byId.get('interview.prep.review').kind, 'gate');
  assert.equal(byId.get('interview.prep.select').defaultMode, 'human');
  assert.equal(byId.get('interview.outcome').executor, 'manual');
  assert.deepEqual([...byId.get('offer.decision').allowedModes], ['human', 'withhold'], 'an offer is never decided by policy');
  assert.ok(STAFFED_NODES.includes('interview.prep.author'));
  assert.ok(!STAFFED_NODES.includes('interview.outcome'));
});

test('an interview walks prep → author → review → select → upcoming → outcome by derivation, a person at every gate', (t) => {
  const { home, db } = createStore(t);
  const applicationId = runCli(home, ['add-application', '--company', 'Retell AI', '--role', 'Senior FDE']).application.id;
  const now = new Date('2026-09-10T12:00:00.000Z');
  const interview = createScheduledInterview(db, {
    applicationId, roundType: 'technical_screen', scheduledAt: '2026-09-12T17:00:00-07:00', timezone: 'America/Los_Angeles', format: 'video', durationMinutes: 45
  });

  // 1. No analysis: the deterministic first draft is due, and the tick performs it.
  let next = deriveFabricNext(db, { now });
  const generate = only(next, applicationId, 'interview.prep.generate');
  assert.equal(generate.status, 'eligible');
  assert.match(generate.reason, /no prep analysis yet/u);
  assert.equal(generate.act.interviewId, interview.id);
  // add-application records a legacy-import application at stage submitted:
  // the preparation half leaves it alone, the lifecycle half still runs.
  const subject = next.subjects.find((row) => row.subjectId === applicationId);
  assert.match(subject.note, /legacy-import/u);
  assert.equal(items(next, applicationId, 'application.intake').length, 0);
  const tick = runFabricTick(db, { now });
  assert.deepEqual(tick.performed.map((row) => row.node), ['interview.prep.generate']);
  assert.match(tick.performed[0].summary, /generated prep analysis #1 v1/u);
  const again = runFabricTick(db, { now });
  assert.equal(again.performed.length, 0, 'the deterministic draft is generated once');

  // 2. Only the deterministic draft exists: the agent must author; the item is staffed by the dispatcher.
  next = deriveFabricNext(db, { now });
  const author = only(next, applicationId, 'interview.prep.author');
  assert.equal(author.status, 'eligible');
  assert.match(author.reason, /only the deterministic draft \(#1\) exists/u);
  assert.equal(author.act.currentAnalysisId, 1);
  assert.equal(author.idempotencyKey, `fabric-interview.prep.author-${interview.id}-v2`);
  assert.deepEqual(again.dispatchable.map((row) => row.node), ['interview.prep.author']);
  const brief = briefFor({ ...author, subjectKind: 'application', subjectId: applicationId }, { storeHome: home, jobtrackRoot: root }, { dispatch: 1 });
  assert.match(brief, /INTERVIEW-PREP worker for application/u);
  assert.match(brief, /Only the deterministic draft \(#1\) exists/u);
  assert.match(brief, new RegExp(`--idempotency-key fabric-interview.prep.author-${interview.id}-v2`, 'u'));
  assert.match(brief, /SKILL_FOCUS_MISMATCH, EVIDENCE_MISMATCH/u);

  // The agent authors version 2; the deterministic draft stays current.
  const authored = createInterviewPrepAnalysis(db, analysisInput(interview.id), { idempotencyKey: author.idempotencyKey });
  assert.equal(authored.analysis.version, 2);
  assert.equal(authored.analysis.is_current, false);

  // 3. Unreviewed: the review gate parks for a person.
  next = deriveFabricNext(db, { now });
  const review = only(next, applicationId, 'interview.prep.review');
  assert.equal(review.status, 'parked');
  assert.equal(review.owner, 'human');
  assert.equal(review.act.analysisId, authored.analysis.id);
  assert.match(review.commands[0], /interview-prep review --analysis-id 2 --decision approved\|rejected/u);
  assert.equal(items(next, applicationId, 'interview.prep.author').length, 0);

  // A rejection sends it back to the author with the reviewer's notes in front of it.
  reviewInterviewPrepAnalysis(db, { analysisId: authored.analysis.id, decision: 'rejected', reviewedBy: 'Cole', notes: 'name the on-call risk' }, { idempotencyKey: 'rev-2-reject' });
  next = deriveFabricNext(db, { now });
  const reauthor = only(next, applicationId, 'interview.prep.author');
  assert.match(reauthor.reason, /rejected by Cole \(name the on-call risk\)/u);
  assert.equal(reauthor.act.rejectedAnalysisId, 2);
  assert.equal(reauthor.idempotencyKey, `fabric-interview.prep.author-${interview.id}-v3`);
  assert.match(briefFor({ ...reauthor, subjectKind: 'application', subjectId: applicationId }, { storeHome: home, jobtrackRoot: root }), /was REJECTED by Cole: "name the on-call risk"/u);
  const third = createInterviewPrepAnalysis(db, analysisInput(interview.id, { title: 'Second try' }), { idempotencyKey: reauthor.idempotencyKey });
  reviewInterviewPrepAnalysis(db, { analysisId: third.analysis.id, decision: 'approved', reviewedBy: 'Cole' }, { idempotencyKey: 'rev-3-approve' });

  // 4. Approved but not current: the selection gate parks, naming the expected current.
  next = deriveFabricNext(db, { now });
  const select = only(next, applicationId, 'interview.prep.select');
  assert.equal(select.status, 'parked');
  assert.equal(select.act.analysisId, third.analysis.id);
  assert.equal(select.act.expectedCurrentAnalysisId, 1);
  assert.match(select.commands[0], /--expected-current-analysis-id 1/u);
  selectCurrentInterviewPrep(db, { analysisId: third.analysis.id, selectedBy: 'Cole', expectedCurrentAnalysisId: 1 }, { idempotencyKey: 'sel-3' });

  // 5. Prep ready: the interview is upcoming, standing, and the wake hint is its end.
  next = deriveFabricNext(db, { now });
  const upcoming = only(next, applicationId, 'interview.upcoming');
  assert.equal(upcoming.status, 'standing');
  assert.equal(upcoming.wakeAt, '2026-09-13T00:45:00.000Z');
  assert.equal(next.nextWakeAt, '2026-09-13T00:45:00.000Z');
  assert.equal(items(next, applicationId, 'interview.prep.review').length + items(next, applicationId, 'interview.prep.select').length + items(next, applicationId, 'interview.prep.author').length, 0);
  const quiet = runFabricTick(db, { now });
  assert.equal(quiet.performed.length, 0);
  assert.equal(quiet.parked.length, 0);

  // 6. After the interview: a person records the outcome; then nothing remains.
  const later = new Date('2026-09-13T09:00:00.000Z');
  next = deriveFabricNext(db, { now: later });
  const outcome = only(next, applicationId, 'interview.outcome');
  assert.equal(outcome.status, 'parked');
  assert.equal(outcome.owner, 'human');
  assert.equal(outcome.executor, 'manual');
  assert.match(outcome.commands[0], new RegExp(`update-interview --interview-id ${interview.id} --outcome passed\\|failed`, 'u'));
  assert.deepEqual(runFabricTick(db, { now: later }).parked.map((row) => row.node), ['interview.outcome']);
  updateScheduledInterview(db, interview.id, { outcome: 'passed', expectedLockVersion: 0 });
  next = deriveFabricNext(db, { now: later });
  assert.equal(items(next, applicationId, 'interview.outcome').length, 0);
  assert.equal(items(next, applicationId, 'interview.upcoming').length, 0);
});

test('a cancelled interview leaves the lifecycle, and policy modes fire the prep gates the way a person would', (t) => {
  const { home, db } = createStore(t);
  const applicationId = runCli(home, ['add-application', '--company', 'Vapi', '--role', 'FDE']).application.id;
  const now = new Date('2026-09-10T12:00:00.000Z');
  const cancelled = createScheduledInterview(db, { applicationId, roundType: 'technical_screen', scheduledAt: '2026-09-11T17:00:00Z', format: 'video' });
  updateScheduledInterview(db, cancelled.id, { schedulingStatus: 'cancelled', expectedLockVersion: 0 });
  assert.equal(items(deriveFabricNext(db, { now }), applicationId, 'interview.prep.generate').length, 0, 'a cancelled interview needs nothing');

  const interview = createScheduledInterview(db, { applicationId, roundType: 'technical_screen', scheduledAt: '2026-09-15T17:00:00Z', format: 'video' });
  runFabricTick(db, { now });
  createInterviewPrepAnalysis(db, analysisInput(interview.id), { idempotencyKey: 'author-v2' });
  // Review policy with no author rule holds; with the author named it approves.
  setGatePolicy(db, { gateId: 'interview.prep.review', mode: 'policy', setBy: 'Cole', setAuthorship: 'human', expectedCurrentRevisionId: 'none', rules: '{}' });
  let tick = runFabricTick(db, { now });
  assert.equal(tick.held.length, 1);
  assert.match(tick.held[0].reason, /does not name the author fabric-worker/u);
  setGatePolicy(db, { gateId: 'interview.prep.review', mode: 'policy', setBy: 'Cole', setAuthorship: 'human', expectedCurrentRevisionId: 1, rules: '{"approveGeneratedBy":["fabric-worker"]}' });
  tick = runFabricTick(db, { now });
  assert.deepEqual(tick.performed.map((row) => [row.node, row.actor]), [['interview.prep.review', 'policy:fabric/interview.prep.review@rev2']]);
  // Selection policy selects the approved analysis over the deterministic current.
  setGatePolicy(db, { gateId: 'interview.prep.select', mode: 'policy', setBy: 'Cole', setAuthorship: 'human', expectedCurrentRevisionId: 'none' });
  tick = runFabricTick(db, { now });
  assert.deepEqual(tick.performed.map((row) => row.node), ['interview.prep.select']);
  const upcoming = only(deriveFabricNext(db, { now }), applicationId, 'interview.upcoming');
  assert.equal(upcoming.act.analysisId, 2);
  // The offer gate admits no policy mode.
  assert.throws(() => setGatePolicy(db, { gateId: 'offer.decision', mode: 'policy', setBy: 'Cole', setAuthorship: 'human', expectedCurrentRevisionId: 'none' }), (error) => error.code === 'INVALID_MODE');
});

test('a recorded offer parks at the decision gate with its deadline as the wake hint until a person decides', (t) => {
  const { home, db } = createStore(t);
  const applicationId = runCli(home, ['add-application', '--company', 'Together AI', '--role', 'Senior Platform Engineer']).application.id;
  runCli(home, ['record-offer', '--application-id', String(applicationId), '--details', 'Base 210k, equity, start Oct 6. Respond by the 20th.', '--decision-deadline', '2026-09-20T17:00:00Z']);
  const now = new Date('2026-09-15T12:00:00.000Z');
  let next = deriveFabricNext(db, { now });
  const decision = only(next, applicationId, 'offer.decision');
  assert.equal(decision.status, 'parked');
  assert.equal(decision.owner, 'human');
  assert.match(decision.reason, /decide by 2026-09-20T17:00:00Z: Base 210k/u);
  assert.equal(decision.wakeAt, '2026-09-20T17:00:00.000Z');
  assert.equal(next.nextWakeAt, '2026-09-20T17:00:00.000Z');
  assert.match(decision.commands[0], /update-offer --application-id \d+ --outcome accepted\|declined/u);
  const overdue = only(deriveFabricNext(db, { now: new Date('2026-09-21T00:00:00.000Z') }), applicationId, 'offer.decision');
  assert.match(overdue.reason, /OVERDUE/u);
  assert.equal(overdue.wakeAt, undefined, 'a past deadline is no wake hint');
  runCli(home, ['update-offer', '--application-id', String(applicationId), '--outcome', 'declined']);
  next = deriveFabricNext(db, { now });
  assert.equal(items(next, applicationId, 'offer.decision').length, 0);
});
