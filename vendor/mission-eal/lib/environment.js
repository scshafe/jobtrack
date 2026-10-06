// environment.ts — the promoted TurnExecutionEnvironment aggregate
// (mission-restructure A3; DESIGN-CONDUCTOR.md: "EAL = promote
// TurnExecutionEnvironment, never a new invented layer" — the aggregate keeps
// its name). One executing process holds ONE bound environment; the execution
// path calls its seams and never branches on which machine (or which shape)
// the invocation runs on — swapping the environment IS the machine-ignorance
// mechanism (the §9 stop-gate).
//
// v2 (vs the P0 recognition shape): `container: HeadlessTurn` becomes
// `executor: TurnExecutor` (uniform execute over worktree / corpus-read /
// model-only kinds) and `credentials` becomes the provisionCredentials
// OPERATION (credentials.ts) instead of a deps holder. MC's local binding —
// which additionally carries the host-specific container/sandbox accessors its
// admission, wake, and drain paths require — lives in
// mc-harness/turn-execution-environment.ts.
import { createInertCodebaseProvider } from "./codebase.js";
import { CredentialProvisioningError, createInertCredentialProvisioner } from "./credentials.js";
import { assertValidEnvironmentDescriptor, ENVIRONMENT_DESCRIPTOR_BOUNDS } from "./descriptor.js";
import { createModelInferenceExecutor } from "./model-inference-executor.js";
/**
 * Resolve the URL the in-container Mission Control callback hits. For a LOCAL
 * docker turn it is the host fallback (typically host.docker.internal); for a
 * remote-docker turn it is the server's tailnet callbackUrl (host.docker.internal
 * only resolves on the MC host). Lifted verbatim from buildDockerSpawnContext so
 * the live spawn AND the environment compute it from one source.
 */
export function resolveCallbackEndpoint(input) {
    const execution = input.execution;
    const remote = execution?.location === "remote-docker";
    return remote && execution?.callbackUrl?.trim() ? execution.callbackUrl.trim() : input.fallbackWebUrl;
}
/** The general factory — the seam SWAP POINT. Central binds local impls; a
 *  fleet node binds Tailnet codebase + its own docker + delivered creds; a
 *  model-only host binds inert codebase + the model-inference executor. */
export function createTurnExecutionEnvironment(input) {
    return {
        codebase: input.codebase,
        executor: input.executor,
        credentials: input.credentials,
        describe(describeInput) {
            const descriptor = input.describe(describeInput);
            assertValidEnvironmentDescriptor(descriptor);
            return descriptor;
        },
        callbackEndpoint(execution) {
            return resolveCallbackEndpoint({ execution, fallbackWebUrl: input.fallbackWebUrl });
        }
    };
}
export class ExecutionEnvironmentFactoryError extends Error {
    constructor(message) {
        super(message);
        this.name = "ExecutionEnvironmentFactoryError";
    }
}
/**
 * Capture an immutable descriptor grant at composition time. A fixed
 * environment must not inherit later mutation of caller-owned arrays/objects:
 * that would let admission validate one posture and execution observe another.
 */
export function snapshotFixedEnvironmentDescriptor(input) {
    // Read each top-level property exactly once into a closed plain object before
    // validation. This prevents a getter/proxy-backed caller from presenting one
    // posture during validation and a wider one during the copy. Spreading also
    // preserves unknown enumerable keys so additionalProperties:false rejects
    // them instead of silently normalizing them away.
    const captured = { ...input };
    const captureObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.freeze({ ...value })
        : value;
    const capabilities = Array.isArray(captured.capabilities)
        ? Object.freeze([...captured.capabilities])
        : captured.capabilities;
    const mounts = Array.isArray(captured.mounts)
        ? Object.freeze([...captured.mounts].map(captureObject))
        : captured.mounts;
    const secretRefs = Array.isArray(captured.secretRefs)
        ? Object.freeze([...captured.secretRefs])
        : captured.secretRefs;
    const io = captureObject(captured.io);
    const budget = captureObject(captured.budget);
    const snapshot = {
        ...captured,
        capabilities,
        mounts,
        secretRefs,
        io,
        ...(captured.budget !== undefined ? { budget } : {})
    };
    assertValidEnvironmentDescriptor(snapshot);
    return Object.freeze(snapshot);
}
function assertModelOnlyDescriptor(descriptor, hasCredentialProvisioner) {
    assertValidEnvironmentDescriptor(descriptor);
    if (descriptor.network !== "model-endpoint") {
        throw new ExecutionEnvironmentFactoryError('createModelOnlyExecutionEnvironment: descriptor.network must be "model-endpoint"');
    }
    if (descriptor.capabilities.length !== 1
        || descriptor.capabilities[0] !== "network:model") {
        throw new ExecutionEnvironmentFactoryError('createModelOnlyExecutionEnvironment: descriptor.capabilities must be exactly ["network:model"]');
    }
    if (descriptor.mounts.length !== 0) {
        throw new ExecutionEnvironmentFactoryError("createModelOnlyExecutionEnvironment: a model-only descriptor must have zero mounts");
    }
    if (!hasCredentialProvisioner && descriptor.secretRefs.length !== 0) {
        throw new ExecutionEnvironmentFactoryError("createModelOnlyExecutionEnvironment: descriptor.secretRefs must be empty when no credential provisioner is bound");
    }
    if (hasCredentialProvisioner && descriptor.secretRefs.length === 0) {
        throw new ExecutionEnvironmentFactoryError("createModelOnlyExecutionEnvironment: an explicit credential provisioner requires one or more descriptor.secretRefs");
    }
}
function fixedCredentialProvisioner(provisioner, expectedSecretRefs) {
    const provisionCredentials = provisioner?.provisionCredentials;
    const revokeCredentials = provisioner?.revokeCredentials;
    if (typeof provisionCredentials !== "function"
        || typeof revokeCredentials !== "function") {
        throw new ExecutionEnvironmentFactoryError("createModelOnlyExecutionEnvironment: credentials must implement provisionCredentials() and revokeCredentials()");
    }
    const expected = Object.freeze([...expectedSecretRefs]);
    const sameSecretRefs = (actual) => {
        const actualSet = new Set(actual);
        const expectedSet = new Set(expected);
        return (actualSet.size === expectedSet.size
            && [...actualSet].every((secretRef) => expectedSet.has(secretRef)));
    };
    const retire = async (invocationId) => {
        try {
            const count = await revokeCredentials.call(provisioner, invocationId);
            return Number.isInteger(count) && count >= 1;
        }
        catch {
            return false;
        }
    };
    const fixed = {
        async provisionCredentials(request) {
            const invocationId = request.invocationId;
            const capabilities = request.capabilities === undefined
                ? undefined
                : Object.freeze([...request.capabilities]);
            const narrowed = Object.freeze({
                invocationId,
                kind: "model-inference",
                projectId: request.projectId,
                sessionId: request.sessionId,
                ...(request.personaRef !== undefined
                    ? { personaRef: request.personaRef }
                    : {}),
                ...(request.denyAll !== undefined
                    ? { denyAll: request.denyAll }
                    : {}),
                ...(request.ttlMs !== undefined ? { ttlMs: request.ttlMs } : {}),
                ...(capabilities !== undefined ? { capabilities } : {})
            });
            try {
                const provisioned = await provisionCredentials.call(provisioner, narrowed);
                const token = provisioned?.token;
                const rawSecretRefs = provisioned?.secretRefs;
                const secretRefs = Array.isArray(rawSecretRefs)
                    ? [...rawSecretRefs]
                    : rawSecretRefs;
                const callbackUrl = provisioned?.callbackUrl;
                const expiresAt = provisioned?.expiresAt;
                if (typeof token !== "string"
                    || token.length === 0
                    || !Array.isArray(secretRefs)
                    || !sameSecretRefs(secretRefs)
                    || typeof callbackUrl !== "string"
                    || callbackUrl.length === 0
                    || typeof expiresAt !== "number"
                    || !Number.isInteger(expiresAt)
                    || expiresAt < 0) {
                    throw new CredentialProvisioningError("model-only provisioner returned credentials that do not exactly match the fixed descriptor");
                }
                return Object.freeze({
                    token,
                    secretRefs: Object.freeze(secretRefs),
                    callbackUrl,
                    expiresAt
                });
            }
            catch (error) {
                const retired = await retire(invocationId);
                const cleanupDetail = retired
                    ? ""
                    : "; cleanup failed and the rejected credential may remain live";
                if (error instanceof CredentialProvisioningError) {
                    throw new CredentialProvisioningError(`${error.message}${cleanupDetail}`);
                }
                throw new CredentialProvisioningError("model-only provisioner failed or returned an unsafe result" +
                    cleanupDetail);
            }
        },
        revokeCredentials(invocationId) {
            return revokeCredentials.call(provisioner, invocationId);
        }
    };
    return Object.freeze(fixed);
}
/**
 * Bind the tool-less model-inference environment: no workspace, no codebase,
 * and no ambient credential authority. The descriptor is validated once and
 * retained by identity so admission, prompt assembly, and consumers all see
 * the same fixed posture.
 */
export function createModelOnlyExecutionEnvironment(input) {
    const captured = { ...input };
    if (typeof captured.fallbackWebUrl !== "string"
        || captured.fallbackWebUrl.trim().length === 0) {
        throw new ExecutionEnvironmentFactoryError("createModelOnlyExecutionEnvironment: fallbackWebUrl is required");
    }
    if (captured.maxTokens !== undefined
        && (!Number.isInteger(captured.maxTokens)
            || captured.maxTokens < 0
            || captured.maxTokens
                > ENVIRONMENT_DESCRIPTOR_BOUNDS.budgetMaxTokensMax)) {
        throw new ExecutionEnvironmentFactoryError("createModelOnlyExecutionEnvironment: maxTokens must be an integer in " +
            `0..${ENVIRONMENT_DESCRIPTOR_BOUNDS.budgetMaxTokensMax}`);
    }
    if (captured.temperature !== undefined
        && (typeof captured.temperature !== "number"
            || !Number.isFinite(captured.temperature)
            || captured.temperature < 0)) {
        throw new ExecutionEnvironmentFactoryError("createModelOnlyExecutionEnvironment: temperature must be a finite non-negative number");
    }
    const descriptor = snapshotFixedEnvironmentDescriptor(captured.descriptor);
    assertModelOnlyDescriptor(descriptor, captured.credentials !== undefined);
    const boundedMaxTokens = descriptor.budget === undefined
        ? captured.maxTokens
        : captured.maxTokens === undefined
            ? descriptor.budget.maxTokens
            : Math.min(captured.maxTokens, descriptor.budget.maxTokens);
    const codebase = Object.freeze(createInertCodebaseProvider({
        reason: "model-only execution"
    }));
    const credentials = captured.credentials === undefined
        ? Object.freeze(createInertCredentialProvisioner({
            reason: "model-only execution"
        }))
        : fixedCredentialProvisioner(captured.credentials, descriptor.secretRefs);
    return Object.freeze(createTurnExecutionEnvironment({
        codebase,
        executor: createModelInferenceExecutor({
            client: captured.client,
            ...(captured.temperature !== undefined
                ? { temperature: captured.temperature }
                : {}),
            ...(boundedMaxTokens !== undefined ? { maxTokens: boundedMaxTokens } : {})
        }),
        credentials,
        describe: () => descriptor,
        fallbackWebUrl: captured.fallbackWebUrl
    }));
}
