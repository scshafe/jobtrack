'use strict';

// The application workspace and its two detail pages.
//
// The workspace is eleven sections over one application, and its job is to
// keep four DIFFERENT states visibly distinct rather than blending them into
// one progress bar: the application's own status, the workflow stage, material
// readiness, and form-coverage. A reader has to be able to tell "we have not
// looked" from "we looked and it is fine".
//
// That is why the empty states here are wordy. "No custom cover letter
// recorded" means something different for a historical application (legacy
// coverage unknown — not evidence the real submission omitted it) than for a
// prospective one (a required artifact is missing), and the banner says which.
//
// Protected fields are rendered as their ABSENCE: prompt text, help text and
// observed choices are withheld for a sensitive field, and the readiness
// blockers were already rewritten by the read model so a blocker string cannot
// carry the field text through.

const { escapeHtml, formatToken, formatDate, renderRedactedSourceUrl } = require('../html');
const { baseStyles } = require('../styles');
const { appHeader, primaryNav } = require('../nav');
const {
  renderBadge,
  renderEmptyPanel,
  renderEmptyState,
  renderKeyValues,
  renderTechnicalDetails
} = require('../vocabulary');
const { deriveApplicationStatus } = require('../read-model/rows');
const { describeOutgoingState, outgoingStateIsMuted } = require('./reply-lifecycle');
const { isProtectedApplicationField } = require('../../application-field-safety');
const { renderLatexPreview, latexPreviewStylesheet } = require('../../latex-preview');

function renderApplicationWorkspacePage(model) {
  const application = model.application;
  const sections = applicationWorkspaceSections(model);
  const total = sections.reduce((sum, section) => sum + section.count, 0);
  const index = sections.map((section) => `<a href="#${escapeHtml(section.key)}"><span>${escapeHtml(section.nav)}</span><code>${escapeHtml(section.count)}</code></a>`).join('');
  const openingLink = application.job_opening_id
    ? `<a href="/openings/${application.job_opening_id}">Opening #${escapeHtml(application.job_opening_id)}</a>`
    : '<span class="activity">No normalized opening linked</span>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(application.company)} — ${escapeHtml(application.role)} materials</title><style>${baseStyles()}.document-preview{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55}.workspace-status-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.workspace-status-grid>div{padding:10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-2)}.workspace-list{display:grid;gap:8px;margin:0;padding:0;list-style:none}.workspace-list>li{padding:10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-2)}.workspace-list p{margin:4px 0}.source-link{overflow-wrap:anywhere}@media(max-width:760px){.workspace-status-grid{grid-template-columns:1fr 1fr}}</style></head><body class="app-viewport">${appHeader()}
    <a class="skip-link" href="#application-workspace">Skip to application materials</a>
    <main class="shell app-doc">
      <header class="page-hero"><div><p class="kicker">application workspace // read-only</p><h1>${escapeHtml(application.role)}</h1><p class="summary">${escapeHtml(application.company)} · application #${escapeHtml(application.id)} · ${openingLink}</p><div class="readonly-strip"><span>GET/HEAD only</span><span>CLI is sole writer</span><span>Human-final submission</span></div></div><div>${primaryNav()}<p class="result-count mono">${escapeHtml(total)} workspace record${total === 1 ? '' : 's'}</p></div></header>
      <aside class="privacy-note"><strong>Private application material:</strong> generated prose is displayed as inert escaped text. Highly sensitive answers, raw captures, credentials, tokens, and attachment paths are never rendered.</aside>
      ${renderApplicationReadinessBanner(model)}
      <nav class="jump-nav section-index" aria-label="Application workspace section index">${index}</nav>
      <div id="materials" aria-hidden="true"></div>
      <div class="profile-sections" id="application-workspace">${sections.map(renderApplicationWorkspaceSection).join('')}</div>
    </main></body></html>`;
}

function applicationWorkspaceSections(model) {
  return [
    { key: 'overview', nav: 'Overview', title: 'Application overview', deck: 'Application, opening, workflow, and material-readiness states remain distinct.', count: 1, body: renderApplicationWorkspaceOverview(model) },
    { key: 'strategy', nav: 'Strategy', title: 'Application strategy control plane', deck: 'A frontier coordinator proposes the plan; policy-routed workers produce bounded proposals that still pass their domain review gates.', count: model.strategy?.counts?.total || 0, body: renderApplicationStrategy(model) },
    { key: 'reconnaissance', nav: 'Form discovery', title: 'Application-form reconnaissance', deck: 'Evidence-bound coverage for each exact posting and submission route. No observations never means complete.', count: model.surveys.length || model.postings.length, body: renderApplicationReconnaissance(model) },
    { key: 'requirements', nav: 'Requirements', title: 'Known requirements', deck: 'Requiredness and profile availability are explicit; unassessed is not the same as missing.', count: model.informationRequests.length + model.questions.length, body: renderApplicationRequirements(model) },
    { key: 'communications', nav: 'Communications', title: 'Recipient-aware communications', deck: 'Observable register, Cole-owned writing voice, and per-message tone decisions stay separate. Transmission happens only through a signed approval (human or policy) and the allowlisted send-approved edge.', count: model.communications?.counts?.message_count || 0, body: renderApplicationCommunications(model) },
    { key: 'correlation-quality', nav: 'Correlation', title: 'Email correlation quality', deck: 'Latest-per-message journal metrics make automatic links, agent decisions, clarification, corrections, and time-to-link observable.', count: model.correlationMetrics?.counts?.correlatedMessages || 0, body: renderApplicationCorrelationMetrics(model.correlationMetrics) },
    { key: 'resume', nav: 'Resume', title: 'Custom resume revisions', deck: 'Application-specific rough drafts, review state, explicit selection, and pinned evidence.', count: countWorkspaceMaterials(model, 'resume') || model.legacyResumes.length, body: renderApplicationMaterialGroup(model, 'resume', model.legacyResumes) },
    { key: 'cover-letter', nav: 'Cover letter', title: 'Custom cover-letter revisions', deck: 'A custom cover letter is required for every prospective application.', count: countWorkspaceMaterials(model, 'cover-letter') || model.legacyCoverLetters.length, body: renderApplicationMaterialGroup(model, 'cover-letter', model.legacyCoverLetters) },
    { key: 'questions', nav: 'Answers', title: 'Application questions and answers', deck: 'Answers belong to the exact observed form field; reusable profile answers are evidence, not submitted answers.', count: model.questions.length, body: renderApplicationQuestions(model) },
    { key: 'reviews', nav: 'Reviews', title: 'Review and selection decisions', deck: 'Review and current selection are append-only decisions separate from draft creation.', count: model.materialReviews.length + model.materialSelections.length + model.assessmentReviews.length, body: renderApplicationReviews(model) },
    { key: 'packages', nav: 'Packages', title: 'Immutable package history', deck: 'Packages pin exact approved revisions and remain operator-submitted.', count: model.preparationPackages.length || model.packages.length, body: renderApplicationPackages(model) },
    { key: 'history', nav: 'History', title: 'Preparation history', deck: 'A chronological summary without raw captures, secrets, or attachment paths.', count: model.preparationHistory.length + model.lifecycle.length, body: renderApplicationPreparationHistory(model) }
  ];
}

function renderApplicationWorkspaceSection(section) {
  return `<section class="profile-section" data-jt-section="${escapeHtml(section.key)}" id="${escapeHtml(section.key)}" aria-labelledby="${escapeHtml(section.key)}-title"><div class="section-head"><div><h2 id="${escapeHtml(section.key)}-title">${escapeHtml(section.title)}</h2><p>${escapeHtml(section.deck)}</p></div><span class="section-count mono">${escapeHtml(section.count)}</span></div><div class="section-body">${section.body}</div></section>`;
}

function renderApplicationReadinessBanner(model) {
  if (model.readiness) {
    const label = model.plan?.mode === 'legacy-import'
      ? 'Legacy / materials not recorded'
      : model.readiness.is_package_ready ? 'Package-ready' : model.readiness.is_draftable ? 'Draftable, not package-ready' : 'Preparation blocked';
    const blockers = (model.readiness.blockers || []).map((blocker) => escapeHtml(blocker.message || blocker.code || blocker)).join(' · ');
    return `<aside class="coverage-note"><strong>${escapeHtml(label)}:</strong> ${blockers || 'No current blockers recorded.'}</aside>`;
  }
  const historical = isHistoricalApplication(model.application);
  if (!model.materialsSchemaAvailable) {
    return `<aside class="coverage-note"><strong>Materials coverage ${historical ? 'not recorded' : 'not initialized'}:</strong> ${historical ? 'This historical application predates the normalized materials workspace; absence here is not evidence that the submitted application lacked these documents.' : 'The normalized v0.5 materials workspace has not been initialized for this store.'}</aside>`;
  }
  return '<aside class="coverage-note"><strong>Preparation state unknown:</strong> no authoritative readiness projection is available.</aside>';
}

function renderApplicationWorkspaceOverview(model) {
  const application = model.application;
  const latestPackage = model.preparationPackages[0] || model.packages[0] || null;
  return `<div class="workspace-status-grid">
    <div><span class="label">Application status</span>${renderBadge(deriveApplicationStatus(application))}</div>
    <div><span class="label">Workflow</span>${renderBadge(application.workflow_stage)}</div>
    <div><span class="label">Material readiness</span><span>${escapeHtml(model.readiness?.label || (model.materialsSchemaAvailable ? 'Unknown' : 'Legacy coverage'))}</span></div>
    <div><span class="label">Latest package</span><span>${escapeHtml(latestPackage ? formatToken(latestPackage.package_status || latestPackage.status || 'recorded') : 'None recorded')}</span></div>
    <div><span class="label">Posting occurrences</span><span>${escapeHtml(model.postings.length)}</span></div>
    <div><span class="label">Known requirements</span><span>${escapeHtml(model.informationRequests.length + model.questions.length)}</span></div>
    <div><span class="label">Profile blockers</span><span>${escapeHtml(model.gapSummary?.blocking_missing_count || 0)}</span></div>
    <div><span class="label">Applied</span><span>${escapeHtml(application.applied_date || 'Not recorded')}</span></div>
  </div>`;
}

function renderApplicationStrategy(model) {
  const strategy = model.strategy;
  if (!strategy || !strategy.strategy) {
    return renderEmptyPanel('No reviewed strategy plan is selected. This is unplanned state, not evidence that the application needs no further work.');
  }
  const selected = strategy.strategy;
  const summary = `<div class="workspace-status-grid">
    <div><span class="label">Control-plane state</span>${renderBadge(strategy.state || 'unknown')}</div>
    <div><span class="label">Plan revision</span><span>${escapeHtml(selected.revisionNumber || selected.revision_number || selected.id)}</span></div>
    <div><span class="label">Plan review</span><span>${escapeHtml(formatToken(selected.review?.decision || 'unreviewed'))}</span></div>
    <div><span class="label">Freshness</span><span>${selected.isStale ? 'Stale evidence' : 'Current evidence'}</span></div>
    <div><span class="label">Ready</span><span>${escapeHtml(strategy.counts?.ready || 0)}</span></div>
    <div><span class="label">Active</span><span>${escapeHtml(strategy.counts?.active || 0)}</span></div>
    <div><span class="label">Blocked</span><span>${escapeHtml(strategy.counts?.blocked || 0)}</span></div>
    <div><span class="label">Completed</span><span>${escapeHtml(strategy.counts?.completed || 0)} / ${escapeHtml(strategy.counts?.total || 0)}</span></div>
  </div>`;
  const work = strategy.workItems?.length
    ? `<ul class="workspace-list">${strategy.workItems.map((item) => {
      const routing = item.routing || null;
      const resultState = item.resultState || null;
      const route = routing?.routeAlias || null;
      const modelClass = routing?.requiredModelClass || null;
      const budget = resultState?.overBudget === true ? ' · over budget' : '';
      return `<li><div class="entry-title"><strong>${escapeHtml(item.title || item.item_key || `Work item ${item.id}`)}</strong>${renderBadge(item.state || 'unknown')}<span class="pill pill-neutral">${escapeHtml(formatToken(item.capability || 'work'))}</span></div><p class="activity">Priority ${escapeHtml(item.priority || '—')} · ${escapeHtml(formatToken(item.review_gate || 'review'))}${route ? ` · route ${escapeHtml(route)}` : ''}${modelClass ? ` · ${escapeHtml(formatToken(modelClass))}` : ''}${escapeHtml(budget)}</p>${item.blockers?.length ? `<p class="warning">${item.blockers.map(escapeHtml).join(' · ')}</p>` : ''}</li>`;
    }).join('')}</ul>`
    : renderEmptyPanel("The selected strategy has no work items.", "jobtrack strategy plan --application-id ID");
  return `${summary}${work}`;
}

function renderApplicationCommunications(model) {
  const communications = model.communications;
  const outgoing = communications ? communications.outgoing : null;
  const outgoingCount = outgoing ? outgoing.counts.proposals : 0;
  if (!communications || (!communications.counts.message_count && !outgoingCount)) {
    return renderEmptyPanel('No reviewed email-to-application links are recorded. Conversation demeanor and recipient register remain unknown.');
  }
  const counts = communications.counts;
  // The policy line names what governs THIS application: the default is auto
  // (policy approvals allowed) unless an operator recorded an override.
  const policyLabel = outgoing
    ? `${formatToken(outgoing.policy.mode)} (${outgoing.policy.source})`
    : 'schema unavailable';
  const summary = `<div class="workspace-status-grid">
    <div><span class="label">Linked messages</span><span>${escapeHtml(counts.message_count)}</span></div>
    <div><span class="label">Threads</span><span>${escapeHtml(counts.thread_count)}</span></div>
    <div><span class="label">Demeanor observations</span><span>${escapeHtml(counts.observation_count)}</span></div>
    <div><span class="label">Tone decisions</span><span>${escapeHtml(counts.tone_decision_count)}</span></div>
    <div><span class="label">Outgoing replies (v2)</span><span>${escapeHtml(outgoingCount)}</span></div>
    <div><span class="label">Sent</span><span>${escapeHtml(outgoing ? outgoing.counts.sent : 0)}</span></div>
    <div><span class="label">Approval policy</span><span>${escapeHtml(policyLabel)}</span></div>
    <div><span class="label">Send edge</span><span>send-approved · allowlisted</span></div>
    <div><span class="label">Historical v1 styled drafts</span><span>${escapeHtml(counts.styled_draft_count)}</span></div>
  </div>`;
  const outgoingRows = outgoing && outgoing.proposals.length
    ? `<h3>Outgoing replies (live v2 lane)</h3><ul class="workspace-list">${outgoing.proposals.map(renderWorkspaceOutgoingReply).join('')}</ul>`
    : '';
  const tones = communications.toneDecisions.length
    ? `<h3>Tone decisions</h3><ul class="workspace-list">${communications.toneDecisions.map((tone) => `<li><div class="entry-title"><strong>${escapeHtml(formatToken(tone.purpose || 'reply'))}</strong><span class="pill pill-neutral">${escapeHtml(tone.decision_id)}</span></div><p>${escapeHtml(formatToken(tone.formality || 'neutral'))} · ${escapeHtml(formatToken(tone.warmth || 'neutral'))} · ${escapeHtml(formatToken(tone.energy || 'neutral'))} · ${escapeHtml(formatToken(tone.directness || 'balanced'))} · ${escapeHtml(formatToken(tone.verbosity || 'concise'))}</p><p class="activity">Voice ${escapeHtml(tone.voice_revision_id)}${tone.style_profile_id ? ` · recipient profile ${escapeHtml(tone.style_profile_id)}` : ' · no selected recipient profile'} · exclamation ${escapeHtml(formatToken(tone.exclamation_policy || 'none'))} · emoji ${escapeHtml(formatToken(tone.emoji_policy || 'none'))} · ${escapeHtml(formatDate(tone.created_at))}</p></li>`).join('')}</ul>`
    : '<p class="activity">No tone decision is recorded yet.</p>';
  const drafts = communications.drafts.length
    ? `<h3>Styled reply proposals (historical v1 — this lane never transmitted)</h3><ul class="workspace-list">${communications.drafts.map((draft) => `<li><strong>Reply proposal ${escapeHtml(draft.proposal_id)}</strong> · ${escapeHtml(formatToken(draft.review_state || 'proposed'))}<p class="activity">Tone ${escapeHtml(draft.tone_decision_id)} · voice ${escapeHtml(draft.voice_revision_id)} · ${escapeHtml(formatDate(draft.created_at))} · auto-send disabled</p>${draft.proposal?.subject ? `<p><strong>${escapeHtml(draft.proposal.subject)}</strong></p>` : ''}${draft.proposal?.bodyText ? `<div class="document-preview" style="white-space:pre-wrap">${escapeHtml(draft.proposal.bodyText)}</div>` : ''}</li>`).join('')}</ul>`
    : '';
  return `${summary}${outgoingRows}${tones}${drafts}`;
}

function renderApplicationCorrelationMetrics(metrics) {
  if (!metrics || metrics.counts.correlatedMessages === 0) {
    return renderEmptyPanel('No email correlation journal entries involve this application yet.');
  }
  const counts = metrics.counts;
  return `<div class="workspace-status-grid">
    <div><span class="label">Evaluated messages</span><span>${escapeHtml(counts.correlatedMessages)}</span></div>
    <div><span class="label">Automatic-link rate</span><span>${escapeHtml(formatRate(metrics.rates.automaticLink))}</span></div>
    <div><span class="label">Agent-link rate</span><span>${escapeHtml(formatRate(metrics.rates.agentLink))}</span></div>
    <div><span class="label">Clarify rate</span><span>${escapeHtml(formatRate(metrics.rates.clarify))}</span></div>
    <div><span class="label">Mislink retractions</span><span>${escapeHtml(counts.mislinkRetractions)}</span></div>
    <div><span class="label">Average time-to-link</span><span>${escapeHtml(formatDuration(metrics.timeToLink.averageMs))}</span></div>
    <div><span class="label">Linked messages</span><span>${escapeHtml(counts.linkedMessages)}</span></div>
    <div><span class="label">Timing samples</span><span>${escapeHtml(metrics.timeToLink.samples)} / ${escapeHtml(counts.linkedMessages)}</span></div>
  </div>`;
}

function formatRate(value) {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function formatDuration(milliseconds) {
  if (milliseconds === null) return '—';
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1000)} sec`;
  if (milliseconds < 3_600_000) return `${(milliseconds / 60_000).toFixed(1)} min`;
  return `${(milliseconds / 3_600_000).toFixed(1)} hr`;
}

// The live lane, collapsed exactly like the global outgoing-replies page:
// state and register metadata only — no prose, subject, exact address,
// approver identity, or rejection reason. Exact-content review stays CLI-only.
function renderWorkspaceOutgoingReply(item) {
  const statePillClass = outgoingStateIsMuted(item.state) ? 'pill-neutral' : '';
  const reviewPill = item.review
    ? `<span class="pill pill-neutral">${escapeHtml(item.review.decision === 'approve' ? `approved by ${item.review.approverKind || 'unknown'}` : 'rejected')}</span>`
    : '<span class="pill pill-neutral">awaiting review</span>';
  const registerLine = `Thread ${escapeHtml(item.thread.threadId)} · ${escapeHtml(formatToken(item.thread.provider))}`
    + `${item.recipientDomain ? ` · recipient @${escapeHtml(item.recipientDomain)}` : ''}`;
  const outcomeLine = item.receipt
    ? `Receipt ${escapeHtml(formatToken(item.receipt.outcome))} (${escapeHtml(formatToken(item.receipt.classification))}) · observed ${escapeHtml(formatDate(item.receipt.observedAt))}`
    : (item.send
      ? `Send requested ${escapeHtml(formatDate(item.send.requestedAt))} · no receipt correlated yet`
      : (item.approval
        ? `Approved ${escapeHtml(formatDate(item.approval.approvedAt))}${item.approval.invalidated ? ` · INVALIDATED (${escapeHtml(formatToken(item.approval.invalidationReason || 'unknown'))})` : ' · not yet sent'}`
        : 'No approval recorded'));
  return `<li>
    <div class="entry-title"><strong>Outgoing reply ${escapeHtml(item.proposalId)}</strong><span class="pill ${statePillClass}">${escapeHtml(describeOutgoingState(item.state))}</span>${reviewPill}</div>
    <p class="activity">${registerLine}</p>
    <p class="activity">${outcomeLine}</p>
    <p class="activity">Drafted ${escapeHtml(formatDate(item.timestamps.draftedAt))}${item.timestamps.decidedAt ? ` · decided ${escapeHtml(formatDate(item.timestamps.decidedAt))}` : ''}</p>
  </li>`;
}

function renderApplicationReconnaissance(model) {
  if (model.surveys.length) return `<ul class="workspace-list">${model.surveys.map(renderApplicationSurvey).join('')}</ul>`;
  if (!model.postings.length) return renderEmptyPanel("No submission-route posting is linked. Application-form coverage is unknown, not complete.", "jobtrack capture-posting --application-id ID");
  return `<ul class="workspace-list">${model.postings.map((posting) => `<li><div class="entry-title"><strong>${escapeHtml(posting.platform || 'Posting')} · ${escapeHtml(posting.venue || 'Unknown venue')}</strong><span class="pill pill-neutral">Coverage unknown</span></div><p class="activity">Posting #${escapeHtml(posting.id)} · ${escapeHtml(formatToken(posting.relation || 'linked'))}${posting.is_primary ? ' · primary route' : ''}</p>${posting.canonical_url ? `<p class="source-link">${renderRedactedSourceUrl(posting.canonical_url)}</p>` : ''}<p class="warning">No reviewed form survey is recorded. Later or conditional steps may exist.</p></li>`).join('')}</ul>`;
}

function renderApplicationSurvey(survey) {
  const state = survey.coverage_state || survey.coverageState || 'unknown';
  const complete = ['complete', 'all-reachable-pre-submit-steps-observed', 'provider-schema-complete'].includes(state)
    && survey.review_decision === 'approved';
  const uncertainty = [
    survey.known_unobserved_step_count ? `${survey.known_unobserved_step_count} declared/unobserved step(s)` : null,
    survey.possible_unobserved_branches ? 'possible unobserved branches' : null,
    survey.pre_submit_boundary_observed === false ? 'pre-submit boundary not observed' : null
  ].filter(Boolean).join(' · ');
  const warning = complete && !uncertainty ? '' : `<p class="warning">${escapeHtml(uncertainty || 'Later, conditional, authenticated, or inaccessible steps may still exist.')}</p>`;
  return `<li><div class="entry-title"><strong>${escapeHtml(survey.platform || survey.venue || `Posting #${survey.job_posting_id || 'unknown'}`)}</strong><span class="pill ${complete ? '' : 'pill-neutral'}">${escapeHtml(formatToken(state))}</span><span class="pill ${survey.review_decision === 'approved' ? '' : 'pill-neutral'}">${escapeHtml(formatToken(survey.review_decision || 'unreviewed'))}</span></div><p class="activity">${escapeHtml(survey.method_label || formatToken(survey.discovery_method || 'observation'))} · observed ${escapeHtml(formatDate(survey.observed_at))} · ${escapeHtml(survey.step_count || 0)} step(s) · ${escapeHtml(survey.field_count || 0)} field(s)</p>${survey.public_url ? `<p class="source-link">${renderRedactedSourceUrl(survey.public_url)}</p>` : ''}${warning}</li>`;
}

function renderApplicationRequirements(model) {
  const rows = model.informationRequests.map((request) => {
    const sensitive = isProtectedApplicationField({
      ...request,
      label: request.information_field_label || request.requested_label,
      prompt: request.raw_prompt,
      help_text: request.requested_label
    });
    const label = request.information_field_label || request.requested_label || 'Requested information';
    const observedLabel = sensitive ? 'Employer field details withheld' : request.requested_label || 'Employer field';
    return `<li><div class="entry-title"><strong>${escapeHtml(label)}</strong>${renderBadge(request.requiredness || 'unknown')}<span class="pill ${request.assessment_state === 'confirmed_missing' ? '' : 'pill-neutral'}">${escapeHtml(formatToken(request.assessment_state || 'unassessed'))}</span></div><p class="activity">${escapeHtml(observedLabel)} · observed ${escapeHtml(formatDate(request.observed_at))}${request.job_posting_id ? ` · posting #${escapeHtml(request.job_posting_id)}` : ''}</p>${request.raw_prompt ? `<p>${escapeHtml(request.raw_prompt)}</p>` : ''}</li>`;
  });
  const questionRows = model.questions.map((question) => renderApplicationQuestionSummary(model.application.id, question));
  return rows.length || questionRows.length ? `<ul class="workspace-list">${rows.join('')}${questionRows.join('')}</ul>` : renderEmptyPanel('No requirements have been captured. This means coverage is unknown; it does not mean the employer asks no questions.');
}

function countWorkspaceMaterials(model, kind) {
  const group = model.materialGroups.find((candidate) => candidate.kind === kind || candidate.kind_slug === kind);
  return group ? Number(group.revision_count ?? group.revisions?.length ?? 0) : 0;
}

function renderApplicationMaterialGroup(model, kind, legacyRows) {
  const group = model.materialGroups.find((candidate) => candidate.kind === kind || candidate.kind_slug === kind);
  const revisions = group?.revisions || [];
  if (revisions.length) return `<ul class="workspace-list">${revisions.map((revision) => renderApplicationMaterialSummary(model.application.id, group, revision)).join('')}</ul>`;
  if (legacyRows.length) return `<ul class="workspace-list">${legacyRows.map((row, index) => `<li><div class="entry-title"><strong>Legacy ${escapeHtml(formatToken(kind))} #${escapeHtml(row.id)}</strong><span class="pill pill-neutral">Not normalized</span></div><p class="activity">${index === 0 ? 'Latest legacy record · ' : ''}${escapeHtml(formatDate(row.updated_at || row.created_at))} · review/current-selection state unavailable</p></li>`).join('')}</ul>`;
  const historical = isHistoricalApplication(model.application);
  return renderEmptyPanel(historical
    ? `No ${formatToken(kind)} is recorded in JobTrack for this historical application. That is legacy coverage unknown, not evidence the actual submission omitted it.`
    : `No custom ${formatToken(kind)} revision has been recorded; one is required before the application can become package-ready.`);
}

function renderApplicationMaterialSummary(applicationId, group, revision) {
  const decision = revision.review_decision || revision.reviewDecision || 'unreviewed';
  const reviewedRenderId = revision.latest_review_render_id || null;
  const reviewedRender = reviewedRenderId
    ? (revision.renders || []).find((render) => String(render.id) === String(reviewedRenderId))
    : null;
  const renderState = reviewedRender
    ? `PDF render #${reviewedRender.id} · ${reviewedRender.page_count} page(s) · ${reviewedRender.output_sha256} · ${reviewedRender.active_content_policy || 'active-content scan unavailable'}`
    : revision.source_format === 'latex' ? 'PDF not pinned by current review' : 'Legacy text source';
  return `<li><div class="entry-title"><strong><a href="/applications/${applicationId}/materials/${escapeHtml(revision.id)}">${escapeHtml(formatToken(group.kind || group.kind_slug))} revision ${escapeHtml(revision.revision_number || revision.version || revision.id)}</a></strong>${renderBadge(revision.revision_stage || 'rough-draft')}<span class="pill ${decision === 'approved' ? '' : 'pill-neutral'}">${escapeHtml(formatToken(decision))}</span></div><p class="activity">${revision.is_selected ? 'Selected current · ' : ''}${revision.is_head ? 'Latest draft · ' : ''}${escapeHtml(formatDate(revision.created_at))}${revision.is_stale ? ' · stale evidence' : ''}</p><p class="activity">${escapeHtml(formatToken(revision.source_format || 'legacy-text'))} · ${escapeHtml(renderState)}</p></li>`;
}

function renderApplicationQuestions(model) {
  if (!model.questions.length) return renderEmptyPanel('No application-specific questions are captured. Until form coverage is reviewed, answer coverage remains unknown.');
  return `<ul class="workspace-list">${model.questions.map((question) => renderApplicationQuestionSummary(model.application.id, question)).join('')}</ul>`;
}

function renderApplicationQuestionSummary(applicationId, question) {
  const sensitive = Boolean(question.is_sensitive) || isProtectedApplicationField(question);
  const label = question.prompt_label || question.label || question.prompt || 'Application question';
  return `<li><div class="entry-title"><strong><a href="/applications/${applicationId}/questions/${escapeHtml(question.id)}">${escapeHtml(label)}</a></strong>${renderBadge(question.requiredness || 'unknown')}<span class="pill ${question.answer_review_decision === 'approved' ? '' : 'pill-neutral'}">${escapeHtml(formatToken(question.answer_review_decision || question.answer_state || 'unanswered'))}</span></div><p class="activity">${escapeHtml(formatToken(question.input_kind || question.field_kind || 'question'))}${question.job_posting_id ? ` · posting #${escapeHtml(question.job_posting_id)}` : ''}</p></li>`;
}

function renderApplicationReviews(model) {
  const material = model.materialReviews.map((review) => `<li><strong>${escapeHtml(formatToken(review.kind || 'material'))} revision ${escapeHtml(review.revision_number || review.revision_id)}</strong> · ${escapeHtml(formatToken(review.decision))}<p class="activity">${escapeHtml(review.reviewed_by || 'Reviewer not recorded')} · ${escapeHtml(formatDate(review.reviewed_at || review.created_at))}${review.render_id ? ` · reviewed PDF #${escapeHtml(review.render_id)}` : ''}</p>${review.notes ? `<p>${escapeHtml(review.notes)}</p>` : ''}</li>`);
  const selections = model.materialSelections.map((selection) => `<li><strong>${escapeHtml(formatToken(selection.kind || 'material'))} selected</strong> · revision ${escapeHtml(selection.revision_number || selection.revision_id)}<p class="activity">${escapeHtml(selection.selected_by || 'Selector not recorded')} · ${escapeHtml(formatDate(selection.selected_at || selection.created_at))}</p></li>`);
  const assessments = model.assessmentReviews.map((review) => `<li><strong>Application assessment</strong> · ${escapeHtml(formatToken(review.decision))}<p class="activity">${escapeHtml(review.decided_by || 'Reviewer not recorded')} · ${escapeHtml(formatDate(review.decided_at))}</p>${review.notes ? `<p>${escapeHtml(review.notes)}</p>` : ''}</li>`);
  const rows = [...material, ...selections, ...assessments];
  return rows.length ? `<ul class="workspace-list">${rows.join('')}</ul>` : renderEmptyPanel('No review or selection decisions are recorded. Draft creation alone never implies approval.');
}

function renderApplicationPackages(model) {
  const packages = model.preparationPackages.length ? model.preparationPackages : model.packages;
  if (!packages.length) return renderEmptyPanel("No immutable application package has been recorded. JobTrack never submits automatically.", "jobtrack build-package --application-id ID --expected-readiness-sha256 SHA");
  return `<ul class="workspace-list">${packages.map((item) => `<li><div class="entry-title"><strong>Package #${escapeHtml(item.package_id || item.id)}</strong>${renderBadge(item.package_status || item.status || 'recorded')}</div><p class="activity">${escapeHtml(formatDate(item.created_at || item.updated_at))}${item.is_stale ? ' · stale' : ''}</p><p>Resume revision ${escapeHtml(item.resume_revision_id || item.resume_id || 'not pinned')} · PDF render ${escapeHtml(item.resume_render_id || 'not pinned')} · cover-letter revision ${escapeHtml(item.cover_letter_revision_id || item.cover_letter_id || 'not pinned')} · PDF render ${escapeHtml(item.cover_letter_render_id || 'not pinned')}</p></li>`).join('')}</ul>`;
}

function renderApplicationPreparationHistory(model) {
  const history = [
    ...model.preparationHistory.map((row) => ({ at: row.created_at || row.occurred_at, label: row.label || row.event_kind || row.kind, detail: row.detail || row.notes })),
    ...model.lifecycle.map((row) => ({ at: row.created_at, label: row.event_kind, detail: `${formatToken(row.from_stage || 'start')} → ${formatToken(row.to_stage)}${row.notes ? ` · ${row.notes}` : ''}` }))
  ].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return history.length ? `<ul class="workspace-list">${history.slice(0, 500).map((row) => `<li><strong>${escapeHtml(formatToken(row.label || 'event'))}</strong><p class="activity">${escapeHtml(formatDate(row.at))}</p>${row.detail ? `<p>${escapeHtml(row.detail)}</p>` : ''}</li>`).join('')}</ul>` : renderEmptyPanel("No application preparation history is recorded.", "jobtrack application-material activate --application-id ID");
}

function isHistoricalApplication(application) {
  return Boolean(application.applied_date) || ['submitted', 'interviewing', 'offer', 'declined', 'archived'].includes(application.workflow_stage);
}

function renderApplicationMaterialPage(model) {
  const revision = model.revision;
  const application = model.application;
  const reviews = (model.reviews || []).map((review) => `<li><strong>${escapeHtml(formatToken(review.decision))}</strong> · ${escapeHtml(review.reviewed_by || 'Reviewer not recorded')} · ${escapeHtml(formatDate(review.reviewed_at || review.created_at))}${review.render_id ? ` · reviewed PDF #${escapeHtml(review.render_id)}` : ''}${review.notes ? `<p>${escapeHtml(review.notes)}</p>` : ''}</li>`).join('');
  const renders = (revision.renders || []).map((render) => `<li><strong>PDF render #${escapeHtml(render.id)}</strong> · ${escapeHtml(render.page_count)} page(s) · ${escapeHtml(render.output_bytes)} bytes<p class="activity">${escapeHtml(render.renderer_profile)} · image ${escapeHtml(render.renderer_image_digest)} · SHA-256 ${escapeHtml(render.output_sha256)} · active-content policy ${escapeHtml(render.active_content_policy || 'not recorded')} · scan ${escapeHtml(render.active_content_scan_sha256 || 'not recorded')} · ${escapeHtml(render.output_attachment_path || 'attachment path not recorded')}</p><iframe class="pdf-frame" src="/applications/${application.id}/material-renders/${escapeHtml(render.id)}.pdf" title="Rendered PDF ${escapeHtml(render.id)}"></iframe></li>`).join('');
  const content = `<div class="document-preview">${escapeHtml(revision.content || 'No inline content stored.')}</div>`;
  // Approximate typeset preview (server-side latex.js) for LaTeX materials
  // without exposing any client JavaScript. The pinned PDF above remains the
  // authoritative render; this covers drafts that have none yet.
  let preview = '';
  if (['resume', 'cover-letter'].includes(model.kind) && revision.content) {
    const rendered = renderLatexPreview(revision.content);
    preview = rendered.ok
      ? `<section class="card"><h2>Typeset preview <span class="pill">approximate · latex.js</span></h2><div class="latexjs-preview">${rendered.html}</div><p class="activity">Server-side approximation for quick reading. The digest-pinned PDF render is the authoritative output.</p></section>`
      : `<section class="card"><h2>Typeset preview</h2><p class="activity">No preview available: ${escapeHtml(rendered.reason)}</p></section>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(formatToken(model.kind))} revision · JobTrack</title><style>${baseStyles()}.document-preview{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}.detail{display:grid;gap:12px}.pdf-frame{width:100%;height:640px;border:1px solid #ccc;border-radius:6px;margin-top:10px;background:#fff}${preview ? latexPreviewStylesheet() : ''}</style></head><body class="app-viewport">${appHeader()}<main class="app-doc"><header><div><p class="summary"><a href="/applications/${application.id}#${escapeHtml(model.kind)}">← Application workspace</a></p><h1>${escapeHtml(formatToken(model.kind))} revision ${escapeHtml(revision.revision_number)}</h1><p class="summary">${escapeHtml(application.company)} · ${escapeHtml(application.role)} · ${escapeHtml(formatToken(revision.revision_stage || 'rough-draft'))} · ${escapeHtml(formatToken(model.reviewDecision || 'unreviewed'))}${model.isSelected ? ' · selected current' : ''}${model.isHead ? ' · latest draft' : ''}${model.isStale ? ' · stale evidence' : ''}</p></div>${primaryNav()}</header><div class="detail">${preview}<section class="card"><h2>Immutable LaTeX source</h2>${content}</section><section class="card" data-jt-section="traceability"><h2>Traceability</h2>${renderKeyValues([['Revision stage', formatToken(revision.revision_stage)],['Source format', formatToken(revision.source_format || 'legacy-text')],['Template', revision.template_key],['Authorship', revision.authorship],['Authored by', revision.authored_by],['Change note', revision.change_note],['Created', revision.created_at]])}${renderTechnicalDetails([['Generation contract', revision.generation_contract_version],['Content SHA-256', revision.content_sha256],['Source manifest SHA-256', model.sourceManifestSha256],['Parent revision', revision.parent_revision_id]], { summary: 'Digests and generation provenance' })}</section><section class="card"><h2>Rendered PDFs</h2><ul>${renders || renderEmptyState("No rendered PDF recorded.", "jobtrack application-material render --application-id ID --revision-id ID", { as: 'li' })}</ul></section><section class="card"><h2>Review history</h2><ul>${reviews || renderEmptyState("No review decision recorded. Draft creation does not imply approval.", "jobtrack application-material review --application-id ID --revision-id ID --decision approved", { as: 'li' })}</ul></section></div></main></body></html>`;
}

function renderApplicationQuestionPage(model) {
  const question = model.question;
  const application = model.application;
  const sensitive = Boolean(model.isSensitive) || isProtectedApplicationField(question);
  const heading = question.label || question.prompt || 'Application question';
  const revisions = (model.answerRevisions || []).map((revision) => `<li><strong>Revision ${escapeHtml(revision.revision_number)}</strong> · ${escapeHtml(formatToken(revision.review_decision || 'unreviewed'))} · ${escapeHtml(formatDate(revision.created_at))}<div class="document-preview">${escapeHtml(revision.content || revision.rendered_answer || '')}</div></li>`).join('');
  const constraintFields = questionConstraintFields(model.constraints);
  const guidance = sensitive
    ? '<p class="activity">Potentially sensitive prompt details are not rendered.</p>'
    : question.help_text ? `<p>${escapeHtml(question.help_text)}</p>` : '<p class="activity">No additional field guidance was captured.</p>';
  const choices = !sensitive && model.options?.length
    ? `<h3>Observed choices</h3><ul>${model.options.map((option) => `<li>${escapeHtml(option.label)}</li>`).join('')}</ul>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Application question · JobTrack</title><style>${baseStyles()}.document-preview{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}</style></head><body class="app-viewport">${appHeader()}<main class="app-doc"><header><div><p class="summary"><a href="/applications/${application.id}#questions">← Application workspace</a></p><h1>${escapeHtml(heading)}</h1><p class="summary">${escapeHtml(application.company)} · ${escapeHtml(application.role)} · ${escapeHtml(formatToken(question.requiredness || 'unknown'))}</p></div>${primaryNav()}</header><section class="card"><h2>Observed field</h2>${guidance}${renderKeyValues([['Input kind', formatToken(question.input_kind || question.field_kind)],['Sensitivity', formatToken(question.sensitivity)],['Observation state', formatToken(question.observation_state)],['Posting', question.job_posting_id],['Observed', question.observed_at],['Choice count', model.options?.length || 0],...constraintFields])}${choices}</section><section class="card"><h2>Answer revisions</h2><ul>${revisions || renderEmptyState("No application-specific answer revision recorded.", "jobtrack application-material draft --application-id ID --kind form-answer --form-field-id ID", { as: 'li' })}</ul></section></main></body></html>`;
}

function questionConstraintFields(constraints) {
  if (!constraints || typeof constraints !== 'object' || Array.isArray(constraints)) return [];
  const labels = {
    minLength: 'Minimum characters', maxLength: 'Maximum characters',
    minSelections: 'Minimum selections', maxSelections: 'Maximum selections',
    maxFileBytes: 'Maximum file bytes', acceptedMimeTypes: 'Accepted MIME types',
    acceptedExtensions: 'Accepted extensions'
  };
  return Object.entries(labels).map(([key, label]) => [label, constraints[key]]);
}

module.exports = {
  renderApplicationWorkspacePage,
  renderApplicationMaterialPage,
  renderApplicationQuestionPage
};
