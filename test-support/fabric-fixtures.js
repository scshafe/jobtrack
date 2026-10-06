'use strict';

// Shared materials fixtures for the fabric tests: draft revisions, synthetic
// container-free renders (the createMaterialRender renderResult path), and
// passing lint reports. Lives OUTSIDE test/ so `node --test` never treats it
// as a test file. Test-only code — never required by lib/ or bin/.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildApplicationMaterialsContext,
  createMaterialDraft,
  createMaterialRender,
  reviewMaterialRevision,
  selectMaterialRevision
} = require('../lib/application-materials');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function draft(db, applicationId, kind, content, parentId, artifactId, profileEntryId, key, stage) {
  const expectedSourceStateSha256 = buildApplicationMaterialsContext(db, applicationId, {
    kind, parentRevisionId: parentId, artifactIds: [artifactId], profileEntryIds: [profileEntryId]
  }).sourceStateSha256;
  return createMaterialDraft(db, {
    applicationId, kind, content,
    authoredBy: 'test-generator', stage,
    parentRevisionId: parentId, expectedHeadRevisionId: parentId,
    artifactIds: [artifactId], profileEntryIds: [profileEntryId],
    expectedSourceStateSha256, idempotencyKey: key
  });
}

function syntheticExtractionText(db, revision) {
  const application = db.prepare('SELECT company, role FROM applications WHERE id=?').get(revision.application_id);
  return [
    'Cole Example',
    `${application?.company || 'Example Co'} — ${application?.role || 'Engineer'}`,
    '',
    `Synthetic extraction for revision ${revision.content_sha256}.`,
    'Deterministic body text that stands in for a rendered document during tests. '.repeat(6)
  ].join('\n');
}

let lintSequence = 0;

function recordPassingLint(db, applicationId, renderId) {
  const { recordMaterialLintReport } = require('../lib/resume-lint');
  lintSequence += 1;
  const outcome = recordMaterialLintReport(db, {
    applicationId, renderId, lintedBy: 'test-lint', idempotencyKey: `fabric-fixture-lint:${renderId}:${lintSequence}`
  });
  assert.equal(outcome.verdict, 'pass', JSON.stringify(outcome.findings));
  return outcome;
}

/** The real linter over a render that violates policy (e.g. a two-page
 * synthetic render): asserts the verdict is fail and the expected code fired. */
function recordFailingLint(db, applicationId, renderId, expectedCode) {
  const { recordMaterialLintReport } = require('../lib/resume-lint');
  lintSequence += 1;
  const outcome = recordMaterialLintReport(db, {
    applicationId, renderId, lintedBy: 'test-lint', idempotencyKey: `fabric-fixture-lint:${renderId}:${lintSequence}`
  });
  assert.equal(outcome.verdict, 'fail', JSON.stringify(outcome.findings));
  assert.ok(outcome.findings.some((finding) => finding.code === expectedCode && finding.severity === 'error'),
    `expected finding ${expectedCode}: ${JSON.stringify(outcome.findings)}`);
  return outcome;
}

function syntheticRender(db, revision, options = {}) {
  const storeHome = path.dirname(db.name);
  const directory = path.join(storeHome, 'attachments', 'material-renders', String(revision.application_id), String(revision.id));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const pdf = Buffer.from(`%PDF-1.4\n% synthetic fabric render ${revision.content_sha256}\n%%EOF\n`);
  const outputSha256 = sha256(pdf);
  const outputPath = path.join(directory, `${outputSha256}.pdf`);
  fs.writeFileSync(outputPath, pdf, { mode: 0o600 });
  const extractedText = syntheticExtractionText(db, revision);
  const textPath = path.join(directory, `${outputSha256}.txt`);
  fs.writeFileSync(textPath, extractedText, { mode: 0o600 });
  const created = createMaterialRender(db, {
    applicationId: revision.application_id,
    revisionId: revision.id,
    expectedContentSha256: revision.content_sha256,
    renderedBy: 'test-fixed-renderer',
    idempotencyKey: `fabric-fixture-render:${revision.id}`,
    renderResult: {
      rendererProfile: 'jobtrack-latex-pdf-v1',
      rendererImageDigest: `sha256:${'a'.repeat(64)}`,
      rendererVersion: 'test-renderer-v1',
      bundleSha256: 'b'.repeat(64),
      outputAttachmentPath: outputPath,
      extractedTextAttachmentPath: textPath,
      outputSha256,
      outputBytes: pdf.length,
      pageCount: options.pageCount ?? 1,
      extractedTextSha256: sha256(extractedText),
      activeContentPolicy: 'jobtrack-pdf-active-content.v1',
      activeContentScanSha256: sha256(`jobtrack-pdf-active-content.v1\n${outputSha256}\nclean\n`)
    }
  });
  return created.render;
}

/** Rough -> final-candidate -> synthetic render -> passing lint. Stops there:
 * review and selection are gate acts the test under exercise performs. */
function finalCandidateWithRender(db, applicationId, kind, artifactId, profileEntryId, key) {
  const rough = draft(db, applicationId, kind, `${kind} rough`, null, artifactId, profileEntryId, `${key}:rough`);
  const final = draft(db, applicationId, kind, `${kind} final`, rough.revision.id, artifactId, profileEntryId, `${key}:final`, 'final-candidate');
  const render = syntheticRender(db, final.revision);
  recordPassingLint(db, applicationId, render.id);
  return { final: final.revision, render };
}

/** The whole arc through selection, for fixtures that just need a done kind. */
function finishMaterial(db, applicationId, kind, artifactId, profileEntryId, key) {
  const { final, render } = finalCandidateWithRender(db, applicationId, kind, artifactId, profileEntryId, key);
  reviewMaterialRevision(db, {
    applicationId, revisionId: final.id, renderId: render.id,
    decision: 'approved', reviewedBy: 'Cole', expectedReviewId: null, idempotencyKey: `${key}:review`
  });
  selectMaterialRevision(db, {
    applicationId, revisionId: final.id, selectedBy: 'Cole',
    expectedSelectedRevisionId: null, idempotencyKey: `${key}:select`
  });
  return { final, render };
}

module.exports = {
  draft,
  finalCandidateWithRender,
  finishMaterial,
  recordFailingLint,
  recordPassingLint,
  sha256,
  syntheticExtractionText,
  syntheticRender
};
