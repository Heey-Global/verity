/**
 * A project member's rights as independent check marks (ADR 0023 §1). Reading
 * comes with membership and is not a choice. Some rights need others: Code
 * needs Edit, and managing includes every other right, because a person who
 * changes rights could grant any of them to themselves.
 *
 * Checking a right also checks what it needs; unchecking one also clears what
 * builds on it. No combination the server refuses can be reached that way.
 */
export interface TeamRights {
  canExecute: boolean;
  canCode: boolean;
  canManage: boolean;
}

export type TeamRight = 'execute' | 'code' | 'manage';

export function toggleTeamRight(rights: TeamRights, right: TeamRight): TeamRights {
  const checking = !held(rights, right);
  switch (right) {
    case 'execute':
      return checking
        ? { ...rights, canExecute: true }
        : { canExecute: false, canCode: false, canManage: false };
    case 'code':
      return checking
        ? { ...rights, canExecute: true, canCode: true }
        : { ...rights, canCode: false, canManage: false };
    case 'manage':
      return checking
        ? { canExecute: true, canCode: true, canManage: true }
        : { ...rights, canManage: false };
  }
}

function held(rights: TeamRights, right: TeamRight): boolean {
  if (right === 'execute') return rights.canExecute;
  return right === 'code' ? rights.canCode : rights.canManage;
}

/** The strongest right a member holds, as the team list's tag names it. */
export function teamRightLabel(rights: {
  canExecute: boolean;
  canCode?: boolean | undefined;
  canManage: boolean;
}): string {
  if (rights.canManage) return 'Manage';
  if (rights.canCode === true) return 'Code';
  return rights.canExecute ? 'Can edit' : 'Can read';
}
