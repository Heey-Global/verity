import { type GithubAppValidateResult, type VerityClient } from '@verity/mobile';
import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { settingsStyles as styles } from './settings/settingsStyles';
import { Button } from './ui';

export function GithubPermissionNotice({ client }: { client: VerityClient }) {
  const [result, setResult] = useState<GithubAppValidateResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void client
      .validateGithubApp()
      .then((value) => {
        if (active) setResult(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [client]);
  const check = async () => {
    setBusy(true);
    setError(false);
    try {
      setResult(await client.validateGithubApp());
    } catch {
      setResult(undefined);
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const permission = result?.commitStatusPermission;
  const missing =
    permission?.state === 'app_update_required' || permission?.state === 'approval_required';
  const unknown = error || result?.ok === false || permission?.state === 'unknown';
  if (!missing && !unknown) return null;
  const appUpdate = permission?.state === 'app_update_required';
  return (
    <View>
      <Text style={styles.reproSubtitle} accessibilityRole="alert">
        {missing ? 'Complete CI checks' : 'Could not check commit-status access'}
      </Text>
      <Text style={styles.reproSubtitle}>
        {missing
          ? 'Verity needs Commit statuses: Read-only to read additional build and test results. Without it, CI checks may miss results. This permission does not allow changes to status messages.'
          : 'Your connection remains available. Retry to check whether GitHub has granted access to additional build and test results.'}
      </Text>
      {missing ? (
        <Text style={styles.reproSubtitle}>
          {appUpdate
            ? 'An App owner or manager must set Repository permissions → Commit statuses to Read-only and save. Then the installation owner must approve the new permission in GitHub.'
            : 'The installation owner must review and approve the new permission in GitHub. If you cannot manage this installation, ask its owner.'}
        </Text>
      ) : null}
      <View style={styles.actionRow}>
        {missing && permission.url ? (
          <Button
            label={appUpdate ? 'Enable permission in GitHub' : 'Approve new permission in GitHub'}
            variant="secondary"
            size="compact"
            onPress={() => {
              void Linking.openURL(permission.url!).catch(() => setError(true));
            }}
          />
        ) : null}
        <Button
          label={busy ? 'Checking…' : 'Check again'}
          disabled={busy}
          variant="secondary"
          size="compact"
          onPress={() => {
            void check();
          }}
        />
      </View>
      {missing && error ? (
        <Text style={styles.reproSubtitle}>Could not open GitHub. Try again.</Text>
      ) : null}
    </View>
  );
}
