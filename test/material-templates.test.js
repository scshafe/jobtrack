'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { expandMaterialTemplate, listMaterialTemplates, texEscape, MaterialTemplateError } = require('../lib/material-templates');

const RESUME_PAYLOAD = {
  name: 'Ada & Co. Lovelace',
  contactLine: 'London — ada@example.test — 100% analytical',
  summary: 'Engine programmer with $variables and #tags.',
  experience: [
    { title: 'Analyst', org: 'Babbage_Labs', dates: '1842 - 1843', bullets: ['Wrote Note G', 'Modeled loops & branches'] }
  ],
  education: [{ degree: 'Self-taught', org: 'Private tutors', dates: '1830s', notes: [] }],
  skills: ['mathematics', 'poetry']
};

test('resume template expands deterministically with escaped content', () => {
  const first = expandMaterialTemplate('resume.standard.v1', RESUME_PAYLOAD, 'resume');
  const second = expandMaterialTemplate('resume.standard.v1', RESUME_PAYLOAD, 'resume');
  assert.equal(first, second, 'byte-identical expansion');
  assert.match(first, /\\documentclass\[10\.5pt\]\{article\}/);
  assert.match(first, /Ada \\& Co\. Lovelace/, 'ampersand escaped');
  assert.match(first, /100\\% analytical/, 'percent escaped');
  assert.match(first, /\\\$variables and \\#tags/, 'dollar and hash escaped');
  assert.match(first, /Babbage\\_Labs/, 'underscore escaped');
  assert.match(first, /\\item Wrote Note G/);
  assert.doesNotMatch(first, /enumitem/, 'renderer-safe: no enumitem');
});

test('payloads are validated hard: unknown keys, missing keys, kind mismatch', () => {
  assert.throws(() => expandMaterialTemplate('resume.standard.v1', { ...RESUME_PAYLOAD, extra: 1 }, 'resume'), /unknown key "extra"/);
  assert.throws(() => expandMaterialTemplate('resume.standard.v1', { ...RESUME_PAYLOAD, name: '' }, 'resume'), /name is required/);
  assert.throws(() => expandMaterialTemplate('resume.standard.v1', RESUME_PAYLOAD, 'cover-letter'), MaterialTemplateError);
  assert.throws(() => expandMaterialTemplate('nope.v9', RESUME_PAYLOAD, 'resume'), /Unknown material template/);
});

test('cover letter template renders paragraphs and blocks', () => {
  const latex = expandMaterialTemplate('cover-letter.standard.v1', {
    senderName: 'Ada Lovelace',
    senderLines: ['London'],
    recipientLines: ['Hiring Team', 'Babbage Labs'],
    salutation: 'Dear team,',
    paragraphs: ['I am applying for the Analyst role.', 'My Note G work maps directly.'],
    closing: 'Sincerely,'
  }, 'cover-letter');
  assert.match(latex, /Dear team,/);
  assert.match(latex, /Note G work maps directly/);
  assert.match(latex, /Sincerely,\\\\\[8pt\]\nAda Lovelace/);
});

test('payload text cannot inject LaTeX commands', () => {
  const latex = expandMaterialTemplate('cover-letter.standard.v1', {
    senderName: '\\input{/etc/passwd}',
    senderLines: [], recipientLines: [],
    salutation: 'Hi,', paragraphs: ['x'], closing: 'Bye'
  }, 'cover-letter');
  assert.doesNotMatch(latex, /\\input\{/, 'backslash neutralized');
  assert.match(latex, /\\textbackslash\{\}input/);
});

test('registry lists frozen v1/v2 templates and the v3 resume successor', () => {
  const keys = listMaterialTemplates().map((template) => template.key).sort();
  assert.deepEqual(keys, [
    'cover-letter.standard.v1', 'cover-letter.standard.v2',
    'resume.standard.v1', 'resume.standard.v2', 'resume.standard.v3', 'resume.standard.v4'
  ]);
  assert.equal(texEscape('a~b^c'), 'a\\textasciitilde{}b\\textasciicircum{}c');
});

// --------------------------------------------------------------- golden ----
// v1 template identities are FROZEN. These fixtures are the enforcement: any
// change to v1's own code OR to a byte-producing helper it shares would move
// these bytes and fail here. Never regenerate a fixture to make this pass —
// ship a successor template instead.

const GOLDEN_PAYLOADS = require('./fixtures/golden-payloads.json');

for (const [key, kind, fixture] of [
  ['resume.standard.v1', 'resume', 'resume.standard.v1.golden.tex'],
  ['cover-letter.standard.v1', 'cover-letter', 'cover-letter.standard.v1.golden.tex']
]) {
  test(`${key} expands to frozen golden bytes`, () => {
    const payload = kind === 'resume' ? GOLDEN_PAYLOADS.resume : GOLDEN_PAYLOADS.coverLetter;
    const expected = fs.readFileSync(path.join(__dirname, 'fixtures', fixture), 'utf8');
    assert.equal(expandMaterialTemplate(key, payload, kind), expected,
      `${key} is a frozen identity — expansion must not change; ship a successor instead`);
  });
}

// ------------------------------------------------------------------- v2 ----

const RESUME_V2_PAYLOAD = {
  name: 'Ada Lovelace',
  contactLine: 'London — ada@example.test — example.test/ada',
  summary: 'Engine programmer working across analysis & mechanism seams.',
  experience: [
    {
      title: 'Analyst', org: 'Babbage Labs', location: 'London', dates: '1842 - 1843',
      context: 'Mechanical computation research group.',
      bullets: ['Wrote Note G, the first published algorithm', 'Modeled loops & branches']
    }
  ],
  projects: [{ name: 'Note G', technologies: 'Analytical Engine', bullets: ['Bernoulli number generator'] }],
  education: [{ degree: 'Self-taught', org: 'Private tutors', dates: '1830s', notes: ['Mathematics'] }],
  skills: [
    { group: 'Languages', items: ['Analytical notation', 'French'] },
    { group: 'Methods', items: ['Symbolic analysis', 'Mechanism design'] }
  ]
};

test('resume v2 is deterministic and carries the extraction fixes', () => {
  const first = expandMaterialTemplate('resume.standard.v2', RESUME_V2_PAYLOAD, 'resume');
  const second = expandMaterialTemplate('resume.standard.v2', RESUME_V2_PAYLOAD, 'resume');
  assert.equal(first, second, 'byte-identical expansion');

  // Defect 1: justified text split keywords across lines. Ragged-right plus
  // BOTH penalties — hyphenpenalty alone does not stop breaks at explicit
  // hyphens, so "content-addressed" would still split.
  assert.match(first, /\\raggedright/);
  assert.match(first, /\\hyphenpenalty=10000/);
  assert.match(first, /\\exhyphenpenalty=10000/);

  // Defect 2: bullet glyphs must carry a Unicode mapping to survive pdftotext.
  assert.match(first, /\\usepackage\[T1\]\{fontenc\}/);

  assert.match(first, /\\usepackage\{charter\}/, 'Charter body face');
  assert.match(first, /margin=0\.75in/);
  assert.match(first, /letterpaper/);
  assert.match(first, /\\jtsection\{Technical Skills\}/, 'standard heading');
  assert.match(first, /\\textbf\{Languages:\} Analytical notation, French/, 'grouped skills');
  assert.match(first, /\\jtsection\{Projects\}/);

  // Defect 3: `\hfill` pushed dates far enough right that pdftotext emitted
  // them as their own block behind a blank line ("isolated dates"). Dates now
  // ride an adjacent meta line, contiguous in every extraction mode.
  assert.doesNotMatch(first, /\\hfill/, 'no fill gaps — they detach dates in extraction');
  assert.match(first, /\\textbf\{Babbage Labs\} --- Analyst\\\\\n\\textit\{London \\textperiodcentered\{\} 1842 - 1843\}/,
    'role line followed immediately by location + dates');

  // Section headings must open in vertical mode, or they glue onto the tail of
  // the preceding paragraph in extraction ("Next.js Experience").
  assert.match(first, /\\newcommand\{\\jtsection\}\[1\]\{\\par/, 'heading macro breaks the paragraph first');

  assert.match(first, /Mechanical computation research group\./, 'org context');
  assert.doesNotMatch(first, /enumitem/, 'renderer-safe');
  assert.doesNotMatch(first, /hyperref/, 'plain-text URLs are the extraction-safe choice');
});

test('resume v2 rejects v1-shaped payloads and validates its own shape', () => {
  // v1's flat skills list is not a v2 payload — shapes are validated hard.
  assert.throws(() => expandMaterialTemplate('resume.standard.v2',
    { ...RESUME_V2_PAYLOAD, skills: ['flat', 'list'] }, 'resume'), /payload\.skills\[0\] must be an object/);
  assert.throws(() => expandMaterialTemplate('resume.standard.v2',
    { ...RESUME_V2_PAYLOAD, projects: undefined, extra: 1 }, 'resume'), /unknown key "extra"/);
  assert.throws(() => expandMaterialTemplate('resume.standard.v2',
    { ...RESUME_V2_PAYLOAD, experience: [] }, 'resume'), /payload\.experience needs at least 1/);
  assert.throws(() => expandMaterialTemplate('resume.standard.v2', RESUME_V2_PAYLOAD, 'cover-letter'), MaterialTemplateError);
});

test('v2 escaping is independent of v1 and still blocks injection', () => {
  const latex = expandMaterialTemplate('resume.standard.v2', {
    ...RESUME_V2_PAYLOAD, name: '\\input{/etc/passwd} & Co. 100%'
  }, 'resume');
  assert.doesNotMatch(latex, /\\input\{/, 'backslash neutralized');
  assert.match(latex, /\\textbackslash\{\}input/);
  assert.match(latex, /\\& Co\. 100\\%/);
});

test('cover letter v2 carries the same typography pass', () => {
  const latex = expandMaterialTemplate('cover-letter.standard.v2', GOLDEN_PAYLOADS.coverLetter, 'cover-letter');
  assert.match(latex, /\\usepackage\{charter\}/);
  assert.match(latex, /\\raggedright/);
  assert.match(latex, /\\exhyphenpenalty=10000/);
  assert.match(latex, /Dear team,/);
});
