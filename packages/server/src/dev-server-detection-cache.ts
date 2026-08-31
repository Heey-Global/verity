import type { ProjectRecord } from '@verity/store';
import type { DevServerSuggestion } from './dev-server-detection.js';

export const DEV_SERVER_DETECTION_CACHE_TTL_MS = 60_000;

type Detect = (project: ProjectRecord) => Promise<DevServerSuggestion[]>;

/** Small per-project read-through cache for repository detection. The in-flight
 * promise is cached too, so StrictMode mounts and a simultaneous manual Review
 * share one filesystem scan. Classification remains uncached and always uses the
 * current dev_servers rows in dev-server-routes.ts. */
export class DevServerDetectionCache {
  private readonly entries = new Map<
    string,
    { expiresAt: number | null; result: Promise<DevServerSuggestion[]> }
  >();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly detect: Detect,
    private readonly ttlMs = DEV_SERVER_DETECTION_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(project: ProjectRecord): Promise<DevServerSuggestion[]> {
    const cached = this.entries.get(project.id);
    if (cached && (cached.expiresAt === null || cached.expiresAt > this.now())) {
      return cached.result;
    }

    const generation = this.generations.get(project.id) ?? 0;
    const result = this.detect(project).then((suggestions) =>
      (this.generations.get(project.id) ?? 0) === generation ? suggestions : this.get(project),
    );
    const entry: { expiresAt: number | null; result: Promise<DevServerSuggestion[]> } = {
      expiresAt: null,
      result,
    };
    this.entries.set(project.id, entry);
    void result.then(
      () => {
        if (this.entries.get(project.id) === entry) entry.expiresAt = this.now() + this.ttlMs;
      },
      () => {
        if (this.entries.get(project.id) === entry) this.entries.delete(project.id);
      },
    );
    return result;
  }

  invalidate(projectId: string): void {
    this.generations.set(projectId, (this.generations.get(projectId) ?? 0) + 1);
    this.entries.delete(projectId);
  }
}
