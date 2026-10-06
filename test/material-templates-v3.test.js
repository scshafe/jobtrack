'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { expandMaterialTemplate, getMaterialTemplate, MaterialTemplateError } = require('../lib/material-templates');

const FIXTURES = path.join(__dirname, 'fixtures', 'material-templates-v3');
const FROZEN_V2 = require('./fixtures/material-templates-v3/frozen-v2-payloads.json');
const DENSE = require('./fixtures/material-templates-v3/dense-resume.json');
const expand = (payload = DENSE) => expandMaterialTemplate('resume.standard.v3', payload, 'resume');

for (const [key, kind, payload] of [
  ['resume.standard.v2', 'resume', FROZEN_V2.resume],
  ['cover-letter.standard.v2', 'cover-letter', FROZEN_V2.coverLetter]
]) {
  test(`${key} retains its bytes captured before v3 existed`, () => {
    assert.equal(expandMaterialTemplate(key, payload, kind), fs.readFileSync(path.join(FIXTURES, `${key}.golden.tex`), 'utf8'));
  });
}

test('v3 has deterministic content-only expansion and an actual 10.5pt font selection', () => {
  const latex = expand();
  assert.equal(latex, expand(JSON.parse(JSON.stringify(DENSE))));
  assert.equal(latex, fs.readFileSync(path.join(FIXTURES, 'resume.standard.v3.golden.tex'), 'utf8'), 'v3 identity is fixed after calibration');
  assert.match(latex, /\\documentclass\[10pt,letterpaper\]\{article\}/);
  assert.match(latex, /\\fontsize\{10\.5pt\}\{12pt\}\\selectfont/);
  assert.match(latex, /margin=0\.63in/);
  assert.match(latex, /\\usepackage\[T1\]\{fontenc\}/);
  assert.match(latex, /\\raggedright\n\\hyphenpenalty=10000\n\\exhyphenpenalty=10000/);
  assert.doesNotMatch(latex, /\\(?:hfill|begin\{(?:tabular|multicols)|small|footnotesize)/);
  assert.match(latex, /\\textbf\{Example Embedded\} --- Software Engineer \\textperiodcentered\{\} \\textit\{Jun 2021 - Jun 2022\}\\par/);
  assert.match(latex, /\\textbf\{Example University\} --- BS, Computer Science \\textperiodcentered\{\} 2019\\par/);
  assert.ok(latex.indexOf('\\jtsection{Experience}') < latex.indexOf('\\jtsection{Technical Skills}'));
  assert.equal(getMaterialTemplate('resume.standard.v3').kind, 'resume');
});

test('v3 links have visible labels and strict mailto/HTTPS profile targets', () => {
  const latex = expand();
  assert.match(latex, /\\href\{mailto:alex\\_example\+jobs@example\.test\}\{alex\\_example\+jobs@example\.test\}/);
  assert.match(latex, /\\href\{https:\/\/github\.com\/alex-example\}\{GitHub: alex-example\}/);
  assert.match(latex, /\\href\{https:\/\/www\.linkedin\.com\/in\/alex-example\}\{LinkedIn: alex-example\}/);
  assert.doesNotThrow(() => expand({ ...DENSE, contactLine: undefined }));
  assert.doesNotThrow(() => expand({ ...DENSE, contactLinks: undefined }));
  assert.doesNotThrow(() => expand(FROZEN_V2.resume), 'v2 content shape remains valid');
  assert.throws(() => expand({ ...DENSE, contactLine: '', contactLinks: [] }), /needs contactLine/);
});

test('v3 rejects unsafe URI variants before they enter LaTeX', () => {
  const unsafe = [
    'javascript:alert(1)', 'file:///etc/passwd', 'tel:1234', 'http://github.com/alex',
    'https://github.com.evil.test/alex', 'https://github.com@evil.test/alex',
    'https://user:password@github.com/alex', 'https://github.com:443/alex',
    'https://github.com/alex?tab=repositories', 'https://github.com/alex#readme',
    'https://github.com/alex/repository', 'https://github.com/%61lex',
    'https://github.com/alex\\input{x}', 'https://github.com/alex\n',
    'https://www.linkedin.com/company/example', 'https://www.linkedin.com/in/alex?trk=resume',
    'mailto:alex@example.test?subject=Resume', 'mailto:alex@example.test#fragment',
    'mailto:alex%0aBcc:other@example.test', 'mailto:alex@example.test,other@example.test',
    'mailto:alex@example.test\r\nBcc:other@example.test', 'mailto:alex{\\input{x}}@example.test',
    'mailto:.alex@example.test', 'mailto:alex..example@example.test', 'mailto:alex@example..test',
    ' mailto:alex@example.test', 'MAILTO:alex@example.test', 'https://github.com/alex%2F..'
  ];
  for (const url of unsafe) {
    assert.throws(() => expand({ ...DENSE, contactLinks: [{ label: 'Contact', url }] }),
      (error) => error instanceof MaterialTemplateError && error.code === 'TEMPLATE_PAYLOAD_INVALID', url);
  }
});

test('v3 rejects unknown fields, malformed nested shapes, controls and layout instructions', () => {
  for (const key of ['fontSize', 'margin', 'preamble', 'template', 'commands', 'layout']) {
    assert.throws(() => expand({ ...DENSE, [key]: 'arbitrary' }), /unknown key/);
  }
  const cases = [
    { ...DENSE, experience: [] },
    { ...DENSE, experience: [{ ...DENSE.experience[0], style: 'tiny' }] },
    { ...DENSE, projects: [{ ...DENSE.projects[0], url: 'https://example.test' }] },
    { ...DENSE, education: [{ ...DENSE.education[0], fontSize: 8 }] },
    { ...DENSE, skills: ['TypeScript'] },
    { ...DENSE, contactLinks: null },
    { ...DENSE, contactLinks: [{ label: 'Email', url: 'mailto:alex@example.test', headers: {} }] },
    { ...DENSE, contactLinks: [{ label: '', url: 'mailto:alex@example.test' }] },
    { ...DENSE, contactLinks: [...DENSE.contactLinks, DENSE.contactLinks[0]] },
    { ...DENSE, contactLinks: [DENSE.contactLinks[0], DENSE.contactLinks[0]] },
    { ...DENSE, name: 'Injected\u0000name' }
  ];
  for (const payload of cases) assert.throws(() => expand(payload), MaterialTemplateError);
});

test('v3 escapes hostile prose and link labels without executable commands', () => {
  const hostile = '\\input{/etc/passwd} \\end{document} & 100% $cash #tag _name ~ ^';
  const latex = expand({ ...DENSE, name: hostile, contactLinks: [{ label: hostile, url: 'mailto:alex@example.test' }] });
  assert.doesNotMatch(latex, /\\input\{/);
  assert.equal((latex.match(/\\end\{document\}/g) || []).length, 1);
  assert.match(latex, /\\textbackslash\{\}input\\\{\/etc\/passwd\\\}/);
  assert.match(latex, /\\& 100\\% \\\$cash \\#tag \\_name \\textasciitilde\{\} \\textasciicircum\{\}/);
});

// This is fabricated calibration content, never professional-source evidence.
// Keep the real renderer opt-in and pinned; no host TeX or new image is used.
test('v3 dense four-role fixture fits one page with complete extraction and safe link annotations', {
  skip: process.env.JOBTRACK_RUN_LATEX_CONTAINER_TESTS !== '1'
}, () => {
  const { createLatexRenderer, RENDERER_IMAGE_DIGEST } = require('../lib/latex-renderer');
  const base = path.join(os.homedir(), '.cache', 'jobtrack', 'render-staging');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const temporaryStore = fs.mkdtempSync(path.join(base, 'v3-calibration-test-'));
  const oldStore = process.env.JOBTRACK_HOME;
  process.env.JOBTRACK_HOME = temporaryStore;
  try {
    const upperTarget = structuredClone(DENSE);
    upperTarget.experience[0].context = 'Freight software for logistics teams managing quotes, manifests, customs documents, and review workflows across many shipments. Engineers work with product and support peers to translate customer constraints into data contracts, migration plans, and operable releases for an existing production service.';
    for (const payload of [DENSE, upperTarget]) {
      const content = expand(payload);
      const result = createLatexRenderer()({
        applicationId: 1, revisionId: 1, materialKind: 'resume', content,
        contentSha256: crypto.createHash('sha256').update(content).digest('hex')
      });
      assert.equal(result.pageCount, 1);
      const text = fs.readFileSync(path.join(temporaryStore, result.extractedTextAttachmentPath), 'utf8');
      const tokens = (value) => value.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word));
      assert.ok(tokens(text).length >= 420 && tokens(text).length <= 470, `measured ${tokens(text).length} words`);
      const checkVisibleText = (value) => {
        if (typeof value === 'string') assert.ok(text.replace(/\s+/g, ' ').includes(value), `missing visible content: ${value}`);
        else if (value && typeof value === 'object') {
          for (const [key, child] of Object.entries(value)) if (key !== 'url') checkVisibleText(child);
        }
      };
      checkVisibleText(payload);
      const pdf = path.join(temporaryStore, result.outputAttachmentPath);
      const inspect = (args) => {
        const result = spawnSync('docker', [
          'run', '--pull=never', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
          '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--cpus=1',
          '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m',
          `--mount=type=bind,src=${pdf},dst=/document.pdf,readonly`,
          '--entrypoint', args[0], RENDERER_IMAGE_DIGEST, ...args.slice(1)
        ], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      assert.deepEqual(tokens(inspect(['pdftotext', '-raw', '/document.pdf', '-'])), tokens(text));
      const objects = JSON.parse(inspect(['qpdf', '--json', '/document.pdf']));
      const uriValues = [];
      const collect = (value) => {
        if (!value || typeof value !== 'object') return;
        if (value['/URI']) uriValues.push(value['/URI'].replace(/^u:/, ''));
        for (const child of Object.values(value)) collect(child);
      };
      collect(objects);
      assert.deepEqual(uriValues.sort(), payload.contactLinks.map((link) => link.url).sort());
      const fontSizes = objects.pages.flatMap((page) => page.contents).flatMap((reference) => {
        const [id, generation] = reference.split(' ');
        const stream = inspect(['qpdf', `--show-object=${id},${generation}`, '--filtered-stream-data', '/document.pdf']);
        return [...stream.matchAll(/\/\w+\s+([\d.]+)\s+Tf\b/g)].map((match) => Number(match[1]));
      });
      // TeX points are 1/72.27 inch; PDF points are 1/72 inch.
      assert.ok(fontSizes.some((size) => Math.abs(size - 10.5 * 72 / 72.27) < 0.001), 'body is physically 10.5 TeX points');
      assert.ok(fontSizes.every((size) => size >= 10.46), `unexpected smaller font: ${fontSizes}`);
    }
  } finally {
    if (oldStore === undefined) delete process.env.JOBTRACK_HOME;
    else process.env.JOBTRACK_HOME = oldStore;
    fs.rmSync(temporaryStore, { recursive: true, force: true });
  }
});
