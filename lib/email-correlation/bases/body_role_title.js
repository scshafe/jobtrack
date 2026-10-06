'use strict';
const { add, addEvidence, addRoleTitleMatchEvidence, isOpen, normalizedTitlesFor, titleSimilarity } = require('./helpers');
module.exports = {
  name: 'body_role_title', tier: 'strong',
  run(ctx) {
    if (ctx.facts.schemaVersion !== 'job-application-email-facts.v2' || ctx.identity.companyIds.length !== 1) return;
    const mentions = ctx.signals.roleMentions.filter((mention) => mention.groundedBodyExcerpts.length > 0);
    if (!mentions.length) return;
    const companyId = ctx.identity.companyIds[0];
    for (const row of ctx.store.applicationsAtCompany(companyId).filter(isOpen)) {
      let best = null;
      for (const mention of mentions) {
        for (const title of normalizedTitlesFor(ctx, row)) {
          const similarity = titleSimilarity(mention.normalized, title);
          if (!best || similarity > best.similarity) best = { mention, title, similarity };
        }
      }
      if (!best || best.similarity < ctx.policy.thresholds.titleSimilarity) continue;
      add(ctx, row.application_id, this.name, Math.min(0.95, 0.7 + (best.similarity * 0.25)), [
        `Grounded body role wording matches ${row.canonical_title || row.normalized_title} (${best.similarity.toFixed(2)} similarity); review required`
      ], { companyId });
      addRoleTitleMatchEvidence(ctx, row.application_id, best.mention);
      addEvidence(ctx, 'body_role_title', best.mention.groundedBodyExcerpts[0].excerpt);
    }
  }
};
