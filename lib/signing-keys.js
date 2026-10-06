'use strict';

// One Ed25519 key-mint for the outgoing lane's per-store signing identities.
// Two identities exist today — the auto-approval signer and the native
// send-receipt signer — and each previously carried an identical mint/load
// implementation. The shape is shared; the FILES and keyIds stay distinct on
// purpose (an approval key must never sign receipts, and vice versa: the
// lane pins each by fingerprint).
//
// Keys live at $JOBTRACK_HOME/keys/<fileName> (dir 0700, file 0600) and are
// fingerprinted with the SAME function the lane verifies against
// (publicKeyFingerprint: sha256 over the SPKI DER).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { publicKeyFingerprint } = require('./email-outgoing-v2-contracts');
const { assertPathNotPrivateJournalSource } = require('./private-source-boundary');

function invalidKey(file) {
  const error = new Error(`Signing key file is malformed or unsafe: ${file}`);
  error.code = 'KEY_INVALID';
  return error;
}

function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function readKey(file, keyId) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw invalidKey(file);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (stored.keyId !== keyId || !stored.privateKeyPem || !stored.publicKeyPem || !stored.publicKeySha256) throw invalidKey(file);
    const derived = crypto.createHash('sha256').update(crypto.createPublicKey(
      crypto.createPrivateKey(stored.privateKeyPem)
    ).export({ type: 'spki', format: 'der' })).digest('hex');
    if (derived !== stored.publicKeySha256 || publicKeyFingerprint(stored.publicKeyPem) !== derived) throw invalidKey(file);
    return { ...stored, file };
  } catch (err) {
    if (err.code === 'ENOENT') throw err;
    throw invalidKey(file);
  }
}

/**
 * Mint (once) or load one signing keypair.
 * @param {string} home  JOBTRACK_HOME
 * @param {{fileName: string, keyId: string}} identity
 * @returns {{keyId:string, publicKeyPem:string, privateKeyPem:string, publicKeySha256:string, file:string}}
 */
function ensureSigningKey(home, { fileName, keyId }) {
  if (path.basename(fileName) !== fileName || !fileName || fileName === '.' || fileName === '..') throw invalidKey(fileName);
  const dir = path.join(home, 'keys');
  const file = path.join(dir, fileName);
  assertPathNotPrivateJournalSource(file, 'signing identity');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid())) throw invalidKey(file);
  syncDirectory(home);
  try { return readKey(file, keyId); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeySha256 = publicKeyFingerprint(publicKeyPem);
  const temporary = path.join(dir, `.${fileName}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ keyId, publicKeyPem, privateKeyPem, publicKeySha256, mintedAt: new Date().toISOString() })}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    // Link publishes a fully written inode and cannot replace a winning key.
    // Concurrent first sends for DIFFERENT approvals must share one identity.
    try { fs.linkSync(temporary, file); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
    syncDirectory(dir);
  } finally {
    fs.unlinkSync(temporary);
    syncDirectory(dir);
  }
  return readKey(file, keyId);
}

/** The pin/resolve options the lane's verifiers take, for a minted key. */
function signingKeyOptions(key) {
  return {
    expectedKeyId: key.keyId,
    expectedPublicKeySha256: key.publicKeySha256,
    resolvePublicKey: () => key.publicKeyPem
  };
}

module.exports = { ensureSigningKey, signingKeyOptions };
