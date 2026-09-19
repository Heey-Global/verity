import type {
  GoogleWorkspaceToolStore,
  SessionWorkspaceFile,
  WorkspaceInvocationInput,
} from './google-workspace-tool-types.js';
import {
  clearSheetsValues,
  getSheetsSpreadsheet,
  getSheetsValues,
  sheetsRequestsAreSupported,
  updateSheetsSpreadsheet,
  updateSheetsValues,
} from './google-sheets.js';

const MAX_CELLS = 10_000;
const MAX_VALUE_BYTES = 1_000_000;
const MAX_STRUCTURAL_REQUESTS = 50;
const BOUNDED_A1_RANGE =
  /^(?:'(?:[^']|''){1,200}'|[^'!]{1,100})!([A-Z]{1,3})([1-9][0-9]{0,6}):([A-Z]{1,3})([1-9][0-9]{0,6})$/;
type SheetsRequest = {
  action: 'inspect_spreadsheet' | 'read_range' | 'write_range' | 'clear_range' | 'structural_edit';
  range?: string;
  values?: unknown[][];
  requests?: Record<string, unknown>[];
};

export interface GoogleSheetsToolDeps {
  eventStore: GoogleWorkspaceToolStore;
  googleAccessToken: () => Promise<string | undefined>;
  sheets?: {
    inspect(token: string, fileId: string): Promise<unknown>;
    read(token: string, fileId: string, range: string): Promise<unknown>;
    write(token: string, fileId: string, range: string, values: unknown[][]): Promise<unknown>;
    clear(token: string, fileId: string, range: string): Promise<unknown>;
    structuralUpdate(
      token: string,
      fileId: string,
      requests: readonly Record<string, unknown>[],
    ): Promise<unknown>;
  };
}

function parseRequest(value: unknown): SheetsRequest {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { action?: unknown }).action !== 'string'
  ) {
    throw new Error('Google Sheets request requires an action');
  }
  return value as SheetsRequest;
}

function columnNumber(column: string): number {
  let result = 0;
  for (const char of column) result = result * 26 + char.charCodeAt(0) - 64;
  return result;
}

function validateRange(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 250)
    throw new Error('action requires a bounded A1 range');
  const match = BOUNDED_A1_RANGE.exec(value);
  if (match === null) throw new Error('action requires a bounded A1 range');
  const columns = columnNumber(match[3]!) - columnNumber(match[1]!) + 1;
  const rows = Number(match[4]) - Number(match[2]) + 1;
  if (columns <= 0 || rows <= 0 || columns * rows > MAX_CELLS) {
    throw new Error('range exceeds 10,000 cells');
  }
}

function validateValues(values: unknown): asserts values is unknown[][] {
  if (!Array.isArray(values) || values.length === 0 || values.some((row) => !Array.isArray(row))) {
    throw new Error('action requires a non-empty two-dimensional values array');
  }
  const rows = values as unknown[][];
  const cells = rows.reduce((count, row) => count + row.length, 0);
  if (cells > MAX_CELLS) throw new Error('values exceed 10,000 cells');
  if (Buffer.byteLength(JSON.stringify(values)) > MAX_VALUE_BYTES)
    throw new Error('values exceed 1 MB');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function boundedIndexRange(
  value: unknown,
  startKey: 'startIndex' | 'startRowIndex' | 'startColumnIndex',
  endKey: 'endIndex' | 'endRowIndex' | 'endColumnIndex',
): number | undefined {
  if (!isRecord(value)) return undefined;
  const start = value[startKey];
  const end = value[endKey];
  if (
    typeof start !== 'number' ||
    !Number.isInteger(start) ||
    typeof end !== 'number' ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start
  ) {
    return undefined;
  }
  return end - start;
}

function validateStructuralBounds(kind: string, operation: unknown): void {
  if (!isRecord(operation)) throw new Error('structural_edit contains an unsupported request');
  if (kind === 'sortRange') {
    const range = operation.range;
    if (!isRecord(range) || typeof range.sheetId !== 'number') {
      throw new Error('sortRange requires a bounded grid range');
    }
    const rows = boundedIndexRange(range, 'startRowIndex', 'endRowIndex');
    const columns = boundedIndexRange(range, 'startColumnIndex', 'endColumnIndex');
    if (rows === undefined || columns === undefined || rows * columns > MAX_CELLS) {
      throw new Error('sortRange requires a bounded grid range of at most 10,000 cells');
    }
  }
  if (
    kind === 'insertDimension' ||
    kind === 'deleteDimension' ||
    kind === 'moveDimension' ||
    kind === 'autoResizeDimensions'
  ) {
    const range =
      kind === 'moveDimension'
        ? operation.source
        : kind === 'autoResizeDimensions'
          ? operation.dimensions
          : operation.range;
    const length = boundedIndexRange(range, 'startIndex', 'endIndex');
    if (
      !isRecord(range) ||
      typeof range.sheetId !== 'number' ||
      (range.dimension !== 'ROWS' && range.dimension !== 'COLUMNS') ||
      length === undefined ||
      length > MAX_CELLS
    ) {
      throw new Error(`${kind} requires a bounded dimension range`);
    }
  }
  if (kind === 'appendDimension') {
    const length = operation.length;
    if (
      typeof operation.sheetId !== 'number' ||
      (operation.dimension !== 'ROWS' && operation.dimension !== 'COLUMNS') ||
      typeof length !== 'number' ||
      !Number.isInteger(length) ||
      length <= 0 ||
      length > MAX_CELLS
    ) {
      throw new Error('appendDimension requires a bounded dimension count');
    }
  }
}

function validateStructural(requests: unknown): asserts requests is Record<string, unknown>[] {
  if (!Array.isArray(requests) || requests.length === 0)
    throw new Error('structural_edit requires requests');
  if (requests.length > MAX_STRUCTURAL_REQUESTS)
    throw new Error('structural_edit exceeds 50 requests');
  const candidates: unknown[] = requests;
  const validated: Record<string, unknown>[] = [];
  for (const request of candidates) {
    if (!isRecord(request)) throw new Error('structural_edit contains an unsupported request');
    validated.push(request);
  }
  if (!sheetsRequestsAreSupported(validated)) {
    throw new Error('structural_edit contains an unsupported request');
  }
  for (const request of validated) {
    const keys = Object.keys(request);
    validateStructuralBounds(keys[0]!, request[keys[0]!]);
  }
  if (Buffer.byteLength(JSON.stringify(requests)) > MAX_VALUE_BYTES)
    throw new Error('structural_edit payload exceeds 1 MB');
}

export function createGoogleSheetsTool(deps: GoogleSheetsToolDeps): {
  invoke(input: WorkspaceInvocationInput): Promise<unknown>;
} {
  const sheets = deps.sheets ?? {
    inspect: getSheetsSpreadsheet,
    read: getSheetsValues,
    write: updateSheetsValues,
    clear: clearSheetsValues,
    structuralUpdate: updateSheetsSpreadsheet,
  };
  const assigned = async (
    sessionId: string,
    assignmentId?: string,
  ): Promise<SessionWorkspaceFile> => {
    const file = await deps.eventStore.getSessionWorkspaceFile(sessionId);
    if (
      file === undefined ||
      file.kind !== 'sheets' ||
      (assignmentId !== undefined && file.assignmentId !== assignmentId)
    ) {
      throw new Error(
        assignmentId === undefined
          ? 'No Google Sheets spreadsheet is assigned to this session'
          : 'The assigned Google Sheets spreadsheet changed before the operation was sent',
      );
    }
    return file;
  };

  return {
    async invoke(input) {
      const session = await deps.eventStore.getSession(input.sessionId);
      if (session === undefined || session.projectId !== input.projectId)
        throw new Error('Google Sheets is restricted to the calling session');
      const file = await assigned(input.sessionId);
      const token = await deps.googleAccessToken();
      if (token === undefined) throw new Error('Google Drive is not connected');
      const request = parseRequest(input.request);
      if (request.action === 'inspect_spreadsheet') {
        await assigned(input.sessionId, file.assignmentId);
        return sheets.inspect(token, file.fileId);
      }
      if (request.action === 'read_range') {
        validateRange(request.range);
        await assigned(input.sessionId, file.assignmentId);
        return sheets.read(token, file.fileId, request.range);
      }
      if (!['write_range', 'clear_range', 'structural_edit'].includes(request.action)) {
        throw new Error('Unsupported Google Sheets action');
      }
      if (request.action === 'structural_edit') validateStructural(request.requests);
      else validateRange(request.range);
      if (request.action === 'write_range') validateValues(request.values);
      await assigned(input.sessionId, file.assignmentId);
      const claim = await deps.eventStore.claimGoogleWorkspaceInvocation(input);
      if (claim.status === 'completed') return claim.result;
      if (claim.status === 'pending')
        throw new Error(
          'This Google Sheets edit may already have run; inspect the spreadsheet first',
        );
      await assigned(input.sessionId, file.assignmentId);
      let result: unknown;
      if (request.action === 'write_range')
        result = await sheets.write(token, file.fileId, request.range!, request.values!);
      else if (request.action === 'clear_range')
        result = await sheets.clear(token, file.fileId, request.range!);
      else result = await sheets.structuralUpdate(token, file.fileId, request.requests!);
      const response = { result };
      await deps.eventStore.completeGoogleWorkspaceInvocation(input.invocationId, response);
      return response;
    },
  };
}
