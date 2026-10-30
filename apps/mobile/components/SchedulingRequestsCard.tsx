import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  schedulingWindowLabel,
  type SchedulingRequestView,
  type VerityClient,
} from '@verity/mobile';
import { Button, Card, CardHead, Group, Row, Sheet, StatusTag, Text, useConfirm } from './ui';
import type { StatusIntent } from './ui/Status';
import { useScanResource } from '../lib/useScanResource';
import { settingsStyles } from './settings/settingsStyles';

const RECENT_MS = 24 * 60 * 60 * 1000;

function status(request: SchedulingRequestView): { intent: StatusIntent; label: string } {
  if (request.pendingCleanups > 0) return { intent: 'needsSetup', label: 'Cleanup pending' };
  switch (request.state) {
    case 'provisioning':
      return { intent: 'transient', label: 'Sending' };
    case 'open':
      return request.failure
        ? { intent: 'needsSetup', label: 'Check email' }
        : { intent: 'ready', label: 'Open' };
    case 'booked':
      return { intent: 'ready', label: 'Booked' };
    case 'failed':
      return { intent: 'needsSetup', label: 'Failed' };
    case 'revoked':
      return { intent: 'unknown', label: 'Withdrawn' };
    default:
      return { intent: 'unknown', label: request.state === 'expired' ? 'Expired' : 'Draft' };
  }
}

function when(iso: string, timeZone: string): string {
  const options = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  } as const;
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, ...options }).format(new Date(iso));
  } catch {
    // An unknown zone must not take the chat down; the device zone is still a real time.
    return new Intl.DateTimeFormat('en-GB', options).format(new Date(iso));
  }
}

function guestName(request: SchedulingRequestView): string {
  return request.guest.name ?? request.guest.email;
}

function subtitle(request: SchedulingRequestView): string {
  if (request.booked) return `Booked ${when(request.booked.start, request.timeZone)}`;
  if (request.state === 'open')
    return `${request.title} · closes ${when(request.closesAt, request.timeZone)}`;
  return request.failure ?? request.title;
}

/** Requests worth showing above the composer: running ones, problems, and fresh bookings. */
export function visibleSchedulingRequests(
  requests: readonly SchedulingRequestView[],
  now = Date.now(),
): SchedulingRequestView[] {
  return requests.filter(
    (request) =>
      request.state === 'open' ||
      request.state === 'provisioning' ||
      request.pendingCleanups > 0 ||
      (request.state === 'failed' && now - Date.parse(request.createdAt) < RECENT_MS) ||
      (request.booked !== null && now - Date.parse(request.booked.start) < 0),
  );
}

/** The scheduling requests of one session, kept current while the chat is visible. */
export function SchedulingRequestsCard({
  client,
  sessionId,
}: {
  client: VerityClient;
  sessionId: string;
}) {
  const resource = useScanResource(
    useCallback(() => client.sessionSchedulingRequests(sessionId), [client, sessionId]),
  );
  const [confirm, confirmSheet] = useConfirm();
  const [overview, setOverview] = useState(false);
  const [copied, setCopied] = useState<string>();
  const requests = visibleSchedulingRequests(resource.data ?? []);
  if (requests.length === 0 && !overview) return null;
  const revoke = (request: SchedulingRequestView) =>
    confirm({
      title: `Withdraw the request for ${guestName(request)}?`,
      message: 'The link stops offering times and the holds are removed from the calendars.',
      confirmLabel: 'Withdraw',
      destructive: true,
      onConfirm: async () => {
        await client.revokeSchedulingRequest(sessionId, request.id);
        resource.reload();
      },
    });
  return (
    <>
      {requests.map((request, index) => {
        const state = status(request);
        return (
          <Card key={request.id} stacked divided attention={state.intent === 'needsSetup'}>
            <CardHead
              title={`${guestName(request)} · ${request.title}`}
              subtitle={subtitle(request)}
              trailing={<StatusTag intent={state.intent} label={state.label} />}
            />
            {request.state === 'open' || request.state === 'provisioning' ? (
              <Text variant="subtitle">
                {request.windows
                  .filter((window) => window.state === 'active' || window.state === 'pending')
                  .map((window) => schedulingWindowLabel(window, request.timeZone))
                  .join('\n')}
              </Text>
            ) : null}
            {request.failure && request.state === 'open' ? (
              <Text variant="footnote">{request.failure}</Text>
            ) : null}
            {request.link || request.state === 'open' || index === 0 ? (
              <View style={settingsStyles.actionRowStart}>
                {request.link ? (
                  <Button
                    label={copied === request.id ? 'Link copied' : 'Copy link'}
                    variant="text"
                    size="compact"
                    icon="copy"
                    onPress={() =>
                      void Clipboard.setStringAsync(request.link!).then(() => setCopied(request.id))
                    }
                  />
                ) : null}
                {request.state === 'open' || request.state === 'provisioning' ? (
                  <Button
                    label="Withdraw"
                    variant="destructive"
                    size="compact"
                    onPress={() => revoke(request)}
                  />
                ) : null}
                {index === 0 ? (
                  <Button
                    label="All requests"
                    variant="text"
                    size="compact"
                    onPress={() => setOverview(true)}
                  />
                ) : null}
              </View>
            ) : null}
          </Card>
        );
      })}
      {resource.error ? <Text variant="footnote">{resource.error}</Text> : null}
      <SchedulingOverviewSheet
        client={client}
        visible={overview}
        onClose={() => setOverview(false)}
      />
      {confirmSheet}
    </>
  );
}

/** Every scheduling request across sessions; problems first. */
function SchedulingOverviewSheet({
  client,
  visible,
  onClose,
}: {
  client: VerityClient;
  visible: boolean;
  onClose: () => void;
}) {
  const [requests, setRequests] = useState<SchedulingRequestView[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    client
      .schedulingRequests()
      .then((loaded) => {
        setRequests(loaded);
        setError(undefined);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load requests.'));
  }, [client]);
  useEffect(() => {
    if (visible) load();
  }, [visible, load]);
  const sorted = [...(requests ?? [])].sort(
    (a, b) =>
      Number(b.pendingCleanups > 0) - Number(a.pendingCleanups > 0) ||
      Number(b.state === 'open') - Number(a.state === 'open'),
  );
  return (
    <Sheet visible={visible} title="Scheduling requests" onClose={onClose}>
      <Text variant="subtitle">Each request has its own link and holds.</Text>
      {error ? <Text variant="footnote">{error}</Text> : null}
      {sorted.length === 0 && requests ? (
        <Text variant="footnote">No scheduling requests yet.</Text>
      ) : null}
      {sorted.length > 0 ? (
        <Group>
          {sorted.map((request) => {
            const state = status(request);
            return (
              <Row
                key={request.id}
                title={guestName(request)}
                subtitle={subtitle(request)}
                leading={{ dot: state.intent }}
                trailing={<Text variant="subtitle">{state.label}</Text>}
              />
            );
          })}
        </Group>
      ) : null}
    </Sheet>
  );
}
