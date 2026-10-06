'use strict';
const { normalizeMentionText } = require('../normalize');
const { add, addEvidence, isOpen } = require('./helpers');
const AFFIXES = new Set(['my','get','go','join','the','try','use','meet','with','hq','team','hello','hi','jobs','careers','talent','recruiting','hr','app','io','labs','inc','co','corp','work','mail','email','notify','notifications']);
module.exports = {
  name: 'fuzzy', tier: 'weak',
  run(ctx) {
    if (ctx.facts.schemaVersion !== 'job-application-email-facts.v2' || !ctx.signals.applicationSpecific) return;
    const labels = normalizeMentionText(ctx.signals.sender.domain.split('.').slice(0, -1).join(' ')).split(' ').filter(Boolean);
    const existing = new Set(ctx.candidates.values().map((candidate) => candidate.applicationId));
    for (const row of ctx.store.allApplicationCatalog().filter(isOpen)) {
      if (existing.has(row.application_id)) continue;
      const name = normalizeMentionText(row.normalized_name || row.canonical_name);
      if (name.includes(' ') || name.length < 4 || !labels.some((label) => senderLabelNamesCompany(label, name))) continue;
      add(ctx, row.application_id, this.name, 0.25, [`Sender domain contains the company name (${row.canonical_name}); review required`], { companyId: row.company_id });
      addEvidence(ctx, 'sender_domain_mention', row.canonical_name);
    }
  }
};
function senderLabelNamesCompany(label, name) {
  if (label === name) return true;
  if (label.startsWith(name)) return AFFIXES.has(label.slice(name.length));
  if (label.endsWith(name)) return AFFIXES.has(label.slice(0, label.length - name.length));
  return false;
}
