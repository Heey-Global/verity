import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Row } from './Card';
import { Icon } from '../Icon';

/** Keeps technical detail within its entry without crowding the scan-friendly list. */
export function Disclosure({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);
  return (
    <View>
      <Row
        title={title}
        subtitle={subtitle}
        onPress={() => setExpanded(!expanded)}
        accessibilityHint={expanded ? 'Collapse details' : 'Expand details'}
        expanded={expanded}
        trailing={
          <Icon
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={theme.colors.textMuted}
          />
        }
      />
      {expanded ? <View style={styles.content}>{children}</View> : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  content: {
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.md,
    gap: theme.spacing.sm,
    minWidth: 0,
  },
}));
