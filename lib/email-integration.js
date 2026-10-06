'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { requestWakeQuietly } = require('./fabric-wake');
const { createScheduledInterview, updateScheduledInterview } = require('./interview-prep');
const {
  validateJobApplicationEmailFacts,
  validateCorrelationResult,
  validateTransitionProposal,
  validateReplyDraftProposal,
  digest,
  stableJson
} = require('./email-contracts');
const {
  migrateEmailCommunication,
  projectMessageThread,
  persistReplyStyleBinding
} = require('./email-communication');
const {
  isEmailCommunicationAction,
  assertEmailCommunicationCommandFlags,
  runEmailCommunicationCommand
} = require('./email-communication-command');
const {
  migrateEmailDraftReply,
  migrateEmailSendReceiptCorrelation,
  buildDraftReplyContext,
  issueDraftReplyRequest,
  recordDraftReplyResult,
  approveDraftReplySend,
  correlateSendReceipt,
  readReplyLifecycleSummary
} = require('./email-draft-reply');
const {
  migrateEmailOutgoingV2,
  migrateEmailOutgoingV2AuthorityGuards,
  issueDraftRequest: issueOutgoingDraftRequest,
  recordDraftResult: recordOutgoingDraftResult,
  captureDraftReceipt: captureOutgoingDraftReceipt,
  readReviewProjection: readOutgoingReviewProjection,
  recordReviewDecision: recordOutgoingReviewDecision,
  createSendRequest: createOutgoingSendRequest,
  invalidateApproval: invalidateOutgoingApproval,
  correlateSendReceipt: correlateOutgoingSendReceipt
} = require('./email-outgoing-v2');
const { digestCanonicalJson } = require('./email-outgoing-v2-contracts');
const {
  migrateApprovalPolicy,
  approvalPolicyFor,
  setApprovalPolicy,
  autoApproveProposal
} = require('./email-auto-approval');
const { sendApproved } = require('./email-send-live');

const EMAIL_SCHEMA_VERSION = 2026071711;
const correlationRegistry = require('./email-correlation/registry');
const { correlate } = require('./email-correlation');
const { createCorrelationStore } = require('./email-correlation/candidates');
const {
  REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_MIGRATION_NAME,
  REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_SCHEMA_VERSION,
  backfillLearnings: backfillCorrelationLearnings,
  editIdentityRegistry,
  migrateReversibleApplicationExternalIdentifiers,
  retractLink: retractCorrelationLink,
  safeLearn: safeCorrelationLearn
} = require('./email-correlation/learn');
const { readCorrelationMetrics } = require('./email-correlation/metrics');
const { classifySenderDomainWithProvenance } = require('./email-correlation/domain-classes');
const { prioritizeRoleTitleMatchEvidence } = require('./email-correlation/signals');
const { loadPolicy, migrateCorrelationPolicy } = require('./email-correlation/policy');
const {
  confirmClarificationReply,
  migrateEmailClarifications,
  openClarification
} = require('./email-correlation/clarify');

const APPLICATION_EXTERNAL_IDENTIFIER_SCHEMA_VERSION = 2026071713;
const APPLICATION_EXTERNAL_IDENTIFIER_MIGRATION_NAME = 'reviewed_application_external_identifiers';
const MAX_INPUT_BYTES = 1024 * 1024;
const STATUS_TRANSITIONS = new Map([
  ['applied', new Set(['interviewing', 'offer', 'rejected', 'withdrawn'])],
  ['interviewing', new Set(['offer', 'rejected', 'withdrawn'])],
  ['offer', new Set(['rejected', 'withdrawn'])],
  ['rejected', new Set()],
  ['withdrawn', new Set()]
]);
const EMAIL_COMMAND_FLAGS = Object.freeze({
  correlate: ['input'],
  'import-facts': ['input', 'idempotencyKey'],
  'record-correlation': ['input', 'idempotencyKey'],
  'retract-learning': ['messageRefId', 'actor', 'reason'],
  'backfill-learnings': ['actor'],
  'learnings': ['messageRefId', 'companyId', 'applicationId'],
  'identity': ['address', 'domain', 'name', 'companyId', 'kind', 'class', 'actor', 'reason'],
  metrics: ['applicationId'],
  clarify: ['messageRefId', 'candidates', 'inReplyTo', 'references', 'replySubject', 'preparationDigest'],
  'resolve-correlation': ['input', 'idempotencyKey'],
  'propose-transition': ['input', 'idempotencyKey'],
  'propose-reply': ['input', 'idempotencyKey'],
  'review-transition': ['proposalId', 'decision', 'decidedBy', 'notes', 'idempotencyKey'],
  'review-reply': ['proposalId', 'decision', 'decidedBy', 'notes', 'idempotencyKey'],
  'apply-transition': ['proposalId', 'expectedApplicationVersion', 'appliedBy', 'idempotencyKey'],
  // draft-reply work kind (v0.6). data-only: JobTrack describes the draft work
  // and checks the result; the model runs externally, and the approved
  // send-request is emitted to a DRY-RUN sink, never delivered.
  // --research is an OPTIONAL declarative company-research capability descriptor
  // (P3). Fail-closed: absent it, the projection carries no research capability.
  // JobTrack makes no network call; the descriptor only DECLARES the exact
  // broker allowlist a runner may use. It is pinned into sourceStateSha256.
  'draft-reply-context': ['provider', 'accountId', 'messageId', 'threadId', 'research'],
  'draft-reply-issue': ['input', 'idempotencyKey'],
  'draft-reply-record': ['input', 'idempotencyKey'],
  'draft-reply-approve-send': [
    'proposalId', 'expectedProposalDigest', 'approvedBy', 'approvedAt', 'idempotencyKey'
  ],
  'draft-reply-correlate-receipt': ['input'],
  // Additive G03 provider-neutral data lane. Positive approval, request
  // claiming, and native receipt correlation require host-injected keys; the
  // stock CLI intentionally supplies no signing or provider capability.
  'outgoing-draft-issue': ['input'],
  'outgoing-draft-record': ['input'],
  'outgoing-draft-receipt': ['input'],
  'outgoing-review': ['proposalId'],
  'outgoing-review-record': ['input'],
  'outgoing-send-request': ['input'],
  'outgoing-receipt': ['input'],
  'outgoing-invalidate': ['input'],
  'approval-policy': ['applicationId', 'mode'],
  'auto-approve': ['proposalId', 'applicationId'],
  'send-approved': ['approvalId', 'provider', 'transmitAccount', 'gmailThreadId', 'replyToMessageId']
});

class EmailIntegrationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'EmailIntegrationError';
    this.code = code;
    this.details = details;
  }
}

function migrateEmailIntegration(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobtrack_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const foundation = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?').get(EMAIL_SCHEMA_VERSION);
  if (foundation && foundation.name !== 'job_email_integration_foundation') {
    throw new EmailIntegrationError('MIGRATION_CONFLICT', `Schema version ${EMAIL_SCHEMA_VERSION} is already named ${foundation.name}`);
  }
  if (!foundation) {
    ensureColumn(db, 'applications', 'lock_version', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'interviews', 'timezone', 'TEXT');
    ensureColumn(db, 'interviews', 'scheduling_status', "TEXT NOT NULL DEFAULT 'scheduled' CHECK (scheduling_status IN ('proposed','scheduled','rescheduled','cancelled','completed'))");
    ensureColumn(db, 'interviews', 'cancelled_at', 'TEXT');
    ensureColumn(db, 'interviews', 'cancellation_reason', 'TEXT');
    ensureColumn(db, 'interviews', 'lock_version', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`
    CREATE TABLE job_email_message_refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      from_address TEXT NOT NULL,
      from_domain TEXT NOT NULL,
      reply_to_address TEXT,
      content_digest TEXT NOT NULL CHECK (length(content_digest)=64),
      content_completeness TEXT NOT NULL CHECK (content_completeness IN ('metadata_only','sanitized_plain_text')),
      event_kind TEXT NOT NULL,
      security_risk TEXT NOT NULL CHECK (security_risk IN ('low','medium','high')),
      requires_review INTEGER NOT NULL CHECK (requires_review IN (0,1)),
      facts_json TEXT NOT NULL CHECK (json_valid(facts_json)),
      facts_digest TEXT NOT NULL CHECK (length(facts_digest)=64),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, account_id, message_id)
    );

    CREATE TABLE job_email_correlations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
      facts_digest TEXT NOT NULL CHECK (length(facts_digest)=64),
      resolution TEXT NOT NULL CHECK (resolution IN ('linked','ambiguous','unmatched')),
      resolved_application_id INTEGER REFERENCES applications(id) ON DELETE RESTRICT,
      correlation_json TEXT NOT NULL CHECK (json_valid(correlation_json)),
      correlation_digest TEXT NOT NULL CHECK (length(correlation_digest)=64),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(message_ref_id, correlation_digest)
    );

    CREATE TABLE job_email_correlation_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correlation_id INTEGER NOT NULL REFERENCES job_email_correlations(id) ON DELETE RESTRICT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      company_id INTEGER,
      opening_id INTEGER,
      posting_id INTEGER,
      posting_occurrence_id INTEGER,
      interview_id INTEGER REFERENCES interviews(id) ON DELETE RESTRICT,
      match_basis TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(correlation_id, application_id, match_basis, posting_id, interview_id)
    );

    CREATE TABLE job_email_application_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      relation TEXT NOT NULL,
      proposal_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(message_ref_id, application_id, relation)
    );

    CREATE TABLE job_email_interview_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
      interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE RESTRICT,
      relation TEXT NOT NULL,
      proposal_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(message_ref_id, interview_id, relation)
    );

    CREATE TABLE job_email_transition_proposals (
      proposal_id TEXT PRIMARY KEY,
      message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
      correlation_id INTEGER NOT NULL REFERENCES job_email_correlations(id) ON DELETE RESTRICT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      interview_id INTEGER REFERENCES interviews(id) ON DELETE RESTRICT,
      action_kind TEXT NOT NULL,
      expected_application_version INTEGER NOT NULL CHECK (expected_application_version >= 0),
      automation_eligible INTEGER NOT NULL CHECK (automation_eligible IN (0,1)),
      requires_review INTEGER NOT NULL CHECK (requires_review IN (0,1)),
      proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
      proposal_digest TEXT NOT NULL CHECK (length(proposal_digest)=64),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE job_email_reply_draft_proposals (
      proposal_id TEXT PRIMARY KEY,
      message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
      recipient TEXT NOT NULL,
      authorship TEXT NOT NULL CHECK (authorship IN ('template','model','human')),
      requires_review INTEGER NOT NULL CHECK (requires_review IN (0,1)),
      auto_send_eligible INTEGER NOT NULL DEFAULT 0 CHECK (auto_send_eligible = 0),
      proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
      proposal_digest TEXT NOT NULL CHECK (length(proposal_digest)=64),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE job_email_transition_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL REFERENCES job_email_transition_proposals(proposal_id) ON DELETE RESTRICT,
      event_kind TEXT NOT NULL CHECK (event_kind IN ('proposed','approved','rejected','applied')),
      actor TEXT NOT NULL,
      notes TEXT,
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE job_email_reply_draft_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL REFERENCES job_email_reply_draft_proposals(proposal_id) ON DELETE RESTRICT,
      event_kind TEXT NOT NULL CHECK (event_kind IN ('proposed','approved','rejected')),
      actor TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE job_email_application_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL REFERENCES job_email_transition_proposals(proposal_id) ON DELETE RESTRICT,
      message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      action_kind TEXT NOT NULL,
      before_status TEXT NOT NULL,
      after_status TEXT NOT NULL,
      before_version INTEGER NOT NULL,
      after_version INTEGER NOT NULL,
      details_json TEXT NOT NULL CHECK (json_valid(details_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(proposal_id)
    );

    CREATE TABLE job_email_interview_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL REFERENCES job_email_transition_proposals(proposal_id) ON DELETE RESTRICT,
      message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE RESTRICT,
      event_kind TEXT NOT NULL CHECK (event_kind IN ('scheduled','rescheduled','cancelled')),
      before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
      after_json TEXT NOT NULL CHECK (json_valid(after_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(proposal_id, event_kind)
    );

    CREATE TABLE job_email_operations (
      idempotency_key TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64),
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_job_email_message_thread ON job_email_message_refs(provider, account_id, thread_id);
    CREATE INDEX idx_job_email_correlation_message ON job_email_correlations(message_ref_id, created_at DESC);
    CREATE INDEX idx_job_email_candidate_application ON job_email_correlation_candidates(application_id, created_at DESC);
    CREATE INDEX idx_job_email_application_link ON job_email_application_links(application_id, created_at DESC);
    CREATE INDEX idx_job_email_interview_link ON job_email_interview_links(interview_id, created_at DESC);
    CREATE INDEX idx_job_email_transition_application ON job_email_transition_proposals(application_id, created_at DESC);
    CREATE INDEX idx_job_email_transition_event ON job_email_transition_events(proposal_id, id DESC);
    CREATE INDEX idx_job_email_reply_event ON job_email_reply_draft_events(proposal_id, id DESC);
  `);
    for (const table of [
      'job_email_message_refs', 'job_email_correlations', 'job_email_correlation_candidates',
      'job_email_application_links', 'job_email_interview_links', 'job_email_transition_proposals',
      'job_email_reply_draft_proposals', 'job_email_transition_events', 'job_email_reply_draft_events',
      'job_email_application_events', 'job_email_interview_events', 'job_email_operations'
    ]) createAppendOnlyTriggers(db, table);
    db.prepare(`INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?, 'job_email_integration_foundation')`).run(EMAIL_SCHEMA_VERSION);
  }
  migrateApplicationExternalIdentifiers(db);
  correlationRegistry.migrateEmailCorrelationRegistry(db);
  migrateReversibleApplicationExternalIdentifiers(db);
  migrateCorrelationPolicy(db);
  migrateEmailCommunication(db);
  migrateEmailDraftReply(db);
  migrateEmailSendReceiptCorrelation(db);
  migrateEmailOutgoingV2(db);
  migrateEmailOutgoingV2AuthorityGuards(db);
  migrateApprovalPolicy(db);
  migrateEmailClarifications(db);
}

function migrateApplicationExternalIdentifiers(db) {
  const migration = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
    .get(APPLICATION_EXTERNAL_IDENTIFIER_SCHEMA_VERSION);
  if (migration) {
    if (migration.name !== APPLICATION_EXTERNAL_IDENTIFIER_MIGRATION_NAME) {
      throw new EmailIntegrationError(
        'MIGRATION_CONFLICT',
        `Schema version ${APPLICATION_EXTERNAL_IDENTIFIER_SCHEMA_VERSION} is already named ${migration.name}`
      );
    }
    return;
  }
  const nameConflict = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?')
    .get(APPLICATION_EXTERNAL_IDENTIFIER_MIGRATION_NAME);
  if (nameConflict) {
    throw new EmailIntegrationError(
      'MIGRATION_CONFLICT',
      `Migration ${APPLICATION_EXTERNAL_IDENTIFIER_MIGRATION_NAME} is already registered as version ${nameConflict.version}`
    );
  }

  db.exec(`
    CREATE TABLE application_external_identifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      namespace TEXT NOT NULL COLLATE NOCASE,
      value TEXT NOT NULL,
      source_message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
      source_correlation_id INTEGER NOT NULL REFERENCES job_email_correlations(id) ON DELETE RESTRICT,
      source_transition_proposal_id TEXT NOT NULL REFERENCES job_email_transition_proposals(proposal_id) ON DELETE RESTRICT,
      review_event_id INTEGER NOT NULL REFERENCES job_email_transition_events(id) ON DELETE RESTRICT,
      reviewed_by TEXT NOT NULL,
      facts_digest TEXT NOT NULL CHECK (length(facts_digest)=64),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (trim(namespace) <> '' AND namespace=lower(trim(namespace))),
      CHECK (trim(value) <> '' AND value=trim(value)),
      CHECK (trim(reviewed_by) <> ''),
      UNIQUE(namespace, value),
      UNIQUE(application_id, namespace, value)
    );

    CREATE INDEX idx_application_external_identifiers_application
      ON application_external_identifiers(application_id, namespace);

    CREATE TRIGGER application_external_identifiers_reviewed_source
    BEFORE INSERT ON application_external_identifiers
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM job_email_message_refs message
        JOIN job_email_correlations correlation
          ON correlation.id=NEW.source_correlation_id
         AND correlation.message_ref_id=message.id
        JOIN job_email_transition_proposals proposal
          ON proposal.proposal_id=NEW.source_transition_proposal_id
         AND proposal.message_ref_id=message.id
         AND proposal.correlation_id=correlation.id
        JOIN job_email_transition_events review
          ON review.id=NEW.review_event_id
         AND review.proposal_id=proposal.proposal_id
         AND review.event_kind='approved'
        JOIN json_each(message.facts_json, '$.applicationRefs') reference
        WHERE message.id=NEW.source_message_ref_id
          AND message.facts_digest=NEW.facts_digest
          AND correlation.facts_digest=NEW.facts_digest
          AND correlation.resolution='linked'
          AND correlation.resolved_application_id=NEW.application_id
          AND proposal.application_id=NEW.application_id
          AND review.actor=NEW.reviewed_by
          AND lower(trim(CAST(json_extract(reference.value, '$.namespace') AS TEXT)))=NEW.namespace
          AND trim(CAST(json_extract(reference.value, '$.value') AS TEXT))=NEW.value
      ) THEN RAISE(ABORT, 'application identifier requires reviewed linked email provenance') END;
    END;
  `);
  createAppendOnlyTriggers(db, 'application_external_identifiers');
  db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)')
    .run(APPLICATION_EXTERNAL_IDENTIFIER_SCHEMA_VERSION, APPLICATION_EXTERNAL_IDENTIFIER_MIGRATION_NAME);
}

function runEmailCommand(db, args, flags, dependencies = {}) {
  const action = args[0];
  if (isEmailCommunicationAction(action)) return runEmailCommunicationCommand(db, action, flags);
  assertAllowedFlags(flags, EMAIL_COMMAND_FLAGS[action], `email ${action || ''}`.trim());
  if (action === 'import-facts') return importFacts(db, readContractFile(flags.input, '--input'), required(flags.idempotencyKey, '--idempotency-key'));
  if (action === 'record-correlation') {
    const recorded = recordCorrelation(db, readContractFile(flags.input, '--input'), required(flags.idempotencyKey, '--idempotency-key'));
    // The relay delivering inbound mail is the loop's main external event.
    if (!recorded?.reused) requestWakeQuietly(db, { reason: 'inbound mail recorded', source: 'relay' });
    return recorded;
  }
  if (action === 'retract-learning') {
    return commandResult('retract-learning', retractCorrelationLink(db, {
      messageRefId: required(flags.messageRefId, '--message-ref-id'), actor: flags.actor, reason: flags.reason
    }));
  }
  if (action === 'backfill-learnings') {
    return commandResult('backfill-learnings', backfillCorrelationLearnings(db, { actor: flags.actor || 'jobtrack:backfill' }));
  }
  if (action === 'learnings') {
    return commandResult('learnings', { learnings: correlationRegistry.listLearnings(db, flags) });
  }
  if (action === 'identity') {
    const operation = args[1];
    if (args.length > 2 || (operation && !['add', 'retract'].includes(operation))) {
      throw new EmailIntegrationError('INVALID_ARGUMENT', 'email identity accepts only the add or retract operation');
    }
    if (operation) return commandResult('identity', editIdentityRegistry(db, operation, flags));
    if (flags.actor !== undefined || flags.reason !== undefined || flags.class !== undefined) {
      throw new EmailIntegrationError('INVALID_ARGUMENT', 'email identity inspection does not accept edit provenance or class fields');
    }
    const address = String(flags.address ?? '').trim().toLowerCase();
    const domain = String(flags.domain ?? (address.includes('@') ? address.split('@').at(-1) : '')).trim().toLowerCase();
    const identity = correlationRegistry.identifySender(db, {
      source: { fromAddress: address, fromDomain: domain },
      ...(flags.name ? { company: { name: String(flags.name) } } : {})
    });
    return commandResult('identity', {
      ...identity,
      domainClassProvenance: classifySenderDomainWithProvenance(db, domain),
      registryFacts: correlationRegistry.listRegistryFacts(db, {
        address: address || undefined,
        domain: address ? undefined : (domain || undefined),
        companyId: flags.companyId,
        kind: flags.kind
      })
    });
  }
  if (action === 'metrics') {
    return commandResult('metrics', { metrics: readCorrelationMetrics(db, { applicationId: flags.applicationId }) });
  }
  if (action === 'clarify') {
    return commandResult('clarify', openClarification(db, {
      messageRefId: required(flags.messageRefId, '--message-ref-id'),
      candidates: required(flags.candidates, '--candidates'),
      ...(flags.inReplyTo !== undefined ? { inReplyTo: flags.inReplyTo } : {}),
      ...(flags.references !== undefined ? { references: flags.references } : {}),
      ...(flags.replySubject !== undefined ? { replySubject: flags.replySubject } : {}),
      ...(flags.preparationDigest !== undefined ? { preparationDigest: flags.preparationDigest } : {})
    }, dependencies.clarification || {}));
  }
  if (action === 'resolve-correlation') return resolveCorrelation(db, readContractFile(flags.input, '--input'), required(flags.idempotencyKey, '--idempotency-key'));
  if (action === 'propose-transition') return proposeTransition(db, readContractFile(flags.input, '--input'), required(flags.idempotencyKey, '--idempotency-key'));
  if (action === 'propose-reply') return proposeReplyDraft(db, readContractFile(flags.input, '--input'), required(flags.idempotencyKey, '--idempotency-key'));
  if (action === 'review-transition') return reviewTransition(db, flags);
  if (action === 'review-reply') return reviewReplyDraft(db, flags);
  if (action === 'apply-transition') return applyTransition(db, flags);
  if (action === 'draft-reply-context') {
    // The research descriptor, when supplied, is read from a JSON file and pinned
    // into the returned sourceStateSha256. JobTrack still makes no network call.
    const research = flags.research !== undefined ? readContractFile(flags.research, '--research') : undefined;
    return {
      context: buildDraftReplyContext(db, {
        provider: required(flags.provider, '--provider'),
        accountId: required(flags.accountId, '--account-id'),
        messageId: required(flags.messageId, '--message-id'),
        ...(flags.threadId ? { threadId: flags.threadId } : {})
      }, research)
    };
  }
  if (action === 'draft-reply-issue') {
    const request = readContractFile(flags.input, '--input');
    return issueDraftReplyRequest(
      db,
      { ...request, idempotencyKey: required(flags.idempotencyKey, '--idempotency-key') },
      idempotentOperation
    );
  }
  if (action === 'draft-reply-record') {
    return recordDraftReplyResult(
      db, readContractFile(flags.input, '--input'), required(flags.idempotencyKey, '--idempotency-key'),
      { proposeReplyDraft, idempotentOperation }
    );
  }
  if (action === 'draft-reply-approve-send') {
    return approveDraftReplySend(
      db,
      {
        proposalId: required(flags.proposalId, '--proposal-id'),
        expectedProposalDigest: required(flags.expectedProposalDigest, '--expected-proposal-digest'),
        approvedBy: required(flags.approvedBy, '--approved-by'),
        approvedAt: nullable(flags.approvedAt),
        idempotencyKey: required(flags.idempotencyKey, '--idempotency-key')
      },
      { reviewReplyDraft, idempotentOperation }
    );
  }
  if (action === 'draft-reply-correlate-receipt') {
    return correlateSendReceipt(db, readContractFile(flags.input, '--input'));
  }
  if (action === 'outgoing-draft-issue') {
    return issueOutgoingDraftRequest(db, readContractFile(flags.input, '--input'));
  }
  if (action === 'outgoing-draft-record') {
    return recordOutgoingDraftResult(db, readContractFile(flags.input, '--input'));
  }
  if (action === 'outgoing-draft-receipt') {
    return captureOutgoingDraftReceipt(db, readContractFile(flags.input, '--input'));
  }
  if (action === 'outgoing-review') {
    return { projection: readOutgoingReviewProjection(db, required(flags.proposalId, '--proposal-id')) };
  }
  if (action === 'outgoing-review-record') {
    return recordOutgoingReviewDecision(
      db,
      readContractFile(flags.input, '--input'),
      dependencies.outgoingReview || {
        approvalChannel: { verify: verifyOwnerCliReviewChannel }
      }
    );
  }
  if (action === 'outgoing-send-request') {
    return createOutgoingSendRequest(
      db,
      readContractFile(flags.input, '--input'),
      dependencies.outgoingSendRequest || {}
    );
  }
  if (action === 'outgoing-receipt') {
    return correlateOutgoingSendReceipt(
      db,
      readContractFile(flags.input, '--input'),
      dependencies.outgoingReceipt || {}
    );
  }
  if (action === 'outgoing-invalidate') {
    return invalidateOutgoingApproval(db, readContractFile(flags.input, '--input'));
  }
  if (action === 'approval-policy') {
    const applicationId = flags.applicationId === undefined ? undefined : Number(flags.applicationId);
    if (flags.mode === undefined) return approvalPolicyFor(db, applicationId);
    if (applicationId === undefined || !Number.isInteger(applicationId)) {
      throw new EmailIntegrationError('INVALID_INPUT',
        'Setting a policy requires --application-id (the fleet default stays auto; JOBTRACK_APPROVAL_DEFAULT=manual flips it)');
    }
    return setApprovalPolicy(db, { applicationId, mode: flags.mode, setBy: 'owner-cli' });
  }
  if (action === 'auto-approve') {
    return autoApproveProposal(db, {
      proposalId: required(flags.proposalId, '--proposal-id'),
      applicationId: flags.applicationId === undefined ? undefined : Number(flags.applicationId)
    });
  }
  if (action === 'send-approved') {
    return sendApproved(db, {
      approvalId: required(flags.approvalId, '--approval-id'),
      provider: flags.provider,
      transmitAccount: flags.transmitAccount,
      gmailThreadId: flags.gmailThreadId,
      replyToMessageId: flags.replyToMessageId
    });
  }
  if (action === 'correlate') throw new EmailIntegrationError('READ_ONLY_REQUIRED', 'email correlate must use the dedicated read-only CLI path');
  throw new EmailIntegrationError('UNKNOWN_COMMAND', `Unknown email integration command: ${action || '(missing)'}`);
}

// Direct invocation of the owner-only JobTrack CLI is the authentication
// boundary for a rejection event. The receipt digest binds the exact review
// context. This verifier supplies no signing capability, so it cannot mint an
// approval-receipt.v2 or any send authority.
function verifyOwnerCliReviewChannel(channel, context) {
  return channel.kind === 'jobtrack_fixed_command'
    && channel.channelId === 'jobtrack-owner-cli.v1'
    && channel.authenticationReceiptDigest === digestCanonicalJson(context);
}

function assertEmailCommandFlags(action, flags) {
  if (isEmailCommunicationAction(action)) return assertEmailCommunicationCommandFlags(action, flags);
  assertAllowedFlags(flags, EMAIL_COMMAND_FLAGS[action], `email ${action || ''}`.trim());
}

function correlateEmailFileReadOnly(dbPath, inputPath) {
  const facts = validateJobApplicationEmailFacts(readContractFile(inputPath, '--input'));
  // SQLite can create -wal/-shm sidecars even when a connection is opened with
  // SQLITE_OPEN_READONLY. Correlation must not mutate the source store at all,
  // so query a verified private snapshot instead. Copying the committed WAL as
  // well as the main file preserves the latest state without touching either.
  const snapshot = createVerifiedReadonlySnapshot(dbPath);
  let db;
  try {
    db = new Database(snapshot.dbPath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    return correlateEmailReadOnly(db, facts);
  } finally {
    if (db?.open) db.close();
    fs.rmSync(snapshot.directory, { recursive: true, force: true });
  }
}

function createVerifiedReadonlySnapshot(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new EmailIntegrationError('STORE_NOT_INITIALIZED', `JobTrack database does not exist: ${dbPath}`);
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-email-readonly-'));
  const snapshotPath = path.join(directory, 'jobtrack.db');
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const before = sourceSnapshotSignature(dbPath);
      fs.copyFileSync(dbPath, snapshotPath);
      fs.rmSync(`${snapshotPath}-wal`, { force: true });
      if (before.wal !== null) {
        try {
          fs.copyFileSync(`${dbPath}-wal`, `${snapshotPath}-wal`);
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
      }
      const after = sourceSnapshotSignature(dbPath);
      if (before.database === after.database && before.wal === after.wal) {
        return { directory, dbPath: snapshotPath };
      }
    }
    throw new EmailIntegrationError(
      'STORE_BUSY',
      'JobTrack changed repeatedly while creating a read-only correlation snapshot; retry the command'
    );
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function sourceSnapshotSignature(dbPath) {
  return {
    database: fileSignature(dbPath, true),
    wal: fileSignature(`${dbPath}-wal`, false)
  };
}

function fileSignature(filePath, requiredFile) {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if (!requiredFile && error.code === 'ENOENT') return null;
    if (requiredFile && error.code === 'ENOENT') {
      throw new EmailIntegrationError('STORE_NOT_INITIALIZED', `JobTrack database does not exist: ${filePath}`);
    }
    throw error;
  }
}

function correlateEmailReadOnly(db, rawFacts) {
  const facts = validateJobApplicationEmailFacts(rawFacts);
  if (!tableExists(db, 'applications')) throw new EmailIntegrationError('STORE_NOT_INITIALIZED', 'JobTrack applications table is missing');
  const store = createCorrelationStore(db);
  return validateCorrelationResult(correlate(facts, store, loadPolicy(store)));
}

function importFacts(db, rawFacts, idempotencyKey) {
  const facts = validateJobApplicationEmailFacts(rawFacts);
  return idempotentOperation(db, 'import-facts', idempotencyKey, facts, () => {
    const factsDigest = digest(facts);
    const existing = findMessageRef(db, messageRefFromFacts(facts));
    if (existing) {
      if (existing.facts_digest !== factsDigest || existing.content_digest !== facts.source.contentDigest) {
        throw new EmailIntegrationError('MESSAGE_CONFLICT', 'The provider message was already imported with different facts');
      }
      projectMessageThread(db, existing);
      return commandResult('import-facts', { messageRefId: existing.id, factsDigest, reused: true });
    }
    const info = db.prepare(`
      INSERT INTO job_email_message_refs (
        provider, account_id, message_id, thread_id, received_at, from_address, from_domain,
        reply_to_address, content_digest, content_completeness, event_kind, security_risk,
        requires_review, facts_json, facts_digest
      ) VALUES (@provider,@accountId,@messageId,@threadId,@receivedAt,@fromAddress,@fromDomain,
        @replyToAddress,@contentDigest,@contentCompleteness,@eventKind,@securityRisk,@requiresReview,@factsJson,@factsDigest)
    `).run({
      ...facts.source,
      replyToAddress: facts.source.replyToAddress || null,
      contentCompleteness: facts.contentCompleteness,
      eventKind: facts.eventKind,
      securityRisk: facts.security.risk,
      requiresReview: facts.security.requiresReview ? 1 : 0,
      factsJson: stableJson(facts),
      factsDigest
    });
    const messageRefId = Number(info.lastInsertRowid);
    projectMessageThread(db, messageRefId);
    return commandResult('import-facts', { messageRefId, factsDigest, reused: false });
  });
}

// S6 of the correlation design: every confirmed link teaches the registry
// (sender contact, employer domain, role-title aliases). Learning never blocks
// a link — a failure is reported in the command result, not thrown.
function safeLearn(db, input) {
  return safeCorrelationLearn(db, input);
}

function recordCorrelation(db, rawCorrelation, idempotencyKey) {
  const correlation = validateCorrelationResult(rawCorrelation);
  return idempotentOperation(db, 'record-correlation', idempotencyKey, correlation, () => {
    const message = requireMessageRef(db, correlation.source, correlation.factsDigest);
    const correlationDigest = digest(correlation);
    const storedFacts = validateJobApplicationEmailFacts(JSON.parse(message.facts_json));
    const store = createCorrelationStore(db);
    // Replay under the revision stamped by the producer, not whichever policy
    // happens to be newest when the relay records it.
    const replayPolicy = correlation.schemaVersion === 'jobtrack-correlation-result.v3'
      ? loadPolicy(store, correlation.policyRevisionId)
      : loadPolicy(store);
    const currentCorrelation = validateCorrelationResult(correlate(storedFacts, store, replayPolicy));
    if (digest(currentCorrelation) !== correlationDigest) {
      throw new EmailIntegrationError(
        'CORRELATION_STALE',
        'Correlation does not match JobTrack\'s current read-only result; correlate again before recording it'
      );
    }
    const existing = db.prepare('SELECT id FROM job_email_correlations WHERE message_ref_id=? AND correlation_digest=?').get(message.id, correlationDigest);
    if (existing) return commandResult('record-correlation', { correlationId: existing.id, correlationDigest, reused: true });
    const info = db.prepare(`
      INSERT INTO job_email_correlations (
        message_ref_id, facts_digest, resolution, resolved_application_id, correlation_json, correlation_digest
      ) VALUES (?,?,?,?,?,?)
    `).run(message.id, correlation.factsDigest, correlation.resolution, correlation.resolved?.applicationId || null, stableJson(correlation), correlationDigest);
    const correlationId = Number(info.lastInsertRowid);
    const insertCandidate = db.prepare(`
      INSERT INTO job_email_correlation_candidates (
        correlation_id, application_id, company_id, opening_id, posting_id, posting_occurrence_id,
        interview_id, match_basis, confidence, reasons_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    for (const candidate of correlation.candidates) {
      insertCandidate.run(
        correlationId, candidate.applicationId, candidate.companyId || null, candidate.openingId || null,
        candidate.postingId || null, candidate.postingOccurrenceId || null, candidate.interviewId || null,
        candidate.matchBasis, candidate.confidence, stableJson(candidate.reasons)
      );
    }
    // A company_single_open link is queued for agent review and is not yet a
    // confirmed fact. Only normalized automatic exact links may teach here;
    // agent/operator confirmation learns in its reviewed action path.
    const learning = correlation.resolution === 'linked' && correlation.resolved && correlation.automaticEligible
      ? safeLearn(db, { messageRefId: message.id, applicationId: correlation.resolved.applicationId, correlationId, actor: 'jobtrack:record-correlation' })
      : undefined;
    const clarification = correlation.resolution === 'linked'
      && correlation.resolved?.matchBasis === 'clarification_reply'
      ? confirmClarificationReply(db, {
        facts: storedFacts,
        clarificationId: clarificationIdFromCorrelation(correlation),
        identityCompanyIds: correlation.identity.companyIds,
        companyId: correlation.resolved.companyId,
        applicationId: correlation.resolved.applicationId,
        messageRefId: message.id
      })
      : null;
    return commandResult('record-correlation', {
      correlationId,
      correlationDigest,
      reused: false,
      ...(learning ? { learning } : {}),
      ...(clarification ? { clarification } : {})
    });
  });
}

function clarificationIdFromCorrelation(correlation) {
  const ids = new Set((correlation.evidence || [])
    .filter((entry) => entry?.kind === 'clarification_reply')
    .map((entry) => String(entry.value || '').trim())
    .filter(Boolean));
  return ids.size === 1 ? [...ids][0] : null;
}

// HIGH-4: operator disambiguation. When correlation is `ambiguous` — two or more
// applications match, as happens the moment a welcome email lands on a company
// with several open applications — there is no exact basis to auto-pick, and
// propose-transition refuses. This verb lets the operator say "it is this one":
// it re-derives the current read-only correlation (which MUST still be ambiguous
// and MUST still list the chosen application), promotes that candidate to
// `resolved`, and records the human choice as an `operator_resolution` evidence
// entry. The result is a `linked` correlation that is deliberately NON-automatic
// (automaticEligible stays false because the promoted basis is non-exact), so the
// downstream transition still requires review — the operator unblocked the lane,
// they did not bypass approval.
function resolveCorrelation(db, rawInput, idempotencyKey) {
  const input = validateCorrelationResolutionInput(rawInput);
  return idempotentOperation(db, 'resolve-correlation', idempotencyKey, input, () => {
    const message = requireMessageRef(db, input.source, input.factsDigest);
    const facts = validateJobApplicationEmailFacts(JSON.parse(message.facts_json));
    const current = correlateEmailReadOnly(db, facts);
    if (current.resolution !== 'ambiguous') {
      throw new EmailIntegrationError(
        'CORRELATION_NOT_AMBIGUOUS',
        `Only an ambiguous correlation can be operator-resolved; current resolution is ${current.resolution}`
      );
    }
    // Promote the highest-priority candidate for the chosen application. candidates
    // are already ordered by basis priority then confidence, so the first match wins.
    const resolved = current.candidates.find((candidate) => candidate.applicationId === input.applicationId);
    if (!resolved) {
      throw new EmailIntegrationError(
        'RESOLUTION_TARGET_NOT_A_CANDIDATE',
        `Application ${input.applicationId} is not among the correlation candidates; correlate again before resolving`
      );
    }
    if (tableExists(db, 'email_link_retractions') && db.prepare(`
      SELECT 1 FROM email_link_retractions
      WHERE message_ref_id=? AND (application_id=? OR application_id IS NULL)
      LIMIT 1
    `).get(message.id, input.applicationId)) {
      throw new EmailIntegrationError(
        'CORRELATION_RETRACTED',
        `Message ${message.id} was previously retracted from application ${input.applicationId}; choose a current candidate`
      );
    }
    const operatorEvidence = {
      kind: 'operator_resolution',
      value: boundedResolutionEvidence(input.actor, input.applicationId, current.candidates.length, input.reason)
    };
    // Preserve the selected application's causal title bindings ahead of all
    // other read-only evidence, then reserve the final contract slot for the
    // operator's choice. This prevents the 30-item cap from authorizing a link
    // while silently discarding the evidence required for safe alias learning.
    const evidence = [
      ...prioritizeRoleTitleMatchEvidence(current.evidence, input.applicationId).slice(0, 29),
      operatorEvidence
    ];
    const { preferredCandidateId: _preferredCandidateId, clarifiable: _clarifiable, ...currentWithoutAmbiguousFields } = current;
    const resolvedCorrelation = validateCorrelationResult({
      ...currentWithoutAmbiguousFields,
      resolution: 'linked',
      resolved,
      candidates: current.candidates,
      evidence,
      automaticEligible: false,
      ...(current.schemaVersion === 'jobtrack-correlation-result.v3' ? { clarifiable: false } : {})
    });
    const correlationDigest = digest(resolvedCorrelation);
    const existing = db.prepare('SELECT id FROM job_email_correlations WHERE message_ref_id=? AND correlation_digest=?').get(message.id, correlationDigest);
    if (existing) {
      return commandResult('resolve-correlation', {
        correlationId: existing.id, correlationDigest, resolvedApplicationId: input.applicationId,
        matchBasis: resolved.matchBasis, reused: true
      });
    }
    const info = db.prepare(`
      INSERT INTO job_email_correlations (
        message_ref_id, facts_digest, resolution, resolved_application_id, correlation_json, correlation_digest
      ) VALUES (?,?,?,?,?,?)
    `).run(message.id, resolvedCorrelation.factsDigest, 'linked', input.applicationId, stableJson(resolvedCorrelation), correlationDigest);
    const correlationId = Number(info.lastInsertRowid);
    const insertCandidate = db.prepare(`
      INSERT INTO job_email_correlation_candidates (
        correlation_id, application_id, company_id, opening_id, posting_id, posting_occurrence_id,
        interview_id, match_basis, confidence, reasons_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    for (const candidate of resolvedCorrelation.candidates) {
      insertCandidate.run(
        correlationId, candidate.applicationId, candidate.companyId || null, candidate.openingId || null,
        candidate.postingId || null, candidate.postingOccurrenceId || null, candidate.interviewId || null,
        candidate.matchBasis, candidate.confidence, stableJson(candidate.reasons)
      );
    }
    const learning = safeLearn(db, { messageRefId: message.id, applicationId: input.applicationId, correlationId, actor: input.actor });
    return commandResult('resolve-correlation', {
      correlationId,
      correlationDigest,
      resolvedApplicationId: input.applicationId,
      learning,
      resolved: {
        applicationId: resolved.applicationId,
        applicationVersion: resolved.applicationVersion,
        matchBasis: resolved.matchBasis,
        confidence: resolved.confidence
      },
      reused: false
    });
  });
}

function validateCorrelationResolutionInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    throw new EmailIntegrationError('INVALID_INPUT', 'resolve-correlation input must be an object');
  }
  const allowed = new Set(['source', 'factsDigest', 'applicationId', 'actor', 'reason']);
  for (const key of Object.keys(rawInput)) {
    if (!allowed.has(key)) throw new EmailIntegrationError('INVALID_INPUT', `Unexpected resolve-correlation field: ${key}`);
  }
  const source = rawInput.source;
  if (!source || typeof source !== 'object') throw new EmailIntegrationError('INVALID_INPUT', 'resolve-correlation requires a source');
  for (const key of ['provider', 'accountId', 'messageId', 'threadId']) {
    if (typeof source[key] !== 'string' || source[key].length === 0) {
      throw new EmailIntegrationError('INVALID_INPUT', `resolve-correlation source.${key} is required`);
    }
  }
  if (typeof rawInput.factsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(rawInput.factsDigest)) {
    throw new EmailIntegrationError('INVALID_INPUT', 'resolve-correlation factsDigest must be a 64-hex digest');
  }
  if (!Number.isInteger(rawInput.applicationId) || rawInput.applicationId <= 0) {
    throw new EmailIntegrationError('INVALID_INPUT', 'resolve-correlation applicationId must be a positive integer');
  }
  const actor = boundedResolutionText(rawInput.actor, 'actor', 200);
  const reason = boundedResolutionText(rawInput.reason, 'reason', 500);
  return {
    source: { provider: source.provider, accountId: source.accountId, messageId: source.messageId, threadId: source.threadId },
    factsDigest: rawInput.factsDigest,
    applicationId: rawInput.applicationId,
    actor,
    reason
  };
}

function boundedResolutionText(value, label, max) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EmailIntegrationError('INVALID_INPUT', `resolve-correlation ${label} is required`);
  }
  const text = value.trim();
  if (text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new EmailIntegrationError('INVALID_INPUT', `resolve-correlation ${label} exceeds its safe printable bound`);
  }
  return text;
}

function boundedResolutionEvidence(actor, applicationId, candidateCount, reason) {
  const base = `operator=${actor}; chose application:${applicationId} from ${candidateCount} candidates; ${reason}`;
  return base.length > 500 ? `${base.slice(0, 497)}...` : base;
}

function proposeTransition(db, rawProposal, idempotencyKey) {
  const proposal = validateTransitionProposal(rawProposal);
  return idempotentOperation(db, 'propose-transition', idempotencyKey, proposal, () => {
    const message = requireMessageRef(db, proposal.source, proposal.factsDigest);
    const facts = validateJobApplicationEmailFacts(JSON.parse(message.facts_json));
    const expectedSafety = {
      contentCompleteness: facts.contentCompleteness,
      securityRisk: facts.security.risk,
      sourceRequiresReview: facts.security.requiresReview
    };
    if (stableJson(proposal.safety) !== stableJson(expectedSafety)) {
      throw new EmailIntegrationError('FACTS_SAFETY_MISMATCH', 'Transition safety fields differ from the imported facts');
    }
    const activeCorrelationSource = db.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name='active_job_email_linked_correlations'").get()
      ? 'active_job_email_linked_correlations'
      : 'job_email_correlations';
    const correlation = db.prepare(`
      SELECT * FROM ${activeCorrelationSource}
      WHERE message_ref_id=? AND correlation_digest=? AND facts_digest=?
    `).get(message.id, proposal.correlationDigest, proposal.factsDigest);
    if (!correlation) throw new EmailIntegrationError('CORRELATION_NOT_FOUND', 'Record the exact correlation before proposing a transition');
    const storedCorrelation = validateCorrelationResult(JSON.parse(correlation.correlation_json));
    if (storedCorrelation.resolution !== 'linked' || storedCorrelation.resolved.applicationId !== proposal.target.applicationId) {
      throw new EmailIntegrationError('CORRELATION_MISMATCH', 'Transition target does not match the linked correlation');
    }
    if (proposal.correlation.matchBasis !== storedCorrelation.resolved.matchBasis
      || proposal.correlation.confidence !== storedCorrelation.resolved.confidence) {
      throw new EmailIntegrationError('CORRELATION_MISMATCH', 'Transition correlation summary differs from the recorded result');
    }
    if (storedCorrelation.resolved.applicationVersion !== proposal.expectedApplicationVersion) {
      throw new EmailIntegrationError('CORRELATION_MISMATCH', 'Transition expected version does not match the correlation snapshot');
    }
    verifyNormalizedTarget(db, proposal.target, storedCorrelation.resolved);
    const proposalDigest = digest(proposal);
    const existing = db.prepare('SELECT proposal_digest FROM job_email_transition_proposals WHERE proposal_id=?').get(proposal.proposalId);
    if (existing) {
      if (existing.proposal_digest !== proposalDigest) throw new EmailIntegrationError('PROPOSAL_CONFLICT', 'Proposal ID was reused with different content');
      return commandResult('propose-transition', { proposalId: proposal.proposalId, proposalDigest, reused: true });
    }
    db.prepare(`
      INSERT INTO job_email_transition_proposals (
        proposal_id, message_ref_id, correlation_id, application_id, interview_id, action_kind,
        expected_application_version, automation_eligible, requires_review, proposal_json, proposal_digest
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      proposal.proposalId, message.id, correlation.id, proposal.target.applicationId, proposal.target.interviewId || null,
      proposal.action.kind, proposal.expectedApplicationVersion, proposal.automationEligible ? 1 : 0,
      proposal.requiresReview ? 1 : 0, stableJson(proposal), proposalDigest
    );
    insertTransitionEvent(db, proposal.proposalId, 'proposed', 'email-extension', null, null);
    return commandResult('propose-transition', { proposalId: proposal.proposalId, proposalDigest, reused: false });
  });
}

function proposeReplyDraft(db, rawProposal, idempotencyKey) {
  const proposal = validateReplyDraftProposal(rawProposal);
  return idempotentOperation(db, 'propose-reply', idempotencyKey, proposal, () => {
    const message = requireMessageRef(db, proposal.source, proposal.factsDigest);
    const facts = validateJobApplicationEmailFacts(JSON.parse(message.facts_json));
    const lockedRecipient = (facts.source.replyToAddress || facts.source.fromAddress).toLowerCase();
    if (proposal.recipient.toLowerCase() !== lockedRecipient) {
      throw new EmailIntegrationError('RECIPIENT_MISMATCH', 'Reply recipient is not the imported message reply context');
    }
    const proposalDigest = digest(proposal);
    const existing = db.prepare('SELECT proposal_digest FROM job_email_reply_draft_proposals WHERE proposal_id=?').get(proposal.proposalId);
    if (existing) {
      if (existing.proposal_digest !== proposalDigest) throw new EmailIntegrationError('PROPOSAL_CONFLICT', 'Reply proposal ID was reused with different content');
      return commandResult('propose-reply', { proposalId: proposal.proposalId, proposalDigest, reused: true, autoSendEnabled: false });
    }
    db.prepare(`
      INSERT INTO job_email_reply_draft_proposals (
        proposal_id, message_ref_id, recipient, authorship, requires_review, auto_send_eligible, proposal_json, proposal_digest
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(
      proposal.proposalId, message.id, proposal.recipient, proposal.authorship, proposal.requiresReview ? 1 : 0,
      0, stableJson(proposal), proposalDigest
    );
    const styleBinding = persistReplyStyleBinding(db, proposal, message);
    insertReplyEvent(db, proposal.proposalId, 'proposed', 'email-extension', null);
    return commandResult('propose-reply', {
      proposalId: proposal.proposalId,
      proposalDigest,
      reused: false,
      autoSendEnabled: false,
      ...(styleBinding ? { styleBinding } : {})
    });
  });
}

function reviewTransition(db, flags) {
  const proposalId = required(flags.proposalId, '--proposal-id');
  const decision = enumInput(flags.decision, new Set(['approved', 'rejected']), '--decision');
  const decidedBy = required(flags.decidedBy, '--decided-by');
  const request = { proposalId, decision, decidedBy, notes: nullable(flags.notes) };
  return idempotentOperation(db, 'review-transition', required(flags.idempotencyKey, '--idempotency-key'), request, () => {
    requireTransitionProposal(db, proposalId);
    const latest = latestTransitionEvent(db, proposalId);
    if (!latest || latest.event_kind !== 'proposed') throw new EmailIntegrationError('INVALID_PROPOSAL_STATE', `Transition proposal is already ${latest?.event_kind || 'unknown'}`);
    insertTransitionEvent(db, proposalId, decision, decidedBy, request.notes, null);
    return commandResult('review-transition', { proposalId, decision, decidedBy });
  });
}

function reviewReplyDraft(db, flags) {
  const proposalId = required(flags.proposalId, '--proposal-id');
  const decision = enumInput(flags.decision, new Set(['approved', 'rejected']), '--decision');
  const decidedBy = required(flags.decidedBy, '--decided-by');
  const request = { proposalId, decision, decidedBy, notes: nullable(flags.notes) };
  return idempotentOperation(db, 'review-reply', required(flags.idempotencyKey, '--idempotency-key'), request, () => {
    const proposal = db.prepare('SELECT * FROM job_email_reply_draft_proposals WHERE proposal_id=?').get(proposalId);
    if (!proposal) throw new EmailIntegrationError('NOT_FOUND', `Reply draft proposal not found: ${proposalId}`);
    const latest = db.prepare('SELECT * FROM job_email_reply_draft_events WHERE proposal_id=? ORDER BY id DESC LIMIT 1').get(proposalId);
    if (!latest || latest.event_kind !== 'proposed') throw new EmailIntegrationError('INVALID_PROPOSAL_STATE', `Reply draft proposal is already ${latest?.event_kind || 'unknown'}`);
    insertReplyEvent(db, proposalId, decision, decidedBy, request.notes);
    return commandResult('review-reply', { proposalId, decision, decidedBy, autoSendEnabled: false });
  });
}

function applyTransition(db, flags) {
  const proposalId = required(flags.proposalId, '--proposal-id');
  const expectedApplicationVersion = nonnegativeIntegerInput(flags.expectedApplicationVersion, '--expected-application-version');
  const appliedBy = required(flags.appliedBy, '--applied-by');
  const request = { proposalId, expectedApplicationVersion, appliedBy };
  return idempotentOperation(db, 'apply-transition', required(flags.idempotencyKey, '--idempotency-key'), request, () => {
    const record = requireTransitionProposal(db, proposalId);
    const proposal = validateTransitionProposal(JSON.parse(record.proposal_json));
    const latest = latestTransitionEvent(db, proposalId);
    if (!latest || latest.event_kind !== 'approved') throw new EmailIntegrationError('APPROVAL_REQUIRED', 'Transition proposal requires an explicit approval event');
    const activeCorrelationSource = db.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name='active_job_email_linked_correlations'").get()
      ? 'active_job_email_linked_correlations'
      : 'job_email_correlations';
    const activeCorrelation = db.prepare(`
      SELECT 1 FROM ${activeCorrelationSource}
      WHERE id=? AND message_ref_id=? AND resolved_application_id=?
    `).get(record.correlation_id, record.message_ref_id, record.application_id);
    if (!activeCorrelation) {
      throw new EmailIntegrationError('CORRELATION_RETRACTED', 'The reviewed email link was retracted before this transition could be applied');
    }
    if (proposal.expectedApplicationVersion !== expectedApplicationVersion) {
      throw new EmailIntegrationError('EXPECTED_VERSION_MISMATCH', 'Apply request version does not match the immutable proposal');
    }
    const application = db.prepare('SELECT * FROM applications WHERE id=?').get(proposal.target.applicationId);
    if (!application) throw new EmailIntegrationError('NOT_FOUND', `Application not found: ${proposal.target.applicationId}`);
    if ((application.lock_version || 0) !== expectedApplicationVersion) {
      throw new EmailIntegrationError('STALE_APPLICATION', `Application ${application.id} changed after correlation`, {
        expected: expectedApplicationVersion, actual: application.lock_version || 0
      });
    }
    const message = db.prepare('SELECT * FROM job_email_message_refs WHERE id=?').get(record.message_ref_id);
    const identifierValidation = validateReviewedApplicationIdentifiers(db, {
      record,
      application,
      message,
      reviewEvent: latest
    });
    const learning = safeLearn(db, {
      messageRefId: message.id,
      applicationId: application.id,
      correlationId: record.correlation_id,
      actor: appliedBy,
      reviewedTransition: identifierValidation.reviewedTransition
    });
    const externalIdentifiers = learning?.applicationIdentifiers;
    const result = {
      ...applyAction(db, proposal, application, message),
      ...(identifierValidation.hasIdentifiers && externalIdentifiers ? { externalIdentifiers } : {}),
      learning
    };
    insertTransitionEvent(db, proposalId, 'applied', appliedBy, null, result);
    return commandResult('apply-transition', { proposalId, appliedBy, ...result });
  });
}

function validateReviewedApplicationIdentifiers(db, input) {
  const facts = validateJobApplicationEmailFacts(JSON.parse(input.message.facts_json));
  const correlation = db.prepare('SELECT * FROM job_email_correlations WHERE id=?').get(input.record.correlation_id);
  if (!correlation
    || correlation.message_ref_id !== input.message.id
    || correlation.resolution !== 'linked'
    || correlation.resolved_application_id !== input.application.id
    || correlation.facts_digest !== input.message.facts_digest) {
    throw new EmailIntegrationError('CORRELATION_MISMATCH', 'External application identifiers require the reviewed linked correlation');
  }
  if (input.record.application_id !== input.application.id
    || input.record.message_ref_id !== input.message.id
    || input.reviewEvent.proposal_id !== input.record.proposal_id
    || input.reviewEvent.event_kind !== 'approved') {
    throw new EmailIntegrationError('APPROVAL_REQUIRED', 'External application identifiers require the proposal approval event');
  }

  return {
    hasIdentifiers: facts.applicationRefs.length > 0,
    reviewedTransition: {
      proposalId: input.record.proposal_id,
      reviewEventId: input.reviewEvent.id,
      reviewedBy: input.reviewEvent.actor
    }
  };
}

function applyAction(db, proposal, application, message) {
  const action = proposal.action;
  const beforeStatus = application.status;
  const beforeVersion = application.lock_version || 0;
  let afterStatus = beforeStatus;
  let interview = null;
  let beforeInterview = null;
  let interviewEventKind = null;

  if (action.kind === 'transition_application_status') {
    if (beforeStatus !== action.fromStatus) throw new EmailIntegrationError('STALE_APPLICATION_STATUS', `Expected application status ${action.fromStatus}, found ${beforeStatus}`);
    assertStatusTransition(action.fromStatus, action.toStatus);
    afterStatus = action.toStatus;
  } else if (action.kind === 'create_interview') {
    const duplicate = db.prepare(`
      SELECT id FROM interviews WHERE application_id=? AND round=? AND scheduled_at=? AND scheduling_status IN ('scheduled','rescheduled')
    `).get(application.id, action.round, action.scheduledAt);
    if (duplicate) throw new EmailIntegrationError('INTERVIEW_CONFLICT', `Interview already exists: ${duplicate.id}`);
    interview = createScheduledInterview(db, {
      applicationId: application.id,
      round: action.round,
      scheduledAt: action.scheduledAt,
      timezone: action.timezone,
      format: action.format,
      interviewer: action.interviewer || null,
      sourceMessageRef: `${message.provider}:${message.account_id}:${message.message_id}`
    });
    interviewEventKind = 'scheduled';
    if (beforeStatus === 'applied') afterStatus = 'interviewing';
  } else if (action.kind === 'reschedule_interview') {
    beforeInterview = requireInterviewForApplication(db, action.interviewId, application.id);
    if (!['scheduled', 'rescheduled'].includes(beforeInterview.scheduling_status)) throw new EmailIntegrationError('INTERVIEW_CONFLICT', 'Only scheduled interviews can be rescheduled');
    if (Date.parse(beforeInterview.scheduled_at) !== Date.parse(action.fromScheduledAt)) {
      throw new EmailIntegrationError('STALE_INTERVIEW', 'Interview schedule changed after proposal');
    }
    interview = updateScheduledInterview(db, action.interviewId, {
      scheduledAt: action.toScheduledAt,
      timezone: action.timezone,
      schedulingStatus: 'rescheduled',
      sourceMessageRef: `${message.provider}:${message.account_id}:${message.message_id}`,
      expectedLockVersion: beforeInterview.lock_version || 0
    });
    interviewEventKind = 'rescheduled';
  } else if (action.kind === 'cancel_interview') {
    beforeInterview = requireInterviewForApplication(db, action.interviewId, application.id);
    if (!['scheduled', 'rescheduled'].includes(beforeInterview.scheduling_status)) throw new EmailIntegrationError('INTERVIEW_CONFLICT', 'Interview is not currently scheduled');
    const update = db.prepare(`
      UPDATE interviews SET scheduling_status='cancelled', cancelled_at=?, cancellation_reason=?, source_message_ref=?,
        updated_at=datetime('now'), lock_version=lock_version+1
      WHERE id=? AND lock_version=?
    `).run(
      action.cancelledAt || new Date().toISOString(), action.reason || null,
      `${message.provider}:${message.account_id}:${message.message_id}`,
      action.interviewId, beforeInterview.lock_version || 0
    );
    if (update.changes !== 1) throw new EmailIntegrationError('STALE_INTERVIEW', 'Interview changed concurrently');
    interview = db.prepare('SELECT * FROM interviews WHERE id=?').get(action.interviewId);
    interviewEventKind = 'cancelled';
  } else if (action.kind === 'record_offer') {
    if (beforeStatus !== 'offer') assertStatusTransition(beforeStatus, 'offer');
    db.prepare(`
      INSERT INTO offers(application_id,details,decision_deadline,outcome,updated_at)
      VALUES (?,?,?,'pending',datetime('now'))
      ON CONFLICT(application_id) DO UPDATE SET details=excluded.details,
        decision_deadline=excluded.decision_deadline, outcome='pending', updated_at=datetime('now')
    `).run(application.id, action.summary, action.decisionDeadline || null);
    afterStatus = 'offer';
  } else if (!['link_message', 'record_requested_action'].includes(action.kind)) {
    throw new EmailIntegrationError('UNSUPPORTED_ACTION', `Unsupported transition action: ${action.kind}`);
  }

  const relation = relationForAction(action);
  db.prepare(`
    INSERT INTO job_email_application_links(message_ref_id,application_id,relation,proposal_id)
    VALUES (?,?,?,?) ON CONFLICT(message_ref_id,application_id,relation) DO NOTHING
  `).run(message.id, application.id, relation, proposal.proposalId);
  if (interview) {
    db.prepare(`
      INSERT INTO job_email_interview_links(message_ref_id,interview_id,relation,proposal_id)
      VALUES (?,?,?,?) ON CONFLICT(message_ref_id,interview_id,relation) DO NOTHING
    `).run(message.id, interview.id, interviewEventKind, proposal.proposalId);
  }

  const update = db.prepare(`
    UPDATE applications SET status=?,
      status_changed_at=CASE WHEN status<>? THEN datetime('now') ELSE status_changed_at END,
      updated_at=datetime('now'), lock_version=lock_version+1
    WHERE id=? AND lock_version=?
  `).run(afterStatus, afterStatus, application.id, beforeVersion);
  if (update.changes !== 1) throw new EmailIntegrationError('STALE_APPLICATION', 'Application changed concurrently');
  const afterVersion = beforeVersion + 1;
  const details = {
    action,
    message: { provider: message.provider, accountId: message.account_id, messageId: message.message_id, threadId: message.thread_id },
    ...(interview ? { interviewId: interview.id } : {})
  };
  db.prepare(`
    INSERT INTO job_email_application_events (
      proposal_id,message_ref_id,application_id,action_kind,before_status,after_status,before_version,after_version,details_json
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run(proposal.proposalId, message.id, application.id, action.kind, beforeStatus, afterStatus, beforeVersion, afterVersion, stableJson(details));
  if (interview) {
    db.prepare(`
      INSERT INTO job_email_interview_events (
        proposal_id,message_ref_id,application_id,interview_id,event_kind,before_json,after_json
      ) VALUES (?,?,?,?,?,?,?)
    `).run(
      proposal.proposalId, message.id, application.id, interview.id, interviewEventKind,
      beforeInterview ? stableJson(interviewProjection(beforeInterview)) : null,
      stableJson(interviewProjection(interview))
    );
  }
  if (beforeStatus !== afterStatus) recordCanonicalStatusEventIfAvailable(db, {
    applicationId: application.id,
    fromStatus: beforeStatus,
    toStatus: afterStatus,
    proposal,
    evidenceIncomplete: proposal.safety.contentCompleteness !== 'sanitized_plain_text'
  });
  return {
    applicationId: application.id,
    beforeStatus,
    afterStatus,
    beforeVersion,
    afterVersion,
    ...(interview ? { interviewId: interview.id, interviewEventKind } : {})
  };
}

function verifyNormalizedTarget(db, target, resolved) {
  for (const key of ['companyId', 'openingId', 'postingId', 'postingOccurrenceId', 'interviewId']) {
    if (target[key] !== resolved[key]) {
      throw new EmailIntegrationError('CORRELATION_MISMATCH', `Transition target ${key} does not match correlation`);
    }
  }
  const application = db.prepare('SELECT * FROM applications WHERE id=?').get(target.applicationId);
  if (!application) throw new EmailIntegrationError('NOT_FOUND', `Application not found: ${target.applicationId}`);
  if (target.openingId !== undefined && application.job_opening_id !== undefined && application.job_opening_id !== null && application.job_opening_id !== target.openingId) {
    throw new EmailIntegrationError('CORRELATION_MISMATCH', 'Application opening differs from transition target');
  }
  if (target.postingId !== undefined && tableExists(db, 'application_postings')) {
    const link = db.prepare('SELECT 1 FROM application_postings WHERE application_id=? AND job_posting_id=?').get(target.applicationId, target.postingId);
    const primary = application.primary_job_posting_id === target.postingId;
    if (!link && !primary) throw new EmailIntegrationError('CORRELATION_MISMATCH', 'Application is not linked to the transition posting');
  }
}

function idempotentOperation(db, command, idempotencyKey, request, action) {
  boundedIdempotencyKey(idempotencyKey);
  const requestSha = digest(request);
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM job_email_operations WHERE idempotency_key=?').get(idempotencyKey);
    if (existing) {
      if (existing.command !== command || existing.request_sha256 !== requestSha) {
        throw new EmailIntegrationError('IDEMPOTENCY_CONFLICT', `Idempotency key ${idempotencyKey} was already used for a different request`);
      }
      return JSON.parse(existing.result_json);
    }
    const result = action();
    db.prepare(`INSERT INTO job_email_operations(idempotency_key,command,request_sha256,result_json) VALUES (?,?,?,?)`)
      .run(idempotencyKey, command, requestSha, stableJson(result));
    return result;
  }).immediate();
}

function recordCanonicalStatusEventIfAvailable(db, input) {
  if (!tableExists(db, 'application_status_events')) return;
  const columns = tableColumns(db, 'application_status_events');
  const requiredColumns = ['application_id', 'from_status', 'to_status', 'event_kind', 'source', 'source_ref', 'evidence_incomplete', 'occurred_at', 'idempotency_key'];
  if (!requiredColumns.every((column) => columns.has(column))) return;
  db.prepare(`
    INSERT OR IGNORE INTO application_status_events (
      application_id,from_status,to_status,event_kind,source,source_ref,evidence_incomplete,occurred_at,idempotency_key
    ) VALUES (?,?,?,'email_transition_applied','email_integration',?,?,datetime('now'),?)
  `).run(
    input.applicationId, input.fromStatus, input.toStatus, input.proposal.proposalId,
    input.evidenceIncomplete ? 1 : 0, `job-email-status:${input.proposal.proposalId}`
  );
}

function insertTransitionEvent(db, proposalId, eventKind, actor, notes, result) {
  db.prepare(`
    INSERT INTO job_email_transition_events(proposal_id,event_kind,actor,notes,result_json)
    VALUES (?,?,?,?,?)
  `).run(proposalId, eventKind, actor, notes, result ? stableJson(result) : null);
}

function insertReplyEvent(db, proposalId, eventKind, actor, notes) {
  db.prepare(`INSERT INTO job_email_reply_draft_events(proposal_id,event_kind,actor,notes) VALUES (?,?,?,?)`)
    .run(proposalId, eventKind, actor, notes);
}

function requireTransitionProposal(db, proposalId) {
  const proposal = db.prepare('SELECT * FROM job_email_transition_proposals WHERE proposal_id=?').get(proposalId);
  if (!proposal) throw new EmailIntegrationError('NOT_FOUND', `Transition proposal not found: ${proposalId}`);
  return proposal;
}

function latestTransitionEvent(db, proposalId) {
  return db.prepare('SELECT * FROM job_email_transition_events WHERE proposal_id=? ORDER BY id DESC LIMIT 1').get(proposalId);
}

function requireMessageRef(db, source, factsDigest) {
  const message = findMessageRef(db, source);
  if (!message) throw new EmailIntegrationError('MESSAGE_NOT_FOUND', 'Import email facts before recording derived proposals');
  if (message.facts_digest !== factsDigest) throw new EmailIntegrationError('FACTS_DIGEST_MISMATCH', 'Derived artifact facts digest does not match imported facts');
  if (message.thread_id !== source.threadId) throw new EmailIntegrationError('MESSAGE_CONFLICT', 'Thread ID differs from the imported message');
  return message;
}

function findMessageRef(db, source) {
  return db.prepare(`
    SELECT * FROM job_email_message_refs WHERE provider=? AND account_id=? AND message_id=?
  `).get(source.provider, source.accountId, source.messageId);
}

function requireInterviewForApplication(db, interviewId, applicationId) {
  const interview = db.prepare('SELECT * FROM interviews WHERE id=? AND application_id=?').get(interviewId, applicationId);
  if (!interview) throw new EmailIntegrationError('NOT_FOUND', `Interview ${interviewId} does not belong to application ${applicationId}`);
  return interview;
}

function assertStatusTransition(fromStatus, toStatus) {
  if (!STATUS_TRANSITIONS.get(fromStatus)?.has(toStatus)) {
    throw new EmailIntegrationError('INVALID_STATUS_TRANSITION', `Status may not move from ${fromStatus} to ${toStatus}`);
  }
}

function relationForAction(action) {
  if (action.kind === 'link_message') return action.relation;
  if (['create_interview', 'reschedule_interview', 'cancel_interview'].includes(action.kind)) return 'interview';
  if (action.kind === 'record_offer') return 'offer';
  if (action.kind === 'transition_application_status' && action.toStatus === 'rejected') return 'rejection';
  if (action.kind === 'record_requested_action') return 'action_required';
  return 'application_update';
}

function interviewProjection(interview) {
  return {
    id: interview.id,
    applicationId: interview.application_id,
    round: interview.round,
    scheduledAt: interview.scheduled_at,
    timezone: interview.timezone,
    format: interview.format,
    interviewer: interview.interviewer,
    outcome: interview.outcome,
    schedulingStatus: interview.scheduling_status,
    cancelledAt: interview.cancelled_at,
    cancellationReason: interview.cancellation_reason,
    lockVersion: interview.lock_version || 0
  };
}

function messageRefFromFacts(facts) {
  return {
    provider: facts.source.provider,
    accountId: facts.source.accountId,
    messageId: facts.source.messageId,
    threadId: facts.source.threadId
  };
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function tableColumns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function ensureColumn(db, table, column, definition) {
  if (!tableColumns(db, table).has(column)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

function createAppendOnlyTriggers(db, table) {
  db.exec(`
    CREATE TRIGGER ${table}_append_only_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
    CREATE TRIGGER ${table}_append_only_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
  `);
}

function readContractFile(value, label) {
  const filePath = path.resolve(required(value, label));
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new EmailIntegrationError('INVALID_INPUT', `${label} must identify a regular JSON file`);
  if (stat.size > MAX_INPUT_BYTES) throw new EmailIntegrationError('INPUT_TOO_LARGE', `${label} exceeds ${MAX_INPUT_BYTES} bytes`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { throw new EmailIntegrationError('INVALID_JSON', `${label} must contain valid JSON`); }
  return parsed;
}

function assertAllowedFlags(flags, schema, scope) {
  if (!schema) throw new EmailIntegrationError('UNKNOWN_COMMAND', `Unknown email integration command: ${scope}`);
  const allowed = new Set(schema);
  const unknown = Object.keys(flags).filter((key) => !allowed.has(key));
  if (unknown.length) throw new EmailIntegrationError('INVALID_ARGUMENT', `Unknown flag(s) for ${scope}: ${unknown.sort().join(', ')}`);
}

function boundedIdempotencyKey(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500 || /[\u0000-\u001f]/.test(value)) {
    throw new EmailIntegrationError('INVALID_ARGUMENT', '--idempotency-key must contain 1 to 500 printable characters');
  }
}

function commandResult(command, fields) {
  return { schemaVersion: 'job-email-command-result.v1', command, ...fields };
}

function dedupeRows(rows, key) {
  return [...new Map(rows.map((row) => [row[key], row])).values()];
}

function required(value, label) {
  if (value === undefined || value === null || value === '') throw new EmailIntegrationError('INVALID_ARGUMENT', `Missing required ${label}`);
  return String(value);
}

function nullable(value) {
  return value === undefined || value === '' ? null : String(value);
}

function enumInput(value, allowed, label) {
  const normalized = required(value, label);
  if (!allowed.has(normalized)) throw new EmailIntegrationError('INVALID_ARGUMENT', `${label} has an unsupported value`);
  return normalized;
}

function nonnegativeIntegerInput(value, label) {
  if (!/^(0|[1-9]\d*)$/.test(String(value))) throw new EmailIntegrationError('INVALID_ARGUMENT', `${label} must be a nonnegative integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new EmailIntegrationError('INVALID_ARGUMENT', `${label} is too large`);
  return number;
}

module.exports = {
  EMAIL_SCHEMA_VERSION,
  correlationRegistry,
  APPLICATION_EXTERNAL_IDENTIFIER_SCHEMA_VERSION,
  REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_MIGRATION_NAME,
  REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_SCHEMA_VERSION,
  EmailIntegrationError,
  migrateEmailIntegration,
  assertEmailCommandFlags,
  runEmailCommand,
  correlateEmailFileReadOnly,
  correlateEmailReadOnly,
  importFacts,
  recordCorrelation,
  resolveCorrelation,
  proposeTransition,
  proposeReplyDraft,
  reviewTransition,
  reviewReplyDraft,
  applyTransition,
  buildDraftReplyContext,
  issueDraftReplyRequest: (db, input) => issueDraftReplyRequest(db, input, idempotentOperation),
  recordDraftReplyResult: (db, rawInput, idempotencyKey, deps = {}) =>
    recordDraftReplyResult(db, rawInput, idempotencyKey, { proposeReplyDraft, idempotentOperation, ...deps }),
  approveDraftReplySend: (db, input, deps = {}) =>
    approveDraftReplySend(db, input, { reviewReplyDraft, idempotentOperation, ...deps }),
  correlateSendReceipt,
  issueOutgoingDraftRequest,
  recordOutgoingDraftResult,
  captureOutgoingDraftReceipt,
  readOutgoingReviewProjection,
  recordOutgoingReviewDecision,
  createOutgoingSendRequest,
  invalidateOutgoingApproval,
  correlateOutgoingSendReceipt,
  // Read-only lifecycle projection for the operator web surface (JT-4).
  readReplyLifecycleSummary,
  // Exposed for targeted tests that isolate the draft-reply machinery from the
  // separately-tested tone/voice/style binding in the reply state machine.
  idempotentOperation,
  // The digest record-correlation stores; the agent lane compares a live
  // result against it to decide whether an ambiguous record has grown stale.
  correlationDigest: digest
};
