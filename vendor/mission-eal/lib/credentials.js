// credentials.ts — CredentialProvider stops being a holder (mission-restructure
// A3; the cross-repo analysis H-CRED finding). The EAL's credential seam is an
// OPERATION: provisionCredentials(invocation) delivers per-invocation scoped
// credentials; revokeCredentials retires them. The local implementation wraps
// the promoted AsyncSandboxAuthTokenStore — the provisioner and the web
// validator hold the SAME store instance, so mint==validate is preserved
// exactly as before. A fleet node later binds a provisioner that assembles
// pre-provisioned node secrets + a centrally-delivered token, never minting.
//
// Identity rule (critique 12): a worktree-turn invocation MUST carry the
// run identity — the un-fakeable reviewer-run binding the never-self-decide
// guard trusts. The provisioner enforces it LOUDLY at mint time so a missing
// runId surfaces as a provisioning failure, never as a bypassable guard.
export class CredentialProvisioningError extends Error {
    constructor(message) {
        super(message);
        this.name = "CredentialProvisioningError";
    }
}
/**
 * Named failure from the deliberately unbound credential seam used by
 * authority-free environments. A call reaching this provisioner is a wiring
 * bug: callers must either keep credentials null or bind an explicit scoped
 * provisioner at environment construction.
 */
export class InertCredentialProvisionerError extends CredentialProvisioningError {
    constructor(reason) {
        super(`provisionCredentials called on an INERT credential provisioner (${reason}). ` +
            "This environment has no credentials by design; bind an explicit scoped " +
            "CredentialProvisioner instead of falling back to ambient authority.");
        this.name = "InertCredentialProvisionerError";
    }
}
/**
 * The no-credentials binding. Provisioning fails loudly; revoking an
 * invocation that could never have minted through this binding is the
 * idempotent zero-result operation.
 */
export function createInertCredentialProvisioner(options) {
    const reason = typeof options?.reason === "string"
        ? options.reason.trim()
        : "";
    if (reason.length === 0) {
        throw new CredentialProvisioningError("createInertCredentialProvisioner: reason is required");
    }
    return {
        provisionCredentials() {
            return Promise.reject(new InertCredentialProvisionerError(reason));
        },
        revokeCredentials() {
            return Promise.resolve(0);
        }
    };
}
function snapshotCredentialCapabilities(capabilities) {
    if (capabilities === undefined)
        return undefined;
    if (!Array.isArray(capabilities)) {
        throw new CredentialProvisioningError("provisionCredentials: capabilities must be an array of route-verb strings when provided");
    }
    const length = capabilities.length;
    const snapshot = [];
    for (let index = 0; index < length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(capabilities, index)) {
            throw new CredentialProvisioningError("provisionCredentials: capabilities must be an array of route-verb strings when provided");
        }
        const capability = capabilities[index];
        if (typeof capability !== "string") {
            throw new CredentialProvisioningError("provisionCredentials: capabilities must be an array of route-verb strings when provided");
        }
        snapshot.push(capability);
    }
    return Object.freeze(snapshot);
}
export function createTokenStoreCredentialProvisioner(input) {
    const tokens = input.tokens;
    const callbackUrl = input.callbackUrl;
    const mint = tokens.mint.bind(tokens);
    const validate = tokens.validate.bind(tokens);
    const revokeForTurn = tokens.revokeForTurn.bind(tokens);
    const retireRejectedMint = async (invocationId, validationFailure) => {
        let cleanupFailure = null;
        try {
            await revokeForTurn(invocationId);
        }
        catch (error) {
            cleanupFailure = error;
        }
        const validationDetail = validationFailure instanceof Error
            ? validationFailure.message
            : String(validationFailure);
        const cleanupDetail = cleanupFailure === null
            ? ""
            : ` Credential revocation also failed; the token may remain live until expiry (${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}).`;
        throw new CredentialProvisioningError(`provisionCredentials: minted sandbox token failed post-mint validation (${validationDetail}).${cleanupDetail}`);
    };
    return Object.freeze({
        async provisionCredentials(request) {
            const invocationId = request.invocationId;
            const kind = request.kind;
            const projectId = request.projectId;
            const sessionId = request.sessionId;
            const runId = request.runId;
            const ttlMs = request.ttlMs;
            const denyAll = request.denyAll;
            const capabilities = snapshotCredentialCapabilities(request.capabilities);
            if (typeof invocationId !== "string" || invocationId.trim().length === 0) {
                throw new CredentialProvisioningError("provisionCredentials: invocationId is required");
            }
            if (kind === "worktree-turn" && (typeof runId !== "string" || runId.trim().length === 0)) {
                throw new CredentialProvisioningError("provisionCredentials: a worktree-turn invocation must carry runId — the un-fakeable " +
                    "reviewer-run identity the never-self-decide guard trusts. Thread WorkView.runId through, " +
                    "or use a non-turn executor kind for run-less invocations.");
            }
            const token = await mint({
                projectId,
                chatSessionId: sessionId,
                turnId: invocationId,
                ...(runId ? { runId } : {}),
                ...(ttlMs !== undefined ? { ttlMs } : {}),
                // denyAll wins: an EMPTY allowlist denies every mutation route (deny-by-default
                // at the gate); otherwise the explicit masks (this raw binding does not narrow
                // by persona — bindings that can, do; see the MC sandbox provisioner).
                ...(denyAll ? { capabilities: [] } : capabilities ? { capabilities: capabilities } : {})
            });
            let validationFailed = false;
            let validationFailure;
            let expiresAt;
            try {
                const result = await validate(token);
                if (result.ok) {
                    expiresAt = result.scope.expiresAt;
                    if (!Number.isFinite(expiresAt)) {
                        throw new Error("validated sandbox token returned a non-finite expiresAt");
                    }
                }
                else {
                    validationFailed = true;
                    validationFailure = result.reason;
                }
            }
            catch (error) {
                validationFailed = true;
                validationFailure = error;
            }
            if (validationFailed) {
                return retireRejectedMint(invocationId, validationFailure);
            }
            return Object.freeze({
                token,
                secretRefs: Object.freeze(["secretref:sandbox-scoped-token"]),
                callbackUrl,
                expiresAt: expiresAt
            });
        },
        revokeCredentials(invocationId) {
            return revokeForTurn(invocationId);
        }
    });
}
