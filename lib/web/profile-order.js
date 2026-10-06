'use strict';

// Profile ordering: newest first, within the curation the operator already set.
//
// The store holds FOUR date shapes because each capture path chose its own —
// "Feb 2026" (work), a bare "2015" (education), "2026-05" (projects), and ISO
// datetimes (created_at/updated_at). Comparing those as STRINGS sorts by month
// name, which is how an early cut of this put Jan 2014 above Jun 2021; the
// whole point of the module is that they all reduce to one comparable number.
//
// Pinned by test/profile-ordering.test.js.

const { compareCuration } = require('../profile-presentation');

/**
 * The date a profile entry should sort by: the most recent moment it describes.
 *
 * Each structured kind keeps its own vocabulary — a job has start/end, a talk
 * has published_at, a certificate has issued_at — so the ordering has to read
 * whichever the entry actually carries. An ongoing role ('present') outranks
 * every finished one, which is why it maps to a sentinel rather than to today's
 * date: it must stay first without depending on when the page is rendered.
 * Entries with no date of their own (skills, links, answers) fall back to when
 * the record was last touched, so a section is never arbitrarily ordered.
 */
const PROFILE_ONGOING = Number.MAX_SAFE_INTEGER;
const PROFILE_MONTHS = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
});

/**
 * Parse any date shape the profile store actually holds into one comparable
 * number (YYYYMMDD).
 *
 * FOUR formats coexist because each capture path chose its own: work entries
 * hold "Feb 2026", education holds a bare "2015", projects hold "2026-05", and
 * every table's created_at/updated_at is an ISO datetime. Comparing those as
 * strings sorts by month NAME — which is how the first cut of this put Jan 2014
 * above Jun 2021. Unparseable or absent dates return 0 and fall to the bottom
 * rather than throwing.
 */
function profileDateValue(raw) {
  if (raw === PROFILE_ONGOING) return PROFILE_ONGOING;
  const text = String(raw ?? '').trim();
  if (!text) return 0;
  let found = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/.exec(text);
  if (found) return (Number(found[1]) * 10000) + (Number(found[2]) * 100) + Number(found[3] || 1);
  found = /^([A-Za-z]{3,})\s+(\d{4})$/.exec(text);
  if (found) {
    const month = PROFILE_MONTHS[found[1].slice(0, 3).toLowerCase()];
    if (month) return (Number(found[2]) * 10000) + (month * 100) + 1;
  }
  found = /^(\d{4})$/.exec(text);
  if (found) return (Number(found[1]) * 10000) + 101;
  return 0;
}

/**
 * The moment an entry should sort by: the most recent one it describes. An
 * ongoing role outranks every finished one via a sentinel rather than today's
 * date, so the order does not depend on when the page was rendered.
 */
function profileEntrySortKey(entry) {
  const pick = (...values) => values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') ?? null;
  const span = (record) => {
    if (!record) return null;
    if (record.is_present) return PROFILE_ONGOING;
    return pick(record.end_date, record.start_date);
  };
  const candidate = pick(
    span(entry.work),
    // Education records a graduation year separately from its span; it is the
    // later fact when both exist.
    entry.education ? pick(entry.education.end_date, entry.education.graduation_year, entry.education.start_date) : null,
    span(entry.project),
    span(entry.volunteer),
    entry.publication?.published_at,
    entry.credential?.issued_at,
    entry.recognition?.awarded_at,
    entry.updated_at,
    entry.created_at
  );
  return profileDateValue(candidate);
}

/** Newest first by an explicit key selector; ties break on id. */
function sortProfileRecordsDesc(records, keyOf) {
  return [...records].sort((a, b) => {
    const left = profileDateValue(keyOf(a));
    const right = profileDateValue(keyOf(b));
    if (left !== right) return right - left;
    return Number(b.id || 0) - Number(a.id || 0);
  });
}

/** Newest first; ties break on id so the order is stable across renders. */
/**
 * Newest first — but WITHIN the curation the operator already set.
 *
 * `jobtrack profile set-display` pins, hides, and orders entries, which is a
 * deliberate statement about importance that chronology must not overrule.
 * Curation therefore comes first (shared with `compareDisplay` via
 * `compareCuration`, so the rules exist once), and the date an entry DESCRIBES
 * breaks the remaining ties. An uncurated store — every entry 'visible' with no
 * explicit order — is purely reverse-chronological, which is the common case.
 */
function sortProfileEntriesDesc(entries) {
  return [...entries].sort((a, b) => {
    const byCuration = compareCuration(a, b);
    if (byCuration) return byCuration;
    const dateA = profileEntrySortKey(a);
    const dateB = profileEntrySortKey(b);
    if (dateA !== dateB) return dateB - dateA;
    return Number(b.id || 0) - Number(a.id || 0);
  });
}

module.exports = {
  PROFILE_ONGOING,
  PROFILE_MONTHS,
  profileDateValue,
  profileEntrySortKey,
  sortProfileRecordsDesc,
  sortProfileEntriesDesc
};
