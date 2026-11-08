import type { SessionSummary } from '@verity/mobile';

/** Working on a turn or a background task, or waiting on another session. */
export function isActive(session: SessionSummary): boolean {
  return (
    session.status === 'running' ||
    session.status === 'awaiting_dependency' ||
    session.backgroundWorking === true
  );
}
