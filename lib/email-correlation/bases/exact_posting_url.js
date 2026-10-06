'use strict';
const { add, addEvidence } = require('./helpers');
module.exports = {
  name: 'exact_posting_url', tier: 'exact',
  run(ctx) {
    for (const reference of (ctx.facts.postingRefs || []).filter((item) => item.url)) {
      const normalizedIds = new Set(ctx.store.normalizedPostingMatches(reference).map((match) => match.applicationId));
      const opportunity = ctx.store.opportunityMatches(reference.url);
      for (const match of opportunity) {
        if (!normalizedIds.has(match.applicationId)) add(ctx, match.applicationId, this.name, 0.97, ['Exact immutable opportunity URL']);
      }
      if (opportunity.length) addEvidence(ctx, 'opportunity_url', opportunity[0].canonical);
      const legacy = ctx.store.legacyUrlMatches(reference.url);
      for (const match of legacy) {
        if (!normalizedIds.has(match.applicationId) && !opportunity.some((row) => row.applicationId === match.applicationId)) {
          add(ctx, match.applicationId, this.name, 0.9, ['Exact legacy application job_url; normalized posting ID unavailable']);
        }
      }
      if (legacy.length) addEvidence(ctx, 'legacy_job_url', legacy[0].canonical);
    }
  }
};
