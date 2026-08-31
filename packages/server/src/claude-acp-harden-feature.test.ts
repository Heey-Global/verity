/**
 * `features/verity-sandbox-toolkit/bin/verity-claude-acp-harden.mjs` runs at
 * image build time — in the server Dockerfile and in the sandbox toolkit's
 * install.sh — against the globally installed `@agentclientprotocol/claude-agent-acp`.
 *
 * What it defends: the adapter renders a tool call's display title straight out
 * of model-authored tool input. Model output is untrusted JSON — the tool schema
 * is a request, not a guarantee — so a wrong-typed field makes the title builder
 * throw. That throw escapes the SDK query stream, exits the adapter without a
 * terminal event, and (because `session/load` replays history through the same
 * builder) re-throws on every resume, so the session never recovers.
 *
 * The fixture reproduces the upstream shape rather than the upstream package:
 * the build step verifies the real install by probing it, while these cases pin
 * the decision the script makes — above all that it FAILS rather than silently
 * shipping an unhardened adapter.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const HARDEN_SCRIPT = fileURLToPath(
  new URL(
    '../../../features/verity-sandbox-toolkit/bin/verity-claude-acp-harden.mjs',
    import.meta.url,
  ),
);

/** The upstream branches that read a field's shape on faith, reproduced from
 *  `claude-agent-acp@0.65.0` dist/tools.js — including the `export function`
 *  line the script uses as its wrapper seam.
 *
 *  Two shapes of the same defect, and the fixture carries both: `WebSearch` and
 *  `ReportFindings` THROW on a wrong-typed field, while `Task` and `Write` hand
 *  the raw field back as a `title`/location `path`. The second kind never
 *  reaches this function's caller as an exception — it fails a schema check a
 *  layer later — so a wrapper that only catches would miss it. */
const VULNERABLE_TOOLS_JS = `export function toolInfoFromToolUse(toolUse, supportsTerminalOutput = false, cwd) {
    const name = toolUse.name;
    switch (name) {
        case "Task": {
            const input = toolUse.input;
            return { title: input?.description ? input.description : "Task", kind: "think", content: [] };
        }
        case "Write": {
            const input = toolUse.input;
            return {
                title: input?.file_path ? \`Write \${input.file_path}\` : "Write",
                kind: "edit",
                content: [],
                locations: input?.file_path ? [{ path: input.file_path }] : [],
            };
        }
        case "WebSearch": {
            const input = toolUse.input;
            let label = input?.query ? \`"\${input.query}"\` : "Web search";
            if (input?.allowed_domains && input.allowed_domains.length > 0) {
                label += \` (allowed: \${input.allowed_domains.join(", ")})\`;
            }
            if (input?.blocked_domains && input.blocked_domains.length > 0) {
                label += \` (blocked: \${input.blocked_domains.join(", ")})\`;
            }
            return { title: label, kind: "fetch", content: [] };
        }
        case "ReportFindings": {
            const input = toolUse.input;
            const findings = input?.findings ?? [];
            return {
                title: \`\${findings.length} findings\`,
                kind: "think",
                content: findings.map((finding) => ({ type: "text", text: finding.summary })),
            };
        }
        default:
            return { title: name, kind: "other", content: [] };
    }
}
`;

const RESTRUCTURED_SIGNATURE =
  'export const toolInfoFromToolUse = (toolUse, supportsTerminalOutput = false, cwd) => {';

/** An upstream that reshaped the seam but still crashes: the one case that must
 *  never be waved through. */
const RESTRUCTURED_BUT_BROKEN = VULNERABLE_TOOLS_JS.replace(
  'export function toolInfoFromToolUse(toolUse, supportsTerminalOutput = false, cwd) {',
  RESTRUCTURED_SIGNATURE,
);

/** An upstream that fixed EVERY field this script knows about. All of them must
 *  be guarded here — a fixture that claims "safe" while one field still fails
 *  would make the already-safe case pass for the wrong reason. */
const ALREADY_SAFE = VULNERABLE_TOOLS_JS.replace(
  'if (input?.allowed_domains && input.allowed_domains.length > 0) {',
  'if (Array.isArray(input?.allowed_domains) && input.allowed_domains.length > 0) {',
)
  .replace(
    'if (input?.blocked_domains && input.blocked_domains.length > 0) {',
    'if (Array.isArray(input?.blocked_domains) && input.blocked_domains.length > 0) {',
  )
  .replace(
    'const findings = input?.findings ?? [];',
    'const findings = Array.isArray(input?.findings) ? input.findings : [];',
  )
  .replace(
    'title: input?.description ? input.description : "Task"',
    'title: typeof input?.description === "string" ? input.description : "Task"',
  )
  .replace(
    'locations: input?.file_path ? [{ path: input.file_path }] : [],',
    'locations: typeof input?.file_path === "string" ? [{ path: input.file_path }] : [],',
  );

/** The same upstream, reshaped past the seam. Nothing known is broken — and the
 *  backstop still cannot be installed, which is exactly why this must fail
 *  rather than pass quietly on the strength of yesterday's probe list. */
const RESTRUCTURED_AND_SAFE = ALREADY_SAFE.replace(
  'export function toolInfoFromToolUse(toolUse, supportsTerminalOutput = false, cwd) {',
  RESTRUCTURED_SIGNATURE,
);

/** An upstream that fixed only *some* of it. The dangerous shape: it looks
 *  repaired from the two loudest fields, so a probe set that stops at those
 *  waves it through and ships an adapter that still loses sessions. */
const PARTIALLY_FIXED = ALREADY_SAFE.replace(
  'if (Array.isArray(input?.blocked_domains) && input.blocked_domains.length > 0) {',
  'if (input?.blocked_domains && input.blocked_domains.length > 0) {',
);

const created: string[] = [];

async function packageDir(toolsJs: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'verity-acp-harden-'));
  created.push(root);
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"name":"acp-fixture","type":"module"}');
  await writeFile(path.join(root, 'dist', 'tools.js'), toolsJs);
  return root;
}

function toolsFile(dir: string): string {
  return path.join(dir, 'dist', 'tools.js');
}

async function run(args: string[], script?: string): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      script ? ['--input-type=module', '-e', script] : args,
    );
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, out: (failure.stdout ?? '') + (failure.stderr ?? '') };
  }
}

async function harden(dir: string): Promise<{ code: number; out: string }> {
  return run([HARDEN_SCRIPT, dir]);
}

/**
 * Render a title the way the adapter does. In a child process, because that is
 * both a fresh module instance per call and the only honest way to observe
 * "this throw would have taken the process down".
 */
type ToolInfo = { title: unknown; locations?: unknown };

async function renderInfo(
  dir: string,
  toolUse: unknown,
): Promise<{ ok: true; info: ToolInfo } | { ok: false; error: string }> {
  const source = `const { toolInfoFromToolUse } = await import(${JSON.stringify(
    pathToFileURL(toolsFile(dir)).href,
  )});
process.stdout.write(JSON.stringify(toolInfoFromToolUse(${JSON.stringify(toolUse)})));`;
  const result = await run([], source);
  if (result.code !== 0) return { ok: false, error: result.out };
  return { ok: true, info: JSON.parse(result.out) as ToolInfo };
}

async function renderTitle(
  dir: string,
  toolUse: unknown,
): Promise<{ ok: true; title: unknown } | { ok: false; error: string }> {
  const result = await renderInfo(dir, toolUse);
  return result.ok ? { ok: true, title: result.info.title } : result;
}

const WRONG_TYPED_SEARCH = {
  name: 'WebSearch',
  id: 'x',
  input: { query: 'link a github repo', allowed_domains: 'github.com' },
};
const WRONG_TYPED_FINDINGS = { name: 'ReportFindings', id: 'y', input: { findings: 'oops' } };
const WRONG_TYPED_BLOCKED = {
  name: 'WebSearch',
  id: 'w',
  input: { query: 'link a github repo', blocked_domains: 'evil.example' },
};
const WELL_FORMED_SEARCH = {
  name: 'WebSearch',
  id: 'z',
  input: { query: 'q', allowed_domains: ['a.com', 'b.com'] },
};
/** Wrong-typed but silent: upstream returns these fields verbatim, so the title
 *  is an object and the location path is an object. Nothing throws. */
const WRONG_TYPED_TASK = { name: 'Task', id: 't', input: { description: { not: 'a string' } } };
const WRONG_TYPED_WRITE = { name: 'Write', id: 'v', input: { file_path: { not: 'a string' } } };
const WELL_FORMED_WRITE = { name: 'Write', id: 'u', input: { file_path: '/work/a.ts' } };

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Claude ACP tool-title hardening', () => {
  it('turns a session-killing throw into a degraded title', async () => {
    const dir = await packageDir(VULNERABLE_TOOLS_JS);

    expect(await renderTitle(dir, WRONG_TYPED_SEARCH)).toMatchObject({
      ok: false,
      error: expect.stringContaining('input.allowed_domains.join is not a function') as string,
    });
    expect(await renderTitle(dir, WRONG_TYPED_FINDINGS)).toMatchObject({
      ok: false,
      error: expect.stringContaining('findings.map is not a function') as string,
    });

    expect((await harden(dir)).code).toBe(0);

    // The guarded field keeps a useful title; the unguarded one falls back to
    // the tool name. Neither ends the turn, which is the whole point.
    expect(await renderTitle(dir, WRONG_TYPED_SEARCH)).toEqual({
      ok: true,
      title: '"link a github repo"',
    });
    expect(await renderTitle(dir, WRONG_TYPED_FINDINGS)).toEqual({
      ok: true,
      title: 'ReportFindings',
    });
  });

  it('leaves well-formed tool input rendering exactly as before', async () => {
    const dir = await packageDir(VULNERABLE_TOOLS_JS);
    const before = await renderTitle(dir, WELL_FORMED_SEARCH);

    expect((await harden(dir)).code).toBe(0);

    expect(before).toEqual({ ok: true, title: '"q" (allowed: a.com, b.com)' });
    expect(await renderTitle(dir, WELL_FORMED_SEARCH)).toEqual(before);
  });

  it('is idempotent, so a rebuild does not stack wrappers', async () => {
    const dir = await packageDir(VULNERABLE_TOOLS_JS);
    expect((await harden(dir)).code).toBe(0);
    const once = await readFile(toolsFile(dir), 'utf8');

    const again = await harden(dir);

    expect(again.code).toBe(0);
    expect(again.out).toContain('nothing to do');
    expect(await readFile(toolsFile(dir), 'utf8')).toBe(once);
  });

  it('keeps a non-string title from reaching the protocol', async () => {
    const dir = await packageDir(VULNERABLE_TOOLS_JS);

    // Upstream hands the raw field back. Nothing throws, so a catch-only
    // wrapper would pass this straight to a schema that requires a string.
    expect(await renderTitle(dir, WRONG_TYPED_TASK)).toEqual({
      ok: true,
      title: { not: 'a string' },
    });

    expect((await harden(dir)).code).toBe(0);

    expect(await renderTitle(dir, WRONG_TYPED_TASK)).toEqual({ ok: true, title: 'Task' });
    expect(await renderInfo(dir, WRONG_TYPED_WRITE)).toMatchObject({
      ok: true,
      info: { title: expect.any(String) as string, locations: [] },
    });
    // Well-formed locations are untouched — the point is a narrower title, not
    // a poorer one.
    expect(await renderInfo(dir, WELL_FORMED_WRITE)).toMatchObject({
      ok: true,
      info: { title: 'Write /work/a.ts', locations: [{ path: '/work/a.ts' }] },
    });
  });

  it('still installs the backstop when upstream fixed every field it knows', async () => {
    const dir = await packageDir(ALREADY_SAFE);

    const result = await harden(dir);

    // The probe list only knows the fields that broke yesterday, so "all probes
    // pass" is not a reason to ship without the catch-all — a fourth field can
    // appear in any release.
    expect(result.code).toBe(0);
    expect(result.out).toContain('installing the backstop anyway');
    expect(await readFile(toolsFile(dir), 'utf8')).toContain('verity:tool-title-hardening');
    expect(await renderTitle(dir, WELL_FORMED_SEARCH)).toEqual({
      ok: true,
      title: '"q" (allowed: a.com, b.com)',
    });
  });

  it('fails the build when the seam is gone even though nothing known crashes', async () => {
    const dir = await packageDir(RESTRUCTURED_AND_SAFE);

    const result = await harden(dir);

    expect(result.code).toBe(1);
    expect(result.out).toContain('the toolInfoFromToolUse seam is gone');
    expect(await readFile(toolsFile(dir), 'utf8')).toBe(RESTRUCTURED_AND_SAFE);
  });

  it('still hardens an upstream that guarded only some of the fields', async () => {
    const dir = await packageDir(PARTIALLY_FIXED);

    // Pre-state: the two loud fields are repaired, `blocked_domains` is not —
    // so a probe set that stopped at the loud ones would call this safe.
    expect(await renderTitle(dir, WRONG_TYPED_SEARCH)).toMatchObject({ ok: true });
    expect(await renderTitle(dir, WRONG_TYPED_BLOCKED)).toMatchObject({
      ok: false,
      error: expect.stringContaining('input.blocked_domains.join is not a function') as string,
    });

    const result = await harden(dir);

    expect(result.code).toBe(0);
    expect(result.out).not.toContain('nothing to do');
    expect(await renderTitle(dir, WRONG_TYPED_BLOCKED)).toEqual({
      ok: true,
      title: '"link a github repo"',
    });
    expect(await renderTitle(dir, WELL_FORMED_SEARCH)).toEqual({
      ok: true,
      title: '"q" (allowed: a.com, b.com)',
    });
  });

  it('fails the build when upstream still crashes but the seam is gone', async () => {
    const dir = await packageDir(RESTRUCTURED_BUT_BROKEN);

    const result = await harden(dir);

    // Loud, not silent: an unhardened adapter looks identical to a hardened one
    // right up until a session is lost.
    expect(result.code).toBe(1);
    expect(result.out).toContain('Re-derive the hardening');
    expect(await readFile(toolsFile(dir), 'utf8')).toBe(RESTRUCTURED_BUT_BROKEN);
  });

  it('fails the build when the adapter is not where it is expected', async () => {
    const result = await harden(path.join(tmpdir(), 'verity-acp-absent'));

    expect(result.code).toBe(1);
    expect(result.out).toContain('cannot read');
  });
});
