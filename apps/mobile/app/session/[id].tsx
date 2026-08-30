// Session chat screen: the live transcript for one Claude Code session plus the
// operator input bar. Binds @verity/mobile's headless SessionModel via useSession
// (live WS stream → reducer → Message[]) and renders each canonical message kind
// with our own components — user bubbles, agent text with fenced-code blocks, tool
// cards, and lifecycle event rows. The input bar (text + mic/attach placeholders)
// sits inside a KeyboardAvoidingView so it rises above the keyboard. All
// StyleSheet.create-using components live in this file so the Unistyles Babel
// plugin (root: 'app') processes them.
import {
  type AgentTextMessage,
  type AgentLoop,
  type AgentLoopProposalMessage,
  type Attachment,
  type AttachmentUpload,
  type BranchSwitchRequest,
  VerityApiError,
  type VerityClient,
  type ChoicesMessage,
  type Message,
  type ChoicesOption,
  type ModeSwitchMessage,
  type PendingMessage,
  type PendingPermission,
  type PermissionDecision,
  type RateLimitNotice,
  type SessionFileEntry,
  type ToolCallMessage,
  type UserTextMessage,
  agentEventDescriptor,
  agentLoopConfigFingerprint,
  briefingExtent,
  chunkFilePreview,
  engineLabel,
  formatChoiceAnswer,
  freezeTranscriptTail,
  frozenTranscriptRows,
  githubRefUrl,
  isPullRequestConflicted,
  isSessionImageFilePath,
  groupRows,
  pullRequestStatusText,
  markdownSectionTitle,
  modelRateLimited,
  modelDisplayName,
  orderModels,
  partitionModels,
  publishAgentLoopMutation,
  publishDevServerStatusMutation,
  subscribeAgentLoopMutations,
  subscribeDevServerStatusMutations,
  parseBranchIssue,
  parseInline,
  parseMarkdownBlocks,
  rateLimitNotice,
  rateLimitNoticeText,
  rateLimitNoticeTone,
  rowKey,
  rowRecycleType,
  secretGrantScopes,
  brokeredAuthSentence,
  brokeredHttpSummary,
  brokeredHttpTitle,
  listSessionsSentence,
  listSessionsSummary,
  listSessionsTitle,
  permissionInputText,
  sessionHandoffCaveats,
  sessionHandoffSummary,
  sessionHandoffTitle,
  spellOutBidiControls,
  trustedCliInjectionSummary,
  trustedCliSecretLabel,
  trustedCliSummary,
  splitSearchHighlights,
  sessionFilePathFromLocalLink,
  splitRichText,
  toolCallView,
  type AgentEventTone,
  type FrozenTranscriptTail,
  type RestoredQueuedTurn,
  type Row,
  type ToolCallTone,
  type ToolImage,
} from '@verity/mobile';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  createContext,
  type ComponentProps,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Easing,
  FlatList,
  InteractionManager,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  type StyleProp,
  Text,
  TextInput,
  type TextInputKeyPressEventData,
  type TextStyle,
  useWindowDimensions,
  View,
  type ViewStyle,
  type ViewToken,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Directory as FsDirectory, File as FsFile, Paths } from 'expo-file-system';
// expo-image (not RN Image) for attachments: it lazily fetches + disk-caches by
// URL, so a referenced image loads only when its row is on screen and is cached
// across reopens — the backlog of images never loads up front.
import { Image as ExpoImage, type ImageSource } from 'expo-image';
import { UITextView } from 'react-native-uitextview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../../components/Icon';
import { AgentLoopCockpit } from '../../components/AgentLoopCockpit';
import { DRAG_OUT_SUPPORTED, DragSource } from '../../components/DragSource';
import { DropZone } from '../../components/DropZone';
import { ImageLightbox } from '../../components/ImageLightbox';
import { WorkingDot } from '../../components/WorkingDot';
import {
  hardwareKeyboardDetection,
  isExternalKeyboardHeight,
  shouldPreserveComposerFocus,
} from '../../hardwareKeyboard';
import { type Bookmarks, useBookmarks } from '../../hooks/useBookmarks';
import { type UseBranches, useBranches } from '../../hooks/useBranches';
import { useModels } from '../../hooks/useModels';
import { useSession } from '../../hooks/useSession';
import { type VoiceState, useVoiceInput } from '../../hooks/useVoiceInput';
import { attachMenuRows } from '../../lib/attachMenu';
import {
  type DroppedFileDescriptor,
  captureImage,
  pickMeetingAudioAsset,
  pickSessionFiles,
  readMeetingAudioUpload,
  pickFiles,
  pickImagesFromLibrary,
  readDroppedAttachments,
} from '../../lib/attachments';
import { getAuthToken } from '../../lib/authToken';
import { createVerityClient, getVerityBaseUrl } from '../../lib/client';
import { downloadPinnedFile } from '../../lib/pinnedTransport';
import { getServerProfile } from '../../lib/serverProfile';
import { MEETING_AUDIO_ENABLED } from '../../lib/featureFlags';
import {
  type ClickModifiers,
  type DragFileItem,
  dragItemsForRow,
  fileNameFromPath,
  isSelectableFile,
  mimeTypeForFile,
  retainVisibleSelection,
  selectionForModifierClick,
  selectionSummary,
  toggleFileSelection,
} from '../../lib/fileSelection';
import {
  cacheDirectoryName,
  fileEntryMeta,
  fileIcon,
  loadSharingModule,
  parentPath,
} from '../../lib/sessionFileUi';
import {
  claimPendingMeetingUpload,
  meetingAudioRequestText,
  meetingTranscriptionReadiness,
  pendingUploadActionAfterBackendChoice,
  restorePendingMeetingUpload,
  shouldShowLocalMeetingUpload,
} from '../../lib/meetingUploads';
import {
  historyAnchorIntraRowOffset,
  historyEdgeDistance,
  isAtLatestEdge,
  isHistoryEdgeVisible,
  isOldestRowViewable,
  isScrollTowardHistory,
  migratedAnchorOffset,
  shouldContinueOlderHistory,
  shouldAcceptNativeLatestState,
  shouldFollowStreamingContent,
  shouldRequestOlderHistory,
  shouldRestoreToLatestEdge,
  transcriptPositionMaintenance,
  transcriptRestoreRequest,
  TRANSCRIPT_COORDINATE_SYSTEM,
} from '../../lib/scrollPosition';
import {
  createPersistedStringSet,
  loadScrollAnchor,
  saveScrollAnchor,
  scrollAnchorDebug,
  SCROLL_BOTTOM_BOUNCE_EPSILON,
  SCROLL_DIRECTION_EPSILON,
  SCROLL_STALE_DELTA_MIN,
  SCROLL_STALE_DELTA_VIEWPORTS,
} from '../../lib/sessionScrollPersistence';
import {
  anchorFromRow,
  findAnchorIndex,
  messageSeq,
  type ScrollAnchor,
} from '../../lib/transcriptAnchor';
import { formatResetDisplay, formatTurnTimestamp } from '../../lib/time';

// In-memory per-session draft cache: keeps the typed/dictated draft when the
// operator leaves a session and returns (within the app's lifetime), so input work
// isn't lost on navigation. Module-scoped so it survives the screen unmount.
// (Cross-app-restart persistence would need AsyncStorage — a follow-up.)
const draftStore = new Map<string, string>();

const MEETING_FOLLOW_UP_IDLE_POLL_MS = 1200;
const MEETING_FOLLOW_UP_IDLE_ATTEMPTS = 100;
const MAX_ATTACHMENTS_PER_TURN = 8;
// A history page is an append behind the viewport, so nothing has to be corrected
// afterwards — but FlashList still measures the new rows over the following frames.
// Treat the page as "settling" until then so an automatic follow-up load cannot stack
// another measurement pass onto a list that is still moving.
const HISTORY_APPEND_SETTLE_MS = 200;
const HISTORY_APPEND_SETTLE_FALLBACK_MS = 2000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSessionIdle(client: VerityClient, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < MEETING_FOLLOW_UP_IDLE_ATTEMPTS; attempt += 1) {
    const activity = await client.getActivity(sessionId);
    if (!activity.busy && activity.queued.length === 0) return;
    await delay(MEETING_FOLLOW_UP_IDLE_POLL_MS);
  }
  throw new Error(
    'The session is still busy. The meeting prompt will retry when this chat opens again.',
  );
}

interface LocalMeetingUploadActivity {
  id: string;
  fileName: string;
  startedAt: number;
  phase: 'reading' | 'uploading';
}

function localMeetingUploadMessages(activity: LocalMeetingUploadActivity): Message[] {
  const phaseText =
    activity.phase === 'reading'
      ? `Preparing meeting audio…\n${activity.fileName}`
      : `Uploading meeting audio…\n${activity.fileName}`;
  return [
    {
      kind: 'user-text' as const,
      id: `local-meeting-upload-request-${activity.id}`,
      localId: activity.id,
      createdAt: activity.startedAt,
      text: meetingAudioRequestText(activity.fileName),
      pending: 'sending' as const,
    },
    {
      kind: 'agent-text',
      id: `local-meeting-upload-agent-${activity.id}`,
      localId: activity.id,
      createdAt: activity.startedAt + 1,
      text: phaseText,
    },
  ];
}

/** A locally echoed operator message as a transcript message. `pending` marks it as
 * not-yet-confirmed so `<UserBubble>` renders the sending/failed affordance; the
 * `pending-…` id is the dismiss handle back into `SessionModel.dismissPending`. */
function pendingEchoMessage(pending: PendingMessage): Message {
  return {
    kind: 'user-text',
    id: pending.id,
    localId: pending.id,
    createdAt: pending.createdAt,
    text: pending.text,
    pending: pending.status,
    ...(pending.attachments !== undefined ? { attachments: pending.attachments } : {}),
  };
}

function shouldAlertMeetingUploadApiError(error: VerityApiError): boolean {
  return ![
    'unsupported audio file',
    'audio file is empty',
    'meeting transcription is not configured',
    'meeting transcription failed',
    'meeting transcription returned no text',
  ].includes(error.message);
}

// Per-session scroll anchor: remembers WHICH message the operator last had at the
// BOTTOM of their viewport, so reopening lands them exactly there — with any messages
// that streamed in while they were away sitting BELOW it, to scroll down into. We
// persist that row's KEY, not a pixel offset: row heights vary wildly (a one-line
// event vs. a long code block or an image), so an offset would be fragile across
// relayout and history paging. Anchoring the last-SEEN row (rather than snapping to
// the latest) is what the operator asked for — being caught up isn't a signal to
// jump past what they hadn't read yet. Keyed per session and AsyncStorage-backed, so
// it survives navigation AND an app restart. See the restore effect in SessionChat.
//
// The stored `coordinateSystem` tag keeps this forward/backward compatible across the
// inversion: an anchor written by the chronological layout still names a real row, but
// its `offsetY` measures something else, so it is repositioned by row identity alone
// (`migratedAnchorOffset`).
const dismissedPullRequests = createPersistedStringSet('verity.dismissedPullRequests.v1');

function isSingleInsertedNewline(previous: string, next: string): boolean {
  if (next.length !== previous.length + 1) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== previous[index]) {
      return next[index] === '\n' && next.slice(index + 1) === previous.slice(index);
    }
  }
  return false;
}

// Half-height of the 3-item message-nav stack, incl. the backdrop's vertical padding:
// 3 btns·(icon 22 + 6·2) + 2 gaps·8 + container 6·2 = 130; half = 65. Used to
// translateY the stack onto the true vertical centre of the visible transcript. Keep
// in sync with styles.msgNav(Btn).
const NAV_STACK_HALF = 65;
const SPLIT_SCREEN_MIN_WIDTH = 900;

export default function SessionScreen() {
  const { id, targetMessageId, targetSearchQuery } = useLocalSearchParams<{
    id: string;
    targetMessageId?: string;
    targetSearchQuery?: string;
  }>();
  const client = useMemo(() => createVerityClient(), []);
  const baseUrl = getVerityBaseUrl();
  const { width } = useWindowDimensions();

  if (!id) {
    return <CenteredMessage title="Session not found" subtitle="No session id was provided." />;
  }
  if (!client || !baseUrl) {
    return (
      <CenteredMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to open this session."
      />
    );
  }
  // Wide screens use the single unified split layout on the sessions home route
  // (index.tsx): redirect there with this session preselected in the right pane,
  // rather than the old per-route flat sidebar this screen used to render. Keeps
  // exactly one split implementation, so a new-session `replace('/session/[id]')`
  // (new.tsx) lands in the project-grouped overview like everywhere else.
  if (width >= SPLIT_SCREEN_MIN_WIDTH) {
    return (
      <SplitScreenRedirect
        id={id}
        targetMessageId={targetMessageId}
        targetSearchQuery={targetSearchQuery}
      />
    );
  }
  return (
    <SessionChat
      key={id}
      client={client}
      sessionId={id}
      baseUrl={baseUrl}
      initialTargetMessageId={targetMessageId}
      initialTargetSearchQuery={targetSearchQuery}
    />
  );
}

// Send the wide-screen viewer to the split home with this session preselected.
// Uses `dismissTo` (not `<Redirect>`/`replace`): when a home screen is already
// below in the stack — the usual case, since sessions are reached via `/new`,
// an issue, or a list tap that all sit on top of `/` — this pops
// back to that existing home instead of stacking a *second* `/`. A duplicate
// home was what surfaced the phantom "‹ Verity" back button on the home header.
// If no home exists below (e.g. a cold deep-link straight to /session/[id]),
// `dismissTo` falls back to replacing this route with `/`, exactly like the old
// redirect did. Mirrors expo-router's own <Redirect>, which fires on focus.
function SplitScreenRedirect({
  id,
  targetMessageId,
  targetSearchQuery,
}: {
  id: string;
  targetMessageId?: string;
  targetSearchQuery?: string;
}) {
  useFocusEffect(
    useCallback(() => {
      router.dismissTo({
        pathname: '/',
        params: {
          selected: id,
          ...(targetMessageId ? { targetMessageId } : {}),
          ...(targetSearchQuery ? { targetSearchQuery } : {}),
        },
      });
    }, [id, targetMessageId, targetSearchQuery]),
  );
  return null;
}

/**
 * Actions a transcript row needs to drive a turn — provided once by `SessionChat`
 * so a deep child (the Quick-Action `<ChoicesRow>`, issue #97) can send the
 * tapped option as a new turn or focus the input for a free-text answer, without
 * threading callbacks through `renderRow`. Null only outside a provider (never in
 * practice; `<ChoicesRow>` renders null defensively if so).
 */
interface SessionActions {
  /** Dispatch `prompt` as a new steering turn (a tapped chip's label). */
  sendTurn: (prompt: string) => void;
  /** A turn is in flight — chips deactivate so a stale choice can't be re-sent. */
  sending: boolean;
  /** Session can't be resumed (worktree gone) — chips are inert. */
  dead: boolean;
  /** Focus the input bar (the "Custom answer" chip → free-text reply). */
  focusInput: () => void;
  /** Put a failed optimistic message back into the input for editing. */
  recoverPending: (id: string) => void;
  /** Persist, test, and enable a structured Agent Loop proposal after explicit approval. */
  confirmAgentLoop: (message: AgentLoopProposalMessage) => Promise<void>;
  enableAgentLoop: (loopId: string) => Promise<void>;
  /** Server-persisted readiness survives navigation away from the proposal row. */
  agentLoopStatus: AgentLoop['status'] | null;
  agentLoopTested: boolean;
  agentLoopId: string | null;
  agentLoopConfigFingerprint: string | null;
}

const SessionActionsContext = createContext<SessionActions | null>(null);

// Bookmark state (#bookmarks), provided once by `SessionChat` so a deep transcript
// row (`<AgentMarkdown>`) can toggle its own message's bookmark without threading a
// callback through `renderRow`. Null outside a provider — the affordance renders
// nothing rather than crashing (never happens in practice; the FlashList is always
// wrapped).
const BookmarksContext = createContext<Bookmarks | null>(null);

const SessionFileOpenContext = createContext<((path: string) => void) | null>(null);
const SessionFileImageSourceContext = createContext<
  ((path: string) => ImageSource | undefined) | null
>(null);
const SearchHighlightContext = createContext<string | null>(null);

/** Whether a model is routable for a PROJECT session — Claude (bare id) or Codex
 * (`codex/…`). OpenCode's `provider/model` ids are blocked (the server 400s them),
 * so the picker hides them for project sessions. Mirrors new.tsx + the server. */
function isProjectSessionModel(model: string): boolean {
  return !model.includes('/') || model.startsWith('codex/');
}

export function SessionChat({
  client,
  sessionId,
  baseUrl,
  embedded,
  initialTargetMessageId,
  initialTargetSearchQuery,
}: {
  client: VerityClient;
  sessionId: string;
  baseUrl: string;
  embedded?: boolean;
  initialTargetMessageId?: string;
  initialTargetSearchQuery?: string;
}) {
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const {
    session,
    streamError,
    sending,
    sendError,
    cancelError,
    resumable,
    name,
    model: currentModel,
    projectId,
    kind,
    switchingModel,
    modelSwitchPending,
    terminationUnconfirmed,
    switchModelError,
    loaded,
    locallyCreated,
    busy,
    working,
    waitingMessages,
    pendingMessages,
    branch: liveBranch,
    decidingPermission,
    permissionError,
    sendTurn,
    cancel,
    cancelWaiting,
    dismissPending,
    decidePermission,
    switchModel,
    hasOlder,
    loadingOlder,
    olderLoadStalled,
    olderLoadNeedsContinuation,
    olderLoadGeneration,
    loadOlder,
    loadOlderUntil,
  } = useSession(client, sessionId, baseUrl);
  const sessionFileImageSource = useCallback(
    (path: string): ImageSource | undefined => {
      if (!isSessionImageFilePath(path)) return undefined;
      const token = getAuthToken(baseUrl);
      return {
        uri: client.sessionFileDownloadUrl(sessionId, path),
        ...(token !== null && token.length > 0
          ? { headers: { authorization: `Bearer ${token}` } }
          : {}),
      };
    },
    [baseUrl, client, sessionId],
  );
  // Engine switcher: the header chip names the CURRENT engine (Claude/Codex/…) and
  // taps open a picker to switch the session's backend mid-flight (#switch-engine).
  // `currentModel` is the persisted choice (survives a switch + remount); fall back
  // to the reducer's spawn model until the detail loads.
  const { models, modelOrder, moreModels, refresh: refreshModels } = useModels(client);
  const [enginePickerOpen, setEnginePickerOpen] = useState(false);
  const effectiveModel = currentModel ?? session.model;
  const [agentLoop, setAgentLoop] = useState<AgentLoop | null>(null);
  const agentLoopGeneration = useRef(0);
  const [loopCockpitOpen, setLoopCockpitOpen] = useState(false);
  useEffect(() => {
    if (kind !== 'agent_loop' || !projectId) {
      setAgentLoop(null);
      return;
    }
    let active = true;
    const generation = agentLoopGeneration.current;
    void client
      .listAgentLoops(projectId)
      .then((loops) => {
        if (active && generation === agentLoopGeneration.current) {
          setAgentLoop(loops.find((loop) => loop.sessionId === sessionId) ?? null);
        }
      })
      .catch(() => {
        if (active && generation === agentLoopGeneration.current) setAgentLoop(null);
      });
    return () => {
      active = false;
    };
  }, [client, kind, projectId, sessionId]);
  useEffect(
    () =>
      subscribeAgentLoopMutations((updated) => {
        if (updated.sessionId !== sessionId) return;
        agentLoopGeneration.current += 1;
        setAgentLoop(updated);
      }),
    [sessionId],
  );

  // Dev-server session preview: the header button points the project's configured
  // dev server(s) at THIS session's worktree so the branch can be previewed before
  // merging; tapping again points them back at the main checkout. State reflects
  // whether every configured server currently previews this session.
  const [devServerPreview, setDevServerPreview] = useState<'off' | 'on' | 'busy'>('off');
  const configuredDevServerIds = useRef(new Set<string>());
  const previewReconcileGeneration = useRef(0);
  const pendingPreviewMutations = useRef(new Map<string, string | null>());
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const generation = ++previewReconcileGeneration.current;
    void client
      .listDevServers(projectId)
      .then((servers) => {
        if (!active || generation !== previewReconcileGeneration.current) return;
        const pending = pendingPreviewMutations.current;
        const resolved = servers.map((server) => ({
          ...server,
          previewSessionId: pending.has(server.id)
            ? (pending.get(server.id) ?? null)
            : server.previewSessionId,
        }));
        pending.clear();
        const configured = resolved.filter((server) => server.command?.trim());
        configuredDevServerIds.current = new Set(configured.map((server) => server.id));
        setDevServerPreview(
          configured.length > 0 &&
            configured.every((server) => server.previewSessionId === sessionId)
            ? 'on'
            : 'off',
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, projectId, sessionId]);
  useEffect(
    () =>
      subscribeDevServerStatusMutations((mutation) => {
        if (mutation.projectId !== projectId || mutation.previewSessionId === undefined) return;
        pendingPreviewMutations.current.set(mutation.id, mutation.previewSessionId);
        if (mutation.devServer !== undefined) {
          if (mutation.devServer.command?.trim()) configuredDevServerIds.current.add(mutation.id);
          else configuredDevServerIds.current.delete(mutation.id);
        }
        if (!configuredDevServerIds.current.has(mutation.id)) return;
        const generation = ++previewReconcileGeneration.current;
        if (mutation.previewSessionId !== sessionId) {
          setDevServerPreview((current) => (current === 'busy' ? current : 'off'));
          return;
        }
        void client
          .listDevServers(projectId)
          .then((servers) => {
            if (generation !== previewReconcileGeneration.current) return;
            const pending = pendingPreviewMutations.current;
            const configured = servers
              .map((server) => ({
                ...server,
                previewSessionId: pending.has(server.id)
                  ? (pending.get(server.id) ?? null)
                  : server.previewSessionId,
              }))
              .filter((server) => server.command?.trim());
            pending.clear();
            setDevServerPreview((current) =>
              current === 'busy'
                ? current
                : configured.length > 0 &&
                    configured.every((server) => server.previewSessionId === sessionId)
                  ? 'on'
                  : 'off',
            );
          })
          .catch(() => undefined);
      }),
    [client, projectId, sessionId],
  );

  const toggleDevServerPreview = useCallback(async () => {
    if (!projectId || devServerPreview === 'busy') return;
    const wasOn = devServerPreview === 'on';
    const changedServers: Array<{ id: string; previewSessionId: string | null }> = [];
    setDevServerPreview('busy');
    try {
      const servers = (await client.listDevServers(projectId)).filter((server) =>
        server.command?.trim(),
      );
      configuredDevServerIds.current = new Set(servers.map((server) => server.id));
      if (servers.length === 0) {
        Alert.alert('No dev server', 'This project has no configured dev server to preview with.');
        setDevServerPreview('off');
        return;
      }
      for (const server of servers) {
        changedServers.push({ id: server.id, previewSessionId: server.previewSessionId });
        const result = await client.setDevServerPreviewSession(server.id, wasOn ? null : sessionId);
        publishDevServerStatusMutation({
          id: result.devServer.id,
          projectId: result.devServer.projectId,
          devServer: result.devServer,
          previewSessionId: result.devServer.previewSessionId,
          ...(result.runtime ? { running: result.runtime.running } : {}),
        });
      }
      setDevServerPreview(wasOn ? 'off' : 'on');
    } catch (error) {
      await Promise.allSettled(
        changedServers.reverse().map(async (server) => {
          const result = await client.setDevServerPreviewSession(
            server.id,
            server.previewSessionId,
          );
          publishDevServerStatusMutation({
            id: result.devServer.id,
            projectId: result.devServer.projectId,
            devServer: result.devServer,
            previewSessionId: result.devServer.previewSessionId,
            ...(result.runtime ? { running: result.runtime.running } : {}),
          });
        }),
      );
      const refreshed = await client.listDevServers(projectId).catch(() => []);
      const configured = refreshed.filter((server) => server.command?.trim());
      setDevServerPreview(
        configured.length > 0 && configured.every((server) => server.previewSessionId === sessionId)
          ? 'on'
          : 'off',
      );
      Alert.alert('Preview failed', error instanceof Error ? error.message : String(error));
    }
  }, [client, devServerPreview, projectId, sessionId]);

  const editAgentLoop = useCallback(() => {
    if (!agentLoop || sending || busy) return;
    sendTurn(
      [
        `Reconfigure the Agent Loop "${agentLoop.name}".`,
        `Agent Loop ID: ${agentLoop.id}`,
        'Ask me focused questions about the script and schedule, one decision at a time.',
        `Current config:\n${JSON.stringify(
          {
            name: agentLoop.name,
            schedule: agentLoop.schedule,
            script: agentLoop.script,
            reactionPrompt: agentLoop.reactionPrompt,
            reactionModel: agentLoop.reactionModel,
          },
          null,
          2,
        )}`,
        'Keep the script deterministic, read-only by default, bounded, and self-contained.',
        'Propose the full replacement config for my explicit confirmation and test run. The final verity:agent-loop block must use the Agent Loop ID above. Do not enable it yourself.',
      ].join('\n\n'),
    );
  }, [agentLoop, busy, sendTurn, sending]);

  const confirmAgentLoop = useCallback(
    async (message: AgentLoopProposalMessage): Promise<void> => {
      const proposal = message.proposal;
      if (agentLoop?.id !== proposal.loopId) {
        throw new Error('This proposal does not belong to the open Agent Loop.');
      }
      await client.updateAgentLoop(proposal.loopId, {
        name: proposal.name,
        script: proposal.script,
        schedule: proposal.schedule,
        reactionPrompt: proposal.reactionPrompt ?? null,
        reactionModel: proposal.reactionModel ?? null,
      });
      const tested = await client.testAgentLoop(proposal.loopId);
      if (tested.result.outcome === 'error') {
        throw new Error(tested.result.detail ?? 'The Agent Loop test run failed.');
      }
      setAgentLoop(tested.loop);
      publishAgentLoopMutation(tested.loop);
    },
    [agentLoop?.id, client],
  );
  const enableAgentLoop = useCallback(
    async (loopId: string): Promise<void> => {
      const enabled = await client.updateAgentLoop(loopId, { status: 'enabled' });
      setAgentLoop(enabled);
      publishAgentLoopMutation(enabled);
    },
    [client],
  );
  // For a project session only Claude/Codex models are routable (the server 400s the
  // rest), so hide OpenCode ids — mirrors the new-session picker.
  const selectableModels = useMemo(() => {
    return projectId ? models.filter(isProjectSessionModel) : models;
  }, [models, projectId]);
  const selectableModelOrder = useMemo(() => {
    return projectId ? modelOrder.filter(isProjectSessionModel) : modelOrder;
  }, [modelOrder, projectId]);
  const selectableMoreModels = useMemo(() => {
    const ordered = orderModels(moreModels);
    return projectId ? ordered.filter(isProjectSessionModel) : ordered;
  }, [moreModels, projectId]);
  // Restore any draft left here last time (persisted across navigation), and write
  // every change back so leaving + returning keeps the typed/dictated text.
  const [draft, setDraftState] = useState(() => draftStore.get(sessionId) ?? '');
  const setDraft = useCallback(
    (next: string | ((current: string) => string)) => {
      setDraftState((current) => {
        const resolved = typeof next === 'function' ? next(current) : next;
        draftStore.set(sessionId, resolved);
        return resolved;
      });
    },
    [sessionId],
  );
  // Live dictation writes recognized speech straight into the draft as it streams.
  const voice = useVoiceInput(draft, setDraft);
  // Branch switcher (#91): tap the top chip to switch this session's worktree to a
  // different branch — the chat (one persistent thread per session) stays put.
  const branches = useBranches(client, sessionId);
  const branchesRefresh = branches.refresh;
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // The chip names the CURRENT BRANCH; fall back to the session label while the
  // branch list is still loading (or if branch switching is unconfigured → 503).
  const sessionFallback = name?.trim() ? name.trim() : shortLabel(session.model, sessionId);
  // The header tracks the LIVE branch from the ~1.5s activity poll (#110) so the label
  // updates on an external/agent `git checkout` without a remount; fall back to the
  // load-once `useBranches` value until the first poll resolves (or when the server
  // doesn't report it). `||` (not `??`) so an empty/whitespace name also falls back.
  // `||` (not `??`): an empty live branch (the never-in-practice empty `rev-parse`)
  // also falls back to the load-once value rather than winning as ''.
  const effectiveBranch = liveBranch || branches.current;
  const currentLabel = effectiveBranch?.trim() || sessionFallback;
  // Issue # comes from the branch name (#125, works before any PR). The PR chip has
  // moved out of the header — the bottom PR status bar surfaces the PR now.
  const issueNumber = parseBranchIssue(effectiveBranch);
  // Tappable Issue chip (#161): build the GitHub URL from the server-surfaced owner/
  // repo. `githubRefUrl` returns null when owner/repo is unknown (no GitHub remote /
  // older server) — the chip then renders non-tappable, never linking to a broken URL.
  const repoIdentity = { owner: branches.owner, repo: branches.repo };
  const issueUrl = githubRefUrl('issue', repoIdentity, issueNumber);
  // Gate the PR bar until dismissed-state has loaded so a hidden bar does not flash
  // before the local cache resolves.
  const [pullRequestBarReady, setPullRequestBarReady] = useState(() =>
    dismissedPullRequests.loaded(),
  );
  const [, bumpPullRequestBarVersion] = useState(0);
  useEffect(() => {
    let active = true;
    void dismissedPullRequests.load().finally(() => {
      if (!active) return;
      setPullRequestBarReady(true);
      bumpPullRequestBarVersion((version) => version + 1);
    });
    return () => {
      active = false;
    };
  }, []);
  const pullRequestKey = branches.pullRequest
    ? `${sessionId}:${String(branches.pullRequest.number)}:${branches.pullRequest.phase}`
    : null;
  const pullRequestDismissed =
    branches.pullRequest?.phase !== 'open' &&
    pullRequestKey !== null &&
    dismissedPullRequests.store.has(pullRequestKey);
  const visiblePullRequest =
    pullRequestBarReady && branches.pullRequest && !pullRequestDismissed
      ? branches.pullRequest
      : null;
  const dismissPullRequest = useCallback(() => {
    if (pullRequestKey === null) return;
    dismissedPullRequests.store.add(pullRequestKey);
    dismissedPullRequests.persist();
    bumpPullRequestBarVersion((version) => version + 1);
    branchesRefresh();
  }, [branchesRefresh, pullRequestKey]);
  // When the live branch diverges from the load-once branch list (an external/agent
  // checkout the switcher didn't initiate), refresh the list so its rows AND the PR
  // chip track the new branch too. Converges in one step (refresh makes them match),
  // so no loop.
  useEffect(() => {
    // `liveBranch` truthy → ignore undefined (not yet polled) and the '' edge.
    if (liveBranch && branches.current !== undefined && liveBranch !== branches.current) {
      branchesRefresh();
    }
  }, [liveBranch, branches.current, branchesRefresh]);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) branchesRefresh();
    wasBusy.current = busy;
  }, [busy, branchesRefresh]);

  const [localMeetingUploads, setLocalMeetingUploads] = useState<LocalMeetingUploadActivity[]>([]);
  const localMeetingMessages = useMemo(
    () =>
      localMeetingUploads.flatMap((activity) => {
        // The canonical request bubble means the server owns the flow now. Drop both
        // optimistic rows together so the temporary upload status never lingers beside
        // the real transcript, even though the fallback timer keeps its local activity
        // around briefly in case a streamed notice was missed.
        return shouldShowLocalMeetingUpload(session.messages, activity.id)
          ? localMeetingUploadMessages(activity)
          : [];
      }),
    [localMeetingUploads, session.messages],
  );
  // The operator's just-sent messages, echoed locally until the server's `prompt`
  // event lands (or the send fails). Rendered as ordinary operator bubbles at the
  // tail so a message is on screen from the instant Send is tapped — on a slow
  // server it otherwise vanished for the whole round trip.
  const pendingEchoMessages = useMemo(
    () => pendingMessages.map(pendingEchoMessage),
    [pendingMessages],
  );
  const messages = useMemo(
    () => [...session.messages, ...localMeetingMessages, ...pendingEchoMessages],
    [session.messages, localMeetingMessages, pendingEchoMessages],
  );
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  // Group consecutive tool calls into one collapsible row (Claude-app style: a run
  // of tools reads as a single rolling line, not N stacked cards). The reducer keeps
  // messages chronological; grouping needs that order.
  const transcriptData = useMemo(() => groupRows(session.messages), [session.messages]);
  const localMeetingData = useMemo(() => groupRows(localMeetingMessages), [localMeetingMessages]);
  const pendingEchoData = useMemo(() => groupRows(pendingEchoMessages), [pendingEchoMessages]);
  const liveChronologicalData = useMemo(
    () => [...transcriptData, ...localMeetingData, ...pendingEchoData],
    [transcriptData, localMeetingData, pendingEchoData],
  );
  // The live tail is frozen while the operator reads history — see the freeze effect
  // below and lib/../transcriptFreeze.ts for why the list itself cannot hold their
  // position against a growing row 0. `null` = following the live edge.
  const [frozenTail, setFrozenTail] = useState<FrozenTranscriptTail | null>(null);
  const frozenRows = useMemo(
    () => (frozenTail === null ? null : frozenTranscriptRows(messages, frozenTail)),
    [frozenTail, messages],
  );
  const chronologicalData = frozenRows ?? liveChronologicalData;
  // Both assigned during render (same reasoning as `dataRef` below): the freeze is
  // driven from scroll callbacks and effects that must see the CURRENT transcript,
  // not the one captured when the callback was created.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const frozenTailRef = useRef<FrozenTranscriptTail | null>(null);
  frozenTailRef.current = frozenTail;
  const snapshotLiveTail = useCallback(() => {
    setFrozenTail(freezeTranscriptTail(messagesRef.current));
  }, []);
  // A snapshot whose boundary message is gone (the transcript was reloaded) no longer
  // describes this session: `frozenTranscriptRows` returned null and we are rendering
  // live rows, so take a fresh snapshot to freeze the tail again.
  useEffect(() => {
    if (frozenTail !== null && frozenRows === null) snapshotLiveTail();
  }, [frozenTail, frozenRows, snapshotLiveTail]);
  // FlashList is fed NEWEST-FIRST and rendered inverted (styles.invertedList /
  // styles.invertedItem). That single decision is what removes the whole class of
  // prepend jumps: older pages append at the DATA END, behind the viewport, so no row
  // is ever inserted in front of what the operator is reading and there is nothing to
  // correct afterwards. See lib/scrollPosition.ts for the coordinate system.
  //
  // Known trade-off: the scaleY transform flips pixels, not the data order, so the
  // accessibility tree is newest-first. React Native's own `inverted` prop (which
  // FlashList 2 dropped) has exactly this property, and RN 0.85 exposes no traversal-
  // order prop, so no in-tree fix exists; VoiceOver and TalkBack both fall back to
  // geometric ordering of the transformed frames, which is the visual order, so how
  // much of this reaches a screen-reader user needs a device to answer. If it does,
  // the fix is a screen-reader mode that renders chronologically — those users
  // navigate by element focus, where the paging jumps this inversion removes barely
  // matter — not a per-row patch here.
  const data = useMemo(() => [...chronologicalData].reverse(), [chronologicalData]);
  const latestTranscriptRowKey =
    transcriptData.length > 0 ? rowKey(transcriptData[transcriptData.length - 1]) : null;
  const dataRef = useRef<Row[]>([]);
  const loadOlderNearStartRef = useRef<(allowStalledRetry?: boolean) => void>(() => undefined);
  // Assigned during render, not in an effect: FlashList reports viewability from a
  // layout callback whose order against passive effects is not guaranteed. A first
  // viewability report that still saw an empty `dataRef` would read row count 0, decide
  // the oldest row is not viewable, and skip the initial page — and an underfilled
  // transcript emits no further scroll event to retry with. `data` is derived purely
  // from state, so a discarded render can only write a value the next render overwrites.
  dataRef.current = data;
  // "Jump to latest" affordance (Claude-style): a pill shown when scrolled up from
  // the bottom; tapping it scrolls to the end.
  const listRef = useRef<FlashListRef<Row>>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  // True only after an intentional operator navigation away from the bottom:
  // dragging the transcript, jumping between own messages, or opening a bookmark.
  // FlashList also emits onScroll for layout correction, restore positioning, and
  // live content changes; those events must not disable bottom-follow or poison the
  // saved re-entry anchor.
  const readingAwayFromBottomRef = useRef(false);
  const lastScrollYRef = useRef(0);
  const lastViewportHeightRef = useRef(0);
  const lastContentHeightRef = useRef(0);
  const userScrollActiveRef = useRef(false);
  // True from requesting a history page until its appended rows have been committed
  // and measured. It gates automatic follow-up loads only — the append itself happens
  // behind the viewport and needs no scroll bookkeeping.
  const historyAppendSettlingRef = useRef(false);
  const historyAppendSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stalledRetryAvailableRef = useRef(false);
  const olderLoadDisarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollDebugSeqRef = useRef(0);
  const scrollDebugDirectionRef = useRef<boolean | null>(null);
  const scrollDebugLastProgrammaticAtRef = useRef(0);
  const hasOlderDebugRef = useRef(hasOlder);
  const loadingOlderDebugRef = useRef(loadingOlder);
  const restoringDebugRef = useRef(true);
  const messagesLengthDebugRef = useRef(messages.length);
  // Returning to the live edge (jump-to-latest, or reaching it by hand) re-asserts
  // offset zero across the next few frames instead of once. Offset zero is an exact
  // constant in the inverted list, so re-issuing it is idempotent and cheap — and the
  // commit that puts the live tail back renders rows in FRONT of the viewport, which
  // makes the list issue its own (here: unwanted) offset correction one frame later.
  // These passes overrule it. Only a real finger drag stops them; a non-zero offset
  // reported in between is exactly the thing being corrected, so `atBottom` is
  // deliberately not part of the check.
  const repinRafRef = useRef<number | null>(null);
  const repinTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const returningToLatestRef = useRef(false);
  const cancelRepinTimers = useCallback(() => {
    if (repinRafRef.current !== null) cancelAnimationFrame(repinRafRef.current);
    repinRafRef.current = null;
    for (const id of repinTimersRef.current) clearTimeout(id);
    repinTimersRef.current = [];
  }, []);
  const repinToLatestEdge = useCallback(
    (animated: boolean) => {
      cancelRepinTimers();
      returningToLatestRef.current = true;
      const pin = (last: boolean) => {
        if (
          userScrollActiveRef.current ||
          readingAwayFromBottomRef.current ||
          restoringDebugRef.current
        ) {
          returningToLatestRef.current = false;
          return;
        }
        listRef.current?.scrollToOffset({ offset: 0, animated: false });
        // We just commanded the newest edge; say so rather than leaving the
        // jump-to-latest pill flashing on the offset the correction reported in between.
        if (!atBottomRef.current) {
          atBottomRef.current = true;
          setAtBottom(true);
        }
        if (last) returningToLatestRef.current = false;
      };
      // An animated jump owns the viewport until its animation settles — both platforms
      // run a fixed ~300ms programmatic scroll — so pinning before that would cut the
      // very animation the caller asked for. Wait it out instead. A non-animated caller
      // is already at the edge and wants it held from the next frame on.
      if (animated) {
        repinTimersRef.current.push(
          setTimeout(() => pin(false), 350),
          setTimeout(() => pin(true), 600),
        );
        return;
      }
      repinRafRef.current = requestAnimationFrame(() => pin(false));
      repinTimersRef.current.push(
        setTimeout(() => pin(false), 120),
        setTimeout(() => pin(true), 300),
      );
    },
    [cancelRepinTimers],
  );
  useEffect(() => cancelRepinTimers, [cancelRepinTimers]);
  // The single freeze/unfreeze decision. Both the passive effect near the end of this
  // component and every callback that deliberately leaves the newest edge run it, so
  // there is one rule rather than two that can disagree. It is idempotent: a steady
  // state touches no state at all.
  //
  // Taking the snapshot is layout-neutral by construction — it holds exactly the rows
  // that are on screen at that moment, with the same keys — so a caller may run it
  // right after issuing a programmatic scroll without disturbing it. Do run it AFTER:
  // the snapshot follows the newest message the reducer has published, which can be one
  // delta ahead of the `data` a row index was computed from.
  const syncTailFreeze = useCallback(() => {
    if (restoringDebugRef.current) return;
    if (returningToLatestRef.current && !userScrollActiveRef.current) return;
    const following = shouldFollowStreamingContent(
      atBottomRef.current,
      readingAwayFromBottomRef.current,
      restoringDebugRef.current,
    );
    if (following) {
      if (frozenTailRef.current === null) return;
      // Back at the live edge: hold offset zero across the commit that splices the
      // withheld rows back in. They land in FRONT of the reader in layout terms, where
      // the same broken correction would otherwise push the viewport off the edge it
      // just reached.
      setFrozenTail(null);
      repinToLatestEdge(false);
      return;
    }
    if (frozenTailRef.current === null && messagesRef.current.length > 0) snapshotLiveTail();
  }, [repinToLatestEdge, snapshotLiveTail]);
  useEffect(() => {
    hasOlderDebugRef.current = hasOlder;
  }, [hasOlder]);
  useEffect(() => {
    loadingOlderDebugRef.current = loadingOlder;
  }, [loadingOlder]);
  useEffect(() => {
    messagesLengthDebugRef.current = messages.length;
  }, [messages.length]);
  const reportScrollDebug = useCallback(
    (event: string, data: Record<string, unknown> = {}) => {
      const seq = (scrollDebugSeqRef.current += 1);
      void client
        .reportScrollDiagnostic(sessionId, {
          event,
          seq,
          at: Date.now(),
          data: {
            atBottom: atBottomRef.current,
            readingAwayFromBottom: readingAwayFromBottomRef.current,
            hasOlder: hasOlderDebugRef.current,
            loadingOlder: loadingOlderDebugRef.current,
            restoring: restoringDebugRef.current,
            rows: dataRef.current.length,
            messages: messagesLengthDebugRef.current,
            userScrollActive: userScrollActiveRef.current,
            ...data,
          },
        })
        .catch(() => undefined);
    },
    [client, sessionId],
  );
  // Measured height of the input bar (incl. its safe-area padding, and any extra
  // rows it grows — multi-line text, attachment previews). The scroll-to-bottom
  // button is anchored a fixed gap above it, so it tracks the bar instead of a
  // hardcoded offset that only fit a single-line bar.
  const [inputBarHeight, setInputBarHeight] = useState(0);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [highlightedSearchQuery, setHighlightedSearchQuery] = useState<string | null>(null);
  const clearSearchHighlight = useCallback(() => {
    setHighlightedMessageId(null);
    setHighlightedSearchQuery(null);
  }, []);
  const clearSearchHighlightAfterTouch = useCallback(() => {
    requestAnimationFrame(clearSearchHighlight);
  }, [clearSearchHighlight]);
  const onDraftChange = useCallback(
    (text: string) => {
      clearSearchHighlight();
      setDraft(text);
    },
    [clearSearchHighlight],
  );
  // Auto-fade for the message-nav stack. It stays HIDDEN until the operator ACTIVELY
  // scrolls (onScrollBeginDrag — a real finger drag, NOT programmatic/content-driven
  // scroll: opening a session or the agent streaming new rows must not summon it), then
  // fades in, holds, and fades out after a short idle. So it never fights the transcript
  // text at rest and needs no reserved gutter (steals no width). `navFaded` gates
  // pointerEvents so the invisible stack can't swallow taps over the transcript.
  const navOpacity = useRef(new Animated.Value(0)).current;
  const [navFaded, setNavFaded] = useState(true);
  const navShownRef = useRef(false);
  const navFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualScrollGestureRef = useRef(false);
  const fingerDragActiveRef = useRef(false);
  const momentumScrollActiveRef = useRef(false);
  // Show the stack (animate in from hidden/fading) and CANCEL any pending fade — it
  // stays put while the list is in motion. Reveal fires on drag- and momentum-BEGIN;
  // the fade is (re)scheduled only when motion ENDS, so the hold is measured from the
  // list coming to REST, not from when the drag started.
  const revealNav = useCallback(() => {
    if (navFadeTimer.current) {
      clearTimeout(navFadeTimer.current);
      navFadeTimer.current = null;
    }
    // Only animate IN when coming from hidden/fading — a new timing() on the same value
    // interrupts a running fade-out, so a scroll mid-fade reverses smoothly.
    if (!navShownRef.current) {
      navShownRef.current = true;
      setNavFaded(false);
      Animated.timing(navOpacity, {
        toValue: 1,
        duration: 280,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }).start();
    }
  }, [navOpacity]);
  // Start the hold-then-fade countdown. Fires on drag- and momentum-END (a finger lift
  // with no fling ends via onScrollEndDrag; a fling ends via onMomentumScrollEnd). If a
  // fling follows the lift, onMomentumScrollBegin → revealNav cancels this first timer,
  // so the real countdown only runs once the list is truly at rest.
  const scheduleNavFade = useCallback(() => {
    if (navFadeTimer.current) clearTimeout(navFadeTimer.current);
    navFadeTimer.current = setTimeout(() => {
      navShownRef.current = false;
      Animated.timing(navOpacity, {
        toValue: 0,
        duration: 650,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setNavFaded(true);
      });
    }, 1800);
  }, [navOpacity]);
  const scheduleUserScrollSettle = useCallback(
    (delayMs: number, terminal: boolean) => {
      if (olderLoadDisarmTimer.current) clearTimeout(olderLoadDisarmTimer.current);
      olderLoadDisarmTimer.current = setTimeout(() => {
        olderLoadDisarmTimer.current = null;
        // onScroll's idle fallback may fire while a finger is still held stationary.
        // Preserve the manual lifecycle until drag/momentum end confirms completion.
        if (manualScrollGestureRef.current && !terminal) return;
        const wasManualGesture = manualScrollGestureRef.current;
        manualScrollGestureRef.current = false;
        userScrollActiveRef.current = false;
        stalledRetryAvailableRef.current = false;
        scheduleNavFade();
        if (followSettleTimer.current) {
          clearTimeout(followSettleTimer.current);
          followSettleTimer.current = null;
        }
        const settledAtBottom = atBottomRef.current;
        if (wasManualGesture && settledAtBottom) readingAwayFromBottomRef.current = false;
        const oldestRowViewable = isOldestRowViewable(
          oldestVisibleIndexRef.current,
          dataRef.current.length,
        );
        reportScrollDebug('settle-idle', {
          delayMs,
          terminal,
          settledAtBottom,
          wasManualGesture,
          oldestRowViewable,
        });
        // The gesture is over, so a page withheld by the append-settle window or by
        // the gesture guard can run now. Nothing else would trigger it: a list whose
        // last row is still viewable is one that produced no further scroll events.
        if (oldestRowViewable) loadOlderNearStartRef.current();
        // This is the moment a manual scroll that ended at the newest edge starts
        // following again (`readingAwayFromBottomRef` was just cleared above), and it
        // publishes no state — so resume the live tail from here rather than waiting
        // for a render that may not come while the agent is between messages.
        syncTailFreeze();
      }, delayMs);
    },
    [reportScrollDebug, scheduleNavFade, syncTailFreeze],
  );
  const cancelPendingUserScrollSettle = useCallback(() => {
    if (olderLoadDisarmTimer.current) {
      clearTimeout(olderLoadDisarmTimer.current);
      olderLoadDisarmTimer.current = null;
    }
    if (followSettleTimer.current) {
      clearTimeout(followSettleTimer.current);
      followSettleTimer.current = null;
    }
    userScrollActiveRef.current = false;
    manualScrollGestureRef.current = false;
    fingerDragActiveRef.current = false;
  }, []);
  // Starts hidden (see initial state above) — no reveal on mount. Just clear the
  // pending fade timer on unmount.
  useEffect(() => {
    return () => {
      if (navFadeTimer.current) clearTimeout(navFadeTimer.current);
      if (followSettleTimer.current) clearTimeout(followSettleTimer.current);
      if (olderLoadDisarmTimer.current) clearTimeout(olderLoadDisarmTimer.current);
      if (historyAppendSettleTimer.current) clearTimeout(historyAppendSettleTimer.current);
    };
  }, []);
  // onScroll fires for ALL scrolls (incl. programmatic / maintainVisibleContentPosition
  // as the agent streams) — use it only for the at-latest check, NOT to summon the nav.
  const isScrollEventAtBottom = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Inverted list: the newest edge is offset zero, so this is exact even while rows
    // further down are still being measured.
    return isAtLatestEdge(e.nativeEvent.contentOffset.y);
  }, []);
  const isPlausibleScrollEvent = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const y = contentOffset.y;
    if (!Number.isFinite(y)) return false;
    return y >= 0 && y < contentSize.height + layoutMeasurement.height;
  }, []);
  const onListScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!isPlausibleScrollEvent(e)) return;
      const y = e.nativeEvent.contentOffset.y;
      const viewportHeight = e.nativeEvent.layoutMeasurement.height;
      lastViewportHeightRef.current = viewportHeight;
      const contentHeight = e.nativeEvent.contentSize.height;
      lastContentHeightRef.current = contentHeight;
      // The oldest loaded row sits at the CONTENT END in the inverted list.
      if (
        isHistoryEdgeVisible(
          y,
          contentHeight,
          viewportHeight,
          oldestVisibleIndexRef.current,
          dataRef.current.length,
        )
      ) {
        const allowStalledRetry = stalledRetryAvailableRef.current;
        stalledRetryAvailableRef.current = false;
        loadOlderNearStartRef.current(allowStalledRetry);
      }
      const previousY = lastScrollYRef.current;
      const dy = y - previousY;
      const absDy = Math.abs(dy);
      const staleDeltaThreshold = Math.max(
        viewportHeight * SCROLL_STALE_DELTA_VIEWPORTS,
        SCROLL_STALE_DELTA_MIN,
      );
      const staleLayoutDelta = absDy > staleDeltaThreshold;
      const directionEpsilon = atBottomRef.current
        ? SCROLL_BOTTOM_BOUNCE_EPSILON
        : SCROLL_DIRECTION_EPSILON;
      if (userScrollActiveRef.current && absDy > directionEpsilon && !staleLayoutDelta) {
        const towardHistory = isScrollTowardHistory(dy);
        if (scrollDebugDirectionRef.current !== towardHistory) {
          scrollDebugDirectionRef.current = towardHistory;
          reportScrollDebug('direction-change', { towardHistory, y, previousY, dy });
        }
        scheduleUserScrollSettle(220, false);
      } else if (userScrollActiveRef.current && staleLayoutDelta) {
        reportScrollDebug('ignored-stale-scroll-delta', {
          y,
          previousY,
          dy,
          contentHeight,
          viewportHeight,
        });
      }
      if (!userScrollActiveRef.current && previousY !== 0 && absDy > 80) {
        const now = Date.now();
        if (now - scrollDebugLastProgrammaticAtRef.current > 500) {
          scrollDebugLastProgrammaticAtRef.current = now;
          reportScrollDebug('programmatic-scroll-delta', {
            y,
            previousY,
            dy,
            contentHeight: e.nativeEvent.contentSize.height,
            viewportHeight: e.nativeEvent.layoutMeasurement.height,
          });
        }
      }
      lastScrollYRef.current = y;
      if (shouldAcceptNativeLatestState(restoringDebugRef.current)) {
        const nextAtBottom = isScrollEventAtBottom(e);
        atBottomRef.current = nextAtBottom;
        setAtBottom(nextAtBottom);
      }
    },
    [isPlausibleScrollEvent, isScrollEventAtBottom, reportScrollDebug, scheduleUserScrollSettle],
  );
  // "Jump between MY messages" affordance: the operator's own prompts are their
  // orientation anchors in a long transcript. `⌃`/`⌄` step to the previous/next
  // `user-text` row instead of hunting by eye. Indices into `data` (recomputed as
  // rows stream/prepend), plus the topmost visible index as the cursor prev/next
  // move relative to.
  const userRowIndices = useMemo(() => {
    const out: number[] = [];
    data.forEach((row, i) => {
      if (row.kind === 'message' && row.message.kind === 'user-text') out.push(i);
    });
    return out;
  }, [data]);
  // Two cursors, because the list is inverted: the SMALLEST visible index is the
  // newest visible row (visually at the bottom) and backs the saved re-entry anchor;
  // the LARGEST is the visually topmost row and drives message navigation and the
  // history edge.
  const [oldestVisibleIndex, setOldestVisibleIndex] = useState(0);
  const oldestVisibleIndexRef = useRef(0);
  const newestVisibleIndexRef = useRef(0);
  const newestVisibleAnchorRef = useRef<ScrollAnchor | null>(null);
  const visualTopAnchorRef = useRef<ScrollAnchor | null>(null);
  // FlashList requires a STABLE onViewableItemsChanged / viewabilityConfig (it warns
  // and refuses to update mid-flight if the identity changes), so keep both in refs.
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    let min = Infinity;
    let max = -1;
    for (const v of viewableItems) {
      if (v.index == null) continue;
      if (v.index < min) min = v.index;
      if (v.index > max) max = v.index;
    }
    if (min !== Infinity) {
      newestVisibleIndexRef.current = min;
      newestVisibleAnchorRef.current = anchorFromRow(dataRef.current[min], false, null);
    }
    if (max >= 0) {
      oldestVisibleIndexRef.current = max;
      setOldestVisibleIndex(max);
      visualTopAnchorRef.current = anchorFromRow(dataRef.current[max], false, null);
      // This also covers an initial tail shorter than the viewport: there may be no
      // scroll event at all, but the oldest loaded row is already visible and older
      // history still needs fetching until the viewport is populated.
      if (isOldestRowViewable(max, dataRef.current.length)) loadOlderNearStartRef.current();
    }
  }).current;
  // Nearest user rows strictly above / below the cursor (-1 when none — the button
  // then reads as disabled and no-ops rather than disappearing, so the stack layout
  // stays put).
  // Newest-first data: an OLDER user message has a LARGER index, a newer one a
  // smaller. Both cursors are taken from the visually topmost row, so "previous"
  // reads as "the prompt above what I'm looking at" either way.
  const userRowAfterIndex = useCallback(
    (index: number) => {
      for (const idx of userRowIndices) if (idx > index) return idx;
      return -1;
    },
    [userRowIndices],
  );
  const prevUserIndex = useMemo(
    () => userRowAfterIndex(oldestVisibleIndex),
    [userRowAfterIndex, oldestVisibleIndex],
  );
  const nextUserIndex = useMemo(() => {
    let found = -1;
    for (const idx of userRowIndices) {
      if (idx < oldestVisibleIndex) found = idx;
      else break;
    }
    return found;
  }, [userRowIndices, oldestVisibleIndex]);
  const canJumpToPreviousUser = prevUserIndex >= 0 || hasOlder;
  const scrollToUserRow = useCallback(
    (index: number) => {
      if (index < 0) return;
      cancelPendingUserScrollSettle();
      readingAwayFromBottomRef.current = true;
      // Inverted list: viewPosition 1 aligns the row's layout END with the viewport's
      // layout end, which on screen is the row parked at the TOP — so the agent's
      // reply to that prompt reads downward from there.
      scrollDebugLastProgrammaticAtRef.current = Date.now();
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 1 });
      // Nothing here publishes state, so freeze from the callback rather than waiting
      // for an unrelated render to run the pass at the end of the component.
      syncTailFreeze();
    },
    [cancelPendingUserScrollSettle, syncTailFreeze],
  );
  const [pendingUserJump, setPendingUserJump] = useState<'previous' | null>(null);
  const userJumpRowsRef = useRef(-1);
  const jumpToPreviousUserRow = useCallback(() => {
    if (prevUserIndex >= 0) {
      scrollToUserRow(prevUserIndex);
      return;
    }
    if (!hasOlder) return;
    cancelPendingUserScrollSettle();
    readingAwayFromBottomRef.current = true;
    const currentData = dataRef.current;
    visualTopAnchorRef.current =
      currentData[oldestVisibleIndex] !== undefined
        ? anchorFromRow(currentData[oldestVisibleIndex], false, null)
        : visualTopAnchorRef.current;
    userJumpRowsRef.current = -1;
    setPendingUserJump('previous');
  }, [cancelPendingUserScrollSettle, hasOlder, prevUserIndex, scrollToUserRow, oldestVisibleIndex]);
  useEffect(() => {
    if (pendingUserJump !== 'previous') return;
    const anchor = visualTopAnchorRef.current;
    const anchorIndex =
      anchor === null ? oldestVisibleIndex : findAnchorIndex(data, anchor, 'newest-first');
    const cursor = anchorIndex >= 0 ? anchorIndex : oldestVisibleIndex;
    // Older = larger index, so the nearest previous prompt is the first one past the
    // cursor. The appended page can only add rows behind it, never renumber it.
    let target = -1;
    for (const idx of userRowIndices) {
      if (idx > cursor) {
        target = idx;
        break;
      }
    }
    if (target >= 0) {
      setPendingUserJump(null);
      requestAnimationFrame(() => scrollToUserRow(target));
      return;
    }
    if (loadingOlder) return;
    if (!hasOlder || data.length === userJumpRowsRef.current) {
      setPendingUserJump(null);
      return;
    }
    userJumpRowsRef.current = data.length;
    loadOlder();
  }, [
    pendingUserJump,
    data,
    oldestVisibleIndex,
    userRowIndices,
    loadingOlder,
    hasOlder,
    loadOlder,
    scrollToUserRow,
  ]);

  // ── Scroll-position memory (persist where the operator was reading) ────────────
  // Compute the anchor synchronously from refs at departure time. That avoids saving a
  // one-render-stale React state snapshot when the operator scrolls and immediately
  // navigates away or backgrounds the app.
  const currentScrollAnchor = useCallback((): ScrollAnchor => {
    const currentData = dataRef.current;
    const useVisibleAnchor = !atBottomRef.current && readingAwayFromBottomRef.current;
    if (useVisibleAnchor) {
      // The row at the LAYOUT top of the inverted viewport is the newest one on
      // screen — visually the bottom-most, which is exactly the "last message I had
      // read" the anchor promises.
      const index = newestVisibleIndexRef.current;
      const anchor =
        newestVisibleAnchorRef.current ?? anchorFromRow(currentData[index], false, null);
      // A stale visible index or an unmeasured row yields an absolute list offset rather
      // than an intra-row one; persisting that would restore pages off-target. Saving
      // `null` means "reposition by row identity alone".
      const intraRowOffset = historyAnchorIntraRowOffset(
        lastScrollYRef.current,
        listRef.current?.getLayout(index),
      );
      return {
        ...anchor,
        offsetY: intraRowOffset,
        coordinateSystem: TRANSCRIPT_COORDINATE_SYSTEM,
      };
    }
    // Newest-first: index 0 is the latest row.
    return anchorFromRow(currentData[0], true, 0);
  }, []);
  const restoreBusyRef = useRef(true);
  const saveCurrentScrollAnchor = useCallback(() => {
    if (restoreBusyRef.current) return;
    saveScrollAnchor(sessionId, currentScrollAnchor());
  }, [sessionId, currentScrollAnchor]);
  // Persist the anchor when the operator leaves this session (useFocusEffect cleanup
  // fires on blur — the navigate-away case) and when the app is sent to the
  // background (the app-kill case, which blur never sees). Both funnel through the
  // same idempotent write, so a double-fire is harmless. Only 'background' (not the
  // transient iOS 'inactive' from an app-switcher peek / Face ID / notification, which
  // isn't a real departure) so we don't overwrite with an intermediate anchor.
  useFocusEffect(
    useCallback(() => {
      return saveCurrentScrollAnchor;
    }, [saveCurrentScrollAnchor]),
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') saveCurrentScrollAnchor();
    });
    return () => sub.remove();
  }, [saveCurrentScrollAnchor]);
  // Restore the saved position ONCE per session-open, after the backlog has drained
  // (`loaded`) and the list has data. We find the last-seen row by key and park it at
  // the top of the viewport. Anchored to the ROW, not a
  // pixel offset, so variable row heights and streamed appends don't drift it.
  //
  // We only restore anchors that are already present in the initial loaded tail. A deep
  // stored anchor would require paging older history on open, which made long sessions
  // feel stuck behind the restore cover and could walk toward the transcript start.
  // If the anchor is not in the tail, reveal at the bottom and let deliberate scrolling
  // load older pages.
  // `restoredSessionRef` is a belt-and-braces guard; the embedded pane already remounts
  // per session via `key={selectedId}` (index.tsx), so this is a fresh mount either way.
  const restoredSessionRef = useRef<string | null>(null);
  // True once we've SCHEDULED the final scroll-to-anchor, so the positioning effect
  // (which re-runs on every `data` change) doesn't re-schedule it. Not a cleanup-
  // cancelled timer: clearing `restoreTarget` re-runs the effect, and a cleanup there
  // would cancel the very scroll we just queued.
  const positioningRef = useRef(false);
  // Set when the operator's own finger drag interrupts an in-flight restore, so the
  // converging re-scrolls (below) stop fighting them. Only a real drag flips it —
  // programmatic scrollToIndex fires onScroll, NOT onScrollBeginDrag.
  const restoreInterruptedRef = useRef(false);
  // Pending timers / handles of the converging restore, so they can be cancelled on
  // unmount. We DON'T cancel on the positioning effect's own re-runs (it re-runs on
  // every streamed `data` delta — cancelling there would kill the in-flight scroll);
  // cleanup lives in a separate unmount-only effect below.
  const restoreTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const restoreTaskRef = useRef<ReturnType<typeof InteractionManager.runAfterInteractions> | null>(
    null,
  );
  const restoreRafRef = useRef<number | null>(null);
  const cancelRestoreTimers = useCallback(() => {
    for (const id of restoreTimersRef.current) clearTimeout(id);
    restoreTimersRef.current = [];
    restoreTaskRef.current?.cancel();
    restoreTaskRef.current = null;
    if (restoreRafRef.current !== null) cancelAnimationFrame(restoreRafRef.current);
    restoreRafRef.current = null;
  }, []);
  useEffect(() => cancelRestoreTimers, [cancelRestoreTimers]);
  // The anchor row we still need to reach (null = no restore in flight). `restoring`
  // gates the cover overlay while the final scroll-to-anchor convergence runs.
  // Without covering the in-tail case, the list can
  // visibly render at FlashList's initial estimate, then hop a few rows when the restore
  // pass lands after layout/measurement.
  const [restoreTarget, setRestoreTarget] = useState<ScrollAnchor | null>(null);
  const [restoring, setRestoring] = useState(true);
  // Opening at the newest edge is offset ZERO in the inverted list — an exact constant
  // that no row measurement can invalidate. The former converging scroll-to-end (three
  // passes against progressively-measured estimates, each one visible) has no
  // counterpart here: FlashList already starts at index 0, so this is a no-op reassert
  // rather than a correction.
  const restoreToLatestEdge = useCallback(
    (reason: string) => {
      cancelRestoreTimers();
      if (restoreInterruptedRef.current || userScrollActiveRef.current) {
        positioningRef.current = false;
        setRestoring(false);
        reportScrollDebug('restore-latest-interrupted', { reason });
        return;
      }
      positioningRef.current = false;
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
      atBottomRef.current = true;
      setAtBottom(true);
      setRestoring(false);
      reportScrollDebug('restore-latest', { reason });
    },
    [cancelRestoreTimers, reportScrollDebug],
  );
  const hasRestoreData = data.length > 0;
  useEffect(() => {
    restoringDebugRef.current = restoring;
    restoreBusyRef.current = restoring || restoreTarget !== null || positioningRef.current;
  }, [restoring, restoreTarget]);
  useEffect(() => {
    if (restoredSessionRef.current === sessionId) return;
    if (!loaded || !hasRestoreData) return;
    let active = true;
    const requestedSessionId = sessionId;
    restoredSessionRef.current = sessionId;
    positioningRef.current = false;
    restoreBusyRef.current = true;
    // Reset the drag-abort flag once per session open (not in the positioning branch
    // below) so an interrupt raised while older history is still paging in is preserved
    // into the convergence rather than discarded when the row finally loads.
    restoreInterruptedRef.current = false;
    void loadScrollAnchor(requestedSessionId).then((anchor) => {
      if (!active || sessionIdRef.current !== requestedSessionId) return;
      if (restoreInterruptedRef.current) {
        reportScrollDebug('restore-skipped-after-user-action');
        setRestoring(false);
        return;
      }
      if (shouldRestoreToLatestEdge(anchor)) {
        readingAwayFromBottomRef.current = false;
        restoreToLatestEdge(anchor?.atBottom ? 'saved-bottom' : 'empty');
        return;
      }
      if (!anchor) return;
      const inTail = findAnchorIndex(dataRef.current, anchor, 'newest-first') >= 0;
      reportScrollDebug('restore-anchor', {
        ...scrollAnchorDebug('anchor', anchor),
        inTail,
      });
      if (!inTail) {
        // Do not page deep history on open. A stale/bad deep anchor makes the session
        // feel stuck behind the restore cover and can fetch toward the beginning of a
        // long transcript. Restore only positions already loaded in the initial tail.
        readingAwayFromBottomRef.current = false;
        reportScrollDebug('restore-skip-deep-anchor', scrollAnchorDebug('anchor', anchor));
        // The saved row is outside the initially loaded tail — open at the newest edge
        // and let deliberate scrolling page older history back in.
        restoreToLatestEdge('deep-anchor-not-loaded');
        return;
      }
      // Left scrolled up reading history and that row is still in the loaded tail:
      // cover the final positioning so the operator never sees the measurement
      // correction hop.
      readingAwayFromBottomRef.current = true;
      setRestoring(true);
      setRestoreTarget(anchor);
    });
    return () => {
      active = false;
    };
  }, [restoreToLatestEdge, loaded, hasRestoreData, reportScrollDebug, sessionId]);
  // Positioning loop. Restore only targets rows already present in the initial loaded
  // tail; it never fetches older history on open.
  useEffect(() => {
    if (restoreTarget === null || positioningRef.current) return;
    const index = findAnchorIndex(data, restoreTarget, 'newest-first');
    if (index >= 0) {
      positioningRef.current = true;
      cancelRestoreTimers();
      reportScrollDebug('restore-position', {
        index,
        ...scrollAnchorDebug('target', restoreTarget),
      });
      // CONVERGING restore. FlashList's scrollToIndex computes the target offset from
      // ESTIMATED row heights; until the rows around the anchor are actually measured
      // that estimate is off, which landed the operator ~a screen up or a few lines
      // down. So we re-issue the (instant, idempotent) scroll across several frames:
      // each pass runs against progressively-more-measured layout and converges on the
      // true position. We only reveal the cover AFTER the last pass, so the paging case
      // never flashes an intermediate position. A real finger drag aborts the sequence
      // (restoreInterruptedRef) so we don't fight the operator taking over.
      const RESTORE_STEPS_MS = [0, 60, 150, 300, 500];
      const settle = () => {
        cancelRestoreTimers();
        setRestoring(false);
        setRestoreTarget(null);
        positioningRef.current = false;
      };
      const step = (i: number) => {
        if (restoreInterruptedRef.current) {
          settle();
          return;
        }
        const currentIndex = findAnchorIndex(dataRef.current, restoreTarget, 'newest-first');
        if (currentIndex < 0) {
          reportScrollDebug('restore-target-lost', scrollAnchorDebug('target', restoreTarget));
          settle();
          return;
        }
        try {
          // Always restore by stable row identity. An offset stored by the former
          // chronological layout measures a different quantity, so it is dropped and
          // the row alone decides the position.
          const intraRowOffset = migratedAnchorOffset(
            restoreTarget.coordinateSystem,
            restoreTarget.offsetY,
          );
          void listRef.current
            ?.scrollToIndex(transcriptRestoreRequest(currentIndex, intraRowOffset))
            .catch(() => undefined);
        } catch {
          // A transient out-of-range (anchor shifted mid-stream) must not strand the
          // cover — fall through to the next pass / settle rather than throwing out.
        }
        if (i + 1 < RESTORE_STEPS_MS.length) {
          restoreTimersRef.current.push(
            setTimeout(() => step(i + 1), RESTORE_STEPS_MS[i + 1] - RESTORE_STEPS_MS[i]),
          );
        } else {
          // Reveal on the next frame so the final scroll has committed before the cover
          // lifts, then clear the restore state.
          restoreRafRef.current = requestAnimationFrame(settle);
        }
      };
      // Start once the open transition has settled (InteractionManager); a timeout backs
      // it up if that handle is delayed (mirrors the composer-focus pattern above).
      let started = false;
      const begin = () => {
        if (started) return;
        started = true;
        step(0);
      };
      restoreTaskRef.current = InteractionManager.runAfterInteractions(begin);
      restoreTimersRef.current.push(setTimeout(begin, 300));
      return;
    }
    // A normal user-triggered history load is in flight — wait for it to settle.
    if (loadingOlder) return;
    // Target vanished or was not in the loaded tail: give up and reveal.
    reportScrollDebug('restore-give-up', scrollAnchorDebug('target', restoreTarget));
    setRestoreTarget(null);
    setRestoring(false);
  }, [restoreTarget, data, loadingOlder, cancelRestoreTimers, reportScrollDebug]);
  // Hard safety net: never let the cover overlay stick if positioning stalls (e.g. a
  // paging fetch hangs). Force-reveal after a few seconds regardless.
  useEffect(() => {
    if (!restoring) return;
    const timer = setTimeout(() => {
      cancelRestoreTimers();
      setRestoring(false);
      setRestoreTarget(null);
      positioningRef.current = false;
    }, 6000);
    return () => clearTimeout(timer);
  }, [restoring]);
  // A real finger drag both summons the message-nav stack (revealNav) AND aborts any
  // in-flight restore convergence, so the operator can immediately take over the scroll
  // without the re-scrolls fighting them.
  const onListScrollBeginDrag = useCallback(() => {
    clearSearchHighlight();
    momentumScrollActiveRef.current = false;
    manualScrollGestureRef.current = true;
    fingerDragActiveRef.current = true;
    readingAwayFromBottomRef.current = true;
    userScrollActiveRef.current = true;
    stalledRetryAvailableRef.current = true;
    if (
      isHistoryEdgeVisible(
        lastScrollYRef.current,
        lastContentHeightRef.current,
        lastViewportHeightRef.current,
        oldestVisibleIndexRef.current,
        dataRef.current.length,
      )
    ) {
      stalledRetryAvailableRef.current = false;
      loadOlderNearStartRef.current(true);
    }
    scrollDebugDirectionRef.current = null;
    reportScrollDebug('begin-drag');
    if (olderLoadDisarmTimer.current) {
      clearTimeout(olderLoadDisarmTimer.current);
      olderLoadDisarmTimer.current = null;
    }
    restoreInterruptedRef.current = true;
    if (followSettleTimer.current) {
      clearTimeout(followSettleTimer.current);
      followSettleTimer.current = null;
    }
    // A finger on the list is the most common way to leave the edge, and the one that
    // must take effect immediately: from here on the tail is held still, so the drag
    // lands where the operator aimed it even while the agent writes below.
    syncTailFreeze();
    revealNav();
  }, [clearSearchHighlight, reportScrollDebug, revealNav, syncTailFreeze]);
  const onListMomentumScrollBegin = useCallback(() => {
    if (!manualScrollGestureRef.current) return;
    momentumScrollActiveRef.current = true;
    userScrollActiveRef.current = true;
    reportScrollDebug('momentum-begin');
    if (olderLoadDisarmTimer.current) {
      clearTimeout(olderLoadDisarmTimer.current);
      olderLoadDisarmTimer.current = null;
    }
    if (followSettleTimer.current) {
      clearTimeout(followSettleTimer.current);
      followSettleTimer.current = null;
    }
    revealNav();
  }, [reportScrollDebug, revealNav]);
  const onListScrollSettled = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!isPlausibleScrollEvent(e)) {
        scheduleUserScrollSettle(260, true);
        return;
      }
      const y = e.nativeEvent.contentOffset.y;
      const viewportHeight = e.nativeEvent.layoutMeasurement.height;
      const contentHeight = e.nativeEvent.contentSize.height;
      lastScrollYRef.current = y;
      lastViewportHeightRef.current = viewportHeight;
      lastContentHeightRef.current = contentHeight;
      const acceptLatestState = shouldAcceptNativeLatestState(restoringDebugRef.current);
      const nextAtBottom = acceptLatestState ? isScrollEventAtBottom(e) : atBottomRef.current;
      if (acceptLatestState) {
        atBottomRef.current = nextAtBottom;
        setAtBottom(nextAtBottom);
      }
      reportScrollDebug('scroll-settled-event', {
        atBottom: nextAtBottom,
        acceptLatestState,
        y,
        historyEdgeDistance: historyEdgeDistance(y, contentHeight, viewportHeight),
      });
      scheduleUserScrollSettle(260, true);
    },
    [isPlausibleScrollEvent, isScrollEventAtBottom, reportScrollDebug, scheduleUserScrollSettle],
  );
  const onListScrollEndDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      onListScrollSettled(e);
      fingerDragActiveRef.current = false;
    },
    [onListScrollSettled],
  );
  const onListMomentumScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      // A user can interrupt a fling with a new drag. Ignore the old fling's delayed
      // terminal callback so it cannot settle the new gesture while the finger is down.
      if (fingerDragActiveRef.current) return;
      onListScrollSettled(e);
      momentumScrollActiveRef.current = false;
    },
    [onListScrollSettled],
  );
  // Request one older page. In the inverted list this is a pure APPEND at the data end
  // — behind the viewport — so there is nothing to capture beforehand and nothing to
  // correct afterwards. The only bookkeeping left is the settle window that keeps a
  // single flick from queueing page after page.
  const requestOlderHistory = useCallback(
    (allowStalledRetry = false) => {
      if (
        !shouldRequestOlderHistory(
          hasOlder,
          loadingOlder,
          olderLoadStalled,
          allowStalledRetry,
          historyAppendSettlingRef.current,
        )
      ) {
        reportScrollDebug('start-reached-blocked', {
          blockedBy: !hasOlder
            ? 'no-older-history'
            : historyAppendSettlingRef.current && !loadingOlder
              ? 'append-settling'
              : 'loading-older',
        });
        return;
      }
      historyAppendSettlingRef.current = true;
      if (historyAppendSettleTimer.current) clearTimeout(historyAppendSettleTimer.current);
      // Dead-man switch: if the request never reaches a `loadingOlder` cycle (rejected
      // upstream, offline), the window must still expire or paging would stay armed
      // shut for the rest of the session. Deliberately without the settled path's
      // retry — that is an error path, so the next scroll or viewability change
      // re-arms it rather than a silent background loop.
      historyAppendSettleTimer.current = setTimeout(() => {
        historyAppendSettleTimer.current = null;
        historyAppendSettlingRef.current = false;
      }, HISTORY_APPEND_SETTLE_FALLBACK_MS);
      // Reaching history is an away-from-latest action — but only if the viewport
      // actually left the newest edge. An underfilled transcript pages automatically
      // while still sitting at offset 0, and marking that as "reading history" would
      // switch off the streaming-follow fallback for someone who never scrolled.
      if (!atBottomRef.current) readingAwayFromBottomRef.current = true;
      reportScrollDebug('load-older-start', {
        allowStalledRetry,
        oldestVisibleIndex: oldestVisibleIndexRef.current,
        y: lastScrollYRef.current,
      });
      void loadOlder();
    },
    [hasOlder, loadingOlder, loadOlder, olderLoadStalled, reportScrollDebug],
  );
  loadOlderNearStartRef.current = requestOlderHistory;
  // Hold the settle window until the appended rows have been committed AND measured.
  // Nothing visible depends on it — it exists purely to space automatic follow-ups.
  useEffect(() => {
    if (loadingOlder) {
      historyAppendSettlingRef.current = true;
      // The request reached a real load cycle, so the dead-man fallback has done its
      // job. Disarm it: a request slower than HISTORY_APPEND_SETTLE_FALLBACK_MS would
      // otherwise clear the flag mid-flight, and completion would then find it already
      // false and skip the measurement window entirely.
      if (historyAppendSettleTimer.current) {
        clearTimeout(historyAppendSettleTimer.current);
        historyAppendSettleTimer.current = null;
      }
      return;
    }
    if (!historyAppendSettlingRef.current) return;
    if (historyAppendSettleTimer.current) clearTimeout(historyAppendSettleTimer.current);
    historyAppendSettleTimer.current = setTimeout(() => {
      historyAppendSettleTimer.current = null;
      historyAppendSettlingRef.current = false;
      const oldestRowViewable = isOldestRowViewable(
        oldestVisibleIndexRef.current,
        dataRef.current.length,
      );
      reportScrollDebug('history-append-settled', {
        rows: dataRef.current.length,
        y: lastScrollYRef.current,
        oldestRowViewable,
      });
      // Clearing a ref renders nothing, so no effect or callback re-evaluates paging
      // on its own. Re-check here or the two cases that add no reachable rows stall
      // after a single page: a metadata-only scan, and an initial viewport still too
      // short to scroll. Viewability (not the cached content height, which may still
      // describe the pre-append list) decides, so this cannot run away: once the page
      // put real rows behind the viewport, the last row is no longer viewable.
      // Never during an active gesture — the settle-idle handler re-checks the same
      // condition once the finger is up.
      if (oldestRowViewable && !userScrollActiveRef.current) loadOlderNearStartRef.current();
    }, HISTORY_APPEND_SETTLE_MS);
  }, [loadingOlder, olderLoadGeneration, reportScrollDebug]);
  const observedOlderLoadGenerationRef = useRef(olderLoadGeneration);
  useEffect(() => {
    const completed = observedOlderLoadGenerationRef.current !== olderLoadGeneration;
    observedOlderLoadGenerationRef.current = olderLoadGeneration;
    if (
      !shouldContinueOlderHistory(
        completed,
        hasOlder,
        olderLoadStalled,
        olderLoadNeedsContinuation,
        isHistoryEdgeVisible(
          lastScrollYRef.current,
          lastContentHeightRef.current,
          lastViewportHeightRef.current,
          oldestVisibleIndexRef.current,
          dataRef.current.length,
        ),
        userScrollActiveRef.current,
        historyAppendSettlingRef.current,
      )
    )
      return;

    // A bounded scan may advance across metadata-only pages without changing any
    // visible rows. Continue after React has committed the new cursor while the
    // history edge remains visible. Failures/non-progress are deliberately excluded
    // above, so this cannot become an automatic retry loop.
    const raf = requestAnimationFrame(() => loadOlderNearStartRef.current());
    return () => cancelAnimationFrame(raf);
  }, [hasOlder, olderLoadGeneration, olderLoadNeedsContinuation, olderLoadStalled]);
  useEffect(() => {
    reportScrollDebug('loading-older-state', { loadingOlder });
  }, [loadingOlder, reportScrollDebug]);
  // ──────────────────────────────────────────────────────────────────────────────
  // Bookmarks (#bookmarks): per-session "dog-ears" on agent messages. Toggled from the
  // tap-revealed action row under a message (next to Copy); recalled from the header
  // sheet, which jumps back to the message.
  const bookmarks = useBookmarks(sessionId);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesInitialPath, setFilesInitialPath] = useState<string | null>(null);
  const openSessionFile = useCallback((path: string) => {
    setFilesInitialPath(path);
    setFilesOpen(true);
  }, []);
  // Index of a bookmarked message id in the current rows, or -1 if not loaded yet.
  const rowIndexOfMessage = useCallback(
    (messageId: string) =>
      findAnchorIndex(
        data,
        { rowKey: null, messageId, atBottom: false, offsetY: null },
        'newest-first',
      ),
    [data],
  );
  // Pull older history straight toward a bookmark target: one fetch sized to the span
  // down to the message's seq (from its id), not 150-at-a-time. Falls back to a normal
  // page for an unexpected id shape.
  const pageTowardMessage = useCallback(
    (messageId: string) => {
      const seq = messageSeq(messageId);
      if (seq !== null) loadOlderUntil(seq);
      else loadOlder();
    },
    [loadOlderUntil, loadOlder],
  );
  // When a jump target isn't in the loaded window yet, page older history toward it
  // until it appears — driven entirely by the effect below (ONE control path, so the
  // async prepends settle across re-renders and the initial call can't race the retry).
  // `jumpRowsRef` records the row count at the last page request: if a load settles
  // without adding rows we've made no progress — a flaky fetch, an empty page, or a
  // target whose id re-keyed away across a coalescing boundary (older text deltas
  // merging onto an earlier seq when a page prepends) — so we stop instead of
  // refetching in a tight, unthrottled loop.
  const [pendingJumpId, setPendingJumpId] = useState<string | null>(null);
  const pendingJumpQueryRef = useRef<string | null>(null);
  const highlightMessage = useCallback((messageId: string, searchQuery: string | null = null) => {
    setHighlightedMessageId(messageId);
    setHighlightedSearchQuery(searchQuery);
  }, []);
  const jumpRowsRef = useRef(-1);
  const jumpToBookmark = useCallback(
    (messageId: string, searchQuery: string | null = null): boolean => {
      const index = rowIndexOfMessage(messageId);
      if (index >= 0) {
        cancelPendingUserScrollSettle();
        readingAwayFromBottomRef.current = true;
        // Inverted list: viewPosition 1 parks the message at the visual top, like the
        // user-row jump, so the conversation reads downward from it.
        scrollDebugLastProgrammaticAtRef.current = Date.now();
        listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 1 });
        highlightMessage(messageId, searchQuery);
        syncTailFreeze();
        return true;
      }
      // Not in the rendered rows. It may simply be one of the rows the live-tail freeze
      // is holding back (a bookmark on a message written while the operator read
      // history), so re-snapshot — that takes in everything streamed since — and let
      // the pending-jump effect re-find it on the next commit. If it really is older,
      // that effect falls through to paging exactly as it would have.
      if (frozenTailRef.current !== null) {
        snapshotLiveTail();
        jumpRowsRef.current = -1;
        pendingJumpQueryRef.current = searchQuery;
        setPendingJumpId(messageId);
        return true;
      }
      // Not loaded — let the effect page toward it. Nothing older → the message is gone.
      if (hasOlder) {
        jumpRowsRef.current = -1; // fresh jump: no page requested yet
        pendingJumpQueryRef.current = searchQuery;
        setPendingJumpId(messageId);
        return true;
      }
      return false;
    },
    [
      cancelPendingUserScrollSettle,
      rowIndexOfMessage,
      hasOlder,
      highlightMessage,
      snapshotLiveTail,
      syncTailFreeze,
    ],
  );
  const handledSearchTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialTargetMessageId) {
      handledSearchTargetRef.current = null;
      return;
    }
    const targetKey = initialTargetMessageId
      ? `${initialTargetMessageId}\n${initialTargetSearchQuery ?? ''}`
      : null;
    if (initialTargetMessageId && handledSearchTargetRef.current !== targetKey) {
      // The first render can precede both backlog data and `hasOlder`. Mark the
      // route target handled only once it was found or an older-page jump was queued;
      // otherwise this effect retries as the transcript state arrives.
      if (jumpToBookmark(initialTargetMessageId, initialTargetSearchQuery ?? null)) {
        handledSearchTargetRef.current = targetKey;
        // Consume the navigation intent. Clearing it lets the same result be tapped
        // again later after the highlight was dismissed, while the pending jump keeps
        // its own id/query state if older history still has to load.
        router.setParams({ targetMessageId: undefined, targetSearchQuery: undefined });
      }
    }
  }, [initialTargetMessageId, initialTargetSearchQuery, jumpToBookmark]);
  useEffect(() => {
    if (pendingJumpId === null) return;
    const index = rowIndexOfMessage(pendingJumpId);
    if (index >= 0) {
      setPendingJumpId(null);
      // Defer to the next frame so the prepend has committed, then RE-FIND the row: its
      // index can shift (or the message vanish) between this commit and the frame.
      const id = pendingJumpId;
      requestAnimationFrame(() => {
        const at = rowIndexOfMessage(id);
        if (at >= 0) {
          cancelPendingUserScrollSettle();
          readingAwayFromBottomRef.current = true;
          scrollDebugLastProgrammaticAtRef.current = Date.now();
          // viewPosition 1 — visual top, as above.
          listRef.current?.scrollToIndex({ index: at, animated: true, viewPosition: 1 });
          highlightMessage(id, pendingJumpQueryRef.current);
          pendingJumpQueryRef.current = null;
          // Outside React's batching (a frame later), so freeze from here rather than
          // relying on a render that may not come.
          syncTailFreeze();
        }
      });
      return;
    }
    if (loadingOlder) return; // a page is in flight — wait for it to settle
    // Give up (don't spin) when there's nothing older left, or the last page added no
    // rows (no progress toward the target).
    if (!hasOlder || data.length === jumpRowsRef.current) {
      setPendingJumpId(null);
      pendingJumpQueryRef.current = null;
      return;
    }
    jumpRowsRef.current = data.length;
    pageTowardMessage(pendingJumpId);
  }, [
    cancelPendingUserScrollSettle,
    pendingJumpId,
    data,
    rowIndexOfMessage,
    hasOlder,
    loadingOlder,
    pageTowardMessage,
    highlightMessage,
    syncTailFreeze,
  ]);
  // Pending image uploads for the NEXT turn (picked but not yet sent, raw base64).
  // Cleared on send. Kept in screen state (not the draft cache) — transient.
  const [attachments, setAttachments] = useState<AttachmentUpload[]>([]);
  // A dead session (worktree gone) can't take turns — disable sending proactively
  // (`resumable === false`); `undefined` (detail still loading) stays enabled.
  const dead = resumable === false;
  // Sendable with text OR at least one attachment (a bare screenshot is valid).
  const canSend =
    (draft.trim().length > 0 || attachments.length > 0) &&
    attachments.length <= MAX_ATTACHMENTS_PER_TURN &&
    !sending &&
    !dead;
  // Show a one-time rate-limit banner only when the 5h window is exhausted
  // (status !== 'allowed'); the common 'allowed' case shows nothing.
  const rateNotice = rateLimitNotice(session.rateLimit);

  // Bumped on every send so the input's TextInput remounts fresh (one line). A
  // native multiline field doesn't shrink back when its value is cleared
  // programmatically on iOS/Fabric, so without this it stays grown after sending.
  // Keyed only on SEND (not on any empty draft) so manually clearing the field
  // while typing doesn't remount and drop focus.
  const [sendNonce, setSendNonce] = useState(0);
  const composerFocusedRef = useRef(false);
  const keyboardShownRef = useRef(false);
  const preserveFocusAfterSendRef = useRef(false);
  const isIpadFocusTarget = Platform.OS === 'ios' && Platform.isPad;
  const onComposerFocus = useCallback(() => {
    composerFocusedRef.current = true;
  }, []);
  const onComposerBlur = useCallback(() => {
    composerFocusedRef.current = false;
  }, []);
  const scrollToLatest = useCallback(
    (animated: boolean) => {
      restoreInterruptedRef.current = true;
      cancelRestoreTimers();
      positioningRef.current = false;
      setRestoreTarget(null);
      setRestoring(false);
      readingAwayFromBottomRef.current = false;
      cancelPendingUserScrollSettle();
      // Drop the live-tail freeze here rather than waiting for the arrival to report
      // the edge: the operator asked for the newest content, so it has to be rendered
      // by the time we get there. Offset zero is the newest edge either way.
      setFrozenTail(null);
      // Inverted list: the newest edge is offset zero, not a measured content end.
      listRef.current?.scrollToOffset({ offset: 0, animated });
      repinToLatestEdge(animated);
    },
    [cancelPendingUserScrollSettle, cancelRestoreTimers, repinToLatestEdge],
  );
  const onMergePullRequest = useCallback<UseBranches['mergePullRequest']>(
    (number) => {
      // Merging dispatches a server-authored transcript turn for both success and
      // rejection. Treat the button press like sending a prompt: return to the live
      // edge now and keep following until that notification arrives.
      scrollToLatest(true);
      return branches.mergePullRequest(number);
    },
    [branches.mergePullRequest, scrollToLatest],
  );
  const onMergeLocally = useCallback<UseBranches['mergeLocally']>(() => {
    // Same reasoning as the pull-request merge above: the server dispatches a turn
    // describing the post-merge state, so follow the live edge to see it arrive.
    scrollToLatest(true);
    return branches.mergeLocally();
  }, [branches.mergeLocally, scrollToLatest]);
  const voiceAbort = voice.abort;
  const onSend = useCallback(() => {
    const prompt = draft.trim();
    // Enforce the cap here as well as through `canSend`: hardware Enter invokes
    // this callback directly and can bypass the disabled send button. Restored
    // queue backlogs may exceed the cap and must remain intact until trimmed.
    if (
      (prompt.length === 0 && attachments.length === 0) ||
      attachments.length > MAX_ATTACHMENTS_PER_TURN ||
      sending
    )
      return;
    // End any live dictation FIRST (#133): otherwise the voice hook's next (partial/
    // final) result writes the transcript back into the field right after we clear
    // it, and recording stays on. `abort()` swallows the trailing result; no-op idle.
    voiceAbort();
    sendTurn(prompt, attachments.length > 0 ? { attachments } : {});
    // Sending is an explicit return to the live conversation: reveal the new operator
    // message even when they had scrolled up to read older transcript content, and keep
    // following while the matching prompt event and agent response arrive.
    scrollToLatest(true);
    setDraft('');
    setAttachments([]);
    setSendNonce((n) => n + 1);
    // Sending a steering prompt is a "send then watch the agent work" action, so on a
    // touch keyboard close it to reveal the transcript (the operator expected this).
    // With a hardware keyboard there's nothing covering the transcript, and the
    // operator wants to keep typing — so leave focus in place (a sendNonce effect
    // re-focuses the remounted field, #98) instead of dismissing. Treat "unknown" as
    // preserve on iPad because hardware keyboards may not emit a keyboard-show event
    // for us to learn from before the first send. Also preserve one manually focused
    // send when no software keyboard is visible; this covers the case where detection
    // previously fell back to `software`, but the operator has since focused the
    // composer with a hardware keyboard attached.
    const preserveFocus =
      isIpadFocusTarget &&
      (shouldPreserveComposerFocus() || (composerFocusedRef.current && !keyboardShownRef.current));
    preserveFocusAfterSendRef.current = preserveFocus;
    if (!preserveFocus) Keyboard.dismiss();
  }, [
    draft,
    attachments,
    sending,
    sendTurn,
    scrollToLatest,
    setDraft,
    voiceAbort,
    isIpadFocusTarget,
  ]);
  // Merge handling is server-side: the server performs deterministic worktree
  // cleanup, then dispatches the agent-facing post-merge turn while keeping the
  // visible transcript prompt compact.

  // Cap on attachments per turn — mirrors the server's MAX_ATTACHMENTS so the UI
  // never lets the operator build a turn the server will 400.
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  // Screen position of the composer's paperclip, so the attach menu docks to it.
  const [attachAnchor, setAttachAnchor] = useState<AttachAnchor | null>(null);
  // Merge a picker's result into `attachments`, capping at MAX_ATTACHMENTS. The
  // picker fns throw a user-facing message on failure — a silent no-op would look
  // like a dead button.
  const performPick = useCallback(
    (pick: (remaining: number) => Promise<AttachmentUpload[]>) => {
      void (async () => {
        const remaining = MAX_ATTACHMENTS_PER_TURN - attachments.length;
        if (remaining <= 0) return;
        try {
          const picked = await pick(remaining);
          if (picked.length === 0) return;
          setAttachments((cur) => [...cur, ...picked].slice(0, MAX_ATTACHMENTS_PER_TURN));
        } catch (error) {
          Alert.alert('Could not attach', error instanceof Error ? error.message : String(error));
        }
      })();
    },
    [attachments.length],
  );
  // iOS can't present the native picker while the attach menu is still animating
  // away, so on iOS we stash the chosen picker and fire it from the menu's
  // `onDismiss`. Android has no such collision — run it straight away.
  const pendingPickRef = useRef<((remaining: number) => Promise<AttachmentUpload[]>) | null>(null);
  const pendingMeetingAudioRef = useRef(false);
  const uploadMeetingAudioRef = useRef<() => void>(() => undefined);
  const choosePick = useCallback(
    (pick: (remaining: number) => Promise<AttachmentUpload[]>) => {
      setAttachMenuOpen(false);
      if (Platform.OS === 'ios') pendingPickRef.current = pick;
      else performPick(pick);
    },
    [performPick],
  );
  const uploadMeetingAudio = useCallback(() => {
    void (async () => {
      let localId: string | undefined;
      let pickedUri: string | undefined;
      let clearLocalImmediately = false;
      let scheduleLocalFallbackClear = false;
      try {
        const settings = await client.getMeetingTranscriptionBackendStatus();
        const readiness = meetingTranscriptionReadiness(settings);
        if (readiness.state === 'choose') {
          const choose = (mode: 'local' | 'external') => {
            void client
              .updateMeetingTranscriptionBackendMode(mode)
              .then(() => {
                if (mode === 'external' && !readiness.externalConfigured) {
                  router.push('/settings');
                } else {
                  uploadMeetingAudioRef.current();
                }
              })
              .catch((error) =>
                Alert.alert(
                  'Could not save transcription backend',
                  error instanceof Error ? error.message : String(error),
                ),
              );
          };
          Alert.alert(
            'Choose transcription backend',
            'Where should Verity process meeting audio? You can change this later in Settings.',
            [
              { text: 'Cancel', style: 'cancel' },
              ...(readiness.localAvailable
                ? [{ text: 'Use locally', onPress: () => choose('local' as const) }]
                : []),
              { text: 'Use external service', onPress: () => choose('external') },
            ],
          );
          return;
        }
        if (readiness.state === 'local-unavailable') {
          Alert.alert(
            'Local transcription unavailable',
            'This Verity deployment has no local transcription service. Choose an external service in Settings.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open settings', onPress: () => router.push('/settings') },
            ],
          );
          return;
        }
        if (readiness.state === 'external-incomplete') {
          Alert.alert(
            'Finish transcription setup',
            'Add the API URL and model before uploading meeting audio. Add a token if your service requires one.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open settings', onPress: () => router.push('/settings') },
            ],
          );
          return;
        }
        const picked = await pickMeetingAudioAsset();
        if (!picked) return;
        pickedUri = picked.uri;
        const activityId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        localId = activityId;
        setLocalMeetingUploads((current) => [
          ...current,
          {
            id: activityId,
            fileName: picked.fileName,
            startedAt: Date.now(),
            phase: 'reading',
          },
        ]);
        const upload = await readMeetingAudioUpload(picked);
        setLocalMeetingUploads((current) =>
          current.map((activity) =>
            activity.id === activityId ? { ...activity, phase: 'uploading' } : activity,
          ),
        );
        await client.uploadMeetingAudio(sessionId, { ...upload, clientRequestId: activityId });
        scheduleLocalFallbackClear = true;
      } catch (error) {
        if (error instanceof VerityApiError) {
          // Streamed uploads emit the canonical request notice only after the
          // server accepts the bytes. A non-2xx response therefore has nothing
          // that can confirm this optimistic bubble; remove it immediately.
          clearLocalImmediately = true;
          if (shouldAlertMeetingUploadApiError(error)) {
            Alert.alert('Could not upload meeting audio', error.message);
          }
        } else {
          clearLocalImmediately = true;
          Alert.alert(
            'Could not upload meeting audio',
            error instanceof Error ? error.message : String(error),
          );
        }
      } finally {
        if (pickedUri) {
          try {
            new FsFile(pickedUri).delete();
          } catch {
            // Best effort; the OS may already have reaped the picker copy.
          }
        }
        if (localId) {
          const clearLocal = () => {
            setLocalMeetingUploads((current) =>
              current.filter((activity) => activity.id !== localId),
            );
          };
          if (clearLocalImmediately) clearLocal();
          else if (scheduleLocalFallbackClear) setTimeout(clearLocal, 10_000);
        }
      }
    })();
  }, [client, sessionId]);
  uploadMeetingAudioRef.current = uploadMeetingAudio;
  useEffect(() => {
    if (!MEETING_AUDIO_ENABLED) return;
    const pending = claimPendingMeetingUpload(sessionId);
    if (!pending) return;
    void (async () => {
      let transcriptUploaded = pending.transcriptUploaded === true;
      const resumePending = async () => {
        try {
          if (!transcriptUploaded) {
            await client.uploadMeetingAudio(sessionId, {
              ...pending.upload,
              announceRequest: false,
            });
            transcriptUploaded = true;
          }
          if (pending.followUpPrompt?.trim()) {
            const followUpPrompt = pending.followUpPrompt.trim();
            try {
              await waitForSessionIdle(client, sessionId);
            } catch (error) {
              restorePendingMeetingUpload(sessionId, { ...pending, transcriptUploaded: true });
              throw error;
            }
            try {
              await client.sendTurn(sessionId, { prompt: followUpPrompt });
            } catch (error) {
              setDraft((current) =>
                current.trim().length > 0
                  ? `${current.trimEnd()}\n\n${followUpPrompt}`
                  : followUpPrompt,
              );
              throw error;
            }
          }
        } catch (error) {
          const retryableUploadFailure =
            !transcriptUploaded &&
            (!(error instanceof VerityApiError) || error.status === 429 || error.status >= 500);
          if (retryableUploadFailure) {
            restorePendingMeetingUpload(sessionId, { ...pending, transcriptUploaded });
          }
          if (error instanceof VerityApiError && !transcriptUploaded) {
            if (retryableUploadFailure) {
              Alert.alert('Could not upload meeting audio', error.message);
              return;
            }
            if (pending.followUpPrompt?.trim()) {
              const followUpPrompt = pending.followUpPrompt.trim();
              setDraft((current) =>
                current.trim().length > 0
                  ? `${current.trimEnd()}\n\n${followUpPrompt}`
                  : followUpPrompt,
              );
            }
            return;
          }
          Alert.alert(
            transcriptUploaded ? 'Could not send meeting prompt' : 'Could not upload meeting audio',
            error instanceof Error ? error.message : String(error),
          );
        }
      };

      if (transcriptUploaded) {
        await resumePending();
        return;
      }
      let status: Awaited<ReturnType<typeof client.getMeetingTranscriptionBackendStatus>>;
      try {
        status = await client.getMeetingTranscriptionBackendStatus();
      } catch (error) {
        restorePendingMeetingUpload(sessionId, { ...pending, transcriptUploaded: false });
        Alert.alert(
          'Could not check transcription backend',
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      const readiness = meetingTranscriptionReadiness(status);
      if (readiness.state === 'ready') {
        await resumePending();
        return;
      }
      const defer = () =>
        restorePendingMeetingUpload(sessionId, { ...pending, transcriptUploaded: false });
      if (readiness.state === 'choose') {
        const choose = (mode: 'local' | 'external') => {
          void client
            .updateMeetingTranscriptionBackendMode(mode)
            .then(async () => {
              if (
                pendingUploadActionAfterBackendChoice(mode, readiness.externalConfigured) ===
                'configure-external'
              ) {
                defer();
                router.push('/settings');
                return;
              }
              await resumePending();
            })
            .catch((error) => {
              defer();
              Alert.alert(
                'Could not save transcription backend',
                error instanceof Error ? error.message : String(error),
              );
            });
        };
        Alert.alert(
          'Choose transcription backend',
          'A pending meeting recording is waiting. Where should Verity process it?',
          [
            { text: 'Not now', style: 'cancel', onPress: defer },
            ...(readiness.localAvailable
              ? [{ text: 'Use locally', onPress: () => choose('local' as const) }]
              : []),
            { text: 'Use external service', onPress: () => choose('external') },
          ],
        );
      } else {
        defer();
        Alert.alert(
          readiness.state === 'local-unavailable'
            ? 'Local transcription unavailable'
            : 'Finish transcription setup',
          readiness.state === 'local-unavailable'
            ? 'This deployment has no local transcription service. Choose another backend in Settings.'
            : 'Add the external API URL and model before the pending recording can be uploaded.',
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'Open settings', onPress: () => router.push('/settings') },
          ],
        );
      }
    })();
  }, [client, sessionId]);
  const runPendingPick = useCallback(() => {
    const pick = pendingPickRef.current;
    pendingPickRef.current = null;
    if (pick) performPick(pick);
    if (pendingMeetingAudioRef.current) {
      pendingMeetingAudioRef.current = false;
      uploadMeetingAudio();
    }
  }, [performPick, uploadMeetingAudio]);
  const onCapturePhoto = useCallback(() => choosePick(() => captureImage()), [choosePick]);
  const onPickPhotos = useCallback(() => choosePick((r) => pickImagesFromLibrary(r)), [choosePick]);
  const onPickFiles = useCallback(() => choosePick((r) => pickFiles(r)), [choosePick]);
  const onDropFiles = useCallback(
    (files: Parameters<typeof readDroppedAttachments>[0]) => {
      void (async () => {
        // Unlike an interactive picker, native drop loading may finish after
        // another attachment source has filled the remaining slots. Always run
        // the reader so its `finally` removes every native temporary copy.
        const remaining = Math.max(0, MAX_ATTACHMENTS_PER_TURN - attachments.length);
        try {
          const dropped = await readDroppedAttachments(files, remaining);
          if (dropped.length === 0) return;
          setAttachments((current) => [...current, ...dropped].slice(0, MAX_ATTACHMENTS_PER_TURN));
        } catch (error) {
          Alert.alert('Could not attach', error instanceof Error ? error.message : String(error));
        }
      })();
    },
    [attachments.length],
  );
  const onDropRejected = useCallback((errors: string[]) => {
    if (errors.length > 0) Alert.alert('Could not attach', errors.join('\n'));
  }, []);
  const onPickMeetingAudio = useCallback(() => {
    setAttachMenuOpen(false);
    if (Platform.OS === 'ios') pendingMeetingAudioRef.current = true;
    else uploadMeetingAudio();
  }, [uploadMeetingAudio]);
  const onPickGoogleDrive = useCallback(() => {
    setAttachMenuOpen(false);
    // A route navigation (not a native picker), so it can run immediately without
    // the iOS modal-dismiss deferral the meeting-audio path needs.
    router.push({ pathname: '/google-drive/[sessionId]', params: { sessionId } });
  }, [sessionId]);
  const onAttach = useCallback((anchor: AttachAnchor) => {
    setAttachAnchor(anchor);
    setAttachMenuOpen(true);
  }, []);

  const onRemoveAttachment = useCallback((index: number) => {
    setAttachments((cur) => cur.filter((_, i) => i !== index));
  }, []);

  // Quick-Action chips (issue #97): rows reach these through context so a tapped
  // option dispatches a turn, and the "Custom answer" chip focuses the input.
  const inputRef = useRef<TextInput>(null);
  const focusInput = useCallback(() => inputRef.current?.focus(), []);
  // Focus the composer resiliently. On iOS a lone focus() is silently dropped when it
  // lands mid screen-transition, or before the key={sendNonce}-remounted field has
  // reattached — which is what made the iPad autofocus flaky once the keyboard began
  // persisting across sessions (#98): the single focus() attempt kept losing the race.
  // Retry over a short window (re-focusing an already-focused field is a no-op) so the
  // cursor reliably lands. Returns a canceller for effect cleanup.
  const focusComposer = useCallback(() => {
    let raf: number | undefined;
    let tries = 0;
    const tick = () => {
      const el = inputRef.current;
      if (el && !el.isFocused()) el.focus();
      tries += 1;
      // Stop once focused, or after ~8 frames (well past a remount / a settled transition).
      if (tries < 8 && !inputRef.current?.isFocused()) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      if (raf !== undefined) cancelAnimationFrame(raf);
    };
  }, []);
  // Tap a "waiting to send" bubble (#80): retract that queued turn and drop its text
  // back into the input so the operator can edit it and resend (or clear it). Only
  // restores the input when the server confirms the retract (returns the prompt). The
  // retracted turn is GONE from the queue by then, so its text would be lost if not
  // surfaced — when a draft is already in progress, prepend the retracted text (with a
  // blank line) rather than clobbering what the operator typed.
  const onRetractWaiting = useCallback(
    (id: string) => {
      void cancelWaiting(id).then((restored) => {
        if (restored === undefined) return;
        setDraft(draft.trim().length > 0 ? `${restored.prompt}\n\n${draft}` : restored.prompt);
        if (restored.attachments) {
          setAttachments((current) => [...restored.attachments!, ...current]);
        }
        focusInput();
      });
    },
    [cancelWaiting, setDraft, focusInput, draft],
  );
  const onDismissPendingEcho = useCallback(
    (id: string) => {
      const text = dismissPending(id);
      if (text === undefined) return;
      setDraft(draft.trim().length > 0 ? `${text}\n\n${draft}` : text);
      focusInput();
    },
    [dismissPending, setDraft, focusInput, draft],
  );
  // Every stop drops the pending backlog server-side, so whoever asked for it owes
  // the operator their typed text back. Shared by Stop and by the force-release
  // below — that one clears the same backlog, and losing it there would be worse,
  // since a fenced session is exactly where prompts pile up.
  const restoreStoppedTurns = useCallback(
    (turns: RestoredQueuedTurn[]) => {
      if (turns.length === 0) return;
      const restored = turns.map((turn) => turn.prompt).join('\n\n');
      setDraft((current) => (current.trim().length > 0 ? `${restored}\n\n${current}` : restored));
      const restoredAttachments = turns.flatMap((turn) => turn.attachments ?? []);
      if (restoredAttachments.length > 0) {
        // Preserve every stopped turn's attachments. If the combined backlog exceeds
        // the per-turn upload limit, Send stays disabled until enough previews are
        // removed; silently slicing here would make already-dequeued files unrecoverable.
        setAttachments((current) => [...restoredAttachments, ...current]);
      }
      focusInput();
    },
    [setDraft, setAttachments, focusInput],
  );
  const onStop = useCallback(() => {
    void cancel().then(restoreStoppedTurns);
  }, [cancel, restoreStoppedTurns]);
  // The way out of a session the server cannot free by itself. It is not a stronger
  // Stop — Stop already ran and did everything it safely could; this gives up the
  // guarantee behind the reservation, so the dialog says what is actually being
  // traded rather than asking "are you sure?".
  const onForceRelease = useCallback(() => {
    Alert.alert(
      'Release the session?',
      'Verity could not confirm that the previous agent process exited. Releasing lets the ' +
        'next one start anyway — if the old one is still alive, both will edit this worktree. ' +
        'Check the branch before trusting the next turn.',
      [
        { text: 'Keep waiting', style: 'cancel' },
        {
          text: 'Release anyway',
          style: 'destructive',
          onPress: () => {
            void cancel({ force: true }).then(restoreStoppedTurns);
          },
        },
      ],
    );
  }, [cancel, restoreStoppedTurns]);
  const sendQuickReply = useCallback(
    (prompt: string) => {
      sendTurn(prompt);
      // A choice chip sends a real operator turn without going through the composer.
      // Return to the live edge just like a normal send so that turn stays visible.
      scrollToLatest(true);
    },
    [scrollToLatest, sendTurn],
  );
  const actions = useMemo<SessionActions>(
    () => ({
      sendTurn: sendQuickReply,
      sending,
      dead,
      focusInput,
      recoverPending: onDismissPendingEcho,
      confirmAgentLoop,
      enableAgentLoop,
      agentLoopStatus: agentLoop?.status ?? null,
      agentLoopTested: agentLoop?.testedScriptFingerprint !== null && agentLoop !== null,
      agentLoopId: agentLoop?.id ?? null,
      agentLoopConfigFingerprint: agentLoop ? agentLoopConfigFingerprint(agentLoop) : null,
    }),
    [
      sendQuickReply,
      sending,
      dead,
      focusInput,
      onDismissPendingEcho,
      confirmAgentLoop,
      enableAgentLoop,
      agentLoop?.status,
      agentLoop?.testedScriptFingerprint,
      agentLoop?.id,
      agentLoop?.name,
      agentLoop?.script,
      agentLoop?.schedule,
      agentLoop?.reactionPrompt,
      agentLoop?.reactionModel,
    ],
  );
  // Local upload placeholders may sit after the transcript tail, but quick-action
  // chips should stay keyed to the latest
  // REAL transcript row so an upload does not temporarily disable active choices.
  const highlightedRowIndex = useMemo(
    () =>
      highlightedMessageId === null
        ? -1
        : findAnchorIndex(
            data,
            { rowKey: null, messageId: highlightedMessageId, atBottom: false, offsetY: null },
            'newest-first',
          ),
    [data, highlightedMessageId],
  );
  const renderItem = useCallback(
    ({ item, index }: { item: Row; index: number }) => {
      const isSearchTarget = index === highlightedRowIndex;
      const key = rowKey(item);
      const isLatestTranscriptRow =
        latestTranscriptRowKey !== null && key === latestTranscriptRowKey;
      const rendered = renderRow(item, isLatestTranscriptRow);
      // Counter-flip each row so the inverted list reads the right way up.
      return rendered ? (
        <View style={styles.invertedItem}>
          <SearchHighlightContext.Provider value={isSearchTarget ? highlightedSearchQuery : null}>
            {rendered}
          </SearchHighlightContext.Provider>
        </View>
      ) : null;
    },
    [highlightedRowIndex, highlightedSearchQuery, latestTranscriptRowKey],
  );
  // Keep recycling pools shape-compatible. Agent prose gets bounded height buckets:
  // reusing a many-screen cell for a short progress update can leave the old native
  // height visible as a large blank block on iOS until FlashList measures it again.
  const getItemType = useCallback((row: Row): string => rowRecycleType(row), []);
  // One stable native configuration for the inverted list: streaming grows layout
  // index 0, which native maintainVisibleContentPosition absorbs for a reader parked
  // in history, and re-pins only when they were exactly on the newest edge.
  const maintainVisibleContentPosition = useMemo(() => {
    return transcriptPositionMaintenance();
  }, []);
  useEffect(() => {
    reportScrollDebug('transcript-mode', {
      mode: 'newest-first',
      loadingOlder,
      restoring,
    });
  }, [loadingOlder, reportScrollDebug, restoring]);
  // Belt-and-braces re-pin to the newest edge. Native mVCP already keeps offset zero
  // when the reader is there, so this is normally a no-op; it exists so a dropped
  // native adjustment cannot silently strand live follow. Reading history never
  // reaches it — onScrollBeginDrag flips readingAwayFromBottomRef synchronously.
  useEffect(() => {
    if (
      !shouldFollowStreamingContent(
        atBottomRef.current,
        readingAwayFromBottomRef.current,
        restoring,
      )
    )
      return;
    const raf = requestAnimationFrame(() =>
      listRef.current?.scrollToOffset({ offset: 0, animated: false }),
    );
    return () => cancelAnimationFrame(raf);
  }, [data, restoring]);
  // ── Live-tail freeze ──────────────────────────────────────────────────────────
  // Leaving the newest edge snapshots the transcript and renders the snapshot, so the
  // list holds absolutely still while the operator reads: the row that grows while the
  // agent writes is not part of what's rendered. FlashList's own
  // maintainVisibleContentPosition cannot achieve this — it anchors on the FIRST
  // VISIBLE row, which anywhere within one streamed message of the edge IS the growing
  // row 0, and row 0's layout origin is pinned at zero by construction. It therefore
  // measures no movement and corrects nothing while the content underneath scrolls
  // away, which is exactly the drift the operator sees (and why it stops only once
  // they have scrolled past the whole growing message). See
  // packages/mobile/src/ui/transcriptFreeze.ts.
  //
  // The freeze is the exact complement of live-follow, so it covers every way of
  // leaving the newest edge — a drag, a jump to a prompt, a bookmark, a restore into
  // saved history — and every way back. The callbacks for those run `syncTailFreeze`
  // themselves, the moment they leave; this pass is the net beneath them. It runs after
  // EVERY render rather than off a dependency list because the follow state lives in
  // refs written from scroll callbacks: a dependency list would need every one of those
  // writes to also publish state, and a single missed write would silently strand the
  // transcript frozen (or unfrozen). The decision is idempotent, so a steady state
  // re-renders without touching state.
  useEffect(() => {
    syncTailFreeze();
  });
  // Bars below the list (composer growth, queued turns, permission prompt, PR bar)
  // change the viewport height rather than the list content. Offset zero stays the
  // newest edge across that, so a reader pinned to latest keeps their position without
  // any scroll — and a reader in history keeps theirs too.

  // While the keyboard is open it already covers the home-indicator area, so the
  // input's safe-area bottom padding would otherwise show as a dead gap between the
  // field and the keyboard top. Track keyboard visibility and drop the inset while
  // it's up (keyboardWillShow/Hide on iOS for in-sync animation; the Did* events on
  // Android, where the Will* variants don't fire reliably).
  const [keyboardShown, setKeyboardShown] = useState(false);
  const probingAutofocusRef = useRef(false);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (event) => {
      keyboardShownRef.current = true;
      setKeyboardShown(true);
      if (
        Platform.OS === 'ios' &&
        Platform.isPad &&
        probingAutofocusRef.current &&
        !isExternalKeyboardHeight(event.endCoordinates?.height ?? 0) &&
        inputRef.current?.isFocused()
      ) {
        inputRef.current.blur();
        Keyboard.dismiss();
      }
      probingAutofocusRef.current = false;
    });
    const hide = Keyboard.addListener(hideEvt, () => {
      keyboardShownRef.current = false;
      setKeyboardShown(false);
      probingAutofocusRef.current = false;
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Composer autofocus on iPad with a hardware keyboard (#98): drop the operator
  // straight into the input (blinking cursor, ready to type) when a session opens, so
  // they don't have to tap the field first. "Unknown" gets one probe attempt because
  // iOS may never emit a keyboard-show event for an attached hardware keyboard; if that
  // probe opens a full software keyboard, the keyboard listener above dismisses it and
  // the global detector records `software` so future opens stay hands-off.
  useEffect(() => {
    if (Platform.OS !== 'ios' || !Platform.isPad || !shouldPreserveComposerFocus()) return;
    probingAutofocusRef.current = hardwareKeyboardDetection() === 'unknown';
    // Focus only after the navigation transition settles — focusing mid-transition is
    // unreliable on iOS. InteractionManager fires once the animation completes, and the
    // resilient retry then rides out any residual attach/layout timing. But a lingering
    // interaction handle — e.g. the keyboard staying up across a send + navigate (#98) —
    // can delay or drop that callback, which is what left a fresh session opening WITHOUT
    // the blinking cursor. A timeout is a hard fallback so focus is always attempted;
    // both paths funnel into the same idempotent retry, so a double-fire is harmless.
    let cancelFocus: (() => void) | undefined;
    const focus = () => {
      cancelFocus?.();
      cancelFocus = focusComposer();
    };
    const task = InteractionManager.runAfterInteractions(focus);
    const fallback = setTimeout(focus, 350);
    return () => {
      task.cancel();
      clearTimeout(fallback);
      probingAutofocusRef.current = false;
      cancelFocus?.();
    };
  }, [focusComposer]);

  // Keep the cursor in the composer after a send on iPad with a hardware keyboard
  // (#98). `key={sendNonce}` remounts the field on each send (to shrink it back to one
  // line), which drops focus; re-focus the fresh field so the operator can fire off the
  // next message without re-tapping. Gated on a detected keyboard, and skips the
  // initial mount (the session-open autofocus above owns that). On touch keyboards we
  // stay hands-off — onSend deliberately dismisses to reveal the transcript.
  const prevSendNonce = useRef(sendNonce);
  useEffect(() => {
    if (prevSendNonce.current === sendNonce) return;
    prevSendNonce.current = sendNonce;
    if (!isIpadFocusTarget) {
      preserveFocusAfterSendRef.current = false;
      return;
    }
    const preserveFocus = preserveFocusAfterSendRef.current || shouldPreserveComposerFocus();
    preserveFocusAfterSendRef.current = false;
    if (!preserveFocus) return;
    // Retry until the remounted TextInput reattaches — a single frame wasn't always
    // enough (the remount could commit a frame or two later), which dropped the focus.
    return focusComposer();
  }, [sendNonce, focusComposer, isIpadFocusTarget]);

  // Fully custom header: the native iOS-26 nav bar wraps every bar-button item
  // (incl. the back button) in a Liquid-Glass capsule, which made the branch label
  // read as a tappable Back-style button. Rendering our own header lets the branch be
  // plain inline text (no box) while keeping it tappable to open the switcher. Back
  // chevron + centered title replace the native equivalents.
  // Three-column row: equal-flex left/right slots keep the title truly centered
  // regardless of branch-name length; the right slot is bounded so a long branch name
  // truncates instead of shoving the title off-center.
  // When `embedded`, this renders inline in a two-pane layout (the embedding screen
  // owns the route header): no back button (no pane-local back nav) and `theme.spacing.sm`
  // top padding instead of the safe-area inset (the pane sits below the app header).
  const headerBar = (
    <View style={[styles.header, { paddingTop: embedded ? theme.spacing.xs : insets.top }]}>
      <View style={[styles.headerRow, embedded && styles.headerRowEmbedded]}>
        {embedded ? (
          <View style={styles.headerSide} />
        ) : (
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
        )}
        <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">
          {sessionFallback}
        </Text>
        {/* Right spacer keeps the title centered now that the actions live on the
            context row below — the title row gets the full width, so the session name
            no longer truncates on a phone. */}
        <View style={styles.headerSide} />
      </View>
      {/* Context row under the title: the branch switcher (#91) and the bookmarks
          jump-list (#bookmarks), plus the Issue chip when present. Moved down off the
          title row so the title reads full-width; the engine switcher lives on the
          input bar's action row. */}
      <View style={styles.headerMetaRow}>
        {/* Left slot: the Issue chip when present, left-aligned so it never nudges the
            centered branch switcher. */}
        <View style={styles.headerMetaSide}>
          {issueNumber !== null ? (
            <MetaChip label={`Issue #${issueNumber}`} url={issueUrl} />
          ) : null}
        </View>
        {/* Center: the branch switcher (#91), anchored to the row's true center by the
            two equal-flex side slots — so its position stays put whether or not there
            are bookmarks. */}
        <Pressable
          onPress={() => setSwitcherOpen(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Current branch ${currentLabel}. Tap to switch branch.`}
          style={styles.headerBranchBtn}
        >
          <Icon name="git-branch" size={12} color={theme.colors.textMuted} />
          <Text style={styles.headerBranch} numberOfLines={1}>
            {currentLabel}
          </Text>
          {/* A quiet caret signals the branch is tappable (opens the switcher, #91)
              without making it read as a Back-style button. */}
          <Icon name="chevron-down" size={18} color={theme.colors.textFaint} />
        </Pressable>
        {/* Right slot: the bookmarks jump-list (#bookmarks), pinned to the right edge
            when any exist — it appears without shifting the centered branch. */}
        <View style={[styles.headerMetaSide, styles.headerMetaSideRight]}>
          {kind === 'agent_loop' ? (
            <Pressable
              onPress={() => setLoopCockpitOpen(true)}
              disabled={!agentLoop}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Open Loop cockpit"
              accessibilityState={{ disabled: !agentLoop }}
              style={styles.headerLoopButton}
            >
              <Text style={styles.headerLoopButtonText}>Loop</Text>
            </Pressable>
          ) : null}
          {bookmarks.ids.size > 0 ? (
            <Pressable
              onPress={() => setBookmarksOpen(true)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`${String(bookmarks.ids.size)} bookmarks. Tap to view.`}
              style={styles.headerBookmarkBtn}
            >
              <Icon name="bookmark" size={15} color={theme.colors.textMuted} />
              <Text style={styles.headerBookmarkCount}>{bookmarks.ids.size}</Text>
            </Pressable>
          ) : null}
          {projectId ? (
            <Pressable
              onPress={() => void toggleDevServerPreview()}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={
                devServerPreview === 'on'
                  ? 'Stop previewing this session in the dev server'
                  : 'Preview this session in the dev server'
              }
              accessibilityState={{
                selected: devServerPreview === 'on',
                busy: devServerPreview === 'busy',
              }}
              style={styles.headerBookmarkBtn}
            >
              <Icon
                name="monitor"
                size={15}
                color={devServerPreview === 'on' ? theme.colors.primary : theme.colors.textMuted}
              />
              <Text
                style={[
                  styles.headerBookmarkCount,
                  devServerPreview === 'on' ? { color: theme.colors.primary } : null,
                ]}
              >
                Preview
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => {
              setFilesInitialPath(null);
              setFilesOpen(true);
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Browse session files"
            style={styles.headerBookmarkBtn}
          >
            <Icon name="folder" size={15} color={theme.colors.textMuted} />
          </Pressable>
        </View>
      </View>
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      // The custom nav header is drawn by the navigator ABOVE this screen body, so
      // the KAV frame already starts below it (screen-absolute coords) — no extra
      // offset needed. A non-zero offset here over-lifts the input by ~the header
      // height, leaving a dead gap between the field and the keyboard top.
      keyboardVerticalOffset={0}
    >
      {embedded ? headerBar : <Stack.Screen options={{ header: () => headerBar }} />}
      {switcherOpen ? (
        <BranchSwitcherSheet branches={branches} onClose={() => setSwitcherOpen(false)} />
      ) : null}
      {bookmarksOpen ? (
        <BookmarksSheet
          bookmarks={bookmarks}
          onJump={(messageId) => {
            setBookmarksOpen(false);
            jumpToBookmark(messageId);
          }}
          onClose={() => setBookmarksOpen(false)}
        />
      ) : null}
      {filesOpen ? (
        <SessionFilesSheet
          client={client}
          sessionId={sessionId}
          baseUrl={baseUrl}
          initialFilePath={filesInitialPath}
          onClose={() => setFilesOpen(false)}
        />
      ) : null}
      {enginePickerOpen ? (
        <EngineSwitcherSheet
          models={selectableModels}
          modelOrder={selectableModelOrder}
          moreModels={selectableMoreModels}
          selected={effectiveModel}
          busy={switchingModel}
          rateLimitNotice={rateNotice}
          onPick={(m) => {
            // No-op if it's already the current engine/model; otherwise switch and
            // close (the chip + subsequent turns reflect it via the persisted choice).
            if (m === effectiveModel) {
              setEnginePickerOpen(false);
              return;
            }
            // Switching hands the worktree from one agent to the next, which means the
            // running turn is interrupted — the handover cannot be safe and deferred at
            // the same time. That is fine on an idle session and destructive on a busy
            // one, so ask exactly when it costs something.
            //
            // `busy` alone is too coarse: a session fenced by an unconfirmed
            // termination is busy with nothing running, and telling the operator we
            // are about to stop "the agent that is working right now" would be wrong
            // twice over — nothing is working, and the switch will fail with a 503
            // rather than interrupt anything. The banner is where that state gets
            // acted on, so let the pick fall through to the ordinary error path.
            if (busy && !terminationUnconfirmed) {
              Alert.alert(
                'Interrupt the running turn?',
                'Switching the model stops the agent that is working right now. Its progress so ' +
                  'far stays in the transcript, but the turn does not finish. A turn that starts ' +
                  'in the next moment is stopped too.',
                [
                  {
                    text: 'Keep working',
                    style: 'cancel',
                    onPress: () => setEnginePickerOpen(false),
                  },
                  {
                    text: 'Switch anyway',
                    style: 'destructive',
                    onPress: () => {
                      switchModel(m);
                      setEnginePickerOpen(false);
                    },
                  },
                ],
              );
              return;
            }
            switchModel(m);
            setEnginePickerOpen(false);
          }}
          onClose={() => setEnginePickerOpen(false)}
        />
      ) : null}
      {agentLoop ? (
        <AgentLoopCockpit
          client={client}
          loop={agentLoop}
          visible={loopCockpitOpen}
          onClose={() => setLoopCockpitOpen(false)}
          onEdit={editAgentLoop}
          onLoopChanged={(updated) => {
            setAgentLoop(updated);
            publishAgentLoopMutation(updated);
          }}
          sessionBusy={sending || busy}
        />
      ) : null}
      {dead ? (
        <Banner
          tone="attention"
          text="This session's workspace was cleaned up. The transcript stays available, but new turns need a new agent."
        />
      ) : null}
      {rateNotice ? (
        <Banner
          tone={rateLimitNoticeTone(rateNotice)}
          text={rateLimitNoticeText(
            rateNotice,
            formatResetDisplay(rateNotice.resetsAt, rateNotice.window),
          )}
        />
      ) : null}
      {streamError ? <Banner tone="attention" text={`Stream: ${streamError}`} /> : null}
      {sendError ? <Banner tone="danger" text={`Send failed: ${sendError}`} /> : null}
      {switchModelError ? (
        <Banner tone="danger" text={`Model switch failed: ${switchModelError}`} />
      ) : null}
      {modelSwitchPending ? (
        <Banner tone="attention" text="Switching model — handing over from the running agent…" />
      ) : null}
      {/* Busy for a reason nothing else on this screen explains: the worktree stays
          reserved until the previous agent process is confirmed gone. Nothing is
          running for the operator, and the server keeps trying by itself — first the
          bounded reaper, then the periodic liveness sweep. But both need evidence the
          old worker is gone, and a worker that is alive with an unreachable control
          plane never produces any, so this state can outlast every automatic path.
          Hence the escape hatch: waiting is the advice, not the only option. */}
      {terminationUnconfirmed ? (
        <Banner
          tone="attention"
          text="Waiting for the previous agent to exit — the session stays reserved until it does."
          action={{ label: 'Release', onPress: onForceRelease }}
        />
      ) : null}
      {cancelError ? <Banner tone="danger" text={`Stop failed: ${cancelError}`} /> : null}
      {permissionError ? (
        <Banner tone="danger" text={`Decision failed: ${permissionError}`} />
      ) : null}
      {voice.error ? <Banner tone="danger" text={`Voice: ${voice.error}`} /> : null}
      {!loaded && !locallyCreated && messages.length === 0 && !streamError ? (
        // Still coming up: transcript hasn't drained yet and nothing has streamed in.
        // Show the loading animation inside the real chat body (header + composer
        // already rendered) rather than a blank pane. Locally-created sessions
        // deliberately skip this branch because their empty start is already known.
        // Suppressed on `streamError` so the spinner never contradicts the error
        // banner rendered above.
        <View style={styles.centered}>
          <ActivityIndicator color={theme.colors.textMuted} />
          <Text style={styles.emptySubtitle}>Opening session…</Text>
        </View>
      ) : (loaded || locallyCreated) && messages.length === 0 ? (
        // Existing sessions wait for their backlog before claiming to be empty.
        // A locally-created session is already known to start empty, so show the
        // usable chat state immediately while provisioning continues behind it.
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>No messages yet</Text>
          <Text style={styles.emptySubtitle}>
            Send a prompt below to steer this agent — its reply streams in live.
          </Text>
        </View>
      ) : (
        // Quick-Action chips (#97) reach the input/dispatch through the context. The
        // Rows stay chronological so FlashList's native chat anchoring can preserve the
        // viewport while older history is prepended and new text grows below it.
        <SessionActionsContext.Provider value={actions}>
          <SessionFileOpenContext.Provider value={openSessionFile}>
            <SessionFileImageSourceContext.Provider value={sessionFileImageSource}>
              <BookmarksContext.Provider value={bookmarks}>
                <FlashList
                  ref={listRef}
                  data={data}
                  keyExtractor={rowKey}
                  renderItem={renderItem}
                  getItemType={getItemType}
                  // Render further beyond the viewport (default ~250px) so rows above are
                  // MEASURED before a scroll-up reveals them — their height correction then
                  // happens off-screen instead of jumping the visible offset (cause-2 fix).
                  drawDistance={500}
                  // Visual inversion: newest-first data flipped back the right way up.
                  // Each row is counter-flipped in renderItem (styles.invertedItem).
                  style={styles.invertedList}
                  contentContainerStyle={styles.listContent}
                  onScroll={onListScroll}
                  onTouchEnd={clearSearchHighlightAfterTouch}
                  scrollEventThrottle={64}
                  // Only a real finger drag/fling summons the message-nav stack (see
                  // revealNav) — programmatic/content-driven scrolls (session open, agent
                  // streaming) fire none of these, so the stack never pops up on its own. The
                  // hold-then-fade starts on motion END (drag lift / fling settle), so the
                  // 1.8s is measured from the list coming to REST.
                  onScrollBeginDrag={onListScrollBeginDrag}
                  onMomentumScrollBegin={onListMomentumScrollBegin}
                  onScrollEndDrag={onListScrollEndDrag}
                  onMomentumScrollEnd={onListMomentumScrollEnd}
                  onViewableItemsChanged={onViewableItemsChanged}
                  viewabilityConfig={viewabilityConfig}
                  // Paging is driven by our scroll/viewability callbacks (see
                  // requestOlderHistory), which also own the settle window between
                  // pages that the native edge callbacks have no notion of.
                  //
                  // The spinner belongs to the OLDEST end, which in the newest-first
                  // list is the footer. It sits behind the viewport, so unlike the
                  // former header spinner it cannot shift a single visible row.
                  ListFooterComponent={
                    <View style={[styles.olderSpinner, styles.invertedItem]}>
                      <ActivityIndicator
                        color={theme.colors.textMuted}
                        animating={loadingOlder}
                        hidesWhenStopped={false}
                        style={!loadingOlder ? styles.olderSpinnerHidden : undefined}
                        accessibilityLabel="Loading older messages"
                        accessibilityElementsHidden={!loadingOlder}
                        importantForAccessibility={loadingOlder ? 'auto' : 'no-hide-descendants'}
                      />
                    </View>
                  }
                  maintainVisibleContentPosition={maintainVisibleContentPosition}
                  // Drag down to dismiss the keyboard; keep taps working (e.g. tool cards).
                  keyboardDismissMode="interactive"
                  keyboardShouldPersistTaps="handled"
                />
                {/* Opaque cover shown only while converging to a saved position that is
                already present in the initial loaded tail. It blocks touches during the
                measurement correction and lifts after we've scrolled to the anchor. */}
                {restoring ? (
                  <View style={styles.restoreCover}>
                    <ActivityIndicator color={theme.colors.textMuted} />
                  </View>
                ) : null}
              </BookmarksContext.Provider>
            </SessionFileImageSourceContext.Provider>
          </SessionFileOpenContext.Provider>
        </SessionActionsContext.Provider>
      )}
      {messages.length > 0 ? (
        // Gate on the transcript existing, NOT on a `user-text` row being loaded: with
        // one opening prompt + a very long agent turn, that row sits above the first
        // loaded page, so `userRowIndices` is empty until you scroll up far enough to
        // page it in — which made the whole stack vanish mid-transcript and only "pop
        // back" on scroll-up. Previous stays active while older history exists and
        // pages toward the next unloaded user row; next/latest self-disable when they
        // have no reachable target, so the stack stays available throughout.
        //
        // Message-nav stack, hugging the right edge, DEZENT (muted icons, no pill).
        // Icon language the operator picked: DOUBLE chevrons = "jump to my prev/next
        // message", SINGLE arrow = "jump to the very bottom" — so the three read
        // distinctly. Generous gap + hitSlop keep the three targets easy to hit apart.
        // Vertically centred in the VISIBLE transcript: top 50% of the frame, pulled up
        // by half the stack height AND half the input bar (which the frame includes),
        // so it lands mid-chat, not too low. Auto-fades at rest (opacity + navFaded →
        // pointerEvents) so it neither overlaps text nor costs any width.
        <Animated.View
          style={[
            styles.msgNav,
            {
              opacity: navOpacity,
              transform: [{ translateY: -(NAV_STACK_HALF + inputBarHeight / 2) }],
            },
          ]}
          pointerEvents={navFaded ? 'none' : 'box-none'}
        >
          <Pressable
            style={styles.msgNavBtn}
            hitSlop={12}
            onPress={jumpToPreviousUserRow}
            disabled={!canJumpToPreviousUser}
            accessibilityRole="button"
            accessibilityLabel="Jump to my previous message"
          >
            <Icon
              name="chevrons-up"
              size={22}
              color={!canJumpToPreviousUser ? theme.colors.textFaint : theme.colors.textMuted}
            />
          </Pressable>
          <Pressable
            style={styles.msgNavBtn}
            hitSlop={12}
            onPress={() => scrollToUserRow(nextUserIndex)}
            disabled={nextUserIndex < 0}
            accessibilityRole="button"
            accessibilityLabel="Jump to my next message"
          >
            <Icon
              name="chevrons-down"
              size={22}
              color={nextUserIndex < 0 ? theme.colors.textFaint : theme.colors.textMuted}
            />
          </Pressable>
          <Pressable
            style={styles.msgNavBtn}
            hitSlop={12}
            onPress={() => scrollToLatest(true)}
            disabled={atBottom}
            accessibilityRole="button"
            accessibilityLabel="Scroll to latest"
          >
            <Icon
              name="arrow-down"
              size={22}
              color={atBottom ? theme.colors.textFaint : theme.colors.textMuted}
            />
          </Pressable>
        </Animated.View>
      ) : null}
      {/* Live per-tool permission prompt (#149): when the mid-turn runner pauses on a
          tool, render an approve/deny prompt above the input. Sits below the
          transcript so it reads as "the agent is waiting on YOU", and POSTs the
          decision back. Hidden once answered (the stream clears `pendingPermission`). */}
      {session.pendingPermission ? (
        <PermissionPrompt
          pending={session.pendingPermission}
          deciding={decidingPermission === session.pendingPermission.toolUseId}
          dead={dead}
          onDecide={decidePermission}
        />
      ) : null}
      {waitingMessages.length > 0 ? (
        <QueuedMessages items={waitingMessages} onRetract={onRetractWaiting} />
      ) : null}
      {visiblePullRequest ? (
        <PullRequestBar
          key={visiblePullRequest.number}
          pullRequest={visiblePullRequest}
          onMerge={onMergePullRequest}
          onDismiss={visiblePullRequest.phase === 'open' ? undefined : dismissPullRequest}
        />
      ) : null}
      {!visiblePullRequest &&
      branches.localMergeBase !== undefined &&
      branches.current !== undefined &&
      branches.current !== branches.localMergeBase &&
      !branches.workspaceMissing ? (
        <LocalMergeBar
          branch={branches.current}
          base={branches.localMergeBase}
          onMerge={onMergeLocally}
        />
      ) : null}
      <InputBar
        inputRef={inputRef}
        value={draft}
        sendNonce={sendNonce}
        onChangeText={onDraftChange}
        onSend={onSend}
        canSend={canSend}
        sending={sending}
        // "Working" = the reconciled model signal (`state.working`): server-authoritative
        // `busy` (which already counts open background tasks) OR the reducer's eager
        // `session.running` while it's running AHEAD of the poll on a fresh turn. Unlike
        // a raw `busy || session.running`, it can't stick ON after the turn truly ended
        // (a reducer that missed a `task ended`), so the Stop button + activity line
        // agree with the overview's server `status` dot instead of diverging.
        running={working}
        onStop={onStop}
        dead={dead}
        voiceState={voice.state}
        onMic={voice.toggle}
        engineLabel={modelDisplayName(effectiveModel)}
        engineBusy={switchingModel}
        onEnginePress={() => {
          // Re-fetch /models each time the picker opens so a catalog the server
          // discovered after this screen mounted (e.g. Codex models that surfaced
          // once the secret store was unlocked) shows up without a screen remount.
          // The hook keeps the current list while loading, so this never blanks the
          // sheet.
          refreshModels();
          setEnginePickerOpen(true);
        }}
        bottomInset={keyboardShown ? 0 : insets.bottom}
        onHeightChange={setInputBarHeight}
        attachments={attachments}
        onAttach={onAttach}
        onDropFiles={onDropFiles}
        onDropRejected={onDropRejected}
        onRemoveAttachment={onRemoveAttachment}
        onFocus={isIpadFocusTarget ? onComposerFocus : undefined}
        onBlur={isIpadFocusTarget ? onComposerBlur : undefined}
      />
      <AttachMenu
        visible={attachMenuOpen}
        anchor={attachAnchor}
        onCapturePhoto={onCapturePhoto}
        onPickPhotos={onPickPhotos}
        onPickFiles={onPickFiles}
        onPickMeetingAudio={onPickMeetingAudio}
        onPickGoogleDrive={onPickGoogleDrive}
        onClose={() => setAttachMenuOpen(false)}
        onDismiss={runPendingPick}
      />
    </KeyboardAvoidingView>
  );
}

// A header Issue context chip (#125). Tappable when `url` is a string (opens the
// GitHub issue via `Linking.openURL`, announced as a link); when `url` is null —
// owner/repo unknown (no GitHub remote / older server) — it renders as the plain,
// non-tappable chip it always was, never linking to a broken URL (#161).
function MetaChip({ label, url }: { label: string; url: string | null }) {
  if (url === null) {
    return <Text style={styles.headerMetaChip}>{label}</Text>;
  }
  return (
    <Pressable
      hitSlop={6}
      // openURL rejects only if no handler can open the (always https) URL; swallow
      // so it never surfaces as an unhandled rejection.
      onPress={() => void Linking.openURL(url).catch(() => undefined)}
      accessibilityRole="link"
      accessibilityLabel={`${label}. Tap to open on GitHub.`}
    >
      <Text style={styles.headerMetaChip}>{label}</Text>
    </Pressable>
  );
}

// The engine chip on the header's second row (#switch-engine): names the session's
// current backend (Claude/Codex/…) and opens the picker on tap. Styled as a quiet,
// tappable meta pill with a caret (cf. the branch chip) — a spinner replaces the
// caret while a switch is resolving.
function EngineChip({
  engine,
  busy,
  onPress,
  // Optional style overrides so the same chip reads correctly in two placements:
  // the compact header meta row (default) and the input bar's action row.
  style,
  textStyle,
}: {
  engine: string;
  busy: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      hitSlop={6}
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={`Current model: ${engine}. Tap to switch model.`}
      style={[styles.headerEngineChip, style]}
    >
      <Text style={[styles.headerMetaChip, textStyle]}>{engine}</Text>
      {busy ? (
        <ActivityIndicator size="small" color={theme.colors.textMuted} />
      ) : (
        <Icon name="chevron-down" size={18} color={theme.colors.textFaint} />
      )}
    </Pressable>
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

type PanHandlers = ReturnType<typeof PanResponder.create>['panHandlers'];

function useResizableSheet(): {
  sheetStyle: Animated.WithAnimatedValue<ViewStyle>;
  panHandlers: PanHandlers;
} {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const minSheetHeight = Math.min(windowHeight * 0.7, Math.max(300, windowHeight * 0.34));
  const maxSheetHeight = Math.max(minSheetHeight, windowHeight - insets.top - 12);
  const defaultSheetHeight = clamp(windowHeight * 0.7, minSheetHeight, maxSheetHeight);
  const sheetHeight = useRef(new Animated.Value(defaultSheetHeight)).current;
  const sheetHeightRef = useRef(defaultSheetHeight);
  const dragStartHeight = useRef(defaultSheetHeight);
  useEffect(() => {
    const next = clamp(sheetHeightRef.current, minSheetHeight, maxSheetHeight);
    sheetHeightRef.current = next;
    sheetHeight.setValue(next);
  }, [maxSheetHeight, minSheetHeight, sheetHeight]);
  const setClampedSheetHeight = useCallback(
    (next: number) => {
      const clamped = clamp(next, minSheetHeight, maxSheetHeight);
      sheetHeightRef.current = clamped;
      sheetHeight.setValue(clamped);
    },
    [maxSheetHeight, minSheetHeight, sheetHeight],
  );
  const settleSheetHeight = useCallback(
    (next: number) => {
      const clamped = clamp(next, minSheetHeight, maxSheetHeight);
      sheetHeightRef.current = clamped;
      Animated.spring(sheetHeight, {
        toValue: clamped,
        damping: 24,
        stiffness: 260,
        mass: 0.9,
        useNativeDriver: false,
      }).start();
    },
    [maxSheetHeight, minSheetHeight, sheetHeight],
  );
  const resizePan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dy) > 2,
        onPanResponderGrant: () => {
          dragStartHeight.current = sheetHeightRef.current;
          sheetHeight.stopAnimation((height) => {
            sheetHeightRef.current = height;
            dragStartHeight.current = height;
          });
        },
        onPanResponderMove: (_event, gesture) => {
          setClampedSheetHeight(dragStartHeight.current - gesture.dy);
        },
        onPanResponderRelease: () => {
          settleSheetHeight(sheetHeightRef.current);
        },
        onPanResponderTerminate: () => {
          settleSheetHeight(sheetHeightRef.current);
        },
      }),
    [setClampedSheetHeight, settleSheetHeight, sheetHeight],
  );
  return {
    sheetStyle: {
      height: sheetHeight,
      maxHeight: maxSheetHeight,
      paddingBottom: insets.bottom + 12,
    },
    panHandlers: resizePan.panHandlers,
  };
}

function SheetResizeHandle({ panHandlers }: { panHandlers: PanHandlers }) {
  return (
    <View
      style={styles.filesResizeHandle}
      {...panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel="Resize sheet"
    >
      <View style={styles.sheetHandle} />
    </View>
  );
}

/** Ceiling for a file dropped into the browser for upload. The server streams
 * the body to disk and caps only on free space, but the native drop target
 * copies the file into the app's temporary directory first — so this bounds that
 * copy rather than the transfer. Far above the composer's attachment cap, which
 * exists for an unrelated reason (base64 inside a turn). */
const MAX_DROPPED_UPLOAD_BYTES = 100_000_000;
/** Ceiling across one drop. The native side copies every accepted file before
 * the first upload starts, so without this the per-file cap alone would let a
 * full drop take `MAX_DROPPED_UPLOADS × MAX_DROPPED_UPLOAD_BYTES` of scratch
 * space. Files past the budget are reported as skipped. */
const MAX_DROPPED_UPLOAD_TOTAL_BYTES = 250_000_000;
/** Files accepted from a single drop into the browser. */
const MAX_DROPPED_UPLOADS = 24;

function SessionFilesSheet({
  client,
  sessionId,
  baseUrl,
  initialFilePath,
  onClose,
}: {
  client: VerityClient;
  sessionId: string;
  baseUrl: string;
  initialFilePath: string | null;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  const sheet = useResizableSheet();
  const [path, setPath] = useState(initialFilePath ? parentPath(initialFilePath) : '');
  const [entries, setEntries] = useState<SessionFileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [dropActive, setDropActive] = useState(false);
  // Monotonic id of the newest preview fetch; a resolved fetch whose id no longer
  // matches is a superseded tap and is dropped. See openFile.
  const previewRequest = useRef(0);
  // Modifier keys held at the last touch down, reported by the native row before
  // its press fires (see DragSource). Shared by the whole list rather than kept
  // per row, because a press only ever follows its own report — and consumed by
  // that press, so it can never be read twice.
  const modifiers = useRef<ClickModifiers>({ shift: false, command: false });
  // What the next modifier-click needs to know about the last one: the row a
  // shift-click measures its range from, and the rows the last one contributed
  // so a smaller range can take them back. A ref, not state: it changes what the
  // next click means, never what is on screen.
  const modifierClick = useRef<{ anchor: string | null; range: string[] }>({
    anchor: null,
    range: [],
  });
  // Read on every render rather than memoized: the bearer lives in a module
  // variable that a biometric unlock can fill in after this sheet has mounted,
  // and a memo keyed on baseUrl would hand the native drag source the empty
  // string it saw first.
  const token = getAuthToken(baseUrl);
  const authorization = token !== null && token.length > 0 ? `Bearer ${token}` : '';
  const directTlsPin =
    getServerProfile()?.endpoints.find(({ url }) => url === baseUrl)?.transport === 'direct'
      ? getServerProfile()?.endpoints.find(({ url }) => url === baseUrl)?.tlsPin
      : undefined;

  useEffect(() => {
    if (!initialFilePath) return;
    // Shares openFile's request token so a tap during this initial fetch wins even
    // if the deep-linked file resolves afterwards.
    const request = (previewRequest.current += 1);
    const active = () => previewRequest.current === request;
    setPath(parentPath(initialFilePath));
    setError(null);
    setPreviewLoading(true);
    void client
      .getSessionFileContent(sessionId, initialFilePath)
      .then((file) => {
        if (active()) setPreview({ path: file.path, content: file.content });
      })
      .catch((err) => {
        if (active()) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active()) setPreviewLoading(false);
      });
    return () => {
      previewRequest.current += 1;
    };
  }, [client, sessionId, initialFilePath]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void client
      .listSessionFiles(sessionId, path)
      .then((dir) => {
        if (!active) return;
        setEntries(dir.entries);
        setTruncated(dir.truncated);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
        setEntries([]);
        setTruncated(false);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, sessionId, path, reloadKey]);

  // A reload — an upload landed, or the agent changed the tree — can retire rows
  // the selection still names. Pruning keeps the header count honest and stops a
  // drag from promising a file that is no longer listed.
  useEffect(() => {
    setSelected((current) => {
      const retained = retainVisibleSelection(current, entries);
      return retained.length === current.length ? current : retained;
    });
  }, [entries]);

  // Leaving a directory ends selection outright. Every selected row belongs to
  // the directory being left, so carrying the mode across would show an empty
  // "0 selected" header over rows that were never chosen.
  useEffect(() => {
    setSelecting(false);
    setSelected([]);
    modifierClick.current = { anchor: null, range: [] };
  }, [path]);

  const uploadFiles = useCallback(() => {
    void (async () => {
      let uploaded = false;
      let picked: Awaited<ReturnType<typeof pickSessionFiles>> = [];
      try {
        picked = await pickSessionFiles();
        if (picked.length === 0) return;
        setUploading(true);
        for (const file of picked) {
          await client.uploadSessionFile(sessionId, {
            path,
            fileName: file.fileName,
            data: new FsFile(file.uri),
          });
          uploaded = true;
        }
      } catch (err) {
        Alert.alert('Could not upload file', err instanceof Error ? err.message : String(err));
      } finally {
        // DocumentPicker copied every selected item into our cache. Dispose all
        // copies after success or failure; otherwise repeated large selections
        // permanently consume app storage.
        for (const file of picked) {
          try {
            new FsFile(file.uri).delete();
          } catch {
            // Best effort; the OS may already have reaped the temporary file.
          }
        }
        if (uploaded) setReloadKey((key) => key + 1);
        setUploading(false);
      }
    })();
  }, [client, path, sessionId]);

  const uploadDroppedFiles = useCallback(
    (files: readonly DroppedFileDescriptor[]) => {
      void (async () => {
        let uploaded = false;
        const failures: string[] = [];
        setUploading(true);
        try {
          // Each file is its own attempt: one rejected name — a collision, an
          // unwritable path — must not discard the rest of the drop, whose
          // temporary copies are deleted below either way.
          for (const file of files) {
            try {
              await client.uploadSessionFile(sessionId, {
                path,
                fileName: file.fileName,
                data: new FsFile(file.uri),
              });
              uploaded = true;
            } catch (err) {
              failures.push(
                `${file.fileName}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          if (failures.length > 0) {
            Alert.alert(
              failures.length === 1 ? 'Could not upload file' : 'Some files were not uploaded',
              failures.join('\n'),
            );
          }
        } finally {
          // These are the native drop target's own temporary copies. Unlike the
          // attachment path there is no reader that disposes of them, so a
          // failure partway through must not strand the rest.
          for (const file of files) {
            try {
              new FsFile(file.uri).delete();
            } catch {
              // Best effort; the OS also clears the app's temporary directory.
            }
          }
          if (uploaded) setReloadKey((key) => key + 1);
          setUploading(false);
        }
      })();
    },
    [client, path, sessionId],
  );

  const onUploadDropRejected = useCallback((errors: string[]) => {
    if (errors.length > 0) Alert.alert('Could not upload', errors.join('\n'));
  }, []);

  const openWith = useCallback(
    (filePath: string) => {
      void (async () => {
        const url = client.sessionFileDownloadUrl(sessionId, filePath);
        try {
          if (Platform.OS === 'web') {
            const blob = await client.downloadSessionFile(sessionId, filePath);
            const objectUrl = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = fileNameFromPath(filePath);
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
            return;
          }
          const cacheDir = new FsDirectory(Paths.cache, cacheDirectoryName(sessionId, filePath));
          cacheDir.create({ idempotent: true, intermediates: true });
          const token = getAuthToken(baseUrl);
          const destination = new FsFile(cacheDir, fileNameFromPath(filePath));
          const headers =
            token !== null && token.length > 0 ? { authorization: `Bearer ${token}` } : undefined;
          const file = directTlsPin
            ? new FsFile(
                await downloadPinnedFile({
                  url,
                  destination: destination.uri,
                  tlsPin: directTlsPin,
                  ...(headers ? { headers } : {}),
                }),
              )
            : await FsFile.downloadFileAsync(url, destination, {
                idempotent: true,
                ...(headers ? { headers } : {}),
              });
          const sharing = await loadSharingModule();
          if (sharing !== undefined && (await sharing.isAvailableAsync())) {
            await sharing.shareAsync(file.uri, {
              mimeType: mimeTypeForFile(filePath),
              dialogTitle: `Open ${fileNameFromPath(filePath)}`,
            });
          } else {
            throw new Error('No app is available to open or share this file');
          }
        } catch (err) {
          Alert.alert('Could not open file', err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [baseUrl, client, directTlsPin, sessionId],
  );

  const openFile = useCallback(
    (entry: SessionFileEntry) => {
      // Every tap invalidates whatever fetch is in flight: a large file takes long
      // enough that a second tap (or a directory hop) lands first, and without this
      // the slower response would win — showing a file the operator already left,
      // or clearing the spinner while the newer request is still running.
      const request = (previewRequest.current += 1);
      if (entry.kind === 'directory') {
        setPath(entry.path);
        setPreview(null);
        setPreviewLoading(false);
        return;
      }
      if (entry.kind !== 'file') return;
      setError(null);
      // A large file takes a moment to fetch AND to lay out; without this the sheet
      // sits unchanged after the tap and the open reads as a dead press.
      setPreviewLoading(true);
      void client
        .getSessionFileContent(sessionId, entry.path)
        .then((file) => {
          if (previewRequest.current !== request) return;
          setPreview({ path: file.path, content: file.content });
        })
        .catch((err) => {
          if (previewRequest.current !== request) return;
          if (err instanceof VerityApiError && (err.status === 413 || err.status === 415)) {
            openWith(entry.path);
            return;
          }
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (previewRequest.current !== request) return;
          setPreviewLoading(false);
        });
    },
    [client, sessionId, openWith],
  );

  const toggleSelected = useCallback((entry: SessionFileEntry) => {
    if (!isSelectableFile(entry)) return;
    modifierClick.current = { anchor: entry.path, range: [] };
    setSelected((current) => toggleFileSelection(current, entry.path));
  }, []);

  const endSelection = useCallback(() => {
    setSelecting(false);
    setSelected([]);
    modifierClick.current = { anchor: null, range: [] };
  }, []);

  const rememberModifiers = useCallback((held: ClickModifiers) => {
    modifiers.current = held;
  }, []);

  const forgetModifiers = useCallback(() => {
    modifiers.current = { shift: false, command: false };
  }, []);

  // What a press on a row means. A command- or shift-click selects — entering
  // selection mode on its own, so a Mac operator never has to find the header
  // toggle first — and anything else keeps the touch behaviour: pick the row in
  // selection mode, open it outside of one.
  const pressFileRow = useCallback(
    (entry: SessionFileEntry) => {
      // Consumed, not just read: every touch reports its own flags before its
      // press, so a press that finds a report left over is one that had no touch
      // behind it — VoiceOver activation, say — and must not inherit whatever was
      // held last. Touches that end in a drag or a scroll withdraw their own
      // report (see forgetModifiers), so nothing is left standing there either.
      const held = modifiers.current;
      modifiers.current = { shift: false, command: false };
      const next = selectionForModifierClick(
        { selected, ...modifierClick.current },
        entry,
        held,
        entries,
      );
      if (next) {
        modifierClick.current = { anchor: next.anchor, range: next.range };
        setSelected(next.selected);
        setSelecting(true);
        return;
      }
      if (selecting) {
        toggleSelected(entry);
        return;
      }
      openFile(entry);
    },
    [entries, openFile, selected, selecting, toggleSelected],
  );

  const downloadUrlFor = useCallback(
    (filePath: string) => client.sessionFileDownloadUrl(sessionId, filePath),
    [client, sessionId],
  );

  // Every row needs its own drag payload, and each selected row's payload is the
  // same ordered selection — so it is built once here rather than per row, which
  // would be quadratic in the size of the selection.
  const dragItemsByPath = useMemo(() => {
    const chosen = new Set(selected);
    const anySelected = entries.find((entry) => isSelectableFile(entry) && chosen.has(entry.path));
    const selectionItems = anySelected
      ? dragItemsForRow(anySelected, selected, entries, downloadUrlFor)
      : [];
    const byPath = new Map<string, DragFileItem[]>();
    for (const entry of entries) {
      if (!isSelectableFile(entry)) continue;
      byPath.set(
        entry.path,
        chosen.has(entry.path)
          ? selectionItems
          : // An empty selection is the "row outside the selection" case, which
            // is exactly what an unselected row should drag.
            dragItemsForRow(entry, [], entries, downloadUrlFor),
      );
    }
    return byPath;
  }, [entries, selected, downloadUrlFor]);

  const canSelect = useMemo(() => DRAG_OUT_SUPPORTED && entries.some(isSelectableFile), [entries]);

  // React Native lays a `<Text>` out as one native text node, so the whole body in a
  // single node silently renders blank well below the server's 1 MB preview limit (a
  // ~143 KB transcript did). Chunked + virtualized, only the visible blocks lay out.
  const previewChunks = useMemo(
    () => (preview ? chunkFilePreview(preview.content) : []),
    [preview],
  );

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} accessibilityRole="button">
        <View />
      </Pressable>
      <Animated.View style={[styles.sheet, sheet.sheetStyle]}>
        <SheetResizeHandle panHandlers={sheet.panHandlers} />
        <View style={styles.filesHeader}>
          <View style={styles.filesTitleWrap}>
            <Text style={styles.sheetTitle}>
              {selecting
                ? selected.length > 0
                  ? selectionSummary(selected.length)
                  : 'Select files'
                : 'Files'}
            </Text>
            <Text style={styles.filesPath} numberOfLines={1}>
              /{path}
            </Text>
          </View>
          {canSelect ? (
            <Pressable
              onPress={() => (selecting ? endSelection() : setSelecting(true))}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityState={{ selected: selecting }}
              accessibilityLabel={selecting ? 'Stop selecting files' : 'Select files'}
              style={styles.bookmarkRemove}
            >
              <Icon
                name={selecting ? 'x-square' : 'check-square'}
                size={19}
                color={selecting ? theme.colors.primary : theme.colors.textMuted}
              />
            </Pressable>
          ) : null}
          <Pressable
            onPress={uploadFiles}
            disabled={uploading}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Upload files to /${path}`}
            style={styles.bookmarkRemove}
          >
            {uploading ? (
              <ActivityIndicator size="small" color={theme.colors.textMuted} />
            ) : (
              // `file-plus`, not `upload`: Feather's upload glyph is a tray with an
              // arrow out of it, near-identical at this size to the per-row `share`
              // glyph right below it — two different actions reading as one icon.
              <Icon name="file-plus" size={19} color={theme.colors.textMuted} />
            )}
          </Pressable>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close files"
            style={styles.bookmarkRemove}
          >
            <Icon name="x" size={20} color={theme.colors.textMuted} />
          </Pressable>
        </View>
        {preview ? (
          <View style={styles.filesPreviewWrap}>
            <View style={styles.filesPreviewHeader}>
              <Pressable
                onPress={() => {
                  // Also drops a fetch still in flight, so leaving the preview can't
                  // be undone a second later by a slow response.
                  previewRequest.current += 1;
                  setPreview(null);
                  setPreviewLoading(false);
                }}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Back to file list"
                style={styles.bookmarkRemove}
              >
                <Icon name="chevron-left" size={20} color={theme.colors.textMuted} />
              </Pressable>
              <Text style={styles.filesPreviewTitle} numberOfLines={1}>
                {preview.path}
              </Text>
              {/* Chunked rendering means native text selection stops at each block, so
                  drag-selecting the whole file no longer works — this copies the exact
                  content the server returned, which is what select-all was for anyway. */}
              <CopyButton value={preview.content} accessibilityLabel="Copy file contents" />
              <Pressable
                onPress={() => openWith(preview.path)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Open file with another app"
                style={styles.bookmarkRemove}
              >
                <Icon name="share" size={18} color={theme.colors.textMuted} />
              </Pressable>
            </View>
            <FlatList
              style={styles.filesPreview}
              contentContainerStyle={styles.filesPreviewBody}
              data={previewChunks}
              keyExtractor={(_, index) => String(index)}
              initialNumToRender={8}
              maxToRenderPerBatch={8}
              windowSize={7}
              renderItem={({ item }) => (
                <Text selectable style={styles.filesPreviewText}>
                  {item}
                </Text>
              )}
              ListEmptyComponent={<Text style={styles.sheetEmpty}>Empty file</Text>}
            />
          </View>
        ) : previewLoading ? (
          <View style={styles.sheetLoading}>
            <ActivityIndicator color={theme.colors.textMuted} />
          </View>
        ) : (
          <>
            {error ? <Text style={styles.sheetError}>{error}</Text> : null}
            {truncated ? <Text style={styles.sheetLimited}>Showing first 1000 entries</Text> : null}
            {loading ? (
              <View style={styles.sheetLoading}>
                <ActivityIndicator color={theme.colors.textMuted} />
              </View>
            ) : (
              <DropZone
                style={styles.filesDropZone}
                enabled={!uploading}
                maxFiles={MAX_DROPPED_UPLOADS}
                maxFileBytes={MAX_DROPPED_UPLOAD_BYTES}
                maxTotalBytes={MAX_DROPPED_UPLOAD_TOTAL_BYTES}
                onFiles={uploadDroppedFiles}
                onRejected={onUploadDropRejected}
                onActiveChange={setDropActive}
              >
                {/* A touch that turned into a scroll never reaches a press, so
                    the modifiers it reported have to be withdrawn here too. */}
                <ScrollView style={styles.filesList} onScrollBeginDrag={forgetModifiers}>
                  {path ? (
                    <Pressable
                      onPress={() => setPath(parentPath(path))}
                      accessibilityRole="button"
                      style={({ pressed }) => [
                        styles.fileRow,
                        pressed ? styles.sheetRowPressed : null,
                      ]}
                    >
                      <Icon name="corner-up-left" size={18} color={theme.colors.textMuted} />
                      <Text style={styles.sheetRowLabel}>..</Text>
                    </Pressable>
                  ) : null}
                  {entries.length === 0 ? (
                    <Text style={styles.sheetEmpty}>No files</Text>
                  ) : (
                    entries.map((entry) => {
                      const meta = fileEntryMeta(entry);
                      const selectable = isSelectableFile(entry);
                      const picked = selectable && selected.includes(entry.path);
                      // In selection mode only files respond: a directory has
                      // nothing to select, and navigating away would discard the
                      // selection you are still building.
                      const inert = selecting
                        ? !selectable
                        : entry.kind === 'symlink' || entry.kind === 'other';
                      return (
                        <DragSource
                          key={entry.path}
                          // Every row stays draggable while selecting: grabbing
                          // one outside the selection drags just that file, the
                          // same as Finder. `items` already encodes which.
                          enabled
                          items={dragItemsByPath.get(entry.path) ?? []}
                          authorization={authorization}
                          tlsPin={directTlsPin ?? ''}
                          origin={baseUrl}
                          // The selection has done its job once the files land
                          // somewhere; leaving it up would strand the sheet in a
                          // mode you have to dismiss by hand. A row dragged from
                          // outside the selection did not carry it, so it leaves
                          // the selection alone.
                          onDelivered={selecting && picked ? endSelection : undefined}
                          onModifiers={rememberModifiers}
                        >
                          <Pressable
                            onPress={() => {
                              pressFileRow(entry);
                            }}
                            disabled={inert}
                            accessibilityRole={selecting ? 'checkbox' : 'button'}
                            accessibilityLabel={entry.name}
                            accessibilityState={selecting ? { checked: picked } : undefined}
                            style={({ pressed }) => [
                              styles.fileRow,
                              pressed || picked ? styles.sheetRowPressed : null,
                              inert ? styles.sheetRowDisabled : null,
                            ]}
                          >
                            <Icon name={fileIcon(entry)} size={18} color={theme.colors.textMuted} />
                            <View style={styles.fileMain}>
                              <Text
                                style={[styles.sheetRowLabel, styles.fileName]}
                                numberOfLines={2}
                                ellipsizeMode="tail"
                              >
                                {entry.name}
                              </Text>
                              {meta.length > 0 ? (
                                <Text style={styles.fileMeta} numberOfLines={1}>
                                  {meta}
                                </Text>
                              ) : null}
                            </View>
                            {selecting ? (
                              <View style={styles.fileDownload}>
                                <Icon
                                  name={picked ? 'check-square' : 'square'}
                                  size={18}
                                  color={picked ? theme.colors.primary : theme.colors.textFaint}
                                />
                              </View>
                            ) : entry.kind === 'file' ? (
                              <Pressable
                                onPress={() => openWith(entry.path)}
                                hitSlop={8}
                                accessibilityRole="button"
                                accessibilityLabel={`Open ${entry.name} with another app`}
                                style={styles.fileDownload}
                              >
                                <Icon name="share" size={17} color={theme.colors.textMuted} />
                              </Pressable>
                            ) : (
                              <Icon name="chevron-right" size={17} color={theme.colors.textFaint} />
                            )}
                          </Pressable>
                        </DragSource>
                      );
                    })
                  )}
                </ScrollView>
                {dropActive ? (
                  <View pointerEvents="none" style={styles.filesDropHint}>
                    <Icon name="download" size={18} color={theme.colors.primary} />
                    <Text style={styles.filesDropHintText}>Drop to upload to /{path}</Text>
                  </View>
                ) : null}
              </DropZone>
            )}
          </>
        )}
      </Animated.View>
    </Modal>
  );
}

// `bookmarkable` gates the per-message bookmark affordance: true for top-level
// transcript rows (which live in `data`, so the header sheet can scroll back to
// them), false for messages rendered inside a collapsed sub-agent subtree — those
// aren't rows we can jump to, so offering a bookmark there would be a dead anchor.
function renderRow(item: Row, isLatest: boolean, bookmarkable = true) {
  // Collapsible rows keep local `expanded` state and expand to many screens of detail.
  // FlashList recycles a cell renderer instance across items of the same type, so that
  // state (and the tall native height it produced) would otherwise bleed into the next,
  // often collapsed, row it's reused for — a large blank block. Keying each by its row
  // identity remounts it when the underlying item changes, resetting the state and
  // forcing a fresh measurement.
  //
  // Key off a GROWTH-STABLE id, not the row key: a group's row id derives from its LAST
  // member (transcriptRows.ts flushTools), so it changes every time a tool streams into
  // a live run — keying on that would remount (and collapse) an expanded live group on
  // each appended tool. The FIRST member is stable across tail growth, so an expanded
  // running group stays open; it still differs between genuinely distinct groups, which
  // is all the cross-item bleed reset needs. (It trades prepend-stability for
  // stream-stability: a boundary group whose head an older-page load extends will
  // remount — a rare history-scroll case, and no member id is stable across both.)
  if (item.kind === 'tool-group')
    return <ToolGroup key={item.tools[0]?.id ?? item.id} tools={item.tools} />;
  if (item.kind === 'todo-group')
    return <TodoGroup key={item.tools[0]?.id ?? item.id} tools={item.tools} />;
  if (item.kind === 'delegated-agent') return <DelegatedAgent key={item.id} row={item} />;
  switch (item.message.kind) {
    case 'user-text':
      return <UserBubble message={item.message} />;
    case 'agent-text':
      return <AgentBlock message={item.message} bookmarkable={bookmarkable} />;
    case 'tool-call':
      return <ToolCard key={item.message.id} message={item.message} />; // single tool not in a run
    case 'agent-event':
      return <EventRow message={item.message} />;
    case 'choices':
      // Interactive only while this is the LATEST row; `renderItem` computes that from
      // the chat list order. Once the operator answers, a newer row makes it no longer
      // latest and the chips freeze (#97: stale chips deactivate).
      return <ChoicesRow message={item.message} isLatest={isLatest} />;
    case 'agent-loop-proposal':
      return <AgentLoopProposalRow message={item.message} isLatest={isLatest} />;
  }
  return null;
}

// The operator's own message. These `user-text` messages are produced by the
// reducer from the canonical `prompt` event (the server persists the operator's
// steering prompt — see the prompt-event slice). Until that lands, the message is
// shown from a LOCAL ECHO (`message.pending`, minted by `SessionModel.sendTurn`)
// so it never disappears for the duration of a slow round trip; the model retires
// the echo the moment the canonical message arrives, so there is exactly one
// bubble at every point in time (see `SessionModel.retirePending`).
function HighlightedSearchText({ text }: { text: string }) {
  const query = useContext(SearchHighlightContext);
  return splitSearchHighlights(text, query).map((segment, index) => (
    <Text key={index} style={segment.highlighted ? styles.searchTermHighlight : undefined}>
      {segment.text}
    </Text>
  ));
}

function UserBubble({ message }: { message: UserTextMessage }) {
  const attachments = message.attachments ?? [];
  // Only images open the full-screen viewer; files render as (non-tappable) chips.
  const images = attachments.filter((a) => a.kind !== 'file');
  // Index (within `images`) of the attachment shown full-screen, or null when closed.
  const [viewer, setViewer] = useState<number | null>(null);
  const shown = viewer !== null ? images[viewer] : undefined;
  // A local echo: still in flight, or a send that failed and can be tapped to
  // recover the text. Both render as a normal (dimmed) bubble plus a status line.
  const pending = message.pending;
  const actions = useContext(SessionActionsContext);
  const recoverable = pending === 'failed' && actions !== null;
  return (
    <View>
      <Text style={styles.turnTimestamp}>{formatTurnTimestamp(message.createdAt)}</Text>
      <View style={styles.userRow}>
        <View style={[styles.userBubble, pending ? styles.userBubblePending : null]}>
          {attachments.length > 0 ? (
            <View style={styles.userImages}>
              {attachments.map((a, i) =>
                a.kind === 'file' ? (
                  <FilePreview key={i} name={a.fileName} />
                ) : (
                  <Pressable
                    key={i}
                    onPress={() => setViewer(images.indexOf(a))}
                    accessibilityRole="imagebutton"
                    accessibilityLabel={`View attached image ${String(i + 1)} full screen`}
                  >
                    <AttachmentImage
                      attachment={a}
                      style={styles.userImage}
                      contentFit="cover"
                      transition={120}
                    />
                  </Pressable>
                ),
              )}
            </View>
          ) : null}
          {message.text.length > 0 ? (
            // Native <Text selectable>, not <UITextView>: the latter is a native
            // iOS UITextView (a UIScrollView subclass) that intermittently
            // mis-measures its height on send — the bubble renders far taller than
            // its content and the text gets clipped inside the scroll frame (#153,
            // #136 fought the image-attachment variant; this is the text-only one).
            // A plain <Text> can't scroll or mis-measure — it always grows to fit.
            // We lose cross-block selection here, but that never worked across the
            // View-separated per-block UITextViews anyway, so nothing is given up.
            // Matches the pending-send twin (`queuedText`), which uses <Text> too.
            <Text style={styles.userText} selectable>
              <HighlightedSearchText text={message.text} />
            </Text>
          ) : null}
          {pending === 'sending' ? (
            <Text style={styles.userPendingTag}>◌ sending…</Text>
          ) : pending === 'failed' ? (
            <Pressable
              onPress={recoverable ? () => actions.recoverPending(message.id) : undefined}
              disabled={!recoverable}
              accessibilityRole={recoverable ? 'button' : 'text'}
              accessibilityLabel={recoverable ? 'Edit this unsent message' : undefined}
              accessibilityHint={
                recoverable
                  ? 'Removes the unsent message and puts the text back in the input'
                  : undefined
              }
            >
              <Text style={styles.userPendingTag}>
                {recoverable ? '✕ not sent · tap to edit' : '✕ not sent'}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {shown ? <ImageViewer attachment={shown} onClose={() => setViewer(null)} /> : null}
      </View>
    </View>
  );
}

// Full-screen viewer for a sent attachment. Base64 → data URI (or the stored-blob
// URL) for <Image>; the zoom/pan/close behaviour lives in ImageLightbox.
function ImageViewer({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const source = useAttachmentImageSource(attachment);
  if (source === undefined) return null;
  return (
    <ImageLightbox
      source={source}
      label={attachment.kind === 'file' ? attachment.fileName : undefined}
      onClose={onClose}
    />
  );
}

function AgentBlock({
  message,
  bookmarkable,
}: {
  message: AgentTextMessage;
  bookmarkable: boolean;
}) {
  if (message.id.startsWith('local-meeting-upload-agent-')) {
    const [status, ...fileNameParts] = message.text.split('\n');
    const fileName = fileNameParts.join('\n');
    return (
      <View
        style={styles.localMeetingUploadStatus}
        accessible
        accessibilityLabel={`${status ?? 'Uploading meeting audio'} ${fileName}`.trim()}
      >
        <View style={styles.localMeetingUploadIndicator}>
          <WorkingDot size={7} />
        </View>
        <View style={styles.localMeetingUploadStatusText}>
          <Text style={styles.localMeetingUploadTitle}>{status}</Text>
          {fileName ? (
            <Text style={styles.localMeetingUploadFileName} numberOfLines={1}>
              {fileName}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }
  // Branch (no hooks here) so each path's hooks stay unconditional. Thinking blocks
  // aren't bookmarkable — they're ephemeral reasoning, not an anchor worth returning
  // to; only the message id is threaded, so the affordance is off in the subtree too.
  return message.isThinking ? (
    <ThinkingBlock text={message.text} />
  ) : (
    <AgentMarkdown
      text={message.text}
      messageId={bookmarkable ? message.id : undefined}
      createdAt={message.createdAt}
    />
  );
}

// Copy-to-clipboard affordance: a Feather "copy" glyph that flips to "check" for a
// beat after a tap. `expo-clipboard` is already used by the GitHub onboarding flow.
// Reused as an always-on badge on code cards and as the tap-revealed action under
// agent prose. `label` is optional — code cards render icon-only.
function CopyButton({
  value,
  label,
  style,
  accessibilityLabel,
}: {
  value: string;
  label?: string;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel: string;
}) {
  const { theme } = useUnistyles();
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    void Clipboard.setStringAsync(value).then(() => {
      setCopied(true);
      // Revert so it doesn't read "copied" forever after a single tap.
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);
  const tint = copied ? theme.colors.primary : theme.colors.textMuted;
  return (
    <Pressable
      onPress={onCopy}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.copyBtn, style, pressed ? styles.copyBtnPressed : null]}
    >
      <Icon name={copied ? 'check' : 'copy'} size={15} color={tint} />
      {label ? (
        <Text style={[styles.copyLabel, { color: tint }]}>{copied ? 'Copied' : label}</Text>
      ) : null}
    </Pressable>
  );
}

// Agent prose: fenced code → a monospace card (with an always-on copy badge);
// everything else → markdown lines (headings / bullets / **bold** / `inline code`)
// so it reads as formatted text. A single tap anywhere on the message reveals a
// "Copy" action for the whole thing (auto-hides after a few seconds) — a plain
// tap, distinct from the long-press that drives native text selection, so the two
// gestures don't fight. (Text long-press selection is the per-block fallback until
// contiguous-prose selection lands.)
// `messageId` is present only for a bookmarkable top-level message (see renderRow /
// AgentBlock); when set, the tap-reveal row gains a bookmark toggle beside Copy and a
// persistent dog-ear marks the message while scrolling.
function AgentMarkdown({
  text,
  messageId,
  createdAt,
}: {
  text: string;
  messageId?: string;
  createdAt: number;
}) {
  const { theme } = useUnistyles();
  const searchHighlightQuery = useContext(SearchHighlightContext);
  const blocks = useMemo(() => splitRichText(text), [text]);
  const openSessionFile = useContext(SessionFileOpenContext);
  const sessionFileImageSource = useContext(SessionFileImageSourceContext);
  const [viewer, setViewer] = useState<{ source: ImageSource; label: string } | null>(null);
  const [showCopy, setShowCopy] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toggleCopy = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setShowCopy((v) => {
      const next = !v;
      if (next) hideTimer.current = setTimeout(() => setShowCopy(false), 4000);
      return next;
    });
  }, []);
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );
  const bookmarks = useContext(BookmarksContext);
  const bookmarked = messageId != null && bookmarks?.isBookmarked(messageId) === true;
  return (
    <Pressable
      onPress={toggleCopy}
      // Not an a11y element itself: keep the prose readable as individual nodes
      // rather than collapsing the whole message into one button. Copy is exposed
      // via the CopyButton's own a11y (and the reveal gesture is a sighted-user
      // convenience). VoiceOver users get per-block selection + the code badges.
      accessible={false}
    >
      <View style={[styles.agentBlock, showCopy && styles.agentBlockActive]}>
        {blocks.map((block, i) =>
          block.type === 'code' ? (
            <View key={i} style={styles.codeBlock}>
              {block.lang ? <Text style={styles.codeLang}>{block.lang}</Text> : null}
              {searchHighlightQuery ? (
                <Text style={styles.codeText} selectable>
                  <HighlightedSearchText text={block.content} />
                </Text>
              ) : (
                <UITextView style={styles.codeText} selectable uiTextView>
                  {block.content}
                </UITextView>
              )}
              <CopyButton
                value={block.content}
                accessibilityLabel="Copy code block"
                style={styles.codeCopyBtn}
              />
            </View>
          ) : (
            <MarkdownText
              key={i}
              content={block.content}
              onOpenLocalFile={openSessionFile}
              sessionFileImageSource={sessionFileImageSource}
              onOpenImage={(source, label) => setViewer({ source, label })}
            />
          ),
        )}
        {viewer !== null ? (
          <ImageSourceViewer
            source={viewer.source}
            label={viewer.label}
            onClose={() => setViewer(null)}
          />
        ) : null}
        {/* Persistent dog-ear: shows a bookmarked message is marked even at rest (no
            reveal needed), so it's spottable while scrolling — the Kindle affordance.
            Non-interactive so it never fights the tap-to-reveal / long-press-select
            gestures; toggling off happens via the reveal row or the header sheet. */}
        {bookmarked && !showCopy ? (
          <View style={styles.msgBookmarkFlag} pointerEvents="none">
            <Icon name="bookmark" size={13} color={theme.colors.primary} />
          </View>
        ) : null}
        {showCopy ? (
          <View style={styles.msgActions}>
            {messageId != null && bookmarks ? (
              <BookmarkButton
                bookmarked={bookmarked}
                // Persist a short preview + timestamp so the jump-list can show this
                // bookmark even when its message is scrolled out of the loaded window.
                onToggle={() =>
                  bookmarks.toggle(messageId, { preview: bookmarkPreview(text), createdAt })
                }
              />
            ) : null}
            <CopyButton
              value={text}
              accessibilityLabel="Copy message"
              style={styles.msgActionBtn}
            />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

// The bookmark toggle in a message's tap-revealed action row — the same corner-chip
// language as the Copy button next to it. Filled + tinted once bookmarked, so its
// state reads at a glance; tapping toggles it (and updates the header count + the
// dog-ear). Icon-only to match the Copy chip.
function BookmarkButton({ bookmarked, onToggle }: { bookmarked: boolean; onToggle: () => void }) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      onPress={onToggle}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={bookmarked ? 'Remove bookmark' : 'Bookmark this message'}
      style={({ pressed }) => [
        styles.copyBtn,
        styles.msgActionBtn,
        pressed ? styles.copyBtnPressed : null,
      ]}
    >
      <Icon
        name="bookmark"
        size={15}
        color={bookmarked ? theme.colors.primary : theme.colors.textMuted}
      />
    </Pressable>
  );
}

function MarkdownText({
  content,
  onOpenLocalFile,
  sessionFileImageSource,
  onOpenImage,
}: {
  content: string;
  onOpenLocalFile: ((path: string) => void) | null;
  sessionFileImageSource: ((path: string) => ImageSource | undefined) | null;
  onOpenImage: (source: ImageSource, label: string) => void;
}) {
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);
  return (
    <View>
      {blocks.map((block, i) =>
        block.type === 'table' ? (
          <MarkdownTable key={i} header={block.header} rows={block.rows} />
        ) : (
          block.lines.map((line, j) => (
            <MarkdownLine
              key={`${i}-${j}`}
              line={line}
              onOpenLocalFile={onOpenLocalFile}
              sessionFileImageSource={sessionFileImageSource}
              onOpenImage={onOpenImage}
            />
          ))
        ),
      )}
    </View>
  );
}

// A markdown table (GitHub-flavored: a header row, a `|---|` separator, body
// rows) → an aligned grid. The block-level parsing (`parseMarkdownBlocks` /
// `splitTableCells`) lives in @verity/mobile and is unit-tested; this component
// renders the parsed header + rows.
function MarkdownTable({ header, rows }: { header: string[]; rows: string[][] }) {
  return (
    <View style={styles.table}>
      <View style={[styles.tableRow, styles.tableHeaderRow]}>
        {header.map((cell, i) => (
          <View key={i} style={styles.tableCell}>
            <SelectableMarkdownText textStyle={[styles.agentText, styles.tableHeaderText]}>
              <Inline text={cell} onOpenLocalFile={null} />
            </SelectableMarkdownText>
          </View>
        ))}
      </View>
      {rows.map((row, ri) => (
        <View
          key={ri}
          style={[styles.tableRow, ri === rows.length - 1 ? styles.tableRowLast : null]}
        >
          {row.map((cell, ci) => (
            <View key={ci} style={styles.tableCell}>
              <SelectableMarkdownText textStyle={styles.agentText}>
                <Inline text={cell} onOpenLocalFile={null} />
              </SelectableMarkdownText>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const ORDERED = /^\s*(\d+)\.\s+(.*)$/;

// Agent prose uses native RN <Text>, not react-native-uitextview. Keep it out of
// generic flex rows: on iOS, selectable Text in a row can measure as one wide
// line and clip at the right edge. Direct column layout wraps normally and also
// avoids UITextView's clipped-height mis-measure.
function SelectableMarkdownText({
  textStyle,
  children,
}: {
  textStyle: StyleProp<TextStyle>;
  children: ReactNode;
}) {
  return (
    <Text style={[styles.mdText, textStyle]} selectable>
      {children}
    </Text>
  );
}

function MarkdownLine({
  line,
  onOpenLocalFile,
  sessionFileImageSource,
  onOpenImage,
}: {
  line: string;
  onOpenLocalFile: ((path: string) => void) | null;
  sessionFileImageSource: ((path: string) => ImageSource | undefined) | null;
  onOpenImage: (source: ImageSource, label: string) => void;
}) {
  const imageLinks = useMemo(() => localImageLinks(line), [line]);
  const heading = HEADING.exec(line);
  if (heading) {
    return (
      <SelectableMarkdownText textStyle={[styles.agentText, styles.mdHeading]}>
        <Inline text={heading[2] ?? ''} onOpenLocalFile={onOpenLocalFile} />
      </SelectableMarkdownText>
    );
  }
  const bullet = BULLET.exec(line);
  if (bullet) {
    return (
      <View style={styles.mdListRow}>
        <Text style={styles.mdBullet}>•</Text>
        <View style={styles.mdTextSlot}>
          <SelectableMarkdownText textStyle={styles.agentText}>
            <Inline text={bullet[1] ?? ''} onOpenLocalFile={onOpenLocalFile} />
          </SelectableMarkdownText>
          <LocalImageLinks
            links={imageLinks}
            sessionFileImageSource={sessionFileImageSource}
            onOpenImage={onOpenImage}
          />
        </View>
      </View>
    );
  }
  const ordered = ORDERED.exec(line);
  if (ordered) {
    return (
      <View style={styles.mdListRow}>
        <Text style={styles.mdBullet}>{ordered[1]}.</Text>
        <View style={styles.mdTextSlot}>
          <SelectableMarkdownText textStyle={styles.agentText}>
            <Inline text={ordered[2] ?? ''} onOpenLocalFile={onOpenLocalFile} />
          </SelectableMarkdownText>
          <LocalImageLinks
            links={imageLinks}
            sessionFileImageSource={sessionFileImageSource}
            onOpenImage={onOpenImage}
          />
        </View>
      </View>
    );
  }
  const section = markdownSectionTitle(line);
  if (section) {
    return (
      <SelectableMarkdownText textStyle={[styles.agentText, styles.mdSectionHeading]}>
        <HighlightedSearchText text={section} />
      </SelectableMarkdownText>
    );
  }
  if (line.trim() === '') return <View style={styles.mdGap} />;
  return (
    <View>
      <SelectableMarkdownText textStyle={styles.agentText}>
        <Inline text={line} onOpenLocalFile={onOpenLocalFile} />
      </SelectableMarkdownText>
      <LocalImageLinks
        links={imageLinks}
        sessionFileImageSource={sessionFileImageSource}
        onOpenImage={onOpenImage}
      />
    </View>
  );
}

function localImageLinks(line: string): Array<{ path: string; label: string }> {
  const seen = new Set<string>();
  const links: Array<{ path: string; label: string }> = [];
  for (const span of parseInline(line)) {
    if (span.t !== 'link' || span.external) continue;
    const path = sessionFilePathFromLocalLink(span.url);
    if (path === null || !isSessionImageFilePath(path) || seen.has(path)) continue;
    seen.add(path);
    links.push({ path, label: span.text });
  }
  return links;
}

function LocalImageLinks({
  links,
  sessionFileImageSource,
  onOpenImage,
}: {
  links: Array<{ path: string; label: string }>;
  sessionFileImageSource: ((path: string) => ImageSource | undefined) | null;
  onOpenImage: (source: ImageSource, label: string) => void;
}) {
  if (links.length === 0 || sessionFileImageSource === null) return null;
  return (
    <View style={styles.localLinkImages}>
      {links.map((link) => {
        const source = sessionFileImageSource(link.path);
        if (source === undefined) return null;
        return (
          <Pressable
            key={link.path}
            onPress={() => onOpenImage(source, link.label)}
            accessibilityRole="imagebutton"
            accessibilityLabel={`View ${link.label} full screen`}
          >
            <ExpoImage
              source={source}
              style={styles.localLinkImage}
              contentFit="contain"
              transition={120}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

function ImageSourceViewer({
  source,
  label,
  onClose,
}: {
  source: ImageSource;
  label: string;
  onClose: () => void;
}) {
  return <ImageLightbox source={source} label={label} onClose={onClose} />;
}

// Render inline **bold** / `code` / link spans (nested Text lays them out inline).
// A link tap opens the URL in the system browser; selection still works via a
// long-press on the surrounding selectable Text.
function Inline({
  text,
  onOpenLocalFile,
}: {
  text: string;
  onOpenLocalFile: ((path: string) => void) | null;
}) {
  const { theme } = useUnistyles();
  return (
    <>
      {parseInline(text).map((span, i) => {
        if (span.t === 'bold') {
          return (
            <Text key={i} style={styles.mdBold}>
              <HighlightedSearchText text={span.text} />
            </Text>
          );
        }
        if (span.t === 'code') {
          return (
            <Text key={i} style={[styles.mdCode, { color: theme.colors.accent }]}>
              <HighlightedSearchText text={span.text} />
            </Text>
          );
        }
        if (span.t === 'link') {
          const localPath = span.external ? null : sessionFilePathFromLocalLink(span.url);
          const canOpenLocal = localPath !== null && onOpenLocalFile !== null;
          return (
            <Text
              key={i}
              style={[
                span.external ? styles.mdLink : styles.mdReference,
                { color: span.external ? theme.colors.primary : theme.colors.accent },
              ]}
              // openURL rejects only if no handler can open it (no browser); swallow
              // so it never surfaces as an unhandled rejection (only http(s) reach here).
              onPress={
                span.external
                  ? () => void Linking.openURL(span.url).catch(() => undefined)
                  : canOpenLocal
                    ? () => onOpenLocalFile(localPath)
                    : undefined
              }
              accessibilityRole={span.external || canOpenLocal ? 'link' : undefined}
            >
              <HighlightedSearchText text={span.text} />
            </Text>
          );
        }
        return (
          <Text key={i}>
            <HighlightedSearchText text={span.text} />
          </Text>
        );
      })}
    </>
  );
}

// The agent's reasoning, collapsed to a subtle one-line chip by default. Only
// reached for NON-EMPTY thinking: headless `claude -p` exposes no thinking body
// (just a signature), so the reducer drops empty thinking blocks rather than
// render a chip that expands to nothing (#81). Retained for runtimes/futures that
// do surface the content.
function ThinkingBlock({ text }: { text: string }) {
  const { theme } = useUnistyles();
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        style={styles.thinkingRow}
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel="Thinking"
      >
        <Text style={styles.thinkingLabel}>Thinking</Text>
        <Icon
          name={open ? 'chevron-down' : 'chevron-right'}
          size={16}
          color={theme.colors.textFaint}
        />
      </Pressable>
      {open ? <Text style={[styles.agentText, styles.thinkingText]}>{text}</Text> : null}
    </View>
  );
}

// Images a tool returned (e.g. a Read of a PNG, #115) render inline — they ARE
// the payload the operator wants to see, not hidden behind a tap. Shared by the
// single-tool ToolCard and the collapsed ToolGroup so a Read that happens to sit
// next to another tool call never buries its image behind the group's "·N" line.
// The inline slot is only a preview though (a fixed-height, letterboxed strip), so
// a tap opens the image in the zoomable full-screen lightbox — a floor plan or a
// screenshot is unreadable at strip size. The Pressable also swallows the tap so it
// never reaches the enclosing ToolCard/ToolGroup and collapses the row underneath.
function ToolImages({ images }: { images: ToolImage[] }) {
  const [viewer, setViewer] = useState<ImageSource | null>(null);
  if (images.length === 0) return null;
  return (
    <View style={styles.toolImages}>
      {images.map((img, i) => (
        <ToolImageItem key={`${String(i)}-${img.id ?? 'inline'}`} image={img} onOpen={setViewer} />
      ))}
      {viewer !== null ? <ImageLightbox source={viewer} onClose={() => setViewer(null)} /> : null}
    </View>
  );
}

function ToolImageItem({
  image,
  onOpen,
}: {
  image: ToolImage;
  onOpen: (source: ImageSource) => void;
}) {
  const source = useAttachmentImageSource(image);
  if (source === undefined) return null;
  return (
    <Pressable
      onPress={() => onOpen(source)}
      accessibilityRole="imagebutton"
      accessibilityLabel="Image from tool result"
      accessibilityHint="Opens the image full screen, where you can pinch to zoom"
    >
      <ExpoImage source={source} style={styles.toolImage} contentFit="contain" />
    </Pressable>
  );
}

// Compact, Claude-app-style tool call: a single dense line (dot · tool · the
// command summary) collapsed by default; tap to expand the full input + output.
function ToolCard({ message }: { message: ToolCallMessage }) {
  const { theme } = useUnistyles();
  const view = toolCallView(message.tool);
  const color = theme.colors.tone[toolToneColor(view.tone)];
  const [expanded, setExpanded] = useState(false);
  // A `Skill` call (e.g. /code-review) carries the injected SKILL.md
  // body; show it as this card's collapsed detail instead of leaking it as prose,
  // and pulse the dot while the call is still launching.
  const skillBody = message.tool.skillBody;
  const running = message.tool.name === 'Skill' && message.tool.state === 'running';
  const expandable = Boolean(view.subtitle) || Boolean(view.preview) || Boolean(skillBody);
  return (
    <Pressable
      style={styles.toolCard}
      onPress={expandable ? () => setExpanded((e) => !e) : undefined}
      accessibilityRole={expandable ? 'button' : undefined}
      accessibilityLabel={view.headline}
    >
      <View style={styles.toolHeader}>
        {running ? (
          <WorkingDot size={7} />
        ) : (
          <View style={[styles.toolDot, { backgroundColor: color }]} />
        )}
        <Text style={styles.toolHeadline} numberOfLines={1}>
          {view.headline}
        </Text>
        {expandable ? (
          <Icon
            name={expanded ? 'chevron-down' : 'chevron-right'}
            size={16}
            color={theme.colors.textFaint}
          />
        ) : null}
      </View>
      <ToolImages images={view.images} />
      {expanded ? (
        <View style={styles.toolDetail}>
          {skillBody !== undefined ? (
            // The skill body replaces the generic input/result detail — the ack
            // ("Launching skill: …") and the skill name are just noise beside it.
            // Not `selectable` — matches the sibling tool detail and avoids the
            // long-press selection swallowing the card's collapse tap.
            <Text style={styles.toolSkillBody}>{skillBody}</Text>
          ) : (
            <>
              {view.subtitle ? <Text style={styles.toolCommand}>{view.subtitle}</Text> : null}
              {view.preview ? <Text style={styles.toolPreview}>{view.preview}</Text> : null}
            </>
          )}
        </View>
      ) : null}
    </Pressable>
  );
}

// A run of consecutive tool calls. One tool → the plain line. Several → a single
// collapsed line showing the LATEST tool (the "currently running" command as it
// streams in) plus a quiet "·N" count; tap to expand the whole run as individual
// lines.
function ToolGroup({ tools }: { tools: ToolCallMessage[] }) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);
  const last = tools[tools.length - 1];
  // Images returned by any tool in the run. Surfaced on the collapsed group so a
  // Read of a PNG isn't buried just because it sits next to another tool call
  // (#115). When expanded, the per-tool ToolCards render their own images, so this
  // strip is shown only while collapsed to avoid rendering each image twice.
  const images = useMemo(() => tools.flatMap((t) => toolCallView(t.tool).images), [tools]);
  if (!last) return null;
  if (tools.length === 1) return <ToolCard message={last} />;
  const view = toolCallView(last.tool);
  const color = theme.colors.tone[toolToneColor(view.tone)];
  return (
    <View>
      <Pressable
        style={styles.toolCard}
        onPress={() => setExpanded((e) => !e)}
        accessibilityRole="button"
        accessibilityLabel={`${tools.length} tool calls, latest ${view.headline}`}
      >
        <View style={styles.toolHeader}>
          <View style={[styles.toolDot, { backgroundColor: color }]} />
          <Text style={styles.toolHeadline} numberOfLines={1}>
            {view.headline}
          </Text>
          <Text style={styles.toolGroupCountText}>{`·${String(tools.length)}`}</Text>
          <Icon
            name={expanded ? 'chevron-down' : 'chevron-right'}
            size={16}
            color={theme.colors.textFaint}
          />
        </View>
      </Pressable>
      {expanded ? (
        <View style={styles.toolGroupList}>
          {tools.map((t) => (
            <ToolCard key={t.id} message={t} />
          ))}
        </View>
      ) : (
        <ToolImages images={images} />
      )}
    </View>
  );
}

// A delegation to a sub-agent (Agent/Task tool): collapsed to ONE card —
// "Delegated <description> ⎿ Done · N tools" — instead of flattening the whole
// sub-agent subtree into the transcript (#98). Tap to reveal the nested subtree.
function DelegatedAgent({ row }: { row: Extract<Row, { kind: 'delegated-agent' }> }) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);
  const view = toolCallView(row.parent.tool);
  const color = theme.colors.tone[toolToneColor(view.tone)];
  const state = row.parent.tool.state;
  const verb = state === 'running' ? 'Running' : state === 'error' ? 'Failed' : 'Done';
  const summary = `⎿ ${verb} · ${String(row.toolCount)} ${row.toolCount === 1 ? 'tool' : 'tools'}`;
  return (
    <View>
      <Pressable
        style={styles.toolCard}
        onPress={() => setExpanded((e) => !e)}
        accessibilityRole="button"
        accessibilityLabel={`${view.headline}. ${verb}, ${String(row.toolCount)} tools. Tap to ${
          expanded ? 'collapse' : 'expand'
        } the delegated sub-agent.`}
      >
        <View style={styles.toolHeader}>
          <View style={[styles.toolDot, { backgroundColor: color }]} />
          <Text style={styles.toolHeadline} numberOfLines={1}>
            {view.headline}
          </Text>
          <Icon
            name={expanded ? 'chevron-down' : 'chevron-right'}
            size={16}
            color={theme.colors.textFaint}
          />
        </View>
        <Text style={styles.delegatedSummary} numberOfLines={1}>
          {summary}
        </Text>
      </Pressable>
      {expanded ? (
        <View style={styles.delegatedSubtree}>
          {row.childRows.map((r) => (
            <View key={rowKey(r)}>{renderRow(r, false, false)}</View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// The TaskCreate/TaskUpdate churn collapsed into ONE todo widget (#98) instead of
// N cards: a single line with the latest op + a count badge; tap to expand the
// individual operations.
function TodoGroup({ tools }: { tools: ToolCallMessage[] }) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);
  const last = tools[tools.length - 1];
  if (!last) return null;
  const view = toolCallView(last.tool);
  // Always the "active" tone: a todo list reads as one live, in-progress widget
  // rather than per-op success/error states.
  const color = theme.colors.tone.active;
  return (
    <View>
      <Pressable
        style={styles.toolCard}
        onPress={() => setExpanded((e) => !e)}
        accessibilityRole="button"
        accessibilityLabel={`Todos: ${String(tools.length)} updates, latest ${view.headline}`}
      >
        <View style={styles.toolHeader}>
          <View style={[styles.toolDot, { backgroundColor: color }]} />
          <Text style={styles.toolHeadline} numberOfLines={1}>
            {view.headline}
          </Text>
          <Text style={styles.toolGroupCountText}>{`·${String(tools.length)}`}</Text>
          <Icon
            name={expanded ? 'chevron-down' : 'chevron-right'}
            size={16}
            color={theme.colors.textFaint}
          />
        </View>
      </Pressable>
      {expanded ? (
        <View style={styles.toolGroupList}>
          {tools.map((t) => (
            <ToolCard key={t.id} message={t} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function EventRow({ message }: { message: ModeSwitchMessage }) {
  const { theme } = useUnistyles();
  const descriptor = agentEventDescriptor(message.event);
  const color = theme.colors.tone[eventToneColor(descriptor.tone)];
  return (
    <View style={[styles.eventRow, descriptor.action ? styles.eventRowActionable : null]}>
      <Text style={[styles.eventLabel, { color }]}>{descriptor.label}</Text>
      {descriptor.detail ? <Text style={styles.eventDetail}>{descriptor.detail}</Text> : null}
      {descriptor.action === 'claude-login' ? (
        <Pressable
          style={({ pressed }) => [styles.eventAction, pressed ? styles.eventActionPressed : null]}
          onPress={() => router.push('/settings?agentLogin=claude')}
          accessibilityRole="button"
          accessibilityLabel="Sign in to Claude"
        >
          <Text style={styles.eventActionLabel}>Sign in to Claude</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// Quick-Action chips (issue #97): the agent's end-of-turn decision rendered as
// tappable options. A single-select tap sends the option's label as a new turn
// immediately; a multi-select choice toggles options and sends the chosen set via
// a "Send" button. The agent's recommended pick is highlighted, and a "Custom
// answer" chip opens the keyboard for a free-text reply. Chips are interactive
// only while this is the latest row and the session can take a turn — once the
// operator answers (tap or type), a newer message pushes this down and the chips
// freeze as a record of what was offered.
function ChoicesRow({ message, isLatest }: { message: ChoicesMessage; isLatest: boolean }) {
  const actions = useContext(SessionActionsContext);
  const [selected, setSelected] = useState<string[]>([]);
  if (actions === null) return null; // provider always wraps the list; defensive

  const active = isLatest && !actions.sending && !actions.dead;

  const send = (labels: readonly string[]): void => {
    if (!active || labels.length === 0) return;
    actions.sendTurn(formatChoiceAnswer(labels));
    setSelected([]);
  };
  const toggle = (label: string): void => {
    setSelected((cur) => (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]));
  };
  // Send the multi-select set in OPTION order (not tap order) so the agent reads a
  // stable, top-to-bottom answer.
  const sendSelected = (): void =>
    send(message.options.filter((o) => selected.includes(o.label)).map((o) => o.label));

  return (
    <View style={styles.choicesRow}>
      {message.question ? <Text style={styles.choicesQuestion}>{message.question}</Text> : null}
      <View style={styles.choicesChips}>
        {message.options.map((opt: ChoicesOption) => {
          const picked = message.multiSelect && selected.includes(opt.label);
          return (
            <Pressable
              key={opt.label}
              onPress={() => (message.multiSelect ? toggle(opt.label) : send([opt.label]))}
              disabled={!active}
              accessibilityRole="button"
              accessibilityState={{
                disabled: !active,
                ...(message.multiSelect ? { selected: picked } : {}),
              }}
              accessibilityLabel={opt.recommended ? `${opt.label} (recommended)` : opt.label}
              style={({ pressed }) => [
                styles.chip,
                opt.recommended ? styles.chipRecommended : null,
                picked ? styles.chipSelected : null,
                active ? null : styles.chipDisabled,
                pressed && active ? styles.chipPressed : null,
              ]}
            >
              {opt.recommended ? <Text style={styles.chipStar}>★</Text> : null}
              <Text
                style={[
                  styles.chipLabel,
                  opt.recommended ? styles.chipLabelRecommended : null,
                  picked ? styles.chipLabelSelected : null,
                ]}
                numberOfLines={2}
              >
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => active && actions.focusInput()}
          disabled={!active}
          accessibilityRole="button"
          accessibilityLabel="Write a custom answer"
          style={({ pressed }) => [
            styles.chip,
            styles.chipCustom,
            active ? null : styles.chipDisabled,
            pressed && active ? styles.chipPressed : null,
          ]}
        >
          <Text style={styles.chipCustomLabel}>✎ Custom answer</Text>
        </Pressable>
      </View>
      {message.multiSelect ? (
        <Pressable
          onPress={sendSelected}
          disabled={!active || selected.length === 0}
          accessibilityRole="button"
          accessibilityLabel="Send selected options"
          style={({ pressed }) => [
            styles.choicesSend,
            active && selected.length > 0 ? null : styles.choicesSendDisabled,
            pressed && active ? styles.chipPressed : null,
          ]}
        >
          <Text style={styles.choicesSendLabel}>
            {selected.length > 0 ? `Send (${String(selected.length)})` : 'Send'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function AgentLoopProposalRow({
  message,
  isLatest,
}: {
  message: AgentLoopProposalMessage;
  isLatest: boolean;
}) {
  const actions = useContext(SessionActionsContext);
  const [state, setState] = useState<'idle' | 'testing' | 'tested' | 'enabling' | 'enabled'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const proposal = message.proposal;
  const actionsAvailable = actions !== null && !actions.sending;
  const currentProposal =
    actions?.agentLoopId === proposal.loopId &&
    actions.agentLoopConfigFingerprint === agentLoopConfigFingerprint(proposal);
  const confirmActive = isLatest && actionsAvailable;
  const enableActive = actionsAvailable && currentProposal;

  useEffect(() => {
    if (!actions || !currentProposal || state === 'testing' || state === 'enabling') return;
    if (actions.agentLoopStatus === 'enabled') setState('enabled');
    else if (actions.agentLoopTested) setState('tested');
  }, [actions, currentProposal, state]);

  const confirm = useCallback(() => {
    if (!confirmActive || !actions) return;
    setState('testing');
    setError(null);
    void actions
      .confirmAgentLoop(message)
      .then(() => setState('tested'))
      .catch((caught: unknown) => {
        setState('idle');
        setError(caught instanceof Error ? caught.message : 'Could not test Agent Loop.');
      });
  }, [actions, confirmActive, message]);

  const enable = useCallback(() => {
    if (!enableActive || !actions || state !== 'tested') return;
    setState('enabling');
    setError(null);
    void actions
      .enableAgentLoop(proposal.loopId)
      .then(() => setState('enabled'))
      .catch((caught: unknown) => {
        setState('tested');
        setError(caught instanceof Error ? caught.message : 'Could not enable Agent Loop.');
      });
  }, [actions, enableActive, proposal.loopId, state]);

  return (
    <View style={styles.agentLoopProposal}>
      <View style={styles.agentLoopProposalHeader}>
        <Text style={styles.agentLoopProposalTitle}>{proposal.name}</Text>
        <Text style={styles.agentLoopProposalState}>
          {state === 'enabled'
            ? 'Enabled'
            : state === 'tested'
              ? 'Test passed'
              : state === 'testing'
                ? 'Testing…'
                : state === 'enabling'
                  ? 'Enabling…'
                  : 'Ready to test'}
        </Text>
      </View>
      <Text style={styles.agentLoopProposalSchedule}>
        {agentLoopProposalScheduleLabel(proposal.schedule)}
      </Text>
      <ScrollView style={styles.agentLoopProposalScript} nestedScrollEnabled>
        <Text selectable style={styles.agentLoopProposalScriptText}>
          {proposal.script}
        </Text>
      </ScrollView>
      <Text style={styles.agentLoopProposalHint}>
        Confirmation saves this configuration and runs it once in the project container. Enabling
        stays a separate decision after the test passes.
      </Text>
      {error ? <Text style={styles.agentLoopProposalError}>{error}</Text> : null}
      <Pressable
        onPress={confirm}
        disabled={!confirmActive || state !== 'idle'}
        accessibilityRole="button"
        accessibilityLabel="Confirm and test Agent Loop"
        accessibilityState={{ disabled: !confirmActive || state !== 'idle' }}
        style={[
          styles.agentLoopProposalConfirm,
          (!confirmActive || state !== 'idle') && styles.choicesSendDisabled,
        ]}
      >
        {state === 'testing' ? <ActivityIndicator size="small" /> : null}
        <Text style={styles.agentLoopProposalConfirmText}>
          {state === 'tested' || state === 'enabling' || state === 'enabled'
            ? 'Test passed'
            : 'Confirm & test'}
        </Text>
      </Pressable>
      {state === 'tested' || state === 'enabling' || state === 'enabled' ? (
        <Pressable
          onPress={enable}
          disabled={!enableActive || state !== 'tested'}
          accessibilityRole="button"
          accessibilityLabel="Enable Agent Loop"
          accessibilityState={{ disabled: !enableActive || state !== 'tested' }}
          style={[
            styles.agentLoopProposalConfirm,
            (!enableActive || state !== 'tested') && styles.choicesSendDisabled,
          ]}
        >
          {state === 'enabling' ? <ActivityIndicator size="small" /> : null}
          <Text style={styles.agentLoopProposalConfirmText}>
            {state === 'enabled' ? 'Agent Loop enabled' : 'Enable loop'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function agentLoopProposalScheduleLabel(
  schedule: AgentLoopProposalMessage['proposal']['schedule'],
): string {
  if (schedule.kind === 'interval') return `Every ${String(schedule.everyMinutes)} minutes`;
  const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
  if (schedule.kind === 'daily') return `Daily at ${time}`;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `${days[schedule.weekday] ?? 'Weekly'} at ${time}`;
}

// First non-empty line of a bookmarked message, lightly de-marked (drop a leading
// heading/bullet/quote marker) and clipped — enough to recognize the passage in the
// jump-list without storing any of the prose (it's resolved live from the message).
function bookmarkPreview(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '(empty message)';
  const clean = line.replace(/^(#{1,6}\s+|[-*+]\s+|>\s+)/, '');
  return clean.length > 100 ? `${clean.slice(0, 100)}…` : clean;
}

// The bookmarks jump-list (#bookmarks): a bottom sheet listing this session's
// bookmarks in transcript order. Driven by the PERSISTED entries (id + preview), so
// every bookmark shows even if its message hasn't been paged into the loaded window
// yet — tapping one pages history toward it (see jumpToBookmark). Tap a row to jump;
// tap × to remove. Mirrors the branch switcher's sheet chrome.
function BookmarksSheet({
  bookmarks,
  onJump,
  onClose,
}: {
  bookmarks: Bookmarks;
  onJump: (messageId: string) => void;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  const sheet = useResizableSheet();
  const { entries } = bookmarks;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={styles.sheetBackdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close bookmarks"
      />
      <Animated.View style={[styles.sheet, sheet.sheetStyle]}>
        <SheetResizeHandle panHandlers={sheet.panHandlers} />
        <Text style={styles.sheetTitle}>Bookmarks</Text>
        <ScrollView style={styles.sheetList} keyboardShouldPersistTaps="handled">
          {entries.length === 0 ? (
            <Text style={styles.sheetEmpty}>
              No bookmarks yet — tap a message, then the bookmark icon to save it here.
            </Text>
          ) : null}
          {entries.map((entry) => {
            const preview = entry.preview.length > 0 ? entry.preview : '(bookmarked message)';
            return (
              <View key={entry.id} style={styles.bookmarkRow}>
                <Pressable
                  style={({ pressed }) => [
                    styles.bookmarkRowMain,
                    pressed ? styles.sheetRowPressed : null,
                  ]}
                  onPress={() => onJump(entry.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Jump to bookmark: ${preview}`}
                >
                  <Icon name="bookmark" size={15} color={theme.colors.primary} />
                  <Text style={styles.bookmarkPreview} numberOfLines={2}>
                    {preview}
                  </Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.bookmarkRemove,
                    pressed ? styles.copyBtnPressed : null,
                  ]}
                  onPress={() => bookmarks.toggle(entry.id)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Remove bookmark"
                >
                  <Icon name="x" size={16} color={theme.colors.textMuted} />
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

// The branch switcher (#91): a bottom sheet listing the worktree's switchable
// branches + a "New branch" create row. Picking a branch (or creating one) calls
// switchTo, which keeps the session's chat and only moves its working branch. On
// the dirty-worktree case the sheet offers commit/stash retries inline. Rendered
// only while open, so its branch fetch runs only then.
function BranchSwitcherSheet({
  branches,
  onClose,
}: {
  // Shared with the top chip (one source of truth) so a switch updates BOTH —
  // the chip's branch name and the sheet's list — not just the sheet.
  branches: UseBranches;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  const sheet = useResizableSheet();
  const { current, switchable, previewable, loading, error, switchTo } = branches;

  // The in-flight branch name (existing or new) so we can disable the list +
  // spin the right row while a switch is resolving.
  const [pending, setPending] = useState<string | undefined>(undefined);
  const [newBranch, setNewBranch] = useState('');
  // A plain (non-dirty) switch error to surface inline.
  const [switchError, setSwitchError] = useState<string | undefined>(undefined);
  // The dirty-worktree prompt: which switch to retry with commit/stash. We hold
  // the original `switchTo` options so the retry targets the same branch.
  const [dirty, setDirty] = useState<{ opts: BranchSwitchRequest; label: string } | undefined>(
    undefined,
  );

  const run = useCallback(
    async (opts: BranchSwitchRequest, label: string): Promise<void> => {
      setPending(label);
      setSwitchError(undefined);
      setDirty(undefined);
      const result = await switchTo(opts);
      setPending(undefined);
      if (result.ok) {
        onClose();
        return;
      }
      if (result.dirty) {
        setDirty({ opts, label });
        return;
      }
      setSwitchError(result.message);
    },
    [switchTo, onClose],
  );

  const createNew = (): void => {
    const name = newBranch.trim();
    if (name.length === 0) return;
    void run({ newBranch: name }, name);
  };

  const busy = pending !== undefined;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={styles.sheetBackdrop}
        onPress={onClose}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Close switcher"
      />
      <Animated.View style={[styles.sheet, sheet.sheetStyle]}>
        <SheetResizeHandle panHandlers={sheet.panHandlers} />
        <Text style={styles.sheetTitle}>Switch branch</Text>
        <ScrollView style={styles.sheetList} keyboardShouldPersistTaps="handled">
          {error ? <Text style={styles.sheetError}>Couldn’t load branches: {error}</Text> : null}
          {switchError ? <Text style={styles.sheetError}>{switchError}</Text> : null}
          {loading && current === undefined ? (
            <View style={styles.sheetLoading}>
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          ) : null}
          {current !== undefined ? (
            <View style={styles.sheetRow}>
              <View style={[styles.sheetDot, { backgroundColor: theme.colors.tone.active }]} />
              <Text style={styles.sheetRowLabel} numberOfLines={1}>
                {current}
              </Text>
              <Text style={styles.sheetCurrent}>current</Text>
            </View>
          ) : null}
          {!loading && !error && switchable.length === 0 ? (
            <Text style={styles.sheetEmpty}>No other branches — create one below.</Text>
          ) : null}
          {switchable.map((branch) => (
            <Pressable
              key={branch}
              style={({ pressed }) => [styles.sheetRow, pressed ? styles.sheetRowPressed : null]}
              onPress={() => void run({ branch }, branch)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`Switch to branch ${branch}`}
            >
              <View style={[styles.sheetDot, { backgroundColor: theme.colors.border }]} />
              <Text style={styles.sheetRowLabel} numberOfLines={1}>
                {branch}
              </Text>
              {pending === branch ? <ActivityIndicator color={theme.colors.accent} /> : null}
            </Pressable>
          ))}
          {/* Preview a PR / pushed branch (#122): check out origin/<branch> DETACHED
              so the cockpit can see an open PR live, even one a sibling worktree is
              developing. Separate section from the local switch rows. */}
          {previewable.length > 0 ? (
            <>
              <Text style={styles.sheetSectionLabel}>Preview a PR / pushed branch</Text>
              {previewable.map((branch) => (
                <Pressable
                  key={`preview:${branch}`}
                  style={({ pressed }) => [
                    styles.sheetRow,
                    pressed ? styles.sheetRowPressed : null,
                  ]}
                  onPress={() => void run({ preview: branch }, branch)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={`Preview pushed branch ${branch}`}
                >
                  {/* Accent dot marks a preview (detached) row vs a local switch. */}
                  <View style={[styles.sheetDot, { backgroundColor: theme.colors.accent }]} />
                  <Text style={styles.sheetRowLabel} numberOfLines={1}>
                    {branch}
                  </Text>
                  <Text style={styles.sheetCurrent}>preview</Text>
                  {pending === branch ? <ActivityIndicator color={theme.colors.accent} /> : null}
                </Pressable>
              ))}
            </>
          ) : null}
        </ScrollView>

        {dirty ? (
          <View style={styles.dirtyPrompt}>
            <Text style={styles.dirtyText}>
              Uncommitted changes — keep them by committing or stashing before switching to{' '}
              {dirty.label}.
            </Text>
            <View style={styles.dirtyButtons}>
              <Pressable
                style={({ pressed }) => [
                  styles.dirtyButton,
                  pressed ? styles.sheetRowPressed : null,
                ]}
                onPress={() => void run({ ...dirty.opts, onDirty: 'commit' }, dirty.label)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Commit changes and switch"
              >
                <Text style={[styles.dirtyButtonText, { color: theme.colors.accent }]}>
                  Commit &amp; switch
                </Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.dirtyButton,
                  pressed ? styles.sheetRowPressed : null,
                ]}
                onPress={() => void run({ ...dirty.opts, onDirty: 'stash' }, dirty.label)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Stash changes and switch"
              >
                <Text style={[styles.dirtyButtonText, { color: theme.colors.accent }]}>
                  Stash &amp; switch
                </Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.dirtyButton,
                  pressed ? styles.sheetRowPressed : null,
                ]}
                onPress={() => setDirty(undefined)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={styles.dirtyButtonText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.sheetNew}>
            <TextInput
              style={styles.newBranchInput}
              value={newBranch}
              onChangeText={setNewBranch}
              placeholder="New branch name"
              placeholderTextColor={theme.colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              keyboardAppearance="dark"
              onSubmitEditing={createNew}
              accessibilityLabel="New branch name"
            />
            <Pressable
              style={({ pressed }) => [
                styles.newBranchButton,
                newBranch.trim().length === 0 || busy ? styles.newBranchButtonDisabled : null,
                pressed ? styles.sheetRowPressed : null,
              ]}
              onPress={createNew}
              disabled={newBranch.trim().length === 0 || busy}
              accessibilityRole="button"
              accessibilityLabel="Create and switch to new branch"
            >
              {pending === newBranch.trim() && newBranch.trim().length > 0 ? (
                <ActivityIndicator color={theme.colors.accent} />
              ) : (
                <Text style={[styles.newBranchButtonText, { color: theme.colors.accent }]}>
                  Create
                </Text>
              )}
            </Pressable>
          </View>
        )}
      </Animated.View>
    </Modal>
  );
}

// The engine/model picker for a RUNNING session (#switch-engine): a bottom sheet of
// the routable models, the current one marked. Picking one switches the session's
// backend from its next turn onward (the choice is persisted server-side). Mirrors
// the new-session ModelPickerSheet but reuses this screen's sheet styles, and each
// row shows the engine that model routes to so "Claude vs Codex" reads at a glance.
function EngineSwitcherSheet({
  models,
  modelOrder,
  moreModels,
  selected,
  busy,
  rateLimitNotice,
  onPick,
  onClose,
}: {
  models: string[];
  modelOrder: string[];
  moreModels: string[];
  selected: string | undefined;
  busy: boolean;
  rateLimitNotice: RateLimitNotice | null;
  onPick: (model: string) => void;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  const sheet = useResizableSheet();
  const partitionedModels = useMemo(
    () => partitionModels(models, moreModels, modelOrder),
    [models, moreModels, modelOrder],
  );
  const [moreOpen, setMoreOpen] = useState(
    () => selected !== undefined && partitionedModels.more.includes(selected),
  );
  const selectedIsMore = selected !== undefined && partitionedModels.more.includes(selected);
  useEffect(() => {
    if (selectedIsMore) setMoreOpen(true);
  }, [selectedIsMore]);
  const renderModelRow = (m: string) => {
    const isSelected = m === selected;
    const modelEngine = engineLabel(m);
    const rateLimited = modelRateLimited(rateLimitNotice, modelEngine);
    const disabled = busy || rateLimited;
    return (
      <Pressable
        key={m}
        style={({ pressed }) => [
          styles.sheetRow,
          disabled ? styles.sheetRowDisabled : null,
          pressed && !disabled ? styles.sheetRowPressed : null,
        ]}
        onPress={() => onPick(m)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ selected: isSelected, disabled }}
        accessibilityLabel={`Use model ${modelDisplayName(m)}, ${m}${
          isSelected ? ', current' : ''
        }${rateLimited ? ', limit reached' : ''}`}
      >
        <View
          style={[
            styles.sheetDot,
            { backgroundColor: isSelected ? theme.colors.tone.active : theme.colors.border },
          ]}
        />
        <Text style={styles.sheetRowLabel} numberOfLines={1}>
          {modelDisplayName(m)}
        </Text>
        {rateLimited ? (
          <Text style={styles.sheetLimited}>limit reached</Text>
        ) : isSelected ? (
          <Text style={styles.sheetCurrent}>current</Text>
        ) : modelEngine === 'OpenCode' ? (
          <Text style={styles.sheetCurrent}>OpenCode</Text>
        ) : null}
      </Pressable>
    );
  };
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={styles.sheetBackdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close model picker"
      />
      <Animated.View style={[styles.sheet, sheet.sheetStyle]}>
        <SheetResizeHandle panHandlers={sheet.panHandlers} />
        <Text style={styles.sheetTitle}>Switch model</Text>
        <ScrollView style={styles.sheetList} keyboardShouldPersistTaps="handled">
          {models.length === 0 ? <Text style={styles.sheetEmpty}>No models available.</Text> : null}
          {partitionedModels.primary.map(renderModelRow)}
          {partitionedModels.more.length > 0 ? (
            <Pressable
              style={({ pressed }) => [
                styles.sheetRow,
                styles.moreModelsRow,
                pressed ? styles.sheetRowPressed : null,
              ]}
              onPress={() => setMoreOpen((open) => !open)}
              accessibilityRole="button"
              accessibilityState={{ expanded: moreOpen }}
              accessibilityLabel={`${moreOpen ? 'Hide' : 'Show'} more models`}
            >
              <Text style={styles.sheetRowLabel}>More models</Text>
              <Icon
                name={moreOpen ? 'chevron-down' : 'chevron-right'}
                size={18}
                color={theme.colors.textFaint}
              />
            </Pressable>
          ) : null}
          {moreOpen ? partitionedModels.more.map(renderModelRow) : null}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

// The LIVE per-tool permission prompt (#149): when the mid-turn runner pauses the
// agent on a `can_use_tool`, the reducer surfaces it as `session.pendingPermission`
// and this renders an approve/deny prompt above the input. Shows the tool name + a
// one-line input summary (reusing `toolCallView`, the same summary the transcript
// tool cards use) so the operator knows exactly what they're approving. Tapping
// Allow/Deny POSTs the decision; the buttons disable + the tapped one spins while
// it's in flight (the `deciding` flag), and a dead session (worktree gone) makes
// the prompt inert. Once answered, the stream clears `pendingPermission` and this
// unmounts. Both buttons are real <Pressable> buttons with explicit accessibility
// labels so they're focus/keyboard reachable (a11y). A brokered-HTTP prompt shows
// a readable request summary instead of raw JSON and offers scoped allows
// (ADR 0011 D2): HTTP supports every scope; trusted CLI remains one-time because
// generic CLI configuration can load code that an argv digest cannot safely model.
function PermissionPrompt({
  pending,
  deciding,
  dead,
  onDecide,
}: {
  pending: PendingPermission;
  /** A decision POST for THIS prompt is in flight — disable the buttons + spin. */
  deciding: boolean;
  /** Session can't be resumed (worktree gone) — the prompt is inert. */
  dead: boolean;
  onDecide: (toolUseId: string, decision: PermissionDecision) => void;
}) {
  const { theme } = useUnistyles();
  // Reuse the transcript's tool summariser so "what am I approving" reads the same
  // as a tool card: a minimal synthetic ToolCall is enough for the headline/subtitle.
  const view = toolCallView({
    name: pending.tool,
    state: 'running',
    input: pending.input,
    createdAt: pending.createdAt,
    startedAt: pending.createdAt,
    completedAt: null,
    description: null,
  });
  const active = !deciding && !dead;
  const isBrokeredHttp = pending.tool === 'verity_http_request';
  const isTrustedCli = pending.tool === 'verity_secret_run';
  const isSessionHandoff = pending.tool === 'verity_session_handoff';
  const isListSessions = pending.tool === 'verity_list_sessions';
  const httpSummary = isBrokeredHttp ? brokeredHttpSummary(pending.input) : null;
  const cliSummary = isTrustedCli ? trustedCliSummary(pending.input) : null;
  const handoffSummary = isSessionHandoff ? sessionHandoffSummary(pending.input) : null;
  const listingSummary = isListSessions ? listSessionsSummary(pending.input) : null;
  const cliSecretLabel = cliSummary === null ? null : trustedCliSecretLabel(cliSummary);
  const grantInput =
    typeof pending.input === 'object' && pending.input !== null && !Array.isArray(pending.input)
      ? (pending.input as Record<string, unknown>)
      : undefined;
  const reusableScopes = secretGrantScopes(pending.tool, grantInput);
  const isScopedSecretTool = reusableScopes.length > 0;
  // A brokered request whose input the summariser could not read still has to be
  // legible before it is approved, so the raw input takes the summary's place
  // rather than leaving the card with nothing but the tool name.
  //
  // See {@link permissionInputText} for why rendering it is its own function: this
  // runs inside `render`, on the inputs least likely to be well-formed, and a throw
  // here removes the card rather than degrading it.
  const brokeredRequestDetails =
    (isBrokeredHttp && httpSummary === null) ||
    (isTrustedCli && cliSummary === null) ||
    (isSessionHandoff && handoffSummary === null) ||
    (isListSessions && listingSummary === null)
      ? permissionInputText(pending.input)
      : null;
  // The fallback path only — `brokeredRequestDetails` is non-null exactly when no summariser
  // read the input. The caveats are about the TOOL, not about the request, so an input that
  // could not be parsed does not make them less true; it makes them more necessary. Hence
  // `null` passed to each: there is no summary to read, the tool name is the whole input, and
  // the card still says what approving does rather than showing raw JSON and nothing else.
  //
  // Trusted CLI is absent from this chain and has no tool-level caveat to fall back to — its
  // warning is built from the parsed secret list, so there is nothing to render when parsing
  // is what failed. That is a gap in the same argument, not an exception to it.
  const brokeredRequestCaveats =
    brokeredRequestDetails === null
      ? null
      : isSessionHandoff
        ? sessionHandoffCaveats(null)
        : isListSessions
          ? listSessionsSentence(null)
          : null;
  // One row per brokered card rather than a ternary chain in the header: each summariser
  // owns its own headline, first match wins in the order they are parsed above, and the next
  // tool adds a line here instead of another level of nesting. The fallback names the tool,
  // which is all that is known when no summariser recognised the input.
  const cardTitle =
    [
      httpSummary === null ? null : brokeredHttpTitle(httpSummary),
      cliSecretLabel === null ? null : `Run trusted command with ${cliSecretLabel}?`,
      handoffSummary === null ? null : sessionHandoffTitle(handoffSummary),
      listingSummary === null ? null : listSessionsTitle(listingSummary),
    ].find((title) => title !== null) ??
    // Spelled out like every other string on the card. Tool names are server-controlled today,
    // so this is consistency rather than exposure — but it is the headline, and the one field
    // here that never passed a summariser.
    `Allow ${spellOutBidiControls(pending.tool)}?`;
  const allow = (scope?: 'session' | 'project' | 'forever'): void => {
    if (!active) return;
    onDecide(
      pending.toolUseId,
      scope === undefined ? { behavior: 'allow' } : { behavior: 'allow', scope },
    );
  };
  return (
    <View
      style={styles.permissionPrompt}
      // Announce the whole prompt as one a11y unit so the intent ("approve this
      // tool") is read before the operator reaches the Allow/Deny buttons.
      accessibilityRole="alert"
      accessibilityLabel={`The agent wants to run ${pending.tool}. Allow or deny.`}
    >
      <View style={styles.permissionHeader}>
        <View style={[styles.permissionDot, { backgroundColor: theme.colors.tone.attention }]} />
        <Text style={styles.permissionTitle} numberOfLines={1}>
          {cardTitle}
        </Text>
        {/* Surface the backend's risk class (#149): `ask` is the escalated case that
            reaches the operator; show it so the carried signal is visible, not just
            transported. (`auto` is normally pre-approved upstream, so it's rare here —
            labelled plainly if it ever arrives.) */}
        <Text style={styles.permissionRisk}>
          {pending.riskClass === 'ask' ? 'needs approval' : pending.riskClass}
        </Text>
      </View>
      {httpSummary !== null ? (
        <View style={styles.permissionHttpSummary}>
          <Text style={styles.permissionSubtitle} selectable numberOfLines={2}>
            {httpSummary.method} {httpSummary.host}
            {httpSummary.path}
          </Text>
          {httpSummary.body !== null ? (
            <ScrollView style={styles.permissionDetails} nestedScrollEnabled>
              {/* The method, host and path are held to printable ASCII by the summariser,
                  but the body is a stringified JSON value and is not — and `JSON.stringify`
                  does not escape bidi controls. Spelled out so the body reads in the order
                  it is sent. */}
              <Text style={styles.permissionSubtitle} selectable>
                {spellOutBidiControls(httpSummary.body)}
              </Text>
            </ScrollView>
          ) : null}
          <Text style={styles.permissionHttpMeta}>{brokeredAuthSentence(httpSummary)}</Text>
        </View>
      ) : cliSummary !== null ? (
        <View style={styles.permissionHttpSummary}>
          <ScrollView style={styles.permissionDetails} nestedScrollEnabled>
            {/* Command tokens are arbitrary strings and this is the card that hands a
                secret to a process — the displayed order has to be the executed order. */}
            <Text style={styles.permissionSubtitle} selectable>
              {spellOutBidiControls(
                cliSummary.command.map((token) => JSON.stringify(token)).join(' '),
              )}
            </Text>
          </ScrollView>
          <Text style={styles.permissionHttpMeta}>
            {cliSummary.entryScript !== null
              ? `Entry script ${cliSummary.entryScript.path} (SHA-256 ${cliSummary.entryScript.sha256}, ${cliSummary.entryScript.loading} loading). `
              : ''}
            Verity injects {trustedCliInjectionSummary(cliSummary)}. This trusted process can read,
            transform, or disclose{' '}
            {cliSummary.secrets.length === 1 ? 'the complete secret' : 'every one of them in full'}.
            Output redaction is hygiene only and cannot prevent exfiltration.
          </Text>
        </View>
      ) : handoffSummary !== null ? (
        <View style={styles.permissionHttpSummary}>
          {/* The target again, in full and selectable. The headline carries it too, but on one
              clipped line — and a session id may be 128 characters and a project reference 200,
              so the field this card exists to name is the one the header is likeliest to
              ellipsize away. Wrapped rather than clipped here, and first, because it is what
              the decision is about. */}
          <Text style={styles.permissionSubtitle} selectable>
            To {handoffSummary.target}
          </Text>
          <Text style={styles.permissionSubtitle} selectable numberOfLines={2}>
            {handoffSummary.title}
          </Text>
          {/* The briefing in full, scrollable. Approving is what turns this text into a
              prompt in another session, so it is the thing to read — not a preview of it.
              Its extent is stated first, because the box is the same height either way and a
              long briefing is otherwise indistinguishable from a short one until scrolled. */}
          <Text style={styles.permissionHttpMeta}>{briefingExtent(handoffSummary)}</Text>
          <ScrollView style={styles.permissionBriefing} nestedScrollEnabled>
            <Text style={styles.permissionSubtitle} selectable>
              {handoffSummary.briefing}
            </Text>
          </ScrollView>
          <Text style={styles.permissionHttpMeta}>{sessionHandoffCaveats(handoffSummary)}</Text>
        </View>
      ) : listingSummary !== null ? (
        // No scroll box and no input echo: the whole request is two fields, and both are
        // already in the headline and this sentence.
        <View style={styles.permissionHttpSummary}>
          <Text style={styles.permissionHttpMeta}>{listSessionsSentence(listingSummary)}</Text>
        </View>
      ) : brokeredRequestDetails !== null ? (
        <View style={styles.permissionHttpSummary}>
          {/* A handoff that fell back to raw JSON is still a briefing to read before approving,
              so it keeps the taller box rather than being the one card that shows 20,000
              characters through the short window. */}
          <ScrollView
            style={isSessionHandoff ? styles.permissionBriefing : styles.permissionDetails}
            nestedScrollEnabled
          >
            <Text style={styles.permissionSubtitle} selectable>
              {brokeredRequestDetails}
            </Text>
          </ScrollView>
          {brokeredRequestCaveats !== null ? (
            <Text style={styles.permissionHttpMeta}>{brokeredRequestCaveats}</Text>
          ) : null}
        </View>
      ) : view.subtitle ? (
        <Text style={styles.permissionSubtitle} numberOfLines={3}>
          {view.subtitle}
        </Text>
      ) : null}
      <View style={styles.permissionButtons}>
        <Pressable
          onPress={() => active && onDecide(pending.toolUseId, { behavior: 'deny' })}
          disabled={!active}
          accessibilityRole="button"
          accessibilityState={{ disabled: !active, busy: deciding }}
          accessibilityLabel={`Deny ${pending.tool}`}
          style={({ pressed }) => [
            styles.permissionButton,
            styles.permissionDeny,
            active ? null : styles.permissionButtonDisabled,
            pressed && active ? styles.permissionButtonPressed : null,
          ]}
        >
          {deciding ? (
            <ActivityIndicator color={theme.colors.tone.danger} />
          ) : (
            <Text style={[styles.permissionButtonLabel, { color: theme.colors.tone.danger }]}>
              Deny
            </Text>
          )}
        </Pressable>
        <Pressable
          onPress={() => allow()}
          disabled={!active}
          accessibilityRole="button"
          accessibilityState={{ disabled: !active, busy: deciding }}
          accessibilityLabel={`Allow ${pending.tool}${isScopedSecretTool ? ' once' : ''}`}
          style={({ pressed }) => [
            styles.permissionButton,
            styles.permissionAllow,
            active ? null : styles.permissionButtonDisabled,
            pressed && active ? styles.permissionButtonPressed : null,
          ]}
        >
          {deciding ? (
            <ActivityIndicator color={theme.colors.onPrimary} />
          ) : (
            <Text style={[styles.permissionButtonLabel, styles.permissionAllowLabel]}>
              {isScopedSecretTool ? 'Allow once' : 'Allow'}
            </Text>
          )}
        </Pressable>
      </View>
      {/* Scoped allows (ADR 0011 D2): quieter secondary actions. 'This session'
          auto-approves this secret+host pair until the session ends; 'Always'
          persists a project-wide grant for 30 days. */}
      {isScopedSecretTool ? (
        <View style={styles.permissionScopeRow}>
          {reusableScopes.includes('session') ? (
            <Pressable
              onPress={() => allow('session')}
              disabled={!active}
              accessibilityRole="button"
              accessibilityState={{ disabled: !active, busy: deciding }}
              accessibilityLabel={`Allow ${httpSummary?.secretAlias ?? cliSecretLabel ?? pending.tool} for ${httpSummary?.host ?? cliSummary?.executable ?? 'this destination'} for this session`}
              style={({ pressed }) => [
                styles.permissionScopeButton,
                active ? null : styles.permissionButtonDisabled,
                pressed && active ? styles.permissionButtonPressed : null,
              ]}
            >
              <Text style={styles.permissionScopeLabel}>Allow this session</Text>
            </Pressable>
          ) : null}
          {reusableScopes.includes('project') ? (
            <Pressable
              onPress={() => allow('project')}
              disabled={!active}
              accessibilityRole="button"
              accessibilityState={{ disabled: !active, busy: deciding }}
              accessibilityLabel={`Allow ${httpSummary?.secretAlias ?? cliSecretLabel ?? pending.tool} for ${httpSummary?.host ?? cliSummary?.executable ?? 'this destination'} in this project for 30 days`}
              style={({ pressed }) => [
                styles.permissionScopeButton,
                active ? null : styles.permissionButtonDisabled,
                pressed && active ? styles.permissionButtonPressed : null,
              ]}
            >
              <Text style={styles.permissionScopeLabel}>Allow for 30 days</Text>
            </Pressable>
          ) : null}
          {reusableScopes.includes('forever') ? (
            <Pressable
              onPress={() => allow('forever')}
              disabled={!active}
              accessibilityRole="button"
              accessibilityState={{ disabled: !active, busy: deciding }}
              accessibilityLabel={`Always allow ${httpSummary?.secretAlias ?? pending.tool} for ${httpSummary?.host ?? 'this destination'}`}
              style={({ pressed }) => [
                styles.permissionScopeButton,
                active ? null : styles.permissionButtonDisabled,
                pressed && active ? styles.permissionButtonPressed : null,
              ]}
            >
              <Text style={styles.permissionScopeLabel}>Always allow</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// Messages sent while the agent was busy (#90), shown as muted dashed "waiting"
// bubbles just above the input until their turn runs (their prompt event lands in
// the transcript) — so a queued message is visible, not silently swallowed.
function QueuedMessages({
  items,
  onRetract,
}: {
  items: { id: string; text: string; attachments?: Attachment[] }[];
  /** Tap a queued bubble to retract it back into the input (#80). */
  onRetract: (id: string) => void;
}) {
  return (
    <View style={styles.queuedWrap}>
      {items.map((item, i) => {
        // An id-less item comes from a pre-#80 server: render it but don't make it
        // tappable (there's no handle to retract it with).
        const retractable = item.id.length > 0;
        return (
          <View key={item.id || i} style={styles.queuedBubbleRow}>
            <Pressable
              style={styles.queuedBubble}
              onPress={retractable ? () => onRetract(item.id) : undefined}
              disabled={!retractable}
              // A non-retractable (old-server, id-less) bubble is informational, not a
              // control — announce it as text, not a dimmed/dead button.
              accessibilityRole={retractable ? 'button' : 'text'}
              accessibilityLabel={retractable ? 'Edit this queued message' : undefined}
              accessibilityHint={
                retractable
                  ? 'Removes it from the queue and puts the text back in the input'
                  : undefined
              }
            >
              {item.attachments && item.attachments.length > 0 ? (
                <View style={styles.userImages}>
                  {item.attachments.map((attachment, attachmentIndex) =>
                    attachment.kind === 'file' ? (
                      <FilePreview key={attachmentIndex} name={attachment.fileName} />
                    ) : (
                      <AttachmentImage
                        key={attachmentIndex}
                        attachment={attachment}
                        style={styles.userImage}
                        contentFit="cover"
                        transition={120}
                        accessibilityLabel={`Queued attachment ${String(attachmentIndex + 1)}`}
                      />
                    ),
                  )}
                </View>
              ) : null}
              <Text style={styles.queuedText} numberOfLines={3}>
                {item.text}
              </Text>
              <Text style={styles.queuedTag}>
                {retractable ? '⧖ waiting to send · tap to edit' : '⧖ waiting to send'}
              </Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

function PullRequestBar({
  pullRequest,
  onMerge,
  onDismiss,
}: {
  pullRequest: NonNullable<UseBranches['pullRequest']>;
  onMerge: UseBranches['mergePullRequest'];
  onDismiss?: () => void;
}) {
  const { theme } = useUnistyles();
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [mergeRejectedFor, setMergeRejectedFor] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  const { checks } = pullRequest;
  const pullRequestStateKey = [
    pullRequest.number,
    pullRequest.headSha ?? pullRequest.updatedAt ?? 'unknown',
    pullRequest.phase,
    pullRequest.pipeline,
    checks.completed,
    checks.total,
    checks.failed,
    checks.pending,
    pullRequest.mergeable === true
      ? 'mergeable'
      : pullRequest.mergeable === false
        ? 'blocked'
        : 'unknown',
    pullRequest.mergeState ?? 'no-state',
  ].join(':');
  const pending = pullRequest.pipeline === 'running' || pullRequest.pipeline === 'pending';
  const failed = pullRequest.pipeline === 'failure';
  // A conflicting PR gets no merge ref from GitHub, so its `pull_request` workflows
  // never start and the pipeline reads `unknown` with zero checks — which used to
  // render as the dead-end "status unavailable". `mergeable_state: 'dirty'` is the
  // authoritative signal, independent of the pipeline, so name the conflict instead.
  const conflicted = isPullRequestConflicted(pullRequest);
  const unavailable = pullRequest.pipeline === 'unknown' && !conflicted;
  // Only a CONFIRMED conflict (mergeable === false) blocks. `null` means GitHub is
  // still computing mergeability just after a push — treat that as "checks green,
  // resolving", not blocked, so a just-fixed PR doesn't flash red before it settles.
  const mergeabilityBlocked =
    conflicted ||
    (pullRequest.phase === 'open' &&
      pullRequest.pipeline === 'success' &&
      pullRequest.mergeable === false);
  const mergeRejected = !pending && mergeRejectedFor === pullRequestStateKey && error !== undefined;
  const mergeBlocked = failed || mergeabilityBlocked || mergeRejected;
  const visibleError = mergeRejected ? error : undefined;
  const merged = pullRequest.phase === 'merged';
  const checksText = pullRequestStatusText(pullRequest);
  const statusColor = mergeBlocked
    ? theme.colors.tone.danger
    : pending || checks.total === 0
      ? theme.colors.tone.attention
      : theme.colors.tone.done;
  const canMerge =
    pullRequest.phase === 'open' &&
    pullRequest.mergeable === true &&
    !conflicted &&
    !pending &&
    !merging &&
    !mergeRejected;
  const mergeButtonEnabled = canMerge;
  // A conflicted PR has zero checks but is NOT "waiting" for anything — nothing will
  // run until the conflict is resolved, so it must not pulse like a starting pipeline.
  const active =
    !failed &&
    !unavailable &&
    !conflicted &&
    (pending || (pullRequest.phase === 'open' && checks.total === 0) || merging);
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!active) {
      pulse.stopAnimation();
      pulse.setValue(1);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.68, duration: 850, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 850, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(1);
    };
  }, [active, pulse]);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (mergeRejectedFor === undefined) return;
    if (!pending && mergeRejectedFor === pullRequestStateKey) return;
    setMergeRejectedFor(undefined);
    setError(undefined);
  }, [mergeRejectedFor, pending, pullRequestStateKey]);

  const merge = (): void => {
    if (!mergeButtonEnabled) return;
    void (async () => {
      setMerging(true);
      setError(undefined);
      setMergeRejectedFor(undefined);
      const result = await onMerge(pullRequest.number);
      if (!mounted.current) return;
      setMerging(false);
      if (!result.ok) {
        setError(result.message);
        setMergeRejectedFor(pullRequestStateKey);
        return;
      }
      // On success there's nothing more to do client-side: onMerge already
      // refreshed the branch/PR state, and the post-merge worktree reset +
      // agent notification happen server-side.
    })();
  };

  return (
    <View style={styles.prBarWrap}>
      <View style={styles.prBar}>
        <Pressable
          style={({ pressed }) => [styles.prOpenTarget, pressed ? styles.prBarPressed : null]}
          onPress={() => void Linking.openURL(pullRequest.url).catch(() => undefined)}
          accessibilityRole="link"
          accessibilityLabel={`Open pull request ${String(pullRequest.number)} on GitHub`}
        >
          <Animated.View
            style={[
              styles.prStatusDot,
              { backgroundColor: statusColor },
              active ? { opacity: pulse, transform: [{ scale: pulse }] } : null,
            ]}
          />
          <View style={styles.prMain}>
            <Text style={styles.prTitle} numberOfLines={1}>
              PR #{pullRequest.number} · {pullRequest.title}
            </Text>
            <Text style={styles.prSub} numberOfLines={1}>
              {merged ? 'merged' : pullRequest.phase} · {checksText}
            </Text>
            {visibleError ? (
              <Text style={styles.prError} numberOfLines={1}>
                {visibleError}
              </Text>
            ) : null}
          </View>
        </Pressable>
        {onDismiss ? (
          <Pressable
            style={({ pressed }) => [
              styles.prDismissButton,
              pressed ? styles.prDismissButtonPressed : null,
            ]}
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel={`Hide pull request ${String(pullRequest.number)} status`}
          >
            <Text style={styles.prDismissText}>×</Text>
          </Pressable>
        ) : (
          <Pressable
            style={({ pressed }) => [
              styles.prMergeButton,
              // "Merge" reads as green for the go action. Hard blockers, including a
              // rejected merge attempt, turn the disabled button danger instead of leaving
              // a green action next to a red error.
              { backgroundColor: mergeBlocked ? theme.colors.tone.danger : theme.colors.tone.done },
              !mergeButtonEnabled && !mergeBlocked ? styles.prMergeButtonDisabled : null,
              pressed && mergeButtonEnabled ? styles.prMergeButtonPressed : null,
            ]}
            onPress={merge}
            disabled={!mergeButtonEnabled}
            accessibilityRole="button"
            accessibilityState={{ disabled: !mergeButtonEnabled, busy: merging }}
            accessibilityLabel={
              mergeRejected
                ? `Merge blocked because GitHub rejected pull request ${String(pullRequest.number)}`
                : conflicted
                  ? `Merge blocked because pull request ${String(pullRequest.number)} conflicts with ${pullRequest.baseRef ?? 'the base branch'}`
                  : failed
                    ? `Merge blocked because CI failed for pull request ${String(pullRequest.number)}`
                    : mergeabilityBlocked
                      ? `Merge blocked for pull request ${String(pullRequest.number)}`
                      : `Merge pull request ${String(pullRequest.number)}`
            }
          >
            {merging ? (
              <ActivityIndicator color={theme.colors.onPrimary} />
            ) : (
              <Text style={styles.prMergeText}>{mergeBlocked ? 'Blocked' : 'Merge'}</Text>
            )}
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** The merge affordance for a project WITHOUT a GitHub repository: there is no pull
 *  request to show status for, so this is deliberately plain — the branch it would
 *  merge, the base it merges into, and one button. Every precondition (uncommitted
 *  changes, conflicts, a running turn) is decided server-side and surfaced here as
 *  the returned message, so the button never claims a readiness it can't know. */
function LocalMergeBar({
  branch,
  base,
  onMerge,
}: {
  branch: string;
  base: string;
  onMerge: UseBranches['mergeLocally'];
}) {
  const { theme } = useUnistyles();
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);
  // A new branch (or base) is a new attempt: drop the previous rejection so a stale
  // reason can't sit under a button that would now succeed.
  useEffect(() => {
    setError(undefined);
  }, [branch, base]);

  const merge = (): void => {
    if (merging) return;
    void (async () => {
      setMerging(true);
      setError(undefined);
      const result = await onMerge();
      if (!mounted.current) return;
      setMerging(false);
      if (!result.ok) setError(result.message);
      // On success there is nothing to do client-side: onMerge refreshed the branch
      // state, and the worktree reset + agent notification happen server-side.
    })();
  };

  return (
    <View style={styles.prBarWrap}>
      <View style={styles.prBar}>
        <View style={styles.prLocalMain}>
          {/* Branch on its own line, truncated in the MIDDLE: a session branch is
              `<type>/<issue>-<long-slug>`, so the distinctive tail matters as much as
              the type prefix. The base lives on the sub-line instead of after a `→`,
              where a long branch name would truncate it away entirely. */}
          <Text style={styles.prTitle} numberOfLines={1} ellipsizeMode="middle">
            {branch}
          </Text>
          <Text style={styles.prSub} numberOfLines={1}>
            → {base} · local project
          </Text>
          {error !== undefined ? (
            <Text style={styles.prError} numberOfLines={2}>
              {error}
            </Text>
          ) : null}
        </View>
        <Pressable
          style={({ pressed }) => [
            styles.prMergeButton,
            { backgroundColor: theme.colors.tone.done },
            merging ? styles.prMergeButtonDisabled : null,
            pressed && !merging ? styles.prMergeButtonPressed : null,
          ]}
          onPress={merge}
          disabled={merging}
          accessibilityRole="button"
          accessibilityState={{ disabled: merging, busy: merging }}
          accessibilityLabel={`Merge ${branch} into ${base}`}
        >
          {merging ? (
            <ActivityIndicator color={theme.colors.onPrimary} />
          ) : (
            <Text style={styles.prMergeText}>Merge</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function InputBar({
  inputRef,
  value,
  sendNonce,
  onChangeText,
  onSend,
  canSend,
  sending,
  running,
  onStop,
  dead,
  voiceState,
  onMic,
  engineLabel,
  engineBusy,
  onEnginePress,
  bottomInset,
  onHeightChange,
  attachments,
  onAttach,
  onDropFiles,
  onDropRejected,
  onRemoveAttachment,
  onFocus,
  onBlur,
}: {
  /** Ref to the text field so a "Custom answer" chip can focus it (issue #97). */
  inputRef: RefObject<TextInput | null>;
  value: string;
  /** Increments on each send; keys the TextInput so it remounts fresh (one line)
   * after a send — a native multiline field doesn't shrink on programmatic clear. */
  sendNonce: number;
  onChangeText: (text: string) => void;
  onSend: () => void;
  canSend: boolean;
  sending: boolean;
  /** A turn is in flight (#79) — the empty-field action button becomes Stop. */
  running: boolean;
  /** Interrupt the in-flight turn (#79). */
  onStop: () => void;
  /** Session can't be resumed (worktree gone) — lock the input, no send/mic. */
  dead: boolean;
  voiceState: VoiceState;
  onMic: () => void;
  /** Current engine/model label shown on the chip in the action row. */
  engineLabel: string;
  /** An engine switch is in flight — the chip shows a spinner and is disabled. */
  engineBusy: boolean;
  /** Open the engine/model picker sheet. */
  onEnginePress: () => void;
  bottomInset: number;
  /** Reports the bar's rendered height so the scroll-to-bottom button can anchor
   * above it (it grows with multi-line text / attachment previews). */
  onHeightChange: (height: number) => void;
  /** Files picked or dropped for the next turn (not yet sent, raw base64). */
  attachments: AttachmentUpload[];
  /** Open the attach menu, docked to the paperclip (its measured screen rect). */
  onAttach: (anchor: AttachAnchor) => void;
  /** Attach Finder/Desktop files dropped anywhere on the composer. */
  onDropFiles: (files: Parameters<typeof readDroppedAttachments>[0]) => void;
  onDropRejected: (errors: string[]) => void;
  onRemoveAttachment: (index: number) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const { theme } = useUnistyles();
  const [dropActive, setDropActive] = useState(false);
  const attachBtnRef = useRef<View>(null);
  const openAttachMenu = useCallback(() => {
    const node = attachBtnRef.current;
    if (!node) return;
    node.measureInWindow((x, y, width, height) => onAttach({ x, y, width, height }));
  }, [onAttach]);
  const suppressReturnChangeRef = useRef(false);
  const returnSubmitValueRef = useRef('');
  const onComposerChangeText = useCallback(
    (next: string) => {
      if (suppressReturnChangeRef.current) {
        suppressReturnChangeRef.current = false;
        if (isSingleInsertedNewline(returnSubmitValueRef.current, next)) return;
      }
      onChangeText(next);
    },
    [onChangeText],
  );
  const onComposerKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (dead || Platform.OS !== 'ios' || !Platform.isPad || event.nativeEvent.key !== 'Enter')
        return;
      if (hardwareKeyboardDetection() !== 'hardware') return;
      suppressReturnChangeRef.current = true;
      returnSubmitValueRef.current = value;
      onSend();
    },
    [dead, onSend, value],
  );
  // Auto-grow: let the native multiline TextInput size to its content (it grows up
  // to `maxHeight`, then scrolls). We deliberately do NOT set an explicit `height`
  // from `onContentSizeChange` — on Fabric that event only fires once at mount
  // (verified on device), so a state-driven height pins the field to one line. The
  // text padding lives on the `inputCard`, not the TextInput, so the input's content
  // width is clean and lines wrap correctly.
  return (
    <DropZone
      style={[styles.inputBarWrap, { paddingBottom: bottomInset + 4 }]}
      onLayout={(e) => onHeightChange(e.nativeEvent.layout.height)}
      enabled={!dead && attachments.length < MAX_ATTACHMENTS_PER_TURN}
      maxFiles={Math.max(0, MAX_ATTACHMENTS_PER_TURN - attachments.length)}
      onFiles={onDropFiles}
      onRejected={onDropRejected}
      onActiveChange={setDropActive}
    >
      <InputActivityLine running={running && !dead} />
      {dropActive ? (
        <View pointerEvents="none" style={styles.inputDropHint}>
          <Icon name="paperclip" size={18} color={theme.colors.primary} />
          <Text style={styles.inputDropHintText}>Drop files to attach</Text>
        </View>
      ) : null}
      {attachments.length > 0 ? (
        <AttachmentPreviews attachments={attachments} onRemove={onRemoveAttachment} />
      ) : null}
      {/* Two-tier layout (like the Claude app): the text field spans the FULL width
          on top, and the action buttons sit in a row UNDERNEATH it — so the field is
          never squeezed between inline buttons. Padding lives on this card (not the
          TextInput) so the input's content-size measurement isn't skewed (RN#35234). */}
      <View style={[styles.inputCard, dropActive ? styles.inputCardDropActive : null]}>
        <TextInput
          key={sendNonce}
          ref={inputRef}
          style={styles.input}
          value={value}
          onChangeText={onComposerChangeText}
          onKeyPress={onComposerKeyPress}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={
            dead
              ? 'This session can’t be resumed'
              : voiceState === 'recording'
                ? 'Listening…'
                : 'Message this agent…'
          }
          placeholderTextColor={theme.colors.textFaint}
          editable={!dead}
          multiline
          keyboardAppearance="dark"
          accessibilityLabel="Message input"
        />
        <View style={styles.actionRow}>
          {/* Left: attach + the engine/model chip (moved here from the header, like
              the Claude app — it sits with the composer instead of the nav bar). */}
          <View style={styles.actionRowLeft}>
            <Pressable
              ref={attachBtnRef}
              style={styles.iconButton}
              onPress={openAttachMenu}
              disabled={dead}
              hitSlop={4}
              accessibilityRole="button"
              accessibilityState={{ disabled: dead }}
              accessibilityLabel="Add attachment"
            >
              <Icon
                name="paperclip"
                size={22}
                color={dead ? theme.colors.textFaint : theme.colors.textMuted}
              />
            </Pressable>
            <EngineChip
              engine={engineLabel}
              busy={engineBusy}
              onPress={onEnginePress}
              style={styles.inputEngineChip}
              textStyle={styles.inputEngineChipText}
            />
          </View>
          {/* Right: the persistent mic, then the Send/Stop slot. */}
          <View style={styles.actionRowRight}>
            {/* The mic is ALWAYS a mic (never a stop glyph) and always pressable —
                dictation is tap-to-toggle; recording gets its own active treatment.
                A separate button keeps it from ever "mutating" into Send/Stop. */}
            <MicButton voiceState={voiceState} onMic={onMic} disabled={dead} />
            {running && !canSend && !sending && !dead ? (
              // Empty field while a turn runs → Stop is available, while the top
              // activity line carries the "agent is working" cue.
              <StopButton onStop={onStop} />
            ) : (
              // Otherwise the Send button — active when there's something to send,
              // greyed when idle/empty or dead. Sending while a turn runs queues/steers
              // it, so Send keeps priority over Stop whenever the field is sendable.
              <Pressable
                style={[styles.sendButton, canSend ? null : styles.sendButtonDisabled]}
                onPress={onSend}
                disabled={!canSend}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Send message"
              >
                <Icon
                  name="arrow-up"
                  size={22}
                  color={canSend ? theme.colors.onPrimary : theme.colors.textMuted}
                />
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </DropZone>
  );
}

// Screen-space rect of the attach button, so the menu can dock to it.
type AttachAnchor = { x: number; y: number; width: number; height: number };

// The attach menu (mirrors Claude's): the composer's paperclip opens this small
// popover docked to it — a source per row (camera, photo library, or an arbitrary
// file) — instead of a full-width bottom sheet.
function AttachMenu({
  visible,
  anchor,
  onCapturePhoto,
  onPickPhotos,
  onPickFiles,
  onPickMeetingAudio,
  onPickGoogleDrive,
  onClose,
  onDismiss,
}: {
  visible: boolean;
  anchor: AttachAnchor | null;
  onCapturePhoto: () => void;
  onPickPhotos: () => void;
  onPickFiles: () => void;
  onPickMeetingAudio: () => void;
  onPickGoogleDrive: () => void;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const { theme } = useUnistyles();
  const { width: winW, height: winH } = useWindowDimensions();
  const rows = attachMenuRows({
    onCapturePhoto,
    onPickPhotos,
    onPickFiles,
    onPickMeetingAudio,
    onPickGoogleDrive,
  });
  // Dock to the button: left-aligned and clamped on-screen; placed above the button
  // (the composer sits at the bottom, so the menu opens upward).
  const MENU_WIDTH = 220;
  const GAP = 8;
  const ax = anchor?.x ?? 12;
  const ay = anchor?.y ?? winH - 120;
  const ah = anchor?.height ?? 0;
  const left = Math.max(8, Math.min(ax, winW - MENU_WIDTH - 8));
  const cardPos = ay > winH / 2 ? { bottom: winH - ay + GAP, left } : { top: ay + ah + GAP, left };
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      onDismiss={onDismiss}
    >
      <Pressable
        style={styles.menuBackdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close attachment menu"
      />
      <View style={[styles.menuCard, { width: MENU_WIDTH }, cardPos]}>
        {rows.map((row, index) =>
          'divider' in row ? (
            <View key={`divider-${String(index)}`} style={styles.menuDivider} />
          ) : (
            <Pressable
              key={row.label}
              style={({ pressed }) => [styles.menuRow, pressed ? styles.menuRowPressed : null]}
              onPress={row.onPress}
              accessibilityRole="button"
              accessibilityLabel={row.label}
            >
              <Icon name={row.icon} size={20} color={theme.colors.textMuted} />
              <Text style={styles.menuRowLabel}>{row.label}</Text>
            </Pressable>
          ),
        )}
      </View>
    </Modal>
  );
}

// A non-image attachment shown as a chip: a file glyph over its (truncated) name.
function FilePreview({ name }: { name: string }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.previewFile} accessibilityLabel={`File ${name}`}>
      <Icon name="file" size={20} color={theme.colors.textMuted} />
      <Text style={styles.previewFileName} numberOfLines={2}>
        {name}
      </Text>
    </View>
  );
}

// Resolve an attachment to a renderable URI: a stored ref (id) → the server's
// content-addressed endpoint (expo-image lazy-fetches + disk-caches it); a pending
// upload or a legacy inline attachment (data) → a data URI.
function attachmentSource(a: {
  id?: string;
  data?: string;
  mediaType: string;
}): ImageSource | undefined {
  const baseUrl = getVerityBaseUrl();
  if (a.id !== undefined && baseUrl !== null) {
    const token = getAuthToken(baseUrl);
    return {
      uri: `${baseUrl}/attachments/${a.id}`,
      ...(token !== null && token.length > 0
        ? { headers: { authorization: `Bearer ${token}` } }
        : {}),
    };
  }
  if (a.data !== undefined) return { uri: `data:${a.mediaType};base64,${a.data}` };
  return undefined;
}

/** Resolve stored images through the same native public-key-pinned downloader as
 * API requests. Passing their HTTPS URL directly to expo-image would use its own
 * URLSession and therefore reject the installer's self-signed certificate. */
function useAttachmentImageSource(a: {
  id?: string;
  data?: string;
  mediaType: string;
}): ImageSource | undefined {
  const immediate = useMemo(() => attachmentSource(a), [a.data, a.id, a.mediaType]);
  const [source, setSource] = useState<ImageSource | undefined>(
    a.id === undefined ? immediate : undefined,
  );
  useEffect(() => {
    if (a.id === undefined) {
      setSource(immediate);
      return;
    }
    const baseUrl = getVerityBaseUrl();
    const endpoint = getServerProfile()?.endpoints.find(({ url }) => url === baseUrl);
    if (baseUrl === null || endpoint?.transport !== 'direct' || endpoint.tlsPin === undefined) {
      setSource(immediate);
      return;
    }
    let active = true;
    let cachedUri: string | undefined;
    const destination = new FsFile(
      Paths.cache,
      'verity-attachments',
      `${a.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const token = getAuthToken(baseUrl);
    void downloadPinnedFile({
      url: `${baseUrl}/attachments/${a.id}`,
      destination: destination.uri,
      tlsPin: endpoint.tlsPin,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    })
      .then((uri) => {
        if (active) {
          cachedUri = uri;
          setSource({ uri });
        } else {
          try {
            new FsFile(uri).delete();
          } catch {
            // Best effort cache cleanup.
          }
        }
      })
      .catch(() => {
        if (active) setSource(undefined);
      });
    return () => {
      active = false;
      if (cachedUri) {
        try {
          new FsFile(cachedUri).delete();
        } catch {
          // Best effort cache cleanup.
        }
      }
    };
  }, [a.id, immediate]);
  return source;
}

function AttachmentImage({
  attachment,
  ...props
}: Omit<ComponentProps<typeof ExpoImage>, 'source'> & {
  attachment: { id?: string; data?: string; mediaType: string };
}) {
  const source = useAttachmentImageSource(attachment);
  return <ExpoImage {...props} source={source} />;
}

// The strip of picked-but-not-yet-sent images above the input: horizontally
// scrollable thumbnails, each with a remove (×) button (rendered via expo-image
// from a data URI — see attachmentSource).
function AttachmentPreviews({
  attachments,
  onRemove,
}: {
  attachments: AttachmentUpload[];
  onRemove: (index: number) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.previewStrip}
      keyboardShouldPersistTaps="handled"
    >
      {attachments.map((a, i) => (
        <View key={i} style={styles.previewItem}>
          {a.kind === 'file' ? (
            <FilePreview name={a.fileName} />
          ) : (
            <AttachmentImage
              attachment={a}
              style={styles.previewImage}
              contentFit="cover"
              accessibilityLabel={`Attachment ${String(i + 1)}`}
            />
          )}
          <Pressable
            style={styles.previewRemove}
            onPress={() => onRemove(i)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Remove attachment ${String(i + 1)}`}
          >
            <Text style={styles.previewRemoveGlyph}>×</Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

function InputActivityLine({ running }: { running: boolean }) {
  const [width, setWidth] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;
  const isPad = Platform.OS === 'ios' && Platform.isPad;
  const segmentWidth = 86;

  // The sweep runs across the full composer width in a fixed time. On the much
  // wider iPad composer that fixed duration reads as fast and dominant. There,
  // scale the duration with the travelled distance so the segment keeps a calm,
  // near-constant velocity regardless of width, biased a little slower. iPhone
  // keeps the original fixed 1400ms feel untouched.
  const duration = isPad
    ? Math.round(Math.min(5200, Math.max(2800, (segmentWidth + width) * 4.5)))
    : 1400;

  useEffect(() => {
    if (!running) {
      progress.stopAnimation();
      progress.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, running, duration]);

  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-segmentWidth, Math.max(width, 1)],
  });

  return (
    <View
      pointerEvents="none"
      style={styles.inputActivityTrack}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {running ? (
        <Animated.View
          style={[
            styles.inputActivitySegment,
            isPad ? { opacity: 0.55 } : null,
            { width: segmentWidth, transform: [{ translateX }] },
          ]}
        />
      ) : null}
    </View>
  );
}

// The Stop button (#79), shown in the send-slot only while a turn is in flight.
// It uses the same fixed active surface as recording dictation, so the state
// changes color but never changes the action row's footprint.
function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.stopButton, pressed ? styles.stopButtonPressed : null]}
      onPress={onStop}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Agent is working — tap to stop"
    >
      <View style={styles.activeActionFill}>
        <View style={styles.stopSquare} />
      </View>
    </Pressable>
  );
}

// The voice button: a microphone when idle, always pressable — tap to start live
// dictation, tap again to finish. While recording it shows a check glyph (not a
// stop square) so it stays distinct from the agent Stop button, since finishing
// dictation keeps the transcribed text rather than discarding it. Recording uses a
// fixed active surface matching Stop; there is no size change or pulsing effect.
function MicButton({
  voiceState,
  onMic,
  disabled,
}: {
  voiceState: VoiceState;
  onMic: () => void;
  disabled?: boolean;
}) {
  const { theme } = useUnistyles();
  const recording = voiceState === 'recording';
  return (
    <Pressable
      style={styles.iconButton}
      onPress={onMic}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled), busy: recording }}
      accessibilityLabel={recording ? 'Stop dictation' : 'Start voice dictation'}
    >
      {recording ? (
        <View style={styles.activeActionFill}>
          <Icon name="check" size={20} color={theme.colors.background} />
        </View>
      ) : (
        <Icon
          name="mic"
          size={22}
          color={disabled ? theme.colors.textFaint : theme.colors.textMuted}
        />
      )}
    </Pressable>
  );
}

/** A one-line status strip. `action` turns it into an offer rather than a statement —
 * only for states where the operator has a lever the app cannot pull for them. */
function Banner({
  tone,
  text,
  action,
}: {
  tone: 'attention' | 'danger';
  text: string;
  action?: { label: string; onPress: () => void };
}) {
  const { theme } = useUnistyles();
  const color = theme.colors.tone[tone];
  return (
    <View style={[styles.banner, { borderLeftColor: color }]}>
      <View style={styles.bannerRow}>
        <Text style={[styles.bannerText, { color }]} numberOfLines={2}>
          {text}
        </Text>
        {action ? (
          <Pressable
            onPress={action.onPress}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={action.label}
          >
            <Text style={[styles.bannerAction, { color }]}>{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function CenteredMessage({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={styles.centered}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySubtitle}>{subtitle}</Text>
    </View>
  );
}

function toolToneColor(tone: ToolCallTone): 'active' | 'done' | 'danger' {
  return tone === 'error' ? 'danger' : tone === 'done' ? 'done' : 'active';
}

function eventToneColor(tone: AgentEventTone): 'idle' | 'attention' | 'danger' {
  return tone === 'danger' ? 'danger' : tone === 'warning' ? 'attention' : 'idle';
}

/** A short header label: the model name, falling back to a truncated session id. */
function shortLabel(model: string | undefined, sessionId: string): string {
  if (model) return model;
  return sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId;
}

const styles = StyleSheet.create((theme) => ({
  flex: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
  },
  // Full-bleed cover over the transcript while restoring a saved scroll position from
  // the loaded tail; matches the screen background while measurement settles.
  restoreCover: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '600',
  },
  emptySubtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    textAlign: 'center',
    maxWidth: 320,
    lineHeight: 20 * theme.fontScale,
  },
  // Custom header (replaces the native nav bar so the branch can be plain text,
  // not an iOS-26 glass-capsule button). Flat surface, hairline bottom border.
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
  // In the two-pane (embedded) layout the right-pane header sits beside the left
  // pane's compact usage meters; a shorter title row + reduced top padding line
  // the two bars up on the same baseline. The phone header keeps the full 44px.
  headerRowEmbedded: {
    height: 38,
  },
  headerBack: {
    paddingRight: theme.spacing.xs,
  },
  // Stop button (#79): same 40px touch footprint as Send/Mic, with a smaller
  // active fill so the white state does not look visually larger than idle.
  stopButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  stopButtonPressed: {
    opacity: 0.8,
  },
  activeActionFill: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.text,
  },
  stopSquare: {
    width: 11,
    height: 11,
    borderRadius: 2.5,
    backgroundColor: theme.colors.background,
  },
  headerTitle: {
    // flex: 1 so the title spans the full width BETWEEN the two fixed-width side slots
    // (not just an equal third): now that the branch selector moved to the context row,
    // the right slot is an empty spacer, and a narrow fixed width on both sides frees
    // the middle for the session name — it truncates far later than the old 1/3 column.
    flex: 1,
    textAlign: 'center',
    marginHorizontal: theme.spacing.xs,
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  // Fixed, equal-width side slots so the title stays screen-centered while spanning the
  // middle: the back chevron sits in the left slot; an empty right slot of the same
  // width balances it (the actions now live on the context row below). Width fits the
  // 28px chevron + its padding.
  headerSide: {
    width: 40,
    flexDirection: 'row',
    alignItems: 'center',
  },
  // The branch affordance on the context row: a quiet git-branch icon + the branch
  // name, both muted + caption-sized — no box/border/background, deliberately not the
  // title/tint color — so it reads as a passive status hint, not a tappable Back-style
  // button. Bounded narrow so a long name truncates instead of stretching the row.
  headerBranchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    maxWidth: 120,
  },
  headerBranch: {
    flexShrink: 1,
    color: theme.colors.textMuted,
    fontSize: 11 * theme.fontScale,
    fontWeight: '400',
  },
  // The bookmarks jump-list opener: a quiet dog-ear + count on the context row. Same
  // muted, box-less caption language so it reads as a passive affordance. Row spacing
  // is handled by the context row's `gap`.
  headerBookmarkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  headerBookmarkCount: {
    color: theme.colors.textMuted,
    fontSize: 11 * theme.fontScale,
    fontWeight: '600',
  },
  headerLoopButton: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 5,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  headerLoopButtonText: {
    color: theme.colors.text,
    fontSize: 11 * theme.fontScale,
    fontWeight: '700',
  },
  // The context row under the title: a three-slot layout that pins the branch switcher
  // to the row's true center (stable position) with the Issue chip in the left slot and
  // the bookmarks opener in the right slot. Keeps the title row itself free of controls
  // so the session name reads full-width.
  headerMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.sm,
    paddingBottom: theme.spacing.xs,
  },
  // Equal-flex side slots flanking the centered branch switcher: the left holds the
  // Issue chip (left-aligned), the right holds the bookmarks opener (right-aligned, see
  // headerMetaSideRight). Equal flex keeps the branch centered regardless of what — if
  // anything — sits in either slot.
  headerMetaSide: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerMetaSideRight: {
    justifyContent: 'flex-end',
    gap: theme.spacing.md,
    // A little extra inset so the bookmark count doesn't hug the screen edge. Padding
    // on the slot (not a margin on the button) keeps both side slots equal-flex, so the
    // centered branch switcher stays put.
    paddingRight: theme.spacing.sm,
  },
  // The tappable engine chip (#switch-engine): the engine pill + a quiet caret/spinner
  // in a row, so the whole affordance reads as one button on the meta row.
  headerEngineChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  // A quiet pill: muted caption text on a faint surface, distinct from the title.
  headerMetaChip: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    maxHeight: '70%',
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.border,
    marginBottom: theme.spacing.sm,
  },
  filesResizeHandle: {
    alignItems: 'center',
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.sm,
    marginTop: -theme.spacing.xs,
  },
  sheetTitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: theme.spacing.sm,
  },
  // Section header within the switcher list (e.g. the #122 preview section).
  sheetSectionLabel: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.xs,
  },
  sheetList: {
    flex: 1,
  },
  sheetError: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    paddingVertical: theme.spacing.sm,
  },
  sheetEmpty: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    paddingVertical: theme.spacing.md,
  },
  sheetLoading: {
    paddingVertical: theme.spacing.lg,
    alignItems: 'center',
  },
  filesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  filesTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  filesPath: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
  },
  // The drop target wraps the list rather than the whole sheet: a drop onto the
  // preview or the header would have no directory to land in.
  filesDropZone: {
    flex: 1,
  },
  filesList: {
    flex: 1,
  },
  filesDropHint: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.primary,
    backgroundColor: `${theme.colors.primary}14`,
  },
  filesDropHintText: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  fileRow: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.xs,
    borderRadius: theme.radius.md,
  },
  fileMain: {
    flex: 1,
    minWidth: 0,
  },
  fileName: {
    lineHeight: 22 * theme.fontScale,
  },
  fileMeta: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    marginTop: 1,
  },
  fileDownload: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.md,
  },
  filesPreviewWrap: {
    flex: 1,
    minHeight: 280,
  },
  filesPreviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingBottom: theme.spacing.sm,
  },
  filesPreviewTitle: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  filesPreview: {
    flex: 1,
  },
  filesPreviewBody: {
    paddingVertical: theme.spacing.md,
  },
  filesPreviewText: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.xs,
    borderRadius: theme.radius.md,
  },
  sheetRowPressed: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  moreModelsRow: {
    marginTop: theme.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  sheetRowDisabled: {
    opacity: 0.55,
  },
  sheetDot: {
    width: 8,
    height: 8,
    borderRadius: theme.radius.pill,
  },
  sheetRowLabel: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.md,
  },
  sheetCurrent: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    textTransform: 'uppercase',
  },
  sheetLimited: {
    color: theme.colors.tone.attention,
    fontSize: theme.text.xs,
    textTransform: 'uppercase',
  },
  // A bookmark jump-row: the tappable preview (dog-ear + up-to-2 lines of the passage)
  // plus a trailing remove (×) target, so a jump and a delete never share one hit area.
  bookmarkRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  bookmarkRowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.xs,
    borderRadius: theme.radius.md,
  },
  bookmarkPreview: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.md,
    lineHeight: 20 * theme.fontScale,
  },
  bookmarkRemove: {
    padding: theme.spacing.sm,
    borderRadius: theme.radius.sm,
  },
  // The "New branch" row: a name input + a Create button, separated from the list.
  sheetNew: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    marginTop: theme.spacing.xs,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  newBranchInput: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  newBranchButton: {
    minWidth: 64,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
  },
  newBranchButtonDisabled: {
    opacity: 0.4,
  },
  newBranchButtonText: {
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  // The inline dirty-worktree prompt: a message + commit/stash/cancel buttons,
  // shown in place of the new-branch row after a 409 "uncommitted changes".
  dirtyPrompt: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    marginTop: theme.spacing.xs,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  dirtyText: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  dirtyButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
  dirtyButton: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  dirtyButtonText: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  queuedWrap: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  prBarWrap: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
  },
  prBar: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
  },
  prOpenTarget: {
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingLeft: theme.spacing.md,
    paddingRight: theme.spacing.sm,
  },
  prBarPressed: {
    backgroundColor: theme.colors.border,
  },
  prStatusDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  prMain: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  /** The local merge bar has no status dot and nothing to open, so it carries the
   *  padding `prOpenTarget` gives the PR row itself — without it the branch name sits
   *  flush against the bar's border on one side and the Merge button on the other. */
  prLocalMain: {
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    gap: 1,
    justifyContent: 'center',
    paddingLeft: theme.spacing.md,
    paddingRight: theme.spacing.sm,
  },
  prTitle: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  prSub: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  prError: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  prMergeButton: {
    width: 78,
    height: 36,
    marginRight: theme.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
  },
  prMergeButtonDisabled: {
    opacity: 0.45,
  },
  prMergeButtonPressed: {
    opacity: 0.8,
  },
  prMergeText: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  prDismissButton: {
    width: 36,
    height: 36,
    marginRight: theme.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  prDismissButtonPressed: {
    opacity: 0.55,
  },
  prDismissText: {
    color: theme.colors.textFaint,
    fontSize: 22 * theme.fontScale,
    lineHeight: 24 * theme.fontScale,
    fontWeight: '400',
  },
  queuedBubbleRow: {
    alignItems: 'flex-end',
  },
  queuedBubble: {
    maxWidth: '78%',
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderStyle: 'dashed',
    paddingHorizontal: theme.spacing.md,
    // Padding matches `userBubble` — same bubble shape, just the not-yet-sent
    // state (#136). No `alignItems: flex-start` here: this bubble only renders
    // muted `<Text>` (the message clamped to `numberOfLines={3}` plus the waiting
    // tag), never an image/UITextView, so it can't hit the mis-measure that fix
    // addresses.
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.lg,
    gap: 2,
  },
  queuedText: {
    color: theme.colors.textMuted,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
  },
  queuedTag: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    fontWeight: '600',
    textAlign: 'right',
  },
  banner: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surfaceAlt,
    borderLeftWidth: 3,
  },
  bannerText: {
    fontSize: theme.text.xs,
    // Takes the row's slack so long copy wraps to its two lines instead of pushing
    // the action off the edge.
    flex: 1,
  },
  bannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  bannerAction: {
    fontSize: theme.text.xs,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  listContent: {
    padding: theme.spacing.lg,
    gap: theme.spacing.lg,
  },
  // The transcript is stored newest-first and flipped: history then APPENDS at the
  // data end, behind the viewport, instead of being inserted in front of the reader.
  // FlashList 2 has no `inverted` prop, so the flip is a transform on the list plus a
  // counter-transform on every row (and on the footer spinner).
  invertedList: {
    transform: [{ scaleY: -1 }],
  },
  invertedItem: {
    transform: [{ scaleY: -1 }],
  },
  searchTermHighlight: {
    color: theme.colors.text,
    backgroundColor: `${theme.colors.accent}66`,
    borderRadius: 3,
  },
  // Spinner at the top of the transcript while older history is loading (scroll-up).
  olderSpinner: {
    paddingVertical: theme.spacing.md,
    alignItems: 'center',
  },
  olderSpinnerHidden: {
    opacity: 0,
  },
  turnTimestamp: {
    // A subtle turn marker above the operator's bubble — small, faint, and
    // right-aligned to sit with the user turn it dates. Reads as orientation, not
    // content, so it uses the faintest text token at the xs scale.
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    textAlign: 'right',
    marginBottom: theme.spacing.xs,
    marginHorizontal: theme.spacing.sm,
  },
  userRow: {
    // A real flex row (not a column with cross-axis end-alignment): this gives
    // the bubble a determinate available width to shrink into, which the native
    // UITextView (iOS, new arch) needs to *wrap* long text rather than measure a
    // single intrinsic line and let the bubble's maxWidth merely clip it.
    // (`queuedBubbleRow` deliberately stays a column — its pending-send twin
    // renders `<Text numberOfLines={3}>`, which wraps natively under maxWidth and
    // never hits this UITextView quirk, so it needs no row treatment.)
    flexDirection: 'row',
    justifyContent: 'flex-end',
    // Extra breathing room above/below the user turn, on top of the list's `lg`
    // row gap, so the operator's bubble doesn't crowd the agent text it sits
    // between (gap and margin sum under flex — no collapsing). Targeted to the
    // user row rather than bumping `listContent.gap`, which would also spread
    // agent↔agent blocks and tool cards.
    marginVertical: theme.spacing.sm,
  },
  userBubble: {
    // A subtle raised surface (one step above true black) rather than a loud
    // saturated fill — matches the Claude app: the user turn reads as "mine"
    // via right-alignment + a quiet panel, not a bright color block.
    maxWidth: '78%',
    // Shrink within the row so a long message wraps inside maxWidth instead of
    // being clipped: flexShrink lets the bubble fall below its intrinsic
    // (single-line) content width down to maxWidth's share of the row. Short
    // messages still hug their content (flex-basis auto). Orthogonal to the
    // `alignItems: 'flex-start'` below (#136), which governs only cross-axis
    // sizing of the bubble's children, not the bubble's own width.
    flexShrink: 1,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    // Children size to their own content rather than stretching to the bubble's
    // widest child (#136). Without this, an image attachment forces the bubble to
    // ~140px wide and a short caption stretches to that frame. (The caption is now
    // a native <Text>, which can't mis-measure its height the way the old
    // `UITextView` did — but keeping children content-sized still avoids a short
    // caption visually spanning the full image width.) Text is left-aligned, so
    // `alignItems` is visually inert for the text-only case.
    alignItems: 'flex-start',
    paddingHorizontal: theme.spacing.md,
    // `md` (not `sm`) so the text doesn't hug the top/bottom border — `sm` with
    // a 22px line-height read as cramped on-device (#136). Kept in sync with
    // `queuedBubble`, the pending-send twin of this bubble.
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.lg,
  },
  // A message that hasn't been confirmed by the server yet (local echo): the same
  // bubble, marked as not-yet-landed with the dashed outline the "waiting to send"
  // bubble already uses, so the two pending states read as one visual family.
  userBubblePending: {
    borderStyle: 'dashed',
    opacity: 0.75,
  },
  userPendingTag: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    fontWeight: '600',
    alignSelf: 'flex-end',
    marginTop: 2,
  },
  userText: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
    fontWeight: '400',
  },
  // Attached images in a sent user turn: a wrapping row of rounded thumbnails,
  // sized to sit comfortably in the bubble. A trailing margin separates them from
  // the caption text below (when present).
  userImages: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  userImage: {
    width: 140,
    height: 140,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
  },
  agentBlock: {
    gap: theme.spacing.sm,
    // A transparent frame is always reserved so revealing the copy outline can't
    // shift the prose. Horizontally the padding is offset by a negative margin to
    // keep the text aligned with the other rows (the outline just bleeds into the
    // screen-edge gutter). Vertically we DON'T offset it: the padding stays as real
    // breathing room so the dashed line sits clear of this message's own text and
    // of the neighbouring rows above/below, instead of grazing them.
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    marginHorizontal: -theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'transparent',
  },
  // While the tap-revealed copy chip is showing, a quiet dashed outline (no fill)
  // marks exactly which region the button will copy — subtle enough not to fight
  // the prose.
  agentBlockActive: {
    borderColor: theme.colors.border,
  },
  // The tap-revealed action row (visually Copy + Bookmark): same corner-pinned, icon-only
  // affordance as the code card's badge, but bottom-right so it clears the prose's
  // first line. Absolutely positioned so revealing it never reflows the message (no
  // tap-jump).
  msgActions: {
    position: 'absolute',
    bottom: theme.spacing.xs,
    right: theme.spacing.xs,
    flexDirection: 'row-reverse',
    gap: theme.spacing.xs,
  },
  // Each action chip: solid surface + border so it reads over the prose it overlaps.
  msgActionBtn: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  // The persistent dog-ear on a bookmarked message: pinned top-right, quiet, and
  // non-interactive — a scanning cue while scrolling, not a control.
  msgBookmarkFlag: {
    position: 'absolute',
    top: theme.spacing.xs,
    right: theme.spacing.xs,
  },
  agentText: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
    fontWeight: '400',
  },
  localMeetingUploadStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    minHeight: 40,
    paddingVertical: theme.spacing.xs,
  },
  localMeetingUploadIndicator: {
    width: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  localMeetingUploadStatusText: {
    flex: 1,
    minWidth: 0,
  },
  localMeetingUploadTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    lineHeight: 20 * theme.fontScale,
    fontWeight: '500',
  },
  localMeetingUploadFileName: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 18 * theme.fontScale,
  },
  mdHeading: {
    fontSize: theme.text.lg,
    fontWeight: '700',
    marginTop: theme.spacing.xs,
  },
  mdSectionHeading: {
    fontWeight: '700',
    marginTop: theme.spacing.sm,
  },
  mdListRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    paddingLeft: theme.spacing.xs,
  },
  mdBullet: {
    color: theme.colors.textMuted,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
  },
  // Native selectable Text wraps reliably in normal column flow. Inside list
  // rows, give it an explicit flex slot so it can shrink before wrapping instead
  // of measuring as one clipped line on iOS.
  mdText: {
    width: '100%',
    flexShrink: 1,
  },
  mdTextSlot: {
    flex: 1,
    minWidth: 0,
  },
  mdGap: {
    height: theme.spacing.sm,
  },
  mdBold: {
    fontWeight: '700',
  },
  mdCode: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: theme.text.sm,
  },
  mdLink: {
    textDecorationLine: 'underline',
  },
  mdReference: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: theme.text.sm,
  },
  table: {
    marginVertical: theme.spacing.xs,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  tableRowLast: {
    borderBottomWidth: 0,
  },
  tableHeaderRow: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  tableCell: {
    flex: 1,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  tableHeaderText: {
    fontWeight: '700',
    color: theme.colors.text,
  },
  thinkingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  thinkingLabel: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  thinkingText: {
    color: theme.colors.textMuted,
    fontStyle: 'italic',
  },
  codeBlock: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  codeLang: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  codeText: {
    color: theme.colors.text,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  // Copy affordance (shared by code cards and the tap-revealed message action).
  copyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: theme.radius.sm,
  },
  copyBtnPressed: {
    opacity: 0.6,
  },
  copyLabel: {
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  // Pinned to the code card's top-right corner, on a solid chip so it reads over
  // the monospace text it overlaps.
  codeCopyBtn: {
    position: 'absolute',
    top: theme.spacing.xs,
    right: theme.spacing.xs,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  // A tool call reads as one quiet line (dot · headline · chevron), no card frame
  // — the Claude-Code "Ausgeführt …" style. The box (border/surface/padding) made
  // a run of tools dominate the transcript; here they recede behind the agent's
  // prose.
  toolCard: {
    paddingVertical: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  toolHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  toolDot: {
    width: 7,
    height: 7,
    borderRadius: theme.radius.pill,
  },
  toolHeadline: {
    flex: 1,
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
  },
  // Collapsed multi-tool group count — a quiet "·N" suffix, not a filled badge.
  toolGroupCountText: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  // The expanded run: individual tool lines, indented under the group line.
  toolGroupList: {
    marginTop: 2,
    marginLeft: theme.spacing.md,
  },
  // The "⎿ Done · N tools" summary line under a delegated-agent card.
  delegatedSummary: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    marginTop: 2,
    marginLeft: theme.spacing.md,
  },
  // The revealed sub-agent subtree, indented under its dispatch card.
  delegatedSubtree: {
    gap: theme.spacing.md,
    marginTop: theme.spacing.sm,
    marginLeft: theme.spacing.md,
    paddingLeft: theme.spacing.sm,
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
  },
  // Inline images from a tool result (#115), indented under the headline.
  toolImages: {
    gap: theme.spacing.xs,
    marginTop: theme.spacing.xs,
    marginLeft: theme.spacing.lg,
  },
  toolImage: {
    width: '100%',
    height: 220,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  localLinkImages: {
    gap: theme.spacing.xs,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  localLinkImage: {
    width: '100%',
    height: 220,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  // Expanded input/output, indented under the headline (no card frame to divide).
  toolDetail: {
    gap: theme.spacing.xs,
    marginTop: theme.spacing.xs,
    marginLeft: theme.spacing.lg,
  },
  toolCommand: {
    color: theme.colors.text,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: theme.text.xs,
    lineHeight: 18 * theme.fontScale,
  },
  toolPreview: {
    color: theme.colors.textFaint,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: theme.text.xs,
    lineHeight: 18 * theme.fontScale,
  },
  toolSkillBody: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    lineHeight: 18 * theme.fontScale,
  },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  eventRowActionable: {
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  eventLabel: {
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  eventDetail: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
  },
  eventAction: {
    alignSelf: 'flex-start',
    marginTop: theme.spacing.xs,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.accent,
  },
  eventActionLabel: {
    color: theme.colors.background,
    fontWeight: '700',
  },
  eventActionPressed: {
    opacity: 0.72,
  },
  // The whole bottom bar: an optional attachment-preview strip stacked above the
  // input row. The surface + top border live here so the strip and row read as one
  // bar; `paddingBottom` is set inline from the safe-area inset.
  inputBarWrap: {
    position: 'relative',
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  inputDropHint: {
    // Just a centered "Drop files to attach" label — no tinted bar or blue
    // underline above the field, so the drop-active accent stays on the text
    // field itself (see inputCardDropActive) rather than as a separate line.
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
  },
  inputDropHintText: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  inputActivityTrack: {
    position: 'absolute',
    top: -1,
    left: 0,
    right: 0,
    height: 2,
    overflow: 'hidden',
  },
  inputActivitySegment: {
    height: 2,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
    opacity: 0.8,
  },
  // Quick-Action chips (issue #97).
  choicesRow: {
    paddingVertical: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  choicesQuestion: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  agentLoopProposal: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    marginVertical: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  agentLoopProposalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  agentLoopProposalTitle: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  agentLoopProposalState: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  agentLoopProposalSchedule: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
  },
  agentLoopProposalScript: {
    maxHeight: 220,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  agentLoopProposalScriptText: {
    color: theme.colors.text,
    fontSize: theme.text.xs,
    lineHeight: 18 * theme.fontScale,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  agentLoopProposalHint: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 18 * theme.fontScale,
  },
  agentLoopProposalError: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.xs,
  },
  agentLoopProposalConfirm: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
  },
  agentLoopProposalConfirmText: {
    color: theme.colors.background,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  choicesChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  // The agent's default pick: outlined in the primary accent so it stands out.
  chipRecommended: {
    borderColor: theme.colors.primary,
  },
  // A toggled multi-select option: filled to read as "on".
  chipSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primary,
  },
  chipDisabled: {
    opacity: 0.5,
  },
  chipPressed: {
    backgroundColor: theme.colors.border,
  },
  chipLabel: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '500',
  },
  chipLabelRecommended: {
    color: theme.colors.primary,
    fontWeight: '600',
  },
  chipLabelSelected: {
    color: theme.colors.onPrimary,
  },
  chipStar: {
    color: theme.colors.primary,
    fontSize: theme.text.xs,
  },
  // "Custom answer": a dashed-outline chip that opens the keyboard, visually set
  // apart from the agent's concrete options.
  chipCustom: {
    borderStyle: 'dashed',
    backgroundColor: 'transparent',
  },
  chipCustomLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
  },
  choicesSend: {
    alignSelf: 'flex-start',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
  },
  choicesSendDisabled: {
    opacity: 0.5,
  },
  choicesSendLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  // The live per-tool permission prompt (#149): a bordered card just above the input,
  // attention-toned so it reads as "the agent is paused, waiting on your decision".
  permissionPrompt: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.tone.attention,
    backgroundColor: theme.colors.surfaceAlt,
    gap: theme.spacing.sm,
  },
  permissionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  permissionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  permissionTitle: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  // The risk-class tag (#149): a quiet attention-toned chip next to the title.
  permissionRisk: {
    color: theme.colors.tone.attention,
    fontSize: theme.text.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  permissionSubtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  permissionDetails: {
    maxHeight: 220,
  },
  // Taller than `permissionDetails`: a handoff briefing is prose meant to be read before
  // it is approved, not a request body being spot-checked.
  permissionBriefing: {
    maxHeight: 320,
  },
  permissionButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
  },
  permissionButton: {
    minWidth: 84,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
  },
  // Deny: an outlined (danger-toned) button — destructive, so not filled.
  permissionDeny: {
    borderColor: theme.colors.tone.danger,
    backgroundColor: 'transparent',
  },
  // Allow: the filled primary action.
  permissionAllow: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primary,
  },
  permissionButtonDisabled: {
    opacity: 0.5,
  },
  permissionButtonPressed: {
    opacity: 0.7,
  },
  permissionButtonLabel: {
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  permissionAllowLabel: {
    color: theme.colors.onPrimary,
  },
  // Brokered-HTTP card (ADR 0011): readable request summary + plain-language
  // explanation instead of a raw JSON dump.
  permissionHttpSummary: {
    gap: theme.spacing.xs,
  },
  permissionHttpMeta: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
  },
  // Scoped allows (ADR 0011 D2): a quiet outlined secondary row under Deny/Allow.
  permissionScopeRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  permissionScopeButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: 'transparent',
  },
  permissionScopeLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  // The rounded input card holding the full-width text field stacked above the
  // action row (two-tier, like the Claude app). Padding lives here, not on the
  // TextInput (RN#35234 content-size skew).
  inputCard: {
    marginHorizontal: theme.spacing.md,
    marginTop: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.xs,
    // Breathing room between the text field and the button row underneath.
    gap: 10,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  inputCardDropActive: {
    borderColor: theme.colors.primary,
    backgroundColor: `${theme.colors.primary}14`,
  },
  // The button row under the text field: attach + engine chip on the left,
  // mic + Send/Stop right.
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  actionRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    // Let the chip truncate rather than shove the right-hand buttons off-screen.
    flexShrink: 1,
  },
  actionRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  // The engine/model chip as it appears in the input bar's action row: a pill that
  // stands off the input card (which is surfaceAlt) using the same surface + border
  // as the neighbouring icon buttons, sized to sit comfortably beside them.
  inputEngineChip: {
    // Match the neighbouring icon/send buttons (40) so the action row aligns.
    height: 40,
    paddingLeft: theme.spacing.sm,
    paddingRight: theme.spacing.xs,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    flexShrink: 1,
  },
  inputEngineChipText: {
    // Drop the header pill's own surface/border — the chip container supplies them here.
    backgroundColor: 'transparent',
    borderWidth: 0,
    paddingHorizontal: 0,
  },
  // Horizontal strip of picked-but-unsent image thumbnails above the input row.
  previewStrip: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
  },
  previewItem: {
    width: 64,
    height: 64,
  },
  previewImage: {
    width: 64,
    height: 64,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  // A file attachment's chip: same 64×64 footprint as a thumbnail, icon over name.
  previewFile: {
    width: 64,
    height: 64,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    padding: 4,
  },
  previewFileName: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    textAlign: 'center',
  },
  // Compact attach popover docked to the paperclip (Claude-style), not a bottom sheet.
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.15)' },
  menuCard: {
    position: 'absolute',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing.xs,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
  },
  menuRowPressed: { backgroundColor: theme.colors.surfaceAlt },
  menuRowLabel: { color: theme.colors.text, fontSize: theme.text.md },
  menuDivider: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing.xs,
    marginHorizontal: theme.spacing.sm,
  },
  // The round × badge pinned to a thumbnail's top-right corner.
  previewRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: theme.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  previewRemoveGlyph: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    lineHeight: 16 * theme.fontScale,
    fontWeight: '700',
  },
  // Right-edge message-nav stack (prev/next my message + to-bottom). `top: '50%'` +
  // an inline translateY (NAV_STACK_HALF + inputBarHeight/2) centre it in the VISIBLE
  // transcript. Wide gap so the three targets read (and tap) as distinct.
  msgNav: {
    position: 'absolute',
    right: 6,
    top: '50%',
    alignItems: 'center',
    gap: 8,
    // Translucent backdrop + hairline border + soft glow so the stack lifts off the
    // transcript text while visible. The whole thing rides the Animated opacity, so it
    // fades away with the icons at rest (no persistent overlay, no reserved width).
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.scrim,
    borderWidth: 1,
    borderColor: theme.colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  msgNavBtn: {
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  input: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    lineHeight: 21 * theme.fontScale,
    // One comfortable line tall when empty; native multiline grows up to maxHeight
    // (~8 lines) then scrolls. No explicit height (RN#35234) and full width (stretches
    // in the column card), so the field is no longer squeezed by inline buttons.
    minHeight: 24,
    maxHeight: 21 * 8,
    padding: 0,
    paddingTop: 2,
    textAlignVertical: 'top',
  },
  // Action-slot + attach buttons share one clear circular footprint; the visible
  // button matches its tap target so edge taps are less surprising.
  iconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  sendButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
  },
  sendButtonDisabled: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
}));
