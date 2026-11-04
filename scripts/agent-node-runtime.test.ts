import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { agentLaunchSpec } from '../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

for (const command of ['codex-acp', 'claude-agent-acp', 'opencode-acp'] as const) {
  it.skipIf(!existsSync('/etc/ssl/openssl.cnf')).each(['normal', 'planning', 'knowledge'])(
    `admits Node's system OpenSSL file for ${command} in %s mode without its private directory`,
    (mode) => {
      const spec = agentLaunchSpec(
        {
          command,
          args: [],
          cwd: '/work',
          ...(mode === 'normal'
            ? { managedHome: '/home/probe' }
            : {
                knowledgeHome: '/home/probe',
                planning: mode === 'planning',
                knowledgeIsolation: mode === 'knowledge',
              }),
        },
        { agentUid: 1000, agentGid: 1000, env: {} },
      );
      const index = spec.args.indexOf('/etc/ssl/openssl.cnf');
      expect(index).toBeGreaterThan(0);
      expect(spec.args[index - 1]).toBe('--secret');
      expect(spec.args).not.toContain('/etc/ssl');
      expect(spec.args).not.toContain('/etc/ssl/private');
    },
  );
}
