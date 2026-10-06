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
import { spawn } from "node:child_process";
const DEFAULT_COMMAND = ["claude", "--print"];
const DEFAULT_TIMEOUT_MS = 120_000;
function effectiveTimeoutMs(configured, requested) {
    return requested === undefined ? configured : Math.min(configured, requested);
}
function abortError(target) {
    const error = new Error(`${target} aborted`);
    error.name = "AbortError";
    return error;
}
function defaultFormatStdin(request) {
    if (request.system && request.system.length > 0) {
        return `${request.system}\n\n${request.prompt}`;
    }
    return request.prompt;
}
export function createSubprocessLlmClient(options = {}) {
    const command = options.command ?? DEFAULT_COMMAND;
    if (command.length === 0) {
        throw new Error("createSubprocessLlmClient: command must contain at least one element.");
    }
    const formatStdin = options.formatStdin ?? defaultFormatStdin;
    const parseStdout = options.parseStdout ?? ((stdout) => stdout.trim());
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return {
        async complete(request, controls) {
            if (controls?.signal?.aborted) {
                throw abortError("LLM subprocess");
            }
            const stdinPayload = formatStdin(request);
            const result = await runSubprocess(command, stdinPayload, {
                env: options.env,
                cwd: options.cwd,
                timeoutMs: effectiveTimeoutMs(timeoutMs, controls?.timeoutMs),
                signal: controls?.signal
            });
            const text = parseStdout(result.stdout);
            return {
                text,
                raw: {
                    command,
                    exitCode: result.exitCode,
                    stdoutLength: result.stdout.length,
                    stderrLength: result.stderr.length,
                    stderrPreview: result.stderr.slice(0, 500)
                }
            };
        }
    };
}
function runSubprocess(command, stdin, options) {
    const [cmd, ...args] = command;
    if (!cmd) {
        return Promise.reject(new Error("runSubprocess: command is empty"));
    }
    if (options.signal?.aborted) {
        return Promise.reject(abortError("LLM subprocess"));
    }
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            env: { ...process.env, ...(options.env ?? {}) },
            cwd: options.cwd,
            stdio: ["pipe", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const cleanup = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
        };
        const rejectOnce = (error, terminate) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            if (terminate)
                child.kill("SIGTERM");
            reject(error);
        };
        const onAbort = () => {
            rejectOnce(abortError("LLM subprocess"), true);
        };
        const timer = setTimeout(() => {
            rejectOnce(new Error(`LLM subprocess "${command.join(" ")}" timed out after ${options.timeoutMs}ms`), true);
        }, options.timeoutMs);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) {
            onAbort();
            return;
        }
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (err) => {
            rejectOnce(err, false);
        });
        child.on("close", (code) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            const exitCode = code ?? 0;
            if (exitCode !== 0) {
                reject(new Error(`LLM subprocess "${command.join(" ")}" exited with code ${exitCode}: ${stderr.slice(0, 500)}`));
                return;
            }
            resolve({ stdout, stderr, exitCode });
        });
        child.stdin.on("error", (err) => {
            rejectOnce(err, true);
        });
        child.stdin.write(stdin);
        child.stdin.end();
    });
}
export function createHttpLlmClient(options) {
    const base = options.url.trim().replace(/\/$/, "");
    if (!base)
        throw new Error("createHttpLlmClient: url must be non-empty.");
    const endpoint = /\/chat\/completions$/.test(base) ? base : `${base}/v1/chat/completions`;
    const model = options.model.trim();
    if (!model)
        throw new Error("createHttpLlmClient: model must be non-empty.");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchImpl = options.fetchImpl ?? fetch;
    return {
        async complete(request, controls) {
            if (controls?.signal?.aborted) {
                throw abortError(`LLM HTTP request to ${endpoint}`);
            }
            const messages = [];
            if (request.system && request.system.length > 0) {
                messages.push({ role: "system", content: request.system });
            }
            messages.push({ role: "user", content: request.prompt });
            const controller = new AbortController();
            const requestTimeoutMs = effectiveTimeoutMs(timeoutMs, controls?.timeoutMs);
            let abortCause = null;
            const onAbort = () => {
                if (abortCause === null)
                    abortCause = "external";
                controller.abort();
            };
            controls?.signal?.addEventListener("abort", onAbort, { once: true });
            if (controls?.signal?.aborted) {
                controls.signal.removeEventListener("abort", onAbort);
                throw abortError(`LLM HTTP request to ${endpoint}`);
            }
            const timer = setTimeout(() => {
                if (abortCause === null)
                    abortCause = "timeout";
                controller.abort();
            }, requestTimeoutMs);
            try {
                const response = await fetchImpl(endpoint, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
                        ...(options.extraHeaders ?? {})
                    },
                    body: JSON.stringify({
                        model,
                        messages,
                        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {})
                    }),
                    signal: controller.signal
                });
                const text = await response.text();
                if (!response.ok) {
                    throw new Error(`LLM HTTP request to ${endpoint} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
                }
                let parsed;
                try {
                    parsed = JSON.parse(text);
                }
                catch {
                    throw new Error(`LLM HTTP response from ${endpoint} was not JSON: ${text.slice(0, 200)}`);
                }
                const record = parsed;
                const content = record.choices?.[0]?.message?.content;
                if (typeof content !== "string" || content.length === 0) {
                    throw new Error(`LLM HTTP response from ${endpoint} carried no choices[0].message.content.`);
                }
                return {
                    text: content,
                    raw: { status: response.status, model: record.model ?? model, usage: record.usage ?? null }
                };
            }
            catch (error) {
                if (abortCause === "timeout") {
                    throw new Error(`LLM HTTP request to ${endpoint} timed out after ${requestTimeoutMs}ms`);
                }
                if (abortCause === "external"
                    || controls?.signal?.aborted
                    || (error instanceof Error && error.name === "AbortError")) {
                    throw abortError(`LLM HTTP request to ${endpoint}`);
                }
                throw error;
            }
            finally {
                clearTimeout(timer);
                controls?.signal?.removeEventListener("abort", onAbort);
            }
        }
    };
}
// ----------------------------------------------------------------------------
// Helpers for callers
// ----------------------------------------------------------------------------
/**
 * Parse a shell-quoted command string into an argv array (e.g. for reading
 * --llm-command from CLI flags). Handles simple double-quoted segments;
 * not a full shell parser.
 */
export function parseCommandString(input) {
    const tokens = [];
    let current = "";
    let inQuote = null;
    let escape = false;
    for (const ch of input) {
        if (escape) {
            current += ch;
            escape = false;
            continue;
        }
        if (ch === "\\") {
            escape = true;
            continue;
        }
        if (inQuote) {
            if (ch === inQuote) {
                inQuote = null;
            }
            else {
                current += ch;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            inQuote = ch;
            continue;
        }
        if (ch === " " || ch === "\t") {
            if (current.length > 0) {
                tokens.push(current);
                current = "";
            }
            continue;
        }
        current += ch;
    }
    if (inQuote)
        throw new Error(`Unclosed quote in command string: ${input}`);
    if (current.length > 0)
        tokens.push(current);
    return tokens;
}
