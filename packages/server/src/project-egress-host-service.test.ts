import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import {
  serveProjectEgressHost,
  verifyProjectEgressDockerHost,
  verifyProjectEgressServiceManager,
} from './project-egress-host-service.js';

function fixture() {
  const events: string[] = [];
  const server = createServer();
  const deps = {
    restore: vi.fn(async () => {
      events.push('deny');
    }),
    deny: vi.fn(async () => {
      events.push('stop-deny');
    }),
    verifyHost: vi.fn(async () => {
      events.push('host');
    }),
    revalidate: vi.fn(async () => {
      events.push('bindings');
    }),
    listen: vi.fn(async () => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      events.push('socket');
      return server;
    }),
    notifyReady: vi.fn(async () => {
      events.push('ready');
    }),
  };
  return { events, deps, server };
}

it('does not report ready while restored bindings are still being validated', async () => {
  const f = fixture();
  let release!: () => void;
  f.deps.revalidate.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const starting = serveProjectEgressHost(f.deps);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(f.deps.listen).not.toHaveBeenCalled();
  expect(f.deps.notifyReady).not.toHaveBeenCalled();
  release();
  const service = await starting;
  expect(f.events).toEqual(['deny', 'host', 'socket', 'ready']);
  const a = service.stop();
  expect(service.stop()).toBe(a);
  await a;
  expect(f.server.listening).toBe(false);
  expect(f.deps.restore).toHaveBeenCalledTimes(1);
  expect(f.deps.deny).toHaveBeenCalledTimes(1);
});

it.each(['restore', 'verifyHost', 'revalidate'] as const)(
  'withholds the socket and readiness if %s fails',
  async (stage) => {
    const f = fixture();
    f.deps[stage].mockRejectedValueOnce(new Error('refused'));
    await expect(serveProjectEgressHost(f.deps)).rejects.toThrow('refused');
    expect(f.deps.listen).not.toHaveBeenCalled();
    expect(f.deps.notifyReady).not.toHaveBeenCalled();
  },
);

it('closes control and restores denial when systemd does not accept readiness', async () => {
  const f = fixture();
  f.deps.notifyReady.mockRejectedValueOnce(new Error('notification failed'));
  await expect(serveProjectEgressHost(f.deps)).rejects.toThrow('notification failed');
  expect(f.server.listening).toBe(false);
  expect(f.events).toEqual(['deny', 'host', 'bindings', 'socket', 'stop-deny']);
});

describe('supported host contract', () => {
  it.each([
    ['systemd 248', 'systemd'],
    ['systemd 249', 'bash'],
    ['', 'systemd'],
  ])('rejects unavailable lifecycle semantics: %s / %s', (version, init) => {
    expect(() => verifyProjectEgressServiceManager(version, init)).toThrow();
  });
  it('accepts the minimum service manager and rejects incomplete daemon facts', () => {
    verifyProjectEgressServiceManager('systemd 249 (249.1)\n+PAM', 'systemd\n');
    const host = {
      OSType: 'linux',
      ServerVersion: '29.9.2',
      LiveRestoreEnabled: false,
      SecurityOptions: ['name=seccomp'],
    };
    verifyProjectEgressDockerHost(host);
    for (const bad of [
      { ...host, OSType: 'windows' },
      { ...host, ServerVersion: 'unverified' },
      { ...host, LiveRestoreEnabled: true },
      { ...host, SecurityOptions: ['name=rootless'] },
      { ...host, SecurityOptions: undefined },
    ])
      expect(() => verifyProjectEgressDockerHost(bad)).toThrow();
  });
});
