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

const { validateCorrelationResultV3 } = require('../lib/email-contracts');
const { correlateEmailReadOnly, importFacts, recordCorrelation } = require('../lib/email-integration');
const { normalizeText, tokenJaccard } = require('../lib/email-correlation/normalize');
const { DEFAULT_POLICY, LEGACY_DEFAULT_POLICY, LEGACY_DEFAULT_POLICY_DIGEST, POLICY_DOCUMENT_VERSION, POLICY_MIGRATION_NAME, POLICY_SCHEMA_VERSION, createPolicyRevisionsTable, insertPolicyRevision, loadPolicy, migrateCorrelationPolicy, upgradePolicyDocument, validatePolicy } = require('../lib/email-correlation/policy');
const { resolve } = require('../lib/email-correlation/resolve');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');
const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/email-correlation/golden-corpus.json'), 'utf8'));
const arc3 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/email-correlation/arc3-facts.json'), 'utf8'));
const arc4 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/email-correlation/arc4-facts.json'), 'utf8'));

const GOLDEN_ENTRY_KEYS = Object.freeze(['expected', 'facts', 'name', 'record', 'store']);
const ARCHIVE_ENTRY_KEYS = Object.freeze(['expected', 'facts', 'messageRefId', 'name', 'record', 'store']);
const STORE_KEYS = Object.freeze(['activityAt', 'applications', 'companyDomains', 'priorThreadLink']);
const APPLICATION_KEYS = Object.freeze(['company', 'key', 'role', 'status']);
const PRIOR_THREAD_LINK_KEYS = Object.freeze(['application', 'threadId']);
const EXPECTED_KEYS = Object.freeze([
  'automaticEligible', 'candidateOrder', 'clarifiable', 'identity', 'learnedRows',
  'preferredApplication', 'resolution', 'resolvedApplication', 'resolvedBasis'
]);
const EXPECTED_KEYS_WITH_IDENTIFIERS = Object.freeze([...EXPECTED_KEYS, 'externalIdentifierRows']);
const IDENTITY_KEYS = Object.freeze(['basis', 'companyIds', 'confidence']);
const LEARNED_ROW_KEYS = Object.freeze([
  'actor', 'application', 'company', 'kind', 'normalizedValue', 'retracted',
  'sourceCorrelation', 'sourceMessage', 'value'
]);
const EXTERNAL_IDENTIFIER_ROW_KEYS = Object.freeze([
  'active', 'application', 'confirmedBy', 'namespace', 'provenanceKind',
  'sourceCorrelation', 'sourceMessage', 'value'
]);

function runCli(home, args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], {
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8'
  }));
}

function createStore(t, { cold = false } = {}) {
  const copied = cold ? null : createTestStore('jobtrack-r3-');
  const parent = copied?.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-r3-'));
  const home = copied?.home ?? path.join(parent, 'store');
  if (cold) runCli(home, ['init']);
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  t.after(() => { db.close(); fs.rmSync(parent, { recursive: true, force: true }); });
  return { home, db };
}

function installStoreState(fixture, state) {
  const applicationIds = {};
  for (const application of state.applications) {
    const created = runCli(fixture.home, [
      'add-application', '--company', application.company, '--role', application.role,
      '--status', application.status
    ]).application;
    applicationIds[application.key] = created.id;
    fixture.db.prepare(`
      UPDATE applications SET created_at=?, updated_at=?, status_changed_at=? WHERE id=?
    `).run(state.activityAt, state.activityAt, state.activityAt, created.id);
  }
  for (const [company, domain] of Object.entries(state.companyDomains || {})) {
    fixture.db.prepare('UPDATE companies SET website_domain=? WHERE normalized_name=?')
      .run(domain, normalizeText(company));
  }
  const sourceMessageKeys = new Map();
  if (state.priorThreadLink) {
    const seed = factsFor('prior-thread-seed', {
      source: { messageId: 'prior-thread-message', threadId: state.priorThreadLink.threadId },
      eventKind: 'recruiter_followup', company: undefined, postingRefs: [], replyRequested: false,
      evidence: [{ field: 'subject', excerpt: 'Original subject' }]
    });
    const imported = importFacts(fixture.db, seed, `golden:${state.priorThreadLink.threadId}:seed`);
    fixture.db.prepare('INSERT INTO job_email_application_links(message_ref_id,application_id,relation) VALUES (?,?,?)')
      .run(imported.messageRefId, applicationIds[state.priorThreadLink.application], 'golden_fixture');
    sourceMessageKeys.set(imported.messageRefId, 'priorThreadSeed');
  }
  const companyNames = new Map(fixture.db.prepare('SELECT id, canonical_name FROM companies ORDER BY id').all()
    .map((row) => [Number(row.id), row.canonical_name]));
  return { applicationIds, companyNames, sourceMessageKeys };
}

function factsFor(name, overrides) {
  const source = overrides.source || {};
  return {
    schemaVersion: 'job-application-email-facts.v2',
    trust: 'untrusted_external',
    source: {
      provider: 'gmail_gog', accountId: 'applicant@example.test',
      messageId: source.messageId || name, threadId: source.threadId || name,
      receivedAt: '2026-09-02T20:00:00.000Z',
      fromAddress: source.fromAddress || 'sender@example.test',
      fromDomain: source.fromDomain || 'example.test',
      ...(source.fromDisplayName ? { fromDisplayName: source.fromDisplayName } : {}),
      contentDigest: crypto.createHash('sha256').update(name).digest('hex')
    },
    contentCompleteness: 'sanitized_plain_text',
    eventKind: overrides.eventKind,
    ...(overrides.company ? { company: overrides.company } : {}),
    postingRefs: overrides.postingRefs || [],
    applicationRefs: overrides.applicationRefs || [],
    replyRequested: overrides.replyRequested,
    evidence: overrides.evidence,
    extraction: { provider: 'inbox-pipeline', version: 'email-mentions.v1', confidence: 0.9 },
    security: { risk: 'medium', requiresReview: true }
  };
}

function assertExactKeys(value, expected, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has exact keys`);
}

function validateFixtureEntry(entry, manifest) {
  assertExactKeys(entry, manifest.entryKeys, `${manifest.name}:${entry?.name || '<unnamed>'}`);
  assert.equal(typeof entry.name, 'string');
  assert.ok(entry.name.length > 0);
  assert.equal(typeof entry.record, 'boolean', `${manifest.name}:${entry.name}.record`);
  if (manifest.entryKeys === ARCHIVE_ENTRY_KEYS) {
    assert.ok(Number.isInteger(entry.messageRefId) && entry.messageRefId > 0,
      `${manifest.name}:${entry.name}.messageRefId`);
  }
  assertExactKeys(entry.store, STORE_KEYS, `${manifest.name}:${entry.name}.store`);
  assert.equal(typeof entry.store.activityAt, 'string');
  assert.ok(Number.isFinite(Date.parse(entry.store.activityAt)), `${manifest.name}:${entry.name}.store.activityAt`);
  assert.ok(Array.isArray(entry.store.applications));
  const applicationKeys = new Set();
  const companyNames = new Set();
  for (const application of entry.store.applications) {
    assertExactKeys(application, APPLICATION_KEYS, `${manifest.name}:${entry.name}.store.application`);
    assert.ok(!applicationKeys.has(application.key), `${manifest.name}:${entry.name} has unique application keys`);
    applicationKeys.add(application.key);
    companyNames.add(application.company);
  }
  assert.ok(entry.store.companyDomains && typeof entry.store.companyDomains === 'object'
    && !Array.isArray(entry.store.companyDomains), `${manifest.name}:${entry.name}.store.companyDomains must be an object`);
  for (const [company, domain] of Object.entries(entry.store.companyDomains)) {
    assert.ok(companyNames.has(company), `${manifest.name}:${entry.name} companyDomains key ${company} is declared`);
    assert.ok(typeof domain === 'string' && domain.length > 0,
      `${manifest.name}:${entry.name} companyDomains value for ${company}`);
  }
  if (entry.store.priorThreadLink !== null) {
    assertExactKeys(entry.store.priorThreadLink, PRIOR_THREAD_LINK_KEYS,
      `${manifest.name}:${entry.name}.store.priorThreadLink`);
    assert.ok(applicationKeys.has(entry.store.priorThreadLink.application),
      `${manifest.name}:${entry.name}.store.priorThreadLink application is declared`);
  }
  const hasApplicationReferences = Array.isArray(entry.facts.applicationRefs)
    && entry.facts.applicationRefs.length > 0;
  assertExactKeys(entry.expected, hasApplicationReferences ? EXPECTED_KEYS_WITH_IDENTIFIERS : EXPECTED_KEYS,
    `${manifest.name}:${entry.name}.expected`);
  assertExactKeys(entry.expected.identity, IDENTITY_KEYS, `${manifest.name}:${entry.name}.expected.identity`);
  assert.ok(entry.expected.identity.companyIds.every((company) => companyNames.has(company)),
    `${manifest.name}:${entry.name}.expected.identity companies are declared`);
  assert.equal(typeof entry.expected.automaticEligible, 'boolean');
  assert.equal(typeof entry.expected.clarifiable, 'boolean');
  assert.ok(entry.expected.preferredApplication === null
    || applicationKeys.has(entry.expected.preferredApplication),
    `${manifest.name}:${entry.name}.expected.preferredApplication is null or declared`);
  assert.ok(entry.expected.resolvedApplication === null
    || applicationKeys.has(entry.expected.resolvedApplication),
    `${manifest.name}:${entry.name}.expected.resolvedApplication is null or declared`);
  assert.ok(entry.expected.resolvedBasis === null || typeof entry.expected.resolvedBasis === 'string');
  assert.ok(Array.isArray(entry.expected.candidateOrder));
  for (const candidate of entry.expected.candidateOrder) {
    assert.ok(Array.isArray(candidate) && candidate.length === 2,
      `${manifest.name}:${entry.name}.expected.candidateOrder entry`);
    assert.ok(applicationKeys.has(candidate[0]),
      `${manifest.name}:${entry.name}.expected candidate application ${candidate[0]} is declared`);
    assert.ok(typeof candidate[1] === 'string' && candidate[1].length > 0,
      `${manifest.name}:${entry.name}.expected candidate basis`);
  }
  assert.ok(Array.isArray(entry.expected.learnedRows));
  for (const row of entry.expected.learnedRows) {
    assertExactKeys(row, LEARNED_ROW_KEYS, `${manifest.name}:${entry.name}.expected.learnedRows entry`);
    assert.ok(row.company === null || companyNames.has(row.company),
      `${manifest.name}:${entry.name}.expected learning company is null or declared`);
    assert.ok(row.application === null || applicationKeys.has(row.application),
      `${manifest.name}:${entry.name}.expected learning application is null or declared`);
    assert.ok(row.sourceMessage === 'current' || row.sourceMessage === 'priorThreadSeed',
      `${manifest.name}:${entry.name}.expected learning source message is stable`);
    assert.ok(row.sourceCorrelation === null || row.sourceCorrelation === 'current',
      `${manifest.name}:${entry.name}.expected learning source correlation is stable`);
  }
  if (hasApplicationReferences) {
    assert.ok(Array.isArray(entry.expected.externalIdentifierRows));
    for (const row of entry.expected.externalIdentifierRows) {
      assertExactKeys(row, EXTERNAL_IDENTIFIER_ROW_KEYS,
        `${manifest.name}:${entry.name}.expected.externalIdentifierRows entry`);
    }
  }
}

function requiredMapValue(map, key, label) {
  const value = map instanceof Map ? map.get(key) : Object.keys(map).find((name) => map[name] === key);
  assert.notEqual(value, undefined, `${label} ${key} must be declared by fixture store state`);
  return value;
}

function projectCorrelation(correlation, state) {
  const applicationKey = (id) => requiredMapValue(state.applicationIds, Number(id), 'application id');
  const companyName = (id) => requiredMapValue(state.companyNames, Number(id), 'company id');
  return {
    identity: {
      companyIds: correlation.identity.companyIds.map(companyName),
      basis: correlation.identity.basis,
      confidence: correlation.identity.confidence
    },
    resolution: correlation.resolution,
    automaticEligible: correlation.automaticEligible,
    clarifiable: correlation.clarifiable,
    preferredApplication: correlation.preferredCandidateId
      ? applicationKey(correlation.preferredCandidateId)
      : null,
    resolvedApplication: correlation.resolved ? applicationKey(correlation.resolved.applicationId) : null,
    resolvedBasis: correlation.resolved?.matchBasis || null,
    candidateOrder: correlation.candidates.map((candidate) => [
      applicationKey(candidate.applicationId), candidate.matchBasis
    ])
  };
}

function projectLearnedRows(fixture, state, current) {
  const applicationKey = (id) => id === null
    ? null
    : requiredMapValue(state.applicationIds, Number(id), 'learning application id');
  const companyName = (id) => id === null
    ? null
    : requiredMapValue(state.companyNames, Number(id), 'learning company id');
  const sourceMessage = (id) => {
    if (current.messageRefId === Number(id)) return 'current';
    return requiredMapValue(state.sourceMessageKeys, Number(id), 'learning source message id');
  };
  const sourceCorrelation = (id) => {
    if (id === null) return null;
    assert.equal(Number(id), current.correlationId, 'learning source correlation must be the current recorded correlation');
    return 'current';
  };
  return fixture.db.prepare('SELECT * FROM email_identity_learnings ORDER BY id').all().map((row) => ({
    kind: row.kind,
    company: companyName(row.company_id),
    application: applicationKey(row.application_id),
    value: row.value,
    normalizedValue: row.normalized_value,
    sourceMessage: sourceMessage(row.source_message_ref_id),
    sourceCorrelation: sourceCorrelation(row.source_correlation_id),
    actor: row.actor,
    retracted: row.retracted_at !== null
  }));
}

function projectExternalIdentifierRows(fixture, state, current) {
  const applicationKey = (id) => requiredMapValue(
    state.applicationIds, Number(id), 'identifier application id'
  );
  const sourceMessage = (id) => {
    if (current.messageRefId === Number(id)) return 'current';
    return requiredMapValue(state.sourceMessageKeys, Number(id), 'identifier source message id');
  };
  return fixture.db.prepare(`
    SELECT identifier.*,
      NOT EXISTS (
        SELECT 1 FROM email_link_retractions retraction
        WHERE retraction.message_ref_id=identifier.source_message_ref_id
          AND (retraction.application_id IS NULL OR retraction.application_id=identifier.application_id)
      ) AS active
    FROM application_external_identifiers identifier ORDER BY identifier.id
  `).all().map((row) => {
    assert.equal(Number(row.source_correlation_id), current.correlationId,
      'identifier source correlation must be the current recorded correlation');
    return {
      application: applicationKey(row.application_id),
      namespace: row.namespace,
      value: row.value,
      provenanceKind: row.provenance_kind,
      sourceMessage: sourceMessage(row.source_message_ref_id),
      sourceCorrelation: 'current',
      confirmedBy: row.confirmed_by,
      active: Boolean(row.active)
    };
  });
}

const fixtureManifests = Object.freeze([
  { name: 'golden', entries: corpus.cases, entryKeys: GOLDEN_ENTRY_KEYS, buildFacts: (entry) => factsFor(entry.name, entry.facts) },
  { name: 'arc3', entries: arc3, entryKeys: ARCHIVE_ENTRY_KEYS, buildFacts: (entry) => entry.facts },
  { name: 'arc4', entries: arc4, entryKeys: ARCHIVE_ENTRY_KEYS, buildFacts: (entry) => entry.facts }
]);

test('strict email-correlation fixture manifests match complete resolution, candidate, and learning oracles', async (t) => {
  assertExactKeys(corpus, ['cases', 'schemaVersion'], 'golden manifest');
  assert.equal(corpus.schemaVersion, 'jobtrack-email-correlation-golden-corpus.v1');
  assert.ok(Array.isArray(corpus.cases));
  assert.ok(Array.isArray(arc3));
  assert.ok(Array.isArray(arc4));

  for (const manifest of fixtureManifests) {
    await t.test(manifest.name, async (manifestTest) => {
      assert.equal(new Set(manifest.entries.map((entry) => entry.name)).size, manifest.entries.length,
        `${manifest.name} fixture names are unique`);
      if (manifest.entryKeys === ARCHIVE_ENTRY_KEYS) {
        assert.equal(new Set(manifest.entries.map((entry) => entry.messageRefId)).size, manifest.entries.length,
          `${manifest.name} archived message refs are unique`);
      }
      for (const entry of manifest.entries) {
        await manifestTest.test(entry.name, (caseTest) => {
          validateFixtureEntry(entry, manifest);
          const fixture = createStore(caseTest);
          const state = installStoreState(fixture, entry.store);
          const facts = manifest.buildFacts(entry);
          const correlation = correlateEmailReadOnly(fixture.db, facts);
          assert.equal(correlation.schemaVersion, 'jobtrack-correlation-result.v3');
          assert.equal(correlation.policyRevisionId, 1);

          const current = { messageRefId: null, correlationId: null };
          if (entry.record) {
            current.messageRefId = importFacts(fixture.db, facts, `${manifest.name}:${entry.name}:import`).messageRefId;
            state.sourceMessageKeys.set(current.messageRefId, 'current');
            current.correlationId = recordCorrelation(
              fixture.db, correlation, `${manifest.name}:${entry.name}:record`
            ).correlationId;
          }

          const actual = {
            ...projectCorrelation(correlation, state),
            learnedRows: projectLearnedRows(fixture, state, current)
          };
          if (Array.isArray(entry.facts.applicationRefs) && entry.facts.applicationRefs.length > 0) {
            actual.externalIdentifierRows = projectExternalIdentifierRows(fixture, state, current);
          }
          assert.deepEqual(actual, entry.expected);

          if (manifest.name === 'arc4') {
            assert.ok(correlation.candidates.some((candidate) => candidate.matchBasis === 'company_domain'),
              `arc4 message ${entry.messageRefId} has sender-domain evidence and does not rely on its subject alone`);
          }
          if (entry.name === 'applysim_reference_only_single_open') {
            assert.equal(correlation.resolved?.matchBasis, 'company_single_open');
            assert.ok(correlation.candidates.some((candidate) => candidate.matchBasis === 'company_mention'),
              'the reference-only fixture is grounded by the company signature, not its novel subject reference');
            assert.ok(!correlation.candidates.some((candidate) => candidate.matchBasis === 'company_domain'),
              'the fresh manual ingest has no pre-seeded Drove domain association');
            assert.ok(!correlation.candidates.some((candidate) => candidate.matchBasis === 'provider_application_id'),
              'a novel bracket reference is not treated as a previously learned exact identifier');
          }
        });
      }
    });
  }
});

test('shared normalization applies NFKC, non-locale lower-case, symbol spacing, and token similarity', () => {
  const asset = JSON.parse(fs.readFileSync(path.join(root, 'contracts/email/text-normalization.v1.json'), 'utf8'));
  assert.deepEqual(asset, {
    ruleSetVersion: 'email-correlation-text-normalization.v1', unicodeNormalization: 'NFKC',
    caseFold: 'lower', punctuation: 'space', whitespace: 'collapse', trim: true
  });
  assert.equal(normalizeText('  ＰＬＡＴＦＯＲＭ—Engineer©\n'), 'platform engineer');
  assert.equal(tokenJaccard('Platform Engineer', 'Engineer, Platform'), 1);
});

test('policy revisions are seeded, digest-checked, immutable data and reject structural drift', (t) => {
  // Exercise initial policy seeding through the real cold CLI migration.
  const fixture = createStore(t, { cold: true });
  const migration = fixture.db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?').get(POLICY_SCHEMA_VERSION);
  assert.equal(migration.name, POLICY_MIGRATION_NAME);
  const policy = loadPolicy(fixture.db);
  assert.equal(policy.revisionId, 1);
  assert.deepEqual(JSON.parse(JSON.stringify({ ...policy, revisionId: undefined, revision: undefined, digest: undefined }, (key, value) => value)), DEFAULT_POLICY);
  assert.throws(() => fixture.db.prepare('UPDATE email_correlation_policy_revisions SET created_by=? WHERE id=1').run('tamper'), /append-only/);
  assert.throws(() => fixture.db.prepare('DELETE FROM email_correlation_policy_revisions WHERE id=1').run(), /append-only/);
  assert.throws(() => validatePolicy({ ...DEFAULT_POLICY, surprise: true }), /unexpected keys/);
  assert.throws(() => validatePolicy({ ...DEFAULT_POLICY, thresholds: { ...DEFAULT_POLICY.thresholds, titleSimilarity: 1.5 } }), /titleSimilarity/);
});

test('the dead clarify.secondNudge knob is gone from the document, and stores seeded under v1 stay loadable', (t) => {
  assert.equal(DEFAULT_POLICY.schemaVersion, 'email-correlation-policy.v2');
  assert.equal('secondNudge' in DEFAULT_POLICY.clarify, false);
  assert.throws(() => validatePolicy({ ...DEFAULT_POLICY, clarify: { ...DEFAULT_POLICY.clarify, secondNudge: false } }), /policy\.clarify has unexpected keys/,
    'a current document may not carry the removed key');
  // What every store seeded between 2026-09-03 and 2026-09-05 holds as its
  // immutable revision 1: the v1 default, with the knob, at exactly this digest.
  assert.equal(LEGACY_DEFAULT_POLICY.schemaVersion, 'email-correlation-policy.v1');
  assert.equal(LEGACY_DEFAULT_POLICY.clarify.secondNudge, false);
  assert.equal(LEGACY_DEFAULT_POLICY_DIGEST, '99954b0ea731b8a30e1d6cb4e5bc482aa8535d128e2c793934f33e1e654e03fa');

  // Keep this legacy-policy migration replay independent of the copied template.
  // Rebuild such a store: the migration row already exists, revision 1 is the v1 document.
  const fixture = createStore(t, { cold: true });
  fixture.db.exec('DROP TABLE email_correlation_policy_revisions');
  createPolicyRevisionsTable(fixture.db);
  const legacyJson = JSON.stringify(LEGACY_DEFAULT_POLICY);
  fixture.db.prepare(`
    INSERT INTO email_correlation_policy_revisions (policy_key,revision,policy_json,policy_digest,created_by)
    VALUES ('default',1,?,?,'jobtrack:default')
  `).run(legacyJson, LEGACY_DEFAULT_POLICY_DIGEST);
  assert.doesNotThrow(() => migrateCorrelationPolicy(fixture.db), 'replaying the migration accepts the legacy revision 1');
  assert.equal(fixture.db.prepare("SELECT count(*) AS n FROM email_correlation_policy_revisions").get().n, 1, 'no second default is seeded');

  const loaded = loadPolicy(fixture.db);
  assert.equal(loaded.revisionId, 1);
  assert.equal(loaded.digest, LEGACY_DEFAULT_POLICY_DIGEST, 'the digest is checked over the bytes as stored');
  assert.equal(loaded.schemaVersion, POLICY_DOCUMENT_VERSION, 'the runtime sees the current shape');
  assert.equal('secondNudge' in loaded.clarify, false);
  assert.deepEqual(JSON.parse(JSON.stringify({ ...loaded, revisionId: undefined, revision: undefined, digest: undefined }, (key, value) => value)), DEFAULT_POLICY,
    'the legacy default and the current default are the same policy');

  // A new revision written from the old document comes out in the current shape.
  const next = insertPolicyRevision(fixture.db, { ...LEGACY_DEFAULT_POLICY, clarify: { ...LEGACY_DEFAULT_POLICY.clarify, expiryDays: 5 } }, 'test');
  assert.equal(next.revision, 2);
  assert.equal(next.clarify.expiryDays, 5);
  const storedNext = JSON.parse(fixture.db.prepare('SELECT policy_json FROM email_correlation_policy_revisions WHERE id=?').get(next.revisionId).policy_json);
  assert.equal(storedNext.schemaVersion, POLICY_DOCUMENT_VERSION);
  assert.equal('secondNudge' in storedNext.clarify, false);
  assert.deepEqual(upgradePolicyDocument(DEFAULT_POLICY), DEFAULT_POLICY, 'a current document upgrades to itself');
  // A stored v1 revision is validated as written: a v1 document with a
  // non-boolean knob is still a broken document.
  assert.throws(() => validatePolicy({ ...LEGACY_DEFAULT_POLICY, clarify: { ...LEGACY_DEFAULT_POLICY.clarify, secondNudge: 'yes' } }), /secondNudge must be boolean/);
});

test('recording replays the stamped policy and an unconfirmed single-open link teaches nothing', (t) => {
  const fixture = createStore(t);
  runCli(fixture.home, ['add-application', '--company', 'Acme', '--role', 'Platform Engineer', '--status', 'applied']);
  fixture.db.prepare("UPDATE companies SET website_domain='acme.test' WHERE normalized_name='acme'").run();
  const facts = factsFor('stamped-policy', {
    source: { fromAddress: 'jobs@acme.test', fromDomain: 'acme.test' },
    eventKind: 'application_received', company: { name: 'Acme', domain: 'acme.test' },
    postingRefs: [], replyRequested: false,
    evidence: [{ field: 'subject', excerpt: 'Application received' }]
  });
  const underRevisionOne = correlateEmailReadOnly(fixture.db, facts);
  assert.equal(underRevisionOne.resolution, 'linked');
  assert.equal(underRevisionOne.resolved.matchBasis, 'company_single_open');
  importFacts(fixture.db, facts, 'stamped-policy:import');

  const revisionTwo = insertPolicyRevision(fixture.db, {
    ...DEFAULT_POLICY,
    autoLink: { ...DEFAULT_POLICY.autoLink, companySingleOpen: false }
  }, 'test');
  assert.equal(revisionTwo.revisionId, 2);
  assert.equal(correlateEmailReadOnly(fixture.db, facts).resolution, 'ambiguous', 'the newest revision is active for new work');
  assert.doesNotThrow(() => recordCorrelation(fixture.db, underRevisionOne, 'stamped-policy:record'),
    'the previously produced result replays under its own stamped revision');
  assert.equal(fixture.db.prepare('SELECT count(*) AS n FROM email_identity_learnings').get().n, 0,
    'a review-required company_single_open result is not confirmed learning');
});

test('resolver is pure, aggregates by application, and honors policy switches', () => {
  const candidate = (applicationId, matchBasis, confidence, companyId = 9) => ({
    applicationId, applicationVersion: 0, companyId, matchBasis, confidence, reasons: ['test']
  });
  const policy = { ...DEFAULT_POLICY, revisionId: 1 };
  const exact = candidate(1, 'provider_application_id', 1);
  assert.deepEqual(resolve([exact], { companyIds: [9] }, policy), {
    resolution: 'linked', resolved: exact, automaticEligible: true, clarifiable: false
  });
  const disabled = { ...policy, autoLink: { ...policy.autoLink, normalizedExact: false } };
  assert.equal(resolve([exact], { companyIds: [9] }, disabled).automaticEligible, false);
  const thread = candidate(1, 'previously_linked_thread', 0.99);
  const contradictoryBody = candidate(2, 'body_role_title', 0.95);
  assert.deepEqual(resolve([thread, contradictoryBody], { companyIds: [9] }, policy), {
    resolution: 'ambiguous', preferredCandidateId: 2,
    automaticEligible: false, clarifiable: false
  }, 'a provider-coalesced thread cannot silently override one grounded role for another application');
  assert.equal(resolve([thread, candidate(1, 'body_role_title', 0.95)], { companyIds: [9] }, policy).resolution, 'linked',
    'a grounded role that agrees with the thread preserves the exact link');
  assert.equal(resolve([thread], { companyIds: [9] }, policy).resolution, 'linked',
    'a thread with no contradictory grounded role preserves existing behavior');
  assert.equal(resolve([thread, contradictoryBody, exact], { companyIds: [9] }, policy).resolution, 'linked',
    'a non-thread exact identifier for the same application remains authoritative');
  const body = candidate(1, 'body_role_title', 0.9);
  const runner = candidate(2, 'company_domain', 0.5);
  const ambiguous = resolve([body, runner, candidate(1, 'company_domain', 0.5)], {
    companyIds: [9], messageClarifiable: true
  }, policy);
  assert.equal(ambiguous.resolution, 'ambiguous');
  assert.equal(ambiguous.preferredCandidateId, 1);
  assert.equal(ambiguous.clarifiable, false, 'a policy winner goes to the agent; only no-winner ambiguity asks the sender');
  const tied = resolve([candidate(1, 'company_domain', 0.5), candidate(2, 'company_domain', 0.5)], {
    companyIds: [9], messageClarifiable: true
  }, policy);
  assert.equal(tied.preferredCandidateId, undefined);
  assert.equal(tied.clarifiable, true);
});

test('v3 validator enforces identity, preferred application, clarification, and one-way automatic eligibility', () => {
  const base = {
    schemaVersion: 'jobtrack-correlation-result.v3',
    source: { provider: 'gmail_gog', accountId: 'a@example.test', messageId: 'm', threadId: 't' },
    factsDigest: 'a'.repeat(64), policyRevisionId: 1,
    identity: { companyIds: [7], basis: 'domain', confidence: 0.75 },
    resolution: 'ambiguous',
    candidates: [
      { applicationId: 1, applicationVersion: 0, companyId: 7, matchBasis: 'company_domain', confidence: 0.5, reasons: ['one'] },
      { applicationId: 2, applicationVersion: 0, companyId: 7, matchBasis: 'company_domain', confidence: 0.5, reasons: ['two'] }
    ],
    evidence: [], automaticEligible: false, clarifiable: true, preferredCandidateId: 1
  };
  assert.deepEqual(validateCorrelationResultV3(base), base);
  assert.throws(() => validateCorrelationResultV3({ ...base, preferredCandidateId: 99 }), /candidate applicationId/);
  assert.throws(() => validateCorrelationResultV3({ ...base, candidates: [base.candidates[0]], clarifiable: true }), /at least two applications/);
  assert.throws(() => validateCorrelationResultV3({ ...base, identity: { companyIds: [], basis: 'domain', confidence: 0.75 } }), /requires company ids/);
  const exact = base.candidates[0];
  const linkedNonExact = { ...base, resolution: 'linked', resolved: exact, candidates: [exact], automaticEligible: false, clarifiable: false };
  delete linkedNonExact.preferredCandidateId;
  assert.deepEqual(validateCorrelationResultV3(linkedNonExact), linkedNonExact, 'false remains allowed because policy may disable automation');
  assert.throws(() => validateCorrelationResultV3({ ...linkedNonExact, automaticEligible: true }), /exact normalized/);
});

test('body-role matching consumes learned company wording and stage/recency adjust only existing candidates', (t) => {
  const fixture = createStore(t);
  const platform = runCli(fixture.home, ['add-application', '--company', 'Globex', '--role', 'Platform Engineer', '--status', 'applied']).application.id;
  const sre = runCli(fixture.home, ['add-application', '--company', 'Globex', '--role', 'Site Reliability Engineer', '--status', 'interviewing']).application.id;
  const companyId = fixture.db.prepare("SELECT id FROM companies WHERE normalized_name='globex'").get().id;
  fixture.db.prepare('UPDATE companies SET website_domain=? WHERE id=?').run('globex.test', companyId);
  fixture.db.prepare('INSERT INTO application_title_aliases(application_id,alias,normalized_alias) VALUES (?,?,?)')
    .run(platform, 'data plane role', 'data plane role');
  const aliasFacts = factsFor('learned-alias', {
    source: { fromAddress: 'recruiter@globex.test', fromDomain: 'globex.test' },
    eventKind: 'recruiter_followup', company: { name: 'Globex', domain: 'globex.test' },
    postingRefs: [{ roleTitle: 'data plane role' }], replyRequested: true,
    evidence: [{ field: 'subject', excerpt: 'Welcome Chat' }, { field: 'body', excerpt: 'This is about the data plane role.' }]
  });
  const alias = correlateEmailReadOnly(fixture.db, aliasFacts);
  assert.equal(alias.candidates[0].applicationId, platform);
  assert.equal(alias.candidates[0].matchBasis, 'body_role_title');

  const offerFacts = factsFor('stage-modifier', {
    source: { fromAddress: 'recruiter@globex.test', fromDomain: 'globex.test' },
    eventKind: 'offer', company: { name: 'Globex', domain: 'globex.test' },
    postingRefs: [], replyRequested: true,
    evidence: [{ field: 'subject', excerpt: 'Next steps' }, { field: 'body', excerpt: 'We have an update.' }]
  });
  const offer = correlateEmailReadOnly(fixture.db, offerFacts);
  const mentionCandidates = offer.candidates.filter((candidate) => candidate.matchBasis === 'company_mention');
  assert.deepEqual(mentionCandidates.map((candidate) => candidate.applicationId), [sre, platform]);
  assert.ok(mentionCandidates[0].confidence > mentionCandidates[1].confidence);
});

test('company identity and legacy similarity bases never offer closed applications', (t) => {
  const fixture = createStore(t);
  const open = runCli(fixture.home, [
    'add-application', '--company', 'Globex', '--role', 'Platform Engineer', '--status', 'applied'
  ]).application.id;
  const rejected = runCli(fixture.home, [
    'add-application', '--company', 'Globex', '--role', 'Site Reliability Engineer', '--status', 'rejected'
  ]).application.id;
  const withdrawn = runCli(fixture.home, [
    'add-application', '--company', 'Globex', '--role', 'Data Engineer', '--status', 'withdrawn'
  ]).application.id;
  fixture.db.prepare("UPDATE companies SET website_domain='globex.test' WHERE normalized_name='globex'").run();

  const facts = factsFor('closed-applications', {
    source: { fromAddress: 'recruiter@globex.test', fromDomain: 'globex.test' },
    eventKind: 'recruiter_followup', company: { name: 'Globex', domain: 'globex.test' },
    postingRefs: [{ roleTitle: 'Site Reliability Engineer' }], replyRequested: true,
    evidence: [
      { field: 'subject', excerpt: 'Globex Site Reliability Engineer update' },
      { field: 'body', excerpt: 'This is about the Site Reliability Engineer role.' }
    ]
  });
  const correlation = correlateEmailReadOnly(fixture.db, facts);

  assert.equal(correlation.resolution, 'linked');
  assert.equal(correlation.resolved.applicationId, open);
  assert.equal(correlation.resolved.matchBasis, 'company_single_open');
  assert.deepEqual([...new Set(correlation.candidates.map((candidate) => candidate.applicationId))], [open]);
  assert.ok(!correlation.candidates.some((candidate) => [rejected, withdrawn].includes(candidate.applicationId)));
});
