import type { useUnistyles } from 'react-native-unistyles';
type Colors = ReturnType<typeof useUnistyles>['theme']['colors'];

/** The approved meeting surfaces use the website's dark CI, with the app's light theme fallback. */
export type MeetingColors = {
  [Key in keyof Colors]: Colors[Key] extends string ? string : Colors[Key];
};

export function meetingPalette(colors: Colors): MeetingColors {
  if (colors.background !== '#000000') return colors;
  return {
    ...colors,
    background: '#07080d',
    surface: '#0c0e17',
    surfaceAlt: '#111422',
    border: '#22263a',
    text: '#f5f5f8',
    textMuted: '#a5a8b8',
    textFaint: '#74788d',
    primary: '#18c8f5',
    accent: '#ff18b7',
  };
}
