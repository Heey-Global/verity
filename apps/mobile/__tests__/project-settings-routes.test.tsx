// The project settings routes (app/project/[id]/settings/*): the index that
// routes to them, and each screen's own behaviour. They mirror the Verity
// settings routes — same scaffold, same row furniture, same module mocks — so
// the harness is the one the Verity settings suites share, plus a project.
//
// What is worth guarding here is that every row on the index reaches a screen
// that can act on it, that the Environment screen shows one honest state with
// the one action that answers it, and that a choice made on a screen lands on
// the server as exactly the PATCH the server expects.
import { subscribeProjectStatusMutations, type ProjectDetail } from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

jest.mock('expo-clipboard', () => require('./support/settingsHarness').clipboardMock());
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import ProjectSettingsIndexScreen from '../app/project/[id]/settings/index';
import ProjectEnvironmentScreen from '../app/project/[id]/settings/environment';
import ProjectServicesScreen from '../app/project/[id]/settings/services';
import ProjectGitHubScreen from '../app/project/[id]/settings/github';
import ProjectModelScreen from '../app/project/[id]/settings/model';
import { healthWithRebuild, makeClient, makeDetail } from './support/projectHarness';
import {
  mockCreateVerityClient,
  mockDismissTo,
  mockPush,
  mockReplace,
  refocus,
  resetSettingsHarness,
  setSearchParams,
} from './support/settingsHarness';

beforeEach(() => {
  setSearchParams({ id: 'p/1' });
});

afterEach(() => {
  resetSettingsHarness();
  jest.restoreAllMocks();
});

describe('project settings index — destinations', () => {
  // Each row is the entry point to one of the project's settings screens, and
  // the only way to reach it. The structure follows the Verity settings index:
  // Setup first (GitHub, Connected services, Environment), then the
  // project's own defaults.
  it.each([
    ['GitHub', '/project/[id]/settings/github'],
    ['Connected services', '/project/[id]/settings/services'],
    ['Environment', '/project/[id]/settings/environment'],
    ['Default model', '/project/[id]/settings/model'],
  ])('routes %s to %s', async (label, pathname) => {
    mockCreateVerityClient.mockReturnValue(makeClient());
    render(<ProjectSettingsIndexScreen />);

    fireEvent.press(await screen.findByLabelText(label));
    expect(mockPush).toHaveBeenCalledWith({ pathname, params: { id: 'p/1' } });
  });

  it('shows the repository, the environment state and the default model without tapping in', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient({ detail: makeDetail({ defaultModel: 'codex/default' }) }),
    );
    render(<ProjectSettingsIndexScreen />);

    expect(await screen.findByText('heey-global/verity')).toBeOnTheScreen();
    expect(screen.getByText('Connected')).toBeOnTheScreen();
    // The same badge label the overview dot uses for an `absent` project.
    expect(screen.getByLabelText('Paused')).toBeOnTheScreen();
    expect(screen.getByText('Codex')).toBeOnTheScreen();
  });

  it('marks a local project as not connected to GitHub', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient({ detail: makeDetail({ kind: 'local' }) }));
    render(<ProjectSettingsIndexScreen />);

    expect(await screen.findByText('Not connected')).toBeOnTheScreen();
    expect(screen.getByText('Server default')).toBeOnTheScreen();
  });

  it('keeps every editable field off the index', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient());
    render(<ProjectSettingsIndexScreen />);

    await screen.findByLabelText('GitHub');
    expect(screen.queryByLabelText('Choose Doppler binding')).toBeNull();
    expect(screen.queryByLabelText('Start project')).toBeNull();
    expect(screen.queryByLabelText('Use the server default model')).toBeNull();
  });

  // `replace` here swapped this screen for `/` while the home it was opened from
  // stayed below it, so the overview came back carrying a back button to itself —
  // the "‹ Verity" on the top left of the project list. Popping to the existing
  // home is the whole fix, so the assertion is on which router verb runs.
  it('pops back to the existing overview after deleting a project', async () => {
    const deleteProject = jest.fn().mockResolvedValue({ projectId: 'p/1' });
    mockCreateVerityClient.mockReturnValue(makeClient({ deleteProject }));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === 'Delete')?.onPress?.();
    });
    render(<ProjectSettingsIndexScreen />);

    fireEvent.press(await screen.findByLabelText('Delete project'));

    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith('p/1'));
    await waitFor(() => expect(mockDismissTo).toHaveBeenCalledWith('/'));
    expect(mockReplace).not.toHaveBeenCalledWith('/');
    alert.mockRestore();
  });

  // The server deletes a project's sessions along with it, so the confirmation
  // must not promise the operator that they survive somewhere in the list.
  it('warns that the project sessions go with the project', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient({}));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    render(<ProjectSettingsIndexScreen />);

    fireEvent.press(await screen.findByLabelText('Delete project'));

    const [title, message] = alert.mock.calls[0];
    expect(title).toBe('Delete project?');
    expect(message).toContain('sessions and their history');
    expect(message).not.toContain('stay in the list');
    alert.mockRestore();
  });
});

describe('project settings — environment', () => {
  it('shows a running environment with a Pause action and an update affordance', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        state: 'active',
        sandboxUpdate: {
          state: 'available',
          kind: 'normal',
          category: 'software',
          reason: null,
          current: null,
          target: null,
          currentVersion: '1.22.1',
          currentRevision: null,
          targetVersion: '2.9.2',
          targetRevision: null,
          selfRepair: 'converging',
          turnBlocked: false,
        },
      },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectEnvironmentScreen />);

    // Not "Running": Verity is recreating this container onto the new image, and
    // the pill reads the same badge the overview dot pulses on. A green settled
    // "Running" beside a row saying a rebuild is in flight is the screen
    // reporting two states of one container.
    expect(await screen.findByLabelText('Updating secure workspace…')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Running')).toBeNull();
    // Still pausable — an update in flight is not a lifecycle transition.
    expect(screen.getByLabelText('Pause project')).toBeOnTheScreen();
    // The slim update row appears only because an update is available.
    expect(screen.getByLabelText('Update project environment')).toBeOnTheScreen();
    // Reads as reassurance, not as a fault: while Verity is still rebuilding the
    // sandbox the row says so, and the manual Update stays available anyway.
    expect(
      screen.getByText('Update pending — Verity is rebuilding this sandbox'),
    ).toBeOnTheScreen();
  });

  it('offers no Update button for an update a turn is holding off', async () => {
    // The silent failure this guards: the Server refuses this recreate for as long
    // as a turn runs (SBX-1), so an Update button here can only return a 409 that
    // surfaces as "Could not update project" — the operator reads a fault where
    // there is a turn, and pressing it again never helps. The dialog has to say
    // what would move it and then offer nothing that would not.
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        state: 'active',
        sandboxUpdate: {
          state: 'available',
          kind: 'normal',
          category: 'software',
          reason: null,
          current: null,
          target: null,
          currentVersion: '1.22.1',
          currentRevision: null,
          targetVersion: '2.9.2',
          targetRevision: null,
          selfRepair: 'stalled',
          turnBlocked: true,
        },
      },
    };
    const recreateProjectContainer = jest.fn();
    mockCreateVerityClient.mockReturnValue(makeClient({ detail, recreateProjectContainer }));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    render(<ProjectEnvironmentScreen />);

    expect(
      await screen.findByText('Update waiting for a turn to finish — cancel it to update now'),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByLabelText('Update project environment'));

    const [title, message, buttons] = alert.mock.calls[0];
    expect(title).toBe('Update waiting for a turn');
    expect(message).toContain('cancel the turn first');
    expect(buttons?.map((button) => button.text)).toEqual(['OK']);
    // Nothing on this path may reach the route that would 409 — or, if SBX-1 ever
    // stopped holding, kill the turn the message just promised was safe.
    buttons?.forEach((button) => button.onPress?.());
    expect(recreateProjectContainer).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  // The Environment screen is where Start/Repair/Update live, so the finding and
  // the action that answers it are on the same surface.
  it('explains toolkit drift next to the environment actions', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        toolkitDrift: { verdict: 'drifted', carrier: 'devcontainer' },
      },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectEnvironmentScreen />);

    expect(
      await screen.findByText(/attestation verdict no longer holds and needs re-checking/),
    ).toBeOnTheScreen();
    expect(screen.getByText(/rebuilds and re-attests it/)).toBeOnTheScreen();
  });

  // A base-image project must not be told to repair its way out of this: only a
  // rebuilt base image changes what that image contains.
  it('does not promise a rebuild for a base-image project', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        toolkitDrift: { verdict: 'drifted', carrier: 'base-image' },
      },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectEnvironmentScreen />);

    expect(await screen.findByText(/only a rebuilt base image fixes it/)).toBeOnTheScreen();
  });

  it('stays silent when the recorded toolkit matches', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        toolkitDrift: { verdict: 'matches', carrier: 'devcontainer' },
      },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectEnvironmentScreen />);

    expect(await screen.findByLabelText('Paused')).toBeOnTheScreen();
    expect(screen.queryByText(/needs re-checking/)).toBeNull();
  });

  // The warning sits beside Start/Repair/Update rather than on a facts list
  // somewhere else, and appears exactly once on the screen.
  it('surfaces a project provision warning beside the environment actions', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        provisionWarning: 'Runner supervisor is disabled after boundary attestation failed.',
      },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectEnvironmentScreen />);

    expect(
      await screen.findByText('Runner supervisor is disabled after boundary attestation failed.'),
    ).toBeOnTheScreen();
    expect(screen.queryByText('Provision warning')).toBeNull();
  });

  it('shows a rebuilding status instead of Running during an image rebuild', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        state: 'active',
        provisionWarning: 'Project image rebuild is in progress.',
      },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectEnvironmentScreen />);

    expect(await screen.findByLabelText('Rebuilding secure workspace…')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Running')).toBeNull();
  });

  // The pill reads from the shared `projectBadge`, so it names the container state
  // the same way the overview dot does — and never falls back to the raw state id
  // (it used to render a literal "container_starting" at the operator).
  // The project screen and its settings routes stack on top of each other, each
  // polling the same project. Only an ACTION's response may go on the status
  // bus: a published poll result would land in the other instances as a pending
  // mutation that outranks their own newer fetch, so an older poll could roll a
  // visible screen back from Running to Starting.
  it('publishes an action result to the status bus but never a poll result', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = { ...base, project: { ...base.project, state: 'active' } };
    const deprovisionProject = jest.fn().mockResolvedValue({ ...detail.project, state: 'absent' });
    mockCreateVerityClient.mockReturnValue(makeClient({ detail, deprovisionProject }));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === 'Pause')?.onPress?.();
    });
    const published = jest.fn();
    const unsubscribe = subscribeProjectStatusMutations(published);
    render(<ProjectEnvironmentScreen />);

    fireEvent.press(await screen.findByLabelText('Pause project'));
    await waitFor(() => expect(deprovisionProject).toHaveBeenCalledWith('p/1', { purge: false }));
    await waitFor(() => expect(published).toHaveBeenCalledTimes(1));
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ id: 'p/1', state: 'absent' }));
    expect(await screen.findByLabelText('Start project')).toBeOnTheScreen();
    unsubscribe();
    alert.mockRestore();
  });

  // Every stacked screen sees the same `pending` status on load; without a
  // shared guard each would PATCH it, and the server would take three writes
  // for one migration.
  it('migrates a pending setup status once for the whole project stack', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: { ...base.project, setupStatus: 'pending' },
    };
    let finishPatch: (() => void) | undefined;
    const setProjectSetupStatus = jest.fn(
      () =>
        new Promise((resolve) => {
          finishPatch = () => resolve({ ...detail.project, setupStatus: 'complete' });
        }),
    );
    mockCreateVerityClient.mockReturnValue(makeClient({ detail, setProjectSetupStatus }));
    render(
      <>
        <ProjectSettingsIndexScreen />
        <ProjectEnvironmentScreen />
      </>,
    );

    expect(await screen.findByLabelText('Delete project')).toBeOnTheScreen();
    expect(await screen.findByLabelText('Start project')).toBeOnTheScreen();
    await waitFor(() => expect(setProjectSetupStatus).toHaveBeenCalledWith('p/1', 'complete'));
    expect(setProjectSetupStatus).toHaveBeenCalledTimes(1);
    // Settling the PATCH must not let the second instance, whose own fetch
    // still says `pending`, take its turn at the same migration.
    await act(async () => {
      finishPatch?.();
    });
    expect(setProjectSetupStatus).toHaveBeenCalledTimes(1);
  });

  it('offers Start for a paused environment and hides the update row', async () => {
    // The default fixture is `absent` (paused) with no sandbox update.
    mockCreateVerityClient.mockReturnValue(makeClient({ detail: makeDetail() }));
    render(<ProjectEnvironmentScreen />);

    expect(await screen.findByLabelText('Paused')).toBeOnTheScreen();
    expect(screen.getByLabelText('Start project')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Update project environment')).toBeNull();
  });

  it('offers Repair for a failed environment', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = { ...base, project: { ...base.project, state: 'failed' } };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectEnvironmentScreen />);

    expect(await screen.findByLabelText('Needs repair')).toBeOnTheScreen();
    expect(screen.getByLabelText('Repair project')).toBeOnTheScreen();
  });

  it('offers Repair while an environment is starting', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: { ...base.project, state: 'container_starting', setupStatus: 'complete' },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectEnvironmentScreen />);

    expect(await screen.findByLabelText('Starting secure workspace…')).toBeOnTheScreen();
    expect(screen.queryByLabelText('container_starting')).toBeNull();
    expect(screen.getByLabelText('Repair project')).toBeOnTheScreen();
  });

  // The escape hatch for a devcontainer change the image cache cannot see:
  // Update and Repair both reuse the content-hash-cached tag, so only this
  // action rebuilds. It has to reach the server as an explicit `forceRebuild`,
  // otherwise it is just another Repair.
  it('rebuilds the image without the build cache when asked to', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        state: 'active',
        imageRef: 'verity-devc-heey-global-verity:0123456789ab',
      },
    };
    const recreateProjectContainer = jest.fn().mockResolvedValue(detail.project);
    mockCreateVerityClient.mockReturnValue(
      makeClient({ detail, recreateProjectContainer, getHealth: healthWithRebuild() }),
    );
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === 'Rebuild')?.onPress?.();
    });
    render(<ProjectEnvironmentScreen />);

    fireEvent.press(await screen.findByLabelText('Rebuild project image'));

    await waitFor(() =>
      expect(recreateProjectContainer).toHaveBeenCalledWith('p/1', {
        confirmWarnings: true,
        forceRebuild: true,
      }),
    );
    expect(alert.mock.calls[0][0]).toBe('Rebuild image?');
    alert.mockRestore();
  });

  // The canonical reason to want a cacheless rebuild: the project built once and
  // now fails. `imageRef` names the last SUCCESSFUL provision and survives a
  // failed one, so the action has to still be there in that state.
  it('offers the rebuild action for a failed project that built once', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        state: 'failed',
        imageRef: 'verity-devc-heey-global-verity:0123456789ab',
      },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail, getHealth: healthWithRebuild() }));
    render(<ProjectEnvironmentScreen />);

    expect(await screen.findByLabelText('Repair project')).toBeOnTheScreen();
    expect(await screen.findByLabelText('Rebuild project image')).toBeOnTheScreen();
  });

  // A project running the pulled sandbox image has no build of its own to redo,
  // and a paused one has no container the server would accept a recreate for.
  it('hides the rebuild action for a base-image project and while paused', async () => {
    const base = makeDetail();
    const pulled: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        state: 'active',
        imageRef: 'ghcr.io/heey-global/verity-sandbox@sha256:abc',
      },
    };
    mockCreateVerityClient.mockReturnValue(
      makeClient({ detail: pulled, getHealth: healthWithRebuild() }),
    );
    const view = render(<ProjectEnvironmentScreen />);

    expect(await screen.findByLabelText('Pause project')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Rebuild project image')).toBeNull();
    view.unmount();

    const paused: ProjectDetail = {
      ...base,
      project: { ...base.project, imageRef: 'verity-devc-heey-global-verity:0123456789ab' },
    };
    mockCreateVerityClient.mockReturnValue(
      makeClient({ detail: paused, getHealth: healthWithRebuild() }),
    );
    render(<ProjectEnvironmentScreen />);

    expect(await screen.findByLabelText('Start project')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Rebuild project image')).toBeNull();
  });

  // The app ships on its own release train, and the server's recreate body schema
  // is non-strict: an older server would STRIP `forceRebuild` and recreate from
  // the cached image, so the operator would wait out a rebuild that rebuilt
  // nothing. Hide the action until the server says it honours the flag.
  it('hides the rebuild action from a server that does not report the capability', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        state: 'active',
        imageRef: 'verity-devc-heey-global-verity:0123456789ab',
      },
    };
    mockCreateVerityClient.mockReturnValue(
      makeClient({
        detail,
        // An older server: liveness only, no capability keys at all.
        getHealth: jest.fn().mockResolvedValue({ status: 'ok' }),
      }),
    );
    render(<ProjectEnvironmentScreen />);

    expect(await screen.findByLabelText('Pause project')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Rebuild project image')).toBeNull();
  });
});

describe('project settings — connected services', () => {
  it('lists projects, then configs, then PATCHes { dopplerProject, dopplerConfig }', async () => {
    const listDopplerProjects = jest
      .fn()
      .mockResolvedValue({ projects: [{ slug: 'acme-app', name: 'Acme App' }] });
    const listDopplerConfigs = jest
      .fn()
      .mockResolvedValue({ configs: [{ name: 'dev', environment: 'dev', root: true }] });
    const updateProjectSettings = jest.fn().mockResolvedValue({
      ...makeDetail().settings,
      dopplerProject: 'acme-app',
      dopplerConfig: 'dev',
    });
    mockCreateVerityClient.mockReturnValue(
      makeClient({ listDopplerProjects, listDopplerConfigs, updateProjectSettings }),
    );
    render(<ProjectServicesScreen />);
    fireEvent.press(await screen.findByLabelText('Doppler'));

    // Open the picker → project list loads.
    fireEvent.press(await screen.findByLabelText('Choose Doppler binding'));
    fireEvent.press(await screen.findByLabelText('Doppler project Acme App'));
    await waitFor(() => expect(listDopplerConfigs).toHaveBeenCalledWith('acme-app'));

    // Pick a config → PATCH lands with the binding.
    fireEvent.press(await screen.findByLabelText('Doppler config dev'));
    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalledTimes(1));
    const [, patch] = updateProjectSettings.mock.calls[0];
    expect(patch).toEqual({ dopplerProject: 'acme-app', dopplerConfig: 'dev' });
  });

  it('shows the account-token hint when the list is not configured', async () => {
    const listDopplerProjects = jest.fn().mockResolvedValue({ error: 'not configured' });
    mockCreateVerityClient.mockReturnValue(makeClient({ listDopplerProjects }));
    render(<ProjectServicesScreen />);
    fireEvent.press(await screen.findByLabelText('Doppler'));

    fireEvent.press(await screen.findByLabelText('Choose Doppler binding'));
    expect(
      await screen.findByText(/Set the Doppler account token in Verity settings/),
    ).toBeOnTheScreen();
  });

  it('renders the current binding and a "Change" control when already bound', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient({
        detail: makeDetail({
          dopplerProject: 'acme-app',
          dopplerConfig: 'dev',
        }),
      }),
    );
    render(<ProjectServicesScreen />);
    fireEvent.press(await screen.findByLabelText('Doppler'));

    expect(await screen.findByText('acme-app / dev')).toBeOnTheScreen();
    expect(screen.getByLabelText('Change Doppler binding')).toBeOnTheScreen();
  });

  it('enables an MCP connection for the project with a switch', async () => {
    const setProjectMcpBinding = jest.fn().mockResolvedValue(undefined);
    mockCreateVerityClient.mockReturnValue(
      makeClient({
        listHttpMcpConnections: jest
          .fn()
          .mockResolvedValue([{ id: 'c1', name: 'Linear', enabled: true }]),
        setProjectMcpBinding,
      }),
    );
    render(<ProjectServicesScreen />);

    fireEvent.press(await screen.findByLabelText('Linear'));
    await waitFor(() => expect(setProjectMcpBinding).toHaveBeenCalledWith('p/1', 'c1', true));
  });

  it('points at the Verity MCP screen when there is nothing to enable yet', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient());
    render(<ProjectServicesScreen />);

    fireEvent.press(await screen.findByLabelText('MCP connections'));
    expect(mockPush).toHaveBeenCalledWith('/settings/services/mcp');
  });

  it('opens Matrix rooms with this project selected', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient());
    render(<ProjectServicesScreen />);

    fireEvent.press(await screen.findByLabelText('Matrix'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/settings/services/matrix',
      params: { projectId: 'p/1' },
    });
  });
});

describe('project settings — default model', () => {
  it('keeps a saved model when an older project refresh finishes afterward', async () => {
    const before = makeDetail();
    const client = makeClient({ detail: before });
    const getProject = client.getProject as jest.Mock;
    let finishRefresh: (() => void) | undefined;
    const updateProjectSettings = client.updateProjectSettings as jest.Mock;
    updateProjectSettings.mockResolvedValue({ ...before.settings, defaultModel: 'codex/default' });
    mockCreateVerityClient.mockReturnValue(client);
    render(<ProjectModelScreen />);

    expect(await screen.findByLabelText('Use model Codex, codex/default')).toBeOnTheScreen();
    const initialLoads = getProject.mock.calls.length;
    getProject.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = () => resolve(before);
        }),
    );
    act(() => refocus());
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(initialLoads + 1));

    fireEvent.press(screen.getByLabelText('Use model Codex, codex/default'));
    await waitFor(() =>
      expect(
        screen.getByLabelText('Use model Codex, codex/default').props.accessibilityState.checked,
      ).toBe(true),
    );
    await act(async () => finishRefresh?.());
    expect(
      screen.getByLabelText('Use model Codex, codex/default').props.accessibilityState.checked,
    ).toBe(true);
  });

  it('offers the server default plus the models the server can spawn', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient());
    render(<ProjectModelScreen />);

    const serverDefault = await screen.findByLabelText('Use the server default model');
    expect(serverDefault.props.accessibilityState.checked).toBe(true);
    expect(
      screen.getByLabelText('Use model Claude Sonnet 4.6, claude-sonnet-4-6'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Use model Codex, codex/default')).toBeOnTheScreen();
  });

  // The choice has to reach the server as the `defaultModel` key alone — a
  // PATCH that also carried `defaultBranch` or `memory` would clear them.
  it('PATCHes { defaultModel } when a model is picked and null for the server default', async () => {
    const updateProjectSettings = jest
      .fn()
      .mockImplementation((_id: string, patch: object) =>
        Promise.resolve({ ...makeDetail().settings, ...patch }),
      );
    mockCreateVerityClient.mockReturnValue(makeClient({ updateProjectSettings }));
    render(<ProjectModelScreen />);

    fireEvent.press(await screen.findByLabelText('Use model Codex, codex/default'));
    await waitFor(() =>
      expect(updateProjectSettings).toHaveBeenCalledWith('p/1', { defaultModel: 'codex/default' }),
    );
    expect(
      (await screen.findByLabelText('Use model Codex, codex/default')).props.accessibilityState
        .checked,
    ).toBe(true);

    fireEvent.press(screen.getByLabelText('Use the server default model'));
    await waitFor(() =>
      expect(updateProjectSettings).toHaveBeenLastCalledWith('p/1', { defaultModel: null }),
    );
  });

  // A model the server no longer offers is still what this project starts
  // sessions with. Hiding it would show nothing selected while the setting
  // silently stays in force.
  it('keeps a stored model visible and selected when the server no longer lists it', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient({ detail: makeDetail({ defaultModel: 'claude-opus-4-8' }) }),
    );
    render(<ProjectModelScreen />);

    expect(
      (await screen.findByLabelText('Use model Claude Opus 4.8, claude-opus-4-8')).props
        .accessibilityState.checked,
    ).toBe(true);
    expect(
      screen.getByLabelText('Use the server default model').props.accessibilityState.checked,
    ).toBe(false);
  });
});

describe('project settings — GitHub', () => {
  it('shows the bound repository for a GitHub project', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient());
    render(<ProjectGitHubScreen />);

    expect(await screen.findByText('heey-global/verity')).toBeOnTheScreen();
    expect(screen.getByText('No published release')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Connect project to GitHub')).toBeNull();
  });

  it('connects a local project to a repository the installation can see', async () => {
    const linkProjectToGitHub = jest
      .fn()
      .mockResolvedValue({ project: { ...makeDetail().project, kind: 'github' } });
    mockCreateVerityClient.mockReturnValue(
      makeClient({
        detail: makeDetail({ kind: 'local' }),
        listAvailableRepositories: jest
          .fn()
          .mockResolvedValue([{ ...makeDetail().project, id: 'r/1', owner: 'acme', repo: 'site' }]),
        linkProjectToGitHub,
      }),
    );
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === 'Connect')?.onPress?.();
    });
    render(<ProjectGitHubScreen />);

    fireEvent.press(await screen.findByLabelText('Connect project to GitHub'));
    await waitFor(() => expect(linkProjectToGitHub).toHaveBeenCalledWith('p/1', 'acme/site'));
    alert.mockRestore();
  });
});
