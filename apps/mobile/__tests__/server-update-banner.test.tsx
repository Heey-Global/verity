import { fireEvent, render, screen } from '@testing-library/react-native';

const mockNavigate = jest.fn();
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: {
    navigate: (href: string) => mockNavigate(href),
    push: (href: string) => mockPush(href),
  },
}));

import { ServerUpdateBanner } from '../components/ServerUpdateBanner';
import { SERVER_UPDATE_ROUTE } from '../lib/serverUpdateRoute';

// The route the banner opens must be a real screen; a renamed file would leave
// the banner tapping into "unmatched route" while every type still checks.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const screenModule = require(`../app${String(SERVER_UPDATE_ROUTE)}`) as { default: unknown };

describe('ServerUpdateBanner', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockPush.mockClear();
  });

  it('opens the install screen in one tap', () => {
    render(<ServerUpdateBanner version="4.1.1" />);

    expect(screen.getByText('Verity 4.1.1 available')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button'));

    expect(mockNavigate).toHaveBeenCalledWith(SERVER_UPDATE_ROUTE);
    // The banner outlives the tap; a second one must not stack another copy.
    expect(mockPush).not.toHaveBeenCalled();
    expect(typeof screenModule.default).toBe('function');
  });
});
