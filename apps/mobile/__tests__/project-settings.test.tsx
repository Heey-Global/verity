// The project entry route. The settings screens themselves are covered in
// `project-settings-routes.test.tsx`.
import { render, waitFor } from '@testing-library/react-native';
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

// With the new design preview off (the default), the entry still opens the
// settings. It decides once the stored choice is read, so the redirect is awaited;
// the preview's own route behaviour is covered in `project-page.test.tsx`.
it('opens project settings from the project entry route without the preview', async () => {
  render(<ProjectEntry />);
  await waitFor(() =>
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/project/[id]/settings',
      params: { id: 'p/1' },
    }),
  );
});
