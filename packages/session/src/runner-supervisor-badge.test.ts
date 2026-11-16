import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Backend } from './backend.js';
import { InMemoryEventBus } from './bus.js';
import { SupervisorRunnerClient } from './runner-supervisor-client.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

// A start attempt retires the badge it minted when its turn settles. A launch
// without an attempt's box has nobody to retire it, so a badge minted there
// would keep naming its person to sandbox routes for up to a day.
it('mints no badge for a launch that has no start attempt to retire it', async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'verity-badge-'));
  let request: Record<string, unknown> | undefined;
  const server: Server = createServer((peer) => {
    peer.once('data', (data) => {
      request = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      peer.end(`${JSON.stringify({ ok: true, outcome: 'ambiguous' })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(join(runtime, 'supervisor.sock'), resolve));
  cleanup.push(
    () => rm(runtime, { recursive: true, force: true }),
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const issued: string[] = [];
  const client = new SupervisorRunnerClient({ runnerSupervisorBackend: 'codex-acp' } as Backend, {
    securityPreflight: false,
    runtimeDir: runtime,
    store: { ingestRunnerFrame: async () => ({ outcome: 'accepted' }) },
    bus: new InMemoryEventBus(),
    turnCapabilities: {
      issue: (turnId) => {
        issued.push(turnId);
        return 'badge-1';
      },
      release: () => undefined,
    },
  });
  const launch = (client as unknown as { launch(opts: unknown): Promise<void> }).launch.bind(
    client,
  );
  await expect(
    launch({
      store: {} as never,
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'hello',
      storeSessionId: 'session-1',
      turnId: 'turn-1',
      startCommandId: 'start-1',
    }),
  ).rejects.toThrow('invalid start outcome');
  expect(request?.kind).toBe('start-turn');
  expect(issued).toEqual([]);
  expect(request).not.toHaveProperty('turnCapability');
});
