'use strict';

// §7 correlation-journal evaluation. The projection is deliberately read-only:
// latest-per-message correlation rows define the denominator, explicit link
// retraction events define corrections, and no mutable counter can drift from
// the underlying audit records.

const METRICS_SCHEMA_VERSION = 'jobtrack-email-correlation-metrics.v1';

function readCorrelationMetrics(db, { applicationId } = {}) {
  const scopedApplicationId = applicationId === undefined || applicationId === null
    ? null
    : positiveInteger(applicationId, 'applicationId');
  const empty = emptyMetrics(scopedApplicationId);
  if (!tableExists(db, 'job_email_message_refs')
      || !tableExists(db, 'job_email_correlations')
      || !tableExists(db, 'job_email_correlation_candidates')) return empty;
  const hasRetractions = tableExists(db, 'email_link_retractions');
  const retractedExpression = hasRetractions
    ? `EXISTS (
        SELECT 1 FROM email_link_retractions retraction
        WHERE retraction.message_ref_id=correlation.message_ref_id
          AND (retraction.application_id IS NULL OR retraction.application_id=correlation.resolved_application_id)
      )`
    : '0';

  const rows = db.prepare(`
    WITH latest AS (
      SELECT message_ref_id, max(id) AS correlation_id
      FROM job_email_correlations
      GROUP BY message_ref_id
    )
    SELECT correlation.id AS correlation_id, correlation.message_ref_id,
      correlation.resolution, correlation.resolved_application_id,
      correlation.correlation_json, correlation.created_at AS linked_at,
      message.received_at, ${retractedExpression} AS link_retracted
    FROM latest
    JOIN job_email_correlations correlation ON correlation.id=latest.correlation_id
    JOIN job_email_message_refs message ON message.id=correlation.message_ref_id
    WHERE (? IS NULL OR EXISTS (
      SELECT 1
      FROM job_email_correlations scoped_correlation
      LEFT JOIN job_email_correlation_candidates scoped_candidate
        ON scoped_candidate.correlation_id=scoped_correlation.id
      WHERE scoped_correlation.message_ref_id=correlation.message_ref_id
        AND (scoped_correlation.resolved_application_id=? OR scoped_candidate.application_id=?)
    ))
    ORDER BY correlation.message_ref_id
  `).all(scopedApplicationId, scopedApplicationId, scopedApplicationId);

  let automaticLinks = 0;
  let agentLinks = 0;
  const durations = [];
  const scopedMessageIds = new Set(rows.map((row) => Number(row.message_ref_id)));
  for (const row of rows) {
    if (row.resolution !== 'linked' || Boolean(row.link_retracted)) continue;
    if (scopedApplicationId !== null && Number(row.resolved_application_id) !== scopedApplicationId) continue;
    const correlation = safeJson(row.correlation_json, null);
    if (wasAgentResolved(correlation)) agentLinks += 1;
    else automaticLinks += 1;
    const receivedAt = timestampMs(row.received_at);
    const linkedAt = timestampMs(row.linked_at);
    if (Number.isFinite(receivedAt) && Number.isFinite(linkedAt)) {
      const duration = linkedAt - receivedAt;
      if (duration >= 0) durations.push(duration);
      else if (duration > -1000) durations.push(0);
    }
  }

  const clarifications = tableExists(db, 'email_clarifications')
    ? countClarifications(db, scopedApplicationId)
    : 0;
  const mislinkRetractions = hasRetractions
    ? countRetractions(db, scopedApplicationId, scopedMessageIds)
    : 0;
  const correlatedMessages = rows.length;
  const linkedMessages = automaticLinks + agentLinks;

  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    scope: scopedApplicationId === null
      ? { kind: 'all' }
      : { kind: 'application', applicationId: scopedApplicationId },
    denominator: 'latest_correlated_messages',
    counts: {
      correlatedMessages,
      linkedMessages,
      automaticLinks,
      agentLinks,
      clarifications,
      mislinkRetractions
    },
    rates: {
      automaticLink: rate(automaticLinks, correlatedMessages),
      agentLink: rate(agentLinks, correlatedMessages),
      clarify: rate(clarifications, correlatedMessages)
    },
    timeToLink: summarizeDurations(durations, linkedMessages)
  };
}

function countClarifications(db, applicationId) {
  const rows = db.prepare('SELECT message_ref_id,candidate_application_ids_json FROM email_clarifications').all();
  if (applicationId === null) return new Set(rows.map((row) => Number(row.message_ref_id))).size;
  return new Set(rows.filter((row) => {
    const ids = safeJson(row.candidate_application_ids_json, []);
    return Array.isArray(ids) && ids.some((id) => Number(id) === applicationId);
  }).map((row) => Number(row.message_ref_id))).size;
}

function countRetractions(db, applicationId, scopedMessageIds) {
  const columns = tableColumns(db, 'email_link_retractions');
  const applicationColumn = columns.has('application_id');
  const rows = db.prepare(`SELECT id,message_ref_id${applicationColumn ? ',application_id' : ''} FROM email_link_retractions`).all();
  const matching = applicationId === null
    ? rows
    : rows.filter((row) => applicationColumn
    ? Number(row.application_id) === applicationId
    : scopedMessageIds.has(Number(row.message_ref_id)));
  return new Set(matching.map((row) => Number(row.message_ref_id))).size;
}

function wasAgentResolved(correlation) {
  return Array.isArray(correlation?.evidence)
    && correlation.evidence.some((entry) => entry?.kind === 'operator_resolution');
}

function summarizeDurations(values, linkedMessages) {
  if (!values.length) {
    return { samples: 0, excludedSamples: linkedMessages, averageMs: null, medianMs: null, p95Ms: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const averageMs = Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length);
  return {
    samples: sorted.length,
    excludedSamples: linkedMessages - sorted.length,
    averageMs,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95)
  };
}

function percentile(sorted, percentileValue) {
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)];
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function timestampMs(value) {
  if (!value) return NaN;
  const text = String(value);
  return Date.parse(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function tableColumns(db, name) {
  return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name));
}

function emptyMetrics(applicationId) {
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    scope: applicationId === null ? { kind: 'all' } : { kind: 'application', applicationId },
    denominator: 'latest_correlated_messages',
    counts: {
      correlatedMessages: 0,
      linkedMessages: 0,
      automaticLinks: 0,
      agentLinks: 0,
      clarifications: 0,
      mislinkRetractions: 0
    },
    rates: { automaticLink: null, agentLink: null, clarify: null },
    timeToLink: { samples: 0, excludedSamples: 0, averageMs: null, medianMs: null, p95Ms: null }
  };
}

module.exports = { METRICS_SCHEMA_VERSION, readCorrelationMetrics };
