import type { SandboxResourceManifest } from "./provision-manifest.js";
import { type HarnessCredentialStatus } from "./harness-registry.js";
/**
 * Thrown when a sandbox resource fails preflight. `resourceKey` is the manifest
 * item key (e.g. "image.cli"); `category` mirrors the item's category; `detail`
 * is the low-level reason from the check seam. The message is already the loud,
 * specific operator-facing string from the manifest item's failure() renderer.
 */
export declare class SandboxProvisioningError extends Error {
    readonly resourceKey: string;
    readonly category: string;
    readonly detail: string;
    constructor(input: {
        resourceKey: string;
        category: string;
        detail: string;
        message: string;
    });
}
/** Result of probing a single check; ok=true means the resource is present. */
export type SandboxCheckOutcome = {
    ok: true;
} | {
    ok: false;
    detail: string;
};
/**
 * Injectable verification seams. Production wires the node:fs / fetch / docker
 * defaults; tests inject mocks so each missing-resource branch can be asserted
 * without touching the real filesystem, network, or docker.
 */
export interface SandboxPreflightSeams {
    /** Verify a host path exists, is readable, and is the expected kind. */
    statPath?: (path: string, expect: "directory" | "file") => Promise<SandboxCheckOutcome>;
    /** Probe a host-reachable URL; ok when Mission Control web answers. */
    probeWebEndpoint?: (hostProbeUrl: string) => Promise<SandboxCheckOutcome>;
    /** Probe that a CLI command resolves on PATH inside the image. */
    probeImageCli?: (input: {
        image: string;
        command: string;
        dockerBinary: string;
    }) => Promise<SandboxCheckOutcome>;
    /** Probe a harness credential store (CP-DICT-1). Defaults to the registered
     * descriptor's refresh-aware probe; tests inject a mock. */
    probeHarnessCredential?: (harnessKind: string) => Promise<HarnessCredentialStatus>;
    /** Wall clock (ms) for the image-probe throttle cache. Defaults to Date.now. */
    now?: () => number;
}
export interface VerifySandboxProvisioningInput {
    readonly manifest: SandboxResourceManifest;
    readonly seams?: SandboxPreflightSeams;
}
/** Test-only: clear the throttle cache so probe-count assertions are isolated. */
export declare function resetImageCliProbeCacheForTest(): void;
/**
 * Verify every item in the manifest. Items are checked in order; the FIRST
 * failure throws SandboxProvisioningError with that item's loud, specific
 * message and the verifier returns nothing on success. The caller must not
 * spawn the turn when this throws.
 */
export declare function verifySandboxProvisioning(input: VerifySandboxProvisioningInput): Promise<void>;
export type { SandboxResourceManifest, SandboxResourceItem } from "./provision-manifest.js";
