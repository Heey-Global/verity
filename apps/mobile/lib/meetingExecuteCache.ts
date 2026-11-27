import AsyncStorage from '@react-native-async-storage/async-storage';

const meetingAccessStorage = 'verity.meeting.acl';
let writes = Promise.resolve();
const denied = new Map<string, object>();

async function read(): Promise<[string, string][]> {
  const stored = await AsyncStorage.getItem(meetingAccessStorage);
  if (stored === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  return Array.isArray(parsed)
    ? parsed.filter(
        (value): value is [string, string] =>
          Array.isArray(value) &&
          value.length === 2 &&
          value.every((entry) => typeof entry === 'string'),
      )
    : [];
}

export async function readMeetingExecuteProject(key: string): Promise<string | undefined> {
  await writes;
  const grant = (await read()).find(([entry]) => entry === key)?.[1];
  return denied.has(key) ? undefined : grant;
}

export function rememberMeetingExecuteGrant(key: string, projectId: string | undefined): void {
  if (projectId === undefined) denied.set(key, {});
  const denial = denied.get(key);
  writes = writes
    .then(async () => {
      const keys = (await read()).filter(([entry]) => entry !== key);
      if (projectId !== undefined) keys.unshift([key, projectId]);
      await AsyncStorage.setItem(meetingAccessStorage, JSON.stringify(keys.slice(0, 64)));
      if (denial !== undefined && denied.get(key) === denial) denied.delete(key);
    })
    .catch(async () => {
      if (projectId === undefined)
        await AsyncStorage.removeItem(meetingAccessStorage).catch(() => undefined);
    });
}
