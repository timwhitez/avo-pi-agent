// Abort saves work; identity also rejects responses already queued when aborted.
export function createRequestOwner() {
  let current = null;
  let pending = false;
  const invalidate = () => {
    current?.abort();
    current = null;
    pending = false;
  };
  return {
    invalidate,
    begin({ replace = true } = {}) {
      if (!replace && pending) return null;
      invalidate();
      const controller = new AbortController();
      current = controller;
      pending = true;
      return {
        signal: controller.signal,
        isCurrent: () => current === controller,
        finish: () => { if (current === controller) pending = false; },
      };
    },
  };
}
