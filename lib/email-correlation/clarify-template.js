'use strict';

const TEMPLATE_ID = 'email-clarification-question.v2';

// Fixed local text, not a model/runner invocation and never a mailbox effect.
function questionFor(titles, applicantName, reference = null) {
  const choices = titles.length === 2
    ? `${titles[0]} or ${titles[1]}`
    : `${titles.slice(0, -1).join(', ')}, or ${titles.at(-1)}`;
  const normalizedReference = String(reference || '').trim().toUpperCase();
  const referenceLine = /^[A-Z]{2,6}-[0-9A-Z]{3,12}$/.test(normalizedReference)
    ? `\n\nConversation reference: [${normalizedReference}]`
    : '';
  return `Hi,\n\nHappy to — could you confirm which role this is regarding, ${choices}?${referenceLine}\n\nBest regards,\n${applicantName}`;
}

module.exports = { TEMPLATE_ID, questionFor };
