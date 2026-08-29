// Jest setup for the Expo app. Runs after the test framework is installed
// (`setupFilesAfterEnv`), so `jest` is in scope and RNTL's built-in matchers are
// already registered (RNTL >= 12.4 auto-extends `expect` on import — no separate
// `@testing-library/jest-native` import needed).

// Unistyles v3 is native-only (NitroModules / TurboModules): importing the real
// module in jest throws `TurboModuleRegistry.getEnforcing('NitroModules')`. The
// library ships an official jest mock at `react-native-unistyles/mocks` that
// `jest.mock`s both `react-native-unistyles` and `react-native-nitro-modules`.
// Importing it registers those mocks (jest hoists the `jest.mock` calls inside).
import 'react-native-unistyles/mocks';

// react-native-safe-area-context ships a Jest mock that returns static insets so
// `useSafeAreaInsets()` resolves without a real native provider.
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

// react-native-gesture-handler's native module is absent in jest; its shipped
// jestSetup swaps RNGestureHandlerModule (and the native-backed buttons) for JS
// mocks, so `GestureHandlerRootView` / `GestureDetector` render. Needed by the
// image lightbox's pinch/pan gestures.
import 'react-native-gesture-handler/jestSetup';

// Expo 57 resolves vector-icon fonts through the runtime asset registry, where
// Jest's numeric font module has no registered Metro asset. Tests exercise our
// icon wrapper's layout and interaction, not the native font loader, so keep a
// lightweight host component while preserving every prop for assertions.
jest.mock('@expo/vector-icons/Feather', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => React.createElement('Feather', props),
  };
});

// AsyncStorage's native module is null in jest; its shipped in-memory mock backs
// the app's base-URL / push-outbox persistence so storage-touching modules import
// cleanly (importing the real module throws "NativeModule: AsyncStorage is null").
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// The unistyles mock starts with an EMPTY theme registry, so `StyleSheet.create`
// would resolve `(theme) => …` against `{}` and blow up on `theme.colors.…`.
// Importing the app's `unistyles` module calls the mock's `StyleSheet.configure`
// with the real dark/light tokens, populating the registry — mirroring the root
// layout's `import '../unistyles'` side effect that every screen relies on.
import './unistyles';

// Raise the default async-query timeout (RNTL default is 1000 ms). The screens
// resolve their initial state through async client calls (getSecretStatus +
// getVeritySettings) before the status-driven UI renders; on a cold CI runner
// the FIRST test also pays the one-time module-transform cost, which can push
// that first render past 1 s and occasionally beyond 5 s on a loaded shared
// runner. Ten seconds still fails quickly on a genuine hang and stays below the
// 15-second per-test ceiling in jest.config.js.
import { configure } from '@testing-library/react-native';
configure({ asyncUtilTimeout: 10_000 });
