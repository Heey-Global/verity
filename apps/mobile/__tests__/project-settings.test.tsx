// The project entry route. The settings screens themselves are covered in
// `project-settings-routes.test.tsx`.
import { render } from '@testing-library/react-native';
import { router } from 'expo-router';

// Expo Router exposes a fixed project id and records navigation destinations.
jest.mock('expo-router', () => ({
  Redirect: ({ href }: { href: unknown }) => {
    jest.requireMock<typeof import('expo-router')>('expo-router').router.replace(href as never);
    return null;
  },
  router: { replace: jest.fn() },
  useLocalSearchParams: () => ({ id: 'p/1' }),
}));

import ProjectEntry from '../app/project/[id]';

const mockRouter = router as unknown as { replace: jest.Mock };

it('opens project settings directly from the project entry route', () => {
  render(<ProjectEntry />);
  expect(mockRouter.replace).toHaveBeenCalledWith({
    pathname: '/project/[id]/settings',
    params: { id: 'p/1' },
  });
});
