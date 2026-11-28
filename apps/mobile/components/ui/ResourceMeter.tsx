import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';
import { Text } from './Text';
import { tint } from './tint';

/** From here a share reads as a warning (docs/design-system.md § 5.5c). */
const RESOURCE_BUSY_PERCENT = 90;

const busy = (share: number | null) => share !== null && share >= RESOURCE_BUSY_PERCENT;
const clamp = (share: number) => Math.min(100, Math.max(0, Number.isFinite(share) ? share : 0));

/**
 * One measured resource as a single figure — its icon and current share — for
 * the collapsed form of a set of meters (docs/design-system.md § 5.5c). A share
 * from 90 % takes `attention`, icon and figure alike.
 */
export function ResourceFigure({
  icon,
  label,
  share,
}: {
  icon: IconName;
  /** The spoken name: `CPU`, `RAM`, `Disk`. */
  label: string;
  share: number | null;
}) {
  const { theme } = useUnistyles();
  const warn = busy(share);
  return (
    <View
      style={styles.figure}
      accessible
      accessibilityLabel={`${label} ${share === null ? 'not measured' : `${Math.round(share)} percent`}`}
    >
      <Icon name={icon} size={14} color={warn ? theme.colors.attention : theme.colors.textMuted} />
      <Text variant="bodySmall" tone={warn ? 'attention' : 'default'} style={styles.value}>
        {share === null ? '–' : `${Math.round(share)}%`}
      </Text>
    </View>
  );
}

/**
 * One measured resource of a machine (docs/design-system.md § 5.5c): an icon and
 * label on the left, the current share on the right, and under them either the
 * recent history as bars (`history`, for something that moves from minute to
 * minute, like CPU) or one fill bar (`fill`, for something that grows over days,
 * like a disk). Every history slot is a faint full-height column, so the strip
 * shows its scale and its full width from the first reading.
 */
export function ResourceMeter({
  icon,
  label,
  share,
  history,
  slots = 30,
  testID,
}: {
  icon: IconName;
  /** What is measured and its size: `CPU · 8 cores`, `RAM · 5.0 / 15.5 GB`. */
  label: string;
  /** The current used share, 0–100, or null when it could not be measured. */
  share: number | null;
  /** Earlier shares, oldest first, the current one last. Omitted: a fill bar. */
  history?: readonly (number | null)[] | undefined;
  /** How many readings the history strip holds. */
  slots?: number;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  const warn = busy(share);
  const valueText = share === null ? '–' : `${Math.round(share)}%`;
  return (
    <View
      style={styles.meter}
      testID={testID}
      accessible
      accessibilityLabel={`${label}, ${share === null ? 'not measured' : `${Math.round(share)} percent used`}`}
    >
      <View style={styles.head}>
        <Icon name={icon} size={16} color={theme.colors.textMuted} />
        <Text variant="bodySmall" tone="muted" numberOfLines={1} style={styles.label}>
          {label}
        </Text>
        <Text variant="row" tone={warn ? 'attention' : 'default'} style={styles.value}>
          {valueText}
        </Text>
      </View>
      {history === undefined ? (
        <View style={styles.track} testID={testID === undefined ? undefined : `${testID}-fill`}>
          <View
            style={[
              styles.fill,
              { width: `${share === null ? 0 : clamp(share)}%` },
              warn ? styles.fillBusy : null,
            ]}
          />
        </View>
      ) : (
        <View style={styles.strip} testID={testID === undefined ? undefined : `${testID}-history`}>
          {Array.from({ length: slots }, (_, index) => {
            const sample = history[history.length - slots + index];
            const measured = sample !== undefined && sample !== null;
            // Every slot is a full-height column, so the strip shows its scale
            // (0 to 100 %) even while the readings stay low.
            return (
              <View key={index} style={styles.slot}>
                {measured ? (
                  <View
                    testID={testID === undefined ? undefined : `${testID}-bar`}
                    style={[
                      styles.bar,
                      { height: `${Math.max(4, clamp(sample))}%` },
                      index === slots - 1 ? styles.barLatest : null,
                      busy(sample) ? styles.barBusy : null,
                    ]}
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The room above separates one meter from the strip of the one before it.
  meter: { gap: theme.spacing.sm, paddingTop: theme.spacing.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  label: { flex: 1 },
  figure: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs },
  value: { fontVariant: ['tabular-nums'] },
  // A meter is a state, never an action: the bars are `textMuted`, the current
  // one `text`, and a busy reading `attention`, each in a faint full column.
  strip: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.spacing.xxs,
    height: 36,
  },
  slot: {
    flex: 1,
    height: '100%',
    justifyContent: 'flex-end',
    borderRadius: theme.radius.sm / 3,
    backgroundColor: tint(theme.colors.text, 'neutral'),
    overflow: 'hidden',
  },
  bar: { width: '100%', backgroundColor: theme.colors.textMuted },
  barLatest: { backgroundColor: theme.colors.text },
  barBusy: { backgroundColor: theme.colors.attention },
  track: {
    height: 6,
    borderRadius: theme.radius.pill,
    backgroundColor: tint(theme.colors.text, 'neutral'),
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.text,
  },
  fillBusy: { backgroundColor: theme.colors.attention },
}));
