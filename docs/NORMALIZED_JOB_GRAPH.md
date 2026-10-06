# Normalized Job Graph

Status: implementation contract for the post-`v0.2.0` release.

## Why this exists

JobTrack must distinguish the job itself from the places where the job was
published. It must also make companies, role types, seniority, and skills
queryable relations instead of burying them in free text. Interview preparation,
email-driven updates, discovery, and future ranking all depend on that identity
model being correct first.

## Canonical identity chain

```text
company
  `-- job opening / employer requisition
        |-- posting at company careers / ATS
        |-- posting at LinkedIn
        |-- posting at another approved venue
        |     `-- immutable observations and snapshots
        |
        |-- role type classifications
        |-- seniority classifications
        |-- snapshot-bound skill requirements
        `-- application attempt
              |-- posting relations (submitted via / discovered via / alternate)
              |-- append-only status history
              |-- linked application emails and proposals
              `-- interviews
                    `-- versioned interview-prep analyses
```

The meanings are intentionally separate:

- **Company**: a canonical employer identity with aliases and domains.
- **Opening**: one vacancy or requisition at that company.
- **Posting**: one publication of that opening at a particular venue and URL.
- **Observation/snapshot**: immutable evidence of what a posting said at a time.
- **Opportunity**: JobTrack's discovery/triage workflow for an opening; not the
  posting and not an application.
- **Application**: one application attempt for an opening.

Two URLs never prove two distinct openings. Conversely, similar titles never
prove that two postings are the same opening. Automatic linking requires exact,
trustworthy identity evidence such as a shared employer requisition identifier.
Similarity produces a reviewable duplicate candidate, never an automatic merge.

## Relational classifications

### Role type

`role_types` is a hierarchy. Initial branches include software engineering,
hardware, data, machine learning, security, infrastructure, product, and
management. Leaf examples include frontend, backend, full-stack, FPGA,
firmware, embedded, mobile, DevOps, and site reliability engineering.

An opening may have multiple role types, but at most one is primary. Every link
records confidence, source, and optional snapshot evidence.

### Seniority

`seniority_levels` is an ordered vocabulary with career track. Initial levels
include intern, junior/entry, regular/mid-level, senior, staff, principal, lead,
manager, director, and executive. An opening may explicitly span levels (for
example, Senior/Staff), while at most one classification is primary. A missing
level stays unspecified; it is not silently treated as regular.

### Skills

`skills` is a canonical vocabulary with aliases and categories. Candidate
profile skills link to this vocabulary. Job skill requirements are attached to
the immutable posting snapshot that supplied the evidence and use one of:

- `required`
- `preferred`
- `mentioned`

This preserves conflicts between postings or revisions instead of flattening
them. An opening-level query may aggregate current snapshots while showing the
underlying evidence.

Free-form opportunity tags remain intact. They are not assumed to be skills.

## Application and interview history

Application status is an append-only event stream with a current projection and
optimistic lock version. Imported legacy statuses remain facts even if their
supporting interview or offer record is missing; those events are explicitly
marked `evidence_incomplete` rather than inventing records.

Scheduled interviews gain versioned preparation analyses. A prep revision may
link to:

- required/preferred skills and candidate skill evidence;
- posting snapshots and application research artifacts;
- profile stories or revisions approved for interview preparation;
- likely questions, questions for the interviewer, risks, gaps, and rehearsal
  tasks.

Older prep revisions remain immutable. At most one revision is current for an
interview. Creation, review, and selection are distinct audited operations: a
new deterministic draft cannot silently displace reviewed prep. Each analysis
stores a canonical source manifest and digest; selected snapshot, artifact,
profile, and story evidence is ownership-checked and later mutations make the
analysis visibly stale instead of rewriting history. Story use relies on the
existing purpose-specific `interview` permission.

## Job-application email boundary

```text
read-only email ingestion
  -> sanitized job-email facts
  -> read-only JobTrack correlation
  -> transition proposal + optional reply-draft proposal
  -> policy/approval
       |-- JobTrack executor applies a narrow state transition
       `-- G03 stores provider-neutral outgoing review/authority data
             (storing it has no provider effect; since 2026-08-05
              `email send-approved` can then transmit it — see EMAIL_LANES.md)
```

Email content is untrusted data. The adapter never opens the JobTrack database,
receives provider credentials from JobTrack, or sends arbitrary commands. Correlation is exact-ID
first and may return `linked`, `ambiguous`, or `unmatched`. Company/title or
fuzzy matches are review-only.

State transitions and reply drafts are separate proposals. Auto-send is disabled. G03 requires
an exact content projection, captured not-sent draft evidence, authenticated human approval,
injected Ed25519 attestation, exclusive expiry, invalidation checks, and a single content-
equivalent request. The request is data only; a separately reviewed provider edge would still
need independent evidence resolution and idempotency consumption. A model-authored reply always
requires review. See `EMAIL_OUTGOING_PROVIDER_NEUTRAL.md`.

## Automated discovery boundary

```text
scheduler
  -> isolated strategy worker
       -> declarative fetch intent
       -> allowlisted egress broker
       -> immutable retrieval envelope
       -> content-addressed proposal bundle
  -> trusted proposal importer
  -> pending review
  -> opportunity
  -> explicit application pursuit
```

Workers receive no JobTrack store, host credentials, browser profile, Docker
socket, or arbitrary network. The egress broker permits only reviewed HTTPS
origins and path templates with rate, redirect, content-type, byte, and time
limits. Proposal import cannot create an application.

Initial strategies:

- approved direct company ATS boards (Ashby and Greenhouse, then Lever);
- funding-event evidence -> company resolution -> proposed careers source ->
  approved direct-board scan;
- imported LinkedIn/public-search/email-alert leads.

There is no LinkedIn crawler: no automated login, cookies, session reuse,
CAPTCHA handling, credentialed scraping, or bypass. A LinkedIn lead may point to
an approved company ATS posting, which is fetched through that ATS adapter.

## Migration contract

The first normalized migration is additive and idempotent:

1. Create canonical tables and nullable links while retaining legacy columns.
2. Backfill companies conservatively using normalized exact aliases.
3. Create one opening per existing opportunity; only exact legacy links share
   an opening with an application.
4. Create one posting per existing opportunity and link existing immutable
   observations/snapshots.
5. Give every unlinked legacy application its own opening; do not invent a
   posting when it has no URL.
6. Link existing profile skills to canonical skills without rewriting them.
7. Import current application states as append-only migration events, preserving
   incomplete evidence explicitly.
8. Preserve every legacy tag and artifact byte-for-byte.

Legacy company/title/URL columns remain compatibility projections during this
release. Canonical tables are authoritative. A later, separately verified
table-rebuild migration may remove those duplicated projections only after all
callers use normalized relations.

## Verification gates

- Fresh-store migration and exact replay are idempotent.
- A copy of the live schema-v7 store migrates with identical legacy row counts
  and immutable snapshot hashes.
- `PRAGMA quick_check` and `foreign_key_check` pass.
- Same opening at two venues stays one opening with two postings.
- Same-title distinct openings stay distinct.
- Cross-opening application/posting links fail transactionally.
- Conflicting required/preferred skill evidence is preserved by snapshot.
- Email proposal replay is idempotent; stale versions and ambiguous matches do
  not write.
- Interview prep versions and evidence links remain internally consistent.
- Discovery workers cannot see the JobTrack store and cannot bypass the egress
  boundary.
- Existing CLI, profile/story provenance, read-only web, Docker, and tailnet
  security invariants continue to pass.

## Library extraction lens

Potential reusable packages are the job-identity catalog, taxonomy model,
proposal envelope, provenance ledger, safe public fetcher, and sandbox runner.
They remain inside their projects until at least two real consumers demonstrate
the same dependency boundary; extraction follows proven use, not speculation.
