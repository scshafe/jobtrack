// context.ts — capability-checked, deterministic invocation context assembly.
//
// Context is part of the environment contract, not free-floating prompt text:
// every fragment declares the EnvironmentCapability posture it relies on and
// assembly fails before execution when the admitted descriptor does not grant
// one of those capabilities. The output uses the AssembledContext type already
// owned by executor.ts; this module deliberately does not redefine it.
import { createHash } from "node:crypto";
import { assertValidEnvironmentDescriptor } from "./descriptor.js";
export class ContextAssemblyError extends Error {
    constructor(message) {
        super(message);
        this.name = "ContextAssemblyError";
    }
}
export class ContextCapabilityMismatchError extends ContextAssemblyError {
    fragmentId;
    missingCapabilities;
    constructor(fragmentId, missingCapabilities) {
        super(`context fragment ${JSON.stringify(fragmentId)} requires ungranted environment ` +
            `capabilit${missingCapabilities.length === 1 ? "y" : "ies"}: ${missingCapabilities.join(", ")}`);
        this.name = "ContextCapabilityMismatchError";
        this.fragmentId = fragmentId;
        this.missingCapabilities = [...missingCapabilities];
    }
}
function contextManifestDigest(fragments, separator) {
    // Hash the ordered source fragments, their requirements, and the separator —
    // not merely the rendered text. Moving identical bytes between fragment IDs
    // or changing posture requirements must change the manifest identity.
    const payload = {
        version: "mission-eal.context-manifest.v1",
        separator,
        fragments: fragments.map((fragment) => ({
            id: fragment.id,
            text: fragment.text,
            requires: [...(fragment.requires ?? [])]
        }))
    };
    return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}
/**
 * Assemble ordered context fragments against one admitted environment
 * descriptor. Exact fragment bytes and authored order are preserved.
 */
export function assembleContext(fragments, descriptor, options = {}) {
    assertValidEnvironmentDescriptor(descriptor);
    const granted = new Set(descriptor.capabilities);
    const fragmentIds = [];
    const seenIds = new Set();
    for (const fragment of fragments) {
        if (typeof fragment.id !== "string" || fragment.id.trim().length === 0) {
            throw new ContextAssemblyError("context fragment id must be a non-empty string");
        }
        if (seenIds.has(fragment.id)) {
            throw new ContextAssemblyError(`duplicate context fragment id: ${JSON.stringify(fragment.id)}`);
        }
        seenIds.add(fragment.id);
        fragmentIds.push(fragment.id);
        const missing = (fragment.requires ?? []).filter((capability) => !granted.has(capability));
        if (missing.length > 0) {
            throw new ContextCapabilityMismatchError(fragment.id, missing);
        }
    }
    const separator = options.separator ?? "\n\n";
    return {
        systemText: fragments.map((fragment) => fragment.text).join(separator),
        manifest: {
            fragmentIds,
            digest: contextManifestDigest(fragments, separator)
        }
    };
}
