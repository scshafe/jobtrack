'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../test/fixtures/execution-contracts-outgoing-v2');
const manifestFile = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

function verifyPinnedOutgoingV2Fixtures() {
  assert.equal(manifest.schemaVersion, 'jobtrack-pinned-execution-contract-fixtures.v1');
  assert.equal(manifest.sourceRepository, 'scshafe/execution-contracts');
  assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(manifest.sourceTree, /^[a-f0-9]{40}$/);
  const entries = Object.entries(manifest.files);
  // REVIEWED REPIN (execution-contracts 1.7.0): correlation-result v3 adds its
  // schema plus golden/negative fixtures to the previously reviewed 73 bytes.
  assert.equal(entries.length, 76);
  for (const [relative, expected] of entries) {
    assert.equal(path.isAbsolute(relative), false, `${relative} must be repository-relative`);
    const resolved = path.resolve(root, relative);
    assert.equal(resolved.startsWith(`${root}${path.sep}`), true, `${relative} must remain below the pinned root`);
    const bytes = fs.readFileSync(resolved);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected, relative);
  }
  const discovered = listFiles(root)
    .map((file) => path.relative(root, file))
    .filter((relative) => relative !== 'manifest.json')
    .sort();
  assert.deepEqual(discovered, Object.keys(manifest.files).sort(), 'pinned fixture manifest must cover every checked-in source byte exactly once');
  return true;
}

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(candidate));
    else if (entry.isFile()) files.push(candidate);
    else assert.fail(`Pinned fixture tree contains a non-regular entry: ${candidate}`);
  }
  return files;
}

module.exports = Object.freeze({
  root,
  emailFixtures: path.join(root, 'fixtures/email'),
  negativeFixtures: path.join(root, 'fixtures/negative'),
  testVectors: path.join(root, 'test-vectors'),
  manifest: Object.freeze(manifest),
  verifyPinnedOutgoingV2Fixtures
});
