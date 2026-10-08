import {
  dispatchTaskVoiceShortcut,
  dispatchVoiceShortcut,
  subscribeTaskVoiceShortcut,
  subscribeVoiceShortcut,
} from './voiceShortcut';

it('keeps task capture separate from chat dictation and removes unmounted listeners', () => {
  const chat = jest.fn();
  const task = jest.fn();
  const removeChat = subscribeVoiceShortcut(chat);
  const removeTask = subscribeTaskVoiceShortcut(task);
  try {
    dispatchTaskVoiceShortcut();
    expect(task).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
    dispatchVoiceShortcut();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(task).toHaveBeenCalledTimes(1);
    removeTask();
    removeChat();
    dispatchTaskVoiceShortcut();
    dispatchVoiceShortcut();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(task).toHaveBeenCalledTimes(1);
  } finally {
    removeTask();
    removeChat();
  }
});
