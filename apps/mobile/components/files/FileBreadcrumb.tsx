import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';

/** Where the list is inside the active tab. It sits below the tabs because it
 * is a path within the chosen root: the root shows as that tab's icon, not its
 * name again, and every folder on the way is one tap back. The last segment is
 * where you are, so it is not a button. */
export function FileBreadcrumb({
  rootIcon,
  rootLabel,
  segments,
  disabled = false,
  onNavigate,
}: {
  rootIcon: IconName;
  rootLabel: string;
  segments: ReadonlyArray<{ key: string; name: string }>;
  disabled?: boolean;
  /** -1 for the root, otherwise the index of the segment tapped. */
  onNavigate: (index: number) => void;
}) {
  const atRoot = segments.length === 0;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroll}
      contentContainerStyle={styles.row}
    >
      <Pressable
        onPress={() => onNavigate(-1)}
        disabled={disabled || atRoot}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={atRoot ? rootLabel : `Back to ${rootLabel}`}
        style={({ pressed }) => [styles.root, pressed ? styles.pressed : null]}
      >
        <Icon name={rootIcon} size={15} color="#ffffff" />
      </Pressable>
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        return (
          <View key={segment.key} style={styles.segment}>
            <Icon name="chevron-right" size={14} color="#ffffff" />
            <Pressable
              onPress={() => onNavigate(index)}
              disabled={disabled || last}
              hitSlop={6}
              accessibilityRole={last ? 'text' : 'button'}
              accessibilityLabel={last ? segment.name : `Back to ${segment.name}`}
            >
              <Text
                numberOfLines={1}
                style={[
                  styles.label,
                  last ? styles.current : styles.link,
                  disabled ? styles.disabledLabel : null,
                ]}
              >
                {segment.name}
              </Text>
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flexGrow: 0,
    marginBottom: theme.spacing.xs,
  },
  row: {
    alignItems: 'center',
    gap: theme.spacing.xs,
    paddingVertical: theme.spacing.xs,
  },
  root: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  pressed: { opacity: 0.7 },
  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  label: { fontSize: theme.text.sm },
  link: { color: theme.colors.primary },
  current: { color: theme.colors.text, fontWeight: '600' },
  disabledLabel: { color: theme.colors.textFaint },
}));
