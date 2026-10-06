/** What a resource item logically groups under, for reporting/aggregation. */
export type SandboxResourceCategory = "mount" | "image" | "network" | "auth";
/**
 * How a single resource item is verified. A closed union so the verifier can
 * switch exhaustively; each variant carries exactly the params its check seam
 * needs.
 */
export type SandboxResourceCheck = {
    /** Stat a host path; assert it exists, is readable, and (optionally) is a directory or a file. */
    readonly kind: "host-path";
    readonly path: string;
    readonly expect: "directory" | "file";
} | {
    /** HTTP-probe a host-reachable endpoint; assert it answers. */
    readonly kind: "web-endpoint";
    /** URL the in-container CLI is told to use (may contain host.docker.internal). */
    readonly containerUrl: string;
    /** URL the HOST can actually reach (host.docker.internal rewritten to loopback). */
    readonly hostProbeUrl: string;
} | {
    /** Run a minimal command inside the image; assert a CLI resolves on PATH. */
    readonly kind: "image-cli";
    readonly image: string;
    /** Command expected to resolve on PATH inside the image (e.g. "mission-control"). */
    readonly command: string;
    readonly dockerBinary: string;
} | {
    /** Assert an in-memory value (e.g. the minted auth token) is a non-empty string. */
    readonly kind: "value-present";
    readonly value: string | null | undefined;
    readonly label: string;
} | {
    /** Probe the bound harness's credential store (CP-DICT-1): assert the
     * provider credential is usable BEFORE spawn, so a dead token surfaces as
     * a LOUD pre-turn provisioning failure instead of a post-invoke
     * INFRA-ERROR. The descriptor probe is refresh-aware — an expired access
     * token with a refresh token stays ok (the CLI refreshes itself), so this
     * only fails on a missing/unparseable store or a credential with no
     * usable refresh path. */
    readonly kind: "cred-store";
    readonly harnessKind: string;
};
export interface SandboxResourceItem {
    /** Stable identifier used in errors, events, and tests. */
    readonly key: string;
    readonly category: SandboxResourceCategory;
    /** Human-readable description of what this resource is. */
    readonly description: string;
    /** How to verify the item is present/usable. */
    readonly check: SandboxResourceCheck;
    /**
     * Render the loud, specific failure message for this item. `detail` is the
     * low-level reason from the check seam (e.g. an errno string).
     */
    readonly failure: (detail: string) => string;
    /**
     * True when this item still depends on an environment variable rather than a
     * file. Surfaced so the files-over-env migration can grep for the holdouts;
     * does not change verification behavior.
     */
    readonly envOnly?: boolean;
}
export interface SandboxResourceManifest {
    /** What spawn mode this manifest describes; "opencode-docker" for now. */
    readonly kind: "opencode-docker";
    readonly items: readonly SandboxResourceItem[];
}
/**
 * Rewrite a container-facing URL so the HOST can reach the same service. The
 * in-container CLI is handed http://host.docker.internal:PORT (and on older
 * setups callers have mistakenly handed it 127.0.0.1, which inside a container
 * is the container itself — the exact silent-failure this guard exists for).
 * Either way, from the host the service lives on loopback, so we swap the
 * authority's hostname to 127.0.0.1 while preserving scheme/port/path.
 */
export declare function hostReachableUrlForContainerWebUrl(webUrl: string): string;
/**
 * Project a manifest item to the compact descriptor surfaced in the
 * chat.provisioning.failed event payload. Kept beside the manifest so the event
 * shape can't drift from the item shape as the manifest evolves.
 */
export declare function manifestItemToEventPayload(item: SandboxResourceItem): {
    key: string;
    category: SandboxResourceCategory;
    description: string;
    envOnly?: boolean;
};
