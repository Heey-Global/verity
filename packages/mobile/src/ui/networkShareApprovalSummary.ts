// The approval card's account of a network share change. The server adds it to
// the card's input (as `networkShare`) from the project's grants, so it names
// the share and folders as the user knows them; agents cannot supply it.

export interface NetworkShareApprovalSummary {
  action: 'update' | 'rename' | 'move' | 'delete';
  kind: 'file' | 'folder';
  share: string;
  /** Share name and folders down to the item, joined with ` › `. */
  location: string;
  /** Where a rename or move puts the item. */
  destination: string | null;
  /** A replacement's size and, when it is text, its beginning. */
  content: { bytes: number; preview: string | null } | null;
}

const ACTIONS = new Set(['update', 'rename', 'move', 'delete']);

export function networkShareApprovalSummary(input: unknown): NetworkShareApprovalSummary | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>)['networkShare'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const { action, kind, share, location, destination, content } = fields;
  if (
    typeof action !== 'string' ||
    !ACTIONS.has(action) ||
    (kind !== 'file' && kind !== 'folder') ||
    typeof share !== 'string' ||
    typeof location !== 'string' ||
    (destination !== undefined && typeof destination !== 'string')
  )
    return null;
  // A rename or move without a destination would hide where the item goes.
  if ((action === 'rename' || action === 'move') !== (typeof destination === 'string')) return null;
  let replacement: NetworkShareApprovalSummary['content'] = null;
  if (content !== undefined) {
    if (typeof content !== 'object' || content === null) return null;
    const { bytes, preview } = content as Record<string, unknown>;
    if (typeof bytes !== 'number' || (preview !== undefined && typeof preview !== 'string'))
      return null;
    replacement = { bytes, preview: preview ?? null };
  }
  return {
    action: action as NetworkShareApprovalSummary['action'],
    kind,
    share,
    location,
    destination: typeof destination === 'string' ? destination : null,
    content: replacement,
  };
}

/** The card's headline, for example “Delete file on Studio NAS?”. */
export function networkShareApprovalTitle(summary: NetworkShareApprovalSummary): string {
  const verb =
    summary.action === 'update'
      ? 'Replace'
      : summary.action === 'delete'
        ? 'Delete'
        : summary.action === 'rename'
          ? 'Rename'
          : 'Move';
  return `${verb} ${summary.kind} on ${summary.share}?`;
}

/** The last name in a ` › ` location: a rename's new name. */
export function networkShareItemName(location: string): string {
  return location.split(' › ').at(-1) ?? location;
}

/** What approving does, in one or two sentences. */
export function networkShareApprovalEffect(summary: NetworkShareApprovalSummary): string {
  switch (summary.action) {
    case 'delete':
      return summary.kind === 'file'
        ? 'Deletes the version the agent read. If the file changed since, nothing is deleted.'
        : 'Deletes the folder only if it is empty.';
    case 'rename':
      return 'Stays in the same folder. Nothing is replaced; the rename fails if the name is taken.';
    case 'move':
      return summary.kind === 'folder'
        ? 'Moves the folder with everything in it. Nothing at the destination is replaced; the move fails if the name is taken.'
        : 'Nothing at the destination is replaced; the move fails if the name is taken.';
    case 'update':
      return `Replaces the version the agent read with ${formatBytes(summary.content?.bytes ?? 0)} of new ${summary.content?.preview === null ? 'content' : 'text'}. If the file changed since, nothing is replaced.`;
  }
}

/** Deleting leaves nothing to restore through Verity; the card says so plainly. */
export const NETWORK_SHARE_DELETE_WARNING =
  'Verity keeps no copy. The file can only be recovered if the NAS keeps a recycle bin for this share.';

function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} bytes`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
