// The session row's leading edge: one thin stripe per standing property, side
// by side, always in the same order and color — favorite (accent), automation
// (primary) and shared preview (done). The edge never tints the row itself, so
// the selected background stays the only fill and remains readable.
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export type SessionMarker =
  | { kind: 'favorite' }
  | { kind: 'automation'; paused: boolean }
  | { kind: 'shared'; public: boolean };

export function sessionMarkers({
  favorite,
  automation,
  preview,
}: {
  favorite: boolean;
  automation: 'enabled' | 'paused' | undefined;
  /** `public` when an unexpired public (Uplink) share exists, else `local`. */
  preview: 'local' | 'public' | undefined;
}): SessionMarker[] {
  const markers: SessionMarker[] = [];
  if (favorite) markers.push({ kind: 'favorite' });
  if (automation) markers.push({ kind: 'automation', paused: automation === 'paused' });
  if (preview) markers.push({ kind: 'shared', public: preview === 'public' });
  return markers;
}

/** Spoken form of the markers, appended to the row's accessibility label. */
export function sessionMarkersLabel(markers: readonly SessionMarker[]): string {
  return markers
    .map((marker) => {
      if (marker.kind === 'favorite') return 'favorite';
      if (marker.kind === 'automation')
        return marker.paused ? 'automation paused' : 'automation active';
      return marker.public ? 'shared publicly' : 'shared locally';
    })
    .join(', ');
}

export function SessionMarkerEdge({ markers }: { markers: readonly SessionMarker[] }) {
  const { theme } = useUnistyles();
  if (markers.length === 0) return null;
  return (
    <View pointerEvents="none" style={styles.edge} testID="session-marker-edge">
      {markers.map((marker) => {
        const color =
          marker.kind === 'favorite'
            ? theme.colors.accent
            : marker.kind === 'automation'
              ? theme.colors.primary
              : theme.colors.tone.done;
        return (
          <View
            key={marker.kind}
            testID={`session-marker-${marker.kind}`}
            style={[
              styles.stripe,
              { backgroundColor: color },
              // A paused automation is still configured, just quieter.
              marker.kind === 'automation' && marker.paused ? styles.paused : null,
              // A public share is reachable from the internet: it glows.
              marker.kind === 'shared' && marker.public
                ? { shadowColor: color, shadowOpacity: 0.9, shadowRadius: 4 }
                : null,
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  edge: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    flexDirection: 'row',
    gap: 2,
  },
  stripe: {
    width: 3,
    height: '100%',
    shadowOffset: { width: 0, height: 0 },
  },
  paused: {
    opacity: 0.4,
  },
});
