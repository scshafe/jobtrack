# JobTrack Email Pipeline Rollout Plan

Status: companion plan for Inbox Pipeline's PostgreSQL/continuous-processing implementation.

Outgoing note: this document describes inbound detection/correlation rollout. Its references to
a future executor are historical and grant no authority. The current outgoing design is the
standalone, provider-neutral G03 control plane in
[`EMAIL_OUTGOING_PROVIDER_NEUTRAL.md`](EMAIL_OUTGOING_PROVIDER_NEUTRAL.md); frozen v1 dry-run code
is inert.

## Goal

Connect JobTrack to the local-first inbox pipeline so job-application communications are detected
quickly, correlated to the correct company/opening/posting/application/interview, and turned into
reviewable state-transition and reply-draft proposals without granting the email system direct
JobTrack database access or send authority.

## Ownership boundary

```text
Inbox Pipeline owns                  JobTrack owns
------------------                  -------------
mail accounts and provider IDs      companies/openings/postings
message/thread identity             applications/interviews
safe message evidence               normalized correlation
model/persona/stage provenance      transition validity/versioning
delivery retries                    proposal review/apply history
future send executor boundary       application-material/profile data
```

There are no cross-database foreign keys. Stable versioned documents and idempotency keys cross
the boundary.

## Existing JobTrack capabilities retained

- `job-application-email-facts.v1` strict sanitized facts;
- read-only correlation over a verified SQLite snapshot;
- exact normalized provider/application/posting identities;
- ambiguous/unmatched fail-closed behavior;
- version-pinned transition proposals and explicit review/apply;
- recipient-locked reply drafts with `autoSendEligible=false`;
- append-only provenance and idempotency conflict detection.

## Inbox Pipeline responsibilities

1. Preserve provider/account/message/thread IDs exactly.
2. Treat all message content as untrusted.
3. Produce bounded evidence and a content digest; exclude raw MIME, HTML, attachments, tracking
   pixels, credentials, and private mailbox archives.
4. Mark completeness honestly as `metadata_only` or `sanitized_plain_text`;
   production proposals require an immutable `sanitized_plain_text` processing
   input, while metadata-only evidence remains review/legacy context and cannot
   authorize JobTrack work.
5. Emit `unknown` rather than inventing a company, application, status, deadline, or interview.
6. Call `jobtrack email correlate` through a fixed executable/argument adapter with no shell.
7. Persist and deliver facts/correlation/proposals idempotently.
8. Stop at operator review for ambiguity, stale versions, security risk, or missing evidence.
9. Never infer send permission from an approved JobTrack reply draft.

## Delivery topics

The implemented release-candidate transport is
`jobtrack.mail.proposed.v1`. It carries one least-data, human-review-bound
proposal from the sole production externalizing variant. The dedicated relay
validates that exact producer/payload contract, projects it to
`job-application-email-facts.v1`, and invokes only JobTrack's fixed
`correlate`, `import-facts`, and `record-correlation` commands.

The following domain-specific topics are later normalized projections to add
as the staged rollout advances:

- `job-email.detected.v1`: exact safe facts and provenance are available.
- `jobtrack-correlation.completed.v1`: read-only correlation outcome was recorded.
- `job-application-status-signal.proposed.v1`: a version-pinned transition is ready for review.
- `job-communication-reply-draft.proposed.v1`: a recipient-locked draft is ready for review.

Each event has a schema version, aggregate ID, partition key, payload digest, dedupe key, and
per-consumer delivery ledger. Delivery acknowledgement is not JobTrack transition approval.

## Staged rollout

### JT-1 — Contract compatibility

- Validate Inbox Pipeline artifacts against JobTrack's checked-in runtime validators and JSON
  Schemas.
- Pin supported contract digests and reject drift.
- Add shared fixtures covering application receipt, action request, invite, reschedule,
  cancellation, rejection, offer, recruiter follow-up, ambiguity, and malicious content.

Gate: both projects accept/reject the same fixtures and no unknown field crosses the boundary.

### JT-2 — Detection and read-only correlation

- Select job-related messages from exact classification evidence and deterministic sender/
  application references.
- Produce facts only from the exact successfully hydrated processing input;
  deferred and quarantined bodies remain outside delivery until repair or human
  review.
- Invoke read-only correlation and store the complete outcome in Inbox Pipeline's outbox ledger.
- Surface ambiguous/unmatched items in operator review.

Gate: JobTrack source database hashes/modes/sidecars remain unchanged by correlation.

### JT-3 — Proposal creation

- For exact links, create one target/version-pinned transition proposal.
- Create a reply draft only when an exact reply address exists; model-authored content always
  requires review.
- Persist proposals through JobTrack's idempotent CLI operations.

Gate: duplicate delivery reuses the exact operation; changed input with the same key conflicts;
stale application versions fail atomically.

### JT-4 — Operator workflow

- Add Inbox Pipeline links/status to the existing review console.
- Link to JobTrack's relevant application/interview/proposal view without exposing private
  payloads by default.
- Keep JobTrack review/apply an explicit human action.

Gate: no approval path can invoke a mail sender, and no mail worker can apply a JobTrack change.

### JT-5 — Timely continuous lane

- Run after the recent-mail ten-message classification lane.
- Retry JobTrack outages independently through per-consumer outbox delivery.
- Track detection-to-proposal latency, ambiguous rate, stale-version rate, review decisions, and
  false-negative audit samples.

Gate: a JobTrack outage does not block mail ingestion/classification or lose proposal evidence.

### JT-6 — Future outbound mail (not authorized here)

A later project may add a separate email draft/send executor. It must require its own credential,
recipient/thread lock, sensitive-data scan, policy, idempotency key, approval semantics, audit,
canary, and explicit authorization. It is not part of the current rollout.

## Required tests

- exact application/posting/provider ID correlation;
- cross-posting distinction for one opening;
- account/message/thread identity preservation;
- metadata-only and sanitized-body completeness;
- ambiguous/unmatched stop behavior;
- stale application/interview version;
- prompt-injection and sensitive-data redaction;
- duplicate/out-of-order/outage delivery;
- recipient mismatch and missing reply-to rejection;
- inability to open JobTrack SQLite directly from the connector;
- inability to send, label, archive, delete, or upload through either project.

## Rollback

Disable the JobTrack subscription while retaining immutable outbox events and delivery attempts.
Inbox classification continues. JobTrack's current SQLite schema and CLI remain authoritative;
no direct dual-write or destructive migration is introduced by this integration.
