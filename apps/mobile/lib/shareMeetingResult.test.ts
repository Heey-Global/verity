import { shareMeetingResult } from './shareMeetingResult';
import { createVerityClient } from './client';
import { loadPrintModule, loadSharingModule } from './sessionFileUi';

const mockWrite = jest.fn();
jest.mock('expo-file-system', () => ({
  File: jest.fn().mockImplementation(() => ({ uri: 'file:///meeting.md', write: mockWrite })),
  Paths: { cache: 'file:///cache' },
}));
jest.mock('./client', () => ({ createVerityClient: jest.fn() }));
jest.mock('./sessionFileUi', () => ({ loadPrintModule: jest.fn(), loadSharingModule: jest.fn() }));
it('shares the filed Markdown and renders PDF from that same source', async () => {
  const shareAsync = jest.fn();
  const printToFileAsync = jest.fn().mockResolvedValue({ uri: 'file:///meeting.pdf' });
  jest
    .mocked(loadSharingModule)
    .mockResolvedValue({ isAvailableAsync: async () => true, shareAsync } as unknown as NonNullable<
      Awaited<ReturnType<typeof loadSharingModule>>
    >);
  jest
    .mocked(loadPrintModule)
    .mockResolvedValue({ printToFileAsync } as unknown as NonNullable<
      Awaited<ReturnType<typeof loadPrintModule>>
    >);
  const getSessionFileContent = jest
    .fn()
    .mockResolvedValue({ path: 'meetings/m.md', content: '# Result\n\nAgreed.' });
  const getHistory = jest.fn().mockResolvedValue({
    hasMore: false,
    events: [
      {
        seq: 1,
        event: {
          t: 'notice',
          text: 'Meeting saved to the knowledge base: [Result](/knowledge/meetings/m.md)\n<!-- verity-meeting: {"sessionId":"s","meetingId":"m"} -->',
        },
      },
    ],
  });
  jest
    .mocked(createVerityClient)
    .mockReturnValue({ getHistory, getSessionFileContent } as unknown as NonNullable<
      ReturnType<typeof createVerityClient>
    >);
  await shareMeetingResult('s', 'm', 'markdown');
  expect(getSessionFileContent).toHaveBeenCalledWith('s', 'meetings/m.md', 'knowledge');
  expect(mockWrite).toHaveBeenCalledWith('# Result\n\nAgreed.');
  expect(shareAsync).toHaveBeenCalledWith(
    'file:///meeting.md',
    expect.objectContaining({ mimeType: 'text/markdown' }),
  );
  await shareMeetingResult('s', 'm', 'pdf');
  expect(printToFileAsync).toHaveBeenCalledWith({ html: expect.stringContaining('Agreed.') });
  expect(shareAsync).toHaveBeenLastCalledWith(
    'file:///meeting.pdf',
    expect.objectContaining({ mimeType: 'application/pdf' }),
  );
});
