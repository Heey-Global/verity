/** Window width in points, shared by the overview and session entry routes. */
export const SPLIT_SCREEN_MIN_WIDTH = 768;

export function sessionLayout(width: number): { wide: boolean; sidebarWidth: number } {
  return {
    wide: width >= SPLIT_SCREEN_MIN_WIDTH,
    sidebarWidth: Math.min(380, Math.max(280, width * 0.36)),
  };
}
