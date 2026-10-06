'use strict';

// upload-verification.js — the last mile of the materials gate chain.
//
// WHY THIS EXISTS
// ---------------
// Everything upstream of this module verifies a file nobody read. A material
// revision is content-addressed, a render is digest-pinned and structurally
// checked by `qpdf --check` inside the renderer, and the resulting bytes are
// hashed into `application_material_renders.output_sha256`. All of that
// describes a PDF sitting in the store.
//
// The applysim drill r2608050256bb3f proved the gap: it uploaded a resume whose
// object streams were destroyed in transit — poppler could not find the trailer
// dictionary and extracted ZERO characters — while its sibling cover letter
// arrived intact. Neither uploaded file's hash matched any render in the store.
// Every upstream gate was green and an unreadable resume reached the employer.
//
// So the chain has to reach the bytes that are actually carried:
//
//   render.output_sha256  ==  sha256(file staged for upload)  [==  received]
//
// Two independent checks, because they fail in different situations:
//   * DIGEST — proves the carried bytes are the reviewed-and-selected bytes.
//     Requires a known expected hash.
//   * STRUCTURE — proves the file is a readable PDF on its own terms, via the
//     same pinned image the renderer uses. Catches corruption even when no
//     expected hash exists (an out-of-band file, a hand-staged path).
//
// Verification events are append-only observations. `assertUploadsVerified`
// turns them into a gate: a managed submission cannot be recorded unless every
// rendered material in the package has a passing, current verification.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_LABELS = Object.freeze(['staged', 'received']);
const VERDICTS = Object.freeze(['verified', 'mismatch', 'unreadable']);
const STRUCTURAL_STATUSES = Object.freeze(['pass', 'fail', 'skipped']);
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

class UploadVerificationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'UploadVerificationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function positiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UploadVerificationError('INVALID_INPUT', `${label} must be a positive integer`);
  return parsed;
}

function requiredText(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim()) throw new UploadVerificationError('INVALID_INPUT', `${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new UploadVerificationError('INVALID_INPUT', `${label} exceeds ${max} characters`);
  return trimmed;
}

function ensureUploadVerificationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS application_upload_verification_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      material_kind_id INTEGER NOT NULL REFERENCES application_material_kinds(id) ON DELETE RESTRICT,
      revision_id INTEGER NOT NULL REFERENCES application_material_revisions(id) ON DELETE RESTRICT,
      render_id INTEGER NOT NULL REFERENCES application_material_renders(id) ON DELETE RESTRICT,
      source_label TEXT NOT NULL CHECK (source_label IN ('staged','received')),
      expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256)=64),
      observed_sha256 TEXT NOT NULL CHECK (length(observed_sha256)=64),
      observed_bytes INTEGER NOT NULL CHECK (observed_bytes>=0),
      structural_status TEXT NOT NULL CHECK (structural_status IN ('pass','fail','skipped')),
      structural_detail TEXT,
      verdict TEXT NOT NULL CHECK (verdict IN ('verified','mismatch','unreadable')),
      verified_by TEXT NOT NULL CHECK (trim(verified_by)<>''),
      verified_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_upload_verification_render
      ON application_upload_verification_events(render_id, source_label, id);
    CREATE INDEX IF NOT EXISTS idx_upload_verification_application
      ON application_upload_verification_events(application_id, id);
  `);
  // Observations are facts: append-only, like every other event table here.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_upload_verification_immutable_update
      BEFORE UPDATE ON application_upload_verification_events
      BEGIN SELECT RAISE(ABORT,'application_upload_verification_events is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_upload_verification_immutable_delete
      BEFORE DELETE ON application_upload_verification_events
      BEGIN SELECT RAISE(ABORT,'application_upload_verification_events is immutable'); END;
  `);
  // A verification must point at a render of the revision it claims, for the
  // application it claims — the same scope discipline the sibling tables use.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_upload_verification_scope
      BEFORE INSERT ON application_upload_verification_events
      WHEN NOT EXISTS (
        SELECT 1
        FROM application_material_renders r
        JOIN application_material_revisions v ON v.id=r.revision_id
        JOIN application_materials m ON m.id=v.material_id
        WHERE r.id=NEW.render_id
          AND r.revision_id=NEW.revision_id
          AND m.application_id=NEW.application_id
          AND m.material_kind_id=NEW.material_kind_id
      )
      BEGIN SELECT RAISE(ABORT,'verification render, revision, kind and application must agree'); END;
  `);
}

/**
 * The rendered materials a submission will actually carry: every SELECTED
 * material revision that has a render. Form answers are typed into the form and
 * have no file, so they are absent by construction rather than by filtering.
 */
function listExpectedUploads(db, applicationId) {
  const id = positiveId(applicationId, 'application id');
  return db.prepare(`
    SELECT
      k.slug           AS materialKind,
      k.id             AS materialKindId,
      m.id             AS materialId,
      s.revision_id    AS revisionId,
      r.id             AS renderId,
      r.output_sha256  AS expectedSha256,
      r.output_bytes   AS expectedBytes,
      r.page_count     AS pageCount,
      r.output_attachment_path AS attachmentPath
    FROM application_material_selections s
    JOIN application_materials m ON m.id=s.material_id
    JOIN application_material_kinds k ON k.id=m.material_kind_id
    JOIN application_material_renders r ON r.revision_id=s.revision_id
    WHERE m.application_id=?
    ORDER BY k.slug
  `).all(id);
}

/** Hash and shape-check a file on disk. No container needed. */
function inspectUploadBytes(filePath) {
  const resolved = path.resolve(filePath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new UploadVerificationError('UPLOAD_FILE_MISSING', `No file at ${resolved}`);
  }
  if (!stat.isFile()) throw new UploadVerificationError('UPLOAD_FILE_MISSING', `${resolved} is not a regular file`);
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new UploadVerificationError('UPLOAD_FILE_TOO_LARGE', `${resolved} exceeds ${MAX_UPLOAD_BYTES} bytes`);
  }
  const bytes = fs.readFileSync(resolved);
  const header = bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  const trailer = bytes.subarray(Math.max(0, bytes.length - 2048)).includes(Buffer.from('%%EOF'));
  return {
    path: resolved,
    sha256: sha256(bytes),
    bytes: bytes.length,
    looksLikePdf: header && trailer
  };
}

/**
 * Verify one staged (or received) file against the render it claims to be, and
 * record the observation.
 *
 * `inspectPdfStructure` is injected so the caller decides whether the pinned
 * container runs; when absent the structural leg records `skipped` rather than
 * silently claiming a pass it never made.
 */
function recordUploadVerification(db, input) {
  ensureUploadVerificationSchema(db);
  const applicationId = positiveId(input.applicationId, 'application id');
  const renderId = positiveId(input.renderId, 'render id');
  const sourceLabel = requiredText(input.sourceLabel || 'staged', 'source label', 20);
  if (!SOURCE_LABELS.includes(sourceLabel)) {
    throw new UploadVerificationError('INVALID_INPUT', `source label must be one of ${SOURCE_LABELS.join(', ')}`);
  }
  const verifiedBy = requiredText(input.verifiedBy, 'verified by');
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key');
  const verifiedAt = input.verifiedAt ? requiredText(input.verifiedAt, 'verified at', 40) : new Date().toISOString();

  const expected = db.prepare(`
    SELECT r.id AS renderId, r.revision_id AS revisionId, r.output_sha256 AS expectedSha256,
           r.output_bytes AS expectedBytes, m.material_kind_id AS materialKindId, m.application_id AS applicationId
    FROM application_material_renders r
    JOIN application_material_revisions v ON v.id=r.revision_id
    JOIN application_materials m ON m.id=v.material_id
    WHERE r.id=?
  `).get(renderId);
  if (!expected) throw new UploadVerificationError('RENDER_NOT_FOUND', `No render ${renderId}`);
  if (expected.applicationId !== applicationId) {
    throw new UploadVerificationError('RENDER_SCOPE_MISMATCH', `Render ${renderId} does not belong to application ${applicationId}`);
  }

  const observed = inspectUploadBytes(input.filePath);
  const structure = typeof input.inspectPdfStructure === 'function'
    ? input.inspectPdfStructure(observed.path)
    : { status: 'skipped', detail: 'structural inspection not requested' };
  if (!STRUCTURAL_STATUSES.includes(structure.status)) {
    throw new UploadVerificationError('INVALID_INPUT', `structural status must be one of ${STRUCTURAL_STATUSES.join(', ')}`);
  }

  // Digest first: a byte mismatch is the headline finding even if the file
  // happens to be a structurally valid PDF of something else entirely.
  let verdict;
  if (observed.sha256 !== expected.expectedSha256) verdict = 'mismatch';
  else if (structure.status === 'fail' || !observed.looksLikePdf) verdict = 'unreadable';
  else verdict = 'verified';

  const structuralDetail = structure.status === 'pass'
    ? null
    : [structure.detail, observed.looksLikePdf ? null : 'missing %PDF header or %%EOF trailer']
      .filter(Boolean).join('; ') || null;

  const intent = {
    applicationId, renderId, sourceLabel, verifiedBy,
    observedSha256: observed.sha256, observedBytes: observed.bytes, verdict
  };
  const intentSha256 = sha256(stableJson(intent));

  const prior = db.prepare('SELECT * FROM application_upload_verification_events WHERE idempotency_key=?').get(idempotencyKey);
  if (prior) {
    if (prior.intent_sha256 !== intentSha256) {
      throw new UploadVerificationError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different verification');
    }
    return { event: prior, verdict: prior.verdict, replayed: true };
  }

  const info = db.prepare(`
    INSERT INTO application_upload_verification_events(
      application_id,material_kind_id,revision_id,render_id,source_label,
      expected_sha256,observed_sha256,observed_bytes,
      structural_status,structural_detail,verdict,verified_by,verified_at,
      idempotency_key,intent_sha256
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    applicationId, expected.materialKindId, expected.revisionId, renderId, sourceLabel,
    expected.expectedSha256, observed.sha256, observed.bytes,
    structure.status, structuralDetail, verdict, verifiedBy, verifiedAt,
    idempotencyKey, intentSha256
  );

  return {
    event: db.prepare('SELECT * FROM application_upload_verification_events WHERE id=?').get(Number(info.lastInsertRowid)),
    verdict,
    replayed: false,
    expectedSha256: expected.expectedSha256,
    observedSha256: observed.sha256
  };
}

/**
 * Verify a set of staged files for an application, keyed by material kind.
 * `files` is `{ resume: '/path/a.pdf', 'cover-letter': '/path/b.pdf' }`.
 */
function verifyApplicationUploads(db, input) {
  ensureUploadVerificationSchema(db);
  const applicationId = positiveId(input.applicationId, 'application id');
  const files = input.files && typeof input.files === 'object' ? input.files : {};
  const expectedUploads = listExpectedUploads(db, applicationId);
  if (!expectedUploads.length) {
    throw new UploadVerificationError('NO_RENDERED_MATERIALS', `Application ${applicationId} has no selected materials with renders`);
  }

  const unknown = Object.keys(files).filter((kind) => !expectedUploads.some((upload) => upload.materialKind === kind));
  if (unknown.length) {
    throw new UploadVerificationError('UNKNOWN_MATERIAL_KIND', `No selected, rendered material for: ${unknown.join(', ')}`);
  }

  const results = expectedUploads.map((upload) => {
    const filePath = files[upload.materialKind];
    if (!filePath) {
      return { materialKind: upload.materialKind, renderId: upload.renderId, verdict: 'not-provided', expectedSha256: upload.expectedSha256 };
    }
    const outcome = recordUploadVerification(db, {
      applicationId,
      renderId: upload.renderId,
      filePath,
      sourceLabel: input.sourceLabel || 'staged',
      verifiedBy: input.verifiedBy,
      verifiedAt: input.verifiedAt,
      idempotencyKey: `${requiredText(input.idempotencyKey, 'idempotency key')}:${upload.materialKind}`,
      inspectPdfStructure: input.inspectPdfStructure
    });
    return {
      materialKind: upload.materialKind,
      renderId: upload.renderId,
      verdict: outcome.verdict,
      expectedSha256: upload.expectedSha256,
      observedSha256: outcome.observedSha256 || outcome.event.observed_sha256,
      structuralStatus: outcome.event.structural_status,
      structuralDetail: outcome.event.structural_detail,
      replayed: outcome.replayed
    };
  });

  return {
    applicationId,
    allVerified: results.every((result) => result.verdict === 'verified'),
    results
  };
}

/**
 * Gate: every rendered material selected for this application must have a
 * CURRENT passing staged verification — current meaning the verification's
 * expected hash still equals the render's hash, so re-rendering or re-selecting
 * invalidates a stale pass rather than carrying it forward.
 */
function assertUploadsVerified(db, applicationId) {
  ensureUploadVerificationSchema(db);
  const expectedUploads = listExpectedUploads(db, applicationId);
  const unverified = [];
  for (const upload of expectedUploads) {
    const pass = db.prepare(`
      SELECT e.* FROM application_upload_verification_events e
      WHERE e.render_id=? AND e.source_label='staged' AND e.verdict='verified' AND e.expected_sha256=?
      ORDER BY e.id DESC LIMIT 1
    `).get(upload.renderId, upload.expectedSha256);
    if (!pass) unverified.push({ materialKind: upload.materialKind, renderId: upload.renderId, expectedSha256: upload.expectedSha256 });
  }
  if (unverified.length) {
    throw new UploadVerificationError(
      'UPLOAD_NOT_VERIFIED',
      `The bytes to be uploaded were never verified against their render: ${unverified.map((item) => item.materialKind).join(', ')}. `
      + 'Run `jobtrack application-material verify-uploads` on the exact files that will be attached.',
      { unverified }
    );
  }
  return { verified: true, count: expectedUploads.length };
}

module.exports = {
  UploadVerificationError,
  SOURCE_LABELS,
  VERDICTS,
  ensureUploadVerificationSchema,
  listExpectedUploads,
  inspectUploadBytes,
  recordUploadVerification,
  verifyApplicationUploads,
  assertUploadsVerified
};
