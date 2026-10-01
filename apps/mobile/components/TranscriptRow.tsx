import type { Row } from '@verity/mobile';
import { memo, type ReactNode } from 'react';

/** Stable row identities keep historical Markdown out of the streaming render path. */
export const TranscriptRow = memo(function TranscriptRow({
  item,
  isLatest,
  bookmarkable = true,
  renderContent,
}: {
  item: Row;
  isLatest: boolean;
  bookmarkable?: boolean;
  renderContent: (item: Row, isLatest: boolean, bookmarkable: boolean) => ReactNode;
}) {
  return renderContent(item, isLatest, bookmarkable);
});
