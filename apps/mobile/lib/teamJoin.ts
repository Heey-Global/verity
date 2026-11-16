import { VerityApiError, VerityClient } from '@verity/mobile';
import { CryptoDigestAlgorithm, digest, getRandomBytes } from 'expo-crypto';
import { requireNativeModule } from 'expo-modules-core';

import { adoptStoredAuthToken, setAuthToken } from './authToken';
import { setVerityBaseUrl } from './client';
import { requestRemoteControlAdmission } from './remoteControlAdmission';
import {
  clearTeamJoinProgress,
  loadTeamJoinProgress,
  saveTeamJoinProgress,
  type TeamJoinProgress,
} from './teamJoinState';
import { deviceLabel } from './deviceLabel';
import { createPinnedFetch, verifyPairedIdentity } from './pinnedTransport';
import {
  activateServerProfile,
  getOtherServerProfiles,
  getServerProfile,
  type VerityServerProfile,
} from './serverProfile';
import { serverIdFor, TeamJoinLinkError, type TeamJoinLink } from './teamInvitationLink';
import { requestTeamJoinAdmission, TeamJoinAdmissionError } from './teamJoinAdmission';

function randomId(): string {
  let binary = '';
  for (const byte of getRandomBytes(32)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** A dedicated attachment that leaves the active server transport intact. */
interface JoinTunnel {
  start(
    dataUrl: string,
    ticket: string,
    sessionId: string,
    coreUrl: string,
    capability: 'team-bootstrap-v1' | 'remote-control-v1',
  ): Promise<number>;
  stop(): Promise<void>;
}

export interface JoinTeamDeps {
  admission?: typeof requestTeamJoinAdmission;
  tunnel?: () => JoinTunnel;
  signal?: AbortSignal;
  onPhase?: (phase: 'saving' | 'confirming') => void;
}

export class TeamJoinError extends Error {
  constructor(
    readonly reason: 'unavailable' | 'known_server' | 'identity' | 'incompatible',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Join the project of an invitation (ADR 0023 §7). The app reserves the join at
 * Uplink, which opens a tunnel to the server once the server accepted it, so
 * the inviter's server is reachable from any network. The server is trusted
 * only through the link's pinned TLS key and signed identity, exactly as
 * pairing does; neither Uplink nor the link's own claims prove anything. The
 * redemption is the one Uplink minted for this tunnel; the app never makes one.
 */
let joiningInProgress = false;
export async function joinTeam(
  link: TeamJoinLink,
  displayName: string,
  deps: JoinTeamDeps = {},
): Promise<{ projectId: string }> {
  if (joiningInProgress) throw new Error('A join is already running.');
  joiningInProgress = true;
  try {
    return await joinTeamAttempt(link, displayName, deps);
  } finally {
    joiningInProgress = false;
  }
}

async function joinTeamAttempt(
  link: TeamJoinLink,
  displayName: string,
  deps: JoinTeamDeps = {},
): Promise<{ projectId: string }> {
  const saved = await loadTeamJoinProgress();
  if (saved !== null && saved.link.invitationId !== link.invitationId)
    throw new Error('Finish the saved join before opening another invitation.');
  if (saved !== null) link = saved.link;
  if (saved?.credential === undefined && link.expiresAt <= Date.now())
    throw new TeamJoinLinkError('expired');
  // A server this app already uses keeps its own credential; a second one for
  // the same server would sign this device in as someone else.
  const known = [getServerProfile(), ...getOtherServerProfiles()];
  if (
    saved?.credential === undefined &&
    known.some((profile) => profile?.serverId === link.serverId)
  ) {
    throw new TeamJoinError('known_server', 'This app is already connected to this server.');
  }
  // Credentials are kept per address: a link naming the address of another
  // server this app uses would overwrite that server's credential.
  if (
    saved?.credential === undefined &&
    known.some((profile) =>
      profile?.endpoints?.some((endpoint) => endpoint.url === link.coreOrigin),
    )
  ) {
    throw new TeamJoinLinkError('invalid');
  }
  const derived = await serverIdFor(link.identityKey, (bytes) =>
    digest(CryptoDigestAlgorithm.SHA256, bytes),
  );
  if (derived !== link.serverId) throw new TeamJoinLinkError('invalid');

  if (
    known.filter(Boolean).length >= 16 &&
    !known.some((profile) => profile?.serverId === link.serverId)
  )
    throw new Error('This app knows too many servers.');
  const tunnel = (deps.tunnel ?? nativeJoinTunnel)();
  const controller = new AbortController();
  const abort = () => controller.abort();
  deps.signal?.addEventListener('abort', abort, { once: true });
  if (deps.signal?.aborted) controller.abort();
  const deadline = setTimeout(abort, 90_000);
  try {
    const requestedAt = Date.now();
    let progress = saved;
    let admission;
    try {
      admission =
        saved !== null
          ? { ...saved.admission, finish() {} }
          : await (deps.admission ?? requestTeamJoinAdmission)({
              uplinkOrigin: link.uplinkOrigin,
              installationHandle: link.installationHandle,
              invitationId: link.invitationId,
              signal: controller.signal,
            });
    } catch (error) {
      // Unknown, cancelled, expired and used invitations all read the same.
      if (error instanceof TeamJoinAdmissionError && error.code === 'unavailable')
        throw new TeamJoinError('unavailable', 'This invitation can no longer be used.');
      throw error;
    }
    if (progress === null) {
      progress = {
        version: 1,
        // The attachment ticket is short-lived; reattachment retains the original
        // ten-minute redemption window, conservatively measured before reservation.
        recoveryExpiresAt: Math.min(link.expiresAt, requestedAt + 10 * 60_000),
        link,
        displayName: displayName.trim(),
        admission: {
          sessionId: admission.sessionId,
          redemptionId: admission.redemptionId,
          ticket: admission.ticket,
          expiresAt: admission.expiresAt,
        },
      };
      try {
        await saveTeamJoinProgress(progress);
      } catch (error) {
        admission.finish();
        throw error;
      }
    }
    const dataUrl = new URL(link.uplinkOrigin);
    dataUrl.protocol = 'wss:';
    dataUrl.pathname = '/data';
    let joined = progress.credential;
    const recoveryExpiresAt = progress.recoveryExpiresAt ?? progress.admission.expiresAt;
    const useDirect = joined !== undefined && recoveryExpiresAt <= Date.now();
    try {
      // Recovery never redeems an invitation after the device credential was saved.
      if (joined !== undefined) {
        if (recoveryExpiresAt > Date.now()) {
          admission = await (deps.admission ?? requestTeamJoinAdmission)({
            uplinkOrigin: link.uplinkOrigin,
            installationHandle: link.installationHandle,
            invitationId: link.invitationId,
            redemptionId: progress.admission.redemptionId,
            signal: controller.signal,
          });
        }
      } else if (
        Math.min(link.expiresAt, saved === null ? admission.expiresAt : recoveryExpiresAt) <=
        Date.now()
      ) {
        await clearTeamJoinProgress();
        throw new TeamJoinError(
          'unavailable',
          'This invitation can no longer be used. Ask for a new invitation.',
        );
      }
      if (saved !== null && joined === undefined) {
        admission = await (deps.admission ?? requestTeamJoinAdmission)({
          uplinkOrigin: link.uplinkOrigin,
          installationHandle: link.installationHandle,
          invitationId: link.invitationId,
          redemptionId: progress.admission.redemptionId,
          signal: controller.signal,
        });
      }
      controller.signal.throwIfAborted();
      const attach = async (
        ticket: string,
        sessionId: string,
        capability: 'team-bootstrap-v1' | 'remote-control-v1',
      ) => {
        const starting = tunnel.start(dataUrl.href, ticket, sessionId, link.coreOrigin, capability);
        void starting.then(
          () => {
            if (controller.signal.aborted) void tunnel.stop().catch(() => undefined);
          },
          () => undefined,
        );
        const port = await bounded(starting, controller.signal);
        if (!Number.isInteger(port) || port < 1 || port > 65_535)
          throw new Error('The join tunnel did not open.');
        return port;
      };
      const port = useDirect
        ? undefined
        : await attach(admission.ticket, admission.sessionId, 'team-bootstrap-v1');
      admission.finish();
      let transport = createPinnedFetch(link.tlsPin, false, port);
      let fallbackAvailable = useDirect;
      const pinnedFetch: typeof transport = async (input, init) => {
        try {
          return await transport(input, { ...init, signal: controller.signal });
        } catch (error) {
          if (!fallbackAvailable || controller.signal.aborted) throw error;
          fallbackAvailable = false;
          const remote = await requestRemoteControlAdmission({
            uplinkOrigin: link.uplinkOrigin,
            installationHandle: link.installationHandle,
            signal: controller.signal,
          });
          try {
            transport = createPinnedFetch(
              link.tlsPin,
              false,
              await attach(remote.ticket, remote.sessionId, 'remote-control-v1'),
            );
          } finally {
            remote.finish();
          }
          return transport(input, { ...init, signal: controller.signal });
        }
      };
      const client = new VerityClient({
        baseUrl: link.coreOrigin,
        fetch: pinnedFetch,
        uploadFetch: pinnedFetch,
        getToken: () => joined?.token ?? null,
      });
      const challenge = randomId();
      const identity = await client.fetchPairingIdentity(challenge);
      if (identity.identityKey !== link.identityKey)
        throw new TeamJoinError('identity', 'The server is not the one that sent this invitation.');
      await verifyPairedIdentity({
        identityKey: link.identityKey,
        expectedServerId: link.serverId,
        serverId: identity.serverId,
        challenge,
        signature: identity.signature,
      });
      try {
        await client.people.teamJoinCapabilities();
      } catch {
        throw new TeamJoinError(
          'incompatible',
          'This server needs an update before this app can safely join.',
        );
      }
      if (joined === undefined) {
        const request = {
          invitationId: link.invitationId,
          secret: link.secret,
          redemptionId: progress.admission.redemptionId,
          displayName: progress.displayName,
          deviceLabel: deviceLabel(),
        };
        try {
          try {
            joined = await client.joinTeam(request);
          } catch (error) {
            if (error instanceof VerityApiError || controller.signal.aborted) throw error;
            if (
              Math.min(link.expiresAt, saved === null ? admission.expiresAt : recoveryExpiresAt) <=
              Date.now()
            )
              throw error;
            joined = await client.joinTeam(request);
          }
          deps.onPhase?.('saving');
          progress = {
            ...progress,
            link: { ...progress.link, secret: '' },
            credential: joined,
            admission: {
              ...progress.admission,
              expiresAt:
                'completionExpiresAt' in joined
                  ? Number(joined.completionExpiresAt)
                  : progress.admission.expiresAt,
            },
          };
          await saveTeamJoinProgress(progress);
        } catch (error) {
          if (error instanceof VerityApiError && error.status === 410) {
            await clearTeamJoinProgress();
            throw new TeamJoinError('unavailable', 'This invitation can no longer be used.');
          }
          throw error;
        }
      }
      deps.onPhase?.('confirming');
      let confirmed = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        controller.signal.throwIfAborted();
        try {
          const result = await client.people.completeTeamJoin();
          if (result.projectId !== joined.projectId)
            throw new TeamJoinError('identity', 'The server returned a different project.');
          if (result.confirmed) {
            confirmed = true;
            break;
          }
        } catch (error) {
          if (error instanceof VerityApiError && error.status === 410) {
            await clearTeamJoinProgress();
            throw new TeamJoinError(
              'unavailable',
              'This join can no longer be completed. Ask for a new invitation.',
            );
          }
          if (error instanceof TeamJoinError || error instanceof VerityApiError || attempt === 11)
            throw error;
        }
        await bounded(new Promise<void>((resolve) => setTimeout(resolve, 1500)), controller.signal);
      }
      if (!confirmed)
        throw new Error('Membership is not confirmed yet. Your access is saved; try again.');
    } finally {
      admission.finish();
      await tunnel.stop().catch(() => undefined);
    }
    controller.signal.throwIfAborted();
    if (joined === undefined) throw new Error('No saved device credential.');

    if (!(await setAuthToken(link.coreOrigin, joined.token, joined.tokenId, false)))
      throw new Error('Could not save the device credential. Open the invitation again.');
    controller.signal.throwIfAborted();
    const profile: VerityServerProfile = {
      version: 1,
      serverId: link.serverId,
      identityKey: link.identityKey,
      activeUrl: link.coreOrigin,
      endpoints: [{ url: link.coreOrigin, transport: 'direct', tlsPin: link.tlsPin }],
      remoteControl: {
        version: 1,
        installationId: link.installationId,
        installationHandle: link.installationHandle,
        uplinkOrigin: link.uplinkOrigin,
      },
      ...(link.display === undefined ? {} : { sharedBy: link.display.inviterName }),
    };
    // The server used so far stays known, so the app can switch back to it.
    await activateServerProfile(profile, controller.signal);
    controller.signal.throwIfAborted();
    adoptStoredAuthToken(link.coreOrigin, joined.token, joined.tokenId);
    await setVerityBaseUrl(link.coreOrigin);
    await clearTeamJoinProgress().catch(() => undefined);
    return { projectId: joined.projectId };
  } finally {
    clearTimeout(deadline);
    deps.signal?.removeEventListener('abort', abort);
  }
}

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Join interrupted. Saved progress can be continued.'));
    signal.addEventListener('abort', abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => undefined);
  });
}

export async function resumeTeamJoin(deps: JoinTeamDeps = {}): Promise<{ projectId: string }> {
  const progress = await loadTeamJoinProgress();
  if (progress === null) throw new Error('No saved join. Open a new invitation.');
  return joinTeam(progress.link, progress.displayName, deps);
}

function nativeJoinTunnel(): JoinTunnel {
  const native = requireNativeModule<{
    startJoin?: (
      url: string,
      ticket: string,
      sessionId: string,
      core: string,
      capability: string,
    ) => Promise<number>;
    stopJoin?: (sessionId: string) => Promise<void>;
  }>('VerityRemoteControlTunnel');
  if (!native.startJoin || !native.stopJoin)
    throw new TeamJoinError('incompatible', 'Update this app before joining a project.');
  let session = '';
  return {
    start: (url, ticket, sessionId, core, capability) => {
      session = sessionId;
      return native.startJoin!(url, ticket, sessionId, core, capability);
    },
    stop: () => native.stopJoin!(session),
  };
}
