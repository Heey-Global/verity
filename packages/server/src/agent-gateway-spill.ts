import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createSecretCipher } from '@verity/store';

interface ClaudeSpillPayload {
  version: 1;
  accessToken: string;
}

/** Encrypted local recovery cache. The key is supplied at unseal time and is
 * never written by the gateway; only the authenticated ciphertext is durable. */
export class AgentGatewaySpill {
  constructor(private readonly path: string) {}

  async unseal(keyMaterial: string, accessToken?: string): Promise<string | undefined> {
    const cipher = createSecretCipher(keyMaterial);
    if (accessToken !== undefined) {
      validateAccessToken(accessToken);
      const payload: ClaudeSpillPayload = { version: 1, accessToken };
      const encrypted = cipher.encrypt(JSON.stringify(payload));
      await this.writeAtomically(`${encrypted}\n`);
      return accessToken;
    }
    let stored: string;
    try {
      stored = (await readFile(this.path, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const parsed = JSON.parse(cipher.decrypt(stored)) as unknown;
    if (!isClaudeSpillPayload(parsed)) throw new Error('Agent gateway spill payload is invalid');
    validateAccessToken(parsed.accessToken);
    return parsed.accessToken;
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async writeAtomically(contents: string): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}

function isClaudeSpillPayload(value: unknown): value is ClaudeSpillPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).version === 1 &&
    typeof (value as Record<string, unknown>).accessToken === 'string'
  );
}

function validateAccessToken(token: string): void {
  if (token.length === 0 || /[\r\n]/u.test(token)) {
    throw new Error('Agent gateway Claude access token is invalid');
  }
}
