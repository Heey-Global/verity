import { describe, expect, it } from 'vitest';
import { taskContext } from './tasks.js';
describe('task context', () => {
  const sessions = [{ sessionId: 's', projectId: 'p' }];
  it('uses the session project on phone and selected wide home', () => {
    expect(taskContext('/session/s', { id: 's' }, sessions)).toEqual({
      projectId: 'p',
      sessionId: 's',
    });
    expect(taskContext('/', { selected: 's' }, sessions)).toEqual({
      projectId: 'p',
      sessionId: 's',
    });
  });
  it('uses project routes and ignores stale params elsewhere', () => {
    expect(taskContext('/project/p/settings', { id: 'p' }, sessions)).toEqual({
      projectId: 'p',
      sessionId: null,
    });
    expect(taskContext('/settings', { selected: 's', id: 'p' }, sessions)).toEqual({
      projectId: null,
      sessionId: null,
    });
  });
  it('does not guess a project for an unresolved session', () => {
    expect(taskContext('/session/missing', { id: 'missing' }, sessions)).toEqual({
      projectId: null,
      sessionId: 'missing',
    });
  });
});
