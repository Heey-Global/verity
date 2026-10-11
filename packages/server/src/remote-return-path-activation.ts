import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { RETURN_PATH_LIMITS } from './remote-return-path-diagnostics.js';

type Selection = { installationId: string; expiresAt: number };
export interface ReturnPathStatus {
  enabled: boolean;
  source: 'runtime' | 'environment' | 'none';
  installationFingerprint: string | null;
  expiresAt: string | null;
  currentUtc: string;
  remainingMs: number;
  matchedConnectors: number;
}

/** Consent never survives restart, reconnect or a wall-clock rollback. */
export class ReturnPathActivation {
  private selection: Selection | undefined;
  private source: ReturnPathStatus['source'] = 'none';
  private deadline = 0;
  private matched = false;
  private timer: NodeJS.Timeout | undefined;
  private listeners = new Set<() => void>();
  private finalizers = new Set<() => void>();
  constructor(
    private readonly descriptor: () => { enabled: boolean; installationId?: string },
    environment?: Selection,
    private readonly wall = Date.now,
    private readonly monotonic = () => performance.now(),
  ) {
    if (environment && environment.expiresAt > wall()) this.select(environment, 'environment');
  }
  private select(selection: Selection, source: 'runtime' | 'environment'): void {
    this.matched = source === 'runtime';
    this.selection = selection;
    this.source = source;
    this.deadline =
      this.monotonic() + Math.min(RETURN_PATH_LIMITS.durationMs, selection.expiresAt - this.wall());
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.expiry(), 1_000);
    this.timer.unref();
    this.notify();
  }
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  beforeStop(listener: () => void): () => void {
    this.finalizers.add(listener);
    return () => this.finalizers.delete(listener);
  }
  expiry(): number | undefined {
    const selection = this.selection;
    if (!selection) return undefined;
    const descriptor = this.descriptor();
    if (this.wall() >= selection.expiresAt || this.monotonic() >= this.deadline) {
      this.stop(false);
      return undefined;
    }
    if (!descriptor.enabled || descriptor.installationId !== selection.installationId) {
      if (this.matched) this.stop(false);
      return undefined;
    }
    this.matched = true;
    return selection.expiresAt;
  }
  start(expiresAt: string): ReturnPathStatus {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(expiresAt))
      throw new Error('invalid_expiry');
    const expiry = Date.parse(expiresAt);
    if (
      !Number.isFinite(expiry) ||
      new Date(expiry).toISOString().slice(0, 19) !== expiresAt.slice(0, 19) ||
      expiry <= this.wall() ||
      expiry - this.wall() > RETURN_PATH_LIMITS.durationMs
    )
      throw new Error('invalid_expiry');
    const descriptor = this.descriptor();
    if (!descriptor.enabled || !descriptor.installationId) throw new Error('remote_unavailable');
    if (this.expiry() !== undefined) {
      if (this.selection?.expiresAt !== expiry) throw new Error('already_active');
      return this.status();
    }
    this.select({ installationId: descriptor.installationId, expiresAt: expiry }, 'runtime');
    return this.status();
  }
  stop(flush = true): void {
    if (flush && this.expiry() !== undefined) {
      for (const finalize of this.finalizers) {
        // A failed export cannot leave a Stop request collecting metadata.
        try {
          finalize();
        } catch {
          /* Consent still ends below. */
        }
      }
    }
    const hadSelection = this.selection !== undefined;
    this.matched = false;
    this.selection = undefined;
    this.source = 'none';
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (hadSelection) this.notify();
  }
  status(matchedConnectors = 0): ReturnPathStatus {
    const expiry = this.expiry();
    return {
      enabled: expiry !== undefined,
      source: this.source,
      installationFingerprint: this.selection
        ? createHash('sha256').update(this.selection.installationId).digest('hex').slice(0, 16)
        : null,
      expiresAt: expiry === undefined ? null : new Date(expiry).toISOString(),
      currentUtc: new Date(this.wall()).toISOString(),
      remainingMs:
        expiry === undefined
          ? 0
          : Math.max(0, Math.min(expiry - this.wall(), this.deadline - this.monotonic())),
      matchedConnectors: expiry === undefined ? 0 : matchedConnectors,
    };
  }
  dispose(): void {
    this.stop();
    this.listeners.clear();
    this.finalizers.clear();
  }
}
