export function parseTestTimeoutScale(value) {
  if (value === undefined) return 1;
  if (!/^(?:[1-9]|10)$/.test(value)) {
    throw new Error('AVO_TEST_TIMEOUT_SCALE must be an integer from 1 to 10');
  }
  return Number(value);
}

export const TEST_TIMEOUT_SCALE = parseTestTimeoutScale(process.env.AVO_TEST_TIMEOUT_SCALE);
export const testObservationBudget = (baselineMs) => baselineMs * TEST_TIMEOUT_SCALE;
