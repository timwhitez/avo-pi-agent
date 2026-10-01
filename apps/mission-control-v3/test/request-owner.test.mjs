import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestOwner } from '../lib/request-owner.mjs';

const deferred = () => Promise.withResolvers();

test('only the newest request can commit success, failure or finally, even if abort is ignored', async () => {
  for (const failure of [false, true]) {
    const owner = createRequestOwner();
    const old = deferred();
    const fresh = deferred();
    const writes = [];
    const read = async (pending) => {
      const token = owner.begin();
      try {
        const value = await pending.promise;
        if (token.isCurrent()) writes.push(value);
      } catch (error) {
        if (token.isCurrent()) writes.push(error.message);
      } finally {
        if (token.isCurrent()) writes.push('finished');
      }
      return token;
    };
    const first = read(old);
    const second = read(fresh);
    fresh.resolve('B');
    await second;
    if (failure) old.reject(new Error('Run not found'));
    else old.resolve('A');
    const oldToken = await first;
    assert.equal(oldToken.signal.aborted, true);
    assert.deepEqual(writes, ['B', 'finished']);
  }
});

test('selection and session cleanup revoke queued callbacks and A → B → A requests', async () => {
  const owner = createRequestOwner();
  const firstA = owner.begin();
  owner.invalidate();
  const b = owner.begin();
  owner.invalidate();
  const secondA = owner.begin();
  assert.equal(firstA.isCurrent(), false);
  assert.equal(b.isCurrent(), false);
  assert.equal(secondA.isCurrent(), true);
  const queued = Promise.resolve().then(() => secondA.isCurrent());
  owner.invalidate();
  owner.invalidate();
  assert.equal(await queued, false);
  assert.equal(secondA.signal.aborted, true);
  // StrictMode cleanup must allow the next mount to issue a fresh request.
  assert.equal(owner.begin().isCurrent(), true);
});

test('list, selection and comparison have independent request ownership', () => {
  const owners = Array.from({ length: 3 }, createRequestOwner);
  const tokens = owners.map((owner) => owner.begin());
  owners[1].invalidate();
  assert.deepEqual(tokens.map((token) => token.isCurrent()), [true, false, true]);
});
