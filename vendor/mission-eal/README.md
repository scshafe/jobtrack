# mission-eal

Mission EAL is the host-neutral Environment Adaptation Layer for typed agent
execution. It owns:

- environment descriptors, capability projections, and declarative tool/context
  assembly;
- uniform worktree, corpus-read, and model-inference execution contracts;
- the complete `CodebaseProvider` allocation/lifecycle/harvest port;
- per-invocation credential and sandbox-token authority;
- provisioning manifests and preflight verification;
- LLM and harness registries; and
- the sole adapter from Mission Pipeline's frozen `AgentStepExecutor` contract
  to a bound execution environment.

Mission EAL does not implement a Git/worktree backend, invoke a concrete agent
harness, persist tokens, or choose a deployment host. Those are host adapters.

## Dependency boundary

The only runtime dependency is Mission Pipeline, pinned to its `v0.1.1`
release commit
`07855eb194782323dbbed402f59fe238b713f815`. Source may import:

- relative modules within this repository;
- Node built-ins; and
- the three owned Mission Pipeline subpaths used by the agent-step/usage
  contracts.

There are no `file:`, `link:`, absolute-path, sibling-workspace, `mc-*`, or
other package dependencies.

Mission Pipeline is private. Local installs use the caller's GitHub SSH access.
GitHub Actions must be given a fine-grained token with read-only Contents
access to `scshafe/mission-pipeline` in the
`MISSION_PIPELINE_READ_TOKEN` repository secret. The workflow fails loudly if
that secret is absent; it never falls back to a public package with the same
name.

## Binding a codebase host

Mission EAL owns the port in `mission-eal/codebase`; a host supplies both
lifecycle behavior and commit inspection:

```ts
import { createCodebaseProvider } from "mission-eal/codebase";

const provider = createCodebaseProvider(lifecycleAdapter, {
  commitReader: {
    listCommitsBetween: (path, before, after) =>
      hostGit.listCommitsBetween(path, before, after)
  }
});
```

There is deliberately no default Git implementation and no fleet-node factory
in this package. A host decides how code is allocated, isolated, harvested,
and transported.

## Development and release proof

Node `22.22.x` is the release line:

```sh
npm ci
npm run verify
npm pack --dry-run
```

`lib/` is committed because Node does not type-strip TypeScript under
`node_modules`. `npm run verify` rebuilds it and fails if generated JavaScript
or declarations drift from `src/`.

The initial history is a subtree-preserving extraction from
`scshafe/mission-control@74081469646d8d50f1e5922e28f818a4330306fb`.
