import type { RouteVerbMask } from "./capabilities.js";
import type { UsageReceipt } from "mission-pipeline/contracts/usage-receipt";
export type ExecutorKind = "worktree-turn" | "corpus-read-turn" | "model-inference";
/** Assembled system context for an invocation. context.ts produces this from
 *  capability-checked ContextFragments. `manifest` names what went in so prompt
 *  drift is diffable; it remains optional for compatibility with callers that
 *  have not yet moved onto descriptor-backed assembly. */
export interface AssembledContext {
    readonly systemText: string;
    readonly manifest?: {
        readonly fragmentIds: readonly string[];
        readonly digest: string;
    };
}
/** Per-invocation scoped credentials, delivered by the A3 CredentialProvisioner
 *  operation. The token is the ONLY authority the invocation holds; secretRefs
 *  are opaque handles (never material — the descriptor invariant). */
export interface ProvisionedCredentials {
    readonly token: string;
    readonly secretRefs: readonly string[];
    readonly callbackUrl: string;
    /** epoch ms. */
    readonly expiresAt: number;
}
/** The exact frozen usage-receipt.v1 shape owned by mission-pipeline. Keeping
 * this as a type alias (instead of a second lookalike interface) makes the EAL
 * → pipeline adapter mechanically share the one receipt contract. */
export type UsageReceiptLike = UsageReceipt;
/** Per-invocation resource ceilings carried from the frozen pipeline request.
 * Every field is optional because callers may constrain only one resource. */
export interface AgentInvocationBudget {
    readonly maxTokens?: number;
    readonly maxCostMicroUsd?: number;
    readonly maxElapsedMs?: number;
}
export interface AgentInvocation {
    /** The invocation identity — for a worktree turn this IS the turn id (the
     *  same id credentials were scoped to, so revoke matches; critique 12: the
     *  worktree executor REQUIRES it to preserve the never-self-decide same-run
     *  guard). */
    readonly invocationId: string;
    /** Resolved agent slug / persona ref. */
    readonly agentRef: string;
    /** The caller-composed directive (the user-message text). */
    readonly directive: string;
    /** Assembled system context; null = the executor's own default assembly. */
    readonly context: AssembledContext | null;
    /** Per-invocation inference settings (the B2 resource-binding axis). */
    readonly settings: {
        readonly providerId?: string;
        readonly modelId?: string;
        readonly effort?: string;
    } | null;
    /** The workspace the invocation runs against; null for model-only inference. */
    readonly workspace: {
        readonly path: string;
        readonly readOnly: boolean;
    } | null;
    /** Scoped credentials; null when the invocation holds no mutation authority. */
    readonly credentials: ProvisionedCredentials | null;
    /** Typed io contracts for structured invocations (the pipeline shape). */
    readonly io?: {
        readonly inputContract: string;
        readonly outputContract: string;
    } | null;
    /** Request-owned resource ceilings. Executors must only narrow these. */
    readonly budget?: AgentInvocationBudget;
    /** Relative outer deadline in milliseconds. The pipeline remains the
     * authoritative race owner; cooperative executors forward it downstream. */
    readonly deadlineMs?: number;
    /** Route-verb masks the credentials were narrowed to (R5). Nominal type —
     *  never EnvironmentCapability strings (capabilities.ts). */
    readonly capabilities?: readonly RouteVerbMask[] | null;
    /** Host-specific extras the BINDING executor parses LOUDLY (MC: projectId,
     *  agent server binding, provider-session resume, delegation contracts …).
     *  Opaque here so the vocabulary stays host-neutral. */
    readonly harnessOptions?: unknown;
}
export interface AgentInvocationFailure {
    readonly kind: string;
    readonly detail: string;
}
export interface AgentInvocationResult {
    /** completed = the agent ran and produced its output; failed = the agent ran
     *  but the output is unusable (contract violation, refusal); infra-error =
     *  the invocation never usably ran (spawn/transport/provider failure). */
    readonly outcome: "completed" | "failed" | "infra-error";
    /** Primary text output (markdown for turns; raw text for inference). */
    readonly text: string | null;
    /** Contract-shaped output when io.outputContract was set and parsed. */
    readonly structured?: unknown;
    /** Structured turn-close report, when the harness produced one. */
    readonly report?: unknown;
    readonly usage?: UsageReceiptLike | null;
    /** Sanitized provider-session continuation blob (worktree turns). */
    readonly providerSession?: unknown;
    readonly failure?: AgentInvocationFailure | null;
}
export interface TurnExecutor {
    readonly kind: ExecutorKind;
    execute(invocation: AgentInvocation, signal?: AbortSignal): Promise<AgentInvocationResult>;
}
