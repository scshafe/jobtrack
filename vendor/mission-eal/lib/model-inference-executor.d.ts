import type { LlmClient } from "./llm-client.js";
import type { TurnExecutor } from "./executor.js";
export interface CreateModelInferenceExecutorOptions {
    readonly client: LlmClient;
    /** Decoding defaults forwarded to the client (an invocation cannot override
     *  them — bindings own decoding; keep the executor deterministic per config). */
    readonly temperature?: number;
    readonly maxTokens?: number;
    /** Injectable epoch/monotonic millisecond clock for exact receipt tests. */
    readonly now?: () => number;
}
export declare function createModelInferenceExecutor(options: CreateModelInferenceExecutorOptions): TurnExecutor;
