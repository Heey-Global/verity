import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheBytes, parseCacheUsage } from './storage-evidence.mjs';

test('uses buildctl UsageInfo JSON tags and rejects incompatible output', () => {
  const records = parseCacheUsage(
    '[{"id":"snapshot","size":2048,"inUse":true,"description":"RUN sleep 120"}]',
  );
  assert.equal(cacheBytes(records), 2048);
  assert.equal(records[0].inUse, true);
  assert.match(records[0].description, /sleep 120/);
  assert.deepEqual(parseCacheUsage('null'), []);
  assert.throws(() => parseCacheUsage('[{"id":"snapshot","Size":2048}]'));
  assert.throws(() => parseCacheUsage('{"size":2048}'));
  assert.throws(() => parseCacheUsage('[{"id":"snapshot","size":null}]'));
});
