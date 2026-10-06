const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { freePort } = require('../test-support/free-port');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'jobtrack.js');

test('profile renders the full CLI-captured corpus and rejects writes', async (t) => {
  const home = makeHome('jobtrack-full-profile-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  seedFullProfile(home);

  await withServer(home, async (baseUrl) => {
    const profile = await request(`${baseUrl}/profile`);
    assert.equal(profile.status, 200, profile.text);
    assert.match(profile.text, /Contact \+ Summary/);
    assert.match(profile.text, /Builder of durable tools/);
    assert.match(profile.text, /id="work-title">Experience/);
    assert.match(profile.text, /Systems Engineer/);
    assert.match(profile.text, /id="education-title">Education/);
    assert.match(profile.text, /State University/);
    assert.match(profile.text, /Links/);
    assert.match(profile.text, /GitHub/);
    assert.match(profile.text, /id="skills-title">Skills/);
    assert.match(profile.text, /SQLite/);
    assert.match(profile.text, /Projects/);
    assert.match(profile.text, /JobTrack/);
    assert.match(profile.text, /Certifications \+ Licenses/);
    assert.match(profile.text, /Node Certification/);
    assert.match(profile.text, /Driver License/);
    assert.match(profile.text, /Awards \+ Honors/);
    assert.match(profile.text, /Launch Award/);
    assert.match(profile.text, /Dean&#39;s List/);
    assert.match(profile.text, /Publications \+ Talks \+ Patents/);
    assert.match(profile.text, /SQLite at Scale/);
    assert.match(profile.text, /Agent Systems Talk/);
    assert.match(profile.text, /Workflow Patent/);
    assert.match(profile.text, /Languages/);
    assert.match(profile.text, /Spanish/);
    assert.match(profile.text, /Volunteer Experience/);
    assert.match(profile.text, /Open Source Guild/);
    assert.match(profile.text, /Reusable Application Answers/);
    assert.match(profile.text, /Why this role\?/);
    assert.match(profile.text, /References/);
    assert.match(profile.text, /Riley Reference/);
    assert.match(profile.text, /Optional EEO \+ Self-ID/);
    assert.match(profile.text, /they\/them/);
    assert.match(profile.text, /Other Profile Evidence/);
    assert.match(profile.text, /Async preference/);
    assert.match(profile.text, /jump-nav/);
    // The read-only posture moved from a paragraph on this page into the app
    // header, where it is present on every surface instead of one.
    assert.match(profile.text, /class="header-note"[^>]*>read-only</);

    const applications = await request(`${baseUrl}/`);
    assert.equal(applications.status, 200);
    assert.match(applications.text, /ExampleCo/);

    const post = await request(`${baseUrl}/profile`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  });
});

test('profile returns 200 with empty sections for an older store without profile tables', async (t) => {
  // This compatibility assertion requires the deliberately incomplete schema.
  const home = makeHome('jobtrack-old-profile-', { migrated: false });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const db = new Database(path.join(home, 'jobtrack.db'));
  db.exec('CREATE TABLE applications (id INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  db.close();

  await withServer(home, async (baseUrl) => {
    const response = await request(`${baseUrl}/profile`);
    assert.equal(response.status, 200, response.text);
    assert.match(response.text, /No contact, headline, summary, or autofill preferences stored yet/);
    assert.match(response.text, /No structured work entries yet/);
    // Marker contract, not prose: an older store renders every section as a
    // designed empty state. (The former assertion pinned a sentence that was
    // appended to EVERY panel — including fresh stores with zero rows, where
    // "older stores" was simply untrue.)
    assert.match(response.text, /data-jt-empty/);
    assert.match(response.text, /<section class="profile-section" data-jt-section="contact"/);
  });
});

function seedFullProfile(home) {
  runCli(home, ['add-application', '--company', 'ExampleCo', '--role', 'Engineer', '--status', 'applied', '--applied-date', '2026-06-24']);
  runCli(home, ['profile', 'set-contact', '--name', 'Cole Example', '--email', 'cole@example.com', '--phone', '555-0100', '--location', 'Tailnet', '--work-authorization', 'Authorized', '--visa-sponsorship', 'No', '--relocation-willingness', 'Remote only', '--remote-preference', 'Remote', '--compensation-expectations', 'Market', '--notice-period', 'Immediate', '--earliest-start-date', '2026-07-01', '--headline', 'Builder of durable tools', '--summary', 'Builds dense internal systems for application workflows.', '--source', 'operator', '--confidence', 'high', '--tags', 'contact,summary']);
  runCli(home, ['profile', 'add-work', '--company', 'Mission Control', '--role', 'Systems Engineer', '--start-date', '2020', '--present', '--location', 'Remote', '--highlights', 'Led launch readiness.', '--description', 'Built agent-facing tooling.', '--source', 'operator', '--confidence', 'high']);
  runCli(home, ['profile', 'add-education', '--institution', 'State University', '--degree', 'BS', '--field', 'Computer Science', '--start-date', '2010', '--graduation-year', '2014', '--honors', 'Magna cum laude', '--source', 'operator', '--confidence', 'high']);
  runCli(home, ['profile', 'add-link', '--kind', 'GitHub', '--label', 'GitHub', '--url', 'https://example.com/cole', '--username', 'cole', '--confidence', 'high']);
  runCli(home, ['profile', 'add-skill', '--name', 'SQLite', '--group', 'Data', '--proficiency', 'advanced', '--years', '5', '--notes', 'Schema and WAL operations.', '--confidence', 'high']);
  runCli(home, ['profile', 'add-project', '--name', 'JobTrack', '--description', 'Application tracker.', '--stack', 'Node,SQLite,Express', '--role', 'Builder', '--url', 'https://example.com/jobtrack', '--links', 'https://example.com/docs', '--start-date', '2026', '--highlights', 'Read-only profile portal.', '--confidence', 'high']);
  runCli(home, ['profile', 'add-certification', '--name', 'Node Certification', '--issuer', 'Node Org', '--credential-id', 'NODE-1', '--issued-at', '2025', '--url', 'https://example.com/cert', '--confidence', 'high']);
  runCli(home, ['profile', 'add-license', '--name', 'Driver License', '--issuer', 'State', '--license-number', 'D-123', '--issued-at', '2024', '--expires-at', '2028', '--confidence', 'high']);
  runCli(home, ['profile', 'add-award', '--title', 'Launch Award', '--issuer', 'Mission Control', '--awarded-at', '2026', '--description', 'Recognized launch delivery.', '--confidence', 'high']);
  runCli(home, ['profile', 'add-honor', '--title', "Dean's List", '--issuer', 'State University', '--awarded-at', '2014', '--confidence', 'high']);
  runCli(home, ['profile', 'add-publication', '--title', 'SQLite at Scale', '--publisher', 'Internal Notes', '--published-at', '2025', '--description', 'Operational notes.', '--confidence', 'high']);
  runCli(home, ['profile', 'add-talk', '--title', 'Agent Systems Talk', '--publisher', 'Meetup', '--published-at', '2026', '--description', 'Talk on agent systems.', '--confidence', 'high']);
  runCli(home, ['profile', 'add-patent', '--title', 'Workflow Patent', '--publisher', 'USPTO', '--published-at', '2024', '--description', 'Workflow patent record.', '--confidence', 'high']);
  runCli(home, ['profile', 'add-language', '--language', 'Spanish', '--proficiency', 'professional', '--notes', 'Used with customers.', '--confidence', 'high']);
  runCli(home, ['profile', 'add-volunteer', '--organization', 'Open Source Guild', '--role', 'Maintainer', '--cause', 'Developer tools', '--start-date', '2022', '--present', '--location', 'Remote', '--highlights', 'Reviewed patches.', '--confidence', 'high']);
  runCli(home, ['profile', 'add-answer', '--question', 'Why this role?', '--answer', 'I like durable, operator-first tooling.', '--category', 'motivation', '--confidence', 'high']);
  runCli(home, ['profile', 'add-reference', '--name', 'Riley Reference', '--relationship', 'Manager', '--company', 'Mission Control', '--title', 'Director', '--contact', 'riley@example.com', '--notes', 'Ask before sharing.', '--confidence', 'high']);
  runCli(home, ['profile', 'set-eeo', '--gender', 'Prefer not to say', '--pronouns', 'they/them', '--race-ethnicity', 'Prefer not to say', '--veteran', 'No', '--disability', 'Prefer not to say', '--notes', 'Optional autofill only.', '--confidence', 'high']);
  runCli(home, ['profile', 'add', '--category', 'preference', '--title', 'Async preference', '--content', 'Prefers asynchronous written collaboration.', '--source', 'operator', '--confidence', 'high']);
}

function runCli(home, args) {
  execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
    stdio: 'pipe'
  });
}

function makeHome(prefix, { migrated = true } = {}) {
  const home = migrated
    ? require('../test-support/migrated-store').createTestHome(prefix)
    : fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(home, 'tmp'));
  return home;
}

async function withServer(home, fn) {
  const port = await freePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db'), HOST: '127.0.0.1', PORT: String(port), TMPDIR: path.join(home, 'tmp') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl, server, () => stderr);
    await fn(baseUrl);
  } finally {
    if (!server.killed) server.kill('SIGTERM');
    await once(server, 'exit').catch(() => {});
  }
}

async function waitForServer(baseUrl, server, getStderr) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early: ${getStderr()}`);
    try {
      const response = await fetch(`${baseUrl}/profile`, { signal: AbortSignal.timeout(250) });
      await response.text();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`server did not start: ${getStderr()}`);
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}
