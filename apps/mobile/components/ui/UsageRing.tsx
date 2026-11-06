import { Text, View } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

/** How full a quota window is, as `quotaMeterLevel` reports it. */
export type UsageRingLevel = 'calm' | 'low' | 'spent';

const STROKE = 2.6;

/**
 * One quota window as a small ring (docs/design-system.md § 5.5b): the arc is
 * the share already used, the notch marks where usage would sit now at an even
 * pace, and the label inside names the window. A meter is a state, never an
 * action or brand moment, so the arc is muted while there is room, `text` once
 * the window runs low and `attention` once it is spent. A spent window has no
 * pace left to keep, so it draws no notch.
 *
 * The ring is decoration for the text beside it; the caller owns the spoken
 * label.
 */
export function UsageRing({
  label,
  percent,
  pace,
  level,
  size = 26,
}: {
  label: string;
  /** Used share, 0–100. Values outside are clamped. */
  percent: number;
  /** Even-pace position, 0–100, or null when the window has none. */
  pace: number | null;
  level: UsageRingLevel;
  size?: number;
}) {
  const { theme } = useUnistyles();
  const scale = size / 26;
  const stroke = STROKE * scale;
  const center = size / 2;
  // Leave room for the notch, which reaches past the ring's outer edge.
  const radius = center - stroke / 2 - 1.4 * scale;
  const circumference = 2 * Math.PI * radius;
  const used = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  const arcColor =
    level === 'spent'
      ? theme.colors.attention
      : level === 'low'
        ? theme.colors.text
        : theme.colors.textMuted;
  const notch = level !== 'spent' && pace !== null && Number.isFinite(pace) ? pace : null;
  const notchEnds =
    notch === null
      ? null
      : [radius - stroke, radius + stroke].map((r) => {
          const angle = (2 * Math.PI * Math.min(100, Math.max(0, notch))) / 100 - Math.PI / 2;
          return { x: center + r * Math.cos(angle), y: center + r * Math.sin(angle) };
        });
  return (
    <View
      style={[styles.ring, { width: size, height: size }]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={size} height={size}>
        <Circle
          cx={center}
          cy={center}
          r={radius}
          stroke={theme.colors.border}
          strokeWidth={stroke}
          fill="none"
        />
        {used > 0 ? (
          <Circle
            testID="usage-ring-arc"
            cx={center}
            cy={center}
            r={radius}
            stroke={arcColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            // A full circle with a round cap would close on itself; stop just short.
            strokeDasharray={`${(circumference * Math.min(used, 99.6)) / 100} ${circumference}`}
            fill="none"
            transform={`rotate(-90 ${center} ${center})`}
          />
        ) : null}
        {notchEnds !== null ? (
          <>
            {/* A halo in the background colour keeps the notch readable on the arc. */}
            <Line
              x1={notchEnds[0]!.x}
              y1={notchEnds[0]!.y}
              x2={notchEnds[1]!.x}
              y2={notchEnds[1]!.y}
              stroke={theme.colors.surface}
              strokeWidth={3.2 * scale}
              strokeLinecap="round"
            />
            <Line
              testID="usage-ring-notch"
              x1={notchEnds[0]!.x}
              y1={notchEnds[0]!.y}
              x2={notchEnds[1]!.x}
              y2={notchEnds[1]!.y}
              stroke={theme.colors.text}
              strokeWidth={1.5 * scale}
              strokeLinecap="round"
            />
          </>
        ) : null}
      </Svg>
      <View style={styles.labelBox} pointerEvents="none">
        <Text style={styles.label} numberOfLines={1} maxFontSizeMultiplier={1}>
          {label}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  ring: {
    flexShrink: 0,
  },
  labelBox: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    ...theme.typography.caption,
    fontFamily: theme.fonts.bold,
    color: theme.colors.textMuted,
  },
}));
