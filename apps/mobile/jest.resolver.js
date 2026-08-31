// Jest module resolver: the React Native one jest-expo installs by default, plus
// the react-native-worklets shim.
//
// Reanimated 4 delegates its runtime bootstrap to react-native-worklets, whose
// `*.native.ts` entry points call into a TurboModule and throw "Native part of
// Worklets doesn't seem to be initialized" the moment they are imported under jest.
// react-native-worklets ships a resolver that drops the `.native` extensions for
// its own requires so the plain JS implementations load instead — but jest takes a
// SINGLE resolver, and jest-expo already installs React Native's, which every other
// platform-suffixed module still needs. So apply the worklets rule here and
// delegate to the RN resolver rather than replacing it.
const rnResolver = require('@react-native/jest-preset/jest/resolver');

/** @type {import('jest-resolve').SyncResolver} */
module.exports = (request, options) => {
  if (
    options.basedir.includes('react-native-worklets') ||
    request.includes('react-native-worklets')
  ) {
    options = {
      ...options,
      extensions: options.extensions?.filter((ext) => !ext.includes('native')),
    };
  }
  return rnResolver(request, options);
};
