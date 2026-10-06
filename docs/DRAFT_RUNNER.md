# JobTrack out-of-process reply-draft runner

Status: implemented offline, 2026-08-01. Clean-rebuild checklist task 46.

`bin/jobtrack-draft-runner.js` composes one job-application email reply from
one digest-pinned request. It is a separate process by design and it is the
only component in JobTrack that produces draft prose.

## Why a separate process

JobTrack is a declarative control plane, not a model runtime. The store, the
CLI, and the web workspace must never gain a drafting capability, and drafting
must never gain store, mailbox, or send authority. Splitting the runner out
makes that boundary a process boundary rather than a code convention.

The runner therefore holds:

- no handle on the canonical JobTrack store, and no access to any JobTrack
  domain module — it is refused by name from opening `jobtrack.db`;
- no network client, credential, mailbox, or provider adapter;
- no tool surface, shell, or subprocess;
- no send, no native draft, no approval.

It does own one database, for pipeline evidence only: runs, attempts, results,
dead letters, and outbox events. That is a different authority from reaching
JobTrack's domain, and it is what makes the engine's durability guarantees
real rather than nominal.

Its entire output is inert data that the JobTrack CLI re-validates from
scratch before recording. `jobtrack email outgoing-draft-record` independently
re-checks every schema, digest, projection, chronology, and no-effect rule; a
compromised runner cannot make JobTrack accept an unbound draft.

## Contract

```text
stdin   jobtrack-email-reply-draft-request.v1   (from `outgoing-draft-issue`)
stdout  jobtrack-email-reply-draft-result.v1    (into `outgoing-draft-record`)
stderr  jobtrack-email-reply-draft-refusal.v1   (on any refusal)
```

Exit codes: `0` composed, `2` refused or invalid request, `3` the vendored
engine failed its integrity pin.

```sh
jobtrack email outgoing-draft-issue --json issue.json > request.json
node bin/jobtrack-draft-runner.js --provenance provenance.json \
  < request.json > result.json
jobtrack email outgoing-draft-record --json result.json
```

A refusal writes nothing to stdout. An unanswerable message never becomes a
silent draft.

## The pipeline

The runner executes a compiled DAG on Mission Pipeline. The engine supplies
what a hand-rolled loop would not: a digest-sealed compiled pipeline whose
identity changes if any stage, contract, or model binding changes; contract
validation on every edge; durable per-stage idempotency keys and a bounded
attempt budget; and usage receipts that ride the same atomic append as the
attempt that earned them.

```text
verify_request  code   the request's own no-effect policy, expiry, risk
      |
classify_event  code   event kind -> exactly one declared reply purpose
      |
select_evidence code   bounded admissible excerpts + the phrase guard
      |
compose_reply   model  the one bound node; executes via an injected resolver
      |
seal_proposal   code   every safety rule, then the sealed v3/v1 pair
```

`compose_reply` is a genuine `kind: "model"` node bound to a digest-sealed
`model-stage-binding.v2`. Its recorded inference parameters are part of the
sealed binding, so changing any of them changes the binding digest, the
compiled node fingerprint, and every downstream stage idempotency key.

The default resolver is a local deterministic composer: bounded templates, one
per purpose, that state only what JobTrack itself knows. It reaches no network
and holds no credential, which is what lets the runner honestly declare
`networkAccess: none`. Substituting a real provider is a resolver change; the
pipeline, its contracts, and its digests are unchanged. `toolPolicy` is fixed
at `none` and a binding that says otherwise is refused.

## Safety rules the runner enforces

Untrusted message content is quoted evidence, never instruction. No stage
interprets an excerpt as a directive.

- **Admissible evidence.** Only `subject`, `body`, and `from` excerpts reach
  composition. URL and header excerpts are dropped: they carry the highest
  injection and tracking risk and contribute nothing a reply needs.
- **Recipient lock.** The composed recipient must equal the imported
  `source.replyToAddress` exactly.
- **No distinctive-phrase reuse.** Any four-word run from the recipient's own
  prose is off limits verbatim in the body. Subject excerpts are excluded from
  the guard: a reply subject echoes the original by threading convention.
- **Register adaptation only.** No personality inference, no protected-trait
  inference, no identity imitation.
- **Sensitive-data scan.** A hit downgrades the scan to `requires_review`
  rather than silently redacting.
- **Normalization.** Subject and body must already be LF and Unicode NFC.
- **Always reviewed.** `requiresReview` is true and `autoSendEligible` false on
  every proposal, without exception.

A refusal is a decision, not a transient error. Refusals are raised as the
engine's non-retryable, item-scoped stage error with a stable
`draft_refused.*` code, so retrying can never turn a principled "no" into a
different answer. The runner uses a single attempt for the same reason.

## Determinism and replay

Every identity is derived from the request, and no stage consults a clock or a
random source except the injected clock. Replaying the same request produces a
byte-identical result document.

Against the durable store that is more than a property of the composer: the
replay is *answered from evidence*. Each stage that already succeeded replays
from its committed result, the model node's provider is never called a second
time, and the usage receipts the original run committed are read back from the
outbox. A crash-retry therefore costs nothing and cannot produce a different
answer. A test asserts exactly this — one composer invocation across two runs.

Evidence lives in `~/.jobtrack/pipeline-evidence.db` by default, overridable
with `JOBTRACK_PIPELINE_DB` or the `storePath` option, and `:memory:` opts out
of durability deliberately. The runner refuses to open `jobtrack.db` itself.

A stage refusal is raised as the engine's non-retryable, item-scoped error, so
the attempt budget governs only genuinely transient failures — which is what a
real model provider will eventually produce. A refusal is never retried into a
different answer regardless of that budget.

## The vendored engine

Mission Pipeline is vendored under `vendor/mission-pipeline/` rather than
installed, so the runner has no registry, network, or mutable-checkout
dependency at build or run time. `vendor/mission-pipeline/manifest.json` pins
every byte by SHA-256 to an exact published commit (1.0.0 is untagged
upstream — the commit is the release):

```text
repository  scshafe/mission-pipeline
release     1.0.0
commit      d22fb89af059081bd8da7e824a7000e97dc49c60
tree        97b89fe0530ccff0d07bd73d853f73173074fa45
```

Since 2026-09-01 this is the **v2 node-graph engine**. The runner is a sealed
five-node chain (`jobtrack.email.reply_draft@2`) over one state artifact
(`jobtrack-email-reply-draft-state.v1`): each node reads the state, adds its
section — policy, intent, evidence, composition, outcome — and emits the new
state; `ok` advances, `refused` is a declared terminal outcome recorded with its
code and reason (the engine never retries a refusal into a different answer);
the composer is the one `model` node, bound to its sealed binding. Evidence
lives in `SqliteUnitStore` (`lib/engine-v2`), the engine's own store contract
persisted per operation and unit-scoped, and a re-run of the same request is
answered from the unit's journey. The host seam the runner shares with the
fabric worker and the triage panel is described in `docs/V2-ENGINE-PORT.md` §7.

`lib/draft-runner/vendor-pin.js` verifies that pin before the engine is
loaded, and fails closed on a changed byte, an added or removed file, a moved
pin, or a path that escapes the vendored root. The vendored engine imports
only Node builtins and its own relative files; a test asserts that.

Updating the engine means re-vendoring from a new published release and
updating both the manifest and the constants in `vendor-pin.js`. A drifted
tree stops the runner rather than running unverified code.

`vendor/mission-eal/` (Mission EAL v0.2.0, the host-neutral LLM client the
triage panel's resolver uses to reach local model endpoints) sits under the
**identical** mechanism: its own `manifest.json`, its own `PINS` entry in
`vendor-pin.js`, verified before load. It is not declared in `package.json` —
`vendor-pin.js` resolves it by path — so no dependency graph names it. Both
trees are retained on purpose; see `vendor/README.md` for the retention record
and the upgrade discipline.

## Tests

`test/draft-runner.test.js` covers the pin, the engine's dependency isolation,
the compiled DAG's stable shape, the happy path, deterministic replay, every
mapped event kind, injection resistance, evidence admissibility, each refusal,
every effect and capability claim, hostile composer behavior, the sensitive
scan, and the process boundary itself.
