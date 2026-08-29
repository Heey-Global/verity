export interface ProjectEnvironmentSettings {
  defaultBranch: string | null;
  defaultModel: string | null;
}

function put(env: Record<string, string>, key: string, value: string | null): void {
  const trimmed = value?.trim();
  if (trimmed) env[key] = trimmed;
}

/** Environment projected into a project's container for agents and runtime commands. */
export function projectSettingsEnv(
  settings: ProjectEnvironmentSettings | null | undefined,
): Record<string, string> | undefined {
  if (settings === null || settings === undefined) return undefined;
  const env: Record<string, string> = {};
  put(env, 'VERITY_PROJECT_DEFAULT_BRANCH', settings.defaultBranch);
  put(env, 'VERITY_PROJECT_DEFAULT_MODEL', settings.defaultModel);
  return Object.keys(env).length > 0 ? env : undefined;
}

/** A secret whose VALUE must not appear on the `docker exec` command line (audit
 *  M8): actual tokens/secrets/keys, but NOT the reference/path vars that merely
 *  point at them (`*_REF`, `*_FILE`, `*_URL`, …), which are non-secret and stay
 *  inline so they can't accidentally clobber the docker CLI's own env (e.g. PATH). */
export function isSensitiveEnvKey(key: string): boolean {
  if (/_(REF|FILE|PATH|URL|DIR|HOME|NAME|ID)$/i.test(key)) return false;
  return /(TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|API_KEY)/i.test(key);
}

/**
 * Build `docker exec -e …` flags. Non-secret vars stay INLINE (`-e NAME=value`) as
 * before. Secret vars (see {@link isSensitiveEnvKey}) are passed BY REFERENCE
 * (`-e NAME`) with their value returned in `env` for the caller to place in the
 * docker CLI's OWN process environment (audit M8): the old inline form put the
 * value (notably `DOPPLER_TOKEN`) on the command line, where `ps` /
 * `/proc/<pid>/cmdline` exposes it to any process in the server's PID namespace.
 * `-e NAME` (no `=`) makes docker read it from its own env instead, which lives in
 * `/proc/<pid>/environ` (same-uid only), not argv. The caller MUST spread the
 * returned `env` into the spawned docker process's environment.
 */
export function dockerEnvPassthrough(env: Record<string, string> | undefined): {
  args: string[];
  env: Record<string, string>;
} {
  if (env === undefined) return { args: [], env: {} };
  const args: string[] = [];
  const passEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isSensitiveEnvKey(key)) {
      args.push('-e', key);
      passEnv[key] = value;
    } else {
      args.push('-e', `${key}=${value}`);
    }
  }
  return { args, env: passEnv };
}
