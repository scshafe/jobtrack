'use strict';

// HTML/text primitives for the read-only web surface.
//
// Everything here is pure: no store access, no request state, no rendering
// policy. They are the bottom of the web layer — escaping, token prettifying,
// date formatting, and the two link renderers — so every module above can
// depend on them without depending on each other.

function formatToken(value) {
  return String(value || '').replace(/_/g, ' ');
}

function renderSourceUrl(value) {
  const text = escapeHtml(value);
  if (!isHttpUrl(value)) return text;
  return `<a href="${text}" rel="noreferrer">${text}</a>`;
}

function renderRedactedSourceUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return escapeHtml(String(value || ''));
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    const redacted = url.toString();
    return `<a href="${escapeHtml(redacted)}" rel="noreferrer" referrerpolicy="no-referrer">${escapeHtml(redacted)}</a>`;
  } catch {
    return '<span class="activity">Source URL withheld</span>';
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function formatDate(value) {
  const date = parseDate(value);
  if (!date) return 'No activity yet';

  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC'
  }).format(date) + ' UTC';
}

function parseDate(value) {
  if (!value) return null;
  const normalized = String(value).includes('T') ? String(value) : `${String(value).replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  escapeHtml,
  formatToken,
  formatDate,
  parseDate,
  isHttpUrl,
  renderSourceUrl,
  renderRedactedSourceUrl
};
