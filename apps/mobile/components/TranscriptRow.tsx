import { beginRenderWork } from '../lib/sessionSwitchTiming';
import type { Row } from '@verity/mobile';
import { createContext, memo, type ReactNode } from 'react';
export const TranscriptTimingContext = createContext<string | undefined>(undefined);

/** Stable row identities keep historical Markdown out of the streaming render path. */
export const TranscriptRow = memo(function TranscriptRow({
  item,
  sessionId,
  isLatest,
  bookmarkable = true,
  renderContent,
}: {
  item: Row;
  sessionId?: string;
  isLatest: boolean;
  bookmarkable?: boolean;
  renderContent: (item: Row, isLatest: boolean, bookmarkable: boolean) => ReactNode;
}) {
  const finish = beginRenderWork('transcript-row-body', sessionId ?? '');
  const rendered = renderContent(item, isLatest, bookmarkable);
  finish();
  return (
    <TranscriptTimingContext.Provider value={sessionId}>
      {rendered}
    </TranscriptTimingContext.Provider>
  );
});
