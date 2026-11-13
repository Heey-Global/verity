import type { ActiveLiveMeetings, UpcomingMeeting } from '@verity/mobile';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { createVerityClient } from '../../lib/client';
import { Button, Card, CardHead, Group, Row, SectionHeader, Text, TextField } from '../ui';
import { Disclosure } from '../ui/Disclosure';
import { StatusTag } from '../ui/Status';

const PROVIDER = { meet: 'Google Meet', teams: 'Teams', zoom: 'Zoom' } as const;
const REFRESH_MS = 30_000;
/** Prefer a meeting near its start without preventing an explicit earlier join. */
const PRESELECT_EARLY_MS = 15 * 60_000;

export const canJoinCalendarMeeting = (meeting: UpcomingMeeting, now: number) =>
  meeting.endsAt > now;

/** The hosts the server's `isSupportedMeetingUrl` accepts; a test keeps the two equal. */
export const MEETING_HOSTS = [
  'meet.google.com',
  'teams.microsoft.com',
  'teams.live.com',
  'zoom.us',
];

/**
 * Whether Verity's bot can join a typed link, as the server decides it: HTTPS on Google Meet,
 * Teams or Zoom. A link pasted without `https://` is read the way the server reads it.
 */
export function isSupportedMeetingLink(text: string): boolean {
  const value = text.trim();
  const withScheme =
    /^(?:meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|(?:[a-z0-9-]+\.)?zoom\.us)\//i.test(
      value,
    )
      ? `https://${value}`
      : value;
  try {
    const url = new URL(withScheme);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      MEETING_HOSTS.some(
        (host) =>
          url.hostname === host || (host === 'zoom.us' && url.hostname.endsWith('.zoom.us')),
      )
    );
  } catch {
    return false;
  }
}

/** Shown at the link field when Verity cannot join the link. */
export const UNSUPPORTED_LINK_ERROR = {
  title: 'Link not supported',
  message: 'Use Google Meet, Microsoft Teams or Zoom.',
};

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Upcoming entries from the selected calendars, including in-person meetings. */
export function useUpcomingMeetings(enabled: boolean) {
  const [upcoming, setUpcoming] = useState<UpcomingMeeting[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const load = () => {
      const client = createVerityClient();
      if (!client) return;
      // Permission or connection failures must not look like an empty calendar.
      void Promise.resolve()
        .then(() => client.getUpcomingMeetings(true))
        .then((list) => {
          if (current) {
            setLoadFailed(false);
            setUpcoming(list.filter((item) => item.decision !== 'joined'));
          }
        })
        .catch(() => {
          if (current) {
            setLoadFailed(true);
            setUpcoming([]);
          }
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [enabled]);
  return { upcoming, loadFailed };
}

/**
 * Which calendar meeting the start button joins. The first one is picked by default; with
 * none to pick, the link field opens, since typing the link is then the only way forward.
 */
export function useCalendarMeetingChoice(
  upcoming: UpcomingMeeting[] | null,
  now: number,
  inPerson = false,
  /** The meeting Verity prepared the screen for; picked first while it is listed. */
  preferredEventKey: string | null = null,
) {
  const [selectedEventKey, setSelectedEventKey] = useState<string | null>(null);
  const [manualLink, setManualLink] = useState(false);
  const preselected = useRef(false);
  const previousSource = useRef(inPerson);
  useEffect(() => {
    if (upcoming === null) return;
    if (upcoming.length === 0) setManualLink(true);
    // A refresh preserves the choice; changing sources selects a compatible current event.
    const sourceChanged = previousSource.current !== inPerson;
    previousSource.current = inPerson;
    if (!preselected.current || sourceChanged) {
      preselected.current = true;
      const eligible = (item: UpcomingMeeting) =>
        canJoinCalendarMeeting(item, now) &&
        item.startsAt - now <= PRESELECT_EARLY_MS &&
        (inPerson || item.provider !== null);
      const current = upcoming.find((item) => item.eventKey === selectedEventKey);
      // Verity may name a meeting hours ahead to fill in its title, but never one without
      // a call link for an online start.
      const preferred = sourceChanged
        ? undefined
        : upcoming.find(
            (item) => item.eventKey === preferredEventKey && (inPerson || item.provider !== null),
          );
      const soon =
        preferred ??
        (sourceChanged && current && eligible(current) ? current : upcoming.find(eligible));
      if (soon) {
        setSelectedEventKey(soon.eventKey);
        if (sourceChanged) setManualLink(false);
      } else if (sourceChanged) setSelectedEventKey(null);
      return;
    }
    if (selectedEventKey && !upcoming.some((item) => item.eventKey === selectedEventKey))
      setSelectedEventKey(null);
  }, [upcoming, selectedEventKey, now, inPerson]);
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
      // Ended ones too: they are kept until the retention period and can still be continued.
      setUnassigned(active.unassigned);
    } catch {
      setUnassigned([]);
    }
  };
  useEffect(() => {
    void load();
    // A meeting Verity joins while this screen is open shows up without leaving it.
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
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
  loadFailed = false,
  inPerson = false,
  onChooseCalendars,
  selectedKey,
  onSelect,
  manual,
  onManualChange,
  meetingUrl,
  onMeetingUrlChange,
  meetingUrlError,
  now,
}: {
  upcoming: UpcomingMeeting[] | null;
  loadFailed?: boolean;
  inPerson?: boolean;
  onChooseCalendars?: () => void;
  selectedKey: string | null;
  onSelect: (eventKey: string) => void;
  manual: boolean;
  onManualChange: (manual: boolean) => void;
  meetingUrl: string;
  onMeetingUrlChange: (url: string) => void;
  /** Set once a start was refused because Verity cannot join the typed link. */
  meetingUrlError?: { title: string; message: string } | undefined;
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
              subtitle={`${when(meeting)} · ${
                meeting.provider
                  ? PROVIDER[meeting.provider]
                  : inPerson
                    ? 'In person'
                    : 'Link not supported'
              }`}
              selected={!manual && selectedKey === meeting.eventKey}
              disabled={!inPerson && (!meeting.provider || !canJoinCalendarMeeting(meeting, now))}
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
            title={
              loadFailed
                ? 'Could not load calendar meetings'
                : upcoming === null
                  ? 'Loading meetings…'
                  : 'No calendar meetings'
            }
            subtitle={
              loadFailed
                ? 'Check your server connection and calendar access. Retrying automatically.'
                : upcoming === null
                  ? undefined
                  : 'From watched calendars in the next hours. Choose calendars in Settings → Google → Meeting calendars.'
            }
            leading={{ icon: 'calendar' }}
          />
        </Card>
      )}
      {onChooseCalendars && (!upcoming || upcoming.length === 0 || loadFailed) ? (
        <Button label="Choose meeting calendars" variant="text" onPress={onChooseCalendars} />
      ) : null}
      {!inPerson ? (
        <Card flush>
          <Disclosure
            title="Enter link manually"
            expanded={manual}
            onExpandedChange={onManualChange}
          >
            <TextField
              label="Meeting link"
              accessibilityLabel="Online meeting link"
              value={meetingUrl}
              onChangeText={onMeetingUrlChange}
              placeholder="https://"
              keyboardType="url"
              error={meetingUrlError}
            />
            {meetingUrlError ? null : (
              <Text variant="footnote">Google Meet, Microsoft Teams or Zoom.</Text>
            )}
          </Disclosure>
        </Card>
      ) : null}
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
  const minutes = Math.max(0, Math.floor(((meeting.endedAt ?? now) - meeting.startedAt) / 60_000));
  return (
    <Card stacked>
      <CardHead
        title={meeting.title || 'Online meeting'}
        subtitle={[
          meeting.state === 'ended'
            ? `Ended · ${String(minutes)} min`
            : meeting.state === 'interrupted'
              ? 'Reconnecting'
              : `Live · ${String(minutes)} min`,
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
