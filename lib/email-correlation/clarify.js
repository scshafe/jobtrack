'use strict';

const crypto = require('node:crypto');
const {
  NORMALIZATION_VERSION,
  digestCanonicalJson,
  digestUtf8Text,
  projectApprovedContentFromProposal
} = require('../email-outgoing-v2-contracts');
const {
  issueClarificationDraftRequest,
  recordClarificationDraftResult
} = require('../email-outgoing-v2');
const { loadPolicy } = require('./policy');
const { normalizeMentionText } = require('./normalize');
const { TEMPLATE_ID, questionFor } = require('./clarify-template');

const CLARIFICATION_SCHEMA_VERSION = 2026090203;
const CLARIFICATION_MIGRATION_NAME = 'email_clarifications';

class EmailClarificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmailClarificationError';
    this.code = code;
  }
}

function migrateEmailClarifications(db) {
  const migration = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
    .get(CLARIFICATION_SCHEMA_VERSION);
  if (migration && migration.name !== CLARIFICATION_MIGRATION_NAME) {
    throw new EmailClarificationError('MIGRATION_CONFLICT', `Schema version ${CLARIFICATION_SCHEMA_VERSION} is already named ${migration.name}`);
  }
  if (migration) return;
  const nameConflict = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?')
    .get(CLARIFICATION_MIGRATION_NAME);
  if (nameConflict) {
    throw new EmailClarificationError('MIGRATION_CONFLICT', `Migration ${CLARIFICATION_MIGRATION_NAME} is already version ${nameConflict.version}`);
  }
  db.exec(`
    CREATE TABLE email_clarifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clarification_id TEXT NOT NULL UNIQUE,
      message_ref_id INTEGER NOT NULL UNIQUE REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
      correlation_id INTEGER NOT NULL REFERENCES job_email_correlations(id) ON DELETE RESTRICT,
      policy_revision_id INTEGER NOT NULL REFERENCES email_correlation_policy_revisions(id) ON DELETE RESTRICT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      candidate_application_ids_json TEXT NOT NULL CHECK (json_valid(candidate_application_ids_json)),
      candidate_snapshot_json TEXT NOT NULL CHECK (json_valid(candidate_snapshot_json)),
      candidate_snapshot_digest TEXT NOT NULL CHECK (length(candidate_snapshot_digest)=64),
      question_text TEXT NOT NULL,
      question_digest TEXT NOT NULL CHECK (length(question_digest)=64),
      outgoing_proposal_id TEXT NOT NULL UNIQUE REFERENCES job_email_outgoing_proposals_v3(proposal_id) ON DELETE RESTRICT,
      outgoing_approval_id TEXT UNIQUE REFERENCES job_email_approval_receipts_v2(approval_id) ON DELETE RESTRICT,
      outgoing_send_request_id TEXT UNIQUE REFERENCES job_email_send_requests_v2(request_id) ON DELETE RESTRICT,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      sent_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','expired')),
      asked_at TEXT,
      expires_at TEXT NOT NULL,
      answered_at TEXT,
      answered_message_ref_id INTEGER UNIQUE REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
      selected_application_id INTEGER REFERENCES applications(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      CHECK (trim(clarification_id)<>'' AND trim(question_text)<>''),
      CHECK (
        (status='pending' AND answered_at IS NULL AND answered_message_ref_id IS NULL AND selected_application_id IS NULL)
        OR (status='answered' AND answered_at IS NOT NULL AND answered_message_ref_id IS NOT NULL AND selected_application_id IS NOT NULL)
        OR (status='expired' AND answered_at IS NULL AND answered_message_ref_id IS NULL AND selected_application_id IS NULL)
      )
    );
    CREATE INDEX idx_email_clarifications_thread
      ON email_clarifications(provider,account_id,thread_id,status,expires_at);
    CREATE TRIGGER email_clarifications_immutable_snapshot
    BEFORE UPDATE ON email_clarifications
    WHEN NEW.clarification_id IS NOT OLD.clarification_id
      OR NEW.message_ref_id IS NOT OLD.message_ref_id
      OR NEW.correlation_id IS NOT OLD.correlation_id
      OR NEW.policy_revision_id IS NOT OLD.policy_revision_id
      OR NEW.company_id IS NOT OLD.company_id
      OR NEW.candidate_application_ids_json IS NOT OLD.candidate_application_ids_json
      OR NEW.candidate_snapshot_json IS NOT OLD.candidate_snapshot_json
      OR NEW.candidate_snapshot_digest IS NOT OLD.candidate_snapshot_digest
      OR NEW.question_text IS NOT OLD.question_text
      OR NEW.question_digest IS NOT OLD.question_digest
      OR NEW.outgoing_proposal_id IS NOT OLD.outgoing_proposal_id
      OR NEW.provider IS NOT OLD.provider
      OR NEW.account_id IS NOT OLD.account_id
      OR NEW.thread_id IS NOT OLD.thread_id
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT, 'email clarification candidate/question snapshot is immutable'); END;
    CREATE TRIGGER email_clarifications_terminal_state
    BEFORE UPDATE OF status ON email_clarifications
    WHEN NOT (
      NEW.status=OLD.status
      OR (OLD.status='pending' AND NEW.status IN ('answered','expired'))
    )
    BEGIN SELECT RAISE(ABORT, 'email clarification status is terminal'); END;
    CREATE TRIGGER email_clarifications_no_delete
    BEFORE DELETE ON email_clarifications
    BEGIN SELECT RAISE(ABORT, 'email clarifications are append-only'); END;
  `);
  db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)')
    .run(CLARIFICATION_SCHEMA_VERSION, CLARIFICATION_MIGRATION_NAME);
}

/**
 * Open the only clarification this inbound message may ever produce. The
 * candidate/title wording is frozen before the outgoing lane starts. Every
 * retry resumes the same proposal/approval, so failure cannot become a second
 * question or nudge.
 */
function openClarification(db, rawInput, deps = {}) {
  migrateEmailClarifications(db);
  const messageRefId = positiveInteger(rawInput?.messageRefId, 'messageRefId');
  const requestedIds = candidateIds(rawInput?.candidateApplicationIds ?? rawInput?.candidates);
  const message = db.prepare('SELECT * FROM job_email_message_refs WHERE id=?').get(messageRefId);
  if (!message) fail('NOT_FOUND', `message ref ${messageRefId} not found`);
  const correlationRow = db.prepare(`
    SELECT * FROM job_email_correlations WHERE message_ref_id=? ORDER BY id DESC LIMIT 1
  `).get(messageRefId);
  if (!correlationRow) fail('NOT_CORRELATED', `message ${messageRefId} has no recorded correlation`);
  const correlation = parseJson(correlationRow.correlation_json, 'stored correlation');
  if (correlation.schemaVersion !== 'jobtrack-correlation-result.v3'
    || correlation.resolution !== 'ambiguous' || correlation.clarifiable !== true) {
    fail('NOT_CLARIFIABLE', `message ${messageRefId} is not an ambiguous, clarifiable v3 correlation`);
  }
  const offered = activeCandidateIds(db, messageRefId, correlation.candidates);
  if (offered.length < 2 || !sameNumbers(offered, requestedIds)) {
    fail('CANDIDATE_MISMATCH', '--candidates must name every distinct active application in the recorded ambiguous correlation');
  }
  const policy = loadPolicy(db, correlation.policyRevisionId);
  if (!policy.clarify.enabled || requestedIds.length < policy.clarify.minimumCandidates) {
    fail('NOT_CLARIFIABLE', `policy revision ${correlation.policyRevisionId} does not allow this clarification`);
  }

  const snapshot = buildCandidateSnapshot(db, requestedIds);
  if (policy.clarify.sameCompany && new Set(snapshot.candidates.map((candidate) => candidate.companyId)).size !== 1) {
    fail('MULTIPLE_COMPANIES', 'clarification candidates must all belong to one company');
  }
  const candidateSnapshotDigest = digestCanonicalJson(snapshot);
  const existing = db.prepare('SELECT * FROM email_clarifications WHERE message_ref_id=?').get(messageRefId);
  if (existing) {
    if (existing.candidate_snapshot_digest !== candidateSnapshotDigest) {
      fail('ALREADY_CLARIFIED', `message ${messageRefId} already has a clarification with a different immutable candidate snapshot`);
    }
    return continueClarification(db, existing, deps);
  }

  const facts = parseJson(message.facts_json, 'stored facts');
  const applicantName = profileName(db);
  const template = { titles: snapshot.candidates.map((candidate) => candidate.offeredTitle),
    applicantName, reference: clarificationReference(facts) };
  const questionText = questionFor(template.titles, applicantName, template.reference);
  const now = observedNow(deps);
  const expiresAt = new Date(Date.parse(now) + policy.clarify.expiryDays * 86_400_000).toISOString();
  const clarificationId = stableId(`clarification:${message.provider}:${message.account_id}:${message.message_id}`, 'clarification');
  const ids = outgoingIds(clarificationId);
  const deliveryProvider = deliveryProviderFor(message.provider);
  const subjectEvidence = (facts.evidence || []).find((entry) => entry?.field === 'subject' && entry.excerpt)?.excerpt;
  const source = {
    provider: message.provider, accountId: message.account_id, messageId: message.message_id,
    threadId: message.thread_id,
    replyToAddress: String(message.reply_to_address || message.from_address).toLowerCase()
  };
  const preparation = {
    schemaVersion: 'jobtrack-email-clarification-preparation.v1',
    clarificationId, messageRefId, policyRevisionId: correlation.policyRevisionId,
    correlationId: correlationRow.id, factsDigest: message.facts_digest,
    candidateSnapshotDigest, candidates: snapshot.candidates,
    source, delivery: { provider: deliveryProvider, accountId: message.account_id },
    subjectHint: subjectEvidence ? replySubject(subjectEvidence) : null, question: questionText
  };
  const preparationDigest = digestCanonicalJson(preparation);
  if (rawInput.preparationDigest !== undefined && rawInput.preparationDigest !== preparationDigest) {
    fail('PREPARATION_STALE', 'clarification preparation no longer matches the source, policy, candidates or question');
  }
  const headers = sourceHeaders(rawInput);
  if (!headers) return {
    ...preparation, preparationDigest, proposalId: null, status: 'preparing',
    deliveryState: 'awaiting_source_headers', askedAt: null, sentMessageId: null, reused: false
  };
  if (!rawInput.preparationDigest) {
    fail('PREPARATION_REQUIRED', 'resolve actual source headers only after preparing and pinning --preparation-digest');
  }
  const subject = headers.replySubject;

  // The proposal and clarification identity are one transaction. A failed local
  // preparation cannot strand half a generation with different retry timestamps.
  return db.transaction(() => {
  const issued = issueClarificationDraftRequest(db, {
    schemaVersion: 'jobtrack-email-reply-draft-issue.v1',
    requestId: ids.requestId,
    idempotencyKey: ids.issueKey,
    generationId: ids.generationId,
    manifestDigest: digestUtf8Text(TEMPLATE_ID),
    source: { ...source, inReplyTo: headers.inReplyTo, references: headers.references },
    delivery: { provider: deliveryProvider, accountId: message.account_id },
    toneDecisionId: ids.toneId,
    toneDecisionDigest: digestUtf8Text('clarification:concise-professional'),
    voiceRevisionId: ids.voiceId,
    voiceRevisionDigest: digestUtf8Text(`applicant:${applicantName}`),
    expiresAt
  }, template);
  const proposal = {
    schemaVersion: 'email-reply-draft-proposal.v3',
    normalizationVersion: NORMALIZATION_VERSION,
    proposalId: ids.proposalId,
    generationId: issued.request.generationId,
    manifestDigest: issued.request.manifestDigest,
    factsDigest: issued.request.factsDigest,
    source: issued.request.source,
    recipient: issued.request.source.replyToAddress,
    subject,
    body: questionText,
    bodyDigest: digestUtf8Text(questionText),
    purpose: 'information_response',
    authorship: 'template',
    templateId: TEMPLATE_ID,
    expiresAt,
    sensitiveDataScan: 'passed',
    toneDecisionId: issued.request.toneDecisionId,
    toneDecisionDigest: issued.request.toneDecisionDigest,
    voiceRevisionId: issued.request.voiceRevisionId,
    voiceRevisionDigest: issued.request.voiceRevisionDigest,
    sourceStateSha256: issued.request.sourceStateSha256,
    delivery: issued.request.delivery,
    registerAdaptationOnly: true,
    distinctivePhraseReuse: false,
    requiresReview: true,
    autoSendEligible: false
  };
  const approvedContent = projectApprovedContentFromProposal(proposal, {
    contentId: ids.contentId,
    createdAt: now
  });
  recordClarificationDraftResult(db, {
    schemaVersion: 'jobtrack-email-reply-draft-result.v1',
    resultId: ids.resultId,
    requestId: issued.request.requestId,
    requestDigest: issued.requestDigest,
    proposal,
    approvedContent,
    usage: { runner: 'clarification_template_in_process', toolCalls: 0, toolsUsed: [], sideEffects: [] },
    completedAt: now,
    idempotencyKey: ids.recordKey
  });

  db.prepare(`
    INSERT INTO email_clarifications(
      clarification_id,message_ref_id,correlation_id,policy_revision_id,company_id,
      candidate_application_ids_json,candidate_snapshot_json,candidate_snapshot_digest,
      question_text,question_digest,outgoing_proposal_id,provider,account_id,thread_id,
      status,expires_at,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    clarificationId, messageRefId, correlationRow.id, correlation.policyRevisionId,
    snapshot.candidates[0].companyId, JSON.stringify(requestedIds), JSON.stringify(snapshot),
    candidateSnapshotDigest, questionText, digestUtf8Text(questionText), proposal.proposalId,
    message.provider, message.account_id, message.thread_id, 'pending', expiresAt, now
  );
  return continueClarification(
    db,
    db.prepare('SELECT * FROM email_clarifications WHERE clarification_id=?').get(clarificationId),
    deps
  );
  }).immediate();
}

function continueClarification(db, row, deps) {
  if (row.status !== 'pending') return clarificationProjection(row, true);
  // Observe the ordinary external lane's durable authority only. This function
  // must never create native evidence, approve, transmit, or infer a send time.
  const sent = db.prepare(`
    SELECT request.request_id,request.approval_id,receipt.receipt_json
    FROM job_email_send_requests_v2 request
    JOIN job_email_approval_receipts_v2 approval ON approval.approval_id=request.approval_id
    JOIN job_email_send_receipt_correlations_v2 receipt ON receipt.send_request_id=request.request_id
    WHERE approval.proposal_id=? AND receipt.outcome='sent' AND receipt.classification='applied'
    ORDER BY receipt.observed_at,receipt.receipt_id LIMIT 1
  `).get(row.outgoing_proposal_id);
  if (sent) {
    const receipt = parseJson(sent.receipt_json, 'stored send receipt');
    const askedAt = validDate(receipt.observedAt);
    if (!askedAt || !receipt.providerMessageId) fail('STORE_CORRUPT', 'sent clarification receipt lacks provider identity/time');
    const expiryDays = loadPolicy(db, row.policy_revision_id).clarify.expiryDays;
    const expiresAt = new Date(Date.parse(askedAt) + expiryDays * 86_400_000).toISOString();
    db.prepare(`
      UPDATE email_clarifications
      SET outgoing_approval_id=COALESCE(outgoing_approval_id,?),
          outgoing_send_request_id=COALESCE(outgoing_send_request_id,?),
          sent_message_id=COALESCE(sent_message_id,?), asked_at=COALESCE(asked_at,?),
          expires_at=CASE WHEN asked_at IS NULL THEN ? ELSE expires_at END
      WHERE id=?
    `).run(sent.approval_id, sent.request_id, receipt.providerMessageId, askedAt, expiresAt, row.id);
    row = db.prepare('SELECT * FROM email_clarifications WHERE id=?').get(row.id);
  }
  const nowMs = Date.parse(observedNow(deps));
  if (nowMs >= Date.parse(row.expires_at)) {
    expireClarifications(db, { now: new Date(nowMs) });
    return clarificationProjection(db.prepare('SELECT * FROM email_clarifications WHERE id=?').get(row.id), true);
  }
  if (sent) return { ...clarificationProjection(row, true), deliveryState: 'sent' };
  const approval = db.prepare('SELECT approval_id FROM job_email_approval_receipts_v2 WHERE proposal_id=?')
    .get(row.outgoing_proposal_id);
  const nativeDraft = db.prepare('SELECT 1 FROM job_email_draft_receipts_v1 WHERE proposal_id=?')
    .get(row.outgoing_proposal_id);
  return { ...clarificationProjection(row, true), approvalId: approval?.approval_id || null,
    deliveryState: !nativeDraft ? 'awaiting_native_draft' : !approval ? 'awaiting_review' : 'awaiting_send' };
}

/** Match one grounded extracted role mention to exactly one offered snapshot. */
function matchClarificationReply(signals, clarifications) {
  for (const clarification of clarifications || []) {
    const snapshot = typeof clarification.candidateSnapshot === 'object'
      ? clarification.candidateSnapshot
      : parseJson(clarification.candidate_snapshot_json, 'candidate snapshot');
    const matched = new Map();
    for (const mention of signals.roleMentions.filter((candidate) => candidate.groundedBodyExcerpts.length > 0)) {
      for (const candidate of snapshot.candidates) {
        if (candidate.recognizedTitles.some((title) => title.normalized === mention.normalized)) {
          matched.set(candidate.applicationId, { candidate, mention });
        }
      }
    }
    if (matched.size === 1) {
      const [applicationId, evidence] = [...matched.entries()][0];
      return {
        clarificationId: clarification.clarificationId || clarification.clarification_id,
        applicationId,
        companyId: evidence.candidate.companyId,
        title: evidence.mention.value,
        excerpt: evidence.mention.groundedBodyExcerpts[0].excerpt,
        mention: evidence.mention
      };
    }
  }
  return null;
}

function confirmClarificationReply(db, {
  facts, clarificationId, identityCompanyIds, companyId, applicationId, messageRefId
}) {
  if (!tableExists(db, 'email_clarifications')) {
    fail('CLARIFICATION_CONFIRMATION_FAILED', 'an exact clarification reply has no clarification ledger');
  }
  const normalizedClarificationId = String(clarificationId || '').trim();
  if (!normalizedClarificationId) {
    fail('CLARIFICATION_CONFIRMATION_FAILED', 'an exact clarification reply must identify one clarification');
  }
  const row = pendingForMessage(db, facts)
    .find((candidate) => candidate.clarification_id === normalizedClarificationId
      && Number(candidate.company_id) === Number(companyId)
      && Number(candidate.answer_message_ref_id) === Number(messageRefId)
      && parseJson(candidate.candidate_application_ids_json, 'candidate ids').includes(Number(applicationId)));
  if (!row) {
    fail('CLARIFICATION_CONFIRMATION_FAILED', `clarification ${normalizedClarificationId} is not the exact pending clarification matched by this message`);
  }
  if (row.match_scope === 'reference'
    && (!Array.isArray(identityCompanyIds) || identityCompanyIds.length !== 1
      || Number(identityCompanyIds[0]) !== Number(row.company_id))) {
    fail('CLARIFICATION_CONFIRMATION_FAILED', `clarification ${normalizedClarificationId} is not bound to one matching sender company`);
  }
  const answerAt = latestDate(
    validDate(facts?.source?.receivedAt),
    validDate(row.answer_observed_at),
    validDate(row.asked_at)
  ) || new Date().toISOString();
  const changed = db.prepare(`
    UPDATE email_clarifications SET status='answered',answered_at=?,answered_message_ref_id=?,selected_application_id=?
    WHERE id=? AND status='pending'
  `).run(answerAt, Number(messageRefId), Number(applicationId), row.id);
  if (changed.changes !== 1) {
    fail('CLARIFICATION_CONFIRMATION_FAILED', `clarification ${normalizedClarificationId} could not transition from pending to answered`);
  }
  return clarificationProjection(db.prepare('SELECT * FROM email_clarifications WHERE id=?').get(row.id), false);
}

function expireClarifications(db, { now = new Date() } = {}) {
  if (!tableExists(db, 'email_clarifications')) return { expired: 0, clarificationIds: [] };
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const ids = db.prepare("SELECT clarification_id FROM email_clarifications WHERE status='pending' AND datetime(expires_at)<=datetime(?) ORDER BY id")
    .all(at).map((row) => row.clarification_id);
  if (ids.length) db.prepare("UPDATE email_clarifications SET status='expired' WHERE status='pending' AND datetime(expires_at)<=datetime(?)").run(at);
  return { expired: ids.length, clarificationIds: ids };
}

/**
 * Pending, sent, unexpired clarifications in this provider thread that the
 * message can answer. Providers time their messages differently: Gmail's
 * source timestamp is minute-granular, so a reply sent seconds after the
 * question can carry a receivedAt that precedes asked_at. The window therefore
 * compares at the provider's precision and, in every case, requires the answer
 * to have been durably imported at or after the question was asked — the same
 * window the conversation-reference arm applies (answerWindowAllows). A message
 * observed before the question cannot be its answer.
 */
function pendingForThread(db, source, receivedAt, observedAt) {
  if (!tableExists(db, 'email_clarifications')) return [];
  const at = validDate(receivedAt);
  const observed = validDate(observedAt);
  if (!at || !observed) return [];
  return db.prepare(`
    SELECT * FROM email_clarifications
    WHERE provider=? AND account_id=? AND thread_id=? AND status='pending'
      AND asked_at IS NOT NULL AND sent_message_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM job_email_send_requests_v2 request
        JOIN job_email_send_receipt_correlations_v2 receipt
          ON receipt.send_request_id=request.request_id
        WHERE request.request_id=email_clarifications.outgoing_send_request_id
          AND receipt.outcome='sent' AND receipt.classification='applied'
      )
    ORDER BY id DESC
  `).all(source.provider, source.accountId, source.threadId)
    .filter((row) => answerWindowAllows(source.provider, at, observed, row));
}

/**
 * Find pending clarifications that this imported message can answer. Provider
 * threads remain the primary linkage. Some providers rewrite a reply into a
 * new thread, so a second, narrower arm admits one immutable question whose
 * generated conversation reference is repeated in the body. That arm also
 * requires the original immutable facts to contain that same grounded token.
 * Both arms share one answer window (answerWindowAllows): the source time is
 * compared at the provider's precision — Gmail's is minute-granular, precise
 * providers keep strict time — and the answer must be durably imported at or
 * after the question was asked. A message that is not yet imported cannot
 * answer anything, which is why the relay imports before it correlates.
 */
function pendingForMessage(db, facts) {
  if (!tableExists(db, 'email_clarifications')) return [];
  const source = facts?.source || {};
  const observed = messageObservation(db, source);
  if (!observed?.observed_at) return [];
  const suppliedReferences = (facts?.applicationRefs || [])
    .filter((candidate) => candidate?.namespace === 'bracket_code');
  if (suppliedReferences.length === 0) {
    return pendingForThread(db, source, source.receivedAt, observed.observed_at).map((row) => ({
      ...row,
      match_scope: 'thread',
      answer_message_ref_id: observed.message_ref_id,
      answer_observed_at: observed.observed_at
    }));
  }

  const reference = clarificationReference(facts);
  const at = validDate(source.receivedAt);
  if (!reference || !at) return [];
  const possible = db.prepare(`
    SELECT clarification.*,origin.facts_json AS origin_facts_json
    FROM email_clarifications clarification
    JOIN job_email_message_refs origin ON origin.id=clarification.message_ref_id
    WHERE clarification.provider=? AND clarification.account_id=?
      AND clarification.status='pending'
      AND clarification.asked_at IS NOT NULL
      AND clarification.sent_message_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM job_email_send_requests_v2 request
        JOIN job_email_send_receipt_correlations_v2 receipt
          ON receipt.send_request_id=request.request_id
        WHERE request.request_id=clarification.outgoing_send_request_id
          AND receipt.outcome='sent' AND receipt.classification='applied'
      )
    ORDER BY clarification.id DESC
  `).all(
    source.provider,
    source.accountId
  ).filter((row) => answerWindowAllows(source.provider, at, observed.observed_at, row)
    && clarificationReference(parseJson(row.origin_facts_json, 'clarification origin facts')) === reference
    && clarificationReferenceFromQuestion(row.question_text) === reference);
  if (possible.length !== 1) return [];
  return [{
    ...possible[0],
    match_scope: 'reference',
    answer_message_ref_id: observed.message_ref_id,
    answer_observed_at: observed.observed_at
  }];
}

function messageObservation(db, source) {
  if (!tableExists(db, 'job_email_message_refs')) return null;
  return db.prepare(`
    SELECT id AS message_ref_id,
      strftime('%Y-%m-%dT%H:%M:%fZ',created_at) AS observed_at
    FROM job_email_message_refs
    WHERE provider=? AND account_id=? AND message_id=?
    ORDER BY id DESC LIMIT 1
  `).get(source.provider, source.accountId, source.messageId);
}

/**
 * The one answer window for both matching arms: the answer's source time is at
 * or after the question at the provider's precision, before the question's
 * expiry, and its durable import happened at or after the question was asked.
 */
function answerWindowAllows(provider, receivedAt, observedAt, row) {
  const receivedMs = Date.parse(receivedAt);
  const observedMs = Date.parse(observedAt);
  const askedMs = Date.parse(row.asked_at);
  const expiresMs = Date.parse(row.expires_at);
  if (![receivedMs, observedMs, askedMs, expiresMs].every(Number.isFinite)) return false;
  const sourceAfterQuestion = provider === 'gmail_gog'
    ? Math.floor(receivedMs / 60_000) >= Math.floor(askedMs / 60_000)
    : receivedMs >= askedMs;
  // job_email_message_refs.created_at is stored at whole-second precision.
  // Treat observations in the same stored second as contemporaneous, while
  // still rejecting every durably earlier second.
  const durablyObservedAfterQuestion = Math.floor(observedMs / 1_000) >= Math.floor(askedMs / 1_000);
  return sourceAfterQuestion && receivedMs < expiresMs && durablyObservedAfterQuestion;
}

function clarificationReferenceFromQuestion(question) {
  const values = new Set([...String(question || '').toUpperCase()
    .matchAll(/(?:^|\n)CONVERSATION REFERENCE: \[([A-Z]{2,6}-[0-9A-Z]{3,12})\](?=\n|$)/g)]
    .map((match) => match[1]));
  return values.size === 1 ? [...values][0] : null;
}

function buildCandidateSnapshot(db, applicationIds) {
  const candidates = applicationIds.map((applicationId) => {
    const row = db.prepare(`
      SELECT a.id,o.company_id,o.canonical_title,o.normalized_title,c.canonical_name
      FROM applications a JOIN job_openings o ON o.id=a.job_opening_id
      JOIN companies c ON c.id=o.company_id WHERE a.id=?
    `).get(applicationId);
    if (!row) fail('APPLICATION_NOT_FOUND', `application ${applicationId} not found`);
    const aliases = tableExists(db, 'application_title_aliases')
      ? db.prepare('SELECT alias,normalized_alias FROM application_title_aliases WHERE application_id=? ORDER BY id DESC').all(applicationId)
      : [];
    const recognized = [];
    const add = (title, normalized = normalizeMentionText(title)) => {
      const value = String(title || '').trim();
      if (value && normalized && !recognized.some((entry) => entry.normalized === normalized)) {
        recognized.push({ title: value, normalized });
      }
    };
    for (const alias of aliases) add(alias.alias, alias.normalized_alias);
    add(row.canonical_title, row.normalized_title);
    return {
      applicationId: row.id,
      companyId: row.company_id,
      companyName: row.canonical_name,
      offeredTitle: recognized[0].title,
      recognizedTitles: recognized
    };
  });
  return { schemaVersion: 'jobtrack-email-clarification-candidate-snapshot.v1', candidates };
}

function clarificationReference(facts) {
  const values = new Set((facts.applicationRefs || [])
    .filter((reference) => reference?.namespace === 'bracket_code')
    .map((reference) => String(reference?.value || '').trim().toUpperCase())
    .filter((value) => /^[A-Z]{2,6}-[0-9A-Z]{3,12}$/.test(value)));
  if (values.size !== 1) return null;
  const [value] = values;
  const grounded = (facts.evidence || []).some((entry) => entry?.field === 'body'
    && [...String(entry.excerpt || '').toUpperCase().matchAll(/\[([A-Z]{2,6}-[0-9A-Z]{3,12})\]/g)]
      .some((match) => match[1] === value));
  return grounded ? value : null;
}

function clarificationProjection(row, reused) {
  return {
    clarificationId: row.clarification_id,
    messageRefId: row.message_ref_id,
    policyRevisionId: row.policy_revision_id,
    companyId: row.company_id,
    candidates: parseJson(row.candidate_snapshot_json, 'candidate snapshot').candidates,
    question: row.question_text,
    proposalId: row.outgoing_proposal_id,
    approvalId: row.outgoing_approval_id || null,
    sendRequestId: row.outgoing_send_request_id || null,
    sentMessageId: row.sent_message_id || null,
    threadId: row.thread_id,
    status: row.status,
    askedAt: row.asked_at || null,
    expiresAt: row.expires_at,
    answeredAt: row.answered_at || null,
    answeredMessageRefId: row.answered_message_ref_id || null,
    selectedApplicationId: row.selected_application_id || null,
    reused
  };
}

function deliveryProviderFor(sourceProvider) {
  if (sourceProvider === 'gmail_gog') return 'gog_gmail';
  if (sourceProvider === 'apple_mail_emlx') return 'apple_mail_automation';
  fail('UNSUPPORTED_DELIVERY', `no outgoing delivery adapter maps inbound provider ${sourceProvider}`);
}

function outgoingIds(clarificationId) {
  return {
    generationId: `${clarificationId}-generation`, requestId: `${clarificationId}-request`,
    issueKey: `${clarificationId}-issue`, proposalId: `${clarificationId}-proposal`,
    contentId: `${clarificationId}-content`, resultId: `${clarificationId}-result`,
    recordKey: `${clarificationId}-record`,
    toneId: `${clarificationId}-tone`, voiceId: `${clarificationId}-voice`
  };
}

function stableId(seed, prefix) {
  return `${prefix}-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}
function replySubject(value) { return /^re:/iu.test(String(value).trim()) ? String(value).trim() : `Re: ${String(value).trim()}`; }
function sourceHeaders(input) {
  if (input.inReplyTo === undefined && input.references === undefined && input.replySubject === undefined) return null;
  // RFC Message-ID evidence is supplied by the external source-header reader.
  // Never turn a provider's opaque message ID into a fabricated header.
  const valid = (value) => typeof value === 'string' && value.length <= 998
    && /^<[^<>\s@]+@[^<>\s@]+>$/.test(value);
  let references = input.references;
  if (typeof references === 'string') {
    try { references = JSON.parse(references); } catch { fail('INVALID_INPUT', '--references must be a JSON array of RFC Message-IDs'); }
  }
  if (!valid(input.inReplyTo) || !Array.isArray(references) || !references.length || references.length > 50
    || references.some((value) => !valid(value)) || new Set(references).size !== references.length
    || !references.includes(input.inReplyTo)) {
    fail('INVALID_INPUT', '--in-reply-to and --references must contain actual RFC Message-IDs including the parent');
  }
  if (typeof input.replySubject !== 'string' || !input.replySubject.trim() || input.replySubject.length > 998
    || /[\u0000-\u001f\u007f]/.test(input.replySubject)) {
    fail('INVALID_INPUT', '--reply-subject must contain the actual native reply subject, not a facts excerpt');
  }
  return { inReplyTo: input.inReplyTo, references, replySubject: input.replySubject };
}
function profileName(db) {
  const row = tableExists(db, 'profile_contact') ? db.prepare('SELECT name FROM profile_contact WHERE id=1').get() : null;
  const name = String(row?.name || '').trim();
  if (!name || /[\u0000-\u001f\u007f]/.test(name)) fail('PROFILE_NAME_REQUIRED', 'the applicant profile needs a name before a clarification can be signed');
  return name;
}
function candidateIds(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const ids = [...new Set(raw.map((entry) => Number(String(entry).trim())))].sort(numeric);
  if (ids.length < 2 || ids.some((id) => !Number.isInteger(id) || id < 1)) fail('INVALID_INPUT', '--candidates must contain at least two unique positive application IDs');
  return ids;
}
function activeCandidateIds(db, messageRefId, candidates) {
  const offered = [...new Set(candidates.map((candidate) => Number(candidate.applicationId)))].sort(numeric);
  if (!tableExists(db, 'email_link_retractions')) return offered;
  const retractions = db.prepare(`
    SELECT application_id FROM email_link_retractions WHERE message_ref_id=?
  `).all(messageRefId);
  if (retractions.some((retraction) => retraction.application_id === null)) return [];
  const retracted = new Set(retractions.map((retraction) => Number(retraction.application_id)));
  return offered.filter((applicationId) => !retracted.has(applicationId));
}
function observedNow(deps) {
  const value = deps.now ? deps.now() : new Date().toISOString();
  const parsed = validDate(value);
  if (!parsed) fail('CLOCK_UNAVAILABLE', 'clarification clock must return an RFC 3339 date-time');
  return parsed;
}
function validDate(value) { const ms = Date.parse(value); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; }
function latestDate(...values) {
  const dates = values.filter(Boolean);
  if (!dates.length) return null;
  return dates.sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}
function positiveInteger(value, label) { const number = Number(value); if (!Number.isInteger(number) || number < 1) fail('INVALID_INPUT', `${label} must be a positive integer`); return number; }
function sameNumbers(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function numeric(left, right) { return left - right; }
function parseJson(value, label) { try { return JSON.parse(value); } catch { fail('STORE_CORRUPT', `${label} is not valid JSON`); } }
function tableExists(db, name) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
function fail(code, message) { throw new EmailClarificationError(code, message); }

module.exports = {
  CLARIFICATION_MIGRATION_NAME,
  CLARIFICATION_SCHEMA_VERSION,
  EmailClarificationError,
  clarificationReference,
  clarificationReferenceFromQuestion,
  confirmClarificationReply,
  expireClarifications,
  matchClarificationReply,
  migrateEmailClarifications,
  openClarification,
  pendingForMessage,
  pendingForThread,
  questionFor
};
