'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const PRIVATE_JOURNAL_MARKER = /(?:^|[^a-z0-9])(?:private-journal|chloe private journal)(?:$|[^a-z0-9])/i;
const PATH_FLAG_KEYS = new Set(['config', 'file', 'input', 'out', 'output', 'payload']);
const PROVENANCE_FLAG_KEYS = new Set([
  'authoredBy',
  'capturedBy',
  'generatedBy',
  'importedBy',
  'source',
  'sourceLabel',
  'sourceName'
]);

class PrivateJournalSourceError extends Error {
  constructor(detail) {
    super(`PRIVATE_JOURNAL_SOURCE_PROHIBITED: ${detail}`);
    this.name = 'PrivateJournalSourceError';
    this.code = 'PRIVATE_JOURNAL_SOURCE_PROHIBITED';
  }
}

function defaultPrivateJournalBoundaries(home = os.homedir()) {
  const openclaw = path.join(home, '.openclaw');
  return [
    path.join(openclaw, 'workspace-private-journal'),
    path.join(openclaw, 'agents', 'private-journal'),
    // Telegram ingress, media, transient delivery, and state stores are shared
    // OpenClaw runtime surfaces that can contain private-journal payloads.
    path.join(openclaw, 'state'),
    path.join(openclaw, 'telegram'),
    path.join(openclaw, 'media'),
    path.join(openclaw, 'delivery-queue'),
    path.join(openclaw, 'session-delivery-queue'),
    path.join(openclaw, 'credentials', 'telegram-private-journal.token')
  ];
}

function normalizeComparable(candidate) {
  const normalized = path.resolve(candidate).normalize('NFC');
  return process.platform === 'darwin' || process.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized;
}

function pathIsInside(candidate, boundary) {
  const normalizedCandidate = normalizeComparable(candidate);
  const normalizedBoundary = normalizeComparable(boundary);
  return normalizedCandidate === normalizedBoundary
    || normalizedCandidate.startsWith(`${normalizedBoundary}${path.sep}`);
}

function realpathIncludingMissing(candidate) {
  let cursor = path.resolve(candidate);
  const missing = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return path.resolve(candidate);
    missing.push(path.basename(cursor));
    cursor = parent;
  }
  const real = fs.realpathSync.native ? fs.realpathSync.native(cursor) : fs.realpathSync(cursor);
  return path.join(real, ...missing.reverse());
}

function expandCandidate(value, home) {
  const raw = String(value);
  if (raw === '-' || raw.length === 0) return null;
  if (raw.startsWith('file:')) {
    try {
      return fileURLToPath(raw);
    } catch {
      return raw;
    }
  }
  if (raw === '~') return home;
  if (raw.startsWith(`~${path.sep}`)) return path.join(home, raw.slice(2));
  return path.resolve(raw);
}

function assertPathNotPrivateJournalSource(value, label = 'path', options = {}) {
  if (value === undefined || value === null || value === false || value === true || value === 0) return;
  const home = options.home || os.homedir();
  const boundaries = options.boundaries || defaultPrivateJournalBoundaries(home);
  const candidate = expandCandidate(value, home);
  if (!candidate) return;

  const lexicalMatch = boundaries.find((boundary) => pathIsInside(candidate, boundary));
  if (lexicalMatch) {
    throw new PrivateJournalSourceError(`${label} is inside a protected private-journal boundary`);
  }

  const canonical = realpathIncludingMissing(candidate);
  const canonicalMatch = boundaries.find((boundary) => {
    const canonicalBoundary = realpathIncludingMissing(boundary);
    return pathIsInside(canonical, canonicalBoundary);
  });
  if (canonicalMatch) {
    throw new PrivateJournalSourceError(`${label} resolves inside a protected private-journal boundary`);
  }
}

function isPathFlag(key) {
  return PATH_FLAG_KEYS.has(key) || /(?:File|Path)$/.test(key);
}

function assertNoPrivateJournalSource(flags, options = {}) {
  for (const [key, rawValue] of Object.entries(flags || {})) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (isPathFlag(key)) {
        assertPathNotPrivateJournalSource(value, `--${key}`, options);
      }
      if (PROVENANCE_FLAG_KEYS.has(key)
          && typeof value === 'string'
          && PRIVATE_JOURNAL_MARKER.test(value)) {
        throw new PrivateJournalSourceError(`--${key} identifies the protected private journal`);
      }
      if (key === 'sourceUrl' && typeof value === 'string' && value.startsWith('file:')) {
        assertPathNotPrivateJournalSource(value, '--source-url', options);
      }
    }
  }
}

module.exports = {
  PRIVATE_JOURNAL_MARKER,
  PrivateJournalSourceError,
  assertNoPrivateJournalSource,
  assertPathNotPrivateJournalSource,
  defaultPrivateJournalBoundaries,
  pathIsInside,
  realpathIncludingMissing
};
