import { Platform, type TextStyle } from 'react-native';

/**
 * Removes the browser's own focus ring from a text field whose container shows
 * focus itself. Chromium draws that ring as `outline-style: auto`, which ignores
 * `outline-width`, so only `outline-style: none` removes it. React Native's
 * types omit `none`; React Native Web passes it through.
 */
export const WEB_NO_FOCUS_RING: TextStyle | null =
  Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null;
