'use strict';
const { add, addEvidence, isOpen } = require('./helpers');
module.exports = {
  name: 'company_domain', tier: 'strong',
  run(ctx) {
    if (ctx.facts.schemaVersion !== 'job-application-email-facts.v2' || !ctx.signals.applicationSpecific) return;
    const companyIds = new Set();
    if (ctx.identity.domainClass === 'corporate') {
      for (const companyId of ctx.store.companiesByDomain(ctx.signals.sender.domain)) companyIds.add(companyId);
    }
    for (const companyId of ctx.store.companiesByDomain(ctx.signals.company.domain)) companyIds.add(companyId);
    for (const companyId of companyIds) {
      const rows = ctx.store.applicationsAtCompany(companyId).filter(isOpen);
      if (rows.length) addEvidence(ctx, 'company_domain', `company:${companyId}`);
      for (const row of rows) add(ctx, row.application_id, this.name, 0.5,
        ['Sender domain matches the company domain; review required'], { companyId });
    }
  }
};
