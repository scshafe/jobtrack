'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  factsJsonSchema,
  factsV2JsonSchema,
  correlationJsonSchema,
  correlationV2JsonSchema,
  transitionJsonSchema,
  replyDraftJsonSchema,
  validateJobApplicationEmailFacts,
  validateCorrelationResult,
  validateTransitionProposal,
  validateReplyDraftProposal,
  digest
} = require('../lib/email-contracts');
const {
  APPLICATION_EXTERNAL_IDENTIFIER_SCHEMA_VERSION,
  REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_SCHEMA_VERSION,
  correlateEmailReadOnly,
  migrateEmailIntegration,
  importFacts,
  recordCorrelation,
  resolveCorrelation,
  proposeTransition,
  proposeReplyDraft,
  reviewTransition,
  reviewReplyDraft,
  applyTransition
} = require('../lib/email-integration');
const emailLearning = require('../lib/email-correlation/learn');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('email contracts are strict, versioned, and keep metadata-only proposals out of automation', () => {
  for (const schema of [
    factsJsonSchema,
    factsV2JsonSchema,
    correlationJsonSchema,
    correlationV2JsonSchema,
    transitionJsonSchema,
    replyDraftJsonSchema
  ]) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.match(schema.$id, /jobtrack\.local\/contracts/);
    assert.equal(schema.additionalProperties, false);
  }

  const facts = makeFacts({ contentCompleteness: 'metadata_only' });
  assert.equal(validateJobApplicationEmailFacts(facts).schemaVersion, 'job-application-email-facts.v1');
  assert.throws(() => validateJobApplicationEmailFacts({ ...facts, unexpectedAuthority: 'send' }), /unknown field/i);

  const proposal = {
    ...makeTransitionProposal({
      facts,
      correlation: linkedCorrelationStub(facts),
      action: { kind: 'link_message', relation: 'application_update' },
      proposalId: 'metadata-proposal'
    }),
    requiresReview: true,
    automationEligible: true
  };
  assert.throws(() => validateTransitionProposal(proposal), /automationEligible/);
  assert.throws(
    () => validateTransitionProposal({ ...proposal, automationEligible: false, policyCandidate: 'exact_status' }),
    /policyCandidate/
  );
  assert.throws(
    () => validateTransitionProposal({ ...proposal, requiresReview: false, automationEligible: false }),
    /requiresReview/
  );
});

test('legacy same-company matching remains ambiguous and cannot silently choose an application', (t) => {
  const fixture = createStore(t);
  const first = addApplication(fixture.home, 'Acme', 'Frontend Engineer');
  const second = addApplication(fixture.home, 'Acme', 'FPGA Engineer');
  const db = fixture.open();
  try {
    const facts = makeFacts({
      company: { name: 'Acme', domain: 'acme.example' },
      postingRefs: []
    });
    const correlation = correlateEmailReadOnly(db, facts);
    assert.equal(correlation.resolution, 'ambiguous');
    assert.equal(correlation.automaticEligible, false);
    assert.deepEqual(new Set(correlation.candidates.map((candidate) => candidate.applicationId)), new Set([first, second]));
    assert.ok(correlation.candidates.every((candidate) => candidate.matchBasis === 'company_only'));
  } finally {
    db.close();
  }
});

// A welcome email carries v2 facts; company_domain is a v2-era basis. The facts
// company name is deliberately unrelated to the seeded company so that ONLY the
// sender-domain path fires (the legacy applications.company string match would
// otherwise also contribute company_only candidates).
function welcomeV2Facts(overrides = {}) {
  const sourceOverrides = overrides.source || {};
  return makeAppleMailFacts({
    company: { name: 'Third Party ATS', domain: 'thirdparty-ats.test' },
    postingRefs: [],
    ...overrides,
    source: {
      messageId: 'welcome-domain-1',
      fromAddress: 'careers@acme.test',
      fromDomain: 'acme.test',
      contentDigest: sha256('welcome domain content'),
      ...sourceOverrides
    }
  });
}

test('a relevant welcome from an identified company with one open application links for review (HIGH-3)', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    const companyId = db.prepare("SELECT id FROM companies WHERE normalized_name='acme'").get().id;
    db.prepare('UPDATE companies SET website_domain=? WHERE id=?').run('acme.test', companyId);

    // No posting URL, no application id — only the sender's From domain ties it
    // to the company.
    const correlation = correlateEmailReadOnly(db, welcomeV2Facts());
    assert.equal(correlation.schemaVersion, 'jobtrack-correlation-result.v3');
    assert.equal(correlation.resolution, 'linked');
    assert.equal(correlation.automaticEligible, false);
    assert.equal(correlation.resolved.applicationId, applicationId);
    assert.equal(correlation.resolved.matchBasis, 'company_single_open');
    assert.ok(correlation.candidates.some((candidate) => candidate.matchBasis === 'company_domain'));
    assert.ok(correlation.evidence.some((entry) => entry.kind === 'company_domain'));

    // A subdomain sender still matches the registrable company domain.
    const subCorrelation = correlateEmailReadOnly(db, welcomeV2Facts({
      source: { messageId: 'welcome-sub', fromAddress: 'no-reply@careers.acme.test', fromDomain: 'careers.acme.test' }
    }));
    assert.equal(subCorrelation.resolution, 'linked');
    assert.ok(subCorrelation.candidates.some((candidate) => candidate.matchBasis === 'company_domain'));

    // The producer-supplied facts.company.domain is honored even when the From
    // domain is a third-party ATS.
    const viaFactsCompany = correlateEmailReadOnly(db, welcomeV2Facts({
      company: { name: 'Third Party ATS', domain: 'acme.test' },
      source: { messageId: 'welcome-fc', fromAddress: 'talent@thirdparty-ats.test', fromDomain: 'thirdparty-ats.test' }
    }));
    assert.equal(viaFactsCompany.candidates.some((candidate) => candidate.matchBasis === 'company_domain'), true);

    // When the email also names the role, the basis upgrades to company_and_role.
    const withRole = correlateEmailReadOnly(db, welcomeV2Facts({
      postingRefs: [{ roleTitle: 'Platform Engineer' }],
      source: { messageId: 'welcome-role', fromAddress: 'careers@acme.test', fromDomain: 'acme.test' }
    }));
    assert.ok(withRole.candidates.some((candidate) => candidate.matchBasis === 'company_and_role'));

    // A look-alike domain does not match on the dot boundary.
    const stranger = correlateEmailReadOnly(db, welcomeV2Facts({
      source: { messageId: 'welcome-stranger', fromAddress: 'hi@evilacme.test', fromDomain: 'evilacme.test' }
    }));
    assert.equal(stranger.resolution, 'unmatched');
  } finally {
    db.close();
  }
});

test('company-domain correlation surfaces every application at the company as an ambiguous candidate (HIGH-3)', (t) => {
  const fixture = createStore(t);
  const first = addApplication(fixture.home, 'Acme', 'Frontend Engineer');
  const second = addApplication(fixture.home, 'Acme', 'FPGA Engineer');
  const db = fixture.open();
  try {
    const companyId = db.prepare("SELECT id FROM companies WHERE normalized_name='acme'").get().id;
    db.prepare('UPDATE companies SET website_domain=? WHERE id=?').run('acme.test', companyId);
    const correlation = correlateEmailReadOnly(db, welcomeV2Facts());
    assert.equal(correlation.resolution, 'ambiguous');
    assert.deepEqual(
      new Set(correlation.candidates.map((candidate) => candidate.applicationId)),
      new Set([first, second])
    );
    assert.ok(correlation.candidates.every((candidate) => candidate.matchBasis === 'company_domain'));
  } finally {
    db.close();
  }
});

test('an operator disambiguates an ambiguous correlation and unblocks the transition (HIGH-4)', (t) => {
  const fixture = createStore(t);
  const first = addApplication(fixture.home, 'Acme', 'Frontend Engineer');
  addApplication(fixture.home, 'Acme', 'FPGA Engineer');
  const db = fixture.open();
  try {
    // Two applications at the same company -> ambiguous (company_only), so
    // propose-transition would throw CORRELATION_MISMATCH. Uses a v1/fixture
    // provider because the transition-proposal contract is strict-provider.
    const facts = makeFacts({
      company: { name: 'Acme', domain: 'acme.example' },
      postingRefs: [],
      applicationRefs: [{ namespace: 'lever:acme:application', value: 'AGENT-CONFIRMED-17' }]
    });
    const factsDigest = digest(facts);
    importFacts(db, facts, 'high4:facts');
    const ambiguous = correlateEmailReadOnly(db, facts);
    assert.equal(ambiguous.resolution, 'ambiguous');
    assert.ok(ambiguous.candidates.length >= 2);

    const resolveInput = {
      source: facts.source,
      factsDigest,
      applicationId: first,
      actor: 'Cole',
      reason: 'Recruiter is the Frontend Engineer application; confirmed from the thread.'
    };
    // An application that is not among the candidates cannot be chosen.
    assert.throws(
      () => resolveCorrelation(db, { ...resolveInput, applicationId: 999999 }, 'high4:bad-target'),
      (error) => error.code === 'RESOLUTION_TARGET_NOT_A_CANDIDATE'
    );
    const resolved = resolveCorrelation(db, resolveInput, 'high4:resolve');
    assert.equal(resolved.resolvedApplicationId, first);
    assert.equal(resolved.reused, false);
    assert.deepEqual(resolved.learning.applicationIdentifiers, {
      created: 1,
      reused: 0,
      namespaces: ['lever:acme:application']
    });
    assert.deepEqual(
      db.prepare(`
        SELECT provenance_kind,confirmed_by,source_transition_proposal_id,review_event_id,reviewed_by
        FROM application_external_identifiers WHERE value='AGENT-CONFIRMED-17'
      `).get(),
      {
        provenance_kind: 'confirmed_link',
        confirmed_by: 'Cole',
        source_transition_proposal_id: null,
        review_event_id: null,
        reviewed_by: null
      }
    );

    // Idempotent replay returns the same recorded correlation.
    assert.deepEqual(resolveCorrelation(db, resolveInput, 'high4:resolve'), resolved);

    // The stored correlation is now linked to the chosen application, non-automatic,
    // and carries the operator's choice as evidence.
    const stored = JSON.parse(db.prepare('SELECT correlation_json FROM job_email_correlations WHERE id=?').get(resolved.correlationId).correlation_json);
    assert.equal(stored.resolution, 'linked');
    assert.equal(stored.resolved.applicationId, first);
    assert.equal(stored.automaticEligible, false);
    assert.ok(stored.evidence.some((entry) => entry.kind === 'operator_resolution' && entry.value.includes('Cole')));
    assert.deepEqual(validateCorrelationResult(stored), stored);

    // propose-transition, which throws CORRELATION_MISMATCH on an ambiguous
    // correlation, now succeeds against the operator-resolved one.
    const proposal = makeTransitionProposal({
      facts,
      correlation: stored,
      proposalId: 'high4-transition',
      action: { kind: 'link_message', relation: 'application_update' }
    });
    const proposed = proposeTransition(db, proposal, 'high4:propose');
    assert.equal(proposed.reused, false);
    assert.equal(
      db.prepare('SELECT application_id FROM job_email_transition_proposals WHERE proposal_id=?').get('high4-transition').application_id,
      first
    );

  } finally {
    db.close();
  }
});

test('operator resolution works for the v2 welcome path correlated by company domain (HIGH-4)', (t) => {
  const fixture = createStore(t);
  const first = addApplication(fixture.home, 'Acme', 'Frontend Engineer');
  addApplication(fixture.home, 'Acme', 'FPGA Engineer');
  const db = fixture.open();
  try {
    const companyId = db.prepare("SELECT id FROM companies WHERE normalized_name='acme'").get().id;
    db.prepare('UPDATE companies SET website_domain=? WHERE id=?').run('acme.test', companyId);
    const facts = welcomeV2Facts();
    importFacts(db, facts, 'high4-v2:facts');
    assert.equal(correlateEmailReadOnly(db, facts).resolution, 'ambiguous');

    const resolved = resolveCorrelation(db, {
      source: facts.source, factsDigest: digest(facts), applicationId: first,
      actor: 'Cole', reason: 'Confirmed the welcome email is the Frontend Engineer application.'
    }, 'high4-v2:resolve');
    assert.equal(resolved.resolvedApplicationId, first);
    assert.equal(resolved.resolved.matchBasis, 'company_domain');

    const stored = JSON.parse(db.prepare('SELECT correlation_json FROM job_email_correlations WHERE id=?').get(resolved.correlationId).correlation_json);
    assert.equal(stored.schemaVersion, 'jobtrack-correlation-result.v3');
    assert.equal(stored.resolution, 'linked');
    assert.equal(stored.resolved.applicationId, first);
    assert.equal(stored.automaticEligible, false);
    assert.ok(stored.evidence.some((entry) => entry.kind === 'operator_resolution'));
    assert.deepEqual(validateCorrelationResult(stored), stored);
  } finally {
    db.close();
  }
});

test('operator resolution refuses a correlation that is not ambiguous (HIGH-4)', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    const normalized = addNormalizedOpening(db, applicationId);
    // An exact posting match -> linked, not ambiguous.
    const facts = makeAppleMailFacts({
      company: { name: 'Acme', domain: 'acme.example' },
      postingRefs: [{ url: normalized.primaryUrl, roleTitle: 'Platform Engineer' }]
    });
    importFacts(db, facts, 'high4-linked:facts');
    assert.equal(correlateEmailReadOnly(db, facts).resolution, 'linked');
    assert.throws(
      () => resolveCorrelation(db, {
        source: facts.source, factsDigest: digest(facts), applicationId, actor: 'Cole', reason: 'n/a'
      }, 'high4-linked:resolve'),
      (error) => error.code === 'CORRELATION_NOT_AMBIGUOUS'
    );
  } finally {
    db.close();
  }
});

test('the transition proposal source is provider-neutral (HIGH-5)', () => {
  const base = {
    schemaVersion: 'jobtrack-transition-proposal.v1',
    proposalId: 'provider-neutral-proposal',
    source: { provider: 'apple_mail_emlx', accountId: 'jobs@example.test', messageId: 'm-1', threadId: 't-1' },
    factsDigest: 'a'.repeat(64),
    correlationDigest: 'b'.repeat(64),
    target: { applicationId: 1 },
    expectedApplicationVersion: 0,
    correlation: { resolution: 'linked', matchBasis: 'company_domain', confidence: 0.5 },
    safety: { contentCompleteness: 'sanitized_plain_text', securityRisk: 'medium', sourceRequiresReview: true },
    action: { kind: 'link_message', relation: 'application_update' },
    policyCandidate: 'exact_link',
    requiresReview: true,
    automationEligible: false,
    evidence: ['Derived from m-1']
  };
  // A provider-neutral code is accepted, and a legacy strict provider still is.
  assert.equal(validateTransitionProposal(base).source.provider, 'apple_mail_emlx');
  assert.equal(validateTransitionProposal({ ...base, source: { ...base.source, provider: 'gmail' } }).source.provider, 'gmail');
  // Provider-neutral means the code PATTERN, not anything: malformed codes still reject.
  for (const bad of ['Apple Mail', 'GMAIL', '1provider', 'has space']) {
    assert.throws(() => validateTransitionProposal({ ...base, source: { ...base.source, provider: bad } }), /provider/i);
  }
});

test('a v2 Apple message travels the full transition lane: propose, review, apply (HIGH-5)', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    const normalized = addNormalizedOpening(db, applicationId);
    // A v2 apple_mail_emlx message that correlates linked via an exact posting URL.
    const facts = makeAppleMailFacts({
      company: { name: 'Acme', domain: 'acme.example' },
      postingRefs: [{ url: normalized.primaryUrl, roleTitle: 'Platform Engineer' }]
    });
    assert.equal(facts.source.provider, 'apple_mail_emlx');
    importFacts(db, facts, 'high5:facts');
    const correlation = correlateEmailReadOnly(db, facts);
    assert.equal(correlation.resolution, 'linked');
    recordCorrelation(db, correlation, 'high5:correlation');

    // propose-transition previously threw on the apple_mail_emlx provider; it now
    // validates and stores the proposal.
    const proposal = makeTransitionProposal({
      facts,
      correlation,
      proposalId: 'high5-link',
      action: { kind: 'link_message', relation: 'application_update' }
    });
    proposeTransition(db, proposal, 'high5:propose');

    reviewTransition(db, {
      proposalId: proposal.proposalId, decision: 'approved', decidedBy: 'Cole', idempotencyKey: 'high5:review'
    });
    const applied = applyTransition(db, {
      proposalId: proposal.proposalId,
      expectedApplicationVersion: proposal.expectedApplicationVersion,
      appliedBy: 'fixture:high5',
      idempotencyKey: 'high5:apply'
    });
    assert.equal(applied.command, 'apply-transition');
    assert.deepEqual(
      db.prepare('SELECT event_kind FROM job_email_transition_events WHERE proposal_id=? ORDER BY id').all(proposal.proposalId).map((row) => row.event_kind),
      ['proposed', 'approved', 'applied']
    );
    // The email is now linked to the application.
    assert.ok(db.prepare('SELECT 1 FROM job_email_application_links WHERE application_id=?').get(applicationId));
  } finally {
    db.close();
  }
});

test('an exact normalized cross-post URL resolves one application through either posting occurrence', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    const normalized = addNormalizedOpening(db, applicationId);
    const facts = makeFacts({
      company: { name: 'Acme', domain: 'acme.example' },
      postingRefs: [{ url: normalized.secondaryUrl, roleTitle: 'Platform Engineer' }]
    });
    const correlation = correlateEmailReadOnly(db, facts);
    assert.equal(correlation.resolution, 'linked');
    assert.equal(correlation.automaticEligible, true);
    assert.equal(correlation.resolved.applicationId, applicationId);
    assert.equal(correlation.resolved.openingId, normalized.openingId);
    assert.equal(correlation.resolved.postingId, normalized.secondaryPostingId);
    assert.equal(correlation.resolved.postingOccurrenceId, normalized.secondaryPostingId);
    assert.equal(correlation.resolved.matchBasis, 'exact_posting_occurrence');
  } finally {
    db.close();
  }
});

test('an automatic exact correlation seeds same-thread exact evidence before a transition is applied', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    const normalized = addNormalizedOpening(db, applicationId);
    const initial = makeAppleMailFacts({
      source: {
        messageId: 'automatic-thread-initial',
        threadId: 'automatic-thread',
        fromAddress: 'no-reply@greenhouse.io',
        fromDomain: 'greenhouse.io',
        contentDigest: sha256('automatic thread initial')
      },
      company: { name: 'Unrelated ATS' },
      postingRefs: [{ url: normalized.primaryUrl }],
      evidence: [{ field: 'subject', excerpt: 'Application update' }]
    });
    const imported = importFacts(db, initial, 'automatic-thread:initial:import');
    const exact = correlateEmailReadOnly(db, initial);
    assert.equal(exact.resolution, 'linked');
    assert.equal(exact.automaticEligible, true);
    assert.equal(exact.resolved.matchBasis, 'exact_posting_occurrence');
    recordCorrelation(db, exact, 'automatic-thread:initial:record');
    assert.equal(db.prepare('SELECT count(*) AS n FROM job_email_application_links WHERE message_ref_id=?').get(imported.messageRefId).n, 0);

    const followUp = makeAppleMailFacts({
      source: {
        messageId: 'automatic-thread-follow-up',
        threadId: 'automatic-thread',
        fromAddress: 'no-reply@greenhouse.io',
        fromDomain: 'greenhouse.io',
        contentDigest: sha256('automatic thread follow up')
      },
      eventKind: 'recruiter_followup',
      company: { name: 'Unrelated ATS' },
      postingRefs: [],
      evidence: [{ field: 'subject', excerpt: 'Next steps' }]
    });
    const linked = correlateEmailReadOnly(db, followUp);
    assert.equal(linked.resolution, 'linked');
    assert.equal(linked.resolved.applicationId, applicationId);
    assert.equal(linked.resolved.matchBasis, 'previously_linked_thread');

    emailLearning.retractLink(db, {
      messageRefId: imported.messageRefId,
      actor: 'Cole',
      reason: 'the exact source was attached to the wrong application'
    });
    assert.equal(correlateEmailReadOnly(db, followUp).candidates.some((candidate) =>
      candidate.matchBasis === 'previously_linked_thread'), false);
  } finally {
    db.close();
  }
});

test('email exact URL correlation uses catalog identity across legacy query and tracking variants', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    const normalized = addNormalizedOpening(db, applicationId);
    const legacyUrl = `${normalized.secondaryUrl}/?z=9&utm_source=stored&a=1`;
    db.prepare('UPDATE job_postings SET canonical_url=?,canonical_url_sha256=? WHERE id=?')
      .run(legacyUrl, sha256(legacyUrl), normalized.secondaryPostingId);
    const facts = makeFacts({
      company: { name: 'Acme', domain: 'acme.example' },
      postingRefs: [{
        url: `${normalized.secondaryUrl}?a=1&fbclid=ignored&z=9&utm_medium=email#apply`,
        roleTitle: 'Platform Engineer'
      }]
    });
    const correlation = correlateEmailReadOnly(db, facts);
    assert.equal(correlation.resolution, 'linked');
    assert.equal(correlation.automaticEligible, true);
    assert.equal(correlation.resolved.applicationId, applicationId);
    assert.equal(correlation.resolved.postingId, normalized.secondaryPostingId);
    assert.equal(correlation.resolved.matchBasis, 'exact_posting_occurrence');
  } finally {
    db.close();
  }
});

test('an automatic exact link stores normalized provider application IDs before transition review', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    const normalized = addNormalizedOpening(db, applicationId);
    assert.equal(
      db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
        .get(APPLICATION_EXTERNAL_IDENTIFIER_SCHEMA_VERSION).name,
      'reviewed_application_external_identifiers'
    );
    assert.equal(
      db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
        .get(REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_SCHEMA_VERSION).name,
      'reversible_application_external_identifiers'
    );
    const prepared = prepareTransition(db, {
      applicationId,
      normalized,
      suffix: 'bind-provider-id',
      factsOverrides: {
        applicationRefs: [
          { namespace: 'Greenhouse:Acme:Application', value: ' GH-APP-2048 ' },
          { namespace: ' greenhouse:acme:application ', value: 'GH-APP-2048' }
        ]
      },
      action: { kind: 'link_message', relation: 'application_update' }
    });

    assert.throws(
      () => applyPrepared(db, prepared, 'bind-provider-id-unreviewed'),
      (error) => error.code === 'APPROVAL_REQUIRED'
    );
    assert.deepEqual(prepared.recorded.learning.applicationIdentifiers, {
      created: 1,
      reused: 0,
      namespaces: ['greenhouse:acme:application']
    });
    assert.equal(db.prepare('SELECT count(*) count FROM application_external_identifiers').get().count, 1);

    approve(db, prepared, 'bind-provider-id');
    const applied = applyPrepared(db, prepared, 'bind-provider-id');
    assert.deepEqual(applied.externalIdentifiers, {
      created: 0,
      reused: 1,
      namespaces: ['greenhouse:acme:application']
    });
    const identifier = db.prepare('SELECT * FROM application_external_identifiers').get();
    assert.equal(identifier.application_id, applicationId);
    assert.equal(identifier.namespace, 'greenhouse:acme:application');
    assert.equal(identifier.value, 'GH-APP-2048');
    assert.equal(identifier.provenance_kind, 'confirmed_link');
    assert.equal(identifier.confirmed_by, 'jobtrack:record-correlation');
    assert.equal(identifier.source_transition_proposal_id, null);
    assert.equal(identifier.review_event_id, null);
    assert.equal(identifier.reviewed_by, null);
    assert.ok(identifier.source_message_ref_id);
    assert.ok(identifier.source_correlation_id);

    const laterFacts = makeFacts({
      source: { messageId: 'provider-id-followup', threadId: 'unrelated-provider-thread' },
      company: undefined,
      postingRefs: [],
      applicationRefs: [{ namespace: 'GREENHOUSE:ACME:APPLICATION', value: 'GH-APP-2048' }]
    });
    const laterCorrelation = correlateEmailReadOnly(db, laterFacts);
    assert.equal(laterCorrelation.resolution, 'linked');
    assert.equal(laterCorrelation.automaticEligible, true);
    assert.equal(laterCorrelation.resolved.applicationId, applicationId);
    assert.equal(laterCorrelation.resolved.matchBasis, 'provider_application_id');
  } finally {
    db.close();
  }
});

test('a review-required single-open link learns its provider ID only after approved apply', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    const companyId = db.prepare(`
      SELECT opening.company_id FROM applications application
      JOIN job_openings opening ON opening.id=application.job_opening_id
      WHERE application.id=?
    `).get(applicationId).company_id;
    db.prepare('UPDATE companies SET website_domain=? WHERE id=?').run('acme.test', companyId);
    const facts = welcomeV2Facts({
      source: { messageId: 'single-open-reviewed-id', threadId: 'single-open-reviewed-id' },
      postingRefs: [{ roleTitle: 'the platform role' }],
      evidence: [
        { field: 'subject', excerpt: 'Welcome Chat' },
        { field: 'body', excerpt: 'This is about the platform role.' }
      ],
      applicationRefs: [
        { namespace: 'workday:acme:application', value: 'WD-REVIEW-42' },
        { namespace: '\u0001unsafe', value: 'INVALID-BUT-NONBLOCKING' }
      ]
    });
    const correlation = correlateEmailReadOnly(db, facts);
    assert.equal(correlation.resolution, 'linked');
    assert.equal(correlation.resolved.applicationId, applicationId);
    assert.equal(correlation.resolved.matchBasis, 'company_single_open');
    assert.equal(correlation.automaticEligible, false);
    importFacts(db, facts, 'single-open-reviewed-id:facts');
    const recorded = recordCorrelation(db, correlation, 'single-open-reviewed-id:correlation');
    assert.equal(recorded.learning, undefined, 'recording a review-required link is not confirmation');
    assert.equal(db.prepare('SELECT count(*) count FROM application_external_identifiers').get().count, 0);
    assert.equal(db.prepare("SELECT count(*) count FROM email_identity_learnings WHERE kind='title_alias'").get().count, 0);

    const proposal = makeTransitionProposal({
      facts,
      correlation,
      proposalId: 'proposal-single-open-reviewed-id',
      action: { kind: 'link_message', relation: 'application_update' }
    });
    proposeTransition(db, proposal, 'single-open-reviewed-id:proposal');
    const prepared = { facts, correlation, proposal, recorded };
    approve(db, prepared, 'single-open-reviewed-id');
    const applied = applyPrepared(db, prepared, 'single-open-reviewed-id');
    assert.equal(applied.externalIdentifiers.created, 1);
    assert.equal(applied.externalIdentifiers.reused, 0);
    assert.deepEqual(applied.externalIdentifiers.namespaces, ['workday:acme:application']);
    assert.deepEqual(applied.externalIdentifiers.errors, [{
      namespace: '\u0001unsafe',
      value: 'INVALID-BUT-NONBLOCKING',
      code: 'INVALID_APPLICATION_IDENTIFIER',
      message: 'application identifier namespace/value is outside the safe printable bounds'
    }]);
    assert.deepEqual(applied.learning.applicationIdentifiers, applied.externalIdentifiers,
      'learning errors are observable without aborting the approved action');
    assert.equal(applied.learning.contact, 'learned',
      'approved and applied link_message is the confirmation boundary for sender learning');
    assert.equal(applied.learning.titleAliases, 1,
      'the reviewed transition learns only after the grounded role match is confirmed');
    assert.deepEqual(db.prepare(`
      SELECT application_id,value FROM email_identity_learnings
      WHERE kind='title_alias' AND retracted_at IS NULL
    `).all(), [{ application_id: applicationId, value: 'the platform role' }]);
    assert.ok(db.prepare(`
      SELECT 1 FROM email_identity_learnings
      WHERE source_message_ref_id=(SELECT id FROM job_email_message_refs WHERE message_id=?)
    `).get(facts.source.messageId));
    assert.deepEqual(
      db.prepare(`
        SELECT provenance_kind,confirmed_by,source_transition_proposal_id,review_event_id,reviewed_by
        FROM application_external_identifiers WHERE value='WD-REVIEW-42'
      `).get(),
      {
        provenance_kind: 'reviewed_transition',
        confirmed_by: 'Cole',
        source_transition_proposal_id: proposal.proposalId,
        review_event_id: db.prepare(`
          SELECT id FROM job_email_transition_events
          WHERE proposal_id=? AND event_kind='approved'
        `).get(proposal.proposalId).id,
        reviewed_by: 'Cole'
      }
    );
  } finally {
    db.close();
  }
});

test('provider identifier projection survives one live confirmed vouch and disappears after the last retraction', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    const normalized = addNormalizedOpening(db, applicationId);
    const reference = [{ namespace: 'greenhouse:acme:application', value: 'GH-TWO-VOUCHES' }];
    const first = prepareTransition(db, {
      applicationId,
      normalized,
      suffix: 'identifier-vouch-one',
      factsOverrides: { applicationRefs: reference },
      action: { kind: 'link_message', relation: 'application_update' }
    });
    assert.equal(first.recorded.learning.applicationIdentifiers.created, 1);
    approve(db, first, 'identifier-vouch-one');
    assert.equal(applyPrepared(db, first, 'identifier-vouch-one').externalIdentifiers.reused, 1);

    const second = prepareTransition(db, {
      applicationId,
      normalized,
      suffix: 'identifier-vouch-two',
      factsOverrides: { applicationRefs: reference },
      action: { kind: 'link_message', relation: 'application_update' }
    });
    assert.equal(second.recorded.learning.applicationIdentifiers.created, 1);
    approve(db, second, 'identifier-vouch-two');
    assert.deepEqual(applyPrepared(db, second, 'identifier-vouch-two').externalIdentifiers, {
      created: 0,
      reused: 1,
      namespaces: ['greenhouse:acme:application']
    });
    assert.equal(db.prepare('SELECT count(*) count FROM active_application_external_identifiers WHERE value=?').get('GH-TWO-VOUCHES').count, 2);

    const messageId = (prepared) => db.prepare('SELECT id FROM job_email_message_refs WHERE message_id=?').get(prepared.facts.source.messageId).id;
    emailLearning.retractLink(db, { messageRefId: messageId(first), actor: 'Cole', reason: 'first source withdrawn' });
    assert.equal(db.prepare('SELECT count(*) count FROM active_application_external_identifiers WHERE value=?').get('GH-TWO-VOUCHES').count, 1);
    const exactFacts = makeFacts({
      source: {
        messageId: 'identifier-vouch-probe', threadId: 'identifier-vouch-probe',
        fromAddress: 'no-reply@greenhouse.io', fromDomain: 'greenhouse.io'
      },
      company: undefined,
      postingRefs: [],
      applicationRefs: reference
    });
    assert.equal(correlateEmailReadOnly(db, exactFacts).resolved.matchBasis, 'provider_application_id');

    emailLearning.retractLink(db, { messageRefId: messageId(second), actor: 'Cole', reason: 'last source withdrawn' });
    assert.equal(db.prepare('SELECT count(*) count FROM active_application_external_identifiers WHERE value=?').get('GH-TWO-VOUCHES').count, 0);
    assert.equal(correlateEmailReadOnly(db, exactFacts).candidates.some((candidate) => candidate.matchBasis === 'provider_application_id'), false);
    assert.equal(db.prepare('SELECT count(*) count FROM application_external_identifiers WHERE value=?').get('GH-TWO-VOUCHES').count, 2,
      'both confirmed source rows remain immutable history');
  } finally {
    db.close();
  }
});

test('reversible identifier migration preserves legacy UUIDs while replacing static uniqueness with active uniqueness', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE jobtrack_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);
    CREATE TABLE applications(id INTEGER PRIMARY KEY);
    CREATE TABLE job_email_message_refs(id INTEGER PRIMARY KEY,facts_json TEXT,facts_digest TEXT);
    CREATE TABLE job_email_correlations(
      id INTEGER PRIMARY KEY,message_ref_id INTEGER,facts_digest TEXT,resolution TEXT,
      resolved_application_id INTEGER,correlation_json TEXT
    );
    CREATE TABLE job_email_transition_proposals(
      proposal_id TEXT PRIMARY KEY,message_ref_id INTEGER,correlation_id INTEGER,application_id INTEGER
    );
    CREATE TABLE job_email_transition_events(id INTEGER PRIMARY KEY,proposal_id TEXT,event_kind TEXT,actor TEXT);
    CREATE TABLE email_link_retractions(id INTEGER PRIMARY KEY,message_ref_id INTEGER,application_id INTEGER);
    CREATE VIEW active_job_email_linked_correlations AS
      SELECT correlation.* FROM job_email_correlations correlation
      WHERE correlation.resolution='linked' AND NOT EXISTS (
        SELECT 1 FROM email_link_retractions retraction
        WHERE retraction.message_ref_id=correlation.message_ref_id
          AND (retraction.application_id IS NULL OR retraction.application_id=correlation.resolved_application_id)
      );
    CREATE TABLE application_external_identifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
      namespace TEXT NOT NULL COLLATE NOCASE,
      value TEXT NOT NULL,
      source_message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
      source_correlation_id INTEGER NOT NULL REFERENCES job_email_correlations(id) ON DELETE RESTRICT,
      source_transition_proposal_id TEXT NOT NULL REFERENCES job_email_transition_proposals(proposal_id) ON DELETE RESTRICT,
      review_event_id INTEGER NOT NULL REFERENCES job_email_transition_events(id) ON DELETE RESTRICT,
      reviewed_by TEXT NOT NULL,
      facts_digest TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(namespace,value),
      UNIQUE(application_id,namespace,value)
    );
    CREATE INDEX idx_application_external_identifiers_application
      ON application_external_identifiers(application_id,namespace);
    CREATE UNIQUE INDEX idx_application_external_identifiers_uuid
      ON application_external_identifiers(uuid);
    CREATE TRIGGER application_external_identifiers_reviewed_source BEFORE INSERT ON application_external_identifiers BEGIN SELECT 1; END;
    CREATE TRIGGER application_external_identifiers_append_only_update BEFORE UPDATE ON application_external_identifiers BEGIN SELECT RAISE(ABORT,'append-only'); END;
    CREATE TRIGGER application_external_identifiers_append_only_delete BEFORE DELETE ON application_external_identifiers BEGIN SELECT RAISE(ABORT,'append-only'); END;
    INSERT INTO applications(id) VALUES (1);
    INSERT INTO job_email_message_refs(id,facts_json,facts_digest)
      VALUES (1,'{"applicationRefs":[{"namespace":"legacy:application","value":"LEGACY-7"}]}',printf('%064d',0));
    INSERT INTO job_email_correlations(
      id,message_ref_id,facts_digest,resolution,resolved_application_id,correlation_json
    ) VALUES (1,1,printf('%064d',0),'linked',1,'{"automaticEligible":false,"evidence":[]}');
    INSERT INTO job_email_transition_proposals(proposal_id,message_ref_id,correlation_id,application_id)
      VALUES ('legacy-proposal',1,1,1);
    INSERT INTO job_email_transition_events(id,proposal_id,event_kind,actor)
      VALUES (1,'legacy-proposal','approved','Cole');
    INSERT INTO application_external_identifiers(
      id,uuid,application_id,namespace,value,source_message_ref_id,source_correlation_id,
      source_transition_proposal_id,review_event_id,reviewed_by,facts_digest,created_at
    ) VALUES (
      7,'11111111-1111-4111-8111-111111111111',1,'legacy:application','LEGACY-7',
      1,1,'legacy-proposal',1,'Cole',printf('%064d',0),'2026-09-01 12:00:00'
    );
    INSERT INTO jobtrack_schema_migrations(version,name)
      VALUES (2026071713,'reviewed_application_external_identifiers');
  `);

  emailLearning.migrateReversibleApplicationExternalIdentifiers(db);
  assert.deepEqual(db.prepare(`
    SELECT id,uuid,application_id,namespace,value,provenance_kind,confirmed_by,reviewed_by,created_at
    FROM application_external_identifiers
  `).get(), {
    id: 7,
    uuid: '11111111-1111-4111-8111-111111111111',
    application_id: 1,
    namespace: 'legacy:application',
    value: 'LEGACY-7',
    provenance_kind: 'reviewed_transition',
    confirmed_by: 'Cole',
    reviewed_by: 'Cole',
    created_at: '2026-09-01 12:00:00'
  });
  assert.equal(db.prepare('SELECT count(*) count FROM active_application_external_identifiers').get().count, 1);
  const indexes = db.prepare("PRAGMA index_list('application_external_identifiers')").all().map((row) => row.name);
  assert.ok(indexes.includes('idx_application_external_identifiers_source_vouch'));
  const uuidIndex = db.prepare("PRAGMA index_list('application_external_identifiers')").all()
    .find((row) => row.name === 'idx_application_external_identifiers_uuid');
  assert.equal(uuidIndex?.unique, 1, 'the rebuilt table retains universal UUID uniqueness');
  assert.equal(indexes.some((name) => name.startsWith('sqlite_autoindex_application_external_identifiers_')), false,
    'the legacy static namespace/value uniqueness is gone');
  emailLearning.migrateReversibleApplicationExternalIdentifiers(db);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('application identifier provenance is append-only, facts-bound, conflict-safe, and migration-replayable', (t) => {
  const fixture = createStore(t);
  const firstApplicationId = addApplication(fixture.home, 'Alpha', 'Platform Engineer');
  const secondApplicationId = addApplication(fixture.home, 'Beta', 'Frontend Engineer');
  const db = fixture.open();
  try {
    migrateEmailIntegration(db);
    const firstNormalized = addNormalizedOpening(db, firstApplicationId);
    const secondNormalized = addNormalizedOpening(db, secondApplicationId);
    const sharedReference = { namespace: 'ashby:shared-board:application', value: 'candidate-77' };
    const firstPrepared = prepareTransition(db, {
      applicationId: firstApplicationId,
      normalized: firstNormalized,
      suffix: 'identifier-first',
      factsOverrides: {
        company: { name: 'Alpha', domain: 'alpha.example' },
        source: { fromAddress: 'jobs@alpha.example', fromDomain: 'alpha.example' },
        applicationRefs: [sharedReference]
      },
      action: { kind: 'link_message', relation: 'application_update' }
    });
    assert.equal(firstPrepared.recorded.learning.applicationIdentifiers.created, 1);
    approve(db, firstPrepared, 'identifier-first');
    applyPrepared(db, firstPrepared, 'identifier-first');

    // The second message has exact posting evidence for Beta but the now-bound
    // provider ID points at Alpha. It is ambiguous until the operator confirms
    // Beta; that confirmation must still learn every nonconflicting fact.
    const secondFacts = makeAppleMailFacts({
      source: {
        messageId: 'message-identifier-second', threadId: 'thread-identifier-second',
        fromAddress: 'jobs@beta.example', fromDomain: 'beta.example'
      },
      company: { name: 'Beta', domain: 'beta.example' },
      postingRefs: [{ url: secondNormalized.primaryUrl, roleTitle: 'Frontend Engineer' }],
      applicationRefs: [
        sharedReference,
        { namespace: 'ashby:shared-board:application', value: 'candidate-77-secondary-vouch' }
      ]
    });
    importFacts(db, secondFacts, 'identifier-second:facts');
    const secondAmbiguous = correlateEmailReadOnly(db, secondFacts);
    assert.equal(secondAmbiguous.resolution, 'ambiguous');
    assert.deepEqual(
      new Set(secondAmbiguous.candidates.map((candidate) => candidate.applicationId)),
      new Set([firstApplicationId, secondApplicationId])
    );
    recordCorrelation(db, secondAmbiguous, 'identifier-second:correlation');
    const secondResolved = resolveCorrelation(db, {
      source: secondFacts.source,
      factsDigest: digest(secondFacts),
      applicationId: secondApplicationId,
      actor: 'Cole',
      reason: 'The posting and company identify Beta; the shared provider reference was previously misbound.'
    }, 'identifier-second:resolve');
    assert.equal(secondResolved.learning.applicationIdentifiers.created, 1,
      'the nonconflicting provider reference is learned despite the shared-reference conflict');
    assert.deepEqual(secondResolved.learning.applicationIdentifiers.conflicts, [{
      namespace: sharedReference.namespace,
      value: sharedReference.value,
      applicationId: firstApplicationId,
      code: 'APPLICATION_IDENTIFIER_CONFLICT'
    }]);
    assert.equal(secondResolved.learning.contact, 'learned');

    const secondStored = JSON.parse(db.prepare(
      'SELECT correlation_json FROM job_email_correlations WHERE id=?'
    ).get(secondResolved.correlationId).correlation_json);
    const secondProposal = makeTransitionProposal({
      facts: secondFacts,
      correlation: secondStored,
      proposalId: 'proposal-identifier-second',
      action: { kind: 'link_message', relation: 'application_update' }
    });
    proposeTransition(db, secondProposal, 'identifier-second:proposal');
    const secondPrepared = { facts: secondFacts, correlation: secondStored, proposal: secondProposal };
    approve(db, secondPrepared, 'identifier-second');
    const secondBefore = db.prepare('SELECT lock_version FROM applications WHERE id=?').get(secondApplicationId).lock_version;
    const conflictedApply = applyPrepared(db, secondPrepared, 'identifier-second');
    assert.equal(db.prepare('SELECT lock_version FROM applications WHERE id=?').get(secondApplicationId).lock_version, secondBefore + 1);
    assert.equal(operationExists(db, 'apply:identifier-second'), true,
      'a learning conflict does not abort the reviewed application action');
    assert.deepEqual(conflictedApply.externalIdentifiers.conflicts, [{
      namespace: sharedReference.namespace,
      value: sharedReference.value,
      applicationId: firstApplicationId,
      code: 'APPLICATION_IDENTIFIER_CONFLICT'
    }]);
    assert.equal(conflictedApply.externalIdentifiers.reused, 1);
    assert.deepEqual(conflictedApply.learning.applicationIdentifiers, conflictedApply.externalIdentifiers);
    assert.equal(db.prepare(`
      SELECT count(*) count FROM active_job_email_application_links
      WHERE message_ref_id=(SELECT id FROM job_email_message_refs WHERE message_id=?) AND application_id=?
    `).get(secondFacts.source.messageId, secondApplicationId).count, 1);
    assert.equal(db.prepare('SELECT count(*) count FROM application_external_identifiers').get().count, 2);

    const firstMessageRefId = db.prepare('SELECT id FROM job_email_message_refs WHERE message_id=?')
      .get(firstPrepared.facts.source.messageId).id;
    emailLearning.retractLink(db, {
      messageRefId: firstMessageRefId,
      actor: 'Cole',
      reason: 'the provider identifier was attached to the wrong application'
    });
    assert.equal(db.prepare(`
      SELECT count(*) count FROM active_application_external_identifiers
      WHERE namespace=? AND value=?
    `).get(sharedReference.namespace, sharedReference.value).count, 0);

    const corrected = emailLearning.backfillLearnings(db, { actor: 'jobtrack:test-backfill' });
    assert.equal(corrected.applicationIdentifiersLearned, 1,
      'the still-confirmed Beta source assumes the provider ID after the wrong source retracts');
    assert.equal(db.prepare('SELECT count(*) count FROM application_external_identifiers').get().count, 3,
      'the wrong binding remains immutable history beside its correction');
    assert.equal(db.prepare(`
      SELECT application_id FROM active_application_external_identifiers
      WHERE namespace=? AND value=?
    `).get(sharedReference.namespace, sharedReference.value).application_id, secondApplicationId);

    const exactFacts = makeFacts({
      source: { messageId: 'corrected-provider-id', threadId: 'corrected-provider-id' },
      company: undefined,
      postingRefs: [],
      applicationRefs: [sharedReference]
    });
    const exact = correlateEmailReadOnly(db, exactFacts);
    assert.equal(exact.resolution, 'linked');
    assert.equal(exact.resolved.applicationId, secondApplicationId);
    assert.equal(exact.resolved.matchBasis, 'provider_application_id');

    const identifier = db.prepare(`
      SELECT * FROM active_application_external_identifiers
      WHERE application_id=? AND value=?
    `).get(secondApplicationId, sharedReference.value);
    assert.throws(
      () => db.prepare(`
        INSERT INTO application_external_identifiers (
          application_id,namespace,value,provenance_kind,source_message_ref_id,source_correlation_id,
          confirmed_by,source_transition_proposal_id,review_event_id,reviewed_by,facts_digest
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        secondApplicationId, identifier.namespace, 'not-in-confirmed-facts', identifier.provenance_kind,
        identifier.source_message_ref_id, identifier.source_correlation_id, identifier.confirmed_by,
        identifier.source_transition_proposal_id, identifier.review_event_id, identifier.reviewed_by,
        identifier.facts_digest
      ),
      /requires exact or operator-confirmed active link provenance/
    );
    assert.throws(
      () => db.prepare('UPDATE application_external_identifiers SET value=? WHERE id=?').run('tamper', identifier.id),
      /append-only/
    );
    assert.throws(
      () => db.prepare('DELETE FROM application_external_identifiers WHERE id=?').run(identifier.id),
      /append-only/
    );
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  } finally {
    db.close();
  }
});

test('posting external IDs are exact only when scoped to their normalized platform', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    const normalized = addNormalizedOpening(db, applicationId);
    const unscoped = makeFacts({
      company: undefined,
      postingRefs: [{ externalJobId: `linkedin-${normalized.openingId}` }]
    });
    assert.equal(correlateEmailReadOnly(db, unscoped).resolution, 'unmatched');

    const scoped = makeFacts({
      company: undefined,
      postingRefs: [{ provider: 'linkedin', externalJobId: `linkedin-${normalized.openingId}` }]
    });
    const correlation = correlateEmailReadOnly(db, scoped);
    assert.equal(correlation.resolution, 'linked');
    assert.equal(correlation.resolved.applicationId, applicationId);
    assert.equal(correlation.resolved.postingId, normalized.secondaryPostingId);
    assert.equal(correlation.automaticEligible, true);
  } finally {
    db.close();
  }
});

test('facts, correlations, and transition proposals replay exactly and conflict on changed requests', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    const normalized = addNormalizedOpening(db, applicationId);
    const facts = makeFacts({ postingRefs: [{ url: normalized.primaryUrl, roleTitle: 'Platform Engineer' }] });
    const correlation = correlateEmailReadOnly(db, facts);
    const firstFacts = importFacts(db, facts, 'facts:replay');
    assert.deepEqual(importFacts(db, facts, 'facts:replay'), firstFacts);
    assert.throws(
      () => importFacts(db, { ...facts, eventKind: 'rejection' }, 'facts:replay'),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );
    assert.throws(
      () => recordCorrelation(db, {
        ...correlation,
        evidence: [...correlation.evidence, { kind: 'fabricated', value: 'not emitted by JobTrack correlation' }]
      }, 'correlation:forged'),
      (error) => error.code === 'CORRELATION_STALE'
    );
    assert.equal(operationExists(db, 'correlation:forged'), false);
    const recorded = recordCorrelation(db, correlation, 'correlation:replay');
    assert.deepEqual(recordCorrelation(db, correlation, 'correlation:replay'), recorded);
    const proposal = makeTransitionProposal({
      facts,
      correlation,
      proposalId: 'transition-replay',
      action: { kind: 'link_message', relation: 'application_update' }
    });
    assert.throws(
      () => proposeTransition(db, {
        ...proposal,
        proposalId: 'transition-elevated-correlation',
        correlation: { resolution: 'linked', matchBasis: 'previously_linked_thread', confidence: 1 }
      }, 'transition:elevated-correlation'),
      (error) => error.code === 'CORRELATION_MISMATCH'
    );
    assert.throws(
      () => proposeTransition(db, {
        ...proposal,
        proposalId: 'transition-omitted-relations',
        target: { applicationId }
      }, 'transition:omitted-relations'),
      (error) => error.code === 'CORRELATION_MISMATCH'
    );
    assert.throws(
      () => proposeTransition(db, {
        ...proposal,
        proposalId: 'transition-elevated-safety',
        safety: { contentCompleteness: 'metadata_only', securityRisk: 'high', sourceRequiresReview: true }
      }, 'transition:elevated-safety'),
      (error) => error.code === 'FACTS_SAFETY_MISMATCH'
    );
    const proposed = proposeTransition(db, proposal, 'transition:replay');
    assert.deepEqual(proposeTransition(db, proposal, 'transition:replay'), proposed);
    assert.throws(
      () => proposeTransition(db, { ...proposal, evidence: ['changed evidence'] }, 'transition:replay'),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );
    assert.equal(db.prepare('SELECT count(*) count FROM job_email_transition_proposals').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) count FROM job_email_operations').get().count, 3);
    assert.throws(
      () => db.prepare("UPDATE job_email_message_refs SET event_kind='unknown' WHERE id=?").run(firstFacts.messageRefId),
      /append-only/
    );
  } finally {
    db.close();
  }
});

test('the CLI performs the reviewed transition protocol end to end', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  const normalized = addNormalizedOpening(db, applicationId);
  db.close();

  const facts = makeFacts({
    source: { messageId: 'message-cli-e2e', threadId: 'thread-cli-e2e' },
    postingRefs: [{ url: normalized.primaryUrl, roleTitle: 'Platform Engineer' }]
  });
  const factsPath = writeJson(fixture.root, 'cli-facts.json', facts);
  const correlation = runCli(fixture.home, ['email', 'correlate', '--input', factsPath]);
  const correlationPath = writeJson(fixture.root, 'cli-correlation.json', correlation);
  runCli(fixture.home, ['email', 'import-facts', '--input', factsPath, '--idempotency-key', 'cli:facts']);
  runCli(fixture.home, ['email', 'record-correlation', '--input', correlationPath, '--idempotency-key', 'cli:correlation']);

  const proposal = makeTransitionProposal({
    facts,
    correlation,
    proposalId: 'cli-transition',
    action: { kind: 'transition_application_status', fromStatus: 'applied', toStatus: 'interviewing' }
  });
  const proposalPath = writeJson(fixture.root, 'cli-transition.json', proposal);
  runCli(fixture.home, ['email', 'propose-transition', '--input', proposalPath, '--idempotency-key', 'cli:proposal']);
  runCli(fixture.home, [
    'email', 'review-transition', '--proposal-id', proposal.proposalId, '--decision', 'approved',
    '--decided-by', 'Cole', '--idempotency-key', 'cli:review'
  ]);
  const applied = runCli(fixture.home, [
    'email', 'apply-transition', '--proposal-id', proposal.proposalId,
    '--expected-application-version', String(proposal.expectedApplicationVersion),
    '--applied-by', 'fixture:e2e', '--idempotency-key', 'cli:apply'
  ]);
  assert.equal(applied.afterStatus, 'interviewing');
  assert.equal(applied.afterVersion, proposal.expectedApplicationVersion + 1);

  const readback = fixture.open();
  try {
    assert.deepEqual(
      readback.prepare('SELECT status,lock_version FROM applications WHERE id=?').get(applicationId),
      { status: 'interviewing', lock_version: proposal.expectedApplicationVersion + 1 }
    );
    assert.deepEqual(
      readback.prepare('SELECT event_kind FROM job_email_transition_events WHERE proposal_id=? ORDER BY id').all(proposal.proposalId)
        .map((row) => row.event_kind),
      ['proposed', 'approved', 'applied']
    );
  } finally {
    readback.close();
  }
});

test('Apple Mail v2 facts correlate, import, record, and replay without widening mutation surfaces', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const setup = fixture.open();
  const normalized = addNormalizedOpening(setup, applicationId);
  setup.close();

  const facts = makeAppleMailFacts({
    company: { name: 'Acme', domain: 'acme.example' },
    postingRefs: [{ url: normalized.primaryUrl, roleTitle: 'Platform Engineer' }]
  });
  const factsPath = writeJson(fixture.root, 'apple-mail-facts-v2.json', facts);

  const correlation = runCli(fixture.home, ['email', 'correlate', '--input', factsPath]);
  assert.equal(correlation.schemaVersion, 'jobtrack-correlation-result.v3');
  assert.equal(correlation.source.provider, 'apple_mail_emlx');
  assert.equal(correlation.resolution, 'linked');
  assert.equal(correlation.resolved.applicationId, applicationId);
  assert.equal(correlation.resolved.postingId, normalized.primaryPostingId);
  assert.equal(correlation.automaticEligible, true);
  assert.deepEqual(validateCorrelationResult(correlation), correlation);

  const imported = runCli(fixture.home, [
    'email', 'import-facts', '--input', factsPath, '--idempotency-key', 'apple-mail:v2:facts'
  ]);
  assert.equal(imported.reused, false);
  assert.deepEqual(
    runCli(fixture.home, [
      'email', 'import-facts', '--input', factsPath, '--idempotency-key', 'apple-mail:v2:facts'
    ]),
    imported
  );

  const correlationPath = writeJson(fixture.root, 'apple-mail-correlation-v2.json', correlation);
  const recorded = runCli(fixture.home, [
    'email', 'record-correlation', '--input', correlationPath, '--idempotency-key', 'apple-mail:v2:correlation'
  ]);
  assert.equal(recorded.reused, false);
  assert.deepEqual(
    runCli(fixture.home, [
      'email', 'record-correlation', '--input', correlationPath, '--idempotency-key', 'apple-mail:v2:correlation'
    ]),
    recorded
  );

  const readback = fixture.open();
  try {
    const message = readback.prepare('SELECT * FROM job_email_message_refs').get();
    assert.equal(message.provider, 'apple_mail_emlx');
    assert.equal(message.account_id, facts.source.accountId);
    assert.deepEqual(validateJobApplicationEmailFacts(JSON.parse(message.facts_json)), facts);
    assert.equal(message.facts_digest, digest(facts));

    const storedCorrelation = readback.prepare('SELECT * FROM job_email_correlations').get();
    assert.deepEqual(validateCorrelationResult(JSON.parse(storedCorrelation.correlation_json)), correlation);
    assert.equal(storedCorrelation.correlation_digest, digest(correlation));
    assert.equal(readback.prepare('SELECT count(*) count FROM job_email_message_refs').get().count, 1);
    assert.equal(readback.prepare('SELECT count(*) count FROM job_email_correlations').get().count, 1);
    assert.equal(
      readback.prepare('SELECT count(*) count FROM job_email_correlation_candidates').get().count,
      correlation.candidates.length
    );
    assert.equal(readback.prepare('SELECT count(*) count FROM job_email_operations').get().count, 2);
    assert.equal(readback.prepare('SELECT count(*) count FROM job_email_transition_proposals').get().count, 0);
    assert.equal(readback.prepare('SELECT count(*) count FROM job_email_reply_draft_proposals').get().count, 0);
    assert.equal(readback.prepare('SELECT count(*) count FROM job_email_send_request_sink').get().count, 0);
  } finally {
    readback.close();
  }
});

test('Apple Mail v2 rejects a malformed provider before importing any message', (t) => {
  const fixture = createStore(t);
  const malformed = makeAppleMailFacts();
  malformed.source.provider = 'Apple Mail';
  const factsPath = writeJson(fixture.root, 'apple-mail-malformed-provider.json', malformed);

  const failed = runCliFailure(fixture.home, [
    'email', 'import-facts', '--input', factsPath, '--idempotency-key', 'apple-mail:v2:malformed'
  ]);
  assert.equal(failed.status, 1);
  const error = JSON.parse(failed.stderr);
  assert.equal(error.ok, false);
  assert.equal(error.error.code, 'INVALID_EMAIL_CONTRACT');
  assert.match(error.error.message, /provider/);

  const readback = fixture.open();
  try {
    assert.equal(readback.prepare('SELECT count(*) count FROM job_email_message_refs').get().count, 0);
    assert.equal(readback.prepare('SELECT count(*) count FROM job_email_operations').get().count, 0);
  } finally {
    readback.close();
  }
});

test('explicit apply enforces approval, stale versions, and non-regressing status transitions', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    const normalized = addNormalizedOpening(db, applicationId);
    const prepared = prepareTransition(db, {
      applicationId,
      normalized,
      suffix: 'stale',
      action: { kind: 'transition_application_status', fromStatus: 'applied', toStatus: 'interviewing' }
    });
    assert.throws(
      () => applyTransition(db, {
        proposalId: prepared.proposal.proposalId,
        expectedApplicationVersion: String(prepared.proposal.expectedApplicationVersion),
        appliedBy: 'executor:test',
        idempotencyKey: 'apply:without-approval'
      }),
      (error) => error.code === 'APPROVAL_REQUIRED'
    );
    assert.equal(operationExists(db, 'apply:without-approval'), false);
    reviewTransition(db, {
      proposalId: prepared.proposal.proposalId,
      decision: 'approved', decidedBy: 'Cole', idempotencyKey: 'review:stale'
    });
    db.prepare('UPDATE applications SET lock_version=lock_version+1 WHERE id=?').run(applicationId);
    assert.throws(
      () => applyTransition(db, {
        proposalId: prepared.proposal.proposalId,
        expectedApplicationVersion: String(prepared.proposal.expectedApplicationVersion),
        appliedBy: 'executor:test', idempotencyKey: 'apply:stale'
      }),
      (error) => error.code === 'STALE_APPLICATION'
    );
    assert.equal(operationExists(db, 'apply:stale'), false);

    db.prepare("UPDATE applications SET status='interviewing' WHERE id=?").run(applicationId);
    const regression = prepareTransition(db, {
      applicationId,
      normalized,
      suffix: 'regression',
      action: { kind: 'transition_application_status', fromStatus: 'interviewing', toStatus: 'applied' }
    });
    reviewTransition(db, {
      proposalId: regression.proposal.proposalId,
      decision: 'approved', decidedBy: 'Cole', idempotencyKey: 'review:regression'
    });
    assert.throws(
      () => applyTransition(db, {
        proposalId: regression.proposal.proposalId,
        expectedApplicationVersion: String(regression.proposal.expectedApplicationVersion),
        appliedBy: 'executor:test', idempotencyKey: 'apply:regression'
      }),
      (error) => error.code === 'INVALID_STATUS_TRANSITION'
    );
    assert.equal(db.prepare('SELECT status FROM applications WHERE id=?').get(applicationId).status, 'interviewing');
    assert.equal(operationExists(db, 'apply:regression'), false);
  } finally {
    db.close();
  }
});

test('apply revalidates that its reviewed correlation is still active', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    const normalized = addNormalizedOpening(db, applicationId);
    const prepared = prepareTransition(db, {
      applicationId,
      normalized,
      suffix: 'retracted-before-apply',
      action: { kind: 'transition_application_status', fromStatus: 'applied', toStatus: 'interviewing' }
    });
    approve(db, prepared, 'retracted-before-apply');
    const messageRefId = db.prepare('SELECT id FROM job_email_message_refs WHERE message_id=?')
      .get(prepared.facts.source.messageId).id;
    emailLearning.retractLink(db, {
      messageRefId, actor: 'Cole', reason: 'review found that the message belonged to another application'
    });

    assert.throws(
      () => applyPrepared(db, prepared, 'retracted-before-apply'),
      (error) => error.code === 'CORRELATION_RETRACTED'
    );
    assert.deepEqual(
      db.prepare('SELECT status,lock_version FROM applications WHERE id=?').get(applicationId),
      { status: 'applied', lock_version: prepared.proposal.expectedApplicationVersion }
    );
    assert.equal(operationExists(db, 'apply:retracted-before-apply'), false);
  } finally {
    db.close();
  }
});

test('interview create, reschedule, and cancel preserve message provenance transactionally', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    const normalized = addNormalizedOpening(db, applicationId);
    const firstTime = '2026-08-01T17:00:00.000Z';
    const secondTime = '2026-08-02T18:30:00.000Z';
    const created = prepareTransition(db, {
      applicationId,
      normalized,
      suffix: 'interview-create',
      factsOverrides: {
        eventKind: 'interview_invite',
        interview: { intent: 'schedule', round: 'screen', scheduledAt: firstTime, timezone: 'America/Los_Angeles', format: 'video' }
      },
      action: { kind: 'create_interview', round: 'screen', scheduledAt: firstTime, timezone: 'America/Los_Angeles', format: 'video', interviewer: 'A Recruiter' }
    });
    approve(db, created, 'create');
    const createResult = applyPrepared(db, created, 'create');
    const interviewId = createResult.interviewId;
    assert.ok(interviewId);
    assert.equal(db.prepare('SELECT status FROM applications WHERE id=?').get(applicationId).status, 'interviewing');

    const rescheduled = prepareTransition(db, {
      applicationId,
      normalized,
      suffix: 'interview-reschedule',
      factsOverrides: {
        eventKind: 'interview_rescheduled',
        interview: { intent: 'reschedule', round: 'screen', previousScheduledAt: firstTime, scheduledAt: secondTime, timezone: 'America/Los_Angeles', format: 'video' }
      },
      action: { kind: 'reschedule_interview', interviewId, fromScheduledAt: firstTime, toScheduledAt: secondTime, timezone: 'America/Los_Angeles' }
    });
    assert.equal(rescheduled.correlation.resolved.interviewId, interviewId);
    approve(db, rescheduled, 'reschedule');
    applyPrepared(db, rescheduled, 'reschedule');
    assert.equal(db.prepare('SELECT scheduled_at FROM interviews WHERE id=?').get(interviewId).scheduled_at, secondTime);

    const cancelled = prepareTransition(db, {
      applicationId,
      normalized,
      suffix: 'interview-cancel',
      factsOverrides: {
        eventKind: 'interview_cancelled',
        interview: { intent: 'cancel', round: 'screen', scheduledAt: secondTime, timezone: 'America/Los_Angeles', format: 'video' }
      },
      action: { kind: 'cancel_interview', interviewId, cancelledAt: '2026-07-30T12:00:00.000Z', reason: 'Employer cancelled' }
    });
    assert.equal(cancelled.correlation.resolved.interviewId, interviewId);
    approve(db, cancelled, 'cancel');
    const cancelResult = applyPrepared(db, cancelled, 'cancel');
    assert.equal(cancelResult.interviewEventKind, 'cancelled');
    const interview = db.prepare('SELECT * FROM interviews WHERE id=?').get(interviewId);
    assert.equal(interview.scheduling_status, 'cancelled');
    assert.equal(interview.cancellation_reason, 'Employer cancelled');
    assert.deepEqual(
      db.prepare('SELECT event_kind FROM job_email_interview_events ORDER BY id').all().map((row) => row.event_kind),
      ['scheduled', 'rescheduled', 'cancelled']
    );
    assert.equal(db.prepare('SELECT count(*) count FROM job_email_interview_links').get().count, 3);
    assert.equal(db.prepare('SELECT count(*) count FROM job_email_application_events').get().count, 3);

    const replay = applyPrepared(db, cancelled, 'cancel');
    assert.deepEqual(replay, cancelResult);
    assert.throws(
      () => applyTransition(db, {
        proposalId: cancelled.proposal.proposalId,
        expectedApplicationVersion: String(cancelled.proposal.expectedApplicationVersion),
        appliedBy: 'different-executor', idempotencyKey: 'apply:cancel'
      }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );
  } finally {
    db.close();
  }
});

test('failed interview application is atomic and does not consume its idempotency key', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    const normalized = addNormalizedOpening(db, applicationId);
    const scheduledAt = '2026-08-01T17:00:00.000Z';
    const interviewId = db.prepare(`
      INSERT INTO interviews(application_id,round,scheduled_at,timezone,format,outcome,scheduling_status,updated_at)
      VALUES (?,'screen',?,'America/Los_Angeles','video','pending','scheduled',datetime('now'))
    `).run(applicationId, scheduledAt).lastInsertRowid;
    const prepared = prepareTransition(db, {
      applicationId,
      normalized,
      suffix: 'atomic-cancel',
      factsOverrides: {
        eventKind: 'interview_cancelled',
        interview: { intent: 'cancel', scheduledAt, timezone: 'America/Los_Angeles', format: 'video' }
      },
      action: { kind: 'cancel_interview', interviewId: Number(interviewId), reason: 'Cancelled' }
    });
    approve(db, prepared, 'atomic-cancel');
    db.prepare("UPDATE interviews SET scheduling_status='cancelled' WHERE id=?").run(interviewId);
    assert.throws(
      () => applyPrepared(db, prepared, 'atomic-cancel'),
      (error) => error.code === 'INTERVIEW_CONFLICT'
    );
    assert.equal(operationExists(db, 'apply:atomic-cancel'), false);
    assert.equal(db.prepare('SELECT count(*) count FROM job_email_application_links WHERE proposal_id=?').get(prepared.proposal.proposalId).count, 0);
    assert.equal(db.prepare('SELECT count(*) count FROM job_email_application_events WHERE proposal_id=?').get(prepared.proposal.proposalId).count, 0);
    assert.equal(db.prepare('SELECT event_kind FROM job_email_transition_events WHERE proposal_id=? ORDER BY id DESC LIMIT 1').get(prepared.proposal.proposalId).event_kind, 'approved');
  } finally {
    db.close();
  }
});

test('interview facts with no unique scheduled match surface the miss as evidence, not silence', (t) => {
  const fixture = createStore(t);
  const applicationId = addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const db = fixture.open();
  try {
    addNormalizedOpening(db, applicationId);
    const interviewFacts = makeFacts({
      eventKind: 'interview_invite',
      interview: { intent: 'schedule', round: 'screen', timezone: 'America/Los_Angeles', format: 'video' }
    });

    // Zero scheduled interviews on the application: the facts expected a link
    // that cannot be made. The correlation must say so.
    const unmatched = correlateEmailReadOnly(db, interviewFacts);
    assert.ok(
      unmatched.evidence.some((entry) => entry.kind === 'interview_unmatched'),
      'a zero-match interview must leave an interview_unmatched evidence entry'
    );
    assert.ok(unmatched.candidates.every((candidate) => candidate.interviewId === undefined));

    // Two scheduled interviews: linking one would be a guess, so none is
    // linked — but the ambiguity is recorded rather than swallowed.
    for (const scheduledAt of ['2026-08-05T17:00:00.000Z', '2026-08-06T17:00:00.000Z']) {
      db.prepare(`
        INSERT INTO interviews(application_id,round,scheduled_at,timezone,format,outcome,scheduling_status,updated_at)
        VALUES (?,'screen',?,'America/Los_Angeles','video','pending','scheduled',datetime('now'))
      `).run(applicationId, scheduledAt);
    }
    const ambiguous = correlateEmailReadOnly(db, interviewFacts);
    const ambiguousEntry = ambiguous.evidence.find((entry) => entry.kind === 'interview_ambiguous');
    assert.ok(ambiguousEntry, 'a multi-match interview must leave an interview_ambiguous evidence entry');
    assert.match(ambiguousEntry.value, /2 scheduled interviews matched/);
    assert.ok(ambiguous.candidates.every((candidate) => candidate.interviewId === undefined),
      'ambiguous interview matches must not silently link one');
  } finally {
    db.close();
  }
});

test('reply drafts are recipient-locked proposals with no send capability', (t) => {
  const fixture = createStore(t);
  const db = fixture.open();
  try {
    const facts = makeFacts({
      replyRequested: true,
      source: { replyToAddress: 'recruiter@acme.example' }
    });
    importFacts(db, facts, 'facts:reply');
    const body = 'Thank you. I will review the scheduling options.';
    const proposal = {
      schemaVersion: 'email-reply-draft-proposal.v1',
      proposalId: 'reply-draft-1',
      factsDigest: digest(facts),
      source: {
        provider: facts.source.provider,
        accountId: facts.source.accountId,
        messageId: facts.source.messageId,
        threadId: facts.source.threadId,
        replyToAddress: facts.source.replyToAddress
      },
      recipient: facts.source.replyToAddress,
      subject: 'Re: Interview scheduling',
      body,
      bodyDigest: sha256(body),
      purpose: 'scheduling',
      authorship: 'model',
      expiresAt: '2026-08-01T00:00:00.000Z',
      sensitiveDataScan: 'passed',
      requiresReview: true,
      autoSendEligible: false
    };
    assert.equal(validateReplyDraftProposal(proposal).autoSendEligible, false);
    assert.throws(() => validateReplyDraftProposal({ ...proposal, recipient: 'attacker@example.net' }), /replyToAddress/);
    const saved = proposeReplyDraft(db, proposal, 'reply:propose');
    assert.equal(saved.autoSendEnabled, false);
    const reviewed = reviewReplyDraft(db, {
      proposalId: proposal.proposalId, decision: 'approved', decidedBy: 'Cole', idempotencyKey: 'reply:review'
    });
    assert.equal(reviewed.autoSendEnabled, false);
    assert.deepEqual(
      db.prepare('SELECT event_kind FROM job_email_reply_draft_events ORDER BY id').all().map((row) => row.event_kind),
      ['proposed', 'approved']
    );
    // Every 'send'-named object is a DATA table, never a send path: the historical
    // v1 dry-run sink/correlation, provider-neutral v2 immutable request/receipt
    // ledgers, and declarative reply-intent send-start journal. Draft review
    // neither creates reply intent ownership nor emits to any send ledger.
    assert.deepEqual(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%send%' ORDER BY name").all().map((row) => row.name),
      [
        'job_email_reply_send_starts',
        'job_email_send_receipt_correlations',
        'job_email_send_receipt_correlations_v2',
        'job_email_send_request_sink',
        'job_email_send_requests_v2'
      ]
    );
    assert.equal(db.prepare('SELECT count(*) count FROM job_email_reply_intents').get().count, 0);
    assert.equal(db.prepare('SELECT count(*) count FROM job_email_reply_send_starts').get().count, 0);
    assert.equal(db.prepare('SELECT count(*) count FROM job_email_send_request_sink').get().count, 0);
    assert.equal(db.prepare('SELECT count(*) count FROM job_email_send_requests_v2').get().count, 0);
    assert.equal(db.prepare('SELECT count(*) count FROM job_email_send_receipt_correlations_v2').get().count, 0);
  } finally {
    db.close();
  }
});

test('email correlate CLI is genuinely read-only: no chmod, migration, WAL, or source-store writes', (t) => {
  const fixture = createStore(t);
  addApplication(fixture.home, 'Acme', 'Platform Engineer');
  const factsPath = path.join(fixture.root, 'facts.json');
  fs.writeFileSync(factsPath, JSON.stringify(makeFacts({ company: { name: 'Acme', domain: 'acme.example' }, postingRefs: [] })));
  const dbPath = path.join(fixture.home, 'jobtrack.db');
  const db = new Database(dbPath);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  fs.chmodSync(dbPath, 0o444);
  const before = fs.statSync(dbPath);
  const inheritedDb = process.env.JOBTRACK_DB;
  const unrelatedDb = path.join(fixture.root, 'unrelated-store', 'jobtrack.db');
  let result;
  try {
    // Correlation honors JOBTRACK_DB before JOBTRACK_HOME. Even with an
    // inherited override, fixture CLI helpers must use only this test's copy.
    process.env.JOBTRACK_DB = unrelatedDb;
    result = runCli(fixture.home, ['email', 'correlate', '--input', factsPath]);
    assert.equal(fs.existsSync(path.dirname(unrelatedDb)), false);
  } finally {
    if (inheritedDb === undefined) delete process.env.JOBTRACK_DB;
    else process.env.JOBTRACK_DB = inheritedDb;
  }
  const after = fs.statSync(dbPath);
  assert.equal(result.schemaVersion, 'jobtrack-correlation-result.v1');
  assert.equal(after.mode & 0o777, 0o444);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(fs.existsSync(`${dbPath}-wal`), false);
  assert.equal(fs.existsSync(`${dbPath}-shm`), false);
  fs.chmodSync(dbPath, 0o600);
});

test('read-only correlation includes committed WAL frames without changing source sidecars', (t) => {
  const fixture = createStore(t);
  const dbPath = path.join(fixture.home, 'jobtrack.db');
  const writer = new Database(dbPath);
  writer.pragma('journal_mode = WAL');
  writer.pragma('wal_autocheckpoint = 0');
  const inserted = writer.prepare(`
    INSERT INTO applications(company,role,status,applied_date,workflow_stage)
    VALUES ('WAL Corp','Snapshot Engineer','applied','2026-07-17','submitted')
  `).run();
  const factsPath = path.join(fixture.root, 'wal-facts.json');
  fs.writeFileSync(factsPath, JSON.stringify(makeFacts({
    company: { name: 'WAL Corp', domain: 'wal.example' },
    postingRefs: []
  })));
  const walPath = `${dbPath}-wal`;
  assert.equal(fs.existsSync(walPath), true);
  const beforeDatabase = fileFingerprint(dbPath);
  const beforeWal = fileFingerprint(walPath);
  try {
    const result = runCli(fixture.home, ['email', 'correlate', '--input', factsPath]);
    assert.equal(result.resolution, 'ambiguous');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].applicationId, Number(inserted.lastInsertRowid));
    assert.equal(fileFingerprint(dbPath), beforeDatabase);
    assert.equal(fileFingerprint(walPath), beforeWal);
  } finally {
    writer.close();
  }
});

function prepareTransition(db, input) {
  const facts = makeFacts({
    source: { messageId: `message-${input.suffix}`, threadId: `thread-${input.suffix}` },
    postingRefs: [{ url: input.normalized.primaryUrl, roleTitle: 'Platform Engineer' }],
    contentCompleteness: 'sanitized_plain_text',
    security: { risk: 'low', requiresReview: false },
    ...input.factsOverrides
  });
  const correlation = correlateEmailReadOnly(db, facts);
  assert.equal(correlation.resolution, 'linked');
  importFacts(db, facts, `facts:${input.suffix}`);
  const recorded = recordCorrelation(db, correlation, `correlation:${input.suffix}`);
  const proposal = makeTransitionProposal({
    facts,
    correlation,
    proposalId: `proposal-${input.suffix}`,
    action: input.action
  });
  proposeTransition(db, proposal, `proposal:${input.suffix}`);
  return { facts, correlation, proposal, recorded };
}

function approve(db, prepared, suffix) {
  return reviewTransition(db, {
    proposalId: prepared.proposal.proposalId,
    decision: 'approved',
    decidedBy: 'Cole',
    idempotencyKey: `review:${suffix}`
  });
}

function applyPrepared(db, prepared, suffix) {
  return applyTransition(db, {
    proposalId: prepared.proposal.proposalId,
    expectedApplicationVersion: String(prepared.proposal.expectedApplicationVersion),
    appliedBy: 'executor:test',
    idempotencyKey: `apply:${suffix}`
  });
}

function makeTransitionProposal({ facts, correlation, proposalId, action }) {
  const resolved = correlation.resolved;
  const target = { applicationId: resolved.applicationId };
  for (const key of ['companyId', 'openingId', 'postingId', 'postingOccurrenceId', 'interviewId']) {
    if (resolved[key] !== undefined) target[key] = resolved[key];
  }
  const policyCandidate = action.kind === 'link_message'
    ? 'exact_link'
    : action.kind === 'transition_application_status'
      ? 'exact_status'
      : ['create_interview', 'reschedule_interview', 'cancel_interview'].includes(action.kind)
        ? 'exact_interview'
        : 'never';
  return validateTransitionProposal({
    schemaVersion: 'jobtrack-transition-proposal.v1',
    proposalId,
    source: correlation.source,
    factsDigest: correlation.factsDigest,
    correlationDigest: digest(correlation),
    target,
    expectedApplicationVersion: resolved.applicationVersion,
    correlation: {
      resolution: 'linked',
      matchBasis: resolved.matchBasis,
      confidence: resolved.confidence
    },
    safety: {
      contentCompleteness: facts.contentCompleteness,
      securityRisk: facts.security.risk,
      sourceRequiresReview: facts.security.requiresReview
    },
    action,
    policyCandidate,
    requiresReview: true,
    automationEligible: false,
    evidence: [`Derived from ${facts.source.messageId}`]
  });
}

function linkedCorrelationStub(facts) {
  const candidate = {
    applicationId: 1,
    applicationVersion: 0,
    openingId: 1,
    postingId: 1,
    postingOccurrenceId: 1,
    matchBasis: 'exact_posting_occurrence',
    confidence: 1,
    reasons: ['fixture']
  };
  return {
    schemaVersion: 'jobtrack-correlation-result.v1',
    source: {
      provider: facts.source.provider,
      accountId: facts.source.accountId,
      messageId: facts.source.messageId,
      threadId: facts.source.threadId
    },
    factsDigest: digest(facts),
    resolution: 'linked',
    resolved: candidate,
    candidates: [candidate],
    evidence: [{ kind: 'fixture', value: 'fixture' }],
    automaticEligible: true
  };
}

function makeFacts(overrides = {}) {
  const sourceOverrides = overrides.source || {};
  const facts = {
    schemaVersion: 'job-application-email-facts.v1',
    trust: 'untrusted_external',
    source: {
      provider: 'fixture',
      accountId: 'cole@example.test',
      messageId: 'message-1',
      threadId: 'thread-1',
      receivedAt: '2026-07-17T18:00:00.000Z',
      fromAddress: 'jobs@acme.example',
      fromDomain: 'acme.example',
      contentDigest: sha256('sanitized source content'),
      ...sourceOverrides
    },
    contentCompleteness: 'sanitized_plain_text',
    eventKind: 'application_received',
    company: { name: 'Acme', domain: 'acme.example' },
    postingRefs: [{ roleTitle: 'Platform Engineer' }],
    applicationRefs: [],
    replyRequested: false,
    evidence: [{ field: 'subject', excerpt: 'Application update' }],
    extraction: { provider: 'fixture', version: '1', confidence: 0.95 },
    security: { risk: 'low', requiresReview: false },
    ...overrides,
    source: {
      provider: 'fixture',
      accountId: 'cole@example.test',
      messageId: 'message-1',
      threadId: 'thread-1',
      receivedAt: '2026-07-17T18:00:00.000Z',
      fromAddress: 'jobs@acme.example',
      fromDomain: 'acme.example',
      contentDigest: sha256('sanitized source content'),
      ...sourceOverrides
    }
  };
  return validateJobApplicationEmailFacts(facts);
}

function makeAppleMailFacts(overrides = {}) {
  const sourceOverrides = overrides.source || {};
  const facts = {
    schemaVersion: 'job-application-email-facts.v2',
    trust: 'untrusted_external',
    source: {
      provider: 'apple_mail_emlx',
      accountId: 'jobs@example.test',
      messageId: 'apple-message-1',
      threadId: 'apple-thread-1',
      receivedAt: '2026-07-22T18:00:00.000Z',
      fromAddress: 'recruiter@acme.example',
      fromDomain: 'acme.example',
      contentDigest: sha256('sanitized Apple Mail source content'),
      ...sourceOverrides
    },
    contentCompleteness: 'sanitized_plain_text',
    eventKind: 'application_received',
    company: { name: 'Acme', domain: 'acme.example' },
    postingRefs: [],
    applicationRefs: [],
    replyRequested: false,
    evidence: [{ field: 'subject', excerpt: 'Application communication' }],
    extraction: { provider: 'inbox-pipeline', version: 'jobtrack-relay.v3', confidence: 0.87 },
    security: { risk: 'medium', requiresReview: true },
    ...overrides,
    source: {
      provider: 'apple_mail_emlx',
      accountId: 'jobs@example.test',
      messageId: 'apple-message-1',
      threadId: 'apple-thread-1',
      receivedAt: '2026-07-22T18:00:00.000Z',
      fromAddress: 'recruiter@acme.example',
      fromDomain: 'acme.example',
      contentDigest: sha256('sanitized Apple Mail source content'),
      ...sourceOverrides
    }
  };
  return validateJobApplicationEmailFacts(facts);
}

function addNormalizedOpening(db, applicationId) {
  const application = db.prepare('SELECT job_opening_id FROM applications WHERE id=?').get(applicationId);
  assert.ok(application?.job_opening_id, 'CLI-created applications must already have a normalized opening');
  const openingId = application.job_opening_id;
  const companyId = db.prepare('SELECT company_id FROM job_openings WHERE id=?').get(openingId).company_id;
  const directPlatformId = db.prepare("SELECT id FROM posting_platforms WHERE slug='direct'").get().id;
  const linkedInPlatformId = db.prepare("SELECT id FROM posting_platforms WHERE slug='linkedin'").get().id;
  const directVenueId = nextId(db, 'posting_venues');
  const linkedInVenueId = directVenueId + 1;
  const primaryPostingId = nextId(db, 'job_postings');
  const secondaryPostingId = primaryPostingId + 1;
  const primaryUrl = `https://jobs.acme.example/openings/${openingId}`;
  const secondaryUrl = `https://linkedin.example/jobs/${openingId}`;
  db.prepare('INSERT INTO posting_venues(id,posting_platform_id,company_id,venue_key,label) VALUES (?,?,?,?,?)')
    .run(directVenueId, directPlatformId, companyId, `acme-${openingId}`, 'Acme careers');
  db.prepare('INSERT INTO posting_venues(id,posting_platform_id,company_id,venue_key,label) VALUES (?,?,?,?,?)')
    .run(linkedInVenueId, linkedInPlatformId, companyId, `acme-linkedin-${openingId}`, 'Acme on LinkedIn');
  db.prepare(`
    INSERT INTO job_postings(id,job_opening_id,posting_venue_id,canonical_url,canonical_url_sha256,external_id)
    VALUES (?,?,?,?,?,?)
  `).run(primaryPostingId, openingId, directVenueId, primaryUrl, sha256(primaryUrl), `acme-${openingId}`);
  db.prepare(`
    INSERT INTO job_postings(id,job_opening_id,posting_venue_id,canonical_url,canonical_url_sha256,external_id)
    VALUES (?,?,?,?,?,?)
  `).run(secondaryPostingId, openingId, linkedInVenueId, secondaryUrl, sha256(secondaryUrl), `linkedin-${openingId}`);
  db.prepare('UPDATE application_postings SET is_primary=0 WHERE application_id=?').run(applicationId);
  db.prepare('INSERT INTO application_postings(application_id,job_posting_id,relation,is_primary) VALUES (?,?,?,1)')
    .run(applicationId, primaryPostingId, 'submitted_via');
  db.prepare('INSERT INTO application_postings(application_id,job_posting_id,relation,is_primary) VALUES (?,?,?,0)')
    .run(applicationId, secondaryPostingId, 'alternate');
  db.prepare('UPDATE applications SET job_opening_id=?,primary_job_posting_id=? WHERE id=?').run(openingId, primaryPostingId, applicationId);
  return { companyId, openingId, primaryPostingId, secondaryPostingId, primaryUrl, secondaryUrl };
}

function createStore(t) {
  const { root: rootDir, home } = require('../test-support/migrated-store').createTestStore('jobtrack-email-');
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return {
    root: rootDir,
    home,
    open() {
      const db = new Database(path.join(home, 'jobtrack.db'));
      db.pragma('foreign_keys = ON');
      return db;
    }
  };
}

function addApplication(home, company, role, status = 'applied') {
  return runCli(home, ['add-application', '--company', company, '--role', role, '--status', status]).application.id;
}

function runCli(home, args) {
  const output = execFileSync(process.execPath, [cli, ...args, '--json'], {
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8'
  });
  return JSON.parse(output);
}

function runCliFailure(home, args) {
  return spawnSync(process.execPath, [cli, ...args, '--json'], {
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8'
  });
}

function writeJson(directory, filename, value) {
  const filePath = path.join(directory, filename);
  fs.writeFileSync(filePath, JSON.stringify(value));
  return filePath;
}

function operationExists(db, key) {
  return Boolean(db.prepare('SELECT 1 FROM job_email_operations WHERE idempotency_key=?').get(key));
}

function nextId(db, table) {
  return db.prepare(`SELECT COALESCE(MAX(id),0)+1 id FROM ${table}`).get().id;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileFingerprint(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
