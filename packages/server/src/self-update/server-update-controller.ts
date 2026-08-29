import { lstat, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ServerUpdateController } from '../server.js';
import {
  acknowledgeUpdaterStandby,
  claimUpdaterHandoffEnvelope,
  publishUpdaterHandoff,
  readUpdaterHandoff,
  readUpdaterAgentSeed,
  readUpdaterOperation,
  readUpdaterStandby,
  requestUpdaterOperation,
  updaterControlTokenPath,
  UPDATER_CONTROL_SOCKET,
  type UpdaterHandoffMessage,
  type UpdaterHandoffState,
} from './updater-status.js';
import { compareAgentSeed, type AgentSeedProvenance } from './agent-seed-stamp.js';
import type { KeyHandoffEnvelope } from './secret-key-handoff.js';
import type { StandbyDirective, StandbyDirectiveState } from './standby-directive.js';

/**
 * A reachable control channel, or undefined when this deployment has none.
 *
 * Presence is decided by the control MOUNT, not by what is inside it. The
 * volume is part of the sealed Server spec, so the directory is there from the
 * first instant the container runs, and it is absent exactly in the cases that
 * should get no controller: a legacy Compose deployment, or a spec sealed
 * before the mount existed.
 *
 * The socket and the token are deliberately NOT part of that question. The
 * Updater publishes them only after it has finished resuming an interrupted
 * operation, and it reconciles the Server before it starts listening — so a
 * Server that boots quickly can look at an empty control directory. Deciding
 * managed-ness there would turn a few seconds of startup ordering into a Server
 * that refuses every update action until someone restarts it.
 *
 * Both files are therefore resolved per call. An Updater that is not listening
 * yet surfaces as an unreachable control channel — `/server/updates` answers
 * "status unavailable", the action answers "updater is unavailable" — which is
 * a transient, retryable truth rather than a permanent verdict.
 *
 * Re-reading the token per call matters for a second reason: it originates in a
 * host secret file the Updater republishes on every start, so caching it would
 * turn a rotation into a Server that 401s until it is restarted.
 */
async function openControlChannel(
  socketPath: string,
): Promise<(() => Promise<{ socketPath: string; token: string }>) | undefined> {
  const tokenPath = updaterControlTokenPath(socketPath);
  try {
    // `lstat`, so a symlink planted where the mount should be does not pass as
    // the mount itself.
    if (!(await lstat(dirname(socketPath))).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return async () => {
    const token = (await readFile(tokenPath, 'utf8')).trim();
    if (token.length < 32) throw new Error('updater control token is malformed');
    return { socketPath, token };
  };
}

/** The Server's client for the device-facing update actions. */
export async function createServerUpdateController(
  socketPath: string = UPDATER_CONTROL_SOCKET,
): Promise<ServerUpdateController | undefined> {
  const channel = await openControlChannel(socketPath);
  if (channel === undefined) return undefined;
  return {
    async readOperation() {
      return readUpdaterOperation(await channel());
    },
    async requestUpdate(input) {
      return requestUpdaterOperation({ ...(await channel()), ...input });
    },
  };
}

/**
 * The Server's client for the secret-key handoff (ADR 0008 D8).
 *
 * Separate from {@link createServerUpdateController} because it is not part of
 * the device-facing update API: these three calls are how the outgoing and the
 * promoted Server talk past each other through the only channel they share, and
 * no request ever reaches them from outside.
 */
export interface SecretKeyHandoffClient {
  read(): Promise<UpdaterHandoffState | null>;
  publish(message: UpdaterHandoffMessage): Promise<boolean>;
  claimEnvelope(): Promise<KeyHandoffEnvelope | null>;
}

export async function createSecretKeyHandoffClient(
  socketPath: string = UPDATER_CONTROL_SOCKET,
): Promise<SecretKeyHandoffClient | undefined> {
  const channel = await openControlChannel(socketPath);
  if (channel === undefined) return undefined;
  return {
    async read() {
      return readUpdaterHandoff(await channel());
    },
    async publish(message) {
      return publishUpdaterHandoff(await channel(), message);
    },
    async claimEnvelope() {
      return claimUpdaterHandoffEnvelope(await channel());
    },
  };
}

/**
 * The Server's view of the agent seed the host is serving to sandboxes.
 *
 * Goes through the Updater because the Server cannot see the directory: its
 * mounts are fixed by the sealed deployment spec, which admits four, none
 * read-only, and the fourth is the control socket this client speaks over.
 * Widening that allowlist to let the Server read one file would be a poor trade
 * — the Updater already has the directory and already answers questions.
 */
export interface AgentSeedProvenanceClient {
  read(): Promise<AgentSeedProvenance>;
}

export async function createAgentSeedProvenanceClient(
  serverVersion: string,
  socketPath: string = UPDATER_CONTROL_SOCKET,
): Promise<AgentSeedProvenanceClient | undefined> {
  const channel = await openControlChannel(socketPath);
  if (channel === undefined) return undefined;
  return {
    async read() {
      const seed = await readUpdaterAgentSeed(await channel());
      if (!seed.visible)
        return {
          state: 'unknown',
          reason:
            'the Updater does not have the agent seed mounted, so this deployment cannot tell which release the sandboxes are running',
        };
      return compareAgentSeed(seed.stamp, serverVersion);
    },
  };
}

/**
 * The Server's client for the standby directive (ADR 0008 D9).
 *
 * Its own client rather than part of the update controller, for the same reason
 * the handoff has one: this is not a device-facing action. It is how the Server
 * being replaced learns that it should stop being the control plane without
 * being stopped, and how it reports that it has.
 */
export interface StandbyDirectiveClient {
  read(): Promise<StandbyDirectiveState | null>;
  acknowledge(operationId: string, state: StandbyDirective): Promise<boolean>;
}

export async function createStandbyDirectiveClient(
  socketPath: string = UPDATER_CONTROL_SOCKET,
): Promise<StandbyDirectiveClient | undefined> {
  const channel = await openControlChannel(socketPath);
  if (channel === undefined) return undefined;
  return {
    async read() {
      return readUpdaterStandby(await channel());
    },
    async acknowledge(operationId, state) {
      return acknowledgeUpdaterStandby({ ...(await channel()), operationId, state });
    },
  };
}
