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
import {
  runGoogleDriveAuth,
  runGmailAuth,
  runCalendarAuth,
  runContactsAuth,
  runGoogleWorkspaceAuth,
} from '../../lib/googleDrive';
import { ConfirmSheet, TextField, Sheet, Button } from '../../components/ui';

type Service = 'Drive' | 'Gmail' | 'Calendar' | 'Contacts' | 'Docs, Sheets & Slides';
const services: [Service, string[]][] = [
  ['Drive', ['drive']],
  ['Gmail', ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic']],
  ['Calendar', ['calendar.calendarlist.readonly', 'calendar.events']],
  ['Contacts', ['contacts.readonly']],
  ['Docs, Sheets & Slides', ['documents', 'spreadsheets', 'presentations']],
];
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
  const [adding, setAdding] = useState(false);
  const pending = useRef(false);
  const [removing, setRemoving] = useState<GoogleAccount | null>(null);
  const [renaming, setRenaming] = useState<GoogleAccount | null>(null);
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
  const connect = async (service: Service, account?: GoogleAccount) =>
    perform(async () => {
      if (!clientId) throw new Error('Google sign-in is not configured on this server.');
      const auth =
        service === 'Docs, Sheets & Slides'
          ? await runGoogleWorkspaceAuth(clientId, 'application/vnd.google-apps.document')
          : await {
              Drive: runGoogleDriveAuth,
              Gmail: runGmailAuth,
              Calendar: runCalendarAuth,
              Contacts: runContactsAuth,
            }[service](clientId);
      if (auth.kind === 'cancelled') return;
      const input = {
        code: auth.code,
        codeVerifier: auth.codeVerifier,
        redirectUri: auth.redirectUri,
        ...(account ? { accountId: account.id } : {}),
      };
      if (service === 'Gmail') await client.connectGmail(input);
      else if (service === 'Calendar') await client.connectCalendar(input);
      else if (service === 'Contacts') await client.connectContacts(input);
      else await client.connectGoogleDrive(input);
    });
  return (
    <SettingsScaffold title="Google" detail>
      <SettingsGroup
        title="Accounts"
        description="Connect services here, then choose accounts and folders in each project. Chats can override project defaults."
      >
        <SettingsNavRow
          title="Add Google account"
          icon="plus"
          disabled={busy}
          onPress={() => setAdding(true)}
        />
      </SettingsGroup>
      {accounts.map((account) => (
        <SettingsGroup key={account.id} title={account.displayName ?? account.email}>
          <Text style={styles.pathLabel}>{account.email}</Text>
          <SettingsNavRow
            title="Account name"
            subtitle={account.displayName ?? 'Optional, for example Personal or Work'}
            icon="edit-2"
            disabled={busy}
            onPress={() => {
              setName(account.displayName ?? '');
              setRenaming(account);
            }}
          />
          <Text style={styles.pathLabel}>
            {account.projects.length
              ? `Used in: ${account.projects.map((project) => project.name).join(', ')}`
              : 'Not used in any project yet'}
          </Text>
          <SettingsPanel>
            {services.map(([service, scopes]) => (
              <SettingsNavRow
                key={service}
                title={service}
                icon="link"
                disabled={
                  busy ||
                  (service === 'Docs, Sheets & Slides' &&
                    !account.scopes.some(
                      (scope) => scope === 'https://www.googleapis.com/auth/drive',
                    ))
                }
                subtitle={
                  service === 'Docs, Sheets & Slides' &&
                  !account.scopes.some((scope) => scope === 'https://www.googleapis.com/auth/drive')
                    ? 'Connect Drive first'
                    : scopes.every((scope) =>
                          account.scopes.includes(`https://www.googleapis.com/auth/${scope}`),
                        )
                      ? 'Access granted · Reconnect'
                      : 'Connect'
                }
                onPress={() => void connect(service, account)}
              />
            ))}
          </SettingsPanel>
          <SettingsNavRow
            title="Disconnect account"
            icon="x"
            disabled={busy}
            onPress={() => setRemoving(account)}
          />
        </SettingsGroup>
      ))}
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
      <Sheet visible={adding} title="Connect Google account" onClose={() => setAdding(false)}>
        {services
          .filter(([service]) => service !== 'Docs, Sheets & Slides')
          .map(([service]) => (
            <SettingsNavRow
              key={service}
              title={service}
              icon="link"
              disabled={busy}
              onPress={() => {
                setAdding(false);
                void connect(service);
              }}
            />
          ))}
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
