# Welcome-email readiness: issues and recommendations

Date: 2026-08-01

> **HISTORICAL (banner added 2026-08-06).** Every blocker and HIGH item below is
> resolved, and the work went further than this document's scope: the first full
> DUPLEX lifecycle ran on 2026-08-05 — four company emails and four real replies,
> welcome through offer, each stage gated on the previous one being answered.
> Kept for the RCA trail, which is the valuable part; several of these fixes
> (the `company_domain` correlation basis, `email resolve-correlation`,
> provider-neutral transition sources) are load-bearing and still current.
>
> For what is true now: [`EMAIL_LANES.md`](EMAIL_LANES.md) (which lane owns
> what), `~/.mission-control/projects/applysim/docs/LIVE-LOOP.md` (the operating
> protocol), and `.../docs/LIVE-LOOP-LOG.md` (the iteration history).

## Progress (updated as fixes land)

- **BLOCKER-1 — resolved.** inbox-pipeline now emits `application_received`
  (and `rejection`/`offer`) from source-grounded subtypes, so a welcome email
  is no longer `unknown`. Verified end to end: import the widened facts, issue
  a draft request, run the out-of-process runner — it now produces a reviewed
  acknowledgement reply where it previously refused with
  `draft_refused.unmapped_event_kind`. inbox-pipeline `main` @ `7fb4622`.
- **HIGH-2 — partially resolved.** `replyRequested` is now derived (true for a
  fresh acknowledgement or offer). `postingRefs`/`applicationRefs` population
  and correcting the frozen-golden `action_required` case remain.
- **LOW-1 — resolved.** A dropped interview link now leaves an
  `interview_unmatched` or `interview_ambiguous` evidence entry instead of
  failing silently. JobTrack `main` @ `450e439`.
- **HIGH-1 — resolved (coordinated contract change).** The sender's display
  name now survives the whole path. execution-contracts v1.4.0 adds an optional
  `source.fromDisplayName` to `job-application-email-facts.v2` (additive, frozen
  bytes re-pinned per CONVENTIONS §3); inbox-pipeline threads
  `normalized.fromName` through `JobTrackMailProposalV2.sender.name` into
  `projectProposalToJobTrackFactsV2`; JobTrack's validator accepts it and a new
  `email record-contact` verb promotes it into a durable, endpoint-scoped
  `company_contacts` row (name defaults to `fromDisplayName`, email must be an
  exact From/Reply-To of the source message, idempotent over the natural key).
  execution-contracts `main` @ `ad7185a`, inbox-pipeline `main` @ `87545dc`,
  JobTrack this commit.
- **BLOCKER-2 — resolved (full fixture-mailbox rehearsal, no send).** A
  synthetic welcome `.emlx` was driven through the real Apple Mail adapter and
  the provider-neutral stage chain in-process (route `jobs`, signal
  `application_acknowledged`, `eventKind: application_received`,
  `replyRequested: true`, `fromDisplayName: "Talent Team"`), then through the
  live JobTrack CLI on a disposable store: correlate (linked) → import-facts →
  record-correlation → record-contact ("Talent Team" stored) →
  outgoing-draft-issue (effects all false) → outgoing-draft-record →
  outgoing-review, which rendered a reply awaiting human review. Approval failed
  closed (`RUNTIME_UNAVAILABLE`: signer keyRef must be injected) and the run
  stopped before any send — the correct end state for that tranche.
- **HIGH-3 — resolved (coordinated contract change).** Correlation can now match
  on company. A new `company_domain` basis matches the sender's `from_domain`
  (and `facts.company.domain` when present) against `companies.website_domain`
  and domain-kind aliases, then surfaces every application under the matched
  company as a candidate. It is deliberately FUZZY — absent from the exact set,
  it can never auto-link; a first-contact welcome email resolves `ambiguous`
  with the company's applications for an operator to confirm, and upgrades to
  `company_and_role` when the email also names the role. Delivered as an
  additive enum widening of `jobtrack-correlation-result.v2` (v2-only; the
  frozen `v1` correlation contract is untouched). execution-contracts `main` @
  `01c351d` (v1.5.0), inbox-pipeline `main` @ `6268b0a`, JobTrack `441534e`.
- **HIGH-4 — resolved (JobTrack-only; no contract change).** New
  `email resolve-correlation` verb: an operator picks one application from an
  `ambiguous` correlation. It re-derives the current read-only correlation
  (which must still be ambiguous and still list the choice), promotes that
  candidate to `resolved`, and records the human choice as an
  `operator_resolution` evidence entry — the contract already permits a `linked`
  correlation with a non-exact `resolved` and `automaticEligible:false`, so no
  schema change was needed. The result is a review-required linked correlation
  that `propose-transition` accepts (verified: previously `CORRELATION_MISMATCH`,
  now succeeds), and it is non-automatic by construction — the operator unblocked
  the lane, they did not bypass approval. JobTrack this commit.
  - *Surfaced en route → resolved as HIGH-5 below.*
- **HIGH-5 — resolved (JobTrack-only; no contract change).** The transition
  proposal source is now provider-neutral, so the v2 Apple welcome path reaches
  the transition lane. `jobtrack-transition-proposal.v1` is a JobTrack-local,
  unpublished contract, so `validateTransitionProposal` now validates
  `source.provider` against the provider-code pattern (a superset of the legacy
  `{gmail, fixture, manual}` enum — every prior proposal stays valid), and the
  runtime provider is re-bound to a stored message by `proposeTransition`, so
  nothing is weakened. Verified end to end: a v2 `apple_mail_emlx` message now
  travels correlate → record → **propose → review → apply** (`link_message`),
  producing a real message↔application link where the strict enum previously
  rejected the proposal. JobTrack this commit.
  - *Scoped out:* the legacy `propose-reply` lane (`email-reply-draft-proposal`
    v1/v2) stays strict — v2 is a PUBLISHED shared contract, so widening it is a
    coordinated execution-contracts change, and the v2 reply path already uses
    the provider-neutral outgoing lane, so nothing needs it.

**Scope update (2026-08-01).** Send, the B08 native Mail host, and approval
reachability are **now in scope** going forward — they are no longer the hard
boundary this document treated them as. They remain **unbuilt** and are the next
frontier, not a completed capability: today approval still fails closed without
an injected signer, and nothing sends. What changes is intent — future work may
build the signer-injected approval path, the native Mail draft/send host, and
the actual send edge, rather than treating them as permanently out of bounds.

Remaining: HIGH-2 tail (`postingRefs`/`applicationRefs` population,
`action_required` golden), MEDIUM-3 (extend the relay past correlation), and the
newly in-scope approval/native-Mail/send frontier (BLOCKER-3 and B08).

---

## The objective

A recruiter sends a simple, friendly welcome email — no interview, no
scheduling, nothing to decide. The platform should read it, understand what it
is, attach it to the right application, remember who sent it, and prepare a
reasonable reply for Cole to review.

This is the smallest end-to-end exercise of the whole communications path, which
is exactly why it is worth getting right first.

## Verdict

**It cannot complete that journey today.** The break is not where
`WORK_REMAINING.md` implies. The JobTrack half is largely real and was driven
end to end on a scratch store during this review: facts → correlate → import →
record-correlation → propose → review → apply, then draft-issue → runner →
draft-record → review. That works.

Three things stop it, and one of them is a semantic mismatch that no test on
either side would catch, because each side is individually correct.

---

## The path, leg by leg

| Leg | Status | Stops at |
| --- | --- | --- |
| Apple Mail → inbox-pipeline | **not built** | entrypoint refuses; no Inbox PostgreSQL |
| message → typed facts | **partial** | projection cannot express an acknowledgement |
| facts → JobTrack | **works** | — |
| JobTrack → status / link | **works** | fully manual by design |
| JobTrack → contacts / names | **not built** | name is dropped at the contract boundary |
| status → drafted reply | **works** | — |
| draft → human review | **partial** | renders; approval unreachable |

---

## Issues

Severity reflects impact on this objective, not on the platform generally.

### BLOCKER-1 — A welcome email classifies as `unknown`, and `unknown` is undraftable

The two halves do not meet, and each is individually correct.

inbox-pipeline can emit exactly three event kinds — `action_required`,
`recruiter_followup`, `unknown` — out of the ten the shared contract defines.
Its `signalType → eventKind` map collapses `application_status_signal`,
`interview_signal`, and `unknown_job_mail` all into `unknown`
(`src/integration/jobtrack-relay-contracts.ts:288-294`). A welcome email is an
`application_status_signal`, so it arrives as `unknown`.

JobTrack's draft runner maps nine event kinds to reply purposes.
`unknown` is deliberately not one of them, because the runner refuses to guess a
purpose it cannot derive (`lib/draft-runner/stages.js`, `EVENT_PURPOSES`). It
therefore refuses with `draft_refused.unmapped_event_kind`.

Verified directly: of the three kinds inbox can emit, two are draftable and the
one a welcome email actually becomes is refused.

**Fix.** Widen the producer so `application_received` is reachable. This is task
38 and it is the single highest-value change in this document — nothing
downstream can work without it.

### BLOCKER-2 — The mailbox leg has no runnable path

`apple_mail_emlx` is fully implemented and genuinely well hardened — `O_NOFOLLOW`
opens, realpath canonicalisation, symlink rejection, dev/ino/size/mtime
revalidation before and after every read, manifest-stability rescans with
retries. It is **not wired to anything**. The Apple ingress entrypoint refuses
with *"B08 signed native Reader bridge is unadmitted"*, the production schedule
pins `nativeReaderAdmissionState: "unadmitted"`, and there is no Inbox
PostgreSQL instance running at all (retired in B02; B12 has not happened).

**Fix for this objective.** Do not build B08. Drive the adapter in-process
against a fixture `.emlx` tree. It needs no Full Disk Access, no native bridge,
and no PostgreSQL, and the adapter already has a test proving it composes a
fully hydrated provider-neutral page from a real fixture directory.

### BLOCKER-3 — Approval is unreachable, by design

`outgoing-review` renders the exact recipient, thread, subject, body and digest.
But `canApprove` is false without a native Mail draft receipt that no component
can produce (task 49), and `outgoing-review-record --decision approve` fails
with *"approval signer.keyRef must be injected"* — the stock CLI wires no
Ed25519 signer. Rejection works.

**This is correct and should not be changed.** The objective ends at *a reply
drafted and rendered for review*. Approval and sending are gated behind B08 and
Cole's tasks 58-61, and nothing here should try to route around that.

---

### HIGH-1 — The sender's name is captured, then deliberately thrown away

inbox-pipeline *does* capture the display name, in
`mail.message_participants.display_name`, and re-derives it downstream as
`normalized.fromName`.

JobTrack's facts contract validates with `exactKeys`, which **rejects any field
it does not know** (`lib/email-contracts.js:729-740`). There is no name field.
So the name is captured upstream and discarded at the handoff.

Worse, the destination is unreachable anyway: `company_contacts` has a `name`
column, but **no CLI verb inserts into it** — only a test does. `email
bind-contact` requires a `--company-contact-id` that nothing can create.

**Fix.** Add an optional `source.fromDisplayName` to the facts contract, emit it
from the relay, and add a verb that creates or proposes a `company_contacts` row
from an inbound sender. Without both halves, "storing emails and names" remains
half-built.

### HIGH-2 — `replyRequested` is hardcoded `false`

`src/integration/jobtrack-relay-contracts.ts:251-253` pins
`replyRequested: z.literal(false)`. JobTrack can therefore never learn that a
reply was wanted — which is the entire premise of this objective.

`postingRefs` and `applicationRefs` are pinned to `z.array(z.never()).length(0)`
in the same block, so no posting URL, external job id, role title, or ATS
application id ever reaches JobTrack.

**Fix.** Part of task 38, alongside BLOCKER-1.

### HIGH-3 — Correlation cannot match on company, so a welcome email likely lands `unmatched`

Correlation matches only to *applications*, and `from_domain` is never matched
against `companies` or company aliases. `facts.company` is never populated by
inbox-pipeline at all. For a welcome email carrying no posting URL and no
external application id, the only reachable bases are the weak legacy string
matches `company_and_role` (0.65) and `company_only` (0.35) — and those need
`facts.company`, which is absent.

The realistic outcome today is `unmatched`, which blocks `propose-transition`
entirely.

**Fix.** Populate `facts.company` from the sender domain and subject, and add a
`from_domain → companies` match basis. Keep it fuzzy, so it proposes rather than
auto-links.

### HIGH-4 — Ambiguity dead-ends with no resolution verb

`linked` requires exactly one distinct application on an exact basis. Two or
more yields `ambiguous`, and `propose-transition` then throws
`CORRELATION_MISMATCH`. There is no verb to disambiguate — the operator cannot
say "it is this one" and continue.

**Fix.** Add a resolution verb that records an operator's choice as evidence and
unblocks the proposal. This will bite the moment there is more than one
application at the same company.

---

### MEDIUM-1 — Reply-To is captured nowhere

`mail.message_participants.role` includes `reply_to` in its enum, but only
`from`, `to`, and `cc` are ever written. `source.replyToAddress` is in the facts
contract but the producer never emits it.

JobTrack degrades gracefully — `issueDraftRequest` falls back to
`message.reply_to_address || message.from_address` — so this is not a blocker.
But a recruiter using a no-reply From with a real Reply-To would get a draft
addressed to the wrong place, silently.

### MEDIUM-2 — The Gmail path fetches RFC headers and discards them

The wired Gmail adapter makes three extra `gog` calls per message to fetch
`Message-ID`, `References`, and `In-Reply-To`, then drops them, because
`ingested-email.v1` has no fields for them. `ingested-email.v2` does persist
`internet_message_id`, but its only non-test caller is a one-shot canary.

Pure waste today, and threading evidence lost. Not on the Apple path.

### MEDIUM-3 — The relay stops at correlation

The relay is genuinely built — a PostgreSQL-backed leased delivery queue
draining to the JobTrack CLI over a fixed three-verb surface, payloads passed by
owner-only temp file rather than argv. It is good work.

It never calls `propose-transition` or `propose-reply`; the tests actively
assert that it does not (task 39). So even with BLOCKER-1 fixed, the last mile
into JobTrack's proposal lane is manual.

### MEDIUM-4 — No dead letters and no replay for deliveries

`pipeline.dead_letters` exists but is scoped to stage executions and is never
written by the relay. A terminally failed delivery has no admin path back, and
`integration.outbox_deliveries` is append-only, so a poisoned event cannot be
retried without minting a new one (task 41).

### MEDIUM-5 — `security.risk` is hardcoded `medium`

The `security.scan` stage's actual findings are never projected into the facts;
`risk: 'medium'` and `requiresReview: true` are literals. `low` and `high` are
unreachable.

This matters for drafting: the runner refuses outright on `risk: 'high'`, so a
genuinely dangerous message would be drafted for rather than refused.

### MEDIUM-6 — `outgoing-draft-issue` never verifies the tone decision or voice revision exists

The draft request requires `toneDecisionId` + digest and `voiceRevisionId` +
digest, each operator-authored then reviewed then selected through three verbs.
The G03 lane accepts any well-formed identifier without checking the database.
A typo produces a draft bound to a tone decision that does not exist.

---

### LOW-1 — Interview linkage is dropped silently

`enrichInterviewCandidates` (`lib/email-integration.js:1220`) attaches an
interview only when exactly one matches. With zero or two-plus it attaches
nothing, emits no evidence entry, and issues **no warning**. The operator sees a
correlation that looks complete and simply lacks the link.

This is the one place in the reviewed path that fails *quietly* rather than
closed. Everything else refuses loudly.

### LOW-2 — `EmailAdapterRegistry` is scaffolding

The class is never instantiated anywhere in `src/`. Every production call site
constructs a concrete adapter factory directly. Harmless, but misleading to read.

---

## Recommendations beyond the fixes

### Use the classifier that already exists

inbox-pipeline already runs a Mission Pipeline model node — `classify.model@3`,
bound to `qwen2.5-14b` over a loopback OpenAI-compatible endpoint, with a sealed
`classification.balanced` prompt stack. **A local small model is already wired
and working in this system.**

But it is only asked for category, urgency, summary, `requiresHumanAction`, and
confidence. Nothing ever asks a model for `eventKind`, company, posting refs, or
whether a reply is wanted — those are all hand-rolled or hardcoded.

Widening that node's response contract is a far smaller change than building a
new extraction path, and it reuses a binding that is already sealed and pinned.

### Extraction is the natural second panel

The triage panel proved the pattern: several small models with different
personalities, combined by published rules, with abstention as a first-class
answer. Fact extraction from an email is the same shape — one reader for event
kind, one for company and posting identity, one for the reply signal — and it
would give `score_coverage`'s equivalent: an honest measure of how much of the
message was actually understood, rather than a hardcoded `medium`.

That is a better use of the panel machinery than interview-prep, and it sits
directly on this objective's critical path.

### Do not automate the status change

For a welcome email the correct action is `link_message`, not
`transition_application_status`. JobTrack already models this: the transition
proposal's action union has a `link_message` kind with a relation. Nothing
should auto-apply — `apply-transition` requiring a human approval and an
optimistic-lock version is the right design and should stay.

### Fix the silent failure before the loud ones

LOW-1 is the only reviewed path that misleads rather than refuses. It is small,
and it is worth doing first purely because everything else in this system fails
closed and a single quiet exception erodes trust in all of it.

---

## Sequenced plan

Ordered by dependency; each step is independently verifiable.

**1. Widen the facts projection** *(fixes BLOCKER-1, HIGH-2, MEDIUM-5)*
Make all ten `eventKind` values reachable; emit real `replyRequested`, real
`security.risk`, and populated `postingRefs`/`applicationRefs` where present.
Verify: a welcome-email fixture produces `eventKind: application_received` and
`replyRequested: true`.

**2. Carry the sender's name** *(fixes HIGH-1)*
Add optional `source.fromDisplayName` to the facts contract, emit it, and add a
verb that creates or proposes a `company_contacts` row. Verify: after import, a
contact row exists with the sender's name and address.

**3. Fix the silent interview drop** *(fixes LOW-1)*
Emit an evidence entry and a warning on zero-or-many interview matches.

**4. Company correlation** *(fixes HIGH-3)*
Populate `facts.company`; add a `from_domain → companies` fuzzy basis. Verify: a
welcome email from a known company's domain reaches `linked` or a reviewable
candidate rather than `unmatched`.

**5. Ambiguity resolution verb** *(fixes HIGH-4)*

**6. Drive the Apple adapter against a fixture tree** *(works around BLOCKER-2)*
No FDA, no native bridge, no PostgreSQL. Verify: a `.emlx` fixture becomes a
provider-neutral page in process.

**7. Extend the relay past correlation** *(fixes MEDIUM-3)*
Have it propose a transition and a reply draft. Verify: one fixture message
produces a transition proposal and a draft request without operator steps.

**8. Verify the tone/voice references** *(fixes MEDIUM-6)*

**9. End-to-end rehearsal, no send.**
Fixture `.emlx` → adapter → classify → facts → relay → correlate → import →
record-correlation → propose-transition → review → apply (`link_message`) →
draft-issue → runner → draft-record → `outgoing-review`. Stop there.

Deferred, not on this path: MEDIUM-1, MEDIUM-2, MEDIUM-4, LOW-2.

---

## Explicitly out of scope

- **Anything that sends.** The objective ends at a rendered draft awaiting
  review.
- **B08** — the signed native Mail host, drafter, and sender.
- **Cole's tasks 58-61** (Full Disk Access, Automation consent, per-draft
  approval). The fixture-store route exists precisely so none of these are
  needed, and the checklist forbids requesting them before G08.
- **Approval.** `canApprove` staying false and the CLI wiring no signer are
  correct behaviours, not defects.

## What would still be true afterwards

Completing this plan demonstrates the communications path on a fixture mailbox
with a reviewed draft at the end. It does **not** close G07, which additionally
needs the JobTrack-to-Inbox send-request ingress (task 52, currently zero code
on both sides), the PostgreSQL thread and effective-recipient resolver (task
53), the native Mail host, and an independent audit of the released commit.
