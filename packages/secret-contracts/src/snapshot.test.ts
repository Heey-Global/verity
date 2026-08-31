import { describe, expect, it } from 'vitest';
import {
  snapshotApprovalContextSchema,
  snapshotContentRootPreimage,
  snapshotIdPreimage,
  snapshotManifestSchema,
  validateSnapshotIdentity,
} from './index.js';

const hash = 'a'.repeat(64);
const base = {
  protocolVersion: 1,
  projectId: 'owner_repo',
  baseRevision: 'b'.repeat(40),
  snapshotPolicyHash: hash,
  sparseCheckout: false,
  entries: [
    {
      kind: 'file',
      path: 'src/index.ts',
      source: 'modified',
      mode: '100644',
      size: 12,
      contentHash: hash,
    },
  ],
  exclusions: [],
  fileCount: 1,
  totalBytes: 12,
  contentRootHash: hash,
  snapshotId: hash,
} as const;

describe('immutable snapshot contracts', () => {
  it('accepts a bounded regular-file manifest', () => {
    expect(snapshotManifestSchema.parse(base).fileCount).toBe(1);
  });

  it.each(['/etc/passwd', '../secret', 'a//b', 'a\\b', 'e\u0301.txt'])(
    'rejects unsafe or non-normalized path %s',
    (path) => {
      expect(() =>
        snapshotManifestSchema.parse({ ...base, entries: [{ ...base.entries[0], path }] }),
      ).toThrow();
    },
  );

  it('rejects case collisions and inconsistent aggregate metadata', () => {
    const second = { ...base.entries[0], path: 'SRC/INDEX.TS' };
    expect(() =>
      snapshotManifestSchema.parse({
        ...base,
        entries: [...base.entries, second],
        fileCount: 2,
        totalBytes: 24,
      }),
    ).toThrow(/collision/);
    expect(() => snapshotManifestSchema.parse({ ...base, totalBytes: 13 })).toThrow(
      /totalBytes mismatch/,
    );
  });

  it('rejects file ancestors and component-level portable collisions', () => {
    const entry = base.entries[0];
    expect(() =>
      snapshotManifestSchema.parse({
        ...base,
        entries: [
          { ...entry, path: 'a' },
          { ...entry, path: 'a/b' },
        ],
        fileCount: 2,
        totalBytes: 24,
      }),
    ).toThrow(/ancestor collision/);
    expect(() =>
      snapshotManifestSchema.parse({
        ...base,
        entries: [
          { ...entry, path: 'A/x' },
          { ...entry, path: 'a/y' },
        ],
        fileCount: 2,
        totalBytes: 24,
      }),
    ).toThrow(/component collision/);
  });

  it('binds domain-separated identities and approval preview to the manifest', () => {
    const fakeSha256 = (preimage: string) => (preimage.length % 16).toString(16).repeat(64);
    const initial = snapshotManifestSchema.parse(base);
    const contentRootHash = fakeSha256(snapshotContentRootPreimage(initial));
    const withRoot = { ...initial, contentRootHash };
    const snapshotId = fakeSha256(snapshotIdPreimage(withRoot));
    const manifest = { ...withRoot, snapshotId };
    expect(validateSnapshotIdentity(manifest, fakeSha256).snapshotId).toBe(snapshotId);
    const tamperedId = `${snapshotId.startsWith('a') ? 'b' : 'a'}${snapshotId.slice(1)}`;
    expect(() =>
      validateSnapshotIdentity({ ...manifest, snapshotId: tamperedId }, fakeSha256),
    ).toThrow(/snapshotId mismatch/);

    const preview = {
      snapshotId,
      baseRevision: manifest.baseRevision,
      fileCount: 1,
      deletionCount: 0,
      renameCount: 0,
      excludedCount: 0,
      totalBytes: 12,
      sparseCheckout: false,
      snapshotPolicyHash: hash,
      warnings: [],
    } as const;
    expect(snapshotApprovalContextSchema.parse({ manifest, preview }).preview.snapshotId).toBe(
      snapshotId,
    );
    expect(() =>
      snapshotApprovalContextSchema.parse({
        manifest,
        preview: { ...preview, sparseCheckout: true },
      }),
    ).toThrow(/sparseCheckout mismatch/);
  });

  it('derives identities independently of input order and ambiguous path delimiters', () => {
    const initial = snapshotManifestSchema.parse(base);
    const renames = [
      {
        kind: 'rename' as const,
        from: 'a:b',
        path: 'c',
        mode: '100644' as const,
        size: 1,
        contentHash: hash,
      },
      {
        kind: 'rename' as const,
        from: 'a',
        path: 'b:c',
        mode: '100644' as const,
        size: 1,
        contentHash: hash,
      },
    ];
    const forward = { ...initial, entries: renames, fileCount: 2, totalBytes: 2 };
    const reverse = { ...forward, entries: [...renames].reverse() };
    expect(snapshotContentRootPreimage(forward)).toBe(snapshotContentRootPreimage(reverse));
    expect(snapshotContentRootPreimage(forward)).toContain('verity.snapshot.content-root.v1\u0000');
  });

  it('rejects unsupported modes and unknown entry fields', () => {
    expect(() =>
      snapshotManifestSchema.parse({
        ...base,
        entries: [{ ...base.entries[0], mode: '100777' }],
      }),
    ).toThrow();
    expect(() =>
      snapshotManifestSchema.parse({
        ...base,
        entries: [{ ...base.entries[0], symlinkTarget: '/run/verity/token' }],
      }),
    ).toThrow();
  });
});
