'use strict';
const { add, addEvidence } = require('./helpers');
module.exports = {
  name: 'exact_posting_occurrence', tier: 'exact',
  run(ctx) {
    for (const reference of ctx.facts.postingRefs || []) {
      const matches = ctx.store.normalizedPostingMatches(reference);
      for (const match of matches) add(ctx, match.applicationId, this.name, 1, ['Exact normalized posting occurrence'], match);
      for (const posting of new Set(matches.map((match) => match.postingId))) addEvidence(ctx, 'normalized_posting', `job_posting:${posting}`);
    }
  }
};
