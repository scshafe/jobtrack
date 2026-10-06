// Provision manifest — the generic vocabulary for "everything an agent
// invocation needs before it can run": a declarative list of independently
// checkable resource items walked by the companion verifier (preflight.ts),
// which aborts the invocation LOUDLY if any item is absent, so a turn never
// starts degraded.
//
// Why this exists: a real kick-off failed silently because the docker sandbox
// was missing things the agent was told to use — the `mission-control` CLI was
// not on the image's PATH, the prompt's web URL pointed at the container's own
// loopback (127.0.0.1) instead of the host, and a referenced file was not
// mounted. None of it surfaced until someone exec'd into the container. The
// manifest turns each of those into an independently-checkable item with a
// specific, named failure message.
//
// Design notes:
// - Each item is independently checkable: the verifier evaluates them all and
//   reports the FIRST failure with a precise message (which resource, why).
// - We prefer FILES over env reliance. Mount sources are checked by stat-ing
//   the host path; the in-image CLI is checked by probing the image. The one
//   unavoidable env item (MISSION_CONTROL_WEB_URL) is flagged as `envOnly` so
//   the files-over-env migration can find it later.
// - The check kinds are a closed discriminated union so the verifier can switch
//   exhaustively and a test can assert each branch.
//
// The concrete builder for MC's opencode-docker sandbox turns
// (buildOpenCodeSandboxResourceManifest) stays in mc-harness — this module is
// the host-agnostic vocabulary the EAL exposes to every consumer.
/**
 * Rewrite a container-facing URL so the HOST can reach the same service. The
 * in-container CLI is handed http://host.docker.internal:PORT (and on older
 * setups callers have mistakenly handed it 127.0.0.1, which inside a container
 * is the container itself — the exact silent-failure this guard exists for).
 * Either way, from the host the service lives on loopback, so we swap the
 * authority's hostname to 127.0.0.1 while preserving scheme/port/path.
 */
export function hostReachableUrlForContainerWebUrl(webUrl) {
    let url;
    try {
        url = new URL(webUrl);
    }
    catch {
        // Not a parseable URL — hand it back unchanged so the web-endpoint check
        // fails loudly on the probe instead of here.
        return webUrl;
    }
    if (url.hostname === "host.docker.internal") {
        url.hostname = "127.0.0.1";
    }
    return url.toString();
}
/**
 * Project a manifest item to the compact descriptor surfaced in the
 * chat.provisioning.failed event payload. Kept beside the manifest so the event
 * shape can't drift from the item shape as the manifest evolves.
 */
export function manifestItemToEventPayload(item) {
    return {
        key: item.key,
        category: item.category,
        description: item.description,
        ...(item.envOnly ? { envOnly: true } : {})
    };
}
