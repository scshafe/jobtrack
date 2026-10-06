'use strict';

// Row shaping shared by every collection read model.
//
// The store returns group_concat'ed columns — role_type_ids, seniority_levels,
// four separate tag columns — because one query per row would be a fan-out.
// decoratePositionRow is where those flat strings become the arrays a renderer
// can use, and where the four tag sources (application, opening, inherited,
// normalized) collapse into ONE case-insensitively deduplicated list, so a tag
// inherited from an opportunity and set on the application shows once.
//
// deriveApplicationStatus lives here rather than in SQL because it is a
// reading, not a column: an accepted offer outranks the application's own
// status field, a declined offer or a 'declined' workflow stage reads as
// rejected, and the preparation stages collapse to 'prospective'.

const { parseDate } = require('../html');

function decoratePositionRow(row) {
  return {
    ...row,
    roleTypeIds: splitIntegerList(row.role_type_ids),
    seniorityIds: splitIntegerList(row.seniority_ids),
    roleTypeLabels: splitCommaList(row.role_types),
    seniorityLabels: splitCommaList(row.seniority_levels),
    normalizedTagLabels: uniqueStrings([
      ...splitCommaList(row.normalized_tags),
      ...splitCommaList(row.application_tags),
      ...splitCommaList(row.opening_tags),
      ...splitCommaList(row.inherited_tags)
    ])
  };
}

function deriveApplicationStatus(row) {
  if (row.offer_outcome === 'accepted') return 'accepted';
  if (row.status === 'rejected' || row.workflow_stage === 'declined' || row.offer_outcome === 'declined') return 'rejected';
  if (['prospective', 'researched', 'assessment_ready', 'assessment_approved', 'letter_drafted', 'package_ready'].includes(row.workflow_stage)) return 'prospective';
  if (row.workflow_stage === 'archived') return 'archived';
  if (row.status === 'applied' && row.workflow_stage === 'submitted') return 'submitted';
  return row.status;
}

function splitIntegerList(value) {
  return splitCommaList(value).map(Number).filter(Number.isSafeInteger);
}

function splitCommaList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function uniqueStrings(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortByFreshness(rows) {
  return [...rows].sort((left, right) => {
    const leftTime = Date.parse(left.updated_at || left.created_at || '') || 0;
    const rightTime = Date.parse(right.updated_at || right.created_at || '') || 0;
    return rightTime - leftTime || Number(right.id || 0) - Number(left.id || 0);
  });
}

function sortApplications(applications, sort, dir) {
  const direction = dir === 'asc' ? 1 : -1;
  const sorted = [...applications];

  sorted.sort((left, right) => {
    const leftValue = valueForSort(left, sort);
    const rightValue = valueForSort(right, sort);
    const compared = leftValue.localeCompare(rightValue, undefined, { sensitivity: 'base' });
    if (compared !== 0) return compared * direction;
    return (right.id - left.id) * direction;
  });

  return sorted;
}

function valueForSort(application, sort) {
  if (sort === 'latest') return toSortDate(application.latest_activity_at);
  if (sort === 'workflow') return String(application.workflow_stage || '');
  if (sort === 'package') return String(application.package_status || '');
  if (sort === 'type') return String(application.item_type || 'application');
  if (sort === 'status') return String(application.derived_status || application.status || application.state || '');
  return String(application[sort] || '');
}

function toSortDate(value) {
  const date = parseDate(value);
  if (!date) return '';
  return date.toISOString();
}

function parseTags(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

module.exports = {
  decoratePositionRow,
  deriveApplicationStatus,
  splitIntegerList,
  splitCommaList,
  uniqueStrings,
  sortByFreshness,
  sortApplications,
  toSortDate,
  parseTags
};
