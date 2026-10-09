import { main } from '../package.json';

it('selects the theme before Expo Router loads themed routes', () => {
  jest.resetModules();
  const configure = jest.fn();
  const loadRouter = jest.fn(() => {
    // Jest setup preconfigures themes, hiding startup ordering failures in UI tests.
    expect(configure).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { initialTheme: 'dark' } }),
    );
  });

  jest.doMock('react-native-unistyles', () => ({ StyleSheet: { configure } }));
  jest.doMock('expo-router/entry', () => {
    loadRouter();
    return {};
  });

  try {
    jest.isolateModules(() => {
      require(`../${main}`);
    });
    expect(loadRouter).toHaveBeenCalledTimes(1);
  } finally {
    jest.dontMock('react-native-unistyles');
    jest.dontMock('expo-router/entry');
  }
});
