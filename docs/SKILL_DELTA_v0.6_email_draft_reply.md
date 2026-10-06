# Skill delta (v0.6) — `email draft-reply` verbs

**Status:** SUPERSEDED HISTORICAL DRAFT. **Not installed; do not install.** This delta describes
the frozen v0.6/v1 dry-run lane. The current standalone, provider-neutral G03 architecture is
[`EMAIL_OUTGOING_PROVIDER_NEUTRAL.md`](EMAIL_OUTGOING_PROVIDER_NEUTRAL.md). Any future durable
skill proposal must be rebuilt from that document through the Skill Workshop; this file must not
be promoted as written.

## What this adds

The `email draft-reply` work kind. JobTrack is the drafting **brain**: it
materializes a read-only, digest-pinned context projection, writes a strict
declarative request for a model turn it does **not** run, checks the returned
draft + provenance, and on human approval of the **exact bytes** emits an
approved-send artifact to a **DRY-RUN sink** (a staging table). JobTrack holds no
Gmail credential, runs no model in-process, and never sends. The external runner
is manual/out-of-process, exactly like the existing `application-strategy work`
pattern.

Trust invariants preserved (v0.6 non-negotiables): propose ≠ apply; untrusted
inbound text stays inert data; the model runs outside JobTrack; per-message human
approval of exact bytes; the usage receipt carries an explicit trust tier so a
zero/absent draft receipt is flagged; the CLI is the sole writer.

## Contracts consumed (checked-in copies of the frozen `execution-contracts` v1)

- `contracts/email/email-reply-draft-proposal.v2.schema.json` (existing; the draft output)
- `contracts/email/draft-provenance-receipt.v1.schema.json` (new; embeds a usage receipt)
- `contracts/email/approval-receipt.v1.schema.json` (new)
- `contracts/email/email-send-request.v1.schema.json` (new; emitted to the dry-run sink)
- `contracts/email/email-send-receipt.v1.schema.json` (new; correlation)
- `contracts/execution/usage-receipt.v1.schema.json` (new; mandatory trust tier)

## Verbs

### `jobtrack email draft-reply-context --provider P --account-id A --message-id M [--thread-id T] [--research RESEARCH.json] [--json]`

Read-only. Assembles and returns the drafting context projection for one imported
inbound message: locked recipient, sanitized inbox facts, the current approved
writing voice, any current thread style profile, the correlated application
record, and prior reply drafts on the thread. Digests the whole projection into
`sourceStateSha256`. Writes nothing. A stale corpus later fails closed at issue
time against this digest.

`--research RESEARCH.json` is OPTIONAL and fail-closed: absent it, the projection
declares **no** research capability (`research: null`). When supplied, it composes
corpus-read PLUS a `discovery-egress-broker` capability with an **exact allowlist**
for fresh company research — never raw internet. JobTrack itself makes **no**
network call and runs **no** model; it only DECLARES the broker capability + its
validated allowlist, which is pinned into `sourceStateSha256` (like the strategy
source checkpoint). `RESEARCH.json`:

```json
{
  "capability": "discovery-egress-broker",
  "mode": "brokered-read",
  "networkPolicy": {
    "schemaVersion": 1,
    "policyId": "company-research-acme",
    "userAgent": "JobTrack-company-research/0.1 (+private operator tool)",
    "allowedOrigins": [
      { "hostname": "www.acme.example", "port": 443,
        "paths": [{ "match": "prefix", "value": "/about/" }],
        "allowedQueryKeys": [], "requiredQuery": {} }
    ],
    "allowedContentTypes": ["text/html", "application/json"],
    "limits": { "maxRedirects": 1, "timeoutMs": 15000, "maxCompressedBytes": 1048576, "maxDecompressedBytes": 2097152 }
  },
  "targets": [{ "sourceKey": "acme-about", "url": "https://www.acme.example/about/company" }]
}
```

`capability` must be `discovery-egress-broker`; `mode` must be `brokered-read`
(default); `networkPolicy` is validated by the SAME exact-allowlist broker
validator the `discovery-egress` broker enforces at fetch time; and every
`targets[].url` must satisfy that allowlist (origin + path + query) — a
non-allowlisted target is **refused**. Each `sourceKey` must be a
broker-compatible identifier (lowercase, no colon, `<=128`). The same descriptor
may be included as an optional `research` field in the `draft-reply-issue`
`REQUEST.json`, and both paths must pin the identical digest.

### `jobtrack email draft-reply-issue --input REQUEST.json --idempotency-key K [--json]`

Writes a declarative `bounded_internal_request` (`trust: bounded_internal_request`,
`safety.proposalOnly: true`, `safety.externalActionsAllowed: false`,
`safety.forbiddenEffects` including `send-email`, a route alias, a token/cost/
duration budget, and the pinned `sourceStateSha256`) and **stops** — JobTrack does
not run the model (`executed: false` in the result). Fails closed
(`SOURCE_STATE_STALE`) if the request's `expectedSourceStateSha256` no longer
equals the current context digest. `REQUEST.json`:

```json
{
  "requestId": "req-1",
  "issuedBy": "Cole",
  "expectedSourceStateSha256": "<64-hex from draft-reply-context>",
  "source": { "provider": "fixture", "accountId": "cole@example.test", "messageId": "message-1", "threadId": "thread-1" },
  "budget": { "maxInputTokens": 120000, "maxOutputTokens": 4000, "maxCostMicros": 2000000, "maxDurationMs": 120000 },
  "research": null
}
```

`budget` is optional (a conservative default is applied). `research` is optional
(same shape as the `draft-reply-context --research` file); when present it MUST
match the descriptor used to compute `expectedSourceStateSha256`, or the issue
fails closed with `SOURCE_STATE_STALE`. The issued request then carries the
declarative broker capability (the exact validated `networkPolicy` plus enumerated
fetch-intent shells) for the external runner to drive the `discovery-egress`
broker — JobTrack still makes no network call. The external runner executes the
returned request and produces an `email-reply-draft-proposal.v2` plus a
`draft-provenance-receipt.v1` (whose `companyResearch: { used, brokered }` records
whether the broker was used).

### `jobtrack email draft-reply-record --input RESULT.json --idempotency-key K [--json]`

Validates a returned result and binds it to the issued request. `RESULT.json` is
`{ requestId, proposal, provenance }` where `proposal` is an
`email-reply-draft-proposal.v2` and `provenance` is a `draft-provenance-receipt.v1`
whose `sourceStateSha256` must equal the issued request's, whose `factsDigest`
must match, and whose `draftProposalDigest` must equal the exact proposal bytes.
The usage receipt is **mandatory** and its trust tier is surfaced
(`usageTrustBelowFloor: true` when the tier is `unavailable`, never silently
accepted). The reply proposal itself is recorded through the existing
recipient-locked `proposed` state machine (`auto_send_eligible = 0`).

### `jobtrack email draft-reply-approve-send --proposal-id ID --expected-proposal-digest DIGEST --approved-by WHO [--approved-at ISO] --idempotency-key K [--json]`

The human approval of **exact bytes**. `--expected-proposal-digest` must equal the
stored draft-artifact digest (approval binds bytes the approver actually saw;
mismatch fails closed). Advances the reply state machine `proposed → approved`,
then builds an `approval-receipt.v1` (FROZEN v1: no signature required) and an
`email-send-request.v1` (FROZEN v1 content = the `draft_artifact` digest
reference; no MIME bytes inline) and emits both to the **dry-run sink**
(`job_email_send_request_sink`, `sink = 'dry-run'`). It is **never** delivered and
**never** pushed to Inbox; the result carries `delivered: false`. The Inbox send
edge later re-verifies `content.digest == approval.approvedArtifactDigest` and
`recipient` against the ingested thread before any real send.

### `jobtrack email draft-reply-correlate-receipt --input RECEIPT.json [--json]`

Records a returned `email-send-receipt.v1` against the emitted send request
(append-only), asserting the receipt binds the exact `requestDigest` and
`idempotencyKey`. Data-only; no dispatch. Closes the loop.

## Emitted `email-send-request.v1` shape (for the Inbox track)

```json
{
  "schemaVersion": "email-send-request.v1",
  "requestId": "send:<proposalId>",
  "idempotencyKey": "send-<32hex of proposalId:draftDigest>",
  "recipient": "recruiter@acme.example",
  "inReplyTo": "<source messageId>",
  "threadId": "thread-1",
  "content": {
    "mode": "draft_artifact",
    "contractId": "email-reply-draft-proposal.v2",
    "digest": "<64-hex draft-artifact digest>"
  },
  "approval": {
    "schemaVersion": "approval-receipt.v1",
    "approvalId": "approval:<proposalId>",
    "approvedArtifactContractId": "email-reply-draft-proposal.v2",
    "approvedArtifactDigest": "<64-hex, == content.digest>",
    "approver": { "kind": "human", "id": "<approvedBy>" },
    "approvedAt": "<ISO date-time>",
    "scope": { "action": "send-once", "recipient": "recruiter@acme.example", "threadId": "thread-1" }
  }
}
```

## Company-research-via-broker composition (plan P3)

Wired as of this increment (see `draft-reply-context --research` above). The
drafting environment may DECLARE a `discovery-egress-broker` capability with an
exact allowlist; JobTrack validates and pins that allowlist into
`sourceStateSha256` but makes no network call and runs no model. Only the external
runner drives the broker with the declared policy. Fail-closed default: no
research. A non-allowlisted origin/path/query target is refused at declare time.

## Not in this increment

- No live send, no Gmail credential, no in-process model, no auto-send policy.
- No send capability of any kind — auto-send stays unauthorized (`JT-6`).
- Cryptographic approval signing is deferred to contract v2 (freeze decisions #5/#6).
