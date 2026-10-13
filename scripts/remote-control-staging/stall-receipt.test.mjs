import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStallReceipt } from './stall-receipt.mjs';

const stallFixture = () => ({
  worker: 1,
  ownRequests: 0,
  totalRequests: 0,
  kind: 'transport',
  code: -1001,
  phase: 'PIN_AND_CHAIN_TRUST_ACCEPTED',
  diagnostic: {
    headersMs: 5,
    firstByteMs: 6,
    completedMs: 12000,
    writer: {
      mapping: 'matched',
      queued: 1,
      sending: 0,
      completed: 2,
      failed: 0,
      globalQueued: 1,
      globalSending: 1,
      oldestSendMs: 11000,
      overflow: false,
    },
  },
});
const parse = (value) => parseStallReceipt(`probe-stall-failure:${JSON.stringify(value)}`);
test('accepts bounded response milestones and distinct writer queue/send state', () => {
  const value = stallFixture();
  assert.deepEqual(parse(value), value);
});
test('missing or ambiguous mapping never masquerades as zero pending sends', () => {
  for (const mapping of ['unknown', 'ambiguous', 'overflow']) {
    const value = stallFixture();
    Object.assign(value.diagnostic.writer, {
      mapping,
      overflow: mapping === 'overflow',
      queued: -1,
      sending: -1,
      completed: -1,
      failed: -1,
    });
    assert.deepEqual(parse(value), value);
    value.diagnostic.writer.queued = 0;
    assert.equal(parse(value), null);
  }
});
test('rejects secret fields, malformed data, invalid ranges and contradictory timing', () => {
  for (const mutate of [
    (v) => {
      v.ticket = 'secret';
    },
    (v) => {
      v.diagnostic.url = 'https://private.invalid';
    },
    (v) => {
      v.diagnostic.writer.payload = 'secret';
    },
    (v) => {
      v.worker = 8;
    },
    (v) => {
      v.code = true;
    },
    (v) => {
      v.diagnostic.headersMs = -1;
    },
    (v) => {
      v.diagnostic.firstByteMs = 4;
    },
    (v) => {
      v.diagnostic.completedMs = 86400001;
    },
    (v) => {
      v.diagnostic.writer.globalQueued = 129;
    },
    (v) => {
      v.diagnostic.writer.overflow = true;
    },
    (v) => {
      v.diagnostic.writer.queued = 2;
    },
  ]) {
    const value = stallFixture();
    mutate(value);
    assert.equal(parse(value), null);
  }
  for (const line of ['probe-stall-failure:{', 'probe-stall-failure:null', 'x'.repeat(5000)])
    assert.equal(parseStallReceipt(line), null);
});
