// corpus-read-codebase-provider.ts — the NO-GIT codebase seam variant.
//
// DESIGN-EMAIL-DRAFTING-HOST.md §3-4 (P2, increment 1): today the TEE cannot
// represent a "read-the-corpus, no-git, emit-a-proposal" drafting turn because
// the `codebase` seam is worktree/opencode-shaped — `CodebaseProvider` extends
// `WorktreeBackend`, so `getCodebase` allocates a git worktree/clone and
// `harvestResult` captures commits baseRef..HEAD. A drafting turn has no git repo
// to check out and produces a PROPOSAL, not commits.
//
// This module makes the `codebase` seam REPRESENTABLE for that turn WITHOUT a git
// worktree, and WITHOUT the turn path branching on "which shape" (the exact thing
// the seam exists to prevent — DESIGN §9 stop-gate). It is a `CodebaseProvider`
// like any other: the drain and the build/write-back stages consume it through
// the identical seam methods. The difference is entirely INSIDE the provider:
//
//   - getCodebase   → materializes a BOUNDED, READ-ONLY artifact projection (the
//                     "Juncture Workspace Materialization" idea): the turn gets a
//                     workspace path it may READ, cut from no branch. The
//                     allocation reports SENTINEL branch/baseRef (there is no git
//                     ref) so the shape stays a WorktreeAllocation without lying
//                     about a repo that doesn't exist.
//   - harvestResult → ALWAYS EMPTY: a read-only projection produces zero commits.
//                     The write-back's `harvestResult` call therefore captures
//                     nothing, and the advance-main peg has nothing to advance —
//                     the drafting turn never lands a commit on any branch.
//   - release/discard/ensure/recut/detectOrphans → inert lifecycle: there is no
//                     branch to fetch-home or push, and nothing to advance to
//                     canonical. This is the load-bearing NO-AUTHORITY property:
//                     the corpus-read provider grants READ-ONLY projection access
//                     ONLY — it can never deliver a branch to a canonical repo.
//
// STANDALONE-FIRST / GUARDRAILS (AGENTS.md; DESIGN §7, §10):
//   - No host dependency: node builtins + Mission EAL's own codebase-port types.
//   - No new authority: the projection is READ-ONLY; no send, no apply, no
//     git-write, no branch delivery. `propose ≠ apply` is preserved because this
//     provider CANNOT apply — it has no write path to any canonical surface.
//   - The DEFAULT worktree path is UNTOUCHED: this is a SEPARATE provider a caller
//     opts into by binding it as `codebase`. `createCodebaseProvider` /
//     `createLocalTurnExecutionEnvironment` are byte-identical.
//
// A5 COMPLETION:
//   createCorpusReadExecutionEnvironment (below) binds an explicit
//   corpus-read-turn executor, a fixed descriptor, and a provisioner narrowed
//   to ONE caller-supplied record-proposal route. The route remains injected:
//   its host-owned name lands with the inbox redesign and must not be invented
//   or hard-coded in this substrate package.
import { isAbsolute } from "node:path";
import { asRecordProposalRouteVerbMask } from "./capabilities.js";
import { CredentialProvisioningError } from "./credentials.js";
import { assertValidEnvironmentDescriptor } from "./descriptor.js";
import { createTurnExecutionEnvironment, snapshotFixedEnvironmentDescriptor } from "./environment.js";
/**
 * The SENTINEL branch/baseRef a corpus-read allocation reports. There is no git
 * ref backing a read-only projection, so the allocation carries these stable,
 * NON-git markers instead of a real branch/sha. Downstream code that keys off the
 * branch (e.g. the write-back's advance-main) sees a marker it never advances —
 * and, defensively, `harvestResult` returns zero commits so there is nothing to
 * advance regardless.
 */
export const CORPUS_READ_SENTINEL_BRANCH = "corpus-read/no-branch";
export const CORPUS_READ_SENTINEL_BASE_REF = "corpus-read/no-base";
function nowIso(clock) {
    return clock().toISOString();
}
const CORPUS_READ_CODEBASE_BRAND = Symbol("mission-eal.corpus-read-codebase");
const CORPUS_READ_CODEBASE_INSTANCES = new WeakSet();
/**
 * Build a corpus-read `CodebaseProvider`: a read-only artifact projection instead
 * of a git worktree, so a no-git drafting turn is representable behind the
 * existing `codebase` seam. Every method satisfies the `CodebaseProvider`
 * (⊇ `WorktreeBackend`) contract so the drain/stages consume it identically — but
 * the provisioning is a bounded read-only projection and the harvest/lifecycle are
 * inert (no commits, no branch delivery, no canonical write).
 */
export function createCorpusReadCodebaseProvider(options = {}) {
    const clock = options.clock ?? (() => new Date());
    const resolveProjection = options.resolveProjection ?? ((input) => input.projectRootPath);
    /**
     * Provision the turn's read-only projection. Returns a `WorktreeAllocation`
     * shape (so the seam is uniform) whose `worktreePath` is the bounded projection
     * dir and whose branch/baseRef are the NON-git sentinels. `detachRemote` is
     * irrelevant (there is no remote); `branchName`/`baseRef` on the input are
     * IGNORED — a projection has no branch to name or base to cut from.
     */
    function allocateProjection(input) {
        if (!input.taskId || input.taskId.trim().length === 0) {
            throw new Error("corpus-read getCodebase requires a non-empty taskId");
        }
        if (!input.projectRootPath || input.projectRootPath.trim().length === 0) {
            throw new Error("corpus-read getCodebase requires a projectRootPath to resolve the projection from");
        }
        const worktreePath = resolveProjection(input);
        if (typeof worktreePath !== "string"
            || worktreePath.length === 0
            || !isAbsolute(worktreePath)) {
            throw new Error("corpus-read projection resolver must return a non-empty absolute path");
        }
        return {
            taskId: input.taskId,
            worktreePath,
            baseRef: CORPUS_READ_SENTINEL_BASE_REF,
            branch: CORPUS_READ_SENTINEL_BRANCH,
            allocatedAt: nowIso(clock)
        };
    }
    const provider = {
        [CORPUS_READ_CODEBASE_BRAND]: true,
        // getCodebase / allocateWorktree — the design-named seam + its WorktreeBackend
        // alias both resolve the read-only projection (a caller may reach the provider
        // through either name; they are identical here).
        async getCodebase(input) {
            return allocateProjection(input);
        },
        async allocateWorktree(input) {
            return allocateProjection(input);
        },
        // harvestResult — ALWAYS EMPTY. A read-only projection produces no commits, so
        // the write-back captures nothing and the central advance-main has nothing to
        // advance. The branch/base sentinels are echoed for shape-fidelity only.
        harvestResult(input) {
            return Promise.resolve({
                commits: [],
                commitShas: [],
                branchRef: input.branch,
                baseRef: input.baseRef
            });
        },
        // Lifecycle — INERT. There is no git checkout, no branch to fetch-home or
        // push, and no canonical repo to advance. release/discard are no-ops (nothing
        // to persist and nothing to throw away destructively); ensure/recut keep the
        // seam total without materializing git state; detectOrphans reports nothing
        // (this provider tracks no on-disk worktrees).
        //
        // NO-AUTHORITY INVARIANT: none of these can deliver a branch or a commit to a
        // canonical repo — the corpus-read provider is read-only projection access,
        // full stop.
        ensureWorktree(_input) {
            return Promise.resolve();
        },
        releaseWorktree(_input) {
            return Promise.resolve();
        },
        discardWorktree(_input) {
            return Promise.resolve();
        },
        async recutWorktree(input) {
            // A re-cut on a corpus-read turn is a re-resolution of the same read-only
            // projection (there is no stale branch to drop) — return a fresh allocation
            // pointing at the same corpus.
            return allocateProjection({ taskId: input.taskId, projectRootPath: input.projectRootPath });
        },
        detectOrphans(_input) {
            return Promise.resolve({ orphans: [], missing: [], matched: [], scannedAt: nowIso(clock) });
        }
    };
    CORPUS_READ_CODEBASE_INSTANCES.add(provider);
    return Object.freeze(provider);
}
export const CORPUS_READ_DRAFT_INPUT_CONTRACT = "email-draft-request.v1";
export const CORPUS_READ_DRAFT_OUTPUT_CONTRACT = "email-reply-draft-proposal.v2";
export class CorpusReadExecutionEnvironmentFactoryError extends Error {
    constructor(message) {
        super(message);
        this.name = "CorpusReadExecutionEnvironmentFactoryError";
    }
}
function assertCorpusReadDescriptor(descriptor) {
    assertValidEnvironmentDescriptor(descriptor);
    if (descriptor.network !== "model-endpoint") {
        throw new CorpusReadExecutionEnvironmentFactoryError('createCorpusReadExecutionEnvironment: descriptor.network must be "model-endpoint"');
    }
    const capabilitySet = new Set(descriptor.capabilities);
    if (descriptor.capabilities.length !== 2
        || !capabilitySet.has("network:model")
        || !capabilitySet.has("filesystem:corpus-ro")) {
        throw new CorpusReadExecutionEnvironmentFactoryError("createCorpusReadExecutionEnvironment: descriptor.capabilities must be exactly " +
            '["network:model", "filesystem:corpus-ro"] (order-independent)');
    }
    if (descriptor.mounts.length === 0
        || descriptor.mounts.some((mount) => mount.mode !== "ro")) {
        throw new CorpusReadExecutionEnvironmentFactoryError("createCorpusReadExecutionEnvironment: descriptor.mounts must contain only one or more read-only corpus mounts");
    }
    if (new Set(descriptor.mounts.map((mount) => mount.path)).size !== descriptor.mounts.length) {
        throw new CorpusReadExecutionEnvironmentFactoryError("createCorpusReadExecutionEnvironment: descriptor mount paths must be unique");
    }
    if (descriptor.secretRefs.length !== 1) {
        throw new CorpusReadExecutionEnvironmentFactoryError("createCorpusReadExecutionEnvironment: descriptor.secretRefs must name exactly one scoped record-proposal credential");
    }
    if (descriptor.io.inputContract !== CORPUS_READ_DRAFT_INPUT_CONTRACT
        || descriptor.io.outputContract !== CORPUS_READ_DRAFT_OUTPUT_CONTRACT) {
        throw new CorpusReadExecutionEnvironmentFactoryError("createCorpusReadExecutionEnvironment: descriptor.io must be " +
            `${CORPUS_READ_DRAFT_INPUT_CONTRACT} -> ${CORPUS_READ_DRAFT_OUTPUT_CONTRACT}`);
    }
}
function fixedCorpusReadExecutor(executor) {
    const kind = executor?.kind;
    const execute = executor?.execute;
    if (kind !== "corpus-read-turn") {
        throw new CorpusReadExecutionEnvironmentFactoryError('createCorpusReadExecutionEnvironment: executor.kind must be "corpus-read-turn"');
    }
    if (typeof execute !== "function") {
        throw new CorpusReadExecutionEnvironmentFactoryError("createCorpusReadExecutionEnvironment: executor.execute must be a function");
    }
    const fixed = {
        kind: "corpus-read-turn",
        execute(invocation, signal) {
            return execute.call(executor, invocation, signal);
        }
    };
    return Object.freeze(fixed);
}
function assertFixedCorpusReadCodebase(codebase) {
    if (!CORPUS_READ_CODEBASE_INSTANCES.has(codebase)
        || codebase?.[CORPUS_READ_CODEBASE_BRAND] !== true
        || !Object.isFrozen(codebase)) {
        throw new CorpusReadExecutionEnvironmentFactoryError("createCorpusReadExecutionEnvironment: codebase must come from createCorpusReadCodebaseProvider");
    }
}
function fixedCorpusReadCodebase(codebase, descriptor) {
    const allowedPaths = new Set(descriptor.mounts.map((mount) => mount.path));
    const allocateWorktree = codebase.allocateWorktree;
    const ensureWorktree = codebase.ensureWorktree;
    const recutWorktree = codebase.recutWorktree;
    const releaseWorktree = codebase.releaseWorktree;
    const discardWorktree = codebase.discardWorktree;
    const detectOrphans = codebase.detectOrphans;
    const getCodebase = codebase.getCodebase;
    const harvestResult = codebase.harvestResult;
    if ([
        allocateWorktree,
        ensureWorktree,
        recutWorktree,
        releaseWorktree,
        discardWorktree,
        detectOrphans,
        getCodebase,
        harvestResult
    ].some((operation) => typeof operation !== "function")) {
        throw new CorpusReadExecutionEnvironmentFactoryError("createCorpusReadExecutionEnvironment: corpus codebase has an incomplete operation surface");
    }
    const assertBoundedAllocation = (allocation) => {
        if (!allowedPaths.has(allocation?.worktreePath)) {
            throw new CorpusReadExecutionEnvironmentFactoryError(`corpus-read projection ${JSON.stringify(allocation?.worktreePath)} is not one of the fixed read-only descriptor mounts`);
        }
        return Object.freeze({ ...allocation });
    };
    const fixed = {
        [CORPUS_READ_CODEBASE_BRAND]: true,
        async allocateWorktree(request) {
            return assertBoundedAllocation(await allocateWorktree.call(codebase, request));
        },
        ensureWorktree(request) {
            return ensureWorktree.call(codebase, request);
        },
        async recutWorktree(request) {
            return assertBoundedAllocation(await recutWorktree.call(codebase, request));
        },
        releaseWorktree(request) {
            return releaseWorktree.call(codebase, request);
        },
        discardWorktree(request) {
            return discardWorktree.call(codebase, request);
        },
        detectOrphans(request) {
            return detectOrphans.call(codebase, request);
        },
        async getCodebase(request) {
            return assertBoundedAllocation(await getCodebase.call(codebase, request));
        },
        harvestResult(request) {
            return harvestResult.call(codebase, request);
        }
    };
    CORPUS_READ_CODEBASE_INSTANCES.add(fixed);
    return Object.freeze(fixed);
}
function proposalOnlyCredentialProvisioner(credentials, recordProposalCapability, expectedSecretRef) {
    const provisionCredentials = credentials?.provisionCredentials;
    const revokeCredentials = credentials?.revokeCredentials;
    if (typeof provisionCredentials !== "function"
        || typeof revokeCredentials !== "function") {
        throw new CorpusReadExecutionEnvironmentFactoryError("createCorpusReadExecutionEnvironment: credentials must implement provisionCredentials() and revokeCredentials()");
    }
    async function retireRejectedCredential(invocationId) {
        try {
            const retired = await revokeCredentials.call(credentials, invocationId);
            return Number.isInteger(retired) && retired >= 1;
        }
        catch {
            return false;
        }
    }
    return Object.freeze({
        async provisionCredentials(request) {
            const invocationId = request.invocationId;
            const projectId = request.projectId;
            const sessionId = request.sessionId;
            const personaRef = request.personaRef;
            const denyAll = request.denyAll;
            const ttlMs = request.ttlMs;
            const narrowedCapabilities = Object.freeze(denyAll ? [] : [recordProposalCapability]);
            // Rebuild from the closed public contract. Runtime/JS callers cannot
            // smuggle host-extension authority through a rest spread.
            const narrowedRequest = Object.freeze({
                invocationId,
                kind: "corpus-read-turn",
                projectId,
                sessionId,
                ...(personaRef !== undefined ? { personaRef } : {}),
                ...(denyAll !== undefined ? { denyAll } : {}),
                ...(ttlMs !== undefined ? { ttlMs } : {}),
                // `denyAll` is an intentional further narrowing. Every other request,
                // including a caller-supplied broader mask, is pinned to exactly ONE
                // host-approved record-proposal route.
                capabilities: narrowedCapabilities
            });
            try {
                const provisioned = await provisionCredentials.call(credentials, narrowedRequest);
                // Capture every returned field exactly once. Getter/proxy-backed host
                // results cannot validate one credential and freeze a different one.
                const token = provisioned?.token;
                const rawSecretRefs = provisioned?.secretRefs;
                const secretRefs = Array.isArray(rawSecretRefs)
                    ? [...rawSecretRefs]
                    : rawSecretRefs;
                const callbackUrl = provisioned?.callbackUrl;
                const expiresAt = provisioned?.expiresAt;
                if (typeof token !== "string"
                    || token.length === 0
                    || !Array.isArray(secretRefs)
                    || secretRefs.length !== 1
                    || secretRefs[0] !== expectedSecretRef
                    || typeof callbackUrl !== "string"
                    || callbackUrl.length === 0
                    || typeof expiresAt !== "number"
                    || !Number.isInteger(expiresAt)
                    || expiresAt < 0) {
                    throw new CredentialProvisioningError("corpus-read provisioner returned credentials that do not exactly match the fixed proposal descriptor");
                }
                return Object.freeze({
                    token,
                    secretRefs: Object.freeze(secretRefs),
                    callbackUrl,
                    expiresAt
                });
            }
            catch (error) {
                const retired = await retireRejectedCredential(invocationId);
                const cleanupDetail = retired
                    ? ""
                    : "; cleanup failed and the rejected credential may remain live";
                if (error instanceof CredentialProvisioningError) {
                    throw new CredentialProvisioningError(`${error.message}${cleanupDetail}`);
                }
                throw new CredentialProvisioningError("corpus-read provisioner result could not be safely captured" +
                    cleanupDetail);
            }
        },
        revokeCredentials(invocationId) {
            return revokeCredentials.call(credentials, invocationId);
        }
    });
}
/**
 * Complete the no-git drafting environment: a bounded read-only corpus,
 * explicit corpus-read executor kind, exact fixed descriptor, and a credential
 * seam that can emit a proposal but can never apply or send one.
 */
export function createCorpusReadExecutionEnvironment(input) {
    const captured = { ...input };
    assertFixedCorpusReadCodebase(captured.codebase);
    const executor = fixedCorpusReadExecutor(captured.executor);
    if (typeof captured.fallbackWebUrl !== "string"
        || captured.fallbackWebUrl.trim().length === 0) {
        throw new CorpusReadExecutionEnvironmentFactoryError("createCorpusReadExecutionEnvironment: fallbackWebUrl is required");
    }
    const descriptor = snapshotFixedEnvironmentDescriptor(captured.descriptor);
    assertCorpusReadDescriptor(descriptor);
    const codebase = fixedCorpusReadCodebase(captured.codebase, descriptor);
    const recordProposalCapability = asRecordProposalRouteVerbMask(captured.recordProposalCapability);
    return Object.freeze(createTurnExecutionEnvironment({
        codebase,
        executor,
        credentials: proposalOnlyCredentialProvisioner(captured.credentials, recordProposalCapability, descriptor.secretRefs[0]),
        describe: () => descriptor,
        fallbackWebUrl: captured.fallbackWebUrl
    }));
}
