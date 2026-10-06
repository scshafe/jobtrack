// HarnessDescriptor — the per-kind contract for an agent harness (refactor
// phase C-3). One descriptor per kind declares everything generic code needs
// to know about a harness WITHOUT importing its transport:
//
//   - transport shape and whether a turn requires a reachable agent-server
//     endpoint (`needsAgentServer`). The opencode CLI transport never talks
//     to `opencode serve` during a turn, so its descriptor opts out of the
//     per-turn reachability gate that used to make :4096 a single point of
//     failure for every chat send.
//   - agent_servers config defaults (absorbed from the old agent-server-kinds
//     KINDS table; agent-server-kinds.ts is now a thin adapter over this
//     registry).
//   - the credential contract: where the harness keeps its own OAuth/token
//     store on the host, and a probe that validates it. Mission Control never
//     acquires, parses-for-use, refreshes, or persists harness credentials —
//     each harness CLI owns its store; MC references, verifies, and (for
//     sandboxed kinds) injects it. A local/credential-less harness declares
//     mode "none" and skips the whole apparatus.
//
// Built-in descriptors live in src/harness/<kind>/descriptor.ts and register
// on import; a third-party harness registers its own the same way it
// registers a chat backend.
const registry = new Map();
export function registerHarnessDescriptor(descriptor) {
    if (registry.has(descriptor.kind)) {
        throw new Error(`Harness descriptor already registered for kind "${descriptor.kind}".`);
    }
    registry.set(descriptor.kind, descriptor);
}
export function getHarnessDescriptor(kind) {
    return registry.get(kind) ?? null;
}
export function listHarnessDescriptors() {
    return Array.from(registry.values());
}
/** Test seam: clear the registry so a test can re-register descriptors. */
export function __resetHarnessDescriptorRegistryForTesting() {
    registry.clear();
}
