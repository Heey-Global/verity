/** Whether the app header should expose message search for the current route. */
export function showsMessageSearch(routeName: string): boolean {
  return routeName === 'index' || routeName === 'session/[id]';
}

/** Detail titles need more room than the overview's navigation controls. */
export function usesExpandedHeaderTitle(routeName: string): boolean {
  return routeName.includes('settings') || routeName === 'project/[id]/vulnerability-scan';
}
