import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The adapter's published `claude-agent-acp` executable. Resolved through the
 * manifest's `bin`, which is public, rather than a `dist/` path: 0.104 narrowed
 * `exports` to the entry point and `package.json`, so deep imports now fail. */
export function claudeAgentAcpBin(): string {
  const manifest = fileURLToPath(
    import.meta.resolve('@agentclientprotocol/claude-agent-acp/package.json'),
  );
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const entry = typeof bin === 'string' ? bin : bin?.['claude-agent-acp'];
  if (!entry) throw new Error('claude-agent-acp publishes no claude-agent-acp executable');
  return resolve(dirname(manifest), entry);
}
