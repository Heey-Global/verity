import type { SessionSummary } from '@verity/mobile';
import { useMemo } from 'react';
import { moveProjectIdToIndex } from '../lib/projectReorder';

export function useSessionRowCallbacks({
  sessions,
  scope,
  reordering,
  onRename,
  onFavorite,
  onDelete,
  onSelect,
  onOpen,
  onReorder,
}: {
  sessions: readonly SessionSummary[];
  scope: string;
  reordering: boolean;
  onRename: (session: SessionSummary & { openLinks?: boolean }) => void;
  onFavorite: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => void;
  onSelect?: ((id: string) => void) | undefined;
  onOpen: (session: SessionSummary) => void;
  onReorder: (scope: string, order: readonly string[]) => void;
}) {
  return useMemo(() => {
    const order = sessions.map((session) => `session:${session.sessionId}`);
    return new Map(
      sessions.map((session, index) => [
        session.sessionId,
        {
          onRename: () => onRename(session),
          onOpenLinks: () => onRename({ ...session, openLinks: true }),
          onToggleFavorite: () => onFavorite(session),
          onDelete: () => onDelete(session),
          onSelect: onSelect ? () => onSelect(session.sessionId) : undefined,
          onOpen: () => onOpen(session),
          onMoveUp:
            reordering && index > 0
              ? () => onReorder(scope, moveProjectIdToIndex(order, order[index]!, index - 1))
              : undefined,
          onMoveDown:
            reordering && index < sessions.length - 1
              ? () => onReorder(scope, moveProjectIdToIndex(order, order[index]!, index + 1))
              : undefined,
        },
      ]),
    );
  }, [sessions, scope, reordering, onRename, onFavorite, onDelete, onSelect, onOpen, onReorder]);
}
