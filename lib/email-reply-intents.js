'use strict';

// Declarative reply recovery only. These immutable journals never create a
// draft, approve or send mail, inspect a mailbox, or release a send fence.
const { createHash, randomUUID } = require('node:crypto');

class ReplyIntentError extends Error {
  constructor(code, message) { super(message); this.name = 'ReplyIntentError'; this.code = code; }
}
const fail = (code, message) => { throw new ReplyIntentError(code, message); };
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TABLES = ['job_email_reply_intents', 'job_email_reply_send_starts', 'job_email_reply_supersessions'];

function migrateReplyIntents(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_email_reply_intents (
      id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE,
      message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id),
      application_id INTEGER NOT NULL REFERENCES applications(id),
      request_json TEXT NOT NULL CHECK(json_valid(request_json)), request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
      idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) BETWEEN 1 AND 200),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(message_ref_id,application_id)
    );
    CREATE TABLE IF NOT EXISTS job_email_reply_send_starts (
      id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE,
      intent_id INTEGER NOT NULL UNIQUE REFERENCES job_email_reply_intents(id),
      approval_id TEXT NOT NULL UNIQUE REFERENCES job_email_approval_receipts_v2(approval_id),
      request_json TEXT NOT NULL CHECK(json_valid(request_json)), request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
      idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) BETWEEN 1 AND 200),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS job_email_reply_supersessions (
      id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE,
      intent_id INTEGER NOT NULL UNIQUE REFERENCES job_email_reply_intents(id),
      superseding_message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id),
      handling_decision_id INTEGER NOT NULL REFERENCES job_email_handling_decisions(id),
      evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64),
      request_json TEXT NOT NULL CHECK(json_valid(request_json)), request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
      idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) BETWEEN 1 AND 200),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reply_intents_application ON job_email_reply_intents(application_id);
  `);
  for (const table of TABLES) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_append_only_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_append_only_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
    `);
  }
}

function text(value, label, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u0008\u000b-\u001f]/.test(value)) {
    fail('INVALID_INPUT', `${label} must be nonempty text (at most ${max} characters)`);
  }
  return value.trim();
}
function id(value, label) {
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail('INVALID_INPUT', `${label} must be a positive integer`);
  return Number(value);
}
function intentUuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID_INPUT', '--intent-id must be a UUID v4');
  return value.toLowerCase();
}
function actor(input, field = 'actor') {
  if (!['agent', 'human'].includes(input.authorship)) fail('INVALID_INPUT', '--authorship must be agent or human');
  return { actor: text(input[field], field, 120), authorship: input.authorship,
    reason: text(input.reason, '--reason'), idempotencyKey: text(input.idempotencyKey, '--idempotency-key', 200) };
}
function getIntent(db, uuid) {
  const row = db.prepare('SELECT * FROM job_email_reply_intents WHERE uuid=?').get(uuid);
  if (!row) fail('NOT_FOUND', 'Reply intent not found');
  return row;
}
function replay(db, table, request) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE idempotency_key=?`).get(request.idempotencyKey);
  if (!row) return null;
  if (row.request_json !== JSON.stringify(request) || row.request_digest !== hash(request)) fail('IDEMPOTENCY_CONFLICT', 'Key already belongs to a different immutable reply operation');
  return row;
}
function atomic(db, fn) { return db.inTransaction ? fn() : db.transaction(fn).immediate(); }
function hasRelation(db, name) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type IN ('table','view')").get(name)); }

function activeBinding(db, messageRefId, applicationId) {
  const links = hasRelation(db, 'active_job_email_application_links') ? 'active_job_email_application_links' : 'job_email_application_links';
  const correlations = hasRelation(db, 'active_job_email_linked_correlations') ? 'active_job_email_linked_correlations' : 'job_email_correlations';
  const linked = db.prepare(`SELECT id FROM ${links} WHERE message_ref_id=? AND application_id=? ORDER BY id`).all(messageRefId, applicationId);
  const resolved = db.prepare(`SELECT id FROM ${correlations} WHERE message_ref_id=? AND resolved_application_id=? AND resolution='linked'
    AND id=(SELECT MAX(id) FROM job_email_correlations WHERE message_ref_id=?)`).all(messageRefId, applicationId, messageRefId);
  return linked.length || resolved.length ? { links: linked.map(r => r.id), correlations: resolved.map(r => r.id) } : null;
}
function singleApplicationBinding(db, intent) {
  const links = hasRelation(db, 'active_job_email_application_links') ? 'active_job_email_application_links' : 'job_email_application_links';
  const correlations = hasRelation(db, 'active_job_email_linked_correlations') ? 'active_job_email_linked_correlations' : 'job_email_correlations';
  const applications = db.prepare(`SELECT application_id FROM ${links} WHERE message_ref_id=?
    UNION SELECT resolved_application_id AS application_id FROM ${correlations} WHERE message_ref_id=? AND resolution='linked'
      AND id=(SELECT MAX(id) FROM job_email_correlations WHERE message_ref_id=?)`).all(intent.message_ref_id, intent.message_ref_id, intent.message_ref_id);
  return applications.length === 1 && applications[0].application_id === intent.application_id;
}
function requireSingleApplication(db, intent) {
  if (!singleApplicationBinding(db, intent)) {
    fail('REPLY_APPLICATION_AMBIGUOUS', 'Sending requires this intent application to be the sole active source-message binding');
  }
}
function message(db, messageRefId) {
  const row = db.prepare('SELECT * FROM job_email_message_refs WHERE id=?').get(messageRefId);
  if (!row) fail('NOT_FOUND', 'Source message not found');
  return row;
}
function sourceSnapshot(row) {
  return { uuid: row.uuid, provider: row.provider, accountId: row.account_id, messageId: row.message_id,
    threadId: row.thread_id, receivedAt: row.received_at, factsDigest: row.facts_digest };
}
function receipt(db, intent, start) {
  // Approval contracts bind a source message, not an application. The immutable
  // pre-send start is the exact application/intent binding; never infer it from
  // an old receipt for another intent or a newly linked application.
  if (!start || !hasRelation(db, 'job_email_send_receipt_correlations_v2')) return null;
  return db.prepare(`SELECT r.receipt_id, r.receipt_digest FROM job_email_send_receipt_correlations_v2 r
    JOIN job_email_send_requests_v2 q ON q.request_id=r.send_request_id
    JOIN job_email_outgoing_proposals_v3 p ON p.proposal_id=q.proposal_id
    WHERE p.message_ref_id=? AND q.approval_id=? AND r.outcome IN ('sent','duplicate')
    ORDER BY r.receipt_id LIMIT 1`).get(intent.message_ref_id, start.approval_id) ?? null;
}
function state(db, intent) {
  const start = db.prepare('SELECT * FROM job_email_reply_send_starts WHERE intent_id=?').get(intent.id);
  const supersession = db.prepare('SELECT * FROM job_email_reply_supersessions WHERE intent_id=?').get(intent.id);
  const sent = receipt(db, intent, start);
  const historicalAttempt = !start && db.prepare(`SELECT 1 FROM job_email_send_requests_v2 q
    JOIN job_email_outgoing_proposals_v3 p ON p.proposal_id=q.proposal_id WHERE p.message_ref_id=? LIMIT 1`).get(intent.message_ref_id);
  // Retiring an obsolete reply cannot hide an unresolved physical-send attempt.
  return { status: sent ? 'fulfilled' : supersession ? 'superseded' : 'pending',
    reconcileOnly: Boolean((start && !sent) || historicalAttempt),
    reconciliationReason: historicalAttempt ? 'unbound_historical_send_request' : start && !sent ? 'send_start_without_authenticated_receipt' : null,
    start, supersession, receipt: sent };
}

function recordReplyIntent(db, input) {
  const request = { messageRefId: id(input.messageRefId, '--message-ref-id'), applicationId: id(input.applicationId, '--application-id'), ...actor(input) };
  return atomic(db, () => {
    const prior = replay(db, TABLES[0], request);
    if (prior) return { replyIntentId: prior.uuid, reused: true };
    if (!activeBinding(db, request.messageRefId, request.applicationId)) fail('NOT_LINKED', 'Reply intent requires an active application/message binding');
    if (db.prepare('SELECT 1 FROM job_email_reply_intents WHERE message_ref_id=? AND application_id=?').get(request.messageRefId, request.applicationId)) {
      fail('REPLY_INTENT_EXISTS', 'This message/application already has an immutable reply intent; inspect it instead of creating another');
    }
    const uuid = randomUUID();
    db.prepare(`INSERT INTO job_email_reply_intents(uuid,message_ref_id,application_id,request_json,request_digest,idempotency_key)
      VALUES (?,?,?,?,?,?)`).run(uuid, request.messageRefId, request.applicationId, JSON.stringify(request), hash(request), request.idempotencyKey);
    return { replyIntentId: uuid, reused: false };
  });
}

function recordReplySendStart(db, input) {
  const request = { intentId: intentUuid(input.intentId), approvalId: text(input.approvalId, '--approval-id', 200), ...actor(input) };
  return atomic(db, () => {
    const prior = replay(db, TABLES[1], request);
    if (prior) return { sendStartId: prior.uuid, replyIntentId: request.intentId, reused: true, reconcileOnly: state(db, getIntent(db, request.intentId)).reconcileOnly };
    const intent = getIntent(db, request.intentId);
    const current = state(db, intent);
    if (current.start || current.reconcileOnly || current.status !== 'pending') fail('REPLY_INTENT_CLOSED', 'No new send-start is allowed for an attempted, fulfilled, superseded or historical-send-held intent');
    if (!activeBinding(db, intent.message_ref_id, intent.application_id)) fail('NOT_LINKED', 'Intent source is no longer actively linked');
    requireSingleApplication(db, intent);
    const approval = db.prepare(`SELECT a.approval_id FROM job_email_approval_receipts_v2 a
      JOIN job_email_outgoing_proposals_v3 p ON p.proposal_id=a.proposal_id
      WHERE a.approval_id=? AND p.message_ref_id=?`).get(request.approvalId, intent.message_ref_id);
    if (!approval) fail('APPROVAL_SOURCE_MISMATCH', 'The recorded approval must belong to the exact intent message');
    if (db.prepare(`SELECT 1 FROM job_email_reply_send_starts start JOIN job_email_reply_intents other ON other.id=start.intent_id
      WHERE other.message_ref_id=?`).get(intent.message_ref_id)) fail('REPLY_SEND_START_EXISTS', 'Another intent already owns this source-message send barrier');
    if (db.prepare('SELECT 1 FROM job_email_send_requests_v2 WHERE approval_id=?').get(request.approvalId)) {
      fail('REPLY_SEND_ALREADY_REQUESTED', 'A reply send-start must precede its first send request; historical attempts require separate reconciliation');
    }
    const uuid = randomUUID();
    db.prepare(`INSERT INTO job_email_reply_send_starts(uuid,intent_id,approval_id,request_json,request_digest,idempotency_key)
      VALUES (?,?,?,?,?,?)`).run(uuid, intent.id, request.approvalId, JSON.stringify(request), hash(request), request.idempotencyKey);
    return { sendStartId: uuid, replyIntentId: intent.uuid, reused: false, reconcileOnly: true };
  });
}

function supersessionEvidence(db, intent, successorId) {
  const original = message(db, intent.message_ref_id);
  const successor = message(db, successorId);
  if (successor.id === original.id || original.provider !== successor.provider || original.account_id !== successor.account_id
      || !original.thread_id || original.thread_id !== successor.thread_id) {
    fail('SUPERSESSION_SCOPE_MISMATCH', 'Supersession v1 requires two distinct messages in the exact same provider/account/thread; cross-thread references are unresolved');
  }
  const before = Date.parse(original.received_at), after = Date.parse(successor.received_at);
  if (!Number.isFinite(before) || !Number.isFinite(after) || after <= before) fail('SUPERSESSION_ORDER_INVALID', 'The reviewed successor must be received strictly after the original');
  const originalBinding = activeBinding(db, original.id, intent.application_id);
  const successorBinding = activeBinding(db, successor.id, intent.application_id);
  if (!originalBinding || !successorBinding) fail('NOT_LINKED', 'Both messages must still have active bindings to the same application');
  const handling = db.prepare(`SELECT * FROM job_email_handling_decisions WHERE message_ref_id=? AND application_id=?
    ORDER BY id DESC LIMIT 1`).get(successor.id, intent.application_id);
  if (!handling || handling.decision === 'none') fail('SUPERSESSION_UNREVIEWED', 'A successor must have an explicit handling decision that acted on it');
  return { schemaVersion: 'jobtrack-reply-supersession-evidence.v1', intentId: intent.uuid, intentDigest: intent.request_digest,
    applicationId: intent.application_id, original: sourceSnapshot(original), successor: sourceSnapshot(successor),
    originalBinding, successorBinding, handling: { uuid: handling.uuid, decision: handling.decision, actor: handling.actor,
      authorship: handling.authorship, reason: handling.reason, createdAt: handling.created_at } };
}

function recordReplySupersession(db, input) {
  const evidenceDigest = text(input.expectedEvidenceDigest, '--expected-evidence-digest', 64);
  if (!/^[0-9a-f]{64}$/.test(evidenceDigest)) fail('INVALID_INPUT', '--expected-evidence-digest must be lowercase SHA256');
  const request = { intentId: intentUuid(input.intentId), supersedingMessageRefId: id(input.supersedingMessageRefId, '--superseding-message-ref-id'),
    expectedEvidenceDigest: evidenceDigest, ...actor(input, 'reviewedBy') };
  return atomic(db, () => {
    const prior = replay(db, TABLES[2], request);
    if (prior) return { supersessionId: prior.uuid, replyIntentId: request.intentId, reused: true,
      reconcileOnly: state(db, getIntent(db, request.intentId)).reconcileOnly };
    const intent = getIntent(db, request.intentId);
    if (state(db, intent).supersession) fail('REPLY_INTENT_CLOSED', 'This intent already has an immutable supersession review');
    const evidence = supersessionEvidence(db, intent, request.supersedingMessageRefId);
    if (hash(evidence) !== evidenceDigest) fail('STALE_SUPERSESSION_EVIDENCE', 'Read the current intent context and review its exact evidence again');
    const handling = db.prepare('SELECT id FROM job_email_handling_decisions WHERE uuid=?').get(evidence.handling.uuid);
    const uuid = randomUUID();
    db.prepare(`INSERT INTO job_email_reply_supersessions(uuid,intent_id,superseding_message_ref_id,handling_decision_id,evidence_json,evidence_digest,request_json,request_digest,idempotency_key)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(uuid, intent.id, request.supersedingMessageRefId, handling.id, JSON.stringify(evidence), evidenceDigest,
      JSON.stringify(request), hash(request), request.idempotencyKey);
    return { supersessionId: uuid, replyIntentId: intent.uuid, reused: false, reconcileOnly: state(db, intent).reconcileOnly };
  });
}

function listReplyIntents(db, { applicationId } = {}) {
  if (!hasRelation(db, TABLES[0])) return [];
  if (applicationId !== undefined) applicationId = id(applicationId, '--application-id');
  return db.prepare('SELECT * FROM job_email_reply_intents WHERE (? IS NULL OR application_id=?) ORDER BY id')
    .all(applicationId ?? null, applicationId ?? null).map(intent => {
      const current = state(db, intent), source = message(db, intent.message_ref_id);
      const candidates = [];
      if (!current.supersession) {
        for (const successor of db.prepare('SELECT id FROM job_email_message_refs WHERE provider=? AND account_id=? AND thread_id=? AND id<>? ORDER BY id')
          .all(source.provider, source.account_id, source.thread_id, source.id)) {
          try {
            const evidence = supersessionEvidence(db, intent, successor.id);
            candidates.push({ messageRefId: successor.id, evidenceDigest: hash(evidence), evidence });
          } catch (error) { if (!(error instanceof ReplyIntentError)) throw error; }
        }
      }
      return { replyIntentId: intent.uuid, messageRefId: intent.message_ref_id, applicationId: intent.application_id,
        status: current.status, reconcileOnly: current.reconcileOnly,
        reconciliationReason: current.reconciliationReason,
        active: Boolean(activeBinding(db, intent.message_ref_id, intent.application_id)),
        sendBindingUnambiguous: singleApplicationBinding(db, intent),
        sendStartId: current.start?.uuid ?? null, approvalId: current.start?.approval_id ?? null,
        supersessionId: current.supersession?.uuid ?? null, receiptId: current.receipt?.receipt_id ?? null,
        source: sourceSnapshot(source), supersessionCandidates: candidates };
    });
}

/** Last-mile veto only: reconciliation still happens in the existing send lane. */
function assertReplyIntentAllowsSend(db, approvalId) {
  if (!hasRelation(db, TABLES[0])) return;
  const intents = db.prepare(`SELECT intent.* FROM job_email_reply_intents intent
    JOIN job_email_outgoing_proposals_v3 p ON p.message_ref_id=intent.message_ref_id
    JOIN job_email_approval_receipts_v2 a ON a.proposal_id=p.proposal_id WHERE a.approval_id=?`).all(approvalId);
  for (const intent of intents) {
    const current = state(db, intent);
    if (current.supersession) fail('REPLY_INTENT_SUPERSEDED', 'An explicit reviewed supersession forbids transmitting this obsolete reply');
    if (!current.start || current.start.approval_id !== approvalId) fail('REPLY_SEND_START_REQUIRED', 'Record the exact approval send-start before executing this intent; no replacement approval bypass is allowed');
    if (!activeBinding(db, intent.message_ref_id, intent.application_id)) fail('NOT_LINKED', 'Intent source is no longer actively linked');
    requireSingleApplication(db, intent);
  }
}

module.exports = { ReplyIntentError, migrateReplyIntents, recordReplyIntent, recordReplySendStart,
  recordReplySupersession, listReplyIntents, assertReplyIntentAllowsSend };
