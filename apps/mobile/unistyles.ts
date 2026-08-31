// Unistyles v3 runtime configuration. Imported once for its side effect from the
// root layout BEFORE any styled component renders (StyleSheet.create relies on
// the themes registered here). `initialTheme: 'dark'` forces dark mode (instead
// of `adaptiveThemes` following the OS) — the dark theme uses a true-black
// (#000000) background so OLED pixels switch off, minimizing battery draw. The
// module augmentation makes `theme`/breakpoints fully typed in every
// StyleSheet.create((theme) => …) and useUnistyles() call across the app.
import { StyleSheet } from 'react-native-unistyles';

import { darkTheme, lightTheme } from './theme/tokens';

const breakpoints = { xs: 0, sm: 576, md: 768, lg: 992 } as const;

type AppThemes = {
  light: typeof lightTheme;
  dark: typeof darkTheme;
};
type AppBreakpoints = typeof breakpoints;

declare module 'react-native-unistyles' {
  export interface UnistylesThemes extends AppThemes {}
  export interface UnistylesBreakpoints extends AppBreakpoints {}
}

StyleSheet.configure({
  themes: { light: lightTheme, dark: darkTheme },
  breakpoints,
  settings: {
    initialTheme: 'dark',
  },
});
