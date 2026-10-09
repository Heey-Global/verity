// The session row's marker column on the trailing edge: one entry per standing
// property, stacked top to bottom in a fixed order — favorite (accent, star),
// automation (primary, repeat) and shared preview (done, wifi when only on the
// local network, globe once it is reachable online). Each entry is its icon next
// to a short colored bar, so a row with one marker reads the same as a row with
// three. The leading edge stays with the working/unread dot, and the column never
// tints the row, so the selected background stays the only fill.
import { Linking, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from './Icon';

export type SessionMarker =
  | { kind: 'favorite' }
  | { kind: 'automation'; paused: boolean }
  | { kind: 'linked' }
  | { kind: 'shared'; online: boolean };

export function sessionMarkers({
  favorite,
  automation,
  shared,
  linked = false,
}: {
  linked?: boolean;
  favorite: boolean;
  automation: 'enabled' | 'paused' | undefined;
  /** How far the preview reaches; `online` wins when both are shared. */
  shared: 'local' | 'online' | undefined;
}): SessionMarker[] {
  const markers: SessionMarker[] = [];
  if (favorite) markers.push({ kind: 'favorite' });
  if (automation) markers.push({ kind: 'automation', paused: automation === 'paused' });
  if (linked) markers.push({ kind: 'linked' });
  if (shared) markers.push({ kind: 'shared', online: shared === 'online' });
  return markers;
}

/** Spoken form of the markers, appended to the row's accessibility label. */
export function sessionMarkersLabel(markers: readonly SessionMarker[]): string {
  return markers
    .map((marker) => {
      if (marker.kind === 'favorite') return 'favorite';
      if (marker.kind === 'automation')
        return marker.paused ? 'automation paused' : 'automation active';
      if (marker.kind === 'linked') return 'linked sessions';
      return marker.online ? 'shared online' : 'shared on the local network';
    })
    .join(', ');
}

export function markerIcon(marker: SessionMarker): IconName {
  if (marker.kind === 'favorite') return 'star';
  if (marker.kind === 'automation') return 'repeat';
  if (marker.kind === 'linked') return 'link';
  return marker.online ? 'globe' : 'wifi';
}

export function SessionMarkerColumn({
  markers,
  previewUrl,
  onOpenLinks,
}: {
  onOpenLinks?: () => void;
  markers: readonly SessionMarker[];
  /** Where the share entry leads; null while a public share has no origin yet. */
  previewUrl: string | null;
}) {
  const { theme } = useUnistyles();
  if (markers.length === 0) return null;
  return (
    <View
      style={[styles.column, markers.length === 4 ? styles.compact : null]}
      testID="session-marker-column"
    >
      {markers.map((marker) => {
        const color =
          marker.kind === 'favorite'
            ? theme.colors.accent
            : marker.kind === 'automation'
              ? theme.colors.primary
              : marker.kind === 'linked'
                ? theme.colors.linked
                : theme.colors.tone.done;
        const entry = (
          <View
            testID={`session-marker-${marker.kind}`}
            style={[
              styles.entry,
              // A paused automation is still configured, just quieter.
              marker.kind === 'automation' && marker.paused ? styles.paused : null,
            ]}
          >
            <Icon name={markerIcon(marker)} size={13} color={color} />
            <View style={[styles.bar, { backgroundColor: color }]} />
          </View>
        );
        if (marker.kind === 'linked')
          return (
            <Pressable
              key={marker.kind}
              onPress={onOpenLinks}
              accessibilityRole="button"
              accessibilityLabel="Open linked sessions"
            >
              {entry}
            </Pressable>
          );
        if (marker.kind !== 'shared') {
          return (
            <View
              key={marker.kind}
              accessible={false}
              importantForAccessibility="no-hide-descendants"
            >
              {entry}
            </View>
          );
        }
        // The share entry opens the preview, as the preview icon used to. Enabled
        // even without a URL yet: a disabled Pressable lets the tap fall through to
        // the row, which would open the session instead.
        return (
          <Pressable
            key={marker.kind}
            onPress={() => previewUrl && void Linking.openURL(previewUrl).catch(() => undefined)}
            hitSlop={8}
            accessibilityRole="link"
            accessibilityLabel="Open preview"
            accessibilityState={{ disabled: !previewUrl }}
          >
            {entry}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: {
    alignSelf: 'stretch',
    justifyContent: 'center',
    gap: theme.spacing.xs,
  },
  compact: { gap: 0 },
  entry: {
    height: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bar: {
    width: 3,
    height: '100%',
    borderTopLeftRadius: 2,
    borderBottomLeftRadius: 2,
  },
  paused: {
    opacity: 0.4,
  },
}));
