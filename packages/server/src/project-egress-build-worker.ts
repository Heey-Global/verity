/** Private Server child. Only a host-confirmed terminal outcome releases storage;
 * a nonzero exit retains reservations because remote work may still be running.
 */
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createProtectedBuildClient,
  ProtectedBuildTransportError,
} from './project-egress-build-client.js';
import {
  protectedBuildRequest,
  type ProtectedBuildRequest,
  type ProtectedBuildCommand,
  type ProtectedBuildReply,
} from './project-egress-build.js';
import { z } from 'zod';

type Command = (command: ProtectedBuildCommand) => Promise<ProtectedBuildReply>;
export async function superviseProtectedBuild(
  request: ProtectedBuildRequest,
  command: Command,
  options: {
    now?: () => number;
    pause?: (ms: number) => Promise<unknown>;
    timeoutMs?: number;
  } = {},
): Promise<{ success: boolean }> {
  request = protectedBuildRequest.parse(request);
  const now = options.now ?? (() => performance.now());
  const pause = options.pause ?? delay;
  const until = now() + (options.timeoutMs ?? 30 * 60_000);
  const reference = { projectId: request.projectId, attemptId: request.attemptId };
  const retry = async (input: ProtectedBuildCommand) => {
    while (true) {
      try {
        return await command(input);
      } catch (error) {
        // A refusal or malformed acknowledgement is not a transient network loss.
        if (!(error instanceof ProtectedBuildTransportError) || now() >= until) throw error;
        await pause(200);
      }
    }
  };
  const health = await command({ operation: 'health' });
  if (!('available' in health) || !health.available)
    throw new Error('Protected builder is not ready');
  try {
    // Idempotent begin survives long snapshot preparation and a lost reply. A new
    // attempt ID here would orphan the original workload and its storage owner.
    await retry({ operation: 'begin', request });
    while (now() < until) {
      const reply = await retry({ operation: 'status', ...reference });
      if (!('record' in reply)) throw new Error('Invalid protected build status');
      if (reply.record.ended) return { success: reply.record.phase === 'succeeded' };
      if (reply.record.phase === 'running') await retry({ operation: 'heartbeat', ...reference });
      await pause(200);
    }
    const stopped = await command({ operation: 'cancel', ...reference });
    if (!('record' in stopped) || !stopped.record.ended)
      throw new Error('Protected build termination is unconfirmed');
    return { success: false };
  } catch (error) {
    // Cancellation is best effort on a broken transport. Failure remains nonzero
    // even if cancellation replies, preserving conservative reservation handling.
    await command({ operation: 'cancel', ...reference }).catch(() => undefined);
    throw error;
  }
}
export async function runProtectedBuildWorker(options: {
  jobFile: string;
  socketPath: string;
  keyPath: string;
}): Promise<{ success: boolean }> {
  const job = z
    .strictObject({ request: protectedBuildRequest })
    .parse(JSON.parse(await readFile(options.jobFile, 'utf8')));
  const key = (await readFile(options.keyPath, 'utf8')).trim();
  return superviseProtectedBuild(
    job.request,
    createProtectedBuildClient({
      socketPath: options.socketPath,
      token: () => key,
      timeoutMs: 30000,
    }),
  );
}
