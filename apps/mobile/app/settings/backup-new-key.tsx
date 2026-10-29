// A new recovery key, reached from Backup options. Same key step as setup; the
// new key takes over only when the operator confirms they saved it, and leaving
// earlier discards it on the server so the current key stays in force.
import { type BackupKeyOffer, type VerityClient } from '@verity/mobile';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { RecoveryKeyStep } from '../../components/settings/backup/RecoveryKeyStep';
import { SettingsMessage, SettingsScaffold } from '../../components/settings/SettingsChrome';
import { Button, Card, CardHead, StatusDot } from '../../components/ui';
import { createVerityClient } from '../../lib/client';

export default function BackupNewKeyScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client)
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to manage backups."
        screenTitle="New recovery key"
      />
    );
  return <BackupNewKeyView client={client} />;
}

function BackupNewKeyView({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const [offer, setOffer] = useState<BackupKeyOffer | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const pending = useRef<BackupKeyOffer | null>(null);

  const begin = (): void => {
    setError(undefined);
    void client
      .beginBackupKeyReplacement()
      .then((next) => {
        pending.current = next;
        setOffer(next);
      })
      .catch(() => setError('Could not create a new key. Try again.'));
  };
  // Once per visit: a second offer would replace the key on screen, and the
  // server refuses overlapping requests.
  const started = useRef(false);
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      begin();
    }
    return () => {
      if (pending.current !== null) void client.cancelBackupKeyReplacement().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = (current: BackupKeyOffer): void => {
    setBusy(true);
    setError(undefined);
    void client
      .confirmBackupKeyReplacement(current)
      .then(() => {
        pending.current = null;
        setDone(true);
      })
      .catch(() => setError('Could not switch to the new key. Try again.'))
      .finally(() => setBusy(false));
  };

  const state = { error, saving: false };
  if (done)
    return (
      <SettingsScaffold
        title="New recovery key"
        detail
        state={state}
        footer={<Button label="Done" fullWidth onPress={() => router.back()} />}
      >
        <Card stacked>
          <CardHead
            title="New key is active"
            subtitle="New backups use it from now on. Older backups still open with your old key."
            trailing={<StatusDot intent="ready" label="Active" />}
          />
        </Card>
      </SettingsScaffold>
    );

  return (
    <SettingsScaffold
      title="New recovery key"
      detail
      state={state}
      onRetry={offer === null ? begin : undefined}
      footer={
        offer !== null ? (
          <Button
            label="I saved it, use the new key"
            loading={busy}
            fullWidth
            onPress={() => confirm(offer)}
          />
        ) : undefined
      }
    >
      {offer !== null ? (
        <RecoveryKeyStep recoveryKey={offer.recoveryKey} />
      ) : error === undefined ? (
        <ActivityIndicator color={theme.colors.text} />
      ) : null}
    </SettingsScaffold>
  );
}
