// The badge hook's two non-obvious contracts, both of which are about WHEN it
// asks rather than what it answers: every screen in the stack renders the header
// that calls it, and the Verity client does not exist until the operator has
// chosen a server.
import { type VerityClient, type ServerUpdateStatus } from '@verity/mobile';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { createVerityClient, getVerityBaseUrl } from './client';
import { SERVER_UPDATE_BADGE_POLL_MS, useServerUpdateBadge } from './serverUpdateBadge';

jest.mock('./client', () => ({ createVerityClient: jest.fn(), getVerityBaseUrl: jest.fn() }));

const createClient = createVerityClient as jest.MockedFunction<typeof createVerityClient>;
const baseUrl = getVerityBaseUrl as jest.MockedFunction<typeof getVerityBaseUrl>;

const available = {
  state: 'available',
  release: { version: 'v11.1.0' },
  operation: null,
} as unknown as ServerUpdateStatus;

function fakeClient(getServerUpdates: jest.Mock): VerityClient {
  return { getServerUpdates } as unknown as VerityClient;
}

beforeEach(() => {
  baseUrl.mockReturnValue('http://server-a');
});

afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe('useServerUpdateBadge', () => {
  it('lights up on the screen that draws the dot', async () => {
    const getServerUpdates = jest.fn().mockResolvedValue(available);
    createClient.mockReturnValue(fakeClient(getServerUpdates));

    const { result } = renderHook(() => useServerUpdateBadge(true));

    await waitFor(() => expect(result.current).toBe(true));
    expect(getServerUpdates).toHaveBeenCalledTimes(1);
  });

  /**
   * The reason the screen passes `isHome` in rather than filtering the answer:
   * a session screen's header calls this too, and the screens behind it stay
   * mounted. Filtering afterwards would leave every one of them polling.
   */
  it('asks nothing from a screen without the settings button', async () => {
    const getServerUpdates = jest.fn().mockResolvedValue(available);
    createClient.mockReturnValue(fakeClient(getServerUpdates));

    const { result } = renderHook(() => useServerUpdateBadge(false));

    await act(async () => undefined);
    expect(getServerUpdates).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
  });

  /**
   * A first run pairs with the server after the header is already on screen.
   * The client is built per pass so that operator does not have to restart the
   * app to be told about a release.
   */
  it('picks up a server configured after it mounted', async () => {
    jest.useFakeTimers();
    const getServerUpdates = jest.fn().mockResolvedValue(available);
    createClient.mockReturnValueOnce(null).mockReturnValue(fakeClient(getServerUpdates));

    const { result } = renderHook(() => useServerUpdateBadge(true));
    expect(result.current).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(SERVER_UPDATE_BADGE_POLL_MS);
    });
    expect(getServerUpdates).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(true);
  });
});

/**
 * The dot is a claim about one server, and this hook outlives the choice of
 * server: the header stays mounted while the operator re-pairs, and the answer it
 * last received is not evidence about the next server. Everything here is about
 * not carrying a stale `true` across that boundary — the failure would be silent
 * and would point the operator at an update that does not exist.
 */
describe('when the server changes underneath it', () => {
  it('does not claim an update for a server it has never asked', async () => {
    const getServerUpdates = jest.fn().mockResolvedValue(available);
    createClient.mockReturnValue(fakeClient(getServerUpdates));

    const { result, rerender } = renderHook(() => useServerUpdateBadge(true));
    await waitFor(() => expect(result.current).toBe(true));

    // The operator points the app at a different server. Nothing has been asked
    // of it yet, so the dot must go dark rather than inherit the old answer.
    baseUrl.mockReturnValue('http://server-b');
    rerender(undefined);
    expect(result.current).toBe(false);
  });

  /**
   * The unreachable case, which is the one that lasts: a request that fails is
   * not evidence that an update is still waiting on either the old or new server.
   */
  it('stays dark for a new server that cannot be reached', async () => {
    jest.useFakeTimers();
    const getServerUpdates = jest.fn().mockResolvedValue(available);
    createClient.mockReturnValue(fakeClient(getServerUpdates));

    const { result, rerender } = renderHook(() => useServerUpdateBadge(true));
    await act(async () => undefined);
    expect(result.current).toBe(true);

    baseUrl.mockReturnValue('http://server-b');
    getServerUpdates.mockRejectedValue(new Error('unreachable'));
    rerender(undefined);
    await act(async () => {
      jest.advanceTimersByTime(SERVER_UPDATE_BADGE_POLL_MS);
    });
    expect(result.current).toBe(false);
  });

  it('clears an available answer when that server disappears for update activation', async () => {
    jest.useFakeTimers();
    const getServerUpdates = jest.fn().mockResolvedValue(available);
    createClient.mockReturnValue(fakeClient(getServerUpdates));

    const { result } = renderHook(() => useServerUpdateBadge(true));
    await act(async () => undefined);
    expect(result.current).toBe(true);

    getServerUpdates.mockRejectedValue(new Error('update cutover'));
    await act(async () => {
      jest.advanceTimersByTime(SERVER_UPDATE_BADGE_POLL_MS);
    });
    expect(result.current).toBe(false);
  });

  it('goes dark when the server is unpaired', async () => {
    jest.useFakeTimers();
    const getServerUpdates = jest.fn().mockResolvedValue(available);
    createClient.mockReturnValue(fakeClient(getServerUpdates));

    const { result } = renderHook(() => useServerUpdateBadge(true));
    await act(async () => undefined);
    expect(result.current).toBe(true);

    // No server configured any more: there is nothing the dot could be about.
    createClient.mockReturnValue(null);
    baseUrl.mockReturnValue(null);
    await act(async () => {
      jest.advanceTimersByTime(SERVER_UPDATE_BADGE_POLL_MS);
    });
    expect(result.current).toBe(false);
  });

  /**
   * Polling stops on every screen but the overview, and a session can be open for
   * a long time. Whatever was true when the operator navigated away is not what
   * they should be shown on the way back, before the first fresh answer arrives.
   */
  it('forgets what it knew while it was not polling', async () => {
    const getServerUpdates = jest.fn().mockResolvedValue(available);
    createClient.mockReturnValue(fakeClient(getServerUpdates));

    const { result, rerender } = renderHook(({ on }: { on: boolean }) => useServerUpdateBadge(on), {
      initialProps: { on: true },
    });
    await waitFor(() => expect(result.current).toBe(true));

    rerender({ on: false });
    // Back on the overview, with a server that now answers nothing: the dot must
    // come from a fresh answer, not from the one before the pause.
    createClient.mockReturnValue(null);
    rerender({ on: true });
    expect(result.current).toBe(false);
  });
});
