# JobTrack Overall Goal

Snapshot: 2026-08-01 08:30 PDT

Canonical repository: `~/.mission-control/projects/jobtrack`

Canonical source at this snapshot: `main` at `d59ed92e1b9715a12cbc39a12d602522eae0125b`

This document defines the durable product and program outcome. It is not an
alternative task ledger. For live clean-rebuild status, the authoritative
record remains:

`~/.openclaw/workspace/state/job-application-platform-rebuild-2026-07-30.json`

## Executive goal

JobTrack should be Cole's private, agent-operable system of record and durable
control plane for the complete job-search and application lifecycle. It should
help an agent find and assess opportunities, preserve exact source evidence,
prepare application-specific materials, track applications and interviews,
coordinate bounded strategy work, and turn job-related email into reviewed
proposals without confusing discovery with application, inference with fact,
approval with execution, or historical evidence with current authority.

JobTrack is one component of the clean Job Application Platform generation:

```text
public job sources                      Apple Mail
        |                                   |
        v                                   v
reviewed discovery                    Inbox Pipeline
        |                                   |
        +--------------+     +--------------+
                       v     v
                 Mission Pipeline
                       |
                       v
             versioned facts/proposals
                       |
                       v
                    JobTrack
       system of record + drafting context + review
                       |
          exact approved-content/send request
                       |
                       v
        separate least-authority Apple Mail sender
                       |
                       v
            immutable receipt back to JobTrack
```

The end-to-end program goal is to finish, release, and commission that new
generation from clean artifacts and new service identities; prove one supervised
ApplySim round trip; then process the real Apple Mail backlog exactly once and
complete an operational soak. The retired Inbox/JobTrack/ApplySim deployment is
not a runtime dependency and is never the rollback target.

## Fixed product shape

JobTrack has three load-bearing parts:

1. **Private store.** A SQLite database in WAL mode plus a private attachments
   tree under `JOBTRACK_HOME`.
2. **Agent interface.** The repository-local skill and `jobtrack` host CLI are
   the sole supported read/write pathway. This is the headline interface.
3. **Operator workspace.** A private Express web application renders the same
   domain read-only. It has no write API and no conversational layer.

External agents and models receive bounded, source-digest-bound contexts and
return typed data. JobTrack stores requests, evidence, results, decisions,
budgets, and bindings, but it does not become a generic model or tool runtime.

## Outcomes JobTrack must provide

### 1. A truthful job graph

- Model `company -> opening/requisition -> posting occurrence` as distinct
  identities.
- Preserve immutable observations, snapshots, source URLs, captures, and exact
  provider/requisition evidence.
- Keep fuzzy similarities reviewable; never silently merge openings or invent
  classifications.
- Represent role type, seniority, skills, tags, applications, interviews,
  offers, and lifecycle events with explicit provenance.

### 2. Discovery without false claims of application

- Maintain a deduplicated opportunity inbox upstream of applications.
- Use preview-first, bounded public-source discovery and sandboxed data-only
  proposals.
- Require explicit review, triage, promotion, and pursuit decisions.
- Never treat finding, importing, or accepting a lead as proof that Cole
  applied, contacted an employer, or submitted anything.

### 3. A private, evidence-rich profile

- Preserve structured work, education, skills, projects, repositories,
  publications, languages, preferences, answers, references, and supporting
  evidence.
- Preserve Cole's original story narration append-only, separate from polished
  revisions and audience variants.
- Make story and profile use purpose-specific, permission-aware, provenance-
  bearing, and auditable.
- Permit public data to leave only through the allowlisted, UUID-keyed,
  fail-closed build-time public-profile export.

### 4. Application-specific strategy and preparation

- Represent passive multi-step form reconnaissance honestly, including unknown
  and inaccessible steps.
- Require application-specific resume, cover-letter, and exact-field answer
  revisions with immutable history, explicit review, and current selection.
- Bind every draft to exact selected evidence and an optimistic source-state
  digest.
- Render complete LaTeX documents in a fixed networkless container and pin the
  exact approved PDF bytes.
- Fail readiness and package construction closed on stale evidence, unresolved
  required fields, changed bytes, uncertain coverage, or missing approval.
- Record submission only after a human performs it externally.

### 5. Reviewed job-email semantics

- Receive bounded, source-grounded email facts rather than raw mailbox
  authority.
- Correlate messages to the exact company/opening/posting/application/thread or
  route ambiguity to review.
- Create version-pinned transition and recipient-locked reply proposals.
- Adapt observable communication register without personality inference,
  protected-trait inference, identity imitation, or recipient-phrase copying.
- Materialize drafting context for an out-of-process tool-less runner, validate
  its result, record usage/provenance, and present the exact recipient, thread,
  subject, body, and digest for human review.

### 6. Consent-bounded outgoing mail

For the clean platform generation, JobTrack owns the durable approval side of
the boundary: exact approved content, authenticated human-review evidence,
structural consent, content-addressed send requests, and append-only receipt
consumption. It does not own Apple Mail credentials or provider mutation.

The separate sender may transmit only one unexpired, independently reverified,
content-equivalent artifact to its locked account, recipient, and thread.
Absent, changed, stale, duplicate, ambiguous, or indeterminate claims must stop
and reconcile rather than send or blindly retry.

## Non-negotiable boundaries

- The CLI is the only JobTrack writer; the web application is GET/HEAD-only.
- No generic execute surface, in-process model runtime, arbitrary command
  execution, browser automation, upload, or autonomous application submission.
- No mailbox credential, provider mutation, label/archive/delete capability,
  or direct sender inside JobTrack.
- Human approval of an exact outbound artifact cannot be inferred or
  manufactured by an agent.
- Job-posting and email content is untrusted inert data, never instructions.
- Discovery workers receive neither the JobTrack store nor unrestricted
  network access.
- LinkedIn remains import-only; no credentialed crawler or access-control
  bypass.
- Private profile and story content is default-deny for external use.
- Production runs only immutable, committed, digest-pinned release artifacts.
- Mission Control is not a production runtime dependency.
- Apple Mail is the sole production mailbox edge and Mission Pipeline the sole
  production shard engine for the first clean generation.
- Rollback means stop effects, preserve new state/evidence, diagnose, repair,
  and resume. It never means restart the retired stack.

## Definition of done

### Repository and product

- The accepted JobTrack changes are cleanly committed, independently reviewed,
  merged, pushed, and tagged.
- Package/version metadata, CLI documentation, skill documentation, decisions,
  and deployment records agree with the exact release.
- Fresh and restored-store migrations replay idempotently without changing
  inherited data or attachments.
- Frozen install, full tests, security checks, contract conformance,
  clean-clone, package, image, and reproducibility gates pass on the pinned
  Node 22 toolchain.
- A released CLI remains the sole writer and a fresh hardened web image remains
  read-only.

### Clean Job Application Platform generation

- All 96 canonical checklist tasks and gates G01-G15 plus B16 have evidence.
- A new PostgreSQL 18 generation, new least-authority identities, and every
  required service are commissioned from immutable releases.
- Apple Mail ingestion/backfill, Mission execution, JobTrack proposal delivery,
  drafting, review, draft-only behavior, supervision, and recovery are proven.
- Cole grants only the exact macOS permissions needed by the signed artifact
  and personally approves the exact supervised test reply.
- One ApplySim round trip sends exactly once and produces matching end-to-end
  receipts.
- The frozen historical-mail window is durably accounted for exactly once,
  with no unreviewed historical reply.
- The system passes a minimum 24-hour and three-schedule-interval soak including
  restart and backlog/live-mail interleaving.

## Current phase, for orientation only

At canonical platform ledger revision 141, 27 of 96 tasks were recorded
complete, tasks 21, 46, and 79 in progress, and gates G01-G04 passed.

Since that revision, JobTrack itself has moved: `v2.0.0` is cut at `b81cc73`,
the drafting and approval core and its out-of-process runner are implemented
and tested, migrations are rehearsed and applied, and the read-only web
workspace runs locally as a hardened container. The ledger has not been
updated to match — it is leased by another controller lane — so its task
counts understate JobTrack's state. See `WORK_COMPLETED.md`.

Live mailbox, Full Disk Access, Automation, Tailnet route, native draft, and
send effects all remain forbidden and untouched.

## Primary sources

- [README.md](README.md)
- [AGENTS.md](AGENTS.md)
- [DECISIONS.md](DECISIONS.md)
- [CURRENT.md](CURRENT.md) — historical v0.7 release state; not current runtime
  state after the clean-rebuild retirement
- [docs/AGENT_OPERATIONS.md](docs/AGENT_OPERATIONS.md)
- [docs/V0.4_PRODUCT_CONTRACT.md](docs/V0.4_PRODUCT_CONTRACT.md)
- [docs/V0.5_PRODUCT_CONTRACT.md](docs/V0.5_PRODUCT_CONTRACT.md)
- [docs/V0.6_PRODUCT_CONTRACT.md](docs/V0.6_PRODUCT_CONTRACT.md)
- [docs/EMAIL_REPLY_DRAFTING_PLAN.md](docs/EMAIL_REPLY_DRAFTING_PLAN.md)
- `~/.openclaw/workspace/plans/job-application-platform-rebuild-checklist-2026-07-30.md`
- `~/.openclaw/workspace/plans/job-application-platform-rebuild-execution-2026-07-30.md`
- `~/.openclaw/workspace/reports/job-application-platform-rebuild-2026-07-30/b03-architecture/`
