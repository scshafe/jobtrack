'use strict';

// linear-graph.js — a sealed Mission Pipeline v2 graph for a STATE-ACCUMULATING
// chain of code and model nodes (docs/V2-ENGINE-PORT.md §7).
//
// v1 pipelines wired multi-slot node inputs from several upstream outputs. A v2
// node takes ONE input artifact — the artifact its inbound edge carried — so a
// chain that needs earlier results downstream carries them forward in one STATE
// artifact: every node reads the state, adds its section, and emits the new
// state. Routing is by declared outcome: `ok` advances to the next node; every
// node may also end the journey with `refused` (a principled decision, not a
// failure — the refusal rides the state artifact so the reason is evidence, and
// the engine never retries it into a different answer); the last node's `ok` is
// the graph's successful terminal.
//
// The v2 join primitive (`all` / `nOf`) is a SYNCHRONISATION barrier: the joined
// node receives the artifact of ONE selected edge, and node bodies hold no store
// authority to read the others (`execute/ports.ts`). Fan-out → fan-in
// aggregation is therefore expressed as a chain that accumulates — the triage
// panel's five panellists run in sequence, each appending its verdict — which
// keeps every panellist's sealed binding as its own node (the graph digest still
// changes whenever any persona changes) and keeps the bodies authority-free.

const OK = 'ok';
const REFUSED = 'refused';

/**
 * @param {object} mp the vendored mission-pipeline 1.0.0 module namespace
 * @param {{
 *   graphId: string, version: number, description: string,
 *   principalId: string, stateContract: string,
 *   leaseMs?: number, maxAttempts?: number,
 *   nodes: Array<{ nodeId: string, ref: { id: string, version: number }, kind: 'code'|'model', binding?: object }>
 * }} spec  `binding` is a sealed ModelStageBinding (required for model nodes)
 * @returns {{ graph: object, compiled: object, terminals: object }}
 */
function defineLinearGraph(mp, spec) {
  if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) throw new TypeError('defineLinearGraph needs at least one node');
  const leaseMs = spec.leaseMs ?? 3_600_000;
  const maxAttempts = spec.maxAttempts ?? 2;
  const nodes = spec.nodes.map((node) => ({
    nodeId: node.nodeId,
    ref: node.ref,
    kind: node.kind,
    input: spec.stateContract,
    // The outcome vocabulary version must equal the node ref version.
    outcomes: { version: node.ref.version, outcomes: [OK, REFUSED] },
    principal: { id: spec.principalId },
    ...(node.kind === 'model'
      ? { binding: mp.modelStageBindingRef(node.binding) }
      : {}),
    turn: {
      idempotency: mp.NODE_TURN_IDEMPOTENCY,
      leaseMs,
      maxAttempts,
      retryTaxonomy: mp.NODE_TURN_RETRY_TAXONOMY
    }
  }));
  const edges = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    edges.push({
      edgeId: `${nodes[index].nodeId}__ok`,
      from: nodes[index].nodeId,
      when: { outcome: OK },
      to: [nodes[index + 1].nodeId]
    });
  }
  const terminals = [
    ...nodes.map((node) => ({ nodeId: node.nodeId, outcome: REFUSED })),
    { nodeId: nodes[nodes.length - 1].nodeId, outcome: OK }
  ];
  const graph = mp.createGraphDefinition({
    graphId: spec.graphId,
    version: spec.version,
    description: spec.description,
    entry: nodes[0].nodeId,
    nodes,
    edges,
    terminals
  });
  return { graph, compiled: mp.compileGraph(graph), terminals };
}

module.exports = Object.freeze({ OK, REFUSED, defineLinearGraph });
