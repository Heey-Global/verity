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
  expanded: controlled,
  onExpandedChange,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Set to control it from outside, e.g. to open it when it is the only way forward. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const { theme } = useUnistyles();
  const [own, setOwn] = useState(false);
  const expanded = controlled ?? own;
  const setExpanded = (next: boolean) => {
    if (controlled === undefined) setOwn(next);
    onExpandedChange?.(next);
  };
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
