# Resume quality plan — making the materials lane top-notch

**Status:** FINAL (reviewed 2026-08-05)
**Scope:** the resume/cover-letter generation lane — `lib/material-templates.js`,
`lib/application-materials*.js`, `lib/latex-renderer.js`, `lib/profile-work-details.js`,
the profile substrate they read from, and the submission path that carries their output.
**Target candidate profile:** software engineer, 4–5 years of experience, U.S. private-sector
tech roles.

This plan translates a researched best-practices report (Harvard / MIT / Stanford / Berkeley
career-center guidance, Microsoft and Greenhouse parser documentation) into work that fits the
gated, content-addressed framework jobtrack already has. The organizing claim:

> Most published resume advice is unverifiable by the person receiving it. We render the PDF,
> hold the bytes, and pin the hash — so for us the advice is **checkable**, and what is
> checkable should be a gate, not a guideline.

The review of the draft added a second claim of equal weight, and it comes first in the work:

> A gate chain that ends at the render verifies nothing about what the employer receives.
> **It must extend to the received bytes.**

---

## 0. Measured baseline

**Two stores exist and must never be conflated.** `~/.jobtrack` is the personal store of record
(profile substrate; no applications have been driven through it). `~/.jobtrack-applysim` is the
drill store used by the applysim end-to-end runs. Every lane artifact cited below lives in the
**drill** store; a citation without a store name is a defect.

Probing the pinned renderer image (`jobtrack-latex-renderer:v0.6.1`, digest `sha256:dcdeb866…`)
established it already contains:

| Capability | Status |
| --- | --- |
| `pdftotext`, `pdfinfo`, `qpdf` (poppler + qpdf) | **present** |
| `helvet.sty`, `mathptmx.sty`, `charter.sty` (psnfss) | **present** |
| `hyperref.sty` | present (deliberately unused — see §3) |
| `enumitem.sty` | absent (known; `tightitemize` stands in) |

So the extraction work in Phase 3 ships against the **existing digest pin**. No renderer
successor is required for any phase of this plan.

### 0.1 Lane substrate

```
~/.jobtrack-applysim (drill store)        ~/.jobtrack (personal store)
  application_material_revisions      12    application_material_revisions       0
  application_material_source_manifests 12  application_material_renders         0
  application_material_renders         2    posting_skill_requirements           0
  posting_skill_requirements           0    profile_work_entries                13
  profile_work_entry_details           0    profile_work_entry_details           0
                                            profile_stories                      0
                                            profile_skills                      50
                                            profile_projects                    20
                                            profile_entries                     93
```

The lane **has** run end to end on this host — renders 1 and 2 exist with
`renderer_version jobtrack-texlive-2026.2`, managed attachments under
`~/.jobtrack-applysim/attachments/material-renders/`, and `output_sha256`
`75df179664875b4c…` (resume, revision 2) and `a43195305cca6be1…` (cover letter, revision 4).
Both hash byte-identically against their staged copies.

Two substrate tables are empty everywhere and gate later phases:
`profile_work_entry_details` (the fact ledger) and `posting_skill_requirements` (the left side
of any requirement→evidence join). Nothing currently populates either.

### 0.2 Render defects (v1 template)

Extracting text from render 1 (`output_sha256 75df1796…`, `resume.standard.v1`) found four
defects that no amount of content work would fix:

1. **Justified body text hyphenates keywords across line breaks** — `server-less`,
   `con-current`, `pro-cesses`, `prototype-grade`. `pdftotext` re-joins some; a naive parser
   indexes the fragments.
2. **Bullet glyphs do not survive extraction.** Items emerge as leading whitespace rather than
   discrete list entries, so a parser sees run-on prose where a reader sees five accomplishments.
3. **Dates detach from their role** in raw (non-`-layout`) extraction order — the "isolated
   dates" failure named in Greenhouse's parse-failure documentation. **Invisible in `-layout`
   mode**, which is the only mode the renderer records.
4. **Skills is a single flat comma list**, the report's explicit anti-pattern, and the timeline
   carries an unexplained **Jun 2022 → Apr 2025 gap**.

A fifth defect surfaced while building v2 and is recorded here because it is the same class:

5. **Section headings glue onto the tail of the preceding paragraph** when the heading macro
   opens in horizontal mode — extraction produced `Frontend: React, Next.js Experience` as one
   line. A parser reads that as a skills value, not a section boundary.

Confirmed already-correct: one page, US Letter, text-based, unencrypted, single logical column,
`\hfill` used as a genuine right tab stop rather than a table.

### 0.3 The submission gap (why Phase 0 exists)

The only live-fire submission to date — applysim drill `r2608050256bb3f` — uploaded two files:

```
3391157a3a6d47ff…  …-resume-Applicant-Resume.pdf            CORRUPT — unparseable
b4a8e7141f16e29b…  …-cover_letter-Applicant-Cover-Letter.pdf   intact
```

The resume is structurally destroyed: poppler inside the pinned image reports
`Couldn't find trailer dictionary` / `Catalog object is wrong type (null)` and extracts **zero
characters**. The cover letter from the same run parses cleanly, isolating the damage to the
resume's upload path — consistent with the base64 in-page injection workaround used because the
browser `file_upload` tool is broken.

Worse than a corrupted copy: **neither uploaded sha matches any render in the store**
(`75df1796…`, `a43195305…`). Those uploads had no verified provenance against the lane at all.

`render.sh` runs `qpdf --check` on every render, so lane-produced PDFs are structurally
validated at render time — the corruption happened strictly **after** the render, in the
carry. Every gate this plan proposed in draft would have passed while an unreadable resume
reached the employer. That is the first thing to fix.

---

## 1. Lessons that change the design

**L1 — What is checkable should be a gate.** We hold the rendered artifact. Extraction order,
page count, file size, bullet recoverability, hyphenation damage, and text-vs-payload identity
are all mechanically verifiable.

**L2 — The gate chain must reach the received bytes.** Verification that stops at
`output_sha256` is verification of a file nobody read. See §0.3.

**L3 — The scarce input is a fact ledger, not a template.** `profile_work_entry_details` and
`profile_stories` are both empty. A bullet cannot state a baseline, a scale, a constraint, or an
outcome that was never recorded. It is the long pole and it requires the human.

**L4 — "AI as editor, not author" must be enforced, not asserted.** Made concrete: every
numeric token in a bullet must appear in its cited sources **with the same unit**, or be covered
by an explicit human-confirmed derivation record; technologies match a lexicon by whole token;
and a bullet's lead verb must not claim more ownership than the cited node's `my_role`. Crucially
this only works if the ledger itself carries authorship — otherwise the agent writes an invented
fact into the ledger and then "cites" it, and provenance **launders** invention instead of
preventing it.

**L5 — Tailoring is selection over a master, not regeneration.** `requirement_kinds` already
holds `required`/`preferred`/`mentioned`. Selection structurally prevents invention, because a
variant can only contain what the master and ledger already contain. Note the left side of the
join is empty today.

**L6 — Level calibration at 4–5 years is a parameter set.** One page; roughly three roles at
5 / 4 / 2 bullets; mid-level signals (independent ownership, production delivery, debugging and
operations, system design, cross-team collaboration) with senior-stretch signals only where
true. Page-*area* share is not measurable from extracted text; bullets-per-role bands and
line-count proxies are.

**L7 — One hazard class exists because of what the profile now stores.** Date of birth
(`profile_contact.date_of_birth`), the `profile_eeo` fields, and street address must never
reach a resume payload — checked against the **stored values**, not keywords, since keyword
scanning would false-positive on a legitimate DEI-project bullet. Phone and email remain normal
contact-line content. Separately, the report cites a 2026 study finding hidden prompt-injection
material in ~1% of real resumes; an AI-operated pipeline must be able to *prove* it embeds no
hidden or instruction-like text.

**L8 — This lane is the mechanism that makes human proofreading optional.** The stated product
direction is unattended generate-and-submit. Something must replace the human read. A
deterministic lint gate, provenance tracing, and received-byte verification are that something.
Note the honest precondition: `reviewMaterialRevision` accepts any `reviewedBy` string today, so
the "human gate" being swapped out currently exists only as convention. Formalizing review
authorship is part of the work, not an afterthought.

---

## 2. Phase 0 — prove the last mile

**Upload byte-verification.** Re-hash the staged file immediately before browser attach and
compare against the render's `output_sha256`; record a submission-side verification event; and
where the destination echoes a file (applysim drills always can) compare the **received** bytes
against the render row. An unverifiable or mismatched upload is a blocker on the submission
event, not a warning.

**Structural re-check at the boundary.** Run `qpdf --check` on the file as staged for upload,
in the pinned image — the same check `render.sh` already performs, applied at the carry.

**Fix the carry itself.** The base64 injection path used for the broken `file_upload` tool is
the demonstrated corruption source and must not be used for binary attachments again.

**Document the render staging requirement.** `lib/latex-renderer.js` stages under `os.tmpdir()`
(`/var/folders/…`), which colima does not share into the VM; renders succeed on this host only
with `TMPDIR=~/.cache/jobtrack-latex-tmp`. Either stage under a shared path by default or make
the requirement explicit and fail loudly when unmet.

Rationale: renders, revisions, and manifests all exist, but the one real submission bypassed
the lane and shipped corrupt bytes. Nothing else in this plan is falsifiable until the carry is
trustworthy.

### 2.1 Implementation record — Phase 0 shipped 2026-08-05

`lib/upload-verification.js` closes the chain with two independent legs, because they fail in
different situations:

- **Digest** — `sha256(file staged for upload)` must equal the selected render's
  `output_sha256`. Requires a known expected hash; catches any corruption in the carry.
- **Structure** — `createPdfStructureInspector()` in `lib/latex-renderer.js` runs
  `qpdf --check` + `pdfinfo` + `pdftotext` in the same pinned, networkless, read-only image
  the renderer uses. Catches an unreadable file on its own terms, including the case where no
  expected hash exists. A PDF that extracts zero characters fails — that is both the drill
  signature and the ATS failure.

Verdict is `verified` / `mismatch` / `unreadable`. Observations land in
`application_upload_verification_events` (append-only, with a scope trigger requiring render,
revision, kind and application to agree). `assertUploadsVerified` gates
`recordApplicationSubmission`: every selected render needs a *current* passing staged
verification, where current means the verification's expected hash still equals the render's —
so re-rendering or re-selecting invalidates a stale pass instead of inheriting it.

CLI: `application-material expected-uploads` and
`application-material verify-uploads --resume-file … --cover-letter-file … --verified-by …`
(structural leg on by default; `--skip-structural-check` for container-free runs).

**Validated against the real artifacts**, not just fixtures:

```
drill resume (known corrupt)     -> FAIL  pages=null chars=0  | qpdf --check exited 2
drill cover letter (known good)  -> PASS  pages=1 chars=1239
v2 render (fresh)                -> PASS  pages=1 chars=2478
```

**Staging fix.** `lib/latex-renderer.js` no longer stages under `os.tmpdir()`; callers needed to
know to export `TMPDIR` or renders died as a confusing `LATEX_COMPILATION_FAILED`. Staging now
defaults to `~/.cache/jobtrack/render-staging` — under `$HOME` so colima shares it, and
deliberately **outside** the store, because the store is never bind-mounted into the renderer.
(The first attempt staged under `$JOBTRACK_HOME/tmp` and was caught by the existing
"the JobTrack store must never be mounted into the renderer" invariant.) Override with
`JOBTRACK_RENDER_TMPDIR`.

Suite green: 523 pass / 0 fail / 4 skipped.

Still open in Phase 0: retiring the base64 in-page injection carry (blocked on the browser
`file_upload` tool), and `received`-side verification against destinations that echo the file.

---

## 3. Phase 3-core, then Phase 2 — measure before changing

### 3.1 Lint gate (`lib/resume-lint.js`) — extraction and safety audits first

The renderer already runs `pdftotext -layout` and records `extracted_text_sha256`, then discards
the text with the staging directory. **Persist `document.txt` beside the PDF** (additive,
verifiable against the already-recorded sha) and add a second **raw-order** extraction pass in
the same pinned image, replicating the renderer's hardening flags — defect 3 is invisible in
`-layout` mode, so raw order is not optional.

**Extraction audit.** Name and contact first; section order preserved; every bullet recoverable
as a discrete item; no keywords split across lines; dates adjacent to their role; page count
within policy; file size < 2.5 MB; text-based; unencrypted.

**Safety audit.** No `profile_eeo` values, `date_of_birth`, or street address present — matched
against stored values, plus structural patterns for SSN-like tokens. No hidden, invisible, or
instruction-like text; extracted text ≡ payload text.

**Prose audit** (calibrate later, once real payloads exist). Banned phrases (`responsible for`,
`worked on`, `involved in`, `tasked with`, `duties included`, `utilized`,
`references available upon request`, `passionate`, `results-driven`); weak verb starts;
first-person pronouns; bullets exceeding two rendered lines; bullets-per-role bands; repeated
lead verbs; **metric-cadence monotony** (flag when >60% of bullets match the
`verb … by N% … through/using X` shape); and the report's **twice rule** — an important skill
appears once in Technical Skills and once inside a bullet that proves it.

**Cover-letter audit** (letters are freeform prose, the highest-invention surface): company and
greeting cross-check against `applications.company` — the wrong-company letter is
deterministically catchable, and the drill letter addressed a generic "Drove Hiring Team" —
plus a length band, the banned-phrase list, and fact-tracing for paragraph claims.

**Timeline audit.** Unexplained gaps over six months block until a **recorded human decision**;
they are never concealed and never silently passed.

### 3.2 Severity model and binding point

Findings do **not** originate in `lib/application-fulfillment.js` — that module is a read-only
projection over `getApplicationReadiness`. Bind instead where renders already bind: a passing
lint report for the exact render is required to approve a LaTeX revision, in the
`MATERIAL_RENDER_REQUIRED` idiom (`lib/application-materials.js`). Unresolved `error` findings
additionally surface as readiness blockers, which the fulfillment plan then reflects
automatically.

Three finding classes:

| Class | Examples | Disposition |
| --- | --- | --- |
| **Mechanical** | extraction, safety, byte identity | error, non-waivable |
| **Editorial** | prose, cadence, verb repetition | warn, or error-with-waiver |
| **Decision** | timeline gaps | blocks until a recorded human decision |

Editorial waivers and gap decisions need a home and a ceremony, modeled on
`acceptApplicationFormUncertainty` / `application_preparation_uncertainty_events`. Reports bind
to a render id in their own table; the contract is
`contracts/materials/resume-lint-report.v1.schema.json`.

### 3.3 `resume.standard.v2`

Built **after** the linter, so the scoreboard proves the fixes rather than an eyeball.
`resume.standard.v1` is frozen per the template-identity rule.

**Immutability hazard, addressed first:** `renderResumeStandardV1` depends on module-level
`texEscape`, `TIGHT_LIST_PREAMBLE`, and `itemize`. Any "improvement" to a shared helper changes
v1's expansion for some payloads without touching the v1 function. **v2 introduces its own
helpers, and golden-byte fixture tests for both v1 templates land before v2 does.**

Changes:

- `\raggedright` **plus both** `\hyphenpenalty=10000` and `\exhyphenpenalty=10000` —
  `\hyphenpenalty` alone does not stop breaks at explicit hyphens, so `content-addressed` and
  `event-driven` would still split. Fixes defect 1 and the justification anti-pattern together.
- Real text typeface via psnfss (**Charter** proposed; `helvet` the sans alternative).
- Margins 0.9in → 0.75in (report range 0.65–0.85in); body stays 10.5pt.
- Standard headings — `Technical Skills`, `Experience`, `Projects`, `Education` — set with a
  thin `\hrule`, no package dependency.
- **Grouped** skills (`Languages:` / `Backend:` / `Infrastructure:` / `AI & Data:` / `Tools:`);
  payload becomes an ordered list of `{group, items[]}`.
- Per-role `location`, and an optional one-line org context for unfamiliar companies.
- A `projects` section (name, technologies, bullets) — currently unrepresentable.
- An extraction-safe bullet glyph, **verified by the linter** rather than assumed.
- Plain-text URLs retained; `hyperref` deliberately unused, since visible URL text is the
  extraction-safe choice.
- **One page only.** Two-page support is cut from v2 (see §7).

**One-page overflow policy** (the report requires a cut order, not a shrink): drop irrelevant
roles/bullets → repetition → old details → introductory context → excess skills → coursework →
vertical spacing → margins within range. Type size is never reduced. Under unattended
generation, overflow that survives the cut order is a decision-class finding.

`cover-letter.standard.v2` receives the same typeface, margin, and ragged-right pass.

### 3.4 Implementation record — v2 shipped 2026-08-05

Decisions taken: **Charter**, **one page**. Built and measured against a real render of Cole's
content through `lib/latex-renderer.js` (pinned image, digest verified, networkless):

| Defect | v1 | v2 |
| --- | --- | --- |
| 1. Keywords split by hyphenation | `server-less`, `con-current`, `pro-cesses` | none |
| 2. Bullet glyphs extractable | 0 | 9 of 9 |
| 3. Dates isolated behind a blank line | yes | contiguous with the role line |
| 4. Skills a flat comma list | yes | 4 named groups, same 19 items |
| 5. Headings glued to prior paragraph | yes | headings on their own line |

Page count 1, US Letter, text-based, unencrypted. Full suite green (515 pass / 0 fail).

Two implementation findings worth carrying forward:

- **`\hfill` is incompatible with clean extraction.** The fill gap is wide enough that
  `pdftotext` emits the right-aligned date as its own block behind a blank line. Right-aligned
  dates are only safe if extraction is *measured*, and here it failed — v2 places dates on an
  adjacent italic meta line instead, which is contiguous in every extraction mode and keeps a
  fixed left scan column.
- **Heading macros must open in vertical mode** (`\par` first), or the heading is absorbed into
  the previous paragraph. This is invisible in the PDF and only shows up in extraction — a
  concrete instance of why §3.1's audit is the acceptance test rather than an eyeball.

The v1 templates are now pinned by golden-byte fixtures (`test/fixtures/*.golden.tex`), so any
future edit to a shared byte-producing helper fails loudly instead of silently altering a frozen
identity. v2 owns its escape and list helpers outright for the same reason.

### 3.5 Implementation record — lint gate, ledger, masters, re-drill (2026-08-19)

The remaining phases shipped as a sequence on 2026-08-19:

- **§3.1/§3.2 lint gate** (`lib/resume-lint.js`): renders persist their digest-verified
  `document.txt` beside the PDF; append-only lint reports bind to the exact render and text
  digest; approving a LaTeX revision requires a passing current report
  (`MATERIAL_LINT_REQUIRED`/`MATERIAL_LINT_FAILED`); readiness re-checks the selected render's
  latest report; a lint-version upgrade makes old passes stale. Mechanical checks are
  non-waivable errors; editorial checks warn; timeline gaps surface as decision-class warnings
  until the recorded-decision ledger exists. Raw-order extraction remains open (layout mode
  only today).
- **§4 fact ledger**: typed columns (kind/baseline/result/my_role/confidential/evidence_url +
  authorship_kind/authored_by) with fail-closed pairing rules, and
  `profile work-detail-interview` — the deterministic question walk that makes capture
  tractable. Anchors seeded for the top three roles in the store of record.
- **§6 masters**: `profile_material_masters` — append-only immutable versions, template-validated
  at write, human authorship required; surfaced in the context catalog; render lint flags
  variant bullets absent from the master (`MASTER_DIVERGENCE`, editorial until Phase 4).
- **Re-drill** (throwaway store, pinned image `sha256:dcdeb866…`, real container renders): the
  full arc — prospect → posting/research → assessment gate → two-pass context → template
  drafts → render → lint → review → select → uncertainty acceptance → package →
  `verify-uploads` (digest + structural legs) → submission fact. The gate proved itself on the
  first attempt: a 3,339-character payload rendered TWO pages
  (`PAGE_COUNT_EXCEEDS_POLICY`), and LaTeX's typographic apostrophe (U+2019) broke bullet
  containment against ASCII payloads. Fixes: density bands recalibrated against the measured
  render (floor 2,200 / ceiling 3,200 / hard 4,200 payload chars; ≤13 bullets), and a
  canonicalization pass (curly quotes, ligatures, NBSP, form feed) applied to every extraction
  comparison. The slimmed 2,633-character / 10-bullet variant rendered one page and passed with
  a single honest decision-class warning (the real 2022→2023 timeline gap).

Still open from this plan: raw-order second extraction pass, the editorial-waiver and
timeline-decision ceremonies, Phase 4 per-bullet provenance (citable ledger nodes, numeric-token
fact preservation), and the requirement→evidence coverage matrix (blocked on
`posting_skill_requirements` population).

---

## 4. Phase 1 — the fact ledger

Extend `profile_work_entry_details` with additive columns: `kind`
(context / action / decision / outcome / scale / constraint), `baseline`, `result`, `my_role`
(led / owned / designed / co-designed / implemented / contributed), `confidential`,
`evidence_url`, and — load-bearing — **`authorship_kind` / `authored_by`**, in the
`application_material_revisions` idiom. Only `human`-authored nodes are citable as bullet
evidence, and the write path for human-authored nodes carries the same posture as protected form
answers (`PROTECTED_RESPONSE_REQUIRES_HUMAN`).

Add an interview-style capture command
(`jobtrack profile work-detail interview --work-entry-id N`) that walks the report's fact-ledger
questions one at a time. Thirteen roles is not tractable by hand; this command is what makes the
long pole finishable.

**Sync coupling — do this in lockstep.** `profile_work_entry_details` is in applysim's
`PROFILE_TABLES` allowlist, and `sync-profile.mjs` hard-fails on a schema-signature mismatch
("schema mismatch between stores"). Column additions require upgrading both stores together.

Files: `lib/profile-work-details.js`, `lib/profile-normalization.js`, `bin/jobtrack.js`,
`server.js`, `test/profile-work-details.test.js`.

---

## 5. Phase 4 — provenance schema (design now), targeting joins (defer)

**Design alongside Phase 1, because schema decisions are free at 0 rows and become migrations
the moment capture starts.** The capture command must write nodes in the shape provenance will
cite.

Outline nodes are **not citable today**: `readEligibleProfileEntries` reads `profile_entries`
only, and `canonicalSourceState` pins entries/artifacts/story-uses —
`profile_work_entry_details` never enters the generation context or `profile_snapshot_json`.
Making them citable requires extending the context, the manifest snapshot, and a provenance table.

Three rules for that schema:

1. **Cite pinned content, not live rows.** Outline nodes are mutable and deletable
   (`removeWorkDetail` re-packs positions; `importWorkOutline --replace` wipes the tree). Pin a
   per-node content hash in `profile_snapshot_json` at draft time, exactly as `hashProfileEntry`
   + `MATERIAL_SOURCES_STALE` / `materialRevisionIsFresh` already do for entries, and extend
   freshness checking to them.
2. **Per-bullet provenance exists only for template revisions** (`template_payload NOT NULL`),
   addressed by JSON path (`experience[2].bullets[1]`). Freeform-LaTeX revisions remain a
   first-class lane but have no addressable bullets and are excluded from the unattended path.
3. **Fact-preservation compares numeric tokens with units**, per L4 — never digit characters.
   A digit-character subset check both passes fabrications (sources containing "2019–2023" and
   "500" admit a fabricated "95%") and fails legitimate derivations ("4x faster" from
   800ms→200ms, "three"→"3", `S3`, `P99`, `HTTP/2`). Derived values require an explicit
   human-confirmed derivation record on the provenance row.

The **coverage matrix** (requirement → evidence, absent-required → info-request) waits until
something populates `posting_skill_requirements`, which is empty in both stores.

---

## 6. Phase 5 — master, surfacing

- `profile_material_masters` — versioned master payload per kind, human-authored, in the profile
  store. (*Not* "baselines": that word already means something specific here —
  `application_material_baseline_status`, `source='baseline-policy'`.) Carrying it to applysim
  requires a coordinated addition to applysim's `PROFILE_TABLES` allowlist.
- Per-application variants produced by **selection and reordering** over the master.
- Web UI: a plain-text extraction pane beside the embedded PDF (see exactly what a parser sees)
  and a lint-findings panel.
- **Formalize reviewer identity** — a vocabulary in the `authorship_kinds` idiom distinguishing
  human review from agent self-approval. L8's swap depends on it.

---

## 7. Cut

- **Two-page support and the page-2 header.** One page is the target at 4–5 YOE; untested
  machinery must not be frozen into an immutable identity. A `v3` is cheap.
- **`profile_positioning` and its "reinforced in two sections" lint.** "Reinforced" is not
  deterministic. Keep the one-sentence thesis as authoring guidance; cut the gate.
- **Interview-prep wiring.** Model-generated questions per bullet gate nothing and depend on an
  empty ledger. Revisit after Phase 1 has content.
- **"55–65% of the page on Experience."** Not measurable from extracted text.

---

## 8. Invariants preserved

Nothing here disturbs: content sha computation, render pinning and digest verification, the
propose/review/select lanes, template-identity immutability (v1 templates continue to expand
byte-identically forever — now protected by golden-byte tests), protected-field human-authorship
rules, or the observation-sha stability of existing form bundles.

---

## 9. Sequencing

0. **Phase 0 — prove the last mile.** Upload byte-verification, structural re-check at the
   carry, retire the base64 injection path, document/fix render staging. Nothing else is
   falsifiable first.
1. **Phase 3-core — extraction + safety audits.** The linter is the acceptance test for v2.
   Building v2 first means re-verifying by eyeball, which is the thing this plan exists to end.
2. **Phase 2 — `resume.standard.v2`**, validated by the scoreboard, with v1 golden-byte tests
   landing first.
3. **Phase 1 — ledger capture, in parallel from the start** (it is the human-gated long pole),
   with authorship columns and node-hash pinning designed in from day one, and the Phase 5
   provenance schema settled alongside it.
4. **Phase 4 joins and Phase 5 masters** once the ledger has content and something populates
   `posting_skill_requirements`. Prose-audit thresholds get calibrated here, against real
   payloads.

## 10. Open decisions

1. Body typeface — **Charter** (serif, professional, ATS-safe) proposed; `helvet` the sans
   alternative.
2. Where editorial waivers and timeline-gap decisions are recorded.
3. Upload byte-verification mechanism per submission route (drill vs. real ATS, where no echo
   of the received file may be available).

---

## Appendix — review record

The draft was reviewed against the live code and schema. Adjudication of the two claims not
accepted:

- **"The baseline render does not exist; `application_material_renders` is empty."** The review
  queried `~/.jobtrack`, where this is true. The lane artifacts live in `~/.jobtrack-applysim`:
  renders 1 and 2, shas `75df1796…` / `a43195305…`, with matching managed attachments. The real
  defect was the draft citing a hash without naming its store — fixed throughout §0.
- **"The render lane is environmentally broken; zero renders exist."** Two renders were produced
  on this host. The underlying fragility is real (`os.tmpdir()` is not shared into colima and
  renders require `TMPDIR=~/.cache/jobtrack-latex-tmp`), and is carried into Phase 0 as a
  documentation/robustness item rather than a blocker.

Everything else in the review was accepted, and the corrupt-upload finding — independently
reproduced — restructured the plan around a new Phase 0.
