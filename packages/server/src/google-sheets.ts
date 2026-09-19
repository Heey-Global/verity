import { googleWorkspaceHttpReason } from './google-workspace-errors.js';
import type { GoogleFetch, GoogleTransportOptions } from './google-drive.js';

const GOOGLE_SHEETS_API = 'https://sheets.googleapis.com/v4';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RANGE_BYTES = 1_000_000;

export class GoogleSheetsError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'GoogleSheetsError';
  }
}

export interface SheetsSpreadsheetSummary {
  spreadsheetId: string;
  title: string;
  sheets: { sheetId: number; title: string; index: number }[];
}

export interface SheetsValueRange {
  range: string;
  majorDimension?: string;
  values?: unknown[][];
}

async function sheetsRequest(
  accessToken: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
  opts: GoogleTransportOptions = {},
): Promise<unknown> {
  const doFetch: GoogleFetch = opts.fetch ?? fetch;
  let response;
  try {
    response = await doFetch(`${GOOGLE_SHEETS_API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleSheetsError('could not reach Google Sheets', 'network');
  }
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new GoogleSheetsError(
      `Google Sheets returned an unexpected status (${String(response.status)})`,
      googleWorkspaceHttpReason(response.status, payload),
    );
  }
  return payload;
}

export async function getSheetsSpreadsheet(
  accessToken: string,
  spreadsheetId: string,
  opts: GoogleTransportOptions = {},
): Promise<SheetsSpreadsheetSummary> {
  const payload = (await sheetsRequest(
    accessToken,
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}?includeGridData=false&fields=spreadsheetId,properties.title,sheets.properties(sheetId,title,index)`,
    {},
    opts,
  )) as {
    spreadsheetId?: unknown;
    properties?: { title?: unknown };
    sheets?: { properties?: { sheetId?: unknown; title?: unknown; index?: unknown } }[];
  };
  if (typeof payload.spreadsheetId !== 'string' || typeof payload.properties?.title !== 'string') {
    throw new GoogleSheetsError(
      'Google Sheets returned malformed spreadsheet metadata',
      'malformed',
    );
  }
  const sheets = (payload.sheets ?? []).flatMap(({ properties }) =>
    typeof properties?.sheetId === 'number' &&
    typeof properties.title === 'string' &&
    typeof properties.index === 'number'
      ? [{ sheetId: properties.sheetId, title: properties.title, index: properties.index }]
      : [],
  );
  return { spreadsheetId: payload.spreadsheetId, title: payload.properties.title, sheets };
}

export async function getSheetsValues(
  accessToken: string,
  spreadsheetId: string,
  range: string,
  opts: GoogleTransportOptions = {},
): Promise<SheetsValueRange> {
  const payload = (await sheetsRequest(
    accessToken,
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
    {},
    opts,
  )) as { range?: unknown; majorDimension?: unknown; values?: unknown };
  if (
    typeof payload.range !== 'string' ||
    (payload.values !== undefined && !Array.isArray(payload.values))
  ) {
    throw new GoogleSheetsError('Google Sheets returned malformed range data', 'malformed');
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_RANGE_BYTES) {
    throw new GoogleSheetsError('Google Sheets range exceeds the 1 MB read limit', 'too_large');
  }
  return {
    range: payload.range,
    ...(typeof payload.majorDimension === 'string'
      ? { majorDimension: payload.majorDimension }
      : {}),
    ...(Array.isArray(payload.values) ? { values: payload.values as unknown[][] } : {}),
  };
}

export async function updateSheetsValues(
  accessToken: string,
  spreadsheetId: string,
  range: string,
  values: readonly (readonly unknown[])[],
  opts: GoogleTransportOptions = {},
): Promise<unknown> {
  return sheetsRequest(
    accessToken,
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: { range, majorDimension: 'ROWS', values } },
    opts,
  );
}

export async function clearSheetsValues(
  accessToken: string,
  spreadsheetId: string,
  range: string,
  opts: GoogleTransportOptions = {},
): Promise<unknown> {
  return sheetsRequest(
    accessToken,
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:clear`,
    { method: 'POST', body: {} },
    opts,
  );
}

export async function updateSheetsSpreadsheet(
  accessToken: string,
  spreadsheetId: string,
  requests: readonly unknown[],
  opts: GoogleTransportOptions = {},
): Promise<unknown> {
  return sheetsRequest(
    accessToken,
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    { method: 'POST', body: { requests } },
    opts,
  );
}

const SUPPORTED_STRUCTURAL_REQUESTS = new Set([
  'addSheet',
  'deleteSheet',
  'duplicateSheet',
  'updateSheetProperties',
  'insertDimension',
  'deleteDimension',
  'appendDimension',
  'moveDimension',
  'autoResizeDimensions',
  'sortRange',
]);

export function sheetsRequestsAreSupported(requests: readonly Record<string, unknown>[]): boolean {
  return requests.every((request) => {
    const keys = Object.keys(request);
    return keys.length === 1 && SUPPORTED_STRUCTURAL_REQUESTS.has(keys[0] ?? '');
  });
}
