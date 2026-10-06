# Outgoing email: which lane owns what

- **Status:** current as of 2026-08-06
- **Scope:** the reply/outgoing path only. Inbound correlation (`email
  import-facts`, `record-correlation`, `propose-transition`) is a separate,
  single-lane concern and is not covered here.

Two outgoing lanes exist in this repo. They share no tables, no contracts, and
no code. This document says which one runs, which one does not, and what that
costs today.

## The short version

| | v1 | v2 |
| --- | --- | --- |
| Code | `lib/email-draft-reply.js` | `lib/email-outgoing-v2.js` + `-contracts.js`, `lib/email-auto-approval.js`, `lib/email-send-live.js` |
| CLI | `email draft-reply-{context,issue,record,approve-send,correlate-receipt}` | `email outgoing-{draft-issue,draft-record,draft-receipt,review,review-record,send-request,receipt,invalidate}`, `email auto-approve`, `email send-approved` |
| In `--help` | no | yes (`auto-approve`, `send-approved` and `approval-policy` were missing until 2026-08-06; added in the same change as this doc) |
| Real callers | **one, cross-repo:** inbox-pipeline's send-receipt relay calls `email draft-reply-correlate-receipt` through a fixed-verb boundary (mission-control `RETENTION-REGISTER.md` §2 — deleting it silently breaks that lane); the other four writers have no caller outside `test/` | applysim's live duplex loop; `scripts/synthesize-welcome-draft.cjs` |
| Can it send? | no — emits a dry-run request to a sink | **yes** — `send-approved` transmits via Apple Mail or gog/Gmail |
| Rows in either store | 0 | 0 in the sampled snapshots (applysim's store is wiped between runs) |

**v2 is the production lane.** Every reply actually sent — including the first
full-duplex lifecycle on 2026-08-05 — went through it.

## Tables

Disjoint. This is the important fact in this document.

**v1 owns**

```
job_email_reply_draft_proposals        job_email_draft_reply_requests
job_email_reply_draft_events           job_email_draft_reply_provenance
job_email_reply_draft_style_bindings   job_email_send_request_sink
                                       job_email_send_receipt_correlations
```

**v2 owns**

```
job_email_outgoing_proposals_v3        job_email_approval_receipts_v2
job_email_outgoing_draft_requests      job_email_send_requests_v2
job_email_outgoing_draft_results       job_email_send_receipt_correlations_v2
job_email_draft_receipts_v1            job_email_outgoing_review_events
job_email_approved_contents_v1         job_email_outgoing_invalidation_events
```

(The `_v1`/`_v3` suffixes inside the v2 set are CONTRACT versions, not lane
versions. Frozen contracts get successors, never edits, so the numbers drifted
apart from the lane name.)

## The operator's reply view reads the live lane (closed 2026-08-05)

This section previously documented the gap that motivated this file: both web
projections read only v1 tables, so **no v2 send could ever appear on the
page** — the applysim duplex loop could send four real replies and reach an
offer while `/communications/replies` rendered its empty state.

That gap is closed. `lib/web/read-model/communications.js` now projects the
v2 lane — proposal → review (with approver KIND, human or policy) → approval →
one-send request → correlated receipt — and both surfaces render it:

- `/communications/replies` leads with the live lane; the frozen v1 dry-run
  history renders below it, clearly marked, only when v1 rows exist.
- The application workspace's Communications section shows the application's
  own v2 lifecycle plus the approval-policy mode governing it (`auto (default)`
  unless an operator recorded an override).

The collapse discipline is unchanged and identical for both lanes: recipients
as a domain only, approvers as a kind only (never an id or signer identity),
artifacts as truncated digests, and no prose, subjects, rejection reasons, or
provider payloads. Exact-content review stays CLI-only. Pinned by
`test/outgoing-web.test.js`, `test/reply-lifecycle-web.test.js`, and
`test/email-outgoing-v2-cli.test.js`.

## Why v1 was not deleted

The brief for this pass was to retire v1 where it is reachable only from tests
or dead CLI paths. Its five `draft-reply-*` write actions do qualify: nothing
outside `test/` calls them, and they are absent from `--help`. But deleting
them is not a clean excision:

1. `readReplyLifecycleSummary` lives in the same module and **is** load-bearing
   — it is what `/communications/replies` renders. Removing the writers while
   keeping the reader leaves a page that is structurally incapable of showing
   anything, which is worse than the status quo, not better.
2. `job_email_reply_draft_proposals` has readers in three other modules
   (`email-communication.js`, `email-integration.js`, `application-strategy.js`),
   so the table is not private to the dead path.
3. The v1 contracts under `contracts/email/` are published and frozen. The
   repo's discipline is that published identities get successors, never edits
   or deletions.
4. **One v1 writer has a live cross-repo consumer.** inbox-pipeline's
   send-receipt relay invokes `email draft-reply-correlate-receipt`
   (`correlateSendReceipt`) — so "nothing outside `test/` calls them" is true
   of four of the five actions, not five. The 2026-08-31 dead-code survey had
   to take these writers OFF its deletion list for exactly this reason
   (mission-control `RETENTION-REGISTER.md`, cross-repo trap #4). Any retirement
   moves inbox's relay first.

So v1 stays, documented as dormant. The web projections were re-pointed at v2
on 2026-08-05, which removes reason 1's sting: the v1 reader now serves only
the historical section. Retiring the v1 WRITERS (the five `draft-reply-*`
actions) is now a free-standing decision — nothing operator-facing depends on
them — but it is still a deliberate excision across `email-integration.js` and
its tests, not a drive-by deletion.

## If you are adding an outgoing-email feature

Use v2. The full path, in order:

```
outgoing-draft-issue  ->  outgoing-draft-record  ->  outgoing-draft-receipt
   ->  outgoing-review  ->  auto-approve (or outgoing-review-record)
   ->  send-approved
```

Notes that bite:

- A positive approval **requires a captured draft receipt**
  (`DRAFT_RECEIPT_REQUIRED`), so `outgoing-draft-receipt` is not optional.
- The draft artifact clock must precede the approval, or the lane rejects it as
  `draft_observed_after_approval`.
- One approval yields exactly one send request. Re-sending is fenced by a
  stored sent-receipt lookup in `sendApproved`, not by request idempotency.
- Correlating a send needs a SECOND native receipt key, distinct from the draft
  receipt's.
- The recipient allowlist (`$JOBTRACK_HOME/send-allowlist.json`) sits between
  the authority claim and the wire, and is never widened automatically.

## Related

- `docs/EMAIL_REPLY_DRAFTING_PLAN.md` — the v1 design, historical.
- `~/.mission-control/projects/applysim/docs/LIVE-REPLY-SEND-PLAN.md` — how the
  v2 send edge was built and what it is gated on.
- `~/.mission-control/projects/applysim/docs/LIVE-LOOP.md` — the operating
  protocol the duplex loop runs under.
