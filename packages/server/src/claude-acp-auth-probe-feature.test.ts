/**
 * `verity-claude-acp-auth-probe.mjs` makes the adapter's `claude auth status`
 * probe pass root options before the subcommand. 0.104 moved that probe from
 * dist/acp-agent.js to dist/auth-status-reporter.js, which failed the image
 * build. The step must follow the code, and still fail when the seam is gone
 * or ambiguous rather than ship an adapter it never checked.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(
  new URL(
    '../../../features/verity-sandbox-toolkit/bin/verity-claude-acp-auth-probe.mjs',
    import.meta.url,
  ),
);
const UNORDERED = 'args.push("--settings", JSON.stringify(context.override));';
const ORDERED = 'args.unshift("--settings", JSON.stringify(context.override));';
const module = (line: string) => `export function probe(args, context) {\n    ${line}\n}\n`;
const created: string[] = [];

async function adapter(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'verity-claude-auth-probe-'));
  created.push(root);
  for (const [file, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, 'dist', file)), { recursive: true });
    await writeFile(path.join(root, 'dist', file), source);
  }
  return root;
}

async function run(root: string): Promise<number> {
  try {
    await execFileAsync(process.execPath, [SCRIPT, root]);
    return 0;
  } catch (error) {
    return (error as { code?: number }).code ?? 1;
  }
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Claude ACP auth probe option ordering', () => {
  it.each(['acp-agent.js', 'auth-status-reporter.js'])('reorders the probe in %s', async (file) => {
    const root = await adapter({ [file]: module(UNORDERED) });
    expect(await run(root)).toBe(0);
    expect(await readFile(path.join(root, 'dist', file), 'utf8')).toContain(ORDERED);
  });

  it('accepts an adapter whose probe already orders the options', async () => {
    const root = await adapter({
      'v1/acp-agent.js': 'export {};\n',
      'auth-status-reporter.js': module(ORDERED),
    });
    expect(await run(root)).toBe(0);
  });

  it('fails when the seam is missing', async () => {
    expect(await run(await adapter({ 'v1/acp-agent.js': 'export {};\n' }))).not.toBe(0);
  });

  it('fails when the seam appears in more than one file', async () => {
    const root = await adapter({
      'acp-agent.js': module(UNORDERED),
      'auth-status-reporter.js': module(UNORDERED),
    });
    expect(await run(root)).not.toBe(0);
    expect(await readFile(path.join(root, 'dist', 'acp-agent.js'), 'utf8')).toContain(UNORDERED);
  });
});
