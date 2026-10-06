'use strict';
module.exports = {
  name: 'recency', tier: 'modifier',
  run(ctx) {
    if (ctx.facts.schemaVersion !== 'job-application-email-facts.v2') return;
    const received = Date.parse(ctx.facts.source.receivedAt);
    if (!Number.isFinite(received)) return;
    const windowMs = ctx.policy.thresholds.recencyDays * 86400000;
    for (const candidate of ctx.candidates.values()) {
      const application = ctx.store.application(candidate.applicationId);
      const activity = Date.parse(application?.status_changed_at || application?.updated_at || application?.created_at || '');
      if (!Number.isFinite(activity) || activity > received || received - activity > windowMs) continue;
      candidate.confidence = Math.min(1, candidate.confidence + ctx.policy.thresholds.recencyBoost);
      candidate.reasons = [...new Set([...candidate.reasons, `Application activity is within ${ctx.policy.thresholds.recencyDays} days of the message`])].slice(0, 10);
    }
  }
};
