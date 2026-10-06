'use strict';

// The shared presentation vocabulary is a contract, not styling.
//
// `toneByState` is the reason a badge, a border, and a cell can agree on what
// "blocked" looks like. Pinning it here means a new workflow state added by a
// migration either gets a deliberate tone or is visibly a fallback — it cannot
// silently acquire one meaning on one page and another elsewhere.

const assert = require('node:assert/strict');
const test = require('node:test');

// These were once lifted out of server.js by regex into a vm context, because
// requiring server.js pulled in a store snapshot and a listen(). The vocabulary
// now lives in its own dependency-free module, so the test imports the real
// thing — no source-text extraction that a rename could silently defeat.
// (escapeHtml/formatToken are exercised transitively: the escaping assertions
// below go through renderBadge and renderEmptyState, which is where escaping
// actually has to hold.)
const { toneByState, renderBadge, renderEmptyState } = require('../lib/web/vocabulary');

test('every tone is one of the four documented values', () => {
  const allowed = new Set(['neutral', 'info', 'ok', 'warning', 'danger']);
  const states = [
    'approved', 'rejected', 'blocked-dependencies', 'stale-plan', 'verified', 'mismatch',
    'fulfilled', 'awaiting-human', 'linked', 'ambiguous', 'submitted', 'ask', 'high'
  ];
  for (const state of states) assert.ok(allowed.has(toneByState(state)), `${state} -> ${toneByState(state)}`);
});

test('success terminals are ok; stops are danger; human-needed is warning', () => {
  // These are the assignments a reader relies on when scanning a dense page.
  for (const state of ['approved', 'selected', 'verified', 'linked', 'submitted', 'fulfilled']) {
    assert.equal(toneByState(state), 'ok', state);
  }
  for (const state of ['rejected', 'mismatch', 'unreadable', 'blocked-dependencies', 'blocked-plan-review']) {
    assert.equal(toneByState(state), 'danger', state);
  }
  for (const state of ['awaiting-human', 'ambiguous', 'stale-plan', 'ask', 'changes-requested']) {
    assert.equal(toneByState(state), 'warning', state);
  }
});

test('an unknown state degrades to neutral rather than throwing', () => {
  // A read-only page must never 500 because a migration added a state slug.
  assert.equal(toneByState('a-state-invented-tomorrow'), 'neutral');
  assert.equal(toneByState(null), 'neutral');
  assert.equal(toneByState(undefined), 'neutral');
  assert.equal(toneByState(''), 'neutral');
});

test('badges carry the tone marker and escape their content', () => {
  const badge = renderBadge('approved');
  assert.match(badge, /data-jt-tone="ok"/);
  assert.match(badge, /class="badge badge-ok"/);
  assert.equal(renderBadge(''), '', 'an absent state renders nothing, not an empty badge');

  const hostile = renderBadge('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(hostile, /<img/, 'state text must never render as markup');
  assert.match(hostile, /&lt;img/);
});

test('an explicit tone overrides the state mapping', () => {
  assert.match(renderBadge('Senior', { label: 'Senior', tone: 'neutral' }), /data-jt-tone="neutral"/);
});

test('empty states carry the marker and name their remedy', () => {
  const empty = renderEmptyState('No packages recorded.', 'jobtrack build-package --application-id ID');
  assert.match(empty, /data-jt-empty/);
  assert.match(empty, /No packages recorded\./);
  assert.match(empty, /<code>jobtrack build-package --application-id ID<\/code>/);

  const bare = renderEmptyState('Nothing here.');
  assert.match(bare, /data-jt-empty/);
  assert.doesNotMatch(bare, /empty-command/, 'no remedy means no empty command block');

  assert.match(renderEmptyState('x', null, { as: 'li' }), /^<li class="empty"/);
  assert.match(renderEmptyState('x', null, { as: 'td' }), /^<td class="empty"/);
});

test('empty-state text and commands are escaped', () => {
  const hostile = renderEmptyState('<script>alert(1)</script>', '<script>alert(2)</script>');
  assert.doesNotMatch(hostile, /<script>/);
  assert.match(hostile, /&lt;script&gt;/);
});
