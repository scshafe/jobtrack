'use strict';

// The filter toolbar: the strip above the results, and the URLs it builds.
//
// This is the RENDER half of filtering (lib/web/filters.js is the read/query
// half). It is one fixed-height row, deliberately: each control carries its
// label inside its own placeholder option ("Company: all") instead of a
// stacked caption above it, which is what keeps the strip one line tall so the
// results region keeps the height it gains. aria-label preserves the
// accessible name now that there is no visible caption element.
//
// Every link the toolbar emits goes through buildQueryUrl, so the active
// filters, sort and direction survive a sort click, a chip dismissal, or a
// profile tab — the URL is the whole state of this surface.

const { escapeHtml, formatToken } = require('./html');
const { MAX_QUERY_TEXT } = require('./filters');

function renderFilterForm({ action, filters, facets, sort, dir, positionFacets, statusOptions, stateOptions, workflowOptions }) {
  const fields = [
    `<input class="filter-control filter-search" type="search" name="q" maxlength="${MAX_QUERY_TEXT}" value="${escapeHtml(filters.q || '')}" aria-label="Search" placeholder="Search company, role, status, tag…">`
  ];
  if (positionFacets) {
    fields.push(renderSelectField('Company', 'company', facets.companies, filters.company?.value));
    fields.push(renderSelectField('Position type', 'role_type', facets.roleTypes, filters.role_type?.value));
    fields.push(renderSelectField('Position level', 'seniority', facets.seniority, filters.seniority?.value));
  }
  fields.push(renderSelectField('Tags (match all)', 'tag', facets.tags, (filters.tags || []).map((tag) => tag.value), { multiple: true }));
  if (statusOptions.length) fields.push(renderSelectField('Status', 'status', enumOptions(statusOptions), filters.status));
  if (stateOptions.length) fields.push(renderSelectField('State', 'state', enumOptions(stateOptions), filters.state));
  if (workflowOptions.length) fields.push(renderSelectField('Workflow', 'workflow', enumOptions(workflowOptions), filters.workflow));
  // One fixed-height strip, not a panel. Controls carry their label in the
  // select's own placeholder option ("All companies") instead of a stacked
  // caption above each field — that alone was costing three lines of height.
  // Anything that overflows scrolls sideways within the strip, so the region's
  // height never changes and the table keeps the space it gains.
  return `<form class="filter-bar" method="get" action="${escapeHtml(action)}" aria-label="Filter results" data-jt-filters>
    <div class="filter-strip">
      ${fields.join('')}
      <button class="hbtn hbtn-primary" type="submit">Apply</button>
      <a class="hbtn" href="${escapeHtml(action)}">Clear</a>
      ${renderActiveFacetChips(action, filters, sort, dir)}
    </div>
    <input type="hidden" name="sort" value="${escapeHtml(sort)}"><input type="hidden" name="dir" value="${escapeHtml(dir)}">${filters.section ? `<input type="hidden" name="section" value="${escapeHtml(filters.section)}">` : ''}
  </form>`;
}

function renderActiveFacetChips(action, filters, sort, dir) {
  const active = [];
  const base = { ...filters, sort, dir };
  const add = (label, overrides) => active.push(`<a class="active-filter" href="${escapeHtml(buildQueryUrl(action, base, overrides))}" aria-label="Remove ${escapeHtml(label)} filter">${escapeHtml(label)} <span aria-hidden="true">×</span></a>`);
  if (filters.q) add(`Search: ${filters.q}`, { q: null });
  if (filters.company) add(`Company: ${filters.company.label}`, { company: null });
  if (filters.role_type) add(`Type: ${filters.role_type.label}`, { role_type: null });
  if (filters.seniority) add(`Level: ${filters.seniority.label}`, { seniority: null });
  for (const tag of (filters.tags || [])) add(`Tag: ${tag.label}`, { tags: filters.tags.filter((candidate) => candidate.value !== tag.value) });
  if (filters.status) add(`Status: ${formatToken(filters.status)}`, { status: null });
  if (filters.state) add(`State: ${formatToken(filters.state)}`, { state: null });
  if (filters.workflow) add(`Workflow: ${formatToken(filters.workflow)}`, { workflow: null });
  return active.length ? `<div class="active-filters" aria-label="Active filters">${active.join('')}</div>` : '';
}

function renderSelectField(label, name, options, selected, { multiple = false } = {}) {
  const selectedValues = new Set(Array.isArray(selected) ? selected : selected ? [selected] : []);
  const optionMarkup = options.map((option) => {
    const text = `${option.namespaceLabel ? `${option.namespaceLabel}: ` : ''}${option.label}${option.count === undefined ? '' : ` (${option.count})`}`;
    return `<option value="${escapeHtml(option.value)}"${selectedValues.has(option.value) ? ' selected' : ''}>${escapeHtml(text)}</option>`;
  }).join('');
  // The label rides in the placeholder option, so the control is one line tall
  // and still self-describing. `aria-label` keeps the accessible name intact
  // now that there is no visible caption element.
  const empty = multiple ? '' : `<option value="">${escapeHtml(label)}: all</option>`;
  const size = multiple ? ' multiple size="1"' : '';
  return `<select class="filter-control" name="${escapeHtml(name)}" aria-label="${escapeHtml(label)}"${size}>${empty}${optionMarkup}</select>`;
}

function enumOptions(values) {
  return values.map((value) => ({ value, label: formatToken(value) }));
}

function buildQueryUrl(basePath, filters = {}, overrides = {}) {
  const params = new URLSearchParams();
  const merged = { ...filters, ...overrides };
  if (merged.q) params.set('q', merged.q);
  if (merged.company) params.set('company', merged.company.value || merged.company);
  for (const tag of (merged.tags || [])) params.append('tag', tag.value || tag);
  if (merged.role_type) params.set('role_type', merged.role_type.value || merged.role_type);
  if (merged.seniority) params.set('seniority', merged.seniority.value || merged.seniority);
  for (const name of ['status', 'state', 'workflow', 'sort', 'dir', 'section']) if (merged[name]) params.set(name, merged[name]);
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

function renderClassificationCoverage(facets) {
  const roleUnclassified = facets.roleTypes.find((option) => option.unclassified)?.count || 0;
  const levelUnclassified = facets.seniority.find((option) => option.unclassified)?.count || 0;
  if (!roleUnclassified && !levelUnclassified) return '';
  return `<aside class="coverage-note"><strong>Classification coverage:</strong> ${roleUnclassified} record(s) have no normalized position type; ${levelUnclassified} have no normalized position level. Use the exact “Unclassified” filters to inspect them—JobTrack never guesses from titles or legacy tags.</aside>`;
}

/** One sortable column header. Clicking the active column flips the
 *  direction; clicking any other starts it ascending. */
function renderHeader(label, key, sort, dir, basePath, filters) {
  const nextDir = sort === key && dir === 'asc' ? 'desc' : 'asc';
  const marker = sort === key ? (dir === 'asc' ? ' (asc)' : ' (desc)') : '';
  const url = buildQueryUrl(basePath, filters, { sort: key, dir: nextDir });
  return `<th scope="col"><a href="${escapeHtml(url)}">${escapeHtml(label)}${marker}</a></th>`;
}

module.exports = {
  renderFilterForm,
  renderActiveFacetChips,
  renderSelectField,
  enumOptions,
  buildQueryUrl,
  renderClassificationCoverage,
  renderHeader
};
