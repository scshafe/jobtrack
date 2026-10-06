#!/usr/bin/env node
'use strict';

// Rebuild only from an explicit clean upstream checkout, never installed gog.
// Installation is refused unless the result matches the reviewed binary pin.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { assertPathNotPrivateJournalSource } = require('../lib/private-source-boundary.js');
const ROOT = path.resolve(__dirname, '..');
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, CGO_ENABLED: '1', GOFLAGS: '', GOOS: 'darwin', GOARCH: 'arm64', CC: 'clang' }, shell: false });
  if (result.error || result.status !== 0) throw new Error('PINNED_GOG_BUILD_COMMAND_FAILED');
  return (result.stdout ?? '').trim();
}
function main() {
  const source = process.argv[2];
  if (process.argv.length !== 3 || !source || !path.isAbsolute(source)) throw new Error('Usage: node scripts/build-pinned-gog.cjs /absolute/clean/gogcli-v0.27.1-checkout');
  assertPathNotPrivateJournalSource(source, 'gog build source');
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('PINNED_GOG_PLATFORM_NOT_REVIEWED');
  const pinPath = path.join(ROOT, 'tools/gog/pin.json');
  assertPathNotPrivateJournalSource(pinPath, 'gog build pin');
  const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
  const patch = path.join(ROOT, 'tools/gog/single-attempt.patch');
  const authPatch = path.join(ROOT, 'tools/gog/scoped-auth.patch');
  const uiPatch = path.join(ROOT, 'tools/gog/noninteractive-keychain.patch');
  assertPathNotPrivateJournalSource(patch, 'gog transport patch');
  assertPathNotPrivateJournalSource(authPatch, 'gog scoped auth patch');
  assertPathNotPrivateJournalSource(uiPatch, 'gog noninteractive Keychain patch');
  if (digest(fs.readFileSync(patch)) !== pin.patchSha256) throw new Error('PINNED_GOG_PATCH_MISMATCH');
  if (pin.schema !== 'jobtrack-pinned-gog.v3' || pin.scopedAuthPatchFile !== 'tools/gog/scoped-auth.patch'
      || digest(fs.readFileSync(authPatch)) !== pin.scopedAuthPatchSha256) throw new Error('PINNED_GOG_AUTH_PATCH_MISMATCH');
  if (pin.noninteractivePatchFile !== 'tools/gog/noninteractive-keychain.patch'
      || digest(fs.readFileSync(uiPatch)) !== pin.noninteractivePatchSha256) throw new Error('PINNED_GOG_UI_PATCH_MISMATCH');
  if (run('git', ['rev-parse', 'HEAD'], source, { capture: true }) !== pin.upstreamCommit
      || run('git', ['status', '--porcelain'], source, { capture: true }) !== '') throw new Error('PINNED_GOG_SOURCE_NOT_EXACT_CLEAN');
  if (run('go', ['env', 'GOVERSION'], source, { capture: true }) !== pin.build.goVersion
      || run('clang', ['--version'], source, { capture: true }).split('\n')[0] !== pin.build.compiler
      || run('xcrun', ['--show-sdk-version'], source, { capture: true }) !== pin.build.sdkVersion) throw new Error('PINNED_GOG_TOOLCHAIN_MISMATCH');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-pinned-gog-build-'));
  try {
    const checkout = path.join(temporary, 'source');
    run('git', ['clone', '--no-hardlinks', '--quiet', source, checkout], ROOT);
    run('git', ['apply', '--check', patch], checkout);
    run('git', ['apply', patch], checkout);
    run('git', ['apply', '--check', authPatch], checkout);
    run('git', ['apply', authPatch], checkout);
    run('git', ['apply', '--check', uiPatch], checkout);
    run('git', ['apply', uiPatch], checkout);
    run('go', ['test', './internal/googleapi', '-count=1'], checkout);
    run('go', ['test', './internal/cmd', '-run', '^TestJobTrack(InspectAccount|NoninteractiveKeychain)', '-count=1'], checkout);
    const built = path.join(temporary, 'gog');
    run('go', ['build', '-trimpath', '-buildvcs=false', '-ldflags', pin.build.ldflags, '-o', built, './cmd/gog'], checkout);
    const artifact = pin.artifacts['darwin-arm64'];
    if (digest(fs.readFileSync(built)) !== artifact.sha256) throw new Error('PINNED_GOG_BUILD_HASH_MISMATCH');
    const destination = path.join(ROOT, '.tools/gog/jobtrack-single-attempt-v3-darwin-arm64/gog');
    assertPathNotPrivateJournalSource(destination, 'gog build destination');
    const directory = path.dirname(destination);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    let cursor = ROOT;
    for (const segment of path.relative(ROOT, directory).split(path.sep)) {
      cursor = path.join(cursor, segment);
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || stat.uid !== process.getuid()) throw new Error('PINNED_GOG_UNSAFE_DESTINATION');
    }
    if (fs.existsSync(destination)) {
      const stat = fs.lstatSync(destination);
      if (!stat.isFile() || stat.isSymbolicLink() || digest(fs.readFileSync(destination)) !== artifact.sha256) throw new Error('PINNED_GOG_REFUSE_OVERWRITE');
    } else {
      const staged = `${destination}.${randomUUID()}.tmp`;
      fs.copyFileSync(built, staged, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(staged, 0o700);
      const fd = fs.openSync(staged, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.linkSync(staged, destination); // Exclusive install; never replace a racing artifact.
      fs.unlinkSync(staged);
      const dirFd = fs.openSync(directory, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }
    require('./lib/pinned-gog.cjs').resolvePinnedGog({ metadataOnly: true });
    process.stdout.write(`Verified pinned gog: ${artifact.sha256}\n`);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
