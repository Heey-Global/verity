// Backup: set up encrypted backups of this server and see whether they work.
// Setup is three steps on this one route — explain, show the recovery key once,
// success — and afterwards the route is the status page. Restoring a lost
// server stays with the installer (docs/INSTALLER_RECOVERY.md).
import {
  VerityApiError,
  type BackupKeyOffer,
  type BackupStatus,
  type VerityClient,
} from '@verity/mobile';
import { router, type Href } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Confetti } from '../../components/premium/Confetti';
import { RecoveryKeyStep, removeKeyFile } from '../../components/settings/backup/RecoveryKeyStep';
import {
  backupAlertText,
  backupStatusRows,
  formatBackupTime,
  formatInterval,
  DEFAULT_INTERVAL_MS,
} from '../../components/settings/backup/backupText';
import { useBackupStatus } from '../../components/settings/backup/useBackupStatus';
import {
  SettingsGroup,
  SettingsMessage,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import {
  Button,
  Card,
  CardHead,
  Group,
  HintBox,
  Row,
  SectionHeader,
  StatusDot,
  StatusTag,
  StepIntro,
  SuccessHero,
  Text,
} from '../../components/ui';
import { createVerityClient } from '../../lib/client';

type Available = Extract<BackupStatus, { available: true }>;
type Step = { kind: 'status' } | { kind: 'key'; offer: BackupKeyOffer } | { kind: 'success' };

export default function BackupScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client)
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to manage backups."
        screenTitle="Backup"
      />
    );
  return <BackupView client={client} />;
}

function BackupView({ client }: { client: VerityClient }) {
  const [step, setStep] = useState<Step>({ kind: 'status' });
  const [watching, setWatching] = useState(false);
  // The success step watches the first capture start and finish.
  const { state, reload } = useBackupStatus(client, { poll: watching });
  const firstDone =
    state.kind === 'ready' && state.status.available && state.status.lastSuccess != null;
  useEffect(() => {
    setWatching(step.kind === 'success' && !firstDone);
  }, [step.kind, firstDone]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // An offered key that was never confirmed is discarded on the server when the
  // operator leaves, so the next attempt starts over with a new key.
  const pending = useRef<BackupKeyOffer | null>(null);
  const left = useRef(false);
  useEffect(() => {
    left.current = false;
    removeKeyFile();
    return () => {
      left.current = true;
      if (pending.current !== null) void client.cancelBackupSetup().catch(() => undefined);
    };
  }, [client]);

  const begin = (): void => {
    setBusy(true);
    setError(undefined);
    void client
      .beginBackupSetup()
      .then((offer) => {
        // The operator left while the key was being generated.
        if (left.current) {
          void client.cancelBackupSetup().catch(() => undefined);
          return;
        }
        pending.current = offer;
        setStep({ kind: 'key', offer });
      })
      .catch(() => setError('Could not start the setup. Try again.'))
      .finally(() => setBusy(false));
  };
  const confirm = (offer: BackupKeyOffer): void => {
    setBusy(true);
    setError(undefined);
    // Leaving during confirmation must not cancel a key the server may already use.
    pending.current = null;
    void client
      .confirmBackupSetup(offer)
      .then(() => {
        setStep({ kind: 'success' });
        void reload();
      })
      .catch(async (failure: unknown) => {
        const after = await client.getBackupStatus().catch(() => undefined);
        const on = after?.available === true && after.configured;
        if (failure instanceof VerityApiError && failure.status === 410) {
          // This key was never used: it expired, or another device set up backups.
          setStep({ kind: 'status' });
          void reload();
          setError(
            on
              ? 'Backup was set up from another device. The key shown here was not used.'
              : 'The key expired before it was confirmed. Set up again to get a new key.',
          );
          return;
        }
        // Any other failure may be a reply lost after the server committed.
        if (on) {
          setStep({ kind: 'success' });
          void reload();
          return;
        }
        pending.current = offer;
        setError('Could not turn on backup. Try again.');
      })
      .finally(() => setBusy(false));
  };

  const banner = {
    error: error ?? (state.kind === 'error' ? state.message : undefined),
    saving: false,
  };
  const retry = (): void => {
    setError(undefined);
    void reload();
  };

  if (step.kind === 'key')
    return (
      <SettingsScaffold
        title="Backup"
        detail
        state={banner}
        footer={
          <Button
            label="I saved it, turn on backup"
            loading={busy}
            fullWidth
            onPress={() => confirm(step.offer)}
          />
        }
      >
        <RecoveryKeyStep recoveryKey={step.offer.recoveryKey} />
      </SettingsScaffold>
    );

  if (step.kind === 'success')
    return (
      <SettingsScaffold
        title="Backup"
        detail
        state={banner}
        footer={<Button label="Done" fullWidth onPress={() => setStep({ kind: 'status' })} />}
      >
        <SetupSuccess status={state.kind === 'ready' ? state.status : undefined} />
      </SettingsScaffold>
    );

  if (state.kind !== 'ready')
    return (
      <SettingsScaffold title="Backup" detail state={banner} onRetry={retry}>
        {state.kind === 'loading' ? <Loading /> : null}
      </SettingsScaffold>
    );

  const status = state.status;
  if (!status.available)
    return (
      <SettingsScaffold title="Backup" detail state={banner} onRetry={retry}>
        <Unavailable reason={status.reason} />
      </SettingsScaffold>
    );

  if (!status.configured)
    return (
      <SettingsScaffold
        title="Backup"
        detail
        state={banner}
        onRetry={retry}
        footer={
          <Button
            label="Set up backup"
            icon="hard-drive"
            loading={busy}
            fullWidth
            onPress={begin}
          />
        }
      >
        <SetupIntro />
      </SettingsScaffold>
    );

  return (
    <SettingsScaffold title="Backup" detail state={banner} onRetry={retry}>
      <BackupStatusView status={status} />
    </SettingsScaffold>
  );
}

function Loading() {
  const { theme } = useUnistyles();
  return <ActivityIndicator color={theme.colors.text} />;
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <Card stacked>
      <CardHead
        title={
          reason === 'installer-required' ? 'One-time server step needed' : 'Backup unavailable'
        }
        subtitle={
          reason === 'installer-required'
            ? 'This server was set up before backups existed. Run the Verity installer on the server once more.'
            : 'Backup is not working on this server right now. Check the server logs.'
        }
      />
    </Card>
  );
}

function SetupIntro() {
  return (
    <>
      <StepIntro
        headline="Your server,"
        accent="backed up."
        lead="Settings, projects, sessions and knowledge, saved automatically."
      />
      <View style={styles.stack}>
        <SectionHeader title="How it works" variant="eyebrow" />
        <Card flush>
          <Row
            leading={{ icon: 'clock' }}
            title="Every 6 hours"
            subtitle="You can change this later"
          />
        </Card>
        <Card flush>
          <Row
            leading={{ icon: 'lock', signature: true }}
            title="Encrypted"
            subtitle="Only your recovery key opens it"
          />
        </Card>
        <Card flush>
          <Row
            leading={{ icon: 'hard-drive' }}
            title="Stored on this server"
            subtitle="Copy the backup folder elsewhere to survive a broken disk"
          />
        </Card>
      </View>
    </>
  );
}

function SetupSuccess({ status }: { status: BackupStatus | undefined }) {
  const { theme } = useUnistyles();
  const interval =
    status?.available === true ? (status.intervalMs ?? DEFAULT_INTERVAL_MS) : DEFAULT_INTERVAL_MS;
  const done = status?.available === true && status.lastSuccess != null;
  return (
    <>
      <Confetti />
      <SuccessHero
        title="Backup activated"
        lead={`Your server is now backed up ${formatInterval(interval, 'long')}.`}
      />
      <Card flush>
        <Row
          title={done ? 'First backup finished' : 'First backup running'}
          subtitle={
            done
              ? 'From now on, only changes are saved.'
              : 'Takes a while the first time, then only changes. You can keep working.'
          }
          trailing={
            done ? (
              <StatusDot intent="ready" label="Done" />
            ) : (
              <ActivityIndicator color={theme.colors.textMuted} />
            )
          }
        />
      </Card>
    </>
  );
}

function BackupStatusView({ status }: { status: Available }) {
  const rows = backupStatusRows(status);
  return (
    <>
      {status.alerts.length > 0 ? <ProblemCard status={status} /> : null}
      <SettingsGroup title="Status">
        <Group>
          {rows.map((row) => (
            <Row
              key={row.title}
              title={row.title}
              trailing={
                row.title === 'Next backup' ? (
                  <Text variant="body" tone="muted">
                    {row.value}
                  </Text>
                ) : (
                  <StatusDot intent={row.intent} label={row.value} />
                )
              }
            />
          ))}
        </Group>
      </SettingsGroup>
      <SettingsGroup title="Actions">
        <Group>
          <Row
            leading={{ icon: 'check-square' }}
            title="Test restore"
            subtitle="Checks that your backup and key work"
            navigates
            onPress={() => router.push('/settings/backup-test' as Href)}
          />
        </Group>
      </SettingsGroup>
      <SettingsGroup title="More">
        <Group>
          <Row
            leading={{ icon: 'sliders' }}
            title="Options"
            subtitle="Schedule, pause, recovery key"
            navigates
            onPress={() => router.push('/settings/backup-options' as Href)}
          />
        </Group>
      </SettingsGroup>
    </>
  );
}

function ProblemCard({ status }: { status: Available }) {
  return (
    <Card stacked attention>
      <CardHead
        title="Backup"
        subtitle={
          status.lastSuccess != null
            ? `Last backup ${formatBackupTime(status.lastSuccess, Date.now(), { inline: true })}`
            : 'No backup yet'
        }
        trailing={<StatusTag intent="needsSetup" label="Needs attention" />}
      />
      {status.alerts.map((code) => {
        const text = backupAlertText(code);
        return <HintBox key={code} title={text.title} message={text.message} />;
      })}
      {status.alerts.includes('probe-overdue') ? (
        <Button
          label="Test restore"
          size="compact"
          onPress={() => router.push('/settings/backup-test' as Href)}
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.spacing.sm },
}));
