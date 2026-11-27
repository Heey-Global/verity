/**
 * A set that tells its observers each value that entered or left it. Writers
 * keep using it as a plain `Set`, so a condition held in one becomes
 * observable without every place that changes it having to announce.
 */
export class ObservedSet<T> extends Set<T> {
  // Created on first use: `Set`'s constructor adds initial values before
  // subclass fields exist.
  private observers: Set<(value: T) => void> | undefined;

  /** Observe every value that enters or leaves; returns the function that
   * stops observing. */
  observe(observer: (value: T) => void): () => void {
    (this.observers ??= new Set()).add(observer);
    return () => {
      this.observers?.delete(observer);
    };
  }

  override add(value: T): this {
    if (this.has(value)) return this;
    super.add(value);
    this.changed(value);
    return this;
  }

  override delete(value: T): boolean {
    if (!super.delete(value)) return false;
    this.changed(value);
    return true;
  }

  override clear(): void {
    const values = [...this];
    super.clear();
    for (const value of values) this.changed(value);
  }

  private changed(value: T): void {
    for (const observer of [...(this.observers ?? [])]) {
      try {
        observer(value);
      } catch {
        // An observer's failure must not fail the write that changed the set.
      }
    }
  }
}
