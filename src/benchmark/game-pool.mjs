/**
 * Run async task factories with a bounded worker pool.
 *
 * Tasks are started in order; each factory is invoked exactly once. The
 * returned array preserves input order regardless of completion order. A
 * rejected task is captured in place (as {error}) so every other task still
 * finishes; the caller decides how to surface failures.
 */
export async function runWithConcurrency(taskFactories, limit = 1) {
  if (!Array.isArray(taskFactories)) throw new TypeError('taskFactories must be an array');
  const size = Math.max(1, Math.min(Number(limit) || 1, taskFactories.length || 1));
  const results = new Array(taskFactories.length).fill(undefined);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= taskFactories.length) return;
      try {
        results[index] = { value: await taskFactories[index]() };
      } catch (error) {
        results[index] = { error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, Math.max(1, taskFactories.length)) }, worker));
  return results;
}
