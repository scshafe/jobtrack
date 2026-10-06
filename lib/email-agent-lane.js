'use strict';

// lib/email-agent-lane.js — inbound email as FABRIC WORK for the applicant's agent
// (applysim plan L7-B). The relay delivers a proposal and JobTrack links the
// message to an application; from then on a real applicant reads it and
// decides — reply, move the application along, or nothing. This module gives
// the fabric that queue, records the decision, and assembles the transition
// proposal the review lanes require, so the agent never hand-builds contracts.
//
// Nothing here transmits, approves, or applies: replies still go through the
// outgoing-v2 lane (draft → auto-approve policy → send-approved), transitions
// through propose → review → apply. The agent supplies the judgment and the
// words; the lanes keep the evidence.

const { execFileSync } = require('node:child_process');
const { resolvePinnedGog } = require('../scripts/lib/pinned-gog.cjs');
const { sanitizedGogEnvironment } = require('../scripts/lib/gog-environment.cjs');
const { validateJobApplicationEmailFacts, validateTransitionProposal } = require('./email-contracts');
const { correlateEmailReadOnly, correlationDigest, proposeTransition, recordCorrelation, resolveCorrelation } = require('./email-integration');
const { clarificationReference, expireClarifications } = require('./email-correlation/clarify');
const { migrateReplyIntents, recordReplyIntent, recordReplySendStart, recordReplySupersession, listReplyIntents } = require('./email-reply-intents');

class EmailAgentLaneError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmailAgentLaneError';
    this.code = code;
  }
}

const HANDLING_DECISIONS = new Set(['reply', 'transition', 'reply_and_transition', 'none']);
const AUTHORSHIPS = new Set(['agent', 'human']);

function migrateEmailAgentLane(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_email_handling_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id),
      application_id INTEGER NOT NULL REFERENCES applications(id),
      decision TEXT NOT NULL CHECK (decision IN ('reply','transition','reply_and_transition','none')),
      actor TEXT NOT NULL,
      authorship TEXT NOT NULL CHECK (authorship IN ('agent','human')),
      reason TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      uuid TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16))))
    );
    CREATE INDEX IF NOT EXISTS idx_job_email_handling_decisions_message ON job_email_handling_decisions(message_ref_id);
    CREATE INDEX IF NOT EXISTS idx_job_email_handling_decisions_application ON job_email_handling_decisions(application_id);
    CREATE TABLE IF NOT EXISTS job_email_reply_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id),
      outcome TEXT NOT NULL CHECK (outcome IN ('failed','skipped')),
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      uuid TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16))))
    );
    CREATE INDEX IF NOT EXISTS idx_job_email_reply_attempts_message ON job_email_reply_attempts(message_ref_id);
  `);
  migrateReplyIntents(db);
}

/**
 * The agent's record of a reply attempt that produced no outgoing proposal
 * (refused before synthesis, a failed recipe step, a deliberate skip). It is
 * what lets the owed-reply lane wait out its retry window instead of
 * re-staffing the same failure every pass.
 */
function recordReplyAttempt(db, input) {
  migrateEmailAgentLane(db);
  const messageRefId = Number(input.messageRefId);
  if (!Number.isInteger(messageRefId) || messageRefId < 1) throw new EmailAgentLaneError('INVALID_INPUT', '--message-ref-id must be a positive integer');
  if (!db.prepare('SELECT 1 FROM job_email_message_refs WHERE id=?').get(messageRefId)) throw new EmailAgentLaneError('NOT_FOUND', `message ref ${messageRefId} not found`);
  const outcome = String(input.outcome ?? '');
  if (!['failed', 'skipped'].includes(outcome)) throw new EmailAgentLaneError('INVALID_INPUT', '--outcome must be failed or skipped');
  const reason = String(input.reason ?? '').trim();
  if (!reason || reason.length > 1000) throw new EmailAgentLaneError('INVALID_INPUT', '--reason is required (at most 1000 characters)');
  const key = String(input.idempotencyKey ?? '').trim();
  if (!key) throw new EmailAgentLaneError('INVALID_INPUT', '--idempotency-key is required');
  const existing = db.prepare('SELECT id, message_ref_id, outcome FROM job_email_reply_attempts WHERE idempotency_key=?').get(key);
  if (existing) {
    if (existing.message_ref_id !== messageRefId || existing.outcome !== outcome) throw new EmailAgentLaneError('IDEMPOTENCY_CONFLICT', 'idempotency key already bound to a different reply attempt');
    return { attemptId: existing.id, reused: true };
  }
  const info = db.prepare('INSERT INTO job_email_reply_attempts(message_ref_id, outcome, actor, reason, idempotency_key) VALUES (?,?,?,?,?)')
    .run(messageRefId, outcome, String(input.actor ?? 'fabric-worker'), reason, key);
  return { attemptId: Number(info.lastInsertRowid), reused: false };
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name));
}

function activeApplicationLinksSource(db) {
  return tableExists(db, 'active_job_email_application_links')
    ? 'active_job_email_application_links'
    : 'job_email_application_links';
}

function activeLinkedCorrelationsSource(db) {
  return tableExists(db, 'active_job_email_linked_correlations')
    ? 'active_job_email_linked_correlations'
    : 'job_email_correlations';
}

function activeCorrelationCandidateRows(db, correlationId, messageRefId) {
  const retractionGuard = tableExists(db, 'email_link_retractions')
    ? `AND NOT EXISTS (
        SELECT 1 FROM email_link_retractions retraction
        WHERE retraction.message_ref_id=?
          AND (retraction.application_id=candidate.application_id OR retraction.application_id IS NULL)
      )`
    : '';
  return db.prepare(`
    SELECT candidate.application_id, candidate.match_basis, candidate.confidence
    FROM job_email_correlation_candidates candidate
    WHERE candidate.correlation_id=? ${retractionGuard}
    ORDER BY candidate.id ASC
  `).all(...(retractionGuard ? [correlationId, messageRefId] : [correlationId]));
}

function hasRelevantHandlingDecision(db, messageRefId, applicationIds) {
  const offered = new Set(applicationIds.map(Number).filter(Number.isInteger));
  if (offered.size === 0) return false;
  return db.prepare(`
    SELECT application_id FROM job_email_handling_decisions WHERE message_ref_id=?
  `).all(messageRefId).some((decision) => offered.has(Number(decision.application_id)));
}

/**
 * Decisions that retire a (message, application) pairing. A `none` judgment
 * made while the record could not ask the sender (an ambiguous correlation
 * that was not clarifiable) is provisional: once a newer correlation is
 * recorded for the message, the pair is open again and the agent looks at it
 * afresh. Every other decision, and a `none` made against the newest
 * correlation, is final.
 */
function retiringDecisions(db, messageRefId, applicationIds, correlationCreatedAt) {
  const retired = new Set();
  if (!applicationIds.length) return retired;
  const rows = db.prepare(`
    SELECT application_id, decision, created_at FROM job_email_handling_decisions
    WHERE message_ref_id=? AND application_id IN (${applicationIds.map(() => '?').join(',')})
  `).all(messageRefId, ...applicationIds);
  const recordedAt = storedTimestampMs(correlationCreatedAt);
  for (const row of rows) {
    if (row.decision !== 'none' || !Number.isFinite(recordedAt) || storedTimestampMs(row.created_at) >= recordedAt) {
      retired.add(Number(row.application_id));
    }
  }
  return retired;
}

/** A decision that acted on the message (anything but `none`) for any of these applications. */
function hasFinalHandlingDecision(db, messageRefId, applicationIds) {
  if (!applicationIds.length) return false;
  return Boolean(db.prepare(`
    SELECT 1 FROM job_email_handling_decisions
    WHERE message_ref_id=? AND decision<>'none' AND application_id IN (${applicationIds.map(() => '?').join(',')}) LIMIT 1
  `).get(messageRefId, ...applicationIds));
}

function hasHandlingDecisionForEvery(db, messageRefId, applicationIds) {
  const offered = new Set(applicationIds.map(Number).filter(Number.isInteger));
  if (offered.size === 0) return false;
  const decided = new Set(db.prepare(`
    SELECT application_id FROM job_email_handling_decisions WHERE message_ref_id=?
  `).all(messageRefId).map((decision) => Number(decision.application_id)));
  return [...offered].every((candidateId) => decided.has(candidateId));
}

function parseFacts(row) {
  try {
    return validateJobApplicationEmailFacts(JSON.parse(row.facts_json));
  } catch {
    return null;
  }
}

/**
 * Linked inbound messages that no decision has been recorded for yet — the
 * applicant's inbox as the fabric sees it. Newest first is wrong for an inbox
 * that must be worked in order, so oldest first.
 */
function listInboundQueue(db, { applicationId, now = new Date() } = {}) {
  if (!tableExists(db, 'job_email_correlations') || !tableExists(db, 'job_email_message_refs')) return [];
  migrateEmailAgentLane(db);
  expireClarifications(db, { now });
  const activeLinks = activeApplicationLinksSource(db);
  const activeCorrelations = activeLinkedCorrelationsSource(db);
  // The relay RECORDS a correlation; a link row only appears once a link_message
  // transition is applied. The applicant's inbox is therefore every message whose
  // newest recorded correlation resolved `linked` to an application — plus any
  // message already linked — with no handling decision for that pairing yet.
  const rows = db.prepare(`
    WITH latest AS (
      SELECT c.message_ref_id, MAX(c.id) AS correlation_id
      FROM job_email_correlations c
      GROUP BY c.message_ref_id
    ),
    linked AS (
      SELECT c.message_ref_id, c.resolved_application_id AS application_id, 'correlation' AS via, c.created_at AS linked_at
      FROM latest
      JOIN ${activeCorrelations} c ON c.id = latest.correlation_id
      WHERE c.resolution = 'linked' AND c.resolved_application_id IS NOT NULL
      UNION
      SELECT l.message_ref_id, l.application_id, 'link', l.created_at
      FROM ${activeLinks} l
    )
    SELECT DISTINCT linked.message_ref_id, linked.application_id, linked.via, linked.linked_at,
           m.provider, m.account_id, m.message_id, m.thread_id, m.received_at,
           m.from_address, m.from_domain, m.reply_to_address, m.event_kind, m.security_risk, m.requires_review,
           m.content_completeness, m.facts_json, m.facts_digest
    FROM linked
    JOIN job_email_message_refs m ON m.id = linked.message_ref_id
    WHERE (? IS NULL OR linked.application_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM job_email_handling_decisions d
        WHERE d.message_ref_id = linked.message_ref_id AND d.application_id = linked.application_id
      )
    ORDER BY m.received_at ASC, m.id ASC
  `).all(applicationId ?? null, applicationId ?? null);
  const ambiguousRows = db.prepare(`
    WITH latest AS (
      SELECT c.message_ref_id, MAX(c.id) AS correlation_id FROM job_email_correlations c GROUP BY c.message_ref_id
    )
    SELECT c.id AS correlation_id, c.message_ref_id, c.created_at AS linked_at,c.correlation_json,
           m.provider, m.account_id, m.message_id, m.thread_id, m.received_at,
           m.from_address, m.from_domain, m.reply_to_address, m.event_kind, m.security_risk, m.requires_review,
           m.content_completeness, m.facts_json, m.facts_digest
    FROM latest
    JOIN job_email_correlations c ON c.id = latest.correlation_id
    JOIN job_email_message_refs m ON m.id = c.message_ref_id
    WHERE c.resolution = 'ambiguous'
    ORDER BY m.received_at ASC, m.id ASC
  `).all();
  const clarificationStatement = tableExists(db, 'email_clarifications') ? db.prepare(`
    SELECT clarification_id,status,expires_at,asked_at,sent_message_id,outgoing_proposal_id,question_text,candidate_snapshot_json
    FROM email_clarifications WHERE message_ref_id=? ORDER BY id DESC LIMIT 1
  `) : null;
  const seen = new Set();
  const queue = [];
  for (const row of ambiguousRows) {
    const clarification = clarificationStatement?.get(row.message_ref_id) || null;
    // Once the sender answered, the original ambiguity is closed. The answer
    // itself enters this queue as its exact linked message.
    if (clarification?.status === 'answered') continue;
    const candidates = activeCorrelationCandidateRows(db, row.correlation_id, row.message_ref_id)
      .map((c) => ({ applicationId: c.application_id, matchBasis: c.match_basis, confidence: c.confidence }));
    if (candidates.length === 0) continue;
    if (applicationId !== undefined && applicationId !== null && !candidates.some((c) => c.applicationId === Number(applicationId))) continue;
    const decisionApplications = applicationId === undefined || applicationId === null
      ? candidates.map((candidate) => candidate.applicationId)
      : [Number(applicationId)];
    const retired = retiringDecisions(db, row.message_ref_id, decisionApplications, row.linked_at);
    if (decisionApplications.every((id) => retired.has(id))) continue;
    const facts = parseFacts(row);
    let storedCorrelation = null;
    try { storedCorrelation = JSON.parse(row.correlation_json); } catch { /* reported as non-clarifiable */ }
    queue.push({
      messageRefId: row.message_ref_id,
      applicationId: applicationId ?? null,
      // The correlation this ambiguity comes from; a re-correlation mints a new
      // one, and with it fresh work for candidates only judged `none` before.
      correlationId: row.correlation_id,
      via: clarification?.status === 'pending' ? 'clarifying' : 'ambiguous',
      clarifiable: Boolean(storedCorrelation?.clarifiable),
      candidates,
      ...(clarification ? { clarification: {
        clarificationId: clarification.clarification_id,
        status: clarification.status,
        askedAt: clarification.asked_at,
        sentMessageId: clarification.sent_message_id,
        proposalId: clarification.outgoing_proposal_id,
        expiresAt: clarification.expires_at,
        question: clarification.question_text,
        candidates: JSON.parse(clarification.candidate_snapshot_json).candidates
      } } : {}),
      linkedAt: row.linked_at,
      source: {
        provider: row.provider, accountId: row.account_id, messageId: row.message_id, threadId: row.thread_id,
        receivedAt: row.received_at, fromAddress: row.from_address, fromDomain: row.from_domain,
        replyToAddress: row.reply_to_address ?? row.from_address,
        ...(facts && clarificationReference(facts) ? { conversationReference: clarificationReference(facts) } : {})
      },
      eventKind: row.event_kind,
      securityRisk: row.security_risk,
      requiresReview: Boolean(row.requires_review),
      contentCompleteness: row.content_completeness,
      factsDigest: row.facts_digest,
      facts: facts ? {
        eventKind: facts.eventKind, company: facts.company ?? null, interview: facts.interview ?? null,
        requestedAction: facts.requestedAction ?? null, replyRequested: facts.replyRequested ?? null,
        evidence: facts.evidence ?? [], extraction: facts.extraction ?? null, security: facts.security,
        conversationReference: clarificationReference(facts)
      } : null
    });
    seen.add(`${row.message_ref_id}:ambiguous`);
  }
  for (const row of rows) {
    const pairing = `${row.message_ref_id}:${row.application_id}`;
    if (seen.has(pairing)) continue;
    seen.add(pairing);
    const facts = parseFacts(row);
    queue.push({
      messageRefId: row.message_ref_id,
      applicationId: row.application_id,
      via: row.via,
      linkedAt: row.linked_at,
      source: {
        provider: row.provider,
        accountId: row.account_id,
        messageId: row.message_id,
        threadId: row.thread_id,
        receivedAt: row.received_at,
        fromAddress: row.from_address,
        fromDomain: row.from_domain,
        replyToAddress: row.reply_to_address ?? row.from_address,
        ...(facts && clarificationReference(facts) ? { conversationReference: clarificationReference(facts) } : {})
      },
      eventKind: row.event_kind,
      securityRisk: row.security_risk,
      requiresReview: Boolean(row.requires_review),
      contentCompleteness: row.content_completeness,
      factsDigest: row.facts_digest,
      // What the agent may read: the imported facts (sanitized, provider-neutral),
      // never raw mail. Interview details, requested actions, and replyRequested
      // ride here when the extraction produced them.
      facts: facts ? {
        eventKind: facts.eventKind,
        company: facts.company ?? null,
        interview: facts.interview ?? null,
        requestedAction: facts.requestedAction ?? null,
        replyRequested: facts.replyRequested ?? null,
        evidence: facts.evidence ?? [],
        extraction: facts.extraction ?? null,
        security: facts.security,
        conversationReference: clarificationReference(facts)
      } : null
    });
  }
  return queue;
}

/** Record what the applicant's agent decided about one linked message. Idempotent by key. */
function recordHandlingDecision(db, input) {
  migrateEmailAgentLane(db);
  const messageRefId = Number(input.messageRefId);
  const applicationId = Number(input.applicationId);
  if (!Number.isInteger(messageRefId) || messageRefId < 1) throw new EmailAgentLaneError('INVALID_INPUT', '--message-ref-id must be a positive integer');
  if (!Number.isInteger(applicationId) || applicationId < 1) throw new EmailAgentLaneError('INVALID_INPUT', '--application-id must be a positive integer');
  if (!HANDLING_DECISIONS.has(input.decision)) throw new EmailAgentLaneError('INVALID_INPUT', `--decision must be one of ${[...HANDLING_DECISIONS].join('|')}`);
  if (!AUTHORSHIPS.has(input.authorship)) throw new EmailAgentLaneError('INVALID_INPUT', '--authorship must be agent or human');
  const actor = String(input.actor ?? '').trim();
  const reason = String(input.reason ?? '').trim();
  const key = String(input.idempotencyKey ?? '').trim();
  if (!actor || actor.length > 120) throw new EmailAgentLaneError('INVALID_INPUT', '--actor is required (1..120 chars)');
  if (!reason || reason.length > 1000) throw new EmailAgentLaneError('INVALID_INPUT', '--reason is required (1..1000 chars)');
  if (!key || key.length > 200) throw new EmailAgentLaneError('INVALID_INPUT', '--idempotency-key is required (1..200 chars)');
  // A committed idempotent operation remains replayable even when a later
  // correlation changes which application is currently authorized. Validate
  // its complete immutable intent before consulting that mutable state so a
  // changed payload still conflicts rather than degrading to NOT_LINKED.
  const existing = db.prepare('SELECT * FROM job_email_handling_decisions WHERE idempotency_key=?').get(key);
  if (existing) {
    const same = existing.message_ref_id === messageRefId && existing.application_id === applicationId
      && existing.decision === input.decision && existing.actor === actor && existing.authorship === input.authorship && existing.reason === reason;
    if (!same) throw new EmailAgentLaneError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different handling decision');
    return { decisionId: existing.id, reused: true };
  }
  const activeLinks = activeApplicationLinksSource(db);
  const activeCorrelations = activeLinkedCorrelationsSource(db);
  const ambiguousRetractionGuard = tableExists(db, 'email_link_retractions')
    ? `AND NOT EXISTS (
        SELECT 1 FROM email_link_retractions retraction
        WHERE retraction.message_ref_id=c.message_ref_id
          AND (retraction.application_id=k.application_id OR retraction.application_id IS NULL)
      )`
    : '';
  const paired = db.prepare(`
    SELECT 1 FROM ${activeLinks} WHERE message_ref_id=? AND application_id=?
    UNION ALL
    SELECT 1 FROM ${activeCorrelations} WHERE message_ref_id=? AND resolution='linked' AND resolved_application_id=?
    UNION ALL
    SELECT 1 FROM job_email_correlations c JOIN job_email_correlation_candidates k ON k.correlation_id = c.id
    WHERE c.id=(SELECT MAX(latest.id) FROM job_email_correlations latest WHERE latest.message_ref_id=?)
      AND c.resolution='ambiguous' AND k.application_id=? ${ambiguousRetractionGuard}
  `).get(messageRefId, applicationId, messageRefId, applicationId, messageRefId, applicationId);
  if (!paired) throw new EmailAgentLaneError('NOT_LINKED', `message ${messageRefId} is not linked or correlated to application ${applicationId}`);
  const prior = db.prepare('SELECT id, decision, created_at FROM job_email_handling_decisions WHERE message_ref_id=? AND application_id=? ORDER BY id DESC LIMIT 1').get(messageRefId, applicationId);
  // A provisional `none` (see retiringDecisions) may be superseded once a newer
  // correlation has been recorded for the message; anything else is final.
  const superseded = prior && prior.decision === 'none' && Boolean(db.prepare(
    'SELECT 1 FROM job_email_correlations WHERE message_ref_id=? AND created_at>? LIMIT 1'
  ).get(messageRefId, prior.created_at));
  if (prior && !superseded) throw new EmailAgentLaneError('ALREADY_HANDLED', `message ${messageRefId} already has a handling decision (#${prior.id})`);
  const result = db.prepare(`
    INSERT INTO job_email_handling_decisions (message_ref_id, application_id, decision, actor, authorship, reason, idempotency_key)
    VALUES (?,?,?,?,?,?,?)
  `).run(messageRefId, applicationId, input.decision, actor, input.authorship, reason, key);
  return { decisionId: Number(result.lastInsertRowid), reused: false };
}

function policyCandidateFor(kind) {
  if (kind === 'link_message') return 'exact_link';
  if (kind === 'transition_application_status') return 'exact_status';
  if (['create_interview', 'reschedule_interview', 'cancel_interview'].includes(kind)) return 'exact_interview';
  return 'never';
}

/**
 * Assemble the transition proposal the review lane requires, from what the
 * store already holds about a LINKED message — the agent supplies only the
 * action and its evidence. Agent proposals always require review (the agent
 * performs the review under the arc's standing policy), so they are never
 * automation-eligible; the contract's own validator checks the result.
 */
function buildTransitionProposal(db, input) {
  const messageRefId = Number(input.messageRefId);
  if (!Number.isInteger(messageRefId) || messageRefId < 1) throw new EmailAgentLaneError('INVALID_INPUT', '--message-ref-id must be a positive integer');
  const message = db.prepare('SELECT * FROM job_email_message_refs WHERE id=?').get(messageRefId);
  if (!message) throw new EmailAgentLaneError('NOT_FOUND', `message ref ${messageRefId} not found`);
  const correlation = db.prepare(`
    SELECT * FROM ${activeLinkedCorrelationsSource(db)} WHERE message_ref_id=? AND facts_digest=? ORDER BY id DESC LIMIT 1
  `).get(messageRefId, message.facts_digest);
  if (!correlation) throw new EmailAgentLaneError('NOT_CORRELATED', `message ${messageRefId} has no recorded correlation`);
  const stored = JSON.parse(correlation.correlation_json);
  if (stored.resolution !== 'linked' || !stored.resolved) throw new EmailAgentLaneError('NOT_LINKED', `message ${messageRefId} is ${stored.resolution}, not linked`);
  const facts = parseFacts(message);
  if (!facts) throw new EmailAgentLaneError('FACTS_INVALID', 'stored facts do not validate');
  const action = input.action;
  if (!action || typeof action !== 'object' || typeof action.kind !== 'string') throw new EmailAgentLaneError('INVALID_INPUT', '--action-json must be an object with a kind');
  const evidence = Array.isArray(input.evidence) ? input.evidence.map((e) => String(e).slice(0, 500)).filter(Boolean) : [];
  if (evidence.length === 0) throw new EmailAgentLaneError('INVALID_INPUT', 'at least one --evidence item is required');
  // The lane verifies the target against the correlation's normalized identity:
  // every id the resolved candidate carries rides into the target.
  const target = { applicationId: stored.resolved.applicationId };
  for (const key of ['companyId', 'openingId', 'postingId', 'postingOccurrenceId', 'interviewId']) {
    if (stored.resolved[key] !== undefined && stored.resolved[key] !== null) target[key] = stored.resolved[key];
  }
  if (['reschedule_interview', 'cancel_interview'].includes(action.kind)) target.interviewId = action.interviewId;
  if (action.kind === 'create_interview') delete target.interviewId;
  const proposal = {
    schemaVersion: 'jobtrack-transition-proposal.v1',
    proposalId: String(input.proposalId ?? `agent-transition-${messageRefId}-${action.kind}`),
    source: { provider: message.provider, accountId: message.account_id, messageId: message.message_id, threadId: message.thread_id },
    factsDigest: message.facts_digest,
    correlationDigest: correlation.correlation_digest,
    target,
    expectedApplicationVersion: stored.resolved.applicationVersion,
    correlation: { resolution: 'linked', matchBasis: stored.resolved.matchBasis, confidence: stored.resolved.confidence },
    safety: {
      contentCompleteness: facts.contentCompleteness,
      securityRisk: facts.security.risk,
      sourceRequiresReview: facts.security.requiresReview
    },
    action,
    policyCandidate: policyCandidateFor(action.kind),
    requiresReview: true,
    automationEligible: false,
    evidence
  };
  return validateTransitionProposal(proposal);
}

/** Build AND propose in one act; the agent then reviews and applies through the existing lane. */
function transitionFromAgent(db, input) {
  const proposal = buildTransitionProposal(db, input);
  const key = String(input.idempotencyKey ?? '').trim();
  if (!key) throw new EmailAgentLaneError('INVALID_INPUT', '--idempotency-key is required');
  const proposed = proposeTransition(db, proposal, key);
  return { ...proposed, proposal: { proposalId: proposal.proposalId, action: proposal.action, target: proposal.target, expectedApplicationVersion: proposal.expectedApplicationVersion } };
}

/**
 * The applicant resolves an ambiguous correlation to one of its candidate
 * applications (the lane's operator-resolution verb, with the agent as the
 * operator under the arc's standing policy). The result is a `linked`,
 * non-automatic correlation — downstream transitions still go through review.
 */
function resolveFromAgent(db, input) {
  const messageRefId = Number(input.messageRefId);
  const applicationId = Number(input.applicationId);
  if (!Number.isInteger(messageRefId) || messageRefId < 1) throw new EmailAgentLaneError('INVALID_INPUT', '--message-ref-id must be a positive integer');
  if (!Number.isInteger(applicationId) || applicationId < 1) throw new EmailAgentLaneError('INVALID_INPUT', '--application-id must be a positive integer');
  const message = db.prepare('SELECT * FROM job_email_message_refs WHERE id=?').get(messageRefId);
  if (!message) throw new EmailAgentLaneError('NOT_FOUND', `message ref ${messageRefId} not found`);
  const key = String(input.idempotencyKey ?? '').trim();
  if (!key) throw new EmailAgentLaneError('INVALID_INPUT', '--idempotency-key is required');
  return resolveCorrelation(db, {
    source: { provider: message.provider, accountId: message.account_id, messageId: message.message_id, threadId: message.thread_id },
    factsDigest: message.facts_digest,
    applicationId,
    actor: String(input.actor ?? 'fabric-worker'),
    reason: String(input.reason ?? 'resolved by the applicant\'s agent')
  }, key);
}

/**
 * Inbound messages whose NEWEST recorded correlation is `unmatched` but whose
 * live read-only correlation now proposes candidates (the record grew: a
 * company domain was learned, a new correlation basis shipped, an application
 * was promoted after the mail arrived) — messages that were IMPORTED but
 * never had any correlation recorded at all (the relay's record step failed
 * after its import, e.g. a stale correlation terminalized the delivery), which
 * would otherwise be invisible to every lane — and messages recorded
 * `ambiguous` whose live result has since changed (2026-09-03: a first-contact
 * message from an unknown sender that named no role was ambiguous but NOT
 * clarifiable, because nothing identified the company yet; once a later
 * message taught the sender's contact, the same message became clarifiable).
 * Scoped to an application, only the messages whose live candidates include
 * it. Read-only: the fabric's `email.recorrelate` tick node records the fresh
 * correlation.
 */
function listStaleUnmatched(db, { applicationId } = {}) {
  if (!tableExists(db, 'job_email_correlations') || !tableExists(db, 'job_email_message_refs')) return [];
  migrateEmailAgentLane(db);
  const activeCorrelations = activeLinkedCorrelationsSource(db);
  const rows = db.prepare(`
    WITH latest AS (
      SELECT c.message_ref_id, MAX(c.id) AS correlation_id FROM job_email_correlations c GROUP BY c.message_ref_id
    ),
    stale AS (
      SELECT c.id AS correlation_id, c.resolution AS recorded, c.correlation_digest,
             c.message_ref_id, m.event_kind, m.from_domain, m.from_address,
             m.received_at, m.id AS message_id, m.facts_json
      FROM latest
      JOIN job_email_correlations c ON c.id = latest.correlation_id
      JOIN job_email_message_refs m ON m.id = c.message_ref_id
      WHERE c.resolution IN ('unmatched', 'ambiguous')
         OR (c.resolution='linked' AND NOT EXISTS (
           SELECT 1 FROM ${activeCorrelations} active WHERE active.id=c.id
         ))
      UNION ALL
      SELECT NULL AS correlation_id, NULL AS recorded, NULL AS correlation_digest,
             m.id AS message_ref_id, m.event_kind, m.from_domain, m.from_address,
             m.received_at, m.id AS message_id, m.facts_json
      FROM job_email_message_refs m
      WHERE NOT EXISTS (SELECT 1 FROM job_email_correlations c WHERE c.message_ref_id = m.id)
    )
    SELECT correlation_id, recorded, correlation_digest, message_ref_id, event_kind, from_domain, from_address, received_at, facts_json
    FROM stale
    ORDER BY received_at ASC, message_id ASC
  `).all();
  const stale = [];
  for (const row of rows) {
    let live;
    try {
      live = correlateEmailReadOnly(db, JSON.parse(row.facts_json));
    } catch {
      continue; // unreadable facts stay where they are; nothing to re-correlate
    }
    if (live.resolution === 'unmatched') continue;
    // An ambiguous record is stale only when the live result actually differs;
    // an identical result would re-record the same row on every pass.
    if (row.recorded === 'ambiguous' && correlationDigest(live) === row.correlation_digest) continue;
    const retracted = tableExists(db, 'email_link_retractions')
      ? new Set(db.prepare(`
          SELECT application_id FROM email_link_retractions
          WHERE message_ref_id=?
        `).all(row.message_ref_id).map((entry) => entry.application_id))
      : new Set();
    const liveCandidates = live.candidates.filter((candidate) => !retracted.has(null) && !retracted.has(candidate.applicationId));
    const offered = live.resolution === 'linked' && live.resolved && !retracted.has(null) && !retracted.has(live.resolved.applicationId)
      ? [live.resolved.applicationId]
      : liveCandidates.map((candidate) => candidate.applicationId);
    if (offered.length === 0) continue;
    if (applicationId !== undefined && applicationId !== null && !offered.includes(Number(applicationId))) continue;
    const decisionApplications = applicationId === undefined || applicationId === null
      ? offered
      : [Number(applicationId)];
    // A `none` judged against an ambiguous record that could not ask does not
    // pin that record; a decision that acted on the message does.
    const blocked = row.recorded === 'ambiguous'
      ? hasFinalHandlingDecision(db, row.message_ref_id, decisionApplications)
      : hasRelevantHandlingDecision(db, row.message_ref_id, decisionApplications);
    if (blocked) continue;
    stale.push({
      messageRefId: row.message_ref_id,
      // null: imported, never correlated (no correlation row exists yet).
      correlationId: row.correlation_id,
      // The newest recorded resolution this re-correlation supersedes.
      recorded: row.recorded,
      eventKind: row.event_kind,
      fromDomain: row.from_domain,
      fromAddress: row.from_address,
      receivedAt: row.received_at,
      live: {
        resolution: live.resolution,
        candidates: liveCandidates.map((candidate) => ({ applicationId: candidate.applicationId, matchBasis: candidate.matchBasis, confidence: candidate.confidence }))
      }
    });
  }
  return stale;
}


/** SQLite's datetime('now') text or an ISO string → epoch ms (NaN when unreadable). */
function storedTimestampMs(value) {
  if (!value) return NaN;
  const text = String(value);
  return Date.parse(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
}
const REPLY_RETRY_MINUTES = 8; // one attempt per loop pass

/**
 * Linked, decided inbound messages that still owe the applicant's reply: the
 * kind expects one (an interview invite, an offer, or replyRequested facts) and
 * no send receipt with outcome sent/duplicate exists for any outgoing proposal
 * answering the message. Arc 2 (2026-09-02): the invite was moved to
 * interviewing but its reply failed inside the draft recipe; a real applicant
 * goes back and answers — this is how the fabric remembers to.
 *
 * Bounded: a message whose newest outgoing attempt is younger than
 * REPLY_RETRY_MINUTES is not offered again yet (one attempt per window). When
 * an approved draft already exists for the message, the entry names it
 * (pendingApproval) so the next attempt sends it instead of drafting again.
 */
function listOutstandingReplies(db, { applicationId, now = new Date() } = {}) {
  if (!tableExists(db, 'job_email_correlations') || !tableExists(db, 'job_email_message_refs') || !tableExists(db, 'job_email_handling_decisions')) return [];
  const hasIntents = tableExists(db, 'job_email_reply_intents');
  const activeLinks = activeApplicationLinksSource(db);
  const activeCorrelations = activeLinkedCorrelationsSource(db);
  const hasProposals = tableExists(db, 'job_email_outgoing_proposals_v3');
  const hasRequests = tableExists(db, 'job_email_send_requests_v2');
  const hasReceipts = tableExists(db, 'job_email_send_receipt_correlations_v2');
  const replyIntents = new Map(listReplyIntents(db, { applicationId }).map(intent => [`${intent.messageRefId}:${intent.applicationId}`, intent]));
  const rows = db.prepare(`
    WITH latest AS (
      SELECT c.message_ref_id, MAX(c.id) AS correlation_id FROM job_email_correlations c GROUP BY c.message_ref_id
    ),
    linked AS (
      SELECT c.message_ref_id, c.resolved_application_id AS application_id
      FROM latest JOIN ${activeCorrelations} c ON c.id = latest.correlation_id
      WHERE c.resolution = 'linked' AND c.resolved_application_id IS NOT NULL
      UNION
      SELECT l.message_ref_id, l.application_id FROM ${activeLinks} l
      ${hasIntents ? 'UNION SELECT message_ref_id, application_id FROM job_email_reply_intents' : ''}
    )
    SELECT DISTINCT linked.message_ref_id, linked.application_id,
           m.provider, m.account_id, m.message_id, m.thread_id, m.received_at,
           m.from_address, m.from_domain, m.reply_to_address, m.event_kind, m.security_risk, m.requires_review, m.facts_json,
           d.decision, d.reason AS decision_reason, d.created_at AS decided_at
    FROM linked
    JOIN job_email_message_refs m ON m.id = linked.message_ref_id
    LEFT JOIN job_email_handling_decisions d ON d.message_ref_id = linked.message_ref_id AND d.application_id = linked.application_id
      AND d.id=(SELECT MAX(latest_decision.id) FROM job_email_handling_decisions latest_decision
        WHERE latest_decision.message_ref_id=linked.message_ref_id AND latest_decision.application_id=linked.application_id)
    WHERE (? IS NULL OR linked.application_id = ?)
      AND (d.id IS NOT NULL ${hasIntents ? `OR EXISTS (SELECT 1 FROM job_email_reply_intents intent
        WHERE intent.message_ref_id=linked.message_ref_id AND intent.application_id=linked.application_id)` : ''})
    ORDER BY m.received_at ASC, m.id ASC
  `).all(applicationId ?? null, applicationId ?? null);
  const outstanding = [];
  for (const row of rows) {
    const facts = parseFacts(row);
    const replyIntent = replyIntents.get(`${row.message_ref_id}:${row.application_id}`);
    if (replyIntent && replyIntent.status !== 'pending' && !replyIntent.reconcileOnly) continue;
    // The applicant's decision rules. A reply is owed when they MEANT to send
    // one and it never left: a decision of reply/reply_and_transition with no
    // send receipt, or a recorded failed reply attempt (jobtrack email
    // reply-attempt) with no receipt. A plain "transition" or "none" is their
    // considered choice not to write — a confirmation recorded as an
    // interview owes nothing, whatever the classifier's label or replyRequested
    // flag said (arc 3: every company mail arrived as interview_invite,
    // replyRequested true).
    const meantToReply = Boolean(replyIntent) || row.decision === 'reply' || row.decision === 'reply_and_transition';
    const failedAttempts = db.prepare("SELECT count(*) AS n FROM job_email_reply_attempts WHERE message_ref_id=? AND outcome='failed'").get(row.message_ref_id).n;
    if (!meantToReply && failedAttempts === 0) continue;
    if (row.security_risk === 'high' && !replyIntent?.reconcileOnly) continue;
    let attempts = [];
    if (hasProposals) {
      attempts = db.prepare('SELECT proposal_id, created_at FROM job_email_outgoing_proposals_v3 WHERE message_ref_id=? ORDER BY created_at ASC').all(row.message_ref_id);
    }
    // Attempts that never reached a proposal (recorded by the agent) count too.
    // Timestamps arrive in two spellings (ISO from the recipe, SQLite's
    // "YYYY-MM-DD HH:MM:SS" from datetime('now')): order by instant, not text.
    attempts = attempts.concat(
      db.prepare('SELECT idempotency_key AS proposal_id, created_at FROM job_email_reply_attempts WHERE message_ref_id=? ORDER BY created_at ASC').all(row.message_ref_id)
    ).map((attempt) => ({ ...attempt, atMs: storedTimestampMs(attempt.created_at) }))
      .sort((left, right) => (left.atMs || 0) - (right.atMs || 0));
    let replied = false;
    if (hasProposals && hasRequests && hasReceipts && attempts.length) {
      replied = Boolean(db.prepare(`
        SELECT 1 FROM job_email_send_receipt_correlations_v2 r
        JOIN job_email_send_requests_v2 q ON q.request_id = r.send_request_id
        JOIN job_email_outgoing_proposals_v3 p ON p.proposal_id = q.proposal_id
        WHERE p.message_ref_id = ? AND r.outcome IN ('sent', 'duplicate') LIMIT 1
      `).get(row.message_ref_id));
    }
    if (replied && !replyIntent) continue;
    let pendingApproval = null;
    if ((!replyIntent || replyIntent.sendBindingUnambiguous) && hasProposals && tableExists(db, 'job_email_approval_receipts_v2')) {
      pendingApproval = db.prepare(`
        SELECT a.approval_id AS approvalId, a.proposal_id AS proposalId, a.expires_at AS expiresAt
        FROM job_email_approval_receipts_v2 a
        JOIN job_email_outgoing_proposals_v3 p ON p.proposal_id = a.proposal_id
        WHERE p.message_ref_id = ? ORDER BY a.approved_at DESC LIMIT 1
      `).get(row.message_ref_id) ?? null;
    }
    const lastAttemptMs = attempts.length ? attempts[attempts.length - 1].atMs : NaN;
    const lastAttemptAt = Number.isFinite(lastAttemptMs) ? new Date(lastAttemptMs).toISOString() : null;
    const coolingDown = Number.isFinite(lastAttemptMs) && now.getTime() - lastAttemptMs < REPLY_RETRY_MINUTES * 60_000;
    const retryAt = Number.isFinite(lastAttemptMs) ? new Date(lastAttemptMs + REPLY_RETRY_MINUTES * 60_000).toISOString() : null;
    outstanding.push({
      messageRefId: row.message_ref_id,
      applicationId: row.application_id,
      replyIntentId: replyIntent?.replyIntentId ?? null,
      replyIntentStatus: replyIntent?.status ?? null,
      reconcileOnly: replyIntent?.reconcileOnly ?? false,
      intentActive: replyIntent?.active ?? true,
      intentSendBindingUnambiguous: replyIntent?.sendBindingUnambiguous ?? true,
      eventKind: row.event_kind,
      decision: row.decision,
      decisionReason: row.decision_reason,
      decidedAt: row.decided_at,
      attempts: attempts.length,
      lastAttemptAt,
      coolingDown,
      retryAt,
      pendingApproval,
      source: {
        provider: row.provider, accountId: row.account_id, messageId: row.message_id, threadId: row.thread_id,
        receivedAt: row.received_at, fromAddress: row.from_address, fromDomain: row.from_domain,
        replyToAddress: row.reply_to_address ?? row.from_address,
        ...(facts && clarificationReference(facts) ? { conversationReference: clarificationReference(facts) } : {})
      },
      securityRisk: row.security_risk,
      requiresReview: Boolean(row.requires_review),
      facts: facts ? {
        eventKind: facts.eventKind, interview: facts.interview ?? null, requestedAction: facts.requestedAction ?? null,
        replyRequested: facts.replyRequested ?? null, evidence: facts.evidence ?? [],
        conversationReference: clarificationReference(facts)
      } : null
    });
  }
  return outstanding;
}

// ---------------------------------------------------------------------------
// Transmit readiness requires proof of a Gmail send-capable scope for THIS
// account and client, not merely a successful read. Only the reviewed pinned
// `auth inspect-account` capability may read that account's metadata; `auth
// list` enumerates unrelated credentials and must never be a fallback. The
// scoped capability uses a non-migrating local credential read, not a provider
// request or token refresh. This deployment is scoped to the university/default
// credential only. Other accounts remain parked, without opening their tokens.
// ---------------------------------------------------------------------------
const READINESS_ACCOUNT = 'scshafe@umich.edu';
const METADATA_KEYS = new Set(['schemaVersion', 'email', 'client', 'services', 'scopes', 'auth', 'credentialValuesIncluded']);
const SEND_CAPABLE_SCOPES = new Set(['https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.compose',
  'https://mail.google.com/']);
const readinessCache = new Map();
let transmitProbe = function defaultTransmitProbe(account) {
  if (account !== READINESS_ACCOUNT) return { ready: false, detail: 'GOG_READINESS_ACCOUNT_OUT_OF_SCOPE' };
  let executable;
  try { executable = resolvePinnedGog(); }
  catch (error) { return { ready: false, detail: error?.code === 'GOG_KEYCHAIN_ACCESS_PAUSED'
    ? 'GOG_KEYCHAIN_ACCESS_PAUSED' : 'GOG_PINNED_BINARY_UNAVAILABLE' }; }
  let stdout;
  try {
    stdout = execFileSync(executable, ['--account', READINESS_ACCOUNT, '--client=default',
      '--json', '--no-input', '--gmail-no-send', '--enable-commands-exact=auth.inspect-account',
      'auth', 'inspect-account', READINESS_ACCOUNT], {
      encoding: 'utf8', timeout: 8000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'ignore'], shell: false,
      env: { ...sanitizedGogEnvironment(process.env), GOG_GMAIL_NO_SEND: '1' }
    });
  } catch { return { ready: false, detail: 'SCOPED_GOG_AUTH_METADATA_UNAVAILABLE' }; }
  let metadata;
  try {
    if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > 65536) throw new Error();
    metadata = JSON.parse(stdout);
    const textArray = (value) => Array.isArray(value) && value.length <= 256
      && value.every(item => typeof item === 'string' && /^[^\s\u0000-\u001f\u007f]{1,2048}$/u.test(item));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || Object.keys(metadata).length !== METADATA_KEYS.size || Object.keys(metadata).some(key => !METADATA_KEYS.has(key))
        || metadata.schemaVersion !== 'jobtrack-gog-account-metadata.v1'
        || metadata.email !== READINESS_ACCOUNT || metadata.client !== 'default' || metadata.auth !== 'oauth'
        || metadata.credentialValuesIncluded !== false || !textArray(metadata.services) || !textArray(metadata.scopes)) throw new Error();
  } catch { return { ready: false, detail: 'SCOPED_GOG_AUTH_METADATA_INVALID' }; }
  // Preserve the old send / modify / compose / full-mail scope gate, matching
  // complete canonical scope URLs rather than unrelated substring lookalikes.
  return metadata.scopes.some(scope => SEND_CAPABLE_SCOPES.has(scope))
    ? { ready: true, detail: 'reviewed university/default credential carries a Gmail send-capable scope' }
    : { ready: false, detail: 'GOG_SEND_CAPABLE_SCOPE_MISSING' };
};

function transmitReadiness(account) {
  const key = String(account || '').toLowerCase();
  if (!key) return { ready: false, detail: 'no transmitting account' };
  if (readinessCache.has(key)) return readinessCache.get(key);
  let result;
  try {
    result = transmitProbe(key);
  } catch {
    result = { ready: false, detail: 'GOG_READINESS_PROBE_FAILED' };
  }
  readinessCache.set(key, result);
  return result;
}

/** Tests (and hosts without gog) replace the probe; pass null to restore the default. */
function setTransmitReadinessProbe(probe) {
  readinessCache.clear();
  if (probe === null || probe === undefined) {
    transmitProbe = defaultProbeReference;
  } else {
    transmitProbe = probe;
  }
}
const defaultProbeReference = transmitProbe;

/** Record the live correlation of a stored message (the fabric's `email.recorrelate` act). */
function recorrelateFromStore(db, { messageRefId, idempotencyKey }) {
  const message = db.prepare('SELECT * FROM job_email_message_refs WHERE id=?').get(Number(messageRefId));
  if (!message) throw new EmailAgentLaneError('NOT_FOUND', `message ref ${messageRefId} not found`);
  const key = String(idempotencyKey ?? '').trim();
  if (!key) throw new EmailAgentLaneError('INVALID_INPUT', 'an idempotency key is required to re-correlate');
  const live = correlateEmailReadOnly(db, JSON.parse(message.facts_json));
  return recordCorrelation(db, live, key);
}

const AGENT_LANE_ACTIONS = new Set(['inbound-queue', 'mark-handled', 'transition-from-agent', 'resolve-from-agent', 'reply-attempt',
  'reply-intent', 'reply-intents', 'reply-send-start', 'reply-supersede']);

/** Strict flag allowlists, like every other jobtrack verb: an unknown flag is an error, never ignored. */
const AGENT_LANE_FLAGS = Object.freeze({
  'inbound-queue': ['applicationId'],
  'mark-handled': ['messageRefId', 'applicationId', 'decision', 'actor', 'authorship', 'reason', 'idempotencyKey'],
  'transition-from-agent': ['messageRefId', 'actionJson', 'evidence', 'proposalId', 'idempotencyKey'],
  'resolve-from-agent': ['messageRefId', 'applicationId', 'actor', 'reason', 'idempotencyKey'],
  'reply-attempt': ['messageRefId', 'outcome', 'actor', 'reason', 'idempotencyKey'],
  'reply-intent': ['messageRefId', 'applicationId', 'actor', 'authorship', 'reason', 'idempotencyKey'],
  'reply-intents': ['applicationId'],
  'reply-send-start': ['intentId', 'approvalId', 'actor', 'authorship', 'reason', 'idempotencyKey'],
  'reply-supersede': ['intentId', 'supersedingMessageRefId', 'expectedEvidenceDigest', 'reviewedBy', 'authorship', 'reason', 'idempotencyKey']
});

function assertEmailAgentLaneFlags(action, flags) {
  const allowed = AGENT_LANE_FLAGS[action];
  if (!allowed) throw new EmailAgentLaneError('UNKNOWN_ACTION', `unknown email agent-lane action ${action}`);
  for (const key of Object.keys(flags || {})) {
    if (key === 'json') continue;
    if (!allowed.includes(key)) throw new EmailAgentLaneError('INVALID_INPUT', `email ${action} does not accept --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
}

function isEmailAgentLaneAction(action) {
  return AGENT_LANE_ACTIONS.has(action);
}

function parseEvidence(flags) {
  const raw = flags.evidence;
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw;
  return String(raw).split('||').map((item) => item.trim()).filter(Boolean);
}

function runEmailAgentLaneCommand(db, action, flags) {
  if (action === 'reply-intents') return { ok: true, command: 'email reply-intents', intents: listReplyIntents(db, { applicationId: flags.applicationId }) };
  if (action === 'reply-intent') return { ok: true, command: 'email reply-intent', ...recordReplyIntent(db, flags) };
  if (action === 'reply-send-start') return { ok: true, command: 'email reply-send-start', ...recordReplySendStart(db, flags) };
  if (action === 'reply-supersede') return { ok: true, command: 'email reply-supersede', ...recordReplySupersession(db, flags) };
  if (action === 'inbound-queue') {
    const applicationId = flags.applicationId === undefined ? undefined : Number(flags.applicationId);
    return { ok: true, command: 'email inbound-queue', queue: listInboundQueue(db, { applicationId }) };
  }
  if (action === 'mark-handled') {
    return { ok: true, command: 'email mark-handled', ...recordHandlingDecision(db, {
      messageRefId: flags.messageRefId, applicationId: flags.applicationId, decision: flags.decision,
      actor: flags.actor, authorship: flags.authorship ?? 'agent', reason: flags.reason, idempotencyKey: flags.idempotencyKey
    }) };
  }
  if (action === 'resolve-from-agent') {
    return { ok: true, command: 'email resolve-from-agent', ...resolveFromAgent(db, {
      messageRefId: flags.messageRefId, applicationId: flags.applicationId, actor: flags.actor, reason: flags.reason, idempotencyKey: flags.idempotencyKey
    }) };
  }
  if (action === 'reply-attempt') {
    return { ok: true, command: 'email reply-attempt', ...recordReplyAttempt(db, {
      messageRefId: flags.messageRefId, outcome: flags.outcome, actor: flags.actor, reason: flags.reason, idempotencyKey: flags.idempotencyKey
    }) };
  }
  if (action === 'transition-from-agent') {
    let parsedAction;
    try { parsedAction = JSON.parse(String(flags.actionJson ?? '')); } catch { throw new EmailAgentLaneError('INVALID_INPUT', '--action-json must be valid JSON'); }
    return { ok: true, command: 'email transition-from-agent', ...transitionFromAgent(db, {
      messageRefId: flags.messageRefId, action: parsedAction, evidence: parseEvidence(flags), proposalId: flags.proposalId, idempotencyKey: flags.idempotencyKey
    }) };
  }
  throw new EmailAgentLaneError('UNKNOWN_ACTION', `unknown email agent-lane action ${action}`);
}

module.exports = {
  EmailAgentLaneError,
  assertEmailAgentLaneFlags,
  buildTransitionProposal,
  isEmailAgentLaneAction,
  listInboundQueue,
  listOutstandingReplies,
  listStaleUnmatched,
  setTransmitReadinessProbe,
  transmitReadiness,
  recorrelateFromStore,
  migrateEmailAgentLane,
  recordHandlingDecision,
  recordReplyAttempt,
  resolveFromAgent,
  runEmailAgentLaneCommand,
  transitionFromAgent
};
