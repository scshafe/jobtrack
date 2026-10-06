# JobTrack web UI vs. Mission Control — comparison and contrast

**Date:** 2026-08-05
**Companion to:** `MISSION_CONTROL_UX_PATTERNS.md`
**Subjects:** JobTrack `server.js` (3,620 lines, server-rendered) vs. Mission Control
`web/` + `mc-ui` (React SPA)

The headline: **these are not two attempts at the same thing.** Mission Control is an operator
console for acting on a live system. JobTrack's web surface is a *read-only window onto an
append-only record*, deliberately incapable of mutation. Most differences follow from that, and
several of JobTrack's apparent deficits are correct decisions. The genuinely useful comparison
is narrower than "adopt React", and this document tries to find it.

---

## 1. Side by side

| | Mission Control | JobTrack |
| --- | --- | --- |
| Rendering | React SPA, esbuild bundle | Server-rendered HTML template strings |
| Client JS | Full Redux app | **Zero.** No `<script>`, no handlers |
| Files | 77 `.ts`/`.tsx` + 2,969-line stylesheet | One `server.js`, 172 functions |
| Styling | `mc-ui` package + theme tokens | `baseStyles()` — 12.4 KB inline, 71 classes |
| Design tokens | ~50 app + 13 `mc-ui` layout tokens | 19 tokens |
| Media queries | 14 (880/720/640/560 + reduced-motion) | 3 (mostly `max-width:760px`) |
| Navigation | 2-level: 6 workspaces × leaf tabs, with memory | 1-level: 8 flat links |
| Within-page nav | Client-side `FocusTabs` with count badges | Anchor `jump-nav` / `?section=` round-trip |
| Forms | Rich editors, confirm dialogs, toasts | **1 form** (a filter), 2 tables |
| Mutation | Full gestures + optimistic state | None — CLI is sole writer |
| Overlays | Tooltip/HoverCard/Popover/ContextMenu/Toast | None |
| Test contract | `data-mc-component` markers, frozen | 7 `data-*` attributes total |
| Accessibility | skip-link, aria-*, keyboard tab handling, reduced-motion | 22 `aria-*`, skip-link |

---

## 2. Where JobTrack is right to differ

These are not gaps. Changing them would make the product worse.

**Zero JavaScript is a security posture, not a shortcut.** The web surface is `GET`/`HEAD` only
and says so in a persistent `readonly-strip`: *"GET/HEAD only · CLI is sole writer ·
Human-final submission."* No client JS means no XSS execution sink, a trivially strict CSP, and
no possibility that a rendered email body or scraped posting — both untrusted — becomes
executable. For a system whose entire threat model includes *rendering adversarial content from
strangers*, this is the correct architecture.

**Server rendering keeps the record authoritative.** Every page is a projection of SQLite at
request time. There is no client cache to go stale, no optimistic update to diverge from the
store, and no way for the UI to display something the database does not contain.

**The absence of mutation affordances is the safety model made visible.** Mission Control's
gesture layer exists because operators act there. JobTrack's ceremony (propose → review →
select → readiness → package → submit) runs through the CLI precisely so that each step is
audited, idempotent, and content-addressed. A web button that "approves" a revision would be a
hole in that.

**Provenance display is genuinely better than Mission Control's.** JobTrack pages surface
content SHAs, source-manifest SHAs, renderer versions, authorship, and review history as
first-class content. That is domain-appropriate and Mission Control has no equivalent.

---

## 3. Where the gap is real

### 3.1 Navigation is flat and has no memory

JobTrack's `primaryNav()` is eight sibling links (Home, Applications, Openings, Opportunities,
Discovery, Interviews, Communications, Profile). Every destination is peer-ranked, and the
system now has considerably more than eight meaningful surfaces — materials, renders, questions,
fulfillment plans, stories, discovery proposals, reply lifecycle.

Mission Control's answer — group by *intent* (Attention / Work / Design / Operate), remember the
last leaf per group — costs almost nothing server-side. JobTrack could group as:

- **Pipeline** — opportunities, discovery, openings
- **Applications** — applications, materials, questions
- **Attention** — communications, replies awaiting review, information requests, gaps
- **Prepare** — interviews, stories, profile

Per-workspace memory is a cookie or a query parameter; no client framework required.

### 3.2 Within-page navigation costs a round trip

Profile sections use `?section=`, and the application workspace uses an anchor `jump-nav`. Both
work; neither preserves scroll position or gives the "3 items here" count badges that make
Mission Control's `FocusTabs` scannable. A no-JS improvement is available: CSS `:target` or a
radio-driven tab pattern gives client-side tab switching with zero script.

### 3.3 No shared tone vocabulary

JobTrack has `pill`, `pill-neutral`, `warning`, `stage`, `package`, `status` — a vocabulary that
grew per-page. Mission Control's `toneByState` is one function mapping any workflow state to
`neutral | info | warning | danger`, so a badge, a border, and a cell always agree. JobTrack has
many workflow states (revision stages, review decisions, fulfillment classifications, readiness,
correlation resolutions) and would benefit disproportionately. **This is the single highest
value-to-effort item in this document** — one function, no architecture change.

### 3.4 No disclosure ladder

JobTrack renders SHAs, manifest digests, and renderer pins inline at full weight, next to
human-meaningful content. Mission Control's `CompactRecord → Details → TechnicalDetails` ladder
is exactly the right shape for this: the hash stays present and copyable, but stops competing
with the company name. `<details>` is used once in the whole file; it could carry every
traceability block.

### 3.5 Responsive support is thin

Three media queries against Mission Control's fourteen, and the collapse strategy is mostly
"grid becomes one column." What is missing is a phone-density step below the tablet breakpoint.

**Correction (2026-08-05):** an earlier revision of this document claimed tables had
"`table-scroll` but no card-reflow." That was wrong — `@media(max-width:760px)` already
reflows every table to cards, hiding `thead` and emitting `td::before { content: attr(data-label) }`,
and the row renderers already emit `data-label` on each cell. The reflow was there before this
comparison was written.

Mission Control's discipline of confining every mobile rule inside its media query (so desktop
stays byte-identical) is the technique still worth adopting explicitly.

### 3.6 The test contract is thin

Seven `data-*` attributes across the whole surface. Mission Control treats
`data-mc-component` markers as a *frozen contract* and asserts structure rather than pixels.
JobTrack's web tests currently assert on rendered strings and class names, which is why the
de-redaction work required flipping sentinel assertions across several test files — the tests
were coupled to appearance. Marker attributes on each section/card would decouple them.

### 3.7 No empty-state design

Mission Control ships an `EmptyState` component. JobTrack emits bare sentences
("No rendered PDF recorded.", "No applications linked to this opening."). Since JobTrack is
frequently in a legitimately empty state — a fresh drill store has zero of nearly everything —
empty states are load-bearing, and each one is an opportunity to name the CLI command that
would fill it.

---

## 4. What would be a mistake to copy

**Do not port the React/Redux stack.** It buys client state management for an application with
no client state, and it costs the zero-JS security property that is currently doing real work.

**Do not adopt the `mc-ui` package as a dependency.** It is a React component library; JobTrack
emits strings. The *ideas* transfer; the code does not.

**Do not add mutation affordances to the web surface** without deciding, deliberately and
separately, that the CLI-is-sole-writer invariant should end. That is a safety-model decision,
not a UI decision, and it should not arrive as a side effect of a redesign.

---

## 5. Recommended adoption, in order

Each item is achievable inside the current server-rendered, zero-JS architecture.

1. **Tone vocabulary** — one `toneByState(state) → neutral|info|warning|danger` helper plus four
   token pairs; replace the ad-hoc pill classes. *Highest value-to-effort.*
2. **Disclosure ladder** — move SHAs, manifest digests, and renderer pins into
   `<details class="technical">` blocks. Present, copyable, no longer competing.
3. **Empty states** — a shared renderer taking (message, the CLI command that resolves it).
4. **Marker attributes** — `data-jt-section` / `data-jt-record` on sections and rows; migrate web
   tests onto them so appearance changes stop breaking tests.
5. **Two-level navigation with memory** — group the eight destinations by intent; remember the
   last leaf per group via query param or cookie.
6. **Token expansion** — adopt a spacing scale (`--space-xs…2xl`) and width clamps before any
   further colour work; JobTrack currently hard-codes pixel gaps throughout `baseStyles()`.
7. **CSS-only tabs** — `:target` or radio-driven, to remove the round trip on profile sections.
8. **Responsive pass** — table→card reflow at ≤560px, with every rule confined to its media
   query so desktop output is provably unchanged.

Items 1–4 are self-contained and could land in a single pass without touching a route. Items 5–8
change page structure and deserve their own plan.

---

## 5a. Implementation record — all eight shipped 2026-08-05

**Items 1–4** (commit `9c9833c`): `toneByState()` + `renderBadge()` at 19 call sites;
`renderTechnicalDetails()` behind a native `<details>`; `renderEmptyState()` at all 26 sites,
each naming the CLI command that fills it; and `data-jt-*` markers with the coupled web tests
migrated onto them.

**Item 6 — tokens.** A spacing scale (`--space-3xs…2xl`, 2/4/6/8/12/16/24/32px) replacing 105 px
literals. 49 substitutions were exact; 56 snapped to the nearest step — deliberate, since the
stylesheet had been using 5, 7, 9, 10, 11, 13, 14, 18, 20 and 22px interchangeably with no
rationale. 1px hairlines are never tokenised and media-query conditions keep literal px (custom
properties are not valid in a media condition).

**Item 5 — navigation.** Eight flat links became five intent groups (Home · Pipeline ·
Applications · Attention · Prepare) with a leaf row for the active group. Per-workspace memory
rides in a cookie — the only client state this surface keeps — recorded via `AsyncLocalStorage`
rather than threading request state through thirteen render functions. The cookie is
attacker-controlled input, so a remembered value is honoured **only** if it is one of that
workspace's declared leaf paths; off-site URLs, cross-workspace paths and traversal attempts all
fall back to the first leaf. Single-leaf workspaces never set a cookie at all.

**Item 7 — CSS-only tabs.** On the default view every section is already in the document, so the
tabs are `:target` hashes gated by `:has()` — instant, no round trip, still shareable URLs.
`?section=` remains for deep links and as the fallback where `:has()` is unavailable, in which
case all sections simply stay visible (the pre-tabs behaviour, never a broken page).

**Item 8 — responsive.** A phone-density step at ≤560px, plus mobile handling for the new nav
group. Desktop rendering is *provably* unchanged: stripping every media query from the stylesheet
before and after leaves byte-identical rules, and `test/web-navigation.test.js` asserts that
property so it cannot regress.

Tests: `test/web-vocabulary.test.js` (7) and `test/web-navigation.test.js` (6). Suite green at
536 pass / 0 fail / 4 skipped. No client JavaScript was added; the surface remains GET/HEAD-only
with the CLI as its sole writer.

---

## 6. The honest summary

JobTrack's web UI is not an immature version of Mission Control's. It is a **different genre**:
a read-only, zero-JS, server-rendered evidence viewer whose architecture is load-bearing for the
product's safety guarantees. Its real deficits are in *information design* — hierarchy, grouping,
disclosure, and a consistent state vocabulary — not in framework choice. Every recommendation
above is achievable without adding a single byte of client JavaScript, and doing so would
preserve the property that makes the surface trustworthy in the first place.
