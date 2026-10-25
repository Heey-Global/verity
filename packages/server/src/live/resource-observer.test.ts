import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceObserver } from './resource-observer.js';

describe('ResourceObserver', () => {
  let observer: ResourceObserver;
  beforeEach(() => {
    vi.useFakeTimers();
    observer = new ResourceObserver();
  });
  afterEach(() => {
    observer.close();
    vi.useRealTimers();
  });

  it('shares a read between devices of the same user, and only reports changes', async () => {
    let body = 'one';
    const read = vi.fn(async () => ({ statusCode: 200, body }));
    const first = vi.fn();
    const second = vi.fn();
    observer.watch('alice', { path: '/projects' }, read, first);
    observer.watch('alice', { path: '/projects' }, read, second);
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    body = 'two';
    await vi.advanceTimersByTimeAsync(15_000);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(first.mock.calls).toEqual([[], []]);
  });

  it('does not share private snapshots or meeting-owner access between users', async () => {
    const read = vi.fn(async () => ({ statusCode: 200, body: 'private' }));
    observer.watch('alice', { path: '/projects' }, read, () => {});
    observer.watch('bob', { path: '/projects' }, read, () => {});
    observer.watch(
      'alice',
      { path: '/sessions/s/live-meetings/m/commands', ownerToken: 'one' },
      read,
      () => {},
    );
    observer.watch(
      'alice',
      { path: '/sessions/s/live-meetings/m/commands', ownerToken: 'two' },
      read,
      () => {},
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('announces a saved fold immediately after authorization, without waking unrelated sessions', async () => {
    let body = '{"collapsed":false}';
    const read = async () => ({ statusCode: 200, body });
    const projects = vi.fn();
    const other = vi.fn();
    observer.watch('alice', { path: '/projects' }, read, projects);
    observer.watch('alice', { path: '/sessions/other/branches' }, read, other);
    await vi.advanceTimersByTimeAsync(1000);
    body = '{"collapsed":true}';
    observer.invalidate('/projects/p/collapsed');
    await vi.advanceTimersByTimeAsync(1);
    expect(projects).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('refreshes the overview and affected session after a session mutation', async () => {
    let body = 'before';
    const read = async () => ({ statusCode: 200, body });
    const overview = vi.fn();
    const branches = vi.fn();
    const other = vi.fn();
    observer.watch('alice', { path: '/sessions?overview=1' }, read, overview);
    observer.watch('alice', { path: '/sessions/s/branches' }, read, branches);
    observer.watch('alice', { path: '/sessions/other/branches' }, read, other);
    await vi.advanceTimersByTimeAsync(1000);
    body = 'after';
    observer.invalidate('/sessions/s/merge');
    await vi.advanceTimersByTimeAsync(1);
    expect(overview).toHaveBeenCalledTimes(2);
    expect(branches).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('never reports changes in resources the user cannot read', async () => {
    let statusCode = 403;
    let body = 'forbidden';
    const changed = vi.fn();
    observer.watch(
      'member',
      { path: '/server/updates' },
      async () => ({ statusCode, body }),
      changed,
    );
    await vi.advanceTimersByTimeAsync(1000);
    observer.invalidate('/server/updates');
    await vi.advanceTimersByTimeAsync(1);
    expect(changed).not.toHaveBeenCalled();
    statusCode = 200;
    body = 'available';
    await vi.advanceTimersByTimeAsync(2500);
    expect(changed).toHaveBeenCalledTimes(1);
    statusCode = 403;
    observer.invalidate('/server/updates');
    await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenCalledTimes(2);
    observer.invalidate('/server/updates');
    await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('stops observing after the last view detaches, even with a pending read', async () => {
    let resolve!: (value: { statusCode: number; body: string }) => void;
    const read = vi.fn(
      () =>
        new Promise<{ statusCode: number; body: string }>((done) => {
          resolve = done;
        }),
    );
    const changed = vi.fn();
    const detach = observer.watch('alice', { path: '/projects' }, read, changed)!;
    detach();
    resolve({ statusCode: 200, body: 'late' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it('keeps unrelated resources moving while bounding pending reads', async () => {
    let resolve!: (value: { statusCode: number; body: string }) => void;
    const first = vi.fn(
      () =>
        new Promise<{ statusCode: number; body: string }>((done) => {
          resolve = done;
        }),
    );
    let releaseSecond!: (value: { statusCode: number; body: string }) => void;
    const second = vi.fn(
      () =>
        new Promise<{ statusCode: number; body: string }>((done) => {
          releaseSecond = done;
        }),
    );
    const third = vi.fn(async () => ({ statusCode: 200, body: '{}' }));
    observer.watch('alice', { path: '/projects' }, first, () => {});
    observer.watch('bob', { path: '/projects' }, second, () => {});
    observer.watch('charlie', { path: '/server/updates' }, third, () => {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(second).toHaveBeenCalledOnce();
    expect(third).not.toHaveBeenCalled();
    // A stuck branch or preview read must not freeze all other watched resources.
    releaseSecond({ statusCode: 200, body: '{}' });
    await vi.advanceTimersByTimeAsync(1);
    expect(third).toHaveBeenCalledOnce();
    resolve({ statusCode: 200, body: '{}' });
    await vi.advanceTimersByTimeAsync(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('refuses arbitrary, streaming and write-only resources', () => {
    const read = vi.fn();
    for (const path of [
      'https://example.com/projects',
      '//example.com/projects',
      '/sessions/s/files/download',
      '/sessions/s/stream',
      '/github/app/manifest/start',
      '/projects/../secret',
      '/projects/%2e%2e',
    ]) {
      expect(observer.watch('alice', { path }, read, () => {})).toBeUndefined();
    }
    expect(read).not.toHaveBeenCalled();
  });
});

it('invalidates account-wide task lists immediately after a background title update', async () => {
  const observer = new ResourceObserver();
  let body = 'provisional title';
  const changed = vi.fn();
  observer.watch('alice', { path: '/tasks' }, async () => ({ statusCode: 200, body }), changed);
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  body = 'generated title';
  observer.invalidate('/tasks');
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
  observer.close();
});
