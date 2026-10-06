// codebase.ts — Mission EAL's host-neutral codebase port.
//
// Mission EAL owns the complete allocation/lifecycle/harvest contract. A host
// supplies an implementation (for example, Mission Control adapts its
// mc-worktree backend and git commit reader); this package never imports a
// concrete worktree implementation or shells out to git.
/**
 * Adapt a host lifecycle implementation into the uniform EAL provider.
 *
 * The lifecycle object must expose closure-safe methods. Commit inspection is
 * explicit and injected; a host can bind git, an API, or another provenance
 * source without Mission EAL importing that implementation.
 */
export function createCodebaseProvider(lifecycle, options) {
    if (!options
        || typeof options.commitReader?.listCommitsBetween !== "function") {
        throw new TypeError("createCodebaseProvider requires a commitReader.listCommitsBetween host binding");
    }
    return {
        ...lifecycle,
        getCodebase(input) {
            return lifecycle.allocateWorktree(input);
        },
        async harvestResult(input) {
            const commits = input.worktreePath && input.baseRef
                ? await options.commitReader
                    .listCommitsBetween(input.worktreePath, input.baseRef, "HEAD")
                    .catch(() => [])
                : [];
            const snapshot = commits.map((commit) => ({ ...commit }));
            const commitShas = snapshot
                .map((commit) => commit.fullSha)
                .filter((sha) => typeof sha === "string" && sha.length > 0);
            return {
                commits: snapshot,
                commitShas,
                branchRef: input.branch,
                baseRef: input.baseRef
            };
        }
    };
}
export class InertCodebaseError extends Error {
    constructor(operation, reason) {
        super(`codebase.${operation} called on an INERT codebase provider (${reason}). `
            + "This environment has no codebase by design (model-only inference); a consumer path "
            + "reaching the codebase seam is a wiring bug — fix the caller, do not bind a workspace.");
        this.name = "InertCodebaseError";
    }
}
/** A uniform no-codebase binding: every operation rejects loudly. */
export function createInertCodebaseProvider(options) {
    const reject = (operation) => Promise.reject(new InertCodebaseError(operation, options.reason));
    return {
        allocateWorktree: () => reject("allocateWorktree"),
        ensureWorktree: () => reject("ensureWorktree"),
        recutWorktree: () => reject("recutWorktree"),
        releaseWorktree: () => reject("releaseWorktree"),
        discardWorktree: () => reject("discardWorktree"),
        detectOrphans: () => reject("detectOrphans"),
        getCodebase: () => reject("getCodebase"),
        harvestResult: () => reject("harvestResult")
    };
}
