export const DEFAULT_MINIMUM_RESERVE_BYTES: number;
export const KILL_COOLDOWN_MS: number;
export const REARM_GROWTH_FRACTION: number;
export const MINIMUM_VICTIM_RSS_BYTES: number;

export type ReadFile = (path: string) => string;

export interface MemoryCeiling {
  limitBytes: number;
  usageBytes: number;
  source: 'cgroup-v1' | 'cgroup-v2';
}

export interface GuardedProcess {
  pid: number;
  ppid: number;
  uid: number;
  rssBytes: number;
  name: string;
  /** Field 22 of `/proc/<pid>/stat` at snapshot time; `''` when unreadable. */
  startTime: string;
}

/** A process chosen as the root of the tree to kill. */
export interface MemoryGuardVictim extends GuardedProcess {
  /** `session`: a child of a session's ACP adapter; `command`: a child of that; `detached`: a tree under init. */
  tier: 'session' | 'command' | 'detached';
  /** RSS summed over the process and all its descendants. */
  treeRssBytes: number;
}

export interface MemoryGuardLogRecord {
  event: string;
  [key: string]: unknown;
}

export interface MemoryGuardOptions {
  readFile?: ReadFile;
  listPids?: () => string[];
  readLink?: (path: string) => string;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  log?: (record: MemoryGuardLogRecord) => void;
  env?: Record<string, string | undefined>;
  agentUid?: number;
  protectedPids?: Iterable<number>;
  cgroupRoot?: string;
  dryRun?: boolean;
}

export interface MemoryGuardTick {
  outcome:
    | 'no-ceiling'
    | 'not-gvisor'
    | 'below-threshold'
    | 'cooldown'
    | 'suspended'
    | 'no-candidate'
    | 'would-kill'
    | 'kill';
  limitBytes?: number;
  usageBytes?: number;
  source?: MemoryCeiling['source'];
  thresholdBytes?: number;
  victim?: MemoryGuardVictim;
}

export function readMemoryCeiling(
  readFile?: ReadFile,
  cgroupRoot?: string,
): MemoryCeiling | undefined;
export function resolveReserveBytes(
  limitBytes: number,
  env?: Record<string, string | undefined>,
): number;
export function resolvePollIntervalMs(env?: Record<string, string | undefined>): number;
export function listProcesses(readFile?: ReadFile, listPids?: () => string[]): GuardedProcess[];
export function chooseVictim(
  processes: readonly GuardedProcess[],
  options: { agentUid: number; protectedPids?: Set<number>; minimumSessionRssBytes?: number },
): MemoryGuardVictim | undefined;
export function descendantsOf(pid: number, processes: readonly GuardedProcess[]): GuardedProcess[];
export function createMemoryGuard(options: MemoryGuardOptions): { tick(): MemoryGuardTick };
export function probeMemoryGuard(controlDir: string, readFile?: ReadFile): boolean;
