import { spawn } from 'node:child_process';

export class BackupLockBusyError extends Error {
  constructor() {
    super('Backup repository locked');
  }
}

/** A kernel-held lock survives neither process death nor reboot; there is no stale lock recovery. */
export async function withRepositoryLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const child = spawn(
    'flock',
    ['--exclusive', '--nonblock', '--', path, 'sh', '-c', 'printf "locked\\n"; cat >/dev/null'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let lost = false;
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => {
      lost = true;
      resolve();
    });
  });
  // Keep an error handler attached even if startup fails before we await exit.
  void exited.catch(() => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString();
        if (output === 'locked\n') resolve();
      });
      child.once('error', reject);
      child.once('exit', (code) =>
        reject(code === 1 ? new BackupLockBusyError() : new Error('Backup flock unavailable')),
      );
    });
    const result = await action();
    if (lost) throw new Error('Backup repository lock lost');
    return result;
  } finally {
    child.stdin.end();
    await exited;
  }
}
