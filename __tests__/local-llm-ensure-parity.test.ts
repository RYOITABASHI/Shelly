import * as fs from 'fs';
import * as path from 'path';

// docs/superpowers/DEFERRED.md "PlanSpec executor 経由の無人スケジュール実行に
// local LLM autostart が無い" (2026-07-18): scripts/shelly-local-llm-ensure.sh
// ships as an APK asset and is kept in scripts/ for host tests; they MUST stay
// byte-identical (same invariant as shelly-plan-executor.js /
// shelly-capability-broker.js — a drift would let CI test one version while
// the device ships another). This is a pure extraction (duplicate) of
// ensure_local_llm_server() and its helper closure out of
// lib/agent-executor.ts's generateRunScript() bash template — see this file's
// own header comment for the full function inventory.
describe('shelly-local-llm-ensure.sh parity', () => {
  const root = path.resolve(__dirname, '..');
  const scriptCopy = path.join(root, 'scripts', 'shelly-local-llm-ensure.sh');
  const assetCopy = path.join(
    root,
    'modules/terminal-emulator/android/src/main/assets/shelly-local-llm-ensure.sh',
  );
  const scriptSrc = fs.readFileSync(scriptCopy, 'utf8');
  const homeInitializer = fs.readFileSync(
    path.join(
      root,
      'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt',
    ),
    'utf8',
  );
  const agentRuntime = fs.readFileSync(
    path.join(
      root,
      'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentRuntime.kt',
    ),
    'utf8',
  );

  it('scripts/ copy and the APK asset are byte-identical', () => {
    expect(fs.readFileSync(assetCopy, 'utf8')).toBe(scriptSrc);
  });

  it('is valid, self-contained bash defining every extracted function', () => {
    expect(scriptSrc).toContain('ensure_local_llm_server() {');
    expect(scriptSrc).toContain('find_llama_server_bin() {');
    expect(scriptSrc).toContain('find_local_llm_model() {');
    expect(scriptSrc).toContain('local_llm_clear_stale_start_lock() {');
  });

  it('every function ensure_local_llm_server transitively calls is defined in this file', () => {
    // Guards against a partial extraction: any helper referenced but not
    // defined here would fail as "command not found" the first time a
    // device actually hits that code path (e.g. LOCAL_LLM_INSTALL_LLAMA_SERVER=1
    // triggering the auto-install chain), which host `bash -n` cannot catch
    // since it only validates syntax, not that every called function exists.
    const requiredFunctions = [
      'shelly_app_binary_path',
      'shelly_run_app_binary',
      'shelly_node',
      'node_usable',
      'python3_usable',
      'http_get_ok',
      'http_get_text',
      'local_llm_is_loopback_url',
      'local_llm_ready',
      'local_llm_server_matches_model',
      'local_llm_port',
      'local_llm_touch_activity',
      'local_llm_cleanup_stale_active_users',
      'local_llm_wait_for_no_active_users',
      'local_llm_runtime_profile',
      'local_llm_stop_watcher',
      'local_llm_stop_server',
      'local_llm_start_idle_watcher',
      'find_llama_server_bin',
      'local_llm_normalize_model_token',
      'local_llm_path_matches_model',
      'download_file_node',
      'extract_zip_file',
      'extract_archive_file',
      'resolve_llama_server_download_url',
      'install_llama_server_bin',
      'find_local_llm_model',
      'local_llm_clear_stale_start_lock',
      'ensure_local_llm_server',
    ];
    for (const fn of requiredFunctions) {
      expect(scriptSrc).toContain(`${fn}() {`);
    }
  });

  it('HomeInitializer.kt extracts it into $HOME unconditionally, matching the other bundled helper assets', () => {
    expect(homeInitializer).toContain('"shelly-local-llm-ensure.sh"');
    expect(homeInitializer).toContain('.shelly-local-llm-ensure.sh');
  });

  it('AgentRuntime.kt sources it before the PlanSpec executor launch for tool.type=="local", falling through unconditionally to the unchanged node launch', () => {
    expect(agentRuntime).toContain('readPlanSpecToolType(plan) == "local"');
    expect(agentRuntime).toContain('ensureLocalLlmServerBeforePlanExecutor(');
    expect(agentRuntime).toContain('.shelly-local-llm-ensure.sh');
    expect(agentRuntime).toContain('ensure_local_llm_server \\"\\$LOCAL_URL\\"');
  });
});
