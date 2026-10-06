'use strict';

const { normalizeMentionText, tokenize, tokenJaccard } = require('../normalize');
const { roleTitleMatchEvidence } = require('../signals');

const OPEN_STATUSES = new Set(['applied', 'interviewing', 'offer']);
const TITLE_WRAPPERS = new Set(['the', 'a', 'an', 'role', 'position', 'opening', 'job', 'posting']);

function add(ctx, applicationId, basis, confidence, reasons, identifiers = {}) {
  return ctx.addCandidate(applicationId, basis, confidence, reasons, identifiers);
}

function addEvidence(ctx, kind, value) {
  if (!value) return;
  ctx.evidence.push({ kind, value: String(value).slice(0, 500) });
}

function addRoleTitleMatchEvidence(ctx, applicationId, mention) {
  const evidence = roleTitleMatchEvidence(applicationId, mention?.referenceIndex);
  if (!evidence) return;
  if (!ctx.evidence.some((entry) => entry.kind === evidence.kind && entry.value === evidence.value)) {
    ctx.evidence.push(evidence);
  }
}

function normalizedTitlesFor(ctx, row) {
  const titles = [row.normalized_title, row.canonical_title]
    .map(normalizeMentionText).filter(Boolean);
  for (const alias of ctx.store.titleAliases(row.application_id)) {
    const normalized = normalizeMentionText(alias.normalized_alias || alias.alias);
    if (normalized) titles.push(normalized);
  }
  return [...new Set(titles)];
}

function titleSimilarity(left, right) {
  const a = contentTokens(left);
  const b = contentTokens(right);
  if (!a.length || !b.length) return 0;
  const intersection = a.filter((token) => b.includes(token)).length;
  const overlap = intersection / Math.min(a.length, b.length);
  return Math.max(tokenJaccard(a.join(' '), b.join(' ')), overlap);
}

function contentTokens(value) {
  const withoutWrappers = tokenize(value).filter((token) => !TITLE_WRAPPERS.has(token));
  return [...new Set(withoutWrappers.length ? withoutWrappers : tokenize(value))];
}

function isOpen(application) { return OPEN_STATUSES.has(application.status); }

module.exports = {
  OPEN_STATUSES,
  add,
  addEvidence,
  addRoleTitleMatchEvidence,
  isOpen,
  normalizedTitlesFor,
  titleSimilarity
};
