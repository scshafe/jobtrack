'use strict';

// The outgoing-replies page: the LIVE v2 lane (draft proposal -> signed
// approval -> one-send request -> correlated receipt) as collapsed metadata,
// with the frozen v1 dry-run era below it when that history exists.
//
// This surface exists to answer "what happened, and does anything need me?"
// without becoming a place where reply prose can be read or send authority
// granted. So: recipients appear as a domain only, never an exact address;
// approvers appear as a KIND (human or policy), never an id or signer
// identity; artifacts appear as truncated SHA-256 digests, which carry no
// recoverable prose; rejection reasons and provider payloads are never
// rendered. Transmission happens only through the allowlisted send-approved
// edge, and nothing on this page grants it.
//
// The current provider-neutral G03 exact review surface stays CLI-only.

const { escapeHtml, formatToken, formatDate } = require('../html');
const { baseStyles } = require('../styles');
const { appHeader, primaryNav } = require('../nav');
const { renderEmptyPanel } = require('../vocabulary');

function renderReplyLifecyclePage(model) {
  const v2 = model.v2 || { available: false, counts: null, lifecycle: [] };
  const v1 = model.v1 || { available: false, counts: null, lifecycle: [] };
  const count = v2.available ? (v2.counts.proposals || 0) : 0;

  const v2Body = v2.available
    ? (v2.lifecycle.length
      ? `${renderV2SummaryGrid(v2.counts)}<ul class="workspace-list lifecycle-list">${v2.lifecycle.map(renderV2Card).join('')}</ul>`
      : `${renderV2SummaryGrid(v2.counts)}${renderEmptyPanel('No outgoing replies are recorded yet. The live lane records a proposal when a reply is drafted; approvals, send requests, and receipts follow it here.')}`)
    : renderEmptyPanel('This store predates the outgoing-email schema.');

  // The dry-run era renders only when it holds rows: an empty historical
  // section would just be noise under the live lane.
  const v1Section = v1.available && (v1.counts.total || 0) > 0
    ? `<h2 class="lifecycle-era">Historical v1 (dry-run era)</h2>
      <p class="activity">Frozen draft and dry-run history. This lane never transmitted; nothing here reflects live sends.</p>
      ${renderV1SummaryGrid(v1.counts)}
      <ul class="workspace-list lifecycle-list">${v1.lifecycle.map(renderV1Card).join('')}</ul>`
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Outgoing replies · JobTrack</title><style>${baseStyles()}.workspace-status-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0 0 16px}.workspace-status-grid>div{padding:10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-2)}.workspace-list{display:grid;gap:10px;margin:0;padding:0;list-style:none}.workspace-list>li{padding:12px 14px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-2)}.workspace-list p{margin:5px 0}.lifecycle-era{margin:26px 0 6px}.lifecycle-digests{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--line-soft);border:1px solid var(--line-soft);border-radius:var(--r-sm);overflow:hidden;margin-top:8px}.lifecycle-digests>div{min-width:0;padding:7px 9px;background:var(--surface);font-size:.78rem;overflow-wrap:anywhere}.lifecycle-digests code{color:var(--muted)}@media(max-width:760px){.workspace-status-grid,.lifecycle-digests{grid-template-columns:1fr}}</style></head><body class="app-viewport">${appHeader()}
    <a class="skip-link" href="#content">Skip to outgoing replies</a>
    <main class="shell app-doc" id="content">
      <header class="page-hero"><div><p class="kicker">outgoing replies // read-only</p><h1>Outgoing replies</h1><p class="summary">The live v2 lane: draft proposals, signed approvals (human or policy), one-send requests, and correlated receipts, as collapsed metadata. Current provider-neutral G03 exact review stays CLI-only. No draft prose, subject lines, exact addresses, approver identities, or provider payloads are shown; transmission happens only through the allowlisted send-approved edge.</p><div class="readonly-strip"><span>GET/HEAD only</span><span>CLI is sole writer</span><span>Metadata only</span><span>Send edge: send-approved only</span></div></div><div>${primaryNav()}<p class="result-count mono">${escapeHtml(count)} outgoing ${count === 1 ? 'reply' : 'replies'}</p></div></header>
      <aside class="privacy-note"><strong>Collapsed metadata:</strong> recipients are shown as a domain only, approvers as a kind (human or policy), and artifacts as digests. Raw reply prose, subject lines, message bodies, exact private addresses, approver identities, and rejection reasons are never rendered here.</aside>
      ${v2Body}
      ${v1Section}
    </main></body></html>`;
}

// ---------------------------------------------------------------------------
// v2: the live lane.
// ---------------------------------------------------------------------------

const V2_STATE_LABELS = {
  'draft-recorded': 'Draft recorded',
  approved: 'Approved',
  rejected: 'Rejected',
  'approval-invalidated': 'Approval invalidated',
  'send-requested': 'Send requested',
  sent: 'Sent',
  'send-duplicate': 'Send: duplicate',
  'send-failed': 'Send: failed',
  'send-indeterminate': 'Send: indeterminate'
};

// States where the lane stopped or needs eyes render on the muted pill so the
// live successes stay visually loud.
const V2_MUTED_STATES = new Set(['rejected', 'approval-invalidated', 'send-failed', 'send-indeterminate']);

function renderV2SummaryGrid(counts) {
  return `<div class="workspace-status-grid">
    <div><span class="label">Outgoing proposals</span><span>${escapeHtml(counts.proposals || 0)}</span></div>
    <div><span class="label">Awaiting review</span><span>${escapeHtml(counts.awaitingReview || 0)}</span></div>
    <div><span class="label">Approved by policy</span><span>${escapeHtml(counts.approvedByPolicy || 0)}</span></div>
    <div><span class="label">Approved by human</span><span>${escapeHtml(counts.approvedByHuman || 0)}</span></div>
    <div><span class="label">Rejected</span><span>${escapeHtml(counts.rejected || 0)}</span></div>
    <div><span class="label">Approvals invalidated</span><span>${escapeHtml(counts.invalidated || 0)}</span></div>
    <div><span class="label">Send requests</span><span>${escapeHtml(counts.sendRequests || 0)}</span></div>
    <div><span class="label">Sent</span><span>${escapeHtml(counts.sent || 0)}</span></div>
    <div><span class="label">Failed / duplicate / indeterminate</span><span>${escapeHtml(`${counts.failed || 0} / ${counts.duplicate || 0} / ${counts.indeterminate || 0}`)}</span></div>
  </div>`;
}

function renderV2Card(item) {
  const stateLabel = V2_STATE_LABELS[item.state] || formatToken(item.state);
  const statePillClass = V2_MUTED_STATES.has(item.state) ? 'pill-neutral' : '';
  const reviewPill = item.review
    ? `<span class="pill pill-neutral">${escapeHtml(item.review.decision === 'approve' ? `approved by ${item.review.approverKind || 'unknown'}` : 'rejected')}</span>`
    : '<span class="pill pill-neutral">awaiting review</span>';
  const application = item.application
    ? `<a href="/applications/${escapeHtml(item.application.id)}">${escapeHtml(item.application.company)} · ${escapeHtml(item.application.role)}</a>`
    : 'Unlinked thread';
  const registerLine = `Thread ${escapeHtml(item.thread.threadId)} · ${escapeHtml(formatToken(item.thread.provider))}`
    + `${item.thread.senderDomain ? ` · sender @${escapeHtml(item.thread.senderDomain)}` : ''}`
    + `${item.recipientDomain ? ` · recipient @${escapeHtml(item.recipientDomain)}` : ''}`;
  const approvalLine = item.approval
    ? `Approval ${escapeHtml(item.approval.approvalId)} · approved ${escapeHtml(formatDate(item.approval.approvedAt))} · expires ${escapeHtml(formatDate(item.approval.expiresAt))}`
      + `${item.approval.invalidated ? ` · INVALIDATED (${escapeHtml(formatToken(item.approval.invalidationReason || 'unknown'))} ${escapeHtml(formatDate(item.approval.invalidatedAt))})` : ''}`
    : 'No signed approval recorded';
  const sendLine = item.send
    ? `Send request ${escapeHtml(item.send.requestId)} · requested ${escapeHtml(formatDate(item.send.requestedAt))} · one send per approval`
    : 'No send request issued';
  const receiptLine = item.receipt
    ? `Send receipt ${escapeHtml(item.receipt.receiptId)} · ${escapeHtml(formatToken(item.receipt.outcome))} (${escapeHtml(formatToken(item.receipt.classification))})`
      + `${item.receipt.hasProviderMessageId ? ' · provider message id recorded' : ''}`
      + `${item.receipt.attempts > 1 ? ` · ${escapeHtml(item.receipt.attempts)} attempts` : ''}`
      + ` · observed ${escapeHtml(formatDate(item.receipt.observedAt))}`
    : 'No send receipt correlated';
  const timesLine = `Drafted ${escapeHtml(formatDate(item.timestamps.draftedAt))}`
    + `${item.timestamps.decidedAt ? ` · decided ${escapeHtml(formatDate(item.timestamps.decidedAt))}` : ''}`
    + ` · proposal expires ${escapeHtml(formatDate(item.timestamps.proposalExpiresAt))}`;
  const digests = renderLifecycleDigests([
    ['Proposal digest', item.digests.proposalDigest],
    ['Approved content digest', item.digests.contentDigest],
    ['Approval digest', item.digests.approvalDigest],
    ['Send-request digest', item.digests.requestDigest],
    ['Send-receipt digest', item.digests.receiptDigest]
  ]);
  return `<li>
    <div class="entry-title"><strong>Outgoing reply ${escapeHtml(item.proposalId)}</strong><span class="pill ${statePillClass}">${escapeHtml(stateLabel)}</span>${reviewPill}</div>
    <p class="activity">${registerLine} · ${application}</p>
    <p class="activity">${approvalLine}</p>
    <p class="activity">${sendLine}</p>
    <p class="activity">${receiptLine}</p>
    <p class="activity">${timesLine}</p>
    ${digests}
  </li>`;
}

// ---------------------------------------------------------------------------
// v1: the frozen dry-run era. Rendering unchanged from the era itself.
// ---------------------------------------------------------------------------

const LIFECYCLE_STATE_LABELS = {
  'draft-proposed': 'Draft proposed',
  approved: 'Approved',
  rejected: 'Rejected',
  'send-request-emitted': 'Send-request emitted (dry-run)',
  'receipt-sent': 'Send receipt: sent',
  'receipt-skipped_duplicate': 'Send receipt: skipped (duplicate)',
  'receipt-failed': 'Send receipt: failed'
};

function renderV1SummaryGrid(counts) {
  return `<div class="workspace-status-grid">
    <div><span class="label">Reply drafts</span><span>${escapeHtml(counts.total || 0)}</span></div>
    <div><span class="label">Awaiting review</span><span>${escapeHtml(counts.drafted || 0)}</span></div>
    <div><span class="label">Approved</span><span>${escapeHtml(counts.approved || 0)}</span></div>
    <div><span class="label">Rejected</span><span>${escapeHtml(counts.rejected || 0)}</span></div>
    <div><span class="label">Historical v1 requests (dry-run)</span><span>${escapeHtml(counts.emitted || 0)}</span></div>
    <div><span class="label">Receipts sent</span><span>${escapeHtml(counts.sent || 0)}</span></div>
    <div><span class="label">Receipts skipped</span><span>${escapeHtml(counts.skipped || 0)}</span></div>
    <div><span class="label">Receipts failed</span><span>${escapeHtml(counts.failed || 0)}</span></div>
    <div><span class="label">Auto-send</span><span>Never granted</span></div>
  </div>`;
}

function renderV1Card(item) {
  const stateLabel = LIFECYCLE_STATE_LABELS[item.state] || formatToken(item.state);
  const receiptStatus = item.receipt ? item.receipt.status : null;
  const statePillClass = receiptStatus === 'failed'
    ? 'pill-neutral'
    : (item.state === 'rejected' ? 'pill-neutral' : '');
  const application = item.application
    ? `<a href="/applications/${escapeHtml(item.application.id)}">${escapeHtml(item.application.company)} · ${escapeHtml(item.application.role)}</a>`
    : 'Unlinked thread';
  const registerLine = `Thread ${escapeHtml(item.thread.threadId)} · ${escapeHtml(formatToken(item.thread.provider))}`
    + `${item.thread.senderDomain ? ` · sender @${escapeHtml(item.thread.senderDomain)}` : ''}`
    + `${item.recipientDomain ? ` · recipient @${escapeHtml(item.recipientDomain)}` : ''}`;
  const lockLine = `${item.recipientLocked ? 'Recipient-locked' : 'Recipient not locked'}`
    + ` · ${item.autoSendEligible ? 'auto-send ELIGIBLE' : 'auto-send disabled'}`
    + ` · ${escapeHtml(formatToken(item.authorship))} authored`
    + `${item.requiresReview ? ' · review required' : ''}`;
  const provenanceLine = item.provenance
    ? `Draft provenance recorded${item.routeAlias ? ` · route ${escapeHtml(item.routeAlias)}` : ''} · usage trust ${escapeHtml(formatToken(item.provenance.usageTrust))}`
    : 'No draft-provenance receipt recorded';
  const sendLine = item.send
    ? `Send-request ${escapeHtml(item.send.requestId)} → ${escapeHtml(formatToken(item.send.sink))} sink · not delivered · emitted ${escapeHtml(formatDate(item.send.emittedAt))}`
    : 'No send-request emitted';
  const receiptLine = item.receipt
    ? `Send receipt ${escapeHtml(item.receipt.receiptId)} · ${escapeHtml(formatToken(item.receipt.status))}${item.receipt.hasProviderMessageId ? ' · provider message id recorded' : ''} · ${escapeHtml(formatDate(item.receipt.receiptAt))}`
    : 'No send receipt correlated';
  const digests = renderLifecycleDigests([
    ['Draft proposal digest', item.digests.draftProposalDigest],
    ['Approved artifact digest', item.digests.approvedArtifactDigest],
    ['Send-request digest', item.digests.requestDigest],
    ['Issued request digest', item.digests.issuedRequestDigest],
    ['Source-state digest', item.digests.sourceStateSha256],
    ['Send-receipt digest', item.digests.receiptDigest]
  ]);
  return `<li>
    <div class="entry-title"><strong>Reply draft ${escapeHtml(item.proposalId)}</strong><span class="pill ${statePillClass}">${escapeHtml(stateLabel)}</span><span class="pill pill-neutral">review ${escapeHtml(formatToken(item.reviewState))}</span></div>
    <p class="activity">${escapeHtml(lockLine)}</p>
    <p class="activity">${registerLine} · ${application}</p>
    <p class="activity">${escapeHtml(provenanceLine)}</p>
    <p class="activity">${sendLine}</p>
    <p class="activity">${receiptLine}</p>
    <p class="activity">Drafted ${escapeHtml(formatDate(item.timestamps.draftedAt))}${item.timestamps.emittedAt ? ` · emitted ${escapeHtml(formatDate(item.timestamps.emittedAt))}` : ''}${item.timestamps.receiptAt ? ` · receipt ${escapeHtml(formatDate(item.timestamps.receiptAt))}` : ''}</p>
    ${digests}
  </li>`;
}

// Digests are collapsed identifiers, not content. Show a truncated form; each is
// a bare SHA-256 that carries no recoverable prose.
function renderLifecycleDigests(entries) {
  const rows = entries.filter(([, value]) => value);
  if (!rows.length) return '';
  return `<div class="lifecycle-digests">${rows.map(([label, value]) => `<div><span class="label">${escapeHtml(label)}</span><code>${escapeHtml(String(value).slice(0, 16))}…</code></div>`).join('')}</div>`;
}

function describeOutgoingState(state) {
  return V2_STATE_LABELS[state] || formatToken(state);
}

function outgoingStateIsMuted(state) {
  return V2_MUTED_STATES.has(state);
}

module.exports = { renderReplyLifecyclePage, describeOutgoingState, outgoingStateIsMuted };
