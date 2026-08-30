import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVATION_GATE_DIRECTORY,
  activationGatePath,
  openActivationGate,
  waitForActivationGate,
} from './activation-gate.js';

/**
 * The Updater half of the gate writes through `node:fs/promises` with no
 * injection point, and what it publishes is an inode a DIFFERENT container is
 * trusted to read: root-owned, group-readable by the peer, and readable by
 * nobody else. Those are exactly the facts a unit test has to be able to see, so
 * the four entry points it uses are backed by an in-memory inode table.
 *
 * Only paths under the gate directory are intercepted — every other caller
 * (vitest's own runtime included) keeps the real implementation.
 */
const gate = vi.hoisted(() => {
  interface Inode {
    content: string;
    uid: number;
    gid: number;
    mode: number;
    isFile: boolean;
  }
  return {
    files: new Map<string, Inode>(),
    events: [] as string[],
    /** uid the host would give a file this process creates (0 = running as root). */
    createUid: 0,
    openError: undefined as NodeJS.ErrnoException | undefined,
    raceWinner: undefined as Inode | undefined,
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const owned = (path: unknown): path is string =>
    typeof path === 'string' && path.startsWith('/run/verity-updater/control/');
  const enoent = (path: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
      code: 'ENOENT',
    });
  return {
    ...actual,
    open: async (path: unknown, ...rest: unknown[]) => {
      if (path === '/run/verity-updater/control') {
        return {
          sync: async () => {
            gate.events.push('dirsync');
          },
          close: async () => undefined,
        };
      }
      if (!owned(path)) return actual.open(path as string, ...(rest as []));
      if (gate.openError !== undefined) throw gate.openError;
      const inode = gate.files.get(path);
      if (inode === undefined) throw enoent(path);
      gate.events.push(`open:${path}`);
      return {
        stat: async () => ({
          isFile: () => inode.isFile,
          uid: inode.uid,
          gid: inode.gid,
          mode: inode.mode,
        }),
        readFile: async () => inode.content,
        chown: async (uid: number, group: number) => {
          gate.events.push(`chown:${String(uid)}:${String(group)}`);
          inode.uid = uid;
          inode.gid = group;
        },
        chmod: async (mode: number) => {
          gate.events.push(`chmod:${mode.toString(8)}`);
          inode.mode = (inode.mode & ~0o7777) | mode;
        },
        sync: async () => {
          gate.events.push('sync');
        },
        close: async () => undefined,
      };
    },
    writeFile: async (path: unknown, data: unknown, options: unknown) => {
      if (!owned(path)) return actual.writeFile(path as string, data as string, options as object);
      if ((options as { flag?: string }).flag === 'wx' && gate.files.has(path))
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      gate.events.push('writeFile');
      gate.files.set(path, {
        content: String(data),
        uid: gate.createUid,
        gid: gate.createUid,
        mode: 0o100000 | ((options as { mode?: number }).mode ?? 0o600),
        isFile: true,
      });
      return undefined;
    },
    link: async (from: unknown, to: unknown) => {
      if (!owned(from)) return actual.link(from as string, to as string);
      const inode = gate.files.get(from);
      if (inode === undefined) throw enoent(from);
      if (gate.raceWinner !== undefined) gate.files.set(to as string, gate.raceWinner);
      if (gate.files.has(to as string))
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      gate.events.push(`link:${String(to)}`);
      gate.files.set(to as string, inode);
      return undefined;
    },
    unlink: async (path: unknown) => {
      if (!owned(path)) return actual.unlink(path as string);
      if (!gate.files.delete(path)) throw enoent(path);
      gate.events.push('unlink');
      return undefined;
    },
  };
});

const GATE = `${ACTIVATION_GATE_DIRECTORY}/activate-update-7`;
const PEER_GID = 1101;

interface Inode {
  content: string;
  uid: number;
  gid: number;
  mode: number;
  isFile: boolean;
}

/** What a correctly published marker looks like on disk. */
const published = (overrides: Partial<Inode> = {}): Inode => ({
  content: 'update-7\n',
  uid: 0,
  gid: PEER_GID,
  mode: 0o100640,
  isFile: true,
  ...overrides,
});

beforeEach(() => {
  gate.files.clear();
  gate.events.length = 0;
  gate.createUid = 0;
  gate.openError = undefined;
  gate.raceWinner = undefined;
});

describe('standby activation gate', () => {
  it('binds one validated operation to the private updater-control volume', () => {
    expect(activationGatePath('update-7')).toBe('/run/verity-updater/control/activate-update-7');
    expect(() => activationGatePath('../escape')).toThrow('operation id is invalid');
  });

  it('does not let lock availability activate a candidate before journal authority exists', async () => {
    let present = false;
    const openFile = vi.fn(async () => {
      if (!present) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return {
        stat: async () => ({
          isFile: () => true,
          uid: 0,
          gid: process.getegid?.() ?? 0,
          mode: 0o100640,
        }),
        readFile: async () => 'update-7\n',
        close: async () => undefined,
      };
    });
    const sleep = vi.fn(async () => {
      present = true;
    });

    await expect(waitForActivationGate('update-7', { openFile, sleep })).resolves.toBeUndefined();
    expect(openFile).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('fails closed on a writable or non-root activation marker', async () => {
    const openFile = vi.fn(async () => ({
      stat: async () => ({
        isFile: () => true,
        uid: 1000,
        gid: process.getegid?.() ?? 0,
        mode: 0o100660,
      }),
      readFile: async () => 'update-7\n',
      close: async () => undefined,
    }));
    await expect(waitForActivationGate('update-7', { openFile })).rejects.toThrow(
      'private root-owned, peer-readable regular file',
    );
  });

  it('rejects a marker whose contents do not grant this operation authority', async () => {
    const openFile = vi.fn(async () => ({
      stat: async () => ({
        isFile: () => true,
        uid: 0,
        gid: process.getegid?.() ?? 0,
        mode: 0o100640,
      }),
      readFile: async () => 'update-6\n',
      close: async () => undefined,
    }));
    await expect(waitForActivationGate('update-7', { openFile })).rejects.toThrow(
      'belongs to another operation',
    );
  });

  it('reads the marker off the shared volume when no reader is injected', async () => {
    // The production default — `open(path, O_RDONLY | O_NOFOLLOW)` against the
    // agreed directory, and a real 250ms sleep between attempts — is the code path
    // every deployed Server actually takes; the injected reader above never
    // exercises the path constant or the retry clock.
    setTimeout(() => gate.files.set(GATE, published({ gid: process.getegid?.() ?? 0 })), 10);

    await expect(waitForActivationGate('update-7')).resolves.toBeUndefined();
    expect(gate.events).toContain(`open:${GATE}`);
  });

  it('refuses a peer gid that could never name a real group', async () => {
    for (const gid of [-1, 1.5, Number.NaN]) {
      await expect(openActivationGate('update-7', gid)).rejects.toThrow(
        'activation gate peer gid is invalid',
      );
    }
    expect([...gate.files.keys()]).toEqual([]);
  });

  it('publishes the marker as a private root-owned file before it appears at its name', async () => {
    // Ordering is the point: the waiting Server opens the gate by name, so the
    // ownership and mode have to be final BEFORE the link makes it visible.
    // Publishing first and tightening afterwards would leave a window in which a
    // peer-writable marker is a valid activation authority.
    await expect(openActivationGate('update-7', PEER_GID)).resolves.toBeUndefined();

    expect(gate.events.map((event) => event.split(':')[0])).toEqual([
      'writeFile',
      'open',
      'chown',
      'chmod',
      'sync',
      'link',
      'dirsync',
      'unlink',
    ]);
    expect(gate.events).toContain(`chown:0:${String(PEER_GID)}`);
    expect(gate.events).toContain('chmod:640');
    expect([...gate.files.keys()]).toEqual([GATE]);
    expect(gate.files.get(GATE)).toMatchObject({
      content: 'update-7\n',
      uid: 0,
      gid: PEER_GID,
      mode: 0o100640,
    });
  });

  it('adopts a valid concurrent winner without replacing its inode', async () => {
    const winner = published();
    gate.raceWinner = winner;
    await expect(openActivationGate('update-7', PEER_GID)).resolves.toBeUndefined();
    expect(gate.files.get(GATE)).toBe(winner);
    expect(gate.events).not.toContain(`link:${GATE}`);
  });

  it('adopts an already published marker instead of republishing it', async () => {
    // The Updater re-enters this after a crash. A second publish would hand the
    // waiting Server a new inode under the same name while it holds the old one.
    gate.files.set(GATE, published());

    await expect(openActivationGate('update-7', PEER_GID)).resolves.toBeUndefined();

    expect(gate.events).toEqual([`open:${GATE}`]);
  });

  it.each([
    ['the peer cannot read', published({ mode: 0o100600 })],
    ['anyone else can write', published({ mode: 0o100646 })],
    ['another user owns', published({ uid: 1000 })],
    ['another group is authorized by', published({ gid: PEER_GID + 1 })],
    ['is not a regular file at all', published({ isFile: false })],
  ])('refuses to adopt a marker %s', async (_case, inode) => {
    gate.files.set(GATE, inode);

    await expect(openActivationGate('update-7', PEER_GID)).rejects.toThrow(
      'activation gate must be a private root-owned, peer-readable regular file',
    );
    // Refusing is only half of it: the offending inode must survive untouched
    // rather than be replaced by a marker this Updater considers acceptable.
    expect(gate.files.get(GATE)).toBe(inode);
  });

  it('refuses to adopt a marker that authorizes a different operation', async () => {
    gate.files.set(GATE, published({ content: 'update-6\n' }));

    await expect(openActivationGate('update-7', PEER_GID)).rejects.toThrow(
      'activation gate belongs to another operation',
    );
  });

  it('surfaces an unreadable control directory instead of publishing over it', async () => {
    // Only ENOENT means "no marker yet". Anything else — a permission change, a
    // volume that failed to mount — has to stop the operation, because publishing
    // past it would claim authority the Updater could not verify it holds.
    gate.openError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

    await expect(openActivationGate('update-7', PEER_GID)).rejects.toThrow(
      'EACCES: permission denied',
    );
    expect(gate.events).toEqual([]);
  });

  it('leaves no half-published temporary behind when it cannot own the marker', async () => {
    // A non-root Updater cannot produce a marker the peer may trust. The refusal
    // matters, and so does the cleanup: a stale `.next` file in the shared control
    // volume is indistinguishable from one a concurrent publish is still using.
    gate.createUid = 1000;

    await expect(openActivationGate('update-7', PEER_GID)).rejects.toThrow(
      'activation gate must be a root-owned regular file',
    );
    expect([...gate.files.keys()]).toEqual([]);
    expect(gate.events).toContain('unlink');
  });
});
