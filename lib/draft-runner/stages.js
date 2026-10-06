'use strict';

// The five code stages of the reply-drafting DAG. Every stage is a pure
// function of its declared inputs: no store handle, no filesystem, no network,
// no clock except the one the caller injects. Untrusted message content is
// quoted evidence, never instruction — no stage interprets an excerpt as a
// directive, and the composer never copies a recipient's distinctive phrasing.

const {
  digestCanonicalJson,
  digestUtf8Text,
  normalizeBodyV1,
  normalizeNfc,
  parseTime,
  projectApprovedContentFromProposal,
  validateReplyDraftProposalV3,
  NORMALIZATION_VERSION
} = require('../email-outgoing-v2-contracts');

const {
  COMPOSITION_CONTRACT,
  DRAFT_REQUEST_CONTRACT,
  EVIDENCE_CONTRACT,
  INTENT_CONTRACT,
  OUTCOME_CONTRACT,
  POLICY_CONTRACT
} = require('./contracts');

// Which imported event kinds a reply may answer at all, and the one purpose
// each maps to. An unlisted or unknown kind is refused rather than guessed.
const EVENT_PURPOSES = Object.freeze({
  application_received: 'acknowledgement',
  action_required: 'information_response',
  interview_invite: 'scheduling',
  interview_rescheduled: 'scheduling',
  interview_cancelled: 'acknowledgement',
  rejection: 'acknowledgement',
  offer: 'acknowledgement',
  withdrawal_confirmed: 'acknowledgement',
  recruiter_followup: 'follow_up'
});

// Excerpt fields admissible as drafting evidence. URLs and raw headers are
// excluded: they carry the highest injection and tracking risk and contribute
// nothing a reply legitimately needs.
const ADMISSIBLE_EVIDENCE_FIELDS = Object.freeze(['subject', 'body', 'from']);

const MIN_GUARDED_PHRASE_WORDS = 4;
const MAX_GUARDED_PHRASES = 500;

// Patterns that must never appear in an outbound draft. A hit downgrades the
// scan to requires_review rather than silently redacting.
const SENSITIVE_PATTERNS = Object.freeze([
  ['us_ssn', /\b\d{3}-\d{2}-\d{4}\b/],
  ['long_digit_run', /\b\d{9,}\b/],
  ['credential_word', /\b(?:password|passcode|api[ _-]?key|secret|token|otp|mfa code)\b/i],
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._-]{16,}/],
  ['private_key_block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/]
]);

class DraftRefusal extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DraftRefusal';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// Stages refuse through an injected factory so the host can raise the engine's
// own typed stage error. That makes a refusal a non-retryable, item-scoped
// classification the engine records verbatim, instead of an anonymous throw it
// would classify as a generic retryable failure.
function defaultRefusalFactory(code, message, details) {
  return new DraftRefusal(code, message, details);
}

function refuserFrom(factory) {
  const build = typeof factory === 'function' ? factory : defaultRefusalFactory;
  return (code, message, details) => { throw build(code, message, details); };
}

// --- stage 1: verify the request's own no-effect policy --------------------

function createVerifyRequestStage({ now, refusalFactory }) {
  const refuse = refuserFrom(refusalFactory);
  return {
    id: 'jobtrack.draft.verify_request',
    version: 1,
    async run(request) {
      const evaluatedAt = now();
      const refusals = [];
      if (parseTime(request.expiresAt) <= parseTime(evaluatedAt)) refusals.push('request_expired');
      if (request.context.security.risk === 'high') refusals.push('source_security_risk_high');
      if (request.context.contentCompleteness === 'metadata_only'
        && !EVENT_PURPOSES[request.context.eventKind]) {
        refusals.push('insufficient_content_for_unknown_event');
      }
      if (refusals.length) refuse('draft_refused.request_policy', 'Request policy forbids composing a reply', { refusals });
      return {
        request,
        requestDigest: digestCanonicalJson(request),
        evaluatedAt,
        replyPermitted: true,
        refusals
      };
    }
  };
}

// --- stage 2: classify the reply's single purpose --------------------------

function createClassifyEventStage({ refusalFactory } = {}) {
  const refuse = refuserFrom(refusalFactory);
  return {
    id: 'jobtrack.draft.classify_event',
    version: 1,
    async run(policy) {
      const eventKind = policy.request.context.eventKind;
      const purpose = EVENT_PURPOSES[eventKind];
      if (!purpose) {
        refuse('draft_refused.unmapped_event_kind', 'No reply purpose is defined for this event kind', { refusals: ['unmapped_event_kind'] });
      }
      return {
        purpose,
        eventKind,
        replyPermitted: true,
        // JobTrack requires human review of every outbound draft without
        // exception; the source's own review flag can only reinforce it.
        requiresReview: true,
        refusals: []
      };
    }
  };
}

// --- stage 3: bound the evidence and build the phrase guard ----------------

// Distinctive-phrase reuse is measured on overlapping word windows of the
// recipient's own prose. Anything the recipient wrote in a run of this many
// words is off limits verbatim, which blocks phrase mirroring without blocking
// ordinary shared vocabulary.
//
// Subject excerpts are deliberately excluded. A reply subject echoes the
// original by convention and by threading requirement, so guarding it would
// forbid the one repetition every mail client expects.
function guardedPhrasesFrom(excerpts) {
  const phrases = new Set();
  for (const excerpt of excerpts) {
    const words = excerpt.toLowerCase().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    for (let index = 0; index + MIN_GUARDED_PHRASE_WORDS <= words.length; index += 1) {
      phrases.add(words.slice(index, index + MIN_GUARDED_PHRASE_WORDS).join(' '));
      if (phrases.size >= MAX_GUARDED_PHRASES) return [...phrases];
    }
  }
  return [...phrases];
}

function createSelectEvidenceStage() {
  return {
    id: 'jobtrack.draft.select_evidence',
    version: 1,
    async run({ policy, intent }) {
      void intent;
      const seen = new Set();
      const admitted = [];
      for (const entry of policy.request.context.evidence) {
        if (!ADMISSIBLE_EVIDENCE_FIELDS.includes(entry.field)) continue;
        const excerpt = normalizeNfc(entry.excerpt);
        const key = `${entry.field}:${excerpt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        admitted.push({ field: entry.field, excerpt });
      }
      const subject = admitted.find((entry) => entry.field === 'subject');
      const guardedPhrases = guardedPhrasesFrom(
        admitted.filter((entry) => entry.field !== 'subject').map((entry) => entry.excerpt)
      );
      return {
        admitted,
        ...(subject ? { subjectExcerpt: subject.excerpt } : {}),
        guardedPhrases,
        evidenceDigest: digestCanonicalJson({ admitted, guardedPhrases })
      };
    }
  };
}

// --- stage 4 support: the deterministic tool-less composer -----------------

// One bounded template per purpose. The composer states only what JobTrack
// itself knows — that Cole received the message and how he will follow up — and
// never asserts a fact drawn from the untrusted excerpt.
const TEMPLATES = Object.freeze({
  acknowledgement: {
    templateId: 'jobtrack.reply.acknowledgement.v1',
    body: [
      'Thank you for the update.',
      '',
      'I appreciate you taking the time to let me know, and I have noted it.',
      '',
      'Best regards,',
      'Cole Shafer'
    ]
  },
  scheduling: {
    templateId: 'jobtrack.reply.scheduling.v1',
    body: [
      'Thank you for reaching out about scheduling.',
      '',
      'I am glad to find a time that works. Please let me know which of the',
      'proposed slots you would like to confirm, and I will make it work.',
      '',
      'Best regards,',
      'Cole Shafer'
    ]
  },
  information_response: {
    templateId: 'jobtrack.reply.information_response.v1',
    body: [
      'Thank you for the note.',
      '',
      'I have seen your request and will follow up with the requested details',
      'shortly. Please let me know if there is a deadline I should work to.',
      '',
      'Best regards,',
      'Cole Shafer'
    ]
  },
  follow_up: {
    templateId: 'jobtrack.reply.follow_up.v1',
    body: [
      'Thank you for following up.',
      '',
      'I remain interested and am happy to continue the conversation. Please',
      'let me know what would be most useful as a next step.',
      '',
      'Best regards,',
      'Cole Shafer'
    ]
  },
  other: {
    templateId: 'jobtrack.reply.general.v1',
    body: [
      'Thank you for your message.',
      '',
      'I have received it and will follow up shortly.',
      '',
      'Best regards,',
      'Cole Shafer'
    ]
  }
});

const REPLY_PREFIX = /^\s*re\s*:/i;

function replySubjectFrom(evidence) {
  const excerpt = evidence.subjectExcerpt;
  if (!excerpt) return 'Re: your message';
  const trimmed = excerpt.replace(/\s+/g, ' ').trim();
  if (!trimmed) return 'Re: your message';
  const subject = REPLY_PREFIX.test(trimmed) ? trimmed : `Re: ${trimmed}`;
  return subject.length > 900 ? `${subject.slice(0, 897)}...` : subject;
}

// The default model-binding resolver: a local, deterministic composer that
// satisfies the model-node port without a provider, a network call, or a
// credential. Substituting a real provider is a resolver change; the pipeline,
// its contracts, and its digests are unchanged.
function createDeterministicComposerResolver({ refusalFactory } = {}) {
  const refuse = refuserFrom(refusalFactory);
  return {
    async resolve(binding) {
      const profile = binding.inferenceProfileRef.parameters;
      if (profile.toolPolicy !== 'none') {
        refuse('draft_refused.tool_policy_not_none', 'The draft runner only executes tool-less model bindings', { refusals: ['tool_policy_not_none'] });
      }
      return {
        async invoke(request) {
          const started = process.hrtime.bigint();
          const { intent, evidence } = request.input;
          const template = TEMPLATES[intent.purpose] || TEMPLATES.other;
          const output = {
            subject: normalizeNfc(replySubjectFrom(evidence)),
            body: normalizeBodyV1(template.body.join('\n')),
            authorship: 'template',
            templateId: template.templateId,
            registerAdaptationOnly: true
          };
          const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
          return {
            output,
            usage: {
              schemaVersion: 'usage-receipt.v1',
              // No provider was called, so there is no telemetry to report and
              // the policy floor applies rather than an invented measurement.
              trust: 'unavailable',
              observedInputTokens: null,
              observedOutputTokens: null,
              chargedTokens: 1,
              observedCostMicroUsd: null,
              chargedCostMicroUsd: 1,
              durationMs,
              routeAlias: 'jobtrack-deterministic-composer'
            }
          };
        }
      };
    }
  };
}

// --- stage 5: enforce every safety rule and seal the pair ------------------

function assertRecipientLocked(refuse, request, recipient) {
  if (recipient !== request.source.replyToAddress) {
    refuse('draft_refused.recipient_not_locked', 'Composed recipient does not equal the imported reply-to address', { refusals: ['recipient_not_locked'] });
  }
}

// Only the body is scanned: the subject is a threading header that must echo.
function assertNoPhraseReuse(refuse, body, guardedPhrases) {
  const haystack = body.toLowerCase().replace(/\s+/g, ' ');
  const reused = guardedPhrases.filter((phrase) => haystack.includes(phrase));
  if (reused.length) {
    refuse('draft_refused.distinctive_phrase_reuse', 'Composed draft reuses the recipient\'s distinctive phrasing', {
      refusals: ['distinctive_phrase_reuse'],
      reused: reused.slice(0, 5)
    });
  }
}

function scanSensitive(subject, body) {
  const haystack = `${subject}\n${body}`;
  const hits = SENSITIVE_PATTERNS.filter(([, pattern]) => pattern.test(haystack)).map(([name]) => name);
  return { scan: hits.length ? 'requires_review' : 'passed', hits };
}

function createSealProposalStage({ now, proposalIdFor, contentIdFor, refusalFactory }) {
  const refuse = refuserFrom(refusalFactory);
  return {
    id: 'jobtrack.draft.seal_proposal',
    version: 1,
    async run({ policy, intent, evidence, composition }) {
      const request = policy.request;
      const checks = [];

      const subject = normalizeNfc(composition.subject);
      const body = normalizeBodyV1(composition.body);
      if (subject !== composition.subject || body !== composition.body) {
        refuse('draft_refused.composition_not_normalized', 'Composed text was not already LF + Unicode NFC normalized', { refusals: ['composition_not_normalized'] });
      }
      checks.push('normalization');

      assertRecipientLocked(refuse, request, request.source.replyToAddress);
      checks.push('recipient_locked');

      assertNoPhraseReuse(refuse, body, evidence.guardedPhrases);
      checks.push('distinctive_phrase_reuse');

      const { scan, hits } = scanSensitive(subject, body);
      if (hits.length) checks.push(`sensitive_data:${hits.join('|')}`);
      else checks.push('sensitive_data');

      const createdAt = now();
      if (!(parseTime(createdAt) < parseTime(request.expiresAt))) {
        refuse('draft_refused.request_expired', 'The request expired before composition completed', { refusals: ['request_expired'] });
      }
      checks.push('chronology');

      const proposal = validateReplyDraftProposalV3({
        schemaVersion: 'email-reply-draft-proposal.v3',
        normalizationVersion: NORMALIZATION_VERSION,
        proposalId: proposalIdFor(request),
        generationId: request.generationId,
        manifestDigest: request.manifestDigest,
        factsDigest: request.factsDigest,
        source: {
          provider: request.source.provider,
          accountId: request.source.accountId,
          messageId: request.source.messageId,
          threadId: request.source.threadId,
          replyToAddress: request.source.replyToAddress,
          inReplyTo: request.source.inReplyTo,
          references: [...request.source.references]
        },
        recipient: request.source.replyToAddress,
        subject,
        body,
        bodyDigest: digestUtf8Text(body),
        purpose: intent.purpose,
        authorship: composition.authorship,
        ...(composition.templateId ? { templateId: composition.templateId } : {}),
        expiresAt: request.expiresAt,
        sensitiveDataScan: scan,
        toneDecisionId: request.toneDecisionId,
        toneDecisionDigest: request.toneDecisionDigest,
        ...(request.styleProfileId ? {
          styleProfileId: request.styleProfileId,
          styleProfileDigest: request.styleProfileDigest
        } : {}),
        voiceRevisionId: request.voiceRevisionId,
        voiceRevisionDigest: request.voiceRevisionDigest,
        sourceStateSha256: request.sourceStateSha256,
        delivery: {
          provider: request.delivery.provider,
          accountId: request.delivery.accountId,
          sendFidelity: 'content_equivalent'
        },
        registerAdaptationOnly: true,
        distinctivePhraseReuse: false,
        requiresReview: true,
        autoSendEligible: false
      });

      const approvedContent = projectApprovedContentFromProposal(proposal, {
        contentId: contentIdFor(request),
        createdAt
      });
      checks.push('content_projection');

      return {
        proposal,
        approvedContent,
        safety: {
          recipientLocked: true,
          phraseReuseChecked: true,
          sensitiveDataScan: scan,
          checks
        }
      };
    }
  };
}

module.exports = Object.freeze({
  ADMISSIBLE_EVIDENCE_FIELDS,
  COMPOSITION_CONTRACT,
  DRAFT_REQUEST_CONTRACT,
  DraftRefusal,
  EVENT_PURPOSES,
  EVIDENCE_CONTRACT,
  INTENT_CONTRACT,
  OUTCOME_CONTRACT,
  POLICY_CONTRACT,
  TEMPLATES,
  createClassifyEventStage,
  createDeterministicComposerResolver,
  createSealProposalStage,
  createSelectEvidenceStage,
  createVerifyRequestStage,
  guardedPhrasesFrom,
  replySubjectFrom
});
