'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const {
  EDITORIAL_REVIEW_VERSION, buildResumeEditorialContext, validateResumeEditorialReview,
  migrateResumeEditorialReviews, recordResumeEditorialReview, getResumeEditorialReadiness,
  resumeEditorialEvidencePaths
} = require('../lib/resume-editorial-review');

const clone = (value) => JSON.parse(JSON.stringify(value));
const H = (char) => char.repeat(64);

function input() {
  const current = {
    name: 'Test Engineer', contactLine: 'engineer@example.test', summary: 'Backend engineer.',
    experience: [
      { org: 'Current Co', title: 'Software Engineer', dates: 'Apr 2025 – Present',
        bullets: ['Built typed event contracts and generated SDKs.', 'Owned incident response.'] }
    ],
    projects: [{ name: 'Practice project', technologies: 'Node.js', bullets: ['Designed a review-bound document pipeline.'] }],
    education: [{ org: 'University', degree: 'BS', dates: '2019', notes: [] }],
    skills: [{ group: 'Languages', items: ['TypeScript', 'Node.js'] }]
  };
  const older = clone(current);
  older.experience[0].bullets[0] = 'Built nine event domains and generated SDKs for 25+ clients.';
  older.experience.push({ org: 'Earlier Co', title: 'Software Engineer', dates: 'Jun 2021 – Jun 2022',
    bullets: ['Shipped AWS delivery infrastructure for hundreds of users.'] });
  older.skills[0].items.push('AWS');
  return {
    applicationId: 3, revisionId: 16, renderId: 8, templateKey: 'resume.standard.v3', authoredBy: 'agent:author',
    sourceStateSha256: H('a'), payload: current,
    // The immediate parent already dropped the old role; checking only it
    // would erase both the chronology issue and the lost career history.
    ancestors: [{ revisionId: 15, payload: clone(current) }, { revisionId: 14, payload: older }],
    sources: [
      { id: 'profile:4', kind: 'profile-entry', sha256: H('b'), text: 'Typed event systems and incidents.' },
      { id: 'profile:8', kind: 'profile-entry', sha256: H('c'), text: 'Earlier infrastructure work.' }
    ],
    requirements: [
      { id: 'snapshot:3:node', text: 'Production TypeScript and Node.js', kind: 'required' },
      { id: 'snapshot:3:years', text: 'Eight years production backend experience', kind: 'required' },
      { id: 'snapshot:3:mentoring', text: 'Mentor senior and mid-level engineers', kind: 'responsibility' }
    ],
    postingContext: { snapshotId: 3, sha256: H('d'), title: 'Staff Software Engineer' }
  };
}

function review(context, decision = 'approved') {
  return {
    schemaVersion: EDITORIAL_REVIEW_VERSION, contextSha256: context.contextSha256, decision,
    notes: 'Checked the submitted evidence and the intended Staff role.', reviewerScope: 'Role fit and factual fidelity',
    matrix: context.requirements.map((requirement) => ({
      requirementId: requirement.id,
      status: requirement.id.endsWith(':node') ? 'demonstrated' : requirement.id.endsWith(':years') ? 'partial' : 'not-demonstrated',
      evidence: requirement.id.endsWith(':node') ? [{ sourceId: 'profile:4', payloadPath: 'experience[0].bullets[0]' }]
        : requirement.id.endsWith(':years') ? [{ sourceId: 'profile:4', payloadPath: 'experience[0].dates' }] : [],
      rationale: requirement.id.endsWith(':node') ? 'Current production systems demonstrate the stack.' : 'The supplied evidence does not establish the full requirement.',
      stretchReason: requirement.id.endsWith(':node') ? '' : 'Accept a transparent stretch application without claiming the missing qualification.'
    })),
    omissions: Object.values(context.factsDiff).flat().map((finding) => ({
      findingId: finding.findingId, disposition: 'accepted-omission', reason: 'Reviewer considered the removed information and its effect on role fit.'
    })),
    chronology: context.chronologyGaps.map((finding) => ({
      findingId: finding.findingId, disposition: 'unexplained-gap-accepted', reason: 'The applicant has not supplied a gap explanation; no continuous employment is claimed.'
    }))
  };
}

function database(t, migrate = true) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE applications(id INTEGER PRIMARY KEY);
    CREATE TABLE application_material_revisions(id INTEGER PRIMARY KEY);
    CREATE TABLE application_material_renders(id INTEGER PRIMARY KEY);
    INSERT INTO applications VALUES(3);
    INSERT INTO application_material_revisions VALUES(16);
    INSERT INTO application_material_renders VALUES(8);
  `);
  if (migrate) migrateResumeEditorialReviews(db);
  return db;
}
function rejectsCode(fn, code) { assert.throws(fn, (error) => error.code === code, code); }
function record(db, context, document, idempotencyKey = 'editorial:16:1') {
  return recordResumeEditorialReview(db, { context, review: document, reviewedBy: 'agent:independent-reviewer', idempotencyKey });
}

test('factual diff retains jobs, rewritten bullets, quantities and skills omitted before the immediate parent', () => {
  const context = buildResumeEditorialContext(input());
  assert.equal(context.factsDiff.omittedRoles.length, 1);
  assert.deepEqual(context.factsDiff.omittedRoles[0].ancestorRevisionIds, [14]);
  assert.equal(context.factsDiff.omittedRoles[0].org, 'Earlier Co');
  assert.equal(context.factsDiff.omittedRoles[0].title, 'Software Engineer');
  assert.equal(context.factsDiff.omittedRoles[0].dates, 'Jun 2021 – Jun 2022');
  assert.equal(context.factsDiff.removedBullets.length, 2);
  assert.deepEqual(new Set(context.factsDiff.removedScopeNumbers.map((f) => f.value)), new Set(['nine', '25+', 'hundreds']));
  assert.equal(context.factsDiff.lostSkills[0].skill, 'AWS');
  assert.equal(context.chronologyGaps.length, 1);
  assert.equal(context.chronologyGaps[0].months, 34);
  assert.equal(context.chronologyGaps[0].current, false);
  assert.deepEqual(context.chronologyGaps[0].ancestorRevisionIds, [14]);
});

test('context canonicalization pins sources, posting, ancestry, payload and exact render', () => {
  const original = input();
  const context = buildResumeEditorialContext(original);
  const reorder = input();
  reorder.ancestors.reverse(); reorder.sources.reverse(); reorder.requirements.reverse();
  assert.equal(buildResumeEditorialContext(reorder).contextSha256, context.contextSha256);
  assert.equal(buildResumeEditorialContext(context).contextSha256, context.contextSha256);
  for (const change of [
    (v) => { v.sources[0].sha256 = H('e'); },
    (v) => { v.sources[0].text = 'Changed selected evidence'; },
    (v) => { v.postingContext.sha256 = H('e'); },
    (v) => { v.requirements[0].text = 'A different requirement'; },
    (v) => { v.ancestors[1].payload.experience[1].dates = 'Jun 2020 – Jun 2022'; },
    (v) => { v.payload.experience[0].bullets.push('New factual claim.'); },
    (v) => { v.renderId = 9; }
  ]) {
    const altered = input(); change(altered);
    assert.notEqual(buildResumeEditorialContext(altered).contextSha256, context.contextSha256);
  }
  const tampered = clone(context); tampered.payload.summary = 'Changed after review';
  rejectsCode(() => buildResumeEditorialContext(tampered), 'EDITORIAL_CONTEXT_STALE');
  assert.deepEqual(original, input(), 'context building is pure');
});

test('chronology merges overlapping roles, keeps conservative year-only gaps, and flags unparseable dates', () => {
  const data = input(); data.ancestors = [];
  data.payload.experience = [
    { org: 'A', dates: 'Jan 2020 – Dec 2024', bullets: [] },
    { org: 'B', dates: 'Jun 2021 – Jun 2022', bullets: [] },
    { org: 'C', dates: 'Apr 2025 – Present', bullets: [] }
  ];
  assert.equal(buildResumeEditorialContext(data).chronologyGaps.length, 0, 'overlap must not manufacture a gap');
  data.payload.experience = [{ org: 'A', dates: '2020 – 2021' }, { org: 'B', dates: '2023 – Present' }];
  assert.equal(buildResumeEditorialContext(data).chronologyGaps[0].months, 13);
  data.payload.experience[0].dates = 'Earlier career';
  assert.equal(buildResumeEditorialContext(data).chronologyGaps[0].kind, 'unparsed-role-dates');
});

test('complete independent matrix binds exact selected sources and current visible payload paths', () => {
  const context = buildResumeEditorialContext(input());
  const document = review(context);
  assert.equal(validateResumeEditorialReview(context, document, 'independent reviewer').decision, 'approved');
  const paths = resumeEditorialEvidencePaths(context.payload).map((p) => p.payloadPath);
  assert.ok(paths.includes('experience[0].dates'));
  assert.ok(paths.includes('skills[0].items[1]'));
  assert.ok(!paths.includes('contactLine'));
  const stack = document.matrix.find((entry) => entry.requirementId.endsWith(':node'));
  stack.evidence[0].payloadPath = 'skills[0].items[1]';
  assert.equal(validateResumeEditorialReview(context, document, 'reviewer').matrix.length, 3);
  stack.evidence[0].payloadPath = 'contactLine';
  rejectsCode(() => validateResumeEditorialReview(context, document, 'reviewer'), 'EDITORIAL_EVIDENCE_INVALID');
  stack.evidence[0].payloadPath = 'experience[9].bullets[0]';
  rejectsCode(() => validateResumeEditorialReview(context, document, 'reviewer'), 'EDITORIAL_EVIDENCE_INVALID');
  stack.evidence[0] = { sourceId: 'profile:unselected', payloadPath: 'experience[0].bullets[0]' };
  rejectsCode(() => validateResumeEditorialReview(context, document, 'reviewer'), 'EDITORIAL_EVIDENCE_INVALID');
});

test('missing, duplicate or substituted requirements and missing dispositions fail closed', () => {
  const context = buildResumeEditorialContext(input());
  for (const alter of [
    (v) => { v.matrix.pop(); },
    (v) => { v.matrix[0].requirementId = 'not-a-posting-requirement'; },
    (v) => { v.omissions.pop(); },
    (v) => { v.chronology = []; }
  ]) {
    const document = review(context); alter(document);
    rejectsCode(() => validateResumeEditorialReview(context, document, 'reviewer'), 'EDITORIAL_REVIEW_INCOMPLETE');
  }
  const duplicate = review(context); duplicate.matrix.push(clone(duplicate.matrix[0]));
  rejectsCode(() => validateResumeEditorialReview(context, duplicate, 'reviewer'), 'INVALID_INPUT');
  const noRequirements = input(); noRequirements.requirements = [];
  const emptyContext = buildResumeEditorialContext(noRequirements);
  rejectsCode(() => validateResumeEditorialReview(emptyContext, review(emptyContext), 'reviewer'), 'EDITORIAL_REQUIREMENTS_MISSING');
});

test('review rejects self-review, stale contexts, unsupported claims and implicit stretch approval', () => {
  const context = buildResumeEditorialContext(input());
  rejectsCode(() => validateResumeEditorialReview(context, review(context), '  AGENT:AUTHOR '), 'EDITORIAL_SELF_REVIEW');
  const stale = review(context); stale.contextSha256 = H('f');
  rejectsCode(() => validateResumeEditorialReview(context, stale, 'reviewer'), 'EDITORIAL_CONTEXT_STALE');
  const unsupported = review(context); unsupported.matrix.find((r) => r.status === 'demonstrated').evidence = [];
  rejectsCode(() => validateResumeEditorialReview(context, unsupported, 'reviewer'), 'EDITORIAL_EVIDENCE_REQUIRED');
  const stretch = review(context); stretch.matrix.find((r) => r.status === 'partial').stretchReason = '';
  rejectsCode(() => validateResumeEditorialReview(context, stretch, 'reviewer'), 'EDITORIAL_STRETCH_REASON_REQUIRED');
  stretch.matrix.find((r) => r.status === 'partial').stretchReason = null;
  rejectsCode(() => validateResumeEditorialReview(context, stretch, 'reviewer'), 'INVALID_INPUT');
  const unknown = review(context); unknown.forceApprove = true;
  rejectsCode(() => validateResumeEditorialReview(context, unknown, 'reviewer'), 'INVALID_INPUT');
  const noDecision = review(context); delete noDecision.decision;
  rejectsCode(() => validateResumeEditorialReview(context, noDecision, 'reviewer'), 'INVALID_INPUT');
});

test('canonical input refuses getters and non-JSON values without evaluating them', () => {
  const data = input(); let reads = 0;
  Object.defineProperty(data.payload, 'summary', { enumerable: true, get() { reads += 1; return 'not inert'; } });
  rejectsCode(() => buildResumeEditorialContext(data), 'INVALID_INPUT');
  assert.equal(reads, 0);
  const sparse = input(); sparse.sources = new Array(1);
  rejectsCode(() => buildResumeEditorialContext(sparse), 'INVALID_INPUT');
});

test('append-only ledger replays exact input, conflicts on changed intent, and rejects UPDATE/DELETE', (t) => {
  const db = database(t), context = buildResumeEditorialContext(input());
  const document = review(context);
  const first = record(db, context, document);
  assert.equal(first.replayed, false);
  assert.match(first.review.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(first.review.revision_id, 16); assert.equal(first.review.render_id, 8);
  document.matrix.reverse(); document.omissions.reverse();
  assert.equal(record(db, context, document).review.id, first.review.id);
  assert.equal(record(db, context, document).replayed, true);
  const changed = review(context, 'changes_requested');
  rejectsCode(() => record(db, context, changed), 'IDEMPOTENCY_CONFLICT');
  assert.throws(() => db.prepare('UPDATE application_resume_editorial_reviews SET reviewed_by=? WHERE id=?').run('author', first.review.id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM application_resume_editorial_reviews WHERE id=?').run(first.review.id), /append-only/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM application_resume_editorial_reviews').get().n, 1);
  migrateResumeEditorialReviews(db);
  assert.equal(db.prepare('SELECT count(*) AS n FROM application_resume_editorial_reviews').get().n, 1, 'migration replay preserves review history');
});

test('v3 gate is independent of mechanical lint and a complete changes-requested matrix blocks', (t) => {
  const db = database(t), context = buildResumeEditorialContext(input());
  assert.deepEqual(getResumeEditorialReadiness(db, context).blockerCodes, ['RESUME_EDITORIAL_REVIEW_REQUIRED']);
  record(db, context, review(context));
  assert.equal(getResumeEditorialReadiness(db, context).ready, true);
  record(db, context, review(context, 'changes_requested'), 'editorial:16:2');
  assert.deepEqual(getResumeEditorialReadiness(db, context).blockerCodes, ['RESUME_EDITORIAL_CHANGES_REQUESTED']);
  record(db, context, review(context), 'editorial:16:3');
  assert.equal(getResumeEditorialReadiness(db, context).ready, true);
  const changed = input(); changed.sources[0].sha256 = H('e');
  assert.deepEqual(getResumeEditorialReadiness(db, buildResumeEditorialContext(changed)).blockerCodes, ['RESUME_EDITORIAL_REVIEW_STALE']);
  const anotherRender = input(); anotherRender.renderId = 9;
  assert.deepEqual(getResumeEditorialReadiness(db, buildResumeEditorialContext(anotherRender)).blockerCodes, ['RESUME_EDITORIAL_REVIEW_REQUIRED']);
  db.pragma('query_only = ON');
  assert.equal(getResumeEditorialReadiness(db, context).ready, true, 'readiness never migrates or writes');
});

test('read-only gate handles absent schema and preserves existing v1/v2 artifacts', (t) => {
  const db = database(t, false), context = buildResumeEditorialContext(input());
  db.pragma('query_only = ON');
  assert.deepEqual(getResumeEditorialReadiness(db, context).blockerCodes, ['RESUME_EDITORIAL_REVIEW_REQUIRED']);
  assert.equal(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get('application_resume_editorial_reviews'), undefined);
  for (const templateKey of ['resume.standard.v1', 'resume.standard.v2']) {
    assert.deepEqual(getResumeEditorialReadiness(db, { templateKey }), { required: false, ready: true, blockerCodes: [], reviewId: null });
  }
});
