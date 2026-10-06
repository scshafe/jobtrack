'use strict';

// ports.js — JobTrack's host bindings for v2 worker node ports over a
// state-accumulating graph (docs/V2-ENGINE-PORT.md §7).
//
//   createCodePort   stage bodies `{ id, version, run(state) → section }` become a
//                    CodeNodePort: the returned section is merged into the state
//                    artifact and the turn settles `ok`; a thrown REFUSAL (an error
//                    whose `code` the host marks as a refusal) settles `refused`
//                    with the refusal recorded on the state artifact. Anything
//                    else propagates and the engine classifies it (retryable vs
//                    terminal) exactly as it would any node body failure.
//
//   createModelPort  a v1-shaped ModelBindingResolver (`resolve(binding) → {
//                    invoke(request, signal) → { output, usage }, compiledPrompt? }`)
//                    becomes a ModelNodePort. The port resolves the sealed binding
//                    the node names, has the engine verify the resolution
//                    (`verifyResolvedModelBinding` — a promptStackRef binding MUST
//                    surface the compiled prompt whose identity matches), invokes,
//                    validates the receipt and the output against the node's own
//                    contract validator, and records exactly one usage receipt.
//                    A contract-violating output is a TERMINAL typed failure
//                    (`model_output_contract_invalid`, the v1 code) — it dead-letters
//                    rather than being retried into a different answer.
//
// Node bodies receive only the validated input payload and the engine's minimal
// context; nothing here hands them a store, a lease or graph authority.

const { OK, REFUSED } = require('./linear-graph');

/** The usage-receipt.v1 `unavailable` floor: no provider reached, never a silent zero. */
function unavailableReceipt(durationMs) {
  return {
    schemaVersion: 'usage-receipt.v1',
    trust: 'unavailable',
    observedInputTokens: null,
    observedOutputTokens: null,
    chargedTokens: 1,
    observedCostMicroUsd: null,
    chargedCostMicroUsd: 1,
    durationMs: Math.max(1, Math.round(durationMs))
  };
}

function refusalRecord(error) {
  return {
    code: String(error.code),
    message: String(error.message ?? ''),
    ...(error.details !== undefined ? { details: error.details } : {})
  };
}

/**
 * @param {{ mp: object, stateContract: string, stages: Record<string, { run: Function }>,
 *   isRefusal: (error: unknown) => boolean, merge?: (state: object, section: unknown, nodeId: string) => object }} options
 *   `stages` is keyed by nodeId; `merge` defaults to a shallow spread of the section into the state.
 */
function createCodePort({ mp, stateContract, stages, isRefusal, merge }) {
  const mergeSection = merge ?? ((state, section) => ({ ...state, ...section }));
  return Object.freeze({
    async run(input, context) {
      const stage = stages[context.nodeId];
      if (!stage) throw new mp.ExecutionFailureError('code_node_unbound', false, new Error(`no stage bound for node ${context.nodeId}`));
      let section;
      try {
        section = await stage.run(input, context);
      } catch (error) {
        if (isRefusal(error)) {
          return {
            outcome: REFUSED,
            outputArtifact: mp.createArtifactEnvelope(stateContract, { ...input, refusal: { nodeId: context.nodeId, ...refusalRecord(error) } })
          };
        }
        throw error;
      }
      return {
        outcome: OK,
        outputArtifact: mp.createArtifactEnvelope(stateContract, mergeSection(input, section, context.nodeId))
      };
    }
  });
}

/**
 * @param {{ mp: object, stateContract: string, resolver: { resolve: Function },
 *   bindings: object[], nodes: Record<string, { stageId: string, stageVersion: number,
 *     inputFor: (state: object) => unknown, validateOutput: (output: unknown) => unknown,
 *     merge: (state: object, output: unknown) => object }>,
 *   isRefusal: (error: unknown) => boolean }} options
 *   `bindings` are the sealed ModelStageBindings the graph's model nodes reference.
 */
function createModelPort({ mp, stateContract, resolver, bindings, nodes, isRefusal }) {
  const byRef = new Map(bindings.map((binding) => [`${binding.bindingId}@${binding.version}:${binding.bindingDigest}`, binding]));
  return Object.freeze({
    async invoke(input, bindingRef, context) {
      const spec = nodes[context.nodeId];
      if (!spec) throw new mp.ExecutionFailureError('model_node_unbound', false, new Error(`no model spec bound for node ${context.nodeId}`));
      const binding = byRef.get(`${bindingRef.bindingId}@${bindingRef.version}:${bindingRef.bindingDigest}`);
      if (!binding) {
        throw new mp.ExecutionFailureError('model_binding_unknown', false, new Error(`node ${context.nodeId} names binding ${bindingRef.bindingId}@${bindingRef.version} (${bindingRef.bindingDigest.slice(0, 12)}) which this host did not seal`));
      }
      const started = Date.now();
      let resolved;
      try {
        resolved = mp.verifyResolvedModelBinding(await resolver.resolve(binding), binding);
      } catch (error) {
        if (isRefusal(error)) {
          return {
            outcome: REFUSED,
            outputArtifact: mp.createArtifactEnvelope(stateContract, { ...input, refusal: { nodeId: context.nodeId, ...refusalRecord(error) } }),
            usage: [unavailableReceipt(Date.now() - started)]
          };
        }
        throw error;
      }
      const result = await resolved.invoke({
        runId: context.unitId,
        itemId: context.unitId,
        nodeId: context.nodeId,
        stage: { id: spec.stageId, version: spec.stageVersion },
        attempt: context.attemptIndex,
        idempotencyKey: context.idempotencyKey,
        input: spec.inputFor(input),
        binding
      }, context.signal);
      let receipt;
      try {
        receipt = mp.validateUsageReceipt(result?.usage);
      } catch (error) {
        throw new mp.ExecutionFailureError('model_usage_receipt_invalid', false, error);
      }
      let output;
      try {
        output = spec.validateOutput(result.output);
      } catch (error) {
        throw new mp.ExecutionFailureError('model_output_contract_invalid', false, error);
      }
      return {
        outcome: OK,
        outputArtifact: mp.createArtifactEnvelope(stateContract, spec.merge(input, output)),
        usage: [receipt]
      };
    }
  });
}

module.exports = Object.freeze({ createCodePort, createModelPort, unavailableReceipt });
