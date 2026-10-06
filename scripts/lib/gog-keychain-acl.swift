// Metadata-only operator utility. No token-value query, export, or replacement.
import Foundation
import Security
import CryptoKit
import Darwin

let schema = "jobtrack-gog-keychain-acl-plan.v1"
let expectedHash = "d2fed1e9a561be788c9b55d40be8c1267f093fe559942d6c8734cea4d3130e30"
let expectedCDHash = "53d5aabb3c49523d1534762f90e67191b6161777"
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
let binary = root + "/.tools/gog/jobtrack-single-attempt-v3-darwin-arm64/gog"
let loginKeychainPath = FileManager.default.homeDirectoryForCurrentUser.path + "/Library/Keychains/login.keychain-db"
let targets = [("primary", "token:default:scshafe@umich.edu"),
               ("legacy", "token:scshafe@umich.edu"),
               ("subject", "token-sub:default:114064574647921073534")]
struct Failure: Error { let code: String; let status: OSStatus? }
func require(_ condition: Bool, _ code: String) throws { if !condition { throw Failure(code: code, status: nil) } }
func checked(_ status: OSStatus, _ code: String) throws {
    if status != errSecSuccess { throw Failure(code: code, status: status) }
}
let encoder: JSONEncoder = { let e = JSONEncoder(); e.outputFormatting = [.sortedKeys]; return e }()
struct ACL: Codable, Equatable {
    let authorizations: [String]
    let description: String?
    let prompt: UInt16
    var applications: [String]? // SecTrustedApplicationCopyData bytes, NOT credential bytes.
}
struct Access: Codable, Equatable {
    let uid: UInt32
    let gid: UInt32
    let ownerType: UInt32
    let acls: [ACL]
}
struct Target: Codable, Equatable { let label: String; let accountKey: String; let access: Access }
struct SnapshotTarget: Codable {
    let label: String
    let accountKey: String
    let modifiedAt: String
    let access: Access
}
struct MetadataSnapshot: Codable {
    let schemaVersion = "jobtrack-gog-keychain-snapshot.v1"
    let mode = "snapshot"
    let observedAt: String
    let binaryPath = binary
    let binarySha256 = expectedHash
    let binaryCDHash = expectedCDHash
    let keychainPath = loginKeychainPath
    let aliases: [SnapshotTarget]
    let credentialDataRead = false
    let credentialDataWritten = false
}
struct Plan: Codable, Equatable {
    let schemaVersion: String
    let mutationScope: String? // Missing only in the original app-trust receipts.
    let binaryPath: String
    let binarySha256: String
    let binaryCDHash: String?
    let keychainPath: String
    let before: [Target]
    let after: [Target]
}
struct OpenTarget {
    let label: String
    let key: String
    let item: SecKeychainItem
    let access: SecAccess
}
func trustedData(_ application: SecTrustedApplication) throws -> String {
    var data: CFData?
    try checked(SecTrustedApplicationCopyData(application, &data), "TRUST_METADATA_FAILED")
    guard let data = data else { throw Failure(code: "TRUST_METADATA_MISSING", status: nil) }
    return (data as Data).base64EncodedString()
}
func contents(_ acl: SecACL) throws -> ([SecTrustedApplication]?, CFString?, SecKeychainPromptSelector) {
    var applications: CFArray?; var description: CFString?
    var prompt = SecKeychainPromptSelector(rawValue: 0)
    try checked(SecACLCopyContents(acl, &applications, &description, &prompt), "ACL_CONTENTS_FAILED")
    if applications != nil { try require(applications is [SecTrustedApplication], "ACL_APPLICATION_TYPE_INVALID") }
    return (applications as? [SecTrustedApplication], description, prompt)
}
func aclList(_ access: SecAccess) throws -> [SecACL] {
    var list: CFArray?
    try checked(SecAccessCopyACLList(access, &list), "ACL_LIST_FAILED")
    guard let result = list as? [SecACL] else { throw Failure(code: "ACL_LIST_INVALID", status: nil) }
    return result
}
func snapshot(_ access: SecAccess) throws -> Access {
    var uid: uid_t = 0; var gid: gid_t = 0; var owner: SecAccessOwnerType = 0
    try checked(SecAccessCopyOwnerAndACL(access, &uid, &gid, &owner, nil), "ACL_OWNER_FAILED")
    var values: [ACL] = []
    for acl in try aclList(access) {
        let (apps, description, prompt) = try contents(acl)
        guard let authorizations = SecACLCopyAuthorizations(acl) as? [String] else { throw Failure(code: "ACL_AUTHORIZATIONS_INVALID", status: nil) }
        values.append(ACL(authorizations: authorizations.sorted(), description: description as String?,
                          prompt: prompt.rawValue, applications: try apps?.map(trustedData)))
    }
    // ACL ordering has no authorization meaning; preserve all values and nulls.
    values.sort { String(data: try! encoder.encode($0), encoding: .utf8)! < String(data: try! encoder.encode($1), encoding: .utf8)! }
    return Access(uid: uid, gid: gid, ownerType: owner, acls: values)
}
func openTargets(_ keychain: SecKeychain) throws -> [OpenTarget] {
    try targets.map { label, key in
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "gogcli", kSecAttrAccount as String: key,
            kSecMatchSearchList as String: [keychain], kSecReturnRef as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll]
        var result: CFTypeRef?
        try checked(SecItemCopyMatching(query as CFDictionary, &result), "EXISTING_ALIAS_LOOKUP_FAILED_" + label)
        guard let items = result as? [SecKeychainItem], items.count == 1 else { throw Failure(code: "EXISTING_ALIAS_NOT_UNIQUE_" + label, status: nil) }
        var access: SecAccess?
        try checked(SecKeychainItemCopyAccess(items[0], &access), "ACCESS_COPY_FAILED_" + label)
        guard let access = access else { throw Failure(code: "ACCESS_MISSING_" + label, status: nil) }
        return OpenTarget(label: label, key: key, item: items[0], access: access)
    }
}
func targetSnapshot(_ value: OpenTarget) throws -> Target { Target(label: value.label, accountKey: value.key, access: try snapshot(value.access)) }
// BEGIN FRESH METADATA SNAPSHOT (fixed aliases, attributes/references only).
func freshMetadataSnapshot(_ keychain: SecKeychain) throws -> MetadataSnapshot {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let aliases: [SnapshotTarget] = try targets.map { label, key in
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "gogcli", kSecAttrAccount as String: key,
            kSecMatchSearchList as String: [keychain], kSecReturnRef as String: true,
            kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
        var result: CFTypeRef?
        try checked(SecItemCopyMatching(query as CFDictionary, &result), "SNAPSHOT_ALIAS_LOOKUP_FAILED_" + label)
        guard let items = result as? [[String: Any]], items.count == 1,
              let modifiedAt = items[0][kSecAttrModificationDate as String] as? Date,
              let reference = items[0][kSecValueRef as String] else {
            throw Failure(code: "SNAPSHOT_ALIAS_METADATA_INVALID_" + label, status: nil)
        }
        try require(CFGetTypeID(reference as CFTypeRef) == SecKeychainItemGetTypeID(), "SNAPSHOT_ITEM_REFERENCE_INVALID_" + label)
        let item = reference as! SecKeychainItem
        var access: SecAccess?
        try checked(SecKeychainItemCopyAccess(item, &access), "SNAPSHOT_ACCESS_COPY_FAILED_" + label)
        guard let access = access else { throw Failure(code: "SNAPSHOT_ACCESS_MISSING_" + label, status: nil) }
        return SnapshotTarget(label: label, accountKey: key, modifiedAt: formatter.string(from: modifiedAt),
                              access: try snapshot(access))
    }
    // This is a sequential observation, not a transaction or authorization plan.
    return MetadataSnapshot(observedAt: formatter.string(from: Date()), aliases: aliases)
}
// END FRESH METADATA SNAPSHOT
func verifyBinary() throws {
    var metadata = stat()
    try require(lstat(binary, &metadata) == 0 && (metadata.st_mode & S_IFMT) == S_IFREG
        && metadata.st_uid == getuid() && (metadata.st_mode & 0o022) == 0
        && URL(fileURLWithPath: binary).resolvingSymlinksInPath().path == binary, "PINNED_BINARY_UNSAFE")
    let bytes = try Data(contentsOf: URL(fileURLWithPath: binary))
    let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    try require(hash == expectedHash, "PINNED_BINARY_HASH_MISMATCH")
    let process = Process(); let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
    process.arguments = ["-d", "--verbose=3", binary]
    process.standardError = output; process.standardOutput = FileHandle.nullDevice
    try process.run()
    let metadataBytes = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let lines = String(data: metadataBytes, encoding: .utf8)?.split(separator: "\n").filter { $0.hasPrefix("CDHash=") } ?? []
    try require(process.terminationStatus == 0 && lines.count == 1 && lines[0] == "CDHash=" + expectedCDHash,
                "PINNED_CODE_IDENTITY_MISMATCH")
    let validation = Process()
    validation.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
    validation.arguments = ["--verify", "--strict", binary]
    validation.standardError = FileHandle.nullDevice; validation.standardOutput = FileHandle.nullDevice
    try validation.run(); validation.waitUntilExit()
    try require(validation.terminationStatus == 0, "PINNED_CODE_SIGNATURE_INVALID")
}
// BEGIN PURE PARTITION TRANSFORM (exercised without Keychain by unit tests).
func decodePartition(_ description: String) throws -> ([String: Any], PropertyListSerialization.PropertyListFormat) {
    let characters = Array(description)
    try require(!characters.isEmpty && characters.count % 2 == 0 && characters.count < 100000, "PARTITION_DESCRIPTION_INVALID")
    var bytes = Data()
    for index in stride(from: 0, to: characters.count, by: 2) {
        guard let byte = UInt8(String(characters[index...index+1]), radix: 16) else { throw Failure(code: "PARTITION_DESCRIPTION_INVALID", status: nil) }
        bytes.append(byte)
    }
    var format = PropertyListSerialization.PropertyListFormat.xml
    guard let properties = try PropertyListSerialization.propertyList(from: bytes, options: [], format: &format) as? [String: Any],
          properties["Partitions"] is [String] else { throw Failure(code: "PARTITION_PLIST_INVALID", status: nil) }
    try require(format == .xml || format == .binary, "PARTITION_PLIST_FORMAT_UNSUPPORTED")
    return (properties, format)
}
func partitionChange(_ description: String, remove: Bool, restore: String? = nil) throws -> String {
    var (properties, format) = try decodePartition(description)
    var partitions = properties["Partitions"] as! [String]
    let identity = "cdhash:" + expectedCDHash
    if remove {
        try require(partitions.filter { $0 == identity }.count == 1, "ROLLBACK_CODE_IDENTITY_NOT_UNIQUE")
        partitions.removeAll { $0 == identity }
    } else {
        try require(!partitions.contains(identity), "CODE_IDENTITY_ALREADY_AUTHORIZED")
        partitions.append(identity)
    }
    properties["Partitions"] = partitions
    if remove {
        guard let restore = restore else { throw Failure(code: "ROLLBACK_PARTITION_DESCRIPTION_REQUIRED", status: nil) }
        let (original, _) = try decodePartition(restore)
        try require(NSDictionary(dictionary: properties).isEqual(to: original), "ROLLBACK_PARTITION_DELTA_NOT_EXACT")
        return restore // Restore original bytes, including plist formatting.
    }
    // Preserve the original plist format, every unknown key/value and all old
    // partitions in order. No generic apple:/apple-tool:/teamid grant is added.
    let bytes = try PropertyListSerialization.data(fromPropertyList: properties, format: format, options: 0)
    let updated = bytes.map { String(format: "%02x", $0) }.joined()
    let (roundTrip, _) = try decodePartition(updated)
    try require(NSDictionary(dictionary: properties).isEqual(to: roundTrip), "PARTITION_ROUND_TRIP_CHANGED_METADATA")
    return updated
}
// END PURE PARTITION TRANSFORM
// BEGIN NATIVE PARTITION GUARDS (pure metadata; no Keychain or password access).
func nativePartitionList(_ description: String) throws -> [String] {
    let (properties, format) = try decodePartition(description)
    try require(format == .xml && Set(properties.keys) == Set(["Partitions"]), "NATIVE_PARTITION_METADATA_UNSUPPORTED")
    let partitions = properties["Partitions"] as! [String]
    try require(!partitions.isEmpty && Set(partitions).count == partitions.count
        && partitions.allSatisfy { !$0.isEmpty && $0.utf8.allSatisfy { $0 > 32 && $0 < 127 && $0 != 44 } }, "NATIVE_PARTITION_LIST_INVALID")
    // Mirror Apple's CLI serialization exactly. The CLI replaces this entire
    // description, so reject unknown keys, binary plists and different framing.
    guard let xml = CFPropertyListCreateXMLData(nil, ["Partitions": partitions] as CFDictionary)?.takeRetainedValue() else {
        throw Failure(code: "NATIVE_PARTITION_SERIALIZATION_FAILED", status: nil)
    }
    let exact = (xml as Data).map { String(format: "%02x", $0) }.joined()
    try require(exact == description, "NATIVE_PARTITION_SERIALIZATION_NOT_EXACT")
    return partitions
}
func validateNativePartitionPair(_ before: String, _ after: String) throws {
    let old = try nativePartitionList(before)
    let new = try nativePartitionList(after)
    try require(!old.contains("cdhash:" + expectedCDHash) && new == old + ["cdhash:" + expectedCDHash], "NATIVE_PARTITION_DELTA_NOT_EXACT")
}
func nativePartitionArguments(_ index: Int, _ keychainPath: String, _ description: String) throws -> [String] {
    try require(targets.indices.contains(index) && keychainPath == loginKeychainPath, "NATIVE_PARTITION_SCOPE_MISMATCH")
    return ["set-generic-password-partition-list", "-a", targets[index].1, "-s", "gogcli",
        "-S", try nativePartitionList(description).joined(separator: ","), keychainPath]
}
// END NATIVE PARTITION GUARDS
// BEGIN NATIVE TERMINAL EXECUTION (no credential bytes enter this process).
func nativeTerminal() throws -> FileHandle {
    let fd = open("/dev/tty", O_RDWR | O_NOCTTY | O_CLOEXEC)
    try require(fd >= 0, "NATIVE_PARTITION_CONTROLLING_TERMINAL_REQUIRED")
    guard isatty(fd) == 1 && tcgetpgrp(fd) == getpgrp() else {
        close(fd)
        throw Failure(code: "NATIVE_PARTITION_FOREGROUND_TERMINAL_REQUIRED", status: nil)
    }
    return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
}
func runNativePartition(_ arguments: [String], _ terminal: FileHandle) throws {
    let fd = terminal.fileDescriptor
    try require(isatty(fd) == 1 && tcgetpgrp(fd) == getpgrp(), "NATIVE_PARTITION_FOREGROUND_TERMINAL_REQUIRED")
    var actions: posix_spawn_file_actions_t?
    try checked(posix_spawn_file_actions_init(&actions), "NATIVE_PARTITION_SPAWN_SETUP_FAILED")
    defer { posix_spawn_file_actions_destroy(&actions) }
    try checked(posix_spawn_file_actions_adddup2(&actions, fd, STDIN_FILENO), "NATIVE_PARTITION_SPAWN_SETUP_FAILED")
    try checked(posix_spawn_file_actions_adddup2(&actions, fd, STDERR_FILENO), "NATIVE_PARTITION_SPAWN_SETUP_FAILED")
    try checked(posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0), "NATIVE_PARTITION_SPAWN_SETUP_FAILED")
    let argv = (["/usr/bin/security"] + arguments).map { strdup($0) } + [nil]
    // Do not inherit caller credential variables, loader overrides or selectors.
    let environment: [String] = ["PATH=/usr/bin:/bin", "LANG=en_US.UTF-8"]
    let env = environment.map { strdup($0) } + [nil]
    defer { for pointer in argv + env { free(pointer) } }
    try require(argv.dropLast().allSatisfy { $0 != nil } && env.dropLast().allSatisfy { $0 != nil }, "NATIVE_PARTITION_ALLOCATION_FAILED")
    var pid: pid_t = 0
    let launched = argv.withUnsafeBufferPointer { args in env.withUnsafeBufferPointer { vars in
        // No SETPGROUP/SETSID: Apple getpass must remain in our foreground group.
        posix_spawn(&pid, "/usr/bin/security", &actions, nil, args.baseAddress!, vars.baseAddress!)
    } }
    try checked(launched, "NATIVE_PARTITION_SPAWN_FAILED")
    var status: Int32 = 0
    while waitpid(pid, &status, 0) < 0 {
        if errno == EINTR { continue } // Wait again; NEVER launch another command.
        throw Failure(code: "NATIVE_PARTITION_WAIT_FAILED_VERIFY_SAVED_PLAN", status: nil)
    }
    try require(status == 0, "NATIVE_PARTITION_AUTHORIZATION_FAILED_VERIFY_SAVED_PLAN")
}
// END NATIVE TERMINAL EXECUTION
func mutateInMemory(_ access: SecAccess, application: SecTrustedApplication, remove: Bool,
                    scope: String, restorePartition: String? = nil) throws {
    let targetData = try trustedData(application)
    let decrypt = try aclList(access).filter { (SecACLCopyAuthorizations($0) as? [String] ?? []).contains("ACLAuthorizationDecrypt") }
    try require(decrypt.count == 1, "DECRYPT_ACL_NOT_UNIQUE")
    let acl = decrypt[0]
    let (apps, description, prompt) = try contents(acl)
    guard var apps = apps, let description = description else { throw Failure(code: "DECRYPT_ACL_NOT_EXPLICIT", status: nil) }
    let existing = try apps.map(trustedData)
    try require(Set(existing).count == existing.count, "DUPLICATE_TRUSTED_APPLICATION")
    if scope == "code-identity" {
        try require(existing.filter { $0 == targetData }.count == 1, "PINNED_APPLICATION_TRUST_REQUIRED")
        let entries = try aclList(access).filter { (SecACLCopyAuthorizations($0) as? [String] ?? []).contains("ACLAuthorizationPartitionID") }
        try require(entries.count == 1, "PARTITION_ACL_NOT_UNIQUE")
        let partitionACL = entries[0]
        let (partitionApps, partitionDescription, partitionPrompt) = try contents(partitionACL)
        guard let partitionDescription = partitionDescription else { throw Failure(code: "PARTITION_DESCRIPTION_MISSING", status: nil) }
        let changed = try partitionChange(partitionDescription as String, remove: remove, restore: restorePartition)
        try checked(SecACLSetContents(partitionACL, partitionApps.map { $0 as CFArray }, changed as CFString, partitionPrompt), "LOCAL_PARTITION_EDIT_FAILED")
        return
    }
    try require(scope == "app-trust", "UNKNOWN_MUTATION_SCOPE")
    if remove {
        try require(existing.filter { $0 == targetData }.count == 1, "ROLLBACK_APPLICATION_NOT_UNIQUE")
        apps = try apps.filter { try trustedData($0) != targetData }
    } else {
        try require(!existing.contains(targetData), "PINNED_APPLICATION_ALREADY_AUTHORIZED")
        apps.append(application)
    }
    // Preserve the original trusted application OBJECTS, all authorization tags,
    // description, prompt selector, owner, and every other existing ACL.
    try checked(SecACLSetContents(acl, apps as CFArray, description, prompt), "LOCAL_ACL_EDIT_FAILED")
}
func run() throws {
    let arguments = Array(CommandLine.arguments.dropFirst())
    try require((1...3).contains(arguments.count) && ["snapshot", "inspect", "verify", "apply", "rollback"].contains(arguments[0]), "INVALID_MODE")
    let mode = arguments[0]
    let flags = Array(arguments.dropFirst())
    try require(Set(flags).count == flags.count && flags.allSatisfy { ["--interactive", "--code-identity"].contains($0) }, "INVALID_FLAGS")
    let interactive = flags.contains("--interactive")
    let scope = flags.contains("--code-identity") ? "code-identity" : "app-trust"
    try require(mode != "snapshot" || flags.isEmpty, "SNAPSHOT_IS_NONINTERACTIVE_METADATA_ONLY")
    try require(!(scope == "code-identity" && mode == "rollback"), "NATIVE_PARTITION_ROLLBACK_REQUIRES_OPERATOR")
    try require(!interactive || mode == "apply", "INTERACTIVE_REQUIRES_EXPLICIT_APPLY")
    try require(!(scope == "code-identity" && mode == "apply") || interactive, "CODE_IDENTITY_APPLY_REQUIRES_INTERACTIVE")
    try verifyBinary()
    let terminal = scope == "code-identity" && mode == "apply" ? try nativeTerminal() : nil
    // Code identity: only Apple's child may prompt. Our metadata queries remain
    // noninteractive and never gain credential-value access themselves.
    try checked(SecKeychainSetUserInteractionAllowed(interactive && scope == "app-trust"), "KEYCHAIN_INTERACTION_POLICY_FAILED")
    let keychainPath = loginKeychainPath
    var keychain: SecKeychain?
    try checked(SecKeychainOpen(keychainPath, &keychain), "LOGIN_KEYCHAIN_OPEN_FAILED")
    guard let keychain = keychain else { throw Failure(code: "LOGIN_KEYCHAIN_MISSING", status: nil) }
    if mode == "snapshot" {
        FileHandle.standardOutput.write(try encoder.encode(freshMetadataSnapshot(keychain))); return
    }
    var application: SecTrustedApplication?
    try checked(SecTrustedApplicationCreateFromPath(binary, &application), "PINNED_APPLICATION_REFERENCE_FAILED")
    guard let application = application else { throw Failure(code: "PINNED_APPLICATION_REFERENCE_MISSING", status: nil) }
    if mode == "inspect" {
        let current = try openTargets(keychain)
        let before = try current.map(targetSnapshot)
        for item in current { try mutateInMemory(item.access, application: application, remove: false, scope: scope) }
        let after = try current.map(targetSnapshot)
        let plan = Plan(schemaVersion: schema, mutationScope: scope, binaryPath: binary, binarySha256: expectedHash, binaryCDHash: expectedCDHash,
                        keychainPath: keychainPath, before: before, after: after)
        FileHandle.standardOutput.write(try encoder.encode(plan)); return
    }
    let input = FileHandle.standardInput.readDataToEndOfFile()
    try require(input.count < 100000, "PLAN_TOO_LARGE")
    let plan = try JSONDecoder().decode(Plan.self, from: input)
    try require(plan.schemaVersion == schema && plan.binaryPath == binary && plan.binarySha256 == expectedHash
        && (plan.mutationScope ?? "app-trust") == scope
        && (plan.binaryCDHash == expectedCDHash || (scope == "app-trust" && plan.binaryCDHash == nil))
        && plan.keychainPath == keychainPath && plan.before.count == 3 && plan.after.count == 3, "PLAN_SCOPE_MISMATCH")
    for index in targets.indices {
        try require(plan.before[index].label == targets[index].0 && plan.before[index].accountKey == targets[index].1
            && plan.after[index].label == targets[index].0 && plan.after[index].accountKey == targets[index].1, "PLAN_ALIAS_MISMATCH")
    }
    if mode == "verify" {
        var results: [[String: String]] = []
        for (index, item) in try openTargets(keychain).enumerated() {
            let state = try targetSnapshot(item)
            results.append(["label": item.label, "state": state == plan.before[index] ? "before" : state == plan.after[index] ? "after" : "mismatch"])
        }
        let result: [String: Any] = ["schemaVersion": "jobtrack-gog-keychain-acl-verification.v1",
            "mode": "verify", "mutationScope": scope, "aliases": results, "credentialDataRead": false, "credentialDataWritten": false]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])); return
    }
    if scope == "code-identity" {
        // Validate native replacement and full approved delta for ALL aliases
        // before any command. A later alias's unsupported metadata cannot cause
        // avoidable partial authorization of earlier aliases.
        for index in targets.indices {
            let before = plan.before[index].access.acls.filter { $0.authorizations.contains("ACLAuthorizationPartitionID") }
            let after = plan.after[index].access.acls.filter { $0.authorizations.contains("ACLAuthorizationPartitionID") }
            try require(before.count == 1 && after.count == 1, "PARTITION_ACL_NOT_UNIQUE")
            guard let old = before[0].description, let new = after[0].description else { throw Failure(code: "PARTITION_DESCRIPTION_MISSING", status: nil) }
            try validateNativePartitionPair(old, new)
            var oldACLs = plan.before[index].access.acls; var newACLs = plan.after[index].access.acls
            oldACLs.removeAll { $0.authorizations.contains("ACLAuthorizationPartitionID") }
            newACLs.removeAll { $0.authorizations.contains("ACLAuthorizationPartitionID") }
            try require(oldACLs == newACLs && before[0].authorizations == after[0].authorizations
                && before[0].prompt == after[0].prompt && before[0].applications == after[0].applications
                && plan.before[index].access.uid == plan.after[index].access.uid
                && plan.before[index].access.gid == plan.after[index].access.gid
                && plan.before[index].access.ownerType == plan.after[index].access.ownerType, "PLAN_DELTA_NOT_EXACT_" + targets[index].0)
        }
    }
    // Preflight ALL aliases before the first write. Partial prior completion is
    // recoverable only if each alias is exactly its recorded before or after.
    // This is optimistic checking, not an OS atomic CAS. Do not concurrently
    // edit the same ACL while a native authorization dialog is outstanding.
    for (index, item) in try openTargets(keychain).enumerated() {
        let state = try targetSnapshot(item)
        try require(state == plan.before[index] || state == plan.after[index], "PLAN_STALE_" + item.label)
    }
    var changed: [String] = []
    for index in targets.indices {
        try verifyBinary()
        let current = try openTargets(keychain)[index]
        let state = try targetSnapshot(current)
        let desired = mode == "apply" ? plan.after[index] : plan.before[index]
        let expected = mode == "apply" ? plan.before[index] : plan.after[index]
        if state == desired { continue }
        try require(state == expected, "PLAN_STALE_" + current.label)
        let restorePartition = plan.before[index].access.acls.first { $0.authorizations.contains("ACLAuthorizationPartitionID") }?.description
        try mutateInMemory(current.access, application: application, remove: mode == "rollback", scope: scope, restorePartition: restorePartition)
        try require(try targetSnapshot(current) == desired, "PLAN_DELTA_NOT_EXACT_" + current.label)
        if scope == "code-identity" {
            guard let terminal = terminal, let description = desired.access.acls.first(where: { $0.authorizations.contains("ACLAuthorizationPartitionID") })?.description else {
                throw Failure(code: "NATIVE_PARTITION_INTERACTIVE_APPLY_REQUIRED", status: nil)
            }
            try runNativePartition(nativePartitionArguments(index, keychainPath, description), terminal)
        } else {
            try require(scope == "app-trust", "UNKNOWN_MUTATION_SCOPE")
            let status = SecKeychainItemSetAccess(current.item, current.access)
            if status != errSecSuccess { throw Failure(code: "KEYCHAIN_AUTHORIZATION_REQUIRED_OR_DENIED_" + current.label, status: status) }
        }
        changed.append(current.label)
        let observed = try targetSnapshot(openTargets(keychain)[index])
        try require(observed == desired, "POST_WRITE_ACL_MISMATCH_" + current.label)
    }
    let observed = try openTargets(keychain).map(targetSnapshot)
    try require(observed == (mode == "apply" ? plan.after : plan.before), "FINAL_ACL_MISMATCH")
    let result: [String: Any] = ["schemaVersion": "jobtrack-gog-keychain-acl-result.v1", "mode": mode, "mutationScope": scope,
        "changedAliases": changed, "verifiedAliases": targets.map { $0.0 }, "credentialDataRead": false, "credentialDataWritten": false]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
}
do { try run() } catch {
    let failure = error as? Failure
    let output: [String: Any] = ["code": failure?.code ?? "KEYCHAIN_METADATA_UTILITY_FAILED",
        "osStatus": failure?.status as Any? ?? NSNull(), "credentialDataRead": false, "credentialDataWritten": false]
    if let data = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]) { FileHandle.standardError.write(data) }
    exit(1)
}
