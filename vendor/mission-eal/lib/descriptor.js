// environment-descriptor.ts — a VENDORED, MIRRORED copy of the shared
// execution-contracts `environment-descriptor.v1` vocabulary.
//
// DESIGN-EMAIL-DRAFTING-HOST §5: MC adopts the shared EnvironmentDescriptor so
// its sandbox provisioning and the (future) drafting environment speak ONE
// vocabulary and are test-asserted. The cross-repo plan
// (SHARED_EXECUTION_CONTRACTS_PLAN.md) keeps the canonical schema in the
// `execution-contracts` package.
//
// WHY MIRRORED, NOT IMPORTED (AGENTS.md standalone-first):
//   Mission Control must NOT gain a runtime dependency on the contracts package.
//   mc-harness is an L2 kernel that imports only mc-schema/mc-infra/mc-worktree
//   (+ node) — the import-boundary guard (test D) forbids any other bare import.
//   So, exactly like `mc-error-client` mirrors the error-report severity enum +
//   bounds rather than importing MC's policy core, we MIRROR the descriptor's
//   enums/bounds/shape here as plain constants. The repo test suite PINS this
//   mirror against a checked-in copy of the frozen JSON Schema
//   (test/fixtures/environment-descriptor.v1.schema.json) so the two cannot
//   drift — a change to the frozen schema fails the pin loudly.
//
// FREEZE: `environment-descriptor.v1` is a FROZEN v1 schema. These constants
// mirror its enums/bounds EXACTLY; do not narrow an enum, tighten a bound, or
// add a required field here without a corresponding non-breaking schema change.
//
// This module is I/O-free and credential-free: `secretRefs` are OPAQUE handles
// only (never credential material), matching the shared contract's invariant.
/** The literal schemaVersion const of the frozen shared schema. */
export const ENVIRONMENT_DESCRIPTOR_SCHEMA_VERSION = "environment-descriptor.v1";
/**
 * The closed `network` enum (mirrors the frozen schema's `network.enum`).
 * Ordered from most- to least-restrictive posture:
 *  - none              no network at all.
 *  - loopback-only     only a host-loopback callback (no model/egress).
 *  - model-endpoint    a model endpoint is reachable (the drafting/inference turn).
 *  - egress-allowlist  a bounded egress allowlist (e.g. company research).
 */
export const ENVIRONMENT_NETWORK_POSTURES = [
    "none",
    "loopback-only",
    "model-endpoint",
    "egress-allowlist"
];
/**
 * The closed, CODE-OWNED `capabilities` set (mirrors the frozen schema's
 * `capabilities.items.enum`). Config SELECTS from this set; it never embeds a
 * new capability. `none` is exclusive (see NETWORK/`allOf` rule below).
 */
export const ENVIRONMENT_CAPABILITIES = [
    "none",
    "network:model",
    "decision:hierarchical",
    "network:egress-allowlist",
    "filesystem:corpus-ro",
    "filesystem:workspace",
    "network:oauth",
    "network:mail-egress",
    "filesystem:mail-store-ro",
    "os:automation",
    "mail:read",
    "mail:draft",
    "mail:send"
];
/** Mount access mode (mirrors `mounts.items.properties.mode.enum`). */
export const ENVIRONMENT_MOUNT_MODES = ["ro", "rw"];
// ---------------------------------------------------------------------------
// Mirrored BOUNDS (mirror the frozen schema's minItems/maxItems/min/max/length).
// Kept as one object so the validator + tests read from a single source and the
// schema-pin test can assert each one against the checked-in frozen schema.
// ---------------------------------------------------------------------------
export const ENVIRONMENT_DESCRIPTOR_BOUNDS = {
    capabilitiesMin: 1,
    capabilitiesMax: 8,
    mountsMax: 32,
    mountPathMin: 1,
    mountPathMax: 1024,
    secretRefsMax: 16,
    secretRefMin: 1,
    secretRefMax: 256,
    contractIdMax: 160,
    budgetMaxTokensMax: 10_000_000,
    budgetMaxCostMicroUsdMax: 100_000_000_000,
    budgetMaxElapsedMsMax: 86_400_000
};
/** A contractId must match this pattern (mirrors `$defs.contractId.pattern`). */
export const CONTRACT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\.v[1-9][0-9]*$/;
/** An imageDigest is a lowercase 64-hex sha256 (mirrors `$defs.sha256.pattern`). */
export const IMAGE_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CAPABILITY_SET = new Set(ENVIRONMENT_CAPABILITIES);
const NETWORK_SET = new Set(ENVIRONMENT_NETWORK_POSTURES);
const MOUNT_MODE_SET = new Set(ENVIRONMENT_MOUNT_MODES);
const DESCRIPTOR_PROPERTY_SET = new Set([
    "schemaVersion",
    "network",
    "capabilities",
    "mounts",
    "secretRefs",
    "imageDigest",
    "io",
    "budget"
]);
const MOUNT_PROPERTY_SET = new Set(["path", "mode"]);
const IO_PROPERTY_SET = new Set(["inputContract", "outputContract"]);
const BUDGET_PROPERTY_SET = new Set(["maxTokens", "maxCostMicroUsd", "maxElapsedMs"]);
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function rejectUnknownProperties(value, allowed, location, errors) {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            errors.push(`${location} has unknown property ${JSON.stringify(key)} (additionalProperties:false).`);
        }
    }
}
/**
 * Validate a descriptor against the MIRRORED constraints (the same rules the
 * frozen JSON Schema enforces, expressed in code so callers that never touch a
 * JSON validator still catch a malformed descriptor). Returns every violation
 * so a caller can report them all at once. This is a CODE-VALIDATOR — a
 * non-breaking addition; it never mutates the descriptor.
 */
export function validateEnvironmentDescriptor(descriptor) {
    const errors = [];
    const b = ENVIRONMENT_DESCRIPTOR_BOUNDS;
    const candidate = descriptor;
    if (!isRecord(candidate)) {
        return { ok: false, errors: ["descriptor must be an object."] };
    }
    rejectUnknownProperties(candidate, DESCRIPTOR_PROPERTY_SET, "descriptor", errors);
    if (candidate.schemaVersion !== ENVIRONMENT_DESCRIPTOR_SCHEMA_VERSION) {
        errors.push(`schemaVersion must be "${ENVIRONMENT_DESCRIPTOR_SCHEMA_VERSION}" (got ${JSON.stringify(candidate.schemaVersion)}).`);
    }
    if (typeof candidate.network !== "string" || !NETWORK_SET.has(candidate.network)) {
        errors.push(`network must be one of ${[...NETWORK_SET].join(", ")} (got ${JSON.stringify(candidate.network)}).`);
    }
    // capabilities: 1..8, unique, from the closed set, and `none` is exclusive.
    const caps = candidate.capabilities;
    if (!Array.isArray(caps)) {
        errors.push("capabilities must be an array.");
    }
    else {
        if (caps.length < b.capabilitiesMin || caps.length > b.capabilitiesMax) {
            errors.push(`capabilities must have ${b.capabilitiesMin}..${b.capabilitiesMax} items (got ${caps.length}).`);
        }
        if (new Set(caps).size !== caps.length) {
            errors.push("capabilities must be unique.");
        }
        for (const cap of caps) {
            if (typeof cap !== "string" || !CAPABILITY_SET.has(cap))
                errors.push(`unknown capability ${JSON.stringify(cap)}.`);
        }
        if (caps.includes("none") && caps.length !== 1) {
            errors.push("capability `none` is exclusive: a descriptor either grants nothing, or lists only real capabilities.");
        }
    }
    // mounts: <=32; each path 1..1024; mode ro|rw.
    const mounts = candidate.mounts;
    if (!Array.isArray(mounts)) {
        errors.push("mounts must be an array.");
    }
    else {
        if (mounts.length > b.mountsMax) {
            errors.push(`mounts must have at most ${b.mountsMax} items (got ${mounts.length}).`);
        }
        for (let i = 0; i < mounts.length; i += 1) {
            const mount = mounts[i];
            if (!isRecord(mount)) {
                errors.push(`mounts[${i}] must be an object.`);
                continue;
            }
            rejectUnknownProperties(mount, MOUNT_PROPERTY_SET, `mounts[${i}]`, errors);
            if (typeof mount.path !== "string" || mount.path.length < b.mountPathMin || mount.path.length > b.mountPathMax) {
                errors.push(`mounts[${i}].path must be ${b.mountPathMin}..${b.mountPathMax} chars.`);
            }
            if (typeof mount.mode !== "string" || !MOUNT_MODE_SET.has(mount.mode)) {
                errors.push(`mounts[${i}].mode must be "ro" or "rw" (got ${JSON.stringify(mount.mode)}).`);
            }
        }
    }
    // secretRefs: <=16; each 1..256 chars (opaque handles).
    const secretRefs = candidate.secretRefs;
    if (!Array.isArray(secretRefs)) {
        errors.push("secretRefs must be an array.");
    }
    else {
        if (secretRefs.length > b.secretRefsMax) {
            errors.push(`secretRefs must have at most ${b.secretRefsMax} items (got ${secretRefs.length}).`);
        }
        for (let i = 0; i < secretRefs.length; i += 1) {
            const ref = secretRefs[i];
            if (typeof ref !== "string" || ref.length < b.secretRefMin || ref.length > b.secretRefMax) {
                errors.push(`secretRefs[${i}] must be ${b.secretRefMin}..${b.secretRefMax} chars.`);
            }
        }
    }
    // imageDigest: optional 64-hex sha256.
    if (candidate.imageDigest !== undefined
        && (typeof candidate.imageDigest !== "string" || !IMAGE_DIGEST_PATTERN.test(candidate.imageDigest))) {
        errors.push("imageDigest must be a lowercase 64-hex sha256.");
    }
    // io: two contractIds.
    const io = candidate.io;
    if (!isRecord(io)) {
        errors.push("io must be an object.");
    }
    else {
        rejectUnknownProperties(io, IO_PROPERTY_SET, "io", errors);
        for (const field of ["inputContract", "outputContract"]) {
            const value = io[field];
            if (typeof value !== "string" || value.length < 1 || value.length > b.contractIdMax || !CONTRACT_ID_PATTERN.test(value)) {
                errors.push(`io.${field} must be a contractId (1..${b.contractIdMax} chars) matching ${CONTRACT_ID_PATTERN}.`);
            }
        }
    }
    // budget: optional; when present all three bounds apply.
    if (candidate.budget !== undefined) {
        if (!isRecord(candidate.budget)) {
            errors.push("budget must be an object.");
            return { ok: false, errors };
        }
        rejectUnknownProperties(candidate.budget, BUDGET_PROPERTY_SET, "budget", errors);
        const { maxTokens, maxCostMicroUsd, maxElapsedMs } = candidate.budget;
        if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 0 || maxTokens > b.budgetMaxTokensMax) {
            errors.push(`budget.maxTokens must be an integer in 0..${b.budgetMaxTokensMax}.`);
        }
        if (typeof maxCostMicroUsd !== "number"
            || !Number.isInteger(maxCostMicroUsd)
            || maxCostMicroUsd < 0
            || maxCostMicroUsd > b.budgetMaxCostMicroUsdMax) {
            errors.push(`budget.maxCostMicroUsd must be an integer in 0..${b.budgetMaxCostMicroUsdMax}.`);
        }
        if (typeof maxElapsedMs !== "number"
            || !Number.isInteger(maxElapsedMs)
            || maxElapsedMs < 1
            || maxElapsedMs > b.budgetMaxElapsedMsMax) {
            errors.push(`budget.maxElapsedMs must be an integer in 1..${b.budgetMaxElapsedMsMax}.`);
        }
    }
    return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
/**
 * Assert-validate a descriptor, throwing on the first failure. Convenience for
 * call sites (and the mapping builder) that treat a malformed descriptor as a
 * programming error rather than data to inspect.
 */
export function assertValidEnvironmentDescriptor(descriptor) {
    const result = validateEnvironmentDescriptor(descriptor);
    if (!result.ok) {
        throw new Error(`invalid EnvironmentDescriptor: ${result.errors.join("; ")}`);
    }
}
/**
 * Deterministically project a validated descriptor into runtime posture flags.
 * A malformed descriptor fails before any flags are returned.
 */
export function environmentDescriptorToRuntimeFlags(descriptor) {
    assertValidEnvironmentDescriptor(descriptor);
    const networkEnabled = descriptor.network !== "none";
    const modelEndpointAllowed = descriptor.network === "model-endpoint"
        && descriptor.capabilities.includes("network:model");
    return {
        network: descriptor.network,
        networkEnabled,
        modelEndpointAllowed,
        readOnlyRootfs: true,
        writableMountPaths: descriptor.mounts
            .filter((mount) => mount.mode === "rw")
            .map((mount) => mount.path),
        readOnlyMountPaths: descriptor.mounts
            .filter((mount) => mount.mode === "ro")
            .map((mount) => mount.path),
        secretRefs: [...descriptor.secretRefs],
        mayInvokeModel: modelEndpointAllowed,
        sendAllowed: false
    };
}
