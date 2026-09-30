import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('sandbox toolkit hardening', () => {
  it('rejects an existing runner account with the wrong primary runtime group', async () => {
    const source = await readFile('features/verity-sandbox-toolkit/install.sh', 'utf8');
    expect(source).toContain('cut -d: -f4)" = "$RUNTIME_GID');
    expect(source).toContain('existing verity-runner does not use runtime GID');
  });
});
