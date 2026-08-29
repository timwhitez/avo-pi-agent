import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCompetitionReportAuthority,
  initialAuthority,
  normalizeReasoningLevel,
  requireRunMode,
  summarizeMissionControlReport,
} from '../lib/run-authority.mjs';
import {
  privateRunCapsuleEvidenceFixture,
  publicRunCapsuleFixture,
} from '../../../test/support/run-capsule.mjs';

const privateCapsuleEvidence = privateRunCapsuleEvidenceFixture();

function authoritative(overrides = {}) {
  return {
    status: 'complete',
    completeness: { complete: true, expectedCount: 25, actualCount: 25 },
    loopAttestation: { complete: true, loop: 'pi-sdk' },
    officialScore: { value: 0, origin: 'aggregateScorecard.score' },
    privateArtifactHashes: {
      runCapsule: { file: 'run-capsule.json', sha256: privateCapsuleEvidence.sha256 },
    },
    aggregates: { wins: 3, totalLevels: 10, totalActions: 100 },
    provenance: {
      runCapsule: publicRunCapsuleFixture(),
      noMockAttestation: true,
      wireApi: 'responses',
      publicGameCount: 25,
      providerPreflight: {
        ok: true,
        outputVerified: true,
        challengeVerified: true,
        responseFreshnessVerified: true,
      },
      arcRuntime: { officialPackageAttested: true },
      arcAuth: { keyAcquired: true, mode: 'anonymous-auto' },
    },
    ...overrides,
  };
}

test('invalid modes fail closed and optional reasoning defaults only when omitted', () => {
  assert.equal(requireRunMode('diagnostic'), 'diagnostic');
  assert.equal(requireRunMode('competition'), 'competition');
  for (const value of [undefined, null, '', 'diag', 1, false]) {
    assert.throws(() => requireRunMode(value), /mode must be exactly/);
  }
  assert.equal(normalizeReasoningLevel(undefined), 'max');
  assert.equal(normalizeReasoningLevel(''), 'max');
  assert.equal(normalizeReasoningLevel('high'), 'high');
  for (const value of ['HIGH', 'extreme', 3, false]) {
    assert.throws(() => normalizeReasoningLevel(value), /reasoningLevel/);
  }
});

test('competition starts pending and diagnostic is permanently non-official', () => {
  assert.deepEqual(initialAuthority('competition'), {
    requestedMode: 'competition', executionMode: 'competition', official: false,
    authorityState: 'pending', authorityReasons: [],
  });
  const diagnostic = summarizeMissionControlReport({
    status: 'complete', kind: 'diagnostic-public-environments',
    summary: { diagnosticScore: 0, diagnosticScoreOrigin: 'local-diagnostic' },
  }, 'diagnostic');
  assert.equal(diagnostic.official, false);
  assert.equal(diagnostic.authorityState, 'diagnostic');
  assert.equal(diagnostic.diagnosticScore, 0);
});

test('complete but non-authoritative competition report is rejected', () => {
  const report = authoritative({
    officialScore: { value: 0.7, origin: 'local.heuristic' },
  });
  const authority = evaluateCompetitionReportAuthority(report, { privateCapsuleEvidence });
  assert.equal(authority.accepted, false);
  assert.match(authority.reasons.join(' '), /score origin/);
  const summary = summarizeMissionControlReport(report, 'competition', { privateCapsuleEvidence });
  assert.equal(summary.official, false);
  assert.equal(summary.authorityState, 'rejected');
  assert.equal(summary.officialScore, null);
  assert.equal(summary.reportedScore, 0.7);
});

test('public report hashes cannot replace actual private capsule evidence', () => {
  const report = authoritative();
  report.privateArtifactHashes.runCapsule.sha256 =
    report.provenance.runCapsule.capsuleEvidenceSha256;
  const authority = evaluateCompetitionReportAuthority(report);
  assert.equal(authority.accepted, false);
  assert.ok(authority.reasons.some((reason) => /private run capsule artifact/.test(reason)));
});

test('official state requires all benchmark provenance gates and preserves score zero', () => {
  const summary = summarizeMissionControlReport(
    authoritative(),
    'competition',
    { privateCapsuleEvidence },
  );
  assert.equal(summary.official, true);
  assert.equal(summary.authorityState, 'official');
  assert.equal(summary.officialScore, 0);
  assert.deepEqual(summary.authorityReasons, []);

  for (const report of [
    authoritative({ loopAttestation: { complete: false, loop: 'pi-sdk' } }),
    authoritative({ provenance: { ...authoritative().provenance, noMockAttestation: false } }),
    authoritative({ completeness: { complete: true, expectedCount: 25, actualCount: 24 } }),
    authoritative({ officialScore: { value: null, origin: 'aggregateScorecard.score' } }),
    authoritative({
      provenance: {
        ...authoritative().provenance,
        runCapsule: publicRunCapsuleFixture({ runClass: 'diagnostic-migrated', comparable: false }),
      },
    }),
  ]) {
    assert.equal(summarizeMissionControlReport(
      report,
      'competition',
      { privateCapsuleEvidence },
    ).official, false);
  }
});
