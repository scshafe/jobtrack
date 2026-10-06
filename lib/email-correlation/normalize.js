'use strict';

const RULE_SET = Object.freeze(require('../../contracts/email/text-normalization.v1.json'));

const EXPECTED_RULES = Object.freeze({
  ruleSetVersion: 'email-correlation-text-normalization.v1',
  unicodeNormalization: 'NFKC',
  caseFold: 'lower',
  punctuation: 'space',
  whitespace: 'collapse',
  trim: true
});

for (const [key, expected] of Object.entries(EXPECTED_RULES)) {
  if (RULE_SET[key] !== expected) {
    throw new Error(`Unsupported email-correlation normalization rule ${key}: ${JSON.stringify(RULE_SET[key])}`);
  }
}

/**
 * The cross-repository title/mention normalizer. Keep the operation order in
 * sync with contracts/email/text-normalization.v1.json and Inbox's copy:
 * NFKC, non-locale lower-case, punctuation/symbol runs to spaces, Unicode
 * whitespace collapse, trim.
 */
function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function tokenize(value) {
  const normalized = normalizeText(value);
  return normalized === '' ? [] : normalized.split(' ');
}

function tokenJaccard(left, right) {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

module.exports = {
  RULE_SET,
  normalizeCatalogText: normalizeText,
  normalizeMentionText: normalizeText,
  normalizeText,
  tokenJaccard,
  tokenize
};
