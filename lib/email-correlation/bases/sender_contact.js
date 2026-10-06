'use strict';
const { add, addEvidence, isOpen } = require('./helpers');
module.exports = {
  name: 'sender_contact', tier: 'strong',
  run(ctx) {
    if (ctx.facts.schemaVersion !== 'job-application-email-facts.v2'
      || ctx.identity.basis !== 'contact'
      || !ctx.signals.applicationSpecific) return;
    for (const companyId of ctx.identity.companyIds) {
      const rows = ctx.store.applicationsAtCompany(companyId).filter(isOpen);
      if (rows.length) addEvidence(ctx, 'sender_contact', `company:${companyId}`);
      for (const row of rows) add(ctx, row.application_id, this.name, 0.7,
        [`Sender address is a known contact of the company (${ctx.signals.sender.address}); review required`], { companyId });
    }
  }
};
