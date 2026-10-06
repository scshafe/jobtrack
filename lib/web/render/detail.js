'use strict';

// Single-record detail pages: a normalized opening, a discovered opportunity,
// an untrusted discovery proposal, an interview prep revision, and a story.
//
// Each renders its own document rather than the collection shell, because each
// wants a layout the results scroller cannot give it. What they share is a
// posture: they display captured evidence as INERT ESCAPED TEXT with its
// provenance beside it — source key, parser and version, observation digest,
// fetch time — so a reader can always tell what was observed from what was
// derived. Untrusted posting prose is truncated rather than trusted, and the
// truncation is stated in the output.

const { escapeHtml, formatToken, formatDate, renderSourceUrl } = require('../html');
const { baseStyles } = require('../styles');
const { appHeader, primaryNav } = require('../nav');
const { renderBadge, renderEmptyState } = require('../vocabulary');

function renderDiscoveryProposalPage(model) {
  const facts = model.facts;
  const occurrences = model.occurrences.map((occurrence) => {
    const evidence = occurrence.evidence.map((item) => `<li>${escapeHtml(formatToken(item.evidence_kind))} · ${renderSourceUrl(item.url)}<br><code>${escapeHtml(item.binding_sha256)}</code></li>`).join('');
    return `<article class="card"><h2>${escapeHtml(occurrence.observation_id)}</h2><p class="summary">Observed ${escapeHtml(formatDate(occurrence.observed_at))} · run ${escapeHtml(occurrence.run_id)} · ${escapeHtml(occurrence.plugin_id)} ${escapeHtml(occurrence.plugin_version)}</p><ul>${evidence}</ul></article>`;
  }).join('');
  const decision = model.status === 'pending'
    ? '<p>Pending explicit CLI review.</p>'
    : `<p><strong>${escapeHtml(formatToken(model.status))}</strong> by ${escapeHtml(model.decided_by)} on ${escapeHtml(formatDate(model.decided_at))}</p><p>${escapeHtml(model.rationale)}</p>`;
  const description = String(facts.descriptionText || '').slice(0, 20_000);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Discovery proposal</title><style>${baseStyles()}.stack{display:grid;gap:14px}.description{white-space:pre-wrap;line-height:1.55}code{overflow-wrap:anywhere}</style></head><body class="app-viewport">${appHeader()}<main class="app-doc"><header><div><p class="summary"><a href="/discovery-proposals">← Discovery proposals</a></p><h1>${escapeHtml(facts.title || 'Discovery proposal')}</h1><p class="summary">${escapeHtml(facts.companyName || facts.attributes?.organizationName || model.source_key)} · ${escapeHtml(formatToken(facts.candidateKind || model.candidate_kind))}</p></div>${primaryNav()}</header><section class="stack"><article class="card"><h2>Review state</h2>${decision}<p><code>${escapeHtml(model.proposal_id)}</code></p></article><article class="card"><h2>Candidate facts</h2><p>${renderSourceUrl(facts.canonicalUrl)}</p><p>${escapeHtml([facts.locationText, facts.workplaceType, facts.employmentType].filter(Boolean).join(' · '))}</p><div class="description">${escapeHtml(description || 'No description text supplied.')}${String(facts.descriptionText || '').length > description.length ? '\n\n[truncated for the web view]' : ''}</div></article><section><h2>Immutable provenance</h2>${occurrences || '<div class="card">No occurrences found.</div>'}</section></section></main></body></html>`;
}

function renderOpeningPage(model) {
  const { opening } = model;
  const facets = [...model.roleTypes.map((row) => row.label), ...model.seniority.map((row) => row.label)]
    .map((label) => `${renderBadge(label, { label, tone: 'neutral' })}`).join(' ');
  const postings = model.postings.map((row) => `<li><strong>${escapeHtml(row.platform)}</strong> · ${escapeHtml(row.venue)} · ${escapeHtml(formatToken(row.state))}<br>${renderSourceUrl(row.canonical_url)}${row.external_id ? ` · external ID ${escapeHtml(row.external_id)}` : ''}</li>`).join('');
  const skills = model.skills.map((row) => `<li>${renderBadge(row.requirement_kind)} <strong>${escapeHtml(row.canonical_name)}</strong>${row.minimum_years !== null ? ` · ${escapeHtml(row.minimum_years)}+ years` : ''}${row.raw_phrase ? `<br><span class="activity">${escapeHtml(row.raw_phrase)}</span>` : ''}</li>`).join('');
  const applications = model.applications.map((row) => `<li>Application #${row.id} · ${escapeHtml(formatToken(row.status))} · ${escapeHtml(formatToken(row.workflow_stage))}${row.primary_job_posting_id ? ` · posting #${row.primary_job_posting_id}` : ''}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(opening.company)} — ${escapeHtml(opening.canonical_title)}</title><style>${baseStyles()}.layout{display:grid;grid-template-columns:1fr 1fr;gap:14px}.panel{padding:18px}.panel h2{margin-top:0}.panel li{margin:10px 0}.wide{grid-column:1/-1}@media(max-width:760px){.layout{grid-template-columns:1fr}.wide{grid-column:auto}}</style></head><body class="app-viewport">${appHeader()}<main class="app-doc"><header><div><p class="activity">${escapeHtml(opening.company)} · opening #${opening.id}</p><h1>${escapeHtml(opening.canonical_title)}</h1><p>${facets || '<span class="activity">Classification pending</span>'}</p></div>${primaryNav()}</header><div class="layout"><section class="card panel"><h2>Posting occurrences</h2><ul>${postings || renderEmptyState("No posting occurrences.", "jobtrack catalog posting --help", { as: 'li' })}</ul></section><section class="card panel"><h2>Required and preferred skills</h2><ul>${skills || renderEmptyState("No normalized skill requirements yet.", "jobtrack catalog skill --help", { as: 'li' })}</ul></section><section class="card panel wide"><h2>Linked applications</h2><ul>${applications || renderEmptyState("No applications linked to this opening.", "jobtrack add-application --company NAME --role TITLE", { as: 'li' })}</ul></section></div></main></body></html>`;
}

function renderInterviewPrepPage(model) {
  const context = model.context;
  const analysis = model.analysis;
  const sections = model.sections.map((row) => `<section class="card panel"><p class="activity">${escapeHtml(formatToken(row.section_kind))}</p><h2>${escapeHtml(row.heading)}</h2><p>${escapeHtml(row.content)}</p></section>`).join('');
  const questions = model.questions.map((row) => `<li><strong>${escapeHtml(row.prompt)}</strong>${row.suggested_answer ? `<p>${escapeHtml(row.suggested_answer)}</p>` : ''}${row.rationale ? `<p class="activity">${escapeHtml(row.rationale)}</p>` : ''}</li>`).join('');
  const skills = model.skillFocus.map((row) => `<li>${renderBadge(row.focus_kind)} ${escapeHtml(row.canonical_name)}${row.requirement_kind ? ` · ${escapeHtml(formatToken(row.requirement_kind))}` : ''}</li>`).join('');
  const status = analysis ? `Prep v${analysis.version} · ${analysis.review_status} · ${analysis.is_stale ? 'stale' : 'current evidence'}` : 'No prep analysis yet';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(context.interview.company)} interview prep</title><style>${baseStyles()}.grid{display:grid;gap:12px}.panel{padding:18px}.panel h2{margin:4px 0 10px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:760px){.columns{grid-template-columns:1fr}}</style></head><body class="app-viewport">${appHeader()}<main class="app-doc"><header><div><p class="activity">${escapeHtml(context.interview.company)} · ${escapeHtml(context.interview.role)}</p><h1>${analysis ? escapeHtml(analysis.title) : 'Interview prep pending'}</h1><p class="summary">${escapeHtml(status)} · ${escapeHtml(formatDate(context.interview.scheduled_at))} · ${escapeHtml(context.interview.timezone || 'timezone not recorded')}</p></div>${primaryNav()}</header>${analysis ? `<section class="card panel"><h2>Strategy</h2><p>${escapeHtml(analysis.executive_summary || '')}</p><p>${escapeHtml(analysis.strategy || '')}</p></section>${sections}<div class="columns"><section class="card panel"><h2>Questions</h2><ol>${questions || renderEmptyState("No questions recorded.", "jobtrack interview-prep --help", { as: 'li' })}</ol></section><section class="card panel"><h2>Skill focus</h2><ul>${skills || renderEmptyState("No linked skill focus yet.", "jobtrack catalog skill --help", { as: 'li' })}</ul></section></div>` : '<section class="card panel"><p>Generate the first version with the read/write CLI; this web surface remains read-only.</p></section>'}</main></body></html>`;
}

// Frozen v1 reply-draft -> dry-run request -> receipt history. The current G03
// exact review surface remains private CLI-only. This web projection stays
// collapsed metadata: it renders NO draft prose, message bodies, exact private

function renderOpportunityPage(model) {
  const opportunity = model.opportunity;
  const triage = model.triage.map((item) => `<li><strong>${escapeHtml(item.decision)}</strong>${item.score === null ? '' : ` · ${escapeHtml(item.score)}/100`} — ${escapeHtml(item.rationale)} <span class="activity">${escapeHtml(formatDate(item.created_at))}</span></li>`).join('');
  const provenance = model.observations.map((item) => `<li>${escapeHtml(item.source_key || 'unknown')} · ${escapeHtml(formatDate(item.observed_at))} · snapshot #${escapeHtml(item.snapshot_id)} · <code>${escapeHtml(String(item.payload_sha256 || '').slice(0, 12))}</code></li>`).join('');
  const tags = model.tags.map((item) => `<span>${escapeHtml(item.tag)}</span>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(opportunity.title)} · JobTrack</title><style>
    ${baseStyles()}
    .detail{display:grid;gap:16px}.panel{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}.description{white-space:pre-wrap;line-height:1.55}.tag-row{display:flex;gap:8px;flex-wrap:wrap}.tag-row span{border:1px solid var(--line);border-radius:999px;padding:5px 9px;color:var(--muted)}li{margin:.55rem 0}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  </style></head><body class="app-viewport">${appHeader()}<main class="app-doc"><header><div><p class="summary"><a href="/opportunities">← Opportunity inbox</a></p><h1>${escapeHtml(opportunity.title)}</h1><p class="summary">${escapeHtml(opportunity.company_name)} · ${escapeHtml(opportunity.location_text || 'Location not listed')}</p></div>${primaryNav()}</header><div class="detail"><section class="panel"><p>${renderBadge(opportunity.state)} · source ${escapeHtml(opportunity.source_key || 'unknown')} · last verified ${escapeHtml(formatDate(opportunity.last_verified_at))}</p><p>${renderSourceUrl(opportunity.canonical_url)}</p><div class="tag-row">${tags}</div></section><section class="panel"><h2>Posting snapshot</h2><div class="description">${escapeHtml(opportunity.description_text || 'No posting text captured yet.')}</div></section><section class="panel"><h2>Triage history</h2><ul>${triage || renderEmptyState("No triage decisions yet.", "jobtrack discovery proposal --help", { as: 'li' })}</ul></section><section class="panel"><h2>Provenance</h2><ul>${provenance || renderEmptyState("No observations recorded.", "jobtrack application-form import --application-id ID --bundle-file FILE", { as: 'li' })}</ul><p class="activity">${model.snapshots.length} immutable snapshot(s); ${model.events.length} audit event(s).</p></section></div></main></body></html>`;
}

function renderStoryPage(model) {
  const story = model.story;
  const revisions = model.revisions.map((revision) => `<article><h3>Revision ${escapeHtml(revision.revision_number)}${revision.is_current ? ' · current' : ''}</h3>${revision.one_line_summary ? `<p><strong>Summary:</strong> ${escapeHtml(revision.one_line_summary)}</p>` : ''}<div class="narrative">${escapeHtml(revision.canonical_text)}</div>${revision.takeaway ? `<p><strong>Takeaway:</strong> ${escapeHtml(revision.takeaway)}</p>` : ''}${revision.why_it_matters ? `<p><strong>Why it matters:</strong> ${escapeHtml(revision.why_it_matters)}</p>` : ''}</article>`).join('');
  const variants = model.variants.map((variant) => `<li><strong>${escapeHtml(variant.variant_key)} v${escapeHtml(variant.version)}</strong> · ${escapeHtml(variant.purpose)} · ${escapeHtml(variant.length_class)} · ${escapeHtml(variant.status)}${variant.status === 'approved' ? `<div class="narrative">${escapeHtml(variant.content)}</div>` : '<div class="activity">Draft content remains visible only in this private operator view.</div>'}</li>`).join('');
  const permissions = model.permissions.map((permission) => `<li>${escapeHtml(permission.purpose)}: <strong>${escapeHtml(permission.decision)}</strong>${permission.reason ? ` — ${escapeHtml(permission.reason)}` : ''}</li>`).join('');
  const questions = model.questions.map((question) => `<li><strong>${escapeHtml(question.status)}</strong> · ${escapeHtml(question.question_kind)} — ${escapeHtml(question.question)}${question.has_answer ? '<div class="activity">Answer preserved as a protected raw capture; polish it into the canonical revision before reuse.</div>' : ''}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(story.title)} · JobTrack</title><style>${baseStyles()}.detail{display:grid;gap:16px}.panel{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}.narrative{white-space:pre-wrap;line-height:1.6}article+article{border-top:1px solid var(--line);margin-top:18px;padding-top:18px}li{margin:.65rem 0}</style></head><body class="app-viewport">${appHeader()}<main class="app-doc"><header><div><p class="summary"><a href="/stories">← Story library</a></p><h1>${escapeHtml(story.title)}</h1><p class="summary">${escapeHtml(formatToken(story.status))} · ${escapeHtml(formatToken(story.sensitivity))}</p></div>${primaryNav()}</header><div class="detail"><section class="panel"><h2>Canonical revisions</h2>${revisions || '<p>No canonical revision yet.</p>'}</section><section class="panel"><h2>Purpose permissions</h2><ul>${permissions || `<li>Default: ${escapeHtml(story.default_use_decision)}</li>`}</ul></section><section class="panel"><h2>Variants</h2><ul>${variants || renderEmptyState("No audience/length variants yet.", "jobtrack story variant --story-id ID", { as: 'li' })}</ul></section><section class="panel"><h2>Raw captures</h2>${model.captures.length ? model.captures.map((capture) => `<article><p class="summary"><strong>Capture ${escapeHtml(capture.id)}</strong> · ${escapeHtml(formatToken(capture.capture_kind || 'narration'))} · ${escapeHtml(capture.captured_by || 'capturer not recorded')} · ${escapeHtml(formatDate(capture.captured_at || capture.created_at))} · SHA-256 ${escapeHtml(capture.sha256 || 'n/a')}</p><div class="narrative">${escapeHtml(capture.raw_text || '(no inline text; attachment-only capture)')}</div></article>`).join('') : '<p>No raw captures.</p>'}</section><section class="panel"><h2>Open work</h2><ul>${questions || renderEmptyState("No follow-up questions.", "jobtrack story question --story-id ID", { as: 'li' })}</ul><p class="activity">${model.captures.length} raw capture record(s); ${model.applicationLinks.length} application link(s); ${model.uses.length} recorded external use(s).</p></section></div></main></body></html>`;
}

module.exports = {
  renderDiscoveryProposalPage,
  renderOpeningPage,
  renderInterviewPrepPage,
  renderOpportunityPage,
  renderStoryPage
};
