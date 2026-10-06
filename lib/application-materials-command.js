'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createPdfStructureInspector } = require('./latex-renderer');
const { listExpectedUploads, verifyApplicationUploads } = require('./upload-verification');

const {
  MAX_MATERIAL_CONTENT_BYTES,
  ApplicationMaterialsError,
  acceptApplicationFormUncertainty,
  buildApplicationMaterialsContext,
  buildPackageSelectionSnapshot,
  createMaterialRender,
  createMaterialDraft,
  getApplicationMaterialsReadModel,
  getApplicationReadiness,
  getMaterialRevision,
  listMaterialRenders,
  listApplicationMaterials,
  projectPublicApplicationPackage,
  projectPublicMaterialRender,
  readMaterial,
  recordApplicationSubmission,
  resolveApplicationFormField,
  reviewMaterialRevision,
  selectMaterialRevision,
  setApplicationPreparationMode
} = require('./application-materials');

const APPLICATION_MATERIAL_FLAG_SCHEMAS = Object.freeze({
  context: ['applicationId', 'id', 'kind', 'formFieldId', 'parentRevisionId', 'artifactIds', 'profileEntryIds', 'storyUseIds'],
  list: ['applicationId', 'id'],
  submissions: ['applicationId', 'id'],
  show: ['applicationId', 'materialId', 'revisionId', 'id', 'exact'],
  readiness: ['applicationId', 'id'],
  plan: ['applicationId', 'id'],
  draft: [
    'applicationId', 'id', 'kind', 'formFieldId', 'content', 'contentFile', 'authoredBy',
    'authorship', 'stage', 'parentRevisionId', 'expectedHeadRevisionId', 'artifactIds',
    'profileEntryIds', 'storyUseIds', 'formOptionIds', 'expectedSourceStateSha256', 'changeNote', 'idempotencyKey',
    'template', 'payloadFile'
  ],
  templates: [],
  render: [
    'applicationId', 'id', 'revisionId', 'expectedContentSha256', 'renderedBy', 'idempotencyKey'
  ],
  lint: ['applicationId', 'id', 'renderId', 'lintedBy', 'idempotencyKey'],
  'lint-payload': ['template', 'payloadFile', 'kind'],
  'editorial-context': ['applicationId', 'id', 'revisionId', 'renderId'],
  'editorial-review': ['applicationId', 'id', 'revisionId', 'renderId', 'reviewFile', 'reviewedBy', 'idempotencyKey'],
  review: [
    'applicationId', 'revisionId', 'renderId', 'decision', 'reviewedBy', 'expectedReviewId', 'notes',
    'reviewedAt', 'idempotencyKey'
  ],
  select: [
    'applicationId', 'revisionId', 'selectedBy', 'expectedSelectedRevisionId', 'selectedAt',
    'idempotencyKey'
  ],
  'accept-uncertainty': [
    'applicationId', 'id', 'acceptedBy', 'reason', 'expectedFormStateSha256', 'acceptedAt',
    'idempotencyKey'
  ],
  'resolve-field': [
    'applicationId', 'id', 'formFieldId', 'state', 'artifactId', 'actor', 'rationale',
    'expectedCurrentResolutionId', 'expectedFormStateSha256', 'resolvedAt', 'idempotencyKey'
  ],
  activate: ['applicationId', 'id', 'activatedBy', 'reason', 'expectedPlanVersion', 'idempotencyKey'],
  'package-snapshot': ['applicationId', 'id', 'expectedReadinessSha256'],
  'record-submission': [
    'applicationId', 'id', 'packageId', 'submittedBy', 'submittedAt', 'expectedReadinessSha256',
    'notes', 'attemptId', 'idempotencyKey'
  ],
  'expected-uploads': ['applicationId', 'id'],
  'verify-uploads': [
    'applicationId', 'id', 'resumeFile', 'coverLetterFile', 'verifiedBy', 'sourceLabel',
    'skipStructuralCheck', 'idempotencyKey'
  ]
});

function assertApplicationMaterialsCommandFlags(action, flags) {
  const schema = APPLICATION_MATERIAL_FLAG_SCHEMAS[action];
  if (!schema) throw new ApplicationMaterialsError('UNKNOWN_COMMAND', `Unknown application-materials action: ${action || '(missing)'}`);
  const allowed = new Set(schema);
  const unknown = Object.keys(flags).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new ApplicationMaterialsError(
      'INVALID_ARGUMENT',
      `Unknown flag(s) for application-materials ${action}: ${unknown.sort().map(toFlag).join(', ')}`
    );
  }
}

function runApplicationMaterialsCommand(db, args, flags = {}, services = {}) {
  const action = args[0] || 'list';
  if (args.length > 2) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', 'Use one action and at most one positional application or material id');
  }
  assertApplicationMaterialsCommandFlags(action, flags);

  if (action === 'editorial-context' || action === 'editorial-review') {
    const { buildApplicationResumeEditorialContext, recordApplicationResumeEditorialReview } = require('./application-resume-editorial');
    const input = { applicationId: applicationId(flags, args), revisionId: requiredId(flags.revisionId, 'revision id'), renderId: requiredId(flags.renderId, 'render id') };
    if (action === 'editorial-context') return { context: buildApplicationResumeEditorialContext(db, input) };
    const reviewFile = requiredText(flags.reviewFile, '--review-file');
    require('./private-source-boundary').assertNoPrivateJournalSource({ reviewFile, source: flags.reviewedBy });
    const stat = fs.statSync(reviewFile);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new ApplicationMaterialsError('INVALID_ARGUMENT', 'Editorial review must be a JSON file no larger than 256 KiB');
    let review;
    try { review = JSON.parse(fs.readFileSync(reviewFile, 'utf8')); }
    catch { throw new ApplicationMaterialsError('INVALID_ARGUMENT', 'Editorial review file must contain valid JSON'); }
    return recordApplicationResumeEditorialReview(db, { ...input, review, reviewedBy: requiredText(flags.reviewedBy, '--reviewed-by'), idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key') });
  }

  if (action === 'context') {
    return {
      context: buildApplicationMaterialsContext(db, applicationId(flags, args), {
        kind: flags.kind,
        formFieldId: flags.formFieldId,
        parentRevisionId: flags.parentRevisionId,
        artifactIds: flags.artifactIds,
        profileEntryIds: flags.profileEntryIds,
        storyUseIds: flags.storyUseIds
      })
    };
  }
  if (action === 'list') {
    const id = applicationId(flags, args);
    return { applicationId: id, materials: listApplicationMaterials(db, id) };
  }
  if (action === 'submissions') {
    const id = applicationId(flags, args);
    return {
      applicationId: id,
      submissions: getApplicationMaterialsReadModel(db, id).submissions
    };
  }
  if (action === 'show') {
    const scopedApplicationId = optionalId(flags.applicationId, 'application id');
    const exact = normalizeBoolean(flags.exact, false, '--exact');
    if (flags.revisionId) {
      const revision = getMaterialRevision(db, requiredId(flags.revisionId, 'revision id'), scopedApplicationId);
      if (!exact) return { revision };
      return {
        revision: {
          ...revision,
          renders: listMaterialRenders(db, revision.id, revision.application_id)
        },
        exact: true
      };
    }
    if (exact) {
      throw new ApplicationMaterialsError('INVALID_ARGUMENT', '--exact requires --revision-id for application-material show');
    }
    const material = readMaterial(
      db,
      requiredId(flags.materialId || flags.id || args[1], 'material id'),
      scopedApplicationId
    );
    const publicMaterial = listApplicationMaterials(db, material.application_id)
      .find((item) => item.id === material.id);
    return { material: publicMaterial?.protected ? publicMaterial : material };
  }
  if (action === 'readiness') {
    return getApplicationReadiness(db, applicationId(flags, args));
  }
  if (action === 'plan') {
    const { buildFulfillmentPlan } = require('./application-fulfillment');
    return buildFulfillmentPlan(db, applicationId(flags, args));
  }
  if (action === 'templates') {
    const { listMaterialTemplates } = require('./material-templates');
    return { templates: listMaterialTemplates() };
  }
  if (action === 'draft') {
    // Standardized-template lane: --template KEY --payload-file FILE expands a
    // versioned LaTeX skeleton with a structured content payload. Mutually
    // exclusive with raw --content/--content-file; the expanded LaTeX becomes
    // the revision content and the template key + canonical payload are
    // recorded as provenance.
    let content;
    let templateKey = null;
    let templatePayloadJson = null;
    if (flags.template) {
      if (flags.content || flags.contentFile) {
        throw new Error('--template expands its own LaTeX; do not also pass --content/--content-file');
      }
      const payloadPath = requiredText(flags.payloadFile, '--payload-file');
      let payload;
      try { payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8')); }
      catch (error) { throw new Error(`--payload-file must be valid JSON: ${error.message}`); }
      const { expandMaterialTemplate } = require('./material-templates');
      templateKey = requiredText(flags.template, '--template');
      // v4: the header is the store's approved contact block, never the worker's.
      payload = require('./resume-contact-block').injectProfileContact(db, templateKey, payload);
      content = expandMaterialTemplate(templateKey, payload, requiredText(flags.kind, '--kind'));
      templatePayloadJson = canonicalPayloadJson(payload);
    } else {
      content = readExactContent(flags.content, flags.contentFile);
    }
    const result = projectPublicMaterialMutation(db, createMaterialDraft(db, {
      ...flags,
      applicationId: applicationId(flags, args),
      content,
      templateKey,
      templatePayloadJson
    }));
    if (templateKey) {
      // Advisory density bands at draft time (plan L6). They never block a
      // draft — the mechanical page/lint gate binds at render review — but
      // surfacing them here is the cheapest possible feedback loop.
      const { lintTemplatePayload } = require('./resume-lint');
      const payload = JSON.parse(templatePayloadJson);
      result.payloadLint = lintTemplatePayload(templateKey, requiredText(flags.kind, '--kind'), payload);
    }
    return result;
  }
  if (action === 'lint') {
    const { recordMaterialLintReport } = require('./resume-lint');
    return recordMaterialLintReport(db, {
      applicationId: applicationId(flags, args),
      renderId: requiredId(flags.renderId, 'render id'),
      lintedBy: requiredText(flags.lintedBy, '--linted-by'),
      idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key')
    });
  }
  if (action === 'lint-payload') {
    // Read-only preflight: validates the payload against the template exactly
    // as draft would, then returns the density findings without writing.
    const { expandMaterialTemplate } = require('./material-templates');
    const { lintTemplatePayload } = require('./resume-lint');
    const templateKey = requiredText(flags.template, '--template');
    const kind = requiredText(flags.kind, '--kind');
    const payloadPath = requiredText(flags.payloadFile, '--payload-file');
    let payload;
    try { payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8')); }
    catch (error) { throw new Error(`--payload-file must be valid JSON: ${error.message}`); }
    payload = require('./resume-contact-block').injectProfileContact(db, templateKey, payload);
    expandMaterialTemplate(templateKey, payload, kind);
    const findings = lintTemplatePayload(templateKey, kind, payload);
    return {
      template: templateKey,
      kind,
      payloadValid: true,
      errorCount: findings.filter((item) => item.severity === 'error').length,
      warnCount: findings.filter((item) => item.severity === 'warn').length,
      findings
    };
  }
  if (action === 'render') {
    const scopedApplicationId = applicationId(flags, args);
    const revisionId = requiredId(flags.revisionId, 'revision id');
    const expectedContentSha256 = requiredText(flags.expectedContentSha256, '--expected-content-sha256');
    if (typeof services.renderLatexMaterial !== 'function') {
      throw new ApplicationMaterialsError('RENDERER_UNAVAILABLE', 'The fixed JobTrack LaTeX renderer is unavailable');
    }
    const result = createMaterialRender(db, {
      applicationId: scopedApplicationId,
      revisionId,
      expectedContentSha256,
      renderedBy: requiredText(flags.renderedBy, '--rendered-by'),
      idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key'),
      renderMaterial: services.renderLatexMaterial
    });
    return { ...result, render: projectPublicMaterialRender(result.render) };
  }
  if (action === 'review') {
    return projectPublicMaterialMutation(db, reviewMaterialRevision(db, {
      ...flags,
      applicationId: optionalId(flags.applicationId, 'application id'),
      revisionId: requiredId(flags.revisionId || args[1], 'revision id')
    }));
  }
  if (action === 'select') {
    return projectPublicMaterialMutation(db, selectMaterialRevision(db, {
      ...flags,
      applicationId: optionalId(flags.applicationId, 'application id'),
      revisionId: requiredId(flags.revisionId || args[1], 'revision id')
    }));
  }
  if (action === 'accept-uncertainty') {
    const application = applicationId(flags, args);
    const result = acceptApplicationFormUncertainty(db, { ...flags, applicationId: application });
    const readiness = getApplicationReadiness(db, application);
    return {
      ...result,
      acceptance: readiness.uncertaintyAcceptance,
      form: readiness.form
    };
  }
  if (action === 'resolve-field') {
    return resolveApplicationFormField(db, {
      ...flags,
      applicationId: applicationId(flags, args),
      formFieldId: requiredId(flags.formFieldId, 'form field id')
    });
  }
  if (action === 'activate') {
    return setApplicationPreparationMode(db, {
      applicationId: applicationId(flags, args),
      mode: 'managed',
      actor: requiredText(flags.activatedBy, '--activated-by'),
      reason: requiredText(flags.reason, '--reason'),
      expectedPlanVersion: requiredNonnegativeInteger(flags.expectedPlanVersion, '--expected-plan-version'),
      idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key')
    });
  }
  if (action === 'package-snapshot') {
    return buildPackageSelectionSnapshot(db, applicationId(flags, args), {
      expectedReadinessSha256: flags.expectedReadinessSha256
    });
  }
  if (action === 'record-submission') {
    const result = recordApplicationSubmission(db, {
      applicationId: applicationId(flags, args),
      packageId: requiredId(flags.packageId, 'package id'),
      submittedBy: requiredText(flags.submittedBy, '--submitted-by'),
      submittedAt: flags.submittedAt,
      expectedReadinessSha256: requiredText(flags.expectedReadinessSha256, '--expected-readiness-sha256'),
      notes: flags.notes,
      attemptId: flags.attemptId,
      idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key')
    });
    return { ...result, package: projectPublicApplicationPackage(result.package) };
  }
  if (action === 'expected-uploads') {
    const id = applicationId(flags, args);
    return { applicationId: id, expectedUploads: listExpectedUploads(db, id) };
  }
  if (action === 'verify-uploads') {
    const files = {};
    if (flags.resumeFile) files.resume = requiredText(flags.resumeFile, '--resume-file');
    if (flags.coverLetterFile) files['cover-letter'] = requiredText(flags.coverLetterFile, '--cover-letter-file');
    if (!Object.keys(files).length) {
      throw new ApplicationMaterialsError('INVALID_INPUT', 'Pass --resume-file and/or --cover-letter-file with the exact files that will be attached');
    }
    // The structural leg costs a container run. It is on by default because the
    // failure it catches — a readable-looking file that no parser can open —
    // is exactly what shipped in drill r2608050256bb3f.
    const inspectPdfStructure = flags.skipStructuralCheck
      ? undefined
      : (services.inspectPdfStructure || createPdfStructureInspector());
    return verifyApplicationUploads(db, {
      applicationId: applicationId(flags, args),
      files,
      verifiedBy: requiredText(flags.verifiedBy, '--verified-by'),
      sourceLabel: flags.sourceLabel,
      idempotencyKey: requiredText(flags.idempotencyKey, '--idempotency-key'),
      inspectPdfStructure
    });
  }
  throw new ApplicationMaterialsError('UNKNOWN_COMMAND', `Unknown application-materials action: ${action}`);
}

function projectPublicMaterialMutation(db, result) {
  const revision = result?.revision || result?.selectedRevision || null;
  if (!revision?.form_field_id) return result;
  const material = listApplicationMaterials(db, revision.application_id)
    .find((item) => item.id === revision.material_id);
  if (!material?.protected) return result;
  const publicRevision = material.revisions.find((item) => item.id === revision.id) || null;
  const publicReview = result.review ? selectKeys(result.review, [
    'id', 'revision_id', 'decision_id', 'expected_prior_review_id', 'reviewed_by',
    'reviewed_at', 'created_at'
  ]) : undefined;
  return {
    ...result,
    ...(result.material ? { material } : {}),
    ...(result.revision ? { revision: publicRevision } : {}),
    ...(result.selectedRevision ? { selectedRevision: publicRevision } : {}),
    ...(result.review ? { review: publicReview } : {}),
    protectedPayloadRedacted: true
  };
}

function selectKeys(value, keys) {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function normalizeBoolean(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 'true' || value === '1' || value === 'yes') return true;
  if (value === false || value === 'false' || value === '0' || value === 'no') return false;
  throw new ApplicationMaterialsError('INVALID_ARGUMENT', `${label} must be true or false`);
}

function getApplicationMaterialsPageModel(db, applicationIdValue) {
  return getApplicationMaterialsReadModel(db, requiredId(applicationIdValue, 'application id'));
}

function applicationId(flags, args) {
  return requiredId(flags.applicationId || flags.id || args[1], 'application id');
}

function canonicalPayloadJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalPayloadJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalPayloadJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readExactContent(content, contentFile) {
  const hasInline = content !== undefined && content !== null;
  const hasFile = contentFile !== undefined && contentFile !== null && String(contentFile).trim() !== '';
  if (hasInline === hasFile) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', 'Provide exactly one of --content or --content-file');
  }
  if (hasInline) return String(content);
  const filename = path.resolve(String(contentFile));
  const stat = fs.statSync(filename);
  if (!stat.isFile()) throw new ApplicationMaterialsError('INVALID_ARGUMENT', '--content-file must identify a regular file');
  if (stat.size > MAX_MATERIAL_CONTENT_BYTES) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', `Material file exceeds ${MAX_MATERIAL_CONTENT_BYTES} bytes`);
  }
  return fs.readFileSync(filename, 'utf8');
}

function requiredId(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', `${label} must be a positive integer`);
  }
  return number;
}

function optionalId(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return requiredId(value, label);
}

function requiredNonnegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', `${label} must be a non-negative integer`);
  }
  return number;
}

function requiredText(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new ApplicationMaterialsError('INVALID_ARGUMENT', `Missing required ${label}`);
  }
  return String(value).trim();
}

function toFlag(value) {
  return `--${value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`;
}

module.exports = {
  APPLICATION_MATERIAL_FLAG_SCHEMAS,
  assertApplicationMaterialsCommandFlags,
  runApplicationMaterialsCommand,
  getApplicationMaterialsPageModel
};
