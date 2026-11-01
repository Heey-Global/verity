import { subscribeLiveRefresh } from '../lib/liveConnection';
import { router, usePathname } from 'expo-router';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActiveLiveMeetings } from '@verity/mobile';
import {
  Animated,
  AppState,
  PanResponder,
  Pressable,
  useWindowDimensions,
  View,
} from 'react-native';
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
import {
  createVerityClient,
  getActiveMeetingServerId,
  subscribeVerityBaseUrl,
} from '../lib/client';
import {
  clearFollowedRemoteMeeting,
  followRemoteMeeting,
  subscribeFollowedRemoteMeeting,
  syncMeetingSession,
} from '../lib/liveMeetingSync';
import { subscribeMeetingPrompt } from '../lib/meetingPrompts';
import { AssignMeetingSheet, type AssignableMeeting } from './meeting/AssignMeetingSheet';
import { CalendarMeetingPrompt } from './meeting/CalendarMeetingPrompt';
import { Button, Text, useConfirm } from './ui';
import { Dot } from './ui/Status';

const WIDTH = 200;

/** Online meetings stay alive while interrupted: Core is still recovering them. */
const alive = (meeting: Pick<MeetingRecord, 'state' | 'engine'> | null | undefined) =>
  meeting?.state === 'active' ||
  (meeting?.engine === 'attendee' && meeting.state === 'interrupted');

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
  // What the server reports as running, so a meeting started elsewhere (another device,
  // or Verity joining on its own) appears without first opening its session.
  const [discovered, setDiscovered] = useState<ActiveLiveMeetings | null>(null);
  const discoveredRef = useRef(discovered);
  discoveredRef.current = discovered;
  const [assigning, setAssigning] = useState<AssignableMeeting | null>(null);
  // A calendar meeting whose notification was tapped: asks Join / Skip.
  const [upcomingKey, setUpcomingKey] = useState<string | null>(null);
  const [confirm, confirmSheet] = useConfirm();
  // Meetings seen ending: the server list may still name one until it refreshes, and
  // following it again would bounce between follow and clear.
  const settled = useRef(new Set<string>());
  const discoverRef = useRef<() => Promise<void>>(async () => undefined);
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
  useEffect(
    () =>
      subscribeMeetingPrompt((prompt) => {
        if (prompt.kind === 'upcoming') {
          setUpcomingKey(prompt.eventKey);
          return;
        }
        // "Verity joined …": open the meeting where it runs, or assign it first.
        void (async () => {
          try {
            const client = createVerityClient();
            if (!client) throw new Error('Connect to the server to open this meeting.');
            const active = await client.getActiveLiveMeetings();
            setDiscovered(active);
            const running = active.running.find((item) => item.id === prompt.meetingId);
            const unassigned = active.unassigned.find((item) => item.id === prompt.meetingId);
            if (running)
              router.push({
                pathname: '/meeting/[sessionId]',
                params: { sessionId: running.sessionId },
              });
            else if (unassigned) setAssigning(unassigned);
            else setError('This meeting has ended or was discarded.');
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        })();
      }),
    [],
  );
  // A pairing made after launch or a switch to another server starts discovery over, so the
  // card never shows, assigns or discards meetings of the previous server.
  const [serverEpoch, setServerEpoch] = useState(0);
  useEffect(
    () =>
      subscribeVerityBaseUrl(() => {
        setDiscovered(null);
        setAssigning(null);
        setUpcomingKey(null);
        setServerEpoch((value) => value + 1);
      }),
    [],
  );
  useEffect(() => {
    const client = createVerityClient();
    if (!client) return;
    let mounted = true;
    const discover = async () => {
      try {
        const active = await client.getActiveLiveMeetings();
        if (mounted) setDiscovered(active);
      } catch {
        /* Offline or an older server: keep what the device already knows. */
      }
    };
    discoverRef.current = discover;
    const detach = subscribeLiveRefresh(
      client,
      discover,
      (path) => path === '/live-meetings/active',
      [{ path: '/live-meetings/active' }],
      { initial: true },
    );
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') void discover();
    });
    return () => {
      mounted = false;
      detach();
      foreground.remove();
    };
  }, [serverEpoch]);
  useEffect(() => {
    if (!discovered || followed || alive(localMeeting)) return;
    const next = discovered.running.find(
      (item) => item.id !== localMeeting?.id && !settled.current.has(item.id),
    );
    if (next) followRemoteMeeting(next.sessionId, next.id);
  }, [discovered, followed, localMeeting]);
  const meeting = localMeeting?.state === 'active' ? localMeeting : remoteMeeting;
  const online = meeting?.engine === 'attendee';
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
        if (!saved) {
          // Not synced to this device yet (or offline): while the server still lists it as
          // running, keep following and look again on the next refresh. Clearing at once
          // would let discovery follow it again, in a loop; once it is gone, let it go.
          if (discoveredRef.current?.running.some((item) => item.id === followed.meetingId)) return;
          settled.current.add(followed.meetingId);
          clearFollowedRemoteMeeting();
          return;
        }
        if (!alive(saved)) settled.current.add(saved.id);
        if (!alive(saved)) {
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
        // Online meetings run on the server; there is no recorder to command.
        if (saved?.engine === 'attendee') return;
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
  const unassigned = discovered?.unassigned.find((item) => item.state !== 'ended') ?? null;
  const showMeeting = alive(meeting);
  useEffect(() => {
    if (!showMeeting && !unassigned) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [showMeeting, unassigned]);
  useEffect(() => {
    if (meeting?.state !== 'active') return;
    void activateKeepAwakeAsync('verity-live-meeting').catch(() => undefined);
    return () => {
      void deactivateKeepAwake('verity-live-meeting').catch(() => undefined);
    };
  }, [meeting?.state]);

  const sheets = (
    <>
      <AssignMeetingSheet
        meeting={assigning}
        onClose={() => setAssigning(null)}
        onAssigned={(sessionId) => {
          setAssigning(null);
          void discoverRef.current();
          router.push({ pathname: '/meeting/[sessionId]', params: { sessionId } });
        }}
        onDiscard={() => {
          const target = assigning;
          setAssigning(null);
          if (target) discardUnassigned(target.id);
        }}
      />
      <CalendarMeetingPrompt
        eventKey={upcomingKey}
        onClose={() => setUpcomingKey(null)}
        onJoined={() => {
          setUpcomingKey(null);
          void discoverRef.current();
        }}
      />
      {confirmSheet}
    </>
  );
  const discardUnassigned = (meetingId: string) =>
    confirm({
      title: 'Discard this meeting?',
      message: 'Verity leaves the call and deletes everything it transcribed.',
      confirmLabel: 'Discard',
      destructive: true,
      onConfirm: async () => {
        try {
          const client = createVerityClient();
          if (!client) throw new Error('Connect to the server to discard this meeting.');
          await client.discardLiveMeeting(meetingId);
          setError(null);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
        await discoverRef.current();
      },
    });

  if (pathname.startsWith('/meeting/')) return sheets;
  if (!showMeeting || !meeting) {
    if (!unassigned) return sheets;
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
          <View style={styles.titleRow}>
            <Dot intent={unassigned.state === 'interrupted' ? 'optional' : 'needsSetup'} />
            <Text variant="row" style={styles.title}>
              Online · {Math.max(0, Math.floor((now - unassigned.startedAt) / 60000))} min
            </Text>
          </View>
          <Text variant="row" numberOfLines={1}>
            {unassigned.title || 'Online meeting'}
          </Text>
          <Text variant="footnote">Not in a project yet</Text>
          {error ? (
            <Text variant="footnote" tone="attention">
              {error}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <View style={styles.grow}>
              <Button
                label="Assign"
                accessibilityLabel="Assign meeting to a project"
                size="compact"
                onPress={() => setAssigning(unassigned)}
                fullWidth
              />
            </View>
            <Button
              label="Discard"
              accessibilityLabel="Discard meeting"
              variant="secondary"
              size="compact"
              onPress={() => discardUnassigned(unassigned.id)}
            />
          </View>
        </Animated.View>
        {sheets}
      </View>
    );
  }

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
      if (remote && (!meeting.serverId || meeting.serverId !== getActiveMeetingServerId()))
        throw new Error('This meeting belongs to another server.');
      if (remote && online) {
        const client = createVerityClient();
        if (!client) throw new Error('Connect to the server to stop this meeting.');
        await client.stopOnlineMeeting(meeting.sessionId, meeting.id);
        void discoverRef.current();
      } else if (remote) {
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
            {/* Recording is shown in the problem colour, as on the meeting screen. */}
            <Dot intent={meeting.captureStatus === 'paused' ? 'optional' : 'needsSetup'} />
            <Text variant="row" style={styles.title}>
              {meeting.captureStatus === 'paused' ? 'Paused' : online ? 'Online' : 'Live meeting'} ·{' '}
              {Math.floor((now - meeting.startedAt) / 60000)} min
            </Text>
          </View>
          {meeting.title ? (
            <Text variant="row" numberOfLines={1}>
              {meeting.title}
            </Text>
          ) : null}
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
            {online ? (
              <Button
                label="Open"
                accessibilityLabel="Open live meeting"
                size="compact"
                onPress={openMeeting}
                fullWidth
              />
            ) : (
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
            )}
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
      {sheets}
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
