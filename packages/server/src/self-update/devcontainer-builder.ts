import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import type { DockerClient } from '../docker.js';
import { requestHostAnswer } from './host-runtimes.js';

/** Written by `deploy/bin/verity-install` into the host runtime directory. */
const DEVCONTAINER_BUILDER_RECEIPT_FILE = 'devcontainer-builder.json';

const receiptSchema = z
  .object({
    version: z.literal(1),
    gid: z.number().int().positive().lt(65535),
  })
  .strict();

export type DevcontainerBuilderCapability =
  | { readonly state: 'available'; readonly gid: number }
  | { readonly state: 'unsupported' | 'invalid' };

/**
 * Whether the installer verified the dedicated devcontainer builder on this host.
 *
 * The receipt records an installation, not liveness: it is written only after
 * the builder unit was active and its socket existed, and it is the Updater's
 * sole reason to add the socket bind to a sealed spec. Whether the builder is
 * up when a project builds is the Server's to check, against the socket itself.
 */
export async function readDevcontainerBuilderCapability(
  directory = '/run/verity-host-runtime',
): Promise<DevcontainerBuilderCapability> {
  let handle;
  try {
    handle = await open(join(directory, DEVCONTAINER_BUILDER_RECEIPT_FILE), 'r');
    const buffer = Buffer.alloc(1025);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024) return { state: 'invalid' };
    const parsed = receiptSchema.safeParse(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
    return parsed.success ? { state: 'available', gid: parsed.data.gid } : { state: 'invalid' };
  } catch (error) {
    return {
      state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unsupported' : 'invalid',
    };
  } finally {
    await handle?.close();
  }
}

/**
 * A release whose image carries the builder bundle `verity-host-builder` installs (the files
 * under /opt/verity-install/deploy that deploy/buildkit/install.sh reads) declares this label.
 * Older releases do not, and are never asked for it.
 */
export const DEVCONTAINER_BUILDER_LABEL = 'org.verity.devcontainer-builder';
export const DEVCONTAINER_BUILDER_CONTRACT = '2';

const INSTALLER_ONCE =
  'Re-run the Verity installer once on the host; later updates then install the builder ' +
  'their release ships.';

export type DevcontainerBuilderReconciliation =
  | { readonly state: 'skipped'; readonly reason: string }
  | { readonly state: 'reconciled'; readonly message: string }
  | { readonly state: 'failed'; readonly message: string };

export interface ReconcileDevcontainerBuilderOptions {
  readonly docker: Pick<DockerClient, 'inspectImageLabels'>;
  /** The official target image digest; the host verifies its signature itself. */
  readonly image: string;
  /** Stable across a resumed operation, so a crash reuses the request and its answer. */
  readonly requestId: string;
  readonly requestDir?: string;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

async function hostBuilderTrigger(directory: string): Promise<unknown> {
  try {
    const agent: unknown = JSON.parse(await readFile(join(directory, 'agent.json'), 'utf8'));
    return agent !== null && typeof agent === 'object' && 'builder' in agent
      ? agent.builder
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Have the host install the devcontainer builder the target release ships, before the release
 * is activated.
 *
 * The builder is a host service, so without this a fix to it reached a host only through a
 * manual installer run, while the Server it serves was already updated. The request names only
 * the target image: `verity-host-builder` verifies that image's release signature, takes the
 * bundle out of it, and leaves an unchanged builder running.
 *
 * Never throws for a host condition. A builder that cannot be brought up to date keeps the
 * previous one (the host component restores it), and repository builds are not a reason to hold
 * back a Server update, so the caller reports the outcome and the update continues; the next
 * update asks again.
 */
export async function reconcileDevcontainerBuilder(
  options: ReconcileDevcontainerBuilderOptions,
): Promise<DevcontainerBuilderReconciliation> {
  const directory = options.requestDir ?? '/run/verity-host-runtime';
  if (options.docker.inspectImageLabels === undefined)
    return { state: 'skipped', reason: 'image labels are unavailable' };
  const labels = await options.docker.inspectImageLabels(options.image);
  if (labels?.[DEVCONTAINER_BUILDER_LABEL] !== DEVCONTAINER_BUILDER_CONTRACT)
    return { state: 'skipped', reason: 'the target release declares no builder bundle' };
  const capability = await readDevcontainerBuilderCapability(directory);
  if (capability.state !== 'available')
    return { state: 'skipped', reason: 'this host has no installer-verified builder' };
  if ((await hostBuilderTrigger(directory)) !== 'systemd-path')
    return {
      state: 'failed',
      message: `This host's Verity host components predate builder updates. ${INSTALLER_ONCE}`,
    };
  const result = await requestHostAnswer({
    dir: directory,
    request: 'builder-request.json',
    result: 'builder-result.json',
    id: options.requestId,
    body: { version: 1, id: options.requestId, image: options.image },
    // Longer than the host unit's own 20-minute limit, so its last answer still arrives.
    timeoutMs: options.timeoutMs ?? 25 * 60_000,
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (result === undefined)
    return {
      state: 'failed',
      message:
        'The host builder service did not answer; check `journalctl -u verity-host-builder` on the host.',
    };
  return result.ok
    ? { state: 'reconciled', message: result.message }
    : {
        state: 'failed',
        message: `The host could not update the devcontainer builder: ${result.message}`,
      };
}
