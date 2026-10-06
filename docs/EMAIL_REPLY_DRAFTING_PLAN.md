# Historical email reply drafting plan (frozen v0.6/v1 lane)

- **Status:** Superseded historical design; implemented dry-run code is inert compatibility only
- **Date:** 2026-07-19
- **Repo role in the email feature:** the drafting **brain** (context + draft + review + approved-send emit). JobTrack never holds Gmail credentials and never runs a model in-process.
- **Companion docs:**
  - `~/.openclaw/workspace/projects/inbox-pipeline/SHARED_EXECUTION_CONTRACTS_PLAN.md` (shared contract packages)
  - `~/.openclaw/workspace/projects/inbox-pipeline/EMAIL_SEND_EDGE_PLAN.md` (the mailbox send edge)
  - `~/.mission-control/app/mission-control/DESIGN-EMAIL-DRAFTING-HOST.md` (optional agent host)

> Do not use this document as the current architecture and do not implement its provider-host or
> byte-exact-v1 proposals. G03 replaced it with the standalone, provider-neutral,
> content-equivalent design in
> [`EMAIL_OUTGOING_PROVIDER_NEUTRAL.md`](EMAIL_OUTGOING_PROVIDER_NEUTRAL.md). The old
> `draft-reply-*` commands, v1 contracts, and dry-run sink remain frozen and cannot send.

## 1. Goal

Make JobTrack the place where a rich, context-materialized agent **drafts** a job-email reply, a human **approves the exact bytes**, and an **approved-send artifact** is emitted to the Inbox send edge — all while preserving JobTrack's trusted shape (SQLite/WAL, host CLI as sole writer, read-only web, **no in-process model runtime, no credentials**).

## 2. Why JobTrack owns drafting

It already holds the corpus (profile, stories, application record, materials, writing voice) and already has the typed drafting surface:

- `email propose-reply` → `contracts/email/email-reply-draft-proposal.v2.schema.json` (fully typed, closed-enum, `autoSendEligible: false`, `requiresReview: true`),
- `email-tone-decision.v1`, `lib/email-style-policy.js`, `lib/email-communication.js` (deterministic tone recomputation; deviation rejected),
- recipient locked to the source `From`/`Reply-To`, `auto_send_eligible = 0 CHECK` (`lib/email-integration.js:183`).

This feature **upgrades the producer** of that existing contract from a single call to a context-rich agent, and **adds an approved-send emit**. It does not invent a new trust model.

## 3. Non-goals

JobTrack does not run the model in-process (preserve "no generic model runtime"), does not hold Gmail credentials, does not send. It **describes** the draft work, **checks** the result, and **emits** an approved artifact for the Inbox edge.

## 4. New components

1. **`email draft-reply` work kind** — reuse the **application-strategy runner pattern verbatim** (`lib/application-strategy.js`): JobTrack writes a strict declarative `bounded_internal_request` (`proposalOnly: true`, `externalActionsAllowed: false`, route alias, budgets, `forbiddenEffects` incl. `send-email`) and **does not execute it**. An external runner / agent turn (see the MC host doc, or a standalone runner on the local Ubuntu models) runs the model and returns the result via `jobtrack email draft-reply record --input result.json`.
2. **Context materialization** — a typed, **read-only** projection JobTrack builds of `{ profile, voice guide, past comms for this contact/company, application record, relevant stories/materials, the inbound thread reference + Inbox facts, optional company research }`. This is the environment's real job here (context, not authority). Bounded, digested, and pinned into the request's `sourceStateSha256` so a stale corpus fails closed — exactly like the existing strategy source-checkpoint guard (`assertBindingCheckpointDeltaAllowed`).
3. **Optional company research** — the drafting environment may compose corpus-read **plus** a `discovery-egress-broker` capability (JobTrack already has the fail-closed exact-allowlist broker in `discovery-sandbox/`) for fresh company research; never raw internet.
4. **Review → approve exact bytes** — extend the existing reply proposed→approved/rejected state machine (`lib/email-communication.js`) so approval binds the **exact rendered bytes** (draft artifact digest), then emits an `email-send-request.v1` + `approval-receipt.v1`.
5. **Send correlation** — record the returned `email-send-receipt.v1` against the application/thread (append-only), closing the loop.

## 5. Data flow

```
inbound thread + Inbox facts ─┐
profile/voice/apps/materials ─┼─▶ context projection (RO, digest-pinned into sourceStateSha256)
company research (broker) ────┘        │
                                       ▼
  declarative draft request ──▶ EXTERNAL RUNNER / AGENT TURN (local Ubuntu or frontier model)
                                       │  emits email-reply-draft-proposal.v2 + draft-provenance-receipt.v1
      jobtrack email draft-reply record → review → APPROVE exact bytes
                                       │  emits email-send-request.v1 + approval-receipt.v1
                                       ▼  (to Inbox send edge)
                              ◀── email-send-receipt.v1 (correlate, append-only)
```

## 6. Authority & security gates

- The drafting agent gets **broad read** of the corpus (it is the user's own data) + **emit-proposal**, and **zero send / zero apply**. The blast radius of a bad draft is "a human sees a bad draft."
- **CLI-sole-writer preserved**: only the host CLI records results / binds approval; the web tier stays `query_only = ON`.
- **No-credential boundary preserved**: the approved-send artifact is emitted to the Inbox edge; JobTrack never receives Gmail credentials.
- **Per-message human approval is mandatory in v1.** Auto-send is a *separate, later* policy gate, never a default the drafter can reach.
- **Usage-receipt trust**: adopt the shared `UsageReceipt` trust tier so a zero/absent draft receipt is visibly flagged, not silently accepted (`validateUsage` today accepts floor-0).
- **Forbidden-effects unchanged**: the request's `forbiddenEffects` continue to include `send-email`, `submit-application`, `execute`, `external-mutation`; `assertNoEffectKeys` still rejects any executable/tool/credential-shaped payload.

## 7. Contract adoption (see `SHARED_EXECUTION_CONTRACTS_PLAN.md`)

- Promote `email-reply-draft-proposal.v2` / `email-tone-decision.v1` into `@scope/email-pipeline-contracts`; keep JobTrack's per-kind typed domain rows as the binding target (the generic payload is never materialized blindly).
- Ship the **v0.6 skill delta**: the installed `skill/SKILL.md` currently documents **zero** v0.6 verbs, so an agent loading only the skill cannot discover `email draft-reply`. Route the delta through the OpenClaw Skill Workshop per `AGENTS.md`.

## 8. Phasing / effort

| Phase | Work | Effort |
|---|---|---|
| **P1** | Context-projection builder + `email draft-reply` request/record contracts (runner still manual paste-back, like strategy today). | S–M (~1.5 wk) |
| **P2** | Approval-binds-exact-bytes + `email-send-request`/`approval-receipt` emit; wire to the Inbox edge (dry-run). | M (~2 wk) |
| **P3** | Company-research-via-broker composition + v0.6 skill delta. | S (~1 wk) |

## 9. Open decisions

- Drafting agent runs as a **standalone runner** (simplest; recommended for v1) **vs.** on Mission Control's harness (see `DESIGN-EMAIL-DRAFTING-HOST.md`).
- One reply at a time **vs.** a batch review queue for approvals.
- Whether `draft-provenance-receipt.v1` records the corpus source digests inline or by reference.

## 10. Non-negotiables

Propose ≠ apply (the drafter never sends); untrusted inbound content stays inert; the model runs **outside** JobTrack; secrets never enter the store; per-message human approval of exact bytes; receipts carry an explicit trust tier; the CLI remains the sole writer.
