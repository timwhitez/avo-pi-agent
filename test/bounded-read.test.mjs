import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ReadRequestError,
  canonicalSource,
  decodeCursor,
  encodeCursor,
  fitsBound,
  isSafeCut,
  packListPage,
  previewText,
  readDetailEnvelope,
  readErrorMessage,
  readRequestError,
  resolveToolResultMaxChars,
  sha256Hex,
} from '../src/core/bounded-read.mjs';
import { canonicalJson } from '../src/local/canonical-json.mjs';

const FIELDS = { schema: 'test.bounded.v1', ok: true, view: 'record', recordId: 'record-1' };
const CUT = { v: 1, collection: 'proposals', snapshotSha256: 'a'.repeat(64), afterId: 'proposal-000000000001' };

function caught(run, pattern) {
  try {
    run();
  } catch (error) {
    if (pattern) assert.match(String(error.message), pattern);
    return error;
  }
  throw new Error('expected the call to throw');
}

function detailLength({ source, contentSha256, offset, end }) {
  const isFinal = end >= source.length;
  return JSON.stringify({
    ...FIELDS,
    encoding: 'canonical-json',
    contentSha256,
    totalChars: source.length,
    offset,
    chunk: source.slice(offset, end),
    nextOffset: isFinal ? null : end,
    nextRequest: isFinal ? null : { view: 'record', recordId: 'record-1', offset: end, expectedSha256: contentSha256 },
  }).length;
}

test('the effective bound comes from explicit config, then the environment, then the default', () => {
  assert.equal(resolveToolResultMaxChars({ toolResultMaxChars: 4096 }, { AVO_TOOL_RESULT_MAX_CHARS: '24000' }), 4096);
  assert.equal(resolveToolResultMaxChars({}, { AVO_TOOL_RESULT_MAX_CHARS: '7000' }), 7000);
  assert.equal(resolveToolResultMaxChars({}, { AVO_TOOL_RESULT_MAX_CHARS: '' }), 24_000);
  assert.equal(resolveToolResultMaxChars({}, {}), 24_000);
  assert.equal(resolveToolResultMaxChars(), 24_000);

  for (const invalid of [null, 0, -1, 1.5, '4096', Number.MAX_SAFE_INTEGER + 2, Number.NaN]) {
    assert.throws(() => resolveToolResultMaxChars({ toolResultMaxChars: invalid }), /toolResultMaxChars/,
      `config ${String(invalid)}`);
  }
  for (const invalid of ['0', '-5', '1x', 'abc', '4096.5', '2e3']) {
    assert.throws(() => resolveToolResultMaxChars({}, { AVO_TOOL_RESULT_MAX_CHARS: invalid }),
      /AVO_TOOL_RESULT_MAX_CHARS/, `env ${invalid}`);
  }
});

test('previews stay within 160 UTF-16 code units without splitting a surrogate pair', () => {
  const short = previewText('abc');
  assert.deepEqual(short, { preview: 'abc', previewTruncated: false });
  assert.equal(previewText('x'.repeat(160)).previewTruncated, false);
  const long = previewText('x'.repeat(200));
  assert.equal(long.preview.length, 160);
  assert.equal(long.previewTruncated, true);
  const emoji = previewText(`${'x'.repeat(159)}😀tail`);
  assert.equal(emoji.previewTruncated, true);
  assert.equal(emoji.preview.length, 159, 'the boundary backs off the whole surrogate pair');
  assert.equal(emoji.preview.includes('\ud83d'), false);
  assert.equal(isSafeCut('😀', 0), true);
  assert.equal(isSafeCut('😀', 1), false);
  assert.equal(isSafeCut('😀', 2), true);
});

test('a requested final page is tried before any non-final prefix', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const envelopeFor = (selected, last, isFinal) => ({
    schema: 'test.list.v1',
    items: selected.map((item) => item.id),
    returned: selected.length,
    nextCursor: isFinal ? null : 'cursor',
    nextRequest: isFinal ? null : { limit: 3, cursor: 'cursor', afterId: last.id },
  });
  const finalEnvelope = envelopeFor(items, items.at(-1), true);
  const exact = JSON.stringify(finalEnvelope).length;
  const packed = packListPage({ items, limit: 3, B: exact, envelopeFor });
  assert.deepEqual(packed.items, ['a', 'b', 'c']);
  assert.equal(packed.nextRequest, null);
  assert.equal(fitsBound(packed, exact), true);

  // With more data behind the page the navigation must fit; when it cannot,
  // the read fails instead of returning the same items without progress.
  const withNav = caught(() => packListPage({ items, limit: 3, B: exact, hasMore: true, envelopeFor }));
  assert.equal(withNav.code, 'READ_BUDGET_TOO_SMALL');
  const prefixed = packListPage({
    items, limit: 3, B: JSON.stringify(envelopeFor(items, items.at(-1), false)).length, hasMore: true, envelopeFor,
  });
  assert.deepEqual(prefixed.items, ['a', 'b', 'c']);
  assert.ok(prefixed.nextRequest);

  const smaller = packListPage({ items, limit: 2, B: JSON.stringify(envelopeFor(items.slice(0, 2), items[1], false)).length, envelopeFor });
  assert.deepEqual(smaller.items, ['a', 'b']);
  assert.ok(smaller.nextRequest);

  const empty = packListPage({ items: [], limit: 3, B: JSON.stringify(envelopeFor([], null, true)).length, envelopeFor });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.nextRequest, null);
});

test('an unrepresentable list page fails instead of returning a progress-free page', () => {
  const items = [{ id: 'a' }, { id: 'b' }];
  const envelopeFor = (selected, last, isFinal) => ({
    schema: 'test.list.v1',
    items: selected.map((item) => item.id),
    nextCursor: isFinal ? null : 'cursor',
    nextRequest: isFinal ? null : { cursor: 'cursor' },
  });
  assert.equal(caught(() => packListPage({ items, limit: 2, B: 20, envelopeFor })).code, 'READ_BUDGET_TOO_SMALL');
  assert.equal(caught(() => packListPage({ items: [], limit: 2, B: 20, envelopeFor })).code, 'READ_BUDGET_TOO_SMALL');
});

test('the final detail chunk is tried first and an exact fit is enough', () => {
  const value = { payload: 'a'.repeat(400), nested: { list: [1, 2, 3] } };
  const { source, contentSha256 } = canonicalSource(value);
  const finalLength = detailLength({ source, contentSha256, offset: 0, end: source.length });
  const shortLength = detailLength({ source, contentSha256, offset: 0, end: source.length - 1 });
  assert.ok(shortLength > finalLength, 'a non-final chunk carries navigation overhead');

  const exact = readDetailEnvelope({
    value, offset: 0, B: finalLength, fields: FIELDS,
    nextRequest: (nextOffset, hash) => ({ offset: nextOffset, expectedSha256: hash }),
  });
  assert.equal(exact.chunk, source);
  assert.equal(exact.nextOffset, null);
  assert.equal(exact.nextRequest, null);
  assert.equal(JSON.stringify(exact).length, finalLength);
  assert.equal(exact.contentSha256, sha256Hex(source));
  assert.deepEqual(JSON.parse(exact.chunk), JSON.parse(source));
});

test('detail chunking advances, respects escaped length and reassembles byte-exactly', () => {
  const values = [
    { text: 'quotes " and \\ backslash and \n newline and \t tab and \u0001 control' },
    { text: '中文文本 😀👩‍💻 ok' },
    { text: `${'x'.repeat(300)}😀${'y'.repeat(300)}` },
    { text: 'short' },
  ];
  for (const value of values) {
    const { source, contentSha256 } = canonicalSource(value);
    const B = 420;
    let offset = 0;
    let assembled = '';
    let pages = 0;
    let request = null;
    for (;;) {
      const envelope = readDetailEnvelope({
        value, offset, expectedSha256: offset === 0 ? undefined : contentSha256, B, fields: FIELDS,
        nextRequest: (nextOffset, hash) => ({ offset: nextOffset, expectedSha256: hash }),
      });
      assert.ok(JSON.stringify(envelope).length <= B, `${JSON.stringify(envelope).length} <= ${B}`);
      assert.equal(envelope.chunk.length >= 0, true);
      assembled += envelope.chunk;
      pages += 1;
      if (envelope.nextOffset === null) {
        assert.equal(envelope.nextRequest, null);
        break;
      }
      assert.ok(envelope.chunk.length > 0, 'a non-final chunk makes progress');
      assert.ok(envelope.nextOffset > offset);
      assert.equal(isSafeCut(source, envelope.nextOffset), true);
      assert.equal(envelope.nextRequest.expectedSha256, contentSha256);
      request = envelope.nextRequest;
      offset = request.offset;
      assert.ok(pages <= 60);
    }
    assert.equal(assembled, source);
    assert.deepEqual(JSON.parse(assembled), JSON.parse(canonicalJson(value)));
  }
});

test('detail reads reject invalid offsets and stale hashes and terminate at the end', () => {
  const value = { payload: 'z'.repeat(120), emoji: '😀' };
  const { source, contentSha256 } = canonicalSource(value);
  const nextRequest = (nextOffset, hash) => ({ offset: nextOffset, expectedSha256: hash });

  const invalidOffset = caught(() => readDetailEnvelope({
    value, offset: source.length + 1, expectedSha256: contentSha256, B: 4096, fields: FIELDS, nextRequest,
  }));
  assert.equal(invalidOffset.code, 'INVALID_READ_REQUEST');
  assert.equal(caught(() => readDetailEnvelope({
    value, offset: 3, B: 4096, fields: FIELDS, nextRequest,
  })).code, 'INVALID_READ_REQUEST');
  assert.equal(caught(() => readDetailEnvelope({
    value, offset: 0, expectedSha256: 'not-a-hash', B: 4096, fields: FIELDS, nextRequest,
  })).code, 'INVALID_READ_REQUEST');
  assert.equal(caught(() => readDetailEnvelope({
    value, offset: 0, expectedSha256: 'f'.repeat(64), B: 4096, fields: FIELDS, nextRequest,
  })).code, 'STALE_READ');

  const emojiIndex = source.indexOf('😀');
  assert.equal(caught(() => readDetailEnvelope({
    value, offset: emojiIndex + 1, expectedSha256: contentSha256, B: 4096, fields: FIELDS, nextRequest,
  })).code, 'INVALID_READ_REQUEST');
  const boundary = readDetailEnvelope({
    value, offset: emojiIndex, expectedSha256: contentSha256, B: 4096, fields: FIELDS, nextRequest,
  });
  assert.equal(boundary.chunk.startsWith('😀'), true);

  const end = readDetailEnvelope({
    value, offset: source.length, expectedSha256: contentSha256, B: 420, fields: FIELDS, nextRequest,
  });
  assert.equal(end.chunk, '');
  assert.equal(end.nextOffset, null);
  assert.equal(end.nextRequest, null);
});

test('a bound too small for one character with navigation fails explicitly', () => {
  const value = { payload: 'q'.repeat(80) };
  const error = caught(() => readDetailEnvelope({
    value, offset: 0, B: 120, fields: FIELDS,
    nextRequest: (nextOffset, hash) => ({ offset: nextOffset, expectedSha256: hash }),
  }));
  assert.equal(error.code, 'READ_BUDGET_TOO_SMALL');
});

test('detail reads are deterministic for the same value and bound', () => {
  const value = { payload: 'd'.repeat(500) };
  const options = {
    value, offset: 0, B: 600, fields: FIELDS,
    nextRequest: (nextOffset, hash) => ({ offset: nextOffset, expectedSha256: hash }),
  };
  assert.deepEqual(readDetailEnvelope(options), readDetailEnvelope(options));
});

test('cursors round-trip and reject malformed, oversized or versioned input', () => {
  const encoded = encodeCursor(CUT);
  assert.deepEqual(decodeCursor(encoded), CUT);
  assert.ok(encoded.length <= 2048);

  for (const invalid of [
    '',
    'not!!base64',
    'x'.repeat(2049),
    Buffer.from('{not json', 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify({ ...CUT, v: 2 }), 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify({ ...CUT, snapshotSha256: 'short' }), 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify({ ...CUT, afterId: '' }), 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify({ ...CUT, extra: 1 }), 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify([CUT]), 'utf8').toString('base64url'),
  ]) {
    const error = caught(() => decodeCursor(invalid), /cursor/);
    assert.equal(error.code, 'INVALID_CURSOR');
  }
  assert.equal(caught(() => decodeCursor(null), /cursor/).code, 'INVALID_CURSOR');
});

test('read errors expose their own code and a short fixed message', () => {
  const error = readRequestError('STALE_CURSOR');
  assert.equal(error instanceof ReadRequestError, true);
  assert.equal(error.code, 'STALE_CURSOR');
  assert.equal(error.message, readErrorMessage('STALE_CURSOR'));
  for (const code of ['INVALID_READ_REQUEST', 'READ_NOT_FOUND', 'INVALID_CURSOR', 'STALE_CURSOR', 'STALE_READ', 'READ_BUDGET_TOO_SMALL']) {
    assert.ok(JSON.stringify({ ok: false, code, message: readErrorMessage(code) }).length <= 256, code);
  }
  assert.ok(fitsBound({ ok: false, code: 'STALE_READ', message: readErrorMessage('STALE_READ') }, 256));
});
