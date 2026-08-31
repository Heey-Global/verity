/** Notification category ids. These MUST equal the `categoryId` the server sends
 * on each push (`packages/server/src/push-fire-points.ts`): the OS looks up the
 * app-declared category by that id to render the action buttons. `SESSION_STATUS`
 * is informational (tap-to-open, no custom actions). */
export const PUSH_CATEGORY = {
  permissionPrompt: 'PERMISSION_PROMPT',
  sessionStatus: 'SESSION_STATUS',
  agentQuestion: 'AGENT_QUESTION',
  pullRequestReady: 'PULL_REQUEST_READY',
} as const;
export type PushCategoryId = (typeof PUSH_CATEGORY)[keyof typeof PUSH_CATEGORY];

/** Action ids the app declares on its categories and reads back from a
 * notification response's `actionIdentifier`. App-owned strings — the payload
 * never names them (ADR 0008: quick-reply actions live in-app, not in the push). */
export const PUSH_ACTION = {
  allow: 'VERITY_ALLOW',
  deny: 'VERITY_DENY',
  reply: 'VERITY_REPLY',
  mergePullRequest: 'VERITY_MERGE_PULL_REQUEST',
  openSession: 'VERITY_OPEN_SESSION',
} as const;
export type PushActionId = (typeof PUSH_ACTION)[keyof typeof PUSH_ACTION];

/** A single category button, shaped so the native layer can hand it straight to
 * `Notifications.setNotificationCategoryAsync` without re-deriving semantics. */
export interface PushCategoryAction {
  identifier: PushActionId;
  buttonTitle: string;
  /** Force a device unlock (Face ID / passcode) and foreground the app before the
   * action runs. Used for the destructive permission `allow` so an approval can
   * never be tapped straight off a locked screen (KONZEPT §5b; ADR 0008 §202-208).
   * Maps to expo's `isAuthenticationRequired` + `opensAppToForeground`. */
  authenticationRequired?: boolean;
  /** Render the button as destructive (red). Maps to expo's `isDestructive`. */
  destructive?: boolean;
  /** Present a free-text field instead of a plain button (AGENT_QUESTION reply).
   * Maps to expo's `textInput`. */
  textInput?: { submitButtonTitle: string; placeholder: string };
}

export interface PushCategorySpec {
  identifier: PushCategoryId;
  actions: PushCategoryAction[];
}

/** The categories the app registers at launch. `SESSION_STATUS` is intentionally
 * omitted: it has no custom actions, so a default tap (open the session) is all it
 * needs. The `AGENT_QUESTION` reply becomes live once the server emits that fire
 * point (Block 0), which it now does when a turn ends on a prose question. */
export const PUSH_NOTIFICATION_CATEGORIES: readonly PushCategorySpec[] = [
  {
    identifier: PUSH_CATEGORY.permissionPrompt,
    actions: [
      { identifier: PUSH_ACTION.allow, buttonTitle: 'Allow', authenticationRequired: true },
      { identifier: PUSH_ACTION.deny, buttonTitle: 'Deny', destructive: true },
    ],
  },
  {
    identifier: PUSH_CATEGORY.agentQuestion,
    actions: [
      {
        identifier: PUSH_ACTION.reply,
        buttonTitle: 'Reply',
        textInput: { submitButtonTitle: 'Send', placeholder: 'Reply to the agent…' },
      },
    ],
  },
  {
    identifier: PUSH_CATEGORY.pullRequestReady,
    actions: [
      {
        identifier: PUSH_ACTION.mergePullRequest,
        buttonTitle: 'Merge',
        authenticationRequired: true,
      },
      { identifier: PUSH_ACTION.openSession, buttonTitle: 'Open' },
    ],
  },
];
