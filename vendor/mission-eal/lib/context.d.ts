import { type EnvironmentCapability, type EnvironmentDescriptor } from "./descriptor.js";
import type { AssembledContext } from "./executor.js";
export interface ContextFragment {
    /** Stable, non-empty identity carried into the assembly manifest. */
    readonly id: string;
    /** Exact prompt bytes for this fragment. Assembly never trims or normalizes. */
    readonly text: string;
    /** Environment posture this text promises is available. */
    readonly requires?: readonly EnvironmentCapability[];
}
export interface AssembleContextOptions {
    /** Exact separator between fragments. Defaults to semantic prompt blocks. */
    readonly separator?: string;
}
export interface ContextAssemblyManifest {
    readonly fragmentIds: readonly string[];
    readonly digest: string;
}
/** The manifest is guaranteed for contexts produced by assembleContext even
 * though executor.ts keeps it optional for compatibility with older callers. */
export type CapabilityCheckedContext = AssembledContext & {
    readonly manifest: ContextAssemblyManifest;
};
export declare class ContextAssemblyError extends Error {
    constructor(message: string);
}
export declare class ContextCapabilityMismatchError extends ContextAssemblyError {
    readonly fragmentId: string;
    readonly missingCapabilities: readonly EnvironmentCapability[];
    constructor(fragmentId: string, missingCapabilities: readonly EnvironmentCapability[]);
}
/**
 * Assemble ordered context fragments against one admitted environment
 * descriptor. Exact fragment bytes and authored order are preserved.
 */
export declare function assembleContext(fragments: readonly ContextFragment[], descriptor: EnvironmentDescriptor, options?: AssembleContextOptions): CapabilityCheckedContext;
