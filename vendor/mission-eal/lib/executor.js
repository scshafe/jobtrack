// executor.ts — the EAL's uniform agent-invocation seam (mission-restructure A2).
//
// One executor interface covers every way an agent step can run: a full
// worktree turn (MC's opencode-docker build/chat turns), a corpus-read turn
// (read-only projection, no git), and a bare model inference (the inbox
// classify shape — no codebase, no container). `kind` is METADATA (descriptor
// projection + preflight selection); `execute` is uniform, and the §9
// machine-ignorance stop-gate (DESIGN-EMAIL-DRAFTING-HOST.md) binds: consumer
// turn paths never branch on kind or machine — each consumer path is uniform
// over whatever executor its environment bound.
//
// mc-harness implements the worktree kind (createHeadlessTurnExecutor over
// HeadlessTurn); this package implements model-inference over LlmClient
// (model-inference-executor.ts). MC-specific turn extras (agent servers,
// provider-session resume, delegation contracts, projectId) travel in
// `harnessOptions` — an opaque record the binding executor parses LOUDLY —
// so this vocabulary stays host-neutral.
export {};
