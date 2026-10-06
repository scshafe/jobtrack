# Design: mapping inbound email to applications

Status: ACTIVE ROLLOUT (2026-09-03). Owner: JobTrack (decision) with
inbox-pipeline (extraction). Supersedes the correlation notes in
`EMAIL_PIPELINE_INTEGRATION.md` §"Correlation and normalized data";
`EMAIL_LANES.md` (outgoing lanes) is unchanged.

## 1. The problem, stated realistically

Today's correlator was proven against a simulator whose every message carries
the company name, the role title and a reference code in the subject. Real
recruiter mail mostly does not. The case this design must handle first:

```
From:    Priya Natarajan <priya@acme-robotics.com>
Subject: Welcome Chat
Body:    Hi Cole, thanks for applying for Platform Engineer. I'd like to set
         up a time to chat — do you have 30 minutes this week or next?
```

Nothing in the subject identifies anything. The company is in the sender's
domain; the position is in the body; the applicant's name confirms it is
addressed to us. Variants that must also work:

- the same mail from an applicant-tracking system (`no-reply@greenhouse.io`,
  `@lever.co`, `@myworkday.com`): the domain names the ATS, not the company;
- the same mail from a recruiter's personal address (`@gmail.com`): the domain
  names nothing;
- two open applications at the same company with different titles, and the
  body naming one of them loosely ("the platform role");
- two open applications at the same company and a body that names neither
  ("thanks for applying to Acme — let's chat");
- a reply inside a thread we started, with the subject line rewritten;
- a message that is not about any application at all (a newsletter from a
  company we applied to).

Arc 4 evidence (2026-09-02): all seven company messages correlated on one
non-exact basis, "company and role" from the subject; the domain basis never
fired because `companies.website_domain` is empty for every company in the
store; the reference basis never fires because the inbox relay pins
`applicationRefs` to an empty array. In other words the proven path is the
narrow one. This design makes the broad path the default and keeps the narrow
signals as accelerators.

## 2. Principles

1. **Exact before heuristic, deterministic before model, model before agent,
   agent before asking, asking before guessing.** Each rung is cheaper and
   more auditable than the next; a message climbs only as far as it must.
2. **No silent mislink.** A link is made automatically only on an exact
   basis; every other link is made by the applicant's agent with a recorded
   reason, or confirmed by the sender's answer. Mislinks are reversible and
   retract what they taught.
3. **Learn from every confirmed link.** The first message from a company
   costs judgment; the second should not. Sender address, domain, thread,
   reference and the company's wording for a role are recorded with
   provenance and become exact or strong bases afterwards.
4. **Signals are source-grounded.** Every extracted mention points at an
   excerpt that exists verbatim in the sanitized message. A model may
   propose mentions; the extractor keeps only those it can find.
5. **Least data crosses the boundary.** Facts carry short mentions and
   excerpts, never the body. The body stays in the mailbox and is read by the
   applicant's agent at review time, as today.
6. **One vocabulary, one candidate model, one policy table.** Every basis
   produces the same candidate shape; priorities and thresholds live in one
   versioned policy, not in scattered constants.

## 3. Vocabulary

| Term | Meaning |
|---|---|
| Facts | The provider-neutral, sanitized description of one inbound message (`job-application-email-facts.v2`), produced by inbox-pipeline and delivered by the relay. |
| Signal | One extracted, source-grounded observation: a sender address, a domain, a role-title mention, a reference, a greeting name, a posting URL. |
| Sender identity | What the tracker knows about an address and a domain: which company they belong to, how it learned that, and how confident it is. |
| Candidate | One (application, basis, confidence, reasons) tuple. The single shape every basis emits (today's `addCandidate`). |
| Basis | One strategy that turns facts plus store state into candidates. Tiered exact / strong / weak. |
| Resolution | The correlator's outcome for a message: linked, ambiguous (with candidates), unmatched. |
| Decision | What the applicant's agent does with a message: link, transition, reply, clarify, none. |
| Clarification | A short question sent to the sender to learn which application a message concerns; its answer is an exact basis. |

## 4. Architecture: six stages, two owners

```
 inbox-pipeline                      JobTrack
 ┌──────────────┐   facts    ┌────────────┐  ┌────────────┐  ┌────────────┐
 │ S1 extract   │──────────▶ │ S2 identify│─▶│ S3 generate│─▶│ S4 resolve │
 │ signals      │            │ sender     │  │ candidates │  │ (policy)   │
 └──────────────┘            └────────────┘  └────────────┘  └─────┬──────┘
                                                                   ▼
                              ┌────────────┐               ┌────────────┐
                              │ S6 learn   │◀──────────────│ S5 decide  │
                              │ (registry) │  confirmed    │ agent/ask  │
                              └────────────┘               └────────────┘
```

S1 runs per message in the inbox graph. S2–S4 are pure functions over the
facts and the store (today's `correlateEmailReadOnly`, restructured). S5 is
the applicant's agent in the fabric (`email.review`), extended with one new
decision. S6 runs on every confirmed link and on every retraction.

### S1 — Extract signals (inbox-pipeline)

The facts schema already has the fields; the relay leaves them empty. S1
fills them from the sanitized text with two extractors behind one interface:

```ts
interface MentionExtractor {
  readonly name: string;                 // "deterministic.v1", "model.v1"
  extract(text: SanitizedText): Mention[]; // every Mention carries its excerpt
}
type Mention =
  | { kind: "role_title";  value: string; excerpt: string }
  | { kind: "company";     value: string; excerpt: string }
  | { kind: "reference";   namespace: string; value: string; excerpt: string }
  | { kind: "posting_url"; value: string; excerpt: string }
  | { kind: "greeting";    value: string; excerpt: string }   // "Hi Cole,"
  | { kind: "person";      value: string; role?: string; excerpt: string }; // signature
```

- **Deterministic extractor.** Patterns with named captures, each a row in
  one table (pattern, kind, namespace, confidence): `for the (.+?) (role|
  position|opening)`, `applying (?:for|to) (.+?)[.,\n]`, `(?:Application|
  Req|Requisition|Reference|Job) (?:ID|#|No\.?):?\s*([A-Z0-9-]{4,})`,
  bracketed codes `\[([A-Z]{2,6}-[0-9A-Z]{3,10})\]`, greeting lines,
  signature blocks (name + title + company on the last lines), URLs.
- **Model extractor.** A second implementation of the same interface, fed
  through `extractMentions(text, extra)`. It does NOT widen the classifier's
  output: `classified-email.v1` and its decision contracts are frozen (the
  reviewed schema digests and the adapters' `email-classification-json-
  schema.v1` response format pin them), so model-proposed mentions arrive
  through a dedicated extraction port — a separate model call with its own
  contract — in a later phase (R3). The extractor **keeps a model mention
  only if its excerpt is found in the text** (case-folded, whitespace-
  normalized). Unfound mentions are dropped and counted; they never reach
  the facts. R2 ships the deterministic extractor and the grounding seam.
- **Sender domain class.** A small config table classifies the sender domain:
  `corporate` (default), `ats` (greenhouse.io, lever.co, ashbyhq.com,
  myworkday.com, icims.com, smartrecruiters.com, jobvite.com, workable.com,
  bamboohr.com, …), `consumer` (gmail.com, outlook.com, yahoo.com, icloud.com,
  …), `unknown`. The list is data, versioned with the extractor.

Projection into facts (all additive; the schema needs one optional field):

| Signal | Facts field |
|---|---|
| role-title mentions | `postingRefs[].roleTitle` |
| reference codes | `applicationRefs[] {namespace, value}` |
| posting URLs | `postingRefs[].url` |
| company mentions (signature, body) | `company.name` (best), others as `evidence` excerpts |
| sender domain (when class = corporate) | `company.domain` |
| sender domain class | not transmitted: derived on both sides from the shared rule set (§5) |
| greeting name, person mentions | `evidence[] {field: "body", excerpt}` |

The relay stops pinning `postingRefs`/`applicationRefs`/`company` to empty.
That unfreezes two golden fixture sets (inbox and JobTrack execution
contracts); they are regenerated together in one coordinated change, with the
facts schema version bumped to `v2.1` for the one new optional field.

### S2 — Identify the sender (JobTrack)

A **sender identity registry** replaces "does the sender domain equal
`companies.website_domain`":

```
email_identity_learnings   (kind: contact|domain|title_alias, company/application, value, source message + correlation, actor, retracted_at)   -- the provenance ledger every projection hangs off
company_aliases            (alias_kind='domain' rows = learned employer mail domains; shipped in place of a separate company_domains table)
company_contacts           (company_id, name, role_title, email, source)   -- written by the email path since R1
email_domain_classes       (domain, class: corporate|ats|consumer, source)   -- seeded from the shared rule set; operator-editable
```

`identifySender(facts)` returns `{ companyIds: [...], basis, confidence }`:

1. exact contact: `fromAddress` is a known contact → its company (exact
   company, not application);
2. corporate domain: `fromDomain` is a known company domain → that company;
3. ATS domain: the company is not the domain; look at the display name
   ("Acme Robotics via Greenhouse"), signature and body company mentions,
   matched against `companies` + `company_aliases`;
4. consumer/unknown domain: same as 3, from mentions only;
5. nothing: company unknown.

Seeding: when an application is created from a posting, record the posting
host as a `website` domain only when it is not an ATS/job-board host; when a
welcome/acknowledgement is linked, record the sender as a contact and its
domain as a `mail` domain (S6).

### S3 — Generate candidates (JobTrack)

Every basis is one module implementing one interface and registered in one
list. The seven existing correlators become the first seven entries; the
candidate shape is unchanged.

```js
// lib/email-correlation/bases/<name>.js
module.exports = {
  name: 'sender_contact',
  tier: 'strong',                    // 'exact' | 'strong' | 'weak'
  run(ctx) { /* ctx.facts, ctx.identity, ctx.store, ctx.addCandidate */ }
};
```

| Basis | Tier | What it matches | Status |
|---|---|---|---|
| `clarification_reply` | exact | a reply in the thread of a clarification we sent, answering with one of the offered candidates | new |
| `provider_application_id` | exact | `applicationRefs` ↔ recorded external identifiers | exists, starved |
| `previously_linked_message` / `_thread` | exact | thread already linked | exists |
| `exact_posting_occurrence` / `exact_posting_url` | exact | posting URL in the mail | exists |
| `sender_contact` | strong | known contact address → that company's applications | new |
| `company_domain` | strong | corporate domain → company (was weak: `website_domain` only) | reworked |
| `company_mention` | strong | company name/alias in signature or body | new |
| `body_role_title` | strong within company | title mentions ↔ open applications' titles and learned aliases (normalized; token similarity ≥ threshold) | new |
| `company_and_role` | strong | subject names company and title | exists |
| `stage_consistency` | modifier | eventKind plausible for the application's status (an offer for an application still "applied" is penalized; an interview invite for one "interviewing" is boosted) | new |
| `recency` | modifier | prefer applications with activity in the last N days | new |
| `company_single_open` | strong | company identified and exactly one open application there | new |
| `fuzzy` | weak | legacy name-string similarity | exists |

Modifiers do not create candidates; they adjust confidence of existing ones.

### S4 — Resolve (JobTrack policy)

One policy revision (a row in `email_correlation_policy_revisions`, like the
fabric gate policies) holds: basis priorities, the exact set, the title
similarity threshold, the auto-link rule, the clarify rule. The resolver is a
pure function of (candidates, policy):

| Situation | Resolution | Who links |
|---|---|---|
| one application on an exact basis | `linked` | automatic when the basis is normalized (today's rule) |
| company identified, exactly one open application | `linked` with `review: true` | automatic; the agent's review is the decision step anyway |
| company identified, several open applications, one title/stage/recency winner above threshold and the runner-up below it | `ambiguous` with a preferred candidate | the agent, with the recorded reason |
| company identified, several open applications, no clear winner | `ambiguous` → **clarify** when the message expects a reply, otherwise hold for the agent | the sender's answer, or the agent |
| company unknown, mentions match one company's application | `ambiguous` (weak), re-correlated once the record identifies the sender | the agent |
| nothing | `unmatched` | human review; "possible new opportunity" path |

The policy revision id is stamped on every correlation so an outcome can be
replayed under the policy that produced it.

### S5 — Decide (the applicant's agent, fabric `email.review`)

Decisions today: link (resolve-from-agent), transition, reply, none. One new
decision, **clarify**:

- allowed only when the resolution is ambiguous with 2+ candidates in one
  company and the policy marked the message clarifiable (it expects a reply
  or it is a scheduling ask);
- the agent drafts a two-line question through the existing outgoing lane
  (draft → approve → send), naming the candidates' titles in the company's
  own wording when known: "Happy to — could you confirm which role this is
  regarding, Platform Engineer or Site Reliability Engineer?";
- the tracker records `email_clarifications (message_ref_id, candidate
  application ids, sent message id, thread id, status: pending|answered|
  expired, asked_at, answered_at)`; the inbound item stays open with
  `via: clarifying`;
- the answer arrives in the thread → basis `clarification_reply` (exact):
  the extractor's title mentions are matched against the offered candidates;
  a clear match links, anything else returns to the agent;
- expiry (policy, default 3 days) returns the item to the agent for a
  judgment call, never to silence;
- a `none` judged while the correlation was ambiguous but not clarifiable is
  provisional: a first contact from a sender nothing identifies yet cannot be
  asked, but when the record grows (a later message teaches the sender's
  contact or domain) the fabric re-correlates the message, and every
  candidate judged `none` under the poorer record is offered again under the
  new one (review work is keyed per correlation). Decisions that acted on the
  message stay final.

The brief gains one rule, mirroring the design: "if the queue entry says
`via: ambiguous` with more than one candidate and the body does not name the
role, ask — do not guess."

### S6 — Learn (JobTrack)

On every confirmed link (automatic exact link, explicit operator/agent
resolution, or approved transition applied):

- sender address → `company_contacts` (source: linked message id);
- sender domain → a `company_aliases` domain row when the class is corporate;
- thread → linked (exists);
- references → `application_external_identifiers` (exists; now fed);
- role-title mentions that matched → `application_title_aliases (application_id, alias, source)` so the company's wording ("the platform role") matches next time.

On a retraction (a link undone by the applicant or a human): every row whose
source is the retracted message is deleted in the same transaction. Provenance
is therefore mandatory on every learned row.

## 5. Contracts and compatibility

- Facts: NO schema change. The sender-domain class is DERIVED from the domain
  on both sides with one shared rule set (inbox `src/data/sender-domain-
  classes.json` ≡ jobtrack `contracts/email/sender-domain-classes.v1.json`),
  not transmitted: inbox uses it to decide whether the sender's domain may
  fill `company.domain`; JobTrack uses it to decide whether a domain may be
  learned as the company's. The relay removes the three empty pins and fills
  `company`, `postingRefs[].roleTitle|url`, `applicationRefs` and body
  evidence excerpts — fields the frozen facts.v2 has carried since 1.0.
  (Decided in R2, 2026-09-02: the earlier draft proposed a `v2.1`
  `source.fromDomainKind`; a derived class needs no contract release.)
- Correlation result: execution-contracts **1.6.0** widens the candidate
  `matchBasis` enum with `sender_contact`, `company_mention`,
  `body_role_title`, `company_single_open`, `clarification_reply` (additive;
  v1 frozen; no fixture changes). Consumers re-pinned: JobTrack manifest →
  8c9e25b, inbox dependency → `#8c9e25b`.
- Correlation result `v3`: execution-contracts **1.7.0** at `bd7e1f6` adds
  `policyRevisionId`, `identity {companyIds, basis, confidence}`,
  `preferredCandidateId?`, and `clarifiable: boolean`; v2 remains frozen.
- Storage: `email_identity_learnings`, `application_title_aliases`,
  `email_domain_classes`, `email_identity_registry_facts`,
  `email_correlation_policy_revisions`, `email_clarifications` and
  `email_link_retractions`; learned domains project into `company_aliases`;
  `company_contacts` starts being written. All additive migrations.
- CLI: `jobtrack email correlate` output gains the new fields; `jobtrack email
  clarify --message-ref-id … --candidates … --json` drafts the question through
  the outgoing lane; `jobtrack email identity …` inspects and edits the
  registry (add/retract a domain or contact by hand).

## 6. Code organization (DRY, clean, extensible)

`lib/email-integration.js` is 1,900 lines holding extraction, correlation,
persistence and proposals. The correlation half moves to:

```
lib/email-correlation/
  index.js          correlate(facts, store, policy) → result    (the only entry point)
  signals.js        facts → Signal[] (normalization, domain class lookup)
  identity.js       identifySender(signals, store) → SenderIdentity
  candidates.js     Candidate model, addCandidate, dedupe, ordering
  policy.js         load/validate a policy revision; defaults as data
  resolve.js        (candidates, identity, policy) → Resolution
  learn.js          confirmLink / retractLink (all provenance writes)
  clarify.js        openClarification / matchClarificationReply / expire
  bases/
    index.js        the ordered registry
    <one file per basis>
```

Rules that keep it clean:

- a basis reads through `ctx.store` (prepared queries in one module), never
  raw SQL scattered in strategies; it emits candidates only through
  `ctx.addCandidate`;
- text normalization (`normalizeCatalogText`, `normalizeMentionText`, domain
  normalization) lives in one `normalize.js` used by S1's counterpart in
  inbox-pipeline through a shared, published rule set (the two repos must
  normalize titles identically; the rule set is a versioned JSON both test
  against);
- priorities, thresholds and the exact set are policy data, not constants;
- every module is pure over its inputs except `learn.js`, which is the only
  writer of registry rows;
- `email-integration.js` keeps facts validation, persistence of correlations
  and proposals, and calls `correlate()`; nothing else changes shape.

## 7. Evaluation

- **Golden corpus** in `test/fixtures/email-correlation/`: realistic messages
  (the §1 case and its variants, plus arc-3/arc-4 recordings), each with the
  store state it arrives in and the expected resolution, candidates in order,
  and learned rows. The corpus is the acceptance test; every basis also has
  unit tests.
- **Metrics** from the correlation journal: automatic-link rate, agent-link
  rate, clarify rate, mislink retractions counted as distinct corrected
  messages, time-to-link. Sub-second negative latency caused by SQLite's
  whole-second timestamp truncation is zero; larger backward-clock samples are
  excluded. Reported on the JobTrack application page and in the arc logs.
- **applysim scenarios**: (a) "Welcome Chat" with no reference and a plain
  subject; (b) two roles at one company; (c) ATS sender with the company only
  in the display name; (d) consumer-domain recruiter; (e) reference-only
  subject; (f) a clarification round-trip where the company answers with the
  role. The emitter gains a "realistic" template set selected per run, so an
  arc can draw it the way it draws the time zone.

## 8. Rollout

| Phase | Delivers | Acceptance |
|---|---|---|
| R1 identity + learning — **shipped 2026-09-02** | `email_identity_learnings` ledger with provenance + retraction, `application_title_aliases`, `email_domain_classes` seeded from the rule set, learning on every confirmed link (automatic exact, explicit operator/agent resolution, or approved transition applied), `sender_contact` + `company_mention` bases, `jobtrack email identity | learnings | retract-learning | backfill-learnings` | arc-4 replay test: every message after the first link carries `sender_contact`; a second application at the same company is separated by a learned title alias |
| R2 extraction — **shipped 2026-09-02** | `src/stages/email-mentions.ts` (pattern table + grounding + projection; the model port is R3), `sender-domain-classes.ts`, proposal v2 optional fields, relay unpinned | the §1 message yields `company {name, domain}`, one `roleTitle` mention, the greeting excerpt (test/email-mentions.test.ts) |
| R3 bases + policy — **shipped 2026-09-03** | §6 registry of bases, immutable policy revisions, pure resolver, correlation result v3 (execution-contracts 1.7.0), shared normalization rules, dedicated default-off local-model mention contract and grounded extraction port, strict golden/arc corpus | 732-test JobTrack suite (728 pass, 4 opt-in skips), 1,197-test Inbox suite (1,153 pass, 44 environment/opt-in skips), and the 129-test disposable-Postgres gate green; exact corpus projections prove candidate order and causal learning; archived arc-4 messages resolve on strong or exact bases, never subject-only; Inbox `d4e0aef` is deployed with migration 21 exact, the feature flag off, stable health, deterministic message-bound normalization of recognized `gog` wrappers, and durable `import-facts → correlate → record-correlation` relay ordering |
| R4 clarify — **shipped 2026-09-03** | agent-only clarification decision, immutable question/candidate rows, one-question outgoing-v2 draft, exact thread-linked answer basis restricted to sent, unexpired questions and newer replies, 3-day expiry with no second nudge, CLI surface, and a safe Gmail new-thread fallback when a provider cannot preserve the source thread. Follow-up (review, 2026-09-03): the provider-thread arm and the conversation-reference arm now share one answer window — the source time compares at the provider's precision (Gmail is minute-granular) and the answer must be durably imported after the question — because both live proofs had bound through the reference arm. Proven live 2026-09-03 21:56Z (scenario g): a token-free company answer, stamped by Gmail's minute clock before the ask, bound through the provider thread on exact `clarification_reply` | unattended simulated round-trip, timing-boundary, and adversarial-reference tests green; live Gmail answer messageRef 3 produced correlation 6, linked application 1 on exact `clarification_reply` at 1.00, marked clarification 1 answered exactly once, and replayed idempotently |
| R5 realistic simulation — **implementation shipped 2026-09-03; live acceptance incomplete** | versioned company profiles, multi-run registry plus compatibility alias, one IMAP connection per physical mailbox, reference/thread reply routing, realistic per-run templates and pinned variants, and application-scoped ambiguous-message work/handling keys | Scenarios (a), (b), (e), and (f), including clean Stage 2, passed live with one ingest per application, application-scoped handling, one signed clarification, one role-naming answer, exact `clarification_reply`, no duplicate proposal, no wrong link, and no second nudge. Stage 1 scenarios (c)/(d) are blocked on an operator-supplied second provisioned company mailbox, not a code failure. Scenario (g), the answer bound by provider thread rather than by an echoed reference, passed on the welcome thread on 2026-09-03 (applysim campaign log) |

R1–R3 preserved the simulator's existing linking behavior. R4 introduced the
first user-visible clarification path. R5's implementation and same-sender
Stage 2 acceptance have landed; its live matrix remains open only for the
externally provisioned Stage 1 mailbox and scenarios (c)/(d).

## 9. Operator decisions

1. Clarification is one question signed as the applicant, expires after three
   days, and is never nudged a second time. The policy document has no switch
   for a second nudge: the never-read `clarify.secondNudge` key was removed on
   2026-09-05 (document version v2; revisions stored under v1 stay loadable as
   written). Recorded as DECISIONS.md D-031.
2. A company with exactly one open application may auto-link with review.
3. ATS and consumer-domain lists are repo-seeded and console-editable, with
   provenance preserved for either source.
