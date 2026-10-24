export function migrateOpenCodeSession(
  sourcePath: string,
  targetPath: string,
  rootId: string,
): Promise<{ migrated: boolean; sessionIds: string[] }>;

export function purgeOpenCodeSessions(sourcePath: string, sessionIds: string[]): Promise<void>;
