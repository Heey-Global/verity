import type { ReactNode } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../../components/Icon';
import { Button, SwipeActionLane, Text } from '../../components/ui';

const ignore = () => undefined;

export interface LaneAction {
  label: string;
  icon: IconName;
  destructive?: boolean;
}

/**
 * A row held open after a short swipe to the left, drawn with the app's own
 * swipe lanes. The row stays readable beside them here; in the app it slides
 * under the finger.
 */
export function SwipedOpen({ actions, children }: { actions: LaneAction[]; children: ReactNode }) {
  return (
    <View style={styles.swiped}>
      <View style={styles.slid}>{children}</View>
      <SwipeActionLane
        actions={actions.map((action) => ({
          key: action.label,
          label: action.label,
          icon: action.icon,
          tone: action.destructive ? 'destructive' : 'action',
          onPress: ignore,
        }))}
      />
    </View>
  );
}

/** The "‹ verity › Sources › meetings" line above an embedded library. */
export function LibraryPath({ levels }: { levels: string[] }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.path}>
      <Button label="verity" icon="chevron-left" variant="text" size="compact" onPress={ignore} />
      {levels.map((level, index) => (
        <View key={level} style={styles.path}>
          <Icon name="chevron-right" size={14} color={theme.colors.textFaint} />
          {index === levels.length - 1 ? (
            <Text variant="subtitle" numberOfLines={1}>
              {level}
            </Text>
          ) : (
            <Button label={level} variant="text" size="compact" onPress={ignore} />
          )}
        </View>
      ))}
    </View>
  );
}

/** The project page's wide layout: the library on the left, `pane` on the right.
 *  A phone shows the library alone, or the pane alone when there is one. */
export function LibraryLayout({ list, pane }: { list: ReactNode; pane?: ReactNode }) {
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  if (!wide && pane) return <View style={styles.root}>{pane}</View>;
  const column = <ScrollView contentContainerStyle={styles.column}>{list}</ScrollView>;
  if (!wide) return <View style={styles.root}>{column}</View>;
  return (
    <View style={[styles.root, styles.split]}>
      <View style={styles.left}>{column}</View>
      <View style={styles.right}>
        {pane ?? (
          <View style={styles.empty}>
            <Text variant="body" tone="muted">
              Select a file to read it here.
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  split: { flexDirection: 'row' },
  left: {
    width: 440,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  right: { flex: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  column: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  path: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs },
  swiped: { flexDirection: 'row', overflow: 'hidden' },
  slid: { flex: 1, minWidth: 0, backgroundColor: theme.colors.surface },
}));
