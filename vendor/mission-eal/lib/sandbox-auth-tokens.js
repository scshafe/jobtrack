// Per-turn sandbox auth tokens.
//
// Phase B step 5 of PROPOSAL-DOCKER-OPENCODE-SANDBOX. A token is minted right
// before a `docker run --rm` is spawned and is bound to
// (projectId, chatSessionId, turnId). The in-container `mission-control`
// bundle reads MC_AUTH_TOKEN from env and attaches
// X-Mission-Control-Auth-Token on every /api/mutations/* call; the web
// router validates the header before routing the mutation.
//
// Storage defaults to in-memory: tokens die with the web process, which matches
// the single-process posture. Mission Restructure A6 also promotes this contract
// to an async PostgreSQL authority for cross-process validation, selected only
// behind the host's explicit backend flag.
import { randomBytes } from "node:crypto";
/** Adapt the sync in-memory store to the promoted async interface. SAME store
 *  instance = the mint==validate authority is preserved across both views. */
export function asAsyncSandboxAuthTokenStore(store) {
    const mint = store.mint.bind(store);
    const validate = store.validate.bind(store);
    const revokeForTurn = store.revokeForTurn.bind(store);
    const cleanup = store.cleanup.bind(store);
    return Object.freeze({
        mint: async (input) => mint(input),
        validate: async (token, scope) => validate(token, scope),
        revokeForTurn: async (turnId) => revokeForTurn(turnId),
        cleanup: async () => cleanup()
    });
}
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const TOKEN_PREFIX = "mcst_";
const TOKEN_BYTES = 32;
/** First 8 hex chars of a token (after the mcst_ prefix) — enough to correlate a
 * mint with a later validate/revoke WITHOUT logging the secret itself. */
function tokenFingerprint(token) {
    return typeof token === "string" && token.startsWith(TOKEN_PREFIX)
        ? token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 8)
        : "????????";
}
function snapshotCapabilities(capabilities) {
    if (capabilities === undefined)
        return undefined;
    if (!Array.isArray(capabilities)) {
        throw new Error("sandbox auth token mint: capabilities must be an array of strings when provided.");
    }
    const length = capabilities.length;
    const snapshot = [];
    for (let index = 0; index < length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(capabilities, index)) {
            throw new Error("sandbox auth token mint: capabilities must be an array of strings when provided.");
        }
        const capability = capabilities[index];
        if (typeof capability !== "string") {
            throw new Error("sandbox auth token mint: capabilities must be an array of strings when provided.");
        }
        snapshot.push(capability);
    }
    return Object.freeze(snapshot);
}
// Probe 1 (observability): the in-memory token store emits no event/log on its own, so
// the auth.scoped-token preflight cannot distinguish "never minted" from "revoked too
// early". Emit a gated debug line on mint / validate-failure / revoke carrying the turnId
// + an 8-hex token fingerprint (NEVER the token itself). The gate is inlined (rather than
// importing the executor's logChatPipelineDebug) to keep this leaf module cycle-free; the
// `[mc-chat-pipeline]` prefix keeps it in the same captured log stream.
function logSandboxTokenDebug(stage, payload) {
    if (process.env.MISSION_CONTROL_CHAT_EXEC_DEBUG === "0")
        return;
    try {
        console.log(`[mc-chat-pipeline] sandbox-token.${stage} ${JSON.stringify(payload)}`);
    }
    catch {
        // logging must never break the token path
    }
}
export function createSandboxAuthTokenStore(options = {}) {
    const now = options.now ?? Date.now;
    const defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    const rng = options.randomBytes ?? randomBytes;
    const tokens = new Map();
    function generateToken() {
        return `${TOKEN_PREFIX}${rng(TOKEN_BYTES).toString("hex")}`;
    }
    return {
        mint(input) {
            // Snapshot every caller-owned field exactly once. In addition to closing
            // getter/TOCTOU tricks at the credential boundary, cloning capabilities
            // prevents a caller from widening a live token after mint by mutating the
            // original array. Undefined and [] remain distinct; duplicates and
            // authored order remain byte-for-byte intact.
            const projectId = input.projectId;
            const chatSessionId = input.chatSessionId;
            const turnId = input.turnId;
            const runId = input.runId;
            const requestedTtlMs = input.ttlMs;
            const capabilities = snapshotCapabilities(input.capabilities);
            if (!projectId.trim() || !chatSessionId.trim() || !turnId.trim()) {
                throw new Error("sandbox auth token mint: projectId, chatSessionId, and turnId are required.");
            }
            const ttlMs = requestedTtlMs ?? defaultTtlMs;
            if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
                throw new Error(`sandbox auth token mint: ttlMs must be a positive number (got ${ttlMs}).`);
            }
            const issuedAt = now();
            const expiresAt = issuedAt + ttlMs;
            if (!Number.isFinite(expiresAt)) {
                throw new Error("sandbox auth token expiresAt must be finite.");
            }
            let token = generateToken();
            while (tokens.has(token)) {
                token = generateToken();
            }
            const tokenScope = Object.freeze({
                projectId,
                chatSessionId,
                turnId,
                ...(runId ? { runId } : {}),
                expiresAt,
                ...(capabilities !== undefined ? { capabilities } : {})
            });
            tokens.set(token, tokenScope);
            logSandboxTokenDebug("mint", {
                turnId,
                tokenFp8: tokenFingerprint(token),
                projectId,
                chatSessionId,
                capabilities: capabilities?.length ?? null,
                expiresAt
            });
            return token;
        },
        validate(token, scope) {
            const requestedProjectId = scope?.projectId;
            const requestedChatSessionId = scope?.chatSessionId;
            const fail = (reason) => {
                logSandboxTokenDebug("validate.fail", {
                    tokenFp8: tokenFingerprint(token),
                    reason,
                    requestedProjectId,
                    requestedChatSessionId
                });
                return Object.freeze({ ok: false, reason });
            };
            if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) {
                return fail("token is not a Mission Control sandbox token");
            }
            const record = tokens.get(token);
            if (!record) {
                return fail("token is unknown or has been revoked");
            }
            if (record.expiresAt <= now()) {
                tokens.delete(token);
                return fail("token has expired");
            }
            if (requestedProjectId !== undefined && record.projectId !== requestedProjectId) {
                return fail(`token projectId "${record.projectId}" does not match request projectId "${requestedProjectId}"`);
            }
            if (requestedChatSessionId !== undefined && record.chatSessionId !== requestedChatSessionId) {
                return fail(`token chatSessionId "${record.chatSessionId}" does not match request chatSessionId "${requestedChatSessionId}"`);
            }
            return Object.freeze({ ok: true, scope: record });
        },
        revokeForTurn(turnId) {
            let dropped = 0;
            for (const [token, record] of tokens.entries()) {
                if (record.turnId === turnId) {
                    tokens.delete(token);
                    dropped += 1;
                }
            }
            logSandboxTokenDebug("revoke", { turnId, dropped });
            return dropped;
        },
        cleanup() {
            const cutoff = now();
            let dropped = 0;
            for (const [token, record] of tokens.entries()) {
                if (record.expiresAt <= cutoff) {
                    tokens.delete(token);
                    dropped += 1;
                }
            }
            return dropped;
        },
        size() {
            return tokens.size;
        }
    };
}
/**
 * Resolve the per-turn sandbox token TTL the web boot path uses, so any OTHER
 * process that mints these tokens (the scheduler's queued docker build turns,
 * P4.x) derives the SAME lifetime rather than the bare 10-min default. The token
 * must outlive the longest possible turn: the turn timeout is 1h-configurable
 * (MISSION_CONTROL_OPENCODE_CLI_TIMEOUT_MS) and the TTL tracks it + 5 min slack,
 * floored at 65 min. Explicit override: MISSION_CONTROL_SANDBOX_TOKEN_TTL_MS.
 */
export function resolveSandboxTokenTtlMs(env = process.env) {
    const explicit = Number(env.MISSION_CONTROL_SANDBOX_TOKEN_TTL_MS);
    if (Number.isFinite(explicit) && explicit > 0)
        return explicit;
    const turnTimeout = Number(env.MISSION_CONTROL_OPENCODE_CLI_TIMEOUT_MS);
    const base = Number.isFinite(turnTimeout) && turnTimeout > 0 ? turnTimeout : 60 * 60 * 1000;
    return Math.max(base + 5 * 60 * 1000, 65 * 60 * 1000);
}
/**
 * Header used on the wire. Lowercase form keeps node:http happy — request
 * headers are normalized to lowercase before lookup.
 */
export const SANDBOX_AUTH_TOKEN_HEADER = "x-mission-control-auth-token";
