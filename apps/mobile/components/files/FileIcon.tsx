import { View } from 'react-native';
import { Icon, type IconName } from '../Icon';
export type { IconName } from '../Icon';

/** White explorer glyphs need a dark backing in both app themes. */
export function FileIcon({ name, size = 20 }: { name: IconName; size?: number; color?: string }) {
  return (
    <View style={{ backgroundColor: '#30343b', borderRadius: 4, padding: 2 }}>
      <Icon name={name} size={size} color="#ffffff" />
    </View>
  );
}
