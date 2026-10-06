'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');
const { RENDERER_IMAGE_DIGEST } = require('../lib/latex-renderer');
const DENSE = require('./fixtures/material-templates-v3/dense-resume.json');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'jobtrack.js');

// Run with Node 24 and JOBTRACK_RUN_LATEX_CONTAINER_TESTS=1. The public CLI
// invokes the existing fixed networkless renderer and metrics inspector. The
// fabricated profile and posting below exist only in this private fresh store.
test('v3 CLI lifecycle binds real PDF lint, independent editorial review and readiness revocation', {
  skip: process.env.JOBTRACK_RUN_LATEX_CONTAINER_TESTS !== '1',
  timeout: 120000
}, (t) => {
  const base = path.join(os.homedir(), '.cache', 'jobtrack', 'container-tests');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const temporaryRoot = fs.mkdtempSync(path.join(base, 'editorial-cli-'));
  const store = path.join(temporaryRoot, 'store');
  const staging = path.join(temporaryRoot, 'render-staging');
  fs.mkdirSync(store, { mode: 0o700 });
  fs.mkdirSync(staging, { mode: 0o700 });
  let db;
  t.after(() => {
    if (db?.open) db.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const env = { ...process.env, JOBTRACK_HOME: store, JOBTRACK_DB: path.join(store, 'jobtrack.db'),
    JOBTRACK_RENDER_TMPDIR: staging };
  function run(args, expectedError = null) {
    const result = spawnSync(process.execPath, [CLI, ...args.map(String), '--json'], {
      cwd: ROOT, env, encoding: 'utf8', timeout: 55000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.ifError(result.error);
    const output = `${result.stdout}\n${result.stderr}`;
    if (expectedError) {
      assert.notEqual(result.status, 0, 'the CLI must reject this operation');
      assert.match(output, new RegExp(expectedError));
      return null;
    }
    assert.equal(result.status, 0, `${args.slice(0, 2).join(' ')} failed: ${output}`);
    return JSON.parse(result.stdout);
  }

  run(['init']);
  const application = run(['add-prospect', '--company', 'Synthetic Editorial Co', '--role', 'Backend Engineer',
    '--url', 'https://editorial.example.test/jobs/backend']).application;
  db = new Database(path.join(store, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  const posting = [
    "What you'll do", 'Build reliable customer integrations.',
    'Requirements', 'Production TypeScript services.', 'Mentor senior engineers.',
    'Nice to have', 'AWS delivery experience.',
    'Benefits', 'Four weeks leave.', 'Apply for this role', 'Email address'
  ].join('\n');
  const artifactId = Number(db.prepare(`INSERT INTO application_artifacts(application_id,kind,title,content)
    VALUES (?,'posting','Synthetic qualification fixture',?)`).run(application.id, posting).lastInsertRowid);
  const profileId = Number(db.prepare(`INSERT INTO profile_entries(category,title,content,source,confidence,tags)
    VALUES ('work','Synthetic calibration evidence',?,'container-test fixture','high','[]')`)
    .run(JSON.stringify(DENSE)).lastInsertRowid);
  run(['add-research', '--application-id', application.id, '--source-url', 'https://editorial.example.test/about', '--citation', 'Synthetic research fixture', '--notes', 'Synthetic employer evidence.']);
  run(['assess-application', '--application-id', application.id, '--company-assessment', 'Synthetic employer', '--role-fit', 'Explicit stretch', '--risks', 'Mentoring not established', '--evidence', 'Synthetic posting and profile', '--open-questions', 'Mentoring threshold', '--approach', 'Independent review']);
  run(['review-assessment', '--application-id', application.id, '--decision', 'approved', '--decided-by', 'synthetic-independent-reviewer', '--notes', 'Proceed within isolated fixture']);
  const payloadFile = path.join(temporaryRoot, 'resume.json');
  fs.writeFileSync(payloadFile, JSON.stringify(DENSE), { mode: 0o600 });
  const material = (action, ...args) => run(['application-material', action, '--application-id', application.id, ...args]);

  function draft(parent = null) {
    const sourceFlags = ['--kind', 'resume', '--artifact-ids', artifactId, '--profile-entry-ids', profileId,
      ...(parent ? ['--parent-revision-id', parent.id] : [])];
    const context = material('context', ...sourceFlags).context;
    assert.match(context.sourceStateSha256, /^[0-9a-f]{64}$/);
    return material('draft', ...sourceFlags, '--template', 'resume.standard.v3', '--payload-file', payloadFile,
      '--authored-by', 'synthetic-author', '--stage', parent ? 'final-candidate' : 'rough-draft',
      '--expected-head-revision-id', parent?.id || 'none',
      '--expected-source-state-sha256', context.sourceStateSha256,
      '--idempotency-key', parent ? 'editorial-smoke:final' : 'editorial-smoke:rough').revision;
  }

  const rough = draft();
  const final = draft(rough);
  assert.equal(final.parent_revision_id, rough.id);
  assert.equal(final.revision_stage, 'final-candidate');
  const render = material('render', '--revision-id', final.id, '--expected-content-sha256', final.content_sha256,
    '--rendered-by', 'fixed-renderer-smoke', '--idempotency-key', 'editorial-smoke:render').render;
  assert.equal(render.page_count, 1);
  assert.equal(render.renderer_image_digest, RENDERER_IMAGE_DIGEST);
  const lint = material('lint', '--render-id', render.id, '--linted-by', 'mechanical-smoke',
    '--idempotency-key', 'editorial-smoke:lint');
  assert.equal(lint.verdict, 'pass', JSON.stringify(lint.findings));
  assert.equal(lint.errorCount, 0);
  assert.equal(lint.pdfMetrics.outputSha256, render.output_sha256);
  assert.equal(lint.pdfMetrics.wordLikeTokens, 426);
  assert.equal(lint.pdfMetrics.layoutAndRawTokenOrderEqual, true);
  assert.ok(Math.abs(lint.pdfMetrics.bodyFontSizePt - 10.5 * 72 / 72.27) < 0.001);
  assert.equal(lint.pdfMetrics.fontMeasurementSupported, true);

  const approvalArgs = ['application-material', 'review', '--application-id', application.id,
    '--revision-id', final.id, '--render-id', render.id, '--decision', 'approved',
    '--reviewed-by', 'material-reviewer', '--expected-review-id', 'none',
    '--idempotency-key', 'editorial-smoke:material-approval'];
  run(approvalArgs, 'RESUME_EDITORIAL_REVIEW_REQUIRED');
  assert.equal(db.prepare('SELECT count(*) AS n FROM application_material_review_events WHERE revision_id=?').get(final.id).n, 0);

  const context = material('editorial-context', '--revision-id', final.id, '--render-id', render.id).context;
  assert.equal(context.revisionId, final.id);
  assert.equal(context.renderId, render.id);
  assert.equal(context.postingContext.outputSha256, render.output_sha256);
  assert.deepEqual(context.ancestors.map((entry) => entry.revisionId), [rough.id]);
  assert.deepEqual(new Set(context.requirements.map((entry) => entry.text)), new Set([
    'Build reliable customer integrations.', 'Production TypeScript services.',
    'Mentor senior engineers.', 'AWS delivery experience.'
  ]));
  assert.ok(context.sources.some((source) => source.id === `profile:${profileId}`));
  const evidence = (payloadPath) => [{ sourceId: `profile:${profileId}`, payloadPath }];
  const review = {
    schemaVersion: 'jobtrack-resume-editorial-review.v1', contextSha256: context.contextSha256,
    decision: 'approved', notes: 'Synthetic sources and the exact PDF were reviewed independently.',
    matrix: context.requirements.map((requirement) => ({
      requirementId: requirement.id,
      status: requirement.text.includes('Mentor') ? 'not-demonstrated' : 'demonstrated',
      evidence: requirement.text.includes('Mentor') ? [] : evidence(requirement.text.includes('TypeScript')
        ? 'experience[0].bullets[2]' : requirement.text.includes('AWS') ? 'experience[3].bullets[0]' : 'experience[1].bullets[0]'),
      rationale: requirement.text.includes('Mentor') ? 'No mentoring evidence appears in the synthetic profile.' : 'The selected source supports this visible accomplishment.',
      stretchReason: requirement.text.includes('Mentor') ? 'Explicitly accept this fixture as a stretch without claiming mentoring.' : ''
    })),
    omissions: Object.values(context.factsDiff).flat().map((finding) => ({ findingId: finding.findingId,
      disposition: 'accepted', reason: 'The removed information was reviewed against this posting.' })),
    chronology: context.chronologyGaps.map((finding) => ({ findingId: finding.findingId,
      disposition: 'unexplained-gap-accepted', reason: 'Preserve accurate dates without inventing continuity.' }))
  };
  const reviewFile = path.join(temporaryRoot, 'review.json');
  fs.writeFileSync(reviewFile, JSON.stringify(review), { mode: 0o600 });
  const reviewArgs = ['application-material', 'editorial-review', '--application-id', application.id,
    '--revision-id', final.id, '--render-id', render.id, '--review-file', reviewFile];
  run([...reviewArgs, '--reviewed-by', 'synthetic-author', '--idempotency-key', 'editorial-smoke:self-review'], 'EDITORIAL_SELF_REVIEW');
  const approved = run([...reviewArgs, '--reviewed-by', 'independent-reviewer', '--idempotency-key', 'editorial-smoke:editorial-approval']);
  assert.equal(approved.review.reviewed_by, 'independent-reviewer');
  assert.equal(approved.review.context_sha256, context.contextSha256);
  run(approvalArgs);
  material('select', '--revision-id', final.id, '--selected-by', 'independent-selector',
    '--expected-selected-revision-id', 'none', '--idempotency-key', 'editorial-smoke:select');

  const before = material('readiness');
  assert.equal(before.baseline.resume.reviewDecision, 'approved');
  assert.equal(before.manifest.resumeEditorial.ready, true);
  assert.equal(before.manifest.resumeEditorial.reviewId, approved.review.id);
  assert.equal(before.manifest.resumeEditorial.contextSha256, context.contextSha256);
  assert.ok(!before.blockers.some((item) => /EDITORIAL/.test(item.code)));
  // This slice intentionally leaves the cover letter and form
  // unfinished: an approved resume must not imply whole-application readiness.
  assert.equal(before.ready, false);

  review.notes = 'A second independent approval carries its own provenance.';
  fs.writeFileSync(reviewFile, JSON.stringify(review), { mode: 0o600 });
  const reaffirmed = run([...reviewArgs, '--reviewed-by', 'second-independent-reviewer', '--idempotency-key', 'editorial-smoke:second-approval']);
  const renewed = material('readiness');
  assert.equal(renewed.manifest.resumeEditorial.reviewId, reaffirmed.review.id);
  assert.notEqual(renewed.readinessSha256, before.readinessSha256, 'the exact editorial approval participates in package readiness');

  review.decision = 'changes_requested';
  review.notes = 'Reconsider the explicit mentoring stretch before proceeding.';
  fs.writeFileSync(reviewFile, JSON.stringify(review), { mode: 0o600 });
  const revoked = run([...reviewArgs, '--reviewed-by', 'independent-reviewer', '--idempotency-key', 'editorial-smoke:changes-requested']);
  const after = material('readiness');
  assert.equal(after.baseline.resume.reviewDecision, 'approved', 'mechanical/material approval remains a separate event');
  assert.equal(after.manifest.resumeEditorial.ready, false);
  assert.equal(after.manifest.resumeEditorial.reviewId, revoked.review.id);
  assert.ok(after.blockers.some((item) => item.code === 'RESUME_EDITORIAL_CHANGES_REQUESTED'));
  assert.notEqual(after.readinessSha256, renewed.readinessSha256);
  run(['application-material', 'select', '--application-id', application.id, '--revision-id', final.id,
    '--selected-by', 'independent-selector', '--expected-selected-revision-id', final.id,
    '--idempotency-key', 'editorial-smoke:revoked-selection'], 'RESUME_EDITORIAL_CHANGES_REQUESTED');
  // Synthetic additional render identity over the same verified bytes. Recovery
  // must follow the ordinary approval's exact render, not whichever row is newest.
  const additionalRender = { ...db.prepare('SELECT * FROM application_material_renders WHERE id=?').get(render.id) };
  delete additionalRender.id;
  additionalRender.uuid = require('node:crypto').randomUUID();
  additionalRender.idempotency_key = 'editorial-smoke:additional-render-identity';
  additionalRender.rendered_by = 'synthetic-additional-render';
  const renderColumns = Object.keys(additionalRender);
  const extraRenderId = Number(db.prepare(`INSERT INTO application_material_renders (${renderColumns.join(',')}) VALUES (${renderColumns.map(() => '?').join(',')})`).run(...renderColumns.map((key) => additionalRender[key])).lastInsertRowid);
  assert.ok(extraRenderId > render.id);
  const ordinaryReviewCount = db.prepare('SELECT count(*) AS n FROM application_material_review_events WHERE revision_id=?').get(final.id).n;
  const next = require('../lib/fabric').deriveFabricNext(db);
  const items = next.subjects.find((s) => s.subjectKind === 'application' && s.subjectId === application.id)?.items ?? [];
  const recovery = items.find((item) => item.node === 'application.materials.draft' && item.instance === 'resume');
  // Changes requested need an authored revision, not a repeated approval of the
  // same bytes. The existing workflow carries the exact independent feedback.
  assert.ok(recovery, `revoked editorial approval has actionable revision work even after ordinary approval: ${JSON.stringify(next.subjects)}`);
  assert.equal(recovery.act.renderId, render.id, 'recover the approved render even when another render is newer');
  assert.equal(recovery.act.editorialReviewId, revoked.review.id);
  assert.ok(recovery.act.editorialFindings.some((finding) => finding.code === 'EDITORIAL_CHANGES_REQUESTED' && finding.message === review.notes));
  assert.ok(recovery.act.editorialFindings.some((finding) => finding.code === 'REQUIREMENT_NOT_DEMONSTRATED'));
  assert.ok(recovery.commands.some((c) => c.includes('application-material draft ')));
  assert.ok(!items.some((item) => item.node === 'application.materials.review' && item.instance === 'resume'), 'do not re-offer approval while the requested content changes remain unresolved');
  assert.ok(!recovery.commands.some((c) => c.includes('application-material review ')), 'recovery preserves the existing material approval');
  assert.equal(db.prepare('SELECT count(*) AS n FROM application_material_review_events WHERE revision_id=?').get(final.id).n, ordinaryReviewCount);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
