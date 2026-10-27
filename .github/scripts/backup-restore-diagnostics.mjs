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
]);

// Recovery failures can carry private input in messages, causes and process output.
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
