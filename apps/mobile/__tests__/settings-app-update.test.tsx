jest.mock('expo-updates', () => ({
  isEnabled: true,
  useUpdates: jest.fn(),
  checkForUpdateAsync: jest.fn(),
  fetchUpdateAsync: jest.fn(),
  reloadAsync: jest.fn(),
}));
jest.mock('expo-application', () => ({
  applicationId: 'build.verity.app',
  nativeApplicationVersion: '1.75.0',
  nativeBuildVersion: '312',
}));
jest.mock('expo-localization', () => ({ getLocales: () => [{ regionCode: 'DE' }] }));
const mockOpenURL = jest.fn((_url: string) => Promise.resolve(true));
jest.mock('react-native/Libraries/Linking/Linking', () => {
  const linking = { openURL: (url: string) => mockOpenURL(url) };
  return { __esModule: true, ...linking, default: linking };
});
// The over-the-air bundle the device runs, ahead of its 1.75.0 binary.
jest.mock('../lib/buildInfo', () => ({ runningReleaseVersion: () => '1.75.4' }));

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Updates from 'expo-updates';

import { AppUpdateSection } from '../components/settings/AppUpdateSection';
import { resetAppStoreLookupForTests } from '../lib/appUpdateFacts';

const useUpdates = Updates.useUpdates as jest.Mock;
const STORE_PAGE = 'https://apps.apple.com/de/app/verity/id6807746931';

function lookup(version: string | null) {
  return {
    ok: true,
    json: async () => ({
      resultCount: version === null ? 0 : 1,
      results:
        version === null
          ? []
          : [
              {
                version,
                trackViewUrl: STORE_PAGE,
                releaseNotes: 'Faster voice input start',
                currentVersionReleaseDate: '2026-10-22T07:00:00Z',
              },
            ],
    }),
  };
}

const fetchMock = jest.fn();

beforeEach(() => {
  resetAppStoreLookupForTests();
  fetchMock.mockReset().mockResolvedValue(lookup('1.75.0'));
  global.fetch = fetchMock as unknown as typeof fetch;
  useUpdates.mockReturnValue({ isUpdatePending: false, isChecking: false, isDownloading: false });
  (Updates.checkForUpdateAsync as jest.Mock).mockResolvedValue({ isAvailable: false });
  (Updates.reloadAsync as jest.Mock).mockResolvedValue(undefined);
});

describe('app box on the update screen', () => {
  it('says up to date when the store has nothing above the installed binary', async () => {
    render(<AppUpdateSection />);
    expect(await screen.findByText('Up to date')).toBeOnTheScreen();
    expect(screen.getByText('Version 1.75.4')).toBeOnTheScreen();
    expect(screen.getByText('Check for updates')).toBeOnTheScreen();
    // Asked for the device's own storefront, by this app's bundle id.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://itunes.apple.com/lookup?bundleId=build.verity.app&country=de',
      expect.anything(),
    );
  });

  it('checks for a smaller update without restarting the app', async () => {
    render(<AppUpdateSection />);
    fireEvent.press(await screen.findByText('Check for updates'));
    await waitFor(() => expect(Updates.checkForUpdateAsync).toHaveBeenCalled());
    expect(Updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('asks the App Store again on an explicit check', async () => {
    render(<AppUpdateSection />);
    expect(await screen.findByText('Up to date')).toBeOnTheScreen();
    fetchMock.mockResolvedValue(lookup('1.76.0'));
    fireEvent.press(screen.getByText('Check for updates'));
    expect(await screen.findByText('Version 1.76.0 is available')).toBeOnTheScreen();
  });

  it('restarts into a downloaded update on request', async () => {
    useUpdates.mockReturnValue({ isUpdatePending: true, isChecking: false, isDownloading: false });
    render(<AppUpdateSection />);
    expect(await screen.findByText('Update ready')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Restart now'));
    await waitFor(() => expect(Updates.reloadAsync).toHaveBeenCalled());
  });

  it('sends a newer App Store version to the store page the store named', async () => {
    fetchMock.mockResolvedValue(lookup('1.76.0'));
    // Waiting as well, but the store release supersedes it.
    useUpdates.mockReturnValue({ isUpdatePending: true, isChecking: false, isDownloading: false });
    render(<AppUpdateSection />);
    expect(await screen.findByText('Version 1.76.0 is available')).toBeOnTheScreen();
    expect(screen.getByText('Update')).toBeOnTheScreen();
    expect(screen.getByText('Faster voice input start')).toBeOnTheScreen();
    expect(screen.queryByText('Restart now')).toBeNull();
    fireEvent.press(screen.getByText('Update in App Store'));
    expect(mockOpenURL).toHaveBeenCalledWith(STORE_PAGE);
  });

  it('offers nothing from the store when the lookup fails, and asks again next time', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const { unmount } = render(<AppUpdateSection />);
    expect(await screen.findByText('Up to date')).toBeOnTheScreen();
    unmount();
    fetchMock.mockResolvedValue(lookup('1.76.0'));
    render(<AppUpdateSection />);
    expect(await screen.findByText('Version 1.76.0 is available')).toBeOnTheScreen();
  });
});
