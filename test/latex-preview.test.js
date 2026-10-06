'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { renderLatexPreview, normalizeForPreview, latexPreviewStylesheet } = require('../lib/latex-preview');

const REALISTIC = `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\setlength{\\parindent}{0pt}
\\pagestyle{empty}
\\newenvironment{tightlist}
  {\\begin{itemize}\\setlength{\\itemsep}{1pt}}
  {\\end{itemize}}
\\begin{document}
{\\LARGE \\textbf{Ada Lovelace}}\\\\
London \\hfill 1843

\\vspace{7pt}\\textbf{Experience}\\\\
\\begin{tightlist}
\\item Wrote the first published algorithm
\\item Analytical Engine notes A through G
\\end{tightlist}
\\end{document}
`;

test('normalizeForPreview inlines simple environments and strips page styling', () => {
  const out = normalizeForPreview(REALISTIC);
  assert.doesNotMatch(out, /newenvironment|tightlist|setlength|pagestyle|vspace|hfill/);
  assert.match(out, /\\begin\{itemize\}/);
  assert.match(out, /first published algorithm/);
});

test('renderLatexPreview typesets a realistic material document', () => {
  const result = renderLatexPreview(REALISTIC);
  assert.equal(result.ok, true, result.reason);
  assert.match(result.html, /Ada Lovelace/);
  // latex.js typesets with ligatures ("fi" -> U+FB01), so match around it.
  assert.match(result.html, /published algorithm/);
  assert.doesNotMatch(result.html, /<script/i, 'preview HTML must never carry scripts');
});

test('renderLatexPreview degrades gracefully and caches by content', () => {
  const bad = renderLatexPreview('\\documentclass{article}\\begin{document}\\undefinedmacro{x}\\end{document}');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /latex\.js could not parse/);
  const first = renderLatexPreview(REALISTIC);
  const second = renderLatexPreview(REALISTIC);
  assert.equal(first, second, 'identical content returns the cached object');
});

test('stylesheet inlines without webfont imports', () => {
  const css = latexPreviewStylesheet();
  assert.doesNotMatch(css, /@import/);
  assert.match(css, /latexjs-preview/);
});
