// mission-eal — the Environment Adaptation Layer.
//
// The per-invocation provision surface, promoted from mc-harness
// (DESIGN-CONDUCTOR.md: "EAL = promote TurnExecutionEnvironment + the
// published package DAG, never a new invented layer"). Layer 1.5 in the
// import-boundary DAG: this package defines the seams; mc-harness implements
// them. Consumers import bare subpaths (mission-eal/descriptor, …); this
// barrel exists for discovery and the package main.
//
// A1 contents (leaf vocabulary): the shared EnvironmentDescriptor mirror, the
// sandbox auth-token store (mint==validate authority), the harness descriptor
// registry (TOOLS axis), the generic provision manifest + preflight verifier,
// and the LLM client. The environment aggregate (executor kinds, credential
// provisioner, context assembly) lands in Track A increments 2-5.
export * from "./descriptor.js";
export * from "./sandbox-auth-tokens.js";
export * from "./harness-registry.js";
export * from "./provision-manifest.js";
export * from "./preflight.js";
export * from "./llm-client.js";
// A2 — the uniform invocation seam: executor kinds + the two capability
// namespaces + the model-inference executor.
export * from "./capabilities.js";
export * from "./executor.js";
export * from "./model-inference-executor.js";
// A3 — the promoted environment: codebase seam (incl. inert + fleet-node
// providers), corpus-read projection, the credential-provision OPERATION, and
// the TurnExecutionEnvironment aggregate.
export * from "./codebase.js";
export * from "./corpus-read.js";
export * from "./credentials.js";
export * from "./environment.js";
// A4 — capability-checked context assembly and the single declarative tool
// surface projected into provisioning, token authority, and prompt context.
export * from "./context.js";
export * from "./tools.js";
// A5 — the sole bridge from mission-pipeline's frozen AgentStepExecutor port
// onto a bound EAL TurnExecutionEnvironment.
export * from "./agent-step-port.js";
