'use strict';

const crypto = require('node:crypto');

const routingPolicyJsonSchema = require('../contracts/strategy/application-strategy-routing-policy.v1.schema.json');
const applicationStrategyPlanJsonSchema = require('../contracts/strategy/application-strategy-plan.v1.schema.json');
const applicationStrategyWorkResultJsonSchema = require('../contracts/strategy/application-strategy-work-result.v1.schema.json');

const MODEL_CLASSES = Object.freeze(['deterministic', 'economy', 'strong', 'frontier']);
const MODEL_CLASS_SET = new Set(MODEL_CLASSES);
const MODEL_CLASS_RANK = new Map([
  ['deterministic', 0],
  ['economy', 1],
  ['strong', 2],
  ['frontier', 3]
]);
const CAPABILITIES = new Set([
  'application-strategy',
  'application-reconcile',
  'company-research',
  'job-posting-analysis',
  'email-signal-analysis',
  'email-tone-analysis',
  'email-draft',
  'application-material-draft',
  'interview-prep',
  'latex-render'
]);
const OUTPUT_KINDS = new Set([
  'analysis',
  'research-proposal',
  'assessment-proposal',
  'email-reply-draft-proposal',
  'application-material-draft-proposal',
  'interview-prep-proposal',
  'render-result'
]);
const REVIEW_GATES = new Set(['frontier', 'human', 'domain']);
const RESULT_STATUSES = new Set(['succeeded', 'failed', 'blocked']);
const SOURCE_KINDS = new Set([
  'artifact', 'snapshot', 'material-revision', 'email-message', 'interview',
  'profile-entry', 'story-use'
]);
const FORBIDDEN_EFFECTS = new Set(['execute', 'send-email', 'submit-application', 'external-mutation']);
const EFFECT_KEY_WORDS = new Set([
  'execute', 'executes', 'executed', 'executing', 'execution', 'executions', 'executable', 'executables',
  'executor', 'executors',
  'send', 'sends', 'sending',
  'submit', 'submits', 'submitted', 'submitting', 'submission', 'submissions',
  'apply', 'applies', 'applying',
  'tool', 'tools',
  'command', 'commands', 'commanded', 'commanding',
  'credential', 'credentials'
]);
const MAX_PAYLOAD_DEPTH = 12;
const MAX_PAYLOAD_NODES = 20_000;
const MAX_PAYLOAD_BYTES = 1_000_000;

class StrategyContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StrategyContractError';
    this.code = 'INVALID_STRATEGY_CONTRACT';
  }
}

function validateRoutingPolicy(value) {
  const root = plainObject(value, 'routingPolicy');
  exactKeys(root, 'routingPolicy', [
    'schemaVersion', 'policyId', 'version', 'coordinator', 'rules', 'forbiddenEffects'
  ], [
    'schemaVersion', 'policyId', 'version', 'coordinator', 'rules', 'forbiddenEffects'
  ]);
  literal(root.schemaVersion, 'application-strategy-routing-policy.v1', 'routingPolicy.schemaVersion');
  identifier(root.policyId, 'routingPolicy.policyId');
  integerRange(root.version, 'routingPolicy.version', 1, 1_000_000_000);
  validatePolicyCoordinator(root.coordinator, 'routingPolicy.coordinator');

  const rules = array(root.rules, 'routingPolicy.rules', 1, 50);
  const capabilities = new Set();
  rules.forEach((rule, index) => {
    const capability = validateRoutingRule(rule, `routingPolicy.rules[${index}]`);
    if (capabilities.has(capability)) fail(`routingPolicy.rules contains duplicate capability ${capability}`);
    capabilities.add(capability);
  });
  validateForbiddenEffects(root.forbiddenEffects, 'routingPolicy.forbiddenEffects');
  return clone(root);
}

function validateApplicationStrategyPlan(value) {
  const root = plainObject(value, 'strategyPlan');
  exactKeys(root, 'strategyPlan', [
    'schemaVersion', 'trust', 'applicationId', 'sourceStateSha256', 'coordinator', 'objective',
    'thesis', 'assumptions', 'risks', 'stopConditions', 'workItems'
  ], [
    'schemaVersion', 'trust', 'applicationId', 'sourceStateSha256', 'coordinator', 'objective',
    'thesis', 'assumptions', 'risks', 'stopConditions', 'workItems'
  ]);
  literal(root.schemaVersion, 'application-strategy-plan.v1', 'strategyPlan.schemaVersion');
  literal(root.trust, 'model_proposal', 'strategyPlan.trust');
  positiveInteger(root.applicationId, 'strategyPlan.applicationId');
  sha256(root.sourceStateSha256, 'strategyPlan.sourceStateSha256');
  validatePlanCoordinator(root.coordinator, 'strategyPlan.coordinator');
  nonblankString(root.objective, 'strategyPlan.objective', 1, 5_000);
  nonblankString(root.thesis, 'strategyPlan.thesis', 1, 5_000);
  statementList(root.assumptions, 'strategyPlan.assumptions');
  statementList(root.risks, 'strategyPlan.risks');
  statementList(root.stopConditions, 'strategyPlan.stopConditions');

  const workItems = array(root.workItems, 'strategyPlan.workItems', 1, 50);
  const workByKey = new Map();
  workItems.forEach((item, index) => {
    validateWorkItem(item, `strategyPlan.workItems[${index}]`);
    if (workByKey.has(item.key)) fail(`strategyPlan.workItems contains duplicate key ${item.key}`);
    workByKey.set(item.key, item);
  });
  validateWorkGraph(workByKey);
  return clone(root);
}

function validateApplicationStrategyWorkResult(value) {
  const root = plainObject(value, 'workResult');
  exactKeys(root, 'workResult', [
    'schemaVersion', 'trust', 'requestId', 'requestDigest', 'sourceStateSha256', 'status',
    'worker', 'usage', 'confidence', 'summary', 'claims', 'output'
  ], [
    'schemaVersion', 'trust', 'requestId', 'requestDigest', 'sourceStateSha256', 'status',
    'worker', 'usage', 'confidence', 'summary', 'claims'
  ]);
  literal(root.schemaVersion, 'application-strategy-work-result.v1', 'workResult.schemaVersion');
  literal(root.trust, 'model_proposal', 'workResult.trust');
  positiveInteger(root.requestId, 'workResult.requestId');
  sha256(root.requestDigest, 'workResult.requestDigest');
  sha256(root.sourceStateSha256, 'workResult.sourceStateSha256');
  enumValue(root.status, RESULT_STATUSES, 'workResult.status');
  validateWorker(root.worker, 'workResult.worker');
  validateUsage(root.usage, 'workResult.usage');
  numberRange(root.confidence, 'workResult.confidence', 0, 1);
  nonblankString(root.summary, 'workResult.summary', 1, 5_000);
  array(root.claims, 'workResult.claims', 0, 50).forEach((claim, index) => {
    validateClaim(claim, `workResult.claims[${index}]`);
  });

  if (root.status === 'succeeded') {
    if (!hasOwn(root, 'output')) fail('workResult.output is required when status is succeeded');
    validateOutput(root.output, 'workResult.output');
  } else if (hasOwn(root, 'output')) {
    fail(`workResult.output is not allowed when status is ${root.status}`);
  }
  assertNoEffectKeys(root, 'workResult');
  return clone(root);
}

function validatePolicyCoordinator(value, path) {
  const coordinator = plainObject(value, path);
  exactKeys(coordinator, path, ['capability', 'requiredModelClass', 'routeAlias'], [
    'capability', 'requiredModelClass', 'routeAlias'
  ]);
  literal(coordinator.capability, 'application-strategy', `${path}.capability`);
  literal(coordinator.requiredModelClass, 'frontier', `${path}.requiredModelClass`);
  routeAlias(coordinator.routeAlias, `${path}.routeAlias`);
}

function validateRoutingRule(value, path) {
  const rule = plainObject(value, path);
  exactKeys(rule, path, [
    'capability', 'defaultRouteAlias', 'minimumModelClass', 'escalationModelClass',
    'maxAttempts', 'reviewMode', 'budgets'
  ], [
    'capability', 'defaultRouteAlias', 'minimumModelClass', 'escalationModelClass',
    'maxAttempts', 'reviewMode', 'budgets'
  ]);
  enumValue(rule.capability, CAPABILITIES, `${path}.capability`);
  routeAlias(rule.defaultRouteAlias, `${path}.defaultRouteAlias`);
  enumValue(rule.minimumModelClass, MODEL_CLASS_SET, `${path}.minimumModelClass`);
  enumValue(rule.escalationModelClass, MODEL_CLASS_SET, `${path}.escalationModelClass`);
  if (MODEL_CLASS_RANK.get(rule.escalationModelClass) < MODEL_CLASS_RANK.get(rule.minimumModelClass)) {
    fail(`${path}.escalationModelClass cannot be weaker than minimumModelClass`);
  }
  integerRange(rule.maxAttempts, `${path}.maxAttempts`, 1, 10);
  enumValue(rule.reviewMode, REVIEW_GATES, `${path}.reviewMode`);
  validateBudgets(rule.budgets, `${path}.budgets`);
  return rule.capability;
}

function validateBudgets(value, path) {
  const budgets = plainObject(value, path);
  exactKeys(budgets, path, [
    'maxInputTokens', 'maxOutputTokens', 'maxCostMicros', 'maxDurationMs'
  ], [
    'maxInputTokens', 'maxOutputTokens', 'maxCostMicros', 'maxDurationMs'
  ]);
  integerRange(budgets.maxInputTokens, `${path}.maxInputTokens`, 1, 10_000_000);
  integerRange(budgets.maxOutputTokens, `${path}.maxOutputTokens`, 1, 10_000_000);
  integerRange(budgets.maxCostMicros, `${path}.maxCostMicros`, 0, 100_000_000_000);
  integerRange(budgets.maxDurationMs, `${path}.maxDurationMs`, 1, 86_400_000);
}

function validateForbiddenEffects(value, path) {
  const effects = array(value, path, 4, 4);
  const actual = new Set();
  effects.forEach((effect, index) => {
    enumValue(effect, FORBIDDEN_EFFECTS, `${path}[${index}]`);
    if (actual.has(effect)) fail(`${path} contains duplicate effect ${effect}`);
    actual.add(effect);
  });
  for (const effect of FORBIDDEN_EFFECTS) {
    if (!actual.has(effect)) fail(`${path} must include ${effect}`);
  }
}

function validatePlanCoordinator(value, path) {
  const coordinator = plainObject(value, path);
  exactKeys(coordinator, path, [
    'runId', 'routeAlias', 'modelClass', 'provider', 'model', 'modelVersion'
  ], [
    'runId', 'routeAlias', 'modelClass', 'provider', 'model'
  ]);
  identifier(coordinator.runId, `${path}.runId`);
  routeAlias(coordinator.routeAlias, `${path}.routeAlias`);
  literal(coordinator.modelClass, 'frontier', `${path}.modelClass`);
  nonblankString(coordinator.provider, `${path}.provider`, 1, 100);
  nonblankString(coordinator.model, `${path}.model`, 1, 200);
  if (hasOwn(coordinator, 'modelVersion')) {
    nonblankString(coordinator.modelVersion, `${path}.modelVersion`, 1, 200);
  }
}

function statementList(value, path) {
  array(value, path, 0, 20).forEach((statement, index) => {
    nonblankString(statement, `${path}[${index}]`, 1, 1_000);
  });
}

function validateWorkItem(value, path) {
  const item = plainObject(value, path);
  exactKeys(item, path, [
    'key', 'capability', 'title', 'goal', 'priority', 'dependsOn', 'acceptanceCriteria',
    'sourceRefs', 'outputKind', 'reviewGate'
  ], [
    'key', 'capability', 'title', 'goal', 'priority', 'dependsOn', 'acceptanceCriteria',
    'sourceRefs', 'outputKind', 'reviewGate'
  ]);
  workKey(item.key, `${path}.key`);
  enumValue(item.capability, CAPABILITIES, `${path}.capability`);
  nonblankString(item.title, `${path}.title`, 1, 300);
  nonblankString(item.goal, `${path}.goal`, 1, 2_000);
  integerRange(item.priority, `${path}.priority`, 1, 5);
  const dependencies = array(item.dependsOn, `${path}.dependsOn`, 0, 20);
  const seenDependencies = new Set();
  dependencies.forEach((dependency, index) => {
    workKey(dependency, `${path}.dependsOn[${index}]`);
    if (seenDependencies.has(dependency)) fail(`${path}.dependsOn contains duplicate key ${dependency}`);
    seenDependencies.add(dependency);
  });
  const criteria = array(item.acceptanceCriteria, `${path}.acceptanceCriteria`, 1, 20);
  criteria.forEach((criterion, index) => {
    nonblankString(criterion, `${path}.acceptanceCriteria[${index}]`, 1, 1_000);
  });
  const sourceRefs = array(item.sourceRefs, `${path}.sourceRefs`, 0, 50);
  const seenSourceRefs = new Set();
  sourceRefs.forEach((sourceRef, index) => {
    const refPath = `${path}.sourceRefs[${index}]`;
    const ref = plainObject(sourceRef, refPath);
    exactKeys(ref, refPath, ['kind', 'id'], ['kind', 'id']);
    enumValue(ref.kind, SOURCE_KINDS, `${refPath}.kind`);
    positiveInteger(ref.id, `${refPath}.id`);
    const identity = `${ref.kind}:${ref.id}`;
    if (seenSourceRefs.has(identity)) fail(`${path}.sourceRefs contains duplicate ${identity}`);
    seenSourceRefs.add(identity);
  });
  enumValue(item.outputKind, OUTPUT_KINDS, `${path}.outputKind`);
  enumValue(item.reviewGate, REVIEW_GATES, `${path}.reviewGate`);
}

function validateWorkGraph(workByKey) {
  for (const [key, item] of workByKey) {
    for (const dependency of item.dependsOn) {
      if (dependency === key) fail(`strategyPlan.workItems ${key} cannot depend on itself`);
      if (!workByKey.has(dependency)) {
        fail(`strategyPlan.workItems ${key} depends on unknown work item ${dependency}`);
      }
    }
  }

  const state = new Map();
  const trail = [];
  function visit(key) {
    if (state.get(key) === 2) return;
    if (state.get(key) === 1) {
      const cycleStart = trail.indexOf(key);
      const cycle = [...trail.slice(cycleStart), key].join(' -> ');
      fail(`strategyPlan.workItems dependencies contain a cycle: ${cycle}`);
    }
    state.set(key, 1);
    trail.push(key);
    for (const dependency of workByKey.get(key).dependsOn) visit(dependency);
    trail.pop();
    state.set(key, 2);
  }
  for (const key of workByKey.keys()) visit(key);
}

function validateWorker(value, path) {
  const worker = plainObject(value, path);
  exactKeys(worker, path, [
    'runId', 'routeAlias', 'modelClass', 'provider', 'model', 'modelVersion'
  ], [
    'runId', 'routeAlias', 'modelClass', 'provider', 'model'
  ]);
  identifier(worker.runId, `${path}.runId`);
  routeAlias(worker.routeAlias, `${path}.routeAlias`);
  enumValue(worker.modelClass, MODEL_CLASS_SET, `${path}.modelClass`);
  nonblankString(worker.provider, `${path}.provider`, 1, 100);
  nonblankString(worker.model, `${path}.model`, 1, 200);
  if (hasOwn(worker, 'modelVersion')) nonblankString(worker.modelVersion, `${path}.modelVersion`, 1, 200);
}

function validateUsage(value, path) {
  const usage = plainObject(value, path);
  exactKeys(usage, path, [
    'inputTokens', 'outputTokens', 'costMicros', 'durationMs'
  ], [
    'inputTokens', 'outputTokens', 'costMicros', 'durationMs'
  ]);
  integerRange(usage.inputTokens, `${path}.inputTokens`, 0, 10_000_000);
  integerRange(usage.outputTokens, `${path}.outputTokens`, 0, 10_000_000);
  integerRange(usage.costMicros, `${path}.costMicros`, 0, 100_000_000_000);
  integerRange(usage.durationMs, `${path}.durationMs`, 0, 86_400_000);
}

function validateClaim(value, path) {
  const claim = plainObject(value, path);
  exactKeys(claim, path, ['statement', 'evidenceRefs'], ['statement', 'evidenceRefs']);
  nonblankString(claim.statement, `${path}.statement`, 1, 2_000);
  const refs = array(claim.evidenceRefs, `${path}.evidenceRefs`, 0, 20);
  const seen = new Set();
  refs.forEach((reference, index) => {
    nonblankString(reference, `${path}.evidenceRefs[${index}]`, 1, 500);
    if (seen.has(reference)) fail(`${path}.evidenceRefs contains duplicate reference ${reference}`);
    seen.add(reference);
  });
}

function validateOutput(value, path) {
  const output = plainObject(value, path);
  exactKeys(output, path, ['kind', 'payload'], ['kind', 'payload']);
  enumValue(output.kind, OUTPUT_KINDS, `${path}.kind`);
  const state = { nodes: 0 };
  validateSafeJson(output.payload, `${path}.payload`, 0, state);
  if (Buffer.byteLength(stableJson(output.payload), 'utf8') > MAX_PAYLOAD_BYTES) {
    fail(`${path}.payload exceeds ${MAX_PAYLOAD_BYTES} canonical JSON bytes`);
  }
}

function validateSafeJson(value, path, depth, state) {
  if (depth > MAX_PAYLOAD_DEPTH) fail(`${path} exceeds maximum JSON depth ${MAX_PAYLOAD_DEPTH}`);
  state.nodes += 1;
  if (state.nodes > MAX_PAYLOAD_NODES) fail(`${path} exceeds maximum JSON node count ${MAX_PAYLOAD_NODES}`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > 100_000) fail(`${path} exceeds 100000 characters`);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} must be a finite JSON number`);
    return;
  }
  if (Array.isArray(value)) {
    strictArray(value, path, 200);
    value.forEach((entry, index) => validateSafeJson(entry, `${path}[${index}]`, depth + 1, state));
    return;
  }
  const object = plainObject(value, path);
  const keys = Object.keys(object);
  if (keys.length > 200) fail(`${path} exceeds 200 fields`);
  for (const key of keys) {
    if (key.length < 1 || key.length > 200) fail(`${path} contains a field name outside 1 to 200 characters`);
    if (effectLikeKey(key)) fail(`${path} contains prohibited effect-like field ${JSON.stringify(key)}`);
    validateSafeJson(object[key], `${path}.${key}`, depth + 1, state);
  }
}

function assertNoEffectKeys(value, path) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoEffectKeys(entry, `${path}[${index}]`));
    return;
  }
  for (const key of Object.keys(value)) {
    if (effectLikeKey(key)) fail(`${path} contains prohibited effect-like field ${JSON.stringify(key)}`);
    assertNoEffectKeys(value[key], `${path}.${key}`);
  }
}

function effectLikeKey(key) {
  if (key === '__proto__' || key === 'prototype' || key === 'constructor') return true;
  const separated = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2');
  const words = separated.split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word.toLowerCase());
  if (words.some((word) => EFFECT_KEY_WORDS.has(word))) return true;
  return words.some((word, index) => word === 'external' && words[index + 1] === 'mutation');
}

function exactKeys(value, path, allowed, required) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) fail(`${path} contains unknown field(s): ${unknown.sort().join(', ')}`);
  for (const key of required) if (!hasOwn(value, key)) fail(`${path}.${key} is required`);
}

function plainObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${path} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`${path} must not contain symbol fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !hasOwn(descriptor, 'value')) fail(`${path}.${key} must be an enumerable data field`);
  }
  return value;
}

function array(value, path, minimum, maximum) {
  strictArray(value, path, maximum);
  if (value.length < minimum) fail(`${path} requires at least ${minimum} item(s)`);
  return value;
}

function strictArray(value, path, maximum) {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  if (value.length > maximum) fail(`${path} exceeds ${maximum} items`);
  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, index)) fail(`${path} must not be sparse`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      fail(`${path} must not contain non-index fields`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !hasOwn(descriptor, 'value')) fail(`${path}[${key}] must be an enumerable data item`);
  }
  return value;
}

function nonblankString(value, path, minimum, maximum) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.trim().length === 0) {
    fail(`${path} must be a nonblank string from ${minimum} to ${maximum} characters`);
  }
  return value;
}

function identifier(value, path) {
  nonblankString(value, path, 1, 200);
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) fail(`${path} must be a stable identifier`);
}

function workKey(value, path) {
  nonblankString(value, path, 1, 100);
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) fail(`${path} must be a stable work-item key`);
}

function routeAlias(value, path) {
  nonblankString(value, path, 1, 100);
  if (!/^[a-z][a-z0-9-]*$/.test(value)) fail(`${path} must be a lowercase logical route alias`);
}

function sha256(value, path) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    fail(`${path} must be a lowercase SHA-256 digest`);
  }
}

function positiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${path} must be a positive integer`);
}

function integerRange(value, path, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${path} must be an integer from ${minimum} to ${maximum}`);
  }
}

function numberRange(value, path, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(`${path} must be between ${minimum} and ${maximum}`);
  }
}

function literal(value, expected, path) {
  if (value !== expected) fail(`${path} must equal ${JSON.stringify(expected)}`);
}

function enumValue(value, allowed, path) {
  if (!allowed.has(value)) fail(`${path} has an unsupported value`);
}

function stableJson(value) {
  return canonicalJson(value, '$', new Set());
}

function canonicalJson(value, path, ancestors) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} must be a finite JSON number`);
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') fail(`${path} is not a JSON value`);
  if (ancestors.has(value)) fail(`${path} contains a circular reference`);
  ancestors.add(value);
  let encoded;
  if (Array.isArray(value)) {
    strictArray(value, path, Number.MAX_SAFE_INTEGER);
    encoded = `[${value.map((entry, index) => canonicalJson(entry, `${path}[${index}]`, ancestors)).join(',')}]`;
  } else {
    const object = plainObject(value, path);
    encoded = `{${Object.keys(object).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(object[key], `${path}.${key}`, ancestors)}`
    )).join(',')}}`;
  }
  ancestors.delete(value);
  return encoded;
}

function digest(value) {
  const input = typeof value === 'string' ? value : stableJson(value);
  return crypto.createHash('sha256').update(input).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(message) {
  throw new StrategyContractError(message);
}

module.exports = {
  StrategyContractError,
  MODEL_CLASSES,
  routingPolicyJsonSchema,
  applicationStrategyPlanJsonSchema,
  applicationStrategyWorkResultJsonSchema,
  validateRoutingPolicy,
  validateApplicationStrategyPlan,
  validateApplicationStrategyWorkResult,
  stableJson,
  digest
};
