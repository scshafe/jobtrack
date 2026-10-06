# Mission Control web UI — layout and UX pattern analysis

**Date:** 2026-08-05
**Subject:** `~/.mission-control/app/mission-control` (web client + its `mc-ui` package)
**Purpose:** establish what the Mission Control front end actually does, as the baseline for
comparing JobTrack's web surface (see `JOBTRACK_VS_MISSION_CONTROL_UI.md`).

---

## 1. What kind of application this is

A single-page React application with a hard architectural spine:

| Dimension | Value |
| --- | --- |
| Rendering | Client-side SPA; one `AppShellComponent` swaps workspace content |
| State | Redux Toolkit — thunks → slices → memoized selectors |
| Design system | `mc-ui`, a separately packaged, domain-free component library |
| Editor | TipTap (`@tiptap/*` + `tiptap-markdown`) for rich/markdown editing |
| Graph/diagram | `graphpaper` + `elkjs` (layered graph layout) |
| Icons | `iconoir-react`, injected through an `IconContext` seam |
| Build | esbuild via `mc-ui/build`'s `buildWebApp` |
| Source size | 77 `.ts`/`.tsx` files under `web/src`; 2,969-line app stylesheet |

The largest components are domain workspaces — implementation plans (1,226 lines), chat
workspace (1,046), inbox (944), project directory table (596) — which tells you where the
product's weight actually sits: **triage, planning, and conversation**, not CRUD forms.

---

## 2. The spatial model

### 2.1 Three-zone shell

```
┌──────────────┬────────────────────────────────────────────┐
│  app-sidebar │  app-shell (#app-shell-scroll)             │
│              │                                            │
│  brand       │  ┌──────────────────────────────────────┐  │
│  ─────────   │  │ FocusHeader: title · meta · actions   │  │
│  workspace   │  ├──────────────────────────────────────┤  │
│  nav items   │  │ FocusTabs: leaf tabs + count badges   │  │
│  (segmented) │  ├──────────────────────────────────────┤  │
│              │  │ Scroll: the workspace body            │  │
│  attention   │  │   (table · split rail+detail · chat)  │  │
│  panel       │  └──────────────────────────────────────┘  │
└──────────────┴────────────────────────────────────────────┘
```

The sidebar is a persistent, collapsible rail (`flex: 0 0 56px` when collapsed). The right side
is a single scroll container that every workspace renders into.

### 2.2 Two-level navigation with memory

This is the most distinctive structural decision. Navigation is **not** a flat list of pages.
`web/src/navigation/ProjectWorkspaceNavigation.ts` defines six *workspaces*, each owning a set
of *leaf tabs*:

| Workspace | Leaves |
| --- | --- |
| **Overview** | overview |
| **Attention** | inbox, approvals, reviews, consults |
| **Work** | implementation-plans, backlog, runs, dependencies |
| **Design** | architecture, components, relations, notes |
| **Collaborate** | chats, swarm |
| **Operate** | git, artifacts, events, automation |

Two consequences worth stealing:

1. **The grouping is by intent, not by entity.** "Attention" is everything demanding a human
   decision; "Operate" is everything about the running system. A user picks a *mode of work*
   first and an object second.
2. **`LastProjectLeafByWorkspace` remembers the last leaf per workspace.** Returning to
   "Attention" returns you to the leaf you were last on, not a fixed default. Navigation has
   memory, so the second visit is cheaper than the first.

Leaf ids are derived from a shared server contract (`mc-infra/project-tab-ids`) and filtered by
an explicit `REMOVED_PROJECT_LEAF_IDS` list — removed surfaces are named and dated in code
rather than silently deleted.

### 2.3 Destinations are addressable

Actions carry a structured `Destination`:

```ts
type Destination = {
  tabId: string; filter: string | null; quickView: string | null;
  recordId: string | null; focusTarget: string | null;
};
```

A card on the Overview tab can say "3 items need review" and hand you a destination that opens
the right leaf, applies the right filter, opens the right record, and focuses the right element.
Cross-surface links are data, not hand-written URLs.

---

## 3. The design system (`mc-ui`)

Explicitly layered, with import-closure rules enforced per layer:

1. **Layout primitives** — `Stack` · `Inline` · `Grid` · `Pane` · `Scroll`. Thin wrappers over
   spacing tokens; depend only on React. This is the substrate everything renders through.
2. **Generic components** — `Kbd` · `Sheet` · `PinnedDataTable` · `MarkdownEditor`.
3. **Overlay + seam layer** — `Tooltip` · `HoverCard` · `Popover` (driven by an injected
   `PopoverController`), plus leaves: `Badge` · `Description` · field components · `Identifier` ·
   `Label` · `Title` · `Copyable` · `MarkdownContent` · `EmptyState` · `List` · `Panel` · `Reader`.
4. **Pagination + format** — `InfiniteScrollSentinel`/`useInfiniteScroll`, and `mc-ui/format`
   (`toneByState` · `timestamp` · `esc` · `classToken` · `plural` · `shortRef`).
5. **Optional state layer** (`mc-ui/state`) — the Redux model as library code.

**The rule that makes it work:** *host-owned state, injected seams.* The package never knows an
endpoint, an icon set, or a popover policy. Icons arrive via `IconContext`, popovers via a
controller, table preferences via callbacks. A package that cannot reach back into its host
cannot accrete domain coupling.

The stated extraction bar for promoting an app component into the package: **two real consumers,
byte-identical render, no reverse-imports.**

### 3.1 Tokens

Two token families, deliberately small:

- **Spacing** — `--mc-space-none/xs/sm/md/lg/xl/2xl` → `0/4/8/12/16/24/32px`
- **Width clamps** — `--mc-clamp-2xs…xl` → `80/120/160/200/280/360px`

The app theme layers on colour, radius, and shadow (~50 more custom properties): a dark-first
palette (`color-scheme: dark`), semantic aliases (`--accent`, `--ok`, `--warn`, `--danger`,
`--info`), matching `*-subtle` washes for backgrounds, five radius steps, two shadows.

Everything is a token alias chain — `--border: var(--line)`, `--accent: var(--blue)` — so a
retheme happens at `:root` and the package CSS is never forked. Overriding by editing the
package is explicitly forbidden.

---

## 4. Interaction patterns

### 4.1 Progressive disclosure, three tiers

The app-level `common/` components name the disclosure ladder:

- `CompactRecord` — the dense, scannable row/card
- `Details` — expandable secondary information
- `TechnicalDetails` — hashes, ids, provenance; present but out of the way

Nothing is hidden that a user might need; the *ordering of attention* is what's designed.

### 4.2 Tables as a first-class surface

`PinnedDataTable` is the workhorse, with column pinning and user-adjustable widths persisted
through a `DataTablePreferences` slice. The philosophy is stated explicitly: **the package
observes and calls back; the host owns the state.** Same for paging —
`InfiniteScrollSentinel` fires `onLoadMore`, the host owns offset/hasMore/inFlight.

### 4.3 A shared tone vocabulary

`toneByState` maps a workflow state to one of `neutral | info | warning | danger`. Because it is
one function in the format module, a badge, a card border, and a table cell all agree on what
"blocked" looks like — and a consumer extends rather than replaces it
(`new Map([...toneByState, …])`).

### 4.4 Overlays and confirmation

A full overlay family — `Tooltip`, `HoverCard`, `Popover`, `ContextMenu`, `MoreActionsMenu`,
`ConfirmDialog`, `ToastTray`. Popovers route through a single controller so only one is open at
a time; that policy lives in one place instead of in every component.

### 4.5 Split workspaces

`SplitWorkspaceComponent` plus `CollapsibleListRail` give the rail+detail pattern: a list on the
left, the selected record on the right, rail collapsible for focus. This is how inbox, runs, and
consults all read.

---

## 5. Responsive strategy

Breakpoints: **880px** (sidebar → mobile), then 720 / 640 / 560 for phone density.

The approach is unusually disciplined and worth naming: **every mobile rule lives inside its
media query, so desktop rendering is byte-identical.** The code comments assert this repeatedly
("`is-mobile-nav-open` is a no-op on desktop — every rule keyed off it lives inside the
`@media (max-width:880px)` block, so >880px stays byte-identical").

At phone width the sidebar becomes a top bar: brand · current-surface label · hamburger. The
current-surface label is *derived* — it prefers the active project's title over a generic
"Project workspace" string, because the generic label reads poorly on a phone. That's a real
piece of mobile-specific information design, not a CSS reflow.

Touch targets are raised to a 44px minimum on mobile controls.

---

## 6. Accessibility

Present and deliberate, not retrofitted:

- A `skip-link` to `#app-shell-scroll` as the first focusable element
- `aria-label` / `aria-expanded` / `aria-controls` on the nav toggles; `aria-selected` on tabs
- `role`/`controlsId`/`focusId` carried in the *tab model itself*, so the markup can't drift
  from the semantics
- `tabIndex={-1}` on the shell so programmatic navigation can move focus
- Dedicated keyboard handling for tabs (`FocusTabsKeyboard.ts`)
- Three `prefers-reduced-motion` blocks

---

## 7. Testability as a design constraint

`data-mc-component` markers and class names are a **frozen test contract** — pinned, not
restyled. Render smoke tests "assert the marker contract, not pixels." Tests run against built
artifacts in a child process (a bundled React graph holds Node's event loop open and wedges
`node --test`), and HTTP tests bind port 0.

This is the pattern with the widest applicability: the UI has a *stable, machine-checkable
surface* that is independent of appearance, so visual change doesn't break tests and structural
regression does.

---

## 8. The doctrine in one page

From `mc-ui/docs/FRONTEND-DOCTRINE.md`, the rules that generate everything above:

- **Components never fetch and never own server state.** Data enters through condition-guarded
  thunks, lands in slices, and reaches components only via selectors.
- **No RTK Query** — adopting it is a "documented STOP-and-elevate divergence, not a local
  choice." A parallel cache with its own lifecycle vocabulary is treated as an architectural
  fork.
- **Recurring lifecycles are factory calls, not hand-rolls** — `createResourceSlice`,
  `createPagedListSlice`, `createDetailSlice`, `createRouteStateSlice`, `createPersistMiddleware`.
  Hand-write a slice only for a genuine domain state machine.
- **The store is a manifest** — `createMcStore({ slices: [...] })`, one `McProviders` at the root.
- **The library never knows your endpoints.**
- **Theme at `:root`; never fork package CSS.**

---

## 9. What is most worth borrowing

Ranked by value-to-effort for any adjacent product:

1. **Intent-based two-level navigation with per-workspace memory.** Cheap to model, immediately
   changes how a dense app feels.
2. **A shared tone vocabulary** (`toneByState`). One function; makes every surface agree.
3. **Structured destinations.** Cross-surface links become data, and "take me to the thing that
   needs me" becomes expressible.
4. **The disclosure ladder** — compact record → details → technical details. Especially apt for
   any system that shows hashes and provenance.
5. **`data-*` marker contracts** as the test surface.
6. **Two small token families** (spacing + width clamps) before any colour work.
7. **Mobile rules confined to media queries**, so the desktop rendering is provably unchanged.
