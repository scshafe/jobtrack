# The Fabric — plan of record

- **Status:** design outline, adopted 2026-08-20. Supersedes steps 3–5 of the
  autonomous-cycle build order (steps 1–2 — the submission-lane CLI and the
  applysim `run-cycle` dealer — shipped 2026-08-20 and are load-bearing here).
- **Directive (Cole, 2026-08-20):** the overall system operates as an ongoing,
  never-ending pipeline. At the front, an agent researches and finds
  opportunities and saves them; **everything past that point fires from
  callbacks, crons, or programmatic mechanisms** — no monitor. applysim trials
  mock the front and exercise everything downstream. **Operator gates become
  modular nodes whose behavior is configurable.**
- **Name:** `jobtrack fabric`. Not "pipeline" — the vendored Mission Pipeline
  draft-runner engine already owns that word in this repo.

## 1. The model

One sentence: **a reconciler over the store, not a web of callbacks.**

The store already records every fact and every act as append-only ledger rows;
the CLI is the only writer; every verb is idempotent under an explicit key.
So the fabric never needs queues, schedulers with memory, or event
subscriptions — all of which are state that can be lost or double-fired.
Instead, a loop asks one pure question and acts on the answer:

> Given everything the ledgers say, what is the next required act for each
> in-flight subject, and who is allowed to perform it?

Three consequences, stated as commitments:

1. **Deterministic code decides WHAT happens next; agents only perform acts
   that need judgment.** (The applysim robustness plan's closing boundary,
   adopted here for orchestration itself.)
2. **Crash-safety by construction.** A tick recomputes from the ledger. A
   crashed loop resumes by running again. Two concurrent ticks collide only on
   idempotency keys and expected-current fences that already exist.
3. **One machine, two configurations.** Drills (applysim) and production run
   the identical fabric; only the store, the gate configuration, and the
   approver identities differ. The drill is a rehearsal of production, not a
   simulation of it.

Inbound events (a lifecycle email arrives, a human decision lands, a worker
finishes) are simply store mutations; the next tick notices their
consequences. Cron cadence plus an optional on-demand tick after known
mutations is the whole trigger story.

## 2. The node graph

The pipeline is a graph of **nodes** over two subject kinds. A node is
`(id, subjectKind, kind, precondition, act, executor)` where `kind` is
`work` (does something) or `gate` (decides something), `precondition` is a
pure predicate over store state ("eligible now"), and `act` names the
**existing CLI verb(s)** that satisfy it. The fabric adds NO parallel stores:
every node is satisfied by a verb whose lane already has its own ledger,
concurrency fences, and tests.

| # | Node | Kind | Executor | Satisfying verb(s) | Notes |
|---|------|------|----------|--------------------|-------|
| O1 | `opportunity.triage` | work | agent | `opportunity triage --scorer-kind agent …` | Rationale, dimensions, score, evidence snapshot. Already modeled append-only. |
| O2 | `opportunity.pursue` | **gate** | per config | `opportunity promote` / state → `dismissed`/`watching` | Decision vocabulary: pursue / dismiss / watch. |
| A1 | `application.intake` | work | agent | `capture-posting`, `attach-artifact`, catalog sync, `catalog posting add-skill-requirement` | Posting facts + skill requirements into the store (feeds tailoring). |
| A2 | `application.research` | work | agent | `add-research` | Company research with citations. |
| A3 | `application.assess` | work | agent | `assess-application` | Role fit, risks, evidence, approach. |
| A4 | `application.assessment-review` | **gate** | per config | `review-assessment --decision approved` | |
| A5 | `application.form-recon` | work | agent | `application-form import` | Observe the apply surface's form. |
| A6 | `application.form-review` | **gate** | per config | `application-form review --decision approved` | Eligible when a capture exists. |
| A7 | `application.uncertainty-accept` | **gate** | per config | `application-material accept-uncertainty` | Eligible only when no reviewable form exists. |
| A8 | `application.materials.draft` | work | agent | `application-material context` + `draft` (template lane) | One instance per required kind: resume, cover-letter, each required form answer. Generation doctrine applies (pool + posting keywords). |
| A9 | `application.materials.render-lint` | work | deterministic | `render`, `lint` | Container render + lint gate. Needs Docker; preflight owns the probe. |
| A10 | `application.materials.review` | **gate** | per config | `application-material review --decision approved` | Lint pass is structurally required already; policy mode can add ceilings (e.g., zero editorial warns). |
| A11 | `application.materials.select` | **gate** | per config | `application-material select` | Deliberately a gate: selection is authority, even when the rule is "latest approved". |
| A12 | `application.package` | work | deterministic | `readiness`, `build-package`, bind | Eligible when readiness is green. |
| A13 | `application.submission.propose` | work | deterministic | `application-submission propose --package-id …` | Intent digests the package's exact bytes/answers. |
| A14 | `application.submission.approve` | **gate** | per config | `application-submission approve` | THE outward-facing gate. See §3 safety invariants. |
| A15 | `application.apply` | work | **configurable executor** | claim → drive the surface → `settle` | `agent` (drive the form; applysim today, real surfaces someday) or `manual` (park: Cole submits by hand — today's production reality, expressed as configuration rather than as a missing feature). |
| A16 | `application.verify-record` | work | deterministic | `verify-uploads`, `record-submission --attempt-id` | Digest legs where the destination echoes; the submission fact cites the settled attempt. |
| A17 | `application.watch` | work | deterministic + agent on events | `email correlate`, lifecycle verbs | Standing: inbound mail moves lifecycle; new events surface the lifecycle nodes below (2026-09-05). |
| I1 | `interview.prep.generate` | work | deterministic | `interview-prep generate` | An open interview with no analysis: the deterministic first draft, generated once under a fixed key. |
| I2 | `interview.prep.author` | work | agent | `interview-prep context` + `create --analysis-file` | Only the deterministic draft exists, the current analysis went stale, or the latest was rejected: author an evidence-bound analysis (the store refuses ungrounded skills and foreign evidence). |
| I3 | `interview.prep.review` | **gate** | per config | `interview-prep review --decision approved` | Policy mode approves only authors named by `rules.approveGeneratedBy`. |
| I4 | `interview.prep.select` | **gate** | per config | `interview-prep select --expected-current-analysis-id` | Approved but not current → select it. |
| I5 | `interview.upcoming` | work | standing | — | Prep reviewed and current: a standing note whose wake hint is the interview's end. |
| I6 | `interview.outcome` | work | manual | `update-interview --outcome passed\|failed` | The interview has passed: a person records what happened. |
| F1 | `offer.decision` | **gate** | human or withhold only | `update-offer --outcome accepted\|declined` | A recorded offer with no decision; the decision deadline is the wake hint. No policy mode exists for this gate. |

Terminal: `submitted` (→ watch), `rejected`, `withdrawn`, `closed`,
`dismissed`. A parked gate is not terminal; it is a **surfaced waiting
state** with a named owner.

## 3. Gate nodes — the modular, configurable unit

Every operator gate shares one shape, so gates are one mechanism configured
five ways, not five mechanisms:

```
gate = {
  id,                      // e.g. "application.submission.approve"
  subjectKind,             // opportunity | application (+ sub-subject, e.g. revision)
  decisions,               // the verb's own vocabulary (approved/rejected/…)
  satisfyingVerb,          // the EXISTING lane verb; its ledger stays the source of truth
  mode,                    // from configuration, below
  rules,                   // policy-mode inputs, gate-specific
  constraints,             // hard bounds a policy may never exceed
  notify                   // how a parked gate reaches a human (optional)
}
```

**Modes** (the configurable behavior):

- `human` — the fabric parks the subject and surfaces it (`fabric next
  --parked` is the queue). Only a human's act unparks it. **Fail-closed
  default for every gate.**
- `policy` — the fabric performs the satisfying verb itself, as an honestly
  labeled automated actor (`approver_kind='policy'`,
  actor `policy:fabric/<gateId>@rev<N>`), but only when the gate's `rules`
  hold (e.g., submission: lint green, readiness pinned, digests match,
  surface on the allowlist). The submission lane's schema anticipated exactly
  this — policy approvers are first-class, never masquerading as a person.
- `withhold` — the gate refuses, deliberately: T10 drills
  (authorization withheld) and "pause this lane" operationally.
- `manual` — only for executor-bearing work nodes (A15): park with
  instructions; the human performs the act out-of-band and records it.

**Configuration lanes** (mirroring `strategy_routing_policy_revisions` — the
repo's existing pattern for versioned policy):

- `fabric_gate_policy_revisions` — append-only, one current revision per
  gate id: `(gate_id, mode, rules_json, constraints_json, notify_json,
  set_by, set_authorship, expected_current_revision_id …)`. Changing a gate's
  behavior is an audited act with optimistic concurrency, not an env var.
- `fabric_gate_overrides` — per-subject override (`application 7's
  submission gate: withhold — reason, set_by`), same append-only discipline.
  Precedence: subject override > gate revision > fail-closed `human`.

**Safety invariants** (enforced in code, not documented hope):

1. Absent configuration = `human`. A fresh store is fully parked.
2. **Outward-facing gates** (A14 now; the email send gate when it joins the
   fabric) refuse `mode=policy` unless the current revision was set with
   `set_authorship='human'` AND carries non-empty `constraints_json` — at
   minimum a surface allowlist (drills: loopback/applysim only) and an
   expiry. An agent can never write itself permission to submit.
3. A policy decision records the gate revision that made it, in the acting
   identity — auditable back to the exact rule set.
4. Gate evaluation is pure: same store + same config ⇒ same decision.

## 4. The three moving parts

**`fabric next`** — the pure derivation. Reads the store, applies node
preconditions and gate configuration, returns per subject: eligible work,
parked gates (with owner + notify state), blocked reasons, and for each item
the exact satisfying verb with a stable idempotency-key template. No side
effects; this command IS the pipeline definition, and it is where nearly all
testing concentrates.

**`fabric tick`** — one bounded reconciliation pass, in-store acts only:
executes deterministic work nodes (A9, A12, A13, A16) and fires
policy-mode gates whose rules hold, each through the same lib the CLI uses,
each under its idempotency key and expected-current fences. Returns
`{performed, parked, dispatchable}` where `dispatchable` is the agent-work
list. **Tick never spawns an agent** — jobtrack stays model-free.

**The dispatcher** — host-level, outside the store: takes `dispatchable`
items and spawns stage workers; enforces per-node concurrency caps and
per-subject serialization. Two instantiations of the same loop:

- **Drill:** applysim `run-cycle` — seed → tick/dispatch until every subject
  is terminal or parked-on-`withhold` → score.
- **Production:** a cron/launchd entry running `tick` + dispatch on cadence,
  with parked-gate notifications. (Mission Control's scheduler may later own
  the cadence; the fabric takes no MC dependency.)

**Worker contract.** A stage worker receives only `{storeHome, subjectRef,
nodeId, brief}`; performs two-pass context reads; writes only via CLI verbs
with keys derived `(nodeId, subjectRef, attempt)`; its transcript lands in
the evidence dir; its exit code decides nothing — ledgers judge. Workers are
narrow by construction: the triage worker cannot submit; the drafting worker
cannot approve.

## 5. applysim trials under the fabric

`run-cycle` stops printing a player handoff. Instead it **mocks the front**:
after reset it performs the same verb the real discovery agent would —
`opportunity ingest --source manual --url http://127.0.0.1:<port>/sites/…`
against the dealt posting — then sets the drill store's gate configuration
(all `policy` with drill constraints; T10 = `submission.approve: withhold`;
A15 executor `agent`), and runs the tick/dispatch loop. Scoring is unchanged:
the applysim ledger and the four release blockers, now cross-checked against
the jobtrack attempt/settle ledger.

Blindness becomes **structural**: every worker sees only the store and the
site — exactly a production worker's world. The dealer's secret knowledge
(faults, honeypots) exists solely in applysim's `flow-config`, which no
worker input ever contains. The briefing document survives only as the
standing rules baked into each worker's brief.

## 6. Testing strategy

- **Derivation goldens:** store fixtures → expected `fabric next` output, one
  per node and per interesting precondition edge. This is the bulk.
- **Gate matrix:** every gate × every mode × rules-hold/rules-fail ×
  override precedence; invariant 2's refusal cases (policy without
  human-set constraints) as explicit tests.
- **Tick idempotence:** tick twice, second is a no-op; tick concurrently,
  fences hold (the store's existing discipline does the work).
- **Dispatcher with scripted workers:** the run-cycle pattern already proven
  — fake workers that write ledger-honest acts, including a lying worker the
  scorer must catch.
- **Full drill:** seeded ingest → autonomous run to `submitted` → PASSED,
  and the T10 variant to parked-`withhold` → PASSED (stopping is a passing
  outcome).

## 7. Build phases

- **A — the read model.** Node registry, `fabric next`, gate config lanes +
  `fabric gates list/set/override` CLI. Pure addition; nothing changes
  behavior. *Exit: `fabric next` names the correct next act for every
  fixture, and for the real store's current contents.*
- **B — `fabric tick`.** Deterministic executors + policy-gate firing +
  parked queue. *Exit: a prepared drill-store application advances
  draft→packaged→proposed by ticks alone, with gates parked.*
- **C — the dispatcher, drill mode.** run-cycle seeds the mocked front and
  loops tick/dispatch with real stage workers for O1/A1–A5; materials arrive
  pre-provided this phase. *Exit: first monitorless drill: ingest → scored,
  including one T10 withhold run.*
- **D — materials workers.** A8–A10 live in-cycle (generation doctrine,
  real renders, lint, policy review). *Exit: posting URL in, scored
  submission out, resume generated fresh from the pool.*
- **E — the standing system.** Cycle report cross-ledger asserts + wave
  runner; then the same fabric on a production cron against `~/.jobtrack`
  with every gate `human` and notifications on. *Exit: Wave 1 runs unattended
  overnight; the real store's parked queue is the daily driver.*

## 8. Defaults proposed (Cole can re-configure any of these per gate, that's the point)

| Gate | Drill store | Real store |
|------|-------------|------------|
| O2 pursue | policy (score ≥ threshold, no hard blockers) | human |
| A4 assessment-review | policy | human |
| A6/A7 form gates | policy | human |
| A10 materials review | policy (lint green, zero mechanical) | human |
| A11 select | policy (latest approved) | human, revisit later |
| A14 submission approve | policy (loopback allowlist) / withhold for T10 | **human — policy requires your explicit constrained opt-in** |
| A15 apply executor | agent | manual (until real-surface driving is a deliberate decision) |

## 8.5 Implementation record

- **Phase A shipped 2026-08-20** (`lib/fabric.js`, `lib/fabric-command.js`,
  `test/fabric.test.js`): the node registry (O1–O2, A1–A17), `fabric next`
  (with `--parked` and per-subject filters), the gate config lanes
  (`fabric_gate_policy_revisions` / `fabric_gate_overrides`, append-only with
  expected-current concurrency), `fabric gates list/set/override`, and all
  §3 safety invariants enforced with tests (outward-gate refusals, override
  precedence, fail-closed defaults). The golden walk drives a real store from
  `opportunity ingest` through recorded submission, asserting the derivation
  names the correct next act at every stage; against the real store the first
  run surfaced 11 untriaged discovery opportunities and correctly excluded
  every legacy-import application. One deviation from the outline: per-subject
  overrides on the outward gate may only NARROW (policy-via-override is
  refused with `OUTWARD_POLICY_REQUIRES_REVISION`) — opening automation
  requires a full, constrained, human-set revision.
- **Phase B shipped 2026-08-20** (`fabric tick`): one bounded pass executes
  deterministic work nodes (render-lint, package, propose, verify-record) and
  fires policy-mode gates, each in its own savepoint (a failing item rolls
  back cleanly and retries next tick), returning `{performed, held, parked,
  dispatchable, failed}`. Rules AND the outward gate's constraints are
  re-evaluated at FIRE time, fail-closed: an unrecognized rule or constraint
  key refuses. Every policy act is attributed
  `policy:fabric/<gateId>@rev<N>` — auditable to the config revision that
  allowed it. Process capabilities (`renderLatexMaterial`, `buildPackage`,
  `reviewAssessment`, signing `home`) are injected by bin; a missing
  capability degrades to held/dispatchable, never a crash. Refinements
  discovered while building: a current FAILING lint re-surfaces the DRAFT
  (content problem), never a re-render (churn); `verify-record` performs the
  recording half itself but classifies as dispatchable until the apply worker
  has verified the delivered bytes; propose takes its surface from the
  application's job URL. Exit test: a prepared application advances
  draft→…→recorded submission by ticks alone, every act attributed.

- **Phase C shipped 2026-08-20** (the dispatcher — applysim
  `scripts/fabric-drill.mjs` + `run-cycle --mode fabric`): run-cycle seeds the
  mocked discovery front (`opportunity ingest` at the dealt posting), sets the
  drill store's gates (`--authorization grant` = a human-attributed
  loopback-constrained policy revision on the outward gate, mirrored into the
  run's `authority.json` as a fabric-grant record with NO
  `authorizedSubmissions` list — the scorer's contract for "authority recorded
  elsewhere"; `--authorization withhold` leaves the empty list, the T10
  shape), then loops `fabric tick` + one narrow stage worker at a time, with
  dealer-side verification of RECEIVED upload bytes unblocking verify-record.
  Blindness is structural: workers get only `{store, site, item}` briefs. The
  exit criterion ran live: **the first monitorless drills** — grant: ingest →
  triage → promote → research → assess → generated-payload drafts → real
  container renders → lint → policy gates → package → propose → constrained
  policy approval → the apply worker driving the faulted-prefill flow →
  settle → dealer verify → recorded submission → scored PASSED (~9s);
  withhold: full arc to the boundary, parked, zero approvals/attempts
  anywhere, scored PASSED. Workers in these runs are the deterministic
  scripted stand-ins (`harness/integration/scripted-fabric-worker.mjs`,
  opt-in integration tier); the headless-claude worker command is wired as
  the default and gets its live proof in Phase D, where drafting genuinely
  needs judgment. Findings that changed code: `blocked` tick items now carry
  a flag so dispatchers never staff reconciliation blind; real-profile
  bullets carry Unicode arrows that break extraction parity (worker
  transliterates; a D-phase brief rule); the review surface requires a street
  address the profile does not record — a real worker must escalate that, and
  the profile gap is worth filling.

- **Phase D shipped 2026-08-21** (live agent workers): worker staffing became
  `--workers claude|scripted|mixed` (mixed = a fresh headless claude session
  per judgment node, `APPLYSIM_WORKER_MODEL` selects the model; apply stays
  scripted until the profile records a street address — an honest agent must
  escalate that). Workers get a `jobtrack` PATH shim and scratch cwds outside
  the run dir, so blindness holds structurally. **The first fully monitorless
  live-agent drill scored PASSED** (`drill-2608210046-5ba189d5`, ~14 min,
  6 workers): sonnet agents did triage, research, assessment, and BOTH
  document drafts under the generation doctrine — the resume passed the lint
  gate on the first render, tailored to the posting's asks from the real
  profile pool. Best finding of the phase: handed a contentless "posting" in
  an earlier take, the triage agent scored it 0.3, chose watch, and the
  pursue gate held — the honest refusal working live; the fix was authoring
  the missing posting fixture (`DRILL_POSTING`), not softening any gate.
  Hardening found by fire: a dynamic-import deadlock in the CLI path
  (fabric-drill must not import run-cycle), and SQLITE_BUSY contention
  between workers and the server's company-side runner (retry-on-busy at
  the jt seams — the drill store has concurrent CLI writers by design).

- **Phase E shipped 2026-08-21** (the standing system):
  (a) `applysim scripts/cycle-report.mjs` — the cross-ledger integrity report
  every fabric drill now runs after scoring: backend acceptances correlate to
  lane attempts by session id through the settle's external reference,
  RECEIVED upload bytes must equal the selected render's sha, the recorded
  submission must cite an accepted attempt, acceptances must be claimed,
  withheld drills must show total silence, and drill approvers must be
  `policy:fabric/...` actors — a scorer PASS with disagreeing ledgers becomes
  `failed-crosscheck`, exit 1.
  (b) `applysim scripts/run-wave.mjs` — waves run unattended, one summary,
  one campaign-log row per drill. **Wave 1 ran unattended** as a machinery
  wave: five random deals, every one carried through generated materials to a
  policy approval (6 workers each); all five stalled honestly at the scripted
  apply worker on unfamiliar renderers — after which the worker learned to
  settle `failed` rather than abandon a claim (the ambiguity fence held
  exactly as designed in all five).
  (c) The production heartbeat: `scripts/fabric-cron.sh` +
  `deploy/launchd/com.cole.jobtrack-fabric.plist`, installed and running
  hourly against `~/.jobtrack` with every gate at its human default —
  `~/.jobtrack/fabric/queue.md` is the operator queue (11 opportunities
  awaiting triage on day one), `tick-log.jsonl` the heartbeat history.
  Remaining before honest-agent campaign waves: the claude apply worker
  needs the profile's street address recorded, and worker briefs for the
  renderer/flow families beyond resume-first.
- **Addendum 2026-08-21 (both closed):** Cole recorded his postal address
  (`profile set-contact --address-*`, new contact columns at personal
  sensitivity), and the apply brief became the full non-classic protocol —
  renderer notes (js is progressive enhancement: parse and POST the real
  form; the server's word is the only validation), flow families (gate-first
  behavioral answering with the dealer-provided gate file and run key, the
  outbox mailbox for email codes, knockouts as real outcomes, external
  handoffs, self-ID decline-by-default, repeatable groups, adversarial
  content as data), backend weather (rate limits, UNKNOWN_COMMIT_STATE,
  duplicate → settle `duplicate`, strict-review step bounces, slow parse,
  closed jobs), and the settle-outcome mapping. An honest escalation is now
  a terminal, SCORED drill outcome (`escalated`) — never a retry loop.
  `--workers claude` is the honest-agent mode, unblocked. **Proven live the
  same day** (applysim drill-2608210334, PASSED): full claude staffing on the
  sectioned behavioral flow — both documents generated (the resume lint-clean
  on its first render under the band recalibrated to 2200–2800 by a second
  real-render data point), and the apply agent ran the story gate first,
  found 18/29 required behavioral prompts unmapped, never touched the
  surface, settled honestly, escalated — 48 gated questions, 48 gate rows,
  crosscheck consistent. The gate's blocked direction now has live
  honest-agent evidence; the mapped direction awaits the 18-story authoring
  backlog delivered to Cole.
- **Addendum 2026-09-01 (v2 engine):** the runner below now targets the
  Mission Pipeline **v2 node-graph engine** (1.0.0, `vendor/mission-pipeline`):
  one sealed one-node graph per worker turn, a consumer-owned `SqliteUnitStore`
  (`lib/engine-v2`) over the engine's executable specification, replay from the
  unit journey. Same request/result contracts, same exit codes, same taxonomy.
  Accepted by the real-claude drill `drill-2609012047-c32fab5e`; the v1 engine
  tree and the v1 runner were retired the same day — `docs/V2-ENGINE-PORT.md`.
- **Addendum 2026-08-21 (engine-backed workers):** every claude worker turn
  now runs through the byte-pinned vendored Mission Pipeline engine instead
  of a raw `claude -p` spawn. New in jobtrack: `lib/fabric-worker-runner/`
  (the `jobtrack-fabric-worker-request.v1` → `…-result.v1` single-node
  pipeline: safeParse-shaped contracts, an agent-step spec whose per-run
  brief rides as a digest-verified input artifact, and a claude executor
  that races the engine's deadline with an AbortSignal) and
  `bin/jobtrack-fabric-worker.js` (stdin request → stdout result document;
  exit 0 completed · 4 failed · 5 timed_out · 6 infra_error · 2 bad
  request). What the engine buys: durable evidence per turn in
  `<JOBTRACK_HOME>/pipeline-evidence.db` (attempts, typed failures, dead
  letters, usage receipts with the frozen non-silent-zero floor for
  telemetry-less turns), idempotent replay (re-running a requestId answers
  from committed evidence without spawning a second agent), and the frozen
  taxonomy — `failed` is terminal ("the agent ran and produced junk";
  re-briefing is dispatcher judgment), `timed_out`/`infra_error` retry
  within a bounded budget and keep their typed status when exhausted.
  applysim routes all claude staffing through it (`pipelineWorkerCmd`, the
  default; `APPLYSIM_WORKER_RAW=1` is the raw-spawn escape hatch), with
  requestIds unique per dispatch so a re-brief is a fresh engine run and
  replay protection guards only accidental re-runs of the same dispatch.
  Evidence lands beside whichever store the drill uses. Proven by 6 new
  jobtrack tests (replay, terminal-vs-retryable, contract rejection, bin
  exit codes), an applysim cross-repo round-trip test through the real
  runner bin, and a live engine-backed drill (see DRILL-CAMPAIGN-LOG).
- **Addendum 2026-09-02 (email as fabric work — applysim plan L7-B):** the
  applicant's inbox is now fabric work. `lib/email-agent-lane.js` derives the
  queue from the relay's recorded correlations (an ambiguous one is work too:
  the applicant resolves it with `email resolve-from-agent`), the fabric emits
  one `email.review` agent item per message (`deriveInboundEmail`, after the
  standing watch), and the agent acts through the existing lanes — replies via
  the outgoing recipe (`scripts/synthesize-welcome-draft.cjs --kind agent
  --body-file`, then auto-approve, then send-approved), status changes via
  `email transition-from-agent` (assembles the proposal from the stored
  correlation; always requires review, which the agent performs under the
  arc's policy) → review → apply — and retires the item with `email
  mark-handled` (table `job_email_handling_decisions`, one decision per
  message/application, idempotent). Nothing new transmits or approves.
- **Addendum 2026-09-01 (codex harness):** the worker request grew an
  optional `harness` field (`claude` | `codex`). `codex` runs the turn as a
  headless `codex exec --json` session on the operator's ChatGPT OAuth login
  (no metered spend) through the SAME engine port, evidence tables, and
  replay rules — `lib/fabric-worker-runner/codex-executor.js`, proven by
  `test/fabric-worker-codex-executor.test.js` over a fake spawn. applysim
  selects it with `--worker-harness codex` (its new default) and pins the
  model per harness. Reason: the operator ruled that drills continue on local
  models plus Codex OAuth only — no Claude API spend.

- **Addendum 2026-09-05 (the production dispatcher — Phase E's missing
  half):** the real store had eleven discovered opportunities waiting at
  `opportunity.triage` since 2026-07-17 while the hourly cron performed only
  deterministic ticks, because the dispatcher lived in applysim. It now lives
  here: `jobtrack fabric dispatch` (lib/fabric-dispatch.js) is one bounded pass
  — tick, staff the first eligible agent item this dispatcher staffs, tick
  again — through the engine-backed worker runner on the codex harness by
  default, with a per-pass worker cap (`--max-workers`, default 3), a DURABLE
  per-item budget across passes (`<home>/fabric/dispatch-budgets.json`; 2
  attempts, 4 for drafts; `--reset-budgets`), an overlap lock, evidence under
  `<home>/fabric/dispatch/<pass>/workers/` and `dispatch-log.jsonl`, and honest
  outcomes (quiescent · capped · waiting · parked · stalled · failed · dry-run)
  mapped to exit codes 0/3/1 the way applysim's arc loop does. `--dry-run`
  lists what a pass would staff. The briefs are jobtrack's own
  (lib/fabric-briefs.js): the store-bound nodes — triage, intake, research,
  assess, materials.draft, email.review, email.reply — with production
  wording (the store, not a drill store; intake/research may GET public
  pages of the posting and the employer's own site, never submit or log in).
  The apply node is NOT staffed: on the real store it is `manual` until the
  operator decides otherwise (§9.3). applysim's drill dispatcher keeps its
  drill-only parts (seed, gates, the apply worker, claims, scoring). The shared
  brief follow-up is implemented below (2026-09-09).
  Production wiring: the `fabric daemon` runs `fabric dispatch --notify` as
  its pass command on the real store (LaunchAgent
  `com.cole.jobtrack-fabric-daemon`), beside the hourly queue.md cron.

- **Addendum 2026-09-05 (interview and offer stages):** the lifecycle after
  submission is now fabric work (I1–I6, F1 in §2). Derivation reads the
  store's own `interviews`, `interview_prep_*` and `offers` rows; every act is
  an existing interview-prep or offer verb; the fabric takes a clock
  (`deriveFabricNext(db, { now })`) so time-based items — the outcome after
  the interview's end, an overdue offer deadline — are testable. The review
  and selection gates take policy mode (review needs `approveGeneratedBy`);
  the offer gate is human-or-withhold by construction. The first real-store
  pass after this landed derived nothing new: no interviews or offers were
  recorded there yet; the next confirmation email that creates one puts
  `interview.prep.generate` on the very next tick.

- **Addendum 2026-09-09 (shared worker instructions):**
  `lib/fabric-briefs.js` exports `briefBodyFor(item, ctx, extras)` alongside
  its existing schema, staffed nodes, full production brief and helper exports.
  The body is pure text generation: no imports, store opening, network or
  provider authority. Production and Applysim consume the exact same bodies
  for every currently staffed store-bound drill node. `ctx.jobtrackRoot`
  resolves recipe paths; `extras.dispatch` retains retry-safe material keys.
  Unknown nodes and `application.apply` return null. Applysim retains its own
  envelope, explicit staffing list, site-only rules, dealer machinery and
  unchanged apply-body template; sharing never staffs production application
  submission or adds interview staffing to the drill.

  The consumer lazily loads the module from the same `JOBTRACK_ROOT` as its
  CLI, checks the v1 schema/body/helpers contract and node coverage before
  seeding, configuring gates or ticking. A missing CLI/module or incompatible
  contract is an explicit error, not a copied fallback. The full-cycle preflight
  checks it before reset/deal/server startup too. Every child worker receives
  the same resolved checkout, Node binary and dealer-bound store. It remains import-safe
  without a sibling checkout; machinery tests use an explicit synthetic
  provider, while real-body parity tests require the checkout. The read-before-
  any-email-decision safeguard from Applysim is preserved in the shared body,
  as are JobTrack's current resume/editorial and chronology-safe retry rules.

  Smoke (synthetic fixtures only, no live mail or model calls):
  `node --test test/fabric-briefs.test.js` in JobTrack, then
  `node --test scripts/__tests__/fabric-drill.test.mjs scripts/__tests__/shared-fabric-briefs.test.mjs scripts/__tests__/run-cycle.test.mjs`
  in Applysim. Repeat the latter with `JOBTRACK_ROOT` set to a nonexistent
  absolute path to exercise standalone unit operation (real-contract cases skip).
  This is a local implementation record, not a deployment or live-arc receipt.
  Release the JobTrack source interface before updating the Applysim consumer;
  restart any standing consumer process so Node reloads the module.

  Verification: Applysim's default suite passed 638/638; JobTrack's targeted
  brief/dispatcher/tick/fabric regression batch passed 22/22. The Applysim
  three-file smoke passed 52/52 with the checkout, and 44 passed / 8 expected
  skips without it. Independent review found no remaining blockers after
  checking pre-reset refusal, CLI/source consistency and child runtime pins.
  No live/provider tests, push or deployment were performed.

## 9. Open items

1. ~~**Notification surface** for parked gates in production~~ — shipped
   2026-09-05 as `jobtrack fabric notify` (lib/fabric-notify.js): the queue is
   diffed against the last notified snapshot and what is NEW — gates parked on
   a human, work parked as manual, blocked items, dispatch budgets a pass
   exhausted — is pushed once to the house ntfy topic (`JOBTRACK_NTFY_TOPIC`,
   base `JOBTRACK_NTFY_BASE_URL`); an undelivered push is not marked told.
2. ~~**Interview/offer stages** (post-`submitted` lifecycle) join the graph as
   A17 event-driven extensions~~ — shipped 2026-09-05 as I1–I6 and F1 above
   (`deriveInterviews`/`deriveOffer` in lib/fabric.js): interviews and offers
   are events on ANY live application, including legacy-import ones a person
   records by hand, so the preparation half's "managed only" rule does not
   hide them. A tick generates the deterministic first draft; the dispatcher
   staffs `interview.prep.author`; review, selection and the offer decision
   park for a person; the outcome is recorded by a person after the interview.
3. **Real-surface driving** (A15 `agent` outside applysim) is a policy
   decision with its own safety review, not a technical unlock; the fabric
   expresses it as configuration so the decision stays visible.
