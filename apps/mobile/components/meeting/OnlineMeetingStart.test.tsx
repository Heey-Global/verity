import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import type { UpcomingMeeting } from '@verity/mobile';
import { createVerityClient } from '../../lib/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CalendarMeetingPicker,
  isSupportedMeetingLink,
  MEETING_HOSTS,
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

  it('selects an eligible call when switching from a mixed in-person list to online', () => {
    const upcoming = [meeting('office', NOW, { provider: null }), meeting('call', NOW)];
    const { result, rerender } = renderHook(
      ({ inPerson }: { inPerson: boolean }) => useCalendarMeetingChoice(upcoming, NOW, inPerson),
      { initialProps: { inPerson: true } },
    );
    expect(result.current.selectedEvent?.eventKey).toBe('office');
    rerender({ inPerson: false });
    expect(result.current.selectedEvent?.eventKey).toBe('call');
    expect(result.current.manualLink).toBe(false);
  });

  // Verity prepared the screen for one meeting; the default pick must not replace it.
  it('picks the meeting Verity prepared, until the source changes', () => {
    const upcoming = [meeting('now', NOW), meeting('client', NOW + 3_600_000)];
    const { result, rerender } = renderHook(
      ({ inPerson }: { inPerson: boolean }) =>
        useCalendarMeetingChoice(upcoming, NOW, inPerson, 'client'),
      { initialProps: { inPerson: false } },
    );
    expect(result.current.selectedEventKey).toBe('client');
    rerender({ inPerson: true });
    expect(result.current.selectedEventKey).toBe('now');
  });

  it('never preselects a meeting without a call link for an online start', () => {
    const upcoming = [meeting('call', NOW), meeting('office', NOW, { provider: null })];
    const { result } = renderHook(() => useCalendarMeetingChoice(upcoming, NOW, false, 'office'));
    expect(result.current.selectedEventKey).toBe('call');
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
  it('leaves out joined meetings and exposes calendar loading failures', async () => {
    jest.mocked(createVerityClient).mockReturnValue({
      getUpcomingMeetings: jest
        .fn()
        .mockResolvedValue([meeting('a', NOW), meeting('b', NOW, { decision: 'joined' })]),
    } as never);
    const listed = renderHook(() => useUpcomingMeetings(true));
    await waitFor(() =>
      expect(listed.result.current.upcoming?.map((item) => item.eventKey)).toEqual(['a']),
    );
    listed.unmount();
    jest.mocked(createVerityClient).mockReturnValue({
      getUpcomingMeetings: jest.fn().mockRejectedValue(new Error('403')),
    } as never);
    const refused = renderHook(() => useUpcomingMeetings(true));
    await waitFor(() => expect(refused.result.current).toEqual({ upcoming: [], loadFailed: true }));
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
    // An explicit selection may join before the default preselection window.
    expect(props.onSelect).toHaveBeenCalledWith('b');
    fireEvent.press(screen.getByText('Meeting a'));
    expect(props.onSelect).toHaveBeenCalledWith('a');
    fireEvent.press(screen.getByText('Enter link manually'));
    expect(props.onManualChange).toHaveBeenCalledWith(true);
  });

  it('offers in-person events without a call link and keeps link entry hidden', () => {
    render(
      <CalendarMeetingPicker
        {...props}
        upcoming={[meeting('office', NOW, { provider: null })]}
        inPerson
        manual={false}
      />,
    );
    fireEvent.press(screen.getByText('Meeting office'));
    expect(props.onSelect).toHaveBeenCalledWith('office');
    expect(screen.queryByText('Enter link manually')).toBeNull();
  });

  it('allows choosing a meeting half an hour before its start', () => {
    const onSelect = jest.fn();
    render(
      <CalendarMeetingPicker
        {...props}
        upcoming={[meeting('early', NOW + 30 * 60_000)]}
        onSelect={onSelect}
        manual={false}
      />,
    );
    fireEvent.press(screen.getByText('Meeting early'));
    expect(onSelect).toHaveBeenCalledWith('early');
  });

  it('shows calendar request failures distinctly from empty calendars', () => {
    render(<CalendarMeetingPicker {...props} upcoming={[]} loadFailed manual />);
    expect(screen.getByText('Could not load calendar meetings')).toBeOnTheScreen();
    expect(screen.queryByText('No calendar meetings')).toBeNull();
  });

  it('shows the link field when nothing can be picked', () => {
    render(<CalendarMeetingPicker {...props} upcoming={[]} manual />);
    expect(screen.getByText('No calendar meetings')).toBeOnTheScreen();
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

describe('isSupportedMeetingLink', () => {
  // The app refuses a link before the server sees it; a host added on the server only would
  // be blocked here without anyone noticing.
  it('accepts exactly the hosts the server joins', () => {
    const server = readFileSync(
      join(__dirname, '../../../../packages/server/src/calendar-meeting-links.ts'),
      'utf8',
    );
    const hosts = /const MEETING_HOSTS = (\[[^\]]*\])/u.exec(server)?.[1];
    expect(hosts).toBeDefined();
    expect(MEETING_HOSTS).toEqual(JSON.parse(hosts!.replaceAll("'", '"')));
  });

  it.each([
    ['https://meet.google.com/abc-defg-hij', true],
    ['meet.google.com/abc-defg-hij', true],
    ['us02web.zoom.us/j/1', true],
    ['https://teams.live.com/meet/1', true],
    ['http://meet.google.com/abc-defg-hij', false],
    ['https://meet.example.com/abc', false],
    ['https://user:pw@zoom.us/j/1', false],
    ['not a link', false],
  ])('reads %s as %s', (link, supported) => {
    expect(isSupportedMeetingLink(link)).toBe(supported);
  });
});
