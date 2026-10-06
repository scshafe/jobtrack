'use strict';

// The live send executor: lane-gated (one send per signed approval),
// allowlist-fenced (refusal means nothing transmits), receipt-signed (the
// lane's own native-attestation verification accepts the executor's key).

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { makeStore, seedDraft } = require('../test-support/outgoing-live-seed');
const { autoApproveProposal, approvalKeyOptions } = require('../lib/email-auto-approval');
const { createSendRequest, invalidateApproval } = require('../lib/email-outgoing-v2');
const { sendApproved, loadAllowlist, EmailSendLiveError, readSendAttempt, parseGogSendEvidence } = require('../lib/email-send-live');
const { sanitizedGogEnvironment } = require('../scripts/lib/gog-environment.cjs');

function approve(home, db, seed, options = { deliveryProvider: 'gog_gmail' }) {
  const proposalId = seedDraft(home, db, seed, options);
  return autoApproveProposal(db, { proposalId, applicationId: 1, home }).approvalReceipt.approvalId;
}

test('the allowlist seeds restrictively and refuses an out-of-scope recipient before any transmit', () => {
  const { home, db } = makeStore();
  const approvalId = approve(home, db, 'fence');
  assert.deepEqual(loadAllowlist(home).domains, ['mydrove.com'], 'seeded to mydrove.com only');
  let transmitted = 0;
  assert.throws(
    () => sendApproved(db, { approvalId, home, transmit: () => { transmitted += 1; return {}; } }),
    (err) => err instanceof EmailSendLiveError && err.code === 'RECIPIENT_NOT_ALLOWLISTED'
  );
  assert.equal(transmitted, 0, 'nothing transmitted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job_email_send_receipt_correlations_v2').get().n, 0, 'no receipt');
  // The one-send request precedes the allowlist; no durable wire attempt is
  // made on refusal. The outer CLI transaction may roll back this request.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job_email_send_requests_v2').get().n, 1);
  assert.equal(readSendAttempt(home, approvalId).status, 'not_attempted');
});

test('an allowlisted recipient transmits once, lands a lane-verified sent receipt, and replays as alreadySent', () => {
  const { home, db } = makeStore();
  fs.writeFileSync(path.join(home, 'send-allowlist.json'),
    `${JSON.stringify({ domains: ['example.test'], addresses: [] })}\n`);
  const approvalId = approve(home, db, 'sends');
  let calls = 0;
  let sentBody;
  const transmit = (args) => {
    calls += 1;
    assert.equal(args.recipient, 'recruiter@example.test');
    assert.ok(args.bodyText.length > 0, 'approved body text reaches the provider');
    sentBody = args.bodyText;
    assert.equal(args.account, 'jobs@example.test');
    assert.equal(args.gmailThreadId, '18fa0');
    assert.equal(args.replyToMessageId, '18fa1');
    assert.equal(readSendAttempt(home, approvalId).status, 'reconcile_only', 'fence already exists at the wire');
    return { providerMessageId: `stub-msg-${calls}`, providerThreadId: '18fa0', raw: 'not journaled' };
  };
  const first = sendApproved(db, { approvalId, home, transmit });
  assert.equal(first.outcome, 'sent');
  assert.equal(first.providerMessageId, 'stub-msg-1');
  assert.equal(calls, 1);
  assert.equal(db.prepare('SELECT outcome FROM job_email_send_receipt_correlations_v2').get().outcome, 'sent');

  const replay = sendApproved(db, { approvalId, home, transmit });
  assert.equal(replay.alreadySent, true, 'the approval sends exactly once');
  assert.equal(calls, 1, 'no second transmission');
  const journal = readSendAttempt(home, approvalId);
  assert.equal(journal.status, 'receipt_persisted');
  assert.equal(JSON.stringify(journal).includes('not journaled'), false);
  assert.equal(JSON.stringify(journal).includes(sentBody), false);
});

function allowedStore(seed, options) {
  const { home, db } = makeStore();
  fs.writeFileSync(path.join(home, 'send-allowlist.json'), JSON.stringify({ domains: ['example.test'] }));
  return { home, db, approvalId: approve(home, db, seed, options) };
}

const sentEvidence = () => ({ providerMessageId: '18fa2', providerThreadId: '18fa0' });
const requiresReconciliation = (err) => err instanceof EmailSendLiveError && err.code === 'SEND_RECONCILIATION_REQUIRED';

test('ambiguous provider failure survives SQLite rollback and never retransmits', () => {
  const { home, db, approvalId } = allowedStore('rollback-ambiguous');
  let calls = 0;
  const run = db.transaction(() => sendApproved(db, { home, approvalId, transmit() { calls++; throw new Error('timeout after accepted'); } }));
  assert.throws(run, requiresReconciliation);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_email_send_requests_v2').get().n, 0);
  assert.equal(readSendAttempt(home, approvalId).status, 'reconcile_only');
  assert.throws(() => sendApproved(db, { home, approvalId, transmit() { calls++; return sentEvidence(); } }), requiresReconciliation);
  assert.equal(calls, 1);
});

test('a persisted signed receipt restores its rolled-back request and correlates without a second wire call', () => {
  const { home, db, approvalId } = allowedStore('rollback-sent');
  let calls = 0;
  let first;
  assert.throws(db.transaction(() => {
    first = sendApproved(db, { home, approvalId, transmit() { calls++; return sentEvidence(); } });
    throw new Error('outer CLI transaction failed after send');
  }), /outer CLI transaction/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_email_send_requests_v2').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_email_send_receipt_correlations_v2').get().n, 0);
  const recovered = sendApproved(db, { home, approvalId, transmit() { calls++; throw new Error('must not transmit'); } });
  assert.equal(recovered.reconciled, true);
  assert.equal(recovered.alreadySent, true);
  assert.deepEqual(recovered.receipt, first.receipt);
  assert.deepEqual(recovered.request, first.request);
  assert.equal(calls, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_email_send_receipt_correlations_v2').get().n, 1);
});

test('same-process reentrancy cannot cross the durable fence', () => {
  const { home, db, approvalId } = allowedStore('reentrant');
  let calls = 0;
  sendApproved(db, { home, approvalId, transmit() {
    calls++;
    assert.throws(() => sendApproved(db, { home, approvalId, transmit() { calls++; return sentEvidence(); } }), requiresReconciliation);
    return sentEvidence();
  } });
  assert.equal(calls, 1);
});

test('a different approval cannot evade an uncertain or completed source-message attempt', () => {
  for (const outcome of ['uncertain', 'sent']) {
    const { home, db, approvalId } = allowedStore(`source-${outcome}`);
    let calls = 0;
    const first = () => sendApproved(db, { home, approvalId, transmit() {
      calls++;
      if (outcome === 'uncertain') throw new Error('ambiguous');
      return sentEvidence();
    } });
    if (outcome === 'uncertain') assert.throws(first, requiresReconciliation);
    else first();
    const replacement = approve(home, db, `replacement-${outcome}`);
    assert.notEqual(replacement, approvalId);
    assert.throws(() => sendApproved(db, { home, approvalId: replacement, transmit() { calls++; return sentEvidence(); } }), requiresReconciliation);
    assert.equal(calls, 1);
  }
});

test('an old receipt in SQLite also fences a changed approval even without new-format journal files', () => {
  const { home, db, approvalId } = allowedStore('historical-source');
  sendApproved(db, { home, approvalId, transmit: sentEvidence });
  // Simulate pre-journal deployment data in this throwaway fixture only.
  fs.renameSync(path.join(home, 'email-send-source-fences'), path.join(home, 'fixture-old-source-fences'));
  const replacement = approve(home, db, 'historical-replacement');
  assert.throws(() => sendApproved(db, { home, approvalId: replacement, transmit() { assert.fail('must never transmit'); } }), requiresReconciliation);
});

test('malformed or placeholder provider results remain fenced with no sent receipt', () => {
  for (const evidence of [undefined, {}, { providerMessageId: 'unknown', providerThreadId: '18fa0' },
    { providerMessageId: '18fa2', providerThreadId: 'unknown' },
    { providerMessageId: 'apple-osascript-123', providerThreadId: 'subject-threaded' },
    { providerMessageId: '18fa2', providerThreadId: 'another-thread' }]) {
    const { home, db, approvalId } = allowedStore(`bad-evidence-${JSON.stringify(evidence)}`);
    let calls = 0;
    assert.throws(() => sendApproved(db, { home, approvalId, transmit() { calls++; return evidence; } }), requiresReconciliation);
    assert.throws(() => sendApproved(db, { home, approvalId, transmit() { calls++; return sentEvidence(); } }), requiresReconciliation);
    assert.equal(calls, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM job_email_send_receipt_correlations_v2').get().n, 0);
  }
});

test('Gmail output parsing requires native IDs and never uses a requested-thread fallback', () => {
  assert.deepEqual(parseGogSendEvidence('{"messageId":"18fa2","threadId":"18fa0"}'), sentEvidence());
  assert.deepEqual(parseGogSendEvidence('{"id":"18fa2","threadId":"18fa0"}'), sentEvidence());
  assert.deepEqual(parseGogSendEvidence('{"message_id":"18fa2","thread_id":"18fa0"}'), sentEvidence());
  assert.deepEqual(parseGogSendEvidence('{"message":{"id":"18fa2","threadId":"18fa0"}}'), sentEvidence());
  assert.deepEqual(parseGogSendEvidence('{"message":{"messageId":"18fa2","threadId":"18fa0"}}'), sentEvidence());
  for (const raw of ['not json', '{}', 'null', '{"id":"18fa2"}', '{"id":"unknown","threadId":"18fa0"}',
    '{"id":"local-stub","threadId":"18fa0"}', '{"id":123,"threadId":"18fa0"}', '{"id":"18fa2 ","threadId":"18fa0"}']) {
    assert.throws(() => parseGogSendEvidence(raw), (err) => err.code === 'PROVIDER_EVIDENCE_INVALID');
  }
});

test('native result aliases must agree exactly, including outer/nested identity fields', () => {
  const consistent = { messageId: '18fa2', id: '18fa2', message_id: '18fa2', threadId: '18fa0', thread_id: '18fa0' };
  assert.deepEqual(parseGogSendEvidence(JSON.stringify(consistent)), sentEvidence());
  assert.deepEqual(parseGogSendEvidence(JSON.stringify({ ...consistent, message: consistent })), sentEvidence());
  for (const aliases of [
    { messageId: '18fa3' }, { id: '18fa3' }, { message_id: '18fa3' },
    { threadId: '18fa1' }, { thread_id: '18fa1' }, { id: null }, { message_id: '' }
  ]) {
    for (const data of [{ ...consistent, ...aliases }, { ...aliases, message: consistent }]) {
      assert.throws(() => parseGogSendEvidence(JSON.stringify(data)), (error) => error.code === 'PROVIDER_EVIDENCE_INVALID');
    }
  }
  for (const messageId of ['native-stub', '18fa2 ', 123, '', null]) {
    assert.throws(() => parseGogSendEvidence(JSON.stringify({ messageId, threadId: '18fa0' })),
      (error) => error.code === 'PROVIDER_EVIDENCE_INVALID');
  }
});

test('signed delivery provider/account/thread/source cannot be redirected by CLI overrides', () => {
  for (const override of [{ provider: 'apple-mail' }, { transmitAccount: 'other@example.test' },
    { gmailThreadId: '18fa9' }, { replyToMessageId: '18fa8' }]) {
    const { home, db, approvalId } = allowedStore(`redirect-${JSON.stringify(override)}`);
    let calls = 0;
    assert.throws(() => sendApproved(db, { home, approvalId, ...override, transmit() { calls++; return sentEvidence(); } }),
      (err) => err.code === 'DELIVERY_SCOPE_MISMATCH');
    assert.equal(calls, 0);
    assert.equal(readSendAttempt(home, approvalId).status, 'not_attempted');
  }
});

test('native Apple Mail fails before wire instead of signing fabricated resource IDs', () => {
  const { home, db, approvalId } = allowedStore('apple-closed', { deliveryProvider: 'apple_mail_automation' });
  assert.throws(() => sendApproved(db, { home, approvalId, provider: 'apple-mail' }),
    (err) => err.code === 'APPLE_MAIL_EVIDENCE_UNAVAILABLE');
  assert.equal(readSendAttempt(home, approvalId).status, 'not_attempted');
});

test('resuming a request cannot bypass a subsequently invalidated approval', () => {
  const { home, db, approvalId } = allowedStore('invalidated');
  const tag = crypto.createHash('sha256').update(approvalId).digest('hex').slice(0, 24);
  const requestId = `send-req-${tag}`;
  const request = createSendRequest(db, {
    schemaVersion: 'jobtrack-email-send-request-issue.v1', requestId,
    approvalId, operationIdempotencyKey: `${requestId}-op`
  }, { approvalKey: approvalKeyOptions(home) }).request;
  invalidateApproval(db, {
    schemaVersion: 'jobtrack-email-outgoing-invalidation.v1',
    invalidationId: 'test-invalidated-before-wire', approvalId,
    expectedApprovalDigest: request.approvalDigest, reason: 'content_edited',
    invalidatedAt: new Date().toISOString(), operationIdempotencyKey: 'test-invalidate-op'
  });
  assert.throws(() => sendApproved(db, { home, approvalId, transmit() { assert.fail('must never transmit'); } }),
    (err) => err.code === 'SEND_AUTHORITY_NOT_CURRENT');
  assert.equal(readSendAttempt(home, approvalId).status, 'not_attempted');
});

test('incomplete and tampered journals fail closed; inspection creates nothing', () => {
  const { home, db, approvalId } = allowedStore('tamper');
  assert.equal(readSendAttempt(home, approvalId).status, 'not_attempted');
  assert.equal(fs.existsSync(path.join(home, 'email-send-attempts')), false);
  assert.throws(db.transaction(() => {
    sendApproved(db, { home, approvalId, transmit: sentEvidence });
    throw new Error('rollback');
  }), /rollback/);
  const root = path.join(home, 'email-send-attempts');
  const directory = path.join(root, fs.readdirSync(root)[0]);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  for (const name of fs.readdirSync(directory)) assert.equal(fs.statSync(path.join(directory, name)).mode & 0o777, 0o600);
  const receiptFile = path.join(directory, 'receipt.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile));
  receipt.providerMessageId = '18fa9';
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  assert.equal(readSendAttempt(home, approvalId).status, 'reconcile_only');
  assert.throws(() => sendApproved(db, { home, approvalId, transmit() { assert.fail('must never transmit'); } }), requiresReconciliation);
  fs.writeFileSync(receiptFile, '{');
  assert.equal(readSendAttempt(home, approvalId).status, 'reconcile_only');
});

test('provider evidence without a completed native signature grants no recovery or retry', () => {
  const { home, db, approvalId } = allowedStore('signing-crash');
  const originalSign = crypto.sign;
  let calls = 0;
  try {
    crypto.sign = () => { throw new Error('simulated signing failure'); };
    assert.throws(() => sendApproved(db, { home, approvalId, transmit() { calls++; return sentEvidence(); } }), requiresReconciliation);
  } finally { crypto.sign = originalSign; }
  const root = path.join(home, 'email-send-attempts');
  const directory = path.join(root, fs.readdirSync(root)[0]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'provider-evidence.json'))), sentEvidence());
  assert.equal(fs.existsSync(path.join(directory, 'receipt.json')), false);
  assert.equal(readSendAttempt(home, approvalId).status, 'reconcile_only');
  assert.throws(() => sendApproved(db, { home, approvalId, transmit() { calls++; return sentEvidence(); } }), requiresReconciliation);
  assert.equal(calls, 1);
});

test('a killed sender keeps its pre-wire fence across process restart', () => {
  const { home, db, approvalId } = allowedStore('crash');
  const result = spawnSync(process.execPath, ['-e', `
    const Database = require('better-sqlite3');
    const { sendApproved } = require('./lib/email-send-live');
    const db = new Database(process.argv[1] + '/jobtrack.db');
    db.transaction(() => sendApproved(db, { home: process.argv[1], approvalId: process.argv[2],
      transmit() { process.kill(process.pid, 'SIGKILL'); } }))();
  `, home, approvalId], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') } });
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_email_send_requests_v2').get().n, 0);
  assert.equal(readSendAttempt(home, approvalId).status, 'reconcile_only');
  assert.throws(() => sendApproved(db, { home, approvalId, transmit() { assert.fail('must never transmit'); } }), requiresReconciliation);
});

test('competing processes transmit at most once for the same signed approval', async () => {
  const { home, db, approvalId } = allowedStore('competing-processes');
  let wireCalls = 0;
  const children = [];
  const program = `
    const Database = require('better-sqlite3');
    const { sendApproved } = require('./lib/email-send-live');
    const db = new Database(process.argv[1] + '/jobtrack.db');
    db.pragma('busy_timeout=5000');
    process.on('message', () => {
      try {
        const result = sendApproved(db, { home: process.argv[1], approvalId: process.argv[2], transmit() {
          process.send({ wire: true });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
          return { providerMessageId: '18fa2', providerThreadId: '18fa0' };
        } });
        process.send({ outcome: result.outcome || 'already_sent' });
      } catch (err) { process.send({ error: err.code }); }
      db.close(); process.disconnect();
    });
    process.send({ ready: true });
  `;
  try {
    const completions = [0, 1].map(() => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', program, home, approvalId], {
        cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }
      });
      children.push(child);
      let result;
      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data; });
      child.on('message', (message) => {
        if (message.ready) {
          child.readyForTest = true;
          if (children.length === 2 && children.every((candidate) => candidate.readyForTest)) {
            for (const candidate of children) candidate.send({ go: true });
          }
        } else if (message.wire) wireCalls++;
        else result = message;
      });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve(result) : reject(new Error(stderr || `child exited ${code}`)));
    }));
    const results = await Promise.all(completions);
    assert.equal(wireCalls, 1);
    assert.equal(results.filter((value) => value.outcome === 'sent').length, 1);
    assert.ok(results.every((value) => value.outcome || value.error === 'SEND_RECONCILIATION_REQUIRED'), JSON.stringify(results));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM job_email_send_receipt_correlations_v2').get().n, 1);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('distinct-source first sends share one durable native key and both recover after receipt rollback', { timeout: 15000 }, async () => {
  const { home, db, approvalId } = allowedStore('key-race-one');
  const secondApproval = approve(home, db, 'key-race-two', {
    deliveryProvider: 'gog_gmail', sourceMessageId: '18fa3', sourceThreadId: '18fa4'
  });
  db.exec(`CREATE TRIGGER test_fail_receipt BEFORE INSERT ON job_email_send_receipt_correlations_v2
    BEGIN SELECT RAISE(ABORT,'scratch receipt failure'); END`);
  const release = path.join(home, 'test-release-key-mint');
  const children = [];
  let mintCount = 0;
  let wireCount = 0;
  const program = `
    const fs = require('node:fs');
    const crypto = require('node:crypto');
    const generate = crypto.generateKeyPairSync;
    crypto.generateKeyPairSync = (...args) => {
      const result = generate(...args);
      process.send({ mint: true });
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(process.argv[3])) {
        if (Date.now() >= deadline) throw new Error('key mint barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return result;
    };
    const Database = require('better-sqlite3');
    const { sendApproved, readSendAttempt } = require('./lib/email-send-live');
    const db = new Database(process.argv[1] + '/jobtrack.db');
    db.pragma('busy_timeout=5000');
    try {
      sendApproved(db, { home: process.argv[1], approvalId: process.argv[2], transmit(args) {
        process.send({ wire: true });
        return { providerMessageId: args.replyToMessageId + '1', providerThreadId: args.gmailThreadId };
      } });
      process.send({ error: 'unexpected_success' });
    } catch (err) {
      process.send({ error: err.code, status: readSendAttempt(process.argv[1], process.argv[2]).status });
    }
    db.close(); process.disconnect();
  `;
  try {
    const outcomes = await Promise.all([approvalId, secondApproval].map((id) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', program, home, id, release], {
        cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') }
      });
      children.push(child);
      let result;
      let stderr = '';
      child.stderr.on('data', (value) => { stderr += value; });
      child.on('message', (value) => {
        if (value.mint) {
          mintCount++;
          if (mintCount === 2) fs.writeFileSync(release, 'release', { flag: 'wx', mode: 0o600 });
        } else if (value.wire) wireCount++;
        else result = value;
      });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve(result) : reject(new Error(stderr || `child exited ${code}`)));
    })));
    assert.equal(mintCount, 2, 'force both processes to generate before either publishes');
    assert.equal(wireCount, 2, 'one send for each distinct source');
    for (const outcome of outcomes) assert.deepEqual(outcome, { error: 'SEND_RECONCILIATION_REQUIRED', status: 'receipt_persisted' });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM job_email_send_receipt_correlations_v2').get().n, 0);
    db.exec('DROP TRIGGER test_fail_receipt');
    for (const id of [approvalId, secondApproval]) {
      assert.equal(readSendAttempt(home, id).status, 'receipt_persisted');
      const recovered = sendApproved(db, { home, approvalId: id, transmit() { assert.fail('recovery may not transmit'); } });
      assert.equal(recovered.reconciled, true);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM job_email_send_receipt_correlations_v2').get().n, 2);
    assert.equal(fs.readdirSync(path.join(home, 'keys')).some((name) => name.endsWith('.tmp')), false);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('Gmail environment cannot redirect account/client/config/ADC or reshape provider evidence', () => {
  const environment = {
    PATH: '/test/bin', HOME: '/test/home', GOG_ACCESS_TOKEN: 'untrusted-token', GOG_AUTH_MODE: 'adc',
    GOG_ACCOUNT: 'wrong@example.test', GOG_CLIENT: 'other', GOG_HOME: '/other', GOG_CONFIG_DIR: '/other-config',
    GOG_DATA_DIR: '/other-data', GOG_CACHE_DIR: '/other-cache', GOG_STATE_DIR: '/other-state',
    GOG_KEYRING_BACKEND: 'other', GOG_KEYRING_SERVICE_NAME: 'other', GOG_RESULTS_ONLY: '1', GOG_SELECT: 'id',
    GOG_KEYRING_PASSWORD: 'test-unlock', GOG_GMAIL_NO_SEND: '1', GOOGLE_APPLICATION_CREDENTIALS: '/adc',
    XDG_CONFIG_HOME: '/other-xdg', XDG_DATA_HOME: '/other-xdg-data', XDG_STATE_HOME: '/other-xdg-state', XDG_CACHE_HOME: '/other-xdg-cache'
  };
  assert.deepEqual(sanitizedGogEnvironment(environment), {
    PATH: '/test/bin', HOME: '/test/home', GOG_KEYRING_PASSWORD: 'test-unlock', GOG_GMAIL_NO_SEND: '1',
    GOG_KEYRING_BACKEND: 'keychain', GOG_KEYRING_SERVICE_NAME: 'gogcli'
  });
});

test('native sender accepts pinned camel-case output and persists one signed receipt behind exact authority', () => {
  const { home, db, approvalId } = allowedStore('native-injected-command');
  const program = `
    const assert = require('node:assert/strict');
    const childProcess = require('node:child_process');
    const { sanitizedGogEnvironment } = require('./scripts/lib/gog-environment.cjs');
    require('./scripts/lib/pinned-gog.cjs').resolvePinnedGog = () => '/test/pinned-gog';
    let calls = 0;
    childProcess.execFileSync = (file, args, options) => {
      calls++;
      assert.equal(file, '/test/pinned-gog');
      assert.deepEqual(options.env, sanitizedGogEnvironment(process.env));
      assert.equal(options.env.GOG_ACCESS_TOKEN, undefined);
      assert.equal(options.env.GOG_AUTH_MODE, undefined);
      assert.equal(options.env.GOG_CONFIG_DIR, undefined);
      assert.equal(options.shell, false);
      assert.equal(args[args.indexOf('-a') + 1], 'jobs@example.test');
      assert.equal(args[args.indexOf('--to') + 1], 'recruiter@example.test');
      assert.equal(args[args.indexOf('--reply-to-message-id') + 1], '18fa1');
      assert.ok(args.includes('--client=default') && args.includes('--enable-commands-exact=gmail.send') && args.includes('--no-input'));
      assert.ok(options.input.length > 0);
      // Exact pinned gog protocol: internal/cmd/gmail_compose.go,
      // gmailMessageResultJSON (not text-mode message_id/thread_id labels).
      return JSON.stringify({ messageId: '18fa2', threadId: '18fa0' });
    };
    const Database = require('better-sqlite3');
    const { sendApproved, readSendAttempt } = require('./lib/email-send-live');
    const db = new Database(process.argv[1] + '/jobtrack.db');
    assert.equal(sendApproved(db, { home: process.argv[1], approvalId: process.argv[2] }).outcome, 'sent');
    assert.equal(readSendAttempt(process.argv[1], process.argv[2]).status, 'receipt_persisted');
    assert.equal(sendApproved(db, { home: process.argv[1], approvalId: process.argv[2] }).alreadySent, true);
    assert.equal(calls, 1);
    db.close();
  `;
  const result = spawnSync(process.execPath, ['-e', program, home, approvalId], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db'),
      GOG_ACCESS_TOKEN: 'test-untrusted-token', GOG_AUTH_MODE: 'adc', GOG_CONFIG_DIR: '/test-wrong-root' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_email_send_receipt_correlations_v2').get().n, 1);
});

test('send-approved accepts the documented short provider names as aliases of the registry ids', () => {
  const { resolveProviderName } = require('../lib/email-send-live');
  assert.equal(resolveProviderName('gog'), 'gog_gmail');
  assert.equal(resolveProviderName('gog_gmail'), 'gog_gmail');
  assert.equal(resolveProviderName('apple-mail'), 'apple_mail_automation');
  assert.equal(resolveProviderName(undefined), 'gog_gmail');
  assert.equal(resolveProviderName('carrier-pigeon'), 'carrier-pigeon', 'unknown names stay unknown and are refused downstream');
});

test('gog gets the exact approved subject and one threading anchor: message id wins over thread fallback', () => {
  const { gogSendArgs } = require('../lib/email-send-live');
  const base = { account: 'applicant@umich.test', recipient: 'careers@mydrove.test', subject: 'Re: Interview invitation' };
  const both = gogSendArgs({ ...base, gmailThreadId: 't1', replyToMessageId: 'm1' });
  assert.deepEqual(both.slice(0, 2), ['gmail', 'send']);
  assert.ok(both.includes('--reply-to-message-id') && !both.includes('--thread-id'), both.join(' '));
  assert.equal(both[both.indexOf('--subject') + 1], base.subject);
  assert.ok(both.includes('--client=default'));
  assert.ok(both.includes('--enable-commands-exact=gmail.send'));
  const threadOnly = gogSendArgs({ ...base, gmailThreadId: 't1' });
  assert.ok(threadOnly.includes('--thread-id') && !threadOnly.includes('--reply-to-message-id'));
  assert.equal(threadOnly[threadOnly.indexOf('--subject') + 1], base.subject);
  const fresh = gogSendArgs(base);
  assert.deepEqual(fresh.slice(-2), ['--subject', 'Re: Interview invitation']);
  assert.ok(fresh.includes('--no-input') && fresh.includes('--json'));
});
