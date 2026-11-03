import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
import { QAApprovalCard } from '../components/QAApprovalCard';
it('explains standing consent and submits only the selected project proposal', async () => {
  const decideQAApproval = jest.fn().mockResolvedValue(undefined);
  const client = {
    qaApprovals: jest.fn().mockResolvedValue({
      proposals: [
        { id: 'proposal', project_id: 'p', owner: 'team', repo: 'app', resource: 'pr:42' },
      ],
    }),
    decideQAApproval,
  } as unknown as VerityClient;
  render(<QAApprovalCard client={client} sessionId="qa" />);
  await screen.findByText(/also permits future repairs/);
  expect(decideQAApproval).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Allow automatic repairs for this project' }));
  await waitFor(() => expect(decideQAApproval).toHaveBeenCalledWith('p', 'proposal', true));
});
