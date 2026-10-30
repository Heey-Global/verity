import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { startNativeRetirementEvidence } from './native-buildkit.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
it('binds an independent inventory to the fresh host challenge and preserves uncertainty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-evidence-')); roots.push(root);
  mkdirSync(join(root, 'reclamation-evidence'));
  const nonce = randomUUID();
  const challenge = (age = 0) => writeFileSync(join(root, 'native-challenge.json'), JSON.stringify({ version: 1, nonce, observedAt: new Date(Date.now() - age).toISOString() }));
  // A prior container incarnation may have crashed while running as PID 1.
  writeFileSync(join(root, 'reclamation-evidence', `server.json.${process.pid}.tmp`), 'old partial receipt');
  let empty = false;
  const service = startNativeRetirementEvidence(() => empty, root, 'server');
  try {
    challenge(31_000); await service.tick();
    const result = join(root, 'reclamation-evidence', 'server.json');
    expect(existsSync(result)).toBe(false);
    challenge(); await service.tick();
    expect(JSON.parse(readFileSync(result, 'utf8'))).toMatchObject({ nonce, empty: false, identity: 'server' });
    empty = true; await service.tick();
    expect(JSON.parse(readFileSync(result, 'utf8')).empty).toBe(true);
  } finally { service.stop(); }
});
it('does not produce evidence when the reservation inventory fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-evidence-')); roots.push(root);
  mkdirSync(join(root, 'reclamation-evidence'));
  writeFileSync(join(root, 'native-challenge.json'), JSON.stringify({ version: 1, nonce: randomUUID(), observedAt: new Date().toISOString() }));
  const service = startNativeRetirementEvidence(() => { throw new Error('unreadable'); }, root, 'server');
  try { await service.tick(); expect(existsSync(join(root, 'reclamation-evidence', 'server.json'))).toBe(false); expect(readdirSync(join(root, 'reclamation-evidence'))).toEqual([]); }
  finally { service.stop(); }
});
