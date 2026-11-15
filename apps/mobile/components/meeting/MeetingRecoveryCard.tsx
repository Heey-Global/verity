import { useState } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { getActiveMeetingServerId } from '../../lib/client';
import type { MeetingRecord } from '../../lib/liveMeetingStore';
import {
  finalizeMeetingOnServer,
  retryMeetingSync,
  type MeetingSyncFailure,
} from '../../lib/liveMeetingSync';
import { Button, Text, useConfirm } from '../ui';
import { NoticedCard } from './MeetingUI';

type Confirm = ReturnType<typeof useConfirm>[0];
type PendingCommand = 'pause' | 'resume' | 'stop' | null;

/**
 * Whether a device that is not recording should offer to end the meeting without its
 * recorder: the recorder stopped reporting, or a stop is waiting for it. Only that
 * recorder can acknowledge a stop, so without this the meeting stays running everywhere.
 */
export function canEndWithoutRecorder(
  meeting: Pick<MeetingRecord, 'engine' | 'serverId' | 'state'>,
  recordingHere: boolean,
  recorderUnreachable: boolean,
  pendingCommand: PendingCommand,
): boolean {
  return (
    meeting.state === 'active' &&
    meeting.engine !== 'attendee' &&
    !recordingHere &&
    meeting.serverId != null &&
    meeting.serverId === getActiveMeetingServerId() &&
    (recorderUnreachable || pendingCommand === 'stop')
  );
}

/**
 * Asks before ending a meeting on the server while its recording device is away. Ending
 * keeps everything the server has received; the device stops and sends the rest once it
 * reconnects. A failure is reported through `onError` and closes the confirmation.
 */
export function confirmEndWithoutRecorder(
  confirm: Confirm,
  meeting: Pick<MeetingRecord, 'id' | 'sessionId'>,
  handlers: { onEnded: () => void | Promise<void>; onError: (message: string) => void },
): void {
  confirm({
    title: 'End without the recording device?',
    message:
      'Verity ends the meeting with the transcript it has received so far and prepares the result. Nothing is deleted. The recording device stops and sends what it still has when it next opens Verity.',
    confirmLabel: 'End meeting',
    onConfirm: async () => {
      try {
        await finalizeMeetingOnServer(meeting.sessionId, meeting.id);
      } catch (reason) {
        handlers.onError(
          reason instanceof Error ? reason.message : 'The meeting could not be ended. Try again.',
        );
        return;
      }
      await handlers.onEnded();
    },
  });
}

/**
 * Recovery for a meeting whose server state needs a hand: the recorder's sync failed, or
 * another device's recorder can no longer be reached.
 */
export function MeetingRecoveryCard({
  meeting,
  live,
  recordingHere,
  recorderOnline,
  pendingCommand,
  syncFailure,
  onRecovered,
  onError,
}: {
  meeting: MeetingRecord | null;
  live: boolean;
  recordingHere: boolean;
  recorderOnline: boolean;
  pendingCommand: PendingCommand;
  syncFailure: MeetingSyncFailure | null;
  onRecovered: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const { theme } = useUnistyles();
  const [recovery, setRecovery] = useState<'end' | 'retry' | null>(null);
  const [confirm, confirmSheet] = useConfirm();
  if (!meeting || meeting.engine === 'attendee') return null;
  const sameServer = meeting.serverId === getActiveMeetingServerId();

  const run = async (action: 'end' | 'retry') => {
    if (recovery) return;
    setRecovery(action);
    onError(null);
    try {
      if (!meeting.serverId || !sameServer)
        throw new Error('Reconnect to this meeting’s server to recover sync.');
      if (action === 'end') await finalizeMeetingOnServer(meeting.sessionId, meeting.id);
      else await retryMeetingSync(meeting.sessionId, meeting.id);
      await onRecovered();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Meeting recovery failed. Try again.');
    } finally {
      setRecovery(null);
    }
  };

  if (!syncFailure) {
    if (!canEndWithoutRecorder(meeting, recordingHere, !recorderOnline, pendingCommand))
      return null;
    return (
      <>
        <NoticedCard
          tone={theme.colors.attention}
          label="Recording device"
          title={recorderOnline ? 'Stop not confirmed yet' : 'Recorder not reporting'}
          body={
            recorderOnline
              ? 'The device that records this meeting has not confirmed the stop yet. If it no longer records, end the meeting here.'
              : 'The device that records this meeting has stopped reporting. Open Verity there, or end the meeting with the transcript received so far.'
          }
        >
          <Button
            label="End without recording device"
            onPress={() => {
              onError(null);
              confirmEndWithoutRecorder(confirm, meeting, {
                onEnded: () => onRecovered().catch(() => undefined),
                onError,
              });
            }}
            fullWidth
          />
        </NoticedCard>
        {confirmSheet}
      </>
    );
  }

  const localTranscriptSaved =
    Boolean(meeting.ownerToken) && !meeting.error?.startsWith('Local save failed');
  return (
    <NoticedCard
      tone={theme.colors.attention}
      label="Sync needs attention"
      title={
        live
          ? 'Transcript sync needs attention'
          : syncFailure.serverFinalized
            ? 'Meeting ended on server'
            : 'Server end not confirmed'
      }
      body={
        live
          ? localTranscriptSaved
            ? 'Your transcript is saved on this device, but changes could not be sent to the server. Check recording status before leaving.'
            : 'Meeting updates could not be sent to the server. Check the recording device before ending the meeting.'
          : syncFailure.serverFinalized
            ? 'The server meeting has ended. Some transcript changes have not been synced. Keep this device’s copy until sync succeeds.'
            : localTranscriptSaved
              ? 'Recording has stopped on this device. Your transcript is saved here. Sync failed, so we cannot confirm that the meeting has ended on the server.'
              : 'The meeting has stopped locally, but its end on the server is not confirmed. Check the local save error before leaving this screen.'
      }
    >
      <View style={styles.block}>
        {!live && meeting.ownerToken && !syncFailure.serverFinalized ? (
          <>
            <Button
              label="End on server"
              onPress={() => void run('end')}
              loading={recovery === 'end'}
              disabled={recovery !== null || !sameServer}
              fullWidth
            />
            <Text variant="footnote" tone="muted">
              Keep the transcript already received by the server and end the meeting there.
            </Text>
          </>
        ) : null}
        <Button
          label="Retry sync"
          variant="secondary"
          icon="refresh-cw"
          onPress={() => void run('retry')}
          loading={recovery === 'retry'}
          disabled={recovery !== null || !sameServer}
          fullWidth
        />
        <Text variant="footnote" tone="muted">
          {sameServer
            ? 'Try sending the saved transcript again.'
            : 'Reconnect to this meeting’s server to recover sync.'}
        </Text>
      </View>
    </NoticedCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  block: { gap: theme.spacing.md },
}));
