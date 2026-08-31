#!/usr/bin/env node
/**
 * Preserve structured Claude lifecycle messages across claude-agent-acp 0.66.0.
 *
 * The upstream adapter receives compact_boundary, task_* and synthetic skill
 * messages from the Claude Agent SDK, but either turns them into prose or drops
 * them before ACP. Verity patches the pinned adapter to carry those facts in
 * ACP's reserved `_meta` extension point. The Session package maps the same
 * vendor-neutral shape for every ACP backend.
 */
import { execFileSync } from 'node:child_process';
import { lstat, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LABEL = 'verity-claude-acp-lifecycle';
const MARKER = 'verity:structured-lifecycle';

function fail(message) {
  process.stderr.write(`!! ${LABEL}: ${message}\n`);
  process.exit(1);
}

function packageDir() {
  if (process.argv[2]) return process.argv[2];
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return path.join(root, '@agentclientprotocol', 'claude-agent-acp');
}

function replaceOnce(source, from, to, label) {
  const first = source.indexOf(from);
  if (first === -1 || source.indexOf(from, first + from.length) !== -1) {
    fail(`${label} seam is missing or ambiguous; re-derive against the pinned adapter`);
  }
  return source.replace(from, to);
}

const resolvedPackageDir = await realpath(packageDir()).catch((error) =>
  fail(`cannot resolve package directory: ${error?.message ?? error}`),
);
const file = path.join(resolvedPackageDir, 'dist', 'acp-agent.js');
let source;
try {
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink()) fail(`${file} is not a regular file`);
  source = await readFile(file, 'utf8');
} catch (error) {
  fail(`cannot read ${file}: ${error?.message ?? error}`);
}

if (source.includes(MARKER)) {
  process.stdout.write(`>> ${LABEL}: already installed\n`);
  process.exit(0);
}

source = replaceOnce(
  source,
  `sessionUpdate: "usage_update",
                                        used: lastAssistantTotalUsage,
                                        size: session.contextWindowSize,
                                    },
                                });
                                break;
                            }
                            case "local_command_output":`,
  `sessionUpdate: "usage_update",
                                        used: lastAssistantTotalUsage,
                                        size: session.contextWindowSize,
                                        _meta: { verity: { lifecycle: { type: "compaction" } } }, // ${MARKER}
                                    },
                                });
                                break;
                            }
                            case "local_command_output":`,
  'compact_boundary',
);

source = replaceOnce(
  source,
  `                            case "hook_response":
                            case "files_persisted":
                            case "task_progress":
                                break;`,
  `                            case "hook_response":
                            case "files_persisted":
                                break;
                            case "task_progress":
                                await sendUpdate({
                                    sessionId: message.session_id,
                                    update: {
                                        sessionUpdate: "session_info_update",
                                        _meta: { verity: { lifecycle: {
                                            type: "task", id: message.task_id, phase: "progress",
                                            description: message.description ?? message.summary,
                                            status: message.status,
                                        } } },
                                    },
                                });
                                break;`,
  'task_progress',
);

source = replaceOnce(
  source,
  `                            case "task_started":
                                // For subagent tasks`,
  `                            case "task_started":
                                await sendUpdate({
                                    sessionId: message.session_id,
                                    update: {
                                        sessionUpdate: "session_info_update",
                                        _meta: { verity: { lifecycle: {
                                            type: "task", id: message.task_id, phase: "started",
                                            toolUseId: message.tool_use_id,
                                            description: message.description ?? message.summary ?? message.subagent_type,
                                            status: message.status,
                                        } } },
                                    },
                                });
                                // For subagent tasks`,
  'task_started',
);

source = replaceOnce(
  source,
  `                            case "task_notification":
                                // The task settled`,
  `                            case "task_notification":
                                await sendUpdate({
                                    sessionId: message.session_id,
                                    update: {
                                        sessionUpdate: "session_info_update",
                                        _meta: { verity: { lifecycle: {
                                            type: "task", id: message.task_id, phase: "ended",
                                            description: message.summary,
                                            status: message.status ?? "completed",
                                        } } },
                                    },
                                });
                                // The task settled`,
  'task_notification',
);

source = replaceOnce(
  source,
  `                            case "task_updated":
                                // terminal-status task_updated patch`,
  `                            case "task_updated": {
                                const status = message.patch.status;
                                const terminal = status === "completed" || status === "failed" ||
                                    status === "error" || status === "cancelled" || status === "canceled" ||
                                    status === "aborted" || status === "timed_out" || status === "killed";
                                await sendUpdate({
                                    sessionId: message.session_id,
                                    update: {
                                        sessionUpdate: "session_info_update",
                                        _meta: { verity: { lifecycle: {
                                            type: "task", id: message.task_id,
                                            phase: terminal ? "ended" : "progress",
                                            description: message.patch.description ?? message.patch.summary,
                                            status,
                                        } } },
                                    },
                                });
                                // terminal-status task_updated patch`,
  'task_updated start',
);
source = replaceOnce(
  source,
  `                                }
                                break;
                            case "worker_shutting_down":`,
  `                                }
                                break;
                            }
                            case "worker_shutting_down":`,
  'task_updated end',
);

source = replaceOnce(
  source,
  `                        // Skip these user messages for now, since they seem to just be messages we don't want in the feed
                        if (message.type === "user" &&
                            (typeof message.message.content === "string" ||
                                (Array.isArray(message.message.content) &&
                                    message.message.content.length === 1 &&
                                    message.message.content[0].type === "text"))) {
                            break;
                        }`,
  `                        // Match the native normalizer: runtime-injected user text
                        // uses the skill carrier. The reducer correlates it with a Skill
                        // tool call and drops unmatched slash/resume/retry injections;
                        // genuine prompt echoes and tool results remain hidden here.
                        if (message.type === "user" &&
                            (typeof message.message.content === "string" ||
                                (Array.isArray(message.message.content) &&
                                    message.message.content.length === 1 &&
                                    message.message.content[0].type === "text"))) {
                            if (message.isSynthetic === true) {
                                const rawText = typeof message.message.content === "string"
                                    ? message.message.content
                                    : message.message.content[0].text;
                                const trimmed = rawText.trimStart();
                                const skillBrief = /^Base directory for this skill:[ \\t]+\\//.test(trimmed);
                                const newline = trimmed.indexOf("\\n");
                                const text = skillBrief
                                    ? (newline === -1 ? "" : trimmed.slice(newline + 1).replace(/^\\n+/, ""))
                                    : rawText;
                                await sendUpdate({
                                    sessionId: message.session_id,
                                    update: {
                                        sessionUpdate: "user_message_chunk",
                                        content: { type: "text", text },
                                        _meta: { verity: { lifecycle: { type: "skill", text } } },
                                    },
                                });
                            }
                            break;
                        }`,
  'synthetic user message',
);

const temporary = `${file}.verity-${String(process.pid)}.tmp`;
try {
  const mode = (await stat(file)).mode;
  await writeFile(temporary, source, { encoding: 'utf8', mode, flag: 'wx' });
  await rename(temporary, file);
} finally {
  await rm(temporary, { force: true });
}
if (process.env['VERITY_PATCH_FIXTURE'] !== '1') {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    fail(`patched adapter failed syntax validation: ${error?.stderr?.toString() ?? error}`);
  }
}
process.stdout.write(`>> ${LABEL}: installed structured lifecycle metadata\n`);
