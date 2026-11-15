import type { UserTextMessage } from '@verity/mobile';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

// Who sent each message, in a session several people write in: names by user id
// and the signed-in person. Absent (null) when one person works alone, whose
// transcript stays unlabelled.
const SessionPeopleContext = createContext<{
  people: Readonly<Record<string, string>>;
  viewerUserId: string | undefined;
} | null>(null);

export function SessionPeopleProvider({
  people,
  viewerUserId,
  children,
}: {
  people: Readonly<Record<string, string>> | undefined;
  viewerUserId: string | undefined;
  children: ReactNode;
}) {
  const value = useMemo(
    () => (people === undefined ? null : { people, viewerUserId }),
    [people, viewerUserId],
  );
  return <SessionPeopleContext.Provider value={value}>{children}</SessionPeopleContext.Provider>;
}

/**
 * The name a user message is labelled with in a shared session, and whether it
 * came from someone other than the reader. Someone else's message sits on the
 * other side, like an agent's, so the reader can tell them apart.
 */
export function useMessageSender(message: UserTextMessage): {
  sender: string | undefined;
  fromOther: boolean;
} {
  const shared = useContext(SessionPeopleContext);
  const senderId =
    message.initiatedBy?.userId ?? (message.pending ? shared?.viewerUserId : undefined);
  const sender =
    shared !== null && !message.peer && senderId !== undefined
      ? shared.people[senderId]
      : undefined;
  return { sender, fromOther: sender !== undefined && senderId !== shared?.viewerUserId };
}
