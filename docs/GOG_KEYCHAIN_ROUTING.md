# Shared university Google credentials: one executable

Status, September 8, 2026: implementation/build candidate; **live acceptance is
blocked on native macOS authorization, not complete**. Do not interpret a
successful fixture or cached-token read as a permanent repair.

Review corrections: the cutover below now drains old callers **before** any
authorization/live window. Main has a separate explicit-account routing policy,
not JobTrack's implicit university default. Personal routing remains blocked
pending the user's exact account and a separately reviewed implementation;
this correction does not claim to restore personal Gmail/Calendar access.

## Prompt-storm containment (September 8 Pacific / September 9 UTC)

After the V2 candidate, the user reported more than 30 native authorization
dialogs. This exposed a missed safeguard: gog's `--no-input` did not disable
Security.framework interaction. Fresh CLI processes do not share the readiness
cache, and a denied primary lookup can lead to a legacy-alias lookup. Repeated
background invocations can therefore produce multiple prompts. The specific
30-dialog sequence is not attributed to a captured process.

Containment is active via `.tools/gog/keychain-access-paused`. Default pinned
resolution fails with `GOG_KEYCHAIN_ACCESS_PAUSED` before launching gog. Only
internal build verification and the metadata/authorization utility may use
`metadataOnly: true`; all pin checks still run. A dangling marker still blocks.
Do not remove this hold until the separate native authorization and live-witness
plan is ready. This temporarily blocks Google-dependent work that reaches the
pinned resolver or scoped shim; it is not universal main-agent containment.

Two live process snapshots plus a 30-second watch saw no active gog. JobTrack
and ApplySim daemons retained their original PIDs 628/620 and launchd runs=1:
there was no observed crash/restart loop. The marker affects newly loaded code;
old cached modules, explicit Homebrew paths, other agents and already queued
dialogs are not universally intercepted. Do not kill SecurityAgent or broad
process groups. Existing dialogs can be denied/cancelled; repeated Always Allow
is not the repair. A subsequent noninteractive metadata snapshot still failed
on primary ACL inspection with OSStatus -25293. No credential read was attempted
as a workaround for that denial.

A later actual-main routing check exposed a second gap: OpenClaw's Codex-native
`bash` does not consume `tools.exec.pathPrepend`. It resolved Homebrew, not the
held shim. A labels-list diagnostic returned `missing --account`, with no
successful Google read. Upstream account inference can inspect stored accounts
before that error, so this mistaken routing check **may itself have requested
Keychain access**. Its prompt contribution was not captured. Subsequent main
diagnostics inspect PATH and `command -v gog` only, without executing gog.
The subsequent main-only Codex shell policy change passed an actual gateway
native-shell witness: `command -v gog` selected the scoped shim. The runtime
preserved its generated Codex vendor PATH prefix ahead of the configured tail.
No gateway restart, global Codex configuration or other-agent change was needed.

An isolated V3 JobTrack Codex worker then exposed the same inherited-PATH gap:
bare gog selected Homebrew even though its direct resolver verified V3 and the
hold. That check executed no gog or credential operation. Source-level process
PATH injection alone is not sufficient proof of a model tool's effective PATH.
After the per-invocation Codex shell-policy correction, a second isolated actual
worker selected the scoped shim and verified V3 plus the active hold without
executing gog. Both active Codex runtime types now have path-only witnesses;
neither is yet a successful Google/refresh witness.

V3 adds `noninteractive-keychain.patch`: a CLI BeforeApply hook disables and
verifies native Keychain interaction when `--no-input` is true, before credential
work. Denied access then fails closed without requesting a dialog. This changes
only the gog process's interaction policy, not Keychain permissions, lock settings,
credentials, or other applications. Foreground defaults are unchanged. A
credential-free child test exercised the real Set/Get policy API. See
[Apple's client-local policy implementation](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_keychain/lib/Globals.h).
The prior V1/V2 artifacts remain untouched.

## Cause and fresh diagnosis

The September 8 investigation found two valid ad-hoc identities sharing the
three university token aliases. Token refresh persists new access-token metadata
to those aliases. Apple's legacy Keychain replaces the secret's secure-storage
group, preserving ordinary application trust but recreating its partition ACL
for the writer. Re-adding both hashes is therefore not durable.

Fresh inspection in this task reconfirmed the original binaries (Homebrew 0.27.1
and the original JobTrack v1 executable) unchanged, by SHA-256 and CDHash.

Both signatures passed `codesign --verify --strict`. Homebrew resolves to
`/opt/homebrew/Cellar/gogcli/0.27.1/bin/gog`. The original JobTrack executable
and historical plans/receipts remain unchanged. A fresh settings query returned
"User interaction is not allowed"; the new noninteractive fixed-alias snapshot
then returned `SNAPSHOT_ACCESS_COPY_FAILED_primary`, OSStatus `-25293`.
Consequently **current ACL contents, lock state, and intervening drift have not
been established**. No old plan was replayed and no authorization was bypassed.

Primary source references:
[gog refresh persistence](https://github.com/steipete/gogcli/blob/22d197c5c40e3b6482dff4e8c7be68e29239b05c/internal/googleapi/client_auth.go),
[alias persistence](https://github.com/steipete/gogcli/blob/22d197c5c40e3b6482dff4e8c7be68e29239b05c/internal/secrets/token.go),
[Apple Item implementation](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_keychain/lib/Item.cpp).
The exact invocation behind the reported screenshot remains unwitnessed.

## Chosen implementation

All intentionally shared `default` / university-account calls must use the one
reviewed `jobtrack-single-attempt-v3-darwin-arm64/gog` artifact. `pin.json` records
the exact upstream/toolchain, all three patch hashes, executable SHA-256 and CDHash.
Every native operation and scoped launcher revalidates the pin. No PATH,
Homebrew, environment override, or missing-artifact fallback is permitted.

The original `single-attempt.patch` is byte-for-byte unchanged. An additive
`scoped-auth.patch` introduces only `auth inspect-account EMAIL`, which requires
explicit client/account identity, reads that account with `GetTokenNoMigrate`,
and returns seven closed metadata fields (including scopes), never tokens.
This additional build was necessary because upstream `auth list` enumerates all
stored credentials and `auth status` does not provide send-scope evidence.
Read access is not substituted for the existing Gmail send-scope readiness gate.

The existing artifact was not overwritten or re-signed. V3's reviewed identity
(SHA-256 and CDHash) is recorded in `tools/gog/pin.json`.

The common environment explicitly selects Keychain service `gogcli` and removes
ambient alternate accounts/clients, direct tokens, ADC, alternate roots and
output selectors. Existing no-send fences remain. The scoped `gog` shim refuses
auth/export/config commands, other accounts/clients, credential/root flags and
aliases, combined short flags, and attempts to disable no-input or no-send.
It is an operational route, not an OS sandbox or new send authorization.

## Caller inventory and activation

| Caller | Fresh finding | Intended route / activation |
| --- | --- | --- |
| Native source/draft/clarification/send adapters | Already exact pinned paths and sanitized environment | V3 pin; all journals/approvals/identity gates remain |
| `defaultTransmitProbe` | PATH `gog auth list --json`, all accounts | V3 exact-account metadata; never enumerate other accounts |
| Production email review/reply briefs | Two PATH `gog gmail get` recipes | Exact `scripts/read-email-source.cjs`; failure stops work |
| Production and ApplySim Codex executors | Both inspected standing configurations default to Codex; inherited PATH alone was overridden by tool shell | One checked `gogWorkerEnvironment()` feeds both spawn environment and per-invocation `-c shell_environment_policy.set.PATH=...`; native source paths stay explicit |
| Optional Claude / standalone absent-harness workers | Not selected by inspected standing daemons; standalone default remains Claude | Scoped process PATH added, but actual Claude shell/snapshot routing is unverified; do not enable shared Google access on this route until witnessed |
| `com.cole.jobtrack-fabric-daemon` / `ai.applysim.fabric-daemon` | Running Node alias → v24.18.0; Homebrew in PATH; no GOG selectors in plists | Stop admissions and drain first; keep normal scheduling stopped through authorization/live acceptance; resume only afterward |
| Hourly `com.cole.jobtrack-fabric` | `scripts/fabric-cron.sh`, no plist environment | Updated exact readiness subprocess; no cycle used for verification |
| University Inbox relay / frontier reviewer / stage1 babysitter | Local scripts contain no gog/GOG invocation | No routing edit required |
| OpenClaw main gog skill | Native shell needs its own PATH policy; initial university-only route also hijacked general/personal account selection | Separate `main-bin/gog` requires an explicit approved account; both main-only deployment fragments now target it; personal route is not enabled |
| Interactive shell | Bare `gog` still resolves Homebrew; no existing gog override found | Use explicit scoped launcher below for university credentials; global shell config unchanged |
| Inbox credential edge | `gog-lane.sh` names `/usr/local/bin/gog` on Linux, explicit file backend/per-lane storage | Separate remote store, not these macOS entries; unchanged |
| ApplySim raw-worker escape hatch | `APPLYSIM_WORKER_RAW` absent from inspected standing configuration | Bypasses the normal worker environment; disabled/unverified for shared Google access, not exercised or changed |

The reviewed main correction is now applied to both its legacy exec setting and
isolated native Codex config. A fresh actual-main native `bash` command-resolution
witness selected `main-bin/gog`, not `umich-bin/gog` or Homebrew. JobTrack's checked
worker environment still selects `umich-bin`; its executor source is unchanged
by this main-account correction. This is path-only evidence, not Google access.

No matching crontab entries were found. Inventory was limited to relevant source,
safe administrative configuration projections, and launch definitions, not
unrestricted process arguments, secret environment values, journal workspaces,
agent state, messages or account-owned shared payload records. Manual commands,
new callers and explicit executable paths can bypass PATH; this policy must be
carried into their implementation. Do not claim they were globally intercepted.

For an interactive university read, use the service-first scoped interface:

```sh
~/.mission-control/projects/jobtrack/tools/gog/umich-bin/gog gmail labels list --json
```

Other accounts are deliberately refused by the JobTrack launcher, not newly authorized. Do not use
Homebrew against these same university aliases between checks or after rollout.
Do not modify the installed OpenClaw skill in place; durable skill changes use
the Skill Workshop lifecycle. The applied configuration affects **main only**,
not global exec policy or private-journal. The previous main exec pathPrepend was absent. Preserve any subsequently added
path entries; the setting is not a global shell or other-agent override.

Native Codex additionally needs the additive `shell_environment_policy.set.PATH`
fragment in `deploy/openclaw/gog-main.codex.toml`, merged only into
`~/.openclaw/agents/main/agent/codex-home/config.toml`. That file previously
had no shell policy; existing project/MCP tables remain intact. The fragment
preserves the observed ordinary runtime PATH tail, not generated Codex tmp/vendor
directories. Reconcile the versioned Node directory when upgrading Node; retain
the stable Node alias. Do not replace the entire configuration with this fragment.
Verify both effective PATH and `command -v gog` through a fresh actual main turn
after any OpenClaw/Codex upgrade. A schema-valid legacy exec setting is insufficient.

JobTrack's Codex executor likewise binds the same checked PATH through a
per-invocation shell-policy override. It changes no user/global Codex configuration
and preserves all other model, sandbox, brief and no-replay behavior. A missing
shim fails inside the caught spawn preparation before creating a worker process.
Optional Claude and raw-worker routes have not passed actual shell routing
acceptance; process environment unit tests do not establish that proof.

### Main's explicit account policy

Main's PATH must select `tools/gog/main-bin/gog`, while JobTrack worker PATHs
continue to select `tools/gog/umich-bin/gog`. The main launcher is a thin policy
layer over the same pinned university route; it never chooses another executable
after a refusal, pin failure or pause.

| Context / selection | Behavior |
| --- | --- |
| JobTrack scoped launcher, no account | Intentionally university/default, unchanged |
| Main, no explicit account (even with `GOG_ACCOUNT`) | `GOG_MAIN_EXPLICIT_ACCOUNT_REQUIRED`; no credential lookup |
| Main, exactly the approved university account | Existing university/default pinned route and hold |
| Main, personal/unknown account or account alias | `GOG_MAIN_ACCOUNT_NOT_APPROVED`; no discovery, delegation or fallback |
| Main, duplicate/conflicting selectors | Refused before execution, even if values match |

Use one `--account ADDRESS`, `--account=ADDRESS` or `-a ADDRESS` before or after
the service. The remainder must remain service-first; credential/config/export
commands, alternate clients, account aliases and credential-root overrides remain
refused. For example, once controlled live access is authorized:

```sh
gog gmail labels list --account <university-account> --json
```

If the requested account is unclear, ask which account rather than choosing the
university account. If a personal account is requested, report the separate route
as pending; do not retry with a stock binary, a default/alias, environment-based
inference or JobTrack's implicit launcher. The personal address has been requested
from the user, not discovered from Keychain, `auth list`, or shared agent state.

A future personal route requires an exact approved account and reviewed
credential-access implementation first. Stock Homebrew retains the native-dialog
gap; reusing V3 for personal credentials must not silently grant JobTrack broader
access. Keep personal alias/client authorization out of the university repair
plans. No such route or new permission is introduced by this interim correction.

Deploy only the main-specific `deploy/openclaw/gog-main.patch.json` and
`gog-main.codex.toml` settings. These replace the earlier `gog-umich.*` main
deployment fragments, not the university worker launcher. Installed skills,
global shell/Codex settings and other agents remain unchanged.

## Complete the blocked authorization and live witness

**Corrected cutover order: stop admissions → drain old callers → verify fresh
held routes → authorize → controlled reads/refresh → resume normal scheduling.**
The previous order placed drain/restart after live checks. That was unsafe:
cached workers can bypass the marker and overwrite a token during verification.
The corrected procedure below has not yet been executed; it is not a drain receipt.

1. **Keep the hold present and stop new university work.** Coordinate a pause of
   main/manual Google calls and any other identified university caller. Record
   the current enabled/loaded state of only the three relevant scheduler labels
   below and record their PID/PPID/PGID/executable metadata, including existing
   detached pass/worker descendants. Never print unrestricted arguments or secret
   environment values, enumerate account-owned shared payloads, or touch
   private-journal. No global gateway restart or broad process kill is permitted.
2. **Disable scoped scheduling, then gracefully drain.** Verify the current GUI
   domain/UID and exact labels before acting. Fresh inspection found UID 502;
   these commands are operator cutover steps, not commands already performed:

   ```sh
   launchctl disable gui/502/com.cole.jobtrack-fabric
   launchctl disable gui/502/com.cole.jobtrack-fabric-daemon
   launchctl disable gui/502/ai.applysim.fabric-daemon
   ```

   Verify only those three disabled flags before signalling; if any check fails,
   stop and keep the hold. Then signal only the two exact daemon services:

   ```sh
   launchctl kill SIGTERM gui/502/com.cole.jobtrack-fabric-daemon
   launchctl kill SIGTERM gui/502/ai.applysim.fabric-daemon
   ```

   The daemon SIGTERM handler stops
   future passes and awaits the **whole current pass**, not just the current
   worker. That pass can still admit additional workers until it finishes.
   Let an already-running hourly job finish naturally. Disabling alone is not
   proof of drain. Track descendants even if reparented; confirm both daemon
   roots, their passes/workers and separately identified competing university
   callers have exited, and verify no scheduler restart. Absence of gog alone
   is insufficient. Do not delete locks, budgets, pending wakes or receipts.
   If a deadline kills a worker, an orphan persists or an email mutation is
   ambiguous, keep the hold and reconcile bounded operation evidence; never
   automatically retry it or declare the drain successful.
3. **Keep production scheduling stopped.** Only after natural drain may idle
   exact services be unloaded if necessary. Never start cutover with `bootout`,
   `kickstart -k` or forced termination: launchd can escalate signals and passes
   use detached process groups. Do not bootstrap the normal daemons merely to
   test the hold: `RunAtLoad` can admit ordinary work, including work unrelated
   to Google that the credential marker does not block.
4. **Verify fresh code while held.** Use fresh isolated workers through the real
   JobTrack runner/pipeline/executor and main's actual native shell to verify
   routing, the exact V3 pin and the active pause without invoking gog. Never
   mistake a cached daemon's lifetime or spawn PATH for effective shell routing.
   Production labels remain stopped throughout the following acceptance window.
   Any launchd-origin diagnostic must use a separately reviewed, narrowly scoped
   diagnostic-only launch definition that invokes the same real worker path with
   no production cycle. Record its exact origin honestly; it is not proof of an
   ordinary restarted production daemon. No such diagnostic job is installed yet.
5. **Prepare and authorize only the scoped identity.** Check the login keychain
   locally and unlock it if locked; current lock state was not established by
   denied checks. While the hold remains, take a fresh `--snapshot` of exactly
   the primary/legacy/subject university aliases. It reads metadata/refs only,
   noninteractively; a denial stops work. Snapshots are sequential observations,
   not an atomic transaction. Review fresh application-trust and code-identity
   plans for V3 in new private receipt directories, preserving existing entries.
   Do not replay V1 plans. Only then use the exact `--apply --interactive`
   workflows in foreground Terminal with native protected local input—never
   chat, argv or environment. No broad partition/all-app exceptions. Shared
   client-secret and personal entries are not included automatically.
6. **Open only the controlled acceptance window.** Reconfirm old writers are
   gone, normal admissions remain disabled, fresh routes are correct and V3
   authorization is verified. Only now archive the exact pause marker without
   deleting credentials. Run sequential isolated read-only probes through
   JobTrack's actual `makeWorkerRunner` / pipeline / Codex executor and main's
   actual runtime. The sole brief runs `scripts/check-gog-access.cjs --json`;
   no dispatch/tick/ApplySim cycle, live-store, draft, send or application action.
   A failed gate closes the window: restore the hold and keep scheduling stopped.
7. **Witness persistence and subsequent access.** The probe discards labels and
   raw diagnostics, emitting closed booleans. Wait for natural expiry if
   `refreshPersisted` is false; do not delete/export tokens or alter expiry.
   Require the exact successful post-persistence DEBUG event, changed timestamps
   on all three aliases and no persistence warning. Never use all-account
   `auth list --check` / `auth doctor --check`. Repeat both runtime reads after
   actual persistence; snapshot complete ordinary ACLs and writer partition
   identity again. A V3-only partition after a V3 write is expected. Observe the
   desktop. Keep ordinary scheduling stopped until these checks succeed.
8. **Resume only after acceptance.** Restore only the recorded prior scheduler
   enablement and load the exact reviewed plists if unloaded. Preserve anything
   that was already disabled before cutover. `RunAtLoad` is operational resumption,
   not a read-only test. Normal restarted-daemon verification remains separately
   required; do not rerun ApplySim/email/application cycles to manufacture proof.
   If resumption exposes drift, restore the hold, stop new admissions and drain
   again before investigating. Do not roll back to a competing writer.

Drain behavior is grounded in `lib/fabric-command.js`'s SIGTERM handler,
`lib/fabric-wake.js`'s whole-pass shutdown and detached spawn, and
`lib/fabric-dispatch.js`'s per-pass worker admission. Fresh inspection for this
review found the two original daemon PIDs 628/620 (runs=1), hourly idle (runs=10),
and all three labels effectively enabled. No services were disabled, signalled,
unloaded or restarted during this review correction.

```sh
node scripts/authorize-pinned-gog-keychain.cjs --snapshot \
  --receipt-dir ~/.mission-control/projects/jobtrack/.tools/gog/keychain-routing-20260908
node scripts/check-gog-access.cjs --json
```

The second command is a normal credential-using provider read, not a metadata-only
Keychain inspection; do not run it as a workaround for denied authorization.
No live provider, refresh, desktop prompt stability or restarted-daemon witness
has been obtained in this implementation turn.

## Verification completed for the implementation candidate

- Latest account-policy correction: 54/54 focused root tests passed, including
  seven new main-router tests plus shared routing, pinning, Codex executor,
  scoped readiness, access-probe and Swift ACL fixtures. Independent review
  passed 33 tests and approved the cutover procedure and main-only configuration.
  `config validate`, safe TOML parsing/exact PATH-fragment comparison and
  `git diff --check` passed. An actual main gateway native-bash `command -v gog`
  witness selected the new `main-bin/gog`; it did not execute gog or access
  credentials. Main's native config and the unchanged active hold remain owner-private.
  Personal routing remains unavailable. No daemon lifecycle change, Keychain
  operation, credential access or provider request occurred during this correction; no full live-acceptance
  or completed-drain claim is made.
- Earlier V2 candidate full repository suite: `env -u NODE_ENV
  ~/.openclaw/tools/node/bin/node --test --test-reporter=dot` exited 0.
- Earlier V2 candidate independent final review: 91 focused tests passed on Node 24.18.0, zero
  failures/skips; includes pinned identity, native sender journal/no-replay,
  account-scoped readiness, source/adapter, routing and actual Swift pure fixtures.
- Earlier V2 candidate root pin/route/snapshot/access/readiness batch: 32/32 passed; Swift
  helper typecheck and `git diff --check` passed.
- Two independent build runs produced the same V3 SHA-256. The official rebuild
  ran the complete `internal/googleapi` transport suite and nine scoped-account /
  noninteractive-Keychain tests (including the real native policy child). The official installer verified the reviewed hash before
  exclusive installation. Strict signature verification passed independently.
- Current V3 + hold full repository suite: `env -u NODE_ENV
  ~/.openclaw/tools/node/bin/node --test --test-reporter=dot` exited 0.
  The final full rerun after the per-invocation Codex PATH correction also exited 0.
  Root focused pin/route/snapshot/access/readiness batch, including both main
  deployment fragments: 35/35 passed.
  Updated Swift helper typecheck passed with existing API-deprecation/Codable warnings.
- OpenClaw per-main config patch initially passed a dry run, then was applied
  during prompt-storm containment; `config validate` exited 0. Only main's
  `tools.exec.pathPrepend` was added. A real main native-bash witness then proved
  this legacy-exec setting does not control that tool; it is not live routing
  acceptance. No global/other-agent config was edited.
- Historical university-only main native Codex shell policy parsed successfully and an
  actual gateway main native-shell witness selected the scoped shim. Only PATH
  metadata was queried: no gog process, credential access or provider operation.
  Native config reloaded without a gateway restart. Both main routing layers
  were recorded in `deploy/openclaw/`; this is not evidence for the later distinct
  `main-bin` explicit-account router. Neither layer alters unrelated agents.
- Per-invocation JobTrack Codex PATH regression tests passed: 19/19 root executor
  and shared-route checks; independent combined executor/route/pin review passed
  26/26 after updating the old direct-spawn source assertion for the shared
  checked environment. Failure-before-spawn and exact PATH quoting are covered.
- Current V3 actual `makeWorkerRunner` → pipeline → Codex worker path-only
  witness passed after the shell-policy correction: bare gog resolved the scoped
  shim; metadata-only pin verification selected V3; the normal resolver returned
  `GOG_KEYCHAIN_ACCESS_PAUSED`. Private local evidence:
  `.tools/gog/worker-route-v3-shellpath.zFUYJ6/pipeline-evidence.db`. This was a
  manually initiated isolated diagnostic matching daemon Node/PATH, **not
  daemon-origin**. It executed no gog, provider, credential, live-store or
  ApplySim operation. The initial failing route witness remains separately in
  `.tools/gog/worker-route-v3.BsXHOT/pipeline-evidence.db`.
- Latest post-routing noninteractive snapshot still failed primary ACL inspection,
  OSStatus `-25293`; native authorization remains unresolved. The last process
  snapshot saw neither gog nor SecurityAgent, which is not a desktop-stability witness.
- Earlier V2 candidate actual isolated `makeWorkerRunner` → pipeline → Codex executor
  completed successfully. It verified the V2 pin and executed the scoped launcher with
  `gmail labels list --help`, reporting backend `keychain`. Private local evidence:
  `.tools/gog/worker-route-dV6ao3`. This matched the production launchd Node/PATH
  but was **not daemon-origin**, and made **no credential or provider request**.
  It does not satisfy the live Google/refresh acceptance criteria.

An initial Node 22 fixture run encountered the existing SQLite native-addon ABI
mismatch (addon ABI 137, Node 22 expects 127). Nothing was rebuilt or downgraded;
the correct live Node 24 runtime passed the reruns and full suite.

No credentials were exported, no Keychain ACL/security settings were changed by
the implementation (the user's Always Allow actions are separate),
no Homebrew file was overwritten, no unrelated account was authorized, and no
live mailbox/application mutation or ApplySim cycle was invoked. The unexpected
Homebrew invocation above may have inspected stored credentials; do not infer
that all diagnostics avoided credential access. Source is
updated in the shared checkout; long-running daemons have **not been restarted**
and may still hold old loaded modules. Runtime rollout is therefore unfinished.

## Upgrade and rollback

Keep the one-writer invariant through future upgrades: review all three patches,
reproduce the build, update all source/hash/CDHash pins together, authorize only
the exact new identity, migrate callers together, and verify real persistence.
Never replace a pinned artifact in place or add an automatic stock fallback.
Keep the two policy entry points distinct: main requires an explicit approved
account, whereas JobTrack intentionally fixes the university account. Do not
collapse their PATH settings back to the implicit university launcher.

The old **main exec pathPrepend** and **main Codex shell PATH override** were both
absent; no credential-bearing configuration backup was exported for this task.
Routing rollback removes only these introduced settings after checking for
subsequent edits: main's `tools.exec.pathPrepend` and main's isolated
`shell_environment_policy.set.PATH`. Preserve all unrelated tools/project/MCP
settings and any newly added shell policy fields. Stop university calls while
reconciling one approved writer. Keep the V1/V2 artifacts and old receipts;
none were deleted. A deliberate
V1 rollback requires restoring matching pin/helper/build source as one reviewed
unit, preserving native transport/journal safeguards and avoiding the old
all-account readiness call (fail closed instead). Reauthorize from fresh metadata
if necessary; old code-identity plans are not reusable. Application-trust inverse
rollback is exact-delta/drift-sensitive; partition rollback requires separately
reviewed native action. No token revocation, deletion, export or regrant is needed.

For this account-policy correction specifically, do not roll main back to the
earlier `umich-bin` PATH prefix: that would restore implicit university selection
and the personal-account regression. If the new main router must be withdrawn,
keep university calls paused and remove only the main routing additions after
reviewing drift; do not treat the newly exposed Homebrew PATH as an approved
university or personal fallback. JobTrack's existing `umich-bin` route remains
unchanged. Personal routing stays unavailable until separately approved.
