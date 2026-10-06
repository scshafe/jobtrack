# Resume editorial operations

Effective for new `resume.standard.v3` and `resume.standard.v4` work, September 9, 2026.
V1/v2/v3 template bytes and historical submission approvals remain unchanged. Cover letters retain
their separate v2 contract. This change does not authorize any submission.

## Generation and density

Use `resume.standard.v4` for new resumes. It is the v3 page (a real 10.5 TeX point
body, 10.4608 PDF points, 0.63in margins, compact chronological role headings, ordinary
reading order, compact education) with a template-generated header: the CLI reads the
approved profile contact record (name, email, location) and the GitHub and LinkedIn
profile links at draft and preflight time and injects them as `payload.contact`. The
worker never authors the header; a payload carrying `name`, `contactLine`, `contactLinks`
or `contact` is rejected (`TEMPLATE_CONTACT_NOT_AUTHORED`). Each link prints its visible
address (`github.com/…`, `linkedin.com/in/…`) in a dark print-safe blue and is clickable;
the same mailto/GitHub/LinkedIn URL validation as v3 applies. Phone, street address and
every other private contact field are never read. `resume.standard.v3` stays frozen and
valid for its existing revisions; its `contactLinks` accept at most one each of a mailto
address, an HTTPS GitHub profile and an HTTPS `www.linkedin.com/in/` profile, with
labels and URLs separately validated. Everything below applies to both compact templates
unless it names one.

Aim for 420–470 rendered word-like tokens on one page. This is an editorial
prototype calibrated with real 426- and 465-word two-line synthetic fixtures and a
431-word evidence-backed candidate, not an ATS standard or a universal quota.
Do not pad, invent measurements, or shrink type. Real geometry takes precedence
over a character count. V3 character advisories are provisional; the PDF supplies
the actual measurement. Keep relevant earlier jobs and engineering scope; trim
repetition, coursework, redundant projects and excess skill groups first.

Each claim needs evidence of the same scope and unit. A source reporting nine
event domains does not establish nine services or a performance improvement.
Distinguish built, designed, operated, and supervised. Substantially agent-built
projects must retain accurate human-versus-agent attribution. Missing mentoring,
Staff influence, production scale, tenure or gap explanations remain missing.

## Editorial rules from the September 9 reviews

Three independent reviews of the September 9 candidates converged on the same failure
modes. They are now render-lint errors where measurable and brief/doc rules where not:

- A bullet fills at most two rendered lines and never ends in a one-word line; two full
  lines is the target for a substantive role, one full line is acceptable for a minor one
  (the Outlier line is the standing example). `BULLET_RENDERS_THREE_LINES` and
  `BULLET_WIDOW_LINE` are mechanical errors on `resume.standard.v3`/`v4`, measured on the exact
  extraction; the fix is fewer words, never smaller type or fewer facts.
- Verbs match the source's level of ownership: built, designed, co-designed, owned, operated,
  oversaw. A fact-ledger `my_role` attested by Cole outranks an imported highlight's verb.
- Comparative goals stay comparative and stated purposes stay purposes; neither becomes an
  achieved or measured result without a source that measured it.
- Bounded facts are not habits or sequences; "designs, documents, and ships" is licensed by
  three documented designs, "writes the design documents first" is not.
- A fact carried over from a different highlight (a product name, an audience) needs its own
  source line or it is dropped.
- Real page geometry outranks the 420–470 prototype band: one page, full type size, no padding,
  no widow lines. The band is an advisory; the page is the contract.
- Education notes render inline in v3/v4 with no glyph; lint checks them as text
  (`NOTE_NOT_EXTRACTABLE`) rather than as bullets.
- A project bullet says what the project is and why it matters (the problem it solves, who
  it serves, what it changed); the `technologies` field carries the stack, so the bullet
  does not narrate how it was built unless the build itself is the point. Accurate
  human/agent attribution stays.
- On v4 the header is template-generated from the profile: lint checks that the name is
  the first extracted line and that each contact's visible address survives extraction
  (`CONTACT_LINK_LABEL_NOT_EXTRACTABLE`); URLs never appear as text.

## Review sequence

1. Read the source catalog and exact selected generation context. Select every
   professional source actually used, including any restored earlier jobs. Draft
   through the normal CLI with the selected source-state digest, current head and
   parent. Never replace an already-submitted revision or package in place.
2. Preflight the payload, then render and lint the exact revision. The pinned,
   networkless renderer and active-content protections remain mandatory.
3. Hand the resulting PDF and editorial context to a genuinely separate reviewer.
   The reviewer checks visual layout, factual support, all compound posting
   requirements, omitted history, and inherited chronology concerns.
4. Record the independent editorial decision. Only then can ordinary material
   approval and selection proceed. A policy gate checks the same requirements;
   it cannot substitute a lint pass or a legacy template for editorial review.

```sh
jobtrack application-material editorial-context --application-id 7 \
  --revision-id 14 --render-id 9 --json
jobtrack application-material editorial-review --application-id 7 \
  --revision-id 14 --render-id 9 --review-file editorial-review.json \
  --reviewed-by independent-reviewer --idempotency-key app-7-resume-editorial-v1 --json
```

`editorial-context` is a domain read. As with other CLI reads, startup may apply
schema migrations; it neither creates a review nor contacts a provider. It derives
its inputs from the revision's selected sources and ancestry, not an arbitrary
caller-supplied requirement list. `editorial-review` appends one immutable row to
`application_resume_editorial_reviews`; it does not approve/select the material,
make a package, or submit. Its file is limited to 256 KiB and passes the private
source boundary before store opening. Keep context/review artifacts private.

Review JSON schema (substitute exact IDs and findings from context):

```json
{
  "schemaVersion": "jobtrack-resume-editorial-review.v1",
  "contextSha256": "EXACT_CONTEXT_SHA256",
  "decision": "approved",
  "reviewerScope": "Independent factual, role-fit and rendered-page review",
  "notes": "Explain the overall judgment, not just checklist completion.",
  "matrix": [{
    "requirementId": "posting:31:line:12",
    "status": "partial",
    "evidence": [{"sourceId": "profile:8", "payloadPath": "experience[2].bullets[0]"}],
    "rationale": "AWS delivery work is evidenced, but the full scale requirement is not.",
    "stretchReason": "Accept only as a transparent stretch; do not claim the missing scale."
  }],
  "omissions": [{
    "findingId": "EXACT_FINDING_ID",
    "disposition": "rewritten-with-evidence-retained",
    "reason": "Name the replacement evidence and why the change improves the resume."
  }],
  "chronology": [{
    "findingId": "EXACT_GAP_FINDING_ID",
    "disposition": "unexplained-gap-retained",
    "reason": "Dates remain accurate; no unsupported explanation or continuous tenure claim."
  }]
}
```

Use `changes_requested` to block approval. Every requirement and finding must be
addressed exactly once. Status is `demonstrated`, `partial`, or `not-demonstrated`.
Demonstrated claims require a selected source ID and an existing professional
payload path; not-demonstrated requirements cannot claim supporting evidence.
Every partial/not-demonstrated result needs explicit stretch reasoning. An honest
stretch review is not a declaration that Cole meets all requirements.

Diffs include all structured ancestors, not only the immediate parent: omitted
roles, rewritten/removed bullets, changed numerical scope and lost skills. These
are prompts for judgment, not proof that a paraphrase lost meaning. Gaps over six
months and unparseable dates require disposition even when an intervening draft
already removed the older role. Dispositions do not establish unknown facts.

Actor names are an audited workflow convention, not cryptographic human identity.
The CLI rejects author/reviewer name equality, but an author must not self-review
under another name. A separate coordinator/reviewer or Cole supplies the decision;
no model is automatically invoked by this module. Unattended work holds here until
that independent review exists. Existing workers must load the new briefing/code
through their normal controlled rollout; this change does not restart them.

## Evidence and rendering gates

The context binds the selected source-state digest, complete structured ancestry,
payload, exact render ID/PDF/extraction hashes, and posting requirements. Each `profile:`
source shows the entry text followed by its citable fact-ledger nodes (human-authored,
non-confidential), the same nodes the drafter saw as `workDetails`; their content is
inside the entry's pinned digest, so a node recorded after selection makes the context
stale. The
payload must reproduce the immutable LaTeX bytes. A changed source, render,
requirement, or latest editorial decision invalidates approval/readiness. V3
readiness also includes the editorial review ID/context digest, so a new decision
changes package readiness even when both decisions approve.

The conservative requirement parser recognizes common responsibilities, required
and preferred section headings. It excludes recognized benefits/compensation and
application-form sections. A posting with no recognizable required section fails
closed; capture a faithful structured posting and regenerate rather than supplying
a smaller list. Reviewers must still read the full captured posting, including
requirements outside headings and each clause of compound requirements. The
parser is not semantic proof of complete requirement coverage.

V3 lint stores immutable `pdf_metrics_json` and its digest alongside the lint
report: exact PDF and extraction hashes/bytes/pages, word-like and whitespace
token counts, rendered lines, page bounds/bottom whitespace, transformed font
sizes, and raw-versus-layout extraction order. Body font is determined from
text-show weights for the supported fixed-renderer PDF structure; unsupported
structures fail closed. Word-like tokens contain a Unicode letter or digit;
standalone bullets/separators are excluded, hyphenated terms remain one token.
Blank space measures below the last word box, not ink coverage.

Mechanical errors remain non-waivable: safety-value checks, source/extraction
parity, active content, page overflow, minimum type, clipping, and reading order.
Density warnings require editorial judgment. The 431-word candidate still has
about 0.86in usable bottom space; filling every remaining line is not a reason to
invent claims. Stored safety values are never echoed. Common-word safety matches
remain fail-closed; use safe local synthetic fixtures to study false positives,
not protected-value exports or relaxed production checks.

## Verification and rollback

Run the focused tests on the project's ABI-compatible Node runtime:

```sh
node --test test/material-templates.test.js test/material-templates-v3.test.js test/material-templates-v4.test.js \
  test/resume-contact-block.test.js test/resume-lint.test.js \
  test/latex-renderer.test.js test/pdf-metrics.test.js \
  test/resume-editorial-review.test.js test/application-resume-editorial.test.js \
  test/application-materials.test.js test/fabric.test.js test/fabric-briefs.test.js
JOBTRACK_RUN_LATEX_CONTAINER_TESTS=1 node --test test/material-templates-v3.test.js \
  test/material-templates-v4.test.js test/latex-renderer.test.js test/resume-editorial-container.test.js
# All seven discovery/renderer container cases, serialized across files:
npm run test:containers
```

The real-container smoke uses a fresh synthetic store and no credentials. Never
use live drafts, submissions, email or an ApplySim cycle as a resume regression
test. The September 9 candidate is a standalone revision for Cole's inspection,
not a replacement selection in the submitted ApplySim application.

Rollback: retain the historical PDF/package and do not delete review rows. If v3
fails, hold new resume automation and fix forward or explicitly use a separately
reviewed legacy template through manual review. Do not weaken the renderer, pins,
safety checks or single-attempt Google transport. No installed skill, service or
daemon was changed by this resume implementation; installed skill rollout remains
subject to Skill Workshop.
