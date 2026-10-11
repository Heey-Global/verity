import { fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SavedMeetingCard } from './SavedMeetingCard';
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
it('opens the exact saved meeting and shows its recorded metrics', () => {
  render(
    <SavedMeetingCard
      card={{
        title: 'Pricing sync',
        link: '/knowledge/meetings/pricing.md',
        sessionId: 'session-1',
        meetingId: 'meeting-1',
        durationMinutes: 42,
        people: 3,
        notes: 2,
        answers: 4,
      }}
    />,
  );
  expect(screen.getByText('42 min · 3 people · 4 answers · 2 notes')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Open meeting: Pricing sync'));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/meeting/[sessionId]',
    params: { sessionId: 'session-1', meetingId: 'meeting-1' },
  });
});
it('opens legacy notices through the session file handler', () => {
  const open = jest.fn();
  render(
    <SavedMeetingCard
      card={{ title: 'Older meeting', link: '/knowledge/meetings/old.md' }}
      onOpenLegacy={open}
    />,
  );
  fireEvent.press(screen.getByLabelText('Open meeting: Older meeting'));
  expect(open).toHaveBeenCalledTimes(1);
});
