import type { GoogleAccount, VerityClient } from '@verity/mobile';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Text } from 'react-native';
import {
  SettingsScaffold,
  SettingsGroup,
  SettingsNavRow,
  SettingsPanel,
} from '../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../components/settings/settingsStyles';
import { createVerityClient } from '../../lib/client';
import { runGoogleAccountAuth } from '../../lib/googleDrive';
import { missingGoogleServices } from '../../lib/googleServices';
import { ConfirmSheet, TextField, Sheet, Button } from '../../components/ui';

export default function GoogleSettings() {
  const client = useMemo(() => createVerityClient(), []);
  return client ? (
    <GoogleSettingsContent client={client} />
  ) : (
    <SettingsScaffold title="Google" detail>
      <Text style={styles.pathLabel}>Connect to your server first.</Text>
    </SettingsScaffold>
  );
}
function GoogleSettingsContent({ client }: { client: VerityClient }) {
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [clientId, setClientId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [removing, setRemoving] = useState<GoogleAccount | null>(null);
  const [renaming, setRenaming] = useState<GoogleAccount | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = accounts.find((account) => account.id === selectedId) ?? null;
  const [name, setName] = useState('');
  const reload = useCallback(async () => {
    const [list, connection] = await Promise.all([
      client.listGoogleAccounts(),
      client.getGoogleDriveConnection(),
    ]);
    setAccounts(list);
    setClientId(connection.clientId);
  }, [client]);
  useEffect(() => {
    void reload().catch((error: unknown) => Alert.alert('Could not load Google', String(error)));
  }, [reload]);
  const perform = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await operation();
      await reload();
    } catch (error) {
      Alert.alert('Could not update Google account', String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  // One consent covers every service; Google keeps any the user deselects out of the grant.
  const connect = async (account?: GoogleAccount) =>
    perform(async () => {
      if (!clientId) throw new Error('Google sign-in is not configured on this server.');
      const auth = await runGoogleAccountAuth(clientId);
      if (auth.kind === 'cancelled') return;
      await client.connectGoogleAccount({
        code: auth.code,
        codeVerifier: auth.codeVerifier,
        redirectUri: auth.redirectUri,
        ...(account ? { accountId: account.id } : {}),
      });
    });
  const selectedMissing = selected ? missingGoogleServices(selected.scopes) : [];
  return (
    <SettingsScaffold title="Google" detail>
      <SettingsGroup
        title="Accounts"
        description="Add a Google account once, then choose in each project which account it uses. Chats can override project defaults."
      >
        {accounts.map((account) => {
          const missing = missingGoogleServices(account.scopes);
          return (
            <SettingsNavRow
              key={account.id}
              title={account.displayName ?? account.email}
              subtitle={
                missing.length
                  ? `Missing: ${missing.join(', ')}`
                  : account.displayName
                    ? account.email
                    : undefined
              }
              icon="user"
              status={
                missing.length
                  ? { intent: 'needsSetup', label: 'Incomplete' }
                  : { intent: 'ready', label: 'Full access' }
              }
              disabled={busy}
              onPress={() => setSelectedId(account.id)}
            />
          );
        })}
        <SettingsNavRow
          title="Add Google account"
          icon="plus"
          disabled={busy}
          onPress={() => void connect()}
        />
      </SettingsGroup>
      <Sheet
        visible={selected !== null}
        title={selected?.displayName ?? selected?.email ?? 'Google account'}
        onClose={() => setSelectedId(null)}
      >
        <Text style={styles.pathLabel}>{selected?.email}</Text>
        <Text style={styles.pathLabel}>
          {selectedMissing.length
            ? `Missing: ${selectedMissing.join(', ')}. Projects cannot use these services with this account.`
            : 'Full access to Drive, Gmail, Calendar, Contacts, and Docs, Sheets & Slides.'}
        </Text>
        <Text style={styles.pathLabel}>
          {selected?.projects.length
            ? `Used in: ${selected.projects.map((project) => project.name).join(', ')}`
            : 'Not used in any project yet'}
        </Text>
        <SettingsPanel>
          <SettingsNavRow
            title={selectedMissing.length ? 'Grant missing permissions' : 'Reconnect'}
            icon="link"
            disabled={busy}
            onPress={() => {
              if (!selected) return;
              setSelectedId(null);
              void connect(selected);
            }}
          />
          <SettingsNavRow
            title="Account name"
            subtitle={selected?.displayName ?? 'Optional, for example Personal or Work'}
            icon="edit-2"
            disabled={busy}
            onPress={() => {
              if (!selected) return;
              setName(selected.displayName ?? '');
              setSelectedId(null);
              setRenaming(selected);
            }}
          />
          <SettingsNavRow
            title="Disconnect account"
            icon="x"
            disabled={busy}
            onPress={() => {
              if (!selected) return;
              setSelectedId(null);
              setRemoving(selected);
            }}
          />
        </SettingsPanel>
      </Sheet>
      <Sheet visible={renaming !== null} title="Account name" onClose={() => setRenaming(null)}>
        <TextField
          label="Name"
          value={name}
          onChangeText={setName}
          placeholder="Personal or Work"
        />
        <Button
          label="Save"
          disabled={busy}
          onPress={() =>
            void perform(async () => {
              if (renaming) await client.renameGoogleAccount(renaming.id, name || null);
              setRenaming(null);
            })
          }
        />
      </Sheet>
      <ConfirmSheet
        visible={removing !== null}
        title="Disconnect Google account?"
        message={`Remove ${removing?.email ?? ''} from its projects and chats. Other accounts keep their access.${removing?.projects.length ? ` Used in: ${removing.projects.map((project) => project.name).join(', ')}.` : ''}`}
        confirmLabel="Disconnect"
        destructive
        onConfirm={() =>
          perform(async () => {
            if (removing) await client.removeGoogleAccount(removing.id);
            setRemoving(null);
          })
        }
        onCancel={() => setRemoving(null)}
      />
    </SettingsScaffold>
  );
}
