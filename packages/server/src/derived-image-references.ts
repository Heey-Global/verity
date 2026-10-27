import type { Kysely } from 'kysely';
import type { Database } from '@verity/store';
import { devcontainerImageTag } from './provisioner.js';

/** One active Server owns each project Engine. Persisted project selections survive
 * restarts; temporary reservations cover build -> import -> container creation.
 * The same gate serializes reservation against collection, closing the gap between
 * an image listing and deletion. No long-lived database transaction is required.
 */
export interface DerivedImageSnapshot {
  refs: ReadonlySet<string>;
  repositories: ReadonlySet<string>;
}
export class DerivedImageReferences {
  private readonly held = new Map<string, Set<string>>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly readProjects: () => Promise<DerivedImageSnapshot>) {}

  private async exclusive<T>(run: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      return await run();
    } finally {
      unlock();
    }
  }

  async reserve(projectId: string, ref: string): Promise<void> {
    await this.exclusive(() => {
      const refs = this.held.get(projectId) ?? new Set<string>();
      refs.add(ref);
      this.held.set(projectId, refs);
    });
  }
  async releaseProject(projectId: string): Promise<void> {
    await this.exclusive(() => {
      this.held.delete(projectId);
    });
  }
  async withSnapshot<T>(run: (snapshot: DerivedImageSnapshot) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      // A failed DB read must skip collection, never turn all projects into orphans.
      const projects = await this.readProjects();
      const refs = new Set(projects.refs);
      for (const held of this.held.values()) for (const ref of held) refs.add(ref);
      return run({ refs, repositories: projects.repositories });
    });
  }
}

/** Read from durable rows on every pass, including selections of absent projects. */
export function createProjectImageReferences(db: Kysely<Database>): DerivedImageReferences {
  return new DerivedImageReferences(async () => {
    const projects = await db
      .selectFrom('projects')
      .select(['image_ref', 'image_override_ref', 'owner', 'repo'])
      .where('hidden_at', 'is', null)
      .execute();
    return {
      refs: new Set(
        projects.flatMap((project) =>
          [project.image_ref, project.image_override_ref].filter(
            (ref): ref is string => ref !== null,
          ),
        ),
      ),
      repositories: new Set(
        projects.map(
          (project) => devcontainerImageTag(project.owner, project.repo, 'current').split(':')[0]!,
        ),
      ),
    };
  });
}
