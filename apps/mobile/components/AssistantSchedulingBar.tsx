import { useCallback, useState } from 'react';
import { router } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import type { SchedulingRequestView, VerityClient } from '@verity/mobile';
import { useScanResource } from '../lib/useScanResource';
import { Icon } from './Icon';
import { schedulingGuestName, schedulingTime } from './SchedulingRequestsCard';
import { Button, Group, Row, Sheet } from './ui';
import { SessionBar, SessionBarContent, SessionBarTarget } from './ui/SessionBar';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A scheduling request in the assistant's overview, with the project it belongs to. */
export interface AssistantSchedulingItem {
  request: SchedulingRequestView;
  project: string | null;
}

/** The open requests of every granted project, longest waiting first. */
export function openSchedulingItems(
  items: readonly AssistantSchedulingItem[],
): AssistantSchedulingItem[] {
  const sent = (item: AssistantSchedulingItem) =>
    Date.parse(item.request.emailSentAt ?? item.request.createdAt);
  return items
    .filter(({ request }) => request.state === 'open' || request.state === 'provisioning')
    .sort((a, b) => sent(a) - sent(b));
}

/** "Waiting 2 days · closes Thu 5 Nov, 13:00", plus a note when no time can be booked. */
export function openSchedulingDetail(request: SchedulingRequestView, now = Date.now()): string {
  const days = Math.floor((now - Date.parse(request.emailSentAt ?? request.createdAt)) / DAY_MS);
  return [
    days < 1 ? 'Sent today' : `Waiting ${String(days)} day${days === 1 ? '' : 's'}`,
    request.windows.some((window) => window.state === 'active') ? null : 'no times left',
    `closes ${schedulingTime(request.closesAt, request.timeZone)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The open scheduling requests above the assistant's composer: one quiet line, the list in a
 * sheet. Hidden while nothing is open.
 */
export function AssistantSchedulingBar({
  items,
  now = Date.now(),
}: {
  items: readonly AssistantSchedulingItem[];
  now?: number;
}) {
  const { theme } = useUnistyles();
  const [open, setOpen] = useState(false);
  const openItems = openSchedulingItems(items);
  if (openItems.length === 0) return null;
  const title = `${String(openItems.length)} open scheduling request${openItems.length === 1 ? '' : 's'}`;
  const detail = openItems.map(({ request }) => schedulingGuestName(request)).join(', ');
  return (
    <>
      <SessionBar>
        <SessionBarTarget
          onPress={() => setOpen(true)}
          accessibilityLabel={`${title}: ${detail}`}
          accessibilityHint="Shows the open scheduling requests of your projects"
        >
          <SessionBarContent color={theme.colors.textMuted} title={title} subtitle={detail} />
          <Icon name="chevron-up" size={16} color={theme.colors.textFaint} />
        </SessionBarTarget>
      </SessionBar>
      <Sheet
        visible={open}
        title="Open scheduling requests"
        onClose={() => setOpen(false)}
        footer={
          <Button
            label="All requests"
            variant="text"
            onPress={() => {
              setOpen(false);
              router.push('/settings/scheduling-requests');
            }}
          />
        }
      >
        <Group>
          {openItems.map(({ request, project }) => (
            <Row
              key={request.id}
              title={`${schedulingGuestName(request)} · ${request.title}`}
              subtitle={[project, openSchedulingDetail(request, now)].filter(Boolean).join(' · ')}
              navigates
              onPress={() => {
                setOpen(false);
                router.push(`/session/${request.sessionId}`);
              }}
            />
          ))}
        </Group>
      </Sheet>
    </>
  );
}

/**
 * The overview in the assistant's own session only: the open requests of the projects granted
 * to it, named by project.
 */
export function AssistantSchedulingOverview({
  client,
  sessionId,
}: {
  client: VerityClient;
  sessionId: string;
}) {
  const resource = useScanResource(
    useCallback(async () => {
      const overview = await client.assistantSchedulingRequests();
      if (overview.assistantSessionId !== sessionId) return null;
      const projects = await client.listProjects();
      const names = new Map(projects.map((project) => [project.id, project.repo]));
      return overview.requests.map((request) => ({
        request,
        project: request.projectId ? (names.get(request.projectId) ?? null) : null,
      }));
    }, [client, sessionId]),
  );
  return resource.data ? <AssistantSchedulingBar items={resource.data} /> : null;
}
