import { describe, expect, it, vi } from 'vitest';

import { createGoogleDocsTool } from './google-docs-tool.js';
import type { GoogleWorkspaceToolStore } from './google-workspace-tool-types.js';

const file = { assignmentId: 'a1', fileId: 'doc1', kind: 'docs' as const, revisionId: 'r1' };
const input = { projectId: 'p1', sessionId: 's1', turnId: 't1', invocationId: 'i1' };

function setup(overrides: Partial<GoogleWorkspaceToolStore> = {}) {
  const updateSessionWorkspaceRevision = vi.fn().mockResolvedValue(true);
  const completeGoogleWorkspaceInvocation = vi.fn().mockResolvedValue(undefined);
  const eventStore: GoogleWorkspaceToolStore = {
    getSession: vi.fn().mockResolvedValue({ projectId: 'p1' }),
    getSessionWorkspaceFile: vi.fn().mockResolvedValue(file),
    updateSessionWorkspaceRevision,
    claimGoogleWorkspaceInvocation: vi.fn().mockResolvedValue({ status: 'claimed' }),
    completeGoogleWorkspaceInvocation,
    ...overrides,
  };
  const docs = {
    inspect: vi.fn().mockResolvedValue({ title: 'Doc', revisionId: 'r1' }),
    read: vi.fn().mockResolvedValue({ body: {}, revisionId: 'r1' }),
    update: vi.fn().mockResolvedValue({ revisionId: 'r2', result: { replies: [] } }),
  };
  return {
    eventStore,
    docs,
    updateSessionWorkspaceRevision,
    completeGoogleWorkspaceInvocation,
    tool: createGoogleDocsTool({ eventStore, docs, googleAccessToken: async () => 'token' }),
  };
}

describe('Google Docs session tool', () => {
  it('restricts access to the calling project', async () => {
    const { tool, docs } = setup({ getSession: vi.fn().mockResolvedValue({ projectId: 'other' }) });
    await expect(
      tool.invoke({ ...input, request: { action: 'inspect_document' } }),
    ).rejects.toThrow('restricted to the calling session');
    expect(docs.inspect).not.toHaveBeenCalled();
  });

  it('requires a revision and rejects unallowlisted Docs requests', async () => {
    const { tool, docs } = setup();
    await expect(
      tool.invoke({
        ...input,
        request: {
          action: 'edit',
          requests: [{ insertText: { text: 'x', location: { index: 1, tabId: 'tab-1' } } }],
        },
      }),
    ).rejects.toThrow('requires revisionId');
    await expect(
      tool.invoke({
        ...input,
        request: { action: 'edit', revisionId: 'r1', requests: [{ createHeader: {} }] },
      }),
    ).rejects.toThrow('unsupported request');
    expect(docs.update).not.toHaveBeenCalled();
  });

  it('requires every edit to name the inspected tab', async () => {
    const { tool, docs } = setup();

    await expect(
      tool.invoke({
        ...input,
        request: {
          action: 'edit',
          revisionId: 'r1',
          requests: [{ replaceAllText: { containsText: { text: 'a' }, replaceText: 'b' } }],
        },
      }),
    ).rejects.toThrow('tabsCriteria.tabIds');
    await expect(
      tool.invoke({
        ...input,
        request: {
          action: 'edit',
          revisionId: 'r1',
          requests: [{ insertText: { text: 'x', location: { index: 1 } } }],
        },
      }),
    ).rejects.toThrow('explicit tabId');
    expect(docs.update).not.toHaveBeenCalled();
  });

  it('persists the revision observed by a fresh document read', async () => {
    const { tool, updateSessionWorkspaceRevision } = setup();

    await expect(
      tool.invoke({ ...input, request: { action: 'read_document' } }),
    ).resolves.toMatchObject({ revisionId: 'r1' });
    expect(updateSessionWorkspaceRevision).toHaveBeenCalledWith('s1', 'a1', 'r1');
  });

  it('rechecks the assigned file after claiming a write', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(file)
      .mockResolvedValueOnce(file)
      .mockResolvedValueOnce({ ...file, assignmentId: 'a2' });
    const { tool, docs } = setup({ getSessionWorkspaceFile: get });
    await expect(
      tool.invoke({
        ...input,
        request: {
          action: 'edit',
          revisionId: 'r1',
          requests: [{ insertText: { text: 'x', location: { index: 1, tabId: 'tab-1' } } }],
        },
      }),
    ).rejects.toThrow('changed before the operation was sent');
    expect(docs.update).not.toHaveBeenCalled();
  });

  it('persists the resulting revision and invocation result', async () => {
    const { tool, docs, updateSessionWorkspaceRevision, completeGoogleWorkspaceInvocation } =
      setup();
    await expect(
      tool.invoke({
        ...input,
        request: {
          action: 'edit',
          revisionId: 'r1',
          requests: [
            {
              replaceAllText: {
                containsText: { text: 'a' },
                replaceText: 'b',
                tabsCriteria: { tabIds: ['tab-1'] },
              },
            },
          ],
        },
      }),
    ).resolves.toEqual({ result: { replies: [] }, revisionId: 'r2' });
    expect(docs.update).toHaveBeenCalledWith('token', 'doc1', expect.any(Array), 'r1');
    expect(updateSessionWorkspaceRevision).toHaveBeenCalledWith('s1', 'a1', 'r2');
    expect(completeGoogleWorkspaceInvocation).toHaveBeenCalledWith(
      'i1',
      expect.objectContaining({ revisionId: 'r2' }),
    );
  });

  it('replays a completed edit before comparing its original revision', async () => {
    const completed = { result: { replies: [] }, revisionId: 'r2' };
    const { tool, docs } = setup({
      getSessionWorkspaceFile: vi.fn().mockResolvedValue({ ...file, revisionId: 'r2' }),
      claimGoogleWorkspaceInvocation: vi.fn().mockResolvedValue({
        status: 'completed',
        result: completed,
      }),
    });

    await expect(
      tool.invoke({
        ...input,
        request: {
          action: 'edit',
          revisionId: 'r1',
          requests: [{ insertText: { text: 'x', location: { index: 1, tabId: 'tab-1' } } }],
        },
      }),
    ).resolves.toEqual(completed);
    expect(docs.update).not.toHaveBeenCalled();
  });
});
