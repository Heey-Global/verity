import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

/** Publication and reclamation must observe one stable selection across containers. */
export async function withAgentSeedLease<T>(root: string, run: () => Promise<T>): Promise<T> {
  const holder = spawn(
    'flock',
    [
      '--nonblock',
      join(await realpath(root), '.seed-lifecycle.lock'),
      'sh',
      '-c',
      'printf "locked\\n"; cat >/dev/null',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      holder.once('error', reject);
      holder.once('exit', () => reject(new Error('agent-seed lifecycle is busy')));
      holder.stdout.setEncoding('utf8');
      holder.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.includes('locked\n')) resolve();
      });
    });
    return await run();
  } finally {
    holder.stdin.end();
    if (holder.pid !== undefined) await exited;
  }
}
