// A pulsing magenta dot signalling that an agent is actively working (#387) — the
// session list's subtle stand-in for a "Running" label, echoing the magenta
// progress bar in the session view. Pure presentation: the caller decides WHEN an
// agent is running (status === 'running'); unmounting it removes the signal. Its
// opacity is driven by the SHARED pulse clock, so it breathes in lock-step with the
// running-CI icons on the right of the row.
import { Animated } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useSyncedPulse } from '../lib/pulse';

// `label` lets non-session callers (e.g. a project that is starting its container)
// reuse the exact same "work in progress" signal without announcing "Agent is
// working" to screen readers.
export function WorkingDot({
  size = 9,
  label = 'Agent is working',
}: {
  size?: number;
  label?: string;
}) {
  const { theme } = useUnistyles();
  const pulse = useSyncedPulse();

  return (
    <Animated.View
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: theme.colors.accent,
        opacity: pulse,
      }}
    />
  );
}
