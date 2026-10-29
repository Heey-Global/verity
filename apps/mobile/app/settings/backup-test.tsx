// Test restore: the server reads the newest backup with the recovery key the
// operator pastes, without changing anything, and reports whether it worked.
// This is also how the operator learns that the key they saved is the right one.
import { type BackupProbeJob, type VerityClient } from '@verity/mobile';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  formatBackupTime,
  probeFailureText,
  probePhaseText,
  probeRunning,
} from '../../components/settings/backup/backupText';
import { useBackupStatus } from '../../components/settings/backup/useBackupStatus';
import {
  SettingsGroup,
  SettingsMessage,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import { Button, Group, HintBox, Row, StatusDot, Text, TextField } from '../../components/ui';
import { createVerityClient } from '../../lib/client';

const POLL_MS = 2000;

export default function BackupTestScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client)
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to manage backups."
        screenTitle="Test restore"
      />
    );
  return <BackupTestView client={client} />;
}

function BackupTestView({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const { state, reload } = useBackupStatus(client);
  const [key, setKey] = useState('');
  const [job, setJob] = useState<BackupProbeJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const status = state.kind === 'ready' && state.status.available ? state.status : undefined;
  // A test started elsewhere (or before leaving this screen) is picked up again.
  const current = job ?? status?.probe ?? null;
  const running = probeRunning(current);

  useEffect(() => {
    if (!running || current === null) return;
    const id = current.id;
    const timer = setInterval(() => {
      void client
        .getBackupProbe(id)
        .then((next) => {
          setJob(next);
          if (!probeRunning(next)) void reload();
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [client, running, current?.id, reload]);

  const start = (): void => {
    const recoveryKey = key.trim();
    if (recoveryKey.length === 0) return;
    setBusy(true);
    setError(undefined);
    // The key is sent once and never kept on this screen.
    setKey('');
    void client
      .startBackupProbe(recoveryKey)
      .then(setJob)
      .catch(() => setError('Could not start the test. Try again.'))
      .finally(() => setBusy(false));
  };
  const cancel = (): void => {
    if (current === null) return;
    setBusy(true);
    void client
      .cancelBackupProbe(current.id)
      .then(setJob)
      .catch(() => setError('Could not cancel the test.'))
      .finally(() => setBusy(false));
  };

  const failed =
    current !== null && !running && current.status !== 'succeeded' ? current : undefined;
  const banner = {
    error: error ?? (state.kind === 'error' ? state.message : undefined),
    saving: false,
  };

  return (
    <SettingsScaffold
      title="Test restore"
      detail
      state={banner}
      onRetry={() => void reload()}
      footer={
        running ? (
          <Button
            label="Cancel test"
            variant="secondary"
            loading={busy || current?.status === 'cancelling'}
            fullWidth
            onPress={cancel}
          />
        ) : (
          <Button
            label="Test restore"
            loading={busy}
            disabled={key.trim().length === 0 || status === undefined || !status.configured}
            fullWidth
            onPress={start}
          />
        )
      }
    >
      {state.kind === 'loading' ? <ActivityIndicator color={theme.colors.text} /> : null}
      {status?.lastProbe != null ? (
        <SettingsGroup title="Last test">
          <Group>
            <Row
              title="Backup works"
              subtitle={formatBackupTime(status.lastProbe.finishedAt)}
              trailing={<StatusDot intent="ready" label="Passed" />}
            />
          </Group>
        </SettingsGroup>
      ) : null}
      {running && current !== null ? (
        <SettingsGroup title="Running">
          <Group>
            <Row
              title={probePhaseText(current.phase).title}
              subtitle={probePhaseText(current.phase).step}
              trailing={<ActivityIndicator color={theme.colors.textMuted} />}
            />
          </Group>
        </SettingsGroup>
      ) : null}
      {failed !== undefined ? (
        <HintBox
          title={probeFailureText(failed).title}
          message={probeFailureText(failed).message}
        />
      ) : null}
      {!running ? (
        <SettingsGroup title={status?.lastProbe != null ? 'Test again' : 'Test now'}>
          <TextField
            label="Recovery key"
            value={key}
            onChangeText={setKey}
            placeholder="Paste your recovery key"
            secret
            disabled={busy}
          />
          <Text variant="footnote" tone="faint">
            Only enter this key on a server you trust. It is used for this test only and is not
            stored.
          </Text>
        </SettingsGroup>
      ) : null}
    </SettingsScaffold>
  );
}
