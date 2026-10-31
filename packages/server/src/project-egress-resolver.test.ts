import { expect, it, vi } from 'vitest';
import { createProjectEgressResolver } from './project-egress-resolver.js';

function fixture() {
  let now = 1000;
  const resolver = {
    resolve4: vi.fn(async () => [{ address: '8.8.8.8', ttl: 30 }]),
    resolve6: vi.fn(async () => [{ address: '2606:4700:4700::1111', ttl: 20 }]),
    cancel: vi.fn(),
  };
  const destinationAllowed = vi.fn<(address: string) => Promise<boolean>>(async () => true);
  const resolve = createProjectEgressResolver({
    servers: ['1.1.1.1'],
    destinationAllowed,
    now: () => now,
    createResolver: () => resolver,
  });
  return {
    resolver,
    destinationAllowed,
    resolve,
    setNow: (value: number) => {
      now = value;
    },
  };
}
it('bounds both address families to the earliest original DNS expiry', async () => {
  const { resolve, resolver } = fixture();
  expect(await resolve('downloads.example.com')).toEqual({
    addresses: ['8.8.8.8', '2606:4700:4700::1111'],
    expiresAt: 21000,
  });
  expect(resolver.cancel).toHaveBeenCalledOnce();
});
it('rejects the entire mixed answer and host-owned exclusions', async () => {
  const f = fixture();
  f.resolver.resolve4.mockResolvedValue([
    { address: '8.8.8.8', ttl: 30 },
    { address: '127.0.0.1', ttl: 30 },
  ]);
  await expect(f.resolve('downloads.example.com')).rejects.toThrow('Forbidden');
  f.resolver.resolve4.mockResolvedValue([{ address: '8.8.8.8', ttl: 30 }]);
  f.destinationAllowed.mockResolvedValue(false);
  await expect(f.resolve('downloads.example.com')).rejects.toThrow('Forbidden');
});
it('accepts absent family data but fails closed on resolver failures', async () => {
  const f = fixture();
  f.resolver.resolve6.mockRejectedValue(Object.assign(new Error(), { code: 'ENODATA' }));
  expect((await f.resolve('downloads.example.com')).addresses).toEqual(['8.8.8.8']);
  f.resolver.resolve6.mockRejectedValue(Object.assign(new Error(), { code: 'ETIMEOUT' }));
  await expect(f.resolve('downloads.example.com')).rejects.toThrow();
  expect(f.resolver.cancel).toHaveBeenCalledTimes(2);
});
it('never queries noncanonical inputs or literal addresses', async () => {
  const f = fixture();
  for (const host of ['8.8.8.8', 'Downloads.example.com', 'example.com.', 'https://example.com'])
    await expect(f.resolve(host)).rejects.toThrow();
  expect(f.resolver.resolve4).not.toHaveBeenCalled();
});
it('does not rebase TTL after asynchronous work', async () => {
  const f = fixture();
  f.destinationAllowed.mockImplementation(async () => {
    f.setNow(31000);
    return true;
  });
  await expect(f.resolve('downloads.example.com')).rejects.toThrow('expired');
});

it('rejects missing, oversized, wrong-family and zero-TTL answers', async () => {
  for (const records of [
    [],
    Array.from({ length: 33 }, () => ({ address: '8.8.8.8', ttl: 30 })),
    [{ address: '::ffff:8.8.8.8', ttl: 30 }],
    [{ address: '8.8.8.8', ttl: 0 }],
    [{ address: '8.8.8.8', ttl: NaN }],
  ]) {
    const f = fixture();
    f.resolver.resolve4.mockResolvedValue(records);
    f.resolver.resolve6.mockResolvedValue([]);
    await expect(f.resolve('downloads.example.com')).rejects.toThrow();
    expect(f.resolver.cancel).toHaveBeenCalledOnce();
  }
});

it('cancels a stalled resolution within its total DNS budget', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.resolver.resolve4.mockImplementation(() => new Promise(() => undefined));
    const pending = expect(f.resolve('downloads.example.com')).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(f.resolver.cancel).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
