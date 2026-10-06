import type { ExecutorKind, ProvisionedCredentials } from "./executor.js";
import type { RouteVerbMask } from "./capabilities.js";
import type { AsyncSandboxAuthTokenStore } from "./sandbox-auth-tokens.js";
export interface ProvisionCredentialsInput {
    /** The invocation identity — for a turn this IS the turn id; the minted token
     *  is scoped to it and revokeCredentials is keyed by it. */
    readonly invocationId: string;
    /** The executor kind this invocation runs under. worktree-turn REQUIRES runId. */
    readonly kind: ExecutorKind;
    readonly projectId: string;
    readonly sessionId: string;
    /** The run the turn executes in (build-turn WorkView.runId) — REQUIRED for
     *  worktree-turn (the never-self-decide same-run identity); omit for
     *  model-only / corpus-read invocations and host-mode callers. */
    readonly runId?: string;
    /** Route-verb masks (R5 least-privilege) — the nominal type; never
     *  EnvironmentCapability strings. A binding may INTERSECT this with a
     *  persona allowlist (narrow-only). Omit for the binding's default set. */
    readonly capabilities?: readonly RouteVerbMask[];
    /** The persona whose allowlist bounds the granted verbs (host-resolved).
     *  Bindings that narrow by persona read it; the raw token-store binding
     *  ignores it. */
    readonly personaRef?: string | null;
    /** Mint with ZERO verbs (the no-consequence posture: every mutation route
     *  denied; reads stay loopback-trusted). Wins over capabilities. */
    readonly denyAll?: boolean;
    readonly ttlMs?: number;
}
export declare class CredentialProvisioningError extends Error {
    constructor(message: string);
}
export interface CredentialProvisioner {
    provisionCredentials(input: ProvisionCredentialsInput): Promise<ProvisionedCredentials>;
    /** Retire every credential minted for the invocation. Returns the count. */
    revokeCredentials(invocationId: string): Promise<number>;
}
/**
 * Named failure from the deliberately unbound credential seam used by
 * authority-free environments. A call reaching this provisioner is a wiring
 * bug: callers must either keep credentials null or bind an explicit scoped
 * provisioner at environment construction.
 */
export declare class InertCredentialProvisionerError extends CredentialProvisioningError {
    constructor(reason: string);
}
/**
 * The no-credentials binding. Provisioning fails loudly; revoking an
 * invocation that could never have minted through this binding is the
 * idempotent zero-result operation.
 */
export declare function createInertCredentialProvisioner(options: {
    readonly reason: string;
}): CredentialProvisioner;
export interface CreateTokenStoreCredentialProvisionerInput {
    /** The central mint==validate authority — the SAME instance the web
     *  validator holds (in-memory today; PG-backed behind the A6 flag). */
    readonly tokens: AsyncSandboxAuthTokenStore;
    /** The callback URL delivered with the credentials (the environment's
     *  fallback web URL locally; the tailnet callback for a remote turn). */
    readonly callbackUrl: string;
}
export declare function createTokenStoreCredentialProvisioner(input: CreateTokenStoreCredentialProvisionerInput): CredentialProvisioner;
