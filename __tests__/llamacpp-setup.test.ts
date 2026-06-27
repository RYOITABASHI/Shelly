import {
  buildDaemonStartScript,
  buildDeleteModelCommand,
  buildRecommendedStartCommand,
  getModelById,
  getModelRuntimeProfile,
  getRecommendedModel,
  MODEL_CATALOG,
} from '@/lib/llamacpp-setup';

describe('llama.cpp local server tuning', () => {
  it('uses the light autonomous profile as the recommended default', () => {
    const model = getRecommendedModel();
    const command = buildRecommendedStartCommand(model, '$HOME/models/model.gguf');

    expect(model.filename).toBe('Qwen3.5-0.8B-Q4_K_M.gguf');
    // Context window must be large enough for agent prompts that inject project
    // context (a real run overflowed a 1024 window at 7806 tokens).
    expect(command).toContain('--ctx-size 8192');
    expect(command).not.toContain('--ctx-size 1024');
    expect(command).toContain('--threads 2');
    expect(command).toContain('--alias "model"');
  });

  it('gives the small work tiers a large window and heavier tiers a moderate one', () => {
    const twoB = getModelById('qwen3.5-2b-q4');
    const fourB = getModelById('qwen3.5-4b-q4');

    expect(twoB && getModelRuntimeProfile(twoB)).toMatchObject({
      contextSize: 8192,
      threads: 4,
      idleTimeoutSeconds: 1800,
    });
    expect(fourB && getModelRuntimeProfile(fourB)).toMatchObject({
      contextSize: 4096,
      idleTimeoutSeconds: 900,
    });
  });

  it('keeps llama-server background priority interactive', () => {
    const model = getRecommendedModel();
    const script = buildDaemonStartScript(model, '$HOME/models/model.gguf');

    expect(script).toContain('/system/bin/nice -n 5');
    expect(script).toContain('LLAMA_SERVER_IDLE_TIMEOUT_SECONDS');
    expect(script).toContain('llama-server-watcher.pid');
    expect(script).toContain('llama-server.activity');
    expect(script).toContain('llama-server.active');
    expect(script).toContain('ACTIVE_COUNT="$(find "$ACTIVE_DIR" -type f -name');
    expect(script).toContain('continue');
    expect(script).toContain('Waiting for active local LLM request to finish');
    expect(script).toContain('--alias "model"');
    expect(script.indexOf('Idle auto-stop')).toBeGreaterThan(script.indexOf('llama-server ready'));
  });

  it('shows only the recommended three install candidates while preserving legacy deletion metadata', () => {
    const nineB = getModelById('qwen3.5-9b-q4');
    const visibleIds = MODEL_CATALOG.filter((model) => !model.hidden).map((model) => model.id);

    expect(nineB).toMatchObject({
      filename: 'Qwen3.5-9B-Q4_K_M.gguf',
      hidden: true,
    });
    expect(visibleIds).toEqual([
      'qwen3.5-2b-q4',
      'qwen3.5-0.8b-q4',
      'qwen3.5-4b-q4',
    ]);
  });

  it('deletes the detected installed model path', () => {
    const model = getModelById('qwen3.5-2b-q4')!;
    const command = buildDeleteModelCommand(
      model,
      '/sdcard/Download/ShellyModels/Qwen3.5-2B-Q4_K_M.gguf',
    );

    expect(command).toContain("target='/sdcard/Download/ShellyModels/Qwen3.5-2B-Q4_K_M.gguf'");
    expect(command).toContain('rm -f -- "$target"');
    expect(command).not.toContain('$HOME/models/Qwen3.5-2B-Q4_K_M.gguf');
  });

  it('keeps the fallback model path expandable', () => {
    const model = getModelById('qwen3.5-2b-q4')!;
    const command = buildDeleteModelCommand(model);

    expect(command).toContain('target="$HOME/models/Qwen3.5-2B-Q4_K_M.gguf"');
    expect(command).not.toContain("target='$HOME/models/Qwen3.5-2B-Q4_K_M.gguf'");
  });

  it('does not delete a loosely matched variant path as the catalog model', () => {
    const model = getModelById('qwen3.5-2b-q4')!;
    const command = buildDeleteModelCommand(
      model,
      '/sdcard/Download/ShellyModels/Qwen3.5-2B-Q5_K_M.gguf',
    );

    expect(command).toContain('target="$HOME/models/Qwen3.5-2B-Q4_K_M.gguf"');
    expect(command).not.toContain('/sdcard/Download/ShellyModels/Qwen3.5-2B-Q5_K_M.gguf');
  });
});
