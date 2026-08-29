import { describe, expect, it } from 'vitest';

import {
  GoogleDriveError,
  createCachedGoogleAccessToken,
  downloadDriveFile,
  exchangeGoogleAuthCode,
  exportDriveFile,
  getDriveAccountEmail,
  listDriveFiles,
  planDriveImport,
  referenceDocFileName,
  refreshGoogleAccessToken,
  type GoogleFetch,
  type GoogleHttpResponse,
} from './google-drive.js';

const jsonRes = (body: unknown, init?: { ok?: boolean; status?: number }): GoogleHttpResponse => ({
  ok: init?.ok ?? true,
  status: init?.status ?? 200,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
});

const bytesRes = (
  bytes: Uint8Array,
  init?: { ok?: boolean; status?: number },
): GoogleHttpResponse => ({
  ok: init?.ok ?? true,
  status: init?.status ?? 200,
  json: () => Promise.resolve({}),
  text: () => Promise.resolve(''),
  arrayBuffer: () => {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return Promise.resolve(copy.buffer);
  },
});

interface Call {
  url: string;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
}

function recordingFetch(respond: (call: Call) => GoogleHttpResponse): {
  fetch: GoogleFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: GoogleFetch = (url, init) => {
    const call: Call = { url, method: init?.method, headers: init?.headers, body: init?.body };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return { fetch, calls };
}

describe('planDriveImport', () => {
  it('exports native Google editor types to a text-first format', () => {
    expect(planDriveImport('application/vnd.google-apps.document', 'Spec')).toEqual({
      kind: 'export',
      exportMimeType: 'text/markdown',
      extension: 'md',
    });
    expect(planDriveImport('application/vnd.google-apps.spreadsheet', 'Budget')).toEqual({
      kind: 'export',
      exportMimeType: 'text/csv',
      extension: 'csv',
    });
    expect(planDriveImport('application/vnd.google-apps.presentation', 'Deck')).toEqual({
      kind: 'export',
      exportMimeType: 'application/pdf',
      extension: 'pdf',
    });
  });

  it('rejects folders and non-exportable Google types as not_importable', () => {
    expect(() => planDriveImport('application/vnd.google-apps.folder', 'Docs')).toThrow(
      GoogleDriveError,
    );
    try {
      planDriveImport('application/vnd.google-apps.form', 'Survey');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GoogleDriveError);
      expect((err as GoogleDriveError).reason).toBe('not_importable');
    }
  });

  it('downloads regular files, preferring the name extension over the MIME fallback', () => {
    expect(planDriveImport('application/pdf', 'contract.PDF')).toEqual({
      kind: 'download',
      extension: 'pdf',
    });
    // No usable name extension → MIME fallback.
    expect(planDriveImport('application/pdf', 'contract')).toEqual({
      kind: 'download',
      extension: 'pdf',
    });
    // Unknown MIME and no extension → bin.
    expect(planDriveImport('application/x-unknown', 'blob')).toEqual({
      kind: 'download',
      extension: 'bin',
    });
  });
});

describe('exchangeGoogleAuthCode', () => {
  it('posts a PKCE authorization_code exchange with no client secret', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonRes({ access_token: 'at', refresh_token: 'rt', expires_in: 3599 }),
    );
    const tokens = await exchangeGoogleAuthCode(
      {
        clientId: 'cid.apps.googleusercontent.com',
        code: 'the-code',
        codeVerifier: 'verifier',
        redirectUri: 'com.example:/oauth',
      },
      { fetch },
    );
    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresInSeconds: 3599 });
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
    const params = new URLSearchParams(calls[0]?.body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('client_id')).toBe('cid.apps.googleusercontent.com');
    expect(params.get('code')).toBe('the-code');
    expect(params.get('code_verifier')).toBe('verifier');
    expect(params.get('redirect_uri')).toBe('com.example:/oauth');
    expect(params.get('client_secret')).toBeNull();
  });

  it('maps a Google error to its short reason code without leaking the body', async () => {
    const { fetch } = recordingFetch(() =>
      jsonRes(
        { error: 'invalid_grant', error_description: 'Bad Request: secret-ish detail' },
        { ok: false, status: 400 },
      ),
    );
    await expect(
      exchangeGoogleAuthCode(
        { clientId: 'cid', code: 'x', codeVerifier: 'y', redirectUri: 'z' },
        { fetch },
      ),
    ).rejects.toMatchObject({ reason: 'invalid_grant' });
  });

  it('surfaces a network failure as reason "network"', async () => {
    const fetch: GoogleFetch = () => Promise.reject(new Error('ECONNREFUSED'));
    await expect(
      exchangeGoogleAuthCode(
        { clientId: 'c', code: 'x', codeVerifier: 'y', redirectUri: 'z' },
        { fetch },
      ),
    ).rejects.toMatchObject({ reason: 'network' });
  });
});

describe('refreshGoogleAccessToken', () => {
  it('posts a refresh_token grant and returns a fresh access token', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonRes({ access_token: 'fresh', expires_in: 3599 }),
    );
    const tokens = await refreshGoogleAccessToken(
      { clientId: 'cid', refreshToken: 'rt' },
      { fetch },
    );
    expect(tokens.accessToken).toBe('fresh');
    expect(tokens.refreshToken).toBeUndefined();
    const params = new URLSearchParams(calls[0]?.body);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('rt');
  });
});

describe('getDriveAccountEmail', () => {
  it('reads the connected account email from Drive about.user', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonRes({ user: { emailAddress: 'me@example.com', displayName: 'Me' } }),
    );
    await expect(getDriveAccountEmail('at', { fetch })).resolves.toBe('me@example.com');
    expect(calls[0]?.url).toContain('/about?fields=user');
    expect(calls[0]?.headers?.Authorization).toBe('Bearer at');
  });
});

describe('listDriveFiles', () => {
  it('queries a folder, parses files, and returns the page token', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonRes({
        files: [
          { id: 'f1', name: 'Sub', mimeType: 'application/vnd.google-apps.folder' },
          {
            id: 'd1',
            name: 'Spec',
            mimeType: 'application/vnd.google-apps.document',
            modifiedTime: 't',
          },
          { bogus: true },
        ],
        nextPageToken: 'next',
      }),
    );
    const result = await listDriveFiles({ accessToken: 'at', parentId: 'FOLDER' }, { fetch });
    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toMatchObject({
      id: 'f1',
      mimeType: 'application/vnd.google-apps.folder',
    });
    expect(result.nextPageToken).toBe('next');
    const url = calls[0]?.url ?? '';
    // URLSearchParams encodes spaces as `+` and single quotes as `%27`.
    expect(url).toContain('%27FOLDER%27+in+parents');
    expect(url).toContain('trashed+%3D+false');
    expect(url).toContain('orderBy=name_natural');
  });

  it('defaults to the My Drive root when no parent is given', async () => {
    const { fetch, calls } = recordingFetch(() => jsonRes({ files: [] }));
    await listDriveFiles({ accessToken: 'at' }, { fetch });
    expect(calls[0]?.url).toContain('%27root%27+in+parents');
  });

  it('lists files in the Shared with me collection', async () => {
    const { fetch, calls } = recordingFetch(() => jsonRes({ files: [] }));
    await listDriveFiles({ accessToken: 'at', sharedWithMe: true }, { fetch });
    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('q')).toBe('sharedWithMe = true and trashed = false');
    expect(url.searchParams.get('corpora')).toBe('user');
    expect(url.searchParams.get('orderBy')).toBe('name_natural');
  });

  it('searches file names across Drive and escapes query literals', async () => {
    const { fetch, calls } = recordingFetch(() => jsonRes({ files: [] }));
    await listDriveFiles({ accessToken: 'at', query: String.raw`team's \ plan` }, { fetch });
    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('q')).toBe(
      String.raw`name contains 'team\'s \\ plan' and trashed = false`,
    );
    expect(url.searchParams.get('q')).not.toContain('in parents');
    expect(url.searchParams.get('corpora')).toBe('user');
    expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('true');
  });

  it("lifts Google's 403 reason slug into the error (errors[0].reason)", async () => {
    const { fetch } = recordingFetch(() =>
      jsonRes(
        { error: { errors: [{ reason: 'accessNotConfigured' }], status: 'PERMISSION_DENIED' } },
        { ok: false, status: 403 },
      ),
    );
    await expect(listDriveFiles({ accessToken: 'at' }, { fetch })).rejects.toMatchObject({
      reason: 'http_403_accessNotConfigured',
    });
  });

  it('falls back to error.status when no errors[].reason is present', async () => {
    const { fetch } = recordingFetch(() =>
      jsonRes({ error: { status: 'PERMISSION_DENIED' } }, { ok: false, status: 403 }),
    );
    await expect(listDriveFiles({ accessToken: 'at' }, { fetch })).rejects.toMatchObject({
      reason: 'http_403_PERMISSIONDENIED',
    });
  });

  it('stays a bare http_<status> when the body carries no error slug', async () => {
    const { fetch } = recordingFetch(() => jsonRes({}, { ok: false, status: 403 }));
    await expect(listDriveFiles({ accessToken: 'at' }, { fetch })).rejects.toMatchObject({
      reason: 'http_403',
    });
  });

  it('degrades a malformed errors array to a bare http_<status> without throwing', async () => {
    // Untrusted body shapes must never turn a GoogleDriveError into an uncaught
    // TypeError: a null/non-object first element falls back to a clean reason.
    for (const errors of [[null], [123], ['x'], [{ nope: true }]]) {
      const { fetch } = recordingFetch(() =>
        jsonRes({ error: { errors } }, { ok: false, status: 403 }),
      );
      await expect(listDriveFiles({ accessToken: 'at' }, { fetch })).rejects.toMatchObject({
        reason: 'http_403',
      });
    }
  });
});

describe('downloadDriveFile / exportDriveFile', () => {
  it('downloads raw bytes via alt=media', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const { fetch, calls } = recordingFetch(() => bytesRes(payload));
    const bytes = await downloadDriveFile('at', 'file-id', { fetch });
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(calls[0]?.url).toContain('/files/file-id?alt=media');
  });

  it('exports native files to the requested MIME type', async () => {
    const payload = new Uint8Array([9, 9]);
    const { fetch, calls } = recordingFetch(() => bytesRes(payload));
    await exportDriveFile('at', 'doc-id', 'text/markdown', { fetch });
    expect(calls[0]?.url).toContain('/files/doc-id/export?mimeType=text%2Fmarkdown');
  });

  it('maps a non-2xx download to an http_<status> reason', async () => {
    const { fetch } = recordingFetch(() => bytesRes(new Uint8Array(), { ok: false, status: 404 }));
    await expect(downloadDriveFile('at', 'gone', { fetch })).rejects.toMatchObject({
      reason: 'http_404',
    });
  });
});

describe('referenceDocFileName', () => {
  it('produces a stable slug-plus-fileId-hash name, applying the plan extension', () => {
    const a = referenceDocFileName('My Spec! v2.txt', 'md', 'file-abc');
    expect(a).toMatch(/^my-spec-v2-[0-9a-f]{8}\.md$/);
    // Same file id → same name (re-import overwrites).
    expect(referenceDocFileName('My Spec! v2.txt', 'md', 'file-abc')).toBe(a);
    // Different file id with the same title → different hash (no collision).
    expect(referenceDocFileName('My Spec! v2.txt', 'md', 'file-xyz')).not.toBe(a);
  });

  it('falls back to "document" when the name has no slug characters', () => {
    expect(referenceDocFileName('***', 'csv', 'id1')).toMatch(/^document-[0-9a-f]{8}\.csv$/);
  });
});

describe('createCachedGoogleAccessToken', () => {
  it('refreshes once and serves the cached token within the TTL', async () => {
    let refreshes = 0;
    const fetch: GoogleFetch = () => {
      refreshes += 1;
      return Promise.resolve(jsonRes({ access_token: `t${String(refreshes)}`, expires_in: 3599 }));
    };
    const provider = createCachedGoogleAccessToken(
      () => Promise.resolve({ clientId: 'cid', refreshToken: 'rt' }),
      { fetch, now: () => 1_000 },
    );
    await expect(provider()).resolves.toBe('t1');
    await expect(provider()).resolves.toBe('t1');
    expect(refreshes).toBe(1);
  });

  it('returns undefined when not connected', async () => {
    const provider = createCachedGoogleAccessToken(() => Promise.resolve(undefined));
    await expect(provider()).resolves.toBeUndefined();
  });

  it('busts the cache when the refresh token changes (reconnect)', async () => {
    let refreshes = 0;
    let refreshToken = 'rt-old';
    const fetch: GoogleFetch = () => {
      refreshes += 1;
      return Promise.resolve(jsonRes({ access_token: `t${String(refreshes)}`, expires_in: 3599 }));
    };
    const provider = createCachedGoogleAccessToken(
      () => Promise.resolve({ clientId: 'cid', refreshToken }),
      { fetch, now: () => 1_000 },
    );
    await expect(provider()).resolves.toBe('t1');
    refreshToken = 'rt-new';
    await expect(provider()).resolves.toBe('t2');
    expect(refreshes).toBe(2);
  });

  it('swallows a refresh failure to undefined so the next call retries', async () => {
    let attempt = 0;
    const fetch: GoogleFetch = () => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('boom'));
      return Promise.resolve(jsonRes({ access_token: 'ok', expires_in: 3599 }));
    };
    const provider = createCachedGoogleAccessToken(
      () => Promise.resolve({ clientId: 'cid', refreshToken: 'rt' }),
      { fetch, now: () => 1_000 },
    );
    await expect(provider()).resolves.toBeUndefined();
    await expect(provider()).resolves.toBe('ok');
  });
});
