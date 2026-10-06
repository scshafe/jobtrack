# The fabric worker runner on Mission Pipeline v2

Status: **complete 2026-09-01** (mission-control `PLAN-CLEANUP-AND-HARDENING.md`
P3-2). Slice 1 (§1–§6) moved the fabric worker runner and was accepted by the
real-claude drill; slice 2 (§7) moved the reply-draft runner and the triage
panel onto a shared host seam and **retired the v1 engine tree**. Mission
Pipeline 1.0.0 is JobTrack's only engine.

## 1. Why this is a port, not a bump

`lib/fabric-worker-runner/pipeline.js` executed one agent turn on the vendored
Mission Pipeline **v0.2.0** (the v1 static-DAG engine). Upstream deleted the v1
execution surfaces at `d22fb89a` (engine 1.0.0, 2026-08-30): `StageCatalog`,
`createPipelineDefinition`, `compilePipeline`, `runOneShard`, the
`PipelineStore` port, and the v1 agent-node invoker
(`createAgentNodeInvoker` / `createAgentReceiptLedger`). In 1.0.0
`lib/agent/executor-port.js` compiles to `export {}` — interfaces only. The
runner's every engine call had no target.

## 2. Gap list — v1 surface used → v2 equivalent

| v1 (what the runner called) | v2 (mission-pipeline 1.0.0) | port decision |
|---|---|---|
| `StageCatalog` + `catalog.register({descriptor, executable})` with a `ContractValidator` port | none — a node is `MissionPipelineNode` `{nodeId, ref, kind, input: contractId, outcomes, principal, turn}`; payload schema validation is the host's job | request/report JSON validation stays in the runner; the node names the contract ids |
| `createPipelineDefinition` + `compilePipeline` → `compiled` | `createGraphDefinition({graphId, version, entry, nodes, edges, terminals})` → sealed `graphDigest`; `compileGraph` (outcome-completeness) | one-node graph `jobtrack-fabric-worker@2`, terminals `completed` and `failed` |
| `runOneShard({store, catalog, invoker, runId, shardId, maxAttempts, outboxEventsFor…})` | `publishGraph` → `admitUnit({unitId, graph ref, seedArtifact})` → `runNextUnitTurn({store, principalId, ports, leaseOwner, nodeId})` | unitId = `fabric-worker:<requestId>`; the runner claims **its own unit** through a unit-scoped store |
| `createAgentNodeInvoker({executor, specs:[{stage, environment, instructions, budget, deadlineMs}]})` | `WorkerNodePorts.agent = {submitTurnIntent(input, ctx), awaitSettledResult(ctx)}` → `{outcome, outputArtifact?, usage}` | the claude spawn becomes the agent port; the frozen `agent-step-{request,result}.v1` contracts are kept as the runner's internal executor seam so the stub/test executors are unchanged |
| agent-step taxonomy: `failed` terminal; `timed_out`/`infra_error` retryable within `maxAttempts` | throw `ExecutionFailureError(code, retryable)`: retryable → `turn_failed` journey record + retry up to `turn.maxAttempts`, then dead letter; a returned outcome settles | `completed`/`failed` return outcomes; `timed_out`/`infra_error` throw retryable; a contract-violating report throws terminal (`output_contract_rejected`) → dead letter |
| `SqlitePipelineStore` (`createRun`, `hasRun`, `committedOutput`) in `pipeline-evidence.db` | `UnitStore` + `GraphStore` ports; engine ships only memory stores; consumers own durable adapters (inbox: Postgres) | **`SqliteUnitStore`** (`lib/fabric-worker-runner/sqlite-unit-store.js`): the engine's executable memory specification, persisted per operation into SQLite, unit-scoped — § 3 |
| replay: `hasRun` → `committedOutput` | `admitUnit` is idempotent by unitId; `readJourney` holds `turn_settled` / `turn_failed`; `getArtifact` returns the sealed output | a settled unit replays from its journey without a second agent; a dead-lettered unit replays as `replayed_failure` |
| usage receipts through the invoker's receipt ledger | `usage: UsageReceipt[]` on the agent completion; journey records carry them; `node_turn_usage_receipt` outbox events | unchanged schema (`usage-receipt.v1`) |
| `vendor/mission-pipeline` (v0.2.0) pinned by `vendor-pin.js` | `vendor/mission-pipeline` (1.0.0 @ `d22fb89a`, tree `97b89fe0…`) — same byte-pin mechanism, the one `PINS['mission-pipeline']` entry, `loadMissionPipeline()` | slice 1 vendored 1.0.0 beside v1 (`-v2` suffix); slice 2 retired v1 and the suffix once every consumer had moved (§7) |

## 3. Shape decision: one v2 graph per worker turn, unit-scoped SQLite store

Two shapes were on the table.

**A worker turn as a one-node v2 graph** (chosen). Every dispatch admits one
`MissionPipelineUnit` into the sealed graph `jobtrack-fabric-worker@2` (one
`agent` node, `worker_turn`, principal `jobtrack.fabric.worker`) and runs its
single turn. The engine supplies exactly what the v1 runner bought: a sealed
identity that changes when the node/contract/environment posture changes,
append-only journey evidence with usage receipts, cached-attempt reuse, the
retryable-vs-terminal taxonomy with a bounded attempt budget, and replay from
committed evidence. The graph never sees the dispatcher — routing is empty by
construction (both outcomes are terminals).

**The runner as a v2 code-node host** (rejected). Making the fabric tick loop
itself a v2 graph (dispatch → worker → verify → submit as nodes) would move
jobtrack's fabric control plane into the engine. That is a redesign of
`lib/fabric.js`, not a port of the runner, and the fabric tick's gates
(`application.submission.approve` is a HUMAN act) already have their own
authority model. Out of scope; noted as a future direction.

**The store.** mission-pipeline ships `MemoryUnitStore` as the executable
specification and expects consumers to own durable adapters (inbox owns the
Postgres one, whose N4 design hydrates the store state per operation and
persists a delta). JobTrack's adapter follows the same shape at SQLite scale:

- `SqliteUnitStore` wraps `MemoryUnitStore`. Each operation runs inside one
  `BEGIN IMMEDIATE … COMMIT`: load the scope's `MemoryUnitStoreStateSnapshot`
  from `engine_unit_state`, load every published graph into a
  `MemoryGraphStore`, run the operation on the hydrated memory store, then
  persist the new snapshot and the evidence projections
  (`engine_journey`, `engine_outbox`, `engine_dead_letters`) — or roll back if
  the operation threw before its commit checkpoint.
- **Unit scoping.** The runner opens the store with `scope = unitId`, so its
  snapshot holds exactly one unit and `runNextUnitTurn` can only claim that
  unit — a stale queue left by a crashed sibling process is never picked up by
  a different request. Cross-scope reads (`listDeadLetters()`,
  `listOutboxEvents()` without a unit) union every partition.
- **Concurrency.** Operations are serialised in-process (a promise chain) and
  across processes by SQLite's write lock (`busy_timeout`), so two workers on
  the same evidence database never lose an update.
- **What this is not.** It is not a relational unit store; a partition's
  snapshot is rewritten per operation. That is the documented N4 trade-off and
  bounded here by the one-unit scope. If a future consumer needs cross-unit
  fairness or thousands of queued units in one scope, the F1 scoping work
  inbox carries applies here too.
- **Conformance.** The engine's own `registerUnitStoreConformanceTests` and
  `registerGraphStoreConformanceTests` run against `SqliteUnitStore`
  (`test/fabric-engine-v2-store-conformance.test.mjs`), including the
  settle-checkpoint crash/recover cases.

## 4. The turn, end to end

```mermaid
sequenceDiagram
    participant D as applysim dispatcher (pipelineWorkerCmd)
    participant R as bin/jobtrack-fabric-worker.js
    participant P as lib/fabric-worker-runner/pipeline.js
    participant S as SqliteUnitStore (pipeline-evidence.db)
    participant E as mission-pipeline 1.0.0 (vendored, byte-pinned)
    participant A as agent port (claude -p … --output-format json)

    D->>R: request.v1 on stdin (requestId, node, brief, model, deadlineMs)
    R->>P: runFabricWorkerRequest(request)
    P->>P: vendorPin.loadMissionPipeline() — verify tree, import lib
    P->>S: publishGraph(jobtrack-fabric-worker@2) — idempotent by digest
    P->>S: admitUnit(unitId=fabric-worker:<requestId>, seed=request envelope)
    alt unit already settled or dead-lettered
        S-->>P: journey: turn_settled | dead letter
        P-->>R: replayed result (no agent spawned)
    else queued
        P->>E: runNextUnitTurn(store, principal=jobtrack.fabric.worker, ports.agent, nodeId=worker_turn)
        E->>S: claimUnitTurns → prepareTurnAttempt (lease, attempt N)
        E->>A: submitTurnIntent(input, ctx) / awaitSettledResult(ctx)
        A-->>E: {outcome: completed, outputArtifact: report.v1, usage} — or throws ExecutionFailureError(timed_out|infra_error, retryable)
        E->>S: settleTurn (journey + artifact + outbox + lease release, one transaction) — or recordTurnFailure → retry / dead letter
        P->>S: readJourney(unitId) → result
        P-->>R: {status, report, usage, evidence:{unitId, graph, databasePath, replayed:false}}
    end
    R-->>D: result.v1 on stdout; exit 0|4|5|6
```

### 4.1 Harness selection (2026-09-01)

The agent node's executor is chosen by the request's optional `harness`
field — `claude` (the original, `lib/fabric-worker-runner/claude-executor.js`,
a headless `claude -p` session) or `codex`
(`lib/fabric-worker-runner/codex-executor.js`, a headless `codex exec --json`
session authenticated by the operator's ChatGPT OAuth login: no API key, no
metered spend). Both speak the frozen `agent-step-{request,result}.v1` seam,
so the engine port, the graph, the evidence tables, and the replay rules are
byte-identical across harnesses; only the spawn differs. The codex executor
reads the JSONL event stream (`thread.started` → `agentSessionId`,
`item.completed agent_message` → the report, `turn.completed.usage` → a
provider-reported receipt with cost observed-null/charged-0 because a
subscription login reports none, `error` → `agent_error`), passes the brief on
stdin rather than argv, and runs with
`--dangerously-bypass-approvals-and-sandbox` for the same reason the claude
spawn skips permissions: the brief drives the JobTrack CLI outside the scratch
cwd and reaches the loopback site, which the workspace sandbox forbids. A
request that reuses a `requestId` with a different harness is a different seed
and is refused as `REQUEST_ID_REUSED`, by design. Tests:
`test/fabric-worker-codex-executor.test.js` (fake spawn; no binary, no network).

## 5. Acceptance

- [x] Gap list above, written before the port.
- [x] `SqliteUnitStore` passes both engine conformance suites.
- [x] `test/fabric-worker-runner.test.js` semantics preserved on v2: durable
      evidence + replay without a second agent; `failed` terminal; `infra_error`
      and `timed_out` retryable then surfaced; contract-violating report is a
      terminal rejection; stdin/stdout runner protocol and exit codes unchanged.
- [x] applysim's engine-backed integration case (stub executor) passes against
      the v2 evidence tables — the deterministic full arc.
- [x] **The real-claude drill PASSED 2026-09-01** — applysim
      `drill-2609012047-c32fab5e`, launched on the operator's word with
      `--approved-by Cole`: outcome `submitted` after 21 ticks, six claude turns
      all exit 0 through this runner (model pinned `claude-sonnet-5`), v2 ledger
      with the sealed graph published once, 6 units admitted + settled
      `completed`, 0 dead letters; scorer 0 blockers, submission floor met;
      crosscheck consistent 8/8; 11 min, $3.12. Recorded in applysim's
      `docs/DRILL-CAMPAIGN-LOG.md`.
- [x] Retire `vendor/mission-pipeline` (v1) and `pipeline.v1.js` — done in
      slice 2 (§7) together with porting the reply-draft runner and the triage
      panel.

## 6. Rollback

During slice 1 the v1 tree stayed vendored and the v1 fabric runner was
preserved verbatim behind `JOBTRACK_FABRIC_WORKER_ENGINE=v1`. After the
acceptance drill that rollback stopped being load-bearing, and slice 2 retired
it with the v1 tree. Rollback is now a git revert of the retirement commit; the
v1 evidence tables (`runs`, `attempts`, …) left in existing
`pipeline-evidence.db` files are inert history beside the `engine_*` tables and
were deliberately not dropped.

## 7. Slice 2 — the reply-draft runner, the triage panel, and the retirement

Retiring the v1 tree meant every consumer had to move. The survey named the
fabric runner; the tree in fact had three: `lib/draft-runner/pipeline.js` (the
B07 reply-draft runner), `lib/triage-panel/pipeline.js` (the opportunity triage
panel — five model panellists plus a deterministic synthesis) and the preserved
v1 fabric runner. Both remaining runners were linear or fan-in DAGs of code and
model stages with multi-slot inputs, executed by `runOneShard` over
`SqlitePipelineStore`.

### 7.1 Gap list — what the two runners used → v2

| v1 | v2 | decision |
|---|---|---|
| `StageCatalog` with per-stage input/output contracts and multi-slot node inputs (`node_output` sources from several nodes) | one input artifact per node, routed by outcome | a **state artifact** per runner (`jobtrack-email-reply-draft-state.v1`, `jobtrack-triage-panel-state.v1`): every node reads the state and adds its section; the frozen per-section contract ids stay as validators the host applies on each node's edge |
| `PipelineStageError(code, retryable=false, …, 'item')` — a stage refusal as a typed terminal failure | throw → retry taxonomy → dead letter; or RETURN a declared outcome | refusals are a **declared `refused` outcome** on every node (terminal), recorded on the state with code/message/details; the runner surfaces them as the same `DRAFT_NOT_COMPOSED` / `PANEL_INCOMPLETE` errors with the refusing node's code |
| `createModelNodeInvoker` + `createModelReceiptLedger` over a `ModelBindingResolver` | `WorkerNodePorts.model.invoke(input, bindingRef, ctx) → {outcome, outputArtifact, usage:[receipt]}`; `verifyResolvedModelBinding` survives | `lib/engine-v2/ports.js createModelPort`: same resolver interface as v1 (so every existing resolver and test double is unchanged), engine-verified resolution (a `promptStackRef` binding must surface its compiled prompt), one validated receipt, `model_output_contract_invalid` as a terminal failure |
| fan-out to five panellist nodes + fan-in `synthesize` | joins exist (`all` / `nOf`) but SYNCHRONISE: the joined node receives one selected edge's artifact and bodies cannot read the store | the panel runs as a **chain that accumulates verdicts** (each panellist's prompt still sees only the posting); the synthesis node reads them off the state. Provenance is unchanged: every panellist is its own node with its own sealed binding, so the graph digest changes when any persona does |
| `SqlitePipelineStore` + `test-support/pipeline-store-conformance.js` | `SqliteUnitStore` (slice 1) | store, schema and v1 conformance suite deleted; the engine's own UnitStore + GraphStore suites run against `SqliteUnitStore` |
| `runOneShard` → `outcome.status`, `store.committedOutput`, `store.latestDeadLetter` | `runNextUnitTurn` until nothing is claimable; journey + artifacts + dead letters | `lib/engine-v2/run-unit.js runUnitToCompletion`: admit-once (a re-run finds its unit), replay from a terminal settlement, drive to completion otherwise, return journey/terminal/dead-letter/receipts |
| provenance `pipeline.compiledDigest`, `nodes[].bindingFingerprint`, `compiled-pipeline.v2` | `graph.graphDigest`, `nodes[].binding.bindingDigest` | provenance documents bump to `…-provenance.v2` with `graph` in place of `pipeline`; the CLI result document (`jobtrack-email-reply-draft-result.v1`) is byte-compatible |

### 7.2 The shared seam — `lib/engine-v2`

- `linear-graph.js` — `defineLinearGraph(mp, spec)`: a sealed chain where every
  node declares `ok | refused`, `ok` advances, each `refused` is a terminal and
  the last `ok` is the success terminal.
- `ports.js` — `createCodePort` (stage bodies → CodeNodePort, refusals →
  `refused`) and `createModelPort` (v1-shaped resolvers → ModelNodePort).
- `run-unit.js` — `runUnitToCompletion` + `refusalOf`.
- `sqlite-unit-store.js` — moved here from the fabric runner; unchanged.

The fabric worker keeps its own agent port (one agent node, no state chain) and
shares only the store.

### 7.3 What the port found

- The draft runner's CLI tests had been passing against the **operator's real
  evidence database** with an expiry (`2026-08-02`) the real clock passed weeks
  ago: v1 replayed an old committed run forever. The v2 unit id exposed it (the
  first honest run refused `request_expired`). The CLI cases now run against an
  isolated `JOBTRACK_PIPELINE_DB` with a far-future expiry; the one polluting
  unit was removed from the operator's file.
- `mission-eal` v0.2.0 declares a peer range of `mission-pipeline >=0.2.0
  <0.3.0`, but imports only `agent/step`, `contracts/usage-receipt` and the
  type-only `agent/executor-port` — all unchanged in 1.0.0 — so it loads against
  the v2 tree (`node_modules/mission-pipeline` → `vendor/mission-pipeline`).
- Retired: `vendor/mission-pipeline` (v0.2.0), `lib/fabric-worker-runner/
  pipeline.v1.js` (+ `JOBTRACK_FABRIC_WORKER_ENGINE`), `lib/draft-runner/
  sqlite-pipeline-store.js`, `sqlite-store-schema.js`,
  `test-support/pipeline-store-conformance.js`, `test/pipeline-store-conformance.test.js`,
  the `-v2` suffix on the vendored tree and its `PINS` entry.

Suites: draft runner 19/19, triage panel 13/13, fabric worker + engine
conformance 51/51.
