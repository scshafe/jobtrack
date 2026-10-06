'use strict';

function resolve(candidates, identity, policy) {
  const exactSet = new Set(policy.exactBases);
  const exact = candidates.filter((candidate) => exactSet.has(candidate.matchBasis));
  const exactApplications = new Set(exact.map((candidate) => candidate.applicationId));
  if (exactApplications.size === 1) {
    const applicationId = [...exactApplications][0];
    const resolved = exact.find((candidate) => candidate.applicationId === applicationId);
    const exactIsThreadOnly = exact.every((candidate) =>
      candidate.matchBasis === 'previously_linked_thread'
    );
    const bodyRoleApplications = new Set(candidates
      .filter((candidate) => candidate.matchBasis === 'body_role_title')
      .map((candidate) => candidate.applicationId));
    // Providers may coalesce unrelated messages with the same generic subject
    // into one thread. Preserve that evidence for review, but never let a
    // thread-only exact match silently override one unique, grounded role title
    // that points at a different application. Stronger exact identifiers keep
    // their existing behavior.
    if (exactIsThreadOnly && bodyRoleApplications.size === 1
      && !bodyRoleApplications.has(applicationId)) {
      return {
        resolution: 'ambiguous',
        preferredCandidateId: [...bodyRoleApplications][0],
        automaticEligible: false,
        clarifiable: false
      };
    }
    return {
      resolution: 'linked',
      resolved,
      automaticEligible: Boolean(policy.autoLink.normalizedExact && exactCandidateIsNormalized(resolved)),
      clarifiable: false
    };
  }

  const singleOpen = candidates.filter((candidate) => candidate.matchBasis === 'company_single_open');
  const singleOpenApplications = new Set(singleOpen.map((candidate) => candidate.applicationId));
  if (exactApplications.size === 0 && policy.autoLink.companySingleOpen && singleOpenApplications.size === 1) {
    return {
      resolution: 'linked',
      resolved: singleOpen[0],
      automaticEligible: false,
      clarifiable: false
    };
  }

  if (candidates.length === 0) {
    return { resolution: 'unmatched', automaticEligible: false, clarifiable: false };
  }

  const distinctApplications = [...new Set(candidates.map((candidate) => candidate.applicationId))];
  const best = bestPerApplication(candidates, policy);
  const winner = best[0];
  const runnerUp = best[1];
  const preferred = winner
    && distinctApplications.length >= 2
    && winner.confidence >= policy.thresholds.preferredConfidence
    && (!runnerUp || winner.confidence - runnerUp.confidence >= policy.thresholds.preferredMargin)
    ? winner.applicationId
    : undefined;
  const companies = new Set(candidates.map((candidate) => candidate.companyId).filter(Number.isInteger));
  const everyCandidateHasCompany = candidates.every((candidate) => Number.isInteger(candidate.companyId));
  const clarifiable = Boolean(
    policy.clarify.enabled
    && identity.messageClarifiable
    && preferred === undefined
    && distinctApplications.length >= policy.clarify.minimumCandidates
    && (!policy.clarify.sameCompany || (identity.companyIds.length === 1 && companies.size === 1 && everyCandidateHasCompany))
  );
  return {
    resolution: 'ambiguous',
    ...(preferred ? { preferredCandidateId: preferred } : {}),
    automaticEligible: false,
    clarifiable
  };
}

function bestPerApplication(candidates, policy) {
  const byApplication = new Map();
  for (const candidate of candidates) {
    const current = byApplication.get(candidate.applicationId);
    if (!current || compare(candidate, current, policy) < 0) byApplication.set(candidate.applicationId, candidate);
  }
  return [...byApplication.values()].sort((left, right) => compare(left, right, policy));
}

function compare(left, right, policy) {
  return (policy.priorities[right.matchBasis] - policy.priorities[left.matchBasis])
    || right.confidence - left.confidence
    || left.applicationId - right.applicationId;
}

function exactCandidateIsNormalized(candidate) {
  if (candidate.matchBasis === 'exact_posting_url') return false;
  if (candidate.matchBasis === 'exact_posting_occurrence') return Boolean(candidate.postingId || candidate.postingOccurrenceId);
  return ['provider_application_id', 'clarification_reply', 'previously_linked_message', 'previously_linked_thread'].includes(candidate.matchBasis);
}

module.exports = { exactCandidateIsNormalized, resolve };
