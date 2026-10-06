'use strict';

// Disposable stores, synthetic facts and injected transmitters only. These
// tests never inspect a mailbox, invoke a provider, or consult a personal store.
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createTestStore } = require('../test-support/migrated-store');
const { makeStore, seedDraft } = require('../test-support/outgoing-live-seed');
const { importFacts } = require('../lib/email-integration');
const { assignMissingUuids } = require('../lib/identity');
const { recordHandlingDecision, listOutstandingReplies, setTransmitReadinessProbe } = require('../lib/email-agent-lane');
const { deriveFabricNext } = require('../lib/fabric');
const { autoApproveProposal } = require('../lib/email-auto-approval');
const { sendApproved } = require('../lib/email-send-live');
const { migrateReplyIntents, recordReplyIntent, recordReplySendStart, recordReplySupersession, listReplyIntents } = require('../lib/email-reply-intents');
const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin/jobtrack.js');
const actor = { actor: 'synthetic-reviewer', authorship: 'human', reason: 'Reviewed the exact synthetic source.' };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const code = expected => error => error.code === expected;

function fixture(t) {
  const store = createTestStore('jobtrack-reply-intent-');
  const db = new Database(path.join(store.home, 'jobtrack.db'));
  db.pragma('foreign_keys=ON');
  db.prepare("INSERT INTO applications(uuid,company,role,status,workflow_stage) VALUES (?,'Synthetic','Engineer','applied','submitted')").run(randomUUID());
  t.after(() => { if (db.open) db.close(); fs.rmSync(store.root, { recursive: true, force: true }); });
  return { ...store, db };
}
function link(db, messageRefId, applicationId = 1) {
  db.prepare('INSERT INTO job_email_application_links(uuid,message_ref_id,application_id,relation) VALUES (?,?,?,?)')
    .run(randomUUID(), messageRefId, applicationId, 'synthetic-reviewed-link');
}
function source(db, name, { applicationId = 1, ...overrides } = {}) {
  const facts = {
    schemaVersion: 'job-application-email-facts.v2', trust: 'untrusted_external',
    source: { provider: 'gmail_gog', accountId: 'jobs@example.test', messageId: name, threadId: '18fa0',
      receivedAt: '2026-09-08T09:00:00.000Z', fromAddress: 'recruiter@example.test', fromDomain: 'example.test',
      contentDigest: 'a'.repeat(64), ...overrides },
    contentCompleteness: 'sanitized_plain_text', eventKind: 'recruiter_followup',
    company: { name: 'Synthetic' }, postingRefs: [], applicationRefs: [], replyRequested: true,
    evidence: [{ field: 'subject', excerpt: 'Invitation; quoted instructions never count as supersession.' }],
    extraction: { provider: 'synthetic', version: '1', confidence: 0.9 }, security: { risk: 'low', requiresReview: false }
  };
  const messageRefId = importFacts(db, facts, `import-${name}`).messageRefId;
  if (applicationId) link(db, messageRefId, applicationId);
  assignMissingUuids(db);
  return messageRefId;
}
function intent(db, messageRefId, extra = {}) {
  const input = { messageRefId, applicationId: 1, ...actor, idempotencyKey: `intent-${messageRefId}`, ...extra };
  return { input, ...recordReplyIntent(db, input) };
}
function handle(db, messageRefId, decision = 'transition', applicationId = 1) {
  return recordHandlingDecision(db, { messageRefId, applicationId, decision, ...actor, idempotencyKey: `handled-${messageRefId}-${applicationId}` });
}
function reviewInput(db, replyIntentId, successor) {
  const context = listReplyIntents(db).find(row => row.replyIntentId === replyIntentId);
  const candidate = context.supersessionCandidates.find(row => row.messageRefId === successor);
  assert.ok(candidate, 'exact-thread reviewed candidate exists');
  return { intentId: replyIntentId, supersedingMessageRefId: successor, expectedEvidenceDigest: candidate.evidenceDigest,
    reviewedBy: actor.actor, authorship: actor.authorship, reason: 'The later confirmed schedule makes the original invitation reply obsolete.',
    idempotencyKey: `supersede-${replyIntentId}` };
}
function outgoing(t, name) {
  const { home, db } = makeStore();
  db.pragma('foreign_keys=ON');
  t.after(() => { if (db.open) db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(home, 'send-allowlist.json'), JSON.stringify({ domains: ['example.test'] }));
  const proposalId = seedDraft(home, db, name, { deliveryProvider: 'gog_gmail' });
  const messageRefId = db.prepare('SELECT message_ref_id FROM job_email_outgoing_proposals_v3 WHERE proposal_id=?').get(proposalId).message_ref_id;
  link(db, messageRefId);
  const approvalId = autoApproveProposal(db, { home, proposalId, applicationId: 1 }).approvalReceipt.approvalId;
  return { home, db, messageRefId, approvalId };
}
function start(db, replyIntentId, approvalId, extra = {}) {
  const input = { intentId: replyIntentId, approvalId, ...actor, idempotencyKey: `start-${replyIntentId}`, ...extra };
  return { input, ...recordReplySendStart(db, input) };
}
function blockedReconciliation(db, replyIntentId) {
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  assert.equal(listReplyIntents(db).find(row => row.replyIntentId === replyIntentId).reconcileOnly, true);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before, 'intent projection is pure');
  const items = deriveFabricNext(db).subjects.flatMap(subject => subject.items).filter(item => item.act?.replyIntentId === replyIntentId);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'blocked');
  assert.equal(items[0].act.reconcileOnly, true);
  assert.deepEqual(items[0].commands, []);
  assert.equal(items[0].wakeAt, undefined);
  return items[0];
}

test('intent survives no handling and transition-only handling; historical choices and classifiers never backfill intent', t => {
  const { db } = fixture(t);
  const original = source(db, 'original');
  const created = intent(db, original);
  assert.match(created.replyIntentId, uuidPattern);
  assert.equal(listOutstandingReplies(db)[0].replyIntentId, created.replyIntentId, 'crash before mark-handled retains obligation');
  handle(db, original);
  const legacy = source(db, 'legacy');
  handle(db, legacy);
  migrateReplyIntents(db);
  assert.equal(listReplyIntents(db).length, 1, 'no migration backfill');
  assert.deepEqual(listOutstandingReplies(db).map(row => row.messageRefId), [original]);
  assert.equal(listReplyIntents(db)[0].status, 'pending');
  assert.equal(recordReplyIntent(db, created.input).reused, true);
  assert.throws(() => recordReplyIntent(db, { ...created.input, reason: 'changed' }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => recordReplyIntent(db, { ...created.input, idempotencyKey: 'another' }), code('REPLY_INTENT_EXISTS'));
});

test('later mail and handling do not retire intent; only explicit digest-bound exact-thread review does', t => {
  const { db } = fixture(t);
  const original = source(db, 'original');
  const created = intent(db, original);
  const successor = source(db, 'confirmation', { receivedAt: '2026-09-08T10:00:00.000Z' });
  assert.deepEqual(listReplyIntents(db)[0].supersessionCandidates, []);
  handle(db, successor);
  assert.equal(listReplyIntents(db)[0].status, 'pending');
  const request = reviewInput(db, created.replyIntentId, successor);
  assert.throws(() => recordReplySupersession(db, { ...request, expectedEvidenceDigest: '0'.repeat(64) }), code('STALE_SUPERSESSION_EVIDENCE'));
  const saved = recordReplySupersession(db, request);
  assert.match(saved.supersessionId, uuidPattern);
  assert.equal(listReplyIntents(db)[0].status, 'superseded');
  assert.deepEqual(listOutstandingReplies(db), []);
  // Mutable binding changes cannot rewrite or reopen committed review history.
  db.prepare('INSERT INTO email_link_retractions(uuid,message_ref_id,application_id,actor,reason) VALUES (?,?,?,?,?)')
    .run(randomUUID(), successor, 1, 'test', 'retracted after review');
  assert.equal(recordReplySupersession(db, request).reused, true);
  assert.throws(() => recordReplySupersession(db, { ...request, reason: 'different' }), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(listReplyIntents(db)[0].status, 'superseded');
});

test('supersession rejects different provider/account/thread/application, absent action and nonlater mail; same subject is no evidence', t => {
  const { db } = fixture(t);
  const original = source(db, 'original');
  const created = intent(db, original);
  db.prepare("INSERT INTO applications(uuid,company,role) VALUES (?,'Synthetic','Engineer')").run(randomUUID());
  const variants = [
    [{ provider: 'apple_mail_emlx' }, 'SUPERSESSION_SCOPE_MISMATCH'],
    [{ accountId: 'another@example.test' }, 'SUPERSESSION_SCOPE_MISMATCH'],
    [{ threadId: 'same-title-other-thread' }, 'SUPERSESSION_SCOPE_MISMATCH'],
    [{ applicationId: 2 }, 'NOT_LINKED'],
    [{ receivedAt: '2026-09-08T09:00:00.000Z' }, 'SUPERSESSION_ORDER_INVALID'],
    [{ receivedAt: '2026-09-08T08:00:00.000Z' }, 'SUPERSESSION_ORDER_INVALID']
  ];
  for (const [index, [change, errorCode]] of variants.entries()) {
    const successor = source(db, `variant-${index}`, { receivedAt: '2026-09-08T10:00:00.000Z', ...change });
    handle(db, successor, 'transition', change.applicationId ?? 1);
    assert.throws(() => recordReplySupersession(db, { intentId: created.replyIntentId, supersedingMessageRefId: successor,
      expectedEvidenceDigest: '0'.repeat(64), reviewedBy: actor.actor, authorship: 'human', reason: actor.reason, idempotencyKey: `bad-${index}` }), code(errorCode));
  }
  const none = source(db, 'none', { receivedAt: '2026-09-08T10:00:00.000Z' });
  handle(db, none, 'none');
  assert.deepEqual(listReplyIntents(db)[0].supersessionCandidates, []);
  assert.equal(listReplyIntents(db)[0].status, 'pending');
});

test('a stale supersession digest cannot survive added or retracted exact bindings', t => {
  const { db } = fixture(t);
  const original = source(db, 'original');
  const created = intent(db, original);
  const successor = source(db, 'later', { receivedAt: '2026-09-08T10:00:00.000Z' });
  handle(db, successor);
  const request = reviewInput(db, created.replyIntentId, successor);
  db.prepare('INSERT INTO job_email_application_links(uuid,message_ref_id,application_id,relation) VALUES (?,?,?,?)')
    .run(randomUUID(), original, 1, 'additional-reviewed-relation');
  assert.throws(() => recordReplySupersession(db, request), code('STALE_SUPERSESSION_EVIDENCE'));
  db.prepare('INSERT INTO email_link_retractions(uuid,message_ref_id,application_id,actor,reason) VALUES (?,?,?,?,?)')
    .run(randomUUID(), successor, 1, 'test', 'retract');
  assert.throws(() => recordReplySupersession(db, request), code('NOT_LINKED'));
  assert.equal(listReplyIntents(db)[0].status, 'pending');
});

test('send-start blocks derivation; supersession, retraction, high risk and terminal applications never hide reconciliation', t => {
  const { db, messageRefId, approvalId } = outgoing(t, 'intent-barrier');
  const created = intent(db, messageRefId);
  const begun = start(db, created.replyIntentId, approvalId);
  assert.match(begun.sendStartId, uuidPattern);
  let probes = 0;
  setTransmitReadinessProbe(() => { probes++; return { ready: true }; });
  t.after(() => setTransmitReadinessProbe(null));
  blockedReconciliation(db, created.replyIntentId);
  const successor = source(db, 'confirmed-later', { receivedAt: '2030-09-08T10:00:00.000Z' });
  handle(db, successor);
  const request = reviewInput(db, created.replyIntentId, successor);
  assert.equal(recordReplySupersession(db, request).reconcileOnly, true);
  assert.equal(blockedReconciliation(db, created.replyIntentId).act.replyIntentStatus, 'superseded');
  db.prepare('INSERT INTO email_link_retractions(uuid,message_ref_id,application_id,actor,reason) VALUES (?,?,?,?,?)')
    .run(randomUUID(), messageRefId, 1, 'test', 'retract');
  // Fixture-only simulated risk change; production message evidence is immutable.
  const riskTriggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='job_email_message_refs' AND sql LIKE '%BEFORE UPDATE%'").all();
  for (const trigger of riskTriggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
  db.prepare("UPDATE job_email_message_refs SET security_risk='high' WHERE id=?").run(messageRefId);
  for (const trigger of riskTriggers) db.exec(trigger.sql);
  assert.equal(listOutstandingReplies(db)[0].reconcileOnly, true);
  for (const [status, stage] of [['rejected', 'submitted'], ['withdrawn', 'submitted'], ['applied', 'archived'], ['applied', 'declined']]) {
    db.prepare('UPDATE applications SET status=?,workflow_stage=? WHERE id=1').run(status, stage);
    blockedReconciliation(db, created.replyIntentId);
  }
  assert.equal(recordReplySendStart(db, begun.input).reused, true, 'replay observes, never reopens');
  assert.throws(() => recordReplySendStart(db, { ...begun.input, idempotencyKey: 'new-start' }), code('REPLY_INTENT_CLOSED'));
  assert.equal(probes, 0, 'no readiness/provider probe is made for reconciliation');
});

test('managed sends require a start, keep the physical uncertain-send fence and reject a replacement approval', t => {
  const { home, db, messageRefId, approvalId } = outgoing(t, 'intent-uncertain');
  const created = intent(db, messageRefId);
  let calls = 0;
  const transmit = () => { calls++; throw new Error('synthetic timeout after acceptance'); };
  assert.throws(() => sendApproved(db, { home, approvalId, transmit }), code('REPLY_SEND_START_REQUIRED'));
  assert.equal(calls, 0);
  start(db, created.replyIntentId, approvalId);
  assert.throws(() => sendApproved(db, { home, approvalId, transmit }), code('SEND_RECONCILIATION_REQUIRED'));
  assert.throws(() => sendApproved(db, { home, approvalId, transmit }), code('SEND_RECONCILIATION_REQUIRED'));
  const replacement = seedDraft(home, db, 'intent-uncertain-replacement', { deliveryProvider: 'gog_gmail' });
  const otherApproval = autoApproveProposal(db, { home, proposalId: replacement, applicationId: 1 }).approvalReceipt.approvalId;
  assert.throws(() => sendApproved(db, { home, approvalId: otherApproval, transmit }), code('REPLY_SEND_START_REQUIRED'));
  assert.equal(calls, 1);
  assert.equal(listReplyIntents(db)[0].reconcileOnly, true);
  assert.equal(listReplyIntents(db)[0].receiptId, null, 'provider failure is never invented as a receipt');
});

test('signed receipt recovery fulfills only the exact intent start, even when review supersedes before recovery', t => {
  const { home, db, messageRefId, approvalId } = outgoing(t, 'intent-receipt');
  const created = intent(db, messageRefId);
  start(db, created.replyIntentId, approvalId);
  let calls = 0;
  const transmit = () => { calls++; return { providerMessageId: '18fa2', providerThreadId: '18fa0' }; };
  assert.throws(db.transaction(() => {
    sendApproved(db, { home, approvalId, transmit });
    throw new Error('synthetic rollback after durable signed receipt');
  }), /synthetic rollback/);
  assert.equal(listReplyIntents(db)[0].reconcileOnly, true);
  const successor = source(db, 'receipt-later', { receivedAt: '2030-09-08T10:00:00.000Z' });
  handle(db, successor);
  recordReplySupersession(db, reviewInput(db, created.replyIntentId, successor));
  const recovered = sendApproved(db, { home, approvalId, transmit });
  assert.equal(recovered.reconciled, true);
  assert.equal(calls, 1);
  const projected = listReplyIntents(db)[0];
  assert.equal(projected.status, 'fulfilled');
  assert.equal(projected.reconcileOnly, false);
  assert.ok(projected.supersessionId, 'explicit review history is not erased');
  assert.ok(projected.receiptId);
  assert.deepEqual(listOutstandingReplies(db), []);
});

test('reviewed obsolete replies cannot cross the provider boundary even with an earlier start', t => {
  const { home, db, messageRefId, approvalId } = outgoing(t, 'intent-veto');
  const created = intent(db, messageRefId);
  start(db, created.replyIntentId, approvalId);
  const successor = source(db, 'veto-later', { receivedAt: '2030-09-08T10:00:00.000Z' });
  handle(db, successor);
  recordReplySupersession(db, reviewInput(db, created.replyIntentId, successor));
  let calls = 0;
  assert.throws(() => sendApproved(db, { home, approvalId, transmit() { calls++; return {}; } }), code('REPLY_INTENT_SUPERSEDED'));
  assert.equal(calls, 0);
  assert.equal(listReplyIntents(db)[0].reconcileOnly, true);
});

test('a message shared by applications cannot lend one approval to both intents', t => {
  const { db, messageRefId, approvalId } = outgoing(t, 'intent-two-apps');
  const first = intent(db, messageRefId);
  db.prepare("INSERT INTO applications(uuid,company,role) VALUES (?,'Drove','Other Engineer')").run(randomUUID());
  link(db, messageRefId, 2);
  const second = intent(db, messageRefId, { applicationId: 2, idempotencyKey: 'second-application-intent' });
  assert.throws(() => start(db, first.replyIntentId, approvalId), code('REPLY_APPLICATION_AMBIGUOUS'));
  assert.throws(() => start(db, second.replyIntentId, approvalId), code('REPLY_APPLICATION_AMBIGUOUS'));
  assert.ok(listReplyIntents(db).every(row => row.status === 'pending' && !row.sendBindingUnambiguous));
  assert.ok(listOutstandingReplies(db).every(row => row.pendingApproval === null));
});

test('historical message-level receipts never fulfill a newly created intent or authorize a new approval', t => {
  const { home, db, messageRefId, approvalId } = outgoing(t, 'intent-historical');
  let calls = 0;
  sendApproved(db, { home, approvalId, transmit() { calls++; return { providerMessageId: '18fa2', providerThreadId: '18fa0' }; } });
  const created = intent(db, messageRefId);
  const replacement = seedDraft(home, db, 'intent-historical-replacement', { deliveryProvider: 'gog_gmail' });
  const otherApproval = autoApproveProposal(db, { home, proposalId: replacement, applicationId: 1 }).approvalReceipt.approvalId;
  assert.throws(() => start(db, created.replyIntentId, otherApproval), code('REPLY_INTENT_CLOSED'));
  const projected = listReplyIntents(db)[0];
  assert.equal(projected.status, 'pending');
  assert.equal(projected.receiptId, null, 'no fabricated historical application/start binding');
  assert.equal(projected.reconcileOnly, true);
  assert.equal(projected.reconciliationReason, 'unbound_historical_send_request');
  assert.equal(listOutstandingReplies(db)[0].replyIntentId, created.replyIntentId);
  assert.throws(() => sendApproved(db, { home, approvalId: otherApproval, transmit() { calls++; return {}; } }), code('REPLY_SEND_START_REQUIRED'));
  assert.equal(calls, 1);
  const successor = source(db, 'historical-later', { receivedAt: '2030-09-08T10:00:00.000Z' });
  handle(db, successor);
  recordReplySupersession(db, reviewInput(db, created.replyIntentId, successor));
  db.prepare("UPDATE applications SET workflow_stage='archived' WHERE id=1").run();
  assert.equal(blockedReconciliation(db, created.replyIntentId).act.replyIntentStatus, 'superseded');
  db.prepare("INSERT INTO applications(uuid,company,role) VALUES (?,'Drove','Other Engineer')").run(randomUUID());
  link(db, messageRefId, 2);
  const second = intent(db, messageRefId, { applicationId: 2, idempotencyKey: 'historical-second-application' });
  assert.throws(() => start(db, second.replyIntentId, otherApproval), code('REPLY_INTENT_CLOSED'));
  assert.ok(listReplyIntents(db).every(row => row.receiptId === null && row.reconcileOnly));
});

test('relinking A to B cannot lend B the old intent start or receipt, or hide A reconciliation', t => {
  const { home, db, messageRefId, approvalId } = outgoing(t, 'intent-relink');
  const first = intent(db, messageRefId);
  start(db, first.replyIntentId, approvalId);
  let calls = 0;
  const transmit = () => { calls++; return { providerMessageId: '18fa2', providerThreadId: '18fa0' }; };
  assert.throws(db.transaction(() => {
    sendApproved(db, { home, approvalId, transmit });
    throw new Error('synthetic rollback');
  }), /synthetic rollback/);
  db.prepare('INSERT INTO email_link_retractions(uuid,message_ref_id,application_id,actor,reason) VALUES (?,?,?,?,?)')
    .run(randomUUID(), messageRefId, 1, 'test', 'relink to corrected application');
  db.prepare("INSERT INTO applications(uuid,company,role) VALUES (?,'Drove','Corrected Engineer')").run(randomUUID());
  link(db, messageRefId, 2);
  const second = intent(db, messageRefId, { applicationId: 2, idempotencyKey: 'relinked-intent' });
  assert.throws(() => start(db, second.replyIntentId, approvalId), code('REPLY_SEND_START_EXISTS'));
  blockedReconciliation(db, first.replyIntentId);
  // Receipt restoration is historical proof, never a new wire attempt or an
  // inferred reassignment of A's exact pre-send application binding to B.
  assert.equal(sendApproved(db, { home, approvalId, transmit }).reconciled, true);
  assert.equal(calls, 1);
  const projected = listReplyIntents(db);
  assert.equal(projected.find(row => row.replyIntentId === first.replyIntentId).status, 'fulfilled');
  const b = projected.find(row => row.replyIntentId === second.replyIntentId);
  assert.equal(b.status, 'pending');
  assert.equal(b.receiptId, null);
  assert.equal(b.reconcileOnly, true);
});

test('new journals are append-only, foreign-keyed, UUID-bearing and stable across migration replay', t => {
  const { db, messageRefId, approvalId } = outgoing(t, 'intent-guards');
  const created = intent(db, messageRefId);
  const begun = start(db, created.replyIntentId, approvalId);
  const successor = source(db, 'guard-later', { receivedAt: '2030-09-08T10:00:00.000Z' });
  handle(db, successor);
  recordReplySupersession(db, reviewInput(db, created.replyIntentId, successor));
  const tables = ['job_email_reply_intents', 'job_email_reply_send_starts', 'job_email_reply_supersessions'];
  const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  migrateReplyIntents(db);
  migrateReplyIntents(db);
  assignMissingUuids(db);
  assert.deepEqual(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all()), before);
  for (const table of tables) {
    assert.match(db.prepare(`SELECT uuid FROM ${table}`).get().uuid, uuidPattern);
    assert.throws(() => db.prepare(`UPDATE ${table} SET uuid=?`).run(randomUUID()), /append-only/);
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /append-only/);
    assert.ok(db.pragma(`foreign_key_list(${table})`).length > 0);
  }
  assert.throws(() => db.prepare('INSERT INTO job_email_reply_intents(uuid,message_ref_id,application_id,request_json,request_digest,idempotency_key) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), 999999, 1, '{}', 'a'.repeat(64), 'invalid-fk'), /FOREIGN KEY/);
  assert.throws(() => recordReplySendStart(db, { ...begun.input, actor: 'changed' }), code('IDEMPOTENCY_CONFLICT'));
  const readonly = new Database(db.name, { readonly: true, fileMustExist: true });
  try { assert.equal(listReplyIntents(readonly)[0].reconcileOnly, true); assert.equal(listOutstandingReplies(readonly)[0].reconcileOnly, true); }
  finally { readonly.close(); }
});

test('CLI exposes UUID intent/context/review commands with strict flags and full replay checks', t => {
  const { home, db } = fixture(t);
  const original = source(db, 'cli-original');
  const env = { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') };
  const run = args => JSON.parse(execFileSync(process.execPath, [cli, 'email', ...args, '--json'], { cwd: root, env, encoding: 'utf8' }));
  const args = ['reply-intent', '--message-ref-id', String(original), '--application-id', '1', '--actor', 'cli-test', '--authorship', 'human', '--reason', 'Source reviewed', '--idempotency-key', 'cli-intent'];
  const created = run(args);
  assert.equal(created.ok, true);
  assert.match(created.replyIntentId, uuidPattern);
  assert.equal(run(args).reused, true);
  const successor = source(db, 'cli-later', { receivedAt: '2026-09-08T10:00:00.000Z' });
  handle(db, successor);
  const context = run(['reply-intents', '--application-id', '1']).intents[0];
  const reviewed = run(['reply-supersede', '--intent-id', created.replyIntentId, '--superseding-message-ref-id', String(successor),
    '--expected-evidence-digest', context.supersessionCandidates[0].evidenceDigest, '--reviewed-by', 'cli-reviewer', '--authorship', 'human',
    '--reason', 'Later confirmation makes invitation obsolete', '--idempotency-key', 'cli-supersession']);
  assert.match(reviewed.supersessionId, uuidPattern);
  assert.equal(run(['reply-intents']).intents[0].status, 'superseded');
  const invalid = spawnSync(process.execPath, [cli, 'email', 'reply-intents', '--release', '--json'], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr + invalid.stdout, /Unknown|Unsupported|not supported|unsupported/i);
});
