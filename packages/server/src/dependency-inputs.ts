/** Compare install inputs, excluding release-only workspace versions and scripts. */
export function dependencyInputIdentity(path: string, source: string): string {
  const fields = [
    'name',
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
    'optionalDependencies',
    'overrides',
    'resolutions',
    'workspaces',
    'packageManager',
    'engines',
    'os',
    'cpu',
    'libc',
    'bin',
  ];
  const manifest = (value: Record<string, unknown>): unknown =>
    Object.fromEntries(fields.filter((key) => key in value).map((key) => [key, value[key]]));
  const sort = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sort)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, sort(item)]),
          )
        : value;
  if (!/(^|\/)(package.json|package-lock.json|npm-shrinkwrap.json)$/.test(path)) return source;
  const value = JSON.parse(source) as Record<string, unknown>;
  if (path.endsWith('package.json')) return JSON.stringify(sort(manifest(value)));
  if (!value.packages || typeof value.packages !== 'object') return JSON.stringify(sort(value));
  return JSON.stringify(
    sort({
      lockfileVersion: value.lockfileVersion,
      packages: Object.fromEntries(
        Object.entries(value.packages).map(([name, entry]) => [
          name,
          name.startsWith('node_modules/') || name.includes('/node_modules/')
            ? entry
            : manifest(entry as Record<string, unknown>),
        ]),
      ),
    }),
  );
}
