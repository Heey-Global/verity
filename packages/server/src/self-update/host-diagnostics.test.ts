import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readHostDiagnosticsCapability } from './host-diagnostics.js';

describe('host diagnostics capability', () => {
  it('distinguishes unsupported, malformed, oversized, stale and future receipts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'diagnostic-capability-'));
    const now = Date.now();
    const snapshot = {
      schemaVersion: 1,
      observedAt: new Date(now).toISOString(),
      since: new Date(now - 86_400_000).toISOString(),
      until: new Date(now).toISOString(),
      sources: { kernel: 'unavailable', runtime: 'failed' },
      truncated: false,
    };
    try {
      expect(await readHostDiagnosticsCapability(directory, now)).toEqual({ state: 'unsupported' });
      for (const raw of ['{', 'x'.repeat(16_385), JSON.stringify({ version: 2 })]) {
        await writeFile(join(directory, 'diagnostics.json'), raw);
        expect(await readHostDiagnosticsCapability(directory, now)).toEqual({ state: 'invalid' });
      }
      for (const hostPath of ['/', '/path/../other', '/path:rw', '/path\n']) {
        await writeFile(
          join(directory, 'diagnostics.json'),
          JSON.stringify({ version: 1, hostPath, snapshot }),
        );
        expect(await readHostDiagnosticsCapability(directory, now)).toEqual({ state: 'invalid' });
      }
      for (const offset of [-300_001, 60_001]) {
        await writeFile(
          join(directory, 'diagnostics.json'),
          JSON.stringify({
            version: 1,
            hostPath: '/var/lib/verity/host-diagnostics',
            snapshot: { ...snapshot, observedAt: new Date(now + offset).toISOString() },
          }),
        );
        expect(await readHostDiagnosticsCapability(directory, now)).toEqual({ state: 'stale' });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
