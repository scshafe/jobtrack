#!/usr/bin/env node
'use strict';

// Fixture setup only: no application commands, personal stores, or services.
// Run in a fresh process so the copy batch includes template initialization.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const repositoryRoot = path.resolve(__dirname, '..');

function parseSamples(args) {
  if (args.length === 0) return 8;
  if (args.length !== 2 || args[0] !== '--samples' || !/^(?:[2-9]|[1-9][0-9]|100)$/.test(args[1])) {
    throw new Error('Usage: node scripts/benchmark-test-store.cjs [--samples 2..100]');
  }
  return Number(args[1]);
}

function coldStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrack-benchmark-cold-'));
  const home = path.join(root, 'store');
  try {
    execFileSync(process.execPath, [path.join(repositoryRoot, 'bin/jobtrack.js'), 'init', '--json'], {
      cwd: repositoryRoot,
      env: { ...process.env, JOBTRACK_HOME: home, JOBTRACK_DB: path.join(home, 'jobtrack.db') },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000
    });
    return { root, home };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function measure(count, createStore) {
  const timings = [];
  for (let sample = 0; sample < count; sample += 1) {
    let fixture;
    try {
      const started = performance.now();
      fixture = createStore();
      timings.push(performance.now() - started);
    } finally {
      // Cleanup is outside the measured setup time for both batches.
      if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
  return timings;
}

function rounded(value) {
  return Number(value.toFixed(3));
}

function summary(timings) {
  const total = timings.reduce((sum, value) => sum + value, 0);
  const sorted = [...timings].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { samples: timings.length, totalMs: rounded(total), meanMs: rounded(total / timings.length), medianMs: rounded(median) };
}

function main(args) {
  const samples = parseSamples(args);
  const { createTestStore } = require('../test-support/migrated-store');
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  let sqlite;
  try {
    sqlite = db.prepare('SELECT sqlite_version() AS version').get().version;
  } finally {
    db.close();
  }

  const cold = measure(samples, coldStore);
  const copies = measure(samples, () => createTestStore('jobtrack-benchmark-copy-'));
  const total = (timings) => timings.reduce((sum, value) => sum + value, 0);
  process.stdout.write(`${JSON.stringify({
    scope: 'Disposable fixture setup only; excludes cleanup and test execution. Cold batch runs first; copy batch includes first template initialization.',
    toolchain: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      betterSqlite3: require('better-sqlite3/package.json').version,
      sqlite
    },
    samples,
    coldCliInit: summary(cold),
    templateCopiesIncludingInitialization: summary(copies),
    firstTemplateCopyMs: rounded(copies[0]),
    warmCopies: summary(copies.slice(1)),
    coldOverCopyRatio: rounded(total(cold) / total(copies))
  }, null, 2)}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`Test store benchmark failed: ${error.message}\n`);
  process.exitCode = 1;
}
