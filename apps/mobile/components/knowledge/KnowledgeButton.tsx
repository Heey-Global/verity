import { Pressable, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Icon, type IconName } from '../Icon';
import { styles } from './styles';

export function KnowledgeButton({
  label,
  onPress,
  disabled = false,
  icon,
  iconOnly = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  icon?: IconName;
  iconOnly?: boolean;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, iconOnly && styles.iconButton, disabled && { opacity: 0.45 }]}
    >
      {icon ? <Icon name={icon} size={18} color={theme.colors.textMuted} /> : null}
      {!iconOnly ? <Text style={styles.buttonText}>{label}</Text> : null}
    </Pressable>
  );
}
