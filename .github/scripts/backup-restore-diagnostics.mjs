const safeCodes = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EROFS',
  'ELOOP',
  'ENOTDIR',
  'ENAMETOOLONG',
  'ERR_ASSERTION',
  '23505',
  '23503',
  '23502',
  '42501',
  '42P01',
  '42703',
]);

/** Recovery failures can carry private input in messages, causes and process output.
 * @param {{ code?: string, stack?: string } | null | undefined} error
 */
export function formatRestoreFailure(error) {
  const code = safeCodes.has(error?.code) ? error.code : 'unknown';
  const sites = [
    ...String(error?.stack ?? '').matchAll(
      /^\s+at [^\n]*?(\/app\/packages\/(?:server|store)\/dist\/[A-Za-z0-9/_-]+\.js:[0-9]+:[0-9]+)/gm,
    ),
  ]
    .slice(0, 8)
    .map((match) => match[1]);
  return 'Restore fixture failure: ' + JSON.stringify({ code, sites });
}

const activationFailures = [
  'verity-compose: managed topology failed readiness; restoring the legacy Server',
  'verity-compose: existing managed topology failed readiness',
  'verity-compose: managed topology failed to start; restoring the legacy Server',
  'verity-compose: existing managed topology could not be reconciled',
];

/** Return static failure markers and code positions from private installer/container output.
 * @param {unknown} contents
 */
export function formatRestoreLog(contents) {
  const text = String(contents).slice(-1024 * 1024);
  const failures = activationFailures.filter((message) => text.includes(message));
  const sites = [
    ...new Set(
      [
        ...text.matchAll(
          /\/app\/packages\/(?:server|store)\/dist\/[A-Za-z0-9/_-]+\.js:[0-9]+:[0-9]+/g,
        ),
      ].map((match) => match[0]),
    ),
  ].slice(0, 8);
  const codes = new Set();
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line);
      const error = entry?.err ?? entry?.error;
      if (safeCodes.has(error?.code)) codes.add(error.code);
    } catch {
      /* Plain installer output is scanned only for the static markers above. */
    }
  }
  return 'Restore activation diagnostic: ' + JSON.stringify({ failures, sites, codes: [...codes] });
}
