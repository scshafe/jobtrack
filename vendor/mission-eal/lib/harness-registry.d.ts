export interface HarnessCredentialStatus {
    ok: boolean;
    /** Operator-facing detail: what was checked, what to run to fix it. */
    detail: string;
    /** Earliest credential expiry when the store exposes one (epoch ms). */
    expiresAtMs?: number | null;
}
/** Injectable I/O seams so credential probes are unit-testable without
 * touching the real host credential stores. */
export interface HarnessCredentialProbeSeams {
    readFile?(path: string): Promise<string>;
    env?: Record<string, string | undefined>;
    /** Test seam for expiry comparisons (A2); production uses Date.now(). */
    nowMs?(): number;
}
/**
 * What a harness can do for a BUILD / HEADLESS turn (the externally-composed,
 * scheduler-run turn surface — NOT the live chat path). Declarative only: the
 * actual executor function is registered separately (headless-executor-registry)
 * so the descriptor stays transport-free. A harness that omits `build` cannot back
 * a headless/build turn — the build-turn enqueue gate, the HeadlessTurn server
 * resolver, and the chat-handoff build-vs-chat fork all consult this capability
 * instead of a hard-coded `kind === "opencode"` check (the C-/B1 de-pinning).
 */
export interface HarnessBuildCapability {
    /** The sandbox modes this harness can execute a headless/build turn in. A
     *  host-only harness declares ["host"]; opencode declares ["host","docker"]. */
    readonly sandboxModes: readonly ("host" | "docker")[];
    /** Whether this harness can run a MUTATING (worktree-isolated, reversible) build
     *  turn. A read-only-capable harness sets false; the build-turn enqueue gate
     *  requires true (a mutating turn always needs a docker sandbox too). */
    readonly canMutate: boolean;
}
export interface HarnessServerDefaults {
    readonly defaultLabel: string;
    readonly defaultPort: number;
    readonly defaultProbePath: string;
    readonly defaultCommand: string;
    readonly defaultArgs: (resolved: {
        port: number;
        host: string;
    }) => readonly string[];
    /** True when the kind expects credentials in process env that we cannot put in the plist. */
    readonly requiresSecretWrapper: boolean;
    readonly defaultModel: string | null;
    /** Provider slugs this kind can route to (composer availability annotation). */
    readonly supportedProviders: readonly string[];
}
export interface HarnessDescriptor {
    readonly kind: string;
    readonly displayName: string;
    readonly transport: "subprocess" | "websocket" | "http";
    /**
     * Whether a chat turn requires the bound agent_servers endpoint to be
     * REACHABLE at send time. Subprocess transports (opencode CLI, claude-code)
     * never touch the endpoint during a turn — the agent_servers row is their
     * config anchor (model default, sandbox mode), not their transport — so
     * they set false and a down `opencode serve` can no longer block sends.
     * Endpoint transports (codex app-server) set true. Unknown kinds are
     * treated as true (conservative).
     */
    readonly needsAgentServer: boolean;
    /** agent_servers config defaults; consumed via the agent-server-kinds adapter. */
    readonly server: HarnessServerDefaults;
    /** Headless/build-turn capability (B1). Absent → this harness cannot back a
     *  build/headless turn (chat-only). The executor itself is registered via
     *  headless-executor-registry, keeping this declaration transport-free. */
    readonly build?: HarnessBuildCapability;
    readonly credential: {
        readonly mode: "none" | "harness-store" | "env-keys";
        /** Host artifacts (operator documentation + probe targets). */
        readonly hostArtifacts: readonly {
            path: string;
            description: string;
        }[];
        /** Validate the credential store. Never throws — returns ok:false with an
         * actionable detail instead. */
        probe(seams?: HarnessCredentialProbeSeams): Promise<HarnessCredentialStatus>;
    };
    /** Tag of the persisted provider-session resume handle ({type: ...}), or
     * null when the harness has no resume concept. */
    readonly sessionHandleType: string | null;
}
export declare function registerHarnessDescriptor(descriptor: HarnessDescriptor): void;
export declare function getHarnessDescriptor(kind: string): HarnessDescriptor | null;
export declare function listHarnessDescriptors(): readonly HarnessDescriptor[];
/** Test seam: clear the registry so a test can re-register descriptors. */
export declare function __resetHarnessDescriptorRegistryForTesting(): void;
