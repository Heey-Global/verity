// First-run onboarding gate (#320, PR 1). On mount, fetch `/onboarding/status`
// (sealed-safe on the server) and, when setup is incomplete, redirect into the
// wizard at the resume step. Deliberately FAIL-OPEN: a failed status fetch must
// NOT hard-lock the app behind an un-enterable gate — a broken gate blocking the
// whole app is worse than a missed redirect — so an error logs and lets the
// operator through to the normal app.
import {
  isCoreOnboardingComplete,
  isPristineOnboardingStatus,
  resumeStep,
  type OnboardingStatus,
} from '@verity/mobile';
import { useGlobalSearchParams, usePathname, useSegments } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { getAuthToken } from '../lib/authToken';
import { createVerityClient, getVerityBaseUrl, hasConfiguredVerityBaseUrl } from '../lib/client';

export type OnboardingGateState = { status: 'checking' } | { status: 'done'; redirectTo?: string };

const SERVER_SECRET_CHECK_INTERVAL_MS = 15_000;

function onboardingRoute(status: OnboardingStatus): string {
  if (isCoreOnboardingComplete(status)) return '/';
  if (isPristineOnboardingStatus(status)) return '/onboarding/welcome';
  return `/onboarding/${resumeStep(status)}`;
}

function unlockRoute(returnTo: string, opts: { serverSecret?: boolean } = {}): string {
  const query = new URLSearchParams({ returnTo });
  if (opts.serverSecret === true) query.set('serverSecret', '1');
  return `/unlock-device?${query.toString()}`;
}

/**
 * Runs the first-run check exactly once and returns whether the gate is still
 * deciding. While `checking`, the caller should hold the splash/loader rather than
 * flash the home screen. The gate resolves to `done` in every terminal case —
 * redirected, already-complete, already-in-wizard, no-client, or error (fail-open).
 */
export function useOnboardingGate(): OnboardingGateState {
  const segments = useSegments();
  const pathname = usePathname();
  const searchParams = useGlobalSearchParams<Record<string, string | string[]>>();
  const inOnboarding = segments[0] === 'onboarding';
  const inUnlockDevice = segments[0] === 'unlock-device';
  // The standalone GitHub reconnect screen is exempt from the "setup incomplete"
  // redirect: disconnecting GitHub there flips `status.complete` false, and bouncing
  // the operator into the wizard mid-reconnect would defeat the screen's purpose.
  // The sealed→unlock and missing-auth-token→unlock redirects still apply.
  const inGithubConnect = segments[0] === 'github-connect';
  const [state, setState] = useState<OnboardingGateState>({ status: 'checking' });

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let interval: ReturnType<typeof setInterval> | undefined;

    const currentReturnTo = (): string => {
      if (!pathname || pathname.length === 0 || pathname === '/unlock-device') return '/';
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(searchParams)) {
        for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
      }
      const encoded = query.toString();
      return encoded ? `${pathname}?${encoded}` : pathname;
    };

    const check = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        if (!hasConfiguredVerityBaseUrl()) {
          if (!inOnboarding) {
            setState({ status: 'done', redirectTo: '/onboarding/welcome' });
            return;
          }
          setState((current) => (current.status === 'checking' ? { status: 'done' } : current));
          return;
        }

        const client = createVerityClient();
        if (!client) {
          setState((current) => (current.status === 'checking' ? { status: 'done' } : current));
          return;
        }

        const status = await client.fetchOnboardingStatus();
        if (!active) return;

        if (status.masterPasswordSet && status.sealed) {
          if (inUnlockDevice) {
            setState({ status: 'done' });
            return;
          }
          setState({
            status: 'done',
            redirectTo: unlockRoute(currentReturnTo(), { serverSecret: true }),
          });
          return;
        }

        if (
          !inOnboarding &&
          status.masterPasswordSet &&
          getAuthToken(getVerityBaseUrl()) === null
        ) {
          if (inUnlockDevice) {
            setState({ status: 'done' });
            return;
          }
          setState({
            status: 'done',
            redirectTo: unlockRoute(
              // An unauthenticated post-setup response deliberately hides provider
              // state and carries `nextStep: null`. Return to the requested screen
              // after device authorization; the next authenticated gate check can
              // then route to a genuinely incomplete step. Treating the redacted
              // response as incomplete sends every cold launch to master password.
              isCoreOnboardingComplete(status) || status.nextStep === null
                ? currentReturnTo()
                : onboardingRoute(status),
              {
                serverSecret: false,
              },
            ),
          });
          return;
        }

        if (!inOnboarding && !inGithubConnect && !isCoreOnboardingComplete(status)) {
          setState({ status: 'done', redirectTo: onboardingRoute(status) });
          return;
        }

        setState((current) => (current.status === 'checking' ? { status: 'done' } : current));
      } catch (error) {
        // `/onboarding/status` carries the richer first-run state, but unlocking
        // must remain reachable if that probe alone regresses or is temporarily
        // unavailable. `/secret/status` is independently pre-authenticated and
        // exposes only the cipher state, which is enough to route a sealed store
        // to the existing unlock form without guessing about setup progress.
        try {
          const client = createVerityClient();
          if (client && (await client.getSecretStatus()) === 'sealed' && active) {
            if (inUnlockDevice) {
              setState({ status: 'done' });
            } else {
              setState({
                status: 'done',
                redirectTo: unlockRoute(currentReturnTo(), { serverSecret: true }),
              });
            }
            return;
          }
        } catch {
          // Preserve the gate's fail-open contract when neither safe status probe
          // is available. A connectivity failure must not trap the whole app.
        }
        console.warn('verity: onboarding status check failed, allowing through', error);
        if (active) {
          setState((current) => (current.status === 'checking' ? { status: 'done' } : current));
        }
      } finally {
        inFlight = false;
      }
    };

    void check();
    interval = setInterval(() => void check(), SERVER_SECRET_CHECK_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void check();
    });

    return () => {
      active = false;
      if (interval !== undefined) clearInterval(interval);
      subscription.remove();
    };
  }, [inOnboarding, inUnlockDevice, inGithubConnect, pathname, searchParams]);

  return state;
}
