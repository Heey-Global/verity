import { expect, it, vi } from 'vitest';
import { createEmbeddedPreviewMutations } from './embedded-preview-mutations.js';

function manager(events: string[], name: string) {
  return {
    beginSessionMove: vi.fn(async (projectId: string) => {
      events.push(`${name}:begin:${projectId}`);
      return () => events.push(`${name}:release`);
    }),
    retireProjectShares: vi.fn(async (projectId: string) => {
      events.push(`${name}:retire:${projectId}`);
    }),
    withProjectStorageMutation: async <T>(
      projectId: string,
      mutation: () => Promise<T>,
      options?: { waitForIdle?: boolean },
    ): Promise<T> => {
      events.push(`${name}:storage:${projectId}:${String(options?.waitForIdle)}`);
      return mutation();
    },
  };
}

it('defers manager lookup until invocation and sees managers installed after bootstrap', async () => {
  const events: string[] = [];
  const managers: {
    local?: ReturnType<typeof manager>;
    public?: ReturnType<typeof manager>;
  } = {};
  const getLocal = vi.fn(() => managers.local);
  const getPublic = vi.fn(() => managers.public);
  const runtime = createEmbeddedPreviewMutations({ local: getLocal, public: getPublic });
  expect(getLocal).not.toHaveBeenCalled();
  expect(getPublic).not.toHaveBeenCalled();
  await expect(runtime.withPreviewProjectMutation('p', async () => 'before')).resolves.toBe(
    'before',
  );
  managers.local = manager(events, 'local');
  managers.public = manager(events, 'public');
  await expect(
    runtime.withPreviewProjectMutation(
      'p',
      async () => {
        events.push('mutation');
        return 'after';
      },
      async () => {
        events.push('capture');
      },
    ),
  ).resolves.toBe('after');
  expect(events).toEqual([
    'local:begin:p',
    'public:begin:p',
    'capture',
    'local:retire:p',
    'public:retire:p',
    'mutation',
    'public:release',
    'local:release',
  ]);
});

it('preserves both fences until a failed mutation unwinds', async () => {
  const events: string[] = [];
  const local = manager(events, 'local');
  const publicManager = manager(events, 'public');
  const runtime = createEmbeddedPreviewMutations({
    local: () => local,
    public: () => publicManager,
  });
  const failure = new Error('mutation refused');
  await expect(
    runtime.withPreviewProjectMutation('p', async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(events).toEqual([
    'local:begin:p',
    'public:begin:p',
    'local:retire:p',
    'public:retire:p',
    'public:release',
    'local:release',
  ]);
});

it.each([undefined, false, true])(
  'passes the storage wait policy through both managers (%s)',
  async (waitForIdle) => {
    const events: string[] = [];
    const managers: {
      local?: ReturnType<typeof manager>;
      public?: ReturnType<typeof manager>;
    } = {};
    const runtime = createEmbeddedPreviewMutations({
      local: () => managers.local,
      public: () => managers.public,
    });
    await expect(runtime.withStorageProjectMutation('p', async () => 'before')).resolves.toBe(
      'before',
    );
    managers.local = manager(events, 'local');
    managers.public = manager(events, 'public');
    const options = waitForIdle === undefined ? undefined : { waitForIdle };
    await expect(
      runtime.withStorageProjectMutation(
        'p',
        async () => {
          events.push('mutation');
          return 'stored';
        },
        options,
      ),
    ).resolves.toBe('stored');
    expect(events).toEqual([
      `local:storage:p:${String(waitForIdle ?? true)}`,
      `public:storage:p:${String(waitForIdle ?? true)}`,
      'mutation',
    ]);
  },
);
