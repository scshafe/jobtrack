/**
 * Provider-agnostic LLM client interface used by Mission Control components
 * that need to call a language model (e.g., the workflow governor's
 * LlmJudgmentEvaluator).
 *
 * Implementations decide how the model is reached (subprocess CLI, HTTP API,
 * local server, etc.) and how auth is handled. Callers depend only on
 * `LlmClient.complete()`, so any backend that satisfies the interface can be
 * dropped in without code changes elsewhere.
 *
 * V1 ships SubprocessLlmClient, which pipes the prompt to a configurable
 * command's stdin and reads stdout. That covers OAUTH-backed CLIs (e.g.
 * `claude --print`) without coupling Mission Control to any particular
 * provider's SDK.
 */
export interface LlmCompletionRequest {
    /** Optional system prompt. Implementations may inline into the user prompt or pass via a dedicated channel. */
    system?: string;
    /** The user prompt. Required. */
    prompt: string;
    /** Optional decoding hint. Implementations may ignore. */
    temperature?: number;
    /** Optional decoding hint. Implementations may ignore. */
    maxTokens?: number;
}
export interface LlmCompletionResponse {
    /** Plain-text content of the completion. */
    text: string;
    /** Implementation-defined raw response (for debugging, logging). */
    raw?: unknown;
}
/** Cooperative controls are deliberately separate from the serialized model
 * request: adding a deadline must not change provider request bytes. */
export interface LlmCompletionControls {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}
export interface LlmClient {
    complete(request: LlmCompletionRequest, controls?: LlmCompletionControls): Promise<LlmCompletionResponse>;
}
export interface SubprocessLlmClientOptions {
    /**
     * Command + argv to invoke. The prompt is written to the subprocess's stdin
     * (per `formatStdin`); stdout is read as the response (per `parseStdout`).
     * Defaults to `["claude", "--print"]`.
     */
    command?: string[];
    /** Extra env vars to merge into the subprocess environment. */
    env?: Record<string, string>;
    /** Working directory for the subprocess. */
    cwd?: string;
    /**
     * Render the LlmCompletionRequest into the stdin payload. Default: emits
     * `system\n\nprompt` when both present, otherwise just `prompt`.
     */
    formatStdin?: (request: LlmCompletionRequest) => string;
    /**
     * Extract the response text from raw stdout. Default: identity (assumes the
     * CLI prints the assistant's content as plain text). Override when the CLI
     * wraps output in JSON.
     */
    parseStdout?: (stdout: string) => string;
    /** Subprocess timeout in milliseconds. Default 120_000 (2 min). */
    timeoutMs?: number;
}
export declare function createSubprocessLlmClient(options?: SubprocessLlmClientOptions): LlmClient;
export interface HttpLlmClientOptions {
    /** Server base URL (e.g. http://linux-host:8000) or a full
     * .../chat/completions endpoint; bases get /v1/chat/completions appended. */
    url: string;
    model: string;
    /** Bearer token; local servers usually need none. */
    apiKey?: string;
    extraHeaders?: Record<string, string>;
    /** Request timeout in milliseconds. Default 120_000 (2 min). */
    timeoutMs?: number;
    /** Test seam. Defaults to global fetch. */
    fetchImpl?: typeof fetch;
}
export declare function createHttpLlmClient(options: HttpLlmClientOptions): LlmClient;
/**
 * Parse a shell-quoted command string into an argv array (e.g. for reading
 * --llm-command from CLI flags). Handles simple double-quoted segments;
 * not a full shell parser.
 */
export declare function parseCommandString(input: string): string[];
