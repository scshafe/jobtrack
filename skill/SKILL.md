---
name: jobtrack
description: Operate the JobTrack SQLite store directly through the jobtrack CLI. Use when an operator wants to search, parse, add, or edit job applications, prospective application lifecycle state, artifacts, assessment gates, cover letters, interviews, offers, outcomes, or the private internal profile corpus.
---

# JobTrack Skill

JobTrack has no chat layer and no server-side write API. The `jobtrack` CLI is the writer and reader. It opens the SQLite store at `JOBTRACK_HOME/jobtrack.db`, creates `JOBTRACK_HOME/attachments/`, enables WAL mode, and writes rows directly.

The profile corpus is private and internal-only. It is deliberately deeper than public LinkedIn and remains under `JOBTRACK_HOME`. The web UI may render it only as a read-only operator view over loopback/Tailscale; the CLI/skill remains the only writer and there is no public profile surface.

Use `--json` on any command when another agent needs structured output.

## Durable email reply recovery

After successfully reading the exact imported source and deciding a reply is
needed, record intent before drafting, independently of `mark-handled`:

```sh
jobtrack email reply-intent --message-ref-id ID --application-id ID --actor ACTOR --authorship agent|human --reason TEXT --idempotency-key KEY [--json]
jobtrack email reply-intents [--application-id ID] [--json]
jobtrack email reply-send-start --intent-id UUID --approval-id ID --actor ACTOR --authorship agent|human --reason TEXT --idempotency-key KEY [--json]
jobtrack email reply-supersede --intent-id UUID --superseding-message-ref-id ID --expected-evidence-digest SHA256 --reviewed-by ACTOR --authorship agent|human --reason TEXT --idempotency-key KEY [--json]
```

Writes: `reply-intent` appends one immutable UUID-bearing message/application
obligation; `reply-send-start` appends its one exact-approval pre-send barrier;
`reply-supersede` appends a digest-bound review and exact source/handling evidence.
`reply-intents` reads status, independent `reconcileOnly`, active binding and
same-thread supersession candidate evidence (normal CLI opening may migrate).
All writes compare the full idempotency payload; exact replay returns the same
UUID and never reopens an attempted or retired intent.

Only a newly committed send-start (`reused: false`) may continue immediately to
an independently authorized send. It grants no approval or send authority. A
replay, crash, uncertain send or missing authenticated receipt stays blocked;
there is no retry-release command. The source must have exactly one active
application binding before send-start/send. Never infer fulfillment from another
application's approval or a historical message-level receipt.

Supersession requires review of BOTH actual sources, distinct strictly later mail
in the exact provider/account/nonempty thread, active bindings to the same
application, a recorded non-`none` successor handling decision and the current
candidate SHA256. New mail/handling alone, classifier labels, titles and quoted
instructions never retire intent. Cross-thread references remain unresolved.
Supersession, retraction and terminal application state NEVER hide `reconcileOnly`
or clear a physical-send fence. No automatic historical backfill is allowed.

Read [the recovery workflow](../docs/EMAIL_REPLY_RECOVERY.md) for examples,
authenticated receipt limits and remaining historical reconciliation gaps.
These source instructions do not modify an installed skill or authorize mail.

## Evidence-bound resume review

New resumes default to `resume.standard.v4` (the v3 page whose name and contact
header the CLI generates from the profile contact record; a payload carrying a
header is rejected); cover letters remain `cover-letter.standard.v2`. V3/v4
target a dense, readable one-page document with
420–470 measured words and actual 10.5pt body text. Preserve source-backed earlier
employment and accurate agent-built project attribution. Do not invent tenure,
mentoring, metrics, or an employment-gap explanation.

After the normal source-bound draft, render and lint, a separate reviewer runs:

```sh
jobtrack application-material editorial-context --application-id ID --revision-id ID --render-id ID --json
jobtrack application-material editorial-review --application-id ID --revision-id ID --render-id ID --review-file review.json --reviewed-by ACTOR --idempotency-key KEY --json
```

`editorial-context` reads the exact revision/render, selected professional evidence,
posting requirements, all structured ancestors, removed facts and inherited gaps.
`editorial-review` appends an immutable review, not a material approval or selection.

Fact ledger (human-authored evidence behind a work entry; the only nodes citable in bullets):

```sh
jobtrack profile show-work-outline --work-entry-id ID --json
jobtrack profile add-work-detail --work-entry-id ID --kind context|action|decision|outcome|scale|constraint --text "Cole's exact words" --authorship-kind human --authored-by Cole [--parent-detail-id ID] [--my-role led|owned|designed|co-designed|implemented|contributed] [--baseline TEXT --result TEXT] [--confidential true] --json
jobtrack profile update-work-detail --detail-id ID [--kind KIND] [--my-role ROLE] --authorship-kind human --authored-by Cole --json
```

Record only Cole's exact words under human authorship; paraphrase is agent authorship and is
not evidence. Selected work entries surface these nodes as `workDetails` in
`application-material context`, pinned inside the entry's source digest.
It requires a different reviewer from the author, the exact context digest, every
requirement marked demonstrated/partial/not-demonstrated, source+payload citations
for demonstrated claims (partial evidence may support partial claims), no evidence
for not-demonstrated claims, explicit stretch reasoning and omission/gap dispositions. A complete
`changes_requested` review blocks approval. A lint pass alone cannot approve v3/v4;
automatic policy approval cannot fall back to a legacy resume template.

Read `docs/RESUME_EDITORIAL_OPERATIONS.md` for the full strict JSON schema, density
measurement, safe file handling, verification and rollback. Normal material
review/select commands follow only after independent editorial approval. Never
use another actor name to self-review. These repository instructions do not update
an installed skill; installed changes require the Skill Workshop lifecycle.

## Store

- `JOBTRACK_HOME` defaults to `~/.jobtrack`.
- The database file is `jobtrack.db`.
- Attachments live under `attachments/` and are referenced from database rows.
- Tables: `applications`, `cover_letters`, `interviews`, `offers`, `profile_entries`, `profile_work_entries`, `profile_education_entries`, `profile_contact`, `profile_links`, `profile_skills`, `profile_projects`, `profile_credentials`, `profile_recognitions`, `profile_publications`, `profile_languages`, `profile_volunteer_entries`, `profile_answers`, `profile_references`, `profile_eeo`, `application_artifacts`, `application_assessments`, `assessment_review_gates`, `application_packages`, `application_lifecycle_events`.
- Application status values: `applied`, `interviewing`, `offer`, `rejected`, `withdrawn`.
- Assistance workflow stages: `prospective`, `researched`, `assessment_ready`, `assessment_approved`, `letter_drafted`, `package_ready`, `submitted`, `declined`, `archived`.
- `applications.status` remains the outcome/status model. Use `applications.workflow_stage` for the assistance lifecycle.
- Interview rounds: `screen`, `technical`, `onsite`, `final`.
- Interview formats: `phone`, `video`, `onsite`.
- Interview outcomes: `pending`, `passed`, `failed`.
- Offer outcomes: `pending`, `accepted`, `declined`.
- Profile categories: `work`, `education`, `skill`, `project`, `accomplishment`, `story`, `preference`, `link`, `evidence`, `resume`, `other`.
- Profile confidence values: `low`, `medium`, `high`, `unverified`.
- Assessment gate decisions: `approved`, `revision_requested`, `declined`.

Initialize or inspect the store:

```bash
jobtrack init
jobtrack init --json
```

Reads/writes: creates `JOBTRACK_HOME`, `attachments/`, `jobtrack.db`, schema tables, constraints, indexes, and WAL mode if needed. Reads back the store paths and journal mode.

## Deployment And Access Boundary

The CLI runs on the host and writes directly to `JOBTRACK_HOME`. The Express web UI is read-only over the same store and is intended for the operator's private loopback/Tailscale access only.

- Do not call or invent a server-side write route; none exists by design.
- Do not expose `JOBTRACK_HOME`, profile rows, references, or optional EEO/self-ID data on a public/LAN surface.
- Docker mounts the store read-only, and `docker-compose.yml` binds the published web port to `127.0.0.1`; reach it remotely through `tailscale serve` rather than `0.0.0.0`.
- Treat `jobtrack-application-assistance-v1` as the architectural boundary: `jobtrack-skill-cli` writes `jobtrack-store` and `attachments-dir` through `cli-writes-store` and `cli-writes-attachments`; `jobtrack-store` contains `profile-corpus` through `store-contains-profile`; `draft-cover-letter` reads the profile through `profile-ground-letter`, and `build-package` persists the human-final package through `letter-builds-package` without submitting to job sites.

## Search Applications

```bash
jobtrack search [--company TEXT] [--role TEXT] [--status STATUS] [--workflow-stage STAGE] [--from DATE] [--to DATE] [--text TEXT] [--json]
```

Reads: `applications`, with free-text checks over application notes/URL, cover letters, interviews, offers, artifacts, assessment gates, and lifecycle events.

Writes: nothing except first-use store initialization.

Examples:

```bash
jobtrack search --status interviewing
jobtrack search --workflow-stage prospective
jobtrack search --company ExampleCo --role Engineer --json
jobtrack search --from 2026-06-01 --to 2026-06-30
jobtrack search --text "remote typescript"
```

## Show Or Read A Full Application Path

```bash
jobtrack show <application-id> [--json]
jobtrack read <application-id> [--json]
```

Reads: the application, all cover letters, all interviews, the offer row if present, artifacts, assessment gates, package references, and lifecycle events.

Writes: nothing except first-use store initialization.

Example:

```bash
jobtrack show 1 --json
```

## Parse Guidance For Raw Operator Input

```bash
jobtrack parse-guidance [--type job-posting|posting-capture|company-research|application-assessment|artifact|assessment-gate|profile-capture|interview-invite|cover-letter|application-package|offer] [--json]
```

Reads: nothing except first-use store initialization.

Writes: nothing except first-use store initialization.

Use this before writing when the operator pastes a job posting, profile material, research note, cited source, assessment/approach, assessment review, cover letter, interview invite, or offer. Extract the fields it lists, then run the explicit add/edit command. Do not invent a chat or server API.

Example:

```bash
jobtrack parse-guidance --type interview-invite --json
```

## Add An Application

```bash
jobtrack add-application --company TEXT --role TEXT [--status STATUS] [--applied-date DATE] [--job-url URL] [--notes TEXT] [--json]
```

Writes: inserts one row into `applications`. Defaults `status` to `applied`.

Lifecycle: sets `workflow_stage` to `submitted` because this command represents an already-submitted or active application. Use `add-prospect` for a not-yet-submitted opportunity.

Reads: returns the new structured application path.

Examples:

```bash
jobtrack add-application --company ExampleCo --role "Backend Engineer" --status applied --applied-date 2026-06-24 --job-url "https://example.com/jobs/1" --notes "Remote; Node role"
jobtrack add-application --company "Northwind" --role "Data Engineer" --json
```

## Add A Prospective Application

```bash
jobtrack add-prospect --company TEXT --role TEXT --url URL [--notes TEXT] [--json]
```

Writes: inserts one row into `applications` with `status='applied'` for compatibility and `workflow_stage='prospective'`, records the posting URL in `job_url`, and inserts a `prospect_created` row in `application_lifecycle_events`.

Reads: returns the full structured application path.

Examples:

```bash
jobtrack add-prospect --company ExampleCo --role "Backend Engineer" --url "https://example.com/jobs/1" --notes "Interesting infra role" --json
```

## Prospect Research And Assessment Workflow

Use these semantic commands for the application assistance v1 path. The external agent may read a posting and company sources, but JobTrack itself is not a crawler, credential store, browser automation tool, or submission agent. When a source needs authenticated access, use Mission Control credential wrappers for provider secrets and remote-friendly device-code OAuth for human auth; never store job-site credentials or OAuth secrets in JobTrack rows, notes, artifacts, or attachments.

### Capture The Posting Snapshot

```bash
jobtrack capture-posting --application-id ID --source-url URL (--content TEXT|--content-file PATH|--file PATH|--attachment-path PATH) [--title TEXT] [--citation TEXT] [--notes TEXT] [--captured-at DATE] [--json]
```

Writes: inserts a `posting` row in `application_artifacts`. `--content` or `--content-file` stores text. `--file` copies a local snapshot such as a PDF or HTML capture into `JOBTRACK_HOME/attachments/`. `--attachment-path` references an already-managed attachment. The row records `source_url`, `captured_at`, citation/notes, and the attachment reference when supplied.

Lifecycle: on a prospective record, moves `workflow_stage` to `researched` because the posting has been captured for research.

Reads: returns the inserted artifact plus lifecycle state.

Examples:

```bash
jobtrack capture-posting --application-id 1 --source-url "https://example.com/jobs/1" --content-file posting.txt --citation "ExampleCo job posting captured 2026-06-24" --json
jobtrack capture-posting --application-id 1 --source-url "https://example.com/jobs/1" --file snapshots/exampleco-posting.pdf --notes "PDF print of original posting" --json
```

### Add Cited Company Research

```bash
jobtrack add-research --application-id ID (--source-url URL|--source-name TEXT) [--title TEXT] [--citation TEXT] [--notes TEXT] [--content TEXT|--content-file PATH] [--file PATH|--attachment-path PATH] [--captured-at DATE] [--json]
```

Writes: inserts a `research` row in `application_artifacts` with the source URL or source name, timestamp, citation text, notes/content, and optional managed attachment. Use one row per source or coherent research note so later assessment claims can cite concrete artifacts.

Lifecycle: keeps or moves the record at `researched` until an assessment is created.

Reads: returns the inserted artifact plus lifecycle state.

Examples:

```bash
jobtrack add-research --application-id 1 --source-url "https://example.com/about" --citation "ExampleCo About page" --notes "Builds developer infrastructure for small teams" --json
jobtrack add-research --application-id 1 --source-name "Company blog" --content-file research-notes.md --file captures/company-blog.pdf --json
```

### Create Structured Assessment And Approach

```bash
jobtrack assess-application --application-id ID --company-assessment TEXT --role-fit TEXT --risks TEXT --approach TEXT [--evidence TEXT] [--open-questions TEXT] [--profile-entry-refs CSV] [--title TEXT] [--notes TEXT] [--captured-at DATE] [--json]
```

Prerequisites: at least one captured posting artifact and one company research artifact must exist for the application. Optionally run `jobtrack profile extract --application-id ID --text TEXT --json` first, then pass relevant profile entry ids with `--profile-entry-refs 2,5`.

Writes: inserts a structured row in `application_assessments` and a linked `assessment` artifact in `application_artifacts`. The assessment explicitly separates company assessment, role fit, risks, evidence, open questions, and recommended application approach. The artifact citation lists the posting/research artifacts and profile entries used for grounding.

Lifecycle: moves `workflow_stage` to `assessment_ready`, which means Cole must review or steer the assessment before downstream cover-letter/package work.

Reads: returns the assessment, linked artifact, and lifecycle state.

Example:

```bash
jobtrack assess-application --application-id 1 \
  --company-assessment "ExampleCo looks like a small infra company serving developer teams." \
  --role-fit "Strong fit for Node, SQLite, and agent-facing CLI work." \
  --risks "Unclear compensation and on-call expectations." \
  --evidence "Posting artifact #1 mentions Node/SQLite; research artifact #2 shows developer tooling focus." \
  --open-questions "Confirm remote policy and support load." \
  --approach "Lead with local-first tooling, durable workflow design, and operational pragmatism." \
  --profile-entry-refs 2,5 \
  --json
```

### Show Assessment And Review State

```bash
jobtrack show-assessment --application-id ID [--assessment-id ID] [--json]
jobtrack read-assessment --application-id ID [--assessment-id ID] [--json]
```

Reads: application, structured assessments, posting/research/assessment artifact grounding, assessment gates, and the latest assessment gate. Writes nothing except first-use store initialization.

Example:

```bash
jobtrack show-assessment --application-id 1 --json
```

### Review Gate

```bash
jobtrack review-assessment --application-id ID --decision approved|revision_requested|declined [--artifact-id ID] [--notes TEXT] [--decided-by TEXT] [--decided-at DATE] [--json]
```

Writes: inserts one `assessment_review_gates` row. If `--artifact-id` is omitted and an assessment artifact exists, the latest assessment artifact is linked automatically. `approved` moves `workflow_stage` to `assessment_approved`; `revision_requested` moves it back to `assessment_ready`; `declined` moves it to `declined`.

Downstream gate rule: `draft-cover-letter`, `build-package`, package-ready/submitted stage advancement, and package-oriented commands require the latest gate to be `approved`. If the latest gate is missing, `revision_requested`, or `declined`, the drafting/package commands fail clearly before writing.

Examples:

```bash
jobtrack review-assessment --application-id 1 --decision revision_requested --notes "Clarify compensation and remote policy" --decided-by Cole --json
jobtrack review-assessment --application-id 1 --decision approved --notes "Proceed with this angle" --decided-by Cole --json
```

## Show Lifecycle State

```bash
jobtrack lifecycle <application-id> [--json]
jobtrack show-lifecycle --application-id ID [--json]
```

Reads: the application row, current `workflow_stage`, artifact/citation rows, assessment review gates, latest assessment gate, package references, and lifecycle events.

Writes: nothing except first-use store initialization.

Example:

```bash
jobtrack lifecycle 1 --json
```

## Set Workflow Stage

```bash
jobtrack set-workflow-stage --application-id ID --stage prospective|researched|assessment_ready|assessment_approved|letter_drafted|package_ready|submitted|declined|archived [--notes TEXT] [--json]
```

Writes: updates only `applications.workflow_stage`, touches `applications.updated_at`, and inserts a `stage_set` lifecycle event. This does not change `applications.status`. Moving to `letter_drafted`, `package_ready`, or `submitted` requires the latest assessment gate to be `approved`.

Reads: returns lifecycle state.

Use this as a foundation primitive when a later workflow has already completed the real work and only needs to persist the stage. Do not use it to imply that research, letters, packages, or submission happened unless the responsible agent has recorded the backing artifacts or operator action.

Example:

```bash
jobtrack set-workflow-stage --application-id 1 --stage assessment_ready --notes "Assessment artifact attached for Cole review" --json
```

## Attach A Generic Cited Artifact

Prefer `capture-posting`, `add-research`, and `assess-application` for the assistance workflow. Use this lower-level primitive only for non-standard artifact types or maintenance.

```bash
jobtrack attach-artifact --application-id ID --kind KIND [--title TEXT] [--source-url URL] [--source-name TEXT] [--citation TEXT] [--notes TEXT] [--content TEXT|--content-file PATH|--file PATH|--attachment-path PATH] [--captured-at DATE] [--json]
```

Writes: inserts one row into `application_artifacts`. With `--file`, copies the file into `JOBTRACK_HOME/attachments/` and stores the relative attachment path. With `--content` or `--content-file`, stores text content. With source and citation fields, stores traceable references for downstream assessment and package work.

Lifecycle: attaching `posting` or `research` to a `prospective` application moves `workflow_stage` to `researched`. Attaching `assessment` to a `prospective` or `researched` application moves it to `assessment_ready`. Other kinds do not change the stage automatically.

Reads: returns the inserted artifact plus lifecycle state.

Examples:

```bash
jobtrack attach-artifact --application-id 1 --kind posting --source-url "https://example.com/jobs/1" --citation "ExampleCo job posting" --notes "Captured role requirements" --json
jobtrack attach-artifact --application-id 1 --kind assessment --title "Initial fit assessment" --content-file assessment.md --citation "Grounded in posting and company research" --json
```

## Record Or Read Assessment Review Gate

```bash
jobtrack review-assessment --application-id ID --decision approved|revision_requested|declined [--artifact-id ID] [--notes TEXT] [--decided-by TEXT] [--decided-at DATE] [--json]
jobtrack lifecycle <application-id> --json
```

Writes: inserts one row into `assessment_review_gates` and records a lifecycle event. `approved` moves `workflow_stage` to `assessment_approved`; `revision_requested` moves it to `assessment_ready`; `declined` moves it to `declined`.

Reads: returns the inserted gate plus lifecycle state. Use `lifecycle` to read all gates and the latest gate.

Downstream gate rule: cover-letter grounding and package assembly read the latest assessment gate and require `decision='approved'`. `draft-cover-letter` without supplied content returns grounding only; with supplied content it persists traceability to the approved assessment, gate, profile corpus, and artifacts. `build-package` persists the human-final package and moves the workflow to `package_ready`.

Examples:

```bash
jobtrack review-assessment --application-id 1 --decision revision_requested --notes "Clarify compensation and remote policy" --decided-by Cole --json
jobtrack review-assessment --application-id 1 --decision approved --artifact-id 2 --notes "Proceed with this angle" --decided-by Cole --json
```

## Draft A Tailored Cover Letter

```bash
jobtrack draft-cover-letter --application-id ID [--content TEXT|--content-file PATH] [--json]
```

Prerequisite: the latest assessment review gate for the application must be `approved`. If it is missing or not approved, the command fails clearly and writes nothing.

Read grounding first: run without `--content` or `--content-file`. This writes nothing. It returns approved-gate grounding for the applying agent: application role/company/job URL/notes, captured posting and company research artifacts, the approved assessment and approach, and concrete profile material from work highlights, education, skills, projects, accomplishments, stories, answers, and other useful evidence.

Write final prose second: after reading the grounding, the applying agent writes the tailored cover letter as natural applicant-facing prose and stores it with `--content-file PATH` or `--content TEXT`. The CLI stores that supplied prose verbatim in `cover_letters`; it does not generate the primary prose, concatenate profile fields, or turn assessment notes into letter paragraphs. The row stores traceability columns for assessment id, assessment gate id, artifact refs, and the profile snapshot used for grounding.

Writing rules for the applying agent:

- Use concrete accomplishments, highlights, and project details from the grounding.
- Use the approved approach as direction, but do not parrot assessment notes verbatim.
- Avoid field labels and template artifacts such as `Company:`, `Skill:`, or `Institution:` in the letter.
- Make the prose specific to the role and company; do not invent claims that are not grounded in profile or research artifacts.
- Preserve the v1 human-final boundary: prepare prose for Cole to review and submit manually; never submit, automate the browser, or handle job-site credentials.

Lifecycle: moves `workflow_stage` to `letter_drafted` unless the workflow is already farther along; records a lifecycle event either way.

Reads: grounding mode returns the role/posting, approved assessment/approach, profile material, traceability, and lifecycle state. Storage mode returns the cover-letter row, assessment/gate traceability, and lifecycle state.

Examples:

```bash
jobtrack draft-cover-letter --application-id 1 --json
jobtrack draft-cover-letter --application-id 1 --content-file cover-letter.md --json
jobtrack draft-cover-letter --application-id 1 --content "Dear ExampleCo team..." --json
```

## Build A Ready-To-Submit Package

```bash
jobtrack build-package --application-id ID [--checklist TEXT] [--notes TEXT] [--json]
jobtrack show-package --application-id ID [--json]
```

Prerequisite: the latest assessment review gate must be `approved`, and a tailored cover letter must exist.

Writes: inserts one `application_packages` row with `package_status='ready'`, Markdown package content, the managed attachment path under `attachments/packages/`, cover-letter id, assessment id, assessment gate id, application snapshot, profile snapshot, artifact refs, and checklist. `--checklist` adds operator-specific checklist items; separate multiple items with `|`.

Lifecycle: moves `workflow_stage` to `package_ready` unless already farther along and records `package_built`. This remains human-final: Cole reviews and submits manually. The command does not store job-site credentials, drive a browser, or click final submit.

Reads: `show-package`, `show`, and `lifecycle` expose the persisted package row and managed package attachment path.

Examples:

```bash
jobtrack build-package --application-id 1 --checklist "Cole reviews final answers" --json
jobtrack show-package --application-id 1 --json
```

## Attach A Package Reference

```bash
jobtrack attach-package-reference --application-id ID [--status draft|ready|submitted|archived] [--notes TEXT] [--file PATH|--attachment-path PATH] [--json]
```

Writes: inserts one row into `application_packages`. This is a reference primitive only; it does not assemble a package, draft a cover letter, submit an application, store job-site credentials, or drive a browser. For any application that has entered the assistance workflow through a prospect stage or posting/research/assessment artifact, package references require the latest assessment gate to be `approved`.

Lifecycle: `ready`, `submitted`, and `archived` update `workflow_stage` to `package_ready`, `submitted`, or `archived`. `draft` leaves the stage unchanged. `ready` and `submitted` always require the latest assessment gate to be `approved`.

Reads: returns the package reference plus lifecycle state.

Example:

```bash
jobtrack attach-package-reference --application-id 1 --status ready --attachment-path attachments/package-checklist.md --notes "Package prepared by downstream workflow" --json
```

## Attach Or Log A Cover Letter

This is a tracker primitive for recording existing cover-letter material. It is not a drafting command and it does not assemble a ready-to-submit package. If the application has entered the assistance workflow through a prospect stage or posting/research/assessment artifact, this command requires the latest assessment gate to be `approved`; application-assistance drafting is handled by later gated workflow commands after that approval.

```bash
jobtrack attach-cover-letter --application-id ID (--content TEXT|--content-file PATH|--file PATH|--attachment-path PATH) [--json]
```

Writes: inserts one row into `cover_letters`. With `--file`, copies the file into `JOBTRACK_HOME/attachments/` and stores the relative attachment path. With `--content` or `--content-file`, stores text content. With `--attachment-path`, stores an already-managed attachment reference.

Reads: returns the inserted cover-letter row and touched application.

Examples:

```bash
jobtrack attach-cover-letter --application-id 1 --content-file cover-letter.md
jobtrack attach-cover-letter --application-id 1 --file cover-letter.pdf
jobtrack attach-cover-letter --application-id 1 --content "Dear hiring team..." --json
```

## Log An Interview

```bash
jobtrack log-interview --application-id ID --round screen|technical|onsite|final --scheduled-at DATE --format phone|video|onsite [--interviewer TEXT] [--outcome pending|passed|failed] [--notes TEXT] [--json]
```

Writes: inserts one row into `interviews`. If the application is still `applied`, moves it to `interviewing`. Defaults `outcome` to `pending`.

Reads: returns the inserted interview row and updated application.

Examples:

```bash
jobtrack log-interview --application-id 1 --round screen --scheduled-at 2026-07-01T10:00:00Z --format video --interviewer "Sam Lee" --outcome pending
jobtrack log-interview --application-id 1 --round technical --scheduled-at 2026-07-08T14:00:00Z --format video --notes "Bring portfolio" --json
```

## Record An Offer

```bash
jobtrack record-offer --application-id ID --details TEXT [--decision-deadline DATE] [--outcome pending|accepted|declined] [--json]
```

Writes: inserts or replaces the application offer in `offers`, then moves the application status to `offer`. Defaults offer `outcome` to `pending`.

Reads: returns the full structured application path.

Example:

```bash
jobtrack record-offer --application-id 1 --details '$145k base plus equity' --decision-deadline 2026-07-15 --outcome pending
```

## Record A Final Or Status Outcome

```bash
jobtrack record-outcome --application-id ID --status applied|interviewing|offer|rejected|withdrawn [--notes TEXT] [--json]
```

Writes: updates `applications.status`, `status_changed_at`, `updated_at`, and appends `--notes` to application notes when provided.

Reads: returns the full structured application path.

Examples:

```bash
jobtrack record-outcome --application-id 1 --status rejected --notes "Company selected another candidate"
jobtrack record-outcome --application-id 1 --status withdrawn --notes "Accepted another offer" --json
```

## Edit An Application

```bash
jobtrack update-application --application-id ID [--company TEXT] [--role TEXT] [--status STATUS] [--applied-date DATE] [--job-url URL] [--notes TEXT] [--json]
jobtrack edit-application --application-id ID [same options]
```

Writes: updates supplied `applications` columns. Updating `--status` also updates `status_changed_at`.

Reads: returns the full structured application path.

Example:

```bash
jobtrack update-application --application-id 1 --status interviewing --notes "Recruiter screen scheduled"
```

## Edit An Interview

```bash
jobtrack update-interview --interview-id ID [--round ROUND] [--scheduled-at DATE] [--format FORMAT] [--interviewer TEXT] [--outcome OUTCOME] [--notes TEXT] [--json]
```

Writes: updates supplied `interviews` columns and touches the parent application.

Reads: returns the full structured application path.

Example:

```bash
jobtrack update-interview --interview-id 1 --outcome passed --notes "Advanced to technical"
```

## Edit An Offer

```bash
jobtrack update-offer --application-id ID [--details TEXT] [--decision-deadline DATE] [--outcome pending|accepted|declined] [--json]
```

Writes: updates supplied `offers` columns and touches the parent application.

Reads: returns the full structured application path.

Example:

```bash
jobtrack update-offer --application-id 1 --outcome accepted
```

## Private Profile Corpus

Profile commands write only to the private `profile_entries` table, linked structured profile tables, and managed `attachments/` files. They do not sync to a public profile, create a product chat layer, add a server write API, or create any public profile exposure.

Every profile claim should carry source or confidence metadata. Prefer concrete, evidence-backed specifics over generic traits.

Sensitive boundary: contact details, references, and optional EEO/self-ID are internal-only. Persist them only when Cole explicitly supplies them. Do not copy them into public artifacts, web pages, cover letters, application packages, or external systems unless Cole separately asks for that exact use. Never infer protected-class or self-ID values.

Capture rule: convert raw material into the most specific supported command, preserve the original source and confidence, and avoid polishing uncertain input into a stronger claim. Use `--source`, `--source-url`, `--evidence`, `--recency`, `--confidence`, `--tags`, and `--file` or `--attachment-path` whenever the command accepts them. If a command does not expose every metadata flag in help output, still prefer the flags documented here only when they are already supported by the CLI.

Before adding a new fact, run `jobtrack profile search --text TEXT --json` or `jobtrack profile list --json` to avoid duplicates. If the new material corrects or deepens an existing flat entry, use `profile update`; if it corrects work or education, use the structured update command.

### Seed From A Resume Or Profile Document

```bash
jobtrack profile import-resume --file PATH [--title TEXT] [--source TEXT] [--source-url URL] [--evidence TEXT] [--recency TEXT] [--confidence low|medium|high|unverified] [--tags CSV] [--json]
jobtrack profile seed-resume --file PATH [same options]
```

Writes: copies `PATH` into `JOBTRACK_HOME/attachments/` and inserts one `profile_entries` row with category `resume`, full text content, attachment path, source metadata, confidence, recency, and tags. Defaults source to `resume`, confidence to `medium`, and tags to `resume,seed`.

Reads: returns the inserted profile entry.

Examples:

```bash
jobtrack profile import-resume --file resume.md --confidence medium --tags resume,seed --json
jobtrack profile import-resume --file cole-profile.txt --title "Verbose profile seed" --source "Cole profile draft" --confidence high
```

### Add Structured Work History

```bash
jobtrack profile add-work --company TEXT --role TEXT --start-date DATE (--end-date DATE|--present) [--location TEXT] [--highlights TEXT|--highlights-file PATH] [--description TEXT|--description-file PATH] (--source TEXT|--confidence CONFIDENCE) [--source-url URL] [--evidence TEXT] [--file PATH] [--attachment-path PATH] [--recency TEXT] [--tags CSV] [--json]
```

Writes: inserts one `profile_entries` metadata row with category `work`, then inserts one linked `profile_work_entries` row with company, role/title, start date, end date or present, optional location, highlights, and description. With `--file`, copies evidence into `JOBTRACK_HOME/attachments/`; `--attachment-path` records an already-managed attachment reference.

Reads: returns the inserted profile entry. JSON includes the flat metadata fields plus `work` and `structured` objects.

Use this command for employment/work history. Do not use the flat `profile add --category work` path for new work history unless importing legacy free-text material that cannot yet be structured.

Examples:

```bash
jobtrack profile add-work --company ExampleCo --role "Platform Engineer" --start-date 2022-01 --present --location Remote --highlights "Led platform migration" --source "Cole interview 2026-06-25" --confidence high --tags platform,leadership --json
jobtrack profile add-work --company "Northwind" --role "Backend Engineer" --start-date 2019-05 --end-date 2021-12 --description-file work-notes.md --source resume --source-url "https://example.com/profile" --confidence medium --file evidence.pdf
```

### Edit Structured Work History

```bash
jobtrack profile update-work --entry-id ID [--company TEXT] [--role TEXT] [--start-date DATE] [--end-date DATE] [--present true|false] [--location TEXT] [--highlights TEXT|--highlights-file PATH] [--description TEXT|--description-file PATH] [--source TEXT] [--source-url URL] [--evidence TEXT] [--file PATH] [--attachment-path PATH] [--recency TEXT] [--confidence CONFIDENCE] [--tags CSV] [--json]
jobtrack profile edit-work --entry-id ID [same options]
```

Writes: updates supplied structured work fields and/or existing profile metadata without dropping source, evidence, confidence, recency, tags, or attachment metadata that was not explicitly changed. When structured fields change, the generated flat title/content mirror is refreshed for compatibility.

Reads: returns the updated profile entry with `work` and `structured` objects.

Example:

```bash
jobtrack profile update-work --entry-id 4 --present false --end-date 2024-03 --evidence "Cole confirmed end date" --confidence high --json
```

### Add Structured Education

```bash
jobtrack profile add-education --institution TEXT --degree TEXT --field TEXT (--start-date DATE|--start-year YEAR) (--end-date DATE|--end-year YEAR|--graduation-year YEAR) [--honors TEXT|--honors-file PATH] [--notes TEXT|--notes-file PATH] (--source TEXT|--confidence CONFIDENCE) [--source-url URL] [--evidence TEXT] [--file PATH] [--attachment-path PATH] [--recency TEXT] [--tags CSV] [--json]
```

Writes: inserts one `profile_entries` metadata row with category `education`, then inserts one linked `profile_education_entries` row with institution, degree, field of study, start date/year, end date/year or graduation year, honors, and notes.

Reads: returns the inserted profile entry. JSON includes the flat metadata fields plus `education` and `structured` objects.

Examples:

```bash
jobtrack profile add-education --institution "Example University" --degree BS --field "Computer Science" --start-year 2010 --graduation-year 2014 --honors "Honors program" --source resume --confidence high --json
jobtrack profile add-education --institution "Community College" --degree Certificate --field "Data Systems" --start-date 2018-01 --end-date 2018-06 --notes "Evening program" --source "Cole interview 2026-06-25" --confidence high
```

### Edit Structured Education

```bash
jobtrack profile update-education --entry-id ID [--institution TEXT] [--degree TEXT] [--field TEXT] [--start-date DATE|--start-year YEAR] [--end-date DATE|--end-year YEAR] [--graduation-year YEAR] [--honors TEXT|--honors-file PATH] [--notes TEXT|--notes-file PATH] [--source TEXT] [--source-url URL] [--evidence TEXT] [--file PATH] [--attachment-path PATH] [--recency TEXT] [--confidence CONFIDENCE] [--tags CSV] [--json]
jobtrack profile edit-education --entry-id ID [same options]
```

Writes: updates supplied structured education fields and/or existing profile metadata without dropping source, evidence, confidence, recency, tags, or attachment metadata that was not explicitly changed. When structured fields change, the generated flat title/content mirror is refreshed for compatibility.

Reads: returns the updated profile entry with `education` and `structured` objects.

Example:

```bash
jobtrack profile update-education --entry-id 5 --honors "Graduated with honors" --evidence "Resume and transcript note agree" --confidence high --json
```

### Contact, Summary, Compensation, And Availability

```bash
jobtrack profile set-contact [--name TEXT] [--email TEXT] [--phone TEXT] [--location TEXT] [--work-authorization TEXT] [--sponsorship TEXT] [--relocation-willingness TEXT] [--remote-preference TEXT] [--compensation TEXT] [--notice-period TEXT] [--earliest-start-date DATE] [--headline TEXT] [--summary TEXT|--summary-file PATH] [--source TEXT] [--source-url URL] [--evidence TEXT] [--recency TEXT] [--confidence low|medium|high|unverified] [--tags CSV] [--json]
jobtrack profile set-summary [--headline TEXT] [--summary TEXT|--summary-file PATH] [--json]
```

Writes: upserts the singleton `profile_contact` row. This captures name, email, phone, location, work authorization, visa/sponsorship needs, relocation willingness, remote preference, compensation expectations, notice period, earliest start date, headline, professional summary, source/evidence/confidence/recency, and tags.

Reads: returns the contact/profile summary row. `profile show --json` also includes it as `contact`.

Use contact, work authorization, compensation, availability, headline, and summary fields as internal application/autofill source material. Do not copy phone, email, compensation, visa/sponsorship, or availability details into public-facing material unless Cole explicitly approves that exact use for the target application.

Examples:

```bash
jobtrack profile set-contact --name "Cole Example" --email cole@example.com --phone 555-0100 --location Remote --work-authorization "US citizen" --sponsorship "not needed" --remote-preference remote --compensation "$160k+" --notice-period "2 weeks" --earliest-start-date 2026-07-15 --source "Cole interview 2026-06-26" --json
jobtrack profile set-summary --headline "Backend/platform engineer" --summary "Builds local-first operational tools with Node, SQLite, and durable workflows." --json
```

### Links, Skills, Projects, Credentials, Recognition, Publications, Languages, And Volunteer Work

```bash
jobtrack profile add-link --kind TEXT --url URL [--label TEXT] [--username TEXT] [--source TEXT] [--source-url URL] [--evidence TEXT] [--file PATH] [--attachment-path PATH] [--recency TEXT] [--confidence CONFIDENCE] [--tags CSV] [--json]
jobtrack profile add-skill --name TEXT [--proficiency TEXT] [--group TEXT] [--years TEXT] [--notes TEXT|--notes-file PATH] [--source TEXT] [--source-url URL] [--evidence TEXT] [--file PATH] [--attachment-path PATH] [--recency TEXT] [--confidence CONFIDENCE] [--tags CSV] [--json]
jobtrack profile add-project --name TEXT [--description TEXT|--description-file PATH] [--stack CSV] [--role TEXT] [--url URL] [--links CSV] [--start-date DATE] [--end-date DATE] [--highlights TEXT|--highlights-file PATH] [--source TEXT] [--source-url URL] [--evidence TEXT] [--file PATH] [--attachment-path PATH] [--recency TEXT] [--confidence CONFIDENCE] [--tags CSV] [--json]
jobtrack profile skill-link --entry-id ID --skill SLUG_OR_NAME_OR_ALIAS [--source TEXT] [--confidence 0..1] [--evidence TEXT] [--json]
jobtrack profile skill-unlink --entry-id ID --skill SLUG_OR_NAME_OR_ALIAS [--json]
jobtrack profile skill-links [--entry-id ID | --skill SLUG_OR_NAME_OR_ALIAS | --unresolved] [--json]
jobtrack profile set-display --entry-id ID [--status pinned|visible|hidden] [--order N | --clear-order] [--json]
jobtrack profile link-repo --entry-id ID --url HTTPS_URL [--role primary|component|deploy-target|mirror|docs] [--primary] [--name TEXT] [--json]
jobtrack profile unlink-repo --entry-id ID --url HTTPS_URL [--json]
jobtrack repo add --url HTTPS_URL [--name TEXT] [--visibility public|private] [--notes TEXT] [--json]
jobtrack repo list [--json]
jobtrack repo update --url HTTPS_URL [--name TEXT] [--visibility public|private] [--notes TEXT] [--json]
jobtrack profile project-kind --entry-id ID --kind application|library|service|site|tool|experiment [--json]
jobtrack profile relate --entry-id ID --to-entry-id ID --relation uses|extracted_from|part_of|successor_of [--notes TEXT] [--json]
jobtrack profile unrelate --entry-id ID --to-entry-id ID --relation RELATION [--json]
jobtrack profile relations [--entry-id ID] [--json]
jobtrack profile add-certification --name TEXT [--issuer TEXT] [--credential-id TEXT] [--issued-at DATE] [--expires-at DATE] [--url URL] [--notes TEXT|--notes-file PATH] [--source TEXT] [--evidence TEXT] [--tags CSV] [--json]
jobtrack profile add-license --name TEXT [--issuer TEXT] [--license-number TEXT] [--issued-at DATE] [--expires-at DATE] [--url URL] [--notes TEXT|--notes-file PATH] [--source TEXT] [--evidence TEXT] [--tags CSV] [--json]
jobtrack profile add-award --title TEXT [--issuer TEXT] [--awarded-at DATE] [--description TEXT|--description-file PATH] [--url URL] [--source TEXT] [--evidence TEXT] [--tags CSV] [--json]
jobtrack profile add-honor --title TEXT [same options]
jobtrack profile add-publication --title TEXT [--publisher TEXT] [--published-at DATE] [--url URL] [--description TEXT|--description-file PATH] [--source TEXT] [--evidence TEXT] [--tags CSV] [--json]
jobtrack profile add-talk --title TEXT [--venue TEXT] [--published-at DATE] [--url URL] [--description TEXT|--description-file PATH] [--source TEXT] [--evidence TEXT] [--tags CSV] [--json]
jobtrack profile add-patent --title TEXT [--publisher TEXT] [--published-at DATE] [--url URL] [--description TEXT|--description-file PATH] [--source TEXT] [--evidence TEXT] [--tags CSV] [--json]
jobtrack profile add-language --language TEXT [--proficiency TEXT] [--notes TEXT|--notes-file PATH] [--source TEXT] [--evidence TEXT] [--tags CSV] [--json]
jobtrack profile add-volunteer --organization TEXT [--role TEXT] [--cause TEXT] [--start-date DATE] [--end-date DATE|--present] [--location TEXT] [--description TEXT|--description-file PATH] [--highlights TEXT|--highlights-file PATH] [--source TEXT] [--evidence TEXT] [--tags CSV] [--json]
```

Writes: inserts a compatible `profile_entries` row plus a linked structured row in the matching table. These commands preserve source/evidence/confidence/recency/tags and optional attachment/source-link metadata when supplied. The generated flat entry keeps search/read compatibility while the linked structured row preserves section-specific fields.

Reads: returns the inserted profile entry. JSON includes a section-specific object such as `link`, `skill`, `project`, `credential`, `recognition`, `publication`, `language`, or `volunteer`, plus `structured` for generic consumers.

Examples:

```bash
jobtrack profile add-link --kind github --url https://github.com/example --source "Cole supplied" --json
jobtrack profile add-skill --name SQLite --proficiency advanced --evidence "Built JobTrack CLI/store" --tags sqlite,node --json
jobtrack profile add-project --name JobTrack --description "Private job tracker" --stack Node,SQLite --role Builder --url https://example.com/jobtrack --source "local project" --json
jobtrack profile skill-link --entry-id 12 --skill sqlite --source repo_mining --evidence "Schema + migrations in bin/jobtrack.js" --json
jobtrack profile skill-links --unresolved --json
jobtrack export public-profile [--out FILE] [--json]

jobtrack profile add-certification --name "AWS Solutions Architect" --issuer AWS --credential-id ABC123 --issued-at 2025-01 --json
jobtrack profile add-license --name "Professional Engineer" --issuer "Example Board" --license-number PE-123 --expires-at 2027-12 --source "Cole supplied" --json
jobtrack profile add-award --title "Engineering Excellence" --issuer ExampleCo --awarded-at 2024 --description "Recognized platform migration leadership" --json
jobtrack profile add-honor --title "Dean's List" --issuer "Example University" --awarded-at 2014 --evidence "Resume education section" --json
jobtrack profile add-publication --title "Durable Local Workflows" --publisher "Personal blog" --published-at 2026-02 --url https://example.com/writing --json
jobtrack profile add-talk --title "SQLite for Local-First Tools" --venue "Example Meetup" --published-at 2025-09 --url https://example.com/talk --json
jobtrack profile add-patent --title "Queue Coordination System" --publisher USPTO --published-at 2023 --url https://example.com/patent --confidence unverified --evidence "Needs patent number confirmation" --json
jobtrack profile add-language --language English --proficiency native --json
jobtrack profile add-volunteer --organization "Code Club" --role Mentor --cause education --start-date 2023-01 --present --highlights "Mentored junior developers" --json
```

Use `add-certification` for certificates and `add-license` for licenses. Use `add-award` or `add-honor` for recognition. Use `add-publication`, `add-talk`, or `add-patent` based on the actual source material; do not collapse an uncertain talk or unpublished draft into a publication. Do not invent proficiency, credentials, awards, patents, publications, languages, dates, URLs, or metrics. If the operator gives uncertain material, store the uncertainty in `--evidence`, use `--confidence low` or `unverified`, and ask before using it in downstream application materials.

### Reusable Application Answer Bank

```bash
jobtrack profile add-answer --question TEXT (--answer TEXT|--answer-file PATH) [--category TEXT] [--source TEXT] [--source-url URL] [--evidence TEXT] [--file PATH] [--attachment-path PATH] [--recency TEXT] [--confidence CONFIDENCE] [--tags CSV] [--json]
```

Writes: inserts one `profile_entries` row and one linked `profile_answers` row with question, answer content, optional category, tags, and source/evidence metadata. Use this for reusable application-form answers such as motivation, work authorization explanation, leadership examples, or salary/availability wording.

Reads: returns the inserted entry with an `answer` object. `jobtrack profile search --text TEXT --json` searches question/answer content through the compatible profile entry text.

Examples:

```bash
jobtrack profile add-answer --question "Why this role?" --answer "Because the role matches local-first infrastructure and developer tooling work." --category motivation --source "Cole interview 2026-06-26" --tags motivation,tailoring --json
jobtrack profile search --text "Why this role" --json
```

Answers are reusable source material, not final application copy. Tailor later and keep claims grounded in stored evidence.

### Sensitive References And Optional EEO/Self-ID

```bash
jobtrack profile add-reference --name TEXT [--relationship TEXT] [--company TEXT] [--title TEXT] [--contact TEXT] [--notes TEXT|--notes-file PATH] [--source TEXT] [--source-url URL] [--evidence TEXT] [--recency TEXT] [--confidence CONFIDENCE] [--tags CSV] [--json]
jobtrack profile set-eeo [--gender TEXT] [--pronouns TEXT] [--race-ethnicity TEXT] [--veteran TEXT] [--disability TEXT] [--notes TEXT|--notes-file PATH] [--source TEXT] [--source-url URL] [--evidence TEXT] [--recency TEXT] [--confidence CONFIDENCE] [--tags CSV] [--json]
```

Writes: `add-reference` inserts one `profile_references` row. `set-eeo` upserts the singleton `profile_eeo` row. These rows are not mirrored into `profile_entries` as public-ish profile cards. They are readable through CLI `profile show --json` and searchable through CLI `profile search --text TEXT --json` under `sensitive`; a private operator web view may display them only as internal-only/autofill-only material.

Examples:

```bash
jobtrack profile add-reference --name "Reference Person" --relationship Manager --company ExampleCo --contact ref@example.com --source "Cole supplied" --json
jobtrack profile set-eeo --gender undisclosed --veteran undisclosed --disability undisclosed --source "Cole supplied" --json
```

Never infer or normalize protected-class answers beyond what Cole explicitly supplied. Do not expose references or EEO/self-ID in public web views, cover letters, package artifacts, or external systems by default. Treat references as permission-gated contact data and EEO/self-ID as optional form-fill data only.

### Add A Flat Profile Entry

```bash
jobtrack profile add --category CATEGORY --title TEXT (--content TEXT|--content-file PATH) (--source TEXT|--confidence CONFIDENCE) [--source-url URL] [--evidence TEXT] [--file PATH] [--attachment-path PATH] [--recency TEXT] [--tags CSV] [--json]
```

Writes: inserts one flat profile row. With `--file`, copies evidence into `JOBTRACK_HOME/attachments/` and stores the relative attachment path. `--attachment-path` records an already-managed attachment reference. Use this flat command for `skill`, `project`, `accomplishment`, `story`, `preference`, `link`, `evidence`, `resume`, and `other` entries. Prefer `add-work` and `add-education` for new work and education facts.

Reads: returns the inserted profile entry.

Examples:

```bash
jobtrack profile add --category story --title "Led billing migration" --content "Led a billing migration from a fragile cron path to queued workers; reduced failed retries and gave support a clear audit trail." --source "Cole interview 2026-06-24" --confidence high --recency "recent" --tags migration,backend,leadership --json
jobtrack profile add --category skill --title "SQLite and Node" --content "Built local-first Node CLIs over SQLite with WAL mode and read-only web projections." --source resume --confidence medium --tags node,sqlite,cli
jobtrack profile add --category evidence --title "Portfolio architecture note" --content-file notes/profile-evidence.md --file artifacts/architecture.pdf --source "local portfolio" --confidence high
```

### Update A Profile Entry

```bash
jobtrack profile update --entry-id ID [--category CATEGORY] [--title TEXT] [--content TEXT|--content-file PATH] [--source TEXT] [--source-url URL] [--evidence TEXT] [--file PATH] [--attachment-path PATH] [--recency TEXT] [--confidence CONFIDENCE] [--tags CSV] [--json]
jobtrack profile edit --entry-id ID [same options]
```

Writes: updates supplied profile columns and `updated_at`. With `--file`, copies the new evidence file into managed attachments.

Reads: returns the updated profile entry.

Example:

```bash
jobtrack profile update --entry-id 3 --confidence high --evidence "Cole confirmed this story and supplied metrics" --tags migration,backend,metrics
```

### Search Or Show Profile Material

```bash
jobtrack profile search [--text TEXT] [--category CATEGORY] [--confidence CONFIDENCE] [--tag TAG] [--limit N] [--json]
jobtrack profile show [ENTRY_ID] [--json]
jobtrack profile list [--json]
jobtrack profile read [ENTRY_ID] [--json]
```

Reads: profile rows only. `search` checks title, content, source, source URL, evidence, recency, tags, and structured row content. `show` with no id or `list` returns `contact`, `eeo`, `references`, and all compatible profile entries ordered by latest update. JSON for structured work includes `work`; JSON for structured education includes `education`; newer structured entries include objects such as `skill`, `project`, `answer`, or `credential`; flat categories remain flat.

Writes: nothing except first-use store initialization.

Examples:

```bash
jobtrack profile search --text migration --json
jobtrack profile search --category work --text ExampleCo --json
jobtrack profile search --category skill --tag node --confidence high
jobtrack profile show 1 --json
jobtrack profile list --json
```

### Extract Relevant Specifics For An Application Context

```bash
jobtrack profile extract [--application-id ID] [--company TEXT] [--role TEXT] [--text TEXT] [--tags CSV] [--limit N] [--json]
```

Reads: candidate profile entries relevant to the supplied application context. With `--application-id`, the CLI reads company, role, notes, and job URL from `applications` and ranks profile entries against that context plus any extra `--text`.

Writes: nothing except first-use store initialization.

Use this for later assessment or cover-letter grounding. The output is not a draft and must not be treated as permission to invent unsupported claims. Cite profile entry ids and sources when using these specifics in downstream artifacts.

Examples:

```bash
jobtrack profile extract --application-id 1 --text "backend migration leadership" --limit 5 --json
jobtrack profile extract --company ExampleCo --role "Platform Engineer" --text "Node SQLite operations" --json
```

## Agent-Led Profile Capture Guidance

An external applying agent should deepen Cole's profile through normal conversation outside JobTrack, then persist only confirmed facts through CLI commands. The pathway follows `jobtrack-application-assistance-v1`: Cole talks to an external agent, the agent uses `jobtrack-skill-cli`, the CLI writes `jobtrack-store` and `attachments-dir`, and later application materials may draw from `profile-corpus` only through grounded profile entries.

### Raw Material To Commands

Use `jobtrack parse-guidance --type profile-capture --json` before writing when raw material is long or mixed. Split the material into atomic facts, search for duplicates, then run one explicit write command per accepted fact or coherent record.

- Resume/profile document: store the source document with `profile import-resume`, then extract structured work with `profile add-work`, education with `profile add-education`, skills with `profile add-skill`, projects with `profile add-project`, and remaining stories/accomplishments/evidence with `profile add`.
- Contact/personal/autofill data: capture name, email, phone, location, work authorization, sponsorship needs, relocation willingness, remote preference, compensation expectations, notice period, earliest start date, headline, and professional summary with `profile set-contact` or `profile set-summary`.
- Structured work: capture company, role/title, start date, end date or present, location, responsibilities, stack, scope, team/domain context, measurable outcomes, and highlights/description with `profile add-work`; update corrections with `profile update-work`.
- Structured education: capture institution, degree, field of study, start/end or graduation year, honors, notes, relevant coursework, and evidence with `profile add-education`; update corrections with `profile update-education`.
- Links: capture GitHub, portfolio, LinkedIn, writing, demos, repositories, and other application links with `profile add-link`.
- Skills: capture skill name, proficiency/depth, group, years, recency, where used, strongest proof, and stale/weak areas with `profile add-skill`.
- Projects: capture problem, constraints, Cole's role, architecture, tradeoffs, stack, dates, links, highlights, and evidence with `profile add-project`.
- Skill relations: bind catalog skills to specific work/education/project entries with `profile skill-link` (resolution is strict slug/name/alias — it never creates catalog skills; add missing skills first with `profile add-skill`). Review coverage and unlinkable stack strings with `profile skill-links [--unresolved]`.
- Mission Control sync (optional enrichment, never a public source): `profile map-mc` binds a project entry to an MC project via the loopback read API; `profile sync-mc` dry-runs a drift report (title drift, stale end dates, archived-status recommendations) and `--apply` writes exactly one narrow field — clearing a stale end_date when MC says the project is active. Curated prose is never auto-changed; an unreachable MC is a soft outcome.
- Project graph: `profile project-kind` distinguishes libraries/applications/services/sites/tools/experiments; `profile relate`/`unrelate`/`relations` record the dependency graph (`uses`, `extracted_from`, `part_of`, `successor_of`) between project entries — e.g. mission-control uses its six git-pinned libraries.
- Repos: repositories are entities identified by unique https URL (`repo add`/`repo list`), linked to projects with roles and one primary via `profile link-repo`/`unlink-repo`. Existing project url/links backfill automatically. `--visibility private` repos stay linked and queryable but never appear in the public export.
- Presentation curation: `profile set-display` pins, hides, or orders any profile entry (`display_status` + `display_order` on the spine). Hidden entries stay in the private views; the public export excludes them. Curation never touches `updated_at` or content.
- Public export: `jobtrack export public-profile [--out FILE]` emits the allowlisted, uuid-keyed public projection for the personal site (contract: `contracts/export/public-profile.v2.schema.json`). v2 honors curation: hidden entries are fully excluded (including from `uses` arrays), arrays are ordered pinned-first then display order then recency, every entity carries `pinned`, and projects carry `kind`, PUBLIC-visibility repos only, and `uses` refs. It validates against the contract and fails closed on any redaction violation (email/phone patterns, forbidden private fields, integer row ids). Stories cross only with purpose `public_bio`, an approved current variant, an unexpired `allow` permission, and `normal` sensitivity. Re-export after any profile change you want the site to pick up; the site build consumes the artifact — JobTrack itself never serves public traffic.
- Certifications/licenses: capture name, issuer, credential/license id, issue/expiration dates, URL, and evidence with `profile add-certification` or `profile add-license`.
- Awards/honors: capture title, issuer, date, description, URL, and evidence with `profile add-award` or `profile add-honor`.
- Publications/talks/patents: capture title, kind, publisher/venue, date, URL, description, and evidence with `profile add-publication`, `profile add-talk`, or `profile add-patent`.
- Languages: capture language, proficiency, notes, and evidence with `profile add-language`.
- Volunteer experience: capture organization, role, cause, dates or present, location, highlights, and description with `profile add-volunteer`.
- Reusable application answers: capture the exact question, answer, category, source/evidence, tags, and whether the wording needs tailoring with `profile add-answer`.
- References: capture name, relationship, company/title, contact details, notes, source, recency, confidence, and permission boundaries with `profile add-reference` only when Cole explicitly supplies them.
- Optional EEO/self-ID: capture only explicit values Cole chooses to store with `profile set-eeo`; never infer protected-class, veteran, disability, gender, pronoun, race, or ethnicity data.
- Flat entries: use `profile add` for stories, accomplishments, preferences, evidence notes, resume-derived fragments, and other material that does not fit a structured command. Prefer structured commands when a supported structured surface exists.

### Traceability And Confidence

Use concrete source labels such as `resume`, `Cole interview 2026-06-26`, `portfolio`, `LinkedIn`, `GitHub`, `artifact`, or a named document. Add `--source-url` for external sources and `--file` or `--attachment-path` for local evidence when available.

Use `--evidence` to quote or summarize the exact basis for the claim, especially for metrics, scope, dates, certifications, awards, publications, patents, language proficiency, work authorization, compensation, or references.

Use confidence consistently: `high` for Cole-confirmed first-person facts or direct evidence, `medium` for resume/profile-derived facts that seem reliable, `low` for plausible but incomplete material, and `unverified` when the fact is stored only to ask about later.

Use `--recency` and `--tags` to make future retrieval useful. Good tags include role families, stacks, domains, seniority signals, story types, application-answer categories, and sensitivity markers such as `internal-only` or `autofill-only`.

### No Unsupported Claims

Ask follow-up questions before writing vague or consequential facts. Never invent employers, titles, dates, degrees, graduation years, credentials, license numbers, publications, patents, awards, language proficiency, metrics, team sizes, compensation expectations, authorization status, reference permissions, or protected-class/self-ID values.

Store uncertainty visibly in `--evidence`, `--notes`, or the content itself. Do not convert uncertain material into polished resume/application claims. If a fact is unsupported but worth preserving for later confirmation, store it with `--confidence unverified` and tags such as `needs-confirmation`.

### Sensitive And Internal-Only Fields

Contact details, work authorization, sponsorship needs, compensation expectations, availability, references, and EEO/self-ID data are internal-only. Use them as private operator/autofill source material, not as public profile content.

References require explicit permission boundaries. EEO/self-ID is optional form-fill data only. Do not include sensitive fields in cover letters, package artifacts, public pages, external systems, or job-site submissions unless Cole separately approves that exact use.

### Completion Check

After each write, run `profile show <entry-id> --json`, `profile show --json`, or `profile search --text TEXT --json` to confirm the stored claim, source/evidence, confidence, recency, and tags. If a mistake is found, correct it with the matching `profile update`, `profile update-work`, or `profile update-education` command rather than adding a conflicting duplicate.

## Agent Workflow

1. Search before writing if the operator gives company/role but not an application id.
2. Use `parse-guidance --json` to map raw input to concrete fields.
3. For a new opportunity, run `add-prospect`, then `capture-posting`, then one or more `add-research` commands with citations/source references.
4. For profile material, use `profile search` before adding, then the most specific supported profile command with source/confidence/evidence/recency/tags metadata; use `profile extract` to find relevant entry ids for assessment grounding.
5. Create an assessment with `assess-application`, show it with `show-assessment`, and wait for Cole's explicit `review-assessment` decision before any letter/package step.
6. Run exactly one explicit write command for each user-approved change.
7. After Cole approves the assessment, use `draft-cover-letter`, then `build-package`, then `show-package`, `show <id> --json`, and `lifecycle <id> --json` to confirm the package path.
8. Never call a server write endpoint; there is none by design.
9. Keep `status` and `workflow_stage` separate: status is the application outcome path; workflow stage is assistance progress.
10. Never treat this skill as a crawler, chat service, credential store, web write API, browser submitter, autonomous final submitter, or public profile surface. It can assemble package records and store agent-authored cover letters only through the explicit gated CLI commands.

## Smoke Path

```bash
npm install
export JOBTRACK_HOME=$(mktemp -d)
npm exec -- jobtrack add-application --company ExampleCo --role Engineer --status applied --applied-date 2026-06-24
npm exec -- jobtrack log-interview --application-id 1 --round screen --scheduled-at 2026-07-01T10:00:00Z --format video --outcome pending
npm exec -- jobtrack search --company ExampleCo
npm exec -- jobtrack show 1 --json
printf 'Cole led a migration from cron jobs to queued workers.\n' > resume.md
npm exec -- jobtrack profile import-resume --file resume.md --json
npm exec -- jobtrack profile add --category story --title Example --content "Led a migration" --source "Cole interview" --confidence high --json
npm exec -- jobtrack profile search --text migration --json
npm exec -- jobtrack profile show --json
npm exec -- jobtrack profile extract --application-id 1 --text migration --json
```

Lifecycle smoke:

```bash
npm install
export JOBTRACK_HOME=$(mktemp -d)
npm exec -- jobtrack profile add-work --company ExampleCo --role "Platform Engineer" --start-date 2022-01 --present --location Remote --highlights "Led reliable internal platform work" --source note --confidence high --json
npm exec -- jobtrack profile add-education --institution "Example University" --degree BS --field "Computer Science" --start-year 2010 --graduation-year 2014 --source note --confidence high --json
npm exec -- jobtrack profile add-skill --name SQLite --proficiency advanced --source note --confidence high --json
npm exec -- jobtrack add-prospect --company ExampleCo --role Engineer --url https://example.com/job --json
npm exec -- jobtrack capture-posting --application-id 1 --source-url https://example.com/job --content "Example posting text" --json
npm exec -- jobtrack add-research --application-id 1 --source-url https://example.com/about --citation "Example citation" --notes "Company research" --json
npm exec -- jobtrack assess-application --application-id 1 --company-assessment "Useful company" --role-fit "Strong fit" --risks "Needs compensation clarity" --evidence "Posting #1 and research #2" --open-questions "Confirm remote policy" --approach "Lead with local-first tooling" --json
npm exec -- jobtrack draft-cover-letter --application-id 1 --json # expected to fail before approval
npm exec -- jobtrack review-assessment --application-id 1 --decision approved --notes "Proceed" --json
npm exec -- jobtrack draft-cover-letter --application-id 1 --json
npm exec -- jobtrack build-package --application-id 1 --checklist "Cole reviews final answers" --json
npm exec -- jobtrack show-package --application-id 1 --json
npm exec -- jobtrack show-assessment --application-id 1 --json
npm exec -- jobtrack lifecycle 1 --json
npm exec -- jobtrack show 1 --json
```
