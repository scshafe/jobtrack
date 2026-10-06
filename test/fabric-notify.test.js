'use strict';
// Parked-gate notifications (lib/fabric-notify.js): a person hears about each
// new item once; unchanged queues push nothing; an undelivered push is retried.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { attentionItems, deriveNotifications, pushNtfy, runNotifyCommand } = require('../lib/fabric-notify');

const next = (items) => ({
  subjects: [{
    subjectKind: 'application', subjectId: 3, label: 'Anthropic — Staff Engineer',
    items
  }]
});
const parkedGate = { node: 'application.assessment-review', kind: 'gate', status: 'parked', title: 'Assessment review', reason: 'assessment recorded; review it', commands: ['jobtrack review-assessment --application-id 3 --json'] };
const eligibleWork = { node: 'application.research', kind: 'work', status: 'eligible', executor: 'agent', reason: 'no research' };
const manualWork = { node: 'application.apply', kind: 'work', status: 'parked', executor: 'manual', title: 'Drive the submission on the surface', reason: 'apply is manual' };

test('only parked gates, manual work and blocked items need a person', () => {
  const rows = attentionItems(next([parkedGate, eligibleWork, manualWork, { node: 'x', kind: 'work', status: 'eligible', blocked: true, reason: 'blocked by y' }]));
  assert.deepEqual(rows.map((row) => [row.node, row.status]), [['application.assessment-review', 'parked'], ['application.apply', 'manual'], ['x', 'blocked']]);
  assert.equal(rows[0].command, 'jobtrack review-assessment --application-id 3 --json');
});

test('a message names what is new, says nothing when nothing changed, and mentions exhausted budgets', () => {
  const first = deriveNotifications({ next: next([parkedGate]), previous: {} });
  assert.equal(first.rows.length, 1);
  assert.equal(first.message.title, 'JobTrack: 1 item waiting on you');
  assert.match(first.message.body, /Anthropic — Staff Engineer: Assessment review needs your decision — assessment recorded; review it/u);
  const again = deriveNotifications({ next: next([parkedGate]), previous: first.snapshot });
  assert.equal(again.message, null, 'an item already told is not repeated');
  const more = deriveNotifications({ next: next([parkedGate, manualWork]), previous: first.snapshot, pass: { skipped: [{ key: 'opportunity.triage:opportunity:9', node: 'opportunity.triage', subjectKind: 'opportunity', subjectId: 9, reason: 'budget exhausted (2/2)' }] } });
  assert.equal(more.rows.length, 2);
  assert.match(more.message.body, /needs you to act/u);
  assert.match(more.message.body, /gave up after repeated failures — budget exhausted/u);
  assert.equal(more.message.priority, 4);
  const cleared = deriveNotifications({ next: next([]), previous: more.snapshot });
  assert.equal(cleared.message, null);
  assert.deepEqual(Object.keys(cleared.snapshot.items), []);
});

test('pushNtfy posts the house wire shape and never throws', async () => {
  const calls = [];
  const ok = await pushNtfy({ baseUrl: 'https://ntfy.example.test/', topic: 'jobtrack-example-topic', title: 'T\nx', body: 'b', priority: 4, tags: ['a', 'b'], fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; } });
  assert.deepEqual(ok, { ok: true, status: 200, reason: null });
  assert.equal(calls[0].url, 'https://ntfy.example.test/jobtrack-example-topic');
  assert.equal(calls[0].init.headers.Title, 'T x');
  assert.equal(calls[0].init.headers.Priority, '4');
  assert.equal(calls[0].init.headers.Tags, 'a,b');
  const failed = await pushNtfy({ topic: 't', title: 't', body: 'b', fetchImpl: async () => { throw new Error('down'); } });
  assert.deepEqual(failed, { ok: false, status: null, reason: 'down' });
  assert.equal((await pushNtfy({ topic: '', title: 't', body: 'b' })).reason, 'no topic configured');
});

test('the verb persists the snapshot only after delivery, and reports a dry channel without a topic', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-notify-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const deriveNext = () => next([parkedGate]);
  const dry = await runNotifyCommand({ home, deriveNext, env: {} });
  assert.equal(dry.channel, 'none');
  assert.equal(dry.newItems, 1);
  assert.equal(dry.delivered, false);
  assert.equal(fs.existsSync(path.join(home, 'fabric', 'notified.json')), false, 'no topic: the person has not been told, so nothing is marked told');
  let attempts = 0;
  const flaky = async () => { attempts += 1; return attempts === 1 ? { ok: false, status: 503 } : { ok: true, status: 200 }; };
  const first = await runNotifyCommand({ home, deriveNext, env: { JOBTRACK_NTFY_TOPIC: 'jobtrack-example-topic' }, fetchImpl: flaky });
  assert.equal(first.delivered, false);
  assert.equal(first.push.reason, 'HTTP 503');
  assert.equal(fs.existsSync(path.join(home, 'fabric', 'notified.json')), false, 'an undelivered push is not marked told');
  const second = await runNotifyCommand({ home, deriveNext, env: { JOBTRACK_NTFY_TOPIC: 'jobtrack-example-topic' }, fetchImpl: flaky });
  assert.equal(second.delivered, true);
  assert.ok(fs.existsSync(path.join(home, 'fabric', 'notified.json')));
  const third = await runNotifyCommand({ home, deriveNext, env: { JOBTRACK_NTFY_TOPIC: 'jobtrack-example-topic' }, fetchImpl: async () => { throw new Error('must not push'); } });
  assert.equal(third.newItems, 0);
  assert.equal(third.message, null);
});
