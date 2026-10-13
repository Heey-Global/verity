// The shared furniture of the Settings screens: the scaffold every route renders
// into, the grouped-list row that navigates between them, and the small field
// primitives the forms are built from. Rows, fields, headings and buttons are
// drawn by the design system's building blocks (components/ui); these wrappers
// keep the screens' props until each screen is migrated to them directly.
//
// Keeping these in one place is what makes the split invisible to the operator:
// a card, a row and a text field look and behave identically whichever of the
// five screens they happen to be on, and the auto-save banner reports work
// started on a screen that has since been popped.
import { type ReactNode } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { KeyboardAvoidingView, KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

import { type IconName } from '../Icon';
import { Button, Group, Row, SectionHeader, StatusDot, TextField, ToggleRow } from '../ui';
import { type StatusIntent } from '../ui/Status';
import { KEYBOARD_BOTTOM_OFFSET } from '../../lib/keyboardOffsets';
import { useVeritySettings } from '../../lib/settingsStore';
import { ApplyPendingBanner } from './ApplyPendingBanner';
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
  state,
  footer,
  children,
}: {
  title: string;
  /** What "Retry" on the error banner should do. Omitted → no retry offered. */
  onRetry?: () => void;
  /** Detail routes use a calmer reading width on tablets and desktop. */
  detail?: boolean;
  /** Banner state for screens that are not backed by the Verity settings store
   *  (the project settings routes). Omitted → the shared store's error and
   *  save state drive the banners. */
  state?: { error: string | undefined; saving: boolean };
  /** Pinned below the scroll view, clear of the home indicator: the one
   *  primary action of a step-like screen (Verity Premium). */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const verity = useVeritySettings();
  const error = state !== undefined ? state.error : verity.error;
  const saving = state !== undefined ? (state.saving ? 1 : 0) : verity.saving;

  // A pinned footer sits outside the scroll view, so the frame itself has to
  // shrink above the keyboard or the footer's action ends up behind it. Only one
  // of the two may react to the keyboard, or the inset is applied twice. Both
  // stay mounted either way so switching steps keeps the scroll position.
  const pinned = footer !== undefined;
  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding" enabled={pinned}>
      <Stack.Screen options={{ title }} />
      {error !== undefined ? <SettingsBanner message={error} onRetry={onRetry} /> : null}
      {/* Only on screens backed by the Verity settings store — that store is
          where a container-affecting save is recorded. */}
      {state === undefined ? <ApplyPendingBanner /> : null}
      {saving > 0 ? (
        <View style={styles.autoSaveBanner} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={theme.colors.setup.text} />
          <Text style={styles.autoSaveBannerText}>Saving changes…</Text>
        </View>
      ) : null}
      {/*
        Keyboard-aware rather than a plain ScrollView: the keyboard covers the
        bottom of the list on both platforms, and the last group of a screen
        (Public Preview, on connected services) holds a write-only paste box —
        a credential typed behind the keyboard is never echoed back anywhere.
        `bottomOffset` is the gap left between the focused field and the
        keyboard's top edge, so the field is not flush against it.
      */}
      <KeyboardAwareScrollView
        contentContainerStyle={[
          styles.content,
          detail ? styles.detailContent : null,
          { paddingBottom: pinned ? 24 : insets.bottom + 24 },
        ]}
        keyboardShouldPersistTaps="handled"
        bottomOffset={KEYBOARD_BOTTOM_OFFSET}
        enabled={!pinned}
      >
        {children}
      </KeyboardAwareScrollView>
      {footer !== undefined ? (
        <View style={[styles.scaffoldFooter, { paddingBottom: insets.bottom + 16 }]}>{footer}</View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

/** A titled section of the screen. The title is a real heading for screen
 *  readers, so swipe-by-heading navigation skips between sections. */
export function SettingsGroup({
  title,
  description,
  trailing,
  children,
}: {
  title: string;
  description?: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.settingsGroup}>
      <View style={styles.sectionHeaderRow}>
        <View style={styles.sectionHeaderLabel}>
          <SectionHeader title={title} flush />
        </View>
        {trailing}
      </View>
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

/** A grouped list of rows, divided by the design system's `Group`. */
export function SettingsListPanel({ children }: { children: ReactNode }) {
  return <Group>{children}</Group>;
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
  disabled = false,
  signature = false,
}: {
  icon: IconName;
  title: string;
  subtitle?: string;
  value?: string;
  status?: { intent: StatusIntent; label: string };
  onPress: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
  /** Draws the icon in the brand pink; only for the Verity Premium row. */
  signature?: boolean;
}) {
  const trailing =
    status !== undefined ? (
      value !== undefined ? (
        <View style={styles.navRowTrailing}>
          <Text style={styles.navRowValue} numberOfLines={1}>
            {value}
          </Text>
          <StatusDot intent={status.intent} label={status.label} />
        </View>
      ) : (
        <StatusDot intent={status.intent} label={status.label} />
      )
    ) : (
      value
    );
  return (
    <Row
      leading={{ icon, signature }}
      title={title}
      subtitle={subtitle}
      trailing={trailing}
      onPress={onPress}
      navigates
      disabled={disabled}
      accessibilityLabel={
        accessibilityLabel ??
        [title, subtitle, value, status?.label].filter((part) => part !== undefined).join(', ')
      }
    />
  );
}

/**
 * One option of a single-choice list: the model picker on project settings.
 * Selection is shown by a check mark on the trailing edge rather than a pill,
 * so a list of ten rows reads as one control and not ten statuses.
 */
export function SettingsChoiceRow({
  title,
  subtitle,
  selected,
  disabled = false,
  onPress,
  accessibilityLabel,
}: {
  title: string;
  subtitle?: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <Row
      title={title}
      subtitle={subtitle}
      selected={selected}
      disabled={disabled}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel ?? title}
    />
  );
}

export function SettingsToggleRow({
  label,
  subtitle,
  value,
  onValueChange,
  disabled = false,
  icon,
}: {
  label: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  /** Leading glyph, drawn in the same slot as a nav row's icon. */
  icon?: ReactNode;
}) {
  return (
    <ToggleRow
      title={label}
      subtitle={subtitle}
      {...(icon !== undefined ? { leading: { element: icon } } : {})}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
    />
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
  return (
    <TextField
      label={label}
      value={value}
      onChangeText={onChangeText}
      onBlur={onBlur}
      placeholder={placeholder}
      accessibilityLabel={accessibilityLabel}
      keyboardType={keyboardType}
      // Settings fields hold names, hosts and identifiers, never prose.
      literal
      multiline={multiline}
    />
  );
}

/**
 * A write-only secret paste box.
 *
 * The value is never read back from the server, so the status reflects the
 * server's `*Configured` boolean rather than the (always empty on load) box.
 * PEM callers stay multiline because newlines must survive and React Native
 * cannot reliably mask a multiline input; single-line tokens opt into `masked`,
 * which hides the value behind a reveal control and drops the visible-value
 * warning.
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
  accessibilityLabel,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  configured: boolean;
  editable: boolean;
  onBlur: () => void;
  masked?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <View style={styles.pathContent}>
      <TextField
        label={label}
        labelAccessory={
          <StatusDot
            intent={configured ? 'ready' : 'optional'}
            label={configured ? 'Configured' : 'Not configured'}
          />
        }
        value={value}
        onChangeText={onChangeText}
        onBlur={onBlur}
        placeholder={placeholder}
        disabled={!editable}
        secret={masked}
        multiline={!masked}
        literal
        {...(accessibilityLabel !== undefined ? { accessibilityLabel } : {})}
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
        <Button label="Retry" variant="text" size="compact" onPress={onRetry} />
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
        <Button label="Retry" variant="secondary" onPress={onRetry} />
      ) : null}
    </View>
  );
}
