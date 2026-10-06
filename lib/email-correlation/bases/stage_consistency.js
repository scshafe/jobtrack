'use strict';
const EXPECTED = Object.freeze({
  application_received: new Set(['applied']),
  interview_invite: new Set(['interviewing']),
  interview_rescheduled: new Set(['interviewing']),
  interview_cancelled: new Set(['interviewing']),
  offer: new Set(['interviewing', 'offer']),
  withdrawal_confirmed: new Set(['withdrawn'])
});
module.exports = {
  name: 'stage_consistency', tier: 'modifier',
  run(ctx) {
    if (ctx.facts.schemaVersion !== 'job-application-email-facts.v2') return;
    const expected = EXPECTED[ctx.facts.eventKind];
    if (!expected) return;
    for (const candidate of ctx.candidates.values()) {
      const status = ctx.store.application(candidate.applicationId)?.status;
      if (!status) continue;
      if (expected.has(status)) {
        candidate.confidence = Math.min(1, candidate.confidence + ctx.policy.thresholds.stageBoost);
        candidate.reasons = [...new Set([...candidate.reasons, `${ctx.facts.eventKind} is consistent with application status ${status}`])].slice(0, 10);
      } else if (ctx.facts.eventKind === 'offer' && status === 'applied') {
        candidate.confidence = Math.max(0, candidate.confidence - ctx.policy.thresholds.stagePenalty);
        candidate.reasons = [...new Set([...candidate.reasons, `offer is less consistent with application status ${status}`])].slice(0, 10);
      }
    }
  }
};
