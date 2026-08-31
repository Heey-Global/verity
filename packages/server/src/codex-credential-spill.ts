import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createSecretCipher } from '@verity/store';

export interface CodexSpillPayload {
  version: 2;
  sourceRevision: string;
  authJson: string;
}

/** Encrypted write-ahead storage for the gateway-owned rotating Codex login. */
export class CodexCredentialSpill {
  constructor(private readonly path: string) {}

  async read(keyMaterial: string): Promise<CodexSpillPayload | undefined> {
    let stored: string;
    try {
      stored = (await readFile(this.path, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const cipher = createSecretCipher(keyMaterial);
    const value = JSON.parse(cipher.decrypt(stored)) as unknown;
    if (!isPayload(value)) throw new Error('Codex gateway spill payload is invalid');
    return value;
  }

  async write(keyMaterial: string, sourceRevision: string, authJson: string): Promise<void> {
    if (authJson.trim().length === 0) throw new Error('Codex gateway auth JSON is empty');
    if (!/^[a-f0-9]{64}$/u.test(sourceRevision))
      throw new Error('Codex gateway source revision is invalid');
    const cipher = createSecretCipher(keyMaterial);
    const payload: CodexSpillPayload = { version: 2, sourceRevision, authJson };
    await this.writeAtomically(`${cipher.encrypt(JSON.stringify(payload))}\n`);
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

function isPayload(value: unknown): value is CodexSpillPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).version === 2 &&
    typeof (value as Record<string, unknown>).sourceRevision === 'string' &&
    /^[a-f0-9]{64}$/u.test((value as Record<string, unknown>).sourceRevision as string) &&
    typeof (value as Record<string, unknown>).authJson === 'string' &&
    ((value as Record<string, unknown>).authJson as string).trim().length > 0
  );
}
