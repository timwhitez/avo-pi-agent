import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { diagnosticSelection, selectDiagnosticGames, diagnosticReportFields } from '../src/benchmark/diagnostic.mjs';

test('diagnostic selection resolves exact public versions and rejects ambiguity', () => {
  const games = [{ gameId: 'a', versionedGameId: 'a-v1' }, { gameId: 'b', versionedGameId: 'b-v2' }];
  Object.defineProperty(games, 'arcAuth', { value: { mode: 'registered', keyAcquired: true } });
  assert.deepEqual(selectDiagnosticGames(diagnosticSelection(['--game=b']), games), [games[1]]);
  assert.equal(selectDiagnosticGames(['b'], games).arcAuth, games.arcAuth);
  assert.deepEqual(selectDiagnosticGames(diagnosticSelection(['--all']), games), games);
  assert.throws(() => diagnosticSelection(['--game=a,a']), /duplicate/);
  assert.throws(() => diagnosticSelection(['--all', '--game=a']), /selection requires/);
  assert.throws(() => selectDiagnosticGames(['missing'], games), /unavailable/);
  assert.throws(() => selectDiagnosticGames(['a', 'a-v1'], games), /same resolved game/);
  assert.throws(() => selectDiagnosticGames(['a'], [...games, { gameId: 'a', versionedGameId: 'a-v2' }]), /ambiguous/);
  assert.equal(diagnosticReportFields(null).official, false);
  const report = diagnosticReportFields(['a'], { games: 1, wins: 0, levelsCompleted: 2, totalLevels: 3, actions: 7 }, 0);
  assert.equal(report.summary.totalActions, 7);
  assert.equal(report.summary.totalLevelsCompleted, 2);
  assert.equal(report.summary.diagnosticScore, 0);
});

test('actual diagnostic wrapper records primary configuration failure without source report', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-diagnostic-failure-'));
  try {
    const run = spawnSync(process.execPath, [path.resolve('scripts/run-public-diagnostic-locked.mjs'), '--game=a'], {
      cwd: root, detached: true, encoding: 'utf8', timeout: 15000,
      env: { PATH: process.env.PATH, AVO_DISABLE_DOTENV: '1', AVO_REAL_RUN_ID: 'diagnostic-config' },
    });
    assert.equal(run.status, 1, run.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'runs/diagnostic/diagnostic-config.json')));
    assert.equal(report.failedStage, 'configuration');
    assert.equal(report.official, false);
    assert.equal(report.executionMode, 'diagnostic');
    assert.match(report.error, /OPENAI|provider/i);
    assert.doesNotMatch(report.error, /ENOENT|source report/);
    assert.equal(fs.existsSync(path.join(root, 'runs/private/.local-execution.lock')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
