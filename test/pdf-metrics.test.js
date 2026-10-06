'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPdfMetricsInspector, RENDERER_IMAGE_DIGEST, countWordLikeTokens } = require('../lib/latex-renderer');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
// Match this host's lexical boundary; these paths must never reach filesystem I/O.
const protectedPath = (name) => path.join(os.homedir(), '.openclaw', 'workspace-private-journal', name);
const PDF = Buffer.from('%PDF-1.4\nfixture\n%%EOF');
const LAYOUT = 'Example Person\n• Built café systems — 東京 25+ https://example.test/path\n';
const CONTENT = 'q 1 0 0 1 0 0 cm BT /F1 17.2154 Tf (Example Person) Tj /F2 9.9626 Tf [(Built cafe systems with scoped measurements) -10 (more body words)] TJ ET Q';

function fixture(t, changed = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-pdf-metrics-test-'));
  const filePath = path.join(dir, 'render.pdf'); fs.writeFileSync(filePath, PDF, { mode: 0o600 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const inspector = createPdfMetricsInspector({ runProcess(command, args, options) {
    calls.push({ command, args, options });
    if (args[0] === 'image') return { status: 0, stdout: `${RENDERER_IMAGE_DIGEST}\n` };
    if (changed.error) {
      if (args[0] === 'rm') return { status: 0 };
      if (args[0] === 'container') return { status: 1 };
      return { status: null, error: { code: 'ETIMEDOUT' }, stderr: 'secret failure text' };
    }
    const mount = args.find((arg) => arg.startsWith('--mount=') && arg.endsWith(',dst=/output'));
    const out = mount.slice('--mount=type=bind,src='.length, -',dst=/output'.length);
    const files = {
      'layout.txt': changed.layout ?? LAYOUT,
      'raw.txt': changed.raw ?? LAYOUT,
      'bbox.html': changed.bbox ?? '<html><body><doc><page width="612.000000" height="792.000000"><flow><block><line><word xMin="54.0" yMin="54.0" xMax="150.0" yMax="671.14">Example</word></line></block></flow></page></doc></body></html>',
      'content.txt': changed.content ?? CONTENT
    };
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(out, name), bytes, { mode: 0o600 });
    if (changed.extra) fs.writeFileSync(path.join(out, 'extra.txt'), 'unexpected');
    if (changed.symlink) { fs.unlinkSync(path.join(out, 'raw.txt')); fs.symlinkSync(filePath, path.join(out, 'raw.txt')); }
    return { status: 0, stdout: 'untrusted output must never be returned', stderr: '' };
  } });
  return { filePath, inspector, calls, dir, input: { filePath, expectedOutputSha256: digest(PDF), expectedExtractedTextSha256: digest(changed.layout ?? LAYOUT) } };
}

test('word metrics retain hyphenated words and URLs, excluding punctuation-only tokens', () => {
  assert.equal(countWordLikeTokens('• Built café systems — 東京 25+ https://example.test/path & long-running'), 7);
  assert.equal(countWordLikeTokens(Array.from({ length: 292 }, () => 'word').join(' ') + ' • & |'), 292);
});

test('exact pinned PDF inspector returns only bounded byte-bound measurements', (t) => {
  const f = fixture(t); const metrics = f.inspector(f.input);
  assert.equal(metrics.outputSha256, digest(PDF));
  assert.equal(metrics.extractedTextSha256, digest(LAYOUT));
  assert.equal(metrics.renderedTextLines, 2);
  assert.equal(metrics.bodyFontSizePt, 9.9626);
  assert.equal(metrics.fontMeasurementSupported, true);
  assert.deepEqual(metrics.fontSizeOperatorsPt, [9.9626, 17.2154]);
  assert.equal(metrics.layoutAndRawTokenOrderEqual, true);
  assert.equal(metrics.pages[0].usableBottomWhitespacePt, 66.86);
  assert.equal(metrics.pages[0].blankBelowTextPt, 120.86);
  assert(!JSON.stringify(metrics).includes('Example Person'));
  assert(!JSON.stringify(metrics).includes('untrusted output'));
  const { args, options } = f.calls.find((call) => call.args[0] === 'run');
  for (const flag of ['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--cpus=1']) assert(args.includes(flag), flag);
  assert(args.includes(RENDERER_IMAGE_DIGEST));
  assert.equal(args.filter((arg) => arg.startsWith('--mount=')).length, 2);
  assert(!args.some((arg) => arg.includes(f.dir)), 'the source directory is never mounted');
  assert.equal(options.shell, false);
  assert.equal(options.killSignal, 'SIGKILL');
  const inputMount = args.find((arg) => arg.includes('dst=/input,readonly'));
  assert.equal(fs.existsSync(inputMount.slice('--mount=type=bind,src='.length, -',dst=/input,readonly'.length)), false, 'private staging is removed');
});

test('font measurement ignores quoted fake operators and accounts for transforms', (t) => {
  const f = fixture(t, { content: 'q 2 0 0 2 0 0 cm BT /F1 5.25 Tf (body /Fake 1 Tf here) Tj ET Q' });
  const metrics = f.inspector(f.input);
  assert.equal(metrics.bodyFontSizePt, 10.5);
  assert.deepEqual(metrics.fontSizeOperatorsPt, [5.25]);
});

test('octal escapes and line continuations preserve real text-show byte weights', (t) => {
  const f = fixture(t, { content: 'BT /F1 10.4608 Tf (abcd) Tj /F2 6 Tf (\\123\\123\\\r\n\\\n) Tj ET' });
  const metrics = f.inspector(f.input);
  assert.equal(metrics.bodyFontSizePt, 10.4608);
  assert.deepEqual(metrics.textFontSizes, [{ sizePt: 10.4608, glyphByteWeight: 4 }, { sizePt: 6, glyphByteWeight: 2 }]);
});

test('unvisited forms are not misrepresented as a verified body size', (t) => {
  const f = fixture(t, { content: `${CONTENT}\n/Form1 Do` });
  assert.equal(f.inspector(f.input).bodyFontSizePt, null);
  assert.equal(f.inspector(f.input).fontMeasurementSupported, false);
});

test('raw-order disagreement and clipping remain visible in metrics', (t) => {
  const f = fixture(t, { raw: 'systems Person Example', bbox: '<page width="612" height="792"><word xMin="-2" yMin="54" xMax="80" yMax="800">text</word></page>' });
  const metrics = f.inspector(f.input);
  assert.equal(metrics.layoutAndRawTokenOrderEqual, false);
  assert.equal(metrics.pages[0].textOutsidePage, true);
});

test('bad digest, protected path and symlink input stop before any container launch', (t) => {
  const f = fixture(t);
  assert.throws(() => f.inspector({ ...f.input, expectedOutputSha256: '0'.repeat(64) }), { code: 'INSPECT_DIGEST_MISMATCH' });
  assert.throws(() => f.inspector({ ...f.input, filePath: protectedPath('never-open.pdf') }), { code: 'PRIVATE_JOURNAL_SOURCE_PROHIBITED' });
  const link = path.join(f.dir, 'link.pdf'); fs.symlinkSync(f.filePath, link);
  assert.throws(() => f.inspector({ ...f.input, filePath: link }));
  assert.equal(f.calls.length, 0);
});

test('protected or in-store staging is rejected before any directory creation', (t) => {
  const f = fixture(t); const previous = process.env.JOBTRACK_RENDER_TMPDIR;
  const previousHome = process.env.JOBTRACK_HOME;
  const mkdir = fs.mkdirSync; let creations = 0;
  fs.mkdirSync = (...args) => { creations += 1; return mkdir(...args); };
  try {
    process.env.JOBTRACK_RENDER_TMPDIR = protectedPath('must-not-create');
    assert.throws(() => f.inspector(f.input), { code: 'PRIVATE_JOURNAL_SOURCE_PROHIBITED' });
    process.env.JOBTRACK_HOME = f.dir;
    process.env.JOBTRACK_RENDER_TMPDIR = path.join(f.dir, 'must-not-create');
    assert.throws(() => f.inspector(f.input), { code: 'INSPECT_STAGING_UNSAFE' });
    assert.equal(creations, 0);
    assert.equal(f.calls.length, 0);
  } finally {
    fs.mkdirSync = mkdir;
    if (previous === undefined) delete process.env.JOBTRACK_RENDER_TMPDIR; else process.env.JOBTRACK_RENDER_TMPDIR = previous;
    if (previousHome === undefined) delete process.env.JOBTRACK_HOME; else process.env.JOBTRACK_HOME = previousHome;
  }
});

test('unexpected files, symlink outputs and changed extraction fail closed', (t) => {
  for (const changed of [{ extra: true }, { symlink: true }, { bbox: '<page/>' }]) {
    const f = fixture(t, changed); assert.throws(() => f.inspector(f.input), { code: 'PDF_METRICS_INVALID' });
  }
  const f = fixture(t); assert.throws(() => f.inspector({ ...f.input, expectedExtractedTextSha256: '1'.repeat(64) }), { code: 'INSPECT_TEXT_DIGEST_MISMATCH' });
});

test('timeout cleanup is verified without exposing provider/tool diagnostics', (t) => {
  const f = fixture(t, { error: true });
  assert.throws(() => f.inspector(f.input), (error) => error.code === 'PDF_METRICS_UNAVAILABLE' && !error.message.includes('secret'));
  assert.equal(f.calls.at(-2).args[0], 'rm');
  assert.deepEqual(f.calls.at(-1).args.slice(0, 2), ['container', 'inspect']);
});
