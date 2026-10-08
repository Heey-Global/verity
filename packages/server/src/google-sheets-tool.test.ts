import { describe, expect, it, vi } from 'vitest';

import { createGoogleSheetsTool } from './google-sheets-tool.js';
import type { GoogleWorkspaceToolStore } from './google-workspace-tool-types.js';

const file = {
  assignmentId: 'a1',
  fileId: 'sheet1',
  kind: 'sheets' as const,
  revisionId: 'r1',
};
const input = { projectId: 'p1', sessionId: 's1', turnId: 't1', invocationId: 'i1' };

function setup(overrides: Partial<GoogleWorkspaceToolStore> = {}) {
  const eventStore: GoogleWorkspaceToolStore = {
    getSession: vi.fn().mockResolvedValue({ projectId: 'p1' }),
    getSessionWorkspaceFile: vi.fn().mockResolvedValue(file),
    updateSessionWorkspaceRevision: vi.fn().mockResolvedValue(true),
    claimGoogleWorkspaceInvocation: vi.fn().mockResolvedValue({ status: 'claimed' }),
    completeGoogleWorkspaceInvocation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const sheets = {
    inspect: vi.fn().mockResolvedValue({ title: 'Sheet' }),
    read: vi.fn().mockResolvedValue({ values: [] }),
    write: vi.fn().mockResolvedValue({ updatedCells: 1 }),
    clear: vi.fn().mockResolvedValue({}),
    structuralUpdate: vi.fn().mockResolvedValue({ replies: [] }),
  };
  return {
    eventStore,
    sheets,
    tool: createGoogleSheetsTool({ eventStore, sheets, googleAccessToken: async () => 'token' }),
  };
}

describe('Google Sheets session tool', () => {
  it('requires an explicit bounded A1 range', async () => {
    const { tool, sheets } = setup();
    await expect(
      tool.invoke({ ...input, request: { action: 'read_range', range: 'Sheet1!A:A' } }),
    ).rejects.toThrow('bounded A1 range');
    await expect(
      tool.invoke({ ...input, request: { action: 'read_range', range: 'Sheet1!A1:Z1000' } }),
    ).rejects.toThrow('10,000 cells');
    expect(sheets.read).not.toHaveBeenCalled();
  });

  it('accepts escaped apostrophes in quoted sheet names', async () => {
    const { tool, sheets } = setup();

    await expect(
      tool.invoke({ ...input, request: { action: 'read_range', range: "'O''Brien'!A1:B2" } }),
    ).resolves.toEqual({ values: [] });
    expect(sheets.read).toHaveBeenCalledWith('token', 'sheet1', "'O''Brien'!A1:B2");
  });

  it('bounds values and permits a fixed-range write without a revision', async () => {
    const { tool, sheets } = setup();
    await expect(
      tool.invoke({
        ...input,
        request: { action: 'write_range', range: 'Sheet1!A1:B1', values: [[1, 2]] },
      }),
    ).resolves.toEqual({ result: { updatedCells: 1 } });
    expect(sheets.write).toHaveBeenCalledWith('token', 'sheet1', 'Sheet1!A1:B1', [[1, 2]]);
  });

  it('fences structural edits by invocation', async () => {
    const { tool, sheets } = setup();
    await expect(
      tool.invoke({
        ...input,
        request: {
          action: 'structural_edit',
          requests: [{ addSheet: { properties: { title: 'New' } } }],
        },
      }),
    ).resolves.toEqual({ result: { replies: [] } });
    expect(sheets.structuralUpdate).toHaveBeenCalledOnce();
  });

  it('passes any single-operation Google Sheets request through', async () => {
    const { tool, sheets } = setup();
    const request = { addChart: { chart: { spec: {}, position: {} } } };
    await expect(
      tool.invoke({
        ...input,
        request: { action: 'structural_edit', requests: [request] },
      }),
    ).resolves.toEqual({ result: { replies: [] } });
    expect(sheets.structuralUpdate).toHaveBeenCalledWith('token', 'sheet1', [request]);
  });

  it('allows structural operations to affect more than the direct value-transfer limit', async () => {
    const { tool, sheets } = setup();
    const request = {
      sortRange: {
        range: {
          sheetId: 0,
          startRowIndex: 0,
          endRowIndex: 100_000,
          startColumnIndex: 0,
          endColumnIndex: 30,
        },
        sortSpecs: [{ dimensionIndex: 0, sortOrder: 'ASCENDING' }],
      },
    };

    await expect(
      tool.invoke({
        ...input,
        request: { action: 'structural_edit', requests: [request] },
      }),
    ).resolves.toEqual({ result: { replies: [] } });
    expect(sheets.structuralUpdate).toHaveBeenCalledWith('token', 'sheet1', [request]);
  });

  it('rejects malformed Sheets request envelopes before calling Google', async () => {
    const { tool, sheets } = setup();

    await expect(
      tool.invoke({
        ...input,
        request: {
          action: 'structural_edit',
          requests: [{ addSheet: {}, deleteSheet: {} }],
        },
      }),
    ).rejects.toThrow('one Google request operation per entry');
    expect(sheets.structuralUpdate).not.toHaveBeenCalled();
  });

  it('accepts bounded auto-resize dimensions', async () => {
    const { tool, sheets } = setup();
    const request = {
      autoResizeDimensions: {
        dimensions: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: 4 },
      },
    };

    await expect(
      tool.invoke({
        ...input,
        request: { action: 'structural_edit', requests: [request] },
      }),
    ).resolves.toEqual({ result: { replies: [] } });
    expect(sheets.structuralUpdate).toHaveBeenCalledWith('token', 'sheet1', [request]);
  });

  it('sets and clears a basic filter on a bounded sheet range', async () => {
    const { tool, sheets } = setup();
    const setFilter = {
      setBasicFilter: {
        filter: {
          range: {
            sheetId: 0,
            startRowIndex: 0,
            endRowIndex: 28,
            startColumnIndex: 0,
            endColumnIndex: 31,
          },
        },
      },
    };
    const clearFilter = { clearBasicFilter: { sheetId: 0 } };

    await expect(
      tool.invoke({
        ...input,
        request: { action: 'structural_edit', requests: [setFilter, clearFilter] },
      }),
    ).resolves.toEqual({ result: { replies: [] } });
    expect(sheets.structuralUpdate).toHaveBeenCalledWith('token', 'sheet1', [
      setFilter,
      clearFilter,
    ]);
  });

  it('rechecks assignment and kind after claiming a write', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(file)
      .mockResolvedValueOnce(file)
      .mockResolvedValueOnce({ ...file, kind: 'docs' });
    const { tool, sheets } = setup({ getSessionWorkspaceFile: get });
    await expect(
      tool.invoke({ ...input, request: { action: 'clear_range', range: 'Sheet1!A1:B2' } }),
    ).rejects.toThrow('changed before the operation was sent');
    expect(sheets.clear).not.toHaveBeenCalled();
  });
});

it('keeps native spreadsheet reads but refuses edits in a read-only Drive project', async () => {
  const { tool, sheets } = setup({
    getProjectSettings: vi
      .fn()
      .mockResolvedValue({ googleDriveFolderId: 'root', googleDriveAccessMode: 'read-only' }),
  });
  await tool.invoke({ ...input, request: { action: 'read_range', range: 'Sheet1!A1:A2' } });
  await expect(
    tool.invoke({
      ...input,
      request: { action: 'write_range', range: 'Sheet1!A1:A2', values: [['new']] },
    }),
  ).rejects.toThrow('read-only');
  expect(sheets.write).not.toHaveBeenCalled();
});
