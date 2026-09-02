import type { ExpoConfig } from 'expo/config';

// The official Verity EAS project ID is public configuration. Forks can point
// their builds at a different Expo project without editing this file.
const expoProjectId = process.env.EXPO_PROJECT_ID?.trim() || 'b38b4675-5fef-4eb5-bf4c-492c3e21e717';
// OAuth client IDs are public application identifiers. Keep the official iOS
// client reproducible in source; forks can override it alongside their bundle ID.
const officialGoogleOAuthClientId =
  '340053543157-ohufghcdnc5do2lkjg7cgnkk67oac0e7.apps.googleusercontent.com';
const googleOAuthClientId = process.env.GOOGLE_AUTH_ID?.trim() || officialGoogleOAuthClientId;
const expoUpdateChannel = process.env.EXPO_UPDATE_CHANNEL?.trim();
const iosBuildNumber = process.env.VERITY_IOS_BUILD_NUMBER?.trim();
const googleOAuthClientPattern = /^[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com$/;

if (!googleOAuthClientPattern.test(googleOAuthClientId)) {
  throw new Error('GOOGLE_AUTH_ID must be a Google iOS OAuth client ID');
}
if (iosBuildNumber && !/^[0-9]+$/.test(iosBuildNumber)) {
  throw new Error('VERITY_IOS_BUILD_NUMBER must be numeric');
}

const googleOAuthScheme = `com.googleusercontent.apps.${googleOAuthClientId.replace(/\.apps\.googleusercontent\.com$/, '')}`;

// Expo config (SDK 57). New Arch is forced by SDK 57 (no `newArchEnabled`
// field). EAS Update checks on launch; native build workflows inject the target
// channel and the OTA workflow publishes compatible updates.
const config: ExpoConfig = {
  name: 'Verity',
  slug: 'verity',
  // The Google scheme must be registered in the native binary before its OAuth
  // redirect can return from the system browser.
  scheme: ['verity', googleOAuthScheme],
  version: '1.15.0', // x-release-please-version
  // iPad and iPad-on-Mac should adapt to the user's current window/device
  // orientation, especially with Magic Keyboard or Stage Manager. Phone layouts
  // still render portrait-first through the app's responsive UI constraints.
  orientation: 'default',
  // The app is dark-only (Unistyles `initialTheme: 'dark'`). Force the native iOS
  // interface style to dark so system chrome — the photo picker, keyboard, action
  // sheets and alerts — matches instead of rendering light on a dark app.
  userInterfaceStyle: 'dark',
  // Brand mark: the magenta-to-cyan Verity V on a near-black tile. iOS uses this
  // square directly (the OS applies the rounded-superellipse mask); Android uses
  // the matching transparent mark in the adaptive icon below.
  icon: './assets/icon.png',
  updates: {
    url: `https://u.expo.dev/${expoProjectId}`,
    // GitHub's native build does not receive an EAS build profile. Its release
    // workflow supplies the channel explicitly; development and preview builds
    // must not inherit the TestFlight channel.
    ...(expoUpdateChannel ? { requestHeaders: { 'expo-channel-name': expoUpdateChannel } } : {}),
    // Let the native runtime start a non-blocking update check as early as possible
    // (fallbackToCacheTimeout=0), while the root JS gate/foreground sync actively
    // downloads + reloads compatible updates so they apply without multiple manual
    // restarts.
    checkAutomatically: 'ON_LOAD',
    fallbackToCacheTimeout: 0,
  },
  owner: 'heey',
  // Shared iOS and Android application identifier (reverse-DNS of verity.build).
  ios: {
    bundleIdentifier: 'build.verity.app',
    ...(iosBuildNumber ? { buildNumber: iosBuildNumber } : {}),
    // Enables native iPad builds and lets App Store Connect/TestFlight offer the
    // same iPad binary on Apple Silicon Macs unless Mac availability is disabled
    // there.
    supportsTablet: true,
    infoPlist: {
      // Verity uses only standard/exempt encryption; declaring export compliance
      // stops EAS/App Store Connect prompting for it on every build.
      ITSAppUsesNonExemptEncryption: false,
      // The control-plane server is reached over Tailscale by its bare MagicDNS
      // hostname over plain HTTP (http://dev-server:8082). iOS App Transport
      // Security blocks cleartext by default; NSAllowsLocalNetworking permits it
      // for unqualified (dot-less) hostnames like `dev-server` without disabling
      // ATS globally. The tailnet transport is itself encrypted.
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
      },
    },
  },
  android: {
    package: 'build.verity.app',
    // Adaptive icon: the Verity V as a transparent foreground (padded into the
    // mask safe zone) over a true-black background, so any launcher mask shape
    // keeps the mark centered and uncropped.
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#06030d',
    },
  },
  web: { favicon: './assets/favicon.png' },
  plugins: [
    'expo-router',
    [
      'expo-camera',
      {
        cameraPermission: 'Allow Verity to scan a secure server pairing code.',
        barcodeScannerEnabled: true,
      },
    ],
    // Secure, OS-keychain-backed storage for the per-device API bearer token
    // (audit C1). Sensitive items use native keychain authentication at read time.
    'expo-secure-store',
    // Biometric unlock (Face ID / Touch ID) protecting the stored bearer token.
    // Sets the iOS NSFaceIDUsageDescription.
    [
      'expo-local-authentication',
      {
        faceIDPermission: 'Allow Verity to unlock your saved sign-in with Face ID.',
      },
    ],
    // Launch screen: the Verity V centered on midnight (matches the AMOLED
    // dark theme, so there's no flash of a light screen before the app mounts).
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 200,
        resizeMode: 'contain',
        backgroundColor: '#06030d',
      },
    ],
    // Reliable device-locale list (getLocales) for dictation language selection —
    // Hermes' Intl returns a UI-language + region combo (e.g. en-DE) that isn't a
    // valid recognition locale.
    'expo-localization',
    // Live voice dictation (§6) via the OS speech recognizer. Sets the iOS
    // NSMicrophoneUsageDescription + NSSpeechRecognitionUsageDescription, and
    // declares Google's recognition service so Android can bind to it.
    [
      'expo-speech-recognition',
      {
        microphonePermission: 'Allow Verity to use the microphone for voice dictation.',
        speechRecognitionPermission: 'Allow Verity to transcribe your speech to text.',
        androidSpeechServicePackages: ['com.google.android.googlequicksearchbox'],
      },
    ],
    // Efficient image rendering (chat attachments + previews).
    'expo-image',
    // Native share-sheet integration for exporting session content and files.
    'expo-sharing',
    // Attach screenshots/photos from the library or camera into a prompt.
    [
      'expo-image-picker',
      {
        photosPermission: 'Allow Verity to attach screenshots and images from your library.',
        cameraPermission: 'Allow Verity to attach photos you take.',
      },
    ],
    // Push notifications (ADR 0008): permission prompt/turn-done/crash alerts and
    // the lock-screen quick-reply categories. The APNs entitlement + key are wired
    // through EAS credentials; this plugin sets up the native module. Notifications
    // are fail-safe — a deployment with push disabled skips the permission prompt.
    'expo-notifications',
    // System-browser auth session for the Google Drive OAuth (PKCE) connect flow
    // (ADR 0009). Uses ASWebAuthenticationSession on iOS so the redirect returns
    // into the app via its reversed-client-id scheme.
    'expo-web-browser',
  ],
  experiments: {
    typedRoutes: true,
    // Native iOS drop target for Finder/Desktop files. Expo discovers the Swift
    // view during prebuild and includes it in the generated app target.
    inlineModules: { watchedDirectories: ['native'] },
  },
  extra: { eas: { projectId: expoProjectId } },
};

// A native X.Y.0 release owns exactly one OTA line. Version fields are excluded
// from Expo fingerprints, so an explicit runtime string is required to guarantee
// that X.(Y+1).x updates can never reach an older X.Y.0 installation.
if (!config.version) throw new Error('Mobile release version is required');
const [runtimeMajor, runtimeMinor] = config.version.split('.');
config.runtimeVersion = `${runtimeMajor}.${runtimeMinor}.0`;

export default config;
