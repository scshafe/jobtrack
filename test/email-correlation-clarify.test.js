'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createTestStore } = require('../test-support/migrated-store');

const { listInboundQueue } = require('../lib/email-agent-lane');
const {
  CLARIFICATION_MIGRATION_NAME,
  CLARIFICATION_SCHEMA_VERSION,
  clarificationReference,
  expireClarifications,
  openClarification: prepareClarification,
  questionFor
} = require('../lib/email-correlation/clarify');
const {
  correlateEmailReadOnly,
  importFacts,
  recordCorrelation,
  runEmailCommand
} = require('../lib/email-integration');
const { captureDraftReceipt, readReviewProjection, recordDraftResult, recordClarificationDraftResult } = require('../lib/email-outgoing-v2');
const { autoApproveProposal } = require('../lib/email-auto-approval');
const { sendApproved } = require('../lib/email-send-live');
const { NORMALIZATION_VERSION, digestCanonicalJson, digestUtf8Text, projectApprovedContentFromProposal } = require('../lib/email-outgoing-v2-contracts');
const { deriveFabricNext } = require('../lib/fabric');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

// Explicit simulated external executor for these store integration tests only.
// Production clarify has no native-draft/approval/send imports or callbacks.
function openClarification(db, input, deps = {}) {
  let prepared = prepareClarification(db, input, deps);
  if (prepared.deliveryState === 'awaiting_source_headers') {
    const inReplyTo = `<${prepared.source.messageId}@source.example.test>`;
    prepared = prepareClarification(db, { ...input, inReplyTo, references: [inReplyTo], replySubject: 'Re: Actual native subject',
      preparationDigest: prepared.preparationDigest }, deps);
  }
  if (prepared.status !== 'pending' || prepared.askedAt || !deps.transmit) return prepared;
  captureTestNativeDraft(db, prepared.proposalId);
  const approved = autoApproveProposal(db, { proposalId: prepared.proposalId,
    applicationId: prepared.candidates[0].applicationId, home: deps.home });
  const message = db.prepare('SELECT * FROM job_email_message_refs WHERE id=?').get(input.messageRefId);
  sendApproved(db, { approvalId: approved.approvalReceipt.approvalId,
    provider: message.provider === 'gmail_gog' ? 'gog_gmail' : 'apple_mail_automation',
    transmitAccount: message.account_id, gmailThreadId: message.thread_id,
    replyToMessageId: message.message_id, home: deps.home, transmit: deps.transmit });
  return prepareClarification(db, input, deps);
}

function captureTestNativeDraft(db, proposalId) {
  const projection = readReviewProjection(db, proposalId);
  const content = projection.approvedContent;
  captureDraftReceipt(db, {
    schemaVersion: 'jobtrack-email-draft-receipt-capture.v1',
    idempotencyKey: `test-capture-${proposalId}`,
    receipt: {
      schemaVersion: 'email-draft-receipt.v1', normalizationVersion: NORMALIZATION_VERSION,
      receiptId: `test-receipt-${proposalId}`, draftProposalId: proposalId,
      draftProposalDigest: digestCanonicalJson(projection.proposal),
      contentDigest: digestCanonicalJson(content), generationId: content.generationId,
      manifestDigest: content.manifestDigest, provider: content.provider, accountId: content.accountId,
      recipient: content.recipient, threadId: content.thread.threadId,
      providerDraftId: `test-native-${proposalId}`, providerThreadId: content.thread.threadId,
      outcome: 'created', transmission: 'not_sent', sendFidelity: 'content_equivalent',
      observedAt: new Date().toISOString()
    }
  });
}

function runCli(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], {
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8'
  }));
}

function createStore(t, { cold = false } = {}) {
  const copied = cold ? null : createTestStore('jobtrack-r4-');
  const parent = copied?.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-r4-'));
  const home = copied?.home ?? path.join(parent, 'store');
  if (cold) runCli(home, ['init']);
  runCli(home, ['profile', 'set-contact', '--name', 'Cole Applicant', '--source', 'test']);
  const first = runCli(home, ['add-application', '--company', 'Drove', '--role', 'Platform Engineer', '--status', 'applied']).application.id;
  const second = runCli(home, ['add-application', '--company', 'Drove', '--role', 'Site Reliability Engineer', '--status', 'applied']).application.id;
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  db.prepare("UPDATE companies SET website_domain='mydrove.com' WHERE normalized_name='drove'").run();
  t.after(() => { db.close(); fs.rmSync(parent, { recursive: true, force: true }); });
  return { home, db, first, second };
}

function facts(messageId, overrides = {}) {
  const receivedAt = overrides.receivedAt || new Date().toISOString();
  return {
    schemaVersion: 'job-application-email-facts.v2',
    trust: 'untrusted_external',
    source: {
      provider: 'gmail_gog', accountId: 'applicant@example.test', messageId,
      threadId: 'clarification-thread-1', receivedAt,
      fromAddress: 'careers@mydrove.com', fromDomain: 'mydrove.com',
      fromDisplayName: 'Drove Careers',
      contentDigest: crypto.createHash('sha256').update(messageId).digest('hex')
    },
    contentCompleteness: 'sanitized_plain_text',
    eventKind: overrides.eventKind || 'recruiter_followup',
    company: { name: 'Drove', domain: 'mydrove.com' },
    postingRefs: overrides.postingRefs || [],
    applicationRefs: overrides.applicationRefs || [],
    replyRequested: overrides.replyRequested ?? true,
    evidence: overrides.evidence || [
      { field: 'subject', excerpt: 'Quick question' },
      { field: 'body', excerpt: 'Could you send your availability?' }
    ],
    extraction: { provider: 'inbox-pipeline', version: 'email-mentions.v1', confidence: 0.95 },
    security: { risk: 'medium', requiresReview: true }
  };
}

test('pure clarification preparation binds actual headers and cannot manufacture native or runner evidence', (t) => {
  const fixture = createStore(t);
  const initial = facts('provider-opaque-id');
  const imported = importFacts(fixture.db, initial, 'pure:import');
  recordCorrelation(fixture.db, correlateEmailReadOnly(fixture.db, initial), 'pure:correlate');
  const input = { messageRefId: imported.messageRefId, candidates: [fixture.first, fixture.second] };
  const noEffects = { sendApproved: () => assert.fail('store cannot send'), transmit: () => assert.fail('store cannot transmit') };
  const prepared = prepareClarification(fixture.db, input, noEffects);
  assert.equal(prepared.deliveryState, 'awaiting_source_headers');
  assert.equal(prepared.proposalId, null);
  assert.equal(prepared.source.messageId, 'provider-opaque-id');
  assert.equal('inReplyTo' in prepared.source, false);
  assert.equal(prepareClarification(fixture.db, input).preparationDigest, prepared.preparationDigest);
  assert.equal(fixture.db.prepare('SELECT count(*) n FROM email_clarifications').get().n, 0);
  assert.equal(fixture.db.prepare('SELECT count(*) n FROM job_email_outgoing_draft_requests').get().n, 0);
  for (const inReplyTo of ['<provider-opaque-id>', '<source@domain>\r\nBcc: victim@domain', 'source@domain', '<one@two@three>']) {
    assert.throws(() => prepareClarification(fixture.db, { ...input, inReplyTo,
      references: [inReplyTo], preparationDigest: prepared.preparationDigest }), /actual RFC/);
  }
  const headers = { inReplyTo: '<real-message@mydrove.com>', references: ['<ancestor@mydrove.com>', '<real-message@mydrove.com>'],
    replySubject: 'Re: Actual full native subject which differs from the facts excerpt' };
  assert.throws(() => prepareClarification(fixture.db, { ...input, ...headers, replySubject: undefined,
    preparationDigest: prepared.preparationDigest }), /actual native reply subject/);
  assert.throws(() => prepareClarification(fixture.db, { ...input, ...headers }), /preparation-digest/);
  assert.throws(() => prepareClarification(fixture.db, { ...input, ...headers, preparationDigest: '0'.repeat(64) }), /no longer matches/);
  const opened = prepareClarification(fixture.db, { ...input, ...headers, preparationDigest: prepared.preparationDigest }, noEffects);
  assert.equal(opened.deliveryState, 'awaiting_native_draft');
  const projection = readReviewProjection(fixture.db, opened.proposalId);
  assert.equal(projection.draftReceipt, null);
  assert.deepEqual(projection.proposal.source.references, headers.references);
  assert.equal(projection.proposal.source.inReplyTo, headers.inReplyTo);
  assert.equal(projection.proposal.subject, headers.replySubject);
  assert.notEqual(projection.proposal.subject, prepared.subjectHint);
  assert.equal(projection.proposal.body, prepared.question);
  const request = JSON.parse(fixture.db.prepare('SELECT request_json FROM job_email_outgoing_draft_requests').get().request_json);
  const recorded = JSON.parse(fixture.db.prepare('SELECT result_json FROM job_email_outgoing_draft_results').get().result_json);
  assert.equal(request.execution.kind, 'clarification_template_in_process');
  assert.equal(request.execution.templateId, 'email-clarification-question.v2');
  assert.equal(request.execution.processIsolation, 'in_process');
  assert.deepEqual(request.effects, { mailboxRead: false, nativeDraft: false, send: false });
  assert.deepEqual(recorded.usage, { runner: 'clarification_template_in_process', toolCalls: 0, toolsUsed: [], sideEffects: [] });
  assert.throws(() => recordDraftResult(fixture.db, { ...recorded, idempotencyKey: 'wrong-generic-runner' }), /standalone_out_of_process/);
  assert.throws(() => recordDraftResult(fixture.db, { ...recorded,
    usage: { ...recorded.usage, runner: 'standalone_out_of_process' }, idempotencyKey: 'false-generic-runner' }), /no-effect/);
  assert.throws(() => recordClarificationDraftResult(fixture.db, { ...recorded,
    usage: { ...recorded.usage, toolCalls: 1 }, idempotencyKey: 'template-has-tools' }), /no-effect/);
  assert.throws(() => recordClarificationDraftResult(fixture.db, { ...recorded,
    proposal: { ...recorded.proposal, templateId: 'arbitrary-template' }, idempotencyKey: 'different-template' }), /no-effect/);
  const arbitraryProposal = { ...recorded.proposal, body: 'Arbitrary caller text', bodyDigest: digestUtf8Text('Arbitrary caller text') };
  assert.throws(() => recordClarificationDraftResult(fixture.db, { ...recorded, proposal: arbitraryProposal,
    approvedContent: projectApprovedContentFromProposal(arbitraryProposal, {
      contentId: recorded.approvedContent.contentId, createdAt: recorded.approvedContent.createdAt }),
    idempotencyKey: 'arbitrary-template-body' }), /no-effect/);
  assert.equal(prepareClarification(fixture.db, input, noEffects).proposalId, opened.proposalId);
  for (const table of ['job_email_draft_receipts_v1', 'job_email_approval_receipts_v2', 'job_email_send_requests_v2', 'job_email_send_receipt_correlations_v2']) {
    assert.equal(fixture.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, `${table} remains empty`);
  }
});

test('failure after local draft recording rolls back the entire clarification generation', (t) => {
  const fixture = createStore(t);
  const initial = facts('atomic-clarification');
  const imported = importFacts(fixture.db, initial, 'atomic-clarification:import');
  recordCorrelation(fixture.db, correlateEmailReadOnly(fixture.db, initial), 'atomic-clarification:correlate');
  const input = { messageRefId: imported.messageRefId, candidates: [fixture.first, fixture.second] };
  const prepared = prepareClarification(fixture.db, input);
  fixture.db.exec("CREATE TRIGGER test_clarification_fail BEFORE INSERT ON email_clarifications BEGIN SELECT RAISE(ABORT,'test-clarification-interruption'); END");
  const bound = { ...input, preparationDigest: prepared.preparationDigest,
    inReplyTo: '<real@source.example.test>', references: ['<real@source.example.test>'], replySubject: 'Re: Actual native subject' };
  assert.throws(() => prepareClarification(fixture.db, bound), /test-clarification-interruption/);
  for (const table of ['job_email_outgoing_draft_requests', 'job_email_outgoing_draft_results',
    'job_email_outgoing_proposals_v3', 'job_email_approved_contents_v1', 'email_clarifications']) {
    assert.equal(fixture.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
  fixture.db.exec('DROP TRIGGER test_clarification_fail');
  assert.equal(prepareClarification(fixture.db, bound).deliveryState, 'awaiting_native_draft');
});

test('clarification autoapproval retains every candidate manual override and rechecks decision-time races', (t) => {
  const fixture = createStore(t);
  const initial = facts('manual-candidate-question');
  const imported = importFacts(fixture.db, initial, 'manual-candidate:import');
  recordCorrelation(fixture.db, correlateEmailReadOnly(fixture.db, initial), 'manual-candidate:correlate');
  const opened = openClarification(fixture.db, { messageRefId: imported.messageRefId, candidates: [fixture.first, fixture.second] });
  captureTestNativeDraft(fixture.db, opened.proposalId);
  fixture.db.prepare("INSERT INTO job_email_approval_policy(application_id,mode,set_by) VALUES (?,'manual','test')").run(fixture.second);
  const approve = { proposalId: opened.proposalId, applicationId: fixture.first, home: fixture.home };
  assert.throws(() => autoApproveProposal(fixture.db, approve), { code: 'APPROVAL_POLICY_MANUAL' });
  assert.throws(() => autoApproveProposal(fixture.db, { ...approve, applicationId: undefined }), { code: 'APPROVAL_POLICY_MANUAL' });
  fixture.db.prepare("UPDATE job_email_approval_policy SET mode='auto' WHERE application_id=?").run(fixture.second);
  assert.throws(() => autoApproveProposal(fixture.db, { ...approve, now: () => {
    fixture.db.prepare("UPDATE job_email_approval_policy SET mode='manual' WHERE application_id=?").run(fixture.second);
    return new Date().toISOString();
  } }), /channel|authenticated|authentication/i);
  assert.equal(fixture.db.prepare('SELECT count(*) n FROM job_email_approval_receipts_v2').get().n, 0);
});

test('fabric resumes an unsent clarification and blocks only after the external sent receipt is synchronized', (t) => {
  const fixture = createStore(t);
  fixture.db.prepare("UPDATE applications SET workflow_stage='submitted' WHERE id IN (?,?)").run(fixture.first, fixture.second);
  fixture.db.prepare("UPDATE application_preparation_plans SET mode_id=(SELECT id FROM application_preparation_modes WHERE slug='managed') WHERE application_id IN (?,?)")
    .run(fixture.first, fixture.second);
  const initial = facts('fabric-clarification-question');
  const imported = importFacts(fixture.db, initial, 'fabric-clarification:import');
  recordCorrelation(fixture.db, correlateEmailReadOnly(fixture.db, initial), 'fabric-clarification:correlate');
  const input = { messageRefId: imported.messageRefId, candidates: [fixture.first, fixture.second] };
  const opened = openClarification(fixture.db, input);
  const itemFor = () => deriveFabricNext(fixture.db).subjects.find((subject) =>
    subject.subjectKind === 'application' && subject.subjectId === fixture.first)?.items
    .find((item) => item.node === 'email.review' && item.act.messageRefId === imported.messageRefId);
  const unsent = itemFor();
  assert.ok(unsent, JSON.stringify(deriveFabricNext(fixture.db)));
  assert.equal(unsent.status, 'eligible');
  assert.equal(unsent.act.clarification.proposalId, opened.proposalId);
  assert.equal(unsent.act.clarification.askedAt, null);
  assert.match(unsent.reason, /unsent.*resume the same proposal/);
  assert.ok(unsent.commands.some((command) => command.includes('email clarify')));
  let transmissions = 0;
  const sent = openClarification(fixture.db, input, { home: fixture.home, transmit: () => {
    transmissions += 1;
    return { providerMessageId: 'fabric-native-outbound', providerThreadId: initial.source.threadId };
  } });
  assert.equal(sent.deliveryState, 'sent');
  const waiting = itemFor();
  assert.equal(waiting.status, 'blocked');
  assert.equal(waiting.idempotencyKey, unsent.idempotencyKey);
  assert.deepEqual(waiting.commands, []);
  assert.equal(waiting.act.clarification.sentMessageId, 'fabric-native-outbound');
  assert.equal(waiting.wakeAt, sent.expiresAt);
  assert.equal(prepareClarification(fixture.db, input).askedAt, sent.askedAt);
  assert.equal(transmissions, 1);
});

test('clarification round-trips through an explicit external executor and the exact reply basis', (t) => {
  const fixture = createStore(t);
  const initial = facts('ambiguous-welcome', {
    applicationRefs: [{ namespace: 'bracket_code', value: 'DRV-A1B2C3D4E5' }],
    evidence: [
      { field: 'subject', excerpt: 'Welcome Chat' },
      { field: 'body', excerpt: 'Conversation reference: [DRV-A1B2C3D4E5]' }
    ]
  });
  const imported = importFacts(fixture.db, initial, 'r4:initial:import');
  const ambiguous = correlateEmailReadOnly(fixture.db, initial);
  assert.equal(ambiguous.resolution, 'ambiguous');
  assert.equal(ambiguous.clarifiable, true);
  recordCorrelation(fixture.db, ambiguous, 'r4:initial:correlate');

  let transmissions = 0;
  const transmit = ({ recipient, bodyText }) => {
    transmissions += 1;
    assert.equal(recipient, 'careers@mydrove.com');
    assert.match(bodyText, /Platform Engineer or Site Reliability Engineer\?/);
    assert.match(bodyText, /Conversation reference: \[DRV-A1B2C3D4E5\]/);
    assert.match(bodyText, /Best regards,\nCole Applicant$/);
    assert.equal((bodyText.match(/\?/g) || []).length, 1, 'one clarification contains exactly one question');
    return { providerMessageId: 'clarification-outbound-1', providerThreadId: initial.source.threadId };
  };
  const opened = openClarification(fixture.db, {
    messageRefId: imported.messageRefId,
    candidates: [fixture.first, fixture.second]
  }, { home: fixture.home, transmit });
  assert.equal(opened.status, 'pending');
  assert.equal(opened.deliveryState, 'sent');
  assert.equal(opened.sentMessageId, 'clarification-outbound-1');
  assert.equal(transmissions, 1);
  assert.equal(fixture.db.prepare('SELECT count(*) AS n FROM job_email_outgoing_proposals_v3').get().n, 1);
  assert.equal(fixture.db.prepare('SELECT count(*) AS n FROM job_email_approval_receipts_v2').get().n, 1);
  assert.equal(fixture.db.prepare('SELECT count(*) AS n FROM job_email_send_requests_v2').get().n, 1);
  assert.equal(listInboundQueue(fixture.db).find((entry) => entry.messageRefId === imported.messageRefId).via, 'clarifying');

  // Replaying the same decision resumes its one-send receipt. It cannot mint a
  // second proposal or transmit a second nudge.
  const replay = openClarification(fixture.db, {
    messageRefId: imported.messageRefId,
    candidates: `${fixture.first},${fixture.second}`
  }, { home: fixture.home, transmit });
  assert.equal(replay.reused, true);
  assert.equal(transmissions, 1);
  assert.equal(fixture.db.prepare('SELECT count(*) AS n FROM email_clarifications').get().n, 1);

  const olderAnswer = facts('clarification-answer-before-question', {
    receivedAt: new Date(Date.parse(opened.askedAt) - 1_000).toISOString(),
    postingRefs: [{ roleTitle: 'Platform Engineer' }],
    evidence: [
      { field: 'subject', excerpt: 'Re: Quick question' },
      { field: 'body', excerpt: 'This is for the Platform Engineer role.' }
    ],
    replyRequested: false
  });
  assert.equal(correlateEmailReadOnly(fixture.db, olderAnswer).candidates.some((candidate) =>
    candidate.matchBasis === 'clarification_reply'), false,
  'mail received before the question was sent cannot answer it');

  const answer = facts('clarification-answer', {
    postingRefs: [{ roleTitle: 'Platform Engineer' }],
    evidence: [
      { field: 'subject', excerpt: 'Re: Quick question' },
      { field: 'body', excerpt: 'This is for the Platform Engineer role.' }
    ],
    replyRequested: false
  });
  const answerImport = importFacts(fixture.db, answer, 'r4:answer:import');
  const exact = correlateEmailReadOnly(fixture.db, answer);
  assert.equal(exact.resolution, 'linked');
  assert.equal(exact.resolved.applicationId, fixture.first);
  assert.equal(exact.resolved.matchBasis, 'clarification_reply');
  assert.equal(exact.automaticEligible, true);
  const recorded = recordCorrelation(fixture.db, exact, 'r4:answer:correlate');
  assert.equal(recorded.learning.titleAliases, 1,
    'the automatic exact path learns the grounded title bound by clarification evidence');
  assert.deepEqual(fixture.db.prepare(`
    SELECT application_id,value FROM email_identity_learnings
    WHERE source_message_ref_id=? AND kind='title_alias' AND retracted_at IS NULL
  `).all(answerImport.messageRefId), [{ application_id: fixture.first, value: 'Platform Engineer' }]);
  assert.equal(recorded.clarification.status, 'answered');
  assert.equal(recorded.clarification.answeredMessageRefId, answerImport.messageRefId);
  assert.equal(recorded.clarification.selectedApplicationId, fixture.first);
  assert.equal(listInboundQueue(fixture.db).some((entry) => entry.messageRefId === imported.messageRefId), false,
    'the answered original ambiguity leaves the queue');
  assert.throws(
    () => fixture.db.prepare("UPDATE email_clarifications SET question_text='different' WHERE message_ref_id=?").run(imported.messageRefId),
    /immutable/
  );
});

test('a pending but unsent clarification cannot create an exact reply match', (t) => {
  const fixture = createStore(t);
  const initial = facts('unsent-clarification');
  const imported = importFacts(fixture.db, initial, 'r4:unsent:import');
  recordCorrelation(fixture.db, correlateEmailReadOnly(fixture.db, initial), 'r4:unsent:correlate');
  fixture.db.prepare("INSERT INTO job_email_approval_policy(application_id,mode,set_by) VALUES (?,'manual','test')")
    .run(fixture.first);
  const opened = openClarification(fixture.db, {
    messageRefId: imported.messageRefId,
    candidates: [fixture.first, fixture.second]
  }, { home: fixture.home });
  assert.equal(opened.deliveryState, 'awaiting_native_draft');
  assert.equal(opened.askedAt, null);
  assert.equal(opened.sentMessageId, null);

  const answer = facts('unsent-clarification-answer', {
    postingRefs: [{ roleTitle: 'Platform Engineer' }],
    evidence: [
      { field: 'subject', excerpt: 'Re: Quick question' },
      { field: 'body', excerpt: 'This is for the Platform Engineer role.' }
    ],
    replyRequested: false
  });
  assert.equal(correlateEmailReadOnly(fixture.db, answer).candidates.some((candidate) =>
    candidate.matchBasis === 'clarification_reply'), false);
});

test('an imported provider-rethreaded reply needs one exact body reference and one offered title', (t) => {
  const fixture = createStore(t);
  const reference = 'DRV-R3THR34D99';
  const initial = facts('rethreaded-question', {
    applicationRefs: [{ namespace: 'bracket_code', value: reference }],
    evidence: [
      { field: 'subject', excerpt: 'Quick question' },
      { field: 'body', excerpt: `Conversation reference: [${reference}]` }
    ]
  });
  const imported = importFacts(fixture.db, initial, 'r4:rethreaded:initial:import');
  recordCorrelation(fixture.db, correlateEmailReadOnly(fixture.db, initial), 'r4:rethreaded:initial:correlate');
  const opened = openClarification(fixture.db, {
    messageRefId: imported.messageRefId,
    candidates: [fixture.first, fixture.second]
  }, {
    home: fixture.home,
    transmit: () => ({ providerMessageId: 'rethreaded-question-native-id', providerThreadId: initial.source.threadId })
  });

  // Gmail source timestamps are minute-granular in this lane. Exercise a
  // source time just before askedAt while the durable import proves that the
  // message was actually observed after the question.
  const askedMs = Date.parse(opened.askedAt);
  const roundedSourceTime = new Date(Math.floor(askedMs / 60_000) * 60_000).toISOString();
  const answer = facts('rethreaded-answer', {
    receivedAt: roundedSourceTime,
    applicationRefs: [{ namespace: 'bracket_code', value: reference }],
    postingRefs: [{ roleTitle: 'Platform Engineer' }],
    evidence: [
      { field: 'subject', excerpt: 'Quick question' },
      { field: 'body', excerpt: 'This is about the Platform Engineer role.' },
      { field: 'body', excerpt: `[${reference}]` }
    ],
    replyRequested: false
  });
  answer.source.threadId = 'gmail-rewritten-thread';
  const answerImport = importFacts(fixture.db, answer, 'r4:rethreaded:answer:import');
  const exact = correlateEmailReadOnly(fixture.db, answer);
  assert.equal(exact.resolution, 'linked');
  assert.equal(exact.resolved.matchBasis, 'clarification_reply');
  assert.equal(exact.resolved.applicationId, fixture.first);
  assert.equal(exact.resolved.confidence, 1);
  assert.equal(exact.automaticEligible, true);
  assert.deepEqual(exact.evidence.filter((entry) => entry.kind === 'clarification_reply'), [
    { kind: 'clarification_reply', value: opened.clarificationId }
  ]);
  const recorded = recordCorrelation(fixture.db, exact, 'r4:rethreaded:answer:correlate');
  assert.equal(recorded.clarification.status, 'answered');
  assert.equal(recorded.clarification.answeredMessageRefId, answerImport.messageRefId);
  assert.ok(Date.parse(recorded.clarification.answeredAt) >= Date.parse(opened.askedAt));
  const replay = recordCorrelation(fixture.db, exact, 'r4:rethreaded:answer:correlate');
  assert.deepEqual(replay, recorded);
  assert.equal(fixture.db.prepare('SELECT count(*) n FROM job_email_correlations WHERE message_ref_id=?')
    .get(answerImport.messageRefId).n, 1);
  assert.equal(fixture.db.prepare("SELECT count(*) n FROM email_clarifications WHERE status='answered'").get().n, 1);
});

test('the provider-rethread fallback rejects subject-only tokens, unresolved company identity, and pre-question imports', (t) => {
  const fixture = createStore(t);
  const reference = 'DRV-SAFEFALL99';
  const initial = facts('fallback-safety-question', {
    applicationRefs: [{ namespace: 'bracket_code', value: reference }],
    evidence: [{ field: 'body', excerpt: `[${reference}]` }]
  });
  const imported = importFacts(fixture.db, initial, 'r4:fallback-safety:initial:import');
  recordCorrelation(fixture.db, correlateEmailReadOnly(fixture.db, initial), 'r4:fallback-safety:initial:correlate');
  const early = facts('fallback-early-import', {
    receivedAt: new Date(Date.now() + 60_000).toISOString(),
    applicationRefs: [{ namespace: 'bracket_code', value: reference }],
    postingRefs: [{ roleTitle: 'Platform Engineer' }],
    evidence: [
      { field: 'body', excerpt: 'This is about the Platform Engineer role.' },
      { field: 'body', excerpt: `[${reference}]` }
    ],
    replyRequested: false
  });
  early.source.threadId = 'rewritten-fallback-early-import';
  importFacts(fixture.db, early, 'r4:fallback-safety:early:import');
  const afterEarlyImport = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(afterEarlyImport, 0, 0, 1_050);
  const opened = openClarification(fixture.db, {
    messageRefId: imported.messageRefId,
    candidates: [fixture.first, fixture.second]
  }, {
    home: fixture.home,
    transmit: () => ({ providerMessageId: 'fallback-safety-outbound', providerThreadId: initial.source.threadId })
  });
  const reply = (messageId) => {
    const value = facts(messageId, {
      receivedAt: new Date(Date.parse(opened.askedAt) + 1_000).toISOString(),
      applicationRefs: [{ namespace: 'bracket_code', value: reference }],
      postingRefs: [{ roleTitle: 'Platform Engineer' }],
      evidence: [
        { field: 'subject', excerpt: 'Quick question' },
        { field: 'body', excerpt: 'This is about the Platform Engineer role.' },
        { field: 'body', excerpt: `[${reference}]` }
      ],
      replyRequested: false
    });
    value.source.threadId = `rewritten-${messageId}`;
    return value;
  };
  const hasExact = (value) => correlateEmailReadOnly(fixture.db, value).candidates.some((candidate) =>
    candidate.matchBasis === 'clarification_reply');

  const subjectOnly = reply('fallback-subject-only');
  subjectOnly.evidence = subjectOnly.evidence.filter((entry) => entry.excerpt !== `[${reference}]`);
  subjectOnly.evidence.push({ field: 'subject', excerpt: `[${reference}]` });
  importFacts(fixture.db, subjectOnly, 'r4:fallback-safety:subject-only:import');
  assert.equal(hasExact(subjectOnly), false);

  const wrongReference = reply('fallback-wrong-reference');
  wrongReference.source.threadId = initial.source.threadId;
  wrongReference.applicationRefs = [{ namespace: 'bracket_code', value: 'DRV-WRONGREF99' }];
  wrongReference.evidence = wrongReference.evidence.map((entry) => ({
    ...entry,
    excerpt: entry.excerpt === `[${reference}]` ? '[DRV-WRONGREF99]' : entry.excerpt
  }));
  importFacts(fixture.db, wrongReference, 'r4:fallback-safety:wrong-reference:import');
  assert.equal(hasExact(wrongReference), false,
    'a supplied conflicting token vetoes the otherwise matching provider thread');

  const missingReference = reply('fallback-missing-reference');
  missingReference.applicationRefs = [];
  missingReference.evidence = missingReference.evidence.filter((entry) => entry.excerpt !== `[${reference}]`);
  importFacts(fixture.db, missingReference, 'r4:fallback-safety:missing-reference:import');
  assert.equal(hasExact(missingReference), false);

  const noTitle = reply('fallback-no-title');
  noTitle.postingRefs = [];
  noTitle.evidence = noTitle.evidence.filter((entry) => !entry.excerpt.includes('Platform Engineer'));
  importFacts(fixture.db, noTitle, 'r4:fallback-safety:no-title:import');
  assert.equal(hasExact(noTitle), false);

  const multipleTitles = reply('fallback-multiple-titles');
  multipleTitles.postingRefs.push({ roleTitle: 'Site Reliability Engineer' });
  multipleTitles.evidence.push({
    field: 'body',
    excerpt: 'It may instead concern the Site Reliability Engineer role.'
  });
  importFacts(fixture.db, multipleTitles, 'r4:fallback-safety:multiple-titles:import');
  assert.equal(hasExact(multipleTitles), false);

  const unresolved = reply('fallback-unresolved-company');
  unresolved.source.fromAddress = 'other@example.test';
  unresolved.source.fromDomain = 'example.test';
  unresolved.source.fromDisplayName = 'Recruiting';
  unresolved.company = { name: 'Another Company' };
  importFacts(fixture.db, unresolved, 'r4:fallback-safety:identity:import');
  assert.equal(hasExact(unresolved), false);

  assert.equal(hasExact(early), false);
});

test('a reference shared by two pending clarifications cannot become an exact reply', (t) => {
  const fixture = createStore(t);
  const reference = 'DRV-DUPLICATE9';
  const openQuestion = (messageId, threadId, key) => {
    const initial = facts(messageId, {
      applicationRefs: [{ namespace: 'bracket_code', value: reference }],
      evidence: [{ field: 'body', excerpt: `[${reference}]` }]
    });
    initial.source.threadId = threadId;
    const imported = importFacts(fixture.db, initial, `${key}:import`);
    recordCorrelation(fixture.db, correlateEmailReadOnly(fixture.db, initial), `${key}:correlate`);
    return openClarification(fixture.db, {
      messageRefId: imported.messageRefId,
      candidates: [fixture.first, fixture.second]
    }, {
      home: fixture.home,
      transmit: () => ({ providerMessageId: `${key}-outbound`, providerThreadId: threadId })
    });
  };
  const first = openQuestion('duplicate-reference-question-1', 'duplicate-question-thread-1', 'r4:duplicate:one');
  const second = openQuestion('duplicate-reference-question-2', 'duplicate-question-thread-2', 'r4:duplicate:two');
  const answer = facts('duplicate-reference-answer', {
    receivedAt: new Date(Math.max(Date.parse(first.askedAt), Date.parse(second.askedAt)) + 1_000).toISOString(),
    applicationRefs: [{ namespace: 'bracket_code', value: reference }],
    postingRefs: [{ roleTitle: 'Platform Engineer' }],
    evidence: [
      { field: 'body', excerpt: 'This is about the Platform Engineer role.' },
      { field: 'body', excerpt: `[${reference}]` }
    ],
    replyRequested: false
  });
  answer.source.threadId = 'duplicate-reference-rewritten-answer';
  importFacts(fixture.db, answer, 'r4:duplicate:answer:import');
  assert.equal(correlateEmailReadOnly(fixture.db, answer).candidates.some((candidate) =>
    candidate.matchBasis === 'clarification_reply'), false);
  assert.equal(fixture.db.prepare("SELECT count(*) n FROM email_clarifications WHERE status='pending'").get().n, 2);
});

test('clarification compares and snapshots only non-retracted candidates from the latest ambiguity', (t) => {
  const fixture = createStore(t);
  const third = runCli(fixture.home, [
    'add-application', '--company', 'Drove', '--role', 'Data Engineer', '--status', 'applied'
  ]).application.id;
  const initial = facts('ambiguous-after-candidate-retraction');
  const imported = importFacts(fixture.db, initial, 'r4:active-candidates:import');
  const ambiguous = correlateEmailReadOnly(fixture.db, initial);
  assert.equal(ambiguous.resolution, 'ambiguous');
  assert.deepEqual(
    [...new Set(ambiguous.candidates.map((candidate) => candidate.applicationId))].sort((left, right) => left - right),
    [fixture.first, fixture.second, third]
  );
  recordCorrelation(fixture.db, ambiguous, 'r4:active-candidates:correlate');
  fixture.db.prepare(`
    INSERT INTO email_link_retractions(message_ref_id,application_id,actor,reason)
    VALUES (?,?,?,?)
  `).run(imported.messageRefId, fixture.first, 'test', 'candidate was ruled out');

  const opened = openClarification(fixture.db, {
    messageRefId: imported.messageRefId,
    candidates: [fixture.second, third]
  }, {
    home: fixture.home,
    transmit: ({ bodyText }) => {
      assert.match(bodyText, /Site Reliability Engineer or Data Engineer\?/u);
      assert.doesNotMatch(bodyText, /Platform Engineer/u);
      return { providerMessageId: 'clarification-active-candidates-outbound', providerThreadId: initial.source.threadId };
    }
  });

  assert.deepEqual(opened.candidates.map((candidate) => candidate.applicationId), [fixture.second, third]);
  assert.doesNotMatch(opened.question, /Platform Engineer/u);
  const stored = fixture.db.prepare(`
    SELECT candidate_application_ids_json,candidate_snapshot_json FROM email_clarifications WHERE message_ref_id=?
  `).get(imported.messageRefId);
  assert.deepEqual(JSON.parse(stored.candidate_application_ids_json), [fixture.second, third]);
  assert.deepEqual(
    JSON.parse(stored.candidate_snapshot_json).candidates.map((candidate) => candidate.applicationId),
    [fixture.second, third]
  );
});

test('clarification questions echo only bounded token-shaped references', () => {
  const safe = questionFor(['Platform Engineer', 'Site Reliability Engineer'], 'Cole Applicant', 'drv-a1b2c3');
  assert.match(safe, /Conversation reference: \[DRV-A1B2C3\]/u);
  const hostile = questionFor(['Platform Engineer', 'Site Reliability Engineer'], 'Cole Applicant', 'DRV-GOOD\nBcc: attacker@example.test');
  assert.doesNotMatch(hostile, /Conversation reference|Bcc:/u);
  assert.equal((hostile.match(/\?/g) || []).length, 1);

  const grounded = (applicationRefs, evidence) => clarificationReference({ applicationRefs, evidence });
  const exact = { namespace: 'bracket_code', value: 'DRV-A1B2C3' };
  assert.equal(grounded([exact], [{ field: 'body', excerpt: 'Conversation reference: [DRV-A1B2C3]' }]), 'DRV-A1B2C3');
  assert.equal(grounded([{ namespace: 'application_id', value: 'DRV-A1B2C3' }], [{ field: 'body', excerpt: '[DRV-A1B2C3]' }]), null);
  assert.equal(grounded([exact], [{ field: 'subject', excerpt: '[DRV-A1B2C3]' }]), null);
  assert.equal(grounded([
    exact,
    { namespace: 'bracket_code', value: 'DRV-D4E5F6' }
  ], [{ field: 'body', excerpt: '[DRV-A1B2C3] [DRV-D4E5F6]' }]), null);
});

test('expiry returns the original item to the agent and never permits a second question', (t) => {
  const fixture = createStore(t);
  const initial = facts('expires-welcome');
  const imported = importFacts(fixture.db, initial, 'r4:expiry:import');
  const ambiguous = correlateEmailReadOnly(fixture.db, initial);
  recordCorrelation(fixture.db, ambiguous, 'r4:expiry:correlate');
  let transmissions = 0;
  const deps = {
    home: fixture.home,
    transmit: () => {
      transmissions += 1;
      return { providerMessageId: 'clarification-expiry-outbound', providerThreadId: initial.source.threadId };
    }
  };
  const opened = openClarification(fixture.db, {
    messageRefId: imported.messageRefId,
    candidates: [fixture.first, fixture.second]
  }, deps);
  const expired = expireClarifications(fixture.db, { now: new Date(Date.parse(opened.expiresAt) + 1) });
  assert.equal(expired.expired, 1);
  const queue = listInboundQueue(fixture.db, { now: new Date(Date.parse(opened.expiresAt) + 1) });
  assert.equal(queue.find((entry) => entry.messageRefId === imported.messageRefId).via, 'ambiguous');
  const replay = openClarification(fixture.db, {
    messageRefId: imported.messageRefId,
    candidates: [fixture.first, fixture.second]
  }, deps);
  assert.equal(replay.status, 'expired');
  assert.equal(transmissions, 1);
  const lateAnswer = facts('expired-clarification-answer', {
    receivedAt: new Date(Date.parse(opened.expiresAt) + 1_000).toISOString(),
    postingRefs: [{ roleTitle: 'Platform Engineer' }],
    evidence: [
      { field: 'subject', excerpt: 'Re: Quick question' },
      { field: 'body', excerpt: 'This is for the Platform Engineer role.' }
    ],
    replyRequested: false
  });
  assert.equal(correlateEmailReadOnly(fixture.db, lateAnswer).candidates.some((candidate) =>
    candidate.matchBasis === 'clarification_reply'), false);
});

test('migration and CLI seam are registered with strict candidates input', (t) => {
  // Keep actual CLI migration registration under test on a fresh store.
  const fixture = createStore(t, { cold: true });
  assert.equal(
    fixture.db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?').get(CLARIFICATION_SCHEMA_VERSION).name,
    CLARIFICATION_MIGRATION_NAME
  );
  const initial = facts('cli-welcome');
  const imported = importFacts(fixture.db, initial, 'r4:cli:import');
  recordCorrelation(fixture.db, correlateEmailReadOnly(fixture.db, initial), 'r4:cli:correlate');
  assert.throws(
    () => runEmailCommand(fixture.db, ['clarify'], { messageRefId: String(imported.messageRefId), candidates: String(fixture.first) }, {
      clarification: { home: fixture.home, transmit: () => ({ providerMessageId: 'never', providerThreadId: initial.source.threadId }) }
    }),
    /at least two/
  );
  fixture.db.prepare("INSERT INTO job_email_approval_policy(application_id,mode,set_by) VALUES (?,'manual','test')")
    .run(fixture.first);
  const cliResult = runCli(fixture.home, [
    'email', 'clarify', '--message-ref-id', String(imported.messageRefId),
    '--candidates', `${fixture.first},${fixture.second}`
  ]);
  assert.equal(cliResult.command, 'clarify');
  assert.equal(cliResult.deliveryState, 'awaiting_source_headers');
  assert.equal(cliResult.status, 'preparing');
  const issued = runCli(fixture.home, [
    'email', 'clarify', '--message-ref-id', String(imported.messageRefId),
    '--candidates', `${fixture.first},${fixture.second}`, '--in-reply-to', '<source@mydrove.com>',
    '--references', '["<source@mydrove.com>"]', '--reply-subject', 'Re: Actual native subject', '--preparation-digest', cliResult.preparationDigest
  ]);
  assert.equal(issued.deliveryState, 'awaiting_native_draft');
  assert.equal(issued.status, 'pending');
});

test('a provider-threaded answer binds at the provider\'s time precision, and only once it is durably imported', (t) => {
  // Gmail reports a message's source time at minute precision, so the company's
  // reply a few seconds after the question carries a receivedAt BEFORE asked_at.
  // The thread arm must compare at that precision (as the reference arm already
  // did) while still refusing anything that was not imported after the ask.
  function askedClarification(fixture, suffix) {
    const question = facts(`minute-question-${suffix}`, {
      evidence: [
        { field: 'subject', excerpt: 'Quick question' },
        { field: 'body', excerpt: 'Could you reply with a few times that work for you this week?' }
      ]
    });
    const imported = importFacts(fixture.db, question, `r4:minute:${suffix}:import`);
    const ambiguous = correlateEmailReadOnly(fixture.db, question);
    assert.equal(ambiguous.resolution, 'ambiguous');
    assert.equal(ambiguous.clarifiable, true);
    recordCorrelation(fixture.db, ambiguous, `r4:minute:${suffix}:correlate`);
    const opened = openClarification(fixture.db, {
      messageRefId: imported.messageRefId,
      candidates: [fixture.first, fixture.second]
    }, {
      home: fixture.home,
      transmit: () => ({ providerMessageId: `clarification-outbound-${suffix}`, providerThreadId: question.source.threadId })
    });
    assert.equal(opened.deliveryState, 'sent');
    return opened;
  }
  const answerFacts = (messageId, receivedAt) => facts(messageId, {
    receivedAt,
    postingRefs: [{ roleTitle: 'Platform Engineer' }],
    evidence: [
      { field: 'subject', excerpt: 'Re: Quick question' },
      { field: 'body', excerpt: 'Yes — this is about the Platform Engineer role.' }
    ],
    replyRequested: false
  });
  const exactReply = (fixture, answer) => correlateEmailReadOnly(fixture.db, answer).candidates
    .some((candidate) => candidate.matchBasis === 'clarification_reply');

  // Same minute as the question: allowed once imported, refused before that.
  const sameMinute = createStore(t);
  const opened = askedClarification(sameMinute, 'same');
  const minuteFloor = new Date(Math.floor(Date.parse(opened.askedAt) / 60_000) * 60_000).toISOString();
  assert.ok(Date.parse(minuteFloor) <= Date.parse(opened.askedAt), 'the truncated source time precedes or equals the ask');
  const answer = answerFacts('minute-answer-same', minuteFloor);
  assert.equal(exactReply(sameMinute, answer), false, 'an unimported reply has no durable observation and cannot answer');
  importFacts(sameMinute.db, answer, 'r4:minute:same:answer:import');
  const exact = correlateEmailReadOnly(sameMinute.db, answer);
  assert.equal(exact.resolution, 'linked');
  assert.equal(exact.resolved.matchBasis, 'clarification_reply');
  assert.equal(exact.resolved.applicationId, sameMinute.first);
  assert.equal(exact.automaticEligible, true);
  const recorded = recordCorrelation(sameMinute.db, exact, 'r4:minute:same:answer:record');
  assert.equal(recorded.clarification.status, 'answered');
  assert.equal(recorded.clarification.selectedApplicationId, sameMinute.first);

  // The previous minute is older than the question even at minute precision.
  const previousMinute = createStore(t);
  const earlier = askedClarification(previousMinute, 'earlier');
  const priorMinute = new Date(Math.floor(Date.parse(earlier.askedAt) / 60_000) * 60_000 - 60_000).toISOString();
  const stale = answerFacts('minute-answer-earlier', priorMinute);
  importFacts(previousMinute.db, stale, 'r4:minute:earlier:answer:import');
  assert.equal(exactReply(previousMinute, stale), false, 'a reply from the previous minute predates the question');
  assert.equal(previousMinute.db.prepare("SELECT status FROM email_clarifications").get().status, 'pending');
});
