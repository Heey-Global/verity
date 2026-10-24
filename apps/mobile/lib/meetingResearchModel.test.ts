import {
  fasterMeetingModel,
  meetingModelChoice,
  meetingResearchModel,
  setMeetingModel,
} from './meetingResearchModel';
import type { VerityClient } from '@verity/mobile';

test('only selects advertised models on the same backend', () => {
  expect(fasterMeetingModel('claude-opus-5-5', ['claude-sonnet-5-5'])).toBe('claude-sonnet-5-5');
  expect(fasterMeetingModel('codex/gpt-6-astra', ['codex/gpt-6-luna'])).toBe('codex/gpt-6-luna');
  expect(fasterMeetingModel('codex/default', ['claude-sonnet-5-5'])).toBeUndefined();
  expect(fasterMeetingModel('claude-sonnet-5-5', ['claude-sonnet-5-5'])).toBeUndefined();
  expect(fasterMeetingModel('claude-haiku-5-5', ['claude-sonnet-5-5'])).toBeUndefined();
  expect(fasterMeetingModel('opencode/provider/model', ['codex/gpt-6-luna'])).toBeUndefined();
});

test('uses the project model catalog and retains the session model on discovery failure', async () => {
  const getSession = jest.fn().mockResolvedValue({ model: 'codex/default', projectId: 'project' });
  const listModels = jest.fn().mockResolvedValue({ models: ['codex/gpt-6-luna'] });
  const client = { getSession, listModels } as unknown as VerityClient;
  expect(await meetingResearchModel(client, 'session')).toBe('codex/gpt-6-luna');
  expect(listModels).toHaveBeenCalledWith('project');
  listModels.mockRejectedValueOnce(new Error('offline'));
  expect(await meetingResearchModel(client, 'session')).toBeUndefined();
});

test('a model picked in a meeting wins over the faster default for that meeting only', async () => {
  const getSession = jest.fn().mockResolvedValue({ model: 'claude-opus-5-5', projectId: null });
  const listModels = jest
    .fn()
    .mockResolvedValue({ models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'codex/gpt-6-luna'] });
  const client = { getSession, listModels } as unknown as VerityClient;
  setMeetingModel('meeting-1', 'claude-opus-5-5');
  expect(await meetingResearchModel(client, 'session', 'meeting-1')).toBe('claude-opus-5-5');
  // Another meeting in the same chat still gets the faster model.
  expect(await meetingModelChoice(client, 'session', 'meeting-2')).toEqual({
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'codex/gpt-6-luna'],
    model: 'claude-sonnet-5-5',
    effective: 'claude-sonnet-5-5',
  });
  // A choice the project stopped offering falls back instead of failing the request.
  setMeetingModel('meeting-3', 'claude-fable-5-1');
  expect(await meetingResearchModel(client, 'session', 'meeting-3')).toBe('claude-sonnet-5-5');
});
