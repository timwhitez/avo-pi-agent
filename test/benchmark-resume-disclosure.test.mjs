import test from 'node:test';
import assert from 'node:assert/strict';

// The disclosure contract exercised through buildProvenance: a resumed run
// must publish both the original and the resume-time commit.
import { buildProvenance } from '../src/benchmark/provenance.mjs';

function provenanceWithResume(resumeContext, gitSha) {
  const games = [{ gameId: 'ls20', versionedGameId: 'ls20@1' }];
  const provenance = buildProvenance({
    provider: { baseUrl: 'https://provider.internal/v1', model: 'm', reasoningEffort: 'high' },
    providerPreflight: { challengeVerified: true, responseFreshnessVerified: true },
    games,
    runId: 'run-x',
    gitSha,
  });
  if (resumeContext) {
    provenance.resume = Object.freeze({
      resumed: true,
      resumedAt: new Date().toISOString(),
      originalGitSha: resumeContext.originalGitSha,
      resumedAtGitSha: resumeContext.resumedAtGitSha || gitSha,
      originalCreatedAt: resumeContext.originalCreatedAt,
    });
  }
  return provenance;
}

test('a resumed run discloses both commits in published provenance', () => {
  const provenance = provenanceWithResume(
    { originalGitSha: 'a'.repeat(40), resumedAtGitSha: 'b'.repeat(40), originalCreatedAt: '2026-08-28T06:45:00Z' },
    'b'.repeat(40),
  );
  assert.equal(provenance.gitSha, 'b'.repeat(40));
  assert.equal(provenance.resume.resumed, true);
  assert.equal(provenance.resume.originalGitSha, 'a'.repeat(40));
  assert.equal(provenance.resume.resumedAtGitSha, 'b'.repeat(40));
  assert.notEqual(provenance.resume.originalGitSha, provenance.resume.resumedAtGitSha);
});

test('a fresh run carries no resume disclosure', () => {
  const provenance = provenanceWithResume(null, 'c'.repeat(40));
  assert.equal(provenance.resume, undefined);
  assert.equal(provenance.gitSha, 'c'.repeat(40));
});
