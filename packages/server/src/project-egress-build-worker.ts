import {
  ProtectedBuildFailure,
  protectedBuildFailure,
  type ProtectedBuildDiagnostic,
} from './project-egress-build-error.js';
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
  sameProtectedBuildRequest,
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
): Promise<{ success: boolean; failure?: ProtectedBuildDiagnostic }> {
  request = protectedBuildRequest.parse(request);
  const now = options.now ?? (() => performance.now());
  const pause = options.pause ?? delay;
  const until = now() + (options.timeoutMs ?? 30 * 60_000);
  const reference = { projectId: request.projectId, attemptId: request.attemptId };
  const confirmed = (reply: ProtectedBuildReply): boolean =>
    'record' in reply &&
    reply.record.ended &&
    (reply.record.phase === 'failed' || reply.record.phase === 'succeeded') &&
    sameProtectedBuildRequest(reply.record.request, request);
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
      if (confirmed(reply)) return { success: reply.record.phase === 'succeeded' };
      if (reply.record.phase === 'running') {
        try {
          await retry({ operation: 'heartbeat', ...reference });
        } catch (error) {
          const current = await retry({ operation: 'status', ...reference });
          if ('record' in current && confirmed(current))
            return { success: current.record.phase === 'succeeded' };
          throw error;
        }
      }
      await pause(200);
    }
    const stopped = await command({ operation: 'cancel', ...reference });
    if (!confirmed(stopped)) throw new Error('Protected build termination is unconfirmed');
    return { success: false };
  } catch (error) {
    // A failed build can still have a confirmed end. Only exact host evidence,
    // never client exit or error text, allows storage to be released.
    for (const operation of ['cancel', 'status'] as const) {
      const reply = await command({ operation, ...reference }).catch(() => undefined);
      if (reply && confirmed(reply)) {
        // A lost heartbeat or reply after the build itself succeeded is not a failed build.
        if ('record' in reply && reply.record.phase === 'succeeded') return { success: true };
        return {
          success: false,
          ...(error instanceof ProtectedBuildFailure
            ? { failure: protectedBuildFailure(error) }
            : {}),
        };
      }
    }
    throw error;
  }
}
export async function runProtectedBuildWorker(options: {
  jobFile: string;
  socketPath: string;
  keyPath: string;
}): Promise<{ success: boolean; failure?: ProtectedBuildDiagnostic }> {
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
