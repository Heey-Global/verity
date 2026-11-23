import {
  changeSubmissionBar,
  openPullRequestPrompt,
  projectNoun,
  type ChangeSubmissionState,
  VerityApiError,
  type VerityClient,
} from '@verity/mobile';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';

import { Button } from '../ui/Button';
import { SessionBar } from '../ui/SessionBar';
import { changeBarStyles as styles } from './LocalMergeBar';

/** How often the bar re-reads where submitted changes stand while it is shown. */
const REFRESH_MS = 15_000;

/**
 * The bar above the composer for a session's changes in a shared project (ADR
 * 0023), in the shape of the "Save to project" bar. A member without Code submits
 * the changes and follows them until they are added; a member with Code sees who
 * submitted them and can ask the agent for a pull request, after which the pull
 * request bar takes over.
 */
export function ChangeSubmissionBar({
  client,
  sessionId,
  projectKind,
  pullRequestShown,
  busy,
  onOpenPullRequest,
}: {
  client: VerityClient;
  sessionId: string;
  projectKind?: string | undefined;
  pullRequestShown: boolean;
  busy: boolean;
  /** Sends `prompt` to the session's agent as the viewer's message; false when refused. */
  onOpenPullRequest: (prompt: string) => Promise<boolean>;
}) {
  const [state, setState] = useState<ChangeSubmissionState | undefined>(undefined);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  // The session the bar shows now: a read for another one must not land here.
  const current = useRef(sessionId);
  current.current = sessionId;
  const unsupported = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await client.changeSubmissions.read(sessionId, signal);
        if (mounted.current && current.current === sessionId) setState(next);
      } catch (caught) {
        // An older server has no submissions: stop asking. A passing failure keeps
        // the last state.
        if (caught instanceof VerityApiError && caught.status === 404) unsupported.current = true;
      }
    },
    [client, sessionId],
  );
  useEffect(() => {
    setState(undefined);
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => {
      if (!unsupported.current) void load();
    }, REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);

  if (state === undefined) return null;
  const model = changeSubmissionBar({
    state,
    pullRequestShown,
    noun: projectNoun(),
    local: projectKind === 'local',
  });
  if (model === undefined) return null;

  const act = (): void => {
    if (acting || busy || model.action === undefined) return;
    const kind = model.action.kind;
    void (async () => {
      setActing(true);
      setError(undefined);
      try {
        if (kind === 'submit') await client.changeSubmissions.submit(sessionId);
        else if (
          state.submission !== null &&
          !(await onOpenPullRequest(openPullRequestPrompt(state.submission.submittedBy)))
        )
          throw new Error('The message to the agent was not sent. Try again.');
        await load();
      } catch (caught) {
        if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (mounted.current) setActing(false);
      }
    })();
  };

  return (
    <SessionBar>
      <View style={styles.main}>
        <Text style={styles.title} numberOfLines={1}>
          {model.title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {model.subtitle}
        </Text>
        {error !== undefined ? (
          <Text style={styles.error} numberOfLines={2}>
            {error}
          </Text>
        ) : null}
      </View>
      {model.action !== undefined ? (
        <View style={styles.action}>
          <Button
            label={model.action.label}
            size="small"
            loading={acting}
            disabled={busy}
            onPress={act}
          />
        </View>
      ) : null}
    </SessionBar>
  );
}
