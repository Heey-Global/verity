// Presentational pieces of the connection diagnostics screen. They hold no
// capture, Stop or storage logic; ConnectionRecording and
// SelectedConnectionTest keep owning those and only describe their state here.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Card, CardHead, StatusTag, Text } from '../ui';
import type { ConnectionDiagnosticReport } from '../../lib/connectionDiagnosticReport';

/** One test: what it does, where it stands, and its single next action. */
export function TestCard({
  title,
  description,
  attention = false,
  children,
}: {
  title: string;
  description: string;
  attention?: boolean;
  children?: ReactNode;
}) {
  return (
    <Card stacked attention={attention}>
      <CardHead title={title} subtitle={description} />
      {children}
    </Card>
  );
}

/** "Step 2 of 4 · Turn VPN off…" with one segment per step. */
export function StepIndicator({ steps, current }: { steps: readonly string[]; current: number }) {
  const index = Math.min(Math.max(current, 0), steps.length - 1);
  return (
    <View style={styles.steps} accessibilityRole="progressbar">
      <View style={styles.segments}>
        {steps.map((step, position) => (
          <View
            key={step}
            style={[styles.segment, position <= index ? styles.segmentDone : null]}
          />
        ))}
      </View>
      <Text variant="caption">{`Step ${String(index + 1)} of ${String(steps.length)} · ${steps[index]!}`}</Text>
    </View>
  );
}

export type StatusTone = 'ok' | 'problem' | 'neutral';

/** The current state in plain words, with an optional explanation. */
export function StatusLine({
  title,
  detail,
  tone = 'neutral',
}: {
  title: string;
  detail?: string | undefined;
  tone?: StatusTone;
}) {
  return (
    <View style={styles.status}>
      <Text variant="row" tone={tone === 'problem' ? 'attention' : undefined}>
        {title}
      </Text>
      {detail ? <Text variant="subtitle">{detail}</Text> : null}
    </View>
  );
}

/** App, Core and Uplink as small available/missing tags. */
export function SourceTags({ sources }: { sources: ConnectionDiagnosticReport['sources'] }) {
  return (
    <View style={styles.tags}>
      {(['app', 'core', 'uplink'] as const).map((source) => (
        <StatusTag
          key={source}
          intent={sources[source] ? 'ready' : 'needsSetup'}
          label={`${sourceNames[source]} ${sources[source] ? '✓' : '✗'}`}
        />
      ))}
    </View>
  );
}

export function Actions({ children }: { children: ReactNode }) {
  return <View style={styles.actions}>{children}</View>;
}

export { Button };

const sourceNames = { app: 'App', core: 'Core', uplink: 'Uplink' } as const;

/** "Complete" or "Incomplete – Core and Uplink data missing". */
export function completeness(report: Pick<ConnectionDiagnosticReport, 'complete' | 'sources'>) {
  if (report.complete) return 'Complete';
  const missing = (['app', 'core', 'uplink'] as const)
    .filter((source) => !report.sources[source])
    .map((source) => sourceNames[source]);
  if (missing.length === 0) return 'Incomplete – some details could not be confirmed';
  return `Incomplete – ${joinNames(missing)} data missing`;
}

function joinNames(names: string[]) {
  return names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

const testNames: Record<string, string> = {
  quick_test: 'Quick test',
  problem_recording: 'Long test',
};
/** Reports from older app versions may carry another type; name them neutrally. */
export function testName(type: string) {
  return testNames[type] ?? 'Connection test';
}

/** Local, relative wording for a report time: "Today, 20:34", "Yesterday, …", "15 Oct, …". */
export function formatReportTime(iso: string | null, now: Date = new Date()) {
  if (!iso) return 'Earlier test';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'Earlier test';
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  const month = months[date.getMonth()]!;
  return date.getFullYear() === now.getFullYear()
    ? `${String(date.getDate())} ${month}, ${time}`
    : `${String(date.getDate())} ${month} ${String(date.getFullYear())}, ${time}`;
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (value: number) => String(value).padStart(2, '0');

/**
 * A short wait after discarding a run whose Core/Uplink Stop is unconfirmed:
 * the server side may still record that run until it expires, so a new test
 * must not start on top of it. The deadline is persisted before the run is
 * removed, so reopening Diagnostics or restarting the app keeps waiting.
 * `held()` reads it without a render and holds until the stored value is read.
 */
const MAXIMUM_HOLD_MS = 10 * 60_000;
export function useHold(persistKey: string | null) {
  const until = useRef(0);
  const restored = useRef(false);
  const [left, setLeft] = useState(0);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    until.current = 0;
    restored.current = false;
    setLeft(0);
    setLoaded(false);
    void (async () => {
      try {
        const raw = persistKey ? await AsyncStorage.getItem(persistKey) : null;
        const value = raw === null ? 0 : Number(raw);
        // A deadline beyond the longest possible wait is corrupt; ignore it.
        if (live && Number.isFinite(value) && value <= Date.now() + MAXIMUM_HOLD_MS) {
          // A hold set while this read was pending is newer; never shorten it.
          until.current = Math.max(until.current, value);
          setLeft(Math.max(0, Math.ceil((until.current - Date.now()) / 1000)));
        }
      } catch {
        /* An unreadable deadline must not block testing forever. */
      } finally {
        if (live) {
          restored.current = true;
          setLoaded(true);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [persistKey]);
  const counting = left > 0;
  useEffect(() => {
    if (!counting) return;
    // Re-read the deadline on an interval: an early tick yielding the same value
    // must not stop the countdown with both tests still locked.
    const timer = setInterval(
      () => setLeft(Math.max(0, Math.ceil((until.current - Date.now()) / 1000))),
      500,
    );
    return () => clearInterval(timer);
  }, [counting]);
  const hold = useCallback(
    async (untilMs: number) => {
      if (untilMs <= Date.now()) return;
      if (persistKey) await AsyncStorage.setItem(persistKey, String(untilMs));
      until.current = untilMs;
      setLeft(Math.max(0, Math.ceil((untilMs - Date.now()) / 1000)));
    },
    [persistKey],
  );
  const held = useCallback(() => !restored.current || until.current > Date.now(), []);
  return [left, hold, held, loaded] as const;
}

export function holdReason(seconds: number) {
  return `Core and Uplink are still finishing the previous test · ready in ${String(seconds)} s`;
}

/** A confirmation that disappears by itself, so it never reads as current state. */
export function useTransientMessage(durationMs = 4000) {
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const show = useCallback(
    (next: string) => {
      if (timer.current) clearTimeout(timer.current);
      setMessage(next);
      timer.current = setTimeout(() => setMessage(''), durationMs);
    },
    [durationMs],
  );
  return [message, show] as const;
}

export function Toast({ message }: { message: string }) {
  if (!message) return null;
  return (
    <View style={styles.toast} accessibilityLiveRegion="polite">
      <Text variant="bodySmall">{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  steps: { gap: theme.spacing.xs },
  segments: { flexDirection: 'row', gap: theme.spacing.xs },
  segment: {
    flex: 1,
    height: 4,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.textFaint,
    opacity: 0.35,
  },
  segmentDone: { backgroundColor: theme.colors.success, opacity: 1 },
  status: { gap: theme.spacing.xxs },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  actions: { gap: theme.spacing.sm },
  toast: {
    marginTop: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
}));
