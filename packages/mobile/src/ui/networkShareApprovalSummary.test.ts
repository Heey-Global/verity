import { describe, expect, it } from 'vitest';

import { networkShareApprovalSummary } from './networkShareApprovalSummary.js';
import { permissionSummary } from './permissionSummary.js';

// The server merges `networkShare` into the card's input; the agent's own
// request only carries opaque folder IDs.
const card = (networkShare: object, request: object = { folderId: 'f1', path: 'x' }) => ({
  ...request,
  networkShare,
});

describe('network share approval cards', () => {
  it('names the share, the item and the risk of a file delete', () => {
    const summary = permissionSummary(
      'verity_network_shares',
      card({
        action: 'delete',
        kind: 'file',
        share: 'Studio NAS',
        location: ['Studio NAS', 'Projects', 'Briefs', 'old-kickoff.md'],
      }),
    );
    expect(summary.title).toBe('Delete file on Studio NAS?');
    expect(summary.lines.map((line) => line.text)).toEqual([
      'Studio NAS › Projects › Briefs › old-kickoff.md',
      'Deletes the version the agent read. If the file changed since, nothing is deleted.',
      'Verity keeps no copy. The file can only be recovered if the NAS keeps a recycle bin for this share.',
    ]);
  });

  it('shows where a move puts the item and the new name of a rename', () => {
    const move = permissionSummary(
      'verity_network_shares',
      card({
        action: 'move',
        kind: 'folder',
        share: 'Studio NAS',
        location: ['Studio NAS', 'Projects', 'Briefs', 'Reviews 2025'],
        destination: ['Studio NAS', 'Projects', 'Archive', 'Reviews 2025'],
      }),
    );
    expect(move.title).toBe('Move folder on Studio NAS?');
    expect(move.lines[1]?.text).toBe('To Studio NAS › Projects › Archive › Reviews 2025');
    const rename = permissionSummary(
      'verity_network_shares',
      card({
        action: 'rename',
        kind: 'file',
        share: 'Studio NAS',
        location: ['Studio NAS', 'Briefs', 'budget_v7.xlsx'],
        destination: ['Studio NAS', 'Briefs', 'Budget 2026.xlsx'],
      }),
    );
    expect(rename.lines[1]?.text).toBe('New name: Budget 2026.xlsx');
  });

  it('states the size of a replacement', () => {
    const summary = permissionSummary(
      'verity_network_shares',
      card({
        action: 'update',
        kind: 'file',
        share: 'Studio NAS',
        location: ['Studio NAS', 'kickoff.md'],
        content: { bytes: 3400, preview: '# Kickoff' },
      }),
    );
    expect(summary.title).toBe('Replace file on Studio NAS?');
    expect(summary.lines.at(-1)?.text).toContain('3.4 KB of new text');
  });

  // Names come from the agent. One that contains the separator must not read
  // as two folder levels, or the card would show a different place.
  it('quotes names that contain the separator', () => {
    const rename = permissionSummary(
      'verity_network_shares',
      card({
        action: 'rename',
        kind: 'file',
        share: 'Studio NAS',
        location: ['Studio NAS', 'Briefs', 'a.md'],
        destination: ['Studio NAS', 'Briefs', 'Budget › Final.xlsx'],
      }),
    );
    expect(rename.lines[1]?.text).toBe('New name: "Budget › Final.xlsx"');
    const move = permissionSummary(
      'verity_network_shares',
      card({
        action: 'move',
        kind: 'file',
        share: 'Studio NAS',
        location: ['Studio NAS', 'Briefs › Archive', 'a.md'],
        destination: ['Studio NAS', 'Archive', 'a.md'],
      }),
    );
    expect(move.lines[0]?.text).toBe('Studio NAS › "Briefs › Archive" › a.md');
    const lookalike = permissionSummary(
      'verity_network_shares',
      card({
        action: 'delete',
        kind: 'file',
        share: 'Studio NAS',
        location: ['Studio NAS', 'Briefs ⟩ Archive', 'a.md'],
      }),
    );
    expect(lookalike.lines[0]?.text).toBe('Studio NAS › "Briefs ⟩ Archive" › a.md');
  });

  // A card that cannot say where something goes must fall back to the raw
  // request rather than show a partial account.
  it('rejects incomplete or unknown descriptions', () => {
    for (const networkShare of [
      { action: 'move', kind: 'file', share: 'S', location: ['S', 'a'] },
      { action: 'delete', kind: 'everything', share: 'S', location: ['S', 'a'] },
      { action: 'create', kind: 'file', share: 'S', location: ['S', 'a'] },
      { action: 'delete', kind: 'file', share: 'S', location: ['S', 'a'], destination: ['S', 'b'] },
      { action: 'update', kind: 'file', share: 'S', location: ['S', 'a'], content: { bytes: '1' } },
      { action: 'update', kind: 'file', share: 'S', location: ['S', 'a'] },
    ])
      expect(networkShareApprovalSummary(card(networkShare))).toBeNull();
    expect(networkShareApprovalSummary({ folderId: 'f1' })).toBeNull();
    expect(
      networkShareApprovalSummary(
        card({ action: 'delete', kind: 'file', share: '', location: ['S', 'a'] }),
      ),
    ).toBeNull();
    expect(
      permissionSummary('verity_network_shares', { action: 'delete', folderId: 'f1' }).title,
    ).not.toContain('Studio NAS');
  });
});
