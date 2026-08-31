import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('sandbox toolkit hardening', () => {
  it('authenticates every verity-tasks request from a private token source', async () => {
    const source = await readFile(
      'features/verity-sandbox-toolkit/agent-seed/bin/verity-tasks',
      'utf8',
    );
    expect(source).toContain("VERITY_API_TOKEN_FILE || '/run/verity/api-token'");
    expect(source).toContain('authorization: `Bearer ${token}`');
    expect(source).toContain('if (!token) throw new Error');
  });

  it('rejects an existing runner account with the wrong primary runtime group', async () => {
    const source = await readFile('features/verity-sandbox-toolkit/install.sh', 'utf8');
    expect(source).toContain('cut -d: -f4)" = "$RUNTIME_GID');
    expect(source).toContain('existing verity-runner does not use runtime GID');
  });
});
