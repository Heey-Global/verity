/** Whether the app header should expose message search for the current route. */
export function showsMessageSearch(routeName: string): boolean {
  return routeName === 'index' || routeName === 'session/[id]';
}

/**
 * Detail titles need more room than the overview's navigation controls. Mockups
 * stand in for detail screens of every kind, so they get the room too; in the
 * narrower header a title such as "Shared knowledge" was cut off in the mockup
 * although the real screen shows it whole.
 */
export function usesExpandedHeaderTitle(routeName: string): boolean {
  return (
    routeName.includes('settings') ||
    routeName === 'project/[id]/vulnerability-scan' ||
    routeName === 'mockups/[spec]/[mockup]'
  );
}
