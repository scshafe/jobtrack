'use strict';

const crypto = require('node:crypto');

const factsJsonSchema = require('../contracts/email/job-application-email-facts.v1.schema.json');
const factsV2JsonSchema = require('../contracts/email/job-application-email-facts.v2.schema.json');
const correlationJsonSchema = require('../contracts/email/jobtrack-correlation-result.v1.schema.json');
const correlationV2JsonSchema = require('../contracts/email/jobtrack-correlation-result.v2.schema.json');
const correlationV3JsonSchema = require('../contracts/email/jobtrack-correlation-result.v3.schema.json');
const transitionJsonSchema = require('../contracts/email/jobtrack-transition-proposal.v1.schema.json');
const replyDraftJsonSchema = require('../contracts/email/email-reply-draft-proposal.v1.schema.json');
const demeanorObservationJsonSchema = require('../contracts/email/email-demeanor-observation.v1.schema.json');
const recipientStyleProfileJsonSchema = require('../contracts/email/email-recipient-style-profile.v1.schema.json');
const writingVoiceRevisionJsonSchema = require('../contracts/email/profile-writing-voice-revision.v1.schema.json');
const toneDecisionJsonSchema = require('../contracts/email/email-tone-decision.v1.schema.json');
const replyDraftV2JsonSchema = require('../contracts/email/email-reply-draft-proposal.v2.schema.json');
const usageReceiptJsonSchema = require('../contracts/execution/usage-receipt.v1.schema.json');
const draftProvenanceReceiptJsonSchema = require('../contracts/email/draft-provenance-receipt.v1.schema.json');
const approvalReceiptJsonSchema = require('../contracts/email/approval-receipt.v1.schema.json');
const emailSendRequestJsonSchema = require('../contracts/email/email-send-request.v1.schema.json');
const emailSendReceiptJsonSchema = require('../contracts/email/email-send-receipt.v1.schema.json');
const replyDraftV3JsonSchema = require('../contracts/email/email-reply-draft-proposal.v3.schema.json');
const emailApprovedContentJsonSchema = require('../contracts/email/email-approved-content.v1.schema.json');
const emailDraftReceiptJsonSchema = require('../contracts/email/email-draft-receipt.v1.schema.json');
const approvalReceiptV2JsonSchema = require('../contracts/email/approval-receipt.v2.schema.json');
const emailSendRequestV2JsonSchema = require('../contracts/email/email-send-request.v2.schema.json');
const emailSendReceiptV2JsonSchema = require('../contracts/email/email-send-receipt.v2.schema.json');
const outgoingV2 = require('./email-outgoing-v2-contracts');

const PROVIDERS = new Set(['gmail', 'fixture', 'manual']);
const PROVIDER_CODE_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/;
const COMPLETENESS = new Set(['metadata_only', 'sanitized_plain_text']);
const EVENT_KINDS = new Set([
  'application_received', 'action_required', 'interview_invite', 'interview_rescheduled',
  'interview_cancelled', 'rejection', 'offer', 'withdrawal_confirmed', 'recruiter_followup', 'unknown'
]);
const SECURITY_RISKS = new Set(['low', 'medium', 'high']);
const MATCH_BASES = new Set([
  'provider_application_id', 'previously_linked_message', 'previously_linked_thread',
  'exact_posting_occurrence', 'exact_posting_url', 'company_and_role', 'company_domain',
  'company_only', 'fuzzy',
  // execution-contracts 1.6.0 (2026-09-02): the correlation design's bases.
  // Only clarification_reply is exact; it joins EXACT_MATCH_BASES when R4 emits it.
  'sender_contact', 'company_mention', 'body_role_title', 'company_single_open', 'clarification_reply'
]);
const EXACT_MATCH_BASES = new Set([
  'provider_application_id', 'previously_linked_message', 'previously_linked_thread',
  'exact_posting_occurrence', 'exact_posting_url'
]);
const APPLICATION_STATUSES = new Set(['applied', 'interviewing', 'offer', 'rejected', 'withdrawn']);
const INTERVIEW_ROUNDS = new Set(['screen', 'technical', 'onsite', 'final']);
const INTERVIEW_FORMATS = new Set(['phone', 'video', 'onsite']);
const AUTOMATABLE_ACTIONS = new Set([
  'link_message', 'transition_application_status', 'create_interview', 'reschedule_interview', 'cancel_interview'
]);
const STYLE_DIMENSIONS = Object.freeze({
  formality: new Set(['casual', 'neutral', 'formal']),
  warmth: new Set(['reserved', 'neutral', 'warm']),
  energy: new Set(['restrained', 'neutral', 'upbeat']),
  directness: new Set(['direct', 'balanced', 'contextual']),
  verbosity: new Set(['terse', 'concise', 'moderate'])
});
const EMAIL_PURPOSES = new Set(['acknowledgement', 'scheduling', 'information_response', 'follow_up', 'other']);
const STYLE_RATIONALE_CODES = new Set([
  'cole_voice_baseline', 'thread_register', 'reviewed_contact_register', 'low_confidence_fallback',
  'scheduling_clarity', 'information_clarity', 'follow_up_brevity', 'conservative_context',
  'identity_mimicry_guard'
]);
// Shared execution-contracts (frozen v1 plus additive provider-neutral v2).
// JobTrack keeps hand-written validators (no ajv) that carry the code-side
// cross-field invariants documented in CONVENTIONS.md.
const USAGE_TRUST_TIERS = new Set([
  'provider_signed', 'provider_reported', 'estimated_tier_ceiling', 'unavailable'
]);
const CORPUS_SOURCE_KINDS = new Set([
  'profile-entry', 'writing-voice', 'past-communication', 'application-record', 'story-use',
  'material-revision', 'inbound-thread', 'inbox-facts', 'company-research'
]);
const SEND_RECEIPT_STATUSES = new Set(['sent', 'skipped_duplicate', 'failed']);
const SEND_RECEIPT_PROVIDERS = new Set(['gmail', 'fixture', 'manual']);
const ROUTE_ALIAS_PATTERN = /^[a-z][a-z0-9-]*$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CONTRACT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\.v[1-9][0-9]*$/;
const MICRO_USD_MAX = 100_000_000_000;
const TOKEN_COUNT_MAX = 10_000_000;

class EmailContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmailContractError';
    this.code = 'INVALID_EMAIL_CONTRACT';
  }
}

function validateJobApplicationEmailFacts(value) {
  if (value?.schemaVersion === 'job-application-email-facts.v2') {
    return validateJobApplicationEmailFactsV2(value);
  }
  return validateJobApplicationEmailFactsV1(value);
}

function validateJobApplicationEmailFactsV1(value) {
  return validateJobApplicationEmailFactsVersion(value, 'job-application-email-facts.v1', false);
}

function validateJobApplicationEmailFactsV2(value) {
  return validateJobApplicationEmailFactsVersion(value, 'job-application-email-facts.v2', true);
}

function validateJobApplicationEmailFactsVersion(value, schemaVersion, providerNeutral) {
  const root = plainObject(value, 'facts');
  exactKeys(root, 'facts', [
    'schemaVersion', 'trust', 'source', 'contentCompleteness', 'eventKind', 'company', 'postingRefs',
    'applicationRefs', 'interview', 'requestedAction', 'replyRequested', 'evidence', 'extraction', 'security'
  ], [
    'schemaVersion', 'trust', 'source', 'contentCompleteness', 'eventKind', 'postingRefs', 'applicationRefs',
    'replyRequested', 'evidence', 'extraction', 'security'
  ]);
  literal(root.schemaVersion, schemaVersion, 'facts.schemaVersion');
  literal(root.trust, 'untrusted_external', 'facts.trust');
  validateFactsSource(root.source, 'facts.source', providerNeutral);
  enumValue(root.contentCompleteness, COMPLETENESS, 'facts.contentCompleteness');
  enumValue(root.eventKind, EVENT_KINDS, 'facts.eventKind');
  if (root.company !== undefined) validateCompany(root.company, 'facts.company');
  array(root.postingRefs, 'facts.postingRefs', 20).forEach((entry, index) => validatePostingRef(entry, `facts.postingRefs[${index}]`));
  array(root.applicationRefs, 'facts.applicationRefs', 20).forEach((entry, index) => validateApplicationRef(entry, `facts.applicationRefs[${index}]`));
  if (root.interview !== undefined) validateInterviewFacts(root.interview, 'facts.interview');
  if (root.requestedAction !== undefined) validateRequestedAction(root.requestedAction, 'facts.requestedAction');
  boolean(root.replyRequested, 'facts.replyRequested');
  array(root.evidence, 'facts.evidence', 20).forEach((entry, index) => validateEvidence(entry, `facts.evidence[${index}]`));
  validateExtraction(root.extraction, 'facts.extraction');
  validateSecurity(root.security, 'facts.security');
  if (['interview_invite', 'interview_rescheduled', 'interview_cancelled'].includes(root.eventKind) && root.interview === undefined) {
    fail(`facts.interview is required for ${root.eventKind}`);
  }
  if (root.eventKind === 'interview_invite' && root.interview.intent !== 'schedule') fail('interview_invite requires interview.intent=schedule');
  if (root.eventKind === 'interview_rescheduled' && root.interview.intent !== 'reschedule') fail('interview_rescheduled requires interview.intent=reschedule');
  if (root.eventKind === 'interview_cancelled' && root.interview.intent !== 'cancel') fail('interview_cancelled requires interview.intent=cancel');
  return clone(root);
}

function validateCorrelationResult(value) {
  if (value?.schemaVersion === 'jobtrack-correlation-result.v3') {
    return validateCorrelationResultV3(value);
  }
  if (value?.schemaVersion === 'jobtrack-correlation-result.v2') {
    return validateCorrelationResultV2(value);
  }
  return validateCorrelationResultV1(value);
}

function validateCorrelationResultV1(value) {
  return validateCorrelationResultVersion(value, 'jobtrack-correlation-result.v1', false);
}

function validateCorrelationResultV2(value) {
  return validateCorrelationResultVersion(value, 'jobtrack-correlation-result.v2', true);
}

function validateCorrelationResultV3(value) {
  const root = plainObject(value, 'correlation');
  exactKeys(root, 'correlation', [
    'schemaVersion', 'source', 'factsDigest', 'policyRevisionId', 'identity', 'resolution',
    'resolved', 'preferredCandidateId', 'candidates', 'evidence', 'automaticEligible', 'clarifiable'
  ], [
    'schemaVersion', 'source', 'factsDigest', 'policyRevisionId', 'identity', 'resolution',
    'candidates', 'evidence', 'automaticEligible', 'clarifiable'
  ]);
  literal(root.schemaVersion, 'jobtrack-correlation-result.v3', 'correlation.schemaVersion');
  validateMessageRef(root.source, 'correlation.source', true);
  sha256(root.factsDigest, 'correlation.factsDigest');
  positiveInteger(root.policyRevisionId, 'correlation.policyRevisionId');
  const identity = plainObject(root.identity, 'correlation.identity');
  exactKeys(identity, 'correlation.identity', ['companyIds', 'basis', 'confidence'], ['companyIds', 'basis', 'confidence']);
  const companyIds = array(identity.companyIds, 'correlation.identity.companyIds', 50);
  companyIds.forEach((id, index) => positiveInteger(id, `correlation.identity.companyIds[${index}]`));
  if (new Set(companyIds).size !== companyIds.length) fail('correlation.identity.companyIds must be unique');
  enumValue(identity.basis, new Set(['contact', 'domain', 'mention', 'none']), 'correlation.identity.basis');
  numberRange(identity.confidence, 'correlation.identity.confidence', 0, 1);
  if (identity.basis === 'none') {
    if (companyIds.length !== 0 || identity.confidence !== 0) fail('correlation.identity none requires no company ids and zero confidence');
  } else if (companyIds.length === 0 || identity.confidence <= 0) {
    fail('correlation.identity non-none requires company ids and positive confidence');
  }
  enumValue(root.resolution, new Set(['linked', 'ambiguous', 'unmatched']), 'correlation.resolution');
  const candidates = array(root.candidates, 'correlation.candidates', 50).map((entry, index) => validateCandidate(entry, `correlation.candidates[${index}]`));
  validateCorrelationEvidence(root.evidence);
  boolean(root.automaticEligible, 'correlation.automaticEligible');
  boolean(root.clarifiable, 'correlation.clarifiable');

  if (root.resolution === 'linked') {
    if (root.resolved === undefined) fail('linked correlation requires correlation.resolved');
    const resolved = validateCandidate(root.resolved, 'correlation.resolved');
    if (!candidates.some((candidate) => sameCandidate(candidate, resolved))) fail('correlation.resolved must be present in candidates');
    if (root.automaticEligible && !exactCorrelationCandidateV3(resolved)) {
      fail('correlation.automaticEligible true requires an exact normalized correlation');
    }
    if (root.preferredCandidateId !== undefined) fail('linked correlation cannot include correlation.preferredCandidateId');
    if (root.clarifiable) fail('linked correlation cannot be clarifiable');
  } else {
    if (root.resolved !== undefined) fail(`${root.resolution} correlation cannot include correlation.resolved`);
    if (root.automaticEligible) fail(`${root.resolution} correlation cannot be automatically eligible`);
    if (root.resolution === 'unmatched') {
      if (candidates.length !== 0) fail('unmatched correlation cannot contain candidates');
      if (root.preferredCandidateId !== undefined) fail('unmatched correlation cannot include correlation.preferredCandidateId');
      if (root.clarifiable) fail('unmatched correlation cannot be clarifiable');
    } else {
      if (candidates.length === 0) fail('ambiguous correlation requires at least one candidate');
      if (root.preferredCandidateId !== undefined) {
        positiveInteger(root.preferredCandidateId, 'correlation.preferredCandidateId');
        if (!candidates.some((candidate) => candidate.applicationId === root.preferredCandidateId)) {
          fail('correlation.preferredCandidateId must match a candidate applicationId');
        }
      }
      if (root.clarifiable) {
        const applications = new Set(candidates.map((candidate) => candidate.applicationId));
        const companies = new Set(candidates.map((candidate) => candidate.companyId));
        if (applications.size < 2 || companies.has(undefined) || companies.size !== 1) {
          fail('clarifiable correlation requires at least two applications sharing one company');
        }
      }
    }
  }
  return clone(root);
}

function validateCorrelationEvidence(value) {
  array(value, 'correlation.evidence', 30).forEach((entry, index) => {
    const evidence = plainObject(entry, `correlation.evidence[${index}]`);
    exactKeys(evidence, `correlation.evidence[${index}]`, ['kind', 'value'], ['kind', 'value']);
    boundedString(evidence.kind, `correlation.evidence[${index}].kind`, 1, 100);
    boundedString(evidence.value, `correlation.evidence[${index}].value`, 1, 500);
  });
}

function validateCorrelationResultVersion(value, schemaVersion, providerNeutral) {
  const root = plainObject(value, 'correlation');
  exactKeys(root, 'correlation', [
    'schemaVersion', 'source', 'factsDigest', 'resolution', 'resolved', 'candidates', 'evidence', 'automaticEligible'
  ], ['schemaVersion', 'source', 'factsDigest', 'resolution', 'candidates', 'evidence', 'automaticEligible']);
  literal(root.schemaVersion, schemaVersion, 'correlation.schemaVersion');
  validateMessageRef(root.source, 'correlation.source', providerNeutral);
  sha256(root.factsDigest, 'correlation.factsDigest');
  enumValue(root.resolution, new Set(['linked', 'ambiguous', 'unmatched']), 'correlation.resolution');
  const candidates = array(root.candidates, 'correlation.candidates', 50).map((entry, index) => validateCandidate(entry, `correlation.candidates[${index}]`));
  array(root.evidence, 'correlation.evidence', 30).forEach((entry, index) => {
    const evidence = plainObject(entry, `correlation.evidence[${index}]`);
    exactKeys(evidence, `correlation.evidence[${index}]`, ['kind', 'value'], ['kind', 'value']);
    boundedString(evidence.kind, `correlation.evidence[${index}].kind`, 1, 100);
    boundedString(evidence.value, `correlation.evidence[${index}].value`, 1, 500);
  });
  boolean(root.automaticEligible, 'correlation.automaticEligible');
  if (root.resolution === 'linked') {
    if (root.resolved === undefined) fail('linked correlation requires correlation.resolved');
    const resolved = validateCandidate(root.resolved, 'correlation.resolved');
    if (!candidates.some((candidate) => sameCandidate(candidate, resolved))) fail('correlation.resolved must be present in candidates');
    const exact = exactCorrelationCandidate(resolved);
    if (root.automaticEligible !== exact) fail('correlation.automaticEligible must reflect an exact normalized correlation');
  } else {
    if (root.resolved !== undefined) fail(`${root.resolution} correlation cannot include correlation.resolved`);
    if (root.automaticEligible) fail(`${root.resolution} correlation cannot be automatically eligible`);
    if (root.resolution === 'ambiguous' && candidates.length === 0) fail('ambiguous correlation requires at least one candidate');
    if (root.resolution === 'unmatched' && candidates.length !== 0) fail('unmatched correlation cannot contain candidates');
  }
  return clone(root);
}

function validateTransitionProposal(value) {
  const root = plainObject(value, 'transitionProposal');
  exactKeys(root, 'transitionProposal', [
    'schemaVersion', 'proposalId', 'source', 'factsDigest', 'correlationDigest', 'target',
    'expectedApplicationVersion', 'correlation', 'safety', 'action', 'policyCandidate',
    'requiresReview', 'automationEligible', 'evidence'
  ], [
    'schemaVersion', 'proposalId', 'source', 'factsDigest', 'correlationDigest', 'target',
    'expectedApplicationVersion', 'correlation', 'safety', 'action', 'policyCandidate',
    'requiresReview', 'automationEligible', 'evidence'
  ]);
  literal(root.schemaVersion, 'jobtrack-transition-proposal.v1', 'transitionProposal.schemaVersion');
  identifier(root.proposalId, 'transitionProposal.proposalId');
  // HIGH-5: provider-neutral source. The proposal only echoes a provider that is
  // re-bound to a stored message by proposeTransition (requireMessageRef), so a
  // provider-neutral code (e.g. apple_mail_emlx) is safe here — accepting it lets
  // the v2 mailbox path reach the transition lane. Provider-neutral is a superset
  // of the legacy {gmail, fixture, manual} enum, so every prior proposal stays valid.
  validateMessageRef(root.source, 'transitionProposal.source', true);
  sha256(root.factsDigest, 'transitionProposal.factsDigest');
  sha256(root.correlationDigest, 'transitionProposal.correlationDigest');
  validateTarget(root.target, 'transitionProposal.target');
  nonnegativeInteger(root.expectedApplicationVersion, 'transitionProposal.expectedApplicationVersion');
  const correlation = validateProposalCorrelation(root.correlation, 'transitionProposal.correlation');
  const safety = validateProposalSafety(root.safety, 'transitionProposal.safety');
  const action = validateAction(root.action, 'transitionProposal.action');
  enumValue(root.policyCandidate, new Set(['never', 'exact_link', 'exact_status', 'exact_interview']), 'transitionProposal.policyCandidate');
  const expectedPolicyCandidate = action.kind === 'link_message'
    ? 'exact_link'
    : action.kind === 'transition_application_status'
      ? 'exact_status'
      : ['create_interview', 'reschedule_interview', 'cancel_interview'].includes(action.kind)
        ? 'exact_interview'
        : 'never';
  if (root.policyCandidate !== expectedPolicyCandidate) {
    fail(`transitionProposal.policyCandidate must equal ${expectedPolicyCandidate} for ${action.kind}`);
  }
  boolean(root.requiresReview, 'transitionProposal.requiresReview');
  boolean(root.automationEligible, 'transitionProposal.automationEligible');
  if ((safety.contentCompleteness === 'metadata_only' || safety.securityRisk !== 'low' || safety.sourceRequiresReview)
    && !root.requiresReview) {
    fail('transitionProposal.requiresReview must be true for incomplete or security-gated source facts');
  }
  const evidence = array(root.evidence, 'transitionProposal.evidence', 20);
  if (evidence.length === 0) fail('transitionProposal.evidence requires at least one item');
  evidence.forEach((item, index) => boundedString(item, `transitionProposal.evidence[${index}]`, 1, 500));
  if (['reschedule_interview', 'cancel_interview'].includes(action.kind)) {
    if (root.target.interviewId !== action.interviewId) fail('transition proposal target.interviewId must equal action.interviewId');
  }
  if (action.kind === 'create_interview' && root.target.interviewId !== undefined) fail('create_interview target must not already identify an interview');
  const exact = EXACT_MATCH_BASES.has(correlation.matchBasis)
    // A URL-only match may link a record for review, but automation requires
    // either a normalized posting occurrence or another durable exact identity.
    && correlation.matchBasis !== 'exact_posting_url'
    && (correlation.matchBasis !== 'exact_posting_occurrence'
      || root.target.postingId !== undefined
      || root.target.postingOccurrenceId !== undefined);
  const computedAutomation = exact
    && safety.contentCompleteness === 'sanitized_plain_text'
    && safety.securityRisk === 'low'
    && safety.sourceRequiresReview === false
    && AUTOMATABLE_ACTIONS.has(action.kind)
    && root.policyCandidate !== 'never'
    && root.requiresReview === false;
  if (root.automationEligible !== computedAutomation) {
    fail('transitionProposal.automationEligible does not satisfy exact-correlation and safety requirements');
  }
  if (['record_offer', 'record_requested_action'].includes(action.kind) && !root.requiresReview) {
    fail(`${action.kind} proposals always require review`);
  }
  return clone(root);
}

function validateReplyDraftProposal(value) {
  if (value && value.schemaVersion === 'email-reply-draft-proposal.v2') return validateReplyDraftProposalV2(value);
  const root = plainObject(value, 'replyDraft');
  exactKeys(root, 'replyDraft', [
    'schemaVersion', 'proposalId', 'factsDigest', 'source', 'recipient', 'subject', 'body', 'bodyDigest',
    'purpose', 'authorship', 'templateId', 'expiresAt', 'sensitiveDataScan', 'requiresReview', 'autoSendEligible'
  ], [
    'schemaVersion', 'proposalId', 'factsDigest', 'source', 'recipient', 'subject', 'body', 'bodyDigest',
    'purpose', 'authorship', 'expiresAt', 'sensitiveDataScan', 'requiresReview', 'autoSendEligible'
  ]);
  literal(root.schemaVersion, 'email-reply-draft-proposal.v1', 'replyDraft.schemaVersion');
  identifier(root.proposalId, 'replyDraft.proposalId');
  sha256(root.factsDigest, 'replyDraft.factsDigest');
  const source = validateReplySource(root.source, 'replyDraft.source');
  email(root.recipient, 'replyDraft.recipient');
  if (root.recipient.toLowerCase() !== source.replyToAddress.toLowerCase()) fail('replyDraft.recipient must equal source.replyToAddress');
  boundedString(root.subject, 'replyDraft.subject', 1, 998);
  boundedString(root.body, 'replyDraft.body', 1, 20_000);
  sha256(root.bodyDigest, 'replyDraft.bodyDigest');
  if (digest(root.body) !== root.bodyDigest) fail('replyDraft.bodyDigest does not match replyDraft.body');
  enumValue(root.purpose, EMAIL_PURPOSES, 'replyDraft.purpose');
  enumValue(root.authorship, new Set(['template', 'model', 'human']), 'replyDraft.authorship');
  if (root.templateId !== undefined) identifier(root.templateId, 'replyDraft.templateId');
  if (root.authorship === 'template' && root.templateId === undefined) fail('template-authored reply drafts require templateId');
  dateTime(root.expiresAt, 'replyDraft.expiresAt');
  enumValue(root.sensitiveDataScan, new Set(['passed', 'requires_review']), 'replyDraft.sensitiveDataScan');
  boolean(root.requiresReview, 'replyDraft.requiresReview');
  literal(root.autoSendEligible, false, 'replyDraft.autoSendEligible');
  if (root.authorship === 'model' && !root.requiresReview) fail('model-authored reply drafts require review');
  if (root.sensitiveDataScan === 'requires_review' && !root.requiresReview) fail('reply drafts with sensitive-data findings require review');
  return clone(root);
}

function validateDemeanorObservation(value) {
  const root = plainObject(value, 'demeanorObservation');
  exactKeys(root, 'demeanorObservation', [
    'schemaVersion', 'observationId', 'source', 'factsDigest', 'contentDigest', 'authorship',
    'dimensions', 'surfaceSignals', 'confidence', 'evidence', 'extraction', 'security', 'profileEligible'
  ], [
    'schemaVersion', 'observationId', 'source', 'factsDigest', 'contentDigest', 'authorship',
    'dimensions', 'surfaceSignals', 'confidence', 'evidence', 'extraction', 'security', 'profileEligible'
  ]);
  literal(root.schemaVersion, 'email-demeanor-observation.v1', 'demeanorObservation.schemaVersion');
  identifier(root.observationId, 'demeanorObservation.observationId');
  validateMessageRef(root.source, 'demeanorObservation.source');
  sha256(root.factsDigest, 'demeanorObservation.factsDigest');
  sha256(root.contentDigest, 'demeanorObservation.contentDigest');
  enumValue(root.authorship, new Set(['human', 'automated', 'unknown']), 'demeanorObservation.authorship');
  validateStyleDimensions(root.dimensions, 'demeanorObservation.dimensions', true);
  validateSurfaceSignals(root.surfaceSignals, 'demeanorObservation.surfaceSignals');
  numberRange(root.confidence, 'demeanorObservation.confidence', 0, 1);
  const evidence = array(root.evidence, 'demeanorObservation.evidence', 20);
  if (evidence.length < 1) fail('demeanorObservation.evidence requires at least one item');
  evidence.forEach((entry, index) => validateStyleEvidence(entry, `demeanorObservation.evidence[${index}]`));
  validateStyleGenerator(root.extraction, 'demeanorObservation.extraction', 'register-observation.v1');
  const security = plainObject(root.security, 'demeanorObservation.security');
  exactKeys(security, 'demeanorObservation.security', [
    'risk', 'promptInjectionDetected', 'sensitiveTraitInferenceDetected', 'personalityInferenceDetected', 'requiresReview'
  ], [
    'risk', 'promptInjectionDetected', 'sensitiveTraitInferenceDetected', 'personalityInferenceDetected', 'requiresReview'
  ]);
  enumValue(security.risk, SECURITY_RISKS, 'demeanorObservation.security.risk');
  for (const key of ['promptInjectionDetected', 'sensitiveTraitInferenceDetected', 'personalityInferenceDetected', 'requiresReview']) {
    boolean(security[key], `demeanorObservation.security.${key}`);
  }
  boolean(root.profileEligible, 'demeanorObservation.profileEligible');
  const computedEligible = root.authorship === 'human'
    && security.risk === 'low'
    && !security.promptInjectionDetected
    && !security.sensitiveTraitInferenceDetected
    && !security.personalityInferenceDetected
    && !security.requiresReview;
  if (root.profileEligible !== computedEligible) {
    fail('demeanorObservation.profileEligible must fail closed for automated, uncertain, risky, or inference-bearing observations');
  }
  return clone(root);
}

function validateRecipientStyleProfile(value) {
  const root = plainObject(value, 'styleProfile');
  exactKeys(root, 'styleProfile', [
    'schemaVersion', 'profileId', 'source', 'scope', 'version', 'observationIds', 'dimensions', 'delivery',
    'confidence', 'sample', 'safeguards', 'generatedBy', 'sourceStateSha256', 'requiresReview'
  ], [
    'schemaVersion', 'profileId', 'source', 'scope', 'version', 'observationIds', 'dimensions', 'delivery',
    'confidence', 'sample', 'safeguards', 'generatedBy', 'sourceStateSha256', 'requiresReview'
  ]);
  literal(root.schemaVersion, 'email-recipient-style-profile.v1', 'styleProfile.schemaVersion');
  identifier(root.profileId, 'styleProfile.profileId');
  validateMessageRef(root.source, 'styleProfile.source');
  const scope = validateStyleScope(root.scope, 'styleProfile.scope');
  positiveInteger(root.version, 'styleProfile.version');
  const observationIds = array(root.observationIds, 'styleProfile.observationIds', 8);
  if (observationIds.length < 1) fail('styleProfile.observationIds requires at least one item');
  observationIds.forEach((entry, index) => identifier(entry, `styleProfile.observationIds[${index}]`));
  if (new Set(observationIds).size !== observationIds.length) fail('styleProfile.observationIds must be unique');
  validateStyleDimensions(root.dimensions, 'styleProfile.dimensions', true);
  validateStyleDelivery(root.delivery, 'styleProfile.delivery', { profile: true });
  enumValue(root.confidence, new Set(['low', 'medium', 'high']), 'styleProfile.confidence');
  const sample = plainObject(root.sample, 'styleProfile.sample');
  exactKeys(sample, 'styleProfile.sample', [
    'eligibleMessageCount', 'distinctThreadCount', 'firstObservedAt', 'lastObservedAt'
  ], ['eligibleMessageCount', 'distinctThreadCount', 'firstObservedAt', 'lastObservedAt']);
  integerRange(sample.eligibleMessageCount, 'styleProfile.sample.eligibleMessageCount', 1, 8);
  integerRange(sample.distinctThreadCount, 'styleProfile.sample.distinctThreadCount', 1, 8);
  dateTime(sample.firstObservedAt, 'styleProfile.sample.firstObservedAt');
  dateTime(sample.lastObservedAt, 'styleProfile.sample.lastObservedAt');
  if (Date.parse(sample.firstObservedAt) > Date.parse(sample.lastObservedAt)) fail('styleProfile sample dates are reversed');
  if (sample.eligibleMessageCount !== observationIds.length) fail('styleProfile sample count must equal observationIds length');
  if (sample.distinctThreadCount > sample.eligibleMessageCount) fail('styleProfile distinct thread count exceeds sample count');
  if (scope.kind === 'thread' && sample.distinctThreadCount !== 1) fail('thread style profiles must contain exactly one thread');
  if (scope.kind === 'contact' && (sample.eligibleMessageCount < 3 || sample.distinctThreadCount < 2)) {
    fail('contact style profiles require at least three eligible messages across two threads');
  }
  validateSafeguards(root.safeguards, 'styleProfile.safeguards');
  validateStyleGenerator(root.generatedBy, 'styleProfile.generatedBy', 'register-adaptation.v1');
  sha256(root.sourceStateSha256, 'styleProfile.sourceStateSha256');
  literal(root.requiresReview, true, 'styleProfile.requiresReview');
  return clone(root);
}

function validateWritingVoiceRevision(value) {
  const root = plainObject(value, 'writingVoice');
  exactKeys(root, 'writingVoice', [
    'schemaVersion', 'voiceKey', 'revisionId', 'version', 'label', 'dimensions', 'delivery',
    'ownership', 'sampleDigests', 'authoredBy', 'createdAt', 'requiresReview'
  ], [
    'schemaVersion', 'voiceKey', 'revisionId', 'version', 'label', 'dimensions', 'delivery',
    'ownership', 'sampleDigests', 'authoredBy', 'createdAt', 'requiresReview'
  ]);
  literal(root.schemaVersion, 'profile-writing-voice-revision.v1', 'writingVoice.schemaVersion');
  identifier(root.voiceKey, 'writingVoice.voiceKey');
  identifier(root.revisionId, 'writingVoice.revisionId');
  positiveInteger(root.version, 'writingVoice.version');
  boundedString(root.label, 'writingVoice.label', 1, 200);
  validateStyleDimensions(root.dimensions, 'writingVoice.dimensions', false);
  validateStyleDelivery(root.delivery, 'writingVoice.delivery', { voice: true });
  const ownership = plainObject(root.ownership, 'writingVoice.ownership');
  exactKeys(ownership, 'writingVoice.ownership', ['owner', 'source', 'attestedBy', 'attestedAt'], ['owner', 'source', 'attestedBy', 'attestedAt']);
  literal(ownership.owner, 'Cole', 'writingVoice.ownership.owner');
  enumValue(ownership.source, new Set(['manual', 'cole_owned_samples']), 'writingVoice.ownership.source');
  literal(ownership.attestedBy, 'Cole', 'writingVoice.ownership.attestedBy');
  dateTime(ownership.attestedAt, 'writingVoice.ownership.attestedAt');
  const samples = array(root.sampleDigests, 'writingVoice.sampleDigests', 8);
  samples.forEach((sample, index) => sha256(sample, `writingVoice.sampleDigests[${index}]`));
  if (new Set(samples).size !== samples.length) fail('writingVoice.sampleDigests must be unique');
  if (ownership.source === 'cole_owned_samples' && samples.length === 0) fail('Cole-owned-sample voices require sample digests');
  boundedString(root.authoredBy, 'writingVoice.authoredBy', 1, 200);
  dateTime(root.createdAt, 'writingVoice.createdAt');
  literal(root.requiresReview, true, 'writingVoice.requiresReview');
  return clone(root);
}

function validateToneDecision(value) {
  const root = plainObject(value, 'toneDecision');
  exactKeys(root, 'toneDecision', [
    'schemaVersion', 'decisionId', 'source', 'factsDigest', 'purpose', 'styleProfileId',
    'styleProfileDigest', 'voiceRevisionId', 'voiceRevisionDigest', 'selected', 'policy',
    'rationaleCodes', 'generatedBy', 'sourceStateSha256', 'requiresReview'
  ], [
    'schemaVersion', 'decisionId', 'source', 'factsDigest', 'purpose', 'voiceRevisionId',
    'voiceRevisionDigest', 'selected', 'policy', 'rationaleCodes', 'generatedBy',
    'sourceStateSha256', 'requiresReview'
  ]);
  literal(root.schemaVersion, 'email-tone-decision.v1', 'toneDecision.schemaVersion');
  identifier(root.decisionId, 'toneDecision.decisionId');
  validateMessageRef(root.source, 'toneDecision.source');
  sha256(root.factsDigest, 'toneDecision.factsDigest');
  enumValue(root.purpose, EMAIL_PURPOSES, 'toneDecision.purpose');
  pairedFields(root, 'styleProfileId', 'styleProfileDigest', 'toneDecision');
  if (root.styleProfileId !== undefined) identifier(root.styleProfileId, 'toneDecision.styleProfileId');
  if (root.styleProfileDigest !== undefined) sha256(root.styleProfileDigest, 'toneDecision.styleProfileDigest');
  identifier(root.voiceRevisionId, 'toneDecision.voiceRevisionId');
  sha256(root.voiceRevisionDigest, 'toneDecision.voiceRevisionDigest');
  const selected = plainObject(root.selected, 'toneDecision.selected');
  exactKeys(selected, 'toneDecision.selected', ['dimensions', 'delivery'], ['dimensions', 'delivery']);
  validateStyleDimensions(selected.dimensions, 'toneDecision.selected.dimensions', false);
  validateStyleDelivery(selected.delivery, 'toneDecision.selected.delivery', { tone: true });
  validateTonePolicy(root.policy, 'toneDecision.policy');
  const rationale = array(root.rationaleCodes, 'toneDecision.rationaleCodes', 8);
  if (rationale.length < 1) fail('toneDecision.rationaleCodes requires at least one item');
  rationale.forEach((code, index) => enumValue(code, STYLE_RATIONALE_CODES, `toneDecision.rationaleCodes[${index}]`));
  if (new Set(rationale).size !== rationale.length) fail('toneDecision.rationaleCodes must be unique');
  if (!rationale.includes('identity_mimicry_guard')) fail('toneDecision requires the identity_mimicry_guard rationale');
  validateStyleGenerator(root.generatedBy, 'toneDecision.generatedBy', 'register-adaptation.v1');
  sha256(root.sourceStateSha256, 'toneDecision.sourceStateSha256');
  literal(root.requiresReview, true, 'toneDecision.requiresReview');
  return clone(root);
}

function validateReplyDraftProposalV2(value) {
  const root = plainObject(value, 'replyDraft');
  exactKeys(root, 'replyDraft', [
    'schemaVersion', 'proposalId', 'factsDigest', 'source', 'recipient', 'subject', 'body', 'bodyDigest',
    'purpose', 'authorship', 'templateId', 'expiresAt', 'sensitiveDataScan', 'toneDecisionId',
    'toneDecisionDigest', 'styleProfileId', 'styleProfileDigest', 'voiceRevisionId',
    'voiceRevisionDigest', 'sourceStateSha256', 'registerAdaptationOnly', 'distinctivePhraseReuse',
    'requiresReview', 'autoSendEligible'
  ], [
    'schemaVersion', 'proposalId', 'factsDigest', 'source', 'recipient', 'subject', 'body', 'bodyDigest',
    'purpose', 'authorship', 'expiresAt', 'sensitiveDataScan', 'toneDecisionId', 'toneDecisionDigest',
    'voiceRevisionId', 'voiceRevisionDigest', 'sourceStateSha256', 'registerAdaptationOnly',
    'distinctivePhraseReuse', 'requiresReview', 'autoSendEligible'
  ]);
  literal(root.schemaVersion, 'email-reply-draft-proposal.v2', 'replyDraft.schemaVersion');
  identifier(root.proposalId, 'replyDraft.proposalId');
  sha256(root.factsDigest, 'replyDraft.factsDigest');
  const source = validateReplySource(root.source, 'replyDraft.source');
  email(root.recipient, 'replyDraft.recipient');
  if (root.recipient.toLowerCase() !== source.replyToAddress.toLowerCase()) fail('replyDraft.recipient must equal source.replyToAddress');
  boundedString(root.subject, 'replyDraft.subject', 1, 998);
  boundedString(root.body, 'replyDraft.body', 1, 20_000);
  sha256(root.bodyDigest, 'replyDraft.bodyDigest');
  if (digest(root.body) !== root.bodyDigest) fail('replyDraft.bodyDigest does not match replyDraft.body');
  enumValue(root.purpose, EMAIL_PURPOSES, 'replyDraft.purpose');
  enumValue(root.authorship, new Set(['template', 'model', 'human']), 'replyDraft.authorship');
  if (root.templateId !== undefined) identifier(root.templateId, 'replyDraft.templateId');
  if (root.authorship === 'template' && root.templateId === undefined) fail('template-authored reply drafts require templateId');
  dateTime(root.expiresAt, 'replyDraft.expiresAt');
  enumValue(root.sensitiveDataScan, new Set(['passed', 'requires_review']), 'replyDraft.sensitiveDataScan');
  identifier(root.toneDecisionId, 'replyDraft.toneDecisionId');
  sha256(root.toneDecisionDigest, 'replyDraft.toneDecisionDigest');
  pairedFields(root, 'styleProfileId', 'styleProfileDigest', 'replyDraft');
  if (root.styleProfileId !== undefined) identifier(root.styleProfileId, 'replyDraft.styleProfileId');
  if (root.styleProfileDigest !== undefined) sha256(root.styleProfileDigest, 'replyDraft.styleProfileDigest');
  identifier(root.voiceRevisionId, 'replyDraft.voiceRevisionId');
  sha256(root.voiceRevisionDigest, 'replyDraft.voiceRevisionDigest');
  sha256(root.sourceStateSha256, 'replyDraft.sourceStateSha256');
  literal(root.registerAdaptationOnly, true, 'replyDraft.registerAdaptationOnly');
  literal(root.distinctivePhraseReuse, false, 'replyDraft.distinctivePhraseReuse');
  literal(root.requiresReview, true, 'replyDraft.requiresReview');
  literal(root.autoSendEligible, false, 'replyDraft.autoSendEligible');
  if (root.sensitiveDataScan === 'requires_review' && !root.requiresReview) fail('reply drafts with sensitive-data findings require review');
  return clone(root);
}

function validateUsageReceipt(value, path = 'usage') {
  const root = plainObject(value, path);
  exactKeys(root, path, [
    'schemaVersion', 'trust', 'observedInputTokens', 'observedOutputTokens', 'chargedTokens',
    'observedCostMicroUsd', 'chargedCostMicroUsd', 'durationMs', 'routeAlias', 'signature'
  ], [
    'schemaVersion', 'trust', 'observedInputTokens', 'observedOutputTokens', 'chargedTokens',
    'observedCostMicroUsd', 'chargedCostMicroUsd', 'durationMs'
  ]);
  literal(root.schemaVersion, 'usage-receipt.v1', `${path}.schemaVersion`);
  enumValue(root.trust, USAGE_TRUST_TIERS, `${path}.trust`);
  nullableInteger(root.observedInputTokens, `${path}.observedInputTokens`, 0, TOKEN_COUNT_MAX);
  nullableInteger(root.observedOutputTokens, `${path}.observedOutputTokens`, 0, TOKEN_COUNT_MAX);
  integerRange(root.chargedTokens, `${path}.chargedTokens`, 0, TOKEN_COUNT_MAX);
  nullableInteger(root.observedCostMicroUsd, `${path}.observedCostMicroUsd`, 0, MICRO_USD_MAX);
  integerRange(root.chargedCostMicroUsd, `${path}.chargedCostMicroUsd`, 0, MICRO_USD_MAX);
  integerRange(root.durationMs, `${path}.durationMs`, 0, 86_400_000);
  if (root.routeAlias !== undefined) {
    boundedString(root.routeAlias, `${path}.routeAlias`, 1, 100);
    if (!ROUTE_ALIAS_PATTERN.test(root.routeAlias)) fail(`${path}.routeAlias must be a route alias`);
  }
  // Closes the silent-zero gap: charged values are NEVER null; observed values
  // are null exactly when the trust tier carries no observation.
  if (root.trust === 'estimated_tier_ceiling' || root.trust === 'unavailable') {
    if (root.observedInputTokens !== null) fail(`${path}.observedInputTokens must be null for ${root.trust}`);
    if (root.observedOutputTokens !== null) fail(`${path}.observedOutputTokens must be null for ${root.trust}`);
    if (root.observedCostMicroUsd !== null) fail(`${path}.observedCostMicroUsd must be null for ${root.trust}`);
    // Non-zero-floor invariant (CONVENTIONS §5 amendment): when no telemetry
    // anchors the charge, the charged values are the caller's floor policy — a
    // config-pinned NON-ZERO floor, never a silent zero by another name. A
    // charged-0 receipt at these tiers is rejected code-side (the JSON Schema
    // cannot express this cross-field floor rule).
    if (root.chargedTokens < 1) fail(`${path}.chargedTokens must be at least 1 for ${root.trust}`);
    if (root.chargedCostMicroUsd < 1) fail(`${path}.chargedCostMicroUsd must be at least 1 for ${root.trust}`);
  }
  if (root.trust === 'provider_reported' || root.trust === 'provider_signed') {
    const hasObserved = Number.isInteger(root.observedInputTokens)
      || Number.isInteger(root.observedOutputTokens)
      || Number.isInteger(root.observedCostMicroUsd);
    if (!hasObserved) fail(`${path}.${root.trust} requires at least one observed value`);
  }
  if (root.trust === 'provider_signed') {
    if (root.signature === undefined) fail(`${path}.signature is required when trust is provider_signed`);
    boundedString(root.signature, `${path}.signature`, 1, 4096);
  } else if (root.signature !== undefined) {
    fail(`${path}.signature is present only when trust is provider_signed`);
  }
  return clone(root);
}

function validateDraftProvenanceReceipt(value) {
  const root = plainObject(value, 'draftProvenance');
  exactKeys(root, 'draftProvenance', [
    'schemaVersion', 'receiptId', 'draftProposalId', 'draftProposalDigest', 'factsDigest',
    'sourceStateSha256', 'generatedBy', 'corpusSources', 'companyResearch', 'usage', 'createdAt'
  ], [
    'schemaVersion', 'receiptId', 'draftProposalId', 'draftProposalDigest', 'factsDigest',
    'sourceStateSha256', 'generatedBy', 'corpusSources', 'usage', 'createdAt'
  ]);
  literal(root.schemaVersion, 'draft-provenance-receipt.v1', 'draftProvenance.schemaVersion');
  identifier(root.receiptId, 'draftProvenance.receiptId');
  identifier(root.draftProposalId, 'draftProvenance.draftProposalId');
  sha256(root.draftProposalDigest, 'draftProvenance.draftProposalDigest');
  sha256(root.factsDigest, 'draftProvenance.factsDigest');
  sha256(root.sourceStateSha256, 'draftProvenance.sourceStateSha256');
  validateGeneratedBy(root.generatedBy, 'draftProvenance.generatedBy');
  const sources = array(root.corpusSources, 'draftProvenance.corpusSources', 64);
  sources.forEach((source, index) => validateCorpusSource(source, `draftProvenance.corpusSources[${index}]`));
  if (root.companyResearch !== undefined) validateCompanyResearch(root.companyResearch, 'draftProvenance.companyResearch');
  // Usage receipt is MANDATORY and carries an explicit trust tier so a zero or
  // absent draft receipt is visibly flagged, never silently accepted.
  validateUsageReceipt(root.usage, 'draftProvenance.usage');
  dateTime(root.createdAt, 'draftProvenance.createdAt');
  return clone(root);
}

function validateGeneratedBy(value, path) {
  const root = plainObject(value, path);
  exactKeys(root, path, ['provider', 'model', 'modelVersion', 'version', 'routeAlias'], ['provider', 'version']);
  boundedString(root.provider, `${path}.provider`, 1, 100);
  if (root.model !== undefined) boundedString(root.model, `${path}.model`, 1, 200);
  if (root.modelVersion !== undefined) boundedString(root.modelVersion, `${path}.modelVersion`, 1, 200);
  boundedString(root.version, `${path}.version`, 1, 100);
  if (root.routeAlias !== undefined) {
    boundedString(root.routeAlias, `${path}.routeAlias`, 1, 100);
    if (!ROUTE_ALIAS_PATTERN.test(root.routeAlias)) fail(`${path}.routeAlias must be a route alias`);
  }
}

function validateCorpusSource(value, path) {
  const root = plainObject(value, path);
  exactKeys(root, path, ['kind', 'ref', 'digest'], ['kind', 'digest']);
  enumValue(root.kind, CORPUS_SOURCE_KINDS, `${path}.kind`);
  if (root.ref !== undefined) boundedString(root.ref, `${path}.ref`, 1, 300);
  sha256(root.digest, `${path}.digest`);
}

function validateCompanyResearch(value, path) {
  const root = plainObject(value, path);
  exactKeys(root, path, ['used', 'brokered'], ['used', 'brokered']);
  boolean(root.used, `${path}.used`);
  boolean(root.brokered, `${path}.brokered`);
}

function validateApprovalReceipt(value, path = 'approval') {
  const root = plainObject(value, path);
  exactKeys(root, path, [
    'schemaVersion', 'approvalId', 'approvedArtifactContractId', 'approvedArtifactDigest',
    'approver', 'approvedAt', 'scope', 'expiresAt', 'signature'
  ], [
    'schemaVersion', 'approvalId', 'approvedArtifactContractId', 'approvedArtifactDigest',
    'approver', 'approvedAt', 'scope'
  ]);
  literal(root.schemaVersion, 'approval-receipt.v1', `${path}.schemaVersion`);
  identifier(root.approvalId, `${path}.approvalId`);
  contractId(root.approvedArtifactContractId, `${path}.approvedArtifactContractId`);
  sha256(root.approvedArtifactDigest, `${path}.approvedArtifactDigest`);
  const approver = plainObject(root.approver, `${path}.approver`);
  exactKeys(approver, `${path}.approver`, ['kind', 'id'], ['kind', 'id']);
  enumValue(approver.kind, new Set(['human']), `${path}.approver.kind`);
  boundedString(approver.id, `${path}.approver.id`, 1, 320);
  dateTime(root.approvedAt, `${path}.approvedAt`);
  const scope = plainObject(root.scope, `${path}.scope`);
  exactKeys(scope, `${path}.scope`, ['action', 'recipient', 'threadId'], ['action', 'recipient', 'threadId']);
  literal(scope.action, 'send-once', `${path}.scope.action`);
  email(scope.recipient, `${path}.scope.recipient`);
  boundedString(scope.threadId, `${path}.scope.threadId`, 1, 500);
  if (root.expiresAt !== undefined) dateTime(root.expiresAt, `${path}.expiresAt`);
  if (root.signature !== undefined) boundedString(root.signature, `${path}.signature`, 1, 4096);
  return clone(root);
}

function validateEmailSendRequest(value) {
  const root = plainObject(value, 'sendRequest');
  exactKeys(root, 'sendRequest', [
    'schemaVersion', 'requestId', 'idempotencyKey', 'recipient', 'inReplyTo', 'threadId',
    'content', 'approval'
  ], [
    'schemaVersion', 'requestId', 'idempotencyKey', 'recipient', 'threadId', 'content', 'approval'
  ]);
  literal(root.schemaVersion, 'email-send-request.v1', 'sendRequest.schemaVersion');
  identifier(root.requestId, 'sendRequest.requestId');
  boundedString(root.idempotencyKey, 'sendRequest.idempotencyKey', 1, 200);
  if (!IDEMPOTENCY_KEY_PATTERN.test(root.idempotencyKey)) fail('sendRequest.idempotencyKey must be a stable idempotency key');
  email(root.recipient, 'sendRequest.recipient');
  if (root.inReplyTo !== undefined) boundedString(root.inReplyTo, 'sendRequest.inReplyTo', 1, 998);
  boundedString(root.threadId, 'sendRequest.threadId', 1, 500);
  const content = plainObject(root.content, 'sendRequest.content');
  exactKeys(content, 'sendRequest.content', ['mode', 'contractId', 'digest'], ['mode', 'contractId', 'digest']);
  literal(content.mode, 'draft_artifact', 'sendRequest.content.mode');
  contractId(content.contractId, 'sendRequest.content.contractId');
  sha256(content.digest, 'sendRequest.content.digest');
  const approval = validateApprovalReceipt(root.approval, 'sendRequest.approval');
  // Code-side cross-field invariants the send edge also re-verifies. FROZEN v1:
  // content is the approved draft-artifact digest reference; the send edge sends
  // only bytes whose digest equals approval.approvedArtifactDigest.
  if (content.digest !== approval.approvedArtifactDigest) {
    fail('sendRequest.content.digest must equal sendRequest.approval.approvedArtifactDigest');
  }
  if (content.contractId !== approval.approvedArtifactContractId) {
    fail('sendRequest.content.contractId must equal sendRequest.approval.approvedArtifactContractId');
  }
  if (root.recipient.toLowerCase() !== approval.scope.recipient.toLowerCase()) {
    fail('sendRequest.recipient must equal sendRequest.approval.scope.recipient');
  }
  if (root.threadId !== approval.scope.threadId) {
    fail('sendRequest.threadId must equal sendRequest.approval.scope.threadId');
  }
  return clone(root);
}

function validateEmailSendReceipt(value) {
  const root = plainObject(value, 'sendReceipt');
  exactKeys(root, 'sendReceipt', [
    'schemaVersion', 'receiptId', 'requestId', 'idempotencyKey', 'requestDigest', 'status',
    'provider', 'providerMessageId', 'providerThreadId', 'failureReason', 'observedAt'
  ], [
    'schemaVersion', 'receiptId', 'requestId', 'idempotencyKey', 'requestDigest', 'status', 'observedAt'
  ]);
  literal(root.schemaVersion, 'email-send-receipt.v1', 'sendReceipt.schemaVersion');
  identifier(root.receiptId, 'sendReceipt.receiptId');
  identifier(root.requestId, 'sendReceipt.requestId');
  boundedString(root.idempotencyKey, 'sendReceipt.idempotencyKey', 1, 200);
  if (!IDEMPOTENCY_KEY_PATTERN.test(root.idempotencyKey)) fail('sendReceipt.idempotencyKey must be a stable idempotency key');
  sha256(root.requestDigest, 'sendReceipt.requestDigest');
  enumValue(root.status, SEND_RECEIPT_STATUSES, 'sendReceipt.status');
  if (root.provider !== undefined) enumValue(root.provider, SEND_RECEIPT_PROVIDERS, 'sendReceipt.provider');
  if (root.providerMessageId !== undefined) boundedString(root.providerMessageId, 'sendReceipt.providerMessageId', 1, 500);
  if (root.providerThreadId !== undefined) boundedString(root.providerThreadId, 'sendReceipt.providerThreadId', 1, 500);
  if (root.failureReason !== undefined) boundedString(root.failureReason, 'sendReceipt.failureReason', 1, 1000);
  dateTime(root.observedAt, 'sendReceipt.observedAt');
  if (root.status === 'sent' || root.status === 'skipped_duplicate') {
    if (root.provider === undefined) fail(`sendReceipt.provider is required when status is ${root.status}`);
    if (root.providerMessageId === undefined) fail(`sendReceipt.providerMessageId is required when status is ${root.status}`);
    if (root.failureReason !== undefined) fail(`sendReceipt.failureReason must be absent when status is ${root.status}`);
  }
  if (root.status === 'failed') {
    if (root.failureReason === undefined) fail('sendReceipt.failureReason is required when status is failed');
    if (root.providerMessageId !== undefined) fail('sendReceipt.providerMessageId must be absent when status is failed');
  }
  return clone(root);
}

// Additive provider-neutral outgoing validators. Keep the public error type
// stable for callers of lib/email-contracts while the implementation lives in
// its isolated v3/v2 module and leaves every frozen predecessor path alone.
function outgoingValidator(name, value) {
  try {
    return outgoingV2[name](value);
  } catch (error) {
    if (error instanceof outgoingV2.OutgoingContractError) fail(error.message);
    throw error;
  }
}

function validateReplyDraftProposalV3(value) {
  return outgoingValidator('validateReplyDraftProposalV3', value);
}

function validateEmailApprovedContentV1(value) {
  return outgoingValidator('validateEmailApprovedContentV1', value);
}

function validateEmailDraftReceiptV1(value) {
  return outgoingValidator('validateEmailDraftReceiptV1', value);
}

function validateApprovalReceiptV2(value) {
  return outgoingValidator('validateApprovalReceiptV2', value);
}

function validateEmailSendRequestV2(value) {
  return outgoingValidator('validateEmailSendRequestV2', value);
}

function validateEmailSendReceiptV2(value) {
  return outgoingValidator('validateEmailSendReceiptV2', value);
}

function validateFactsSource(value, path, providerNeutral = false) {
  const source = plainObject(value, path);
  exactKeys(source, path, [
    'provider', 'accountId', 'messageId', 'threadId', 'receivedAt', 'fromAddress', 'fromDomain', 'fromDisplayName', 'replyToAddress', 'contentDigest'
  ], ['provider', 'accountId', 'messageId', 'threadId', 'receivedAt', 'fromAddress', 'fromDomain', 'contentDigest']);
  validateProvider(source.provider, `${path}.provider`, providerNeutral);
  boundedString(source.accountId, `${path}.accountId`, 1, 320);
  boundedString(source.messageId, `${path}.messageId`, 1, 500);
  boundedString(source.threadId, `${path}.threadId`, 1, 500);
  dateTime(source.receivedAt, `${path}.receivedAt`);
  email(source.fromAddress, `${path}.fromAddress`);
  domain(source.fromDomain, `${path}.fromDomain`);
  if (source.fromAddress.split('@').at(-1).toLowerCase() !== source.fromDomain.toLowerCase()) fail(`${path}.fromDomain must match fromAddress`);
  // Optional sender display name (facts.v2, execution-contracts >= 1.4.0).
  // Bounded; the producer sanitizes it, and it is stored as inert evidence.
  if (source.fromDisplayName !== undefined) boundedString(source.fromDisplayName, `${path}.fromDisplayName`, 1, 998);
  if (source.replyToAddress !== undefined) email(source.replyToAddress, `${path}.replyToAddress`);
  sha256(source.contentDigest, `${path}.contentDigest`);
}

function validateCompany(value, path) {
  const company = plainObject(value, path);
  exactKeys(company, path, ['name', 'domain'], []);
  if (company.name === undefined && company.domain === undefined) fail(`${path} requires name or domain`);
  if (company.name !== undefined) boundedString(company.name, `${path}.name`, 1, 300);
  if (company.domain !== undefined) domain(company.domain, `${path}.domain`);
}

function validatePostingRef(value, path) {
  const posting = plainObject(value, path);
  exactKeys(posting, path, ['url', 'provider', 'externalJobId', 'roleTitle'], []);
  if (posting.url === undefined && posting.externalJobId === undefined && posting.roleTitle === undefined) fail(`${path} requires url, externalJobId, or roleTitle`);
  if (posting.url !== undefined) httpUrl(posting.url, `${path}.url`);
  if (posting.provider !== undefined) boundedString(posting.provider, `${path}.provider`, 1, 100);
  if (posting.externalJobId !== undefined) boundedString(posting.externalJobId, `${path}.externalJobId`, 1, 300);
  if (posting.roleTitle !== undefined) boundedString(posting.roleTitle, `${path}.roleTitle`, 1, 500);
}

function validateApplicationRef(value, path) {
  const reference = plainObject(value, path);
  exactKeys(reference, path, ['namespace', 'value'], ['namespace', 'value']);
  boundedString(reference.namespace, `${path}.namespace`, 1, 100);
  boundedString(reference.value, `${path}.value`, 1, 500);
}

function validateInterviewFacts(value, path) {
  const interview = plainObject(value, path);
  exactKeys(interview, path, ['intent', 'round', 'scheduledAt', 'previousScheduledAt', 'timezone', 'format', 'interviewer'], ['intent']);
  enumValue(interview.intent, new Set(['schedule', 'reschedule', 'cancel', 'reminder', 'outcome', 'unknown']), `${path}.intent`);
  if (interview.round !== undefined) enumValue(interview.round, new Set([...INTERVIEW_ROUNDS, 'other']), `${path}.round`);
  if (interview.scheduledAt !== undefined) dateTime(interview.scheduledAt, `${path}.scheduledAt`);
  if (interview.previousScheduledAt !== undefined) dateTime(interview.previousScheduledAt, `${path}.previousScheduledAt`);
  if (interview.timezone !== undefined) boundedString(interview.timezone, `${path}.timezone`, 1, 100);
  if (interview.format !== undefined) enumValue(interview.format, new Set([...INTERVIEW_FORMATS, 'unknown']), `${path}.format`);
  if (interview.interviewer !== undefined) boundedString(interview.interviewer, `${path}.interviewer`, 1, 500);
}

function validateRequestedAction(value, path) {
  const action = plainObject(value, path);
  exactKeys(action, path, ['kind', 'deadline'], ['kind']);
  enumValue(action.kind, new Set(['reply', 'schedule', 'complete_assessment', 'provide_information', 'review_offer', 'other']), `${path}.kind`);
  if (action.deadline !== undefined) dateTime(action.deadline, `${path}.deadline`);
}

function validateEvidence(value, path) {
  const evidence = plainObject(value, path);
  exactKeys(evidence, path, ['field', 'excerpt'], ['field', 'excerpt']);
  enumValue(evidence.field, new Set(['from', 'subject', 'body', 'url', 'header']), `${path}.field`);
  boundedString(evidence.excerpt, `${path}.excerpt`, 1, 500);
}

function validateExtraction(value, path) {
  const extraction = plainObject(value, path);
  exactKeys(extraction, path, ['provider', 'model', 'version', 'confidence'], ['provider', 'version', 'confidence']);
  boundedString(extraction.provider, `${path}.provider`, 1, 100);
  if (extraction.model !== undefined) boundedString(extraction.model, `${path}.model`, 1, 200);
  boundedString(extraction.version, `${path}.version`, 1, 100);
  numberRange(extraction.confidence, `${path}.confidence`, 0, 1);
}

function validateSecurity(value, path) {
  const security = plainObject(value, path);
  exactKeys(security, path, ['risk', 'requiresReview'], ['risk', 'requiresReview']);
  enumValue(security.risk, SECURITY_RISKS, `${path}.risk`);
  boolean(security.requiresReview, `${path}.requiresReview`);
}

function validateMessageRef(value, path, providerNeutral = false) {
  const source = plainObject(value, path);
  exactKeys(source, path, ['provider', 'accountId', 'messageId', 'threadId'], ['provider', 'accountId', 'messageId', 'threadId']);
  validateProvider(source.provider, `${path}.provider`, providerNeutral);
  boundedString(source.accountId, `${path}.accountId`, 1, 320);
  boundedString(source.messageId, `${path}.messageId`, 1, 500);
  boundedString(source.threadId, `${path}.threadId`, 1, 500);
  return source;
}

function validateProvider(value, path, providerNeutral) {
  if (!providerNeutral) {
    enumValue(value, PROVIDERS, path);
    return;
  }
  boundedString(value, path, 1, 80);
  if (!PROVIDER_CODE_PATTERN.test(value)) fail(`${path} must be a lowercase provider code`);
}

function validateReplySource(value, path) {
  const source = plainObject(value, path);
  exactKeys(source, path, ['provider', 'accountId', 'messageId', 'threadId', 'replyToAddress'], ['provider', 'accountId', 'messageId', 'threadId', 'replyToAddress']);
  // Strict provider: email-reply-draft-proposal.v2 is a PUBLISHED shared contract,
  // so its provider set cannot be widened unilaterally (that would fail the
  // cross-repo parity gate). The v2 mailbox reply path uses the provider-neutral
  // outgoing lane instead; making this legacy reply lane provider-neutral would be
  // a coordinated execution-contracts change, tracked separately.
  validateMessageRef({ provider: source.provider, accountId: source.accountId, messageId: source.messageId, threadId: source.threadId }, path);
  email(source.replyToAddress, `${path}.replyToAddress`);
  return source;
}

function validateCandidate(value, path) {
  const candidate = plainObject(value, path);
  exactKeys(candidate, path, [
    'applicationId', 'applicationVersion', 'companyId', 'openingId', 'postingId', 'postingOccurrenceId', 'interviewId', 'matchBasis', 'confidence', 'reasons'
  ], ['applicationId', 'applicationVersion', 'matchBasis', 'confidence', 'reasons']);
  positiveInteger(candidate.applicationId, `${path}.applicationId`);
  nonnegativeInteger(candidate.applicationVersion, `${path}.applicationVersion`);
  for (const key of ['companyId', 'openingId', 'postingId', 'postingOccurrenceId', 'interviewId']) {
    if (candidate[key] !== undefined) positiveInteger(candidate[key], `${path}.${key}`);
  }
  enumValue(candidate.matchBasis, MATCH_BASES, `${path}.matchBasis`);
  numberRange(candidate.confidence, `${path}.confidence`, 0, 1);
  const reasons = array(candidate.reasons, `${path}.reasons`, 10);
  if (reasons.length === 0) fail(`${path}.reasons requires at least one item`);
  reasons.forEach((reason, index) => boundedString(reason, `${path}.reasons[${index}]`, 1, 300));
  return candidate;
}

function validateTarget(value, path) {
  const target = plainObject(value, path);
  exactKeys(target, path, ['applicationId', 'companyId', 'openingId', 'postingId', 'postingOccurrenceId', 'interviewId'], ['applicationId']);
  for (const key of Object.keys(target)) positiveInteger(target[key], `${path}.${key}`);
  return target;
}

function validateProposalCorrelation(value, path) {
  const correlation = plainObject(value, path);
  exactKeys(correlation, path, ['resolution', 'matchBasis', 'confidence'], ['resolution', 'matchBasis', 'confidence']);
  literal(correlation.resolution, 'linked', `${path}.resolution`);
  enumValue(correlation.matchBasis, MATCH_BASES, `${path}.matchBasis`);
  numberRange(correlation.confidence, `${path}.confidence`, 0, 1);
  return correlation;
}

function validateProposalSafety(value, path) {
  const safety = plainObject(value, path);
  exactKeys(safety, path, ['contentCompleteness', 'securityRisk', 'sourceRequiresReview'], ['contentCompleteness', 'securityRisk', 'sourceRequiresReview']);
  enumValue(safety.contentCompleteness, COMPLETENESS, `${path}.contentCompleteness`);
  enumValue(safety.securityRisk, SECURITY_RISKS, `${path}.securityRisk`);
  boolean(safety.sourceRequiresReview, `${path}.sourceRequiresReview`);
  return safety;
}

function validateAction(value, path) {
  const action = plainObject(value, path);
  boundedString(action.kind, `${path}.kind`, 1, 100);
  if (action.kind === 'link_message') {
    exactKeys(action, path, ['kind', 'relation'], ['kind', 'relation']);
    enumValue(action.relation, new Set(['application_update', 'interview', 'offer', 'rejection', 'action_required', 'other']), `${path}.relation`);
  } else if (action.kind === 'transition_application_status') {
    exactKeys(action, path, ['kind', 'fromStatus', 'toStatus'], ['kind', 'fromStatus', 'toStatus']);
    enumValue(action.fromStatus, APPLICATION_STATUSES, `${path}.fromStatus`);
    enumValue(action.toStatus, APPLICATION_STATUSES, `${path}.toStatus`);
    if (action.fromStatus === action.toStatus) fail(`${path} must change status`);
  } else if (action.kind === 'create_interview') {
    exactKeys(action, path, ['kind', 'round', 'scheduledAt', 'timezone', 'format', 'interviewer'], ['kind', 'round', 'scheduledAt', 'timezone', 'format']);
    enumValue(action.round, INTERVIEW_ROUNDS, `${path}.round`);
    dateTime(action.scheduledAt, `${path}.scheduledAt`);
    boundedString(action.timezone, `${path}.timezone`, 1, 100);
    enumValue(action.format, INTERVIEW_FORMATS, `${path}.format`);
    if (action.interviewer !== undefined) boundedString(action.interviewer, `${path}.interviewer`, 1, 500);
  } else if (action.kind === 'reschedule_interview') {
    exactKeys(action, path, ['kind', 'interviewId', 'fromScheduledAt', 'toScheduledAt', 'timezone'], ['kind', 'interviewId', 'fromScheduledAt', 'toScheduledAt', 'timezone']);
    positiveInteger(action.interviewId, `${path}.interviewId`);
    dateTime(action.fromScheduledAt, `${path}.fromScheduledAt`);
    dateTime(action.toScheduledAt, `${path}.toScheduledAt`);
    if (Date.parse(action.fromScheduledAt) === Date.parse(action.toScheduledAt)) fail(`${path} must change scheduled time`);
    boundedString(action.timezone, `${path}.timezone`, 1, 100);
  } else if (action.kind === 'cancel_interview') {
    exactKeys(action, path, ['kind', 'interviewId', 'cancelledAt', 'reason'], ['kind', 'interviewId']);
    positiveInteger(action.interviewId, `${path}.interviewId`);
    if (action.cancelledAt !== undefined) dateTime(action.cancelledAt, `${path}.cancelledAt`);
    if (action.reason !== undefined) boundedString(action.reason, `${path}.reason`, 1, 1000);
  } else if (action.kind === 'record_offer') {
    exactKeys(action, path, ['kind', 'summary', 'decisionDeadline'], ['kind', 'summary']);
    boundedString(action.summary, `${path}.summary`, 1, 2000);
    if (action.decisionDeadline !== undefined) dateTime(action.decisionDeadline, `${path}.decisionDeadline`);
  } else if (action.kind === 'record_requested_action') {
    exactKeys(action, path, ['kind', 'requestKind', 'deadline'], ['kind', 'requestKind']);
    enumValue(action.requestKind, new Set(['reply', 'schedule', 'complete_assessment', 'provide_information', 'review_offer', 'other']), `${path}.requestKind`);
    if (action.deadline !== undefined) dateTime(action.deadline, `${path}.deadline`);
  } else {
    fail(`${path}.kind is not supported`);
  }
  return action;
}

function exactCorrelationCandidate(candidate) {
  if (!EXACT_MATCH_BASES.has(candidate.matchBasis)) return false;
  if (candidate.matchBasis === 'exact_posting_url') return false;
  if (candidate.matchBasis === 'exact_posting_occurrence') return candidate.postingId !== undefined || candidate.postingOccurrenceId !== undefined;
  return true;
}

function exactCorrelationCandidateV3(candidate) {
  if (!new Set([
    'provider_application_id', 'previously_linked_message', 'previously_linked_thread',
    'exact_posting_occurrence', 'exact_posting_url', 'clarification_reply'
  ]).has(candidate.matchBasis)) return false;
  if (candidate.matchBasis === 'exact_posting_url') return false;
  if (candidate.matchBasis === 'exact_posting_occurrence') return candidate.postingId !== undefined || candidate.postingOccurrenceId !== undefined;
  return true;
}

function sameCandidate(left, right) {
  return left.applicationId === right.applicationId
    && left.applicationVersion === right.applicationVersion
    && left.companyId === right.companyId
    && left.openingId === right.openingId
    && left.postingId === right.postingId
    && left.postingOccurrenceId === right.postingOccurrenceId
    && left.interviewId === right.interviewId
    && left.matchBasis === right.matchBasis;
}

function validateStyleDimensions(value, path, allowUnknown) {
  const dimensions = plainObject(value, path);
  const keys = Object.keys(STYLE_DIMENSIONS);
  exactKeys(dimensions, path, keys, keys);
  for (const [key, values] of Object.entries(STYLE_DIMENSIONS)) {
    const allowed = allowUnknown ? new Set([...values, 'unknown']) : values;
    enumValue(dimensions[key], allowed, `${path}.${key}`);
  }
  return dimensions;
}

function validateSurfaceSignals(value, path) {
  const signals = plainObject(value, path);
  exactKeys(signals, path, ['length', 'greeting', 'closing', 'exclamation', 'emoji', 'contractions'], ['length', 'greeting', 'closing', 'exclamation', 'emoji', 'contractions']);
  enumValue(signals.length, new Set(['very_short', 'short', 'medium', 'long', 'unknown']), `${path}.length`);
  enumValue(signals.greeting, new Set(['none', 'name', 'hi', 'hello', 'dear', 'other', 'unknown']), `${path}.greeting`);
  enumValue(signals.closing, new Set(['none', 'thanks', 'best', 'regards', 'other', 'unknown']), `${path}.closing`);
  enumValue(signals.exclamation, new Set(['none', 'one', 'multiple', 'unknown']), `${path}.exclamation`);
  enumValue(signals.emoji, new Set(['none', 'present', 'unknown']), `${path}.emoji`);
  enumValue(signals.contractions, new Set(['none', 'present', 'unknown']), `${path}.contractions`);
  return signals;
}

function validateStyleEvidence(value, path) {
  const evidence = plainObject(value, path);
  exactKeys(evidence, path, ['signal', 'factsEvidenceIndex'], ['signal', 'factsEvidenceIndex']);
  enumValue(evidence.signal, new Set([
    'formality', 'warmth', 'energy', 'directness', 'verbosity', 'length',
    'greeting', 'closing', 'exclamation', 'emoji', 'contractions'
  ]), `${path}.signal`);
  integerRange(evidence.factsEvidenceIndex, `${path}.factsEvidenceIndex`, 0, 19);
}

function validateStyleGenerator(value, path, policyVersion) {
  const generator = plainObject(value, path);
  exactKeys(generator, path, ['provider', 'model', 'version', 'policyVersion'], ['provider', 'version', 'policyVersion']);
  boundedString(generator.provider, `${path}.provider`, 1, 100);
  if (generator.model !== undefined) boundedString(generator.model, `${path}.model`, 1, 200);
  boundedString(generator.version, `${path}.version`, 1, 100);
  literal(generator.policyVersion, policyVersion, `${path}.policyVersion`);
  return generator;
}

function validateStyleScope(value, path) {
  const scope = plainObject(value, path);
  if (scope.kind === 'thread') {
    exactKeys(scope, path, ['kind', 'provider', 'accountId', 'threadId'], ['kind', 'provider', 'accountId', 'threadId']);
    validateMessageRef({ provider: scope.provider, accountId: scope.accountId, messageId: 'scope', threadId: scope.threadId }, path);
  } else if (scope.kind === 'contact') {
    exactKeys(scope, path, ['kind', 'contactId'], ['kind', 'contactId']);
    positiveInteger(scope.contactId, `${path}.contactId`);
  } else {
    fail(`${path}.kind has an unsupported value`);
  }
  return scope;
}

function validateStyleDelivery(value, path, options = {}) {
  const delivery = plainObject(value, path);
  const keys = ['greeting', 'closing', 'exclamationPolicy', 'emojiPolicy', 'contractions'];
  if (options.voice) keys.push('maxBandShift');
  exactKeys(delivery, path, keys, keys);
  enumValue(delivery.greeting, new Set(['omit', 'name', 'hi', 'hello', 'dear']), `${path}.greeting`);
  enumValue(delivery.closing, new Set(['none', 'thanks', 'best', 'regards']), `${path}.closing`);
  enumValue(delivery.exclamationPolicy, new Set(['none', 'at_most_one']), `${path}.exclamationPolicy`);
  enumValue(delivery.emojiPolicy, options.voice || options.tone ? new Set(['none']) : new Set(['none', 'reciprocal_only']), `${path}.emojiPolicy`);
  enumValue(delivery.contractions, new Set(['avoid', 'allow']), `${path}.contractions`);
  if (options.voice) enumValue(delivery.maxBandShift, new Set([0, 1]), `${path}.maxBandShift`);
  return delivery;
}

function validateSafeguards(value, path) {
  const safeguards = plainObject(value, path);
  exactKeys(safeguards, path, ['registerAdaptationOnly', 'sensitiveTraitInference', 'personalityInference', 'distinctivePhraseReuse'], ['registerAdaptationOnly', 'sensitiveTraitInference', 'personalityInference', 'distinctivePhraseReuse']);
  literal(safeguards.registerAdaptationOnly, true, `${path}.registerAdaptationOnly`);
  literal(safeguards.sensitiveTraitInference, false, `${path}.sensitiveTraitInference`);
  literal(safeguards.personalityInference, false, `${path}.personalityInference`);
  literal(safeguards.distinctivePhraseReuse, false, `${path}.distinctivePhraseReuse`);
  return safeguards;
}

function validateTonePolicy(value, path) {
  const policy = plainObject(value, path);
  exactKeys(policy, path, [
    'version', 'fallback', 'maxBandShift', 'registerAdaptationOnly', 'sensitiveTraitInference',
    'personalityInference', 'distinctivePhraseReuse'
  ], [
    'version', 'fallback', 'maxBandShift', 'registerAdaptationOnly', 'sensitiveTraitInference',
    'personalityInference', 'distinctivePhraseReuse'
  ]);
  literal(policy.version, 'register-adaptation.v1', `${path}.version`);
  literal(policy.fallback, 'neutral_professional', `${path}.fallback`);
  enumValue(policy.maxBandShift, new Set([0, 1]), `${path}.maxBandShift`);
  validateSafeguards({
    registerAdaptationOnly: policy.registerAdaptationOnly,
    sensitiveTraitInference: policy.sensitiveTraitInference,
    personalityInference: policy.personalityInference,
    distinctivePhraseReuse: policy.distinctivePhraseReuse
  }, path);
  return policy;
}

function pairedFields(value, left, right, path) {
  if ((value[left] === undefined) !== (value[right] === undefined)) fail(`${path}.${left} and ${path}.${right} must be supplied together`);
}

function exactKeys(value, path, allowed, required) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) fail(`${path} contains unknown field(s): ${unknown.sort().join(', ')}`);
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${path}.${key} is required`);
}

function plainObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${path} must be a plain object`);
  return value;
}

function array(value, path, maximum) {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  if (value.length > maximum) fail(`${path} exceeds ${maximum} items`);
  return value;
}

function boundedString(value, path, minimum, maximum) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) fail(`${path} must be a string from ${minimum} to ${maximum} characters`);
  return value;
}

function identifier(value, path) {
  boundedString(value, path, 1, 200);
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) fail(`${path} must be a stable identifier`);
}

function sha256(value, path) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`${path} must be a lowercase SHA-256 digest`);
}

function dateTime(value, path) {
  boundedString(value, path, 1, 100);
  if (!value.includes('T') || !Number.isFinite(Date.parse(value))) fail(`${path} must be an ISO date-time`);
}

function email(value, path) {
  boundedString(value, path, 3, 320);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail(`${path} must be an email address`);
}

function domain(value, path) {
  boundedString(value, path, 1, 253);
  if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(value)) fail(`${path} must be a DNS domain`);
}

function httpUrl(value, path) {
  boundedString(value, path, 1, 2000);
  let parsed;
  try { parsed = new URL(value); } catch { fail(`${path} must be a URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) fail(`${path} must use http or https`);
  if (parsed.username || parsed.password) fail(`${path} must not contain credentials`);
}

function positiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${path} must be a positive integer`);
}

function nonnegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${path} must be a nonnegative integer`);
}

function integerRange(value, path, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${path} must be an integer from ${minimum} to ${maximum}`);
}

function nullableInteger(value, path, minimum, maximum) {
  if (value === null) return;
  integerRange(value, path, minimum, maximum);
}

function contractId(value, path) {
  boundedString(value, path, 1, 160);
  if (!CONTRACT_ID_PATTERN.test(value)) fail(`${path} must be a lowercase contract id (name.vN)`);
}

function numberRange(value, path, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) fail(`${path} must be between ${minimum} and ${maximum}`);
}

function boolean(value, path) {
  if (typeof value !== 'boolean') fail(`${path} must be boolean`);
}

function literal(value, expected, path) {
  if (value !== expected) fail(`${path} must equal ${JSON.stringify(expected)}`);
}

function enumValue(value, allowed, path) {
  if (!allowed.has(value)) fail(`${path} has an unsupported value`);
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(message) {
  throw new EmailContractError(message);
}

module.exports = {
  APPLICATION_STATUSES,
  EXACT_MATCH_BASES,
  EmailContractError,
  factsJsonSchema,
  factsV2JsonSchema,
  correlationJsonSchema,
  correlationV2JsonSchema,
  correlationV3JsonSchema,
  transitionJsonSchema,
  replyDraftJsonSchema,
  demeanorObservationJsonSchema,
  recipientStyleProfileJsonSchema,
  writingVoiceRevisionJsonSchema,
  toneDecisionJsonSchema,
  replyDraftV2JsonSchema,
  usageReceiptJsonSchema,
  draftProvenanceReceiptJsonSchema,
  approvalReceiptJsonSchema,
  emailSendRequestJsonSchema,
  emailSendReceiptJsonSchema,
  replyDraftV3JsonSchema,
  emailApprovedContentJsonSchema,
  emailDraftReceiptJsonSchema,
  approvalReceiptV2JsonSchema,
  emailSendRequestV2JsonSchema,
  emailSendReceiptV2JsonSchema,
  validateJobApplicationEmailFacts,
  validateJobApplicationEmailFactsV2,
  validateCorrelationResult,
  validateCorrelationResultV2,
  validateCorrelationResultV3,
  validateTransitionProposal,
  validateReplyDraftProposal,
  validateDemeanorObservation,
  validateRecipientStyleProfile,
  validateWritingVoiceRevision,
  validateToneDecision,
  validateReplyDraftProposalV2,
  validateUsageReceipt,
  validateDraftProvenanceReceipt,
  validateApprovalReceipt,
  validateEmailSendRequest,
  validateEmailSendReceipt,
  validateReplyDraftProposalV3,
  validateEmailApprovedContentV1,
  validateEmailDraftReceiptV1,
  validateApprovalReceiptV2,
  validateEmailSendRequestV2,
  validateEmailSendReceiptV2,
  digest,
  stableJson
};
