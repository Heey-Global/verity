// The session row's leading edge: one segment per standing property, stacked
// top to bottom, always in the same order and color — favorite (accent),
// automation (primary) and shared preview (done, local or online alike). The
// edge never tints the row itself, so the selected background stays the only fill.
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export type SessionMarker =
  { kind: 'favorite' } | { kind: 'automation'; paused: boolean } | { kind: 'shared' };

export function sessionMarkers({
  favorite,
  automation,
  shared,
}: {
  favorite: boolean;
  automation: 'enabled' | 'paused' | undefined;
  /** A preview is shared, on the local network or online. */
  shared: boolean;
}): SessionMarker[] {
  const markers: SessionMarker[] = [];
  if (favorite) markers.push({ kind: 'favorite' });
  if (automation) markers.push({ kind: 'automation', paused: automation === 'paused' });
  if (shared) markers.push({ kind: 'shared' });
  return markers;
}

/** Spoken form of the markers, appended to the row's accessibility label. */
export function sessionMarkersLabel(markers: readonly SessionMarker[]): string {
  return markers
    .map((marker) => {
      if (marker.kind === 'favorite') return 'favorite';
      if (marker.kind === 'automation')
        return marker.paused ? 'automation paused' : 'automation active';
      return 'shared';
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
              styles.segment,
              { backgroundColor: color },
              // A paused automation is still configured, just quieter.
              marker.kind === 'automation' && marker.paused ? styles.paused : null,
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
    top: 4,
    bottom: 4,
    left: 0,
    width: 4,
    gap: 2,
  },
  segment: {
    flex: 1,
    borderTopRightRadius: 2,
    borderBottomRightRadius: 2,
  },
  paused: {
    opacity: 0.4,
  },
});
