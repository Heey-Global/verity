import AsyncStorage from '@react-native-async-storage/async-storage';

import { rememberMeetingExecuteGrant, readMeetingExecuteProject } from './meetingExecuteCache';

it('retains confirmed meeting access only for the recorded account and session', async () => {
  await AsyncStorage.clear();
  rememberMeetingExecuteGrant('account-a:session-a', 'project-a');
  await expect(readMeetingExecuteProject('account-a:session-a')).resolves.toBe('project-a');
  await expect(readMeetingExecuteProject('account-a:session-b')).resolves.toBeUndefined();
  await expect(readMeetingExecuteProject('account-b:session-a')).resolves.toBeUndefined();

  rememberMeetingExecuteGrant('account-a:session-a', undefined);
  await expect(readMeetingExecuteProject('account-a:session-a')).resolves.toBeUndefined();
});

it('rejects a cached grant after denial even if storage could not remove it', async () => {
  const key = 'account:session-with-failed-write';
  rememberMeetingExecuteGrant(key, 'project');
  await expect(readMeetingExecuteProject(key)).resolves.toBe('project');

  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('Storage unavailable'));
  rememberMeetingExecuteGrant(key, undefined);

  await expect(readMeetingExecuteProject(key)).resolves.toBeUndefined();
  await expect(AsyncStorage.getItem('verity.meeting.acl')).resolves.toBeNull();
});
