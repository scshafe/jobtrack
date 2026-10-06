'use strict';

// The route table: the whole HTTP surface of JobTrack web.
//
// GET and HEAD only. Every other method gets a 405 with an Allow header and a
// page that names the CLI as the sole writer — this is not an oversight to be
// filled in later, it is the design: the web view reads a query_only snapshot
// and there is no code path here that can write to the store.
//
// The security headers are set once, before anything else, and the CSP is
// deliberately severe: default-src 'none' with only inline styles allowed, no
// script source at all. A page that cannot execute script cannot be turned
// into an exfiltration channel by anything the store happens to contain, which
// matters because much of what it contains was written by someone else.
//
// Errors leave by one door. A filter rejection carries a public message and
// becomes a 400; a missing record becomes a 404; anything else becomes a
// generic 500 whose text says nothing about the store — the detail goes to the
// server log, not to the page.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');

const { JOBTRACK_HOME, getDb } = require('./store');
const { navMiddleware } = require('./nav');
const {
  APPLICATION_STATUSES,
  WORKFLOW_STAGES,
  OPPORTUNITY_STATES,
  DISCOVERY_STATUSES,
  STORY_STATUSES,
  PIPELINE_STATUSES,
  readCollectionContext
} = require('./filters');
const { buildQueryUrl } = require('./toolbar');
const { sortApplications } = require('./read-model/rows');
const {
  listApplications,
  readApplicationWorkspace,
  readApplicationMaterial,
  readApplicationQuestion,
  listPipelineItems,
  sortPipelineItems
} = require('./read-model/applications');
const { readCommunicationsModel } = require('./read-model/communications');
const {
  listOpportunities,
  listDiscoveryProposals,
  readDiscoveryProposal,
  readOpportunity,
  listOpenings,
  readOpening,
  listInterviewQueue,
  readInterviewPrep
} = require('./read-model/positions');
const { listProfileCorpus, readStory } = require('./read-model/profile');
const { renderMessagePage } = require('./render/shell');
const {
  renderPipelinePage,
  renderApplicationsPage,
  renderDiscoveryProposalsPage,
  renderOpeningsPage,
  renderInterviewsPage,
  renderOpportunitiesPage
} = require('./render/collections');
const {
  renderApplicationWorkspacePage,
  renderApplicationMaterialPage,
  renderApplicationQuestionPage
} = require('./render/application');
const {
  renderDiscoveryProposalPage,
  renderOpeningPage,
  renderInterviewPrepPage,
  renderOpportunityPage,
  renderStoryPage
} = require('./render/detail');
const { renderReplyLifecyclePage } = require('./render/reply-lifecycle');
const { PROFILE_SECTION_DEFS, renderProfilePage } = require('./render/profile');

const app = express();

app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; frame-src 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin'
  });
  next();
});

app.use(navMiddleware);

app.get('/', (req, res, next) => {
  try {
    const context = readCollectionContext(req, {
      scope: 'pipeline',
      statusOptions: PIPELINE_STATUSES,
      defaultSort: 'latest',
      includeWorkflow: false
    });
    const items = sortPipelineItems(listPipelineItems(context.filters), context.sort, context.dir);
    res.type('html').send(renderPipelinePage({ items, ...context }));
  } catch (error) {
    next(error);
  }
});

app.get('/applications', (req, res, next) => {
  try {
    const context = readCollectionContext(req, {
      scope: 'applications',
      statusOptions: APPLICATION_STATUSES,
      workflowOptions: WORKFLOW_STAGES,
      defaultSort: 'latest'
    });
    const applications = sortApplications(listApplications(context.filters, { scope: 'applications', pipeline: true }), context.sort, context.dir);
    res.type('html').send(renderApplicationsPage({ applications, ...context }));
  } catch (error) {
    next(error);
  }
});

app.get('/applications/:id', (req, res, next) => {
  try {
    const id = positiveRouteId(req.params.id);
    const workspace = readApplicationWorkspace(id);
    if (!workspace) {
      res.status(404).type('html').send(renderMessagePage('Application not found', 'The requested application does not exist.'));
      return;
    }
    res.type('html').send(renderApplicationWorkspacePage(workspace));
  } catch (error) {
    next(error);
  }
});

app.get('/applications/:id/materials', (req, res, next) => {
  try {
    const id = positiveRouteId(req.params.id);
    if (!readApplicationWorkspace(id)) {
      res.status(404).type('html').send(renderMessagePage('Application not found', 'The requested application does not exist.'));
      return;
    }
    res.redirect(302, `/applications/${id}#materials`);
  } catch (error) {
    next(error);
  }
});

app.get('/applications/:applicationId/materials/:materialId', (req, res, next) => {
  try {
    const applicationId = positiveRouteId(req.params.applicationId);
    const materialId = positiveRouteId(req.params.materialId);
    const material = readApplicationMaterial(applicationId, materialId);
    if (!material) {
      res.status(404).type('html').send(renderMessagePage('Material revision not found', 'The requested material revision does not exist for this application.'));
      return;
    }
    res.type('html').send(renderApplicationMaterialPage(material));
  } catch (error) {
    next(error);
  }
});

// The authoritative render: stream a material revision's digest-pinned PDF.
// Read-only like everything here; bytes are re-hashed against the recorded
// output SHA-256 before a single byte is served.
app.get('/applications/:applicationId/material-renders/:renderId.pdf', (req, res, next) => {
  try {
    const applicationId = positiveRouteId(req.params.applicationId);
    const renderId = positiveRouteId(req.params.renderId);
    const row = getDb().prepare(`
      SELECT output_attachment_path, output_sha256
      FROM application_material_renders
      WHERE id=? AND application_id=?
    `).get(renderId, applicationId);
    const filePath = row ? resolveStoreAttachmentPath(row.output_attachment_path) : null;
    if (!filePath) {
      res.status(404).type('html').send(renderMessagePage('Render not found', 'No such rendered PDF for this application.'));
      return;
    }
    const bytes = fs.readFileSync(filePath);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== row.output_sha256) {
      res.status(409).type('html').send(renderMessagePage('Render integrity failure', 'The stored PDF no longer matches its recorded SHA-256; refusing to serve it.'));
      return;
    }
    res.status(200)
      .set('Content-Type', 'application/pdf')
      .set('Content-Disposition', `inline; filename="application-${applicationId}-render-${renderId}.pdf"`)
      .send(bytes);
  } catch (error) {
    next(error);
  }
});

/**
 * Resolve a stored attachment path inside the CURRENT store. Render rows
 * record the absolute path at render time; when the store is mounted at a
 * different root (the read-only web container mounts it at /jobtrack), the
 * path is re-rooted at JOBTRACK_HOME by its attachments/ suffix. Anything
 * that does not resolve inside the store's attachments tree is refused.
 * @param {string|null} stored
 * @returns {string|null}
 */
function resolveStoreAttachmentPath(stored) {
  if (!stored) return null;
  const attachmentsRoot = path.join(JOBTRACK_HOME, 'attachments') + path.sep;
  const candidates = [stored];
  if (!path.isAbsolute(stored)) candidates.unshift(path.join(JOBTRACK_HOME, stored));
  const marker = `${path.sep}attachments${path.sep}`;
  const at = stored.indexOf(marker);
  if (at !== -1) candidates.push(path.join(JOBTRACK_HOME, 'attachments', stored.slice(at + marker.length)));
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(attachmentsRoot)) continue;
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

app.get('/applications/:applicationId/questions/:questionId', (req, res, next) => {
  try {
    const applicationId = positiveRouteId(req.params.applicationId);
    const questionId = positiveRouteId(req.params.questionId);
    const question = readApplicationQuestion(applicationId, questionId);
    if (!question) {
      res.status(404).type('html').send(renderMessagePage('Application question not found', 'The requested question does not exist for this application.'));
      return;
    }
    res.type('html').send(renderApplicationQuestionPage(question));
  } catch (error) {
    next(error);
  }
});

app.get('/profile', (req, res, next) => {
  try {
    const context = readCollectionContext(req, {
      scope: 'profile',
      statusOptions: STORY_STATUSES,
      positionFacets: false,
      defaultSort: 'latest'
    });
    // Tabbed sections: ?section=<key> shows one section; default 'all' is the
    // full stacked view. Unknown values fall back to 'all' rather than 404 —
    // the tab strip is the only producer of this parameter.
    const requested = typeof req.query.section === 'string' ? req.query.section : 'all';
    const activeSection = PROFILE_SECTION_DEFS.some((definition) => definition.key === requested) ? requested : 'all';
    context.filters.section = activeSection === 'all' ? null : activeSection;
    res.type('html').send(renderProfilePage({ corpus: listProfileCorpus(context.filters), activeSection, ...context }));
  } catch (error) {
    next(error);
  }
});

app.get('/opportunities', (req, res, next) => {
  try {
    const context = readCollectionContext(req, {
      scope: 'opportunities',
      stateOptions: OPPORTUNITY_STATES,
      defaultSort: 'latest'
    });
    res.type('html').send(renderOpportunitiesPage({ opportunities: listOpportunities(context.filters), ...context }));
  } catch (error) {
    next(error);
  }
});

app.get('/discovery-proposals', (req, res, next) => {
  try {
    const context = readCollectionContext(req, {
      scope: 'discovery',
      statusOptions: DISCOVERY_STATUSES,
      defaultSort: 'latest'
    });
    res.type('html').send(renderDiscoveryProposalsPage({
      proposals: listDiscoveryProposals(context.filters, context.facets),
      ...context
    }));
  } catch (error) {
    next(error);
  }
});

app.get('/discovery-proposals/:proposalId', (req, res, next) => {
  try {
    const proposal = readDiscoveryProposal(req.params.proposalId);
    if (!proposal) {
      res.status(404).type('html').send(renderMessagePage('Discovery proposal not found', 'The requested discovery proposal does not exist.'));
      return;
    }
    res.type('html').send(renderDiscoveryProposalPage(proposal));
  } catch (error) {
    next(error);
  }
});

app.get('/opportunities/:id', (req, res, next) => {
  try {
    const id = positiveRouteId(req.params.id);
    const opportunity = readOpportunity(id);
    if (!opportunity) {
      res.status(404).type('html').send(renderMessagePage('Opportunity not found', 'The requested opportunity does not exist.'));
      return;
    }
    res.type('html').send(renderOpportunityPage(opportunity));
  } catch (error) {
    next(error);
  }
});

app.get('/openings', (req, res, next) => {
  try {
    const context = readCollectionContext(req, {
      scope: 'openings',
      statusOptions: ['open', 'closed', 'unknown'],
      defaultSort: 'company'
    });
    res.type('html').send(renderOpeningsPage({ openings: listOpenings(context.filters), ...context }));
  } catch (error) {
    next(error);
  }
});

app.get('/openings/:id', (req, res, next) => {
  try {
    const opening = readOpening(positiveRouteId(req.params.id));
    if (!opening) {
      res.status(404).type('html').send(renderMessagePage('Opening not found', 'The requested normalized opening does not exist.'));
      return;
    }
    res.type('html').send(renderOpeningPage(opening));
  } catch (error) {
    next(error);
  }
});

app.get('/interviews', (req, res, next) => {
  try {
    const context = readCollectionContext(req, {
      scope: 'interviews',
      statusOptions: ['scheduled', 'reschedule_pending', 'cancelled'],
      defaultSort: 'latest'
    });
    res.type('html').send(renderInterviewsPage({ interviews: listInterviewQueue(context.filters), ...context }));
  } catch (error) {
    next(error);
  }
});

app.get('/interviews/:id/prep', (req, res, next) => {
  try {
    const model = readInterviewPrep(positiveRouteId(req.params.id));
    if (!model) {
      res.status(404).type('html').send(renderMessagePage('Interview not found', 'The requested interview does not exist.'));
      return;
    }
    res.type('html').send(renderInterviewPrepPage(model));
  } catch (error) {
    next(error);
  }
});

app.get('/communications/replies', (_req, res, next) => {
  try {
    res.type('html').send(renderReplyLifecyclePage(readCommunicationsModel()));
  } catch (error) {
    next(error);
  }
});

app.get('/communications', (_req, res) => {
  res.redirect(302, '/communications/replies');
});

app.get('/stories', (req, res, next) => {
  try {
    const context = readCollectionContext(req, {
      scope: 'profile',
      statusOptions: STORY_STATUSES,
      positionFacets: false,
      defaultSort: 'latest'
    });
    const target = buildQueryUrl('/profile', context.filters, {}) + '#stories';
    res.redirect(302, target);
  } catch (error) {
    next(error);
  }
});

app.get('/stories/:id', (req, res, next) => {
  try {
    const id = positiveRouteId(req.params.id);
    const story = readStory(id);
    if (!story) {
      res.status(404).type('html').send(renderMessagePage('Story not found', 'The requested story does not exist.'));
      return;
    }
    res.type('html').send(renderStoryPage(story));
  } catch (error) {
    next(error);
  }
});

app.get('/healthz', (_req, res, next) => {
  try {
    getDb().prepare('SELECT 1').get();
    res.type('text').send('ok\n');
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.set('Allow', 'GET, HEAD');
    res.status(405).type('html').send(renderMessagePage('Method not allowed', 'JobTrack web is read-only. Use the jobtrack CLI to change the store.'));
    return;
  }

  res.status(404).type('html').send(renderMessagePage('Not found', 'Use the applications, openings, discovery proposals, opportunities, interviews, communications, stories, or profile views.'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error && error.status === 400) {
    res.status(400).type('html').send(renderMessagePage('Invalid filters', error.publicMessage || 'One or more filter values are not available in this store.'));
    return;
  }
  if (error && error.status === 404) {
    res.status(404).type('html').send(renderMessagePage('Not found', 'The requested JobTrack record does not exist.'));
    return;
  }
  res.status(500).type('html').send(renderMessagePage('Unable to render JobTrack', 'The private read-only view could not be rendered. Check the server logs for details.'));
});

function positiveRouteId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    const error = new Error('Invalid route id');
    error.status = 404;
    throw error;
  }
  return id;
}

module.exports = { app };
