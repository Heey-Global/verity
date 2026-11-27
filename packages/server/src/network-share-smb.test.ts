import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  NetworkShareError,
  SmbClient,
  contentVersion,
  parseInfo,
  parseListing,
} from './network-share-smb.js';

// Output captured from smbclient 4.17 against Samba (see the integration test).
const LISTING = [
  '  .                                   D        0  Fri Nov 27 11:44:27 2026',
  '  ..                                  D        0  Fri Nov 27 11:44:27 2026',
  '  Reviews                             D        0  Fri Nov 27 11:44:27 2026',
  '  kickoff notes.md                    A     1234  Fri Nov 27 11:49:08 2026',
  '  #recycle                           DH        0  Fri Nov  7 09:01:02 2026',
  '  desktop.ini                        AHS      90  Fri Nov 27 11:44:27 2026',
  '',
  '\t\t487018084 blocks of size 1024. 62021820 blocks available',
].join('\n');

const FILE_INFO = [
  'altname: kickoff.md',
  'create_time:    Fri Nov 27 11:44:28 2026 UTC',
  'access_time:    Fri Nov 27 11:44:28 2026 UTC',
  'write_time:     Fri Nov 27 11:44:28 2026 UTC',
  'change_time:    Fri Nov 27 11:44:28 2026 UTC',
  'attributes:  (80)',
  'stream: [::$DATA], 6 bytes',
].join('\n');

describe('smbclient output', () => {
  it('lists entries with spaces in their names and hides NAS plumbing', () => {
    expect(parseListing(LISTING)).toEqual([
      { name: 'Reviews', kind: 'folder', size: 0 },
      { name: 'kickoff notes.md', kind: 'file', size: 1234 },
    ]);
  });

  // Timestamps from allinfo have one-second resolution; two same-size edits in
  // one second would share a time-based version and slip past a conflict check.
  it('versions files by content', () => {
    expect(contentVersion(Buffer.from('a'))).not.toBe(contentVersion(Buffer.from('b')));
    expect(contentVersion(Buffer.from('a'))).toBe(contentVersion(Buffer.from('a')));
  });

  it('reads kind and size', () => {
    const info = parseInfo(FILE_INFO);
    expect(info).toMatchObject({ kind: 'file', size: 6 });
    expect(parseInfo(FILE_INFO.replace('attributes:  (80)', 'attributes: D (10)')).kind).toBe(
      'folder',
    );
    // Without a reported size a file must not count as small enough to download.
    expect(parseInfo(FILE_INFO.replace('stream: [::$DATA], 6 bytes', '')).size).toBe(Infinity);
  });
});

// A stand-in smbclient: it reports a 6-byte file, then serves a download that
// keeps growing, as a file appended to on the NAS during the transfer would.
const GROWING_SMBCLIENT = `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *verity-mark*) echo "NT_STATUS_OBJECT_NAME_NOT_FOUND getting alt name for $(echo "$line" | cut -d'"' -f2)" >&2 ;;
    allinfo*) printf 'attributes:  (80)\\nstream: [::$DATA], 6 bytes\\n' >&2 ;;
    get*) target=$(echo "$line" | cut -d'"' -f4); while :; do head -c 1048576 /dev/zero >> "$target"; done ;;
    quit) exit 0 ;;
  esac
done
`;

describe('downloads', () => {
  // The size reported before a download is only the server's word; without a
  // bound during the transfer a growing file fills the server's disk.
  it('stops a download that grows past the file limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-fake-smb-'));
    try {
      const binary = join(dir, 'smbclient');
      writeFileSync(binary, GROWING_SMBCLIENT);
      chmodSync(binary, 0o755);
      const client = new SmbClient({ binary, timeoutMs: 20_000 });
      const started = Date.now();
      const error = await client
        .read(
          { host: 'nas', port: null, share: 'team', username: 'u', password: Buffer.from('p') },
          'big.bin',
        )
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NetworkShareError);
      expect((error as NetworkShareError).code).toBe('too_large');
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('credentials', () => {
  // Node rejects a NUL in the environment with a message that quotes the
  // value; uncaught, the password would end up in the server log.
  it('never lets a refused password reach an error message', async () => {
    const client = new SmbClient({ binary: '/nonexistent/smbclient' });
    const error = await client
      .test({
        host: 'nas',
        port: null,
        share: 'team',
        username: 'u',
        password: Buffer.from('secret\0pw'),
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkShareError);
    expect(String((error as Error).message)).not.toContain('secret');
    expect(JSON.stringify(error)).not.toContain('secret');
  });
});
