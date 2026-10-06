'use strict';

// The profile corpus: one operator-curated record of who Cole is, assembled
// from a flat entries table plus eleven structured side-tables.
//
// Assembly, not a join: each side-table is attached onto its owning entry by
// id, so a store that predates a migration simply contributes nothing for that
// kind instead of failing the page. Work entries additionally carry a nested
// detail outline, rebuilt here from its parent/position rows.
//
// Two things are deliberate. Curation comes first — jobtrack profile
// set-display pins, hides and orders entries, and that is a statement about
// importance that chronology must not overrule (see lib/web/profile-order.js).
// And story CAPTURES keep their raw narrative out of list reads: the web
// surface renders meaning, and only the CLI can reveal raw text on request.

const {
  getDb,
  tableExists,
  tableRows,
  safeJson
} = require('../store');
const {
  publicTagJoins,
  publicTagPredicate,
  hasNormalizedProfileTags,
  scopeEntityCte,
  buildEntityFilter
} = require('../filters');
const { parseTags, splitCommaList, sortByFreshness } = require('./rows');
const { sortByDisplay } = require('../../profile-presentation');
const { attachProfileSkillLinks } = require('../../profile-skill-relations');
const { attachProjectRepos } = require('../../repos');
const { attachProjectRelations } = require('../../project-graph');

function listProfileCorpus(storyFilters = {}) {
  const db = getDb();
  const entries = sortByDisplay(tableRows(db, 'profile_entries')).map(serializeProfileEntry);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  attachStructuredRows(db, byId, 'profile_work_entries', 'work', (row) => ({ ...row, is_present: Boolean(row.is_present) }));
  // Detail outlines ride along with their work entries (nested tree per node).
  {
    const outlineRows = tableExists(db, 'profile_work_entry_details')
      ? db.prepare(`
        SELECT d.id, d.work_entry_id, d.parent_detail_id, d.position, d.detail
        FROM profile_work_entry_details d ORDER BY d.parent_detail_id, d.position
      `).all()
      : [];
    const byEntry = new Map();
    for (const row of outlineRows) {
      if (!byEntry.has(row.work_entry_id)) byEntry.set(row.work_entry_id, new Map());
      const byParent = byEntry.get(row.work_entry_id);
      const key = row.parent_detail_id ?? 0;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(row);
    }
    for (const entry of byId.values()) {
      if (!entry.work) continue;
      const byParent = byEntry.get(entry.work.id);
      if (!byParent) { entry.work.detailOutline = []; continue; }
      const build = (parentKey) => (byParent.get(parentKey) || []).map((row) => ({
        id: row.id, detail: row.detail, children: build(row.id)
      }));
      entry.work.detailOutline = build(0);
    }
  }
  attachStructuredRows(db, byId, 'profile_education_entries', 'education');
  attachStructuredRows(db, byId, 'profile_links', 'link');
  attachStructuredRows(db, byId, 'profile_skills', 'skill');
  attachStructuredRows(db, byId, 'profile_projects', 'project', (row) => ({ ...row, stack: parseTags(row.stack), links: parseTags(row.links) }));
  attachStructuredRows(db, byId, 'profile_credentials', 'credential');
  attachStructuredRows(db, byId, 'profile_recognitions', 'recognition');
  attachStructuredRows(db, byId, 'profile_publications', 'publication');
  attachStructuredRows(db, byId, 'profile_languages', 'language');
  attachStructuredRows(db, byId, 'profile_volunteer_entries', 'volunteer', (row) => ({ ...row, is_present: Boolean(row.is_present) }));
  attachStructuredRows(db, byId, 'profile_answers', 'answer');
  attachNormalizedProfileMetadata(db, byId);
  attachProfileSkillLinks(db, byId);
  attachProjectRepos(db, byId);
  attachProjectRelations(db, byId);

  return {
    contact: firstTableRow(db, 'profile_contact', (row) => row.id === 1),
    entries,
    stories: listStories(storyFilters),
    references: sortByFreshness(tableRows(db, 'profile_references')).map(serializeSensitiveProfileRow),
    eeo: firstTableRow(db, 'profile_eeo', (row) => row.id === 1)
  };
}

function attachNormalizedProfileMetadata(db, byId) {
  if (hasNormalizedProfileTags(db)) {
    const grouped = new Map();
    for (const entry of byId.values()) {
      entry.tags = [];
      entry.normalizedTags = [];
    }
    for (const row of db.prepare(`
      SELECT pet.profile_entry_id, t.id, t.slug, t.label, ns.slug AS namespace_slug, ns.label AS namespace_label
      FROM profile_entry_tags pet JOIN tags t ON t.id=pet.tag_id
      JOIN tag_namespaces ns ON ns.id=t.tag_namespace_id
      JOIN tag_lifecycle_statuses ts ON ts.id=t.status_id
      JOIN tag_lifecycle_statuses nss ON nss.id=ns.status_id
      JOIN tag_namespace_sensitivity_levels sensitivity ON sensitivity.id=ns.sensitivity_level_id
      WHERE ts.slug='active' AND nss.slug='active' AND sensitivity.slug='public'
      ORDER BY lower(ns.label), lower(t.label), t.id
    `).all()) {
      const values = grouped.get(row.profile_entry_id) || [];
      values.push(row);
      grouped.set(row.profile_entry_id, values);
    }
    for (const [entryId, tags] of grouped) {
      const entry = byId.get(entryId);
      if (!entry) continue;
      entry.tags = tags.map((tag) => tag.label);
      entry.normalizedTags = tags;
    }
  }
  if (tableExists(db, 'profile_project_skills') && tableExists(db, 'skills')) {
    for (const entry of byId.values()) {
      if (!entry.project?.id) continue;
      entry.project.normalizedSkills = db.prepare(`
        SELECT s.canonical_name FROM profile_project_skills pps JOIN skills s ON s.id=pps.skill_id
        WHERE pps.profile_project_id=? ORDER BY pps.position, s.id
      `).all(entry.project.id).map((row) => row.canonical_name);
    }
  }
  if (tableExists(db, 'companies')) {
    const lookup = db.prepare('SELECT canonical_name FROM companies WHERE id=?');
    for (const entry of byId.values()) {
      if (entry.work?.company_id) entry.work.normalizedCompany = lookup.get(entry.work.company_id)?.canonical_name || null;
    }
  }
}

function listProfileEntries() {
  return listProfileCorpus().entries;
}

function listStories(filters = {}) {
  const db = getDb();
  if (!tableExists(db, 'profile_stories')) return [];
  const useNormalizedTags = hasNormalizedProfileTags(db);
  const sqlFilters = buildEntityFilter(filters, 'profile', {
    statusExpression: 'ps.status',
    queryExpressions: [
      'pe.title', 'r.one_line_summary', 'r.takeaway', 'r.why_it_matters', 'ps.status',
      useNormalizedTags ? `(SELECT group_concat(t.label, ' ') FROM profile_entry_tags search_pet JOIN tags t ON t.id=search_pet.tag_id ${publicTagJoins('t')} WHERE search_pet.profile_entry_id=ps.profile_entry_id AND ${publicTagPredicate()})` : 'pe.tags'
    ]
  });
  return db.prepare(`
    WITH entities AS (${scopeEntityCte('profile', db)})
    SELECT ps.*, pe.title, pe.tags AS legacy_tags, pe.confidence, pe.source,
      ${useNormalizedTags ? `(SELECT group_concat(t.label, ', ') FROM profile_entry_tags pet JOIN tags t ON t.id=pet.tag_id ${publicTagJoins('t')} WHERE pet.profile_entry_id=ps.profile_entry_id AND ${publicTagPredicate()} ORDER BY lower(t.label))` : 'NULL'} AS normalized_tags,
      r.id AS revision_id, r.one_line_summary, r.takeaway, r.why_it_matters,
      (SELECT COUNT(*) FROM profile_story_captures WHERE story_id=ps.id) AS capture_count,
      (SELECT COUNT(*) FROM profile_story_variants WHERE story_id=ps.id AND is_current=1) AS variant_count,
      (SELECT COUNT(*) FROM profile_story_questions WHERE story_id=ps.id AND status='open') AS open_question_count
    FROM profile_stories ps
    JOIN entities e ON e.entity_key='story:' || ps.id
    JOIN profile_entries pe ON pe.id=ps.profile_entry_id
    LEFT JOIN profile_story_revisions r ON r.story_id=ps.id AND r.is_current=1
    ${sqlFilters.clause}
    ORDER BY CASE ps.status WHEN 'ready' THEN 0 WHEN 'developing' THEN 1 WHEN 'captured' THEN 2 ELSE 3 END,
      datetime(ps.updated_at) DESC, ps.id DESC
  `).all(sqlFilters.params).map((row) => ({
    ...row,
    tags: useNormalizedTags ? splitCommaList(row.normalized_tags) : parseTags(row.legacy_tags)
  }));
}

function readStory(id) {
  const db = getDb();
  if (!tableExists(db, 'profile_stories')) return null;
  const story = db.prepare(`
    SELECT ps.*, pe.title, pe.content AS compatibility_content, pe.source, pe.source_url, pe.evidence,
      pe.recency, pe.confidence, pe.tags
    FROM profile_stories ps JOIN profile_entries pe ON pe.id=ps.profile_entry_id WHERE ps.id=?
  `).get(id);
  if (!story) return null;
  return {
    story: { ...story, tags: parseTags(story.tags) },
    // Raw narrative is deliberately omitted from the web surface. The CLI can
    // reveal it only when the operator explicitly requests --include-raw.
    captures: db.prepare('SELECT id, capture_kind, raw_text, source_label, source_url, attachment_path, captured_by, captured_at, sha256, supersedes_capture_id, created_at FROM profile_story_captures WHERE story_id=? ORDER BY id').all(id),
    revisions: db.prepare('SELECT * FROM profile_story_revisions WHERE story_id=? ORDER BY revision_number DESC').all(id).map((row) => ({ ...row, beats: safeJson(row.beats_json, []) })),
    variants: db.prepare('SELECT * FROM profile_story_variants WHERE story_id=? ORDER BY variant_key, version DESC').all(id),
    permissions: db.prepare('SELECT * FROM profile_story_permissions WHERE story_id=? ORDER BY purpose').all(id),
    questions: db.prepare(`
      SELECT id, story_id, question_kind, question, priority, status,
        CASE WHEN status='answered' THEN 1 ELSE 0 END AS has_answer,
        asked_by, answered_at, created_at, updated_at
      FROM profile_story_questions WHERE story_id=? ORDER BY status, priority DESC, id
    `).all(id),
    applicationLinks: db.prepare('SELECT * FROM profile_story_application_links WHERE story_id=? ORDER BY id DESC').all(id),
    uses: db.prepare('SELECT * FROM profile_story_uses WHERE story_id=? ORDER BY id DESC').all(id)
  };
}

function firstTableRow(db, table, predicate) {
  const rows = tableRows(db, table);
  const row = rows.find(predicate) || null;
  return row ? serializeSensitiveProfileRow(row) : null;
}

function attachStructuredRows(db, byId, table, key, transform = (row) => row) {
  for (const row of tableRows(db, table)) {
    const entry = byId.get(row.profile_entry_id);
    if (!entry) continue;
    entry[key] = transform(row);
    entry.structured = entry[key];
  }
}

function serializeProfileEntry(entry) {
  const serialized = {
    id: entry.id,
    category: entry.category,
    title: entry.title,
    content: entry.content,
    source: entry.source,
    source_url: entry.source_url,
    evidence: entry.evidence,
    attachment_path: entry.attachment_path,
    recency: entry.recency,
    confidence: entry.confidence,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    display_status: entry.display_status || 'visible',
    display_order: entry.display_order ?? null,
    tags: parseTags(entry.tags)
  };

  if (entry.work_company) {
    serialized.work = {
      company: entry.work_company,
      role_title: entry.work_role_title,
      start_date: entry.work_start_date,
      end_date: entry.work_end_date,
      is_present: Boolean(entry.work_is_present),
      location: entry.work_location,
      highlights: entry.work_highlights,
      description: entry.work_description
    };
  }

  if (entry.education_institution) {
    serialized.education = {
      institution: entry.education_institution,
      degree: entry.education_degree,
      field_of_study: entry.education_field_of_study,
      start_date: entry.education_start_date,
      end_date: entry.education_end_date,
      graduation_year: entry.education_graduation_year,
      honors: entry.education_honors,
      notes: entry.education_notes
    };
  }

  return serialized;
}

function serializeSensitiveProfileRow(row) {
  return {
    ...row,
    tags: parseTags(row.tags)
  };
}

module.exports = {
  listProfileCorpus,
  listProfileEntries,
  listStories,
  readStory
};
