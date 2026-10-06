# Temporary Chloe stewardship

**Historical record. This stewardship period has ended.** JobTrack is back under
Mission Control ownership, `origin` is `git@github.com:scshafe/jobtrack.git`, and
the current release is `v2.0.0`. Everything below describes the state as it stood
during the temporary stewardship and is preserved unedited as provenance for the
v0.3 and v0.4 work. For current status see [../CURRENT.md](../CURRENT.md); for
current verification evidence see [VERIFICATION.md](VERIFICATION.md).

JobTrack remains a Mission Control project. Chloe is temporarily maintaining it while
Mission Control is being reworked, with the intent to hand it back without erasing its
history or changing its core operating boundary.

## Baseline

- Original baseline commit: `8295213`
- Local annotated tag: `pre-chloe-takeover-2026-07-17`
- Live-store backup made before schema work:
  `~/.jobtrack/backups/pre-chloe-20260717-104000.db`
- The repository currently has no configured Git remote, so stewardship changes remain
  local unless Cole explicitly chooses a destination later.

## Fixed boundaries

- The host-side CLI is the only writer.
- The web application is GET/HEAD-only and reads a private snapshot of the store.
- Internet discovery retrieves public job information only; it does not apply, contact
  employers, submit forms, or retain job-site credentials.
- An external agent may help compose or polish text, but JobTrack stores, versions,
  validates, retrieves, and audits it rather than silently generating claims.
- Private profile material and personal stories are default-deny for external use.

## Handoff contract

Before returning ownership to Mission Control:

1. The working tree and local release references must be documented.
2. Schema migrations must be repeatable against both a fresh store and the preserved
   pre-stewardship backup.
3. The complete test suite, SQLite integrity check, CLI smoke, and read-only web smoke
   must pass.
4. Any live-store additions must retain source/provenance and must not imply that Cole
   applied to a role when he only discovered it.
5. Known limitations and any pending human decisions must be listed in this document or
   an adjacent handoff record.

## Current workstream

Completed in local release `v0.2.0`:

- Hardened the private web snapshot, CLI transactions/arguments, package privacy gates,
  attachment rollback, owner-only store modes, and container runtime.
- Added a deduplicated, provenance-preserving opportunity inbox upstream of applications.
- Added preview-first official Ashby/Greenhouse discovery with fixed network origins, bounded
  responses, immutable run/source/query snapshots, rate limits, and explicit curated ingestion.
- Added append-only story captures, immutable polishing/variants, tagged retrieval,
  clarification questions, purpose permissions, application links, and use auditing.
- Migrated and checked the live store, retaining the inherited 4 applications and 39 profile
  entries; seeded 11 verified public roles as untriaged inbox items.
- Expanded the suite to 62 passing tests and recorded the full evidence in `VERIFICATION.md`.

Completed in deployed release `v0.3.0`:

- Separated openings from posting occurrences; normalized companies, role type,
  seniority, skills, interview prep, email proposals, and sandboxed discovery.
- Migrated the live store to schema 8 while retaining the inherited application,
  opportunity, and profile records.

Completed in deployed release `v0.4.0`:

- Added exact scoped collection facets and a unified application/opportunity
  pipeline without duplicating promoted opportunities.
- Added normalized profile vocabularies, organization aliases, governed tags,
  project-skill links, and immutable posting-scoped information-gap assessments.
- Moved stories into the indexed profile information architecture and unified
  the read-only visual system across collection and profile views.

## Handoff state

- Current deployed release tag: `v0.4.0` on the final verification record;
  runtime code/image revision: `8fe1abd`.
- No Git remote is configured and nothing was pushed or published.
- The legacy tracked `skill/SKILL.md` remains unchanged. The v0.4-revised Skill
  Workshop proposal `jobtrack-20260717-32b0409b43` is pending, scan-clean, and
  requires Cole's explicit approval before it can replace the durable installed
  agent skill.
- No recurring scan, application submission, employer contact, or opportunity promotion was
  enabled. The 11 seeded roles remain `inbox` for deliberate review.
- The live story library is empty by design; agents should use the new capture/polish/permission
  workflow when Cole begins sharing stories.
