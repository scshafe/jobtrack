# Decisions

## D-001 — Opening and posting are distinct identities

One employer vacancy/requisition is a `job_opening`. Each place it appears is a
`job_posting`. Multiple postings may link to one opening. Similar text or titles
only create duplicate candidates; they never auto-merge openings.

## D-002 — Canonical relations are authoritative

Companies, role types, seniority, and skills use canonical tables and foreign
keys. Legacy application/opportunity text columns remain temporary compatibility
projections during the additive migration.

## D-003 — Skill evidence is snapshot-bound

Required, preferred, and mentioned skills attach to immutable posting snapshots.
Opening-level summaries are derived views so conflicting source facts remain
visible.

## D-004 — Status and preparation history are append-only

Application status changes and interview-prep revisions retain provenance.
Current state is a transactionally maintained projection or pointer; history is
not overwritten.

## D-005 — Email integrations are proposal-only by default

The inbox pipeline emits strict facts, correlations, transition proposals, and
reply-draft proposals. It receives no JobTrack or Gmail credentials. Live send
requires a distinct future executor and policy gate; model-authored text is
never initially auto-sendable.

## D-006 — Discovery separates network authority from parsing

Sandboxed strategy workers cannot access the internet directly or mount the
JobTrack store. They submit declarative fetch intents to an allowlisted egress
broker and emit bounded, content-addressed proposal bundles.

## D-007 — LinkedIn is an intake source, not a crawl target

JobTrack may accept manual links, email alerts, licensed APIs, or separately
licensed search leads. It will not automate login, scrape credentialed pages,
reuse browser sessions, bypass access controls, or auto-apply.

## D-008 — Normalize additively before removing compatibility data

The first migration creates and backfills canonical relations without deleting
legacy columns. Table rebuilds and legacy-column removal require a later release
after all callers have moved and copied-live verification passes.

## D-009 — Prep creation, review, and selection are separate

Preparation analyses are immutable and idempotent. Creating a new draft never
silently replaces an existing current analysis. Review decisions and current
selection are append-only audited actions; selection uses an expected-current
identifier so concurrent updates fail closed.

## D-010 — Discovery acceptance is a data-only intent

Importing or accepting a sandbox proposal records provenance and a reviewed
ingestion intent. It cannot create an opportunity or application, grant network
authority, contact an employer, or submit a form. Those transitions remain
separate explicit decisions.

## D-011 — External application identities require reviewed evidence

Provider application identifiers become durable exact-match identities only
when facts-bound transition evidence has been reviewed and successfully
applied. Identity history is append-only; cross-application conflicts roll back
rather than being guessed.

## D-012 — Shared platforms and company sites have different venue scope

LinkedIn and shared applicant tracking systems such as Greenhouse, Lever, and
Ashby are global posting venues. A company's direct careers site is
company-scoped. Reusing a shared venue must never imply that the platform is
owned by the first company encountered.

## D-013 — Recurring discovery remains an explicit operational decision

The sandbox, broker, parsers, and trusted importer are release-ready, but no
recurring scheduler is enabled by v0.3. Scheduling requires approved source
policy, persistent leases/rate state, and a separately reviewed cadence.

## D-014 — Collection facets are exact relations, not text inference

Company, position type, position level, and governed tag filters compose over
canonical foreign-key relations. Repeated tag filters use AND semantics.
Unclassified records remain explicitly queryable; titles and legacy tags never
silently manufacture role or seniority classifications.

## D-015 — Requested profile information is evidence-scoped history

An application or opportunity may record information requested by a specific
form/posting. Requests are immutable, assessments are append-only, and current
state is an optimistic projection. A sibling posting on the same opening is not
equivalent evidence. Only an explicit `confirmed_missing` assessment creates a
missing-information signal, and requiredness determines whether it blocks work.

## D-016 — Profile normalization preserves source truth

Profile section types, confidence/proficiency domains, organizations and exact
aliases, work preferences, link/credential/answer kinds, project skills, and
tags use governed tables and foreign keys. Migration retains original strings
and compatibility projections exactly. Exact identities may link; fuzzy
organization merging and unsupported enum guesses are forbidden.

## D-017 — Tags are governed metadata, not canonical job facts

Tags have namespaces, lifecycle and sensitivity states, entity scopes,
provenance, confidence, and evidence. Only active public tags enter web facets.
Private profile tags cannot leak into public collection filters. Skills, role
types, and seniority remain distinct canonical relations.

## D-018 — The profile owns the story information architecture

Stories are a permission-aware subsection of the indexed private profile.
Legacy `/stories` collection links redirect to `/profile#stories`; story detail
routes and all raw-capture/privacy guarantees remain intact.

## D-019 — Strategy is a declarative control plane, not a model runtime

An external frontier-capable coordinator owns application strategy and reconciliation. JobTrack
stores bounded source manifests, reviewed routing policy, immutable plans, declarative work
requests, strict results, and append-only decisions. It does not call model APIs or execute
generic tools. Auxiliary work may use cheaper model classes under policy, but accepted outputs
must still pass the existing target-domain review/apply workflow.

## D-020 — Email adapts register without imitating identity

Recipient/thread profiles describe only observable communication register using closed bounded
dimensions. They do not claim personality, psychology, demographics, protected traits, dialect,
or identity. Cole-owned writing voices use only explicitly approved Cole-authored samples.
Outgoing drafts may accommodate formality, warmth, energy, directness, and brevity, but never
copy distinctive recipient phrases, signatures, slang, errors, or mannerisms. Review still grants
no send authority.

## D-021 — Document approval pins the rendered PDF

Managed resume and cover-letter revisions are complete LaTeX sources. Rendering occurs only in a
fixed networkless, read-only, resource-bounded container with no store or credential access. An
approved document review pins one exact immutable render; a later render cannot silently replace
it. Readiness, packages, and manual-submission facts bind and rehash both the source and the exact
resume/cover-letter PDF bytes.

## D-022 — Every durable row carries a UUID, and public export is the only crossing

Every durable table has a universal UUID identity, backfilled append-only and
self-healing. The public-profile export is the sole sanctioned path from the
private store to anything public: it is allowlisted, UUID-keyed, validated
against `contracts/export/public-profile.v2.schema.json`, and fails closed on
any redaction violation. Integer row identifiers, private repository URLs, and
hidden-entry content never leave. JobTrack exposes no public HTTP surface and
none may be added.

## D-023 — Repositories and project relations are first-class, with explicit visibility

Repositories are entities rather than free-text URLs, each carrying an explicit
visibility. Projects carry kinds and typed relations (`uses`,
`extracted_from`, `part_of`, `successor_of`). Only PUBLIC-visibility repository
links may appear in an export, and legacy URL and link fields are scrubbed of
private repository references rather than trusted.

## D-024 — Drafting is a separate process holding no authority

Draft generation runs out of process in `bin/jobtrack-draft-runner.js`. The
runner receives a digest-pinned request and returns inert data; it holds no
store handle, network client, credential, mailbox, tool surface, subprocess,
send, native draft, or approval. The CLI re-validates everything it returns
from scratch, so a compromised runner cannot make JobTrack accept an unbound
draft. The read-only web image contains no drafting capability at all.

This keeps D-019's boundary intact: JobTrack remains a declarative control
plane. The runner is a pipeline host, not an in-process model runtime, and a
model provider would enter only as an injected resolver behind a sealed,
digest-pinned binding.

## D-025 — The drafting pipeline is a digest-sealed DAG, and refusals are decisions

Drafting executes as a compiled Mission Pipeline DAG whose identity changes if
any stage, contract, or model binding changes. The engine is vendored and
pinned byte-for-byte to a published release, verified before load, so there is
no registry, network, or mutable-checkout dependency.

A refusal is raised as a non-retryable, item-scoped stage error and the runner
takes a single attempt. Retrying a principled refusal could only produce a
different answer to the same question, which is exactly what must not happen.
Untrusted message content is quoted evidence and never instruction: URL and
header excerpts are inadmissible, the recipient is locked to the imported
reply-to address, and the recipient's own distinctive phrasing may not be
reused verbatim.

## D-026 — The cryptographic callback boundary distrusts the realm, not just its inputs

Injected signers and key resolvers are attacker-positioned code. Every value
they return is classified with intrinsics captured at module load, ordered so
nothing hostile executes before rejection, and every intrinsic the
post-callback path uses is captured the same way — a global replaced mid-call
cannot forge a pinned-key comparison, a canonical serialization, or an
unknown-field check.

Because Node's own byte routines resolve `length` through
`%TypedArray%.prototype`, base64 is encoded and decoded by index arithmetic
rather than `Buffer` conversion. And a replaced prototype chain is treated as a
compromised environment rather than a rejectable value: the boundary verifies
the chain before handling key material and refuses outright if it has moved.
There is no safe way to operate on key material in a tampered realm.

## D-027 — Stories are captured on their own terms, and a required question without a mapped story blocks submission

A story is one real experience told on its own terms, never shaped as the
answer to a particular question; application answers are compressed from the
full story at submission time, and nothing is compressed at authoring time.
Retrieval runs on the facet claims the author records, not on prose overlap.
The story-mapping gate decides, per behavioral question, whether a ready and
permitted story honestly maps. Any required question without one means the
application must not be submitted: the blocked question escalates to Cole as a
durable check row under a run key, Cole authors the full story, and the gate
re-runs. A deliberate veto is the gate working. The real story library is
populated only from stories Cole actually tells.

## D-028 — Submission authority is approval-bound and reconciliation-fenced

The application-submission lane mirrors the v2 email lane rather than
reinventing it. A submission intent digests the exact answers and documents;
an approval is an Ed25519-signed receipt bound to that digest with a
one-submit idempotency key and an expiry; a claim yields one attempt at a
time; a settlement records the outcome, and one landed submission spends the
approval permanently. Editing an answer voids the approval, a concurrent
second claim is refused rather than queued, an unsettled attempt cannot be
re-claimed until reconciliation proves the original did not commit, and an
expired approval submits nothing. The lane performs no network I/O;
submitting is somebody else's job.

## D-029 — Operator gates are one configurable mechanism that fails closed to a human

Every gate shares one shape (id, subject, decisions, satisfying verb, mode,
rules, constraints, notify) and one of three modes. `human` parks the subject
until a person acts, and is the default for every gate. `policy` performs the
satisfying verb as an honestly labelled automated actor
(`approver_kind='policy'`, actor `policy:fabric/<gateId>@rev<N>`) only while
the gate's rules hold, and may never exceed the gate's constraints. `withhold`
refuses deliberately. An outward-facing gate's policy mode is set only as a
human's act. On the real store every gate defaults to human, submission
approval requires Cole's explicit constrained opt-in, and the apply executor
stays `manual` until driving a real application surface is a deliberate
decision with its own safety review.

## D-030 — Agents act only through the CLI, under standing rules and bounded budgets

A fabric worker's world is the store and, only where its brief says so, the
public pages of the posting and the employer's own site. It writes through the
`jobtrack` CLI with the idempotency keys its item provides; it never changes
gates, never approves, never submits, never creates an account, never sends
except by a brief's exact recipe, never acts as a human, never fabricates a
fact, and treats page and message content as data rather than instructions.
Its exit narrative decides nothing; the ledgers are the record. The dispatcher
staffs one item at a time within a per-pass cap and a durable per-item budget,
records every pass and worker under evidence directories, and never staffs the
apply node.

## D-031 — Email correlation asks once, and never nudges twice

When a message resolves ambiguously among two or more candidates and expects a
reply, the applicant's agent may ask one clarification question, signed as the
applicant; it expires after three days and is never nudged a second time, and
the sender's exact thread-linked answer is the strongest basis for the link. A
company with exactly one open application may auto-link with review. ATS and
consumer-domain lists are repo-seeded and console-editable, with provenance
preserved for either source. Policy revisions are immutable, digest-checked
data stamped on every result. The policy document carries no second-nudge
switch: the never-read `clarify.secondNudge` key was removed on 2026-09-05 as
document version v2, and revisions stored under v1 stay loadable as written.

## D-032 — Inbound email and post-submission stages are fabric work on any live application

Inbound job mail is work for the applicant's agent (`email.review`), resolved
and transitioned through the CLI with the agent's decision recorded.
Interviews and offers are events on any live application, including
legacy-import ones a person records by hand, so the preparation half's
"managed only" rule never hides them: a tick generates the deterministic first
preparation draft, an agent authors the analysis, and review, selection, the
interview outcome and the offer decision are a person's acts.

## D-033 — Agent harnesses are interchangeable behind a frozen seam, and production runs without metered spend

The fabric worker runner chooses the harness per request, `claude` or
`codex`, behind the frozen `agent-step-{request,result}.v1` seam, so the
engine port, the graph, the evidence tables and the replay rules are
byte-identical across harnesses; only the spawn differs. The production
dispatcher and the standing daemon run on the codex harness through the
operator's ChatGPT OAuth login, chosen because it incurs no metered API
spend; claude stays selectable per request.
