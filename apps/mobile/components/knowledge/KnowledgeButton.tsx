import { Pressable, Text } from 'react-native';
import { styles } from './styles';
export function KnowledgeButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && { opacity: 0.45 }]}
    >
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
}
