/** One materialized codebase allocated for an invocation. */
export interface CodebaseAllocation {
    /** Invocation/task identity the allocation belongs to. */
    readonly taskId: string;
    /** Absolute path exposed to the executor. */
    readonly worktreePath: string;
    /** Resolved base revision, or a provider-defined non-git sentinel. */
    readonly baseRef: string;
    /** Provider branch/ref, or a provider-defined non-git sentinel. */
    readonly branch: string;
    /** ISO-8601 allocation timestamp. */
    readonly allocatedAt: string;
}
export interface AllocateCodebaseInput {
    readonly taskId: string;
    /** Host-owned canonical project/corpus location. */
    readonly projectRootPath: string;
    readonly baseRef?: string;
    readonly branchName?: string;
    /** A host may use this to remove mutation-capable remotes from the allocation. */
    readonly detachRemote?: boolean;
}
export interface EnsureCodebaseInput {
    readonly taskId: string;
    readonly worktreePath: string;
    readonly branchName?: string;
    readonly projectRootPath: string;
}
export interface ReleaseCodebaseInput {
    readonly taskId: string;
    readonly worktreePath: string;
    readonly projectRootPath?: string;
    readonly force?: boolean;
}
export interface RecutCodebaseInput {
    readonly taskId: string;
    readonly projectRootPath: string;
}
export interface DetectCodebaseOrphansInput {
    readonly expected: ReadonlyArray<{
        readonly taskId: string;
        readonly worktreePath: string;
    }>;
}
export interface DetectedCodebaseOrphan {
    readonly worktreePath: string;
    readonly exists: boolean;
}
export interface DetectedMissingCodebase {
    readonly taskId: string;
    readonly worktreePath: string;
}
export interface CodebaseOrphanReport {
    readonly orphans: readonly DetectedCodebaseOrphan[];
    readonly missing: readonly DetectedMissingCodebase[];
    readonly matched: ReadonlyArray<{
        readonly taskId: string;
        readonly worktreePath: string;
    }>;
    readonly scannedAt: string;
}
/**
 * The lifecycle half of the codebase boundary. The method names deliberately
 * preserve the established worktree protocol while the types and authority are
 * owned here. Non-git providers implement the same total interface with inert
 * lifecycle behavior.
 */
export interface CodebaseLifecyclePort {
    allocateWorktree(input: AllocateCodebaseInput): Promise<CodebaseAllocation>;
    ensureWorktree(input: EnsureCodebaseInput): Promise<void>;
    releaseWorktree(input: ReleaseCodebaseInput): Promise<void>;
    discardWorktree(input: ReleaseCodebaseInput): Promise<void>;
    recutWorktree(input: RecutCodebaseInput): Promise<CodebaseAllocation>;
    detectOrphans(input: DetectCodebaseOrphansInput): Promise<CodebaseOrphanReport>;
}
/** A stable, provider-neutral summary of one harvested git commit. */
export interface CodebaseCommitSummary {
    readonly fullSha: string;
    readonly shortSha: string;
    readonly subject: string;
    readonly author: string;
    readonly committedAt: string;
}
export interface HarvestResultInput {
    readonly worktreePath: string;
    /** Must be a resolved revision for a git-backed provider; null means unknown. */
    readonly baseRef: string | null;
    readonly branch: string;
}
export interface HarvestResult {
    readonly commits: readonly CodebaseCommitSummary[];
    readonly commitShas: readonly string[];
    readonly branchRef: string;
    readonly baseRef: string | null;
}
/** Host port for reading commits without making git a Mission EAL dependency. */
export interface CodebaseCommitReader {
    listCommitsBetween(worktreePath: string, beforeSha: string, afterSha: string): Promise<readonly CodebaseCommitSummary[]>;
}
export interface CodebaseProvider extends CodebaseLifecyclePort {
    getCodebase(input: AllocateCodebaseInput): Promise<CodebaseAllocation>;
    harvestResult(input: HarvestResultInput): Promise<HarvestResult>;
}
export interface CreateCodebaseProviderOptions {
    /** Required host binding. There is intentionally no concrete/default reader. */
    readonly commitReader: CodebaseCommitReader;
}
/**
 * Adapt a host lifecycle implementation into the uniform EAL provider.
 *
 * The lifecycle object must expose closure-safe methods. Commit inspection is
 * explicit and injected; a host can bind git, an API, or another provenance
 * source without Mission EAL importing that implementation.
 */
export declare function createCodebaseProvider(lifecycle: CodebaseLifecyclePort, options: CreateCodebaseProviderOptions): CodebaseProvider;
export declare class InertCodebaseError extends Error {
    constructor(operation: string, reason: string);
}
/** A uniform no-codebase binding: every operation rejects loudly. */
export declare function createInertCodebaseProvider(options: {
    readonly reason: string;
}): CodebaseProvider;
export type WorktreeAllocation = CodebaseAllocation;
export type AllocateWorktreeInput = AllocateCodebaseInput;
export type EnsureWorktreeInput = EnsureCodebaseInput;
export type ReleaseWorktreeInput = ReleaseCodebaseInput;
export type RecutWorktreeInput = RecutCodebaseInput;
export type DetectOrphansInput = DetectCodebaseOrphansInput;
export type DetectedOrphan = DetectedCodebaseOrphan;
export type DetectedMissing = DetectedMissingCodebase;
export type OrphanReport = CodebaseOrphanReport;
export type WorktreeBackend = CodebaseLifecyclePort;
export type RepoCommitSummary = CodebaseCommitSummary;
