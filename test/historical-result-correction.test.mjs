import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const ORIGINAL_SHA256 = '2551905c21dee56730a0f1a692ee23b3b6e729921252233a55e14604c360c9de';
const sourceUrl = new URL('../docs/results/real-public-20260828-high2.json', import.meta.url);
const correctionUrl = new URL('../docs/results/real-public-20260828-high2.correction-v1.json', import.meta.url);

test('historical result stays byte-identical and its correction fails closed', () => {
  const sourceBytes = fs.readFileSync(sourceUrl);
  const source = JSON.parse(sourceBytes);
  const correction = JSON.parse(fs.readFileSync(correctionUrl, 'utf8'));

  assert.equal(crypto.createHash('sha256').update(sourceBytes).digest('hex'), ORIGINAL_SHA256);
  assert.equal(correction.schema, 'avo.historical-result-correction.v1');
  assert.equal(correction.sourceArtifact.sha256, ORIGINAL_SHA256);
  assert.equal(correction.sourceArtifact.bytes, sourceBytes.length);
  assert.equal(correction.sourceArtifact.file, 'real-public-20260828-high2.json');
  assert.equal(correction.sourceArtifact.runId, source.runId);
  assert.equal(correction.scope, 'interpretation-only');
  assert.deepEqual(correction.classification, {
    evidenceClass: 'historical-diagnostic',
    comparable: false,
    official: false,
    acceptedOfficialScore: null,
  });
  assert.deepEqual(correction.retainedSourceObservations, {
    games: source.aggregates.games,
    wins: source.aggregates.wins,
    levelsCompletedReported: source.aggregates.levelsCompleted,
    actionsReported: source.aggregates.actions,
    scorecardValueObserved: source.officialScore.value,
    scorecardOriginObserved: source.officialScore.origin,
    scorecardValueAcceptedAsOfficial: false,
  });
  assert.deepEqual(correction.reasonCodes, [
    'cross-commit-recovery-without-run-capsule',
    'initial-persistent-state-unattested',
    'exact-scorecard-execution-coverage-unavailable',
  ]);
  assert.notEqual(source.provenance.resume.originalGitSha, source.provenance.resume.resumedAtGitSha);
  assert.equal(Object.hasOwn(source, 'scorecardEvidence'), false);
});

test('active benchmark documentation links the hash-bound correction', () => {
  for (const documentUrl of [
    new URL('../README.md', import.meta.url),
    new URL('../docs/VALIDATION_RESULTS.md', import.meta.url),
  ]) {
    assert.match(
      fs.readFileSync(documentUrl, 'utf8'),
      /real-public-20260828-high2\.correction-v1\.json/,
    );
  }
});
