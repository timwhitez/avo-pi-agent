import path from 'node:path';
import { EvidenceStore } from './evidence-store.mjs';
import { canonicalJson } from '../local/canonical-json.mjs';
import { packListPage, readDetailEnvelope, readRequestError, sha256Hex } from './bounded-read.mjs';
import { readJsonFileEvidence } from '../local/regular-file-evidence.mjs';
import { writeJsonAtomic } from '../benchmark/report-safe-files.mjs';

export const TEMPORAL_CONTRACT_V1 = freeze({
  schema: 'avo.sdk-temporal-contract.v1', admission: 'allow-partial',
  limits: {
    framesPerAction: 32, frameWidth: 64, frameHeight: 64, frameSourceBytes: 65536,
    actionSourceBytes: 262144, chunkSourceBytes: 49152, captureEnvelopeBytes: 16384,
    actionPointerBytes: 2048, unitFrames: 4096, unitCaptureActions: 4096,
    unitSourceBytes: 33554432, unitArchiveBytes: 50331648, unitEvents: 20000,
    controlReserveBytes: 4194304, controlReserveEvents: 10240,
    readCalls: 1024, readChars: 1048576, readResultChars: 24000, indexPageItems: 8,
  }, retention: 'private-run-lifetime-no-automatic-eviction',
});
const REF = /^evidence-[0-9]{6,}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const SCHEMAS = new Set(['intent', 'frame-chunk', 'action', 'read-charge'].map((name) => `avo.sdk-temporal-${name}.v1`));
export const temporalContractSha256 = (contract) => sha256Hex(canonicalJson(contract));

export function resolveTemporalEvidenceContract(value = 'off') {
  if (value === undefined || value === '' || value === 'off') return undefined;
  if (typeof value === 'string') {
    if (!['capture', 'capture-read'].includes(value)) throw new Error('AVO_SDK_TEMPORAL_EVIDENCE must be off, capture or capture-read');
    return freeze({ ...TEMPORAL_CONTRACT_V1, mode: value });
  }
  const expected = resolveTemporalEvidenceContract(value?.mode);
  if (!expected || canonicalJson(value) !== canonicalJson(expected)) throw new Error('temporal evidence contract differs from frozen v1');
  return expected;
}

export function validateTemporalScope(scope) {
  if (!scope || canonicalJson(Object.keys(scope).sort()) !== canonicalJson(['actionOrdinal', 'attemptId', 'episodeId', 'gameId', 'runId', 'versionedGameId'])
      || ['runId', 'versionedGameId', 'gameId'].some((key) => typeof scope[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(scope[key]))
      || !/^attempt-[0-9]{6,}$/.test(scope.attemptId) || !/^episode-[0-9]{6,}$/.test(scope.episodeId)
      || !Number.isSafeInteger(scope.actionOrdinal) || scope.actionOrdinal < 1) fail('SCOPE_MISMATCH');
  return scope;
}

export const TEMPORAL_READ_TOOL = freeze({
  name: 'trajectory_frames_read', label: 'Read historical SDK frames',
  description: 'Inspect frames already returned by one legal action or RESET. The final observation alone is current; these views are historical, with final-only metadata. Discover main action refs with view=actions (startSequence defaults to 1), then index, frame or region. Copy frameRequest/nextRequest exactly. Concatenate canonical JSON chunks to recover the grid. Reads spend no environment actions; saved coverage and read allowances are bounded and survive restart.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    view: { type: 'string', enum: ['actions', 'index', 'frame', 'region'] },
    ref: { type: 'string', maxLength: 64, pattern: REF.source },
    startSequence: { type: 'integer', minimum: 1 }, startFrameIndex: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 8 }, frameIndex: { type: 'integer', minimum: 0 },
    x: { type: 'integer', minimum: 0, maximum: 63 }, y: { type: 'integer', minimum: 0, maximum: 63 },
    width: { type: 'integer', minimum: 1, maximum: 64 }, height: { type: 'integer', minimum: 1, maximum: 64 },
    offset: { type: 'integer', minimum: 0 }, expectedSha256: { type: 'string', pattern: HASH.source },
  } },
});

export function normalizeTemporalRead(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_READ_REQUEST');
  const view = input.view === undefined ? 'actions' : input.view;
  const keys = {
    actions: ['view', 'startSequence', 'limit'], index: ['view', 'ref', 'startFrameIndex', 'limit'],
    frame: ['view', 'ref', 'frameIndex', 'offset', 'expectedSha256'],
    region: ['view', 'ref', 'frameIndex', 'x', 'y', 'width', 'height', 'offset', 'expectedSha256'],
  }[view];
  if (!keys || Object.keys(input).some((key) => !keys.includes(key))) fail('INVALID_READ_REQUEST');
  const integer = (key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const value = input[key] === undefined ? fallback : input[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_READ_REQUEST');
    return value;
  };
  if (view === 'actions') return { view, startSequence: integer('startSequence', 1, 1), limit: integer('limit', 8, 1, 8) };
  if (typeof input.ref !== 'string' || !REF.test(input.ref)) fail('INVALID_READ_REQUEST');
  if (view === 'index') return { view, ref: input.ref, startFrameIndex: integer('startFrameIndex', 0), limit: integer('limit', 8, 1, 8) };
  const request = { view, ref: input.ref, frameIndex: integer('frameIndex'), offset: integer('offset', 0) };
  if (input.expectedSha256 !== undefined) {
    if (typeof input.expectedSha256 !== 'string' || !HASH.test(input.expectedSha256)) fail('INVALID_READ_REQUEST');
    request.expectedSha256 = input.expectedSha256;
  }
  if (request.offset > 0 && !request.expectedSha256) fail('INVALID_READ_REQUEST');
  if (view === 'region') for (const key of ['x', 'y', 'width', 'height']) request[key] = integer(key, undefined, ['x', 'y'].includes(key) ? 0 : 1, ['x', 'y'].includes(key) ? 63 : 64);
  return request;
}

export function temporalGrid(grid, limits = TEMPORAL_CONTRACT_V1.limits) {
  if (!Array.isArray(grid) || !grid.length || grid.length > limits.frameHeight || !Array.isArray(grid[0]) || !grid[0].length || grid[0].length > limits.frameWidth
      || grid.some((row) => !Array.isArray(row) || row.length !== grid[0].length || row.some((cell) => !Number.isSafeInteger(cell)))) fail('FRAME_SHAPE_OR_CELLS');
  const source = canonicalJson(grid);
  if (Buffer.byteLength(source) > limits.frameSourceBytes) fail('FRAME_SOURCE_LIMIT');
  return { shape: [grid.length, grid[0].length], sourceSha256: sha256Hex(source), gridContentHash: sha256Hex(canonicalJson({ schema: 'avo.grid-content.v1', frame: grid })), sourceBytes: Buffer.byteLength(source), source };
}

export class TemporalEvidenceArchive {
  constructor({ memoryDir, runId, versionedGameId, gameId, contract, limits }) {
    this.contract = resolveTemporalEvidenceContract(contract);
    if (!this.contract) throw new Error('temporal archive requires an enabled contract');
    this.unit = { runId, versionedGameId, gameId };
    validateTemporalScope({ ...this.unit, attemptId: 'attempt-000001', episodeId: 'episode-000001', actionOrdinal: 1 });
    this.contractSha256 = temporalContractSha256(this.contract);
    this.limits = { ...this.contract.limits, ...limits };
    this.store = new EvidenceStore(path.join(memoryDir, 'evidence', 'temporal-v1'), versionedGameId, { authorityRoot: memoryDir });
    this.allowanceFile = this.store.file.replace(/\.jsonl$/, '.read-allowance.json');
    this.allowanceBytes = 0;
    this.failure = null;
  }

  load(parents = []) {
    try {
      this.store.load();
      if (!this.store.historyComplete) fail('ARCHIVE_INTEGRITY_FAILED');
      for (const record of this.store.events) {
        if (!SCHEMAS.has(record.schema)) fail('UNSUPPORTED_VERSION');
        if (!sameUnit(record.scope, this.unit)) fail('SCOPE_MISMATCH');
        if (record.contractSha256 !== this.contractSha256) fail('UNSUPPORTED_VERSION');
      }
      if (parents.some((event) => event.temporalEvidence?.manifestRef && !this.store.get(event.temporalEvidence.manifestRef))) fail('ARCHIVE_MISSING');
      this.verifyAllowance(this.usage());
    } catch (error) { this.failure = error.code || 'ARCHIVE_INTEGRITY_FAILED'; }
    return this;
  }

  usage() {
    const records = this.store.events;
    const charges = records.filter((r) => r.schema === 'avo.sdk-temporal-read-charge.v1');
    let readChars = 0;
    for (const [index, charge] of charges.entries()) {
      if (!Number.isSafeInteger(charge.resultChars) || charge.resultChars <= 0 || charge.readOrdinal !== index + 1
          || charge.cumulativeCalls !== index + 1 || charge.cumulativeChars !== readChars + charge.resultChars) fail('ARCHIVE_INTEGRITY_FAILED');
      readChars += charge.resultChars;
    }
    const frames = new Set();
    let sourceBytes = 0;
    for (const r of records) {
      if (r.schema === 'avo.sdk-temporal-frame-chunk.v1') {
        frames.add(`${r.intentRef}:${r.frameIndex}`);
        sourceBytes += r.chunk.join('').length;
      }
      if (r.schema === 'avo.sdk-temporal-action.v1') {
        for (const f of r.frames.filter((f) => f.source === 'parent-final-observation')) {
          frames.add(`${r.intentRef}:${f.index}`); sourceBytes += f.sourceBytes;
        }
      }
    }
    return { captureActions: records.filter((r) => r.schema === 'avo.sdk-temporal-intent.v1').length, frames: frames.size, sourceBytes,
      archiveBytes: this.allowanceBytes + records.reduce((n, r) => n + Buffer.byteLength(`${JSON.stringify(r)}\n`), 0), events: records.length, readCalls: charges.length, readChars };
  }

  verifyAllowance(usage) {
    let evidence;
    try { evidence = readJsonFileEvidence(this.allowanceFile, { root: this.store.authorityRoot, maxBytes: 2048, purpose: 'temporal read allowance' }); }
    catch (error) {
      if (error.code === 'ENOENT' && usage.readCalls === 0) return;
      fail('READ_CHARGE_LEDGER_INCOMPLETE');
    }
    this.allowanceBytes = evidence.bytes;
    const value = evidence.value;
    const last = this.store.events.findLast((r) => r.schema === 'avo.sdk-temporal-read-charge.v1');
    if (value.schema !== 'avo.sdk-temporal-read-allowance.v1' || canonicalJson(value.unit) !== canonicalJson(this.unit)
        || value.contractSha256 !== this.contractSha256 || value.readCalls !== usage.readCalls || value.readChars !== usage.readChars
        || value.lastResultTextSha256 !== last?.resultTextSha256) fail('READ_CHARGE_LEDGER_INCOMPLETE');
  }

  append(record, payload = false) {
    if (this.failure) fail(this.failure);
    const usage = this.usage();
    const sequence = this.store.sequence + 1;
    const core = { ...record, contractSha256: this.contractSha256, gameId: this.store.gameId, sequence };
    const digest = sha256Hex(JSON.stringify(core));
    const bytes = Buffer.byteLength(`${JSON.stringify({ ...core, id: `evidence-${String(sequence).padStart(6, '0')}-${digest.slice(0, 12)}`, digest })}\n`);
    const L = this.limits;
    if (bytes > (record.schema === 'avo.sdk-temporal-action.v1' ? L.captureEnvelopeBytes : this.store.maxEventBytes)) fail('ARCHIVE_RECORD_LIMIT');
    if (usage.archiveBytes + bytes > L.unitArchiveBytes - (payload ? L.controlReserveBytes : 0)
        || usage.events + 1 > L.unitEvents - (payload ? L.controlReserveEvents : 0)) fail('ARCHIVE_QUOTA_EXHAUSTED');
    try {
      const saved = this.store.append({ ...record, contractSha256: this.contractSha256 });
      if (Buffer.byteLength(`${JSON.stringify(saved)}\n`) !== bytes) throw new Error('temporal record was altered by bounded persistence');
      return saved;
    } catch (error) { this.failure = 'ARCHIVE_UNWRITABLE'; throw error; }
  }

  recordIntent(input) {
    const context = { schema: this.contract.schema, scope: validateTemporalScope(input.scope), beforeEpisodeId: input.beforeEpisodeId, intentRef: null };
    try {
      if (!sameUnit(context.scope, this.unit)) fail('SCOPE_MISMATCH');
      if (this.usage().captureActions >= this.limits.unitCaptureActions) fail('UNIT_ACTION_LIMIT');
      context.intentRef = this.append({ schema: 'avo.sdk-temporal-intent.v1', ...input }).id;
    } catch (error) { context.captureFailure = error.code || this.failure || 'ARCHIVE_UNWRITABLE'; }
    return context;
  }

  captureAction({ context, capture, frame, afterObservationId }) {
    const pointer = { schema: 'avo.sdk-temporal-ref.v1', contractSha256: this.contractSha256, manifestRef: null, manifestDigest: null,
      status: 'unavailable', sdkFrameCount: null, savedFrameCount: 0, savedRanges: [], omittedRanges: [], reasons: [] };
    try {
      if (!capture) fail('CAPTURE_NOT_RETURNED');
      if (frame.gameId !== this.unit.versionedGameId) fail('SCOPE_MISMATCH');
      if (capture.schema !== 'avo.sdk-temporal-capture.v1') fail('UNSUPPORTED_VERSION');
      if (canonicalJson(capture.scope) !== canonicalJson(context.scope) || capture.intentRef !== context.intentRef || capture.beforeEpisodeId !== context.beforeEpisodeId) fail('SCOPE_MISMATCH');
      const N = capture.sdkReturned?.frameCount;
      if (capture.sdkReturned.status !== 'known' || !Number.isSafeInteger(N) || N < 0 || capture.sdkReturned.finalFrameIndex !== (N ? N - 1 : null)) fail('CAPTURE_INVALID');
      pointer.sdkFrameCount = N;
      pointer.omittedRanges = N ? [[0, N]] : [];
      if (context.captureFailure) fail(context.captureFailure);
      if (!context.intentRef || !this.store.get(context.intentRef)) fail('ARCHIVE_MISSING');
      const { frames, final, reasons } = this.validateCapture(capture, frame.frame);
      const descriptors = [];
      const L = this.limits;
      let usage = this.usage();
      const finalFits = final && usage.frames < L.unitFrames && usage.sourceBytes + final.sourceBytes <= L.unitSourceBytes;
      const reserveFrames = finalFits ? 1 : 0;
      const reserveBytes = finalFits ? final.sourceBytes : 0;
      if (final && !finalFits) reasons.push('UNIT_FRAME_OR_SOURCE_LIMIT');
      for (const f of frames) {
        usage = this.usage();
        if (usage.frames + reserveFrames >= L.unitFrames || usage.sourceBytes + f.sourceBytes + reserveBytes > L.unitSourceBytes) { reasons.push('UNIT_FRAME_OR_SOURCE_LIMIT'); break; }
        const refs = [];
        const chunkCount = Math.ceil(f.source.length / L.chunkSourceBytes);
        try {
          for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
            const byteOffset = chunkIndex * L.chunkSourceBytes;
            const text = f.source.slice(byteOffset, byteOffset + L.chunkSourceBytes);
            // EvidenceStore bounds each string to 16k; preserve a 48 KiB chunk as pieces.
            const chunk = text.match(/.{1,16000}/g) || [];
            refs.push(this.append({ schema: 'avo.sdk-temporal-frame-chunk.v1', scope: context.scope, intentRef: context.intentRef,
              frameIndex: f.index, shape: f.shape, encoding: 'canonical-json-grid', sourceSha256: f.sourceSha256, gridContentHash: f.gridContentHash,
              chunkIndex, chunkCount, byteOffset, sourceBytes: f.sourceBytes, chunkSha256: sha256Hex(text), chunk }, true).id);
          }
          const { source, ...descriptor } = f;
          descriptors.push({ ...descriptor, chunkRefs: refs });
        } catch (error) { reasons.push(error.code || 'ARCHIVE_UNWRITABLE'); break; }
      }
      if (finalFits) descriptors.push({ ...final, source: 'parent-final-observation', chunkRefs: [] });
      const savedRanges = ranges(descriptors.map((f) => f.index));
      const omittedRanges = complement(savedRanges, N);
      const status = N && !omittedRanges.length ? 'complete' : descriptors.length ? 'partial' : 'unavailable';
      const sequence = descriptors.map(({ index, gridContentHash }) => ({ index, gridContentHash }));
      const sequenceHash = (schema) => sha256Hex(canonicalJson({ schema, scope: context.scope, frameCount: N, frames: sequence }));
      const manifest = this.append({ schema: 'avo.sdk-temporal-action.v1', scope: context.scope, intentRef: context.intentRef,
        beforeEpisodeId: context.beforeEpisodeId, afterObservationId, sdkReturned: capture.sdkReturned,
        status, reasons: [...new Set(reasons)], savedRanges, omittedRanges, frames: descriptors,
        sequenceSha256: status === 'complete' ? sequenceHash('avo.sdk-temporal-sequence.v1') : null,
        capturedSequenceSha256: sequenceHash('avo.sdk-temporal-retained-sequence.v1'),
        sourceBytes: descriptors.reduce((n, f) => n + f.sourceBytes, 0) });
      Object.assign(pointer, { manifestRef: manifest.id, manifestDigest: manifest.digest, status, savedFrameCount: descriptors.length, savedRanges, omittedRanges, reasons: manifest.reasons });
    } catch (error) { pointer.reasons = [error.code || this.failure || 'CAPTURE_INVALID']; }
    if (Buffer.byteLength(JSON.stringify(pointer)) > this.limits.actionPointerBytes) throw new Error('temporal pointer exceeds frozen bound');
    return pointer;
  }

  validateCapture(capture, finalGrid) {
    const N = capture.sdkReturned.frameCount;
    if (!Array.isArray(capture.frames) || capture.frames.length > this.limits.framesPerAction - 1 || !Array.isArray(capture.reasons) || capture.reasons.length > 8
        || capture.reasons.some((r) => typeof r !== 'string' || r.length > 64)) fail('CAPTURE_INVALID');
    let sourceBytes = 0;
    const verify = (entry, grid) => {
      const info = temporalGrid(grid, this.limits);
      if (info.sourceSha256 !== entry.sourceSha256 || info.gridContentHash !== entry.gridContentHash) fail('CAPTURE_HASH_MISMATCH');
      sourceBytes += info.sourceBytes;
      return info;
    };
    const frames = capture.frames.map((entry, index) => {
      if (entry.index !== index || index >= N - 1) fail('CAPTURE_INVALID');
      return { index, ...verify(entry, entry.grid) };
    });
    let final = null;
    if (capture.finalFrame) {
      if (capture.finalFrame.index !== N - 1 || capture.finalFrame.source !== 'response.frame') fail('CAPTURE_INVALID');
      const { source, ...info } = verify(capture.finalFrame, finalGrid);
      final = { index: N - 1, ...info };
    }
    const omitted = complement(ranges([...frames.map((f) => f.index), ...(final ? [final.index] : [])]), N);
    if (sourceBytes !== capture.sourceBytes || sourceBytes > this.limits.actionSourceBytes
        || canonicalJson(omitted) !== canonicalJson(capture.omittedRanges)
        || capture.status !== (N && !omitted.length ? 'complete' : frames.length || final ? 'partial' : 'unavailable')
        || Buffer.byteLength(JSON.stringify({ ...capture, frames: capture.frames.map(({ grid, ...entry }) => entry) })) > this.limits.captureEnvelopeBytes) fail('CAPTURE_INVALID');
    return { frames, final, reasons: capture.reasons.slice() };
  }

  verifyLive() {
    if (this.failure) fail(this.failure);
    try {
      const fresh = new EvidenceStore(this.store.root, this.store.gameId, { authorityRoot: this.store.authorityRoot }).load();
      if (!fresh.historyComplete || fresh.events.length !== this.store.events.length || fresh.events.some((r, i) => r.id !== this.store.events[i]?.id || r.digest !== this.store.events[i]?.digest)) fail('ARCHIVE_INTEGRITY_FAILED');
      this.verifyAllowance(this.usage());
    } catch (error) { this.failure = error.code || 'ARCHIVE_INTEGRITY_FAILED'; fail(this.failure); }
  }

  resolveAction(event) {
    if (!event?.temporalEvidence) fail('LEGACY_NOT_CAPTURED');
    this.verifyLive();
    const pointer = event.temporalEvidence;
    if (pointer.contractSha256 !== this.contractSha256 || pointer.schema !== 'avo.sdk-temporal-ref.v1') fail('UNSUPPORTED_VERSION');
    if (!pointer.manifestRef) fail(pointer.reasons[0] || 'ARCHIVE_MISSING');
    const manifest = this.store.get(pointer.manifestRef);
    if (!manifest) fail('ARCHIVE_MISSING');
    if (manifest.digest !== pointer.manifestDigest || manifest.schema !== 'avo.sdk-temporal-action.v1') fail('ARCHIVE_INTEGRITY_FAILED');
    const scope = validateTemporalScope(manifest.scope);
    if (!sameUnit(scope, this.unit) || scope.attemptId !== event.attemptId || scope.episodeId !== event.episodeId || scope.actionOrdinal !== event.actionIndex) fail('SCOPE_MISMATCH');
    const intent = this.store.get(manifest.intentRef);
    if (intent?.schema !== 'avo.sdk-temporal-intent.v1' || canonicalJson(intent.scope) !== canonicalJson(scope)
        || intent.action !== event.action || canonicalJson(intent.data) !== canonicalJson(event.data) || intent.beforeObservationId !== event.beforeObservationId
        || manifest.afterObservationId !== event.episodeObservationId) fail('ARCHIVE_INTEGRITY_FAILED');
    const N = manifest.sdkReturned.frameCount;
    if (pointer.sdkFrameCount !== N || pointer.status !== manifest.status || pointer.savedFrameCount !== manifest.frames.length
        || canonicalJson(pointer.savedRanges) !== canonicalJson(manifest.savedRanges) || canonicalJson(pointer.omittedRanges) !== canonicalJson(manifest.omittedRanges)
        || canonicalJson(complement(manifest.savedRanges, N)) !== canonicalJson(manifest.omittedRanges)
        || canonicalJson(ranges(manifest.frames.map((f) => f.index))) !== canonicalJson(manifest.savedRanges)) fail('ARCHIVE_INTEGRITY_FAILED');
    const sequence = manifest.frames.map(({ index, gridContentHash }) => ({ index, gridContentHash }));
    for (const [hash, schema] of [['capturedSequenceSha256', 'avo.sdk-temporal-retained-sequence.v1'], ['sequenceSha256', 'avo.sdk-temporal-sequence.v1']]) {
      if (hash === 'sequenceSha256' && manifest.status !== 'complete') { if (manifest[hash] !== null) fail('ARCHIVE_INTEGRITY_FAILED'); continue; }
      if (manifest[hash] !== sha256Hex(canonicalJson({ schema, scope, frameCount: N, frames: sequence }))) fail('ARCHIVE_INTEGRITY_FAILED');
    }
    return manifest;
  }

  grid(event, manifest, descriptor) {
    let grid;
    if (descriptor.source === 'parent-final-observation') {
      if (descriptor.index !== manifest.sdkReturned.finalFrameIndex) fail('ARCHIVE_INTEGRITY_FAILED');
      grid = event.observation.frame;
    } else {
      let source = '';
      for (const [index, ref] of descriptor.chunkRefs.entries()) {
        const r = this.store.get(ref);
        if (!r || r.schema !== 'avo.sdk-temporal-frame-chunk.v1') fail('ARCHIVE_MISSING');
        const text = r.chunk.join('');
        if (r.intentRef !== manifest.intentRef || canonicalJson(r.scope) !== canonicalJson(manifest.scope)
            || r.frameIndex !== descriptor.index || r.chunkIndex !== index || r.chunkCount !== descriptor.chunkRefs.length
            || r.byteOffset !== source.length || r.sourceSha256 !== descriptor.sourceSha256 || r.gridContentHash !== descriptor.gridContentHash
            || r.sourceBytes !== descriptor.sourceBytes || canonicalJson(r.shape) !== canonicalJson(descriptor.shape) || sha256Hex(text) !== r.chunkSha256) fail('ARCHIVE_INTEGRITY_FAILED');
        source += text;
      }
      if (sha256Hex(source) !== descriptor.sourceSha256) fail('ARCHIVE_INTEGRITY_FAILED');
      try { grid = JSON.parse(source); } catch { fail('ARCHIVE_INTEGRITY_FAILED'); }
      if (canonicalJson(grid) !== source) fail('ARCHIVE_INTEGRITY_FAILED');
    }
    const info = temporalGrid(grid, this.limits);
    if (info.sourceSha256 !== descriptor.sourceSha256 || info.gridContentHash !== descriptor.gridContentHash || info.sourceBytes !== descriptor.sourceBytes || canonicalJson(info.shape) !== canonicalJson(descriptor.shape)) fail('ARCHIVE_INTEGRITY_FAILED');
    return grid;
  }

  read(input, { parents, attemptId, B }) {
    const request = normalizeTemporalRead(input);
    this.verifyLive();
    const usage = this.usage();
    if (usage.readCalls >= this.limits.readCalls || usage.readChars >= this.limits.readChars) fail('READ_QUOTA_EXHAUSTED');
    B = Math.min(B, this.limits.readResultChars, this.limits.readChars - usage.readChars);
    const base = { schema: 'avo.sdk-temporal-read.v1', ok: true, historical: true, current: false, metadataAvailability: 'final-only', view: request.view };
    let result;
    if (request.view === 'actions') {
      const items = parents.filter((e) => ['environment-action', 'environment-reset'].includes(e.type) && e.sequence >= request.startSequence);
      result = packListPage({ items, limit: request.limit, B, envelopeFor: (selected, last, end) => ({ ...base, unit: this.unit, actions: selected.map((e) => {
        let availability = 'available';
        try { this.resolveAction(e); } catch (error) { availability = error.code || 'ARCHIVE_INTEGRITY_FAILED'; }
        return { ref: e.id, sequence: e.sequence, attemptId: e.attemptId, episodeId: e.episodeId, actionOrdinal: e.actionIndex,
          scope: { ...this.unit, attemptId: e.attemptId, episodeId: e.episodeId, actionOrdinal: e.actionIndex },
          capture: e.temporalEvidence ?? { status: 'unavailable', reasons: ['LEGACY_NOT_CAPTURED'] }, archiveAvailability: availability,
          indexRequest: { view: 'index', ref: e.id } };
      }), nextRequest: end ? null : { ...request, startSequence: last.sequence + 1 } }) });
    } else {
      const event = parents.find((e) => e.id === request.ref);
      if (!event) fail('READ_NOT_FOUND');
      const manifest = this.resolveAction(event);
      const fields = { ...base, scope: manifest.scope, evidenceRef: event.id, captureStatus: manifest.status, archiveAvailability: 'available' };
      if (request.view === 'index') {
        const items = manifest.frames.filter((f) => f.index >= request.startFrameIndex);
        result = packListPage({ items, limit: request.limit, B, envelopeFor: (selected, last, end) => ({ ...fields,
          sdkReturned: manifest.sdkReturned, savedRanges: manifest.savedRanges, omittedRanges: manifest.omittedRanges,
          frames: selected.map(({ index, shape, gridContentHash, sourceSha256 }) => ({ index, shape, gridContentHash, sourceSha256, frameRequest: { view: 'frame', ref: event.id, frameIndex: index } })),
          nextRequest: end ? null : { ...request, startFrameIndex: last.index + 1 } }) });
      } else {
        const descriptor = manifest.frames.find((f) => f.index === request.frameIndex);
        if (!descriptor) fail('FRAME_NOT_SAVED');
        let value = this.grid(event, manifest, descriptor);
        const region = request.view === 'region' ? { x: request.x, y: request.y, width: request.width, height: request.height } : {};
        if (request.view === 'region') {
          if (request.x + request.width > descriptor.shape[1] || request.y + request.height > descriptor.shape[0]) fail('INVALID_READ_REQUEST');
          value = value.slice(request.y, request.y + request.height).map((row) => row.slice(request.x, request.x + request.width));
        }
        result = readDetailEnvelope({ value, offset: request.offset, expectedSha256: request.expectedSha256, B,
          fields: { ...fields, frameIndex: descriptor.index, shape: descriptor.shape, gridContentHash: descriptor.gridContentHash, ...region },
          nextRequest: (offset, expectedSha256) => ({ ...request, offset, expectedSha256 }) });
      }
    }
    const text = JSON.stringify(result);
    // Write the reservation witness first: a lost charge suffix cannot replenish quotas.
    const allowance = { schema: 'avo.sdk-temporal-read-allowance.v1', unit: this.unit, contractSha256: this.contractSha256,
      readCalls: usage.readCalls + 1, readChars: usage.readChars + text.length, lastResultTextSha256: sha256Hex(text) };
    try {
      const bytes = Buffer.byteLength(`${JSON.stringify(allowance, null, 2)}\n`);
      if (usage.archiveBytes - this.allowanceBytes + bytes > this.limits.unitArchiveBytes) fail('ARCHIVE_QUOTA_EXHAUSTED');
      writeJsonAtomic(this.allowanceFile, allowance, { root: this.store.authorityRoot, maxBytes: 2048 });
      this.allowanceBytes = bytes;
    } catch (error) { this.failure = 'ARCHIVE_UNWRITABLE'; throw error; }
    this.append({ schema: 'avo.sdk-temporal-read-charge.v1', scope: { ...this.unit, attemptId }, readOrdinal: usage.readCalls + 1,
      sourceActionRef: request.ref ?? null, resultSourceScope: result.scope ?? null,
      selectorSha256: sha256Hex(`selector:trajectory_frames_read:${canonicalJson(request)}`), resultTextSha256: sha256Hex(text), resultChars: text.length,
      cumulativeCalls: usage.readCalls + 1, cumulativeChars: usage.readChars + text.length });
    return result;
  }

  summary(parents, attemptId = null) {
    const actions = parents.filter((e) => e.temporalEvidence && (!attemptId || e.attemptId === attemptId));
    let resources = null;
    try { this.verifyLive(); resources = this.usage(); } catch {}
    return { schema: 'avo.sdk-temporal-summary.v1', mode: this.contract.mode, admission: 'allow-partial', contractSha256: this.contractSha256,
      unit: this.unit, captureActions: actions.length,
      returnedFrames: actions.reduce((n, e) => n + (e.temporalEvidence.sdkFrameCount ?? 0), 0),
      returnedUnknownActions: actions.filter((e) => e.temporalEvidence.sdkFrameCount === null).length,
      savedFrames: actions.reduce((n, e) => n + e.temporalEvidence.savedFrameCount, 0),
      completeActions: actions.filter((e) => e.temporalEvidence.status === 'complete').length,
      coverageOmittedActions: Math.max(0, actions.length - 8),
      coverage: actions.slice(0, 8).map((e) => ({ ref: e.id, ...e.temporalEvidence })), resources,
      archiveAvailability: this.failure || 'available',
      deliveryAuthority: 'avo.tool-receipt.v1', requestAuthority: 'avo.context-receipt.v1' };
  }
}

export function temporalReadError(error, B) {
  const value = { schema: 'avo.sdk-temporal-read.v1', ok: false, code: error.code || 'ARCHIVE_UNREADABLE' };
  if (JSON.stringify(value).length > Math.min(B, 512)) throw error;
  return value;
}
function fail(code) { throw readRequestError(code); }
function sameUnit(scope, unit) { return ['runId', 'versionedGameId', 'gameId'].every((k) => scope?.[k] === unit[k]); }
function ranges(indexes) {
  const result = [];
  for (const i of indexes) {
    if (result.length && result.at(-1)[1] === i) result.at(-1)[1] = i + 1;
    else result.push([i, i + 1]);
  }
  return result;
}
function complement(saved, count) {
  const result = [];
  let next = 0;
  for (const [lo, hi] of saved) { if (lo > next) result.push([next, lo]); next = hi; }
  if (next < count) result.push([next, count]);
  return result;
}
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }

export function normalizeTemporalSummary(value) {
  if (!value || value.schema !== 'avo.sdk-temporal-summary.v1') throw new Error('temporal summary schema is invalid');
  exactKeys(value, ['schema', 'mode', 'admission', 'contractSha256', 'unit', 'captureActions', 'returnedFrames', 'returnedUnknownActions', 'savedFrames',
    'completeActions', 'coverageOmittedActions', 'coverage', 'resources', 'archiveAvailability', 'deliveryAuthority', 'requestAuthority']);
  const contract = resolveTemporalEvidenceContract(value.mode);
  if (!contract || value.admission !== 'allow-partial' || value.contractSha256 !== temporalContractSha256(contract)) throw new Error('temporal summary capability differs from frozen contract');
  validateTemporalScope({ ...value.unit, attemptId: 'attempt-000001', episodeId: 'episode-000001', actionOrdinal: 1 });
  for (const key of ['captureActions', 'returnedFrames', 'returnedUnknownActions', 'savedFrames', 'completeActions', 'coverageOmittedActions']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`temporal summary ${key} must be a non-negative integer`);
  }
  if (value.returnedUnknownActions > value.captureActions || value.completeActions > value.captureActions || value.savedFrames > value.returnedFrames
      || !Array.isArray(value.coverage) || value.coverage.length > 8 || value.coverage.length + value.coverageOmittedActions !== value.captureActions) throw new Error('temporal summary coverage is inconsistent');
  if (value.resources !== null) {
    exactKeys(value.resources, ['captureActions', 'frames', 'sourceBytes', 'archiveBytes', 'events', 'readCalls', 'readChars']);
    for (const key of ['captureActions', 'frames', 'sourceBytes', 'archiveBytes', 'events', 'readCalls', 'readChars']) {
      if (!Number.isSafeInteger(value.resources[key]) || value.resources[key] < 0) throw new Error('temporal resources must be non-negative integers');
    }
    for (const [key, limit] of [['frames', 'unitFrames'], ['sourceBytes', 'unitSourceBytes'], ['archiveBytes', 'unitArchiveBytes'], ['events', 'unitEvents'], ['readCalls', 'readCalls'], ['readChars', 'readChars']]) {
      if (value.resources[key] > contract.limits[limit]) throw new Error('temporal resources exceed frozen contract');
    }
  }
  const seen = new Set();
  for (const entry of value.coverage) {
    exactKeys(entry, ['ref', 'schema', 'contractSha256', 'manifestRef', 'manifestDigest', 'status', 'sdkFrameCount', 'savedFrameCount', 'savedRanges', 'omittedRanges', 'reasons']);
    for (const list of [entry.savedRanges, entry.omittedRanges]) {
      if (!Array.isArray(list) || list.length > 32 || list.some((range, index) => !Array.isArray(range) || range.length !== 2
          || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] < 0 || range[1] <= range[0]
          || range[1] > entry.sdkFrameCount || (index && range[0] < list[index - 1][1]))) throw new Error('temporal coverage ranges are invalid');
    }
    if (!REF.test(entry.ref) || seen.has(entry.ref) || entry.schema !== 'avo.sdk-temporal-ref.v1' || entry.contractSha256 !== value.contractSha256
        || !['complete', 'partial', 'unavailable'].includes(entry.status) || !Number.isSafeInteger(entry.savedFrameCount) || entry.savedFrameCount < 0
        || (entry.manifestRef !== null && (!REF.test(entry.manifestRef) || !HASH.test(entry.manifestDigest)))
        || (entry.manifestRef === null && entry.manifestDigest !== null)
        || !Array.isArray(entry.reasons) || entry.reasons.some((reason) => typeof reason !== 'string' || reason.length > 64)
        || (entry.sdkFrameCount !== null && (!Number.isSafeInteger(entry.sdkFrameCount) || entry.sdkFrameCount < entry.savedFrameCount))
        || entry.savedRanges.reduce((n, r) => n + r[1] - r[0], 0) !== entry.savedFrameCount) throw new Error('temporal coverage entry is invalid');
    seen.add(entry.ref);
  }
  if (value.deliveryAuthority !== 'avo.tool-receipt.v1' || value.requestAuthority !== 'avo.context-receipt.v1'
      || typeof value.archiveAvailability !== 'string' || value.archiveAvailability.length > 64) throw new Error('temporal summary authority is invalid');
  return freeze(structuredClone(value));
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || canonicalJson(Object.keys(value).sort()) !== canonicalJson(keys.slice().sort())) throw new Error('temporal summary fields are invalid');
}

export function aggregateTemporalSummaries(values) {
  const summaries = values.filter((v) => v !== undefined).map(normalizeTemporalSummary);
  if (!summaries.length) return undefined;
  if (summaries.length !== values.length) throw new Error('temporal attempt summaries are missing');
  const first = summaries[0];
  for (const summary of summaries) if (summary.contractSha256 !== first.contractSha256 || canonicalJson(summary.unit) !== canonicalJson(first.unit)) throw new Error('temporal attempt scope/capability differs');
  const counts = Object.fromEntries(['captureActions', 'returnedFrames', 'returnedUnknownActions', 'savedFrames', 'completeActions'].map((key) => [key, summaries.reduce((n, s) => n + s[key], 0)]));
  const resources = summaries.every((s) => s.resources !== null)
    ? Object.fromEntries(Object.keys(first.resources).map((key) => [key, Math.max(...summaries.map((s) => s.resources[key]))])) : null;
  const coverage = summaries.flatMap((s) => s.coverage).slice(0, 8);
  return normalizeTemporalSummary({ ...first, ...counts, resources, coverage, coverageOmittedActions: counts.captureActions - coverage.length,
    archiveAvailability: summaries.find((s) => s.archiveAvailability !== 'available')?.archiveAvailability ?? 'available' });
}
