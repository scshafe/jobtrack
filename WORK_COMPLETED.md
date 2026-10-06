# JobTrack Work Completed

Snapshot: 2026-08-01 10:05 PDT

Canonical repository: `~/.mission-control/projects/jobtrack`

Canonical source: clean `main` at
`b81cc7341cd31aa7e5ac25a58c2013e6dd24728c`, tagged `v2.0.0`

Latest release: `v2.0.0` (superseding `v0.7.0` at
`f2d8cb03c019259f0901c9b34e17e04f837be488`)

## What changed in this session

JobTrack 2.0 was cut and brought up locally at Cole's direct request. Seven
B07 commits landed on `main` — completing the drafting and approval core and
closing both audit rejections — the ten previously unreleased commits were
released with them, and the read-only web workspace now runs as a hardened
v2.0.0 container against the preserved canonical store.

- **Zero-trap crypto boundary repaired** (`7656eaf`). The blocker that rejected
  `5251ee4` is closed: signer byte views and resolved keys are classified with
  captured intrinsics in an order that executes no hostile code before
  rejection, and resolvers now accept only a canonical PEM string primitive, so
  a `KeyObject`'s attacker-controlled `type`/`export` is never reached.
- **Realm-level hardening after an independent adversarial audit** (`d6168c7`).
  Six attackers ran 428 hostile constructions; ten non-informational findings
  were verified, nine refuted — including both claimed release blockers — and
  one confirmed at hardening severity. That one is fixed by removing the
  dependency on `Buffer.prototype.toString` entirely and by refusing outright
  when the typed-array prototype chain has moved.
- **The out-of-process draft runner** (`f8da2fd`), closing the JobTrack half of
  task 46. `bin/jobtrack-draft-runner.js` executes a digest-sealed five-node
  Mission Pipeline DAG and holds no store, network, credential, mailbox, tool,
  send, or approval authority. Mission Pipeline v0.2.0 is vendored and pinned
  byte-for-byte to commit `d9d4e44`, verified before load.
- **Release `v2.0.0`** (`b81cc73`), which also cleared the status drift the
  handoff review found in `CURRENT.md`, `docs/TEMPORARY_STEWARDSHIP.md`,
  `DECISIONS.md` (now through D-026), and the CLI's export-schema help text.

Verification at the cut: 425 tests / 421 passed / 0 failed / 4 opt-in skips on
Node 22.22.0; zero dependency vulnerabilities; clean diff; both pinned trees
verified; `export public-profile` exits 0 against the live store. Migrations
were rehearsed on a restored backup first — 233 inherited tables with zero row
drift, 11 new empty tables, integrity ok, replay idempotent — and only then
applied to the canonical store, which now reports 245 tables, integrity ok, and
zero foreign-key violations.

The full drafting lane was exercised end to end on a disposable store with the
released CLI: import facts, issue a digest-pinned request, run the standalone
runner, record its result, and read the exact owner-side review projection. A
prompt-injection payload in the source excerpt did not reach the composed
draft, and the tracking URL was never admitted as evidence.

**Still not done, deliberately.** Gate G07 remains open: it needs the
Inbox-side fixed-command relay and PostgreSQL thread resolver (tasks 52-53),
the native Apple Mail host and sender (B08), and an independent audit of
commit `b81cc73` itself. No mailbox, Full Disk Access, Automation consent,
Tailnet route, native draft, or send effect was created. The program ledger
was not modified — it is leased by another controller lane and should be
updated by its owner.

Clean-rebuild ledger snapshot: revision 141; 27 of 96 tasks complete;
G01-G04 passed

This report reconstructs completed work from Git history, release and audit
documents, durable memory, the canonical clean-rebuild ledger, and active plus
archived/reset/deleted OpenClaw session transcripts. It distinguishes accepted
work from partial or rejected work. Historical deployment claims are described
as historical because the old JobTrack runtime has now been deliberately
retired.

## Executive summary

JobTrack grew from a small Mission Control-owned tracker into a private,
agent-operable job-search system with:

- a SQLite/WAL store and attachments;
- a large host CLI and repository-local skill as the only writer;
- a private read-only web workspace;
- normalized company, opening, posting, opportunity, application, interview,
  offer, role, seniority, skill, tag, and profile domains;
- provenance-preserving public discovery and a permission-aware story library;
- application-form reconnaissance, application-specific materials, exact PDF
  review, readiness, package binding, and post-human submission records;
- a declarative application-strategy control plane;
- recipient-aware communication style and provider-neutral email proposal
  lifecycles without embedded provider authority;
- a UUID-keyed, allowlisted public-profile export and a richer project/repository
  graph; and
- provider-neutral outgoing successor schemas for the current clean rebuild.

The prior v0.7 deployment was successfully released and operated privately,
then intentionally removed as part of the clean rebuild. Canonical JobTrack
data and audit evidence were preserved and verified. The new generation has
not yet been deployed.

## Original stewardship directive

On 2026-07-17 Cole temporarily moved stewardship from Mission Control to Chloe.
The original request was to assess and improve JobTrack, add agent-usable
internet job finding, and add an organized/tagged personal-story workflow so
Cole could tell stories, refine their meaning with an agent, and save them for
future applications. The intent was always to return a well-documented,
history-preserving project to Mission Control eventually.

Safeguards established at takeover:

- Baseline commit/tag: `8295213` / `pre-chloe-takeover-2026-07-17`.
- Pre-change canonical-store backup:
  `~/.jobtrack/backups/pre-chloe-20260717-104000.db`.
- The CLI remained the sole writer and the web remained read-only.
- Discovery, drafting, and assistance could not imply application, employer
  contact, submission, or send authority.
- Private profile and story material remained default-deny for external use.

## Foundation inherited at the takeover baseline

Before temporary stewardship, the repository already contained important
foundational work:

- the store + skill/CLI + read-only-web architectural contract;
- the SQLite CLI and application lifecycle spine;
- loopback-only private web deployment behind Tailscale Serve;
- private profile capture and structured work/education/profile views;
- prospect research, evidence, assessments, workflow stages, and artifacts;
- cover-letter package support and agent-authored cover letters; and
- initial tailored-resume generation.

This history was retained rather than rewritten.

## Released product evolution

| Release | Source identity | Major accepted outcome | Verification recorded at release |
| --- | --- | --- | --- |
| v0.2.0 | `cee53ab` | Provenance-preserving opportunity inbox, official Ashby/Greenhouse discovery, and append-only permission-aware story library | 62/62 tests; zero production dependency vulnerabilities; copied-live migration and Docker smoke |
| v0.3.0 | `f9124f4`, schema 8 | Normalized company/opening/posting graph; role/seniority/skill catalogs; interview prep; no-send email facts/proposals; sandboxed discovery | 133 discovered with one ordinary opt-in skip; separate isolation gate; copied-live replay and independent audit |
| v0.4.0 | record `44c9b91`, runtime `8fe1abd`, schema 9 | Exact facets, unified pipeline, normalized profile/tag vocabularies, evidence-scoped information gaps, stories under profile, shared read-only design | 136 runnable tests plus opt-in isolation; zero vulnerabilities; copied-live and live integrity gates |
| v0.5.0 | `d899986`, schema 10 | Passive form reconnaissance, exact-field materials, immutable revisions/review/selection, readiness, packages, and post-human submission facts | 182 discovered / 181 passed / 1 opt-in skip; 22/22 isolation; 52/52 focused independent gate |
| v0.6.0 | tag record `18629cb`, runtime `300eee0`, schema 11 | Declarative strategy control plane, recipient register/Cole voice/tone, bounded work routing, complete LaTeX materials and fixed renderer | 217 discovered / 213 passed / 4 skips; real renderer 8/8; independent strategy/email/LaTeX/deployment audits |
| v0.7.0 | tag record `f2d8cb0`, runtime `1e8b854`, schema 11 | Provider-neutral v2 email facts/correlation, bounded research-assisted reply drafting, usage/provenance/approval/request/outcome records, redacted read-only lifecycle views | 309 discovered / 305 passed / 4 skips; zero vulnerabilities; web/image/security and production checks |

### v0.2.0 — opportunity discovery and personal stories

- Added a deduplicated opportunity inbox upstream of applications.
- Added strict source/query/run records, immutable observations and snapshots,
  preview-first fixed-origin scanning, rate limits, explicit exact-ID or
  curated ingestion, evidence-backed triage, and explicit promotion.
- Seeded 11 verified public roles across Vapi, Retell AI, Together AI, and
  Anthropic without claiming any application or employer contact.
- Added append-only raw story captures, clarification questions/answers,
  immutable polished revisions, audience variants, tags, optimistic locking,
  `allow|ask|deny` purpose permissions, application links, and use auditing.
- Hardened CLI flag scope, transactions, attachment rollback, owner-only modes,
  package privacy, security headers, and read-only container behavior.

### v0.3.0 — normalized identity and sandboxed integration

- Separated openings/requisitions from their posting occurrences.
- Added canonical companies, role types, seniority levels, skills, requirement
  kinds, immutable posting snapshots, and exact evidence-bearing relations.
- Added versioned, reviewed interview-preparation analyses.
- Added strict job-email facts, correlation, transition proposals, and reply
  proposals, but no sender.
- Added an allowlisted HTTPS broker, networkless built-in parsers, sandboxed
  discovery proposals, and a trusted data-only importer.
- Preserved multiple posting occurrences and rejected fuzzy auto-merges.
- The copied-live migration retained 4 applications, 11 opportunities, 39
  profile entries, 11 snapshots, and 11 observations; conservative backfill
  produced 8 companies, 15 openings, 11 postings, and 18 profile-skill links.

### v0.4.0 — unified workspace and deeper profile normalization

- Added exact company, tag, role-type, and seniority facets with AND-tag
  semantics and explicit Unclassified values.
- Made the home view one unified application-plus-unpromoted-opportunity
  pipeline without duplicate promoted records.
- Added normalized profile organizations and aliases, typed section and
  preference vocabularies, project skills, governed provenance-bearing tags,
  and posting-scoped information requests.
- Added append-only optimistic information assessments and typed resolutions;
  only explicit `confirmed_missing` evidence creates a missing-data signal.
- Moved stories into the indexed profile information architecture.
- Standardized shared page components, responsive layout, redaction, and
  read-only security behavior.

### v0.5.0 — application preparation workspace

- Added inert, strict-schema, versioned application-form reconnaissance for
  steps, fields, options, constraints, conditions, blockers, and honest
  coverage uncertainty.
- Added mandatory application-specific resume and cover-letter material
  identities plus exact-field answer revisions.
- Separated creation, refinement, review, and current selection so a new rough
  draft cannot silently replace approved work.
- Implemented two-pass evidence-bounded generation contexts with exact source
  IDs and source-state digests.
- Added exact human/file-field fulfillment, conditional applicability,
  staleness, readiness, immutable package bindings, attachment-byte integrity,
  and audited post-human submission facts.
- During release rehearsal, an incompatible prototype migration was detected.
  The prototype DB/WAL/SHM was quarantined only after proving all 709 inherited
  rows across 144 tables matched the verified schema-9 backup and all
  user-authored prototype tables were empty. The verified backup was restored
  and migrated without inherited-row drift.

### v0.6.0 — strategy, communication style, and exact PDFs

- Added exact two-pass strategy context, frontier-owned plans and
  reconciliation, reviewed routing policy, dependency work, provider-neutral
  model classes, budget/usage receipts, escalation, checkpoints, and typed
  same-application domain bindings.
- Kept JobTrack as a declarative control plane rather than a model runtime.
- Added bounded communication-register observations, reviewed thread/contact
  profiles, Cole-owned writing voices, source-bound tone decisions, and
  recipient/body-locked reply proposals.
- Explicitly prohibited personality/protected-trait inference and recipient
  identity imitation.
- Made managed resume and cover-letter revisions complete self-contained LaTeX
  documents.
- Added a fixed, networkless, read-only, privilege-dropped renderer with PDF
  active-content, URI, geometry, selectable-text, timeout, and byte-integrity
  gates.
- Made approval pin one exact PDF and made readiness/package/submission rehash
  source, renderer, and document bytes.

### v0.7.0 — provider-neutral reply lifecycle

- Adopted provider-neutral v2 inbound facts and correlation while preserving
  the frozen v1 boundary.
- Added deterministic, policy-bound research composition and durable usage,
  provenance, approval, request, and provider-outcome records.
- Kept approval distinct from sending; JobTrack still held no provider token or
  provider mutation authority.
- Added GET/HEAD-only, collapsed lifecycle summaries without exact addresses,
  subjects, message bodies, draft prose, provider payloads, or credentials.
- Caught a missing discovery-policy module in the first candidate image,
  rejected that candidate, fixed the image dependency, and added a regression
  gate before production promotion.
- Deployed the exact v0.7 image privately, loopback-only and Tailnet-only, with
  read-only root/store, non-root identity, dropped capabilities, bounded
  resources, and Funnel off.

That deployment evidence remains valid history, but the service and route were
later retired under the clean-rebuild directive.

## Implemented after v0.7 but not yet released

Canonical `main` contains ten clean commits after published `origin/main`:

| Commit | Accepted local implementation |
| --- | --- |
| `984173d` | Relational skill evidence attached to work, education, and project entries; strict slug/name/alias resolution and unresolved-value reporting |
| `6210e51` | Universal UUID identity for every durable table, including append-only and self-healing sweep behavior |
| `1f189e1` | Allowlisted UUID-keyed public-profile v1 export with schema validation and redaction scan |
| `fb92f4a` | Pinned/visible/hidden profile presentation state and display ordering |
| `88a9daf` | Repositories as first-class public/private entities linked to projects |
| `f4dd914` | Project kinds and `uses`, `extracted_from`, `part_of`, and `successor_of` relations |
| `7973321` | Public-profile v2 curation, ordering, project kinds, public repositories, and visible-project use references |
| `3e8388b` | Private repository URL scrubbing from legacy URL/link fields |
| `6921c56` | Optional read-only Mission Control project mapping and narrow drift sync; excluded from production runtime |
| `d59ed92` | Byte-identical adoption of six provider-neutral outgoing successor schemas plus conformance gates |

The `d59ed92` adoption is deliberately schema/conformance-only. It added no
new JobTrack runtime, CLI, migration, drafting, approval, or send behavior.

Fresh current verification on the pinned runtime:

```text
Node 22.22.0 / ABI 127
373 tests discovered
369 passed
0 failed
4 intentional opt-in skips
CLI smoke: passed
npm audit --omit=dev: 0 vulnerabilities
git diff --check: passed
```

## Clean Job Application Platform rebuild work completed

The current controlling program is the 96-task clean rebuild. At ledger
revision 141, completed tasks are `1-20`, `28`, `32-36`, and `80`.

### B00 — durable program control

- Recovered and saved the exact 96-item scope checklist.
- Converted it into a dependency-ordered execution plan and revisioned JSON
  ledger.
- Established one owner, leases, action receipts, evidence roots, human waits,
  gates, restart handoffs, and a durable continuation loop.
- Added the requested exact-quarter-hour progress renderer/notifier.
- Prevented duplicate controller work while interactive lanes were active.

### B01 / G01 — inventory and verified preservation

- Inventoried the old generation, exact removal targets, and protected
  unrelated services without recording secret values.
- Created and restored a WAL-aware online backup of the canonical JobTrack
  store.
- Proved schema 11, `integrity_check=ok`, zero foreign-key violations, 233/233
  matching table counts, 33/33 matching non-SQLite files, an exact directory
  tree, and successful CLI access to an isolated restored copy.
- Preserved approximately 185,716 KiB across 60 private backup files.
- Created and restored an Inbox PostgreSQL 18.4 custom dump with 203 tables and
  721 exactly matching rows.
- Preserved ApplySim's dirty source and logs and created complete manifest/hash
  evidence.
- Independent preservation review passed G01.

### B02 / G02 — old-generation retirement

- Stopped the exact obsolete services and tunnel.
- Removed all nine obsolete Inbox/ApplySim LaunchAgent plists to recoverable
  Trash.
- Removed only obsolete Tailscale Serve routes 8444 and 8445.
- Retired obsolete remote PostgreSQL container/network/volumes, exact local
  state/release/log roots, old credentials, URL files, and Keychain item.
- Removed the old JobTrack container/runtime/images and the old ApplySim
  deployment while preserving canonical JobTrack state/source and ApplySim
  source/log evidence.
- Preserved unrelated OpenClaw, Mission Control, local PostgreSQL, inference,
  and Tailnet routes.
- Several read-only/RAM/APFS/Colima rehearsals failed closed and were
  independently reconciled without canonical JobTrack drift. The later host
  reboot removed the disposable RAM cage; official Colima deletion removed the
  stopped obsolete profile/runtime.
- Safely reclaimed 1,583 disposable roots / 107,084 nodes / about 5.2 GB
  allocated, then 11 regenerable cache roots / 15,627 nodes / about 10.7 GB,
  with protected anchors unchanged and free space above 50 GB.
- Corrected one important classification error: the shared `scshafe` fleet
  keypair had been mistaken for an Inbox-only credential and moved to Trash.
  It was restored at Cole's request and verified by exact hash, owner/mode,
  fingerprint, routing, and independent connectivity. The obsolete Chloe
  identity was separately retired.
- Proved no obsolete process, listener, route, container, schedule, credential
  path, deployed release, or restartable old rollback remained. G02 passed.

### B03 / G03 — architecture and typed contracts

- Wrote four architecture decision records covering runtime ownership, fresh
  PostgreSQL and immutable evolution, content-equivalent outgoing mail and
  human consent, and production lanes/stop-effects rollback.
- Defined a 19-edge ownership registry, one production-generation manifest,
  six minimal lanes, and a supersession matrix.
- Fixed Apple Mail as the sole mailbox edge, Mission Pipeline as the sole shard
  engine, Mission Control outside the runtime chain, and fresh PostgreSQL 18
  commissioning from empty.
- Added six provider-neutral outgoing schemas:

  - `email-approved-content.v1`
  - `email-reply-draft-proposal.v3`
  - `email-draft-receipt.v1`
  - `approval-receipt.v2`
  - `email-send-request.v2`
  - `email-send-receipt.v2`

- Bound signatures, positive human approval, exclusive expiry, exact approved
  content, one-send intent, provider-neutral content equivalence, and
  conclusive-versus-indeterminate outcome semantics.
- Proved schema parity across Execution Contracts, Inbox, and JobTrack and
  independently accepted JobTrack `d59ed92` as schema-only adoption.
- G03 passed with no downstream live-effect authorization.

### B04 / G04 — Mission Pipeline successor release

- Independently rejected two flawed Mission candidates rather than weakening
  release gates.
- Accepted corrected Mission Pipeline commit `d9d4e44`, published exact remote
  `main` and annotated `v0.2.0`, and reproduced its 99-file package.
- Passed 184/184 Mission tests, clean-clone/package checks, and a disposable
  PostgreSQL 18 reference gate.
- Accepted Inbox commit `4e49e35` as the exact Mission v0.2 pin and production
  entry-graph proof.
- Inbox verification recorded 1,028 tests with 989 passed, 39 expected skips,
  and 0 failures, plus 21/21 focused G04 tests.
- Completed tasks 32-36 and passed G04 without deployment or mailbox effects.

### ApplySim partial work accepted

- Independently rejected candidate `1ef...` with seven blockers and candidate
  `e3de720...` with two durable-state blockers.
- Accepted only task 80 from the latter line: ApplySim form POST now produces
  durable test-run state rather than remaining inert.
- A later candidate `a99fa142...` reached 273 tests and a 25-case
  OS-network-denied matrix and entered independent audit, but the containing
  B10/G10 work was not yet accepted at this snapshot.

### JobTrack B07 groundwork completed but not accepted

The isolated B07 branch contains substantial offline implementation:

- provider-neutral contract validation and canonicalization;
- additive outgoing core and authority-guard migrations;
- immutable draft requests/results, approved content, reviews, approvals, send
  requests, and receipt correlation;
- eight bounded CLI verbs and an exact owner-side review projection;
- Ed25519 approval/native-receipt verification;
- replay, expiry, transition, re-entrancy, and append-only database guards; and
- a repository-local, content-addressed Execution Contracts fixture snapshot.

Candidate `0e1eeb1` was rejected with five authority, timing, hostile-object,
and portability blockers. Candidate `5251ee4` repaired those reproduced cases
and passed 405 discovered tests (400 passed, 5 expected skips), 119/119 focused
tests, 63/63 historical email/web/security tests, and smoke. Independent audit
still rejected it because genuine Buffer/typed-array and key values with Proxy
prototypes could execute traps before rejection at the privileged
cryptographic boundary.

Therefore no B07 task was credited. The rejection and the partial code are
work performed and evidence gained, not completed deliverables.

## Durable design decisions established

The following principles are now explicit and tested throughout the system:

- Opening and posting are distinct identities.
- Canonical relations, not titles or free-form tags, are authoritative.
- Skill requirements remain bound to immutable posting snapshots.
- Status, preparation, story, decision, and receipt history is append-only.
- Discovery acceptance is data-only and never application authority.
- Fuzzy identity remains reviewable; exact evidence alone may auto-link.
- Shared ATS scope and company-careers-site scope are distinct.
- Recurring discovery is a separate operational decision.
- Profile normalization preserves original source strings.
- Strategy is a declarative control plane, not a model runtime.
- Communication style adapts bounded register without identity mimicry.
- Document approval pins the exact rendered PDF.
- Public profile export is the sole sanctioned private-to-public crossing.
- Outgoing approval and provider execution are separate authorities.

## Current source, data, and runtime state resulting from completed work

- Canonical `main` is clean at `d59ed92` and is genuinely ten commits ahead of
  GitHub `origin/main`/`v0.7.0`.
- Package and Docker metadata still identify `0.7.0`; no post-v0.7 release has
  been cut.
- The canonical private JobTrack store remains present and preserved.
- The old v0.7 container, Colima runtime, listener, and Tailnet route 8444 are
  absent by design.
- The old deployment is not a rollback option.
- All current live mailbox, deployment, route, native draft, and send effects
  remain forbidden.

## Evidence map

Repository evidence:

- [README.md](README.md)
- [AGENTS.md](AGENTS.md)
- [DECISIONS.md](DECISIONS.md)
- [docs/VERIFICATION.md](docs/VERIFICATION.md)
- [docs/TEMPORARY_STEWARDSHIP.md](docs/TEMPORARY_STEWARDSHIP.md)
- [docs/NORMALIZED_JOB_GRAPH.md](docs/NORMALIZED_JOB_GRAPH.md)
- [docs/DISCOVERY_SANDBOX.md](docs/DISCOVERY_SANDBOX.md)
- [docs/V0.4_PRODUCT_CONTRACT.md](docs/V0.4_PRODUCT_CONTRACT.md)
- [docs/V0.5_PRODUCT_CONTRACT.md](docs/V0.5_PRODUCT_CONTRACT.md)
- [docs/V0.6_PRODUCT_CONTRACT.md](docs/V0.6_PRODUCT_CONTRACT.md)

Clean-rebuild evidence:

- `~/.openclaw/workspace/plans/job-application-platform-rebuild-checklist-2026-07-30.md`
- `~/.openclaw/workspace/plans/job-application-platform-rebuild-execution-2026-07-30.md`
- `~/.openclaw/workspace/state/job-application-platform-rebuild-2026-07-30.json`
- `~/.openclaw/workspace/reports/job-application-platform-rebuild-2026-07-30/b01-preservation/`
- `~/.openclaw/workspace/reports/job-application-platform-rebuild-2026-07-30/b02-retirement/`
- `~/.openclaw/workspace/reports/job-application-platform-rebuild-2026-07-30/b03-architecture/`
- `~/.openclaw/workspace/reports/job-application-platform-rebuild-2026-07-30/b04-mission-pipeline/`
- `~/.openclaw/workspace/reports/job-application-platform-rebuild-2026-07-30/b07-drafting-send/jobtrack-b07-0e1eeb-independent-fail-audit.md`
- `~/.openclaw/workspace/reports/job-application-platform-rebuild-2026-07-30/b07-drafting-send/jobtrack-b07-5251ee4-independent-fail-audit.md`

Key source transcripts:

- `~/.openclaw/agents/main/sessions/f20a62dd-7446-4549-8b8a-7bc31a381364.jsonl.reset.2026-07-17T21-23-40.482Z`
- `~/.openclaw/agents/main/sessions/4e771c53-b985-4474-8108-53856d2f5da3.jsonl.reset.2026-07-18T15-44-03.131Z`
- `~/.openclaw/agents/main/sessions/f8012197-03b9-4bfb-af64-85056b1d94b1.jsonl.reset.2026-07-19T20-13-32.683Z`
- `~/.openclaw/agents/main/sessions/e31cebd9-e07f-46ff-925a-6e9f3cf14842.jsonl.reset.2026-07-28T16-35-06.895Z`
- `~/.openclaw/agents/main/sessions/5b293150-d7b6-4374-b681-d1832e228cfe.jsonl.reset.2026-07-30T14-30-48.481Z`
- `~/.openclaw/agents/main/sessions/8490251d-6590-4f01-89d0-6e8f7c5ec844.jsonl.reset.2026-07-31T21-24-45.620Z`
- `~/.openclaw/agents/main/sessions/f65d8df1-ccf7-476a-9814-f13dbc8dd729.jsonl.reset.2026-08-01T15-13-41.601Z`
