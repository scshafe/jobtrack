# Next implementation prompt

Use this prompt from the JobTrack workspace:

```text
Inspect JobTrack and the sibling Applysim project to identify and implement
the next useful, unblocked piece of planned work.

Read applicable AGENTS.md instructions, current repository plans/backlogs,
and available Mission Control plan records. Check them against current code,
tests and newer implementation records: do not trust stale checkboxes alone.
Separate missing implementation from code already built, deployment gaps,
live acceptance tests, operator decisions, deferred ideas and non-goals.

Choose one bounded task, respecting the plans' dependency order. Briefly state
why it is next, its acceptance criteria, affected projects and verification
plan, then implement it without waiting for another planning-only turn.

Preserve existing worktree changes. Maintain the read-only web/CLI-only-writer
architecture, source provenance, approval gates and private-journal exclusion.
Use synthetic disposable fixtures for tests; do not access protected/shared
OpenClaw payloads or use a personal JobTrack store as a test target.
Do not send mail, submit applications, change credentials or production policy,
push, deploy or run live drills without separate explicit authorization.
If a task requires that authority, stop at the boundary and explain it.

Implement a coherent slice, add regression tests, run proportionate checks,
and obtain the independent review required by AGENTS.md. Address findings,
update the relevant plan with evidence, and report what changed, what passed,
what remains and whether anything was deployed. Do not mark a larger phase
complete merely because one prerequisite or local test passed.
```
