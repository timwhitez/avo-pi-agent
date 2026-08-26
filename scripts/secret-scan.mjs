#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const ignoredDirs = new Set(['.git', 'node_modules', '.venv', 'runs', '.avo-memory', 'environment_files', 'vendor']);
const allowedFiles = new Set(['.env.example']);
const findings = [];
const openAiPrefix = ['s', 'k', '-'].join('');
const githubPrefixes = ['ghp_', 'github_pat_'];
const patterns = [
  ['OpenAI-style secret', new RegExp(`\\b${openAiPrefix}[A-Za-z0-9_-]{16,}\\b`, 'g')],
  ['GitHub token', new RegExp(`\\b(?:${githubPrefixes.join('|')})[A-Za-z0-9_]{20,}\\b`, 'g')],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['literal bearer token', /Authorization\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._-]{16,}/gi],
  ['literal non-placeholder IPv4 endpoint', /https?:\/\/(?!127\.0\.0\.1|0\.0\.0\.0|localhost)(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/g],
];

const gitCandidates = listGitCandidates(root);
if (gitCandidates) {
  for (const rel of gitCandidates) scan(path.join(root, rel), rel);
} else {
  walk(root);
}
if (findings.length) {
  console.error('Secret scan failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log('Secret scan passed.');

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) walk(full);
    else scan(full, rel);
  }
}

function scan(file, rel) {
  if (rel.startsWith('.env') && !allowedFiles.has(rel)) {
    findings.push(`${rel}: environment file must not be committed`);
    return;
  }
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) {
    findings.push(`${rel}: symbolic link cannot be inspected safely`);
    return;
  }
  if (!stat.isFile()) return;
  if (stat.size > 2_000_000) return;
  const data = fs.readFileSync(file);
  if (data.includes(0)) return;
  const text = data.toString('utf8');
  for (const [label, regex] of patterns) {
    regex.lastIndex = 0;
    if (regex.test(text)) findings.push(`${rel}: ${label}`);
  }
}

function listGitCandidates(directory) {
  const result = spawnSync('git', [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z',
  ], {
    cwd: directory,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((value) => value.replaceAll('/', path.sep));
}
