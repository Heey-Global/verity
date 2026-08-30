// Root layout: configures Unistyles (side-effect import, must run first), then
// mounts the provider stack (gesture handler + safe area) and the themed router
// Stack. The header colors come from the live theme via useUnistyles; the app is
// locked to the dark theme (unistyles `initialTheme: 'dark'`, not OS-adaptive).
// Component styles use StyleSheet.create.
import '../unistyles';

import { Link, Redirect, router, Stack, useGlobalSearchParams, usePathname } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  AppState,
  Appearance,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../components/Icon';
import { KeyCommands } from '../components/KeyCommands';
import { WindowControlsProbe } from '../components/WindowControls';
import { useServerUpdateBadge } from '../lib/serverUpdateBadge';
import { installHardwareKeyboardDetection } from '../hardwareKeyboard';
import { useOnboardingGate } from '../hooks/useOnboardingGate';
import { applyStartupUpdate, downloadAppUpdate } from '../lib/automaticUpdates';
import { hydrateVerityBaseUrl } from '../lib/client';
import { TASKS_ENABLED } from '../lib/featureFlags';
import { adjustFontScale, hydrateFontScale } from '../lib/fontZoom';
import { showsMessageSearch } from '../lib/headerRoutes';
import { NO_WINDOW_CONTROLS_INSET, type WindowControlsInset } from '../lib/windowControls';

// The app is dark-only. Force the native interface style to dark AT RUNTIME so all
// system chrome — keyboard, photo picker, action sheets, alerts — renders dark
// regardless of the device's system setting. This takes effect immediately (no
// native rebuild), complementing the `userInterfaceStyle: 'dark'` build-time config
// in app.config.ts (which only applies to freshly built binaries).
Appearance.setColorScheme('dark');

const FOREGROUND_UPDATE_POLL_MS = 30_000;

export default function RootLayout() {
  const { theme } = useUnistyles();
  // Learn the iPad keyboard type app-wide (see hardwareKeyboard.ts) so opening a
  // session can autofocus the composer on the first try when a hardware keyboard is
  // attached. No-op off iPad.
  useEffect(() => installHardwareKeyboardDetection(), []);

  // Restore the persisted ⌘+/⌘−/⌘0 font zoom (see lib/fontZoom.ts). Fire-and-forget:
  // it never throws and applies the scale via UnistylesRuntime once resolved.
  useEffect(() => {
    void hydrateFontScale();
  }, []);

  // Apply a compatible OTA update before the UI becomes interactive, then load
  // the persisted server base URL before the first app render. A successful
  // update schedules a native reload and deliberately leaves this launch behind
  // the gate; disabled/offline/current update states continue normally.
  // Robust: `hydrateVerityBaseUrl` never throws, and we resolve `hydrated` in every
  // case so a storage hiccup can't hard-lock the app behind the loader. Device
  // authorization is intentionally handled only by /unlock-device; doing a
  // biometric prompt here as well causes duplicate Face ID prompts during setup.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      const update = await applyStartupUpdate();
      if (update === 'reloading') return;
      await hydrateVerityBaseUrl().catch(() => undefined);
      if (active) setHydrated(true);
    })();
    return () => {
      active = false;
    };
  }, []);

  if (!hydrated) {
    return (
      <GestureHandlerRootView style={styles.root}>
        <View
          style={[styles.gateOverlay, { backgroundColor: theme.colors.background }]}
          accessibilityLabel="Checking for updates"
        >
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      </GestureHandlerRootView>
    );
  }

  return <HydratedRoot />;
}

function HydratedRoot() {
  const { theme } = useUnistyles();
  const gate = useOnboardingGate();
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ id?: string; selected?: string }>();
  const handleSearchShortcut = useCallback(
    (action: 'context' | 'global' | 'close') => {
      if (action === 'close') {
        if (pathname === '/search') router.back();
        return;
      }
      const sessionId = params.id ?? params.selected;
      router.push({
        pathname: '/search',
        params: action === 'context' && sessionId ? { sessionId } : {},
      });
    },
    [params.id, params.selected, pathname],
  );
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pathname === '/search') {
        event.preventDefault();
        handleSearchShortcut('close');
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        handleSearchShortcut(event.shiftKey ? 'global' : 'context');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSearchShortcut, pathname]);

  if (gate.status === 'checking') {
    return (
      <GestureHandlerRootView style={styles.root}>
        <View
          style={[styles.gateOverlay, { backgroundColor: theme.colors.background }]}
          accessibilityLabel="Checking setup"
        >
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      </GestureHandlerRootView>
    );
  }

  if (gate.redirectTo) {
    return <Redirect href={gate.redirectTo} />;
  }

  return (
    <KeyCommands style={styles.root} onZoom={adjustFontScale} onSearch={handleSearchShortcut}>
      <ForegroundUpdateSync />
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider>
          <Stack
            screenOptions={{
              header: (props) => <AppHeader {...props} />,
              contentStyle: { backgroundColor: theme.colors.background },
            }}
          >
            <Stack.Screen
              name="index"
              options={{
                title: 'Verity',
              }}
            />
            {/* The task backlog (ADR 0007) is a top-triggered OVERLAY, not a persistent
              bottom-tab destination: the home header's list icon opens it as a modal
              sheet (its own close/swipe-dismiss), so it lifts over the current context
              and gets out of the way — no footer nav competing with the chat composer. */}
            <Stack.Screen
              name="plan"
              options={{ presentation: 'fullScreenModal', headerShown: false }}
            />
            <Stack.Screen
              name="search"
              options={{ presentation: 'fullScreenModal', headerShown: false }}
            />
            <Stack.Screen name="session/[id]" options={{ title: 'Session' }} />
            <Stack.Screen name="project/[id]" options={{ title: 'Project' }} />
            <Stack.Screen name="new" options={{ title: 'New agent' }} />
            <Stack.Screen name="new-project" options={{ title: 'New project' }} />
            <Stack.Screen name="settings" options={{ title: 'Settings' }} />
            <Stack.Screen name="workflows" options={{ title: 'Workflows' }} />
            <Stack.Screen name="github-connect" options={{ title: 'GitHub' }} />
            <Stack.Screen name="unlock-device" options={{ headerShown: false }} />
            {/* The onboarding wizard renders its own header/progress (#320). */}
            <Stack.Screen name="onboarding" options={{ headerShown: false }} />
          </Stack>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </KeyCommands>
  );
}

function ForegroundUpdateSync() {
  useEffect(() => {
    let appState = AppState.currentState;
    const checkIfActive = (): void => {
      if (AppState.currentState === 'active') void downloadAppUpdate();
    };
    const subscription = AppState.addEventListener('change', (nextState) => {
      const becameActive = nextState === 'active' && appState !== 'active';
      appState = nextState;
      if (becameActive) void downloadAppUpdate();
    });
    const timer = setInterval(checkIfActive, FOREGROUND_UPDATE_POLL_MS);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, []);

  return null;
}

function AppHeader({
  navigation,
  route,
  options,
  back,
}: {
  navigation: { goBack: () => void };
  route: { name: string; params?: object };
  options: {
    title?: string;
    headerRight?: (props: { canGoBack: boolean; tintColor?: string }) => ReactNode;
  };
  back?: { title?: string };
}) {
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const isHome = route.name === 'index';
  // iPadOS 26 draws the window controls over the header's top-left corner without
  // reserving any safe area for them, so the row is pushed clear of whatever the
  // window's corners claim (zero everywhere else — see components/WindowControls).
  // The whole row moves, not just the buttons that are actually covered: the side
  // sections are `flex: 1`, so taking the space out of the left one alone would
  // squeeze two 44pt buttons into a third of a narrow window. The centered title
  // therefore sits half the inset right of the window's midpoint while the
  // controls are showing.
  const [windowControls, setWindowControls] =
    useState<WindowControlsInset>(NO_WINDOW_CONTROLS_INSET);
  const trackWindowControls = useCallback((next: WindowControlsInset) => {
    setWindowControls((current) =>
      current.left === next.left && current.right === next.right ? current : next,
    );
  }, []);
  const headerRowInset = useMemo(
    () => ({
      paddingLeft: theme.spacing.md + windowControls.left,
      paddingRight: theme.spacing.md + windowControls.right,
    }),
    [theme.spacing.md, windowControls.left, windowControls.right],
  );
  // Only the overview carries the settings button the dot belongs to, and every
  // screen renders this header — so the screen tells the hook whether to poll at
  // all rather than filtering its answer afterwards.
  const updateAwaitsAttention = useServerUpdateBadge(isHome);
  const showMessageSearch = showsMessageSearch(route.name);
  const title = options.title ?? (isHome ? 'Verity' : route.name);
  const routeParams = route.params as { id?: unknown; selected?: unknown } | undefined;
  const contextualSessionId =
    typeof routeParams?.id === 'string'
      ? routeParams.id
      : typeof routeParams?.selected === 'string'
        ? routeParams.selected
        : undefined;
  return (
    <View style={[styles.header, { paddingTop: insets.top }]}>
      <WindowControlsProbe onInset={trackWindowControls} />
      <View style={[styles.headerRow, headerRowInset]}>
        <View style={styles.headerSide}>
          {isHome ? (
            <>
              {/* The dot rides the settings button rather than sitting on its own,
                  because settings is where the update can actually be started —
                  a badge somewhere else would announce a thing and then leave the
                  operator to find it. */}
              <Link
                href="/settings"
                accessibilityLabel={
                  updateAwaitsAttention ? 'Verity settings, update available' : 'Verity settings'
                }
                asChild
              >
                <Pressable
                  style={({ pressed }) => [
                    styles.headerIconButton,
                    pressed ? styles.headerPressed : null,
                  ]}
                  accessibilityRole="button"
                >
                  <Icon name="more-horizontal" size={19} color={theme.colors.textMuted} />
                  {updateAwaitsAttention ? <View style={styles.headerUpdateDot} /> : null}
                </Pressable>
              </Link>
              <Link href="/new-project" accessibilityLabel="New project" asChild>
                <Pressable
                  style={({ pressed }) => [
                    styles.headerIconButton,
                    pressed ? styles.headerPressed : null,
                  ]}
                  accessibilityRole="button"
                >
                  <Icon name="folder-plus" size={20} color={theme.colors.accent} />
                </Pressable>
              </Link>
            </>
          ) : null}
          {/* Never on the overview: home is the root of every path through the
              app, so a back button there can only point at another copy of
              itself — the "‹ Verity" that showed up whenever a screen navigated
              home with `replace` instead of `dismissTo`. Those call sites are
              fixed; this keeps the next one from reaching the header. */}
          {back && !isHome ? (
            <Pressable
              style={({ pressed }) => [styles.headerBack, pressed ? styles.headerPressed : null]}
              onPress={navigation.goBack}
              accessibilityRole="button"
              accessibilityLabel={`Back to ${back.title ?? 'previous screen'}`}
              hitSlop={8}
            >
              <Icon name="chevron-left" size={28} color={theme.colors.text} />
              {back.title ? (
                <Text style={styles.headerBackTitle} numberOfLines={1}>
                  {back.title}
                </Text>
              ) : null}
            </Pressable>
          ) : null}
        </View>
        <Text
          style={[styles.headerTitle, isHome ? styles.headerTitleHome : null]}
          numberOfLines={1}
          accessibilityRole="header"
        >
          {title}
        </Text>
        <View style={[styles.headerSide, styles.headerSideRight]}>
          {options.headerRight?.({ canGoBack: back !== undefined, tintColor: theme.colors.text })}
          {showMessageSearch ? (
            <>
              <Link
                href={{
                  pathname: '/search',
                  params: {
                    ...(contextualSessionId ? { sessionId: contextualSessionId } : {}),
                  },
                }}
                accessibilityLabel="Search messages"
                asChild
              >
                <Pressable
                  style={({ pressed }) => [
                    styles.headerIconButton,
                    pressed ? styles.headerPressed : null,
                  ]}
                  accessibilityRole="button"
                >
                  <Icon name="search" size={19} color={theme.colors.textMuted} />
                </Pressable>
              </Link>
              {TASKS_ENABLED ? (
                <Link href="/plan" accessibilityLabel="Tasks" asChild>
                  <Pressable
                    style={({ pressed }) => [
                      styles.headerIconButton,
                      pressed ? styles.headerPressed : null,
                    ]}
                    accessibilityRole="button"
                  >
                    <Icon name="check-square" size={19} color={theme.colors.textMuted} />
                  </Pressable>
                </Link>
              ) : null}
              <Link href="/workflows" accessibilityLabel="Cross-project workflows" asChild>
                <Pressable
                  style={({ pressed }) => [
                    styles.headerIconButton,
                    pressed ? styles.headerPressed : null,
                  ]}
                  accessibilityRole="button"
                >
                  <Icon name="git-merge" size={19} color={theme.colors.textMuted} />
                </Pressable>
              </Link>
            </>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  gateOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    backgroundColor: theme.colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  headerRow: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    // Horizontal padding is applied inline (`headerRowInset`), because it also
    // carries whatever the window's corners claim.
  },
  headerSide: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  headerSideRight: {
    justifyContent: 'flex-end',
  },
  headerBack: {
    maxWidth: '100%',
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: theme.spacing.sm,
  },
  headerBackTitle: {
    flexShrink: 1,
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '500',
  },
  headerPressed: {
    opacity: 0.62,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '700',
  },
  headerTitleHome: {
    color: theme.colors.accent,
  },
  headerIconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
  },
  /**
   * A dot, not a count: there is only ever one release to point at, so a number
   * would be noise. Absolutely positioned inside the 44pt touch target so it
   * cannot change the header's layout when it appears — an update arriving must
   * not shift the buttons under the operator's thumb.
   */
  headerUpdateDot: {
    position: 'absolute',
    top: 11,
    right: 10,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: theme.colors.accent,
    // Reads as a badge on the icon rather than a speck floating near it.
    borderWidth: 2,
    borderColor: theme.colors.background,
  },
}));
