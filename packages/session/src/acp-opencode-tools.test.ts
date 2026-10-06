import { describe, expect, it } from 'vitest';
import { AcpEventAdapter } from './acp-adapter.js';
import { openCodeToolName } from './acp-opencode-backend.js';

describe('OpenCode todo snapshots', () => {
  it('names lowercase todo calls for the mobile checklist renderer', () => {
    const adapter = new AcpEventAdapter({ resolveToolName: openCodeToolName });
    const todos = [{ content: 'Verify the fix', status: 'pending', priority: 'high' }];
    expect(
      adapter.consume({
        sessionUpdate: 'tool_call',
        toolCallId: 'todo-1',
        title: 'todowrite',
        kind: 'other',
        status: 'in_progress',
        rawInput: { todos },
      }),
    ).toContainEqual(
      expect.objectContaining({
        t: 'tool_call',
        name: 'TodoWrite',
        input: { todos },
      }),
    );
    expect(
      adapter.consume({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'todo-1',
        title: '1 todos',
        status: 'completed',
        rawOutput: todos,
      }),
    ).toContainEqual(expect.objectContaining({ t: 'tool_result', id: 'todo-1' }));
  });
});
