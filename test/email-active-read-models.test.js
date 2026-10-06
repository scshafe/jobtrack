'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { buildApplicationStrategyContext } = require('../lib/application-strategy');
const {
  readApplicationOutgoingSummary,
  readOutgoingLifecycleV2
} = require('../lib/web/read-model/communications');
const { makeStore, seedDraft } = require('../test-support/outgoing-live-seed');

const EMPTY_SELECTORS = Object.freeze({
  artifactIds: [],
  snapshotIds: [],
  materialRevisionIds: [],
  emailMessageRefIds: [],
  interviewIds: [],
  profileEntryIds: [],
  storyUseIds: []
});

test('outgoing projections stop attributing a message after its application link is retracted', (t) => {
  const fixture = linkedFixture(t, 'active-outgoing-read-model');

  const beforeGlobal = readOutgoingLifecycleV2(fixture.db);
  assert.equal(beforeGlobal.lifecycle.length, 1);
  assert.equal(beforeGlobal.lifecycle[0].application.id, 1);
  assert.equal(readApplicationOutgoingSummary(fixture.db, 1).proposals.length, 1);

  retract(fixture);

  const afterGlobal = readOutgoingLifecycleV2(fixture.db);
  assert.equal(afterGlobal.lifecycle.length, 1);
  assert.equal(afterGlobal.lifecycle[0].application, null);
  assert.equal(readApplicationOutgoingSummary(fixture.db, 1).proposals.length, 0);
});

test('strategy email summary excludes pending transitions backed by a retracted correlation', (t) => {
  const fixture = linkedFixture(t, 'active-strategy-read-model');
  fixture.db.prepare(`
    INSERT INTO job_email_transition_proposals(
      proposal_id,message_ref_id,correlation_id,application_id,action_kind,
      expected_application_version,automation_eligible,requires_review,proposal_json,proposal_digest
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    'active-strategy-transition',
    fixture.messageRefId,
    fixture.correlationId,
    1,
    'link_message',
    0,
    0,
    1,
    '{}',
    'c'.repeat(64)
  );

  const before = buildApplicationStrategyContext(fixture.db, 1, EMPTY_SELECTORS);
  assert.deepEqual(before.domainState.email, {
    messageCount: 1,
    pendingTransitionCount: 1,
    pendingReplyCount: 0
  });

  retract(fixture);

  const after = buildApplicationStrategyContext(fixture.db, 1, EMPTY_SELECTORS);
  assert.deepEqual(after.domainState.email, {
    messageCount: 0,
    pendingTransitionCount: 0,
    pendingReplyCount: 0
  });
});

function linkedFixture(t, seed) {
  const fixture = makeStore();
  t.after(() => {
    fixture.db.close();
    fs.rmSync(fixture.home, { recursive: true, force: true });
  });
  const proposalId = seedDraft(fixture.home, fixture.db, seed);
  const message = fixture.db.prepare(`
    SELECT ref.id,ref.facts_digest
    FROM job_email_outgoing_proposals_v3 proposal
    JOIN job_email_message_refs ref ON ref.id=proposal.message_ref_id
    WHERE proposal.proposal_id=?
  `).get(proposalId);
  const correlationId = Number(fixture.db.prepare(`
    INSERT INTO job_email_correlations(
      message_ref_id,facts_digest,resolution,resolved_application_id,correlation_json,correlation_digest
    ) VALUES (?,?,?,?,?,?)
  `).run(message.id, message.facts_digest, 'linked', 1, '{}', 'a'.repeat(64)).lastInsertRowid);
  fixture.db.prepare(`
    INSERT INTO job_email_application_links(message_ref_id,application_id,relation,proposal_id)
    VALUES (?,?,?,NULL)
  `).run(message.id, 1, 'reviewed-test-link');
  return { ...fixture, messageRefId: message.id, correlationId };
}

function retract(fixture) {
  fixture.db.prepare(`
    INSERT INTO email_link_retractions(message_ref_id,application_id,actor,reason)
    VALUES (?,?,?,?)
  `).run(fixture.messageRefId, 1, 'test-operator', 'wrong application');
}
