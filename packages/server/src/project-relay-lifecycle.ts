import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import type {
  InternalConnectionIdentity,
  ProjectInternalUnixListener,
} from './internal-listener.js';
import type { ProjectClaudeUnixListener } from './project-claude-unix-listener.js';
import type { SigningCapabilityRegistry } from './signing-capability.js';

export interface ProjectRelayBinding {
  projectId: string;
  owner: string;
  repo: string;
  containerGeneration: string;
  claudeGateway: { host: string; port: number };
  codexGateway?: { host: string; port: number };
}

export interface ProjectRelayRuntime {
  close(): Promise<void>;
}

/** Start failed after acquiring a retryable runtime resource. */
export class ProjectRelayStartError extends Error {
  constructor(
    message: string,
    readonly runtime: ProjectRelayRuntime,
    override readonly cause: unknown,
  ) {
    super(message, { cause });
    this.name = 'ProjectRelayStartError';
  }
}

export interface ProjectRelayStartContext {
  identity: InternalConnectionIdentity;
  brokerSocketPath: string;
  claudeSocketPath: string;
  codexSocketPath?: string;
  /** Adopt the generation's existing container instead of creating a namesake. */
  resumeExisting?: boolean;
}

export interface ProjectRelayActivation {
  identity: InternalConnectionIdentity;
  signingCapability: string;
  githubCapability: string;
}

export interface ProjectRelayLifecycleOptions {
  signingCapabilities: SigningCapabilityRegistry;
  githubCapabilities: GhTokenCapabilityRegistry;
  startBrokerListener(identity: InternalConnectionIdentity): Promise<ProjectInternalUnixListener>;
  startClaudeListener(
    identity: InternalConnectionIdentity,
    gateway: { host: string; port: number },
  ): Promise<ProjectClaudeUnixListener>;
  startCodexListener?(
    identity: InternalConnectionIdentity,
    gateway: { host: string; port: number },
  ): Promise<ProjectClaudeUnixListener>;
  startRelay(context: ProjectRelayStartContext): Promise<ProjectRelayRuntime>;
}

interface ActiveRelay {
  containerGeneration: string;
  brokerListener?: ProjectInternalUnixListener;
  claudeListener?: ProjectClaudeUnixListener;
  codexListener?: ProjectClaudeUnixListener;
  runtime?: ProjectRelayRuntime;
}

/**
 * Owns the fail-closed transaction around one project's broker listener, scoped
 * capabilities, and relay runtime. Docker-specific creation stays behind
 * `startRelay`, so this ordering can be unit-tested without weakening the
 * container boundary.
 */
export class ProjectRelayLifecycle {
  private readonly active = new Map<string, ActiveRelay>();
  /** Generations whose `start` is running right now, by project. Deliberately NOT
   *  folded into `active`, whose "fully started" meaning the reconciler depends on
   *  ({@link isActive}) must not change — this only widens what {@link heldRelays}
   *  reports, so a relay container is covered from before it is created until it
   *  is torn down, with no uncovered stretch in between. */
  private readonly starting = new Map<string, string>();
  private readonly operationTails = new Map<string, Promise<void>>();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: ProjectRelayLifecycleOptions) {}

  async start(binding: ProjectRelayBinding): Promise<ProjectRelayActivation> {
    if (this.closed) throw new Error('project relay lifecycle is closed');
    return this.serialize(binding.projectId, () => this.startExclusive(binding));
  }

  /** Reattach this process to an existing relay generation after a Server restart.
   * The sandbox still carries the raw capabilities issued for that generation and
   * their hashes are durable in PostgreSQL, so rotating them here would strand the
   * running sandbox. Only the process-local listeners and relay runtime are rebuilt. */
  async resume(binding: ProjectRelayBinding): Promise<void> {
    if (this.closed) throw new Error('project relay lifecycle is closed');
    return this.serialize(binding.projectId, () => this.resumeExclusive(binding));
  }

  async stop(projectId: string): Promise<void> {
    return this.serialize(projectId, () => this.stopExclusive(projectId));
  }

  /**
   * Whether THIS server process currently owns a fully started relay for the
   * project — the listeners and the capabilities issued behind it, not merely a
   * container that happens to exist. A restarted server owns none, so every
   * capability its predecessor wrote into a still-running sandbox is already dead;
   * the reconciler uses this to tell an orphaned sandbox from a healthy one.
   * Entries appear only once `start` has completed and are dropped on a clean
   * teardown, so a start in flight reads false — the reconciler skips in-flight
   * provisions separately, so that can never race into a recreate.
   */
  isActive(projectId: string, containerGeneration?: string): boolean {
    const active = this.active.get(projectId);
    return (
      active !== undefined &&
      (containerGeneration === undefined || active.containerGeneration === containerGeneration)
    );
  }

  /**
   * The project + generation of every relay this process currently holds.
   *
   * The GC's relay sweep collects a relay that no sandbox claims, which is right
   * for a leak but wrong for a provision still in flight: the relay is started
   * BEFORE its sandbox container is created, so between the two there is nothing
   * on the daemon to vouch for it. Neither guard the sweep already has closes
   * that — the 30-minute grace period is elapsed time, which a stalled multi-GB
   * image pull outlasts, and the re-listing before removal only narrows the
   * window between planning and deleting; both still see a project whose sandbox
   * simply does not exist yet, and delete the relay it is about to be wired to.
   * This is the authoritative answer instead: a relay we are still holding is in
   * use by definition, whatever the daemon's listing looks like.
   *
   * Covers a start that is still RUNNING as well as a completed one — the relay
   * container exists partway through the former, so reporting only completed
   * starts would leave exactly the same uncovered window one level down.
   */
  heldRelays(): Array<{ projectId: string; containerGeneration: string }> {
    const held = new Map<string, { projectId: string; containerGeneration: string }>();
    // Starting first, activated second: while a start is running for a project
    // both can name it, and the two agree on the generation anyway.
    for (const [projectId, containerGeneration] of [
      ...this.starting.entries(),
      ...[...this.active.entries()].map(([id, entry]) => [id, entry.containerGeneration] as const),
    ]) {
      held.set(`${projectId}\0${containerGeneration}`, { projectId, containerGeneration });
    }
    return [...held.values()];
  }

  async close(): Promise<void> {
    this.closed = true;
    return (this.closing ??= (async () => {
      while (this.operationTails.size > 0) {
        await Promise.all(
          [...this.operationTails.values()].map((tail) => tail.catch(() => undefined)),
        );
      }
      const results = await Promise.all(
        [...this.active.keys()].map((projectId) =>
          this.stop(projectId).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
        ),
      );
      const failures = results.flatMap((result) => (result.ok ? [] : [result.error]));
      if (failures.length > 0)
        throw new AggregateError(failures, 'project relay lifecycle shutdown failed');
    })());
  }

  /** Close only process-owned listeners during a control-plane handoff. Relay
   * containers and their durable capabilities deliberately survive so the next
   * Server can resume them without interrupting sandbox processes. */
  async suspend(): Promise<void> {
    this.closed = true;
    while (this.operationTails.size > 0) {
      await Promise.all(
        [...this.operationTails.values()].map((tail) => tail.catch(() => undefined)),
      );
    }
    const failures: unknown[] = [];
    for (const [projectId, entry] of this.active) {
      const entryFailures: unknown[] = [];
      for (const key of ['brokerListener', 'claudeListener', 'codexListener'] as const) {
        const listener = entry[key];
        if (listener === undefined) continue;
        const result = await runCleanup(() => listener.close());
        if (result.ok) {
          if (key === 'brokerListener') delete entry.brokerListener;
          else if (key === 'claudeListener') delete entry.claudeListener;
          else delete entry.codexListener;
        } else entryFailures.push(result.error);
      }
      failures.push(...entryFailures);
      // A failed close leaves authority in an unknown live state. Retain the
      // entry so a later suspend/close can retry those process-owned handles.
      if (entryFailures.length === 0) this.active.delete(projectId);
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'project relay lifecycle suspend failed');
  }

  private async startExclusive(binding: ProjectRelayBinding): Promise<ProjectRelayActivation> {
    validateBinding(binding);
    if (this.active.has(binding.projectId)) {
      throw new Error(`project relay already active: ${binding.projectId}`);
    }
    // Claim the generation BEFORE anything can create its container, and hold the
    // claim until the entry has moved into `active`. A start that stalls after
    // creating the relay would otherwise leave that container claimed by nobody:
    // no sandbox names it, this process does not report it, and once it ages past
    // the sweep's grace period the GC would collect a relay a live provision is
    // about to hand to its sandbox.
    this.starting.set(binding.projectId, binding.containerGeneration);
    try {
      const activation = await this.startClaimed(binding);
      if (activation === undefined)
        throw new Error('project relay activation returned no capabilities');
      return activation;
    } finally {
      this.starting.delete(binding.projectId);
    }
  }

  private async resumeExclusive(binding: ProjectRelayBinding): Promise<void> {
    validateBinding(binding);
    if (this.active.has(binding.projectId)) return;
    this.starting.set(binding.projectId, binding.containerGeneration);
    try {
      await this.startClaimed(binding, false);
    } finally {
      this.starting.delete(binding.projectId);
    }
  }

  private async startClaimed(
    binding: ProjectRelayBinding,
    issueCapabilities = true,
  ): Promise<ProjectRelayActivation | void> {
    if (binding.codexGateway !== undefined && this.options.startCodexListener === undefined) {
      throw new Error('project relay Codex gateway has no listener implementation');
    }
    const identity = {
      projectId: binding.projectId,
      containerGeneration: binding.containerGeneration,
    } satisfies InternalConnectionIdentity;
    const brokerListener = await this.options.startBrokerListener(identity);
    let claudeListener: ProjectClaudeUnixListener | undefined;
    let codexListener: ProjectClaudeUnixListener | undefined;
    let runtime: ProjectRelayRuntime | undefined;
    try {
      claudeListener = await this.options.startClaudeListener(identity, binding.claudeGateway);
      if (binding.codexGateway !== undefined && this.options.startCodexListener !== undefined) {
        codexListener = await this.options.startCodexListener(identity, binding.codexGateway);
      }
      const signingCapability = issueCapabilities
        ? await this.options.signingCapabilities.issue(identity)
        : undefined;
      const githubCapability = issueCapabilities
        ? await this.options.githubCapabilities.issue({
            projectId: binding.projectId,
            owner: binding.owner,
            repo: binding.repo,
            containerGeneration: binding.containerGeneration,
          })
        : undefined;
      runtime = await this.options.startRelay({
        identity,
        brokerSocketPath: brokerListener.socketPath,
        claudeSocketPath: claudeListener.socketPath,
        ...(codexListener === undefined ? {} : { codexSocketPath: codexListener.socketPath }),
        ...(!issueCapabilities ? { resumeExisting: true } : {}),
      });
      this.active.set(binding.projectId, {
        containerGeneration: binding.containerGeneration,
        brokerListener,
        claudeListener,
        ...(codexListener === undefined ? {} : { codexListener }),
        runtime,
      });
      if (signingCapability !== undefined && githubCapability !== undefined)
        return { identity, signingCapability, githubCapability };
    } catch (error) {
      if (error instanceof ProjectRelayStartError) runtime = error.runtime;
      this.active.set(binding.projectId, {
        containerGeneration: binding.containerGeneration,
        brokerListener,
        ...(claudeListener === undefined ? {} : { claudeListener }),
        ...(codexListener === undefined ? {} : { codexListener }),
        ...(runtime === undefined ? {} : { runtime }),
      });
      const cleanupFailures = await this.teardown(binding.projectId, issueCapabilities);
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          `project relay activation and rollback failed: ${binding.projectId}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async stopExclusive(projectId: string): Promise<void> {
    const failures = await this.teardown(projectId);
    if (failures.length > 0) {
      throw new AggregateError(failures, `project relay teardown failed: ${projectId}`);
    }
  }

  private async teardown(projectId: string, revokeCapabilities = true): Promise<unknown[]> {
    const active = this.active.get(projectId);
    const runtime = active?.runtime;
    const brokerListener = active?.brokerListener;
    const claudeListener = active?.claudeListener;
    const codexListener = active?.codexListener;
    // Invoke every independent fail-closed action before awaiting any one of
    // them. A wedged registry or Docker call cannot prevent the other authority
    // from being revoked or the remaining resources from beginning shutdown.
    const authorityResults = revokeCapabilities
      ? [
          runCleanup(() => this.options.signingCapabilities.revokeProject(projectId)),
          runCleanup(() => this.options.githubCapabilities.revokeProject(projectId)),
        ]
      : [];
    const results = await Promise.all([
      ...authorityResults,
      ...(runtime === undefined ? [] : [runCleanup(() => runtime.close())]),
      ...(brokerListener === undefined ? [] : [runCleanup(() => brokerListener.close())]),
      ...(claudeListener === undefined ? [] : [runCleanup(() => claudeListener.close())]),
      ...(codexListener === undefined ? [] : [runCleanup(() => codexListener.close())]),
    ]);
    const failures = results.flatMap((result) => (result.ok ? [] : [result.error]));
    let resultIndex = authorityResults.length;
    if (runtime !== undefined) {
      if (results[resultIndex]?.ok === true) delete active!.runtime;
      resultIndex += 1;
    }
    if (brokerListener !== undefined) {
      if (results[resultIndex]?.ok === true) delete active!.brokerListener;
      resultIndex += 1;
    }
    if (claudeListener !== undefined && results[resultIndex]?.ok === true)
      delete active!.claudeListener;
    if (claudeListener !== undefined) resultIndex += 1;
    if (codexListener !== undefined && results[resultIndex]?.ok === true)
      delete active!.codexListener;
    if (failures.length === 0) this.active.delete(projectId);
    return failures;
  }

  private async serialize<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.operationTails.set(projectId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.operationTails.get(projectId) === tail) this.operationTails.delete(projectId);
    }
  }
}

function validateBinding(binding: ProjectRelayBinding): void {
  const fields: Array<[string, string]> = [
    ['projectId', binding.projectId],
    ['owner', binding.owner],
    ['repo', binding.repo],
    ['containerGeneration', binding.containerGeneration],
  ];
  for (const [name, value] of fields) {
    if (value.trim() === '') throw new Error(`project relay requires ${name}`);
  }
  if (binding.claudeGateway.host.trim() === '')
    throw new Error('project relay requires claudeGateway.host');
  if (
    !Number.isInteger(binding.claudeGateway.port) ||
    binding.claudeGateway.port < 1 ||
    binding.claudeGateway.port > 65_535
  )
    throw new Error('project relay requires a valid claudeGateway.port');
  if (binding.codexGateway !== undefined) {
    if (binding.codexGateway.host.trim() === '')
      throw new Error('project relay requires codexGateway.host');
    if (
      !Number.isInteger(binding.codexGateway.port) ||
      binding.codexGateway.port < 1 ||
      binding.codexGateway.port > 65_535
    )
      throw new Error('project relay requires a valid codexGateway.port');
  }
}

async function runCleanup(
  task: () => Promise<void>,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    await task();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
