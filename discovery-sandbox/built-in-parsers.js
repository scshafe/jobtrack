'use strict';

// Pure, closed parser registry. This module deliberately imports no networking,
// process execution, dynamic module loading, browser, database, or JobTrack writer.
const { TextDecoder } = require('node:util');
const {
  ContractError,
  digest,
  stableJson,
  validateCandidateObservation,
  validateJsonValue,
  withObservationFingerprints
} = require('./contracts');

const WORK_REQUEST_SCHEMA_VERSION = 2;
const INPUT_SCHEMA_ID = 'jobtrack.discovery.parser-work-request.v2';
const OUTPUT_SCHEMA_ID = 'jobtrack.discovery.proposal-bundle.v1';
const MAX_ITEMS = 1000;
const MAX_TEXT = 512 * 1024;
const MAX_SHORT_TEXT = 4000;
const JSON_CONTENT_TYPES = new Set([
  'application/json',
  'application/feed+json'
]);

const DEFINITIONS = Object.freeze([
  Object.freeze({
    pluginId: 'jobtrack.ashby-public-board',
    parserName: 'ashby-json',
    parserVersion: '1',
    strategyKind: 'direct-board',
    configKind: 'board',
    parse: parseAshby
  }),
  Object.freeze({
    pluginId: 'jobtrack.greenhouse-public-board',
    parserName: 'greenhouse-json',
    parserVersion: '1',
    strategyKind: 'direct-board',
    configKind: 'board',
    parse: parseGreenhouse
  }),
  Object.freeze({
    pluginId: 'jobtrack.lever-public-board',
    parserName: 'lever-json',
    parserVersion: '1',
    strategyKind: 'direct-board',
    configKind: 'board',
    parse: parseLever
  }),
  Object.freeze({
    pluginId: 'jobtrack.funding-json-feed',
    parserName: 'funding-json-feed',
    parserVersion: '1',
    strategyKind: 'funding-signal',
    configKind: 'funding-feed',
    parse: parseFundingJsonFeed
  })
]);

const REGISTRY = new Map(DEFINITIONS.map((definition) => [registryKey(definition), definition]));

function executeBuiltInParser({ manifest, run, retrievals, parserConfig }) {
  const definition = REGISTRY.get(registryKey(manifest));
  if (!definition) {
    fail('request.manifest', `unsupported built-in parser identity ${manifest.pluginId}/${manifest.parserName}`);
  }
  assertManifestCompatibility(manifest, definition);
  const config = definition.configKind === 'board'
    ? validateBoardConfig(parserConfig)
    : validateFundingFeedConfig(parserConfig);
  if (!Array.isArray(retrievals) || retrievals.length !== 1) {
    fail('request.retrievals', 'built-in parsers require exactly one retrieval envelope');
  }
  const retrieval = retrievals[0];
  const document = decodeJsonRetrieval(retrieval);
  const facts = definition.parse(document, config, retrieval);
  if (!Array.isArray(facts)) fail('parser.output', 'must be an array');
  if (facts.length > config.maxItems) fail('parser.output', `exceeds parserConfig.maxItems (${config.maxItems})`);
  const observations = facts.map((fact, index) => createObservation({
    fact,
    index,
    definition,
    manifest,
    run,
    retrieval,
    config
  }));
  observations.sort((left, right) => {
    const identity = left.sourceFingerprint.localeCompare(right.sourceFingerprint);
    return identity || left.observationFingerprint.localeCompare(right.observationFingerprint);
  });
  return observations;
}

function listBuiltInParsers() {
  return DEFINITIONS.map(({ pluginId, parserName, parserVersion, strategyKind, configKind }) => ({
    pluginId, parserName, parserVersion, strategyKind, configKind
  }));
}

function assertManifestCompatibility(manifest, definition) {
  if (manifest.parserVersion !== definition.parserVersion) {
    fail('request.manifest.parserVersion', `unsupported revision for ${definition.parserName}`);
  }
  if (manifest.strategyKind !== definition.strategyKind) {
    fail('request.manifest.strategyKind', `must equal ${definition.strategyKind} for ${definition.parserName}`);
  }
  if (manifest.inputSchemaId !== INPUT_SCHEMA_ID) {
    fail('request.manifest.inputSchemaId', `must equal ${INPUT_SCHEMA_ID}`);
  }
  if (manifest.outputSchemaId !== OUTPUT_SCHEMA_ID) {
    fail('request.manifest.outputSchemaId', `must equal ${OUTPUT_SCHEMA_ID}`);
  }
  const capabilities = [...manifest.capabilities].sort();
  if (stableJson(capabilities) !== stableJson(['fetch', 'parse'])) {
    fail('request.manifest.capabilities', 'built-in parsers require exactly fetch and parse');
  }
}

function validateBoardConfig(value) {
  shape(value, ['companyName', 'boardKey', 'maxItems'], [], 'request.input.parserConfig');
  const companyName = cleanRequiredText(value.companyName, 'request.input.parserConfig.companyName', 500);
  const boardKey = cleanRequiredText(value.boardKey, 'request.input.parserConfig.boardKey', 200);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/.test(boardKey)) {
    fail('request.input.parserConfig.boardKey', 'has an invalid board key format');
  }
  integer(value.maxItems, 'request.input.parserConfig.maxItems', 1, MAX_ITEMS);
  return Object.freeze({ companyName, boardKey, maxItems: value.maxItems });
}

function validateFundingFeedConfig(value) {
  shape(value, ['feedName', 'maxItems'], [], 'request.input.parserConfig');
  const feedName = cleanRequiredText(value.feedName, 'request.input.parserConfig.feedName', 200);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/.test(feedName)) {
    fail('request.input.parserConfig.feedName', 'has an invalid feed name format');
  }
  integer(value.maxItems, 'request.input.parserConfig.maxItems', 1, MAX_ITEMS);
  return Object.freeze({ feedName, maxItems: value.maxItems });
}

function decodeJsonRetrieval(retrieval) {
  if (retrieval.method !== 'GET') fail('request.retrievals[0].method', 'built-in parsers require GET');
  if (retrieval.status !== 200) fail('request.retrievals[0].status', 'built-in parsers require HTTP 200');
  const declared = String(retrieval.headers.contentType || '').split(';', 1)[0].trim().toLowerCase();
  if (!JSON_CONTENT_TYPES.has(declared) && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(declared)) {
    fail('request.retrievals[0].headers.contentType', 'must declare a JSON media type');
  }
  const body = Buffer.from(retrieval.bodyBase64, 'base64');
  if (body.length === 0) fail('request.retrievals[0].bodyBase64', 'JSON body must not be empty');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    fail('request.retrievals[0].bodyBase64', 'body must be valid UTF-8 JSON');
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    fail('request.retrievals[0].bodyBase64', 'body must contain one valid JSON value');
  }
  validateJsonValue(document, 'request.retrievals[0].json');
  return document;
}

function parseAshby(document, config) {
  shape(document, ['apiVersion', 'jobs'], [], 'ashby');
  literal(document.apiVersion, '1', 'ashby.apiVersion');
  boundedArray(document.jobs, 'ashby.jobs', config.maxItems);
  const facts = [];
  document.jobs.forEach((job, index) => {
    const path = `ashby.jobs[${index}]`;
    shape(job, ['id', 'title', 'location', 'workplaceType', 'employmentType', 'publishedAt', 'isListed', 'jobUrl'], [
      'department', 'team', 'descriptionHtml', 'descriptionPlain', 'applyUrl', 'secondaryLocations',
      'compensation', 'shouldDisplayCompensationOnJobPostings', 'address', 'jobPostingMetadata'
    ], path);
    const id = scalarId(job.id, `${path}.id`);
    const title = cleanRequiredText(job.title, `${path}.title`, 1000);
    const canonicalUrl = providerUrl(job.jobUrl, `${path}.jobUrl`, 'ashbyhq.com');
    nullableText(job.location, `${path}.location`, 2000);
    nullableText(job.workplaceType, `${path}.workplaceType`, 100);
    nullableText(job.employmentType, `${path}.employmentType`, 100);
    nullableTimestamp(job.publishedAt, `${path}.publishedAt`);
    if (typeof job.isListed !== 'boolean') fail(`${path}.isListed`, 'must be a boolean');
    optionalNullableText(job, 'department', path, 500);
    optionalNullableText(job, 'team', path, 500);
    optionalNullableText(job, 'descriptionHtml', path, MAX_TEXT);
    optionalNullableText(job, 'descriptionPlain', path, MAX_TEXT);
    optionalHttpsUrl(job, 'applyUrl', path);
    optionalJsonArray(job, 'secondaryLocations', path, 100);
    optionalJsonValue(job, 'compensation', path);
    optionalBoolean(job, 'shouldDisplayCompensationOnJobPostings', path);
    optionalJsonValue(job, 'address', path);
    optionalJsonValue(job, 'jobPostingMetadata', path);
    if (!job.isListed) return;
    const descriptionText = choosePlainOrHtml(job.descriptionPlain, job.descriptionHtml, `${path}.description`);
    const secondaryLocations = normalizeAshbySecondaryLocations(job.secondaryLocations, `${path}.secondaryLocations`);
    facts.push({
      candidateKind: 'job-posting',
      companyName: config.companyName,
      title,
      canonicalUrl,
      provider: 'ashby',
      boardKey: config.boardKey,
      externalId: id,
      locationText: joinUnique([cleanNullable(job.location), ...secondaryLocations]),
      workplaceType: normalizeWorkplaceType(job.workplaceType),
      employmentType: normalizeEmploymentType(job.employmentType),
      postedAt: job.publishedAt,
      descriptionText,
      attributes: compactObject({
        companyNameBasis: 'parser-config',
        department: cleanNullable(job.department),
        team: cleanNullable(job.team),
        applyUrl: cleanNullable(job.applyUrl),
        workplaceTypeRaw: cleanNullable(job.workplaceType),
        employmentTypeRaw: cleanNullable(job.employmentType)
      })
    });
  });
  return facts;
}

function parseGreenhouse(document, config) {
  shape(document, ['jobs'], ['meta'], 'greenhouse');
  boundedArray(document.jobs, 'greenhouse.jobs', config.maxItems);
  if (Object.prototype.hasOwnProperty.call(document, 'meta')) {
    shape(document.meta, ['total'], [], 'greenhouse.meta');
    integer(document.meta.total, 'greenhouse.meta.total', 0, Number.MAX_SAFE_INTEGER);
    if (document.meta.total < document.jobs.length) fail('greenhouse.meta.total', 'must not be less than jobs.length');
  }
  return document.jobs.map((job, index) => {
    const path = `greenhouse.jobs[${index}]`;
    shape(job, ['id', 'title', 'absolute_url', 'location', 'updated_at', 'content'], [
      'internal_job_id', 'requisition_id', 'departments', 'offices', 'metadata', 'data_compliance',
      'education', 'company_name', 'first_published', 'language'
    ], path);
    const id = scalarId(job.id, `${path}.id`);
    const title = cleanRequiredText(job.title, `${path}.title`, 1000);
    const canonicalUrl = providerUrl(job.absolute_url, `${path}.absolute_url`, 'greenhouse.io');
    shape(job.location, ['name'], [], `${path}.location`);
    nullableText(job.location.name, `${path}.location.name`, 2000);
    nullableTimestamp(job.updated_at, `${path}.updated_at`);
    nullableText(job.content, `${path}.content`, MAX_TEXT);
    optionalScalarId(job, 'internal_job_id', path);
    optionalNullableText(job, 'requisition_id', path, 1000);
    optionalNamedCollections(job, 'departments', path);
    optionalNamedCollections(job, 'offices', path);
    optionalJsonValue(job, 'metadata', path);
    optionalJsonValue(job, 'data_compliance', path);
    optionalNullableText(job, 'education', path, 500);
    optionalNullableText(job, 'company_name', path, 500);
    optionalNullableTimestamp(job, 'first_published', path);
    optionalNullableText(job, 'language', path, 100);
    if (job.company_name !== undefined && job.company_name !== null
        && normalizedComparison(job.company_name) !== normalizedComparison(config.companyName)) {
      fail(`${path}.company_name`, 'does not match parserConfig.companyName');
    }
    const firstPublished = cleanNullable(job.first_published);
    return {
      candidateKind: 'job-posting',
      companyName: config.companyName,
      title,
      canonicalUrl,
      provider: 'greenhouse',
      boardKey: config.boardKey,
      externalId: id,
      locationText: cleanNullable(job.location.name),
      workplaceType: null,
      employmentType: null,
      postedAt: firstPublished,
      descriptionText: htmlToText(job.content || '', `${path}.content`),
      attributes: compactObject({
        companyNameBasis: job.company_name ? 'retrieval' : 'parser-config',
        requisitionId: cleanNullable(job.requisition_id),
        internalJobId: job.internal_job_id === undefined || job.internal_job_id === null ? null : String(job.internal_job_id),
        updatedAt: cleanNullable(job.updated_at),
        departments: namesFromCollections(job.departments),
        offices: namesFromCollections(job.offices)
      })
    };
  });
}

function parseLever(document, config) {
  boundedArray(document, 'lever', config.maxItems);
  return document.map((job, index) => {
    const path = `lever[${index}]`;
    shape(job, ['id', 'text', 'categories', 'hostedUrl', 'createdAt'], [
      'description', 'descriptionPlain', 'descriptionBody', 'descriptionBodyPlain', 'opening', 'openingPlain',
      'lists', 'additional', 'additionalPlain', 'applyUrl', 'workplaceType', 'country', 'salaryRange',
      'salaryDescription', 'salaryDescriptionPlain'
    ], path);
    const id = scalarId(job.id, `${path}.id`);
    const title = cleanRequiredText(job.text, `${path}.text`, 1000);
    const canonicalUrl = providerUrl(job.hostedUrl, `${path}.hostedUrl`, 'lever.co');
    shape(job.categories, [], ['commitment', 'department', 'location', 'team', 'allLocations'], `${path}.categories`);
    for (const key of ['commitment', 'department', 'location', 'team']) {
      optionalNullableText(job.categories, key, `${path}.categories`, 2000);
    }
    if (Object.prototype.hasOwnProperty.call(job.categories, 'allLocations')) {
      boundedArray(job.categories.allLocations, `${path}.categories.allLocations`, 100);
      job.categories.allLocations.forEach((item, itemIndex) => nullableText(item, `${path}.categories.allLocations[${itemIndex}]`, 2000));
    }
    integer(job.createdAt, `${path}.createdAt`, 0, 8_640_000_000_000_000);
    for (const key of ['description', 'descriptionPlain', 'descriptionBody', 'descriptionBodyPlain', 'opening', 'openingPlain', 'additional', 'additionalPlain', 'salaryDescription', 'salaryDescriptionPlain']) {
      optionalNullableText(job, key, path, MAX_TEXT);
    }
    optionalHttpsUrl(job, 'applyUrl', path);
    optionalNullableText(job, 'workplaceType', path, 100);
    optionalNullableText(job, 'country', path, 200);
    optionalJsonValue(job, 'salaryRange', path);
    if (Object.prototype.hasOwnProperty.call(job, 'lists')) {
      boundedArray(job.lists, `${path}.lists`, 100);
      job.lists.forEach((list, listIndex) => {
        shape(list, ['text', 'content'], [], `${path}.lists[${listIndex}]`);
        nullableText(list.text, `${path}.lists[${listIndex}].text`, 1000);
        nullableText(list.content, `${path}.lists[${listIndex}].content`, MAX_TEXT);
      });
    }
    const descriptionText = joinSections([
      choosePlainOrHtml(job.openingPlain, job.opening, `${path}.opening`),
      choosePlainOrHtml(job.descriptionPlain, job.description, `${path}.description`),
      choosePlainOrHtml(job.descriptionBodyPlain, job.descriptionBody, `${path}.descriptionBody`),
      ...(job.lists || []).map((list, listIndex) => joinSections([
        normalizePlainText(list.text || '', `${path}.lists[${listIndex}].text`),
        htmlToText(list.content || '', `${path}.lists[${listIndex}].content`)
      ])),
      choosePlainOrHtml(job.additionalPlain, job.additional, `${path}.additional`)
    ]);
    return {
      candidateKind: 'job-posting',
      companyName: config.companyName,
      title,
      canonicalUrl,
      provider: 'lever',
      boardKey: config.boardKey,
      externalId: id,
      locationText: joinUnique([
        cleanNullable(job.categories.location),
        ...(job.categories.allLocations || []).map(cleanNullable)
      ]),
      workplaceType: normalizeWorkplaceType(job.workplaceType),
      employmentType: normalizeEmploymentType(job.categories.commitment),
      postedAt: new Date(job.createdAt).toISOString(),
      descriptionText,
      attributes: compactObject({
        companyNameBasis: 'parser-config',
        department: cleanNullable(job.categories.department),
        team: cleanNullable(job.categories.team),
        country: cleanNullable(job.country),
        applyUrl: cleanNullable(job.applyUrl),
        workplaceTypeRaw: cleanNullable(job.workplaceType),
        employmentTypeRaw: cleanNullable(job.categories.commitment)
      })
    };
  });
}

function parseFundingJsonFeed(document, config) {
  shape(document, ['version', 'title', 'items'], [
    'home_page_url', 'feed_url', 'description', 'user_comment', 'next_url', 'icon', 'favicon',
    'authors', 'language', 'expired', 'hubs'
  ], 'fundingFeed');
  if (!['https://jsonfeed.org/version/1', 'https://jsonfeed.org/version/1.1'].includes(document.version)) {
    fail('fundingFeed.version', 'must be JSON Feed version 1 or 1.1');
  }
  cleanRequiredText(document.title, 'fundingFeed.title', 1000);
  for (const key of ['home_page_url', 'feed_url', 'next_url', 'icon', 'favicon']) optionalHttpsUrl(document, key, 'fundingFeed');
  for (const key of ['description', 'user_comment', 'language']) optionalNullableText(document, key, 'fundingFeed', MAX_SHORT_TEXT);
  optionalBoolean(document, 'expired', 'fundingFeed');
  optionalJsonValue(document, 'authors', 'fundingFeed');
  optionalJsonValue(document, 'hubs', 'fundingFeed');
  boundedArray(document.items, 'fundingFeed.items', config.maxItems);
  return document.items.map((item, index) => {
    const path = `fundingFeed.items[${index}]`;
    shape(item, ['id', 'url', 'title', 'date_published', '_jobtrack_funding'], [
      'external_url', 'content_text', 'content_html', 'summary', 'date_modified', 'authors', 'tags',
      'language', 'image', 'banner_image', 'attachments'
    ], path);
    const id = scalarId(item.id, `${path}.id`);
    const canonicalUrl = httpsUrl(item.url, `${path}.url`);
    const title = cleanRequiredText(item.title, `${path}.title`, 1000);
    timestamp(item.date_published, `${path}.date_published`);
    optionalHttpsUrl(item, 'external_url', path);
    optionalNullableText(item, 'content_text', path, MAX_TEXT);
    optionalNullableText(item, 'content_html', path, MAX_TEXT);
    optionalNullableText(item, 'summary', path, MAX_TEXT);
    optionalNullableTimestamp(item, 'date_modified', path);
    for (const key of ['authors', 'tags', 'attachments']) optionalJsonValue(item, key, path);
    optionalNullableText(item, 'language', path, 100);
    optionalHttpsUrl(item, 'image', path);
    optionalHttpsUrl(item, 'banner_image', path);
    shape(item._jobtrack_funding, ['company_name'], ['round', 'amount', 'careers_url'], `${path}._jobtrack_funding`);
    const companyName = cleanRequiredText(item._jobtrack_funding.company_name, `${path}._jobtrack_funding.company_name`, 500);
    optionalNullableText(item._jobtrack_funding, 'round', `${path}._jobtrack_funding`, 200);
    optionalNullableText(item._jobtrack_funding, 'amount', `${path}._jobtrack_funding`, 200);
    optionalHttpsUrl(item._jobtrack_funding, 'careers_url', `${path}._jobtrack_funding`);
    const descriptionText = joinSections([
      item.content_text !== undefined && item.content_text !== null
        ? normalizePlainText(item.content_text, `${path}.content_text`)
        : htmlToText(item.content_html || '', `${path}.content_html`),
      normalizePlainText(item.summary || '', `${path}.summary`)
    ]);
    return {
      candidateKind: 'funding-signal',
      companyName,
      title,
      canonicalUrl,
      provider: 'funding-feed',
      boardKey: config.feedName,
      externalId: id,
      locationText: null,
      workplaceType: null,
      employmentType: null,
      postedAt: item.date_published,
      descriptionText,
      attributes: compactObject({
        feedName: config.feedName,
        feedTitle: document.title,
        round: cleanNullable(item._jobtrack_funding.round),
        amount: cleanNullable(item._jobtrack_funding.amount),
        careersUrl: cleanNullable(item._jobtrack_funding.careers_url),
        externalUrl: cleanNullable(item.external_url),
        dateModified: cleanNullable(item.date_modified)
      })
    };
  });
}

function createObservation({ fact, index, definition, manifest, run, retrieval, config }) {
  const identity = {
    parser: definition.parserName,
    sourceKey: run.sourceKey,
    externalId: fact.externalId,
    canonicalUrl: fact.canonicalUrl
  };
  const observation = withObservationFingerprints({
    schemaVersion: 1,
    kind: 'candidate-observation',
    observationId: `obs-${digest(stableJson(identity)).slice(0, 40)}`,
    candidateKind: fact.candidateKind,
    sourceKey: run.sourceKey,
    observedAt: retrieval.fetchedAt,
    companyName: fact.companyName,
    title: fact.title,
    canonicalUrl: fact.canonicalUrl,
    provider: fact.provider,
    boardKey: fact.boardKey,
    externalId: fact.externalId,
    locationText: fact.locationText,
    workplaceType: fact.workplaceType,
    employmentType: fact.employmentType,
    postedAt: fact.postedAt,
    descriptionText: fact.descriptionText,
    attributes: {
      ...fact.attributes,
      parserConfig: config
    },
    parser: { name: manifest.parserName, version: manifest.parserVersion },
    evidence: [{
      evidenceKind: 'retrieval',
      requestId: retrieval.requestId,
      url: retrieval.finalUrl,
      bodySha256: retrieval.bodySha256,
      capturedAt: retrieval.fetchedAt,
      label: `${definition.parserName} public JSON retrieval`
    }]
  });
  return validateCandidateObservation(observation, `parser.observations[${index}]`);
}

function choosePlainOrHtml(plain, html, path) {
  if (plain !== undefined && plain !== null && String(plain).trim()) return normalizePlainText(plain, `${path}.plain`);
  return htmlToText(html || '', `${path}.html`);
}

function htmlToText(value, path = 'html') {
  if (typeof value !== 'string') fail(path, 'must be a string');
  if (value.length > MAX_TEXT) fail(path, `length must be at most ${MAX_TEXT}`);
  let text = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const decoded = decodeHtmlEntities(text);
    if (decoded === text) break;
    text = decoded;
  }
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|template|noscript|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  text = text.replace(/<(br|hr)\b[^>]*\/?\s*>/gi, '\n');
  text = text.replace(/<\/?(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|ul|ol|li|dl|dt|dd|pre|blockquote|table|thead|tbody|tfoot|tr|caption)\b[^>]*>/gi, '\n');
  text = text.replace(/<\/?(?:td|th)\b[^>]*>/gi, '\t');
  text = text.replace(/<[^>]*>/g, ' ');
  return normalizePlainText(text, path);
}

function decodeHtmlEntities(value) {
  const named = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
    ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', bull: '\u2022',
    rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c'
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return Object.prototype.hasOwnProperty.call(named, entity.toLowerCase()) ? named[entity.toLowerCase()] : match;
    const hex = entity[1].toLowerCase() === 'x';
    const number = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isInteger(number) || number < 1 || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(number);
  });
}

function normalizePlainText(value, path = 'text') {
  if (typeof value !== 'string') fail(path, 'must be a string');
  if (value.length > MAX_TEXT) fail(path, `length must be at most ${MAX_TEXT}`);
  const lines = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[\t \f\v]+/g, ' ').trim());
  const output = [];
  for (const line of lines) {
    if (line || (output.length && output[output.length - 1] !== '')) output.push(line);
  }
  while (output[0] === '') output.shift();
  while (output[output.length - 1] === '') output.pop();
  const result = output.join('\n');
  if (result.length > MAX_TEXT) fail(path, `normalized text exceeds ${MAX_TEXT} characters`);
  return result || null;
}

function joinSections(sections) {
  const unique = [];
  const seen = new Set();
  for (const section of sections) {
    if (!section) continue;
    const normalized = String(section).trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  const result = unique.join('\n\n');
  if (result.length > MAX_TEXT) fail('parser.descriptionText', `combined text exceeds ${MAX_TEXT} characters`);
  return result || null;
}

function normalizeAshbySecondaryLocations(value, path) {
  if (value === undefined || value === null) return [];
  return value.map((entry, index) => {
    if (typeof entry === 'string') return cleanNullable(entry);
    shape(entry, ['location'], [], `${path}[${index}]`);
    nullableText(entry.location, `${path}[${index}].location`, 2000);
    return cleanNullable(entry.location);
  }).filter(Boolean);
}

function optionalNamedCollections(object, key, path) {
  if (!Object.prototype.hasOwnProperty.call(object, key) || object[key] === null) return;
  boundedArray(object[key], `${path}.${key}`, 100);
  object[key].forEach((entry, index) => {
    shape(entry, ['id', 'name'], ['child_ids', 'parent_id'], `${path}.${key}[${index}]`);
    scalarId(entry.id, `${path}.${key}[${index}].id`);
    cleanRequiredText(entry.name, `${path}.${key}[${index}].name`, 500);
    optionalJsonValue(entry, 'child_ids', `${path}.${key}[${index}]`);
    optionalJsonValue(entry, 'parent_id', `${path}.${key}[${index}]`);
  });
}

function namesFromCollections(value) {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => cleanNullable(item.name)).filter(Boolean);
}

function normalizeWorkplaceType(value) {
  const normalized = normalizedComparison(value || '');
  if (['remote', 'remote only'].includes(normalized)) return 'remote';
  if (['hybrid', 'flexible'].includes(normalized)) return 'hybrid';
  if (['onsite', 'on site', 'on-site', 'in office'].includes(normalized)) return 'onsite';
  return null;
}

function normalizeEmploymentType(value) {
  const normalized = normalizedComparison(value || '').replace(/[_-]+/g, ' ');
  const compact = normalized.replace(/\s+/g, '');
  if (['fulltime', 'permanent'].includes(compact)) return 'full-time';
  if (compact === 'parttime') return 'part-time';
  if (['contract', 'contractor', 'temporary', 'intern', 'internship'].includes(compact)) return compact === 'internship' ? 'intern' : compact;
  return null;
}

function joinUnique(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (!value) continue;
    const key = normalizedComparison(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result.length ? result.join('; ') : null;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function shape(value, required, optional, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) fail(path, `missing fields: ${missing.join(', ')}`);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) fail(path, `unknown fields: ${extra.sort().join(', ')}`);
}

function boundedArray(value, path, max) {
  if (!Array.isArray(value) || value.length > max) fail(path, `must be an array with at most ${max} items`);
}

function scalarId(value, path) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length < 1 || String(value).length > 1000) {
    fail(path, 'must be a non-empty string or number of at most 1000 characters');
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail(path, 'numeric identifiers must be safe integers');
  return String(value);
}

function cleanRequiredText(value, path, max) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(path, `must be trimmed text of length 1..${max} without control characters`);
  }
  return value;
}

function nullableText(value, path, max) {
  if (value === null) return;
  if (typeof value !== 'string' || value.length > max) fail(path, `must be null or a string of at most ${max} characters`);
}

function optionalNullableText(object, key, path, max) {
  if (!Object.prototype.hasOwnProperty.call(object, key)) return;
  nullableText(object[key], `${path}.${key}`, max);
}

function optionalScalarId(object, key, path) {
  if (!Object.prototype.hasOwnProperty.call(object, key) || object[key] === null) return;
  scalarId(object[key], `${path}.${key}`);
}

function optionalBoolean(object, key, path) {
  if (!Object.prototype.hasOwnProperty.call(object, key)) return;
  if (typeof object[key] !== 'boolean') fail(`${path}.${key}`, 'must be a boolean');
}

function optionalJsonArray(object, key, path, max) {
  if (!Object.prototype.hasOwnProperty.call(object, key) || object[key] === null) return;
  boundedArray(object[key], `${path}.${key}`, max);
}

function optionalJsonValue(object, key, path) {
  if (!Object.prototype.hasOwnProperty.call(object, key)) return;
  validateJsonValue(object[key], `${path}.${key}`);
}

function optionalHttpsUrl(object, key, path) {
  if (!Object.prototype.hasOwnProperty.call(object, key) || object[key] === null) return;
  httpsUrl(object[key], `${path}.${key}`);
}

function optionalNullableTimestamp(object, key, path) {
  if (!Object.prototype.hasOwnProperty.call(object, key)) return;
  nullableTimestamp(object[key], `${path}.${key}`);
}

function httpsUrl(value, path) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16_384) fail(path, 'must be an HTTPS URL');
  let parsed;
  try { parsed = new URL(value); } catch { fail(path, 'must be a valid URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== '443')) {
    fail(path, 'must be a credential-free HTTPS URL on port 443 with no fragment');
  }
  return parsed.href;
}

function providerUrl(value, path, providerSuffix) {
  const normalized = httpsUrl(value, path);
  const host = new URL(normalized).hostname.toLowerCase().replace(/\.$/, '');
  if (host !== providerSuffix && !host.endsWith(`.${providerSuffix}`)) {
    fail(path, `must use ${providerSuffix}`);
  }
  return normalized;
}

function timestamp(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
    fail(path, 'must be an ISO-8601 timestamp');
  }
}

function nullableTimestamp(value, path) {
  if (value === null) return;
  timestamp(value, path);
}

function integer(value, path, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(path, `must be an integer from ${min} to ${max}`);
}

function literal(value, expected, path) {
  if (value !== expected) fail(path, `must equal ${JSON.stringify(expected)}`);
}

function cleanNullable(value) {
  if (typeof value !== 'string') return value === null || value === undefined ? null : String(value);
  const normalized = value.trim();
  return normalized || null;
}

function normalizedComparison(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function registryKey(value) {
  return `${value.pluginId}\u0000${value.parserName}`;
}

function fail(path, message) {
  throw new ContractError(path, message);
}

module.exports = {
  INPUT_SCHEMA_ID,
  OUTPUT_SCHEMA_ID,
  WORK_REQUEST_SCHEMA_VERSION,
  executeBuiltInParser,
  htmlToText,
  listBuiltInParsers,
  validateBoardConfig,
  validateFundingFeedConfig
};
