'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { isProtectedApplicationField } = require('../lib/application-field-safety');

test('shared application-field classifier keeps ordinary prompts visible and factual or sensitive prompts protected', () => {
  assert.equal(isProtectedApplicationField({
    sensitivity: 'standard', input_kind: 'long-text', label: 'Why are you interested in this role?'
  }), false);
  assert.equal(isProtectedApplicationField({
    sensitivity: 'standard', input_kind: 'long-text', label: 'What were your initial thoughts about the project?'
  }), false);

  for (const field of [
    { sensitivity: 'standard', input_kind: 'short-text', label: 'Passport number' },
    { sensitivity: 'standard', input_kind: 'short-text', provider_field_key: 'bankRoutingNumber' },
    { sensitivity: 'standard', input_kind: 'short-text', help_text: 'Enter your date of birth' },
    { sensitivity: 'standard', input_kind: 'email', label: 'Contact' },
    { sensitivity: 'personal', input_kind: 'long-text', label: 'Details' }
  ]) {
    assert.equal(isProtectedApplicationField(field), true, JSON.stringify(field));
  }
});
