// tools.ts — one declarative tool source projected into provisioning, token
// authority, and prompt context.
//
// The three projections intentionally retain distinct types. In particular,
// tokenCapabilities are nominal RouteVerbMask values and context requirements
// are EnvironmentCapability values inside ContextFragment; no projection casts
// or translates between those authority namespaces.
/**
 * Project all three surfaces in one pass. Returned arrays are fresh so callers
 * cannot mutate the declarative ToolSurface through a projection.
 */
export function projectToolSurface(surface) {
    const manifestItems = [];
    const tokenCapabilities = [];
    const contextFragments = [];
    for (const item of surface.items) {
        manifestItems.push(...item.manifestItems);
        tokenCapabilities.push(...item.tokenCapabilities);
        contextFragments.push(...item.contextFragments);
    }
    return { manifestItems, tokenCapabilities, contextFragments };
}
export function toolSurfaceToManifestItems(surface) {
    return projectToolSurface(surface).manifestItems;
}
export function toolSurfaceToTokenCapabilities(surface) {
    return projectToolSurface(surface).tokenCapabilities;
}
export function toolSurfaceToContextFragments(surface) {
    return projectToolSurface(surface).contextFragments;
}
