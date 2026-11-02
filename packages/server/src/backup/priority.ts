import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

const scope = new AsyncLocalStorage<BackupWork>();
export const backupWork = (): BackupWork | undefined => scope.getStore();
export function backupCommand(command: string, args: string[]): [string, string[]] {
  if (!existsSync('/usr/bin/nice')) return [command, args];
  return [
    '/usr/bin/nice',
    [
      '-n',
      '19',
      ...(existsSync('/usr/bin/ionice') ? ['/usr/bin/ionice', '-c', '3'] : []),
      command,
      ...args,
    ],
  ];
}

/** One bounded job at a time; no unbounded queue or worker pool competes with the Server. */
export class BackupWork {
  private readonly worker: Worker;
  private next = 0;
  private pending:
    { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
  private failed: Error | undefined;
  readonly ready: Promise<{ nice: number; tid: number; idleIO: boolean }>;
  constructor() {
    const compiled = new URL('./priority-worker.js', import.meta.url);
    this.worker = new Worker(
      existsSync(compiled) ? compiled : new URL('./priority-worker.ts', import.meta.url),
    );
    this.ready = new Promise((resolve, reject) => {
      this.worker.on(
        'message',
        (message: {
          ready?: boolean;
          nice: number;
          tid: number;
          idleIO: boolean;
          id?: number;
          error?: boolean;
          code?: string;
          result?: unknown;
        }) => {
          if (message.ready) {
            resolve(message);
            return;
          }
          const pending = this.pending;
          if (!pending || pending.id !== message.id) return;
          this.pending = undefined;
          if (message.error)
            pending.reject(Object.assign(new Error('Backup work failed'), { code: message.code }));
          else pending.resolve(message.result);
        },
      );
      const fail = () => {
        this.failed = new Error('Backup worker stopped');
        reject(this.failed);
        this.pending?.reject(this.failed);
        this.pending = undefined;
      };
      this.worker.on('error', fail);
      this.worker.on('exit', fail);
    });
    void this.ready.catch(() => undefined);
  }
  async call(
    kind: 'encrypt' | 'fingerprint' | 'write' | 'file',
    bytes: Uint8Array,
    options: { key?: string; path?: string; immutable?: boolean; fd?: number } = {},
  ): Promise<unknown> {
    await this.ready;
    if (this.failed) throw this.failed;
    if (this.pending) throw new Error('Backup worker is busy');
    if (bytes.byteLength > 32 * 1024 * 1024) throw new Error('Backup worker byte budget exceeded');
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      this.worker.postMessage({ id, kind, bytes, ...options });
    });
  }
  async close(): Promise<void> {
    await this.worker.terminate();
  }
}
export async function withBackupWork<T>(action: () => Promise<T>): Promise<T> {
  if (backupWork()) return action();
  const work = new BackupWork();
  try {
    await work.ready;
    return await scope.run(work, action);
  } finally {
    await work.close();
  }
}
