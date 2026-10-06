'use strict';

// Company-research-via-broker composition (EMAIL_REPLY_DRAFTING_PLAN §4.3, P3).
//
// JobTrack's drafting environment MAY declare a discovery-egress-broker capability
// for fresh company research — never raw internet, only an EXACT allowlist. This
// is DECLARATIVE only: JobTrack makes no network call and runs no model; it pins
// the declared allowlist into sourceStateSha256 (like the strategy source
// checkpoint) and hands the exact broker policy to an external runner.
//
// Invariants exercised here:
//   * default OFF — absent a descriptor, the projection carries no research;
//   * enabled path carries an EXACT allowlist (the fail-closed broker policy),
//     digest-pinned into sourceStateSha256, and the issued request never fetches;
//   * a non-allowlisted target is REFUSED (mirrors the broker's per-hop gate).

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createTestStore } = require('../test-support/migrated-store');

const {
  importFacts,
  buildDraftReplyContext,
  issueDraftReplyRequest
} = require('../lib/email-integration');
const {
  EmailDraftReplyError,
  RESEARCH_CAPABILITY,
  MAX_RESEARCH_TARGETS,
  normalizeCompanyResearch
} = require('../lib/email-draft-reply');
const { digest } = require('../lib/email-contracts');

const cli = path.join(__dirname, '..', 'bin', 'jobtrack.js');
const POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'company-research-policy.json'), 'utf8'));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeStore(t) {
  const { root: dir, home } = createTestStore('jobtrack-draft-research-');
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

function makeFacts() {
  return {
    schemaVersion: 'job-application-email-facts.v1',
    trust: 'untrusted_external',
    source: {
      provider: 'fixture',
      accountId: 'cole@example.test',
      messageId: 'message-1',
      threadId: 'thread-1',
      receivedAt: '2026-07-17T18:00:00.000Z',
      fromAddress: 'recruiter@acme.example',
      fromDomain: 'acme.example',
      replyToAddress: 'recruiter@acme.example',
      contentDigest: sha256('sanitized source content')
    },
    contentCompleteness: 'sanitized_plain_text',
    eventKind: 'recruiter_followup',
    company: { name: 'Acme', domain: 'acme.example' },
    postingRefs: [{ roleTitle: 'Platform Engineer' }],
    applicationRefs: [],
    replyRequested: true,
    evidence: [{ field: 'subject', excerpt: 'Interview scheduling' }],
    extraction: { provider: 'fixture', version: '1', confidence: 0.95 },
    security: { risk: 'low', requiresReview: false }
  };
}

const SOURCE = { provider: 'fixture', accountId: 'cole@example.test', messageId: 'message-1', threadId: 'thread-1' };

function importFactsHelper(db) {
  const facts = makeFacts();
  importFacts(db, facts, 'facts:draft-reply-research');
  return facts;
}

function research(overrides = {}) {
  return {
    capability: RESEARCH_CAPABILITY,
    networkPolicy: JSON.parse(JSON.stringify(POLICY)),
    targets: [{ sourceKey: 'acme-about', url: 'https://www.acme.example/about/company' }],
    ...overrides
  };
}

// -------------------------------------------------------------------------
// Default OFF.
// -------------------------------------------------------------------------

test('company research defaults OFF — the projection declares no research capability', (t) => {
  const db = makeStore(t);
  importFactsHelper(db);
  const context = buildDraftReplyContext(db, SOURCE);
  assert.equal(context.research, null);
  // Passing an explicit null/undefined is equivalent to omitting it.
  assert.equal(buildDraftReplyContext(db, SOURCE, null).research, null);
  assert.equal(buildDraftReplyContext(db, SOURCE, undefined).sourceStateSha256, context.sourceStateSha256);
});

test('normalizeCompanyResearch is fail-closed for absent descriptors', () => {
  assert.equal(normalizeCompanyResearch(undefined), null);
  assert.equal(normalizeCompanyResearch(null), null);
});

// -------------------------------------------------------------------------
// Enabled path: exact allowlist, digest-pinned, no network call.
// -------------------------------------------------------------------------

test('enabled research pins the exact allowlist into sourceStateSha256', (t) => {
  const db = makeStore(t);
  importFactsHelper(db);
  const base = buildDraftReplyContext(db, SOURCE);
  const withResearch = buildDraftReplyContext(db, SOURCE, research());
  // The declared research capability materially changes the pinned digest.
  assert.notEqual(withResearch.sourceStateSha256, base.sourceStateSha256);
  assert.equal(withResearch.research.capability, RESEARCH_CAPABILITY);
  assert.equal(withResearch.research.mode, 'brokered-read');
  assert.equal(withResearch.research.networkPolicyId, 'company-research-acme');
  // The digest pins the WHOLE validated policy, not just its id — a widened
  // allowlist with the same id would change networkPolicyDigest.
  assert.equal(withResearch.research.networkPolicyDigest, digest(POLICY));
  assert.deepEqual(withResearch.research.allowedOriginHosts, ['www.acme.example']);
  assert.deepEqual(withResearch.research.targets, [{ sourceKey: 'acme-about', url: 'https://www.acme.example/about/company' }]);
  // Pure read: building twice with the same descriptor is stable.
  assert.equal(buildDraftReplyContext(db, SOURCE, research()).sourceStateSha256, withResearch.sourceStateSha256);
});

test('issuing with research declares the broker capability but does NOT execute it', (t) => {
  const db = makeStore(t);
  importFactsHelper(db);
  const context = buildDraftReplyContext(db, SOURCE, research());
  const result = issueDraftReplyRequest(db, {
    requestId: 'req-research-1',
    issuedBy: 'Cole',
    expectedSourceStateSha256: context.sourceStateSha256,
    idempotencyKey: 'draft:issue:research:1',
    source: SOURCE,
    research: research()
  });
  // JobTrack never runs the model or the broker.
  assert.equal(result.executed, false);
  const req = result.request;
  // The declarative capability rides the request with the EXACT allowlist policy.
  assert.equal(req.research.capability, RESEARCH_CAPABILITY);
  assert.equal(req.research.mode, 'brokered-read');
  assert.equal(req.research.networkPolicyId, 'company-research-acme');
  assert.deepEqual(req.research.networkPolicy.allowedOrigins.map((o) => o.hostname), ['www.acme.example']);
  // Fetch-intent shells reference only allowlisted URLs — no headers, no body.
  assert.equal(req.research.fetchIntents.length, 1);
  assert.equal(req.research.fetchIntents[0].url, 'https://www.acme.example/about/company');
  assert.equal(req.research.fetchIntents[0].networkPolicyId, 'company-research-acme');
  // The request still forbids send/apply/execute effects.
  assert.ok(req.safety.forbiddenEffects.includes('send-email'));
  assert.equal(req.safety.externalActionsAllowed, false);
  // The request digest pins the declared research (its sourceStateSha256 matches
  // the research-inclusive context).
  assert.equal(req.sourceStateSha256, context.sourceStateSha256);
});

test('issuing with research fails closed when the pinned digest omits research', (t) => {
  const db = makeStore(t);
  importFactsHelper(db);
  // Operator pinned the NO-research digest but then declared research at issue —
  // the request's context now includes research, so the digests disagree.
  const noResearch = buildDraftReplyContext(db, SOURCE);
  assert.throws(() => issueDraftReplyRequest(db, {
    requestId: 'req-research-mismatch',
    issuedBy: 'Cole',
    expectedSourceStateSha256: noResearch.sourceStateSha256,
    idempotencyKey: 'draft:issue:research:mismatch',
    source: SOURCE,
    research: research()
  }), (error) => error instanceof EmailDraftReplyError && error.code === 'SOURCE_STATE_STALE');
});

// -------------------------------------------------------------------------
// Refusals: a non-allowlisted target, wrong capability/mode, bad policy.
// -------------------------------------------------------------------------

test('a non-allowlisted research target is REFUSED (origin outside the allowlist)', () => {
  assert.throws(() => normalizeCompanyResearch(research({
    targets: [{ sourceKey: 'evil', url: 'https://evil.example/about/company' }]
  })), (error) => error instanceof EmailDraftReplyError && error.code === 'RESEARCH_TARGET_DENIED');
});

test('a target on the allowlisted host but a non-allowlisted PATH is REFUSED', () => {
  assert.throws(() => normalizeCompanyResearch(research({
    targets: [{ sourceKey: 'careers', url: 'https://www.acme.example/careers/openings' }]
  })), (error) => error instanceof EmailDraftReplyError && error.code === 'RESEARCH_TARGET_DENIED');
});

test('a non-HTTPS or credentialed research target is REFUSED', () => {
  for (const url of ['http://www.acme.example/about/x', 'https://user:pass@www.acme.example/about/x']) {
    assert.throws(() => normalizeCompanyResearch(research({ targets: [{ sourceKey: 'x', url }] })),
      (error) => error instanceof EmailDraftReplyError && error.code === 'RESEARCH_TARGET_DENIED');
  }
});

test('an exact-allowlisted path is permitted (positive control for the gate)', () => {
  const ok = normalizeCompanyResearch(research({
    targets: [{ sourceKey: 'acme-press', url: 'https://www.acme.example/press' }]
  }));
  assert.equal(ok.targets[0].url, 'https://www.acme.example/press');
});

test('a wrong capability is REFUSED (never raw internet)', () => {
  assert.throws(() => normalizeCompanyResearch(research({ capability: 'raw-internet' })),
    (error) => error instanceof EmailDraftReplyError && error.code === 'RESEARCH_CAPABILITY_DENIED');
});

test('a non-read mode is REFUSED', () => {
  assert.throws(() => normalizeCompanyResearch(research({ mode: 'brokered-write' })),
    (error) => error instanceof EmailDraftReplyError && error.code === 'RESEARCH_MODE_DENIED');
});

test('a malformed / private broker policy is REFUSED', () => {
  // A private/local origin is refused by the broker's own network policy validator.
  const badPolicy = JSON.parse(JSON.stringify(POLICY));
  badPolicy.allowedOrigins[0].hostname = 'localhost';
  assert.throws(() => normalizeCompanyResearch(research({ networkPolicy: badPolicy })),
    (error) => error instanceof EmailDraftReplyError
      && (error.code === 'RESEARCH_POLICY_INVALID' || error.code === 'RESEARCH_TARGET_DENIED'));
});

test('a research descriptor that smuggles an effect key is REFUSED', () => {
  assert.throws(() => normalizeCompanyResearch({
    capability: RESEARCH_CAPABILITY,
    networkPolicy: JSON.parse(JSON.stringify(POLICY)),
    targets: [{ sourceKey: 'acme-about', url: 'https://www.acme.example/about/company' }],
    credential: 'secret-token'
  }), (error) => error instanceof EmailDraftReplyError);
});

test('too many research targets are REFUSED', () => {
  const targets = Array.from({ length: MAX_RESEARCH_TARGETS + 1 }, (_unused, index) => ({
    sourceKey: `t${index}`, url: 'https://www.acme.example/about/company'
  }));
  assert.throws(() => normalizeCompanyResearch(research({ targets })),
    (error) => error instanceof EmailDraftReplyError && error.code === 'INVALID_ARGUMENT');
});

test('a broker-incompatible sourceKey (uppercase/colon) is REFUSED', () => {
  assert.throws(() => normalizeCompanyResearch(research({
    targets: [{ sourceKey: 'Acme:About', url: 'https://www.acme.example/about/company' }]
  })), (error) => error instanceof EmailDraftReplyError && error.code === 'INVALID_ARGUMENT');
});

// -------------------------------------------------------------------------
// CLI surface: --research composes into draft-reply-context via the sole writer.
// -------------------------------------------------------------------------

test('the draft-reply-context CLI verb accepts an optional --research file and pins it', (t) => {
  const { root: dir, home } = createTestStore('jobtrack-research-cli-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const researchFile = path.join(dir, 'research.json');
  fs.writeFileSync(researchFile, JSON.stringify(research()));

  // Import and context generation still run through the real CLI.
  const factsFile = path.join(dir, 'facts.json');
  fs.writeFileSync(factsFile, JSON.stringify(makeFacts()));
  execFileSync(process.execPath, [cli, 'email', 'import-facts', '--input', factsFile, '--idempotency-key', 'facts:cli', '--json'],
    { env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8' });

  const withResearch = execFileSync(process.execPath,
    [cli, 'email', 'draft-reply-context', '--provider', 'fixture', '--account-id', 'cole@example.test',
      '--message-id', 'message-1', '--thread-id', 'thread-1', '--research', researchFile, '--json'],
    { env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8' });
  const parsed = JSON.parse(withResearch);
  const ctx = parsed.result ? parsed.result.context : parsed.context;
  assert.equal(ctx.research.capability, RESEARCH_CAPABILITY);
  assert.deepEqual(ctx.research.allowedOriginHosts, ['www.acme.example']);
  assert.match(ctx.sourceStateSha256, /^[a-f0-9]{64}$/);

  const withoutResearch = execFileSync(process.execPath,
    [cli, 'email', 'draft-reply-context', '--provider', 'fixture', '--account-id', 'cole@example.test',
      '--message-id', 'message-1', '--thread-id', 'thread-1', '--json'],
    { env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8' });
  const parsedNo = JSON.parse(withoutResearch);
  const ctxNo = parsedNo.result ? parsedNo.result.context : parsedNo.context;
  assert.equal(ctxNo.research, null);
  assert.notEqual(ctxNo.sourceStateSha256, ctx.sourceStateSha256);
});
