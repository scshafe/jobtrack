'use strict';

// The app-local binary is a reviewed build, not an environment/PATH choice.
// Hash every resolution: a replaced executable cannot inherit old approval.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { assertPathNotPrivateJournalSource } = require('../../lib/private-source-boundary.js');
const ROOT = path.resolve(__dirname, '../..');
const COMMIT = '22d197c5c40e3b6482dff4e8c7be68e29239b05c';
const PATCH = 'tools/gog/single-attempt.patch';
const AUTH_PATCH = 'tools/gog/scoped-auth.patch';
const UI_PATCH = 'tools/gog/noninteractive-keychain.patch';
const ARTIFACT = '.tools/gog/jobtrack-single-attempt-v3-darwin-arm64/gog';
function fail() {
  const error = new Error('GOG_PINNED_BINARY_UNAVAILABLE');
  error.code = 'GOG_PINNED_BINARY_UNAVAILABLE';
  throw error;
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function checkedRead(relative, executable = false) {
  const file = path.join(ROOT, relative);
  assertPathNotPrivateJournalSource(file, 'pinned gog artifact');
  let current = ROOT;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
        || (process.getuid && stat.uid !== process.getuid())) fail();
  }
  if (fs.realpathSync(file) !== file) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0 || stat.size > (executable ? 150000000 : 2000000)
        || (executable && (stat.mode & 0o100) === 0)
        || (process.getuid && stat.uid !== process.getuid())) fail();
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function resolvePinnedGog({ metadataOnly = false } = {}) {
  try {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') fail();
    const pin = JSON.parse(checkedRead('tools/gog/pin.json').toString('utf8'));
    const artifact = pin.artifacts?.['darwin-arm64'];
    if (pin.schema !== 'jobtrack-pinned-gog.v3' || pin.upstreamCommit !== COMMIT
        || pin.patchFile !== PATCH || artifact?.relativePath !== ARTIFACT
        || pin.scopedAuthPatchFile !== AUTH_PATCH || !/^[a-f0-9]{64}$/.test(pin.scopedAuthPatchSha256)
        || pin.noninteractivePatchFile !== UI_PATCH || !/^[a-f0-9]{64}$/.test(pin.noninteractivePatchSha256)
        || !/^[a-f0-9]{64}$/.test(pin.patchSha256)
        || !/^[a-f0-9]{64}$/.test(artifact.sha256)) fail();
    if (digest(checkedRead(PATCH)) !== pin.patchSha256
        || digest(checkedRead(AUTH_PATCH)) !== pin.scopedAuthPatchSha256
        || digest(checkedRead(UI_PATCH)) !== pin.noninteractivePatchSha256
        || digest(checkedRead(ARTIFACT, true)) !== artifact.sha256) fail();
    // Operational stop for incomplete native authorization / prompt storms.
    // Only offline build verification and the metadata-only ACL utility opt out;
    // provider callers must never opt out or fall back to another executable.
    let paused = false;
    try { fs.lstatSync(path.join(ROOT, '.tools/gog/keychain-access-paused')); paused = true; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (metadataOnly !== true && paused) {
      const error = new Error('GOG_KEYCHAIN_ACCESS_PAUSED'); error.code = error.message; throw error;
    }
    return path.join(ROOT, ARTIFACT);
  } catch (error) {
    if (error?.code === 'GOG_KEYCHAIN_ACCESS_PAUSED') throw error;
    fail();
  }
}
module.exports = { resolvePinnedGog };
