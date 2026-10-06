'use strict';
const { normalizeMentionText } = require('../normalize');
const { add, addEvidence, isOpen, normalizedTitlesFor } = require('./helpers');

module.exports = {
  name: 'company_and_role', tier: 'strong',
  run(ctx) {
    const mentioned = new Set(ctx.signals.roleMentions.map((item) => item.normalized));
    const seen = new Set();
    if (ctx.facts.schemaVersion === 'job-application-email-facts.v2' && mentioned.size) {
      for (const companyId of ctx.identity.companyIds) {
        for (const row of ctx.store.applicationsAtCompany(companyId).filter(isOpen)) {
          if (!normalizedTitlesFor(ctx, row).some((title) => mentioned.has(title))) continue;
          add(ctx, row.application_id, this.name, 0.65,
            ['Company identity and opening title match an email role reference; review required'], { companyId });
          seen.add(row.application_id);
          addEvidence(ctx, 'company_role', `company:${companyId} / ${row.canonical_title || row.normalized_title}`);
        }
      }
    }
    if (ctx.signals.company.name && mentioned.size) {
      for (const row of ctx.store.legacyApplicationsByCompany(ctx.signals.company.name).filter(isOpen)) {
        if (seen.has(row.application_id) || !mentioned.has(normalizeMentionText(row.role))) continue;
        add(ctx, row.application_id, this.name, 0.65, ['Legacy company and role strings match; review required']);
        addEvidence(ctx, 'legacy_company_role', `${ctx.signals.company.name} / ${row.role}`);
      }
    }
    if (ctx.facts.schemaVersion !== 'job-application-email-facts.v2' || !ctx.signals.subject.normalized) return;
    for (const row of ctx.store.allApplicationCatalog().filter(isOpen)) {
      const company = normalizeMentionText(row.normalized_name || row.canonical_name);
      const title = normalizeMentionText(row.normalized_title || row.canonical_title);
      if (company.length < 3 || title.length < 3
        || !containsWhole(ctx.signals.subject.normalized, company)
        || !ctx.signals.subject.normalized.includes(title)) continue;
      add(ctx, row.application_id, this.name, 0.6,
        [`Subject names the company (${row.canonical_name}) and the opening title; review required`], { companyId: row.company_id });
      addEvidence(ctx, 'subject_company_role', `${row.canonical_name} / ${row.canonical_title}`);
    }
  }
};

function containsWhole(haystack, needle) {
  return (` ${haystack} `).includes(` ${needle} `);
}
