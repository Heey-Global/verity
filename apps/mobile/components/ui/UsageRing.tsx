import { Text, View } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

/** How full a quota window is, as `quotaMeterLevel` reports it. */
export type UsageRingLevel = 'calm' | 'low' | 'spent';

const STROKE = 2.6;

/**
 * One quota window as a small ring (docs/design-system.md § 5.5b): the arc is
 * the share already used, filling clockwise from 12 o'clock, and a muted line
 * across the ring marks how much of the window has passed — where usage would
 * sit now at an even pace. The label inside names the window. A meter is a
 * state, never an action or brand moment, so the arc is `text` while there is
 * room and `attention` once the window is spent. A spent window has no pace
 * left to keep, so it draws no line.
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
  // Leave room for the pace line, which reaches past the ring's outer edge.
  const radius = center - stroke / 2 - 1.6 * scale;
  const circumference = 2 * Math.PI * radius;
  const used = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  const arcColor = level === 'spent' ? theme.colors.attention : theme.colors.text;
  // A round cap reaches half a stroke past each end of the dash. Inset the
  // dash by that much at both ends so the arc starts exactly at 12 o'clock and
  // ends exactly at the used share. A full ring has no ends, and a sliver
  // shorter than the stroke cannot hold two caps, so both stay butt.
  const arcLength = (circumference * used) / 100;
  const round = used < 100 && arcLength >= stroke;
  const capInset = round ? stroke / 2 : 0;
  // The inset start is a rotation rather than a negative dash offset, which
  // not every native renderer applies the same way.
  const startAngle = -90 + (capInset / circumference) * 360;
  const pacePosition = level !== 'spent' && pace !== null && Number.isFinite(pace) ? pace : null;
  const paceEnds =
    pacePosition === null
      ? null
      : [radius - stroke / 2 - 1.4 * scale, radius + stroke / 2 + 1.4 * scale].map((r) => {
          const angle =
            (2 * Math.PI * Math.min(100, Math.max(0, pacePosition))) / 100 - Math.PI / 2;
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
            strokeLinecap={round ? 'round' : 'butt'}
            strokeDasharray={`${Math.max(0.01, arcLength - 2 * capInset)} ${circumference * 2}`}
            fill="none"
            transform={`rotate(${startAngle} ${center} ${center})`}
          />
        ) : null}
        {paceEnds !== null ? (
          <>
            {/* A gap in the background colour keeps the line readable on the arc. */}
            <Line
              x1={paceEnds[0]!.x}
              y1={paceEnds[0]!.y}
              x2={paceEnds[1]!.x}
              y2={paceEnds[1]!.y}
              stroke={theme.colors.surface}
              strokeWidth={2.6 * scale}
              strokeLinecap="round"
            />
            <Line
              testID="usage-ring-pace"
              x1={paceEnds[0]!.x}
              y1={paceEnds[0]!.y}
              x2={paceEnds[1]!.x}
              y2={paceEnds[1]!.y}
              stroke={theme.colors.textMuted}
              strokeWidth={1.1 * scale}
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
