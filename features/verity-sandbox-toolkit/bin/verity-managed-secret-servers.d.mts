import type { ChildProcess, SpawnOptions } from 'node:child_process';
export function listTaggedManagedPids(instanceId: string, procDir?: string): Promise<number[]>;
export function stopTaggedManagedPids(
  instanceId: string,
  signal: 'SIGTERM' | 'SIGKILL',
): Promise<boolean>;
export function createManagedSecretServers(options: {
  uid: number;
  gid: number;
  privilegeDropFlags: readonly string[];
  setprivPath?: string;
  env?: Record<string, string | undefined>;
  spawnChild?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  stopTagged?(instanceId: string, signal: 'SIGTERM' | 'SIGKILL'): Promise<unknown>;
  realpath(path: string): Promise<string>;
  allowedPath(path: string): boolean;
}): {
  handle(
    raw: Record<string, unknown>,
  ): Promise<{ found: boolean; alive?: boolean; exitCode?: number | null; logs?: string }>;
  close(): Promise<void>;
};
