import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import type { UpcomingMeeting } from '@verity/mobile';
import { createVerityClient } from '../../lib/client';
import {
  CalendarMeetingPicker,
  UnassignedMeetingCard,
  useCalendarMeetingChoice,
  useUpcomingMeetings,
} from './OnlineMeetingStart';

jest.mock('../../lib/client', () => ({ createVerityClient: jest.fn() }));

const NOW = Date.parse('2026-11-02T10:06:00Z');
const meeting = (eventKey: string, startsAt: number, fields: Partial<UpcomingMeeting> = {}) =>
  ({
    eventKey,
    title: `Meeting ${eventKey}`,
    startsAt,
    endsAt: startsAt + 30 * 60_000,
    calendar: 'Work',
    provider: 'meet',
    decision: null,
    meetingId: null,
    ...fields,
  }) satisfies UpcomingMeeting;

describe('useCalendarMeetingChoice', () => {
  it('picks the first meeting, and a typed link wins over it', () => {
    const { result, rerender } = renderHook(
      ({ upcoming }: { upcoming: UpcomingMeeting[] | null }) =>
        useCalendarMeetingChoice(upcoming, NOW),
      { initialProps: { upcoming: null as UpcomingMeeting[] | null } },
    );
    expect(result.current.selectedEvent).toBeNull();
    expect(result.current.manualLink).toBe(false);
    rerender({ upcoming: [meeting('a', NOW), meeting('b', NOW + 3_600_000)] });
    expect(result.current.selectedEvent?.eventKey).toBe('a');
    act(() => result.current.setSelectedEventKey('b'));
    expect(result.current.selectedEvent?.eventKey).toBe('b');
    // Typing a link wins over the picked meeting.
    act(() => result.current.setManualLink(true));
    expect(result.current.selectedEvent).toBeNull();
  });

  // "Join …" must never point at a meeting hours away or one the operator did not pick.
  it('preselects only a meeting that is on now, and never swaps in another', () => {
    const later = meeting('later', NOW + 3_600_000);
    const now = meeting('now', NOW - 60_000);
    const { result, rerender } = renderHook(
      ({ upcoming }: { upcoming: UpcomingMeeting[] | null }) =>
        useCalendarMeetingChoice(upcoming, NOW),
      { initialProps: { upcoming: null as UpcomingMeeting[] | null } },
    );
    rerender({ upcoming: [later] });
    expect(result.current.selectedEvent).toBeNull();
    rerender({ upcoming: [later, now] });
    expect(result.current.selectedEvent).toBeNull();

    const fresh = renderHook(
      ({ upcoming }: { upcoming: UpcomingMeeting[] | null }) =>
        useCalendarMeetingChoice(upcoming, NOW),
      { initialProps: { upcoming: [now, meeting('next', NOW + 5 * 60_000)] } },
    );
    expect(fresh.result.current.selectedEvent?.eventKey).toBe('now');
    fresh.rerender({ upcoming: [meeting('next', NOW + 5 * 60_000)] });
    expect(fresh.result.current.selectedEvent).toBeNull();
  });

  it('opens the link field when the calendar has nothing to pick', () => {
    const { result, rerender } = renderHook(
      ({ upcoming }: { upcoming: UpcomingMeeting[] | null }) =>
        useCalendarMeetingChoice(upcoming, NOW),
      { initialProps: { upcoming: null as UpcomingMeeting[] | null } },
    );
    rerender({ upcoming: [] });
    expect(result.current.manualLink).toBe(true);
  });
});

describe('useUpcomingMeetings', () => {
  // A meeting already joined belongs to the floating card, not to the start list.
  it('leaves out joined meetings and reads an unavailable list as empty', async () => {
    jest.mocked(createVerityClient).mockReturnValue({
      getUpcomingMeetings: jest
        .fn()
        .mockResolvedValue([meeting('a', NOW), meeting('b', NOW, { decision: 'joined' })]),
    } as never);
    const listed = renderHook(() => useUpcomingMeetings(true));
    await waitFor(() => expect(listed.result.current?.map((item) => item.eventKey)).toEqual(['a']));
    listed.unmount();
    jest.mocked(createVerityClient).mockReturnValue({
      getUpcomingMeetings: jest.fn().mockRejectedValue(new Error('403')),
    } as never);
    const refused = renderHook(() => useUpcomingMeetings(true));
    await waitFor(() => expect(refused.result.current).toEqual([]));
    refused.unmount();
  });
});

describe('CalendarMeetingPicker', () => {
  const props = {
    selectedKey: 'a',
    onSelect: jest.fn(),
    onManualChange: jest.fn(),
    meetingUrl: '',
    onMeetingUrlChange: jest.fn(),
    now: NOW,
  };

  it('lists meetings with their time and keeps the link field folded', () => {
    render(
      <CalendarMeetingPicker
        {...props}
        upcoming={[
          meeting('a', NOW - 6 * 60_000),
          meeting('b', Date.parse('2026-11-02T11:30:00Z'), { provider: 'zoom' }),
        ]}
        manual={false}
      />,
    );
    expect(screen.getByText('Started 6 min ago · Google Meet')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Online meeting link')).toBeNull();
    fireEvent.press(screen.getByText('Meeting b'));
    // Starts in more than 15 minutes: listed, but not joinable yet.
    expect(props.onSelect).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('Meeting a'));
    expect(props.onSelect).toHaveBeenCalledWith('a');
    fireEvent.press(screen.getByText('Enter link manually'));
    expect(props.onManualChange).toHaveBeenCalledWith(true);
  });

  it('shows the link field when nothing can be picked', () => {
    render(<CalendarMeetingPicker {...props} upcoming={[]} manual />);
    expect(screen.getByText('No meetings with a link')).toBeOnTheScreen();
    expect(screen.getByLabelText('Online meeting link')).toBeOnTheScreen();
  });
});

it('continues or discards a meeting without a project', () => {
  const onContinue = jest.fn();
  const onDiscard = jest.fn();
  render(
    <UnassignedMeetingCard
      meeting={{
        id: 'm1',
        title: 'Weekly sync',
        startedAt: NOW - 12 * 60_000,
        endedAt: null,
        state: 'active',
        captureStatus: 'listening',
        people: 3,
      }}
      now={NOW}
      busy={false}
      onContinue={onContinue}
      onDiscard={onDiscard}
    />,
  );
  expect(screen.getByText('Live · 12 min · 3 people')).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Continue meeting in this session'));
  fireEvent.press(screen.getByLabelText('Discard meeting'));
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(onDiscard).toHaveBeenCalledTimes(1);
});
