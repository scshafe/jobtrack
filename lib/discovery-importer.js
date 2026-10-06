'use strict';

const {
  ContractError,
  digest,
  sourceFingerprintFor,
  stableJson,
  validateJsonValue,
  validateProposalBundle
} = require('../discovery-sandbox/contracts');

const DISCOVERY_IMPORT_SCHEMA_VERSION = 2026071712;
const DISCOVERY_IMPORT_MIGRATION_NAME = 'trusted_discovery_proposal_import';
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
const MAX_IMPORT_OBSERVATIONS = 2_000;
const MAX_IMPORT_RETRIEVALS = 100;
const MAX_IMPORT_EVIDENCE = 20_000;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTENT_ID = /^sha256:[a-f0-9]{64}$/;
const DECISIONS = new Set(['accepted', 'rejected']);
const INTENT_TARGETS = new Set(['opportunity-inbox', 'discovery-review', 'discovery-follow-up']);
const REQUIRED_TABLES = Object.freeze([
  'discovery_import_bundles',
  'discovery_import_retrievals',
  'discovery_import_proposals',
  'discovery_import_occurrences',
  'discovery_import_evidence',
  'discovery_import_decisions',
  'discovery_import_operations'
]);

class DiscoveryImportError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'DiscoveryImportError';
    this.code = code;
    this.details = details;
  }
}

function migrateDiscoveryImporter(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobtrack_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const existing = db.prepare(
    'SELECT name FROM jobtrack_schema_migrations WHERE version=?'
  ).get(DISCOVERY_IMPORT_SCHEMA_VERSION);
  if (existing) {
    if (existing.name !== DISCOVERY_IMPORT_MIGRATION_NAME) {
      throw new DiscoveryImportError(
        'MIGRATION_CONFLICT',
        `Migration ${DISCOVERY_IMPORT_SCHEMA_VERSION} is already registered as ${existing.name}`
      );
    }
    return;
  }
  const nameConflict = db.prepare(
    'SELECT version FROM jobtrack_schema_migrations WHERE name=?'
  ).get(DISCOVERY_IMPORT_MIGRATION_NAME);
  if (nameConflict) {
    throw new DiscoveryImportError(
      'MIGRATION_CONFLICT',
      `Migration ${DISCOVERY_IMPORT_MIGRATION_NAME} is already registered as version ${nameConflict.version}`
    );
  }

  const apply = () => {
    db.exec(`
      CREATE TABLE discovery_import_bundles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bundle_id TEXT NOT NULL UNIQUE CHECK (length(bundle_id)=71 AND substr(bundle_id,1,7)='sha256:'),
        content_sha256 TEXT NOT NULL UNIQUE CHECK (length(content_sha256)=64),
        manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256)=64),
        plugin_id TEXT NOT NULL,
        plugin_version TEXT NOT NULL,
        parser_name TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        strategy_kind TEXT NOT NULL CHECK (strategy_kind IN ('direct-board','funding-signal','imported-leads')),
        run_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        bundle_json TEXT NOT NULL CHECK (json_valid(bundle_json)),
        bundle_bytes INTEGER NOT NULL CHECK (bundle_bytes >= 0 AND bundle_bytes <= ${MAX_IMPORT_BYTES}),
        proposal_count INTEGER NOT NULL CHECK (proposal_count >= 0 AND proposal_count <= ${MAX_IMPORT_OBSERVATIONS}),
        new_proposal_count INTEGER NOT NULL CHECK (new_proposal_count >= 0 AND new_proposal_count <= proposal_count),
        retrieval_count INTEGER NOT NULL CHECK (retrieval_count >= 0 AND retrieval_count <= ${MAX_IMPORT_RETRIEVALS}),
        imported_by TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        UNIQUE(plugin_id, run_id)
      );

      CREATE TABLE discovery_import_retrievals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bundle_row_id INTEGER NOT NULL REFERENCES discovery_import_bundles(id) ON DELETE RESTRICT,
        request_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        requested_url TEXT NOT NULL,
        final_url TEXT NOT NULL,
        body_sha256 TEXT NOT NULL CHECK (length(body_sha256)=64),
        compressed_sha256 TEXT NOT NULL CHECK (length(compressed_sha256)=64),
        retrieval_sha256 TEXT NOT NULL CHECK (length(retrieval_sha256)=64),
        fetched_at TEXT NOT NULL,
        status INTEGER NOT NULL CHECK (status BETWEEN 100 AND 599),
        UNIQUE(bundle_row_id, request_id),
        UNIQUE(bundle_row_id, retrieval_sha256)
      );

      CREATE TABLE discovery_import_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT NOT NULL UNIQUE CHECK (length(proposal_id)=71 AND substr(proposal_id,1,7)='sha256:'),
        source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint)=64),
        observation_fingerprint TEXT NOT NULL UNIQUE CHECK (length(observation_fingerprint)=64),
        candidate_kind TEXT NOT NULL CHECK (candidate_kind IN ('job-posting','funding-signal','imported-lead')),
        source_key TEXT NOT NULL,
        proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
        proposal_sha256 TEXT NOT NULL CHECK (length(proposal_sha256)=64),
        first_bundle_row_id INTEGER NOT NULL REFERENCES discovery_import_bundles(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        CHECK (proposal_id = 'sha256:' || observation_fingerprint),
        CHECK (proposal_sha256 = observation_fingerprint)
      );

      CREATE TABLE discovery_import_occurrences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bundle_row_id INTEGER NOT NULL REFERENCES discovery_import_bundles(id) ON DELETE RESTRICT,
        proposal_row_id INTEGER NOT NULL REFERENCES discovery_import_proposals(id) ON DELETE RESTRICT,
        observation_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        observation_json TEXT NOT NULL CHECK (json_valid(observation_json)),
        observation_sha256 TEXT NOT NULL CHECK (length(observation_sha256)=64),
        UNIQUE(bundle_row_id, proposal_row_id),
        UNIQUE(bundle_row_id, observation_id)
      );

      CREATE TABLE discovery_import_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurrence_id INTEGER NOT NULL REFERENCES discovery_import_occurrences(id) ON DELETE RESTRICT,
        evidence_index INTEGER NOT NULL CHECK (evidence_index >= 0 AND evidence_index < 100),
        evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('retrieval','imported-lead','public-citation')),
        request_id TEXT,
        url TEXT NOT NULL,
        body_sha256 TEXT CHECK (body_sha256 IS NULL OR length(body_sha256)=64),
        captured_at TEXT NOT NULL,
        label TEXT,
        evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256)=64),
        retrieval_sha256 TEXT CHECK (retrieval_sha256 IS NULL OR length(retrieval_sha256)=64),
        binding_sha256 TEXT NOT NULL CHECK (length(binding_sha256)=64),
        UNIQUE(occurrence_id, evidence_index),
        CHECK (
          (evidence_kind='retrieval' AND request_id IS NOT NULL AND body_sha256 IS NOT NULL AND retrieval_sha256 IS NOT NULL)
          OR
          (evidence_kind<>'retrieval' AND request_id IS NULL AND body_sha256 IS NULL AND retrieval_sha256 IS NULL)
        )
      );

      CREATE TABLE discovery_import_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_row_id INTEGER NOT NULL UNIQUE REFERENCES discovery_import_proposals(id) ON DELETE RESTRICT,
        decision TEXT NOT NULL CHECK (decision IN ('accepted','rejected')),
        decided_by TEXT NOT NULL,
        rationale TEXT NOT NULL,
        intent_json TEXT CHECK (intent_json IS NULL OR json_valid(intent_json)),
        intent_sha256 TEXT CHECK (intent_sha256 IS NULL OR length(intent_sha256)=64),
        idempotency_key TEXT NOT NULL UNIQUE,
        decided_at TEXT NOT NULL,
        CHECK (
          (decision='accepted' AND intent_json IS NOT NULL AND intent_sha256 IS NOT NULL)
          OR
          (decision='rejected' AND intent_json IS NULL AND intent_sha256 IS NULL)
        )
      );

      CREATE TABLE discovery_import_operations (
        idempotency_key TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('accept','reject')),
        request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64),
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_discovery_import_bundle_source
        ON discovery_import_bundles(source_key, completed_at DESC, id DESC);
      CREATE INDEX idx_discovery_import_proposal_source
        ON discovery_import_proposals(source_fingerprint, id DESC);
      CREATE INDEX idx_discovery_import_occurrence_proposal
        ON discovery_import_occurrences(proposal_row_id, id DESC);
      CREATE INDEX idx_discovery_import_evidence_occurrence
        ON discovery_import_evidence(occurrence_id, evidence_index);
      CREATE INDEX idx_discovery_import_decision_kind
        ON discovery_import_decisions(decision, decided_at DESC, id DESC);
    `);
    for (const table of REQUIRED_TABLES) createAppendOnlyTriggers(db, table);
    db.prepare(
      'INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)'
    ).run(DISCOVERY_IMPORT_SCHEMA_VERSION, DISCOVERY_IMPORT_MIGRATION_NAME);
  };
  runTransaction(db, apply);
}

function importProposalBundle(db, rawBundle, options = {}) {
  const prepared = prepareBundle(rawBundle);
  const importedBy = boundedText(
    options.importedBy === undefined ? 'jobtrack:trusted-discovery-importer' : options.importedBy,
    'importedBy',
    200
  );
  const importedAt = normalizedTimestamp(
    typeof options.now === 'function' ? options.now() : new Date().toISOString(),
    'importedAt'
  );
  requireSchema(db);

  const execute = () => {
    const existing = db.prepare(
      'SELECT * FROM discovery_import_bundles WHERE bundle_id=?'
    ).get(prepared.bundle.bundleId);
    if (existing) {
      assertStoredBundleMatches(existing, prepared);
      return importResult(db, existing, true);
    }
    const contentCollision = db.prepare(
      'SELECT bundle_id FROM discovery_import_bundles WHERE content_sha256=?'
    ).get(prepared.bundle.contentSha256);
    if (contentCollision) {
      throw new DiscoveryImportError(
        'BUNDLE_CONFLICT',
        `Bundle content is already stored as ${contentCollision.bundle_id}`
      );
    }
    const runCollision = db.prepare(`
      SELECT bundle_id, content_sha256 FROM discovery_import_bundles
      WHERE plugin_id=? AND run_id=?
    `).get(prepared.bundle.manifest.pluginId, prepared.bundle.run.runId);
    if (runCollision) {
      throw new DiscoveryImportError(
        'RUN_CONFLICT',
        `Discovery run ${prepared.bundle.manifest.pluginId}:${prepared.bundle.run.runId} already produced ${runCollision.bundle_id}`
      );
    }
    const newProposalCount = prepared.bundle.observations.reduce((count, observation) => {
      const exists = db.prepare(
        'SELECT 1 FROM discovery_import_proposals WHERE observation_fingerprint=?'
      ).get(observation.observationFingerprint);
      return count + (exists ? 0 : 1);
    }, 0);

    const bundleInsert = db.prepare(`
      INSERT INTO discovery_import_bundles (
        bundle_id, content_sha256, manifest_sha256, plugin_id, plugin_version,
        parser_name, parser_version, strategy_kind, run_id, source_key,
        started_at, completed_at, bundle_json, bundle_bytes, proposal_count,
        new_proposal_count, retrieval_count, imported_by, imported_at
      ) VALUES (
        @bundleId,@contentSha256,@manifestSha256,@pluginId,@pluginVersion,
        @parserName,@parserVersion,@strategyKind,@runId,@sourceKey,
        @startedAt,@completedAt,@bundleJson,@bundleBytes,@proposalCount,
        @newProposalCount,@retrievalCount,@importedBy,@importedAt
      )
    `).run({
      bundleId: prepared.bundle.bundleId,
      contentSha256: prepared.bundle.contentSha256,
      manifestSha256: prepared.bundle.manifestSha256,
      pluginId: prepared.bundle.manifest.pluginId,
      pluginVersion: prepared.bundle.manifest.pluginVersion,
      parserName: prepared.bundle.manifest.parserName,
      parserVersion: prepared.bundle.manifest.parserVersion,
      strategyKind: prepared.bundle.manifest.strategyKind,
      runId: prepared.bundle.run.runId,
      sourceKey: prepared.bundle.run.sourceKey,
      startedAt: prepared.bundle.run.startedAt,
      completedAt: prepared.bundle.run.completedAt,
      bundleJson: prepared.bundleJson,
      bundleBytes: prepared.bundleBytes,
      proposalCount: prepared.bundle.observations.length,
      newProposalCount,
      retrievalCount: prepared.bundle.retrievals.length,
      importedBy,
      importedAt
    });
    const bundleRowId = Number(bundleInsert.lastInsertRowid);
    const retrievals = insertRetrievals(db, bundleRowId, prepared.bundle.retrievals);
    for (const observation of prepared.bundle.observations) {
      const proposal = findOrCreateProposal(db, bundleRowId, observation, importedAt);
      const occurrenceInsert = db.prepare(`
        INSERT INTO discovery_import_occurrences (
          bundle_row_id, proposal_row_id, observation_id, observed_at,
          observation_json, observation_sha256
        ) VALUES (?,?,?,?,?,?)
      `).run(
        bundleRowId,
        proposal.row.id,
        observation.observationId,
        observation.observedAt,
        stableJson(observation),
        digest(stableJson(observation))
      );
      insertEvidence(
        db,
        Number(occurrenceInsert.lastInsertRowid),
        observation,
        retrievals
      );
    }
    const row = db.prepare('SELECT * FROM discovery_import_bundles WHERE id=?').get(bundleRowId);
    return importResult(db, row, false);
  };
  return runTransaction(db, execute);
}

function acceptDiscoveryProposal(db, options) {
  return reviewDiscoveryProposal(db, 'accepted', options);
}

function rejectDiscoveryProposal(db, options) {
  return reviewDiscoveryProposal(db, 'rejected', options);
}

function reviewDiscoveryProposal(db, decision, options = {}) {
  if (!DECISIONS.has(decision)) {
    throw new DiscoveryImportError('VALIDATION_ERROR', 'decision must be accepted or rejected');
  }
  requireSchema(db);
  const proposalId = contentId(options.proposalId, 'proposalId');
  const decidedBy = boundedText(options.decidedBy, 'decidedBy', 200);
  const rationale = boundedText(options.rationale, 'rationale', 4_000);
  const idempotencyKey = boundedText(options.idempotencyKey, 'idempotencyKey', 300);
  const action = decision === 'accepted' ? 'accept' : 'reject';
  const request = { action, proposalId, decidedBy, rationale };
  const requestSha256 = digest(stableJson(request));
  const decidedAt = normalizedTimestamp(
    typeof options.now === 'function' ? options.now() : new Date().toISOString(),
    'decidedAt'
  );

  const execute = () => {
    const replay = db.prepare(
      'SELECT * FROM discovery_import_operations WHERE idempotency_key=?'
    ).get(idempotencyKey);
    if (replay) {
      if (replay.action !== action || replay.request_sha256 !== requestSha256) {
        throw new DiscoveryImportError(
          'IDEMPOTENCY_CONFLICT',
          `Idempotency key ${idempotencyKey} was already used for a different review request`
        );
      }
      return JSON.parse(replay.result_json);
    }
    const proposal = db.prepare(
      'SELECT * FROM discovery_import_proposals WHERE proposal_id=?'
    ).get(proposalId);
    if (!proposal) {
      throw new DiscoveryImportError('NOT_FOUND', `Discovery proposal not found: ${proposalId}`);
    }
    const priorDecision = db.prepare(
      'SELECT * FROM discovery_import_decisions WHERE proposal_row_id=?'
    ).get(proposal.id);
    if (priorDecision) {
      throw new DiscoveryImportError(
        'ALREADY_REVIEWED',
        `Discovery proposal ${proposalId} was already ${priorDecision.decision}`
      );
    }
    const intent = decision === 'accepted' ? buildIngestionIntent(db, proposal) : null;
    if (intent) validateIngestionIntent(intent);
    const intentJson = intent ? stableJson(intent) : null;
    const intentSha256 = intentJson ? digest(intentJson) : null;
    const decisionInsert = db.prepare(`
      INSERT INTO discovery_import_decisions (
        proposal_row_id, decision, decided_by, rationale, intent_json,
        intent_sha256, idempotency_key, decided_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(
      proposal.id,
      decision,
      decidedBy,
      rationale,
      intentJson,
      intentSha256,
      idempotencyKey,
      decidedAt
    );
    const result = {
      schemaVersion: 1,
      kind: 'discovery-proposal-review-result',
      decisionId: Number(decisionInsert.lastInsertRowid),
      proposalId,
      status: decision,
      decidedBy,
      rationale,
      decidedAt,
      applicationCreated: false,
      submissionAuthorized: false,
      ...(intent ? { ingestionIntent: intent, ingestionIntentSha256: intentSha256 } : {})
    };
    db.prepare(`
      INSERT INTO discovery_import_operations (
        idempotency_key, action, request_sha256, result_json, created_at
      ) VALUES (?,?,?,?,?)
    `).run(idempotencyKey, action, requestSha256, stableJson(result), decidedAt);
    return result;
  };
  return runTransaction(db, execute);
}

function getDiscoveryProposal(db, proposalId) {
  requireSchema(db);
  const row = db.prepare(`
    SELECT p.*, d.id AS decision_id, d.decision, d.decided_by, d.rationale,
      d.intent_json, d.intent_sha256, d.decided_at,
      (SELECT count(*) FROM discovery_import_occurrences o WHERE o.proposal_row_id=p.id) AS occurrence_count
    FROM discovery_import_proposals p
    LEFT JOIN discovery_import_decisions d ON d.proposal_row_id=p.id
    WHERE p.proposal_id=?
  `).get(contentId(proposalId, 'proposalId'));
  if (!row) throw new DiscoveryImportError('NOT_FOUND', `Discovery proposal not found: ${proposalId}`);
  return serializeProposal(row);
}

function listDiscoveryProposals(db, options = {}) {
  requireSchema(db);
  const status = options.status === undefined ? null : String(options.status);
  if (status !== null && !['pending', 'accepted', 'rejected'].includes(status)) {
    throw new DiscoveryImportError('VALIDATION_ERROR', 'status must be pending, accepted, or rejected');
  }
  const limit = boundedInteger(options.limit === undefined ? 100 : options.limit, 'limit', 1, 500);
  return db.prepare(`
    SELECT p.*, d.id AS decision_id, d.decision, d.decided_by, d.rationale,
      d.intent_json, d.intent_sha256, d.decided_at,
      (SELECT count(*) FROM discovery_import_occurrences o WHERE o.proposal_row_id=p.id) AS occurrence_count
    FROM discovery_import_proposals p
    LEFT JOIN discovery_import_decisions d ON d.proposal_row_id=p.id
    WHERE (@status IS NULL)
       OR (@status='pending' AND d.id IS NULL)
       OR (d.decision=@status)
    ORDER BY p.id DESC
    LIMIT @limit
  `).all({ status, limit }).map(serializeProposal);
}

function prepareBundle(rawBundle) {
  let json;
  if (Buffer.isBuffer(rawBundle)) {
    if (rawBundle.length > MAX_IMPORT_BYTES) tooLarge(rawBundle.length);
    json = rawBundle.toString('utf8');
  } else if (typeof rawBundle === 'string') {
    const size = Buffer.byteLength(rawBundle, 'utf8');
    if (size > MAX_IMPORT_BYTES) tooLarge(size);
    json = rawBundle;
  } else {
    try {
      json = JSON.stringify(rawBundle);
    } catch (error) {
      throw new DiscoveryImportError('BUNDLE_INVALID', `Bundle must be JSON-serializable: ${error.message}`);
    }
    if (json === undefined) throw new DiscoveryImportError('BUNDLE_INVALID', 'Bundle must be a JSON object');
    const size = Buffer.byteLength(json, 'utf8');
    if (size > MAX_IMPORT_BYTES) tooLarge(size);
  }
  let bundle;
  try {
    bundle = JSON.parse(json);
  } catch (error) {
    throw new DiscoveryImportError('BUNDLE_INVALID', `Bundle is not valid JSON: ${error.message}`);
  }
  enforceImportLimits(bundle);
  try {
    validateProposalBundle(bundle);
  } catch (error) {
    if (error instanceof ContractError || error?.code === 'CONTRACT_INVALID') {
      throw new DiscoveryImportError('BUNDLE_INVALID', error.message, { path: error.path });
    }
    throw error;
  }
  const bundleJson = stableJson(bundle);
  const bundleBytes = Buffer.byteLength(bundleJson, 'utf8');
  if (bundleBytes > MAX_IMPORT_BYTES) tooLarge(bundleBytes);
  return { bundle, bundleJson, bundleBytes };
}

function enforceImportLimits(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new DiscoveryImportError('BUNDLE_INVALID', 'bundle: must be an object');
  }
  if (!Array.isArray(bundle.observations)) {
    throw new DiscoveryImportError('BUNDLE_INVALID', 'bundle.observations: must be an array');
  }
  if (bundle.observations.length > MAX_IMPORT_OBSERVATIONS) {
    throw new DiscoveryImportError(
      'IMPORT_LIMIT_EXCEEDED',
      `Bundle has ${bundle.observations.length} observations; importer limit is ${MAX_IMPORT_OBSERVATIONS}`
    );
  }
  if (!Array.isArray(bundle.retrievals)) {
    throw new DiscoveryImportError('BUNDLE_INVALID', 'bundle.retrievals: must be an array');
  }
  if (bundle.retrievals.length > MAX_IMPORT_RETRIEVALS) {
    throw new DiscoveryImportError(
      'IMPORT_LIMIT_EXCEEDED',
      `Bundle has ${bundle.retrievals.length} retrievals; importer limit is ${MAX_IMPORT_RETRIEVALS}`
    );
  }
  let evidenceCount = 0;
  for (const observation of bundle.observations) {
    if (observation && Array.isArray(observation.evidence)) evidenceCount += observation.evidence.length;
    if (evidenceCount > MAX_IMPORT_EVIDENCE) {
      throw new DiscoveryImportError(
        'IMPORT_LIMIT_EXCEEDED',
        `Bundle has more than ${MAX_IMPORT_EVIDENCE} evidence records`
      );
    }
  }
}

function insertRetrievals(db, bundleRowId, retrievals) {
  const byRequestId = new Map();
  const insert = db.prepare(`
    INSERT INTO discovery_import_retrievals (
      bundle_row_id, request_id, source_key, requested_url, final_url,
      body_sha256, compressed_sha256, retrieval_sha256, fetched_at, status
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  for (const retrieval of retrievals) {
    const retrievalSha256 = digest(stableJson(retrieval));
    insert.run(
      bundleRowId,
      retrieval.requestId,
      retrieval.sourceKey,
      retrieval.requestedUrl,
      retrieval.finalUrl,
      retrieval.bodySha256,
      retrieval.compressedSha256,
      retrievalSha256,
      retrieval.fetchedAt,
      retrieval.status
    );
    byRequestId.set(retrieval.requestId, { ...retrieval, retrievalSha256 });
  }
  return byRequestId;
}

function findOrCreateProposal(db, bundleRowId, observation, createdAt) {
  const proposalId = `sha256:${observation.observationFingerprint}`;
  const proposalPayload = proposalPayloadFor(observation);
  const proposalJson = stableJson(proposalPayload);
  const proposalSha256 = digest(proposalJson);
  if (proposalSha256 !== observation.observationFingerprint) {
    throw new DiscoveryImportError(
      'BUNDLE_INVALID',
      `Observation ${observation.observationId} does not bind to its proposal fingerprint`
    );
  }
  const existing = db.prepare(
    'SELECT * FROM discovery_import_proposals WHERE observation_fingerprint=?'
  ).get(observation.observationFingerprint);
  if (existing) {
    if (
      existing.proposal_id !== proposalId ||
      existing.source_fingerprint !== observation.sourceFingerprint ||
      existing.proposal_sha256 !== proposalSha256 ||
      existing.proposal_json !== proposalJson
    ) {
      throw new DiscoveryImportError(
        'PROPOSAL_CONFLICT',
        `Observation fingerprint ${observation.observationFingerprint} conflicts with its stored proposal`
      );
    }
    return { row: existing, created: false };
  }
  const info = db.prepare(`
    INSERT INTO discovery_import_proposals (
      proposal_id, source_fingerprint, observation_fingerprint, candidate_kind,
      source_key, proposal_json, proposal_sha256, first_bundle_row_id, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    proposalId,
    observation.sourceFingerprint,
    observation.observationFingerprint,
    observation.candidateKind,
    observation.sourceKey,
    proposalJson,
    proposalSha256,
    bundleRowId,
    createdAt
  );
  return {
    row: db.prepare('SELECT * FROM discovery_import_proposals WHERE id=?').get(Number(info.lastInsertRowid)),
    created: true
  };
}

function proposalPayloadFor(observation) {
  const evidence = observation.evidence.map((item) => ({
    evidenceKind: item.evidenceKind,
    url: item.url,
    bodySha256: item.bodySha256
  })).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  return {
    schemaVersion: 1,
    sourceFingerprint: observation.sourceFingerprint,
    facts: {
      candidateKind: observation.candidateKind,
      companyName: observation.companyName,
      title: observation.title,
      canonicalUrl: observation.canonicalUrl,
      provider: observation.provider,
      boardKey: observation.boardKey,
      externalId: observation.externalId,
      locationText: observation.locationText,
      workplaceType: observation.workplaceType,
      employmentType: observation.employmentType,
      postedAt: observation.postedAt,
      descriptionText: observation.descriptionText,
      attributes: observation.attributes
    },
    parser: observation.parser,
    evidence
  };
}

function insertEvidence(db, occurrenceId, observation, retrievals) {
  const insert = db.prepare(`
    INSERT INTO discovery_import_evidence (
      occurrence_id, evidence_index, evidence_kind, request_id, url, body_sha256,
      captured_at, label, evidence_sha256, retrieval_sha256, binding_sha256
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  observation.evidence.forEach((evidence, index) => {
    const retrieval = evidence.requestId ? retrievals.get(evidence.requestId) : null;
    if (evidence.evidenceKind === 'retrieval' && !retrieval) {
      throw new DiscoveryImportError(
        'BUNDLE_INVALID',
        `Evidence references unavailable retrieval ${evidence.requestId}`
      );
    }
    const evidenceSha256 = digest(stableJson(evidence));
    const retrievalSha256 = retrieval ? retrieval.retrievalSha256 : null;
    const bindingSha256 = evidenceBindingSha256(observation, evidence, retrievalSha256);
    insert.run(
      occurrenceId,
      index,
      evidence.evidenceKind,
      evidence.requestId,
      evidence.url,
      evidence.bodySha256,
      evidence.capturedAt,
      evidence.label,
      evidenceSha256,
      retrievalSha256,
      bindingSha256
    );
  });
}

function evidenceBindingSha256(observation, evidence, retrievalSha256) {
  return digest(stableJson({
    sourceFingerprint: observation.sourceFingerprint,
    observationFingerprint: observation.observationFingerprint,
    evidenceKind: evidence.evidenceKind,
    url: evidence.url,
    bodySha256: evidence.bodySha256,
    retrievalSha256
  }));
}

function buildIngestionIntent(db, proposal) {
  const occurrence = db.prepare(`
    SELECT o.*, b.bundle_id, b.content_sha256, b.manifest_sha256,
      b.plugin_id, b.plugin_version, b.parser_name, b.parser_version,
      b.run_id, b.strategy_kind
    FROM discovery_import_occurrences o
    JOIN discovery_import_bundles b ON b.id=o.bundle_row_id
    WHERE o.proposal_row_id=?
    ORDER BY o.id DESC LIMIT 1
  `).get(proposal.id);
  if (!occurrence) {
    throw new DiscoveryImportError('PROVENANCE_MISSING', `Proposal ${proposal.proposal_id} has no imported occurrence`);
  }
  const payload = JSON.parse(proposal.proposal_json);
  const evidence = db.prepare(`
    SELECT evidence_kind, request_id, url, body_sha256, captured_at, label,
      evidence_sha256, retrieval_sha256, binding_sha256
    FROM discovery_import_evidence
    WHERE occurrence_id=? ORDER BY evidence_index
  `).all(occurrence.id).map((row) => ({
    evidenceKind: row.evidence_kind,
    requestId: row.request_id,
    url: row.url,
    bodySha256: row.body_sha256,
    capturedAt: row.captured_at,
    label: row.label,
    evidenceSha256: row.evidence_sha256,
    retrievalSha256: row.retrieval_sha256,
    bindingSha256: row.binding_sha256
  }));
  const target = intentTarget(payload.facts);
  return {
    schemaVersion: 1,
    kind: 'reviewed-discovery-ingestion-intent',
    target,
    proposalId: proposal.proposal_id,
    candidate: payload.facts,
    provenance: {
      bundleId: occurrence.bundle_id,
      bundleContentSha256: occurrence.content_sha256,
      manifestSha256: occurrence.manifest_sha256,
      pluginId: occurrence.plugin_id,
      pluginVersion: occurrence.plugin_version,
      parserName: occurrence.parser_name,
      parserVersion: occurrence.parser_version,
      runId: occurrence.run_id,
      strategyKind: occurrence.strategy_kind,
      sourceKey: proposal.source_key,
      sourceFingerprint: proposal.source_fingerprint,
      observationFingerprint: proposal.observation_fingerprint,
      observationId: occurrence.observation_id,
      observationSha256: occurrence.observation_sha256,
      evidence
    },
    safety: {
      dataOnly: true,
      networkFetchAuthorized: false,
      applicationCreationAuthorized: false,
      submissionAuthorized: false
    }
  };
}

function intentTarget(facts) {
  if (facts.candidateKind === 'funding-signal') return 'discovery-follow-up';
  if (facts.companyName && facts.title) return 'opportunity-inbox';
  return 'discovery-review';
}

function validateIngestionIntent(value) {
  strictObject(value, ['schemaVersion', 'kind', 'target', 'proposalId', 'candidate', 'provenance', 'safety'], 'intent');
  if (value.schemaVersion !== 1) invalidIntent('intent.schemaVersion', 'must equal 1');
  if (value.kind !== 'reviewed-discovery-ingestion-intent') invalidIntent('intent.kind', 'has an invalid value');
  if (!INTENT_TARGETS.has(value.target)) invalidIntent('intent.target', 'has an invalid value');
  contentId(value.proposalId, 'intent.proposalId');
  strictObject(value.candidate, [
    'candidateKind', 'companyName', 'title', 'canonicalUrl', 'provider', 'boardKey',
    'externalId', 'locationText', 'workplaceType', 'employmentType', 'postedAt',
    'descriptionText', 'attributes'
  ], 'intent.candidate');
  if (!['job-posting', 'funding-signal', 'imported-lead'].includes(value.candidate.candidateKind)) {
    invalidIntent('intent.candidate.candidateKind', 'has an invalid value');
  }
  httpsUrl(value.candidate.canonicalUrl, 'intent.candidate.canonicalUrl');
  for (const [field, max] of [
    ['companyName', 500], ['title', 1_000], ['provider', 100], ['boardKey', 500],
    ['externalId', 1_000], ['locationText', 2_000], ['workplaceType', 100],
    ['employmentType', 100], ['descriptionText', 5 * 1024 * 1024]
  ]) {
    if (value.candidate[field] !== null) boundedText(value.candidate[field], `intent.candidate.${field}`, max);
  }
  if (value.candidate.postedAt !== null) contractTimestamp(value.candidate.postedAt, 'intent.candidate.postedAt');
  validateJsonValue(value.candidate.attributes, 'intent.candidate.attributes');
  const expectedTarget = intentTarget(value.candidate);
  if (value.target !== expectedTarget) invalidIntent('intent.target', `must be ${expectedTarget} for this candidate`);
  strictObject(value.provenance, [
    'bundleId', 'bundleContentSha256', 'manifestSha256', 'pluginId', 'pluginVersion',
    'parserName', 'parserVersion', 'runId', 'strategyKind', 'sourceKey',
    'sourceFingerprint', 'observationFingerprint', 'observationId',
    'observationSha256', 'evidence'
  ], 'intent.provenance');
  contentId(value.provenance.bundleId, 'intent.provenance.bundleId');
  for (const field of [
    'bundleContentSha256', 'manifestSha256', 'sourceFingerprint',
    'observationFingerprint', 'observationSha256'
  ]) sha256(value.provenance[field], `intent.provenance.${field}`);
  if (value.provenance.bundleId !== `sha256:${value.provenance.bundleContentSha256}`) {
    invalidIntent('intent.provenance.bundleId', 'does not bind bundleContentSha256');
  }
  if (value.proposalId !== `sha256:${value.provenance.observationFingerprint}`) {
    invalidIntent('intent.proposalId', 'does not bind the observation fingerprint');
  }
  boundedText(value.provenance.pluginId, 'intent.provenance.pluginId', 128);
  boundedText(value.provenance.pluginVersion, 'intent.provenance.pluginVersion', 100);
  boundedText(value.provenance.parserName, 'intent.provenance.parserName', 128);
  boundedText(value.provenance.parserVersion, 'intent.provenance.parserVersion', 100);
  boundedText(value.provenance.runId, 'intent.provenance.runId', 128);
  boundedText(value.provenance.sourceKey, 'intent.provenance.sourceKey', 128);
  boundedText(value.provenance.observationId, 'intent.provenance.observationId', 128);
  if (!['direct-board', 'funding-signal', 'imported-leads'].includes(value.provenance.strategyKind)) {
    invalidIntent('intent.provenance.strategyKind', 'has an invalid value');
  }
  if (!Array.isArray(value.provenance.evidence) || value.provenance.evidence.length < 1 || value.provenance.evidence.length > 100) {
    invalidIntent('intent.provenance.evidence', 'must have 1..100 records');
  }
  for (const [index, evidence] of value.provenance.evidence.entries()) {
    const path = `intent.provenance.evidence[${index}]`;
    strictObject(evidence, [
      'evidenceKind', 'requestId', 'url', 'bodySha256', 'capturedAt', 'label',
      'evidenceSha256', 'retrievalSha256', 'bindingSha256'
    ], path);
    for (const field of ['evidenceSha256', 'bindingSha256']) sha256(evidence[field], `${path}.${field}`);
    if (evidence.retrievalSha256 !== null) sha256(evidence.retrievalSha256, `${path}.retrievalSha256`);
    if (!['retrieval', 'imported-lead', 'public-citation'].includes(evidence.evidenceKind)) {
      invalidIntent(`${path}.evidenceKind`, 'has an invalid value');
    }
    httpsUrl(evidence.url, `${path}.url`);
    contractTimestamp(evidence.capturedAt, `${path}.capturedAt`);
    if (evidence.label !== null) boundedText(evidence.label, `${path}.label`, 1_000);
    if (evidence.evidenceKind === 'retrieval') {
      boundedText(evidence.requestId, `${path}.requestId`, 128);
      sha256(evidence.bodySha256, `${path}.bodySha256`);
      sha256(evidence.retrievalSha256, `${path}.retrievalSha256`);
    } else if (evidence.requestId !== null || evidence.bodySha256 !== null || evidence.retrievalSha256 !== null) {
      invalidIntent(path, 'non-retrieval evidence cannot claim retrieval provenance');
    }
    const evidenceSha256 = digest(stableJson({
      evidenceKind: evidence.evidenceKind,
      requestId: evidence.requestId,
      url: evidence.url,
      bodySha256: evidence.bodySha256,
      capturedAt: evidence.capturedAt,
      label: evidence.label
    }));
    if (evidenceSha256 !== evidence.evidenceSha256) {
      invalidIntent(`${path}.evidenceSha256`, 'does not match evidence content');
    }
    const expectedBinding = digest(stableJson({
      sourceFingerprint: value.provenance.sourceFingerprint,
      observationFingerprint: value.provenance.observationFingerprint,
      evidenceKind: evidence.evidenceKind,
      url: evidence.url,
      bodySha256: evidence.bodySha256,
      retrievalSha256: evidence.retrievalSha256
    }));
    if (expectedBinding !== evidence.bindingSha256) invalidIntent(`${path}.bindingSha256`, 'does not bind proposal provenance');
  }
  const sourceFingerprint = sourceFingerprintFor({
    ...value.candidate,
    sourceKey: value.provenance.sourceKey
  });
  if (sourceFingerprint !== value.provenance.sourceFingerprint) {
    invalidIntent('intent.provenance.sourceFingerprint', 'does not match candidate source identity');
  }
  const proposalSha256 = digest(stableJson({
    schemaVersion: 1,
    sourceFingerprint: value.provenance.sourceFingerprint,
    facts: value.candidate,
    parser: {
      name: value.provenance.parserName,
      version: value.provenance.parserVersion
    },
    evidence: value.provenance.evidence.map((evidence) => ({
      evidenceKind: evidence.evidenceKind,
      url: evidence.url,
      bodySha256: evidence.bodySha256
    })).sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
  }));
  if (proposalSha256 !== value.provenance.observationFingerprint) {
    invalidIntent('intent.provenance.observationFingerprint', 'does not bind candidate and evidence content');
  }
  strictObject(value.safety, [
    'dataOnly', 'networkFetchAuthorized', 'applicationCreationAuthorized', 'submissionAuthorized'
  ], 'intent.safety');
  if (
    value.safety.dataOnly !== true ||
    value.safety.networkFetchAuthorized !== false ||
    value.safety.applicationCreationAuthorized !== false ||
    value.safety.submissionAuthorized !== false
  ) {
    invalidIntent('intent.safety', 'must remain data-only with network, application, and submission authority disabled');
  }
  return value;
}

function assertStoredBundleMatches(row, prepared) {
  if (
    row.content_sha256 !== prepared.bundle.contentSha256 ||
    row.manifest_sha256 !== prepared.bundle.manifestSha256 ||
    row.bundle_json !== prepared.bundleJson ||
    row.bundle_bytes !== prepared.bundleBytes
  ) {
    throw new DiscoveryImportError(
      'BUNDLE_CONFLICT',
      `Bundle ID ${prepared.bundle.bundleId} is already stored with different content`
    );
  }
}

function importResult(db, row, reused) {
  return {
    schemaVersion: 1,
    kind: 'discovery-bundle-import-result',
    bundleId: row.bundle_id,
    contentSha256: row.content_sha256,
    bundleRowId: row.id,
    proposalCount: row.proposal_count,
    newProposalCount: reused ? 0 : row.new_proposal_count,
    retrievalCount: row.retrieval_count,
    pendingProposalCount: db.prepare(`
      SELECT count(*) AS count
      FROM discovery_import_occurrences o
      LEFT JOIN discovery_import_decisions d ON d.proposal_row_id=o.proposal_row_id
      WHERE o.bundle_row_id=? AND d.id IS NULL
    `).get(row.id).count,
    reused
  };
}

function serializeProposal(row) {
  return {
    proposalId: row.proposal_id,
    sourceFingerprint: row.source_fingerprint,
    observationFingerprint: row.observation_fingerprint,
    candidateKind: row.candidate_kind,
    sourceKey: row.source_key,
    status: row.decision || 'pending',
    occurrenceCount: row.occurrence_count,
    proposal: JSON.parse(row.proposal_json),
    ...(row.decision_id ? {
      decision: {
        id: row.decision_id,
        decision: row.decision,
        decidedBy: row.decided_by,
        rationale: row.rationale,
        decidedAt: row.decided_at,
        ...(row.intent_json ? {
          ingestionIntent: JSON.parse(row.intent_json),
          ingestionIntentSha256: row.intent_sha256
        } : {})
      }
    } : {})
  };
}

function requireSchema(db) {
  const foreignKeys = db.pragma('foreign_keys', { simple: true });
  if (foreignKeys !== 1) {
    throw new DiscoveryImportError('FOREIGN_KEYS_REQUIRED', 'SQLite foreign_keys must be enabled for discovery imports');
  }
  const migrationTable = db.prepare(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type='table' AND name='jobtrack_schema_migrations'
  `).get();
  if (!migrationTable) {
    throw new DiscoveryImportError('SCHEMA_REQUIRED', 'Run migrateDiscoveryImporter before importing or reviewing proposals');
  }
  const migration = db.prepare(
    'SELECT name FROM jobtrack_schema_migrations WHERE version=?'
  ).get(DISCOVERY_IMPORT_SCHEMA_VERSION);
  if (!migration || migration.name !== DISCOVERY_IMPORT_MIGRATION_NAME) {
    throw new DiscoveryImportError('SCHEMA_REQUIRED', 'Run migrateDiscoveryImporter before importing or reviewing proposals');
  }
  const present = new Set(db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name IN (${REQUIRED_TABLES.map(() => '?').join(',')})
  `).all(...REQUIRED_TABLES).map((row) => row.name));
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missing.length) {
    throw new DiscoveryImportError('SCHEMA_REQUIRED', `Discovery import schema is incomplete: ${missing.join(', ')}`);
  }
}

function runTransaction(db, operation) {
  const transaction = db.transaction(operation);
  return db.inTransaction ? transaction() : transaction.immediate();
}

function createAppendOnlyTriggers(db, table) {
  db.exec(`
    CREATE TRIGGER ${table}_append_only_update
    BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
    CREATE TRIGGER ${table}_append_only_delete
    BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
  `);
}

function strictObject(value, fields, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidIntent(path, 'must be an object');
  const expected = new Set(fields);
  const missing = fields.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length) invalidIntent(path, `missing fields: ${missing.join(', ')}`);
  const extra = Object.keys(value).filter((field) => !expected.has(field));
  if (extra.length) invalidIntent(path, `unknown fields: ${extra.sort().join(', ')}`);
}

function contentId(value, path) {
  if (typeof value !== 'string' || !CONTENT_ID.test(value)) {
    throw new DiscoveryImportError('VALIDATION_ERROR', `${path} must be a sha256: content identifier`);
  }
  return value;
}

function sha256(value, path) {
  if (typeof value !== 'string' || !SHA256.test(value)) invalidIntent(path, 'must be a lowercase SHA-256 digest');
  return value;
}

function boundedText(value, path, max) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > max || /[\u0000]/.test(value)) {
    throw new DiscoveryImportError('VALIDATION_ERROR', `${path} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function boundedInteger(value, path, min, max) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new DiscoveryImportError('VALIDATION_ERROR', `${path} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function normalizedTimestamp(value, path) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new DiscoveryImportError('VALIDATION_ERROR', `${path} must be a UTC ISO-8601 timestamp`);
  }
  return new Date(value).toISOString();
}

function contractTimestamp(value, path) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    invalidIntent(path, 'must be an ISO-8601 timestamp');
  }
  return value;
}

function httpsUrl(value, path) {
  let url;
  try { url = new URL(value); } catch { invalidIntent(path, 'must be a valid URL'); }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443')
  ) {
    invalidIntent(path, 'must be a credential-free HTTPS URL on port 443 with no fragment');
  }
  return value;
}

function tooLarge(size) {
  throw new DiscoveryImportError(
    'IMPORT_LIMIT_EXCEEDED',
    `Bundle is ${size} bytes; importer limit is ${MAX_IMPORT_BYTES}`
  );
}

function invalidIntent(path, message) {
  throw new DiscoveryImportError('INTENT_INVALID', `${path}: ${message}`);
}

module.exports = {
  DISCOVERY_IMPORT_MIGRATION_NAME,
  DISCOVERY_IMPORT_SCHEMA_VERSION,
  DiscoveryImportError,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_EVIDENCE,
  MAX_IMPORT_OBSERVATIONS,
  MAX_IMPORT_RETRIEVALS,
  acceptDiscoveryProposal,
  getDiscoveryProposal,
  importProposalBundle,
  listDiscoveryProposals,
  migrateDiscoveryImporter,
  rejectDiscoveryProposal,
  validateIngestionIntent
};
