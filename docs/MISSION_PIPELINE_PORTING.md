# Porting a surface onto Mission Pipeline

> **Engine note (2026-09-01).** This guide was written while JobTrack ran the v1
> static-DAG engine (mission-pipeline v0.2.0). The repo now vendors the **v2
> node-graph engine** (1.0.0) as its only engine; the porting shape for v2 —
> state-accumulating chains, declared `refused` outcomes, `SqliteUnitStore`,
> `lib/engine-v2` — is `docs/V2-ENGINE-PORT.md` §7. The principles below
> (sealed identity, evidence-first, fail-closed, one engine copy) carry over;
> the API names (`StageCatalog`, `compilePipeline`, `runOneShard`,
> `PipelineStageError`, `SqlitePipelineStore`) do not exist in 1.0.0.

Two JobTrack surfaces now run on the engine: the out-of-process reply-draft
runner and the multi-persona opportunity-triage panel. This is the method they
established, written down so the next port does not rediscover it.

The goal is **hardening the engine**, not migrating JobTrack for its own sake.
A second and third independent consumer is how a library's ports stop being
"an interface one thing satisfies" and become a contract. Judge a candidate
surface by what porting it teaches Mission Pipeline, and by whether the surface
gains real durability — not by whether it currently looks DAG-shaped.

---

## 1. Decide whether the surface should move at all

Port a surface when **any** of these is true:

- it hand-rolls something the engine already owns — retries, attempt budgets,
  leases, dead letters, idempotency, usage receipts;
- it calls a model, or should be able to, and today has no auditable record of
  which prompt and parameters produced which output;
- it would exercise an engine capability nothing else does yet (see §7).

Do **not** port when:

- the surface is a single deterministic transform. Wrapping one pure function
  in stage descriptors buys nothing and costs a node registry.
- the surface is frozen or superseded. Ceremony on dead code is still ceremony.
- porting would violate a product contract. `application-strategy` is the
  standing example: `docs/V0.6_PRODUCT_CONTRACT.md` states JobTrack never
  invokes a model API, enforced structurally by `FORBIDDEN_EFFECTS` and
  `effectLikeKey`. A model node calling a provider from inside it would break
  the property its own tests pin. Adopt validators there, not an executor.

---

## 2. Preserve the single-copy invariant

**This is the one mistake that fails silently.** Mission Pipeline classifies
stage failures with `instanceof`. Two copies of the engine in one process means
two sets of error classes, and roughly forty identity checks then resolve
against the wrong one. Only two fail loudly; the rest quietly degrade terminal
and shard-scoped signals into `{stage_execution_failed, retryable: true,
scope: item}`. The worst case is a `ShardLeaseLostError` from the foreign copy
becoming a retryable item failure, so a worker that has provably lost its claim
keeps appending evidence while another worker owns the shard.

The topology that holds:

- JobTrack vendors the engine under `vendor/mission-pipeline`, digest-pinned.
- `package.json` declares `"mission-pipeline": "file:vendor/mission-pipeline"`
  plus an `overrides` entry, so a transitive dependency cannot reintroduce a
  second copy.
- Any library that builds on the engine — Mission EAL does — declares it as a
  **peer dependency**, never a direct one.
- Both live in `devDependencies`, so `npm ci --omit=dev` keeps them out of the
  read-only web image with no Dockerfile change. Verify that after any
  dependency edit.

`lib/draft-runner/vendor-pin.js` verifies each vendored tree byte-for-byte
before loading it and `realpath`s the root first, because a symlinked checkout
would otherwise produce a second module record for identical bytes.

To vendor a new release: `git archive <tag> lib package.json LICENSE README.md`
into `vendor/<name>/`, regenerate the manifest, and update that package's entry
in `PINS`. Use the **tree** SHA (`git rev-parse <tag>^{tree}`), not the
annotated tag's object SHA — the pin check will catch the mistake, but knowing
saves a cycle.

---

## 3. Shape the pipeline

Contracts first, in `lib/<surface>/contracts.js`. You need a validator per
edge, exposed through a `ContractValidator` port (`knows` / `validate`). Model
`pipeline-node-input.v1` as a pass-through — the engine composes multi-slot
inputs under it.

Then the DAG. Both existing ports use the same three-part shape:

```
verify/prepare   code    validate the request's own policy; refuse early
     ↓
fan-out          model   the work that needs judgement
     ↓
seal/synthesize  code    assemble the answer from published rules
```

Keep the terminal node **code**, not model. The one number or document a human
acts on belongs on the auditable path; asking a model to do arithmetic it can
get subtly wrong puts it outside that path.

The DAG is static — max 64 nodes, compiled once. A panel of N personalities is
N sibling nodes, not a loop.

## 4. Seal identity into the digests

This is the property that makes a port worth doing.

For a model node, build a `model-stage-binding.v2` carrying
`createInferenceProfileRef` (every recorded parameter is required and fails
closed) and, where the node has a personality, `personaRef` and
`promptStackRef` from `createPersonaDefinition` / `createPromptStackDefinition`.

The chain is: prompt component digest → persona digest → stack digest →
binding digest → compiled node `bindingFingerprint` → `compiledDigest` → every
downstream stage idempotency key. Editing one trait therefore changes the
pipeline's identity, which is what makes "this configuration produced this
output" provable rather than asserted. Assert it in a test.

**A binding with a `promptStackRef` obliges its resolver to surface the
compiled prompt it will use.** The invoker verifies that identity and raises
`model_prompt_identity_mismatch` otherwise. Use `compilePromptStack` rather
than rendering the prompt yourself: it is code-owned, places the safety policy
first and the output rule last, and no operator component can displace them.

## 5. Run it durably

Use `SqliteUnitStore` (`lib/engine-v2/sqlite-unit-store.js`, unit-scoped; v1's
`SqlitePipelineStore` is gone). Against the engine's memory store alone the
idempotency, retry budget, dead letters, and outbox are instantiated and
discarded, which makes durability claims nominal.

Consequences to handle deliberately, all of which the draft runner hit:

- A settled shard is not claimable, so a replay returns `idle`. With durable
  evidence that is an **answer**: read the committed terminal output rather
  than treating it as a failure.
- Guard `createRun` with `hasRun` so a replay reuses the run instead of
  colliding on its primary key.
- Read usage receipts back from the outbox, not the in-process ledger. On a
  replay the ledger is empty by design.
- Raise `maxAttempts` above 1. Refusals should be non-retryable, item-scoped
  `PipelineStageError`s, so the budget governs only transient failures.
- Give each test its own database. Sharing one lets a later case replay an
  earlier one's committed run — correct behaviour, wrong measurement.

Evidence belongs in its own database, never the canonical store, whose schema
is governed by a migration ledger and rehearsed against a restored backup.

## 6. Prove it

Every port must add:

- a digest-stability test (compiling twice yields the same `compiledDigest`);
- an identity test (editing one binding input changes it);
- a replay test asserting the provider is **not** called a second time;
- a fail-closed test (no resolver injected ⇒ refuses rather than inventing);
- refusal tests per policy rule, asserting the typed code.

If you touch the store, run the conformance suite
(`test-support/pipeline-store-conformance.js`) against both implementations,
and mutation-check any new case — break the invariant deliberately and confirm
the suite fails.

---

## 7. Remaining surfaces

Ranked by what they teach the engine.

### interview-prep — recommended next

Its schema already names nine lenses (`role_focus`, `company_context`,
`candidate_fit`, `skill_map`, `risk`, `rehearsal_plan`, `questions_for_them`,
`logistics`, `other`). That is a panel with the dimensions pre-declared, and it
reuses the triage panel's machinery almost unchanged — which is exactly the
point: it proves personas generalise across domains rather than having been
fitted to one. It already has a review gate, a versioned analysis, and an
external-result boundary (`create --analysis-file`). Zero external effect.

Effort: small, mostly a new rubric and persona set.
Teaches: whether the panel abstraction is genuinely reusable.

### discovery — the durability port

The isolation design is strong and needs nothing. The **durability** design has
a live bug: `idx_discovery_runs_one_active_source` is a partial unique index
with no owner token, no TTL, no heartbeat and no reclaim path, so a crashed run
wedges a source at `running` until a human intervenes. There is also no attempt
counter, no dead letter, and rate state split between an in-memory map and a
disconnected column.

Fix the lease first as plain SQL — do not reach for the engine to fix a
twenty-line bug. Then, if you want the port, it is net-new construction on the
trusted-host side rather than consolidation, and it is the natural place to
exercise `runBoundShard` and `BoundPipelineEvidenceStore` (4 methods) with
JobTrack keeping settlement in its own transaction.

Effort: medium. Teaches: the externally-fenced path, currently unexercised.

### application-materials — a new capability, not a migration

Structurally the closest thing in the repo to the draft-runner pattern already:
a `sourceStateSha256` handshake, a record-side re-derivation with a genuine
TOCTOU check, an idempotency ledger, a mandatory review gate, and an injected
external executor whose output is re-validated byte-by-byte (the pinned LaTeX
renderer). All of that arrived independently.

But there is no model call to wrap — composition happens in the operator's own
conversation and enters as finished text. Porting means first inventing a
request/result/refusal contract triple and a runner binary. Judge it as a new
capability, and only take it if you want material drafting to become
machine-executable.

### application-strategy — validators only

Take `validateAgentStepRequest` / `validateAgentStepResult`: its work
request/result contracts are field-for-field `AgentStepRequest`/`Result`, so
the validators drop in with no boundary change and delete hand-rolled
validation. Consider `compileGateFlow` over the escalation ladder — the
termination certificate would upgrade `deriveWorkItemState`'s twelve-state
if-chain from a test-asserted property to a compile-time proof.

Do **not** adopt `createAgentNodeInvoker`: it is an in-process executor and
would violate the stated no-model-invocation property.

### email-draft-reply (frozen v1) — leave it

Superseded by outgoing-v2, cannot send, human-paced across days. The one step a
pipeline improves is already ported. Worth doing: replace the five still-live
dispatch branches with a typed `LANE_FROZEN` refusal, since the lane is frozen
by prose only.

---

## 8. Engine capabilities still unexercised

Vendoring bought the whole engine; these parts have no consumer yet, and each
is a candidate reason to choose one surface over another:

| Capability | Where it would land |
| --- | --- |
| `runBoundShard`, `BoundPipelineEvidenceStore` | discovery, host-owned settlement |
| Gate nodes, `compileGateFlow`, termination certificates | strategy escalation ladder |
| Agent nodes via Mission EAL's `agentStepPortFromEnvironment` | any surface needing a real agent harness rather than a single inference |
| `createArtifactEnvelope`, `putArtifact` / `getArtifact` | large drafting payloads |
| Multi-item shards, work leases, cross-run scheduling | the cross-project balancer |

The last row is the direction of travel. Both current ports use one item in one
shard, which exercises correctness but not scheduling. The first surface that
genuinely batches — triage across many discovered postings, say — is where
multi-item shards, lease contention, and eventually cross-project balancing
become real.

---

## 9. Checklist

```text
[ ] surface passes §1 (gains durability, or teaches the engine something)
[ ] contracts module with a ContractValidator port
[ ] static DAG, terminal node is code
[ ] model nodes carry sealed bindings; personas sealed where they exist
[ ] resolver surfaces its compiled prompt
[ ] runs on SqliteUnitStore, own database, replay reuses the unit journey
[ ] refusals are declared `refused` outcomes carried on the state artifact (never retried)
[ ] tests: digest stability, identity, replay, fail-closed, refusals
[ ] single engine copy verified; npm ci --omit=dev still excludes it
[ ] docs updated with what the port actually does, not what it aspires to
```
