'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const ARTIFACT = '.tools/gog/jobtrack-single-attempt-v3-darwin-arm64/gog';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, platform = 'darwin') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-gog-pin-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Positive pin fixtures have private parents regardless of the inherited umask;
  // the rejection cases below still weaken their own generated paths explicitly.
  for (const relative of ['scripts/lib/pinned-gog.cjs', 'tools/gog/pin.json', 'tools/gog/single-attempt.patch', 'tools/gog/scoped-auth.patch', 'tools/gog/noninteractive-keychain.patch', 'lib/private-source-boundary.js']) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(ROOT, relative), path.join(root, relative));
  }
  const binary = path.join(root, ARTIFACT);
  fs.mkdirSync(path.dirname(binary), { recursive: true, mode: 0o700 });
  fs.writeFileSync(binary, 'test-only-not-an-executable', { mode: 0o700 });
  const pinPath = path.join(root, 'tools/gog/pin.json');
  const pin = JSON.parse(fs.readFileSync(pinPath));
  pin.artifacts['darwin-arm64'].sha256 = digest(fs.readFileSync(binary));
  fs.writeFileSync(pinPath, JSON.stringify(pin));
  const modulePath = path.join(root, 'scripts/lib/pinned-gog.cjs');
  const sandbox = { require: createRequire(modulePath), module: { exports: {} }, __dirname: path.dirname(modulePath),
    process: { platform, arch: 'arm64', getuid: process.getuid, env: { GOG_BIN: '/unsafe/gog', PATH: '/unsafe' } } };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), sandbox, { filename: modulePath });
  return { root, binary, pin, pinPath, resolve: sandbox.module.exports.resolvePinnedGog };
}
function refused(resolve) { assert.throws(resolve, error => error.code === 'GOG_PINNED_BINARY_UNAVAILABLE' && error.message === error.code); }
test('metadata utility and build installer name the same reviewed artifact identity', () => {
  const pin = JSON.parse(fs.readFileSync(path.join(ROOT,'tools/gog/pin.json'),'utf8'));
  const artifact = pin.artifacts['darwin-arm64'];
  const helper = fs.readFileSync(path.join(ROOT,'scripts/lib/gog-keychain-acl.swift'),'utf8');
  assert.ok(helper.includes(`let expectedHash = "${artifact.sha256}"`));
  assert.ok(helper.includes(`let expectedCDHash = "${artifact.cdhash}"`));
  assert.ok(helper.includes(`"/${artifact.relativePath}"`));
  const build = fs.readFileSync(path.join(ROOT,'scripts/build-pinned-gog.cjs'),'utf8');
  assert.ok(build.includes(artifact.relativePath));
  assert.ok(build.includes('^TestJobTrack(InspectAccount|NoninteractiveKeychain)'));
});
test('resolves only the source-pinned app-local artifact, ignoring PATH/environment selectors', t => {
  const f = fixture(t);
  assert.equal(f.resolve(), f.binary);
});
test('missing, replaced, non-executable, writable or symlinked binaries fail closed without fallback', t => {
  for (const mutate of [
    f => fs.unlinkSync(f.binary),
    f => fs.appendFileSync(f.binary, '-replaced'),
    f => fs.chmodSync(f.binary, 0o600),
    f => fs.chmodSync(f.binary, 0o720),
    f => { fs.renameSync(f.binary, `${f.binary}.target`); fs.symlinkSync(`${f.binary}.target`, f.binary); },
    f => fs.chmodSync(path.dirname(f.binary), 0o777)
  ]) { const f = fixture(t); mutate(f); refused(f.resolve); }
});
test('patch/provenance substitution and unsupported platforms fail closed', t => {
  for (const mutate of [
    f => fs.appendFileSync(path.join(f.root, 'tools/gog/single-attempt.patch'), '\nchanged'),
    f => fs.appendFileSync(path.join(f.root, 'tools/gog/scoped-auth.patch'), '\nchanged'),
    f => fs.appendFileSync(path.join(f.root, 'tools/gog/noninteractive-keychain.patch'), '\nchanged'),
    f => { f.pin.upstreamCommit = '0'.repeat(40); fs.writeFileSync(f.pinPath, JSON.stringify(f.pin)); },
    f => { f.pin.artifacts['darwin-arm64'].relativePath = '/opt/homebrew/bin/gog'; fs.writeFileSync(f.pinPath, JSON.stringify(f.pin)); },
    f => fs.chmodSync(f.pinPath, 0o666)
  ]) { const f = fixture(t); mutate(f); refused(f.resolve); }
  refused(fixture(t, 'linux').resolve);
});
test('every resolution rehashes rather than trusting an earlier binary', t => {
  const f = fixture(t);
  assert.equal(f.resolve(), f.binary);
  fs.appendFileSync(f.binary, '-changed-after-validation');
  refused(f.resolve);
});
test('operational hold blocks credential callers but allows metadata-only verification without relaxing pins', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root,'.tools/gog/keychain-access-paused'),'fixture hold');
  assert.throws(()=>f.resolve(),error=>error.code==='GOG_KEYCHAIN_ACCESS_PAUSED');
  assert.throws(()=>f.resolve({metadataOnly:'true'}),error=>error.code==='GOG_KEYCHAIN_ACCESS_PAUSED');
  assert.equal(f.resolve({metadataOnly:true}),f.binary);
  fs.appendFileSync(f.binary,'-changed');
  assert.throws(()=>f.resolve({metadataOnly:true}),error=>error.code==='GOG_PINNED_BINARY_UNAVAILABLE');
});
test('a dangling pause marker still blocks credential use', t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root,'not-present'),path.join(f.root,'.tools/gog/keychain-access-paused'));
  assert.throws(()=>f.resolve(),error=>error.code==='GOG_KEYCHAIN_ACCESS_PAUSED');
});
