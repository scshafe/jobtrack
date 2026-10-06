'use strict';

// resume-lint.js — the deterministic quality gate for rendered materials.
//
// WHY THIS EXISTS
// ---------------
// docs/RESUME_QUALITY_PLAN.md §3.1 named the principle: we hold the rendered
// bytes AND their extracted text, so published resume advice that is normally
// unverifiable is checkable here — and what is checkable should be a gate,
// not a guideline. `resume.standard.v2` was validated by a one-time manual
// extraction probe (plan §3.4); this module is what makes those properties
// CONTINUOUSLY true instead of true once.
//
// Binding point (plan §3.2): findings bind where renders bind. Approving a
// LaTeX revision requires a passing lint report for the exact render being
// pinned, in the MATERIAL_RENDER_REQUIRED idiom, and readiness surfaces a
// missing/failed report as a blocker. Reports are append-only observations
// like upload verifications; a linter upgrade (LINT_VERSION change) makes old
// passes stale rather than silently inheriting them.
//
// Finding classes (plan §3.2):
//   * mechanical — extraction, safety, byte-adjacent facts: severity `error`,
//     non-waivable. A failing mechanical finding fails the report.
//   * editorial — prose and density bands: severity `warn`, recorded but never
//     failing. The §3.2 waiver ceremony arrives with real payload calibration.
//   * decision — timeline gaps. The plan wants these to block until a recorded
//     human decision; the decision ledger does not exist yet, so v1 records
//     them as warnings and says so. Do not silently promote or drop them.
//
// V3-template reports additionally bind pinned-container raw/layout order,
// actual point-size and page-space measurements to the exact PDF bytes.
// Historical v1/v2-template reports retain their original mechanical contract.
//
// Freeform-LaTeX revisions have no addressable payload, so they receive the
// reduced check set (page policy, size, safety, letter/company cross-checks)
// plus an explicit warning that extraction-parity checks were unavailable —
// consistent with the plan excluding freeform from the unattended path.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { countWordLikeTokens, createPdfMetricsInspector, PDF_METRICS_VERSION, RENDERER_IMAGE_DIGEST } = require('./latex-renderer');
const { isCompactResumeTemplate, contactVisibleLabel } = require('./material-templates');

const LINT_VERSION = 'jobtrack-resume-lint.v2';
const LEGACY_LINT_VERSION = 'jobtrack-resume-lint.v1';
const LEGACY_TEMPLATE_KEYS = new Set([null, 'resume.standard.v1', 'resume.standard.v2', 'cover-letter.standard.v1', 'cover-letter.standard.v2']);
const FINDING_CLASSES = Object.freeze(['mechanical', 'editorial', 'decision']);
const VERDICTS = Object.freeze(['pass', 'fail']);
const MAX_OUTPUT_BYTES_POLICY = Math.floor(2.5 * 1024 * 1024); // plan §3.1: file size < 2.5 MB
const MIN_EXTRACTED_CHARS = 300; // near-empty extraction is the drill/ATS failure shape

// Density bands. CALIBRATED AGAINST A REAL RENDER (re-drill, 2026-08-19): a
// 3,339-character payload — 13 bullets averaging ~27 words, summary, four
// skill groups, one project, education — rendered TWO pages. Geometry math
// (95 chars/line × ~50 lines) over-promised because bullets wrap at ~2 lines
// each and every role adds header + meta furniture. Bands warn in both
// directions; the one measured under-filled v2 render was 2,478 chars.
const RESUME_DENSITY = Object.freeze({
  charFloor: 2200,
  // Calibrated by real renders, twice: 3,339 chars rendered 2 pages
  // (2026-08-19), and a generated 3-role/11-bullet payload at 3,052 chars
  // ALSO rendered 2 pages (2026-08-21, drill d-honest-1) — structure (roles,
  // groups, summary) spends page height beyond raw characters. 2,800 leaves
  // margin for generated shapes; the floor is unchanged.
  charCeiling: 2800,
  charHardCeiling: 4200, // certain overflow: error at draft time, before a render
  maxRoles: 5,
  maxBulletsPerRole: 6,
  maxTotalBullets: 13,
  minTotalBullets: 6,
  maxBulletWords: 32, // two rendered lines ≈ 190 chars ≈ 30–32 words
  maxSummaryChars: 500,
  maxSkillGroups: 6
});
// A versioned editorial prototype, not an ATS requirement. Real render geometry
// decides whether content fits; never meet this target with invented evidence.
const RESUME_V3_DENSITY = Object.freeze({
  ...RESUME_DENSITY,
  charFloor: 3000, charCeiling: 4200, charHardCeiling: null,
  maxRoles: 6, maxTotalBullets: 15,
  renderedWordFloor: 420, renderedWordCeiling: 470,
  nominalBottomMarginPt: 45.36,
  minimumBodyFontPt: 10.4,
  calibration: 'editorial-prototype-2026-09-09'
});
const LETTER_DENSITY = Object.freeze({
  bodyCharFloor: 500,
  bodyCharCeiling: 2400,
  maxParagraphs: 5
});

// Plan §3.1 banned-phrase list, verbatim.
const BANNED_PHRASES = Object.freeze([
  'responsible for', 'worked on', 'involved in', 'tasked with', 'duties included',
  'utilized', 'references available upon request', 'passionate', 'results-driven'
]);

// Stored safety values below this length (or in this set) cannot be matched
// without flooding false positives; the structural SSN pattern still applies.
const UNMATCHABLE_SAFETY_VALUES = new Set(['no', 'yes', 'n/a', 'none', 'declined', 'prefer not to say']);

class MaterialLintError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'MaterialLintError';
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
  if (!Number.isInteger(parsed) || parsed <= 0) throw new MaterialLintError('INVALID_INPUT', `${label} must be a positive integer`);
  return parsed;
}

function requiredText(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim()) throw new MaterialLintError('INVALID_INPUT', `${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new MaterialLintError('INVALID_INPUT', `${label} exceeds ${max} characters`);
  return trimmed;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function ensureMaterialLintSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS application_material_lint_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      material_kind_id INTEGER NOT NULL REFERENCES application_material_kinds(id) ON DELETE RESTRICT,
      revision_id INTEGER NOT NULL REFERENCES application_material_revisions(id) ON DELETE RESTRICT,
      render_id INTEGER NOT NULL REFERENCES application_material_renders(id) ON DELETE RESTRICT,
      lint_version TEXT NOT NULL CHECK (trim(lint_version)<>''),
      verdict TEXT NOT NULL CHECK (verdict IN ('pass','fail')),
      error_count INTEGER NOT NULL CHECK (error_count>=0),
      warn_count INTEGER NOT NULL CHECK (warn_count>=0),
      findings_json TEXT NOT NULL CHECK (json_valid(findings_json)),
      extracted_text_sha256 TEXT NOT NULL CHECK (length(extracted_text_sha256)=64),
      linted_by TEXT NOT NULL CHECK (trim(linted_by)<>''),
      linted_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_material_lint_render
      ON application_material_lint_reports(render_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_material_lint_application
      ON application_material_lint_reports(application_id, id);
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(application_material_lint_reports)').all().map((row) => row.name));
  if (!columns.has('pdf_metrics_json')) db.exec('ALTER TABLE application_material_lint_reports ADD COLUMN pdf_metrics_json TEXT CHECK (pdf_metrics_json IS NULL OR json_valid(pdf_metrics_json))');
  if (!columns.has('pdf_metrics_sha256')) db.exec('ALTER TABLE application_material_lint_reports ADD COLUMN pdf_metrics_sha256 TEXT CHECK (pdf_metrics_sha256 IS NULL OR length(pdf_metrics_sha256)=64)');
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_material_lint_immutable_update
      BEFORE UPDATE ON application_material_lint_reports
      BEGIN SELECT RAISE(ABORT,'application_material_lint_reports is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_material_lint_immutable_delete
      BEFORE DELETE ON application_material_lint_reports
      BEGIN SELECT RAISE(ABORT,'application_material_lint_reports is immutable'); END;
  `);
  // A report must point at a render of the revision it claims, for the
  // application and kind it claims — same scope discipline as verifications.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_material_lint_scope
      BEFORE INSERT ON application_material_lint_reports
      WHEN NOT EXISTS (
        SELECT 1
        FROM application_material_renders r
        JOIN application_material_revisions v ON v.id=r.revision_id
        JOIN application_materials m ON m.id=v.material_id
        WHERE r.id=NEW.render_id
          AND r.revision_id=NEW.revision_id
          AND m.application_id=NEW.application_id
          AND m.material_kind_id=NEW.material_kind_id
          AND r.extracted_text_sha256=NEW.extracted_text_sha256
      )
      BEGIN SELECT RAISE(ABORT,'lint report render, revision, kind, application and text digest must agree'); END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_material_lint_metrics_scope
      BEFORE INSERT ON application_material_lint_reports
      WHEN (NEW.pdf_metrics_json IS NULL) != (NEW.pdf_metrics_sha256 IS NULL)
        OR (NEW.pdf_metrics_json IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM application_material_renders r WHERE r.id=NEW.render_id
            AND json_extract(NEW.pdf_metrics_json,'$.schemaVersion')='jobtrack-pdf-metrics.v1'
            AND json_extract(NEW.pdf_metrics_json,'$.outputSha256')=r.output_sha256
            AND json_extract(NEW.pdf_metrics_json,'$.extractedTextSha256')=r.extracted_text_sha256
            AND json_extract(NEW.pdf_metrics_json,'$.pageCount')=r.page_count
            AND json_extract(NEW.pdf_metrics_json,'$.outputBytes')=r.output_bytes
        ))
      BEGIN SELECT RAISE(ABORT,'lint metrics must bind the exact PDF render and extraction'); END;
  `);
}

// ---------------------------------------------------------------- helpers ----

/** Canonicalize typography the PDF pipeline introduces so payload text and
 * extracted text compare in the same alphabet. Measured on a real render
 * (re-drill 2026-08-19): LaTeX sets ASCII `'` as U+2019, so a possessive like `Initech's`
 * failed containment against its own payload. Ligatures, curly quotes,
 * non-breaking spaces, and the form feed pdftotext emits at page breaks all
 * belong to the same class. Idempotent on plain ASCII. */
function canonicalizeExtractionText(value) {
  return String(value)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ﬀ/g, 'ff')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi')
    .replace(/ﬄ/g, 'ffl')
    .replace(/ /g, ' ')
    .replace(/\f/g, '\n');
}

function normalizeWhitespace(value) {
  return canonicalizeExtractionText(value).replace(/\s+/g, ' ').trim();
}

function textLines(extractedText) {
  return canonicalizeExtractionText(extractedText).split('\n');
}

/** Tokenize for containment comparisons. Hyphens split on BOTH sides, so a
 * payload's `content-addressed` and an extraction's re-joined or split form
 * compare identically. Interior punctuation survives (example.test, node.js);
 * edge punctuation is trimmed so `persistence.` and `persistence` compare
 * as the same token. */
function tokenize(value) {
  return canonicalizeExtractionText(value)
    .toLowerCase()
    .split(/[^a-z0-9@+#./]+/)
    .map((token) => token.replace(/^[.#+@/]+|[.#+@/]+$/g, ''))
    .filter((token) => token.length >= 3);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordBoundedMatch(haystack, needle) {
  if (!needle) return false;
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(haystack);
}

function finding(code, cls, severity, message, evidence = undefined) {
  const record = { code, class: cls, severity, message };
  if (evidence !== undefined) record.evidence = String(evidence).slice(0, 400);
  return record;
}

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};

function parseMonthYear(value) {
  const match = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(String(value).trim());
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (month === undefined) return null;
  return Number(match[2]) * 12 + month;
}

function parseDateRange(value) {
  const parts = String(value).split(/\s*[-–—]\s*|\s+to\s+/i).map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  const start = parseMonthYear(parts[0]);
  const end = /^(present|current|now)$/i.test(parts[1]) ? Infinity : parseMonthYear(parts[1]);
  if (start === null || end === null) return null;
  return { start, end };
}

// -------------------------------------------------- payload density bands ----

/**
 * Draft-time density bands over a template payload (plan L6). Pure; no store.
 * These are editorial warnings except the hard character ceiling, which is a
 * certain page overflow and therefore an error worth stopping before a render.
 */
function lintTemplatePayload(templateKey, kind, payload) {
  const findings = [];
  const density = isCompactResumeTemplate(templateKey) ? RESUME_V3_DENSITY : RESUME_DENSITY;
  if (!payload || typeof payload !== 'object') return findings;
  if (kind === 'resume' && String(templateKey || '').startsWith('resume.')) {
    const experience = Array.isArray(payload.experience) ? payload.experience : [];
    const bullets = [];
    for (const [index, entry] of experience.entries()) {
      const entryBullets = Array.isArray(entry?.bullets) ? entry.bullets : [];
      bullets.push(...entryBullets.map((text, bulletIndex) => ({ text: String(text), path: `experience[${index}].bullets[${bulletIndex}]` })));
      if (entryBullets.length > density.maxBulletsPerRole) {
        findings.push(finding('DENSITY_BULLETS_PER_ROLE', 'editorial', 'warn',
          `experience[${index}] carries ${entryBullets.length} bullets; the per-role band tops out near ${density.maxBulletsPerRole}. Preserve the strongest supported evidence.`));
      }
    }
    for (const [index, entry] of (Array.isArray(payload.projects) ? payload.projects : []).entries()) {
      const entryBullets = Array.isArray(entry?.bullets) ? entry.bullets : [];
      bullets.push(...entryBullets.map((text, bulletIndex) => ({ text: String(text), path: `projects[${index}].bullets[${bulletIndex}]` })));
    }
    if (experience.length > density.maxRoles) {
      findings.push(finding('DENSITY_TOO_MANY_ROLES', 'editorial', 'warn',
        `${experience.length} experience entries exceed the ${density.maxRoles}-role prototype band. Review relevance and chronology before removing history; never shrink type.`));
    }
    if (bullets.length > density.maxTotalBullets) {
      findings.push(finding('DENSITY_TOO_MANY_BULLETS', 'editorial', 'warn',
        `${bullets.length} bullets total; the one-page band is roughly ${density.minTotalBullets}–${density.maxTotalBullets}.`));
    } else if (bullets.length > 0 && bullets.length < density.minTotalBullets) {
      findings.push(finding('DENSITY_TOO_FEW_BULLETS', 'editorial', 'warn',
        `${bullets.length} bullets total reads under-filled for a full page; the band is roughly ${density.minTotalBullets}–${density.maxTotalBullets}.`));
    }
    for (const bullet of bullets) {
      const words = isCompactResumeTemplate(templateKey) ? countWordLikeTokens(bullet.text) : bullet.text.trim().split(/\s+/).filter(Boolean).length;
      if (words > density.maxBulletWords) {
        findings.push(finding('DENSITY_BULLET_TOO_LONG', 'editorial', 'warn',
          `${bullet.path} runs ${words} words; review actual wrapping past ~${density.maxBulletWords} words.`, bullet.text));
      }
    }
    const leadCounts = new Map();
    for (const bullet of bullets) {
      const lead = (bullet.text.trim().split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z]/g, '');
      if (!lead) continue;
      leadCounts.set(lead, (leadCounts.get(lead) || 0) + 1);
    }
    for (const [lead, count] of leadCounts) {
      if (count >= 3) {
        findings.push(finding('PROSE_LEAD_VERB_REPEATED', 'editorial', 'warn',
          `${count} bullets open with “${lead}”; vary lead verbs so accomplishments read as distinct.`));
      }
    }
    if (typeof payload.summary === 'string' && payload.summary.length > density.maxSummaryChars) {
      findings.push(finding('DENSITY_SUMMARY_TOO_LONG', 'editorial', 'warn',
        `Summary is ${payload.summary.length} characters; past ~${density.maxSummaryChars} it crowds out evidence bullets.`));
    }
    const skillGroups = Array.isArray(payload.skills) ? payload.skills.length : 0;
    if (skillGroups > density.maxSkillGroups) {
      findings.push(finding('DENSITY_TOO_MANY_SKILL_GROUPS', 'editorial', 'warn',
        `${skillGroups} skill groups each take a full line; ${density.maxSkillGroups} is the practical one-page ceiling.`));
    }
    const contentChars = payloadContentChars(payload);
    if (Number.isFinite(density.charHardCeiling) && contentChars > density.charHardCeiling) {
      findings.push(finding('DENSITY_CERTAIN_OVERFLOW', 'mechanical', 'error',
        `Payload carries ~${contentChars} content characters; one v2 page holds roughly ${density.charCeiling}. Apply the cut order before rendering.`));
    } else if (contentChars > density.charCeiling) {
      findings.push(finding('DENSITY_OVERFLOW_RISK', 'editorial', 'warn',
        `~${contentChars} content characters risks a second page (band ${density.charFloor}–${density.charCeiling}${isCompactResumeTemplate(templateKey) ? ', provisional; verify rendered words and geometry' : ''}).`));
    } else if (contentChars > 0 && contentChars < density.charFloor) {
      findings.push(finding('DENSITY_UNDERFILLED', 'editorial', 'warn',
        `~${contentChars} content characters is below the ${density.charFloor}–${density.charCeiling} band; review evidence coverage and actual rendered density, never pad unsupported claims.`));
    }
  }
  if (kind === 'cover-letter' && Array.isArray(payload.paragraphs)) {
    const bodyChars = payload.paragraphs.reduce((sum, paragraph) => sum + String(paragraph).length, 0);
    if (payload.paragraphs.length > LETTER_DENSITY.maxParagraphs) {
      findings.push(finding('DENSITY_TOO_MANY_PARAGRAPHS', 'editorial', 'warn',
        `${payload.paragraphs.length} paragraphs; a one-page letter reads best at 3–${LETTER_DENSITY.maxParagraphs}.`));
    }
    if (bodyChars > LETTER_DENSITY.bodyCharCeiling) {
      findings.push(finding('DENSITY_LETTER_TOO_LONG', 'editorial', 'warn',
        `Letter body is ~${bodyChars} characters; past ~${LETTER_DENSITY.bodyCharCeiling} it will not sit on one page.`));
    } else if (bodyChars > 0 && bodyChars < LETTER_DENSITY.bodyCharFloor) {
      findings.push(finding('DENSITY_LETTER_TOO_SHORT', 'editorial', 'warn',
        `Letter body is ~${bodyChars} characters; under ~${LETTER_DENSITY.bodyCharFloor} it reads perfunctory.`));
    }
  }
  return findings;
}

function payloadContentChars(payload) {
  let total = 0;
  const visit = (value) => {
    if (typeof value === 'string') total += value.length;
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(payload);
  return total;
}

// ------------------------------------------------------- payload geometry ----

function collectPayloadBullets(templateKey, payload) {
  const bullets = [];
  const push = (list, prefix) => {
    if (!Array.isArray(list)) return;
    list.forEach((text, index) => bullets.push({ text: String(text), path: `${prefix}[${index}]` }));
  };
  (Array.isArray(payload.experience) ? payload.experience : []).forEach((entry, index) => {
    push(entry?.bullets, `experience[${index}].bullets`);
  });
  (Array.isArray(payload.projects) ? payload.projects : []).forEach((entry, index) => {
    push(entry?.bullets, `projects[${index}].bullets`);
  });
  (Array.isArray(payload.education) ? payload.education : []).forEach((entry, index) => {
    // The compact template prints education notes inline after the degree
    // line, with no glyph; they are checked as inline text, not as bullets.
    if (isCompactResumeTemplate(templateKey)) return;
    push(entry?.notes, `education[${index}].notes`);
  });
  return bullets;
}

/** The visible text of a v4 template-generated header: the location and the
 * address a reader sees for each link (never the URL itself). */
function visibleContactFields(contact) {
  if (!contact || typeof contact !== 'object' || Array.isArray(contact)) return {};
  const fields = {};
  if (typeof contact.location === 'string' && contact.location.trim()) fields.location = contact.location;
  for (const key of ['email', 'github', 'linkedin']) {
    if (typeof contact[key] === 'string' && contact[key].trim()) fields[key] = contactVisibleLabel(contact[key]);
  }
  return fields;
}

/** Payload strings the compact template renders inline (no bullet glyph). */
function collectInlineNotes(templateKey, payload) {
  if (!isCompactResumeTemplate(templateKey)) return [];
  const notes = [];
  (Array.isArray(payload.education) ? payload.education : []).forEach((entry, index) => {
    (Array.isArray(entry?.notes) ? entry.notes : []).forEach((text, noteIndex) => notes.push({ text: String(text), path: `education[${index}].notes[${noteIndex}]` }));
  });
  return notes;
}

/** Bullet blocks exactly as the layout extraction rendered them: a line that
 * opens with the glyph starts a block and indented lines continue it. The
 * block's rendered line count and its last line's word count are what the
 * two-line discipline measures (a third line, or a one-word last line, is
 * what every 2026-09-09 review found first). */
function extractedBulletBlocks(extractedText) {
  const blocks = [];
  let current = null;
  for (const line of canonicalizeExtractionText(extractedText).split('\n')) {
    if (/^\s*•/.test(line)) { current = { lines: [line.replace(/^\s*•\s*/, '')] }; blocks.push(current); continue; }
    if (current && /^\s+\S/.test(line)) { current.lines.push(line.trim()); continue; }
    current = null;
  }
  return blocks.map((block) => ({
    text: normalizeWhitespace(block.lines.join(' ')),
    lineCount: block.lines.length,
    lastLineWords: countWordLikeTokens(block.lines.at(-1))
  }));
}

function expectedResumeHeadings(templateKey, payload) {
  if (isCompactResumeTemplate(templateKey)) {
    return [payload.summary ? 'Summary' : null, 'Experience',
      payload.projects?.length ? 'Projects' : null,
      payload.skills?.length ? 'Technical Skills' : null,
      payload.education?.length ? 'Education' : null].filter(Boolean);
  }
  if (templateKey === 'resume.standard.v2') {
    const headings = [];
    if (payload.summary) headings.push('Summary');
    if (Array.isArray(payload.skills) && payload.skills.length) headings.push('Technical Skills');
    headings.push('Experience');
    if (Array.isArray(payload.projects) && payload.projects.length) headings.push('Projects');
    if (Array.isArray(payload.education) && payload.education.length) headings.push('Education');
    return headings;
  }
  if (templateKey === 'resume.standard.v1') {
    const headings = [];
    if (payload.summary) headings.push('Summary');
    headings.push('Experience');
    if (Array.isArray(payload.education) && payload.education.length) headings.push('Education');
    if (Array.isArray(payload.skills) && payload.skills.length) headings.push('Skills');
    return headings;
  }
  return null;
}

function payloadStrings(payload) {
  const strings = [];
  const visit = (value) => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(payload);
  return strings;
}

function validatePdfMetrics(metrics, expected = {}) {
  const keys = ['schemaVersion', 'outputSha256', 'outputBytes', 'inspectionImageDigest', 'extractedTextSha256', 'rawTextSha256', 'wordLikeTokens', 'whitespaceTokens', 'renderedTextLines', 'pageCount', 'pages', 'fontSizeOperatorsPt', 'textFontSizes', 'bodyFontSizePt', 'fontMeasurementSupported', 'layoutAndRawTokenOrderEqual', 'wordCountingMethod', 'fontMeasurementMethod', 'whitespaceMeasurementMethod'];
  const exact = (object, names) => object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).length === names.length && names.every((name) => Object.hasOwn(object, name));
  const number = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
  const integer = (value, min, max) => Number.isSafeInteger(value) && number(value, min, max);
  const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  let valid = exact(metrics, keys) && metrics.schemaVersion === PDF_METRICS_VERSION
    && metrics.inspectionImageDigest === RENDERER_IMAGE_DIGEST
    && ['outputSha256', 'extractedTextSha256', 'rawTextSha256'].every((key) => hash(metrics[key]))
    && integer(metrics.outputBytes, 1, 16 * 1024 * 1024)
    && integer(metrics.pageCount, 1, 20)
    && ['wordLikeTokens', 'whitespaceTokens', 'renderedTextLines'].every((key) => integer(metrics[key], 1, 1000000))
    && metrics.wordLikeTokens <= metrics.whitespaceTokens
    && metrics.wordCountingMethod === 'unicode-letter-or-digit-whitespace-tokens.v1'
    && metrics.fontMeasurementMethod === 'page-content-text-show-glyph-byte-weighted-transformed-point-size.v1'
    && metrics.whitespaceMeasurementMethod === 'page-edge-minus-last-word-bbox-minus-explicit-nominal-margin.v1'
    && typeof metrics.fontMeasurementSupported === 'boolean'
    && typeof metrics.layoutAndRawTokenOrderEqual === 'boolean'
    && (metrics.bodyFontSizePt === null || number(metrics.bodyFontSizePt, 0.1, 300))
    && Array.isArray(metrics.pages) && metrics.pages.length === metrics.pageCount
    && metrics.pages.every((page, index) => exact(page, ['pageNumber', 'widthPt', 'heightPt', 'firstTextYPt', 'lastTextYPt', 'blankBelowTextPt', 'nominalBottomMarginPt', 'usableBottomWhitespacePt', 'textOutsidePage'])
      && page.pageNumber === index + 1 && number(page.widthPt, 1, 2000) && number(page.heightPt, 1, 2000)
      && number(page.firstTextYPt, -2000, 2000) && number(page.lastTextYPt, page.firstTextYPt, 2000)
      && ['blankBelowTextPt', 'usableBottomWhitespacePt'].every((key) => number(page[key], 0, 2000))
      && number(page.nominalBottomMarginPt, 0, 144) && typeof page.textOutsidePage === 'boolean')
    && Array.isArray(metrics.fontSizeOperatorsPt) && metrics.fontSizeOperatorsPt.length <= 100
    && metrics.fontSizeOperatorsPt.every((size) => number(size, 0.1, 300))
    && Array.isArray(metrics.textFontSizes) && metrics.textFontSizes.length <= 100
    && metrics.textFontSizes.every((font) => exact(font, ['sizePt', 'glyphByteWeight']) && number(font.sizePt, 0.1, 300) && integer(font.glyphByteWeight, 1, 8 * 1024 * 1024));
  if (valid) for (const key of ['outputSha256', 'extractedTextSha256', 'outputBytes', 'pageCount']) {
    if (expected[key] !== undefined && metrics[key] !== expected[key]) valid = false;
  }
  if (!valid) throw new MaterialLintError('PDF_METRICS_INVALID', 'PDF measurements are invalid or do not bind the exact render bytes and extraction');
  return metrics;
}

// ------------------------------------------------------------- pure lints ----

/**
 * Lint one rendered material from its stored facts. Pure: every store-derived
 * input is passed in, so the same function serves the CLI, the review gate's
 * tests, and future callers without a database.
 */
function lintRenderedMaterial(input) {
  const materialKind = input.materialKind;
  if (!['resume', 'cover-letter'].includes(materialKind)) {
    throw new MaterialLintError('INVALID_INPUT', 'Only resume and cover-letter renders can be linted');
  }
  const extractedText = canonicalizeExtractionText(String(input.extractedText ?? ''));
  const findings = [];
  const templateKey = input.templateKey || null;
  const payload = templateKey && input.templatePayload && typeof input.templatePayload === 'object'
    ? input.templatePayload
    : null;
  const density = isCompactResumeTemplate(templateKey) ? RESUME_V3_DENSITY : RESUME_DENSITY;
  let pdfMetrics = null;
  if (input.pdfMetrics !== undefined && input.pdfMetrics !== null) {
    try {
      pdfMetrics = validatePdfMetrics(input.pdfMetrics, {
        outputSha256: input.outputSha256,
        extractedTextSha256: sha256(String(input.extractedText ?? '')),
        outputBytes: Number(input.outputBytes), pageCount: Number(input.pageCount)
      });
      if (isCompactResumeTemplate(templateKey) && !/^[a-f0-9]{64}$/.test(input.outputSha256 || '')) pdfMetrics = null;
    } catch { pdfMetrics = null; }
    if (!pdfMetrics) findings.push(finding('PDF_METRICS_INVALID', 'mechanical', 'error', 'PDF measurements must bind the exact render bytes, page count and text extraction.'));
  } else if (isCompactResumeTemplate(templateKey)) {
    findings.push(finding('PDF_METRICS_REQUIRED', 'mechanical', 'error', 'The compact template requires fresh byte-bound PDF measurements from the pinned inspector.'));
  }
  if (pdfMetrics) {
    if (!pdfMetrics.layoutAndRawTokenOrderEqual) findings.push(finding('TEXT_ORDER_DIVERGENCE', 'mechanical', 'error', 'Raw-order and layout-order extraction disagree; inspect reading order before approval.'));
    if (pdfMetrics.pages.some((page) => page.textOutsidePage)) findings.push(finding('TEXT_OUTSIDE_PAGE', 'mechanical', 'error', 'Text bounding boxes extend outside the PDF page.'));
    if (isCompactResumeTemplate(templateKey)) {
      if (!pdfMetrics.fontMeasurementSupported || pdfMetrics.bodyFontSizePt === null) findings.push(finding('BODY_FONT_UNVERIFIED', 'mechanical', 'error', 'The rendered body font could not be established by the supported page-content measurement.'));
      else if (pdfMetrics.bodyFontSizePt < density.minimumBodyFontPt) findings.push(finding('BODY_FONT_TOO_SMALL', 'mechanical', 'error', 'The compact resume body is smaller than the fixed 10.5 TeX-point template policy.'));
      if (pdfMetrics.wordLikeTokens < density.renderedWordFloor || pdfMetrics.wordLikeTokens > density.renderedWordCeiling) findings.push(finding('RENDERED_WORD_DENSITY_REVIEW', 'editorial', 'warn', `${pdfMetrics.wordLikeTokens} rendered word-like tokens is outside the ${density.renderedWordFloor}–${density.renderedWordCeiling} editorial prototype. Prefer verified career history and engineering context; never pad to a quota.`));
      if (pdfMetrics.pages.some((page) => page.nominalBottomMarginPt !== density.nominalBottomMarginPt)) findings.push(finding('PDF_MARGIN_METRICS_INVALID', 'mechanical', 'error', 'Whitespace measurements must use the compact template’s fixed nominal margin.'));
      if (pdfMetrics.pages.at(-1).usableBottomWhitespacePt > 54) findings.push(finding('RENDERED_WHITESPACE_REVIEW', 'editorial', 'warn', 'More than 0.75 inches of usable bottom space remains; review missing evidence and structural spacing before shrinking type.'));
    }
  }

  // --- mechanical: page policy, size, extraction floor -----------------------
  const pageCount = Number(input.pageCount);
  if (pageCount !== 1) {
    // Give the revising drafter its actionable number: the payload's content
    // characters against the calibrated band, so "cut what, by how much" is
    // in the finding rather than rediscovered by trial renders.
    const overflowEvidence = materialKind === 'resume' && payload
      ? `payload ~${payloadContentChars(payload)} content chars vs ${isCompactResumeTemplate(templateKey) ? 'prototype' : 'calibrated'} band ${density.charFloor}–${density.charCeiling}; review structural spacing and evidence loss before cutting history, never type size`
      : undefined;
    findings.push(finding('PAGE_COUNT_EXCEEDS_POLICY', 'mechanical', 'error',
      `Rendered PDF has ${pageCount} pages; the policy is exactly one page (plan §3.3 cut order, never smaller type).`,
      overflowEvidence));
  }
  const outputBytes = Number(input.outputBytes);
  if (Number.isFinite(outputBytes) && outputBytes > MAX_OUTPUT_BYTES_POLICY) {
    findings.push(finding('FILE_SIZE_EXCEEDS_POLICY', 'mechanical', 'error',
      `Rendered PDF is ${outputBytes} bytes; the policy ceiling is ${MAX_OUTPUT_BYTES_POLICY}.`));
  }
  const compactChars = extractedText.replace(/\s+/g, '').length;
  if (compactChars < MIN_EXTRACTED_CHARS) {
    findings.push(finding('EXTRACTION_TOO_SPARSE', 'mechanical', 'error',
      `Only ${compactChars} non-whitespace characters extracted; a parser effectively receives an empty document.`));
  }

  // --- mechanical: safety scan (plan L7 — stored values, not keywords) -------
  for (const safety of Array.isArray(input.safetyValues) ? input.safetyValues : []) {
    const value = String(safety.value ?? '').trim();
    if (value.length < 3 || UNMATCHABLE_SAFETY_VALUES.has(value.toLowerCase())) continue;
    if (wordBoundedMatch(extractedText, value)) {
      findings.push(finding('SAFETY_VALUE_PRESENT', 'mechanical', 'error',
        `A stored protected value appears in the rendered text. Matching can be context-ambiguous; this remains blocked pending a scoped privacy review, never an automatic waiver.`));
    }
  }
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(extractedText)) {
    findings.push(finding('SSN_PATTERN_PRESENT', 'mechanical', 'error',
      'An SSN-shaped token appears in the rendered text.'));
  }

  // --- letter cross-checks (deterministically catchable wrong-company) -------
  if (materialKind === 'cover-letter') {
    const company = String(input.company || '').trim();
    if (company && !wordBoundedMatch(extractedText, company)) {
      findings.push(finding('LETTER_COMPANY_MISSING', 'mechanical', 'error',
        `The letter never names ${company}, the company this application targets.`));
    }
    const headLines = textLines(extractedText).slice(0, 12).join('\n');
    for (const other of Array.isArray(input.otherCompanies) ? input.otherCompanies : []) {
      const otherCompany = String(other || '').trim();
      if (!otherCompany || otherCompany.length < 3) continue;
      if (company && otherCompany.toLowerCase() === company.toLowerCase()) continue;
      if (company && (company.toLowerCase().includes(otherCompany.toLowerCase())
        || otherCompany.toLowerCase().includes(company.toLowerCase()))) continue;
      if (wordBoundedMatch(headLines, otherCompany)) {
        findings.push(finding('LETTER_WRONG_COMPANY', 'mechanical', 'error',
          `The letter's address block names ${otherCompany}, which belongs to a different application.`));
      }
    }
  }

  // --- template-lane extraction parity ---------------------------------------
  if (payload) {
    const normalizedText = normalizeWhitespace(extractedText);
    const lines = textLines(extractedText);

    if (materialKind === 'resume') {
      const name = String(payload.name || payload.contact?.name || '');
      const firstLine = lines.find((line) => line.trim().length > 0) || '';
      if (name && !firstLine.includes(name)) {
        findings.push(finding('NAME_NOT_FIRST', 'mechanical', 'error',
          'The candidate name is not the first extracted line; parsers key contact identity off document order.', firstLine));
      }
      if (isCompactResumeTemplate(templateKey)) {
        for (const [index, link] of (Array.isArray(payload.contactLinks) ? payload.contactLinks : []).entries()) {
          if (typeof link?.label !== 'string' || !normalizedText.includes(normalizeWhitespace(link.label))) findings.push(finding('CONTACT_LINK_LABEL_NOT_EXTRACTABLE', 'mechanical', 'error', `contactLinks[${index}].label must remain visible in extracted text.`));
        }
        // v4: the template-generated header prints each contact field as its
        // visible address; the address, not the URL, must survive extraction.
        for (const [key, label] of Object.entries(visibleContactFields(payload.contact))) {
          if (!normalizedText.includes(normalizeWhitespace(label))) findings.push(finding('CONTACT_LINK_LABEL_NOT_EXTRACTABLE', 'mechanical', 'error', `contact.${key} must remain visible in extracted text.`, label));
        }
      }

      const bullets = collectPayloadBullets(templateKey, payload);
      for (const bullet of bullets) {
        if (!normalizedText.includes(normalizeWhitespace(bullet.text))) {
          findings.push(finding('BULLET_NOT_EXTRACTABLE', 'mechanical', 'error',
            `${bullet.path} is not recoverable from the extracted text.`, bullet.text));
        }
      }

      // Master divergence — only when the operator has RECORDED a master.
      // Masters are an optional curated bullet library (Cole's directive,
      // 2026-08-19): language is normally generated per application from the
      // pool, with facts tracing to sources. A recorded master turns this on
      // as a consistency aid, never a script.
      if (Array.isArray(input.masterBullets) && input.masterBullets.length) {
        const masterSet = new Set(input.masterBullets.map(normalizeWhitespace));
        for (const bullet of bullets) {
          if (!masterSet.has(normalizeWhitespace(bullet.text))) {
            findings.push(finding('MASTER_DIVERGENCE', 'editorial', 'warn',
              `${bullet.path} is not in the recorded resume master. Masters are optional; either update the master or accept the divergence — facts must still trace to the pool either way.`, bullet.text));
          }
        }
      }
      const glyphCount = (extractedText.match(/•/g) || []).length;
      if (bullets.length && glyphCount < bullets.length) {
        findings.push(finding('BULLET_GLYPHS_MISSING', 'mechanical', 'error',
          `${bullets.length} bullets in the payload but only ${glyphCount} bullet glyphs extracted; items are merging into prose (plan defect 2).`));
      }
      for (const note of collectInlineNotes(templateKey, payload)) {
        if (!normalizedText.includes(normalizeWhitespace(note.text))) {
          findings.push(finding('NOTE_NOT_EXTRACTABLE', 'mechanical', 'error',
            `${note.path} is not recoverable from the extracted text.`, note.text));
        }
      }

      // Two-line discipline (v3 only, measured on the exact extraction): a
      // bullet that wraps to a third line, or whose last line holds a single
      // word, wastes the page and reads as a widow. Both are fixed by cutting
      // words, never facts and never type size.
      if (isCompactResumeTemplate(templateKey)) {
        const byText = new Map(bullets.map((bullet) => [normalizeWhitespace(bullet.text), bullet]));
        for (const block of extractedBulletBlocks(extractedText)) {
          const bullet = byText.get(block.text);
          if (!bullet) continue; // text that traces to no bullet is caught by UNTRACEABLE_TEXT_PRESENT
          if (block.lineCount >= 3) {
            findings.push(finding('BULLET_RENDERS_THREE_LINES', 'mechanical', 'error',
              `${bullet.path} renders on ${block.lineCount} lines; compact-template bullets fit exactly two. Cut words, not facts, and never type size.`, bullet.text));
          } else if (block.lineCount === 2 && block.lastLineWords <= 1) {
            findings.push(finding('BULLET_WIDOW_LINE', 'mechanical', 'error',
              `${bullet.path} ends in a one-word line; rewrap or trim so the last line carries at least two words.`, bullet.text));
          }
        }
      }

      const headings = expectedResumeHeadings(templateKey, payload);
      if (headings) {
        let cursor = -1;
        for (const heading of headings) {
          const index = lines.findIndex((line, lineIndex) => lineIndex > cursor && line.trim() === heading);
          if (index === -1) {
            findings.push(finding('SECTION_HEADING_NOT_DISCRETE', 'mechanical', 'error',
              `The “${heading}” heading is not on its own extracted line in order; gluing headings into prose breaks section parsing (plan defect 5).`));
            break;
          }
          cursor = index;
        }
      }

      // Keyword splits (plan defect 1): a line-ending hyphen whose re-joined
      // halves form a payload word means a keyword broke across lines. Two
      // joins are checked because both real failures exist: `server-less` is
      // an inserted hyphen (join without one) and `content-addressed` is a
      // break at an EXPLICIT hyphen (join keeping it).
      const visiblePayload = isCompactResumeTemplate(templateKey)
        ? {
          ...payload,
          contactLinks: (Array.isArray(payload.contactLinks) ? payload.contactLinks : []).map((link) => ({ label: link?.label })),
          ...(payload.contact ? { contact: { name: payload.contact.name, ...visibleContactFields(payload.contact) } } : {})
        }
        : payload;
      const payloadTokens = new Set(payloadStrings(visiblePayload).flatMap(tokenize));
      const hyphenatedPayloadWords = new Set(
        payloadStrings(payload)
          .flatMap((text) => text.toLowerCase().split(/[^a-z0-9@+#./-]+/))
          .filter((word) => word.includes('-'))
      );
      for (let index = 0; index < lines.length - 1; index += 1) {
        const match = /([A-Za-z]{2,})-\s*$/.exec(lines[index]);
        if (!match) continue;
        const nextWord = (lines[index + 1].trim().split(/\s+/)[0] || '').replace(/[^A-Za-z0-9-]/g, '');
        if (!nextWord) continue;
        const fragment = match[1].toLowerCase();
        const joined = `${fragment}${nextWord.toLowerCase()}`;
        const joinedHyphenated = `${fragment}-${nextWord.toLowerCase()}`;
        if (payloadTokens.has(joined) || hyphenatedPayloadWords.has(joinedHyphenated)) {
          findings.push(finding('KEYWORD_SPLIT_ACROSS_LINES', 'mechanical', 'error',
            `“${match[1]}-” / “${nextWord}” splits a payload keyword across lines; naive parsers index the fragments.`));
        }
      }

      // Hidden or injected text (plan L7): every extracted token must trace to
      // the payload or the template's own literals. Extraction and payload both
      // tokenize with hyphen-splitting, so re-joined words still trace.
      const allowedTokens = new Set([
        ...payloadTokens,
        ...tokenize(headings ? headings.join(' ') : ''),
        ...tokenize('summary technical skills experience projects education')
      ]);
      const unknown = [...new Set(tokenize(extractedText).filter((token) => !allowedTokens.has(token)))];
      if (unknown.length) {
        findings.push(finding('UNTRACEABLE_TEXT_PRESENT', 'mechanical', 'error',
          `${unknown.length} extracted token(s) trace to neither the payload nor the template: possible hidden or injected text.`,
          unknown.slice(0, 10).join(', ')));
      }

      // Lint only observes chronology. V3's separate editorial ledger requires
      // a disposition and also examines older ancestors when a role disappears.
      const ranges = (Array.isArray(payload.experience) ? payload.experience : [])
        .map((entry) => parseDateRange(entry?.dates))
        .filter(Boolean)
        .sort((a, b) => a.start - b.start);
      for (let index = 0; index < ranges.length - 1; index += 1) {
        const gap = ranges[index + 1].start - ranges[index].end;
        if (Number.isFinite(gap) && gap > 6) {
          findings.push(finding('TIMELINE_GAP_UNEXPLAINED', 'decision', 'warn',
            isCompactResumeTemplate(templateKey)
              ? `A ${gap}-month gap sits between two roles; independent editorial approval must explicitly address it without inventing an explanation.`
              : `A ${gap}-month gap sits between two roles; the plan requires a recorded human decision before this ships (decision ledger pending).`));
        }
      }
    }

    // Density bands fold in from the payload pass, with one correction: the
    // hard character ceiling is an ESTIMATE of overflow, and here the render
    // is the truth. A one-page render proves the payload fit, so the estimate
    // downgrades to the ordinary overflow-risk warning instead of failing a
    // demonstrably fine document.
    for (const bandFinding of lintTemplatePayload(templateKey, materialKind, payload)) {
      if (bandFinding.code === 'DENSITY_CERTAIN_OVERFLOW' && pageCount === 1) {
        findings.push(finding('DENSITY_OVERFLOW_RISK', 'editorial', 'warn',
          `${bandFinding.message} (The render proved one page despite the estimate.)`));
      } else {
        findings.push(bandFinding);
      }
    }
  } else {
    findings.push(finding('FREEFORM_LIMITED_LINT', 'editorial', 'warn',
      'Freeform LaTeX has no addressable payload; extraction-parity and density checks were skipped. Freeform revisions stay outside the unattended path.'));
  }

  // --- editorial prose checks (both lanes) ------------------------------------
  const lowered = extractedText.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lowered.includes(phrase)) {
      findings.push(finding('PROSE_BANNED_PHRASE', 'editorial', 'warn',
        `Contains “${phrase}” — on the plan's banned list; replace with a specific, owned verb.`));
    }
  }
  if (materialKind === 'resume' && /(?:^|[^\p{L}])(i|me|my|we|our)(?:$|[^\p{L}])/iu.test(extractedText)) {
    findings.push(finding('PROSE_FIRST_PERSON', 'editorial', 'warn',
      'First-person pronouns appear; resume bullets read stronger without them.'));
  }

  const errorCount = findings.filter((item) => item.severity === 'error').length;
  const warnCount = findings.filter((item) => item.severity === 'warn').length;
  return {
    lintVersion: LINT_VERSION,
    verdict: errorCount === 0 ? 'pass' : 'fail',
    errorCount,
    warnCount,
    findings,
    pdfMetrics
  };
}

// ------------------------------------------------------------ persistence ----

function loadRenderScope(db, renderId) {
  const scope = db.prepare(`
    SELECT r.id AS render_id, r.revision_id, r.application_id, r.page_count, r.output_bytes,
      r.extracted_text_sha256, r.extracted_text_attachment_path, r.output_sha256, r.output_attachment_path,
      m.material_kind_id, k.slug AS material_kind,
      v.template_key, v.template_payload, v.source_format
    FROM application_material_renders r
    JOIN application_material_revisions v ON v.id=r.revision_id
    JOIN application_materials m ON m.id=v.material_id
    JOIN application_material_kinds k ON k.id=m.material_kind_id
    WHERE r.id=?
  `).get(renderId);
  if (!scope) throw new MaterialLintError('RENDER_NOT_FOUND', `No render ${renderId}`);
  return scope;
}

function readVerifiedExtractedText(db, scope) {
  if (!scope.extracted_text_attachment_path) {
    throw new MaterialLintError(
      'MATERIAL_LINT_TEXT_MISSING',
      `Render ${scope.render_id} predates extracted-text persistence; re-render the revision so its document.txt is stored and verifiable.`
    );
  }
  // Lazy require: application-materials requires this module for the review
  // gate, so the path helper is pulled at call time to avoid a load cycle.
  const { managedMaterialRenderPath } = require('./application-materials');
  const absolutePath = managedMaterialRenderPath(scope.extracted_text_attachment_path, db);
  const bytes = fs.readFileSync(absolutePath);
  if (sha256(bytes) !== scope.extracted_text_sha256) {
    throw new MaterialLintError(
      'MATERIAL_LINT_TEXT_INTEGRITY',
      'Stored extracted text no longer matches the render\'s recorded digest.'
    );
  }
  return bytes.toString('utf8');
}

function collectStoredSafetyValues(db) {
  const values = [];
  if (tableExists(db, 'profile_contact')) {
    const contact = db.prepare('SELECT date_of_birth FROM profile_contact ORDER BY id LIMIT 1').get();
    const dob = contact?.date_of_birth ? String(contact.date_of_birth).trim() : '';
    const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
    if (dob) values.push({ label: 'date_of_birth', value: dob });
    if (isoMatch) values.push({ label: 'date_of_birth', value: `${isoMatch[2]}/${isoMatch[3]}/${isoMatch[1]}` });
  }
  if (tableExists(db, 'profile_eeo')) {
    const eeo = db.prepare('SELECT gender, pronouns, race_ethnicity, veteran, disability FROM profile_eeo ORDER BY id LIMIT 1').get();
    for (const label of ['gender', 'pronouns', 'race_ethnicity', 'veteran', 'disability']) {
      if (eeo?.[label]) values.push({ label: `eeo.${label}`, value: String(eeo[label]) });
    }
  }
  return values;
}

/**
 * Lint one render against its stored facts and record the append-only report.
 */
function recordMaterialLintReport(db, input, options = {}) {
  ensureMaterialLintSchema(db);
  const applicationId = positiveId(input.applicationId, 'application id');
  const renderId = positiveId(input.renderId, 'render id');
  const lintedBy = requiredText(input.lintedBy, 'linted by');
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotency key');
  const lintedAt = input.lintedAt ? requiredText(input.lintedAt, 'linted at', 40) : new Date().toISOString();

  const scope = loadRenderScope(db, renderId);
  if (scope.application_id !== applicationId) {
    throw new MaterialLintError('RENDER_SCOPE_MISMATCH', `Render ${renderId} does not belong to application ${applicationId}`);
  }
  const extractedText = readVerifiedExtractedText(db, scope);
  const application = db.prepare('SELECT company, role FROM applications WHERE id=?').get(applicationId);
  const otherCompanies = db.prepare('SELECT DISTINCT company FROM applications WHERE id<>? AND company IS NOT NULL')
    .all(applicationId).map((row) => row.company);

  let templatePayload = null;
  if (scope.template_payload) {
    try { templatePayload = JSON.parse(scope.template_payload); }
    catch { templatePayload = null; }
  }

  // Divergence baseline: the current resume master, when one is recorded.
  let masterBullets = null;
  if (scope.material_kind === 'resume') {
    const { getMaterialMaster, masterBulletTexts } = require('./profile-material-masters');
    const master = getMaterialMaster(db, 'resume');
    if (master) masterBullets = masterBulletTexts(master);
  }

  const result = lintRenderedMaterial({
    materialKind: scope.material_kind,
    extractedText,
    pageCount: scope.page_count,
    outputBytes: scope.output_bytes,
    outputSha256: scope.output_sha256,
    ...(isCompactResumeTemplate(scope.template_key) ? { pdfMetrics: (options.inspectPdfMetrics ?? createPdfMetricsInspector())({
      filePath: require('./application-materials').managedMaterialRenderPath(scope.output_attachment_path, db),
      expectedOutputSha256: scope.output_sha256,
      expectedExtractedTextSha256: scope.extracted_text_sha256,
      nominalBottomMarginPt: RESUME_V3_DENSITY.nominalBottomMarginPt
    }) } : {}),
    templateKey: scope.template_key,
    templatePayload,
    masterBullets,
    company: application?.company || '',
    otherCompanies,
    safetyValues: collectStoredSafetyValues(db)
  });

  const intent = {
    applicationId, renderId, lintedBy,
    lintVersion: result.lintVersion,
    verdict: result.verdict,
    findingsSha256: sha256(stableJson(result.findings)),
    ...(result.pdfMetrics ? { pdfMetricsSha256: sha256(stableJson(result.pdfMetrics)) } : {})
  };
  const intentSha256 = sha256(stableJson(intent));
  const prior = db.prepare('SELECT * FROM application_material_lint_reports WHERE idempotency_key=?').get(idempotencyKey);
  if (prior) {
    if (prior.intent_sha256 !== intentSha256) {
      throw new MaterialLintError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different lint result');
    }
    return { report: prior, ...result, findings: JSON.parse(prior.findings_json), replayed: true };
  }

  const info = db.prepare(`
    INSERT INTO application_material_lint_reports(
      application_id,material_kind_id,revision_id,render_id,lint_version,verdict,
      error_count,warn_count,findings_json,extracted_text_sha256,linted_by,linted_at,
      idempotency_key,intent_sha256,pdf_metrics_json,pdf_metrics_sha256
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    applicationId, scope.material_kind_id, scope.revision_id, renderId,
    result.lintVersion, result.verdict, result.errorCount, result.warnCount,
    JSON.stringify(result.findings), scope.extracted_text_sha256,
    lintedBy, lintedAt, idempotencyKey, intentSha256,
    result.pdfMetrics ? JSON.stringify(result.pdfMetrics) : null,
    result.pdfMetrics ? sha256(stableJson(result.pdfMetrics)) : null
  );
  return {
    report: db.prepare('SELECT * FROM application_material_lint_reports WHERE id=?').get(Number(info.lastInsertRowid)),
    ...result,
    replayed: false
  };
}

/** Latest report for a render, without DDL — safe on read-only connections. */
function latestRenderLintSummary(db, renderId) {
  if (!tableExists(db, 'application_material_lint_reports')) return null;
  const row = db.prepare(`
    SELECT id, lint_version, verdict, error_count, warn_count, linted_by, linted_at, findings_json
    FROM application_material_lint_reports WHERE render_id=? ORDER BY id DESC LIMIT 1
  `).get(renderId);
  if (!row) return null;
  const { findings_json: findingsJson, ...summary } = row;
  let findings = [];
  try {
    const parsed = JSON.parse(findingsJson);
    if (Array.isArray(parsed)) findings = parsed;
  } catch { /* a summary never fails on an unreadable report body */ }
  const template = db.prepare(`SELECT v.template_key FROM application_material_renders r JOIN application_material_revisions v ON v.id=r.revision_id WHERE r.id=?`).get(renderId)?.template_key;
  const legacyAccepted = LEGACY_TEMPLATE_KEYS.has(template ?? null) && summary.lint_version === LEGACY_LINT_VERSION;
  let pdfMetrics = null;
  if (isCompactResumeTemplate(template)) {
    const columns = new Set(db.prepare('PRAGMA table_info(application_material_lint_reports)').all().map((column) => column.name));
    if (columns.has('pdf_metrics_json') && columns.has('pdf_metrics_sha256')) {
      const stored = db.prepare('SELECT pdf_metrics_json, pdf_metrics_sha256 FROM application_material_lint_reports WHERE id=?').get(summary.id);
      try {
        const scope = loadRenderScope(db, renderId);
        const candidate = JSON.parse(stored.pdf_metrics_json);
        if (sha256(stableJson(candidate)) === stored.pdf_metrics_sha256) pdfMetrics = validatePdfMetrics(candidate, { outputSha256: scope.output_sha256, extractedTextSha256: scope.extracted_text_sha256, pageCount: scope.page_count, outputBytes: scope.output_bytes });
      } catch { /* missing/invalid metrics make the new report stale */ }
    }
  }
  // `findings` rides along so the fabric can tell a revising worker WHAT
  // failed (2026-09-02: workers looped on "1 error(s)" with the finding hidden).
  return { ...summary, findings, pdfMetrics, stale: (!legacyAccepted && summary.lint_version !== LINT_VERSION) || (isCompactResumeTemplate(template) && !pdfMetrics) };
}

/**
 * Gate (plan §3.2): approving a LaTeX revision requires a passing, current
 * lint report for the exact render being pinned. A linter upgrade makes an
 * old pass stale rather than letting it carry forward.
 */
function assertRenderLintPassed(db, renderId) {
  const summary = latestRenderLintSummary(db, positiveId(renderId, 'render id'));
  if (!summary || summary.stale) {
    throw new MaterialLintError(
      'MATERIAL_LINT_REQUIRED',
      `Render ${renderId} has no current ${LINT_VERSION} report. Run \`jobtrack application-material lint --render-id ${renderId}\` before approval.`
    );
  }
  if (summary.verdict !== 'pass') {
    throw new MaterialLintError(
      'MATERIAL_LINT_FAILED',
      `Render ${renderId} failed lint with ${summary.error_count} error finding(s); fix the revision and re-render rather than approving.`,
      { reportId: summary.id }
    );
  }
  return summary;
}

module.exports = {
  LINT_VERSION,
  FINDING_CLASSES,
  VERDICTS,
  RESUME_DENSITY,
  RESUME_V3_DENSITY,
  LETTER_DENSITY,
  BANNED_PHRASES,
  MaterialLintError,
  ensureMaterialLintSchema,
  lintTemplatePayload,
  lintRenderedMaterial,
  validatePdfMetrics,
  recordMaterialLintReport,
  latestRenderLintSummary,
  assertRenderLintPassed
};
