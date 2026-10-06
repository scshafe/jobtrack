declare const ROUTE_VERB_BRAND: unique symbol;
declare const RECORD_PROPOSAL_ROUTE_VERB_BRAND: unique symbol;
/** A mutation-route verb mask (e.g. "authorities.consult") — the token-scope
 *  namespace. Nominal: obtain one via asRouteVerbMask, never by assertion. */
export type RouteVerbMask = string & {
    readonly [ROUTE_VERB_BRAND]: true;
};
/** A host route whose operation is mechanically limited to recording a
 * proposal. The host still owns the surface name and must bind its `.record`
 * handler to proposal persistence only; EAL refuses send/apply/delegate verbs
 * before the corpus-read environment can mint them. */
export type RecordProposalRouteVerbMask = RouteVerbMask & {
    readonly [RECORD_PROPOSAL_ROUTE_VERB_BRAND]: true;
};
export declare class CapabilityNamespaceError extends Error {
    constructor(message: string);
}
/** Parse ONE route-verb mask. LOUD on anything that is not a dot-form verb —
 *  and pointedly loud when handed an EnvironmentCapability (the exact
 *  cross-namespace leak this module exists to stop). */
export declare function asRouteVerbMask(value: string): RouteVerbMask;
/** Parse the one route shape the corpus-read proposal environment may mint.
 * The surface remains host-owned; the operation is closed to `.record`. */
export declare function asRecordProposalRouteVerbMask(value: string): RecordProposalRouteVerbMask;
/** Parse a list of route-verb masks (order preserved, duplicates rejected). */
export declare function asRouteVerbMasks(values: readonly string[]): readonly RouteVerbMask[];
export {};
