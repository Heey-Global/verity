import { describe, expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';

import { createGoogleSlidesTool } from './google-slides-tool.js';
import { isRichMcpToolResult } from './mcp-tool-result.js';

const attachmentId = 'a'.repeat(64);
const png = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
]);

function store(overrides: Record<string, unknown> = {}): EventStore {
  return {
    listGoogleSlideImageCleanups: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1', projectId: 'project-1' }),
    getSessionSlideDeck: vi.fn().mockResolvedValue({
      sessionId: 'session-1',
      assignmentId: 'assignment-1',
      fileId: 'deck-1',
      name: 'Deck',
      webViewLink: 'https://docs.google.com/presentation/d/deck-1/edit',
      revisionId: 'rev-1',
      assignedAt: new Date(),
    }),
    getEvents: vi
      .fn()
      .mockResolvedValue([
        { t: 'prompt', text: '', attachments: [{ id: attachmentId, mediaType: 'image/png' }] },
      ]),
    getAttachment: vi.fn().mockResolvedValue({ mediaType: 'image/png', bytes: png }),
    createGoogleSlideImageCleanup: vi.fn().mockResolvedValue(undefined),
    setGoogleSlideImageCleanupPermission: vi.fn().mockResolvedValue(undefined),
    markGoogleSlideImageCleanupReady: vi.fn().mockResolvedValue(undefined),
    completeGoogleSlideImageCleanup: vi.fn().mockResolvedValue(undefined),
    failGoogleSlideImageCleanup: vi.fn().mockResolvedValue(undefined),
    updateSessionSlideDeckRevision: vi.fn().mockResolvedValue(true),
    claimGoogleSlideInvocation: vi.fn().mockResolvedValue({ status: 'claimed' }),
    completeGoogleSlideInvocation: vi.fn().mockResolvedValue(undefined),
    pruneGoogleSlideInvocations: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as EventStore;
}

function dependencies(eventStore: EventStore) {
  const drive = {
    upload: vi.fn().mockResolvedValue({ id: 'image-1' }),
    share: vi.fn().mockResolvedValue('permission-1'),
    deletePermission: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  };
  const slides = {
    presentation: vi.fn().mockResolvedValue({
      presentationId: 'deck-1',
      title: 'Deck',
      revisionId: 'rev-2',
      slideIds: ['slide-1'],
    }),
    page: vi.fn().mockResolvedValue({ objectId: 'slide-1' }),
    thumbnail: vi
      .fn()
      .mockResolvedValue({ contentUrl: 'https://example.test/thumb', width: 800, height: 450 }),
    update: vi.fn().mockResolvedValue({
      replies: [],
      writeControl: { requiredRevisionId: 'rev-2' },
    }),
  };
  const created = createGoogleSlidesTool({
    eventStore,
    googleAccessToken: vi.fn().mockResolvedValue('token'),
    cleanupIntervalMs: 2_147_483_647,
    nowId: () => 'cleanup-1',
    fetch: vi
      .fn()
      .mockResolvedValue(
        new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
      ),
    drive,
    slides,
  });
  const tool = {
    ...created,
    invoke: (input: { projectId: string; sessionId: string; request: unknown }) =>
      created.invoke({ ...input, turnId: 'turn-1', invocationId: 'invocation-1' }),
  };
  return { tool, drive, slides };
}

describe('Google Slides agent tool', () => {
  it('refuses a session without an assigned deck', async () => {
    const eventStore = store({ getSessionSlideDeck: vi.fn().mockResolvedValue(undefined) });
    const { tool } = dependencies(eventStore);
    await expect(
      tool.invoke({
        projectId: 'project-1',
        sessionId: 'session-1',
        request: { action: 'inspect_deck' },
      }),
    ).rejects.toThrow('No Google Slides deck is assigned');
    tool.close();
  });

  it('does not dispatch a read after its deck assignment is removed', async () => {
    const deck = {
      sessionId: 'session-1',
      assignmentId: 'assignment-1',
      fileId: 'deck-1',
      name: 'Deck',
      webViewLink: 'https://docs.google.com/presentation/d/deck-1/edit',
      revisionId: 'rev-1',
      assignedAt: new Date(),
    };
    const eventStore = store({
      getSessionSlideDeck: vi.fn().mockResolvedValueOnce(deck).mockResolvedValue(undefined),
    });
    const { tool, slides } = dependencies(eventStore);
    await expect(
      tool.invoke({
        projectId: 'project-1',
        sessionId: 'session-1',
        request: { action: 'inspect_deck' },
      }),
    ).rejects.toThrow('deck changed before the operation was sent');
    expect(slides.presentation).not.toHaveBeenCalled();
    tool.close();
  });

  it('returns a requested thumbnail as rich MCP image content', async () => {
    const eventStore = store();
    const { tool } = dependencies(eventStore);
    const result = await tool.invoke({
      projectId: 'project-1',
      sessionId: 'session-1',
      request: { action: 'thumbnail', slideId: 'slide-1' },
    });
    expect(isRichMcpToolResult(result)).toBe(true);
    if (!isRichMcpToolResult(result)) throw new Error('expected a rich MCP result');
    expect(result.content).toEqual([
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: '{"width":800,"height":450}' },
    ]);
    tool.close();
  });

  it('records cleanup before sharing and removes the temporary image', async () => {
    const calls: string[] = [];
    const persistRevision = vi.fn().mockResolvedValue(true);
    const eventStore = store({
      createGoogleSlideImageCleanup: vi.fn().mockImplementation(() => calls.push('record')),
      setGoogleSlideImageCleanupPermission: vi
        .fn()
        .mockImplementation(() => calls.push('permission')),
      completeGoogleSlideImageCleanup: vi.fn().mockImplementation(() => calls.push('complete')),
      markGoogleSlideImageCleanupReady: vi.fn().mockImplementation(async () => {
        calls.push('ready');
      }),
      updateSessionSlideDeckRevision: persistRevision,
    });
    const { tool, drive, slides } = dependencies(eventStore);
    drive.share.mockImplementation(async () => {
      calls.push('share');
      return 'permission-1';
    });
    drive.deletePermission.mockImplementation(async () => {
      calls.push('revoke');
    });
    drive.deleteFile.mockImplementation(async () => {
      calls.push('delete');
    });

    await tool.invoke({
      projectId: 'project-1',
      sessionId: 'session-1',
      request: { action: 'insert_image', slideId: 'slide-1', attachmentId },
    });

    expect(calls).toEqual([
      'record',
      'share',
      'permission',
      'ready',
      'revoke',
      'delete',
      'complete',
    ]);
    expect(slides.update).toHaveBeenCalledWith(
      'token',
      'deck-1',
      [expect.objectContaining({ createImage: expect.any(Object) })],
      undefined,
    );
    expect(persistRevision).toHaveBeenCalledWith('session-1', 'assignment-1', 'rev-2');
    tool.close();
  });

  it('deletes an upload immediately when its durable cleanup record cannot be created', async () => {
    const eventStore = store({
      createGoogleSlideImageCleanup: vi.fn().mockRejectedValue(new Error('database unavailable')),
    });
    const { tool, drive } = dependencies(eventStore);
    await expect(
      tool.invoke({
        projectId: 'project-1',
        sessionId: 'session-1',
        request: { action: 'insert_image', slideId: 'slide-1', attachmentId },
      }),
    ).rejects.toThrow('database unavailable');
    expect(drive.deleteFile).toHaveBeenCalledWith('token', 'image-1');
    expect(drive.share).not.toHaveBeenCalled();
    tool.close();
  });

  it('keeps and increments a cleanup row when recovery cannot delete its file', async () => {
    const fail = vi.fn().mockResolvedValue(undefined);
    const eventStore = store({
      listGoogleSlideImageCleanups: vi.fn().mockResolvedValue([
        {
          id: 'cleanup-1',
          sessionId: 'session-1',
          fileId: 'image-1',
          permissionId: 'permission-1',
          attempts: 0,
          lastError: null,
          createdAt: new Date(),
        },
      ]),
      failGoogleSlideImageCleanup: fail,
    });
    const { tool, drive } = dependencies(eventStore);
    drive.deleteFile.mockRejectedValue(new Error('Drive unavailable'));
    await tool.recover();
    expect(drive.deletePermission).toHaveBeenCalledWith('token', 'image-1', 'permission-1');
    expect(fail).toHaveBeenCalledWith('cleanup-1', 'Drive unavailable');
    tool.close();
  });

  it('rejects attachments that do not belong to the calling session', async () => {
    const eventStore = store({ getEvents: vi.fn().mockResolvedValue([]) });
    const { tool, drive } = dependencies(eventStore);
    await expect(
      tool.invoke({
        projectId: 'project-1',
        sessionId: 'session-1',
        request: { action: 'insert_image', slideId: 'slide-1', attachmentId },
      }),
    ).rejects.toThrow('only an attachment from this session');
    expect(drive.upload).not.toHaveBeenCalled();
    tool.close();
  });

  it('does not restore an assignment cleared while an edit is in flight', async () => {
    let assigned:
      | {
          sessionId: string;
          assignmentId: string;
          fileId: string;
          name: string;
          webViewLink: string;
          revisionId: string;
          assignedAt: Date;
        }
      | undefined = {
      sessionId: 'session-1',
      assignmentId: 'assignment-1',
      fileId: 'deck-1',
      name: 'Deck',
      webViewLink: 'https://docs.google.com/presentation/d/deck-1/edit',
      revisionId: 'rev-1',
      assignedAt: new Date(),
    };
    const updateRevision = vi.fn(
      async (_sessionId: string, assignmentId: string, revisionId: string): Promise<boolean> => {
        if (assigned?.assignmentId !== assignmentId) return false;
        assigned = { ...assigned, revisionId };
        return true;
      },
    );
    const eventStore = store({
      getSessionSlideDeck: vi.fn(async () => assigned),
      updateSessionSlideDeckRevision: updateRevision,
    });
    const { tool, slides } = dependencies(eventStore);
    slides.update.mockImplementation(async () => {
      assigned = undefined;
      return { replies: [], writeControl: { requiredRevisionId: 'rev-2' } };
    });

    await tool.invoke({
      projectId: 'project-1',
      sessionId: 'session-1',
      request: { action: 'edit', requests: [{ createShape: { shapeType: 'TEXT_BOX' } }] },
    });

    expect(updateRevision).toHaveBeenCalledWith('session-1', 'assignment-1', 'rev-2');
    expect(assigned).toBeUndefined();
    tool.close();
  });

  it('does not dispatch an image edit after its deck assignment is removed', async () => {
    const deck = {
      sessionId: 'session-1',
      assignmentId: 'assignment-1',
      fileId: 'deck-1',
      name: 'Deck',
      webViewLink: 'https://docs.google.com/presentation/d/deck-1/edit',
      revisionId: 'rev-1',
      assignedAt: new Date(),
    };
    const eventStore = store({
      getSessionSlideDeck: vi.fn().mockResolvedValueOnce(deck).mockResolvedValue(undefined),
    });
    const { tool, drive, slides } = dependencies(eventStore);

    await expect(
      tool.invoke({
        projectId: 'project-1',
        sessionId: 'session-1',
        request: { action: 'insert_image', slideId: 'slide-1', attachmentId },
      }),
    ).rejects.toThrow('deck changed before the operation was sent');

    expect(drive.share).toHaveBeenCalledOnce();
    expect(slides.update).not.toHaveBeenCalled();
    expect(drive.deletePermission).toHaveBeenCalledOnce();
    expect(drive.deleteFile).toHaveBeenCalledOnce();
    tool.close();
  });

  it('returns the stored result when a mutation invocation is replayed', async () => {
    const claim = vi
      .fn()
      .mockResolvedValueOnce({ status: 'claimed' })
      .mockResolvedValueOnce({
        status: 'completed',
        result: {
          result: { replies: [], writeControl: { requiredRevisionId: 'rev-2' } },
          revisionId: 'rev-2',
        },
      });
    const complete = vi.fn().mockResolvedValue(undefined);
    const eventStore = store({
      claimGoogleSlideInvocation: claim,
      completeGoogleSlideInvocation: complete,
    });
    const { tool, slides } = dependencies(eventStore);
    const input = {
      projectId: 'project-1',
      sessionId: 'session-1',
      request: { action: 'edit' as const, requests: [{ createShape: { shapeType: 'TEXT_BOX' } }] },
    };

    const first = await tool.invoke(input);
    const replay = await tool.invoke(input);

    expect(replay).toEqual(first);
    expect(slides.update).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    tool.close();
  });

  it('revalidates the assignment after claiming a mutation invocation', async () => {
    const deck = {
      sessionId: 'session-1',
      assignmentId: 'assignment-1',
      fileId: 'deck-1',
      name: 'Deck',
      webViewLink: 'https://docs.google.com/presentation/d/deck-1/edit',
      revisionId: 'rev-1',
      assignedAt: new Date(),
    };
    let assigned = true;
    const eventStore = store({
      getSessionSlideDeck: vi.fn(async () => (assigned ? deck : undefined)),
      claimGoogleSlideInvocation: vi.fn(async () => {
        assigned = false;
        return { status: 'claimed' as const };
      }),
    });
    const { tool, slides } = dependencies(eventStore);

    await expect(
      tool.invoke({
        projectId: 'project-1',
        sessionId: 'session-1',
        request: { action: 'edit', requests: [{ createShape: { shapeType: 'TEXT_BOX' } }] },
      }),
    ).rejects.toThrow('deck changed before the operation was sent');
    expect(slides.update).not.toHaveBeenCalled();
    tool.close();
  });
});
