import type { ForgeAction } from './brokered-forge-github.js';

/** Repository-relative policy; unknown endpoints and methods never inherit write authority. */
export function githubRestAction(method: string, suffix: string): ForgeAction | undefined {
  const read = method === 'GET' || method === 'HEAD';
  if (read) {
    if (
      suffix === '' ||
      /^\/(branches|commits|compare)(\/[^/]+)?$/.test(suffix) ||
      /^\/contents(?:\/[^/]+)*$/.test(suffix) ||
      /^\/git\/(?:refs|ref|commits|trees|blobs|tags)(?:\/[^/]+)*$/.test(suffix)
    )
      return 'git-read';
    if (
      /^\/commits\/[^/]+\/(?:check-runs|check-suites|status|statuses)$/.test(suffix) ||
      /^\/(?:check-runs|check-suites)\/\d+(?:\/(?:annotations|check-runs))?$/.test(suffix)
    )
      return 'checks-read';
    if (/^\/commits\/[^/]+\/pulls$/.test(suffix)) return 'pulls-read';
    if (/^\/releases(?:\/(?:latest|tags\/[^/]+|\d+(?:\/assets)?|assets\/\d+))?$/.test(suffix))
      return 'releases-read';
    if (
      /^\/actions\/runs(?:\/\d+(?:\/(?:jobs|artifacts|logs|attempts\/\d+(?:\/(?:jobs|logs))?))?)?$/.test(
        suffix,
      ) ||
      /^\/actions\/workflows(?:\/[^/]+(?:\/runs)?)?$/.test(suffix) ||
      /^\/actions\/jobs\/\d+(?:\/logs)?$/.test(suffix) ||
      /^\/actions\/artifacts(?:\/\d+(?:\/zip)?)?$/.test(suffix)
    )
      return 'actions-read';
  }
  if (
    method === 'POST' &&
    /^\/actions\/(?:workflows\/[^/]+\/dispatches|runs\/\d+\/(?:rerun|rerun-failed-jobs|cancel|force-cancel)|jobs\/\d+\/rerun)$/.test(
      suffix,
    )
  )
    return 'actions-write';
  if (
    (method === 'POST' && suffix === '/releases') ||
    (['PATCH', 'DELETE'].includes(method) && /^\/releases\/(?:\d+|assets\/\d+)$/.test(suffix))
  )
    return 'releases-write';
  if (
    (['PUT', 'DELETE'].includes(method) && /^\/contents(?:\/[^/]+)+$/.test(suffix)) ||
    (method === 'POST' && /^\/git\/(?:refs|commits|trees|blobs|tags)$/.test(suffix)) ||
    (['PATCH', 'DELETE'].includes(method) && /^\/git\/refs(?:\/[^/]+)+$/.test(suffix))
  )
    return 'git-write';
  if (
    (method === 'POST' && suffix === '/labels') ||
    (['PATCH', 'DELETE'].includes(method) && /^\/labels\/[^/]+$/.test(suffix))
  )
    return 'issues-write';
  if (read && /^\/(?:labels|milestones)(?:\/[^/]+)?$/.test(suffix)) return 'issues-read';
  if (/^\/issues\/\d+\/labels(?:\/[^/]+)?$/.test(suffix))
    return read
      ? 'issues-read'
      : ['POST', 'PUT', 'DELETE'].includes(method)
        ? 'issues-write'
        : undefined;
  if (
    /^\/issues(?:\/\d+)?(?:\/comments)?$/.test(suffix) ||
    /^\/issues\/comments\/\d+$/.test(suffix)
  )
    return read
      ? 'issues-read'
      : ['POST', 'PATCH', 'DELETE'].includes(method)
        ? 'issues-write'
        : undefined;
  if (
    /^\/pulls(?:\/\d+)?(?:\/(?:commits|files|merge|reviews|comments))?$/.test(suffix) ||
    /^\/pulls\/\d+\/reviews\/\d+(?:\/dismissals)?$/.test(suffix)
  )
    return read
      ? 'pulls-read'
      : ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)
        ? 'pulls-write'
        : undefined;
  return undefined;
}
