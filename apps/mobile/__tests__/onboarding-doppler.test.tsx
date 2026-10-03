import { render } from '@testing-library/react-native';
import OnboardingDoppler from '../app/onboarding/doppler';
import OnboardingGithub from '../app/onboarding/github';
const mockRedirect = jest.fn();
jest.mock('expo-router', () => ({
  Redirect: (props: { href: string }) => {
    mockRedirect(props.href);
    return null;
  },
}));
afterEach(() => mockRedirect.mockClear());
it('opens Connections for a legacy Doppler setup link', () => {
  render(<OnboardingDoppler />);
  expect(mockRedirect).toHaveBeenCalledWith('/settings/services/doppler');
});
it('opens GitHub settings for a legacy GitHub setup link', () => {
  render(<OnboardingGithub />);
  expect(mockRedirect).toHaveBeenCalledWith('/settings/github');
});
