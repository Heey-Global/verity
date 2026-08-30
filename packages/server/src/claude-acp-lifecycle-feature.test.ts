import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(
  new URL(
    '../../../features/verity-sandbox-toolkit/bin/verity-claude-acp-lifecycle.mjs',
    import.meta.url,
  ),
);

/** Exact 0.66.0 seams, reduced to the statements the build-time patch owns. */
const PINNED_ADAPTER = `sessionUpdate: "usage_update",
                                        used: lastAssistantTotalUsage,
                                        size: session.contextWindowSize,
                                    },
                                });
                                break;
                            }
                            case "local_command_output":
                            case "hook_response":
                            case "files_persisted":
                            case "task_progress":
                                break;
                            case "task_started":
                                // For subagent tasks
                                doStarted();
                                break;
                            case "task_notification":
                                // The task settled
                                doNotification();
                                break;
                            case "task_updated":
                                // terminal-status task_updated patch
                                if (message.patch.status === "completed") {
                                    session.liveBackgroundTasks.delete(message.task_id);
                                }
                                break;
                            case "worker_shutting_down":
                        // Skip these user messages for now, since they seem to just be messages we don't want in the feed
                        if (message.type === "user" &&
                            (typeof message.message.content === "string" ||
                                (Array.isArray(message.message.content) &&
                                    message.message.content.length === 1 &&
                                    message.message.content[0].type === "text"))) {
                            break;
                        }
`;

async function fixture(source: string = PINNED_ADAPTER): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'verity-claude-lifecycle-'));
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'dist', 'acp-agent.js'), source);
  await execFileAsync(process.execPath, [SCRIPT, root], {
    env: { ...process.env, VERITY_PATCH_FIXTURE: '1' },
  });
  return await readFile(path.join(root, 'dist', 'acp-agent.js'), 'utf8');
}

describe('Claude ACP structured lifecycle feature patch', () => {
  it('carries compaction, task phases and synthetic skills through ACP metadata', async () => {
    const patched = await fixture();
    expect(patched).toContain('verity:structured-lifecycle');
    expect(patched).toContain('lifecycle: { type: "compaction" }');
    expect(patched).toContain('type: "task", id: message.task_id, phase: "started"');
    expect(patched).toContain('phase: terminal ? "ended" : "progress"');
    expect(patched).toContain('status === "timed_out"');
    expect(patched).toContain('lifecycle: { type: "skill", text }');
    expect(patched).toContain('^Base directory for this skill:');
    expect(patched).toContain('trimmed.slice(newline + 1)');
  });

  it('fails closed when a pinned adapter seam moves', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'verity-claude-lifecycle-drift-'));
    await mkdir(path.join(root, 'dist'));
    await writeFile(
      path.join(root, 'dist', 'acp-agent.js'),
      PINNED_ADAPTER.replace('case "task_started":', 'case "task_began":'),
    );
    await expect(
      execFileAsync(process.execPath, [SCRIPT, root], {
        env: { ...process.env, VERITY_PATCH_FIXTURE: '1' },
      }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('refuses to patch through a symlinked adapter file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'verity-claude-lifecycle-link-'));
    const outside = path.join(root, 'outside.js');
    await mkdir(path.join(root, 'dist'));
    await writeFile(outside, PINNED_ADAPTER);
    await symlink(outside, path.join(root, 'dist', 'acp-agent.js'));
    await expect(
      execFileAsync(process.execPath, [SCRIPT, root], {
        env: { ...process.env, VERITY_PATCH_FIXTURE: '1' },
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect(await readFile(outside, 'utf8')).toBe(PINNED_ADAPTER);
  });
});
