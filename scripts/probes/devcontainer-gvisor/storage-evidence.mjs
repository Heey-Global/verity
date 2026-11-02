import assert from 'node:assert/strict';

// buildctl du templates encode client.UsageInfo JSON tags, not Go field names:
// https://github.com/moby/buildkit/blob/v0.34.1/client/diskusage.go
export function parseCacheUsage(text) {
  const records = JSON.parse(text) ?? [];
  assert(Array.isArray(records), 'Expected a BuildKit usage array');
  for (const record of records) {
    assert(record && typeof record.id === 'string' && record.id.length > 0);
    assert(Number.isSafeInteger(record.size), 'Missing/invalid BuildKit size field');
    assert.equal(typeof record.inUse, 'boolean');
    assert.equal(typeof record.description, 'string');
  }
  return records;
}

export function cacheBytes(records) {
  return records.reduce((sum, record) => sum + Math.max(0, record.size), 0);
}
