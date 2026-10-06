'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createTestStore } = require('../test-support/migrated-store');

const {
  demeanorObservationJsonSchema,
  recipientStyleProfileJsonSchema,
  writingVoiceRevisionJsonSchema,
  toneDecisionJsonSchema,
  replyDraftV2JsonSchema,
  validateJobApplicationEmailFacts,
  validateDemeanorObservation,
  validateRecipientStyleProfile,
  validateWritingVoiceRevision,
  validateReplyDraftProposal,
  digest
} = require('../lib/email-contracts');
const {
  EMAIL_COMMUNICATION_MIGRATION_NAME,
  EMAIL_COMMUNICATION_SCHEMA_VERSION,
  EMAIL_COMMUNICATION_USER_VERSION,
  migrateEmailCommunication,
  importDemeanorObservation,
  recordContactBinding,
  recordCompanyContact,
  buildEmailCommunicationContext,
  createStyleProfile,
  reviewStyleProfile,
  selectStyleProfile,
  createWritingVoiceRevision,
  reviewWritingVoiceRevision,
  selectWritingVoiceRevision,
  createToneDecision
} = require('../lib/email-communication');
const {
  STYLE_PROFILE_FRESHNESS_HORIZON_DAYS,
  TONE_POLICY,
  aggregateStyleObservations,
  evaluateStyleProfileFreshness,
  resolveRegisterAdaptation
} = require('../lib/email-style-policy');
const {
  correlateEmailReadOnly,
  importFacts,
  proposeReplyDraft,
  recordCorrelation,
  reviewReplyDraft
} = require('../lib/email-integration');
const emailLearning = require('../lib/email-correlation/learn');
const { readCorrelationMetrics } = require('../lib/email-correlation/metrics');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('communication contracts are strict, bounded, and prohibit trait or personality inference', () => {
  for (const schema of [
    demeanorObservationJsonSchema,
    recipientStyleProfileJsonSchema,
    writingVoiceRevisionJsonSchema,
    toneDecisionJsonSchema,
    replyDraftV2JsonSchema
  ]) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.match(schema.$id, /jobtrack\.local\/contracts/);
    assert.equal(schema.additionalProperties, false);
  }

  const facts = makeFacts();
  const observation = makeObservation(facts, 'observation-contract');
  assert.equal(validateDemeanorObservation(observation).profileEligible, true);
  const aggregationObservation = { ...observation, receivedAt: facts.source.receivedAt };
  assert.throws(
    () => aggregateStyleObservations([aggregationObservation, aggregationObservation]),
    /at most one observation per source message/i
  );
  assert.throws(
    () => validateDemeanorObservation({ ...observation, personalityProfile: { agreeableness: 'high' } }),
    /unknown field/i
  );
  assert.throws(() => validateDemeanorObservation({ ...observation, evidence: [] }), /at least one item/i);
  assert.throws(
    () => validateDemeanorObservation({
      ...observation,
      security: { ...observation.security, sensitiveTraitInferenceDetected: true },
      profileEligible: true
    }),
    /fail closed/i
  );
  assert.throws(
    () => validateDemeanorObservation({
      ...observation,
      security: { ...observation.security, personalityInferenceDetected: true },
      profileEligible: true
    }),
    /fail closed/i
  );

  const voice = makeVoice();
  assert.equal(validateWritingVoiceRevision(voice).ownership.owner, 'Cole');
  assert.equal(
    resolveRegisterAdaptation({ voice, recipientProfile: null, purpose: 'other' }).delivery.exclamationPolicy,
    'at_most_one',
    'absence of recipient evidence must preserve the reviewed Cole baseline'
  );
  const lowConfidenceProfile = {
    dimensions: {
      formality: 'formal',
      warmth: 'reserved',
      energy: 'restrained',
      directness: 'direct',
      verbosity: 'terse'
    },
    delivery: { ...profileDelivery(), exclamationPolicy: 'none' },
    confidence: 'low'
  };
  assert.deepEqual(
    resolveRegisterAdaptation({ voice, recipientProfile: lowConfidenceProfile, purpose: 'other' }).dimensions,
    voice.dimensions,
    'low-confidence recipient evidence must not shift the Cole baseline'
  );
  assert.throws(
    () => validateWritingVoiceRevision({
      ...voice,
      ownership: { ...voice.ownership, owner: 'Recipient' }
    }),
    /must equal "Cole"/i
  );

  const undersampledContactProfile = {
    schemaVersion: 'email-recipient-style-profile.v1',
    profileId: 'undersampled-contact',
    source: messageRef(facts),
    scope: { kind: 'contact', contactId: 1 },
    version: 1,
    observationIds: ['observation-1', 'observation-2'],
    dimensions: warmDimensions(),
    delivery: profileDelivery(),
    confidence: 'low',
    sample: {
      eligibleMessageCount: 2,
      distinctThreadCount: 2,
      firstObservedAt: '2026-07-17T18:00:00.000Z',
      lastObservedAt: '2026-07-18T18:00:00.000Z'
    },
    safeguards: safeguards(),
    generatedBy: styleGenerator(),
    sourceStateSha256: sha256('source state'),
    requiresReview: true
  };
  assert.throws(() => validateRecipientStyleProfile(undersampledContactProfile), /at least three eligible messages/i);

  const invalidReply = {
    ...makeReplyV2({ facts, toneDecision: fakeToneBinding(), body: 'Thank you.' }),
    distinctivePhraseReuse: true
  };
  assert.throws(() => validateReplyDraftProposal(invalidReply), /must equal false/i);

  const lastObservedAt = '2025-01-03T18:00:00.000Z';
  const expirationMilliseconds = Date.parse(lastObservedAt)
    + STYLE_PROFILE_FRESHNESS_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  const justBeforeExpiration = evaluateStyleProfileFreshness(
    { sample: { lastObservedAt } },
    new Date(expirationMilliseconds - 1)
  );
  const atExpiration = evaluateStyleProfileFreshness(
    { sample: { lastObservedAt } },
    new Date(expirationMilliseconds)
  );
  assert.equal(justBeforeExpiration.horizonDays, 180);
  assert.equal(justBeforeExpiration.isStale, false);
  assert.equal(atExpiration.isStale, true);
  assert.equal(atExpiration.staleReason, 'time_horizon_elapsed');
  assert.equal(atExpiration.expiresAt, new Date(expirationMilliseconds).toISOString());
});

test('migration is replay-safe and projects provider/account-scoped first-class threads', (t) => {
  // Initial migration plus replay is the behavior under test here.
  const fixture = createStore(t, { cold: true });
  const db = fixture.open();
  try {
    assert.equal(
      db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
        .get(EMAIL_COMMUNICATION_SCHEMA_VERSION).name,
      EMAIL_COMMUNICATION_MIGRATION_NAME
    );
    assert.equal(db.pragma('user_version', { simple: true }), EMAIL_COMMUNICATION_USER_VERSION);

    const first = makeFacts({ source: { messageId: 'thread-message-1', threadId: 'shared-thread' } });
    const second = makeFacts({
      source: {
        messageId: 'thread-message-2',
        threadId: 'shared-thread',
        receivedAt: '2026-07-17T19:00:00.000Z',
        contentDigest: sha256('thread message 2')
      }
    });
    const otherAccount = makeFacts({
      source: {
        accountId: 'other@example.test',
        messageId: 'thread-message-3',
        threadId: 'shared-thread',
        receivedAt: '2026-07-17T20:00:00.000Z',
        contentDigest: sha256('thread message 3')
      }
    });
    importFacts(db, first, 'facts:thread:1');
    importFacts(db, second, 'facts:thread:2');
    importFacts(db, otherAccount, 'facts:thread:3');

    assert.equal(db.prepare('SELECT count(*) count FROM job_email_threads').get().count, 2);
    assert.deepEqual(
      db.prepare(`
        SELECT t.account_id accountId,count(tm.message_ref_id) messageCount
        FROM job_email_threads t JOIN job_email_thread_messages tm ON tm.thread_ref_id=t.id
        GROUP BY t.id ORDER BY t.account_id
      `).all(),
      [
        { accountId: 'cole@example.test', messageCount: 2 },
        { accountId: 'other@example.test', messageCount: 1 }
      ]
    );

    const metadataOnly = makeFacts({
      contentCompleteness: 'metadata_only',
      source: {
        messageId: 'metadata-only-message',
        threadId: 'metadata-only-thread',
        contentDigest: sha256('metadata only message')
      }
    });
    importFacts(db, metadataOnly, 'facts:metadata-only');
    assert.throws(
      () => importDemeanorObservation(
        db,
        makeObservation(metadataOnly, 'metadata-only-observation'),
        'observation:metadata-only'
      ),
      (error) => error.code === 'OBSERVATION_INELIGIBLE'
    );
    assert.equal(
      db.prepare("SELECT count(*) count FROM job_email_demeanor_observations WHERE observation_id='metadata-only-observation'").get().count,
      0
    );

    const cliContext = runCli(fixture.home, [
      'email', 'communication-context',
      '--provider', 'fixture',
      '--account-id', first.source.accountId,
      '--message-id', first.source.messageId,
      '--thread-id', first.source.threadId
    ]);
    assert.equal(cliContext.context.mode, 'source-catalog');
    assert.equal(cliContext.context.thread.threadId, 'shared-thread');

    const before = db.prepare('SELECT count(*) count FROM job_email_thread_messages').get().count;
    migrateEmailCommunication(db);
    migrateEmailCommunication(db);
    assert.equal(db.prepare('SELECT count(*) count FROM job_email_thread_messages').get().count, before);
    assert.throws(
      () => db.prepare("UPDATE job_email_threads SET thread_id='changed' WHERE id=1").run(),
      /append-only/i
    );
  } finally {
    db.close();
  }
});

test('thread register, Cole voice, tone decision, and reviewed reply bind end to end without send authority', (t) => {
  const fixture = createStore(t);
  const db = fixture.open();
  try {
    const facts = [0, 1, 2].map((index) => makeFacts({
      source: {
        messageId: `warm-thread-message-${index + 1}`,
        threadId: 'warm-thread',
        receivedAt: `2026-07-1${7 + index}T18:00:00.000Z`,
        replyToAddress: 'recruiter@acme.example',
        contentDigest: sha256(`warm thread message ${index + 1}`)
      },
      replyRequested: true
    }));
    facts.forEach((entry, index) => importFacts(db, entry, `facts:warm:${index + 1}`));

    const observations = facts.map((entry, index) => makeObservation(entry, `warm-observation-${index + 1}`));
    observations.forEach((entry, index) => importDemeanorObservation(db, entry, `observation:warm:${index + 1}`));

    const catalog = buildEmailCommunicationContext(db, { source: messageRef(facts[2]) });
    assert.equal(catalog.mode, 'source-catalog');
    assert.equal(catalog.sourceStateSha256, null);
    assert.equal(catalog.availableSources.threadObservations.length, 3);
    assert.equal(JSON.stringify(catalog).includes('Application update'), false, 'catalog must not expose copied email evidence');

    const observationIds = observations.map((entry) => entry.observationId);
    const selectedContext = buildEmailCommunicationContext(db, {
      source: messageRef(facts[2]),
      observationIds
    });
    assert.equal(selectedContext.mode, 'selected-generation');
    assert.match(selectedContext.sourceStateSha256, /^[a-f0-9]{64}$/);
    const aggregate = aggregateStyleObservations(selectedContext.observations);
    assert.equal(aggregate.confidence, 'medium');
    assert.equal(aggregate.delivery.exclamationPolicy, 'at_most_one');

    const cherryPickedContext = buildEmailCommunicationContext(db, {
      source: messageRef(facts[2]),
      observationIds: [observations[2].observationId]
    });
    const cherryPickedProfile = {
      schemaVersion: 'email-recipient-style-profile.v1',
      profileId: 'warm-thread-profile-cherry-picked',
      source: messageRef(facts[2]),
      scope: {
        kind: 'thread',
        provider: facts[2].source.provider,
        accountId: facts[2].source.accountId,
        threadId: facts[2].source.threadId
      },
      version: 1,
      observationIds: [observations[2].observationId],
      ...aggregateStyleObservations(cherryPickedContext.observations),
      generatedBy: styleGenerator(),
      sourceStateSha256: cherryPickedContext.sourceStateSha256,
      requiresReview: true
    };
    assert.throws(
      () => createStyleProfile(db, cherryPickedProfile, 'profile:warm:cherry-picked'),
      (error) => error.code === 'STYLE_PROFILE_SOURCE_WINDOW_MISMATCH'
    );

    const profile = {
      schemaVersion: 'email-recipient-style-profile.v1',
      profileId: 'warm-thread-profile-v1',
      source: messageRef(facts[2]),
      scope: {
        kind: 'thread',
        provider: facts[2].source.provider,
        accountId: facts[2].source.accountId,
        threadId: facts[2].source.threadId
      },
      version: 1,
      observationIds,
      ...aggregate,
      generatedBy: styleGenerator(),
      sourceStateSha256: selectedContext.sourceStateSha256,
      requiresReview: true
    };
    assert.throws(
      () => createStyleProfile(db, { ...profile, sourceStateSha256: sha256('stale') }, 'profile:stale'),
      (error) => error.code === 'SOURCE_STATE_STALE'
    );
    createStyleProfile(db, profile, 'profile:warm:v1');
    const warmThreadId = db.prepare(`
      SELECT id FROM job_email_threads WHERE provider=? AND account_id=? AND thread_id=?
    `).get(facts[2].source.provider, facts[2].source.accountId, facts[2].source.threadId).id;
    assert.throws(
      () => db.prepare(`
        INSERT INTO job_email_style_profile_selections(
          scope_kind,scope_key,profile_id,lock_version,selected_by,selected_at
        ) VALUES ('thread',?,?,0,'bypass','2026-07-18T12:00:00.000Z')
      `).run(String(warmThreadId), profile.profileId),
      /approval mismatch/i
    );
    assert.throws(
      () => selectStyleProfile(db, {
        profileId: profile.profileId,
        selectedBy: 'Cole',
        expectedCurrentProfileId: null,
        idempotencyKey: 'profile:select:too-early'
      }),
      (error) => error.code === 'APPROVAL_REQUIRED'
    );
    reviewStyleProfile(db, {
      profileId: profile.profileId,
      decision: 'approved',
      reviewedBy: 'Cole',
      notes: 'Observed register only; no identity inference.',
      idempotencyKey: 'profile:review:warm:v1'
    });
    selectStyleProfile(db, {
      profileId: profile.profileId,
      selectedBy: 'Cole',
      expectedCurrentProfileId: null,
      idempotencyKey: 'profile:select:warm:v1'
    });
    assert.throws(
      () => db.prepare(`
        UPDATE job_email_style_profile_selections SET scope_key='999'
        WHERE profile_id=?
      `).run(profile.profileId),
      /selection scope or approval mismatch/i
    );

    const voice = makeVoice();
    createWritingVoiceRevision(db, voice, 'voice:cole-professional:v1');
    const voiceId = db.prepare('SELECT id FROM profile_email_writing_voices WHERE voice_key=?').get(voice.voiceKey).id;
    assert.throws(
      () => db.prepare(`
        INSERT INTO profile_email_writing_voice_current(
          voice_id,revision_id,lock_version,selected_by,selected_at
        ) VALUES (?,?,0,'bypass','2026-07-18T12:00:00.000Z')
      `).run(voiceId, voice.revisionId),
      /approval mismatch/i
    );
    assert.throws(
      () => selectWritingVoiceRevision(db, {
        revisionId: voice.revisionId,
        selectedBy: 'Cole',
        expectedCurrentRevisionId: null,
        idempotencyKey: 'voice:select:too-early'
      }),
      (error) => error.code === 'APPROVAL_REQUIRED'
    );
    reviewWritingVoiceRevision(db, {
      revisionId: voice.revisionId,
      decision: 'approved',
      reviewedBy: 'Cole',
      notes: 'Approved Cole-owned baseline.',
      idempotencyKey: 'voice:review:cole-professional:v1'
    });
    selectWritingVoiceRevision(db, {
      revisionId: voice.revisionId,
      selectedBy: 'Cole',
      expectedCurrentRevisionId: null,
      idempotencyKey: 'voice:select:cole-professional:v1'
    });

    const toneContext = buildEmailCommunicationContext(db, {
      source: messageRef(facts[2]),
      styleProfileId: profile.profileId,
      voiceRevisionId: voice.revisionId
    });
    const selectedTone = resolveRegisterAdaptation({
      voice: toneContext.writingVoice,
      recipientProfile: toneContext.styleProfile,
      purpose: 'scheduling'
    });
    const tone = {
      schemaVersion: 'email-tone-decision.v1',
      decisionId: 'warm-scheduling-tone-v1',
      source: messageRef(facts[2]),
      factsDigest: digest(facts[2]),
      purpose: 'scheduling',
      styleProfileId: profile.profileId,
      styleProfileDigest: toneContext.styleProfile.profileDigest,
      voiceRevisionId: voice.revisionId,
      voiceRevisionDigest: toneContext.writingVoice.revisionDigest,
      selected: selectedTone,
      policy: { ...TONE_POLICY, maxBandShift: voice.delivery.maxBandShift },
      rationaleCodes: ['cole_voice_baseline', 'thread_register', 'scheduling_clarity', 'identity_mimicry_guard'],
      generatedBy: styleGenerator(),
      sourceStateSha256: toneContext.sourceStateSha256,
      requiresReview: true
    };
    assert.throws(
      () => createToneDecision(db, {
        ...tone,
        decisionId: 'warm-scheduling-tone-missing-rationale',
        rationaleCodes: ['cole_voice_baseline', 'thread_register', 'identity_mimicry_guard']
      }, 'tone:warm-scheduling:missing-rationale'),
      (error) => error.code === 'TONE_RATIONALE_MISMATCH'
    );
    const toneResult = createToneDecision(db, tone, 'tone:warm-scheduling:v1');
    assert.match(toneResult.decisionDigest, /^[a-f0-9]{64}$/);
    assert.equal(selectedTone.delivery.emojiPolicy, 'none');
    assert.equal(selectedTone.delivery.exclamationPolicy, 'at_most_one');

    const offerFacts = makeFacts({
      eventKind: 'offer',
      requestedAction: { kind: 'review_offer' },
      source: {
        messageId: 'offer-message',
        threadId: 'offer-thread',
        receivedAt: '2026-07-20T18:00:00.000Z',
        replyToAddress: 'recruiter@acme.example',
        contentDigest: sha256('offer message')
      }
    });
    importFacts(db, offerFacts, 'facts:offer');
    const offerContext = buildEmailCommunicationContext(db, {
      source: messageRef(offerFacts),
      voiceRevisionId: voice.revisionId
    });
    const conservativeTone = resolveRegisterAdaptation({
      voice: offerContext.writingVoice,
      purpose: 'other',
      conservative: true
    });
    assert.equal(conservativeTone.delivery.exclamationPolicy, 'none');
    assert.equal(conservativeTone.delivery.emojiPolicy, 'none');
    assert.equal(conservativeTone.delivery.contractions, 'avoid');
    const offerTone = {
      schemaVersion: 'email-tone-decision.v1',
      decisionId: 'offer-tone-v1',
      source: messageRef(offerFacts),
      factsDigest: digest(offerFacts),
      purpose: 'other',
      voiceRevisionId: voice.revisionId,
      voiceRevisionDigest: offerContext.writingVoice.revisionDigest,
      selected: conservativeTone,
      policy: { ...TONE_POLICY, maxBandShift: voice.delivery.maxBandShift },
      rationaleCodes: [
        'cole_voice_baseline', 'low_confidence_fallback', 'conservative_context', 'identity_mimicry_guard'
      ],
      generatedBy: styleGenerator(),
      sourceStateSha256: offerContext.sourceStateSha256,
      requiresReview: true
    };
    assert.throws(
      () => createToneDecision(db, {
        ...offerTone,
        decisionId: 'offer-tone-missing-conservative-rationale',
        rationaleCodes: ['cole_voice_baseline', 'low_confidence_fallback', 'identity_mimicry_guard']
      }, 'tone:offer:missing-conservative-rationale'),
      (error) => error.code === 'TONE_RATIONALE_MISMATCH'
    );
    createToneDecision(db, offerTone, 'tone:offer:v1');

    const body = 'Hi Taylor,\n\nIt is nice to meet you! Tuesday at 2:00 PM works for me.\n\nBest,\nCole';
    const reply = makeReplyV2({
      facts: facts[2],
      toneDecision: {
        decisionId: tone.decisionId,
        decisionDigest: toneResult.decisionDigest,
        styleProfileId: profile.profileId,
        styleProfileDigest: tone.styleProfileDigest,
        voiceRevisionId: voice.revisionId,
        voiceRevisionDigest: tone.voiceRevisionDigest,
        sourceStateSha256: tone.sourceStateSha256
      },
      body
    });
    const replyResult = proposeReplyDraft(db, reply, 'reply:warm-scheduling:v1');
    assert.deepEqual(replyResult.styleBinding, {
      toneDecisionId: tone.decisionId,
      styleProfileId: profile.profileId,
      voiceRevisionId: voice.revisionId,
      sourceStateSha256: tone.sourceStateSha256
    });
    assert.equal(replyResult.autoSendEnabled, false);
    assert.equal(db.prepare('SELECT auto_send_eligible value FROM job_email_reply_draft_proposals WHERE proposal_id=?').get(reply.proposalId).value, 0);

    reviewReplyDraft(db, {
      proposalId: reply.proposalId,
      decision: 'approved',
      decidedBy: 'Cole',
      notes: 'Recipient and tone reviewed.',
      idempotencyKey: 'reply:review:warm-scheduling:v1'
    });
    assert.equal(
      db.prepare('SELECT event_kind FROM job_email_reply_draft_events WHERE proposal_id=? ORDER BY id DESC LIMIT 1')
        .get(reply.proposalId).event_kind,
      'approved'
    );
    assert.throws(
      () => db.prepare('UPDATE job_email_reply_draft_style_bindings SET tone_decision_id=tone_decision_id WHERE proposal_id=?').run(reply.proposalId),
      /append-only/i
    );

    const overAdaptedBody = 'Hi Taylor! Great to meet you! Tuesday works 😀';
    const overAdapted = {
      ...reply,
      proposalId: 'warm-scheduling-reply-over-adapted',
      body: overAdaptedBody,
      bodyDigest: digest(overAdaptedBody)
    };
    assert.throws(
      () => proposeReplyDraft(db, overAdapted, 'reply:warm-scheduling:over-adapted'),
      (error) => error.code === 'DRAFT_STYLE_POLICY_VIOLATION'
    );
    assert.equal(
      db.prepare('SELECT count(*) count FROM job_email_reply_draft_proposals WHERE proposal_id=?')
        .get(overAdapted.proposalId).count,
      0,
      'style failure must roll back the proposal atomically'
    );

    const wrongRecipient = { ...reply, proposalId: 'wrong-recipient', recipient: 'attacker@example.test' };
    assert.throws(() => proposeReplyDraft(db, wrongRecipient, 'reply:wrong-recipient'), /recipient/i);

    const nextVoice = {
      ...voice,
      revisionId: 'cole-professional-v2',
      version: 2,
      dimensions: { ...voice.dimensions, energy: 'neutral' },
      ownership: { ...voice.ownership, attestedAt: '2026-07-19T12:00:00.000Z' },
      createdAt: '2026-07-19T12:00:00.000Z'
    };
    createWritingVoiceRevision(db, nextVoice, 'voice:cole-professional:v2');
    reviewWritingVoiceRevision(db, {
      revisionId: nextVoice.revisionId,
      decision: 'approved',
      reviewedBy: 'Cole',
      notes: 'Approved revised Cole-owned baseline.',
      idempotencyKey: 'voice:review:cole-professional:v2'
    });
    selectWritingVoiceRevision(db, {
      revisionId: nextVoice.revisionId,
      selectedBy: 'Cole',
      expectedCurrentRevisionId: voice.revisionId,
      idempotencyKey: 'voice:select:cole-professional:v2'
    });
    const staleToneReply = { ...reply, proposalId: 'warm-scheduling-reply-stale-tone' };
    assert.throws(
      () => proposeReplyDraft(db, staleToneReply, 'reply:warm-scheduling:stale-tone'),
      (error) => ['VOICE_NOT_CURRENT', 'SOURCE_STATE_STALE'].includes(error.code)
    );
    assert.equal(
      db.prepare('SELECT count(*) count FROM job_email_reply_draft_proposals WHERE proposal_id=?')
        .get(staleToneReply.proposalId).count,
      0
    );

    const revisedObservation = makeObservation(facts[0], 'warm-observation-1-revised', {
      dimensions: { ...warmDimensions(), energy: 'neutral' }
    });
    importDemeanorObservation(db, revisedObservation, 'observation:warm:1:revised');
    const revisedCatalog = buildEmailCommunicationContext(db, { source: messageRef(facts[2]) });
    assert.equal(revisedCatalog.availableSources.threadObservations.length, 3);
    assert.ok(revisedCatalog.availableSources.threadObservations.some((entry) => entry.observationId === revisedObservation.observationId));
    assert.ok(!revisedCatalog.availableSources.threadObservations.some((entry) => entry.observationId === observations[0].observationId));
    assert.equal(
      revisedCatalog.availableSources.styleProfiles.find((entry) => entry.profileId === profile.profileId).isStale,
      true
    );
    assert.throws(
      () => buildEmailCommunicationContext(db, {
        source: messageRef(facts[2]),
        styleProfileId: profile.profileId,
        voiceRevisionId: nextVoice.revisionId
      }),
      (error) => error.code === 'STYLE_PROFILE_STALE'
    );
  } finally {
    db.close();
  }
});

test('recipient style profiles expire after 180 days and selection, tone, and reply fail closed', (t) => {
  const fixture = createStore(t);
  const db = fixture.open();
  try {
    const facts = [1, 2, 3].map((day) => makeFacts({
      source: {
        messageId: `aged-profile-message-${day}`,
        threadId: 'aged-profile-thread',
        receivedAt: `2000-01-0${day}T18:00:00.000Z`,
        replyToAddress: 'recruiter@acme.example',
        contentDigest: sha256(`aged profile message ${day}`)
      },
      replyRequested: true
    }));
    facts.forEach((entry, index) => importFacts(db, entry, `facts:aged:${index + 1}`));
    const observations = facts.map((entry, index) => makeObservation(entry, `aged-observation-${index + 1}`));
    observations.forEach((entry, index) => importDemeanorObservation(db, entry, `observation:aged:${index + 1}`));

    const observationIds = observations.map((entry) => entry.observationId);
    const sourceContext = buildEmailCommunicationContext(db, {
      source: messageRef(facts[2]),
      observationIds
    });
    const aggregate = aggregateStyleObservations(sourceContext.observations);
    const profile = {
      schemaVersion: 'email-recipient-style-profile.v1',
      profileId: 'aged-thread-profile-v1',
      source: messageRef(facts[2]),
      scope: {
        kind: 'thread',
        provider: facts[2].source.provider,
        accountId: facts[2].source.accountId,
        threadId: facts[2].source.threadId
      },
      version: 1,
      observationIds,
      ...aggregate,
      generatedBy: styleGenerator(),
      sourceStateSha256: sourceContext.sourceStateSha256,
      requiresReview: true
    };
    createStyleProfile(db, profile, 'profile:aged:v1');
    reviewStyleProfile(db, {
      profileId: profile.profileId,
      decision: 'approved',
      reviewedBy: 'Cole',
      notes: 'Approved register evidence before its freshness horizon elapsed.',
      idempotencyKey: 'profile:review:aged:v1'
    });

    const expiration = evaluateStyleProfileFreshness(profile, '2100-01-01T00:00:00.000Z').expiresAt;
    const beforeExpiration = new Date(Date.parse(expiration) - 1).toISOString();
    assert.throws(
      () => selectStyleProfile(db, {
        profileId: profile.profileId,
        selectedBy: 'Cole',
        expectedCurrentProfileId: null,
        idempotencyKey: 'profile:select:aged:expired'
      }),
      (error) => error.code === 'STYLE_PROFILE_STALE'
        && error.details.staleReasons.includes('time_horizon_elapsed')
    );
    assert.equal(db.prepare('SELECT count(*) count FROM job_email_style_profile_selections').get().count, 0);

    selectStyleProfile(db, {
      profileId: profile.profileId,
      selectedBy: 'Cole',
      expectedCurrentProfileId: null,
      idempotencyKey: 'profile:select:aged:before-expiration'
    }, { now: beforeExpiration });

    const staleCatalog = buildEmailCommunicationContext(db, { source: messageRef(facts[2]) });
    const staleEntry = staleCatalog.availableSources.styleProfiles.find((entry) => entry.profileId === profile.profileId);
    assert.equal(staleEntry.isStale, true);
    assert.deepEqual(staleEntry.staleReasons, ['time_horizon_elapsed']);
    assert.equal(staleEntry.freshness.horizonDays, 180);
    assert.equal(staleEntry.freshness.lastObservedAt, aggregate.sample.lastObservedAt);
    assert.equal(staleEntry.freshness.expiresAt, expiration);
    assert.equal(staleCatalog.styleProfileFreshnessPolicy.basis, 'sample.lastObservedAt');

    const voice = makeVoice();
    createWritingVoiceRevision(db, voice, 'voice:aged-profile:v1');
    reviewWritingVoiceRevision(db, {
      revisionId: voice.revisionId,
      decision: 'approved',
      reviewedBy: 'Cole',
      notes: 'Approved Cole voice baseline.',
      idempotencyKey: 'voice:review:aged-profile:v1'
    });
    selectWritingVoiceRevision(db, {
      revisionId: voice.revisionId,
      selectedBy: 'Cole',
      expectedCurrentRevisionId: null,
      idempotencyKey: 'voice:select:aged-profile:v1'
    });

    const toneContext = buildEmailCommunicationContext(db, {
      source: messageRef(facts[2]),
      styleProfileId: profile.profileId,
      voiceRevisionId: voice.revisionId
    }, { now: beforeExpiration });
    const selectedTone = resolveRegisterAdaptation({
      voice: toneContext.writingVoice,
      recipientProfile: toneContext.styleProfile,
      purpose: 'scheduling'
    });
    const tone = {
      schemaVersion: 'email-tone-decision.v1',
      decisionId: 'aged-profile-tone-v1',
      source: messageRef(facts[2]),
      factsDigest: digest(facts[2]),
      purpose: 'scheduling',
      styleProfileId: profile.profileId,
      styleProfileDigest: toneContext.styleProfile.profileDigest,
      voiceRevisionId: voice.revisionId,
      voiceRevisionDigest: toneContext.writingVoice.revisionDigest,
      selected: selectedTone,
      policy: { ...TONE_POLICY, maxBandShift: voice.delivery.maxBandShift },
      rationaleCodes: ['cole_voice_baseline', 'thread_register', 'scheduling_clarity', 'identity_mimicry_guard'],
      generatedBy: styleGenerator(),
      sourceStateSha256: toneContext.sourceStateSha256,
      requiresReview: true
    };
    assert.throws(
      () => createToneDecision(db, tone, 'tone:aged-profile:expired', { now: expiration }),
      (error) => error.code === 'STYLE_PROFILE_STALE'
    );
    assert.equal(db.prepare('SELECT count(*) count FROM job_email_tone_decisions').get().count, 0);

    const toneResult = createToneDecision(
      db,
      tone,
      'tone:aged-profile:before-expiration',
      { now: beforeExpiration }
    );
    const reply = makeReplyV2({
      facts: facts[2],
      toneDecision: {
        decisionId: tone.decisionId,
        decisionDigest: toneResult.decisionDigest,
        styleProfileId: profile.profileId,
        styleProfileDigest: tone.styleProfileDigest,
        voiceRevisionId: voice.revisionId,
        voiceRevisionDigest: tone.voiceRevisionDigest,
        sourceStateSha256: tone.sourceStateSha256
      },
      body: 'Hi Taylor,\n\nTuesday at 2:00 PM works for me.\n\nBest,\nCole'
    });
    assert.throws(
      () => proposeReplyDraft(db, reply, 'reply:aged-profile:expired'),
      (error) => error.code === 'STYLE_PROFILE_STALE'
    );
    assert.equal(
      db.prepare('SELECT count(*) count FROM job_email_reply_draft_proposals WHERE proposal_id=?')
        .get(reply.proposalId).count,
      0,
      'expired profile failure must roll back the reply proposal atomically'
    );
  } finally {
    db.close();
  }
});

test('reviewed contact binding enables cross-thread profiles and rejects endpoint mismatch', (t) => {
  const fixture = createStore(t);
  runCli(fixture.home, ['add-application', '--company', 'Acme', '--role', 'Platform Engineer', '--status', 'applied']);
  const db = fixture.open();
  try {
    const companyId = db.prepare("SELECT id FROM companies WHERE normalized_name='acme'").get().id;
    const contactId = Number(db.prepare(`
      INSERT INTO company_contacts(company_id,name,role_title,email,source)
      VALUES (?,?,?,?,?)
    `).run(companyId, 'Taylor Recruiter', 'Recruiter', 'taylor@acme.example', 'reviewed-email-binding').lastInsertRowid);

    const facts = [
      makeFacts({ source: { messageId: 'contact-message-1', threadId: 'contact-thread-a', fromAddress: 'mailer@acme.example', replyToAddress: 'taylor@acme.example', contentDigest: sha256('contact 1') } }),
      makeFacts({ source: { messageId: 'contact-message-2', threadId: 'contact-thread-a', fromAddress: 'mailer@acme.example', replyToAddress: 'taylor@acme.example', receivedAt: '2026-07-18T18:00:00.000Z', contentDigest: sha256('contact 2') } }),
      makeFacts({ source: { messageId: 'contact-message-3', threadId: 'contact-thread-b', fromAddress: 'mailer@acme.example', replyToAddress: 'taylor@acme.example', receivedAt: '2026-07-19T18:00:00.000Z', contentDigest: sha256('contact 3') } })
    ];
    facts.forEach((entry, index) => importFacts(db, entry, `facts:contact:${index + 1}`));
    const messageId = db.prepare("SELECT id FROM job_email_message_refs WHERE message_id='contact-message-1'").get().id;

    assert.throws(
      () => db.prepare(`
        INSERT INTO job_email_contact_binding_events(
          company_contact_id,provider,account_id,normalized_email,source_message_ref_id,decision,
          expected_prior_event_id,actor,reason,idempotency_key,intent_sha256
        ) VALUES (?,?,?,?,?,'bind',NULL,?,?,?,?)
      `).run(
        contactId, 'gmail', 'cole@example.test', 'taylor@acme.example', messageId,
        'Cole', 'Direct SQL source mismatch test', 'contact:direct-source-mismatch', sha256('direct mismatch')
      ),
      /source identity mismatch/i
    );

    assert.throws(
      () => recordContactBinding(db, {
        messageRefId: messageId,
        companyContactId: contactId,
        email: 'other@acme.example',
        decision: 'bind',
        actor: 'Cole',
        reason: 'Wrong endpoint test',
        expectedPriorEventId: null,
        idempotencyKey: 'contact:wrong-endpoint'
      }),
      (error) => error.code === 'CONTACT_ENDPOINT_MISMATCH'
    );
    const binding = recordContactBinding(db, {
      messageRefId: messageId,
      companyContactId: contactId,
      email: 'taylor@acme.example',
      decision: 'bind',
      actor: 'Cole',
      reason: 'Reviewed exact Reply-To endpoint for Taylor.',
      expectedPriorEventId: null,
      idempotencyKey: 'contact:taylor:bind'
    });

    const observations = facts.map((entry, index) => makeObservation(entry, `contact-observation-${index + 1}`));
    observations.forEach((entry, index) => importDemeanorObservation(db, entry, `observation:contact:${index + 1}`));
    const mismatchedReplyToFacts = makeFacts({
      source: {
        messageId: 'contact-message-spoofed-reply-to',
        threadId: 'contact-thread-spoofed',
        fromAddress: 'taylor@acme.example',
        replyToAddress: 'unreviewed-reply-target@acme.example',
        receivedAt: '2026-07-20T18:00:00.000Z',
        contentDigest: sha256('contact spoofed reply-to')
      }
    });
    importFacts(db, mismatchedReplyToFacts, 'facts:contact:spoofed-reply-to');
    importDemeanorObservation(
      db,
      makeObservation(mismatchedReplyToFacts, 'contact-observation-spoofed-reply-to'),
      'observation:contact:spoofed-reply-to'
    );
    assert.throws(
      () => buildEmailCommunicationContext(db, {
        source: messageRef(mismatchedReplyToFacts),
        contactId
      }),
      (error) => error.code === 'CONTACT_SCOPE_MISMATCH'
    );
    const observationIds = observations.map((entry) => entry.observationId);
    const context = buildEmailCommunicationContext(db, {
      source: messageRef(facts[2]),
      contactId,
      observationIds
    });
    assert.deepEqual(context.contact, { companyContactId: contactId, bindingEventId: binding.eventId });
    assert.equal(context.availableSources.contactObservations.length, 3);
    const aggregate = aggregateStyleObservations(context.observations);
    assert.equal(aggregate.sample.distinctThreadCount, 2);

    const profile = {
      schemaVersion: 'email-recipient-style-profile.v1',
      profileId: 'taylor-contact-profile-v1',
      source: messageRef(facts[2]),
      scope: { kind: 'contact', contactId },
      version: 1,
      observationIds,
      ...aggregate,
      generatedBy: styleGenerator(),
      sourceStateSha256: context.sourceStateSha256,
      requiresReview: true
    };
    const created = createStyleProfile(db, profile, 'profile:taylor:contact:v1');
    assert.equal(created.profileId, profile.profileId);
    assert.equal(db.prepare("SELECT scope_kind FROM job_email_recipient_style_profiles WHERE profile_id=?").get(profile.profileId).scope_kind, 'contact');
    assert.throws(
      () => db.prepare('DELETE FROM job_email_contact_binding_events WHERE id=?').run(binding.eventId),
      /append-only/i
    );
  } finally {
    db.close();
  }
});

test('recordCompanyContact promotes an inbound sender name into a durable, endpoint-scoped contact', (t) => {
  const fixture = createStore(t);
  runCli(fixture.home, ['add-application', '--company', 'Acme', '--role', 'Platform Engineer', '--status', 'applied']);
  const db = fixture.open();
  try {
    const companyId = db.prepare("SELECT id FROM companies WHERE normalized_name='acme'").get().id;
    // A welcome email whose facts carry the sender display name the inbox pipeline extracted.
    const facts = makeV2Facts({
      source: {
        messageId: 'welcome-message-1',
        threadId: 'welcome-thread-1',
        fromAddress: 'careers@acme.example',
        replyToAddress: 'talent@acme.example',
        fromDisplayName: 'Talent Team',
        contentDigest: sha256('welcome content')
      }
    });
    const { messageRefId } = importFacts(db, facts, 'facts:welcome:1');

    // Name defaults to source.fromDisplayName; email defaults to the message From address.
    const created = recordCompanyContact(db, { messageRefId, companyId, source: 'welcome-rehearsal', idempotencyKey: 'contact:welcome:create' });
    assert.equal(created.created, true);
    assert.equal(created.name, 'Talent Team');
    assert.equal(created.email, 'careers@acme.example');
    assert.equal(created.companyId, companyId);
    assert.equal(created.sourceMessageRefId, messageRefId);
    const row = db.prepare('SELECT company_id,name,role_title,email,source FROM company_contacts WHERE id=?').get(created.contactId);
    assert.equal(row.company_id, companyId);
    assert.equal(row.name, 'Talent Team');
    assert.equal(row.role_title, null);
    assert.equal(row.email, 'careers@acme.example');
    assert.match(row.source, /^email-learning:\d+$/);
    const learningId = Number(row.source.split(':')[1]);
    assert.deepEqual(db.prepare(`
      SELECT kind,company_id,normalized_value,source_message_ref_id,actor,retracted_at
      FROM email_identity_learnings WHERE id=?
    `).get(learningId), {
      kind: 'contact', company_id: companyId, normalized_value: 'careers@acme.example',
      source_message_ref_id: messageRefId, actor: 'email-record-contact:welcome-rehearsal', retracted_at: null
    });

    // Idempotency-key replay returns the identical result.
    assert.deepEqual(recordCompanyContact(db, { messageRefId, companyId, source: 'welcome-rehearsal', idempotencyKey: 'contact:welcome:create' }), created);
    // A different key for the same sender does not create a duplicate row.
    const again = recordCompanyContact(db, { messageRefId, companyId, source: 'welcome-rehearsal', idempotencyKey: 'contact:welcome:create-2' });
    assert.equal(again.created, false);
    assert.equal(again.contactId, created.contactId);
    assert.equal(db.prepare('SELECT count(*) c FROM company_contacts').get().c, 1);

    // Reply-To is an accepted endpoint, and an explicit name/role are honored — a distinct contact.
    const replyToContact = recordCompanyContact(db, {
      messageRefId, companyId, email: 'talent@acme.example', name: 'Jordan Recruiter', roleTitle: 'Senior Recruiter',
      source: 'welcome-rehearsal', idempotencyKey: 'contact:welcome:replyto'
    });
    assert.equal(replyToContact.created, true);
    assert.equal(replyToContact.name, 'Jordan Recruiter');
    assert.equal(replyToContact.email, 'talent@acme.example');
    assert.notEqual(replyToContact.contactId, created.contactId);

    // An address that is neither From nor Reply-To is rejected.
    assert.throws(
      () => recordCompanyContact(db, { messageRefId, companyId, email: 'stranger@evil.test', source: 'welcome-rehearsal', idempotencyKey: 'contact:welcome:bad' }),
      (error) => error.code === 'CONTACT_ENDPOINT_MISMATCH'
    );
    // Unknown message and unknown company are guarded.
    assert.throws(
      () => recordCompanyContact(db, { messageRefId: 999999, companyId, source: 's', idempotencyKey: 'contact:welcome:no-msg' }),
      (error) => error.code === 'MESSAGE_NOT_FOUND'
    );
    assert.throws(
      () => recordCompanyContact(db, { messageRefId, companyId: 999999, source: 's', idempotencyKey: 'contact:welcome:no-co' }),
      (error) => error.code === 'COMPANY_NOT_FOUND'
    );
    // With no display name in facts and no explicit name, the verb refuses rather than inventing one.
    const nameless = makeV2Facts({ source: { messageId: 'nameless-1', threadId: 'nameless-t', fromAddress: 'noreply@acme.example', contentDigest: sha256('nameless') } });
    const namelessRef = importFacts(db, nameless, 'facts:nameless:1').messageRefId;
    assert.throws(
      () => recordCompanyContact(db, { messageRefId: namelessRef, companyId, source: 's', idempotencyKey: 'contact:nameless' }),
      (error) => error.code === 'INVALID_INPUT' || /contact name/i.test(error.message)
    );

    const retracted = emailLearning.retractLink(db, {
      messageRefId, actor: 'Cole', reason: 'the inbound sender contacts were recorded against the wrong company'
    });
    assert.equal(retracted.contacts, 2);
    assert.equal(retracted.linkRetractions, 0, 'standalone contact learning is not a corrected application link');
    assert.equal(db.prepare('SELECT count(*) AS count FROM email_link_retractions WHERE message_ref_id=?').get(messageRefId).count, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM company_contacts WHERE company_id=?').get(companyId).count, 0);
    assert.equal(db.prepare(`
      SELECT count(*) AS count FROM email_identity_learnings
      WHERE source_message_ref_id=? AND kind='contact' AND retracted_at IS NOT NULL
    `).get(messageRefId).count, 2);

    const future = correlateEmailReadOnly(db, facts);
    assert.equal(future.resolution, 'linked');
    recordCorrelation(db, future, 'facts:welcome:future-correlation');
    assert.equal(db.prepare(`
      SELECT count(*) AS count FROM active_job_email_linked_correlations WHERE message_ref_id=?
    `).get(messageRefId).count, 1, 'learning-only retraction does not blacklist a later valid correlation');
    assert.equal(readCorrelationMetrics(db).counts.mislinkRetractions, 0,
      'learning-only retraction is not reported as a corrected application link');
  } finally {
    db.close();
  }
});

function makeV2Facts(overrides = {}) {
  const sourceOverrides = overrides.source || {};
  const source = {
    provider: 'apple_mail_emlx',
    accountId: 'cole@example.test',
    messageId: 'v2-message-1',
    threadId: 'v2-thread-1',
    receivedAt: '2026-07-22T18:00:00.000Z',
    fromAddress: 'careers@acme.example',
    contentDigest: sha256('sanitized v2 source content'),
    ...sourceOverrides
  };
  if (!Object.prototype.hasOwnProperty.call(sourceOverrides, 'fromDomain')) {
    source.fromDomain = source.fromAddress.split('@').at(-1);
  }
  return validateJobApplicationEmailFacts({
    schemaVersion: 'job-application-email-facts.v2',
    trust: 'untrusted_external',
    source,
    contentCompleteness: 'sanitized_plain_text',
    eventKind: 'application_received',
    company: { name: 'Acme', domain: 'acme.example' },
    postingRefs: [],
    applicationRefs: [],
    replyRequested: true,
    evidence: [{ field: 'subject', excerpt: 'Application communication' }],
    extraction: { provider: 'inbox-pipeline', version: 'jobtrack-relay.v3', confidence: 0.87 },
    security: { risk: 'medium', requiresReview: true },
    ...withoutKey(overrides, 'source'),
    source
  });
}

function makeFacts(overrides = {}) {
  const sourceOverrides = overrides.source || {};
  const source = {
    provider: 'fixture',
    accountId: 'cole@example.test',
    messageId: 'message-1',
    threadId: 'thread-1',
    receivedAt: '2026-07-17T18:00:00.000Z',
    fromAddress: 'jobs@acme.example',
    fromDomain: 'acme.example',
    contentDigest: sha256('sanitized source content'),
    ...sourceOverrides
  };
  if (!Object.prototype.hasOwnProperty.call(sourceOverrides, 'fromDomain')) {
    source.fromDomain = source.fromAddress.split('@').at(-1);
  }
  return validateJobApplicationEmailFacts({
    schemaVersion: 'job-application-email-facts.v1',
    trust: 'untrusted_external',
    source,
    contentCompleteness: 'sanitized_plain_text',
    eventKind: 'recruiter_followup',
    company: { name: 'Acme', domain: 'acme.example' },
    postingRefs: [{ roleTitle: 'Platform Engineer' }],
    applicationRefs: [],
    replyRequested: false,
    evidence: [{ field: 'subject', excerpt: 'Application update' }],
    extraction: { provider: 'fixture', version: '1', confidence: 0.95 },
    security: { risk: 'low', requiresReview: false },
    ...withoutKey(overrides, 'source'),
    source
  });
}

function makeObservation(facts, observationId, overrides = {}) {
  return {
    schemaVersion: 'email-demeanor-observation.v1',
    observationId,
    source: messageRef(facts),
    factsDigest: digest(facts),
    contentDigest: facts.source.contentDigest,
    authorship: 'human',
    dimensions: warmDimensions(),
    surfaceSignals: {
      length: 'short',
      greeting: 'hi',
      closing: 'best',
      exclamation: 'one',
      emoji: 'none',
      contractions: 'present'
    },
    confidence: 0.92,
    evidence: [{ signal: 'warmth', factsEvidenceIndex: 0 }],
    extraction: {
      provider: 'fixture',
      model: 'bounded-style-fixture',
      version: '1',
      policyVersion: 'register-observation.v1'
    },
    security: {
      risk: 'low',
      promptInjectionDetected: false,
      sensitiveTraitInferenceDetected: false,
      personalityInferenceDetected: false,
      requiresReview: false
    },
    profileEligible: true,
    ...overrides
  };
}

function makeVoice() {
  return {
    schemaVersion: 'profile-writing-voice-revision.v1',
    voiceKey: 'cole-professional',
    revisionId: 'cole-professional-v1',
    version: 1,
    label: 'Cole professional',
    dimensions: warmDimensions(),
    delivery: { ...profileDelivery(), emojiPolicy: 'none', maxBandShift: 1 },
    ownership: {
      owner: 'Cole',
      source: 'manual',
      attestedBy: 'Cole',
      attestedAt: '2026-07-18T12:00:00.000Z'
    },
    sampleDigests: [],
    authoredBy: 'Cole',
    createdAt: '2026-07-18T12:00:00.000Z',
    requiresReview: true
  };
}

function makeReplyV2({ facts, toneDecision, body }) {
  return {
    schemaVersion: 'email-reply-draft-proposal.v2',
    proposalId: 'warm-scheduling-reply-v2',
    factsDigest: digest(facts),
    source: {
      ...messageRef(facts),
      replyToAddress: facts.source.replyToAddress || facts.source.fromAddress
    },
    recipient: facts.source.replyToAddress || facts.source.fromAddress,
    subject: 'Re: Scheduling',
    body,
    bodyDigest: digest(body),
    purpose: 'scheduling',
    authorship: 'model',
    expiresAt: '2027-07-18T12:00:00.000Z',
    sensitiveDataScan: 'passed',
    toneDecisionId: toneDecision.decisionId,
    toneDecisionDigest: toneDecision.decisionDigest,
    styleProfileId: toneDecision.styleProfileId,
    styleProfileDigest: toneDecision.styleProfileDigest,
    voiceRevisionId: toneDecision.voiceRevisionId,
    voiceRevisionDigest: toneDecision.voiceRevisionDigest,
    sourceStateSha256: toneDecision.sourceStateSha256,
    registerAdaptationOnly: true,
    distinctivePhraseReuse: false,
    requiresReview: true,
    autoSendEligible: false
  };
}

function fakeToneBinding() {
  return {
    decisionId: 'fake-tone',
    decisionDigest: sha256('fake tone'),
    styleProfileId: 'fake-style',
    styleProfileDigest: sha256('fake style'),
    voiceRevisionId: 'fake-voice',
    voiceRevisionDigest: sha256('fake voice'),
    sourceStateSha256: sha256('fake state')
  };
}

function warmDimensions() {
  return {
    formality: 'neutral',
    warmth: 'warm',
    energy: 'upbeat',
    directness: 'balanced',
    verbosity: 'concise'
  };
}

function profileDelivery() {
  return {
    greeting: 'hi',
    closing: 'best',
    exclamationPolicy: 'at_most_one',
    emojiPolicy: 'none',
    contractions: 'allow'
  };
}

function safeguards() {
  return {
    registerAdaptationOnly: true,
    sensitiveTraitInference: false,
    personalityInference: false,
    distinctivePhraseReuse: false
  };
}

function styleGenerator() {
  return {
    provider: 'fixture',
    model: 'bounded-style-fixture',
    version: '1',
    policyVersion: 'register-adaptation.v1'
  };
}

function messageRef(facts) {
  return {
    provider: facts.source.provider,
    accountId: facts.source.accountId,
    messageId: facts.source.messageId,
    threadId: facts.source.threadId
  };
}

function createStore(t, { cold = false } = {}) {
  const copied = cold ? null : createTestStore('jobtrack-email-communication-');
  const rootDir = copied?.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-email-communication-'));
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

function runCli(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], {
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    encoding: 'utf8'
  }));
}

function withoutKey(value, key) {
  return Object.fromEntries(Object.entries(value).filter(([entry]) => entry !== key));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
