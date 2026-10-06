export interface SandboxAuthTokenScope {
    readonly projectId: string;
    readonly chatSessionId: string;
    readonly turnId: string;
    /** The RUN the scoped turn executes in (the build-turn's WorkView.runId), stamped
     * at mint. This is the UN-FAKEABLE reviewer-run identity the reviews.submitVerdict
     * route passes as reviewerRunId so the store's never-self-verify guard (a reviewer
     * may not verdict a task in its OWN run) cannot be bypassed by a sandboxed agent
     * forging a body field. Undefined for host-mode / operator tokens (no run binding;
     * those callers are trusted and may supply reviewerRunId explicitly). */
    readonly runId?: string;
    readonly expiresAt: number;
    /** Capability allowlist: the native-mutation route ids this token may call.
     * When set, the mutation router rejects (403) any route NOT listed — this is
     * how a docker-sandbox turn is confined to project-content mutations and kept
     * out of privileged config routes like agentProfiles.* (provisioning plan
     * position 2). Undefined = no capability gate (host-mode / legacy tokens). */
    readonly capabilities?: readonly string[];
}
export interface SandboxAuthTokenMintInput {
    readonly projectId: string;
    readonly chatSessionId: string;
    readonly turnId: string;
    /** The run the scoped turn executes in (build-turn WorkView.runId). Stamped into
     * the scope as the un-fakeable reviewer-run identity. Omit for host-mode tokens. */
    readonly runId?: string;
    /** Token lifetime in milliseconds. Defaults to 10 min. */
    readonly ttlMs?: number;
    /** Capability allowlist (native-mutation route ids) baked into the token.
     * Omit for an ungated token (host-mode / tests). */
    readonly capabilities?: readonly string[];
}
export interface SandboxAuthTokenValidateScope {
    readonly projectId?: string;
    readonly chatSessionId?: string;
}
export type SandboxAuthTokenValidateResult = {
    readonly ok: true;
    readonly scope: SandboxAuthTokenScope;
} | {
    readonly ok: false;
    readonly reason: string;
};
export interface SandboxAuthTokenStore {
    mint(input: SandboxAuthTokenMintInput): string;
    validate(token: string, scope?: SandboxAuthTokenValidateScope): SandboxAuthTokenValidateResult;
    revokeForTurn(turnId: string): number;
    /** Drop every entry whose expiresAt is <= now(). Returns the count. */
    cleanup(): number;
    /** For tests/diagnostics only. */
    size(): number;
}
/**
 * The PROMOTED store interface — async from day one (mission-restructure
 * critique 5): the A6 Postgres/OpenBao backing cannot implement a synchronous
 * validate, and asyncifying later would ripple through the web router's
 * header-validation hot path at the worst moment. New EAL consumers (the A3
 * CredentialProvisioner, the web validator seam) program against THIS
 * interface; the in-memory store adapts to it losslessly (resolved promises).
 * The legacy sync SandboxAuthTokenStore remains for existing in-process
 * callers until the A7 cutover.
 */
export interface AsyncSandboxAuthTokenStore {
    mint(input: SandboxAuthTokenMintInput): Promise<string>;
    validate(token: string, scope?: SandboxAuthTokenValidateScope): Promise<SandboxAuthTokenValidateResult>;
    revokeForTurn(turnId: string): Promise<number>;
    /** Drop every entry whose expiresAt is <= now(). Returns the count. */
    cleanup(): Promise<number>;
}
/** Adapt the sync in-memory store to the promoted async interface. SAME store
 *  instance = the mint==validate authority is preserved across both views. */
export declare function asAsyncSandboxAuthTokenStore(store: SandboxAuthTokenStore): AsyncSandboxAuthTokenStore;
export interface CreateSandboxAuthTokenStoreOptions {
    /** Override the wall clock. Defaults to Date.now. */
    readonly now?: () => number;
    /** Default token TTL when mint() does not pass ttlMs. Defaults to 10 min. */
    readonly defaultTtlMs?: number;
    /**
     * Override the random byte source for tests so token format assertions can
     * be deterministic. Defaults to node:crypto.randomBytes.
     */
    readonly randomBytes?: (size: number) => Buffer;
}
export declare function createSandboxAuthTokenStore(options?: CreateSandboxAuthTokenStoreOptions): SandboxAuthTokenStore;
/**
 * Resolve the per-turn sandbox token TTL the web boot path uses, so any OTHER
 * process that mints these tokens (the scheduler's queued docker build turns,
 * P4.x) derives the SAME lifetime rather than the bare 10-min default. The token
 * must outlive the longest possible turn: the turn timeout is 1h-configurable
 * (MISSION_CONTROL_OPENCODE_CLI_TIMEOUT_MS) and the TTL tracks it + 5 min slack,
 * floored at 65 min. Explicit override: MISSION_CONTROL_SANDBOX_TOKEN_TTL_MS.
 */
export declare function resolveSandboxTokenTtlMs(env?: NodeJS.ProcessEnv): number;
/**
 * Header used on the wire. Lowercase form keeps node:http happy — request
 * headers are normalized to lowercase before lookup.
 */
export declare const SANDBOX_AUTH_TOKEN_HEADER: "x-mission-control-auth-token";
