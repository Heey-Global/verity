import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { Button } from './Button';
import { useTextPrompt } from './TextPrompt';

it('edits text with a shared sheet on Android', () => {
  const platform = jest.replaceProperty(Platform, 'OS', 'android');
  const onSave = jest.fn();
  function Example() {
    const editor = useTextPrompt();
    return (
      <>
        {editor.dialog}
        <Button
          label="Edit"
          onPress={() =>
            editor.prompt('Title', 'Edit this title.', onSave, 'plain-text', 'Original')
          }
        />
      </>
    );
  }
  try {
    render(<Example />);
    fireEvent.press(screen.getByText('Edit'));
    fireEvent.changeText(screen.getByLabelText('Title'), 'Updated');
    fireEvent.press(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledWith('Updated');
    expect(screen.queryByText('Save')).toBeNull();
  } finally {
    platform.restore();
  }
});
