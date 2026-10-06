'use strict';

const { canonicalizeCatalogUrl } = require('../catalog');
const { pendingForMessage } = require('./clarify');
const { normalizeDomain, domainMatches } = require('./domain-classes');
const { normalizeMentionText } = require('./normalize');

class CandidateSet {
  constructor(store) {
    this.store = store;
    this.valuesByKey = new Map();
  }

  add(applicationId, matchBasis, confidence, reasons, identifiers = {}) {
    const application = this.store.application(applicationId);
    if (!application) return null;
    const key = `${applicationId}:${matchBasis}:${identifiers.postingId || 0}:${identifiers.interviewId || 0}`;
    const candidate = {
      applicationId: Number(applicationId),
      applicationVersion: application.lock_version || 0,
      ...(application.job_opening_id ? { openingId: application.job_opening_id } : {}),
      ...(application.primary_job_posting_id ? { postingId: application.primary_job_posting_id } : {}),
      ...identifiers,
      matchBasis,
      confidence: clampConfidence(confidence),
      reasons: uniqueReasons(reasons)
    };
    const existing = this.valuesByKey.get(key);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, candidate.confidence);
      existing.reasons = uniqueReasons([...existing.reasons, ...candidate.reasons]);
      for (const field of ['companyId', 'openingId', 'postingId', 'postingOccurrenceId', 'interviewId']) {
        if (existing[field] === undefined && candidate[field] !== undefined) existing[field] = candidate[field];
      }
      return existing;
    }
    this.valuesByKey.set(key, candidate);
    return candidate;
  }

  values() { return [...this.valuesByKey.values()]; }
}

function addCandidate(candidateSet, applicationId, matchBasis, confidence, reasons, identifiers) {
  return candidateSet.add(applicationId, matchBasis, confidence, reasons, identifiers);
}

function orderCandidates(candidates, policy) {
  return [...candidates].sort((left, right) =>
    (policy.priorities[right.matchBasis] - policy.priorities[left.matchBasis])
      || right.confidence - left.confidence
      || left.applicationId - right.applicationId
  );
}

function createCorrelationStore(db) {
  return new CorrelationStore(db);
}

function enrichInterviewCandidates(ctx) {
  if (!ctx.facts.interview) return;
  const scheduledAt = ctx.facts.interview.previousScheduledAt || ctx.facts.interview.scheduledAt;
  for (const candidate of ctx.candidates.values()) {
    const rows = ctx.store.matchingInterviews(candidate.applicationId, scheduledAt);
    if (rows.length === 1) {
      candidate.interviewId = rows[0].id;
      ctx.evidence.push({ kind: 'interview_schedule', value: `interview:${rows[0].id}` });
    } else if (rows.length === 0) {
      ctx.evidence.push({ kind: 'interview_unmatched', value: `application:${candidate.applicationId}:no scheduled interview matched the facts` });
    } else {
      ctx.evidence.push({ kind: 'interview_ambiguous', value: `application:${candidate.applicationId}:${rows.length} scheduled interviews matched; none linked` });
    }
  }
}

class CorrelationStore {
  constructor(db) { this.db = db; }

  tableExists(name) {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name));
  }

  columns(name) {
    if (!this.tableExists(name)) return new Set();
    return new Set(this.db.prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name));
  }

  application(id) { return this.db.prepare('SELECT * FROM applications WHERE id=?').get(id); }

  priorMessageApplications(source) {
    return this.priorApplications(source, 'message_id', source.messageId);
  }

  priorThreadApplications(source) {
    return this.priorApplications(source, 'thread_id', source.threadId);
  }

  priorApplications(source, sourceColumn, sourceValue) {
    if (!this.tableExists('job_email_message_refs')) return [];
    if (!['message_id', 'thread_id'].includes(sourceColumn)) throw new TypeError('unsupported prior-application source field');
    const applicationIds = new Set();
    if (this.tableExists('job_email_application_links')) {
      const links = this.tableExists('active_job_email_application_links')
        ? 'active_job_email_application_links'
        : 'job_email_application_links';
      for (const row of this.db.prepare(`
        SELECT DISTINCT link.application_id FROM job_email_message_refs message
        JOIN ${links} link ON link.message_ref_id=message.id
        WHERE message.provider=? AND message.account_id=? AND message.${sourceColumn}=?
      `).all(source.provider, source.accountId, sourceValue)) applicationIds.add(Number(row.application_id));
    }
    if (this.tableExists('active_job_email_linked_correlations')) {
      const reviewedTransition = this.tableExists('job_email_transition_proposals')
        && this.tableExists('job_email_transition_events')
        ? `OR EXISTS (
            SELECT 1 FROM job_email_transition_proposals proposal
            JOIN job_email_transition_events approved
              ON approved.proposal_id=proposal.proposal_id AND approved.event_kind='approved'
            JOIN job_email_transition_events applied
              ON applied.proposal_id=proposal.proposal_id AND applied.event_kind='applied'
             AND applied.id>approved.id
            WHERE proposal.correlation_id=correlation.id
          )`
        : '';
      for (const row of this.db.prepare(`
        SELECT DISTINCT correlation.resolved_application_id AS application_id
        FROM job_email_message_refs message
        JOIN active_job_email_linked_correlations correlation ON correlation.message_ref_id=message.id
        WHERE message.provider=? AND message.account_id=? AND message.${sourceColumn}=?
          AND correlation.id=(
            SELECT max(newest.id) FROM job_email_correlations newest
            WHERE newest.message_ref_id=correlation.message_ref_id
          )
          AND correlation.facts_digest=message.facts_digest
          AND json_extract(correlation.correlation_json, '$.factsDigest')=correlation.facts_digest
          AND CAST(json_extract(correlation.correlation_json, '$.resolved.applicationId') AS INTEGER)
            =correlation.resolved_application_id
          AND (
            json_extract(correlation.correlation_json, '$.automaticEligible')=1
            OR EXISTS (
              SELECT 1 FROM json_each(correlation.correlation_json, '$.evidence') evidence
              WHERE json_extract(evidence.value, '$.kind')='operator_resolution'
            )
            ${reviewedTransition}
          )
      `).all(source.provider, source.accountId, sourceValue)) applicationIds.add(Number(row.application_id));
    }
    return [...applicationIds].sort((left, right) => left - right);
  }

  applicationsByExternalIdentifier(namespace, value) {
    if (!this.tableExists('application_external_identifiers')) return [];
    const identifiers = this.tableExists('active_application_external_identifiers')
      ? 'active_application_external_identifiers'
      : 'application_external_identifiers';
    const columns = this.columns(identifiers);
    if (!['application_id', 'namespace', 'value'].every((column) => columns.has(column))) return [];
    return this.db.prepare(`
      SELECT DISTINCT application_id FROM ${identifiers}
      WHERE namespace=? COLLATE NOCASE AND value=?
    `).all(namespace, value).map((row) => row.application_id);
  }

  normalizedPostingMatches(reference) {
    if (!this.tableExists('job_postings') || !this.tableExists('application_postings')) return [];
    const postingColumns = this.columns('job_postings');
    const linkColumns = this.columns('application_postings');
    if (!['id', 'job_opening_id'].every((column) => postingColumns.has(column))
      || !['application_id', 'job_posting_id'].every((column) => linkColumns.has(column))) return [];
    const postingRows = [];
    if (reference.url && postingColumns.has('canonical_url')) {
      let canonical;
      try { canonical = canonicalizeCatalogUrl(reference.url); } catch { canonical = null; }
      if (canonical) {
        for (const posting of this.db.prepare('SELECT id,job_opening_id,canonical_url FROM job_postings ORDER BY id').all()) {
          try {
            if (canonicalizeCatalogUrl(posting.canonical_url) === canonical) postingRows.push(posting);
          } catch { /* ignore malformed historical URLs */ }
        }
      }
    }
    if (reference.externalJobId && reference.provider && postingColumns.has('external_id')
      && postingColumns.has('posting_venue_id') && this.tableExists('posting_venues') && this.tableExists('posting_platforms')) {
      postingRows.push(...this.db.prepare(`
        SELECT p.id,p.job_opening_id FROM job_postings p
        JOIN posting_venues v ON v.id=p.posting_venue_id
        JOIN posting_platforms platform ON platform.id=v.posting_platform_id
        WHERE p.external_id=? AND (lower(platform.slug)=lower(?) OR lower(platform.name)=lower(?))
      `).all(reference.externalJobId, reference.provider, reference.provider));
    }
    const matches = [];
    const seen = new Set();
    for (const posting of postingRows) {
      if (seen.has(posting.id)) continue;
      seen.add(posting.id);
      const links = this.db.prepare('SELECT application_id FROM application_postings WHERE job_posting_id=?').all(posting.id);
      if (this.columns('applications').has('primary_job_posting_id')) {
        links.push(...this.db.prepare('SELECT id AS application_id FROM applications WHERE primary_job_posting_id=?').all(posting.id));
      }
      const company = this.openingCompany(posting.job_opening_id);
      for (const applicationId of new Set(links.map((row) => row.application_id))) {
        matches.push({ applicationId, postingId: posting.id, postingOccurrenceId: posting.id,
          openingId: posting.job_opening_id, ...(company ? { companyId: company } : {}) });
      }
    }
    return matches;
  }

  opportunityMatches(url) {
    if (!url || !this.tableExists('opportunities') || !this.columns('applications').has('source_opportunity_id')) return [];
    let canonical;
    try { canonical = canonicalizeCatalogUrl(url); } catch { return []; }
    return this.db.prepare(`
      SELECT a.id AS application_id,o.canonical_url FROM opportunities o
      JOIN applications a ON a.source_opportunity_id=o.id
    `).all().filter((row) => {
      try { return canonicalizeCatalogUrl(row.canonical_url) === canonical; } catch { return false; }
    }).map((row) => ({ applicationId: row.application_id, canonical }));
  }

  legacyUrlMatches(url) {
    if (!url || !this.columns('applications').has('job_url')) return [];
    let canonical;
    try { canonical = canonicalizeCatalogUrl(url); } catch { return []; }
    return this.db.prepare('SELECT id,job_url FROM applications WHERE job_url IS NOT NULL').all()
      .filter((row) => { try { return canonicalizeCatalogUrl(row.job_url) === canonical; } catch { return false; } })
      .map((row) => ({ applicationId: row.id, canonical }));
  }

  legacyApplicationsByCompany(name) {
    const columns = this.columns('applications');
    if (!name || !columns.has('company') || !columns.has('role')) return [];
    return this.db.prepare('SELECT id AS application_id, company, role, status, updated_at, created_at FROM applications WHERE lower(company)=lower(?)').all(name);
  }

  applicationsAtCompany(companyId) {
    if (!this.tableExists('job_openings') || !this.columns('applications').has('job_opening_id')) return [];
    const rows = this.db.prepare(`
      SELECT a.id AS application_id,a.status,a.updated_at,a.created_at,a.status_changed_at,
        o.id AS opening_id,o.canonical_title,o.normalized_title,o.company_id
      FROM applications a JOIN job_openings o ON o.id=a.job_opening_id WHERE o.company_id=?
    `).all(companyId);
    if (this.tableExists('application_postings') && this.tableExists('job_postings')) {
      rows.push(...this.db.prepare(`
        SELECT a.id AS application_id,a.status,a.updated_at,a.created_at,a.status_changed_at,
          o.id AS opening_id,o.canonical_title,o.normalized_title,o.company_id
        FROM application_postings ap JOIN applications a ON a.id=ap.application_id
        JOIN job_postings jp ON jp.id=ap.job_posting_id JOIN job_openings o ON o.id=jp.job_opening_id
        WHERE o.company_id=?
      `).all(companyId));
    }
    return dedupe(rows, 'application_id');
  }

  allApplicationCatalog() {
    if (!this.tableExists('companies') || !this.tableExists('job_openings') || !this.columns('applications').has('job_opening_id')) return [];
    return this.db.prepare(`
      SELECT a.id AS application_id,a.status,a.updated_at,a.created_at,a.status_changed_at,
        o.id AS opening_id,o.company_id,o.canonical_title,o.normalized_title,
        c.canonical_name,c.normalized_name
      FROM applications a JOIN job_openings o ON o.id=a.job_opening_id
      JOIN companies c ON c.id=o.company_id ORDER BY a.id
    `).all();
  }

  titleAliases(applicationId) {
    if (!this.tableExists('application_title_aliases')) return [];
    return this.db.prepare('SELECT alias,normalized_alias FROM application_title_aliases WHERE application_id=? ORDER BY id').all(applicationId);
  }

  pendingClarificationsForMessage(facts) {
    return pendingForMessage(this.db, facts)
      .map((row) => ({
        clarificationId: row.clarification_id,
        companyId: row.company_id,
        matchScope: row.match_scope,
        candidateSnapshot: JSON.parse(row.candidate_snapshot_json)
      }));
  }

  companiesByContact(address) {
    if (!address || !this.tableExists('company_contacts')) return [];
    return this.db.prepare('SELECT DISTINCT company_id AS id FROM company_contacts WHERE email IS NOT NULL AND lower(email)=lower(?)').all(address).map((row) => row.id);
  }

  companiesByDomain(domain) {
    const normalized = normalizeDomain(domain);
    if (!normalized) return [];
    const matched = new Set();
    if (this.tableExists('companies') && this.columns('companies').has('website_domain')) {
      for (const row of this.db.prepare("SELECT id,website_domain FROM companies WHERE website_domain IS NOT NULL AND trim(website_domain)<>''").all()) {
        const known = normalizeDomain(row.website_domain);
        if (known && domainMatches(normalized, known)) matched.add(row.id);
      }
    }
    if (this.tableExists('company_aliases') && this.columns('company_aliases').has('alias_kind')) {
      for (const row of this.db.prepare("SELECT company_id AS id,alias FROM company_aliases WHERE alias_kind='domain'").all()) {
        const known = normalizeDomain(row.alias);
        if (known && domainMatches(normalized, known)) matched.add(row.id);
      }
    }
    return [...matched];
  }

  companiesByName(name) {
    const normalized = normalizeMentionText(name);
    if (!normalized || !this.tableExists('companies')) return [];
    const matched = new Set();
    for (const row of this.db.prepare('SELECT id,normalized_name,canonical_name FROM companies').all()) {
      if (normalizeMentionText(row.normalized_name || row.canonical_name) === normalized) matched.add(row.id);
    }
    if (this.tableExists('company_aliases')) {
      for (const row of this.db.prepare("SELECT company_id AS id,normalized_alias FROM company_aliases WHERE alias_kind<>'domain'").all()) {
        if (normalizeMentionText(row.normalized_alias) === normalized) matched.add(row.id);
      }
    }
    return [...matched];
  }

  openingCompany(openingId) {
    if (!openingId || !this.tableExists('job_openings')) return null;
    return this.db.prepare('SELECT company_id FROM job_openings WHERE id=?').get(openingId)?.company_id || null;
  }

  matchingInterviews(applicationId, scheduledAt) {
    if (!this.tableExists('interviews')) return [];
    if (scheduledAt) return this.db.prepare('SELECT id FROM interviews WHERE application_id=? AND datetime(scheduled_at)=datetime(?) ORDER BY id').all(applicationId, scheduledAt);
    const filter = this.columns('interviews').has('scheduling_status') ? "AND scheduling_status IN ('scheduled','rescheduled')" : '';
    return this.db.prepare(`SELECT id FROM interviews WHERE application_id=? ${filter} ORDER BY datetime(scheduled_at),id`).all(applicationId);
  }
}

function dedupe(rows, key) {
  return [...new Map(rows.map((row) => [row[key], row])).values()];
}

function uniqueReasons(reasons) {
  return [...new Set((reasons || []).map(String).filter(Boolean))].slice(0, 10);
}

function clampConfidence(value) {
  return Math.max(0, Math.min(1, Number(value)));
}

module.exports = { CandidateSet, CorrelationStore, addCandidate, createCorrelationStore, enrichInterviewCandidates, orderCandidates };
