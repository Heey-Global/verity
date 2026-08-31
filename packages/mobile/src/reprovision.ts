// Reprovision orchestration: recreate every *active* project container so they
// pick up changed global settings (Git identity / signing paths). Pure and
// framework-agnostic — the settings screen wires `recreate` to the Verity client
// and `onProgress` to React state. Kept here next to the client + `ProjectRecord`
// so it can be unit-tested without the React Native app.
import type { ProjectRecord } from './api.js';

export type ReprovisionProgress = { total: number; done: number };

export type ReprovisionResult = {
  /** Number of active containers attempted (0 when nothing was running). */
  total: number;
  /** Number processed (always equals `total` once settled). */
  done: number;
  /** `owner/repo` of containers whose recreate threw — the run continues past failures. */
  failed: string[];
};

/**
 * Recreate each `active` project container in sequence. Only `active` projects are
 * touched — `absent` / `cloning` / `container_starting` / `failed` are skipped, mirroring
 * the server's `recreate-container` precondition (it 409s on those). A failure on one
 * container is collected into `failed` and does NOT abort the rest.
 */
export async function reprovisionActiveProjects(
  projects: ProjectRecord[],
  recreate: (projectId: string) => Promise<unknown>,
  onProgress?: (progress: ReprovisionProgress) => void,
): Promise<ReprovisionResult> {
  const active = projects.filter((project) => project.state === 'active');
  const failed: string[] = [];
  let done = 0;
  onProgress?.({ total: active.length, done });
  for (const project of active) {
    try {
      await recreate(project.id);
    } catch {
      failed.push(`${project.owner}/${project.repo}`);
    }
    done += 1;
    onProgress?.({ total: active.length, done });
  }
  return { total: active.length, done, failed };
}
