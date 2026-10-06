'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { freePort } = require('../test-support/free-port');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('CLI and read-only web compose opportunity discovery with permission-aware stories', async (t) => {
  const { root: fixtureRoot, home } = require('../test-support/migrated-store').createTestStore('jobtrack-domain-web-');
  const tmp = path.join(fixtureRoot, 'tmp');
  fs.mkdirSync(tmp);
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  runCli(home, [
    'discovery', 'source', 'add', '--key', 'manual-test', '--adapter', 'manual',
    '--label', 'Public test source', '--policy-state', 'allowed'
  ]);

  const first = runCli(home, [
    'opportunity', 'ingest', '--source', 'manual-test', '--company', 'X <script>alert(1)</script>',
    '--role', 'Platform & Voice Engineer', '--url', 'https://example.com/jobs/voice?utm_source=test',
    '--provider', 'manual', '--external-id', 'voice-1', '--description', 'Public posting text',
    '--idempotency-key', 'opportunity-voice-1'
  ]);
  const repeated = runCli(home, [
    'opportunity', 'ingest', '--source', 'manual-test', '--company', 'X <script>alert(1)</script>',
    '--role', 'Platform & Voice Engineer', '--url', 'https://example.com/jobs/voice?utm_source=other',
    '--provider', 'manual', '--external-id', 'voice-1', '--description', 'Public posting text',
    '--idempotency-key', 'opportunity-voice-1'
  ]);
  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.equal(repeated.observationCreated, false);
  assert.equal(runCli(home, ['opportunity', 'search']).opportunities.length, 1);

  const rawSecret = 'RAW_DO_NOT_RENDER <img src=x onerror=alert(2)>';
  const captured = runCli(home, [
    'story', 'capture', '--title', 'Launch <script>alert(3)</script>', '--raw', rawSecret,
    '--source', 'Cole conversation', '--tags', 'leadership,recovery',
    '--idempotency-key', 'story-launch-capture-v1'
  ]);
  assert.equal(captured.story.lock_version, 0);
  assert.equal(JSON.stringify(captured).includes(rawSecret), false);

  const polished = runCli(home, [
    'story', 'polish', '--story-id', '1', '--expected-version', '0',
    '--canonical', 'Made the failure visible, coordinated recovery, and improved the system.',
    '--summary', 'Recovered a difficult launch', '--takeaway', 'Calm ownership turns incidents into learning.',
    '--why-it-matters', 'Shows technical judgment and communication.', '--status', 'ready',
    '--authored-by', 'test-agent', '--idempotency-key', 'story-launch-polish-v1'
  ]);
  assert.equal(polished.story.status, 'ready');
  assert.equal(polished.story.lock_version, 1);

  runCli(home, [
    'story', 'permission', 'set', '--story-id', '1', '--expected-version', '1',
    '--purpose', 'interview', '--decision', 'allow', '--approved-by', 'Cole',
    '--idempotency-key', 'story-launch-interview-allow-v1'
  ]);
  assert.equal(runCli(home, ['story', 'match', '--purpose', 'interview', '--question', 'launch']).candidates.length, 1);
  assert.equal(runCli(home, ['story', 'match', '--purpose', 'resume', '--question', 'launch']).candidates.length, 0);
  assert.equal(runCli(home, ['profile', 'extract', '--text', 'launch']).entries.length, 0);
  assert.equal(JSON.stringify(runCli(home, ['story', 'show', '1'])).includes(rawSecret), false);
  assert.equal(JSON.stringify(runCli(home, ['story', 'show', '1', '--include-raw'])).includes(rawSecret), true);

  assert.throws(
    () => runCli(home, ['profile', 'add', '--category', 'story', '--title', 'Bypass', '--content', 'mutable', '--source', 'test']),
    /story capture/
  );

  const openingId = first.opportunity.job_opening_id;
  const postingId = first.opportunity.primary_job_posting_id;
  runCli(home, ['catalog', 'role-type', 'assign', '--opening-id', openingId, '--role-type', 'platform', '--primary', '--source', 'test']);
  runCli(home, ['catalog', 'seniority', 'assign', '--opening-id', openingId, '--seniority', 'senior', '--primary', '--source', 'test']);
  runCli(home, ['catalog', 'skill', 'upsert', '--name', 'Node.js', '--category', 'platforms']);
  runCli(home, [
    'catalog', 'posting', 'add-skill-requirement', '--posting-id', postingId,
    '--skill', 'Node.js', '--requirement-kind', 'required', '--snapshot-id', first.snapshotId,
    '--source', 'test'
  ]);
  const promoted = runCli(home, ['opportunity', 'promote', '--opportunity-id', first.opportunityId]);
  const interview = runCli(home, [
    'log-interview', '--application-id', promoted.application.id, '--round-type', 'technical-screen',
    '--scheduled-at', '2026-07-25T17:00:00-07:00', '--timezone', 'America/Los_Angeles', '--format', 'video'
  ]);
  runCli(home, [
    'interview-prep', 'generate', '--interview-id', interview.interview.id,
    '--idempotency-key', 'prep-domain-web-v1'
  ]);

  instance = await startServer(home, tmp);

  const opportunityList = await request(`${instance.baseUrl}/opportunities`);
  assert.equal(opportunityList.status, 200);
  assert.match(opportunityList.text, /Platform &amp; Voice Engineer/);
  assert.match(opportunityList.text, /X &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(opportunityList.text, /<script>alert\(1\)<\/script>/);

  const discoveryProposals = await request(`${instance.baseUrl}/discovery-proposals`);
  assert.equal(discoveryProposals.status, 200);
  assert.match(discoveryProposals.text, /Discovery proposals/);
  assert.match(discoveryProposals.text, /No discovery proposals/);

  const opportunityDetail = await request(`${instance.baseUrl}/opportunities/${first.opportunityId}`);
  assert.equal(opportunityDetail.status, 200);
  assert.match(opportunityDetail.text, /Public posting text/);

  const storyList = await request(`${instance.baseUrl}/stories`);
  assert.equal(storyList.status, 200);
  assert.match(storyList.text, /Launch &lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.doesNotMatch(storyList.text, /RAW_DO_NOT_RENDER/);

  const storyDetail = await request(`${instance.baseUrl}/stories/1`);
  assert.equal(storyDetail.status, 200);
  assert.match(storyDetail.text, /Made the failure visible/);
  // Full-visibility directive (2026-08-05): raw narration renders on the
  // story page — ESCAPED. Visible as inert text; never as active markup.
  assert.match(storyDetail.text, /RAW_DO_NOT_RENDER/);
  assert.match(storyDetail.text, /&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.doesNotMatch(storyDetail.text, /<img src=x onerror=alert/);

  const openingList = await request(`${instance.baseUrl}/openings`);
  assert.equal(openingList.status, 200);
  assert.match(openingList.text, /Platform &amp; Voice Engineer/);
  assert.match(openingList.text, /Platform/);

  const openingDetail = await request(`${instance.baseUrl}/openings/${openingId}`);
  assert.equal(openingDetail.status, 200, instance.stderr());
  assert.match(openingDetail.text, /Node\.js/);
  assert.match(openingDetail.text, /required/i);

  const interviews = await request(`${instance.baseUrl}/interviews`);
  assert.equal(interviews.status, 200);
  assert.match(interviews.text, /Prep v1/);

  const prep = await request(`${instance.baseUrl}/interviews/${interview.interview.id}/prep`);
  assert.equal(prep.status, 200);
  assert.match(prep.text, /Evidence-backed skill map/);
  assert.match(prep.text, /Node\.js/);

  assert.equal((await request(`${instance.baseUrl}/stories/not-an-id`)).status, 404);
  assert.equal((await request(`${instance.baseUrl}/opportunities/999999`)).status, 404);
  assert.equal((await request(`${instance.baseUrl}/openings/999999`)).status, 404);
  assert.equal((await request(`${instance.baseUrl}/interviews/999999/prep`)).status, 404);
  assert.equal((await request(`${instance.baseUrl}/discovery-proposals/not-a-digest`)).status, 404);
  assert.equal((await request(`${instance.baseUrl}/stories`, { method: 'POST' })).status, 405);

  await stopServer(instance);
});

function runCli(home, args) {
  const stdout = execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return JSON.parse(stdout);
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
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(250) });
      if (response.status === 200) return { child, baseUrl, stderr: () => stderr };
    } catch { /* retry until deadline */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill('SIGKILL');
  throw new Error(`server did not become ready: ${stderr}`);
}

async function stopServer(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server did not exit: ${instance.stderr()}`)), 3000);
    instance.child.once('exit', () => { clearTimeout(timeout); resolve(); });
    instance.child.kill('SIGTERM');
  });
}

async function request(url, options) {
  const response = await fetch(url, options);
  return { status: response.status, text: await response.text(), headers: response.headers };
}
