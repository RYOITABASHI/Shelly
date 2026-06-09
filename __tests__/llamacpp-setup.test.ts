import {
  buildDaemonStartScript,
  buildRecommendedStartCommand,
  getRecommendedModel,
} from '@/lib/llamacpp-setup';

describe('llama.cpp local server tuning', () => {
  it('uses the fast interactive Z Fold profile for llama-server', () => {
    const model = getRecommendedModel();
    const command = buildRecommendedStartCommand(model, '$HOME/models/model.gguf');

    expect(command).toContain('--ctx-size 1024');
    expect(command).toContain('--threads 4');
  });

  it('keeps llama-server background priority interactive', () => {
    const model = getRecommendedModel();
    const script = buildDaemonStartScript(model, '$HOME/models/model.gguf');

    expect(script).toContain('/system/bin/nice -n 5');
  });
});
