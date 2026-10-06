# Standing release gates (added 2026-07-28, applies to every release after v0.7.0)

Two gates join the existing checklist for all future releases:

1. **Funnel stays off** (unchanged): the service remains tailnet-only; `tailscale funnel status`
   must show nothing exposed, and Tailscale Serve mappings must still report `tailnet only`.
2. **Public export contract**: `jobtrack export public-profile` must emit an artifact that
   validates against `contracts/export/public-profile.v2.schema.json` (v2 adds pinned flags,
   display ordering, hidden-entry exclusion, project kinds, PUBLIC-visibility-only repo links,
   and `uses` relations; v1 is retained for history) and passes the built-in redaction scan
   (no email/phone patterns, no forbidden keys — email, phone, compensation, EEO, references,
   notice period, work authorization, visa — no integer row identifiers, no private repos, and
   no hidden-entry content; entities are uuid-keyed). The export command itself fails closed on
   any violation; the release check is simply that it exits 0 against the live store.

The public export is the ONLY sanctioned crossing point between the private store and the public
personal site (consumed at build time by pages-generator). No public HTTP surface exists in
JobTrack, and none may be added.

**Encoded in the Conductor since 2026-09-05.** Mission Control's Conductor enrollment `jobtrack`
(manifest `docs/conductor/jobtrack.manifest.json` in the mission-control repository) runs
`scripts/conductor-gate.sh` on every polled commit, from the Conductor's own per-run source
checkout (a git worktree of the laptop's `~/src/jobtrack` at the exact commit, initially
linked to the primary checkout's dependencies): `install` (dev dependencies), `test`
(the full suite, added September 10 UTC), and `export-contract` (gate 2, run against
a scratch copy of the store). Since the 2026-10-04 cutover that store is the live
`/srv/jobtrack/store`, snapshotted with SQLite's online backup. Before that it was the
laptop's replica, refreshed by the now-retired `jobtrack-replica@jobtrack` timer. Since
2026-10-04 the suite runs as four `test-shard` commands, because the Conductor caps each
command at 600 s. A failure means no deploy. After the stack deploy, `verify`
re-checks the health URL and gate 1: the `ts-jobtrack` sidecar must serve the app
`(tailnet only)` with Funnel off. The same script runs by hand from the repository root for a
release made outside the Conductor.

First gated run: `9b7f9e2b` on 2026-09-06 05:51Z for commit `82ec6a4` — `install` added 219
packages in 2 min, `export-contract` reported `{"contract":"public-profile","contractVersion":2}`
against the replica, and the deploy proceeded. (The very first attempt, `86572891`, was cut off two
minutes in when the brain's own self-deploy restarted the scheduler; it was re-run by hand.)

**The full suite now gates both push and deployment.** `sh scripts/conductor-gate.sh test`
runs the whole suite with `NODE_ENV` unset. The canonical clone's pre-push hook
retains it, and the live Conductor enrollment now runs it between install and
public export. Earlier laptop timing was 18 minutes against the ten-minute
per-command cap; optimized synthetic fixture setup brought the reviewed source
under that cap without removing cold-init/migration coverage, as recorded below.

**Authorized activation, 2026-09-10 05:50:53 UTC:** Cole explicitly approved the
release and test-gate activation, then explicitly accepted the completed independent
review in place of Mission Control's unavailable Buddha consultation. No agent
server, Swarm policy, credentials or runtime configuration was repaired. The trusted
loopback update changed only enrollment `a1ad9e57-04dc-4e58-b194-ff9bab489cb9`'s
command list to `install` → `test` → `export-contract`; its enabled state, project,
repository, poll interval, deployment and verification remained unchanged.
Immediate readback matched the reviewed manifest. Mission Control source commit
`c0c0487e4eec4b05fbcabc247adb4f143b3e26db` contains that three-file manifest/test/runbook
change locally; it was not pushed to trigger an unrelated Mission Control deployment.
The activation receipt is retained locally at
`/tmp/jobtrack-gate-activation.MQMYmp/activation-receipt.json`.

Activation is not release acceptance: the intended JobTrack source must pass this
actual enrollment's install/test/export/deploy/verify stages, and the deployed
image revision must match. Conductor's exact-commit run record is the authoritative
release witness. Applysim commit `873d7252c4c50958846f05e5c6c98d1c3d5eadcd` remains local;
its push is held because its ordinary deployment restarts a company daemon that
may send due drill email. That rollout needs separate explicit authorization.

**Verify the existing automatic source synchronization.** The deployed scheduler's
poll reads `git rev-parse HEAD` in `~/src/jobtrack`; neither poll nor
detached-worktree resolution fetches GitHub. The surrounding release workflow
does: the existing five-minute `mc-autodeploy.timer` runs
`/usr/local/sbin/mc-autodeploy`, calls `~/infra/tools/stack sync` for enabled
stack-deploy enrollments, then submits one poll. Sync refuses dirty source,
fetches origin, resolves its default branch (fallback `main`) and fast-forwards.
The enrolled checkout's advance to `7dba861` at 05:57:56 UTC matched the timer's
05:57:47–05:58:07 run; Conductor admitted it at 05:58:08 UTC. Our stale-HEAD guard
stopped before performing any manual fetch or source change.

An earlier source-only inspection missed this surrounding timer and incorrectly
inferred that manual synchronization was required; this corrected account covers
the complete observed workflow. Publish the reviewed commit, then verify that the
standing sync and actual Conductor run reach that exact SHA. Do not reset,
force-update, discard host edits, change global scheduler behavior or race the
timer with manual sync/run submission. Manual and poll triggers have different
idempotency keys. Poll skips active/suspended runs, and the scheduler serializes
commands by enrollment partition, so a later source commit waits for the active
JobTrack release instead of running competing test suites.

**Fixture prerequisite and isolated laptop timing, September 9, 2026:** ordinary repeated fixture
families now copy a per-process synthetic migrated template, with explicit
exceptions preserving cold-init/migration and store-boundary coverage. An eight-store
setup benchmark measured 8.30 s fresh versus 1.08 s including template creation
on the mini. The final local suite passed 917 tests with seven opt-in skips in
56.1 s, against 128.0 s for the initial four-family slice. A corrected, source-hashed
disposable laptop copy passed 914 tests with ten skips in 472.89 s wall, 127.11 s
under the ten-minute cap. The initial failed staging attempt is also documented.
This establishes one isolated run, not a worst-case bound or a Conductor test gate.
That mode-preserving copy alone did not establish actual worktree permissions;
Git does not preserve directory modes. The later synthetic detached-worktree
verification below addresses the audited scheduler's runtime and umask.
Measurement, skip limitations, and regression/review evidence are recorded in
[TEST_STORES.md](TEST_STORES.md). No production policy or deployment changed.

**Synthetic container acceptance, September 9, 2026:** `npm run test:containers`
passed 29/29 tests with zero skips in 11.25 seconds on Node 24.18.0 / macOS arm64,
Docker Compose 5.1.0 / Colima. This includes all seven normally opt-in cases:
discovery host-listener denial; complete networkless resume/letter compilation;
active-PDF, unsafe-URI and oversized-page rejection; forced timeout cleanup;
v3/v4 dense template text/font/link checks; and the real-PDF editorial lifecycle.
The existing renderer image remained
`sha256:dcdeb86662ea2487d1aba825564e4d95d538c44c4edddc31ba6cb4cd078a82ed`;
it was neither rebuilt nor repinned.

The discovery run and cleanup use the same fresh UUID-scoped Compose project,
including its test-only image, instead of the standing project's name. The
renderer timeout check looks for only its exact created container. An explicit
opt-in with Compose unavailable was separately verified to fail before creating
a listener or container. Both inherited store sentinels remained absent and
the private renderer staging directory was empty afterward.

The first run passed six opt-in cases but exposed an obsolete editorial assertion:
existing code routes `changes_requested` to drafting with reviewer findings, not
another approval gate. The corrected test verifies that intended behavior, exact
approved-render binding despite a newer render, exact reviewer feedback, blocked
re-selection, and unchanged ordinary approval history. Independent code review
cleared these test-only changes. This is synthetic container acceptance, not a
live application, email, release, or deployment witness.

The final combined source candidate repeated this complete command after the
reply-intent schema changes: **29/29 passed, zero skips**, 12.924 seconds reported
by Node / 13.093 seconds wall, with both inherited store sentinels still absent.
The same pinned renderer was used. The log is retained locally at
`/var/folders/32/_zypmk8j32330fwfr5lh91c00000gp/T/jobtrack-final-containers-M7SvSV/suite.log`,
SHA-256 `28693ef27f607d3115a3b8bff50891f3bcc4cd8f06a6e8a8d7e1ee08a253725a`.

**Export-copy isolation correction, September 9, 2026:** the source gate now
validates the original store path with `private-source-boundary` before any
source inspection or copying, and pins both `JOBTRACK_HOME` and `JOBTRACK_DB`
to its generated copy. Three synthetic regressions passed, including existing
and absent hostile inherited database overrides and a lexical-only protected
source rejection. The supplied synthetic replica retained its exact bytes and
`0400` mode, unrelated sentinels remained untouched, and the gate removed its
own temporary copies. Independent review and shell syntax checks passed.
No live replica was read or exported to verify this correction, and no Conductor
enrollment or deployed gate script was changed.

**Combined source verification, September 9, 2026:** after the reply-intent and
store-isolation changes, JobTrack's default suite passed **941 discovered / 934
passed / zero failures / seven opt-in skips** in 57.884 seconds (58.036 seconds
wall). Both inherited store sentinels remained absent. A first run exposed one
outdated schema allowlist assertion; its reviewed correction adds the new data
journal and verifies draft approval leaves both intent/start journals empty.
The reply recovery focus independently passed 57/57, including 13 new regressions;
the full email integration file passed 30/30. CLI help smoke and whitespace checks
passed. Applysim's default unit suite passed **643/643, zero skips**, in 20.44
seconds wall, with live integration disabled and both store sentinels absent.
These are source-candidate results, not release, live-reconciliation or clean-drill
acceptance. Recovery's still-open proof boundary is documented in
[EMAIL_REPLY_RECOVERY.md](EMAIL_REPLY_RECOVERY.md).

**Audited synthetic Conductor topology, September 9, 2026:** the final source
candidate passed the actual `scripts/conductor-gate.sh test` command on the
laptop through a copied, unchanged Conductor `execConductorCommand` executor
with its 600,000 ms cap: **941 discovered / 931 passed / zero failures / ten
expected skips**, 479.875 seconds reported by Node and **480.169 seconds wall**.
That observed run leaves 119.831 seconds below the per-command cap; it is not a
worst-case guarantee. The skips are seven container opt-ins (separately passed
locally above) and three Mac-only Swift cases (covered by the local default run).

The reproduction used a new synthetic repository and exact detached commit,
Node 24.18.0 and the audited scheduler's `umask 0022`, not the SSH default `002`.
All 576 archived source files, symlink targets and Git-recorded modes matched
before and after testing; worker-route directories were `0755` inside private
`0700` scratch roots. Actual HOME was unchanged and both explicitly pinned
disposable store sentinels remained absent. No real enrollment, project branch,
live replica or application store was used. Source, executor and log identities,
retained evidence paths and installation caveats are in
[TEST_STORES.md](TEST_STORES.md#audited-synthetic-conductor-topology).

The install gate separately passed in 0.110 seconds against an explicitly
prepared, verified warm synthetic dependency cache. A prior cold install passed
in 126.543 seconds but `npm ci` replaced the synthetic worktree's dependency
symlink with a local directory; that did not warm the primary copy automatically.
A matching stamp plus loadable native dependency can skip installation, but this
witness does not establish the real enrollment's cache state or guarantee cache
reuse on a miss. Neither install time is included in the suite measurement.
At this synthetic checkpoint, source rollout, test-gate activation and an actual
Conductor release had not occurred. The later authorized gate activation above
does not change what these earlier synthetic measurements establish.

During release staging, whitespace checks excluded only the two immutable pinned
Go unified-diff artifacts, `tools/gog/scoped-auth.patch` and
`tools/gog/noninteractive-keychain.patch`: their context-prefix spaces before Go
tabs and blank context line are required patch syntax, not added-source whitespace.
Independent review confirmed every warning and both exact `pin.json` SHA-256s;
all other staged source passed the whitespace check. No patch bytes were rewritten.

# JobTrack 2.0.0 release verification (2026-08-01)

## Scope of this release

`v2.0.0` is a **source and artifact release only**. Nothing here deployed a
service, built or promoted an image, exposed a route, touched a live mailbox,
created a native draft, or sent anything. The retired v0.7 deployment remains
absent by design and is not a rollback target.

It carries the ten previously unreleased `main` commits (skills evidence, UUID
identity, public-profile export and its v2 contract, presentation controls,
repositories, the project graph, private-URL scrubbing, the optional Mission
Control drift sync, and the G03 schema adoption) plus the seven B07 drafting
and approval commits, ending with the standalone out-of-process draft runner.

## Gate results at the cut

```text
toolchain            Node 22.22.0 (~/.openclaw/tools/node/bin/node), ABI 127
npm test             425 discovered / 421 passed / 0 failed / 4 opt-in container skips
npm run smoke        passed; all eight `email outgoing-*` verbs present in help
npm audit --omit=dev 0 vulnerabilities
git diff --check     clean
node --check         every tracked .js file plus the runner and its modules
pinned fixtures      Execution Contracts tree verified (73 files, exact digests)
vendored engine      Mission Pipeline 1.0.0 / d22fb89a verified byte-for-byte — the ONLY engine
                     (fabric worker, reply-draft runner, triage panel, all via lib/engine-v2);
                     SqliteUnitStore passes the engine's UnitStore + GraphStore conformance suites (43 cases)
vendored LLM client  Mission EAL v0.2.0 / 62db3463 verified byte-for-byte (triage panel resolver)
public export        `jobtrack export public-profile` exits 0 against the live
                     store and validates against public-profile.v2.schema.json
tailscale funnel     off; no JobTrack route exposed
```

## Migration rehearsal against the preserved store

Rehearsed on a **restored copy**; the canonical store was never opened for
writing. Backup `jobtrack-pre-v2.0.0-20260801T165500Z.db` was taken with the
WAL-aware online backup API and verified before use (integrity `ok`, zero
foreign-key violations, schema 11, 234 tables).

```text
inherited tables compared  233
inherited row drift        none
migration ledger           28 -> 30 rows (exactly the two new migrations)
new tables added           11, all empty (additive migrations seed nothing)
integrity after            ok
foreign-key violations     0
second migration pass      idempotent; byte-stable table projections
```

## Security evidence for the outgoing authority boundary

Two consecutive earlier candidates (`0e1eeb1`, `5251ee4`) were rejected by
independent audit at the injected cryptographic callback boundary. Both
findings are closed in this release, and the boundary was then re-audited
adversarially: six independent attackers ran 428 hostile constructions across
the signer classifier, the byte-copy path, the key resolver, the verification
sequence, durable-state atomicity, and fresh-clone reproducibility.

Ten non-informational findings were claimed and independently verified. Nine
were refuted on reproduction, including both claimed release blockers — options
are snapshotted before any callback runs, so a poisoned global cannot forge the
pinned-key comparison. One was confirmed at hardening severity: Node's
`Buffer.prototype.toString` resolves `this.length` through
`%TypedArray%.prototype`, so a replaced intrinsic executed a trap while the
module encoded its own trusted copy.

That finding is fixed by removing the dependency (base64 is now encoded and
decoded by index arithmetic, verified against Node's implementation over 6,200
random signatures) and by treating a moved prototype chain as a compromised
environment: both privileged modules verify the chain before handling key
material and refuse outright if it has moved.

Permanent regression coverage: 27 hostile signer constructions, 7 hostile
resolver constructions, 11 poisoned globals, and a replaced typed-array
prototype chain — each asserting zero trap executions and zero durable review,
approval, or operation rows.

## Draft runner

`bin/jobtrack-draft-runner.js` is covered by 17 tests spanning the vendored
engine pin, its dependency isolation, the compiled DAG's stable digest, the
happy path, deterministic replay, every mapped event kind, prompt-injection
resistance, evidence admissibility, each refusal path, every effect and
capability claim, hostile composer behavior, the sensitive scan, and the
process boundary itself. The web image explicitly removes `lib/draft-runner`.

## What this release does NOT close

Gate G07 remains open. It additionally requires the Inbox-side fixed-command
relay and PostgreSQL thread resolver (tasks 52-53), the native Apple Mail host
and sender (B08), and an independent audit of this exact commit. No checklist
task is credited from this document alone.

---

# G03 provider-neutral outgoing authority candidate (2026-08-01)

## Candidate scope

This is repository candidate evidence, not a release or deployment record. Migration
`2026080101 / provider_neutral_email_outgoing_core` was exercised only against disposable test
stores. No live store, deployed service or image, provider adapter, credential, mailbox, native
draft, model runtime, or send operation was changed or invoked. No route was added and the
existing web surface received no mutation capability.

The additive G03 lane implements deterministic source-digest-pinned standalone drafting
requests/results, immutable `email-reply-draft-proposal.v3` and exact
`email-approved-content.v1`, capture-only not-sent draft evidence, exact private review,
append-only authenticated approve/reject events, Ed25519 `approval-receipt.v2`, data-only
one-send `email-send-request.v2`, invalidation, and signed terminal/indeterminate receipt
correlation. The frozen v1 lane remains inert history. The CLI is the supported writer; the web
continues to expose only collapsed historical metadata over GET/HEAD.

## Candidate gates

- Provider-neutral contract, persistence, and CLI focus: 22/22 passed.
- Historical email and web compatibility focus: 63/63 passed.
- `npm test`: 395 discovered; 391 passed; 0 failed; 4 existing opt-in container tests skipped.
- `npm run smoke` passed and includes all bounded `email outgoing-*` verbs in CLI help.
- Adversarial coverage includes hostile object shapes, canonicalization and digest-domain drift,
  source/generation/manifest/account/recipient/thread/content drift, stale projections, exclusive
  expiry, supersession, invalidation, idempotency conflict, key-pin/signature/channel failure,
  atomic crash rollback, replay, second-attempt denial, and `sent` / `duplicate` / `failed` /
  `indeterminate` receipt transitions without retry authority.
- Tests use synthetic human identities and ephemeral in-memory Ed25519 keys only. No real human
  decision, private-key value/reference/path, provider receipt, or send result was fabricated or
  persisted as production evidence.

---

# JobTrack 0.7.0 verification

## Outcome

JobTrack v0.7.0 is deployed at:

https://mac-mini.example-tailnet.ts.net:8444/

The service remains private to the Tailnet. Funnel is off. Port 8444 still proxies only to
`127.0.0.1:3000`; the other Tailscale Serve mappings were unchanged.

Release records:

- Runtime code revision: `1e8b85406dd6e6190ee3e9937df9bd517e28838e`
- Git release tag: `v0.7.0`
- Web image: `jobtrack-web:v0.7.0`
- Web image ID: `sha256:8d6e26d0e36b02a49f52844a9a180daaa799eb4e0d6f669bd2dadd5f7809f4dc`
- Schema: 11 (unchanged)
- Latest migration: `2026071803` (unchanged)
- Release date: 2026-07-27 America/Los_Angeles

## Delivered behavior

- Provider-neutral v2 email facts and correlation preserve the existing v1 boundary while adding
  strict execution usage, draft provenance, approval, send request, and send receipt contracts.
- Research-assisted reply drafting composes only through the bounded network policy and records
  durable budgets, receipts, correlation, and review state. Approval never implies sending.
- Provider outcomes, including skipped-duplicate and failed outcomes, are preserved as immutable
  facts. JobTrack itself still has no OAuth credential or provider mutation authority.
- The web view adds a GET/HEAD-only reply lifecycle summary. It renders bounded collapsed metadata
  while omitting exact addresses, subjects, bodies, draft prose, provider payloads, and credentials.
- Material render-path validation now compares like-normalized paths.

## Repository and candidate gates

- `npm test`: 309 discovered; 305 passed; 0 failed; 4 opt-in container tests skipped.
- `npm audit --omit=dev`: zero vulnerabilities.
- `git diff --check`, CLI smoke, and the focused web security suite passed.
- The first v0.7 candidate failed closed because the image omitted a discovery policy module now
  required by the web read model. The Dockerfile and static regression gate were fixed in
  `1e8b854`; the failed candidate never replaced production.
- The rebuilt exact candidate returned 200 on `/`, `/applications`, `/applications/1`, `/openings`,
  `/opportunities`, `/discovery-proposals`, `/interviews`, `/profile`, and `/healthz`; POST returned
  405 and private no-store, Content Security Policy, frame, referrer, content-type, and permissions
  headers were present.

## Production proof

- Local and Tailnet checks returned 200 for every primary route and `ok` for `/healthz`; local and
  Tailnet POST returned 405.
- The running image is labeled version `0.7.0` and revision
  `1e8b85406dd6e6190ee3e9937df9bd517e28838e`.
- The container runs as `502:20` with read-only root and `/jobtrack` bind, restart
  `unless-stopped`, all capabilities dropped, `no-new-privileges`, bounded PID/memory/CPU limits,
  and only `127.0.0.1:3000` published.
- The image contains no Docker CLI, TeX engine, qpdf, pdfinfo, or pdftotext.
- The live SQLite store remained at schema 11, passed `quick_check`, and had zero foreign-key
  violations. No migration was applied.

## Backup and rollback

The verified pre-v0.7 online backup is:

`~/.jobtrack/backups/jobtrack-v0.6.0-pre-v0.7.0-20260728T011502Z.db`

- SHA-256: `c57c24893a66114ff3180e7f05f3b3354b3a880898caf4012088c88ac8047383`
- mode / owner: `0600`, `cole:staff`
- `quick_check`: `ok`; foreign-key violations: zero; schema: 11

The exact v0.6 web rollback image remains tagged `jobtrack-web:v0.6.0`:

`sha256:c901ebea4c58848257ef7338fff7766623c9cf2855227483979fb00f32398efc`

Rollback requires no schema downgrade: recreate the web service with the v0.6 image and retained
runtime revision, then verify local/Tailnet health, loopback binding, read-only mounts, and the
schema-11 integrity checks. Preserve the current database and WAL/SHM as a forensic set before any
database restoration.

---

# JobTrack 0.6.0 verification

## Outcome

JobTrack v0.6.0 is deployed at:

https://mac-mini.example-tailnet.ts.net:8444/

The service remains private to the Tailnet. Funnel is off. Port 8444 still proxies only to
`127.0.0.1:3000`; the other six Tailscale Serve mappings were unchanged.

Release records:

- Runtime code revision: `300eee0a2e428644797caef6c1b31f13efa23413`
- Git release tag: `v0.6.0`
- Web image: `jobtrack-web:v0.6.0`
- Web image ID: `sha256:c901ebea4c58848257ef7338fff7766623c9cf2855227483979fb00f32398efc`
- LaTeX renderer image: `jobtrack-latex-renderer:v0.6.0`
- Renderer image ID: `sha256:4dc5211bc4434c0d90edd21c55d7b9831eec5d6519f264e128e2d433616e3307`
- Schema: 11
- Migrations: `2026071801`, `2026071802`, and `2026071803`
- Release date: 2026-07-18 America/Los_Angeles

## Delivered behavior

- A frontier-model application strategist now works through a strict declarative control plane:
  exact two-pass context, immutable plan revisions, human review/selection, dependency work queue,
  model-class routing policy, bounded receipts/budgets/escalation, source checkpoints, and typed
  same-application bindings. JobTrack itself has no generic executor or model credentials.
- Email communication style now separates bounded recipient register, a reviewed Cole-owned voice
  revision, and a purpose-specific tone decision. Profiles use at most eight eligible observations,
  require reviewed contact binding for cross-thread aggregation, expire after 180 days, and never
  infer personality/protected traits or authorize identity mimicry. Reply drafts remain recipient-
  locked, reviewed proposals with permanent no-send state.
- New resume and cover-letter revisions are complete, self-contained LaTeX documents. A fixed
  digest-pinned, networkless Docker renderer produces private immutable PDFs. Human approval pins
  the exact PDF; readiness, package creation, and submission recording rehash its bytes and full
  renderer/active-content provenance.
- The renderer rejects scripts, launch actions, embedded payloads, forms/XFA, remote actions,
  unsafe URI schemes, escaped-name evasions, symlink/extra output, oversized bytes, and oversized
  geometry on every page. Stock `hyperref` internal destinations and bounded safe links work.
- Default CLI projections redact material/package payloads and managed paths; deliberate exact
  reads are required. Web projections expose bounded strategy, communication, and render metadata,
  retain GET/HEAD-only behavior, and serve neither PDFs nor compiler/model payloads.

## Repository and renderer gates

The frozen runtime code is commit `300eee0` (implementation commit `ee902cf`, followed by the
Colima loopback-topology correction).

- `npm test`: 217 discovered; 213 passed; 0 failed; 4 opt-in container tests skipped.
- `npm run test:latex-container`: 8/8 passed, including successful complete resume and cover-letter
  fixtures, hostile PDF action/URI/geometry rejection, and forced timeout cleanup.
- `npm audit --omit=dev`: zero vulnerabilities.
- Node syntax, renderer shell syntax, `git diff --check`, strict CLI flag, web security, copied-live
  migration, package tamper, source staleness, protected-data redaction, and append-only invariant
  gates passed.
- Independent strategy, email-security, LaTeX/security, and deployment reviews cleared all release
  blockers. The final focused LaTeX/material/web/security gate passed 60/60 plus the real 8/8 gate;
  strategy CLI/domain tests passed 17/17; combined email/web/security tests passed 26/26.

## Renderer recovery artifact

The exact renderer image is preserved because rebuilding against live Debian package repositories
is not guaranteed to reproduce the pinned image ID:

`~/.jobtrack/images/jobtrack-latex-renderer-v0.6.0-4dc5211bc443.tar`

- SHA-256: `9349369b85b7420fd43e58eab59d6adb3885ddfa2a6418e60e95420d257c9e6c`
- mode / owner: `0600`, `cole:staff`
- size: 143 MiB

The deployed web image contains no TeX engine, qpdf/poppler tool, Docker CLI/socket, or renderer
mount. Re-running `npm run latex:image` may retag a different image; rendering then fails closed
until the source pin and release evidence are deliberately updated.

## Migration, backup, and rollback

The copied-live schema-10 rehearsal used an online SQLite backup. All 187 inherited table
projections remained byte-equivalent. Migration replay was byte-stable, `quick_check` returned
`ok`, foreign-key checks returned zero rows, and no policy/plan/work, communication-style,
voice/tone, render, render-review, package-render, or submission state was invented.

The verified pre-migration rollback database is:

`~/.jobtrack/backups/jobtrack-v0.5.0-pre-v0.6.0-20260718T172606Z.db`

- SHA-256: `e801ba71cff44ebcb82c011be4d26300d631dd591ece14c466fe85be7b210de9`
- mode / owner: `0600`, `cole:staff`
- `quick_check`: `ok`; foreign-key violations: zero; schema: 10
- applications / opportunities / profile entries: 4 / 11 / 39

The exact v0.5 web rollback image is tagged `jobtrack-web:v0.5.0-rollback`:

`sha256:0eb01e621b233a3f2fd70997ff026f6ac9bc81c07518fafc20e4ae71b5ce29a9`

After live migration, schema 11 contained the exact three v0.6 ledger rows once, preserved the
4 / 11 / 39 baseline counts, passed integrity/foreign-key checks, and contained zero strategy
plans/work, email observations/profiles/voices/tones, material renders, or render bindings.

The verified post-migration baseline is:

`~/.jobtrack/backups/jobtrack-v0.6.0-post-migration-20260718T172737Z.db`

- SHA-256: `9555ba317d990b0c818f60c881a15e5274a167199535365954846f7424083d51`
- mode / owner: `0600`, `cole:staff`
- `quick_check`: `ok`; foreign-key violations: zero; schema: 11

Rollback pairs the verified schema-10 backup with the exact v0.5 image. Before restoration, stop
the v0.6 web/writers and preserve the schema-11 database plus WAL/SHM as a forensic set; restore
the backup with private modes and no stale sidecars, recreate the v0.5 container, then recheck
schema 10, health, loopback, and Tailnet routes.

## Candidate and production runtime

The revision-labeled candidate was started against an independently migrated live-store copy.
All primary routes returned 200, POST returned 405, schemas loaded inside the image, and private
security/no-cache headers were present. The candidate and production checks proved:

- healthy runtime image revision `300eee0a2e428644797caef6c1b31f13efa23413`;
- user `502:20`, read-only root filesystem, and read-only `/jobtrack` bind;
- restart policy `unless-stopped`, all Linux capabilities dropped, and `no-new-privileges`;
- only `127.0.0.1:3000` published;
- no Docker socket/CLI, TeX engine, qpdf, pdfinfo, or pdftotext;
- `/tmp` is the only writable runtime filesystem;
- local and Tailnet HTTP 200 on `/`, `/applications`, `/applications/1`, `/openings`,
  `/opportunities`, `/discovery-proposals`, `/interviews`, `/profile`, and `/healthz`;
- local and Tailnet POST 405; no-store, deny-by-default Content Security Policy, frame denial,
  no-referrer, content-type protection, restricted permissions, and same-origin policies.

Colima does not publish host ports from Docker `internal` networks, so the web service retains the
ordinary bridge used by v0.5. The process has no credentials or network-using integration, but
bridge-level outbound connectivity remains a documented defense-in-depth follow-up; renderer and
discovery-worker network isolation are unchanged.

---

# JobTrack 0.5.0 verification

## Outcome

JobTrack v0.5.0 is deployed at:

https://mac-mini.example-tailnet.ts.net:8444/

The service remains private to the Tailnet. Funnel is off. Tailscale Serve still maps only port
8444 to loopback port 3000; the six other host mappings were not changed.

Release records:

- Runtime code revision: `d899986607cd9c75bb152f561f52e1f45b25c9a4`
- Git release tag: `v0.5.0`
- Runtime image: `jobtrack-web:v0.5.0`
- Runtime image ID: `sha256:0eb01e621b233a3f2fd70997ff026f6ac9bc81c07518fafc20e4ae71b5ce29a9`
- Schema: 10
- Migrations: `2026071715`, `2026071716`, and `2026071717`
- Release date: 2026-07-17 America/Los_Angeles

## Delivered behavior

- Every managed application has mandatory, application-specific resume and cover-letter material
  identities. Each supports immutable rough draft, refinement, review, approved selection, and
  readiness history; a new draft never silently replaces an approved selection.
- Application-form reconnaissance imports inert, closed-schema observations for known steps,
  hidden/conditional branches, fields, options, constraints, and stable provider field identities.
  Captures are reviewable and versioned. No capture action logs in, advances a form, uploads a
  file, contacts an employer, or submits an application.
- Narrative and choice questions become exact-field `form-answer` materials. Protected questions
  are human-only. Normal list/readiness/web output redacts protected prompts, labels, options,
  answers, review notes, uncertainty reasons, paths, and package payloads.
- Generation uses a two-pass boundary: inspect a bounded metadata catalog, then select exact
  same-application artifacts/profile entries/approved story uses. Every draft pins the exact source
  IDs and an optimistic source-state digest; refinements also bind their parent revision.
- Readiness fails closed for missing or stale custom documents, answers, assessment approval,
  profile-information resolutions, form coverage, selected evidence, pending form revisions,
  conditional applicability, required uploads, package bytes, or exact source digests.
- Migration `2026071717` adds append-only exact-field states (`applicable`, `fulfilled`,
  `not-applicable`, `blocked`). Required file uploads bind a same-application managed artifact and
  its bytes; conditional fields need an explicit current applicability decision.
- Package creation binds the exact reviewed resume, cover letter, answers/options, information
  resolutions, form state, human field evidence, assessment, export policy, and attachment bytes.
  Reused idempotency keys conflict when normalized build inputs differ.
- `record-submission` only records a submission after Cole performs it externally. It re-verifies
  current readiness and the immutable package binding; JobTrack has no browser submission or email
  sending authority.
- `/applications/:id` is the read-only application preparation workspace. Existing pipeline,
  application, opening, opportunity, discovery, interview, and indexed profile pages remain intact.

## Repository gates

The clean deployed code freeze is commit `d899986`.

- `npm test`: 182 discovered; 181 passed; 0 failed; 1 opt-in container test skipped.
- `JOBTRACK_RUN_CONTAINER_TESTS=1 npm run test:discovery-sandbox`: 22/22 passed, including the live
  host-local network-isolation check.
- `npm audit --omit=dev`: zero vulnerabilities.
- Node syntax checks passed for the CLI, server, every library module, and every test file.
- `git diff --check`, clean-tree checks, and production Docker Compose resolution passed.
- Independent review cleared the pending-form bypass, public arbitrary-package binding, required
  upload/conditional-field dead ends, permissive timestamp parsing, privacy projections, package
  staleness, and migration-ledger regressions. Its focused release gate passed 52/52.

## Migration recovery and copied-live rehearsal

An earlier prototype had already written migration-ledger entries `2026071715/16` into the live
database while leaving older incompatible table and trigger definitions. The v0.4 container was
still serving normally, but an in-place migration was rejected during release rehearsal.

The verified pre-v0.5 schema-9 backup was:

`~/.jobtrack/backups/jobtrack-v0.4.0-pre-v0.5.0-20260718T025905Z.db`

- SHA-256: `dfb4f7fea7e8ab91b21b8da45406b42637986411f33df82064498483d6049306`
- mode / owner: `0600`, `cole:staff`
- `quick_check`: `ok`
- foreign-key violations: zero
- schema: 9
- applications / opportunities / profile entries: 4 / 11 / 39

Every row projected through all 144 schema-9 tables was compared against live before restoration:
709 rows, zero mismatches. All prototype v0.5 form captures, material revisions, reviews, packages,
field resolutions, and submissions were empty; only deterministic vocabularies and backfills
existed.

The prototype database, WAL, and SHM were stopped and moved intact to:

`~/.jobtrack/quarantine/pre-v0.5-restore-20260718T052911Z/`

A separate consistent prototype backup is preserved at:

`~/.jobtrack/backups/jobtrack-v0.5.0-prototype-pre-restore-20260718T052835Z.db`

- SHA-256: `986f59392cf1da63101f8e651b4f9810653ddf04497ed98a041efd8c0156c5e6`
- This is a forensic/rollback artifact for the prototype state, not a database to run with v0.5.

The schema-9 backup was restored, migrated twice with current code, and compared to the independent
rehearsal. Both produced exactly 565 schema objects with SHA-256
`a5c8e6ba5dff52a71424ff3a0a7121540081b3d7c2f604321e0113bd4735a828`.
All 144 inherited tables and 709 rows remained unchanged.

Final migration state:

- `quick_check`: `ok`
- foreign-key violations: zero
- `user_version`: 10
- migrations `2026071715 application_form_reconnaissance`,
  `2026071716 versioned_application_materials_and_readiness`, and
  `2026071717 exact_application_field_fulfillment` present exactly once
- applications / opportunities / profile entries: 4 / 11 / 39
- preparation plans / baseline requirements / material identities: 4 / 8 / 8
- form revisions / material revisions / field resolutions / packages / submissions: 0 / 0 / 0 / 0 / 0

A verified post-migration baseline is preserved at:

`~/.jobtrack/backups/jobtrack-v0.5.0-post-migration-20260718T053003Z.db`

- SHA-256: `a589cd3874161541b1d1f62ae55e0146878e7340e6796f1d4c00bef910e08e66`
- mode / owner: `0600`, `cole:staff`
- `quick_check`: `ok`; foreign-key violations: zero; schema: 10

## Candidate and production runtime

The exact candidate image started against a restored/migrated private store copy under the same
non-root, read-only, capability-dropped constraints used in production. Every primary route
returned 200, POST returned 405, and security/no-cache headers were present.

The deployed container reports:

- healthy and running
- image revision `d899986607cd9c75bb152f561f52e1f45b25c9a4`
- user `502:20`
- read-only root filesystem
- `~/.jobtrack` mounted read-only at `/jobtrack`
- restart policy `unless-stopped`
- all Linux capabilities dropped
- `no-new-privileges` enabled
- only `127.0.0.1:3000` published

Local and Tailnet checks returned HTTP 200 for:

- `/`
- `/applications`
- `/applications/1`
- `/openings`
- `/opportunities`
- `/discovery-proposals`
- `/interviews`
- `/profile`
- `/healthz`

POST returned 405 on both paths. Responses include no-store caching, a deny-by-default Content
Security Policy, frame denial, no-referrer, content-type protection, restricted permissions, and
same-origin opener/resource policies.

All seven Tailscale Serve mappings still report `tailnet only`. Port 8444 still proxies to
`127.0.0.1:3000`. Funnel is off. No Tailscale configuration command was needed.

## Deliberate boundaries and follow-ups

- JobTrack has no application authentication; Tailnet membership and Access Control Lists (ACLs)
  remain the privacy boundary.
- External material generation is agent-driven and evidence-bounded. The CLI stores exact text and
  provenance; it does not contain a hidden text generator.
- Form reconnaissance remains passive and human-navigated. Multi-step fields that cannot be seen
  without a human advancing the provider form remain explicit coverage uncertainty.
- No application materials have been invented for the four existing applications. Only baseline
  resume/cover-letter identities and requirements were conservatively backfilled.
- The installed/legacy JobTrack skill was not mutated. Its pending Skill Workshop proposal must be
  revised for v0.5 and remains unapplied until Cole explicitly approves or rejects it.
- Email sending, employer contact, automatic form filling, final application submission, and
  recurring discovery scheduling remain disabled.
- The `node:22-bookworm-slim` Dockerfile tag remains mutable even though this build resolved a
  concrete base-image digest.
- Tailscale reports a client/daemon build mismatch while service health remains normal.
- No Docker prune was run; v0.4 rollback and v0.5 candidate images remain preserved.
