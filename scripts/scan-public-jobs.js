#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const ADAPTERS = new Set(['ashby', 'greenhouse']);
const BOARD_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
const cli = path.resolve(__dirname, '..', 'bin', 'jobtrack.js');
const FLAG_KEYS = new Map([
  ['help', 'help'],
  ['adapter', 'adapter'],
  ['board', 'board'],
  ['source-key', 'sourceKey'],
  ['sourceKey', 'sourceKey'],
  ['source', 'sourceKey'],
  ['query-key', 'queryKey'],
  ['queryKey', 'queryKey'],
  ['query', 'queryKey'],
  ['company', 'company'],
  ['include', 'include'],
  ['exclude', 'exclude'],
  ['ids', 'ids'],
  ['limit', 'limit'],
  ['ingest', 'ingest'],
  ['all', 'all']
]);
const BOOLEAN_FLAGS = new Set(['help', 'ingest', 'all']);
const QUERY_CRITERIA_KEYS = new Set(['include', 'exclude', 'locations', 'workplaceTypes']);
const HELP = `Usage:
  jobtrack-public-scan --adapter ashby|greenhouse --board KEY --source-key KEY --company NAME [options]

Options:
  --include CSV          Match any term in title, location, or description
  --exclude CSV          Exclude any matching term
  --query-key KEY        Apply a stored enabled discovery query during ingestion
  --ids CSV              Restrict the scan to exact provider job IDs
  --limit N              Return at most N matching jobs (default 100)
  --ingest               Save through a durable JobTrack discovery run
  --all                  With --ingest, explicitly authorize all matching jobs
  --help                 Show this help

Ingestion requires --ids or the explicit --all acknowledgement. Preview mode is read-only.
`;

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const flags = parseFlags(argv);
  if (booleanFlag(flags.help, false)) {
    process.stdout.write(HELP);
    return { schemaVersion: 1, mode: 'help' };
  }
  const adapter = required(flags.adapter, '--adapter').toLowerCase();
  if (!ADAPTERS.has(adapter)) throw new Error(`--adapter must be one of: ${[...ADAPTERS].join(', ')}`);
  const board = required(flags.board, '--board');
  if (!BOARD_PATTERN.test(board)) throw new Error('--board contains unsupported characters');
  const sourceKey = required(flags.sourceKey, '--source-key');
  const queryKey = optional(flags.queryKey);
  const company = required(flags.company, '--company');
  const include = normalizeTerms(csv(flags.include), '--include');
  const exclude = normalizeTerms(csv(flags.exclude), '--exclude');
  const ids = new Set(csv(flags.ids));
  const limit = normalizeLimit(flags.limit, 100);
  const ingest = booleanFlag(flags.ingest, false);
  const all = booleanFlag(flags.all, false);
  if (all && !ingest) throw new Error('--all may only be used with --ingest');
  if (all && ids.size) throw new Error('--all and --ids are mutually exclusive');
  if (all && flags.limit !== undefined) throw new Error('--all and --limit are mutually exclusive');
  if (ingest && !all && ids.size === 0) throw new Error('--ingest requires --ids or explicit --all');
  if (!ingest && queryKey) throw new Error('--query-key requires --ingest; read-only previews use only explicit ad hoc filters');
  if (ids.size > limit) throw new Error('--limit must be at least the number of requested --ids');
  const fetchImpl = dependencies.fetch || fetch;
  const endpoint = sourceEndpoint(adapter, board);
  const adHocCriteria = { include, exclude, locations: [], workplaceTypes: [] };

  if (!ingest) {
    const payload = await fetchJson(endpoint, fetchImpl);
    const allJobs = normalizeJobs(adapter, payload, { board, company });
    const selection = selectJobs(allJobs, ids, adHocCriteria, limit);
    const normalized = selection.jobs;
    const missingIds = findMissingIds(ids, normalized);
    const summary = {
      schemaVersion: 1,
      mode: 'preview',
      adapter,
      board,
      sourceKey,
      queryKey,
      queryApplied: false,
      effectiveCriteria: adHocCriteria,
      endpoint,
      sourceCount: allJobs.length,
      matchedCount: selection.matchedCount,
      returnedCount: normalized.length,
      truncated: selection.truncated,
      requestedIds: [...ids],
      missingIds,
      count: normalized.length,
      opportunities: normalized
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return { count: normalized.length, opportunities: normalized, missingIds };
  }

  const storedSource = validateStoredSource(runCli([
    'discovery', 'source', 'show', flagArg('--key', sourceKey), '--json'
  ], dependencies), { adapter, endpoint, sourceKey });
  let queryCriteria = { include: [], exclude: [], locations: [], workplaceTypes: [] };
  let storedQuery = null;
  if (queryKey) {
    const validatedQuery = validateStoredQuery(runCli([
      'discovery', 'query', 'show', flagArg('--key', queryKey), '--json'
    ], dependencies), queryKey);
    storedQuery = validatedQuery.query;
    queryCriteria = validatedQuery.criteria;
  }
  const effectiveCriteria = mergeCriteria(queryCriteria, adHocCriteria);
  let run = null;
  let created = 0;
  let updated = 0;
  let requestCount = 0;
  let seenCount = 0;
  try {
    const startArgs = ['discovery', 'run', 'start', flagArg('--source', sourceKey)];
    addOptional(startArgs, '--query', queryKey);
    startArgs.push(flagArg('--effective-criteria', JSON.stringify(effectiveCriteria)));
    startArgs.push('--json');
    run = runCli(startArgs, dependencies).run;
    if (!run || !Number.isSafeInteger(Number(run.id))) throw new Error('JobTrack did not return a valid discovery run');
    validateStartedRun(run, { storedSource, storedQuery, effectiveCriteria });

    requestCount = 1;
    const { payload, retrieval } = await fetchJsonDetailed(endpoint, fetchImpl);
    const allJobs = normalizeJobs(adapter, payload, { board, company });
    seenCount = allJobs.length;
    const selection = selectJobs(allJobs, ids, effectiveCriteria, all ? Number.MAX_SAFE_INTEGER : limit);
    const normalized = selection.jobs;
    const missingIds = findMissingIds(ids, normalized);
    if (missingIds.length) {
      throw new Error(`Requested public job IDs were not returned or did not match the effective criteria: ${missingIds.join(', ')}`);
    }

    const results = [];
    for (const job of normalized) {
      const args = [
        'opportunity', 'ingest', flagArg('--source', sourceKey), flagArg('--company', job.company),
        flagArg('--role', job.title), flagArg('--url', job.url), flagArg('--provider', job.provider),
        flagArg('--board', job.board), flagArg('--external-id', job.externalId), flagArg('--run-id', run.id),
        flagArg('--observed-at', job.observedAt), flagArg('--parser-name', `${adapter}-public-api`),
        flagArg('--parser-version', '1'), flagArg('--payload', JSON.stringify(job.payload)),
        flagArg('--idempotency-key', observationIdempotencyKey(job, run.id)), '--json'
      ];
      addOptional(args, '--http-status', retrieval.httpStatus);
      addOptional(args, '--content-type', retrieval.contentType);
      addOptional(args, '--etag', retrieval.etag);
      addOptional(args, '--last-modified', retrieval.lastModified);
      addOptional(args, '--raw-sha256', retrieval.rawSha256);
      addOptional(args, '--location', job.location);
      addOptional(args, '--workplace-type', job.workplaceType);
      addOptional(args, '--employment-type', job.employmentType);
      addOptional(args, '--posted-at', job.postedAt);
      addOptional(args, '--description', job.description);
      if (job.compensation) addOptional(args, '--compensation', JSON.stringify(job.compensation));
      const result = runCli(args, dependencies);
      if (result.created) created += 1;
      else updated += 1;
      results.push({ opportunityId: result.opportunityId, created: result.created, title: job.title, url: job.url });
    }
    const finished = runCli([
      'discovery', 'run', 'finish', flagArg('--run-id', run.id), flagArg('--status', 'succeeded'),
      flagArg('--request-count', requestCount), flagArg('--seen-count', seenCount), flagArg('--new-count', created),
      flagArg('--updated-count', updated), flagArg('--closed-count', '0'), '--json'
    ], dependencies).run;
    const summary = {
      schemaVersion: 1,
      mode: 'ingest',
      adapter,
      board,
      sourceKey,
      queryKey,
      queryApplied: Boolean(queryKey),
      effectiveCriteria,
      endpoint,
      sourceCount: allJobs.length,
      matchedCount: selection.matchedCount,
      returnedCount: normalized.length,
      truncated: selection.truncated,
      run: finished,
      created,
      updated,
      results
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  } catch (error) {
    if (run) {
      try {
        runCli([
          'discovery', 'run', 'finish', flagArg('--run-id', run.id), flagArg('--status', 'failed'),
          flagArg('--request-count', requestCount), flagArg('--seen-count', seenCount), flagArg('--new-count', created),
          flagArg('--updated-count', updated), flagArg('--closed-count', '0'), flagArg('--error-code', 'SCANNER_FAILED'),
          flagArg('--error-message', safeError(error)), '--json'
        ], dependencies);
      } catch { /* preserve the original error */ }
    }
    throw error;
  }
}

function sourceEndpoint(adapter, board) {
  if (!BOARD_PATTERN.test(board)) throw new Error('Invalid public board key');
  if (adapter === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${board}`;
  if (adapter === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`;
  throw new Error(`Unsupported adapter: ${adapter}`);
}

async function fetchJson(url, fetchImpl) {
  return (await fetchJsonDetailed(url, fetchImpl)).payload;
}

async function fetchJsonDetailed(url, fetchImpl) {
  const expected = new URL(url);
  let current = expected;
  let response;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    response = await fetchImpl(current.href, {
      headers: { Accept: 'application/json', 'User-Agent': 'JobTrack-public-discovery/0.2 (+private operator tool)' },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000)
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (redirects === 3) throw new Error('Public source exceeded the redirect limit');
    const location = response.headers.get('location');
    if (!location) throw new Error('Public source returned a redirect without Location');
    const next = new URL(location, current);
    if (next.origin !== expected.origin || next.username || next.password) {
      throw new Error('Public source redirected outside its allowlisted host');
    }
    current = next;
  }
  if (!response.ok) throw new Error(`Public source returned HTTP ${response.status}`);
  const final = new URL(response.url || url);
  if (final.origin !== expected.origin || final.username || final.password) throw new Error('Public source redirected outside its allowlisted host');
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_RESPONSE_BYTES) throw new Error('Public source response exceeded the size limit');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('Public source response exceeded the size limit');
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('Public source returned invalid JSON'); }
  return {
    payload,
    retrieval: {
      httpStatus: response.status,
      contentType: optional(response.headers.get('content-type')),
      etag: optional(response.headers.get('etag')),
      lastModified: optional(response.headers.get('last-modified')),
      rawSha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex')
    }
  };
}

function normalizeJobs(adapter, payload, context) {
  if (!payload || !Array.isArray(payload.jobs)) throw new Error(`${adapter} response is missing jobs[]`);
  const observedAt = new Date().toISOString();
  if (adapter === 'ashby') {
    return payload.jobs.map((job) => normalizeJob({
      company: context.company,
      title: job.title,
      url: job.jobUrl,
      provider: 'ashby',
      board: context.board,
      externalId: job.id,
      location: job.location,
      workplaceType: job.workplaceType,
      employmentType: job.employmentType,
      postedAt: job.publishedAt,
      description: job.descriptionPlain || htmlToText(job.descriptionHtml || ''),
      compensation: job.compensation || null,
      observedAt,
      payload: job
    }));
  }
  return payload.jobs.map((job) => normalizeJob({
    company: context.company,
    title: job.title,
    url: job.absolute_url,
    provider: 'greenhouse',
    board: context.board,
    externalId: String(job.id),
    location: job.location && job.location.name,
    workplaceType: null,
    employmentType: null,
    postedAt: null,
    description: htmlToText(job.content || ''),
    compensation: null,
    observedAt,
    payload: job
  }));
}

function normalizeJob(job) {
  for (const key of ['company', 'title', 'url', 'provider', 'board', 'externalId']) required(job[key], key);
  const digest = crypto.createHash('sha256').update(stableJson(job.payload)).digest('hex');
  return {
    ...job,
    idempotencyKey: `${job.provider}:${job.board}:${job.externalId}:${digest}`
  };
}

function matches(job, include, exclude) {
  const haystack = `${job.title} ${job.location || ''} ${job.description || ''}`.toLowerCase();
  if (exclude.some((term) => haystack.includes(term))) return false;
  return include.length === 0 || include.some((term) => haystack.includes(term));
}

function matchesCriteria(job, criteria) {
  if (!matches(job, [], criteria.exclude)) return false;
  const includeGroups = criteria.includeGroups || (criteria.include.length ? [criteria.include] : []);
  if (includeGroups.some((group) => !matches(job, group, []))) return false;
  const location = String(job.location || '').toLowerCase();
  if (criteria.locations.length && !criteria.locations.some((term) => location.includes(term))) return false;
  const workplaceType = String(job.workplaceType || '').trim().toLowerCase();
  if (criteria.workplaceTypes.length && !criteria.workplaceTypes.includes(workplaceType)) return false;
  return true;
}

function selectJobs(jobs, ids, criteria, limit) {
  const matching = jobs
    .filter((job) => ids.size === 0 || ids.has(job.externalId))
    .filter((job) => matchesCriteria(job, criteria));
  const selected = matching.slice(0, limit);
  return { jobs: selected, matchedCount: matching.length, truncated: selected.length < matching.length };
}

function findMissingIds(ids, jobs) {
  const foundIds = new Set(jobs.map((job) => job.externalId));
  return [...ids].filter((id) => !foundIds.has(id)).sort();
}

function validateStoredSource(result, expected) {
  const source = result && result.source;
  if (!source || typeof source !== 'object') throw new Error('JobTrack did not return the configured discovery source');
  if (String(source.source_key || '').toLowerCase() !== expected.sourceKey.toLowerCase()) {
    throw new Error(`Stored source key does not match --source-key: ${expected.sourceKey}`);
  }
  if (source.adapter !== expected.adapter) {
    throw new Error(`Stored source adapter mismatch: expected ${expected.adapter}`);
  }
  if (normalizeEndpoint(source.base_url) !== normalizeEndpoint(expected.endpoint)) {
    throw new Error(`Stored source endpoint mismatch for ${expected.sourceKey}`);
  }
  if (source.enabled !== true) throw new Error(`Stored source is disabled: ${expected.sourceKey}`);
  if (source.policy_state !== 'allowed') {
    throw new Error(`Stored source policy is not allowed: ${expected.sourceKey}`);
  }
  if (!source.updated_at || Number.isNaN(Date.parse(source.updated_at))) {
    throw new Error(`Stored source is missing a valid update revision: ${expected.sourceKey}`);
  }
  return source;
}

function validateStoredQuery(result, expectedKey) {
  const query = result && result.query;
  if (!query || typeof query !== 'object') throw new Error('JobTrack did not return the configured discovery query');
  if (String(query.query_key || '').toLowerCase() !== expectedKey.toLowerCase()) {
    throw new Error(`Stored query key does not match --query-key: ${expectedKey}`);
  }
  if (query.enabled !== true) throw new Error(`Stored discovery query is disabled: ${expectedKey}`);
  if (!query.updated_at || Number.isNaN(Date.parse(query.updated_at))) {
    throw new Error(`Stored discovery query is missing a valid update revision: ${expectedKey}`);
  }
  return { query, criteria: validateCriteria(query.criteria, `stored query ${expectedKey}`) };
}

function validateStartedRun(run, expected) {
  const sourceSnapshot = runJson(run, 'sourceSnapshot', 'source_snapshot_json');
  if (String(sourceSnapshot.sourceKey || '').toLowerCase() !== String(expected.storedSource.source_key).toLowerCase()
      || sourceSnapshot.adapter !== expected.storedSource.adapter
      || normalizeEndpoint(sourceSnapshot.baseUrl) !== normalizeEndpoint(expected.storedSource.base_url)
      || sourceSnapshot.updatedAt !== expected.storedSource.updated_at) {
    throw new Error('Discovery run source snapshot does not match the validated source revision');
  }

  const effectiveCriteria = runJson(run, 'effectiveCriteria', 'effective_criteria_json');
  if (stableJson(effectiveCriteria) !== stableJson(expected.effectiveCriteria)) {
    throw new Error('Discovery run effective criteria do not match the validated scan criteria');
  }

  if (expected.storedQuery) {
    const querySnapshot = runJson(run, 'querySnapshot', 'query_snapshot_json');
    if (String(querySnapshot.queryKey || '').toLowerCase() !== String(expected.storedQuery.query_key).toLowerCase()
        || querySnapshot.updatedAt !== expected.storedQuery.updated_at
        || stableJson(querySnapshot.criteria) !== stableJson(expected.storedQuery.criteria)) {
      throw new Error('Discovery run query snapshot does not match the validated query revision');
    }
  } else if (run.query_snapshot_json !== null && run.query_snapshot_json !== undefined
      ? runJson(run, 'querySnapshot', 'query_snapshot_json') !== null
      : run.querySnapshot !== null && run.querySnapshot !== undefined) {
    throw new Error('Discovery run unexpectedly captured a query');
  }
}

function runJson(run, camelKey, storageKey) {
  if (Object.prototype.hasOwnProperty.call(run, camelKey)) return run[camelKey];
  if (!Object.prototype.hasOwnProperty.call(run, storageKey)) {
    throw new Error(`Discovery run is missing ${storageKey}`);
  }
  const value = run[storageKey];
  if (value === null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { throw new Error(`Discovery run contains invalid ${storageKey}`); }
}

function validateCriteria(value, label) {
  if (value === undefined || value === null) value = {};
  if (!isPlainObject(value)) throw new Error(`${label} criteria must be an object`);
  const unknown = Object.keys(value).filter((key) => !QUERY_CRITERIA_KEYS.has(key));
  if (unknown.length) throw new Error(`${label} has unsupported criteria: ${unknown.sort().join(', ')}`);
  return {
    include: normalizeCriteriaArray(value.include, `${label}.include`),
    exclude: normalizeCriteriaArray(value.exclude, `${label}.exclude`),
    locations: normalizeCriteriaArray(value.locations, `${label}.locations`),
    workplaceTypes: normalizeCriteriaArray(value.workplaceTypes, `${label}.workplaceTypes`)
  };
}

function mergeCriteria(...criteria) {
  const merged = { include: [], exclude: [], locations: [], workplaceTypes: [] };
  const includeGroups = [];
  for (const item of criteria) {
    const validated = validateCriteria(item, 'effective');
    if (validated.include.length) includeGroups.push(validated.include);
    for (const key of Object.keys(merged)) merged[key].push(...validated[key]);
  }
  for (const key of Object.keys(merged)) merged[key] = [...new Set(merged[key])];
  merged.includeGroups = includeGroups;
  return merged;
}

function observationIdempotencyKey(job, runId) {
  return crypto.createHash('sha256').update(`${job.idempotencyKey}|run:${String(runId)}`).digest('hex');
}

function normalizeCriteriaArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`);
  return normalizeTerms(value, label);
}

function normalizeTerms(values, label) {
  return [...new Set(values.map((value) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must contain non-empty strings`);
    return value.trim().toLowerCase();
  }))];
}

function normalizeEndpoint(value) {
  try {
    const url = new URL(required(value, 'source base URL'));
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('unsafe URL');
    return url.href;
  } catch {
    throw new Error('Stored source endpoint is not a valid HTTPS URL');
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function runCli(args, dependencies) {
  if (dependencies.runCli) return dependencies.runCli(args);
  const stdout = execFileSync(process.execPath, [cli, ...args], {
    cwd: path.resolve(__dirname, '..'),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

function parseFlags(argv) {
  const flags = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected positional argument: ${token}`);
    const equal = token.indexOf('=');
    const rawKey = token.slice(2, equal === -1 ? undefined : equal);
    const key = FLAG_KEYS.get(rawKey);
    if (!key) throw new Error(`Unknown flag: --${rawKey}`);
    if (seen.has(key)) throw new Error(`Duplicate flag: --${rawKey}`);
    seen.add(key);
    if (equal !== -1) {
      flags[key] = token.slice(equal + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
    } else {
      throw new Error(`--${rawKey} requires a value (use --${rawKey}=VALUE when it begins with --)`);
    }
  }
  return flags;
}

function required(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') throw new Error(`Missing required ${label}`);
  return String(value).trim();
}

function csv(value) {
  return value === undefined ? [] : String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function optional(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return String(value).trim();
}

function normalizeLimit(value, fallback) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > 1000) throw new Error('--limit must be between 1 and 1000');
  return result;
}

function booleanFlag(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === 'true' || value === '1' || value === 'yes') return true;
  if (value === false || value === 'false' || value === '0' || value === 'no') return false;
  throw new Error('Boolean flag must be true or false');
}

function addOptional(args, flag, value) {
  if (value !== undefined && value !== null && String(value) !== '') args.push(flagArg(flag, value));
}

function flagArg(flag, value) {
  return `${flag}=${String(value)}`;
}

function htmlToText(value) {
  return String(value || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<(p|div|h[1-6])(?:\s[^>]*)?>/gi, '\n')
    .replace(/<\/(p|li|div|h[1-6])\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function safeError(error) {
  return String(error && error.message || 'scanner failed').replace(/[\r\n]+/g, ' ').slice(0, 500);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`jobtrack-discovery: ${safeError(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchJson,
  fetchJsonDetailed,
  htmlToText,
  main,
  matches,
  matchesCriteria,
  normalizeJobs,
  parseFlags,
  sourceEndpoint,
  validateCriteria
};
