import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from './Icon';

export type LinkedSessionChip = {
  sessionId: string;
  name: string | null;
  projectName: string;
};

/**
 * The linked sessions under the session header. The chip itself opens the
 * linked session; its trailing x disconnects it. The two are sibling
 * pressables, so a tap on the x never also navigates away.
 */
export function LinkedSessionChips<Link extends LinkedSessionChip>({
  links,
  onOpen,
  onDisconnect,
}: {
  links: readonly Link[];
  onOpen: (link: Link) => void;
  onDisconnect: (link: Link) => void;
}) {
  const { theme } = useUnistyles();
  if (links.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      accessibilityLabel="Linked sessions"
    >
      {links.map((link) => {
        const label = link.name ?? link.sessionId;
        return (
          <View key={link.sessionId} style={styles.chip}>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`Open linked session ${label}`}
              onPress={() => onOpen(link)}
              style={({ pressed }) => [styles.open, pressed && styles.pressed]}
            >
              <Icon name="link" size={13} color={theme.colors.action} />
              <Text style={styles.text} numberOfLines={1}>
                {link.projectName} · {label}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Disconnect ${label}`}
              hitSlop={8}
              onPress={() => onDisconnect(link)}
            >
              <Icon name="x" size={15} color={theme.colors.textMuted} />
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

// A quiet pill: muted caption text on a faint surface, distinct from the title.
const styles = StyleSheet.create((theme) => ({
  row: { paddingHorizontal: 16, paddingBottom: 8, gap: 8, alignItems: 'center' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    maxWidth: 250,
    paddingHorizontal: 10,
    minHeight: 30,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  open: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flexShrink: 1,
    alignSelf: 'stretch',
  },
  pressed: { opacity: 0.6 },
  text: {
    flexShrink: 1,
    color: theme.colors.textMuted,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.footnote.fontSize,
  },
}));
