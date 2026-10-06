# Disposable test stores

`test-support/migrated-store.js` provides two layouts over the same template:

- `createTestStore(prefix?)` returns `{ root, home }`, with `home` at `root/store`.
- `createTestHome(prefix?)` returns a flat home directory for fixtures whose
  existing cleanup owns only that directory.

Use them when a test needs the current, empty CLI schema before arranging its
synthetic domain data. Close database handles and stop servers before removing
the owned directory in the test's cleanup hook. Flat and nested fixtures share
one template per process and never share writable database or attachment files.

The first call in each process runs this checkout's real `jobtrack init --json`
in a private temporary directory, explicitly overriding both `JOBTRACK_HOME`
and `JOBTRACK_DB`. It checkpoints SQLite, checks integrity, closes the database,
and protects the template file as read-only. Each call copies that file into a
new private store with an empty `attachments/` directory. No source or destination
store can be supplied. Templates are not reused between processes or runs and
are removed on normal process exit. Abrupt termination such as SIGKILL can leave
disposable temporary directories, as with other fixture helpers.

```js
const { createTestStore } = require('../test-support/migrated-store');

test('example', (t) => {
  const { root, home } = createTestStore('jobtrack-example-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Run the behavior under test against home. Pin both store environment
  // variables when spawning CLI commands; close handles before cleanup.
});
```

Keep cold-start, migration upgrade/replay, and store-permission repair tests on
their existing fresh or deliberately old schemas. Copying is fixture setup;
every actual CLI command still executes its normal production migrations and
UUID assignment. Seed UUIDs are shared between copies within one test process;
each copied store is an independent synthetic database, not a source for merging
or exporting durable identities. The web and CLI production architecture is
unchanged.

Adoption now covers ordinary repeated setup across application, form, material,
interview, fabric, profile, catalog/export, email, and web fixtures, including
implicit initialization by a first domain CLI command. The shared outgoing-email
seed helper also uses a flat copied home and cleans any helper-owned stores its
callers leave behind. The domain-specific migrations and assertions remain in
place. Fixture CLI/server subprocesses pin both store environment variables;
read-only email correlation includes a disposable inherited `JOBTRACK_DB`
override regression. Web teardown waits for the server before deleting its store.

The remaining cold or minimal setups are deliberate:

- `core-invariants.test.js` and `identity.test.js` retain their fresh stores,
  including schema initialization, permission repair, and initial UUID assignment.
- The helper's own cold comparator and six explicitly marked email migration or
  legacy-policy cases still run real initialization; `dual-write-integrity` keeps
  its mid-test migration replay.
- The old profile schema, missing-store web response, exact sibling-store/shared
  temporary-directory security case, and opt-in editorial container lifecycle
  retain their original layouts and setup.
- Private-source rejection, minimal/in-memory migrations, fabric store-replacement
  tests, renderer/provider staging, and separate engine evidence stores are not
  full-schema JobTrack fixtures and do not use the template.

## Reproduce

```sh
node --test test/test-store.test.js test/application-materials.test.js \
  test/email-integration.test.js test/fabric.test.js test/fabric-tick.test.js \
  test/identity.test.js test/core-invariants.test.js test/private-source-boundary.test.js
node scripts/benchmark-test-store.cjs
env -u NODE_ENV -u JOBTRACK_HOME -u JOBTRACK_DB \
  -u JOBTRACK_RUN_CONTAINER_TESTS -u JOBTRACK_RUN_LATEX_CONTAINER_TESTS npm test
```

The benchmark accepts `--samples 2..100` (default 8). It measures only disposable
fixture setup, excludes cleanup symmetrically, reports the first template
initialization separately, and includes it in the copy batch total. Run it without
other tests competing for resources. It does not measure the whole suite or
change a Conductor manifest.

## September 9, 2026 local evidence

On Node 24.18.0, macOS arm64, better-sqlite3 11.10.0 / SQLite 3.49.2:

- Eight fresh CLI initializations: 8,301 ms total, 1,038 ms mean.
- Eight template copies including initialization: 1,079 ms total, 135 ms mean.
- First template creation and copy: 1,053 ms; seven warm copies: 3.7 ms mean.
- Setup batch ratio: 7.69×. This is not a whole-suite speedup claim.
- Focused verification: 107/107 tests passed, including the six new helper
  regressions and preserved cold-start, UUID, and private-source-boundary tests.
- Initial-slice full suite: 923 discovered, 916 passed, zero failures, seven opt-in
  container cases skipped, 128.0 seconds. CLI help smoke, syntax checks, and
  `git diff --check` passed. This local run does not establish laptop timing.
- Two independent reviewers found no remaining blocking issue after fixture CLI
  calls were changed to pin inherited database-path overrides.

The follow-up adoption added one regression for flat/nested template reuse,
private permissions, CLI/attachment isolation, and cleanup. Its focused runs
passed 7 helper tests, 105 domain tests, 34 web tests, and 180 email/shared-seed
tests; these groups overlap and are not additive totals. Independent review found
two pre-existing email web teardown hooks that could remove stores before server
shutdown. Both now stop first, with a further 2/2 focused check.

The expanded local suite passed 924 discovered / 917 passed / zero failures /
seven opt-in skips in 55.8 seconds, compared with 128.0 seconds for the initial
slice on this host. The final teardown corrections additionally passed their
focused tests. These timings describe these two observed runs; the setup-only
7.69× benchmark above is a different measurement. Independent review of the
expanded helper, conversions, retained coverage, and teardown corrections found
no remaining actionable issue.

The final local rerun, including all teardown and laptop-portability corrections,
again passed 924 discovered / 917 passed / zero failures / seven opt-in skips in
56.1 seconds (56.24 seconds wall). Both inherited store variables pointed at
disposable sentinel paths, and neither path was created.

The later combined source candidate, including export-copy isolation and reply
intent recovery, passed **941 discovered / 934 passed / zero failures / seven
opt-in skips** in 57.884 seconds (58.036 seconds wall). Its first full run had
one stale schema allowlist assertion: the new declarative send-start journal was
not listed. The corrected test retains all no-send assertions and additionally
requires both reply intent/start journals to remain empty after draft review;
independent review cleared it. The passing rerun left both inherited store
sentinels absent. Its log is retained locally at
`/var/folders/32/_zypmk8j32330fwfr5lh91c00000gp/T/jobtrack-final-default-cUgYGq/suite.log`,
SHA-256 `808f1c1756d0479e2d7b5dbad7782f1b6d08f4b232796399c0a673d81ef9c034`.
CLI help smoke and `git diff --check` passed. These later totals supersede the
earlier candidate's totals without changing the setup-only benchmark claim.

Selection was reconciled against both repositories and Mission Control's
project-specific plan records: seven JobTrack plans were marked complete (latest
`application-assistance-v1`, September 6); Applysim's September 1 record lagged its
newer repository implementation records. Shared briefs were already built, while
Applysim's clean live repeats and second-mailbox acceptance remained outstanding
ahead of Phase M. None of that acceptance is credited to this local test slice.

## Laptop verification

The follow-up uses a disposable source copy on the production laptop, not its
deployed checkout or any personal store. `/opt/node/bin` supplies Node 24.18.0 and
npm 11.16.0; the ordinary SSH PATH instead resolves unsupported Node 18.
An isolated `npm ci --no-audit --no-fund` installed 219 packages successfully,
and better-sqlite3 11.10.0 / SQLite 3.49.2 loaded on Linux x64. Installation is
separate from the suite timing.

The first disposable laptop run finished in 478.09 seconds, under the cap, but
failed: 924 discovered, 900 passed, 14 failed, ten skipped. It is not passing
acceptance evidence. The file-only archive omitted directory modes, so extraction
under the laptop's `umask 002` made the worker route group-writable; the production
route guard correctly refused it. Other failures exposed tests that assumed the
current checkout was the fixed Mac deployment path, used Mac-only protected-path
negative strings, or created positive pin-fixture parents with permissive modes.

The follow-up changes are test-only: deployment-artifact assertions retain their
reviewed fixed Mac route, protected negative paths use the host's lexical home
boundary without opening them, and positive pin-fixture directories explicitly
use `0700`. Deliberately weakened permission rejection cases remain unchanged.
All 24 targeted tests passed under `umask 002`; independent review repeated them
under `umask 000`, also 24/24. No production permission or source-boundary check
was weakened.

The corrected source archive contains 572 current source files plus 64 explicit
ancestor directory entries, preserving their source modes without recursive
inclusion of unselected files. It includes existing worktree changes, final
teardown fixes, and the test portability corrections. Generated `output/` files
and ignored dependency/runtime trees were excluded; included symlinks resolve
within the source checkout. The archive and source-entry identities are:

```text
archive SHA-256: 25244e81a587c86d75edc50369722d749c18013896e2a434abb01acd631c6c6e
source entry/type/mode/content manifest: 24274ddde1cd453786675a34cd18084bdc77783829fb59e242fca1865e82601a
```

The corrected archive hash was verified before extraction with directory modes
preserved. The four formerly failing suites passed 36/36 targeted tests under
`umask 002`, then the full suite passed: **924 discovered, 914 passed, zero
failures, ten skips, zero cancellations**, exit 0. Node reported 472.510 seconds;
GNU time measured **472.89 seconds wall (7m52.89s)**, 127.11 seconds below the
600-second cap. Skips were seven container opt-ins and three Mac-only Swift
checks; those cases were not verified by this Linux run. Dependency installation
is not included in this measurement.

The run cleared `NODE_ENV` and container opt-ins, pinned both store variables to
nonexistent disposable sentinel paths, and supplied its own private temporary
directory. Neither sentinel path was created. The scratch and temporary roots
remained `0700`; the worker route remained `0755`. GNU `timeout` capped the suite
process group at 600 seconds with a ten-second termination grace; no timeout was
needed. The evidence documentation was updated after this snapshot; source code
changes require a new test snapshot.

The initial failed run and final passing logs are retained under
`/tmp/jobtrack-test-timing.GR2fSP` on the laptop. Final log identities:

```text
final-suite.log SHA-256: 311b131528741b4b98ed2549c81cec9d00f598fecc876d1de51c037d88906ab1
final-suite-time.log SHA-256: 830e8f912f4a72635eda421fe185111b679d69c31c91c0a967dab3b7a422c434
```

A future Conductor gate must verify its actual generated worktree with a supported
Node runtime and trusted worker-route permissions. Git does not record directory
modes; this mode-preserving source archive does not prove that a fresh worktree
created under a permissive umask will pass the route guard. A single isolated
timing also does not establish a worst-case runtime bound or cover skipped cases.

At that checkpoint, Engineering item 1 in `WORK_REMAINING.md` had implemented
ordinary fixture conversion and a passing isolated laptop timing. Conductor-style
worktree verification and separately authorized gate adoption remained; the
later reproduction is recorded below. Deliberately retained cold cases are
coverage choices.
No Conductor enrollment, production policy, personal store, deployment, installed
skill, credentials, mail, or live drill was changed.

## Audited synthetic Conductor topology

The later combined source candidate was verified in a fresh detached Git worktree
inside a new disposable repository on the laptop. This reproduces the inspected
Conductor source-checkout/dependency layout and runs its actual gate command
through a copied, unchanged `execConductorCommand` implementation. It is **not**
an actual enrollment run, source release, deployment or gate activation.

The scheduler's supported Node 24.18.0 and `umask 0022` were used; the ordinary SSH
session's Node 18 and `umask 002` were not. Git worktrees do not preserve archive
directory modes, so fresh worktree directories and the trusted worker route were
checked independently as `0755`. The containing topology and test temporary roots
were `0700`. Both store variables pointed at nonexistent owned sentinel paths;
neither was created, and actual HOME remained unchanged.

The archive contained 576 selected source files/symlinks and 64 explicit directory
entries, including the current uncommitted implementation. Its exact inventory
was force-added only to the synthetic repository so tracked source paths that
also match ignore rules were not lost. Every source file's bytes/type and Git
executable/symlink mode matched before and after the run. The synthetic detached
commit was `b6cebfef9fd425a7687b7d0075a5428a7a770981`; it is not a commit or branch
in the real JobTrack repository. Documentation updates and the unapproved
provider-proof design were added after this snapshot; runtime/test code was not.

```text
archive SHA-256: 0a857a17b3c4f3e601e3e9156f46fe4df1d6cec2cd17c7ba9a32debc734eec68
archived entry/type/mode/content manifest: 8fb6a3902d4add37530bd450d88554534da81e571c36d37ca39557b83dec1086
Git-normalized source manifest content: 42152d3e4949d1cf090a9a446ac6debb61c6643a673da6303153bb3c9cfb6690
raw final-source-manifest.json SHA-256: 3d09c88c547c02fd058661d5bc5dd8737b39b0f9a3005421f437f4b2b7424d4d
copied Conductor node-host.mjs SHA-256: 6f143af7e2170ba9d897b24f81c2309c6bb01eb2469bf63c245df1e37d9df5dc
```

`sh scripts/conductor-gate.sh test` passed through that executor with its actual
600,000 ms cap: **941 discovered / 931 passed / zero failures / ten skips / zero
cancellations**. Node reported 479.875 seconds; executor wall time was **480.169
seconds (8m00.17s)**, leaving **119.831 seconds (19.97%)** below the cap. The exact
skips were the three Mac-only Swift checks and seven opt-in container cases; the
local default and explicit container runs above cover those respective cases.
This is one observed passing run, not a worst-case runtime guarantee.

Installation was verified separately. A cold `install` gate passed in 126.543
seconds with 219 packages and the same lockfile. It replaced that synthetic
worktree's `node_modules` symlink with a local directory, leaving the original
synthetic primary copy unwarmed. The initial harness-only attempt had failed
before installation because both npm configuration paths were `/dev/null`;
the successful retry used distinct task-owned configuration paths. That setup
retry also used a disposable child home; final install/test preserved actual HOME
and isolated only task-specific npm cache/config/devdir/prefix and temporary paths.

The installed dependencies were then copied only into the owned synthetic primary
and verified across 4,733 files/links, modes and link targets. The initial owned
dependency copy was retained separately. With this **explicitly prepared warm
cache**, the final `install` gate passed in 0.110 seconds, correctly skipped
`npm ci`, loaded the native SQLite dependency and preserved the symlink. Neither
install duration is part of the suite timing. This does not prove that the actual
enrollment's primary cache is warm or that a cache miss preserves its symlink.

All witnesses, including the earlier setup failure/success and source comparison,
are retained on the laptop under `/tmp/jobtrack-conductor-topology.Jhr9iy/runner`.

```text
final-test.log SHA-256: 229fde96fe02103ae45281d13ff7ce3559b3eb6e6515412de233a82d3bebd2a7
final-install.log SHA-256: a5779ed085cce9c9f6f614e3bafd740367b7d7d7862e4cf33a08090f60fb92f3
final-test-summary.json SHA-256: 57a764c94f119919c3b8dcf486821db691258170f84edf2ba50d82eebb5c931a
final-gates-summary.json SHA-256: ad84ba787606e00379265442034c60e03a1081555987062f191eb84346f223a7
```

The synthetic topology closes the local reproduction prerequisite, not production
acceptance. At that checkpoint, test-gate enrollment changes and intended source
rollout still required separate explicit authorization. No personal store or live
replica was opened; no mail, live drill, credentials, installed skill, enrollment
or deployed revision changed during these synthetic runs.

The later operator-authorized test-gate activation on September 10 UTC is recorded
in [VERIFICATION.md](VERIFICATION.md). Its real exact-commit Conductor release
record, not these synthetic timing witnesses, determines production acceptance.
