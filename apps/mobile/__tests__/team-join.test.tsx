// The invited person's side: opening a join link, accepting and waiting for
// the join to be confirmed (ADR 0023 §7).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
const mockPaste = jest.fn();
jest.mock('expo-clipboard', () => ({ getStringAsync: () => mockPaste() }));

jest.mock('../lib/teamJoinState', () => ({ loadTeamJoinProgress: jest.fn(async () => null) }));

import { joinRedirect } from '../app/+native-intent';
import { JoinView } from '../app/onboarding/join';
import { TeamJoinError } from '../lib/teamJoin';

// A valid link from the team contract's own fixtures, still valid today.
const fixture = (
  JSON.parse(
    readFileSync(
      join(__dirname, '../../../scripts/team-control-contract/wire-fixtures.json'),
      'utf8',
    ),
  ) as Array<{ schema: string; valid: boolean; name: string; value: Record<string, unknown> }>
).find((entry) => entry.schema === 'invitationLink' && entry.valid && 'display' in entry.value)!;
const encode = (value: Record<string, unknown>) =>
  `https://verity.build/join#${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
const valid = encode({ ...fixture.value, expiresAt: Date.now() + 86_400_000 });
const expired = encode({ ...fixture.value, expiresAt: Date.now() - 1 });

const views = (overrides: Partial<Parameters<typeof JoinView>[0]> = {}) => {
  const props = {
    onClose: jest.fn(),
    onJoined: jest.fn(),
    join: jest.fn().mockResolvedValue({ projectId: 'p1' }),
    resume: jest.fn().mockResolvedValue({ projectId: 'p1' }),
    ...overrides,
  };
  render(<JoinView {...props} />);
  return props;
};

it('waits for safe completion before offering the personal-account setup', async () => {
  let finish!: (value: { projectId: string }) => void;
  const join = jest.fn(
    () =>
      new Promise<{ projectId: string }>((resolve) => {
        finish = resolve;
      }),
  );
  const props = views({ initialLink: valid, join });
  fireEvent.changeText(screen.getByLabelText('Your name in the team'), 'Lena');
  fireEvent.press(screen.getByLabelText('Join project'));
  await waitFor(() =>
    expect(join).toHaveBeenCalledWith(
      expect.objectContaining({ invitationId: fixture.value.invitationId }),
      'Lena',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  );
  expect(screen.getByText('Saving device access')).toBeOnTheScreen();
  expect(props.onJoined).not.toHaveBeenCalled();
  await act(async () => finish({ projectId: 'p1' }));
  expect(screen.getByText('Membership confirmed')).toBeOnTheScreen();
  expect(props.onJoined).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Set up my AI account'));
  expect(props.onJoined).toHaveBeenCalledTimes(1);
});

it('aborts work when leaving without reporting success', async () => {
  let signal!: AbortSignal;
  const props = views({
    initialLink: valid,
    join: jest.fn((_link, _name, options) => {
      signal = options!.signal!;
      return new Promise(() => undefined);
    }),
  });
  fireEvent.changeText(screen.getByLabelText('Your name in the team'), 'Lena');
  fireEvent.press(screen.getByLabelText('Join project'));
  fireEvent.press(await screen.findByLabelText('Leave for now'));
  expect(signal.aborted).toBe(true);
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(props.onJoined).not.toHaveBeenCalled();
});

afterEach(() => {
  jest.useRealTimers();
});

it('shows an expired invitation instead of offering to join', () => {
  const props = views({ initialLink: expired });
  expect(screen.getByText('This invitation has expired')).toBeOnTheScreen();
  expect(screen.queryByLabelText('Join project')).not.toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText('Close'));
  expect(props.onClose).toHaveBeenCalled();
});

it('shows a used or revoked invitation as unusable', async () => {
  views({
    initialLink: valid,
    join: jest.fn().mockRejectedValue(new TeamJoinError('unavailable', 'gone')),
  });
  fireEvent.changeText(screen.getByLabelText('Your name in the team'), 'Lena');
  fireEvent.press(screen.getByLabelText('Join project'));
  expect(await screen.findByText('This invitation can no longer be used')).toBeOnTheScreen();
  expect(screen.getByText('Ask Holger Teske for a new one.')).toBeOnTheScreen();
});

it('takes a pasted link and refuses one that is not an invitation', async () => {
  mockPaste.mockResolvedValue('https://example.com/not-an-invite');
  views();
  fireEvent.press(screen.getByLabelText('Paste'));
  await waitFor(() =>
    expect(screen.getByLabelText('Invitation link').props.value).toBe(
      'https://example.com/not-an-invite',
    ),
  );
  fireEvent.press(screen.getByLabelText('Continue'));
  expect(screen.getByText('This is not a Verity invitation link.')).toBeOnTheScreen();
  fireEvent.changeText(screen.getByLabelText('Invitation link'), valid);
  fireEvent.press(screen.getByLabelText('Continue'));
  expect(screen.getByText(/Holger Teske invites you to/)).toBeOnTheScreen();
});

describe('joinRedirect', () => {
  it('hands a join link with its fragment to the join screen', () => {
    const target = joinRedirect(valid)!;
    expect(target.startsWith('/onboarding/join?link=')).toBe(true);
    // The fragment is the invitation; losing it would open an empty screen.
    expect(decodeURIComponent(target.slice('/onboarding/join?link='.length))).toBe(valid);
  });

  it('leaves every other link to the router', () => {
    expect(joinRedirect('/session/abc')).toBeUndefined();
    expect(joinRedirect('https://verity.build/mcp/oauth/callback?code=1')).toBeUndefined();
    expect(joinRedirect(valid.replace('verity.build', 'evil.example'))).toBeUndefined();
  });
});

it('keeps an overlong name editable before starting enrollment', async () => {
  const props = views({ initialLink: valid });
  fireEvent.changeText(screen.getByLabelText('Your name in the team'), 'x'.repeat(81));
  expect(screen.getByText('Use 80 characters or fewer.')).toBeOnTheScreen();
  expect(screen.getByLabelText('Join project')).toBeDisabled();
  expect(props.join).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText('Your name in the team'), 'Lena');
  fireEvent.press(screen.getByLabelText('Join project'));
  await waitFor(() => expect(props.join).toHaveBeenCalled());
});
