'use strict';
// R1 of docs/DESIGN-EMAIL-CORRELATION.md: the sender identity registry and the
// learning that feeds it. Acceptance: the arc-4 store replayed — every message
// identifies Drove by contact after the first confirmed link.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createTestStore } = require('../test-support/migrated-store');

const { correlateEmailReadOnly, importFacts, recordCorrelation, resolveCorrelation, runEmailCommand } = require('../lib/email-integration');
const registry = require('../lib/email-correlation/registry');
const learning = require('../lib/email-correlation/learn');
const { classifySenderDomain, RULE_SET } = require('../lib/email-correlation/domain-classes');
const { prioritizeRoleTitleMatchEvidence } = require('../lib/email-correlation/signals');
const { buildTransitionProposal, listInboundQueue } = require('../lib/email-agent-lane');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');
const ARC4 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'email-correlation', 'arc4-facts.json'), 'utf8'));

function runCli(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], { env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8' }));
}

function createStore(t, { cold = false } = {}) {
  const copied = cold ? null : createTestStore('jobtrack-registry-');
  const rootDir = copied?.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-registry-'));
  const home = copied?.home ?? path.join(rootDir, 'store');
  if (cold) runCli(home, ['init']);
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return {
    home,
    open() {
      const db = new Database(path.join(home, 'jobtrack.db'));
      db.pragma('foreign_keys = ON');
      return db;
    }
  };
}

function addApplication(home, company, role) {
  return runCli(home, ['add-application', '--company', company, '--role', role, '--status', 'applied']).application.id;
}

/** Import one facts document and record its read-only correlation; returns { messageRefId, correlation }. */
function importAndCorrelate(db, facts, key) {
  importFacts(db, facts, `${key}-import`);
  const correlation = correlateEmailReadOnly(db, facts);
  recordCorrelation(db, correlation, `${key}-record`);
  const message = db.prepare('SELECT id FROM job_email_message_refs WHERE message_id=?').get(facts.source.messageId);
  return { messageRefId: message.id, correlation };
}

test('causal role-title evidence survives correlation and operator evidence caps', () => {
  const ordinary = Array.from({ length: 30 }, (_, index) => ({
    kind: 'ordinary', value: `evidence-${index}`
  }));
  const selected = { kind: 'role_title_match', value: 'application:7:posting-ref:2' };
  const correlationEvidence = prioritizeRoleTitleMatchEvidence([...ordinary, selected]).slice(0, 30);
  assert.equal(correlationEvidence[0], selected,
    'causal evidence is retained before the public 30-entry cap');
  assert.equal(correlationEvidence.length, 30);

  const otherCausal = Array.from({ length: 30 }, (_, index) => ({
    kind: 'role_title_match', value: `application:${index + 20}:posting-ref:0`
  }));
  const exactEvidence = prioritizeRoleTitleMatchEvidence([...otherCausal, selected], 7).slice(0, 30);
  assert.equal(exactEvidence[0], selected,
    'an exact winner is retained even beyond thirty other causal candidates');

  const operatorEvidence = { kind: 'operator_resolution', value: 'selected application 7' };
  const promoted = [
    ...prioritizeRoleTitleMatchEvidence([...ordinary.slice(0, 29), selected], 7).slice(0, 29),
    operatorEvidence
  ];
  assert.equal(promoted[0], selected,
    'the selected application causal token cannot be the entry evicted for operator evidence');
  assert.equal(promoted.at(-1), operatorEvidence);
  assert.equal(promoted.length, 30);
});

test('the registry migration is idempotent and seeds the shared domain classes once', (t) => {
  // Preserve the cold migration and its subsequent idempotent replay.
  const fixture = createStore(t, { cold: true });
  const db = fixture.open();
  try {
    assert.equal(db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?').get(registry.REGISTRY_SCHEMA_VERSION).name, registry.REGISTRY_MIGRATION_NAME);
    const seeded = db.prepare('SELECT count(*) AS n FROM email_domain_classes').get().n;
    assert.equal(seeded, RULE_SET.ats.length + RULE_SET.consumer.length);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name LIKE 'active_job_email_%' ORDER BY name").all().map((row) => row.name), [
      'active_job_email_application_links',
      'active_job_email_linked_correlations'
    ]);
    registry.migrateEmailCorrelationRegistry(db);
    assert.equal(db.prepare('SELECT count(*) AS n FROM email_domain_classes').get().n, seeded, 'seeding twice adds nothing');
    // An operator row wins over the rule set, and parents classify subdomains.
    db.prepare("INSERT INTO email_domain_classes(domain, class, source) VALUES ('staffing-partner.test', 'ats', 'operator')").run();
    assert.equal(classifySenderDomain(db, 'mail.staffing-partner.test'), 'ats');
    assert.equal(classifySenderDomain(db, 'boards.greenhouse.io'), 'ats');
    assert.equal(classifySenderDomain(db, 'someone@gmail.com'.split('@')[1]), 'consumer');
    assert.equal(classifySenderDomain(db, 'acme-robotics.com'), 'corporate');
    assert.equal(classifySenderDomain(db, ''), 'unknown');
  } finally {
    db.close();
  }
});

test('arc 4 replay: the first link teaches the contact and domain, and every later message identifies Drove by contact', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Drove', 'Staff Software Engineer');
  const db = fixture.open();
  try {
    const [welcome, invite, confirmation, followUp, offer] = ARC4.map((entry) => entry.facts);

    // Before any link the registry knows nothing: the welcome correlates only
    // on the subject (company name + title), as it did live.
    const first = importAndCorrelate(db, welcome, 'arc4-1');
    assert.equal(first.correlation.resolution, 'ambiguous');
    assert.deepEqual(first.correlation.candidates.map((c) => c.matchBasis), ['company_and_role']);
    assert.deepEqual(registry.identifySender(db, welcome).basis, 'none');

    // The applicant's agent links it. That confirmed link teaches.
    const resolved = resolveCorrelation(db, {
      source: welcome.source, factsDigest: first.correlation.factsDigest,
      applicationId, actor: 'fabric-worker', reason: 'the welcome for this application'
    }, 'arc4-1-resolve');
    assert.equal(resolved.learning.contact, 'learned');
    assert.equal(resolved.learning.domain, 'learned', 'mydrove.com is an employer domain');
    assert.equal(resolved.learning.titleAliases, 0, 'the live facts carried no role-title mentions');
    assert.equal(db.prepare("SELECT count(*) AS n FROM company_contacts WHERE email='careers@mydrove.com'").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM company_aliases WHERE alias_kind='domain' AND normalized_alias='mydrove.com'").get().n, 1);
    assert.equal(registry.listLearnings(db, { messageRefId: first.messageRefId }).length, 2);

    // Every later message is identified by the contact. Since Drove has exactly
    // one open application and these are lifecycle messages, policy links them
    // for review on company_single_open while retaining the causal strong bases.
    const identity = registry.identifySender(db, invite);
    assert.equal(identity.basis, 'contact');
    assert.equal(identity.domainClass, 'corporate');
    for (const [index, facts] of [invite, confirmation, followUp, offer].entries()) {
      const { correlation } = importAndCorrelate(db, facts, `arc4-${index + 2}`);
      const bases = new Set(correlation.candidates.map((c) => c.matchBasis));
      assert.ok(bases.has('sender_contact'), `message ${index + 2} carries sender_contact (got ${[...bases].join(',')})`);
      assert.ok(bases.has('company_domain'), `message ${index + 2} also matches the learned domain`);
      assert.equal(correlation.resolution, 'linked');
      assert.equal(correlation.resolved.matchBasis, 'company_single_open');
      assert.equal(correlation.automaticEligible, false, 'single-open links always stay in the agent review path');
      assert.ok(correlation.candidates.every((c) => c.applicationId === applicationId));
    }
    // Learning is idempotent: re-learning the same message changes nothing.
    const again = learning.confirmLink(db, { messageRefId: first.messageRefId, applicationId, actor: 'test' });
    assert.equal(again.contact, 'known');
    assert.equal(again.domain, 'known');
  } finally {
    db.close();
  }
});

test('a message with a role-title mention teaches a title alias, and a second application at the same company is separated by it', (t) => {
  const fixture = createStore(t);
  const platform = addApplication(fixture.home, 'Acme Robotics', 'Platform Engineer');
  const sre = addApplication(fixture.home, 'Acme Robotics', 'Site Reliability Engineer');
  const db = fixture.open();
  try {
    const base = ARC4[0].facts;
    const welcomeChat = {
      ...base,
      source: { ...base.source, messageId: 'welcome-chat-1', threadId: 'welcome-chat-1', fromAddress: 'priya@acme-robotics.com', fromDomain: 'acme-robotics.com', fromDisplayName: 'Priya Natarajan' },
      eventKind: 'recruiter_followup',
      company: { name: 'Acme Robotics', domain: 'acme-robotics.com' },
      postingRefs: [{ roleTitle: 'the platform role' }],
      evidence: [
        { field: 'subject', excerpt: 'Welcome Chat' },
        { field: 'body', excerpt: 'Hi Cole, this is about the platform role.' }
      ]
    };
    const first = importAndCorrelate(db, welcomeChat, 'chat-1');
    // Company known by name mention → both applications proposed; the grounded
    // loose wording matches only the platform opening.
    assert.equal(first.correlation.resolution, 'ambiguous');
    assert.ok(first.correlation.candidates.some((candidate) =>
      candidate.applicationId === platform && candidate.matchBasis === 'body_role_title'));
    assert.equal(first.correlation.candidates.some((candidate) =>
      candidate.applicationId === sre && candidate.matchBasis === 'body_role_title'), false);
    assert.equal(new Set(first.correlation.candidates.map((c) => c.applicationId)).size, 2);
    resolveCorrelation(db, { source: welcomeChat.source, factsDigest: first.correlation.factsDigest, applicationId: platform, actor: 'fabric-worker', reason: 'the body names the platform role' }, 'chat-1-resolve');
    assert.equal(db.prepare('SELECT count(*) AS n FROM application_title_aliases WHERE application_id=?').get(platform).n, 1, 'the company wording is now an alias of the platform application');

    // The next message from the same sender with the same wording: the contact
    // identifies the company, and the alias upgrades the platform candidate to
    // company_and_role while the SRE application stays a plain sender_contact.
    const next = { ...welcomeChat, source: { ...welcomeChat.source, messageId: 'welcome-chat-2', threadId: 'welcome-chat-2' } };
    const second = importAndCorrelate(db, next, 'chat-2');
    // Candidates are ordered by basis priority; the first per application is its strongest.
    const byApp = new Map();
    for (const candidate of second.correlation.candidates) if (!byApp.has(candidate.applicationId)) byApp.set(candidate.applicationId, candidate.matchBasis);
    assert.equal(byApp.get(platform), 'body_role_title');
    assert.equal(byApp.get(sre), 'sender_contact');
    assert.equal(second.correlation.candidates[0].applicationId, platform, 'the role-bearing candidate ranks first');
  } finally {
    db.close();
  }
});

test('a confirmed link learns only the role mention causally matched to the selected application', (t) => {
  const fixture = createStore(t);
  const platform = addApplication(fixture.home, 'Acme Robotics', 'Platform Engineer');
  const sre = addApplication(fixture.home, 'Acme Robotics', 'Site Reliability Engineer');
  const db = fixture.open();
  try {
    const base = ARC4[0].facts;
    const facts = {
      ...base,
      source: {
        ...base.source,
        messageId: 'two-role-mentions-one-selection',
        threadId: 'two-role-mentions-one-selection',
        fromAddress: 'priya@acme-robotics.com',
        fromDomain: 'acme-robotics.com',
        fromDisplayName: 'Priya Natarajan'
      },
      eventKind: 'recruiter_followup',
      company: { name: 'Acme Robotics', domain: 'acme-robotics.com' },
      postingRefs: [
        { roleTitle: 'the platform role' },
        { roleTitle: 'the reliability role' }
      ],
      evidence: [
        { field: 'subject', excerpt: 'Quick question' },
        { field: 'body', excerpt: 'Is this about the platform role or the reliability role?' }
      ]
    };
    const imported = importAndCorrelate(db, facts, 'two-role-mentions');
    assert.equal(imported.correlation.resolution, 'ambiguous');
    assert.ok(imported.correlation.candidates.some((candidate) =>
      candidate.applicationId === platform && candidate.matchBasis === 'body_role_title'));
    assert.ok(imported.correlation.candidates.some((candidate) =>
      candidate.applicationId === sre && candidate.matchBasis === 'body_role_title'));
    assert.ok(imported.correlation.evidence.some((entry) =>
      entry.kind === 'role_title_match' && entry.value === `application:${platform}:posting-ref:0`));
    assert.ok(imported.correlation.evidence.some((entry) =>
      entry.kind === 'role_title_match' && entry.value === `application:${sre}:posting-ref:1`));

    const resolved = resolveCorrelation(db, {
      source: facts.source,
      factsDigest: imported.correlation.factsDigest,
      applicationId: platform,
      actor: 'fabric-worker',
      reason: 'the applicant confirmed the platform application'
    }, 'two-role-mentions:resolve');
    assert.equal(resolved.learning.titleAliases, 1);
    assert.deepEqual(db.prepare(`
      SELECT application_id,value,normalized_value FROM email_identity_learnings
      WHERE source_message_ref_id=? AND kind='title_alias' AND retracted_at IS NULL
      ORDER BY id
    `).all(imported.messageRefId), [{
      application_id: platform,
      value: 'the platform role',
      normalized_value: 'the platform role'
    }]);
    assert.equal(db.prepare(`
      SELECT count(*) AS n FROM application_title_aliases
      WHERE application_id=? AND normalized_alias='the reliability role'
    `).get(platform).n, 0, 'the other application\'s wording cannot poison the selected application');
    assert.equal(db.prepare('SELECT count(*) AS n FROM application_title_aliases WHERE application_id=?').get(sre).n, 0,
      'an unselected application receives no learning');
  } finally {
    db.close();
  }
});

test('a subject-only company_and_role candidate cannot teach a title alias', (t) => {
  const fixture = createStore(t);
  const platform = addApplication(fixture.home, 'Acme Robotics', 'Platform Engineer');
  addApplication(fixture.home, 'Acme Robotics', 'Site Reliability Engineer');
  const db = fixture.open();
  try {
    const base = ARC4[0].facts;
    const facts = {
      ...base,
      source: {
        ...base.source,
        messageId: 'subject-role-is-not-learning-evidence',
        threadId: 'subject-role-is-not-learning-evidence',
        fromAddress: 'priya@acme-robotics.com',
        fromDomain: 'acme-robotics.com'
      },
      eventKind: 'recruiter_followup',
      company: { name: 'Acme Robotics', domain: 'acme-robotics.com' },
      postingRefs: [{ roleTitle: 'Platform Engineer' }],
      evidence: [{ field: 'subject', excerpt: 'Acme Robotics Platform Engineer update' }]
    };
    const imported = importAndCorrelate(db, facts, 'subject-role-is-not-learning-evidence');
    assert.ok(imported.correlation.candidates.some((candidate) =>
      candidate.applicationId === platform && candidate.matchBasis === 'company_and_role'));
    assert.equal(imported.correlation.candidates.some((candidate) =>
      candidate.matchBasis === 'body_role_title'), false);
    const resolved = resolveCorrelation(db, {
      source: facts.source,
      factsDigest: imported.correlation.factsDigest,
      applicationId: platform,
      actor: 'fabric-worker',
      reason: 'operator selected the platform application from subject context'
    }, 'subject-role-is-not-learning-evidence:resolve');
    assert.equal(resolved.learning.titleAliases, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM email_identity_learnings WHERE kind='title_alias'").get().n, 0);
  } finally {
    db.close();
  }
});

test('an operator-confirmed correlation seeds the exact thread basis until its link is retracted', (t) => {
  const fixture = createStore(t);
  const platform = addApplication(fixture.home, 'Acme Robotics', 'Platform Engineer');
  addApplication(fixture.home, 'Acme Robotics', 'Site Reliability Engineer');
  const db = fixture.open();
  try {
    const base = ARC4[0].facts;
    const initial = {
      ...base,
      source: {
        ...base.source,
        messageId: 'operator-thread-initial',
        threadId: 'operator-thread',
        fromAddress: 'priya@acme-robotics.com',
        fromDomain: 'acme-robotics.com',
        fromDisplayName: 'Priya Natarajan'
      },
      eventKind: 'recruiter_followup',
      company: { name: 'Acme Robotics', domain: 'acme-robotics.com' },
      postingRefs: [],
      evidence: [{ field: 'subject', excerpt: 'Welcome Chat' }]
    };
    const imported = importAndCorrelate(db, initial, 'operator-thread-initial');
    assert.equal(imported.correlation.resolution, 'ambiguous');
    resolveCorrelation(db, {
      source: initial.source,
      factsDigest: imported.correlation.factsDigest,
      applicationId: platform,
      actor: 'fabric-worker',
      reason: 'the applicant selected the platform application'
    }, 'operator-thread-initial:resolve');
    assert.equal(db.prepare('SELECT count(*) AS n FROM job_email_application_links WHERE message_ref_id=?').get(imported.messageRefId).n, 0,
      'operator resolution itself does not need a transition link row');

    const { company: _company, ...initialWithoutCompany } = initial;
    const followUp = {
      ...initialWithoutCompany,
      source: {
        ...initial.source,
        messageId: 'operator-thread-follow-up',
        contentDigest: 'e'.repeat(64)
      },
      postingRefs: [],
      evidence: [{ field: 'subject', excerpt: 'One more thing' }]
    };
    const correlated = correlateEmailReadOnly(db, followUp);
    assert.equal(correlated.resolution, 'linked');
    assert.equal(correlated.resolved.applicationId, platform);
    assert.equal(correlated.resolved.matchBasis, 'previously_linked_thread');

    learning.retractLink(db, {
      messageRefId: imported.messageRefId,
      actor: 'operator',
      reason: 'the operator selected the wrong application'
    });
    const afterRetraction = correlateEmailReadOnly(db, followUp);
    assert.equal(afterRetraction.candidates.some((candidate) =>
      candidate.matchBasis === 'previously_linked_thread'), false,
    'retraction removes correlation-backed exact thread evidence');
  } finally {
    db.close();
  }
});

test('an unreviewed single-open correlation never seeds exact thread evidence', (t) => {
  const fixture = createStore(t);
  addApplication(fixture.home, 'Acme Robotics', 'Platform Engineer');
  const db = fixture.open();
  try {
    const base = ARC4[0].facts;
    const initial = {
      ...base,
      source: {
        ...base.source,
        messageId: 'single-open-thread-initial',
        threadId: 'single-open-thread',
        fromAddress: 'priya@acme-robotics.com',
        fromDomain: 'acme-robotics.com'
      },
      eventKind: 'recruiter_followup',
      company: { name: 'Acme Robotics', domain: 'acme-robotics.com' },
      postingRefs: [],
      evidence: [{ field: 'subject', excerpt: 'Welcome Chat' }]
    };
    const imported = importAndCorrelate(db, initial, 'single-open-thread-initial');
    assert.equal(imported.correlation.resolution, 'linked');
    assert.equal(imported.correlation.resolved.matchBasis, 'company_single_open');
    assert.equal(imported.correlation.automaticEligible, false);

    const { company: _company, ...initialWithoutCompany } = initial;
    const followUp = {
      ...initialWithoutCompany,
      source: {
        ...initial.source,
        messageId: 'single-open-thread-follow-up',
        contentDigest: 'f'.repeat(64)
      },
      evidence: [{ field: 'subject', excerpt: 'One more thing' }]
    };
    const correlated = correlateEmailReadOnly(db, followUp);
    assert.equal(correlated.candidates.some((candidate) =>
      candidate.matchBasis === 'previously_linked_thread'), false);
  } finally {
    db.close();
  }
});

test('a retracted link removes exactly what it taught, and a consumer-domain sender never teaches a domain', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Globex', 'Data Engineer');
  const db = fixture.open();
  try {
    const base = ARC4[0].facts;
    const fromGmail = {
      ...base,
      source: { ...base.source, messageId: 'gmail-1', threadId: 'gmail-1', fromAddress: 'recruiter.sam@gmail.com', fromDomain: 'gmail.com', fromDisplayName: 'Sam (Globex Talent)' },
      company: { name: 'Globex' },
      postingRefs: [{ roleTitle: 'Data Engineer' }],
      evidence: [
        { field: 'subject', excerpt: 'Quick chat about Globex' },
        { field: 'body', excerpt: 'This is about the Data Engineer role.' }
      ]
    };
    const first = importAndCorrelate(db, fromGmail, 'gmail-1');
    assert.equal(first.correlation.resolution, 'linked');
    assert.equal(first.correlation.resolved.matchBasis, 'company_single_open');
    assert.equal(first.correlation.automaticEligible, false);
    // A company_single_open result is only a review recommendation. The
    // explicit confirmation below is what makes its identity evidence safe to
    // learn, rather than merely recording the unconfirmed correlation.
    learning.confirmLink(db, {
      messageRefId: first.messageRefId,
      applicationId,
      actor: 'fabric-worker'
    });
    assert.equal(db.prepare("SELECT count(*) AS n FROM email_identity_learnings WHERE source_message_ref_id=? AND kind='contact'").get(first.messageRefId).n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM email_identity_learnings WHERE source_message_ref_id=? AND kind='domain'").get(first.messageRefId).n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM company_aliases WHERE alias_kind='domain' AND normalized_alias='gmail.com'").get().n, 0);
    assert.equal(registry.identifySender(db, fromGmail).basis, 'contact');
    db.prepare("INSERT INTO job_email_application_links(message_ref_id,application_id,relation) VALUES (?,?,'reviewed')")
      .run(first.messageRefId, applicationId);
    assert.ok(correlateEmailReadOnly(db, fromGmail).candidates.some((candidate) => candidate.matchBasis === 'previously_linked_message'));
    assert.ok(listInboundQueue(db, { applicationId }).some((item) => item.messageRefId === first.messageRefId));

    // Retract: the contact and the title alias go; the audit rows stay.
    const retracted = runEmailCommand(db, ['retract-learning'], {
      messageRefId: String(first.messageRefId), actor: 'operator', reason: 'wrong application'
    });
    assert.equal(retracted.contacts, 1);
    assert.equal(retracted.titleAliases, 1);
    assert.equal(retracted.retracted, 2);
    assert.equal(retracted.linkRetractions, 1);
    assert.equal(registry.identifySender(db, fromGmail).basis, 'mention', 'only the name mention remains');
    assert.equal(db.prepare('SELECT count(*) AS n FROM email_identity_learnings WHERE retracted_at IS NOT NULL').get().n, 2);
    assert.equal(db.prepare('SELECT reason FROM email_link_retractions WHERE message_ref_id=?').get(first.messageRefId).reason, 'wrong application');
    assert.equal(listInboundQueue(db, { applicationId }).some((item) => item.messageRefId === first.messageRefId), false,
      'a retracted pair leaves the agent queue');
    const afterRetraction = correlateEmailReadOnly(db, fromGmail);
    assert.equal(afterRetraction.candidates.some((candidate) => ['previously_linked_message', 'previously_linked_thread'].includes(candidate.matchBasis)), false,
      'append-only source links stop acting as exact evidence after retraction');
    assert.throws(
      () => learning.confirmLink(db, { messageRefId: first.messageRefId, applicationId, actor: 'fabric-worker' }),
      (error) => error.code === 'LINK_RETRACTED'
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM email_identity_learnings WHERE retracted_at IS NULL').get().n, 0,
      'a stale confirmation cannot revive retracted registry projections');
    assert.throws(() => buildTransitionProposal(db, {
      messageRefId: first.messageRefId,
      action: { kind: 'link_message' },
      evidence: ['stale link must not transition']
    }), /no recorded correlation/);
    // Retracting again is a no-op.
    assert.equal(runEmailCommand(db, ['retract-learning'], { messageRefId: String(first.messageRefId) }).retracted, 0);

    // The identity verb answers from the registry.
    const identity = runEmailCommand(db, ['identity'], { address: 'recruiter.sam@gmail.com' });
    assert.equal(identity.basis, 'none');
    assert.equal(identity.domainClass, 'consumer');
  } finally {
    db.close();
  }
});

test('one retraction deactivates every historical resolved application for the message', (t) => {
  const fixture = createStore(t);
  const firstApplicationId = addApplication(fixture.home, 'Contoso', 'Platform Engineer');
  const secondApplicationId = addApplication(fixture.home, 'Contoso', 'Data Engineer');
  const db = fixture.open();
  try {
    const base = ARC4[0].facts;
    const facts = {
      ...base,
      source: {
        ...base.source,
        messageId: 'multi-resolution', threadId: 'multi-resolution',
        fromAddress: 'recruiter@gmail.com', fromDomain: 'gmail.com'
      },
      company: { name: 'Contoso' },
      postingRefs: [],
      applicationRefs: []
    };
    const imported = importAndCorrelate(db, facts, 'multi-resolution');
    assert.equal(imported.correlation.resolution, 'ambiguous');
    resolveCorrelation(db, {
      source: facts.source,
      factsDigest: imported.correlation.factsDigest,
      applicationId: firstApplicationId,
      actor: 'operator',
      reason: 'historical resolution first'
    }, 'multi-resolution-first');
    // Simulate an older store that accumulated a later operator correction
    // before correlation-backed thread identity existed. New calls cannot
    // silently supersede the now-exact current-message basis, but reads must
    // still treat only the newest historical decision as authoritative.
    const firstResolved = JSON.parse(db.prepare(`
      SELECT correlation_json FROM job_email_correlations
      WHERE message_ref_id=? AND resolution='linked' ORDER BY id DESC LIMIT 1
    `).get(imported.messageRefId).correlation_json);
    const secondCandidate = imported.correlation.candidates.find((candidate) =>
      candidate.applicationId === secondApplicationId);
    const secondResolved = {
      ...firstResolved,
      resolved: secondCandidate,
      evidence: [
        ...firstResolved.evidence.filter((entry) => entry.kind !== 'operator_resolution'),
        { kind: 'operator_resolution', value: 'historical operator correction to the second application' }
      ]
    };
    db.prepare(`
      INSERT INTO job_email_correlations(
        message_ref_id,facts_digest,resolution,resolved_application_id,correlation_json,correlation_digest
      ) VALUES (?,?,'linked',?,?,?)
    `).run(
      imported.messageRefId,
      imported.correlation.factsDigest,
      secondApplicationId,
      JSON.stringify(secondResolved),
      'c'.repeat(64)
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM job_email_correlations WHERE message_ref_id=? AND resolution='linked'").get(imported.messageRefId).n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM job_email_application_links WHERE message_ref_id=?').get(imported.messageRefId).n, 0,
      'operator resolution alone creates no application-link row');

    const { company: _company, ...factsWithoutCompany } = facts;
    const followUp = {
      ...factsWithoutCompany,
      source: {
        ...facts.source,
        messageId: 'multi-resolution-follow-up',
        contentDigest: 'd'.repeat(64)
      },
      evidence: [{ field: 'subject', excerpt: 'One more thing' }]
    };
    const latestOnly = correlateEmailReadOnly(db, followUp);
    const priorThreadCandidates = latestOnly.candidates.filter((candidate) =>
      candidate.matchBasis === 'previously_linked_thread');
    assert.deepEqual(priorThreadCandidates.map((candidate) => candidate.applicationId), [secondApplicationId],
      'a superseded confirmed correlation cannot remain exact thread evidence');
    assert.equal(latestOnly.resolved.applicationId, secondApplicationId);

    const retracted = learning.retractLink(db, {
      messageRefId: imported.messageRefId,
      actor: 'operator',
      reason: 'all historical resolutions were wrong'
    });
    assert.equal(retracted.linkRetractions, 2);
    assert.deepEqual(
      db.prepare('SELECT application_id FROM email_link_retractions WHERE message_ref_id=? ORDER BY application_id').all(imported.messageRefId).map((row) => row.application_id),
      [firstApplicationId, secondApplicationId]
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM active_job_email_linked_correlations WHERE message_ref_id=?').get(imported.messageRefId).n, 0,
      'no older resolved correlation can resurrect after the newest one is retracted');
  } finally {
    db.close();
  }
});

test('contact and title-alias projections survive one live vouch and disappear after the last vouch retracts', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme Robotics', 'Platform Engineer');
  const db = fixture.open();
  try {
    const base = ARC4[0].facts;
    const facts = (suffix) => ({
      ...base,
      source: {
        ...base.source,
        messageId: `duplicate-vouch-${suffix}`,
        threadId: `duplicate-vouch-${suffix}`,
        fromAddress: 'priya@acme-robotics.com',
        fromDomain: 'acme-robotics.com',
        fromDisplayName: 'Priya Natarajan'
      },
      company: { name: 'Acme Robotics', domain: 'acme-robotics.com' },
      postingRefs: [{ roleTitle: 'the platform role' }],
      evidence: [
        { field: 'subject', excerpt: 'Welcome Chat' },
        { field: 'body', excerpt: 'This is about the platform role.' }
      ]
    });
    const first = importAndCorrelate(db, facts('one'), 'duplicate-vouch-one');
    const second = importAndCorrelate(db, facts('two'), 'duplicate-vouch-two');
    learning.confirmLink(db, { messageRefId: first.messageRefId, applicationId, actor: 'test' });
    learning.confirmLink(db, { messageRefId: second.messageRefId, applicationId, actor: 'test' });

    assert.equal(db.prepare("SELECT count(*) AS n FROM email_identity_learnings WHERE kind='contact' AND retracted_at IS NULL").get().n, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM email_identity_learnings WHERE kind='title_alias' AND retracted_at IS NULL").get().n, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM company_contacts WHERE lower(email)='priya@acme-robotics.com'").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM application_title_aliases WHERE application_id=? AND normalized_alias='the platform role'").get(applicationId).n, 1);

    learning.retractLink(db, { messageRefId: first.messageRefId, actor: 'test' });
    assert.equal(db.prepare("SELECT count(*) AS n FROM company_contacts WHERE lower(email)='priya@acme-robotics.com'").get().n, 1,
      'the second contact vouch keeps the shared projection');
    assert.equal(db.prepare("SELECT count(*) AS n FROM application_title_aliases WHERE application_id=? AND normalized_alias='the platform role'").get(applicationId).n, 1,
      'the second title vouch keeps the shared projection');

    learning.retractLink(db, { messageRefId: second.messageRefId, actor: 'test' });
    assert.equal(db.prepare("SELECT count(*) AS n FROM company_contacts WHERE lower(email)='priya@acme-robotics.com'").get().n, 0,
      'the last contact vouch removes its learned projection even when the first learning materialized it');
    assert.equal(db.prepare("SELECT count(*) AS n FROM application_title_aliases WHERE application_id=? AND normalized_alias='the platform role'").get(applicationId).n, 0,
      'the last title vouch removes its learned projection even when the first learning materialized it');
  } finally {
    db.close();
  }
});

test('retracting email learning preserves a pre-existing catalog domain alias', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme Robotics', 'Platform Engineer');
  const db = fixture.open();
  try {
    const companyId = db.prepare(`
      SELECT o.company_id FROM applications a
      JOIN job_openings o ON o.id=a.job_opening_id WHERE a.id=?
    `).get(applicationId).company_id;
    db.prepare(`
      INSERT INTO company_aliases(company_id,alias,normalized_alias,alias_kind)
      VALUES (?, 'acme-robotics.com', 'acme-robotics.com', 'domain')
    `).run(companyId);
    const base = ARC4[0].facts;
    const facts = {
      ...base,
      source: {
        ...base.source,
        messageId: 'catalog-domain-vouch',
        threadId: 'catalog-domain-vouch',
        fromAddress: 'priya@acme-robotics.com',
        fromDomain: 'acme-robotics.com',
        fromDisplayName: 'Priya Natarajan'
      },
      company: { name: 'Acme Robotics', domain: 'acme-robotics.com' },
      postingRefs: []
    };
    const imported = importFacts(db, facts, 'catalog-domain-vouch');
    const learned = learning.confirmLink(db, {
      messageRefId: imported.messageRefId,
      applicationId,
      actor: 'test'
    });

    assert.equal(learned.domain, 'known');
    assert.equal(db.prepare("SELECT count(*) AS n FROM email_identity_learnings WHERE kind='domain'").get().n, 0,
      'the email path does not claim ownership of an independently known domain');

    learning.retractLink(db, { messageRefId: imported.messageRefId, actor: 'test' });
    assert.equal(db.prepare(`
      SELECT count(*) AS n FROM company_aliases
      WHERE company_id=? AND alias_kind='domain' AND normalized_alias='acme-robotics.com'
    `).get(companyId).n, 1, 'the catalog-owned alias survives retraction');
  } finally {
    db.close();
  }
});

test('operator registry edits preserve seed provenance and hand projections off to later email vouches', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme Robotics', 'Platform Engineer');
  const db = fixture.open();
  try {
    const companyId = db.prepare(`
      SELECT o.company_id FROM applications a
      JOIN job_openings o ON o.id=a.job_opening_id WHERE a.id=?
    `).get(applicationId).company_id;

    const classAdd = runCli(fixture.home, [
      'email', 'identity', 'add', '--kind', 'domain-class', '--domain', 'gmail.com',
      '--class', 'corporate', '--actor', 'cole', '--reason', 'trusted staffing tenant'
    ]);
    assert.equal(classAdd.operation, 'add');
    assert.equal(classifySenderDomain(db, 'mail.gmail.com'), 'corporate');
    const inspected = runCli(fixture.home, ['email', 'identity', '--domain', 'gmail.com']);
    assert.match(inspected.domainClassProvenance.source, /^operator-fact:/);
    runCli(fixture.home, [
      'email', 'identity', 'retract', '--kind', 'domain-class', '--domain', 'gmail.com',
      '--actor', 'cole', '--reason', 'tenant exception ended'
    ]);
    assert.equal(classifySenderDomain(db, 'gmail.com'), 'consumer', 'retracting an override reveals the immutable repo seed');
    assert.match(db.prepare("SELECT source FROM email_domain_classes WHERE domain='gmail.com'").get().source, /^rule-set:/);
    assert.throws(() => learning.editIdentityRegistry(db, 'retract', {
      kind: 'domain-class', domain: 'gmail.com', actor: 'cole', reason: 'must not erase the seed'
    }), (error) => error.code === 'PROTECTED_SEED');

    runCli(fixture.home, [
      'email', 'identity', 'add', '--kind', 'domain', '--company-id', String(companyId),
      '--domain', 'acme-robotics.com', '--actor', 'cole', '--reason', 'verified employer mail domain'
    ]);
    runCli(fixture.home, [
      'email', 'identity', 'add', '--kind', 'contact', '--company-id', String(companyId),
      '--address', 'priya@acme-robotics.com', '--name', 'Operator wording',
      '--actor', 'cole', '--reason', 'verified recruiter address'
    ]);
    const duplicateContact = runCli(fixture.home, [
      'email', 'identity', 'add', '--kind', 'contact', '--company-id', String(companyId),
      '--address', 'PRIYA@ACME-ROBOTICS.COM', '--name', 'Different operator wording',
      '--actor', 'cole', '--reason', 'same normalized mailbox'
    ]);
    assert.equal(duplicateContact.reused, true);

    const base = ARC4[0].facts;
    const facts = {
      ...base,
      source: {
        ...base.source,
        messageId: 'operator-vouch', threadId: 'operator-vouch',
        fromAddress: 'priya@acme-robotics.com', fromDomain: 'acme-robotics.com',
        fromDisplayName: 'Different email display name'
      },
      company: { name: 'Acme Robotics', domain: 'acme-robotics.com' },
      postingRefs: []
    };
    const imported = importFacts(db, facts, 'operator-vouch-import');
    const learned = learning.confirmLink(db, { messageRefId: imported.messageRefId, applicationId, actor: 'fabric-worker' });
    assert.equal(learned.contact, 'learned');
    assert.equal(learned.domain, 'learned', 'an operator-owned alias still accepts independent email provenance');
    assert.equal(db.prepare("SELECT count(*) AS n FROM company_contacts WHERE lower(email)='priya@acme-robotics.com'").get().n, 1,
      'differing display names do not duplicate a mailbox identity');

    const domainRetract = runCli(fixture.home, [
      'email', 'identity', 'retract', '--kind', 'domain', '--company-id', String(companyId),
      '--domain', 'acme-robotics.com', '--actor', 'cole', '--reason', 'let observed mail own it'
    ]);
    const contactRetract = runCli(fixture.home, [
      'email', 'identity', 'retract', '--kind', 'contact', '--company-id', String(companyId),
      '--address', 'priya@acme-robotics.com', '--actor', 'cole', '--reason', 'let observed mail own it'
    ]);
    assert.equal(domainRetract.projectionPreservedByLearning, true);
    assert.equal(contactRetract.projectionPreservedByLearning, true);
    assert.equal(db.prepare("SELECT count(*) AS n FROM company_aliases WHERE normalized_alias='acme-robotics.com' AND alias_kind='domain'").get().n, 1);
    assert.match(db.prepare("SELECT source FROM company_contacts WHERE lower(email)='priya@acme-robotics.com'").get().source, /^email-learning:/);

    learning.retractLink(db, { messageRefId: imported.messageRefId, actor: 'cole', reason: 'message was linked incorrectly' });
    assert.equal(db.prepare("SELECT count(*) AS n FROM company_aliases WHERE normalized_alias='acme-robotics.com' AND alias_kind='domain'").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM company_contacts WHERE lower(email)='priya@acme-robotics.com'").get().n, 0);
    const factsLedger = registry.listRegistryFacts(db, { companyId });
    assert.equal(factsLedger.length, 2);
    assert.ok(factsLedger.every((row) => row.source === 'operator' && row.retraction_id), 'operator additions and retractions retain provenance');
    const metrics = runCli(fixture.home, ['email', 'metrics', '--application-id', String(applicationId)]);
    assert.equal(metrics.command, 'metrics');
    assert.deepEqual(metrics.metrics.scope, { kind: 'application', applicationId });
  } finally {
    db.close();
  }
});

test('a later operator vouch assumes email-owned contact and domain projections until its own retraction', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme Robotics', 'Platform Engineer');
  const db = fixture.open();
  try {
    const companyId = db.prepare(`
      SELECT o.company_id FROM applications a
      JOIN job_openings o ON o.id=a.job_opening_id WHERE a.id=?
    `).get(applicationId).company_id;
    const base = ARC4[0].facts;
    const facts = {
      ...base,
      source: {
        ...base.source,
        messageId: 'email-first-vouch', threadId: 'email-first-vouch',
        fromAddress: 'talent@reverse.acme-robotics.com',
        fromDomain: 'reverse.acme-robotics.com',
        fromDisplayName: 'Acme Talent'
      },
      company: { name: 'Acme Robotics', domain: 'reverse.acme-robotics.com' },
      postingRefs: []
    };
    const imported = importFacts(db, facts, 'email-first-vouch-import');
    learning.confirmLink(db, { messageRefId: imported.messageRefId, applicationId, actor: 'fabric-worker' });
    assert.match(db.prepare("SELECT source FROM company_contacts WHERE lower(email)='talent@reverse.acme-robotics.com'").get().source, /^email-learning:/);

    const domainAdd = learning.editIdentityRegistry(db, 'add', {
      kind: 'domain', companyId, domain: 'reverse.acme-robotics.com',
      actor: 'cole', reason: 'operator independently verified the mail domain'
    });
    const contactAdd = learning.editIdentityRegistry(db, 'add', {
      kind: 'contact', companyId, address: 'talent@reverse.acme-robotics.com', name: 'Operator display',
      actor: 'cole', reason: 'operator independently verified the recruiter'
    });
    assert.equal(domainAdd.projectionAssumed, true, 'the operator fact assumes responsibility for the email-owned projection');
    assert.equal(contactAdd.projectionAssumed, true, 'the operator fact assumes responsibility for the email-owned projection');

    learning.retractLink(db, {
      messageRefId: imported.messageRefId, actor: 'cole', reason: 'the source message was linked incorrectly'
    });
    assert.equal(db.prepare("SELECT count(*) AS n FROM company_aliases WHERE normalized_alias='reverse.acme-robotics.com' AND alias_kind='domain'").get().n, 1,
      'the live operator domain fact preserves the projection');
    assert.equal(db.prepare("SELECT count(*) AS n FROM company_contacts WHERE lower(email)='talent@reverse.acme-robotics.com'").get().n, 1,
      'the live operator contact fact preserves the projection');
    assert.equal(
      db.prepare("SELECT source FROM company_contacts WHERE lower(email)='talent@reverse.acme-robotics.com'").get().source,
      `email-registry-fact:${contactAdd.factId}`,
      'contact projection provenance transfers to the operator fact'
    );

    const domainRetract = learning.editIdentityRegistry(db, 'retract', {
      kind: 'domain', companyId, domain: 'reverse.acme-robotics.com',
      actor: 'cole', reason: 'operator vouch withdrawn'
    });
    const contactRetract = learning.editIdentityRegistry(db, 'retract', {
      kind: 'contact', companyId, address: 'talent@reverse.acme-robotics.com',
      actor: 'cole', reason: 'operator vouch withdrawn'
    });
    assert.equal(domainRetract.projectionRemoved, true);
    assert.equal(contactRetract.projectionRemoved, true);
    assert.equal(db.prepare("SELECT count(*) AS n FROM company_aliases WHERE normalized_alias='reverse.acme-robotics.com' AND alias_kind='domain'").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM company_contacts WHERE lower(email)='talent@reverse.acme-robotics.com'").get().n, 0);
  } finally {
    db.close();
  }
});

test('backfill teaches from every existing link once', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Drove', 'Staff Software Engineer');
  const db = fixture.open();
  try {
    const [welcome, invite] = ARC4.map((entry) => entry.facts);
    const first = importAndCorrelate(db, welcome, 'bf-1');
    // A link made before the registry could learn: remove only the derived
    // projections/ledger state to simulate the pre-R1 store. A real link
    // retraction now stays inactive and must not be revived by backfill.
    resolveCorrelation(db, { source: welcome.source, factsDigest: first.correlation.factsDigest, applicationId, actor: 'fabric-worker', reason: 'welcome' }, 'bf-1-resolve');
    db.transaction(() => {
      db.prepare("UPDATE email_identity_learnings SET retracted_at=datetime('now'),retracted_by='test-fixture' WHERE source_message_ref_id=?").run(first.messageRefId);
      db.prepare("DELETE FROM company_contacts WHERE source LIKE 'email-learning:%'").run();
      db.prepare("DELETE FROM company_aliases WHERE alias_kind='domain' AND normalized_alias='mydrove.com'").run();
    })();
    assert.equal(registry.identifySender(db, invite).basis, 'none');
    const backfilled = runEmailCommand(db, ['backfill-learnings'], {});
    assert.equal(backfilled.messages, 1);
    assert.equal(backfilled.contactsLearned, 1);
    assert.equal(backfilled.domainsLearned, 1);
    assert.equal(registry.identifySender(db, invite).basis, 'contact');
    const again = runEmailCommand(db, ['backfill-learnings'], {});
    assert.equal(again.contactsLearned, 0, 'idempotent');
  } finally {
    db.close();
  }
});

test('backfill skips linked single-open messages that were never confirmed', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Drove', 'Staff Software Engineer');
  const db = fixture.open();
  try {
    const companyId = db.prepare(`
      SELECT opening.company_id FROM applications application
      JOIN job_openings opening ON opening.id=application.job_opening_id
      WHERE application.id=?
    `).get(applicationId).company_id;
    db.prepare('UPDATE companies SET website_domain=? WHERE id=?').run('mydrove.com', companyId);
    const base = ARC4[0].facts;
    const facts = {
      ...base,
      applicationRefs: [{ namespace: 'workday:drove:application', value: 'UNREVIEWED-42' }],
      source: {
        ...base.source,
        messageId: 'backfill-unconfirmed-single-open',
        threadId: 'backfill-unconfirmed-single-open'
      }
    };
    const imported = importAndCorrelate(db, facts, 'backfill-unconfirmed-single-open');
    assert.equal(imported.correlation.resolution, 'linked');
    assert.equal(imported.correlation.resolved.matchBasis, 'company_single_open');
    assert.equal(imported.correlation.automaticEligible, false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM email_identity_learnings').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM application_external_identifiers').get().n, 0);

    const backfilled = learning.backfillLearnings(db);
    assert.equal(backfilled.messages, 0);
    assert.equal(backfilled.skippedUnconfirmed, 1);
    assert.equal(backfilled.applicationIdentifiersLearned, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM email_identity_learnings').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM application_external_identifiers').get().n, 0,
      'unreviewed application references never become exact evidence');
  } finally {
    db.close();
  }
});

test('backfill reports structured application-identifier conflicts and malformed references', (t) => {
  const fixture = createStore(t);
  const firstApplicationId = addApplication(fixture.home, 'Alpha', 'Platform Engineer');
  const secondApplicationId = addApplication(fixture.home, 'Beta', 'Frontend Engineer');
  const db = fixture.open();
  try {
    const sharedReference = { namespace: 'ashby:shared:application', value: 'SHARED-91' };
    const malformedReference = { namespace: '\u0001unsafe', value: 'BAD-91' };
    const base = ARC4[0].facts;
    const addConfirmedFixture = (suffix, applicationId, applicationRefs) => {
      const facts = {
        ...base,
        applicationRefs,
        source: {
          ...base.source,
          messageId: `backfill-identifier-${suffix}`,
          threadId: `backfill-identifier-${suffix}`,
          fromAddress: `${suffix}.recruiter@gmail.com`,
          fromDomain: 'gmail.com'
        }
      };
      const imported = importFacts(db, facts, `backfill-identifier-${suffix}:facts`);
      const inserted = db.prepare(`
        INSERT INTO job_email_correlations(
          message_ref_id,facts_digest,resolution,resolved_application_id,correlation_json,correlation_digest
        ) VALUES (?,?,'linked',?,?,?)
      `).run(
        imported.messageRefId,
        imported.factsDigest,
        applicationId,
        JSON.stringify({
          automaticEligible: false,
          evidence: [{ kind: 'operator_resolution', value: 'confirmed by test operator' }]
        }),
        suffix === 'alpha' ? 'a'.repeat(64) : 'b'.repeat(64)
      );
      return { messageRefId: imported.messageRefId, correlationId: Number(inserted.lastInsertRowid) };
    };

    addConfirmedFixture('alpha', firstApplicationId, [sharedReference]);
    const second = addConfirmedFixture(
      'beta', secondApplicationId, [sharedReference, malformedReference]
    );

    const backfilled = runEmailCommand(db, ['backfill-learnings'], {});
    assert.equal(backfilled.messages, 2);
    assert.equal(backfilled.applicationIdentifiersLearned, 1);
    assert.equal(backfilled.applicationIdentifierConflictCount, 1);
    assert.equal(backfilled.applicationIdentifierErrorCount, 1);
    assert.equal(backfilled.applicationIdentifierIssueMessagesOmitted, 0);
    assert.deepEqual(backfilled.applicationIdentifierIssues, [{
      messageRefId: second.messageRefId,
      applicationId: secondApplicationId,
      correlationId: second.correlationId,
      conflicts: [{
        namespace: sharedReference.namespace,
        value: sharedReference.value,
        applicationId: firstApplicationId,
        code: 'APPLICATION_IDENTIFIER_CONFLICT'
      }],
      errors: [{
        namespace: malformedReference.namespace,
        value: malformedReference.value,
        code: 'INVALID_APPLICATION_IDENTIFIER',
        message: 'application identifier namespace/value is outside the safe printable bounds'
      }]
    }]);

    const replay = runEmailCommand(db, ['backfill-learnings'], {});
    assert.equal(replay.applicationIdentifiersLearned, 0);
    assert.equal(replay.applicationIdentifierConflictCount, 1,
      'a zero-create replay still reports the unresolved identifier conflict');
    assert.equal(replay.applicationIdentifierErrorCount, 1);
    assert.deepEqual(replay.applicationIdentifierIssues, backfilled.applicationIdentifierIssues);
  } finally {
    db.close();
  }
});
