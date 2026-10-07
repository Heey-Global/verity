import { describe, expect, it } from 'vitest';
import { bubbleRestingPlace, taskAge, taskContext } from './tasks.js';
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
describe('bubble resting place', () => {
  const screen = { width: 390, top: 100, bottom: 700 };
  it('follows a sideways fling even away from the nearer edge', () => {
    expect(bubbleRestingPlace({ ...screen, x: 60, y: 300, vx: 1.2, vy: 0 })).toEqual({
      side: 'right',
      y: 300,
    });
    expect(bubbleRestingPlace({ ...screen, x: 330, y: 300, vx: -0.8, vy: 0 }).side).toBe('left');
  });
  it('docks at the nearer edge after a slow release', () => {
    expect(bubbleRestingPlace({ ...screen, x: 100, y: 300, vx: 0.1, vy: 0 }).side).toBe('left');
    expect(bubbleRestingPlace({ ...screen, x: 300, y: 300, vx: -0.1, vy: 0 }).side).toBe('right');
  });
  it('carries vertical momentum past the finger but never off the band', () => {
    expect(bubbleRestingPlace({ ...screen, x: 10, y: 300, vx: 0, vy: 0.5 }).y).toBe(410);
    expect(bubbleRestingPlace({ ...screen, x: 10, y: 300, vx: 0, vy: -3 }).y).toBe(100);
    expect(bubbleRestingPlace({ ...screen, x: 10, y: 650, vx: 0, vy: 4 }).y).toBe(700);
  });
});
