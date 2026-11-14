import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(
  new URL(
    '../../../features/verity-sandbox-toolkit/bin/verity-claude-acp-lifecycle.mjs',
    import.meta.url,
  ),
);

/** Exact 0.81.2 seams, reduced to the statements the build-time patch owns. */
const PINNED_ADAPTER = `const AUTONOMOUS_CYCLE = "autonomous-cycle";
export class ClaudeAcpAgent {
        this.client = new ChangedMetaClient(client, () => false);
update: attachUsageModel({
                                        sessionUpdate: "usage_update",
                                        used: lastAssistantTotalUsage,
                                        size: session.contextWindowSize,
                                    }),
                                });
                                break;
                            }
                            case "local_command_output": {
                            case "task_progress":
                                await asyncTasks.taskProgress({
                                    task_id: message.task_id,
                                });
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
                                await asyncTasks.taskUpdated(message.task_id, message.patch);
                                // terminal-status task_updated patch and a (deduplicated)
                                if (message.patch.status === "completed") {
                                    session.liveBackgroundTasks.delete(message.task_id);
                                }
                                break;
                            case "worker_shutting_down":
                                break;
                            case "background_tasks_changed": {
                                await asyncTasks.backgroundTasksChanged(message.tasks);
                                break;
                            }
                        // Skip these user messages for now, since they seem to just be messages we don't want in the feed
                        if (message.type === "user" &&
                            (typeof message.message.content === "string" ||
                                (Array.isArray(message.message.content) &&
                                    message.message.content.length === 1 &&
                                    message.message.content[0].type === "text"))) {
                            break;
                        }
    startForeground(sessionId, owner) {
        this.foregroundWork.set(sessionId, owner);
    }
    endForeground(sessionId, owner) {
        if (this.foregroundWork.get(sessionId) === owner)
            this.foregroundWork.delete(sessionId);
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

  // Verity holds a turn open while the agent still works in the background
  // (background-work.ts). Without these two signals the hold never engages and
  // the agent process — with every background shell and monitor — dies at the
  // first prompt response, while the agent has told the operator it is waiting.
  it('reports self-started cycles and the live background-task level', async () => {
    const patched = await fixture();
    const start = patched.slice(patched.indexOf('startForeground(sessionId, owner) {'));
    expect(start.slice(0, start.indexOf('\n    }'))).toMatch(
      /owner === AUTONOMOUS_CYCLE && previous !== AUTONOMOUS_CYCLE\)\s+void this\.client\.sessionUpdate\(\{[\s\S]*type: "cycle", phase: "started"/,
    );
    const end = patched.slice(patched.indexOf('endForeground(sessionId, owner) {'));
    expect(end.slice(0, end.indexOf('\n    }'))).toMatch(
      /this\.foregroundWork\.delete\(sessionId\);\s+if \(owner === AUTONOMOUS_CYCLE\)\s+void this\.client\.sessionUpdate\(\{[\s\S]*type: "cycle", phase: "ended"/,
    );
    // The level is executed, not matched: run the patched case against recorded
    // collaborators with the task shape the SDK sends.
    const caseStart = patched.indexOf('case "background_tasks_changed": {');
    const caseEnd = patched.indexOf('break;', caseStart);
    const levelDir = await mkdtemp(path.join(tmpdir(), 'verity-claude-lifecycle-level-'));
    const levelPath = path.join(levelDir, 'level.mjs');
    await writeFile(
      levelPath,
      `export default async (asyncTasks, sendUpdate, message) => {\nswitch (message.type) {\n${patched.slice(caseStart, caseEnd)}break;\n}\n}\n}\n`,
    );
    const { default: runLevel } = (await import(pathToFileURL(levelPath).href)) as {
      default: (
        asyncTasks: { backgroundTasksChanged(tasks: unknown): Promise<void> },
        sendUpdate: (notification: unknown) => Promise<void>,
        message: { type: string; session_id: string; tasks: unknown },
      ) => Promise<void>;
    };
    const levels: unknown[] = [];
    const level = async (tasks: unknown): Promise<void> => {
      await runLevel(
        { backgroundTasksChanged: async () => undefined },
        async (notification) => {
          levels.push(notification);
        },
        { type: 'background_tasks_changed', session_id: 'sdk-session', tasks },
      );
    };
    await level([{ task_id: 'bash-1', task_type: 'local_bash' }, { task_id: 'agent-2' }]);
    await level([]);
    // Unreadable entries withhold the level whole: a shortened list would read
    // as "that work ended" and release a held turn under running work.
    await level([{ task_id: 'bash-1' }, { id: 'renamed-field' }]);
    await level(undefined);
    expect(levels).toEqual([
      {
        sessionId: 'sdk-session',
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { verity: { lifecycle: { type: 'background', live: ['bash-1', 'agent-2'] } } },
        },
      },
      {
        sessionId: 'sdk-session',
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { verity: { lifecycle: { type: 'background', live: [] } } },
        },
      },
    ]);
    // The emitted code has to run, not just match: evaluate the patched methods
    // against a recording client and check the signals they send.
    const sent: unknown[] = [];
    // The fixture ends with these two methods, so the tail is a class body.
    const body = patched.slice(patched.indexOf('    startForeground(sessionId, owner) {'));
    const moduleDir = await mkdtemp(path.join(tmpdir(), 'verity-claude-lifecycle-run-'));
    const modulePath = path.join(moduleDir, 'methods.mjs');
    await writeFile(
      modulePath,
      `const AUTONOMOUS_CYCLE = 'autonomous-cycle';\nexport default class {\nconstructor(client) { this.client = client; this.foregroundWork = new Map(); }\n${body}\n}\n`,
    );
    const { default: klass } = (await import(pathToFileURL(modulePath).href)) as {
      default: new (client: { sessionUpdate(p: unknown): Promise<void> }) => {
        startForeground(id: string, owner: unknown): void;
        endForeground(id: string, owner: unknown): void;
      };
    };
    const agent = new klass({
      sessionUpdate: (params) => {
        sent.push((params as { update: { _meta: unknown } }).update._meta);
        return Promise.resolve();
      },
    });
    agent.startForeground('s', 'autonomous-cycle');
    agent.startForeground('s', 'autonomous-cycle');
    agent.endForeground('s', 'autonomous-cycle');
    agent.startForeground('s', 'autonomous-cycle');
    agent.startForeground('s', { turn: 1 }); // a prompt takes the cycle over
    agent.endForeground('s', { turn: 1 });
    expect(sent).toEqual([
      { verity: { lifecycle: { type: 'cycle', phase: 'started' } } },
      { verity: { lifecycle: { type: 'cycle', phase: 'ended' } } },
      { verity: { lifecycle: { type: 'cycle', phase: 'started' } } },
      { verity: { lifecycle: { type: 'cycle', phase: 'ended' } } },
    ]);
  });

  it('keeps stale-run guards before lifecycle updates in newer adapters', async () => {
    const guarded = PINNED_ADAPTER.replace(
      /^( {28}case "(task_[a-z]+)":\n)/gm,
      (header, _match, name) =>
        header +
        `                                if (isLateTaskRun(session, message.task_id, message.run_id)) {
                                    this.logger.log(\`Ignoring ${name} for task \${message.task_id} from earlier run \${message.run_id}\`);
                                    break;
                                }
`,
    );
    const patched = await fixture(guarded);
    for (const name of ['task_progress', 'task_started', 'task_notification', 'task_updated']) {
      const branch = patched.slice(patched.indexOf(`case "${name}":`));
      expect(branch.indexOf('if (isLateTaskRun(')).toBeLessThan(
        branch.indexOf('await sendUpdate('),
      );
      expect(branch.indexOf('break;')).toBeLessThan(branch.indexOf('await sendUpdate('));
    }
  });

  it('keeps resumed delegation end guards before ending lifecycle metadata', async () => {
    const boundary = `                                // In the RFD form, a resumed child runs under the call that
                                // resumed it, and the end of an earlier delegation ends
                                // nothing: the child and its live task belong to the new run.
                                if (subagents.isStaleEnd(message.task_id, message.tool_use_id))
                                    break;
`;
    const guarded = PINNED_ADAPTER.replace(
      'case "task_notification":\n',
      `case "task_notification":
                                if (isLateTaskRun(session, message.task_id, message.run_id)) {
                                    this.logger.log(\`Ignoring task_notification for task \${message.task_id} from earlier run \${message.run_id}\`);
                                    break;
                                }
` + boundary,
    );
    const patched = await fixture(guarded);
    const branch = patched.slice(patched.indexOf('case "task_notification":'));
    expect(branch).toContain(boundary);
    expect(branch.indexOf(boundary)).toBeLessThan(branch.indexOf('await sendUpdate('));
  });

  // 0.104 moved the v1 agent to dist/v1/ beside a draft-v2 core. Looking only
  // at dist/acp-agent.js failed the image build; looking in both, and picking
  // one when both exist, could patch an agent that does not serve the session.
  it('patches the v1 agent where 0.104 moved it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'verity-claude-lifecycle-v1-'));
    await mkdir(path.join(root, 'dist', 'v1'), { recursive: true });
    await writeFile(path.join(root, 'dist', 'v1', 'acp-agent.js'), PINNED_ADAPTER);
    await execFileAsync(process.execPath, [SCRIPT, root], {
      env: { ...process.env, VERITY_PATCH_FIXTURE: '1' },
    });
    expect(await readFile(path.join(root, 'dist', 'v1', 'acp-agent.js'), 'utf8')).toContain(
      'verity:structured-lifecycle',
    );
  });

  it('refuses an adapter that ships both agent layouts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'verity-claude-lifecycle-both-'));
    await mkdir(path.join(root, 'dist', 'v1'), { recursive: true });
    await writeFile(path.join(root, 'dist', 'acp-agent.js'), PINNED_ADAPTER);
    await writeFile(path.join(root, 'dist', 'v1', 'acp-agent.js'), PINNED_ADAPTER);
    await expect(
      execFileAsync(process.execPath, [SCRIPT, root], {
        env: { ...process.env, VERITY_PATCH_FIXTURE: '1' },
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect(await readFile(path.join(root, 'dist', 'acp-agent.js'), 'utf8')).toBe(PINNED_ADAPTER);
  });

  it('fails closed when the self-started cycle constant is renamed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'verity-claude-lifecycle-cycle-'));
    await mkdir(path.join(root, 'dist'));
    await writeFile(
      path.join(root, 'dist', 'acp-agent.js'),
      PINNED_ADAPTER.replace('const AUTONOMOUS_CYCLE =', 'const SELF_STARTED_CYCLE ='),
    );
    await expect(
      execFileAsync(process.execPath, [SCRIPT, root], {
        env: { ...process.env, VERITY_PATCH_FIXTURE: '1' },
      }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it.each([
    [
      'the foreground methods leave the agent class',
      '    startForeground(',
      'class Helper {\n    startForeground(',
    ],
    [
      'the level leaves the message switch',
      // The case keeps its indentation, so only the scope check can refuse it.
      '                            case "background_tasks_changed": {',
      '    handleLevel(message) {\n                            case "background_tasks_changed": {',
    ],
  ])('fails closed when %s', async (_name, from, to) => {
    const root = await mkdtemp(path.join(tmpdir(), 'verity-claude-lifecycle-scope-'));
    await mkdir(path.join(root, 'dist'));
    await writeFile(path.join(root, 'dist', 'acp-agent.js'), PINNED_ADAPTER.replace(from, to));
    await expect(
      execFileAsync(process.execPath, [SCRIPT, root], {
        env: { ...process.env, VERITY_PATCH_FIXTURE: '1' },
      }),
    ).rejects.toMatchObject({ code: 1 });
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
