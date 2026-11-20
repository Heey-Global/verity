// Incoming links before Expo Router resolves them. A team invitation arrives as
// https://verity.build/join#…; its fragment is the invitation, so the whole link
// is handed to the join screen, which works before any server is set up.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return joinRedirect(path) ?? path;
}

export function joinRedirect(path: string): string | undefined {
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.host !== 'verity.build' || url.pathname !== '/join')
    return undefined;
  return `/onboarding/join?link=${encodeURIComponent(url.href)}`;
}
