// Sandbox preflight verifier — asserts every item in a SandboxResourceManifest
// is present/usable BEFORE the real `opencode run`, and aborts the turn LOUDLY
// and specifically if any resource an agent needs is absent. Modeled in the
// spirit of detectOpenCodeInfraError's loud, named failures: never start a
// degraded turn.
//
// Verification strategy (cheapest assertions first, per item):
//  - host-path     stat the mount source on the host (does it exist + is it the
//                  expected file/dir, readable by us).
//  - web-endpoint  HTTP-probe the host-reachable URL (does Mission Control web
//                  answer); a connection refused here is the silent-callback
//                  bug the manifest exists to catch.
//  - image-cli     `docker run --entrypoint bash <image> -c 'command -v <cli>'`
//                  — the one container probe. Throttled + cached per
//                  (image,command) so we do not pay a container start on every
//                  turn.
//  - value-present a pure in-memory non-empty-string check (auth token).
//
// On the FIRST failing item the verifier throws SandboxProvisioningError
// (carrying the item key + the low-level reason) and does NOT continue — the
// caller must not spawn the turn. The caller is also responsible for emitting
// the chat.provisioning.failed mission event; see project-chat-backend-opencode.
import { access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { getHarnessDescriptor } from "./harness-registry.js";
/**
 * Thrown when a sandbox resource fails preflight. `resourceKey` is the manifest
 * item key (e.g. "image.cli"); `category` mirrors the item's category; `detail`
 * is the low-level reason from the check seam. The message is already the loud,
 * specific operator-facing string from the manifest item's failure() renderer.
 */
export class SandboxProvisioningError extends Error {
    resourceKey;
    category;
    detail;
    constructor(input) {
        super(input.message);
        this.name = "SandboxProvisioningError";
        this.resourceKey = input.resourceKey;
        this.category = input.category;
        this.detail = input.detail;
    }
}
const WEB_ENDPOINT_TIMEOUT_MS = 4_000;
const IMAGE_CLI_PROBE_TIMEOUT_MS = 30_000;
// How long a successful image-CLI probe stays trusted before we re-probe. The
// image rarely changes mid-session, so a per-turn container start is wasteful;
// a short TTL keeps us honest after a rebuild without paying every turn.
const IMAGE_CLI_PROBE_TTL_MS = 5 * 60 * 1000;
async function defaultStatPath(path, expect) {
    let info;
    try {
        info = await stat(path);
    }
    catch (error) {
        return { ok: false, detail: error.message };
    }
    if (expect === "directory" && !info.isDirectory()) {
        return { ok: false, detail: "path exists but is not a directory" };
    }
    if (expect === "file" && !info.isFile()) {
        return { ok: false, detail: "path exists but is not a regular file" };
    }
    try {
        await access(path, fsConstants.R_OK);
    }
    catch (error) {
        return { ok: false, detail: `not readable: ${error.message}` };
    }
    return { ok: true };
}
async function defaultProbeWebEndpoint(hostProbeUrl) {
    const fetchImpl = globalThis.fetch;
    if (typeof fetchImpl !== "function") {
        return { ok: false, detail: "no global fetch available to probe the web endpoint" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEB_ENDPOINT_TIMEOUT_MS);
    try {
        // Any HTTP answer (even 404/401) proves the host endpoint is up and
        // reachable, which is all this item asserts; a transport-level throw
        // (ECONNREFUSED / DNS / abort) is the real failure.
        const response = await fetchImpl(hostProbeUrl, { method: "GET", signal: controller.signal });
        void response;
        return { ok: true };
    }
    catch (error) {
        return { ok: false, detail: error.message || "request failed" };
    }
    finally {
        clearTimeout(timer);
    }
}
function defaultProbeImageCli(input) {
    return new Promise((resolve) => {
        // `command -v <cli>` is a bash builtin that exits 0 iff the command
        // resolves on PATH. --entrypoint bash overrides the image's opencode
        // entrypoint so we run our probe instead of starting an agent. Use a
        // NON-login shell (-c, never -lc): the image puts the mission-control CLI
        // on PATH via the Dockerfile ENV (/opt/mc-shell), but a Debian login shell
        // sources /etc/profile and RESETS PATH to a default that drops
        // /opt/mc-shell — so -lc falsely reports the CLI missing. opencode (the
        // real entrypoint) runs the agent's commands non-login, so -c also matches
        // what the agent actually sees.
        execFile(input.dockerBinary, ["run", "--rm", "--entrypoint", "bash", input.image, "-c", `command -v ${input.command}`], { timeout: IMAGE_CLI_PROBE_TIMEOUT_MS, windowsHide: true, env: { ...process.env, NO_COLOR: "1" } }, (error, stdout) => {
            if (error && error.code === "ENOENT") {
                resolve({ ok: false, detail: `docker binary "${input.dockerBinary}" not found on PATH` });
                return;
            }
            if (error && error.code === "ETIMEDOUT") {
                resolve({ ok: false, detail: `image CLI probe timed out after ${IMAGE_CLI_PROBE_TIMEOUT_MS}ms` });
                return;
            }
            if (error) {
                resolve({ ok: false, detail: `"${input.command}" not found on PATH inside the image` });
                return;
            }
            if (!stdout || !stdout.trim()) {
                resolve({ ok: false, detail: `"${input.command}" resolved to an empty path inside the image` });
                return;
            }
            resolve({ ok: true });
        });
    });
}
// Process-wide throttle cache for the (expensive) image-CLI probe. Keyed by
// dockerBinary + image + command; a successful probe is trusted for
// IMAGE_CLI_PROBE_TTL_MS. Failures are never cached so a fix is picked up on
// the very next turn.
const imageCliProbeCache = new Map();
function imageCliCacheKey(input) {
    return `${input.dockerBinary}${input.image}${input.command}`;
}
/** Test-only: clear the throttle cache so probe-count assertions are isolated. */
export function resetImageCliProbeCacheForTest() {
    imageCliProbeCache.clear();
}
function valuePresentOutcome(value) {
    return typeof value === "string" && value.trim().length > 0
        ? { ok: true }
        : { ok: false, detail: "value is empty or unset" };
}
async function runCheck(check, seams, now) {
    switch (check.kind) {
        case "host-path": {
            const statPath = seams.statPath ?? defaultStatPath;
            return statPath(check.path, check.expect);
        }
        case "web-endpoint": {
            const probe = seams.probeWebEndpoint ?? defaultProbeWebEndpoint;
            return probe(check.hostProbeUrl);
        }
        case "image-cli": {
            const probe = seams.probeImageCli ?? defaultProbeImageCli;
            const key = imageCliCacheKey(check);
            const trustedUntil = imageCliProbeCache.get(key);
            if (trustedUntil !== undefined && trustedUntil > now()) {
                return { ok: true };
            }
            const outcome = await probe({ image: check.image, command: check.command, dockerBinary: check.dockerBinary });
            if (outcome.ok) {
                imageCliProbeCache.set(key, now() + IMAGE_CLI_PROBE_TTL_MS);
            }
            else {
                imageCliProbeCache.delete(key);
            }
            return outcome;
        }
        case "value-present":
            return valuePresentOutcome(check.value);
        case "cred-store": {
            const probe = seams.probeHarnessCredential
                ?? (async (harnessKind) => {
                    const descriptor = getHarnessDescriptor(harnessKind);
                    if (!descriptor) {
                        return { ok: false, detail: `no harness descriptor registered for "${harnessKind}"` };
                    }
                    return descriptor.credential.probe();
                });
            const status = await probe(check.harnessKind);
            return status.ok ? { ok: true } : { ok: false, detail: status.detail };
        }
        default: {
            const exhaustive = check;
            return { ok: false, detail: `unknown check kind: ${JSON.stringify(exhaustive)}` };
        }
    }
}
/**
 * Verify every item in the manifest. Items are checked in order; the FIRST
 * failure throws SandboxProvisioningError with that item's loud, specific
 * message and the verifier returns nothing on success. The caller must not
 * spawn the turn when this throws.
 */
export async function verifySandboxProvisioning(input) {
    const seams = input.seams ?? {};
    const now = seams.now ?? Date.now;
    for (const item of input.manifest.items) {
        const outcome = await runCheck(item.check, seams, now);
        if (!outcome.ok) {
            throw new SandboxProvisioningError({
                resourceKey: item.key,
                category: item.category,
                detail: outcome.detail,
                message: item.failure(outcome.detail)
            });
        }
    }
}
