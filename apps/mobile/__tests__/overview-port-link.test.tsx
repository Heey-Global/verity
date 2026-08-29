import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking, Pressable } from 'react-native';

import { ProjectPortChip } from '../components/ProjectPortChip';

describe('ProjectPortChip', () => {
  it('opens its Dev Server URL without triggering the surrounding project toggle', () => {
    const toggle = jest.fn();
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    render(
      <Pressable onPress={toggle} accessibilityLabel="Toggle project">
        <ProjectPortChip port={{ id: 'dev-1', label: '3099', url: 'http://192.168.1.20:3099/' }} />
      </Pressable>,
    );

    const stopPropagation = jest.fn();
    fireEvent.press(screen.getByLabelText('Open Dev Server on port 3099'), { stopPropagation });

    expect(stopPropagation).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('http://192.168.1.20:3099/');
    expect(toggle).not.toHaveBeenCalled();
  });
});
