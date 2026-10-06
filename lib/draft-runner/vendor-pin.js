'use strict';

// JobTrack executes Mission Pipeline v2 node graphs and, for panels that reach a
// model, Mission EAL's host-neutral LLM client. Both are vendored rather than
// installed so there is no registry, network, or mutable-checkout dependency at
// build or run time, and both are pinned byte-for-byte by SHA-256 to an exact
// published release. The pin is verified before either is loaded. This mirrors
// the pinned Execution Contracts fixture tree in
// test-support/outgoing-v2-fixtures.js.
//
// Vendoring also keeps exactly one copy of the engine in the process. Mission
// Pipeline classifies stage failures with instanceof, so a second copy would
// silently degrade terminal and shard-scoped signals — including a lost shard
// lease — into retryable item failures. Mission EAL declares the engine as a
// peer dependency for the same reason.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PINS = Object.freeze({
  // The v2 node-graph engine (mission-pipeline 1.0.0; untagged upstream — the
  // commit is the release). Vendored by scripts/vendor-mission-pipeline.mjs and
  // consumed by every runner through lib/engine-v2 (docs/V2-ENGINE-PORT.md).
  'mission-pipeline': Object.freeze({
    manifestVersion: 'jobtrack-pinned-mission-pipeline.v1',
    repository: 'scshafe/mission-pipeline',
    release: '1.0.0',
    commit: 'd22fb89af059081bd8da7e824a7000e97dc49c60',
    tree: '97b89fe0530ccff0d07bd73d853f73173074fa45',
    packageVersion: '1.0.0',
    entry: 'lib/index.js'
  }),
  'mission-eal': Object.freeze({
    manifestVersion: 'jobtrack-pinned-mission-eal.v1',
    repository: 'scshafe/mission-eal',
    release: 'v0.2.0',
    commit: '62db3463cf6268233793cc11356f5ac1aad76f5c',
    tree: '703ba0d8a37fd40128390b417e7ef870a39ca270',
    packageVersion: '0.2.0',
    entry: 'lib/index.js'
  })
});

const VENDOR_SOURCE_COMMIT = PINS['mission-pipeline'].commit;
const VENDOR_SOURCE_RELEASE = PINS['mission-pipeline'].release;
const VENDOR_SOURCE_TREE = PINS['mission-pipeline'].tree;
const VENDOR_PACKAGE_VERSION = PINS['mission-pipeline'].packageVersion;

class VendorPinError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VendorPinError';
    this.code = 'VENDOR_PIN_INVALID';
  }
}

function fail(message) {
  throw new VendorPinError(message);
}

function vendorRoot(name) {
  // realpath first: a symlinked checkout would otherwise produce a second
  // module record for identical bytes, which is what vendoring prevents.
  return fs.realpathSync(path.resolve(__dirname, '../../vendor', name));
}

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(candidate));
    else if (entry.isFile()) files.push(candidate);
    else fail(`vendored tree contains a non-regular entry: ${candidate}`);
  }
  return files;
}

// Fails closed on any drift: a changed byte, an added or removed file, a moved
// pin, or a path that escapes the vendored root.
function verifyPinnedPackage(name) {
  const pin = PINS[name];
  if (!pin) fail(`no pin is declared for ${name}`);
  const root = vendorRoot(name);

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); }
  catch (error) { fail(`vendored ${name} manifest is unreadable: ${String(error.message || error)}`); }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail(`vendored ${name} manifest must be an object`);
  }
  for (const [field, expected] of [
    ['schemaVersion', pin.manifestVersion],
    ['sourceRepository', pin.repository],
    ['sourceRelease', pin.release],
    ['sourceCommit', pin.commit],
    ['sourceTree', pin.tree],
    ['packageVersion', pin.packageVersion]
  ]) {
    if (manifest[field] !== expected) {
      fail(`vendored ${name} manifest ${field} is ${String(manifest[field])}, expected ${expected}`);
    }
  }
  if (manifest.files === null || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    fail(`vendored ${name} manifest files must be an object`);
  }

  const expectedFiles = Object.keys(manifest.files).sort();
  if (!expectedFiles.length) fail(`vendored ${name} manifest pins no files`);
  for (const relative of expectedFiles) {
    if (path.isAbsolute(relative)) fail(`${name}: ${relative} must be repository-relative`);
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(`${root}${path.sep}`)) fail(`${name}: ${relative} must remain below the vendored root`);
    const digest = manifest.files[relative];
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
      fail(`${name}: ${relative} has no lowercase SHA-256 pin`);
    }
    let bytes;
    try { bytes = fs.readFileSync(resolved); }
    catch { fail(`${name}: ${relative} is pinned but missing`); }
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== digest) {
      fail(`${name}: ${relative} does not match its pinned SHA-256`);
    }
  }

  const discovered = listFiles(root)
    .map((file) => path.relative(root, file))
    .filter((relative) => relative !== 'manifest.json')
    .sort();
  if (discovered.length !== expectedFiles.length
    || discovered.some((relative, index) => relative !== expectedFiles[index])) {
    fail(`vendored ${name} tree contains files the manifest does not pin`);
  }
  return true;
}

function verifyPinnedMissionPipeline() {
  return verifyPinnedPackage('mission-pipeline');
}

function verifyPinnedMissionEal() {
  return verifyPinnedPackage('mission-eal');
}


// Both packages are ESM and JobTrack is CommonJS, so each is reached by dynamic
// import. The pin is verified first — an unverified tree is never loaded — and
// each module is imported once so its class identities stay stable.
const loaded = new Map();

function loadVendored(name) {
  if (!loaded.has(name)) {
    verifyPinnedPackage(name);
    const entry = path.join(vendorRoot(name), PINS[name].entry);
    loaded.set(name, import(`file://${entry}`));
  }
  return loaded.get(name);
}

function loadMissionPipeline() {
  return loadVendored('mission-pipeline');
}

function loadMissionEal() {
  return loadVendored('mission-eal');
}


module.exports = Object.freeze({
  PINS,
  VENDOR_PACKAGE_VERSION,
  VENDOR_SOURCE_COMMIT,
  VENDOR_SOURCE_RELEASE,
  VENDOR_SOURCE_TREE,
  VendorPinError,
  loadMissionEal,
  loadMissionPipeline,
  root: vendorRoot('mission-pipeline'),
  vendorRoot,
  verifyPinnedMissionEal,
  verifyPinnedMissionPipeline
});
