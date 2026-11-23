import type { ChangeSubmissionState, VerityClient } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ChangeSubmissionBar } from './ChangeSubmissionBar';

function client(states: ChangeSubmissionState[]) {
  const read = jest.fn(async () => (states.length > 1 ? states.shift()! : states[0]!));
  const submit = jest.fn(async () => null);
  return {
    api: { changeSubmissions: { read, submit } } as unknown as VerityClient,
    read,
    submit,
  };
}

const mara = { id: 'mara', name: 'Mara' };

it('lets a member without Code submit, then shows that it waits', async () => {
  const { api, submit } = client([
    { submission: null, viewerCanCode: false, hasChanges: true },
    {
      submission: { status: 'waiting', submittedBy: mara, submittedAt: 1 },
      viewerCanCode: false,
    },
  ]);
  render(
    <ChangeSubmissionBar
      client={api}
      sessionId="s1"
      pullRequestShown={false}
      busy={false}
      onOpenPullRequest={jest.fn()}
    />,
  );
  fireEvent.press(await screen.findByText('Submit changes'));
  await waitFor(() => expect(submit).toHaveBeenCalledWith('s1'));
  expect(await screen.findByText('Waiting for a developer')).toBeTruthy();
});

it('asks the agent for a pull request when a member with Code opens one', async () => {
  const { api } = client([
    { submission: { status: 'waiting', submittedBy: mara, submittedAt: 1 }, viewerCanCode: true },
  ]);
  const onOpenPullRequest = jest.fn(async () => true);
  render(
    <ChangeSubmissionBar
      client={api}
      sessionId="s1"
      pullRequestShown={false}
      busy={false}
      onOpenPullRequest={onOpenPullRequest}
    />,
  );
  expect(await screen.findByText('Mara submitted changes')).toBeTruthy();
  fireEvent.press(screen.getByText('Open PR'));
  await waitFor(() =>
    expect(onOpenPullRequest).toHaveBeenCalledWith(
      'Open a pull request with the changes Mara submitted in this session.',
    ),
  );
});

it('stays hidden while the server cannot be read', async () => {
  const read = jest.fn(async () => {
    throw new Error('offline');
  });
  const api = { changeSubmissions: { read } } as unknown as VerityClient;
  const view = render(
    <ChangeSubmissionBar
      client={api}
      sessionId="s1"
      pullRequestShown={false}
      busy={false}
      onOpenPullRequest={jest.fn()}
    />,
  );
  await waitFor(() => expect(read).toHaveBeenCalled());
  expect(view.toJSON()).toBeNull();
});

it('says so when the agent did not get the request', async () => {
  const { api } = client([
    { submission: { status: 'waiting', submittedBy: mara, submittedAt: 1 }, viewerCanCode: true },
  ]);
  render(
    <ChangeSubmissionBar
      client={api}
      sessionId="s1"
      pullRequestShown={false}
      busy={false}
      onOpenPullRequest={jest.fn(async () => false)}
    />,
  );
  fireEvent.press(await screen.findByText('Open PR'));
  expect(await screen.findByText('The message to the agent was not sent. Try again.')).toBeTruthy();
});

it('asks the agent once for two quick taps', async () => {
  const { api } = client([
    { submission: { status: 'waiting', submittedBy: mara, submittedAt: 1 }, viewerCanCode: true },
  ]);
  const onOpenPullRequest = jest.fn(async () => true);
  render(
    <ChangeSubmissionBar
      client={api}
      sessionId="s1"
      pullRequestShown={false}
      busy={false}
      onOpenPullRequest={onOpenPullRequest}
    />,
  );
  const button = await screen.findByText('Open PR');
  fireEvent.press(button);
  fireEvent.press(button);
  await waitFor(() => expect(onOpenPullRequest).toHaveBeenCalled());
  expect(onOpenPullRequest).toHaveBeenCalledTimes(1);
});
