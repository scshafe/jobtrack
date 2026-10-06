'use strict';

// email draft-reply work kind (v0.6).
//
// JobTrack is the drafting BRAIN, not a sender and not a model host. This module
// mirrors the application-strategy runner pattern (lib/application-strategy.js)
// exactly: JobTrack builds a read-only, digest-pinned context projection, writes
// a strict declarative bounded_internal_request, and DOES NOT execute it. An
// external runner / agent turn runs the model out-of-process and pastes the
// result back through `record`. Approval then binds the EXACT draft-artifact
// digest and emits an email-send-request.v1 + approval-receipt.v1 to a DRY-RUN
// sink (a staging table); JobTrack never delivers and holds no Gmail credential.
//
// Non-negotiables preserved: propose != apply (this module never sends); the
// request's forbiddenEffects always include send-email; untrusted inbound text
// stays inert data; secrets never enter the store; per-message human approval of
// exact bytes; the drafting model runs OUTSIDE JobTrack.

const crypto = require('node:crypto');

const {
  validateReplyDraftProposalV2,
  validateDraftProvenanceReceipt,
  validateEmailSendRequest,
  validateEmailSendReceipt,
  digest,
  stableJson
} = require('./email-contracts');
// The company-research composition (EMAIL_REPLY_DRAFTING_PLAN §4.3, P3) reuses the
// fail-closed exact-allowlist broker JobTrack already ships for discovery. JobTrack
// itself makes NO network call and runs NO model here: it only DECLARES the broker
// capability + its exact allowlist into the request, and validates that allowlist
// with the exact-same network policy validator the broker enforces at fetch time.
const {
  validateNetworkPolicy,
  matchAllowedUrl,
  NetworkPolicyError
} = require('../discovery-sandbox/network-policy');

const DRAFT_REPLY_SCHEMA_VERSION = 2026071901;
const DRAFT_REPLY_MIGRATION_NAME = 'email_draft_reply_work_kind';
// Follow-on migration: the append-only send-receipt correlation ledger (closing
// the loop). A separate version keeps existing stores upgradeable rather than
// silently editing an already-registered migration body.
const SEND_RECEIPT_CORRELATION_SCHEMA_VERSION = 2026072001;
const SEND_RECEIPT_CORRELATION_MIGRATION_NAME = 'email_send_receipt_correlation';
const DRAFT_REPLY_ROUTE_ALIAS = 'frontier-default';
const DRAFT_REPLY_OUTPUT_CONTRACT = 'email-reply-draft-proposal.v2';
// send-email leads; the full forbidden set matches the strategy request policy so
// the drafting turn can never reach a send / apply / external mutation effect.
const FORBIDDEN_EFFECTS = Object.freeze([
  'send-email', 'submit-application', 'execute', 'external-mutation'
]);
const MAX_DRAFT_REQUEST_BYTES = 512 * 1024;
const MAX_PAST_COMMUNICATIONS = 25;
const DEFAULT_BUDGET = Object.freeze({
  maxInputTokens: 120000,
  maxOutputTokens: 4000,
  maxCostMicros: 2000000,
  maxDurationMs: 120000
});
// A trust tier below this is surfaced as a warning: a zero / unavailable draft
// usage receipt must never be silently accepted (adopts the shared UsageReceipt
// trust ladder, best-first).
const TRUST_TIER_RANK = Object.freeze({
  provider_signed: 3,
  provider_reported: 2,
  estimated_tier_ceiling: 1,
  unavailable: 0
});
const TRUSTED_USAGE_FLOOR = 1;

// Company-research-via-broker composition (P3). The drafting environment MAY
// declare a discovery-egress-broker capability so an external runner can fetch
// fresh company research — never raw internet, only the exact allowlist the
// broker's fail-closed network policy permits. This is DECLARATIVE only: the
// descriptor pins the exact broker mode, the (validated) network policy allowlist,
// and the exact target URLs the runner is permitted to research. Default posture
// is fail-closed: absent the descriptor there is NO research capability at all.
const RESEARCH_CAPABILITY = 'discovery-egress-broker';
// Bounds on the declared allowlist. The network policy itself already caps origins
// at 100 (network-policy.js); we additionally bound the enumerated per-request
// research targets so the declared surface stays small and reviewable.
const MAX_RESEARCH_TARGETS = 25;

class EmailDraftReplyError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'EmailDraftReplyError';
    this.code = code;
    this.details = details;
  }
}

function migrateEmailDraftReply(db) {
  const byVersion = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
    .get(DRAFT_REPLY_SCHEMA_VERSION);
  if (byVersion) {
    if (byVersion.name !== DRAFT_REPLY_MIGRATION_NAME) {
      throw new EmailDraftReplyError('MIGRATION_CONFLICT', `Schema version ${DRAFT_REPLY_SCHEMA_VERSION} is already named ${byVersion.name}`);
    }
    return;
  }
  const byName = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?')
    .get(DRAFT_REPLY_MIGRATION_NAME);
  if (byName && byName.version !== DRAFT_REPLY_SCHEMA_VERSION) {
    throw new EmailDraftReplyError('MIGRATION_CONFLICT', `Migration ${DRAFT_REPLY_MIGRATION_NAME} is already registered as ${byName.version}`);
  }
  db.exec(`
    -- The declarative bounded_internal_request. JobTrack writes it and stops.
    CREATE TABLE IF NOT EXISTS job_email_draft_reply_requests (
      request_id TEXT PRIMARY KEY,
      message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
      facts_digest TEXT NOT NULL CHECK (length(facts_digest)=64),
      route_alias TEXT NOT NULL,
      source_state_sha256 TEXT NOT NULL CHECK (length(source_state_sha256)=64),
      request_json TEXT NOT NULL CHECK (json_valid(request_json)),
      request_digest TEXT NOT NULL CHECK (length(request_digest)=64),
      issued_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- The recorded draft-provenance-receipt.v1 (usage receipt mandatory). Binds
    -- to the request and to the recorded reply-draft proposal it explains.
    CREATE TABLE IF NOT EXISTS job_email_draft_reply_provenance (
      receipt_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES job_email_draft_reply_requests(request_id) ON DELETE RESTRICT,
      proposal_id TEXT NOT NULL REFERENCES job_email_reply_draft_proposals(proposal_id) ON DELETE RESTRICT,
      draft_proposal_digest TEXT NOT NULL CHECK (length(draft_proposal_digest)=64),
      usage_trust TEXT NOT NULL,
      receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
      receipt_digest TEXT NOT NULL CHECK (length(receipt_digest)=64),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(request_id)
    );

    -- DRY-RUN sink. The approved email-send-request.v1 (with embedded
    -- approval-receipt.v1) is emitted HERE, never to Inbox and never delivered.
    -- The Inbox send edge integrates against this exact shape later.
    CREATE TABLE IF NOT EXISTS job_email_send_request_sink (
      request_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      proposal_id TEXT NOT NULL REFERENCES job_email_reply_draft_proposals(proposal_id) ON DELETE RESTRICT,
      draft_artifact_digest TEXT NOT NULL CHECK (length(draft_artifact_digest)=64),
      recipient TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      sink TEXT NOT NULL DEFAULT 'dry-run' CHECK (sink='dry-run'),
      send_request_json TEXT NOT NULL CHECK (json_valid(send_request_json)),
      send_request_digest TEXT NOT NULL CHECK (length(send_request_digest)=64),
      approval_receipt_json TEXT NOT NULL CHECK (json_valid(approval_receipt_json)),
      emitted_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_job_email_draft_reply_request_message
      ON job_email_draft_reply_requests(message_ref_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_email_send_request_sink_proposal
      ON job_email_send_request_sink(proposal_id, created_at DESC);
  `);
  for (const table of [
    'job_email_draft_reply_requests', 'job_email_draft_reply_provenance', 'job_email_send_request_sink'
  ]) createAppendOnlyTriggers(db, table);
  db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)')
    .run(DRAFT_REPLY_SCHEMA_VERSION, DRAFT_REPLY_MIGRATION_NAME);
}

// Follow-on migration: the append-only send-receipt correlation ledger. A returned
// email-send-receipt.v1 is recorded HERE, bound to the exact emitted sink row and,
// when the inbound thread resolved to one, to the correlated application — closing
// the loop declaratively. Data-only; JobTrack still dispatches nothing.
function migrateEmailSendReceiptCorrelation(db) {
  const byVersion = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
    .get(SEND_RECEIPT_CORRELATION_SCHEMA_VERSION);
  if (byVersion) {
    if (byVersion.name !== SEND_RECEIPT_CORRELATION_MIGRATION_NAME) {
      throw new EmailDraftReplyError('MIGRATION_CONFLICT', `Schema version ${SEND_RECEIPT_CORRELATION_SCHEMA_VERSION} is already named ${byVersion.name}`);
    }
    return;
  }
  const byName = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?')
    .get(SEND_RECEIPT_CORRELATION_MIGRATION_NAME);
  if (byName && byName.version !== SEND_RECEIPT_CORRELATION_SCHEMA_VERSION) {
    throw new EmailDraftReplyError('MIGRATION_CONFLICT', `Migration ${SEND_RECEIPT_CORRELATION_MIGRATION_NAME} is already registered as ${byName.version}`);
  }
  db.exec(`
    -- The correlated email-send-receipt.v1, recorded append-only against the sink
    -- row and (when resolved) the application/thread. One receipt per emitted send
    -- request: re-correlating the exact same receipt is idempotent; a conflicting
    -- receipt for the same request fails closed. Never a dispatch, only a record.
    CREATE TABLE IF NOT EXISTS job_email_send_receipt_correlations (
      receipt_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES job_email_send_request_sink(request_id) ON DELETE RESTRICT,
      proposal_id TEXT NOT NULL REFERENCES job_email_reply_draft_proposals(proposal_id) ON DELETE RESTRICT,
      application_id INTEGER REFERENCES applications(id) ON DELETE RESTRICT,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_message_id TEXT,
      receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
      receipt_digest TEXT NOT NULL CHECK (length(receipt_digest)=64),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_job_email_send_receipt_correlation_application
      ON job_email_send_receipt_correlations(application_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_email_send_receipt_correlation_thread
      ON job_email_send_receipt_correlations(thread_id, created_at DESC);
  `);
  createAppendOnlyTriggers(db, 'job_email_send_receipt_correlations');
  db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)')
    .run(SEND_RECEIPT_CORRELATION_SCHEMA_VERSION, SEND_RECEIPT_CORRELATION_MIGRATION_NAME);
}

// Append-only: rows are immutable once written (mirrors the email-integration
// createAppendOnlyTriggers convention). No UPDATE, no DELETE.
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

// -------------------------------------------------------------------------
// 1. Read-only context projection, digest-pinned into sourceStateSha256.
// -------------------------------------------------------------------------

function buildDraftReplyContext(db, source, researchInput) {
  const message = requireMessageBySource(db, source);
  const facts = JSON.parse(message.facts_json);
  const lockedRecipient = (message.reply_to_address || message.from_address).toLowerCase();

  // Optional company-research-via-broker capability (P3). Fail closed: when the
  // descriptor is absent, `research` is null (no research capability declared).
  // When present, it is normalized against the exact-allowlist broker policy so a
  // malformed / raw-internet allowlist is refused HERE, before it can be pinned
  // into sourceStateSha256 or handed to any runner.
  const research = normalizeCompanyResearch(researchInput);

  // The current selected, approved writing voice (Cole's own corpus).
  const voice = currentWritingVoice(db);
  // Any current approved recipient style profile bound to this thread.
  const styleProfile = currentThreadStyleProfile(db, message);
  // The correlated application record, if this message resolved to one.
  const application = correlatedApplication(db, message.id);
  // Past reply drafts already recorded for this thread (prior comms with the
  // contact), digested by content only — never carried as executable payload.
  const pastCommunications = threadReplyHistory(db, message);

  const projection = {
    schemaVersion: 'email-draft-reply-context.v1',
    // The inbound thread reference + sanitized facts. Untrusted, inert data.
    inboundThread: {
      provider: message.provider,
      accountId: message.account_id,
      messageId: message.message_id,
      threadId: message.thread_id,
      replyToAddress: message.reply_to_address,
      fromAddress: message.from_address,
      eventKind: message.event_kind,
      factsDigest: message.facts_digest
    },
    inboxFacts: sanitizedFactsProjection(facts),
    recipient: lockedRecipient,
    writingVoice: voice
      ? { revisionId: voice.revision_id, revisionDigest: voice.revision_digest }
      : null,
    styleProfile: styleProfile
      ? { profileId: styleProfile.profile_id, profileDigest: styleProfile.profile_digest }
      : null,
    application: application
      ? {
        applicationId: application.id,
        company: application.company,
        role: application.role,
        status: application.status,
        lockVersion: application.lock_version || 0
      }
      : null,
    pastCommunications: pastCommunications.map((entry) => ({
      proposalId: entry.proposal_id,
      proposalDigest: entry.proposal_digest,
      recipient: entry.recipient
    })),
    // Declarative research capability (default: null = no research). Pinned into
    // the digest below so a tampered allowlist / mode / target set fails closed at
    // issue time, exactly like the strategy source-checkpoint guard.
    research: research ? researchProjection(research) : null
  };
  // The pinned corpus digest. A stale corpus fails closed at issue time, exactly
  // like the strategy source-checkpoint guard.
  const sourceStateSha256 = digest(canonicalContext(projection));
  return { ...projection, sourceStateSha256 };
}

// The digested view of the declared research capability. It carries the exact
// broker mode, the validated network policy allowlist digest, the enumerated
// research targets, and the policy id — NEVER any fetched body, credential, or
// raw-internet URL. Pinning the policy DIGEST (not just its id) means a silently
// widened allowlist changes sourceStateSha256 and fails the issue closed.
function researchProjection(research) {
  return {
    capability: research.capability,
    mode: research.mode,
    networkPolicyId: research.networkPolicy.policyId,
    networkPolicyDigest: digest(research.networkPolicy),
    allowedOriginHosts: research.networkPolicy.allowedOrigins.map((origin) => origin.hostname),
    targets: research.targets.map((target) => ({ sourceKey: target.sourceKey, url: target.url }))
  };
}

// Only sanitized, non-executable facts fields feed the projection (the same
// closed shape JobTrack validates on import). Bodies / raw evidence excerpts are
// intentionally excluded from the digest key set.
function sanitizedFactsProjection(facts) {
  return {
    eventKind: facts.eventKind,
    replyRequested: Boolean(facts.replyRequested),
    company: facts.company ? { name: facts.company.name, domain: facts.company.domain } : null,
    postingRefs: Array.isArray(facts.postingRefs)
      ? facts.postingRefs.map((ref) => ({ roleTitle: ref.roleTitle || null }))
      : [],
    security: facts.security ? { risk: facts.security.risk, requiresReview: Boolean(facts.security.requiresReview) } : null
  };
}

function canonicalContext(projection) {
  // The projection is already the pure source view that gets digested — it holds
  // no digest field to strip and no non-canonical members to drop — so this is an
  // identity pass-through kept as a named seam for a future canonicalization step.
  // The actual code-unit canonicalization (the frozen-package rule) happens inside
  // digest()/stableJson() at the call site, not here.
  return projection;
}

// -------------------------------------------------------------------------
// 1a. Company-research-via-broker capability — DECLARATIVE, fail-closed.
//     Default: no research. When declared, an EXACT allowlist only; a target
//     outside that allowlist is refused. JobTrack makes no network call; the
//     external runner would drive the discovery-egress broker with this policy.
// -------------------------------------------------------------------------

function normalizeCompanyResearch(input) {
  // Fail closed: absent / null descriptor => no research capability at all.
  if (input === undefined || input === null) return null;
  const descriptor = plainObject(input, 'research');
  exactKeys(descriptor, 'research', ['capability', 'mode', 'networkPolicy', 'targets'],
    ['capability', 'networkPolicy', 'targets']);
  // Only the discovery-egress broker capability is composable here — never raw
  // internet, never an arbitrary tool handle.
  if (descriptor.capability !== RESEARCH_CAPABILITY) {
    throw new EmailDraftReplyError('RESEARCH_CAPABILITY_DENIED', `research.capability must be ${RESEARCH_CAPABILITY}`, {
      capability: descriptor.capability
    });
  }
  // A single fixed mode: the runner may only READ through the broker. Anything
  // else (a write / send / execute mode) is refused.
  const mode = descriptor.mode === undefined ? 'brokered-read' : descriptor.mode;
  if (mode !== 'brokered-read') {
    throw new EmailDraftReplyError('RESEARCH_MODE_DENIED', 'research.mode must be brokered-read', { mode });
  }
  // The allowlist IS the broker's fail-closed network policy. Validate it with the
  // EXACT validator the broker enforces at fetch time, so a malformed, private, or
  // non-normalized allowlist is refused here rather than at run time.
  let networkPolicy;
  try {
    networkPolicy = validateNetworkPolicy(descriptor.networkPolicy, 'research.networkPolicy');
  } catch (error) {
    throw new EmailDraftReplyError('RESEARCH_POLICY_INVALID', `research.networkPolicy is not a valid exact-allowlist broker policy: ${safeReason(error)}`, {
      reason: safeReason(error)
    });
  }
  // Defense in depth: the declared descriptor must not smuggle an executable,
  // credential, or send-shaped key past the request's forbidden-effects guard.
  assertNoEffectKeys(descriptor, 'research');
  const rawTargets = descriptor.targets;
  if (!Array.isArray(rawTargets) || rawTargets.length < 1 || rawTargets.length > MAX_RESEARCH_TARGETS) {
    throw new EmailDraftReplyError('INVALID_ARGUMENT', `research.targets must list 1 to ${MAX_RESEARCH_TARGETS} allowlisted URLs`);
  }
  const seen = new Set();
  const targets = rawTargets.map((rawTarget, index) => {
    const target = plainObject(rawTarget, `research.targets[${index}]`);
    exactKeys(target, `research.targets[${index}]`, ['sourceKey', 'url'], ['sourceKey', 'url']);
    // The sourceKey becomes the broker's fetch-intent requestId/sourceKey, so it
    // must satisfy the broker's stricter identifier rule (lowercase, no colon,
    // <=128) — not just JobTrack's looser identifier bound. Fail closed if not.
    const sourceKey = requireBrokerSourceKey(target.sourceKey, `research.targets[${index}].sourceKey`);
    const url = requireText(target.url, `research.targets[${index}].url`, 4096);
    // The refusal seam: every declared target must satisfy the SAME exact-allowlist
    // gate the broker applies per hop. A non-allowlisted origin / path / query is
    // refused now, so a bad allowlist never even reaches sourceStateSha256.
    assertResearchTargetAllowlisted(url, networkPolicy, `research.targets[${index}].url`);
    if (seen.has(url)) throw new EmailDraftReplyError('INVALID_ARGUMENT', `research.targets[${index}].url is duplicated`);
    seen.add(url);
    return { sourceKey, url };
  });
  return { capability: RESEARCH_CAPABILITY, mode, networkPolicy, targets };
}

// The declarative research capability the ISSUED request carries. Unlike the
// digested projection (which pins only digests + host names), the request body
// carries the full validated broker policy so an external runner can drive the
// discovery-egress broker directly with it. It is deliberately data-only: a broker
// MODE + a validated network POLICY (the exact allowlist) + the enumerated fetch
// intents the runner is permitted to issue. It contains NO effect key, NO fetched
// body, NO credential — assertNoEffectKeys re-verifies this before persistence.
function requestResearchCapability(research) {
  return {
    capability: research.capability,
    mode: research.mode,
    // The broker enforces this exact policy at fetch time; JobTrack only declares
    // it. The runner passes it to `discovery-egress once --policy ...`.
    networkPolicy: research.networkPolicy,
    networkPolicyId: research.networkPolicy.policyId,
    // Each target is a strict fetch-intent shell (no headers, no body). The runner
    // fills schemaVersion/kind/method as the broker's validateFetchIntent requires.
    fetchIntents: research.targets.map((target) => ({
      requestId: target.sourceKey,
      sourceKey: target.sourceKey,
      networkPolicyId: research.networkPolicy.policyId,
      url: target.url
    }))
  };
}

// Refuse a research target that the broker's exact allowlist would not permit.
// Reuses matchAllowedUrl (the broker's own per-hop gate) so the declared surface
// can never exceed what the broker will actually fetch.
function assertResearchTargetAllowlisted(url, networkPolicy, path) {
  try {
    matchAllowedUrl(url, networkPolicy);
  } catch (error) {
    if (error instanceof NetworkPolicyError) {
      throw new EmailDraftReplyError('RESEARCH_TARGET_DENIED', `${path} is not permitted by the declared exact allowlist: ${error.code}`, {
        url, code: error.code
      });
    }
    throw new EmailDraftReplyError('RESEARCH_TARGET_DENIED', `${path} is not permitted by the declared exact allowlist: ${safeReason(error)}`, {
      url
    });
  }
}

function safeReason(error) {
  return String(error && error.message || 'invalid').replace(/[\r\n]+/g, ' ').slice(0, 300);
}

// -------------------------------------------------------------------------
// 2. Declarative request builder — emits a bounded_internal_request, no run.
// -------------------------------------------------------------------------

function issueDraftReplyRequest(db, input, idempotentOperation) {
  const requestId = requireIdentifier(input.requestId, 'requestId');
  const issuedBy = requireText(input.issuedBy, 'issuedBy', 200);
  const expectedSourceStateSha256 = requireSha256(input.expectedSourceStateSha256, 'expectedSourceStateSha256');
  const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey', 500);
  const source = requireSource(input.source);
  const budget = normalizeBudget(input.budget);
  // The declared company-research capability (P3), fail-closed: default off. The
  // descriptor is normalized once here and threaded into BOTH the pinned context
  // digest and the request body, so the issued request and its sourceStateSha256
  // agree on the exact allowlist.
  const research = normalizeCompanyResearch(input.research);
  // budget is part of the request identity: two issues with the same requestId /
  // source / source-state but DIFFERENT budgets are genuinely different requests.
  // Excluding it would let the second (different-budget) issue dedupe silently to
  // the first result. Include it so a conflicting-budget re-issue fails closed with
  // an IDEMPOTENCY_CONFLICT rather than returning the wrong (already-issued) budget.
  const intent = { requestId, issuedBy, expectedSourceStateSha256, source, budget };
  return idempotentOperation(db, 'draft-reply-issue', idempotencyKey, intent, () => {
    const message = requireMessageBySource(db, source);
    const context = buildDraftReplyContext(db, source, input.research);
    // Fail closed on a stale corpus (the strategy checkpoint-delta guard).
    if (context.sourceStateSha256 !== expectedSourceStateSha256) {
      throw new EmailDraftReplyError('SOURCE_STATE_STALE', 'Expected source state differs from the current read-only context projection', {
        expected: expectedSourceStateSha256, actual: context.sourceStateSha256
      });
    }
    const requestBody = {
      schemaVersion: 'email-draft-reply-request.v1',
      // The trust marker: this is a bounded request JobTrack authored for a
      // model turn it will NOT execute. Same marker the strategy runner uses.
      trust: 'bounded_internal_request',
      requestId,
      route: { alias: DRAFT_REPLY_ROUTE_ALIAS },
      output: {
        contractId: DRAFT_REPLY_OUTPUT_CONTRACT,
        provenanceContractId: 'draft-provenance-receipt.v1'
      },
      recipient: context.recipient,
      inboundThread: context.inboundThread,
      contextProjection: context,
      sourceStateSha256: context.sourceStateSha256,
      budget,
      // The declarative research capability the runner MAY use (never JobTrack).
      // Absent => the request carries no research capability at all. When present,
      // it exposes ONLY the exact-allowlist broker policy + the enumerated targets,
      // never a fetched body, a credential, or a raw-internet URL.
      research: research ? requestResearchCapability(research) : null,
      safety: {
        proposalOnly: true,
        externalActionsAllowed: false,
        sourceTextIsInertData: true,
        forbiddenEffects: [...FORBIDDEN_EFFECTS]
      }
    };
    // Defense in depth: reject any executable/tool/credential-shaped payload
    // before it can be persisted.
    assertNoEffectKeys(requestBody, 'draftReplyRequest');
    const requestJson = stableJson(requestBody);
    const requestBytes = Buffer.byteLength(requestJson, 'utf8');
    if (requestBytes > MAX_DRAFT_REQUEST_BYTES) {
      throw new EmailDraftReplyError('REQUEST_BYTES_LIMIT', `Draft reply request exceeds the ${MAX_DRAFT_REQUEST_BYTES}-byte safety limit`, {
        bytes: requestBytes, limit: MAX_DRAFT_REQUEST_BYTES
      });
    }
    const requestDigest = digest(requestJson);
    const existing = db.prepare('SELECT request_digest FROM job_email_draft_reply_requests WHERE request_id=?').get(requestId);
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new EmailDraftReplyError('REQUEST_CONFLICT', 'Draft reply request ID was reused with different content');
      return draftReplyResult('draft-reply-issue', { requestId, requestDigest, sourceStateSha256: context.sourceStateSha256, reused: true, executed: false });
    }
    db.prepare(`
      INSERT INTO job_email_draft_reply_requests(
        request_id, message_ref_id, facts_digest, route_alias, source_state_sha256,
        request_json, request_digest, issued_by
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(
      requestId, message.id, message.facts_digest, DRAFT_REPLY_ROUTE_ALIAS,
      context.sourceStateSha256, requestJson, requestDigest, issuedBy
    );
    return draftReplyResult('draft-reply-issue', {
      requestId,
      requestDigest,
      sourceStateSha256: context.sourceStateSha256,
      routeAlias: DRAFT_REPLY_ROUTE_ALIAS,
      reused: false,
      // JobTrack does NOT run the model. The runner is external/manual.
      executed: false,
      request: requestBody
    });
  });
}

// -------------------------------------------------------------------------
// 3. Record path — validates a returned proposal.v2 + provenance receipt.
// -------------------------------------------------------------------------

function recordDraftReplyResult(db, rawInput, idempotencyKey, deps) {
  const { proposeReplyDraft, idempotentOperation } = deps;
  const input = plainObject(rawInput, 'draftReplyResult');
  exactKeys(input, 'draftReplyResult', ['requestId', 'proposal', 'provenance'], ['requestId', 'proposal', 'provenance']);
  const requestId = requireIdentifier(input.requestId, 'requestId');
  const proposal = validateReplyDraftProposalV2(input.proposal);
  const provenance = validateDraftProvenanceReceipt(input.provenance);
  const key = requireText(idempotencyKey, 'idempotencyKey', 500);
  return idempotentOperation(db, 'draft-reply-record', key, { requestId, proposal, provenance }, () => {
    const request = db.prepare('SELECT * FROM job_email_draft_reply_requests WHERE request_id=?').get(requestId);
    if (!request) throw new EmailDraftReplyError('NOT_FOUND', `Draft reply request not found: ${requestId}`);
    // Bind the result to the exact request source-state. The DRAFT-REPLY context
    // digest (the read-only corpus projection this request pinned) is carried by
    // the provenance receipt's sourceStateSha256; a stale/forged result fails
    // closed here. NOTE: the reply proposal's own sourceStateSha256 is a distinct
    // digest — the communication-context state the tone/voice/style machinery
    // binds (validated inside proposeReplyDraft/persistReplyStyleBinding), not
    // the draft-reply corpus digest — so it is intentionally not equated here.
    if (provenance.sourceStateSha256 !== request.source_state_sha256) {
      throw new EmailDraftReplyError('SOURCE_DIGEST_MISMATCH', 'Provenance source state differs from the issued request');
    }
    if (proposal.factsDigest !== request.facts_digest || provenance.factsDigest !== request.facts_digest) {
      throw new EmailDraftReplyError('FACTS_DIGEST_MISMATCH', 'Result facts digest does not match the issued request');
    }
    const proposalDigest = digest(proposal);
    if (provenance.draftProposalId !== proposal.proposalId) {
      throw new EmailDraftReplyError('PROPOSAL_BINDING_MISMATCH', 'Provenance receipt does not name the recorded reply proposal');
    }
    if (provenance.draftProposalDigest !== proposalDigest) {
      throw new EmailDraftReplyError('PROPOSAL_DIGEST_MISMATCH', 'Provenance receipt draft digest does not match the reply proposal bytes');
    }
    // Route provenance must match the request's route alias.
    if (provenance.generatedBy.routeAlias && provenance.generatedBy.routeAlias !== request.route_alias) {
      throw new EmailDraftReplyError('ROUTE_MISMATCH', 'Provenance route alias differs from the issued request');
    }
    // The reply proposal itself goes through the EXISTING proposed->approved
    // state machine (recipient-locked, auto_send_eligible=0). We do not
    // duplicate its storage; we delegate to proposeReplyDraft.
    const proposalKey = `${key}:proposal`;
    const proposed = proposeReplyDraft(db, proposal, proposalKey);
    // Mandatory usage receipt with an explicit trust tier. A below-floor tier is
    // surfaced, never silently accepted.
    const usageTrust = provenance.usage.trust;
    const trustBelowFloor = (TRUST_TIER_RANK[usageTrust] ?? 0) < TRUSTED_USAGE_FLOOR;
    const receiptDigest = digest(provenance);
    const existing = db.prepare('SELECT receipt_digest FROM job_email_draft_reply_provenance WHERE request_id=?').get(requestId);
    if (existing) {
      if (existing.receipt_digest !== receiptDigest) throw new EmailDraftReplyError('PROVENANCE_CONFLICT', 'Draft reply request already has a different provenance receipt');
    } else {
      db.prepare(`
        INSERT INTO job_email_draft_reply_provenance(
          receipt_id, request_id, proposal_id, draft_proposal_digest, usage_trust,
          receipt_json, receipt_digest
        ) VALUES (?,?,?,?,?,?,?)
      `).run(
        provenance.receiptId, requestId, proposal.proposalId, proposalDigest, usageTrust,
        stableJson(provenance), receiptDigest
      );
    }
    return draftReplyResult('draft-reply-record', {
      requestId,
      proposalId: proposal.proposalId,
      proposalDigest,
      provenanceReceiptId: provenance.receiptId,
      usageTrust,
      usageTrustBelowFloor: trustBelowFloor,
      autoSendEnabled: false,
      reused: Boolean(proposed?.reused)
    });
  });
}

// -------------------------------------------------------------------------
// 4. Approve exact bytes -> emit email-send-request.v1 to the DRY-RUN sink.
// -------------------------------------------------------------------------

function approveDraftReplySend(db, input, deps) {
  const { reviewReplyDraft, idempotentOperation } = deps;
  const proposalId = requireIdentifier(input.proposalId, 'proposalId');
  const approvedBy = requireText(input.approvedBy, 'approvedBy', 320);
  const expectedProposalDigest = requireSha256(input.expectedProposalDigest, 'expectedProposalDigest');
  const key = requireText(input.idempotencyKey, 'idempotencyKey', 500);
  const approvedAt = input.approvedAt ? requireIsoTimestamp(input.approvedAt, 'approvedAt') : new Date().toISOString();
  const intent = { proposalId, approvedBy, expectedProposalDigest, approvedAt };
  return idempotentOperation(db, 'draft-reply-approve-send', key, intent, () => {
    const stored = db.prepare('SELECT * FROM job_email_reply_draft_proposals WHERE proposal_id=?').get(proposalId);
    if (!stored) throw new EmailDraftReplyError('NOT_FOUND', `Reply draft proposal not found: ${proposalId}`);
    // Approval binds the EXACT immutable draft-artifact digest. A digest the
    // approver did not see fails closed.
    if (stored.proposal_digest !== expectedProposalDigest) {
      throw new EmailDraftReplyError('PROPOSAL_DIGEST_MISMATCH', 'Approval does not bind the exact recorded draft-artifact digest', {
        expected: expectedProposalDigest, actual: stored.proposal_digest
      });
    }
    const proposal = validateReplyDraftProposalV2(JSON.parse(stored.proposal_json));
    // Recipient is locked to the proposal (already == source.replyToAddress).
    const recipient = proposal.recipient;
    const threadId = proposal.source.threadId;
    // Drive the existing proposed->approved reply state machine (side effect;
    // the reply proposal stays recipient-locked with auto_send_eligible=0).
    reviewReplyDraft(db, {
      proposalId, decision: 'approved', decidedBy: approvedBy, idempotencyKey: `${key}:review`
    });
    // Build the approval-receipt.v1: this human approved exactly these bytes for
    // a single send to the locked recipient. FROZEN v1: no signature required.
    const approvalReceipt = {
      schemaVersion: 'approval-receipt.v1',
      // `approval:${proposalId}` would exceed the 200-char identifier bound
      // validateApprovalReceipt enforces for a max-length proposalId; bound it.
      approvalId: deriveBoundedIdentifier('approval:', proposalId),
      approvedArtifactContractId: DRAFT_REPLY_OUTPUT_CONTRACT,
      approvedArtifactDigest: stored.proposal_digest,
      approver: { kind: 'human', id: approvedBy },
      approvedAt,
      scope: { action: 'send-once', recipient, threadId }
    };
    // Build the email-send-request.v1: FROZEN v1 content = draft_artifact digest
    // reference (no bytes inline). Idempotency key dedupes the send.
    const idempotencyKey = deriveSendIdempotencyKey(proposalId, stored.proposal_digest);
    const sendRequest = {
      schemaVersion: 'email-send-request.v1',
      // `send:${proposalId}` would exceed the 200-char identifier bound
      // validateEmailSendRequest enforces for a max-length proposalId; bound it.
      requestId: deriveBoundedIdentifier('send:', proposalId),
      idempotencyKey,
      recipient,
      inReplyTo: proposal.source.messageId,
      threadId,
      content: {
        mode: 'draft_artifact',
        contractId: DRAFT_REPLY_OUTPUT_CONTRACT,
        digest: stored.proposal_digest
      },
      approval: approvalReceipt
    };
    // Validate the emitted artifacts against the checked-in frozen schemas
    // (schema + code-side cross-field invariants) before persisting.
    const validatedSendRequest = validateEmailSendRequest(sendRequest);
    const sendRequestDigest = digest(validatedSendRequest);
    const existing = db.prepare('SELECT send_request_digest FROM job_email_send_request_sink WHERE request_id=?').get(validatedSendRequest.requestId);
    if (existing) {
      if (existing.send_request_digest !== sendRequestDigest) throw new EmailDraftReplyError('SEND_REQUEST_CONFLICT', 'Send request ID was reused with different content');
    } else {
      // Emit to the DRY-RUN sink. Never delivered, never pushed to Inbox.
      db.prepare(`
        INSERT INTO job_email_send_request_sink(
          request_id, idempotency_key, proposal_id, draft_artifact_digest, recipient,
          thread_id, sink, send_request_json, send_request_digest, approval_receipt_json, emitted_by
        ) VALUES (?,?,?,?,?,?, 'dry-run', ?,?,?,?)
      `).run(
        validatedSendRequest.requestId, idempotencyKey, proposalId, stored.proposal_digest, recipient,
        threadId, stableJson(validatedSendRequest), sendRequestDigest, stableJson(approvalReceipt), approvedBy
      );
    }
    return draftReplyResult('draft-reply-approve-send', {
      proposalId,
      approvedBy,
      approvedArtifactDigest: stored.proposal_digest,
      sendRequestId: validatedSendRequest.requestId,
      sendRequestDigest,
      idempotencyKey,
      sink: 'dry-run',
      delivered: false,
      reviewState: 'approved'
    });
  });
}

// Correlation: record a returned email-send-receipt.v1 against the sink AND the
// application/thread it belongs to, append-only, closing the loop. It validates
// the receipt, cross-checks it against the exact emitted send request, then
// PERSISTS it into the append-only send-receipt correlation ledger — bound to the
// sink row, the reply proposal, the thread, and (when the inbound message resolved
// to one) the correlated application. Data-only; JobTrack dispatches nothing.
//
// Idempotency: re-correlating the exact same receipt is a no-op that returns the
// recorded state; a second, DIFFERENT receipt for the same emitted request fails
// closed (the ledger keeps one correlated receipt per send request).
function correlateSendReceipt(db, rawReceipt) {
  const receipt = validateEmailSendReceipt(rawReceipt);
  const sink = db.prepare('SELECT * FROM job_email_send_request_sink WHERE request_id=?').get(receipt.requestId);
  if (!sink) throw new EmailDraftReplyError('NOT_FOUND', `Send request not found in sink: ${receipt.requestId}`);
  if (sink.send_request_digest !== receipt.requestDigest) {
    throw new EmailDraftReplyError('REQUEST_DIGEST_MISMATCH', 'Send receipt does not bind the exact emitted send request');
  }
  if (sink.idempotency_key !== receipt.idempotencyKey) {
    throw new EmailDraftReplyError('IDEMPOTENCY_MISMATCH', 'Send receipt idempotency key differs from the emitted request');
  }
  // Resolve the application/thread the emitted send request belongs to. The sink
  // row carries the proposal + thread; the proposal's message ref resolves to the
  // correlated application (when the inbound message linked to one). A missing
  // application is legitimate (an unlinked thread) — recorded as NULL, not an error.
  const proposalRow = db.prepare('SELECT message_ref_id FROM job_email_reply_draft_proposals WHERE proposal_id=?')
    .get(sink.proposal_id);
  const application = proposalRow ? correlatedApplication(db, proposalRow.message_ref_id) : null;
  const applicationId = application ? application.id : null;
  const receiptDigest = digest(receipt);
  // Append-only: one correlated receipt per emitted send request. A replay of the
  // exact same receipt returns the recorded state; a conflicting receipt (a second
  // receipt for the same send request with different bytes) fails closed.
  const existing = db.prepare('SELECT receipt_id, receipt_digest FROM job_email_send_receipt_correlations WHERE request_id=?')
    .get(receipt.requestId);
  if (existing) {
    if (existing.receipt_digest !== receiptDigest) {
      throw new EmailDraftReplyError('RECEIPT_CONFLICT', 'Send request already has a different correlated receipt', {
        requestId: receipt.requestId
      });
    }
    // A replay of the already-recorded receipt: return the recorded state without
    // appending a second row (recorded=false ⇒ this call wrote nothing new).
    return correlateResult(receipt, applicationId, sink.thread_id, false);
  }
  db.prepare(`
    INSERT INTO job_email_send_receipt_correlations(
      receipt_id, request_id, proposal_id, application_id, thread_id, status,
      provider_message_id, receipt_json, receipt_digest
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    receipt.receiptId, receipt.requestId, sink.proposal_id, applicationId, sink.thread_id,
    receipt.status, receipt.providerMessageId ?? null, stableJson(receipt), receiptDigest
  );
  // This call wrote the correlation into the append-only ledger (recorded=true).
  return correlateResult(receipt, applicationId, sink.thread_id, true);
}

// `recorded` is true only when THIS call appended the correlation to the ledger;
// a replay of the same receipt returns the recorded state with recorded=false.
function correlateResult(receipt, applicationId, threadId, recorded) {
  return {
    schemaVersion: 'job-email-command-result.v1',
    command: 'draft-reply-correlate-receipt',
    receipt,
    correlation: {
      receiptId: receipt.receiptId,
      requestId: receipt.requestId,
      applicationId: applicationId ?? null,
      threadId,
      status: receipt.status,
      recorded
    }
  };
}

// -------------------------------------------------------------------------
// Read-only helpers over the corpus.
// -------------------------------------------------------------------------

function requireMessageBySource(db, source) {
  const message = db.prepare(`
    SELECT * FROM job_email_message_refs WHERE provider=? AND account_id=? AND message_id=?
  `).get(source.provider, source.accountId, source.messageId);
  if (!message) throw new EmailDraftReplyError('MESSAGE_NOT_FOUND', 'Import email facts before drafting a reply');
  if (source.threadId && message.thread_id !== source.threadId) {
    throw new EmailDraftReplyError('MESSAGE_CONFLICT', 'Thread ID differs from the imported message');
  }
  return message;
}

function currentWritingVoice(db) {
  if (!tableExists(db, 'profile_email_writing_voice_current')) return null;
  return db.prepare(`
    SELECT current.revision_id, revision.revision_digest
    FROM profile_email_writing_voice_current current
    JOIN profile_email_writing_voice_revisions revision ON revision.revision_id=current.revision_id
    LIMIT 1
  `).get() || null;
}

function currentThreadStyleProfile(db, message) {
  if (!tableExists(db, 'job_email_recipient_style_profiles') || !tableExists(db, 'job_email_threads')) return null;
  const thread = db.prepare(`
    SELECT id FROM job_email_threads WHERE provider=? AND account_id=? AND thread_id=?
  `).get(message.provider, message.account_id, message.thread_id);
  if (!thread) return null;
  return db.prepare(`
    SELECT profile_id, profile_digest FROM job_email_recipient_style_profiles
    WHERE scope_kind='thread' AND thread_ref_id=?
    ORDER BY version DESC LIMIT 1
  `).get(thread.id) || null;
}

function correlatedApplication(db, messageRefId) {
  if (!tableExists(db, 'job_email_correlations')) return null;
  const correlationSource = db.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name='active_job_email_linked_correlations'").get()
    ? 'active_job_email_linked_correlations'
    : 'job_email_correlations';
  const correlation = db.prepare(`
    SELECT resolved_application_id FROM ${correlationSource}
    WHERE message_ref_id=? AND resolution='linked' AND resolved_application_id IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(messageRefId);
  if (!correlation) return null;
  return db.prepare('SELECT id, company, role, status, lock_version FROM applications WHERE id=?')
    .get(correlation.resolved_application_id) || null;
}

function threadReplyHistory(db, message) {
  return db.prepare(`
    SELECT proposal.proposal_id, proposal.proposal_digest, proposal.recipient
    FROM job_email_reply_draft_proposals proposal
    JOIN job_email_message_refs ref ON ref.id=proposal.message_ref_id
    WHERE ref.provider=? AND ref.account_id=? AND ref.thread_id=?
    ORDER BY proposal.created_at ASC, proposal.rowid ASC
    LIMIT ${MAX_PAST_COMMUNICATIONS}
  `).all(message.provider, message.account_id, message.thread_id);
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

// Defense in depth: reject any executable / tool / credential-shaped key in the
// request body (mirrors application-strategy-contracts assertNoEffectKeys).
function assertNoEffectKeys(value, path) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoEffectKeys(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (EFFECT_KEYS.has(key.toLowerCase())) {
      throw new EmailDraftReplyError('FORBIDDEN_EFFECT_KEY', `Draft reply request must not carry an executable/effect key: ${path}.${key}`);
    }
    assertNoEffectKeys(child, `${path}.${key}`);
  }
}

const EFFECT_KEYS = new Set([
  'command', 'commands', 'exec', 'execute', 'shell', 'script', 'tool', 'tools', 'toolcall',
  'toolcalls', 'function_call', 'send', 'sendemail', 'apply', 'credential', 'credentials',
  'secret', 'secrets', 'token', 'apikey', 'authorization', 'bearer', 'password', 'privatekey'
]);

function deriveSendIdempotencyKey(proposalId, digestValue) {
  const hash = crypto.createHash('sha256').update(`${proposalId}:${digestValue}`).digest('hex').slice(0, 32);
  return `send-${hash}`;
}

// Derive a `${prefix}${proposalId}` identifier that ALWAYS satisfies the 200-char
// identifier bound the frozen contract validators (validateEmailSendRequest,
// validateApprovalReceipt) enforce. A proposalId at its own 200-char bound would
// push a prefixed value past 200 and fail those checks. Keep the readable
// `${prefix}${proposalId}` form when it fits; otherwise deterministically fold
// the full proposalId into a bounded 64-hex suffix so the result stays a valid,
// unique-per-proposalId identifier. The prefix, `:`, and hex digest are all
// inside the identifier charset (/^[A-Za-z0-9._:-]+$/), and every supported
// prefix here keeps `${prefix}${64-hex}` well under 200 chars.
const IDENTIFIER_MAX_LENGTH = 200;

function deriveBoundedIdentifier(prefix, proposalId) {
  const readable = `${prefix}${proposalId}`;
  if (readable.length <= IDENTIFIER_MAX_LENGTH) return readable;
  const hash = crypto.createHash('sha256').update(proposalId).digest('hex');
  return `${prefix}${hash}`;
}

// -------------------------------------------------------------------------
// Input validation (bounded, additive; mirrors email-integration helpers).
// -------------------------------------------------------------------------

function requireSource(value) {
  const source = plainObject(value, 'source');
  exactKeys(source, 'source', ['provider', 'accountId', 'messageId', 'threadId'], ['provider', 'accountId', 'messageId']);
  requireText(source.provider, 'source.provider', 20);
  requireText(source.accountId, 'source.accountId', 320);
  requireText(source.messageId, 'source.messageId', 500);
  if (source.threadId !== undefined) requireText(source.threadId, 'source.threadId', 500);
  return source;
}

function normalizeBudget(value) {
  if (value === undefined) return { ...DEFAULT_BUDGET };
  const budget = plainObject(value, 'budget');
  exactKeys(budget, 'budget', ['maxInputTokens', 'maxOutputTokens', 'maxCostMicros', 'maxDurationMs'],
    ['maxInputTokens', 'maxOutputTokens', 'maxCostMicros', 'maxDurationMs']);
  for (const key of ['maxInputTokens', 'maxOutputTokens', 'maxCostMicros', 'maxDurationMs']) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] < 1) {
      throw new EmailDraftReplyError('INVALID_ARGUMENT', `budget.${key} must be a positive integer`);
    }
  }
  return budget;
}

function requireIdentifier(value, label) {
  requireText(value, label, 200);
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw new EmailDraftReplyError('INVALID_ARGUMENT', `${label} must be a stable identifier`);
  return value;
}

// The broker's fetch-intent identifier rule (discovery-sandbox network-policy.js
// ID pattern): lowercase, no colon, 1..128, no leading/trailing separator. A
// research sourceKey that would fail the broker's own validateFetchIntent is
// refused here rather than at run time.
const BROKER_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;

function requireBrokerSourceKey(value, label) {
  requireText(value, label, 128);
  if (!BROKER_ID.test(value)) throw new EmailDraftReplyError('INVALID_ARGUMENT', `${label} must be a broker-compatible identifier (lowercase, no colon)`);
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new EmailDraftReplyError('INVALID_ARGUMENT', `${label} must be a lowercase SHA-256 digest`);
  return value;
}

function requireIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !value.includes('T') || !Number.isFinite(Date.parse(value))) {
    throw new EmailDraftReplyError('INVALID_ARGUMENT', `${label} must be an ISO date-time`);
  }
  return value;
}

function requireText(value, label, max) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new EmailDraftReplyError('INVALID_ARGUMENT', `${label} must be a string from 1 to ${max} characters`);
  }
  return value;
}

function plainObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new EmailDraftReplyError('INVALID_ARGUMENT', `${path} must be an object`);
  return value;
}

function exactKeys(value, path, allowed, required) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw new EmailDraftReplyError('INVALID_ARGUMENT', `${path} contains unknown field(s): ${unknown.sort().join(', ')}`);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new EmailDraftReplyError('INVALID_ARGUMENT', `${path}.${key} is required`);
  }
}

function draftReplyResult(command, fields) {
  return { schemaVersion: 'job-email-command-result.v1', command, ...fields };
}

// -------------------------------------------------------------------------
// Read-only lifecycle projection (JT-4). Collapses the reply-draft -> approval
// -> send-request -> send-receipt lifecycle to inert OPERATOR METADATA over the
// SAME store the CLI writes. It exposes ONLY: state/status, the pinned digests
// (draftProposalDigest / approvedArtifactDigest / requestDigest), the
// recipient-locked flag, a collapsed thread/contact register (provider + thread
// id + sender DOMAIN + optional company/role — never the exact private address),
// and timestamps. It NEVER reads or returns raw draft prose, message bodies,
// evidence excerpts, exact private email addresses, voice samples, or the
// approver's raw identity. Digests are digests, not content: they carry no
// recoverable body. This is a pure SELECT projection — it opens no network,
// runs no model, and (like the whole web tier) never writes.
//
// One row per reply-draft PROPOSAL — the durable spine of the lifecycle. Each
// proposal joins to its issuing request, provenance receipt, dry-run send-request
// sink emission, and correlated send-receipt when those stages exist. Absent
// stages read as `pending`, never as failure.

const LIFECYCLE_PROPOSAL_LIMIT = 500;

// A collapse of an exact private email address to a non-identifying register.
// The exact local-part (and, for a personal mailbox, the full address) is a
// private identifier per the AGENTS.md read-only rule; we surface only the
// DOMAIN, which is already public routing metadata (and is what the sanitized
// thread/contact register elsewhere shows). A malformed / empty value collapses
// to a fixed sentinel rather than leaking the raw string.
function collapseAddressToDomain(value) {
  if (typeof value !== 'string') return null;
  const at = value.lastIndexOf('@');
  if (at < 0 || at === value.length - 1) return null;
  const domain = value.slice(at + 1).trim().toLowerCase();
  // A domain must look like a domain; anything else is withheld entirely.
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

// The latest reply-draft review event (`proposed` | `approved` | `rejected`) is
// the proposal's review state; absent events read as `proposed`.
function latestReplyReviewState(db, proposalId) {
  const row = db.prepare(`
    SELECT event_kind FROM job_email_reply_draft_events
    WHERE proposal_id=? ORDER BY id DESC LIMIT 1
  `).get(proposalId);
  return row ? row.event_kind : 'proposed';
}

// Derive the collapsed lifecycle state from the presence/status of each stage.
// The send-receipt status (sent | skipped | failed) dominates once a receipt is
// correlated; before that the state tracks drafting -> approval -> emission.
function deriveLifecycleState({ reviewState, emitted, receiptStatus }) {
  if (receiptStatus) return `receipt-${receiptStatus}`;
  if (emitted) return 'send-request-emitted';
  if (reviewState === 'approved') return 'approved';
  if (reviewState === 'rejected') return 'rejected';
  return 'draft-proposed';
}

// Build the collapsed operator projection of the reply lifecycle. `db` is the
// read-only snapshot handle the web tier already opens (query_only=ON). Returns
// null on a store that predates the reply-draft schema so callers render an
// empty section rather than error. Never returns prose, bodies, or exact
// addresses; every recipient is collapsed to its domain + a recipient-locked
// flag, and every digest is a bare 64-hex string.
function readReplyLifecycleSummary(db, options = {}) {
  const required = [
    'job_email_reply_draft_proposals', 'job_email_reply_draft_events',
    'job_email_message_refs', 'job_email_send_request_sink'
  ];
  if (!required.every((name) => tableExists(db, name))) return null;
  const hasReceipts = tableExists(db, 'job_email_send_receipt_correlations');
  const hasRequests = tableExists(db, 'job_email_draft_reply_requests');
  const hasProvenance = tableExists(db, 'job_email_draft_reply_provenance');
  const limit = Math.min(
    Number.isInteger(options.limit) && options.limit > 0 ? options.limit : LIFECYCLE_PROPOSAL_LIMIT,
    LIFECYCLE_PROPOSAL_LIMIT
  );

  const proposals = db.prepare(`
    SELECT
      proposal.proposal_id      AS proposalId,
      proposal.message_ref_id   AS messageRefId,
      proposal.proposal_digest  AS draftProposalDigest,
      proposal.authorship       AS authorship,
      proposal.requires_review  AS requiresReview,
      proposal.auto_send_eligible AS autoSendEligible,
      proposal.recipient        AS recipient,
      proposal.created_at       AS draftedAt,
      ref.provider              AS provider,
      ref.account_id            AS accountId,
      ref.thread_id             AS threadId,
      ref.from_domain           AS fromDomain,
      ref.reply_to_address      AS replyToAddress
    FROM job_email_reply_draft_proposals proposal
    JOIN job_email_message_refs ref ON ref.id=proposal.message_ref_id
    ORDER BY proposal.created_at DESC, proposal.rowid DESC
    LIMIT ?
  `).all(limit);

  const sinkByProposal = new Map();
  for (const row of db.prepare(`
    SELECT proposal_id AS proposalId, request_id AS requestId,
      draft_artifact_digest AS approvedArtifactDigest, send_request_digest AS requestDigest,
      sink, recipient, thread_id AS threadId, created_at AS emittedAt
    FROM job_email_send_request_sink
  `).all()) sinkByProposal.set(row.proposalId, row);

  const provenanceByProposal = new Map();
  if (hasProvenance) {
    for (const row of db.prepare(`
      SELECT proposal_id AS proposalId, draft_proposal_digest AS draftProposalDigest,
        usage_trust AS usageTrust, created_at AS recordedAt
      FROM job_email_draft_reply_provenance
    `).all()) provenanceByProposal.set(row.proposalId, row);
  }

  // The issuing bounded_internal_request links to the PROPOSAL through the
  // provenance receipt (request_id + proposal_id), NOT through the send-request
  // sink (whose request_id is the separate `send:...` id). Join accordingly so
  // the issued route/source-state digests bind to the right proposal.
  const requestByProposal = new Map();
  if (hasRequests && hasProvenance) {
    for (const row of db.prepare(`
      SELECT provenance.proposal_id AS proposalId, request.route_alias AS routeAlias,
        request.source_state_sha256 AS sourceStateSha256, request.request_digest AS issuedRequestDigest,
        request.created_at AS issuedAt
      FROM job_email_draft_reply_provenance provenance
      JOIN job_email_draft_reply_requests request ON request.request_id=provenance.request_id
    `).all()) requestByProposal.set(row.proposalId, row);
  }

  const receiptByProposal = new Map();
  if (hasReceipts) {
    for (const row of db.prepare(`
      SELECT proposal_id AS proposalId, receipt_id AS receiptId, request_id AS requestId,
        application_id AS applicationId, thread_id AS threadId, status AS status,
        receipt_digest AS receiptDigest, created_at AS receiptAt,
        (provider_message_id IS NOT NULL) AS hasProviderMessageId
      FROM job_email_send_receipt_correlations
      ORDER BY created_at DESC, rowid DESC
    `).all()) {
      // Keep only the latest correlated receipt per proposal (one per emitted
      // request in practice; this is defensive against duplicates).
      if (!receiptByProposal.has(row.proposalId)) receiptByProposal.set(row.proposalId, row);
    }
  }

  const applicationCache = new Map();
  const applicationLabel = (applicationId) => {
    if (applicationId === null || applicationId === undefined) return null;
    if (applicationCache.has(applicationId)) return applicationCache.get(applicationId);
    const app = db.prepare('SELECT company, role, status FROM applications WHERE id=?').get(applicationId) || null;
    const label = app ? { id: applicationId, company: app.company, role: app.role, status: app.status } : null;
    applicationCache.set(applicationId, label);
    return label;
  };

  const counts = { total: 0, drafted: 0, approved: 0, rejected: 0, emitted: 0, sent: 0, skipped: 0, failed: 0 };

  const lifecycle = proposals.map((proposal) => {
    const reviewState = latestReplyReviewState(db, proposal.proposalId);
    const sink = sinkByProposal.get(proposal.proposalId) || null;
    const provenance = provenanceByProposal.get(proposal.proposalId) || null;
    const receipt = receiptByProposal.get(proposal.proposalId) || null;
    const request = requestByProposal.get(proposal.proposalId) || null;
    const receiptStatus = receipt ? receipt.status : null;
    const state = deriveLifecycleState({ reviewState, emitted: Boolean(sink), receiptStatus });

    // The correlated application: prefer the receipt's binding, else resolve the
    // proposal's OWN inbound message ref to a linked application. Company/role are
    // safe register metadata; the exact address is not exposed anywhere here.
    let application = receipt ? applicationLabel(receipt.applicationId) : null;
    if (!application) {
      const correlated = correlatedApplication(db, proposal.messageRefId);
      application = correlated ? { id: correlated.id, company: correlated.company, role: correlated.role, status: correlated.status } : null;
    }

    counts.total += 1;
    if (state === 'draft-proposed') counts.drafted += 1;
    if (reviewState === 'approved') counts.approved += 1;
    if (reviewState === 'rejected') counts.rejected += 1;
    if (sink) counts.emitted += 1;
    // Receipt statuses are the frozen email-send-receipt.v1 enum:
    // sent | skipped_duplicate | failed.
    if (receiptStatus === 'sent') counts.sent += 1;
    if (receiptStatus === 'skipped_duplicate') counts.skipped += 1;
    if (receiptStatus === 'failed') counts.failed += 1;

    // The send is recipient-locked: the emitted send-request pins exactly one
    // recipient (== the proposal's reply-to) with a send-once approval scope and
    // auto_send_eligible=0. Surface that as a boolean flag + a collapsed domain,
    // never the exact address.
    const recipientDomain = collapseAddressToDomain(sink ? sink.recipient : proposal.recipient)
      || collapseAddressToDomain(proposal.replyToAddress)
      || proposal.fromDomain
      || null;

    return {
      proposalId: proposal.proposalId,
      state,
      reviewState,
      authorship: proposal.authorship,
      requiresReview: Boolean(proposal.requiresReview),
      // Recipient-locked is ALWAYS true for a reply-draft: the recipient is
      // pinned to the inbound reply-to and auto-send stays disabled. Expose the
      // invariant explicitly for the operator.
      recipientLocked: true,
      autoSendEligible: Boolean(proposal.autoSendEligible),
      recipientDomain,
      thread: {
        provider: proposal.provider,
        threadId: proposal.threadId,
        senderDomain: proposal.fromDomain || null
      },
      application,
      digests: {
        draftProposalDigest: proposal.draftProposalDigest,
        approvedArtifactDigest: sink ? sink.approvedArtifactDigest : null,
        requestDigest: sink ? sink.requestDigest : null,
        issuedRequestDigest: request ? request.issuedRequestDigest : null,
        sourceStateSha256: request ? request.sourceStateSha256 : null,
        receiptDigest: receipt ? receipt.receiptDigest : null
      },
      routeAlias: request ? request.routeAlias : null,
      provenance: provenance ? { usageTrust: provenance.usageTrust, recordedAt: provenance.recordedAt } : null,
      send: sink
        ? {
          sink: sink.sink,
          requestId: sink.requestId,
          emittedAt: sink.emittedAt,
          delivered: false
        }
        : null,
      receipt: receipt
        ? {
          receiptId: receipt.receiptId,
          status: receipt.status,
          hasProviderMessageId: Boolean(receipt.hasProviderMessageId),
          receiptAt: receipt.receiptAt
        }
        : null,
      timestamps: {
        draftedAt: proposal.draftedAt,
        emittedAt: sink ? sink.emittedAt : null,
        receiptAt: receipt ? receipt.receiptAt : null
      }
    };
  });

  return {
    schemaVersion: 'job-email-reply-lifecycle-summary.v1',
    counts,
    lifecycle,
    // Provenance for the reviewer: this projection is metadata-only and the send
    // path is a dry-run sink. Auto-send is never granted.
    autoSendEnabled: false,
    sink: 'dry-run',
    protectedPayloadRedacted: true
  };
}

module.exports = {
  DRAFT_REPLY_SCHEMA_VERSION,
  DRAFT_REPLY_MIGRATION_NAME,
  SEND_RECEIPT_CORRELATION_SCHEMA_VERSION,
  SEND_RECEIPT_CORRELATION_MIGRATION_NAME,
  DRAFT_REPLY_ROUTE_ALIAS,
  FORBIDDEN_EFFECTS,
  RESEARCH_CAPABILITY,
  MAX_RESEARCH_TARGETS,
  EmailDraftReplyError,
  migrateEmailDraftReply,
  migrateEmailSendReceiptCorrelation,
  buildDraftReplyContext,
  normalizeCompanyResearch,
  issueDraftReplyRequest,
  recordDraftReplyResult,
  approveDraftReplySend,
  correlateSendReceipt,
  readReplyLifecycleSummary
};
