import { Image, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { tint } from './ui/tint';

const MARK = require('../assets/brand/verity-v-mark.png') as number;
const MARK_RATIO = 240 / 168;

/**
 * Verity's V on its `signature` halo (docs/design-system.md § 5.8): the one sign
 * that something is Verity's, on Home, her page, the V that opens her panel and
 * her answers in it. `glow` adds the halo's light, for her identity; small
 * attribution marks stay flat.
 */
export function VerityMark({ size = 48, glow = true }: { size?: number; glow?: boolean }) {
  const mark = Math.round(size * (2 / 3));
  return (
    <View
      style={[
        styles.halo,
        glow ? styles.glow : null,
        { width: size, height: size, borderRadius: size / 2 },
      ]}
      testID="verity-mark"
    >
      <Image
        source={MARK}
        accessibilityIgnoresInvertColors
        style={{ width: mark, height: mark / MARK_RATIO }}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  halo: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tint(theme.colors.signature, 'neutral'),
  },
  glow: { shadowColor: theme.colors.signature, ...theme.elevation.glow },
}));
