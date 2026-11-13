// The inviter's side of project team invitations: the team, creating an
// invitation and sharing its link (ADR 0023 §1).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
import { router } from 'expo-router';

jest.mock('expo-router', () => ({
  Stack: Object.assign(() => null, { Screen: () => null }),
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
  useLocalSearchParams: () => ({}),
}));
jest.mock('react-native-qrcode-svg', () => {
  const { Text } = jest.requireActual('react-native');
  return ({ value }: { value: string }) => <Text testID="invitation-qr">{value}</Text>;
});
const mockCopy = jest.fn();
jest.mock('expo-clipboard', () => ({ setStringAsync: (value: string) => mockCopy(value) }));
const mockProfile = {
  version: 1 as const,
  serverId: 'srv_EREREREREREREREREREREQ',
  identityKey: 'MCowBQYDK2VwAyEAERERERERERERERERERERERERERERERERERERERE',
  activeUrl: 'https://192.168.1.20:8443',
  endpoints: [
    { url: 'https://192.168.1.20:8443', transport: 'direct' as const, tlsPin: 'sha256-pin' },
  ],
};
jest.mock('../lib/serverProfile', () => ({ getServerProfile: () => mockProfile }));

import { InvitationView } from '../app/project/[id]/settings/invitation';
import { InviteView } from '../app/project/[id]/settings/invite';
import { ProjectTeamView } from '../app/project/[id]/settings/team';
import { resetVeritySettingsStore } from '../lib/settingsStore';

const mockRouter = router as unknown as { push: jest.Mock; replace: jest.Mock; back: jest.Mock };

const member = (overrides: Record<string, unknown>) => ({
  userId: 'u-lena',
  displayName: 'Lena',
  canRead: true,
  canExecute: true,
  canManage: false,
  creator: false,
  joinedAt: '2026-11-01T10:00:00.000Z',
  ...overrides,
});
const invitation = {
  id: '6f1c1b1e-1d2a-4c3b-9a8d-7e6f5a4b3c2d',
  inviteeName: 'Mia',
  canExecute: false,
  state: 'open' as const,
  expiresAt: '2026-11-20T10:00:00.000Z',
  createdAt: '2026-11-13T10:00:00.000Z',
};
const linkFields = {
  version: 1 as const,
  purpose: 'team-member' as const,
  invitationId: 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM',
  secret: 'NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ',
  expiresAt: 1_800_000_000_000,
  serverId: mockProfile.serverId,
  identityKey: mockProfile.identityKey,
  uplinkOrigin: 'https://uplink.verity.build',
  installationId: '0b7f6e5d-4c3b-4a29-8817-161514131211',
  installationHandle: 'EREREREREREREREREREREQ',
  display: { inviterName: 'Holger', projectName: 'verity' },
};

beforeEach(() => {
  resetVeritySettingsStore();
  mockRouter.push.mockReset();
  mockRouter.replace.mockReset();
  mockRouter.back.mockReset();
  mockCopy.mockReset().mockResolvedValue(undefined);
});

it('lists members and open invitations and changes a member right', async () => {
  const setRights = jest.fn().mockResolvedValue(member({ canManage: true }));
  const client = {
    getProjectTeam: jest.fn().mockResolvedValue({
      members: [
        member({ userId: 'u-holger', displayName: 'Holger', creator: true, canManage: true }),
        member({}),
      ],
      invitations: [invitation],
    }),
    setProjectMemberRights: setRights,
  } as unknown as VerityClient;
  render(<ProjectTeamView client={client} projectId="p1" />);

  expect(await screen.findByText('Members · 2')).toBeOnTheScreen();
  expect(screen.getByText('Owner of this project')).toBeOnTheScreen();
  fireEvent.press(screen.getByText('Invitation for Mia'));
  expect(mockRouter.push).toHaveBeenCalledWith({
    pathname: '/project/[id]/settings/invitation',
    params: { id: 'p1', invitationId: invitation.id },
  });

  // The owner's row opens nothing: their rights cannot be taken from them here.
  fireEvent.press(screen.getByText('Holger'));
  expect(screen.queryByText('Can manage')).not.toBeOnTheScreen();
  fireEvent.press(screen.getByText('Lena'));
  fireEvent.press(await screen.findByText('Can manage'));
  await waitFor(() =>
    expect(setRights).toHaveBeenCalledWith('p1', 'u-lena', { canExecute: true, canManage: true }),
  );
});

it('removes a member only after confirming', async () => {
  const remove = jest.fn().mockResolvedValue(undefined);
  const client = {
    getProjectTeam: jest.fn().mockResolvedValue({ members: [member({})], invitations: [] }),
    removeProjectMember: remove,
  } as unknown as VerityClient;
  render(<ProjectTeamView client={client} projectId="p1" />);
  fireEvent.press(await screen.findByText('Lena'));
  fireEvent.press(await screen.findByText('Remove from project'));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.press(await screen.findByText('Remove'));
  await waitFor(() => expect(remove).toHaveBeenCalledWith('p1', 'u-lena'));
});

it('creates an invitation with the chosen right and opens it', async () => {
  const create = jest.fn().mockResolvedValue({ invitation, linkFields: null });
  const client = {
    getProject: jest.fn().mockResolvedValue({ project: { id: 'p1', name: 'verity' } }),
    createProjectInvitation: create,
  } as unknown as VerityClient;
  render(<InviteView client={client} projectId="p1" />);
  fireEvent.changeText(screen.getByLabelText('Your name, as invited people see it'), ' Holger ');
  fireEvent.changeText(screen.getByLabelText('Who are you inviting?'), 'Mia');
  fireEvent.press(screen.getByText('Can read'));
  fireEvent.press(screen.getByText('Create invitation'));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith('p1', {
      inviteeName: 'Mia',
      canExecute: false,
      inviterName: 'Holger',
    }),
  );
  await waitFor(() =>
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/project/[id]/settings/invitation',
      params: { id: 'p1', invitationId: invitation.id },
    }),
  );
});

it('shows the link once Uplink registered the invitation, and copies it', async () => {
  jest.useFakeTimers();
  try {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ invitation, linkFields: null })
      .mockResolvedValue({ invitation, linkFields });
    const client = { getProjectInvitation: get } as unknown as VerityClient;
    render(<InvitationView client={client} projectId="p1" invitationId={invitation.id} />);
    expect(await screen.findByText('Preparing the link…')).toBeOnTheScreen();
    await act(async () => {
      jest.advanceTimersByTime(3_000);
    });
    const qr = await screen.findByTestId('invitation-qr');
    const link = String(qr.props.children);
    expect(link.startsWith('https://verity.build/join#')).toBe(true);
    // The pin comes from this app's paired profile, never from the server's answer.
    const decoded = JSON.parse(
      Buffer.from(link.slice('https://verity.build/join#'.length), 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(decoded.tlsPin).toBe('sha256-pin');
    fireEvent.press(screen.getByLabelText('Copy invitation link'));
    await waitFor(() => expect(mockCopy).toHaveBeenCalledWith(link));
    expect(screen.getByText('Send to Mia')).toBeOnTheScreen();
  } finally {
    jest.useRealTimers();
  }
});

it('revokes the invitation after confirming', async () => {
  const revoke = jest.fn().mockResolvedValue(undefined);
  const done = jest.fn();
  const client = {
    getProjectInvitation: jest.fn().mockResolvedValue({ invitation, linkFields }),
    revokeProjectInvitation: revoke,
  } as unknown as VerityClient;
  render(
    <InvitationView client={client} projectId="p1" invitationId={invitation.id} onDone={done} />,
  );
  fireEvent.press(await screen.findByText('Revoke invitation'));
  fireEvent.press(await screen.findByText('Revoke'));
  await waitFor(() => expect(revoke).toHaveBeenCalledWith('p1', invitation.id));
  expect(done).toHaveBeenCalled();
});
