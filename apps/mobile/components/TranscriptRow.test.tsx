import type { Row } from '@verity/mobile';
import { render } from '@testing-library/react-native';
import { Text } from 'react-native';
import { TranscriptRow } from './TranscriptRow';

it('skips unchanged rows and renders changed content, latest status and bookmarkability', () => {
  const item: Row = {
    kind: 'message',
    message: { kind: 'agent-text', id: 'text', localId: null, createdAt: 0, text: 'First' },
  };
  const renderContent = jest.fn((row: Row, latest: boolean, bookmarkable: boolean) => (
    <Text>{`${row.kind === 'message' && row.message.kind === 'agent-text' ? row.message.text : ''}:${latest}:${bookmarkable}`}</Text>
  ));
  const screen = render(<TranscriptRow item={item} isLatest renderContent={renderContent} />);
  // Fresh parent elements must not repeatedly parse unchanged historical Markdown.
  screen.rerender(<TranscriptRow item={item} isLatest renderContent={renderContent} />);
  expect(renderContent).toHaveBeenCalledTimes(1);
  const changed: Row = {
    kind: 'message',
    message: { kind: 'agent-text', id: 'text', localId: null, createdAt: 0, text: 'Updated' },
  };
  screen.rerender(<TranscriptRow item={changed} isLatest renderContent={renderContent} />);
  expect(screen.getByText('Updated:true:true')).toBeTruthy();
  screen.rerender(<TranscriptRow item={changed} isLatest={false} renderContent={renderContent} />);
  expect(screen.getByText('Updated:false:true')).toBeTruthy();
  screen.rerender(
    <TranscriptRow
      item={changed}
      isLatest={false}
      bookmarkable={false}
      renderContent={renderContent}
    />,
  );
  expect(screen.getByText('Updated:false:false')).toBeTruthy();
  expect(renderContent).toHaveBeenCalledTimes(4);
});
