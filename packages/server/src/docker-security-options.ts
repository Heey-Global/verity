/** Docker inspection may retain the legacy spelling on existing containers. */
export function normalizeSecurityOptions(options: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (options ?? []).map((option) =>
        option === 'no-new-privileges' || option === 'no-new-privileges:true'
          ? 'no-new-privileges=true'
          : option,
      ),
    ),
  ];
}

export function hasNoNewPrivileges(options: readonly string[] | undefined): boolean {
  return normalizeSecurityOptions(options).includes('no-new-privileges=true');
}
