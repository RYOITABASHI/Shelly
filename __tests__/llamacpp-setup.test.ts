import {
  buildDaemonStartScript,
  buildDeleteModelCommand,
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

  it('deletes the detected installed model path', () => {
    const model = getRecommendedModel();
    const command = buildDeleteModelCommand(
      model,
      '/sdcard/Download/ShellyModels/Qwen3.5-2B-Q4_K_M.gguf',
    );

    expect(command).toContain("target='/sdcard/Download/ShellyModels/Qwen3.5-2B-Q4_K_M.gguf'");
    expect(command).toContain('rm -f -- "$target"');
    expect(command).not.toContain('$HOME/models/Qwen3.5-2B-Q4_K_M.gguf');
  });

  it('keeps the fallback model path expandable', () => {
    const model = getRecommendedModel();
    const command = buildDeleteModelCommand(model);

    expect(command).toContain('target="$HOME/models/Qwen3.5-2B-Q4_K_M.gguf"');
    expect(command).not.toContain("target='$HOME/models/Qwen3.5-2B-Q4_K_M.gguf'");
  });

  it('does not delete a loosely matched variant path as the catalog model', () => {
    const model = getRecommendedModel();
    const command = buildDeleteModelCommand(
      model,
      '/sdcard/Download/ShellyModels/Qwen3.5-2B-Q5_K_M.gguf',
    );

    expect(command).toContain('target="$HOME/models/Qwen3.5-2B-Q4_K_M.gguf"');
    expect(command).not.toContain('/sdcard/Download/ShellyModels/Qwen3.5-2B-Q5_K_M.gguf');
  });
});
