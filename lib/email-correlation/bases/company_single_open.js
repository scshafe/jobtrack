'use strict';
const { add, addEvidence, isOpen } = require('./helpers');
module.exports = {
  name: 'company_single_open', tier: 'strong',
  run(ctx) {
    if (ctx.facts.schemaVersion !== 'job-application-email-facts.v2'
      || ctx.identity.companyIds.length !== 1
      || !ctx.signals.applicationSpecific) return;
    const companyId = ctx.identity.companyIds[0];
    const open = ctx.store.applicationsAtCompany(companyId).filter(isOpen);
    if (open.length !== 1) return;
    add(ctx, open[0].application_id, this.name, 0.8,
      ['The identified company has exactly one open application; linked for agent review'], { companyId });
    addEvidence(ctx, 'company_single_open', `company:${companyId}:application:${open[0].application_id}`);
  }
};
