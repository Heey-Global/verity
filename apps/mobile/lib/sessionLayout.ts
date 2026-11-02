import { Platform } from 'react-native';

/** Window width in points, shared by the overview and session entry routes. */
const SPLIT_SCREEN_MIN_WIDTH = 768;

export function sessionLayout(
  width: number,
  supportsSplit = Platform.OS !== 'ios' || Platform.isPad,
): { wide: boolean; sidebarWidth: number } {
  return {
    // iPhone landscape widths overlap tablet widths; rotation must not change routes.
    wide: supportsSplit && width >= SPLIT_SCREEN_MIN_WIDTH,
    sidebarWidth: Math.min(380, Math.max(280, width * 0.36)),
  };
}
