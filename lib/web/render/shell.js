'use strict';

// The document shells every page is poured into.
//
// renderCollectionDocument is the app-shell layout, borrowed from mission
// control's Projects page: the DOCUMENT never scrolls. Header, toolbar and
// filter strip are fixed-height rows; the results region is the only scroller
// and takes whatever height is left. Every flex ancestor of that scroller
// carries min-height:0 — without it a flex child refuses to shrink below its
// content and the page grows a second scrollbar instead.
//
// data-jt-page and data-jt-count are the collection test contract: assert the
// surface and its result count, never the prose or the class names, so
// appearance can change without rewriting assertions.

const { escapeHtml } = require('../html');
const { baseStyles } = require('../styles');
const { appHeader } = require('../nav');

function renderCollectionDocument({ title, pageTitle, kicker, summary, count, filterForm = '', coverage = '', body, page = null }) {
  // `data-jt-page` / `data-jt-count` are the collection test contract: assert the
  // surface and its result count, not the prose or the class names. Appearance
  // can then change without rewriting assertions (which is exactly what the
  // de-redaction pass had to do when tests were coupled to rendered strings).
  const pageMarker = page ? ` data-jt-page="${escapeHtml(page)}"` : '';
  // App-shell layout (mission-control's Projects page pattern): the document
  // itself never scrolls. Header, page bar and filter strip are fixed-height
  // rows; the results region is the ONLY scroller and takes whatever height is
  // left. Every flex ancestor of that scroller carries `min-height:0`, without
  // which a flex child refuses to shrink below its content and the page grows
  // a second scrollbar instead.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(pageTitle)}</title><style>${baseStyles()}</style></head><body class="app-viewport">${appHeader()}
    <a class="skip-link" href="#content">Skip to results</a>
    <main class="app-main" id="content"${pageMarker} data-jt-count="${escapeHtml(count)}">
      <div class="toolbar">
        <h1 class="toolbar-title" title="${escapeHtml(kicker)} — ${escapeHtml(summary)}">${escapeHtml(title)}</h1>
        ${filterForm}
        <p class="result-count mono">${count} result${count === 1 ? '' : 's'}</p>
      </div>
      <div class="results-region" data-jt-scroll>${coverage}${body}</div>
    </main></body></html>`;
}

function renderMessagePage(title, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${baseStyles()}</style></head><body class="app-viewport">${appHeader()}<main class="app-doc"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/">Applications</a> · <a href="/profile">Profile</a></p></main></body></html>`;
}

module.exports = { renderCollectionDocument, renderMessagePage };
