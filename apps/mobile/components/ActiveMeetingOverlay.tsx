import { subscribeLiveRefresh } from '../lib/liveConnection';
import { router, usePathname } from 'expo-router';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, useWindowDimensions, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  endMeeting,
  pauseMeeting,
  resumeMeeting,
  subscribeMeeting,
  subscribeVoiceMeetingRequest,
} from '../lib/liveMeetingSession';
import { listMeetings, type MeetingRecord } from '../lib/liveMeetingStore';
import { createVerityClient, getActiveMeetingServerId } from '../lib/client';
import {
  clearFollowedRemoteMeeting,
  subscribeFollowedRemoteMeeting,
  syncMeetingSession,
} from '../lib/liveMeetingSync';
import { Button, Text } from './ui';
import { Dot } from './ui/Status';

const WIDTH = 200;

export function ActiveMeetingOverlay() {
  const [localMeeting, setLocalMeeting] = useState<MeetingRecord | null>(null);
  const [remoteMeeting, setRemoteMeeting] = useState<MeetingRecord | null>(null);
  const [followed, setFollowed] = useState<{
    serverId: string;
    sessionId: string;
    meetingId: string;
  } | null>(null);
  const [pendingCommand, setPendingCommand] = useState<'pause' | 'resume' | 'stop' | null>(null);
  const [recorderOnline, setRecorderOnline] = useState(true);
  const remoteStopRequested = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceSending, setVoiceSending] = useState(false);
  const [voiceRequestSent, setVoiceRequestSent] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [overlayHeight, setOverlayHeight] = useState(105);
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const position = useRef(new Animated.ValueXY()).current;
  const origin = useRef({ x: 0, y: 0 });
  const top = insets.top + 12;
  const bottomLimit = Math.max(0, height - top - overlayHeight - insets.bottom - 16);
  const leftLimit = Math.min(0, WIDTH + 24 - width);
  const clamp = (x: number, y: number) => ({
    x: Math.max(leftLimit, Math.min(0, x)),
    y: Math.max(0, Math.min(bottomLimit, y)),
  });

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          Math.abs(gesture.dx) > 6 || Math.abs(gesture.dy) > 6,
        onPanResponderMove: (_, gesture) => {
          position.setValue(clamp(origin.current.x + gesture.dx, origin.current.y + gesture.dy));
        },
        onPanResponderRelease: (_, gesture) => {
          origin.current = clamp(origin.current.x + gesture.dx, origin.current.y + gesture.dy);
          position.setValue(origin.current);
        },
      }),
    [bottomLimit, leftLimit, position],
  );

  useEffect(() => {
    origin.current = clamp(origin.current.x, origin.current.y);
    position.setValue(origin.current);
  }, [bottomLimit, leftLimit, position]);

  useEffect(() => subscribeMeeting(setLocalMeeting), []);
  useEffect(() => setVoiceRequestSent(false), [localMeeting?.id]);
  useEffect(
    () =>
      subscribeVoiceMeetingRequest((event) => {
        if (event.meetingId !== localMeeting?.id) return;
        setVoiceSending(event.status === 'sending');
        if (event.status === 'failed') setError(event.message ?? 'Voice request failed.');
        if (event.status === 'sending') {
          setError(null);
          setVoiceRequestSent(false);
        }
        if (event.status === 'sent') setVoiceRequestSent(true);
      }),
    [localMeeting?.id],
  );
  useEffect(() => subscribeFollowedRemoteMeeting(setFollowed), []);
  const meeting = localMeeting?.state === 'active' ? localMeeting : remoteMeeting;
  const remote =
    meeting !== null && meeting.id === remoteMeeting?.id && localMeeting?.id !== meeting.id;
  const activePendingCommand = remote ? pendingCommand : null;
  useEffect(() => {
    if (!followed || pathname.startsWith('/meeting/')) return;
    let mounted = true;
    let polling = false;
    const client = createVerityClient();
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        if (getActiveMeetingServerId() !== followed.serverId) {
          clearFollowedRemoteMeeting();
          setRemoteMeeting(null);
          return;
        }
        await syncMeetingSession(followed.sessionId);
        if (getActiveMeetingServerId() !== followed.serverId) return;
        const saved =
          (await listMeetings(followed.sessionId)).find((item) => item.id === followed.meetingId) ??
          null;
        if (!mounted) return;
        setRemoteMeeting(saved);
        if (saved?.state !== 'active') {
          clearFollowedRemoteMeeting();
          setPendingCommand(null);
          if (remoteStopRequested.current) {
            remoteStopRequested.current = false;
            router.push({
              pathname: '/meeting/[sessionId]',
              params: { sessionId: followed.sessionId },
            });
          }
          return;
        }
        const control = await client?.getLiveMeetingCommands(
          followed.sessionId,
          followed.meetingId,
        );
        if (!mounted || !control) return;
        setRecorderOnline(control.recorderOnline);
        const latest = control.commands[0];
        setPendingCommand(latest?.state === 'pending' ? latest.action : null);
        if (latest?.state === 'failed') {
          remoteStopRequested.current = false;
          setError(latest.error ?? 'Meeting control failed.');
        }
      } catch {
        if (mounted) setError('Waiting for the recording device…');
      } finally {
        polling = false;
      }
    };
    void poll();
    const detach = client
      ? subscribeLiveRefresh(
          client,
          () => poll(),
          (path) => path.includes('/live-meetings'),
          [{ path: `/sessions/${encodeURIComponent(followed.sessionId)}/live-meetings` }],
        )
      : () => undefined;
    return () => {
      mounted = false;
      detach();
    };
  }, [followed?.serverId, followed?.sessionId, followed?.meetingId, pathname, pendingCommand]);
  useEffect(() => {
    if (meeting?.state !== 'active') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [meeting?.state]);
  useEffect(() => {
    if (meeting?.state !== 'active') return;
    void activateKeepAwakeAsync('verity-live-meeting').catch(() => undefined);
    return () => {
      void deactivateKeepAwake('verity-live-meeting').catch(() => undefined);
    };
  }, [meeting?.state]);

  if (meeting?.state !== 'active' || pathname.startsWith('/meeting/')) return null;

  const openMeeting = () =>
    router.push({ pathname: '/meeting/[sessionId]', params: { sessionId: meeting.sessionId } });
  const togglePause = async () => {
    if (
      busy ||
      activePendingCommand ||
      (meeting.captureStatus !== 'listening' && meeting.captureStatus !== 'paused')
    )
      return;
    setBusy(true);
    try {
      if (remote) {
        if (!meeting.serverId || meeting.serverId !== getActiveMeetingServerId())
          throw new Error('This meeting belongs to another server.');
        const client = createVerityClient();
        if (!client) throw new Error('Connect to the server to control this recording.');
        const action = meeting.captureStatus === 'paused' ? 'resume' : 'pause';
        await client.requestLiveMeetingCommand(meeting.sessionId, meeting.id, action);
        setPendingCommand(action);
      } else if (meeting.captureStatus === 'paused') await resumeMeeting();
      else await pauseMeeting();
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (busy || activePendingCommand === 'stop') return;
    setBusy(true);
    try {
      if (remote) {
        if (!meeting.serverId || meeting.serverId !== getActiveMeetingServerId())
          throw new Error('This meeting belongs to another server.');
        const client = createVerityClient();
        if (!client) throw new Error('Connect to the server to stop this recording.');
        await client.requestLiveMeetingCommand(meeting.sessionId, meeting.id, 'stop');
        remoteStopRequested.current = true;
        setPendingCommand('stop');
      } else await endMeeting();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
      if (!remote) openMeeting();
    }
  };

  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
    >
      <Animated.View
        {...pan.panHandlers}
        onLayout={(event) => setOverlayHeight(event.nativeEvent.layout.height)}
        style={[styles.card, { top, width: WIDTH, transform: position.getTranslateTransform() }]}
      >
        <Pressable
          onPress={openMeeting}
          accessibilityRole="button"
          accessibilityLabel="Return to live meeting"
        >
          <View style={styles.titleRow}>
            <Dot intent={meeting.captureStatus === 'paused' ? 'optional' : 'ready'} />
            <Text variant="row" style={styles.title}>
              {meeting.captureStatus === 'paused' ? 'Paused' : 'Live meeting'} ·{' '}
              {Math.floor((now - meeting.startedAt) / 60000)} min
            </Text>
          </View>
          <Text variant="footnote">
            {activePendingCommand
              ? recorderOnline
                ? `Waiting to ${activePendingCommand} · keep recorder app open`
                : 'Recorder unreachable · open Verity there'
              : 'Drag to move · Open meeting'}
          </Text>
        </Pressable>
        {error ? (
          <Text variant="footnote" tone="attention">
            {error}
          </Text>
        ) : null}
        {voiceSending ? <Text variant="footnote">Sending voice request…</Text> : null}
        {voiceRequestSent ? (
          <Text variant="footnote">Answer will appear in the meeting</Text>
        ) : null}
        <View style={styles.actions}>
          <View style={styles.grow}>
            <Button
              label={meeting.captureStatus === 'paused' ? 'Resume' : 'Pause'}
              accessibilityLabel={
                meeting.captureStatus === 'paused' ? 'Resume meeting' : 'Pause meeting'
              }
              icon={meeting.captureStatus === 'paused' ? 'play' : 'pause'}
              variant="secondary"
              size="compact"
              disabled={
                busy ||
                !!activePendingCommand ||
                (meeting.captureStatus !== 'listening' && meeting.captureStatus !== 'paused')
              }
              onPress={togglePause}
              fullWidth
            />
          </View>
          <Button
            label="Stop"
            accessibilityLabel="Stop meeting"
            icon="square"
            variant="destructive"
            size="compact"
            disabled={busy || activePendingCommand === 'stop'}
            onPress={stop}
          />
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    position: 'absolute',
    right: theme.spacing.md,
    minHeight: 105,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    ...theme.elevation.floating,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  title: { flexShrink: 1 },
  actions: { flexDirection: 'row', gap: theme.spacing.sm },
  grow: { flex: 1 },
}));
