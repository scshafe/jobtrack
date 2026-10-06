# Current Work

Updated: 2026-08-01; post-cut addendum 2026-08-06 (first section below)

## Post-cut addendum (2026-08-05/06)

Landed on `main` after the v2.0.0 snapshot this document describes
(`313f16a..a77c205`):

- The v1/v2 outgoing email lanes are mapped and documented
  ([docs/EMAIL_LANES.md](docs/EMAIL_LANES.md)), and the reply views plus
  the workspace Communications section now read the LIVE v2 lane instead
  of the frozen v1 tables.
- A first-class story library: append-only captures, revisions, variants,
  use permissions, facet CLAIMS (what a story demonstrates, as retrieval
  data), and the story-mapping GATE — no mapped story, no submission;
  blocked checks are durable escalation rows under a run key.
  `bin/story-tool.js` is the authoring front door (`story-tool guide`).
- An approval-bound application-submission lane
  (`lib/application-submission.js`): one approval frees one attempt;
  unreconciled or ambiguous attempts fence all retries.
- Suite at the addendum: 576 pass / 0 fail / 4 intentional skips.
- 2026-09-02: inbound email became fabric work for the applicant's agent (`email.review`; `lib/email-agent-lane.js`: inbound-queue, resolve-from-agent, transition-from-agent, mark-handled) — applysim plan L7-B.
- 2026-09-05: the applicant's agent runs on the REAL store — `jobtrack fabric
  dispatch` (lib/fabric-dispatch.js + lib/fabric-briefs.js) staffs the fabric's
  agent work through the engine-backed runner on codex, with durable per-item
  budgets, a per-pass cap and evidence under `~/.jobtrack/fabric/dispatch/`;
  `jobtrack fabric notify` (lib/fabric-notify.js) pushes what newly waits on
  a person to the house ntfy topic. FABRIC_PLAN §8.5 addendum; §9 item 1 closed.
- 2026-09-05: interview and offer stages are fabric work (FABRIC_PLAN I1–I6,
  F1; §9 item 2 closed): deterministic first prep draft, agent-authored
  analysis, human review/selection gates, the outcome after the interview,
  and the offer decision gate — on managed and legacy-import applications alike.
- 2026-09-01: the fabric worker gained a `codex` harness (ChatGPT OAuth,
  no metered spend) beside `claude`, selected per request — see
  docs/V2-ENGINE-PORT.md §4.1.
- 2026-09-05: plan `application-assistance-v1` rolled up — phase 5's clean-store
  smoke (profile → link → cited posting/research → approved assessment →
  rendered, linted, reviewed materials → package → verified uploads → recorded
  manual submission → read-only web) and the edge-by-edge citation of the v1
  architecture live in [docs/ROLLUP-APPLICATION-ASSISTANCE-V1.md](docs/ROLLUP-APPLICATION-ASSISTANCE-V1.md).
- 2026-09-05: status docs reconciled — WORK_REMAINING.md is again the live
  short list (the 2026-08-01 program-ledger snapshot is archived unchanged at
  docs/archive/WORK_REMAINING-2026-08-01.md), DECISIONS.md gained D-027–D-033
  (the story gate, the approval-bound submission lane, the fabric's gates,
  agent rules and harness choice, email correlation's ask-once rule, and the
  lifecycle stages), and the never-read `clarify.secondNudge` policy knob was
  removed (policy document v2; v1 revisions grandfathered, digest-checked as
  written).
- 2026-09-05: the release gate is encoded in the Conductor —
  `scripts/conductor-gate.sh` (install · public-export contract against the
  live-store replica · post-deploy health + Funnel-off) is what Mission
  Control's `jobtrack` enrollment runs on every polled commit; a red gate
  means no deploy. The suite is the mini's `pre-push` gate, not the
  Conductor's: on the laptop it takes 18 minutes against the ten-minute
  per-command cap (docs/VERIFICATION.md, "Encoded in the Conductor").

The applysim drill surface that consumes the gate lives in the applysim
repo (`scripts/setup-drill.mjs` / `finish-drill.mjs` there).

## Mode

```text
Owner/orchestrator: Mission Control/main
Branch: main
Mode: v2.0.0 cut; clean-generation deployment pending its gates
Runtime: Node.js 22.22.0 / SQLite / Docker / Tailscale Serve
```

## Where the system actually stands

The v0.7 deployment was released and operated privately, then **deliberately
retired** under the clean-rebuild directive. Its container, image, Colima
runtime, and Tailnet route 8444 are all absent by design, and the old stack is
never a rollback target. Rollback means stop effects, preserve state and
evidence, diagnose, repair, and resume.

The canonical private store and every backup were preserved and verified
through that retirement (gate G01), so JobTrack's data spine is intact and
unchanged.

## What v2.0.0 contains

`v2.0.0` is the first release cut since `v0.7.0` and carries seventeen commits.

Ten of them were already on `main` unreleased: relational skills evidence,
universal UUID identity, the allowlisted public-profile export and its v2
contract, profile presentation controls, repositories as first-class linked
entities, the project-kind and dependency graph, private-URL scrubbing, the
optional read-only Mission Control drift sync, and byte-identical adoption of
the six provider-neutral outgoing schemas for gate G03.

Seven are the B07 drafting and approval core:

- provider-neutral outgoing contract validation, canonicalization, and the
  separated digest domains;
- additive migrations `2026080101` and `2026080102` creating eleven immutable
  `job_email_*` tables plus the authority guards and receipt state graph;
- eight bounded `email outgoing-*` CLI verbs and the exact owner-side review
  projection;
- a cryptographic callback boundary that rejects hostile values before any
  attacker code runs and refuses outright in a tampered realm; and
- `bin/jobtrack-draft-runner.js`, the standalone out-of-process reply-draft
  runner built on a digest-pinned Mission Pipeline DAG.

See [docs/DRAFT_RUNNER.md](docs/DRAFT_RUNNER.md) and
[docs/EMAIL_OUTGOING_PROVIDER_NEUTRAL.md](docs/EMAIL_OUTGOING_PROVIDER_NEUTRAL.md).

## Verification at the v2.0.0 cut

```text
Node 22.22.0 / ABI 127
425 tests discovered / 421 passed / 0 failed / 4 intentional opt-in skips
npm audit --omit=dev: 0 vulnerabilities
git diff --check: clean
CLI smoke: passed (all eight email outgoing-* verbs present)
pinned Execution Contracts fixtures: verified
pinned Mission Pipeline 1.0.0 vendor tree: verified (the only engine — fabric worker, draft runner, triage panel; docs/V2-ENGINE-PORT.md)
pinned Mission EAL v0.2.0 vendor tree: verified (triage panel resolver)
migration rehearsal on a restored canonical backup:
  233 inherited tables, zero row drift
  11 new tables, all empty
  integrity ok, 0 foreign-key violations, replay idempotent
```

## What is deliberately NOT done yet

No live mailbox, Full Disk Access, Automation consent, deployment, route,
native draft, or send effect is authorized. Specifically:

- no container is built or running, and no Tailnet route is exposed;
- the native Apple Mail host and sender (B08) do not exist;
- the Inbox-side relay and PostgreSQL thread resolver (tasks 52-53) are not
  implemented;
- gate G07 is not closed — it needs the cross-repository halves plus an
  independent audit of this exact commit.

Cole's macOS permissions must not be requested before B08 has a signed
artifact.

## Primary sources

- [OVERALL_GOAL.md](OVERALL_GOAL.md)
- [WORK_COMPLETED.md](WORK_COMPLETED.md)
- [WORK_REMAINING.md](WORK_REMAINING.md)
- [docs/VERIFICATION.md](docs/VERIFICATION.md)
- [DECISIONS.md](DECISIONS.md)
