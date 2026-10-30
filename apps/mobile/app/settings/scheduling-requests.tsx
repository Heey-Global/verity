import type { SchedulingRequestView, VerityClient } from '@verity/mobile';
import { schedulingWindowLabel } from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useMemo, useState } from 'react';
import { Text } from 'react-native';
import {
  SettingsGroup,
  SettingsNavRow,
  SettingsPanel,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../components/settings/settingsStyles';
import {
  schedulingGuestName,
  schedulingStatus,
  schedulingSubtitle,
} from '../../components/SchedulingRequestsCard';
import { Sheet, useConfirm } from '../../components/ui';
import { createVerityClient } from '../../lib/client';
import { useScanResource } from '../../lib/useScanResource';

export default function SchedulingRequestsSettings() {
  const client = useMemo(() => createVerityClient(), []);
  return client ? (
    <SchedulingRequestsContent client={client} />
  ) : (
    <SettingsScaffold title="Scheduling requests" detail>
      <Text style={styles.pathLabel}>Connect to your server first.</Text>
    </SettingsScaffold>
  );
}

const running = (request: SchedulingRequestView) =>
  request.state === 'open' || request.state === 'provisioning';

/**
 * Every scheduling request the user may steer, across sessions — also those whose chat was
 * deleted, which keep running until they are booked, expire or are withdrawn.
 */
function SchedulingRequestsContent({ client }: { client: VerityClient }) {
  const resource = useScanResource(useCallback(() => client.schedulingRequests(), [client]));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, confirmSheet] = useConfirm();
  const requests = resource.data ?? [];
  const selected = requests.find((request) => request.id === selectedId) ?? null;
  const problems = requests.filter((request) => schedulingStatus(request).intent === 'needsSetup');
  const open = requests.filter(
    (request) => running(request) && schedulingStatus(request).intent !== 'needsSetup',
  );
  const closed = requests.filter(
    (request) => !problems.includes(request) && !open.includes(request),
  );
  const row = (request: SchedulingRequestView) => (
    <SettingsNavRow
      key={request.id}
      icon="calendar"
      title={`${schedulingGuestName(request)} · ${request.title}`}
      subtitle={schedulingSubtitle(request)}
      status={schedulingStatus(request)}
      onPress={() => {
        setCopied(false);
        setSelectedId(request.id);
      }}
    />
  );
  const withdraw = (request: SchedulingRequestView) => {
    setSelectedId(null);
    confirm({
      title: `Withdraw the request for ${schedulingGuestName(request)}?`,
      message: 'The link stops offering times and the holds are removed from the calendars.',
      confirmLabel: 'Withdraw',
      destructive: true,
      onConfirm: async () => {
        await client.revokeSchedulingRequest(request.id);
        resource.reload();
      },
    });
  };
  return (
    <SettingsScaffold title="Scheduling requests" detail>
      {resource.error ? <Text style={styles.pathLabel}>{resource.error}</Text> : null}
      {resource.data && requests.length === 0 ? (
        <Text style={styles.pathLabel}>
          No scheduling requests yet. Ask Verity in a chat to offer times to someone.
        </Text>
      ) : null}
      {problems.length > 0 ? (
        <SettingsGroup title="Needs attention">{problems.map(row)}</SettingsGroup>
      ) : null}
      {open.length > 0 ? (
        <SettingsGroup
          title="Open"
          description="Each request has its own link and holds, even after its chat is deleted."
        >
          {open.map(row)}
        </SettingsGroup>
      ) : null}
      {closed.length > 0 ? <SettingsGroup title="Recent">{closed.map(row)}</SettingsGroup> : null}
      <Sheet
        visible={selected !== null}
        title={
          selected ? `${schedulingGuestName(selected)} · ${selected.title}` : 'Scheduling request'
        }
        onClose={() => setSelectedId(null)}
      >
        {selected ? (
          <>
            <Text style={styles.pathLabel}>{schedulingSubtitle(selected)}</Text>
            {running(selected) ? (
              <Text style={styles.pathLabel}>
                {selected.windows
                  .filter((window) => window.state === 'active' || window.state === 'pending')
                  .map((window) => schedulingWindowLabel(window, selected.timeZone))
                  .join('\n')}
              </Text>
            ) : null}
            <SettingsPanel>
              {selected.link ? (
                <SettingsNavRow
                  icon="copy"
                  title={copied ? 'Link copied' : 'Copy link'}
                  onPress={() =>
                    void Clipboard.setStringAsync(selected.link!)
                      .then(() => setCopied(true))
                      .catch(() => setCopied(false))
                  }
                />
              ) : null}
              {running(selected) ? (
                <SettingsNavRow
                  icon="x"
                  title="Withdraw request"
                  onPress={() => withdraw(selected)}
                />
              ) : null}
            </SettingsPanel>
          </>
        ) : null}
      </Sheet>
      {confirmSheet}
    </SettingsScaffold>
  );
}
