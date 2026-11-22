import { fireEvent, render, screen } from '@testing-library/react-native';

import { SecretApprovalCard } from './SecretApprovalCard';

const request = {
  tool: 'verity_http_request',
  input: {
    secretAlias: 'HEALTH_TOKEN',
    url: 'https://staging.example.com/health',
    auth: { header: 'Authorization', scheme: 'Bearer' },
  },
  secretSource: { project: 'example', config: 'stg' },
};

it('shows all allowed choices alongside the exact request details', () => {
  const allow = jest.fn();
  const deny = jest.fn();
  render(
    <SecretApprovalCard
      request={request}
      actions={{ allow, deny, deciding: false, disabled: false }}
    />,
  );

  expect(screen.getByText('staging.example.com')).toBeTruthy();
  expect(screen.getAllByText('Doppler · example / stg')).toHaveLength(2);
  expect(screen.getByText('Verity does not pass the secret value to the agent.')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Allow once' }));
  fireEvent.press(screen.getByRole('button', { name: 'Allow this session' }));
  fireEvent.press(screen.getByRole('button', { name: 'Allow in project for 30 days' }));
  fireEvent.press(screen.getByRole('button', { name: 'Deny' }));
  expect(allow.mock.calls).toEqual([[], ['session'], ['project']]);
  expect(deny).toHaveBeenCalledTimes(1);
  expect(screen.getByText('GET staging.example.com/health')).toBeTruthy();
});

it('renders the answered card with the original binding and without approval controls', () => {
  render(<SecretApprovalCard request={request} decision="once" />);

  expect(screen.getByText('Allowed once')).toBeTruthy();
  expect(screen.getByText('HEALTH_TOKEN')).toBeTruthy();
  expect(screen.getByText('Doppler · example / stg')).toBeTruthy();
  expect(screen.queryByText('Verity does not pass the secret value to the agent.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
  expect(screen.getByRole('button', { name: 'View request' })).toBeTruthy();
});

it('shows the full command and injection warning before approval', () => {
  render(
    <SecretApprovalCard
      request={{
        tool: 'verity_secret_run',
        input: {
          command: ['gh', 'api', 'rate_limit'],
          secrets: [{ secretAlias: 'GITHUB_TOKEN', env: 'GH_TOKEN' }],
        },
        secretSource: request.secretSource,
      }}
    />,
  );

  expect(screen.getAllByText('"gh" "api" "rate_limit"')).toHaveLength(2);
  expect(screen.getByText('GITHUB_TOKEN')).toBeTruthy();
  expect(screen.getByText(/Verity injects.*GH_TOKEN/)).toBeTruthy();
  expect(screen.getByText('The command can read and share the full secret.')).toBeTruthy();
});
