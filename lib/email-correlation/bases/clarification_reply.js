'use strict';

const { matchClarificationReply } = require('../clarify');
const { add, addEvidence, addRoleTitleMatchEvidence } = require('./helpers');

module.exports = {
  name: 'clarification_reply', tier: 'exact',
  run(ctx) {
    if (ctx.facts.schemaVersion !== 'job-application-email-facts.v2') return;
    const open = ctx.store.pendingClarificationsForMessage(ctx.facts)
      .filter((clarification) => clarification.matchScope !== 'reference'
        || (ctx.identity.companyIds.length === 1
          && ctx.identity.companyIds[0] === clarification.companyId));
    const match = matchClarificationReply(ctx.signals, open);
    if (!match) return;
    add(ctx, match.applicationId, this.name, 1, [
      `Reply names exactly one title offered by clarification ${match.clarificationId}`
    ], { companyId: match.companyId });
    addRoleTitleMatchEvidence(ctx, match.applicationId, match.mention);
    addEvidence(ctx, 'clarification_reply', match.clarificationId);
    addEvidence(ctx, 'body_role_title', match.excerpt);
  }
};
