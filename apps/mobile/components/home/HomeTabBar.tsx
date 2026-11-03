import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';
import { Text } from '../ui';
import { tint } from '../ui/tint';

export type HomeTab = 'home' | 'projects';

const TABS: { tab: HomeTab; label: string; icon: IconName }[] = [
  { tab: 'home', label: 'Home', icon: 'inbox' },
  { tab: 'projects', label: 'Projects', icon: 'layers' },
];

/**
 * The bottom switch between Home (what needs you) and the project list. Only
 * mounted while the "New Home" preview is on; the routes and the stack stay as
 * they are, so a deep link lands exactly where it did before.
 */
export function HomeTabBar({
  tab,
  onChange,
  count,
  bottomInset,
}: {
  tab: HomeTab;
  onChange: (tab: HomeTab) => void;
  /** Items on Home, shown beside its label while the project list is open. */
  count: number;
  bottomInset: number;
}) {
  const { theme } = useUnistyles();
  return (
    <View
      style={[styles.bar, { paddingBottom: Math.max(bottomInset, theme.spacing.sm) }]}
      accessibilityRole="tablist"
    >
      {TABS.map(({ tab: id, label, icon }) => {
        const active = id === tab;
        const color = active ? theme.colors.action : theme.colors.textFaint;
        const badge = id === 'home' && count > 0;
        return (
          <Pressable
            key={id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={badge ? `${label}, ${String(count)} need you` : label}
            onPress={() => onChange(id)}
            style={styles.tab}
          >
            <View style={styles.iconRow}>
              <Icon name={icon} size={22} color={color} />
              {badge ? (
                <View style={styles.badge}>
                  <Text variant="caption" style={styles.badgeText}>
                    {String(count)}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text variant="caption" style={{ color }}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingTop: theme.spacing.sm,
  },
  tab: { flex: 1, alignItems: 'center', gap: theme.spacing.xs, minHeight: 44 },
  iconRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs },
  badge: {
    minWidth: 20,
    paddingHorizontal: theme.spacing.xs,
    borderRadius: theme.radius.tag,
    alignItems: 'center',
    backgroundColor: tint(theme.colors.attention, 'fill'),
  },
  badgeText: { color: theme.colors.attention },
}));
