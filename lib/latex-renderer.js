'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertPathNotPrivateJournalSource, pathIsInside, realpathIncludingMissing } = require('./private-source-boundary');

const RENDERER_PROFILE = 'jobtrack-latex-pdf-v1';
const RENDERER_VERSION = 'jobtrack-texlive-2026.2';
const PDF_ACTIVE_CONTENT_POLICY = 'jobtrack-pdf-active-content.v1';
// Successor pin (2026-08-04): the v0.6.0-era image (sha256:4dc5211b…) was lost
// from the local Docker store; this image is the v0.6.1 rebuild from the
// in-repo Dockerfile. A rebuilt image can never reproduce the old ID, so the
// pin moves forward with the rebuild — never edit the old release record.
const RENDERER_IMAGE = 'jobtrack-latex-renderer:v0.6.1';
const RENDERER_IMAGE_DIGEST = 'sha256:dcdeb86662ea2487d1aba825564e4d95d538c44c4edddc31ba6cb4cd078a82ed';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 16 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 45_000;

/**
 * Staging root for render inputs/outputs.
 *
 * These directories are bind-mounted into the container, so they must live
 * somewhere the container runtime can actually see. On this host Docker is
 * colima, which shares only `$HOME` into its VM — `os.tmpdir()` resolves to
 * `/var/folders/…`, which materializes INSIDE the container as an EMPTY
 * directory, so `render.sh` cannot find its input and the render dies with a
 * confusing compilation failure rather than a mount error. Callers previously
 * had to know to export `TMPDIR`; getting that wrong looked like a LaTeX bug.
 *
 * The staging root must satisfy two constraints at once:
 *   1. shared with the container runtime — hence under `$HOME`, not `/var`;
 *   2. OUTSIDE the JobTrack store — the store is never mounted into the
 *      renderer, and staging under `$JOBTRACK_HOME` would smuggle it in
 *      through the bind source.
 *
 * `JOBTRACK_RENDER_TMPDIR` overrides for hosts where `$HOME` is not shared.
 */
function stagingRootPath() {
  const override = process.env.JOBTRACK_RENDER_TMPDIR;
  return override
    ? path.resolve(override)
    : path.join(os.homedir(), '.cache', 'jobtrack', 'render-staging');
}

function stagingRoot() {
  const root = stagingRootPath();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

class LatexRendererError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'LatexRendererError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function createLatexRenderer(options = {}) {
  const run = options.runProcess || spawnSync;
  const registerCreatedFile = typeof options.registerCreatedFile === 'function'
    ? options.registerCreatedFile
    : () => {};
  const dockerBinary = options.dockerBinary || 'docker';
  const image = RENDERER_IMAGE;
  const expectedImageDigest = options.expectedImageDigest || RENDERER_IMAGE_DIGEST;
  const timeoutMs = options.timeoutMs || RENDER_TIMEOUT_MS;

  return function renderLatexMaterial(input) {
    const applicationId = positiveInteger(input.applicationId, 'application id');
    const revisionId = positiveInteger(input.revisionId, 'revision id');
    const materialKind = String(input.materialKind || '');
    if (!['resume', 'cover-letter'].includes(materialKind)) {
      throw new LatexRendererError('INVALID_MATERIAL_KIND', 'Only resume and cover-letter LaTeX documents can be rendered');
    }
    const content = String(input.content ?? '');
    const sourceBytes = Buffer.byteLength(content, 'utf8');
    if (!sourceBytes || sourceBytes > MAX_SOURCE_BYTES) {
      throw new LatexRendererError('SOURCE_SIZE_INVALID', `LaTeX source must contain 1 to ${MAX_SOURCE_BYTES} bytes`);
    }
    const contentSha256 = sha256(Buffer.from(content, 'utf8'));
    if (input.contentSha256 !== contentSha256) {
      throw new LatexRendererError('SOURCE_DIGEST_MISMATCH', 'LaTeX source does not match the immutable material digest');
    }

    const imageDigest = inspectImage(run, dockerBinary, image, expectedImageDigest, timeoutMs);
    const staging = fs.mkdtempSync(path.join(stagingRoot(), 'jobtrack-latex-render-'));
    const inputDir = path.join(staging, 'input');
    const outputDir = path.join(staging, 'output');
    fs.mkdirSync(inputDir, { mode: 0o700 });
    fs.mkdirSync(outputDir, { mode: 0o700 });
    fs.writeFileSync(path.join(inputDir, 'document.tex'), content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 65532;
      const gid = typeof process.getgid === 'function' ? process.getgid() : 65532;
      const containerName = `jobtrack-latex-${crypto.randomBytes(16).toString('hex')}`;
      const cidFile = path.join(staging, 'container.cid');
      const args = [
        'run', '--pull=never', '--rm',
        `--name=${containerName}`, `--cidfile=${cidFile}`, '--stop-timeout=1',
        '--network=none', '--read-only', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--pids-limit=64',
        '--memory=512m', '--cpus=1', `--user=${uid}:${gid}`,
        `--ulimit=fsize=${MAX_PDF_BYTES}:${MAX_PDF_BYTES}`,
        '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m',
        '--env=HOME=/tmp/home', '--env=TEXMFVAR=/tmp/texmf-var',
        `--mount=type=bind,src=${inputDir},dst=/input,readonly`,
        `--mount=type=bind,src=${outputDir},dst=/output`,
        imageDigest
      ];
      const completed = run(dockerBinary, args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
        killSignal: 'SIGKILL',
        windowsHide: true,
        shell: false
      });
      if (completed.error) {
        if (completed.error.code === 'ETIMEDOUT') {
          assertContainerRemoved(run, dockerBinary, containerName, cidFile);
          throw new LatexRendererError('RENDER_TIMEOUT', `LaTeX rendering exceeded ${timeoutMs} milliseconds`);
        }
        // Buffer exhaustion and client-side process failures can also terminate the
        // Docker client while leaving its container alive. Treat cleanup as part of
        // the renderer's security boundary before reporting the host-side failure.
        assertContainerRemoved(run, dockerBinary, containerName, cidFile);
        throw new LatexRendererError('RENDERER_UNAVAILABLE', 'The fixed Docker LaTeX renderer could not be started');
      }
      if (completed.status !== 0) {
        throw new LatexRendererError(
          'LATEX_COMPILATION_FAILED',
          'The fixed LaTeX renderer rejected the document',
          { diagnostic: boundedDiagnostic(completed.stderr || completed.stdout) }
        );
      }

      const expected = ['document.pdf', 'document.txt', 'metadata.json'];
      const outputs = fs.readdirSync(outputDir).sort();
      if (JSON.stringify(outputs) !== JSON.stringify(expected)) {
        throw new LatexRendererError('RENDER_OUTPUT_INVALID', 'Renderer produced an unexpected output set');
      }
      for (const name of expected) {
        const stat = fs.lstatSync(path.join(outputDir, name));
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new LatexRendererError('RENDER_OUTPUT_INVALID', `Renderer output ${name} is not a regular file`);
        }
      }
      const pdfPath = path.join(outputDir, 'document.pdf');
      const textPath = path.join(outputDir, 'document.txt');
      const metadataPath = path.join(outputDir, 'metadata.json');
      const pdfStat = fs.statSync(pdfPath);
      const textStat = fs.statSync(textPath);
      const metadataStat = fs.statSync(metadataPath);
      if (!pdfStat.size || pdfStat.size > MAX_PDF_BYTES) {
        throw new LatexRendererError('RENDER_OUTPUT_TOO_LARGE', `Rendered PDF must contain 1 to ${MAX_PDF_BYTES} bytes`);
      }
      if (!textStat.size || textStat.size > MAX_EXTRACTED_TEXT_BYTES) {
        throw new LatexRendererError('RENDER_OUTPUT_INVALID', 'Rendered PDF text extraction has an invalid size');
      }
      if (!metadataStat.size || metadataStat.size > MAX_METADATA_BYTES) {
        throw new LatexRendererError('RENDER_OUTPUT_INVALID', 'Renderer metadata has an invalid size');
      }
      const pdf = fs.readFileSync(pdfPath);
      if (pdf.subarray(0, 5).toString('ascii') !== '%PDF-' || !pdf.subarray(Math.max(0, pdf.length - 2048)).includes(Buffer.from('%%EOF'))) {
        throw new LatexRendererError('RENDER_OUTPUT_INVALID', 'Renderer output is not a structurally recognizable PDF');
      }
      const extractedText = fs.readFileSync(textPath);
      if (!extractedText.length) {
        throw new LatexRendererError('RENDER_OUTPUT_INVALID', 'Rendered PDF has no extractable text');
      }
      const metadata = readMetadata(metadataPath);
      if (metadata.rendererProfile !== RENDERER_PROFILE || metadata.rendererVersion !== RENDERER_VERSION) {
        throw new LatexRendererError('RENDERER_PROFILE_MISMATCH', 'Renderer metadata does not match the fixed release profile');
      }
      const pageCount = positiveInteger(metadata.pageCount, 'PDF page count');
      if (pageCount > 20) throw new LatexRendererError('RENDER_OUTPUT_INVALID', 'Rendered PDF exceeds 20 pages');
      const extractedTextSha256 = sha256(extractedText);
      if (metadata.extractedTextSha256 !== extractedTextSha256) {
        throw new LatexRendererError('RENDER_OUTPUT_INVALID', 'Renderer text digest does not match the extracted output');
      }
      const outputSha256 = sha256(pdf);
      if (metadata.activeContentPolicy !== PDF_ACTIVE_CONTENT_POLICY
        || metadata.activeContentScanSha256 !== activeContentScanSha256(outputSha256)) {
        throw new LatexRendererError('RENDER_OUTPUT_ACTIVE_CONTENT_SCAN_INVALID', 'Renderer active-content scan is missing or does not match the PDF bytes');
      }
      const managedPath = persistPdf({
        pdf,
        applicationId,
        revisionId,
        contentSha256,
        outputSha256,
        registerCreatedFile
      });
      // The container already produced document.txt and its digest is verified
      // above; persisting the bytes beside the PDF is what makes the lint gate
      // (plan §3.1) run host-side without another container spin-up, and the
      // stored file stays verifiable against extracted_text_sha256 forever.
      const managedTextPath = persistExtractedText({
        text: extractedText,
        extractedTextSha256,
        applicationId,
        revisionId,
        contentSha256,
        outputSha256,
        registerCreatedFile
      });
      return {
        rendererProfile: RENDERER_PROFILE,
        rendererImageDigest: imageDigest,
        rendererVersion: RENDERER_VERSION,
        bundleSha256: sha256(Buffer.from(stableJson({
          rendererProfile: RENDERER_PROFILE,
          rendererVersion: RENDERER_VERSION,
          imageDigest,
          activeContentPolicy: PDF_ACTIVE_CONTENT_POLICY
        }))),
        outputAttachmentPath: managedPath,
        extractedTextAttachmentPath: managedTextPath,
        outputSha256,
        outputBytes: pdf.length,
        pageCount,
        extractedTextSha256,
        activeContentPolicy: metadata.activeContentPolicy,
        activeContentScanSha256: metadata.activeContentScanSha256
      };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  };
}

function assertContainerRemoved(run, dockerBinary, containerName, cidFile) {
  const target = readContainerId(cidFile) || containerName;
  run(dockerBinary, ['rm', '--force', target], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    shell: false
  });
  const inspected = run(dockerBinary, ['container', 'inspect', '--format={{.Id}}', target], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    shell: false
  });
  if (inspected.error || inspected.status === 0) {
    throw new LatexRendererError(
      'RENDER_CONTAINER_CLEANUP_FAILED',
      'Timed-out LaTeX renderer container could not be proven stopped and removed'
    );
  }
}

function readContainerId(cidFile) {
  if (!fs.existsSync(cidFile)) return null;
  const stat = fs.lstatSync(cidFile);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 12 || stat.size > 128) {
    throw new LatexRendererError('RENDER_CONTAINER_CLEANUP_FAILED', 'Renderer container ID file is invalid');
  }
  const id = fs.readFileSync(cidFile, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(id)) {
    throw new LatexRendererError('RENDER_CONTAINER_CLEANUP_FAILED', 'Renderer container ID is invalid');
  }
  return id;
}

function inspectImage(run, dockerBinary, image, expectedImageDigest, timeoutMs) {
  const inspected = run(dockerBinary, ['image', 'inspect', '--format={{.Id}}', image], {
    encoding: 'utf8',
    timeout: Math.min(timeoutMs, 10_000),
    maxBuffer: 64 * 1024,
    windowsHide: true,
    shell: false
  });
  if (inspected.error || inspected.status !== 0) {
    throw new LatexRendererError(
      'RENDERER_IMAGE_MISSING',
      `Fixed renderer image ${image} is not installed; build it explicitly before rendering`
    );
  }
  const digest = String(inspected.stdout || '').trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new LatexRendererError('RENDERER_IMAGE_INVALID', 'Docker returned an invalid renderer image digest');
  }
  if (digest !== expectedImageDigest) {
    throw new LatexRendererError(
      'RENDERER_IMAGE_DIGEST_MISMATCH',
      `Fixed renderer image ${image} does not match the release-pinned digest`
    );
  }
  return digest;
}

function persistPdf(input) {
  const storeRoot = path.resolve(process.env.JOBTRACK_HOME || path.join(os.homedir(), '.jobtrack'));
  let realStoreRoot;
  try {
    realStoreRoot = fs.realpathSync(storeRoot);
  } catch {
    throw new LatexRendererError('MANAGED_RENDER_PATH_UNSAFE', 'JobTrack store root is missing or inaccessible');
  }
  const relativeDirectory = path.join(
    'attachments',
    'material-renders',
    String(input.applicationId),
    String(input.revisionId)
  );
  const directory = ensurePrivateDirectoryTree(realStoreRoot, [
    'attachments', 'material-renders', String(input.applicationId), String(input.revisionId)
  ]);
  const filename = `${input.contentSha256.slice(0, 16)}-${input.outputSha256.slice(0, 16)}.pdf`;
  const destination = path.join(directory, filename);
  try {
    fs.writeFileSync(destination, input.pdf, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(destination, 0o600);
    input.registerCreatedFile(destination);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(destination);
    const realDestination = fs.realpathSync(destination);
    const relative = path.relative(directory, realDestination);
    if (stat.isSymbolicLink() || !stat.isFile() || relative === '..'
      || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new LatexRendererError('MANAGED_RENDER_PATH_UNSAFE', 'Managed render collision is not a regular in-store file');
    }
    const existing = fs.readFileSync(destination);
    if (sha256(existing) !== input.outputSha256) {
      throw new LatexRendererError('RENDER_OUTPUT_COLLISION', 'Managed render path already contains different bytes');
    }
  }
  return path.join(relativeDirectory, filename).split(path.sep).join('/');
}

/** Persist the renderer's extracted text beside its PDF, same naming scheme
 * with a `.txt` suffix, same EEXIST byte-identity semantics. */
function persistExtractedText(input) {
  const storeRoot = path.resolve(process.env.JOBTRACK_HOME || path.join(os.homedir(), '.jobtrack'));
  let realStoreRoot;
  try {
    realStoreRoot = fs.realpathSync(storeRoot);
  } catch {
    throw new LatexRendererError('MANAGED_RENDER_PATH_UNSAFE', 'JobTrack store root is missing or inaccessible');
  }
  const relativeDirectory = path.join(
    'attachments',
    'material-renders',
    String(input.applicationId),
    String(input.revisionId)
  );
  const directory = ensurePrivateDirectoryTree(realStoreRoot, [
    'attachments', 'material-renders', String(input.applicationId), String(input.revisionId)
  ]);
  const filename = `${input.contentSha256.slice(0, 16)}-${input.outputSha256.slice(0, 16)}.txt`;
  const destination = path.join(directory, filename);
  try {
    fs.writeFileSync(destination, input.text, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(destination, 0o600);
    input.registerCreatedFile(destination);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(destination);
    const realDestination = fs.realpathSync(destination);
    const relative = path.relative(directory, realDestination);
    if (stat.isSymbolicLink() || !stat.isFile() || relative === '..'
      || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new LatexRendererError('MANAGED_RENDER_PATH_UNSAFE', 'Managed render text collision is not a regular in-store file');
    }
    const existing = fs.readFileSync(destination);
    if (sha256(existing) !== input.extractedTextSha256) {
      throw new LatexRendererError('RENDER_OUTPUT_COLLISION', 'Managed render text path already contains different bytes');
    }
  }
  return path.join(relativeDirectory, filename).split(path.sep).join('/');
}

function ensurePrivateDirectoryTree(realStoreRoot, segments) {
  let current = realStoreRoot;
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new LatexRendererError('MANAGED_RENDER_PATH_UNSAFE', 'Managed render parent must be a real directory');
    }
    const realCandidate = fs.realpathSync(candidate);
    const relative = path.relative(realStoreRoot, realCandidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new LatexRendererError('MANAGED_RENDER_PATH_UNSAFE', 'Managed render parent escaped the JobTrack store');
    }
    fs.chmodSync(realCandidate, 0o700);
    current = realCandidate;
  }
  return current;
}

function readMetadata(filename) {
  let value;
  try { value = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new LatexRendererError('RENDER_OUTPUT_INVALID', 'Renderer metadata is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LatexRendererError('RENDER_OUTPUT_INVALID', 'Renderer metadata must be an object');
  }
  const allowed = new Set([
    'rendererProfile', 'rendererVersion', 'pageCount', 'extractedTextSha256',
    'activeContentPolicy', 'activeContentScanSha256'
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length || Object.keys(value).length !== allowed.size) {
    throw new LatexRendererError('RENDER_OUTPUT_INVALID', 'Renderer metadata has an unexpected shape');
  }
  if (!/^[a-f0-9]{64}$/.test(String(value.extractedTextSha256 || ''))) {
    throw new LatexRendererError('RENDER_OUTPUT_INVALID', 'Renderer metadata has an invalid text digest');
  }
  if (value.activeContentPolicy !== PDF_ACTIVE_CONTENT_POLICY
    || !/^[a-f0-9]{64}$/.test(String(value.activeContentScanSha256 || ''))) {
    throw new LatexRendererError('RENDER_OUTPUT_ACTIVE_CONTENT_SCAN_INVALID', 'Renderer metadata has an invalid active-content scan result');
  }
  return value;
}

function activeContentScanSha256(outputSha256) {
  return sha256(Buffer.from(`${PDF_ACTIVE_CONTENT_POLICY}\n${outputSha256}\nclean\n`, 'utf8'));
}

function boundedDiagnostic(value) {
  const text = String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return text.slice(-4000);
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new LatexRendererError('INVALID_ARGUMENT', `${label} must be a positive integer`);
  }
  return number;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

/**
 * Structurally inspect a PDF that is ABOUT TO BE UPLOADED, using the same
 * pinned, networkless image the renderer uses.
 *
 * Why this exists: `render.sh` already runs `qpdf --check` at render time, so a
 * lane-produced PDF is known-good when it is written. The failure this guards
 * is what happens AFTER — the applysim drill r2608050256bb3f uploaded a resume
 * whose object streams were destroyed in transit (poppler could not find the
 * trailer dictionary and extracted zero characters) while its sibling cover
 * letter arrived intact. A hash comparison catches that too, but only when an
 * expected hash exists; this catches an unreadable file on its own terms.
 *
 * Read-only bind, no network, dropped capabilities — same posture as a render.
 */
function createPdfStructureInspector(options = {}) {
  const run = options.runProcess || spawnSync;
  const dockerBinary = options.dockerBinary || 'docker';
  const expectedImageDigest = options.expectedImageDigest || RENDERER_IMAGE_DIGEST;
  const timeoutMs = options.timeoutMs || RENDER_TIMEOUT_MS;

  return function inspectPdfStructure(filePath) {
    const resolved = path.resolve(filePath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new LatexRendererError('INSPECT_TARGET_INVALID', 'Only a regular file can be inspected');
    if (!stat.size || stat.size > MAX_PDF_BYTES) {
      return { status: 'fail', detail: `File size ${stat.size} is outside 1..${MAX_PDF_BYTES} bytes`, pageCount: null };
    }

    const imageDigest = inspectImage(run, dockerBinary, RENDERER_IMAGE, expectedImageDigest, timeoutMs);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 65532;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 65532;
    const containerName = `jobtrack-pdfcheck-${crypto.randomBytes(16).toString('hex')}`;
    const staging = fs.mkdtempSync(path.join(stagingRoot(), 'jobtrack-pdf-inspect-'));
    const inputDir = path.join(staging, 'input');
    fs.mkdirSync(inputDir, { mode: 0o700 });
    // Copy in rather than binding the caller's directory: the inspection must
    // never expose a whole staging tree to the container.
    fs.copyFileSync(resolved, path.join(inputDir, 'document.pdf'));

    try {
      const args = [
        'run', '--pull=never', '--rm',
        `--name=${containerName}`, '--stop-timeout=1',
        '--network=none', '--read-only', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--pids-limit=64',
        '--memory=512m', '--cpus=1', `--user=${uid}:${gid}`,
        '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m',
        '--env=HOME=/tmp/home',
        `--mount=type=bind,src=${inputDir},dst=/input,readonly`,
        '--entrypoint=sh',
        imageDigest,
        '-c',
        'qpdf --check /input/document.pdf >/tmp/check.txt 2>&1; qpdf_status=$?; '
        + 'pages=$(pdfinfo /input/document.pdf 2>/dev/null | awk -F: \'/^Pages:/ { gsub(/ /, "", $2); print $2 }\'); '
        + 'chars=$(pdftotext /input/document.pdf - 2>/dev/null | tr -d "[:space:]" | wc -c); '
        + 'echo "qpdf_status=$qpdf_status"; echo "pages=$pages"; echo "chars=$chars"; '
        + 'echo "--- qpdf ---"; head -c 4000 /tmp/check.txt'
      ];
      const completed = run(dockerBinary, args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
        killSignal: 'SIGKILL',
        windowsHide: true,
        shell: false
      });
      if (completed.error || completed.status !== 0) {
        assertContainerRemoved(run, dockerBinary, containerName, path.join(staging, 'missing.cid'));
        throw new LatexRendererError('INSPECTOR_UNAVAILABLE', 'The pinned PDF inspector could not be run');
      }
      const stdout = String(completed.stdout || '');
      const field = (name) => {
        const match = new RegExp(`^${name}=(.*)$`, 'm').exec(stdout);
        return match ? match[1].trim() : '';
      };
      const qpdfStatus = Number(field('qpdf_status'));
      const pageCount = Number(field('pages')) || null;
      const textChars = Number(field('chars')) || 0;
      const diagnostic = boundedDiagnostic(stdout);
      if (qpdfStatus !== 0) {
        return { status: 'fail', detail: `qpdf --check exited ${qpdfStatus}`, pageCount, textChars, diagnostic };
      }
      if (!pageCount) return { status: 'fail', detail: 'PDF reports no pages', pageCount, textChars, diagnostic };
      // A resume that extracts nothing is the exact drill failure, and it is
      // also the ATS failure — a parser receives an empty document.
      if (!textChars) return { status: 'fail', detail: 'No text could be extracted from the PDF', pageCount, textChars, diagnostic };
      return { status: 'pass', detail: null, pageCount, textChars, diagnostic: null };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  };
}

const PDF_METRICS_VERSION = 'jobtrack-pdf-metrics.v1';
const MAX_METRIC_FILE_BYTES = 8 * 1024 * 1024;

/** The review's counting rule: punctuation-only whitespace tokens are not words. */
function countWordLikeTokens(text) {
  return String(text).split(/\s+/u).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

// No caller text or paths are interpolated into this fixed inspection program.
const PDF_METRICS_COMMAND = [
  'set -eu',
  'qpdf --check /input/document.pdf >/tmp/check.txt 2>&1',
  'pdftotext -layout /input/document.pdf /output/layout.txt',
  'pdftotext -raw /input/document.pdf /output/raw.txt',
  'pdftotext -bbox-layout /input/document.pdf /output/bbox.html',
  'qpdf --json --json-stream-data=none /input/document.pdf >/tmp/document.json',
  'jq -er \'.pages | length | select(. >= 1 and . <= 20)\' /tmp/document.json >/dev/null',
  'jq -r \'.pages[].contents[] | capture("^(?<id>[0-9]+) (?<generation>[0-9]+) R$") | "\\(.id),\\(.generation)"\' /tmp/document.json >/tmp/streams',
  ': >/output/content.txt',
  'while IFS= read -r stream; do case "$stream" in *[!0-9,]*|,*|*,|\'\') exit 1;; esac; qpdf --show-object="$stream" --filtered-stream-data /input/document.pdf >>/output/content.txt; printf "\\n" >>/output/content.txt; done </tmp/streams',
  'chmod 0600 /output/*'
].join('\n');

function metricFailure() {
  throw new LatexRendererError('PDF_METRICS_INVALID', 'Pinned PDF inspection returned invalid or unsupported measurements');
}

function metricNumber(value, min = 0, max = 2000) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) metricFailure();
  return number;
}

function rounded(value) { return Math.round(value * 10000) / 10000; }

/** Parse only qpdf-decoded page content, never font/image streams. Strings and
 * comments are skipped, so prose containing PDF operators cannot forge metrics.
 * Font size is the dominant text-show size after page/text matrix transforms,
 * weighted by encoded glyph bytes. Forms/inline images are reported unsupported,
 * not silently measured as if their unvisited text did not exist. */
function measureTextFonts(content) {
  const tokens = [];
  for (let i = 0; i < content.length;) {
    const c = content[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '%') { while (i < content.length && !/[\r\n]/.test(content[i])) i += 1; continue; }
    if (c === '(') {
      let depth = 1; let bytes = 0; i += 1;
      while (i < content.length && depth) {
        const next = content[i++];
        if (next === '\\') {
          if (i < content.length && /[0-7]/.test(content[i])) {
            let octal = 0;
            while (octal < 3 && i < content.length && /[0-7]/.test(content[i])) { i += 1; octal += 1; }
            bytes += 1;
          } else if (content[i] === '\r' || content[i] === '\n') {
            if (content[i++] === '\r' && content[i] === '\n') i += 1;
          } else if (i < content.length) { i += 1; bytes += 1; }
        }
        else if (next === '(') { depth += 1; bytes += 1; }
        else if (next === ')') { depth -= 1; if (depth) bytes += 1; }
        else bytes += 1;
      }
      if (depth) metricFailure();
      tokens.push({ bytes }); continue;
    }
    if (c === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i + 1); if (end < 0) metricFailure();
      const hex = content.slice(i + 1, end).replace(/\s/g, '');
      if (!/^[0-9a-f]*$/i.test(hex)) metricFailure();
      tokens.push({ bytes: Math.ceil(hex.length / 2) }); i = end + 1; continue;
    }
    if ('[]<>'.includes(c)) { tokens.push(c); i += 1; continue; }
    const begin = i++;
    while (i < content.length && !/[\s()[\]<>%]/.test(content[i])) i += 1;
    tokens.push(content.slice(begin, i));
    if (tokens.length > 500000) metricFailure();
  }
  const identity = () => [1, 0, 0, 1];
  let matrix = identity(); let textMatrix = identity(); let font = 0;
  let operands = []; let unsupported = false;
  const stack = []; const weights = new Map(); const sizes = new Set();
  const multiply = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3]];
  for (const token of tokens) {
    if (typeof token === 'object' || token === '[' || token === ']' || token.startsWith('/') || /^[-+]?(?:\d*\.)?\d+$/.test(token)) { operands.push(token); continue; }
    const numbers = operands.filter((value) => typeof value === 'string' && /^[-+]?(?:\d*\.)?\d+$/.test(value)).map(Number);
    if (token === 'q') stack.push({ matrix: [...matrix], font });
    if (token === 'Q') { const prior = stack.pop(); if (!prior) metricFailure(); ({ matrix, font } = prior); }
    if (token === 'cm') { if (numbers.length !== 6) metricFailure(); matrix = multiply(matrix, numbers.slice(0, 4)); }
    if (token === 'BT') textMatrix = identity();
    if (token === 'Tm') { if (numbers.length !== 6) metricFailure(); textMatrix = numbers.slice(0, 4); }
    if (token === 'Tf') { font = metricNumber(numbers.at(-1), 0.1, 300); sizes.add(rounded(font)); }
    if (['Tj', 'TJ', "'", '"'].includes(token)) {
      const bytes = operands.reduce((sum, value) => sum + (value?.bytes ?? 0), 0);
      const effective = multiply(matrix, textMatrix);
      const size = rounded(font * Math.hypot(effective[2], effective[3]));
      if (bytes) { metricNumber(size, 0.1, 300); weights.set(size, (weights.get(size) || 0) + bytes); }
    }
    if (['Do', 'BI', 'Tr'].includes(token)) unsupported = true;
    operands = [];
  }
  const weightedSizes = [...weights].map(([sizePt, glyphByteWeight]) => ({ sizePt, glyphByteWeight })).sort((a, b) => b.glyphByteWeight - a.glyphByteWeight || a.sizePt - b.sizePt);
  return { fontSizeOperatorsPt: [...sizes].sort((a, b) => a - b), textFontSizes: weightedSizes, bodyFontSizePt: unsupported ? null : weightedSizes[0]?.sizePt ?? null, fontMeasurementSupported: !unsupported && weightedSizes.length > 0 };
}

function parsePdfMetrics({ layout, raw, bbox, content, outputSha256, outputBytes, imageDigest, nominalBottomMarginPt }) {
  const pages = [];
  const pagePattern = /<page\s+width="([\d.]+)"\s+height="([\d.]+)"[^>]*>([\s\S]*?)<\/page>/g;
  for (const match of bbox.matchAll(pagePattern)) {
    const widthPt = metricNumber(match[1], 1); const heightPt = metricNumber(match[2], 1);
    const words = [...match[3].matchAll(/<word\s+xMin="([\d.-]+)"\s+yMin="([\d.-]+)"\s+xMax="([\d.-]+)"\s+yMax="([\d.-]+)"[^>]*>/g)];
    if (!words.length) metricFailure();
    const bounds = words.map((word) => word.slice(1, 5).map((v) => metricNumber(v, -2000)));
    if (bounds.some(([x1, y1, x2, y2]) => x1 > x2 || y1 > y2)) metricFailure();
    const firstTextYPt = Math.min(...bounds.map((b) => b[1]));
    const lastTextYPt = Math.max(...bounds.map((b) => b[3]));
    pages.push({ pageNumber: pages.length + 1, widthPt, heightPt, firstTextYPt: rounded(firstTextYPt), lastTextYPt: rounded(lastTextYPt), blankBelowTextPt: rounded(Math.max(0, heightPt - lastTextYPt)), nominalBottomMarginPt, usableBottomWhitespacePt: rounded(Math.max(0, heightPt - nominalBottomMarginPt - lastTextYPt)), textOutsidePage: bounds.some(([x1, y1, x2, y2]) => x1 < 0 || y1 < 0 || x2 > widthPt || y2 > heightPt) });
  }
  if (!pages.length || pages.length > 20) metricFailure();
  const orderTokens = (text) => text.replace(/[‘’ʼ]/g, "'").replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').split(/\s+/u).filter((token) => /[\p{L}\p{N}]/u.test(token));
  return {
    schemaVersion: PDF_METRICS_VERSION, outputSha256, outputBytes, inspectionImageDigest: imageDigest,
    extractedTextSha256: sha256(Buffer.from(layout)), rawTextSha256: sha256(Buffer.from(raw)),
    wordLikeTokens: countWordLikeTokens(layout), whitespaceTokens: layout.split(/\s+/u).filter(Boolean).length,
    renderedTextLines: layout.split(/[\r\n\f]+/).filter((line) => line.trim()).length,
    pageCount: pages.length, pages, ...measureTextFonts(content),
    layoutAndRawTokenOrderEqual: JSON.stringify(orderTokens(layout)) === JSON.stringify(orderTokens(raw)),
    wordCountingMethod: 'unicode-letter-or-digit-whitespace-tokens.v1',
    fontMeasurementMethod: 'page-content-text-show-glyph-byte-weighted-transformed-point-size.v1',
    whitespaceMeasurementMethod: 'page-edge-minus-last-word-bbox-minus-explicit-nominal-margin.v1'
  };
}

/** Read-only measurements of exact render bytes, with no store/credential mount.
 * Options are dependency-injection seams for local tests, not CLI selectors. */
function createPdfMetricsInspector(options = {}) {
  const run = options.runProcess || spawnSync;
  const dockerBinary = options.dockerBinary || 'docker';
  const timeoutMs = options.timeoutMs || RENDER_TIMEOUT_MS;
  return function inspectPdfMetrics(input) {
    if (!input || typeof input.filePath !== 'string' || !path.isAbsolute(input.filePath)
      || !/^[a-f0-9]{64}$/.test(input.expectedOutputSha256 || '')) throw new LatexRendererError('INSPECT_TARGET_INVALID', 'An absolute PDF path and exact expected digest are required');
    assertPathNotPrivateJournalSource(input.filePath, 'PDF metrics input');
    const fd = fs.openSync(input.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let pdf;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_PDF_BYTES || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new LatexRendererError('INSPECT_TARGET_INVALID', 'Only a bounded owned regular PDF may be inspected');
      pdf = fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
    if (sha256(pdf) !== input.expectedOutputSha256) throw new LatexRendererError('INSPECT_DIGEST_MISMATCH', 'PDF bytes do not match the expected render digest');
    const nominalBottomMarginPt = metricNumber(input.nominalBottomMarginPt ?? 54, 0, 144);
    const stageRoot = stagingRootPath();
    assertPathNotPrivateJournalSource(stageRoot, 'PDF metrics staging');
    const plannedRoot = realpathIncludingMissing(stageRoot);
    const store = path.resolve(process.env.JOBTRACK_HOME || path.join(os.homedir(), '.jobtrack'));
    if (pathIsInside(plannedRoot, realpathIncludingMissing(store))) throw new LatexRendererError('INSPECT_STAGING_UNSAFE', 'PDF inspection staging must be outside the JobTrack store');
    stagingRoot();
    const realRoot = fs.realpathSync(stageRoot);
    if (realRoot !== plannedRoot) throw new LatexRendererError('INSPECT_STAGING_UNSAFE', 'PDF inspection staging changed during preparation');
    const imageDigest = inspectImage(run, dockerBinary, RENDERER_IMAGE, options.expectedImageDigest || RENDERER_IMAGE_DIGEST, timeoutMs);
    const staging = fs.mkdtempSync(path.join(realRoot, 'jobtrack-pdf-metrics-'));
    const inputDir = path.join(staging, 'input'); const outputDir = path.join(staging, 'output');
    const containerName = `jobtrack-pdfmetrics-${crypto.randomBytes(16).toString('hex')}`;
    const cidFile = path.join(staging, 'container.cid');
    try {
      fs.mkdirSync(inputDir, { mode: 0o700 }); fs.mkdirSync(outputDir, { mode: 0o700 });
      fs.writeFileSync(path.join(inputDir, 'document.pdf'), pdf, { mode: 0o600, flag: 'wx' });
      const uid = typeof process.getuid === 'function' ? process.getuid() : 65532;
      const gid = typeof process.getgid === 'function' ? process.getgid() : 65532;
      const args = ['run', '--pull=never', '--rm', `--name=${containerName}`, `--cidfile=${cidFile}`, '--stop-timeout=1', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--cpus=1', `--user=${uid}:${gid}`, `--ulimit=fsize=${MAX_METRIC_FILE_BYTES}:${MAX_METRIC_FILE_BYTES}`, '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m', '--env=HOME=/tmp/home', '--env=LC_ALL=C.UTF-8', `--mount=type=bind,src=${inputDir},dst=/input,readonly`, `--mount=type=bind,src=${outputDir},dst=/output`, '--entrypoint=sh', imageDigest, '-c', PDF_METRICS_COMMAND];
      const completed = run(dockerBinary, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_PROCESS_OUTPUT_BYTES, killSignal: 'SIGKILL', windowsHide: true, shell: false });
      if (completed.error) {
        assertContainerRemoved(run, dockerBinary, containerName, cidFile);
        throw new LatexRendererError('PDF_METRICS_UNAVAILABLE', 'The pinned PDF metrics inspector could not complete');
      }
      if (completed.status !== 0) throw new LatexRendererError('PDF_METRICS_UNAVAILABLE', 'The pinned PDF metrics inspector rejected the PDF');
      const expected = ['bbox.html', 'content.txt', 'layout.txt', 'raw.txt'];
      if (JSON.stringify(fs.readdirSync(outputDir).sort()) !== JSON.stringify(expected)) metricFailure();
      const outputs = {};
      for (const name of expected) {
        const file = path.join(outputDir, name); const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile() || !stat.size || stat.size > MAX_METRIC_FILE_BYTES) metricFailure();
        outputs[name] = fs.readFileSync(file, 'utf8');
      }
      const metrics = parsePdfMetrics({ layout: outputs['layout.txt'], raw: outputs['raw.txt'], bbox: outputs['bbox.html'], content: outputs['content.txt'], outputSha256: input.expectedOutputSha256, outputBytes: pdf.length, imageDigest, nominalBottomMarginPt });
      if (input.expectedExtractedTextSha256 !== undefined && metrics.extractedTextSha256 !== input.expectedExtractedTextSha256) throw new LatexRendererError('INSPECT_TEXT_DIGEST_MISMATCH', 'Fresh extraction does not match the exact render text digest');
      return metrics;
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  };
}

module.exports = {
  RENDERER_PROFILE,
  RENDERER_VERSION,
  PDF_ACTIVE_CONTENT_POLICY,
  RENDERER_IMAGE,
  RENDERER_IMAGE_DIGEST,
  MAX_SOURCE_BYTES,
  MAX_PDF_BYTES,
  MAX_EXTRACTED_TEXT_BYTES,
  RENDER_TIMEOUT_MS,
  LatexRendererError,
  createLatexRenderer,
  createPdfStructureInspector,
  createPdfMetricsInspector,
  PDF_METRICS_VERSION,
  countWordLikeTokens
};
