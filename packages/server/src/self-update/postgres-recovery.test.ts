import { describe, expect, it, vi } from 'vitest';
import {
  POSTGRES_RECOVERY_GRACE_MS,
  POSTGRES_RECOVERY_MIN_FREE_BYTES,
  recoverStoppedControlPlanePostgres,
} from './postgres-recovery.js';

const NOW = Date.parse('2026-11-27T15:00:00Z');
const longAgo = new Date(NOW - 2 * POSTGRES_RECOVERY_GRACE_MS).toISOString();

interface Fake {
  id: string;
  name: string;
  running?: boolean;
  status?: string;
  exitCode?: number;
  finishedAt?: string;
  network?: string;
  service?: string;
}

function harness(containers: Fake[], freeBytes = 10 * POSTGRES_RECOVERY_MIN_FREE_BYTES) {
  const startContainer = vi.fn(async () => {});
  const docker = {
    listContainers: async () =>
      containers.map((c) => ({
        id: c.id,
        names: [`/${c.name}`],
        labels: { 'com.docker.compose.service': c.service ?? 'postgres' },
      })),
    inspectContainer: async (id: string) => {
      const c = containers.find((item) => item.id === id)!;
      return {
        id,
        running: c.running ?? false,
        status: c.running ? 'running' : (c.status ?? 'exited'),
        exitCode: c.exitCode,
        finishedAt: c.finishedAt ?? longAgo,
        networks: { [c.network ?? 'verity-net']: {} },
      };
    },
    startContainer,
  };
  const run = () =>
    recoverStoppedControlPlanePostgres({
      docker: docker as never,
      network: 'verity-net',
      freeBytes: async () => freeBytes,
      now: () => NOW,
    });
  return { run, startContainer };
}

// Observed: PostgreSQL stopped with "No space left on device", Docker's single
// restart failed, and the Server could not resolve the database for hours until
// it was started by hand, although space had been freed long before.
describe('control-plane PostgreSQL recovery', () => {
  it('starts a crashed database that stayed down once space is available', async () => {
    const h = harness([{ id: 'db', name: 'verity-postgres-1', exitCode: 1 }]);
    expect(await h.run()).toBe('started');
    expect(h.startContainer).toHaveBeenCalledWith('db');
  });

  // Each case below is one that must never start anything.
  it.each([
    ['a running database', [{ id: 'db', name: 'verity-postgres-1', running: true }], 'running'],
    [
      'a deliberate stop (exit 0)',
      [{ id: 'db', name: 'verity-postgres-1', exitCode: 0 }],
      'stopped-deliberately',
    ],
    [
      'a predecessor kept for rollback',
      [{ id: 'old', name: 'verity-postgres-1-predecessor-0123456789ab', exitCode: 1 }],
      'absent',
    ],
    [
      'a predecessor beside a running successor',
      [
        { id: 'old', name: 'verity-postgres-1-predecessor-0123456789ab', exitCode: 1 },
        { id: 'new', name: 'verity-postgres-1', running: true },
      ],
      'running',
    ],
    [
      'a crash within the grace period',
      [
        {
          id: 'db',
          name: 'verity-postgres-1',
          exitCode: 1,
          finishedAt: new Date(NOW - 1000).toISOString(),
        },
      ],
      'within-grace',
    ],
    [
      'another deployment on another network',
      [{ id: 'db', name: 'other-postgres-1', exitCode: 1, network: 'other-net' }],
      'absent',
    ],
    [
      'two stopped candidates',
      [
        { id: 'a', name: 'verity-postgres-1', exitCode: 1 },
        { id: 'b', name: 'verity-postgres-2', exitCode: 1 },
      ],
      'ambiguous',
    ],
    [
      'a container that is only created',
      [{ id: 'db', name: 'verity-postgres-1', status: 'created', exitCode: 1 }],
      'ambiguous',
    ],
  ] as const)('leaves %s alone', async (_case, containers, outcome) => {
    const h = harness([...containers]);
    expect(await h.run()).toBe(outcome);
    expect(h.startContainer).not.toHaveBeenCalled();
  });

  it('does not start a crashed database on a disk that is still full', async () => {
    const h = harness(
      [{ id: 'db', name: 'verity-postgres-1', exitCode: 1 }],
      POSTGRES_RECOVERY_MIN_FREE_BYTES - 1,
    );
    expect(await h.run()).toBe('insufficient-space');
    expect(h.startContainer).not.toHaveBeenCalled();
  });
});
