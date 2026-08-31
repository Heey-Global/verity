/** Whether the app header should expose message search for the current route. */
export function showsMessageSearch(routeName: string): boolean {
  return routeName === 'index' || routeName === 'session/[id]';
}
