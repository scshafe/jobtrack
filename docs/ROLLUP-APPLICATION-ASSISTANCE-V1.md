# Rollup — application-assistance-v1, phase 5

Recorded 2026-09-05 on `main` after `16c1c36`. This is the lead-only rollup the
plan's fifth phase asks for: the four framed phases are independently
approved, a clean `JOBTRACK_HOME` walked from profile material and one job URL
to a ready-to-submit package and a recorded manual submission, the archived v1
architecture's boundaries are cited edge by edge against today's code, and the
repository holds product code only.

Mission Control plan `application-assistance-v1` (project `jobtrack`), phase
`integrated-real-application-frame`.

## 1. Phases 1–4: delivered and independently approved

Every framed phase completed with its commit on `main` (each is an ancestor of
`16c1c36`, checked with `git merge-base --is-ancestor`), and every delegated
build slice under them carries an `approve` verdict in Mission Control's
reviews ledger from a different run than the builder's (the review route
refuses self-verification).

| Phase | Commit | Independent approval (reviews ledger) |
| --- | --- | --- |
| 1. Private profile corpus and capture pathway | `f8ce6f6` 2026-06-24 | "Build private profile corpus foundation" — approved 2026-06-24: verified the CLI/profile smoke path |
| 2. Prospect, research, assessment, and approach | `80c0a1a` 2026-06-25 | "Build prospect research assessment workflow" — approved 2026-06-24: inspected the CLI and skill surfaces |
| 3. Tailored letter and ready-to-submit package | `dd428f1` 2026-06-26 | "Build real cover-letter and package commands" and "Make cover letters agent-authored prose" — both approved 2026-06-26 |
| 4. Tracker lifecycle and read-only visibility | `e1680dd` 2026-06-25 | "Build read-only profile web visibility" — approved 2026-06-25 |

Delegated slices that the lead cut under those frames, all completed and
approved the same way: assistance store lifecycle spine (`ce6fabc`, approved
after inspecting that commit), structured work/education profile records
(`308f666`), structured profile web rendering (`753bc59`), comprehensive
application profile data surface (`95bb741`), agent-authored cover letter
grounding (`87d73de`), full `/profile` corpus rendering (`53d92ff`), and the
application detail page with the resume package (`f4faf0a`). The first slice
of the trial that seeded this plan (store + skill CLI, read-only web + Docker)
was approved on 2026-06-24 as well.

The ledger holds 35 review rows for this project: 12 `approve` verdicts on 12
distinct build tasks, and 23 `request_changes` rows that are the governor's
build-loop-floor advisories (`phase_status_mutated`,
`decision_thought_recorded`), not reviewer rejections. One phase,
"Comprehensive profile web rendering and capture guidance", is marked
`skipped`: its rendering half landed as the full `/profile` corpus phase
(`53d92ff`) and its guidance half as "Document comprehensive profile capture
pathway" (approved 2026-06-26).

## 2. The clean-store smoke (2026-09-05, Node 24.18.0)

The phase's verification recipe was written in June against verbs that have
since been replaced by the reviewed-material lane, so the recipe was run with
today's equivalents. Nothing was seeded by hand: every row below was written
by the CLI, in a store created by `jobtrack init` in a throwaway directory
outside the repository.

Inputs: a markdown resume for a fictional applicant (Sam Okafor), the posting
text for a fictional role (Loomworks, Fabric Engineer,
`https://careers.loomworks.test/jobs/7`), and an "about" page for the company.

| Step | Verb | Result |
| --- | --- | --- |
| store | `init` | WAL database + attachments directory, 0 profile entries |
| profile | `profile import-resume --file resume.md --confidence medium --tags resume,seed` | profile entry 1 (category `resume`) |
| link | `add-prospect --company Loomworks --role "Fabric Engineer" --url …/jobs/7` | application 1, `workflow_stage: prospective` |
| posting | `capture-posting --application-id 1 --source-url … --content-file posting.txt --citation …` | artifact 1 (`posting`), cited |
| research | `add-research --application-id 1 --source-url …/about --citation … --content-file about.txt` | artifact 2 (`research`), cited |
| assessment | `assess-application --application-id 1 … --profile-entry-refs 1` | assessment 1 / artifact 3, citation line "Grounded in artifact:1, artifact:2, profile:1" |
| Cole's review | `review-assessment --application-id 1 --decision approved --decided-by Cole` | gate 1 `approved` by Cole |
| resume | `application-material context` → `draft` (rough, then final-candidate) → `render` → `lint` → `review --decision approved --reviewed-by Cole` → `select --selected-by Cole` | revisions 1→2, render 1, lint `pass`, revision 2 selected |
| cover letter | the same six verbs | revisions 3→4, render 2, lint `pass`, revision 4 selected |
| readiness | `application-material readiness --application-id 1` | `ready: true`, no blockers, readiness digest `d2d6fcbe…` |
| package | `build-package --application-id 1 --expected-readiness-sha256 d2d6fcbe… --idempotency-key …` | package 1, `ready` |
| uploads | `application-material verify-uploads --resume-file <pdf> --cover-letter-file <pdf> --verified-by Cole --source-label staged` | both PDFs matched their render digests; structural PDF inspection ran in the container |
| submission | `application-material record-submission --package-id 1 --submitted-by Cole --expected-readiness-sha256 d2d6fcbe…` | submission 1 recorded 2026-09-06T02:45:52Z (UTC), `manual_submission_recorded` lifecycle event |
| result | `show 1` | `status: applied`, `workflow_stage: submitted`, package 1 `submitted`, 6 lifecycle events |

The renders were real: the pinned networkless renderer
(`jobtrack-latex-renderer:v0.6.1`, image digest `sha256:dcdeb866…`,
`jobtrack-texlive-2026.2`) produced a 1-page resume (47,532 bytes, output
digest `86cfa0a4…`) and a 1-page letter (22,476 bytes, `db1b9c1e…`), and the
resume-lint report on each render passed with no findings.

Two refusals fired along the way, and both are the product working as
decided: `review` refused an unlinted render (`MATERIAL_LINT_REQUIRED`), and
`record-submission` refused until the exact files to be attached had been
verified against their renders (`UPLOAD_NOT_VERIFIED`, D-021).

Read-only web, served from the same store on `127.0.0.1:18797`
(`node server.js`; the server refuses a non-loopback bind unless
`JOBTRACK_ALLOW_NON_LOOPBACK=1`):

| Request | Response |
| --- | --- |
| `GET /` | 200; the table lists Loomworks · Fabric Engineer · submitted |
| `GET /applications/1` | 200; shows the approved assessment, Package #1, the manual submission, resume and cover letter |
| `GET /applications/1/materials/1` | 200 |
| `GET /applications/1/material-renders/1.pdf` | 200 `application/pdf`; body digest `86cfa0a4…`, byte-identical to render 1 |
| `GET /profile` | 200; renders the imported corpus (Sam Okafor) |
| `POST /applications/1`, `PUT /` | 405, `allow: GET, HEAD` |

The full suite at this commit: 753 tests, 749 pass, 0 fail, 4 intentional
skips (`npm test`, Node 24.18.0). The clean-store fabric walks in
`test/fabric.test.js` ("the derivation names the correct next act at every
stage, ingest through recorded submission") and `test/fabric-tick.test.js`
("ticks alone advance a prepared application to a recorded submission, every
act attributed") cover the same path under the fabric's own executors.

The agent-driven counterpart of this human-driven smoke is applysim's drill
campaign (`applysim/docs/DRILL-CAMPAIGN-LOG.md`): engine-backed drills passed
with a recorded submission on 2026-08-21 (`drill-2608210518-0817d8e2`) and on
the v2 node-graph engine on 2026-09-01 (`drill-2609012047-c32fab5e`), and the
2026-09-02 wave (`w1-1`…`w1-5`, codex harness, full agent staffing) submitted
three deals and correctly escalated two to the human gate. On the real store
the dispatcher triaged all eleven live opportunities on 2026-09-05; they are
parked at the `opportunity.pursue` human gate, which is Cole's to decide.

## 3. Architecture `jobtrack-application-assistance-v1`: boundaries, cited

The graph (21 nodes, 22 edges, `dataflow`) is `archived` with intent
`deprecated-version`; Mission Control records it as superseded by the four
`current` diagrams `jobtrack-core-authority`,
`jobtrack-human-final-application-flow`, `jobtrack-strategy-plane` and
`jobtrack-email-authority`. It remains the plan's named source of truth, so
each of its edges is cited here against the mechanism that enforces it today
and the durable decision in `DECISIONS.md` that fixes it.

| # | Edge (from → to) | Boundary the graph states | Today's mechanism | Decisions |
| --- | --- | --- | --- | --- |
| 1 | Cole → External Applying Agent Session (sends) | Cole builds the profile conversationally, drops links, reviews and steers | the skill for conversational capture; steering is exercised through gates: `opportunity.pursue`, `review-assessment`, material `review`/`select`, `interview.prep.review`, `offer.decision` | D-009, D-021 |
| 2 | Agent → JobTrack Skill + CLI (sends) | every state change goes through the skill and CLI | fabric workers act through a `bin/jobtrack` shim and the exact commands in their brief; drafting holds no authority of its own | D-024, D-025 |
| 3 | CLI → JOBTRACK_HOME SQLite Store (writes) | only the host-side CLI writes structured data | unchanged; the web process has no write route (405 above) | D-004, D-022 |
| 4 | CLI → JOBTRACK_HOME Attachments (writes) | the CLI writes or references local attachment files | renders live under `attachments/material-renders/<app>/<revision>/`, immutable and digest-named | D-021 |
| 5 | Store ⊃ Verbose Private Profile Corpus (contains) | profile rows are part of the private local store | `profile_*` tables; internal-only, never exported except through #21–22 | D-015, D-016, D-018 |
| 6 | Store ⊃ Prospective Application Record (contains) | prospective applications extend the tracker path | `add-prospect` still creates `workflow_stage: prospective`; the discovery front (`opportunity ingest/triage/promote`) feeds the same record | D-001, D-002, D-010, D-011 |
| 7 | Agent → Job Posting URL (reads) | the agent reads the posting Cole supplied | the intake brief allows one plain GET: no login, no form, no script execution | D-006, D-007 |
| 8 | Agent → Company Research Sources (reads) | credential-safe, remote-friendly research | the research brief is bounded to public pages on the employer's own domain; never create an account, never submit | D-006, D-012 |
| 9 | Agent → Posting + Company Research Artifacts (produces) | research is persisted for grounding and review | `capture-posting` / `add-research` with citations (smoke artifacts 1 and 2) | D-003 |
| 10 | Research artifacts → Assessment + Approach Artifact (produces) | the assessment is grounded in captured evidence | `assess-application` records the grounding line "Grounded in artifact:1, artifact:2, profile:1" | D-003 |
| 11 | Profile corpus → Tailored Cover Letter Draft (produces) | the corpus grounds the letter | material `context` carries profile entries and artifacts and seals them in a source-state digest; a stale digest refuses the draft | D-024, D-025 |
| 12 | Assessment → Cover Letter Draft (produces) | drafting is blocked until Cole has reviewed or steered the assessment | the gate sits where authority is exercised: a rough draft may be started while the assessment awaits review, but its source manifest records no approved gate, readiness carries `ASSESSMENT_MISSING` / `ASSESSMENT_NOT_APPROVED`, and no package can be built until Cole's approval is on file (`test/application-materials.test.js`) | D-009, D-021 |
| 13 | Cover Letter Draft → Ready-to-Submit Package (produces) | the reviewed letter becomes part of the package | `build-package` binds the selected, reviewed, rendered revisions under the readiness digest; `verify-uploads` pins the exact bytes | D-021 |
| 14 | Cole → Job Site Submission (sends) | Cole submits manually; v1 automation stops before submission | `application.apply` defaults to `manual` and the production dispatcher never staffs it; outward-lane approvals must be set with `--set-authorship human`; `record-submission` is Cole's act | D-025, FABRIC_PLAN §9.3 |
| 15 | Read-Only Express Web UI → Store (reads) | the web reads the same store with no write route | GET/HEAD only, 405 otherwise; the container mounts `JOBTRACK_HOME` read-only | D-022 |
| 16 | Tailnet Browser → Web UI (reads) | loopback-bound service fronted over Tailscale | loopback bind enforced in `server.js`; the standing release gate keeps Funnel off and Serve tailnet-only (`docs/VERIFICATION.md`) | — |
| 17 | Web UI ⊃ Read-Only Profile View Page (contains) | the portal includes the profile page | `GET /profile` 200 | — |
| 18 | Profile page → Profile corpus (reads) | renders every corpus section | rendered the imported entry in the smoke | D-018 |
| 19 | Web UI ⊃ Read-Only Application Detail Page (contains) | a per-application detail page | `GET /applications/1` 200 (the node's description says `/application/:id`; the route is `/applications/:id`, a naming difference in the archived description only) | — |
| 20 | Detail page → Store (reads) | reads application, artifacts, assessment, letter, package | assessment, Package #1 and the manual submission rendered in the smoke | — |
| 21 | CLI ⊃ Public-Profile Export Command (contains) | the export lives in the CLI | `jobtrack export public-profile`, the only sanctioned crossing from the private store | D-022, D-023 |
| 22 | Export Command ⊃ public-profile.json Artifact (contains) | the allowlisted, uuid-keyed projection | owner-only `0600` artifact validated against `contracts/export/public-profile.v2.schema.json` with the redaction scan; consumed at build time by pages-generator | D-022 |

Nodes without an edge of their own are covered above: the `pages-generator +
scshafe.github.io` external is the consumer of #22, and the Job Site
Submission external is the target of #14.

Drift verdict: none of the 22 boundaries has been inverted or bypassed. Edge #12 is narrowed to the point where it matters: v1 phrased the assessment review as a gate on drafting, and today it gates readiness and the package instead, which is what D-009 (creation, review and selection are separate) asks for; the outcome the plan names, no letter reaching a ready-to-submit package without Cole's reviewed assessment, holds. What
grew since the graph was drawn is additive and each addition is itself a
durable decision: the discovery front (D-006, D-007, D-010, D-011), the
proposal-only email lanes (D-005, D-020), the strategy control plane (D-019),
the reviewed-material lane with pinned PDFs (D-021, D-024, D-025), UUID
identity and the public export as the only crossing (D-022, D-023), and the
approval-bound outward submission lane (D-026). The one descriptive
difference is edge #19's route name; the archived graph is left as history.

## 4. Repository cleanliness

`git ls-files` on `main` contains no Mission Control metadata: no
`.mc-plan/`, `.mc/`, `.mission-control/`, `.trial-phases.json` or `.claude`
paths. Those paths are kept out by the managed `.git/info/exclude`. The smoke
store lived under a scratch directory outside the checkout; `git status` was
clean before and after the smoke.

## 5. Outside v1, on purpose

- Driving a real application surface stays an explicit operator decision
  (`docs/FABRIC_PLAN.md` §9.3); `application.apply` stays `manual`.
- The production relay of Cole's mailbox into the real store, and a second
  company mailbox for drills, are Cole's to switch on.
- The four legacy demo applications in the real store carry no fabric work and
  are Cole's to delete.
