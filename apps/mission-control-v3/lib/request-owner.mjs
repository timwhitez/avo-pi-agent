// Abort saves work; identity also rejects responses already queued when aborted.
export function createRequestOwner() {
  let current = null;
  const invalidate = () => {
    current?.abort();
    current = null;
  };
  return {
    invalidate,
    begin() {
      invalidate();
      const controller = new AbortController();
      current = controller;
      return {
        signal: controller.signal,
        isCurrent: () => current === controller,
      };
    },
  };
}
