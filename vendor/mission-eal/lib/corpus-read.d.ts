import type { AllocateWorktreeInput, CodebaseProvider } from "./codebase.js";
import { type RecordProposalRouteVerbMask } from "./capabilities.js";
import type { CredentialProvisioner } from "./credentials.js";
import { type EnvironmentDescriptor } from "./descriptor.js";
import type { TurnExecutor } from "./executor.js";
import { type FixedDescriptorExecutionEnvironment } from "./environment.js";
/**
 * The SENTINEL branch/baseRef a corpus-read allocation reports. There is no git
 * ref backing a read-only projection, so the allocation carries these stable,
 * NON-git markers instead of a real branch/sha. Downstream code that keys off the
 * branch (e.g. the write-back's advance-main) sees a marker it never advances —
 * and, defensively, `harvestResult` returns zero commits so there is nothing to
 * advance regardless.
 */
export declare const CORPUS_READ_SENTINEL_BRANCH = "corpus-read/no-branch";
export declare const CORPUS_READ_SENTINEL_BASE_REF = "corpus-read/no-base";
/**
 * How a corpus-read turn's read-only projection is located on THIS machine. The
 * projection is a directory the turn may READ (the corpus); it is NOT a git
 * checkout. The provider does not MOUNT or COPY anything here — that remains
 * the host executor/transport binding's job. It only RESOLVES the bounded
 * projection path for a given turn.
 */
export interface CorpusReadCodebaseProviderOptions {
    /**
     * Resolve the absolute path of the bounded read-only projection for a turn.
     * Given the turn's allocate input (taskId + projectRootPath), return the dir
     * the turn reads. Defaults to the caller-provided `projectRootPath` itself —
     * i.e. the corpus IS the project root, exposed read-only. A caller that
     * materializes a narrower projection (only the drafting-relevant artifacts)
     * overrides this to point at that bounded dir.
     *
     * READ-ONLY CONTRACT: the returned path is a projection the turn may READ. This
     * provider never writes to it, never creates a branch in it, and never delivers
     * anything out of it. Enforcing read-only at the mount layer belongs to the
     * host executor/transport binding; this provider models the intent and keeps
     * the path bounded.
     */
    readonly resolveProjection?: (input: AllocateWorktreeInput) => string;
    /** Override clock for deterministic tests (allocation timestamp). */
    readonly clock?: () => Date;
}
declare const CORPUS_READ_CODEBASE_BRAND: unique symbol;
/** Nominal proof that the provider has the inert-harvest/no-git semantics
 * implemented by createCorpusReadCodebaseProvider. */
export interface CorpusReadCodebaseProvider extends CodebaseProvider {
    readonly [CORPUS_READ_CODEBASE_BRAND]: true;
}
/**
 * Build a corpus-read `CodebaseProvider`: a read-only artifact projection instead
 * of a git worktree, so a no-git drafting turn is representable behind the
 * existing `codebase` seam. Every method satisfies the `CodebaseProvider`
 * (⊇ `WorktreeBackend`) contract so the drain/stages consume it identically — but
 * the provisioning is a bounded read-only projection and the harvest/lifecycle are
 * inert (no commits, no branch delivery, no canonical write).
 */
export declare function createCorpusReadCodebaseProvider(options?: CorpusReadCodebaseProviderOptions): CorpusReadCodebaseProvider;
export declare const CORPUS_READ_DRAFT_INPUT_CONTRACT = "email-draft-request.v1";
export declare const CORPUS_READ_DRAFT_OUTPUT_CONTRACT = "email-reply-draft-proposal.v2";
export declare class CorpusReadExecutionEnvironmentFactoryError extends Error {
    constructor(message: string);
}
export interface CreateCorpusReadExecutionEnvironmentInput {
    /** A bounded, read-only corpus projection (normally from
     * createCorpusReadCodebaseProvider). */
    readonly codebase: CorpusReadCodebaseProvider;
    /** A binding that already identifies itself as corpus-read-turn. The
     * environment never relabels another executor kind. */
    readonly executor: TurnExecutor;
    /** The host provisioner that ultimately mints/validates the scoped token. */
    readonly credentials: CredentialProvisioner;
    /** Fixed, code-owned corpus drafting posture. */
    readonly descriptor: EnvironmentDescriptor;
    /** The host-owned proposal mutation route. Nominal and runtime-validated;
     * the surface name is not hard-coded here, while the operation must be
     * exactly `.record` so send/apply/delegate routes cannot cross this seam. */
    readonly recordProposalCapability: RecordProposalRouteVerbMask;
    readonly fallbackWebUrl: string;
}
/**
 * Complete the no-git drafting environment: a bounded read-only corpus,
 * explicit corpus-read executor kind, exact fixed descriptor, and a credential
 * seam that can emit a proposal but can never apply or send one.
 */
export declare function createCorpusReadExecutionEnvironment(input: CreateCorpusReadExecutionEnvironmentInput): FixedDescriptorExecutionEnvironment;
export {};
