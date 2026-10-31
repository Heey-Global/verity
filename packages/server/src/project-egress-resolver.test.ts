import { expect, it, vi } from 'vitest';
import { Resolver } from 'node:dns/promises';
import { createSocket } from 'node:dgram';
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

it('reads TTL and both families through the actual Node DNS resolver', async () => {
  const socket = createSocket('udp4');
  socket.on('message', (question, peer) => {
    const family = question.readUInt16BE(question.length - 4);
    const data =
      family === 1
        ? Buffer.from([8, 8, 8, 8])
        : Buffer.from('26064700470000000000000000001111', 'hex');
    const header = Buffer.from(question.subarray(0, 12));
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 6);
    const record = Buffer.alloc(12);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(family, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(family === 1 ? 30 : 20, 6);
    record.writeUInt16BE(data.length, 10);
    socket.send(
      Buffer.concat([header, question.subarray(12), record, data]),
      peer.port,
      peer.address,
    );
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  try {
    const address = socket.address();
    const resolve = createProjectEgressResolver({
      servers: ['127.0.0.1'],
      now: () => 1000,
      destinationAllowed: async () => true,
      createResolver: () => {
        const resolver = new Resolver({ timeout: 500, tries: 1 });
        resolver.setServers([`127.0.0.1:${address.port}`]);
        return resolver;
      },
    });
    expect(await resolve('downloads.example.com')).toEqual({
      addresses: ['8.8.8.8', '2606:4700:4700::1111'],
      expiresAt: 21000,
    });
  } finally {
    await new Promise<void>((resolve) => socket.close(resolve));
  }
});
