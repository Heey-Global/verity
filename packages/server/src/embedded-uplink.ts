import type { EventStore, VeritySettingsRecord } from '@verity/store';
import type { ServerDeps } from './server-deps.js';
import { previewSharingCapability } from './preview-capability.js';
import { teamSharingStatus } from './uplink-feature-state.js';
import { applyPremiumFeatureSwitches } from './premium-feature-switches.js';
import type { DockerClient } from './docker.js';
import type { EmbeddedServerConfig } from './embedded-types.js';
import type { PreviewShareManager } from './preview-share-manager.js';
import {
  UplinkControlClient,
  premiumFeatureSwitches,
  type UplinkControlClientOptions,
} from './uplink-control-client.js';
import { CoordinatedRecordingManager } from './coordinated-recording.js';
import { ReturnPathActivation } from './remote-return-path-activation.js';
import { returnPathSelection } from './remote-return-path-diagnostics.js';
import { createRemoteConnectorPool, remoteDataUrlForControl } from './remote-control-connector.js';
import { createDeferredLogger } from './deferred-logger.js';

export function createEmbeddedUplink({
  config,
  eventStore,
  projectDocker,
  getPreviewShareManager,
}: {
  config: Pick<EmbeddedServerConfig, 'publicPreviews'>;
  eventStore: UplinkControlClientOptions['store'];
  projectDocker: DockerClient | undefined;
  getPreviewShareManager: () =>
    Pick<PreviewShareManager, 'disableAll' | 'finishExpiredByUplink'> | undefined;
}) {
  // Every line the Uplink client writes is conditional on this option being
  // present. Without it the handshake record, the close code and the refusal
  // reason are all no-ops, and a control channel that is being refused is
  // indistinguishable from one nobody configured - which is how an outage ran
  // for 13 days with no server-side trace of its cause. It cannot simply be
  // `app.log`: that does not exist yet here, and will not for another thousand
  // lines. Allocated whether or not a client is built, so the binding below
  // needs no second copy of the conditions that decide it.
  const uplinkLog = createDeferredLogger();
  const returnPath: ReturnPathActivation = new ReturnPathActivation(
    () => uplinkControl?.remoteControlDescriptor() ?? { enabled: false },
    returnPathSelection(process.env),
  );
  let coordinatedRecording: CoordinatedRecordingManager | undefined;
  const remoteConnector = config.publicPreviews?.remoteControl
    ? createRemoteConnectorPool({
        dataUrl: remoteDataUrlForControl(config.publicPreviews.uplinkUrl),
        ...config.publicPreviews.remoteControl,
        onReturnPathSnapshot: (snapshot) => coordinatedRecording?.observe(snapshot),
        returnPathExpiry: (sessionHash, connectorId): number | undefined =>
          returnPath.expiry(sessionHash, connectorId),
        returnPathInstallation: (): string | undefined => {
          const descriptor = uplinkControl?.remoteControlDescriptor();
          return descriptor?.enabled ? descriptor.installationId : undefined;
        },
        returnPathBeforeStopSubscribe: (listener) => returnPath.beforeStop(listener),
        returnPathSubscribe: (listener) => returnPath.subscribe(listener),
        log: uplinkLog,
      })
    : undefined;
  const uplinkControl =
    config.publicPreviews !== undefined && projectDocker !== undefined
      ? new UplinkControlClient({
          url: config.publicPreviews.uplinkUrl,
          // Team v1 is only used once the service selects it in welcome, and
          // only offered where an invited person can join through the Remote Control connector.
          offerTeam: remoteConnector !== undefined,
          admitTeamJoin: (pending, signal) =>
            eventStore.projectTeam.admitJoin({ ...pending, signal }),
          rollbackTeamJoin: (pending) => eventStore.projectTeam.rollbackJoinAdmission(pending),
          ...(config.publicPreviews.expectedInstallationId === undefined
            ? {}
            : { expectedInstallationId: config.publicPreviews.expectedInstallationId }),
          store: eventStore,
          serverVersion: config.publicPreviews.serverVersion,
          restoreShareIds: async () => {
            const previews = (await eventStore.listPublicPreviewShares())
              .filter((share) => share.state === 'active' && share.expiresAt.getTime() > Date.now())
              .map((share) => share.id);
            const meetings = await eventStore.listAttendeeState<{
              phase: string;
              binding?: { shareId: string; expiresAt: string };
            }>();
            return [
              ...previews,
              ...meetings
                .filter(
                  (row) =>
                    row.id.startsWith('meeting:') &&
                    row.state.phase !== 'ended' &&
                    row.state.binding &&
                    Date.parse(row.state.binding.expiresAt) > Date.now(),
                )
                .map((row) => row.state.binding!.shareId),
            ];
          },
          ...(remoteConnector === undefined
            ? {}
            : { offerRemoteControl: true, reserveRemoteConnector: remoteConnector.reserve }),
          log: uplinkLog,
          onFeaturesDisabled: (reason) =>
            getPreviewShareManager()?.disableAll(reason) ?? Promise.resolve(),
          onSharePinLocked: (shareId) => eventStore.lockPublicPreviewSharePin(shareId),
          onShareExpired: (shareId) =>
            getPreviewShareManager()?.finishExpiredByUplink(shareId) ?? Promise.resolve(),
        })
      : undefined;
  if (uplinkControl && remoteConnector) {
    coordinatedRecording = new CoordinatedRecordingManager(returnPath, {
      selectedConnectorId: (targetSessionId) =>
        uplinkControl.selectedRecordingConnectorId(targetSessionId),
      start: (runId, durationMs, version, targetSessionId) =>
        uplinkControl.startRecording(runId, durationMs, version, targetSessionId),
      status: (runId) => uplinkControl.recordingStatus(runId),
      stop: (runId) => uplinkControl.stopRecording(runId),
      export: (runId) => uplinkControl.exportRecording(runId),
    });
  }
  return { uplinkLog, returnPath, coordinatedRecording, remoteConnector, uplinkControl };
}

type EmbeddedUplink = ReturnType<typeof createEmbeddedUplink>;

export function createEmbeddedUplinkBindings(ctx: {
  eventStore: Pick<EventStore, 'getVeritySettings'>;
  uplinkControl: EmbeddedUplink['uplinkControl'];
  remoteConnector: EmbeddedUplink['remoteConnector'];
  returnPath: EmbeddedUplink['returnPath'];
  coordinatedRecording: EmbeddedUplink['coordinatedRecording'];
  previewShareManager: PreviewShareManager | undefined;
}): Pick<
  ServerDeps,
  | 'previewSharingCapability'
  | 'previewShareManager'
  | 'returnPathActivation'
  | 'coordinatedRecording'
  | 'returnPathConnectorCount'
  | 'remoteControlDescriptor'
  | 'uplinkDiagnostics'
  | 'onUplinkCredentialsChanged'
  | 'recheckUplink'
  | 'onPremiumFeatureSwitchesChanged'
  | 'attendeeEdge'
> {
  const {
    eventStore,
    uplinkControl,
    remoteConnector,
    returnPath,
    coordinatedRecording,
    previewShareManager,
  } = ctx;
  return {
    previewSharingCapability: async () => {
      const settings = await eventStore.getVeritySettings();
      return previewSharingCapability(
        uplinkControl?.canStartSharing() === true,
        Boolean(settings?.uplinkSubscriptionKey?.trim()),
        uplinkControl?.diagnostics(),
        settings === undefined || premiumFeatureSwitches(settings).sharing,
      );
    },
    ...(previewShareManager !== undefined ? { previewShareManager } : {}),
    returnPathActivation: returnPath,
    ...(coordinatedRecording ? { coordinatedRecording } : {}),
    returnPathConnectorCount: () => remoteConnector?.diagnosticConnectorCount() ?? 0,
    ...(uplinkControl !== undefined
      ? { remoteControlDescriptor: () => uplinkControl.remoteControlDescriptor() }
      : {}),
    ...(uplinkControl !== undefined
      ? {
          uplinkDiagnostics: () => ({
            ...uplinkControl.diagnostics(),
            ...(remoteConnector === undefined
              ? {}
              : { remoteStreams: remoteConnector.recentStreams() }),
          }),
        }
      : {}),
    ...(uplinkControl !== undefined
      ? {
          onUplinkCredentialsChanged: () => uplinkControl.refreshCredentials(),
          recheckUplink: () => uplinkControl.checkEntitlements(),
        }
      : {}),
    ...(uplinkControl !== undefined
      ? {
          onPremiumFeatureSwitchesChanged: (settings: VeritySettingsRecord) =>
            applyPremiumFeatureSwitches(settings, uplinkControl, previewShareManager),
        }
      : {}),
    ...(uplinkControl ? { attendeeEdge: uplinkControl } : {}),
  };
}

export function createEmbeddedTeamSharingBindings(ctx: {
  config: Pick<EmbeddedServerConfig, 'devicePairing'>;
  uplinkControl: EmbeddedUplink['uplinkControl'];
}): Pick<ServerDeps, 'teamLinkIdentity' | 'teamSharing'> {
  const { config, uplinkControl } = ctx;
  return {
    teamLinkIdentity: () => {
      const identity = config.devicePairing?.identity();
      const installation = uplinkControl?.teamInstallation();
      return identity && installation && { ...identity, ...installation };
    },
    teamSharing: teamSharingStatus(uplinkControl),
  };
}
