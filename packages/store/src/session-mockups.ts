import { createHash } from 'node:crypto';

export const MOCKUP_HTML_ATTACHMENT = 'application/vnd.verity.mockup-html';

/** The session-derived mask keeps identical HTML isolated by session while
 * leaving the existing content addresses for generic attachments intact. */
export function attachmentContentAddress(bytes: Buffer, sessionId?: string): string {
  if (sessionId === undefined) return createHash('sha256').update(bytes).digest('hex');
  const mask = createHash('sha256').update('verity-mockup:').update(sessionId).digest();
  const digest = createHash('sha256').update(bytes).digest();
  for (const [index, byte] of mask.entries()) digest[index] = digest[index]! ^ byte;
  return digest.toString('hex');
}

export function attachmentStorageRecord(base64Data: string, mediaType: string, sessionId?: string) {
  const bytes = Buffer.from(base64Data, 'base64');
  const ordinaryType =
    mediaType === MOCKUP_HTML_ATTACHMENT ? 'application/octet-stream' : mediaType;
  return {
    hash: attachmentContentAddress(bytes, sessionId),
    media_type: sessionId === undefined ? ordinaryType : MOCKUP_HTML_ATTACHMENT,
    bytes,
  };
}

// Mockup review state of a session: the screens an agent presented and the
// reviewer's marks, as stored and as read back.

/** `pending`: screens wait for the reviewer, who marks each one and discusses them
 *  in the chat. `revising`: written by earlier versions, which sent comments for a
 *  revision; read as `pending` (see {@link storedMockupState}). `approved`: the user told the agent to implement and
 *  the review ended. */
export type SessionMockupState = 'pending' | 'revising' | 'approved';

/** One presented screen. The artifact is a snapshot in the attachment store, so the
 *  round stays as it was reviewed even when the agent rewrites the file later. */
export interface MockupScreenRecord {
  name: string;
  /** Content address of the artifact in the attachment store. */
  attachment: string;
  mediaType: 'image/png' | 'image/jpeg' | 'text/html';
  width: number;
  height: number;
  verdict: MockupVerdict;
}

/** The reviewer's mark on one screen. Only marks: neither starts any work. */
export type MockupVerdict = 'open' | 'approved' | 'discarded';

/** Stored screens, with marks from earlier versions mapped onto the current ones:
 *  a commented screen was one the reviewer did not accept, so it reads as
 *  discarded and never as approved. */
export function storedMockupScreens(raw: unknown): MockupScreenRecord[] {
  if (!Array.isArray(raw)) return [];
  const entries = raw.filter(
    (entry): entry is Omit<MockupScreenRecord, 'verdict'> & { verdict: string } =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { name?: unknown }).name === 'string' &&
      typeof (entry as { attachment?: unknown }).attachment === 'string' &&
      typeof (entry as { width?: unknown }).width === 'number' &&
      typeof (entry as { height?: unknown }).height === 'number',
  );
  return entries.map(({ name, attachment, mediaType, width, height, verdict }) => ({
    name,
    attachment,
    mediaType,
    width,
    height,
    verdict: verdict === 'approved' ? 'approved' : verdict === 'open' ? 'open' : 'discarded',
  }));
}

export interface SessionMockupReview {
  state: SessionMockupState;
  /** Increments with each presentation; decisions name the round they were made for. */
  revision: number;
  screens: MockupScreenRecord[];
}

/** The review as stored; `state` null before the first presentation. */
export interface SessionMockups {
  state: SessionMockupState | null;
  revision: number;
  screens: MockupScreenRecord[];
}

/** A round an earlier version left `revising` already handed its comments to the
 *  agent; nothing moves it on any more, so it reads as open for marks again. */
export function storedMockupState(state: SessionMockupState | null): SessionMockupState | null {
  return state === 'revising' ? 'pending' : state;
}

export function mockupReview(
  rawState: SessionMockupState | null,
  revision: number,
  screens: unknown,
): { mockupReview?: SessionMockupReview } {
  const state = storedMockupState(rawState);
  if (state === null) return {};
  return {
    mockupReview: {
      state,
      revision,
      screens: storedMockupScreens(screens),
    },
  };
}
