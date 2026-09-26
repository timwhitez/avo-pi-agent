import { buildContextReceipt } from '../../src/trajectory/audit-events.mjs';

// Real-shaped context receipts for one run/game (#359). The production Pi loop
// emits one `prepared` receipt per logical model request and, per HTTP attempt,
// a `dispatch-attempt` followed by a `response-observed`; fixtures that are
// declared audit-ready must carry the same shape instead of an empty array.
export function contextReceiptsFor({
  runId,
  versionedGameId,
  modelCalls,
  cliAttempt = 1,
  attemptId = null,
  startSequence = 1,
}) {
  const receipts = [];
  let recordSequence = 0;
  for (let index = 0; index < modelCalls; index += 1) {
    const requestSequence = startSequence + index;
    const scope = { runId, versionedGameId, attemptId };
    const timing = () => {
      recordSequence += 1;
      return { recordSequence, monotonicTime: recordSequence * 1_000, clockDomain: 'fixture-context-receipts' };
    };
    const digest = String(index + 1).padStart(64, 'a');
    receipts.push(buildContextReceipt({
      scope,
      requestSequence,
      phase: 'prepared',
      payloadCanonicalSha256: digest,
      inputChars: 512 + index,
      ...timing(),
    }));
    receipts.push(buildContextReceipt({
      scope,
      requestSequence,
      phase: 'dispatch-attempt',
      httpAttempt: 1,
      coverage: { complete: true, omittedCount: 0, reason: null },
      payloadCanonicalSha256: digest,
      wireBodySha256: digest,
      wireMatchesPayload: true,
      wireBytes: 512 + index,
      ...timing(),
    }));
    receipts.push(buildContextReceipt({
      scope,
      requestSequence,
      phase: 'response-observed',
      httpAttempt: 1,
      responseStatus: 200,
      payloadCanonicalSha256: digest,
      ...timing(),
    }));
  }
  return receipts.map((receipt) => (cliAttempt === null ? receipt : { ...receipt, cliAttempt }));
}
