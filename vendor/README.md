# vendor/ — byte-pinned engines (retention record)

Two trees live here, both vendored rather than installed and both pinned
byte-for-byte by SHA-256 to an exact published release:

| tree | package | release | pinned by |
|---|---|---|---|
| `vendor/mission-pipeline/` | `mission-pipeline` (the v2 node-graph engine) | 1.0.0 @ `d22fb89a` (untagged upstream; tree `97b89fe0`) | `manifest.json` + `PINS['mission-pipeline']`; re-vendor with `scripts/vendor-mission-pipeline.mjs` |
| `vendor/mission-eal/` | `mission-eal` (host-neutral LLM client) | v0.2.0 @ `62db3463` | `manifest.json` + `PINS['mission-eal']` |

`lib/draft-runner/vendor-pin.js` verifies each tree before it is loaded and
fails closed on a changed byte, an added or removed file, a moved pin, or a
path escaping the vendored root. `mission-pipeline` is also declared as a
`file:` dependency in `package.json` (so `node_modules/mission-pipeline` is a
symlink to this tree — that is how `mission-eal`'s own `mission-pipeline/…`
imports resolve); `mission-eal` is **not** — the pin resolves it by path, so no
dependency graph names it. That is why it looks orphaned to static analysis and
why this file exists.

Every runner sits on the one engine through `lib/engine-v2` (2026-09-01,
`docs/V2-ENGINE-PORT.md`): the fabric worker (`lib/fabric-worker-runner`), the
reply-draft runner (`lib/draft-runner`, `bin/jobtrack-draft-runner.js`) and the
opportunity triage panel (`lib/triage-panel`, whose resolver is the one consumer
of `mission-eal`'s `createHttpLlmClient`). The v1 engine tree (v0.2.0) and the
v1 fabric runner were retired the same day after the real-claude acceptance
drill passed.

## Do not delete, do not upgrade in place

- **Readers.** `lib/draft-runner/vendor-pin.js` is the sole reader of both
  trees, and it is required by the *live* fabric worker
  (`lib/fabric-worker-runner/pipeline.js`) as well as by
  `bin/jobtrack-draft-runner.js`. The `rm -rf ./lib/draft-runner` in
  `Dockerfile` is scoped to the read-only **web image** and is not evidence
  that `lib/draft-runner` is dead.
- **Upgrade discipline.** An engine bump is a re-vendor (`scripts/
  vendor-mission-pipeline.mjs --source <checkout> --commit <sha>`), a `PINS`
  update, the engine conformance suite green against `SqliteUnitStore`
  (`test/fabric-engine-v2-store-conformance.test.mjs`), and the three runner
  suites green. `mission-eal` v0.2.0 declares a peer range of `mission-pipeline
  >=0.2.0 <0.3.0`; the three modules it imports (`agent/step`,
  `contracts/usage-receipt`, and type-only `agent/executor-port`) exist
  unchanged in 1.0.0, which is why it loads against the v2 tree — verified by
  the triage-panel suite.
- **Tests.** `test/draft-runner.test.js` covers the pin and the engine's
  dependency isolation; a pass count that drops after touching `vendor/` means
  a live proof was removed.

Re-vendoring: `scripts/vendor-mission-pipeline.mjs` writes the tree and its
`manifest.json` from `git archive` of the exact commit; then update the
matching `PINS` entry and the release/commit/tree lines in
`docs/DRAFT_RUNNER.md`.
