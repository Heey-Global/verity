import { VerityApiError, type VerityClient } from '@verity/mobile';
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

type Service = 'Drive' | 'Gmail' | 'Calendar' | 'Contacts' | 'Docs, Sheets & Slides';
export default function GoogleSettings() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client)
    return (
      <SettingsScaffold title="Google" detail>
        <Text style={styles.pathLabel}>Connect to your server first.</Text>
      </SettingsScaffold>
    );
  return <GoogleSettingsContent client={client} />;
}
function GoogleSettingsContent({ client }: { client: VerityClient }) {
  const [connection, setConnection] = useState<Awaited<
    ReturnType<typeof client.getGoogleDriveConnection>
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const operationPending = useRef(false);
  const [usageAvailable, setUsageAvailable] = useState(true);
  const [account, setAccount] = useState<Awaited<
    ReturnType<typeof client.getGoogleConnection>
  > | null>(null);
  const reload = useCallback(async () => {
    const [drive, google] = await Promise.allSettled([
      client.getGoogleDriveConnection(),
      client.getGoogleConnection(),
    ]);
    if (drive.status === 'rejected') throw drive.reason;
    setConnection(drive.value);
    if (google.status === 'fulfilled') {
      setAccount(google.value);
      setUsageAvailable(true);
    } else if (google.reason instanceof VerityApiError && google.reason.status === 404) {
      // Account metadata is new; older servers still support the consent flows.
      setUsageAvailable(false);
      setAccount({
        connected: drive.value.connected || drive.value.scopes.length > 0,
        accountEmail: drive.value.accountEmail,
        scopes: drive.value.scopes,
        projects: [],
      });
    } else throw google.reason;
  }, [client]);
  useEffect(() => {
    void reload().catch((error: unknown) => Alert.alert('Could not load Google', String(error)));
  }, [reload]);
  const connect = async (service: Service) => {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true);
    try {
      if (!connection?.clientId)
        throw new Error('Google sign-in is not configured on this server.');
      if (service === 'Docs, Sheets & Slides') {
        if (!connection.connected)
          throw new Error('Connect Google Drive before enabling document editing.');
        const auth = await runGoogleWorkspaceAuth(
          connection.clientId,
          'application/vnd.google-apps.document',
        );
        if (auth.kind === 'cancelled') return;
        await client.connectGoogleDrive({
          code: auth.code,
          codeVerifier: auth.codeVerifier,
          redirectUri: auth.redirectUri,
        });
      } else {
        const auth = await (
          service === 'Drive'
            ? runGoogleDriveAuth
            : service === 'Gmail'
              ? runGmailAuth
              : service === 'Calendar'
                ? runCalendarAuth
                : runContactsAuth
        )(connection.clientId);
        if (auth.kind === 'cancelled') return;
        const input = {
          code: auth.code,
          codeVerifier: auth.codeVerifier,
          redirectUri: auth.redirectUri,
        };
        if (service === 'Drive') await client.connectGoogleDrive(input);
        else if (service === 'Gmail') await client.connectGmail(input);
        else if (service === 'Calendar') await client.connectCalendar(input);
        else await client.connectContacts(input);
      }
      await reload();
    } catch (error) {
      Alert.alert(
        'Could not connect Google',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true);
    try {
      await client.disconnectGoogleDrive();
      await reload();
    } catch (error) {
      Alert.alert('Could not disconnect', String(error));
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  };
  const scopes = account?.scopes ?? [];
  const services: [Service, string[]][] = [
    ['Drive', ['drive']],
    ['Gmail', ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic']],
    ['Calendar', ['calendar.calendarlist.readonly', 'calendar.events']],
    ['Contacts', ['contacts.readonly']],
    ['Docs, Sheets & Slides', ['documents', 'spreadsheets', 'presentations']],
  ];
  return (
    <SettingsScaffold title="Google" detail>
      <SettingsGroup title="Account">
        <Text style={styles.pathLabel}>
          {account?.accountEmail ??
            (account?.connected ? 'Google account connected' : 'No account connected')}
        </Text>
        <Text style={styles.pathLabel}>
          Connect the services you need, then grant access in each project. Native files are
          selected in the session file browser.
        </Text>
      </SettingsGroup>
      <SettingsGroup title="Used in projects">
        <Text style={styles.pathLabel}>
          {!usageAvailable
            ? 'Update your server to see project usage.'
            : account?.projects.length
              ? account.projects.map(({ name }) => name).join(', ')
              : 'Not used in any project yet'}
        </Text>
      </SettingsGroup>
      <SettingsGroup title="Services">
        <SettingsPanel>
          {services.map(([service, required]) => (
            <SettingsNavRow
              key={service}
              disabled={busy}
              title={service}
              icon="link"
              subtitle={
                required.every((scope) =>
                  scopes.includes(`https://www.googleapis.com/auth/${scope}`),
                )
                  ? 'Access granted'
                  : 'Connect'
              }
              onPress={() => void connect(service)}
            />
          ))}
        </SettingsPanel>
      </SettingsGroup>
      {account?.connected ? (
        <SettingsGroup title="Disconnect">
          <SettingsNavRow
            title="Disconnect account"
            disabled={busy}
            icon="link"
            onPress={() =>
              Alert.alert(
                'Disconnect Google?',
                'This removes Google access for all projects and sessions.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Disconnect',
                    style: 'destructive',
                    onPress: () => void disconnect(),
                  },
                ],
              )
            }
          />
        </SettingsGroup>
      ) : null}
    </SettingsScaffold>
  );
}
