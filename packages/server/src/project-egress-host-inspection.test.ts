import { expect, it, vi } from 'vitest';
import { withEgressHostInspection } from './project-egress-host-inspection.js';
const ids = { sandbox: 'a'.repeat(64), relay: 'b'.repeat(64) };
it('batches exact container identities and shares reads only within one fresh phase', async () => {
  let endpoint = 'old';
  const docker = vi.fn(async (...args: string[]) =>
    args[0] === 'container'
      ? JSON.stringify([
          { Id: ids.relay, endpoint },
          { Id: ids.sandbox, endpoint },
        ])
      : JSON.stringify({ endpoint }),
  );
  const inspect = async (read: (...args: string[]) => Promise<string>) => {
    const sandbox = JSON.parse(await read('inspect', ids.sandbox));
    const relay = JSON.parse(await read('container', 'inspect', ids.relay));
    expect(sandbox[0].Id).toBe(ids.sandbox);
    expect(relay[0].Id).toBe(ids.relay);
    await read('network', 'inspect', 'n');
    await read('network', 'inspect', 'n');
    await expect(read('container', 'inspect', 'c'.repeat(64))).rejects.toThrow('outside');
    await expect(read('container', 'start', ids.sandbox)).rejects.toThrow('Unsupported');
    return String(sandbox[0].endpoint);
  };
  expect(await withEgressHostInspection(ids, inspect, docker)).toBe('old');
  endpoint = 'replacement';
  expect(await withEgressHostInspection(ids, inspect, docker)).toBe('replacement');
  expect(docker.mock.calls).toEqual([
    ['container', 'inspect', ids.sandbox, ids.relay],
    ['network', 'inspect', 'n'],
    ['container', 'inspect', ids.sandbox, ids.relay],
    ['network', 'inspect', 'n'],
  ]);
});
it.each([
  { reply: [{ Id: ids.sandbox }, { Id: ids.sandbox }] },
  { reply: [{ Id: ids.sandbox }, { Id: 'c'.repeat(64) }] },
  { reply: [{ Id: ids.sandbox }] },
])(
  'rejects partial, duplicate or substituted daemon identities before validation',
  async ({ reply }) => {
    const inspect = vi.fn(async () => undefined);
    await expect(
      withEgressHostInspection(ids, inspect, async () => JSON.stringify(reply)),
    ).rejects.toThrow();
    expect(inspect).not.toHaveBeenCalled();
  },
);
