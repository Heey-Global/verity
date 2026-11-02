import type { UpcomingMeeting } from '@verity/mobile';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { createVerityClient } from '../../lib/client';
import { Button, Sheet, Text } from '../ui';

const PROVIDER = { meet: 'Google Meet', teams: 'Teams', zoom: 'Zoom' } as const;

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Asks whether Verity joins a meeting from a watched calendar, opened by tapping its
 * notification. Joining from here starts the meeting without a project, as the notification
 * buttons do; the floating card then offers to assign it.
 */
export function CalendarMeetingPrompt({
  eventKey,
  onClose,
  onJoined,
}: {
  eventKey: string | null;
  onClose: () => void;
  onJoined: () => void;
}) {
  const [meeting, setMeeting] = useState<UpcomingMeeting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMeeting(null);
    setError(null);
    if (eventKey === null) return;
    const client = createVerityClient();
    if (!client) {
      setError('Connect to the server to join this meeting.');
      return;
    }
    let current = true;
    void client
      .getUpcomingMeetings()
      .then((list) => {
        if (!current) return;
        const found = list.find((item) => item.eventKey === eventKey) ?? null;
        setMeeting(found);
        if (!found) setError('This meeting is no longer available.');
      })
      .catch(() => {
        if (current) setError('Could not load the meeting.');
      });
    return () => {
      current = false;
    };
  }, [eventKey]);

  const run = async (operation: 'join' | 'skip') => {
    const client = createVerityClient();
    if (!client || !eventKey || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (operation === 'join') {
        await client.joinCalendarMeeting(eventKey);
        onJoined();
      } else {
        await client.skipCalendarMeeting(eventKey);
        onClose();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update the meeting.');
    } finally {
      setBusy(false);
    }
  };

  const joined = meeting?.decision === 'joined';
  return (
    <Sheet
      visible={eventKey !== null}
      title={meeting?.title || 'Online meeting'}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <Button
          label="Join"
          accessibilityLabel="Join meeting with Verity"
          disabled={busy || meeting === null || joined}
          onPress={() => void run('join')}
          fullWidth
        />
      }
    >
      <View style={styles.body}>
        {meeting ? (
          <Text variant="subtitle">
            {[
              `${time(meeting.startsAt)}–${time(meeting.endsAt)}`,
              meeting.calendar,
              PROVIDER[meeting.provider],
            ].join(' · ')}
          </Text>
        ) : null}
        {error ? (
          <Text variant="footnote" tone="attention">
            {error}
          </Text>
        ) : (
          <Text variant="footnote">
            {joined
              ? 'Verity already joined this meeting.'
              : 'Verity joins without a project. You pick the project afterwards.'}
          </Text>
        )}
        {meeting && !joined && meeting.decision !== 'skipped' ? (
          <Button
            label="Skip"
            accessibilityLabel="Skip meeting"
            variant="text"
            disabled={busy}
            onPress={() => void run('skip')}
          />
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing.md },
}));
