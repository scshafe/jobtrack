'use strict';
const { add, addEvidence, isOpen } = require('./helpers');
module.exports = {
  name: 'company_mention', tier: 'strong',
  run(ctx) {
    if (ctx.facts.schemaVersion !== 'job-application-email-facts.v2'
      || !ctx.signals.company.name
      || !ctx.signals.applicationSpecific) return;
    for (const companyId of ctx.store.companiesByName(ctx.signals.company.name)) {
      const rows = ctx.store.applicationsAtCompany(companyId).filter(isOpen);
      if (rows.length) addEvidence(ctx, 'company_mention', `company:${companyId}`);
      for (const row of rows) add(ctx, row.application_id, this.name, 0.55,
        [`Message names the company (${ctx.signals.company.name.slice(0, 80)}); review required`], { companyId });
    }
  }
};
