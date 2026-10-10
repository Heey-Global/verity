import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render } from '@testing-library/react-native';
import type { Row } from '@verity/mobile';
import { useContext, type ContextType } from 'react';
import { Text } from 'react-native';
import { KnowledgeSaveContext, KnowledgeSaveProvider } from './KnowledgeSaveProvider';
import { TranscriptRow } from './TranscriptRow';

it('keeps historical consumers idle on unrelated updates and saves through the current session', async () => {
  const client = { saveSessionKnowledge: jest.fn(async () => ['saved.md']) };
  const replacementClient = { saveSessionKnowledge: jest.fn(async () => ['other.md']) };
  const rendered = jest.fn();
  let knowledge: ContextType<typeof KnowledgeSaveContext> = null;
  function HistoricalMessage() {
    knowledge = useContext(KnowledgeSaveContext);
    rendered();
    return <Text>{knowledge ? 'Save available' : 'Save unavailable'}</Text>;
  }
  const item: Row = {
    kind: 'message',
    message: { kind: 'agent-text', id: 'text-1', localId: null, createdAt: 0, text: 'History' },
  };
  const renderContent = () => <HistoricalMessage />;
  const tree = (sessionId = 'session-1', projectId: string | null = 'project-1', api = client) => (
    <KnowledgeSaveProvider client={api} sessionId={sessionId} projectId={projectId}>
      <TranscriptRow item={item} isLatest={false} renderContent={renderContent} />
    </KnowledgeSaveProvider>
  );
  const screen = render(tree());
  const initialRenderCount = rendered.mock.calls.length;
  const initialKnowledge = knowledge;
  // Context propagation bypasses TranscriptRow's memo boundary, so fresh parent
  // renders used to rebuild historical messages even when all row props matched.
  screen.rerender(tree());
  expect(rendered).toHaveBeenCalledTimes(initialRenderCount);
  expect(knowledge).toBe(initialKnowledge);
  const save = async () => {
    expect(knowledge).not.toBeNull();
    await act(async () => {
      await knowledge?.save('text-1', 'History');
    });
  };
  await save();
  expect(client.saveSessionKnowledge).toHaveBeenLastCalledWith('session-1', {
    messageId: 'text-1',
    text: 'History',
  });

  screen.rerender(tree('session-2'));
  await save();
  expect(client.saveSessionKnowledge).toHaveBeenLastCalledWith('session-2', {
    messageId: 'text-1',
    text: 'History',
  });
  screen.rerender(tree('session-2', 'project-2', replacementClient));
  await save();
  expect(replacementClient.saveSessionKnowledge).toHaveBeenCalledWith('session-2', {
    messageId: 'text-1',
    text: 'History',
  });
  screen.rerender(tree('session-2', null, replacementClient));
  expect(screen.getByText('Save unavailable')).toBeTruthy();
  expect(knowledge).toBeNull();
  screen.rerender(tree('session-2', 'project-2', replacementClient));
  expect(screen.getByText('Save available')).toBeTruthy();
});

it('uses the stable provider around the chat list instead of recreating its context inline', () => {
  const source = readFileSync(join(__dirname, '../app/session/[id].tsx'), 'utf8');
  // An isolated provider test would stay green if the chat switched back to its
  // own inline value, silently restoring the expensive context propagation.
  expect(source).toMatch(
    /<KnowledgeSaveProvider\b[^>]*>[\s\S]*?<FlashList\b[\s\S]*?<\/KnowledgeSaveProvider>/,
  );
  expect(source).not.toMatch(/<KnowledgeSaveContext\.Provider\b/);
  expect(source).not.toMatch(/const KnowledgeSaveContext\s*=/);
});
