import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerUpdateController } from './server-update-controller.js';
import { startUpdaterStatusServer, type UpdaterStatusServer } from './updater-status.js';

const servers: UpdaterStatusServer[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

/** A Server container's view: the control volume is mounted, and whatever the
 *  Updater has published inside it so far. */
async function mounted() {
  const root = await mkdtemp(join(tmpdir(), 'verity-server-update-controller-'));
  const control = join(root, 'control');
  await mkdir(control, { mode: 0o750 });
  const managedRoot = join(root, 'managed-deployment');
  await mkdir(managedRoot, { mode: 0o700 });
  return { root, managedRoot, socketPath: join(control, 'updater.sock') };
}

describe('server update controller', () => {
  it('is absent when the deployment has no updater control mount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-server-update-controller-'));
    await expect(
      createServerUpdateController(join(root, 'control', 'updater.sock')),
    ).resolves.toBeUndefined();
  });

  it('is absent when the control path is not a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-server-update-controller-'));
    await writeFile(join(root, 'control'), '');
    await expect(
      createServerUpdateController(join(root, 'control', 'updater.sock')),
    ).resolves.toBeUndefined();
  });

  /**
   * The startup race this exists to prevent: the Updater finishes an
   * interrupted operation and reconciles the Server BEFORE it publishes its
   * socket, so the Server can boot into an empty control directory. Judging
   * managed-ness by the socket would disable the update action for the whole
   * life of that Server process, long after the Updater came up.
   */
  it('stays available while the Updater has not published its boundary yet', async () => {
    const { managedRoot, socketPath } = await mounted();
    const controller = await createServerUpdateController(socketPath);
    expect(controller).toBeDefined();
    // Unknown, not "no operation": the caller turns this into a 503.
    await expect(controller?.readOperation()).rejects.toThrow(/ENOENT/);

    servers.push(
      await startUpdaterStatusServer({
        socketPath,
        token: 'a'.repeat(32),
        managedRoot,
        // Publishing the token to the peer group is what a managed deployment
        // does; the test process can only chown to a group it belongs to.
        peerGid: process.getgid?.() ?? 0,
      }),
    );

    // Same controller instance, no Server restart in between.
    await expect(controller?.readOperation()).resolves.toBeNull();
  });

  it('follows a token the Updater republished after a restart', async () => {
    const { managedRoot, socketPath } = await mounted();
    const peerGid = process.getgid?.() ?? 0;
    const first = await startUpdaterStatusServer({
      socketPath,
      token: 'a'.repeat(32),
      managedRoot,
      peerGid,
    });
    const controller = await createServerUpdateController(socketPath);
    await expect(controller?.readOperation()).resolves.toBeNull();

    await first.close();
    servers.push(
      await startUpdaterStatusServer({
        socketPath,
        token: 'b'.repeat(32),
        managedRoot,
        peerGid,
      }),
    );
    await expect(controller?.readOperation()).resolves.toBeNull();
  });
});
