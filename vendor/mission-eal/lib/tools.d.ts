import type { RouteVerbMask } from "./capabilities.js";
import type { ContextFragment } from "./context.js";
import type { SandboxResourceItem } from "./provision-manifest.js";
export interface ToolSurfaceItem {
    /** Stable identity for the logical tool or tool group. */
    readonly id: string;
    /** Resources that must pass provisioning before the tool is advertised. */
    readonly manifestItems: readonly SandboxResourceItem[];
    /** Mutation-route masks delivered to the credential provisioner. */
    readonly tokenCapabilities: readonly RouteVerbMask[];
    /** Capability-checked prompt fragments that teach this tool. */
    readonly contextFragments: readonly ContextFragment[];
}
export interface ToolSurface {
    /** Host harness this surface is bound to (for example, "opencode"). */
    readonly harnessKind: string;
    /** Authored order is preserved by every projection. */
    readonly items: readonly ToolSurfaceItem[];
}
export interface ToolSurfaceProjection {
    readonly manifestItems: readonly SandboxResourceItem[];
    readonly tokenCapabilities: readonly RouteVerbMask[];
    readonly contextFragments: readonly ContextFragment[];
}
/**
 * Project all three surfaces in one pass. Returned arrays are fresh so callers
 * cannot mutate the declarative ToolSurface through a projection.
 */
export declare function projectToolSurface(surface: ToolSurface): ToolSurfaceProjection;
export declare function toolSurfaceToManifestItems(surface: ToolSurface): readonly SandboxResourceItem[];
export declare function toolSurfaceToTokenCapabilities(surface: ToolSurface): readonly RouteVerbMask[];
export declare function toolSurfaceToContextFragments(surface: ToolSurface): readonly ContextFragment[];
