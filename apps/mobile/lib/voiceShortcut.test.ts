import {
  dispatchVerityShortcut,
  dispatchVoiceShortcut,
  subscribeVerityShortcut,
  subscribeVoiceShortcut,
} from './voiceShortcut';

it('keeps Verity separate from chat dictation and removes unmounted listeners', () => {
  const chat = jest.fn();
  const verity = jest.fn();
  const removeChat = subscribeVoiceShortcut(chat);
  const removeVerity = subscribeVerityShortcut(verity);
  try {
    dispatchVerityShortcut();
    expect(verity).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
    dispatchVoiceShortcut();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(verity).toHaveBeenCalledTimes(1);
    removeVerity();
    removeChat();
    dispatchVerityShortcut();
    dispatchVoiceShortcut();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(verity).toHaveBeenCalledTimes(1);
  } finally {
    removeVerity();
    removeChat();
  }
});

it('carries how Verity should open', () => {
  const verity = jest.fn();
  const remove = subscribeVerityShortcut(verity);
  try {
    dispatchVerityShortcut({ mode: 'text' });
    dispatchVerityShortcut();
    expect(verity.mock.calls).toEqual([[{ mode: 'text' }], [{}]]);
  } finally {
    remove();
  }
});
