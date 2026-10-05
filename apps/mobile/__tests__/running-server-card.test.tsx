import { fireEvent, render, screen } from '@testing-library/react-native';
import { openFailureAlert, RunningServerCard } from '../components/project/RunningServerCard';

const server = {
  port: 3033,
  reachable: true,
  pid: 1,
  name: 'Curtis Demo',
  command: 'node server.mjs',
  workdir: '.',
};

// A bare port number in the title meant nothing to anyone who had not started
// the server; the card has to say what is running and that it is up.
it('names the server and its state instead of its port', () => {
  const onOpen = jest.fn();
  const onShare = jest.fn();
  render(
    <RunningServerCard
      server={server}
      opening={false}
      disabled={false}
      onOpen={onOpen}
      onShare={onShare}
    />,
  );
  expect(screen.getByText(/Server running/)).toBeTruthy();
  expect(screen.queryByText(/3033/)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Open Curtis Demo on your network' }));
  fireEvent.press(screen.getByRole('button', { name: 'Share Curtis Demo over the internet' }));
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onShare).toHaveBeenCalledTimes(1);
});

// Core's "nothing listens on that port" is accurate but tells the operator
// neither what happened nor what to do.
it('turns a vanished listener into a stopped-server message', () => {
  expect(openFailureAlert('Curtis Demo', 'nothing in this session listens on that port')).toEqual({
    title: 'Server is not running',
    body: 'Curtis Demo stopped. Ask the agent to start it again.',
  });
  expect(openFailureAlert('Curtis Demo', 'boom')).toEqual({
    title: 'Could not open preview',
    body: 'boom',
  });
});
