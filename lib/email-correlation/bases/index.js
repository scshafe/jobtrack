'use strict';

const registry = Object.freeze([
  require('./clarification_reply'),
  require('./provider_application_id'),
  require('./previously_linked_message'),
  require('./previously_linked_thread'),
  require('./exact_posting_occurrence'),
  require('./exact_posting_url'),
  require('./sender_contact'),
  require('./company_domain'),
  require('./company_mention'),
  require('./body_role_title'),
  require('./company_and_role'),
  require('./company_single_open'),
  require('./company_only'),
  require('./fuzzy'),
  require('./stage_consistency'),
  require('./recency')
]);

function runBases(ctx) {
  for (const basis of registry) basis.run(ctx);
}

module.exports = { registry, runBases };
