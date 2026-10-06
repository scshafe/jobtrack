# Missing-provider-proof adoption — design proposal

Status: **unapproved, source-only proposal; independently design-reviewed**,
September 9, 2026. This document advances the design portion of
[Engineering item 8](../WORK_REMAINING.md#engineering), not its implementation,
verification or live acceptance. No new CLI, schema, key, provider permission or
receipt type described below exists by virtue of this proposal. No mailbox,
personal store, protected/shared OpenClaw state or live incident was inspected.
Independent review found no actionable contradiction or overclaim in these
boundaries. That review is not approval of an issuer, evidence contract, runtime
implementation, live read or deployment; the decisions at the end remain open.

## Recommendation and hard boundary

Separate *an authenticated later observation of a provider resource* from
*proof that the exact already-fenced attempt caused that resource*. A signature
on the first does not establish the second. Record only the claim the evidence
can support. Do not turn a matching message into a replacement native send
acknowledgment or let an operator signature stand in for missing operation proof.

The narrow proposed adoption lane can append proof of an already completed send;
it cannot draft, approve, request, transmit, retry, delete/reclaim a fence or mint
a new attempt. It must remain safe when the intent is superseded, the link was
retracted or the application is terminal. Successful proof could close only the
exact reconciliation obligation, never reopen reply intent or enable another send.
No “not found means not sent” or failed-to-retry release is proposed.

First implementation, if separately approved: a strict, offline observation
validator and observation-only store journal, tested synthetically. Terminal
adoption remains disabled until the issuer, operation attribution and compatible
receipt/projection contracts below are reviewed. Do not silently weaken these
requirements to make the historical incident fit the first version.

## Existing evidence and limits

Sources are the checked-in code and recorded incident, not fresh live evidence:

- [Sender and recovery](../lib/email-send-live.js): a per-source fence and an
  exclusive per-approval `claim.json` are fsynced before transmission. The claim
  contains the exact request, approval ID, attempt ID and delivery coordinates.
  After transmission the sender persists native provider IDs, then a separately
  signed `email-send-receipt.v2`, then correlates it into SQLite. `readSendAttempt`
  requires that signed receipt, its claim and provider evidence with exact digest
  and identity agreement. Missing/malformed evidence remains `reconcile_only`.
- [Outgoing store lane](../lib/email-outgoing-v2.js): `correlateSendReceipt`
  requires an existing request and verified approval/native-key bindings. It
  preserves the one-attempt state graph and returns `retryAuthority: false`.
  Existing signed-journal recovery can reconstruct the original request after
  rollback, but uses `createSendRequest` and can refuse on later invalidation or
  changed source state. That is not a general historical proof-restoration API.
- [Runtime contracts](../lib/email-outgoing-v2-contracts.js) and
  [receipt v2 schema](../contracts/email/email-send-receipt.v2.schema.json): receipt
  validation verifies exact request/content/approval bindings, chronology and a
  pinned native signature. Evidence digests are opaque hashes; this validator
  does not independently contact the provider or establish the truth of the
  evidence behind those hashes. Current receipt keys are injected by trusted
  host code, not selected from an imported document.
- [Approved content](../contracts/email/email-approved-content.v1.schema.json)
  is a logical text/plain, empty-attachment projection with NFC/LF normalization,
  not provider MIME byte identity. Source facts, draft receipt, signed approval,
  send request and eventual receipt each have different evidentiary meanings.
- [Recorded incident](APPLYSIM_INTEGRATION_2026-09-07.md#native-nudge-reply-and-post-send-acknowledgment-failure):
  the claim survived, but native acknowledgment bytes, provider evidence, signed
  send receipt and SQLite request/receipt commit did not. A company-observed
  reply and reply-backed booking support the historical account of delivery;
  they do not reconstruct the missing native proof. The parser correction did
  not resolve this uncertainty and does not authorize running the sender again.

Important gaps: the current claim is not independently signed or anchored before
the effect; a later hash proves which bytes were read, not their pre-effect
authenticity. The sender's native draft receipt does not establish a sent-result
link: the send path invokes a message send with approved text, not a send-by-that-
draft-ID operation. The current claim supplies no authenticated provider-side
operation/result mapping. A provider capability supplying such a mapping has not
been established by this source review.

## Proposed roles and trust separation

The CLI remains the only database writer. The web is read-only. No server-side
proof write API, daemon sweep or automatic worker/provider call is proposed.

1. **Context exporter, local and read-only:** the operator selects one exact
   existing approval/request/attempt. It validates the selected store and reads
   only its bounded immutable artifacts and journals. It emits a digest-bound
   challenge containing public UUIDs, exact contract digests and a scoped nonce.
   It never creates keys, requests or filesystem fences during inspection.
2. **Provider observer, external and read-only:** a separately enrolled fixed
   implementation receives that challenge and one explicitly selected candidate
   resource. It may obtain only authorized provider/account/resource data through
   reviewed read-only operations. It has no JobTrack DB, send credentials or
   command capability, approval signer, native sender key, browser automation,
   arbitrary executable, shared OpenClaw payloads or general mailbox enumeration.
   A read-only provider grant and exact resource lookup must be demonstrated for
   the selected adapter; the existence of `gog` is not proof of that isolation.
3. **Observation issuer:** an explicitly trusted observer signs what it actually
   obtained and checked. Prefer a distinct observation key and key-purpose label,
   never the approval key or a silently reused native sender key. This is a host
   observation attestation, not a provider signature or an original send ACK.
4. **Offline reviewer/adopter, CLI-only:** independent review and an offline
   verifier consume the frozen bundle and trusted key registry. They append an
   observation and, only if all adopted proof requirements pass, a separate
   immutable adoption event. They have no provider or signing capability.

The eventual adoption decision must come through a separately reviewed,
authenticated ingress bound to the complete proof/context digest. A caller-set
`reviewedBy` or `authorship: human` string is not identity authentication. Reviewer
and issuer separation must be enforced at that ingress, not by changing a label.

Trust configuration must pin key ID, decoded public-key fingerprint, purpose,
issuer implementation/version, permitted provider/account scope and enrollment
validity out of band. Import cannot install its own key, accept embedded keys as
roots of trust, mint a replacement for a missing/corrupt signer, or choose an
executable. Key rotation/revocation and store-instance/clone identity are explicit
open decisions, not “use the key found next to the file.” A valid signature proves
an enrolled issuer made the claim; it does not cure insufficient provider evidence
or a compromised issuer. Separate enrollment and independent adoption review are
required before production use, without disguising agent review as human consent.

## Evidence bundle and exact bindings

The following is a candidate field inventory, not an accepted schema. A future
contract must have closed keys, bounded inert JSON, explicit versions, canonical
SHA256 and UUID-v4 artifact identities. Imported executable objects, callbacks,
prototype/accessor tricks, duplicate/contradictory identity fields and caller-
provided canonicalization functions must fail closed.

| Binding | Required proof and comparison |
| --- | --- |
| Store and application | Enrolled store-instance identity plus approval-key pin; exact existing application/intent/send-start UUIDs when present. A path, copied store key, current link, or company/title is not a unique instance identity. Missing historical app/start association stays unbound; no backfill from current links. |
| Source | Exact imported provider, authenticated mailbox/account identity, native source message/thread IDs, effective recipient, source facts digest and source-state digest from the immutable proposal. Preserve distinctions between `gmail_gog` source and `gog_gmail` delivery. Aliases require a reviewed exact mapping, not string guessing. |
| Draft/content/proposal | Exact proposal ID/digest, generation/manifest, approved-content ID/full canonical digest and captured draft receipt/digest. Read immutable local artifacts; do not recreate them from current templates or observed provider text. A draft ID is supporting provenance, not proof that this draft caused a sent message. |
| Approval/request | Original signed approval, key pin, approval ID/digest, one-send idempotency key, scope and timestamps; exact original request ID/canonical digest, embedded approval, thread-evidence digest, content digest and requested-at time. No new approval or request ID is permitted. |
| Attempt and claim | Exact pre-existing attempt ID, claim digest and source-fence digest, matching request and approval. A claimed executor string, old-looking timestamp or directory owner alone does not authenticate pre-effect causality. Require a reviewed independent anchor/attestation or provider-side authenticated operation linkage. |
| Provider resource | Observer-authenticated mailbox identity, native sent message ID/thread ID, resource observation time and exact transport/adapter identity; distinguish native IDs from RFC Message-ID. Prove the resource is the claimed sent effect, not a draft, inbound copy, import, other account's message or unrelated identical reply. A label/subject or caller-supplied RFC header alone cannot do that. |
| Operation attribution | Authenticated evidence binds **this original request/attempt** to **that native provider resource**. A guessed native ID, matching content, narrow time window, sole search result, company receipt or reply-backed interview is insufficient. Do not treat an unverified custom header as a provider-generated operation trace. |
| Observation | UUID, challenge/nonce digest, exact scope, issuance and observation times, adapter/version, retrieval evidence hashes, comparison-policy version, typed conclusion and observation signature. Keep actual observation time separate from claimed provider sent time; never backdate an observation or infer a precise send instant. |
| Review/adoption | Reviewer/authorship, bounded rationale, observation digest, immutable context digest, expected prior adoption/receipt state and full idempotency payload. Review attests the review decision, not missing provider facts or pre-effect authority. |

Content equivalence must compare the observed logical subject, normalized plain
text, effective sender/account and single recipient, exact reply headers, and
empty attachments with the already approved artifact. No body truncation,
whitespace trimming, quote stripping, signature stripping, heuristic HTML
conversion, alias substitution or reordered references may be introduced under
`email-text-nfc-lf.v1`. MIME parsing and allowed transfer/charset normalization must
be versioned, bounded, tested and explicitly reviewed. Unsupported/multiple
candidate body parts, concealed recipients, unknown attachments or provider
rewrites that cannot be explained by that policy yield observation-only/hold.

Do not compare the complete approved-content hash with the raw MIME hash: they
are different domains. Record separate raw-resource/evidence and observed logical
content digests, and verify the logical fields against the immutable approved
artifact. Generation IDs, manifest IDs and local creation metadata come from the
local artifact, not from pretending the mailbox echoed them. RFC Message-ID,
provider thread membership and observed delivery time are corroboration unless
an approved proof contract independently establishes their causal linkage.

## Outcomes and contract compatibility

Proposed conservative outcomes:

- `observation_recorded`: authenticated provider observation with exact scope;
  may establish that a resource exists and matches approved content. It **does
  not** fulfill intent or remove `reconcileOnly` without operation attribution.
- `adopted_sent_proof`: the complete original attempt/resource relationship is
  independently established, content and every authority binding match, and
  separate review accepts that proof. It closes only that obligation, while all
  physical fences and review history remain permanent. Never mark “duplicate”
  merely because a search found a matching message.
- `held` / `conflicting_evidence`: bounded reasons, no effect conclusion and no
  release. No result, denied read, stale challenge, malformed native receipt,
  missing key or missing request is not conclusive non-send proof.

Prefer a distinct versioned observation/adoption contract and append-only domain
records; do not shoehorn a later observer into today's native ACK journal. The
current receipt schema has closed keys and no explicit observation/adoption proof
kind. `readSendAttempt` also expects the original claim/receipt plus a particular
provider-evidence digest shape. Silently writing an observer result into
`receipt.json`, injecting an unreviewed key through the receipt lane, or relabeling
the observation as the original native receipt would obscure provenance.

Whether a future reviewed receipt version can truthfully represent adopted proof,
or a separate event should feed a new reconciliation projection, is an explicit
compatibility decision. Until then, existing intent projections continue to
require their current exact signed receipt; an observation-only record cannot
change them. The generic receipt contract's failed/indeterminate branches do not
create local resend permission: JobTrack's per-source no-retry policy is stricter.

## Idempotency, persistence and rollback

Suggested future durable records are observations, explicit adoption reviews and
adoptions, each with non-null unique UUID-v4 identity, foreign keys to existing
local entities, complete canonical document/digest, unique idempotency key and
append-only update/delete guards. Names and a migration version require review.
Migration replay and UUID assignment must preserve every existing guard and row.

Exact replay returns the same recorded fact without provider access, new signing,
new receipt, new request or change of state. A reused artifact ID/key with changed
source/account/resource/context/body digest/issuer/reviewer/rationale is a conflict.
New observations may be appended after further authorized reads; they do not
overwrite contradictory evidence. One attempt cannot adopt two provider resources,
and one resource cannot satisfy distinct attempt/application bindings. A second
matching message is conflict evidence, not automatic selection or “duplicate.”

Persist a verified signed bundle atomically into a new private, immutable evidence
location before DB adoption. Never replace or repair original claim, malformed
receipt, provider evidence or fence files. Use exclusive creation, private modes,
hash verification, fsync and an atomically published manifest; a crash leaves only
an inert evidence artifact or a committed adoption, never new send authority.
The CLI adoption transaction rechecks immutable digests, key-policy snapshot and
expected prior state, inserts all related records atomically, then assigns UUIDs.
Concurrent import/replay and receipt arrival must serialize and fail closed on
conflicting state, including reentrant verifier callbacks. An interrupted import
can replay the exact persisted bundle; it must not re-observe or re-sign silently.

Initial terminal-adoption scope should require an **already persisted exact send
request**. If SQLite rolled it back, record at most observation-only evidence.
The current unsigned claim plus a later mailbox match is not sufficient to restore
the request or its claimed pre-effect time. A separate, reviewed historical
restoration contract would need authenticated original request/claim provenance,
exact old timestamps and digests, and an explicit no-authority reconstruction
path. Do not call `send-approved`, mint a request with current time, backdate a new
request, or bypass invalidation/current-state checks to make restoration succeed.
This deliberate scope limit means the recorded September 7 incident is not yet
eligible for the recommended first adoption version.

Later expiration, supersession, terminal workflow state or retraction cannot
retroactively change a proved physical fact. They still bar ordinary sending.
How historical proof of an effect performed under invalid/expired authority is
recorded as a violation, without marking a legitimate approved send fulfilled,
needs a separate explicit rule; hold it rather than asserting approval after the
fact. Existing terminal receipt history must never be rewritten by new proof.

## Private artifacts and authorization

Every input/provenance/output path must pass `private-source-boundary` before store
opening or candidate I/O, including lexical and canonical/symlink checks and
shared-runtime/provenance-marker denial. Inline content is not an origin bypass.
Use an explicitly selected JobTrack store with both store variables pinned; never
default a proof job to a personal store. Observers must not search shared OpenClaw,
Telegram, media or delivery stores or the excluded private-journal account.

Raw MIME, complete addresses, headers, approval/request documents and evidence
are private bounded artifacts, not stdout, web content, worker prompt material,
public exports or general logs. An offline importer must reject symlinks,
hardlink/ownership/mode violations, traversal, oversized/decompression-heavy data
and path races using validated file descriptors; do not chmod host directories
or repair untrusted source files. Store private artifacts in explicitly governed
0700 directories/0600 files, with no network fetch on an import path. Digests of
low-entropy private fields can leak information too; public/read-only views show
only approved metadata, UUIDs and bounded reason codes. Avoid body-derived error
messages and credential/native output dumps. Retention, encrypted backup and
authorized disposal require an operator policy; this design deletes nothing.

An operator's authorization to read a selected account/resource is separate from
issuer enrollment, adoption review, implementation approval and production
deployment. This proposal grants none of those and cannot authorize a historical
mailbox lookup or incident repair. Mail content remains inert evidence throughout.

## Threat cases and acceptance criteria

All initial checks use synthetic disposable stores, generated test keys and fake
read-only provider transports; both store variables are pinned, actual HOME and
protected directories remain untouched. Instrument all capability boundaries.

1. Valid signed observation with exact content but no causal operation link:
   record at most observation-only; intent remains reconcile-only, fences unchanged.
2. Wrong store/clone, key purpose, issuer fingerprint, provider/account, source,
   approval/request/attempt, resource/thread, generation or content: reject each
   independently, including same message shared by two applications and A→B relinks.
3. Body/time/subject-only candidate, copied RFC Message-ID, fake custom operation
   header, moved/imported message, draft, inbound copy, or multiple identical
   messages: none is adopted. Company booking or quoted “approve” text is no proof.
4. Subject/body/header/recipient/attachment drift, unsupported MIME/charset,
   normalization ambiguity or contradictory native IDs: bounded hold, no guessed
   equivalence. Compare logical and raw hashes in their distinct domains.
5. Missing/corrupt original claim, unsigned claim-only history, lost request,
   missing native key or provider-only file: no key mint, request reconstruction,
   receipt rewrite or fence release. Preserve malformed originals as evidence.
6. New signed proof type cannot enter the existing v2 receipt lane via invented
   fields, observation-key substitution or a schema label change. Frozen old
   signed-receipt recovery and receipt-state graph tests remain unchanged.
7. Full idempotency conflicts, replay after link changes/revocation, simultaneous
   imports, concurrent native receipt arrival and verifier reentrancy: no duplicate
   adoption, hidden contradiction, reopened work or replacement attempt.
8. Crash after evidence persistence and before/inside/after the DB transaction:
   recover exact artifacts idempotently; no transmission or loss of old journals.
   Verify all UUID/FK/append-only constraints and migration replay.
9. Superseded/archived/rejected/withdrawn/high-risk/retracted sources stay blocked
   unless independently sufficient proof resolves that exact obligation; even then
   no dispatch, scheduled retry or send fence removal appears. Negative observations
   and provider-read outages never create non-send or retry authority.
10. Path/provenance/symlink/race attacks fail before disallowed I/O; injected
    provider reads cannot mutate mail; logs/web/export contain no raw mail or key
    material. Sentinel stores and source journals remain byte-identical.

Positive terminal-adoption fixtures may be added only after reviewers define a
truthful authenticated operation-to-resource witness and accepted contract. A fake
test witness proves parser/state behavior, not that any real provider supplies
that evidence. Separate, explicitly authorized live acceptance must demonstrate
the approved adapter/issuer's evidence and least privilege without sending a
message as a test. Engineering item 8 and the historical incident remain open.

## Decisions required before implementation beyond observation-only

- What real, authenticated evidence can bind an already-fenced operation to a
  provider resource, especially when the native result ID was lost? If none is
  available for old attempts, is permanent unresolved status the accepted outcome?
- Who is trusted to issue observations, how are its implementation/key/account
  pins enrolled and audited, and what do revocation, key loss, rotation and store
  cloning mean for historical adoption? No self-enrollment during import.
- Which read-only provider capabilities, MIME equivalence rules and identity
  mappings are proven available? Gmail is only a candidate; Apple remains closed.
- Which reviewed contract truthfully records observation vs adopted physical
  proof, and which consumer/release ordering safely changes reconciliation state
  without granting send authority or altering frozen native receipt semantics?
- Can an authenticated historical request ever be restored without current send
  authority, and how are changed/invalid authority and conflicting receipt history
  recorded? Current unsigned claim-only incidents are excluded by default.
- Who performs independent adoption review, what private evidence can they see,
  and what are the approved retention/encryption/backup and explicit live-read
  boundaries? No answer is assumed by this design.

Independent design review should either accept these boundaries for a later
synthetic-only implementation or identify which decisions remain blocking. It
must not mark deployment, live acceptance, incident reconciliation, cross-thread
supersession or retry-release complete.
