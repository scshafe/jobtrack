import { type AgentStepRequest } from "mission-pipeline/agent/step";
import type { AgentStepExecutor } from "mission-pipeline/agent/executor-port";
import { type EnvironmentDescriptor } from "./descriptor.js";
import { type TurnExecutionEnvironment } from "./environment.js";
import { type RouteVerbMask } from "./capabilities.js";
import type { AgentInvocation } from "./executor.js";
export declare class AgentStepEnvironmentCompatibilityError extends Error {
    constructor(message: string);
}
export declare class AgentStepInvocationBindingError extends Error {
    constructor(message: string);
}
export declare class AgentStepResultMappingError extends Error {
    constructor(message: string);
}
/** The fields a host may bind from its own identity, artifact, workspace, and
 * credential systems. The adapter fixes invocationId and io from the frozen
 * request after this callback returns, so a binding cannot redirect either. */
export type AgentStepInvocationBinding = Omit<AgentInvocation, "invocationId" | "io" | "budget" | "deadlineMs">;
export interface AgentStepInvocationBindingContext {
    readonly request: AgentStepRequest;
    readonly requiredEnvironment: EnvironmentDescriptor;
    readonly grantedEnvironment: EnvironmentDescriptor;
    readonly signal?: AbortSignal;
}
interface AgentStepPortFromEnvironmentCommonOptions {
    /** Resolve host identity and any content-addressed input artifacts into the
     * invocation surface. Required for every adapter: stage identity is not an
     * agent/persona identity, and the adapter never fabricates either an agent
     * binding or artifact contents from a digest. */
    readonly bindInvocation: (context: AgentStepInvocationBindingContext) => AgentStepInvocationBinding | Promise<AgentStepInvocationBinding>;
    /** Route-verb authority the host permits this adapter binding to carry.
     * This is an upper bound, not a grant. Omission means no mutation routes.
     * Credentials must still be explicitly returned by bindInvocation and their
     * secretRefs must exactly match the request-owned descriptor. */
    readonly allowedRouteCapabilities?: readonly RouteVerbMask[];
}
type AgentStepDescribeInputOption<DescribeInput> = [
    DescribeInput
] extends [void] ? {
    /** Derive the concrete host input needed by environment.describe().
     * Fixed-descriptor environments may omit it. */
    readonly describeInput?: (request: AgentStepRequest) => DescribeInput | Promise<DescribeInput>;
} : {
    /** Required for host-bound environments whose descriptor needs
     * concrete admission input. May perform async host lookup; describe()
     * itself remains synchronous. */
    readonly describeInput: (request: AgentStepRequest) => DescribeInput | Promise<DescribeInput>;
};
/** Fixed (void-input) environments need no describe callback. For a host-bound
 * environment whose descriptor takes concrete input, the callback is required
 * by the type system so the adapter cannot silently call describe(undefined). */
export type AgentStepPortFromEnvironmentOptions<DescribeInput = void> = AgentStepPortFromEnvironmentCommonOptions & AgentStepDescribeInputOption<DescribeInput>;
/**
 * Adapt a bound EAL environment to mission-pipeline's AgentStepExecutor port.
 *
 * There is deliberately no second timeout race: mission-pipeline's agent
 * invoker owns the authoritative deadline. The same signal is exposed to the
 * host binder and forwarded to the TurnExecutor for cooperative cancellation.
 */
export declare function agentStepPortFromEnvironment<DescribeInput = void>(environment: TurnExecutionEnvironment<DescribeInput>, options: AgentStepPortFromEnvironmentOptions<DescribeInput>): AgentStepExecutor;
export {};
