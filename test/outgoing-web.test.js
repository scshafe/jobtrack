'use strict';

// The operator's web view reads the LIVE lane. This is the pin for the gap
// docs/EMAIL_LANES.md called out ("the operator's reply view is wired to the
// dead lane"): a v2 policy-approved live send must be visible on
// /communications/replies and on the application workspace, collapsed to
// metadata — proposal id, state, approver KIND, domains, digests — while the
// exact recipient address, draft prose, subject, and approver id stay off the
// page entirely.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { makeStore, seedDraft } = require('../test-support/outgoing-live-seed');
const { autoApproveProposal } = require('../lib/email-auto-approval');
const { sendApproved } = require('../lib/email-send-live');
const { freePort } = require('../test-support/free-port');

const root = path.resolve(__dirname, '..');

test('a v2 policy-approved live send renders on the outgoing-replies page and the workspace', async (t) => {
  const { home, db } = makeStore();
  let instance;
  t.after(async () => {
    await stopServer(instance);
    if (db.open) db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Allow the fixture recipient's domain so the stub transmit is permitted.
  fs.writeFileSync(path.join(home, 'send-allowlist.json'),
    `${JSON.stringify({ domains: ['example.test'], addresses: [] })}\n`);

  const proposalId = seedDraft(home, db, 'outgoing-web', { deliveryProvider: 'gog_gmail' });
  // Link the inbound message to application 1 the way a reviewed transition
  // would, so the lifecycle binds the application register.
  const refId = db.prepare('SELECT message_ref_id FROM job_email_outgoing_proposals_v3 WHERE proposal_id=?')
    .get(proposalId).message_ref_id;
  db.prepare(`
    INSERT INTO job_email_application_links(message_ref_id, application_id, relation, proposal_id)
    VALUES (?,?,?,NULL)
  `).run(refId, 1, 'reviewed-test-link');

  const approval = autoApproveProposal(db, { proposalId, applicationId: 1, home });
  const sent = sendApproved(db, {
    approvalId: approval.approvalReceipt.approvalId,
    home,
    transmit: () => ({ providerMessageId: 'stub-msg-web-1', providerThreadId: '18fa0', raw: 'stub' })
  });
  assert.equal(sent.outcome, 'sent');

  // Capture the private values that must never render, then release the store.
  const proposalRow = db.prepare('SELECT recipient, proposal_digest, proposal_json FROM job_email_outgoing_proposals_v3 WHERE proposal_id=?')
    .get(proposalId);
  const proposalDocument = JSON.parse(proposalRow.proposal_json);
  const privateValues = [proposalRow.recipient, proposalDocument.body, proposalDocument.subject]
    .filter((value) => typeof value === 'string' && value.length > 0);
  assert.ok(privateValues.length >= 2, 'the proposal carries a recipient and prose to protect');
  db.close();

  instance = await startServer(home);

  // 1. The global page: the live lane is the primary section.
  const page = await request(`${instance.baseUrl}/communications/replies`);
  assert.equal(page.status, 200, `${page.text}\n${instance.stderr()}`);
  assert.match(page.text, /Outgoing replies/);
  assert.match(page.text, new RegExp(`Outgoing reply ${escapeRegExp(proposalId)}`));
  assert.match(page.text, /approved by policy/, 'the approver KIND renders');
  assert.match(page.text, /Sent<\/span><span>1</, 'the summary grid counts the send');
  assert.match(page.text, /Approved by policy<\/span><span>1</);
  assert.match(page.text, /sent \(applied\)/, 'receipt outcome and classification render');
  assert.match(page.text, /provider message id recorded/);
  assert.match(page.text, /recipient @example\.test/, 'the recipient collapses to a domain');
  assert.match(page.text, new RegExp(escapeRegExp(proposalRow.proposal_digest.slice(0, 16))), 'digests render truncated');
  assert.match(page.text, /Drove/, 'the correlated application register renders');
  assert.doesNotMatch(page.text, /Historical v1/, 'no v1 rows means no historical section');

  // 2. The collapse discipline: exact address, prose, subject, approver id.
  // Substring checks, not regexes: the body is multi-line prose.
  for (const secret of privateValues) {
    assert.ok(!page.text.includes(secret), `leaked: ${secret.slice(0, 40)}`);
  }
  assert.doesNotMatch(page.text, /auto-approval-policy\.v1/, 'the approver id never renders — only its kind');
  assert.doesNotMatch(page.text, /owner-local-signer|signer/i, 'signer identity never renders');

  // 3. The workspace shows the same lifecycle for its application.
  const workspace = await request(`${instance.baseUrl}/applications/1`);
  assert.equal(workspace.status, 200);
  assert.match(workspace.text, /Outgoing replies \(live v2 lane\)/);
  assert.match(workspace.text, new RegExp(`Outgoing reply ${escapeRegExp(proposalId)}`));
  assert.match(workspace.text, /Approval policy<\/span><span>auto \(default\)/);
  assert.match(workspace.text, /Send edge<\/span><span>send-approved · allowlisted/);
  assert.match(workspace.text, /Outgoing replies \(v2\)<\/span><span>1</);
  assert.match(workspace.text, /Sent<\/span><span>1</);
  for (const secret of privateValues) {
    assert.ok(!workspace.text.includes(secret), `workspace leaked: ${secret.slice(0, 40)}`);
  }
});

test('an approval-policy override renders as the workspace policy line', async (t) => {
  const { home, db } = makeStore();
  let instance;
  t.after(async () => {
    await stopServer(instance);
    if (db.open) db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const proposalId = seedDraft(home, db, 'outgoing-web-manual');
  const refId = db.prepare('SELECT message_ref_id FROM job_email_outgoing_proposals_v3 WHERE proposal_id=?')
    .get(proposalId).message_ref_id;
  db.prepare(`
    INSERT INTO job_email_application_links(message_ref_id, application_id, relation, proposal_id)
    VALUES (?,?,?,NULL)
  `).run(refId, 1, 'reviewed-test-link');
  db.prepare(`
    INSERT INTO job_email_approval_policy(application_id, mode, set_by) VALUES (?,?,?)
  `).run(1, 'manual', 'outgoing-web-test');
  db.close();

  instance = await startServer(home);
  const workspace = await request(`${instance.baseUrl}/applications/1`);
  assert.equal(workspace.status, 200);
  assert.match(workspace.text, /Approval policy<\/span><span>manual \(override\)/);
  const page = await request(`${instance.baseUrl}/communications/replies`);
  assert.match(page.text, /awaiting review/, 'an undecided proposal reads as awaiting review');
  assert.match(page.text, /Awaiting review<\/span><span>1</);
});

async function startServer(home) {
  const port = await freePort();
  const temporary = path.join(home, 'web-tmp');
  fs.mkdirSync(temporary, { recursive: true });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db'), TMPDIR: temporary, HOST: '127.0.0.1', PORT: String(port) },
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
    } catch { /* listener not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start: ${stderr}`);
}

async function stopServer(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  const exited = once(instance.child, 'exit');
  instance.child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not exit: ${instance.stderr()}`)), 3000))
  ]);
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
