import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CODEX_MODEL_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;

interface CodexCatalogResponse {
  models?: unknown;
}

export function parseCodexModelCatalog(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const response = value as CodexCatalogResponse;
  if (!Array.isArray(response.models)) return [];

  const seen = new Set<string>();
  const models: Array<{ id: string; priority: number; index: number }> = [];
  for (const [index, candidate] of response.models.entries()) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const record = candidate as { slug?: unknown; visibility?: unknown; priority?: unknown };
    if (record.visibility !== 'list' || typeof record.slug !== 'string') continue;
    const slug = record.slug.trim();
    if (slug.length === 0 || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      id: `codex/${slug}`,
      priority:
        typeof record.priority === 'number' &&
        Number.isFinite(record.priority) &&
        record.priority >= 0
          ? record.priority
          : Number.POSITIVE_INFINITY,
      index,
    });
  }
  return models.sort((a, b) => a.priority - b.priority || a.index - b.index).map(({ id }) => id);
}

/**
 * The Codex CLI's bundled catalog: `codex debug models --bundled` reports the model
 * list shipped with the binary without reading `CODEX_HOME` or contacting the account.
 * Model discovery deliberately stays credential-free: the Server is not a project mTLS
 * client and must never materialize the subscription login merely to populate a picker.
 */
export async function fetchCodexBundledModels(command = 'codex'): Promise<string[]> {
  const { stdout } = await execFileAsync(command, ['debug', 'models', '--bundled'], {
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
  });
  return parseCodexModelCatalog(JSON.parse(stdout));
}

export interface CodexModelCatalog {
  list: () => string[];
  refresh: () => Promise<void>;
  close: () => Promise<void>;
}

export function startCodexModelCatalog(options: {
  load: () => Promise<string[]>;
  fallback: readonly string[];
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): CodexModelCatalog {
  let models = [...options.fallback];
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight !== undefined) return inFlight;
    inFlight = options
      .load()
      .then((loaded) => {
        if (stopped || loaded.length === 0) return;
        models = [...new Set([...options.fallback, ...loaded])];
      })
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  const timer = setInterval(
    () => void refresh(),
    options.intervalMs ?? CODEX_MODEL_REFRESH_INTERVAL_MS,
  );
  timer.unref();

  return {
    list: () => [...models],
    refresh,
    close: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
