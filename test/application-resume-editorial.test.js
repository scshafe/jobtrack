'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { postingRequirements } = require('../lib/application-resume-editorial');
const { assertNoPrivateJournalSource } = require('../lib/private-source-boundary');

test('posting requirements are derived without letting caller-selected lists omit hard qualifications', () => {
  const rows = postingRequirements([{ id: 7, kind: 'posting', content: "About the role\nOwn platform architecture\nWhat we're looking for\n8+ years\nMentor engineers\nNice to have\nEvent-driven systems\nCompensation\nSalary range\nApply for this role\nResume" }]);
  assert.deepEqual(rows.map((r) => r.text), ['Own platform architecture', '8+ years', 'Mentor engineers', 'Event-driven systems']);
  assert.equal(rows[1].id, 'posting:7:line:4');
  assert.equal(rows.at(-1).kind, 'preferred');
  assert.throws(() => postingRequirements([{ id: 8, kind: 'research', content: 'Requirements\nEasy match' }]), (e) => e.code === 'EDITORIAL_REQUIREMENTS_MISSING');
  assert.throws(() => postingRequirements([{ id: 7, kind: 'posting', content: 'Unstructured posting without recognizable requirements' }]), (e) => e.code === 'EDITORIAL_REQUIREMENTS_MISSING');
});

test('new review-file flag inherits private-source and shared-runtime boundaries', () => {
  for (const reviewFile of ['/home/user/.openclaw/workspace-private-journal/review.json', '/home/user/.openclaw/state/review.json']) {
    assert.throws(() => assertNoPrivateJournalSource({ reviewFile }, { home: '/home/user' }), (e) => e.code === 'PRIVATE_JOURNAL_SOURCE_PROHIBITED');
  }
});
