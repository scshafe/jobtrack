# Reply intent and conservative recovery

This source-only implementation follows the September 7 ApplySim finding: a
failed reply could disappear when the worker recorded only a successful status
transition. It does not repair that historical run, claim its missing receipt,
approve mail, or authorize any live action. Installed skills still require the
Skill Workshop lifecycle; shared brief rollout releases JobTrack before ApplySim.

## Record intent before work

After a successful exact-source read and a real decision that a reply is needed,
record the obligation before drafting. Keep the handling decision separate.
Use the explicitly selected store with both `JOBTRACK_HOME` and `JOBTRACK_DB` pinned.

```sh
jobtrack email reply-intent --message-ref-id MESSAGE_ID --application-id APPLICATION_ID \
  --actor ACTOR --authorship agent --reason 'A reply is required after reviewing the source message.' \
  --idempotency-key INTENT_KEY --json
jobtrack email reply-intents --application-id APPLICATION_ID --json
```

`reply-intent` appends one immutable UUID-bearing intent per message/application
pair. An active application link or latest linked correlation is required. It
does not assert that a reply was drafted or sent. A later `transition`, `none`,
failed recipe, or missing handling decision cannot erase it. There is no automatic
historical backfill from classifier labels, `replyRequested`, failure prose,
old handling decisions, or old send receipts.

`reply-intents` reads intent state and current exact-thread review evidence. Domain
projection is read-only; as with other CLI reads, normal store opening can run
migrations. The projection distinguishes `pending`, `fulfilled`, and `superseded`
from the independent `reconcileOnly` field. A superseded obligation can still
have `reconcileOnly: true`. UUID `replyIntentId` is the new public intent identity;
existing message/application integer arguments retain CLI compatibility.

## Pre-send barrier is not send authority

Drafting, native draft verification and signed approval keep their existing gates.
Only with separately authorized recipient and intent, immediately before the one
external send invocation, commit:

```sh
jobtrack email reply-send-start --intent-id INTENT_UUID --approval-id APPROVAL_ID \
  --actor ACTOR --authorship agent --reason 'Begin one approved external reply attempt.' \
  --idempotency-key SEND_START_KEY --json
```

This appends an immutable UUID-bearing barrier, not a send request, receipt or
approval. Only a newly committed result (`reused: false`) may continue immediately
through the separately authorized existing `send-approved` lane. A replay, crash,
timeout, failed invocation or uncertain handoff must stop for reconciliation.
There is no release, cancel-to-retry or replacement-start command. An unused
barrier is intentionally conservative; elapsed time is not permission to send.

The approval must bind the exact source message. Since outgoing approval contracts
do not independently bind an application, this v1 also requires the intent's
application to be the source's sole active application binding. Each approval and
source message can own at most one intent start. Another approval, another linked
application or changed reply text cannot bypass the barrier. A superseded intent
is vetoed at the last-mile send boundary. Existing per-approval and per-source
fsynced physical-send fences remain authoritative and survive SQLite rollback.

A signed, correlated `sent`/`duplicate` receipt for this intent's own exact start
and approval fulfills it. An old message-level send request with no owned start is
instead `reconcileOnly`, reason `unbound_historical_send_request`: it cannot be
attributed to a new application or used to authorize another attempt. No request,
bare provider identifier, title match, classification or handling decision is a
receipt. Reconciliation remains visible and blocked through supersession, active
link retraction, high security risk, legacy preparation mode, rejection,
withdrawal, decline and archive. Those items have no commands, scheduled retry,
credential readiness probe, or worker dispatch.

## Explicit reviewed supersession, exact-thread v1

Later mail alone never retires an earlier intent. After reviewing both actual
messages, a reviewer may explicitly conclude that the older reply is obsolete.
Both sources must be distinct, strictly ordered by received instant, in the exact
same provider/account/nonempty thread, and still actively bound to the same
application. The successor must already have a non-`none` handling decision.
Read the current candidate and digest first:

```sh
jobtrack email reply-intents --application-id APPLICATION_ID --json
jobtrack email reply-supersede --intent-id EARLIER_INTENT_UUID \
  --superseding-message-ref-id LATER_MESSAGE_ID --expected-evidence-digest CANDIDATE_SHA256 \
  --reviewed-by REVIEWER --authorship human --reason 'The confirmed schedule makes the invitation reply obsolete.' \
  --idempotency-key REVIEW_KEY --json
```

This appends immutable source/binding/handling evidence and review provenance.
The digest is a freshness check, not proof that the reviewer read the bodies;
agents and operators must genuinely perform that review. New bindings, retractions
or changed handling evidence invalidate stale review context. Same titles,
classifier labels, quoted instructions, or a same-thread arrival alone are never
enough. Cross-thread reference-based supersession remains unsupported and must be
held for explicit future domain design; do not guess from copied references.

Every mutation checks the full normalized idempotency payload, including actor,
authorship, reason and expected evidence. Exact replays return the existing UUID
before checking mutable state; changed payloads conflict. Replays never reopen
retired or attempted intent. All three tables have non-null unique UUIDs, foreign
keys and append-only update/delete guards, including after migration replay.

## What remains unresolved

The existing sender can recover an already persisted, verified signed native
receipt and its exact journal claim after database rollback, without another wire
call. The existing authenticated outgoing receipt intake can correlate a valid
signed outcome with its exact stored request. Neither path discovers missing
mailbox evidence or manufactures a native attestation.

When the durable native receipt is absent or malformed (including a provider-only
evidence file without the matching signed receipt), this slice intentionally keeps
the attempt blocked. No general authenticated provider-observation/adoption or
operator retry-release workflow is implemented here. That needs a separately
designed proof contract and explicitly authorized live reconciliation; the
September 7 missing receipt remains unresolved. It must never be repaired by
adding an old failed attempt, clearing journals, or issuing a new approval.

[The provider-proof design proposal](EMAIL_PROVIDER_PROOF_DESIGN.md) separates
authenticated observations from proof of the exact send operation. It has passed
independent design review as an unapproved proposal, not runtime acceptance or
authorization. Issuer trust, causal provider evidence and compatible adoption
contracts remain unresolved; the historical missing-request incident is excluded
from its recommended initial terminal-adoption scope.

Synthetic regression: `node --test test/email-reply-intents.test.js
test/email-agent-lane.test.js test/email-send-live.test.js test/fabric-briefs.test.js`.
Also run ApplySim's `scripts/__tests__/shared-fabric-briefs.test.mjs` against this
checkout. These tests use disposable fixtures and injected transmitters, not mail.
