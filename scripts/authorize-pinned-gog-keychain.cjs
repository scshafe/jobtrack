#!/usr/bin/env node
'use strict';

// Explicit operator action only. No mailbox call or credential-value access.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { isatty } = require('node:tty');
const { resolvePinnedGog } = require('./lib/pinned-gog.cjs');
const { assertPathNotPrivateJournalSource } = require('../lib/private-source-boundary.js');
const ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(__dirname, 'lib/gog-keychain-acl.swift');
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function validateMode(mode, interactive, codeIdentity) {
  if (mode === 'snapshot' && (interactive || codeIdentity)) fail('SNAPSHOT_IS_NONINTERACTIVE_METADATA_ONLY');
  if (codeIdentity && mode === 'rollback') fail('NATIVE_PARTITION_ROLLBACK_REQUIRES_OPERATOR');
  if (interactive && mode !== 'apply') fail('INTERACTIVE_REQUIRES_EXPLICIT_APPLY');
  if (codeIdentity && mode === 'apply' && !interactive) fail('CODE_IDENTITY_APPLY_REQUIRES_INTERACTIVE');
}
function requireControllingTerminal() {
  let fd;
  try {
    fd = fs.openSync('/dev/tty', fs.constants.O_RDWR | fs.constants.O_NOCTTY);
    if (!isatty(fd)) fail('NATIVE_PARTITION_CONTROLLING_TERMINAL_REQUIRED');
  } catch { fail('NATIVE_PARTITION_CONTROLLING_TERMINAL_REQUIRED'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function parseArgs(args) {
  let mode = 'inspect'; let explicitMode = false; let receiptDir; let interactive = false; let codeIdentity = false;
  for (let i = 0; i < args.length; i++) {
    if (['--snapshot', '--dry-run', '--verify', '--apply', '--rollback'].includes(args[i])) {
      if (explicitMode) fail('ONE_MODE_REQUIRED');
      explicitMode = true;
      mode = { '--snapshot': 'snapshot', '--dry-run': 'inspect', '--verify': 'verify', '--apply': 'apply', '--rollback': 'rollback' }[args[i]];
    } else if (args[i] === '--interactive' && !interactive) interactive = true;
    else if (args[i] === '--code-identity' && !codeIdentity) codeIdentity = true;
    else if (args[i] === '--receipt-dir' && !receiptDir && args[i + 1]) receiptDir = args[++i];
    else fail('Usage: node scripts/authorize-pinned-gog-keychain.cjs [--snapshot|--dry-run|--verify|--apply|--rollback] [--code-identity with plan modes only] [--receipt-dir /absolute/private/directory] [--interactive with --apply only]');
  }
  if (receiptDir && !path.isAbsolute(receiptDir)) fail('ABSOLUTE_RECEIPT_DIRECTORY_REQUIRED');
  if (!['inspect', 'snapshot'].includes(mode) && !receiptDir) fail('DURABLE_RECEIPT_DIRECTORY_REQUIRED');
  validateMode(mode, interactive, codeIdentity);
  return { mode, receiptDir, interactive, codeIdentity };
}
function checkPrivate(file, directory) {
  assertPathNotPrivateJournalSource(file, 'Keychain ACL metadata receipt');
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()
      || fs.realpathSync(file) !== file) fail('ACL_RECEIPT_NOT_PRIVATE');
}
function durableWrite(file, value) {
  assertPathNotPrivateJournalSource(file, 'Keychain ACL metadata receipt');
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function readPlan(file) {
  checkPrivate(file, false);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (fs.fstatSync(fd).size > 100000) fail('ACL_PLAN_TOO_LARGE');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
function invoke(mode, plan, interactive = false, codeIdentity = false) {
  validateMode(mode, interactive, codeIdentity);
  if (mode === 'snapshot' && plan !== undefined) fail('SNAPSHOT_DOES_NOT_ACCEPT_A_PLAN');
  if (codeIdentity && mode === 'apply') requireControllingTerminal();
  resolvePinnedGog({ metadataOnly: true }); // No credential use by this utility.
  assertPathNotPrivateJournalSource(HELPER, 'Keychain ACL helper source');
  const result = spawnSync('/usr/bin/swift', ['-suppress-warnings', HELPER, mode, ...(interactive ? ['--interactive'] : []), ...(codeIdentity ? ['--code-identity'] : [])], {
    input: plan ? JSON.stringify(plan) : undefined, encoding: 'utf8', shell: false,
    // Apple owns the native prompt; we never read its password. No timeout only
    // for opted-in apply; all other operations retain their normal bound.
    ...(interactive ? {} : { timeout: 30000 }), maxBuffer: 200000
  });
  if (result.status !== 0 || result.signal || result.error) {
    let diagnostic;
    try { diagnostic = JSON.parse(result.stderr); } catch { diagnostic = { code: 'KEYCHAIN_HELPER_FAILED' }; }
    const error = new Error(diagnostic.code || 'KEYCHAIN_HELPER_FAILED');
    error.diagnostic = { code: error.message, osStatus: Number.isInteger(diagnostic.osStatus) ? diagnostic.osStatus : null };
    throw error;
  }
  try { return JSON.parse(result.stdout); } catch { fail('KEYCHAIN_HELPER_RESPONSE_INVALID'); }
}
function summary(plan) {
  const mutationScope = plan.mutationScope ?? 'app-trust';
  return { mode: 'dry-run', mutationScope, account: 'scshafe@umich.edu', binaryPath: plan.binaryPath,
    binarySha256: plan.binarySha256, binaryCDHash: plan.binaryCDHash, aliases: plan.before.map(item => ({ label: item.label, aclCount: item.access.acls.length })),
    change: mutationScope === 'code-identity' ? 'append only the verified pinned cdhash to existing partition lists; preserve all other access metadata'
      : 'append exact pinned executable to each existing decrypt ACL; preserve all other access metadata',
    credentialDataRead: false, credentialDataWritten: false };
}
function main(args) {
  const { mode, receiptDir, interactive, codeIdentity } = parseArgs(args);
  if (codeIdentity && mode === 'apply') requireControllingTerminal();
  const mutationScope = codeIdentity ? 'code-identity' : 'app-trust';
  resolvePinnedGog({ metadataOnly: true });
  if (receiptDir) {
    assertPathNotPrivateJournalSource(receiptDir, 'Keychain ACL receipt directory');
    if (!fs.existsSync(receiptDir)) {
      if (mode === 'verify' || mode === 'rollback') fail('SAVED_RECEIPT_DIRECTORY_REQUIRED');
      fs.mkdirSync(receiptDir, { mode: 0o700 });
    }
    checkPrivate(receiptDir, true);
  }
  if (mode === 'snapshot') {
    // A fresh observation is independent of prior plans and never invokes an
    // in-memory ACL transform, native authorization, or credential-value read.
    // No operation lock is needed: this branch cannot alter Keychain state.
    const current = invoke('snapshot', undefined);
    if (receiptDir) durableWrite(path.join(receiptDir, `snapshot-${randomUUID()}.json`), current);
    process.stdout.write(`${JSON.stringify(current)}\n`);
    return;
  }
  // One lock across all receipt directories; a crash-owned lock is never stolen.
  const lock = path.join(ROOT, '.tools/gog/.keychain-acl.lock');
  assertPathNotPrivateJournalSource(lock, 'Keychain ACL operation lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  const owned = fs.fstatSync(fd);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, mode, interactive, mutationScope })); fs.fsyncSync(fd);
    const planFile = receiptDir && path.join(receiptDir, 'plan.json');
    let plan;
    if (planFile && fs.existsSync(planFile)) plan = readPlan(planFile);
    else {
      if (mode === 'rollback' || mode === 'verify') fail('SAVED_ACL_PLAN_REQUIRED');
      plan = invoke('inspect', undefined, false, codeIdentity);
      if (planFile) durableWrite(planFile, plan);
    }
    if ((plan.mutationScope ?? 'app-trust') !== mutationScope) fail('PLAN_MUTATION_SCOPE_MISMATCH');
    if (mode === 'inspect') {
      // A saved plan is not live evidence. Recheck code identity and report the
      // current whole-ACL state even when reusing an existing dry-run receipt.
      const current = invoke('verify', plan, false, codeIdentity);
      process.stdout.write(`${JSON.stringify({ ...summary(plan), currentAliases: current.aliases })}\n`); return;
    }
    if (mode === 'verify') { process.stdout.write(`${JSON.stringify(invoke('verify', plan, false, codeIdentity))}\n`); return; }
    const operation = `${mode}-${randomUUID()}`;
    durableWrite(path.join(receiptDir, `${operation}.intent.json`), {
      schemaVersion: 'jobtrack-gog-keychain-acl-intent.v1', mode, interactive, mutationScope, binarySha256: plan.binarySha256,
      binaryCDHash: plan.binaryCDHash,
      planFile: 'plan.json', createdAt: new Date().toISOString()
    });
    try {
      const result = invoke(mode, plan, interactive, codeIdentity);
      durableWrite(path.join(receiptDir, `${operation}.result.json`), result);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      durableWrite(path.join(receiptDir, `${operation}.result.json`), {
        outcome: 'stopped', diagnostic: error.diagnostic || { code: error.message },
        recovery: codeIdentity
          ? 'Stop and --verify this saved plan. Code-identity rollback requires separately reviewed native operator action.'
          : 'Do not bypass OS authorization. Inspect the receipt; --rollback uses exact recorded before/after metadata only.'
      });
      throw error;
    }
  } finally {
    fs.closeSync(fd);
    const current = fs.lstatSync(lock);
    if (!current.isSymbolicLink() && current.ino === owned.ino && current.dev === owned.dev) fs.unlinkSync(lock);
  }
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${JSON.stringify(error.diagnostic || { code: error.message })}\n`); process.exitCode = 1; }
}
module.exports = { parseArgs };
