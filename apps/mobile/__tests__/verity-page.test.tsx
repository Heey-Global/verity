// Verity's page (components/verity/VerityPage.tsx): cross-project knowledge
// reached from Home in the new design.
//
// What is worth guarding: a question starts a session in Verity Control with
// the question as its first prompt (and cannot be sent without one), a recently
// changed page opens that very file, and the three context entries lead to the
// screens that edit them.
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
const mockWide = { value: false };
jest.mock('../lib/sessionLayout', () => ({
  sessionLayout: () => ({ wide: mockWide.value, sidebarWidth: 320 }),
}));

import type { ProjectRecord, RecentSharedKnowledge, VerityClient } from '@verity/mobile';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { VerityPage, changedAgo, recentLine } from '../components/verity/VerityPage';
import VerityScreen from '../app/verity';
import {
  mockCreateVerityClient,
  mockDismissTo,
  mockPush,
  resetSettingsHarness,
} from './support/settingsHarness';

const control = { id: 'control', kind: 'control_plane', repo: 'verity' } as ProjectRecord;
const site = { id: 'site', kind: 'github', repo: 'website' } as ProjectRecord;

const recent: RecentSharedKnowledge[] = [
  {
    path: 'insights/decisions/d1.md',
    title: 'Verity owns Global',
    area: 'decisions',
    modifiedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    decision: { sessionId: 's-42', confirmedAt: '2026-11-03T16:14:02.187Z' },
  },
  {
    path: 'insights/tone.md',
    title: 'Tone of voice',
    area: 'wiki',
    modifiedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  },
];

async function renderPage(
  projects: ProjectRecord[] = [site, control],
  entries = recent,
  truncated = false,
) {
  const client = {
    listRecentSharedKnowledge: jest.fn().mockResolvedValue({ entries, truncated }),
    listProjects: jest.fn().mockResolvedValue(projects),
  };
  render(<VerityPage client={client as unknown as VerityClient} />);
  await act(async () => undefined);
  return client;
}

afterEach(() => {
  mockWide.value = false;
  resetSettingsHarness();
});

it('asks Verity in a new Verity Control session with the question as its prompt', async () => {
  await renderPage();
  fireEvent.changeText(screen.getByLabelText('Ask Verity about your knowledge'), ' Tone rules? ');
  fireEvent.press(screen.getByText('Ask'));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/new',
    params: { projectId: 'control', prompt: 'Tone rules?' },
  });
});

it('says why it cannot ask without Verity Control', async () => {
  await renderPage([site]);
  expect(screen.getByText('Verity Control is not set up')).toBeTruthy();
  fireEvent.press(screen.getByText('Ask'));
  expect(mockPush).not.toHaveBeenCalled();
});

it('does not claim Verity Control is missing when projects could not be read', async () => {
  const client = {
    listRecentSharedKnowledge: jest.fn().mockResolvedValue({ entries: [], truncated: false }),
    listProjects: jest.fn().mockRejectedValue(new Error('offline')),
  };
  render(<VerityPage client={client as unknown as VerityClient} />);
  await act(async () => undefined);
  expect(screen.queryByText('Verity Control is not set up')).toBeNull();
  expect(screen.getByText('Verity could not be reached')).toBeTruthy();
});

it('opens a recently changed page in the Shared browser', async () => {
  await renderPage();
  expect(screen.getByText('Decision · 5 min ago · from a confirmed decision')).toBeTruthy();
  fireEvent.press(screen.getByLabelText(/^Tone of voice/));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/settings/shared-knowledge',
    params: { path: 'insights/tone.md' },
  });
});

it('says when the list covers only part of a large library', async () => {
  await renderPage([control], recent, true);
  expect(screen.getByTestId('verity-recent-partial')).toBeTruthy();
});

it('says so when Shared knowledge is empty', async () => {
  await renderPage([control], []);
  expect(screen.getByText('Nothing in Shared knowledge yet.')).toBeTruthy();
});

it.each([
  ['Instructions', { pathname: '/settings/context', params: { kind: 'instructions' } }],
  ['Memory', { pathname: '/settings/context', params: { kind: 'memory' } }],
  ['Shared knowledge', '/settings/shared-knowledge'],
])('leads %s to the screen that edits it', async (title, href) => {
  await renderPage();
  fireEvent.press(screen.getByLabelText(new RegExp(`^${title},`)));
  expect(mockPush).toHaveBeenCalledWith(href);
});

it('words change times and provenance', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  expect(changedAgo('2026-11-05T11:59:50Z', now)).toBe('just now');
  expect(changedAgo('2026-11-03T12:00:00Z', now)).toBe('2 d ago');
  expect(changedAgo('2026-10-01T12:00:00Z', now)).toBe('2026-10-01');
  expect(recentLine({ ...recent[1]!, modifiedAt: '2026-11-05T09:00:00Z' }, now)).toBe(
    'Wiki · 3 h ago',
  );
});

it('goes back to Home from the wide layout’s left column', async () => {
  const onBack = jest.fn();
  const client = {
    listRecentSharedKnowledge: jest.fn().mockResolvedValue({ entries: [], truncated: false }),
    listProjects: jest.fn().mockResolvedValue([control]),
  };
  render(<VerityPage client={client as unknown as VerityClient} onBack={onBack} />);
  await act(async () => undefined);
  fireEvent.press(screen.getByText('Home'));
  expect(onBack).toHaveBeenCalled();
});

it('hands a wide screen to the left column instead of covering the session', () => {
  // Opened over both columns, the page would hide the session the operator reads.
  mockWide.value = true;
  mockCreateVerityClient.mockReturnValue({} as unknown as VerityClient);
  render(<VerityScreen />);
  expect(mockDismissTo).toHaveBeenCalledWith({ pathname: '/', params: { verity: '1' } });
  expect(screen.queryByTestId('verity-page')).toBeNull();
});

it('opens as its own screen on a phone', async () => {
  mockCreateVerityClient.mockReturnValue({
    listRecentSharedKnowledge: jest.fn().mockResolvedValue({ entries: [], truncated: false }),
    listProjects: jest.fn().mockResolvedValue([control]),
  } as unknown as VerityClient);
  render(<VerityScreen />);
  await act(async () => undefined);
  expect(screen.getByTestId('verity-page')).toBeTruthy();
  expect(mockDismissTo).not.toHaveBeenCalled();
});
