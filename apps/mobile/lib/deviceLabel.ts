import { Platform } from 'react-native';

export function deviceLabel(): string {
  if (Platform.OS === 'ios') return Platform.isPad ? 'iPad' : 'iPhone';
  if (Platform.OS === 'android') return 'Android device';
  return 'Verity device';
}
