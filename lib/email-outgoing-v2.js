'use strict';

// Provider-neutral outgoing-email persistence for the additive G03 lane.
//
// This module is deliberately effect-free: it stores and validates data, but
// has no mailbox, network, credential, native-draft, or send adapter. Private
// signing capability and public-key resolution are injected for the single
// operation that needs them and are never serialized.

const { types: utilTypes } = require('node:util');
const {
  NORMALIZATION_VERSION,
  approvalAttestationPayload,
  assertProposalContentProjection,
  copyInertData,
  digestCanonicalJson,
  digestUtf8Text,
  parseTime,
  publicKeyFingerprint,
  stableJson,
  validateApprovalReceiptV2,
  validateEmailApprovedContentV1,
  validateEmailDraftReceiptV1,
  validateEmailSendReceiptV2,
  validateEmailSendRequestV2,
  validateOutgoingV2Consistency,
  validateReplyDraftProposalV3,
  verifyApprovalAttestation
} = require('./email-outgoing-v2-contracts');
const { TEMPLATE_ID: CLARIFICATION_TEMPLATE_ID, questionFor } = require('./email-correlation/clarify-template');
const CLARIFICATION_RUNNER = 'clarification_template_in_process';

// Capture the exact built-ins used at the signer boundary before an injected
// callback can replace them. None of these predicates/getters traverses an
// untrusted prototype or invokes an own accessor.
const IS_PROXY = utilTypes.isProxy;
const IS_SHARED_ARRAY_BUFFER = utilTypes.isSharedArrayBuffer;
const GET_PROTOTYPE_OF = Object.getPrototypeOf;
const GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const OBJECT_FREEZE = Object.freeze;
const BUILTIN_BUFFER = Buffer;
const BUFFER_FROM = BUILTIN_BUFFER.from;
const BUFFER_ALLOC_UNSAFE = BUILTIN_BUFFER.allocUnsafe;
const BUILTIN_BUFFER_PROTOTYPE = BUILTIN_BUFFER.prototype;
const BUFFER_TO_STRING = BUILTIN_BUFFER_PROTOTYPE.toString;
const BUILTIN_UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
const TYPED_ARRAY_PROTOTYPE = GET_PROTOTYPE_OF(BUILTIN_UINT8_ARRAY_PROTOTYPE);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'byteLength').get;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'buffer').get;
const TYPED_ARRAY_KIND_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag).get;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BUFFER_PROTOTYPE_PROTOTYPE = GET_PROTOTYPE_OF(BUILTIN_BUFFER_PROTOTYPE);

// The exact prototype chain this module was loaded against. Node's own byte
// routines resolve `length` and `byteLength` through it, so a replacement is
// not a hostile value to reject but a hostile environment to refuse.
function assertRealmIntegrity() {
  if (GET_PROTOTYPE_OF(BUILTIN_UINT8_ARRAY_PROTOTYPE) !== TYPED_ARRAY_PROTOTYPE
    || BUFFER_PROTOTYPE_PROTOTYPE !== BUILTIN_UINT8_ARRAY_PROTOTYPE
    || GET_PROTOTYPE_OF(BUILTIN_BUFFER_PROTOTYPE) !== BUILTIN_UINT8_ARRAY_PROTOTYPE) {
    fail('SIGNING_FAILED', 'The typed-array prototype chain was replaced; refusing to handle key material');
  }
}

const EMAIL_OUTGOING_V2_SCHEMA_VERSION = 2026080101;
const EMAIL_OUTGOING_V2_MIGRATION_NAME = 'provider_neutral_email_outgoing_core';
const EMAIL_OUTGOING_V2_AUTHORITY_GUARDS_SCHEMA_VERSION = 2026080102;
const EMAIL_OUTGOING_V2_AUTHORITY_GUARDS_MIGRATION_NAME = 'provider_neutral_email_outgoing_authority_guards';
const INTERNAL_REQUEST_VERSION = 'jobtrack-email-reply-draft-request.v1';
const INTERNAL_RESULT_VERSION = 'jobtrack-email-reply-draft-result.v1';
const REVIEW_PROJECTION_VERSION = 'jobtrack-email-outgoing-review-projection.v1';
const REVIEW_DECISION_VERSION = 'jobtrack-email-outgoing-review-decision.v1';
const SEND_ISSUE_VERSION = 'jobtrack-email-send-request-issue.v1';
const INVALIDATION_VERSION = 'jobtrack-email-outgoing-invalidation.v1';
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const INVALIDATION_REASONS = new Set([
  'content_edited', 'regenerated', 'account_drift', 'recipient_drift', 'thread_drift',
  'generation_drift', 'manifest_drift', 'source_drift', 'expired',
  'idempotency_drift', 'operator_revoked'
]);

class EmailOutgoingV2Error extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'EmailOutgoingV2Error';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function migrateEmailOutgoingV2(db) {
  requireDatabase(db);
  const existing = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
    .get(EMAIL_OUTGOING_V2_SCHEMA_VERSION);
  if (existing && existing.name !== EMAIL_OUTGOING_V2_MIGRATION_NAME) {
    fail('MIGRATION_CONFLICT', `Schema version ${EMAIL_OUTGOING_V2_SCHEMA_VERSION} is already named ${existing.name}`);
  }
  const byName = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?')
    .get(EMAIL_OUTGOING_V2_MIGRATION_NAME);
  if (byName && byName.version !== EMAIL_OUTGOING_V2_SCHEMA_VERSION) {
    fail('MIGRATION_CONFLICT', `Migration ${EMAIL_OUTGOING_V2_MIGRATION_NAME} is already registered as ${byName.version}`);
  }
  if (existing) return;
  for (const dependency of ['job_email_message_refs', 'jobtrack_schema_migrations']) {
    if (!tableExists(db, dependency)) fail('SCHEMA_DEPENDENCY_MISSING', `Outgoing email migration requires ${dependency}`);
  }

  atomic(db, () => {
    db.exec(`
      CREATE TABLE job_email_outgoing_draft_requests (
        request_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        manifest_digest TEXT NOT NULL CHECK (length(manifest_digest)=64),
        source_state_sha256 TEXT NOT NULL CHECK (length(source_state_sha256)=64),
        request_json TEXT NOT NULL CHECK (json_valid(request_json)),
        request_digest TEXT NOT NULL CHECK (length(request_digest)=64),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(request_digest),
        CHECK (trim(provider)<>'' AND trim(account_id)<>'' AND trim(message_id)<>'' AND trim(thread_id)<>'')
      );

      CREATE TABLE job_email_outgoing_draft_results (
        result_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE REFERENCES job_email_outgoing_draft_requests(request_id) ON DELETE RESTRICT,
        request_digest TEXT NOT NULL CHECK (length(request_digest)=64),
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        result_digest TEXT NOT NULL UNIQUE CHECK (length(result_digest)=64),
        completed_at TEXT NOT NULL
      );

      CREATE TABLE job_email_outgoing_proposals_v3 (
        proposal_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE REFERENCES job_email_outgoing_draft_requests(request_id) ON DELETE RESTRICT,
        result_id TEXT NOT NULL UNIQUE REFERENCES job_email_outgoing_draft_results(result_id) ON DELETE RESTRICT,
        message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
        generation_id TEXT NOT NULL,
        manifest_digest TEXT NOT NULL CHECK (length(manifest_digest)=64),
        source_state_sha256 TEXT NOT NULL CHECK (length(source_state_sha256)=64),
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
        proposal_digest TEXT NOT NULL UNIQUE CHECK (length(proposal_digest)=64),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE job_email_approved_contents_v1 (
        content_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL UNIQUE REFERENCES job_email_outgoing_proposals_v3(proposal_id) ON DELETE RESTRICT,
        generation_id TEXT NOT NULL,
        manifest_digest TEXT NOT NULL CHECK (length(manifest_digest)=64),
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        content_json TEXT NOT NULL CHECK (json_valid(content_json)),
        content_digest TEXT NOT NULL UNIQUE CHECK (length(content_digest)=64),
        created_at TEXT NOT NULL
      );

      CREATE TABLE job_email_draft_receipts_v1 (
        receipt_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL UNIQUE REFERENCES job_email_outgoing_proposals_v3(proposal_id) ON DELETE RESTRICT,
        content_id TEXT NOT NULL UNIQUE REFERENCES job_email_approved_contents_v1(content_id) ON DELETE RESTRICT,
        receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
        receipt_digest TEXT NOT NULL UNIQUE CHECK (length(receipt_digest)=64),
        provider_draft_id TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );

      CREATE TABLE job_email_outgoing_review_events (
        review_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL REFERENCES job_email_outgoing_proposals_v3(proposal_id) ON DELETE RESTRICT,
        content_id TEXT NOT NULL REFERENCES job_email_approved_contents_v1(content_id) ON DELETE RESTRICT,
        draft_receipt_id TEXT REFERENCES job_email_draft_receipts_v1(receipt_id) ON DELETE RESTRICT,
        decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
        approver_id TEXT NOT NULL,
        review_projection_digest TEXT NOT NULL CHECK (length(review_projection_digest)=64),
        approved_content_digest TEXT NOT NULL CHECK (length(approved_content_digest)=64),
        authenticated_channel_digest TEXT NOT NULL CHECK (length(authenticated_channel_digest)=64),
        decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
        decision_digest TEXT NOT NULL UNIQUE CHECK (length(decision_digest)=64),
        operation_idempotency_key TEXT NOT NULL UNIQUE,
        decided_at TEXT NOT NULL,
        CHECK ((decision='approve' AND draft_receipt_id IS NOT NULL) OR decision='reject')
      );

      CREATE TABLE job_email_approval_receipts_v2 (
        approval_id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL UNIQUE REFERENCES job_email_outgoing_review_events(review_id) ON DELETE RESTRICT,
        proposal_id TEXT NOT NULL UNIQUE REFERENCES job_email_outgoing_proposals_v3(proposal_id) ON DELETE RESTRICT,
        content_id TEXT NOT NULL UNIQUE REFERENCES job_email_approved_contents_v1(content_id) ON DELETE RESTRICT,
        approval_json TEXT NOT NULL CHECK (json_valid(approval_json)),
        approval_digest TEXT NOT NULL UNIQUE CHECK (length(approval_digest)=64),
        one_send_idempotency_key TEXT NOT NULL UNIQUE,
        key_id TEXT NOT NULL,
        public_key_sha256 TEXT NOT NULL CHECK (length(public_key_sha256)=64),
        signer_identity TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE job_email_outgoing_invalidation_events (
        invalidation_id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL REFERENCES job_email_approval_receipts_v2(approval_id) ON DELETE RESTRICT,
        proposal_id TEXT NOT NULL REFERENCES job_email_outgoing_proposals_v3(proposal_id) ON DELETE RESTRICT,
        replacement_proposal_id TEXT REFERENCES job_email_outgoing_proposals_v3(proposal_id) ON DELETE RESTRICT,
        reason TEXT NOT NULL CHECK (reason IN (
          'content_edited','regenerated','account_drift','recipient_drift','thread_drift',
          'generation_drift','manifest_drift','source_drift','expired','idempotency_drift','operator_revoked'
        )),
        invalidation_json TEXT NOT NULL CHECK (json_valid(invalidation_json)),
        invalidation_digest TEXT NOT NULL UNIQUE CHECK (length(invalidation_digest)=64),
        invalidated_at TEXT NOT NULL,
        UNIQUE(approval_id,reason,replacement_proposal_id)
      );

      CREATE TABLE job_email_send_requests_v2 (
        request_id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL UNIQUE REFERENCES job_email_approval_receipts_v2(approval_id) ON DELETE RESTRICT,
        proposal_id TEXT NOT NULL UNIQUE REFERENCES job_email_outgoing_proposals_v3(proposal_id) ON DELETE RESTRICT,
        content_id TEXT NOT NULL UNIQUE REFERENCES job_email_approved_contents_v1(content_id) ON DELETE RESTRICT,
        request_json TEXT NOT NULL CHECK (json_valid(request_json)),
        request_digest TEXT NOT NULL UNIQUE CHECK (length(request_digest)=64),
        one_send_idempotency_key TEXT NOT NULL UNIQUE,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE job_email_send_receipt_correlations_v2 (
        receipt_id TEXT PRIMARY KEY,
        send_request_id TEXT NOT NULL REFERENCES job_email_send_requests_v2(request_id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('sent','duplicate','failed','indeterminate')),
        classification TEXT NOT NULL CHECK (classification IN ('applied','unapplied','indeterminate')),
        receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
        receipt_digest TEXT NOT NULL UNIQUE CHECK (length(receipt_digest)=64),
        native_key_id TEXT NOT NULL,
        native_public_key_sha256 TEXT NOT NULL CHECK (length(native_public_key_sha256)=64),
        observed_at TEXT NOT NULL,
        UNIQUE(send_request_id,attempt_id,receipt_digest)
      );

      CREATE TABLE job_email_outgoing_operations (
        idempotency_key TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK (length(request_digest)=64),
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        result_digest TEXT NOT NULL CHECK (length(result_digest)=64),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE INDEX idx_job_email_outgoing_source
        ON job_email_outgoing_proposals_v3(provider,account_id,message_id,thread_id,created_at DESC);
      CREATE INDEX idx_job_email_outgoing_review_proposal
        ON job_email_outgoing_review_events(proposal_id,decided_at DESC);
      CREATE INDEX idx_job_email_outgoing_invalidation_approval
        ON job_email_outgoing_invalidation_events(approval_id,invalidated_at DESC);
      CREATE INDEX idx_job_email_outgoing_receipt_request
        ON job_email_send_receipt_correlations_v2(send_request_id,observed_at,receipt_id);

      CREATE TRIGGER job_email_outgoing_review_approve_requires_draft
      BEFORE INSERT ON job_email_outgoing_review_events
      WHEN NEW.decision='approve'
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM job_email_draft_receipts_v1 receipt
          JOIN job_email_approved_contents_v1 content ON content.content_id=receipt.content_id
          WHERE receipt.receipt_id=NEW.draft_receipt_id
            AND receipt.proposal_id=NEW.proposal_id
            AND content.content_id=NEW.content_id
            AND content.content_digest=NEW.approved_content_digest
        ) THEN RAISE(ABORT, 'positive review requires exact captured draft receipt') END;
      END;

      CREATE TRIGGER job_email_outgoing_approval_requires_positive_review
      BEFORE INSERT ON job_email_approval_receipts_v2
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM job_email_outgoing_review_events review
          WHERE review.review_id=NEW.review_id
            AND review.decision='approve'
            AND review.proposal_id=NEW.proposal_id
            AND review.content_id=NEW.content_id
        ) THEN RAISE(ABORT, 'approval receipt requires positive review event') END;
      END;

      CREATE TRIGGER job_email_outgoing_send_request_requires_current_approval
      BEFORE INSERT ON job_email_send_requests_v2
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM job_email_approval_receipts_v2 approval
          WHERE approval.approval_id=NEW.approval_id
            AND approval.proposal_id=NEW.proposal_id
            AND approval.content_id=NEW.content_id
            AND approval.one_send_idempotency_key=NEW.one_send_idempotency_key
        ) THEN RAISE(ABORT, 'send request requires exact approval receipt') END;
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM job_email_outgoing_invalidation_events invalidation
          WHERE invalidation.approval_id=NEW.approval_id
        ) THEN RAISE(ABORT, 'send request approval is invalidated') END;
      END;
    `);
    for (const table of [
      'job_email_outgoing_draft_requests', 'job_email_outgoing_draft_results',
      'job_email_outgoing_proposals_v3', 'job_email_approved_contents_v1',
      'job_email_draft_receipts_v1', 'job_email_outgoing_review_events',
      'job_email_approval_receipts_v2', 'job_email_outgoing_invalidation_events',
      'job_email_send_requests_v2', 'job_email_send_receipt_correlations_v2',
      'job_email_outgoing_operations'
    ]) createAppendOnlyTriggers(db, table);
    db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)')
      .run(EMAIL_OUTGOING_V2_SCHEMA_VERSION, EMAIL_OUTGOING_V2_MIGRATION_NAME);
  });
}

// Additive successor to the frozen 2026080101 migration. These constraints are
// deliberately encoded in SQLite as well as in the JavaScript command layer:
// injected dependency callbacks may re-enter the same connection inside the
// outer transaction, so a pre-callback JS snapshot is not an authority lock.
function migrateEmailOutgoingV2AuthorityGuards(db) {
  requireDatabase(db);
  const existing = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
    .get(EMAIL_OUTGOING_V2_AUTHORITY_GUARDS_SCHEMA_VERSION);
  if (existing && existing.name !== EMAIL_OUTGOING_V2_AUTHORITY_GUARDS_MIGRATION_NAME) {
    fail('MIGRATION_CONFLICT', `Schema version ${EMAIL_OUTGOING_V2_AUTHORITY_GUARDS_SCHEMA_VERSION} is already named ${existing.name}`);
  }
  const byName = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?')
    .get(EMAIL_OUTGOING_V2_AUTHORITY_GUARDS_MIGRATION_NAME);
  if (byName && byName.version !== EMAIL_OUTGOING_V2_AUTHORITY_GUARDS_SCHEMA_VERSION) {
    fail('MIGRATION_CONFLICT', `Migration ${EMAIL_OUTGOING_V2_AUTHORITY_GUARDS_MIGRATION_NAME} is already registered as ${byName.version}`);
  }
  if (existing) return;
  for (const dependency of [
    'job_email_outgoing_review_events',
    'job_email_approval_receipts_v2',
    'job_email_send_receipt_correlations_v2',
    'jobtrack_schema_migrations'
  ]) {
    if (!tableExists(db, dependency)) fail('SCHEMA_DEPENDENCY_MISSING', `Outgoing authority-guard migration requires ${dependency}`);
  }

  atomic(db, () => {
    const duplicateReview = db.prepare(`SELECT proposal_id,count(*) AS count
      FROM job_email_outgoing_review_events GROUP BY proposal_id HAVING count(*)>1 LIMIT 1`).get();
    if (duplicateReview) {
      fail('MIGRATION_STATE_CONFLICT', `Proposal ${duplicateReview.proposal_id} already has ${duplicateReview.count} terminal reviews`);
    }
    for (const request of db.prepare(`SELECT DISTINCT send_request_id
      FROM job_email_send_receipt_correlations_v2 ORDER BY send_request_id`).all()) {
      const rows = receiptStateRows(db, request.send_request_id);
      assertStoredReceiptHistory(rows, request.send_request_id);
    }

    db.exec(`
      CREATE UNIQUE INDEX uq_job_email_outgoing_terminal_review_proposal
        ON job_email_outgoing_review_events(proposal_id);

      CREATE TRIGGER job_email_outgoing_receipt_attempt_transition_guard
      BEFORE INSERT ON job_email_send_receipt_correlations_v2
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM job_email_send_receipt_correlations_v2 prior
          WHERE prior.send_request_id=NEW.send_request_id
            AND prior.attempt_id<>NEW.attempt_id
        ) THEN RAISE(ABORT, 'one-send request cannot introduce a second attempt') END;

        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM job_email_send_receipt_correlations_v2 prior
          WHERE prior.send_request_id=NEW.send_request_id
        ) AND NEW.outcome='duplicate'
        THEN RAISE(ABORT, 'duplicate receipt requires prior sent evidence') END;

        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM job_email_send_receipt_correlations_v2 prior
          WHERE prior.send_request_id=NEW.send_request_id
        ) AND NOT (
          (
            NEW.outcome IN ('sent','failed')
            AND (SELECT count(*) FROM job_email_send_receipt_correlations_v2 prior
                 WHERE prior.send_request_id=NEW.send_request_id)=1
            AND EXISTS (
              SELECT 1 FROM job_email_send_receipt_correlations_v2 prior
              WHERE prior.send_request_id=NEW.send_request_id
                AND prior.attempt_id=NEW.attempt_id
                AND prior.outcome='indeterminate'
            )
          ) OR (
            NEW.outcome='duplicate'
            AND NOT EXISTS (
              SELECT 1 FROM job_email_send_receipt_correlations_v2 prior
              WHERE prior.send_request_id=NEW.send_request_id
                AND prior.outcome IN ('failed','duplicate')
            )
            AND EXISTS (
              SELECT 1 FROM job_email_send_receipt_correlations_v2 prior
              WHERE prior.send_request_id=NEW.send_request_id
                AND prior.attempt_id=NEW.attempt_id
                AND prior.outcome='sent'
                AND prior.receipt_id=json_extract(NEW.receipt_json,'$.duplicateOfReceiptId')
                AND prior.receipt_digest=json_extract(NEW.receipt_json,'$.priorAppliedReceiptDigest')
            )
          )
        ) THEN RAISE(ABORT, 'receipt attempt transition is not admitted') END;
      END;

      CREATE TRIGGER job_email_outgoing_approval_requires_sole_terminal_review
      BEFORE INSERT ON job_email_approval_receipts_v2
      BEGIN
        SELECT CASE WHEN (
          SELECT count(*) FROM job_email_outgoing_review_events review
          WHERE review.proposal_id=NEW.proposal_id
        )<>1 THEN RAISE(ABORT, 'approval requires exactly one terminal review') END;
      END;
    `);
    db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)')
      .run(
        EMAIL_OUTGOING_V2_AUTHORITY_GUARDS_SCHEMA_VERSION,
        EMAIL_OUTGOING_V2_AUTHORITY_GUARDS_MIGRATION_NAME
      );
  });
}

function issueDraftRequest(db, rawInput) {
  return issueDraftRequestWithExecution(db, rawInput, {
    kind: 'standalone_out_of_process', processIsolation: 'required',
    toolAccess: 'none', networkAccess: 'none', credentialAccess: 'none'
  });
}

// Closed, fixed-template path only. External authored/model results continue to
// require the existing standalone runner; no public execution-mode flag exists.
function issueClarificationDraftRequest(db, rawInput, rawTemplate) {
  const input = validateDraftIssueInput(rawInput);
  const template = plainInput(rawTemplate, 'clarification template',
    ['titles', 'applicantName', 'reference'], ['titles', 'applicantName', 'reference']);
  if (!Array.isArray(template.titles) || template.titles.length < 2 || template.titles.length > 50) {
    fail('INVALID_INPUT', 'clarification template needs 2 to 50 titles');
  }
  template.titles.forEach((title) => assertSafeString(title, 'clarification title', 500));
  assertSafeString(template.applicantName, 'applicantName', 500);
  if (template.reference !== null && !/^[A-Z]{2,6}-[0-9A-Z]{3,12}$/.test(template.reference)) {
    fail('INVALID_INPUT', 'clarification reference must be a normalized bracket code or null');
  }
  if (input.manifestDigest !== digestUtf8Text(CLARIFICATION_TEMPLATE_ID)) {
    fail('INVALID_INPUT', 'clarification manifest must bind the shipped fixed template');
  }
  return issueDraftRequestWithExecution(db, input, {
    kind: CLARIFICATION_RUNNER, processIsolation: 'in_process',
    templateId: CLARIFICATION_TEMPLATE_ID, templateParameters: template,
    bodyDigest: digestUtf8Text(questionFor(template.titles, template.applicantName, template.reference)),
    toolAccess: 'none', networkAccess: 'none', credentialAccess: 'none'
  });
}

function issueDraftRequestWithExecution(db, rawInput, execution) {
  const input = validateDraftIssueInput(rawInput);
  const message = requireSourceMessage(db, input.source);
  const facts = parseStoredJson(message.facts_json, 'stored email facts');
  const recipient = String(message.reply_to_address || message.from_address).toLowerCase();
  if (input.source.replyToAddress !== recipient) fail('RECIPIENT_MISMATCH', 'Reply recipient differs from the imported source message');
  if (input.delivery.accountId !== message.account_id) fail('ACCOUNT_MISMATCH', 'Delivery account differs from the imported source account');
  const source = {
    provider: message.provider,
    accountId: message.account_id,
    messageId: message.message_id,
    threadId: message.thread_id,
    replyToAddress: recipient,
    inReplyTo: input.source.inReplyTo,
    references: input.source.references
  };
  const sourceState = {
    schemaVersion: 'jobtrack-email-draft-source-state.v1',
    facts,
    factsDigest: message.facts_digest,
    source,
    delivery: { ...input.delivery, sendFidelity: 'content_equivalent' },
    generationId: input.generationId,
    manifestDigest: input.manifestDigest,
    toneDecisionId: input.toneDecisionId,
    toneDecisionDigest: input.toneDecisionDigest,
    voiceRevisionId: input.voiceRevisionId,
    voiceRevisionDigest: input.voiceRevisionDigest,
    ...(input.styleProfileId ? {
      styleProfileId: input.styleProfileId,
      styleProfileDigest: input.styleProfileDigest
    } : {})
  };
  const sourceStateSha256 = digestCanonicalJson(sourceState);
  const request = copyInertData({
    schemaVersion: INTERNAL_REQUEST_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    requestId: input.requestId,
    generationId: input.generationId,
    manifestDigest: input.manifestDigest,
    factsDigest: message.facts_digest,
    source,
    delivery: { ...input.delivery, sendFidelity: 'content_equivalent' },
    toneDecisionId: input.toneDecisionId,
    toneDecisionDigest: input.toneDecisionDigest,
    voiceRevisionId: input.voiceRevisionId,
    voiceRevisionDigest: input.voiceRevisionDigest,
    ...(input.styleProfileId ? {
      styleProfileId: input.styleProfileId,
      styleProfileDigest: input.styleProfileDigest
    } : {}),
    sourceStateSha256,
    expiresAt: input.expiresAt,
    context: {
      trust: facts.trust,
      contentCompleteness: facts.contentCompleteness,
      eventKind: facts.eventKind,
      evidence: facts.evidence,
      security: facts.security
    },
    outputContracts: {
      proposal: 'email-reply-draft-proposal.v3',
      approvedContent: 'email-approved-content.v1'
    },
    execution,
    effects: { mailboxRead: false, nativeDraft: false, send: false },
    requiresReview: true,
    autoSendEligible: false
  }, 'draft request');
  const requestDigest = digestCanonicalJson(request);
  const operationInput = execution.kind === CLARIFICATION_RUNNER ? { ...input, execution } : input;
  return idempotentWrite(db, 'outgoing-draft-issue', input.idempotencyKey, operationInput, () => {
    const byId = db.prepare('SELECT request_digest,request_json FROM job_email_outgoing_draft_requests WHERE request_id=?')
      .get(input.requestId);
    if (byId) {
      if (byId.request_digest !== requestDigest) fail('REQUEST_CONFLICT', 'Draft request ID is already bound to different content');
      return result('outgoing-draft-issue', { request, requestDigest, reused: true });
    }
    db.prepare(`
      INSERT INTO job_email_outgoing_draft_requests(
        request_id,idempotency_key,message_ref_id,provider,account_id,message_id,thread_id,
        generation_id,manifest_digest,source_state_sha256,request_json,request_digest
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      input.requestId, input.idempotencyKey, message.id, message.provider, message.account_id,
      message.message_id, message.thread_id, input.generationId, input.manifestDigest,
      sourceStateSha256, stableJson(request), requestDigest
    );
    return result('outgoing-draft-issue', { request, requestDigest, reused: false });
  });
}

function recordDraftResult(db, rawInput, deps = {}) {
  return recordDraftResultWithRunner(db, rawInput, deps, 'standalone_out_of_process');
}

function recordClarificationDraftResult(db, rawInput, deps = {}) {
  return recordDraftResultWithRunner(db, rawInput, deps, CLARIFICATION_RUNNER);
}

function recordDraftResultWithRunner(db, rawInput, deps, runner) {
  const input = validateDraftResult(rawInput, runner);
  const dependency = snapshotFailpoint(deps);
  return idempotentWrite(db, 'outgoing-draft-record', input.idempotencyKey, input, () => {
    const storedRequest = db.prepare('SELECT * FROM job_email_outgoing_draft_requests WHERE request_id=?')
      .get(input.requestId);
    if (!storedRequest) fail('REQUEST_NOT_FOUND', `Draft request not found: ${input.requestId}`);
    if (storedRequest.request_digest !== input.requestDigest) fail('REQUEST_DIGEST_MISMATCH', 'Draft result does not bind the stored request digest');
    const request = parseStoredJson(storedRequest.request_json, 'stored draft request');
    assertDraftResultBindings(request, input);
    const currentMessage = db.prepare('SELECT * FROM job_email_message_refs WHERE id=?').get(storedRequest.message_ref_id);
    if (!currentMessage || currentMessage.facts_digest !== request.factsDigest) {
      fail('SOURCE_STATE_STALE', 'Imported source facts no longer match the draft request');
    }
    const proposalDigest = digestCanonicalJson(input.proposal);
    const contentDigest = digestCanonicalJson(input.approvedContent);
    const resultDocument = copyInertData({
      schemaVersion: INTERNAL_RESULT_VERSION,
      resultId: input.resultId,
      requestId: input.requestId,
      requestDigest: input.requestDigest,
      proposal: input.proposal,
      approvedContent: input.approvedContent,
      usage: input.usage,
      completedAt: input.completedAt
    }, 'draft result document');
    const resultDigest = digestCanonicalJson(resultDocument);
    const existing = db.prepare('SELECT result_digest,result_json FROM job_email_outgoing_draft_results WHERE result_id=? OR request_id=?')
      .get(input.resultId, input.requestId);
    if (existing) {
      if (existing.result_digest !== resultDigest) fail('RESULT_CONFLICT', 'Draft request or result ID is already bound to different content');
      return result('outgoing-draft-record', {
        resultId: input.resultId,
        resultDigest,
        proposalId: input.proposal.proposalId,
        proposalDigest,
        contentId: input.approvedContent.contentId,
        approvedContentDigest: contentDigest,
        reused: true
      });
    }
    db.prepare(`INSERT INTO job_email_outgoing_draft_results(
      result_id,request_id,request_digest,result_json,result_digest,completed_at
    ) VALUES (?,?,?,?,?,?)`).run(
      input.resultId, input.requestId, input.requestDigest, stableJson(resultDocument), resultDigest, input.completedAt
    );
    dependency.failpoint('after-result-insert');
    db.prepare(`INSERT INTO job_email_outgoing_proposals_v3(
      proposal_id,request_id,result_id,message_ref_id,generation_id,manifest_digest,
      source_state_sha256,provider,account_id,message_id,thread_id,recipient,
      proposal_json,proposal_digest,expires_at,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.proposal.proposalId, input.requestId, input.resultId, storedRequest.message_ref_id,
      input.proposal.generationId, input.proposal.manifestDigest, input.proposal.sourceStateSha256,
      input.proposal.source.provider, input.proposal.source.accountId, input.proposal.source.messageId,
      input.proposal.source.threadId, input.proposal.recipient, stableJson(input.proposal),
      proposalDigest, input.proposal.expiresAt, input.approvedContent.createdAt
    );
    db.prepare(`INSERT INTO job_email_approved_contents_v1(
      content_id,proposal_id,generation_id,manifest_digest,provider,account_id,recipient,
      thread_id,content_json,content_digest,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.approvedContent.contentId, input.proposal.proposalId, input.approvedContent.generationId,
      input.approvedContent.manifestDigest, input.approvedContent.provider,
      input.approvedContent.accountId, input.approvedContent.recipient,
      input.approvedContent.thread.threadId, stableJson(input.approvedContent), contentDigest,
      input.approvedContent.createdAt
    );
    dependency.failpoint('after-proposal-content-insert');
    invalidateReplacedApprovals(db, input.proposal, input.completedAt);
    return result('outgoing-draft-record', {
      resultId: input.resultId,
      resultDigest,
      proposalId: input.proposal.proposalId,
      proposalDigest,
      contentId: input.approvedContent.contentId,
      approvedContentDigest: contentDigest,
      reused: false
    });
  });
}

function captureDraftReceipt(db, rawInput) {
  const input = validateCaptureInput(rawInput);
  const receipt = validateEmailDraftReceiptV1(input.receipt);
  const receiptDigest = digestCanonicalJson(receipt);
  return idempotentWrite(db, 'outgoing-draft-receipt', input.idempotencyKey, input, () => {
    const artifacts = loadProposalArtifacts(db, receipt.draftProposalId);
    const proposalDigest = digestCanonicalJson(artifacts.proposal);
    const contentDigest = digestCanonicalJson(artifacts.content);
    const mismatches = [];
    compare(receipt.draftProposalDigest, proposalDigest, 'proposalDigest', mismatches);
    compare(receipt.contentDigest, contentDigest, 'contentDigest', mismatches);
    compare(receipt.generationId, artifacts.content.generationId, 'generationId', mismatches);
    compare(receipt.manifestDigest, artifacts.content.manifestDigest, 'manifestDigest', mismatches);
    compare(receipt.provider, artifacts.content.provider, 'provider', mismatches);
    compare(receipt.accountId, artifacts.content.accountId, 'accountId', mismatches);
    compare(receipt.recipient, artifacts.content.recipient, 'recipient', mismatches);
    compare(receipt.threadId, artifacts.content.thread.threadId, 'threadId', mismatches);
    if (!(parseTime(artifacts.content.createdAt) <= parseTime(receipt.observedAt)
      && parseTime(receipt.observedAt) < parseTime(artifacts.proposal.expiresAt))) {
      mismatches.push('chronology');
    }
    if (mismatches.length) fail('DRAFT_RECEIPT_MISMATCH', 'Captured draft receipt does not match immutable proposal/content', { mismatches });
    const existing = db.prepare('SELECT receipt_digest FROM job_email_draft_receipts_v1 WHERE receipt_id=? OR proposal_id=?')
      .get(receipt.receiptId, receipt.draftProposalId);
    if (existing) {
      if (existing.receipt_digest !== receiptDigest) fail('DRAFT_RECEIPT_CONFLICT', 'Draft receipt or proposal already has different capture evidence');
      return result('outgoing-draft-receipt', { receipt, receiptDigest, reused: true, transmission: 'not_sent' });
    }
    db.prepare(`INSERT INTO job_email_draft_receipts_v1(
      receipt_id,proposal_id,content_id,receipt_json,receipt_digest,provider_draft_id,observed_at
    ) VALUES (?,?,?,?,?,?,?)`).run(
      receipt.receiptId, artifacts.proposal.proposalId, artifacts.content.contentId,
      stableJson(receipt), receiptDigest, receipt.providerDraftId, receipt.observedAt
    );
    return result('outgoing-draft-receipt', { receipt, receiptDigest, reused: false, transmission: 'not_sent' });
  });
}

function readReviewProjection(db, proposalId, options = {}) {
  assertId(proposalId, 'proposalId');
  const clockFields = dependencyObject(options, 'review projection options', ['now'], []);
  const observeNow = clockFields.now === undefined
    ? () => new Date().toISOString()
    : snapshotPlainFunction(clockFields.now, 'review projection clock');
  let observedNow;
  try { observedNow = observeNow(); }
  catch { fail('CLOCK_UNAVAILABLE', 'Review projection clock failed'); }
  assertDateTime(observedNow, 'observed review projection time');
  const artifacts = loadProposalArtifacts(db, proposalId);
  const receiptRow = db.prepare('SELECT * FROM job_email_draft_receipts_v1 WHERE proposal_id=?').get(proposalId);
  const latestReview = db.prepare(`SELECT decision,approver_id,decision_digest,decided_at
    FROM job_email_outgoing_review_events WHERE proposal_id=? ORDER BY decided_at DESC,review_id DESC LIMIT 1`).get(proposalId);
  const approvalRow = db.prepare('SELECT approval_id,approval_digest,expires_at FROM job_email_approval_receipts_v2 WHERE proposal_id=?').get(proposalId);
  const invalidations = approvalRow
    ? db.prepare(`SELECT invalidation_id,reason,invalidation_digest,invalidated_at,replacement_proposal_id AS replacementProposalId
        FROM job_email_outgoing_invalidation_events WHERE approval_id=? ORDER BY invalidated_at,invalidation_id`).all(approvalRow.approval_id)
      .map((row) => ({
        invalidationId: row.invalidation_id,
        reason: row.reason,
        invalidationDigest: row.invalidation_digest,
        invalidatedAt: row.invalidated_at,
        ...(row.replacementProposalId ? { replacementProposalId: row.replacementProposalId } : {})
      }))
    : [];
  const draftReceipt = receiptRow ? parseStoredJson(receiptRow.receipt_json, 'stored draft receipt') : null;
  const latestProposal = latestProposalForSource(db, artifacts.proposal);
  const sourceCurrent = proposalSourceIsCurrent(db, artifacts.proposal);
  const proposalCurrent = parseTime(observedNow) < parseTime(artifacts.proposal.expiresAt);
  const unsigned = copyInertData({
    schemaVersion: REVIEW_PROJECTION_VERSION,
    proposal: artifacts.proposal,
    proposalDigest: digestCanonicalJson(artifacts.proposal),
    approvedContent: artifacts.content,
    approvedContentDigest: digestCanonicalJson(artifacts.content),
    draftReceipt,
    draftReceiptDigest: draftReceipt ? digestCanonicalJson(draftReceipt) : null,
    latestReview: latestReview ? {
      decision: latestReview.decision,
      approverId: latestReview.approver_id,
      decisionDigest: latestReview.decision_digest,
      decidedAt: latestReview.decided_at
    } : null,
    approval: approvalRow ? {
      approvalId: approvalRow.approval_id,
      approvalDigest: approvalRow.approval_digest,
      expiresAt: approvalRow.expires_at
    } : null,
    invalidations,
    canApprove: Boolean(
      draftReceipt && !latestReview && !approvalRow && sourceCurrent && proposalCurrent
      && latestProposal?.proposal_id === proposalId
    )
  }, 'review projection');
  return copyInertData({ ...unsigned, projectionDigest: digestCanonicalJson(unsigned) }, 'review projection');
}

function recordReviewDecision(db, rawInput, deps = {}) {
  const input = validateReviewInput(rawInput);
  const settings = snapshotReviewDependencies(deps, input.decision);
  return idempotentWrite(db, 'outgoing-review-record', input.operationIdempotencyKey, input, () => {
    const initialNow = observeAuthorityClock(settings.now, 'Review decision');
    const projection = readReviewProjection(db, input.proposalId, { now: () => initialNow });
    assertReviewProjectionMatchesInDatabase(db, input, projection, initialNow);
    const channelContext = copyInertData({
      schemaVersion: 'jobtrack-email-authenticated-review-context.v1',
      reviewId: input.reviewId,
      proposalId: input.proposalId,
      decision: input.decision,
      approver: input.approver,
      decidedAt: input.decidedAt,
      expectedProjectionDigest: input.expectedProjectionDigest,
      expectedApprovedContentDigest: input.expectedApprovedContentDigest,
      ...(input.approval ? { approvalIntent: input.approval } : {}),
      ...(input.reason ? { rejectionReason: input.reason } : {})
    }, 'authenticated review context');
    let verified;
    try { verified = settings.channelVerify(input.authenticatedChannel, channelContext); }
    catch { fail('CHANNEL_AUTHENTICATION_FAILED', 'Authenticated review channel verification failed'); }
    if (verified !== true) fail('CHANNEL_AUTHENTICATION_FAILED', 'Authenticated review channel did not verify the human decision');

    // The channel is untrusted and explicitly re-entrant. Linearize the clock
    // after it returns, then regenerate the exact projection from the database
    // immediately before the sole terminal-review insert.
    const reviewLinearizedAt = observeAuthorityClock(settings.now, 'Review decision');
    const currentProjection = readReviewProjection(db, input.proposalId, { now: () => reviewLinearizedAt });
    assertReviewProjectionMatchesInDatabase(db, input, currentProjection, reviewLinearizedAt);

    const decisionDocument = copyInertData({
      schemaVersion: REVIEW_DECISION_VERSION,
      reviewId: input.reviewId,
      proposalId: input.proposalId,
      decision: input.decision,
      approver: input.approver,
      decidedAt: input.decidedAt,
      expectedProjectionDigest: input.expectedProjectionDigest,
      expectedApprovedContentDigest: input.expectedApprovedContentDigest,
      authenticatedChannel: input.authenticatedChannel,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.approval ? { approvalIntent: input.approval } : {})
    }, 'review decision');
    const decisionDigest = digestCanonicalJson(decisionDocument);
    const channelDigest = digestCanonicalJson(input.authenticatedChannel);
    const draftReceiptId = input.decision === 'approve' ? currentProjection.draftReceipt.receiptId : null;
    db.prepare(`INSERT INTO job_email_outgoing_review_events(
      review_id,proposal_id,content_id,draft_receipt_id,decision,approver_id,
      review_projection_digest,approved_content_digest,authenticated_channel_digest,
      decision_json,decision_digest,operation_idempotency_key,decided_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.reviewId, input.proposalId, currentProjection.approvedContent.contentId, draftReceiptId,
      input.decision, input.approver.id, input.expectedProjectionDigest,
      input.expectedApprovedContentDigest, channelDigest, stableJson(decisionDocument), decisionDigest,
      input.operationIdempotencyKey, input.decidedAt
    );
    settings.failpoint('after-review-event-insert');
    if (input.decision === 'reject') {
      return result('outgoing-review-record', {
        reviewId: input.reviewId,
        decision: 'reject',
        decisionDigest,
        approvalReceipt: null,
        sendAuthority: false,
        reused: false
      });
    }

    assertSolePositiveReview(db, input, currentProjection);
    assertPositiveReviewCurrent(db, currentProjection, reviewLinearizedAt);

    const content = currentProjection.approvedContent;
    const unsignedApproval = copyInertData({
      schemaVersion: 'approval-receipt.v2',
      normalizationVersion: NORMALIZATION_VERSION,
      approvalId: input.approval.approvalId,
      decision: 'approve',
      idempotencyKey: input.approval.idempotencyKey,
      generationId: content.generationId,
      manifestDigest: content.manifestDigest,
      approvedContentContractId: 'email-approved-content.v1',
      approvedContentDigest: currentProjection.approvedContentDigest,
      approver: input.approver,
      // This is the authenticated human decision time, not a stale callback
      // observation. Every later callback is followed by a fresh expiry check.
      approvedAt: input.decidedAt,
      expiresAt: input.approval.expiresAt,
      scope: {
        action: 'send-once',
        maximumSends: 1,
        sendFidelity: 'content_equivalent',
        provider: content.provider,
        accountId: content.accountId,
        recipient: content.recipient,
        threadId: content.thread.threadId
      },
      authenticatedChannel: input.authenticatedChannel
    }, 'unsigned approval');
    if (!(parseTime(input.decidedAt) < parseTime(input.approval.expiresAt)
      && parseTime(reviewLinearizedAt) < parseTime(input.approval.expiresAt)
      && parseTime(input.approval.expiresAt) <= parseTime(currentProjection.proposal.expiresAt))) {
      fail('APPROVAL_EXPIRY_INVALID', 'Approval expiry must be after the decision and no later than proposal expiry');
    }
    const payloadDigest = digestCanonicalJson(unsignedApproval);
    const signingBytes = REFLECT_APPLY(BUFFER_FROM, BUILTIN_BUFFER, [stableJson(unsignedApproval), 'utf8']);
    let rawSignature;
    try { rawSignature = settings.sign(signingBytes, settings.keyRef); }
    catch { fail('SIGNING_FAILED', 'Owner-private approval signing failed'); }
    const signature = canonicalSignature(rawSignature);
    const afterSigning = observeAuthorityClock(settings.now, 'Review decision');
    assertSolePositiveReview(db, input, currentProjection);
    assertPositiveReviewCurrent(db, currentProjection, afterSigning);
    assertApprovalNotExpired(input, currentProjection, afterSigning);
    const approval = validateApprovalReceiptV2({
      ...unsignedApproval,
      attestation: {
        algorithm: 'Ed25519',
        keyId: settings.keyId,
        payloadDigest,
        signatureEncoding: 'base64',
        signature
      }
    });
    if (stableJson(approvalAttestationPayload(approval)) !== stableJson(unsignedApproval)) {
      fail('SIGNING_FAILED', 'Approval attestation payload changed during signing');
    }
    const pinnedApprovalKey = pinResolvedPublicKey(settings.approvalKey, 'Approval');
    const afterKeyResolution = observeAuthorityClock(settings.now, 'Review decision');
    assertSolePositiveReview(db, input, currentProjection);
    assertPositiveReviewCurrent(db, currentProjection, afterKeyResolution);
    assertApprovalNotExpired(input, currentProjection, afterKeyResolution);
    verifyApprovalAttestation(approval, pinnedApprovalKey);
    const approvalDigest = digestCanonicalJson(approval);
    const finalApprovalClock = observeAuthorityClock(settings.now, 'Review decision');
    assertSolePositiveReview(db, input, currentProjection);
    assertPositiveReviewCurrent(db, currentProjection, finalApprovalClock);
    assertApprovalNotExpired(input, currentProjection, finalApprovalClock);
    db.prepare(`INSERT INTO job_email_approval_receipts_v2(
      approval_id,review_id,proposal_id,content_id,approval_json,approval_digest,
      one_send_idempotency_key,key_id,public_key_sha256,signer_identity,approved_at,expires_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      approval.approvalId, input.reviewId, input.proposalId, content.contentId,
      stableJson(approval), approvalDigest, approval.idempotencyKey, settings.keyId,
      settings.approvalKey.expectedPublicKeySha256, settings.signerIdentity,
      approval.approvedAt, approval.expiresAt
    );
    settings.failpoint('after-approval-receipt-insert');
    const postInsertClock = observeAuthorityClock(settings.now, 'Review decision');
    assertPositiveReviewCurrent(db, currentProjection, postInsertClock);
    assertApprovalNotExpired(input, currentProjection, postInsertClock);
    assertApprovalInsertUninterleaved(db, input, approvalDigest);
    return result('outgoing-review-record', {
      reviewId: input.reviewId,
      decision: 'approve',
      decisionDigest,
      approvalReceipt: approval,
      approvalDigest,
      sendAuthority: 'one-send-request-only',
      reused: false
    });
  });
}

function createSendRequest(db, rawInput, deps = {}) {
  const input = validateSendIssueInput(rawInput);
  const dependencyFields = dependencyObject(deps, 'send request dependencies', ['approvalKey', 'now'], ['approvalKey']);
  const approvalKey = snapshotKeyOptions(dependencyFields.approvalKey, 'approval key');
  const observeNow = dependencyFields.now === undefined
    ? () => new Date().toISOString()
    : snapshotPlainFunction(dependencyFields.now, 'send request clock');
  return idempotentWrite(db, 'outgoing-send-request', input.operationIdempotencyKey, input, () => {
    const approvalRow = db.prepare('SELECT * FROM job_email_approval_receipts_v2 WHERE approval_id=?').get(input.approvalId);
    if (!approvalRow) fail('APPROVAL_NOT_FOUND', `Approval not found: ${input.approvalId}`);
    const priorRequest = db.prepare('SELECT request_digest,request_json FROM job_email_send_requests_v2 WHERE approval_id=? OR request_id=?')
      .get(input.approvalId, input.requestId);
    if (priorRequest) fail('SEND_REQUEST_ALREADY_ISSUED', 'Approval has already minted its one send request');
    const invalidation = db.prepare('SELECT reason FROM job_email_outgoing_invalidation_events WHERE approval_id=? ORDER BY invalidated_at LIMIT 1')
      .get(input.approvalId);
    if (invalidation) fail('APPROVAL_INVALIDATED', `Approval is invalidated: ${invalidation.reason}`);
    const artifacts = loadProposalArtifacts(db, approvalRow.proposal_id);
    const approval = validateApprovalReceiptV2(parseStoredJson(approvalRow.approval_json, 'stored approval'));
    const pinnedApprovalKey = pinResolvedPublicKey(approvalKey, 'Approval');
    verifyApprovalAttestation(approval, pinnedApprovalKey);
    if (approval.attestation.keyId !== approvalRow.key_id
      || approvalKey.expectedKeyId !== approvalRow.key_id
      || approvalKey.expectedPublicKeySha256 !== approvalRow.public_key_sha256) {
      fail('APPROVAL_KEY_MISMATCH', 'Injected approval identity differs from the immutable approval key pin');
    }
    const requestedAt = observeAuthorityClock(observeNow, 'Send request');
    assertSendRequestCurrent(db, input, approval, artifacts, requestedAt);
    const threadEvidenceDigest = digestCanonicalJson({
      schemaVersion: 'email-thread-evidence.v1',
      provider: artifacts.content.provider,
      accountId: artifacts.content.accountId,
      recipient: artifacts.content.recipient,
      thread: artifacts.content.thread,
      sourceMessageId: artifacts.proposal.source.messageId,
      factsDigest: artifacts.proposal.factsDigest
    });
    let request = validateEmailSendRequestV2({
      schemaVersion: 'email-send-request.v2',
      normalizationVersion: NORMALIZATION_VERSION,
      requestId: input.requestId,
      idempotencyKey: approval.idempotencyKey,
      generationId: artifacts.content.generationId,
      manifestDigest: artifacts.content.manifestDigest,
      provider: artifacts.content.provider,
      accountId: artifacts.content.accountId,
      recipient: artifacts.content.recipient,
      threadId: artifacts.content.thread.threadId,
      inReplyTo: artifacts.content.thread.inReplyTo,
      references: artifacts.content.thread.references,
      threadEvidenceDigest,
      sendFidelity: 'content_equivalent',
      content: {
        mode: 'approved_content',
        contractId: 'email-approved-content.v1',
        digest: digestCanonicalJson(artifacts.content)
      },
      approvalDigest: digestCanonicalJson(approval),
      approval,
      requestedAt,
      expiresAt: approval.expiresAt
    });
    const draftReceipt = loadDraftReceipt(db, artifacts.proposal.proposalId);
    const errors = validateOutgoingV2Consistency({
      proposal: artifacts.proposal,
      content: artifacts.content,
      draftReceipt,
      approval,
      request
    }, { phase: 'claim', now: requestedAt, approvalKey: pinnedApprovalKey });
    if (errors.length) fail('SEND_REQUEST_INCONSISTENT', 'One-send request failed the complete pre-effect claim check', { errors });
    const finalRequestedAt = observeAuthorityClock(observeNow, 'Send request');
    if (parseTime(finalRequestedAt) < parseTime(requestedAt)) {
      fail('CLOCK_UNAVAILABLE', 'Send request clock moved backwards during authority linearization');
    }
    if (finalRequestedAt !== requestedAt) {
      request = validateEmailSendRequestV2({ ...request, requestedAt: finalRequestedAt });
    }
    const finalErrors = validateOutgoingV2Consistency({
      proposal: artifacts.proposal,
      content: artifacts.content,
      draftReceipt,
      approval,
      request
    }, { phase: 'claim', now: finalRequestedAt, approvalKey: pinnedApprovalKey });
    if (finalErrors.length) {
      fail('SEND_REQUEST_INCONSISTENT', 'One-send request failed the final complete pre-effect claim check', { errors: finalErrors });
    }
    assertSendRequestCurrent(db, input, approval, artifacts, finalRequestedAt);
    const requestDigest = digestCanonicalJson(request);
    db.prepare(`INSERT INTO job_email_send_requests_v2(
      request_id,approval_id,proposal_id,content_id,request_json,request_digest,
      one_send_idempotency_key,requested_at,expires_at
    ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      request.requestId, approval.approvalId, artifacts.proposal.proposalId,
      artifacts.content.contentId, stableJson(request), requestDigest,
      request.idempotencyKey, request.requestedAt, request.expiresAt
    );
    return result('outgoing-send-request', {
      request,
      requestDigest,
      maximumSends: 1,
      effectPerformed: false,
      reused: false
    });
  });
}

function invalidateApproval(db, rawInput) {
  const input = validateInvalidationInput(rawInput);
  return idempotentWrite(db, 'outgoing-invalidate', input.operationIdempotencyKey, input, () => {
    const approval = db.prepare('SELECT * FROM job_email_approval_receipts_v2 WHERE approval_id=?').get(input.approvalId);
    if (!approval) fail('APPROVAL_NOT_FOUND', `Approval not found: ${input.approvalId}`);
    if (approval.approval_digest !== input.expectedApprovalDigest) fail('APPROVAL_DIGEST_MISMATCH', 'Invalidation does not bind the immutable approval digest');
    if (input.replacementProposalId) loadProposalArtifacts(db, input.replacementProposalId);
    const document = copyInertData({
      schemaVersion: INVALIDATION_VERSION,
      invalidationId: input.invalidationId,
      approvalId: input.approvalId,
      proposalId: approval.proposal_id,
      expectedApprovalDigest: input.expectedApprovalDigest,
      reason: input.reason,
      ...(input.replacementProposalId ? { replacementProposalId: input.replacementProposalId } : {}),
      invalidatedAt: input.invalidatedAt
    }, 'invalidation');
    const digest = digestCanonicalJson(document);
    const existing = db.prepare('SELECT invalidation_digest FROM job_email_outgoing_invalidation_events WHERE invalidation_id=?')
      .get(input.invalidationId);
    if (existing) {
      if (existing.invalidation_digest !== digest) fail('INVALIDATION_CONFLICT', 'Invalidation ID is already bound to different content');
      return result('outgoing-invalidate', { invalidation: document, invalidationDigest: digest, reused: true });
    }
    db.prepare(`INSERT INTO job_email_outgoing_invalidation_events(
      invalidation_id,approval_id,proposal_id,replacement_proposal_id,reason,
      invalidation_json,invalidation_digest,invalidated_at
    ) VALUES (?,?,?,?,?,?,?,?)`).run(
      input.invalidationId, input.approvalId, approval.proposal_id,
      input.replacementProposalId || null, input.reason, stableJson(document), digest,
      input.invalidatedAt
    );
    return result('outgoing-invalidate', { invalidation: document, invalidationDigest: digest, reused: false });
  });
}

function correlateSendReceipt(db, rawInput, deps = {}) {
  const input = validateReceiptCorrelationInput(rawInput);
  const receipt = validateEmailSendReceiptV2(input.receipt);
  const dependencyFields = dependencyObject(deps, 'receipt correlation dependencies', [
    'nativeReceiptKey', 'resolveApprovalPublicKey', 'failpoint', 'now'
  ], ['nativeReceiptKey', 'resolveApprovalPublicKey']);
  const nativeKey = snapshotKeyOptions(dependencyFields.nativeReceiptKey, 'native receipt key');
  const resolveApprovalPublicKey = snapshotPlainFunction(
    dependencyFields.resolveApprovalPublicKey,
    'approval public key resolver'
  );
  const failpoint = dependencyFields.failpoint === undefined
    ? () => {}
    : snapshotPlainFunction(dependencyFields.failpoint, 'failpoint');
  const observeNow = dependencyFields.now === undefined
    ? () => new Date().toISOString()
    : snapshotPlainFunction(dependencyFields.now, 'receipt correlation clock');
  const receiptDigest = digestCanonicalJson(receipt);
  return idempotentWrite(db, 'outgoing-receipt', input.operationIdempotencyKey, input, () => {
    const replay = db.prepare('SELECT receipt_digest,receipt_json FROM job_email_send_receipt_correlations_v2 WHERE receipt_id=?')
      .get(receipt.receiptId);
    if (replay) {
      if (replay.receipt_digest !== receiptDigest) fail('RECEIPT_CONFLICT', 'Receipt ID is already bound to different evidence');
      return result('outgoing-receipt', {
        receipt,
        receiptDigest,
        outcome: receipt.outcome,
        retryAuthority: false,
        reused: true
      });
    }
    const requestRow = db.prepare('SELECT * FROM job_email_send_requests_v2 WHERE request_id=?').get(receipt.requestId);
    if (!requestRow) fail('SEND_REQUEST_NOT_FOUND', `Send request not found: ${receipt.requestId}`);
    const request = validateEmailSendRequestV2(parseStoredJson(requestRow.request_json, 'stored send request'));
    const approvalRow = db.prepare('SELECT * FROM job_email_approval_receipts_v2 WHERE approval_id=?').get(requestRow.approval_id);
    const approval = validateApprovalReceiptV2(parseStoredJson(approvalRow.approval_json, 'stored approval'));
    const artifacts = loadProposalArtifacts(db, requestRow.proposal_id);
    const draftReceipt = loadDraftReceipt(db, requestRow.proposal_id);
    const initialReceipts = assertReceiptStateTransition(db, receipt);
    const resolvePriorAppliedReceipt = ({ receiptId, receiptDigest: expectedDigest }) => {
      const row = db.prepare('SELECT receipt_json,receipt_digest FROM job_email_send_receipt_correlations_v2 WHERE receipt_id=?')
        .get(receiptId);
      if (!row || row.receipt_digest !== expectedDigest) return null;
      return parseStoredJson(row.receipt_json, 'stored prior applied receipt');
    };
    const approvalKey = {
      expectedKeyId: approvalRow.key_id,
      expectedPublicKeySha256: approvalRow.public_key_sha256,
      resolvePublicKey: resolveApprovalPublicKey
    };
    // Resolve each injected key exactly once, then retain only a local resolver
    // closure for deterministic validation. Re-read attempt state after every
    // external callback so nested correlations cannot use a stale snapshot.
    const pinnedApprovalKey = pinResolvedPublicKey(approvalKey, 'Approval');
    assertReceiptStateTransition(db, receipt);
    const pinnedNativeKey = pinResolvedPublicKey(nativeKey, 'Native receipt');
    assertReceiptStateTransition(db, receipt);
    failpoint('before-send-receipt-insert');
    assertReceiptStateTransition(db, receipt);
    const reconciledAt = observeAuthorityClock(observeNow, 'Receipt correlation');
    assertReceiptStateTransition(db, receipt);
    const errors = validateOutgoingV2Consistency({
      proposal: artifacts.proposal,
      content: artifacts.content,
      draftReceipt,
      approval,
      request,
      sendReceipt: receipt
    }, {
      phase: 'reconciliation',
      now: reconciledAt,
      approvalKey: pinnedApprovalKey,
      nativeReceiptKey: pinnedNativeKey,
      resolvePriorAppliedReceipt
    });
    if (errors.length) fail('SEND_RECEIPT_INCONSISTENT', 'Receipt failed complete reconciliation validation', { errors });
    assertReceiptStateTransition(db, receipt);
    db.prepare(`INSERT INTO job_email_send_receipt_correlations_v2(
      receipt_id,send_request_id,attempt_id,outcome,classification,receipt_json,
      receipt_digest,native_key_id,native_public_key_sha256,observed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      receipt.receiptId, receipt.requestId, receipt.attemptId, receipt.outcome,
      receipt.classification, stableJson(receipt), receiptDigest,
      nativeKey.expectedKeyId, nativeKey.expectedPublicKeySha256, receipt.observedAt
    );
    failpoint('after-send-receipt-insert');
    const finalRows = receiptStateRows(db, receipt.requestId);
    if (finalRows.length !== initialReceipts.length + 1
      || finalRows.at(-1)?.receipt_id !== receipt.receiptId) {
      fail('RECEIPT_STATE_CONFLICT', 'Receipt state changed re-entrantly after the correlation insert');
    }
    return result('outgoing-receipt', {
      receipt,
      receiptDigest,
      outcome: receipt.outcome,
      classification: receipt.classification,
      retryAuthority: false,
      reused: false
    });
  });
}

function assertDraftResultBindings(request, input) {
  const proposal = input.proposal;
  const content = input.approvedContent;
  assertProposalContentProjection(proposal, content);
  const comparisons = [
    ['generationId', proposal.generationId, request.generationId],
    ['manifestDigest', proposal.manifestDigest, request.manifestDigest],
    ['factsDigest', proposal.factsDigest, request.factsDigest],
    ['sourceStateSha256', proposal.sourceStateSha256, request.sourceStateSha256],
    ['expiresAt', proposal.expiresAt, request.expiresAt],
    ['toneDecisionId', proposal.toneDecisionId, request.toneDecisionId],
    ['toneDecisionDigest', proposal.toneDecisionDigest, request.toneDecisionDigest],
    ['voiceRevisionId', proposal.voiceRevisionId, request.voiceRevisionId],
    ['voiceRevisionDigest', proposal.voiceRevisionDigest, request.voiceRevisionDigest],
    ['source', stableJson(proposal.source), stableJson(request.source)],
    ['delivery', stableJson(proposal.delivery), stableJson(request.delivery)]
  ];
  if ((proposal.styleProfileId === undefined) !== (request.styleProfileId === undefined)
    || proposal.styleProfileId !== request.styleProfileId
    || proposal.styleProfileDigest !== request.styleProfileDigest) {
    comparisons.push(['styleProfile', 'proposal', 'request']);
  }
  const mismatches = comparisons.filter(([, left, right]) => left !== right).map(([name]) => name);
  if (request.execution?.kind !== input.usage.runner
    || input.usage.toolCalls !== 0
    || input.usage.toolsUsed.length !== 0
    || input.usage.sideEffects.length !== 0) mismatches.push('tool_or_effect_usage');
  if (input.usage.runner === CLARIFICATION_RUNNER && (
    request.execution?.templateId !== CLARIFICATION_TEMPLATE_ID
    || proposal.authorship !== 'template' || proposal.templateId !== CLARIFICATION_TEMPLATE_ID
    || proposal.bodyDigest !== request.execution.bodyDigest
    || digestUtf8Text(proposal.body) !== request.execution.bodyDigest
    || request.manifestDigest !== digestUtf8Text(CLARIFICATION_TEMPLATE_ID)
    || request.execution.toolAccess !== 'none' || request.execution.networkAccess !== 'none'
    || request.execution.credentialAccess !== 'none'
    || request.effects.mailboxRead !== false || request.effects.nativeDraft !== false
    || request.effects.send !== false
  )) mismatches.push('clarification_template');
  if (!(parseTime(content.createdAt) <= parseTime(input.completedAt)
    && parseTime(input.completedAt) < parseTime(proposal.expiresAt))) mismatches.push('chronology');
  if (mismatches.length) fail('DRAFT_RESULT_MISMATCH', 'Draft result violates request bindings or no-effect execution policy', { mismatches });
}

function validateDraftIssueInput(raw) {
  const value = plainInput(raw, 'draft issue input', [
    'schemaVersion', 'requestId', 'idempotencyKey', 'generationId', 'manifestDigest',
    'source', 'delivery', 'toneDecisionId', 'toneDecisionDigest', 'voiceRevisionId',
    'voiceRevisionDigest', 'styleProfileId', 'styleProfileDigest', 'expiresAt'
  ], [
    'schemaVersion', 'requestId', 'idempotencyKey', 'generationId', 'manifestDigest',
    'source', 'delivery', 'toneDecisionId', 'toneDecisionDigest', 'voiceRevisionId',
    'voiceRevisionDigest', 'expiresAt'
  ]);
  literal(value.schemaVersion, 'jobtrack-email-reply-draft-issue.v1', 'schemaVersion');
  for (const key of ['requestId', 'idempotencyKey', 'generationId', 'toneDecisionId', 'voiceRevisionId']) assertId(value[key], key);
  assertDigest(value.manifestDigest, 'manifestDigest');
  assertDigest(value.toneDecisionDigest, 'toneDecisionDigest');
  assertDigest(value.voiceRevisionDigest, 'voiceRevisionDigest');
  if ((value.styleProfileId === undefined) !== (value.styleProfileDigest === undefined)) fail('INVALID_INPUT', 'style profile ID/digest must be supplied together');
  if (value.styleProfileId) {
    assertId(value.styleProfileId, 'styleProfileId');
    assertDigest(value.styleProfileDigest, 'styleProfileDigest');
  }
  assertDateTime(value.expiresAt, 'expiresAt');
  const source = plainInput(value.source, 'source', [
    'provider', 'accountId', 'messageId', 'threadId', 'replyToAddress', 'inReplyTo', 'references'
  ], ['provider', 'accountId', 'messageId', 'threadId', 'replyToAddress', 'inReplyTo', 'references']);
  for (const key of ['provider', 'accountId', 'messageId', 'threadId', 'replyToAddress', 'inReplyTo']) assertSafeString(source[key], `source.${key}`, key === 'replyToAddress' ? 320 : 998);
  if (!Array.isArray(source.references) || source.references.length < 1 || source.references.length > 50) fail('INVALID_INPUT', 'source.references must contain 1 to 50 items');
  source.references.forEach((entry, index) => assertSafeString(entry, `source.references[${index}]`, 998));
  if (new Set(source.references).size !== source.references.length) fail('INVALID_INPUT', 'source.references must be unique');
  const delivery = plainInput(value.delivery, 'delivery', ['provider', 'accountId'], ['provider', 'accountId']);
  assertSafeString(delivery.provider, 'delivery.provider', 64);
  assertSafeString(delivery.accountId, 'delivery.accountId', 500);
  return value;
}

function validateDraftResult(raw, runner = 'standalone_out_of_process') {
  const value = plainInput(raw, 'draft result', [
    'schemaVersion', 'resultId', 'requestId', 'requestDigest', 'proposal',
    'approvedContent', 'usage', 'completedAt', 'idempotencyKey'
  ], [
    'schemaVersion', 'resultId', 'requestId', 'requestDigest', 'proposal',
    'approvedContent', 'usage', 'completedAt', 'idempotencyKey'
  ]);
  literal(value.schemaVersion, INTERNAL_RESULT_VERSION, 'schemaVersion');
  for (const key of ['resultId', 'requestId', 'idempotencyKey']) assertId(value[key], key);
  assertDigest(value.requestDigest, 'requestDigest');
  value.proposal = validateReplyDraftProposalV3(value.proposal);
  value.approvedContent = validateEmailApprovedContentV1(value.approvedContent);
  value.usage = plainInput(value.usage, 'usage', ['runner', 'toolCalls', 'toolsUsed', 'sideEffects'], ['runner', 'toolCalls', 'toolsUsed', 'sideEffects']);
  literal(value.usage.runner, runner, 'usage.runner');
  if (!Number.isInteger(value.usage.toolCalls) || value.usage.toolCalls < 0) fail('INVALID_INPUT', 'usage.toolCalls must be a nonnegative integer');
  if (!Array.isArray(value.usage.toolsUsed) || !Array.isArray(value.usage.sideEffects)) fail('INVALID_INPUT', 'usage tools/effects must be arrays');
  assertDateTime(value.completedAt, 'completedAt');
  return value;
}

function validateCaptureInput(raw) {
  const value = plainInput(raw, 'draft receipt capture', ['schemaVersion', 'receipt', 'idempotencyKey'], ['schemaVersion', 'receipt', 'idempotencyKey']);
  literal(value.schemaVersion, 'jobtrack-email-draft-receipt-capture.v1', 'schemaVersion');
  assertId(value.idempotencyKey, 'idempotencyKey');
  return value;
}

function validateReviewInput(raw) {
  const value = plainInput(raw, 'review input', [
    'schemaVersion', 'reviewId', 'proposalId', 'decision', 'approver', 'decidedAt',
    'expectedProjectionDigest', 'expectedApprovedContentDigest', 'authenticatedChannel',
    'operationIdempotencyKey', 'reason', 'approval'
  ], [
    'schemaVersion', 'reviewId', 'proposalId', 'decision', 'approver', 'decidedAt',
    'expectedProjectionDigest', 'expectedApprovedContentDigest', 'authenticatedChannel',
    'operationIdempotencyKey'
  ]);
  literal(value.schemaVersion, REVIEW_DECISION_VERSION, 'schemaVersion');
  for (const key of ['reviewId', 'proposalId', 'operationIdempotencyKey']) assertId(value[key], key);
  if (!['approve', 'reject'].includes(value.decision)) fail('INVALID_INPUT', 'decision must be approve or reject');
  const approver = plainInput(value.approver, 'approver', ['kind', 'id'], ['kind', 'id']);
  // 'policy' = auto-approval under a standing operator policy (additive
  // widening 2026-08-05; see lib/email-auto-approval.js).
  if (!['human', 'policy'].includes(approver.kind)) {
    fail('INVALID_INPUT', "approver.kind must be 'human' or 'policy'");
  }
  assertSafeString(approver.id, 'approver.id', 320);
  assertDateTime(value.decidedAt, 'decidedAt');
  assertDigest(value.expectedProjectionDigest, 'expectedProjectionDigest');
  assertDigest(value.expectedApprovedContentDigest, 'expectedApprovedContentDigest');
  validateChannel(value.authenticatedChannel);
  if (value.decision === 'approve') {
    if (value.reason !== undefined || value.approval === undefined) fail('INVALID_INPUT', 'approve requires approval fields and no rejection reason');
    const approval = plainInput(value.approval, 'approval input', ['approvalId', 'idempotencyKey', 'expiresAt'], ['approvalId', 'idempotencyKey', 'expiresAt']);
    assertId(approval.approvalId, 'approval.approvalId');
    assertId(approval.idempotencyKey, 'approval.idempotencyKey');
    assertDateTime(approval.expiresAt, 'approval.expiresAt');
  } else {
    if (value.approval !== undefined) fail('INVALID_INPUT', 'reject cannot contain approval fields');
    assertSafeString(value.reason, 'reason', 1000);
  }
  return value;
}

function validateSendIssueInput(raw) {
  const value = plainInput(raw, 'send issue input', [
    'schemaVersion', 'requestId', 'approvalId', 'operationIdempotencyKey'
  ], ['schemaVersion', 'requestId', 'approvalId', 'operationIdempotencyKey']);
  literal(value.schemaVersion, SEND_ISSUE_VERSION, 'schemaVersion');
  for (const key of ['requestId', 'approvalId', 'operationIdempotencyKey']) assertId(value[key], key);
  return value;
}

function validateInvalidationInput(raw) {
  const value = plainInput(raw, 'invalidation input', [
    'schemaVersion', 'invalidationId', 'approvalId', 'expectedApprovalDigest', 'reason',
    'replacementProposalId', 'invalidatedAt', 'operationIdempotencyKey'
  ], [
    'schemaVersion', 'invalidationId', 'approvalId', 'expectedApprovalDigest', 'reason',
    'invalidatedAt', 'operationIdempotencyKey'
  ]);
  literal(value.schemaVersion, INVALIDATION_VERSION, 'schemaVersion');
  for (const key of ['invalidationId', 'approvalId', 'operationIdempotencyKey']) assertId(value[key], key);
  if (value.replacementProposalId) assertId(value.replacementProposalId, 'replacementProposalId');
  assertDigest(value.expectedApprovalDigest, 'expectedApprovalDigest');
  if (!INVALIDATION_REASONS.has(value.reason)) fail('INVALID_INPUT', 'Unsupported invalidation reason');
  assertDateTime(value.invalidatedAt, 'invalidatedAt');
  return value;
}

function validateReceiptCorrelationInput(raw) {
  const value = plainInput(raw, 'receipt correlation input', [
    'schemaVersion', 'receipt', 'operationIdempotencyKey'
  ], ['schemaVersion', 'receipt', 'operationIdempotencyKey']);
  literal(value.schemaVersion, 'jobtrack-email-send-receipt-correlation.v1', 'schemaVersion');
  assertId(value.operationIdempotencyKey, 'operationIdempotencyKey');
  return value;
}

function validateChannel(channel) {
  const value = plainInput(channel, 'authenticatedChannel', [
    'kind', 'channelId', 'authenticated', 'authenticationReceiptDigest'
  ], ['kind', 'channelId', 'authenticated', 'authenticationReceiptDigest']);
  if (!['jobtrack_fixed_command', 'signed_local_bridge'].includes(value.kind)) fail('INVALID_INPUT', 'Unsupported authenticated channel kind');
  assertId(value.channelId, 'authenticatedChannel.channelId');
  literal(value.authenticated, true, 'authenticatedChannel.authenticated');
  assertDigest(value.authenticationReceiptDigest, 'authenticatedChannel.authenticationReceiptDigest');
}

function snapshotReviewDependencies(raw, decision) {
  const fields = dependencyObject(raw, 'review dependencies', [
    'approvalChannel', 'signer', 'approvalKey', 'failpoint', 'now'
  ], ['approvalChannel']);
  const channel = dependencyObject(fields.approvalChannel, 'approvalChannel', ['verify'], ['verify']);
  const resultValue = {
    channelVerify: snapshotPlainFunction(channel.verify, 'approvalChannel.verify'),
    failpoint: fields.failpoint === undefined ? () => {} : snapshotPlainFunction(fields.failpoint, 'failpoint'),
    now: fields.now === undefined ? () => new Date().toISOString() : snapshotPlainFunction(fields.now, 'review decision clock')
  };
  if (decision === 'reject') return Object.freeze(resultValue);
  const signer = dependencyObject(fields.signer, 'approval signer', [
    'keyRef', 'keyId', 'signerIdentity', 'sign'
  ], ['keyRef', 'keyId', 'signerIdentity', 'sign']);
  if (typeof signer.keyRef !== 'string' || signer.keyRef.length < 1 || signer.keyRef.length > 1000) fail('RUNTIME_UNAVAILABLE', 'Approval signer key reference must be injected');
  assertId(signer.keyId, 'approval signer keyId');
  assertId(signer.signerIdentity, 'approval signer identity');
  const approvalKey = snapshotKeyOptions(fields.approvalKey, 'approval key');
  if (signer.keyId !== approvalKey.expectedKeyId) fail('APPROVAL_KEY_MISMATCH', 'Signer key ID differs from the pinned public identity');
  return Object.freeze({
    ...resultValue,
    keyRef: signer.keyRef,
    keyId: signer.keyId,
    signerIdentity: signer.signerIdentity,
    sign: snapshotPlainFunction(signer.sign, 'approval signer sign'),
    approvalKey
  });
}

function snapshotKeyOptions(raw, label) {
  const fields = dependencyObject(raw, label, [
    'expectedKeyId', 'expectedPublicKeySha256', 'resolvePublicKey'
  ], ['expectedKeyId', 'expectedPublicKeySha256', 'resolvePublicKey']);
  assertId(fields.expectedKeyId, `${label}.expectedKeyId`);
  assertDigest(fields.expectedPublicKeySha256, `${label}.expectedPublicKeySha256`);
  return Object.freeze({
    expectedKeyId: fields.expectedKeyId,
    expectedPublicKeySha256: fields.expectedPublicKeySha256,
    resolvePublicKey: snapshotPlainFunction(fields.resolvePublicKey, `${label}.resolvePublicKey`)
  });
}

function snapshotFailpoint(raw) {
  const fields = dependencyObject(raw, 'operation dependencies', [
    'approvalChannel', 'signer', 'approvalKey', 'nativeReceiptKey',
    'resolveApprovalPublicKey', 'failpoint'
  ], []);
  return Object.freeze({
    failpoint: fields.failpoint === undefined ? () => {} : snapshotPlainFunction(fields.failpoint, 'failpoint')
  });
}

function dependencyObject(value, path, allowed, required) {
  if (value === undefined) value = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
    fail('RUNTIME_UNAVAILABLE', `${path} must be an injected plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('RUNTIME_UNAVAILABLE', `${path} must be an injected plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === 'symbol') || keys.some((key) => !allowed.includes(key))) {
    fail('RUNTIME_UNAVAILABLE', `${path} contains unsupported fields`);
  }
  for (const name of required) if (!Object.prototype.hasOwnProperty.call(descriptors, name)) fail('RUNTIME_UNAVAILABLE', `${path}.${name} must be injected`);
  const out = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || 'get' in descriptor || 'set' in descriptor) fail('RUNTIME_UNAVAILABLE', `${path}.${key} must be inert`);
    out[key] = descriptor.value;
  }
  return out;
}

function snapshotPlainFunction(value, path) {
  if (typeof value !== 'function' || utilTypes.isProxy(value)) fail('RUNTIME_UNAVAILABLE', `${path} must be injected as a plain function`);
  return value;
}

function canonicalSignature(value) {
  // A signer runs before this point, so it may have altered the realm itself
  // rather than the value it returned. Several Node internals — Buffer.from,
  // Buffer.prototype.toString — read `length`/`byteLength` through
  // %TypedArray%.prototype, so a swapped intrinsic would execute attacker code
  // while this module handled its own trusted bytes. There is no safe way to
  // operate in a tampered realm, so detect it and refuse before touching
  // anything.
  assertRealmIntegrity();
  // isProxy is an intrinsic predicate: it detects normal and revoked Proxies
  // without invoking getPrototypeOf/valueOf/iterator/property traps. It must be
  // the very first observation of an untrusted signer result.
  if (IS_PROXY(value)) {
    fail('SIGNING_FAILED', 'Approval signer must return raw non-Proxy signature bytes');
  }
  if (value === null || typeof value !== 'object') {
    fail('SIGNING_FAILED', 'Approval signer must return an exact raw 64-byte Buffer or Uint8Array');
  }
  let prototype;
  try { prototype = GET_PROTOTYPE_OF(value); }
  catch { fail('SIGNING_FAILED', 'Approval signer returned unreadable signature bytes'); }
  if (IS_PROXY(prototype)) {
    fail('SIGNING_FAILED', 'Approval signer byte prototype must not be a Proxy');
  }
  if (prototype !== BUILTIN_BUFFER_PROTOTYPE && prototype !== BUILTIN_UINT8_ARRAY_PROTOTYPE) {
    fail('SIGNING_FAILED', 'Approval signer bytes must use an exact built-in Buffer or Uint8Array prototype');
  }
  if (!ARRAY_BUFFER_IS_VIEW(value)) {
    fail('SIGNING_FAILED', 'Approval signer must return a genuine typed-array byte view');
  }
  // A prototype swap can present a DataView or a wider element type as though
  // it were a Uint8Array. The %TypedArray%.prototype toStringTag getter reads
  // the internal element kind rather than any own or inherited property, so it
  // separates a genuine single-byte element view from a same-byteLength
  // impostor without executing hostile code.
  let kind;
  try { kind = REFLECT_APPLY(TYPED_ARRAY_KIND_GETTER, value, []); }
  catch { fail('SIGNING_FAILED', 'Approval signer returned unreadable signature bytes'); }
  if (kind !== 'Uint8Array') {
    fail('SIGNING_FAILED', 'Approval signer bytes must be a genuine Uint8Array element view');
  }
  // Establish the 64-byte bound before enumerating own properties: the sweep
  // below is linear in property count, and an unbounded view would otherwise
  // impose that cost inside the privileged path.
  let byteLength;
  try { byteLength = REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []); }
  catch { fail('SIGNING_FAILED', 'Approval signer returned unreadable signature bytes'); }
  if (byteLength !== 64) fail('SIGNING_FAILED', 'Approval signer must return a 64-byte Ed25519 signature');
  let descriptors;
  try { descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value); }
  catch { fail('SIGNING_FAILED', 'Approval signer returned unreadable signature bytes'); }
  const descriptorKeys = REFLECT_OWN_KEYS(descriptors);
  for (let index = 0; index < descriptorKeys.length; index += 1) {
    const descriptor = descriptors[descriptorKeys[index]];
    if ('get' in descriptor || 'set' in descriptor) {
      fail('SIGNING_FAILED', 'Approval signer bytes must not contain own accessors');
    }
  }
  return encodeSignatureBase64(copyExactSignatureBytes(value));
}

function copyExactSignatureBytes(value) {
  let length;
  let backingBuffer;
  try {
    length = REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
    backingBuffer = REFLECT_APPLY(TYPED_ARRAY_BUFFER_GETTER, value, []);
  }
  catch { fail('SIGNING_FAILED', 'Approval signer returned unreadable signature bytes'); }
  if (length !== 64) fail('SIGNING_FAILED', 'Approval signer must return a 64-byte Ed25519 signature');
  if (IS_SHARED_ARRAY_BUFFER(backingBuffer)) {
    fail('SIGNING_FAILED', 'Approval signer bytes must not use shared memory');
  }
  const bytes = REFLECT_APPLY(BUFFER_ALLOC_UNSAFE, BUILTIN_BUFFER, [64]);
  for (let index = 0; index < 64; index += 1) bytes[index] = value[index];
  return bytes;
}

// Encode the 64 copied bytes without calling Buffer.prototype.toString.
//
// That method reads `this.length`, which is an accessor on %TypedArray%.prototype
// rather than an own property, so the lookup walks the prototype chain. A signer
// that replaced the realm's Uint8Array.prototype prototype could therefore run a
// trap during the encoding of the library's OWN trusted copy — after every check
// on the untrusted value had already passed. Reading integer indices touches the
// exotic object directly and consults no prototype, so this loop cannot be
// intercepted. The 64-byte input always yields 86 base64 characters plus '=='.
function encodeSignatureBase64(bytes) {
  let out = '';
  for (let index = 0; index < 63; index += 3) {
    const triple = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    out += BASE64_ALPHABET[(triple >> 18) & 0x3f]
      + BASE64_ALPHABET[(triple >> 12) & 0x3f]
      + BASE64_ALPHABET[(triple >> 6) & 0x3f]
      + BASE64_ALPHABET[triple & 0x3f];
  }
  const tail = bytes[63] << 16;
  return `${out}${BASE64_ALPHABET[(tail >> 18) & 0x3f]}${BASE64_ALPHABET[(tail >> 12) & 0x3f]}==`;
}

function invalidateReplacedApprovals(db, proposal, invalidatedAt) {
  const rows = db.prepare(`
    SELECT approval.approval_id,approval.approval_digest,approval.proposal_id
    FROM job_email_approval_receipts_v2 approval
    JOIN job_email_outgoing_proposals_v3 old ON old.proposal_id=approval.proposal_id
    WHERE old.provider=? AND old.account_id=? AND old.message_id=? AND old.thread_id=?
      AND old.proposal_id<>?
      AND NOT EXISTS (SELECT 1 FROM job_email_outgoing_invalidation_events x WHERE x.approval_id=approval.approval_id)
    ORDER BY approval.approval_id
  `).all(
    proposal.source.provider, proposal.source.accountId, proposal.source.messageId,
    proposal.source.threadId, proposal.proposalId
  );
  for (const row of rows) {
    const document = {
      schemaVersion: INVALIDATION_VERSION,
      invalidationId: `auto-${digestCanonicalJson({ approvalId: row.approval_id, replacementProposalId: proposal.proposalId }).slice(0, 32)}`,
      approvalId: row.approval_id,
      proposalId: row.proposal_id,
      expectedApprovalDigest: row.approval_digest,
      reason: 'regenerated',
      replacementProposalId: proposal.proposalId,
      invalidatedAt
    };
    const digest = digestCanonicalJson(document);
    db.prepare(`INSERT INTO job_email_outgoing_invalidation_events(
      invalidation_id,approval_id,proposal_id,replacement_proposal_id,reason,
      invalidation_json,invalidation_digest,invalidated_at
    ) VALUES (?,?,?,?,?,?,?,?)`).run(
      document.invalidationId, row.approval_id, row.proposal_id, proposal.proposalId,
      'regenerated', stableJson(document), digest, invalidatedAt
    );
  }
}

function idempotentWrite(db, command, key, request, callback) {
  assertId(key, 'idempotency key');
  const requestDigest = digestCanonicalJson(request);
  return atomic(db, () => {
    const prior = db.prepare('SELECT * FROM job_email_outgoing_operations WHERE idempotency_key=?').get(key);
    if (prior) {
      if (prior.command !== command || prior.request_digest !== requestDigest) {
        fail('IDEMPOTENCY_CONFLICT', 'Idempotency key is already bound to a different outgoing operation');
      }
      return parseStoredJson(prior.result_json, 'stored operation result');
    }
    const output = copyInertData(callback(), 'operation result');
    const outputDigest = digestCanonicalJson(output);
    db.prepare(`INSERT INTO job_email_outgoing_operations(
      idempotency_key,command,request_digest,result_json,result_digest
    ) VALUES (?,?,?,?,?)`).run(key, command, requestDigest, stableJson(output), outputDigest);
    return output;
  });
}

function loadProposalArtifacts(db, proposalId) {
  const row = db.prepare(`SELECT proposal.proposal_json,content.content_json
    FROM job_email_outgoing_proposals_v3 proposal
    JOIN job_email_approved_contents_v1 content ON content.proposal_id=proposal.proposal_id
    WHERE proposal.proposal_id=?`).get(proposalId);
  if (!row) fail('PROPOSAL_NOT_FOUND', `Outgoing proposal not found: ${proposalId}`);
  return {
    proposal: validateReplyDraftProposalV3(parseStoredJson(row.proposal_json, 'stored proposal')),
    content: validateEmailApprovedContentV1(parseStoredJson(row.content_json, 'stored approved content'))
  };
}

function loadDraftReceipt(db, proposalId) {
  const row = db.prepare('SELECT receipt_json FROM job_email_draft_receipts_v1 WHERE proposal_id=?').get(proposalId);
  if (!row) fail('DRAFT_RECEIPT_REQUIRED', 'Positive approval/send request requires captured native draft evidence');
  return validateEmailDraftReceiptV1(parseStoredJson(row.receipt_json, 'stored draft receipt'));
}

function latestProposalForSource(db, proposal) {
  return db.prepare(`SELECT proposal_id FROM job_email_outgoing_proposals_v3
    WHERE provider=? AND account_id=? AND message_id=? AND thread_id=?
    ORDER BY rowid DESC LIMIT 1`).get(
    proposal.source.provider, proposal.source.accountId, proposal.source.messageId, proposal.source.threadId
  );
}

function observeAuthorityClock(observeNow, label) {
  let observed;
  try { observed = observeNow(); }
  catch { fail('CLOCK_UNAVAILABLE', `${label} clock failed`); }
  assertDateTime(observed, `${label.toLowerCase()} time`);
  return observed;
}

function assertReviewProjectionMatchesInDatabase(db, input, projection, observedNow) {
  if (parseTime(input.decidedAt) > parseTime(observedNow)) {
    fail('REVIEW_TIME_INVALID', 'Human decision time cannot be later than the observed review clock');
  }
  if (projection.latestReview || projection.approval) {
    fail('REVIEW_STATE_CONFLICT', 'Proposal acquired terminal review authority during review verification');
  }
  if (projection.approvedContentDigest !== input.expectedApprovedContentDigest) {
    fail('CONTENT_DIGEST_MISMATCH', 'Review decision does not bind the exact displayed content');
  }
  if (input.decision === 'approve') {
    if (!projection.draftReceipt) fail('DRAFT_RECEIPT_REQUIRED', 'Positive approval requires captured native draft evidence');
    assertPositiveReviewCurrent(db, projection, observedNow);
    assertApprovalNotExpired(input, projection, observedNow);
  }
  if (projection.projectionDigest !== input.expectedProjectionDigest) {
    fail('REVIEW_PROJECTION_STALE', 'Review projection changed before the decision was recorded');
  }
}

function assertApprovalNotExpired(input, projection, observedNow) {
  if (parseTime(observedNow) >= parseTime(projection.proposal.expiresAt)) {
    fail('PROPOSAL_EXPIRED', 'Proposal is expired at the observed review clock');
  }
  if (input.approval && parseTime(observedNow) >= parseTime(input.approval.expiresAt)) {
    fail('APPROVAL_EXPIRY_INVALID', 'Approval expired before authority could be appended');
  }
}

function assertSolePositiveReview(db, input, projection) {
  const reviews = db.prepare(`SELECT review_id,decision,content_id,review_projection_digest,approved_content_digest
    FROM job_email_outgoing_review_events WHERE proposal_id=? ORDER BY rowid`).all(input.proposalId);
  if (reviews.length !== 1
    || reviews[0].review_id !== input.reviewId
    || reviews[0].decision !== 'approve'
    || reviews[0].content_id !== projection.approvedContent.contentId
    || reviews[0].review_projection_digest !== input.expectedProjectionDigest
    || reviews[0].approved_content_digest !== input.expectedApprovedContentDigest) {
    fail('REVIEW_STATE_CONFLICT', 'Positive approval no longer has one exact terminal review');
  }
  if (db.prepare('SELECT 1 FROM job_email_approval_receipts_v2 WHERE proposal_id=?').get(input.proposalId)) {
    fail('REVIEW_STATE_CONFLICT', 'Proposal already acquired approval authority');
  }
}

function assertApprovalInsertUninterleaved(db, input, approvalDigest) {
  const row = db.prepare(`SELECT approval_id,review_id,approval_digest FROM job_email_approval_receipts_v2
    WHERE proposal_id=?`).get(input.proposalId);
  if (!row
    || row.approval_id !== input.approval.approvalId
    || row.review_id !== input.reviewId
    || row.approval_digest !== approvalDigest) {
    fail('REVIEW_STATE_CONFLICT', 'Approval insert was interleaved with contradictory authority');
  }
  if (db.prepare('SELECT 1 FROM job_email_outgoing_invalidation_events WHERE approval_id=?').get(row.approval_id)
    || db.prepare('SELECT 1 FROM job_email_send_requests_v2 WHERE approval_id=?').get(row.approval_id)) {
    fail('REVIEW_STATE_CONFLICT', 'Approval callback appended downstream authority before review completion');
  }
}

function assertSendRequestCurrent(db, input, approval, artifacts, requestedAt) {
  const invalidation = db.prepare('SELECT reason FROM job_email_outgoing_invalidation_events WHERE approval_id=? ORDER BY invalidated_at LIMIT 1')
    .get(input.approvalId);
  if (invalidation) fail('APPROVAL_INVALIDATED', `Approval is invalidated: ${invalidation.reason}`);
  if (latestProposalForSource(db, artifacts.proposal)?.proposal_id !== artifacts.proposal.proposalId) {
    fail('APPROVAL_SUPERSEDED', 'A newer proposal exists for this source/thread');
  }
  if (!proposalSourceIsCurrent(db, artifacts.proposal)) {
    fail('SOURCE_STATE_STALE', 'Current imported source facts differ from the approved proposal');
  }
  if (db.prepare('SELECT 1 FROM job_email_send_requests_v2 WHERE approval_id=? OR request_id=?').get(input.approvalId, input.requestId)) {
    fail('SEND_REQUEST_ALREADY_ISSUED', 'Approval has already minted its one send request');
  }
  if (!(parseTime(approval.approvedAt) <= parseTime(requestedAt)
    && parseTime(requestedAt) < parseTime(approval.expiresAt)
    && parseTime(requestedAt) < parseTime(artifacts.proposal.expiresAt))) {
    fail('APPROVAL_EXPIRED', 'Approval/proposal is not current at the exclusive requestedAt boundary');
  }
}

function pinResolvedPublicKey(settings, label) {
  let resolved;
  try { resolved = settings.resolvePublicKey(settings.expectedKeyId); }
  catch { fail('PUBLIC_KEY_RESOLUTION_FAILED', `${label} public key resolution failed`); }
  if (!resolved) fail('PUBLIC_KEY_RESOLUTION_FAILED', `${label} public key was not found`);
  let fingerprint;
  try { fingerprint = publicKeyFingerprint(resolved); }
  catch (error) {
    fail('PUBLIC_KEY_RESOLUTION_FAILED', `${label} public key is invalid: ${String(error.message || error)}`);
  }
  if (fingerprint !== settings.expectedPublicKeySha256) {
    fail('PUBLIC_KEY_MISMATCH', `${label} public key does not match the pinned fingerprint`);
  }
  return REFLECT_APPLY(OBJECT_FREEZE, undefined, [{
    expectedKeyId: settings.expectedKeyId,
    expectedPublicKeySha256: settings.expectedPublicKeySha256,
    resolvePublicKey: () => resolved
  }]);
}

function receiptStateRows(db, requestId) {
  return db.prepare(`SELECT rowid AS sequence,receipt_id,send_request_id,attempt_id,outcome,
      receipt_json,receipt_digest
    FROM job_email_send_receipt_correlations_v2
    WHERE send_request_id=? ORDER BY rowid`).all(requestId);
}

function assertReceiptStateTransition(db, receipt) {
  const rows = receiptStateRows(db, receipt.requestId);
  assertReceiptTransition(rows, receipt);
  return rows;
}

function assertStoredReceiptHistory(rows, requestId) {
  const prior = [];
  for (const row of rows) {
    const receipt = validateEmailSendReceiptV2(parseStoredJson(row.receipt_json, 'stored send receipt'));
    if (receipt.receiptId !== row.receipt_id
      || receipt.requestId !== row.send_request_id
      || receipt.attemptId !== row.attempt_id
      || receipt.outcome !== row.outcome
      || digestCanonicalJson(receipt) !== row.receipt_digest) {
      fail('MIGRATION_STATE_CONFLICT', `Receipt history for ${requestId} is not column/document consistent`);
    }
    try { assertReceiptTransition(prior, receipt); }
    catch (error) {
      fail('MIGRATION_STATE_CONFLICT', `Receipt history for ${requestId} is not an admitted state graph: ${String(error.message || error)}`);
    }
    prior.push(row);
  }
}

function assertReceiptTransition(rows, receipt) {
  if (rows.some((row) => row.attempt_id !== receipt.attemptId)) {
    fail('RETRY_AUTHORITY_DENIED', 'A one-send request cannot introduce a second attempt');
  }
  if (rows.length === 0) {
    if (receipt.outcome === 'duplicate') {
      fail('RECEIPT_STATE_CONFLICT', 'Duplicate evidence requires a prior sent receipt');
    }
    return;
  }
  const terminal = rows.find((row) => ['failed', 'duplicate'].includes(row.outcome));
  if (terminal) fail('RECEIPT_TERMINAL', `Request already has terminal ${terminal.outcome} evidence`);
  if (rows.length === 1 && rows[0].outcome === 'indeterminate'
    && ['sent', 'failed'].includes(receipt.outcome)) return;
  const sent = rows.find((row) => row.outcome === 'sent');
  if (sent && receipt.outcome === 'duplicate') {
    if (receipt.duplicateOfReceiptId !== sent.receipt_id
      || receipt.priorAppliedReceiptDigest !== sent.receipt_digest) {
      fail('RECEIPT_STATE_CONFLICT', 'Duplicate evidence is not bound to the prior sent receipt');
    }
    return;
  }
  if (sent) fail('RECEIPT_TERMINAL', 'A sent outcome accepts only one correctly bound duplicate');
  fail('RECEIPT_STATE_CONFLICT', 'Receipt outcome is not an admitted attempt-state transition');
}

function assertPositiveReviewCurrent(db, projection, observedNow) {
  if (latestProposalForSource(db, projection.proposal)?.proposal_id !== projection.proposal.proposalId) {
    fail('APPROVAL_SUPERSEDED', 'A newer proposal exists for this source/thread');
  }
  if (!proposalSourceIsCurrent(db, projection.proposal)) {
    fail('SOURCE_STATE_STALE', 'Current imported source facts differ from the reviewed proposal');
  }
  if (parseTime(observedNow) >= parseTime(projection.proposal.expiresAt)) {
    fail('PROPOSAL_EXPIRED', 'Proposal is expired at the observed review clock');
  }
  const receipt = db.prepare(`SELECT receipt_digest FROM job_email_draft_receipts_v1
    WHERE receipt_id=? AND proposal_id=? AND content_id=?`).get(
    projection.draftReceipt.receiptId,
    projection.proposal.proposalId,
    projection.approvedContent.contentId
  );
  if (!receipt || receipt.receipt_digest !== projection.draftReceiptDigest) {
    fail('DRAFT_RECEIPT_REQUIRED', 'Captured native draft evidence changed before positive approval');
  }
}

function proposalSourceIsCurrent(db, proposal) {
  const row = db.prepare(`SELECT facts_digest,reply_to_address,from_address,thread_id
    FROM job_email_message_refs WHERE provider=? AND account_id=? AND message_id=?`).get(
    proposal.source.provider, proposal.source.accountId, proposal.source.messageId
  );
  if (!row) return false;
  return row.facts_digest === proposal.factsDigest
    && row.thread_id === proposal.source.threadId
    && String(row.reply_to_address || row.from_address).toLowerCase() === proposal.recipient.toLowerCase();
}

function requireSourceMessage(db, source) {
  const row = db.prepare(`SELECT * FROM job_email_message_refs
    WHERE provider=? AND account_id=? AND message_id=? AND thread_id=?`).get(
    source.provider, source.accountId, source.messageId, source.threadId
  );
  if (!row) fail('SOURCE_NOT_FOUND', 'Exact imported provider/account/message/thread source was not found');
  return row;
}

function plainInput(raw, path, allowed, required) {
  let value;
  try { value = copyInertData(raw, path); }
  catch (error) { fail('INVALID_INPUT', String(error.message || error)); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${path} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail('INVALID_INPUT', `${path} contains unknown fields: ${unknown.sort().join(', ')}`);
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) fail('INVALID_INPUT', `${path}.${key} is required`);
  // Validators occasionally replace a nested object with its validated frozen
  // snapshot. Use a mutable top-level copy while retaining inert nested values.
  return { ...value };
}

function parseStoredJson(text, label) {
  try { return JSON.parse(text); }
  catch { fail('STORE_CORRUPT', `${label} is not valid JSON`); }
}

function assertId(value, path) {
  if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_INPUT', `${path} must be a stable identifier`);
}

function assertDigest(value, path) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('INVALID_INPUT', `${path} must be a lowercase SHA-256 digest`);
}

function assertDateTime(value, path) {
  if (parseTime(value) === null) fail('INVALID_INPUT', `${path} must be a valid RFC 3339 date-time`);
}

function assertSafeString(value, path, maximum) {
  if (typeof value !== 'string' || [...value].length < 1 || [...value].length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_INPUT', `${path} must be a bounded control-free string`);
}

function literal(value, expected, path) {
  if (value !== expected) fail('INVALID_INPUT', `${path} must equal ${JSON.stringify(expected)}`);
}

function compare(left, right, name, mismatches) {
  if (left !== right) mismatches.push(name);
}

function result(command, fields) {
  return { schemaVersion: 'job-email-outgoing-command-result.v1', command, ...fields };
}

function atomic(db, callback) {
  return db.transaction(callback).immediate();
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function requireDatabase(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') fail('INVALID_DATABASE', 'A SQLite database is required');
}

function createAppendOnlyTriggers(db, table) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_${table}_no_update
    BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_${table}_no_delete
    BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
  `);
}

function fail(code, message, details) {
  throw new EmailOutgoingV2Error(code, message, details);
}

module.exports = {
  EMAIL_OUTGOING_V2_AUTHORITY_GUARDS_SCHEMA_VERSION,
  EMAIL_OUTGOING_V2_AUTHORITY_GUARDS_MIGRATION_NAME,
  EMAIL_OUTGOING_V2_SCHEMA_VERSION,
  EMAIL_OUTGOING_V2_MIGRATION_NAME,
  EmailOutgoingV2Error,
  migrateEmailOutgoingV2,
  migrateEmailOutgoingV2AuthorityGuards,
  issueDraftRequest,
  issueClarificationDraftRequest,
  recordDraftResult,
  recordClarificationDraftResult,
  captureDraftReceipt,
  readReviewProjection,
  recordReviewDecision,
  createSendRequest,
  invalidateApproval,
  correlateSendReceipt
};
