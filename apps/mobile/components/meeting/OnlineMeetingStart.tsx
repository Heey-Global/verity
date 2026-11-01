import type { ActiveLiveMeetings, UpcomingMeeting } from '@verity/mobile';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { createVerityClient } from '../../lib/client';
import { Button, Card, CardHead, Group, Row, SectionHeader, Text, TextField } from '../ui';
import { Disclosure } from '../ui/Disclosure';
import { StatusTag } from '../ui/Status';

const PROVIDER = { meet: 'Google Meet', teams: 'Teams', zoom: 'Zoom' } as const;
const REFRESH_MS = 30_000;

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The calendar meetings that can still be joined; empty for a server or user without them. */
export function useUpcomingMeetings(enabled: boolean): UpcomingMeeting[] | null {
  const [upcoming, setUpcoming] = useState<UpcomingMeeting[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const load = () => {
      const client = createVerityClient();
      if (!client) return;
      // Older servers and users other than administrators have no calendar list.
      void client
        .getUpcomingMeetings()
        .then((list) => {
          if (current) setUpcoming(list.filter((item) => item.decision !== 'joined'));
        })
        .catch(() => {
          if (current) setUpcoming([]);
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [enabled]);
  return upcoming;
}

/**
 * Which calendar meeting the start button joins. The first one is picked by default; with
 * none to pick, the link field opens, since typing the link is then the only way forward.
 */
export function useCalendarMeetingChoice(upcoming: UpcomingMeeting[] | null) {
  const [selectedEventKey, setSelectedEventKey] = useState<string | null>(null);
  const [manualLink, setManualLink] = useState(false);
  useEffect(() => {
    if (upcoming === null) return;
    if (upcoming.length === 0) {
      setManualLink(true);
      return;
    }
    if (!upcoming.some((item) => item.eventKey === selectedEventKey))
      setSelectedEventKey(upcoming[0]!.eventKey);
  }, [upcoming, selectedEventKey]);
  const selectedEvent = manualLink
    ? null
    : (upcoming?.find((item) => item.eventKey === selectedEventKey) ?? null);
  return { selectedEventKey, setSelectedEventKey, manualLink, setManualLink, selectedEvent };
}

/** Online meetings that run without a project, to continue in this session. */
export function useUnassignedMeetings(): [ActiveLiveMeetings['unassigned'], () => Promise<void>] {
  const [unassigned, setUnassigned] = useState<ActiveLiveMeetings['unassigned']>([]);
  const load = async () => {
    const client = createVerityClient();
    if (!client) return;
    try {
      const active = await client.getActiveLiveMeetings();
      setUnassigned(active.unassigned.filter((item) => item.state !== 'ended'));
    } catch {
      setUnassigned([]);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  return [unassigned, load];
}

/**
 * The online source of the start screen (mockup: live meeting intake, start): meetings from
 * watched calendars to pick from, and the link field as a fallback behind "Enter link
 * manually", open on its own when there is nothing to pick.
 */
export function CalendarMeetingPicker({
  upcoming,
  selectedKey,
  onSelect,
  manual,
  onManualChange,
  meetingUrl,
  onMeetingUrlChange,
  now,
}: {
  upcoming: UpcomingMeeting[] | null;
  selectedKey: string | null;
  onSelect: (eventKey: string) => void;
  manual: boolean;
  onManualChange: (manual: boolean) => void;
  meetingUrl: string;
  onMeetingUrlChange: (url: string) => void;
  now: number;
}) {
  const when = (meeting: UpcomingMeeting) => {
    if (meeting.startsAt <= now) {
      const minutes = Math.max(0, Math.floor((now - meeting.startsAt) / 60_000));
      return minutes === 0 ? 'Started just now' : `Started ${String(minutes)} min ago`;
    }
    return `${clock(meeting.startsAt)} – ${clock(meeting.endsAt)}`;
  };
  return (
    <View style={styles.section}>
      <SectionHeader title="From your calendar" />
      {upcoming && upcoming.length > 0 ? (
        <Group>
          {upcoming.map((meeting) => (
            <Row
              key={meeting.eventKey}
              title={meeting.title || 'Online meeting'}
              subtitle={`${when(meeting)} · ${PROVIDER[meeting.provider]}`}
              selected={!manual && selectedKey === meeting.eventKey}
              onPress={() => {
                onSelect(meeting.eventKey);
                onManualChange(false);
              }}
            />
          ))}
        </Group>
      ) : (
        <Card flush>
          <Row
            title={upcoming === null ? 'Loading meetings…' : 'No meetings with a link'}
            subtitle={upcoming === null ? undefined : 'From watched calendars in the next hours'}
            leading={{ icon: 'calendar' }}
          />
        </Card>
      )}
      <Card flush>
        <Disclosure title="Enter link manually" expanded={manual} onExpandedChange={onManualChange}>
          <TextField
            label="Meeting link"
            accessibilityLabel="Online meeting link"
            value={meetingUrl}
            onChangeText={onMeetingUrlChange}
            placeholder="https://"
            keyboardType="url"
          />
          <Text variant="footnote">Google Meet, Microsoft Teams or Zoom.</Text>
        </Disclosure>
      </Card>
    </View>
  );
}

/** A meeting Verity joined without a project (mockup: live meeting intake, start 3). */
export function UnassignedMeetingCard({
  meeting,
  now,
  busy,
  onContinue,
  onDiscard,
}: {
  meeting: ActiveLiveMeetings['unassigned'][number];
  now: number;
  busy: boolean;
  onContinue: () => void;
  onDiscard: () => void;
}) {
  const minutes = Math.max(0, Math.floor((now - meeting.startedAt) / 60_000));
  return (
    <Card stacked>
      <CardHead
        title={meeting.title || 'Online meeting'}
        subtitle={[
          meeting.state === 'interrupted' ? 'Reconnecting' : `Live · ${String(minutes)} min`,
          meeting.people > 0
            ? `${String(meeting.people)} ${meeting.people === 1 ? 'person' : 'people'}`
            : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        trailing={<StatusTag intent="optional" label="Not in a project" />}
      />
      <Text variant="footnote">
        Continue it in this session to see the transcript and Verity's help so far.
      </Text>
      <View style={styles.actions}>
        <View style={styles.grow}>
          <Button
            label="Continue here"
            accessibilityLabel="Continue meeting in this session"
            size="compact"
            loading={busy}
            onPress={onContinue}
            fullWidth
          />
        </View>
        <Button
          label="Discard"
          accessibilityLabel="Discard meeting"
          variant="secondary"
          size="compact"
          disabled={busy}
          onPress={onDiscard}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing.sm },
  actions: { flexDirection: 'row', gap: theme.spacing.sm },
  grow: { flex: 1 },
}));
