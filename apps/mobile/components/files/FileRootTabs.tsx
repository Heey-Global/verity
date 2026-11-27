import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';
import { Text } from '../ui';

/** The tabs above a session's files: its Code and, in a project, Google Drive.
 * An unavailable Code tab stays visible, so the list below can say why. */
export function FileRootTabs({
  codeIcon,
  codeActive,
  codeDisabled,
  driveActive,
  drive,
  disabled,
  onCode,
  onDrive,
}: {
  codeIcon: IconName;
  codeActive: boolean;
  codeDisabled: boolean;
  driveActive: boolean;
  /** Whether the session belongs to a project, which is where Drive folders live. */
  drive: boolean;
  disabled: boolean;
  onCode: () => void;
  onDrive: () => void;
}) {
  return (
    <FileTabs
      disabled={disabled}
      tabs={[
        {
          key: 'code',
          icon: codeIcon,
          label: 'Code',
          active: codeActive,
          disabled: codeDisabled,
          onPress: onCode,
        },
        ...(drive
          ? [
              {
                key: 'drive',
                icon: 'hard-drive' as const,
                label: 'Google Drive',
                active: driveActive,
                onPress: () => {
                  if (!driveActive) onDrive();
                },
              },
            ]
          : []),
      ]}
    />
  );
}

export interface FileTab {
  key: string;
  icon: IconName;
  label: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}

/** The areas one explorer moves between — a session's Code and Google Drive,
 * a library's Wiki and Sources — underlined, never filled: they are places,
 * not actions. */
export function FileTabs({
  tabs,
  disabled = false,
}: {
  tabs: readonly FileTab[];
  disabled?: boolean;
}) {
  return (
    <View style={styles.bar}>
      {tabs.map((tab) => (
        <RootTab
          key={tab.key}
          icon={tab.icon}
          label={tab.label}
          accessibilityLabel={tab.label}
          active={tab.active}
          disabled={disabled || tab.disabled === true}
          onPress={tab.onPress}
        />
      ))}
    </View>
  );
}

function RootTab({
  icon,
  label,
  accessibilityLabel,
  active,
  disabled,
  onPress,
}: {
  icon: IconName;
  label: string;
  accessibilityLabel: string;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active, disabled }}
      accessibilityLabel={accessibilityLabel}
      style={[styles.tab, active ? styles.tabActive : null]}
    >
      <Icon name={icon} size={14} color={active ? theme.colors.text : theme.colors.textMuted} />
      <Text
        variant="footnote"
        tone={active ? 'default' : 'muted'}
        style={active ? styles.labelActive : undefined}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: 'row',
    gap: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    marginBottom: -StyleSheet.hairlineWidth,
  },
  tabActive: { borderBottomColor: theme.colors.action },
  labelActive: { fontFamily: theme.fonts.semibold },
}));
