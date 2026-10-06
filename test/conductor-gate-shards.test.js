'use strict';
// The Conductor's ten-minute cap per command is why the gate runs the suite as
// slices (scripts/conductor-gate.sh test-shard I N). The slices must cover
// exactly the files `node --test` discovers, each once.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const gate = path.join(root, 'scripts', 'conductor-gate.sh');

function list(i, n) {
  return execFileSync('sh', [gate, 'test-shard-list', String(i), String(n)], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean);
}

test('the slices partition the discovered test files', () => {
  const all = list(1, 1);
  assert.ok(all.includes('test/conductor-gate-shards.test.js'));
  for (const n of [2, 3, 4, 7]) {
    const slices = Array.from({ length: n }, (_, k) => list(k + 1, n));
    const union = slices.flat();
    assert.equal(union.length, all.length, `N=${n}: every file once`);
    assert.deepEqual([...union].sort(), [...all].sort(), `N=${n}: the same files`);
    const sizes = slices.map((s) => s.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `N=${n}: balanced by count`);
  }
});

test('a bad slice index or count is a usage error', () => {
  for (const args of [['0', '4'], ['5', '4'], ['x', '4'], ['1', '0'], ['', '']]) {
    const r = spawnSync('sh', [gate, 'test-shard', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 64, `test-shard ${args.join(' ')}`);
  }
});
