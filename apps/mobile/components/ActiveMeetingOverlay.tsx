import { router, usePathname } from 'expo-router';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  endMeeting,
  pauseMeeting,
  resumeMeeting,
  subscribeMeeting,
} from '../lib/liveMeetingSession';
import type { MeetingRecord } from '../lib/liveMeetingStore';

const WIDTH = 200;

export function ActiveMeetingOverlay() {
  const [meeting, setMeeting] = useState<MeetingRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => subscribeMeeting(setMeeting), []);
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
    if (busy || (meeting.captureStatus !== 'listening' && meeting.captureStatus !== 'paused'))
      return;
    setBusy(true);
    try {
      if (meeting.captureStatus === 'paused') await resumeMeeting();
      else await pauseMeeting();
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await endMeeting();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
      openMeeting();
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
        style={{
          position: 'absolute',
          top,
          right: 12,
          width: WIDTH,
          minHeight: 105,
          transform: position.getTranslateTransform(),
          backgroundColor: '#211d2d',
          borderColor: '#655b82',
          borderWidth: 1,
          borderRadius: 16,
          padding: 12,
          gap: 8,
          shadowColor: '#000',
          shadowOpacity: 0.35,
          shadowRadius: 12,
          elevation: 8,
        }}
      >
        <Pressable
          onPress={openMeeting}
          accessibilityRole="button"
          accessibilityLabel="Return to live meeting"
        >
          <Text style={{ color: '#eee9f7', fontWeight: '700' }}>
            {meeting.captureStatus === 'paused' ? 'Ⅱ Paused' : '● Live Meeting'} ·{' '}
            {Math.floor((now - meeting.startedAt) / 60000)} min
          </Text>
          <Text style={{ color: '#aaa2ba', fontSize: 11 }}>Drag to move · Open meeting</Text>
        </Pressable>
        {error ? <Text style={{ color: '#ffaba5', fontSize: 11 }}>{error}</Text> : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable
            onPress={togglePause}
            disabled={
              busy || (meeting.captureStatus !== 'listening' && meeting.captureStatus !== 'paused')
            }
            accessibilityRole="button"
            accessibilityLabel={
              meeting.captureStatus === 'paused' ? 'Resume meeting' : 'Pause meeting'
            }
            style={{
              flex: 1,
              alignItems: 'center',
              padding: 7,
              borderRadius: 9,
              backgroundColor: '#383149',
            }}
          >
            <Text style={{ color: '#eee9f7' }}>
              {meeting.captureStatus === 'paused' ? '▶ Resume' : 'Ⅱ Pause'}
            </Text>
          </Pressable>
          <Pressable
            onPress={stop}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Stop meeting"
            style={{
              alignItems: 'center',
              padding: 7,
              borderRadius: 9,
              borderColor: '#a9475d',
              borderWidth: 1,
            }}
          >
            <Text style={{ color: '#ff6878' }}>■ Stop</Text>
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}
