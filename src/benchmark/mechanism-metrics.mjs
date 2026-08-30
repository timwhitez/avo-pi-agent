export const MECHANISM_METRIC_FIELDS = Object.freeze([
  'modelCalls',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'totalTokens',
  'modelLatencyMs',
  'providerHttpRequests',
  'providerRetries',
  'providerErrors',
  'toolCalls',
  'toolFailures',
  'contextCompactions',
  'toolResultTruncations',
  'evidenceRetrievals',
  'observeCalls',
  'trajectoryReadCalls',
  'actCalls',
  'actionSequenceCalls',
  'resetCalls',
  'finishCalls',
  'memoryCalls',
  'journalCalls',
  'supervisorInterventions',
  'workspaceCalls',
  'workspaceFailures',
  'actionBudgetExhaustions',
  'outerTurnBudgetExhaustions',
]);

export function normalizeMechanismMetrics(value, name = 'mechanism metrics') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const metrics = structuredClone(value);
  if (Object.keys(metrics).sort().join('\0') !== MECHANISM_METRIC_FIELDS.slice().sort().join('\0')) {
    throw new Error(`${name} fields are malformed`);
  }
  for (const field of MECHANISM_METRIC_FIELDS) nonNegativeInteger(metrics[field], `${name}.${field}`);
  if (metrics.reasoningTokens > metrics.outputTokens) throw new Error(`${name}.reasoningTokens exceeds outputTokens`);
  if (metrics.toolFailures > metrics.toolCalls) throw new Error(`${name}.toolFailures exceeds toolCalls`);
  if (metrics.workspaceFailures > metrics.workspaceCalls) throw new Error(`${name}.workspaceFailures exceeds workspaceCalls`);
  if (metrics.evidenceRetrievals < metrics.observeCalls + metrics.trajectoryReadCalls) {
    throw new Error(`${name}.evidenceRetrievals is smaller than successful observation retrievals`);
  }
  const interfaceFields = [
    'observeCalls', 'trajectoryReadCalls', 'actCalls',
    'actionSequenceCalls', 'resetCalls', 'finishCalls',
  ];
  for (const field of interfaceFields) {
    if (metrics[field] > metrics.toolCalls) throw new Error(`${name}.${field} exceeds toolCalls`);
  }
  if (interfaceFields.reduce((sum, field) => sum + metrics[field], 0) > metrics.toolCalls) {
    throw new Error(`${name} successful interface calls exceed toolCalls`);
  }
  if (metrics.toolResultTruncations > metrics.contextCompactions) {
    throw new Error(`${name}.toolResultTruncations exceeds contextCompactions`);
  }
  return deepFreeze(metrics);
}

export function aggregateMechanismMetrics(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (values.every((value) => value === null || value === undefined)) return null;
  if (values.some((value) => value === null || value === undefined)) {
    throw new Error('mechanism telemetry must be either complete or entirely unavailable');
  }
  const totals = Object.fromEntries(MECHANISM_METRIC_FIELDS.map((field) => [field, 0]));
  for (const [index, value] of values.entries()) {
    const metrics = normalizeMechanismMetrics(value, `mechanism metrics ${index}`);
    for (const field of MECHANISM_METRIC_FIELDS) totals[field] += metrics[field];
  }
  return normalizeMechanismMetrics(totals, 'aggregate mechanism metrics');
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
