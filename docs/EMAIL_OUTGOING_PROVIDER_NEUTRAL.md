# Provider-neutral outgoing email (G03)

Status: implemented offline control plane, 2026-08-01.
**Amended 2026-08-06 — two boundaries below have moved. Read the amendment
first.**

This is the current outgoing-email architecture. It is standalone,
provider-neutral, and content-equivalent. JobTrack is an immutable review and
authority store; it is not a model host, mailbox client, provider draft
creator, or sender.

---

## Amendment (2026-08-06): what changed after publication

**2026-09-08 integration amendment:** the external native-draft recipe and
durable send-attempt fences are described in
[Native draft operations](NATIVE_DRAFT_OPERATIONS.md). Live paths no longer
use fixture receipts. Clarification is a data-only preparation/synchronization
operation; its fixed-template execution is distinct from the unchanged
standalone-runner contract. Provider mutation retries must be disabled at the
executor as well as fenced at the application. This amendment does not claim
a completed live test cycle.

Every historical email doc in this repo points here as "the current
architecture", so the two places where this document no longer describes the
running system are stated up front rather than left to be discovered. The
design text below is unchanged — this is a note on what moved, not a rewrite.

**1. JobTrack sends. It is a sender now.** The header above says it is not one;
that was true on 2026-08-01. On 2026-08-05 `email send-approved`
(`lib/email-send-live.js`) shipped, and it transmits real mail through Apple
Mail or gog/Gmail. It is the only command in the repo that puts bytes on a
wire. What guards it:

- an approval receipt this lane produced, re-verified against its pinned key;
- a recipient **allowlist** at `$JOBTRACK_HOME/send-allowlist.json`, checked
  between the authority claim and the wire, never widened automatically;
- a stored sent-receipt lookup that fences a second transmission for the same
  approval — idempotent replay of the send REQUEST was not enough, because a
  replayed request is a legitimate no-op while a second transmission is not.

**2. An approval may be made by policy, not only by a human.** The boundary
below reads "only an authenticated positive human review may create
`approval-receipt.v2`". The contract was widened ADDITIVELY on 2026-08-05:
`approver.kind` is now `'human' | 'policy'`, and the default policy is
automatic approval (`lib/email-auto-approval.js`;
`JOBTRACK_APPROVAL_DEFAULT=manual` flips the default, and a per-application
override switches one application back to manual review).

A policy approval is a real `recordReviewDecision` call, not a bypass. It
carries `approver { kind: 'policy', id: 'auto-approval-policy.v1' }` — so a
receipt always says what decided, and a policy never masquerades as a human —
an authenticated channel whose verify re-reads the policy at decision time (a
manual override that lands between drafting and approval wins), and a real
Ed25519 signature from a per-store key.

**What did not change.** Digest locks, approval expiry, sole-positive-review,
one-send-request-per-approval, the required draft receipt, the injected-signer
boundary and its realm-hostile intrinsics handling, and the frozen-contract
rules in "Frozen v1" all still apply exactly as written below. The two changes
above are the whole delta.

See [EMAIL_LANES.md](EMAIL_LANES.md) for which lane owns which tables and
commands, and for the one known gap this created: the web reply views still
read the v1 tables and cannot display a v2 send.

---

The earlier `draft-reply-*` v0.6 / frozen-v1 implementation remains in the
repository only as inert historical compatibility code. It writes a dry-run
sink and cannot deliver mail. It is not the current architecture and must not
be extended into a provider edge.

## Hard boundaries

- The host CLI is the only supported writer. The web process remains
  read-only and has no outgoing mutation route.
- Draft generation runs in a standalone out-of-process runner. The request
  explicitly grants no tools, network, credentials, mailbox reads, native
  draft creation, or send effect. That runner is `bin/jobtrack-draft-runner.js`,
  which executes a digest-sealed Mission Pipeline DAG and returns inert data
  this CLI re-validates from scratch. See [DRAFT_RUNNER.md](DRAFT_RUNNER.md).
- Incoming facts are sanitized, hostile data. Exact provider, account,
  message, thread, effective-recipient, reply-header, generation, manifest,
  tone, voice, and source-state bindings are content-addressed.
- `email-approved-content.v1` is the exact logical content shown for review.
  Approval covers content-equivalent text, headers, recipient, thread, and an
  empty attachment list. It does not claim byte-identical rendered MIME.
- Capturing `email-draft-receipt.v1` records evidence that another authorized
  component already created a provider draft with `transmission=not_sent`.
  JobTrack never creates that draft.
- Only an authenticated positive human review may create
  `approval-receipt.v2`. Rejection appends a review event and creates no
  approval or send authority.
  *(Amended 2026-08-06: an authenticated positive POLICY review may also create
  one — see the amendment at the top. Everything else in this bullet stands.)*
- The approval signer is injected for one call as an owner-private Ed25519
  capability. Only signer identity, public key ID, and the SHA-256 fingerprint
  of raw SPKI DER are stored. Private bytes and the opaque key reference are
  never serialized, logged, returned, or placed in fixtures.
- Every value crossing the injected cryptographic callback boundary is
  classified with intrinsics captured at module load, in an order that executes
  no hostile code before rejection. A signer returns exactly one shape: a
  genuine byte view whose immediate prototype is identically `Buffer.prototype`
  or `Uint8Array.prototype` and whose typed-array element kind is `Uint8Array`.
  Proxies, Proxy or revoked-Proxy prototypes, custom prototype chains,
  subclasses, own accessors, shared memory, detached views, element-kind
  impostors, and signature text are all rejected before any property read,
  iteration, or copy. A public-key resolver returns only a primitive PEM string
  that re-exports to itself; `KeyObject` instances and wrapper objects are
  rejected without inspection, so no attacker-controlled `type`,
  `asymmetricKeyType`, or `export` can ever be reached.
- The same boundary treats the realm itself as untrusted. Every intrinsic the
  post-callback path uses is captured at module load, so replacing a global
  mid-call cannot forge a pinned-key comparison, a canonical serialization, or
  an unknown-field check. Base64 is encoded and decoded by index arithmetic
  rather than `Buffer` conversion, because Node's own byte routines resolve
  `length` through `%TypedArray%.prototype`. And because a swapped prototype
  chain is a compromised environment rather than a rejectable value, both
  modules verify that chain before handling key material and refuse outright
  if it has moved.
- `email-send-request.v2` is one immutable, one-send data claim. Creating it
  performs no provider operation. The stock CLI has no approval-key resolver,
  so this operation fails closed unless an authorized host injects the exact
  pinned public identity.
- `email-send-receipt.v2` correlation accepts signed evidence only. It records
  `sent`, `duplicate`, terminal `failed`, or `indeterminate`; it never grants
  retry authority. An indeterminate attempt may only be reconciled, not
  silently retried.

## Data flow

```text
sanitized imported facts
        |
        v
deterministic source-state-pinned request
        |  standalone process; toolCalls=0; sideEffects=[]
        v
email-reply-draft-proposal.v3
        +--> exact email-approved-content.v1 projection
        |
        +--> capture existing email-draft-receipt.v1 (not sent)
                    |
                    v
             exact read-only review projection
                    |
          +---------+----------+
          |                    |
        reject               approve
          |                    |
   append event only     authenticated human event
                               + injected Ed25519 attestation
                               v
                       approval-receipt.v2
                               |
                     current/fresh/not invalidated
                               v
                       email-send-request.v2
                       (data only; maximumSends=1)
                               |
                   separately authorized provider edge
                               v
                       email-send-receipt.v2
                       (signed evidence only)
```

## Contracts and digest domains

The checked-in schemas are the shared execution contracts:

- `email-reply-draft-proposal.v3`
- `email-approved-content.v1`
- `email-draft-receipt.v1`
- `approval-receipt.v2`
- `email-send-request.v2`
- `email-send-receipt.v2`

Runtime validation additionally enforces normalization, exact projections,
cross-document equality, chronology, expiry, key pinning, and signatures.
The complete shared-contract conformance snapshot—including schemas, public
positive/negative fixtures, digest fixtures, and Ed25519 vectors used by
JobTrack's release gates—is checked in under a content-addressed manifest
pinned to one reviewed Execution Contracts commit/tree. Tests never search a
mutable sibling checkout or a user-specific filesystem path.
Canonical JSON and normalized UTF-8 text are different digest domains and use
different helpers. Text is Unicode NFC with LF newlines. Lone UTF-16
surrogates, accessors, proxies, cycles, sparse arrays, custom prototypes,
controls, non-finite values, and unknown fields fail before authenticated bytes
are produced.

## Immutable SQLite model

Migration `2026080101 / provider_neutral_email_outgoing_core` adds:

- `job_email_outgoing_draft_requests`
- `job_email_outgoing_draft_results`
- `job_email_outgoing_proposals_v3`
- `job_email_approved_contents_v1`
- `job_email_draft_receipts_v1`
- `job_email_outgoing_review_events`
- `job_email_approval_receipts_v2`
- `job_email_outgoing_invalidation_events`
- `job_email_send_requests_v2`
- `job_email_send_receipt_correlations_v2`
- `job_email_outgoing_operations`

Every table has update/delete rejection triggers. Positive review requires the
exact captured draft row. An approval row requires a positive review. A send
request requires the exact approval and no invalidation. Application code adds
full contract/signature validation and wraps multi-row writes in an immediate
transaction, including when the outer CLI already owns a transaction.

The additive successor migration
`2026080102 / provider_neutral_email_outgoing_authority_guards` leaves
`2026080101` byte-for-byte historical and adds the database-enforced authority
invariants: exactly one terminal review per proposal and one serialized receipt
attempt state graph. The only receipt edges are initial
`indeterminate|sent|failed`, `indeterminate -> sent|failed`, and
`sent ->` an exactly evidence-bound `duplicate`. The migration refuses to
adopt a store that already contains a contradictory history.

## CLI workflow

All write inputs are strict JSON documents. Their idempotency keys live inside
the document so the complete command intent is hashed as one object.

```sh
# 1. Append the deterministic, unexecuted request.
jobtrack email outgoing-draft-issue --input request.json --json

# 2. Validate and append an out-of-process result. The usage object must say
#    runner=standalone_out_of_process, toolCalls=0, toolsUsed=[], sideEffects=[].
jobtrack email outgoing-draft-record --input result.json --json

# 3. Capture existing provider-draft evidence. This never creates a draft.
jobtrack email outgoing-draft-receipt --input draft-receipt-capture.json --json

# 4. Read the exact proposal/content/draft bytes and their digests.
jobtrack email outgoing-review --proposal-id PROPOSAL_ID --json

# 5. Append an authenticated decision. Local CLI rejection is available.
#    Positive approval additionally requires the injected private signer and
#    pinned public identity, so the stock CLI fails closed.
jobtrack email outgoing-review-record --input decision.json --json

# 6. Append the one-send request. No mail is sent. An authorized host must
#    inject the approval public-key resolver.
jobtrack email outgoing-send-request --input issue.json --json

# 7. Append signed native outcome evidence. No retry is authorized.
jobtrack email outgoing-receipt --input correlation.json --json

# 8. Append explicit revocation evidence when required.
jobtrack email outgoing-invalidate --input invalidation.json --json
```

`outgoing-review` is a read projection even though it is exposed through the
host CLI. It returns the full exact body for the private operator. It does not
add a web mutation/read route or expose that prose through the collapsed web
lifecycle surface.

For a local rejection, `authenticatedChannel` is
`jobtrack_fixed_command / jobtrack-owner-cli.v1`. Its
`authenticationReceiptDigest` is the canonical digest of the exact
`jobtrack-email-authenticated-review-context.v1` fields (review ID, proposal
ID, decision, human approver, decision time, projection/content digests, and
rejection reason). This proves exact command-intent binding. It supplies no
positive approval signer.

## Freshness, invalidation, and replay

- Expiry is exclusive everywhere: equality with an expiry is expired.
- Send issuance ignores caller timestamps. Its key resolver is snapshotted
  first; `requestedAt` is then read from the descriptor-snapshotted host clock
  and persisted as the final authority timestamp.
- Positive review preserves the authenticated human `decidedAt` as
  `approvedAt`, then re-reads the host clock after channel verification,
  signing, public-key resolution, and immediately before insertion.
  Historical `decidedAt` cannot revive expired content.
- Positive review and send issuance require the proposal to be the latest
  persisted proposal for the exact source tuple and recheck current source
  facts. Exact database state and exclusive expiry are checked after every
  injected channel, signing, key-resolution, failpoint, and clock callback
  before authority is appended.
- Recording a replacement proposal appends `regenerated` invalidation events
  for older approvals. Explicit closed reasons cover edits, source/account/
  recipient/thread/generation/manifest/idempotency drift, expiry, and operator
  revocation.
- An operation idempotency key replays only the byte-equivalent command result.
  Reuse for changed input is a conflict. One approval can mint only one send
  request and one one-send idempotency key.
- Receipt ID/digest replay is harmless. A request cannot introduce a second
  attempt. `failed` and `duplicate` are terminal. `sent` may only be followed
  by a correctly bound duplicate receipt. `indeterminate` carries
  `reconcile_only` and may be resolved for the same attempt; it creates no new
  authority.

## Provider integration boundary

Provider adapters live outside JobTrack and are not implemented here. A future
adapter must independently verify every shared artifact and pinned key,
resolve recipient/thread evidence, atomically consume the one-send idempotency
key, and return a signed receipt. Adding an adapter, credential store, mailbox
read, native-draft call, send call, deployment, service, or route is a separate
reviewed project. Nothing in this migration grants those effects.

## Historical compatibility boundary

The following remain frozen/inert for existing records and tests:

- `email-reply-draft-proposal.v1` and `.v2`
- `draft-provenance-receipt.v1`
- `approval-receipt.v1`
- `email-send-request.v1`
- `email-send-receipt.v1`
- the `draft-reply-*` commands and dry-run sink/correlation tables

They may be read for history. Do not reinterpret their approvals as v2 send
authority, do not upgrade them in place, and do not add a provider effect to
their dry-run sink. New outgoing work uses the G03 contracts and commands in
this document.
