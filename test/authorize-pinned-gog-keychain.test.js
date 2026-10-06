'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const { parseArgs } = require('../scripts/authorize-pinned-gog-keychain.cjs');
test('Keychain ACL utility defaults to inspection; mutation requires explicit mode and private receipt path', () => {
  assert.deepEqual(parseArgs([]), { mode: 'inspect', receiptDir: undefined, interactive: false, codeIdentity: false });
  assert.deepEqual(parseArgs(['--dry-run']), { mode: 'inspect', receiptDir: undefined, interactive: false, codeIdentity: false });
  assert.deepEqual(parseArgs(['--apply', '--receipt-dir', '/private/receipts']), { mode: 'apply', receiptDir: '/private/receipts', interactive: false, codeIdentity: false });
  assert.deepEqual(parseArgs(['--rollback', '--receipt-dir', '/private/receipts']), { mode: 'rollback', receiptDir: '/private/receipts', interactive: false, codeIdentity: false });
  assert.deepEqual(parseArgs(['--verify', '--receipt-dir', '/private/receipts']), { mode: 'verify', receiptDir: '/private/receipts', interactive: false, codeIdentity: false });
  for (const args of [['--apply'], ['--rollback'], ['--verify'], ['--apply', '--rollback'], ['--allow-interaction'],
    ['--account', 'another@example.com'], ['--receipt-dir', 'relative'], ['--receipt-dir', '/one', '--receipt-dir', '/two']]) {
    assert.throws(() => parseArgs(args));
  }
});
test('interactive OS confirmation requires explicit apply, rejects other modes and repeated flags', () => {
  assert.deepEqual(parseArgs(['--apply', '--interactive', '--receipt-dir', '/private/receipts']),
    { mode: 'apply', receiptDir: '/private/receipts', interactive: true, codeIdentity: false });
  assert.deepEqual(parseArgs(['--interactive', '--receipt-dir', '/private/receipts', '--apply']),
    { mode: 'apply', receiptDir: '/private/receipts', interactive: true, codeIdentity: false });
  for (const args of [
    ['--interactive'], ['--interactive', '--receipt-dir', '/private/receipts'],
    ['--dry-run', '--interactive'], ['--verify', '--interactive', '--receipt-dir', '/private/receipts'],
    ['--rollback', '--interactive', '--receipt-dir', '/private/receipts'],
    ['--apply', '--interactive'], ['--apply', '--interactive', '--interactive', '--receipt-dir', '/private/receipts']
  ]) assert.throws(() => parseArgs(args));
});
test('code identity is one fixed opt-in scope with no caller-selected hash, account or path', () => {
  assert.deepEqual(parseArgs(['--code-identity']), { mode: 'inspect', receiptDir: undefined, interactive: false, codeIdentity: true });
  assert.deepEqual(parseArgs(['--apply', '--interactive', '--code-identity', '--receipt-dir', '/private/receipts']),
    { mode: 'apply', receiptDir: '/private/receipts', interactive: true, codeIdentity: true });
  for (const args of [['--code-identity', '--code-identity'], ['--code-identity=other'], ['--cdhash', 'other'],
    ['--binary', '/unsafe/gog'], ['--code-identity', '--interactive'], ['--verify', '--code-identity']]) assert.throws(() => parseArgs(args));
  assert.throws(() => parseArgs(['--apply', '--code-identity', '--receipt-dir', '/private/receipts']), /CODE_IDENTITY_APPLY_REQUIRES_INTERACTIVE/);
  for (const interactive of [[], ['--interactive']]) assert.throws(() => parseArgs([
    '--rollback', '--code-identity', '--receipt-dir', '/private/receipts', ...interactive]), /NATIVE_PARTITION_ROLLBACK_REQUIRES_OPERATOR/);
});
test('snapshot is a separate fixed-scope observation with no plan or interactive authorization', () => {
  assert.deepEqual(parseArgs(['--snapshot']), { mode: 'snapshot', receiptDir: undefined, interactive: false, codeIdentity: false });
  assert.deepEqual(parseArgs(['--snapshot', '--receipt-dir', '/private/receipts']),
    { mode: 'snapshot', receiptDir: '/private/receipts', interactive: false, codeIdentity: false });
  for (const args of [['--snapshot', '--interactive'], ['--snapshot', '--code-identity'], ['--snapshot', '--dry-run'],
    ['--snapshot', '--apply'], ['--snapshot', '--snapshot'], ['--snapshot', '--account', 'another@example.com']]) {
    assert.throws(() => parseArgs(args));
  }
});
test('snapshot wrapper makes one noninteractive observation without reading or creating a plan or lock', () => {
  const script = path.join(__dirname, '../scripts/authorize-pinned-gog-keychain.cjs');
  const source = fs.readFileSync(script, 'utf8');
  const fixture = { schemaVersion: 'jobtrack-gog-keychain-snapshot.v1', mode: 'snapshot',
    aliases: [{ label: 'primary', modifiedAt: '2026-09-08T21:29:07.000Z' }], credentialDataRead: false, credentialDataWritten: false };
  const calls = []; const output = []; let pins = 0;
  const mod = { exports: {} };
  vm.runInNewContext(`${source}\nmodule.exports.mainForTest = main; module.exports.invokeForTest = invoke;`, {
    module: mod, __dirname: path.dirname(script), process: { stdout: { write: text => output.push(text) } },
    require(name) {
      if (name === 'node:fs') return new Proxy({}, { get() { assert.fail('snapshot without receipts must not access filesystem plans or locks'); } });
      if (name === 'node:child_process') return { spawnSync(executable, args, options) {
        calls.push({ executable, args: Array.from(args), options });
        return { status: 0, stdout: JSON.stringify(fixture), stderr: '' };
      } };
      if (name === './lib/pinned-gog.cjs') return { resolvePinnedGog() { pins++; } };
      if (name === '../lib/private-source-boundary.js') return { assertPathNotPrivateJournalSource() {} };
      return require(name);
    }
  });
  mod.exports.mainForTest(['--snapshot']);
  assert.equal(pins, 2);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['-suppress-warnings', path.join(path.dirname(script), 'lib/gog-keychain-acl.swift'), 'snapshot']);
  assert.equal(calls[0].options.input, undefined);
  assert.equal(calls[0].options.timeout, 30000);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(JSON.parse(output.join('')), fixture);
  assert.throws(() => mod.exports.invokeForTest('snapshot', {}), /SNAPSHOT_DOES_NOT_ACCEPT_A_PLAN/);
  assert.equal(calls.length, 1);
});
test('fresh snapshot branch precedes all trusted-app creation and mutation-plan handling', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/lib/gog-keychain-acl.swift'), 'utf8');
  const fresh = source.split('// BEGIN FRESH METADATA SNAPSHOT (fixed aliases, attributes/references only).')[1]
    .split('// END FRESH METADATA SNAPSHOT')[0];
  assert.match(fresh, /targets\.map/);
  assert.match(fresh, /kSecAttrService as String: "gogcli", kSecAttrAccount as String: key/);
  assert.match(fresh, /kSecMatchSearchList as String: \[keychain\], kSecReturnRef as String: true/);
  assert.match(fresh, /kSecReturnAttributes as String: true/);
  assert.match(fresh, /items\.count == 1/);
  assert.match(fresh, /kSecAttrModificationDate/);
  assert.doesNotMatch(fresh, /mutateInMemory|runNativePartition|SetAccess|SetContents|kSecReturnData/);
  const run = source.slice(source.indexOf('func run() throws {'));
  assert.ok(run.indexOf('SecKeychainSetUserInteractionAllowed') < run.indexOf('if mode == "snapshot"'));
  assert.ok(run.indexOf('if mode == "snapshot"') < run.indexOf('SecTrustedApplicationCreateFromPath'));
  assert.ok(run.indexOf('if mode == "snapshot"') < run.indexOf('mutateInMemory'));
  assert.match(source, /validation\.arguments = \["--verify", "--strict", binary\]/);
});
test('actual Swift snapshot logic queries exactly three aliases and rejects incomplete or ambiguous metadata with mocked Security calls', { skip: process.platform !== 'darwin' }, () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/lib/gog-keychain-acl.swift'), 'utf8');
  const fresh = source.split('// BEGIN FRESH METADATA SNAPSHOT (fixed aliases, attributes/references only).')[1]
    .split('// END FRESH METADATA SNAPSHOT')[0];
  const structs = source.slice(source.indexOf('struct ACL:'), source.indexOf('struct Plan:'));
  const swift = `import Foundation
import CoreFoundation
let binary = "/fixture/approved/gog"
let expectedHash = "fixture-pinned-sha256"
let expectedCDHash = "fixture-pinned-cdhash"
let loginKeychainPath = "/fixture/login.keychain-db"
let targets = [("primary", "token:default:scshafe@umich.edu"), ("legacy", "token:scshafe@umich.edu"), ("subject", "token-sub:default:114064574647921073534")]
typealias OSStatus = Int32
typealias SecKeychain = String
typealias SecKeychainItem = String
typealias SecAccess = String
struct Failure: Error { let code: String; let status: OSStatus? }
func require(_ condition: Bool, _ code: String) throws { if !condition { throw Failure(code: code, status: nil) } }
func checked(_ status: OSStatus, _ code: String) throws { if status != 0 { throw Failure(code: code, status: status) } }
${structs}
let kSecClass = "class", kSecClassGenericPassword = "generic", kSecAttrService = "service", kSecAttrAccount = "account"
let kSecMatchSearchList = "search", kSecReturnRef = "reference", kSecReturnAttributes = "attributes", kSecMatchLimit = "limit", kSecMatchLimitAll = "all"
let kSecAttrModificationDate = "modified", kSecValueRef = "valueRef"
var keys: [String] = []; var copied: [String] = []; var failure = ""
let fixtureAccess = Access(uid: 501, gid: 20, ownerType: 0,
    acls: [ACL(authorizations: ["ACLAuthorizationPartitionID"], description: "fixture-partition-description", prompt: 0, applications: nil)])
func snapshot(_ access: SecAccess) throws -> Access { try require(access == "fixture-access", "unexpected access"); return fixtureAccess }
func SecKeychainItemGetTypeID() -> CFTypeID { CFStringGetTypeID() }
func SecItemCopyMatching(_ query: CFDictionary, _ result: inout CFTypeRef?) -> OSStatus {
    let value = query as NSDictionary
    let key = value[kSecAttrAccount] as! String
    precondition(targets.map { $0.1 }.contains(key))
    precondition(value.count == 7 && value[kSecClass] as? String == kSecClassGenericPassword
        && value[kSecAttrService] as? String == "gogcli" && value[kSecMatchSearchList] as? [String] == [loginKeychainPath]
        && value[kSecReturnRef] as? Bool == true && value[kSecReturnAttributes] as? Bool == true
        && value[kSecMatchLimit] as? String == kSecMatchLimitAll)
    keys.append(key)
    if failure == "status" { return -1 }
    var attributes: [String: Any] = [kSecAttrModificationDate: Date(timeIntervalSince1970: 1000), kSecValueRef: "fixture-reference"]
    if failure == "date" { attributes.removeValue(forKey: kSecAttrModificationDate) }
    if failure == "reference" { attributes[kSecValueRef] = 42 }
    result = (failure == "duplicate" ? [attributes, attributes] : failure == "missing" ? [] : [attributes]) as CFArray
    return 0
}
func SecKeychainItemCopyAccess(_ item: SecKeychainItem, _ access: inout SecAccess?) -> OSStatus {
    copied.append(item); access = failure == "access" ? nil : "fixture-access"; return 0
}
${fresh}
let observed = try freshMetadataSnapshot(loginKeychainPath)
try require(keys == targets.map { $0.1 } && copied == Array(repeating: "fixture-reference", count: 3), "query scope changed")
try require(observed.aliases.count == 3 && !observed.credentialDataRead && !observed.credentialDataWritten, "snapshot shape changed")
for (index, alias) in observed.aliases.enumerated() {
    try require(alias.label == targets[index].0 && alias.accountKey == targets[index].1
        && alias.modifiedAt == "1970-01-01T00:16:40.000Z" && alias.access == fixtureAccess, "metadata changed")
}
for bad in ["status", "date", "reference", "duplicate", "missing", "access"] {
    failure = bad; keys = []; copied = []
    do { _ = try freshMetadataSnapshot(loginKeychainPath); fatalError("expected snapshot failure") } catch {}
    try require(keys.count == 1, "snapshot failed to stop at first invalid alias")
}
print("metadata snapshot regression passed")
`;
  // Real production snapshot logic, but every Security API is a local stub.
  // No Security import, Keychain access, credential bytes, or live mutations.
  const result = spawnSync('/usr/bin/swift', ['-suppress-warnings', '-'], { input: swift, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /metadata snapshot regression passed/);
});
test('helper uses metadata references only and has no credential-value, unlock or broad ACL-reset operation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/lib/gog-keychain-acl.swift'), 'utf8');
  assert.match(source, /kSecReturnRef as String: true/);
  assert.match(source, /!interactive \|\| mode == "apply"/);
  assert.match(source, /SecKeychainSetUserInteractionAllowed\(interactive && scope == "app-trust"\)/);
  assert.doesNotMatch(source, /kSecReturnData|SecKeychainItemCopyContent|SecKeychainItemModifyContent|SecKeychainUnlock|SecItemAdd|SecItemUpdate|SecItemDelete|SecAccessCreate|SecACLRemove|SecACLUpdateAuthorizations/);
  assert.match(source, /SecACLSetContents\(acl, apps as CFArray, description, prompt\)/);
  assert.match(source, /try runNativePartition\(nativePartitionArguments\(index, keychainPath, description\), terminal\)/);
  assert.match(source, /else \{\s*try require\(scope == "app-trust", "UNKNOWN_MUTATION_SCOPE"\)\s*let status = SecKeychainItemSetAccess/);
  assert.match(source, /posix_spawn\(&pid, "\/usr\/bin\/security", &actions, nil, args.baseAddress!, vars.baseAddress!\)/);
  assert.match(source, /posix_spawn_file_actions_addopen\(&actions, STDOUT_FILENO, "\/dev\/null", O_WRONLY, 0\)/);
  assert.doesNotMatch(source, /getpass\(|readPassword|"-k"|getenv\(|ProcessInfo.processInfo.environment/);
});
test('runtime-mocked wrapper refuses missing tty and only forwards interactive apply metadata to Swift', () => {
  const script = path.join(__dirname, '../scripts/authorize-pinned-gog-keychain.cjs');
  const text = fs.readFileSync(script, 'utf8');
  let ttyAvailable = false; let closed = 0; const calls = [];
  const mod = { exports: {} };
  vm.runInNewContext(`${text}\nmodule.exports.invokeForTest = invoke;`, {
    module: mod, __dirname: path.dirname(script), process,
    require(name) {
      if (name === 'node:fs') return { constants: fs.constants, openSync(file) {
        assert.equal(file, '/dev/tty'); if (!ttyAvailable) throw new Error('ENXIO'); return 41;
      }, closeSync(fd) { assert.equal(fd, 41); closed++; } };
      if (name === 'node:tty') return { isatty: () => ttyAvailable };
      if (name === 'node:child_process') return { spawnSync(executable, args, options) {
        calls.push({ executable, args: Array.from(args), options }); return { status: 0, stdout: '{}', stderr: '' };
      } };
      if (name === './lib/pinned-gog.cjs') return { resolvePinnedGog() {} };
      if (name === '../lib/private-source-boundary.js') return { assertPathNotPrivateJournalSource() {} };
      return require(name);
    }
  });
  const invoke = mod.exports.invokeForTest;
  assert.throws(() => invoke('apply', {}, true, true), /NATIVE_PARTITION_CONTROLLING_TERMINAL_REQUIRED/);
  assert.equal(calls.length, 0);
  ttyAvailable = true;
  invoke('apply', { metadata: 'only' }, true, true);
  assert.equal(closed, 1);
  assert.equal(calls[0].executable, '/usr/bin/swift');
  assert.deepEqual(calls[0].args, ['-suppress-warnings', path.join(path.dirname(script), 'lib/gog-keychain-acl.swift'), 'apply', '--interactive', '--code-identity']);
  assert.equal(calls[0].options.input, '{"metadata":"only"}');
  assert.equal(calls[0].options.timeout, undefined);
  assert.throws(() => invoke('rollback', {}, true, true), /NATIVE_PARTITION_ROLLBACK_REQUIRES_OPERATOR/);
  assert.equal(calls.length, 1);
  invoke('verify', {}, false, true);
  assert.equal(calls[1].options.timeout, 30000);
});
test('actual Swift partition transform preserves unknown plist values/order and restores exact original bytes', { skip: process.platform !== 'darwin' }, () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/lib/gog-keychain-acl.swift'), 'utf8');
  const begin = '// BEGIN PURE PARTITION TRANSFORM (exercised without Keychain by unit tests).';
  const end = '// END PURE PARTITION TRANSFORM';
  const transform = source.split(begin)[1]?.split(end)[0];
  assert.ok(transform);
  const swift = `import Foundation
let expectedCDHash = "90007e64658051c2c6da3e5310f56e29c6808c86"
struct Failure: Error { let code: String; let status: Int32? }
func require(_ condition: Bool, _ code: String) throws { if !condition { throw Failure(code: code, status: nil) } }
${transform}
func hex(_ properties: [String: Any], _ format: PropertyListSerialization.PropertyListFormat) throws -> String {
    try PropertyListSerialization.data(fromPropertyList: properties, format: format, options: 0).map { String(format: "%02x", $0) }.joined()
}
func expectFailure(_ body: () throws -> Void) { do { try body(); fatalError("expected rejection") } catch {} }
let original: [String: Any] = ["Partitions": ["cdhash:existing", "teamid:already-existing"],
    "Unknown": ["bytes": Data([0, 1, 255]), "date": Date(timeIntervalSince1970: 1000),
        "bool": true, "number": 7, "real": 0.125, "nested": ["preserve", "order"]]]
for format in [PropertyListSerialization.PropertyListFormat.xml, .binary] {
    let before = try hex(original, format)
    let after = try partitionChange(before, remove: false)
    let (decoded, observedFormat) = try decodePartition(after)
    var expected = original
    expected["Partitions"] = ["cdhash:existing", "teamid:already-existing", "cdhash:" + expectedCDHash]
    try require(NSDictionary(dictionary: expected).isEqual(to: decoded) && observedFormat == format, "unknown metadata changed")
    try require(try partitionChange(after, remove: true, restore: before) == before, "rollback changed original bytes")
    expectFailure { _ = try partitionChange(after, remove: false) }
    expectFailure { _ = try partitionChange(before, remove: true, restore: before) }
    var wrong = original; wrong["Unknown"] = "tampered"
    expectFailure { _ = try partitionChange(after, remove: true, restore: hex(wrong, format)) }
}
for bad in ["", "0", "zz", try hex(["Partitions": "not-array"], .xml), try hex(["Other": []], .xml)] {
    expectFailure { _ = try partitionChange(bad, remove: false) }
}
print("partition transform regression passed")
`;
  // Only the pure Foundation transform is evaluated: no Security imports or
  // Keychain calls, token reads, filesystem receipts, or live ACL mutations.
  const result = spawnSync('/usr/bin/swift', ['-'], { input: swift, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /partition transform regression passed/);
});
test('actual Swift native guards pin command targets and reject metadata the Apple CLI cannot preserve exactly', { skip: process.platform !== 'darwin' }, () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/lib/gog-keychain-acl.swift'), 'utf8');
  const transform = source.split('// BEGIN PURE PARTITION TRANSFORM (exercised without Keychain by unit tests).')[1].split('// END PURE PARTITION TRANSFORM')[0];
  const native = source.split('// BEGIN NATIVE PARTITION GUARDS (pure metadata; no Keychain or password access).')[1].split('// END NATIVE PARTITION GUARDS')[0];
  const swift = `import Foundation
let expectedCDHash = "90007e64658051c2c6da3e5310f56e29c6808c86"
let loginKeychainPath = "/home/user/Library/Keychains/login.keychain-db"
let targets = [("primary", "token:default:scshafe@umich.edu"), ("legacy", "token:scshafe@umich.edu"), ("subject", "token-sub:default:114064574647921073534")]
struct Failure: Error { let code: String; let status: Int32? }
func require(_ condition: Bool, _ code: String) throws { if !condition { throw Failure(code: code, status: nil) } }
${transform}
${native}
func hex(_ properties: [String: Any], _ format: PropertyListSerialization.PropertyListFormat = .xml) throws -> String {
    try PropertyListSerialization.data(fromPropertyList: properties, format: format, options: 0).map { String(format: "%02x", $0) }.joined()
}
func reject(_ body: () throws -> Void) { do { try body(); fatalError("expected rejection") } catch {} }
let old = "cdhash:fc8404367d969ce8c1bef38d671dd27f4bce949e"
let before = try hex(["Partitions": [old]])
let after = try partitionChange(before, remove: false)
try validateNativePartitionPair(before, after)
for index in targets.indices {
    let args = try nativePartitionArguments(index, loginKeychainPath, after)
    try require(args == ["set-generic-password-partition-list", "-a", targets[index].1, "-s", "gogcli", "-S", old + ",cdhash:" + expectedCDHash, loginKeychainPath], "command scope changed")
    try require(!args.contains("-k"), "password argument forbidden")
}
reject { _ = try nativePartitionArguments(3, loginKeychainPath, after) }
reject { _ = try nativePartitionArguments(0, "/another/keychain", after) }
reject { try validateNativePartitionPair(before, before) }
reject { try validateNativePartitionPair(before, hex(["Partitions": [old, "apple:", "cdhash:" + expectedCDHash]])) }
reject { try validateNativePartitionPair(before, hex(["Partitions": ["cdhash:" + expectedCDHash, old]])) }
reject { _ = try nativePartitionList(hex(["Partitions": [old], "Unknown": "must preserve"])) }
reject { _ = try nativePartitionList(hex(["Partitions": [old]], .binary)) }
reject { _ = try nativePartitionList(before.uppercased()) }
reject { _ = try nativePartitionList("20" + before) }
for partitions in [[], [""], [old, old], ["cdhash:bad,apple:"], ["bad\\nvalue"]] {
    reject { _ = try nativePartitionList(hex(["Partitions": partitions])) }
}
print("native partition guards passed")
`;
  const result = spawnSync('/usr/bin/swift', ['-suppress-warnings', '-'], { input: swift, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /native partition guards passed/);
});
