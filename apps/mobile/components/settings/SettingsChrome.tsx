// The shared furniture of the Settings screens: the scaffold every route renders
// into, the grouped-list row that navigates between them, and the small field
// primitives the forms are built from.
//
// Keeping these in one place is what makes the split invisible to the operator:
// a card, a row and a text field look and behave identically whichever of the
// five screens they happen to be on, and the auto-save banner reports work
// started on a screen that has since been popped.
import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';
import { StatusPill } from '../StatusPill';
import { useVeritySettings } from '../../lib/settingsStore';
import { settingsStyles as styles } from './settingsStyles';

/**
 * Every settings route's outer frame: the navigation title, the shared error
 * banner, the auto-save indicator, and a scroll view sized clear of the home
 * indicator.
 *
 * The banner and the indicator read the shared store rather than props, so a
 * save that started two screens ago is still visibly in flight here, and a
 * sealed-store error raised by one panel is not lost when the operator walks
 * into the screen that can fix it.
 */
export function SettingsScaffold({
  title,
  onRetry,
  detail = false,
  children,
}: {
  title: string;
  /** What "Retry" on the error banner should do. Omitted → no retry offered. */
  onRetry?: () => void;
  /** Detail routes use a calmer reading width on tablets and desktop. */
  detail?: boolean;
  children: ReactNode;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const { error, saving } = useVeritySettings();

  return (
    <View style={styles.flex}>
      <Stack.Screen options={{ title }} />
      {error !== undefined ? <SettingsBanner message={error} onRetry={onRetry} /> : null}
      {saving > 0 ? (
        <View style={styles.autoSaveBanner} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={theme.colors.setup.text} />
          <Text style={styles.autoSaveBannerText}>Saving changes…</Text>
        </View>
      ) : null}
      <ScrollView
        contentContainerStyle={[
          styles.content,
          detail ? styles.detailContent : null,
          { paddingBottom: insets.bottom + 24 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </View>
  );
}

/** A titled section of the screen. The title is a real heading for screen
 *  readers, so swipe-by-heading navigation skips between sections. */
export function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.settingsGroup}>
      <Text style={styles.groupHeader} accessibilityRole="header">
        {title}
      </Text>
      {description !== undefined ? (
        <Text style={styles.groupDescription}>{description}</Text>
      ) : null}
      {children}
    </View>
  );
}

/** One subject per section, with readiness shown beside its heading. */
export function SettingsPanel({ children }: { children: ReactNode }) {
  return <View style={styles.panel}>{children}</View>;
}

export { SettingsDisclosure } from './SettingsDisclosure';

/** A grouped list of rows, hairline-separated. The
 *  separators are inserted here so a screen cannot forget one (or leave a
 *  dangling one behind a row it conditionally hides). */
export function SettingsListPanel({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View style={styles.listPanel}>
      {rows.map((row, index) => (
        <Fragment key={row.key ?? index}>
          {index > 0 ? <View style={styles.rowSeparator} /> : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

/**
 * A row that leads somewhere: the settings index is made of these.
 *
 * `value` is for a current setting worth seeing without tapping in (the server
 * address); `status` is for readiness. Both are optional and rarely both useful.
 */
export function SettingsNavRow({
  icon,
  title,
  subtitle,
  value,
  status,
  onPress,
  accessibilityLabel,
}: {
  icon: IconName;
  title: string;
  subtitle?: string;
  value?: string;
  status?: { intent: 'ready' | 'needsSetup' | 'optional' | 'transient'; label: string };
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      style={({ pressed }) => [styles.navRow, pressed ? styles.pressed : null]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
    >
      <View style={styles.navRowIcon}>
        <Icon name={icon} size={18} color={theme.colors.primary} />
      </View>
      <View style={styles.navRowBody}>
        <Text style={styles.navRowTitle}>{title}</Text>
        {subtitle !== undefined ? <Text style={styles.navRowSubtitle}>{subtitle}</Text> : null}
      </View>
      <View style={styles.navRowTrailing}>
        {value !== undefined ? (
          <Text style={styles.navRowValue} numberOfLines={1}>
            {value}
          </Text>
        ) : null}
        {status !== undefined ? (
          <StatusPill quiet intent={status.intent} label={status.label} />
        ) : null}
        <Icon name="chevron-right" size={18} color={theme.colors.textFaint} />
      </View>
    </Pressable>
  );
}

export function SettingsToggleRow({
  label,
  value,
  onValueChange,
  disabled = false,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.toggleRow,
        disabled ? styles.buttonDisabled : null,
        pressed ? styles.pressed : null,
      ]}
      onPress={() => onValueChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={label}
    >
      <Text style={styles.toggleLabel}>{label}</Text>
      <View style={[styles.toggleTrack, value ? styles.toggleTrackOn : null]}>
        <View style={[styles.toggleKnob, value ? styles.toggleKnobOn : null]} />
      </View>
    </Pressable>
  );
}

/** A labelled text field. `onBlur` is the auto-save commit point — there is no
 *  Save button anywhere in Settings. */
export function SettingsField({
  label,
  value,
  onChangeText,
  onBlur,
  placeholder,
  accessibilityLabel,
  keyboardType,
  multiline = false,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  onBlur: () => void;
  placeholder: string;
  accessibilityLabel: string;
  keyboardType?: 'url' | 'email-address';
  multiline?: boolean;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.pathContent}>
      <Text style={styles.pathLabel}>{label}</Text>
      <TextInput
        style={[styles.secretInput, multiline ? null : { minHeight: 44 }]}
        value={value}
        onChangeText={onChangeText}
        onBlur={onBlur}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType}
        multiline={multiline}
        accessibilityLabel={accessibilityLabel}
      />
    </View>
  );
}

/**
 * A write-only secret paste box.
 *
 * The value is never read back from the server, so the pill reflects the
 * server's `*Configured` boolean rather than the (always empty on load) box.
 * PEM callers stay multiline because newlines must survive and React Native
 * cannot reliably mask a multiline input; single-line tokens opt into `masked`,
 * which uses `secureTextEntry` and drops the visible-value warning.
 */
export function SecretPasteField({
  label,
  placeholder,
  value,
  onChangeText,
  configured,
  editable,
  onBlur,
  masked = false,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  configured: boolean;
  editable: boolean;
  onBlur: () => void;
  masked?: boolean;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.pathContent}>
      <View style={styles.secretLabelRow}>
        <Text style={styles.pathLabel}>{label}</Text>
        <StatusPill
          quiet
          intent={configured ? 'ready' : 'optional'}
          label={configured ? 'Configured' : 'Not configured'}
        />
      </View>
      <TextInput
        style={[styles.secretInput, !editable ? styles.secretInputDisabled : null]}
        value={value}
        onChangeText={onChangeText}
        onBlur={onBlur}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textFaint}
        editable={editable}
        multiline={!masked}
        secureTextEntry={masked}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
      />
      {editable && !masked ? (
        <Text style={styles.footnote}>The key is visible while entering.</Text>
      ) : null}
    </View>
  );
}

/** A status line, not a control: Settings saves on blur. */
export function SettingsSaveState({ dirty = false }: { dirty?: boolean }) {
  const { saving, savedAt } = useVeritySettings();
  return (
    <>
      <Text style={styles.settingsSaveState} accessibilityLiveRegion="polite">
        {saving > 0 ? 'Saving changes…' : dirty ? 'Unsaved changes' : 'All changes saved'}
      </Text>
      {savedAt !== undefined && !dirty ? (
        <Text style={styles.footnote}>Last saved {new Date(savedAt).toLocaleString()}.</Text>
      ) : null}
    </>
  );
}

function SettingsBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText} numberOfLines={2}>
        {message}
      </Text>
      {onRetry !== undefined ? (
        <Pressable onPress={onRetry} hitSlop={8} accessibilityRole="button">
          <Text style={styles.bannerAction}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function SettingsMessage({
  title,
  subtitle,
  screenTitle = 'Settings',
  onRetry,
}: {
  title: string;
  subtitle?: string;
  screenTitle?: string;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.centered}>
      <Stack.Screen options={{ title: screenTitle }} />
      <Text style={styles.centerTitle}>{title}</Text>
      {subtitle !== undefined ? <Text style={styles.centerSubtitle}>{subtitle}</Text> : null}
      {onRetry !== undefined ? (
        <Pressable style={styles.retryButton} onPress={onRetry} accessibilityRole="button">
          <Text style={styles.retryButtonLabel}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
