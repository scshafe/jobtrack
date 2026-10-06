'use strict';

const {
  ProfileNormalizationError,
  assessInformationRequest,
  assignTag,
  getInformationGaps,
  listInformationFields,
  listInformationRequests,
  listTags,
  markInformationRequest,
  removeTag
} = require('./profile-normalization');

const INFO_REQUEST_FLAGS = Object.freeze({
  mark: ['applicationId', 'opportunityId', 'field', 'requiredness', 'requestedLabel', 'rawPrompt', 'source', 'sourceUrl', 'snapshotId', 'postingId', 'observedAt', 'idempotencyKey'],
  assess: ['applicationId', 'opportunityId', 'requestId', 'state', 'assessment', 'profileEntryId', 'assessedBy', 'assessedAt', 'expectedAssessmentId', 'rationale', 'evidence', 'idempotencyKey'],
  resolve: ['applicationId', 'opportunityId', 'requestId', 'profileEntryId', 'assessedBy', 'assessedAt', 'expectedAssessmentId', 'rationale', 'evidence', 'idempotencyKey'],
  list: ['applicationId', 'opportunityId', 'state', 'assessment'],
  fields: []
});
const GAP_FLAGS = ['applicationId', 'opportunityId'];
const TAG_FLAGS = Object.freeze({
  assign: ['profileEntryId', 'applicationId', 'openingId', 'opportunityId', 'proposalId', 'namespace', 'tag', 'tagSource', 'source', 'confidence', 'evidence'],
  remove: ['profileEntryId', 'applicationId', 'openingId', 'opportunityId', 'proposalId', 'namespace', 'tag'],
  list: ['profileEntryId', 'applicationId', 'openingId', 'opportunityId', 'proposalId', 'namespace']
});

function assertProfileNormalizationCommandFlags(command, args, flags) {
  let allowed;
  let scope;
  if (command === 'tag') {
    const action = args[0];
    allowed = TAG_FLAGS[action];
    scope = `tag ${action || '(missing)'}`;
  } else if (command === 'profile' && args[0] === 'info-request') {
    const action = args[1];
    allowed = INFO_REQUEST_FLAGS[action];
    scope = `profile info-request ${action || '(missing)'}`;
  } else if (command === 'profile' && args[0] === 'gaps') {
    allowed = GAP_FLAGS;
    scope = 'profile gaps';
  } else {
    return false;
  }
  if (!allowed) throw new ProfileNormalizationError('UNKNOWN_COMMAND', `Unknown ${scope}`);
  const accepted = new Set(allowed);
  const unknown = Object.keys(flags).filter((key) => !accepted.has(key));
  if (unknown.length) {
    throw new ProfileNormalizationError('INVALID_ARGUMENT', `Unknown flag(s) for ${scope}: ${unknown.sort().map(toFlag).join(', ')}`);
  }
  return true;
}

function runTagCommand(db, args, flags) {
  if (args.length !== 1) throw new ProfileNormalizationError('INVALID_ARGUMENT', 'Use exactly one tag action');
  const action = args[0];
  assertProfileNormalizationCommandFlags('tag', args, flags);
  if (action === 'assign') return assignTag(db, { ...flags, source: flags.tagSource || flags.source });
  if (action === 'remove') return removeTag(db, flags);
  if (action === 'list') return { tags: listTags(db, flags) };
  throw new ProfileNormalizationError('UNKNOWN_COMMAND', `Unknown tag action: ${action}`);
}

function runProfileNormalizationCommand(db, args, flags) {
  const group = args[0];
  if (group === 'gaps') {
    if (args.length !== 1) throw new ProfileNormalizationError('INVALID_ARGUMENT', 'profile gaps accepts no positional arguments');
    assertProfileNormalizationCommandFlags('profile', args, flags);
    return getInformationGaps(db, flags);
  }
  if (group !== 'info-request') throw new ProfileNormalizationError('UNKNOWN_COMMAND', `Unknown normalized profile command: ${group}`);
  if (args.length !== 2) throw new ProfileNormalizationError('INVALID_ARGUMENT', 'Use exactly one profile info-request action');
  const action = args[1];
  assertProfileNormalizationCommandFlags('profile', args, flags);
  if (action === 'mark') return markInformationRequest(db, flags);
  if (action === 'assess') return assessInformationRequest(db, flags);
  if (action === 'resolve') return assessInformationRequest(db, { ...flags, state: 'available' });
  if (action === 'list') return { requests: listInformationRequests(db, flags) };
  if (action === 'fields') return { fields: listInformationFields(db) };
  throw new ProfileNormalizationError('UNKNOWN_COMMAND', `Unknown profile info-request action: ${action}`);
}

function toFlag(key) {
  return `--${key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`;
}

module.exports = {
  assertProfileNormalizationCommandFlags,
  runProfileNormalizationCommand,
  runTagCommand
};
