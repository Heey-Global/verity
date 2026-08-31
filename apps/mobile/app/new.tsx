// New-session entry: open the chat for a brand-new session immediately and create
// it in the background. Plain plus-clicks stay LLM-idle; prepared prompts from
// explicit flows (Agent Loop setup, issues, tasks) are sent as the first turn.
//
// The create itself is slow — the server refreshes the base branch from origin and
// adds a git worktree — so this screen no longer waits for it. It mints the session
// id up front, registers the in-flight create (see `lib/pendingSessions`), and
// renders the real chat right away: header, transcript, and a working composer. The
// session model holds the stream and the first turn until the id is real, so a
// message typed during those seconds is echoed instantly and dispatched the moment
// the session exists.
import { isServerSecretSealedError, type VerityClient } from '@verity/mobile';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '../components/Icon';
import { createVerityClient, getVerityBaseUrl } from '../lib/client';
import { newSessionId, registerPendingSession } from '../lib/pendingSessions';
import { createSessionConfirmingWarnings } from '../lib/startSession';
import { SessionChat } from './session/[id]';

// Matches session/[id].tsx: at/above this width the app uses the unified split home,
// so a new session there redirects into that split rather than taking over the screen.
const SPLIT_SCREEN_MIN_WIDTH = 900;

function isProjectSessionModel(model: string): boolean {
  return !model.includes('/') || model.startsWith('codex/');
}

function param(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.length > 0 ? raw : undefined;
}

export default function NewAgentScreen() {
  const params = useLocalSearchParams<{
    project?: string;
    projectId?: string;
    prompt?: string;
    model?: string;
    sid?: string;
  }>();
  const client = useMemo(() => createVerityClient(), []);
  if (!client || !getVerityBaseUrl()) {
    return (
      <CenteredMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to start a session."
      />
    );
  }
  return (
    <NewSessionLauncher
      client={client}
      // Legacy links may still carry `<owner>/<repo>`; new project launches use
      // the stable id, which also works before a project is connected to GitHub.
      initialProject={param(params.project)}
      initialProjectId={param(params.projectId)}
      initialPrompt={param(params.prompt)}
      initialModel={param(params.model)}
      // The session id this route is launching, written into the URL the moment it
      // is minted, so a process-death restore reopens THAT session instead of
      // starting a second one.
      restoredSessionId={param(params.sid)}
    />
  );
}

function NewSessionLauncher({
  client,
  initialProject,
  initialProjectId,
  initialPrompt,
  initialModel,
  restoredSessionId,
}: {
  client: VerityClient;
  initialProject?: string;
  initialProjectId?: string;
  initialPrompt?: string;
  initialModel?: string;
  restoredSessionId?: string;
}) {
  const { width } = useWindowDimensions();
  // Keep the launch destination stable for this route. A rotation while the
  // worktree is being created must not switch an in-place phone launch into a
  // wide-layout redirect (or vice versa).
  const wide = useRef(width >= SPLIT_SCREEN_MIN_WIDTH).current;
  const baseUrl = getVerityBaseUrl();
  const launched = useRef(false);
  // Minted here, before anything is asked of the server: it is what lets the chat
  // open in this same frame. It goes into the URL immediately, so a restore reopens
  // THIS session instead of spawning a second one — which is what used to happen
  // when the process died during the seconds the create took.
  const [sessionId] = useState(() => restoredSessionId ?? newSessionId());

  // One gate for the whole launch — resolving the project, creating the session,
  // and dispatching a prepared first prompt. It must NOT settle between those
  // steps: the chat is already live, and an operator message that slipped into
  // the gap would race ahead of the prepared prompt.
  //
  // Registered here in the render, not in the effect below, because this component
  // renders the chat itself: `useSession` reads the registry while it renders, so
  // by the time any effect runs the model has already been built. Registering in
  // the effect left it ungated — a stream and REST calls fired at an id the server
  // has not minted yet, which is the exact thing this screen exists to avoid. The
  // ref both holds the handles for the effect and keeps React's development
  // double-render from registering a second time.
  const gate = useRef<{ settle: () => void; fail: (reason: unknown) => void }>(undefined);
  if (gate.current === undefined) {
    let settle!: () => void;
    let fail!: (reason: unknown) => void;
    const created = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    gate.current = { settle, fail };
    registerPendingSession(sessionId, created);
  }
  const { settle, fail } = gate.current;

  useEffect(() => {
    // Runs exactly once per route: the ref (not state) guards the second pass of
    // React's development double-invoke, which would otherwise create two sessions.
    if (launched.current) return;
    launched.current = true;

    void (async () => {
      try {
        const project = initialProject;
        const model =
          initialModel !== undefined && isProjectSessionModel(initialModel)
            ? initialModel
            : undefined;
        // Issued for a restore too. `sid` names a session this route already
        // launched, but "launched" is not "exists": the process can die in the
        // seconds the create takes, and skipping it there left the chat open on an
        // id the server never minted, forever. The create is idempotent on that id,
        // so re-issuing it either finishes the interrupted one or costs a round-trip
        // against a session that is already there.
        const { existing } = await createSessionConfirmingWarnings(client, {
          sessionId,
          ...(initialPrompt !== undefined ? { prompt: initialPrompt } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(project !== undefined ? { project } : {}),
          ...(initialProjectId !== undefined ? { projectId: initialProjectId } : {}),
        });
        // Dispatched before the gate opens so it is always the session's first turn.
        // `existing` means this call did not mint the session, so the run that did
        // has already sent it — sending again would repeat the prompt on a restore.
        if (initialPrompt !== undefined && !existing) {
          await client.sendTurn(sessionId, {
            prompt: initialPrompt,
            ...(model !== undefined ? { model } : {}),
          });
        }
        settle();
      } catch (caught) {
        // The chat is already mounted and waiting on this. Rejecting is what turns
        // its "Opening session…" into the actual reason and marks a message typed in
        // the meantime as un-sent (tapping it puts the text back in the composer) —
        // an error SCREEN here would take the chat, and that text, away instead.
        fail(caught);
        if (isServerSecretSealedError(caught)) {
          router.replace({
            pathname: '/unlock-device',
            params: { returnTo: '/', serverSecret: '1' },
          });
        }
      }
    })();

    if (wide) {
      // Wide (iPad): keep the single unified split — /session/[id] bounces to the
      // home split with this session preselected (see session/[id].tsx). The pane
      // finds the pending create through the registry, so it opens just as fast as
      // the phone's in-place chat.
      router.replace({ pathname: '/session/[id]', params: { id: sessionId } });
    } else {
      // Narrow (phone): the chat renders in place below, so only the URL needs
      // canonicalizing — `setParams` (not `replace`) keeps this route mounted.
      router.setParams({ sid: sessionId });
    }
  }, [
    client,
    fail,
    initialModel,
    initialProject,
    initialProjectId,
    initialPrompt,
    sessionId,
    settle,
    wide,
  ]);

  // Wide redirects into the split home (above); rendering the chat here too would
  // mount a second copy of it for the same session, so that layout only ever sees
  // the placeholder for the frame it takes to leave this route.
  if (baseUrl && !wide) {
    return <SessionChat client={client} sessionId={sessionId} baseUrl={baseUrl} />;
  }

  return <PendingSessionChat />;
}

/** The one frame the tablet layout spends on this route before redirecting into
 * the split home. The phone layout renders the chat itself, so it never gets here
 * — a failed create is reported inside that chat, not by replacing it. */
function PendingSessionChat() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const header = (
    <View style={[styles.header, { paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        <View style={styles.headerSide}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            style={styles.headerBack}
          >
            <Icon name="chevron-left" size={28} color={theme.colors.text} />
          </Pressable>
        </View>
        <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">
          New session
        </Text>
        <View style={styles.headerSide} />
      </View>
    </View>
  );

  return (
    <View style={styles.pendingScreen}>
      <Stack.Screen options={{ header: () => header }} />
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.textMuted} />
        <Text style={styles.subtitle}>Opening session…</Text>
      </View>
    </View>
  );
}

function CenteredMessage({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={styles.centered}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pendingScreen: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    backgroundColor: theme.colors.background,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
    textAlign: 'center',
  },
  header: {
    backgroundColor: theme.colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  headerRow: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  headerSide: {
    width: 40,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerBack: {
    paddingRight: theme.spacing.xs,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    marginHorizontal: theme.spacing.xs,
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
}));
