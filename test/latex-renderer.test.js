'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  RENDERER_IMAGE,
  RENDERER_IMAGE_DIGEST,
  RENDERER_PROFILE,
  RENDERER_VERSION,
  PDF_ACTIVE_CONTENT_POLICY,
  MAX_PDF_BYTES,
  LatexRendererError,
  createLatexRenderer
} = require('../lib/latex-renderer');

test('fixed renderer uses an exact networkless container boundary and stores a private PDF', (t) => {
  const fixture = rendererFixture(t);
  const calls = [];
  const renderer = createLatexRenderer({
    expectedImageDigest: `sha256:${'a'.repeat(64)}`,
    runProcess(command, args, options) {
      calls.push({ command, args: [...args], options: { ...options } });
      if (args[0] === 'image') return completed({ stdout: `sha256:${'a'.repeat(64)}\n` });
      emitOutputs(args);
      return completed();
    }
  });
  const source = '\\documentclass{article}\\begin{document}Hello\\end{document}';
  const contentSha256 = digest(source);
  const result = renderer({
    applicationId: 7,
    revisionId: 11,
    materialKind: 'resume',
    content: source,
    contentSha256
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['image', 'inspect', '--format={{.Id}}', RENDERER_IMAGE]);
  const runArgs = calls[1].args;
  for (const flag of [
    '--pull=never', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--cpus=1',
    '--stop-timeout=1', `--ulimit=fsize=${MAX_PDF_BYTES}:${MAX_PDF_BYTES}`
  ]) assert(runArgs.includes(flag), flag);
  assert(runArgs.some((value) => /^--name=jobtrack-latex-[a-f0-9]{32}$/.test(value)));
  assert(runArgs.some((value) => value.startsWith('--cidfile=')));
  assert.equal(runArgs.at(-1), `sha256:${'a'.repeat(64)}`);
  assert.equal(calls[1].options.killSignal, 'SIGKILL');
  assert.equal(runArgs.filter((value) => value.startsWith('--mount=')).length, 2);
  assert(runArgs.some((value) => value.includes('dst=/input,readonly')));
  assert(runArgs.some((value) => value.includes('dst=/output')));
  assert(!runArgs.some((value) => value.includes(fixture.home)), 'the JobTrack store must never be mounted into the renderer');

  assert.equal(result.rendererProfile, RENDERER_PROFILE);
  assert.equal(result.rendererVersion, RENDERER_VERSION);
  assert.equal(result.rendererImageDigest, `sha256:${'a'.repeat(64)}`);
  assert.match(result.outputAttachmentPath, /^attachments\/material-renders\/7\/11\//);
  const absoluteOutput = path.join(fixture.home, result.outputAttachmentPath);
  assert.equal(fs.statSync(absoluteOutput).mode & 0o777, 0o600);
  assert.equal(digest(fs.readFileSync(absoluteOutput)), result.outputSha256);
  assert.equal(result.activeContentPolicy, PDF_ACTIVE_CONTENT_POLICY);
  assert.equal(result.activeContentScanSha256, activeContentScan(result.outputSha256));
  assert.match(result.extractedTextAttachmentPath, /^attachments\/material-renders\/7\/11\/.*\.txt$/);
  const absoluteText = path.join(fixture.home, result.extractedTextAttachmentPath);
  assert.equal(fs.statSync(absoluteText).mode & 0o777, 0o600);
  assert.equal(digest(fs.readFileSync(absoluteText)), result.extractedTextSha256,
    'persisted document.txt must stay verifiable against the recorded text digest');
});

test('renderer rejects extra and symlink outputs before copying any managed attachment', (t) => {
  const fixture = rendererFixture(t);
  for (const mode of ['extra', 'symlink']) {
    const renderer = createLatexRenderer({
      expectedImageDigest: `sha256:${'b'.repeat(64)}`,
      runProcess(_command, args) {
        if (args[0] === 'image') return completed({ stdout: `sha256:${'b'.repeat(64)}\n` });
        emitOutputs(args, mode);
        return completed();
      }
    });
    assert.throws(() => renderer({
      applicationId: 3,
      revisionId: mode === 'extra' ? 4 : 5,
      materialKind: 'cover-letter',
      content: '\\documentclass{article}\\begin{document}Safe\\end{document}',
      contentSha256: digest('\\documentclass{article}\\begin{document}Safe\\end{document}')
    }), (error) => error instanceof LatexRendererError && error.code === 'RENDER_OUTPUT_INVALID');
  }
  const renderRoot = path.join(fixture.home, 'attachments', 'material-renders');
  assert.equal(fs.existsSync(renderRoot), false);
});

test('renderer rejects a symlinked managed parent before any out-of-store write', (t) => {
  const fixture = rendererFixture(t);
  const external = path.join(fixture.root, 'external');
  fs.mkdirSync(external, { mode: 0o700 });
  fs.symlinkSync(external, path.join(fixture.home, 'attachments', 'material-renders'));
  const renderer = createLatexRenderer({
    expectedImageDigest: `sha256:${'b'.repeat(64)}`,
    runProcess(_command, args) {
      if (args[0] === 'image') return completed({ stdout: `sha256:${'b'.repeat(64)}\n` });
      emitOutputs(args);
      return completed();
    }
  });
  const source = '\\documentclass{article}\\begin{document}Safe\\end{document}';
  assert.throws(() => renderer({
    applicationId: 4,
    revisionId: 6,
    materialKind: 'resume',
    content: source,
    contentSha256: digest(source)
  }), (error) => error instanceof LatexRendererError && error.code === 'MANAGED_RENDER_PATH_UNSAFE');
  assert.deepEqual(fs.readdirSync(external), []);
});

test('renderer never pulls a missing image and reports compilation diagnostics only as a bounded failure', (t) => {
  rendererFixture(t);
  const missing = createLatexRenderer({
    runProcess() { return completed({ status: 1, stderr: 'No such image' }); }
  });
  const source = '\\documentclass{article}\\begin{document}Hello\\end{document}';
  assert.throws(() => missing({
    applicationId: 1,
    revisionId: 2,
    materialKind: 'resume',
    content: source,
    contentSha256: digest(source)
  }), (error) => error.code === 'RENDERER_IMAGE_MISSING');

  let calls = 0;
  const replaced = createLatexRenderer({
    runProcess() {
      calls += 1;
      return completed({ stdout: `sha256:${'c'.repeat(64)}\n` });
    }
  });
  assert.throws(() => replaced({
    applicationId: 1,
    revisionId: 3,
    materialKind: 'resume',
    content: source,
    contentSha256: digest(source)
  }), (error) => error.code === 'RENDERER_IMAGE_DIGEST_MISMATCH');
  assert.equal(calls, 1, 'a replaced image must be rejected before docker run');
});

test('timeout, compiler failure, and oversized output leave no managed PDF', (t) => {
  const fixture = rendererFixture(t);
  const source = '\\documentclass{article}\\begin{document}Failure gate\\end{document}';
  const baseInput = {
    applicationId: 8,
    revisionId: 9,
    materialKind: 'resume',
    content: source,
    contentSha256: digest(source)
  };
  const timeoutCalls = [];
  const timeoutContainerId = 'd'.repeat(64);
  const timeout = createLatexRenderer({
    expectedImageDigest: `sha256:${'a'.repeat(64)}`,
    runProcess(_command, args) {
      timeoutCalls.push([...args]);
      if (args[0] === 'image') return completed({ stdout: `sha256:${'a'.repeat(64)}\n` });
      if (args[0] === 'run') {
        const cidFile = args.find((value) => value.startsWith('--cidfile=')).slice('--cidfile='.length);
        fs.writeFileSync(cidFile, `${timeoutContainerId}\n`, { mode: 0o600 });
        return completed({ error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), status: null });
      }
      if (args[0] === 'rm') return completed();
      if (args[0] === 'container' && args[1] === 'inspect') return completed({ status: 1, stderr: 'No such object' });
      throw new Error(`Unexpected renderer cleanup command: ${args.join(' ')}`);
    }
  });
  assert.throws(() => timeout(baseInput), (error) => error.code === 'RENDER_TIMEOUT');
  assert.deepEqual(timeoutCalls.at(-2), ['rm', '--force', timeoutContainerId]);
  assert.deepEqual(timeoutCalls.at(-1), ['container', 'inspect', '--format={{.Id}}', timeoutContainerId]);

  const failedCleanup = createLatexRenderer({
    expectedImageDigest: `sha256:${'a'.repeat(64)}`,
    runProcess(_command, args) {
      if (args[0] === 'image') return completed({ stdout: `sha256:${'a'.repeat(64)}\n` });
      if (args[0] === 'run') return completed({ error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), status: null });
      if (args[0] === 'rm') return completed({ status: 1 });
      if (args[0] === 'container' && args[1] === 'inspect') return completed({ stdout: `${'e'.repeat(64)}\n` });
      throw new Error(`Unexpected renderer cleanup command: ${args.join(' ')}`);
    }
  });
  assert.throws(() => failedCleanup(baseInput), (error) => error.code === 'RENDER_CONTAINER_CLEANUP_FAILED');

  const compilerFailure = createLatexRenderer({
    expectedImageDigest: `sha256:${'a'.repeat(64)}`,
    runProcess(_command, args) {
      if (args[0] === 'image') return completed({ stdout: `sha256:${'a'.repeat(64)}\n` });
      return completed({ status: 1, stderr: `private-source-echo-${'x'.repeat(5000)}` });
    }
  });
  assert.throws(() => compilerFailure(baseInput), (error) => {
    assert.equal(error.code, 'LATEX_COMPILATION_FAILED');
    assert(error.details.diagnostic.length <= 4000);
    return true;
  });

  const oversized = createLatexRenderer({
    expectedImageDigest: `sha256:${'a'.repeat(64)}`,
    runProcess(_command, args) {
      if (args[0] === 'image') return completed({ stdout: `sha256:${'a'.repeat(64)}\n` });
      emitOutputs(args);
      const outputMount = args.find((value) => value.startsWith('--mount=') && value.includes('dst=/output'));
      const outputDir = outputMount.match(/src=([^,]+),dst=\/output/)[1];
      fs.writeFileSync(path.join(outputDir, 'document.pdf'), Buffer.alloc(MAX_PDF_BYTES + 1, 0x20));
      return completed();
    }
  });
  assert.throws(() => oversized(baseInput), (error) => error.code === 'RENDER_OUTPUT_TOO_LARGE');
  assert.equal(fs.existsSync(path.join(fixture.home, 'attachments', 'material-renders')), false);
});

test('opt-in fixed container compiles complete resume and cover-letter fixtures without network access', {
  skip: process.env.JOBTRACK_RUN_LATEX_CONTAINER_TESTS !== '1'
}, (t) => {
  rendererFixture(t);
  const fixtures = [
    { kind: 'resume', revisionId: 902, file: 'safe-links.tex' },
    { kind: 'cover-letter', revisionId: 903, file: 'safe-cover-letter.tex' }
  ];
  for (const fixture of fixtures) {
    const source = fs.readFileSync(path.join(__dirname, 'fixtures', 'latex', fixture.file), 'utf8');
    const result = createLatexRenderer()({
      applicationId: 901,
      revisionId: fixture.revisionId,
      materialKind: fixture.kind,
      content: source,
      contentSha256: digest(source)
    });
    assert.equal(result.rendererProfile, RENDERER_PROFILE);
    assert.equal(result.rendererVersion, RENDERER_VERSION);
    assert.equal(result.rendererImageDigest, RENDERER_IMAGE_DIGEST);
    assert.equal(result.pageCount, 1);
    assert(result.outputBytes > 100);
    assert.equal(digest(fs.readFileSync(path.join(process.env.JOBTRACK_HOME, result.outputAttachmentPath))), result.outputSha256);
  }
});

test('opt-in fixed container rejects active PDF actions and unsafe URI schemes', {
  skip: process.env.JOBTRACK_RUN_LATEX_CONTAINER_TESTS !== '1'
}, (t) => {
  rendererFixture(t);
  const hostileSources = [
    [
      '\\documentclass{article}',
      '\\pdfcatalog{/OpenAction << /S /JavaScript /JS (app.alert(1)) >>}',
      '\\begin{document}Selectable hostile action.\\end{document}'
    ].join('\n'),
    [
      '\\documentclass{article}',
      '\\pdfcatalog{/#4fpenAction << /S /#4aavaScript /JS (app.alert(1)) >>}',
      '\\begin{document}Escaped hostile action.\\end{document}'
    ].join('\n'),
    [
      '\\documentclass{article}',
      '\\begin{document}',
      'Unsafe link \\pdfannot width 12pt height 12pt depth 0pt { /Subtype /Link /A << /S /URI /URI <6a6176617363726970743a616c657274283129> >>}.',
      '\\end{document}'
    ].join('\n'),
    [
      '\\documentclass{article}',
      '\\pdfpagewidth=3000pt',
      '\\pdfpageheight=3000pt',
      '\\begin{document}Oversized page.\\end{document}'
    ].join('\n'),
    [
      '\\documentclass{article}',
      '\\begin{document}',
      'Normal first page.',
      '\\newpage',
      '\\pdfpagewidth=3000pt',
      '\\pdfpageheight=3000pt',
      'Oversized second page.',
      '\\end{document}'
    ].join('\n')
  ];
  hostileSources.forEach((source, index) => {
    assert.throws(() => createLatexRenderer()({
      applicationId: 905,
      revisionId: 906 + index,
      materialKind: 'cover-letter',
      content: source,
      contentSha256: digest(source)
    }), (error) => error.code === 'LATEX_COMPILATION_FAILED');
  });
  assert.equal(fs.existsSync(path.join(process.env.JOBTRACK_HOME, 'attachments', 'material-renders')), false);
});

test('opt-in host timeout forcibly removes the renderer container', {
  skip: process.env.JOBTRACK_RUN_LATEX_CONTAINER_TESTS !== '1'
}, (t) => {
  rendererFixture(t);
  const source = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\newcount\\jobtrackcounter',
    '\\loop\\advance\\jobtrackcounter by 1\\iftrue\\repeat',
    '\\end{document}'
  ].join('\n');
  let containerName;
  assert.throws(() => createLatexRenderer({ timeoutMs: 2_000, runProcess(command, args, options) {
    if (args[0] === 'run') containerName = args.find((arg) => arg.startsWith('--name=')).slice('--name='.length);
    return spawnSync(command, args, options);
  } })({
    applicationId: 903,
    revisionId: 904,
    materialKind: 'cover-letter',
    content: source,
    contentSha256: digest(source)
  }), (error) => error.code === 'RENDER_TIMEOUT');
  assert.match(containerName, /^jobtrack-latex-[a-f0-9]{32}$/);
  const remaining = spawnSync('docker', [
    'ps', '-a', `--filter=name=^/${containerName}$`, '--format={{.Names}}'
  ], { encoding: 'utf8', timeout: 10_000, shell: false });
  assert.equal(remaining.status, 0, remaining.stderr);
  assert.equal(remaining.stdout.trim(), '', 'a timed-out render must not leave a container behind');
});

function rendererFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-latex-renderer-test-'));
  const home = path.join(root, 'store');
  fs.mkdirSync(path.join(home, 'attachments'), { recursive: true, mode: 0o700 });
  const prior = process.env.JOBTRACK_HOME;
  process.env.JOBTRACK_HOME = home;
  t.after(() => {
    if (prior === undefined) delete process.env.JOBTRACK_HOME;
    else process.env.JOBTRACK_HOME = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home };
}

function emitOutputs(args, mode = 'normal') {
  const outputMount = args.find((value) => value.startsWith('--mount=') && value.includes('dst=/output'));
  const source = outputMount.match(/src=([^,]+),dst=\/output/)[1];
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n');
  const extracted = Buffer.from('Hello\n');
  fs.writeFileSync(path.join(source, 'document.pdf'), pdf);
  fs.writeFileSync(path.join(source, 'document.txt'), extracted);
  fs.writeFileSync(path.join(source, 'metadata.json'), JSON.stringify({
    rendererProfile: RENDERER_PROFILE,
    rendererVersion: RENDERER_VERSION,
    pageCount: 1,
    extractedTextSha256: digest(extracted),
    activeContentPolicy: PDF_ACTIVE_CONTENT_POLICY,
    activeContentScanSha256: activeContentScan(digest(pdf))
  }));
  if (mode === 'extra') fs.writeFileSync(path.join(source, 'unexpected.log'), 'private compiler output');
  if (mode === 'symlink') {
    fs.rmSync(path.join(source, 'document.pdf'));
    fs.symlinkSync('/etc/passwd', path.join(source, 'document.pdf'));
  }
}

function completed(overrides = {}) {
  return { status: 0, stdout: '', stderr: '', error: null, ...overrides };
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function activeContentScan(outputSha256) {
  return digest(`${PDF_ACTIVE_CONTENT_POLICY}\n${outputSha256}\nclean\n`);
}
