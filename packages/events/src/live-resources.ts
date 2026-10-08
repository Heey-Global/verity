/** Only repeatable, bounded reads may be observed. Downloads, arbitrary URLs,
 * callback routes and streaming handlers must never be executed by a watcher. */
export function liveResourceInterval(path: string): number | undefined {
  if (path.length > 1000 || /[\\\r\n#]/u.test(path)) return undefined;
  if (!path.startsWith('/') || path.startsWith('//')) return undefined;
  const p = path.split('?')[0]!;
  if (p.split('/').some((part) => part === '.' || part === '..' || /%2e|%2f|%5c/iu.test(part)))
    return undefined;
  if (/^\/projects(?:\/[^/]+(?:\/(?:public-shares|local-shares))?)?$/u.test(p)) return 15_000;
  if (
    /^\/sessions\/[^/]+\/(?:branches|links|linked-message-approvals|dev-servers|managed-dev-servers(?:\/[^/]+\/logs)?|local-shares|public-static-entries|public-static-directories)$/u.test(
      p,
    )
  )
    return p.endsWith('/branches') ? 5_000 : 3_000;
  if (/^\/sessions\/[^/]+\/live-meetings(?:\/[^/]+\/(?:commands|insights))?$/u.test(p))
    return 2_000;
  if (/^\/server\/(?:updates|update-channel)$/u.test(p)) return 2_000;
  if (/^\/settings\/agent-logins\/[^/]+$/u.test(p)) return 2_500;
  if (p === '/sessions' || p === '/provider-limits') return 30_000;
  if (/^\/sessions\/[^/]+\/activity$/u.test(p)) return 10_000;
  if (p === '/secret/status') return 15_000;
  if (p === '/onboarding/status') return 3_000;
  return undefined;
}
