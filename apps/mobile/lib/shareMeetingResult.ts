import { File, Paths } from 'expo-file-system';
import { printableFileHtml } from '@verity/mobile';
import { createVerityClient, getActiveMeetingServerId } from './client';
import { meetingSavedCard } from './meetingSavedCard';
import { loadPrintModule, loadSharingModule } from './sessionFileUi';

export async function shareMeetingResult(
  sessionId: string,
  meetingId: string,
  mode: 'markdown' | 'pdf',
  serverId?: string | null,
): Promise<void> {
  if (serverId && serverId !== getActiveMeetingServerId())
    throw new Error('Reconnect to this meeting’s server to share it.');
  const client = createVerityClient();
  if (!client) throw new Error('Connect to your server to share this meeting.');
  let card: ReturnType<typeof meetingSavedCard> = null;
  let beforeSeq: number | undefined;
  for (;;) {
    const history = await client.getHistory(sessionId, {
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      limit: 200,
    });
    card =
      history.events
        .flatMap(({ event }) => (event.t === 'notice' ? [meetingSavedCard(event.text)] : []))
        .findLast((saved) => saved?.meetingId === meetingId) ?? null;
    if (card || !history.hasMore || !history.events.length) break;
    const next = history.events[0]!.seq;
    if (beforeSeq !== undefined && next >= beforeSeq) break;
    beforeSeq = next;
  }
  if (!card) throw new Error('The meeting has not been filed yet. Please try again.');
  const knowledge = card.link.startsWith('/knowledge/');
  const path = knowledge ? card.link.slice('/knowledge/'.length) : card.link;
  const content = await client.getSessionFileContent(
    sessionId,
    path,
    knowledge ? 'knowledge' : 'worktree',
  );
  const sharing = await loadSharingModule();
  if (!sharing || !(await sharing.isAvailableAsync()))
    throw new Error('Sharing is not available in this build.');
  if (mode === 'pdf') {
    const print = await loadPrintModule();
    if (!print) throw new Error('PDF export is not available in this build.');
    const pdf = await print.printToFileAsync({ html: printableFileHtml(path, content.content) });
    await sharing.shareAsync(pdf.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
  } else {
    const file = new File(Paths.cache, `meeting-${meetingId.replace(/[^a-zA-Z0-9_-]/g, '')}.md`);
    file.write(content.content);
    await sharing.shareAsync(file.uri, {
      mimeType: 'text/markdown',
      UTI: 'net.daringfireball.markdown',
    });
  }
}
