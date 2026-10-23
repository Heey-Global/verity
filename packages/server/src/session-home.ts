import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Must agree with the privileged spawn broker's stable container-relative layout. */
export function sessionHomePath(runtimeDir: string, sessionId: string): string {
  if (
    !sessionId ||
    sessionId.length > 256 ||
    Array.from(sessionId).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new Error('invalid session id');
  return join(runtimeDir, 'session-homes', createHash('sha256').update(sessionId).digest('hex'));
}
