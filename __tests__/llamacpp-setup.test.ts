import {
  buildDaemonStartScript,
  buildDeleteModelCommand,
  buildDownloadCommand,
  buildModelContentLengthCommand,
  buildModelDownloadedBytesCommand,
  buildRecommendedStartCommand,
  buildSetupSteps,
  computeModelDownloadProgress,
  parseProbeBytes,
  getModelById,
  getModelRuntimeProfile,
  getRecommendedModel,
  MODEL_CATALOG,
} from '@/lib/llamacpp-setup';
import en from '@/lib/i18n/locales/en';
import ja from '@/lib/i18n/locales/ja';

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
      'minicpm5-2b-q4',
      'qwen3.5-4b-q4',
    ]);
  });

  it('lists MiniCPM5-2B as an opt-in (never default) candidate with i18n keys', () => {
    const model = getModelById('minicpm5-2b-q4')!;
    expect(model).toMatchObject({
      huggingFaceRepo: 'openbmb/MiniCPM5-2B-GGUF',
      filename: 'MiniCPM5-2B-Q4_K_M.gguf',
      downloadUrl:
        'https://huggingface.co/openbmb/MiniCPM5-2B-GGUF/resolve/main/MiniCPM5-2B-Q4_K_M.gguf',
      quantization: 'Q4_K_M',
      descriptionKey: 'llama.model.minicpm5_2b.description',
      badgeKey: 'llama.model.minicpm5_2b.badge',
    });
    expect(model.recommended).toBeFalsy();
    expect(model.hidden).toBeFalsy();
    // 2026-10-06 on-device eval: not adopted, kept as an experimental opt-in.
    expect((en as Record<string, string>)['llama.model.minicpm5_2b.badge']).toBe('Experimental');
    expect((en as Record<string, string>)['llama.model.minicpm5_2b.description']).toContain('Qwen3.5-2B is recommended');
    expect((ja as Record<string, string>)['llama.model.minicpm5_2b.badge']).toBe('実験的');
    expect(getRecommendedModel().id).toBe('qwen3.5-0.8b-q4');
    // Same small-tier runtime profile as Qwen3.5-2B.
    expect(getModelRuntimeProfile(model)).toEqual(
      getModelRuntimeProfile(getModelById('qwen3.5-2b-q4')!),
    );
  });

  it('has en and ja strings for every catalog i18n key', () => {
    const enMap: Record<string, string> = en;
    const jaMap: Record<string, string> = ja;
    for (const model of MODEL_CATALOG) {
      for (const key of [model.descriptionKey, model.badgeKey]) {
        if (!key) continue;
        expect(typeof enMap[key]).toBe('string');
        expect(typeof jaMap[key]).toBe('string');
      }
    }
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

describe('model download progress', () => {
  const model = getModelById('qwen3.5-2b-q4')!;

  it('download command is quiet and probes read the same destination', () => {
    const cmd = buildDownloadCommand(model);
    expect(cmd).toContain('curl -sS -L --fail --retry 3 --retry-delay 2 -C - -o "$MODEL_DEST"');
    expect(cmd).toContain('wget -q -c -O "$MODEL_DEST"');
    const probe = buildModelDownloadedBytesCommand(model);
    expect(probe).toContain(`F="$HOME/models/${model.filename}"`);
    expect(probe).toContain('stat -c %s');
    // Not matched by the wrapper's long-timeout download heuristic.
    expect(probe).not.toContain('MODEL_URL=');
    expect(buildModelContentLengthCommand(model)).toContain('curl -sIL');
  });

  it('parses probe output and computes clamped progress', () => {
    expect(parseProbeBytes('12345\n')).toBe(12345);
    expect(parseProbeBytes('0')).toBeNull();
    expect(parseProbeBytes('')).toBeNull();
    expect(computeModelDownloadProgress(model, 500e6, 1000e6)).toEqual({
      downloadedMb: 500,
      totalMb: 1000,
      percent: 50,
      approximate: false,
    });
    const approx = computeModelDownloadProgress(model, 10e9, null);
    expect(approx.approximate).toBe(true);
    expect(approx.totalMb).toBe(Math.round(model.sizeGb * 1000));
    expect(approx.percent).toBe(99);
  });

  it('has en/ja strings for both progress variants', () => {
    for (const key of ['llama.download_progress', 'llama.download_progress_approx'] as const) {
      expect((en as Record<string, string>)[key]).toContain('{{percent}}');
      expect((ja as Record<string, string>)[key]).toContain('{{downloaded}}');
    }
  });
});

describe('llama.cpp install script output', () => {
  it('keeps curl/wget quiet so the Setup log has no progress-meter table', () => {
    const install = buildSetupSteps().find((s) => s.id === 'install_llamacpp')!.command;
    expect(install).toContain('curl -sS -L --fail --retry 3 --retry-delay 2 -o "$tmp_file"');
    expect(install).toContain('wget -q -O "$tmp_file"');
    expect(install).not.toMatch(/curl -L --fail/);
    // Fail-closed sha256 + fallback logic stays intact.
    expect(install).toContain('refusing to install');
    expect(install).toContain('scan_release_fallback');
  });
});
