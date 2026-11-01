import type { ToolCall } from '../happy/message.js';
const labels = {
  proposed: 'Proposed',
  queued: 'Queued',
  running: 'Working',
  waiting: 'Needs your answer',
  verifying: 'Checking result',
  completed: 'Completed',
  blocked: 'Blocked',
  stopping: 'Stopping',
  stopped: 'Stopped',
};
function unwrap(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 4 || !value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (v.isError === true) return undefined;
  if (v.structuredContent) return unwrap(v.structuredContent, depth + 1);
  if (Array.isArray(v.content))
    for (const item of v.content as unknown[]) {
      if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
        try {
          return unwrap(JSON.parse(item.text), depth + 1);
        } catch {
          /* Not a JSON result. */
        }
      }
    }
  return v;
}
/** Only confirmed tool results, never generated prose, supply assignment state. */
export function qaAssignmentView(tool: ToolCall) {
  if (tool.state !== 'completed' || !/(?:^|__)verity_qa_analysis$/.test(tool.name))
    return undefined;
  const v = unwrap(tool.result);
  if (
    !v ||
    typeof v.assignmentId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.assignmentId) ||
    typeof v.title !== 'string' ||
    typeof v.status !== 'string' ||
    !Object.hasOwn(labels, v.status) ||
    typeof v.projectId !== 'string' ||
    !Number.isInteger(v.version)
  )
    return undefined;
  const status = v.status as keyof typeof labels;
  return {
    id: v.assignmentId,
    title: v.title,
    status,
    label: labels[status],
    sessionId: typeof v.sessionId === 'string' ? v.sessionId : undefined,
    reason: typeof v.reason === 'string' ? v.reason : undefined,
  };
}
