import { type CodebaseProvider } from "./codebase.js";
import type { TurnExecutor } from "./executor.js";
import { type CredentialProvisioner } from "./credentials.js";
import { type EnvironmentDescriptor } from "./descriptor.js";
import type { LlmClient } from "./llm-client.js";
/** Host-supplied environment description binding. The EAL owns the descriptor
 * contract; concrete hosts own the input needed to derive one. */
export type EnvironmentDescriber<Input = unknown> = (input: Input) => EnvironmentDescriptor;
/** The structural slice of a portable execution config the callback resolver
 *  reads. mc-harness's AgentServerPortableConfig["execution"] satisfies it. */
export interface PortableExecutionRef {
    readonly location?: string;
    readonly callbackUrl?: string | null;
}
/**
 * Resolve the URL the in-container Mission Control callback hits. For a LOCAL
 * docker turn it is the host fallback (typically host.docker.internal); for a
 * remote-docker turn it is the server's tailnet callbackUrl (host.docker.internal
 * only resolves on the MC host). Lifted verbatim from buildDockerSpawnContext so
 * the live spawn AND the environment compute it from one source.
 */
export declare function resolveCallbackEndpoint(input: {
    execution: PortableExecutionRef | undefined;
    fallbackWebUrl: string;
}): string;
/**
 * TurnExecutionEnvironment — the bound set of per-invocation seam impls one
 * executing process holds: codebase (worktree / corpus-read / inert), executor
 * (the uniform TurnExecutor), credentials (the provision operation), and the
 * callback resolver.
 */
export interface TurnExecutionEnvironment<DescribeInput = unknown> {
    readonly codebase: CodebaseProvider;
    readonly executor: TurnExecutor;
    readonly credentials: CredentialProvisioner;
    describe(input: DescribeInput): EnvironmentDescriptor;
    callbackEndpoint(execution: PortableExecutionRef | undefined): string;
}
/** An environment whose descriptor is fixed at composition time. `describe()`
 * returns the same validated object on every call. */
export type FixedDescriptorExecutionEnvironment = TurnExecutionEnvironment<void>;
export interface CreateTurnExecutionEnvironmentInput<DescribeInput = unknown> {
    readonly codebase: CodebaseProvider;
    readonly executor: TurnExecutor;
    readonly credentials: CredentialProvisioner;
    /** Host binding that projects its concrete admission data into the shared
     * EnvironmentDescriptor. The factory validates every returned descriptor. */
    readonly describe: EnvironmentDescriber<DescribeInput>;
    /** The callback URL a local container reaches the host on. */
    readonly fallbackWebUrl: string;
}
/** The general factory — the seam SWAP POINT. Central binds local impls; a
 *  fleet node binds Tailnet codebase + its own docker + delivered creds; a
 *  model-only host binds inert codebase + the model-inference executor. */
export declare function createTurnExecutionEnvironment<DescribeInput = unknown>(input: CreateTurnExecutionEnvironmentInput<DescribeInput>): TurnExecutionEnvironment<DescribeInput>;
export declare class ExecutionEnvironmentFactoryError extends Error {
    constructor(message: string);
}
/**
 * Capture an immutable descriptor grant at composition time. A fixed
 * environment must not inherit later mutation of caller-owned arrays/objects:
 * that would let admission validate one posture and execution observe another.
 */
export declare function snapshotFixedEnvironmentDescriptor(input: EnvironmentDescriptor): EnvironmentDescriptor;
export interface CreateModelOnlyExecutionEnvironmentInput {
    readonly client: LlmClient;
    /**
     * The exact, code-owned descriptor for this inference binding. The factory
     * accepts a full descriptor instead of inventing contract ids, budgets, or
     * opaque secret handles on the caller's behalf.
     */
    readonly descriptor: EnvironmentDescriptor;
    /** Optional scoped authority. Omission binds a loud inert provisioner. */
    readonly credentials?: CredentialProvisioner;
    /** Explicit because the aggregate's callback seam must never fabricate a
     * host address, even though model-only inference normally does not call it. */
    readonly fallbackWebUrl: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
}
/**
 * Bind the tool-less model-inference environment: no workspace, no codebase,
 * and no ambient credential authority. The descriptor is validated once and
 * retained by identity so admission, prompt assembly, and consumers all see
 * the same fixed posture.
 */
export declare function createModelOnlyExecutionEnvironment(input: CreateModelOnlyExecutionEnvironmentInput): FixedDescriptorExecutionEnvironment;
