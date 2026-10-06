'use strict';

const {
  CatalogError,
  applicationStatusEvidenceIncomplete,
  canonicalizeCatalogUrl,
  createOpening,
  ensureCompanyAlias,
  ensureOpeningIdentifier,
  getOpening,
  linkApplicationPosting,
  normalizeCatalogText,
  resolveOrCreateCompany,
  resolveOrCreatePosting,
  resolveOrCreateSkill,
  resolveOrCreateVenue,
  resolveOpeningIdentifier,
  resolvePlatform
} = require('./catalog');

const COMMAND_FLAGS = Object.freeze({
  'company.list': ['text', 'limit', 'offset'],
  'company.show': ['companyId', 'name'],
  'company.read': ['companyId', 'name'],
  'company.upsert': ['name', 'websiteDomain'],
  'company.alias': ['companyId', 'alias', 'aliasKind'],
  'opening.list': ['openingId', 'companyId', 'company', 'roleType', 'seniority', 'skill', 'status', 'text', 'limit', 'offset'],
  'opening.show': ['openingId'],
  'opening.read': ['openingId'],
  'opening.create': ['companyId', 'company', 'title', 'status', 'identifierNamespace', 'identifierValue'],
  'posting.list': ['postingId', 'openingId', 'companyId', 'company', 'platform', 'skill', 'requirementKind', 'state', 'text', 'limit', 'offset'],
  'posting.show': ['postingId'],
  'posting.read': ['postingId'],
  'posting.create': ['openingId', 'venueId', 'url', 'platform', 'venueKey', 'label', 'boardKey', 'baseUrl', 'externalId', 'state', 'postedAt', 'firstSeenAt', 'lastSeenAt'],
  'posting.link-application': ['applicationId', 'postingId', 'relation', 'primary'],
  'posting.add-skill-requirement': ['postingId', 'skillId', 'skill', 'requirementKind', 'snapshotId', 'rawPhrase', 'minimumYears', 'confidence', 'source'],
  'role-type.assign': ['openingId', 'roleType', 'primary', 'confidence', 'source', 'evidenceSnapshotId'],
  'seniority.assign': ['openingId', 'seniority', 'primary', 'confidence', 'source', 'evidenceSnapshotId'],
  'skill.upsert': ['name', 'category', 'aliases'],
  'skill.show': ['skillId', 'name'],
  'skill.read': ['skillId', 'name'],
  'skill.list': ['category', 'text', 'limit', 'offset'],
  'taxonomy.list': ['type']
});

const WRITE_COMMANDS = new Set([
  'company.upsert', 'company.alias', 'opening.create', 'posting.create',
  'posting.link-application', 'posting.add-skill-requirement',
  'role-type.assign', 'seniority.assign', 'skill.upsert'
]);

class CatalogCommandError extends CatalogError {
  constructor(code, message, details = null) {
    super(code, message, details);
    this.name = 'CatalogCommandError';
  }
}

function runCatalogCommand(db, args, flags = {}) {
  requireCatalog(db);
  const route = parseRoute(args);
  assertAllowedFlags(route, flags);
  const execute = () => {
    try { return dispatch(db, route, flags); }
    catch (error) { throw normalizeCommandError(error); }
  };
  if (!WRITE_COMMANDS.has(route) || db.inTransaction) return execute();
  return db.transaction(execute).immediate();
}

function normalizeCommandError(error) {
  if (error instanceof CatalogCommandError) return error;
  if (error instanceof CatalogError) return new CatalogCommandError(error.code, error.message, error.details);
  return error;
}

function parseRoute(args) {
  if (!Array.isArray(args)) throw new CatalogCommandError('INVALID_ARGUMENT', 'Catalog command arguments must be an array');
  const tokens = args[0] === 'catalog' ? args.slice(1) : [...args];
  const resourceAliases = {
    companies: 'company', openings: 'opening', postings: 'posting',
    'role-types': 'role-type', seniorities: 'seniority', skills: 'skill', taxonomies: 'taxonomy'
  };
  const resource = resourceAliases[tokens[0]] || tokens[0];
  const defaultAction = ['company', 'opening', 'posting', 'skill', 'taxonomy'].includes(resource) ? 'list' : null;
  const action = tokens[1] || defaultAction;
  const route = resource && action ? `${resource}.${action}` : '';
  if (!COMMAND_FLAGS[route]) {
    throw new CatalogCommandError('UNKNOWN_COMMAND', `Unknown catalog command: ${tokens.filter(Boolean).join(' ') || '(empty)'}`);
  }
  if (tokens.length > 2) throw new CatalogCommandError('INVALID_ARGUMENT', `Unexpected positional arguments: ${tokens.slice(2).join(' ')}`);
  return route;
}

function assertAllowedFlags(route, flags) {
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
    throw new CatalogCommandError('INVALID_ARGUMENT', 'Catalog flags must be an object');
  }
  const allowed = new Set(COMMAND_FLAGS[route]);
  const unknown = Object.keys(flags).filter((key) => flags[key] !== undefined && !allowed.has(key));
  if (unknown.length) {
    throw new CatalogCommandError('INVALID_ARGUMENT', `Unknown flag(s) for catalog ${route.replace('.', ' ')}: ${unknown.sort().map(toFlag).join(', ')}`);
  }
}

function dispatch(db, route, flags) {
  switch (route) {
    case 'company.list': return { companies: listCompanies(db, flags) };
    case 'company.show':
    case 'company.read': return { company: showCompany(db, flags) };
    case 'company.upsert': return { company: upsertCompany(db, flags) };
    case 'company.alias': return addCompanyAlias(db, flags);
    case 'opening.list': return { openings: listOpenings(db, flags) };
    case 'opening.show':
    case 'opening.read': return { opening: showOpening(db, requiredId(flags.openingId, '--opening-id')) };
    case 'opening.create': return { opening: createOpeningCommand(db, flags) };
    case 'posting.list': return { postings: listPostings(db, flags) };
    case 'posting.show':
    case 'posting.read': return { posting: showPosting(db, requiredId(flags.postingId, '--posting-id')) };
    case 'posting.create': return { posting: createPostingCommand(db, flags) };
    case 'posting.link-application': return linkPostingCommand(db, flags);
    case 'posting.add-skill-requirement': return { requirement: addPostingSkillRequirement(db, flags) };
    case 'role-type.assign': return { classification: assignRoleType(db, flags) };
    case 'seniority.assign': return { classification: assignSeniority(db, flags) };
    case 'skill.upsert': return { skill: upsertSkill(db, flags) };
    case 'skill.show':
    case 'skill.read': return { skill: showSkill(db, flags) };
    case 'skill.list': return { skills: listSkills(db, flags) };
    case 'taxonomy.list': return listTaxonomy(db, flags);
    default: throw new CatalogCommandError('UNKNOWN_COMMAND', `Unknown catalog route: ${route}`);
  }
}

function upsertCompany(db, flags) {
  const websiteDomain = websiteDomainValue(flags.websiteDomain);
  const company = resolveOrCreateCompany(db, requiredText(flags.name, '--name'), { websiteDomain });
  if (websiteDomain !== null) {
    db.prepare("UPDATE companies SET website_domain=?, updated_at=datetime('now') WHERE id=?").run(websiteDomain, company.id);
  }
  return getCompanyById(db, company.id);
}

function addCompanyAlias(db, flags) {
  const companyId = requiredId(flags.companyId, '--company-id');
  getCompanyById(db, companyId);
  const alias = ensureCompanyAlias(db, companyId, requiredText(flags.alias, '--alias'), flags.aliasKind || 'name');
  return { company: showCompany(db, { companyId }), alias };
}

function listCompanies(db, flags) {
  const params = { limit: limitValue(flags.limit), offset: offsetValue(flags.offset) };
  const where = [];
  if (flags.text !== undefined) {
    params.text = `%${requiredText(flags.text, '--text')}%`;
    where.push(`(c.canonical_name LIKE @text OR c.website_domain LIKE @text OR EXISTS (
      SELECT 1 FROM company_aliases ca WHERE ca.company_id=c.id AND ca.alias LIKE @text
    ))`);
  }
  return db.prepare(`
    SELECT c.*,
      (SELECT count(*) FROM job_openings jo WHERE jo.company_id=c.id) AS opening_count,
      (SELECT count(*) FROM company_aliases ca WHERE ca.company_id=c.id) AS alias_count
    FROM companies c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.normalized_name, c.id LIMIT @limit OFFSET @offset
  `).all(params);
}

function showCompany(db, flags) {
  assertExactlyOne(flags, ['companyId', 'name'], 'Provide exactly one of --company-id or --name');
  const company = flags.companyId !== undefined
    ? getCompanyById(db, requiredId(flags.companyId, '--company-id'))
    : resolveCompanyExact(db, requiredText(flags.name, '--name'));
  if (!company) throw new CatalogCommandError('NOT_FOUND', 'Company not found');
  return {
    ...company,
    aliases: db.prepare('SELECT * FROM company_aliases WHERE company_id=? ORDER BY normalized_alias').all(company.id),
    openings: db.prepare(`
      SELECT id, canonical_title, normalized_title, status, origin_kind, created_at, updated_at
      FROM job_openings WHERE company_id=? ORDER BY normalized_title, id
    `).all(company.id)
  };
}

function createOpeningCommand(db, flags) {
  assertExactlyOne(flags, ['companyId', 'company'], 'Provide exactly one of --company-id or --company');
  const company = flags.companyId !== undefined
    ? getCompanyById(db, requiredId(flags.companyId, '--company-id'))
    : resolveOrCreateCompany(db, requiredText(flags.company, '--company'));
  const hasNamespace = optionalText(flags.identifierNamespace) !== null;
  const hasValue = optionalText(flags.identifierValue) !== null;
  if (hasNamespace !== hasValue) {
    throw new CatalogCommandError('VALIDATION_ERROR', '--identifier-namespace and --identifier-value must be provided together');
  }
  return createOpening(db, {
    companyId: company.id,
    title: requiredText(flags.title, '--title'),
    status: flags.status || 'unknown',
    originKind: 'manual',
    identifierNamespace: optionalText(flags.identifierNamespace),
    identifierValue: optionalText(flags.identifierValue)
  });
}

function listOpenings(db, flags) {
  const params = { limit: limitValue(flags.limit), offset: offsetValue(flags.offset) };
  const where = [];
  if (flags.openingId !== undefined) {
    params.openingId = requiredId(flags.openingId, '--opening-id');
    where.push('jo.id=@openingId');
  }
  applyCompanyFilter(where, params, flags, 'jo.company_id');
  if (flags.roleType !== undefined) {
    params.roleType = normalizedSlug(flags.roleType, '--role-type');
    where.push(`EXISTS (
      SELECT 1 FROM opening_role_types ort JOIN role_types rt ON rt.id=ort.role_type_id
      WHERE ort.job_opening_id=jo.id AND rt.slug=@roleType
    )`);
  }
  if (flags.seniority !== undefined) {
    params.seniority = normalizedSlug(flags.seniority, '--seniority');
    where.push(`EXISTS (
      SELECT 1 FROM opening_seniority_levels osl JOIN seniority_levels sl ON sl.id=osl.seniority_level_id
      WHERE osl.job_opening_id=jo.id AND sl.slug=@seniority
    )`);
  }
  if (flags.skill !== undefined) {
    params.skill = normalizeCatalogText(requiredText(flags.skill, '--skill'));
    where.push(`EXISTS (
      SELECT 1 FROM job_postings jp
      JOIN posting_skill_requirements psr ON psr.job_posting_id=jp.id
      JOIN skills s ON s.id=psr.skill_id
      WHERE jp.job_opening_id=jo.id AND (
        s.normalized_name=@skill OR EXISTS (
          SELECT 1 FROM skill_aliases sa WHERE sa.skill_id=s.id AND sa.normalized_alias=@skill
        )
      )
    )`);
  }
  if (flags.status !== undefined) {
    params.status = enumValue(flags.status, ['unknown', 'open', 'closed'], '--status');
    where.push('jo.status=@status');
  }
  if (flags.text !== undefined) {
    params.text = `%${requiredText(flags.text, '--text')}%`;
    where.push('(jo.canonical_title LIKE @text OR c.canonical_name LIKE @text)');
  }
  return db.prepare(`
    SELECT jo.*, c.canonical_name AS company_name,
      (SELECT count(*) FROM job_postings jp WHERE jp.job_opening_id=jo.id) AS posting_count,
      (SELECT group_concat(rt.slug, ',') FROM opening_role_types ort JOIN role_types rt ON rt.id=ort.role_type_id WHERE ort.job_opening_id=jo.id ORDER BY ort.is_primary DESC, rt.slug) AS role_types,
      (SELECT group_concat(sl.slug, ',') FROM opening_seniority_levels osl JOIN seniority_levels sl ON sl.id=osl.seniority_level_id WHERE osl.job_opening_id=jo.id ORDER BY osl.is_primary DESC, sl.sort_rank) AS seniority_levels
    FROM job_openings jo JOIN companies c ON c.id=jo.company_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.normalized_name, jo.normalized_title, jo.id LIMIT @limit OFFSET @offset
  `).all(params).map(splitOpeningFacets);
}

function showOpening(db, openingId) {
  const opening = getOpening(db, openingId);
  return {
    ...opening,
    identifiers: db.prepare('SELECT * FROM opening_identifiers WHERE job_opening_id=? ORDER BY namespace, identifier_value').all(openingId),
    postings: listPostings(db, { openingId, limit: 200 }),
    roleTypes: db.prepare(`
      SELECT rt.*, ort.is_primary, ort.source, ort.confidence, ort.evidence_snapshot_id
      FROM opening_role_types ort JOIN role_types rt ON rt.id=ort.role_type_id
      WHERE ort.job_opening_id=? ORDER BY ort.is_primary DESC, rt.slug
    `).all(openingId),
    seniorityLevels: db.prepare(`
      SELECT sl.*, osl.is_primary, osl.source, osl.confidence, osl.evidence_snapshot_id
      FROM opening_seniority_levels osl JOIN seniority_levels sl ON sl.id=osl.seniority_level_id
      WHERE osl.job_opening_id=? ORDER BY osl.is_primary DESC, sl.sort_rank, sl.slug
    `).all(openingId),
    skillRequirements: db.prepare(`
      SELECT s.id AS skill_id, s.canonical_name AS skill_name, rk.slug AS requirement_kind,
        count(*) AS posting_count, max(rk.sort_rank) AS strongest_rank
      FROM job_postings jp JOIN posting_skill_requirements psr ON psr.job_posting_id=jp.id
      JOIN skills s ON s.id=psr.skill_id JOIN requirement_kinds rk ON rk.id=psr.requirement_kind_id
      WHERE jp.job_opening_id=? GROUP BY s.id, rk.id ORDER BY strongest_rank DESC, s.normalized_name
    `).all(openingId)
  };
}

function createPostingCommand(db, flags) {
  const opening = getOpening(db, requiredId(flags.openingId, '--opening-id'));
  let venue;
  if (flags.venueId !== undefined) {
    const venueOnly = ['platform', 'venueKey', 'label', 'boardKey', 'baseUrl'].filter((key) => flags[key] !== undefined);
    if (venueOnly.length) throw new CatalogCommandError('INVALID_ARGUMENT', `--venue-id cannot be combined with ${venueOnly.map(toFlag).join(', ')}`);
    venue = getVenue(db, requiredId(flags.venueId, '--venue-id'));
    if (venue.company_id && venue.company_id !== opening.company_id) {
      throw new CatalogCommandError('OPENING_MISMATCH', `Venue ${venue.id} belongs to another company`);
    }
  } else {
    const platform = getPlatformExact(db, requiredText(flags.platform, '--platform'));
    venue = resolveOrCreateVenue(db, {
      platformId: platform.id,
      companyId: opening.company_id,
      venueKey: requiredText(flags.venueKey, '--venue-key'),
      label: flags.label || `${opening.company_name} on ${platform.name}`,
      boardKey: optionalText(flags.boardKey),
      baseUrl: optionalText(flags.baseUrl)
    });
  }
  return resolveOrCreatePosting(db, {
    openingId: opening.id,
    venueId: venue.id,
    url: requiredText(flags.url, '--url'),
    externalId: optionalText(flags.externalId),
    state: flags.state || 'unknown',
    postedAt: optionalText(flags.postedAt),
    firstSeenAt: optionalText(flags.firstSeenAt),
    lastSeenAt: optionalText(flags.lastSeenAt)
  });
}

function listPostings(db, flags) {
  const params = { limit: limitValue(flags.limit), offset: offsetValue(flags.offset) };
  const where = [];
  if (flags.postingId !== undefined) {
    params.postingId = requiredId(flags.postingId, '--posting-id');
    where.push('jp.id=@postingId');
  }
  if (flags.openingId !== undefined) {
    params.openingId = requiredId(flags.openingId, '--opening-id');
    where.push('jp.job_opening_id=@openingId');
  }
  applyCompanyFilter(where, params, flags, 'jo.company_id');
  if (flags.platform !== undefined) {
    params.platform = normalizedSlug(flags.platform, '--platform');
    where.push('pp.slug=@platform');
  }
  if (flags.skill !== undefined) {
    params.skill = normalizeCatalogText(requiredText(flags.skill, '--skill'));
    where.push(`EXISTS (
      SELECT 1 FROM posting_skill_requirements psr JOIN skills s ON s.id=psr.skill_id
      WHERE psr.job_posting_id=jp.id AND (s.normalized_name=@skill OR EXISTS (
        SELECT 1 FROM skill_aliases sa WHERE sa.skill_id=s.id AND sa.normalized_alias=@skill
      ))
    )`);
  }
  if (flags.requirementKind !== undefined) {
    params.requirementKind = normalizedSlug(flags.requirementKind, '--requirement-kind');
    where.push(`EXISTS (
      SELECT 1 FROM posting_skill_requirements psr JOIN requirement_kinds rk ON rk.id=psr.requirement_kind_id
      WHERE psr.job_posting_id=jp.id AND rk.slug=@requirementKind
    )`);
  }
  if (flags.state !== undefined) {
    params.state = enumValue(flags.state, ['unknown', 'open', 'closed', 'removed'], '--state');
    where.push('jp.state=@state');
  }
  if (flags.text !== undefined) {
    params.text = `%${requiredText(flags.text, '--text')}%`;
    where.push('(jp.canonical_url LIKE @text OR jo.canonical_title LIKE @text OR c.canonical_name LIKE @text)');
  }
  return db.prepare(`
    SELECT jp.*, pv.venue_key, pv.label AS venue_label, pp.slug AS platform,
      jo.canonical_title AS opening_title, c.id AS company_id, c.canonical_name AS company_name,
      (SELECT count(*) FROM posting_skill_requirements psr WHERE psr.job_posting_id=jp.id) AS skill_requirement_count
    FROM job_postings jp JOIN job_openings jo ON jo.id=jp.job_opening_id
    JOIN companies c ON c.id=jo.company_id JOIN posting_venues pv ON pv.id=jp.posting_venue_id
    JOIN posting_platforms pp ON pp.id=pv.posting_platform_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.normalized_name, jo.normalized_title, pp.slug, jp.id LIMIT @limit OFFSET @offset
  `).all(params);
}

function showPosting(db, postingId) {
  const rows = listPostings(db, { postingId, limit: 1 });
  if (!rows.length) throw new CatalogCommandError('NOT_FOUND', `Posting not found: ${postingId}`);
  return {
    ...rows[0],
    skillRequirements: db.prepare(`
      SELECT psr.*, s.canonical_name AS skill_name, s.slug AS skill_slug,
        rk.slug AS requirement_kind, rk.label AS requirement_label
      FROM posting_skill_requirements psr JOIN skills s ON s.id=psr.skill_id
      JOIN requirement_kinds rk ON rk.id=psr.requirement_kind_id
      WHERE psr.job_posting_id=? ORDER BY rk.sort_rank DESC, s.normalized_name, psr.id
    `).all(postingId),
    applications: db.prepare(`
      SELECT ap.*, a.company, a.role, a.status FROM application_postings ap
      JOIN applications a ON a.id=ap.application_id WHERE ap.job_posting_id=?
      ORDER BY ap.is_primary DESC, a.id
    `).all(postingId)
  };
}

function linkPostingCommand(db, flags) {
  const link = linkApplicationPosting(db, {
    applicationId: requiredId(flags.applicationId, '--application-id'),
    postingId: requiredId(flags.postingId, '--posting-id'),
    relation: flags.relation || 'alternate',
    primary: flags.primary === undefined ? undefined : booleanValue(flags.primary, false, '--primary')
  });
  return { link, posting: showPosting(db, link.job_posting_id) };
}

function assignRoleType(db, flags) {
  const openingId = requiredId(flags.openingId, '--opening-id');
  getOpening(db, openingId);
  const slug = normalizedSlug(flags.roleType, '--role-type');
  const roleType = db.prepare('SELECT * FROM role_types WHERE slug=?').get(slug);
  if (!roleType) throw new CatalogCommandError('NOT_FOUND', `Role type not found: ${slug}`);
  return assignOpeningFacet(db, {
    table: 'opening_role_types', idColumn: 'role_type_id', facetId: roleType.id,
    openingId, primary: booleanValue(flags.primary, false, '--primary'),
    confidence: confidenceValue(flags.confidence), source: flags.source || 'manual',
    evidenceSnapshotId: optionalId(flags.evidenceSnapshotId, '--evidence-snapshot-id')
  });
}

function assignSeniority(db, flags) {
  const openingId = requiredId(flags.openingId, '--opening-id');
  getOpening(db, openingId);
  const slug = normalizedSlug(flags.seniority, '--seniority');
  const seniority = db.prepare('SELECT * FROM seniority_levels WHERE slug=?').get(slug);
  if (!seniority) throw new CatalogCommandError('NOT_FOUND', `Seniority not found: ${slug}`);
  return assignOpeningFacet(db, {
    table: 'opening_seniority_levels', idColumn: 'seniority_level_id', facetId: seniority.id,
    openingId, primary: booleanValue(flags.primary, false, '--primary'),
    confidence: confidenceValue(flags.confidence), source: flags.source || 'manual',
    evidenceSnapshotId: optionalId(flags.evidenceSnapshotId, '--evidence-snapshot-id')
  });
}

function assignOpeningFacet(db, input) {
  if (input.evidenceSnapshotId) assertSnapshotOpening(db, input.evidenceSnapshotId, input.openingId);
  if (input.primary) db.prepare(`UPDATE ${input.table} SET is_primary=0 WHERE job_opening_id=? AND ${input.idColumn}<>?`).run(input.openingId, input.facetId);
  db.prepare(`
    INSERT INTO ${input.table} (
      job_opening_id, ${input.idColumn}, is_primary, source, confidence, evidence_snapshot_id
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_opening_id, ${input.idColumn}) DO UPDATE SET
      is_primary=excluded.is_primary, source=excluded.source,
      confidence=excluded.confidence, evidence_snapshot_id=excluded.evidence_snapshot_id
  `).run(
    input.openingId, input.facetId, input.primary ? 1 : 0,
    requiredText(input.source, '--source'), input.confidence, input.evidenceSnapshotId
  );
  return db.prepare(`SELECT * FROM ${input.table} WHERE job_opening_id=? AND ${input.idColumn}=?`).get(input.openingId, input.facetId);
}

function upsertSkill(db, flags) {
  const categorySlug = normalizedSlug(flags.category || 'other', '--category');
  const category = db.prepare('SELECT * FROM skill_categories WHERE slug=?').get(categorySlug);
  if (!category) throw new CatalogCommandError('NOT_FOUND', `Skill category not found: ${categorySlug}`);
  const skill = resolveOrCreateSkill(db, requiredText(flags.name, '--name'), category.id);
  db.prepare('UPDATE skills SET skill_category_id=?, updated_at=datetime(\'now\') WHERE id=?').run(category.id, skill.id);
  for (const alias of listValue(flags.aliases, '--aliases')) ensureSkillAlias(db, skill.id, alias);
  return showSkill(db, { skillId: skill.id });
}

function ensureSkillAlias(db, skillId, alias) {
  const raw = requiredText(alias, 'skill alias');
  const normalized = normalizeCatalogText(raw);
  const existingSkill = resolveSkillExact(db, raw);
  if (existingSkill && existingSkill.id !== skillId) {
    throw new CatalogCommandError('IDENTITY_CONFLICT', `Skill alias ${raw} belongs to skill ${existingSkill.id}`);
  }
  db.prepare(`
    INSERT INTO skill_aliases (skill_id, alias, normalized_alias)
    VALUES (?, ?, ?) ON CONFLICT(normalized_alias) DO NOTHING
  `).run(skillId, raw, normalized);
}

function listSkills(db, flags) {
  const params = { limit: limitValue(flags.limit), offset: offsetValue(flags.offset) };
  const where = [];
  if (flags.category !== undefined) {
    params.category = normalizedSlug(flags.category, '--category');
    where.push('sc.slug=@category');
  }
  if (flags.text !== undefined) {
    params.text = `%${requiredText(flags.text, '--text')}%`;
    where.push(`(s.canonical_name LIKE @text OR EXISTS (
      SELECT 1 FROM skill_aliases sa WHERE sa.skill_id=s.id AND sa.alias LIKE @text
    ))`);
  }
  return db.prepare(`
    SELECT s.*, sc.slug AS category, sc.label AS category_label,
      (SELECT group_concat(alias, ',') FROM skill_aliases sa WHERE sa.skill_id=s.id ORDER BY normalized_alias) AS aliases
    FROM skills s JOIN skill_categories sc ON sc.id=s.skill_category_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY s.normalized_name, s.id LIMIT @limit OFFSET @offset
  `).all(params).map((row) => ({ ...row, aliases: splitList(row.aliases) }));
}

function showSkill(db, flags) {
  assertExactlyOne(flags, ['skillId', 'name'], 'Provide exactly one of --skill-id or --name');
  const skill = flags.skillId !== undefined
    ? db.prepare('SELECT * FROM skills WHERE id=?').get(requiredId(flags.skillId, '--skill-id'))
    : resolveSkillExact(db, requiredText(flags.name, '--name'));
  if (!skill) throw new CatalogCommandError('NOT_FOUND', 'Skill not found');
  const category = db.prepare('SELECT slug, label FROM skill_categories WHERE id=?').get(skill.skill_category_id);
  return {
    ...skill,
    category: category.slug,
    categoryLabel: category.label,
    aliases: db.prepare('SELECT alias, normalized_alias FROM skill_aliases WHERE skill_id=? ORDER BY normalized_alias').all(skill.id),
    requirementCount: db.prepare('SELECT count(*) count FROM posting_skill_requirements WHERE skill_id=?').get(skill.id).count
  };
}

function addPostingSkillRequirement(db, flags) {
  const postingId = requiredId(flags.postingId, '--posting-id');
  const posting = db.prepare('SELECT * FROM job_postings WHERE id=?').get(postingId);
  if (!posting) throw new CatalogCommandError('NOT_FOUND', `Posting not found: ${postingId}`);
  assertExactlyOne(flags, ['skillId', 'skill'], 'Provide exactly one of --skill-id or --skill');
  const skill = flags.skillId !== undefined
    ? db.prepare('SELECT * FROM skills WHERE id=?').get(requiredId(flags.skillId, '--skill-id'))
    : resolveSkillExact(db, requiredText(flags.skill, '--skill'));
  if (!skill) throw new CatalogCommandError('NOT_FOUND', 'Skill not found; upsert it before assigning a requirement');
  const kindSlug = normalizedSlug(flags.requirementKind, '--requirement-kind');
  const kind = db.prepare('SELECT * FROM requirement_kinds WHERE slug=?').get(kindSlug);
  if (!kind) throw new CatalogCommandError('NOT_FOUND', `Requirement kind not found: ${kindSlug}`);
  const snapshotId = optionalId(flags.snapshotId, '--snapshot-id');
  if (snapshotId) assertSnapshotPosting(db, snapshotId, postingId);
  const existing = snapshotId
    ? db.prepare('SELECT * FROM posting_skill_requirements WHERE job_posting_id=? AND opportunity_snapshot_id=? AND skill_id=?').get(postingId, snapshotId, skill.id)
    : db.prepare('SELECT * FROM posting_skill_requirements WHERE job_posting_id=? AND opportunity_snapshot_id IS NULL AND skill_id=?').get(postingId, skill.id);
  const values = {
    postingId, snapshotId, skillId: skill.id, kindId: kind.id,
    rawPhrase: optionalText(flags.rawPhrase), minimumYears: nonnegativeNumber(flags.minimumYears, '--minimum-years'),
    confidence: confidenceValue(flags.confidence), source: flags.source || 'manual'
  };
  let id;
  if (existing) {
    db.prepare(`
      UPDATE posting_skill_requirements SET requirement_kind_id=@kindId, raw_phrase=@rawPhrase,
        minimum_years=@minimumYears, confidence=@confidence, source=@source WHERE id=@id
    `).run({ ...values, id: existing.id });
    id = existing.id;
  } else {
    id = db.prepare(`
      INSERT INTO posting_skill_requirements (
        job_posting_id, opportunity_snapshot_id, skill_id, requirement_kind_id,
        raw_phrase, minimum_years, confidence, source
      ) VALUES (@postingId,@snapshotId,@skillId,@kindId,@rawPhrase,@minimumYears,@confidence,@source)
    `).run(values).lastInsertRowid;
  }
  return db.prepare(`
    SELECT psr.*, s.canonical_name AS skill_name, rk.slug AS requirement_kind
    FROM posting_skill_requirements psr JOIN skills s ON s.id=psr.skill_id
    JOIN requirement_kinds rk ON rk.id=psr.requirement_kind_id WHERE psr.id=?
  `).get(id);
}

function listTaxonomy(db, flags) {
  const type = normalizedSlug(flags.type, '--type');
  const definitions = {
    'role-types': ['roleTypes', 'SELECT rt.*, p.slug AS parent_slug FROM role_types rt LEFT JOIN role_types p ON p.id=rt.parent_role_type_id ORDER BY COALESCE(p.slug,rt.slug), rt.slug'],
    seniority: ['seniorityLevels', 'SELECT * FROM seniority_levels ORDER BY sort_rank, career_track, slug'],
    skills: ['skills', 'SELECT s.*, sc.slug AS category FROM skills s JOIN skill_categories sc ON sc.id=s.skill_category_id ORDER BY s.normalized_name'],
    'skill-categories': ['skillCategories', 'SELECT * FROM skill_categories ORDER BY slug'],
    'requirement-kinds': ['requirementKinds', 'SELECT * FROM requirement_kinds ORDER BY sort_rank DESC, slug'],
    platforms: ['platforms', 'SELECT * FROM posting_platforms ORDER BY slug']
  };
  const definition = definitions[type];
  if (!definition) throw new CatalogCommandError('VALIDATION_ERROR', `--type must be one of: ${Object.keys(definitions).join(', ')}`);
  return { [definition[0]]: db.prepare(definition[1]).all() };
}

function syncLegacyApplicationCatalog(db, applicationId, options = {}) {
  requireCatalog(db);
  const execute = () => {
    const id = requiredId(applicationId, 'application id');
    const application = db.prepare('SELECT * FROM applications WHERE id=?').get(id);
    if (!application) throw new CatalogCommandError('NOT_FOUND', `Application not found: ${id}`);
    let openingId = optionalId(options.openingId, 'opening id') || application.job_opening_id || null;
    let posting = options.postingId
      ? getPosting(db, requiredId(options.postingId, 'posting id'))
      : application.primary_job_posting_id ? getPosting(db, application.primary_job_posting_id) : null;
    const exactUrlPosting = application.job_url ? findPostingByUrl(db, application.job_url) : null;
    if (posting && exactUrlPosting && posting.id !== exactUrlPosting.id) {
      throw new CatalogCommandError('IDENTITY_CONFLICT', 'Application posting id and exact job URL disagree');
    }
    posting = posting || exactUrlPosting;
    if (posting) openingId = reconcileOpeningId(openingId, posting.job_opening_id, 'application posting');
    if (application.source_opportunity_id) {
      const source = db.prepare('SELECT job_opening_id, primary_job_posting_id FROM opportunities WHERE id=?').get(application.source_opportunity_id);
      if (source && source.job_opening_id) openingId = reconcileOpeningId(openingId, source.job_opening_id, 'source opportunity');
      if (!posting && source && source.primary_job_posting_id) posting = getPosting(db, source.primary_job_posting_id);
    }
    if (!openingId) {
      const identity = resolveOpeningIdentifier(db, 'legacy-application', String(id));
      if (identity) openingId = identity.id;
    }
    if (!openingId) {
      const company = resolveOrCreateCompany(db, requiredText(application.company, 'application company'));
      openingId = createOpening(db, {
        companyId: company.id, title: requiredText(application.role, 'application role'),
        originKind: 'application', identifierNamespace: 'legacy-application', identifierValue: String(id)
      }).id;
    } else {
      getOpening(db, openingId);
      ensureOpeningIdentifier(db, openingId, 'legacy-application', String(id));
    }
    if (posting && posting.job_opening_id !== openingId) {
      throw new CatalogCommandError('OPENING_MISMATCH', 'Application posting belongs to another opening');
    }
    if (!posting && application.job_url) {
      posting = createDirectPostingForOpening(db, openingId, application.job_url, {
        firstSeenAt: application.created_at, lastSeenAt: application.updated_at
      });
    }
    db.prepare('UPDATE applications SET job_opening_id=?, primary_job_posting_id=? WHERE id=?')
      .run(openingId, posting ? posting.id : null, id);
    if (posting) {
      linkApplicationPosting(db, {
        applicationId: id, postingId: posting.id,
        relation: options.relation || (application.workflow_stage === 'prospective' ? 'discovered_via' : 'submitted_via'),
        primary: true
      });
    }
    const occurredAt = application.status_changed_at || application.updated_at || application.created_at || new Date(0).toISOString();
    const eventKey = `catalog-sync:application:${id}:${application.status}:${occurredAt}`;
    const evidenceIncomplete = applicationStatusEvidenceIncomplete(db, id, application.status);
    db.prepare(`
      INSERT INTO application_status_events (
        application_id, from_status, to_status, event_kind, source, source_ref,
        evidence_incomplete, occurred_at, idempotency_key
      ) VALUES (?,NULL,?,'legacy_writer_synced','catalog_dual_write',?,?,?,?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(id, application.status, `applications:${id}`, evidenceIncomplete, occurredAt, eventKey);
    return {
      application: db.prepare('SELECT * FROM applications WHERE id=?').get(id),
      opening: showOpening(db, openingId),
      posting: posting ? showPosting(db, posting.id) : null
    };
  };
  return db.inTransaction ? execute() : db.transaction(execute).immediate();
}

function syncLegacyOpportunityCatalog(db, opportunityId, options = {}) {
  requireCatalog(db);
  const execute = () => {
    const id = requiredId(opportunityId, 'opportunity id');
    const opportunity = db.prepare(`
      SELECT o.*, ds.source_key, ds.adapter AS source_adapter, ds.label AS source_label,
        ds.base_url AS source_base_url
      FROM opportunities o LEFT JOIN discovery_sources ds ON ds.id=o.primary_source_id WHERE o.id=?
    `).get(id);
    if (!opportunity) throw new CatalogCommandError('NOT_FOUND', `Opportunity not found: ${id}`);
    const existingEvidence = ['opportunity_snapshots', 'opportunity_observations'].some((table) =>
      tableExists(db, table) && db.prepare(`SELECT 1 FROM ${table} WHERE opportunity_id=? AND job_posting_id IS NULL LIMIT 1`).get(id)
    );
    if (existingEvidence) {
      throw new CatalogCommandError(
        'WRITE_ORDER_CONFLICT',
        'Sync the opportunity catalog before inserting immutable snapshots/observations; use migrateCatalog for legacy evidence'
      );
    }
    let openingId = optionalId(options.openingId, 'opening id') || opportunity.job_opening_id || null;
    const identity = resolveOpeningIdentifier(db, 'legacy-opportunity', String(id));
    if (identity) openingId = reconcileOpeningId(openingId, identity.id, 'legacy opportunity identity');
    if (!openingId) {
      const company = resolveOrCreateCompany(db, requiredText(opportunity.company_name, 'opportunity company'));
      openingId = createOpening(db, {
        companyId: company.id, title: requiredText(opportunity.title, 'opportunity title'),
        status: opportunity.state === 'closed' ? 'closed' : 'open', originKind: 'opportunity',
        identifierNamespace: 'legacy-opportunity', identifierValue: String(id)
      }).id;
    } else {
      getOpening(db, openingId);
      ensureOpeningIdentifier(db, openingId, 'legacy-opportunity', String(id));
    }
    const opening = getOpening(db, openingId);
    const platformSlug = options.platform || inferPlatform(opportunity.provider || opportunity.source_adapter, opportunity.canonical_url);
    const platform = resolvePlatform(db, platformSlug);
    const venue = resolveOrCreateVenue(db, {
      platformId: platform.id, companyId: opening.company_id,
      venueKey: options.venueKey || opportunity.board_key || opportunity.source_key || hostname(opportunity.canonical_url),
      label: options.label || opportunity.source_label || `${opening.company_name} on ${platform.name}`,
      boardKey: opportunity.board_key, baseUrl: opportunity.source_base_url
    });
    const posting = resolveOrCreatePosting(db, {
      openingId, venueId: venue.id, url: opportunity.canonical_url,
      externalId: opportunity.external_id,
      state: opportunity.state === 'closed' ? 'closed' : 'open', postedAt: opportunity.posted_at,
      firstSeenAt: opportunity.first_seen_at, lastSeenAt: opportunity.last_seen_at
    });
    db.prepare('UPDATE opportunities SET job_opening_id=?, primary_job_posting_id=? WHERE id=?').run(openingId, posting.id, id);
    return {
      opportunity: db.prepare('SELECT * FROM opportunities WHERE id=?').get(id),
      opening: showOpening(db, openingId), posting: showPosting(db, posting.id),
      evidenceLink: { jobPostingId: posting.id, snapshotColumn: 'job_posting_id', observationColumn: 'job_posting_id' }
    };
  };
  return db.inTransaction ? execute() : db.transaction(execute).immediate();
}

function createDirectPostingForOpening(db, openingId, url, times = {}) {
  const opening = getOpening(db, openingId);
  const platform = resolvePlatform(db, inferPlatform(null, url));
  const venue = resolveOrCreateVenue(db, {
    platformId: platform.id, companyId: opening.company_id,
    venueKey: hostname(url), label: `${opening.company_name} on ${platform.name}`
  });
  return resolveOrCreatePosting(db, {
    openingId, venueId: venue.id, url, state: 'unknown',
    firstSeenAt: times.firstSeenAt, lastSeenAt: times.lastSeenAt
  });
}

function applyCompanyFilter(where, params, flags, column) {
  if (flags.companyId !== undefined && flags.company !== undefined) {
    throw new CatalogCommandError('INVALID_ARGUMENT', 'Use only one of --company-id or --company');
  }
  if (flags.companyId !== undefined) {
    params.companyId = requiredId(flags.companyId, '--company-id');
    where.push(`${column}=@companyId`);
  }
  if (flags.company !== undefined) {
    params.company = normalizeCatalogText(requiredText(flags.company, '--company'));
    where.push(`(${column} IN (SELECT id FROM companies WHERE normalized_name=@company) OR ${column} IN (
      SELECT company_id FROM company_aliases WHERE normalized_alias=@company
    ))`);
  }
}

function assertSnapshotOpening(db, snapshotId, openingId) {
  const match = db.prepare(`
    SELECT 1 FROM opportunity_snapshots os JOIN job_postings jp ON jp.id=os.job_posting_id
    WHERE os.id=? AND jp.job_opening_id=?
  `).get(snapshotId, openingId);
  if (!match) throw new CatalogCommandError('EVIDENCE_MISMATCH', `Snapshot ${snapshotId} does not belong to opening ${openingId}`);
}

function assertSnapshotPosting(db, snapshotId, postingId) {
  const match = db.prepare('SELECT 1 FROM opportunity_snapshots WHERE id=? AND job_posting_id=?').get(snapshotId, postingId);
  if (!match) throw new CatalogCommandError('EVIDENCE_MISMATCH', `Snapshot ${snapshotId} does not belong to posting ${postingId}`);
}

function getCompanyById(db, id) {
  const company = db.prepare('SELECT * FROM companies WHERE id=?').get(id);
  if (!company) throw new CatalogCommandError('NOT_FOUND', `Company not found: ${id}`);
  return company;
}

function resolveCompanyExact(db, name) {
  const normalized = normalizeCatalogText(name);
  return db.prepare('SELECT * FROM companies WHERE normalized_name=?').get(normalized)
    || db.prepare(`
      SELECT c.* FROM company_aliases ca JOIN companies c ON c.id=ca.company_id
      WHERE ca.normalized_alias=?
    `).get(normalized)
    || null;
}

function resolveSkillExact(db, name) {
  const normalized = normalizeCatalogText(name);
  return db.prepare('SELECT * FROM skills WHERE normalized_name=?').get(normalized)
    || db.prepare(`
      SELECT s.* FROM skill_aliases sa JOIN skills s ON s.id=sa.skill_id
      WHERE sa.normalized_alias=?
    `).get(normalized)
    || null;
}

function getVenue(db, id) {
  const venue = db.prepare('SELECT * FROM posting_venues WHERE id=?').get(id);
  if (!venue) throw new CatalogCommandError('NOT_FOUND', `Posting venue not found: ${id}`);
  return venue;
}

function getPlatformExact(db, slug) {
  const normalized = normalizedSlug(slug, '--platform');
  const platform = db.prepare('SELECT * FROM posting_platforms WHERE slug=?').get(normalized);
  if (!platform) throw new CatalogCommandError('NOT_FOUND', `Posting platform not found: ${normalized}`);
  return platform;
}

function getPosting(db, id) {
  const posting = db.prepare('SELECT * FROM job_postings WHERE id=?').get(id);
  if (!posting) throw new CatalogCommandError('NOT_FOUND', `Posting not found: ${id}`);
  return posting;
}

function findPostingByUrl(db, url) {
  const canonical = canonicalizeCatalogUrl(url);
  return db.prepare('SELECT * FROM job_postings WHERE canonical_url=?').get(canonical) || null;
}

function reconcileOpeningId(current, candidate, source) {
  if (current && candidate && current !== candidate) {
    throw new CatalogCommandError('OPENING_MISMATCH', `${source} belongs to opening ${candidate}, not ${current}`);
  }
  return current || candidate || null;
}

function splitOpeningFacets(row) {
  return { ...row, role_types: splitList(row.role_types), seniority_levels: splitList(row.seniority_levels) };
}

function splitList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function listValue(value, label) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const normalized = [...new Set(list.map((item) => requiredText(item, label)))];
  return normalized;
}

function inferPlatform(provider, url) {
  const text = String(provider || '').toLowerCase();
  for (const slug of ['linkedin', 'greenhouse', 'ashby', 'lever', 'wellfound', 'indeed', 'remoteok', 'hn', 'rss', 'api']) {
    if (text === slug || String(url || '').toLowerCase().includes(slug)) return slug;
  }
  return ['manual', 'web', 'direct'].includes(text) ? 'direct' : 'other';
}

function hostname(url) {
  try { return new URL(requiredText(url, 'URL')).hostname.toLowerCase(); }
  catch { throw new CatalogCommandError('INVALID_URL', `Invalid URL: ${url}`); }
}

function requireCatalog(db) {
  if (!tableExists(db, 'companies') || !tableExists(db, 'job_openings') || !tableExists(db, 'job_postings')) {
    throw new CatalogCommandError('SCHEMA_MISSING', 'Run migrateCatalog(db) before catalog commands');
  }
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function assertExactlyOne(flags, keys, message) {
  if (keys.filter((key) => flags[key] !== undefined && flags[key] !== null && flags[key] !== '').length !== 1) {
    throw new CatalogCommandError('INVALID_ARGUMENT', message);
  }
}

function requiredText(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new CatalogCommandError('VALIDATION_ERROR', `Missing ${label}`);
  }
  return String(value).trim();
}

function optionalText(value) {
  return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim();
}

function websiteDomainValue(value) {
  const domain = optionalText(value);
  if (domain === null) return null;
  const normalized = domain.toLowerCase().replace(/\.$/, '');
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)) {
    throw new CatalogCommandError('VALIDATION_ERROR', '--website-domain must be a bare DNS name');
  }
  return normalized;
}

function requiredId(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new CatalogCommandError('VALIDATION_ERROR', `${label} must be a positive integer`);
  return number;
}

function optionalId(value, label) {
  return value === undefined || value === null || value === '' ? null : requiredId(value, label);
}

function limitValue(value) {
  if (value === undefined) return 100;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new CatalogCommandError('VALIDATION_ERROR', '--limit must be an integer from 1 to 200');
  return limit;
}

function offsetValue(value) {
  if (value === undefined) return 0;
  const offset = Number(value);
  if (!Number.isInteger(offset) || offset < 0) throw new CatalogCommandError('VALIDATION_ERROR', '--offset must be a nonnegative integer');
  return offset;
}

function normalizedSlug(value, label) {
  return requiredText(value, label).normalize('NFKC').toLowerCase().replace(/[_\s]+/g, '-');
}

function booleanValue(value, fallback, label) {
  if (value === undefined) return fallback;
  if (value === true || value === 1 || value === '1' || value === 'true' || value === 'yes') return true;
  if (value === false || value === 0 || value === '0' || value === 'false' || value === 'no') return false;
  throw new CatalogCommandError('VALIDATION_ERROR', `${label} must be true or false`);
}

function confidenceValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new CatalogCommandError('VALIDATION_ERROR', '--confidence must be between 0 and 1');
  return number;
}

function nonnegativeNumber(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new CatalogCommandError('VALIDATION_ERROR', `${label} must be nonnegative`);
  return number;
}

function enumValue(value, allowed, label) {
  const text = requiredText(value, label);
  if (!allowed.includes(text)) throw new CatalogCommandError('VALIDATION_ERROR', `${label} must be one of: ${allowed.join(', ')}`);
  return text;
}

function toFlag(key) {
  return `--${key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`;
}

module.exports = {
  COMMAND_FLAGS,
  CatalogCommandError,
  addPostingSkillRequirement,
  assignRoleType,
  assignSeniority,
  createPostingCommand,
  listCompanies,
  listOpenings,
  listPostings,
  listSkills,
  runCatalogCommand,
  showCompany,
  showOpening,
  showPosting,
  showSkill,
  syncLegacyApplicationCatalog,
  syncLegacyOpportunityCatalog,
  upsertSkill
};
