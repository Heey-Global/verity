import { isProjectSessionModel } from './projectSessionModels';

describe('project session model selection', () => {
  it('keeps configured OpenCode models alongside subscription models', () => {
    // A successful API-key setup must not leave its entire catalog hidden.
    const models = [
      'claude-sonnet-4-6',
      'codex/default',
      'verity/gpt-4.1',
      'verity/provider/model',
    ];
    expect(models.filter(isProjectSessionModel)).toEqual(models);
  });

  it.each(['openai/gpt-4.1', 'provider/model', 'verity/'])(
    'rejects a model outside the configured gateway: %s',
    (model) => {
      expect(isProjectSessionModel(model)).toBe(false);
    },
  );
});
