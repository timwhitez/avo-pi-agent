import fs from 'node:fs';
import path from 'node:path';

function parseDotEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadLocalEnv(cwd = process.cwd()) {
  if (process.env.AVO_DISABLE_DOTENV === '1') return;
  const file = path.join(cwd, '.env');
  if (!fs.existsSync(file)) return;
  const values = parseDotEnv(fs.readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function integer(name, fallback, min = 1) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
}

function enumValue(name, fallback, allowed) {
  const value = String(process.env[name] || fallback).trim().toLowerCase();
  if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

export function getRuntimeConfig({ requireProvider = true } = {}) {
  const provider = {
    baseUrl: process.env.OPENAI_BASE_URL?.replace(/\/$/, ''),
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT || 'max',
  };
  if (requireProvider) {
    const missing = Object.entries(provider)
      .filter(([key, value]) => key !== 'reasoningEffort' && !value)
      .map(([key]) => key);
    if (missing.length) {
      throw new Error(`Missing provider environment values: ${missing.join(', ')}`);
    }
  }
  return {
    provider,
    maxActions: integer('AVO_MAX_ACTIONS', 1000),
    maxOuterTurns: integer('AVO_MAX_OUTER_TURNS', 1000),
    stallWindow: integer('AVO_STALL_WINDOW', 8, 2),
    memoryDir: process.env.AVO_MEMORY_DIR || '.avo-memory',
    workspaceDir: process.env.AVO_WORKSPACE_DIR || '.avo-workspaces',
    workspaceMode: enumValue('AVO_WORKSPACE_MODE', 'files-only', ['disabled', 'files-only', 'isolated-python']),
    workspacePythonTimeoutMs: integer('AVO_WORKSPACE_PYTHON_TIMEOUT_MS', 10_000, 100),
    workspaceContainerRuntime: process.env.AVO_WORKSPACE_CONTAINER_RUNTIME || 'docker',
    workspaceContainerImage: process.env.AVO_WORKSPACE_CONTAINER_IMAGE || 'python:3.12-slim',
    python: process.env.ARC_PYTHON || '.venv/bin/python',
  };
}

export function publicConfigSummary(config) {
  return {
    providerConfigured: Boolean(config.provider.baseUrl && config.provider.apiKey && config.provider.model),
    wireApi: 'responses',
    reasoningEffort: config.provider.reasoningEffort,
    maxActions: config.maxActions,
    maxOuterTurns: config.maxOuterTurns,
    stallWindow: config.stallWindow,
    memoryDir: config.memoryDir,
    workspaceDir: config.workspaceDir,
    workspaceMode: config.workspaceMode,
    workspacePythonIsolated: config.workspaceMode === 'isolated-python',
  };
}
