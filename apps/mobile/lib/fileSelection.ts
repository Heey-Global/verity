// Pure logic behind the session file browser's multi-select and drag-out. Lives
// outside `app/` (like lib/attachments.ts) so it is testable without a renderer,
// and shared between the rows — which build their own drag payload — and the
// header, which reports the selection.
import type { SessionFileEntry } from '@verity/mobile';

/** One item handed to the native drag source. The payload is a download URL, not
 * bytes: the file is only fetched if the drag is actually dropped somewhere. */
export interface DragFileItem {
  url: string;
  fileName: string;
  mimeType: string;
}

export function fileNameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? 'download';
}

export function isTextPreviewCandidate(path: string): boolean {
  const name = fileNameFromPath(path);
  return (
    /\.(md|txt|jsonl?|tsx?|jsx?|css|html|ya?ml|env|sh|py|rb|go|rs|java|kt|swift|sql|toml|ini|lock)$/i.test(
      name,
    ) || /^(Dockerfile|Makefile|README|LICENSE)$/i.test(name)
  );
}

/** Best-effort content type for a worktree path. Drives both the iOS share sheet
 * and the UTType a drag registers — Finder names the saved file from the promise
 * instead, so a wrong guess here costs a generic icon, not a broken download. */
export function mimeTypeForFile(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (isTextPreviewCandidate(path)) return 'text/plain';
  return 'application/octet-stream';
}

/** Mirrors the server's MAX_SESSION_DOWNLOAD_BYTES (packages/server/src/server.ts).
 * Anything above it is refused by `/files/download` with a 413, so it cannot be
 * dragged out or shared — the file browser marks those rows rather than letting
 * a drag fail inside Finder, where the error is the destination's to report. */
export const MAX_DOWNLOADABLE_FILE_BYTES = 50_000_000;

/** Only regular files can be selected: a directory has no single download URL,
 * and a symlink's target may sit outside the worktree the server will serve.
 * A `null` size is unknown, not oversize — the server decides in that case. */
export function isSelectableFile(entry: SessionFileEntry): boolean {
  if (entry.kind !== 'file') return false;
  return entry.size === null || entry.size <= MAX_DOWNLOADABLE_FILE_BYTES;
}

export function toggleFileSelection(selected: readonly string[], path: string): string[] {
  return selected.includes(path)
    ? selected.filter((candidate) => candidate !== path)
    : [...selected, path];
}

/** Modifier keys held when a row was clicked, as the native drag view reports
 * them. Only meaningful with a hardware keyboard — an iPad app on a Mac, or an
 * iPad with a keyboard attached. */
export interface ClickModifiers {
  shift: boolean;
  command: boolean;
}

/** The selection, plus what the next modifier-click needs to know about the last
 * one. Finder keeps the anchor across successive shift-clicks so a range can be
 * resized without starting over; a command-click moves it. */
export interface FileSelectionState {
  selected: string[];
  anchor: string | null;
  /** Paths the last shift-click contributed — the ones it added that were not
   * already selected. The next shift-click takes them back before laying down
   * its own range, which is what makes the range resizable in both directions.
   * Rows picked by command-click are never in here, so resizing never eats
   * them. */
  range: string[];
}

/** What a modifier-click on `entry` should select, or `null` when the click
 * carries no selection meaning — no modifier held, or a row that cannot be
 * selected at all — in which case the caller does whatever a plain tap does.
 *
 * Command toggles the single row; shift spans anchor to row, replacing whatever
 * the previous shift-click spanned so the range can be made smaller as well as
 * larger. Rows selected any other way survive either gesture. */
export function selectionForModifierClick(
  state: { selected: readonly string[]; anchor: string | null; range: readonly string[] },
  entry: SessionFileEntry,
  modifiers: ClickModifiers,
  entries: readonly SessionFileEntry[],
): FileSelectionState | null {
  if (!modifiers.shift && !modifiers.command) return null;
  if (!isSelectableFile(entry)) return null;
  if (!modifiers.shift) {
    // Toggling a row makes it the anchor and ends the range the last
    // shift-click owned — those rows are now the operator's, not the range's.
    return {
      selected: toggleFileSelection(state.selected, entry.path),
      anchor: entry.path,
      range: [],
    };
  }
  // A row that is not in the listing has no position to measure a range from or
  // to, so it cannot mean anything as a shift-click.
  const targetIndex = entries.findIndex((row) => row.path === entry.path);
  if (targetIndex === -1) return null;
  // A stale anchor — its row left the listing, or shift was the first modifier
  // used — degenerates to a range of one, which is what clicking a single row
  // means anyway.
  const anchorIndex = entries.findIndex((row) => row.path === state.anchor);
  const from = anchorIndex === -1 ? targetIndex : Math.min(anchorIndex, targetIndex);
  const to = anchorIndex === -1 ? targetIndex : Math.max(anchorIndex, targetIndex);
  const previous = new Set(state.range);
  const kept = state.selected.filter((path) => !previous.has(path));
  const added = entries
    .slice(from, to + 1)
    .filter(isSelectableFile)
    .map((row) => row.path)
    .filter((path) => !kept.includes(path));
  return {
    selected: [...kept, ...added],
    anchor: anchorIndex === -1 ? entry.path : state.anchor,
    range: added,
  };
}

/** Drop paths that are no longer on screen. Navigating to another directory (or
 * a reload after an upload) must not leave a selection pointing at rows the
 * operator can no longer see or deselect. */
export function retainVisibleSelection(
  selected: readonly string[],
  entries: readonly SessionFileEntry[],
): string[] {
  const visible = new Set(entries.filter(isSelectableFile).map((entry) => entry.path));
  return selected.filter((path) => visible.has(path));
}

/** What a drag starting on `entry` should carry. Finder's rule: dragging a row
 * inside the selection takes the whole selection, dragging one outside it takes
 * only that row — and leaves the selection alone. Items follow the on-screen
 * order rather than the order rows were tapped in. */
export function dragItemsForRow(
  entry: SessionFileEntry,
  selected: readonly string[],
  entries: readonly SessionFileEntry[],
  downloadUrl: (path: string) => string,
): DragFileItem[] {
  if (!isSelectableFile(entry)) return [];
  const paths = selected.includes(entry.path)
    ? entries
        .filter((row) => isSelectableFile(row) && selected.includes(row.path))
        .map((r) => r.path)
    : [entry.path];
  return paths.map((path) => ({
    url: downloadUrl(path),
    fileName: fileNameFromPath(path),
    mimeType: mimeTypeForFile(path),
  }));
}

export function selectionSummary(count: number): string {
  return count === 1 ? '1 selected' : `${String(count)} selected`;
}
