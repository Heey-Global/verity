import { Animated, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';
import { useSyncedPulse } from '../../lib/pulse';

/** The role a mark is filled with; `muted` is for a verdict still settling. */
export type TileMarkTone = 'signature' | 'action' | 'success' | 'attention' | 'muted';

/** A Feather glyph, or one of the two punctuation marks Feather has no bare glyph for. */
export type TileMarkGlyph = IconName | '?' | '!';

/** The mark's outer diameter, ring included; both corners use the same one. */
const TILE_MARK_SIZE = 12;

/**
 * A small filled disc on the corner of a row's icon tile (docs/design-system.md
 * § 5.2): the top corner carries the agent's state, the bottom one a verdict. Both
 * share this one drawing — same size, same 1.5 px ring in the row surface, same
 * glyph weight — so two marks on one tile read as a pair, never as two styles.
 * `pulsing` binds to the shared pulse clock, so it breathes in step with every
 * working dot on screen.
 */
export function TileMark({
  tone,
  glyph,
  pulsing = false,
}: {
  tone: TileMarkTone;
  glyph?: TileMarkGlyph | undefined;
  pulsing?: boolean;
}) {
  const { theme } = useUnistyles();
  const pulse = useSyncedPulse();
  const fill = tone === 'muted' ? theme.colors.textMuted : theme.colors[tone];
  // The glyph is cut out of the fill in the page background, which keeps it
  // legible on every tone in both themes.
  const ink = theme.colors.background;
  return (
    <Animated.View
      style={[styles.mark, { backgroundColor: fill }, pulsing ? { opacity: pulse } : null]}
    >
      {glyph === '?' || glyph === '!' ? (
        <Text style={[styles.punctuation, { color: ink }]} allowFontScaling={false}>
          {glyph}
        </Text>
      ) : glyph !== undefined ? (
        <Icon name={glyph} size={8} color={ink} />
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  mark: {
    width: TILE_MARK_SIZE,
    height: TILE_MARK_SIZE,
    borderRadius: TILE_MARK_SIZE / 2,
    borderWidth: 1.5,
    borderColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  punctuation: {
    ...theme.typography.caption,
    // Two steps under caption, matching the 8 px Feather glyphs in the 9 px
    // space inside the ring.
    fontSize: theme.typography.caption.fontSize - 2,
    fontFamily: theme.fonts.bold,
    includeFontPadding: false,
    lineHeight: TILE_MARK_SIZE - 3,
    textAlign: 'center',
  },
}));
