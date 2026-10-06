'use strict';

// The caller supplies a posting-scoped, source-validated context. This module
// never loads files, discovers sources, runs a model, or grants submit authority.
const crypto = require('node:crypto');

const EDITORIAL_REVIEW_VERSION = 'jobtrack-resume-editorial-review.v1';
const EDITORIAL_CONTEXT_VERSION = 'jobtrack-resume-editorial-context.v1';
const TABLE = 'application_resume_editorial_reviews';
const { isCompactResumeTemplate } = require('./material-templates');

class ResumeEditorialReviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ResumeEditorialReviewError';
    this.code = code;
  }
}

function fail(code, message) { throw new ResumeEditorialReviewError(code, message); }
function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT', `${label} must be non-empty text`);
  return value.trim();
}
function id(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_INPUT', `${label} must be a positive integer`);
  return value;
}
function sha(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('INVALID_INPUT', `${label} must be a SHA-256 digest`);
  return value;
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('INVALID_INPUT', `${label} must be a plain object`);
  }
  return value;
}
function array(value, label) {
  if (!Array.isArray(value)) fail('INVALID_INPUT', `${label} must be an array`);
  return value;
}
function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('INVALID_INPUT', `${label} has unknown field ${key}`);
  }
}

// Canonicalize inert JSON only: no getters, prototypes, undefined, cycles, or
// lossy non-finite numbers can quietly disappear from the reviewed digest.
function canonical(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) fail('INVALID_INPUT', 'Context must contain only acyclic JSON data');
  if (!Array.isArray(value)) object(value, 'JSON object');
  seen.add(value);
  const result = Array.isArray(value) ? [] : Object.create(null);
  const names = Array.isArray(value) ? Array.from({ length: value.length }, (_, i) => String(i)) : Object.keys(value).sort();
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT', 'JSON data must not contain getters or sparse arrays');
    result[key] = canonical(descriptor.value, seen);
  }
  seen.delete(value);
  return result;
}
function stableJson(value) { return JSON.stringify(canonical(value)); }
function digest(value) { return crypto.createHash('sha256').update(stableJson(value)).digest('hex'); }
function normalized(value) { return String(value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(); }
function unique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) fail('INVALID_INPUT', `Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}
function finding(kind, details) {
  return { findingId: `${kind}:${digest(details).slice(0, 24)}`, kind, ...details };
}
function roleIdentity(entry) {
  return { org: entry.org || '', title: entry.title || '', dates: entry.dates || '' };
}
function roleKey(entry) { return stableJson(canonical(roleIdentity(entry))); }
function bullets(payload) {
  const entries = [];
  for (const section of ['experience', 'projects']) {
    (payload[section] || []).forEach((entry, index) => {
      (entry.bullets || []).forEach((value, bulletIndex) => entries.push({
        payloadPath: `${section}[${index}].bullets[${bulletIndex}]`,
        text: value,
        owner: section === 'experience' ? roleIdentity(entry) : { project: entry.name || '' }
      }));
    });
  }
  return entries;
}
// Evidence must resolve to text actually visible in the current payload.
// Contact/name/link destinations cannot stand in for professional evidence.
function resumeEditorialEvidencePaths(payload) {
  const result = bullets(payload).map(({ payloadPath, text: value }) => ({ payloadPath, text: value }));
  const add = (path, value) => { if (typeof value === 'string' && value.trim()) result.push({ payloadPath: path, text: value }); };
  add('summary', payload.summary);
  for (const section of ['experience', 'projects', 'education']) {
    (payload[section] || []).forEach((entry, index) => {
      for (const key of ['org', 'title', 'dates', 'context', 'name', 'technologies', 'degree']) add(`${section}[${index}].${key}`, entry[key]);
      (entry.notes || []).forEach((value, noteIndex) => add(`${section}[${index}].notes[${noteIndex}]`, value));
    });
  }
  (payload.skills || []).forEach((group, index) => {
    if (typeof group === 'string') add(`skills[${index}]`, group);
    else (group.items || []).forEach((value, itemIndex) => add(`skills[${index}].items[${itemIndex}]`, value));
  });
  return result;
}
function skills(payload) {
  return (payload.skills || []).flatMap((group) => typeof group === 'string' ? [group] : group.items || []);
}
function scopeNumbers(value) {
  return [...new Set(String(value).match(/\b\d[\d,.]*(?:[+%]|x\b)?|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|hundreds?|thousands?|millions?)\b/gi) || [])];
}

function factualDiff(payload, ancestors) {
  const omittedRoles = new Map();
  const removedBullets = new Map();
  const removedScopeNumbers = new Map();
  const lostSkills = new Map();
  const currentRoles = new Set((payload.experience || []).map(roleKey));
  const currentBullets = bullets(payload);
  const currentSkills = new Set(skills(payload).map(normalized));
  const add = (map, kind, data, revisionId) => {
    const f = finding(kind, data);
    if (!map.has(f.findingId)) map.set(f.findingId, { ...f, ancestorRevisionIds: [] });
    const revisions = map.get(f.findingId).ancestorRevisionIds;
    if (!revisions.includes(revisionId)) revisions.push(revisionId);
  };
  for (const ancestor of ancestors) {
    for (const role of ancestor.payload.experience || []) {
      if (!currentRoles.has(roleKey(role))) add(omittedRoles, 'omitted-role', roleIdentity(role), ancestor.revisionId);
    }
    for (const bullet of bullets(ancestor.payload)) {
      const sameOwner = currentBullets.filter((entry) => stableJson(entry.owner) === stableJson(bullet.owner));
      if (!sameOwner.some((entry) => normalized(entry.text) === normalized(bullet.text))) {
        add(removedBullets, 'removed-bullet', { owner: bullet.owner, text: bullet.text }, ancestor.revisionId);
      }
      const remainingNumbers = new Set(sameOwner.flatMap((entry) => scopeNumbers(entry.text)).map(normalized));
      for (const value of scopeNumbers(bullet.text)) {
        if (!remainingNumbers.has(normalized(value))) {
          add(removedScopeNumbers, 'removed-scope-number', { owner: bullet.owner, value, previousBullet: bullet.text }, ancestor.revisionId);
        }
      }
    }
    for (const skill of skills(ancestor.payload)) {
      if (!currentSkills.has(normalized(skill))) add(lostSkills, 'lost-skill', { skill }, ancestor.revisionId);
    }
  }
  const sorted = (map) => [...map.values()].map((f) => ({ ...f, ancestorRevisionIds: f.ancestorRevisionIds.sort((a, b) => a - b) }))
    .sort((a, b) => a.findingId.localeCompare(b.findingId));
  return { omittedRoles: sorted(omittedRoles), removedBullets: sorted(removedBullets), removedScopeNumbers: sorted(removedScopeNumbers), lostSkills: sorted(lostSkills) };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function dateMonth(value, end) {
  const v = normalized(value);
  if (/^(present|current|now)$/.test(v)) return end ? Infinity : null;
  let match = /^(\d{4})-(\d{2})$/.exec(v);
  if (match) return Number(match[2]) >= 1 && Number(match[2]) <= 12 ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
  match = /^([a-z]+)\.?\s+(\d{4})$/.exec(v);
  if (match) {
    const month = MONTHS.indexOf(match[1].slice(0, 3));
    return month < 0 ? null : Number(match[2]) * 12 + month;
  }
  if (/^\d{4}$/.test(v)) return Number(v) * 12 + (end ? 11 : 0);
  return null;
}
function dateRange(value) {
  const parts = String(value).split(/\s+(?:-|to)\s+|\s*[–—]\s*/i);
  if (parts.length !== 2) return null;
  const start = dateMonth(parts[0], false), end = dateMonth(parts[1], true);
  return start === null || end === null || end < start ? null : { start, end };
}
function chronology(payload, ancestors) {
  const found = new Map();
  const versions = [{ revisionId: null, payload }, ...ancestors];
  for (const version of versions) {
    const ranges = [];
    const add = (item) => {
      if (!found.has(item.findingId)) found.set(item.findingId, { ...item, current: false, ancestorRevisionIds: [] });
      const existing = found.get(item.findingId);
      if (version.revisionId === null) existing.current = true;
      else if (!existing.ancestorRevisionIds.includes(version.revisionId)) existing.ancestorRevisionIds.push(version.revisionId);
    };
    for (const role of version.payload.experience || []) {
      const range = dateRange(role.dates);
      if (range) ranges.push(range);
      else add(finding('unparsed-role-dates', roleIdentity(role)));
    }
    ranges.sort((a, b) => a.start - b.start);
    let end = ranges[0]?.end;
    for (const range of ranges.slice(1)) {
      if (range.start - end > 6) add(finding('chronology-gap', { fromMonth: end, toMonth: range.start, months: range.start - end }));
      end = Math.max(end, range.end);
    }
  }
  return [...found.values()].map((f) => ({ ...f, ancestorRevisionIds: f.ancestorRevisionIds.sort((a, b) => a - b) }))
    .sort((a, b) => a.findingId.localeCompare(b.findingId));
}

/** Input sources and posting text must already be scoped and checked by the adapter. */
function buildResumeEditorialContext(input) {
  const clean = canonical(input);
  // Accept our own output to re-derive every computed field at a trust boundary.
  const allowed = ['schemaVersion', 'applicationId', 'revisionId', 'renderId', 'templateKey', 'authoredBy', 'sourceStateSha256',
    'payload', 'ancestors', 'sources', 'requirements', 'postingContext', 'contextSha256', 'factsDiff', 'chronologyGaps'];
  keys(clean, allowed, 'context');
  const context = {
    schemaVersion: EDITORIAL_CONTEXT_VERSION,
    applicationId: id(clean.applicationId, 'applicationId'), revisionId: id(clean.revisionId, 'revisionId'),
    renderId: id(clean.renderId, 'renderId'), templateKey: text(clean.templateKey, 'templateKey'),
    authoredBy: text(clean.authoredBy, 'authoredBy'), sourceStateSha256: sha(clean.sourceStateSha256, 'sourceStateSha256'),
    payload: object(clean.payload, 'payload'),
    ancestors: array(clean.ancestors, 'ancestors').map((ancestor) => {
      keys(ancestor, ['revisionId', 'payload'], 'ancestor');
      const revisionId = id(ancestor.revisionId, 'ancestor.revisionId');
      if (revisionId === clean.revisionId) fail('INVALID_INPUT', 'A revision cannot be its own ancestor');
      return { revisionId, payload: object(ancestor.payload, 'ancestor.payload') };
    }).sort((a, b) => a.revisionId - b.revisionId),
    sources: array(clean.sources, 'sources').map((source) => {
      object(source, 'source');
      return { ...source, id: text(String(source.id ?? ''), 'source.id'), kind: text(source.kind, 'source.kind'), sha256: sha(source.sha256, 'source.sha256') };
    }).sort((a, b) => a.id.localeCompare(b.id)),
    requirements: array(clean.requirements, 'requirements').map((requirement) => {
      keys(requirement, ['id', 'text', 'kind'], 'requirement');
      return { id: text(String(requirement.id ?? ''), 'requirement.id'), text: text(requirement.text, 'requirement.text'),
        ...(requirement.kind === undefined ? {} : { kind: text(requirement.kind, 'requirement.kind') }) };
    }).sort((a, b) => a.id.localeCompare(b.id)),
    postingContext: clean.postingContext || null
  };
  unique(context.ancestors, (a) => a.revisionId, 'ancestor revision');
  unique(context.sources, (s) => s.id, 'source id');
  unique(context.requirements, (r) => r.id, 'requirement id');
  context.factsDiff = factualDiff(context.payload, context.ancestors);
  context.chronologyGaps = chronology(context.payload, context.ancestors);
  context.contextSha256 = digest(context);
  if (clean.contextSha256 !== undefined && clean.contextSha256 !== context.contextSha256) {
    fail('EDITORIAL_CONTEXT_STALE', 'Context changed after its digest was computed');
  }
  return context;
}

function dispositionList(value, expected, label) {
  const entries = array(value, label).map((entry) => {
    keys(entry, ['findingId', 'disposition', 'reason'], `${label} entry`);
    return { findingId: text(entry.findingId, `${label}.findingId`), disposition: text(entry.disposition, `${label}.disposition`), reason: text(entry.reason, `${label}.reason`) };
  });
  unique(entries, (e) => e.findingId, `${label} finding`);
  const wanted = new Set(expected.map((e) => e.findingId));
  if (entries.length !== wanted.size || entries.some((e) => !wanted.has(e.findingId))) {
    fail('EDITORIAL_REVIEW_INCOMPLETE', `${label} must address every supplied finding exactly once`);
  }
  return entries.sort((a, b) => a.findingId.localeCompare(b.findingId));
}

function validateResumeEditorialReview(contextInput, reviewInput, reviewedBy) {
  const context = buildResumeEditorialContext(contextInput);
  const reviewer = text(reviewedBy, 'reviewedBy');
  if (normalized(reviewer) === normalized(context.authoredBy)) fail('EDITORIAL_SELF_REVIEW', 'The reviewer must differ from the revision author');
  const review = canonical(reviewInput);
  keys(review, ['schemaVersion', 'contextSha256', 'decision', 'notes', 'reviewerScope', 'matrix', 'omissions', 'chronology'], 'review');
  if (review.schemaVersion !== EDITORIAL_REVIEW_VERSION) fail('INVALID_INPUT', `schemaVersion must be ${EDITORIAL_REVIEW_VERSION}`);
  if (review.contextSha256 !== context.contextSha256) fail('EDITORIAL_CONTEXT_STALE', 'Review does not bind the current context');
  if (!['approved', 'changes_requested'].includes(review.decision)) fail('INVALID_INPUT', 'Editorial decision must be approved or changes_requested');
  if (!context.requirements.length) fail('EDITORIAL_REQUIREMENTS_MISSING', 'Posting requirements must be supplied before an editorial review');
  const sourceIds = new Set(context.sources.map((s) => s.id));
  const paths = new Set(resumeEditorialEvidencePaths(context.payload).map((b) => b.payloadPath));
  const matrix = array(review.matrix, 'matrix').map((entry) => {
    keys(entry, ['requirementId', 'status', 'evidence', 'rationale', 'stretchReason'], 'matrix entry');
    const requirementId = text(entry.requirementId, 'requirementId');
    if (!['demonstrated', 'partial', 'not-demonstrated'].includes(entry.status)) fail('INVALID_INPUT', 'Unsupported requirement status');
    const evidence = array(entry.evidence, 'evidence').map((e) => {
      keys(e, ['sourceId', 'payloadPath'], 'evidence entry');
      const sourceId = text(e.sourceId, 'sourceId'), payloadPath = text(e.payloadPath, 'payloadPath');
      if (!sourceIds.has(sourceId)) fail('EDITORIAL_EVIDENCE_INVALID', 'Evidence must cite a selected source');
      if (!paths.has(payloadPath)) fail('EDITORIAL_EVIDENCE_INVALID', 'Evidence must cite existing current professional payload text');
      return { sourceId, payloadPath };
    });
    unique(evidence, (e) => `${e.sourceId}\u0000${e.payloadPath}`, 'evidence binding');
    if (entry.status === 'demonstrated' && !evidence.length) fail('EDITORIAL_EVIDENCE_REQUIRED', 'Demonstrated requirements need source and bullet evidence');
    if (entry.status === 'not-demonstrated' && evidence.length) fail('EDITORIAL_EVIDENCE_INVALID', 'Not-demonstrated requirements cannot claim supporting evidence');
    if (entry.stretchReason !== undefined && typeof entry.stretchReason !== 'string') fail('INVALID_INPUT', 'stretchReason must be text');
    const stretchReason = entry.stretchReason?.trim() || '';
    if (entry.status !== 'demonstrated' && !stretchReason) fail('EDITORIAL_STRETCH_REASON_REQUIRED', 'Every partial or not-demonstrated requirement needs explicit stretch acceptance');
    return { requirementId, status: entry.status, evidence: evidence.sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
      rationale: text(entry.rationale, 'rationale'), stretchReason };
  });
  unique(matrix, (e) => e.requirementId, 'matrix requirement');
  const requirements = new Set(context.requirements.map((r) => r.id));
  if (matrix.length !== requirements.size || matrix.some((e) => !requirements.has(e.requirementId))) {
    fail('EDITORIAL_REVIEW_INCOMPLETE', 'Matrix must cover every supplied posting requirement exactly once');
  }
  return {
    schemaVersion: EDITORIAL_REVIEW_VERSION, contextSha256: context.contextSha256, decision: review.decision,
    ...(review.notes === undefined ? {} : { notes: text(review.notes, 'notes') }),
    ...(review.reviewerScope === undefined ? {} : { reviewerScope: text(review.reviewerScope, 'reviewerScope') }),
    matrix: matrix.sort((a, b) => a.requirementId.localeCompare(b.requirementId)),
    omissions: dispositionList(review.omissions, Object.values(context.factsDiff).flat(), 'omissions'),
    chronology: dispositionList(review.chronology, context.chronologyGaps, 'chronology')
  };
}

function migrateResumeEditorialReviews(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE,
      application_id INTEGER NOT NULL REFERENCES applications(id),
      revision_id INTEGER NOT NULL REFERENCES application_material_revisions(id),
      render_id INTEGER NOT NULL REFERENCES application_material_renders(id),
      review_version TEXT NOT NULL, source_state_sha256 TEXT NOT NULL CHECK(length(source_state_sha256)=64),
      context_sha256 TEXT NOT NULL CHECK(length(context_sha256)=64),
      review_json TEXT NOT NULL, reviewed_by TEXT NOT NULL, reviewed_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, intent_sha256 TEXT NOT NULL CHECK(length(intent_sha256)=64)
    );
    CREATE INDEX IF NOT EXISTS idx_resume_editorial_render ON ${TABLE}(render_id,id);
    CREATE TRIGGER IF NOT EXISTS trg_resume_editorial_immutable_update BEFORE UPDATE ON ${TABLE}
      BEGIN SELECT RAISE(ABORT,'resume editorial reviews are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_resume_editorial_immutable_delete BEFORE DELETE ON ${TABLE}
      BEGIN SELECT RAISE(ABORT,'resume editorial reviews are append-only'); END;
  `);
}
function hasTable(db) { return Boolean(db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', TABLE)); }

/** Only the normal CLI writer calls this; migration is explicit, never part of a read. */
function recordResumeEditorialReview(db, input) {
  const context = buildResumeEditorialContext(input.context);
  const reviewedBy = text(input.reviewedBy, 'reviewedBy');
  const idempotencyKey = text(input.idempotencyKey, 'idempotencyKey');
  const review = validateResumeEditorialReview(context, input.review, reviewedBy);
  const intentSha256 = digest({ contextSha256: context.contextSha256, reviewedBy, review });
  if (!hasTable(db)) fail('EDITORIAL_SCHEMA_REQUIRED', 'Editorial review schema has not been migrated');
  return db.transaction(() => {
    const prior = db.prepare(`SELECT * FROM ${TABLE} WHERE idempotency_key=?`).get(idempotencyKey);
    if (prior) {
      if (prior.intent_sha256 !== intentSha256) fail('IDEMPOTENCY_CONFLICT', 'Idempotency key already binds a different editorial review');
      return { review: prior, replayed: true };
    }
    const result = db.prepare(`INSERT INTO ${TABLE}
      (uuid,application_id,revision_id,render_id,review_version,source_state_sha256,context_sha256,
       review_json,reviewed_by,reviewed_at,idempotency_key,intent_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(crypto.randomUUID(), context.applicationId, context.revisionId, context.renderId,
        EDITORIAL_REVIEW_VERSION, context.sourceStateSha256, context.contextSha256,
        stableJson(review), reviewedBy, new Date().toISOString(), idempotencyKey, intentSha256);
    return { review: db.prepare(`SELECT * FROM ${TABLE} WHERE id=?`).get(Number(result.lastInsertRowid)), replayed: false };
  })();
}

/** Existing v1/v2 submitted artifacts keep their original gates. Read-only. */
function getResumeEditorialReadiness(db, contextInput) {
  if (!isCompactResumeTemplate(contextInput.templateKey)) return { required: false, ready: true, blockerCodes: [], reviewId: null };
  const context = buildResumeEditorialContext(contextInput);
  const required = { required: true, ready: false, contextSha256: context.contextSha256, reviewId: null };
  if (!context.requirements.length) return { ...required, blockerCodes: ['EDITORIAL_REQUIREMENTS_MISSING'] };
  const row = hasTable(db) ? db.prepare(`SELECT * FROM ${TABLE} WHERE application_id=? AND revision_id=? AND render_id=? ORDER BY id DESC LIMIT 1`)
    .get(context.applicationId, context.revisionId, context.renderId) : null;
  if (!row) return { ...required, blockerCodes: ['RESUME_EDITORIAL_REVIEW_REQUIRED'] };
  if (row.review_version !== EDITORIAL_REVIEW_VERSION || row.context_sha256 !== context.contextSha256
    || row.source_state_sha256 !== context.sourceStateSha256) {
    return { ...required, blockerCodes: ['RESUME_EDITORIAL_REVIEW_STALE'], reviewId: row.id };
  }
  try {
    const review = validateResumeEditorialReview(context, JSON.parse(row.review_json), row.reviewed_by);
    if (digest({ contextSha256: context.contextSha256, reviewedBy: row.reviewed_by, review }) !== row.intent_sha256) throw new Error('Review digest mismatch');
    if (review.decision !== 'approved') return { ...required, blockerCodes: ['RESUME_EDITORIAL_CHANGES_REQUESTED'], reviewId: row.id };
  } catch {
    return { ...required, blockerCodes: ['RESUME_EDITORIAL_REVIEW_INVALID'], reviewId: row.id };
  }
  return { ...required, ready: true, blockerCodes: [], reviewId: row.id, reviewedBy: row.reviewed_by };
}

module.exports = {
  EDITORIAL_REVIEW_VERSION, EDITORIAL_CONTEXT_VERSION, ResumeEditorialReviewError,
  buildResumeEditorialContext, validateResumeEditorialReview, migrateResumeEditorialReviews,
  recordResumeEditorialReview, getResumeEditorialReadiness, resumeEditorialEvidencePaths
};
