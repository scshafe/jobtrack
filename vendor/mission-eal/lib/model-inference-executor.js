// model-inference-executor.ts — the "model-inference" TurnExecutor: one
// tool-less completion against an LlmClient (mission-restructure A2). This is
// the inbox classify shape — no codebase, no container, no mutation authority:
// the invocation's directive (+ assembled context as the system prompt) goes
// to the model; when io.outputContract is set the executor demands STRICT JSON
// and parses it LOUDLY into `structured`.
//
// Tool-less by construction: LlmClient has no tool channel, and this executor
// never grants one. Usage honesty: LlmCompletionResponse carries no telemetry,
// so receipts are trust="unavailable" with the charged floor of 1/1 (the
// execution-contracts non-silent-zero convention — "charged something, amount
// unknown" must never read as free). A client that later reports usage should
// surface it via a richer client seam, not by editing the floor.
const MAX_RECEIPT_DURATION_MS = 86_400_000;
function boundedDurationMs(startedAt, finishedAt) {
    const elapsed = Math.floor(finishedAt - startedAt);
    if (!Number.isFinite(elapsed))
        return 0;
    return Math.max(0, Math.min(MAX_RECEIPT_DURATION_MS, elapsed));
}
function unavailableUsage(durationMs) {
    return {
        schemaVersion: "usage-receipt.v1",
        trust: "unavailable",
        observedInputTokens: null,
        observedOutputTokens: null,
        chargedTokens: 1,
        observedCostMicroUsd: null,
        chargedCostMicroUsd: 1,
        durationMs
    };
}
function minimumDefined(...values) {
    const defined = values.filter((value) => value !== undefined);
    return defined.length === 0 ? undefined : Math.min(...defined);
}
function abortedError() {
    const error = new Error("model inference aborted before completion");
    error.name = "AbortError";
    return error;
}
function strictJsonInstruction(outputContract) {
    return (`Respond with a SINGLE JSON value conforming to the output contract "${outputContract}". ` +
        "No prose, no markdown fences, no leading or trailing text — the raw JSON value only.");
}
/** Extract the one JSON value from a completion. Tolerates surrounding
 *  whitespace only — anything else is a contract failure (LOUD, so a drifting
 *  model surfaces as `failed`, never as silently-unstructured output). */
function parseStrictJson(text) {
    const trimmed = text.trim();
    if (trimmed.length === 0)
        return { ok: false, detail: "empty completion where strict JSON was demanded" };
    try {
        return { ok: true, value: JSON.parse(trimmed) };
    }
    catch (error) {
        return { ok: false, detail: `completion is not strict JSON: ${error.message}` };
    }
}
export function createModelInferenceExecutor(options) {
    const { client } = options;
    const complete = client?.complete;
    if (typeof complete !== "function") {
        throw new Error("createModelInferenceExecutor: client must implement complete()");
    }
    const now = options.now ?? Date.now;
    return Object.freeze({
        kind: "model-inference",
        async execute(invocation, signal) {
            const outputContract = invocation.io?.outputContract ?? null;
            const systemParts = [];
            if (invocation.context?.systemText)
                systemParts.push(invocation.context.systemText);
            if (outputContract)
                systemParts.push(strictJsonInstruction(outputContract));
            const maxTokens = minimumDefined(options.maxTokens, invocation.budget?.maxTokens);
            const timeoutMs = minimumDefined(invocation.deadlineMs, invocation.budget?.maxElapsedMs);
            const completionRequest = {
                ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
                prompt: invocation.directive,
                ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
                ...(maxTokens !== undefined ? { maxTokens } : {})
            };
            let text;
            let clientStarted = false;
            const startedAt = now();
            try {
                if (signal?.aborted)
                    throw abortedError();
                clientStarted = true;
                const response = signal !== undefined || timeoutMs !== undefined
                    ? await complete.call(client, completionRequest, {
                        ...(signal !== undefined ? { signal } : {}),
                        ...(timeoutMs !== undefined ? { timeoutMs } : {})
                    })
                    : await complete.call(client, completionRequest);
                text = response.text;
            }
            catch (error) {
                return {
                    outcome: "infra-error",
                    text: null,
                    usage: clientStarted
                        ? unavailableUsage(boundedDurationMs(startedAt, now()))
                        : null,
                    failure: { kind: "llm-client", detail: error.message || "completion failed" }
                };
            }
            const usage = unavailableUsage(boundedDurationMs(startedAt, now()));
            if (outputContract === null) {
                return { outcome: "completed", text, usage, failure: null };
            }
            const parsed = parseStrictJson(text);
            if (!parsed.ok) {
                return {
                    outcome: "failed",
                    text,
                    usage,
                    failure: { kind: "output-contract", detail: `${outputContract}: ${parsed.detail}` }
                };
            }
            return { outcome: "completed", text, structured: parsed.value, usage, failure: null };
        }
    });
}
