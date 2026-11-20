/** A desired run is intent, not evidence that a listener is alive. */
export class ManagedDevServerLiveness {
  private initialized = false;
  private readonly wanted = new Map<string, { projectId: string; verifiedAt?: number }>();

  constructor(
    private readonly now: () => number,
    private readonly maxAgeMs: number,
  ) {}

  want(id: string, projectId: string): void {
    if (!this.wanted.has(id)) this.wanted.set(id, { projectId });
  }

  reconcile(instances: readonly { id: string; projectId: string }[]): void {
    this.initialized = true;
    const ids = new Set(instances.map((instance) => instance.id));
    for (const id of this.wanted.keys()) if (!ids.has(id)) this.wanted.delete(id);
    for (const instance of instances) this.want(instance.id, instance.projectId);
  }

  verify(id: string): void {
    const entry = this.wanted.get(id);
    if (entry) entry.verifiedAt = this.now();
  }

  invalidate(id: string): void {
    const entry = this.wanted.get(id);
    if (entry) delete entry.verifiedAt;
  }

  remove(id: string): void {
    this.wanted.delete(id);
  }

  private fresh(verifiedAt: number | undefined): boolean {
    const age = verifiedAt === undefined ? Infinity : this.now() - verifiedAt;
    return age >= 0 && age <= this.maxAgeMs;
  }

  verified(id: string): boolean {
    return this.fresh(this.wanted.get(id)?.verifiedAt);
  }

  running(projectId: string): boolean {
    return [...this.wanted.values()].some(
      (entry) => entry.projectId === projectId && this.fresh(entry.verifiedAt),
    );
  }

  unverified(projectId: string): boolean {
    return (
      !this.initialized ||
      [...this.wanted.values()].some(
        (entry) => entry.projectId === projectId && !this.fresh(entry.verifiedAt),
      )
    );
  }
}
