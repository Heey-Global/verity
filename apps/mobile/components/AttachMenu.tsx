import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  type AttachAnchor,
  type AttachMenuHandlers,
  attachMenuRows,
  CONNECTORS,
  connectorState,
  type GoogleMenuAccess,
  type GoogleService,
} from '../lib/attachMenu';
import { type RecentImage, useRecentImages } from '../lib/recentImages';
import { Icon, type IconName } from './Icon';
import { Image } from './ui/Image';
import { tint } from './ui/tint';
import { Toggle } from './ui/Toggle';

export interface AttachMenuGoogle {
  /** A centrally connected Google account; without one there is no Connectors row. */
  connected: boolean;
  /** The account catalog is still being read, or could not be. */
  loading: boolean;
  error: string | null;
  access: GoogleMenuAccess;
  /** Allow (true) or switch off (false) one connector for this chat. */
  onToggle: (service: GoogleService, on: boolean) => void;
}

/**
 * The composer's add menu: a small popover docked to the plus button. On
 * devices with a photo library it opens with a strip — camera first, then the
 * newest images, screenshots first — and a tap on an image attaches it. Below
 * are the remaining sources and the Connectors row, which turns the same card
 * into a list of per-chat switches.
 */
export function AttachMenu({
  visible,
  anchor,
  handlers,
  onAttachRecent,
  google,
  onClose,
  onDismiss,
}: {
  visible: boolean;
  anchor: AttachAnchor | null;
  handlers: Omit<AttachMenuHandlers, 'onOpenConnectors'>;
  onAttachRecent: (image: RecentImage) => void;
  google: AttachMenuGoogle;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const { width: winW, height: winH } = useWindowDimensions();
  const [view, setView] = useState<'main' | 'connectors'>('main');
  // Reopening the menu starts on its first page again.
  useEffect(() => {
    if (!visible) setView('main');
  }, [visible]);
  const recent = useRecentImages(visible);
  const strip = recent.state.kind !== 'unavailable';
  const rows = attachMenuRows(
    { ...handlers, onOpenConnectors: () => setView('connectors') },
    { recentStrip: strip, googleConnected: google.connected, googleAccess: google.access },
  );
  // Dock to the button: left-aligned and clamped on-screen; placed above the button
  // (the composer sits at the bottom, so the menu opens upward). The strip needs
  // room for a few thumbnails; without it the card stays as narrow as before.
  const width = strip || view === 'connectors' ? Math.min(340, winW - 16) : 220;
  const GAP = 8;
  const ax = anchor?.x ?? 12;
  const ay = anchor?.y ?? winH - 120;
  const ah = anchor?.height ?? 0;
  const left = Math.max(8, Math.min(ax, winW - width - 8));
  const cardPos = ay > winH / 2 ? { bottom: winH - ay + GAP, left } : { top: ay + ah + GAP, left };
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={view === 'connectors' ? () => setView('main') : onClose}
      onDismiss={onDismiss}
    >
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close attachment menu"
      />
      <View style={[styles.card, { width }, cardPos]}>
        {view === 'connectors' ? (
          <ConnectorsView google={google} onBack={() => setView('main')} />
        ) : (
          <>
            {strip ? (
              <RecentStrip
                recent={recent}
                onCapture={handlers.onCapturePhoto}
                onAttach={onAttachRecent}
              />
            ) : null}
            {rows.map((row, index) =>
              'divider' in row ? (
                <View key={`divider-${String(index)}`} style={styles.divider} />
              ) : (
                <MenuRow key={row.label} {...row} />
              ),
            )}
            {/* Where the Connectors row appears, so the menu does not jump when it
                arrives: a first read in progress, or one that failed. */}
            {!google.connected && (google.loading || google.error) ? (
              <>
                <View style={styles.divider} />
                <CatalogStatus error={google.error} />
              </>
            ) : null}
          </>
        )}
      </View>
    </Modal>
  );
}

function MenuRow({
  icon,
  label,
  detail,
  navigates,
  onPress,
}: {
  icon: IconName;
  label: string;
  detail?: string;
  navigates?: boolean;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
    >
      <Icon name={icon} size={20} color={theme.colors.textMuted} />
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      </View>
      {navigates ? <Icon name="chevron-right" size={18} color={theme.colors.textFaint} /> : null}
    </Pressable>
  );
}

function CatalogStatus({ error }: { error: string | null }) {
  const { theme } = useUnistyles();
  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole={error ? 'alert' : undefined}
      accessibilityLabel={error ?? 'Checking Google accounts'}
    >
      {error ? (
        <Icon name="alert-circle" size={20} color={theme.colors.textMuted} />
      ) : (
        <ActivityIndicator size="small" color={theme.colors.textMuted} />
      )}
      <View style={styles.rowText}>
        <Text style={styles.rowDetail}>{error ?? 'Checking Google accounts…'}</Text>
      </View>
    </View>
  );
}

function RecentStrip({
  recent,
  onCapture,
  onAttach,
}: {
  recent: ReturnType<typeof useRecentImages>;
  onCapture: () => void;
  onAttach: (image: RecentImage) => void;
}) {
  const { theme } = useUnistyles();
  const { state } = recent;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.strip}
      accessibilityLabel="Recent images"
    >
      <Pressable
        style={[styles.tile, styles.iconTile]}
        onPress={onCapture}
        accessibilityRole="button"
        accessibilityLabel="Take photo"
      >
        <Icon name="camera" size={24} color={theme.colors.textMuted} />
      </Pressable>
      {state.kind === 'ready'
        ? state.images.map((image, index) => (
            <Pressable
              key={image.id}
              style={styles.tile}
              onPress={() => onAttach(image)}
              accessibilityRole="button"
              accessibilityLabel={`Attach recent image ${String(index + 1)}`}
            >
              <Image source={{ uri: image.uri }} style={styles.tileImage} contentFit="cover" />
            </Pressable>
          ))
        : null}
      {state.kind === 'denied' ? (
        <ActionTile icon="image" label="Allow photo access" onPress={recent.openSettings} />
      ) : state.kind === 'ready' && state.limited ? (
        <ActionTile icon="plus" label="Manage" onPress={recent.manageLimited} />
      ) : null}
    </ScrollView>
  );
}

function ActionTile({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      style={[styles.tile, styles.iconTile, styles.actionTile]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon name={icon} size={22} color={theme.colors.textMuted} />
      <Text style={styles.actionTileLabel}>{label}</Text>
    </Pressable>
  );
}

function ConnectorsView({ google, onBack }: { google: AttachMenuGoogle; onBack: () => void }) {
  const { theme } = useUnistyles();
  return (
    <>
      <Pressable
        style={styles.back}
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back to the add menu"
      >
        <Icon name="chevron-left" size={20} color={theme.colors.textMuted} />
        <Text style={styles.backLabel}>Connectors</Text>
      </Pressable>
      <View style={styles.divider} />
      {CONNECTORS.map(({ service, label, icon }) => {
        const { on, locked, detail } = connectorState(google.access[service]);
        return (
          <Pressable
            key={service}
            style={styles.row}
            disabled={locked}
            onPress={() => google.onToggle(service, !on)}
            accessibilityRole="switch"
            accessibilityLabel={label}
            accessibilityHint={detail}
            accessibilityState={{ checked: on, disabled: locked }}
          >
            <Icon name={icon} size={20} color={theme.colors.textMuted} />
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>{label}</Text>
              <Text style={styles.rowDetail}>{detail}</Text>
            </View>
            <Toggle value={on} disabled={locked} />
          </Pressable>
        );
      })}
      <View style={styles.divider} />
      <Text style={styles.footnote}>Project access is set in Project settings.</Text>
    </>
  );
}

const TILE = 76;

const styles = StyleSheet.create((theme) => ({
  // A light dim in both themes; a popover does not take the full scrim.
  backdrop: { flex: 1, backgroundColor: tint(theme.elevation.floating.shadowColor, 'ring') },
  card: {
    position: 'absolute',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing.xs,
    shadowColor: theme.elevation.floating.shadowColor,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
  },
  rowPressed: { backgroundColor: theme.colors.surfaceAlt },
  rowText: { flex: 1 },
  rowLabel: {
    color: theme.colors.text,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.row.fontSize,
  },
  rowDetail: {
    color: theme.colors.textMuted,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.footnote.fontSize,
    marginTop: 1,
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing.xs,
    marginHorizontal: theme.spacing.sm,
  },
  strip: {
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.sm,
  },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: theme.radius.tile,
    overflow: 'hidden',
    backgroundColor: theme.colors.surfaceAlt,
  },
  iconTile: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actionTile: { width: TILE * 1.5, gap: theme.spacing.xs, paddingHorizontal: theme.spacing.xs },
  actionTileLabel: {
    color: theme.colors.textMuted,
    fontFamily: theme.fonts.semibold,
    fontSize: theme.typography.footnote.fontSize,
    textAlign: 'center',
  },
  tileImage: { width: '100%', height: '100%' },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
  },
  backLabel: {
    color: theme.colors.text,
    fontFamily: theme.fonts.semibold,
    fontSize: theme.typography.row.fontSize,
  },
  footnote: {
    color: theme.colors.textMuted,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.footnote.fontSize,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
  },
}));
