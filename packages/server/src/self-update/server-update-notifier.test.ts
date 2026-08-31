import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PushNotification } from '../push-sender.js';
import {
  createServerUpdateNotifier,
  serverUpdateNotifierStatePath,
  SERVER_UPDATE_PUSH_CATEGORY,
} from './server-update-notifier.js';
import type { ServerUpdateAvailability } from './release-channel.js';
import type { UpdateOperation } from './update-operation.js';

const roots: string[] = [];
const newRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'verity-update-notifier-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const release = (version: string) =>
  ({ schemaVersion: 1, channel: 'stable', version }) as unknown as Extract<
    ServerUpdateAvailability,
    { state: 'available' }
  >['release'];

const available = (version: string): ServerUpdateAvailability => ({
  state: 'available',
  release: release(version),
  operation: null,
});

/** One accepted ticket: the shape `PushSender.send` returns when a device was told. */
const delivered = { ticketsAccepted: 1 };

/** An Updater operation in one particular state; nothing else about it is read. */
const inState = (state: UpdateOperation['state']): UpdateOperation =>
  ({ updateId: 'update-1', state }) as UpdateOperation;

async function fixture(
  availability: ServerUpdateAvailability,
  options: { fail?: boolean; targets?: number } = {},
) {
  const root = await newRoot();
  const statePath = serverUpdateNotifierStatePath(root);
  const sent: PushNotification[] = [];
  const notify = vi.fn(async (n: PushNotification) => {
    if (options.fail === true) throw new Error('expo is unreachable');
    sent.push(n);
    return { ticketsAccepted: options.targets ?? 1 };
  });
  const notifier = createServerUpdateNotifier({
    resolve: async () => availability,
    readOperation: async () => null,
    notify,
    statePath,
  });
  return { notifier, sent, notify, statePath };
}

describe('announcing a release', () => {
  it('sends one push naming the version', async () => {
    const f = await fixture(available('v11.1.0'));
    await expect(f.notifier.check()).resolves.toBe('announced');

    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({
      categoryId: SERVER_UPDATE_PUSH_CATEGORY,
      data: { kind: 'server-update', version: 'v11.1.0' },
    });
    expect(f.sent[0]?.body).toContain('v11.1.0');
  });

  it('stays quiet on every later pass for the same version', async () => {
    const f = await fixture(available('v11.1.0'));
    await f.notifier.check();
    await expect(f.notifier.check()).resolves.toBe('already-announced');
    await expect(f.notifier.check()).resolves.toBe('already-announced');
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it('announces again when a newer version appears', async () => {
    const root = await newRoot();
    const statePath = serverUpdateNotifierStatePath(root);
    let current = available('v11.1.0');
    const notify = vi.fn(async () => delivered);
    const notifier = createServerUpdateNotifier({
      resolve: async () => current,
      readOperation: async () => null,
      notify,
      statePath,
    });

    await expect(notifier.check()).resolves.toBe('announced');
    await expect(notifier.check()).resolves.toBe('already-announced');
    current = available('v11.2.0');
    await expect(notifier.check()).resolves.toBe('announced');
    expect(notify).toHaveBeenCalledTimes(2);
  });

  /**
   * The reason the state is a file rather than a variable: a release published
   * while the Server was down is exactly the one it must still announce, and a
   * restart is the most likely moment for that — the Server just replaced itself.
   */
  it('remembers across a restart', async () => {
    const f = await fixture(available('v11.1.0'));
    await f.notifier.check();

    const restarted = createServerUpdateNotifier({
      resolve: async () => available('v11.1.0'),
      readOperation: async () => null,
      notify: f.notify,
      statePath: f.statePath,
    });
    await expect(restarted.check()).resolves.toBe('already-announced');
    expect(f.notify).toHaveBeenCalledTimes(1);
  });
});

describe('staying quiet', () => {
  it.each([
    ['current', { state: 'current', release: release('v11.1.0'), operation: null }],
    ['unsupported', { state: 'unsupported', reason: 'deployment is not managed', operation: null }],
    // Announcing this one would invite an action `/server/updates` then refuses.
    ['incompatible', { state: 'incompatible', release: release('v12.0.0'), operation: null }],
  ])('says nothing for %s', async (_name, availability) => {
    const f = await fixture(availability as ServerUpdateAvailability);
    await expect(f.notifier.check()).resolves.toBe('nothing-to-announce');
    expect(f.notify).not.toHaveBeenCalled();
  });

  it('never throws when the channel cannot be read', async () => {
    const root = await newRoot();
    const notifier = createServerUpdateNotifier({
      resolve: async () => {
        throw new Error('channel is unreachable');
      },
      readOperation: async () => null,
      notify: vi.fn(async () => delivered),
      statePath: serverUpdateNotifierStatePath(root),
    });
    await expect(notifier.check()).resolves.toBe('nothing-to-announce');
  });
});

describe('when the push fails', () => {
  it('retries on the next pass rather than recording it as announced', async () => {
    const f = await fixture(available('v11.1.0'), { fail: true });
    await expect(f.notifier.check()).resolves.toBe('nothing-to-announce');
    await expect(f.notifier.check()).resolves.toBe('nothing-to-announce');
    // Two attempts, and nothing written: a failed send must not silence the next.
    expect(f.notify).toHaveBeenCalledTimes(2);
    await expect(readFile(f.statePath, 'utf8')).rejects.toThrow();
  });
});

describe('when the push reaches nobody', () => {
  /**
   * `PushSender.send` resolves whether or not anything was delivered: no paired
   * device, an Expo request that failed, a token Expo rejected — all resolve. If
   * that counted as announced, the release would be written down and never
   * mentioned again, and a deployment that pairs its first phone an hour later
   * would learn about the version after next. That is the silence this file was
   * written to remove, reintroduced one layer down.
   */
  it('keeps the release open until a device accepts it', async () => {
    const root = await newRoot();
    const statePath = serverUpdateNotifierStatePath(root);
    let accepted = 0;
    const notify = vi.fn(async () => ({ ticketsAccepted: accepted }));
    const notifier = createServerUpdateNotifier({
      resolve: async () => available('v11.1.0'),
      readOperation: async () => null,
      notify,
      statePath,
    });

    await expect(notifier.check()).resolves.toBe('undelivered');
    await expect(notifier.check()).resolves.toBe('undelivered');
    await expect(readFile(statePath, 'utf8')).rejects.toThrow();

    // The device pairs, and the release it was already sitting on is announced.
    accepted = 1;
    await expect(notifier.check()).resolves.toBe('announced');
    await expect(notifier.check()).resolves.toBe('already-announced');
    expect(notify).toHaveBeenCalledTimes(3);
  });
});

describe('while an update is already running', () => {
  /**
   * `ServerUpdateAvailability.operation` is `null` on every branch of the resolver —
   * only `GET /server/updates` overlays the Updater's journal onto it. A notifier
   * reading availability alone therefore sees a plain `available` throughout the
   * install and pushes "ready to install" into the middle of it, inviting an action
   * `POST /server/updates` refuses and contradicting the badge, which goes dark for
   * exactly this state.
   */
  it('says nothing, and leaves the release open for afterwards', async () => {
    const root = await newRoot();
    const statePath = serverUpdateNotifierStatePath(root);
    const notify = vi.fn(async () => delivered);
    let operation: UpdateOperation | null = inState('preparing');
    const notifier = createServerUpdateNotifier({
      resolve: async () => available('v11.1.0'),
      readOperation: async () => operation,
      notify,
      statePath,
    });

    await expect(notifier.check()).resolves.toBe('update-in-progress');
    expect(notify).not.toHaveBeenCalled();
    // Nothing recorded: an operation that fails leaves the release genuinely
    // available, and a written state file would have retired it silently.
    await expect(readFile(statePath, 'utf8')).rejects.toThrow();

    operation = null;
    await expect(notifier.check()).resolves.toBe('announced');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it.each(['rolling-back', 'activating', 'prepared'] as const)(
    'waits while an operation is still moving (%s)',
    async (state) => {
      const root = await newRoot();
      const notify = vi.fn(async () => delivered);
      const notifier = createServerUpdateNotifier({
        resolve: async () => available('v11.1.0'),
        readOperation: async () => inState(state),
        notify,
        statePath: serverUpdateNotifierStatePath(root),
      });

      await expect(notifier.check()).resolves.toBe('update-in-progress');
      expect(notify).not.toHaveBeenCalled();
    },
  );

  /**
   * "In progress" has to mean moving, not merely recorded. The Updater keeps the
   * last journal until the next accepted request archives it, and it accepts one
   * exactly when the previous operation is terminal — so a notifier that read any
   * operation as an update under way would fall permanently silent after the first
   * attempt a deployment ever made. The three cases below are the three ways that
   * silence would begin: an attempt that failed, one that rolled back, and one
   * that installed a version a later release has since superseded. In all three
   * the release is available, `POST /server/updates` would accept it, and nobody
   * would ever be told.
   */
  it.each(['failed', 'rolled-back', 'completed'] as const)(
    'announces a release left available by a %s operation',
    async (state) => {
      const root = await newRoot();
      const notify = vi.fn(async () => delivered);
      const notifier = createServerUpdateNotifier({
        resolve: async () => available('v11.2.0'),
        readOperation: async () => inState(state),
        notify,
        statePath: serverUpdateNotifierStatePath(root),
      });

      await expect(notifier.check()).resolves.toBe('announced');
      expect(notify).toHaveBeenCalledTimes(1);
    },
  );
});

describe('shutting down', () => {
  /**
   * `start()` fires a pass immediately, and that pass does a channel fetch, a push
   * and a state write. A `close()` that only cleared the timer would return while
   * all of that was still in flight, letting it land on a PushSender the `onClose`
   * hook is about to close.
   */
  it('waits for a pass that is still running', async () => {
    const root = await newRoot();
    let releaseResolve!: () => void;
    const resolving = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const notify = vi.fn(async () => delivered);
    const notifier = createServerUpdateNotifier({
      resolve: async () => {
        await resolving;
        return available('v11.1.0');
      },
      readOperation: async () => null,
      notify,
      statePath: serverUpdateNotifierStatePath(root),
    });

    notifier.start();
    let closed = false;
    const closing = notifier.close().then(() => {
      closed = true;
    });
    // The pass is parked in `resolve`, so close cannot have finished.
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseResolve();
    await closing;
    expect(closed).toBe(true);
    // And it really did run to completion rather than being abandoned.
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('starts nothing after it has been closed', async () => {
    const f = await fixture(available('v11.1.0'));
    await f.notifier.close();
    f.notifier.start();
    // No timer, no immediate pass: a closed notifier stays closed.
    expect(f.notify).not.toHaveBeenCalled();
  });
});

describe('the state file', () => {
  it('does not repeat within the same process when the file is corrupted', async () => {
    const f = await fixture(available('v11.1.0'));
    await f.notifier.check();
    await writeFile(f.statePath, 'not json at all');

    // The in-process record outranks the file: whatever happened to the state on
    // disk, this process already told the operator once.
    await expect(f.notifier.check()).resolves.toBe('already-announced');
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it('treats a corrupt file as nothing announced after a restart', async () => {
    const f = await fixture(available('v11.1.0'));
    await f.notifier.check();
    await writeFile(f.statePath, 'not json at all');

    // The honest degradation: unreadable state costs one repeat per restart, not
    // a repeat per check. Guessing "probably announced" would risk silence about a
    // release instead, which is the worse of the two.
    const restarted = createServerUpdateNotifier({
      resolve: async () => available('v11.1.0'),
      readOperation: async () => null,
      notify: f.notify,
      statePath: f.statePath,
    });
    await expect(restarted.check()).resolves.toBe('announced');
    expect(f.notify).toHaveBeenCalledTimes(2);
  });

  it('leaves no scratch file behind', async () => {
    const f = await fixture(available('v11.1.0'));
    await f.notifier.check();
    await expect(readFile(`${f.statePath}.tmp`, 'utf8')).rejects.toThrow();
  });
});

describe('one notification per release, whatever else breaks', () => {
  /**
   * The requirement in one test: a pending update must not produce a stream of
   * notifications. Twenty passes over the same available release, and exactly one
   * push leaves the building.
   */
  it('sends exactly one push across many checks of the same version', async () => {
    const f = await fixture(available('v11.1.0'));
    for (let i = 0; i < 20; i += 1) await f.notifier.check();
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  /**
   * The failure mode that would otherwise reinstate the stream: the push is
   * accepted but the state file cannot be written. Without the in-process record
   * every later pass would re-read "nothing announced" and send again.
   */
  it('still sends only one when the state file cannot be written', async () => {
    const root = await newRoot();
    // A directory where the file belongs: writing fails, reading yields nothing.
    const statePath = serverUpdateNotifierStatePath(root);
    await mkdir(statePath, { recursive: true });
    const notify = vi.fn(async () => delivered);
    const notifier = createServerUpdateNotifier({
      resolve: async () => available('v11.1.0'),
      readOperation: async () => null,
      notify,
      statePath,
    });

    await expect(notifier.check()).resolves.toBe('announced');
    for (let i = 0; i < 10; i += 1) await notifier.check();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
