'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_INPUT_BYTES,
  EmailCommunicationError,
  importDemeanorObservation,
  recordContactBinding,
  recordCompanyContact,
  buildEmailCommunicationContext,
  createStyleProfile,
  reviewStyleProfile,
  selectStyleProfile,
  createWritingVoiceRevision,
  reviewWritingVoiceRevision,
  selectWritingVoiceRevision,
  createToneDecision
} = require('./email-communication');

const EMAIL_COMMUNICATION_COMMAND_FLAGS = Object.freeze({
  'communication-context': [
    'provider', 'accountId', 'messageId', 'threadId', 'observationIds',
    'styleProfileId', 'voiceRevisionId', 'contactId'
  ],
  'import-demeanor': ['input', 'idempotencyKey'],
  'bind-contact': [
    'messageRefId', 'companyContactId', 'email', 'decision', 'actor', 'reason',
    'expectedPriorEventId', 'idempotencyKey'
  ],
  'record-contact': [
    'messageRefId', 'companyId', 'name', 'email', 'roleTitle', 'source', 'idempotencyKey'
  ],
  'propose-style-profile': ['input', 'idempotencyKey'],
  'review-style-profile': ['profileId', 'decision', 'reviewedBy', 'notes', 'idempotencyKey'],
  'select-style-profile': ['profileId', 'selectedBy', 'expectedCurrentProfileId', 'idempotencyKey'],
  'create-writing-voice': ['input', 'idempotencyKey'],
  'review-writing-voice': ['revisionId', 'decision', 'reviewedBy', 'notes', 'idempotencyKey'],
  'select-writing-voice': ['revisionId', 'selectedBy', 'expectedCurrentRevisionId', 'idempotencyKey'],
  'propose-tone': ['input', 'idempotencyKey']
});

function isEmailCommunicationAction(action) {
  return Object.prototype.hasOwnProperty.call(EMAIL_COMMUNICATION_COMMAND_FLAGS, action);
}

function assertEmailCommunicationCommandFlags(action, flags) {
  const schema = EMAIL_COMMUNICATION_COMMAND_FLAGS[action];
  if (!schema) throw new EmailCommunicationError('UNKNOWN_COMMAND', `Unknown email communication action: ${action || '(missing)'}`);
  const allowed = new Set(schema);
  const unknown = Object.keys(flags).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new EmailCommunicationError(
      'INVALID_ARGUMENT',
      `Unknown flag(s) for email ${action}: ${unknown.sort().map(toFlag).join(', ')}`
    );
  }
}

function runEmailCommunicationCommand(db, action, flags = {}) {
  assertEmailCommunicationCommandFlags(action, flags);
  if (action === 'communication-context') {
    return {
      context: buildEmailCommunicationContext(db, {
        source: {
          provider: flags.provider,
          accountId: flags.accountId,
          messageId: flags.messageId,
          threadId: flags.threadId
        },
        observationIds: flags.observationIds,
        styleProfileId: flags.styleProfileId,
        voiceRevisionId: flags.voiceRevisionId,
        contactId: flags.contactId
      })
    };
  }
  if (action === 'import-demeanor') {
    return importDemeanorObservation(db, readJson(flags.input), required(flags.idempotencyKey, '--idempotency-key'));
  }
  if (action === 'bind-contact') {
    return recordContactBinding(db, {
      messageRefId: flags.messageRefId,
      companyContactId: flags.companyContactId,
      email: flags.email,
      decision: flags.decision,
      actor: flags.actor,
      reason: flags.reason,
      expectedPriorEventId: flags.expectedPriorEventId,
      idempotencyKey: flags.idempotencyKey
    });
  }
  if (action === 'record-contact') {
    return recordCompanyContact(db, {
      messageRefId: flags.messageRefId,
      companyId: flags.companyId,
      name: flags.name,
      email: flags.email,
      roleTitle: flags.roleTitle,
      source: flags.source,
      idempotencyKey: flags.idempotencyKey
    });
  }
  if (action === 'propose-style-profile') {
    return createStyleProfile(db, readJson(flags.input), required(flags.idempotencyKey, '--idempotency-key'));
  }
  if (action === 'review-style-profile') return reviewStyleProfile(db, flags);
  if (action === 'select-style-profile') return selectStyleProfile(db, flags);
  if (action === 'create-writing-voice') {
    return createWritingVoiceRevision(db, readJson(flags.input), required(flags.idempotencyKey, '--idempotency-key'));
  }
  if (action === 'review-writing-voice') return reviewWritingVoiceRevision(db, flags);
  if (action === 'select-writing-voice') return selectWritingVoiceRevision(db, flags);
  if (action === 'propose-tone') {
    return createToneDecision(db, readJson(flags.input), required(flags.idempotencyKey, '--idempotency-key'));
  }
  throw new EmailCommunicationError('UNKNOWN_COMMAND', `Unknown email communication action: ${action}`);
}

function readJson(value) {
  const filename = path.resolve(required(value, '--input'));
  const stat = fs.statSync(filename);
  if (!stat.isFile()) throw new EmailCommunicationError('INVALID_INPUT', '--input must identify a regular JSON file');
  if (stat.size > MAX_INPUT_BYTES) throw new EmailCommunicationError('INPUT_TOO_LARGE', `--input exceeds ${MAX_INPUT_BYTES} bytes`);
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    throw new EmailCommunicationError('INVALID_JSON', '--input must contain valid JSON');
  }
}

function required(value, label) {
  if (value === undefined || value === null || value === '') throw new EmailCommunicationError('INVALID_ARGUMENT', `Missing required ${label}`);
  return String(value);
}

function toFlag(key) {
  return `--${key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`;
}

module.exports = {
  EMAIL_COMMUNICATION_COMMAND_FLAGS,
  isEmailCommunicationAction,
  assertEmailCommunicationCommandFlags,
  runEmailCommunicationCommand
};
