import {
  type VerityClient,
  type PermissionDecision,
  type RestoredQueuedTurn,
  SessionModel,
  type SessionModelState,
  type TurnRequest,
  publishSettledPermission,
  publishSessionStatusMutation,
} from '@verity/mobile';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';

import { pendingSession } from '../lib/pendingSessions';
import { createWebSocket } from '../lib/socket';

export interface UseSession extends SessionModelState {
  /** Fire-and-forget an operator turn; the agent's reply streams back over WS.
   * Optional turn options (e.g. image `attachments`) are forwarded to the model. */
  sendTurn: (prompt: string, opts?: Omit<TurnRequest, 'prompt'>) => void;
  /** Load the previous page of older history (scroll-up); no-op when none/loading. */
  loadOlder: () => void;
  /** Load older history in one fetch down to `targetSeq` (a bookmark jump to an
   * unloaded message); no-op when already loaded / nothing older / loading. */
  loadOlderUntil: (targetSeq: number) => void;
  /** Stop the in-flight turn (#79); resolves with queued prompts restored by the
   * caller while the `interrupted` event arrives over WS. `force` additionally
   * releases a session held by an unconfirmed termination — confirm before sending
   * it, since it gives up the guarantee that only one agent owns the worktree. */
  cancel: (opts?: { force?: boolean }) => Promise<RestoredQueuedTurn[]>;
  /** Retract a queued turn (#80); resolves with its prompt text to put back in the
   * input (or `undefined` when it already left the queue / a transient failure). */
  cancelWaiting: (id: string) => Promise<RestoredQueuedTurn | undefined>;
  /** Dismiss a locally echoed message (a failed send) and get its text back for
   * the input; `undefined` when it was already retired by the real message. */
  dismissPending: (id: string) => string | undefined;
  /** Answer the live per-tool permission prompt (#149): POST the operator's
   * allow/deny for `toolUseId`. The pending prompt clears via the stream. */
  decidePermission: (toolUseId: string, decision: PermissionDecision) => void;
  /** Switch the session's engine/model from its next turn onward; the choice is
   * persisted, so the header chip + subsequent turns reflect it. */
  switchModel: (model: string) => void;
}

/**
 * React binding for the headless {@link SessionModel}: instantiates the model for
 * a (client, session, baseUrl), mirrors its state into React via `onChange`, and
 * drives the live-stream lifecycle with `start()`/`stop()`. All orchestration
 * (stream, reconnect, send) lives in the model — this hook is just the glue,
 * mirroring `useSessionList`.
 *
 * A session the app opened before the server had minted it (see
 * {@link pendingSession}) is picked up here rather than passed in as a prop: the
 * chat is mounted from three places, one of them across a route redirect that
 * could not carry a promise. Nothing is found for an ordinary session, which
 * leaves the model ungated exactly as before.
 */
export function useSession(client: VerityClient, sessionId: string, baseUrl: string): UseSession {
  const model = useMemo(() => {
    const ready = pendingSession(sessionId);
    return new SessionModel({
      client,
      sessionId,
      baseUrl,
      connect: createWebSocket,
      getStreamTicket: async () => (await client.createStreamTicket(sessionId)).ticket,
      onChange: (s) => setState(s),
      onPermissionSettled: (toolUseId, accepted) => {
        if (accepted) publishSessionStatusMutation(sessionId, 'running');
        publishSettledPermission(sessionId, toolUseId);
      },
      onTurnCancelled: () => publishSessionStatusMutation(sessionId, 'idle'),
      ...(ready !== undefined ? { ready } : {}),
    });
  }, [client, sessionId, baseUrl]);

  // Seed from the model (empty transcript) so the first frame is consistent.
  const [state, setState] = useState<SessionModelState>(() => model.state);

  useEffect(() => {
    setState(model.state);
    model.start();
    if (AppState.currentState === 'background') model.pause();
    const appState = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background') model.pause();
      else if (nextState === 'active') model.resume();
    });
    return () => {
      appState.remove();
      model.stop();
    };
  }, [model]);

  const sendTurn = useCallback(
    (prompt: string, opts?: Omit<TurnRequest, 'prompt'>) => {
      if (model.state.sending) return;
      void model.sendTurn(prompt, opts).then(() => {
        if (model.state.sendError === undefined) {
          publishSessionStatusMutation(sessionId, 'running');
        }
      });
    },
    [model, sessionId],
  );

  const loadOlder = useCallback(() => {
    void model.loadOlder();
  }, [model]);

  const loadOlderUntil = useCallback(
    (targetSeq: number) => {
      void model.loadOlderUntil(targetSeq);
    },
    [model],
  );

  const cancel = useCallback((opts?: { force?: boolean }) => model.cancel(opts), [model]);

  const cancelWaiting = useCallback((id: string) => model.cancelWaiting(id), [model]);

  const dismissPending = useCallback((id: string) => model.dismissPending(id), [model]);

  const decidePermission = useCallback(
    (toolUseId: string, decision: PermissionDecision) => {
      void model.decidePermission(toolUseId, decision);
    },
    [model],
  );

  const switchModel = useCallback((next: string) => void model.switchModel(next), [model]);

  return {
    ...state,
    sendTurn,
    loadOlder,
    loadOlderUntil,
    cancel,
    cancelWaiting,
    dismissPending,
    decidePermission,
    switchModel,
  };
}
