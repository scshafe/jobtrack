'use strict';

// The email agent lane (applysim plan L7-B): a relay-recorded linked correlation
// becomes fabric work for the applicant's agent; the agent's transition proposal
// is assembled from stored evidence; one handling decision retires the item.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createTestStore } = require('../test-support/migrated-store');

const { correlateEmailReadOnly, importFacts, recordCorrelation } = require('../lib/email-integration');
const emailLearning = require('../lib/email-correlation/learn');
const { deriveFabricNext } = require('../lib/fabric');
const {
  EmailAgentLaneError, buildTransitionProposal, listInboundQueue, listOutstandingReplies, listStaleUnmatched, recordHandlingDecision, recordReplyAttempt, setTransmitReadinessProbe, resolveFromAgent, runEmailAgentLaneCommand, transitionFromAgent
} = require('../lib/email-agent-lane');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function runCli(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], { env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8' }));
}

function createStore(t) {
  const { root: rootDir, home } = createTestStore('jobtrack-agent-lane-');
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return { home, open() { const db = new Database(path.join(home, 'jobtrack.db')); db.pragma('foreign_keys = ON'); return db; } };
}

function promoteManagedApplication(store, { role, suffix, observedAt }) {
  const opportunityId = runCli(store.home, [
    'opportunity', 'ingest', '--source', 'manual', '--company', 'Drove', '--role', role,
    '--url', `https://applysim.example.test/sites/drove/${suffix}`, '--description', `${role} at Drove.`,
    '--observed-at', observedAt, '--parser-name', 'manual-web-result', '--parser-version', '1',
    '--idempotency-key', `lane-ingest-${suffix}`
  ]).opportunity.id;
  runCli(store.home, [
    'opportunity', 'triage', '--opportunity-id', String(opportunityId), '--decision', 'shortlist',
    '--rationale', 'fits', '--score', '0.9', '--score-coverage', '0.9'
  ]);
  return runCli(store.home, [
    'opportunity', 'promote', '--opportunity-id', String(opportunityId)
  ]).application.id;
}

function welcomeFacts(overrides = {}) {
  return {
    schemaVersion: 'job-application-email-facts.v2',
    trust: 'untrusted_external',
    source: {
      provider: 'apple_mail_emlx', accountId: 'applicant@umich.test', messageId: 'arc-welcome-1', threadId: 'arc-thread-1',
      receivedAt: '2026-09-02T03:00:00.000Z', fromAddress: 'careers@mydrove.test', fromDomain: 'mydrove.test',
      contentDigest: sha256('welcome content')
    },
    contentCompleteness: 'sanitized_plain_text',
    eventKind: 'application_received',
    company: { name: 'Third Party ATS', domain: 'thirdparty-ats.test' },
    postingRefs: [],
    applicationRefs: [],
    replyRequested: false,
    evidence: [{ field: 'subject', excerpt: 'Thanks for applying to Drove' }],
    extraction: { provider: 'inbox-pipeline', version: 'jobtrack-relay.v3', confidence: 0.9 },
    security: { risk: 'low', requiresReview: false },
    ...overrides
  };
}

/** One application at Drove whose company domain is the sender domain → the relay's correlation links it. */
function linkedWelcome(t, { factsOverrides = {} } = {}) {
  const store = createStore(t);
  // A MANAGED application, the way the arc creates one: ingest → triage → promote.
  const applicationId = promoteManagedApplication(store, {
    role: 'Platform Engineer', suffix: 'flow', observedAt: '2026-09-02T02:00:00Z'
  });
  const db = store.open();
  const companyId = db.prepare("SELECT id FROM companies WHERE normalized_name='drove'").get().id;
  db.prepare('UPDATE companies SET website_domain=? WHERE id=?').run('mydrove.test', companyId);
  const facts = welcomeFacts(factsOverrides);
  importFacts(db, facts, 'arc-import-1');
  // R3: one identified company plus exactly one open application and an
  // application-specific event links for review on company_single_open.
  const correlation = correlateEmailReadOnly(db, facts);
  assert.equal(correlation.resolution, 'linked', JSON.stringify(correlation).slice(0, 300));
  assert.equal(correlation.resolved.matchBasis, 'company_single_open');
  assert.equal(correlation.automaticEligible, false);
  recordCorrelation(db, correlation, 'arc-record-1');
  const queue = listInboundQueue(db, { applicationId });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].via, 'correlation');
  assert.deepEqual([...new Set(queue[0].candidates?.map((c) => c.applicationId) || [applicationId])], [applicationId]);
  const messageRefId = queue[0].messageRefId;
  return { store, db, applicationId, facts, messageRefId };
}

test('a relay-recorded linked correlation puts the message in the applicant\'s inbound queue, as fabric work, until a decision is recorded', (t) => {
  const { db, applicationId } = linkedWelcome(t);
  try {
    const queue = listInboundQueue(db, { applicationId });
    assert.equal(queue.length, 1);
    const entry = queue[0];
    assert.equal(entry.applicationId, applicationId);
    assert.equal(entry.via, 'correlation', 'no link row exists yet — the (agent-resolved) linked correlation is the pairing');
    assert.equal(entry.eventKind, 'application_received');
    assert.equal(entry.source.replyToAddress, 'careers@mydrove.test', 'reply-to falls back to the sender');
    assert.equal(entry.facts.replyRequested, false);
    assert.equal(entry.facts.security.risk, 'low');

    db.prepare("UPDATE applications SET workflow_stage='submitted' WHERE id=?").run(applicationId);
    const next = deriveFabricNext(db);
    const subject = next.subjects.find((s) => s.subjectKind === 'application' && s.subjectId === applicationId);
    const item = subject.items.find((i) => i.node === 'email.review');
    assert.ok(item, 'the fabric derives an email.review item for the agent');
    assert.equal(item.executor, 'agent');
    assert.equal(item.act.messageRefId, entry.messageRefId);
    assert.match(item.reason, /inbound application_received from mydrove\.test/u);
    assert.equal(item.idempotencyKey, `fabric-email.review-${entry.messageRefId}-a${applicationId}-v1`);
    assert.ok(item.commands.some((c) => c.includes(`email mark-handled`) && c.includes(`fabric-email-handled-${entry.messageRefId}-a${applicationId}`)));

    const handlingKey = `fabric-email-handled-${entry.messageRefId}-a${applicationId}`;
    const decided = recordHandlingDecision(db, {
      messageRefId: entry.messageRefId, applicationId, decision: 'none', actor: 'fabric-worker', authorship: 'agent',
      reason: 'acknowledgement only; nothing to answer', idempotencyKey: handlingKey
    });
    assert.equal(decided.reused, false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM email_identity_learnings').get().n, 0,
      'mark-handled none retires queue work but does not confirm or teach from a single-open link');
    assert.equal(listInboundQueue(db, { applicationId }).length, 0, 'a decision retires the message');
    assert.ok(!deriveFabricNext(db).subjects.find((s) => s.subjectId === applicationId).items.some((i) => i.node === 'email.review'));
    assert.equal(recordHandlingDecision(db, {
      messageRefId: entry.messageRefId, applicationId, decision: 'none', actor: 'fabric-worker', authorship: 'agent',
      reason: 'acknowledgement only; nothing to answer', idempotencyKey: handlingKey
    }).reused, true, 'the same key replays');
    assert.throws(() => recordHandlingDecision(db, {
      messageRefId: entry.messageRefId, applicationId, decision: 'reply', actor: 'fabric-worker', authorship: 'agent',
      reason: 'changed my mind', idempotencyKey: handlingKey
    }), (e) => e instanceof EmailAgentLaneError && e.code === 'IDEMPOTENCY_CONFLICT');
    assert.throws(() => recordHandlingDecision(db, {
      messageRefId: entry.messageRefId, applicationId, decision: 'reply', actor: 'fabric-worker', authorship: 'agent',
      reason: 'second decision', idempotencyKey: 'another-key'
    }), (e) => e.code === 'ALREADY_HANDLED');
    assert.throws(() => recordHandlingDecision(db, {
      messageRefId: entry.messageRefId, applicationId: applicationId + 41, decision: 'none', actor: 'x', authorship: 'agent',
      reason: 'r', idempotencyKey: 'k2'
    }), (e) => e.code === 'NOT_LINKED');
  } finally {
    db.close();
  }
});

test('ambiguous handling keys are scoped to each candidate application', (t) => {
  const store = createStore(t);
  const applicationId = promoteManagedApplication(store, {
    role: 'Platform Engineer', suffix: 'platform', observedAt: '2026-09-02T02:00:00Z'
  });
  const secondApplicationId = promoteManagedApplication(store, {
    role: 'Security Engineer', suffix: 'security', observedAt: '2026-09-02T02:01:00Z'
  });
  const db = store.open();
  try {
    const companyId = db.prepare("SELECT id FROM companies WHERE normalized_name='drove'").get().id;
    db.prepare('UPDATE companies SET website_domain=? WHERE id=?').run('mydrove.test', companyId);
    const facts = welcomeFacts();
    const imported = importFacts(db, facts, 'two-application-import');
    const messageRefId = imported.messageRefId;
    db.prepare("UPDATE applications SET workflow_stage='submitted' WHERE id IN (?,?)").run(applicationId, secondApplicationId);
    const ambiguous = correlateEmailReadOnly(db, facts);
    assert.equal(ambiguous.resolution, 'ambiguous');
    assert.deepEqual(ambiguous.candidates.map((candidate) => [candidate.applicationId, candidate.matchBasis]), [
      [applicationId, 'company_domain'],
      [secondApplicationId, 'company_domain']
    ]);
    const ambiguousRecord = recordCorrelation(db, ambiguous, 'two-application-ambiguous');
    const generation = `-c${ambiguousRecord.correlationId}`;

    const next = deriveFabricNext(db);
    const firstItem = next.subjects.find((subject) => subject.subjectId === applicationId).items
      .find((item) => item.node === 'email.review');
    const secondItem = next.subjects.find((subject) => subject.subjectId === secondApplicationId).items
      .find((item) => item.node === 'email.review');
    assert.equal(firstItem.idempotencyKey, `fabric-email.review-${messageRefId}-a${applicationId}${generation}-v1`);
    assert.equal(secondItem.idempotencyKey, `fabric-email.review-${messageRefId}-a${secondApplicationId}${generation}-v1`);
    assert.notEqual(firstItem.idempotencyKey, secondItem.idempotencyKey);
    assert.ok(firstItem.commands.some((command) => command.includes(`fabric-email-handled-${messageRefId}-a${applicationId}${generation}`)));
    assert.ok(secondItem.commands.some((command) => command.includes(`fabric-email-handled-${messageRefId}-a${secondApplicationId}${generation}`)));

    const firstDecision = recordHandlingDecision(db, {
      messageRefId, applicationId, decision: 'none', actor: 'fabric-worker', authorship: 'agent',
      reason: 'the body names a different role', idempotencyKey: `fabric-email-handled-${messageRefId}-a${applicationId}`
    });
    assert.equal(listInboundQueue(db, { applicationId }).length, 0);
    assert.equal(listInboundQueue(db, { applicationId: secondApplicationId }).length, 1,
      'ruling out one candidate must leave the same message available to the other candidate');
    assert.equal(listInboundQueue(db).length, 1,
      'the unscoped queue retains an ambiguity until every candidate application pair has a decision');
    assert.deepEqual(listInboundQueue(db)[0].candidates.map((candidate) => [candidate.applicationId, candidate.matchBasis]), [
      [applicationId, 'company_domain'],
      [secondApplicationId, 'company_domain']
    ], 'the remaining unscoped item preserves correlation candidate order');

    resolveFromAgent(db, {
      messageRefId, applicationId: secondApplicationId, actor: 'fabric-worker',
      reason: 'the body names Security Engineer', idempotencyKey: `fabric-email-resolve-${messageRefId}`
    });
    assert.deepEqual(recordHandlingDecision(db, {
      messageRefId, applicationId, decision: 'none', actor: 'fabric-worker', authorship: 'agent',
      reason: 'the body names a different role', idempotencyKey: `fabric-email-handled-${messageRefId}-a${applicationId}`
    }), { decisionId: firstDecision.decisionId, reused: true },
    'an exact replay remains valid after the mutable correlation resolves to another application');
    assert.throws(() => recordHandlingDecision(db, {
      messageRefId, applicationId, decision: 'reply', actor: 'fabric-worker', authorship: 'agent',
      reason: 'changed payload', idempotencyKey: `fabric-email-handled-${messageRefId}-a${applicationId}`
    }), (error) => error instanceof EmailAgentLaneError && error.code === 'IDEMPOTENCY_CONFLICT',
    'a changed payload on the committed key still conflicts before mutable-state authorization');
    assert.throws(() => recordHandlingDecision(db, {
      messageRefId, applicationId, decision: 'none', actor: 'fabric-worker', authorship: 'agent',
      reason: 'fresh request after resolution', idempotencyKey: `fabric-email-handled-${messageRefId}-a${applicationId}-fresh`
    }), (error) => error instanceof EmailAgentLaneError && error.code === 'NOT_LINKED',
    'a fresh request must still authorize against the latest correlation');
    const secondDecision = recordHandlingDecision(db, {
      messageRefId, applicationId: secondApplicationId, decision: 'transition', actor: 'fabric-worker', authorship: 'agent',
      reason: 'linked the named role', idempotencyKey: `fabric-email-handled-${messageRefId}-a${secondApplicationId}`
    });
    assert.equal(secondDecision.reused, false, 'the selected candidate gets its own handling idempotency key');
    assert.equal(db.prepare('SELECT count(*) AS n FROM job_email_handling_decisions WHERE message_ref_id=?').get(messageRefId).n, 2);
    assert.equal(listInboundQueue(db).length, 0);
  } finally {
    db.close();
  }
});

test('handling authorization follows only the latest ambiguous correlation state', (t) => {
  const { store, db, applicationId, facts, messageRefId } = linkedWelcome(t);
  try {
    const secondApplicationId = runCli(store.home, [
      'add-application', '--company', 'Drove', '--role', 'Security Engineer', '--status', 'applied'
    ]).application.id;
    const ambiguous = correlateEmailReadOnly(db, facts);
    assert.equal(ambiguous.resolution, 'ambiguous');
    assert.ok(ambiguous.candidates.some((candidate) => candidate.applicationId === secondApplicationId));
    recordCorrelation(db, ambiguous, 'historical-ambiguous');
    resolveFromAgent(db, {
      messageRefId, applicationId, actor: 'fabric-worker', reason: 'the applicant selected Platform Engineer',
      idempotencyKey: 'historical-ambiguous-resolved'
    });

    assert.throws(() => recordHandlingDecision(db, {
      messageRefId, applicationId: secondApplicationId, decision: 'none', actor: 'fabric-worker', authorship: 'agent',
      reason: 'must not authorize against an older candidate set', idempotencyKey: 'historical-ambiguous-wrong-app'
    }), (error) => error instanceof EmailAgentLaneError && error.code === 'NOT_LINKED');
  } finally {
    db.close();
  }
});

test('a uniquely body-grounded bracket code reaches the first-pass fabric reply source', (t) => {
  const { db, applicationId } = linkedWelcome(t, { factsOverrides: {
    applicationRefs: [{ namespace: 'bracket_code', value: 'DRV-A1B2C3D4E5' }],
    evidence: [
      { field: 'subject', excerpt: 'Thanks for applying to Drove' },
      { field: 'body', excerpt: 'Conversation reference: [DRV-A1B2C3D4E5]' }
    ]
  } });
  try {
    const [entry] = listInboundQueue(db, { applicationId });
    assert.equal(entry.source.conversationReference, 'DRV-A1B2C3D4E5');
    db.prepare("UPDATE applications SET workflow_stage='submitted' WHERE id=?").run(applicationId);
    const item = deriveFabricNext(db).subjects.find((subject) => subject.subjectId === applicationId).items
      .find((candidate) => candidate.node === 'email.review');
    assert.equal(item.act.source.conversationReference, 'DRV-A1B2C3D4E5');
  } finally {
    db.close();
  }
});

test('the agent\'s transition proposal is assembled from the stored link and validated by the lane\'s own contract', (t) => {
  const { db, applicationId } = linkedWelcome(t);
  try {
    const [entry] = listInboundQueue(db, { applicationId });
    const proposal = buildTransitionProposal(db, {
      messageRefId: entry.messageRefId,
      action: { kind: 'link_message', relation: 'application_update' },
      evidence: ['Drove acknowledged the application (subject: Thanks for applying to Drove)']
    });
    assert.equal(proposal.schemaVersion, 'jobtrack-transition-proposal.v1');
    assert.equal(proposal.target.applicationId, applicationId);
    assert.equal(proposal.correlation.resolution, 'linked');
    assert.equal(proposal.policyCandidate, 'exact_link');
    assert.equal(proposal.requiresReview, true, 'agent proposals always go through review');
    assert.equal(proposal.automationEligible, false);
    assert.deepEqual(proposal.safety, { contentCompleteness: 'sanitized_plain_text', securityRisk: 'low', sourceRequiresReview: false });

    const proposed = transitionFromAgent(db, {
      messageRefId: entry.messageRefId,
      action: { kind: 'link_message', relation: 'application_update' },
      evidence: ['Drove acknowledged the application'],
      idempotencyKey: 'arc-transition-1'
    });
    assert.ok(proposed.proposalId);
    assert.equal(proposed.reused, false);
    const row = db.prepare('SELECT action_kind, requires_review FROM job_email_transition_proposals WHERE proposal_id=?').get(proposed.proposalId);
    assert.equal(row.action_kind, 'link_message');
    assert.equal(row.requires_review, 1);
    // Reviewed and applied by the agent through the existing lane: the link row appears.
    const reviewed = runEmailAgentLaneCommand(db, 'inbound-queue', { applicationId });
    assert.equal(reviewed.queue.length, 1, 'proposing is not deciding: the item stays until mark-handled');
    assert.throws(() => buildTransitionProposal(db, { messageRefId: entry.messageRefId, action: { kind: 'link_message', relation: 'application_update' }, evidence: [] }), /evidence/u);
    assert.throws(() => buildTransitionProposal(db, { messageRefId: 9999, action: { kind: 'link_message', relation: 'application_update' }, evidence: ['x'] }), (e) => e.code === 'NOT_FOUND');
  } finally {
    db.close();
  }
});

test('the CLI exposes the lane: inbound-queue, transition-from-agent, mark-handled', (t) => {
  const { store, db, applicationId } = linkedWelcome(t);
  db.close();
  const queue = runCli(store.home, ['email', 'inbound-queue', '--application-id', String(applicationId)]);
  assert.equal(queue.queue.length, 1);
  assert.equal(queue.queue[0].via, 'correlation');
  const messageRefId = queue.queue[0].messageRefId;
  const proposed = runCli(store.home, ['email', 'transition-from-agent', '--message-ref-id', String(messageRefId),
    '--action-json', JSON.stringify({ kind: 'link_message', relation: 'application_update' }),
    '--evidence', 'Acknowledgement from careers@||subject names the application', '--idempotency-key', 'cli-transition-1']);
  assert.ok(proposed.proposalId);
  const handled = runCli(store.home, ['email', 'mark-handled', '--message-ref-id', String(messageRefId), '--application-id', String(applicationId),
    '--decision', 'transition', '--actor', 'fabric-worker', '--authorship', 'agent', '--reason', 'linked the acknowledgement', '--idempotency-key', 'cli-handled-1']);
  assert.equal(handled.reused, false);
  assert.equal(runCli(store.home, ['email', 'inbound-queue', '--application-id', String(applicationId)]).queue.length, 0);
});

/** A managed Drove application whose company has NO recorded domain — the arc's real starting point. */
function droveApplicationWithoutDomain(t, { role = 'Platform Engineer' } = {}) {
  const store = createStore(t);
  const opportunityId = runCli(store.home, ['opportunity', 'ingest', '--source', 'manual', '--company', 'Drove', '--role', role,
    '--url', 'https://applysim.example.test/sites/drove/apply', '--description', `${role} at Drove.`,
    '--observed-at', '2026-09-02T02:00:00Z', '--parser-name', 'manual-web-result', '--parser-version', '1', '--idempotency-key', 'mention-ingest-1']).opportunity.id;
  runCli(store.home, ['opportunity', 'triage', '--opportunity-id', String(opportunityId), '--decision', 'shortlist', '--rationale', 'fits', '--score', '0.9', '--score-coverage', '0.9']);
  const applicationId = runCli(store.home, ['opportunity', 'promote', '--opportunity-id', String(opportunityId)]).application.id;
  const db = store.open();
  db.prepare("UPDATE applications SET workflow_stage='submitted' WHERE id=?").run(applicationId);
  return { store, db, applicationId };
}

test('a first-contact welcome correlates by the company and role named in its subject, as an ambiguous candidate', (t) => {
  const { db, applicationId } = droveApplicationWithoutDomain(t);
  try {
    const facts = welcomeFacts({
      company: undefined,
      source: { ...welcomeFacts().source, fromAddress: 'careers@mydrove.test', fromDomain: 'mydrove.test', messageId: 'mention-1', threadId: 'mention-1' },
      evidence: [{ field: 'from', excerpt: 'careers@mydrove.test' }, { field: 'subject', excerpt: 'We received your application: Platform Engineer at Drove [DRV-1]' }]
    });
    delete facts.company;
    const correlation = correlateEmailReadOnly(db, facts);
    assert.equal(correlation.resolution, 'ambiguous', JSON.stringify(correlation).slice(0, 400));
    const candidate = correlation.candidates.find((c) => c.applicationId === applicationId);
    assert.ok(candidate, 'the Drove application is a candidate');
    assert.equal(candidate.matchBasis, 'company_and_role');
    assert.equal(correlation.automaticEligible, false, 'a mention proposes, never links');
    assert.ok(correlation.evidence.some((e) => e.kind === 'subject_company_role'));

    // Company only in the subject → weaker basis; sender label only → fuzzy.
    const companyOnly = correlateEmailReadOnly(db, { ...facts, evidence: [{ field: 'subject', excerpt: 'Thanks for applying to Drove' }] });
    assert.equal(companyOnly.candidates.find((c) => c.applicationId === applicationId)?.matchBasis, 'company_only');
    const senderOnly = correlateEmailReadOnly(db, { ...facts, evidence: [{ field: 'subject', excerpt: 'Your application' }] });
    assert.equal(senderOnly.candidates.find((c) => c.applicationId === applicationId)?.matchBasis, 'fuzzy');
    // An unrelated sender and subject still resolve unmatched.
    const unrelated = correlateEmailReadOnly(db, {
      ...facts,
      source: { ...facts.source, fromAddress: 'noreply@newsletter.test', fromDomain: 'newsletter.test' },
      evidence: [{ field: 'subject', excerpt: 'Weekly digest' }]
    });
    assert.equal(unrelated.resolution, 'unmatched');
  } finally {
    db.close();
  }
});

test('mail recorded unmatched is re-correlated by the fabric once the record offers a candidate, then reaches the agent lane', (t) => {
  const { store, db, applicationId } = droveApplicationWithoutDomain(t);
  try {
    const facts = welcomeFacts({
      company: undefined,
      source: { ...welcomeFacts().source, fromAddress: 'talent@hr-portal.test', fromDomain: 'hr-portal.test', messageId: 'stale-1', threadId: 'stale-1' },
      evidence: [{ field: 'subject', excerpt: 'Thanks for applying' }]
    });
    delete facts.company;
    importFacts(db, facts, 'stale-import-1');
    const first = correlateEmailReadOnly(db, facts);
    assert.equal(first.resolution, 'unmatched');
    recordCorrelation(db, first, 'stale-record-1');
    assert.equal(listInboundQueue(db, { applicationId }).length, 0, 'an unmatched message is not in the inbox lane');
    assert.equal(listStaleUnmatched(db, { applicationId }).length, 0, 'nothing to re-correlate while the record offers no candidate');
    let items = deriveFabricNext(db).subjects.find((s) => s.subjectKind === 'application' && s.subjectId === applicationId).items;
    assert.ok(!items.some((i) => i.node === 'email.recorrelate' || i.node === 'email.review'));

    // The applicant's tracker learns the company's domain.
    const companyId = db.prepare("SELECT id FROM companies WHERE normalized_name='drove'").get().id;
    db.prepare('UPDATE companies SET website_domain=? WHERE id=?').run('hr-portal.test', companyId);
    const stale = listStaleUnmatched(db, { applicationId });
    assert.equal(stale.length, 1);
    assert.equal(stale[0].live.resolution, 'linked');
    items = deriveFabricNext(db).subjects.find((s) => s.subjectId === applicationId).items;
    const recorrelate = items.find((i) => i.node === 'email.recorrelate');
    assert.ok(recorrelate, 'the fabric derives a deterministic re-correlation');
    assert.equal(recorrelate.executor, 'deterministic');
    assert.match(recorrelate.reason, /recorded unmatched; the current record offers .*candidate\(s\).*company_single_open/u);
    assert.equal(recorrelate.idempotencyKey, `fabric-email.recorrelate-${stale[0].messageRefId}-c${stale[0].correlationId}`);

    const tick = runCli(store.home, ['fabric', 'tick']);
    assert.ok(tick.performed.some((p) => p.node === 'email.recorrelate'), JSON.stringify(tick).slice(0, 400));
    assert.equal(listStaleUnmatched(db, { applicationId }).length, 0, 're-correlated: nothing stale remains');
    const queue = listInboundQueue(db, { applicationId });
    assert.equal(queue.length, 1);
    assert.equal(queue[0].via, 'correlation');
    items = deriveFabricNext(db).subjects.find((s) => s.subjectId === applicationId).items;
    assert.ok(items.some((i) => i.node === 'email.review'), 'the message now reaches the agent lane');
    assert.ok(!items.some((i) => i.node === 'email.recorrelate'));
    assert.equal(listInboundQueue(db, { applicationId })[0].via, 'correlation');
  } finally {
    db.close();
  }
});

test('a retracted latest link becomes correction work without re-offering the retracted application', (t) => {
  const { store, db, applicationId, facts, messageRefId } = linkedWelcome(t);
  try {
    const correctedApplicationId = runCli(store.home, [
      'add-application', '--company', 'Drove', '--role', 'Security Engineer', '--status', 'applied'
    ]).application.id;
    recordHandlingDecision(db, {
      messageRefId, applicationId, decision: 'none', actor: 'fabric-worker', authorship: 'agent',
      reason: 'handled before review found the role was wrong', idempotencyKey: 'handled-before-link-correction'
    });
    assert.equal(listInboundQueue(db).length, 0);
    const retracted = emailLearning.retractLink(db, {
      messageRefId, actor: 'Cole', reason: 'the welcome was linked to the wrong Drove role'
    });
    assert.equal(retracted.linkRetractions, 1);
    assert.equal(listInboundQueue(db, { applicationId }).length, 0);
    assert.equal(listStaleUnmatched(db, { applicationId }).length, 0, 'the withdrawn target is not re-offered');
    assert.throws(() => resolveFromAgent(db, {
      messageRefId, applicationId, actor: 'fabric-worker', reason: 'must not revive the withdrawn pair',
      idempotencyKey: 'retracted-link-old-target'
    }), (error) => error.code === 'CORRELATION_RETRACTED');

    const stale = listStaleUnmatched(db, { applicationId: correctedApplicationId });
    assert.equal(stale.length, 1, 'the inactive latest link is explicit re-correlation work');
    assert.ok(stale[0].live.candidates.some((candidate) => candidate.applicationId === correctedApplicationId));
    assert.ok(!stale[0].live.candidates.some((candidate) => candidate.applicationId === applicationId));
    const globalStale = listStaleUnmatched(db);
    assert.equal(globalStale.length, 1,
      'a historical decision for retracted application A does not suppress correction work offered to B');
    assert.deepEqual(globalStale[0].live.candidates.map((candidate) => candidate.applicationId), [correctedApplicationId]);

    const refreshed = correlateEmailReadOnly(db, facts);
    assert.equal(refreshed.resolution, 'ambiguous');
    recordCorrelation(db, refreshed, 'retracted-link-recorrelation');
    assert.equal(listInboundQueue(db, { applicationId }).length, 0);
    const correctedQueue = listInboundQueue(db, { applicationId: correctedApplicationId });
    assert.equal(correctedQueue.length, 1);
    assert.deepEqual(correctedQueue[0].candidates.map((candidate) => candidate.applicationId), [correctedApplicationId]);
    const globalQueue = listInboundQueue(db);
    assert.equal(globalQueue.length, 1,
      'the fresh ambiguous correlation is globally reoffered for its only active candidate B');
    assert.deepEqual(globalQueue[0].candidates.map((candidate) => candidate.applicationId), [correctedApplicationId]);
  } finally {
    db.close();
  }
});

test('a decided interview invite with no sent reply is owed one: offered to the agent when this machine can send, blocked when it cannot', (t) => {
  const { db, applicationId } = linkedWelcome(t);
  t.after(() => setTransmitReadinessProbe(null));
  try {
    // A second message: the invite, relayed, linked to the same application, decided 'transition' — but never answered.
    const invite = welcomeFacts({
      eventKind: 'interview_invite', replyRequested: true,
      source: { ...welcomeFacts().source, messageId: 'arc-invite-1', threadId: 'arc-thread-2', receivedAt: '2026-09-02T04:20:00.000Z' },
      evidence: [{ field: 'subject', excerpt: 'Interview invitation — final round: Platform Engineer at Drove' }],
      interview: { intent: 'schedule', format: 'video' }
    });
    importFacts(db, invite, 'arc-import-invite');
    const correlation = correlateEmailReadOnly(db, invite);
    recordCorrelation(db, correlation, 'arc-record-invite');
    const queue = listInboundQueue(db, { applicationId });
    const entry = queue.find((row) => row.eventKind === 'interview_invite');
    assert.ok(entry, JSON.stringify(queue).slice(0, 300));
    if (correlation.resolution === 'ambiguous') {
      resolveFromAgent(db, { messageRefId: entry.messageRefId, applicationId, actor: 'fabric-worker', reason: 'same company, same role', idempotencyKey: 'arc-resolve-invite' });
    }
    assert.equal(listOutstandingReplies(db, { applicationId }).length, 0, 'undecided mail is the inbox lane\'s, not the reply lane\'s');
    recordHandlingDecision(db, {
      messageRefId: entry.messageRefId, applicationId, decision: 'transition', actor: 'fabric-worker', authorship: 'agent',
      reason: 'moved to interviewing; the reply could not be sent', idempotencyKey: `fabric-email-handled-${entry.messageRefId}`
    });
    assert.equal(listOutstandingReplies(db, { applicationId }).length, 0, 'a plain transition is the applicant\'s choice not to write — nothing owed yet');
    // The agent records that its reply attempt failed → the reply is owed.
    recordReplyAttempt(db, { messageRefId: entry.messageRefId, outcome: 'failed', actor: 'fabric-worker', reason: 'send refused: no mail authorization', idempotencyKey: 'attempt-0' });
    // Nine minutes later (past the retry window) the reply is owed again.
    db.prepare("UPDATE job_email_reply_attempts SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-9 minutes') WHERE idempotency_key='attempt-0'").run();
    const owed = listOutstandingReplies(db, { applicationId });
    assert.equal(owed.length, 1);
    assert.equal(owed[0].messageRefId, entry.messageRefId);
    assert.equal(owed[0].attempts, 1);
    assert.equal(owed[0].coolingDown, false);
    assert.equal(owed[0].source.replyToAddress, 'careers@mydrove.test');

    db.prepare("UPDATE applications SET workflow_stage='submitted' WHERE id=?").run(applicationId);
    setTransmitReadinessProbe(() => ({ ready: false, detail: 'no gog account for applicant@umich.test on this machine' }));
    let items = deriveFabricNext(db).subjects.find((s) => s.subjectId === applicationId).items;
    let reply = items.find((i) => i.node === 'email.reply');
    assert.ok(reply, 'the owed reply is derived');
    assert.equal(reply.status, 'blocked', 'without a send-capable token the item is surfaced, never staffed');
    assert.match(reply.reason, /no reply has been sent.*blocked: no gog account/u);
    assert.equal(reply.idempotencyKey, `fabric-email.reply-${entry.messageRefId}-a1`);
    assert.equal(reply.act.source.messageId, 'arc-invite-1');

    setTransmitReadinessProbe(() => ({ ready: true, detail: 'token ok' }));
    items = deriveFabricNext(db).subjects.find((s) => s.subjectId === applicationId).items;
    reply = items.find((i) => i.node === 'email.reply');
    assert.equal(reply.status, 'eligible');
    assert.equal(reply.executor, 'agent');
    assert.ok(reply.commands.some((c) => c.includes('prepare-reply-draft.cjs')));

    // The acknowledgement (message 1, decided 'none') owes nothing: "none" is the applicant's decision.
    assert.ok(!items.some((i) => i.node === 'email.reply' && i.act.messageRefId !== entry.messageRefId));

    // A failed attempt the agent records starts the retry window: the item is blocked, and the dispatch key advances.
    const attempt = recordReplyAttempt(db, { messageRefId: entry.messageRefId, outcome: 'failed', actor: 'fabric-worker', reason: 'IDEMPOTENCY_CONFLICT at draft synthesis', idempotencyKey: 'attempt-1' });
    assert.equal(attempt.reused, false);
    assert.equal(recordReplyAttempt(db, { messageRefId: entry.messageRefId, outcome: 'failed', actor: 'fabric-worker', reason: 'again', idempotencyKey: 'attempt-1' }).reused, true);
    const owedAgain = listOutstandingReplies(db, { applicationId });
    assert.equal(owedAgain.length, 1);
    assert.equal(owedAgain[0].attempts, 2);
    assert.equal(owedAgain[0].coolingDown, true);
    items = deriveFabricNext(db).subjects.find((s) => s.subjectId === applicationId).items;
    reply = items.find((i) => i.node === 'email.reply');
    assert.equal(reply.status, 'blocked');
    assert.match(reply.reason, /waiting out the retry window/u);
    assert.equal(reply.wakeAt, owedAgain[0].retryAt, 'the retry window end is the wake spine\'s due-at');
    assert.equal(deriveFabricNext(db).nextWakeAt, owedAgain[0].retryAt);
    assert.equal(reply.idempotencyKey, `fabric-email.reply-${entry.messageRefId}-a2`);
    // Past the window it is offered again.
    assert.equal(listOutstandingReplies(db, { applicationId, now: new Date(Date.now() + 46 * 60_000) })[0].coolingDown, false);
    assert.throws(() => recordReplyAttempt(db, { messageRefId: entry.messageRefId, outcome: 'sent', actor: 'x', reason: 'r', idempotencyKey: 'attempt-2' }), /outcome must be failed or skipped/u);

    // (pendingApproval — the approved draft an owed reply hands to the next attempt — is exercised live and by
    // the outgoing-v2 suites; its tables are trigger-guarded, so no hand-made rows here.)
    assert.equal(owedAgain[0].pendingApproval, null, 'no approved draft exists for a reply that never reached synthesis');
  } finally {
    db.close();
  }
});

test('mail imported but never correlated is re-correlated by the fabric instead of staying invisible', (t) => {
  const { store, db, applicationId } = droveApplicationWithoutDomain(t);
  try {
    const companyId = db.prepare("SELECT id FROM companies WHERE normalized_name='drove'").get().id;
    db.prepare('UPDATE companies SET website_domain=? WHERE id=?').run('mydrove.test', companyId);
    const facts = welcomeFacts({
      source: { ...welcomeFacts().source, messageId: 'orphan-1', threadId: 'orphan-1' },
      evidence: [{ field: 'subject', excerpt: 'Welcome Chat' }]
    });
    delete facts.company;
    // The relay imported the message, then its record step never landed (a
    // stale correlation terminalized the delivery). Nothing references it yet.
    importFacts(db, facts, 'orphan-import-1');
    assert.equal(db.prepare('SELECT count(*) AS n FROM job_email_correlations').get().n, 0);
    assert.equal(listInboundQueue(db, { applicationId }).length, 0, 'an uncorrelated message is not in the inbox lane');

    const stale = listStaleUnmatched(db, { applicationId });
    assert.equal(stale.length, 1, 'the lane offers the never-correlated message');
    assert.equal(stale[0].correlationId, null);
    assert.equal(stale[0].live.resolution, 'linked');
    const items = deriveFabricNext(db).subjects.find((s) => s.subjectId === applicationId).items;
    const recorrelate = items.find((i) => i.node === 'email.recorrelate');
    assert.ok(recorrelate, 'the fabric derives a deterministic re-correlation');
    assert.match(recorrelate.reason, /was imported but never correlated; the current record offers .*company_single_open/u);
    assert.equal(recorrelate.idempotencyKey, `fabric-email.recorrelate-${stale[0].messageRefId}-c0`);

    const tick = runCli(store.home, ['fabric', 'tick']);
    assert.ok(tick.performed.some((p) => p.node === 'email.recorrelate'), JSON.stringify(tick).slice(0, 400));
    assert.equal(db.prepare('SELECT count(*) AS n FROM job_email_correlations').get().n, 1);
    assert.equal(listStaleUnmatched(db, { applicationId }).length, 0, 'correlated: nothing stale remains');
    const queue = listInboundQueue(db, { applicationId });
    assert.equal(queue.length, 1);
    assert.equal(queue[0].via, 'correlation');
    assert.ok(deriveFabricNext(db).subjects.find((s) => s.subjectId === applicationId).items.some((i) => i.node === 'email.review'));
  } finally {
    db.close();
  }
});

test('an ambiguous first-contact message becomes clarifiable once the record identifies its sender, via re-correlation', (t) => {
  const { store, db, applicationId } = droveApplicationWithoutDomain(t, { role: 'Backend Engineer' });
  try {
    const second = promoteManagedApplication(store, { role: 'Product Engineer', suffix: 'product', observedAt: '2026-09-02T02:30:00Z' });
    db.prepare("UPDATE applications SET workflow_stage='submitted' WHERE id=?").run(second);
    // A role-omitted first contact from a sender nobody has heard from: the
    // company is only in the mail domain, which the fresh record cannot bind.
    const facts = welcomeFacts({
      source: { ...welcomeFacts().source, messageId: 'first-contact-1', threadId: 'first-contact-1' },
      company: { domain: 'mydrove.test' },
      replyRequested: true,
      evidence: [{ field: 'subject', excerpt: 'Quick question' }, { field: 'body', excerpt: 'Hi Cole,' }]
    });
    importFacts(db, facts, 'first-contact-import-1');
    const first = correlateEmailReadOnly(db, facts);
    assert.equal(first.resolution, 'ambiguous');
    assert.equal(first.identity.basis, 'none');
    assert.equal(first.clarifiable, false, 'an unidentified sender cannot be asked which role');
    assert.deepEqual([...new Set(first.candidates.map((c) => c.matchBasis))], ['fuzzy']);
    recordCorrelation(db, first, 'first-contact-record-1');
    assert.equal(listStaleUnmatched(db, { applicationId }).length, 0, 'an unchanged ambiguous record is not re-correlated');
    let items = deriveFabricNext(db).subjects.find((s) => s.subjectId === applicationId).items;
    assert.ok(!items.some((i) => i.node === 'email.recorrelate'));

    // The record grows: the sender's domain becomes a known employer domain.
    const companyId = db.prepare("SELECT id FROM companies WHERE normalized_name='drove'").get().id;
    db.prepare('UPDATE companies SET website_domain=? WHERE id=?').run('mydrove.test', companyId);
    const stale = listStaleUnmatched(db, { applicationId });
    assert.equal(stale.length, 1);
    assert.equal(stale[0].recorded, 'ambiguous');
    assert.equal(stale[0].live.resolution, 'ambiguous');
    items = deriveFabricNext(db).subjects.find((s) => s.subjectId === applicationId).items;
    const recorrelate = items.find((i) => i.node === 'email.recorrelate');
    assert.ok(recorrelate, 'the fabric re-correlates the grown record');
    assert.match(recorrelate.reason, /was recorded ambiguous before the record grew/u);

    const tick = runCli(store.home, ['fabric', 'tick']);
    assert.ok(tick.performed.some((p) => p.node === 'email.recorrelate'), JSON.stringify(tick).slice(0, 400));
    assert.equal(listStaleUnmatched(db, { applicationId }).length, 0, 'the fresh record is not stale');
    const queue = listInboundQueue(db, { applicationId });
    assert.equal(queue.length, 1);
    assert.equal(queue[0].via, 'ambiguous');
    assert.equal(queue[0].clarifiable, true, 'the identified sender can now be asked which role');
    assert.deepEqual(queue[0].candidates.map((c) => c.applicationId).sort(), [applicationId, second].sort());
    items = deriveFabricNext(db).subjects.find((s) => s.subjectId === applicationId).items;
    const review = items.find((i) => i.node === 'email.review');
    assert.ok(review && review.commands.some((c) => c.includes('email clarify')), 'the review item now offers the clarification');
  } finally {
    db.close();
  }
});

test('a none judged before the record could ask is provisional: re-correlation reopens the pair with fresh work', (t) => {
  const { store, db, applicationId } = droveApplicationWithoutDomain(t, { role: 'Backend Engineer' });
  try {
    const second = promoteManagedApplication(store, { role: 'Product Engineer', suffix: 'product-2', observedAt: '2026-09-02T02:30:00Z' });
    db.prepare("UPDATE applications SET workflow_stage='submitted' WHERE id=?").run(second);
    const facts = welcomeFacts({
      source: { ...welcomeFacts().source, messageId: 'first-contact-2', threadId: 'first-contact-2' },
      company: { domain: 'mydrove.test' },
      replyRequested: true,
      evidence: [{ field: 'subject', excerpt: 'Quick question' }, { field: 'body', excerpt: 'Hi Cole,' }]
    });
    importFacts(db, facts, 'first-contact-import-2');
    const first = correlateEmailReadOnly(db, facts);
    assert.equal(first.clarifiable, false);
    const recorded = recordCorrelation(db, first, 'first-contact-record-2');
    const messageRefId = listInboundQueue(db, { applicationId })[0].messageRefId;
    // The agent could not ask, so it judged `none` for both candidates.
    for (const id of [applicationId, second]) {
      recordHandlingDecision(db, {
        messageRefId, applicationId: id, decision: 'none', actor: 'fabric-worker', authorship: 'agent',
        reason: 'names no role and the correlation is non-clarifiable', idempotencyKey: `fabric-email-handled-${messageRefId}-a${id}-c${recorded.correlationId}`
      });
    }
    assert.equal(listInboundQueue(db, { applicationId }).length, 0, 'judged against the newest record, the pair is retired');
    assert.throws(() => recordHandlingDecision(db, {
      messageRefId, applicationId, decision: 'none', actor: 'fabric-worker', authorship: 'agent',
      reason: 'again', idempotencyKey: `fabric-email-handled-${messageRefId}-a${applicationId}-again`
    }), (error) => error.code === 'ALREADY_HANDLED');

    // The record grows and the message is re-correlated (now clarifiable).
    const companyId = db.prepare("SELECT id FROM companies WHERE normalized_name='drove'").get().id;
    db.prepare('UPDATE companies SET website_domain=? WHERE id=?').run('mydrove.test', companyId);
    assert.equal(listStaleUnmatched(db, { applicationId }).length, 1, 'a none judgment does not pin an ambiguous record');
    // SQLite's datetime('now') is whole-second: make the fresh correlation strictly newer than the judgments.
    db.prepare("UPDATE job_email_handling_decisions SET created_at=datetime(created_at, '-2 seconds') WHERE message_ref_id=?").run(messageRefId);
    const tick = runCli(store.home, ['fabric', 'tick']);
    assert.ok(tick.performed.some((p) => p.node === 'email.recorrelate'), JSON.stringify(tick).slice(0, 300));
    const reopened = listInboundQueue(db, { applicationId });
    assert.equal(reopened.length, 1, 'the provisional none is superseded by the newer, clarifiable record');
    assert.equal(reopened[0].clarifiable, true);
    assert.notEqual(reopened[0].correlationId, recorded.correlationId);
    const items = deriveFabricNext(db).subjects.find((s) => s.subjectId === applicationId).items;
    const review = items.find((i) => i.node === 'email.review');
    assert.ok(review, 'fresh review work is derived');
    assert.equal(review.idempotencyKey, `fabric-email.review-${messageRefId}-a${applicationId}-c${reopened[0].correlationId}-v1`);
    assert.ok(review.commands.some((c) => c.includes('email clarify')));
    // A new decision for the pair is accepted now; the old provisional one is history.
    const again = recordHandlingDecision(db, {
      messageRefId, applicationId, decision: 'none', actor: 'fabric-worker', authorship: 'agent',
      reason: 'judged again under the grown record', idempotencyKey: `fabric-email-handled-${messageRefId}-a${applicationId}-c${reopened[0].correlationId}`
    });
    assert.equal(again.reused, false);
    assert.equal(listInboundQueue(db, { applicationId }).length, 0);
  } finally {
    db.close();
  }
});
