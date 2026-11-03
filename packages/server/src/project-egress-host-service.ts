import type { Server } from 'node:http';
import { z } from 'zod';

export function verifyProjectEgressServiceManager(version: string, init: string): void {
  const release = /^systemd (\d+)\b/u.exec(version)?.[1];
  if (init.trim() !== 'systemd' || release === undefined || Number(release) < 249)
    throw new Error('Project egress requires systemd >=249 as PID 1');
}

export function verifyProjectEgressDockerHost(value: unknown): void {
  z.object({
    OSType: z.literal('linux'),
    ServerVersion: z.literal('29.9.2'),
    LiveRestoreEnabled: z.literal(false),
    SecurityOptions: z
      .array(z.string())
      .refine((items) => !items.some((item) => item.includes('rootless'))),
  }).parse(value);
}

type ControlServer = Pick<Server, 'close' | 'closeAllConnections'>;

/** Readiness belongs to a validated controller, not merely a running process. */
export async function serveProjectEgressHost(deps: {
  restore(): Promise<void>;
  deny(): Promise<void>;
  verifyHost(): Promise<void>;
  revalidate(): Promise<void>;
  listen(): Promise<ControlServer>;
  notifyReady(): Promise<void>;
}): Promise<{ stop(): Promise<void> }> {
  await deps.restore();
  await deps.verifyHost();
  await deps.revalidate();
  const server = await deps.listen();
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      // Close admission before draining the controller's serialized operations.
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await Promise.all([closed, deps.deny()]);
    })();
    return stopping;
  };
  try {
    await deps.notifyReady();
  } catch (error) {
    await stop();
    throw error;
  }
  return { stop };
}
