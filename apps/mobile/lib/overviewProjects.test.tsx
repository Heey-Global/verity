import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ProjectRecord, VerityClient } from '@verity/mobile';
import { useOverviewProjects } from './overviewProjects';
import { useOverviewStore } from './overviewTopics';

jest.mock('./client', () => ({ getVerityBaseUrl: () => 'https://core.example' }));
jest.mock('./liveConnection', () => ({ liveConnectionFor: () => ({}) }));

const project = (id: string, extra: Partial<ProjectRecord> = {}) =>
  ({ id, name: id, kind: 'local', state: 'active', ...extra }) as ProjectRecord;

describe('useOverviewProjects', () => {
  it('reads only while active, then follows the shared copy', async () => {
    const listProjects = jest.fn().mockResolvedValue([project('p1'), project('p2')]);
    const client = { listProjects } as unknown as VerityClient;
    const shared = renderHook(() => useOverviewStore('https://core.example'));
    const { result, rerender } = renderHook(({ active }) => useOverviewProjects(client, active), {
      initialProps: { active: false },
    });
    expect(listProjects).not.toHaveBeenCalled();
    rerender({ active: true });
    await waitFor(() => expect(result.current.map((p) => p.id)).toEqual(['p1', 'p2']));

    // Another view's read, such as Home's, renames a project: shown at once.
    act(() => {
      const store = shared.result.current;
      store.applyProjects(store.beginRead(), [project('p1', { name: 'Renamed' })], {
        covers: (p) => p.id === 'p1',
      });
    });
    expect(result.current.find((p) => p.id === 'p1')?.name).toBe('Renamed');
    expect(listProjects).toHaveBeenCalledTimes(1);
    shared.unmount();
  });
});
