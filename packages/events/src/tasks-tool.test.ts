import { describe, expect, it } from 'vitest';

import {
  ASSIGNED_TASKS_PROMPT_MAX,
  TASKS_ADD_MAX,
  renderAssignedTasksPrompt,
  tasksRequestSchema,
} from './tasks-tool.js';

describe('tasksRequestSchema', () => {
  it('accepts each action and rejects what the agent must not do', () => {
    expect(tasksRequestSchema.parse({ action: 'list' })).toEqual({ action: 'list' });
    expect(
      tasksRequestSchema.parse({ action: 'add', tasks: [{ title: ' Rotate tokens ' }] }),
    ).toEqual({ action: 'add', tasks: [{ title: 'Rotate tokens' }] });
    expect(tasksRequestSchema.parse({ action: 'complete', id: 't1', result: 'done' }).action).toBe(
      'complete',
    );
    // No session or owner can be named; the gateway binds both.
    expect(tasksRequestSchema.safeParse({ action: 'list', sessionId: 's2' }).success).toBe(false);
    // The agent cannot mark done without a result, nor set done through update.
    expect(tasksRequestSchema.safeParse({ action: 'complete', id: 't1' }).success).toBe(false);
    expect(
      tasksRequestSchema.safeParse({ action: 'update', id: 't1', status: 'done' }).success,
    ).toBe(false);
    expect(tasksRequestSchema.safeParse({ action: 'delete', id: 't1' }).success).toBe(false);
    expect(tasksRequestSchema.safeParse({ action: 'add', tasks: [] }).success).toBe(false);
    expect(
      tasksRequestSchema.safeParse({
        action: 'add',
        tasks: Array.from({ length: TASKS_ADD_MAX + 1 }, () => ({ title: 't' })),
      }).success,
    ).toBe(false);
  });
});

describe('renderAssignedTasksPrompt', () => {
  it('is empty without tasks and lists ids, state and attachment counts otherwise', () => {
    expect(renderAssignedTasksPrompt([])).toBe('');
    const prompt = renderAssignedTasksPrompt([
      { id: 'a1', title: 'Rate-limit the\n login route', status: 'in_progress', attachments: 0 },
      { id: 'b2', title: 'Badge cut off on iPad', status: 'open', attachments: 2 },
    ]);
    expect(prompt).toContain('# Assigned tasks (verity_tasks)');
    expect(prompt).toContain('- #a1 (in progress) Rate-limit the login route');
    expect(prompt).toContain('- #b2 Badge cut off on iPad · 2 attachments');
  });

  it('caps the section and truncates long titles so the prompt stays bounded', () => {
    const tasks = Array.from({ length: ASSIGNED_TASKS_PROMPT_MAX + 5 }, (_, i) => ({
      id: `t${String(i)}`,
      title: 'x'.repeat(500),
      status: 'open' as const,
      attachments: 0,
    }));
    const prompt = renderAssignedTasksPrompt(tasks);
    expect(prompt.split('\n- #')).toHaveLength(ASSIGNED_TASKS_PROMPT_MAX + 1);
    expect(prompt).toContain('… 5 more; call verity_tasks list for all');
    expect(prompt.length).toBeLessThan(ASSIGNED_TASKS_PROMPT_MAX * 200);
  });
});
