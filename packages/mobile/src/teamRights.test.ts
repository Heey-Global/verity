import { describe, expect, it } from 'vitest';
import { teamRightLabel, toggleTeamRight, type TeamRight, type TeamRights } from './teamRights.js';

const none: TeamRights = { canExecute: false, canCode: false, canManage: false };
const edit: TeamRights = { canExecute: true, canCode: false, canManage: false };
const code: TeamRights = { canExecute: true, canCode: true, canManage: false };
const all: TeamRights = { canExecute: true, canCode: true, canManage: true };

// The server refuses Code without Edit and managing without both; a tap that
// produced such a combination would fail only once it reached the server.
const consistent = (rights: TeamRights) =>
  (!rights.canCode || rights.canExecute) &&
  (!rights.canManage || (rights.canExecute && rights.canCode));

describe('toggleTeamRight', () => {
  it('checks what a right needs', () => {
    expect(toggleTeamRight(none, 'code')).toEqual(code);
    expect(toggleTeamRight(none, 'manage')).toEqual(all);
    expect(toggleTeamRight(none, 'execute')).toEqual(edit);
  });

  it('clears what builds on a right', () => {
    expect(toggleTeamRight(all, 'execute')).toEqual(none);
    expect(toggleTeamRight(all, 'code')).toEqual(edit);
    expect(toggleTeamRight(all, 'manage')).toEqual(code);
  });

  it('reaches only combinations the server accepts', () => {
    const rights: TeamRight[] = ['execute', 'code', 'manage'];
    const seen = new Set<string>();
    const queue: TeamRights[] = [none];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const key = JSON.stringify(current);
      if (seen.has(key)) continue;
      seen.add(key);
      expect(consistent(current)).toBe(true);
      for (const right of rights) queue.push(toggleTeamRight(current, right));
    }
    // Read only, Edit, Edit + Code, everything.
    expect(seen.size).toBe(4);
  });
});

describe('teamRightLabel', () => {
  it('names the strongest right, and reads an older server without Code as before', () => {
    expect(teamRightLabel(all)).toBe('Manage');
    expect(teamRightLabel(code)).toBe('Code');
    expect(teamRightLabel(edit)).toBe('Can edit');
    expect(teamRightLabel({ canExecute: true, canManage: false })).toBe('Can edit');
    expect(teamRightLabel(none)).toBe('Can read');
  });
});
