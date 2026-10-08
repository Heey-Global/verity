import { createServer as createHttpServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createServerUpdateController,
  notifyManagedMatrixConfigured,
} from './server-update-controller.js';
import {
  startUpdaterStatusServer,
  updaterControlTokenPath,
  type UpdaterStatusServer,
} from './updater-status.js';

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
  it.each(['legacy', 'current', 'unreachable'] as const)(
    'negotiates channel fencing with a %s Updater',
    async (mode) => {
      const { socketPath } = await mounted();
      await writeFile(updaterControlTokenPath(socketPath), 'a'.repeat(32));
      const bodies: unknown[] = [];
      const peer = createHttpServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/update-channel') {
          const status = mode === 'legacy' ? 404 : mode === 'unreachable' ? 503 : 200;
          res
            .writeHead(status)
            .end(JSON.stringify(status === 200 ? { channel: 'stable' } : { error: 'unavailable' }));
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          bodies.push(body);
          // A legacy Updater rejects unknown fields before attempting installation.
          const invalid = mode === 'legacy' && Object.keys(body as object).length !== 2;
          res
            .writeHead(invalid ? 400 : 409)
            .end(JSON.stringify({ error: invalid ? 'invalid-request' : 'operation-in-progress' }));
        });
      });
      await new Promise<void>((resolve) => peer.listen(socketPath, resolve));
      servers.push({
        close: () =>
          new Promise<void>((resolve, reject) =>
            peer.close((error) => (error ? reject(error) : resolve())),
          ),
      });
      const controller = await createServerUpdateController(socketPath, async () => undefined);
      const targetDigest = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
      await expect(
        controller!.requestUpdate({ idempotencyKey: 'update-1', targetDigest, channel: 'stable' }),
      ).rejects.toMatchObject({ status: mode === 'unreachable' ? 503 : 409 });
      expect(bodies).toEqual(
        mode === 'unreachable'
          ? []
          : [
              {
                idempotencyKey: 'update-1',
                targetDigest,
                ...(mode === 'current' ? { channel: 'stable' } : {}),
              },
            ],
      );
    },
  );

  it('verifies the image before contacting the privileged Updater', async () => {
    const { socketPath } = await mounted();
    const verify = vi.fn().mockRejectedValue(new Error('bad signature'));
    const controller = await createServerUpdateController(socketPath, verify);
    const targetDigest = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
    await expect(
      controller!.requestUpdate({ idempotencyKey: 'update-1', targetDigest }),
    ).rejects.toThrow('bad signature');
    expect(verify).toHaveBeenCalledWith(targetDigest);
    // A successful check reaches the control token read; failed checks must not dispatch.
    verify.mockResolvedValue(undefined);
    await expect(
      controller!.requestUpdate({ idempotencyKey: 'update-1', targetDigest }),
    ).rejects.toThrow(/ENOENT/);
  });

  it('notifies the Updater only when its authenticated control channel is available', async () => {
    const { managedRoot, socketPath } = await mounted();
    await expect(notifyManagedMatrixConfigured(socketPath)).rejects.toThrow(/ENOENT/);
    let activations = 0;
    servers.push(
      await startUpdaterStatusServer({
        socketPath,
        token: 'a'.repeat(32),
        managedRoot,
        peerGid: process.getgid?.() ?? 0,
        onMatrixConfigured: async () => {
          activations += 1;
        },
      }),
    );
    await expect(notifyManagedMatrixConfigured(socketPath)).resolves.toBe(true);
    expect(activations).toBe(1);
  });

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
