'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { freePort } = require('../test-support/free-port');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('v0.4 web composes exact facets, unified pipeline, profile stories, gaps, and read-only security', async (t) => {
  const { root: fixtureRoot, home } = require('../test-support/migrated-store').createTestStore('jobtrack-web-v04-');
  const tmp = path.join(fixtureRoot, 'tmp');
  fs.mkdirSync(tmp);
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  runCli(home, ['discovery', 'source', 'add', '--key', 'v04-manual', '--adapter', 'manual', '--label', 'V04 test', '--policy-state', 'allowed']);
  const alpha = ingest(home, 'Alpha Systems', 'Senior Platform Engineer', 'alpha-1');
  const beta = ingest(home, 'Beta Labs', 'Junior Frontend Engineer', 'beta-1');

  runCli(home, ['catalog', 'role-type', 'assign', '--opening-id', alpha.opportunity.job_opening_id, '--role-type', 'platform', '--primary', '--source', 'test']);
  runCli(home, ['catalog', 'seniority', 'assign', '--opening-id', alpha.opportunity.job_opening_id, '--seniority', 'senior', '--primary', '--source', 'test']);
  runCli(home, ['catalog', 'role-type', 'assign', '--opening-id', beta.opportunity.job_opening_id, '--role-type', 'frontend', '--primary', '--source', 'test']);
  runCli(home, ['catalog', 'seniority', 'assign', '--opening-id', beta.opportunity.job_opening_id, '--seniority', 'junior', '--primary', '--source', 'test']);
  runCli(home, ['tag', 'assign', '--opportunity-id', alpha.opportunityId, '--tag', 'Remote', '--source', 'test']);
  runCli(home, ['tag', 'assign', '--opportunity-id', alpha.opportunityId, '--tag', 'Systems', '--source', 'test']);
  runCli(home, ['tag', 'assign', '--opportunity-id', beta.opportunityId, '--tag', 'Remote', '--source', 'test']);
  runCli(home, ['tag', 'assign', '--opportunity-id', beta.opportunityId, '--tag', 'Startup', '--source', 'test']);

  const promoted = runCli(home, ['opportunity', 'promote', '--opportunity-id', alpha.opportunityId]);
  const applicationId = promoted.application.id;
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.pragma('foreign_keys = ON');
  db.prepare("INSERT INTO offers(application_id,details,outcome) VALUES (?,'test offer','accepted')").run(applicationId);
  const proposalId = insertDiscoveryProposal(db, 'Gamma Newco', 'Staff Infrastructure Engineer');
  const proposalVariantId = insertDiscoveryProposal(db, ' gamma newco ', 'Backend Reliability Engineer');
  db.close();

  runCli(home, ['tag', 'assign', '--proposal-id', proposalId, '--tag', 'Remote', '--source', 'test']);
  runCli(home, ['tag', 'assign', '--proposal-id', proposalVariantId, '--tag', 'Remote', '--source', 'test']);
  const informationRequest = runCli(home, [
    'profile', 'info-request', 'mark', '--application-id', applicationId,
    '--field', 'security-clearance', '--requiredness', 'required',
    '--requested-label', 'Active security clearance', '--source', 'test',
    '--idempotency-key', 'web-v04-gap-request'
  ]);
  runCli(home, [
    'profile', 'info-request', 'assess', '--application-id', applicationId,
    '--request-id', informationRequest.request.id, '--state', 'confirmed_missing', '--assessed-by', 'test',
    '--expected-assessment-id', 'none',
    '--rationale', 'Profile has no clearance evidence.', '--evidence', 'Reviewed normalized profile.',
    '--idempotency-key', 'web-v04-gap-assessment'
  ]);
  const opportunityInformationRequest = runCli(home, [
    'profile', 'info-request', 'mark', '--opportunity-id', beta.opportunityId,
    '--field', 'portfolio-url', '--requested-label', 'Portfolio URL', '--source', 'test',
    '--idempotency-key', 'web-v04-opportunity-gap-request'
  ]);
  runCli(home, [
    'profile', 'info-request', 'assess', '--opportunity-id', beta.opportunityId,
    '--request-id', opportunityInformationRequest.request.id, '--state', 'confirmed_missing', '--assessed-by', 'test',
    '--expected-assessment-id', 'none', '--rationale', 'Profile has no portfolio URL.',
    '--idempotency-key', 'web-v04-opportunity-gap-assessment'
  ]);
  runCli(home, [
    'log-interview', '--application-id', applicationId, '--round-type', 'technical-screen',
    '--scheduled-at', '2026-08-01T17:00:00-07:00', '--timezone', 'America/Los_Angeles', '--format', 'video'
  ]);
  runCli(home, ['story', 'capture', '--title', 'Recovered a launch', '--raw', 'private raw narrative', '--source', 'test', '--tags', 'leadership,obsolete-web', '--idempotency-key', 'web-v04-story']);
  runCli(home, ['story', 'polish', '--story-id', '1', '--expected-version', '0', '--canonical', 'Recovered a launch without losing customer data.', '--summary', 'Recovered a launch', '--takeaway', 'Calm execution matters.', '--status', 'ready', '--authored-by', 'test', '--idempotency-key', 'web-v04-story-polish']);
  runCli(home, ['profile', 'set-contact', '--name', 'Private Person', '--email', 'private@example.test', '--work-authorization', 'Authorized', '--tags', 'secret-contact']);
  const taxonomyDb = new Database(path.join(home, 'jobtrack.db'));
  const deprecatedStatus = taxonomyDb.prepare("SELECT id FROM tag_lifecycle_statuses WHERE slug='deprecated'").get();
  const obsoleteTag = taxonomyDb.prepare("SELECT id FROM tags WHERE normalized_label='obsolete-web'").get();
  assert.ok(deprecatedStatus && obsoleteTag, 'deprecated-tag fixture must resolve normalized taxonomy rows');
  taxonomyDb.prepare('UPDATE tags SET status_id=? WHERE id=?').run(deprecatedStatus.id, obsoleteTag.id);
  taxonomyDb.close();

  const ids = readFacetIds(home);
  instance = await startServer(home, tmp);

  const homePage = await request(`${instance.baseUrl}/`);
  assert.equal(homePage.status, 200, homePage.text);
  assert.match(homePage.text, /complete application graph/);
  assert.equal(count(homePage.text, /<td data-label="Company"><strong>Alpha Systems<\/strong>/g), 1, 'promoted source opportunity must render once');
  assert.equal(count(homePage.text, /<td data-label="Company"><strong>Beta Labs<\/strong>/g), 1);
  assert.match(homePage.text, /Profile information blocker/);
  assert.match(homePage.text, /Profile information gap · 1 confirmed missing field\(s\) · 1 priority unclassified/);
  assert.doesNotMatch(homePage.text, /0 optional\/preferred field/);
  assert.match(homePage.headers.get('content-security-policy') || '', /form-action 'self'/);
  assert.doesNotMatch(homePage.headers.get('content-security-policy') || '', /form-action 'none'/);

  const accepted = await request(`${instance.baseUrl}/?status=accepted`);
  assert.match(accepted.text, /Alpha Systems/);
  assert.doesNotMatch(accepted.text, /<td data-label="Company"><strong>Beta Labs/);
  const opportunityOnly = await request(`${instance.baseUrl}/?status=opportunity`);
  assert.match(opportunityOnly.text, /Beta Labs/);
  assert.doesNotMatch(opportunityOnly.text, /<td data-label="Company"><strong>Alpha Systems/);

  const composedUrl = new URL('/applications', instance.baseUrl);
  composedUrl.searchParams.set('company', String(ids.alphaCompany));
  composedUrl.searchParams.set('role_type', String(ids.platformRole));
  composedUrl.searchParams.set('seniority', String(ids.seniorLevel));
  composedUrl.searchParams.append('tag', String(ids.remoteTag));
  composedUrl.searchParams.append('tag', String(ids.systemsTag));
  composedUrl.searchParams.set('status', 'accepted');
  const applications = await request(composedUrl);
  assert.equal(applications.status, 200, applications.text);
  assert.match(applications.text, /Alpha Systems/);
  assert.match(applications.text, /Tag: Remote/);
  assert.match(applications.text, /Tag: Systems/);
  assert.match(applications.text, new RegExp(`company=${ids.alphaCompany}`));
  assert.equal(count(applications.text, new RegExp(`tag=${ids.remoteTag}`, 'g')) > 0, true);
  assert.equal(count(applications.text, new RegExp(`tag=${ids.systemsTag}`, 'g')) > 0, true);

  const impossibleAnd = await request(`${instance.baseUrl}/applications?tag=${ids.systemsTag}&tag=${ids.startupTag}`);
  assert.doesNotMatch(impossibleAnd.text, /<td data-label="Company"><strong>Alpha Systems/);
  assert.equal((await request(`${instance.baseUrl}/applications?company=999999`)).status, 400);
  assert.equal((await request(`${instance.baseUrl}/applications?q=${'x'.repeat(161)}`)).status, 400);
  assert.equal((await request(`${instance.baseUrl}/applications?tag=${ids.remoteTag}&tag=${ids.remoteTag}`)).status, 200, 'duplicate exact tags are idempotent');

  const opening = await request(`${instance.baseUrl}/openings?company=${ids.alphaCompany}&role_type=${ids.platformRole}&seniority=${ids.seniorLevel}&tag=${ids.remoteTag}`);
  assert.match(opening.text, /Senior Platform Engineer/);
  assert.doesNotMatch(opening.text, /Junior Frontend Engineer/);
  const opportunities = await request(`${instance.baseUrl}/opportunities?company=${ids.betaCompany}&role_type=${ids.frontendRole}&seniority=${ids.juniorLevel}&tag=${ids.startupTag}`);
  assert.match(opportunities.text, /Junior Frontend Engineer/);
  assert.doesNotMatch(opportunities.text, /Senior Platform Engineer/);
  const interviews = await request(`${instance.baseUrl}/interviews?company=${ids.alphaCompany}&role_type=${ids.platformRole}&tag=${ids.remoteTag}`);
  assert.match(interviews.text, /technical screen interview/i);

  const proposalCompanyValue = `proposal:${digest('gamma newco')}`;
  const discovery = await request(`${instance.baseUrl}/discovery-proposals?company=${proposalCompanyValue}&tag=${ids.remoteTag}&role_type=unclassified&seniority=unclassified`);
  assert.equal(discovery.status, 200, discovery.text);
  assert.match(discovery.text, /Staff Infrastructure Engineer/);
  assert.match(discovery.text, /Backend Reliability Engineer/);
  assert.match(discovery.text, /Gamma Newco/);
  assert.equal(count(discovery.text, new RegExp(`value="${proposalCompanyValue}"`, 'g')), 1, 'case and whitespace variants share one stable company facet');

  const profile = await request(`${instance.baseUrl}/profile?tag=${ids.leadershipTag}&status=ready&q=Recovered`);
  assert.equal(profile.status, 200, profile.text);
  assert.match(profile.text, /Profile section tabs/);
  assert.match(profile.text, /profile-tabs/);
  assert.match(profile.text, /id="stories"/);
  assert.match(profile.text, /Recovered a launch/);
  assert.doesNotMatch(profile.text, /private raw narrative/);
  assert.doesNotMatch(profile.text, /obsolete-web/i, 'deprecated normalized tags must not fall back to legacy labels');
  // Full-visibility directive (2026-08-05): sensitive sections render like
  // every other section — expanded, no deliberate-open gate.
  // Marker contract (docs/JOBTRACK_VS_MISSION_CONTROL_UI.md §5): assert the
  // navigable section identity, not the surrounding class/attribute order.
  assert.match(profile.text, /data-jt-section="contact"/);
  assert.match(profile.text, /data-jt-section="references"/);
  assert.match(profile.text, /data-jt-section="eeo"/);
  const profileFilter = profile.text.match(/<form class="filter-panel"[\s\S]*?<\/form>/)?.[0] || '';
  assert.doesNotMatch(profileFilter, /secret-contact/);

  const stories = await request(`${instance.baseUrl}/stories?tag=${ids.leadershipTag}`);
  assert.equal(stories.status, 200);
  assert.match(stories.text, /Recovered a launch/);
  const post = await request(`${instance.baseUrl}/applications`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  assert.match(post.headers.get('content-security-policy') || '', /form-action 'self'/);

  await stopServer(instance);
});

function ingest(home, company, role, externalId) {
  return runCli(home, [
    'opportunity', 'ingest', '--source', 'v04-manual', '--company', company, '--role', role,
    '--url', `https://linkedin.com/jobs/view/${externalId}`, '--provider', 'linkedin', '--external-id', externalId,
    '--description', `${company} ${role}`, '--idempotency-key', `ingest-${externalId}`
  ]);
}

function insertDiscoveryProposal(db, companyName, title) {
  const sha = digest(`${companyName}:${title}`);
  const proposalId = `sha256:${sha}`;
  const now = '2026-07-17T20:00:00.000Z';
  const bundleJson = JSON.stringify({ kind: 'test-bundle', companyName, title });
  const bundleSha = digest(bundleJson);
  const bundle = db.prepare(`
    INSERT INTO discovery_import_bundles(
      bundle_id,content_sha256,manifest_sha256,plugin_id,plugin_version,parser_name,parser_version,
      strategy_kind,run_id,source_key,started_at,completed_at,bundle_json,bundle_bytes,proposal_count,
      new_proposal_count,retrieval_count,imported_by,imported_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(`sha256:${bundleSha}`, bundleSha, digest('manifest'), 'web-v04', '1', 'test', '1', 'direct-board',
    `run-${sha.slice(0, 12)}`, 'web-v04', now, now, bundleJson, Buffer.byteLength(bundleJson), 1, 1, 0, 'test', now);
  const proposalJson = JSON.stringify({
    facts: { candidateKind: 'job-posting', companyName, title, canonicalUrl: 'https://jobs.example.test/gamma' },
    parser: { name: 'test', version: '1' }, evidence: []
  });
  db.prepare(`
    INSERT INTO discovery_import_proposals(
      proposal_id,source_fingerprint,observation_fingerprint,candidate_kind,source_key,
      proposal_json,proposal_sha256,first_bundle_row_id,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run(proposalId, digest(companyName), sha, 'job-posting', 'web-v04', proposalJson, sha, bundle.lastInsertRowid, now);
  return proposalId;
}

function readFacetIds(home) {
  const db = new Database(path.join(home, 'jobtrack.db'), { readonly: true });
  const company = (name) => db.prepare('SELECT id FROM companies WHERE canonical_name=?').get(name).id;
  const role = (slug) => db.prepare('SELECT id FROM role_types WHERE slug=?').get(slug).id;
  const level = (slug) => db.prepare('SELECT id FROM seniority_levels WHERE slug=?').get(slug).id;
  const tag = (label) => db.prepare("SELECT t.id FROM tags t JOIN tag_namespaces n ON n.id=t.tag_namespace_id WHERE n.slug='general' AND lower(t.label)=lower(?)").get(label).id;
  const ids = {
    alphaCompany: company('Alpha Systems'), betaCompany: company('Beta Labs'),
    platformRole: role('platform'), frontendRole: role('frontend'),
    seniorLevel: level('senior'), juniorLevel: level('junior'),
    remoteTag: tag('Remote'), systemsTag: tag('Systems'), startupTag: tag('Startup'), leadershipTag: tag('leadership')
  };
  db.close();
  return ids;
}

function runCli(home, args) {
  const output = execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root, env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  return JSON.parse(output);
}

async function startServer(home, tmp) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db'), TMPDIR: tmp, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(250) });
      if (response.status === 200) return { child, baseUrl, stderr: () => stderr };
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start: ${stderr}`);
}

async function stopServer(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server did not exit: ${instance.stderr()}`)), 3000);
    instance.child.once('exit', () => { clearTimeout(timeout); resolve(); });
    instance.child.kill('SIGTERM');
  });
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function count(value, pattern) {
  return [...value.matchAll(pattern)].length;
}
