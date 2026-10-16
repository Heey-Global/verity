import {
  resolveGoogleServiceCredential,
  type GoogleServiceCredentialStore,
} from './google-service-credentials.js';
import {
  appendGmailSignature,
  downloadGmailAttachment,
  createGmailDraft,
  prepareGmailReplyDraft,
  listGmailSendAs,
  selectGmailSender,
  type GmailSendAs,
  type GmailDraftInput,
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

export interface GmailToolStore extends GoogleServiceCredentialStore {
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
  | { action: 'list_senders' }
  | { action: 'search'; query: string; maxResults?: number; pageToken?: string }
  | { action: 'read_thread'; threadId: string }
  | { action: 'download_attachment'; messageId: string; partId: string }
  | {
      action: 'create_reply_draft';
      threadId: string;
      messageId?: string;
      body: string;
      htmlBody?: string;
    }
  | {
      action: 'create_draft';
      from?: string;
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
  googleAccessToken: (accountId?: string) => Promise<string | undefined>;
  gmail?: {
    search(token: string, query: string, maxResults: number, pageToken?: string): Promise<unknown>;
    downloadAttachment?(token: string, messageId: string, partId: string): Promise<unknown>;
    readThread(token: string, threadId: string): Promise<unknown>;
    createDraft(
      token: string,
      input: Extract<GmailRequest, { action: 'create_draft' }>,
    ): Promise<unknown>;
    listSenders(token: string): Promise<GmailSendAs[]>;
    prepareReplyDraft(
      token: string,
      input: Extract<GmailRequest, { action: 'create_reply_draft' }>,
      aliases: GmailSendAs[],
    ): Promise<GmailDraftInput>;
    prepareDraftSend(token: string, draftId: string): Promise<GmailDraftSendSnapshot>;
    sendDraft(token: string, snapshot: GmailDraftSendSnapshot): Promise<unknown>;
    readSignature(token: string, accountEmail: string): Promise<GmailSignature>;
  };
}): { invoke(input: GmailInvocationInput): Promise<unknown> } {
  const gmail = deps.gmail ?? {
    downloadAttachment: downloadGmailAttachment,
    search: searchGmail,
    readThread: readGmailThread,
    createDraft: createGmailDraft,
    listSenders: listGmailSendAs,
    prepareReplyDraft: prepareGmailReplyDraft,
    prepareDraftSend: readGmailDraftForSend,
    sendDraft: sendGmailDraft,
    readSignature: readGmailSignature,
  };
  const authorized = async (
    input: GmailInvocationInput,
  ): Promise<{
    accountId?: string;
    credentialVersion?: number;
    accountEmail: string;
    refreshToken: string;
  }> => {
    const session = await deps.eventStore.getSession(input.sessionId);
    if (deps.eventStore.getGoogleServiceCredentials) {
      if (session?.projectId !== input.projectId)
        throw new Error('Google access is restricted to the calling session');
      const credential = await resolveGoogleServiceCredential(
        deps.eventStore,
        input.sessionId,
        'gmail',
      );
      return {
        credentialVersion: credential.credentialVersion,
        accountId: credential.accountId,
        accountEmail: credential.accountEmail,
        refreshToken: credential.refreshToken,
      };
    }
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
      throw new Error(
        'Gmail is not enabled for the calling session. Enable it for this chat, or grant project-wide access in Project settings → Connections',
      );
    }
    return {
      accountEmail: settings.googleDriveAccountEmail,
      refreshToken: settings.googleDriveRefreshToken,
    };
  };
  const verifyCredentialUnchanged = async (
    input: GmailInvocationInput,
    expected: {
      accountId?: string;
      credentialVersion?: number;
      accountEmail: string;
      refreshToken: string;
    },
  ): Promise<void> => {
    const current = await authorized(input);
    if (
      current.accountEmail.toLowerCase() !== expected.accountEmail.toLowerCase() ||
      current.refreshToken !== expected.refreshToken ||
      current.accountId !== expected.accountId ||
      current.credentialVersion !== expected.credentialVersion
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
      const token = await deps.googleAccessToken(credential.accountId);
      if (token === undefined) throw new Error('Gmail is not connected');
      if (request.action === 'list_senders') {
        await verifyCredentialUnchanged(input, credential);
        return gmail.listSenders(token);
      }
      if (request.action === 'search') {
        await verifyCredentialUnchanged(input, credential);
        return gmail.search(token, request.query, request.maxResults ?? 10, request.pageToken);
      }
      if (request.action === 'read_thread') {
        await verifyCredentialUnchanged(input, credential);
        return gmail.readThread(token, request.threadId);
      }
      if (request.action === 'download_attachment') {
        await verifyCredentialUnchanged(input, credential);
        return (gmail.downloadAttachment ?? downloadGmailAttachment)(
          token,
          request.messageId,
          request.partId,
        );
      }
      if (request.action === 'prepare_draft_send') {
        await verifyCredentialUnchanged(input, credential);
        const snapshot = await gmail.prepareDraftSend(token, request.draftId);
        return {
          ...snapshot,
          ...(credential.accountId
            ? { accountId: credential.accountId, credentialVersion: credential.credentialVersion }
            : {}),
        };
      }
      if (
        request.action !== 'create_draft' &&
        request.action !== 'create_reply_draft' &&
        request.action !== 'send_draft'
      ) {
        throw new Error('Unsupported Gmail action');
      }
      if (
        request.action === 'send_draft' &&
        credential.accountId &&
        (request.accountId !== credential.accountId ||
          request.credentialVersion !== credential.credentialVersion)
      )
        throw new Error('The Gmail account changed since the draft was prepared; prepare it again');
      let requestWithSignature: Extract<GmailRequest, { action: 'create_draft' | 'send_draft' }>;
      if (request.action === 'create_draft' || request.action === 'create_reply_draft') {
        const aliases = await gmail.listSenders(token);
        const draft =
          request.action === 'create_reply_draft'
            ? await gmail.prepareReplyDraft(token, request, aliases)
            : { ...request, from: selectGmailSender(aliases, request.from) };
        const from = selectGmailSender(aliases, draft.from);
        requestWithSignature = {
          ...draft,
          action: 'create_draft',
          from,
          ...appendGmailSignature(request.body, await gmail.readSignature(token, from)),
        };
      } else {
        requestWithSignature = request;
      }
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
          : await gmail.sendDraft(token, requestWithSignature);
      await deps.eventStore.completeGoogleWorkspaceInvocation(input.invocationId, result);
      return result;
    },
  };
}
