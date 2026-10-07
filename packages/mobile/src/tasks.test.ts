import { describe, expect, it } from 'vitest';
import { taskAge, taskContext } from './tasks.js';
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
describe('task age', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  const at = (iso: string) => taskAge(iso, now);
  it('rounds down to the coarsest unit that still reads naturally', () => {
    expect(at('2026-10-07T11:59:40Z')).toBe('just now');
    expect(at('2026-10-07T11:55:00Z')).toBe('5 min ago');
    expect(at('2026-10-07T09:30:00Z')).toBe('2 h ago');
    expect(at('2026-10-06T08:00:00Z')).toBe('yesterday');
    expect(at('2026-10-04T12:00:00Z')).toBe('3 days ago');
    expect(at('2026-08-01T12:00:00Z')).toBe('2 months ago');
  });
  it('never reports the future or an unparsable stamp as elapsed time', () => {
    expect(at('2026-10-08T12:00:00Z')).toBe('just now');
    expect(at('')).toBe('just now');
  });
});
