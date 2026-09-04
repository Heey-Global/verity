// Per-session message bookmarks (#bookmarks): the operator can "dog-ear" an agent
// message in a long transcript and jump back to it later from the header sheet —
// the same orientation aid a Kindle bookmark gives in a long book.
//
// Each bookmark persists the message id plus a SHORT preview line and its timestamp
// — never the full prose. Storing the preview (not just the id) is what lets the
// jump-list show EVERY bookmark up front, even ones whose message hasn't been paged
// into the loaded transcript window yet (history loads newest-first, 150 at a time).
// The preview stays tiny regardless of how long the bookmarked passage is, and the
// jump still resolves the live message by id.
//
// Scoped per session (one AsyncStorage key each) so opening a session loads only its
// own bookmarks, and clearing one session's never touches another's.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useState } from 'react';

const storageKey = (sessionId: string): string => `verity.bookmarks.v1:${sessionId}`;

interface BookmarkEntry {
  /** The bookmarked message's stable id (e.g. `text-42`). */
  id: string;
  /** First line of the message, clipped — shown in the jump-list. */
  preview: string;
  /** The message's `createdAt` (epoch ms), kept as metadata. Ordering uses the seq
   *  parsed from `id` instead (see bySeq) — a reliable monotonic key. */
  createdAt: number;
}

export interface Bookmarks {
  /** Bookmarked entries for this session, oldest→newest (transcript order). */
  entries: BookmarkEntry[];
  /** Ids only, for O(1) membership + the header count. */
  ids: Set<string>;
  isBookmarked: (messageId: string) => boolean;
  /**
   * Add the message if absent (needs its preview+createdAt), remove it if present;
   * persists the change. `meta` is ignored on removal, so callers that only remove
   * (the sheet's ×) may omit it.
   */
  toggle: (messageId: string, meta?: { preview: string; createdAt: number }) => void;
}

// Accept the persisted shape (array of entries) and, defensively, a legacy array of
// bare id strings — so a set written by an earlier build still loads (as previewless
// entries) rather than being dropped.
function parseStored(raw: string): BookmarkEntry[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  const out: BookmarkEntry[] = [];
  for (const item of parsed) {
    if (typeof item === 'string') {
      out.push({ id: item, preview: '', createdAt: 0 });
    } else if (item && typeof item === 'object' && typeof (item as BookmarkEntry).id === 'string') {
      const e = item as BookmarkEntry;
      out.push({
        id: e.id,
        preview: typeof e.preview === 'string' ? e.preview : '',
        createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
      });
    }
  }
  return out;
}

// Sort the jump-list by the message's monotonic seq, parsed from its id (`text-42` →
// 42) — NOT by createdAt. createdAt is the message's `ts`, which falls back to the raw
// seq on frames the server sends without a real timestamp; mixing epoch-ms values with
// small seq-proxies (and 0 for legacy previewless entries) in one session would
// interleave the list out of transcript order. The seq is always the true order.
function entrySeq(entry: BookmarkEntry): number {
  const n = Number(entry.id.slice(entry.id.lastIndexOf('-') + 1));
  return Number.isFinite(n) ? n : 0;
}
const bySeq = (a: BookmarkEntry, b: BookmarkEntry): number => entrySeq(a) - entrySeq(b);

export function useBookmarks(sessionId: string): Bookmarks {
  const [entries, setEntries] = useState<BookmarkEntry[]>([]);

  // Load this session's set once on open. A corrupt/unavailable cache leaves it empty
  // rather than blocking the transcript — bookmarks are a convenience.
  useEffect(() => {
    let active = true;
    setEntries([]);
    void AsyncStorage.getItem(storageKey(sessionId))
      .then((raw) => {
        if (!active || !raw) return;
        setEntries(parseStored(raw).sort(bySeq));
      })
      .catch(() => {
        // Ignore — an unreadable cache just means no bookmarks yet.
      });
    return () => {
      active = false;
    };
  }, [sessionId]);

  const toggle = useCallback(
    (messageId: string, meta?: { preview: string; createdAt: number }) => {
      setEntries((prev) => {
        const next = prev.some((e) => e.id === messageId)
          ? prev.filter((e) => e.id !== messageId)
          : [
              ...prev,
              { id: messageId, preview: meta?.preview ?? '', createdAt: meta?.createdAt ?? 0 },
            ].sort(bySeq);
        void AsyncStorage.setItem(storageKey(sessionId), JSON.stringify(next)).catch(() => {
          // Keep the in-memory value even if the disk write fails.
        });
        return next;
      });
    },
    [sessionId],
  );

  const ids = useMemo(() => new Set(entries.map((e) => e.id)), [entries]);
  const isBookmarked = useCallback((messageId: string) => ids.has(messageId), [ids]);

  // Stable identity while the entries are unchanged: this is the context value, so a
  // fresh object each render would re-render every subscribed transcript row on every
  // SessionChat render (e.g. each streamed delta). It only changes on a toggle.
  return useMemo(
    () => ({ entries, ids, isBookmarked, toggle }),
    [entries, ids, isBookmarked, toggle],
  );
}
