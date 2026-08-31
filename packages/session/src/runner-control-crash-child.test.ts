import { appendFile } from 'node:fs/promises';
import { describe, it } from 'vitest';
import { serveControl } from './runner-control.js';

const socketPath = process.env.VERITY_CONTROL_CRASH_SOCKET;
const journalPath = process.env.VERITY_CONTROL_CRASH_JOURNAL;
const effectPath = process.env.VERITY_CONTROL_CRASH_EFFECT;
const describeCrash =
  socketPath === undefined || journalPath === undefined || effectPath === undefined
    ? describe.skip
    : describe;

describeCrash('control journal crash child', () => {
  it('dies after the external effect but before the settled journal record', async () => {
    await serveControl(
      socketPath!,
      {
        steer: async (message) => {
          await appendFile(effectPath!, `${message.text}\n`);
          process.kill(process.pid, 'SIGKILL');
          return true;
        },
        cancel: () => true,
        answerPermission: () => true,
      },
      { turnId: 'turn-crash', authorizeAcquire: () => true, journalPath: journalPath! },
    );
    process.stdout.write('CONTROL_CRASH_READY\n');
    await new Promise(() => undefined);
  });
});
