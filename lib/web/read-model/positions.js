'use strict';

// Read models for the things that are NOT applications: normalized openings,
// discovered opportunities, untrusted discovery proposals, and the interview
// queue.
//
// They share a shape — a scope CTE from lib/web/filters.js, a filter clause
// over it, and decoratePositionRow on the way out — which is why they sit
// together. What separates them is trust. A discovery proposal is a set of
// PUBLIC FACTS someone else wrote: it stays a proposal until an explicit CLI
// review, its company is matched to the catalog only by exact
// case-insensitive name, and nothing about it is promoted by rendering it.
// An opportunity is a tracked role that has not become an application. An
// opening is the normalized requisition several postings may point at.

const {
  getDb,
  tableExists,
  safeJson
} = require('../store');
const {
  listFilterFacets,
  publicTagJoins,
  publicTagPredicate,
  scopeEntityCte,
  buildEntityFilter
} = require('../filters');
const { decoratePositionRow } = require('./rows');
const { getCurrentInterviewPrep } = require('../../interview-prep');

function listOpportunities(filters = {}, { pipeline = false } = {}) {
  const db = getDb();
  if (!tableExists(db, 'opportunities')) return [];
  const scope = pipeline ? 'pipeline' : 'opportunities';
  const extraClauses = pipeline ? [
    `o.promoted_application_id IS NULL`,
    `o.state<>'promoted'`,
    `NOT EXISTS (SELECT 1 FROM applications linked_application WHERE linked_application.source_opportunity_id=o.id)`,
    ...(filters.status && filters.status !== 'opportunity' ? ['0'] : [])
  ] : [];
  const sqlFilters = buildEntityFilter({ ...filters, status: null }, scope, {
    stateExpression: 'o.state',
    extraClauses,
    queryExpressions: [
      'o.company_name', 'o.title', 'o.location_text', 'o.description_text', 'o.canonical_url', 'o.state',
      `(SELECT group_concat(rt.label, ' ') FROM opening_role_types search_ort JOIN role_types rt ON rt.id=search_ort.role_type_id WHERE search_ort.job_opening_id=o.job_opening_id)`,
      `(SELECT group_concat(sl.label, ' ') FROM opening_seniority_levels search_osl JOIN seniority_levels sl ON sl.id=search_osl.seniority_level_id WHERE search_osl.job_opening_id=o.job_opening_id)`,
      tableExists(db, 'opportunity_tag_links') ? `(SELECT group_concat(t.label, ' ') FROM opportunity_tag_links search_otl JOIN tags t ON t.id=search_otl.tag_id ${publicTagJoins('t')} WHERE search_otl.opportunity_id=o.id AND ${publicTagPredicate()})` : "''",
      tableExists(db, 'opening_tags') ? `(SELECT group_concat(t.label, ' ') FROM opening_tags search_ot JOIN tags t ON t.id=search_ot.tag_id ${publicTagJoins('t')} WHERE search_ot.job_opening_id=o.job_opening_id AND ${publicTagPredicate()})` : "''"
    ]
  });
  const rows = db.prepare(`
    WITH entities AS (${scopeEntityCte(scope, db)})
    SELECT o.*, ds.source_key, jo.company_id,
      (SELECT group_concat(ort.role_type_id) FROM opening_role_types ort WHERE ort.job_opening_id=o.job_opening_id) AS role_type_ids,
      (SELECT group_concat(rt.label, ', ') FROM opening_role_types ort JOIN role_types rt ON rt.id=ort.role_type_id WHERE ort.job_opening_id=o.job_opening_id ORDER BY ort.is_primary DESC, rt.label) AS role_types,
      (SELECT group_concat(osl.seniority_level_id) FROM opening_seniority_levels osl WHERE osl.job_opening_id=o.job_opening_id) AS seniority_ids,
      (SELECT group_concat(sl.label, ', ') FROM opening_seniority_levels osl JOIN seniority_levels sl ON sl.id=osl.seniority_level_id WHERE osl.job_opening_id=o.job_opening_id ORDER BY osl.is_primary DESC, sl.sort_rank) AS seniority_levels,
      ${tableExists(db, 'opportunity_tag_links') ? `(SELECT group_concat(t.label, ', ') FROM opportunity_tag_links otl JOIN tags t ON t.id=otl.tag_id ${publicTagJoins('t')} WHERE otl.opportunity_id=o.id AND ${publicTagPredicate()} ORDER BY lower(t.label))` : 'NULL'} AS normalized_tags,
      ${tableExists(db, 'opening_tags') ? `(SELECT group_concat(t.label, ', ') FROM opening_tags ot JOIN tags t ON t.id=ot.tag_id ${publicTagJoins('t')} WHERE ot.job_opening_id=o.job_opening_id AND ${publicTagPredicate()} ORDER BY lower(t.label))` : 'NULL'} AS opening_tags,
      (SELECT decision FROM opportunity_triage WHERE opportunity_id=o.id ORDER BY id DESC LIMIT 1) AS latest_decision,
      (SELECT score FROM opportunity_triage WHERE opportunity_id=o.id ORDER BY id DESC LIMIT 1) AS latest_score,
      (SELECT score_coverage FROM opportunity_triage WHERE opportunity_id=o.id ORDER BY id DESC LIMIT 1) AS score_coverage,
      (SELECT group_concat(tag, ', ') FROM opportunity_tags WHERE opportunity_id=o.id ORDER BY tag) AS tag_list,
      (SELECT COUNT(*) FROM opportunity_observations WHERE opportunity_id=o.id) AS observation_count,
      (SELECT COUNT(*) FROM opportunities d WHERE d.dedupe_fingerprint=o.dedupe_fingerprint AND d.id<>o.id) AS possible_duplicate_count
    FROM opportunities o
    JOIN entities e ON e.entity_key='opportunity:' || o.id
    LEFT JOIN discovery_sources ds ON ds.id=o.primary_source_id
    LEFT JOIN job_openings jo ON jo.id=o.job_opening_id
    ${sqlFilters.clause}
    ORDER BY CASE o.state WHEN 'shortlisted' THEN 0 WHEN 'inbox' THEN 1 WHEN 'watching' THEN 2 ELSE 3 END,
      datetime(o.last_seen_at) DESC, o.id DESC
    ${pipeline ? '' : 'LIMIT 1000'}
  `).all(sqlFilters.params);
  const gapMap = listOpportunityMissingProfileSignals(db, rows.map((row) => row.id));
  return rows.map((row) => decoratePositionRow({
    ...row,
    company: row.company_name,
    role: row.title,
    item_type: 'opportunity',
    derived_status: 'opportunity',
    compensation: safeJson(row.compensation_json, null),
    missing_profile: gapMap.get(row.id) || null
  }));
}

function listDiscoveryProposals(filters = {}, facets = listFilterFacets('discovery')) {
  const db = getDb();
  if (!tableExists(db, 'discovery_import_proposals')) return [];
  const sqlFilters = buildEntityFilter(filters, 'discovery', {
    statusExpression: `COALESCE(d.decision,'pending')`,
    queryExpressions: [
      `json_extract(p.proposal_json,'$.facts.companyName')`,
      `json_extract(p.proposal_json,'$.facts.title')`,
      `json_extract(p.proposal_json,'$.facts.locationText')`,
      `json_extract(p.proposal_json,'$.facts.descriptionText')`,
      'p.source_key',
      tableExists(db, 'discovery_proposal_tags') ? `(SELECT group_concat(t.label, ' ') FROM discovery_proposal_tags search_dpt JOIN tags t ON t.id=search_dpt.tag_id ${publicTagJoins('t')} WHERE search_dpt.discovery_proposal_id=p.id AND ${publicTagPredicate()})` : "''"
    ]
  });
  const proposals = db.prepare(`
    WITH entities AS (${scopeEntityCte('discovery', db)})
    SELECT p.*, d.decision, d.decided_by, d.rationale, d.decided_at,
      ${tableExists(db, 'discovery_proposal_tags') ? `(SELECT group_concat(t.label, ', ') FROM discovery_proposal_tags dpt JOIN tags t ON t.id=dpt.tag_id ${publicTagJoins('t')} WHERE dpt.discovery_proposal_id=p.id AND ${publicTagPredicate()} ORDER BY lower(t.label))` : 'NULL'} AS normalized_tags,
      (SELECT count(*) FROM discovery_import_occurrences occurrence
       WHERE occurrence.proposal_row_id=p.id) AS occurrence_count
    FROM discovery_import_proposals p
    JOIN entities e ON e.entity_key='proposal:' || p.id
    LEFT JOIN discovery_import_decisions d ON d.proposal_row_id=p.id
    ${sqlFilters.clause}
    ORDER BY p.id DESC LIMIT 500
  `).all(sqlFilters.params).map(serializeDiscoveryProposal).map((row) => decorateDiscoveryProposal(row, facets));
  return proposals;
}

function readDiscoveryProposal(proposalId) {
  if (!/^sha256:[a-f0-9]{64}$/.test(String(proposalId || ''))) return null;
  const db = getDb();
  if (!tableExists(db, 'discovery_import_proposals')) return null;
  const row = db.prepare(`
    SELECT p.*, d.decision, d.decided_by, d.rationale, d.decided_at,
      d.intent_sha256,
      (SELECT count(*) FROM discovery_import_occurrences occurrence
       WHERE occurrence.proposal_row_id=p.id) AS occurrence_count
    FROM discovery_import_proposals p
    LEFT JOIN discovery_import_decisions d ON d.proposal_row_id=p.id
    WHERE p.proposal_id=?
  `).get(proposalId);
  if (!row) return null;
  const proposal = serializeDiscoveryProposal(row);
  proposal.occurrences = db.prepare(`
    SELECT occurrence.id, occurrence.observation_id, occurrence.observed_at,
      occurrence.observation_sha256, bundle.bundle_id, bundle.plugin_id,
      bundle.plugin_version, bundle.parser_name, bundle.parser_version,
      bundle.run_id, bundle.strategy_kind, bundle.imported_by, bundle.imported_at
    FROM discovery_import_occurrences occurrence
    JOIN discovery_import_bundles bundle ON bundle.id=occurrence.bundle_row_id
    WHERE occurrence.proposal_row_id=? ORDER BY occurrence.id DESC
  `).all(row.id).map((occurrence) => ({
    ...occurrence,
    evidence: db.prepare(`
      SELECT evidence_kind, request_id, url, body_sha256, captured_at, label,
        evidence_sha256, retrieval_sha256, binding_sha256
      FROM discovery_import_evidence WHERE occurrence_id=? ORDER BY evidence_index
    `).all(occurrence.id)
  }));
  return proposal;
}

function serializeDiscoveryProposal(row) {
  const payload = safeJson(row.proposal_json, {});
  return {
    ...row,
    status: row.decision || 'pending',
    facts: payload.facts || {},
    parser: payload.parser || {},
    proposalEvidence: payload.evidence || []
  };
}

function readOpportunity(id) {
  const db = getDb();
  if (!tableExists(db, 'opportunities')) return null;
  const opportunity = db.prepare(`
    SELECT o.*, ds.source_key, ds.label AS source_label
    FROM opportunities o LEFT JOIN discovery_sources ds ON ds.id=o.primary_source_id
    WHERE o.id=?
  `).get(id);
  if (!opportunity) return null;
  return {
    opportunity: { ...opportunity, compensation: safeJson(opportunity.compensation_json, null) },
    identities: tableExists(db, 'opportunity_identities') ? db.prepare('SELECT namespace, identity_value, is_primary, created_at FROM opportunity_identities WHERE opportunity_id=? ORDER BY namespace, id').all(id) : [],
    observations: tableExists(db, 'opportunity_observations') ? db.prepare(`
      SELECT oo.*, ds.source_key FROM opportunity_observations oo
      LEFT JOIN discovery_sources ds ON ds.id=oo.source_id
      WHERE oo.opportunity_id=? ORDER BY datetime(oo.observed_at) DESC, oo.id DESC
    `).all(id) : [],
    snapshots: tableExists(db, 'opportunity_snapshots') ? db.prepare(`
      SELECT id, source_id, observed_url, fetched_at, http_status, content_type, etag, last_modified,
        parser_name, parser_version, raw_attachment_path, raw_sha256, normalized_sha256, created_at
      FROM opportunity_snapshots WHERE opportunity_id=? ORDER BY datetime(fetched_at) DESC, id DESC
    `).all(id) : [],
    triage: tableExists(db, 'opportunity_triage') ? db.prepare('SELECT * FROM opportunity_triage WHERE opportunity_id=? ORDER BY id DESC').all(id).map((row) => ({ ...row, dimensions: safeJson(row.dimensions_json, {}), hardBlockers: safeJson(row.hard_blockers_json, []), profileEntryRefs: safeJson(row.profile_entry_refs, []) })) : [],
    tags: tableExists(db, 'opportunity_tags') ? db.prepare('SELECT * FROM opportunity_tags WHERE opportunity_id=? ORDER BY tag').all(id) : [],
    events: tableExists(db, 'opportunity_events') ? db.prepare('SELECT * FROM opportunity_events WHERE opportunity_id=? ORDER BY id DESC').all(id).map((row) => ({ ...row, details: safeJson(row.details_json, {}) })) : []
  };
}

function listOpenings(filters = {}) {
  const db = getDb();
  if (!tableExists(db, 'job_openings')) return [];
  const sqlFilters = buildEntityFilter(filters, 'openings', {
    statusExpression: 'jo.status',
    queryExpressions: [
      'c.canonical_name', 'jo.canonical_title', 'jo.status',
      `(SELECT group_concat(rt.label, ' ') FROM opening_role_types search_ort JOIN role_types rt ON rt.id=search_ort.role_type_id WHERE search_ort.job_opening_id=jo.id)`,
      `(SELECT group_concat(sl.label, ' ') FROM opening_seniority_levels search_osl JOIN seniority_levels sl ON sl.id=search_osl.seniority_level_id WHERE search_osl.job_opening_id=jo.id)`,
      tableExists(db, 'opening_tags') ? `(SELECT group_concat(t.label, ' ') FROM opening_tags search_ot JOIN tags t ON t.id=search_ot.tag_id ${publicTagJoins('t')} WHERE search_ot.job_opening_id=jo.id AND ${publicTagPredicate()})` : "''"
    ]
  });
  return db.prepare(`
    WITH entities AS (${scopeEntityCte('openings', db)})
    SELECT jo.*, c.canonical_name AS company, c.id AS company_id,
      (SELECT group_concat(ort.role_type_id) FROM opening_role_types ort WHERE ort.job_opening_id=jo.id) AS role_type_ids,
      (SELECT group_concat(rt.label, ', ') FROM opening_role_types ort JOIN role_types rt ON rt.id=ort.role_type_id WHERE ort.job_opening_id=jo.id ORDER BY ort.is_primary DESC, rt.label) AS role_types,
      (SELECT group_concat(osl.seniority_level_id) FROM opening_seniority_levels osl WHERE osl.job_opening_id=jo.id) AS seniority_ids,
      (SELECT group_concat(sl.label, ', ') FROM opening_seniority_levels osl JOIN seniority_levels sl ON sl.id=osl.seniority_level_id WHERE osl.job_opening_id=jo.id ORDER BY osl.is_primary DESC, sl.sort_rank) AS seniority_levels,
      ${tableExists(db, 'opening_tags') ? `(SELECT group_concat(t.label, ', ') FROM opening_tags ot JOIN tags t ON t.id=ot.tag_id ${publicTagJoins('t')} WHERE ot.job_opening_id=jo.id AND ${publicTagPredicate()} ORDER BY lower(t.label))` : 'NULL'} AS normalized_tags,
      ${tableExists(db, 'opportunity_tag_links') ? `(SELECT group_concat(DISTINCT t.label) FROM opportunities tag_o JOIN opportunity_tag_links otl ON otl.opportunity_id=tag_o.id JOIN tags t ON t.id=otl.tag_id ${publicTagJoins('t')} WHERE tag_o.job_opening_id=jo.id AND ${publicTagPredicate()})` : 'NULL'} AS inherited_tags,
      (SELECT count(*) FROM job_postings jp WHERE jp.job_opening_id=jo.id) AS posting_count,
      (SELECT count(*) FROM applications a WHERE a.job_opening_id=jo.id) AS application_count,
      (SELECT count(DISTINCT psr.skill_id) FROM job_postings jp JOIN posting_skill_requirements psr ON psr.job_posting_id=jp.id WHERE jp.job_opening_id=jo.id) AS skill_count
    FROM job_openings jo JOIN entities e ON e.entity_key='opening:' || jo.id
    JOIN companies c ON c.id=jo.company_id
    ${sqlFilters.clause}
    ORDER BY lower(c.canonical_name), lower(jo.canonical_title), jo.id LIMIT 500
  `).all(sqlFilters.params).map((row) => decoratePositionRow({ ...row, role: row.canonical_title, derived_status: row.status }));
}

function readOpening(id) {
  const db = getDb();
  if (!tableExists(db, 'job_openings')) return null;
  const opening = db.prepare(`
    SELECT jo.*, c.canonical_name AS company, c.website_domain
    FROM job_openings jo JOIN companies c ON c.id=jo.company_id WHERE jo.id=?
  `).get(id);
  if (!opening) return null;
  return {
    opening,
    identifiers: db.prepare('SELECT namespace, identifier_value, created_at FROM opening_identifiers WHERE job_opening_id=? ORDER BY namespace, identifier_value').all(id),
    roleTypes: db.prepare('SELECT rt.*, ort.is_primary, ort.confidence, ort.source FROM opening_role_types ort JOIN role_types rt ON rt.id=ort.role_type_id WHERE ort.job_opening_id=? ORDER BY ort.is_primary DESC, rt.label').all(id),
    seniority: db.prepare('SELECT sl.*, osl.is_primary, osl.confidence, osl.source FROM opening_seniority_levels osl JOIN seniority_levels sl ON sl.id=osl.seniority_level_id WHERE osl.job_opening_id=? ORDER BY osl.is_primary DESC, sl.sort_rank').all(id),
    postings: db.prepare(`
      SELECT jp.*, pp.name AS platform, pp.slug AS platform_slug, pv.label AS venue, pv.board_key
      FROM job_postings jp JOIN posting_venues pv ON pv.id=jp.posting_venue_id
      JOIN posting_platforms pp ON pp.id=pv.posting_platform_id
      WHERE jp.job_opening_id=? ORDER BY jp.state, pp.slug, jp.id
    `).all(id),
    applications: db.prepare('SELECT id, company, role, status, workflow_stage, applied_date, primary_job_posting_id FROM applications WHERE job_opening_id=? ORDER BY id DESC').all(id),
    skills: db.prepare(`
      SELECT DISTINCT s.id, s.canonical_name, rk.slug AS requirement_kind,
        psr.raw_phrase, psr.minimum_years, psr.confidence, psr.job_posting_id,
        psr.opportunity_snapshot_id
      FROM job_postings jp JOIN posting_skill_requirements psr ON psr.job_posting_id=jp.id
      JOIN skills s ON s.id=psr.skill_id JOIN requirement_kinds rk ON rk.id=psr.requirement_kind_id
      WHERE jp.job_opening_id=? ORDER BY rk.sort_rank DESC, lower(s.canonical_name), psr.job_posting_id
    `).all(id)
  };
}

function listInterviewQueue(filters = {}) {
  const db = getDb();
  if (!tableExists(db, 'interview_prep_analyses')) return [];
  const sqlFilters = buildEntityFilter(filters, 'interviews', {
    statusExpression: 'i.scheduling_status',
    queryExpressions: [
      'c.canonical_name', 'jo.canonical_title', 'COALESCE(irt.label, i.round)', 'i.format', 'i.interviewer', 'i.scheduling_status',
      `(SELECT group_concat(rt.label, ' ') FROM opening_role_types search_ort JOIN role_types rt ON rt.id=search_ort.role_type_id WHERE search_ort.job_opening_id=jo.id)`,
      `(SELECT group_concat(sl.label, ' ') FROM opening_seniority_levels search_osl JOIN seniority_levels sl ON sl.id=search_osl.seniority_level_id WHERE search_osl.job_opening_id=jo.id)`,
      tableExists(db, 'application_tags') ? `(SELECT group_concat(t.label, ' ') FROM application_tags search_at JOIN tags t ON t.id=search_at.tag_id ${publicTagJoins('t')} WHERE search_at.application_id=a.id AND ${publicTagPredicate()})` : "''",
      tableExists(db, 'opening_tags') ? `(SELECT group_concat(t.label, ' ') FROM opening_tags search_ot JOIN tags t ON t.id=search_ot.tag_id ${publicTagJoins('t')} WHERE search_ot.job_opening_id=jo.id AND ${publicTagPredicate()})` : "''"
    ]
  });
  return db.prepare(`
    WITH entities AS (${scopeEntityCte('interviews', db)})
    SELECT i.id, i.application_id, i.round, irt.slug AS round_type,
      irt.label AS round_type_label, i.scheduled_at, i.scheduled_start_utc,
      i.timezone, i.duration_minutes, i.format, i.interviewer, i.scheduling_status,
      c.canonical_name AS company, jo.canonical_title AS role, jo.company_id,
      (SELECT group_concat(ort.role_type_id) FROM opening_role_types ort WHERE ort.job_opening_id=jo.id) AS role_type_ids,
      (SELECT group_concat(rt.label, ', ') FROM opening_role_types ort JOIN role_types rt ON rt.id=ort.role_type_id WHERE ort.job_opening_id=jo.id ORDER BY ort.is_primary DESC, rt.label) AS role_types,
      (SELECT group_concat(osl.seniority_level_id) FROM opening_seniority_levels osl WHERE osl.job_opening_id=jo.id) AS seniority_ids,
      (SELECT group_concat(sl.label, ', ') FROM opening_seniority_levels osl JOIN seniority_levels sl ON sl.id=osl.seniority_level_id WHERE osl.job_opening_id=jo.id ORDER BY osl.is_primary DESC, sl.sort_rank) AS seniority_levels,
      ${tableExists(db, 'application_tags') ? `(SELECT group_concat(t.label, ', ') FROM application_tags at JOIN tags t ON t.id=at.tag_id ${publicTagJoins('t')} WHERE at.application_id=a.id AND ${publicTagPredicate()} ORDER BY lower(t.label))` : 'NULL'} AS application_tags,
      ${tableExists(db, 'opening_tags') ? `(SELECT group_concat(t.label, ', ') FROM opening_tags ot JOIN tags t ON t.id=ot.tag_id ${publicTagJoins('t')} WHERE ot.job_opening_id=jo.id AND ${publicTagPredicate()} ORDER BY lower(t.label))` : 'NULL'} AS opening_tags,
      ${tableExists(db, 'opportunity_tag_links') ? `(SELECT group_concat(t.label, ', ') FROM opportunity_tag_links otl JOIN tags t ON t.id=otl.tag_id ${publicTagJoins('t')} WHERE otl.opportunity_id=a.source_opportunity_id AND ${publicTagPredicate()} ORDER BY lower(t.label))` : 'NULL'} AS inherited_tags,
      ipa.id AS analysis_id, ipa.version AS analysis_version, ipa.status AS analysis_status,
      (SELECT event_kind FROM interview_prep_events e WHERE e.analysis_id=ipa.id AND e.event_kind IN ('approved','rejected') ORDER BY e.id DESC LIMIT 1) AS review_status
    FROM interviews i JOIN entities e ON e.entity_key='interview:' || i.id
    JOIN applications a ON a.id=i.application_id
    LEFT JOIN interview_round_types irt ON irt.id=i.round_type_id
    LEFT JOIN job_openings jo ON jo.id=a.job_opening_id
    LEFT JOIN companies c ON c.id=jo.company_id
    LEFT JOIN interview_prep_current ipc ON ipc.interview_id=i.id
    LEFT JOIN interview_prep_analyses ipa ON ipa.id=ipc.analysis_id
    ${sqlFilters.clause}
    ORDER BY datetime(i.scheduled_at), i.id
  `).all(sqlFilters.params).map(decoratePositionRow);
}

function readInterviewPrep(id) {
  const db = getDb();
  if (!tableExists(db, 'interview_prep_analyses') || !db.prepare('SELECT 1 FROM interviews WHERE id=?').get(id)) return null;
  return getCurrentInterviewPrep(db, id);
}

function listOpportunityMissingProfileSignals(db, opportunityIds) {
  if (!opportunityIds.length || !tableExists(db, 'opportunity_profile_gap_summary')) return new Map();
  const selected = new Set(opportunityIds);
  const rows = db.prepare('SELECT * FROM opportunity_profile_gap_summary WHERE has_confirmed_missing=1').all()
    .filter((row) => selected.has(row.opportunity_id));
  return new Map(rows.map((row) => [row.opportunity_id, row]));
}

function decorateDiscoveryProposal(row, facets) {
  const facts = row.facts || {};
  const companyName = facts.companyName || facts.attributes?.organizationName || null;
  const company = facets.companies.find((option) => option.label.localeCompare(String(companyName || ''), undefined, { sensitivity: 'base' }) === 0);
  return decoratePositionRow({
    ...row,
    company: companyName,
    role: facts.title,
    company_id: company?.id || null,
    normalized_tags: row.normalized_tags,
    derived_status: row.status,
    item_type: 'discovery proposal'
  });
}

module.exports = {
  listOpportunities,
  listDiscoveryProposals,
  readDiscoveryProposal,
  readOpportunity,
  listOpenings,
  readOpening,
  listInterviewQueue,
  readInterviewPrep
};
