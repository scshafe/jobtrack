#!/usr/bin/env node
'use strict';

// Render `jobtrack fabric next --json` (on stdin) as the operator queue —
// the human-readable daily driver the fabric cron refreshes. Parked gates
// first (they wait on a person), then eligible/dispatchable work, then
// standing watches. Pure formatter: no store access, no side effects.

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let next;
  try {
    next = JSON.parse(raw);
  } catch (error) {
    process.stdout.write(`# Fabric queue\n\nUnreadable derivation: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const lines = [];
  lines.push('# Fabric queue');
  lines.push('');
  lines.push(`Generated ${next.generatedAt} — ${next.summary.subjects} subject(s): ` +
    `${next.summary.eligible} eligible, ${next.summary.parked} parked, ` +
    `${next.summary.standing} standing, ${next.summary.errors} error(s).`);
  lines.push('');

  const bucket = (predicate) => next.subjects.flatMap((subject) =>
    (subject.items || []).filter(predicate).map((item) => ({ subject, item })));

  const section = (title, rows, renderCommands) => {
    if (!rows.length) return;
    lines.push(`## ${title}`);
    lines.push('');
    for (const { subject, item } of rows) {
      const instance = item.instance ? ` (${item.instance})` : '';
      lines.push(`- **${subject.label}** — \`${item.node}\`${instance}: ${item.reason}`);
      if (renderCommands) {
        for (const command of item.commands || []) lines.push(`  - \`${command}\``);
      }
    }
    lines.push('');
  };

  section('Waiting on you (parked gates)', bucket((item) => item.status === 'parked'), true);
  section('Eligible work', bucket((item) => item.status === 'eligible'), false);
  section('Blocked (needs reconciliation or inputs)', bucket((item) => item.status === 'blocked'), true);
  section('Watching', bucket((item) => item.status === 'standing'), false);

  for (const subject of next.subjects) {
    if (subject.error) lines.push(`- ERROR deriving ${subject.subjectKind} ${subject.subjectId} (${subject.label}): ${subject.error.message}`);
    if (subject.note) lines.push(`- note: ${subject.subjectKind} ${subject.subjectId} (${subject.label}): ${subject.note}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
});
