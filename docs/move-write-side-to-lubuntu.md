# Moving JobTrack's write side to Lubuntu

Design, 2026-10-03 (infra `docs/MINI-EXIT.md` plan P3). Owner decisions are
marked **(owner)**. The fabric ([FABRIC_PLAN.md](FABRIC_PLAN.md)), the gates,
the briefs and the store's rules are unchanged. What changes is where the
writers run, how they get code, credentials and the store, and how the viewer
reads.

## Why

The read side already runs on the laptop: infra stacks `jobtrack` and
`jobtrack-applysim`, deployed on merge. The write side is still on the Mac
mini:

- **The store:** the authoritative store is `~/.jobtrack` on the Mini (200 MB):
  - `jobtrack.db` (5.7 MB, WAL) and `pipeline-evidence.db` (0.7 MB);
  - `attachments/` (empty), `fabric/` (16 MB: queue, logs, budgets, the
    dispatch evidence of 2,021 passes), `backups/` (25 MB), `quarantine/`;
  - `images/` (143 MB, the lost v0.6.0 renderer image as a tarball).
- **Three LaunchAgents write to it**, all running the checkout
  `~/.mission-control/projects/jobtrack` (78d6fd8, updated only by manual pulls;
  the code equals `main` today):
  - `com.cole.jobtrack-fabric-daemon`: `fabric daemon` → `fabric dispatch
    --max-workers 3 --notify --json`, safety tick 20 min.
  - `com.cole.jobtrack-fabric`: hourly `scripts/fabric-cron.sh` (tick,
    `fabric/queue.md`).
  - `ai.applysim.fabric-daemon`: ApplySim's applicant loop (`agent-loop.mjs`)
    on the drill store `~/.jobtrack-applysim` (11 MB), against the live careers
    site on Lubuntu.
- **Replication:** the Lubuntu viewer reads a one-way replica pulled every five
  minutes (infra `replication/jobtrack/`).

So a merge to `main` redeploys the viewer only. The workers keep running
whatever the Mini checkout holds, and the store's only backup is the replica's.

Goal: the store and its workers live where the viewer lives. One merge updates
everything, and the replication retires. Development stays with
`agent-jobtrack` on Arch.

## What the survey found (2026-10-03)

| Coupling | Today on the Mini | Consequence for the move |
| --- | --- | --- |
| Activity | 2,017 of 2,021 daemon passes since 2026-09-06 ended `parked`; the last staffed worker ran on 2026-09-06. The last tick: 11 subjects parked at `opportunity.pursue`, nothing else. | A cutover window of minutes delays nothing: everything waits on a person. |
| Runtime | Node v24.18.0 from `~/.openclaw/tools/node` (OpenClaw's tool runtime). PATH includes Homebrew. | The container runs Node 22, the web image's runtime. |
| Codex | codex-cli 0.152.1. Workers share the owner's interactive `~/.codex`: its login and its `config.toml` (model `gpt-6-astra`, effort `xhigh`, plus desktop plugins, MCP servers and a notify hook). | The worker gets its own `CODEX_HOME` and its own login (owner step). The config is versioned (`deploy/worker/codex-config.toml`): same model, effort and tier, no plugins or MCP servers. |
| Gmail | Every pinned-gog call fails closed: `.tools/gog/keychain-access-paused` has been present since 2026-09-08 ([GOG_KEYCHAIN_ROUTING.md](GOG_KEYCHAIN_ROUTING.md)). The inbound relay `ai.applysim.jobtrack-v2-relay-listen-umich` is disabled. | JobTrack has no live Gmail today, so the move loses nothing. Gmail on Linux is its own phase (5). |
| Renderer | `docker` (Colima) on the daemon's PATH. The renderer pin `jobtrack-latex-renderer:v0.6.1@sha256:dcdeb866…` is an arm64 image ID. No render has run in recent ticks. | An amd64 renderer needs its own reviewed pin, wherever it runs. Renders are phase 6. Until then the worker sets `JOBTRACK_RENDERER=off`. |
| Notifications | `JOBTRACK_NTFY_TOPIC` in the plist; the house ntfy over the tailnet; `fabric/notified.json` in the store. | The topic moves into the stack's `.env`, and `notified.json` moves with the store, so nothing is pushed twice. |
| Other writers | OpenClaw's journal agent is instructed to run the Mini checkout's `bin/story-tool.js`, which writes `~/.jobtrack`. Operator CLI acts (gate decisions) happen on the Mini. | After cutover the Mini's `~/.jobtrack` is a tombstone file, so story-tool fails loudly instead of writing to a dead copy or creating a new store. A story route is an owner decision (D7). Operator acts move to `docker exec` on Lubuntu. |
| Shared checkout | OpenClaw main's gog route is `…/projects/jobtrack/tools/gog/main-bin`. `ai.applysim.fabric-daemon` uses the checkout as its JobTrack. | The Mini checkout stays. Only the two production plists are retired. |
| Drill stores | The Mini's `~/.jobtrack-applysim` is ApplySim's *arc* store, written today. Lubuntu's `~/.jobtrack-applysim` (applysim stack) was last written 2026-08-09, and **that** is what the `jobtrack-applysim` viewer shows. | The viewer shows a stale store. Phase 7 moves the arc store and points the viewer at it. |

Nothing in JobTrack reads OpenClaw or private-journal state. The worker container
has no host home, no OpenClaw path and no browser profile, so the private-source
boundary (AGENTS.md) holds structurally on Lubuntu.

## Decisions

1. **Process shape: services of the `jobtrack` stack, not systemd units.**
   - The workers run as two containers of `stacks/jobtrack`, from this repo's
     `Dockerfile.worker`:
     - `jobtrack-worker` runs the daemon;
     - `jobtrack-heartbeat` runs the hourly job.
   - The deploy builds the worker image as `DEPLOY_EXTRA_IMAGES` from the same
     commit as the viewer, so one merge redeploys both. The two images' pins
     move, and roll back, together.
   - Compose profile `worker` gates them. Until `COMPOSE_PROFILES=worker` is in
     the stack's `.env`, no image is built and nothing starts. That is why
     these changes merge ahead of the cutover.
   - Why not systemd units from `~/src/jobtrack`:
     - Lubuntu's cole has `Linger=no`, so user units stop at logout (infra
       ONBOARDING: never a `--user` unit). System units need root to install
       and restart.
     - Nothing restarts a unit on merge.
     - The host's Node is 18 and the CLI needs 22.
     - The deploy checkout is fast-forwarded under a running daemon.
   - Precedent: `stacks/applysim` already runs a writer daemon (the company
     side) as a service of its stack.
2. **The store lives at `/srv/jobtrack/store`** (cole:cole, 0700; files 0600).
   - It is outside every git checkout, as for voice-journey
     (`/srv/voice-journey`).
   - The workers mount it read-write. The viewer mounts the same directory
     read-only (`JOBTRACK_STORE_DIR`), as `jobtrack-applysim` already does over
     a live store. The viewer copies the database under a fingerprint guard, so
     a writer next door is safe.
   - The whole store moves, faithfully (including `images/` and `backups/`).
     Pruning is a later owner choice.
3. **The drill store follows the same pattern later** (phase 7). The arc
   store and ApplySim's applicant daemon move into `stacks/applysim`, not into
   this stack: the daemon is ApplySim code.
4. **Codex: a dedicated `CODEX_HOME`** at `/srv/jobtrack/codex-home`, logged in
   by the owner with `codex login --device-auth`.
   - Never a copy of another login: ChatGPT refresh tokens rotate, so two
     homes sharing one would knock each other out.
   - The image pins codex-cli 0.160.0 (2026-10-04). The Mini's 0.152.1 cannot
     run the worker's model, gpt-6-astra (O2 probe, Status).
5. **Gmail on Linux (phase 5) is the credential edge's pattern**, from infra
   `stacks/mailroom` and inbox-pipeline's `gog-lane`.
   - **Grants:** a JobTrack-own gog home per lane, freshly minted on Lubuntu,
     never a copy of the Mini's Keychain token (the inbox-pipeline policy
     amendment: designated service hosts hold scope-minimized,
     independently revocable grants):
     - `~/.config/gogcli-jobtrack-read`: `<university-account>`, bucket
       `gmail-readonly`;
     - later `-send`.
   - **Keyring:** the file keyring. Its password comes from a 0600
     `keyring.env` and reaches the gog process only.
   - **Projection:** the grant is copied into the container's private tmpfs,
     because gog writes its keyring lock.
   - **Binary:** the transport stays the reviewed single-attempt build. The
     same three patches at the same upstream commit, built for linux-amd64
     with `CGO_ENABLED=0` in an image stage, with its own `pin.json` artifact.
     Never stock gog, never a PATH fallback.
6. **Renders (phase 6)** need two reviewed pieces:
   - an amd64 renderer image pin;
   - a way for the worker to run it without the Docker socket. The socket is
     root on the host, so it is rejected for this container. Options **(owner)**:
     a narrow host-side render broker, or renders by an operator command.
7. **Backups:** the store becomes the primary on Lubuntu.
   - The existing `stack-backup@jobtrack` store lane (nightly, 14-day
     retention, shipped to Arch) backs up `/srv/jobtrack/store` as soon as
     `jobtrack.db` exists there; `backup.conf` switches on that test, so the
     cutover needs no edit.
   - Every top-level `*.db` goes through `sqlite3 .backup` plus `quick_check`;
     everything else (attachments, `fabric/`, `backups/`, `images/`) goes into
     `store-files-<UTC>.tar.gz`.
   - The Codex home and gog homes are credentials and are never backed up.
8. **The release gate copies the live store safely.**
   - The Conductor's `export-contract` used to `cp -R` the replica. It now
     copies `jobtrack.db` through `scripts/lib/store-snapshot.cjs`: the online
     backup API when a WAL is live, otherwise a fingerprint-guarded byte copy
     that never leaves sidecars beside the source. Its argument moves from the
     replica to `/srv/jobtrack/store` after cutover (owner-approved enrollment
     change, D6).
9. **Replication retires after cutover.** The order is in "Retire the
   replication" below.

## Target architecture

```text
 Arch: agent-jobtrack ── PR ──▶ github main ──▶ Lubuntu mc-autodeploy → Conductor (gate: install, test, export-contract)
                                                      │ tools/stack deploy jobtrack
                                                      ▼
 Lubuntu: infra stack `jobtrack`
   ├─ ts-jobtrack ── serve https://jobtrack.<tailnet> (tailnet only)
   ├─ web       jobtrack-web:<sha>         store :ro   (viewer)
   ├─ worker    jobtrack-web-worker:<sha>  store :rw + /codex-home   egress bridge 10.253.88.0/28 → OpenAI, public GETs, ntfy
   └─ heartbeat jobtrack-web-worker:<sha>  store :rw   network none
                 │
                 ▼
   /srv/jobtrack/store   jobtrack.db (WAL) · pipeline-evidence.db · attachments/ · fabric/ · fabric.sock
   /srv/jobtrack/codex-home   auth.json (owner login) · config.toml (from the image)
   stack-backup@jobtrack (nightly) → ~/.mission-control/backups/stacks/jobtrack → Arch
```

The worker runs `scripts/fabric-worker-service.sh`. It execs
`fabric daemon --pass-command "fabric dispatch --max-workers 3 --notify --json"
--safety-tick-ms 1200000`, the Mini's exact pass. The entrypoint refuses to
start (exit 78) in two cases:

- the store directory has no `jobtrack.db`, so a wrong mount can never
  cold-initialise a second store;
- staffing is requested without `$CODEX_HOME/auth.json`, so a missing login
  cannot burn every item's dispatch budget.

The daemon's socket `fabric.sock` sits in the store, so a write from another
container on the same mount wakes it (proved in the dry run). The container
healthcheck is that socket's existence.

Operating the store by hand on Lubuntu: `docker exec jobtrack-worker node
bin/jobtrack.js <verb> …`. Use the container: the host's own Node is 18.

## Phases

| # | What | Where | Done when |
| --- | --- | --- | --- |
| 1 | Worker image and entrypoints, renderer switch, live-safe release-gate copy, tests; this design | jobtrack | Suite green; image builds; entrypoint refusals tested |
| 2 | Stack services under profile `worker`; `JOBTRACK_STORE_DIR` for the viewer; `DEPLOY_EXTRA_IMAGES`; `backup.conf` follows the live store; `.env.example`; READMEs | infra | `tools/verify` green; inert with the profile off |
| 3 | Dry run on Lubuntu against a copy of the replica: workers start, derive, wake, drain; the viewer reads the live path | Lubuntu (scratch) | Evidence below; copy deleted |
| 4 | Cutover: owner prerequisites, drain the Mini's two production jobs, final backup, transfer with checksums, start on Lubuntu, witness a pass, tombstone the Mini store, retire the plists, retire the replication | Mini, Lubuntu | The runbook's acceptance list holds |
| 5 | Gmail on Linux: the pinned linux-amd64 single-attempt gog in the worker image, the file-keyring lane projection, `gog-environment` and the `umich-bin` shim made platform-aware, the read-lane grant | jobtrack, infra, owner | A read-only probe (`scripts/check-gog-access.cjs`) passes in the worker; then the email lanes' own gates |
| 6 | Renders: an amd64 renderer pin and a render route without the Docker socket | jobtrack, infra | A real render and lint through the fabric tick |
| 7 | ApplySim's applicant daemon and arc store: an `applicant` service in `stacks/applysim` (Codex, its own `CODEX_HOME`, the arc store under `/srv`), the `jobtrack-applysim` viewer pointed at it, `ai.applysim.fabric-daemon` retired | applysim, infra, Mini | One arc pass on Lubuntu; the viewer shows the arc store |

Phases 5 to 7 do not block phase 4. They run in any order after it.

## Status (2026-10-04)

**Phases 1 and 2: implemented.**

- jobtrack branch `move/write-side-lubuntu` and infra branch
  `jobtrack/write-side-worker` (PRs linked from the session report).
- jobtrack suite under Node 22: 941 pass, 0 fail, 10 skipped.
- The worker image built on Arch and on Lubuntu.

**Phase 3: dry run done, 2026-10-04 01:52 UTC on Lubuntu.** Scratch directory
`/tmp/jobtrack-dryrun.*`, image built there from 2ae44aa. Gmail, Codex and
notifications were off: no network, no login, no topic.

- **Copy.** The replica was snapshotted by the image's own
  `store-snapshot.cjs`, with the replica mounted read-only. The replica's
  sha256 prefix (802aedcb…) and its file listing were unchanged afterwards.
  - The copy: 5,681,152 bytes, `quick_check` ok, 265 tables. Counts: 4
    applications, 11 opportunities, 0 interviews, 0 gate revisions.
- **Worker.** It ran with the stack's settings (uid 1000, read-only root,
  `cap_drop: ALL`), plus no network and the pass `fabric dispatch --dry-run
  --json`. The startup pass and a 15 s safety-tick pass both exited 0.
- **Derivation.** `fabric next`: 15 subjects, 11 parked at
  `opportunity.pursue`. That matches the Mini's last tick (11 parked). A
  dry-run dispatch ended `parked` with nothing to staff.
- **Viewer.** The production viewer image `jobtrack-web:2756f74` ran read-only
  over the live copy while the worker held it open in WAL mode. `/healthz`, `/`
  and `/opportunities` all returned 200.
- **A write from another container.** A synthetic `opportunity ingest` ("Dry Run
  Probe Co") from a second container on the same mount:
  - woke the daemon through `fabric.sock`: a pass with reason `socket`, about
    2 s later;
  - reached the viewer: `/` grew from 49,473 to 50,271 B, and `/opportunities`
    shows the synthetic company;
  - added one eligible `opportunity.triage` to `fabric next`;
  - made the dry-run dispatch end `dry-run`, planning `opportunity.triage` on
    the `codex` harness with `gpt-6-astra`.
- **Heartbeat.** One cycle exited 0 and wrote `queue.md` ("16 subject(s): 1
  eligible, 11 parked"), `last-tick.json` and a `tick-log.jsonl` line.
  `cron.err` was empty.
- **Drain.** SIGTERM: the worker exited 0 in 0.11 s and removed its socket.
- **Lock contention.** An explicit `fabric wake` from a third container,
  during that pass, got `SQLITE_BUSY` ("database is locked"). The Mini's daemon
  logs show the same contention today. It is not introduced by the move, but it
  is worth a follow-up: the CLI's migrate-on-open transaction upgrades a read
  lock.
- **Cleanup.** The containers, the dry-run image and the copy were deleted.
  The production containers were untouched.

**O1 and O2: done; O2's session checks run 2026-10-04 08:20–08:36 UTC on
Lubuntu.** The image was built from `main` 925f782 in a scratch directory
`/tmp/jobtrack-o2.*`, a `git clone` of the deploy checkout (which was only
read).

- **Login.** `CODEX_HOME=/srv/jobtrack/codex-home codex login status`:
  "Logged in using ChatGPT". `auth.json` is cole 0600, and its directory is
  0700.
- **Codex probe.** A throwaway `codex exec` turn ran in the worker image with
  the worker's settings: uid 1000, read-only root, `cap_drop: ALL`,
  `no-new-privileges`, a `/tmp` tmpfs, the Codex home mounted, and the
  executor's flags (`--ephemeral`, `--dangerously-bypass-approvals-and-sandbox`).
  It used a scratch bridge on a pinned subnet, `10.253.89.0/28`, beside the
  stack's `10.253.88.0/28`.
  - **The pinned codex-cli 0.152.1 cannot run the worker's model.** With
    `-m gpt-6-astra` (the dispatcher's default, `deploy/worker/codex-config.toml`)
    OpenAI answered 400: "The 'gpt-6-astra' model requires a newer version of
    Codex". So the request reached OpenAI and was authenticated: login and
    egress work.
  - The same image with `-m gpt-5.5` replied `OK` (exit 0). This proves the
    binary, the login and the egress.
  - A scratch build with `CODEX_VERSION=0.160.0` (npm `latest`) and
    `-m gpt-6-astra` replied `OK`.
  - The Mini has the same codex-cli 0.152.1, so its workers would fail the
    same way today. Nothing has been staffed there since 2026-09-06, so this is
    not caused by the move. But no staffed turn can succeed until the pin is
    raised. **Blocker before the next staffed turn:** bump `CODEX_VERSION` in
    `Dockerfile.worker` (0.160.0 is tested), in a reviewed change.
- **Fresh dry run.** It was repeated exactly as in phase 3, with a new copy of
  the replica.
  - **Copy.** The replica's sha256 prefix was df7ae794… before. Its sha256
    list and file listing were unchanged afterwards.
  - **The copy itself.** 5,681,152 bytes, `quick_check` ok, 265 tables.
    Counts: 4 applications, 11 opportunities, 0 interviews, 0 gate policy
    revisions.
  - **Worker.** No network, no Codex home, `--dry-run --json`, a 15 s safety
    tick. The startup pass and the safety-tick passes all ended `ok`, exit 0.
  - **Derivation.** `fabric next`: 15 subjects, 0 eligible, 11 parked, all
    parked at `opportunity.pursue`. That matches the Mini's last tick
    (2026-10-04T07:37:57Z: 15 subjects, 11 parked, 0 dispatchable; its last
    dispatch pass, at 08:11Z, ended `parked`). A dry-run dispatch ended
    `parked`.
  - **Viewer.** `jobtrack-web:925f782` ran read-only over the live copy
    beside the worker. `/healthz`, `/` and `/opportunities` all returned 200.
  - **A write from another container.** A synthetic `opportunity ingest` ("Dry
    Run Probe Co") from a second container:
    - woke the daemon through `fabric.sock` (a pass with reason `socket`);
    - reached the viewer: `/` grew from 49,512 to 50,304 B, and both pages show
      the company;
    - made `fabric next` give 16 subjects, 1 eligible `opportunity.triage`;
    - made the dry-run dispatch end `dry-run`, planning `opportunity.triage` on
      `codex` with `gpt-6-astra`. That is the model the 0.152.1 pin cannot run.
  - **Heartbeat.**
    - The first cycle ran while a safety-tick pass was in flight. Its tick got
      `SQLITE_BUSY`, so `tick-log` recorded `"no summary"`, while `queue.md`
      was still regenerated. This is the known contention below, made likelier
      by the 15 s test tick. In production the tick is 20 minutes and the
      heartbeat hourly.
    - A cycle with no pass in flight exited 0. It wrote `queue.md` ("16
      subject(s): 1 eligible, 11 parked"), `last-tick.json` and a `tick-log`
      line, and `cron.err` stayed empty.
    - SIGTERM stopped the heartbeat with exit 0 in 0.19 s.
  - **Drain.** SIGTERM: the worker exited 0 in 0.20 s and removed its socket.
  - Gmail and notifications were off, and the dry run did not invoke Codex.
- **Cleanup.** The containers, both scratch images, the scratch network, the
  copy and the scratch directory were deleted. The production containers were
  untouched.

**Before the cutover, 2026-10-04.**

- #6 (`ac9d1fc`) runs the Conductor's test stage as four slices
  (`conductor-gate.sh test-shard I N`). The Conductor caps every command at
  600 s, a constant in its runner, and the whole suite had reached 579–598 s.
- #7 (`f2a7061`) pins codex-cli 0.160.0.
- Both deployed green.

**Phase 4: cutover done, 2026-10-04 ~09:53 UTC** (owner D1, D6, D7; run by
the owner's session).

- **Drain.** Both production labels were disabled, then the daemon got
  SIGTERM.
  - The plist has `KeepAlive` true, so launchd restarted the loaded daemon
    even though the label was disabled (runs 1 to 2, a new PID).
  - With no pass running (no `.dispatch-lock`, no worker, last pass `parked`),
    `launchctl bootout` stopped and unloaded it cleanly, with no restart.
  - The runbook's step 2 now says this.
- **Backup.** `.backup` of both databases (`quick_check` ok) plus the store's
  files: 4,170 files, 200 MB, with a SHA-256 manifest.
- **Transfer.** `MANIFEST-OK` and `FILECOUNT-OK`, `quick_check` ok on
  Lubuntu, and the copy was renamed to `/srv/jobtrack/store`.
- **Start.**
  - `.env` gained `JOBTRACK_STORE_DIR` and `COMPOSE_PROFILES=worker`. The prior
    file is kept as `/srv/jobtrack/env.pre-cutover`.
  - `tools/stack deploy jobtrack --force` was GREEN at `f2a7061`. Web, worker
    and heartbeat are healthy, and the viewer mounts the store read-only.
- **Witness.**
  - The worker's startup pass returned `ok`, and the dispatch log gained a
    `parked` pass.
  - `fabric next` gives 15 subjects, 0 eligible, 11 parked: the Mini's final
    counts.
  - `/healthz` returns 200.
  - The heartbeat's first cycle collided with the startup pass (`SQLITE_BUSY`,
    the known contention). A manual cycle exited 0 and regenerated `queue.md`
    (15/0/11) and `tick-log`.
- **Mini.**
  - `~/.jobtrack` is a 0444 tombstone. The CLI against it exits 1, so
    story-tool writes fail closed (D7).
  - The data is at `~/.jobtrack.moved-to-lubuntu-20261004`.
  - Both plists are in `~/Library/LaunchAgents/disabled/`.
  - The staging copy is at `~/jobtrack-cutover-20261004`, not `/tmp`, which
    the nightly reboot clears. Delete it after 2026-10-18.
  - `ai.applysim.fabric-daemon` still runs on `~/.jobtrack-applysim`.
- **D6.** The enrollment's `export-contract` now reads `/srv/jobtrack/store`.
  Manual Conductor run `b8e7311f` for `f2a7061` succeeded.
- **Remaining.** Owner O4 (the replica timer), then "Retire the replication".
  Phases 5 to 7 are designed above and not started.

## Owner steps, in order

The session runs everything else. **Each step says what the session does right
after it.**

**O1. Create `/srv/jobtrack` (Lubuntu, sudo).** Before the cutover.

```sh
ssh mac-mini
ssh laptop
sudo install -d -o cole -g cole -m 0700 /srv/jobtrack
```

Session, right after:

- `install -d -m 0700 /srv/jobtrack/codex-home`;
- `git -C ~/infra pull --ff-only` (brings the merged stack changes; nothing
  starts while the profile is off);
- put `NTFY_TAILNET_IP` (copied from `stacks/voice-journey/.env`) and
  `JOBTRACK_NTFY_TOPIC` (piped from the Mini's plist, never printed) into
  `~/infra/stacks/jobtrack/.env`, mode 0600.

**O2. Log the workers into Codex (Lubuntu, interactive, a browser).**

```sh
CODEX_HOME=/srv/jobtrack/codex-home codex login --device-auth
```

Sign in with the ChatGPT account whose plan the Mini's workers use today. If
the device-code page refuses, enable device-code sign-in for Codex in ChatGPT's
security settings and retry. Do not copy `~/.codex/auth.json` from any machine.

Session, right after:

- check the login: `CODEX_HOME=/srv/jobtrack/codex-home codex login status`
  must say ChatGPT; `chmod 600` the auth file;
- build the worker image at `main` in a scratch directory;
- run one throwaway `codex exec` turn ("reply OK") in that image with the
  Codex home mounted: this proves binary, login and egress;
- repeat the phase-3 dry run against a fresh replica copy;
- report, and ask for the cutover go-ahead.

**O3. Decide (no commands).** All before the cutover:

- **D1, the cutover itself:** approve the window. The session runs the
  runbook below.
- **D6, the release gate:** approve re-pointing the Conductor enrollment
  `jobtrack`'s `export-contract` from
  `~/infra/stacks/jobtrack/state/store` to `/srv/jobtrack/store`
  after cutover. Until then the gate checks the frozen replica, which still
  passes.
- **D7, stories:** after cutover, OpenClaw's journal agent's `story-tool.js`
  calls on the Mini fail closed (tombstone). Accept that until a story route
  exists, or delay the cutover.

**O4. Disable the replication timer (Lubuntu, sudo).** After the cutover; it
does not block it.

```sh
sudo systemctl disable --now jobtrack-replica@jobtrack.timer
```

Session, right after, in "Retire the replication":

- remove the Mini's `jobtrack-replica-export` `authorized_keys` line;
- delete the replication key pair on Lubuntu;
- after D6, re-point the enrollment and archive the frozen `state/store`.

**Later, phase 5 (Gmail).** Only after the Linux gog route has landed and been
reviewed. The session first prepares `~/.config/gogcli-jobtrack-read` (0700),
then the owner consents in a browser signed in as `<university-account>`.

- **What the session prepares:**
  - `keyring.env`, with a generated `GOG_KEYRING_PASSWORD`;
  - `config/config.json` (file keyring, `<university-account>` → `gmail-readonly`);
  - the OAuth client file. **(owner)** Reuse inbox-pipeline's Desktop client,
    which umich's Workspace already admits, or create a new Google Cloud
    project.
- **What the owner runs:**

  ```sh
  GOG_HOME=$HOME/.config/gogcli-jobtrack-read gog-lane auth add <university-account> \
    --client gmail-readonly --services gmail --gmail-scope readonly --remote --step 1
  # open the printed URL, approve, copy the localhost URL the browser lands on
  GOG_HOME=$HOME/.config/gogcli-jobtrack-read gog-lane auth add <university-account> \
    --client gmail-readonly --services gmail --gmail-scope readonly --remote --step 2 \
    --auth-url '<the copied URL>'
  ```

Session, right after: mount the lane into the worker and run the read-only probe
`scripts/check-gog-access.cjs --json` in it. Sending stays off: a send lane is
its own grant and its own approval (GOG_KEYCHAIN_ROUTING, EMAIL_LANES).

## Cutover runbook (phase 4)

Run as cole. Commands on the Mini start with `M$`, on Lubuntu with `L$`; the
Mini's GUI domain is `gui/502`. Stop at the first failed check. Until step 5
the Mini is still the writer, and stopping means simply resuming it (see
Rollback).

**0. Preconditions (all must hold; the Mini is untouched so far).**

- O1 and O2 are done. The Codex probe and the fresh dry run passed. D1 is
  approved.
- `L$ ls -ld /srv/jobtrack /srv/jobtrack/codex-home`: both are cole 0700, and
  `/srv/jobtrack/store` does not exist yet.
- `L$ git -C ~/src/jobtrack log -1` is a `main` that has `Dockerfile.worker`
  (mc-autodeploy keeps it there), and `L$ git -C ~/infra log -1` shows the
  merged infra change. The stack's `.env`
  has `NTFY_TAILNET_IP` and `JOBTRACK_NTFY_TOPIC`, and no `COMPOSE_PROFILES`.
- No jobtrack Conductor run is in flight: `conductor runs jobtrack --limit 1`.
  No jobtrack merge is pending during the window.
- `M$ launchctl print gui/502/com.cole.jobtrack-fabric-daemon` shows it
  running. Record its PID and the hourly job's state. **Leave
  `ai.applysim.fabric-daemon` alone**: it writes only the arc store and moves
  in phase 7.

**1. Stop admissions on the Mini.** Disable first, then signal. These steps
follow GOG_KEYCHAIN_ROUTING's drain, for the production labels only.

```sh
M$ launchctl disable gui/502/com.cole.jobtrack-fabric
M$ launchctl disable gui/502/com.cole.jobtrack-fabric-daemon
M$ launchctl print-disabled gui/502 | grep -E 'com.cole.jobtrack-fabric(-daemon)?"'   # both "disabled"
M$ launchctl kill SIGTERM gui/502/com.cole.jobtrack-fabric-daemon
```

**2. Wait for the drain.**

- SIGTERM makes the daemon stop admitting passes and wait for the whole current
  pass, staffed workers included.
- Wait until all of these hold:
  - the daemon's PID is gone;
  - no `fabric dispatch` or `jobtrack-fabric-worker` process remains (check
    with `pgrep -fl`);
  - `~/.jobtrack/fabric/.dispatch-lock` is absent;
  - an hourly run that was in progress has finished
    (`launchctl print gui/502/com.cole.jobtrack-fabric` says not running).
- **`KeepAlive` caveat (seen at the 2026-10-04 cutover).** A *loaded*
  `KeepAlive` job is restarted by launchd after SIGTERM even when its label is
  disabled. If `runs` increases, wait until no pass is in flight (no
  `.dispatch-lock`, no `fabric dispatch` worker, last log line finished), then
  `launchctl bootout gui/502/com.cole.jobtrack-fabric-daemon`: it sends the
  same SIGTERM and unloads the job, so launchd does not restart it.
- With `KeepAlive` and the label disabled, launchd does not restart it. Check
  that `runs` did not increase.
- Never `bootout` while a pass is in flight (see the caveat above), and never `kickstart -k` or SIGKILL.
- A worker killed by a deadline, or an orphan, means stop. Resume the Mini,
  then reconcile (GOG_KEYCHAIN_ROUTING step 2).

**3. Final consistent backup on the Mini (quiescent now).**

```sh
M$ S=$(mktemp -d /tmp/jobtrack-cutover.XXXXXX); mkdir -m 700 "$S/store"
M$ for db in jobtrack pipeline-evidence; do sqlite3 ~/.jobtrack/$db.db ".backup '$S/store/$db.db'"; \
     [ "$(sqlite3 "$S/store/$db.db" 'pragma quick_check;')" = ok ] || echo "QUICK_CHECK FAILED $db"; done
M$ /opt/homebrew/bin/rsync -a --exclude=/fabric.sock \
     --exclude=/jobtrack.db --exclude=/jobtrack.db-wal --exclude=/jobtrack.db-shm \
     --exclude=/pipeline-evidence.db --exclude=/pipeline-evidence.db-wal --exclude=/pipeline-evidence.db-shm \
     ~/.jobtrack/ "$S/store/"
M$ (cd "$S/store" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256) > "$S/MANIFEST.sha256"
M$ wc -l < "$S/MANIFEST.sha256"; du -sh "$S/store"
```

The two live databases are fresh `.backup` copies: checkpointed, no sidecars.
The rsync excludes are anchored (`/name`), so only those top-level files and
the socket are skipped. The closed databases under `backups/` and the
`jobtrack.db.backup-pre-*` files travel as plain files.

**4. Transfer with checksums.** Over the Mini's existing key to Lubuntu.

```sh
M$ ssh laptop 'umask 077 && cat > /srv/jobtrack/cutover-MANIFEST.sha256' < "$S/MANIFEST.sha256"
M$ tar -C "$S/store" -cf - . | ssh laptop \
     'umask 077 && mkdir /srv/jobtrack/store.incoming && tar -C /srv/jobtrack/store.incoming -xf -'
L$ cd /srv/jobtrack/store.incoming && sha256sum -c --quiet ../cutover-MANIFEST.sha256 && echo MANIFEST-OK
L$ [ "$(find . -type f | wc -l)" = "$(wc -l < ../cutover-MANIFEST.sha256)" ] && echo FILECOUNT-OK
L$ sqlite3 jobtrack.db 'pragma quick_check;'; sqlite3 pipeline-evidence.db 'pragma quick_check;'
L$ chmod 700 /srv/jobtrack/store.incoming && find /srv/jobtrack/store.incoming -type f -exec chmod go-rwx {} +
L$ mv /srv/jobtrack/store.incoming /srv/jobtrack/store      # rename(2); the store did not exist
```

The manifest lives beside the store, not in it
(`/srv/jobtrack/cutover-MANIFEST.sha256`; keep it as the transfer receipt).
Both the checksums and the file count must match.

**5. Start the write side on Lubuntu.** Edit `~/infra/stacks/jobtrack/.env`,
keeping it 0600, and add:

```text
JOBTRACK_STORE_DIR=/srv/jobtrack/store
COMPOSE_PROFILES=worker
```

Then:

```sh
L$ ~/infra/tools/stack deploy jobtrack --force
```

The deploy builds `jobtrack-web` and `jobtrack-web-worker` at `main`, pins
both, and recreates `web` on the live store. It starts `jobtrack-worker` and
`jobtrack-heartbeat` and requires all three to be ready. A failed readiness
rolls back. In that case remove `COMPOSE_PROFILES`, restore
`JOBTRACK_STORE_DIR` (remove the line) and go to Rollback A.

**6. Witness one fabric pass.**

- `L$ docker logs jobtrack-worker` shows `jobtrack-fabric-daemon-started.v1`
  on `/jobtrack/fabric.sock`, then a `startup` pass with `"ok":true`.
- `/srv/jobtrack/store/fabric/dispatch-log.jsonl` gains a line, with the same
  outcome class as the Mini's last passes (`parked`, 11 parked).
- `L$ docker exec jobtrack-worker node bin/jobtrack.js fabric next --json`
  gives the same counts as the final Mini tick.
- `docker logs jobtrack-heartbeat` is clean, and `fabric/queue.md` is
  regenerated.
- `https://jobtrack.example-tailnet.ts.net/healthz` returns 200. The viewer
  shows the same counts.
- Nothing new on ntfy: `notified.json` came along.

**7. Freeze the Mini's copy.**

```sh
M$ mv ~/.jobtrack ~/.jobtrack.moved-to-lubuntu-$(date +%Y%m%d)
M$ printf '%s\n' "JobTrack's store moved to laptop:/srv/jobtrack/store on $(date -u +%FT%TZ)." \
     "See jobtrack docs/move-write-side-to-lubuntu.md. This file blocks any writer from recreating a store here." > ~/.jobtrack
M$ chmod 0444 ~/.jobtrack
```

The CLI's `mkdir -p` then fails on the tombstone file, so story-tool, a stray
manual command or the replica export fail loudly. Nothing can write to the old
copy or start an empty store.

**8. Retire the Mini's two plists** (the Mini checkout stays):

```sh
M$ launchctl bootout gui/502/com.cole.jobtrack-fabric-daemon 2>/dev/null; launchctl bootout gui/502/com.cole.jobtrack-fabric 2>/dev/null
M$ mkdir -p ~/Library/LaunchAgents/disabled
M$ mv ~/Library/LaunchAgents/com.cole.jobtrack-fabric-daemon.plist ~/Library/LaunchAgents/com.cole.jobtrack-fabric.plist \
      ~/Library/LaunchAgents/disabled/
```

Keep the cutover staging directory `$S` on the Mini for 14 days, then delete
it.

**9. Replication and the gate.** These are the owner's O4 and D6, then "Retire
the replication".

**Acceptance:**

- the Mini has no JobTrack production job and its store is a tombstone;
- Lubuntu's `jobtrack-worker` and `jobtrack-heartbeat` are healthy, and one
  pass was witnessed;
- the viewer reads `/srv/jobtrack/store`;
- the next nightly `stack-backup@jobtrack` writes
  `store-jobtrack-<UTC>.sqlite`, `store-pipeline-evidence-<UTC>.sqlite` and
  `store-files-<UTC>.tar.gz`, reading the live store;
- the next merge to `main` redeploys all three containers. Watch the run with
  `conductor runs jobtrack --limit 2` and check `docker inspect` for both
  images' revision.

### Retire the replication

1. **(owner, O4)** `sudo systemctl disable --now jobtrack-replica@jobtrack.timer`.
   Until then the timer only fails: the tombstone makes the export refuse.
2. On the Mini, remove the `restrict,command="~/.local/bin/jobtrack-replica-export"`
   line from `~/.ssh/authorized_keys`, and `~/.local/bin/jobtrack-replica-export`.
3. On Lubuntu, delete `~/.ssh/id_ed25519_jobtrack_replica{,.pub}` and
   `stacks/jobtrack/state/replica.token`.
4. After D6 has re-pointed the enrollment, archive and remove
   `~/infra/stacks/jobtrack/state/store`.
5. In infra: mark `replication/jobtrack/` retired, then delete it once the
   rollback window (14 days) has passed. Update the stack README and
   `docs/MINI-EXIT.md`. Update this repository's AGENTS.md "Production" and
   `docs/VERIFICATION.md`, which mention the replica.

## Rollback

**A. Before step 7** (the Mini store is still in place).

1. On Lubuntu, stop the workers and return the viewer to the replica:

   ```sh
   docker stop -t 300 jobtrack-worker jobtrack-heartbeat
   docker rm jobtrack-worker jobtrack-heartbeat
   ```

   Then remove `COMPOSE_PROFILES` and `JOBTRACK_STORE_DIR` from the stack's
   `.env` and run `docker compose up -d`. `--remove-orphans` would not do it:
   a service whose profile is off is still defined, not an orphan.
2. Move `/srv/jobtrack/store` aside as `store.failed-<UTC>`; don't delete it.
3. On the Mini:

   ```sh
   launchctl enable gui/502/com.cole.jobtrack-fabric-daemon
   launchctl enable gui/502/com.cole.jobtrack-fabric
   launchctl kickstart gui/502/com.cole.jobtrack-fabric-daemon
   ```

   (or `bootstrap` if it was unloaded).
4. Writes Lubuntu made in between are lost. Any pass there that *staffed* a
   worker must be reconciled first: compare the two `dispatch-log.jsonl` files.

**B. After step 7** (Lubuntu has been the writer).

1. Drain Lubuntu and set the profile off, as in A.1.
2. Take a final backup with the `store-snapshot` helper or `sqlite3 .backup`
   inside `jobtrack-worker`'s image.
3. Transfer back with a checksum manifest, the reverse of steps 3 and 4.
4. On the Mini, swap the tombstone file for the transferred store, never
   for the old `~/.jobtrack.moved-to-lubuntu-*` copy (it lacks Lubuntu's
   writes).
5. Move the plists back from `disabled/`, `bootstrap` them, and re-enable the
   replication timer.

Never run both writers.

## Risks and open points

- **A deploy can cut a staffed turn.** The worker's stop grace is 5 minutes,
  because `stack-deploy` has 15 in all. A Codex turn can run 20.
  - A cut turn leaves an engine attempt without a result. The store's verbs
    are atomic and keyed, so nothing tears, and the item is re-staffed within
    its budget.
  - Passes are seconds when nothing is staffable, the common case (the last
    staffed turn was a month ago).
  - Email sending is not staffed by the dispatcher.
- **The worker egress is open:** OpenAI, public posting pages, ntfy.
  - It is a bridge with a pinned subnet; Docker's default pools are exhausted
    on Lubuntu.
  - An allowlisting egress proxy would narrow it (as discovery-sandbox does
    for discovery workers). A follow-up.
- **Codex `--dangerously-bypass-approvals-and-sandbox` inside the container.**
  This is unchanged from the Mini. The container is the sandbox now: no host
  home, read-only root, no capabilities, only the store and the Codex home
  mounted. That is narrower than the Mini, where the workers had the owner's
  whole home, browser plugins and MCP servers.
- **SQLite contention:** "database is locked" between a pass and a concurrent
  CLI writer. It exists today and was seen in the dry run. A follow-up: open
  with `BEGIN IMMEDIATE` around migrate-on-open, or retry the upgrade.
- **Backup size:** `images/` (143 MB) and `backups/` (25 MB) ride every
  nightly `store-files` tarball, about 2.5 GB over 14 days on a disk with
  42 GB free. **(owner)** Move them to a one-time archive if that matters.
- **The live tar:** GNU tar exits 1 if a file changes while it is read
  (`fabric/dispatch-log.jsonl` at backup time). The lane then reports a
  failure and retries the next night. The database copies are unaffected.
- **Stories and operator acts move off the Mini** (D7). Arch's agent-jobtrack
  cannot reach the tailnet, so a person's CLI act on the store goes through an
  owner (cole) session on Lubuntu.
- **The arc store's viewer is stale today** (Lubuntu's
  `~/.jobtrack-applysim`, last written 2026-08-09). Fixed in phase 7.
