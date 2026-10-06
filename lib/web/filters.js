'use strict';

// Filters: turning an untrusted query string into a bounded, validated filter
// set, and that set into SQL.
//
// Two halves, one idea. The READ half accepts nothing it cannot name: every
// facet value must match an option the store actually produced, every enum
// must be in an explicit allow-list, and text is length-capped. A value that
// fails is a 400 with a public message, never a silent empty result — a filter
// that quietly matches nothing looks exactly like a store with no records.
//
// The SQL half builds one entity CTE per scope (applications, openings,
// opportunities, discovery, interviews, profile, and the pipeline union), then
// composes clauses over it with NAMED parameters only. Nothing from the request
// is ever interpolated into SQL; the request supplies parameter values, and the
// scope supplies the fragments.
//
// Tag visibility is enforced here too: a tag reaches the web surface only if
// its own status, its namespace's status, and the namespace's sensitivity all
// say so (publicTagJoins/publicTagPredicate). Private-namespace tags are not
// filtered out downstream — they never enter a query.

const crypto = require('node:crypto');
const { getDb, tableExists } = require('./store');

const SORTS = new Set(['company', 'role', 'status', 'workflow', 'package', 'latest', 'type']);
const DIRECTIONS = new Set(['asc', 'desc']);
const MAX_QUERY_TEXT = 160;
const MAX_FACET_OPTIONS = 500;
const MAX_SELECTED_TAGS = 8;
const APPLICATION_STATUSES = ['prospective', 'submitted', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn', 'archived'];
const WORKFLOW_STAGES = ['prospective', 'researched', 'assessment_ready', 'assessment_approved', 'letter_drafted', 'package_ready', 'submitted', 'declined', 'archived'];
const OPPORTUNITY_STATES = ['inbox', 'shortlisted', 'watching', 'dismissed', 'promoted', 'closed'];
const DISCOVERY_STATUSES = ['pending', 'accepted', 'rejected'];
const STORY_STATUSES = ['captured', 'developing', 'ready', 'needs_review', 'retired'];
const PIPELINE_STATUSES = ['opportunity', 'prospective', 'submitted', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn', 'archived'];

function readCollectionContext(req, {
  scope = 'openings',
  statusOptions = [],
  stateOptions = [],
  workflowOptions = [],
  positionFacets = true,
  defaultSort = 'latest'
} = {}) {
  const facets = listFilterFacets(scope);
  const filters = {
    q: readBoundedText(req.query.q, 'q'),
    company: positionFacets ? readFacet(req.query.company, facets.companies, 'company') : null,
    tags: readFacetList(req.query.tag, facets.tags, 'tag'),
    role_type: positionFacets ? readFacet(req.query.role_type, facets.roleTypes, 'role type') : null,
    seniority: positionFacets ? readFacet(req.query.seniority, facets.seniority, 'position level') : null,
    status: readEnum(req.query.status, statusOptions, 'status'),
    state: readEnum(req.query.state, stateOptions, 'state'),
    workflow: readEnum(req.query.workflow, workflowOptions, 'workflow stage')
  };
  const sort = readEnum(req.query.sort, [...SORTS], 'sort') || defaultSort;
  const dir = readEnum(req.query.dir, [...DIRECTIONS], 'direction') || (sort === 'company' ? 'asc' : 'desc');
  return { filters, facets, sort, dir, positionFacets, statusOptions, stateOptions, workflowOptions };
}

function readBoundedText(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw badFilter(`${name} must be a single text value`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > MAX_QUERY_TEXT) throw badFilter(`${name} is too long`);
  return normalized;
}

function readFacet(value, options, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_QUERY_TEXT) throw badFilter(`${name} must be a bounded select value`);
  const match = options.find((option) => option.value === value);
  if (!match) throw badFilter(`Unknown ${name} filter`);
  return match;
}

function readFacetList(value, options, name) {
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length > MAX_SELECTED_TAGS) throw badFilter(`Too many ${name} filters`);
  const selected = [];
  for (const item of values) {
    if (typeof item !== 'string' || item.length > MAX_QUERY_TEXT) throw badFilter(`${name} must be a bounded select value`);
    const match = options.find((option) => option.value === item);
    if (!match) throw badFilter(`Unknown ${name} filter`);
    if (!selected.some((option) => option.value === match.value)) selected.push(match);
  }
  return selected;
}

function readEnum(value, allowed, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !allowed.includes(value)) throw badFilter(`Unknown ${name} filter`);
  return value;
}

function badFilter(publicMessage) {
  const error = new Error(publicMessage);
  error.status = 400;
  error.publicMessage = publicMessage;
  return error;
}

function listFilterFacets(scope = 'openings') {
  const db = getDb();
  const cte = scopeEntityCte(scope, db);
  if (!cte) return { companies: [], roleTypes: [], seniority: [], tags: [] };
  const companies = tableExists(db, 'companies') ? db.prepare(`
    WITH entities AS (${cte})
    SELECT c.id, c.canonical_name, count(DISTINCT e.entity_key) AS count
    FROM entities e JOIN companies c ON c.id=e.company_id
    GROUP BY c.id, c.canonical_name ORDER BY lower(c.canonical_name), c.id LIMIT ?
  `).all(MAX_FACET_OPTIONS).map((row) => ({
    value: String(row.id), label: row.canonical_name, id: row.id,
    canonicalName: row.canonical_name, count: row.count
  })) : [];
  if (scope === 'discovery') {
    const extracted = db.prepare(`
      WITH entities AS (${cte})
      SELECT lower(trim(extracted_company)) AS company_key,
        MIN(trim(extracted_company)) AS company_label,
        count(DISTINCT entity_key) AS count FROM entities
      WHERE company_id IS NULL AND trim(COALESCE(extracted_company,''))<>''
      GROUP BY lower(trim(extracted_company)) ORDER BY company_key LIMIT ?
    `).all(Math.max(0, MAX_FACET_OPTIONS - companies.length));
    for (const row of extracted) {
      companies.push({
        value: `proposal:${crypto.createHash('sha256').update(row.company_key).digest('hex')}`,
        label: row.company_label,
        id: null,
        proposalKey: row.company_key,
        count: row.count
      });
    }
  }

  let roleTypes = [];
  let seniority = [];
  if (scope !== 'profile' && tableExists(db, 'role_types') && tableExists(db, 'opening_role_types')) {
    roleTypes = db.prepare(`
      WITH entities AS (${cte})
      SELECT rt.id, rt.slug, rt.label, count(DISTINCT e.entity_key) AS count
      FROM entities e JOIN opening_role_types ort ON ort.job_opening_id=e.opening_id
      JOIN role_types rt ON rt.id=ort.role_type_id
      GROUP BY rt.id, rt.slug, rt.label ORDER BY lower(rt.label), rt.id LIMIT ?
    `).all(MAX_FACET_OPTIONS).map((row) => ({ value: String(row.id), label: row.label, id: row.id, slug: row.slug, count: row.count }));
    const unclassified = db.prepare(`
      WITH entities AS (${cte}) SELECT count(DISTINCT e.entity_key) AS count FROM entities e
      WHERE e.opening_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM opening_role_types ort WHERE ort.job_opening_id=e.opening_id
      )
    `).get().count;
    if (unclassified) roleTypes.unshift({ value: 'unclassified', label: 'Unclassified', id: null, slug: 'unclassified', unclassified: true, count: unclassified });
  }
  if (scope !== 'profile' && tableExists(db, 'seniority_levels') && tableExists(db, 'opening_seniority_levels')) {
    seniority = db.prepare(`
      WITH entities AS (${cte})
      SELECT sl.id, sl.slug, sl.label, count(DISTINCT e.entity_key) AS count
      FROM entities e JOIN opening_seniority_levels osl ON osl.job_opening_id=e.opening_id
      JOIN seniority_levels sl ON sl.id=osl.seniority_level_id
      GROUP BY sl.id, sl.slug, sl.label ORDER BY sl.sort_rank, sl.id LIMIT ?
    `).all(MAX_FACET_OPTIONS).map((row) => ({ value: String(row.id), label: row.label, id: row.id, slug: row.slug, count: row.count }));
    const unclassified = db.prepare(`
      WITH entities AS (${cte}) SELECT count(DISTINCT e.entity_key) AS count FROM entities e
      WHERE e.opening_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM opening_seniority_levels osl WHERE osl.job_opening_id=e.opening_id
      )
    `).get().count;
    if (unclassified) seniority.unshift({ value: 'unclassified', label: 'Unclassified', id: null, slug: 'unclassified', unclassified: true, count: unclassified });
  }

  const tagMatch = tagMatchSql(scope, 'e', 'tags.id');
  const hasTagTaxonomy = ['tags', 'tag_namespaces', 'tag_lifecycle_statuses', 'tag_namespace_sensitivity_levels'].every((table) => tableExists(db, table));
  const tags = tagMatch && hasTagTaxonomy
    ? db.prepare(`
        WITH entities AS (${cte})
        SELECT tags.id, tags.slug, tags.label, tag_namespaces.slug AS namespace_slug,
          tag_namespaces.label AS namespace_label, count(DISTINCT e.entity_key) AS count
        FROM tags JOIN tag_namespaces ON tag_namespaces.id=tags.tag_namespace_id
        JOIN tag_lifecycle_statuses tag_status ON tag_status.id=tags.status_id
        JOIN tag_lifecycle_statuses namespace_status ON namespace_status.id=tag_namespaces.status_id
        JOIN tag_namespace_sensitivity_levels sensitivity ON sensitivity.id=tag_namespaces.sensitivity_level_id
        JOIN entities e ON ${tagMatch}
        WHERE tag_status.slug='active' AND namespace_status.slug='active' AND sensitivity.slug='public'
        GROUP BY tags.id, tags.slug, tags.label, tag_namespaces.slug, tag_namespaces.label
        ORDER BY lower(tag_namespaces.label), lower(tags.label), tags.id LIMIT ?
      `).all(MAX_FACET_OPTIONS).map((row) => ({
        value: String(row.id), label: row.label, id: row.id, slug: row.slug, count: row.count,
        namespaceSlug: row.namespace_slug, namespaceLabel: row.namespace_label
      }))
    : [];
  return { companies, roleTypes, seniority, tags };
}

function publicTagJoins(tagAlias) {
  return `JOIN tag_namespaces web_tag_ns ON web_tag_ns.id=${tagAlias}.tag_namespace_id
    JOIN tag_lifecycle_statuses web_tag_status ON web_tag_status.id=${tagAlias}.status_id
    JOIN tag_lifecycle_statuses web_ns_status ON web_ns_status.id=web_tag_ns.status_id
    JOIN tag_namespace_sensitivity_levels web_tag_sensitivity ON web_tag_sensitivity.id=web_tag_ns.sensitivity_level_id`;
}

function publicTagPredicate() {
  return `web_tag_status.slug='active' AND web_ns_status.slug='active' AND web_tag_sensitivity.slug='public'`;
}

function hasNormalizedProfileTags(db) {
  return [
    'profile_entry_tags', 'tags', 'tag_namespaces',
    'tag_lifecycle_statuses', 'tag_namespace_sensitivity_levels'
  ].every((table) => tableExists(db, table));
}

function scopeEntityCte(scope, db) {
  if (scope === 'applications' && tableExists(db, 'applications')) return `
    SELECT 'application:' || a.id AS entity_key, a.job_opening_id AS opening_id,
      a.id AS application_id, NULL AS opportunity_id, NULL AS proposal_id,
      NULL AS profile_entry_id, jo.company_id AS company_id, NULL AS extracted_company
    FROM applications a LEFT JOIN job_openings jo ON jo.id=a.job_opening_id`;
  if (scope === 'openings' && tableExists(db, 'job_openings')) return `
    SELECT 'opening:' || jo.id AS entity_key, jo.id AS opening_id, NULL AS application_id,
      NULL AS opportunity_id, NULL AS proposal_id, NULL AS profile_entry_id,
      jo.company_id AS company_id, NULL AS extracted_company FROM job_openings jo`;
  if (scope === 'opportunities' && tableExists(db, 'opportunities')) return `
    SELECT 'opportunity:' || o.id AS entity_key, o.job_opening_id AS opening_id,
      NULL AS application_id, o.id AS opportunity_id, NULL AS proposal_id,
      NULL AS profile_entry_id, jo.company_id AS company_id, o.company_name AS extracted_company
    FROM opportunities o LEFT JOIN job_openings jo ON jo.id=o.job_opening_id`;
  if (scope === 'interviews' && tableExists(db, 'interviews')) return `
    SELECT 'interview:' || i.id AS entity_key, a.job_opening_id AS opening_id,
      a.id AS application_id, NULL AS opportunity_id, NULL AS proposal_id,
      NULL AS profile_entry_id, jo.company_id AS company_id, NULL AS extracted_company
    FROM interviews i JOIN applications a ON a.id=i.application_id
    LEFT JOIN job_openings jo ON jo.id=a.job_opening_id
    WHERE i.outcome='pending'`;
  if (scope === 'discovery' && tableExists(db, 'discovery_import_proposals')) return `
    SELECT 'proposal:' || p.id AS entity_key, NULL AS opening_id, NULL AS application_id,
      NULL AS opportunity_id, p.id AS proposal_id, NULL AS profile_entry_id,
      (SELECT c.id FROM companies c
       WHERE lower(trim(c.canonical_name))=lower(trim(json_extract(p.proposal_json,'$.facts.companyName')))
       ORDER BY c.id LIMIT 1) AS company_id,
      json_extract(p.proposal_json,'$.facts.companyName') AS extracted_company
    FROM discovery_import_proposals p`;
  if (scope === 'profile' && tableExists(db, 'profile_stories')) return `
    SELECT 'story:' || ps.id AS entity_key, NULL AS opening_id, NULL AS application_id,
      NULL AS opportunity_id, NULL AS proposal_id, ps.profile_entry_id,
      NULL AS company_id, NULL AS extracted_company FROM profile_stories ps`;
  if (scope === 'pipeline' && tableExists(db, 'applications') && tableExists(db, 'opportunities')) return `
    SELECT 'application:' || a.id AS entity_key, a.job_opening_id AS opening_id,
      a.id AS application_id, NULL AS opportunity_id, NULL AS proposal_id,
      NULL AS profile_entry_id, jo.company_id AS company_id, NULL AS extracted_company
    FROM applications a LEFT JOIN job_openings jo ON jo.id=a.job_opening_id
    UNION ALL
    SELECT 'opportunity:' || o.id, o.job_opening_id, NULL, o.id, NULL, NULL,
      jo.company_id, o.company_name
    FROM opportunities o LEFT JOIN job_openings jo ON jo.id=o.job_opening_id
    WHERE o.promoted_application_id IS NULL AND o.state<>'promoted'
      AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.source_opportunity_id=o.id)`;
  return null;
}

function tagMatchSql(scope, entityAlias, tagIdExpression) {
  const e = entityAlias;
  const tag = tagIdExpression;
  if (scope === 'applications' || scope === 'interviews') return `(
    EXISTS (SELECT 1 FROM application_tags at WHERE at.application_id=${e}.application_id AND at.tag_id=${tag}) OR
    EXISTS (SELECT 1 FROM applications tag_app JOIN opportunity_tag_links otl ON otl.opportunity_id=tag_app.source_opportunity_id WHERE tag_app.id=${e}.application_id AND otl.tag_id=${tag}) OR
    EXISTS (SELECT 1 FROM opening_tags ot WHERE ot.job_opening_id=${e}.opening_id AND ot.tag_id=${tag})
  )`;
  if (scope === 'openings') return `(
    EXISTS (SELECT 1 FROM opening_tags ot WHERE ot.job_opening_id=${e}.opening_id AND ot.tag_id=${tag}) OR
    EXISTS (SELECT 1 FROM opportunities tag_opp JOIN opportunity_tag_links otl ON otl.opportunity_id=tag_opp.id WHERE tag_opp.job_opening_id=${e}.opening_id AND otl.tag_id=${tag})
  )`;
  if (scope === 'opportunities') return `(
    EXISTS (SELECT 1 FROM opportunity_tag_links otl WHERE otl.opportunity_id=${e}.opportunity_id AND otl.tag_id=${tag}) OR
    EXISTS (SELECT 1 FROM opening_tags ot WHERE ot.job_opening_id=${e}.opening_id AND ot.tag_id=${tag})
  )`;
  if (scope === 'pipeline') return `(
    EXISTS (SELECT 1 FROM application_tags at WHERE at.application_id=${e}.application_id AND at.tag_id=${tag}) OR
    EXISTS (SELECT 1 FROM applications tag_app JOIN opportunity_tag_links inherited_otl ON inherited_otl.opportunity_id=tag_app.source_opportunity_id WHERE tag_app.id=${e}.application_id AND inherited_otl.tag_id=${tag}) OR
    EXISTS (SELECT 1 FROM opportunity_tag_links otl WHERE otl.opportunity_id=${e}.opportunity_id AND otl.tag_id=${tag}) OR
    EXISTS (SELECT 1 FROM opening_tags ot WHERE ot.job_opening_id=${e}.opening_id AND ot.tag_id=${tag})
  )`;
  if (scope === 'discovery') return `EXISTS (SELECT 1 FROM discovery_proposal_tags dpt WHERE dpt.discovery_proposal_id=${e}.proposal_id AND dpt.tag_id=${tag})`;
  if (scope === 'profile') return `EXISTS (SELECT 1 FROM profile_entry_tags pet WHERE pet.profile_entry_id=${e}.profile_entry_id AND pet.tag_id=${tag})`;
  return null;
}

function buildEntityFilter(filters, scope, {
  statusExpression = null,
  stateExpression = null,
  workflowExpression = null,
  queryExpressions = [],
  extraClauses = []
} = {}) {
  const clauses = [...extraClauses];
  const params = {};
  if (filters.company) {
    if (filters.company.proposalKey) {
      clauses.push(`lower(trim(e.extracted_company))=@filter_company_key`);
      params.filter_company_key = filters.company.proposalKey;
    } else {
      clauses.push('e.company_id=@filter_company_id');
      params.filter_company_id = filters.company.id;
    }
  }
  if (filters.role_type) {
    clauses.push(filters.role_type.unclassified
      ? `(e.opening_id IS NULL OR NOT EXISTS (SELECT 1 FROM opening_role_types filter_ort WHERE filter_ort.job_opening_id=e.opening_id))`
      : `EXISTS (SELECT 1 FROM opening_role_types filter_ort WHERE filter_ort.job_opening_id=e.opening_id AND filter_ort.role_type_id=@filter_role_type_id)`);
    if (!filters.role_type.unclassified) params.filter_role_type_id = filters.role_type.id;
  }
  if (filters.seniority) {
    clauses.push(filters.seniority.unclassified
      ? `(e.opening_id IS NULL OR NOT EXISTS (SELECT 1 FROM opening_seniority_levels filter_osl WHERE filter_osl.job_opening_id=e.opening_id))`
      : `EXISTS (SELECT 1 FROM opening_seniority_levels filter_osl WHERE filter_osl.job_opening_id=e.opening_id AND filter_osl.seniority_level_id=@filter_seniority_id)`);
    if (!filters.seniority.unclassified) params.filter_seniority_id = filters.seniority.id;
  }
  for (const [index, tag] of (filters.tags || []).entries()) {
    const parameter = `filter_tag_${index}`;
    clauses.push(tagMatchSql(scope, 'e', `@${parameter}`));
    params[parameter] = tag.id;
  }
  if (filters.status && statusExpression) {
    clauses.push(`${statusExpression}=@filter_status`);
    params.filter_status = filters.status;
  }
  if (filters.state && stateExpression) {
    clauses.push(`${stateExpression}=@filter_state`);
    params.filter_state = filters.state;
  }
  if (filters.workflow && workflowExpression) {
    clauses.push(`${workflowExpression}=@filter_workflow`);
    params.filter_workflow = filters.workflow;
  }
  if (filters.q && queryExpressions.length) {
    clauses.push(`(${queryExpressions.map((expression) => `COALESCE(${expression},'') LIKE @filter_query`).join(' OR ')})`);
    params.filter_query = `%${filters.q}%`;
  }
  return { clause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function pipelineApplicationStatusSql(status) {
  if (!status) return null;
  if (status === 'opportunity') return '0';
  if (status === 'accepted') return `EXISTS (SELECT 1 FROM offers filter_offer WHERE filter_offer.application_id=a.id AND filter_offer.outcome='accepted')`;
  if (status === 'rejected') return `(a.status='rejected' OR a.workflow_stage='declined' OR EXISTS (SELECT 1 FROM offers filter_offer WHERE filter_offer.application_id=a.id AND filter_offer.outcome='declined'))`;
  if (status === 'prospective') return `a.workflow_stage IN ('prospective','researched','assessment_ready','assessment_approved','letter_drafted','package_ready')`;
  if (status === 'submitted') return `a.workflow_stage='submitted' AND a.status='applied'`;
  if (status === 'archived') return `a.workflow_stage='archived'`;
  if (status === 'offer') return `a.status='offer' AND NOT EXISTS (SELECT 1 FROM offers filter_offer WHERE filter_offer.application_id=a.id AND filter_offer.outcome='accepted')`;
  return `a.status=@filter_pipeline_status`;
}

module.exports = {
  SORTS,
  DIRECTIONS,
  MAX_QUERY_TEXT,
  MAX_FACET_OPTIONS,
  MAX_SELECTED_TAGS,
  APPLICATION_STATUSES,
  WORKFLOW_STAGES,
  OPPORTUNITY_STATES,
  DISCOVERY_STATUSES,
  STORY_STATUSES,
  PIPELINE_STATUSES,
  readCollectionContext,
  badFilter,
  listFilterFacets,
  publicTagJoins,
  publicTagPredicate,
  hasNormalizedProfileTags,
  scopeEntityCte,
  tagMatchSql,
  buildEntityFilter,
  pipelineApplicationStatusSql
};
