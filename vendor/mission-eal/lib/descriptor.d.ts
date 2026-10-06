/** The literal schemaVersion const of the frozen shared schema. */
export declare const ENVIRONMENT_DESCRIPTOR_SCHEMA_VERSION: "environment-descriptor.v1";
export type EnvironmentDescriptorSchemaVersion = typeof ENVIRONMENT_DESCRIPTOR_SCHEMA_VERSION;
/**
 * The closed `network` enum (mirrors the frozen schema's `network.enum`).
 * Ordered from most- to least-restrictive posture:
 *  - none              no network at all.
 *  - loopback-only     only a host-loopback callback (no model/egress).
 *  - model-endpoint    a model endpoint is reachable (the drafting/inference turn).
 *  - egress-allowlist  a bounded egress allowlist (e.g. company research).
 */
export declare const ENVIRONMENT_NETWORK_POSTURES: readonly ["none", "loopback-only", "model-endpoint", "egress-allowlist"];
export type EnvironmentNetworkPosture = (typeof ENVIRONMENT_NETWORK_POSTURES)[number];
/**
 * The closed, CODE-OWNED `capabilities` set (mirrors the frozen schema's
 * `capabilities.items.enum`). Config SELECTS from this set; it never embeds a
 * new capability. `none` is exclusive (see NETWORK/`allOf` rule below).
 */
export declare const ENVIRONMENT_CAPABILITIES: readonly ["none", "network:model", "decision:hierarchical", "network:egress-allowlist", "filesystem:corpus-ro", "filesystem:workspace", "network:oauth", "network:mail-egress", "filesystem:mail-store-ro", "os:automation", "mail:read", "mail:draft", "mail:send"];
export type EnvironmentCapability = (typeof ENVIRONMENT_CAPABILITIES)[number];
/** Mount access mode (mirrors `mounts.items.properties.mode.enum`). */
export declare const ENVIRONMENT_MOUNT_MODES: readonly ["ro", "rw"];
export type EnvironmentMountMode = (typeof ENVIRONMENT_MOUNT_MODES)[number];
export interface EnvironmentMount {
    /** Absolute in-environment path (1..1024 chars). */
    readonly path: string;
    readonly mode: EnvironmentMountMode;
}
export interface EnvironmentIoContract {
    readonly inputContract: string;
    readonly outputContract: string;
}
export interface EnvironmentBudget {
    readonly maxTokens: number;
    readonly maxCostMicroUsd: number;
    readonly maxElapsedMs: number;
}
/**
 * The shared EnvironmentDescriptor (mirror of `environment-descriptor.v1`).
 * `imageDigest` + `budget` are optional; everything else is required, matching
 * the frozen schema's `required` list.
 */
export interface EnvironmentDescriptor {
    readonly schemaVersion: EnvironmentDescriptorSchemaVersion;
    readonly network: EnvironmentNetworkPosture;
    /** 1..8 unique capabilities; `none` is exclusive. */
    readonly capabilities: readonly EnvironmentCapability[];
    readonly mounts: readonly EnvironmentMount[];
    /** Opaque secret handles ONLY — never credential material. */
    readonly secretRefs: readonly string[];
    /** Lowercase 64-hex sha256 of the pinned image, when known. */
    readonly imageDigest?: string;
    readonly io: EnvironmentIoContract;
    readonly budget?: EnvironmentBudget;
}
export declare const ENVIRONMENT_DESCRIPTOR_BOUNDS: {
    readonly capabilitiesMin: 1;
    readonly capabilitiesMax: 8;
    readonly mountsMax: 32;
    readonly mountPathMin: 1;
    readonly mountPathMax: 1024;
    readonly secretRefsMax: 16;
    readonly secretRefMin: 1;
    readonly secretRefMax: 256;
    readonly contractIdMax: 160;
    readonly budgetMaxTokensMax: 10000000;
    readonly budgetMaxCostMicroUsdMax: 100000000000;
    readonly budgetMaxElapsedMsMax: 86400000;
};
/** A contractId must match this pattern (mirrors `$defs.contractId.pattern`). */
export declare const CONTRACT_ID_PATTERN: RegExp;
/** An imageDigest is a lowercase 64-hex sha256 (mirrors `$defs.sha256.pattern`). */
export declare const IMAGE_DIGEST_PATTERN: RegExp;
/** Result of a code-side (non-JSON-Schema) validation of a descriptor. */
export type EnvironmentDescriptorValidation = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly errors: readonly string[];
};
/**
 * Validate a descriptor against the MIRRORED constraints (the same rules the
 * frozen JSON Schema enforces, expressed in code so callers that never touch a
 * JSON validator still catch a malformed descriptor). Returns every violation
 * so a caller can report them all at once. This is a CODE-VALIDATOR — a
 * non-breaking addition; it never mutates the descriptor.
 */
export declare function validateEnvironmentDescriptor(descriptor: EnvironmentDescriptor): EnvironmentDescriptorValidation;
/**
 * Assert-validate a descriptor, throwing on the first failure. Convenience for
 * call sites (and the mapping builder) that treat a malformed descriptor as a
 * programming error rather than data to inspect.
 */
export declare function assertValidEnvironmentDescriptor(descriptor: EnvironmentDescriptor): void;
/** Runtime posture implied by an {@link EnvironmentDescriptor}. */
export interface EnvironmentRuntimeFlags {
    readonly network: EnvironmentNetworkPosture;
    readonly networkEnabled: boolean;
    readonly modelEndpointAllowed: boolean;
    /** EAL environments keep the root filesystem read-only; writable state is
     * represented only by explicit rw mounts. */
    readonly readOnlyRootfs: boolean;
    readonly writableMountPaths: readonly string[];
    readonly readOnlyMountPaths: readonly string[];
    /** Opaque handles only; never credential material. */
    readonly secretRefs: readonly string[];
    readonly mayInvokeModel: boolean;
    /** Environment descriptors can describe mail adapters, but the EAL runtime
     * projection never turns recognition of `mail:send` into execution authority. */
    readonly sendAllowed: false;
}
/**
 * Deterministically project a validated descriptor into runtime posture flags.
 * A malformed descriptor fails before any flags are returned.
 */
export declare function environmentDescriptorToRuntimeFlags(descriptor: EnvironmentDescriptor): EnvironmentRuntimeFlags;
