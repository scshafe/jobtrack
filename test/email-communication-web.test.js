'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createTestStore } = require('../test-support/migrated-store');
const { freePort } = require('../test-support/free-port');

const {
  validateJobApplicationEmailFacts,
  digest
} = require('../lib/email-contracts');
const {
  importDemeanorObservation,
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
  TONE_POLICY,
  aggregateStyleObservations,
  resolveRegisterAdaptation
} = require('../lib/email-style-policy');
const {
  importFacts,
  proposeReplyDraft,
  reviewReplyDraft
} = require('../lib/email-integration');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('communications workspace exposes only application-scoped inert tone metadata and remains read-only', async (t) => {
  const fixture = makeFixture();
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const linked = runCli(fixture.home, [
    'add-application', '--company', 'Acme', '--role', 'Platform Engineer',
    '--status', 'applied', '--applied-date', '2026-07-17'
  ]);
  const unrelated = runCli(fixture.home, [
    'add-application', '--company', 'Other Co', '--role', 'Security Engineer',
    '--status', 'applied', '--applied-date', '2026-07-17'
  ]);

  const privateAddress = 'private.reply+WEB_EMAIL_ADDRESS_SENTINEL@acme.example';
  const privateEvidence = 'WEB_EMAIL_EVIDENCE_SENTINEL <script>window.emailEvidenceLeaked=true</script>';
  const privateBody = 'WEB_EMAIL_BODY_SENTINEL <img src=x onerror=window.emailBodyLeaked=true> /home/user/private-email-attachment.pdf';
  const db = new Database(path.join(fixture.home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  try {
    const facts = makeFacts({ privateAddress, privateEvidence });
    const imported = importFacts(db, facts, 'web-email:facts');
    db.prepare(`
      INSERT INTO job_email_application_links(message_ref_id,application_id,relation,proposal_id)
      VALUES (?,?,?,NULL)
    `).run(imported.messageRefId, linked.application.id, 'reviewed-test-link');
    db.prepare(`
      INSERT INTO job_email_correlations(
        message_ref_id,facts_digest,resolution,resolved_application_id,correlation_json,correlation_digest
      ) VALUES (?,?,?,?,?,?)
    `).run(
      imported.messageRefId,
      digest(facts),
      'linked',
      linked.application.id,
      JSON.stringify({ evidence: [] }),
      'a'.repeat(64)
    );

    const observation = makeObservation(facts);
    importDemeanorObservation(db, observation, 'web-email:observation');
    const selectedContext = buildEmailCommunicationContext(db, {
      source: messageRef(facts),
      observationIds: [observation.observationId]
    });
    const aggregate = aggregateStyleObservations(selectedContext.observations);
    const profile = {
      schemaVersion: 'email-recipient-style-profile.v1',
      profileId: 'web-thread-profile-v1',
      source: messageRef(facts),
      scope: {
        kind: 'thread',
        provider: facts.source.provider,
        accountId: facts.source.accountId,
        threadId: facts.source.threadId
      },
      version: 1,
      observationIds: [observation.observationId],
      ...aggregate,
      generatedBy: generator(),
      sourceStateSha256: selectedContext.sourceStateSha256,
      requiresReview: true
    };
    createStyleProfile(db, profile, 'web-email:profile');
    reviewStyleProfile(db, {
      profileId: profile.profileId,
      decision: 'approved',
      reviewedBy: 'Cole',
      notes: 'WEB_EMAIL_REVIEW_NOTE_SENTINEL <svg onload=window.reviewLeaked=true>',
      idempotencyKey: 'web-email:profile-review'
    });
    selectStyleProfile(db, {
      profileId: profile.profileId,
      selectedBy: 'Cole',
      expectedCurrentProfileId: null,
      idempotencyKey: 'web-email:profile-select'
    });

    const voice = makeVoice();
    createWritingVoiceRevision(db, voice, 'web-email:voice');
    reviewWritingVoiceRevision(db, {
      revisionId: voice.revisionId,
      decision: 'approved',
      reviewedBy: 'Cole',
      notes: 'Approved test baseline.',
      idempotencyKey: 'web-email:voice-review'
    });
    selectWritingVoiceRevision(db, {
      revisionId: voice.revisionId,
      selectedBy: 'Cole',
      expectedCurrentRevisionId: null,
      idempotencyKey: 'web-email:voice-select'
    });

    const toneContext = buildEmailCommunicationContext(db, {
      source: messageRef(facts),
      styleProfileId: profile.profileId,
      voiceRevisionId: voice.revisionId
    });
    const selected = resolveRegisterAdaptation({
      voice: toneContext.writingVoice,
      recipientProfile: toneContext.styleProfile,
      purpose: 'scheduling'
    });
    const tone = {
      schemaVersion: 'email-tone-decision.v1',
      decisionId: 'web-scheduling-tone-v1',
      source: messageRef(facts),
      factsDigest: digest(facts),
      purpose: 'scheduling',
      styleProfileId: profile.profileId,
      styleProfileDigest: toneContext.styleProfile.profileDigest,
      voiceRevisionId: voice.revisionId,
      voiceRevisionDigest: toneContext.writingVoice.revisionDigest,
      selected,
      policy: { ...TONE_POLICY, maxBandShift: voice.delivery.maxBandShift },
      rationaleCodes: [
        'cole_voice_baseline', 'low_confidence_fallback', 'scheduling_clarity', 'identity_mimicry_guard'
      ],
      generatedBy: generator(),
      sourceStateSha256: toneContext.sourceStateSha256,
      requiresReview: true
    };
    const toneResult = createToneDecision(db, tone, 'web-email:tone');
    const reply = {
      schemaVersion: 'email-reply-draft-proposal.v2',
      proposalId: 'web-styled-reply-v2',
      factsDigest: digest(facts),
      source: { ...messageRef(facts), replyToAddress: privateAddress },
      recipient: privateAddress,
      subject: 'Re: Scheduling',
      body: privateBody,
      bodyDigest: digest(privateBody),
      purpose: 'scheduling',
      authorship: 'model',
      expiresAt: '2027-07-18T12:00:00.000Z',
      sensitiveDataScan: 'passed',
      toneDecisionId: tone.decisionId,
      toneDecisionDigest: toneResult.decisionDigest,
      styleProfileId: profile.profileId,
      styleProfileDigest: tone.styleProfileDigest,
      voiceRevisionId: voice.revisionId,
      voiceRevisionDigest: tone.voiceRevisionDigest,
      sourceStateSha256: tone.sourceStateSha256,
      registerAdaptationOnly: true,
      distinctivePhraseReuse: false,
      requiresReview: true,
      autoSendEligible: false
    };
    proposeReplyDraft(db, reply, 'web-email:reply');
    reviewReplyDraft(db, {
      proposalId: reply.proposalId,
      decision: 'approved',
      decidedBy: 'Cole',
      notes: 'WEB_EMAIL_DRAFT_REVIEW_SENTINEL /home/user/review-notes.txt',
      idempotencyKey: 'web-email:reply-review'
    });
  } finally {
    db.close();
  }

  instance = await startServer(fixture);

  const workspace = await request(`${instance.baseUrl}/applications/${linked.application.id}`);
  assert.equal(workspace.status, 200, `${workspace.text}\n${instance.stderr()}`);
  assert.match(workspace.text, /Recipient-aware communications/);
  assert.match(workspace.text, /Email correlation quality/);
  assert.match(workspace.text, /Automatic-link rate<\/span><span>100\.0%/);
  assert.match(workspace.text, /Agent-link rate<\/span><span>0\.0%/);
  assert.match(workspace.text, /Clarify rate<\/span><span>0\.0%/);
  assert.match(workspace.text, /Mislink retractions<\/span><span>0/);
  assert.match(workspace.text, /Average time-to-link/);
  assert.match(workspace.text, /Demeanor observations/);
  assert.match(workspace.text, /web-scheduling-tone-v1/);
  assert.match(workspace.text, /web-thread-profile-v1/);
  assert.match(workspace.text, /web-cole-professional-v1/);
  assert.match(workspace.text, /web-styled-reply-v2/);
  assert.match(workspace.text, /warm/i);
  assert.match(workspace.text, /upbeat/i);
  // The send edge exists now (2026-08-05); the workspace names the policy
  // that governs it instead of claiming authority is never granted.
  assert.match(workspace.text, /Approval policy<\/span><span>auto \(default\)/);
  assert.match(workspace.text, /Send edge<\/span><span>send-approved · allowlisted/);
  assert.match(workspace.text, /auto-send disabled/);
  assertPrivateHeaders(workspace.headers);

  for (const secret of [
    privateAddress,
    'WEB_EMAIL_ADDRESS_SENTINEL',
    'WEB_FROM_SENTINEL',
    'WEB_EMAIL_EVIDENCE_SENTINEL',
    'WEB_EMAIL_BODY_SENTINEL',
    'WEB_EMAIL_REVIEW_NOTE_SENTINEL',
    'WEB_EMAIL_DRAFT_REVIEW_SENTINEL',
    '/home/user/private-email-attachment.pdf',
    '/home/user/review-notes.txt'
  ]) assert.doesNotMatch(workspace.text, new RegExp(escapeRegExp(secret), 'i'));
  assert.doesNotMatch(workspace.text, /window\.(emailEvidenceLeaked|emailBodyLeaked|reviewLeaked)/);
  assert.doesNotMatch(workspace.text, /<script|<img|<svg/i);
  assert.doesNotMatch(workspace.text, /&lt;(script|img|svg)/i, 'private payloads must be omitted, not merely escaped');

  const otherWorkspace = await request(`${instance.baseUrl}/applications/${unrelated.application.id}`);
  assert.equal(otherWorkspace.status, 200, otherWorkspace.text);
  assert.match(otherWorkspace.text, /No reviewed email-to-application links are recorded/);
  assert.doesNotMatch(otherWorkspace.text, /web-scheduling-tone-v1|web-thread-profile-v1|web-styled-reply-v2/);

  const post = await request(`${instance.baseUrl}/applications/${linked.application.id}`, { method: 'POST' });
  assert.equal(post.status, 405, post.text);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  assertPrivateHeaders(post.headers);

});

function makeFacts({ privateAddress, privateEvidence }) {
  return validateJobApplicationEmailFacts({
    schemaVersion: 'job-application-email-facts.v1',
    trust: 'untrusted_external',
    source: {
      provider: 'fixture',
      accountId: 'cole@example.test',
      messageId: 'web-message-1',
      threadId: 'web-thread-1',
      receivedAt: '2026-07-18T12:00:00.000Z',
      fromAddress: 'private.sender+WEB_FROM_SENTINEL@acme.example',
      fromDomain: 'acme.example',
      replyToAddress: privateAddress,
      contentDigest: sha256('private sanitized body bytes')
    },
    contentCompleteness: 'sanitized_plain_text',
    eventKind: 'recruiter_followup',
    company: { name: 'Acme', domain: 'acme.example' },
    postingRefs: [{ roleTitle: 'Platform Engineer' }],
    applicationRefs: [],
    replyRequested: true,
    evidence: [{ field: 'body', excerpt: privateEvidence }],
    extraction: { provider: 'fixture', version: '1', confidence: 0.98 },
    security: { risk: 'low', requiresReview: false }
  });
}

function makeObservation(facts) {
  return {
    schemaVersion: 'email-demeanor-observation.v1',
    observationId: 'web-observation-v1',
    source: messageRef(facts),
    factsDigest: digest(facts),
    contentDigest: facts.source.contentDigest,
    authorship: 'human',
    dimensions: dimensions(),
    surfaceSignals: {
      length: 'short', greeting: 'hi', closing: 'best', exclamation: 'one', emoji: 'none', contractions: 'present'
    },
    confidence: 0.9,
    evidence: [{ signal: 'warmth', factsEvidenceIndex: 0 }],
    extraction: { ...generator(), policyVersion: 'register-observation.v1' },
    security: {
      risk: 'low', promptInjectionDetected: false, sensitiveTraitInferenceDetected: false,
      personalityInferenceDetected: false, requiresReview: false
    },
    profileEligible: true
  };
}

function makeVoice() {
  return {
    schemaVersion: 'profile-writing-voice-revision.v1',
    voiceKey: 'web-cole-professional',
    revisionId: 'web-cole-professional-v1',
    version: 1,
    label: 'Cole professional',
    dimensions: dimensions(),
    delivery: {
      greeting: 'hi', closing: 'best', exclamationPolicy: 'at_most_one',
      emojiPolicy: 'none', contractions: 'allow', maxBandShift: 1
    },
    ownership: {
      owner: 'Cole', source: 'manual', attestedBy: 'Cole', attestedAt: '2026-07-18T12:00:00.000Z'
    },
    sampleDigests: [],
    authoredBy: 'Cole',
    createdAt: '2026-07-18T12:00:00.000Z',
    requiresReview: true
  };
}

function dimensions() {
  return {
    formality: 'neutral', warmth: 'warm', energy: 'upbeat', directness: 'balanced', verbosity: 'concise'
  };
}

function generator() {
  return {
    provider: 'fixture', model: 'bounded-style-fixture', version: '1', policyVersion: 'register-adaptation.v1'
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

function makeFixture() {
  const { root: rootPath, home } = createTestStore('jobtrack-email-communication-web-');
  const tmp = path.join(rootPath, 'tmp');
  fs.mkdirSync(tmp);
  return { root: rootPath, home, tmp };
}

function runCli(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }));
}

async function startServer(fixture) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      JOBTRACK_HOME: fixture.home,
      JOBTRACK_DB: path.join(fixture.home, 'jobtrack.db'),
      TMPDIR: fixture.tmp,
      HOST: '127.0.0.1',
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(250) });
      if (response.status === 200) return { child, baseUrl, stderr: () => stderr };
    } catch { /* listener not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start: ${stderr}`);
}

async function stopServer(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  const exited = once(instance.child, 'exit');
  instance.child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not exit: ${instance.stderr()}`)), 3000))
  ]);
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

function assertPrivateHeaders(headers) {
  assert.match(headers.get('cache-control') || '', /no-store/);
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.match(headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
