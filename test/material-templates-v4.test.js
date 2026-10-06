'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  expandMaterialTemplate, getMaterialTemplate, MaterialTemplateError,
  isCompactResumeTemplate, contactVisibleLabel, COMPACT_RESUME_TEMPLATES, CONTACT_V4_KEYS
} = require('../lib/material-templates');

const FIXTURES = path.join(__dirname, 'fixtures', 'material-templates-v4');
const DENSE = require('./fixtures/material-templates-v4/dense-resume.json');
const V3_DENSE = require('./fixtures/material-templates-v3/dense-resume.json');
const expand = (payload = DENSE) => expandMaterialTemplate('resume.standard.v4', payload, 'resume');

test('v4 is the v3 page with a template-generated header, frozen to its golden bytes', () => {
  const latex = expand();
  assert.equal(latex, expand(JSON.parse(JSON.stringify(DENSE))));
  assert.equal(latex, fs.readFileSync(path.join(FIXTURES, 'resume.standard.v4.golden.tex'), 'utf8'), 'v4 identity is fixed');
  assert.equal(getMaterialTemplate('resume.standard.v4').kind, 'resume');
  assert.deepEqual(COMPACT_RESUME_TEMPLATES, ['resume.standard.v3', 'resume.standard.v4']);
  assert.equal(isCompactResumeTemplate('resume.standard.v4'), true);
  assert.equal(isCompactResumeTemplate('resume.standard.v2'), false);
  assert.deepEqual(CONTACT_V4_KEYS, ['name', 'email', 'location', 'github', 'linkedin']);
  // Same page geometry and body as v3.
  assert.match(latex, /\\documentclass\[10pt,letterpaper\]\{article\}/);
  assert.match(latex, /\\fontsize\{10\.5pt\}\{12pt\}\\selectfont/);
  assert.match(latex, /margin=0\.63in/);
  assert.match(latex, /\\raggedright\n\\hyphenpenalty=10000\n\\exhyphenpenalty=10000/);
  assert.doesNotMatch(latex, /\\(?:hfill|begin\{(?:tabular|multicols)|small|footnotesize)/);
  // The body sections are byte-identical to the v3 expansion of the same content.
  const v3 = expandMaterialTemplate('resume.standard.v3', V3_DENSE, 'resume');
  const body = (value) => value.slice(value.indexOf('\\jtsection{'));
  assert.equal(body(latex), body(v3), 'v4 changes only the preamble and header');
  // V3's own bytes are untouched by the v4 addition.
  assert.equal(v3, fs.readFileSync(path.join(__dirname, 'fixtures', 'material-templates-v3', 'resume.standard.v3.golden.tex'), 'utf8'));
});

test('v4 header prints each contact as its visible address with a colored clickable link', () => {
  const latex = expand();
  assert.match(latex, /\\usepackage\{xcolor\}\n\\definecolor\{jtlink\}\{rgb\}\{0\.05,0\.24,0\.52\}\n\\usepackage\[colorlinks=true,urlcolor=jtlink,linkcolor=black,citecolor=black,filecolor=black\]\{hyperref\}/);
  assert.match(latex, /\{\\fontsize\{20pt\}\{22pt\}\\selectfont\\bfseries Alex Example\}\\par/);
  assert.match(latex, /Portland, OR \\textperiodcentered\{\} \\href\{mailto:alex\\_example\+jobs@example\.test\}\{alex\\_example\+jobs@example\.test\} \\textperiodcentered\{\} \\href\{https:\/\/github\.com\/alex-example\}\{github\.com\/alex-example\} \\textperiodcentered\{\} \\href\{https:\/\/www\.linkedin\.com\/in\/alex-example\}\{linkedin\.com\/in\/alex-example\}\\par/);
  assert.equal(contactVisibleLabel('https://www.linkedin.com/in/alex-example/'), 'linkedin.com/in/alex-example');
  assert.equal(contactVisibleLabel('mailto:alex@example.test'), 'alex@example.test');
  assert.equal(contactVisibleLabel('https://github.com/alex-example'), 'github.com/alex-example');
  // Optional pieces: any subset of the links, or location alone, still renders.
  assert.match(expand({ ...DENSE, contact: { ...DENSE.contact, github: null, linkedin: null } }), /Portland, OR \\textperiodcentered\{\} \\href\{mailto:/);
  assert.doesNotMatch(expand({ ...DENSE, contact: { ...DENSE.contact, github: null, linkedin: null } }), /github\.com/);
  assert.match(expand({ ...DENSE, contact: { name: 'Alex Example', email: null, location: 'Portland, OR', github: null, linkedin: null } }), /Portland, OR\\par/);
  assert.throws(() => expand({ ...DENSE, contact: { name: 'Alex Example', email: null, location: null, github: null, linkedin: null } }), /needs at least one/);
});

test('v4 rejects worker-authored headers, unknown keys and the unsafe URI variants v3 rejects', () => {
  for (const key of ['name', 'contactLine', 'contactLinks', 'fontSize', 'preamble', 'layout']) {
    assert.throws(() => expand({ ...DENSE, [key]: 'arbitrary' }), /unknown key/, key);
  }
  assert.throws(() => expand({ ...DENSE, contact: undefined }), /payload\.contact must be the profile contact block/);
  assert.throws(() => expand({ ...DENSE, contact: { ...DENSE.contact, phone: '555-0100' } }), /unknown key "phone"/);
  assert.throws(() => expand({ ...DENSE, contact: { ...DENSE.contact, name: '' } }), MaterialTemplateError);
  for (const url of ['javascript:alert(1)', 'http://github.com/alex', 'https://github.com/alex/repository', 'https://www.linkedin.com/company/example', 'https://github.com/alex\\input{x}']) {
    assert.throws(() => expand({ ...DENSE, contact: { ...DENSE.contact, github: url, linkedin: null } }),
      (error) => error instanceof MaterialTemplateError && error.code === 'TEMPLATE_PAYLOAD_INVALID', url);
  }
  for (const email of ['alex@example.test?subject=Resume', 'alex%0aBcc:other@example.test', 'alex@example.test,other@example.test']) {
    assert.throws(() => expand({ ...DENSE, contact: { ...DENSE.contact, email } }), MaterialTemplateError, email);
  }
  assert.throws(() => expand({ ...DENSE, contact: { ...DENSE.contact, github: 'https://www.linkedin.com/in/alex-example' } }), MaterialTemplateError, 'a LinkedIn URL in the GitHub slot is not a GitHub profile');
});

test('v4 escapes hostile contact text without executable commands', () => {
  const hostile = '\\input{/etc/passwd} \\end{document} & 100% $cash #tag _name ~ ^';
  const latex = expand({ ...DENSE, contact: { ...DENSE.contact, name: hostile, location: hostile } });
  assert.doesNotMatch(latex, /\\input\{/);
  assert.equal((latex.match(/\\end\{document\}/g) || []).length, 1);
  assert.match(latex, /\\textbackslash\{\}input\\\{\/etc\/passwd\\\}/);
});

// Real pinned-renderer smoke for v4 (opt-in, like v3's): one page, the
// visible header text and only the three approved link annotations.
test('v4 dense fixture renders one page with visible addresses and exactly the profile link annotations', {
  skip: process.env.JOBTRACK_RUN_LATEX_CONTAINER_TESTS !== '1'
}, () => {
  const os = require('node:os');
  const crypto = require('node:crypto');
  const { spawnSync } = require('node:child_process');
  const { createLatexRenderer, RENDERER_IMAGE_DIGEST } = require('../lib/latex-renderer');
  const base = path.join(os.homedir(), '.cache', 'jobtrack', 'render-staging');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const temporaryStore = fs.mkdtempSync(path.join(base, 'v4-calibration-test-'));
  const oldStore = process.env.JOBTRACK_HOME;
  process.env.JOBTRACK_HOME = temporaryStore;
  try {
    const content = expand();
    const result = createLatexRenderer()({
      applicationId: 1, revisionId: 1, materialKind: 'resume', content,
      contentSha256: crypto.createHash('sha256').update(content).digest('hex')
    });
    assert.equal(result.pageCount, 1);
    const text = fs.readFileSync(path.join(temporaryStore, result.extractedTextAttachmentPath), 'utf8');
    const flat = text.replace(/\s+/g, ' ');
    assert.ok(flat.startsWith('Alex Example Portland, OR · alex_example+jobs@example.test · github.com/alex-example · linkedin.com/in/alex-example '), flat.slice(0, 160));
    assert.equal(flat.includes('https://'), false, 'URLs are link targets, never visible text');
    const pdf = path.join(temporaryStore, result.outputAttachmentPath);
    const inspect = spawnSync('docker', [
      'run', '--pull=never', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--cpus=1',
      '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m',
      `--mount=type=bind,src=${pdf},dst=/document.pdf,readonly`,
      '--entrypoint', 'qpdf', RENDERER_IMAGE_DIGEST, '--json', '/document.pdf'
    ], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(inspect.status, 0, inspect.stderr);
    const uriValues = [];
    const collect = (value) => {
      if (!value || typeof value !== 'object') return;
      if (value['/URI']) uriValues.push(String(value['/URI']).replace(/^u:/, ''));
      for (const child of Object.values(value)) collect(child);
    };
    collect(JSON.parse(inspect.stdout));
    assert.deepEqual(uriValues.sort(), [`mailto:${DENSE.contact.email}`, DENSE.contact.github, DENSE.contact.linkedin].sort());
  } finally {
    if (oldStore === undefined) delete process.env.JOBTRACK_HOME;
    else process.env.JOBTRACK_HOME = oldStore;
    fs.rmSync(temporaryStore, { recursive: true, force: true });
  }
});
