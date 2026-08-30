import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCompleteLocalAcceptance } from '../src/local/complete-acceptance.mjs';
import { nonNegativeIntegerOrNull } from '../src/local/numeric.mjs';

function validRepair() {
  return {
    status: 'complete',
    clean: true,
    rounds: [{ round: 0 }],
    final: {
      authoritative: true,
      clean: true,
      runCapsuleHash: 'a'.repeat(64),
      runClass: 'cold-start',
      runCapsuleComparable: true,
      findingCount: 0,
      openFindingCount: 0,
      officialScore: {
        value: 0.75,
        origin: 'aggregateScorecard.score',
      },
    },
  };
}

test('strict non-negative integer parser rejects coercion traps', () => {
  for (const value of [null, undefined, '', ' ', false, true, [], [0], {}, -1, 1.5, '0x10']) {
    assert.equal(nonNegativeIntegerOrNull(value), null, `unexpected integer for ${JSON.stringify(value)}`);
  }
  assert.equal(nonNegativeIntegerOrNull(0), 0);
  assert.equal(nonNegativeIntegerOrNull('0'), 0);
  assert.equal(nonNegativeIntegerOrNull(12), 12);
});

test('complete local acceptance requires explicit authoritative zero findings and official score', () => {
  const result = evaluateCompleteLocalAcceptance(validRepair());
  assert.equal(result.accepted, true);
  assert.equal(result.officialScore, 0.75);
  assert.equal(result.findingCount, 0);
  assert.equal(result.openFindingCount, 0);
  assert.equal(result.officialOrigin, true);
});

test('a genuine official score of zero remains acceptable', () => {
  const repair = validRepair();
  repair.final.officialScore.value = 0;
  const result = evaluateCompleteLocalAcceptance(repair);
  assert.equal(result.accepted, true);
  assert.equal(result.officialScore, 0);
});

test('missing/coercible score or finding counts can never complete the local run', () => {
  const invalid = [null, undefined, '', ' ', false, true, [], [0], {}, '0x10'];
  for (const value of invalid) {
    const score = validRepair();
    score.final.officialScore.value = value;
    assert.equal(evaluateCompleteLocalAcceptance(score).accepted, false, `score ${JSON.stringify(value)}`);

    const finding = validRepair();
    finding.final.findingCount = value;
    assert.equal(evaluateCompleteLocalAcceptance(finding).accepted, false, `finding ${JSON.stringify(value)}`);

    const open = validRepair();
    open.final.openFindingCount = value;
    assert.equal(evaluateCompleteLocalAcceptance(open).accepted, false, `open finding ${JSON.stringify(value)}`);
  }
});

test('non-official score origin and non-authoritative/dirty reports fail closed', () => {
  const local = validRepair();
  local.final.officialScore.origin = 'localHeuristic.score';
  assert.equal(evaluateCompleteLocalAcceptance(local).accepted, false);

  const nonAuthoritative = validRepair();
  nonAuthoritative.final.authoritative = false;
  assert.equal(evaluateCompleteLocalAcceptance(nonAuthoritative).accepted, false);

  const dirty = validRepair();
  dirty.clean = false;
  assert.equal(evaluateCompleteLocalAcceptance(dirty).accepted, false);

  const incomplete = validRepair();
  incomplete.status = 'exhausted';
  assert.equal(evaluateCompleteLocalAcceptance(incomplete).accepted, false);
});

test('missing or diagnostic-migrated capsule evidence fails closed', () => {
  const missing = validRepair();
  delete missing.final.runCapsuleHash;
  assert.equal(evaluateCompleteLocalAcceptance(missing).accepted, false);

  const migrated = validRepair();
  migrated.final.runClass = 'diagnostic-migrated';
  migrated.final.runCapsuleComparable = false;
  assert.equal(evaluateCompleteLocalAcceptance(migrated).accepted, false);
});
