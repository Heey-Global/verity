import { useCallback, useState } from 'react';
import { router } from 'expo-router';
import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  schedulingWindowLabel,
  type SchedulingRequestView,
  type VerityClient,
} from '@verity/mobile';
import { Button, Card, CardHead, StatusTag, Text, useConfirm } from './ui';
import type { StatusIntent } from './ui/Status';
import { useScanResource } from '../lib/useScanResource';
import { settingsStyles } from './settings/settingsStyles';

const RECENT_MS = 24 * 60 * 60 * 1000;

export function schedulingStatus(request: SchedulingRequestView): {
  intent: StatusIntent;
  label: string;
} {
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

/** A time in the request's own zone, e.g. "Thu 5 Nov, 13:00". */
export function schedulingTime(iso: string, timeZone: string): string {
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

export function schedulingGuestName(request: SchedulingRequestView): string {
  return request.guest.name ?? request.guest.email;
}

export function schedulingSubtitle(request: SchedulingRequestView): string {
  if (request.booked) return `Booked ${schedulingTime(request.booked.start, request.timeZone)}`;
  if (request.state === 'open')
    return `${request.title} · closes ${schedulingTime(request.closesAt, request.timeZone)}`;
  return request.failure ?? request.title;
}

/**
 * Requests worth showing above the composer: running ones and problems that still need the
 * operator. A booking is final and already announced by a notice in the chat history, so pinning
 * it here until the meeting starts would only repeat that notice; Settings keeps the full list.
 */
export function visibleSchedulingRequests(
  requests: readonly SchedulingRequestView[],
  now = Date.now(),
): SchedulingRequestView[] {
  return requests.filter(
    (request) =>
      request.state === 'open' ||
      request.state === 'provisioning' ||
      request.pendingCleanups > 0 ||
      (request.state === 'failed' && now - Date.parse(request.createdAt) < RECENT_MS),
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
  const [copied, setCopied] = useState<string>();
  const requests = visibleSchedulingRequests(resource.data ?? []);
  if (requests.length === 0) return null;
  const revoke = (request: SchedulingRequestView) =>
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
  return (
    <>
      {requests.map((request, index) => {
        const state = schedulingStatus(request);
        return (
          <Card key={request.id} stacked divided attention={state.intent === 'needsSetup'}>
            <CardHead
              title={`${schedulingGuestName(request)} · ${request.title}`}
              subtitle={schedulingSubtitle(request)}
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
            {request.link ||
            request.state === 'open' ||
            request.state === 'provisioning' ||
            index === 0 ? (
              <View style={settingsStyles.actionRowStart}>
                {request.link ? (
                  <Button
                    label={copied === request.id ? 'Link copied' : 'Copy link'}
                    variant="text"
                    size="compact"
                    icon="copy"
                    onPress={() =>
                      void Clipboard.setStringAsync(request.link!)
                        .then(() => setCopied(request.id))
                        .catch(() => setCopied(undefined))
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
                    onPress={() => router.push('/settings/scheduling-requests')}
                  />
                ) : null}
              </View>
            ) : null}
          </Card>
        );
      })}
      {resource.error ? <Text variant="footnote">{resource.error}</Text> : null}
      {confirmSheet}
    </>
  );
}
