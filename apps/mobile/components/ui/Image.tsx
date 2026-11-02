import { Image as ExpoImage } from 'expo-image';
import { withUnistyles } from 'react-native-unistyles';

// Expo Image forwards styles through its own web container. Without the
// third-party adapter, Unistyles dimensions never reach that container and
// inline images collapse to zero height even after their bytes have loaded.
export const Image = withUnistyles(ExpoImage);
