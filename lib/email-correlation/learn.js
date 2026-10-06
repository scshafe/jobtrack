'use strict';
// S6 owns every runtime write made from a confirmed or retracted email link.
// Registry migration and identity reads stay in registry.js; keeping the
// projection mutations here makes the provenance boundary reviewable.

const { classifySenderDomain, normalizeDomain } = require('./domain-classes');
const { matchedRoleTitleReferenceIndexes } = require('./signals');
const {
  EmailCorrelationRegistryError,
  activeOperatorFact,
  companyForApplication,
  normalizeRegistryFactInput,
  normalizeTitleForAlias,
  relationExists,
  tableExists
} = require('./registry');

const REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_SCHEMA_VERSION = 2026090205;
const REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_MIGRATION_NAME = 'reversible_application_external_identifiers';
const MAX_BACKFILL_IDENTIFIER_ISSUE_MESSAGES = 100;

function migrateReversibleApplicationExternalIdentifiers(db) {
  const migration = db.prepare('SELECT name FROM jobtrack_schema_migrations WHERE version=?')
    .get(REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_SCHEMA_VERSION);
  if (migration && migration.name !== REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_MIGRATION_NAME) {
    throw new EmailCorrelationRegistryError('MIGRATION_CONFLICT', `Schema version ${REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_SCHEMA_VERSION} is already named ${migration.name}`);
  }
  if (migration) return;
  const nameConflict = db.prepare('SELECT version FROM jobtrack_schema_migrations WHERE name=?')
    .get(REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_MIGRATION_NAME);
  if (nameConflict) {
    throw new EmailCorrelationRegistryError('MIGRATION_CONFLICT', `Migration ${REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_MIGRATION_NAME} is already registered as version ${nameConflict.version}`);
  }
  if (!tableExists(db, 'application_external_identifiers')
    || !tableExists(db, 'email_link_retractions')
    || !relationExists(db, 'active_job_email_linked_correlations')) {
    throw new EmailCorrelationRegistryError(
      'STORE_NOT_MIGRATED',
      'external identifiers, link retractions, and the active linked-correlation view must be migrated first'
    );
  }
  const legacyHasUuid = db.pragma('table_info(application_external_identifiers)')
    .some((column) => column.name === 'uuid');

  const apply = () => {
    db.exec(`
      DROP VIEW IF EXISTS active_application_external_identifiers;
      DROP TRIGGER IF EXISTS application_external_identifiers_confirmed_source;
      DROP TRIGGER IF EXISTS application_external_identifiers_reviewed_source;
      DROP TRIGGER IF EXISTS application_external_identifiers_active_unique;
      DROP TRIGGER IF EXISTS application_external_identifiers_append_only_update;
      DROP TRIGGER IF EXISTS application_external_identifiers_append_only_delete;
      DROP INDEX IF EXISTS idx_application_external_identifiers_application;
      DROP INDEX IF EXISTS idx_application_external_identifiers_identity;
      DROP INDEX IF EXISTS idx_application_external_identifiers_source_vouch;
      DROP INDEX IF EXISTS idx_application_external_identifiers_uuid;
      ALTER TABLE application_external_identifiers RENAME TO application_external_identifiers_legacy_2026090205;

      CREATE TABLE application_external_identifiers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ${legacyHasUuid ? 'uuid TEXT,' : ''}
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
        namespace TEXT NOT NULL COLLATE NOCASE,
        value TEXT NOT NULL,
        provenance_kind TEXT NOT NULL CHECK (provenance_kind IN ('confirmed_link','reviewed_transition')),
        source_message_ref_id INTEGER NOT NULL REFERENCES job_email_message_refs(id) ON DELETE RESTRICT,
        source_correlation_id INTEGER NOT NULL REFERENCES job_email_correlations(id) ON DELETE RESTRICT,
        confirmed_by TEXT NOT NULL,
        source_transition_proposal_id TEXT REFERENCES job_email_transition_proposals(proposal_id) ON DELETE RESTRICT,
        review_event_id INTEGER REFERENCES job_email_transition_events(id) ON DELETE RESTRICT,
        reviewed_by TEXT,
        facts_digest TEXT NOT NULL CHECK (length(facts_digest)=64),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (trim(namespace) <> '' AND namespace=lower(trim(namespace))),
        CHECK (trim(value) <> '' AND value=trim(value)),
        CHECK (trim(confirmed_by) <> ''),
        CHECK (
          (provenance_kind='confirmed_link'
            AND source_transition_proposal_id IS NULL AND review_event_id IS NULL AND reviewed_by IS NULL)
          OR
          (provenance_kind='reviewed_transition'
            AND source_transition_proposal_id IS NOT NULL AND review_event_id IS NOT NULL
            AND reviewed_by IS NOT NULL AND trim(reviewed_by)<>'' AND reviewed_by=confirmed_by)
        )
      );
      INSERT INTO application_external_identifiers(
        id,${legacyHasUuid ? 'uuid,' : ''}application_id,namespace,value,provenance_kind,source_message_ref_id,source_correlation_id,
        confirmed_by,source_transition_proposal_id,review_event_id,reviewed_by,facts_digest,created_at
      )
      SELECT id,${legacyHasUuid ? 'uuid,' : ''}application_id,namespace,value,'reviewed_transition',source_message_ref_id,source_correlation_id,
        reviewed_by,source_transition_proposal_id,review_event_id,reviewed_by,facts_digest,created_at
      FROM application_external_identifiers_legacy_2026090205;
      DROP TABLE application_external_identifiers_legacy_2026090205;

      CREATE INDEX idx_application_external_identifiers_application
        ON application_external_identifiers(application_id,namespace);
      CREATE INDEX idx_application_external_identifiers_identity
        ON application_external_identifiers(namespace,value,created_at DESC);
      CREATE UNIQUE INDEX idx_application_external_identifiers_source_vouch
        ON application_external_identifiers(application_id,namespace,value,source_message_ref_id,source_correlation_id);
      ${legacyHasUuid ? `CREATE UNIQUE INDEX idx_application_external_identifiers_uuid
        ON application_external_identifiers(uuid);` : ''}

      CREATE VIEW active_application_external_identifiers AS
        SELECT identifier.* FROM application_external_identifiers identifier
        WHERE NOT EXISTS (
          SELECT 1 FROM email_link_retractions retraction
          WHERE retraction.message_ref_id=identifier.source_message_ref_id
            AND (retraction.application_id IS NULL OR retraction.application_id=identifier.application_id)
        );

      CREATE TRIGGER application_external_identifiers_active_unique
      BEFORE INSERT ON application_external_identifiers
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM active_application_external_identifiers active
          WHERE active.namespace=NEW.namespace COLLATE NOCASE AND active.value=NEW.value
            AND active.application_id<>NEW.application_id
        ) THEN RAISE(ABORT, 'active application identifier is already bound') END;
      END;

      CREATE TRIGGER application_external_identifiers_confirmed_source
      BEFORE INSERT ON application_external_identifiers
      WHEN NEW.provenance_kind='confirmed_link'
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1
          FROM job_email_message_refs message
          JOIN active_job_email_linked_correlations correlation
            ON correlation.id=NEW.source_correlation_id
           AND correlation.message_ref_id=message.id
          JOIN json_each(message.facts_json, '$.applicationRefs') reference
          WHERE message.id=NEW.source_message_ref_id
            AND message.facts_digest=NEW.facts_digest
            AND correlation.facts_digest=NEW.facts_digest
            AND correlation.resolved_application_id=NEW.application_id
            AND (
              json_extract(correlation.correlation_json, '$.automaticEligible')=1
              OR EXISTS (
                SELECT 1 FROM json_each(correlation.correlation_json, '$.evidence') evidence
                WHERE json_extract(evidence.value, '$.kind')='operator_resolution'
              )
            )
            AND lower(trim(CAST(json_extract(reference.value, '$.namespace') AS TEXT)))=NEW.namespace
            AND trim(CAST(json_extract(reference.value, '$.value') AS TEXT))=NEW.value
        ) THEN RAISE(ABORT, 'application identifier requires exact or operator-confirmed active link provenance') END;
      END;

      CREATE TRIGGER application_external_identifiers_reviewed_source
      BEFORE INSERT ON application_external_identifiers
      WHEN NEW.provenance_kind='reviewed_transition'
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1
          FROM job_email_message_refs message
          JOIN active_job_email_linked_correlations correlation
            ON correlation.id=NEW.source_correlation_id
           AND correlation.message_ref_id=message.id
          JOIN job_email_transition_proposals proposal
            ON proposal.proposal_id=NEW.source_transition_proposal_id
           AND proposal.message_ref_id=message.id
           AND proposal.correlation_id=correlation.id
          JOIN job_email_transition_events review
            ON review.id=NEW.review_event_id
           AND review.proposal_id=proposal.proposal_id
           AND review.event_kind='approved'
          JOIN json_each(message.facts_json, '$.applicationRefs') reference
          WHERE message.id=NEW.source_message_ref_id
            AND message.facts_digest=NEW.facts_digest
            AND correlation.facts_digest=NEW.facts_digest
            AND correlation.resolution='linked'
            AND correlation.resolved_application_id=NEW.application_id
            AND proposal.application_id=NEW.application_id
            AND review.actor=NEW.reviewed_by
            AND lower(trim(CAST(json_extract(reference.value, '$.namespace') AS TEXT)))=NEW.namespace
            AND trim(CAST(json_extract(reference.value, '$.value') AS TEXT))=NEW.value
        ) THEN RAISE(ABORT, 'application identifier requires reviewed active linked email provenance') END;
      END;

      CREATE TRIGGER application_external_identifiers_append_only_update
      BEFORE UPDATE ON application_external_identifiers
      BEGIN SELECT RAISE(ABORT, 'application_external_identifiers is append-only'); END;
      CREATE TRIGGER application_external_identifiers_append_only_delete
      BEFORE DELETE ON application_external_identifiers
      BEGIN SELECT RAISE(ABORT, 'application_external_identifiers is append-only'); END;
    `);
    const violations = db.prepare('PRAGMA foreign_key_check(application_external_identifiers)').all();
    if (violations.length) {
      throw new EmailCorrelationRegistryError(
        'MIGRATION_FOREIGN_KEY_VIOLATION',
        `application_external_identifiers rebuild has ${violations.length} foreign-key violation(s)`
      );
    }
    db.prepare('INSERT INTO jobtrack_schema_migrations(version,name) VALUES (?,?)')
      .run(REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_SCHEMA_VERSION, REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_MIGRATION_NAME);
  };
  if (db.inTransaction) apply();
  else db.transaction(apply).immediate();
}

function recordLearning(db, input) {
  const existing = db.prepare(`
    SELECT id, retracted_at FROM email_identity_learnings
    WHERE kind=? AND normalized_value=? AND COALESCE(company_id, 0)=COALESCE(?, 0)
      AND COALESCE(application_id, 0)=COALESCE(?, 0) AND source_message_ref_id=?
  `).get(input.kind, input.normalizedValue, input.companyId ?? null, input.applicationId ?? null, input.messageRefId);
  if (existing && existing.retracted_at === null) return { learningId: existing.id, created: false };
  if (existing) {
    db.prepare("UPDATE email_identity_learnings SET retracted_at=NULL, retracted_by=NULL, actor=?, source_correlation_id=COALESCE(?, source_correlation_id) WHERE id=?")
      .run(input.actor, input.correlationId ?? null, existing.id);
    return { learningId: existing.id, created: true };
  }
  const info = db.prepare(`
    INSERT INTO email_identity_learnings (
      kind, company_id, application_id, value, normalized_value,
      source_message_ref_id, source_correlation_id, actor
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    input.kind, input.companyId ?? null, input.applicationId ?? null, input.value, input.normalizedValue,
    input.messageRefId, input.correlationId ?? null, input.actor
  );
  return { learningId: Number(info.lastInsertRowid), created: true };
}

/**
 * Record an inbound sender as a company contact through the same reversible
 * provenance ledger as confirmed-link learning. Endpoint/company validation
 * remains with the email communication command; this function owns the
 * registry projection write and deduplicates it by normalized company/email.
 */
function recordContactFromMessage(db, input) {
  const messageRefId = Number(input.messageRefId);
  const companyId = Number(input.companyId);
  const address = String(input.email ?? '').trim().toLowerCase();
  const name = String(input.name ?? '').trim();
  const roleTitle = input.roleTitle === undefined || input.roleTitle === null
    ? null
    : String(input.roleTitle).trim() || null;
  const actor = String(input.actor ?? 'jobtrack:email-record-contact').trim() || 'jobtrack:email-record-contact';
  if (!Number.isInteger(messageRefId) || messageRefId < 1) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'messageRefId must be a positive integer');
  if (!Number.isInteger(companyId) || companyId < 1) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'companyId must be a positive integer');
  if (!address || !address.includes('@')) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'email must be a normalized address');
  if (!name) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'name is required');
  if (!tableExists(db, 'email_identity_learnings') || !tableExists(db, 'company_contacts')) {
    throw new EmailCorrelationRegistryError('STORE_NOT_MIGRATED', 'email correlation registry and company contacts must be migrated first');
  }

  return db.transaction(() => {
    const learning = recordLearning(db, {
      kind: 'contact', companyId, value: address, normalizedValue: address,
      messageRefId, correlationId: input.correlationId ?? null, actor
    });
    const existing = db.prepare(`
      SELECT id FROM company_contacts
      WHERE company_id=? AND lower(email)=?
      ORDER BY id LIMIT 1
    `).get(companyId, address);
    if (existing) return { contactId: existing.id, learningId: learning.learningId, created: false };
    const inserted = db.prepare(`
      INSERT INTO company_contacts(company_id,name,role_title,email,source)
      VALUES (?,?,?,?,?)
    `).run(companyId, name.slice(0, 300), roleTitle?.slice(0, 300) ?? null, address, `email-learning:${learning.learningId}`);
    return { contactId: Number(inserted.lastInsertRowid), learningId: learning.learningId, created: true };
  })();
}

function activeOperatorOwnedFact(db, kind, companyId, normalizedValue) {
  if (!tableExists(db, 'email_identity_registry_facts')) return null;
  return db.prepare(`
    SELECT addition.id FROM email_identity_registry_facts addition
    WHERE addition.operation='add' AND addition.kind=? AND addition.company_id=?
      AND addition.normalized_value=? AND addition.owns_projection=1
      AND NOT EXISTS (
        SELECT 1 FROM email_identity_registry_facts retraction
        WHERE retraction.operation='retract' AND retraction.target_fact_id=addition.id
      )
    ORDER BY addition.id DESC LIMIT 1
  `).get(kind, companyId, normalizedValue) || null;
}

function activeLinkedCorrelation(db, messageRefId, applicationId, correlationId = null) {
  if (!relationExists(db, 'job_email_correlations')) return null;
  const source = relationExists(db, 'active_job_email_linked_correlations')
    ? 'active_job_email_linked_correlations'
    : 'job_email_correlations';
  return db.prepare(`
    SELECT id,facts_digest,correlation_json FROM ${source}
    WHERE message_ref_id=? AND resolved_application_id=? AND resolution='linked'
      AND (? IS NULL OR id=?)
    ORDER BY id DESC LIMIT 1
  `).get(messageRefId, applicationId, correlationId, correlationId) || null;
}

function isExactOrOperatorConfirmed(correlationRow) {
  if (!correlationRow) return false;
  let correlation;
  try { correlation = JSON.parse(correlationRow.correlation_json); } catch { return false; }
  return correlation.automaticEligible === true
    || (Array.isArray(correlation.evidence)
      && correlation.evidence.some((entry) => entry?.kind === 'operator_resolution'));
}

function identifierProvenanceForLink(correlationRow, input, actor) {
  if (!correlationRow) return null;
  if (input.reviewedTransition) {
    return {
      provenanceKind: 'reviewed_transition',
      confirmedBy: input.reviewedTransition.reviewedBy,
      proposalId: input.reviewedTransition.proposalId,
      reviewEventId: input.reviewedTransition.reviewEventId,
      reviewedBy: input.reviewedTransition.reviewedBy
    };
  }
  if (!isExactOrOperatorConfirmed(correlationRow)) return null;
  return { provenanceKind: 'confirmed_link', confirmedBy: actor };
}

/** Learn contact, employer mail-domain, and role wording from a confirmed link. */
function confirmLink(db, input) {
  const messageRefId = Number(input.messageRefId);
  const applicationId = Number(input.applicationId);
  const actor = String(input.actor ?? 'jobtrack').trim() || 'jobtrack';
  if (!Number.isInteger(messageRefId) || messageRefId < 1) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'messageRefId must be a positive integer');
  if (!Number.isInteger(applicationId) || applicationId < 1) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'applicationId must be a positive integer');
  if (!tableExists(db, 'email_identity_learnings')) throw new EmailCorrelationRegistryError('STORE_NOT_MIGRATED', 'run migrateEmailCorrelationRegistry first');
  const message = db.prepare('SELECT * FROM job_email_message_refs WHERE id=?').get(messageRefId);
  if (!message) throw new EmailCorrelationRegistryError('NOT_FOUND', `message ref ${messageRefId} not found`);
  if (tableExists(db, 'email_link_retractions') && db.prepare(`
    SELECT 1 FROM email_link_retractions
    WHERE message_ref_id=? AND (application_id=? OR application_id IS NULL)
    LIMIT 1
  `).get(messageRefId, applicationId)) {
    throw new EmailCorrelationRegistryError('LINK_RETRACTED', `message ${messageRefId} is retracted from application ${applicationId}`);
  }
  const facts = JSON.parse(message.facts_json);
  const companyId = companyForApplication(db, applicationId);
  const requestedCorrelationId = input.correlationId === undefined ? null : Number(input.correlationId);
  const correlationRow = activeLinkedCorrelation(db, messageRefId, applicationId, requestedCorrelationId);
  const correlationId = correlationRow?.id ?? requestedCorrelationId;
  const normalizedIdentifiers = normalizedApplicationReferences(facts.applicationRefs);
  const identifierProvenance = identifierProvenanceForLink(correlationRow, input, actor);
  const matchedTitleReferences = causalRoleTitleReferences(
    facts,
    correlationRow,
    applicationId,
    message.facts_digest
  );
  const summary = {
    contact: 'skipped', domain: 'skipped', titleAliases: 0, skipped: [],
    applicationIdentifiers: identifierOutcome(0, 0, normalizedIdentifiers.references, [], normalizedIdentifiers.errors)
  };

  const run = db.transaction(() => {
    const address = String(facts.source?.fromAddress ?? '').trim().toLowerCase();
    const domain = normalizeDomain(facts.source?.fromDomain);
    const domainClass = classifySenderDomain(db, domain);

    if (companyId && address && tableExists(db, 'company_contacts')) {
      const learning = recordLearning(db, { kind: 'contact', companyId, value: address, normalizedValue: address, messageRefId, correlationId, actor });
      if (learning.created) {
        const displayName = String(facts.source?.fromDisplayName ?? '').trim() || address.split('@')[0];
        const existingContact = db.prepare('SELECT id FROM company_contacts WHERE company_id=? AND lower(email)=? ORDER BY id LIMIT 1')
          .get(companyId, address);
        if (!existingContact) {
          db.prepare('INSERT INTO company_contacts (company_id, name, email, source) VALUES (?, ?, ?, ?)')
            .run(companyId, displayName.slice(0, 200), address, `email-learning:${learning.learningId}`);
        }
        summary.contact = 'learned';
      } else {
        summary.contact = 'known';
      }
    }

    if (companyId && domain && domainClass === 'corporate' && tableExists(db, 'company_aliases')) {
      const owner = db.prepare("SELECT company_id FROM company_aliases WHERE alias_kind='domain' AND normalized_alias=?").get(domain);
      const operatorOwned = companyId ? activeOperatorOwnedFact(db, 'domain', companyId, domain) : null;
      if (owner && owner.company_id !== companyId) {
        summary.domain = 'conflict';
        summary.skipped.push(`domain ${domain} already belongs to company ${owner.company_id}`);
      } else if (owner && !operatorOwned && !db.prepare(`
        SELECT 1 FROM email_identity_learnings
        WHERE kind='domain' AND company_id=? AND normalized_value=? AND retracted_at IS NULL
        LIMIT 1
      `).get(companyId, domain)) {
        summary.domain = 'known';
      } else {
        const learning = recordLearning(db, { kind: 'domain', companyId, value: domain, normalizedValue: domain, messageRefId, correlationId, actor });
        if (learning.created && !owner) {
          db.prepare("INSERT OR IGNORE INTO company_aliases (company_id, alias, normalized_alias, alias_kind) VALUES (?, ?, ?, 'domain')")
            .run(companyId, domain, domain);
        }
        summary.domain = learning.created ? 'learned' : 'known';
      }
    } else if (domain && domainClass !== 'corporate') {
      summary.domain = `not-an-employer-domain (${domainClass})`;
    }

    if (tableExists(db, 'application_title_aliases')) {
      for (const reference of matchedTitleReferences) {
        const title = typeof reference?.roleTitle === 'string' ? reference.roleTitle.trim() : '';
        if (!title) continue;
        const normalized = normalizeTitleForAlias(db, title);
        if (!normalized) continue;
        const learning = recordLearning(db, { kind: 'title_alias', applicationId, value: title, normalizedValue: normalized, messageRefId, correlationId, actor });
        if (learning.created) {
          db.prepare('INSERT OR IGNORE INTO application_title_aliases (application_id, alias, normalized_alias, source_learning_id) VALUES (?, ?, ?, ?)')
            .run(applicationId, title.slice(0, 500), normalized, learning.learningId);
          summary.titleAliases += 1;
        }
      }
    }

    if (normalizedIdentifiers.references.length > 0) {
      if (!identifierProvenance) {
        const error = {
          namespace: null,
          value: null,
          code: 'APPLICATION_IDENTIFIER_LINK_UNCONFIRMED',
          message: 'application identifiers require an exact automatic link, operator resolution, or reviewed transition'
        };
        summary.applicationIdentifiers = identifierOutcome(
          0, 0, normalizedIdentifiers.references, [], [...normalizedIdentifiers.errors, error]
        );
      } else {
        try {
          const learned = confirmApplicationExternalIdentifiers(db, {
            references: normalizedIdentifiers.references,
            applicationId,
            messageRefId,
            correlationId: correlationRow.id,
            factsDigest: message.facts_digest,
            ...identifierProvenance
          });
          summary.applicationIdentifiers = identifierOutcome(
            learned.created,
            learned.reused,
            normalizedIdentifiers.references,
            learned.conflicts || [],
            [...normalizedIdentifiers.errors, ...(learned.errors || [])]
          );
        } catch (error) {
          summary.applicationIdentifiers = identifierOutcome(
            0, 0, normalizedIdentifiers.references, [],
            [...normalizedIdentifiers.errors, {
              namespace: null,
              value: null,
              code: error.code || 'APPLICATION_IDENTIFIER_WRITE_FAILED',
              message: String(error.message || error).slice(0, 300)
            }]
          );
        }
      }
    }
  });
  run();
  return { messageRefId, applicationId, companyId, ...summary };
}

function causalRoleTitleReferences(facts, correlationRow, applicationId, factsDigest) {
  if (!correlationRow || correlationRow.facts_digest !== factsDigest) return [];
  let correlation;
  try { correlation = JSON.parse(correlationRow.correlation_json); } catch { return []; }
  if (correlation.factsDigest !== factsDigest
    || correlation.resolution !== 'linked'
    || Number(correlation.resolved?.applicationId) !== applicationId) return [];
  return matchedRoleTitleReferenceIndexes(correlation, applicationId)
    .map((referenceIndex) => facts.postingRefs?.[referenceIndex])
    .filter((reference) => typeof reference?.roleTitle === 'string' && reference.roleTitle.trim());
}

function linkRetractionTargets(db, messageRefId, learningRows) {
  const targets = new Set(learningRows.filter((row) => row.application_id !== null).map((row) => Number(row.application_id)));
  if (tableExists(db, 'job_email_correlations')) {
    const rows = db.prepare(`
      SELECT DISTINCT resolved_application_id FROM job_email_correlations
      WHERE message_ref_id=? AND resolution='linked' AND resolved_application_id IS NOT NULL
      ORDER BY resolved_application_id
    `).all(messageRefId);
    for (const row of rows) {
      targets.add(Number(row.resolved_application_id));
    }
  }
  if (tableExists(db, 'job_email_application_links')) {
    for (const row of db.prepare('SELECT DISTINCT application_id FROM job_email_application_links WHERE message_ref_id=?').all(messageRefId)) {
      targets.add(Number(row.application_id));
    }
  }
  return [...targets];
}

function recordLinkRetractions(db, { messageRefId, learningRows, actor, reason }) {
  if (!tableExists(db, 'email_link_retractions')) return 0;
  let recorded = 0;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO email_link_retractions(message_ref_id,application_id,actor,reason)
    VALUES (?,?,?,?)
  `);
  for (const applicationId of linkRetractionTargets(db, messageRefId, learningRows)) {
    recorded += insert.run(messageRefId, applicationId, actor, reason).changes;
  }
  return recorded;
}

/**
 * Retract one message's confirmed link. Source link/correlation rows remain
 * append-only; an append-only event makes the pair inactive. Learning
 * projections disappear only after their last live vouch is gone.
 */
function retractLink(db, input) {
  const messageRefId = Number(input.messageRefId);
  const actor = String(input.actor ?? 'jobtrack').trim() || 'jobtrack';
  const reason = String(input.reason ?? 'email link and its identity learnings retracted').trim();
  if (!Number.isInteger(messageRefId) || messageRefId < 1) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'messageRefId must be a positive integer');
  if (!reason || reason.length > 1000) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'reason must contain 1 to 1000 characters');
  if (!tableExists(db, 'email_identity_learnings')) throw new EmailCorrelationRegistryError('STORE_NOT_MIGRATED', 'run migrateEmailCorrelationRegistry first');
  if (!db.prepare('SELECT 1 FROM job_email_message_refs WHERE id=?').get(messageRefId)) throw new EmailCorrelationRegistryError('NOT_FOUND', `message ref ${messageRefId} not found`);
  const rows = db.prepare('SELECT * FROM email_identity_learnings WHERE source_message_ref_id=? AND retracted_at IS NULL').all(messageRefId);
  const removed = { contacts: 0, domains: 0, titleAliases: 0, retracted: 0, linkRetractions: 0 };
  const run = db.transaction(() => {
    removed.linkRetractions = recordLinkRetractions(db, { messageRefId, learningRows: rows, actor, reason });
    for (const row of rows) {
      db.prepare("UPDATE email_identity_learnings SET retracted_at=datetime('now'), retracted_by=? WHERE id=?").run(actor, row.id);
      removed.retracted += 1;
      const stillVouched = db.prepare(`
        SELECT 1 FROM email_identity_learnings
        WHERE kind=? AND normalized_value=? AND retracted_at IS NULL
          AND company_id IS ? AND application_id IS ?
        LIMIT 1
      `).get(row.kind, row.normalized_value, row.company_id, row.application_id);
      if (stillVouched) continue;
      if (row.kind === 'contact' && tableExists(db, 'company_contacts')) {
        const operatorOwned = activeOperatorOwnedFact(db, 'contact', row.company_id, row.normalized_value);
        if (operatorOwned) {
          db.prepare(`
            UPDATE company_contacts SET source=?,updated_at=datetime('now')
            WHERE company_id=? AND lower(email)=?
              AND source IN (
                SELECT 'email-learning:' || id FROM email_identity_learnings
                WHERE kind='contact' AND company_id=? AND normalized_value=?
              )
          `).run(
            `email-registry-fact:${operatorOwned.id}`,
            row.company_id, row.normalized_value, row.company_id, row.normalized_value
          );
        } else {
          removed.contacts += db.prepare(`
            DELETE FROM company_contacts
            WHERE company_id=? AND lower(email)=?
              AND source IN (
                SELECT 'email-learning:' || id FROM email_identity_learnings
                WHERE kind='contact' AND company_id=? AND normalized_value=?
              )
          `).run(row.company_id, row.normalized_value, row.company_id, row.normalized_value).changes;
        }
      } else if (row.kind === 'domain' && tableExists(db, 'company_aliases')) {
        if (!activeOperatorOwnedFact(db, 'domain', row.company_id, row.normalized_value)) {
          removed.domains += db.prepare("DELETE FROM company_aliases WHERE alias_kind='domain' AND normalized_alias=? AND company_id=?")
            .run(row.normalized_value, row.company_id).changes;
        }
      } else if (row.kind === 'title_alias' && tableExists(db, 'application_title_aliases')) {
        removed.titleAliases += db.prepare(`
          DELETE FROM application_title_aliases
          WHERE application_id=? AND normalized_alias=?
            AND source_learning_id IN (
              SELECT id FROM email_identity_learnings
              WHERE kind='title_alias' AND application_id=? AND normalized_value=?
            )
        `).run(row.application_id, row.normalized_value, row.application_id, row.normalized_value).changes;
      }
    }
  });
  run();
  return { messageRefId, ...removed };
}

/** Backfill S6 from active, newest confirmed correlations only. */
function reviewedTransitionForCorrelation(db, correlationId) {
  if (!tableExists(db, 'job_email_transition_proposals') || !tableExists(db, 'job_email_transition_events')) return null;
  return db.prepare(`
    SELECT proposal.proposal_id AS proposalId,review.id AS reviewEventId,review.actor AS reviewedBy
    FROM job_email_transition_proposals proposal
    JOIN job_email_transition_events applied
      ON applied.proposal_id=proposal.proposal_id AND applied.event_kind='applied'
    JOIN job_email_transition_events review
      ON review.proposal_id=proposal.proposal_id AND review.event_kind='approved'
    WHERE proposal.correlation_id=?
    ORDER BY applied.id DESC,review.id DESC LIMIT 1
  `).get(correlationId) || null;
}

function backfillLearnings(db, { actor = 'jobtrack:backfill' } = {}) {
  if (!tableExists(db, 'email_identity_learnings')) throw new EmailCorrelationRegistryError('STORE_NOT_MIGRATED', 'run migrateEmailCorrelationRegistry first');
  const correlationSource = relationExists(db, 'active_job_email_linked_correlations')
    ? 'active_job_email_linked_correlations'
    : 'job_email_correlations';
  const rows = db.prepare(`
    SELECT c.id AS correlation_id, c.message_ref_id, c.resolved_application_id,c.correlation_json
    FROM ${correlationSource} c
    WHERE c.resolution='linked' AND c.resolved_application_id IS NOT NULL
      AND c.id = (SELECT max(id) FROM job_email_correlations x WHERE x.message_ref_id = c.message_ref_id)
    ORDER BY c.message_ref_id
  `).all();
  const confirmed = rows.map((row) => {
    if (isExactOrOperatorConfirmed(row)) return { row, reviewedTransition: null };
    const reviewedTransition = reviewedTransitionForCorrelation(db, row.correlation_id);
    return reviewedTransition ? { row, reviewedTransition } : null;
  }).filter(Boolean);
  const summary = {
    messages: confirmed.length,
    skippedUnconfirmed: rows.length - confirmed.length,
    contactsLearned: 0,
    domainsLearned: 0,
    titleAliasesLearned: 0,
    applicationIdentifiersLearned: 0,
    applicationIdentifierConflictCount: 0,
    applicationIdentifierErrorCount: 0,
    applicationIdentifierIssues: [],
    applicationIdentifierIssueMessagesOmitted: 0,
    skipped: []
  };
  for (const entry of confirmed) {
    const { row, reviewedTransition } = entry;
    const learned = confirmLink(db, {
      messageRefId: row.message_ref_id,
      applicationId: row.resolved_application_id,
      correlationId: row.correlation_id,
      actor,
      ...(reviewedTransition ? { reviewedTransition } : {})
    });
    if (learned.contact === 'learned') summary.contactsLearned += 1;
    if (learned.domain === 'learned') summary.domainsLearned += 1;
    summary.titleAliasesLearned += learned.titleAliases;
    summary.applicationIdentifiersLearned += learned.applicationIdentifiers?.created || 0;
    const identifierConflicts = Array.isArray(learned.applicationIdentifiers?.conflicts)
      ? learned.applicationIdentifiers.conflicts
      : [];
    const identifierErrors = Array.isArray(learned.applicationIdentifiers?.errors)
      ? learned.applicationIdentifiers.errors
      : [];
    summary.applicationIdentifierConflictCount += identifierConflicts.length;
    summary.applicationIdentifierErrorCount += identifierErrors.length;
    if (identifierConflicts.length || identifierErrors.length) {
      if (summary.applicationIdentifierIssues.length < MAX_BACKFILL_IDENTIFIER_ISSUE_MESSAGES) {
        summary.applicationIdentifierIssues.push({
          messageRefId: Number(row.message_ref_id),
          applicationId: Number(row.resolved_application_id),
          correlationId: Number(row.correlation_id),
          ...(identifierConflicts.length ? { conflicts: identifierConflicts } : {}),
          ...(identifierErrors.length ? { errors: identifierErrors } : {})
        });
      } else {
        summary.applicationIdentifierIssueMessagesOmitted += 1;
      }
    }
    summary.skipped.push(...learned.skipped);
  }
  return summary;
}

function normalizedApplicationReferences(references) {
  const normalized = [];
  const errors = [];
  const seen = new Set();
  for (const reference of references || []) {
    const namespace = String(reference?.namespace ?? '').trim().toLowerCase();
    const value = String(reference?.value ?? '').trim();
    if (!namespace || namespace.length > 100 || /[\u0000-\u001f\u007f]/.test(namespace)
      || !value || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) {
      errors.push({
        namespace: namespace || null,
        value: value || null,
        code: 'INVALID_APPLICATION_IDENTIFIER',
        message: 'application identifier namespace/value is outside the safe printable bounds'
      });
      continue;
    }
    const key = `${namespace}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ namespace, value });
  }
  return { references: normalized, errors };
}

function identifierOutcome(created, reused, references, conflicts, errors) {
  return {
    created,
    reused,
    namespaces: [...new Set(references.map((reference) => reference.namespace))].sort(),
    ...(conflicts.length ? { conflicts } : {}),
    ...(errors.length ? { errors } : {})
  };
}

/** Persist one provenance-bearing application-reference vouch through S6. */
function confirmApplicationExternalIdentifiers(db, input) {
  const identifiers = relationExists(db, 'active_application_external_identifiers')
    ? 'active_application_external_identifiers'
    : 'application_external_identifiers';
  let created = 0;
  let reused = 0;
  const conflicts = [];
  const errors = [];
  const provenanceKind = input.provenanceKind;
  const confirmedBy = String(input.confirmedBy ?? input.reviewedBy ?? '').trim();
  for (const reference of input.references) {
    const conflicting = db.prepare(`
      SELECT id,application_id FROM ${identifiers}
      WHERE namespace=? COLLATE NOCASE AND value=? AND application_id<>?
      LIMIT 1
    `).get(reference.namespace, reference.value, input.applicationId);
    if (conflicting) {
      conflicts.push({
        namespace: reference.namespace,
        value: reference.value,
        applicationId: Number(conflicting.application_id),
        code: 'APPLICATION_IDENTIFIER_CONFLICT'
      });
      continue;
    }
    const existingVouch = db.prepare(`
      SELECT id FROM application_external_identifiers
      WHERE namespace=? COLLATE NOCASE AND value=? AND application_id=?
        AND source_message_ref_id=? AND source_correlation_id=?
    `).get(
      reference.namespace, reference.value, input.applicationId,
      input.messageRefId, input.correlationId
    );
    if (existingVouch) {
      reused += 1;
      continue;
    }
    try {
      db.prepare(`
        INSERT INTO application_external_identifiers (
          application_id,namespace,value,provenance_kind,source_message_ref_id,source_correlation_id,
          confirmed_by,source_transition_proposal_id,review_event_id,reviewed_by,facts_digest
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        input.applicationId,
        reference.namespace,
        reference.value,
        provenanceKind,
        input.messageRefId,
        input.correlationId,
        confirmedBy,
        provenanceKind === 'reviewed_transition' ? input.proposalId : null,
        provenanceKind === 'reviewed_transition' ? input.reviewEventId : null,
        provenanceKind === 'reviewed_transition' ? input.reviewedBy : null,
        input.factsDigest
      );
      created += 1;
    } catch (error) {
      const racedConflict = db.prepare(`
        SELECT application_id FROM ${identifiers}
        WHERE namespace=? COLLATE NOCASE AND value=? AND application_id<>?
        LIMIT 1
      `).get(reference.namespace, reference.value, input.applicationId);
      if (racedConflict) {
        conflicts.push({
          namespace: reference.namespace,
          value: reference.value,
          applicationId: Number(racedConflict.application_id),
          code: 'APPLICATION_IDENTIFIER_CONFLICT'
        });
      } else {
        errors.push({
          namespace: reference.namespace,
          value: reference.value,
          code: error.code || 'APPLICATION_IDENTIFIER_WRITE_FAILED',
          message: String(error.message || error).slice(0, 300)
        });
      }
    }
  }
  return identifierOutcome(created, reused, input.references, conflicts, errors);
}

function insertOperatorFact(db, fact, ownsProjection) {
  const info = db.prepare(`
    INSERT INTO email_identity_registry_facts(
      operation,target_fact_id,kind,company_id,value,normalized_value,domain_class,
      display_name,source,actor,reason,owns_projection
    ) VALUES ('add',NULL,?,?,?,?,?,?,'operator',?,?,?)
  `).run(
    fact.kind, fact.companyId, fact.value, fact.normalizedValue, fact.domainClass,
    fact.displayName, fact.actor, fact.reason, ownsProjection ? 1 : 0
  );
  return Number(info.lastInsertRowid);
}

function addRegistryFact(db, input) {
  const fact = normalizeRegistryFactInput(db, input);
  if (fact.kind === 'domain_class' && fact.domainClass === null) throw new EmailCorrelationRegistryError('INVALID_INPUT', 'class is required when adding a domain-class fact');
  const prior = activeOperatorFact(db, fact);
  if (prior) {
    if (prior.domain_class === fact.domainClass) {
      return {
        operation: 'add', factId: prior.id, kind: fact.kind, companyId: fact.companyId,
        value: fact.value, reused: true, projectionOwned: Boolean(prior.owns_projection)
      };
    }
    throw new EmailCorrelationRegistryError('FACT_CONFLICT', `an active operator ${fact.kind} fact already exists; retract fact ${prior.id} first`);
  }

  return db.transaction(() => {
    let ownsProjection = false;
    let projectionCreated = false;
    if (fact.kind === 'domain') {
      const existing = db.prepare('SELECT company_id,alias_kind FROM company_aliases WHERE normalized_alias=?').get(fact.normalizedValue);
      if (existing && existing.company_id !== fact.companyId) throw new EmailCorrelationRegistryError('FACT_CONFLICT', `domain already belongs to company ${existing.company_id}`);
      if (existing && existing.alias_kind !== 'domain') throw new EmailCorrelationRegistryError('FACT_CONFLICT', 'value is already a non-domain company alias');
      const emailVouch = existing && db.prepare(`
        SELECT 1 FROM email_identity_learnings
        WHERE kind='domain' AND company_id=? AND normalized_value=? AND retracted_at IS NULL
        LIMIT 1
      `).get(fact.companyId, fact.normalizedValue);
      // An operator addition may assume an email-owned projection without
      // rewriting its append-only fact later. That ownership keeps the
      // projection alive if the email is retracted, then makes the final
      // operator retraction responsible for removing it.
      projectionCreated = !existing;
      ownsProjection = projectionCreated || Boolean(emailVouch);
    } else if (fact.kind === 'contact') {
      const contacts = db.prepare('SELECT company_id,source FROM company_contacts WHERE email IS NOT NULL AND lower(email)=?').all(fact.normalizedValue);
      if (contacts.some((row) => row.company_id !== fact.companyId)) throw new EmailCorrelationRegistryError('FACT_CONFLICT', `address already belongs to company ${contacts.find((row) => row.company_id !== fact.companyId).company_id}`);
      projectionCreated = contacts.length === 0;
      ownsProjection = projectionCreated
        || contacts.every((row) => String(row.source).startsWith('email-learning:'));
    }
    const factId = insertOperatorFact(db, fact, ownsProjection);
    if (fact.kind === 'domain' && projectionCreated) {
      db.prepare("INSERT INTO company_aliases(company_id,alias,normalized_alias,alias_kind) VALUES (?,?,?,'domain')")
        .run(fact.companyId, fact.value, fact.normalizedValue);
    } else if (fact.kind === 'contact' && projectionCreated) {
      db.prepare('INSERT INTO company_contacts(company_id,name,email,source) VALUES (?,?,?,?)')
        .run(fact.companyId, fact.displayName, fact.value, `email-registry-fact:${factId}`);
    }
    return {
      operation: 'add', factId, kind: fact.kind, companyId: fact.companyId, value: fact.value,
      reused: false, projectionCreated, projectionAssumed: ownsProjection && !projectionCreated
    };
  })();
}

function retractRegistryFact(db, input) {
  const fact = normalizeRegistryFactInput(db, input);
  const target = activeOperatorFact(db, fact);
  if (!target) {
    if (fact.kind === 'domain_class' && db.prepare('SELECT source FROM email_domain_classes WHERE domain=?').get(fact.normalizedValue)) {
      throw new EmailCorrelationRegistryError('PROTECTED_SEED', `${fact.normalizedValue} is repo-seeded; only an operator override can be retracted`);
    }
    if (fact.kind === 'domain' && db.prepare("SELECT 1 FROM company_aliases WHERE company_id=? AND normalized_alias=? AND alias_kind='domain'").get(fact.companyId, fact.normalizedValue)) {
      throw new EmailCorrelationRegistryError('PROTECTED_FACT', 'the domain has independent catalog/email provenance and cannot be retracted as an operator fact');
    }
    if (fact.kind === 'contact' && db.prepare('SELECT 1 FROM company_contacts WHERE company_id=? AND lower(email)=?').get(fact.companyId, fact.normalizedValue)) {
      throw new EmailCorrelationRegistryError('PROTECTED_FACT', 'the contact has independent catalog/email provenance and cannot be retracted as an operator fact');
    }
    throw new EmailCorrelationRegistryError('NOT_FOUND', 'no active operator fact matches the requested identity');
  }
  if (fact.domainClass !== null && target.domain_class !== fact.domainClass) throw new EmailCorrelationRegistryError('FACT_CONFLICT', `active override is ${target.domain_class}, not ${fact.domainClass}`);

  return db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO email_identity_registry_facts(
        operation,target_fact_id,kind,company_id,value,normalized_value,domain_class,
        display_name,source,actor,reason,owns_projection
      ) VALUES ('retract',?,?,?,?,?,?,?,'operator',?,?,0)
    `).run(
      target.id, target.kind, target.company_id, target.value, target.normalized_value,
      target.domain_class, target.display_name, fact.actor, fact.reason
    );
    let projectionRemoved = false;
    let projectionPreservedByLearning = false;
    if (target.owns_projection && target.kind === 'domain') {
      const learning = db.prepare(`
        SELECT id FROM email_identity_learnings
        WHERE kind='domain' AND company_id=? AND normalized_value=? AND retracted_at IS NULL
        ORDER BY id LIMIT 1
      `).get(target.company_id, target.normalized_value);
      projectionPreservedByLearning = Boolean(learning);
      if (!learning) {
        projectionRemoved = db.prepare("DELETE FROM company_aliases WHERE company_id=? AND normalized_alias=? AND alias_kind='domain'")
          .run(target.company_id, target.normalized_value).changes === 1;
      }
    } else if (target.owns_projection && target.kind === 'contact') {
      const learning = db.prepare(`
        SELECT id FROM email_identity_learnings
        WHERE kind='contact' AND company_id=? AND normalized_value=? AND retracted_at IS NULL
        ORDER BY id LIMIT 1
      `).get(target.company_id, target.normalized_value);
      projectionPreservedByLearning = Boolean(learning);
      if (learning) {
        db.prepare('UPDATE company_contacts SET source=?,updated_at=datetime(\'now\') WHERE company_id=? AND lower(email)=? AND source=?')
          .run(`email-learning:${learning.id}`, target.company_id, target.normalized_value, `email-registry-fact:${target.id}`);
      } else {
        projectionRemoved = db.prepare('DELETE FROM company_contacts WHERE company_id=? AND lower(email)=? AND source=?')
          .run(target.company_id, target.normalized_value, `email-registry-fact:${target.id}`).changes === 1;
      }
    }
    return {
      operation: 'retract', factId: target.id, retractionId: Number(info.lastInsertRowid),
      kind: target.kind, companyId: target.company_id, value: target.value,
      projectionRemoved, projectionPreservedByLearning
    };
  })();
}

function editIdentityRegistry(db, operation, input) {
  if (!tableExists(db, 'email_identity_registry_facts')) throw new EmailCorrelationRegistryError('STORE_NOT_MIGRATED', 'run migrateEmailCorrelationRegistry first');
  if (operation === 'add') return addRegistryFact(db, input);
  if (operation === 'retract') return retractRegistryFact(db, input);
  throw new EmailCorrelationRegistryError('INVALID_INPUT', 'identity operation must be add or retract');
}

function safeLearn(db, input) {
  try {
    return confirmLink(db, input);
  } catch (error) {
    return { error: error.code || error.name || 'LEARNING_FAILED', message: String(error.message || error).slice(0, 300) };
  }
}

module.exports = {
  REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_MIGRATION_NAME,
  REVERSIBLE_APPLICATION_EXTERNAL_IDENTIFIER_SCHEMA_VERSION,
  backfillLearnings,
  confirmApplicationExternalIdentifiers,
  confirmLink,
  editIdentityRegistry,
  migrateReversibleApplicationExternalIdentifiers,
  recordContactFromMessage,
  retractLink,
  safeLearn
};
