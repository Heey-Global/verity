import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
import { ProjectRepositories } from '../components/project/ProjectRepositories';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());

jest.mock('../lib/useScanResource', () => ({
  useScanResource: (load: () => Promise<unknown>) => {
    const React = jest.requireActual<typeof import('react')>('react');
    const [data, setData] = React.useState<unknown>();
    React.useEffect(() => {
      void load().then(setData);
    }, [load]);
    return { data, error: undefined, setError: jest.fn(), reload: jest.fn() };
  },
}));

const connected = (name: string, repo: string, isDefault: boolean) => ({
  id: name,
  projectId: 'campaign',
  name,
  kind: 'github',
  owner: 'northwind',
  repo,
  forgeConnectionId: null,
  defaultBranch: null,
  isDefault,
  removedAt: null,
});

// `shop` is the default repository of some other project. It must stay on
// offer here; only the repositories this project already has are left out.
const available = ['api', 'campaign', 'shop', 'shipping'].map((repo) => ({
  id: `repository:northwind/${repo}`,
  owner: 'northwind',
  repo,
}));

function setup() {
  const addProjectRepository = jest.fn().mockResolvedValue(undefined);
  const client = {
    listProjectRepositories: jest
      .fn()
      .mockResolvedValue([connected('campaign', 'campaign', true), connected('api', 'api', false)]),
    getVeritySettings: jest.fn().mockResolvedValue({ githubAppInstallationId: 1 }),
    listConnections: jest.fn().mockResolvedValue(null),
    listAvailableRepositories: jest.fn().mockResolvedValue(available),
    addProjectRepository,
    removeProjectRepository: jest.fn(),
  } as unknown as VerityClient;
  const view = render(<ProjectRepositories client={client} projectId="campaign" />);
  return { view, addProjectRepository };
}

it('lists connected repositories compactly and removes only additional ones', async () => {
  const { view } = setup();
  await waitFor(() => expect(view.getByText('northwind/api')).toBeTruthy());

  expect(view.getByText('Default')).toBeTruthy();
  expect(view.getByLabelText('Remove api')).toBeTruthy();
  expect(view.queryByLabelText('Remove campaign')).toBeNull();
  // The picker stays closed until the operator asks to add something.
  expect(view.queryByText('northwind/shop')).toBeNull();
});

it('adds a repository another project uses with one tap, named after it', async () => {
  const { view, addProjectRepository } = setup();
  await waitFor(() => expect(view.getByText('Add repository')).toBeTruthy());
  await waitFor(() => expect(view.getByText('Add repository')).toBeEnabled());

  fireEvent.press(view.getByText('Add repository'));
  await waitFor(() => expect(view.getByText('northwind/shop')).toBeTruthy());
  // Repositories already in this project are not offered a second time.
  expect(view.getAllByText('northwind/api')).toHaveLength(1);
  expect(view.queryByLabelText('Add northwind/campaign')).toBeNull();

  fireEvent.changeText(view.getByPlaceholderText('Search GitHub repositories'), 'sh');
  expect(view.queryByText('northwind/shop')).toBeTruthy();
  expect(view.queryByLabelText('Add northwind/api')).toBeNull();

  fireEvent.press(view.getByLabelText('Add northwind/shop'));
  await waitFor(() =>
    expect(addProjectRepository).toHaveBeenCalledWith('campaign', {
      name: 'shop',
      kind: 'github',
      owner: 'northwind',
      repo: 'shop',
    }),
  );
});
