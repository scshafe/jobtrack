# JobTrack Work Remaining

Updated: 2026-09-09, with local implementation evidence below; no deployment implied.

This is the live short list: what is still open, who can close it, and where
the source of truth for each item lives. The 2026-08-01 program-ledger
snapshot that used to live here (96 canonical tasks, batches B05–B16, gates
G01–G15) is archived unchanged at
[docs/archive/WORK_REMAINING-2026-08-01.md](docs/archive/WORK_REMAINING-2026-08-01.md).

## What became of the August ledger

- **The email program no longer runs through a native Apple Mail host.** Mail
  enters through the inbox pipeline's IMAP lane and reaches JobTrack as
  versioned proposals over an account-scoped relay
  ([docs/EMAIL_PIPELINE_ROLLOUT_PLAN.md](docs/EMAIL_PIPELINE_ROLLOUT_PLAN.md),
  [docs/EMAIL_LANES.md](docs/EMAIL_LANES.md),
  [docs/DESIGN-EMAIL-CORRELATION.md](docs/DESIGN-EMAIL-CORRELATION.md)).
  The native-host batch (B08) and its permission tasks (58, 59) are retired
  with it; an IMAP lane needs neither Full Disk Access nor a Mail extension.
- **The supervised round trips happen as applysim drills on the inbox
  pipeline** (applysim `docs/DRILL-CAMPAIGN-LOG.md`): engine-backed
  submissions on 2026-08-21 and 2026-09-01, the five-deal wave on 2026-09-02,
  and arc 3's calendar scheduling. Batches B13/B14 as the ledger framed them
  are not coming back.
- **The release train is the Conductor.** `main` is polled every five
  minutes, deployed into the laptop app stack and verified at
  `https://jobtrack.example-tailnet.ts.net/healthz`. The route the ledger
  held for B13 (tasks 45/78) is live and tailnet-only through the
  `ts-jobtrack` sidecar; Funnel is not enabled.
- **Hygiene gaps 5, 6, 8 and 9 are closed.** The suite runs on Node 24.18.0
  (754 tests, 750 pass, 4 intentional skips) and gates every push from the
  mini, the Conductor gates every deploy on the standing gates, only `main`
  and one worktree remain, and the B07 repair is merged as v2.0.0. Gap 7 is
  below.
- **The Mission Control plan `application-assistance-v1` is complete**
  ([docs/ROLLUP-APPLICATION-ASSISTANCE-V1.md](docs/ROLLUP-APPLICATION-ASSISTANCE-V1.md)).
- The ledger's G07 condition (an independent audit of commit `b81cc73`) is not
  evidenced in this repository; nothing here claims it.

## Where the system stands

The operational counts and pending decisions below are carried from existing
records. September 9 source-only verification did not re-read personal stores
or mailboxes to refresh that live-state snapshot.

- **Store.** `~/.jobtrack` on the mini; the CLI is the only writer. The
  standing daemon `com.cole.jobtrack-fabric-daemon` runs `fabric dispatch
  --notify` on it: agent work is staffed on the codex harness within durable
  budgets, and whatever newly waits on a person reaches the ntfy topic
  (`JOBTRACK_NTFY_TOPIC`). Eleven live opportunities are triaged and parked at the
  pursue gate; four legacy demo applications carry no fabric work.
- **Web.** Read-only, loopback-bound inside the container, tailnet-only
  through the sidecar; GET and HEAD only.
- **Email.** Correlation R1–R5 are shipped. The applysim lane
  (university account → `~/.jobtrack-applysim`) is placed and proven. The
  production relay is not switched on; one stranded proposal waits for its
  first run.
- **Gates.** Every gate on the real store is `human`; submission approval
  requires Cole's explicit constrained opt-in; `application.apply` is
  `manual` (DECISIONS.md D-029).

## Remaining work

### Decisions only Cole can make

1. **Pursue or dismiss the eleven triaged opportunities.** `jobtrack fabric
   next --parked` is the queue; each decision unparks intake for that record.
2. **Switch on the production relay** (personal Gmail →
   `~/.jobtrack`). Applysim's plan (`PLAN-APPLYSIM-ON-INBOX-PIPELINE.md`, L4)
   records that the first run delivers the one stranded proposal and that the
   account-scoped claims keep the two lanes from racing.
3. **Provision the second company mailbox** that R5's Stage 1 scenarios (c)
   and (d) need (DESIGN-EMAIL-CORRELATION §8). They are blocked on the
   mailbox, not on code.
4. **Decide real-surface driving** (FABRIC_PLAN §9.3). It is a policy decision
   with its own safety review, expressed as gate configuration so it stays
   visible; until it is made, `application.apply` stays `manual`.
5. **Delete or keep the four legacy demo applications** in the real store.
6. **Apply or reject Skill Workshop proposal `jobtrack-20260717-32b0409b43`.**
   It is still recorded as pending (docs/TEMPORARY_STEWARDSHIP.md) and must be
   rebuilt from the released CLI surface before any apply.

### Engineering

1. ~~**Encode the release gate in the Conductor manifest** (hygiene gap 6).~~
   Done 2026-09-05 for the standing gates: the enrollment gates every polled
   commit on `scripts/conductor-gate.sh` (install, public-export contract
   against the live-store replica) and re-checks health plus Funnel-off after
   the deploy ([docs/VERIFICATION.md](docs/VERIFICATION.md), "Encoded in the
   Conductor"). The full suite now also gates Conductor: on 2026-09-10 at
   05:50:53 UTC the explicitly authorized, independently reviewed enrollment
   update inserted `test` between install and export, preserving every other
   manifest field. It remains the mini's pre-push gate too. The intended source
   release must pass the actual enrollment and deployed-revision verification;
   Conductor's exact-commit run is its release witness, not the activation alone.
   Fixture adoption, isolated laptop timing and an audited synthetic
   Conductor-style detached-worktree run are complete (2026-09-09):
   `test-support/migrated-store.js` initializes one synthetic template per
   process and copies it into isolated stores across ordinary application,
   material, interview, fabric, profile, email and web fixtures, using flat
   or nested layouts to preserve ownership and cleanup. Eight setup operations measured 8.30 s
   fresh versus 1.08 s with template initialization included; this is setup
   evidence. The final local suite passed 917 tests with seven opt-in skips
   in 56.1 s (initial slice: 128.0 s). The corrected source snapshot passed
   914 tests with ten skips on the laptop in 472.89 s wall, 127.11 s below
   the cap. The later combined candidate passed 931 tests with ten expected
   skips through Conductor's actual command executor in 480.17 s wall, 119.83 s
   below its cap, in a fresh synthetic detached worktree using the scheduler's
   Node 24.18.0 and `umask 0022`. Source/Git modes and store isolation were
   verified before/after. Deliberate cold-init/migration tests and all production
   command migrations remain intact. This reproduction did not itself enable a
   production gate, prove the real dependency cache, or establish worst-case
   runtime. Gate activation is now recorded separately above; see
   [docs/TEST_STORES.md](docs/TEST_STORES.md) for regression/review evidence
   and the reproducible benchmark.
2. ~~**Run the seven opt-in container cases deliberately**~~ — verified
   2026-09-09 against synthetic fixtures with the unchanged pinned renderer.
   `npm run test:containers` runs all seven, sequentially across five files:
   **29/29 passed, zero skips**, in 11.25 s, repeated against the final combined
   source candidate in 13.09 s wall. The cases cover the containerized worker's host-listener denial, the fixed
   renderer container compiling the resume and cover-letter fixtures without
   network, its rejection of active PDF actions and unsafe URI schemes,
   the host timeout that forcibly removes the renderer container, the v3/v4
   dense template renders (including v4 links), and the real-PDF editorial
   lifecycle. The discovery test owns a unique Compose project and checks its
   cleanup; the timeout check targets only its own renderer. An explicit opt-in
   without Compose now fails rather than silently skipping. The editorial
   fixture pins both store paths and verifies that requested changes route to
   drafting with the exact approved-render/reviewer evidence, preserving existing
   approval history. Repeat this acceptance before any release that changes
   discovery egress or the renderer; ordinary-suite skips are not acceptance.
3. **Finish R5's live matrix** once decision 3 above provides the mailbox.
4. ~~**Make applysim's drill dispatcher consume jobtrack's briefs**~~ —
   implemented 2026-09-09. `lib/fabric-briefs.js` exposes a pure shared body;
   Applysim retains its drill envelope, site restrictions and apply worker,
   and rejects missing/incompatible shared contracts before store actions.
   Synthetic contract tests cover both checkouts and missing-checkout unit
   operation. Coordinated source rollout remains separate: update JobTrack's
   shared interface before its Applysim consumer (FABRIC_PLAN §8.5 addendum).
   Applysim's reviewed commit `873d725` is local only: its push remains held
   pending authorization for the mail-capable company-daemon rollout.
5. **Interview and offer stages on the real store** have shipped as fabric
   work (FABRIC_PLAN I1–I6, F1) but have not yet run against a real interview;
   the first real invite is their acceptance.
6. ~~**Confine scoped CLI calls to their selected stores**~~ — source fixes
   implemented and independently reviewed, 2026-09-09. The export gate validates
   its original source before copying and pins both store variables; three
   synthetic regressions preserve the read-only replica and unrelated sentinels.
   Applysim now pins the database for its already-scoped dealer, workers,
   preflight/reset, draft synthesis, metrics, proof reads, and generated ingest
   and story-gate commands. Its focused batch passed 117/117; independent reruns
   passed the 111-test core plus six printed-recipe tests. The final Applysim
   default suite passed 643/643 with no skips in 20.44 seconds. No live workflow,
   profile import, credential, consent, store-selection, or enrollment change
   was used to verify these fixes. Source rollout remains separate.
7. ~~**Preserve failed reply intent and retire obsolete replies explicitly**~~ —
   bounded source implementation verified, 2026-09-09. Immutable reply intent
   survives transition-only handling; one exact-approval pre-send barrier stays
   reconcile-only without its authenticated receipt. Explicit digest-bound
   same-thread supersession cannot erase uncertain-send work, including after
   archive, retraction or high-risk classification. Cross-application ambiguity
   and unbound historical sends stay blocked. Independent focused verification
   passed 57/57 (13 new regressions); Applysim shared-body parity passed 8/8.
   The combined JobTrack default suite passed 934/941 with seven opt-in skips
   and no failures in 58.04 seconds wall.
   See [docs/EMAIL_REPLY_RECOVERY.md](docs/EMAIL_REPLY_RECOVERY.md). No historical
   records, installed skill, mail or live run was changed.
8. **Define and verify missing-provider-proof reconciliation.** The sender can
   recover its existing verified signed receipt after database rollback; this
   does not cover an absent/malformed native receipt or adopt provider-only
   observations. A reviewed proof/adoption contract and separately authorized
   live reconciliation are still required. Cross-thread supersession and any
   operator retry-release design also remain unsupported. The September 7
   missing receipt and Applysim clean-repeat acceptance are not closed by item 7.
   An independently reviewed, **unapproved source-only design proposal** now
   separates observation from causal send proof and excludes claim-only/lost-request
   history from initial terminal adoption:
   [docs/EMAIL_PROVIDER_PROOF_DESIGN.md](docs/EMAIL_PROVIDER_PROOF_DESIGN.md).
   Issuer trust, real operation-to-resource evidence, provider/MIME semantics,
   adoption/rollback contracts and authenticated review remain explicit decisions;
   no new proof runtime or receipt type is implemented.

### Deferred product backlog

Explicit follow-ups, carried from the August snapshot, still not release
blockers unless Cole expands scope:

- A separate reviewed materialization command from an accepted discovery
  intent to the opportunity inbox.
- Durable discovery-source rate state, leases, jitter and backoff before any
  recurring discovery scheduler (DECISIONS.md D-013).
- Production discovery images pinned by digest, a deployment seccomp profile,
  and an external host egress proxy or firewall.
- Removal of legacy compatibility columns, or table rebuilds, only after every
  caller has migrated and copied-live verification passes (D-008).
- The cross-domain timeline follow-up view.
- Degree/field/language identity normalization, re-scoped first; project and
  repository link normalization has since advanced.
- A managed, reviewed corpus of Cole-authored prose and per-axis
  communication-style confidence, if wanted.
- The real story library stays populated only from stories Cole actually
  tells (D-027).

### Non-goals

LinkedIn crawling, an in-process autonomous model runtime, autonomous browser
form submission, broad mailbox mutation, and an inline PDF serving route are
deliberate non-goals, not missing deliverables.

## Completion rule

A release is complete when the standing gates in
[docs/VERIFICATION.md](docs/VERIFICATION.md) hold, the suite is green on the
pinned toolchain, the Conductor's verify stage passes on the deployed
release, and every decision above is either made or explicitly deferred by
Cole. The archived ledger's rule (all 96 tasks, G01–G15, the B16 audit) is
history, not the bar.

## Primary evidence

- [OVERALL_GOAL.md](OVERALL_GOAL.md) — the durable outcome (its component
  diagram still shows Apple Mail; the mail path is the inbox pipeline)
- [WORK_COMPLETED.md](WORK_COMPLETED.md) — the 2026-08-01 completion record
- [CURRENT.md](CURRENT.md) — the post-cut addendum is the running record
- [DECISIONS.md](DECISIONS.md)
- [docs/VERIFICATION.md](docs/VERIFICATION.md)
- [docs/FABRIC_PLAN.md](docs/FABRIC_PLAN.md) §8.5 and §9
- [docs/DESIGN-EMAIL-CORRELATION.md](docs/DESIGN-EMAIL-CORRELATION.md) §8 and §9
- [docs/archive/WORK_REMAINING-2026-08-01.md](docs/archive/WORK_REMAINING-2026-08-01.md)
