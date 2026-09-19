import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Icon, type IconName } from '../Icon';
import { settingsStyles as styles } from './settingsStyles';

/** Keep forms mounted so collapsing never discards drafts or interrupts polling. */
export function SettingsDisclosure({
  title,
  summary,
  icon,
  defaultExpanded = false,
  attention = false,
  onCollapse,
  children,
}: {
  title: string;
  summary?: string;
  icon?: IconName;
  defaultExpanded?: boolean;
  attention?: boolean;
  onCollapse?: () => void;
  children: ReactNode;
}) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const open = expanded || attention;
  return (
    <View style={styles.disclosure}>
      <Pressable
        style={({ pressed }) => [styles.disclosureHeader, pressed ? styles.pressed : null]}
        onPress={() => {
          if (open) onCollapse?.();
          setExpanded(!open);
        }}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open, disabled: attention }}
        disabled={attention}
      >
        {icon ? (
          <View style={styles.navRowIcon}>
            <Icon name={icon} size={18} color={theme.colors.primary} />
          </View>
        ) : null}
        <View style={styles.navRowBody}>
          <Text style={styles.navRowTitle}>{title}</Text>
          {summary ? <Text style={styles.navRowSubtitle}>{summary}</Text> : null}
        </View>
        <Icon
          name={open ? 'chevron-down' : 'chevron-right'}
          size={18}
          color={theme.colors.primary}
        />
      </Pressable>
      <View
        style={[styles.disclosureBody, !open ? { display: 'none' } : null]}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      >
        {children}
      </View>
    </View>
  );
}
