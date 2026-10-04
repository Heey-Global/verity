import type { SessionAutomation } from '@verity/mobile';
import { fireEvent, render, screen } from '@testing-library/react-native';

import {
  AutomationBar,
  AutomationProposalCard,
  AutomationSheet,
} from '../components/SessionAutomation';

jest.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: true }] }));

const proposal = {
  name: 'Morning review',
  schedule: { kind: 'weekly' as const, weekday: 1, hour: 9, minute: 0 },
  prompt: 'Summarize the open pull requests.',
};

const automation: SessionAutomation = {
  id: 'a1',
  sessionId: 's1',
  ...proposal,
  status: 'enabled',
  script: null,
  model: null,
  consecutiveErrorCount: 0,
  lastRunAt: null,
  lastOutcome: null,
  lastDetail: null,
  nextRunAt: null,
  createdAt: '2026-10-04T10:00:00.000Z',
  updatedAt: '2026-10-04T10:00:00.000Z',
};

function card(overrides: Partial<Parameters<typeof AutomationProposalCard>[0]> = {}) {
  const onConfirm = jest.fn();
  render(
    <AutomationProposalCard
      proposal={proposal}
      state="idle"
      current="none"
      error={null}
      disabled={false}
      superseded={false}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return onConfirm;
}

describe('AutomationProposalCard', () => {
  it('creates the automation on one tap and says when it runs', () => {
    const onConfirm = card();
    expect(screen.getByText('Every Monday at 09:00 server time')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Create automation' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows a check script before the operator confirms running it', () => {
    card({ proposal: { ...proposal, script: 'test -s CHANGES.md && exit 10' } });
    // Confirming runs this in the project container; it must not be hidden.
    expect(screen.getByText('test -s CHANGES.md && exit 10')).toBeTruthy();
  });

  it('cannot re-confirm the automation that is already active', () => {
    const onConfirm = card({ current: 'same' });
    fireEvent.press(screen.getByRole('button', { name: 'Automation active' }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not call a paused automation active', () => {
    card({ current: 'same', currentPaused: true });
    expect(screen.getByRole('button', { name: 'Automation paused' })).toBeTruthy();
  });

  it('warns before replacing a different automation', () => {
    const onConfirm = card({ current: 'other' });
    expect(screen.getByText(/already has an automation/)).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Replace current automation' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('keeps an older proposal inert once a newer one exists', () => {
    const onConfirm = card({ superseded: true });
    expect(screen.getByText(/newer version of this proposal/)).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Create automation' }));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('AutomationBar', () => {
  it('opens the details and offers deletion separately', () => {
    const onOpen = jest.fn();
    const onDelete = jest.fn();
    render(<AutomationBar automation={automation} onOpen={onOpen} onDelete={onDelete} />);
    fireEvent.press(screen.getByRole('button', { name: 'Show automation Morning review' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByRole('button', { name: 'Delete automation' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('says when an automation is paused', () => {
    render(
      <AutomationBar
        automation={{ ...automation, status: 'paused' }}
        onOpen={jest.fn()}
        onDelete={jest.fn()}
      />,
    );
    expect(screen.getByText('Paused')).toBeTruthy();
  });
});

describe('AutomationSheet', () => {
  it('pauses an active automation and resumes a paused one', () => {
    const onToggle = jest.fn();
    const { rerender } = render(
      <AutomationSheet
        automation={automation}
        updating={false}
        onToggle={onToggle}
        onDelete={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    expect(screen.getByText('Has not run yet.')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Pause automation' }));
    rerender(
      <AutomationSheet
        automation={{ ...automation, status: 'paused' }}
        updating={false}
        onToggle={onToggle}
        onDelete={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Resume automation' }));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });
});
