'use strict';

// The shared presentation vocabulary: the small set of marks every page uses
// to say the same thing the same way.
//
// A badge, a border and a table cell agree on what "blocked" looks like
// because they all resolve tone through toneByState. Empty states name their
// own remedy because the CLI is the only writer. Key/value blocks and chips
// are here for the same reason -- they are the vocabulary, not any one page's
// layout.
//
// Everything is server-rendered and script-free; the surface stays GET/HEAD
// only. Pinned by test/web-vocabulary.test.js.

const {
  escapeHtml,
  formatToken,
  isHttpUrl,
  renderSourceUrl
} = require('./html');

// ---------------------------------------------------------------------------
// Shared presentation vocabulary (docs/JOBTRACK_VS_MISSION_CONTROL_UI.md §5).
//
// Three helpers, one idea each. They exist because the surface grew a per-page
// vocabulary — `pill`, `pill-neutral`, `stage`, `package`, `warning` — where a
// reader had no way to learn "what does this colour mean" once and reuse it.
// Everything below is server-rendered and script-free; the surface stays
// GET/HEAD-only with the CLI as its sole writer.
// ---------------------------------------------------------------------------

/**
 * Workflow state -> tone. Mission Control's `toneByState` with one addition:
 * `ok`. MC's vocabulary is neutral/info/warning/danger because its states are
 * mostly "needs attention or not"; JobTrack's ceremony has genuine SUCCESS
 * terminals (approved, selected, verified, linked, submitted) that read wrong
 * in `info` and are the thing an operator scans for.
 *
 * Unknown states deliberately fall back to `neutral` rather than throwing: a
 * new state slug added by a migration must never break a read-only page.
 */
const STATE_TONES = new Map(Object.entries({
  // review + selection
  approved: 'ok', selected: 'ok', 'selected current': 'ok', accepted: 'ok',
  rejected: 'danger', 'changes-requested': 'warning', unreviewed: 'neutral',
  // material revision lifecycle
  'rough-draft': 'neutral', 'final-candidate': 'info', 'latest draft': 'info', stale: 'warning',
  'stale evidence': 'warning',
  // readiness + fulfilment (lib/application-fulfillment.js)
  ready: 'ok', fulfilled: 'ok', actionable: 'info', 'awaiting-human': 'warning',
  'blocked-by-dependency': 'danger', blocked: 'danger', 'optional-open': 'neutral',
  // upload verification (lib/upload-verification.js)
  verified: 'ok', mismatch: 'danger', unreadable: 'danger', pass: 'ok', fail: 'danger',
  skipped: 'neutral',
  // package + application workflow
  draft: 'neutral', submitted: 'ok', archived: 'neutral', package_ready: 'info',
  prospect: 'neutral', applied: 'info', interviewing: 'info', offer: 'ok',
  closed: 'neutral', withdrawn: 'neutral',
  // correlation
  linked: 'ok', ambiguous: 'warning', unresolved: 'warning', inert: 'neutral',
  // requiredness
  required: 'warning', preferred: 'info', optional: 'neutral', mentioned: 'neutral',
  // profile stories
  captured: 'neutral', developing: 'info', needs_review: 'warning', retired: 'neutral',
  // story use permission — `ask` is a warning because it BLOCKS an unattended run
  allow: 'ok', ask: 'warning', deny: 'danger',
  // evidence confidence
  high: 'ok', medium: 'info', low: 'warning', unverified: 'neutral',
  // strategy control plane (lib/application-strategy.js). Every `blocked-*`
  // state is a stop, so they are danger; `stale-plan` and `superseded` mean the
  // evidence moved under the plan, which needs a human but is not a failure.
  active: 'ok', completed: 'ok', issued: 'info', 'escalation-ready': 'warning',
  'accepted-awaiting-binding': 'info', 'result-recorded': 'ok',
  'blocked-dependencies': 'danger', 'blocked-plan-review': 'danger',
  'blocked-revision-required': 'danger', 'blocked-routing-policy': 'danger',
  'blocked-source-checkpoint': 'danger', 'blocked-result': 'danger',
  'stale-plan': 'warning', stale: 'warning', superseded: 'warning',
  unplanned: 'neutral', unknown: 'neutral', 'not-recorded': 'neutral',
  'declared-unverified': 'warning'
}));

function toneByState(state) {
  if (state === undefined || state === null) return 'neutral';
  const key = String(state).trim().toLowerCase();
  if (!key) return 'neutral';
  if (STATE_TONES.has(key)) return STATE_TONES.get(key);
  if (key === 'true' || key === 'yes') return 'ok';
  if (key === 'false' || key === 'no') return 'neutral';
  return 'neutral';
}

/**
 * A state badge. `state` drives BOTH the label and the colour, so the two can
 * never disagree; pass `label` only when the human wording differs from the
 * slug. `data-jt-tone` is the test contract — assert the tone, not the class.
 */
function renderBadge(state, { label = null, tone = null } = {}) {
  if (state === undefined || state === null || state === '') return '';
  const resolved = tone || toneByState(state);
  const text = label === null ? formatToken(state) : label;
  return `<span class="badge badge-${escapeHtml(resolved)}" data-jt-tone="${escapeHtml(resolved)}">${escapeHtml(text)}</span>`;
}

/**
 * Technical detail — hashes, digests, renderer pins, idempotency keys.
 *
 * The disclosure ladder: compact record -> details -> TECHNICAL details. These
 * values are load-bearing evidence and must stay present and copyable, but at
 * full weight beside a company name they compete with the content a human came
 * for. `<details>` is native, needs no script, and stays keyboard-accessible.
 */
function renderTechnicalDetails(pairs, { summary = 'Traceability and digests' } = {}) {
  const body = renderKeyValues(pairs);
  if (!body) return '';
  return `<details class="technical" data-jt-technical><summary>${escapeHtml(summary)}</summary>${body}</details>`;
}

/**
 * An empty state that names its own remedy.
 *
 * JobTrack is legitimately empty most of the time — a freshly reset store has
 * zero of nearly everything — so "no rows" is a normal reading, not an error.
 * Every empty state is therefore an opportunity to say which CLI command fills
 * it, since the CLI is the only writer.
 */
function renderEmptyState(message, command = null, { as = 'div' } = {}) {
  const hint = command ? `<p class="empty-command"><code>${escapeHtml(command)}</code></p>` : '';
  const inner = `<p class="empty-message">${escapeHtml(message)}</p>${hint}`;
  if (as === 'li') return `<li class="empty" data-jt-empty>${inner}</li>`;
  if (as === 'td') return `<td class="empty" data-jt-empty colspan="99">${inner}</td>`;
  return `<div class="empty" data-jt-empty>${inner}</div>`;
}

function renderKeyValues(pairs) {
  const fields = pairs.filter(([, value]) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0));
  if (!fields.length) return '';
  return `<div class="kv">${fields.map(([label, value]) => `<div><span class="label">${escapeHtml(label)}</span>${renderProfileValue(value)}</div>`).join('')}</div>`;
}

function renderParagraphs(pairs) {
  return pairs
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `<p class="content"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`)
    .join('');
}

function renderProfileValue(value) {
  if (Array.isArray(value)) return `<div class="tags">${value.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join('')}</div>`;
  if (isHttpUrl(value)) return renderSourceUrl(value);
  return `<span>${escapeHtml(value)}</span>`;
}

function renderChips(values) {
  const chips = values.filter((value) => value !== undefined && value !== null && value !== '');
  if (!chips.length) return '';
  return `<span class="chips">${chips.map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join('')}</span>`;
}

function renderEmptyPanel(message, command = null) {
  return renderEmptyState(message, command);
}

function renderInlineTags(tags) {
  if (!tags || !tags.length) return '';
  return `<div class="tag-row">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>`;
}

module.exports = {
  STATE_TONES,
  toneByState,
  renderBadge,
  renderTechnicalDetails,
  renderEmptyState,
  renderEmptyPanel,
  renderKeyValues,
  renderParagraphs,
  renderProfileValue,
  renderChips,
  renderInlineTags
};
