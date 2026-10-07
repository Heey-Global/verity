import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { SessionContextMenu, SwipeableSessionRow } from '../components/SessionRowActions';

function renderMenu(favorite: boolean) {
  const handlers = {
    onClose: jest.fn(),
    onToggleFavorite: jest.fn(),
    onEdit: jest.fn(),
    onDelete: jest.fn(),
  };
  render(
    <SessionContextMenu
      at={{ x: 40, y: 80 }}
      title="Fix login"
      favorite={favorite}
      {...handlers}
    />,
  );
  return handlers;
}

describe('SessionContextMenu', () => {
  it('offers to add a session that is not a favorite yet', () => {
    const { onToggleFavorite, onClose } = renderMenu(false);

    expect(screen.getByText('Fix login')).toBeTruthy();
    expect(screen.queryByLabelText('Remove from favorites')).toBeNull();
    fireEvent.press(screen.getByLabelText('Add to favorites'));

    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers to remove an existing favorite', () => {
    const { onToggleFavorite } = renderMenu(true);

    expect(screen.queryByLabelText('Add to favorites')).toBeNull();
    fireEvent.press(screen.getByLabelText('Remove from favorites'));
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
  });

  it('routes Edit to the session settings and Delete to the delete confirmation', () => {
    const { onEdit, onDelete, onToggleFavorite, onClose } = renderMenu(false);

    fireEvent.press(screen.getByLabelText('Edit…'));
    fireEvent.press(screen.getByLabelText('Delete…'));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onToggleFavorite).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes without acting when the backdrop is tapped', () => {
    const { onClose, onToggleFavorite, onEdit, onDelete } = renderMenu(false);

    fireEvent.press(screen.getByLabelText('Close menu'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect([onToggleFavorite, onEdit, onDelete].some((fn) => fn.mock.calls.length > 0)).toBe(false);
  });
});

describe('SwipeableSessionRow', () => {
  function renderRow(favorite: boolean) {
    const handlers = { onToggleFavorite: jest.fn(), onDelete: jest.fn(), onEdit: jest.fn() };
    render(
      <SwipeableSessionRow favorite={favorite} label="Fix login" {...handlers}>
        <Text>row content</Text>
      </SwipeableSessionRow>,
    );
    return handlers;
  }

  it('fires favorite and delete from their swipe actions', () => {
    const { onToggleFavorite, onDelete } = renderRow(false);

    expect(screen.getByText('row content')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Favorite'));
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText('Delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('labels the leading action as unfavorite for a favorite', () => {
    renderRow(true);

    expect(screen.getByLabelText('Unfavorite')).toBeTruthy();
    expect(screen.queryByLabelText('Favorite')).toBeNull();
  });
});
