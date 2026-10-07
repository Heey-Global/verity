import { shouldSendWebKey } from '../../lib/composerWebKey';
import { subscribeLiveRefresh } from '../../lib/liveConnection';
import { openTasksPanel } from '../../lib/taskPanelEvents';
import { ActionMenu } from '../../components/ActionMenu';
import { FileTextEditor } from '../../components/files/FileTextEditor';
import { FileContentPreview } from '../../components/files/FileContentPreview';
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
  type Attachment,
  type AutomationProposalMessage,
  type AttachmentUpload,
  type BranchSwitchRequest,
  type DriveFile,
  type SessionAutomation,
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
  type SessionFileContent,
  type SessionFileRoot,
  type SessionGoogleWorkspaceFile,
  type SessionPlanning,
  type ToolCallMessage,
  type UserTextMessage,
  agentEventDescriptor,
  briefingExtent,
  engineLabel,
  groupModelsByEngine,
  formatChoiceAnswer,
  planProposal,
  planProposalRevision,
  planProposalDisplay,
  planningToolName,
  END_PLANNING_TOOL,
  START_PLANNING_TOOL,
  freezeTranscriptTail,
  frozenTranscriptRows,
  gmailPreviewHtml,
  gmailSendSummary,
  calendarChangeSummary,
  githubRefUrl,
  isPullRequestCheckingMergeability,
  isPullRequestConflicted,
  isSessionImageFilePath,
  groupRows,
  reconcileTranscriptRows,
  withPlanningSnapshot,
  pullRequestStatusText,
  markdownSectionTitle,
  modelRateLimited,
  modelDisplayName,
  orderModels,
  partitionModels,
  publishSessionAutomationMutation,
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
  knowledgePublishSummary,
  KNOWLEDGE_PUBLISH_EXPLANATION,
  printableFileHtml,
  sessionHandoffCaveats,
  sessionHandoffSummary,
  sessionHandoffTitle,
  sessionProgressSummary,
  recentSessionMessagesSummary,
  spellOutBidiControls,
  trustedCliInjectionSummary,
  trustedCliSecretLabel,
  trustedCliSummary,
  splitSearchHighlights,
  sessionFilePathFromLocalLink,
  sessionFileTargetFromLocalLink,
  splitRichText,
  toolCallView,
  planHeadline,
  type PlanView,
  trustedCliUnlockCandidate,
  type AgentEventTone,
  type FrozenTranscriptTail,
  type GmailSessionConnection,
  type CalendarSessionConnection,
  type ContactsSessionConnection,
  type RestoredQueuedTurn,
  type Row,
  type ToolCallTone,
  type ToolImage,
  type LocalPreviewShare,
  type ManagedDevServer,
} from '@verity/mobile';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import * as Haptics from 'expo-haptics';
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
  type TextStyle,
  useWindowDimensions,
  View,
  type ViewStyle,
  type ViewToken,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { openLocalPreview } from '../../components/project/previewAccess';
import { openFailureAlert, RunningServerCard } from '../../components/project/RunningServerCard';
import { StaticPreviewSheet } from '../../components/project/StaticPreviewSheet';
import { SessionFolderRow } from '../../components/SessionFolderRow';
import { type FileAction, FileActionMenu } from '../../components/files/FileActionMenu';
import { FileBreadcrumb } from '../../components/files/FileBreadcrumb';
import { FileNameDialog } from '../../components/files/FileNameDialog';
import {
  FileSheetHeader,
  HeaderIconButton,
  HeaderTextButton,
} from '../../components/files/FileSheetHeader';
import { usePermissionHaptic } from '../../components/usePermissionHaptic';
import * as Clipboard from 'expo-clipboard';
import { Directory as FsDirectory, File as FsFile, Paths } from 'expo-file-system';
// expo-image (not RN Image) for attachments: it lazily fetches + disk-caches by
// URL, so a referenced image loads only when its row is on screen and is cached
// across reopens — the backlog of images never loads up front.
import { Image as ExpoImage, type ImageSource } from 'expo-image';
import { UITextView } from 'react-native-uitextview';
import { KeyboardAvoidingView, KeyboardStickyView } from 'react-native-keyboard-controller';
import Reanimated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../../components/Icon';
import {
  AutomationBar,
  AutomationProposalCard,
  AutomationSheet,
  SessionStarterCard,
  type AutomationProposalState,
} from '../../components/SessionAutomation';
import { DragSource } from '../../components/DragSource';
import { DropZone } from '../../components/DropZone';
import { ImageLightbox } from '../../components/ImageLightbox';
import { PromptComposerInput } from '../../components/PromptComposerInput';
import { WorkingDot } from '../../components/WorkingDot';
import {
  hardwareKeyboardDetection,
  isExternalKeyboardHeight,
  shouldPreserveComposerFocus,
  shouldSubmitOnReturn,
} from '../../hardwareKeyboard';
import { type Bookmarks, useBookmarks } from '../../hooks/useBookmarks';
import { type UseBranches, useBranches } from '../../hooks/useBranches';
import { shouldShowPullRequest } from '../../lib/pullRequestVisibility';
import { useModels } from '../../hooks/useModels';
import { useAttachmentMenuAnchor } from '../../hooks/useAttachmentMenuAnchor';
import { useSessionKeyboardAvoidance } from '../../hooks/useSessionKeyboardAvoidance';
import { useTranscriptNavigation } from '../../hooks/useTranscriptNavigation';
import { TranscriptRow } from '../../components/TranscriptRow';
import { isProjectSessionModel } from '../../lib/projectSessionModels';
import { isSameAutomation } from '../../lib/automationText';
import { useSession } from '../../hooks/useSession';
import { type VoiceState, useVoiceInput } from '../../hooks/useVoiceInput';
import { type AttachAnchor, attachMenuRows } from '../../lib/attachMenu';
import {
  type DroppedFileDescriptor,
  captureImage,
  pickMeetingAudioAsset,
  droppedFileData,
  pickSessionFiles,
  releaseDroppedFile,
  readMeetingAudioUpload,
  pickFiles,
  pickImagesFromLibrary,
  readDroppedAttachments,
} from '../../lib/attachments';
import { getAuthToken } from '../../lib/authToken';
import { createVerityClient, getVerityBaseUrl } from '../../lib/client';
import { isDemoMode } from '../../lib/demoMode';
import { downloadPinnedFile } from '../../lib/pinnedTransport';
import { getServerProfile } from '../../lib/serverProfile';
import { subscribeVoiceShortcut } from '../../lib/voiceShortcut';
import { MEETING_AUDIO_ENABLED } from '../../lib/featureFlags';
import { ensureGoogleWorkspaceAccess } from '../../lib/googleDrive';
import {
  hasConnectedGoogleAccount,
  getProjectGoogleAccess,
  connectSessionGoogleService,
  disconnectSessionGoogleService,
  type GoogleService,
} from '../../lib/sessionGoogleAccess';
import {
  type ClickModifiers,
  type DragFileItem,
  dragItemsForRow,
  fileNameFromPath,
  isSelectableFile,
  isTextPreviewCandidate,
  mimeTypeForFile,
  retainVisibleSelection,
  selectionForModifierClick,
  selectionSummary,
  toggleFileSelection,
} from '../../lib/fileSelection';
import {
  breadcrumbSegments,
  cacheDirectoryName,
  fileEntryMeta,
  fileIcon,
  loadPrintModule,
  loadSharingModule,
  parentPath,
  pdfFileName,
  renameProblem,
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
  shouldContinueUserJump,
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
  navigationRowIndices,
  messageSeq,
  type ScrollAnchor,
} from '../../lib/transcriptAnchor';
import { settleTranscriptJump } from '../../lib/transcriptJump';
import { formatResetDisplay, formatTurnTimestamp } from '../../lib/time';

const AnimatedKeyboardAvoidingView = Reanimated.createAnimatedComponent(KeyboardAvoidingView);

// In-memory per-session draft cache: keeps the typed/dictated draft when the
// operator leaves a session and returns (within the app's lifetime), so input work
// isn't lost on navigation. Module-scoped so it survives the screen unmount.
// (Cross-app-restart persistence would need AsyncStorage — a follow-up.)
const draftStore = new Map<string, string>();

const MAX_ATTACHMENTS_PER_TURN = 8;
// Points at 72 PPI (~18 mm). iOS takes page margins only from this option; the
// document's own `@page` rule covers Android.
const PRINT_MARGINS = { top: 50, bottom: 50, left: 50, right: 50 };
// A history page is an append behind the viewport, so nothing has to be corrected
// afterwards — but FlashList still measures the new rows over the following frames.
// Treat the page as "settling" until then so an automatic follow-up load cannot stack
// another measurement pass onto a list that is still moving.
const HISTORY_APPEND_SETTLE_MS = 200;
const HISTORY_APPEND_SETTLE_FALLBACK_MS = 2000;
/** Upper bound on the jump cover; the passes themselves finish in about two seconds. */
const JUMP_FAIL_SAFE_MS = 4000;

async function waitForSessionIdle(client: VerityClient, sessionId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let reading = false;
    let again = false;
    let detach = () => {};
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            'The session is still busy. The meeting prompt will retry when this chat opens again.',
          ),
        ),
      120_000,
    );
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      detach();
      if (error) reject(error);
      else resolve();
    };
    const read = async (): Promise<void> => {
      if (finished) return;
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        const activity = await client.getActivity(sessionId);
        if (!activity.busy && activity.queued.length === 0) finish();
      } catch (error) {
        finish(error);
      } finally {
        reading = false;
        if (again && !finished) {
          again = false;
          void read();
        }
      }
    };
    detach = subscribeLiveRefresh(
      client,
      read,
      (path) => path === `/sessions/${encodeURIComponent(sessionId)}/activity`,
      [{ path: `/sessions/${encodeURIComponent(sessionId)}/activity` }],
    );
    void read();
  });
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

// Half-height of the 3-item message-nav stack, incl. the backdrop's vertical padding:
// 3 btns·(icon 22 + 6·2) + 2 gaps·8 + container 6·2 = 130; half = 65. Used to
// translateY the stack onto the true vertical centre of the visible transcript. Keep
// in sync with styles.msgNav(Btn).
const NAV_STACK_HALF = 65;
const SPLIT_SCREEN_MIN_WIDTH = 900;
const RETRY_TRUSTED_CLI_AFTER_UNLOCK =
  'Retry only the trusted CLI call immediately preceding this unlock. The broker response confirmed that the command was not started.';

export default function SessionScreen() {
  const { id, targetMessageId, targetSearchQuery, retrySecret } = useLocalSearchParams<{
    id: string;
    targetMessageId?: string;
    targetSearchQuery?: string;
    retrySecret?: string;
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
        retrySecret={retrySecret}
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
      retrySecret={retrySecret}
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
  retrySecret,
}: {
  id: string;
  targetMessageId?: string;
  targetSearchQuery?: string;
  retrySecret?: string;
}) {
  useFocusEffect(
    useCallback(() => {
      router.dismissTo({
        pathname: '/',
        params: {
          selected: id,
          ...(targetMessageId ? { targetMessageId } : {}),
          ...(targetSearchQuery ? { targetSearchQuery } : {}),
          ...(retrySecret ? { retrySecret } : {}),
        },
      });
    }, [id, retrySecret, targetMessageId, targetSearchQuery]),
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
  /** Save a proposed automation after the operator confirms it. */
  confirmAutomation: (proposal: AutomationProposalMessage['proposal']) => Promise<void>;
  /** The automation this session has now, so a proposal card knows whether it
   * is already active or would replace another one. */
  automation: SessionAutomation | null;
  automationReady: boolean;
  /** Only the newest proposal can be confirmed; older cards are superseded. */
  latestAutomationProposalId: string | null;
  /** Planning mode, for the plan cards' button and status line. */
  planning: SessionPlanning | undefined;
  planningRevision: number | undefined;
  planningPlan: string | null | undefined;
  decidingPlanning: boolean;
  /** The plan card's "Implement plan": the tap itself is the operator's approval. */
  implementPlan: (revision?: number) => void;
}

const SessionActionsContext = createContext<SessionActions | null>(null);

// Bookmark state (#bookmarks), provided once by `SessionChat` so a deep transcript
// row (`<AgentMarkdown>`) can toggle its own message's bookmark without threading a
// callback through `renderRow`. Null outside a provider — the affordance renders
// nothing rather than crashing (never happens in practice; the FlashList is always
// wrapped).
const BookmarksContext = createContext<Bookmarks | null>(null);
// Knowledge — Project and Global alike — has one symbol across the app, so the
// message "…" sheet, the Explorer tabs and its breadcrumb all read as the same
// thing; the labels tell the two scopes apart.
const KNOWLEDGE_ICON: IconName = 'book-open';
// Where the native drag zone owns the long press; see the row's onLongPress.
const longPressDrags = Platform.OS === 'ios' && Platform.isPad;

const FILE_ROOT_ICON: Record<SessionFileRoot, IconName> = {
  worktree: 'folder',
  knowledge: KNOWLEDGE_ICON,
  shared: KNOWLEDGE_ICON,
};

const KnowledgeSaveContext = createContext<{
  save(messageId: string, text: string): Promise<void>;
} | null>(null);

type OpenLocalFile = (path: string, root?: SessionFileRoot) => void;
const SessionFileOpenContext = createContext<OpenLocalFile | null>(null);
const SessionFileImageSourceContext = createContext<
  ((path: string) => ImageSource | undefined) | null
>(null);
const SearchHighlightContext = createContext<string | null>(null);

function useTranscriptRows(messages: readonly Message[]): Row[] {
  const previous = useRef<Row[]>([]);
  return useMemo(() => {
    const rows = groupRows(messages, previous.current);
    previous.current = rows;
    return rows;
  }, [messages]);
}

export function SessionChat({
  client,
  sessionId,
  baseUrl,
  embedded,
  initialTargetMessageId,
  initialTargetSearchQuery,
  retrySecret,
}: {
  client: VerityClient;
  sessionId: string;
  baseUrl: string;
  embedded?: boolean;
  initialTargetMessageId?: string;
  initialTargetSearchQuery?: string;
  retrySecret?: string;
}) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
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
    planning,
    planningRevision,
    planningPlan,
    decidingPlanning,
    planningError,
    decidePlanning,
    decidingPermission,
    permissionError,
    sendTurn,
    cancel,
    cancelWaiting,
    dismissPending,
    decidePermission,
    switchModel,
    hasOlder,
    oldestHistorySeq,
    loadingOlder,
    olderLoadStalled,
    olderLoadNeedsContinuation,
    olderLoadGeneration,
    loadOlder,
    loadOlderUntil,
  } = useSession(client, sessionId, baseUrl);
  const [linkedSessions, setLinkedSessions] = useState<
    Awaited<ReturnType<VerityClient['listSessionLinks']>>
  >([]);
  const [pendingLinkedMessages, setPendingLinkedMessages] = useState<
    Awaited<ReturnType<VerityClient['listPendingLinkedMessages']>>
  >([]);
  const [decidingLinkedMessage, setDecidingLinkedMessage] = useState<string | null>(null);
  const [contactsConnection, setContactsConnection] = useState<ContactsSessionConnection | null>(
    null,
  );
  useFocusEffect(
    useCallback(() => {
      if (!loaded) return;
      let active = true;
      setLinkedSessions([]);
      const refresh = () => {
        void client
          .listSessionLinks(sessionId)
          .then((links) => {
            if (active) setLinkedSessions(links);
          })
          .catch(() => undefined);
      };
      refresh();
      const detach = subscribeLiveRefresh(
        client,
        refresh,
        (path) => path === `/sessions/${encodeURIComponent(sessionId)}/links`,
      );
      return () => {
        active = false;
        detach();
      };
    }, [client, sessionId, loaded]),
  );
  useFocusEffect(
    useCallback(() => {
      if (!loaded) return;
      let active = true;
      setPendingLinkedMessages([]);
      const refresh = () => {
        void client
          .listPendingLinkedMessages(sessionId)
          .then((items) => {
            if (active) setPendingLinkedMessages(items);
          })
          .catch(() => undefined);
      };
      refresh();
      const detach = subscribeLiveRefresh(
        client,
        refresh,
        (path) => path === `/sessions/${encodeURIComponent(sessionId)}/linked-message-approvals`,
      );
      return () => {
        active = false;
        detach();
      };
    }, [client, sessionId, loaded]),
  );
  const decideLinkedMessage = (id: string, decision: PermissionDecision): void => {
    setDecidingLinkedMessage(id);
    void client
      .decidePermission(sessionId, id, decision)
      .then(() => {
        setPendingLinkedMessages((items) => items.filter((item) => item.id !== id));
      })
      .catch((error: unknown) => {
        Alert.alert(
          'Message decision failed',
          error instanceof Error ? error.message : 'Please try again.',
        );
      })
      .finally(() => setDecidingLinkedMessage(null));
  };
  const disconnectLinkedSession = (link: (typeof linkedSessions)[number]) => {
    Alert.alert(
      'Disconnect sessions?',
      `Stop sharing agent messages with ${link.name ?? link.sessionId}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () => {
            void client
              .unlinkSessions(sessionId, link.sessionId)
              .then(() => {
                setLinkedSessions((current) =>
                  current.filter((item) => item.sessionId !== link.sessionId),
                );
              })
              .catch(() => Alert.alert('Disconnect failed', 'Please try again.'));
          },
        },
      ],
    );
  };
  const compactLandscape =
    Platform.OS === 'ios' && !Platform.isPad && windowWidth > windowHeight && !embedded;
  usePermissionHaptic(loaded, session.pendingPermission?.toolUseId);
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
  const { models, modelOrder, moreModels, refresh: refreshModels } = useModels(client, loaded);
  const [enginePickerOpen, setEnginePickerOpen] = useState(false);
  const effectiveModel = currentModel ?? session.model;
  const [automation, setAutomation] = useState<SessionAutomation | null>(null);
  const [automationReady, setAutomationReady] = useState(false);
  const [automationSheetOpen, setAutomationSheetOpen] = useState(false);
  const [automationUpdating, setAutomationUpdating] = useState(false);
  // Name of a header action shown under the title after a long-press — the icon-only
  // buttons explain themselves on demand without permanent labels.
  const [headerHint, setHeaderHint] = useState<string | null>(null);
  const headerHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showHeaderHint = useCallback((label: string) => {
    if (headerHintTimer.current) clearTimeout(headerHintTimer.current);
    setHeaderHint(label);
    headerHintTimer.current = setTimeout(() => setHeaderHint(null), 1500);
  }, []);
  useEffect(
    () => () => {
      if (headerHintTimer.current) clearTimeout(headerHintTimer.current);
    },
    [],
  );
  // The automation is read when the session opens and again whenever its sheet
  // opens, so the "last run" sentence reflects runs that happened meanwhile.
  // Bumped by every local change, so a read that started earlier cannot bring
  // back an automation the operator just paused, replaced, or deleted.
  const automationGeneration = useRef(0);
  const automationMutationPending = useRef(false);
  useEffect(
    () => () => {
      // A closed chat must not publish an old read over mutations from its replacement.
      automationGeneration.current += 1;
    },
    [sessionId],
  );
  const loadAutomation = useCallback(() => {
    if (automationMutationPending.current) return Promise.resolve();
    const generation = ++automationGeneration.current;
    return client
      .getSessionAutomation(sessionId)
      .then((loaded) => {
        if (generation !== automationGeneration.current) return;
        setAutomationReady(true);
        setAutomation(loaded);
        publishSessionAutomationMutation(sessionId, loaded);
      })
      .catch(() => {
        if (generation === automationGeneration.current) setAutomationReady(false);
      });
  }, [client, sessionId]);
  useEffect(() => {
    setAutomationReady(false);
    if (loaded) void loadAutomation();
  }, [loadAutomation, loaded]);
  const applyAutomation = useCallback(
    (next: SessionAutomation | null) => {
      automationGeneration.current += 1;
      setAutomationReady(true);
      setAutomation(next);
      publishSessionAutomationMutation(sessionId, next);
    },
    [sessionId],
  );
  const openAutomation = useCallback(() => {
    setAutomationSheetOpen(true);
    void loadAutomation();
  }, [loadAutomation]);
  const toggleAutomation = useCallback(() => {
    if (!automation || automationMutationPending.current) return;
    automationMutationPending.current = true;
    automationGeneration.current += 1;
    setAutomationUpdating(true);
    void client
      .setSessionAutomationStatus(sessionId, automation.status === 'enabled' ? 'paused' : 'enabled')
      .then(applyAutomation)
      .catch((error: unknown) =>
        Alert.alert(
          'Could not update automation',
          error instanceof Error ? error.message : 'Please try again.',
        ),
      )
      .finally(() => {
        automationMutationPending.current = false;
        setAutomationUpdating(false);
      });
  }, [applyAutomation, automation, automationUpdating, client, sessionId]);
  const deleteAutomation = useCallback(() => {
    if (!automation) return;
    Alert.alert(
      'Delete this automation?',
      `“${automation.name}” will stop running. The conversation stays as it is.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            if (automationMutationPending.current) return;
            automationMutationPending.current = true;
            automationGeneration.current += 1;
            setAutomationUpdating(true);
            void client
              .deleteSessionAutomation(sessionId)
              .then(() => {
                setAutomationSheetOpen(false);
                applyAutomation(null);
              })
              .catch((error: unknown) =>
                Alert.alert(
                  'Could not delete automation',
                  error instanceof Error ? error.message : 'Please try again.',
                ),
              )
              .finally(() => {
                automationMutationPending.current = false;
                setAutomationUpdating(false);
              });
          },
        },
      ],
    );
  }, [applyAutomation, automation, client, sessionId]);

  const [staticPreviewOpen, setStaticPreviewOpen] = useState(false);
  const [previewServer, setPreviewServer] =
    useState<NonNullable<typeof session.devServers>[number]>();
  const [previewOpening, setPreviewOpening] = useState<number | null>(null);
  const completedServerTools = session.messages.filter(
    (message) => message.kind === 'tool-call' && message.tool.state === 'completed',
  ).length;
  // Names and addresses of managed servers, for their chat cards.
  const [managedByInstance, setManagedByInstance] = useState<Map<string, ManagedDevServer>>(
    () => new Map(),
  );
  useEffect(() => {
    if (typeof client.listManagedDevServers !== 'function') return;
    let active = true;
    void client
      .listManagedDevServers(sessionId)
      .then((servers) => {
        if (!active || !servers) return;
        setManagedByInstance(
          new Map(
            servers.flatMap((server) =>
              server.instance ? [[server.instance.id, server] as const] : [],
            ),
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, completedServerTools, session.devServers, sessionId]);
  const openDetectedLocally = async (server: NonNullable<typeof session.devServers>[number]) => {
    if (previewOpening !== null) return;
    setPreviewOpening(server.port);
    try {
      const capabilities = await client
        .getPreviewCapabilities()
        .catch(() => ({ publicSharing: 'unavailable' as const }));
      const share = await client.createSessionLocalPreviewShare(sessionId, {
        targetPort: server.port,
      });
      await openLocalPreview(
        share,
        capabilities.publicSharing,
        () => {
          setPreviewServer(server);
          setStaticPreviewOpen(true);
        },
        () => router.push('/settings/services'),
      );
    } catch (caught) {
      const alert = openFailureAlert(server.name, caught instanceof Error ? caught.message : '');
      Alert.alert(alert.title, alert.body);
    } finally {
      setPreviewOpening(null);
    }
  };
  const [hasActiveStaticPreview, setHasActiveStaticPreview] = useState(false);
  const [hasRunningDevServer, setHasRunningDevServer] = useState(false);
  // Set once a Core without port detection says so, so the header stops asking.
  const devServersUnsupported = useRef(false);
  const refreshStaticPreview = useCallback(() => {
    if (!projectId) return;
    if (typeof client.listSessionDevServers === 'function' && !devServersUnsupported.current) {
      void client
        .listSessionDevServers(sessionId)
        .then((servers) => {
          if (servers === null) devServersUnsupported.current = true;
          setHasRunningDevServer((servers ?? []).length > 0);
        })
        .catch(() => undefined);
    }
    // Shared means shared on the local network or online alike: either lights the
    // preview button. A failed read counts as "not shared" for that source only.
    const now = Date.now();
    const publicShared = client
      .listPublicPreviewShares(projectId)
      .then((shares) =>
        shares.some(
          (share) =>
            (share.targetKind === 'static-folder' ||
              (share.targetKind === 'dev-server' && share.devServerId === null)) &&
            share.sessionId === sessionId &&
            share.state === 'active' &&
            new Date(share.expiresAt).getTime() > now,
        ),
      )
      .catch(() => false);
    const localShared =
      typeof client.listSessionLocalPreviewShares === 'function'
        ? client
            .listSessionLocalPreviewShares(sessionId)
            .then((shares) => shares.some((share) => share.expiresAt.getTime() > now))
            .catch(() => false)
        : Promise.resolve(false);
    void Promise.all([publicShared, localShared]).then(([online, local]) =>
      setHasActiveStaticPreview(online || local),
    );
  }, [client, projectId, sessionId]);
  useEffect(() => {
    if (!loaded) return;
    refreshStaticPreview();
    const detach = subscribeLiveRefresh(
      client,
      refreshStaticPreview,
      (path) =>
        (projectId != null &&
          path === `/projects/${encodeURIComponent(projectId)}/public-shares`) ||
        (path.startsWith(`/sessions/${encodeURIComponent(sessionId)}/`) &&
          /preview|share|dev-server/u.test(path)),
    );
    return () => detach();
  }, [refreshStaticPreview, loaded, client, projectId, sessionId]);

  useEffect(() => {
    if (session.devServers !== undefined) setHasRunningDevServer(session.devServers.length > 0);
  }, [session.devServers]);

  const confirmAutomation = useCallback(
    async (proposal: AutomationProposalMessage['proposal']): Promise<void> => {
      if (automationMutationPending.current)
        throw new Error('An automation update is in progress.');
      automationMutationPending.current = true;
      automationGeneration.current += 1;
      setAutomationUpdating(true);
      try {
        const saved = await client.saveSessionAutomation(sessionId, {
          name: proposal.name,
          schedule: proposal.schedule,
          prompt: proposal.prompt,
          ...(proposal.script !== undefined ? { script: proposal.script } : {}),
          ...(proposal.model !== undefined ? { model: proposal.model } : {}),
        });
        applyAutomation(saved);
      } finally {
        automationMutationPending.current = false;
        setAutomationUpdating(false);
      }
    },
    [applyAutomation, automationReady, client, sessionId],
  );
  // Keep configured OpenCode gateway models available in project sessions while
  // excluding provider IDs that the server cannot route.
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
  const voiceAutoSendRef = useRef<(text: string) => Promise<boolean>>(async () => false);
  const voice = useVoiceInput(draft, setDraft, (text) => voiceAutoSendRef.current(text));
  // Branch switcher (#91): tap the top chip to switch this session's worktree to a
  // different branch — the chat (one persistent thread per session) stays put.
  const branches = useBranches(client, sessionId, loaded || !locallyCreated);
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
  // Open PRs cannot be dismissed, so they can render immediately. Wait for the
  // dismissed-state cache only for terminal PRs to avoid flashing a hidden bar.
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
  const visiblePullRequest = shouldShowPullRequest(
    branches.pullRequest?.phase,
    pullRequestBarReady,
    pullRequestDismissed,
  )
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
  const loadedTranscriptData = useTranscriptRows(session.messages);
  const transcriptData = useMemo(
    () => withPlanningSnapshot(loadedTranscriptData, { planning, planningPlan, planningRevision }),
    [loadedTranscriptData, planning, planningPlan, planningRevision],
  );
  const localMeetingData = useTranscriptRows(localMeetingMessages);
  const pendingEchoData = useTranscriptRows(pendingEchoMessages);
  const liveChronologicalData = useMemo(
    () => [...transcriptData, ...localMeetingData, ...pendingEchoData],
    [transcriptData, localMeetingData, pendingEchoData],
  );
  // The live tail is frozen while the operator reads history — see the freeze effect
  // below and lib/../transcriptFreeze.ts for why the list itself cannot hold their
  // position against a growing row 0. `null` = following the live edge.
  const [frozenTail, setFrozenTail] = useState<FrozenTranscriptTail | null>(null);
  const previousFrozenRows = useRef<Row[]>([]);
  const frozenRows = useMemo(() => {
    const rows = frozenTail === null ? null : frozenTranscriptRows(messages, frozenTail);
    if (rows === null) {
      previousFrozenRows.current = [];
      return null;
    }
    const stableRows = reconcileTranscriptRows(rows, previousFrozenRows.current);
    previousFrozenRows.current = stableRows;
    return stableRows;
  }, [frozenTail, messages]);
  const chronologicalData = frozenRows ?? liveChronologicalData;
  // Both assigned during render (same reasoning as `dataRef` below): the freeze is
  // driven from scroll callbacks and effects that must see the CURRENT transcript,
  // not the one captured when the callback was created.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const transcriptSnapshot = {
    messages: session.messages,
    planning: { planning, planningPlan, planningRevision },
    localMessageGroups: [localMeetingMessages, pendingEchoMessages],
  };
  const transcriptSnapshotRef = useRef(transcriptSnapshot);
  transcriptSnapshotRef.current = transcriptSnapshot;
  const frozenTailRef = useRef<FrozenTranscriptTail | null>(null);
  frozenTailRef.current = frozenTail;
  const snapshotLiveTail = useCallback(() => {
    const snapshot = transcriptSnapshotRef.current;
    setFrozenTail(
      freezeTranscriptTail(snapshot.messages, snapshot.planning, snapshot.localMessageGroups),
    );
  }, []);
  // A snapshot whose boundary message is gone (the transcript was reloaded) no longer
  // describes this session: `frozenTranscriptRows` returned null and we are rendering
  // live rows, so take a fresh snapshot to freeze the tail again.
  useEffect(() => {
    if (frozenTail !== null && frozenRows === null) snapshotLiveTail();
  }, [frozenTail, frozenRows, snapshotLiveTail]);
  // FlashList is fed NEWEST-FIRST and rendered inverted (the list transform /
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
      voice.onComposerEdit(text);
      setDraft(text);
    },
    [clearSearchHighlight, voice.onComposerEdit, setDraft],
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
        const nearHistoryEdge = isHistoryEdgeVisible(
          lastScrollYRef.current,
          lastContentHeightRef.current,
          lastViewportHeightRef.current,
          oldestVisibleIndexRef.current,
          dataRef.current.length,
        );
        reportScrollDebug('settle-idle', {
          delayMs,
          terminal,
          settledAtBottom,
          wasManualGesture,
          nearHistoryEdge,
        });
        // The gesture is over, so a page withheld by the append-settle window or by
        // the gesture guard can run now. A gesture can stop inside the prefetch
        // buffer without producing another scroll event.
        if (nearHistoryEdge) loadOlderNearStartRef.current();
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
  const bookmarks = useBookmarks(sessionId);
  // Own prompts and bookmarks are orientation anchors in a long transcript.
  // Include bookmarked messages inside grouped rows as well as standalone rows.
  const userRowIndices = useMemo(
    () => navigationRowIndices(data, bookmarks.ids),
    [data, bookmarks.ids],
  );
  // Two cursors, because the list is inverted: the SMALLEST visible index is the
  // newest visible row (visually at the bottom) and backs the saved re-entry anchor;
  // the LARGEST is the visually topmost row and drives message navigation and the
  // history edge.
  const { oldestVisibleIndexRef, prevUserIndex, nextUserIndex, updateVisibleIndex } =
    useTranscriptNavigation(userRowIndices);
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
      updateVisibleIndex(max);
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
  const canJumpToPreviousUser = prevUserIndex >= 0 || hasOlder;
  const [jumpTarget, setJumpTarget] = useState<ScrollAnchor | null>(null);
  const scrollToUserRow = useCallback(
    (index: number) => {
      if (index < 0) return;
      cancelPendingUserScrollSettle();
      readingAwayFromBottomRef.current = true;
      setJumpTarget(anchorFromRow(dataRef.current[index], false, null));
      syncTailFreeze();
    },
    [cancelPendingUserScrollSettle, syncTailFreeze],
  );
  const [pendingUserJump, setPendingUserJump] = useState<'previous' | null>(null);
  const userJumpCursorRef = useRef<number | undefined>(undefined);
  // Rows above the target are a padding's width from the screen edge, like the newest
  // row is from the bottom; the same inset keeps the jumped-to prompt off the edge.
  const jumpTopInset = theme.spacing.lg;
  useEffect(() => {
    if (jumpTarget === null) return;
    let cancelled = false;
    // One awaited scrollToIndex pass at a time, re-checked against the measured layout
    // before the cover lifts (see lib/transcriptJump.ts for why timers fail here).
    void settleTranscriptJump({
      list: () => listRef.current,
      resolveIndex: () => findAnchorIndex(dataRef.current, jumpTarget, 'newest-first'),
      topInset: jumpTopInset,
      isCancelled: () => cancelled,
      onPass: (pass, index) => {
        scrollDebugLastProgrammaticAtRef.current = Date.now();
        reportScrollDebug('jump-pass', { pass, index });
      },
    }).then((outcome) => {
      if (cancelled) return;
      reportScrollDebug('jump-settled', { outcome });
      setJumpTarget(null);
    });
    // Never strand the cover: a pass whose native promise never resolves (list torn
    // down mid-scroll) would otherwise hide the transcript for good.
    const failSafe = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      reportScrollDebug('jump-fail-safe');
      setJumpTarget(null);
    }, JUMP_FAIL_SAFE_MS);
    return () => {
      cancelled = true;
      clearTimeout(failSafe);
    };
  }, [jumpTarget, jumpTopInset, reportScrollDebug]);
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
      currentData[oldestVisibleIndexRef.current] !== undefined
        ? anchorFromRow(currentData[oldestVisibleIndexRef.current], false, null)
        : visualTopAnchorRef.current;
    userJumpCursorRef.current = undefined;
    setPendingUserJump('previous');
  }, [
    cancelPendingUserScrollSettle,
    hasOlder,
    prevUserIndex,
    scrollToUserRow,
    oldestVisibleIndexRef,
  ]);
  useEffect(() => {
    if (pendingUserJump !== 'previous') return;
    const anchor = visualTopAnchorRef.current;
    const anchorIndex =
      anchor === null
        ? oldestVisibleIndexRef.current
        : findAnchorIndex(data, anchor, 'newest-first');
    const cursor = anchorIndex >= 0 ? anchorIndex : oldestVisibleIndexRef.current;
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
      setJumpTarget(anchorFromRow(data[target], false, null));
      setPendingUserJump(null);
      return;
    }
    if (loadingOlder) return;
    if (
      !shouldContinueUserJump(
        hasOlder,
        olderLoadStalled,
        oldestHistorySeq,
        userJumpCursorRef.current,
      )
    ) {
      setPendingUserJump(null);
      return;
    }
    userJumpCursorRef.current = oldestHistorySeq;
    loadOlder();
  }, [
    pendingUserJump,
    data,
    oldestVisibleIndexRef,
    userRowIndices,
    loadingOlder,
    hasOlder,
    oldestHistorySeq,
    olderLoadStalled,
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
      if (pendingUserJump !== null) return;
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
    [hasOlder, loadingOlder, loadOlder, olderLoadStalled, pendingUserJump, reportScrollDebug],
  );
  loadOlderNearStartRef.current = requestOlderHistory;
  const onListContentSizeChange = useCallback((_width: number, height: number) => {
    lastContentHeightRef.current = height;
  }, []);
  const initialHistoryPrefetchRef = useRef(false);
  useEffect(() => {
    if (initialHistoryPrefetchRef.current || !loaded || restoring || !hasOlder || loadingOlder)
      return;
    initialHistoryPrefetchRef.current = true;
    // A single extra page starts behind the initial render. Subsequent pages are
    // governed by the measured four-viewport buffer, so opening a long session
    // cannot pull its whole transcript into memory.
    loadOlderNearStartRef.current();
  }, [loaded, restoring, hasOlder, loadingOlder]);
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
      const nearHistoryEdge = isHistoryEdgeVisible(
        lastScrollYRef.current,
        lastContentHeightRef.current,
        lastViewportHeightRef.current,
        oldestVisibleIndexRef.current,
        dataRef.current.length,
      );
      reportScrollDebug('history-append-settled', {
        rows: dataRef.current.length,
        y: lastScrollYRef.current,
        nearHistoryEdge,
      });
      // Clearing a ref renders nothing, so re-check the measured buffer here. A page
      // containing little visible content may still leave less than four screens ready;
      // content-size updates keep this check current after FlashList measures the rows.
      // Never during an active gesture — the settle-idle handler re-checks the same
      // condition once the finger is up.
      if (nearHistoryEdge && !userScrollActiveRef.current) loadOlderNearStartRef.current();
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
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesInitialPath, setFilesInitialPath] = useState<string | null>(null);
  const [filesInitialRoot, setFilesInitialRoot] = useState<SessionFileRoot>('worktree');
  const openSessionFile = useCallback((path: string, root: SessionFileRoot = 'worktree') => {
    setFilesInitialPath(path);
    setFilesInitialRoot(root);
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
  const [saveAttachmentsToKnowledge, setSaveAttachmentsToKnowledge] = useState(false);
  useEffect(() => {
    if (attachments.length === 0) setSaveAttachmentsToKnowledge(false);
  }, [attachments.length]);
  const [workspaceFile, setWorkspaceFile] = useState<SessionGoogleWorkspaceFile | null>(null);
  const [googleConnected, setGoogleConnected] = useState(false);
  const [gmailConnection, setGmailConnection] = useState<GmailSessionConnection | null>(null);
  const [calendarConnection, setCalendarConnection] = useState<CalendarSessionConnection | null>(
    null,
  );
  const [projectGoogleAccess, setProjectGoogleAccess] = useState<Record<GoogleService, boolean>>({
    gmail: false,
    calendar: false,
    contacts: false,
  });
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setGoogleConnected(false);
      void hasConnectedGoogleAccount(client, sessionId)
        .then((connection) => {
          if (active) setGoogleConnected(connection);
        })
        .catch(() => undefined);
      void client
        .getSessionGoogleWorkspaceFile(sessionId)
        .then((file) => {
          if (active) setWorkspaceFile(file);
        })
        .catch(() => undefined);
      void client
        .getSessionGmailConnection(sessionId)
        .then((connection) => {
          if (active) setGmailConnection(connection);
        })
        .catch(() => undefined);
      void client
        .getSessionCalendarConnection(sessionId)
        .then((connection) => {
          if (active) setCalendarConnection(connection);
        })
        .catch(() => undefined);
      void client
        .getSessionContactsConnection(sessionId)
        .then((connection) => {
          if (active) setContactsConnection(connection);
        })
        .catch(() => undefined);
      void getProjectGoogleAccess(client, projectId)
        .then((access) => {
          if (active) setProjectGoogleAccess(access);
        })
        .catch(() => undefined);
      return () => {
        active = false;
      };
    }, [client, projectId, sessionId]),
  );
  // A dead session (worktree gone) can't take turns — disable sending proactively
  // (`resumable === false`); `undefined` (detail still loading) stays enabled.
  const dead = resumable === false;
  useFocusEffect(
    useCallback(
      () =>
        subscribeVoiceShortcut(() => {
          if (!dead) voice.toggle();
        }),
      [dead, voice.toggle],
    ),
  );
  const checkedSecretFailuresRef = useRef(new Set<string>());
  const retriedSecretFailuresRef = useRef(new Set<string>());

  useEffect(() => {
    if (!loaded || retrySecret) return;
    const failedCall = trustedCliUnlockCandidate(session.messages);
    if (!failedCall || checkedSecretFailuresRef.current.has(failedCall.id)) return;
    checkedSecretFailuresRef.current.add(failedCall.id);

    let active = true;
    let settled = false;
    void client
      .getSecretStatus()
      .then((status) => {
        if (!active) return;
        settled = true;
        if (status !== 'sealed') return;
        const returnTo = embedded
          ? `/?selected=${encodeURIComponent(sessionId)}&retrySecret=${encodeURIComponent(failedCall.id)}`
          : `/session/${encodeURIComponent(sessionId)}?retrySecret=${encodeURIComponent(failedCall.id)}`;
        router.push({
          pathname: '/unlock-device',
          params: { returnTo, serverSecret: '1' },
        });
      })
      .catch(() => {
        if (active) checkedSecretFailuresRef.current.delete(failedCall.id);
      });
    return () => {
      active = false;
      if (!settled) checkedSecretFailuresRef.current.delete(failedCall.id);
    };
  }, [client, embedded, loaded, retrySecret, session.messages, sessionId]);

  useEffect(() => {
    if (!retrySecret || !loaded || sending || busy || dead) return;
    const failedCall = trustedCliUnlockCandidate(session.messages);
    if (failedCall?.id !== retrySecret) {
      router.setParams({ retrySecret: undefined });
      return;
    }
    if (retriedSecretFailuresRef.current.has(retrySecret)) return;
    retriedSecretFailuresRef.current.add(retrySecret);

    let active = true;
    let settled = false;
    void client
      .getSecretStatus()
      .then((status) => {
        if (!active) return;
        settled = true;
        if (status === 'sealed') {
          retriedSecretFailuresRef.current.delete(retrySecret);
          const returnTo = embedded
            ? `/?selected=${encodeURIComponent(sessionId)}&retrySecret=${encodeURIComponent(retrySecret)}`
            : `/session/${encodeURIComponent(sessionId)}?retrySecret=${encodeURIComponent(retrySecret)}`;
          router.push({
            pathname: '/unlock-device',
            params: { returnTo, serverSecret: '1' },
          });
          return;
        }
        if (status !== 'unlocked') {
          retriedSecretFailuresRef.current.delete(retrySecret);
          router.setParams({ retrySecret: undefined });
          return;
        }
        router.setParams({ retrySecret: undefined });
        sendTurn(RETRY_TRUSTED_CLI_AFTER_UNLOCK);
      })
      .catch(() => {
        if (active) retriedSecretFailuresRef.current.delete(retrySecret);
      });
    return () => {
      active = false;
      if (!settled) retriedSecretFailuresRef.current.delete(retrySecret);
    };
  }, [
    busy,
    client,
    dead,
    embedded,
    loaded,
    retrySecret,
    sendTurn,
    sending,
    session.messages,
    sessionId,
  ]);

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
  const onSaveToProject = useCallback<UseBranches['saveToProject']>(() => {
    // Same reasoning as the pull-request merge above: the server dispatches a turn
    // describing the post-merge state, so follow the live edge to see it arrive.
    scrollToLatest(true);
    return branches.saveToProject();
  }, [branches.saveToProject, scrollToLatest]);
  const voiceAbort = voice.abort;
  voiceAutoSendRef.current = async (text) => {
    if (!text || sending || dead || attachments.length > 0) return false;
    const accepted = await sendTurn(text);
    if (!accepted) return false;
    scrollToLatest(true);
    Keyboard.dismiss();
    return true;
  };
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
    const sentAttachments = attachments;
    void sendTurn(prompt, attachments.length > 0 ? { attachments } : {}).then((accepted) => {
      if (!accepted || !saveAttachmentsToKnowledge || !projectId || sentAttachments.length === 0)
        return;
      void client
        .saveSessionKnowledge(sessionId, {
          attachments: sentAttachments.map((attachment, index) => ({
            filename:
              attachment.kind === 'file'
                ? attachment.fileName
                : `chat-image-${String(index + 1)}.${attachment.mediaType === 'image/png' ? 'png' : 'jpg'}`,
            base64: attachment.data,
          })),
        })
        .catch((error: unknown) =>
          Alert.alert(
            'Could not save to Project Knowledge',
            error instanceof Error ? error.message : String(error),
          ),
        );
    });
    // Sending is an explicit return to the live conversation: reveal the new operator
    // message even when they had scrolled up to read older transcript content, and keep
    // following while the matching prompt event and agent response arrive.
    scrollToLatest(true);
    setDraft('');
    setAttachments([]);
    setSaveAttachmentsToKnowledge(false);
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
      Platform.OS === 'web' ||
      (isIpadFocusTarget &&
        (shouldPreserveComposerFocus() ||
          (composerFocusedRef.current && !keyboardShownRef.current)));
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
    saveAttachmentsToKnowledge,
    projectId,
    client,
    sessionId,
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
                  router.push('/settings/transcription');
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
            'This saved backend is no longer available. Configure the OpenAI-compatible API in Settings.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open settings', onPress: () => router.push('/settings/transcription') },
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
              { text: 'Open settings', onPress: () => router.push('/settings/transcription') },
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
                router.push('/settings/transcription');
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
            ? 'This saved backend is no longer available. Configure the transcription API in Settings.'
            : 'Add the external API URL and model before the pending recording can be uploaded.',
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'Open settings', onPress: () => router.push('/settings/transcription') },
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
  const onLiveMeeting = useCallback(() => {
    setAttachMenuOpen(false);
    voice.abort();
    router.push({ pathname: '/meeting/[sessionId]', params: { sessionId } });
  }, [sessionId, voice]);
  const onConnectGoogleService = useCallback(
    (service: GoogleService) => {
      setAttachMenuOpen(false);
      void connectSessionGoogleService(client, sessionId, service)
        .then((result) => {
          if (result.kind === 'session') {
            setGmailConnection(result.connections.gmail);
            setCalendarConnection(result.connections.calendar);
            setContactsConnection(result.connections.contacts);
          }
        })
        .catch((error: unknown) =>
          Alert.alert(
            'Could not connect Google service',
            error instanceof Error ? error.message : String(error),
          ),
        );
    },
    [client, sessionId],
  );
  const onConnectGmail = useCallback(
    () => onConnectGoogleService('gmail'),
    [onConnectGoogleService],
  );
  const onConnectCalendar = useCallback(
    () => onConnectGoogleService('calendar'),
    [onConnectGoogleService],
  );
  const onConnectContacts = useCallback(
    () => onConnectGoogleService('contacts'),
    [onConnectGoogleService],
  );
  const disableGoogleService = useCallback(
    (service: GoogleService) => {
      void disconnectSessionGoogleService(client, sessionId, projectId, service)
        .then(() => {
          setProjectGoogleAccess((current) => ({ ...current, [service]: false }));
          if (service === 'gmail')
            setGmailConnection((current) =>
              current === null ? null : { ...current, enabled: false },
            );
          else if (service === 'calendar')
            setCalendarConnection((current) =>
              current === null ? null : { ...current, enabled: false },
            );
          else
            setContactsConnection((current) =>
              current === null ? null : { ...current, enabled: false },
            );
        })
        .catch((error: unknown) =>
          Alert.alert(
            'Could not disconnect Google service',
            error instanceof Error ? error.message : String(error),
          ),
        );
    },
    [client, projectId, sessionId],
  );
  const disableGmail = useCallback(() => disableGoogleService('gmail'), [disableGoogleService]);
  const disableCalendar = useCallback(
    () => disableGoogleService('calendar'),
    [disableGoogleService],
  );
  const disableContacts = useCallback(
    () => disableGoogleService('contacts'),
    [disableGoogleService],
  );
  const clearWorkspaceFile = useCallback(() => {
    if (workspaceFile === null) return;
    Alert.alert(
      'End Workspace editing?',
      `Edits already made to ${workspaceFile.name} stay in Google Workspace.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'End editing',
          style: 'destructive',
          onPress: () => {
            void client
              .clearSessionGoogleWorkspaceFile(sessionId)
              .then(() => setWorkspaceFile(null))
              .catch((error: unknown) =>
                Alert.alert(
                  'Could not end editing',
                  error instanceof Error ? error.message : String(error),
                ),
              );
          },
        },
      ],
    );
  }, [client, sessionId, workspaceFile]);
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
  const latestAutomationProposalId = useMemo(() => {
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      const message = session.messages[i];
      if (message?.kind === 'automation-proposal') return message.id;
    }
    return null;
  }, [session.messages]);
  // Only a plan of the current round counts: one an earlier round already decided
  // must not be offered for implementation again.
  const hasPresentedPlan = useMemo(() => {
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      const m = session.messages[i];
      if (m?.kind !== 'tool-call') continue;
      if (planProposal(m.tool) !== null) return true;
      if (m.tool.state === 'completed' && planningToolName(m.tool.name) === START_PLANNING_TOOL)
        return false;
    }
    return false;
  }, [session.messages]);
  const implementPlan = useCallback(
    (revision?: number) => {
      decidePlanning('implement', revision);
      scrollToLatest(true);
    },
    [decidePlanning, scrollToLatest],
  );
  // "End" always asks: ending planning gives the agent its file access back, and
  // with a plan on the table the operator also has to say what becomes of it.
  const endPlanning = useCallback(() => {
    if (planningPlan == null) {
      Alert.alert(
        'End planning mode?',
        'The agent can change files again from your next message.',
        [
          { text: 'Keep planning', style: 'cancel' },
          { text: 'End', onPress: () => decidePlanning('discard') },
        ],
      );
      return;
    }
    Alert.alert(
      'End planning mode?',
      hasPresentedPlan
        ? 'What should happen to the latest plan? It stays in the chat either way.'
        : `What should happen to this plan?\n\n${planningPlan}`,
      [
        { text: 'Implement plan', onPress: () => implementPlan(planningRevision) },
        { text: 'Discard plan', style: 'destructive', onPress: () => decidePlanning('discard') },
        { text: 'Keep planning', style: 'cancel' },
      ],
    );
  }, [decidePlanning, hasPresentedPlan, implementPlan, planningRevision, planningPlan]);
  const actions = useMemo<SessionActions>(
    () => ({
      sendTurn: sendQuickReply,
      sending,
      dead,
      focusInput,
      recoverPending: onDismissPendingEcho,
      confirmAutomation,
      automation,
      automationReady,
      latestAutomationProposalId,
      planning,
      planningRevision,
      planningPlan,
      decidingPlanning,
      implementPlan,
    }),
    [
      sendQuickReply,
      sending,
      dead,
      focusInput,
      onDismissPendingEcho,
      confirmAutomation,
      automation,
      automationReady,
      latestAutomationProposalId,
      planning,
      planningRevision,
      planningPlan,
      decidingPlanning,
      implementPlan,
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
      const rendered = (
        <TranscriptRow item={item} isLatest={isLatestTranscriptRow} renderContent={renderRow} />
      );
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
  //
  // The HEIGHT is kept, not just a boolean, because the composer's Return key needs to
  // tell a full software keyboard (newline — it's the only way to type one) from the
  // hardware shortcut bar (send). Both are "shown"; only the height separates them, and
  // taking it from the same event that flips visibility keeps the two in step.
  const [keyboardHeight, setKeyboardHeight] = useState<number | null>(null);
  const keyboardAvoidance = useSessionKeyboardAvoidance();
  const probingAutofocusRef = useRef(false);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (event) => {
      keyboardShownRef.current = true;
      setKeyboardHeight(event.endCoordinates?.height ?? 0);
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
      setKeyboardHeight(null);
      probingAutofocusRef.current = false;
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Navigation can retain the session screen, so mounting alone misses return visits.
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'web') return;
      return focusComposer();
    }, [focusComposer, sessionId]),
  );

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
  // chevron + title replace the native equivalents.
  // One row: back, a left-aligned title block (name over branch) that truncates, and
  // the round action buttons pinned right.
  // When `embedded`, this renders inline in a two-pane layout (the embedding screen
  // owns the route header): no back button (no pane-local back nav) and `theme.spacing.sm`
  // top padding instead of the safe-area inset (the pane sits below the app header).
  const headerBar = (
    <View
      style={[
        styles.header,
        compactLandscape && styles.headerCompact,
        {
          paddingTop: embedded ? theme.spacing.xs : insets.top,
          paddingLeft: embedded ? 0 : insets.left,
          paddingRight: embedded ? 0 : insets.right,
        },
      ]}
    >
      <View
        style={[
          styles.headerRow,
          embedded && styles.headerRowEmbedded,
          compactLandscape && styles.headerRowCompact,
        ]}
      >
        {embedded ? null : (
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
        {/* Title block: the session name with quiet context underneath — the branch
            as a bare glyph that opens the switcher (#91, where its full name is
            shown) and the issue as a bare `#123`. A long-press on a header action
            briefly swaps this line for the action's name. */}
        <View style={styles.headerTitleBlock}>
          <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">
            {sessionFallback}
          </Text>
          {headerHint !== null ? (
            <Text style={[styles.headerBranch, styles.headerHintText]} numberOfLines={1}>
              {headerHint}
            </Text>
          ) : (
            <View style={styles.headerSubtitle}>
              <Pressable
                onPress={() => setSwitcherOpen(true)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Current branch ${currentLabel}. Tap to switch branch.`}
                style={styles.headerBranchBtn}
              >
                <Icon name="git-branch" size={13} color={theme.colors.textFaint} />
              </Pressable>
              {issueNumber !== null ? <IssueRef number={issueNumber} url={issueUrl} /> : null}
            </View>
          )}
        </View>
        {/* Actions sit on the title row as large round buttons, so the header needs a
            single row and the targets are big enough to hit and recognise. */}
        <View style={styles.headerActions}>
          {projectId ? (
            <HeaderActionButton
              icon="monitor"
              label="Preview"
              accessibilityLabel={
                hasRunningDevServer ? 'Share preview. A dev server is running.' : 'Share preview'
              }
              active={hasActiveStaticPreview}
              activeColor={theme.colors.tone.done}
              dot={hasRunningDevServer}
              dotTestID="preview-server-dot"
              onHint={showHeaderHint}
              onPress={() => {
                refreshStaticPreview();
                setStaticPreviewOpen(true);
              }}
            />
          ) : null}
          <HeaderActionButton
            icon="folder"
            label="Files"
            accessibilityLabel="Browse session files"
            onHint={showHeaderHint}
            onPress={() => {
              setFilesInitialPath(null);
              setFilesOpen(true);
            }}
          />
          {bookmarks.ids.size > 0 ? (
            <HeaderActionButton
              icon="bookmark"
              label="Bookmarks"
              accessibilityLabel={`${String(bookmarks.ids.size)} bookmarks. Tap to view.`}
              badge={bookmarks.ids.size}
              onHint={showHeaderHint}
              onPress={() => setBookmarksOpen(true)}
            />
          ) : null}
        </View>
      </View>
      {linkedSessions.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.headerLinks}
          accessibilityLabel="Linked sessions"
        >
          {linkedSessions.map((link) => (
            <View key={link.sessionId} style={styles.headerLinkChip}>
              <Icon name="link" size={13} color={theme.colors.primary} />
              <Text style={styles.headerLinkText} numberOfLines={1}>
                {link.projectName} · {link.name ?? link.sessionId}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Disconnect ${link.name ?? link.sessionId}`}
                hitSlop={8}
                onPress={() => disconnectLinkedSession(link)}
              >
                <Icon name="x" size={15} color={theme.colors.textMuted} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );

  return (
    <AnimatedKeyboardAvoidingView
      style={[styles.flex, keyboardAvoidance.resetStyle]}
      enabled={keyboardAvoidance.enabled}
      // The composer is pinned to the bottom of this frame, so the frame is what
      // shrinks. `padding` on both platforms now that the keyboard controller
      // drives it — it tracks the keyboard frame-by-frame instead of jumping on
      // the show event, which is what the transcript's scroll position is
      // measured against.
      behavior="padding"
      // The custom nav header is drawn by the navigator ABOVE this screen body, so
      // the KAV frame already starts below it (screen-absolute coords) — no extra
      // offset needed. A non-zero offset here over-lifts the input by ~the header
      // height, leaving a dead gap between the field and the keyboard top.
      keyboardVerticalOffset={0}
    >
      {embedded ? headerBar : <Stack.Screen options={{ header: () => headerBar }} />}
      {workspaceFile !== null ? (
        <View style={styles.workspaceFileBar}>
          <Pressable
            style={styles.slideDeckLink}
            onPress={() => void Linking.openURL(workspaceFile.webViewLink).catch(() => undefined)}
            accessibilityRole="link"
            accessibilityLabel={`${workspaceFile.name}. Open in Google ${
              workspaceFile.kind === 'slides'
                ? 'Slides'
                : workspaceFile.kind === 'sheets'
                  ? 'Sheets'
                  : 'Docs'
            }.`}
          >
            <Icon
              name={
                workspaceFile.kind === 'slides'
                  ? 'monitor'
                  : workspaceFile.kind === 'sheets'
                    ? 'grid'
                    : 'file-text'
              }
              size={16}
              color={theme.colors.primary}
            />
            <Text style={styles.slideDeckName} numberOfLines={1}>
              {workspaceFile.name} ↗
            </Text>
          </Pressable>
          <Pressable
            onPress={clearWorkspaceFile}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Stop editing ${workspaceFile.name}`}
          >
            <Icon name="x" size={16} color={theme.colors.textMuted} />
          </Pressable>
        </View>
      ) : null}
      {automation ? (
        <AutomationBar
          automation={automation}
          onOpen={openAutomation}
          onDelete={deleteAutomation}
        />
      ) : null}
      {gmailConnection?.enabled ? (
        <View style={styles.workspaceFileBar}>
          <View style={styles.slideDeckLink}>
            <Icon name="mail" size={16} color={theme.colors.primary} />
            <Text style={styles.slideDeckName} numberOfLines={1}>
              Gmail{projectGoogleAccess.gmail ? ' · Project access' : ''}
              {gmailConnection.accountEmail ? ` · ${gmailConnection.accountEmail}` : ''}
            </Text>
          </View>
          <Pressable
            onPress={disableGmail}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={
              projectGoogleAccess.gmail
                ? 'Disable Gmail for this project'
                : 'Disconnect Gmail from this session'
            }
          >
            <Icon name="x" size={16} color={theme.colors.textMuted} />
          </Pressable>
        </View>
      ) : null}
      {calendarConnection?.enabled ? (
        <View style={styles.workspaceFileBar}>
          <View style={styles.slideDeckLink}>
            <Icon name="calendar" size={16} color={theme.colors.primary} />
            <Text style={styles.slideDeckName} numberOfLines={1}>
              Google Calendar{projectGoogleAccess.calendar ? ' · Project access' : ''}
              {calendarConnection.accountEmail ? ` · ${calendarConnection.accountEmail}` : ''}
            </Text>
          </View>
          <Pressable
            onPress={disableCalendar}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={
              projectGoogleAccess.calendar
                ? 'Disable Google Calendar for this project'
                : 'Disconnect Google Calendar from this session'
            }
          >
            <Icon name="x" size={16} color={theme.colors.textMuted} />
          </Pressable>
        </View>
      ) : null}
      {contactsConnection?.enabled ? (
        <View style={styles.workspaceFileBar}>
          <View style={styles.slideDeckLink}>
            <Icon name="users" size={16} color={theme.colors.primary} />
            <Text style={styles.slideDeckName} numberOfLines={1}>
              Google Contacts{projectGoogleAccess.contacts ? ' · Project access' : ''}
              {contactsConnection.accountEmail ? ` · ${contactsConnection.accountEmail}` : ''}
            </Text>
          </View>
          <Pressable
            onPress={disableContacts}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={
              projectGoogleAccess.contacts
                ? 'Disable Google Contacts for this project'
                : 'Disconnect Google Contacts from this session'
            }
          >
            <Icon name="x" size={16} color={theme.colors.textMuted} />
          </Pressable>
        </View>
      ) : null}
      {/* Below the connection bars (Docs, Gmail, Calendar, Contacts): those
          describe the session itself, while a server comes and goes. */}
      {session.devServers
        ?.filter((server) => server.scope !== 'project')
        .map((server) => {
          // A managed server is named by its entry and opened through it: its
          // address is the reserved one, not a fresh ad hoc share.
          const entry = server.managedInstanceId
            ? managedByInstance.get(server.managedInstanceId)
            : undefined;
          // The overview holds both access switches, so the card leads there.
          const openEntry = () => {
            setStaticPreviewOpen(true);
          };
          return (
            <RunningServerCard
              key={server.port}
              server={entry ? { ...server, name: entry.name } : server}
              managed={entry}
              opening={previewOpening === server.port}
              disabled={previewOpening !== null}
              onOpen={() => {
                if (!server.managedInstanceId) return void openDetectedLocally(server);
                if (!entry?.instance) return openEntry();
                setPreviewOpening(server.port);
                void (async () => {
                  let current = entry;
                  if (!current.approved || current.instance?.awaitingApproval) {
                    const allowed = await new Promise<boolean>((resolve) =>
                      Alert.alert(
                        `Allow ${current.name} on your network?`,
                        `It runs:\n\n${current.command}${current.workdir !== '.' ? `\nin ${current.workdir}` : ''}\n\nAnyone on your network can open it while it runs.`,
                        [
                          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
                          { text: 'Allow', onPress: () => resolve(true) },
                        ],
                        { cancelable: true, onDismiss: () => resolve(false) },
                      ),
                    );
                    if (!allowed) return;
                    const approved = await client.approveManagedDevServer(sessionId, current.id, {
                      command: current.command,
                      workdir: current.workdir,
                    });
                    current = approved.find((value) => value.id === current.id) ?? current;
                  }
                  const url = current.instance?.url;
                  if (!url || !current.instance) return openEntry();
                  const localShareId =
                    current.instance.localShareId ??
                    (await client.listSessionLocalPreviewShares(sessionId)).find(
                      (share) =>
                        share.sessionId === sessionId &&
                        share.targetPort === current.instance?.sandboxPort &&
                        new URL(share.url).origin === new URL(url).origin,
                    )?.id;
                  if (!localShareId)
                    throw new Error('Network access changed. Refresh and try again.');
                  const capabilities = await client
                    .getPreviewCapabilities()
                    .catch(() => ({ publicSharing: 'unavailable' as const }));
                  await openLocalPreview(
                    { id: localShareId, url } as LocalPreviewShare,
                    capabilities.publicSharing,
                    openEntry,
                    () => router.push('/settings/services'),
                  );
                })()
                  .catch((caught: unknown) =>
                    Alert.alert(
                      'Could not open preview',
                      caught instanceof Error ? caught.message : 'Try again.',
                    ),
                  )
                  .finally(() => setPreviewOpening(null));
              }}
              onShare={() => {
                if (server.managedInstanceId) return openEntry();
                setPreviewServer(server);
                setStaticPreviewOpen(true);
              }}
            />
          );
        })}
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
      {staticPreviewOpen && projectId ? (
        <StaticPreviewSheet
          detectedServers={session.devServers}
          initialServer={previewServer}
          onAskAgent={(prompt) => {
            setStaticPreviewOpen(false);
            sendQuickReply(prompt);
          }}
          onOpenSettings={() => {
            setStaticPreviewOpen(false);
            router.push('/settings/services');
          }}
          client={client}
          projectId={projectId}
          sessionId={sessionId}
          onClose={() => {
            setStaticPreviewOpen(false);
            setPreviewServer(undefined);
            refreshStaticPreview();
          }}
        />
      ) : null}
      {filesOpen ? (
        <SessionFilesSheet
          client={client}
          sessionId={sessionId}
          projectId={projectId ?? null}
          baseUrl={baseUrl}
          initialFilePath={filesInitialPath}
          initialRoot={filesInitialRoot}
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
      {automation && automationSheetOpen ? (
        <AutomationSheet
          automation={automation}
          updating={automationUpdating}
          onToggle={toggleAutomation}
          onDelete={deleteAutomation}
          onClose={() => setAutomationSheetOpen(false)}
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
        <ScrollView
          contentContainerStyle={styles.starterScreen}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.emptyTitle}>What should this session do?</Text>
          <View style={styles.starterList}>
            <SessionStarterCard
              icon="code"
              title="Build something"
              text="Describe a change or a bug. The agent works on it in this session's own branch."
            />
            <SessionStarterCard
              icon="message-circle"
              title="Just chat"
              text="Ask questions, plan, or think out loud. Nothing changes until you ask for it."
            />
            <SessionStarterCard
              icon="repeat"
              title="Recurring task"
              badge="New"
              text="Say what should happen and when, for example every Monday at 9:00. You confirm it before it starts."
            />
          </View>
        </ScrollView>
      ) : (
        // Quick-Action chips (#97) reach the input/dispatch through the context. The
        // Rows stay chronological so FlashList's native chat anchoring can preserve the
        // viewport while older history is prepended and new text grows below it.
        <SessionActionsContext.Provider value={actions}>
          <SessionFileOpenContext.Provider value={openSessionFile}>
            <SessionFileImageSourceContext.Provider value={sessionFileImageSource}>
              <BookmarksContext.Provider value={bookmarks}>
                <KnowledgeSaveContext.Provider
                  value={
                    projectId
                      ? {
                          save: async (messageId, text) => {
                            await client.saveSessionKnowledge(sessionId, { messageId, text });
                          },
                        }
                      : null
                  }
                >
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
                    // FlashList consumes plain styles; Unistyles metadata loses the web flip.
                    style={{
                      transform: [{ scaleY: -1 }],
                      marginLeft: embedded ? 0 : insets.left,
                      marginRight: embedded ? 0 : insets.right,
                    }}
                    contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}
                    onScroll={onListScroll}
                    onContentSizeChange={onListContentSizeChange}
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
                  {/* Keep intermediate history pages hidden while resolving a jump, and
                cover measurement correction while restoring a saved position. */}
                  {restoring || pendingUserJump !== null || jumpTarget !== null ? (
                    <View style={styles.restoreCover}>
                      <ActivityIndicator
                        color={theme.colors.textMuted}
                        accessibilityLabel={
                          pendingUserJump !== null || jumpTarget !== null
                            ? 'Jumping to message or bookmark'
                            : 'Restoring chat position'
                        }
                      />
                      {pendingUserJump !== null || jumpTarget !== null ? (
                        <Text style={styles.emptySubtitle}>
                          {pendingUserJump !== null
                            ? 'Finding previous message or bookmark…'
                            : 'Jumping to message or bookmark…'}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                </KnowledgeSaveContext.Provider>
              </BookmarksContext.Provider>
            </SessionFileImageSourceContext.Provider>
          </SessionFileOpenContext.Provider>
        </SessionActionsContext.Provider>
      )}
      {messages.length > 0 ? (
        // Gate on the transcript existing, NOT on a `user-text` row being loaded: with
        // one opening prompt + a very long agent turn, that row sits above the first
        // loaded page, so navigation targets may be empty until you scroll up far enough
        // to page one in — which made the whole stack vanish mid-transcript and only
        // "pop back" on scroll-up. Previous stays active while older history exists and
        // pages toward the next unloaded target; next/latest self-disable when they
        // have no reachable target, so the stack stays available throughout.
        //
        // Message-nav stack, hugging the right edge, DEZENT (muted icons, no pill).
        // DOUBLE chevrons jump to the previous/next own message or bookmark;
        // SINGLE arrow jumps to the very bottom — so the three read
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
            disabled={pendingUserJump !== null || jumpTarget !== null || !canJumpToPreviousUser}
            accessibilityRole="button"
            accessibilityLabel="Jump to previous message or bookmark"
          >
            <Icon
              name="chevrons-up"
              size={22}
              color={
                pendingUserJump !== null || jumpTarget !== null || !canJumpToPreviousUser
                  ? theme.colors.textFaint
                  : theme.colors.textMuted
              }
            />
          </Pressable>
          <Pressable
            style={styles.msgNavBtn}
            hitSlop={12}
            onPress={() => scrollToUserRow(nextUserIndex)}
            disabled={pendingUserJump !== null || jumpTarget !== null || nextUserIndex < 0}
            accessibilityRole="button"
            accessibilityLabel="Jump to next message or bookmark"
          >
            <Icon
              name="chevrons-down"
              size={22}
              color={
                pendingUserJump !== null || jumpTarget !== null || nextUserIndex < 0
                  ? theme.colors.textFaint
                  : theme.colors.textMuted
              }
            />
          </Pressable>
          <Pressable
            style={styles.msgNavBtn}
            hitSlop={12}
            onPress={() => scrollToLatest(true)}
            disabled={pendingUserJump !== null || jumpTarget !== null || atBottom}
            accessibilityRole="button"
            accessibilityLabel="Scroll to latest"
          >
            <Icon
              name="arrow-down"
              size={22}
              color={
                pendingUserJump !== null || jumpTarget !== null || atBottom
                  ? theme.colors.textFaint
                  : theme.colors.textMuted
              }
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
          dead={
            dead &&
            !pendingLinkedMessages.some((item) => item.id === session.pendingPermission?.toolUseId)
          }
          approvedForDelivery={pendingLinkedMessages.some(
            (item) => item.id === session.pendingPermission?.toolUseId && item.approved,
          )}
          onDecide={decidePermission}
        />
      ) : null}
      {pendingLinkedMessages
        .filter((item) => item.id !== session.pendingPermission?.toolUseId)
        .slice(0, 1)
        .map((item) => (
          <PermissionPrompt
            key={item.id}
            pending={{
              toolUseId: item.id,
              tool: 'verity_send_session_message',
              input: { targetSessionId: item.targetSessionId, message: item.message },
              riskClass: 'ask',
              createdAt: Date.parse(item.createdAt),
              grantChannel: 'acp',
            }}
            deciding={decidingLinkedMessage === item.id}
            dead={false}
            approvedForDelivery={item.approved}
            onDecide={decideLinkedMessage}
          />
        ))}
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
      branches.localMergeHasChanges &&
      branches.localMergeBase !== undefined &&
      branches.current !== undefined &&
      branches.current !== branches.localMergeBase &&
      !branches.workspaceMissing ? (
        <LocalMergeBar
          branch={branches.current}
          base={branches.localMergeBase}
          busy={working}
          onSave={onSaveToProject}
        />
      ) : null}
      {planning === 'active' ? (
        <PlanningBar deciding={decidingPlanning} error={planningError} onEnd={endPlanning} />
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
        voiceAutoMode={voice.autoMode}
        voiceCountdown={voice.countdown}
        onMic={voice.toggle}
        onMicLongPress={voice.startAuto}
        onPauseVoiceCountdown={voice.pauseCountdown}
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
        bottomInset={keyboardHeight === null ? insets.bottom : 0}
        horizontalInsets={
          embedded ? { left: 0, right: 0 } : { left: insets.left, right: insets.right }
        }
        compact={compactLandscape}
        keyboardHeight={keyboardHeight}
        onHeightChange={setInputBarHeight}
        attachments={attachments}
        knowledgeEnabled={Boolean(projectId)}
        saveAttachmentsToKnowledge={saveAttachmentsToKnowledge}
        onToggleSaveAttachmentsToKnowledge={() => setSaveAttachmentsToKnowledge((value) => !value)}
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
        onLiveMeeting={onLiveMeeting}
        googleConnected={googleConnected}
        onConnectGmail={onConnectGmail}
        onConnectCalendar={onConnectCalendar}
        onConnectContacts={onConnectContacts}
        onClose={() => setAttachMenuOpen(false)}
        onDismiss={runPendingPick}
      />
    </AnimatedKeyboardAvoidingView>
  );
}

// A round header action (Preview / Files / Bookmarks): an icon large enough to hit
// and recognise, with an optional status dot (e.g. a running dev server) or count
// badge. Long-press reports its name through `onHint`.
function HeaderActionButton({
  icon,
  label,
  accessibilityLabel,
  onPress,
  onHint,
  active = false,
  dot = false,
  dotTestID,
  badge,
  activeColor,
}: {
  icon: IconName;
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  onHint: (label: string) => void;
  active?: boolean;
  dot?: boolean;
  dotTestID?: string;
  badge?: number;
  /** Icon color while `active`; defaults to the primary blue. */
  activeColor?: string;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={() => onHint(label)}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.headerActionBtn, pressed ? styles.copyBtnPressed : null]}
    >
      <Icon
        name={icon}
        size={20}
        color={active ? (activeColor ?? theme.colors.primary) : theme.colors.textMuted}
      />
      {dot ? <View testID={dotTestID} style={styles.headerActionDot} /> : null}
      {badge !== undefined ? (
        <View style={styles.headerActionBadge}>
          <Text style={styles.headerActionBadgeText}>{badge > 99 ? '99+' : String(badge)}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

// The header's issue reference (#125): a bare `#123`. Tappable when `url` is a
// string (opens the GitHub issue via `Linking.openURL`, announced as a link) and
// then tinted like the app's other tappable meta; when `url` is null — owner/repo
// unknown (no GitHub remote / older server) — it stays plain, faint text and never
// links to a broken URL (#161).
function IssueRef({ number, url }: { number: number; url: string | null }) {
  const label = `#${String(number)}`;
  if (url === null) {
    return (
      <Text style={styles.headerBranch} accessibilityLabel={`Issue ${String(number)}`}>
        {label}
      </Text>
    );
  }
  return (
    <Pressable
      hitSlop={6}
      // openURL rejects only if no handler can open the (always https) URL; swallow
      // so it never surfaces as an unhandled rejection.
      onPress={() => void Linking.openURL(url).catch(() => undefined)}
      accessibilityRole="link"
      accessibilityLabel={`Issue ${String(number)}. Tap to open on GitHub.`}
    >
      <Text style={[styles.headerBranch, styles.headerIssueLink]}>{label}</Text>
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
  projectId,
  baseUrl,
  initialFilePath,
  initialRoot = 'worktree',
  onClose,
}: {
  client: VerityClient;
  sessionId: string;
  projectId: string | null;
  baseUrl: string;
  initialFilePath: string | null;
  initialRoot?: SessionFileRoot;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  const sheet = useResizableSheet();
  const compactRootLabels = Platform.OS === 'ios' && !Platform.isPad;
  const [path, setPath] = useState(initialFilePath ? parentPath(initialFilePath) : '');
  const [root, setRoot] = useState<SessionFileRoot>(initialRoot);
  const [entries, setEntries] = useState<SessionFileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SessionFileContent | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [driveActive, setDriveActive] = useState(false);
  const [driveCanWrite, setDriveCanWrite] = useState(false);
  const [driveFolderId, setDriveFolderId] = useState<string | null>(null);
  const [drivePath, setDrivePath] = useState<Array<{ id: string; name: string }>>([]);
  const [driveEntries, setDriveEntries] = useState<DriveFile[]>([]);
  const [driveUnconfigured, setDriveUnconfigured] = useState(false);
  // The file whose action menu is open, and the one being renamed. Both are drawn
  // over the sheet (see FileActionMenu), so they live here rather than in a row.
  const [menuFor, setMenuFor] = useState<{ path: string; inPreview: boolean } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editing, setEditing] = useState<SessionFileContent | null>(null);
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
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

  // Read by the deep-link effect below, which runs before `openWith` is declared
  // and must not refetch whenever its identity changes.
  const openWithRef = useRef<((filePath: string) => void) | null>(null);

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
      .getSessionFileContent(sessionId, initialFilePath, initialRoot)
      .then((file) => {
        if (active()) setPreview(file);
      })
      .catch((err) => {
        if (!active()) return;
        // Same hand-off as a tap in the list: a binary or oversized file opens in
        // another app instead of dead-ending on "file is not a text file".
        if (err instanceof VerityApiError && (err.status === 413 || err.status === 415)) {
          openWithRef.current?.(initialFilePath);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active()) setPreviewLoading(false);
      });
    return () => {
      previewRequest.current += 1;
    };
  }, [client, sessionId, initialFilePath, initialRoot]);

  useEffect(() => {
    if (driveActive) return;
    let active = true;
    setLoading(true);
    setError(null);
    void client
      .listSessionFiles(sessionId, path, root)
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
  }, [client, driveActive, sessionId, path, root, reloadKey]);

  useEffect(() => {
    if (!driveActive || !projectId) return;
    let active = true;
    const loadDrive = async (): Promise<void> => {
      setLoading(true);
      setError(null);
      setDriveUnconfigured(false);
      try {
        let folderId = driveFolderId;
        let nextPath = drivePath;
        const detail = await client.getProject(projectId);
        const configuredFolderId = detail.settings?.googleDriveFolderId ?? null;
        const folderName = detail.settings?.googleDriveFolderName ?? null;
        if (active) setDriveCanWrite(detail.settings?.googleDriveAccessMode !== 'read-only');
        if (!configuredFolderId || !folderName) {
          if (active) {
            setDriveEntries([]);
            setDriveFolderId(null);
            setDriveCanWrite(false);
            setDriveUnconfigured(true);
          }
          return;
        }
        if (!folderId || folderId !== configuredFolderId) {
          folderId = configuredFolderId;
          nextPath = [{ id: folderId, name: folderName }];
          if (active) {
            setDriveFolderId(folderId);
            setDrivePath(nextPath);
          }
        }
        const parentId = nextPath.at(-1)?.id ?? folderId;
        const page = await client.listProjectGoogleDriveFiles(projectId, folderId, { parentId });
        if (active) setDriveEntries(page.files);
      } catch (caught) {
        if (active) {
          setDriveEntries([]);
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void loadDrive();
    return () => {
      active = false;
    };
  }, [client, driveActive, driveFolderId, drivePath, projectId, reloadKey]);

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
            root,
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
  }, [client, path, root, sessionId]);

  const uploadDriveFiles = useCallback(() => {
    if (!projectId || !driveFolderId || drivePath.length === 0 || !driveCanWrite) return;
    void (async () => {
      let picked: Awaited<ReturnType<typeof pickSessionFiles>> = [];
      try {
        picked = await pickSessionFiles();
        if (picked.length === 0) return;
        setUploading(true);
        for (const file of picked) {
          await client.uploadProjectGoogleDriveFile(projectId, driveFolderId, {
            parentId: drivePath.at(-1)?.id,
            fileName: file.fileName,
            mimeType: 'application/octet-stream',
            data: new FsFile(file.uri),
          });
        }
        setReloadKey((key) => key + 1);
      } catch (caught) {
        Alert.alert(
          'Could not upload file',
          caught instanceof Error ? caught.message : String(caught),
        );
      } finally {
        for (const file of picked) {
          try {
            new FsFile(file.uri).delete();
          } catch {
            // Best effort cleanup of the document picker cache copy.
          }
        }
        setUploading(false);
      }
    })();
  }, [client, driveFolderId, drivePath, projectId, driveCanWrite]);

  const openDriveFile = useCallback(
    (file: DriveFile) => {
      if (!projectId || !driveFolderId) return;
      const canUseInChat = new Set([
        'application/vnd.google-apps.document',
        'application/vnd.google-apps.spreadsheet',
        'application/vnd.google-apps.presentation',
      ]).has(file.mimeType);
      Alert.alert(
        file.name,
        'This file stays in Google Drive.',
        [
          ...(Platform.OS === 'android' && canUseInChat && file.webViewLink
            ? []
            : [{ text: 'Cancel', style: 'cancel' as const }]),
          ...(file.webViewLink
            ? [
                {
                  text: 'Open in Google Drive',
                  onPress: () => void Linking.openURL(file.webViewLink!),
                },
              ]
            : []),
          ...(canUseInChat
            ? [
                {
                  text: 'Use in this chat',
                  onPress: () => {
                    setMutating(true);
                    void (async () => {
                      if (!(await ensureGoogleWorkspaceAccess(client, file.mimeType))) return;
                      await client.assignSessionGoogleWorkspaceFile(sessionId, file.id);
                      onClose();
                    })()
                      .catch((caught: unknown) =>
                        Alert.alert(
                          'Could not use file in chat',
                          caught instanceof Error ? caught.message : String(caught),
                        ),
                      )
                      .finally(() => setMutating(false));
                  },
                },
              ]
            : []),
          {
            text: 'Add to Project Knowledge',
            onPress: () => {
              setMutating(true);
              void client
                .importProjectGoogleDriveFile(projectId, driveFolderId, file.id)
                .then((result) => Alert.alert('Added to Project Knowledge', result.path))
                .catch((caught: unknown) =>
                  Alert.alert(
                    'Could not add file',
                    caught instanceof Error ? caught.message : String(caught),
                  ),
                )
                .finally(() => setMutating(false));
            },
          },
        ],
        { cancelable: true },
      );
    },
    [client, driveFolderId, onClose, projectId, sessionId],
  );

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
                data: await droppedFileData(file.uri),
                root,
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
              releaseDroppedFile(file.uri);
            } catch {
              // Best effort; the OS also clears the app's temporary directory.
            }
          }
          if (uploaded) setReloadKey((key) => key + 1);
          setUploading(false);
        }
      })();
    },
    [client, path, root, sessionId],
  );

  const onUploadDropRejected = useCallback((errors: string[]) => {
    if (errors.length > 0) Alert.alert('Could not upload', errors.join('\n'));
  }, []);

  const openWith = useCallback(
    (filePath: string) => {
      void (async () => {
        const url = client.sessionFileDownloadUrl(sessionId, filePath, root);
        try {
          if (Platform.OS === 'web') {
            const blob = await client.downloadSessionFile(sessionId, filePath, root);
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
          if (isDemoMode()) {
            const { content } = await client.getSessionFileContent(sessionId, filePath, root);
            destination.write(content);
            const sharing = await loadSharingModule();
            if (sharing !== undefined && (await sharing.isAvailableAsync())) {
              await sharing.shareAsync(destination.uri, {
                mimeType: mimeTypeForFile(filePath),
                dialogTitle: `Open ${fileNameFromPath(filePath)}`,
              });
            }
            return;
          }
          const headers =
            token !== null && token.length > 0 ? { authorization: `Bearer ${token}` } : undefined;
          const file = directTlsPin
            ? new FsFile(
                await downloadPinnedFile({
                  url,
                  destination: destination.uri,
                  tlsPin: directTlsPin,
                  useRemote: true,
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
    [baseUrl, client, directTlsPin, root, sessionId],
  );
  openWithRef.current = openWith;

  // Print or export the previewed text file. Sharing the raw file never offers
  // "Print" on iOS — the system prints only content it renders itself, PDFs and
  // images — so the file goes through HTML instead: straight to the print dialog,
  // or into a PDF that the share sheet can print, mail or save.
  // Rendering a long file takes seconds with no dialog on screen yet; a second tap
  // would stack print dialogs or overwrite the PDF the first share is still reading.
  const exporting = useRef(false);
  const exportPreview = useCallback(
    (file: { path: string; content: string }, mode: 'print' | 'pdf') => {
      if (exporting.current) return;
      exporting.current = true;
      void (async () => {
        try {
          const print = await loadPrintModule();
          if (print === undefined) throw new Error('Printing is not available in this build');
          const html = printableFileHtml(file.path, file.content);
          if (mode === 'print') {
            try {
              await print.printAsync({ html, margins: PRINT_MARGINS });
            } catch (err) {
              // iOS rejects a print dialog the operator simply dismissed.
              if (err instanceof Error && /did not complete/i.test(err.message)) return;
              throw err;
            }
            return;
          }
          const rendered = await print.printToFileAsync({ html, margins: PRINT_MARGINS });
          const cacheDir = new FsDirectory(
            Paths.cache,
            cacheDirectoryName(sessionId, `${file.path}.pdf`),
          );
          cacheDir.create({ idempotent: true, intermediates: true });
          const pdf = new FsFile(cacheDir, pdfFileName(file.path));
          await new FsFile(rendered.uri).move(pdf, { overwrite: true });
          const sharing = await loadSharingModule();
          if (sharing === undefined || !(await sharing.isAvailableAsync())) {
            throw new Error('No app is available to share this PDF');
          }
          await sharing.shareAsync(pdf.uri, {
            mimeType: 'application/pdf',
            UTI: 'com.adobe.pdf',
            dialogTitle: `Share ${pdfFileName(file.path)}`,
          });
        } catch (err) {
          Alert.alert(
            mode === 'print' ? 'Could not print file' : 'Could not create PDF',
            err instanceof Error ? err.message : String(err),
          );
        } finally {
          exporting.current = false;
        }
      })();
    },
    [sessionId],
  );

  const chooseExport = useCallback(
    (file: { path: string; content: string }) => {
      Alert.alert(fileNameFromPath(file.path), undefined, [
        { text: 'Print', onPress: () => exportPreview(file, 'print') },
        { text: 'Share as PDF', onPress: () => exportPreview(file, 'pdf') },
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [exportPreview],
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
        .getSessionFileContent(sessionId, entry.path, root)
        .then((file) => {
          if (previewRequest.current !== request) return;
          setPreview(file);
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
    [client, sessionId, openWith, root],
  );

  const toggleSelected = useCallback((entry: SessionFileEntry) => {
    if (!isSelectableFile(entry)) return;
    modifierClick.current = { anchor: entry.path, range: [] };
    setSelected((current) => toggleFileSelection(current, entry.path));
  }, []);

  // Selection starts from a row, never from the header: the file you held or
  // chose "Select" for is the first one picked, so the mode never opens empty.
  const startSelection = useCallback(
    (entry: SessionFileEntry) => {
      if (mutating || driveActive || !isSelectableFile(entry)) return;
      modifierClick.current = { anchor: entry.path, range: [] };
      setSelected([entry.path]);
      setSelecting(true);
      void Haptics.selectionAsync();
    },
    [driveActive, mutating],
  );

  const endSelection = useCallback(() => {
    setSelecting(false);
    setSelected([]);
    modifierClick.current = { anchor: null, range: [] };
  }, []);

  // One confirmation for every delete, from a row's menu, the open file or the
  // selection. It names the files and the root they leave: Shared is read by
  // every project, so "this file" is not enough to know what is at stake.
  const confirmDelete = useCallback(
    (
      paths: readonly string[],
      onDeleted: (deleted: readonly string[], complete: boolean) => void,
    ) => {
      if (mutating || paths.length === 0) return;
      setMutating(true);
      const names = paths.slice(0, 5).map((filePath) => `• ${fileNameFromPath(filePath)}`);
      if (paths.length > names.length) names.push(`… and ${paths.length - names.length} more`);
      Alert.alert(
        paths.length === 1 ? 'Delete file?' : `Delete ${paths.length} files?`,
        `${names.join('\n')}\n\n${
          root === 'worktree'
            ? 'This permanently removes them from the workspace.'
            : root === 'shared'
              ? 'This removes them from Global Knowledge, for every project, with their extracted text.'
              : 'This removes them from the project with their extracted text.'
        }`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => setMutating(false) },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                const deleted: string[] = [];
                try {
                  for (const filePath of paths) {
                    await client.deleteSessionFile(sessionId, root, filePath);
                    deleted.push(filePath);
                  }
                  onDeleted(deleted, true);
                } catch (err) {
                  onDeleted(deleted, false);
                  Alert.alert(
                    'Could not delete file',
                    err instanceof Error ? err.message : String(err),
                  );
                } finally {
                  if (deleted.length > 0) setReloadKey((key) => key + 1);
                  setMutating(false);
                }
              })();
            },
          },
        ],
        { cancelable: false },
      );
    },
    [client, mutating, root, sessionId],
  );

  const deleteSelectedFiles = useCallback(() => {
    confirmDelete(selected, (deleted, complete) => {
      if (complete) endSelection();
      else setSelected((current) => current.filter((path) => !deleted.includes(path)));
    });
  }, [confirmDelete, endSelection, selected]);

  const closePreview = useCallback(() => {
    // Also drops a fetch still in flight, so leaving the preview can't be undone
    // a second later by a slow response.
    previewRequest.current += 1;
    setPreview(null);
    setPreviewLoading(false);
  }, []);

  const renameFile = useCallback(
    async (filePath: string, name: string) => {
      setMutating(true);
      try {
        const renamed = await client.renameSessionFile(sessionId, root, filePath, name);
        setPreview((current) =>
          current?.path === filePath ? { ...current, path: renamed.path } : current,
        );
        setRenaming(null);
        setReloadKey((key) => key + 1);
      } catch (err) {
        // A server from before worktree renames answers with the knowledge-only
        // refusal, which reads as nonsense on the Files tab.
        if (
          err instanceof VerityApiError &&
          err.status === 400 &&
          root === 'worktree' &&
          /only knowledge files/.test(err.message)
        ) {
          throw new Error('Update the Verity server to rename files here.');
        }
        throw err;
      } finally {
        setMutating(false);
      }
    },
    [client, root, sessionId],
  );

  const selectableEntries = useMemo(() => entries.filter(isSelectableFile), [entries]);
  const allSelected =
    selectableEntries.length > 0 &&
    selectableEntries.every((entry) => selected.includes(entry.path));

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
      if (mutating) return;
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
    [entries, mutating, openFile, selected, selecting, toggleSelected],
  );

  const downloadUrlFor = useCallback(
    (filePath: string) => client.sessionFileDownloadUrl(sessionId, filePath, root),
    [client, root, sessionId],
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

  const editFile = async (filePath: string) => {
    if (mutating) return;
    setMutating(true);
    try {
      const file = await client.getSessionFileContent(sessionId, filePath, root);
      if (file.editable === false) throw new Error('This preview is read-only.');
      if (!file.version || !file.editable)
        throw new Error('Update the Verity server to edit text files.');
      setEditing(file);
    } catch (error) {
      Alert.alert('Could not edit file', error instanceof Error ? error.message : String(error));
    } finally {
      setMutating(false);
    }
  };
  const menuActions: FileAction[] =
    menuFor === null
      ? []
      : [
          ...(!menuFor.inPreview
            ? [
                {
                  key: 'open',
                  label: 'Open',
                  icon: 'file' as const,
                  onPress: () => {
                    const entry = entries.find((entry) => entry.path === menuFor.path);
                    if (entry) void openFile(entry);
                  },
                },
              ]
            : []),
          ...(() => {
            // Offered only where it will do something: a file past the download
            // limit has a menu but cannot be selected (see isSelectableFile).
            const entry = entries.find((entry) => entry.path === menuFor.path);
            return !menuFor.inPreview && !driveActive && entry && isSelectableFile(entry)
              ? [
                  {
                    key: 'select',
                    label: 'Select',
                    icon: 'check-circle' as const,
                    onPress: () => startSelection(entry),
                  },
                ]
              : [];
          })(),
          ...(menuFor.inPreview && preview
            ? [
                {
                  // Chunked rendering means native text selection stops at each
                  // block, so drag-selecting the whole file does not work — this
                  // copies the exact content the server returned instead.
                  key: 'copy',
                  label: 'Copy contents',
                  icon: 'copy' as const,
                  onPress: () => {
                    void Clipboard.setStringAsync(preview.content)
                      .then(() =>
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
                      )
                      .catch((err: unknown) =>
                        Alert.alert(
                          'Could not copy',
                          err instanceof Error ? err.message : String(err),
                        ),
                      );
                  },
                },
              ]
            : []),
          ...(menuFor.inPreview && preview && Platform.OS !== 'web'
            ? [
                {
                  key: 'export',
                  label: 'Print or share as PDF',
                  icon: 'printer' as const,
                  onPress: () => chooseExport(preview),
                },
              ]
            : []),
          {
            key: 'open-with',
            label: 'Open with another app',
            icon: 'share' as const,
            onPress: () => openWith(menuFor.path),
          },
          // An open file already has Edit in its header; listing it twice would
          // make the menu disagree with the bar above it about where editing lives.
          ...(isTextPreviewCandidate(menuFor.path) && !menuFor.inPreview
            ? [
                {
                  key: 'edit',
                  label: 'Edit text',
                  icon: 'edit' as const,
                  onPress: () => {
                    void editFile(menuFor.path);
                  },
                },
              ]
            : []),
          {
            key: 'rename',
            label: 'Rename…',
            icon: 'edit-3' as const,
            onPress: () => setRenaming(menuFor.path),
          },
          {
            key: 'delete',
            label: 'Delete…',
            icon: 'trash-2' as const,
            destructive: true,
            onPress: () =>
              confirmDelete([menuFor.path], (deleted) => {
                if (deleted.length === 0) return;
                setSelected((current) => current.filter((path) => !deleted.includes(path)));
                if (menuFor.inPreview) closePreview();
              }),
          },
        ];

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} accessibilityRole="button">
        <View />
      </Pressable>
      <Animated.View style={[styles.sheet, sheet.sheetStyle]}>
        <SheetResizeHandle panHandlers={sheet.panHandlers} />
        {!preview ? (
          selecting ? (
            <FileSheetHeader
              leading={
                <HeaderTextButton
                  label={allSelected ? 'Select None' : 'Select All'}
                  disabled={mutating}
                  onPress={() => {
                    modifierClick.current = { anchor: null, range: [] };
                    setSelected(allSelected ? [] : selectableEntries.map((entry) => entry.path));
                  }}
                />
              }
              title={selected.length > 0 ? selectionSummary(selected.length) : 'Select files'}
              trailing={
                // Text, not a glyph: the old toggle turned into an X beside the X
                // that closes the sheet, and nobody could tell which ended what.
                <HeaderTextButton
                  label="Done"
                  emphasis="strong"
                  disabled={mutating}
                  accessibilityLabel="Done selecting files"
                  onPress={endSelection}
                />
              }
            />
          ) : (
            <FileSheetHeader
              title="Files"
              trailing={
                <>
                  {/* One way in to adding, as in every file app's toolbar. Selecting
                      is not up here: a long press on a row starts it, as does
                      "Select" in the row's menu, so the bar stays two glyphs. */}
                  <HeaderIconButton
                    icon={driveActive ? 'upload' : 'plus'}
                    tint
                    busy={uploading}
                    disabled={
                      mutating ||
                      error !== null ||
                      (driveActive && (driveUnconfigured || !driveCanWrite))
                    }
                    accessibilityLabel={
                      driveActive
                        ? driveCanWrite
                          ? 'Upload files to Google Drive'
                          : 'Google Drive is read-only'
                        : 'New or upload files'
                    }
                    onPress={driveActive ? uploadDriveFiles : () => setAdding(true)}
                  />
                  <HeaderIconButton icon="x" accessibilityLabel="Close files" onPress={onClose} />
                </>
              }
            />
          )
        ) : null}
        {!preview ? (
          <View style={styles.filesRootBar}>
            {(
              [
                ['worktree', compactRootLabels ? 'Repo' : 'Repository'],
                ['knowledge', compactRootLabels ? 'Project' : 'Project Knowledge'],
                ['shared', compactRootLabels ? 'Global' : 'Global Knowledge'],
              ] as const
            ).map(([candidate, label]) => (
              <Pressable
                key={candidate}
                disabled={mutating}
                onPress={() => {
                  if (mutating || (!driveActive && candidate === root && path === '')) return;
                  previewRequest.current += 1;
                  endSelection();
                  setDriveActive(false);
                  setRoot(candidate);
                  setPath('');
                  setEntries([]);
                  setTruncated(false);
                  setLoading(true);
                  setPreview(null);
                  setPreviewLoading(false);
                  setError(null);
                }}
                accessibilityRole="tab"
                accessibilityState={{ selected: !driveActive && root === candidate }}
                accessibilityLabel={label}
                style={[
                  styles.filesRootButton,
                  !driveActive && root === candidate ? styles.filesRootButtonActive : null,
                ]}
              >
                <Icon
                  name={FILE_ROOT_ICON[candidate]}
                  size={14}
                  color={
                    !driveActive && root === candidate ? theme.colors.text : theme.colors.textMuted
                  }
                />
                <Text
                  style={
                    !driveActive && root === candidate
                      ? styles.filesRootLabelActive
                      : styles.filesRootLabel
                  }
                >
                  {label}
                </Text>
              </Pressable>
            ))}
            {projectId ? (
              <Pressable
                disabled={mutating}
                onPress={() => {
                  if (driveActive) return;
                  previewRequest.current += 1;
                  endSelection();
                  setDriveActive(true);
                  setLoading(true);
                  setPreview(null);
                  setError(null);
                }}
                accessibilityRole="tab"
                accessibilityState={{ selected: driveActive }}
                accessibilityLabel="Google Drive"
                style={[styles.filesRootButton, driveActive ? styles.filesRootButtonActive : null]}
              >
                <Icon
                  name="hard-drive"
                  size={14}
                  color={driveActive ? theme.colors.text : theme.colors.textMuted}
                />
                <Text style={driveActive ? styles.filesRootLabelActive : styles.filesRootLabel}>
                  Google Drive
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {preview ? null : driveActive ? (
          drivePath.length > 1 ? (
            <FileBreadcrumb
              rootIcon="hard-drive"
              rootLabel={drivePath[0]?.name ?? 'Google Drive'}
              segments={drivePath.slice(1).map(({ id, name }) => ({ key: id, name }))}
              disabled={mutating}
              onNavigate={(index) => setDrivePath((current) => current.slice(0, index + 2))}
            />
          ) : null
        ) : path ? (
          // At the top of a tab the tab itself says where you are; a breadcrumb
          // of nothing but the root would be a control with nowhere to go.
          <FileBreadcrumb
            rootIcon={FILE_ROOT_ICON[root]}
            rootLabel={
              root === 'worktree'
                ? 'Repository'
                : root === 'knowledge'
                  ? 'Project Knowledge'
                  : 'Global Knowledge'
            }
            segments={breadcrumbSegments(path).map((segment) => ({
              key: segment.path,
              name: segment.name,
            }))}
            disabled={mutating || selecting}
            onNavigate={(index) => setPath(index < 0 ? '' : breadcrumbSegments(path)[index]!.path)}
          />
        ) : null}
        {driveActive ? (
          <ScrollView style={styles.filesList}>
            {error ? <Text style={styles.sheetError}>{error}</Text> : null}
            {driveUnconfigured && projectId ? (
              <View style={styles.driveSetupNotice}>
                <Icon name="hard-drive" size={28} color={theme.colors.textFaint} />
                <Text style={styles.emptyTitle}>No Google Drive folder</Text>
                <Text style={styles.emptySubtitle}>
                  Connect a folder in the project settings to use its documents in this project.
                </Text>
                <Pressable
                  onPress={() => {
                    onClose();
                    router.push({
                      pathname: '/project/[id]/settings/services',
                      params: { id: projectId, section: 'drive' },
                    });
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Open project settings to connect Google Drive"
                  style={({ pressed }) => [
                    styles.driveSetupButton,
                    pressed ? styles.driveSetupButtonPressed : null,
                  ]}
                >
                  <Text style={styles.driveSetupButtonLabel}>Connect a folder</Text>
                </Pressable>
              </View>
            ) : loading ? (
              <View style={styles.sheetLoading}>
                <ActivityIndicator color={theme.colors.textMuted} />
              </View>
            ) : driveEntries.length === 0 && !error ? (
              <Text style={styles.sheetEmpty}>This folder is empty.</Text>
            ) : (
              driveEntries.map((file) => {
                const folder = file.mimeType === 'application/vnd.google-apps.folder';
                return (
                  <Pressable
                    key={file.id}
                    onPress={() =>
                      folder
                        ? setDrivePath((current) => [...current, { id: file.id, name: file.name }])
                        : openDriveFile(file)
                    }
                    disabled={mutating}
                    accessibilityRole="button"
                    accessibilityLabel={folder ? `Open folder ${file.name}` : file.name}
                    style={({ pressed }) => [
                      styles.fileRow,
                      pressed ? styles.sheetRowPressed : null,
                    ]}
                  >
                    <Icon
                      name={folder ? 'folder' : 'file'}
                      size={18}
                      color={theme.colors.textMuted}
                    />
                    <View style={styles.fileMain}>
                      <Text style={[styles.sheetRowLabel, styles.fileName]} numberOfLines={2}>
                        {file.name}
                      </Text>
                    </View>
                    <Icon
                      name={folder ? 'chevron-right' : 'more-horizontal'}
                      size={17}
                      color={theme.colors.textFaint}
                    />
                  </Pressable>
                );
              })
            )}
          </ScrollView>
        ) : preview ? (
          <View style={styles.filesPreviewWrap}>
            <FileSheetHeader
              leading={
                <HeaderIconButton
                  icon="chevron-left"
                  accessibilityLabel="Back to file list"
                  onPress={closePreview}
                />
              }
              title={fileNameFromPath(preview.path)}
              subtitle={parentPath(preview.path) || null}
              trailing={
                <>
                  {preview.editable && preview.version ? (
                    <HeaderTextButton
                      label="Edit"
                      disabled={mutating}
                      onPress={() => setEditing(preview)}
                    />
                  ) : null}
                  <HeaderIconButton
                    icon="more-horizontal"
                    disabled={mutating}
                    accessibilityLabel={`More actions for ${fileNameFromPath(preview.path)}`}
                    onPress={() => setMenuFor({ path: preview.path, inPreview: true })}
                  />
                  <HeaderIconButton icon="x" accessibilityLabel="Close files" onPress={onClose} />
                </>
              }
            />
            <FileContentPreview
              key={preview.path}
              path={preview.path}
              content={preview.content}
              listStyle={styles.filesPreview}
              bodyStyle={styles.filesPreviewBody}
              textStyle={styles.filesPreviewText}
              renderMarkdown={(item) =>
                item.type === 'table' ? (
                  <MarkdownTable header={item.header} rows={item.rows} />
                ) : item.type === 'code' ? (
                  <View style={styles.codeBlock}>
                    {item.lang ? <Text style={styles.codeLang}>{item.lang}</Text> : null}
                    <Text selectable style={styles.codeText}>
                      {item.content}
                    </Text>
                  </View>
                ) : (
                  <MarkdownLine
                    line={item.content}
                    onOpenLocalFile={null}
                    sessionFileImageSource={null}
                    onOpenImage={() => {}}
                  />
                )
              }
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
                          enabled={!isDemoMode()}
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
                          {entry.kind === 'directory' && !selecting ? (
                            <SessionFolderRow
                              name={entry.name}
                              onPress={() => pressFileRow(entry)}
                              accessibilityLabel={entry.name}
                            />
                          ) : (
                            <Pressable
                              onPress={() => {
                                pressFileRow(entry);
                              }}
                              // Not on iPad, where a long press is the lift that
                              // starts a native drag (UIDragInteraction is off on
                              // iPhone by default); both firing at ~500 ms would
                              // race. There the row menu and ⌘-click remain.
                              onLongPress={
                                !selecting && selectable && !longPressDrags
                                  ? () => startSelection(entry)
                                  : undefined
                              }
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
                              <Icon
                                name={fileIcon(entry)}
                                size={18}
                                color={theme.colors.textMuted}
                              />
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
                                    name={picked ? 'check-circle' : 'circle'}
                                    size={18}
                                    color={picked ? theme.colors.primary : theme.colors.textFaint}
                                  />
                                </View>
                              ) : entry.kind === 'file' ? (
                                <Pressable
                                  onPress={() => setMenuFor({ path: entry.path, inPreview: false })}
                                  disabled={mutating}
                                  hitSlop={8}
                                  accessibilityRole="button"
                                  accessibilityLabel={`More actions for ${entry.name}`}
                                  style={styles.fileDownload}
                                >
                                  <Icon
                                    name="more-horizontal"
                                    size={18}
                                    color={theme.colors.textMuted}
                                  />
                                </Pressable>
                              ) : (
                                <Icon
                                  name="chevron-right"
                                  size={17}
                                  color={theme.colors.textFaint}
                                />
                              )}
                            </Pressable>
                          )}
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
            {selecting ? (
              <View style={styles.filesSelectionBar}>
                {selected.length === 0 ? (
                  <Text style={styles.filesPath}>Tap files to select them</Text>
                ) : (
                  <View />
                )}
                <HeaderTextButton
                  label="Delete…"
                  emphasis="destructive"
                  disabled={mutating || selected.length === 0}
                  accessibilityLabel="Delete selected files"
                  onPress={deleteSelectedFiles}
                />
              </View>
            ) : null}
          </>
        )}
        {menuFor ? (
          <FileActionMenu
            title={fileNameFromPath(menuFor.path)}
            actions={menuActions}
            onDismiss={() => setMenuFor(null)}
          />
        ) : null}
        {adding ? (
          <FileActionMenu
            title="Add files"
            onDismiss={() => setAdding(false)}
            actions={[
              {
                key: 'create',
                label: 'New Markdown file…',
                icon: 'file-plus',
                onPress: () => setCreating(true),
              },
              { key: 'upload', label: 'Upload files…', icon: 'upload', onPress: uploadFiles },
            ]}
          />
        ) : null}
        {creating ? (
          <FileNameDialog
            title="New Markdown file"
            initialName="note.md"
            allowUnchanged
            confirmLabel="Create"
            validate={(name) =>
              renameProblem(
                name,
                '',
                entries.map((entry) => entry.name),
              ) ?? (!/\.md$/i.test(name) ? 'Use a .md extension.' : null)
            }
            onCancel={() => setCreating(false)}
            onSubmit={async (name) => {
              setCreating(false);
              setEditing({
                path: [path, name].filter(Boolean).join('/'),
                content: '',
                size: 0,
                editable: true,
              });
            }}
          />
        ) : null}
        {editing ? (
          <FileTextEditor
            file={editing}
            onCancel={() => setEditing(null)}
            onRead={(filePath) => client.getSessionFileContent(sessionId, filePath, root)}
            onHistory={() => client.listSessionFileVersions(sessionId, root, editing.path)}
            onVersion={(version) =>
              client.readSessionFileVersion(sessionId, root, editing.path, version)
            }
            onSave={(filePath, content, version) =>
              client.saveSessionFileContent(sessionId, root, filePath, content, version)
            }
            onSaved={(file) => {
              if (file.warning) Alert.alert('File saved', file.warning);
              setEditing(null);
              setPreview(file);
              setPath(parentPath(file.path));
              setReloadKey((key) => key + 1);
            }}
          />
        ) : null}
        {renaming ? (
          <FileNameDialog
            title="Rename file"
            subtitle={parentPath(renaming) ? `in /${parentPath(renaming)}` : undefined}
            initialName={fileNameFromPath(renaming)}
            confirmLabel="Rename"
            validate={(name) =>
              renameProblem(
                name,
                fileNameFromPath(renaming),
                entries.filter((entry) => entry.path !== renaming).map((entry) => entry.name),
              )
            }
            onSubmit={(name) => renameFile(renaming, name)}
            onCancel={() => setRenaming(null)}
          />
        ) : null}
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
  // Keyed by the snapshot and its open state, so a cell recycled from (or into) the
  // open checklist does not keep the other's height or toggled state.
  if (item.kind === 'plan')
    return (
      <PlanCard
        key={`${item.message.id}:${String(item.latest)}`}
        plan={item.plan}
        latest={item.latest}
      />
    );
  if (item.kind === 'plan-proposal')
    return (
      <PlanProposalCard
        key={`${item.message.id}:${String(item.latest)}`}
        markdown={item.markdown}
        latest={item.latest}
        revision={planProposalRevision(item.message.tool)}
      />
    );
  switch (item.message.kind) {
    case 'user-text':
      return <UserBubble message={item.message} />;
    case 'agent-text':
      return <AgentBlock message={item.message} bookmarkable={bookmarkable} />;
    case 'tool-call':
      return <ToolCard key={item.message.id} message={item.message} />; // single tool not in a run
    case 'agent-event':
      return <EventRow message={item.message} />;
    case 'dependency-status':
      return <DependencyStatusRow text={item.message.text} />;
    case 'choices':
      // Interactive only while this is the LATEST row; `renderItem` computes that from
      // the chat list order. Once the operator answers, a newer row makes it no longer
      // latest and the chips freeze (#97: stale chips deactivate).
      return <ChoicesRow message={item.message} isLatest={isLatest} />;
    case 'automation-proposal':
      return <AutomationProposalRow message={item.message} />;
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
      <View style={[styles.userRow, message.peer ? styles.peerRow : null]}>
        <View
          style={[
            styles.userBubble,
            message.peer ? styles.peerBubble : null,
            pending ? styles.userBubblePending : null,
          ]}
        >
          {message.peer ? (
            <Text style={styles.peerSource} accessibilityLabel={`Agent from ${message.peer.label}`}>
              Agent · {message.peer.label}
            </Text>
          ) : null}
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
  iconSize = 15,
}: {
  value: string;
  label?: string;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel: string;
  iconSize?: number;
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
      <Icon name={copied ? 'check' : 'copy'} size={iconSize} color={tint} />
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
// AgentBlock); when set, the tap-reveal row gains a "…" button beside Copy that opens
// the bookmark / Project Knowledge actions, and a persistent dog-ear marks a
// bookmarked message while scrolling.
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
  const [imagePathViewer, setImagePathViewer] = useState<string | null>(null);
  // The files sheet previews text only, so an image link opened there reads as
  // "file is not a text file"; show the image full screen instead.
  const openLocalFile = useMemo(() => {
    if (openSessionFile === null) return null;
    return (path: string, root: SessionFileRoot = 'worktree') => {
      if (root === 'worktree' && sessionFileImageSource !== null && isSessionImageFilePath(path)) {
        setImagePathViewer(path);
      } else {
        openSessionFile(path, root);
      }
    };
  }, [openSessionFile, sessionFileImageSource]);
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
  const knowledge = useContext(KnowledgeSaveContext);
  const [knowledgeSavedFor, setKnowledgeSavedFor] = useState<string>();
  const knowledgeSaved = messageId != null && knowledgeSavedFor === messageId;
  const bookmarked = messageId != null && bookmarks?.isBookmarked(messageId) === true;
  const hasMoreActions = messageId != null && (bookmarks !== null || knowledge !== null);
  // The "…" menu opens at the button that was tapped, so it's obvious which message
  // it acts on. Keyed by message (like knowledgeSavedFor) so a recycled list cell
  // never opens it for a different message.
  const moreRef = useRef<View>(null);
  const [actionsMenu, setActionsMenu] = useState<{ messageId: string; anchor: MenuAnchor }>();
  const actionsOpen = messageId != null && actionsMenu?.messageId === messageId;
  const closeActions = useCallback(() => {
    setActionsMenu(undefined);
    setShowCopy(false);
  }, []);
  const showActions = useCallback(
    (anchor: MenuAnchor) => {
      if (messageId == null) return;
      // Keep the message highlighted with its action row while the menu is open.
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setActionsMenu({ messageId, anchor });
    },
    [messageId],
  );
  // Measured after any keyboard dismissal settles (the Modal would dismiss it and
  // leave the menu at a stale position), same as the composer's attachment menu.
  const measureActions = useAttachmentMenuAnchor(moreRef, showActions);
  // The measurement waits for any keyboard dismissal, so hold the action row (and
  // the button being measured) for the whole press, then give the auto-hide a fresh
  // window — a cancelled press hides it as usual, a completed one is cleared again
  // by showActions.
  const holdActionRow = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);
  const releaseActionRow = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowCopy(false), 4000);
  }, []);
  return (
    <>
      <Pressable
        onPress={toggleCopy}
        // Not an a11y element itself: keep the prose readable as individual nodes
        // rather than collapsing the whole message into one button. Copy is exposed
        // via the CopyButton's own a11y (and the reveal gesture is a sighted-user
        // convenience). VoiceOver users get per-block selection + the code badges.
        accessible={false}
      >
        <View style={[styles.agentBlock, (showCopy || actionsOpen) && styles.agentBlockActive]}>
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
                onOpenLocalFile={openLocalFile}
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
          {imagePathViewer !== null && sessionFileImageSource !== null ? (
            <SessionFileImageViewer
              path={imagePathViewer}
              sessionFileImageSource={sessionFileImageSource}
              onClose={() => setImagePathViewer(null)}
              onUnavailable={() => {
                setImagePathViewer(null);
                openSessionFile?.(imagePathViewer);
              }}
            />
          ) : null}
          {/* Persistent dog-ear: shows a bookmarked message is marked even at rest (no
            reveal needed), so it's spottable while scrolling — the Kindle affordance.
            Non-interactive so it never fights the tap-to-reveal / long-press-select
            gestures; toggling off happens via the "…" sheet or the header sheet. */}
          {bookmarked && !showCopy && !actionsOpen ? (
            <View style={styles.msgBookmarkFlag} pointerEvents="none">
              <Icon name="bookmark" size={13} color={theme.colors.primary} />
            </View>
          ) : null}
          {showCopy || actionsOpen ? (
            <View style={styles.msgActions}>
              {/* Copy stays one tap away; everything else lives behind "…" in a menu
                that names each action, since bare icons (an open book for Project
                Knowledge) didn't explain themselves. */}
              {hasMoreActions ? (
                <Pressable
                  ref={moreRef}
                  onPressIn={holdActionRow}
                  onPressOut={releaseActionRow}
                  onPress={measureActions}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="More message actions"
                  style={({ pressed }) => [
                    styles.copyBtn,
                    styles.msgActionBtn,
                    pressed ? styles.copyBtnPressed : null,
                  ]}
                >
                  <Icon name="more-horizontal" size={18} color={theme.colors.text} />
                </Pressable>
              ) : null}
              <CopyButton
                value={text}
                accessibilityLabel="Copy message"
                iconSize={18}
                style={styles.msgActionBtn}
              />
            </View>
          ) : null}
        </View>
      </Pressable>
      {/* Outside the message Pressable: the Modal's content stays in this React tree,
        so taps on the menu would otherwise bubble into the message's tap-to-reveal. */}
      {actionsOpen && actionsMenu && messageId != null ? (
        <MessageActionsMenu
          anchor={actionsMenu.anchor}
          onClose={closeActions}
          onCopy={() => {
            void Clipboard.setStringAsync(text);
            closeActions();
          }}
          knowledge={
            knowledge
              ? {
                  saved: knowledgeSaved,
                  save: () =>
                    knowledge.save(messageId, text).then(() => setKnowledgeSavedFor(messageId)),
                }
              : null
          }
          bookmark={
            bookmarks
              ? {
                  bookmarked,
                  toggle: () => {
                    // Persist a short preview + timestamp so the jump-list can show
                    // this bookmark even when its message is scrolled out of the
                    // loaded window.
                    bookmarks.toggle(messageId, { preview: bookmarkPreview(text), createdAt });
                    closeActions();
                  },
                }
              : null
          }
        />
      ) : null}
    </>
  );
}

type MenuAnchor = AttachAnchor;

// The "…" menu on an agent message: a small card pinned to the button, right-aligned
// with it, below when there's room and above otherwise — the message it belongs to
// stays visible and highlighted. Each action has a name and a one-line explanation.
// Saving to Project Knowledge keeps the menu open to show its progress and result;
// the other actions close it.
function MessageActionsMenu({
  anchor,
  onClose,
  onCopy,
  knowledge,
  bookmark,
}: {
  anchor: MenuAnchor;
  onClose: () => void;
  onCopy: () => void;
  knowledge: { saved: boolean; save: () => Promise<void> } | null;
  bookmark: { bookmarked: boolean; toggle: () => void } | null;
}) {
  const [saving, setSaving] = useState(false);
  const saveKnowledge = (): void => {
    if (!knowledge || knowledge.saved || saving) return;
    setSaving(true);
    knowledge
      .save()
      .catch((error: unknown) =>
        Alert.alert(
          'Could not add to Project Knowledge',
          error instanceof Error ? error.message : String(error),
        ),
      )
      .finally(() => setSaving(false));
  };
  return (
    <ActionMenu
      anchor={anchor}
      label="Message actions"
      onClose={onClose}
      items={[
        { icon: 'copy', title: 'Copy text', subtitle: 'Copy the whole message', onPress: onCopy },
        ...(knowledge
          ? [
              {
                icon: knowledge.saved ? ('check' as const) : KNOWLEDGE_ICON,
                title: knowledge.saved ? 'Added to Project Knowledge' : 'Save to Project Knowledge',
                subtitle: 'Keep it as a project insight',
                busy: saving,
                disabled: knowledge.saved,
                onPress: saveKnowledge,
              },
            ]
          : []),
        ...(bookmark
          ? [
              {
                icon: 'bookmark' as const,
                title: bookmark.bookmarked ? 'Remove bookmark' : 'Bookmark',
                subtitle: 'Find it again via the header',
                onPress: bookmark.toggle,
              },
            ]
          : []),
      ]}
    />
  );
}

function MarkdownText({
  content,
  onOpenLocalFile,
  sessionFileImageSource,
  onOpenImage,
}: {
  content: string;
  onOpenLocalFile: OpenLocalFile | null;
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
  onOpenLocalFile: OpenLocalFile | null;
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
      {links.map((link) => (
        <LocalImageLink
          key={link.path}
          link={link}
          sessionFileImageSource={sessionFileImageSource}
          onOpenImage={onOpenImage}
        />
      ))}
    </View>
  );
}

// A session-file image goes through the pinned downloader like a tool image: a
// direct HTTPS URL would reach expo-image, which rejects the self-signed
// certificate of a TLS-pinned endpoint and leaves an empty frame behind.
function LocalImageLink({
  link,
  sessionFileImageSource,
  onOpenImage,
}: {
  link: { path: string; label: string };
  sessionFileImageSource: (path: string) => ImageSource | undefined;
  onOpenImage: (source: ImageSource, label: string) => void;
}) {
  const immediate = useMemo(
    () => sessionFileImageSource(link.path),
    [sessionFileImageSource, link.path],
  );
  const source = usePinnedImageSource(immediate, `session-file-${link.path}`);
  if (source === undefined) return null;
  return (
    <Pressable
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

function SessionFileImageViewer({
  path,
  sessionFileImageSource,
  onClose,
  onUnavailable,
}: {
  path: string;
  sessionFileImageSource: (path: string) => ImageSource | undefined;
  onClose: () => void;
  onUnavailable: () => void;
}) {
  const immediate = useMemo(() => sessionFileImageSource(path), [sessionFileImageSource, path]);
  const source = usePinnedImageSource(immediate, `session-file-${path}`, onUnavailable);
  if (source === undefined) return null;
  return <ImageLightbox source={source} label={fileNameFromPath(path)} onClose={onClose} />;
}

// Render inline **bold** / `code` / link spans (nested Text lays them out inline).
// A link tap opens the URL in the system browser; selection still works via a
// long-press on the surrounding selectable Text.
function Inline({
  text,
  onOpenLocalFile,
}: {
  text: string;
  onOpenLocalFile: OpenLocalFile | null;
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
          const local = span.external ? null : sessionFileTargetFromLocalLink(span.url);
          const canOpenLocal = local !== null && onOpenLocalFile !== null;
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
                    ? () => onOpenLocalFile(local.path, local.root)
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
// next to another tool call never buries its image behind the group's "+N more" line.
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

// The collapsed line already shows one call (the latest), so the count names the
// hidden rest: "+9 more" for a run of ten.
function ToolGroupCount({ count }: { count: number }) {
  // A todo run can hold a single update — nothing is hidden then.
  if (count < 2) return null;
  return <Text style={styles.toolGroupCountText}>{`+${String(count - 1)} more`}</Text>;
}

// A run of consecutive tool calls. One tool → the plain line. Several → a single
// collapsed line showing the LATEST tool (the "currently running" command as it
// streams in) plus a quiet "+N more" count; tap to expand the whole run as individual
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
          <ToolGroupCount count={tools.length} />
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
            <View key={rowKey(r)}>
              <TranscriptRow
                item={r}
                isLatest={false}
                bookmarkable={false}
                renderContent={renderRow}
              />
            </View>
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
          <ToolGroupCount count={tools.length} />
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

const PLAN_MARK: Record<PlanView['entries'][number]['status'], string> = {
  completed: '✓',
  in_progress: '◐',
  pending: '○',
};

// The agent's task list. The latest snapshot opens as a checklist; older ones are
// history and show one line — progress plus the step then in hand — until tapped.
function PlanCard({ plan, latest }: { plan: PlanView; latest: boolean }) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(latest);
  const done = plan.completed === plan.entries.length;
  const color = done ? theme.colors.tone.done : theme.colors.tone.active;
  return (
    <Pressable
      style={styles.toolCard}
      onPress={() => setExpanded((e) => !e)}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`${planHeadline(plan)}${plan.current !== null ? `, now: ${plan.current}` : ''}`}
    >
      <View style={styles.toolHeader}>
        <View style={[styles.toolDot, { backgroundColor: color }]} />
        <Text style={styles.toolHeadline} numberOfLines={1}>
          {planHeadline(plan)}
          {!expanded && plan.current !== null ? ` · ${plan.current}` : ''}
        </Text>
        <Icon
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size={16}
          color={theme.colors.textFaint}
        />
      </View>
      {expanded ? (
        <View style={styles.toolDetail}>
          {plan.entries.map((entry, index) => (
            <View key={index} style={styles.planEntry}>
              <Text
                style={[
                  styles.planMark,
                  entry.status === 'in_progress' ? { color: theme.colors.tone.active } : null,
                ]}
              >
                {PLAN_MARK[entry.status]}
              </Text>
              <Text
                style={[
                  styles.planEntryText,
                  entry.status === 'completed' ? styles.planEntryDone : null,
                  entry.status === 'in_progress' ? styles.planEntryCurrent : null,
                ]}
              >
                {entry.content}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

/** A plan the agent presented for the operator's decision. Only the newest one can
 * be implemented; older versions collapse to one line, expandable. */
function PlanProposalCard({
  markdown: presentedMarkdown,
  latest,
  revision: presentedRevision,
}: {
  markdown: string;
  latest: boolean;
  revision?: number;
}) {
  const { theme } = useUnistyles();
  const actions = useContext(SessionActionsContext);
  const [expanded, setExpanded] = useState(latest);
  const planning = actions?.planning;
  const { markdown, revision } = planProposalDisplay(
    { markdown: presentedMarkdown, revision: presentedRevision },
    latest,
    actions,
  );
  const decidable = latest && planning === 'active' && actions?.planningPlan !== null;
  const enabled =
    decidable &&
    revision !== undefined &&
    actions !== null &&
    !actions.dead &&
    !actions.decidingPlanning;
  const status = !latest
    ? 'Earlier version'
    : planning === 'implemented'
      ? 'Implemented'
      : planning === 'discarded'
        ? 'Discarded'
        : null;
  return (
    <View style={styles.toolCard}>
      <Pressable
        style={styles.toolHeader}
        onPress={() => setExpanded((e) => !e)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={status === null ? 'Plan' : `Plan, ${status}`}
      >
        <View
          style={[
            styles.toolDot,
            {
              backgroundColor: decidable
                ? theme.colors.tone.attention
                : planning === 'implemented' && latest
                  ? theme.colors.tone.done
                  : theme.colors.tone.idle,
            },
          ]}
        />
        <Text style={styles.toolHeadline} numberOfLines={1}>
          {status === null ? 'Plan' : `Plan · ${status}`}
        </Text>
        <Icon
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size={16}
          color={theme.colors.textFaint}
        />
      </Pressable>
      {expanded ? (
        <View style={styles.toolDetail}>
          <MarkdownText
            content={markdown}
            onOpenLocalFile={null}
            sessionFileImageSource={null}
            onOpenImage={() => undefined}
          />
        </View>
      ) : null}
      {decidable ? (
        <View style={styles.choicesChips}>
          <Pressable
            onPress={() => enabled && actions?.implementPlan(revision)}
            disabled={!enabled}
            accessibilityRole="button"
            accessibilityState={{ disabled: !enabled }}
            accessibilityLabel="Implement plan"
            style={({ pressed }) => [
              styles.chip,
              styles.chipRecommended,
              enabled ? null : styles.chipDisabled,
              pressed && enabled ? styles.chipPressed : null,
            ]}
          >
            <Text style={styles.chipStar}>★</Text>
            <Text style={[styles.chipLabel, styles.chipLabelRecommended]}>Implement plan</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** Shown above the composer while the session is in planning mode. */
function PlanningBar({
  deciding,
  error,
  onEnd,
}: {
  deciding: boolean;
  error: string | undefined;
  onEnd: () => void;
}) {
  return (
    <View style={styles.prBarWrap}>
      <View style={styles.prBar}>
        <View style={styles.prLocalMain}>
          <Text style={styles.prTitle} numberOfLines={1}>
            Planning mode
          </Text>
          <Text style={styles.prSub} numberOfLines={1}>
            The agent makes no file changes.
          </Text>
          {error !== undefined ? (
            <Text style={styles.prError} numberOfLines={2}>
              {error}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={onEnd}
          disabled={deciding}
          accessibilityRole="button"
          accessibilityState={{ disabled: deciding, busy: deciding }}
          accessibilityLabel="End planning mode"
          style={({ pressed }) => [
            styles.chip,
            styles.planningBarEnd,
            deciding ? styles.chipDisabled : null,
            pressed && !deciding ? styles.chipPressed : null,
          ]}
        >
          <Text style={styles.chipLabel}>End</Text>
        </Pressable>
      </View>
    </View>
  );
}

function EventRow({ message }: { message: ModeSwitchMessage }) {
  const { theme } = useUnistyles();
  const descriptor = agentEventDescriptor(message.event);
  const color = theme.colors.tone[eventToneColor(descriptor.tone)];
  // A task change is bookkeeping, not conversation: one muted line that opens
  // the panel when tapped, so it never competes with the reply around it.
  if (descriptor.action === 'tasks') {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${descriptor.label}. Open Tasks`}
        onPress={openTasksPanel}
        style={({ pressed }) => [styles.eventRow, pressed ? styles.eventActionPressed : null]}
      >
        <Text style={styles.eventDetail}>{descriptor.label}</Text>
        <Text style={styles.eventTasksLink}>Tasks ›</Text>
      </Pressable>
    );
  }
  return (
    <View style={[styles.eventRow, descriptor.action ? styles.eventRowActionable : null]}>
      <Text style={[styles.eventLabel, { color }]}>{descriptor.label}</Text>
      {descriptor.detail ? <Text style={styles.eventDetail}>{descriptor.detail}</Text> : null}
      {descriptor.action === 'claude-login' ? (
        <Pressable
          style={({ pressed }) => [styles.eventAction, pressed ? styles.eventActionPressed : null]}
          onPress={() => router.push('/settings/services/claude?agentLogin=claude')}
          accessibilityRole="button"
          accessibilityLabel="Sign in to Claude"
        >
          <Text style={styles.eventActionLabel}>Sign in to Claude</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function DependencyStatusRow({ text }: { text: string }) {
  return (
    <View style={styles.dependencyStatusRow} accessible accessibilityLabel={text}>
      <WorkingDot size={7} />
      <Text style={styles.dependencyStatusText}>{text}</Text>
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

function AutomationProposalRow({ message }: { message: AutomationProposalMessage }) {
  const actions = useContext(SessionActionsContext);
  const [state, setState] = useState<AutomationProposalState>('idle');
  const [error, setError] = useState<string | null>(null);
  const proposal = message.proposal;
  const current = actions?.automation
    ? isSameAutomation(actions.automation, proposal)
      ? 'same'
      : 'other'
    : 'none';
  // Once saved, the card follows the live automation: deleting or replacing it
  // turns the button back on so this proposal can be confirmed again.
  const shownState = state === 'saved' && current !== 'same' ? 'idle' : state;
  const confirm = useCallback(() => {
    if (!actions || shownState !== 'idle') return;
    setState('saving');
    setError(null);
    void actions
      .confirmAutomation(proposal)
      .then(() => setState('saved'))
      .catch((caught: unknown) => {
        setState('idle');
        setError(caught instanceof Error ? caught.message : 'Could not create the automation.');
      });
  }, [actions, proposal, shownState]);
  return (
    <AutomationProposalCard
      proposal={proposal}
      state={shownState}
      current={current}
      error={
        error ??
        (actions && !actions.automationReady
          ? 'Loading the current automation. If this persists, open the session again.'
          : null)
      }
      disabled={actions === null || !actions.automationReady || actions.sending || actions.dead}
      superseded={actions !== null && actions.latestAutomationProposalId !== message.id}
      currentPaused={actions?.automation?.status === 'paused'}
      onConfirm={confirm}
    />
  );
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
  const insets = useSafeAreaInsets();
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
      {/*
        The "new branch name" field is the last row of this sheet, so the
        keyboard lands squarely on it. The sheet has a dragged, animated height
        rather than a flexible one — shrinking it from the outside would fight
        the resize gesture — so it rides up with the keyboard instead. The
        `opened` offset gives back the home-indicator padding the sheet no
        longer needs once the keyboard occupies that strip.
      */}
      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
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
      </KeyboardStickyView>
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
        ) : null}
      </Pressable>
    );
  };
  const renderGroups = (items: string[]) =>
    groupModelsByEngine(items).map((group, index) => (
      <View key={group.engine}>
        {index > 0 ? (
          <View style={styles.sheetModelSeparator} testID="model-group-separator" />
        ) : null}
        <Text style={styles.sheetSectionLabel}>{group.engine}</Text>
        {group.models.map(renderModelRow)}
      </View>
    ));
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
          {renderGroups(partitionedModels.primary)}
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
          {moreOpen ? renderGroups(partitionedModels.more) : null}
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
// for both HTTP and CLI: once, this session, or 30 days in the project.
function PermissionPrompt({
  pending,
  deciding,
  dead,
  approvedForDelivery = false,
  onDecide,
}: {
  pending: PendingPermission;
  /** A decision POST for THIS prompt is in flight — disable the buttons + spin. */
  deciding: boolean;
  /** Session can't be resumed (worktree gone) — the prompt is inert. */
  dead: boolean;
  /** The decision was saved, but the target has not accepted the turn yet. */
  approvedForDelivery?: boolean;
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
  const isLinkedMessage = pending.tool === 'verity_send_session_message';
  const isListSessions = pending.tool === 'verity_list_sessions';
  const isSessionProgress = pending.tool === 'verity_session_progress';
  const isRecentSessionMessages = pending.tool === 'verity_recent_session_messages';
  const isGmail = pending.tool === 'verity_gmail';
  const isCalendar = pending.tool === 'verity_google_calendar';
  const isKnowledge = pending.tool === 'verity_knowledge';
  const planningTool = planningToolName(pending.tool);
  const isEndPlanning = planningTool === END_PLANNING_TOOL;
  const isPresentPlan = planningTool === 'verity_present_plan';
  const knowledgeSummary = isKnowledge ? knowledgePublishSummary(pending.input) : null;
  const calendarSummary = isCalendar ? calendarChangeSummary(pending.input) : null;
  const httpSummary = isBrokeredHttp ? brokeredHttpSummary(pending.input) : null;
  const cliSummary = isTrustedCli ? trustedCliSummary(pending.input) : null;
  const handoffSummary = isSessionHandoff ? sessionHandoffSummary(pending.input) : null;
  const linkedMessage =
    isLinkedMessage &&
    typeof pending.input === 'object' &&
    pending.input !== null &&
    !Array.isArray(pending.input) &&
    typeof (pending.input as Record<string, unknown>).targetSessionId === 'string' &&
    typeof (pending.input as Record<string, unknown>).message === 'string'
      ? (pending.input as { targetSessionId: string; message: string })
      : null;
  const listingSummary = isListSessions ? listSessionsSummary(pending.input) : null;
  const progressSummary = isSessionProgress ? sessionProgressSummary(pending.input) : null;
  const recentSummary = isRecentSessionMessages
    ? recentSessionMessagesSummary(pending.input)
    : null;
  const gmailSummary = isGmail ? gmailSendSummary(pending.input) : null;
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
    (isLinkedMessage && linkedMessage === null) ||
    (isListSessions && listingSummary === null) ||
    (isSessionProgress && progressSummary === null) ||
    (isRecentSessionMessages && recentSummary === null) ||
    (isGmail && gmailSummary === null) ||
    (isCalendar && calendarSummary === null) ||
    (isKnowledge && knowledgeSummary === null)
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
      : isKnowledge
        ? KNOWLEDGE_PUBLISH_EXPLANATION
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
      !isKnowledge
        ? null
        : knowledgeSummary?.replacesExisting
          ? 'Save changes to Global Knowledge?'
          : 'Publish insight to Global Knowledge?',
      httpSummary === null ? null : brokeredHttpTitle(httpSummary),
      cliSecretLabel === null ? null : `Run trusted command with ${cliSecretLabel}?`,
      handoffSummary === null ? null : sessionHandoffTitle(handoffSummary),
      linkedMessage === null
        ? null
        : approvedForDelivery
          ? `Retry delivery to ${linkedMessage.targetSessionId}?`
          : `Send to ${linkedMessage.targetSessionId} and continue the exchange?`,
      listingSummary === null ? null : listSessionsTitle(listingSummary),
      progressSummary === null ? null : `Read progress for session ${progressSummary.sessionId}?`,
      recentSummary === null
        ? null
        : `Read ${String(recentSummary.count)} recent messages from session ${recentSummary.sessionId}?`,
      calendarSummary?.title ?? null,
      gmailSummary === null ? null : `Send email to ${gmailSummary.to.join(', ')}?`,
      isEndPlanning ? 'Implement the plan?' : null,
      isPresentPlan ? 'Show the proposed plan?' : null,
    ].find((title) => title !== null) ??
    // Spelled out like every other string on the card. Tool names are server-controlled today,
    // so this is consistency rather than exposure — but it is the headline, and the one field
    // here that never passed a summariser.
    `Allow ${spellOutBidiControls(view.title)}?`;
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
      accessibilityLabel={
        isKnowledge
          ? `${cardTitle} ${KNOWLEDGE_PUBLISH_EXPLANATION}`
          : `${cardTitle} Allow or deny.`
      }
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
          {approvedForDelivery
            ? 'delivery pending'
            : pending.riskClass === 'ask'
              ? 'needs approval'
              : pending.riskClass}
        </Text>
      </View>
      {isPresentPlan ? (
        <View style={styles.permissionHttpSummary}>
          <Text style={styles.permissionHttpMeta}>
            The agent wants to show you a plan for review. This does not approve implementation.
          </Text>
        </View>
      ) : null}
      {isEndPlanning ? (
        <View style={styles.permissionHttpSummary}>
          <Text style={styles.permissionHttpMeta}>
            Planning mode ends and the agent may change files again to implement the latest plan.
          </Text>
        </View>
      ) : knowledgeSummary !== null ? (
        <View style={styles.permissionHttpSummary}>
          <Text style={styles.permissionSubtitle} selectable>
            Source: {spellOutBidiControls(knowledgeSummary.source)}
          </Text>
          <Text style={styles.permissionSubtitle} selectable>
            Destination: {spellOutBidiControls(knowledgeSummary.destination)}
          </Text>
          <Text style={styles.permissionHttpMeta}>{KNOWLEDGE_PUBLISH_EXPLANATION}</Text>
          {knowledgeSummary.replacesExisting ? (
            <Text style={styles.permissionHttpMeta}>
              Saves the project version as the updated global file. Agents in every project can use
              the updated content.
            </Text>
          ) : null}
        </View>
      ) : httpSummary !== null ? (
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
      ) : linkedMessage !== null ? (
        <View style={styles.permissionHttpSummary}>
          <Text style={styles.permissionHttpMeta} selectable>
            To {linkedMessage.targetSessionId}
          </Text>
          <ScrollView style={styles.permissionBriefing} nestedScrollEnabled>
            <Text style={styles.permissionSubtitle} selectable>
              {spellOutBidiControls(linkedMessage.message)}
            </Text>
          </ScrollView>
          <Text style={styles.permissionHttpMeta}>
            {approvedForDelivery
              ? 'Already approved. Retry sending this message or cancel it.'
              : 'Allowing sends this message and permits a small further exchange. The next limit asks again.'}
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
      ) : progressSummary !== null ? (
        <View style={styles.permissionHttpSummary}>
          <Text style={styles.permissionHttpMeta}>
            One on-demand metadata read for session {progressSummary.sessionId}. No transcript
            content is returned. Do not poll this tool.
          </Text>
        </View>
      ) : recentSummary !== null ? (
        <View style={styles.permissionHttpSummary}>
          <Text style={styles.permissionSubtitle} selectable>
            Session {recentSummary.sessionId}
          </Text>
          <Text style={styles.permissionHttpMeta} selectable>
            Purpose: {recentSummary.purpose}. Scope: up to {recentSummary.count} redacted messages
            {recentSummary.sinceMinutes === undefined
              ? ''
              : ` from the last ${String(recentSummary.sinceMinutes)} minutes`}
            {recentSummary.beforeSeq === undefined
              ? ''
              : ` before event ${String(recentSummary.beforeSeq)}`}
            . Attachments and tool payloads are excluded; recognized credential patterns are
            redacted, but free text may still contain sensitive material. Another page requires a
            new approval.
          </Text>
        </View>
      ) : calendarSummary !== null ? (
        <View>
          {calendarSummary.details.map((detail, index) => (
            <Text key={index} style={styles.permissionSubtitle} selectable>
              {spellOutBidiControls(detail)}
            </Text>
          ))}
        </View>
      ) : gmailSummary !== null ? (
        <View style={styles.permissionHttpSummary}>
          {gmailSummary.from === null ? null : (
            <Text style={styles.permissionSubtitle} selectable>
              From: {spellOutBidiControls(gmailSummary.from)}
            </Text>
          )}
          {gmailSummary.replyTo === null ? null : (
            <Text style={styles.permissionSubtitle} selectable>
              Reply-To: {spellOutBidiControls(gmailSummary.replyTo)}
            </Text>
          )}
          <Text style={styles.permissionSubtitle} selectable>
            To: {spellOutBidiControls(gmailSummary.to.join(', '))}
          </Text>
          {gmailSummary.cc.length > 0 ? (
            <Text style={styles.permissionSubtitle} selectable>
              CC: {spellOutBidiControls(gmailSummary.cc.join(', '))}
            </Text>
          ) : null}
          {gmailSummary.bcc.length > 0 ? (
            <Text style={styles.permissionSubtitle} selectable>
              BCC: {spellOutBidiControls(gmailSummary.bcc.join(', '))}
            </Text>
          ) : null}
          <Text style={styles.permissionSubtitle} selectable>
            Subject: {spellOutBidiControls(gmailSummary.subject)}
          </Text>
          {gmailSummary.htmlBody === null ? null : (
            <Text style={styles.permissionHttpMeta}>HTML version:</Text>
          )}
          {gmailSummary.htmlBody === null ? null : (
            <WebView
              style={styles.permissionHtmlPreview}
              source={{ html: gmailPreviewHtml(gmailSummary.htmlBody), baseUrl: 'about:blank' }}
              javaScriptEnabled={false}
              domStorageEnabled={false}
              cacheEnabled={false}
              originWhitelist={['about:blank']}
              onShouldStartLoadWithRequest={(request) => request.url === 'about:blank'}
              accessibilityLabel="Email HTML preview; external images and navigation are blocked"
            />
          )}
          {gmailSummary.htmlBody === null ? null : (
            <Text style={styles.permissionHttpMeta}>Plain-text alternative:</Text>
          )}
          <ScrollView style={styles.permissionBriefing} nestedScrollEnabled>
            <Text style={styles.permissionSubtitle} selectable>
              {spellOutBidiControls(gmailSummary.body)}
            </Text>
          </ScrollView>
          {gmailSummary.externalUrls.length > 0 ? (
            <View>
              <Text style={styles.permissionHttpMeta}>
                External links and images in this email:
              </Text>
              {gmailSummary.externalUrls.map((url) => (
                <Text key={url} style={styles.permissionHttpMeta} selectable>
                  {spellOutBidiControls(url)}
                </Text>
              ))}
            </View>
          ) : null}
          <Text style={styles.permissionHttpMeta}>
            Gmail sends exactly this text and HTML snapshot once. After sending, Verity deletes the
            original draft if the final check still matches this preview. A change during cleanup
            may be lost.
          </Text>
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
          accessibilityLabel={`${approvedForDelivery ? 'Cancel' : 'Deny'} ${view.title}`}
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
              {approvedForDelivery ? 'Cancel' : 'Deny'}
            </Text>
          )}
        </Pressable>
        <Pressable
          onPress={() => allow()}
          disabled={!active}
          accessibilityRole="button"
          accessibilityState={{ disabled: !active, busy: deciding }}
          accessibilityLabel={
            isKnowledge
              ? knowledgeSummary?.replacesExisting
                ? 'Save changes to Global Knowledge'
                : 'Publish to Global Knowledge'
              : `${approvedForDelivery ? 'Retry delivery of' : 'Allow'} ${view.title}${isScopedSecretTool ? ' once' : ''}`
          }
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
              {isKnowledge
                ? knowledgeSummary?.replacesExisting
                  ? 'Save changes'
                  : 'Publish to Global'
                : approvedForDelivery
                  ? 'Retry delivery'
                  : isScopedSecretTool
                    ? 'Allow once'
                    : 'Allow'}
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
              accessibilityLabel={`Allow ${httpSummary?.secretAlias ?? cliSecretLabel ?? view.title} for ${httpSummary?.host ?? cliSummary?.executable ?? 'this destination'} for this session`}
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
              accessibilityLabel={`Allow ${httpSummary?.secretAlias ?? cliSecretLabel ?? view.title} for ${httpSummary?.host ?? cliSummary?.executable ?? 'this destination'} in this project for 30 days`}
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
              accessibilityLabel={`Always allow ${httpSummary?.secretAlias ?? view.title} for ${httpSummary?.host ?? 'this destination'}`}
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
  // Green checks but GitHub hasn't finished its merge test yet: the button stays off,
  // and the (still green) dot pulses so the wait reads as progress, not a dead button.
  const checkingMergeability = isPullRequestCheckingMergeability(pullRequest);
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
    (pending ||
      (pullRequest.phase === 'open' && checks.total === 0) ||
      checkingMergeability ||
      merging);
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
            accessibilityState={{
              disabled: !mergeButtonEnabled,
              busy: merging || checkingMergeability,
            }}
            accessibilityLabel={
              mergeRejected
                ? `Merge blocked because GitHub rejected pull request ${String(pullRequest.number)}`
                : conflicted
                  ? `Merge blocked because pull request ${String(pullRequest.number)} conflicts with ${pullRequest.baseRef ?? 'the base branch'}`
                  : failed
                    ? `Merge blocked because CI failed for pull request ${String(pullRequest.number)}`
                    : mergeabilityBlocked
                      ? `Merge blocked for pull request ${String(pullRequest.number)}`
                      : checkingMergeability
                        ? `Merge unavailable while GitHub checks whether pull request ${String(pullRequest.number)} can merge`
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

/** Save a local session's work through the agent and then into the project base.
 *  The server checks the commit and merge preconditions. */
function LocalMergeBar({
  branch,
  base,
  busy,
  onSave,
}: {
  branch: string;
  base: string;
  busy: boolean;
  onSave: UseBranches['saveToProject'];
}) {
  const { theme } = useUnistyles();
  const [saving, setSaving] = useState(false);
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

  const save = (): void => {
    if (saving || busy) return;
    void (async () => {
      setSaving(true);
      setError(undefined);
      const result = await onSave();
      if (!mounted.current) return;
      setSaving(false);
      if (!result.ok) setError(result.message);
      // The server runs the agent turn and local merge after accepting the request.
    })();
  };

  return (
    <View style={styles.prBarWrap}>
      <View style={styles.prBar}>
        <View style={styles.prLocalMain}>
          <Text style={styles.prTitle} numberOfLines={1}>
            Changes from this session
          </Text>
          <Text style={styles.prSub} numberOfLines={1}>
            Save them as a version in your project.
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
            styles.prLocalMergeButton,
            { backgroundColor: theme.colors.tone.done },
            saving || busy ? styles.prMergeButtonDisabled : null,
            pressed && !saving && !busy ? styles.prMergeButtonPressed : null,
          ]}
          onPress={save}
          disabled={saving || busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: saving || busy, busy: saving }}
          accessibilityLabel="Save this session's changes as a version in your project"
        >
          {saving ? (
            <ActivityIndicator color={theme.colors.onPrimary} />
          ) : (
            <Text style={styles.prMergeText}>Save to project</Text>
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
  voiceAutoMode,
  voiceCountdown,
  onMic,
  onMicLongPress,
  onPauseVoiceCountdown,
  engineLabel,
  engineBusy,
  onEnginePress,
  bottomInset,
  horizontalInsets,
  compact,
  keyboardHeight,
  onHeightChange,
  attachments,
  knowledgeEnabled,
  saveAttachmentsToKnowledge,
  onToggleSaveAttachmentsToKnowledge,
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
  voiceAutoMode: boolean;
  voiceCountdown: number | null;
  onMic: () => void;
  onMicLongPress: () => void;
  onPauseVoiceCountdown: () => void;
  /** Current engine/model label shown on the chip in the action row. */
  engineLabel: string;
  /** An engine switch is in flight — the chip shows a spinner and is disabled. */
  engineBusy: boolean;
  /** Open the engine/model picker sheet. */
  onEnginePress: () => void;
  bottomInset: number;
  horizontalInsets: { left: number; right: number };
  compact: boolean;
  /** Height of the on-screen keyboard right now, `null` when none is up. Decides what
   * Return does: a full software keyboard inserts a newline, the shortcut bar or no
   * keyboard at all sends (see `shouldSubmitOnReturn`). */
  keyboardHeight: number | null;
  /** Reports the bar's rendered height so the scroll-to-bottom button can anchor
   * above it (it grows with multi-line text / attachment previews). */
  onHeightChange: (height: number) => void;
  /** Files picked or dropped for the next turn (not yet sent, raw base64). */
  attachments: AttachmentUpload[];
  knowledgeEnabled: boolean;
  saveAttachmentsToKnowledge: boolean;
  onToggleSaveAttachmentsToKnowledge: () => void;
  /** Open the add menu, docked to the plus button (its measured screen rect). */
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
  const openAttachMenu = useAttachmentMenuAnchor(attachBtnRef, onAttach);
  const onComposerKeyPress = useCallback(
    (event: Parameters<NonNullable<React.ComponentProps<typeof TextInput>['onKeyPress']>>[0]) => {
      if (Platform.OS === 'web' && !dead && shouldSendWebKey(event.nativeEvent)) {
        event.preventDefault();
        onSend();
      }
    },
    [dead, onSend],
  );
  // Auto-grow: let the native multiline TextInput size to its content (it grows up
  // to `maxHeight`, then scrolls). We deliberately do NOT set an explicit `height`
  // from `onContentSizeChange` — on Fabric that event only fires once at mount
  // (verified on device), so a state-driven height pins the field to one line. The
  // text padding lives on the `inputCard`, not the TextInput, so the input's content
  // width is clean and lines wrap correctly.
  return (
    <View
      style={[
        styles.inputBarWrap,
        {
          paddingBottom: bottomInset + (compact ? 2 : 4),
          paddingLeft: horizontalInsets.left,
          paddingRight: horizontalInsets.right,
        },
      ]}
      onLayout={(e) => onHeightChange(e.nativeEvent.layout.height)}
    >
      <DropZone
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
          <>
            <AttachmentPreviews attachments={attachments} onRemove={onRemoveAttachment} />
            {knowledgeEnabled ? (
              <Pressable
                onPress={onToggleSaveAttachmentsToKnowledge}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: saveAttachmentsToKnowledge }}
                style={styles.knowledgeAttachmentToggle}
              >
                <Icon
                  name={saveAttachmentsToKnowledge ? 'check-square' : 'square'}
                  size={16}
                  color={saveAttachmentsToKnowledge ? theme.colors.primary : theme.colors.textMuted}
                />
                <Text style={styles.knowledgeAttachmentToggleText}>Save to Project Knowledge</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
        {/* Two-tier layout (like the Claude app): the text field spans the FULL width
          on top, and the action buttons sit in a row UNDERNEATH it — so the field is
          never squeezed between inline buttons. Padding lives on this card (not the
          TextInput) so the input's content-size measurement isn't skewed (RN#35234). */}
        <View
          style={[
            styles.inputCard,
            compact && styles.inputCardCompact,
            dropActive ? styles.inputCardDropActive : null,
          ]}
        >
          <PromptComposerInput
            key={Platform.OS === 'web' ? 'web-composer' : sendNonce}
            ref={inputRef}
            style={[
              styles.input,
              compact && styles.inputCompact,
              Platform.OS === 'web' ? { outlineWidth: 0 } : null,
            ]}
            value={value}
            onChangeText={onChangeText}
            containerStyle={compact ? styles.inputContainerCompact : undefined}
            submitOnReturn={shouldSubmitOnReturn(keyboardHeight)}
            onSend={onSend}
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
            keyboardAppearance="dark"
            accessibilityLabel="Message input"
          />
          <View style={[styles.actionRow, compact && styles.actionRowCompact]}>
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
                accessibilityLabel="Add content or connect a service"
              >
                <Icon
                  name="plus"
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
              <MicButton
                voiceState={voiceState}
                autoMode={voiceAutoMode}
                countdown={voiceCountdown}
                onMic={onMic}
                onLongPress={onMicLongPress}
                onPauseCountdown={onPauseVoiceCountdown}
                disabled={dead}
              />
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
    </View>
  );
}

// The add menu: the composer's plus button opens this small
// popover docked to it — a source per row (camera, photo library, or an arbitrary
// file) — instead of a full-width bottom sheet.
function AttachMenu({
  googleConnected,
  visible,
  anchor,
  onCapturePhoto,
  onPickPhotos,
  onPickFiles,
  onPickMeetingAudio,
  onLiveMeeting,
  onConnectGmail,
  onConnectCalendar,
  onConnectContacts,
  onClose,
  onDismiss,
}: {
  googleConnected: boolean;
  visible: boolean;
  anchor: AttachAnchor | null;
  onCapturePhoto: () => void;
  onPickPhotos: () => void;
  onPickFiles: () => void;
  onPickMeetingAudio: () => void;
  onLiveMeeting: () => void;
  onConnectGmail: () => void;
  onConnectCalendar: () => void;
  onConnectContacts: () => void;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const { theme } = useUnistyles();
  const { width: winW, height: winH } = useWindowDimensions();
  const rows = attachMenuRows(
    {
      onCapturePhoto,
      onPickPhotos,
      onPickFiles,
      onPickMeetingAudio,
      onLiveMeeting,
      onConnectGmail,
      onConnectCalendar,
      onConnectContacts,
    },
    { googleConnected },
  );
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
          'section' in row ? (
            <Text key={row.section} style={styles.menuSectionLabel}>
              {row.section}
            </Text>
          ) : 'divider' in row ? (
            <View key={`divider-${String(index)}`} style={styles.menuDivider} />
          ) : (
            <Pressable
              key={row.label}
              style={({ pressed }) => [styles.menuRow, pressed ? styles.menuRowPressed : null]}
              onPress={row.onPress}
              accessibilityRole="button"
              accessibilityLabel={row.detail ? `${row.label}, ${row.detail}` : row.label}
            >
              <Icon name={row.icon} size={20} color={theme.colors.textMuted} />
              <View style={styles.menuRowText}>
                <Text style={styles.menuRowLabel}>{row.label}</Text>
                {row.detail ? <Text style={styles.menuRowDetail}>{row.detail}</Text> : null}
              </View>
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
  return usePinnedImageSource(immediate, a.id);
}

/** Load a server-hosted image source (`immediate`) through the pinned downloader
 * when the active endpoint is a TLS-pinned direct connection; otherwise hand it to
 * expo-image as-is. `cacheKey` names the downloaded copy; without one, `immediate`
 * is not a server URL (e.g. inline base64) and is returned unchanged. */
function usePinnedImageSource(
  immediate: ImageSource | undefined,
  cacheKey: string | undefined,
  onError?: () => void,
): ImageSource | undefined {
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const [source, setSource] = useState<ImageSource | undefined>(
    cacheKey === undefined ? immediate : undefined,
  );
  useEffect(() => {
    if (cacheKey === undefined || !/^https?:\/\//.test(immediate?.uri ?? '')) {
      setSource(immediate);
      return;
    }
    const baseUrl = getVerityBaseUrl();
    const endpoint = getServerProfile()?.endpoints.find(({ url }) => url === baseUrl);
    if (
      baseUrl === null ||
      endpoint?.transport !== 'direct' ||
      endpoint.tlsPin === undefined ||
      // The bearer and pin belong to the active endpoint only; a source built for
      // another origin (e.g. before a LAN/remote switch) keeps its own loader.
      !immediate!.uri!.startsWith(`${baseUrl}/`)
    ) {
      setSource(immediate);
      return;
    }
    let active = true;
    let cachedUri: string | undefined;
    const destination = new FsFile(
      Paths.cache,
      'verity-attachments',
      `${cacheKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    // Read the bearer now rather than trusting the memoized source's header: a
    // biometric unlock or token rotation can land after the source was built.
    const token = getAuthToken(baseUrl);
    void downloadPinnedFile({
      url: immediate!.uri!,
      destination: destination.uri,
      tlsPin: endpoint.tlsPin,
      useRemote: true,
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
        if (!active) return;
        setSource(undefined);
        onErrorRef.current?.();
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
  }, [cacheKey, immediate]);
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
  const { theme } = useUnistyles();
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
        useNativeDriver: Platform.OS !== 'web',
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
            Platform.OS === 'web'
              ? {
                  height: 2,
                  borderRadius: theme.radius.pill,
                  backgroundColor: theme.colors.accent,
                  opacity: 0.8,
                }
              : styles.inputActivitySegment,
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
  autoMode,
  countdown,
  onMic,
  onLongPress,
  onPauseCountdown,
  disabled,
}: {
  voiceState: VoiceState;
  autoMode: boolean;
  countdown: number | null;
  onMic: () => void;
  onLongPress: () => void;
  onPauseCountdown: () => void;
  disabled?: boolean;
}) {
  const { theme } = useUnistyles();
  const recording = voiceState === 'recording';
  const activationScale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!autoMode) return;
    activationScale.setValue(0.82);
    Animated.spring(activationScale, { toValue: 1, useNativeDriver: true }).start();
  }, [activationScale, autoMode]);
  return (
    <Pressable
      style={styles.iconButton}
      onPress={() => {
        if (countdown !== null) {
          onPauseCountdown();
          return;
        }
        if (autoMode) {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        }
        onMic();
      }}
      onLongPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        onLongPress();
      }}
      delayLongPress={600}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled), busy: recording }}
      accessibilityLabel={
        countdown !== null
          ? 'Pause automatic send'
          : autoMode
            ? 'Stop continuous dictation'
            : recording
              ? 'Stop dictation'
              : 'Start voice dictation; hold for continuous dictation'
      }
    >
      {recording ? (
        <Animated.View
          style={[
            styles.activeActionFill,
            autoMode && styles.voiceAutoActionFill,
            { transform: [{ scale: activationScale }] },
          ]}
        >
          {countdown !== null ? (
            <Text style={{ color: theme.colors.background, fontWeight: '700' }}>{countdown}</Text>
          ) : autoMode ? (
            <Icon name="mic" size={20} color={theme.colors.background} />
          ) : (
            <Icon name="check" size={20} color={theme.colors.background} />
          )}
        </Animated.View>
      ) : (
        <Icon
          name="mic"
          size={22}
          color={disabled ? theme.colors.textFaint : theme.colors.textMuted}
        />
      )}
      {autoMode && recording ? <View style={styles.voiceAutoDot} /> : null}
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
    gap: theme.spacing.sm,
  },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '600',
  },
  starterScreen: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.xl,
  },
  starterList: {
    alignSelf: 'stretch',
    maxWidth: 440,
    width: '100%',
    marginHorizontal: 'auto',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.md,
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
  // An iPhone has very little vertical room in landscape. Put the title and context
  // controls on one line; the inline safe-area padding keeps both clear of the camera
  // cutout regardless of which way the phone is rotated.
  headerCompact: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerRow: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  // In the two-pane (embedded) layout the right-pane header sits beside the left
  // pane's compact usage meters; a shorter title row + reduced top padding keep the
  // two bars close, while still fitting the 40pt action buttons. The phone header
  // uses the full 56px.
  headerRowEmbedded: {
    height: 48,
    paddingLeft: theme.spacing.md,
  },
  headerRowCompact: {
    flex: 1,
    minWidth: 0,
    height: 44,
    paddingRight: 0,
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
  voiceAutoActionFill: {
    backgroundColor: theme.colors.primary,
  },
  voiceAutoDot: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 9,
    height: 9,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
    borderWidth: 1,
    borderColor: theme.colors.background,
  },
  stopSquare: {
    width: 11,
    height: 11,
    borderRadius: 2.5,
    backgroundColor: theme.colors.background,
  },
  // Keep the name and branch centred in the space between navigation and actions.
  // Long names shrink before the action buttons do.
  headerTitleBlock: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: 1,
  },
  headerTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '600',
    textAlign: 'center',
  },
  headerSubtitle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
  },
  headerHintText: {
    color: theme.colors.primary,
    fontWeight: '600',
    textAlign: 'center',
  },
  // Fits the 28px back chevron + its padding.
  headerSide: {
    width: 32,
    flexDirection: 'row',
    alignItems: 'center',
  },
  // The branch glyph under the title: muted so it reads as status, while staying
  // tappable for the switcher. `headerBranch` is the caption text style that line
  // (and the action hint replacing it) uses.
  headerBranchBtn: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  headerBranch: {
    flexShrink: 1,
    color: theme.colors.textFaint,
    fontSize: 12 * theme.fontScale,
    fontWeight: '400',
  },
  headerIssueLink: { color: theme.colors.primary },
  headerBookmarkCount: {
    color: theme.colors.textMuted,
    fontSize: 11 * theme.fontScale,
    fontWeight: '600',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingRight: theme.spacing.xs,
  },
  // A 40pt round target with a 20pt icon — big enough to recognise at a glance.
  headerActionBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  headerActionDot: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 9,
    height: 9,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.tone.done,
    borderWidth: 1.5,
    borderColor: theme.colors.surfaceAlt,
  },
  headerActionBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
  },
  headerActionBadgeText: {
    color: '#ffffff',
    fontSize: 11 * theme.fontScale,
    fontWeight: '700',
  },
  // The tappable engine chip (#switch-engine): the engine pill + a quiet caret/spinner
  // in a row, so the whole affordance reads as one button on the meta row.
  headerEngineChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  // A quiet pill: muted caption text on a faint surface, distinct from the title.
  headerLinks: { paddingHorizontal: 16, paddingBottom: 8, gap: 8, alignItems: 'center' },
  headerLinkChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    maxWidth: 250,
    paddingHorizontal: 10,
    minHeight: 30,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  headerLinkText: { flexShrink: 1, color: theme.colors.textMuted, fontSize: theme.text.xs },
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
  driveSetupNotice: {
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.xl * 2,
  },
  driveSetupButton: {
    marginTop: theme.spacing.sm,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
  },
  driveSetupButtonPressed: {
    opacity: 0.78,
  },
  driveSetupButtonLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  sheetLoading: {
    paddingVertical: theme.spacing.lg,
    alignItems: 'center',
  },
  filesPath: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
  },
  // Pinned under the list while selecting: the one action that applies to the
  // whole selection, labelled and away from the header's Done.
  filesSelectionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  // Tabs mark the active root with an underline, not a filled chip: a fill is
  // what a button looks like, and these are places, not actions.
  filesRootBar: {
    flexDirection: 'row',
    gap: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  filesRootButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    marginBottom: -StyleSheet.hairlineWidth,
  },
  filesRootButtonActive: {
    borderBottomColor: theme.colors.primary,
  },
  filesRootLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
  },
  filesRootLabelActive: {
    color: theme.colors.text,
    fontSize: theme.text.xs,
    fontWeight: '600',
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
  sheetModelSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border,
    marginTop: theme.spacing.sm,
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
  planningBarEnd: {
    marginRight: theme.spacing.sm,
  },
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
  prLocalMergeButton: {
    width: 124,
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
  // The transcript is stored newest-first and flipped: history then APPENDS at the
  // data end, behind the viewport, instead of being inserted in front of the reader.
  // FlashList 2 has no `inverted` prop, so the flip is a transform on the list plus a
  // counter-transform on every row (and on the footer spinner).
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
  peerRow: { justifyContent: 'flex-start' },
  peerBubble: { borderColor: theme.colors.primary, backgroundColor: theme.colors.surface },
  peerSource: {
    color: theme.colors.primary,
    fontSize: theme.text.xs,
    fontWeight: '700',
    marginBottom: 6,
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
    paddingVertical: 7,
    paddingHorizontal: 9,
    borderRadius: theme.radius.md,
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
  // Collapsed multi-tool group count: quiet caption text, spelled out ("+9 more")
  // so it explains itself instead of reading as a stray "·N".
  toolGroupCountText: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
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
  planEntry: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  planMark: {
    width: 14 * theme.fontScale,
    color: theme.colors.textFaint,
    fontSize: theme.text.sm,
  },
  planEntryText: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
  },
  planEntryDone: {
    color: theme.colors.textFaint,
    textDecorationLine: 'line-through',
  },
  planEntryCurrent: {
    fontWeight: '600',
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
  dependencyStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  dependencyStatusText: {
    flex: 1,
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
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
  eventTasksLink: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
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
  workspaceFileBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
    minHeight: 40,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  slideDeckLink: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  slideDeckName: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
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
  permissionHtmlPreview: {
    height: 320,
    borderRadius: theme.radius.sm,
    overflow: 'hidden',
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
  // The landscape composer uses the phone's width to recover vertical transcript
  // space: text and controls share one row instead of stacking into two tiers.
  inputCardCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    paddingTop: 3,
    paddingBottom: 3,
    gap: theme.spacing.sm,
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
  actionRowCompact: {
    flexShrink: 0,
    justifyContent: 'flex-start',
    gap: theme.spacing.sm,
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
  knowledgeAttachmentToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 16,
    paddingVertical: 7,
  },
  knowledgeAttachmentToggleText: {
    color: theme.colors.textMuted,
    fontSize: 13,
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
  // Compact add popover docked to the plus button, not a bottom sheet.
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
  menuRowText: { flex: 1 },
  menuRowLabel: { color: theme.colors.text, fontSize: theme.text.md },
  menuRowDetail: { color: theme.colors.textMuted, fontSize: theme.text.xs, marginTop: 1 },
  menuSectionLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    paddingTop: theme.spacing.xs,
    paddingBottom: 2,
    paddingHorizontal: theme.spacing.md,
  },
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
  inputContainerCompact: {
    flex: 1,
    minWidth: 80,
  },
  inputCompact: {
    maxHeight: 21 * 3,
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
