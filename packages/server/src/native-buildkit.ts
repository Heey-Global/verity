import { hostname } from 'node:os';
import { lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const challenge = z.object({ version: z.literal(1), nonce: z.uuid(), observedAt: z.iso.datetime() }).strict();

/** A challenge is answered only from a complete, non-mutating reservation inventory.
 * The host holds admission exclusively while challenging every socket consumer. */
export function startNativeRetirementEvidence(
  inventory: () => boolean,
  directory = '/run/verity-buildkit',
  identity = hostname(),
): { stop(): void; tick(): Promise<void> } {
  let running = false;
  const tick = async () => {
    if (running || !/^[a-zA-Z0-9-]{1,64}$/.test(identity)) return;
    running = true;
    try {
      const path = join(directory, 'native-challenge.json');
      if ((await lstat(path)).isSymbolicLink()) return;
      const value = challenge.parse(JSON.parse(await readFile(path, 'utf8')));
      const age = Date.now() - Date.parse(value.observedAt);
      if (age < 0 || age > 30_000) return;
      const evidence = join(directory, 'reclamation-evidence');
      if ((await realpath(evidence)) !== evidence) return;
      const target = join(evidence, `${identity}.json`);
      const temp = `${target}.${process.pid}.tmp`;
      // Never reconcile, remove or release an uncertain reservation to answer a challenge.
      await writeFile(temp, JSON.stringify({ ...value, identity, empty: inventory() }), { flag: 'wx', mode: 0o600 });
      await rename(temp, target);
    } catch {
      // Missing host protocol, incomplete inventory and malformed challenges fail closed.
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 1000);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
