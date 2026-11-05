// Spec mockups (apps/mobile/mockups) and the route that shows them.
//
// The failures worth guarding are quiet ones: the route showing a mockup
// outside demo mode, where sample data could be read as the operator's own;
// a mockup file that was added or renamed without its registry entry, so the
// render script serves "not found" instead of the screen someone approved; and
// a mockup that throws while rendering, which only the browser export would
// otherwise reveal.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen } from '@testing-library/react-native';

const mockDemoMode = jest.fn(() => true);
const mockParams: { spec?: string; mockup?: string } = {};

jest.mock('../lib/demoMode', () => ({ isDemoMode: () => mockDemoMode() }));
jest.mock('expo-router', () => {
  const { Text: NativeText } = require('react-native');
  return {
    Redirect: ({ href }: { href: string }) => <NativeText>{`redirect:${href}`}</NativeText>,
    Stack: { Screen: () => null },
    useLocalSearchParams: () => mockParams,
  };
});

import MockupRoute from '../app/mockups/[spec]/[mockup]';
import { findMockup, MOCKUP_SPECS } from '../mockups/registry';

const MOCKUPS_DIR = join(__dirname, '..', 'mockups');

function open(spec: string | undefined, screenId: string | undefined) {
  mockParams.spec = spec;
  mockParams.mockup = screenId;
  return render(<MockupRoute />);
}

afterEach(() => {
  mockDemoMode.mockReturnValue(true);
});

describe('mockup route', () => {
  it('sends the operator home outside demo mode, even for an existing mockup', () => {
    mockDemoMode.mockReturnValue(false);
    open('factory-spec', 'home');
    expect(screen.getByText('redirect:/')).toBeOnTheScreen();
    expect(screen.queryByText('Approve spec: pricing page')).toBeNull();
  });

  it('lists the available mockups for an unknown path', () => {
    open('factory-spec', 'missing');
    expect(screen.getByTestId('mockup-not-found')).toBeOnTheScreen();
    expect(screen.getByText('factory-spec/home')).toBeOnTheScreen();
  });

  it('does not resolve inherited object keys as screens', () => {
    expect(findMockup('factory-spec', 'constructor')).toBeNull();
    expect(findMockup('factory-spec', 'toString')).toBeNull();
  });

  it.each(MOCKUP_SPECS.flatMap((spec) => Object.keys(spec.screens).map((id) => [spec.id, id])))(
    'renders %s/%s without throwing',
    async (spec, screenId) => {
      open(spec, screenId);
      // Home's header loads the capture preference asynchronously.
      await act(async () => undefined);
      expect(screen.queryByTestId('mockup-not-found')).toBeNull();
      expect(screen.queryByText(/^redirect:/)).toBeNull();
    },
  );
});

describe('mockup registry', () => {
  const folders = readdirSync(MOCKUPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it('registers every spec folder under its folder name', () => {
    expect(MOCKUP_SPECS.map((spec) => spec.id).sort()).toEqual([...folders].sort());
  });

  it.each(folders)(
    'serves each screen file of %s under its file name, and no other screen',
    (folder) => {
      const spec = MOCKUP_SPECS.find((candidate) => candidate.id === folder);
      // A screen file is a .tsx whose default export is a component; helpers
      // shared by the screens export only named members.
      const screenFiles = readdirSync(join(MOCKUPS_DIR, folder))
        .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
        .map((file) => ({
          id: file.replace(/\.tsx$/, ''),
          Component: (require(join(MOCKUPS_DIR, folder, file)) as { default?: unknown }).default,
        }))
        .filter((file) => file.Component !== undefined);
      expect(
        Object.entries(spec?.screens ?? {})
          .map(([id, entry]) => ({ id, Component: entry.Component }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ).toEqual(screenFiles.sort((a, b) => a.id.localeCompare(b.id)));
    },
  );
});
