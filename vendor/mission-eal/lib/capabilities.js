// capabilities.ts — the TWO capability namespaces, kept nominally distinct.
//
// MC has two vocabularies that both casually read as "capabilities", and a
// cross-namespace leak would be silent authority drift (mission-restructure
// critique finding 6):
//
//   1. EnvironmentCapability (descriptor.ts) — the CLOSED, frozen-schema enum
//      describing what an environment POSTURE grants ("network:model",
//      "filesystem:workspace", "mail:send", …). Colon-separated. Lives in the
//      cross-repo EnvironmentDescriptor contract; additions are frozen-contract
//      changes.
//   2. RouteVerbMask (here) — a mutation-route VERB the per-turn scoped auth
//      token is narrowed to ("authorities.consult", "tasks.delegate",
//      "projectChats.asyncChat", …). Dot-separated, host-defined, minted into
//      SandboxAuthTokenScope capabilities (the R5 one-verb masks).
//
// The provisioner takes RouteVerbMask[]; the descriptor/context take
// EnvironmentCapability[]. The brands make a cross-namespace assignment a type
// error, and asRouteVerbMask rejects colon-namespace strings LOUDLY at runtime
// so a value smuggled through `string` still cannot cross.
import { ENVIRONMENT_CAPABILITIES } from "./descriptor.js";
/** Route verbs are `<surface>.<verb>` — lowerCamel segments joined by ONE dot.
 *  (Matches every existing mask: authorities.consult, tasks.delegate,
 *  projectChats.asyncChat, reviews.submitVerdict, …). */
const ROUTE_VERB_RE = /^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/;
const ENVIRONMENT_CAPABILITY_SET = new Set(ENVIRONMENT_CAPABILITIES);
export class CapabilityNamespaceError extends Error {
    constructor(message) {
        super(message);
        this.name = "CapabilityNamespaceError";
    }
}
/** Parse ONE route-verb mask. LOUD on anything that is not a dot-form verb —
 *  and pointedly loud when handed an EnvironmentCapability (the exact
 *  cross-namespace leak this module exists to stop). */
export function asRouteVerbMask(value) {
    if (typeof value !== "string") {
        throw new CapabilityNamespaceError(`not a route-verb mask: expected a string (got ${value === null ? "null" : typeof value})`);
    }
    if (ENVIRONMENT_CAPABILITY_SET.has(value) || value.includes(":")) {
        throw new CapabilityNamespaceError(`route-verb mask expected, got the environment-capability namespace: "${value}" — ` +
            "descriptor/context surfaces take EnvironmentCapability; the credential provisioner takes route verbs (\"surface.verb\")");
    }
    if (!ROUTE_VERB_RE.test(value)) {
        throw new CapabilityNamespaceError(`not a route-verb mask: "${value}" (expected "<surface>.<verb>", e.g. "authorities.consult")`);
    }
    return value;
}
/** Parse the one route shape the corpus-read proposal environment may mint.
 * The surface remains host-owned; the operation is closed to `.record`. */
export function asRecordProposalRouteVerbMask(value) {
    const route = asRouteVerbMask(value);
    if (!route.endsWith(".record")) {
        throw new CapabilityNamespaceError(`not a record-proposal route: "${route}" (the operation must be exactly ".record"; send/apply/delegate authority is forbidden)`);
    }
    return route;
}
/** Parse a list of route-verb masks (order preserved, duplicates rejected). */
export function asRouteVerbMasks(values) {
    const seen = new Set();
    return Array.from(values, (value) => {
        const mask = asRouteVerbMask(value);
        if (seen.has(mask)) {
            throw new CapabilityNamespaceError(`duplicate route-verb mask: "${mask}"`);
        }
        seen.add(mask);
        return mask;
    });
}
