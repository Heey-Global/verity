import { it, expect } from 'vitest';
import type { ToolCall } from '../happy/message.js';
import { qaAssignmentView } from './qaAssignment.js';
const tool: ToolCall = {
  name: 'mcp__verity__verity_qa_analysis',
  state: 'completed',
  input: {},
  createdAt: 0,
  startedAt: 0,
  completedAt: 1,
  description: null,
  result: {
    assignmentId: 'a'.repeat(64),
    projectId: 'p',
    title: 'Optimize CI',
    status: 'running',
    sessionId: 's',
    version: 2,
  },
};
it('distinguishes completed tool calls from completed assignments', () => {
  expect(qaAssignmentView(tool)).toMatchObject({ label: 'Working', sessionId: 's' });
});
it('unwraps canonical MCP results', () => {
  expect(
    qaAssignmentView({ ...tool, result: { content: [{ text: JSON.stringify(tool.result) }] } }),
  ).toMatchObject({ label: 'Working' });
});
it.each([
  { ...tool, state: 'running' as const },
  { ...tool, name: 'Bash' },
  { ...tool, result: { isError: true, structuredContent: tool.result } },
  { ...tool, result: { ...(tool.result as object), status: 'success' } },
  { ...tool, result: 'completed' },
])('rejects unconfirmed or unknown results', (candidate) => {
  expect(qaAssignmentView(candidate)).toBeUndefined();
});
