import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { FileContentPreview } from './FileContentPreview';

const markdown = '# Heading\n\n```ts\nconst x = 1;\n```';
const preview = (path: string, content = markdown) =>
  render(
    <FileContentPreview
      path={path}
      content={content}
      renderMarkdown={(item) => (
        <Text>
          {item.type === 'code'
            ? `Code: ${item.content}`
            : item.type === 'line'
              ? `Formatted: ${item.content}`
              : 'Table'}
        </Text>
      )}
    />,
  );

it('starts with formatted Markdown and switches to the exact source', () => {
  preview('notes.md');
  expect(screen.getByText('Formatted: # Heading')).toBeTruthy();
  expect(screen.getByText('Code: const x = 1;')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Source'));
  expect(screen.getByText(markdown)).toBeTruthy();
  expect(screen.queryByText('Formatted: # Heading')).toBeNull();
  fireEvent.press(screen.getByLabelText('Preview'));
  expect(screen.getByText('Formatted: # Heading')).toBeTruthy();
});

it('keeps other text files in source view without Markdown controls', () => {
  preview('notes.txt');
  expect(screen.getByText(markdown)).toBeTruthy();
  expect(screen.queryByLabelText('Preview')).toBeNull();
});

it('shows an empty-file message in both modes', () => {
  preview('empty.md', '');
  expect(screen.getByText('Empty file')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Source'));
  expect(screen.getByText('Empty file')).toBeTruthy();
});
