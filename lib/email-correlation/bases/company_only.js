'use strict';
const { add, addEvidence, isOpen } = require('./helpers');
module.exports = {
  name: 'company_only', tier: 'weak',
  run(ctx) {
    if (ctx.signals.roleMentions.length) return;
    if (ctx.facts.schemaVersion === 'job-application-email-facts.v2' && !ctx.signals.applicationSpecific) return;
    const existing = new Set(ctx.candidates.values().map((candidate) => candidate.applicationId));
    if (ctx.signals.company.name) {
      for (const row of ctx.store.legacyApplicationsByCompany(ctx.signals.company.name).filter(isOpen)) {
        if (existing.has(row.application_id)) continue;
        add(ctx, row.application_id, this.name, 0.35, ['Legacy company string matches; review required']);
        addEvidence(ctx, 'legacy_company', ctx.signals.company.name);
      }
    }
    if (ctx.facts.schemaVersion !== 'job-application-email-facts.v2' || !ctx.signals.subject.normalized) return;
    for (const row of ctx.store.allApplicationCatalog().filter(isOpen)) {
      if (existing.has(row.application_id)) continue;
      const name = String(row.normalized_name || row.canonical_name || '');
      if (containsWhole(ctx.signals.subject.normalized, name)) {
        add(ctx, row.application_id, this.name, 0.3, [`Subject names the company (${row.canonical_name}); review required`], { companyId: row.company_id });
        addEvidence(ctx, 'subject_company', row.canonical_name);
      }
    }
  }
};

function containsWhole(haystack, needle) {
  return needle.length >= 3 && (` ${haystack} `).includes(` ${needle} `);
}
