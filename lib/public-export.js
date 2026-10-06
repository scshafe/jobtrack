'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sortByDisplay } = require('./profile-presentation');

const PUBLIC_PROFILE_CONTRACT = 'public-profile';
const PUBLIC_PROFILE_CONTRACT_VERSION = 2;
const SCHEMA_PATH = path.join(__dirname, '..', 'contracts', 'export', 'public-profile.v2.schema.json');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Redaction is enforced, not conventional: exports fail closed when any
// forbidden key or value pattern survives projection. Keys are compared after
// lowercasing and stripping non-letters, and matched EXACTLY (so `contact`
// stays a legal section name while `references` can never appear).
const FORBIDDEN_KEYS = new Set([
  'email', 'phone', 'compensation', 'compensationexpectations', 'salary',
  'gender', 'pronouns', 'race', 'raceethnicity', 'ethnicity', 'veteran',
  'disability', 'eeo', 'reference', 'references', 'noticeperiod',
  'workauthorization', 'visasponsorship', 'visa', 'sponsorship',
  'earlieststartdate', 'relocationwillingness', 'remotepreference', 'answers'
]);
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_PATTERN = /(?:\d[\s().-]?){10,}/;

class PublicExportError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'PublicExportError';
    this.code = code;
    this.details = details;
  }
}

// v2 curation rules: hidden entries never export (their uuids also vanish
// from every `uses` array), arrays are emitted pinned-first then explicit
// display order then recency, every entity carries `pinned`, projects carry
// kind + PUBLIC repos only + `uses` refs, and the skills section is the union
// of catalog skills referenced by visible entities and non-hidden flat skill
// claims.
function buildPublicProfile(db) {
  const contactRow = db.prepare(
    'SELECT name, headline, professional_summary FROM profile_contact WHERE id=1'
  ).get() || null;

  const workEntries = visibleRows(db, `
    SELECT e.uuid, e.display_status, e.display_order, e.updated_at, e.created_at, e.id,
           w.id AS satellite_id, w.company, w.role_title, w.start_date, w.end_date,
           w.is_present, w.location, w.highlights, w.description
    FROM profile_work_entries w JOIN profile_entries e ON e.id=w.profile_entry_id
  `).map((row) => ({
    uuid: row.uuid,
    pinned: row.display_status === 'pinned',
    company: row.company,
    roleTitle: row.role_title,
    startDate: row.start_date,
    endDate: row.end_date ?? null,
    isPresent: Boolean(row.is_present),
    location: row.location ?? null,
    highlights: row.highlights ?? null,
    description: row.description ?? null,
    skills: linkedSkillUuids(db, 'profile_work_entry_skills', 'profile_work_entry_id', row.satellite_id)
  }));

  const education = visibleRows(db, `
    SELECT e.uuid, e.display_status, e.display_order, e.updated_at, e.created_at, e.id,
           ed.id AS satellite_id, ed.institution, ed.degree, ed.field_of_study,
           ed.start_date, ed.end_date, ed.graduation_year, ed.honors
    FROM profile_education_entries ed JOIN profile_entries e ON e.id=ed.profile_entry_id
  `).map((row) => ({
    uuid: row.uuid,
    pinned: row.display_status === 'pinned',
    institution: row.institution,
    degree: row.degree,
    fieldOfStudy: row.field_of_study,
    startDate: row.start_date,
    endDate: row.end_date ?? null,
    graduationYear: row.graduation_year ?? null,
    honors: row.honors ?? null,
    skills: linkedSkillUuids(db, 'profile_education_skills', 'profile_education_entry_id', row.satellite_id)
  }));

  // Legacy url/links fields must honor repo visibility too: any URL that
  // matches a private repo row is scrubbed, or the raw fields would leak the
  // very links the repos allowlist exists to gate.
  const privateRepoUrls = new Set(
    tableExists(db, 'repos')
      ? db.prepare("SELECT url FROM repos WHERE visibility='private'").all().map((row) => row.url)
      : []
  );
  const scrubUrl = (url) => (url && !privateRepoUrls.has(String(url).replace(/\/+$/, '')) ? url : null);

  const projectRows = visibleRows(db, `
    SELECT e.uuid, e.display_status, e.display_order, e.updated_at, e.created_at, e.id,
           p.id AS satellite_id, p.name, p.description, p.stack, p.role, p.url,
           p.links, p.start_date, p.end_date, p.highlights, p.project_kind
    FROM profile_projects p JOIN profile_entries e ON e.id=p.profile_entry_id
  `);
  const visibleProjectUuidBySatellite = new Map(projectRows.map((row) => [row.satellite_id, row.uuid]));
  const projects = projectRows.map((row) => ({
    uuid: row.uuid,
    pinned: row.display_status === 'pinned',
    name: row.name,
    kind: row.project_kind || 'application',
    description: row.description ?? null,
    stack: parseJsonList(row.stack),
    role: row.role ?? null,
    url: scrubUrl(row.url),
    links: parseJsonList(row.links).filter((link) => scrubUrl(link) !== null),
    startDate: row.start_date ?? null,
    endDate: row.end_date ?? null,
    highlights: row.highlights ?? null,
    skills: linkedSkillUuids(db, 'profile_project_skills', 'profile_project_id', row.satellite_id),
    repos: publicRepos(db, row.satellite_id),
    uses: usesRefs(db, row.satellite_id, visibleProjectUuidBySatellite)
  }));

  const links = visibleRows(db, `
    SELECT e.uuid, e.display_status, e.display_order, e.updated_at, e.created_at, e.id,
           l.kind, l.label, l.url, l.username
    FROM profile_links l JOIN profile_entries e ON e.id=l.profile_entry_id
  `).map((row) => ({
    uuid: row.uuid,
    pinned: row.display_status === 'pinned',
    kind: row.kind,
    label: row.label ?? null,
    url: row.url,
    username: row.username ?? null
  }));

  const publications = visibleRows(db, `
    SELECT e.uuid, e.display_status, e.display_order, e.updated_at, e.created_at, e.id,
           p.kind, p.title, p.publisher, p.published_at, p.url, p.description
    FROM profile_publications p JOIN profile_entries e ON e.id=p.profile_entry_id
  `).map((row) => ({
    uuid: row.uuid,
    pinned: row.display_status === 'pinned',
    kind: row.kind,
    title: row.title,
    publisher: row.publisher ?? null,
    publishedAt: row.published_at ?? null,
    url: row.url ?? null,
    description: row.description ?? null
  }));

  const recognitions = visibleRows(db, `
    SELECT e.uuid, e.display_status, e.display_order, e.updated_at, e.created_at, e.id,
           r.kind, r.title, r.issuer, r.awarded_at, r.description, r.url
    FROM profile_recognitions r JOIN profile_entries e ON e.id=r.profile_entry_id
  `).map((row) => ({
    uuid: row.uuid,
    pinned: row.display_status === 'pinned',
    kind: row.kind,
    title: row.title,
    issuer: row.issuer ?? null,
    awardedAt: row.awarded_at ?? null,
    description: row.description ?? null,
    url: row.url ?? null
  }));

  const languages = visibleRows(db, `
    SELECT e.uuid, e.display_status, e.display_order, e.updated_at, e.created_at, e.id,
           l.language, l.proficiency
    FROM profile_languages l JOIN profile_entries e ON e.id=l.profile_entry_id
  `).map((row) => ({
    uuid: row.uuid,
    pinned: row.display_status === 'pinned',
    language: row.language,
    proficiency: row.proficiency ?? null
  }));

  const volunteer = visibleRows(db, `
    SELECT e.uuid, e.display_status, e.display_order, e.updated_at, e.created_at, e.id,
           v.organization, v.role, v.cause, v.start_date, v.end_date,
           v.is_present, v.location, v.description, v.highlights
    FROM profile_volunteer_entries v JOIN profile_entries e ON e.id=v.profile_entry_id
  `).map((row) => ({
    uuid: row.uuid,
    pinned: row.display_status === 'pinned',
    organization: row.organization,
    role: row.role ?? null,
    cause: row.cause ?? null,
    startDate: row.start_date ?? null,
    endDate: row.end_date ?? null,
    isPresent: Boolean(row.is_present),
    location: row.location ?? null,
    description: row.description ?? null,
    highlights: row.highlights ?? null
  }));

  const referencedSkillUuids = new Set();
  for (const section of [workEntries, education, projects]) {
    for (const entity of section) {
      for (const uuid of entity.skills) referencedSkillUuids.add(uuid);
    }
  }
  const skills = buildSkillsSection(db, referencedSkillUuids);

  // Stories cross the boundary only through the full permission chain:
  // public_bio purpose, approved current variant, an unexpired allow
  // permission, normal sensitivity — and a non-hidden entry.
  const stories = storyTablesExist(db) ? db.prepare(`
    SELECT v.uuid, e.title, v.content
    FROM profile_story_variants v
    JOIN profile_stories s ON s.id=v.story_id
    JOIN profile_entries e ON e.id=s.profile_entry_id
    JOIN profile_story_permissions p ON p.story_id=s.id AND p.purpose='public_bio'
    WHERE v.purpose='public_bio' AND v.status='approved' AND v.is_current=1
      AND p.decision='allow' AND (p.expires_at IS NULL OR p.expires_at > datetime('now'))
      AND s.sensitivity='normal'
      AND e.display_status <> 'hidden'
    ORDER BY v.id
  `).all().map((row) => ({ uuid: row.uuid, title: row.title, content: row.content })) : [];

  return {
    contract: PUBLIC_PROFILE_CONTRACT,
    contractVersion: PUBLIC_PROFILE_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    contact: contactRow ? {
      name: contactRow.name ?? null,
      headline: contactRow.headline ?? null,
      professionalSummary: contactRow.professional_summary ?? null
    } : null,
    workEntries,
    education,
    projects,
    skills,
    links,
    publications,
    recognitions,
    languages,
    volunteer,
    stories
  };
}

function visibleRows(db, sql) {
  return sortByDisplay(db.prepare(sql).all().filter((row) => row.display_status !== 'hidden'));
}

function publicRepos(db, satelliteId) {
  return db.prepare(`
    SELECT r.name, r.url, j.role, j.is_primary
    FROM profile_project_repos j JOIN repos r ON r.id=j.repo_id
    WHERE j.profile_project_id=? AND r.visibility='public'
    ORDER BY j.is_primary DESC, j.position, r.id
  `).all(satelliteId).map((row) => ({
    name: row.name,
    url: row.url,
    role: row.is_primary ? 'primary' : (row.role === 'primary' ? 'component' : row.role)
  }));
}

function usesRefs(db, satelliteId, visibleProjectUuidBySatellite) {
  return db.prepare(`
    SELECT to_profile_project_id FROM profile_project_relations
    WHERE from_profile_project_id=? AND relation='uses'
    ORDER BY to_profile_project_id
  `).all(satelliteId)
    .map((row) => visibleProjectUuidBySatellite.get(row.to_profile_project_id))
    .filter(Boolean);
}

function buildSkillsSection(db, referencedSkillUuids) {
  const byUuid = new Map();
  const flatRows = db.prepare(`
    SELECT s.uuid, s.canonical_name, c.slug AS category, ps.proficiency, ps.years
    FROM profile_skills ps
    JOIN profile_entries pe ON pe.id=ps.profile_entry_id
    JOIN profile_skill_catalog_links l ON l.profile_skill_id=ps.id
    JOIN skills s ON s.id=l.skill_id
    JOIN skill_categories c ON c.id=s.skill_category_id
    WHERE pe.display_status <> 'hidden'
  `).all();
  for (const row of flatRows) {
    byUuid.set(row.uuid, {
      uuid: row.uuid,
      name: row.canonical_name,
      category: row.category,
      proficiency: row.proficiency ?? null,
      years: row.years ?? null
    });
  }
  for (const uuid of referencedSkillUuids) {
    if (byUuid.has(uuid)) continue;
    const row = db.prepare(`
      SELECT s.uuid, s.canonical_name, c.slug AS category
      FROM skills s JOIN skill_categories c ON c.id=s.skill_category_id
      WHERE s.uuid=?
    `).get(uuid);
    if (row) {
      byUuid.set(row.uuid, { uuid: row.uuid, name: row.canonical_name, category: row.category, proficiency: null, years: null });
    }
  }
  return [...byUuid.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function validatePublicProfile(artifact) {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const schemaErrors = [];
  validateNode(artifact, schema, schema, '$', schemaErrors);
  if (schemaErrors.length) {
    throw new PublicExportError('CONTRACT_VIOLATION', `Export violates ${path.basename(SCHEMA_PATH)}: ${schemaErrors.slice(0, 5).join('; ')}`, { errors: schemaErrors });
  }
  const redactionErrors = scanForbidden(artifact, '$');
  if (redactionErrors.length) {
    throw new PublicExportError('REDACTION_VIOLATION', `Export leaks private data: ${redactionErrors.slice(0, 5).join('; ')}`, { errors: redactionErrors });
  }
  return true;
}

function scanForbidden(value, at) {
  const errors = [];
  if (typeof value === 'string') {
    if (UUID_V4.test(value)) return errors; // our own identifiers: digit-heavy uuids are not phone numbers
    if (EMAIL_PATTERN.test(value)) errors.push(`${at}: value matches an email address pattern`);
    if (PHONE_PATTERN.test(value)) errors.push(`${at}: value matches a phone number pattern`);
    return errors;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => errors.push(...scanForbidden(item, `${at}[${index}]`)));
    return errors;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
      if (FORBIDDEN_KEYS.has(normalized)) errors.push(`${at}.${key}: forbidden key`);
      if (normalized === 'id' || normalized.endsWith('id')) {
        if (key !== 'uuid') errors.push(`${at}.${key}: integer row identifiers never leave the store`);
      }
      errors.push(...scanForbidden(child, `${at}.${key}`));
    }
  }
  return errors;
}

// Minimal JSON Schema subset validator: type (incl. unions), const, enum,
// pattern, properties/required/additionalProperties:false, items, $ref into
// local $defs. Enough to enforce this contract without a dependency.
function validateNode(value, schema, rootSchema, at, errors) {
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, rootSchema);
    if (!resolved) { errors.push(`${at}: unresolvable $ref ${schema.$ref}`); return; }
    validateNode(value, resolved, rootSchema, at, errors);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${at}: expected constant ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: not in enum`);
    return;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${describeType(value)}`);
      return;
    }
  }
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${at}: does not match pattern`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateNode(item, schema.items, rootSchema, `${at}[${index}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && (schema.properties || schema.required || schema.additionalProperties === false)) {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${at}: missing required '${key}'`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];
      if (childSchema) validateNode(child, childSchema, rootSchema, `${at}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: property not in allowlist`);
    }
  }
}

function resolveRef(ref, rootSchema) {
  if (!ref.startsWith('#/')) return null;
  return ref.slice(2).split('/').reduce((node, part) => node?.[part], rootSchema) || null;
}

function matchesType(value, type) {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number';
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function runExportCommand(db, args, flags) {
  const target = args[0];
  if (target !== 'public-profile') {
    throw new PublicExportError('UNKNOWN_COMMAND', 'Unknown export target. Use: jobtrack export public-profile [--out FILE]');
  }
  const artifact = buildPublicProfile(db);
  validatePublicProfile(artifact);
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const sha256 = crypto.createHash('sha256').update(serialized).digest('hex');
  const counts = {
    workEntries: artifact.workEntries.length,
    education: artifact.education.length,
    projects: artifact.projects.length,
    skills: artifact.skills.length,
    links: artifact.links.length,
    publications: artifact.publications.length,
    recognitions: artifact.recognitions.length,
    languages: artifact.languages.length,
    volunteer: artifact.volunteer.length,
    stories: artifact.stories.length
  };
  if (flags.out) {
    const outPath = path.resolve(String(flags.out));
    fs.writeFileSync(outPath, serialized, { mode: 0o600 });
    return { written: outPath, bytes: Buffer.byteLength(serialized), sha256, counts };
  }
  return { artifact, sha256, counts };
}

function linkedSkillUuids(db, table, column, satelliteId) {
  return db.prepare(`
    SELECT s.uuid FROM ${table} j JOIN skills s ON s.id=j.skill_id
    WHERE j.${column}=? ORDER BY j.position, s.id
  `).all(satelliteId).map((row) => row.uuid);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function storyTablesExist(db) {
  for (const table of ['profile_story_variants', 'profile_stories', 'profile_story_permissions']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return false;
  }
  return true;
}

function parseJsonList(value) {
  if (value === undefined || value === null || value === '') return [];
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed.map((item) => String(item));
  } catch { /* legacy comma fallback below */ }
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

module.exports = {
  PUBLIC_PROFILE_CONTRACT,
  PUBLIC_PROFILE_CONTRACT_VERSION,
  PublicExportError,
  UUID_V4,
  buildPublicProfile,
  runExportCommand,
  scanForbidden,
  validatePublicProfile
};
