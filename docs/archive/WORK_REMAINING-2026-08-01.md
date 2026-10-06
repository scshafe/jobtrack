# JobTrack Work Remaining (snapshot 2026-08-01, archived)

> **Archived 2026-09-05.** This is the 2026-08-01 program-ledger snapshot,
> kept unchanged for its full task list. The live short list is
> [../../WORK_REMAINING.md](../../WORK_REMAINING.md), which also records which
> batches below landed, which were superseded by the inbox-pipeline relay, and
> which human decisions remain.


Snapshot: 2026-08-01 10:05 PDT

> **Superseded sections below.** JobTrack 2.0 was cut and brought up locally
> after this snapshot was written. What has since been done, and what that
> leaves:
>
> - **P0 (repair and re-audit the B07 branch) is complete.** The module-load
>   failure, the zero-trap blocker, and a further realm-poisoning finding from a
>   fresh adversarial audit are all fixed, tested, merged to `main`, and
>   released as `v2.0.0`. The isolated worktree is no longer the source of
>   truth; canonical `main` at `b81cc73` is.
> - **Task 46 is done on the JobTrack side.** `bin/jobtrack-draft-runner.js`
>   implements the out-of-process runner on a digest-pinned Mission Pipeline
>   DAG. See [docs/DRAFT_RUNNER.md](docs/DRAFT_RUNNER.md).
> - **Task 42 (migration rehearsal) and task 43 (install a released CLI as sole
>   writer) are done**; task 44 (fresh read-only web container) is running
>   locally against the preserved store.
> - **The "JobTrack repository work required for B11" section is done**: `main`
>   is released and tagged, version metadata is `2.0.0`, and the migration
>   rehearsal passed with zero inherited row drift.
> - **Hygiene gaps 1-4 are cleared** (stale status documents, version drift,
>   the public-export help mismatch, and decision-record drift). Gaps 5-9
>   remain.
> - **Task 45/78 (Tailnet route) is deliberately still open.** No route was
>   restored and Funnel remains off; that is gated to B13.
> - **G07 is still open** and none of these tasks may be credited in the ledger
>   until the cross-repository halves land and commit `b81cc73` itself passes
>   an independent audit.
>
> - **Post-snapshot (2026-08-05/06):** the v2-lane reply views, the story
>   library (facets, gate, `story-tool`), and the approval-bound submission
>   lane landed on `main` — see CURRENT.md's post-cut addendum.
>
> Everything below is the pre-release snapshot, retained for the full task list.

Canonical repository: `~/.mission-control/projects/jobtrack`

Authoritative program ledger at this snapshot: revision 141, updated
`2026-08-01T15:00:18Z`

```text
27 / 96 complete
3 in progress: 21, 46, 79
60 pending
6 waiting_human_not_ready: 58, 59, 60, 61, 85, 87
G01-G04 passed
G05-G15 and B16 pending
```

The live authority for status changes is:

`~/.openclaw/workspace/state/job-application-platform-rebuild-2026-07-30.json`

This file is a comprehensive snapshot and execution outline. It separates the
required clean-rebuild program, JobTrack-specific release work, deferred product
backlog, and inferred hygiene gaps. Deliberate non-goals are not mislabeled as
required work.

## Immediate critical path

Three offline lanes are open. No live mailbox, Full Disk Access (FDA),
Transparency Consent and Control (TCC), deployment, route, native draft, or send
effect is authorized yet.

1. **B05 / task 21:** finish Apple-only continuous ingress and resumable
   historical backfill, then independently pass G05 for tasks 21-27.
2. **B07 / task 46:** finish and independently re-audit JobTrack's hostile-object
   zero-trap signature/key boundary, then complete the actual out-of-process
   draft runner and the rest of G07.
3. **B10 / task 79:** complete or repair the standalone ApplySim candidate and
   independently pass its software gate.

## P0 — repair and re-audit the JobTrack B07 branch

Isolated branch:

`~/.openclaw/workspace/.worktrees/job-application-platform-rebuild-2026-07-30/jobtrack-b07`

Committed head: `5251ee4b56b5a98ecb4abac07ee182d582797ed6`

The committed candidate repaired five findings from rejected ancestor
`0e1eeb1`, but independent audit still found one release-blocking family:
genuine Buffer/typed-array or public-key values with Proxy prototypes can
execute traps before rejection at the privileged cryptographic callback
boundary. Database rollback remained atomic, but zero-trap rejection did not.

The current repair is uncommitted and modifies five tracked files:

- `docs/EMAIL_OUTGOING_PROVIDER_NEUTRAL.md`
- `lib/email-outgoing-v2-contracts.js`
- `lib/email-outgoing-v2.js`
- `test/email-outgoing-v2-contracts.test.js`
- `test/email-outgoing-v2-persistence.test.js`

At this snapshot the focused suite does not load because
`lib/email-outgoing-v2-contracts.js:41` calls an undefined `freeze`. This is a
transient unfinished-edit defect, not a new accepted architecture conclusion.
The branch is not test-ready or mergeable.

Required closure sequence:

1. Repair the current module-load failure without losing the dirty work.
2. Classify signer byte views and resolved keys with trap-free primitives before
   `Buffer.isBuffer`, `instanceof`, property reads, iteration, or copying.
3. Reject direct proxies, Proxy prototypes, revoked proxies/prototypes,
   subclasses, custom prototypes, accessors, shared memory, detached views, and
   wrapper key objects before any hostile code can execute.
4. Add permanent Buffer, Uint8Array, and resolved-key adversarial cases that
   require zero traps and zero durable review/approval/operation rows.
5. Run focused outgoing, historical email/web/security, full Node 22,
   migration/replay, content-addressed fixture, no-external-path, syntax, smoke,
   dependency, and diff gates.
6. Reproduce the result from a clean no-local clone and offline frozen install.
7. Commit a clean descendant.
8. Obtain a fresh independent security/release PASS.
9. Do not merge, tag, release, deploy, or credit any B07 task before that PASS.

Even a green JobTrack descendant cannot alone close G07. The fixed
JobTrack-to-Inbox relay, PostgreSQL thread/effective-recipient resolver, native
sender port, and append-only receipt-return path are cross-repository
deliverables that still have to join it.

## Every remaining canonical checklist task

The following list includes each of the 69 non-complete source tasks exactly
once. Status labels are from ledger revision 141.

### Apple Mail ingestion and production operations

- **21 — IN PROGRESS:** Replace the Gmail-only continuous mailbox scope and
  controller with a provider-neutral Apple Mail scope.
- **22 — PENDING:** Implement continuous Apple Mail ingestion through the
  adapter registry.
- **23 — PENDING:** Implement resumable Apple Mail historical backfill with
  durable completion evidence.
- **24 — PENDING:** Add Apple-specific recent-mail and backlog schedules without
  reusing Gmail query semantics.
- **25 — PENDING:** Enforce immutable batches of at most ten, commit before
  checkpoint, crash recovery, and one active reader per mailbox.
- **26 — PENDING:** Preserve Message-ID, thread, References, In-Reply-To,
  Reply-To, account, duplicate, and replay fidelity.
- **27 — PENDING:** Test `.emlx` layouts, partial scans, concurrent Mail-store
  changes, permission denial, malformed mail, and large mailboxes.
- **29 — PENDING:** Add installed supervision for every required broker,
  scheduler, trigger worker, Mission worker, relay, bridge, sender, and monitor.
- **30 — PENDING:** Add machine-readable health for services, schema, cursor
  age, queues, firings, Mission runs, dead letters, usage, JobTrack delivery,
  and backlog progress.
- **31 — PENDING:** Add alerts, watchdogs, log rotation, independent kill
  switches, and restart/recovery tests.

### Inbox to JobTrack semantics

- **37 — PENDING:** Extract acknowledgements, required actions, interviews,
  reschedules, cancellations, rejections, offers, withdrawals, recruiter
  follow-ups, ambiguity, and malicious content as typed facts.
- **38 — PENDING:** Replace the coarse facts projection with source-grounded
  JobTrack facts and exact provenance.
- **39 — PENDING:** Extend relay behavior beyond correlation to idempotent,
  version-pinned transition and reply-draft proposals.
- **40 — PENDING:** Route ambiguous, unmatched, stale, or security-sensitive
  items to review rather than guessing.
- **41 — PENDING:** Add durable delivery leases, retries, poison isolation, dead
  letters, replay, and outage isolation.
- **42 — PENDING:** Rehearse all JobTrack migrations against a restored backup
  and prove inherited rows and files remain intact.
- **43 — PENDING:** Install a clean released JobTrack CLI as the sole writer.
- **44 — PENDING:** Deploy a fresh read-only JobTrack web container against the
  preserved store.
- **45 — PENDING:** Restore the JobTrack Tailnet route only after local health,
  read-only, integrity, and security checks pass.

### Drafting, approval, and Apple Mail outgoing path

- **46 — IN PROGRESS:** Implement the out-of-process JobTrack draft runner with
  digest-pinned context, a tool-less route, proposal validation, provenance,
  and usage receipts.
- **47 — PENDING:** Add a private review surface showing the exact recipient,
  thread, subject, body, and digest.
- **48 — PENDING:** Build a signed native Apple Mail host/extension plus a
  narrowly scoped companion bridge with stable identity.
- **49 — PENDING:** Implement the Apple `MailDrafter` facet and prove it creates
  a recipient/thread-locked draft without sending.
- **50 — PENDING:** Complete provider-neutral, content-equivalent send
  contracts rather than forcing Apple through Gmail byte assumptions.
- **51 — PENDING:** Add content-addressed approved-draft storage that the sender
  can retrieve and rehash exactly.
- **52 — PENDING:** Implement the fixed-command authenticated JobTrack-to-Inbox
  send-request relay.
- **53 — PENDING:** Implement the PostgreSQL inbound-thread resolver and
  independently verify the effective recipient.
- **54 — PENDING:** Implement a separate least-authority Apple sender capable
  only of one already-approved draft to its locked recipient.
- **55 — PENDING:** Add structural consent, idempotency, stale-approval and
  edited-draft rejection, duplicate prevention, and crash-after-send
  reconciliation.
- **56 — PENDING:** Capture Apple Mail draft/message/thread IDs and return
  append-only send receipts to JobTrack.
- **57 — PENDING:** Complete the negative matrix for account, recipient,
  thread, digest, approval, TCC, duplicate, injection, permission, and
  indeterminate-provider failures.
- **58 — WAITING HUMAN, NOT READY:** Cole grants FDA to the exact signed
  Mail reader/bridge only after that artifact exists.
- **59 — WAITING HUMAN, NOT READY:** Cole enables the exact Mail extension and
  grants one-time Automation permission only when it is ready.
- **60 — WAITING HUMAN, NOT READY:** Cole handles Mail-account login, Keychain,
  signing, MFA, or device prompts only if they occur.
- **61 — WAITING HUMAN, NOT READY:** Cole approves or rejects each exact
  content-addressed outbound draft; an agent cannot manufacture this attestation.

### Integrated release train

- **62 — PENDING:** Clean, review, integrate, merge, push, and tag Mission
  Pipeline, Execution Contracts, Inbox Pipeline, JobTrack, and ApplySim in
  dependency order.
- **63 — PENDING:** Standardize builds and runtime on pinned Node 22,
  package-manager versions, native tools, and PostgreSQL 18.
- **64 — PENDING:** Run frozen installs, builds, typechecks, complete tests,
  disposable database replay, contract conformance, and security/reproducibility
  gates.
- **65 — PENDING:** Run independent code, security, operations, and release
  reviews and fix every release blocker.
- **66 — PENDING:** Build immutable release trees; no service may run from a
  mutable checkout, worktree, or local-path dependency.

### Fresh dark deployment and non-sending canaries

- **67 — PENDING:** Create a genuinely new hardened PostgreSQL 18 cluster and
  new secrets.
- **68 — PENDING:** Apply the complete migration chain from empty and prove
  exact replay.
- **69 — PENDING:** Create separate least-authority owner, migrator, scheduler,
  broker, worker, relay, observer, reviewer, drafting, and send identities.
- **70 — PENDING:** Seed reviewed pipeline, model, schedule, mailbox, JobTrack
  subscription, and capability definitions.
- **71 — PENDING:** Package and install the tunnel, Apple reader, scheduler,
  Mission worker, JobTrack relay, draft runner, send ingress, bridge, sender,
  receipt relay, and health monitors, initially disabled.
- **72 — PENDING:** Prove all services reference only the new generation and
  every approval/send queue begins empty.
- **73 — PENDING:** Enable database/tunnel, reader, scheduler/worker, JobTrack
  relay, and drafting incrementally while sending remains held.
- **74 — PENDING:** Run one-message and one-ten-message Apple reader canaries.
- **75 — PENDING:** Run an Inbox to Mission Pipeline to JobTrack
  correlation/proposal canary.
- **76 — PENDING:** Run an Apple Mail draft-only canary and prove zero
  transmission.
- **77 — PENDING:** Exercise reboot, crash recovery, duplicate replay, service
  restart, queue bounds, and every kill switch.
- **78 — PENDING:** Restore the JobTrack Tailnet route only after all preceding
  gates pass.

### ApplySim and the supervised round trip

- **79 — IN PROGRESS:** Finish and release the standalone dummy careers site,
  independent of Cole's real AWS-hosted site.
- Task 80 is already complete: form POST now creates durable test-run state.
- **81 — PENDING:** Implement gated Stalwart lifecycle email with dry-run
  handshake parity first.
- **82 — PENDING:** Implement reply capture through the dummy mailbox so the
  test proves a real round trip.
- **83 — PENDING:** Add run IDs, threading, recipient caps, TLS verification,
  idempotency, health, logs, and teardown.
- **84 — PENDING:** Immediately before the supervised test, choose/provision a
  dummy domain/mailbox and configure MX, SPF, DKIM, and DMARC.
- **85 — WAITING HUMAN, NOT READY:** Cole handles unavoidable registrar or
  mail-host payment, password, or 2FA challenges.
- **86 — PENDING:** Run the external-send matrix against temporary stores:
  happy, malicious, ambiguous, duplicate, outage, mismatch, and crash recovery.
- **87 — WAITING HUMAN, NOT READY:** Cole is present for the supervised test
  and approves the exact outbound reply.
- **88 — PENDING:** Execute the complete ApplySim to Apple Mail to Inbox to
  Mission to JobTrack to approval/send to ApplySim-reply to JobTrack-receipt
  round trip.
- **89 — PENDING:** Preserve the evidence, disable ApplySim's live sender, and
  remove consent unless Cole explicitly retains it.

### Real mailbox backlog and soak

- **90 — PENDING:** Record an immutable backlog cutoff, coverage baseline,
  cursor, and JobTrack counts.
- **91 — PENDING:** Process one historical message, verify it, then one
  ten-message shard.
- **92 — PENDING:** Ramp only while cursor advancement, Mission runs, JobTrack
  delivery, deduplication, resource bounds, and dead-letter health remain clean.
- **93 — PENDING:** Auto-pause on permission loss, unknown Mail layout,
  canonical conflicts, queue bounds, schema drift, or persistent delivery
  failures.
- **94 — PENDING:** Never generate or send a historical reply without a
  separately reviewed exact draft.
- **95 — PENDING:** Prove completion from durable cursor/window evidence rather
  than queue emptiness.
- **96 — PENDING:** Run at least a 24-hour and three-schedule-interval soak with
  restart, new live mail, relay acknowledgements, and backlog/live interleaving.

## Dependency-ordered batches and gates

### B05 / G05 — inbound Apple Mail

Finish tasks 21-27 against fixture/synthetic Mail stores. Gate G05 requires
exact resume behavior, no duplicate committed messages, and durable fail-closed
evidence for permissions and layout uncertainty.

### B06 / G06 — Inbox to JobTrack

Complete tasks 37-41 and advance 42-45. Gate G06 requires every event class,
ambiguity, hostile input, outage, replay, and provenance path to pass shared
contract and disposable-store tests while the CLI remains the only writer.

### B07 / G07 — approval core

Complete tasks 46-47 and 50-56 and advance 57. Gate G07 must prove that absent,
changed, stale, duplicate, wrong-account, wrong-thread, wrong-recipient, or
indeterminate input can never send or blindly retry.

### B08 / G08 — native Mail host

Complete tasks 48-49 and 57 and prepare 58-60. Gate G08 requires a reproducible
signed artifact, green offline/fixture tests, a disabled sender, and zero live
transmission. Do not request Cole's macOS permissions before this gate is ready.

### B09 / G09 — supervision and recovery

Complete tasks 29-31 across every service. Each process needs one owner, one
machine-readable health contract, one kill switch, bounded failure behavior,
and a tested recovery procedure.

### B10 / G10 — ApplySim software

Complete tasks 79, 81-83, and prepare 86 while retaining accepted task 80. Gate
G10 requires reproducible happy/hostile/outage/recovery paths on temporary
stores and no dependency on Cole's real website.

### B11 / G11 — integration and immutable release

After G04-G10:

1. Rehearse all JobTrack migrations against the restored canonical backup.
2. Integrate Mission Pipeline, Execution Contracts, Inbox, JobTrack, and
   ApplySim in dependency order.
3. Run pinned-toolchain frozen install, full tests, the four ordinary-suite
   opt-in container gates, disposable PostgreSQL, contract, clean-clone,
   package/image, security, and reproducibility proofs.
4. Independently review every repository and artifact.
5. Merge, push, and tag exact accepted source.
6. Build immutable released JobTrack CLI and read-only web artifacts.

Gate G11 requires every repository clean at an exact pushed tag/commit and
every artifact digest equal to the production manifest.

### B12 / G12 — dark fresh deployment

Complete tasks 67-72 from empty PostgreSQL 18 using new secrets and
least-authority identities. Install immutable services disabled, prove empty
approval/send journals, expose no route, and transmit no mail.

### B13 / G13 — non-sending production canaries

Complete tasks 43-45, 58-60, and 73-78. Cole's exact FDA/Automation interactions
occur here and only here. Enable services one boundary at a time, prove
ingestion/Mission/JobTrack/draft-only behavior and recovery, then restore
JobTrack route 8444 after local read-only and integrity checks. Sending remains
disabled and transmission count remains zero.

### B14 / G14 — supervised ApplySim

Complete tasks 61 and 84-89. Provision the dummy domain only when ready, run the
external-send matrix, obtain Cole's approval of the exact test artifact, send
exactly once, match ApplySim and JobTrack receipts, prove replay cannot
duplicate, preserve evidence, and remove or explicitly retain consent.

### B15 / G15 — backlog and operational soak

Complete tasks 90-96. Every message in the frozen window must be durably
accounted for exactly once. No historical reply may be sent without separate
approval. Live and backlog lanes must survive the 24-hour/three-interval soak
and restart matrix.

### B16 — closeout

Only after G15:

- prove all 96 tasks complete;
- close every human wait and child worker;
- record final source, tags, artifact digests, generation, schema, identities,
  routes, state roots, backup/restore, canary, ApplySim, backlog, soak, and
  stop-effects evidence;
- update repository handoff and durable memory; and
- mark the long-running goal complete.

## JobTrack repository work required for B11

### Integrate and release current local main

- Canonical `main` is clean at `d59ed92` but ten commits ahead of GitHub
  `origin/main`/`v0.7.0`.
- The package, Dockerfile arguments, and Compose defaults still identify
  `0.7.0`.
- There is no post-v0.7 release tag or immutable artifact.
- Integrate only independently accepted B06/B07 work, choose the next release
  version, update metadata, merge, push, annotate the tag, and build from a
  fresh clone.

### Prove store and migration preservation

- Replay every new migration against a restored copy of the preserved
  canonical store.
- Compare all 233 inherited table projections and every attachment/non-SQLite
  file.
- Re-run integrity, foreign-key, migration-ledger, idempotency, append-only,
  UUID, readiness/package, and public-export checks.
- Never experiment directly on the canonical store.

### Build released artifacts

- Produce a pinned Node 22 CLI as the only writer.
- Produce a fresh read-only, non-root, capability-dropped web image with exact
  labels/digests and no model, compiler, Docker socket, browser, or sender
  authority.
- Keep the Tailnet route absent until G13.

## Deferred product backlog and decisions

These items are explicit product follow-ups, but they are not current
clean-rebuild release blockers unless Cole expands scope.

- Add a separate reviewed materialization command from an accepted discovery
  intent to the opportunity inbox.
- Add durable discovery-source rate state, leases, jitter, and backoff before
  enabling a recurring discovery scheduler.
- Pin production discovery images by digest, add a deployment seccomp profile,
  and consider an external host egress proxy/firewall.
- Remove legacy compatibility columns or rebuild tables only after every
  caller has migrated and copied-live verification passes.
- Add the cross-domain timeline follow-up view.
- Revisit degree/field/language identity normalization. Project/repository link
  normalization has advanced substantially in the post-v0.7 commits, so the
  older combined follow-up should be re-scoped before implementation.
- Add a managed, reviewed corpus of Cole-authored/sent prose and per-axis
  communication-style confidence if desired.
- Populate the intentionally empty real story library only from stories Cole
  actually tells; do not invent examples.
- Refresh Skill Workshop proposal `jobtrack-20260717-32b0409b43` to the final
  released CLI surface. It remains pending/unapplied and requires Cole's
  explicit apply or reject decision.

LinkedIn crawling, an in-process autonomous model runtime, autonomous browser
form submission, broad mailbox mutation, and an inline PDF serving route are
deliberate non-goals. They are not missing current deliverables.

## Inferred readiness and hygiene gaps

These are not separately numbered canonical tasks, but they should be resolved
inside B11 or handoff work.

1. **Stale status documents.** `CURRENT.md` says v0.7 is live;
   `docs/TEMPORARY_STEWARDSHIP.md` still calls v0.4 current and says no remote;
   deployment portions of `docs/VERIFICATION.md` do not reflect retirement.
2. **Version drift.** Package, Docker, and Compose metadata remain `0.7.0`
   despite ten later commits.
3. **Public-export help mismatch.** CLI help says the public export validates
   v1 while implementation, tests, skill docs, and the standing release gate
   use `public-profile.v2.schema.json`.
4. **Decision-record drift.** `DECISIONS.md` predates the UUID/export/project
   graph work and accepted clean-rebuild ADRs.
5. **Host toolchain drift.** Default Node 24 loads a Node-22-built
   `better-sqlite3` and produces a misleading red suite; Homebrew Node 22 is
   broken by a missing `libsimdjson.29.dylib`. The working runtime is
   `~/.openclaw/tools/node/bin/node` v22.22.0. B11 must provide a
   clean, reproducible pinned toolchain and frozen install.
6. **Release automation gaps.** The repository has test/smoke and specialized
   container scripts but no first-class lint/typecheck/build/CI aggregate that
   encodes the complete release gate.
7. **Skipped opt-in gates.** The ordinary main run skips one real discovery
   container-denial smoke and three real LaTeX renderer container cases. Run
   them in the isolated B11 environment.
8. **Historical refs/worktrees.** Several old v0.3 branches/worktrees and one
   prunable missing `/private/tmp/jobtrack-email-integrity` record remain.
   Reconcile unique evidence and explicit supersession before archival/pruning;
   do not blindly merge or destructively clean them.
9. **Dirty B07 preservation.** Preserve the five-file repair exactly until it
   is completed and committed or deliberately superseded.

## Human-only work, and when to ask

Cole's six tasks are expected future waits, not current blockers:

- **58:** grant FDA to the exact signed artifact after G08 is ready.
- **59:** enable the exact Mail extension and Automation permission after G08.
- **60:** handle a genuine account, Keychain, signing, MFA, or device prompt if
  one occurs.
- **61:** approve or reject the exact outbound artifact during B14.
- **85:** handle unavoidable dummy-domain/mail-host payment/password/2FA during
  B14.
- **87:** be present for the supervised ApplySim round trip.

Do not request any of these before their exact artifact and prerequisite gate
exist.

## Completion rule

JobTrack and the platform are not complete merely because the source builds,
the token budget is low, or a partial deployment works. Completion requires
all 96 canonical tasks, G01-G15, the B16 audit, exact immutable release and
deployment evidence, the supervised exactly-once round trip, backlog coverage,
and the operational soak.

## Primary evidence

- [OVERALL_GOAL.md](OVERALL_GOAL.md)
- [WORK_COMPLETED.md](WORK_COMPLETED.md)
- [CURRENT.md](CURRENT.md) — historical/stale operational status
- [DECISIONS.md](DECISIONS.md)
- [docs/VERIFICATION.md](docs/VERIFICATION.md)
- [docs/DISCOVERY_SANDBOX.md](docs/DISCOVERY_SANDBOX.md)
- B07-only evidence: `~/.openclaw/workspace/.worktrees/job-application-platform-rebuild-2026-07-30/jobtrack-b07/docs/EMAIL_OUTGOING_PROVIDER_NEUTRAL.md`
- `~/.openclaw/workspace/plans/job-application-platform-rebuild-checklist-2026-07-30.md`
- `~/.openclaw/workspace/plans/job-application-platform-rebuild-execution-2026-07-30.md`
- `~/.openclaw/workspace/state/job-application-platform-rebuild-2026-07-30.json`
- `~/.openclaw/workspace/reports/job-application-platform-rebuild-2026-07-30/b07-drafting-send/jobtrack-b07-5251ee4-independent-fail-audit.md`
