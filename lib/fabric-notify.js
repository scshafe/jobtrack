'use strict';
// lib/fabric-notify.js — how a parked gate reaches a person (FABRIC_PLAN §9
// item 1). `fabric next` is the queue; this module diffs it against the last
// notified snapshot and pushes ONE bounded message for what is new: gates
// parked on a human, work parked as manual, blocked items, and dispatch
// budgets a pass exhausted. Unchanged queues push nothing; a person is told
// once per new item, never every tick.
//
// Channel: the house ntfy server (tailnet-only). Never throws — a push that
// cannot be delivered is reported in the result, and the snapshot is NOT
// advanced, so the next pass tells the person again.

const fs = require('node:fs');
const path = require('node:path');

const NOTIFY_SCHEMA_VERSION = 'jobtrack-fabric-notify.v1';
const DEFAULT_NTFY_BASE_URL = 'https://ntfy.colobus-stargazer.ts.net';
const MAX_LINES = 12;
const MAX_BODY_CHARS = 3000;

function attentionKey(subject, item) {
  return `${subject.subjectKind}:${subject.subjectId}:${item.node}${item.instance ? `:${item.instance}` : ''}:${item.status ?? ''}`;
}

/** Items a person must act on, from a `fabric next` derivation. Pure. */
function attentionItems(next) {
  const rows = [];
  for (const subject of next?.subjects ?? []) {
    for (const item of subject.items ?? []) {
      const parkedGate = item.kind === 'gate' && item.status === 'parked';
      const manualWork = item.kind === 'work' && (item.executor === 'manual' || item.status === 'manual');
      const blocked = item.blocked === true || item.status === 'blocked';
      if (!parkedGate && !manualWork && !blocked) continue;
      rows.push({
        key: attentionKey(subject, item),
        subjectKind: subject.subjectKind,
        subjectId: subject.subjectId,
        label: subject.label ?? `${subject.subjectKind} ${subject.subjectId}`,
        node: item.node,
        title: item.title ?? item.node,
        status: parkedGate ? 'parked' : manualWork ? 'manual' : 'blocked',
        reason: String(item.reason ?? '').slice(0, 200),
        command: Array.isArray(item.commands) && item.commands.length ? String(item.commands[0]).slice(0, 200) : null
      });
    }
  }
  return rows;
}

/**
 * What to say, given the current derivation, the last notified snapshot and
 * the last dispatch pass (for exhausted budgets). Returns the new rows, the
 * message (null when nothing is new) and the snapshot to persist once the
 * message is delivered.
 */
function deriveNotifications({ next, previous = {}, pass = null, storeLabel = 'JobTrack' }) {
  const current = attentionItems(next);
  const seen = new Set(Object.keys(previous.items ?? {}));
  const fresh = current.filter((row) => !seen.has(row.key));
  const exhausted = (pass?.skipped ?? []).map((row) => ({
    key: `budget:${row.key}`,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    label: `${row.subjectKind} ${row.subjectId}`,
    node: row.node,
    title: row.node,
    status: 'exhausted',
    reason: String(row.reason ?? '').slice(0, 200),
    command: null
  })).filter((row) => !seen.has(row.key));
  const rows = [...fresh, ...exhausted];
  const snapshot = {
    schemaVersion: NOTIFY_SCHEMA_VERSION,
    notifiedAt: new Date().toISOString(),
    items: Object.fromEntries([...current, ...exhausted].map((row) => [row.key, { status: row.status, node: row.node, subjectKind: row.subjectKind, subjectId: row.subjectId }]))
  };
  if (rows.length === 0) return { rows, message: null, snapshot };
  const verb = (row) => ({ parked: 'needs your decision', manual: 'needs you to act', blocked: 'is blocked', exhausted: 'gave up after repeated failures' })[row.status] ?? row.status;
  const lines = rows.slice(0, MAX_LINES).map((row) => `• ${row.label}: ${row.title} ${verb(row)}${row.reason ? ` — ${row.reason}` : ''}`);
  if (rows.length > MAX_LINES) lines.push(`… and ${rows.length - MAX_LINES} more`);
  const counts = rows.reduce((acc, row) => ({ ...acc, [row.status]: (acc[row.status] ?? 0) + 1 }), {});
  const title = `${storeLabel}: ${rows.length} item${rows.length === 1 ? '' : 's'} waiting on you`;
  const body = lines.join('\n').slice(0, MAX_BODY_CHARS);
  const priority = counts.exhausted || counts.blocked ? 4 : 3;
  return { rows, message: { title, body, priority, tags: ['clipboard', 'jobtrack'] }, snapshot };
}

/** POST one message to an ntfy topic. Resolves { ok, status, reason }; never throws. */
async function pushNtfy({ baseUrl = DEFAULT_NTFY_BASE_URL, topic, title, body, priority = 3, tags = [], fetchImpl = fetch, timeoutMs = 8000 }) {
  if (!topic) return { ok: false, status: null, reason: 'no topic configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        Title: String(title).replace(/[\r\n]+/g, ' ').slice(0, 200),
        Priority: String(priority),
        Tags: tags.join(','),
        'Content-Type': 'text/plain; charset=utf-8'
      },
      body: String(body),
      signal: controller.signal
    });
    return { ok: response.ok, status: response.status, reason: response.ok ? null : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, status: null, reason: String(error && error.message ? error.message : error).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

function readSnapshot(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readLastPass(fabricDir) {
  try {
    const lines = fs.readFileSync(path.join(fabricDir, 'dispatch-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    const stamp = String(last.passKey ?? '').replace(/^dispatch-/, '');
    return JSON.parse(fs.readFileSync(path.join(fabricDir, 'dispatch', stamp, 'pass.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The CLI verb: derive, diff, push, persist. `deriveNext` returns the
 * `fabric next` document for the store; env carries JOBTRACK_NTFY_TOPIC and
 * optionally JOBTRACK_NTFY_BASE_URL. With no topic the verb reports what it
 * would have said and leaves the snapshot alone (a dry channel).
 */
async function runNotifyCommand({ home, deriveNext, env = process.env, fetchImpl, now = () => new Date() }) {
  const fabricDir = path.join(home, 'fabric');
  const snapshotFile = path.join(fabricDir, 'notified.json');
  const previous = readSnapshot(snapshotFile);
  const next = deriveNext();
  const pass = readLastPass(fabricDir);
  const derived = deriveNotifications({ next, previous, pass, storeLabel: env.JOBTRACK_NTFY_LABEL || 'JobTrack' });
  const topic = env.JOBTRACK_NTFY_TOPIC?.trim() || null;
  const baseUrl = env.JOBTRACK_NTFY_BASE_URL?.trim() || DEFAULT_NTFY_BASE_URL;
  const result = {
    schemaVersion: NOTIFY_SCHEMA_VERSION,
    at: now().toISOString(),
    channel: topic ? 'ntfy' : 'none',
    newItems: derived.rows.length,
    message: derived.message,
    delivered: false,
    push: null
  };
  if (derived.message === null) {
    fs.mkdirSync(fabricDir, { recursive: true });
    fs.writeFileSync(snapshotFile, `${JSON.stringify(derived.snapshot, null, 2)}\n`);
    return result;
  }
  if (!topic) return result;
  const push = await pushNtfy({ baseUrl, topic, ...derived.message, ...(fetchImpl ? { fetchImpl } : {}) });
  result.push = push;
  if (push.ok) {
    result.delivered = true;
    fs.mkdirSync(fabricDir, { recursive: true });
    fs.writeFileSync(snapshotFile, `${JSON.stringify(derived.snapshot, null, 2)}\n`);
  }
  return result;
}

module.exports = Object.freeze({
  DEFAULT_NTFY_BASE_URL,
  NOTIFY_SCHEMA_VERSION,
  attentionItems,
  deriveNotifications,
  pushNtfy,
  runNotifyCommand
});
