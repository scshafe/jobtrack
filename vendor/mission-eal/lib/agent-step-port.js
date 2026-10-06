// agent-step-port.ts — the ONE adapter from mission-pipeline's frozen
// AgentStepExecutor port onto the EAL's uniform TurnExecutor (A5).
//
// mission-pipeline owns AgentStepRequest/Result and remains a standalone lower
// layer. The dependency points DOWNWARD from EAL to pipeline so this module can
// use the owning validators instead of growing a second contract mirror.
//
// A request carries the environment posture it REQUIRES. Before any host
// binding or executor call, this adapter computes the bound environment's
// descriptor exactly once and proves the requested posture is a subset. Scalar
// posture fields stay exact; collection fields use explicit subset rules.
import { validateAgentStepRequest, validateAgentStepResult } from "mission-pipeline/agent/step";
import { environmentDescriptorToRuntimeFlags } from "./descriptor.js";
import { snapshotFixedEnvironmentDescriptor } from "./environment.js";
import { asRouteVerbMasks } from "./capabilities.js";
export class AgentStepEnvironmentCompatibilityError extends Error {
    constructor(message) {
        super(message);
        this.name = "AgentStepEnvironmentCompatibilityError";
    }
}
export class AgentStepInvocationBindingError extends Error {
    constructor(message) {
        super(message);
        this.name = "AgentStepInvocationBindingError";
    }
}
export class AgentStepResultMappingError extends Error {
    constructor(message) {
        super(message);
        this.name = "AgentStepResultMappingError";
    }
}
function errorDetail(error) {
    return error instanceof Error ? error.message : String(error);
}
function descriptorFromUnknown(value, label) {
    try {
        return snapshotFixedEnvironmentDescriptor(value);
    }
    catch (error) {
        throw new AgentStepEnvironmentCompatibilityError(`${label} is not a valid environment-descriptor.v1: ${errorDetail(error)}`);
    }
}
// EAL treats an explicitly-undefined field as equivalent to an omitted one —
// `{ budget: undefined }` admits exactly like `{}`. Mission Pipeline's evidence
// cloner is stricter and rejects an own key whose value is `undefined`, because
// such a key cannot survive a canonical-JSON round trip. Dropping those keys
// before validation preserves EAL's admission semantics without asking the
// engine to relax a purity rule its digests depend on.
//
// Only plain objects and dense arrays are traversed; anything else is passed
// through untouched so the validators still see, and reject, hostile shapes.
function omitUndefinedLeaves(value) {
    if (Array.isArray(value))
        return value.map(omitUndefinedLeaves);
    if (value === null || typeof value !== "object")
        return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return value;
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined)
            continue;
        out[key] = omitUndefinedLeaves(entry);
    }
    return out;
}
function assertDenseInputArtifacts(request) {
    for (let index = 0; index < request.brief.inputArtifacts.length; index += 1) {
        if (!Object.hasOwn(request.brief.inputArtifacts, index)) {
            throw new AgentStepEnvironmentCompatibilityError(`agent-step brief.inputArtifacts must be dense (missing index ${index})`);
        }
    }
}
function snapshotAgentStepRequest(request, requiredEnvironment) {
    const inputArtifacts = request.brief.inputArtifacts.map((artifact) => {
        const snapshot = {
            contractId: artifact.contractId,
            digest: artifact.digest,
            ...(artifact.bytes !== undefined ? { bytes: artifact.bytes } : {})
        };
        return Object.freeze(snapshot);
    });
    Object.freeze(inputArtifacts);
    const stage = Object.freeze({
        stageId: request.stage.stageId,
        version: request.stage.version
    });
    const brief = Object.freeze({
        instructions: request.brief.instructions,
        inputArtifacts,
        outputContract: request.brief.outputContract
    });
    const budget = request.budget === undefined
        ? undefined
        : Object.freeze({
            ...(request.budget.maxTokens !== undefined
                ? { maxTokens: request.budget.maxTokens }
                : {}),
            ...(request.budget.maxCostMicroUsd !== undefined
                ? { maxCostMicroUsd: request.budget.maxCostMicroUsd }
                : {}),
            ...(request.budget.maxElapsedMs !== undefined
                ? { maxElapsedMs: request.budget.maxElapsedMs }
                : {})
        });
    const snapshot = {
        schemaVersion: request.schemaVersion,
        stage,
        environment: requiredEnvironment,
        brief,
        idempotencyKey: request.idempotencyKey,
        ...(budget !== undefined ? { budget } : {}),
        deadlineMs: request.deadlineMs
    };
    return Object.freeze(snapshot);
}
function assertExact(actual, expected, label) {
    if (actual !== expected) {
        throw new AgentStepEnvironmentCompatibilityError(`${label} mismatch: required ${JSON.stringify(actual)}, granted ${JSON.stringify(expected)}`);
    }
}
function assertBudgetSubset(required, granted, label) {
    if (!granted) {
        throw new AgentStepEnvironmentCompatibilityError(`${label} requires a bounded budget, but the granted environment declares no budget`);
    }
    for (const field of [
        "maxTokens",
        "maxCostMicroUsd",
        "maxElapsedMs"
    ]) {
        if (required[field] > granted[field]) {
            throw new AgentStepEnvironmentCompatibilityError(`${label}.${field} exceeds the granted ceiling (${required[field]} > ${granted[field]})`);
        }
    }
}
function assertEnvironmentSubset(required, granted) {
    assertExact(required.schemaVersion, granted.schemaVersion, "environment.schemaVersion");
    // Network postures are distinct sandbox shapes, not an authority ordering.
    // Do not invent an implication such as egress-allowlist ⊇ model-endpoint.
    assertExact(required.network, granted.network, "environment.network");
    assertExact(required.io.inputContract, granted.io.inputContract, "environment.io.inputContract");
    assertExact(required.io.outputContract, granted.io.outputContract, "environment.io.outputContract");
    const runtimeFlags = environmentDescriptorToRuntimeFlags(granted);
    if (required.capabilities.includes("mail:send") && !runtimeFlags.sendAllowed) {
        throw new AgentStepEnvironmentCompatibilityError("environment capability mail:send is required, but the EAL runtime posture pins sendAllowed=false");
    }
    if (required.capabilities.length === 1 && required.capabilities[0] === "none") {
        if (granted.capabilities.length !== 1
            || granted.capabilities[0] !== "none") {
            throw new AgentStepEnvironmentCompatibilityError("environment capability none is exclusive and may only be satisfied by granted [\"none\"]");
        }
    }
    else {
        const missingCapabilities = required.capabilities.filter((capability) => !granted.capabilities.includes(capability));
        if (missingCapabilities.length > 0) {
            throw new AgentStepEnvironmentCompatibilityError(`environment capabilities are not granted: ${missingCapabilities.join(", ")}`);
        }
    }
    for (const mount of required.mounts) {
        if (!granted.mounts.some((candidate) => candidate.path === mount.path && candidate.mode === mount.mode)) {
            throw new AgentStepEnvironmentCompatibilityError(`environment mount is not granted exactly: ${mount.path} (${mount.mode})`);
        }
    }
    const missingSecretRefs = required.secretRefs.filter((secretRef) => !granted.secretRefs.includes(secretRef));
    if (missingSecretRefs.length > 0) {
        throw new AgentStepEnvironmentCompatibilityError(`environment secretRefs are not granted: ${missingSecretRefs.join(", ")}`);
    }
    if (required.imageDigest !== undefined
        && required.imageDigest !== granted.imageDigest) {
        throw new AgentStepEnvironmentCompatibilityError(`environment.imageDigest mismatch: required ${JSON.stringify(required.imageDigest)}, granted ${JSON.stringify(granted.imageDigest)}`);
    }
    if (required.budget !== undefined) {
        assertBudgetSubset(required.budget, granted.budget, "environment.budget");
    }
}
function assertRequestContracts(request, required, granted) {
    if (request.brief.outputContract !== required.io.outputContract) {
        throw new AgentStepEnvironmentCompatibilityError(`agent-step brief.outputContract ${JSON.stringify(request.brief.outputContract)} does not match required environment.io.outputContract ${JSON.stringify(required.io.outputContract)}`);
    }
    for (const artifact of request.brief.inputArtifacts) {
        if (artifact.contractId !== required.io.inputContract) {
            throw new AgentStepEnvironmentCompatibilityError(`agent-step input artifact contract ${JSON.stringify(artifact.contractId)} does not match required environment.io.inputContract ${JSON.stringify(required.io.inputContract)}`);
        }
    }
    const requestBudgetFields = [
        "maxTokens",
        "maxCostMicroUsd",
        "maxElapsedMs"
    ];
    if (request.budget !== undefined) {
        const grantedBudget = granted.budget;
        const hasRequestedCeiling = requestBudgetFields.some((field) => request.budget?.[field] !== undefined);
        if (hasRequestedCeiling && !grantedBudget) {
            throw new AgentStepEnvironmentCompatibilityError("agent-step request carries a budget, but the granted environment declares no budget");
        }
        for (const field of requestBudgetFields) {
            const requested = request.budget[field];
            if (requested !== undefined
                && grantedBudget !== undefined
                && requested > grantedBudget[field]) {
                throw new AgentStepEnvironmentCompatibilityError(`agent-step budget.${field} exceeds the granted ceiling (${requested} > ${grantedBudget[field]})`);
            }
            if (requested !== undefined
                && required.budget !== undefined
                && requested > required.budget[field]) {
                throw new AgentStepEnvironmentCompatibilityError(`agent-step budget.${field} exceeds the required-environment ceiling (${requested} > ${required.budget[field]})`);
            }
        }
        if (request.budget.maxElapsedMs !== undefined
            && request.deadlineMs > request.budget.maxElapsedMs) {
            throw new AgentStepEnvironmentCompatibilityError(`agent-step deadlineMs exceeds its request budget.maxElapsedMs (${request.deadlineMs} > ${request.budget.maxElapsedMs})`);
        }
    }
    if (required.budget !== undefined
        && request.deadlineMs > required.budget.maxElapsedMs) {
        throw new AgentStepEnvironmentCompatibilityError(`agent-step deadlineMs exceeds the required environment budget.maxElapsedMs (${request.deadlineMs} > ${required.budget.maxElapsedMs})`);
    }
    if (granted.budget !== undefined
        && request.deadlineMs > granted.budget.maxElapsedMs) {
        throw new AgentStepEnvironmentCompatibilityError(`agent-step deadlineMs exceeds the granted environment budget.maxElapsedMs (${request.deadlineMs} > ${granted.budget.maxElapsedMs})`);
    }
}
const BINDING_KEYS = new Set([
    "agentRef",
    "directive",
    "context",
    "settings",
    "workspace",
    "credentials",
    "capabilities",
    "harnessOptions"
]);
function isPlainRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function assertKnownKeys(value, allowed, label) {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new AgentStepInvocationBindingError(`${label} contains unknown key ${JSON.stringify(key)}`);
        }
    }
}
function snapshotContext(value) {
    if (value === null)
        return null;
    if (!isPlainRecord(value)) {
        throw new AgentStepInvocationBindingError("bindInvocation.context must be null or an AssembledContext object");
    }
    assertKnownKeys(value, new Set(["systemText", "manifest"]), "bindInvocation.context");
    const captured = { ...value };
    if (typeof captured.systemText !== "string") {
        throw new AgentStepInvocationBindingError("bindInvocation.context.systemText must be a string");
    }
    let manifest;
    if (captured.manifest !== undefined) {
        if (!isPlainRecord(captured.manifest)) {
            throw new AgentStepInvocationBindingError("bindInvocation.context.manifest must be an object");
        }
        assertKnownKeys(captured.manifest, new Set(["fragmentIds", "digest"]), "bindInvocation.context.manifest");
        const capturedManifest = { ...captured.manifest };
        const fragmentIds = Array.isArray(capturedManifest.fragmentIds)
            ? Array.from(capturedManifest.fragmentIds)
            : null;
        if (fragmentIds === null
            || fragmentIds.some((fragmentId) => typeof fragmentId !== "string")
            || typeof capturedManifest.digest !== "string") {
            throw new AgentStepInvocationBindingError("bindInvocation.context.manifest must contain string fragmentIds and digest");
        }
        manifest = Object.freeze({
            fragmentIds: Object.freeze(fragmentIds),
            digest: capturedManifest.digest
        });
    }
    return Object.freeze({
        systemText: captured.systemText,
        ...(manifest !== undefined ? { manifest } : {})
    });
}
function snapshotSettings(value) {
    if (value === null)
        return null;
    if (!isPlainRecord(value)) {
        throw new AgentStepInvocationBindingError("bindInvocation.settings must be null or an object");
    }
    assertKnownKeys(value, new Set(["providerId", "modelId", "effort"]), "bindInvocation.settings");
    const captured = { ...value };
    for (const key of ["providerId", "modelId", "effort"]) {
        if (captured[key] !== undefined
            && (typeof captured[key] !== "string" || captured[key].length === 0)) {
            throw new AgentStepInvocationBindingError(`bindInvocation.settings.${key} must be a non-empty string when present`);
        }
    }
    return Object.freeze({
        ...(typeof captured.providerId === "string"
            ? { providerId: captured.providerId }
            : {}),
        ...(typeof captured.modelId === "string" ? { modelId: captured.modelId } : {}),
        ...(typeof captured.effort === "string" ? { effort: captured.effort } : {})
    });
}
function snapshotWorkspace(value, required) {
    if (value === null)
        return null;
    if (!isPlainRecord(value)) {
        throw new AgentStepInvocationBindingError("bindInvocation.workspace must be null or an object");
    }
    assertKnownKeys(value, new Set(["path", "readOnly"]), "bindInvocation.workspace");
    const captured = { ...value };
    if (typeof captured.path !== "string"
        || captured.path.length === 0
        || typeof captured.readOnly !== "boolean") {
        throw new AgentStepInvocationBindingError("bindInvocation.workspace must contain a non-empty path and boolean readOnly");
    }
    const allowedMount = required.mounts.find((mount) => mount.path === captured.path
        && (captured.readOnly || mount.mode === "rw"));
    if (!allowedMount) {
        throw new AgentStepInvocationBindingError(`bindInvocation.workspace ${JSON.stringify(captured.path)} (${captured.readOnly ? "ro" : "rw"}) is not declared by the required environment`);
    }
    return Object.freeze({
        path: captured.path,
        readOnly: captured.readOnly
    });
}
function sameStringSet(left, right) {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    return (leftSet.size === rightSet.size
        && [...leftSet].every((item) => rightSet.has(item)));
}
function snapshotCredentials(value, required) {
    if (value === null) {
        if (required.secretRefs.length > 0) {
            throw new AgentStepInvocationBindingError("bindInvocation.credentials is required because the required environment declares secretRefs");
        }
        return null;
    }
    if (required.secretRefs.length === 0) {
        throw new AgentStepInvocationBindingError("bindInvocation.credentials must be null when the required environment declares no secretRefs");
    }
    if (!isPlainRecord(value)) {
        throw new AgentStepInvocationBindingError("bindInvocation.credentials must be null or a ProvisionedCredentials object");
    }
    assertKnownKeys(value, new Set(["token", "secretRefs", "callbackUrl", "expiresAt"]), "bindInvocation.credentials");
    const captured = { ...value };
    const secretRefs = Array.isArray(captured.secretRefs)
        ? Array.from(captured.secretRefs)
        : null;
    if (typeof captured.token !== "string"
        || captured.token.length === 0
        || secretRefs === null
        || secretRefs.some((secretRef) => typeof secretRef !== "string" || secretRef.length === 0)
        || typeof captured.callbackUrl !== "string"
        || captured.callbackUrl.length === 0
        || typeof captured.expiresAt !== "number"
        || !Number.isFinite(captured.expiresAt)
        || !Number.isInteger(captured.expiresAt)
        || captured.expiresAt < 0) {
        throw new AgentStepInvocationBindingError("bindInvocation.credentials is not a valid ProvisionedCredentials object");
    }
    if (!sameStringSet(secretRefs, required.secretRefs)) {
        throw new AgentStepInvocationBindingError("bindInvocation.credentials.secretRefs must exactly match the required environment secretRefs");
    }
    return Object.freeze({
        token: captured.token,
        secretRefs: Object.freeze(secretRefs),
        callbackUrl: captured.callbackUrl,
        expiresAt: captured.expiresAt
    });
}
function snapshotCapabilities(value, credentials, allowedRouteCapabilities) {
    if (credentials === null) {
        if (value !== null && value !== undefined) {
            throw new AgentStepInvocationBindingError("bindInvocation.capabilities require non-null credentials");
        }
        return null;
    }
    if (!Array.isArray(value)) {
        throw new AgentStepInvocationBindingError("bindInvocation with credentials must carry an explicit capabilities array (empty means deny-all)");
    }
    const captured = Array.from(value);
    let capabilities;
    try {
        capabilities = asRouteVerbMasks(captured);
    }
    catch (error) {
        throw new AgentStepInvocationBindingError(`bindInvocation.capabilities are invalid route-verb masks: ${errorDetail(error)}`);
    }
    const allowed = new Set(allowedRouteCapabilities);
    const disallowed = capabilities.filter((capability) => !allowed.has(capability));
    if (disallowed.length > 0) {
        throw new AgentStepInvocationBindingError(`bindInvocation.capabilities exceed the adapter's allowed route set: ${disallowed.join(", ")}`);
    }
    return Object.freeze([...capabilities]);
}
function snapshotBinding(value, required, allowedRouteCapabilities) {
    if (!isPlainRecord(value)) {
        throw new AgentStepInvocationBindingError("bindInvocation must return an AgentInvocation binding object");
    }
    assertKnownKeys(value, BINDING_KEYS, "bindInvocation result");
    const captured = { ...value };
    if (typeof captured.agentRef !== "string"
        || captured.agentRef.trim().length === 0) {
        throw new AgentStepInvocationBindingError("bindInvocation must return a non-empty agentRef");
    }
    if (typeof captured.directive !== "string"
        || captured.directive.length === 0) {
        throw new AgentStepInvocationBindingError("bindInvocation must return a non-empty directive");
    }
    const context = snapshotContext(captured.context);
    const settings = snapshotSettings(captured.settings);
    const workspace = snapshotWorkspace(captured.workspace, required);
    const credentials = snapshotCredentials(captured.credentials, required);
    const capabilities = snapshotCapabilities(captured.capabilities, credentials, allowedRouteCapabilities);
    return Object.freeze({
        agentRef: captured.agentRef,
        directive: captured.directive,
        context,
        settings,
        workspace,
        credentials,
        capabilities,
        ...("harnessOptions" in captured
            ? { harnessOptions: captured.harnessOptions }
            : {})
    });
}
function failureOrDefault(failure, kind, detail) {
    if (failure === null || failure === undefined) {
        return { kind, detail };
    }
    return isPlainRecord(failure) ? { ...failure } : failure;
}
function resultFromInvocation(result, budget) {
    if (!isPlainRecord(result)) {
        throw new AgentStepResultMappingError("TurnExecutor returned a non-object AgentInvocationResult");
    }
    const captured = { ...result };
    const capturedUsage = captured.usage != null && isPlainRecord(captured.usage)
        ? { ...captured.usage }
        : captured.usage;
    const usage = capturedUsage == null ? [] : [capturedUsage];
    let candidate;
    switch (captured.outcome) {
        case "completed":
            if (usage.length === 0) {
                throw new AgentStepResultMappingError("completed AgentInvocationResult is missing its required usage-receipt.v1");
            }
            candidate = {
                schemaVersion: "agent-step-result.v1",
                status: "completed",
                output: captured.structured !== undefined
                    ? captured.structured
                    : captured.text,
                usage
            };
            break;
        case "failed":
            if (usage.length === 0) {
                throw new AgentStepResultMappingError("failed AgentInvocationResult is missing its required usage-receipt.v1");
            }
            candidate = {
                schemaVersion: "agent-step-result.v1",
                status: "failed",
                usage,
                failure: failureOrDefault(captured.failure, "agent-invocation-failed", "agent invocation failed without failure detail")
            };
            break;
        case "infra-error":
            candidate = {
                schemaVersion: "agent-step-result.v1",
                status: "infra_error",
                usage,
                failure: failureOrDefault(captured.failure, "agent-invocation-infra-error", "agent invocation ended in an infrastructure error without failure detail")
            };
            break;
        default: {
            const exhaustive = captured.outcome;
            throw new AgentStepResultMappingError(`unknown AgentInvocationResult outcome ${JSON.stringify(exhaustive)}`);
        }
    }
    try {
        const mapped = validateAgentStepResult(candidate);
        if (budget === undefined || mapped.usage.length === 0) {
            return mapped;
        }
        const chargedTokens = mapped.usage.reduce((total, receipt) => total + receipt.chargedTokens, 0);
        const chargedCostMicroUsd = mapped.usage.reduce((total, receipt) => total + receipt.chargedCostMicroUsd, 0);
        const elapsedMs = mapped.usage.reduce((total, receipt) => total + receipt.durationMs, 0);
        const exceeded = [];
        if (budget.maxTokens !== undefined
            && chargedTokens > budget.maxTokens) {
            exceeded.push(`maxTokens charged ${chargedTokens} > ${budget.maxTokens}`);
        }
        if (budget.maxCostMicroUsd !== undefined
            && chargedCostMicroUsd > budget.maxCostMicroUsd) {
            exceeded.push(`maxCostMicroUsd charged ${chargedCostMicroUsd} > ${budget.maxCostMicroUsd}`);
        }
        if (budget.maxElapsedMs !== undefined
            && elapsedMs > budget.maxElapsedMs) {
            exceeded.push(`maxElapsedMs observed ${elapsedMs} > ${budget.maxElapsedMs}`);
        }
        if (exceeded.length === 0)
            return mapped;
        return validateAgentStepResult({
            schemaVersion: "agent-step-result.v1",
            status: "failed",
            usage: mapped.usage,
            failure: {
                kind: "budget-exceeded",
                detail: `agent-step budget exceeded: ${exceeded.join("; ")}`
            }
        });
    }
    catch (error) {
        throw new AgentStepResultMappingError(`TurnExecutor returned an AgentInvocationResult that cannot satisfy agent-step-result.v1: ${errorDetail(error)}`);
    }
}
/**
 * Adapt a bound EAL environment to mission-pipeline's AgentStepExecutor port.
 *
 * There is deliberately no second timeout race: mission-pipeline's agent
 * invoker owns the authoritative deadline. The same signal is exposed to the
 * host binder and forwarded to the TurnExecutor for cooperative cancellation.
 */
export function agentStepPortFromEnvironment(environment, options) {
    const capturedOptions = options === null || typeof options !== "object"
        ? null
        : { ...options };
    if (capturedOptions === null
        || typeof capturedOptions.bindInvocation !== "function") {
        throw new AgentStepInvocationBindingError("agentStepPortFromEnvironment requires bindInvocation; stage identity is not an agent/persona binding");
    }
    const typedOptions = capturedOptions;
    const bindInvocation = typedOptions.bindInvocation;
    const describeInputOf = typedOptions.describeInput;
    const describeEnvironment = environment?.describe;
    const turnExecutor = environment?.executor;
    const executeTurn = turnExecutor?.execute;
    if (typeof describeEnvironment !== "function"
        || typeof executeTurn !== "function") {
        throw new AgentStepInvocationBindingError("agentStepPortFromEnvironment requires an environment with describe() and executor.execute()");
    }
    let allowedRouteCapabilities;
    try {
        allowedRouteCapabilities = Object.freeze(asRouteVerbMasks([
            ...(typedOptions.allowedRouteCapabilities ?? [])
        ]));
    }
    catch (error) {
        throw new AgentStepInvocationBindingError(`allowedRouteCapabilities are invalid: ${errorDetail(error)}`);
    }
    return Object.freeze({
        async execute(rawRequest, signal) {
            // EAL's own structural checks run BEFORE the Pipeline validator so a
            // malformed request still surfaces an EAL-typed error. Pipeline's
            // request validator is deliberately strict and would otherwise pre-empt
            // these with a generic Error, hiding which boundary rejected the call.
            const candidate = omitUndefinedLeaves(rawRequest);
            assertDenseInputArtifacts(candidate);
            // Validate the request-owned descriptor before any host lookup or
            // environment description. Malformed requirements never cross the EAL
            // composition boundary.
            const requiredEnvironment = descriptorFromUnknown(candidate.environment, "required environment");
            const request = validateAgentStepRequest(candidate);
            const fixedRequest = snapshotAgentStepRequest(request, requiredEnvironment);
            const describeInput = describeInputOf
                ? await describeInputOf(fixedRequest)
                : undefined;
            // Compute exactly once, before binding identities/artifacts or executing.
            const grantedEnvironment = descriptorFromUnknown(describeEnvironment.call(environment, describeInput), "granted environment");
            assertEnvironmentSubset(requiredEnvironment, grantedEnvironment);
            assertRequestContracts(fixedRequest, requiredEnvironment, grantedEnvironment);
            const binding = snapshotBinding(await bindInvocation({
                request: fixedRequest,
                requiredEnvironment,
                grantedEnvironment,
                ...(signal ? { signal } : {})
            }), requiredEnvironment, allowedRouteCapabilities);
            const invocation = {
                ...binding,
                // These two fields are owned by the frozen request and cannot be
                // redirected by a host binding.
                invocationId: fixedRequest.idempotencyKey,
                io: {
                    inputContract: requiredEnvironment.io.inputContract,
                    outputContract: requiredEnvironment.io.outputContract
                },
                ...(fixedRequest.budget !== undefined
                    ? { budget: fixedRequest.budget }
                    : {}),
                deadlineMs: fixedRequest.deadlineMs
            };
            return resultFromInvocation(await executeTurn.call(turnExecutor, invocation, signal), fixedRequest.budget);
        }
    });
}
