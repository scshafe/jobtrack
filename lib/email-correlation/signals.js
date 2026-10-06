'use strict';

const { normalizeDomain } = require('./domain-classes');
const { normalizeMentionText } = require('./normalize');

const APPLICATION_EVENT_KINDS = new Set([
  'application_received', 'action_required', 'interview_invite', 'interview_rescheduled',
  'interview_cancelled', 'rejection', 'offer', 'withdrawal_confirmed', 'recruiter_followup'
]);

const ROLE_TITLE_MATCH_EVIDENCE_KIND = 'role_title_match';

function extractSignals(facts) {
  const bodyExcerpts = (facts.evidence || [])
    .filter((item) => item?.field === 'body' && typeof item.excerpt === 'string')
    .map((item) => ({ excerpt: item.excerpt, normalized: normalizeMentionText(item.excerpt) }));
  const roleMentions = (facts.postingRefs || [])
    .map((reference, referenceIndex) => ({ reference, referenceIndex }))
    .filter(({ reference }) => typeof reference?.roleTitle === 'string')
    .map(({ reference, referenceIndex }) => {
      const value = reference.roleTitle.trim();
      const normalized = normalizeMentionText(value);
      const groundedBodyExcerpts = bodyExcerpts.filter((body) =>
        normalized && (body.normalized.includes(normalized) || normalized.includes(body.normalized))
      );
      return { kind: 'role_title', value, normalized, referenceIndex, groundedBodyExcerpts };
    })
    .filter((signal) => signal.normalized);
  const postingSignals = (facts.postingRefs || []).filter((reference) =>
    Boolean(reference?.url || reference?.externalJobId)
  );
  const subject = (facts.evidence || [])
    .filter((item) => item?.field === 'subject' && typeof item.excerpt === 'string')
    .map((item) => item.excerpt)
    .join(' ');
  const bodyRoleMention = roleMentions.some((mention) => mention.groundedBodyExcerpts.length > 0);
  const applicationSpecific = APPLICATION_EVENT_KINDS.has(facts.eventKind)
    || (facts.applicationRefs || []).length > 0
    || postingSignals.length > 0
    || Boolean(facts.interview)
    || Boolean(facts.requestedAction)
    || bodyRoleMention;
  const clarifiable = Boolean(
    facts.replyRequested
    || facts.requestedAction?.kind === 'reply'
    || facts.requestedAction?.kind === 'schedule'
    || facts.interview?.intent === 'schedule'
    || facts.interview?.intent === 'reschedule'
  );

  return Object.freeze({
    facts,
    sender: Object.freeze({
      address: String(facts.source?.fromAddress || '').trim().toLowerCase(),
      domain: normalizeDomain(facts.source?.fromDomain),
      displayName: String(facts.source?.fromDisplayName || '').trim()
    }),
    company: Object.freeze({
      name: String(facts.company?.name || '').trim(),
      domain: normalizeDomain(facts.company?.domain)
    }),
    subject: Object.freeze({ value: subject, normalized: normalizeMentionText(subject) }),
    bodyExcerpts: Object.freeze(bodyExcerpts),
    roleMentions: Object.freeze(roleMentions),
    applicationSpecific,
    bodyRoleMention,
    clarifiable
  });
}

function roleTitleMatchEvidence(applicationId, referenceIndex) {
  const normalizedApplicationId = Number(applicationId);
  const normalizedReferenceIndex = Number(referenceIndex);
  if (!Number.isInteger(normalizedApplicationId) || normalizedApplicationId < 1
    || !Number.isInteger(normalizedReferenceIndex) || normalizedReferenceIndex < 0) return null;
  return Object.freeze({
    kind: ROLE_TITLE_MATCH_EVIDENCE_KIND,
    value: `application:${normalizedApplicationId}:posting-ref:${normalizedReferenceIndex}`
  });
}

function matchedRoleTitleReferenceIndexes(correlation, applicationId) {
  const selectedApplicationId = Number(applicationId);
  if (!correlation || !Number.isInteger(selectedApplicationId) || selectedApplicationId < 1) return [];
  const indexes = new Set();
  for (const entry of correlation.evidence || []) {
    if (entry?.kind !== ROLE_TITLE_MATCH_EVIDENCE_KIND || typeof entry.value !== 'string') continue;
    const match = /^application:([1-9][0-9]*):posting-ref:(0|[1-9][0-9]*)$/.exec(entry.value);
    if (!match || Number(match[1]) !== selectedApplicationId) continue;
    const referenceIndex = Number(match[2]);
    if (Number.isSafeInteger(referenceIndex)) indexes.add(referenceIndex);
  }
  return [...indexes].sort((left, right) => left - right);
}

function prioritizeRoleTitleMatchEvidence(evidence, applicationId) {
  const entries = Array.isArray(evidence) ? evidence : [];
  const selectedApplicationId = Number(applicationId);
  const selectedPrefix = Number.isInteger(selectedApplicationId) && selectedApplicationId > 0
    ? `application:${selectedApplicationId}:posting-ref:`
    : null;
  const selected = [];
  const otherMatches = [];
  const remaining = [];
  for (const entry of entries) {
    if (entry?.kind !== ROLE_TITLE_MATCH_EVIDENCE_KIND || typeof entry.value !== 'string') {
      remaining.push(entry);
    } else if (selectedPrefix && entry.value.startsWith(selectedPrefix)) {
      selected.push(entry);
    } else {
      otherMatches.push(entry);
    }
  }
  return [...selected, ...otherMatches, ...remaining];
}

module.exports = {
  APPLICATION_EVENT_KINDS,
  ROLE_TITLE_MATCH_EVIDENCE_KIND,
  extractSignals,
  matchedRoleTitleReferenceIndexes,
  prioritizeRoleTitleMatchEvidence,
  roleTitleMatchEvidence
};
