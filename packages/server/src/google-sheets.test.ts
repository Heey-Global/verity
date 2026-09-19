import { describe, expect, it } from 'vitest';

import type { GoogleFetch, GoogleHttpResponse } from './google-drive.js';
import {
  appendSheetsValues,
  clearSheetsValues,
  getSheetsSpreadsheet,
  getSheetsValues,
  sheetsRequestsAreSupported,
  updateSheetsSpreadsheet,
  updateSheetsValues,
} from './google-sheets.js';

function response(body: unknown, status = 200): GoogleHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

describe('Google Sheets client', () => {
  it('reads only spreadsheet and sheet metadata', async () => {
    let url = '';
    const fetch: GoogleFetch = (requestedUrl) => {
      url = requestedUrl;
      return Promise.resolve(
        response({
          spreadsheetId: 'sheet-1',
          properties: { title: 'Budget' },
          sheets: [{ properties: { sheetId: 12, title: 'September', index: 0 } }],
        }),
      );
    };
    await expect(getSheetsSpreadsheet('token', 'sheet-1', { fetch })).resolves.toEqual({
      spreadsheetId: 'sheet-1',
      title: 'Budget',
      sheets: [{ sheetId: 12, title: 'September', index: 0 }],
    });
    expect(url).toContain('includeGridData=false');
    expect(url).toContain('fields=spreadsheetId,properties.title,sheets.properties');
  });

  it('reads an explicitly encoded range', async () => {
    let url = '';
    const fetch: GoogleFetch = (requestedUrl) => {
      url = requestedUrl;
      return Promise.resolve(response({ range: "'Q3 Plan'!A1:B2", values: [[1, 2]] }));
    };
    await expect(
      getSheetsValues('token', 'sheet-1', "'Q3 Plan'!A1:B2", { fetch }),
    ).resolves.toEqual({
      range: "'Q3 Plan'!A1:B2",
      values: [[1, 2]],
    });
    expect(url).toContain("values/'Q3%20Plan'!A1%3AB2");
  });

  it('refuses range output above the tool limit', async () => {
    const fetch: GoogleFetch = () =>
      Promise.resolve(response({ range: 'Data!A1:A1', values: [['x'.repeat(1_000_000)]] }));

    await expect(
      getSheetsValues('token', 'sheet-1', 'Data!A1:A1', { fetch }),
    ).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('uses the documented values write endpoints and modes', async () => {
    const calls: { url: string; method?: string; body?: string | Buffer }[] = [];
    const fetch: GoogleFetch = (url, init) => {
      calls.push({
        url,
        ...(init?.method === undefined ? {} : { method: init.method }),
        ...(init?.body === undefined ? {} : { body: init.body }),
      });
      return Promise.resolve(response({}));
    };
    await updateSheetsValues('token', 'sheet-1', 'Data!A1', [['x']], { fetch });
    await appendSheetsValues('token', 'sheet-1', 'Data!A:A', [['y']], { fetch });
    await clearSheetsValues('token', 'sheet-1', 'Data!B:B', { fetch });

    expect(calls[0]).toMatchObject({ method: 'PUT' });
    expect(calls[0]?.url).toContain('valueInputOption=USER_ENTERED');
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      range: 'Data!A1',
      majorDimension: 'ROWS',
      values: [['x']],
    });
    expect(calls[1]).toMatchObject({ method: 'POST' });
    expect(calls[1]?.url).toContain(
      ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
    );
    expect(calls[2]).toMatchObject({ method: 'POST', body: '{}' });
    expect(calls[2]?.url).toContain('Data!B%3AB:clear');
  });

  it('limits structural batches to conservative request kinds', async () => {
    expect(sheetsRequestsAreSupported([{ addSheet: {} }, { deleteDimension: {} }])).toBe(true);
    expect(sheetsRequestsAreSupported([{ findReplace: { find: 'secret' } }])).toBe(false);
    expect(sheetsRequestsAreSupported([{ addSheet: {}, deleteSheet: {} }])).toBe(false);

    let body = '';
    const fetch: GoogleFetch = (_url, init) => {
      body = String(init?.body);
      return Promise.resolve(response({ replies: [] }));
    };
    await updateSheetsSpreadsheet('token', 'sheet-1', [{ addSheet: {} }], { fetch });
    expect(JSON.parse(body)).toEqual({ requests: [{ addSheet: {} }] });
  });

  it('redacts upstream error details', async () => {
    const fetch: GoogleFetch = () =>
      Promise.resolve(response({ error: { status: 'INVALID_ARGUMENT', message: 'private' } }, 400));
    await expect(getSheetsValues('token', 'sheet-1', 'A1', { fetch })).rejects.toMatchObject({
      name: 'GoogleSheetsError',
      reason: 'http_400_INVALIDARGUMENT',
    });
  });
});
