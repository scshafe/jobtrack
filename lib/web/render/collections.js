'use strict';

// The seven collection pages and the rows/cards they are made of.
//
// Two shapes only: a TABLE where the reader scans and compares (pipeline,
// applications) and a CARD GRID where each record needs a few lines of its own
// (openings, opportunities, discovery, interviews). Both go through
// renderCollectionDocument, so the toolbar, the result count and the single
// scrolling region behave identically everywhere.
//
// The two signal renderers carry most of the meaning per row. Both are careful
// to distinguish MISSING from UNKNOWN: a profile gap is only shown once a
// requested field is confirmed missing, and a material readiness signal
// separates "legacy, never recorded" from "workspace not initialized" from
// "blocked", because they call for completely different actions.

const { escapeHtml, formatToken, formatDate, renderSourceUrl } = require('../html');
const {
  renderBadge,
  renderEmptyPanel,
  renderInlineTags
} = require('../vocabulary');
const {
  renderFilterForm,
  renderClassificationCoverage,
  renderHeader
} = require('../toolbar');
const { renderCollectionDocument } = require('./shell');

function renderPipelinePage(context) {
  const { items, filters, facets, sort, dir } = context;
  const rows = items.map((item) => renderPipelineRow(item, true)).join('');
  return renderCollectionDocument({
    title: 'Pipeline',
    pageTitle: 'JobTrack Pipeline',
    kicker: 'complete application graph', page: "pipeline",
    summary: 'Every application plus every opportunity that has not been promoted. Promoted source opportunities appear once, as applications.',
    count: items.length,
    filterForm: renderFilterForm({ action: '/', ...context }),
    body: `<section class="card table-card" aria-label="Unified application pipeline">
      ${items.length ? `<div class="table-scroll"><table>
        <thead><tr>
          ${renderHeader('Type', 'type', sort, dir, '/', filters)}
          ${renderHeader('Company', 'company', sort, dir, '/', filters)}
          ${renderHeader('Role', 'role', sort, dir, '/', filters)}
          ${renderHeader('Status', 'status', sort, dir, '/', filters)}
          ${renderHeader('Workflow', 'workflow', sort, dir, '/', filters)}
          ${renderHeader('Latest activity', 'latest', sort, dir, '/', filters)}
        </tr></thead><tbody>${rows}</tbody>
      </table></div>` : renderEmptyPanel("No pipeline records match these filters.", "jobtrack add-prospect --company NAME --role TITLE")}
    </section>`,
    coverage: renderClassificationCoverage(facets)
  });
}

function renderApplicationsPage(context) {
  const { applications, filters, facets, sort, dir } = context;
  const rows = applications.map(renderApplicationRow).join('');
  return renderCollectionDocument({
    title: 'Applications',
    pageTitle: 'JobTrack Applications',
    kicker: 'submitted + active records', page: "applications",
    summary: 'Application-only view. The Home pipeline also includes opportunities that have not yet become applications.',
    count: applications.length,
    filterForm: renderFilterForm({ action: '/applications', ...context }),
    coverage: renderClassificationCoverage(facets),
    body: `<section class="card table-card" aria-label="Applications table">
      ${applications.length ? `<div class="table-scroll"><table>
        <thead>
          <tr>
            ${renderHeader('Company', 'company', sort, dir, '/applications', filters)}
            ${renderHeader('Role', 'role', sort, dir, '/applications', filters)}
            ${renderHeader('Status', 'status', sort, dir, '/applications', filters)}
            ${renderHeader('Workflow', 'workflow', sort, dir, '/applications', filters)}
            ${renderHeader('Package', 'package', sort, dir, '/applications', filters)}
            ${renderHeader('Latest activity', 'latest', sort, dir, '/applications', filters)}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table></div>` : renderEmptyPanel("No applications match these filters.", "jobtrack add-application --company NAME --role TITLE")}
    </section>`
  });
}

function renderApplicationRow(application) {
  return renderPipelineRow(application, false);
}

function renderPipelineRow(item, showType) {
  const isOpportunity = item.item_type === 'opportunity';
  const roleUrl = isOpportunity
    ? `/opportunities/${item.id}`
    : `/applications/${item.id}`;
  const missing = renderMissingProfileSignal(item.missing_profile);
  const materials = isOpportunity ? '' : renderMaterialReadinessSignal(item.material_readiness);
  const openingLink = !isOpportunity && item.job_opening_id
    ? `<div class="activity"><a href="/openings/${item.job_opening_id}">Opening #${escapeHtml(item.job_opening_id)}</a> · ${escapeHtml(item.posting_count || 0)} posting occurrence(s)</div>`
    : '';
  const typeCell = showType ? `<td data-label="Type"><span class="pill ${isOpportunity ? 'pill-neutral' : ''}">${escapeHtml(isOpportunity ? 'Opportunity' : 'Application')}</span></td>` : '';
  return `<tr>
    ${typeCell}
    <td data-label="Company"><strong>${escapeHtml(item.company)}</strong>${missing}${materials}</td>
    <td data-label="Role"><div><a href="${roleUrl}">${escapeHtml(item.role)}</a></div><div class="role">${escapeHtml((item.roleTypeLabels || []).join(', ') || 'Role type unclassified')} · ${escapeHtml((item.seniorityLabels || []).join(', ') || 'Level unclassified')}</div>${isOpportunity ? `<div class="activity">Source ${escapeHtml(item.source_key || item.provider || 'unknown')}</div>` : openingLink}${renderInlineTags(item.normalizedTagLabels)}</td>
    <td data-label="Status">${renderBadge(item.derived_status || item.status || item.state)}${isOpportunity ? `<div class="activity">${escapeHtml(formatToken(item.state))}</div>` : ''}</td>
    <td data-label="Workflow">${renderBadge(item.workflow_stage || 'prospective')}${item.applied_date ? `<div class="activity">Applied ${escapeHtml(item.applied_date)}</div>` : ''}</td>
    ${showType ? '' : `<td data-label="Package">${item.package_status ? `${renderBadge(item.package_status)}${item.package_updated_at ? `<div class="activity">Updated ${escapeHtml(formatDate(item.package_updated_at))}</div>` : ''}` : '<span class="activity">No package</span>'}</td>`}
    <td data-label="Latest activity"><div>${escapeHtml(formatDate(item.latest_activity_at))}</div><div class="activity">${escapeHtml(item.latest_activity_kind || 'No activity')}</div></td>
  </tr>`;
}

function renderMissingProfileSignal(summary) {
  if (!summary || !summary.has_confirmed_missing) return '';
  const confirmed = Number(summary.confirmed_missing_count) || 0;
  const blocking = Number(summary.blocking_missing_count) || 0;
  const optional = Number(summary.optional_missing_count) || 0;
  const unclassified = Math.max(0, confirmed - blocking - optional);
  if (summary.has_blocking_gap) {
    const remaining = confirmed > blocking ? ` · ${escapeHtml(confirmed - blocking)} other confirmed missing` : '';
    return `<div class="signal signal-warn" title="Required or conditional requested information is confirmed missing from the profile"><span aria-hidden="true">!</span> Profile information blocker · ${escapeHtml(blocking)} required/conditional field(s)${remaining}</div>`;
  }
  if (unclassified) {
    return `<div class="signal signal-note" title="Requested information is confirmed missing, but its requirement priority is not fully classified"><span aria-hidden="true">i</span> Profile information gap · ${escapeHtml(confirmed)} confirmed missing field(s) · ${escapeHtml(unclassified)} priority unclassified</div>`;
  }
  return `<div class="signal signal-note" title="Optional or preferred requested information is confirmed missing from the profile"><span aria-hidden="true">i</span> Profile information gap · ${escapeHtml(optional)} optional/preferred field(s)</div>`;
}

function renderMaterialReadinessSignal(readiness) {
  if (!readiness) return '';
  if (readiness.compatibility_only) {
    const hasAny = Number(readiness.resume_count || 0) + Number(readiness.cover_letter_count || 0) > 0;
    if (readiness.is_historical && !hasAny) {
      return '<div class="signal signal-note" title="This application predates normalized application-material tracking"><span aria-hidden="true">i</span> Materials legacy / not recorded</div>';
    }
    if (hasAny) {
      return '<div class="signal signal-note" title="Legacy material records exist without normalized review or current-selection state"><span aria-hidden="true">i</span> Legacy materials · review state unknown</div>';
    }
    return '<div class="signal signal-warn" title="A custom resume and cover letter are required for prospective package readiness"><span aria-hidden="true">!</span> Materials workspace not initialized</div>';
  }
  if (readiness.is_package_ready) {
    return '<div class="signal signal-good" title="All normalized application-material readiness requirements currently pass"><span aria-hidden="true">✓</span> Application materials package-ready</div>';
  }
  const blockerCount = Number(readiness.blocker_count ?? readiness.blocking_count ?? 0);
  const label = readiness.readiness_label || readiness.state || (readiness.is_draftable ? 'Draftable · review incomplete' : 'Materials preparation blocked');
  return `<div class="signal signal-warn" title="Normalized application-material readiness"><span aria-hidden="true">!</span> ${escapeHtml(formatToken(label))}${blockerCount ? ` · ${escapeHtml(blockerCount)} blocker(s)` : ''}</div>`;
}

function renderDiscoveryProposalsPage(context) {
  const { proposals, facets } = context;
  const cards = proposals.map((row) => {
    const facts = row.facts;
    const title = facts.title || (facts.candidateKind === 'funding-signal' ? 'Funding signal' : 'Unclassified lead');
    return `<article class="card">
      <p class="summary">${escapeHtml(formatToken(row.status))} · ${escapeHtml(formatToken(row.candidate_kind))} · ${row.occurrence_count} occurrence(s)</p>
      <h2><a href="/discovery-proposals/${encodeURIComponent(row.proposal_id)}">${escapeHtml(title)}</a></h2>
      <p>${escapeHtml(facts.companyName || facts.attributes?.organizationName || row.source_key)}</p>
      <p>${renderSourceUrl(facts.canonicalUrl)}</p>
      ${renderInlineTags(row.normalizedTagLabels)}
      <p class="summary">Source ${escapeHtml(row.source_key)} · parser ${escapeHtml(row.parser.name || 'unknown')} ${escapeHtml(row.parser.version || '')}</p>
    </article>`;
  }).join('');
  return renderCollectionDocument({
    title: 'Discovery proposals', pageTitle: 'JobTrack Discovery Proposals', kicker: 'review boundary', page: "discovery-proposals",
    summary: 'Untrusted public facts remain proposal-only until an explicit CLI review.', count: proposals.length,
    filterForm: renderFilterForm({ action: '/discovery-proposals', ...context }),
    coverage: renderClassificationCoverage(facets),
    body: `<section class="card-grid">${cards || renderEmptyPanel("No discovery proposals match these filters.", "jobtrack discovery run --help")}</section>`
  });
}

function renderOpeningsPage(context) {
  const { openings, facets } = context;
  const cards = openings.map((opening) => `<article class="card">
    <p class="activity">${escapeHtml(opening.company)} · normalized opening #${opening.id}</p>
    <h2><a href="/openings/${opening.id}">${escapeHtml(opening.canonical_title)}</a></h2>
    <p>${escapeHtml(opening.role_types || 'Role type not classified')} · ${escapeHtml(opening.seniority_levels || 'Seniority not classified')}</p>
    ${renderInlineTags(opening.normalizedTagLabels)}
    <p class="activity">${opening.posting_count} posting occurrence(s) · ${opening.application_count} application(s) · ${opening.skill_count} linked skill(s)</p>
  </article>`).join('');
  return renderCollectionDocument({
    title: 'Normalized openings', pageTitle: 'Normalized Job Openings', kicker: 'one requisition // many postings', page: "openings",
    summary: 'One normalized opening can have several distinct posting occurrences.', count: openings.length,
    filterForm: renderFilterForm({ action: '/openings', ...context }), coverage: renderClassificationCoverage(facets),
    body: `<section class="card-grid">${cards || renderEmptyPanel("No normalized openings match these filters.", "jobtrack catalog opening --help")}</section>`
  });
}

function renderInterviewsPage(context) {
  const { interviews, facets } = context;
  const cards = interviews.map((row) => `<article class="card">
    <div><p class="activity">${escapeHtml(row.company || 'Unknown company')} · ${escapeHtml(row.role || 'Unknown role')}</p><h2><a href="/interviews/${row.id}/prep">${escapeHtml(row.round_type_label || formatToken(row.round_type || row.round))} interview</a></h2></div>
    <p>${escapeHtml(formatDate(row.scheduled_at))} · ${escapeHtml(row.timezone || 'timezone not recorded')} · ${escapeHtml(row.format)}</p>
    <p class="activity">${escapeHtml(row.role_types || 'Role type unclassified')} · ${escapeHtml(row.seniority_levels || 'Level unclassified')}</p>
    ${renderInlineTags(row.normalizedTagLabels)}
    <p class="activity">${row.analysis_id ? `Prep v${row.analysis_version} · ${escapeHtml(row.review_status || row.analysis_status)}` : 'Prep not generated'} · ${escapeHtml(formatToken(row.scheduling_status))}</p>
  </article>`).join('');
  return renderCollectionDocument({
    title: 'Interview preparation', pageTitle: 'Interview Preparation', kicker: 'scheduled work queue', page: "interviews",
    summary: 'Scheduled interviews with immutable, evidence-bound prep revisions.', count: interviews.length,
    filterForm: renderFilterForm({ action: '/interviews', ...context }), coverage: renderClassificationCoverage(facets),
    body: `<section class="card-grid">${cards || renderEmptyPanel("No interviews match these filters.", "jobtrack log-interview --application-id ID")}</section>`
  });
}

function renderOpportunitiesPage(context) {
  const { opportunities, facets } = context;
  const cards = opportunities.map((opportunity) => {
    const score = opportunity.latest_score === null || opportunity.latest_score === undefined ? 'Unscored' : `${opportunity.latest_score}/100`;
    return `<article class="opportunity-card">
      <div class="card-head"><div><p class="kicker">${escapeHtml(opportunity.company_name)}</p><h2><a href="/opportunities/${opportunity.id}">${escapeHtml(opportunity.title)}</a></h2></div>${renderBadge(opportunity.state)}</div>
      <p>${escapeHtml(opportunity.location_text || 'Location not listed')} · ${escapeHtml(formatToken(opportunity.workplace_type || 'work mode unknown'))} · ${escapeHtml(score)}</p>
      <p class="activity">Source ${escapeHtml(opportunity.source_key || 'unknown')} · last seen ${escapeHtml(formatDate(opportunity.last_seen_at))} · ${escapeHtml(opportunity.observation_count)} observation(s)</p>
      <p class="activity">${escapeHtml(opportunity.role_types || 'Role type unclassified')} · ${escapeHtml(opportunity.seniority_levels || 'Level unclassified')}</p>
      ${renderMissingProfileSignal(opportunity.missing_profile)}
      ${renderInlineTags(opportunity.normalizedTagLabels)}
      ${opportunity.possible_duplicate_count ? `<p class="warning">${escapeHtml(opportunity.possible_duplicate_count)} possible soft duplicate(s); review before merging.</p>` : ''}
    </article>`;
  }).join('');
  return renderCollectionDocument({
    title: 'Opportunity inbox', pageTitle: 'JobTrack Opportunities', kicker: 'prospective roles', page: "opportunities",
    summary: 'Discovered roles stay separate from applications until explicitly promoted.', count: opportunities.length,
    filterForm: renderFilterForm({ action: '/opportunities', ...context }), coverage: renderClassificationCoverage(facets),
    body: `<section class="card-grid">${cards || renderEmptyPanel("No opportunities match these filters.", "jobtrack discovery query --help")}</section>`
  });
}

module.exports = {
  renderPipelinePage,
  renderApplicationsPage,
  renderDiscoveryProposalsPage,
  renderOpeningsPage,
  renderInterviewsPage,
  renderOpportunitiesPage
};
