import { createHash } from 'node:crypto';
import { liveResourceInterval, type LiveResource } from '@verity/events';

type Reader = (resource: LiveResource) => Promise<{ statusCode: number; body: string }>;
type Listener = { read: Reader; changed: () => void; initial: boolean };
type Entry = {
  resource: LiveResource;
  listeners: Set<Listener>;
  digest?: string;
  authorized?: boolean;
  running: boolean;
  pending: boolean;
  next: number;
};

/** Shared observation of external state. Devices receive only invalidations;
 * the normal HTTP read remains the authorization and data-delivery boundary. */
export class ResourceObserver {
  private readonly entries = new Map<string, Entry>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private sweeping = false;
  constructor() {
    this.timer = setInterval(() => void this.sweep(), 500);
    this.timer.unref();
  }

  watch(
    userKey: string,
    resource: LiveResource,
    read: Reader,
    changed: () => void,
  ): (() => void) | undefined {
    if (this.closed || liveResourceInterval(resource.path) === undefined) return undefined;
    const key = JSON.stringify([userKey, resource]);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 2048) return undefined;
      entry = { resource, listeners: new Set(), running: false, pending: false, next: 0 };
      this.entries.set(key, entry);
    }
    const listener = { read, changed, initial: true };
    entry.listeners.add(listener);
    if (!entry.running) entry.next = 0;
    void this.sweep();
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) this.entries.delete(key);
    };
  }

  invalidate(path: string): void {
    const parts = path.split('?')[0]!.split('/');
    for (const entry of this.entries.values()) {
      const watched = entry.resource.path.split('?')[0]!.split('/');
      let affected = false;
      if (parts[1] === 'sessions')
        affected =
          watched[1] === 'sessions' && (watched[2] === undefined || watched[2] === parts[2]);
      else if (parts[1] === 'projects')
        affected =
          watched[1] === 'projects' &&
          (watched[2] === undefined || parts[2] === undefined || watched[2] === parts[2]);
      else if (parts[1] === 'server') affected = watched[1] === 'server';
      else if (['settings', 'secret', 'github', 'onboarding'].includes(parts[1] ?? ''))
        affected = ['settings', 'onboarding'].includes(watched[1] ?? '');
      if (!affected) continue;
      entry.next = 0;
      if (entry.running) entry.pending = true;
    }
    void this.sweep();
  }

  private async sweep(): Promise<void> {
    if (this.sweeping || this.closed) return;
    this.sweeping = true;
    try {
      for (const entry of this.entries.values()) {
        if (this.closed) break;
        if (entry.next <= Date.now()) await this.sample(entry);
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async sample(entry: Entry): Promise<void> {
    if (this.closed || entry.running || entry.listeners.size === 0) return;
    entry.running = true;
    try {
      const listener = entry.listeners.values().next().value!;
      const result = await listener.read(entry.resource);
      if (this.closed || entry.listeners.size === 0) return;
      const digest = createHash('sha256')
        .update(String(result.statusCode))
        .update(result.body)
        .digest('hex');
      if (result.statusCode >= 200 && result.statusCode < 300) {
        for (const current of entry.listeners) {
          // A write can land between the screen's read and subscription. The
          // first authorized snapshot therefore always prompts a fresh read.
          if (current.initial || (entry.digest !== undefined && entry.digest !== digest))
            current.changed();
          current.initial = false;
        }
      }
      if (
        entry.authorized === true &&
        (result.statusCode === 401 || result.statusCode === 403 || result.statusCode === 404)
      ) {
        for (const current of entry.listeners) current.changed();
      }
      entry.authorized = result.statusCode >= 200 && result.statusCode < 300;
      if (!entry.pending) entry.digest = digest;
      // Provisioning needs prompt observation even with the list cache enabled.
      const provisioning =
        /"(?:lifecycleState|state)":"(?:cloning|container_starting|sleeping_starting|waking)"/u.test(
          result.body,
        );
      entry.next = Date.now() + (provisioning ? 2_000 : liveResourceInterval(entry.resource.path)!);
    } catch {
      // The next backend observation retries; a transient read must not drop a
      // subscription or erase the client's last successful result.
      entry.next = Date.now() + 3_000;
    } finally {
      entry.running = false;
      if (entry.pending) {
        entry.pending = false;
        entry.next = 0;
      }
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.entries.clear();
  }
}
