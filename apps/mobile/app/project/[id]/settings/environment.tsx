// Environment — the project's runtime: run state + one state-driven lifecycle
// action, plus a slim update affordance when the sandbox image has one. No raw
// container/Docker jargon; destructive removal lives on the settings index, not
// here. The project counterpart of the Verity Maintenance screen.
import {
  VerityApiError,
  PROJECT_IMAGE_REBUILDING_WARNING,
  projectBadge,
  REBUILDING_PROJECT_BADGE,
  isSecuritySandboxUpdate,
  sandboxUpdateSummary,
  usesDevcontainerImage,
  type ProjectRecord,
  type VerityClient,
} from '@verity/mobile';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  SettingsGroup,
  SettingsMessage,
  SettingsPanel,
  SettingsScaffold,
} from '../../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../../components/settings/settingsStyles';
import { StatusPill, type StatusPillIntent } from '../../../../components/StatusPill';
import { createVerityClient } from '../../../../lib/client';
import { repairProject } from '../../../../lib/projectRepair';
import { toolkitDriftNotice } from '../../../../lib/projectSetup';
import { projectIdParam, useProjectDetail } from '../../../../lib/useProjectDetail';

export default function ProjectEnvironmentScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const client = useMemo(() => createVerityClient(), []);
  if (!client || projectId.length === 0) {
    return (
      <SettingsMessage
        title="Project unavailable"
        subtitle="This project could not be opened. Go back and pick it again."
        screenTitle="Environment"
      />
    );
  }
  return <ProjectEnvironmentView client={client} projectId={projectId} />;
}

function ProjectEnvironmentView({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string;
}) {
  const { theme } = useUnistyles();
  const { detail, loading, error, load, onProjectUpdated } = useProjectDetail(client, projectId);

  if (loading && detail === undefined) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.setup.text} />
      </View>
    );
  }
  if (detail === undefined) {
    return (
      <SettingsMessage
        title="Couldn't load project"
        subtitle={error ?? 'Unknown error'}
        screenTitle="Environment"
        onRetry={() => load()}
      />
    );
  }
  return (
    <SettingsScaffold
      title="Environment"
      detail
      state={{ error, saving: false }}
      onRetry={() => load()}
    >
      <EnvironmentSection
        client={client}
        project={detail.project}
        onUpdated={onProjectUpdated}
        onReload={() => void load(true)}
      />
    </SettingsScaffold>
  );
}

function sandboxRefLabel(
  ref: string | null | undefined,
  version?: string | null,
  revision?: string | null,
): string | null {
  const normalizedVersion = normalizeImageVersion(version);
  const shortRevision = shortSha(revision);
  if (normalizedVersion && shortRevision) return `${normalizedVersion} · ${shortRevision}`;
  if (normalizedVersion) return normalizedVersion;
  if (shortRevision) return shortRevision;
  if (!ref) return null;
  if (ref.includes('/dev-base')) return 'Legacy base';
  const tag = ref.match(/:([0-9]+(?:\.[0-9]+){1,3}(?:[-.][A-Za-z0-9]+)*)$/)?.[1];
  if (tag !== undefined) return `v${tag}`;
  const digest = shortDigest(ref);
  if (digest) return digest;
  if (ref.endsWith(':latest')) return 'Unpinned sandbox';
  return ref;
}

function normalizeImageVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  const trimmed = version.trim();
  if (trimmed.length === 0) return null;
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

function shortSha(revision: string | null | undefined): string | null {
  if (!revision) return null;
  const trimmed = revision.trim();
  return /^[0-9a-f]{7,}$/i.test(trimmed) ? trimmed.slice(0, 7) : trimmed || null;
}

function shortDigest(ref: string): string | null {
  const match = ref.match(/(?:@|^)sha256:([0-9a-f]{12,})/i);
  return match ? `sha256:${match[1].slice(0, 12)}` : null;
}

function EnvironmentSection({
  client,
  project,
  onUpdated,
  onReload,
}: {
  client: VerityClient;
  project: ProjectRecord;
  onUpdated: (project: ProjectRecord) => void;
  onReload: () => void;
}) {
  const [working, setWorking] = useState<'start' | 'pause' | 'update' | 'rebuild' | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const recoveryGeneration = useRef(0);
  const awaitingDurableCompletion = useRef(false);
  // Whether the server understands `forceRebuild`. Asked once when the panel
  // mounts — the answer only changes when the server is redeployed, and a stale
  // `false` costs a hidden button rather than a rebuild that silently did
  // nothing (see `healthSchema.imageRebuildSupported`).
  const [rebuildSupported, setRebuildSupported] = useState(false);

  useEffect(() => {
    let active = true;
    void client
      .getHealth()
      .then((health) => {
        if (active) setRebuildSupported(health.imageRebuildSupported === true);
      })
      .catch(() => {
        if (active) setRebuildSupported(false);
      });
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(
    () => () => {
      recoveryGeneration.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (
      awaitingDurableCompletion.current &&
      project.state !== 'cloning' &&
      project.state !== 'container_starting' &&
      project.provisionWarning !== PROJECT_IMAGE_REBUILDING_WARNING
    ) {
      awaitingDurableCompletion.current = false;
      setWorking(undefined);
    }
  }, [project.provisionWarning, project.state]);

  const running = project.state === 'active';
  const stopped = project.state === 'absent';
  const failed = project.state === 'failed';
  const starting = project.state === 'container_starting';
  const update = project.sandboxUpdate;
  // Null exactly when there is no pending update, so it gates the update row as
  // well as labelling it — one source of truth instead of a boolean that has to
  // stay in agreement with the summary next to it.
  const updateSummary = sandboxUpdateSummary(update);
  const driftNotice = toolkitDriftNotice(project);

  // Same descriptor the overview dot uses, so both surfaces name the container
  // state identically — and so the pill never leaks a raw state id like
  // `container_starting`, which it did for every transitional state.
  const badge = projectBadge(project);
  const rebuilding =
    working === 'rebuild' ||
    (project.provisionWarning != null &&
      project.provisionWarning === PROJECT_IMAGE_REBUILDING_WARNING);
  // `working === 'rebuild'` is optimistic local state the badge cannot see, so it
  // borrows the badge's own rebuild wording rather than keeping a third copy of
  // it — this pill used to say "Rebuilding…" next to an overview row saying
  // "Rebuilding secure workspace…" about the same container.
  const statusLabel = rebuilding ? REBUILDING_PROJECT_BADGE.label : badge.label;
  // `pulsing` is the badge's own "Verity is working on this", and a transient
  // pill is how this screen says it. Without it a running project mid-update read
  // as a settled green "ready" while its label said it was updating.
  const statusIntent: StatusPillIntent =
    rebuilding || badge.pulsing
      ? 'transient'
      : running
        ? 'ready'
        : badge.needsRepair
          ? 'needsSetup'
          : 'optional';

  // Start / Repair: (re)provision the environment. Preserves the sealed-secret
  // redirect and the server-warning confirmation from the old Reprovision path.
  const start = useCallback(() => {
    if (working !== undefined) return;
    setWorking('start');
    setError(undefined);
    void repairProject({
      client,
      projectId: project.id,
      returnTo: `/project/${project.id}/settings/environment`,
      onUpdated,
      onError: setError,
    }).finally(() => setWorking(undefined));
  }, [client, onUpdated, project.id, working]);

  // Pause: stop and remove the environment but keep the local clone for next start.
  const pause = useCallback(() => {
    if (working !== undefined) return;
    Alert.alert(
      'Pause project?',
      'This stops the project environment. Your local files stay, so you can start it again anytime.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Pause',
          onPress: () => {
            setWorking('pause');
            setError(undefined);
            void client
              .deprovisionProject(project.id, { purge: false })
              .then(onUpdated)
              .catch((caught) => {
                setError(
                  caught instanceof VerityApiError ? caught.message : 'Could not pause project',
                );
              })
              .finally(() => setWorking(undefined));
          },
        },
      ],
    );
  }, [client, onUpdated, project.id, working]);

  // Both container-replacing actions run the same request and differ only in
  // whether the image is rebuilt, so they share one driver — including the
  // dropped-request recovery, which a rebuild needs MORE than an update does:
  // a `--no-cache` build is minutes long and the more likely of the two to
  // outlive the request that started it.
  const recreate = useCallback(
    (forceRebuild: boolean, failureMessage: string) => {
      const generation = ++recoveryGeneration.current;
      let keepWorkingAfterRecovery = false;
      setWorking(forceRebuild ? 'rebuild' : 'update');
      setError(undefined);
      void client
        .recreateProjectContainer(project.id, { confirmWarnings: true, forceRebuild })
        .then(() => {
          if (recoveryGeneration.current === generation) onReload();
        })
        .catch(async (caught) => {
          if (!(caught instanceof VerityApiError)) {
            try {
              // A cacheless build can outlive the HTTP request. Keep the action
              // disabled while the server still reports its transitional state,
              // then surface the actual completed/failed project record.
              let sawTransitionalState = false;
              const recoveryAttempts = forceRebuild ? 450 : 150;
              for (let attempt = 0; attempt < recoveryAttempts; attempt += 1) {
                if (recoveryGeneration.current !== generation) return;
                const next = await client.getProject(project.id);
                onUpdated(next.project);
                const transitional =
                  next.project.state === 'cloning' ||
                  next.project.state === 'container_starting' ||
                  next.project.provisionWarning === PROJECT_IMAGE_REBUILDING_WARNING;
                if (transitional) sawTransitionalState = true;
                const terminalChanged =
                  (next.project.stateChangedAt !== undefined &&
                    next.project.stateChangedAt !== project.stateChangedAt) ||
                  next.project.provisionError !== project.provisionError ||
                  next.project.provisionWarning !== project.provisionWarning;
                if ((sawTransitionalState || terminalChanged) && !transitional) {
                  if (next.project.provisionWarning !== project.provisionWarning) {
                    setError(next.project.provisionWarning ?? failureMessage);
                  } else if (next.project.provisionError) {
                    setError(next.project.provisionError);
                  }
                  onReload();
                  return;
                }
                // A request that never reached the server leaves the original
                // terminal state untouched. Do not turn that into a false
                // success; allow a short window for the server's state write,
                // then surface the original transport error.
                if (!sawTransitionalState && attempt >= (forceRebuild ? 449 : 59)) break;
                await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
              }
              if (!sawTransitionalState) throw new Error('request did not reach the server');
              awaitingDurableCompletion.current = true;
              keepWorkingAfterRecovery = true;
              setError(
                `${forceRebuild ? 'Rebuild' : 'Update'} is still running. Status updates will continue automatically.`,
              );
              return;
            } catch {
              // Fall through to the visible error below only when the recheck
              // also fails; a dropped long-running request can still complete
              // server-side.
            }
          }
          if (recoveryGeneration.current === generation) {
            setError(caught instanceof VerityApiError ? caught.message : failureMessage);
          }
        })
        .finally(() => {
          if (recoveryGeneration.current === generation && !keepWorkingAfterRecovery) {
            setWorking(undefined);
          }
        });
    },
    [
      client,
      onReload,
      onUpdated,
      project.id,
      project.provisionError,
      project.provisionWarning,
      project.stateChangedAt,
    ],
  );

  const runUpdate = useCallback(() => {
    if (!updateSummary || working !== undefined) return;
    const blocked = update?.turnBlocked === true;
    Alert.alert(
      blocked ? 'Update waiting for a turn' : 'Update project?',
      blocked
        ? 'A turn is running in this project. Recreating the environment now would end it — cancel the turn first, then update.'
        : isSecuritySandboxUpdate(update)
          ? 'This recreates the project environment and applies the pending security update.'
          : 'This recreates the project environment and applies the pending update.',
      // No Update button while a turn holds the update off, and not out of
      // caution: the Server refuses this recreate for as long as the turn runs
      // (SBX-1), so the button could only ever produce the 409 the message just
      // explained. An action that cannot be taken is worse than none — it invites
      // the operator to read the refusal as a fault.
      blocked
        ? [{ text: 'OK', style: 'cancel' }]
        : [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Update', onPress: () => recreate(false, 'Could not update project') },
          ],
    );
  }, [recreate, update, updateSummary, working]);

  // Rebuild image: the escape hatch for a devcontainer change the image cache
  // cannot see. Verity caches the built image under a content hash over the
  // `.devcontainer/` directory, so a change to a Dockerfile or build context
  // OUTSIDE it — or to anything a build step fetches at build time — leaves the
  // hash, and therefore the cached image, exactly as it was. Update and Repair
  // both reuse it; this discards it.
  const rebuild = useCallback(() => {
    if (working !== undefined) return;
    Alert.alert(
      'Rebuild image?',
      'This rebuilds the project image from the repository devcontainer without the build cache, then recreates the environment. It can take several minutes.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Rebuild', onPress: () => recreate(true, 'Could not rebuild project image') },
      ],
    );
  }, [recreate, working]);

  // Only a project on a BUILT image has a build to redo, and the server rejects
  // a recreate for a paused or mid-provision project — so the button is absent
  // rather than present-and-failing in those states.
  //
  // `imageRef` names the image of the last SUCCESSFUL provision and is left
  // untouched when one fails, so a project that built once and now fails — the
  // canonical reason to want `--no-cache` — still shows the action. A project
  // that has never provisioned successfully has no `imageRef` and no cached
  // derived image either, so its ordinary Repair already rebuilds.
  const canRebuild =
    rebuildSupported && usesDevcontainerImage(project.imageRef) && (running || failed);

  // One primary action, chosen by run state. Unknown/transient states disable it.
  const primary = running
    ? {
        label: 'Pause',
        busyLabel: 'Pausing…',
        run: pause,
        busy: working === 'pause',
        enabled: true,
      }
    : failed || starting
      ? {
          label: 'Repair',
          busyLabel: 'Repairing…',
          run: start,
          busy: working === 'start',
          enabled: true,
        }
      : {
          label: 'Start',
          busyLabel: 'Starting…',
          run: start,
          busy: working === 'start',
          enabled: stopped,
        };

  return (
    <>
      <SettingsGroup
        title="Secure workspace"
        trailing={
          <View style={styles.sectionHeaderRow}>
            {working && !rebuilding ? <ActivityIndicator size="small" /> : null}
            <StatusPill intent={statusIntent} label={statusLabel} />
          </View>
        }
      >
        <SettingsPanel>
          <Text style={styles.reproSubtitle}>
            {running
              ? 'Sessions run inside this workspace. Pausing stops it; your files stay.'
              : failed
                ? (project.provisionError ??
                  'The last provisioning attempt failed. Repair rebuilds the workspace.')
                : starting
                  ? 'The workspace is starting. Repair restarts provisioning if it stalls.'
                  : 'The workspace is stopped. Starting it provisions the container again.'}
          </Text>
          <Pressable
            style={({ pressed }) => [
              styles.primaryButton,
              styles.selfStart,
              !primary.enabled || working ? styles.buttonDisabled : null,
              pressed ? styles.pressed : null,
            ]}
            onPress={primary.run}
            disabled={!primary.enabled || working !== undefined}
            accessibilityRole="button"
            accessibilityLabel={`${primary.label} project`}
          >
            <Text style={styles.primaryButtonLabel}>
              {primary.busy ? primary.busyLabel : primary.label}
            </Text>
          </Pressable>
          {/* Both notices live beside Start/Repair/Update rather than on a facts
              list somewhere else: they describe the environment, and the actions
              that answer them are right here. */}
          {project.provisionWarning ? (
            <Text style={styles.footnote}>{project.provisionWarning}</Text>
          ) : null}
          {driftNotice ? <Text style={styles.footnote}>{driftNotice}</Text> : null}
          {error ? <Text style={styles.fieldError}>{error}</Text> : null}
        </SettingsPanel>
      </SettingsGroup>

      {updateSummary ? (
        <SettingsGroup title="Update">
          <SettingsPanel>
            <View style={styles.serviceStatusRow}>
              <Text style={styles.serviceStatusLabel}>{updateSummary}</Text>
              <Text style={styles.reproStatus}>
                {sandboxRefLabel(update?.target, update?.targetVersion, update?.targetRevision) ??
                  'available'}
              </Text>
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.reproButton,
                working ? styles.buttonDisabled : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={runUpdate}
              disabled={working !== undefined}
              accessibilityRole="button"
              accessibilityLabel="Update project environment"
            >
              <Text style={styles.reproButtonLabel}>
                {working === 'update' ? 'Updating…' : 'Update'}
              </Text>
            </Pressable>
          </SettingsPanel>
        </SettingsGroup>
      ) : null}

      {canRebuild ? (
        <SettingsGroup title="Image">
          <SettingsPanel>
            <Text style={styles.reproSubtitle}>
              Rebuild the project image from the repository devcontainer without the build cache,
              for a change the cached image cannot see.
            </Text>
            <Pressable
              style={({ pressed }) => [
                styles.reproButton,
                working ? styles.buttonDisabled : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={rebuild}
              disabled={working !== undefined}
              accessibilityRole="button"
              accessibilityLabel="Rebuild project image"
            >
              <Text style={styles.reproButtonLabel}>
                {working === 'rebuild' ? 'Rebuilding…' : 'Rebuild image'}
              </Text>
            </Pressable>
          </SettingsPanel>
        </SettingsGroup>
      ) : null}
    </>
  );
}
