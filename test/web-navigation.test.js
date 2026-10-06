'use strict';

// The app shell: a pinned header, a fixed-height filter strip, and exactly one
// scrolling region.
//
// "Pinned" is asserted STRUCTURALLY rather than by reading CSS: the header is a
// sibling of the scrolling element, not a descendant of it, so it cannot scroll
// away regardless of how the stylesheet changes. The same goes for the filter
// strip. A test that merely grepped for `position:sticky` would pass even if
// the element were nested inside the scroller, where sticky does nothing useful.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { baseStyles } = require('../lib/web/styles');
const { freePort } = require('../test-support/free-port');

const root = path.join(__dirname, '..');

function makeHome(prefix) {
  const home = require('../test-support/migrated-store').createTestHome(prefix);
  fs.mkdirSync(path.join(home, 'tmp'));
  return home;
}

async function withServer(home, fn) {
  const port = await freePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db'), HOST: '127.0.0.1', PORT: String(port), TMPDIR: path.join(home, 'tmp') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 5000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
      try { await (await fetch(`${baseUrl}/profile`, { signal: AbortSignal.timeout(250) })).text(); break; }
      catch { if (Date.now() > deadline) throw new Error(`server did not start: ${stderr}`); await new Promise((r) => setTimeout(r, 50)); }
    }
    await fn(baseUrl);
  } finally {
    if (!server.killed) server.kill('SIGTERM');
    await once(server, 'exit').catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function get(url) {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

const DESTINATIONS = [
  '/applications', '/openings', '/opportunities', '/discovery-proposals',
  '/interviews', '/communications/replies', '/profile'
];

test('every destination is a persistent header button, with the wordmark as home', async () => {
  const home = makeHome('jobtrack-shell-nav-');
  await withServer(home, async (baseUrl) => {
    for (const surface of ['/', '/applications', '/profile']) {
      const page = await get(`${baseUrl}${surface}`);
      assert.equal(page.status, 200, surface);
      // The wordmark carries is-active on Home, where it is the only thing
      // naming the current surface.
      assert.match(page.text, /<a class="brand(?: is-active)?" href="\/"[^>]*>JobTrack<\/a>/, `wordmark on ${surface}`);
      for (const destination of DESTINATIONS) {
        assert.match(page.text, new RegExp(`data-jt-nav="${destination.replace(/\//g, '\\/')}"`), `${destination} on ${surface}`);
      }
    }
  });
});

test('the current destination is marked, and home is marked by nothing else', async () => {
  const home = makeHome('jobtrack-shell-active-');
  await withServer(home, async (baseUrl) => {
    for (const destination of ['/applications', '/profile', '/interviews']) {
      const page = await get(`${baseUrl}${destination}`);
      assert.match(page.text, new RegExp(`class="hbtn is-active" href="${destination}"`), destination);
      assert.equal((page.text.match(/hbtn is-active/g) || []).length, 1, `exactly one active button on ${destination}`);
    }
    // Home is the wordmark, so no nav button claims it.
    assert.doesNotMatch((await get(`${baseUrl}/`)).text, /hbtn is-active/);
    // A nested route still marks its parent destination.
    const nested = await get(`${baseUrl}/applications`);
    assert.match(nested.text, /class="hbtn is-active" href="\/applications"/);
  });
});

test('the header sits outside the scroller on EVERY page type', async () => {
  // The first cut of this shell converted only the collection renderer, so the
  // header still scrolled away on /profile and every detail page — twelve of
  // thirteen documents. Enumerate the page types rather than spot-check one.
  const home = makeHome('jobtrack-shell-pinned-');
  await withServer(home, async (baseUrl) => {
    const surfaces = ['/', '/applications', '/openings', '/opportunities',
      '/discovery-proposals', '/interviews', '/communications/replies', '/profile'];
    for (const surface of surfaces) {
      const page = (await get(`${baseUrl}${surface}`)).text;
      assert.match(page, /<body class="app-viewport">/, `${surface} is a fixed viewport`);
      const header = page.indexOf('<header class="app-header"');
      const headerEnd = page.indexOf('</header>');
      const main = page.search(/<main[^>]*class="[^"]*(?:app-main|app-doc)/);
      assert.ok(header >= 0, `${surface} has the app header`);
      assert.ok(main > 0, `${surface} has a scrolling main`);
      assert.ok(header < main, `${surface}: header precedes main`);
      assert.ok(headerEnd < main, `${surface}: header CLOSES before main opens — it is a sibling, not scrolled content`);
    }
  });
});

test('the filter strip sits outside the results scroller', async () => {
  const home = makeHome('jobtrack-shell-filters-order-');
  await withServer(home, async (baseUrl) => {
    const page = (await get(`${baseUrl}/`)).text;
    const filters = page.indexOf('data-jt-filters');
    const scroller = page.indexOf('data-jt-scroll');
    assert.ok(filters >= 0 && scroller >= 0, 'both landmarks present');
    assert.ok(filters < scroller, 'filter strip precedes the scrolling region');
    // The scroller must be the LAST region, so nothing after it can be clipped.
    assert.ok(page.indexOf('</main>') > scroller);
  });
});

test('detail pages scroll their main, not the document', () => {
  const css = baseStyles();
  assert.match(css, /main\.app-doc \{[^}]*overflow-y:auto/);
  assert.match(css, /main\.app-doc \{[^}]*min-height:0/);
  assert.match(css, /\.app-viewport \{[^}]*overflow:hidden/);
});

test('the filter strip is one fixed-height row, not a stacked panel', async () => {
  const home = makeHome('jobtrack-shell-filters-');
  await withServer(home, async (baseUrl) => {
    const page = (await get(`${baseUrl}/`)).text;
    const markup = page.replace(/<style>[\s\S]*?<\/style>/, '');
    assert.match(markup, /class="filter-strip"/);
    assert.doesNotMatch(markup, /filter-grid/, 'the stacked grid is gone');
    // Each control is its own element with no stacked caption above it: the
    // label rides in the placeholder option, which is what removes the height.
    assert.match(markup, /<select class="filter-control" name="company" aria-label="Company">/);
    assert.match(markup, /<option value="">Company: all<\/option>/);
    assert.doesNotMatch(markup, /<label class="filter-field"/, 'no caption elements above controls');
  });
});

test('table headers stick to the top of the scrolling region', () => {
  const css = baseStyles();
  assert.match(css, /\.results-region thead th \{[^}]*position:sticky/);
  // Sticky table cells lose their borders unless the table separates them.
  assert.match(css, /\.results-region table \{[^}]*border-collapse:separate/);
});

test('the mobile pass cannot change desktop rendering', () => {
  const css = baseStyles();
  const desktop = css.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
  assert.doesNotMatch(desktop, /@media/, 'all media queries stripped');
  for (const selector of ['.badge', '.empty', '.technical', '.app-header', '.filter-strip', '.results-region']) {
    assert.ok(desktop.includes(selector), `${selector} is defined outside any media query`);
  }
  assert.doesNotMatch(css, /@media\([^)]*var\(/, 'custom properties are invalid in a media condition');
});

test('the CSS block never contains a stray backtick', () => {
  // baseStyles() returns a template literal; a backtick inside it terminates
  // the string and the remaining CSS becomes executable JS. That produced a
  // 500 on every page during this layout change, so it is pinned here.
  //
  // The stylesheet now owns a whole module, so the count is asserted over the
  // WHOLE FILE rather than a regex-extracted function body: two backticks, the
  // literal's own delimiters, and nowhere else — comments included.
  const source = fs.readFileSync(path.join(root, 'lib', 'web', 'styles.js'), 'utf8');
  assert.equal((source.match(/`/g) || []).length, 2, 'exactly the opening and closing backtick');
});
