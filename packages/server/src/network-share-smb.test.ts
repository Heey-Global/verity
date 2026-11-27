import { describe, expect, it } from 'vitest';

import { contentVersion, parseInfo, parseListing } from './network-share-smb.js';

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
