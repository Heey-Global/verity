/**
 * In-app links an agent can write into a chat message, such as
 * `[Connect GitHub](verity://settings/services/github)`. The transcript resolves
 * them against the whitelist below and opens the matching screen or sheet; the
 * scheme never reaches the operating system, so it works the same in the native
 * app (whatever its registered scheme), in the browser build and in demo mode.
 *
 * The whitelist is deliberately closed: an agent may only point at screens that
 * exist for every user (Verity settings, the current project's settings, the
 * current session's sheets). Links to other sessions or projects by id are not
 * resolvable, so a hallucinated id cannot open something unexpected. Anything
 * that does not resolve stays non-tappable, exactly like an unknown scheme does
 * today.
 */

export const APP_LINK_SCHEME = 'verity://';

/** Verity settings screens an app link may open, as router paths. Each entry
 * must correspond to a route file under `apps/mobile/app/`; a guard test there
 * fails when one is renamed. The live STT test screen is left out on purpose:
 * it is a diagnostics surface, not something to point a user at. */
export const APP_LINK_SETTINGS_ROUTES = [
  '/settings',
  '/settings/github',
  '/settings/google',
  '/settings/remote-access',
  '/settings/secret-store',
  '/settings/transcription',
  '/settings/tasks',
  '/settings/server-update',
  '/settings/server-update-channel',
  '/settings/voice-input',
  '/settings/services',
  '/settings/services/claude',
  '/settings/services/codex',
  '/settings/services/opencode',
  '/settings/services/doppler',
  '/settings/services/attendee',
  '/settings/services/matrix',
  '/settings/services/mcp',
  '/settings/services/mcp/new',
  '/devices',
] as const;
export type AppLinkSettingsRoute = (typeof APP_LINK_SETTINGS_ROUTES)[number];

/** GitHub and Google are listed under Connections but live as top-level settings
 * screens, so the path an agent naturally writes is accepted as an alias. */
const APP_LINK_ROUTE_ALIASES: Readonly<Record<string, AppLinkSettingsRoute>> = {
  '/settings/services/github': '/settings/github',
  '/settings/services/google': '/settings/google',
};

/** Sub-pages of a project's settings; `null` is the settings index. */
export const APP_LINK_PROJECT_SETTINGS_PAGES = ['github', 'services', 'sandbox', 'model'] as const;
export type AppLinkProjectSettingsPage = (typeof APP_LINK_PROJECT_SETTINGS_PAGES)[number];

export type AppLinkTarget =
  | { kind: 'route'; path: AppLinkSettingsRoute }
  | { kind: 'project-settings'; page: AppLinkProjectSettingsPage | null }
  | { kind: 'new-project' }
  | { kind: 'preview' }
  | { kind: 'session-settings' }
  | { kind: 'files'; root: 'worktree' | 'knowledge' };

/**
 * Resolve a link target to the in-app destination it names, or `null` when it
 * is not a `verity://` link or names nothing on the whitelist. Matching is
 * case-insensitive and ignores a query string or fragment, so a link the agent
 * decorates still resolves; path traversal segments never do.
 */
export function parseAppLink(url: string): AppLinkTarget | null {
  const lower = url.trim().toLowerCase();
  if (!lower.startsWith(APP_LINK_SCHEME)) return null;
  const path = lower.slice(APP_LINK_SCHEME.length).split(/[?#]/)[0] ?? '';
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  const [head, second, third] = segments;
  if (head === 'settings' || head === 'devices') {
    const joined = `/${segments.join('/')}`;
    const routePath = APP_LINK_ROUTE_ALIASES[joined] ?? joined;
    return isSettingsRoute(routePath) ? { kind: 'route', path: routePath } : null;
  }
  if (head === 'project') {
    if (second === 'new' && segments.length === 2) return { kind: 'new-project' };
    if (second === 'knowledge' && segments.length === 2)
      return { kind: 'files', root: 'knowledge' };
    if (second === 'settings') {
      if (segments.length === 2) return { kind: 'project-settings', page: null };
      if (segments.length === 3 && isProjectSettingsPage(third)) {
        return { kind: 'project-settings', page: third };
      }
    }
    return null;
  }
  if (head === 'session' && segments.length === 2) {
    if (second === 'settings') return { kind: 'session-settings' };
    if (second === 'preview') return { kind: 'preview' };
    if (second === 'files') return { kind: 'files', root: 'worktree' };
  }
  return null;
}

function isSettingsRoute(value: string): value is AppLinkSettingsRoute {
  return (APP_LINK_SETTINGS_ROUTES as readonly string[]).includes(value);
}

function isProjectSettingsPage(value: string | undefined): value is AppLinkProjectSettingsPage {
  return (APP_LINK_PROJECT_SETTINGS_PAGES as readonly string[]).includes(value ?? '');
}
