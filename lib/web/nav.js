'use strict';

// Navigation: the destination list, the per-request active-path state, and the
// pinned application header (docs/JOBTRACK_VS_MISSION_CONTROL_UI.md §5).
//
// Every destination is a header button, always present. An earlier cut grouped
// them two-level (workspaces plus a remembered leaf row, with the memory kept
// in a cookie) and that is gone at Cole's direction: with this few
// destinations a group is an extra click and a thing to learn, and "where is
// X" should never require knowing which bucket X lives in. Nothing is hidden,
// so there is nothing to remember, so the cookie went too — which is also why
// this surface sets no cookies at all.
//
// The per-request active path travels via AsyncLocalStorage rather than being
// threaded through thirteen render functions or parked in a module global:
// appHeader() is called from deep inside renderers that have no request in
// hand, and a module global would leak one request's state into another's.

const { AsyncLocalStorage } = require('node:async_hooks');
const { escapeHtml } = require('./html');

const NAV_DESTINATIONS = [
  { path: '/applications', label: 'Applications' },
  { path: '/openings', label: 'Openings' },
  { path: '/opportunities', label: 'Opportunities' },
  { path: '/discovery-proposals', label: 'Discovery' },
  { path: '/interviews', label: 'Interviews' },
  { path: '/communications/replies', label: 'Communications' },
  { path: '/profile', label: 'Profile' }
];

const navContext = new AsyncLocalStorage();

/** Longest-prefix match, so /applications/12/materials still marks Applications. */
function activeNavPath(pathname) {
  let best = null;
  for (const item of NAV_DESTINATIONS) {
    const exact = item.path === pathname;
    const prefixed = pathname.startsWith(`${item.path}/`);
    if (!exact && !prefixed) continue;
    if (!best || item.path.length > best.length) best = item.path;
  }
  return best;
}

/** Express middleware: bind the nav state for the duration of one request. */
function navMiddleware(req, _res, next) {
  const pathname = req.path || '/';
  navContext.run({ pathname, activePath: activeNavPath(pathname) }, next);
}

/**
 * The application header: wordmark (home) on the left, every destination as a
 * persistent button on the right. Pinned — it is a sibling of the scrolling
 * region, not inside it, so it cannot scroll away.
 */
function appHeader() {
  const activePath = navContext.getStore()?.activePath ?? null;
  const buttons = NAV_DESTINATIONS.map((item) => {
    const isActive = item.path === activePath;
    return `<a class="hbtn${isActive ? ' is-active' : ''}" href="${escapeHtml(item.path)}"`
      + ` data-jt-nav="${escapeHtml(item.path)}"${isActive ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a>`;
  }).join('');
  // The wordmark doubles as Home, so it carries the active mark there — with
  // the page titles gone, the header is the only thing saying where you are.
  const atHome = (navContext.getStore()?.pathname ?? null) === '/';
  return `<header class="app-header" data-jt-header>
    <a class="brand${atHome ? ' is-active' : ''}" href="/" data-jt-nav="/"${atHome ? ' aria-current="page"' : ''}>JobTrack</a>
    <span class="header-note" title="GET/HEAD only — the CLI is the sole writer">read-only</span>
    <nav class="header-nav" aria-label="Primary">${buttons}</nav>
  </header>`;
}

// Retained name: thirteen document renderers call this, and detail pages want
// the same header. The header is now emitted at the document shell level, so
// this returns nothing for pages that have been migrated to the app shell.
function primaryNav() {
  return '';
}

module.exports = {
  NAV_DESTINATIONS,
  navContext,
  activeNavPath,
  navMiddleware,
  appHeader,
  primaryNav
};
