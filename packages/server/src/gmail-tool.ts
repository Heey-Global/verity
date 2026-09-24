import {
  appendGmailSignature,
  createGmailDraft,
  createGmailReplyDraft,
  readGmailDraftForSend,
  readGmailThread,
  readGmailSignature,
  searchGmail,
  sendGmailDraft,
  type GmailDraftSendSnapshot,
  type GmailSignature,
} from './gmail.js';

export interface GmailInvocationInput {
  projectId: string;
  sessionId: string;
  turnId: string;
  invocationId: string;
  request: unknown;
}

export interface GmailToolStore {
  getSession(sessionId: string): Promise<{ projectId: string | null } | undefined>;
  getSessionGmailConnection(
    sessionId: string,
  ): Promise<{ accountEmail: string; enabledAt: Date } | undefined>;
  getVeritySettings(): Promise<
    | {
        gmailAuthorized: boolean;
        googleDriveRefreshToken: string | null;
        googleDriveAccountEmail: string | null;
      }
    | undefined
  >;
  claimGoogleWorkspaceInvocation(
    input: GmailInvocationInput,
  ): Promise<
    { status: 'claimed' } | { status: 'pending' } | { status: 'completed'; result: unknown }
  >;
  completeGoogleWorkspaceInvocation(invocationId: string, result: unknown): Promise<void>;
}

type GmailRequest =
  | { action: 'search'; query: string; maxResults?: number; pageToken?: string }
  | { action: 'read_thread'; threadId: string }
  | {
      action: 'create_reply_draft';
      threadId: string;
      messageId?: string;
      body: string;
      htmlBody?: string;
    }
  | {
      action: 'create_draft';
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      body: string;
      threadId?: string;
      inReplyTo?: string;
      references?: string;
    }
  | { action: 'prepare_draft_send'; draftId: string }
  | ({ action: 'send_draft' } & GmailDraftSendSnapshot);

export function gmailHasStandingAuthorization(request: unknown): boolean {
  return !(
    typeof request === 'object' &&
    request !== null &&
    'action' in request &&
    request.action === 'send_draft'
  );
}

export function createGmailTool(deps: {
  eventStore: GmailToolStore;
  googleAccessToken: () => Promise<string | undefined>;
  gmail?: {
    search(token: string, query: string, maxResults: number, pageToken?: string): Promise<unknown>;
    readThread(token: string, threadId: string): Promise<unknown>;
    createDraft(
      token: string,
      input: Extract<GmailRequest, { action: 'create_draft' }>,
    ): Promise<unknown>;
    createReplyDraft(
      token: string,
      input: Extract<GmailRequest, { action: 'create_reply_draft' }>,
    ): Promise<unknown>;
    prepareDraftSend(token: string, draftId: string): Promise<GmailDraftSendSnapshot>;
    sendDraft(token: string, snapshot: GmailDraftSendSnapshot): Promise<unknown>;
    readSignature(token: string, accountEmail: string): Promise<GmailSignature>;
  };
}): { invoke(input: GmailInvocationInput): Promise<unknown> } {
  const gmail = deps.gmail ?? {
    search: searchGmail,
    readThread: readGmailThread,
    createDraft: createGmailDraft,
    createReplyDraft: createGmailReplyDraft,
    prepareDraftSend: readGmailDraftForSend,
    sendDraft: sendGmailDraft,
    readSignature: readGmailSignature,
  };
  const authorized = async (
    input: GmailInvocationInput,
  ): Promise<{ accountEmail: string; refreshToken: string }> => {
    const session = await deps.eventStore.getSession(input.sessionId);
    const connection = await deps.eventStore.getSessionGmailConnection(input.sessionId);
    const settings = await deps.eventStore.getVeritySettings();
    if (
      session === undefined ||
      session.projectId !== input.projectId ||
      connection === undefined ||
      settings?.gmailAuthorized !== true ||
      !settings.googleDriveRefreshToken?.trim() ||
      settings.googleDriveAccountEmail?.toLowerCase() !== connection.accountEmail.toLowerCase()
    ) {
      throw new Error('Gmail is not enabled for the calling session');
    }
    return {
      accountEmail: settings.googleDriveAccountEmail,
      refreshToken: settings.googleDriveRefreshToken,
    };
  };
  const verifyCredentialUnchanged = async (
    input: GmailInvocationInput,
    expected: { accountEmail: string; refreshToken: string },
  ): Promise<void> => {
    const current = await authorized(input);
    if (
      current.accountEmail.toLowerCase() !== expected.accountEmail.toLowerCase() ||
      current.refreshToken !== expected.refreshToken
    ) {
      throw new Error('The connected Gmail account changed during this operation');
    }
  };
  return {
    async invoke(input) {
      const credential = await authorized(input);
      const request = input.request as GmailRequest;
      if (typeof request !== 'object' || request === null || typeof request.action !== 'string') {
        throw new Error('Gmail request requires an action');
      }
      const token = await deps.googleAccessToken();
      if (token === undefined) throw new Error('Gmail is not connected');
      if (request.action === 'search') {
        await verifyCredentialUnchanged(input, credential);
        return gmail.search(token, request.query, request.maxResults ?? 10, request.pageToken);
      }
      if (request.action === 'read_thread') {
        await verifyCredentialUnchanged(input, credential);
        return gmail.readThread(token, request.threadId);
      }
      if (request.action === 'prepare_draft_send') {
        await verifyCredentialUnchanged(input, credential);
        return gmail.prepareDraftSend(token, request.draftId);
      }
      if (
        request.action !== 'create_draft' &&
        request.action !== 'create_reply_draft' &&
        request.action !== 'send_draft'
      ) {
        throw new Error('Unsupported Gmail action');
      }
      const requestWithSignature =
        request.action === 'create_draft' || request.action === 'create_reply_draft'
          ? {
              ...request,
              ...appendGmailSignature(
                request.body,
                await gmail.readSignature(token, credential.accountEmail),
              ),
            }
          : request;
      const claim = await deps.eventStore.claimGoogleWorkspaceInvocation(input);
      if (claim.status === 'completed') return claim.result;
      if (claim.status === 'pending') {
        throw new Error(
          request.action === 'send_draft'
            ? 'This Gmail draft may already have been sent; check Gmail sent mail'
            : 'This Gmail draft may already have been created; check Gmail drafts',
        );
      }
      await verifyCredentialUnchanged(input, credential);
      const result =
        requestWithSignature.action === 'create_draft'
          ? await gmail.createDraft(token, requestWithSignature)
          : requestWithSignature.action === 'create_reply_draft'
            ? await gmail.createReplyDraft(token, requestWithSignature)
            : await gmail.sendDraft(token, requestWithSignature);
      await deps.eventStore.completeGoogleWorkspaceInvocation(input.invocationId, result);
      return result;
    },
  };
}
