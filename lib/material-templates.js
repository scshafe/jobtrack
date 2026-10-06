'use strict';

// material-templates.js — STANDARDIZED LaTeX templates for resumes and cover
// letters (Cole's directive, 2026-08-05).
//
// Purpose: separate PRESENTATION from CONTENT. A template is a fixed,
// versioned LaTeX skeleton, pre-validated against the pinned texlive renderer;
// a generation supplies only a structured content payload. The model engages
// with substance — what to say, which evidence to pull — never with preambles,
// environments, or spacing, and every application comes out visually
// consistent.
//
// Design rules:
//   * Templates are VERSIONED IDENTITIES: `resume.standard.v1` never changes
//     once used; improvements ship as v2 successors. The registry is the only
//     source; there is no ad-hoc template text.
//   * Expansion is DETERMINISTIC: template(payload) -> identical LaTeX bytes,
//     every time. The expanded LaTeX is what becomes the material revision
//     content, so every existing invariant (content sha, render pinning,
//     review, packaging) is untouched. Freeform LaTeX drafting remains
//     available — templates are a lane, not a wall.
//   * All payload text is LaTeX-ESCAPED on the way in. Payloads are content,
//     never markup; a payload cannot inject preamble or commands.
//   * Templates use ONLY constructs the pinned renderer supports
//     (texlive-latex-base/recommended: article, geometry, no enumitem) and
//     that the web preview (latex.js) can approximate.
//
// Payload shapes are validated hard — unknown keys reject, required keys
// reject when absent — so a payload authored today expands identically under
// the same template id forever.

const MAX_TEXT = 2000;
const MAX_ITEMS = 40;

class MaterialTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MaterialTemplateError';
    this.code = code;
  }
}

const invalid = (message) => { throw new MaterialTemplateError('TEMPLATE_PAYLOAD_INVALID', message); };

/** Escape arbitrary text for safe use inside LaTeX body text. Backslashes go
 * through a placeholder so the braces of \textbackslash{} survive the
 * special-character pass. */
function texEscape(value) {
  const BS = '\u0000';
  return String(value)
    .replace(/\\/g, BS)
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .split(BS).join('\\textbackslash{}')
    .replace(/\r?\n+/g, ' ')
    .trim();
}

function requiredText(value, label, max = MAX_TEXT) {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} is required`);
  if (value.length > max) invalid(`${label} exceeds ${max} characters`);
  return texEscape(value);
}

function optionalText(value, label, max = MAX_TEXT) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  if (value.length > max) invalid(`${label} exceeds ${max} characters`);
  return texEscape(value);
}

function textList(value, label, { min = 0, max = MAX_ITEMS } = {}) {
  if (value === undefined || value === null) value = [];
  if (!Array.isArray(value)) invalid(`${label} must be an array of strings`);
  if (value.length < min) invalid(`${label} needs at least ${min} item(s)`);
  if (value.length > max) invalid(`${label} exceeds ${max} items`);
  return value.map((item, index) => requiredText(item, `${label}[${index}]`));
}

function exactKeys(object, allowed, label) {
  if (typeof object !== 'object' || object === null || Array.isArray(object)) invalid(`${label} must be an object`);
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) invalid(`${label} has unknown key "${key}"`);
  }
}

/** Shared list environment: renderer-safe tight itemize (no enumitem). */
const TIGHT_LIST_PREAMBLE = `\\newenvironment{tightitemize}
  {\\begin{itemize}\\setlength{\\itemsep}{1pt}\\setlength{\\parskip}{0pt}\\setlength{\\topsep}{2pt}}
  {\\end{itemize}}`;

function itemize(items) {
  if (!items.length) return '';
  return `\\begin{tightitemize}\n${items.map((item) => `\\item ${item}`).join('\n')}\n\\end{tightitemize}`;
}

// ---------------------------------------------------------------- resume ----

function validateResumePayload(payload) {
  exactKeys(payload, ['name', 'contactLine', 'summary', 'experience', 'education', 'skills'], 'payload');
  const experience = Array.isArray(payload.experience) ? payload.experience : invalid('payload.experience must be an array');
  if (experience.length < 1) invalid('payload.experience needs at least one entry');
  if (experience.length > 12) invalid('payload.experience exceeds 12 entries');
  const education = Array.isArray(payload.education) ? payload.education : invalid('payload.education must be an array');
  if (education.length > 6) invalid('payload.education exceeds 6 entries');
  return {
    name: requiredText(payload.name, 'payload.name', 200),
    contactLine: requiredText(payload.contactLine, 'payload.contactLine', 500),
    summary: optionalText(payload.summary, 'payload.summary'),
    experience: experience.map((entry, index) => {
      exactKeys(entry, ['title', 'org', 'dates', 'bullets'], `payload.experience[${index}]`);
      return {
        title: requiredText(entry.title, `payload.experience[${index}].title`, 200),
        org: requiredText(entry.org, `payload.experience[${index}].org`, 200),
        dates: requiredText(entry.dates, `payload.experience[${index}].dates`, 100),
        bullets: textList(entry.bullets, `payload.experience[${index}].bullets`, { min: 1, max: 8 })
      };
    }),
    education: education.map((entry, index) => {
      exactKeys(entry, ['degree', 'org', 'dates', 'notes'], `payload.education[${index}]`);
      return {
        degree: requiredText(entry.degree, `payload.education[${index}].degree`, 200),
        org: requiredText(entry.org, `payload.education[${index}].org`, 200),
        dates: requiredText(entry.dates, `payload.education[${index}].dates`, 100),
        notes: textList(entry.notes, `payload.education[${index}].notes`, { max: 4 })
      };
    }),
    skills: textList(payload.skills, 'payload.skills', { max: 60 })
  };
}

function renderResumeStandardV1(raw) {
  const p = validateResumePayload(raw);
  const experience = p.experience.map((entry) =>
    `\\textbf{${entry.title}} --- ${entry.org} \\hfill ${entry.dates}\n${itemize(entry.bullets)}`
  ).join('\n');
  const education = p.education.map((entry) =>
    `\\textbf{${entry.degree}} --- ${entry.org} \\hfill ${entry.dates}${entry.notes.length ? `\n${itemize(entry.notes)}` : ''}`
  ).join('\n');
  return `\\documentclass[10.5pt]{article}
\\usepackage[margin=0.9in]{geometry}
\\setlength{\\parindent}{0pt}
\\pagestyle{empty}
${TIGHT_LIST_PREAMBLE}
\\begin{document}
{\\LARGE \\textbf{${p.name}}}\\\\[2pt]
${p.contactLine}
${p.summary ? `\n\\vspace{7pt}\\textbf{Summary}\\\\\n${p.summary}\n` : ''}
\\vspace{7pt}\\textbf{Experience}\\\\[2pt]
${experience}
${p.education.length ? `\n\\vspace{7pt}\\textbf{Education}\\\\\n${education}\n` : ''}${p.skills.length ? `\n\\vspace{7pt}\\textbf{Skills}\\\\\n${p.skills.join(', ')}\n` : ''}\\end{document}
`;
}

// ---------------------------------------------------------- cover letter ----

function validateCoverLetterPayload(payload) {
  exactKeys(payload, ['senderName', 'senderLines', 'recipientLines', 'salutation', 'paragraphs', 'closing'], 'payload');
  return {
    senderName: requiredText(payload.senderName, 'payload.senderName', 200),
    senderLines: textList(payload.senderLines, 'payload.senderLines', { max: 6 }),
    recipientLines: textList(payload.recipientLines, 'payload.recipientLines', { max: 6 }),
    salutation: requiredText(payload.salutation, 'payload.salutation', 200),
    paragraphs: (Array.isArray(payload.paragraphs) && payload.paragraphs.length >= 1 && payload.paragraphs.length <= 8)
      ? payload.paragraphs.map((paragraph, index) => requiredText(paragraph, `payload.paragraphs[${index}]`, 3000))
      : invalid('payload.paragraphs must be 1-8 paragraphs'),
    closing: requiredText(payload.closing, 'payload.closing', 200)
  };
}

function renderCoverLetterStandardV1(raw) {
  const p = validateCoverLetterPayload(raw);
  return `\\documentclass[11pt]{article}
\\usepackage[margin=1.1in]{geometry}
\\setlength{\\parindent}{0pt}
\\pagestyle{empty}
\\begin{document}
${[p.senderName, ...p.senderLines].join('\\\\\n')}\\\\[10pt]
${p.recipientLines.length ? `${p.recipientLines.join('\\\\\n')}\\\\[10pt]\n` : ''}${p.salutation}

${p.paragraphs.join('\n\n')}

${p.closing}\\\\[8pt]
${p.senderName}
\\end{document}
`;
}

// ============================================================================
// v2 templates (2026-08-05). Successors to v1 per the template-identity rule;
// v1 is frozen and keeps expanding byte-identically forever.
//
// IMPORTANT — why the helpers below are duplicated rather than shared: v1's
// output bytes are a frozen identity, and every byte-producing helper it calls
// is therefore frozen too. A well-meaning edit to a SHARED escape or list
// helper (teaching it one new character, tightening one length) would silently
// change v1's expansion without anyone touching `renderResumeStandardV1`.
// So v2 owns its byte-producing helpers outright. Pure validation helpers that
// only throw (`exactKeys`) stay shared — they cannot move a byte.
// `test/material-templates.test.js` pins both v1 templates against golden
// fixtures so this rule is enforced rather than merely documented.
//
// v2 changes, each traceable to docs/RESUME_QUALITY_PLAN.md §0.2 and §3.3:
//   * `\raggedright` + `\hyphenpenalty` + `\exhyphenpenalty` — justified text
//     was splitting keywords across lines ("server-less", "con-current"), and
//     hyphenpenalty alone does not stop breaks at EXPLICIT hyphens, so
//     "content-addressed" would still split.
//   * Charter (psnfss) with T1 encoding — a recommended text face, and T1 is
//     what makes the bullet glyph survive text extraction.
//   * 0.75in margins, grouped skills, per-role location + optional org context,
//     a projects section, standard headings with a thin rule.
//   * ONE PAGE is the target: no page-2 header machinery is frozen into this
//     identity. Page-count enforcement belongs to the lint gate, not here.
//   * Plain-text URLs; hyperref is available in the pinned image but unused,
//     because visible URL text is the extraction-safe choice.
// ============================================================================

/** v2 escape. Byte-for-byte independent of {@link texEscape} by design. */
function texEscapeV2(value) {
  const BS = '\u0000';
  return String(value)
    .replace(/\\/g, BS)
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .split(BS).join('\\textbackslash{}')
    .replace(/\r?\n+/g, ' ')
    .trim();
}

function requiredTextV2(value, label, max = MAX_TEXT) {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} is required`);
  if (value.length > max) invalid(`${label} exceeds ${max} characters`);
  return texEscapeV2(value);
}

function optionalTextV2(value, label, max = MAX_TEXT) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  if (value.length > max) invalid(`${label} exceeds ${max} characters`);
  return texEscapeV2(value);
}

function textListV2(value, label, { min = 0, max = MAX_ITEMS } = {}) {
  if (value === undefined || value === null) value = [];
  if (!Array.isArray(value)) invalid(`${label} must be an array of strings`);
  if (value.length < min) invalid(`${label} needs at least ${min} item(s)`);
  if (value.length > max) invalid(`${label} exceeds ${max} items`);
  return value.map((item, index) => requiredTextV2(item, `${label}[${index}]`));
}

function boundedArray(value, label, { min = 0, max }) {
  if (value === undefined || value === null) value = [];
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  if (value.length < min) invalid(`${label} needs at least ${min} entr(y|ies)`);
  if (value.length > max) invalid(`${label} exceeds ${max} entries`);
  return value;
}

/** v2 preamble. `\rule` rather than `\hrule` so the heading macro is safe in
 * horizontal mode; T1 + Charter so `\textbullet` carries a Unicode mapping and
 * survives `pdftotext`. */
const V2_PREAMBLE = `\\usepackage[T1]{fontenc}
\\usepackage{charter}
\\setlength{\\parindent}{0pt}
\\raggedright
\\hyphenpenalty=10000
\\exhyphenpenalty=10000
\\pagestyle{empty}
\\newcommand{\\jtsection}[1]{\\par\\vspace{9pt}{\\large\\bfseries #1}\\par\\vspace{2pt}\\hrule\\vspace{4pt}\\par}
\\newenvironment{jtitems}
  {\\begin{itemize}\\setlength{\\itemsep}{1.5pt}\\setlength{\\parskip}{0pt}\\setlength{\\parsep}{0pt}\\setlength{\\topsep}{2pt}}
  {\\end{itemize}}`;

function itemizeV2(items) {
  if (!items.length) return '';
  return `\\begin{jtitems}\n${items.map((item) => `\\item ${item}`).join('\n')}\n\\end{jtitems}`;
}

function validateResumeV2Payload(payload) {
  exactKeys(payload, ['name', 'contactLine', 'summary', 'experience', 'projects', 'education', 'skills'], 'payload');
  const experience = boundedArray(payload.experience, 'payload.experience', { min: 1, max: 12 });
  const projects = boundedArray(payload.projects, 'payload.projects', { max: 8 });
  const education = boundedArray(payload.education, 'payload.education', { max: 6 });
  const skills = boundedArray(payload.skills, 'payload.skills', { max: 8 });
  return {
    name: requiredTextV2(payload.name, 'payload.name', 200),
    contactLine: requiredTextV2(payload.contactLine, 'payload.contactLine', 500),
    summary: optionalTextV2(payload.summary, 'payload.summary'),
    experience: experience.map((entry, index) => {
      exactKeys(entry, ['title', 'org', 'location', 'dates', 'context', 'bullets'], `payload.experience[${index}]`);
      return {
        title: requiredTextV2(entry.title, `payload.experience[${index}].title`, 200),
        org: requiredTextV2(entry.org, `payload.experience[${index}].org`, 200),
        location: optionalTextV2(entry.location, `payload.experience[${index}].location`, 120),
        dates: requiredTextV2(entry.dates, `payload.experience[${index}].dates`, 100),
        context: optionalTextV2(entry.context, `payload.experience[${index}].context`, 300),
        bullets: textListV2(entry.bullets, `payload.experience[${index}].bullets`, { min: 1, max: 8 })
      };
    }),
    projects: projects.map((entry, index) => {
      exactKeys(entry, ['name', 'technologies', 'bullets'], `payload.projects[${index}]`);
      return {
        name: requiredTextV2(entry.name, `payload.projects[${index}].name`, 200),
        technologies: optionalTextV2(entry.technologies, `payload.projects[${index}].technologies`, 300),
        bullets: textListV2(entry.bullets, `payload.projects[${index}].bullets`, { max: 4 })
      };
    }),
    education: education.map((entry, index) => {
      exactKeys(entry, ['degree', 'org', 'dates', 'notes'], `payload.education[${index}]`);
      return {
        degree: requiredTextV2(entry.degree, `payload.education[${index}].degree`, 200),
        org: requiredTextV2(entry.org, `payload.education[${index}].org`, 200),
        dates: requiredTextV2(entry.dates, `payload.education[${index}].dates`, 100),
        notes: textListV2(entry.notes, `payload.education[${index}].notes`, { max: 4 })
      };
    }),
    skills: skills.map((entry, index) => {
      exactKeys(entry, ['group', 'items'], `payload.skills[${index}]`);
      return {
        group: requiredTextV2(entry.group, `payload.skills[${index}].group`, 80),
        items: textListV2(entry.items, `payload.skills[${index}].items`, { min: 1, max: 30 })
      };
    })
  };
}

function renderResumeStandardV2(raw) {
  const p = validateResumeV2Payload(raw);
  // Role line keeps org and title adjacent to their dates in the text layer;
  // `\hfill` is a real right tab stop, not a table.
  // Dates ride on an adjacent meta line rather than being pushed right with
  // `\hfill`. Measured: the wide fill gap makes pdftotext emit the date as its
  // own block separated by a blank line — the "isolated dates" parse failure.
  // A normal line break keeps role and dates contiguous in every extraction
  // mode while staying scannable in a fixed left column.
  const experience = p.experience.map((entry) => {
    const meta = [entry.location, entry.dates].filter(Boolean).join(' \\textperiodcentered{} ');
    const head = `\\textbf{${entry.org}} --- ${entry.title}\\\\\n\\textit{${meta}}\\\\[1pt]`;
    const context = entry.context ? `\n${entry.context}\\\\[1pt]` : '';
    return `${head}${context}\n${itemizeV2(entry.bullets)}`;
  }).join('\n\\vspace{4pt}\n');
  const projects = p.projects.map((entry) => {
    const head = `\\textbf{${entry.name}}${entry.technologies ? ` --- ${entry.technologies}` : ''}\\\\[1pt]`;
    return `${head}${entry.bullets.length ? `\n${itemizeV2(entry.bullets)}` : ''}`;
  }).join('\n\\vspace{3pt}\n');
  const education = p.education.map((entry) =>
    `\\textbf{${entry.org}} --- ${entry.degree}\\\\\n\\textit{${entry.dates}}${entry.notes.length ? `\\\\[1pt]\n${itemizeV2(entry.notes)}` : ''}`
  ).join('\n\\vspace{3pt}\n');
  const skills = p.skills.map((entry) => `\\textbf{${entry.group}:} ${entry.items.join(', ')}`).join('\\\\\n');

  return `\\documentclass[10.5pt,letterpaper]{article}
\\usepackage[margin=0.75in]{geometry}
${V2_PREAMBLE}
\\begin{document}
{\\LARGE\\bfseries ${p.name}}\\\\[3pt]
${p.contactLine}
${p.summary ? `\\jtsection{Summary}\n${p.summary}\n` : ''}${p.skills.length ? `\\jtsection{Technical Skills}\n${skills}\n` : ''}\\jtsection{Experience}
${experience}
${p.projects.length ? `\\jtsection{Projects}\n${projects}\n` : ''}${p.education.length ? `\\jtsection{Education}\n${education}\n` : ''}\\end{document}
`;
}

function validateCoverLetterV2Payload(payload) {
  exactKeys(payload, ['senderName', 'senderLines', 'recipientLines', 'salutation', 'paragraphs', 'closing'], 'payload');
  return {
    senderName: requiredTextV2(payload.senderName, 'payload.senderName', 200),
    senderLines: textListV2(payload.senderLines, 'payload.senderLines', { max: 6 }),
    recipientLines: textListV2(payload.recipientLines, 'payload.recipientLines', { max: 6 }),
    salutation: requiredTextV2(payload.salutation, 'payload.salutation', 200),
    paragraphs: (Array.isArray(payload.paragraphs) && payload.paragraphs.length >= 1 && payload.paragraphs.length <= 8)
      ? payload.paragraphs.map((paragraph, index) => requiredTextV2(paragraph, `payload.paragraphs[${index}]`, 3000))
      : invalid('payload.paragraphs must be 1-8 paragraphs'),
    closing: requiredTextV2(payload.closing, 'payload.closing', 200)
  };
}

function renderCoverLetterStandardV2(raw) {
  const p = validateCoverLetterV2Payload(raw);
  return `\\documentclass[11pt,letterpaper]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage[T1]{fontenc}
\\usepackage{charter}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{8pt}
\\raggedright
\\hyphenpenalty=10000
\\exhyphenpenalty=10000
\\pagestyle{empty}
\\begin{document}
${[`{\\large\\bfseries ${p.senderName}}`, ...p.senderLines].join('\\\\\n')}\\\\[12pt]
${p.recipientLines.length ? `${p.recipientLines.join('\\\\\n')}\\\\[12pt]\n` : ''}${p.salutation}

${p.paragraphs.join('\n\n')}

${p.closing}\\\\[10pt]
${p.senderName}
\\end{document}
`;
}

// ============================================================================
// Resume v3 (2026-09-09): compact structure, real 10.5pt body text and typed
// contact links. V1/v2 byte-producing helpers and identities remain frozen.
// Density is an editorial target verified on the PDF, never a layout switch
// in a content payload. Every v3 byte-producing helper is independent.
// ============================================================================

function texEscapeV3(value) {
  const escaped = {
    '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#',
    '_': '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}'
  };
  return value.replace(/[\\&%$#_{}~^]/g, (character) => escaped[character])
    .replace(/[\r\n\t]+/g, ' ').trim();
}

function requiredTextV3(value, label, max = 2000) {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} is required`);
  if (value.length > max) invalid(`${label} exceeds ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid(`${label} contains control characters`);
  return texEscapeV3(value);
}

function optionalTextV3(value, label, max = 2000) {
  if (value === undefined || value === null || value === '') return null;
  return requiredTextV3(value, label, max);
}

function boundedArrayV3(value, label, { min = 0, max }) {
  if (value === undefined || value === null) value = [];
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  if (value.length < min) invalid(`${label} needs at least ${min} entr(y|ies)`);
  if (value.length > max) invalid(`${label} exceeds ${max} entries`);
  return value;
}

function textListV3(value, label, { min = 0, max = 40 } = {}) {
  return boundedArrayV3(value, label, { min, max })
    .map((item, index) => requiredTextV3(item, `${label}[${index}]`));
}

// Links are content-only, explicit URI types: a bare email recipient or one
// public GitHub/LinkedIn profile. No query/header, fragment, credentials,
// port, encoded byte, arbitrary host/path, or LaTeX syntax can enter a URI.
// The pinned renderer independently scans the final PDF's action graph.
function contactLinksV3(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid('payload.contactLinks must be an array');
  if (value.length > 3) invalid('payload.contactLinks exceeds 3 entries');
  const seen = new Set();
  return value.map((entry, index) => {
    const label = `payload.contactLinks[${index}]`;
    exactKeys(entry, ['label', 'url'], label);
    const visible = requiredTextV3(entry.label, `${label}.label`, 100);
    if (typeof entry.url !== 'string' || entry.url.length > 300) invalid(`${label}.url must be an approved contact URI`);
    const email = /^mailto:([A-Za-z0-9_+'-]+(?:\.[A-Za-z0-9_+'-]+)*)@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)$/.exec(entry.url);
    const github = /^https:\/\/(?:www\.)?github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/?$/.test(entry.url);
    const linkedin = /^https:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}\/?$/.test(entry.url);
    const type = email ? 'email' : github ? 'github' : linkedin ? 'linkedin' : null;
    if (!type || (email && (email[1].length > 64 || email[2].split('.').some((part) => part.length > 63)))) {
      invalid(`${label}.url must be a bare mailto email or HTTPS GitHub/LinkedIn profile URI`);
    }
    if (seen.has(type)) invalid(`payload.contactLinks has duplicate ${type} links`);
    seen.add(type);
    return { label: visible, url: texEscapeV3(entry.url) };
  });
}

function validateResumeV3Payload(payload) {
  exactKeys(payload, ['name', 'contactLine', 'contactLinks', 'summary', 'experience', 'projects', 'education', 'skills'], 'payload');
  const contactLine = optionalTextV3(payload.contactLine, 'payload.contactLine', 500);
  const contactLinks = contactLinksV3(payload.contactLinks);
  if (!contactLine && !contactLinks.length) invalid('payload needs contactLine or at least one contactLinks entry');
  return {
    name: requiredTextV3(payload.name, 'payload.name', 200),
    contactLine, contactLinks,
    summary: optionalTextV3(payload.summary, 'payload.summary'),
    experience: boundedArrayV3(payload.experience, 'payload.experience', { min: 1, max: 12 }).map((entry, index) => {
      const label = `payload.experience[${index}]`;
      exactKeys(entry, ['title', 'org', 'location', 'dates', 'context', 'bullets'], label);
      return {
        title: requiredTextV3(entry.title, `${label}.title`, 200),
        org: requiredTextV3(entry.org, `${label}.org`, 200),
        location: optionalTextV3(entry.location, `${label}.location`, 120),
        dates: requiredTextV3(entry.dates, `${label}.dates`, 100),
        context: optionalTextV3(entry.context, `${label}.context`, 300),
        bullets: textListV3(entry.bullets, `${label}.bullets`, { min: 1, max: 8 })
      };
    }),
    projects: boundedArrayV3(payload.projects, 'payload.projects', { max: 8 }).map((entry, index) => {
      const label = `payload.projects[${index}]`;
      exactKeys(entry, ['name', 'technologies', 'bullets'], label);
      return {
        name: requiredTextV3(entry.name, `${label}.name`, 200),
        technologies: optionalTextV3(entry.technologies, `${label}.technologies`, 300),
        bullets: textListV3(entry.bullets, `${label}.bullets`, { max: 4 })
      };
    }),
    education: boundedArrayV3(payload.education, 'payload.education', { max: 6 }).map((entry, index) => {
      const label = `payload.education[${index}]`;
      exactKeys(entry, ['degree', 'org', 'dates', 'notes'], label);
      return {
        degree: requiredTextV3(entry.degree, `${label}.degree`, 200),
        org: requiredTextV3(entry.org, `${label}.org`, 200),
        dates: requiredTextV3(entry.dates, `${label}.dates`, 100),
        notes: textListV3(entry.notes, `${label}.notes`, { max: 4 })
      };
    }),
    skills: boundedArrayV3(payload.skills, 'payload.skills', { max: 8 }).map((entry, index) => {
      const label = `payload.skills[${index}]`;
      exactKeys(entry, ['group', 'items'], label);
      return {
        group: requiredTextV3(entry.group, `${label}.group`, 80),
        items: textListV3(entry.items, `${label}.items`, { min: 1, max: 30 })
      };
    })
  };
}

const V3_RESUME_PREAMBLE = `\\documentclass[10pt,letterpaper]{article}
\\usepackage[margin=0.63in]{geometry}
\\usepackage[T1]{fontenc}
\\usepackage{charter}
\\usepackage[hidelinks]{hyperref}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{0pt}
\\raggedright
\\hyphenpenalty=10000
\\exhyphenpenalty=10000
\\pagestyle{empty}
\\newcommand{\\jtsection}[1]{\\par\\vspace{5pt}{\\fontsize{11.5pt}{13pt}\\selectfont\\bfseries #1}\\par\\nobreak\\vspace{1.5pt}\\hrule\\vspace{3pt}\\nobreak}
\\newenvironment{jtitems}
  {\\begin{list}{\\textbullet}{\\setlength{\\leftmargin}{12pt}\\setlength{\\labelwidth}{6pt}\\setlength{\\labelsep}{6pt}\\setlength{\\itemsep}{1pt}\\setlength{\\parsep}{0pt}\\setlength{\\topsep}{2pt}\\setlength{\\partopsep}{0pt}}}
  {\\end{list}}`;

function itemizeV3(items) {
  if (!items.length) return '';
  return `\\begin{jtitems}\n${items.map((item) => `\\item ${item}`).join('\n')}\n\\end{jtitems}`;
}

function renderResumeStandardV3(raw) {
  const p = validateResumeV3Payload(raw);
  const separator = ' \\textperiodcentered{} ';
  const contact = [p.contactLine, ...p.contactLinks.map((link) => `\\href{${link.url}}{${link.label}}`)].filter(Boolean).join(separator);
  const experience = p.experience.map((entry) => {
    const meta = [entry.dates, entry.location].filter(Boolean).join(separator);
    const head = `\\textbf{${entry.org}} --- ${entry.title}${separator}\\textit{${meta}}\\par\\nopagebreak[3]`;
    return `${head}${entry.context ? `\n${entry.context}\\par\\nopagebreak[3]` : ''}\n${itemizeV3(entry.bullets)}`;
  }).join('\n\\vspace{2pt}\n');
  const projects = p.projects.map((entry) =>
    `\\textbf{${entry.name}}${entry.technologies ? ` --- ${entry.technologies}` : ''}\\par\\nopagebreak[3]${entry.bullets.length ? `\n${itemizeV3(entry.bullets)}` : ''}`
  ).join('\n\\vspace{2pt}\n');
  const education = p.education.map((entry) =>
    `\\textbf{${entry.org}} --- ${entry.degree}${separator}${entry.dates}${entry.notes.length ? `; ${entry.notes.join('; ')}` : ''}\\par`
  ).join('\n');
  const skills = p.skills.map((entry) => `\\textbf{${entry.group}:} ${entry.items.join(', ')}\\par`).join('\n');
  return `${V3_RESUME_PREAMBLE}
\\begin{document}
\\fontsize{10.5pt}{12pt}\\selectfont
{\\fontsize{20pt}{22pt}\\selectfont\\bfseries ${p.name}}\\par\\vspace{2pt}
${contact}\\par
${p.summary ? `\\jtsection{Summary}\n${p.summary}\\par\n` : ''}\\jtsection{Experience}
${experience}
${p.projects.length ? `\\jtsection{Projects}\n${projects}\n` : ''}${p.skills.length ? `\\jtsection{Technical Skills}\n${skills}\n` : ''}${p.education.length ? `\\jtsection{Education}\n${education}\n` : ''}\\end{document}
`;
}

// ============================================================================
// Resume v4 (2026-09-09): the v3 page with a template-generated header. The
// name and contact block come from the approved profile contact record, which
// the CLI injects as `contact`; a worker payload never authors them. Links
// print their visible address text and are clickable, set in a dark print-safe
// blue. V3's byte-producing helpers stay frozen; v4 shares only the pure text
// validators and escaping.
// ============================================================================

const COMPACT_RESUME_TEMPLATES = Object.freeze(['resume.standard.v3', 'resume.standard.v4']);
function isCompactResumeTemplate(key) { return COMPACT_RESUME_TEMPLATES.includes(key); }

/** The address text a reader sees for a contact link: scheme, www. and any
 * trailing slash removed. Shared with lint so visible-text checks agree. */
function contactVisibleLabel(url) {
  return String(url).replace(/^mailto:/i, '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
}

const CONTACT_V4_KEYS = Object.freeze(['name', 'email', 'location', 'github', 'linkedin']);

function contactV4(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('payload.contact must be the profile contact block the CLI injects');
  exactKeys(value, CONTACT_V4_KEYS, 'payload.contact');
  const name = requiredTextV3(value.name, 'payload.contact.name', 200);
  const location = optionalTextV3(value.location, 'payload.contact.location', 120);
  const rawLinks = [];
  if (value.email) rawLinks.push({ label: contactVisibleLabel(value.email), url: `mailto:${String(value.email).trim()}` });
  if (value.github) rawLinks.push({ label: contactVisibleLabel(value.github), url: String(value.github).trim() });
  if (value.linkedin) rawLinks.push({ label: contactVisibleLabel(value.linkedin), url: String(value.linkedin).trim() });
  if (!rawLinks.length && !location) invalid('payload.contact needs at least one of email, github, linkedin, or location');
  return { name, location, links: contactLinksV3(rawLinks) };
}

function validateResumeV4Payload(payload) {
  exactKeys(payload, ['contact', 'summary', 'experience', 'projects', 'education', 'skills'], 'payload');
  const contact = contactV4(payload.contact);
  return {
    contact,
    summary: optionalTextV3(payload.summary, 'payload.summary'),
    experience: boundedArrayV3(payload.experience, 'payload.experience', { min: 1, max: 12 }).map((entry, index) => {
      const label = `payload.experience[${index}]`;
      exactKeys(entry, ['title', 'org', 'location', 'dates', 'context', 'bullets'], label);
      return {
        title: requiredTextV3(entry.title, `${label}.title`, 200),
        org: requiredTextV3(entry.org, `${label}.org`, 200),
        location: optionalTextV3(entry.location, `${label}.location`, 120),
        dates: requiredTextV3(entry.dates, `${label}.dates`, 100),
        context: optionalTextV3(entry.context, `${label}.context`, 300),
        bullets: textListV3(entry.bullets, `${label}.bullets`, { min: 1, max: 8 })
      };
    }),
    projects: boundedArrayV3(payload.projects, 'payload.projects', { max: 8 }).map((entry, index) => {
      const label = `payload.projects[${index}]`;
      exactKeys(entry, ['name', 'technologies', 'bullets'], label);
      return {
        name: requiredTextV3(entry.name, `${label}.name`, 200),
        technologies: optionalTextV3(entry.technologies, `${label}.technologies`, 300),
        bullets: textListV3(entry.bullets, `${label}.bullets`, { max: 4 })
      };
    }),
    education: boundedArrayV3(payload.education, 'payload.education', { max: 6 }).map((entry, index) => {
      const label = `payload.education[${index}]`;
      exactKeys(entry, ['degree', 'org', 'dates', 'notes'], label);
      return {
        degree: requiredTextV3(entry.degree, `${label}.degree`, 200),
        org: requiredTextV3(entry.org, `${label}.org`, 200),
        dates: requiredTextV3(entry.dates, `${label}.dates`, 100),
        notes: textListV3(entry.notes, `${label}.notes`, { max: 4 })
      };
    }),
    skills: boundedArrayV3(payload.skills, 'payload.skills', { max: 8 }).map((entry, index) => {
      const label = `payload.skills[${index}]`;
      exactKeys(entry, ['group', 'items'], label);
      return {
        group: requiredTextV3(entry.group, `${label}.group`, 80),
        items: textListV3(entry.items, `${label}.items`, { min: 1, max: 30 })
      };
    })
  };
}

const V4_RESUME_PREAMBLE = `\\documentclass[10pt,letterpaper]{article}
\\usepackage[margin=0.63in]{geometry}
\\usepackage[T1]{fontenc}
\\usepackage{charter}
\\usepackage{xcolor}
\\definecolor{jtlink}{rgb}{0.05,0.24,0.52}
\\usepackage[colorlinks=true,urlcolor=jtlink,linkcolor=black,citecolor=black,filecolor=black]{hyperref}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{0pt}
\\raggedright
\\hyphenpenalty=10000
\\exhyphenpenalty=10000
\\pagestyle{empty}
\\newcommand{\\jtsection}[1]{\\par\\vspace{5pt}{\\fontsize{11.5pt}{13pt}\\selectfont\\bfseries #1}\\par\\nobreak\\vspace{1.5pt}\\hrule\\vspace{3pt}\\nobreak}
\\newenvironment{jtitems}
  {\\begin{list}{\\textbullet}{\\setlength{\\leftmargin}{12pt}\\setlength{\\labelwidth}{6pt}\\setlength{\\labelsep}{6pt}\\setlength{\\itemsep}{1pt}\\setlength{\\parsep}{0pt}\\setlength{\\topsep}{2pt}\\setlength{\\partopsep}{0pt}}}
  {\\end{list}}`;

function renderResumeStandardV4(raw) {
  const p = validateResumeV4Payload(raw);
  const separator = ' \\textperiodcentered{} ';
  const contact = [p.contact.location, ...p.contact.links.map((link) => `\\href{${link.url}}{${link.label}}`)].filter(Boolean).join(separator);
  const experience = p.experience.map((entry) => {
    const meta = [entry.dates, entry.location].filter(Boolean).join(separator);
    const head = `\\textbf{${entry.org}} --- ${entry.title}${separator}\\textit{${meta}}\\par\\nopagebreak[3]`;
    return `${head}${entry.context ? `\n${entry.context}\\par\\nopagebreak[3]` : ''}\n${itemizeV3(entry.bullets)}`;
  }).join('\n\\vspace{2pt}\n');
  const projects = p.projects.map((entry) =>
    `\\textbf{${entry.name}}${entry.technologies ? ` --- ${entry.technologies}` : ''}\\par\\nopagebreak[3]${entry.bullets.length ? `\n${itemizeV3(entry.bullets)}` : ''}`
  ).join('\n\\vspace{2pt}\n');
  const education = p.education.map((entry) =>
    `\\textbf{${entry.org}} --- ${entry.degree}${separator}${entry.dates}${entry.notes.length ? `; ${entry.notes.join('; ')}` : ''}\\par`
  ).join('\n');
  const skills = p.skills.map((entry) => `\\textbf{${entry.group}:} ${entry.items.join(', ')}\\par`).join('\n');
  return `${V4_RESUME_PREAMBLE}
\\begin{document}
\\fontsize{10.5pt}{12pt}\\selectfont
{\\fontsize{20pt}{22pt}\\selectfont\\bfseries ${p.contact.name}}\\par\\vspace{2pt}
${contact}\\par
${p.summary ? `\\jtsection{Summary}\n${p.summary}\\par\n` : ''}\\jtsection{Experience}
${experience}
${p.projects.length ? `\\jtsection{Projects}\n${projects}\n` : ''}${p.skills.length ? `\\jtsection{Technical Skills}\n${skills}\n` : ''}${p.education.length ? `\\jtsection{Education}\n${education}\n` : ''}\\end{document}
`;
}

// -------------------------------------------------------------- registry ----

const TEMPLATES = Object.freeze({
  'resume.standard.v1': Object.freeze({
    key: 'resume.standard.v1',
    kind: 'resume',
    description: 'Single-page article resume: name/contact header, optional summary, experience with tight bullets, education, skills line.',
    render: renderResumeStandardV1
  }),
  'cover-letter.standard.v1': Object.freeze({
    key: 'cover-letter.standard.v1',
    kind: 'cover-letter',
    description: 'Business-letter layout: sender block, recipient block, salutation, body paragraphs, closing + signature.',
    render: renderCoverLetterStandardV1
  }),
  'resume.standard.v2': Object.freeze({
    key: 'resume.standard.v2',
    kind: 'resume',
    description: 'One-page Charter resume: ragged-right (no keyword-splitting hyphenation), ruled standard headings, grouped technical skills, experience with location + optional org context, projects, education.',
    render: renderResumeStandardV2
  }),
  'cover-letter.standard.v2': Object.freeze({
    key: 'cover-letter.standard.v2',
    kind: 'cover-letter',
    description: 'Charter business letter: ragged-right, 1in margins, sender/recipient blocks, salutation, body paragraphs, closing + signature.',
    render: renderCoverLetterStandardV2
  }),
  'resume.standard.v3': Object.freeze({
    key: 'resume.standard.v3',
    kind: 'resume',
    description: 'Compact Charter resume: actual 10.5pt body, 0.63in margins, adjacent role/date paragraphs, compact skills and education, optional approved mailto/GitHub/LinkedIn contactLinks. Calibrate 420–470 substantive words on the rendered page.',
    render: renderResumeStandardV3
  }),
  'resume.standard.v4': Object.freeze({
    key: 'resume.standard.v4',
    kind: 'resume',
    description: 'The v3 page with a template-generated header: name and contact block injected by the CLI from the approved profile contact record (never worker-authored), visible link text, clickable links. Payload keys: contact (injected), summary, experience, projects, education, skills.',
    render: renderResumeStandardV4
  })
});

function listMaterialTemplates() {
  return Object.values(TEMPLATES).map((template) => ({
    key: template.key, kind: template.kind, description: template.description
  }));
}

function getMaterialTemplate(key) {
  const template = TEMPLATES[key];
  if (!template) throw new MaterialTemplateError('TEMPLATE_NOT_FOUND', `Unknown material template: ${key}. Known: ${Object.keys(TEMPLATES).join(', ')}`);
  return template;
}

/**
 * Expand a template + payload into deterministic LaTeX.
 * @param {string} key       template key, e.g. 'resume.standard.v1'
 * @param {unknown} payload  structured content (validated hard)
 * @param {string} kind      material kind being drafted — must match
 */
function expandMaterialTemplate(key, payload, kind) {
  const template = getMaterialTemplate(key);
  if (template.kind !== kind) {
    throw new MaterialTemplateError('TEMPLATE_KIND_MISMATCH', `Template ${key} produces ${template.kind}, not ${kind}`);
  }
  return template.render(payload);
}

module.exports = {
  MaterialTemplateError,
  COMPACT_RESUME_TEMPLATES,
  CONTACT_V4_KEYS,
  isCompactResumeTemplate,
  contactVisibleLabel,
  expandMaterialTemplate,
  getMaterialTemplate,
  listMaterialTemplates,
  texEscape
};
