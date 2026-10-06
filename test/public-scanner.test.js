'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  fetchJson,
  htmlToText,
  main,
  matches,
  matchesCriteria,
  normalizeJobs,
  parseFlags,
  sourceEndpoint,
  validateCriteria
} = require('../scripts/scan-public-jobs');

function allowedSource(overrides = {}) {
  return {
    source_key: 'ashby-example',
    adapter: 'ashby',
    base_url: 'https://api.ashbyhq.com/posting-api/job-board/example',
    enabled: true,
    policy_state: 'allowed',
    updated_at: '2026-07-17T12:00:00.000Z',
    ...overrides
  };
}

function storedQuery(key, criteria) {
  return {
    query_key: key,
    name: key,
    enabled: true,
    criteria,
    updated_at: '2026-07-17T12:00:00.000Z'
  };
}

function startedRun(id, options = {}) {
  const source = options.source || allowedSource();
  const query = options.query || null;
  const effectiveCriteria = options.effectiveCriteria || {
    include: [], exclude: [], locations: [], workplaceTypes: [], includeGroups: []
  };
  return {
    id,
    status: options.status || 'running',
    source_snapshot_json: JSON.stringify({
      sourceKey: source.source_key,
      adapter: source.adapter,
      baseUrl: source.base_url,
      updatedAt: source.updated_at
    }),
    query_snapshot_json: query ? JSON.stringify({
      queryKey: query.query_key,
      criteria: query.criteria,
      updatedAt: query.updated_at
    }) : null,
    effective_criteria_json: JSON.stringify(effectiveCriteria)
  };
}

test('public scanner endpoints are fixed-host and board keys are constrained', () => {
  assert.equal(sourceEndpoint('ashby', 'vapi'), 'https://api.ashbyhq.com/posting-api/job-board/vapi');
  assert.equal(sourceEndpoint('greenhouse', 'anthropic'), 'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs?content=true');
  assert.throws(() => sourceEndpoint('ashby', '../internal'), /Invalid public board key/);
  assert.throws(() => sourceEndpoint('custom', 'vapi'), /Unsupported adapter/);
});

test('Ashby and Greenhouse payloads normalize to the opportunity contract', () => {
  const ashby = normalizeJobs('ashby', { jobs: [{
    id: 'uuid-1', title: 'Forward Deployed Engineer', location: 'San Francisco',
    workplaceType: 'Hybrid', employmentType: 'FullTime', publishedAt: '2026-07-01T00:00:00Z',
    jobUrl: 'https://jobs.ashbyhq.com/example/uuid-1', descriptionPlain: 'Build voice systems.',
    compensation: { min: 180000, max: 250000, currency: 'USD' }
  }] }, { board: 'example', company: 'Example' });
  assert.equal(ashby[0].externalId, 'uuid-1');
  assert.equal(ashby[0].description, 'Build voice systems.');
  assert.match(ashby[0].idempotencyKey, /^ashby:example:uuid-1:[a-f0-9]{64}$/);

  const greenhouse = normalizeJobs('greenhouse', { jobs: [{
    id: 123, title: 'Platform Engineer', absolute_url: 'https://job-boards.greenhouse.io/example/jobs/123',
    location: { name: 'Remote' }, content: '<p>Build &amp; operate.</p><ul><li>Own systems</li></ul>'
  }] }, { board: 'example', company: 'Example' });
  assert.equal(greenhouse[0].externalId, '123');
  assert.match(greenhouse[0].description, /Build & operate/);
  assert.match(greenhouse[0].description, /Own systems/);
  assert.equal(greenhouse[0].postedAt, null);
});

test('filters are deterministic and posting HTML is converted only to text', () => {
  const job = { title: 'Senior Platform Engineer', location: 'Remote', description: 'Voice AI and TypeScript' };
  assert.equal(matches(job, ['voice'], []), true);
  assert.equal(matches(job, ['rust'], []), false);
  assert.equal(matches(job, [], ['senior']), false);
  assert.equal(htmlToText('<script>alert(1)</script><p>Hello&nbsp;world</p>'), 'alert(1)\nHello world');
  assert.equal(matchesCriteria(
    { ...job, workplaceType: 'Hybrid' },
    { include: ['voice'], exclude: [], locations: ['remote'], workplaceTypes: ['hybrid'] }
  ), true);
  assert.equal(matchesCriteria(
    { ...job, workplaceType: 'Hybrid' },
    { include: [], exclude: [], locations: ['seattle'], workplaceTypes: [] }
  ), false);
  assert.deepEqual(validateCriteria({ include: [' Platform '], locations: ['SF'] }, 'query'), {
    include: ['platform'], exclude: [], locations: ['sf'], workplaceTypes: []
  });
  assert.throws(() => validateCriteria({ seniority: ['senior'] }, 'query'), /unsupported criteria/);
});

test('scanner flags are strict, duplicate-aware, and support equals syntax', () => {
  assert.deepEqual(parseFlags(['--adapter=ashby', '--source-key=example', '--ingest=false']), {
    adapter: 'ashby', sourceKey: 'example', ingest: 'false'
  });
  assert.throws(() => parseFlags(['--adpater', 'ashby']), /Unknown flag: --adpater/);
  assert.throws(() => parseFlags(['--source', 'one', '--source-key', 'two']), /Duplicate flag/);
  assert.throws(() => parseFlags(['--adapter']), /requires a value/);
});

test('scanner help needs no configuration and performs no fetch or CLI access', async () => {
  let called = false;
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    const result = await main(['--help'], {
      fetch: async () => { called = true; throw new Error('unexpected fetch'); },
      runCli: () => { called = true; throw new Error('unexpected CLI call'); }
    });
    assert.equal(result.mode, 'help');
    assert.equal(called, false);
    assert.match(writes.join(''), /Ingestion requires --ids/);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('fetch boundary rejects off-host redirects and oversized content', async () => {
  const offHost = async () => ({
    ok: true, status: 200, url: 'https://evil.example/jobs', headers: new Headers(),
    text: async () => '{"jobs":[]}'
  });
  await assert.rejects(fetchJson('https://api.ashbyhq.com/posting-api/job-board/example', offHost), /outside its allowlisted host/);

  const requested = [];
  const redirectAttempt = async (url, options) => {
    requested.push(url);
    assert.equal(options.redirect, 'manual');
    return {
      ok: false, status: 302, url,
      headers: new Headers({ location: 'https://127.0.0.1/private' }),
      text: async () => ''
    };
  };
  await assert.rejects(fetchJson('https://api.ashbyhq.com/posting-api/job-board/example', redirectAttempt), /outside its allowlisted host/);
  assert.deepEqual(requested, ['https://api.ashbyhq.com/posting-api/job-board/example']);

  const offPortAttempt = async (url) => ({
    ok: false, status: 302, url,
    headers: new Headers({ location: 'https://api.ashbyhq.com:8443/private' }),
    text: async () => ''
  });
  await assert.rejects(
    fetchJson('https://api.ashbyhq.com/posting-api/job-board/example', offPortAttempt),
    /outside its allowlisted host/
  );

  const oversized = async (url) => ({
    ok: true, status: 200, url, headers: new Headers({ 'content-length': String(11 * 1024 * 1024) }),
    text: async () => '{"jobs":[]}'
  });
  await assert.rejects(fetchJson('https://api.ashbyhq.com/posting-api/job-board/example', oversized), /size limit/);
});

test('scanner preview never invokes the writer', async () => {
  let writerCalled = false;
  const fetchStub = async (url) => ({
    ok: true, status: 200, url, headers: new Headers(),
    text: async () => JSON.stringify({ jobs: [{ id: '1', title: 'Platform Engineer', location: 'SF', jobUrl: 'https://jobs.ashbyhq.com/example/1', descriptionPlain: 'TypeScript platform' }] })
  });
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    const result = await main(['--adapter', 'ashby', '--board', 'example', '--source-key', 'ashby-example', '--company', 'Example', '--include', 'platform'], {
      fetch: fetchStub,
      runCli: () => { writerCalled = true; }
    });
    assert.equal(result.count, 1);
    assert.equal(writerCalled, false);
    assert.match(writes.join(''), /"mode": "preview"/);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('scanner can target an explicit provider-id allowlist', async () => {
  const fetchStub = async (url) => ({
    ok: true, status: 200, url, headers: new Headers(),
    text: async () => JSON.stringify({ jobs: [
      { id: 'keep', title: 'Forward Deployed Engineer', location: 'SF', jobUrl: 'https://jobs.ashbyhq.com/example/keep', descriptionPlain: 'Voice AI' },
      { id: 'skip', title: 'Account Executive', location: 'SF', jobUrl: 'https://jobs.ashbyhq.com/example/skip', descriptionPlain: 'Sales' }
    ] })
  });
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    const result = await main([
      '--adapter', 'ashby', '--board', 'example', '--source-key', 'ashby-example',
      '--company', 'Example', '--ids', 'keep'
    ], { fetch: fetchStub });
    assert.equal(result.count, 1);
    assert.equal(result.opportunities[0].externalId, 'keep');
    assert.doesNotMatch(writes.join(''), /Account Executive/);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('targeted ingestion fails closed when an explicitly requested posting disappeared', async () => {
  const fetchStub = async (url) => ({
    ok: true, status: 200, url, headers: new Headers(),
    text: async () => JSON.stringify({ jobs: [] })
  });
  const events = [];
  const runCliStub = (args) => {
    events.push(['cli', args]);
    if (args[0] === 'discovery' && args[1] === 'source') return { source: allowedSource() };
    if (args[0] === 'discovery' && args[1] === 'run' && args[2] === 'start') return { run: startedRun(12) };
    if (args[0] === 'discovery' && args[1] === 'run' && args[2] === 'finish') return { run: { id: 12, status: 'failed' } };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  await assert.rejects(
    main([
      '--adapter', 'ashby', '--board', 'example', '--source-key', 'ashby-example',
      '--company', 'Example', '--ids', 'missing-job', '--ingest'
    ], {
      fetch: async (url) => { events.push(['fetch', url]); return fetchStub(url); },
      runCli: runCliStub
    }),
    /not returned or did not match.*missing-job/
  );
  assert.deepEqual(events.map(([kind, value]) => kind === 'fetch' ? 'fetch' : value.slice(0, 3).join(' ')), [
    'discovery source show',
    'discovery run start',
    'fetch',
    'discovery run finish'
  ]);
  const failed = events.at(-1)[1];
  assert.ok(failed.includes('--status=failed'));
  assert.ok(failed.includes('--request-count=1'));
  assert.ok(failed.includes('--seen-count=0'));
});

test('explicit ingest writes only through a provenance-bound CLI run', async () => {
  const fetchStub = async (url) => ({
    ok: true, status: 200, url,
    headers: new Headers({
      'content-type': 'application/json; charset=utf-8',
      etag: '"scanner-test"',
      'last-modified': 'Fri, 17 Jul 2026 12:00:00 GMT'
    }),
    text: async () => JSON.stringify({ jobs: [
      { id: 'job-1', title: 'Platform Engineer', location: 'San Francisco', jobUrl: 'https://jobs.ashbyhq.com/example/job-1', descriptionPlain: 'Build platforms.' }
    ] })
  });
  const calls = [];
  const runCliStub = (args) => {
    calls.push(args);
    if (args[0] === 'discovery' && args[1] === 'source') return { source: allowedSource() };
    const query = storedQuery('platform-sf', { include: ['platform'], locations: ['San Francisco'], workplaceTypes: [] });
    if (args[0] === 'discovery' && args[1] === 'query') return { query };
    if (args[0] === 'discovery' && args[2] === 'start') return { run: startedRun(7, {
      query,
      effectiveCriteria: {
        include: ['platform'], exclude: [], locations: ['san francisco'], workplaceTypes: [],
        includeGroups: [['platform']]
      }
    }) };
    if (args[0] === 'opportunity') return { opportunityId: 11, created: true };
    if (args[0] === 'discovery' && args[2] === 'finish') return { run: { id: 7, status: 'succeeded' } };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const result = await main([
      '--adapter', 'ashby', '--board', 'example', '--source-key', 'ashby-example',
      '--query-key', 'platform-sf', '--company', 'Example', '--ids', 'job-1', '--ingest'
    ], { fetch: fetchStub, runCli: runCliStub });
    assert.equal(result.created, 1);
    assert.deepEqual(result.effectiveCriteria, {
      include: ['platform'], exclude: [], locations: ['san francisco'], workplaceTypes: [],
      includeGroups: [['platform']]
    });
    assert.deepEqual(calls[0], ['discovery', 'source', 'show', '--key=ashby-example', '--json']);
    assert.deepEqual(calls[1], ['discovery', 'query', 'show', '--key=platform-sf', '--json']);
    assert.deepEqual(calls[2], [
      'discovery', 'run', 'start', '--source=ashby-example', '--query=platform-sf',
      '--effective-criteria={"include":["platform"],"exclude":[],"locations":["san francisco"],"workplaceTypes":[],"includeGroups":[["platform"]]}',
      '--json'
    ]);
    assert.equal(calls[3][0], 'opportunity');
    assert.ok(calls[3].includes('--run-id=7'));
    assert.ok(calls[3].includes('--http-status=200'));
    assert.ok(calls[3].includes('--content-type=application/json; charset=utf-8'));
    assert.ok(calls[3].includes('--etag="scanner-test"'));
    assert.ok(calls[3].includes('--last-modified=Fri, 17 Jul 2026 12:00:00 GMT'));
    assert.match(calls[3].find((arg) => arg.startsWith('--raw-sha256=')), /^--raw-sha256=[a-f0-9]{64}$/);
    assert.deepEqual(calls[4].slice(0, 5), ['discovery', 'run', 'finish', '--run-id=7', '--status=succeeded']);
    assert.ok(calls[4].includes('--seen-count=1'));
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('ingestion fails before fetch when the durable run snapshot differs from preflight', async () => {
  let fetched = false;
  const calls = [];
  const changedSource = allowedSource({ updated_at: '2026-07-17T12:01:00.000Z' });
  await assert.rejects(main([
    '--adapter=ashby', '--board=example', '--source-key=ashby-example', '--company=Example',
    '--ids=job-1', '--ingest'
  ], {
    fetch: async () => { fetched = true; throw new Error('must not fetch'); },
    runCli: (args) => {
      calls.push(args);
      if (args[1] === 'source') return { source: allowedSource() };
      if (args[0] === 'discovery' && args[2] === 'start') return { run: startedRun(8, { source: changedSource }) };
      if (args[0] === 'discovery' && args[2] === 'finish') return { run: { id: 8, status: 'failed' } };
      throw new Error(`unexpected call: ${args.join(' ')}`);
    }
  }), /source snapshot does not match/);
  assert.equal(fetched, false);
  assert.ok(calls.at(-1).includes('--status=failed'));
  assert.ok(calls.at(-1).includes('--request-count=0'));
});

test('ingestion validates the exact stored source before any network request', async () => {
  let fetched = false;
  const calls = [];
  await assert.rejects(main([
    '--adapter=ashby', '--board=example', '--source-key=ashby-example', '--company=Example',
    '--ids=job-1', '--ingest'
  ], {
    fetch: async () => { fetched = true; throw new Error('must not fetch'); },
    runCli: (args) => {
      calls.push(args);
      return { source: allowedSource({ base_url: 'https://api.ashbyhq.com/posting-api/job-board/another' }) };
    }
  }), /endpoint mismatch/);
  assert.equal(fetched, false);
  assert.deepEqual(calls, [['discovery', 'source', 'show', '--key=ashby-example', '--json']]);

  calls.length = 0;
  await assert.rejects(main([
    '--adapter=ashby', '--board=example', '--source-key=ashby-example', '--company=Example',
    '--ids=job-1', '--ingest'
  ], {
    fetch: async () => { fetched = true; throw new Error('must not fetch'); },
    runCli: (args) => {
      calls.push(args);
      return { source: allowedSource({ adapter: 'greenhouse' }) };
    }
  }), /adapter mismatch/);
  assert.equal(fetched, false);
  assert.equal(calls.length, 1);
});

test('disabled stored sources fail before any network request', async () => {
  let fetched = false;
  await assert.rejects(main([
    '--adapter=ashby', '--board=example', '--source-key=ashby-example', '--company=Example',
    '--ids=job-1', '--ingest'
  ], {
    fetch: async () => { fetched = true; throw new Error('must not fetch'); },
    runCli: () => ({ source: allowedSource({ enabled: false }) })
  }), /source is disabled/);
  assert.equal(fetched, false);
});

test('ingestion requires a deliberate scope and rejects typo flags before access', async () => {
  let called = false;
  await assert.rejects(main([
    '--adapter=ashby', '--board=example', '--source-key=ashby-example', '--company=Example', '--ingest'
  ], {
    fetch: async () => { called = true; },
    runCli: () => { called = true; }
  }), /requires --ids or explicit --all/);
  await assert.rejects(main([
    '--adapter=ashby', '--board=example', '--source-key=ashby-example', '--company=Example', '--id=job-1', '--ingest'
  ]), /Unknown flag: --id/);
  await assert.rejects(main([
    '--adapter=ashby', '--board=example', '--source-key=ashby-example', '--company=Example', '--all', '--limit=10', '--ingest'
  ]), /--all and --limit are mutually exclusive/);
  await assert.rejects(main([
    '--adapter=ashby', '--board=example', '--source-key=ashby-example', '--query-key=stored', '--company=Example'
  ]), /--query-key requires --ingest/);
  assert.equal(called, false);
});

test('stored query criteria are applied and merged with ad hoc filters', async () => {
  const fetchStub = async (url) => ({
    ok: true, status: 200, url, headers: new Headers(),
    text: async () => JSON.stringify({ jobs: [
      { id: 'match', title: 'Platform Engineer', location: 'San Francisco', workplaceType: 'Hybrid', jobUrl: 'https://jobs.ashbyhq.com/example/match', descriptionPlain: 'Voice infrastructure' },
      { id: 'no-voice', title: 'Platform Engineer', location: 'San Francisco', workplaceType: 'Hybrid', jobUrl: 'https://jobs.ashbyhq.com/example/no-voice', descriptionPlain: 'Build internal systems' },
      { id: 'wrong-place', title: 'Platform Engineer', location: 'New York', workplaceType: 'Hybrid', jobUrl: 'https://jobs.ashbyhq.com/example/wrong-place', descriptionPlain: 'Voice infrastructure' },
      { id: 'excluded', title: 'Platform Sales Engineer', location: 'San Francisco', workplaceType: 'Hybrid', jobUrl: 'https://jobs.ashbyhq.com/example/excluded', descriptionPlain: 'Voice infrastructure' }
    ] })
  });
  const ingested = [];
  const runCliStub = (args) => {
    if (args[1] === 'source') return { source: allowedSource() };
    const query = storedQuery('voice-sf', {
      include: ['platform'], exclude: ['sales'], locations: ['SF', 'San Francisco'], workplaceTypes: ['Hybrid']
    });
    if (args[1] === 'query') return { query };
    if (args[0] === 'discovery' && args[2] === 'start') return { run: startedRun(21, {
      query,
      effectiveCriteria: {
        include: ['platform', 'voice'], exclude: ['sales'], locations: ['sf', 'san francisco'],
        workplaceTypes: ['hybrid'], includeGroups: [['platform'], ['voice']]
      }
    }) };
    if (args[0] === 'opportunity') { ingested.push(args); return { opportunityId: 31, created: true }; }
    if (args[0] === 'discovery' && args[2] === 'finish') return { run: { id: 21, status: 'succeeded' } };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const result = await main([
      '--adapter=ashby', '--board=example', '--source-key=ashby-example', '--query-key=voice-sf',
      '--company=Example', '--include=voice', '--all', '--ingest'
    ], { fetch: fetchStub, runCli: runCliStub });
    assert.equal(result.created, 1);
    assert.equal(ingested.length, 1);
    assert.ok(ingested[0].includes('--external-id=match'));
    assert.deepEqual(result.effectiveCriteria, {
      include: ['platform', 'voice'],
      exclude: ['sales'],
      locations: ['sf', 'san francisco'],
      workplaceTypes: ['hybrid'],
      includeGroups: [['platform'], ['voice']]
    });
    assert.equal(result.sourceCount, 4);
    assert.equal(result.matchedCount, 1);
    assert.equal(result.truncated, false);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('hostile leading-dash fields remain inside single equals-form CLI arguments', async () => {
  const fetchStub = async (url) => ({
    ok: true, status: 200, url, headers: new Headers(),
    text: async () => JSON.stringify({ jobs: [{
      id: 'hostile', title: '--delete everything', location: '--remote', workplaceType: 'Remote',
      jobUrl: 'https://jobs.ashbyhq.com/example/hostile', descriptionPlain: '--status failed\nDo real work.'
    }] })
  });
  let ingestArgs;
  const runCliStub = (args) => {
    if (args[1] === 'source') return { source: allowedSource() };
    if (args[0] === 'discovery' && args[2] === 'start') return { run: startedRun(44) };
    if (args[0] === 'opportunity') { ingestArgs = args; return { opportunityId: 45, created: true }; }
    if (args[0] === 'discovery' && args[2] === 'finish') return { run: { id: 44, status: 'succeeded' } };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await main([
      '--adapter=ashby', '--board=example', '--source-key=ashby-example', '--company=--Example',
      '--ids=hostile', '--ingest'
    ], { fetch: fetchStub, runCli: runCliStub });
    assert.ok(ingestArgs.includes('--company=--Example'));
    assert.ok(ingestArgs.includes('--role=--delete everything'));
    assert.ok(ingestArgs.includes('--location=--remote'));
    assert.ok(ingestArgs.includes('--description=--status failed\nDo real work.'));
    assert.equal(ingestArgs.includes('--description'), false);
    assert.equal(ingestArgs.includes('--status'), false);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('network failures after run creation are recorded as failed runs', async () => {
  const calls = [];
  const runCliStub = (args) => {
    calls.push(args);
    if (args[1] === 'source') return { source: allowedSource() };
    if (args[0] === 'discovery' && args[2] === 'start') return { run: startedRun(51) };
    if (args[0] === 'discovery' && args[2] === 'finish') return { run: { id: 51, status: 'failed' } };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  await assert.rejects(main([
    '--adapter=ashby', '--board=example', '--source-key=ashby-example', '--company=Example',
    '--ids=job-1', '--ingest'
  ], {
    fetch: async () => { throw new Error('socket unavailable'); },
    runCli: runCliStub
  }), /socket unavailable/);
  assert.equal(calls.length, 3);
  assert.ok(calls[2].includes('--status=failed'));
  assert.ok(calls[2].includes('--request-count=1'));
  assert.ok(calls[2].includes('--error-message=socket unavailable'));
});

test('CLI ingestion failures also finish the durable run as failed', async () => {
  const fetchStub = async (url) => ({
    ok: true, status: 200, url, headers: new Headers(),
    text: async () => JSON.stringify({ jobs: [{
      id: 'job-1', title: 'Platform Engineer', location: 'Remote',
      jobUrl: 'https://jobs.ashbyhq.com/example/job-1', descriptionPlain: 'Build platforms.'
    }] })
  });
  const calls = [];
  const runCliStub = (args) => {
    calls.push(args);
    if (args[1] === 'source') return { source: allowedSource() };
    if (args[0] === 'discovery' && args[2] === 'start') return { run: startedRun(53) };
    if (args[0] === 'opportunity') throw new Error('database rejected observation');
    if (args[0] === 'discovery' && args[2] === 'finish') return { run: { id: 53, status: 'failed' } };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  await assert.rejects(main([
    '--adapter=ashby', '--board=example', '--source-key=ashby-example', '--company=Example',
    '--ids=job-1', '--ingest'
  ], { fetch: fetchStub, runCli: runCliStub }), /database rejected observation/);
  const finish = calls.at(-1);
  assert.deepEqual(finish.slice(0, 5), ['discovery', 'run', 'finish', '--run-id=53', '--status=failed']);
  assert.ok(finish.includes('--seen-count=1'));
  assert.ok(finish.includes('--new-count=0'));
  assert.ok(finish.includes('--error-message=database rejected observation'));
});

test('--all ingests every matching job rather than applying the preview limit', async () => {
  const jobs = Array.from({ length: 105 }, (_, index) => ({
    id: `job-${index + 1}`,
    title: `Platform Engineer ${index + 1}`,
    location: 'Remote',
    jobUrl: `https://jobs.ashbyhq.com/example/job-${index + 1}`,
    descriptionPlain: 'Build platforms.'
  }));
  const fetchStub = async (url) => ({
    ok: true, status: 200, url, headers: new Headers(), text: async () => JSON.stringify({ jobs })
  });
  let ingested = 0;
  const runCliStub = (args) => {
    if (args[1] === 'source') return { source: allowedSource() };
    if (args[0] === 'discovery' && args[2] === 'start') return { run: startedRun(55) };
    if (args[0] === 'opportunity') { ingested += 1; return { opportunityId: ingested, created: true }; }
    if (args[0] === 'discovery' && args[2] === 'finish') return { run: { id: 55, status: 'succeeded' } };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const result = await main([
      '--adapter=ashby', '--board=example', '--source-key=ashby-example', '--company=Example', '--all', '--ingest'
    ], { fetch: fetchStub, runCli: runCliStub });
    assert.equal(ingested, 105);
    assert.equal(result.sourceCount, 105);
    assert.equal(result.matchedCount, 105);
    assert.equal(result.returnedCount, 105);
    assert.equal(result.truncated, false);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('observation idempotency keys are bound to and distinct across runs', async () => {
  const fetchStub = async (url) => ({
    ok: true, status: 200, url, headers: new Headers(),
    text: async () => JSON.stringify({ jobs: [{
      id: 'job-1', title: 'Platform Engineer', location: 'SF',
      jobUrl: 'https://jobs.ashbyhq.com/example/job-1', descriptionPlain: 'Build platforms.'
    }] })
  });
  const keys = [];
  let nextRunId = 60;
  const makeRunCli = () => {
    const runId = nextRunId++;
    return (args) => {
      if (args[1] === 'source') return { source: allowedSource() };
      if (args[0] === 'discovery' && args[2] === 'start') return { run: startedRun(runId) };
      if (args[0] === 'opportunity') {
        keys.push(args.find((arg) => arg.startsWith('--idempotency-key=')));
        return { opportunityId: 70, created: runId === 60 };
      }
      if (args[0] === 'discovery' && args[2] === 'finish') return { run: { id: runId, status: 'succeeded' } };
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
  };
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    for (let iteration = 0; iteration < 2; iteration += 1) {
      await main([
        '--adapter=ashby', '--board=example', '--source-key=ashby-example', '--company=Example',
        '--ids=job-1', '--ingest'
      ], { fetch: fetchStub, runCli: makeRunCli() });
    }
    assert.equal(keys.length, 2);
    assert.match(keys[0], /^--idempotency-key=[a-f0-9]{64}$/);
    assert.match(keys[1], /^--idempotency-key=[a-f0-9]{64}$/);
    assert.notEqual(keys[0], keys[1]);
  } finally {
    process.stdout.write = originalWrite;
  }
});
