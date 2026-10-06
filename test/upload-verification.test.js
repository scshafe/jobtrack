'use strict';

// Regression suite for the last mile of the gate chain.
//
// The failure being guarded is not hypothetical: applysim drill
// r2608050256bb3f uploaded a resume whose bytes were destroyed in transit
// (poppler could not find the trailer dictionary; zero characters extracted)
// while its sibling cover letter arrived intact, and neither uploaded hash
// matched any render in the store. Every upstream gate was green.

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  UploadVerificationError,
  ensureUploadVerificationSchema,
  listExpectedUploads,
  inspectUploadBytes,
  recordUploadVerification,
  verifyApplicationUploads,
  assertUploadsVerified
} = require('../lib/upload-verification');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Minimal store carrying only the tables the verifier touches, wired with the
 * same foreign keys and kind vocabulary the real schema uses.
 */
function createFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-upload-verify-'));
  const db = new Database(path.join(home, 'jobtrack.db'));
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE applications (id INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT NOT NULL);
    CREATE TABLE application_material_kinds (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE application_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id),
      material_kind_id INTEGER NOT NULL REFERENCES application_material_kinds(id)
    );
    CREATE TABLE application_material_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id INTEGER NOT NULL REFERENCES application_materials(id),
      content_sha256 TEXT NOT NULL
    );
    CREATE TABLE application_material_renders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision_id INTEGER NOT NULL REFERENCES application_material_revisions(id),
      output_sha256 TEXT NOT NULL,
      output_bytes INTEGER NOT NULL,
      page_count INTEGER NOT NULL,
      output_attachment_path TEXT NOT NULL
    );
    CREATE TABLE application_material_selections (
      material_id INTEGER PRIMARY KEY REFERENCES application_materials(id),
      revision_id INTEGER NOT NULL REFERENCES application_material_revisions(id)
    );
  `);
  db.prepare("INSERT INTO application_material_kinds(slug) VALUES ('resume'),('cover-letter'),('form-answer')").run();
  const applicationId = Number(db.prepare("INSERT INTO applications(company) VALUES ('Drove')").run().lastInsertRowid);
  ensureUploadVerificationSchema(db);
  return { home, db, applicationId };
}

/** A minimal but genuinely well-formed PDF byte string. */
function pdfBytes(label) {
  return Buffer.from(`%PDF-1.4\n% ${label}\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
}

function addRenderedMaterial(fixture, kind, label) {
  const { db, home, applicationId } = fixture;
  const kindId = db.prepare('SELECT id FROM application_material_kinds WHERE slug=?').get(kind).id;
  const materialId = Number(db.prepare('INSERT INTO application_materials(application_id,material_kind_id) VALUES (?,?)')
    .run(applicationId, kindId).lastInsertRowid);
  const revisionId = Number(db.prepare('INSERT INTO application_material_revisions(material_id,content_sha256) VALUES (?,?)')
    .run(materialId, sha256(label)).lastInsertRowid);
  const bytes = pdfBytes(label);
  const directory = path.join(home, 'attachments', 'material-renders', String(revisionId));
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, 'document.pdf');
  fs.writeFileSync(filePath, bytes);
  const renderId = Number(db.prepare(`
    INSERT INTO application_material_renders(revision_id,output_sha256,output_bytes,page_count,output_attachment_path)
    VALUES (?,?,?,?,?)
  `).run(revisionId, sha256(bytes), bytes.length, 1, filePath).lastInsertRowid);
  db.prepare('INSERT INTO application_material_selections(material_id,revision_id) VALUES (?,?)').run(materialId, revisionId);
  return { materialId, revisionId, renderId, filePath, bytes, sha: sha256(bytes) };
}

test('expected uploads are the selected materials that actually have renders', (t) => {
  const fixture = createFixture(t);
  const resume = addRenderedMaterial(fixture, 'resume', 'resume');
  const letter = addRenderedMaterial(fixture, 'cover-letter', 'letter');

  // A selected form-answer has no render and must not appear as a file to carry.
  const formKindId = fixture.db.prepare("SELECT id FROM application_material_kinds WHERE slug='form-answer'").get().id;
  const formMaterialId = Number(fixture.db.prepare('INSERT INTO application_materials(application_id,material_kind_id) VALUES (?,?)')
    .run(fixture.applicationId, formKindId).lastInsertRowid);
  const formRevisionId = Number(fixture.db.prepare('INSERT INTO application_material_revisions(material_id,content_sha256) VALUES (?,?)')
    .run(formMaterialId, sha256('answer')).lastInsertRowid);
  fixture.db.prepare('INSERT INTO application_material_selections(material_id,revision_id) VALUES (?,?)').run(formMaterialId, formRevisionId);

  const expected = listExpectedUploads(fixture.db, fixture.applicationId);
  assert.deepEqual(expected.map((item) => item.materialKind), ['cover-letter', 'resume']);
  assert.deepEqual(expected.map((item) => item.renderId).sort(), [resume.renderId, letter.renderId].sort());
});

test('matching bytes verify; the drill corruption is caught as a mismatch', (t) => {
  const fixture = createFixture(t);
  const resume = addRenderedMaterial(fixture, 'resume', 'resume');
  const letter = addRenderedMaterial(fixture, 'cover-letter', 'letter');

  // Reproduce the drill exactly: the cover letter is carried intact, the resume
  // is corrupted in transit (bytes mangled, structure destroyed).
  const staged = path.join(fixture.home, 'staged');
  fs.mkdirSync(staged);
  const goodLetter = path.join(staged, 'letter.pdf');
  const badResume = path.join(staged, 'resume.pdf');
  fs.copyFileSync(letter.filePath, goodLetter);
  const mangled = Buffer.from(resume.bytes);
  mangled.fill(0x00, 20, 40);
  fs.writeFileSync(badResume, mangled);

  const report = verifyApplicationUploads(fixture.db, {
    applicationId: fixture.applicationId,
    files: { resume: badResume, 'cover-letter': goodLetter },
    verifiedBy: 'test',
    idempotencyKey: 'drill'
  });

  assert.equal(report.allVerified, false, 'a corrupted carry must not pass');
  const byKind = Object.fromEntries(report.results.map((item) => [item.materialKind, item]));
  assert.equal(byKind['cover-letter'].verdict, 'verified');
  assert.equal(byKind.resume.verdict, 'mismatch');
  assert.notEqual(byKind.resume.observedSha256, byKind.resume.expectedSha256);

  // And the gate refuses the submission on exactly that basis.
  assert.throws(() => assertUploadsVerified(fixture.db, fixture.applicationId), (error) => {
    assert.equal(error.code, 'UPLOAD_NOT_VERIFIED');
    assert.deepEqual(error.details.unverified.map((item) => item.materialKind), ['resume']);
    return true;
  });
});

test('a structurally unreadable file fails even when its digest matches', (t) => {
  const fixture = createFixture(t);
  const resume = addRenderedMaterial(fixture, 'resume', 'resume');
  addRenderedMaterial(fixture, 'cover-letter', 'letter');

  // The exact drill signature: the file is byte-identical to the render, but a
  // parser cannot open it. Digest alone would call this fine.
  const outcome = recordUploadVerification(fixture.db, {
    applicationId: fixture.applicationId,
    renderId: resume.renderId,
    filePath: resume.filePath,
    verifiedBy: 'test',
    idempotencyKey: 'structural',
    inspectPdfStructure: () => ({ status: 'fail', detail: 'unable to find /Root dictionary' })
  });
  assert.equal(outcome.verdict, 'unreadable');
  assert.equal(outcome.event.structural_status, 'fail');
  assert.match(outcome.event.structural_detail, /Root dictionary/);
});

test('a passing verification goes stale when the render moves', (t) => {
  const fixture = createFixture(t);
  const resume = addRenderedMaterial(fixture, 'resume', 'resume');
  const letter = addRenderedMaterial(fixture, 'cover-letter', 'letter');
  verifyApplicationUploads(fixture.db, {
    applicationId: fixture.applicationId,
    files: { resume: resume.filePath, 'cover-letter': letter.filePath },
    verifiedBy: 'test',
    idempotencyKey: 'fresh'
  });
  assert.deepEqual(assertUploadsVerified(fixture.db, fixture.applicationId), { verified: true, count: 2 });

  // Re-rendering the resume must invalidate the old pass rather than inherit it.
  const replacement = pdfBytes('resume rerendered');
  fixture.db.prepare('UPDATE application_material_renders SET output_sha256=?, output_bytes=? WHERE id=?')
    .run(sha256(replacement), replacement.length, resume.renderId);
  assert.throws(() => assertUploadsVerified(fixture.db, fixture.applicationId), (error) => error.code === 'UPLOAD_NOT_VERIFIED');
});

test('verification events are append-only observations', (t) => {
  const fixture = createFixture(t);
  const resume = addRenderedMaterial(fixture, 'resume', 'resume');
  const outcome = recordUploadVerification(fixture.db, {
    applicationId: fixture.applicationId,
    renderId: resume.renderId,
    filePath: resume.filePath,
    verifiedBy: 'test',
    idempotencyKey: 'immutable'
  });
  assert.equal(outcome.verdict, 'verified');
  assert.equal(outcome.event.structural_status, 'skipped', 'no inspector means skipped, never a claimed pass');
  assert.throws(() => fixture.db.prepare('UPDATE application_upload_verification_events SET verdict=? WHERE id=?')
    .run('verified', outcome.event.id), /immutable/);
  assert.throws(() => fixture.db.prepare('DELETE FROM application_upload_verification_events WHERE id=?')
    .run(outcome.event.id), /immutable/);
});

test('idempotency replays the same observation and rejects a changed one', (t) => {
  const fixture = createFixture(t);
  const resume = addRenderedMaterial(fixture, 'resume', 'resume');
  const input = {
    applicationId: fixture.applicationId,
    renderId: resume.renderId,
    filePath: resume.filePath,
    verifiedBy: 'test',
    idempotencyKey: 'replay'
  };
  const first = recordUploadVerification(fixture.db, input);
  const second = recordUploadVerification(fixture.db, input);
  assert.equal(second.replayed, true);
  assert.equal(second.event.id, first.event.id);

  const other = path.join(fixture.home, 'other.pdf');
  fs.writeFileSync(other, pdfBytes('different document'));
  assert.throws(() => recordUploadVerification(fixture.db, { ...input, filePath: other }),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT');
});

test('scope and input errors are refused rather than recorded', (t) => {
  const fixture = createFixture(t);
  const resume = addRenderedMaterial(fixture, 'resume', 'resume');

  assert.throws(() => recordUploadVerification(fixture.db, {
    applicationId: fixture.applicationId, renderId: resume.renderId,
    filePath: path.join(fixture.home, 'nope.pdf'), verifiedBy: 'test', idempotencyKey: 'missing'
  }), (error) => error.code === 'UPLOAD_FILE_MISSING');

  assert.throws(() => recordUploadVerification(fixture.db, {
    applicationId: fixture.applicationId, renderId: 9999,
    filePath: resume.filePath, verifiedBy: 'test', idempotencyKey: 'norender'
  }), (error) => error.code === 'RENDER_NOT_FOUND');

  const otherApplicationId = Number(fixture.db.prepare("INSERT INTO applications(company) VALUES ('Other')").run().lastInsertRowid);
  assert.throws(() => recordUploadVerification(fixture.db, {
    applicationId: otherApplicationId, renderId: resume.renderId,
    filePath: resume.filePath, verifiedBy: 'test', idempotencyKey: 'scope'
  }), (error) => error.code === 'RENDER_SCOPE_MISMATCH');

  assert.throws(() => verifyApplicationUploads(fixture.db, {
    applicationId: fixture.applicationId, files: { portfolio: resume.filePath },
    verifiedBy: 'test', idempotencyKey: 'unknown-kind'
  }), (error) => error.code === 'UNKNOWN_MATERIAL_KIND');

  assert.equal(fixture.db.prepare('SELECT count(*) AS count FROM application_upload_verification_events').get().count, 0);
});

test('byte inspection reports shape without a container', (t) => {
  const fixture = createFixture(t);
  const resume = addRenderedMaterial(fixture, 'resume', 'resume');
  const good = inspectUploadBytes(resume.filePath);
  assert.equal(good.sha256, resume.sha);
  assert.equal(good.looksLikePdf, true);

  const notPdf = path.join(fixture.home, 'notes.txt');
  fs.writeFileSync(notPdf, 'this is not a pdf');
  assert.equal(inspectUploadBytes(notPdf).looksLikePdf, false);
  assert.throws(() => inspectUploadBytes(path.join(fixture.home, 'absent')), UploadVerificationError);
});
