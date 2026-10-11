import type { SessionSummary } from '@verity/mobile';
import { useMemo, useRef } from 'react';
import { moveProjectIdToIndex } from '../lib/projectReorder';

type RowCallbacks = {
  onRename: () => void;
  onOpenLinks: () => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
  onSelect: (() => void) | undefined;
  onOpen: () => void;
  onMoveUp: (() => void) | undefined;
  onMoveDown: (() => void) | undefined;
};

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
  const previous = useRef<
    | {
        context: unknown[];
        order: string[];
        records: Map<string, { session: SessionSummary; callbacks: RowCallbacks }>;
      }
    | undefined
  >(undefined);
  return useMemo(() => {
    const order = sessions.map((session) => `session:${session.sessionId}`);
    const context = [
      scope,
      reordering,
      onRename,
      onFavorite,
      onDelete,
      onSelect,
      onOpen,
      onReorder,
    ];
    const old = previous.current;
    const reusable =
      old !== undefined &&
      context.every((value, index) => value === old.context[index]) &&
      (!reordering ||
        (order.length === old.order.length && order.every((id, index) => id === old.order[index])));
    // A single updated session must not replace every sibling row's action props.
    const records = new Map<string, { session: SessionSummary; callbacks: RowCallbacks }>();
    const actions = new Map(
      sessions.map((session, index) => {
        const previousRecord = reusable ? old.records.get(session.sessionId) : undefined;
        const callbacks: RowCallbacks =
          previousRecord?.session === session
            ? previousRecord.callbacks
            : {
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
              };
        records.set(session.sessionId, { session, callbacks });
        return [session.sessionId, callbacks] as const;
      }),
    );
    previous.current = { context, order, records };
    return actions;
  }, [sessions, scope, reordering, onRename, onFavorite, onDelete, onSelect, onOpen, onReorder]);
}
