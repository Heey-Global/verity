import { Image, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../../components/Icon';
import { Text } from '../../components/ui';

const MARK = require('../../assets/brand/verity-v-mark.png') as number;
const MARK_RATIO = 240 / 168;

/**
 * Verity's recommendation under a question: the V mark and one sentence.
 * Design-system gap: no shared component carries this yet; Home and the spec
 * would both need it.
 */
export function Recommendation({ children }: { children: string }) {
  return (
    <View style={styles.recommendation}>
      <Image
        source={MARK}
        accessibilityIgnoresInvertColors
        style={{ width: 16, height: 16 / MARK_RATIO }}
      />
      <Text variant="bodySmall" style={styles.flex}>
        {children}
      </Text>
    </View>
  );
}

/**
 * A placeholder for a mockup screen's thumbnail: an icon tile and the screen's
 * name. Design-system gap: there is no image thumbnail component, so a spec
 * cannot yet show its rendered screens in a list.
 */
export function ScreenThumb({ icon, label }: { icon: IconName; label: string }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.thumb}>
      <Icon name={icon} size={20} color={theme.colors.textMuted} />
      <Text variant="caption" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  flex: { flex: 1 },
  recommendation: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  thumb: {
    flex: 1,
    minHeight: 72,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    borderRadius: theme.radius.tile,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
}));
