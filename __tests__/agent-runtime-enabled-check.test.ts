import * as fs from 'fs';
import * as path from 'path';

// Security audit Finding 6 (widget/notify TOCTOU audit, MEDIUM): an agent's
// `enabled` flag was re-checked at ShellyNotificationListener.kt (notification-
// triggered runs) and WidgetAgentRepository.scheduledById() (manual widget
// runs) but NOT at the actual native run chokepoint, AgentRuntime.runAgent().
// A straggler AgentAlarmReceiver fire (an alarm armed before the user
// disabled the agent, not yet cancelled/re-armed) — or any other caller that
// reaches AgentRuntime directly — could still execute a disabled (not
// deleted) agent. This test asserts the fail-closed re-check landed at that
// chokepoint, source-level, the same way plan-executor-parity.test.ts and
// agent-alarm-request-code-race.test.ts assert native Kotlin logic that
// can't be unit-tested directly from this repo.

const agentRuntime = fs.readFileSync(
  path.resolve(
    __dirname,
    '..',
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentRuntime.kt',
  ),
  'utf8',
);

const terminalSessionService = fs.readFileSync(
  path.resolve(
    __dirname,
    '..',
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalSessionService.kt',
  ),
  'utf8',
);

const widgetAgentRepository = fs.readFileSync(
  path.resolve(
    __dirname,
    '..',
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/scouter/WidgetAgentRepository.kt',
  ),
  'utf8',
);

const notificationListener = fs.readFileSync(
  path.resolve(
    __dirname,
    '..',
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/ShellyNotificationListener.kt',
  ),
  'utf8',
);

describe('AgentRuntime.runAgent enabled re-check (TOCTOU Finding 6)', () => {
  it('re-checks enabled before any dispatch decision, ahead of the LibExtractor call', () => {
    const runAgentStart = agentRuntime.indexOf('fun runAgent(');
    const libExtractorCall = agentRuntime.indexOf('LibExtractor.extractAll(appContext)');
    const enabledCheckCall = agentRuntime.indexOf('if (unattended && !isAgentEnabled(homeDir, agentId))', runAgentStart);

    expect(runAgentStart).toBeGreaterThan(-1);
    expect(enabledCheckCall).toBeGreaterThan(runAgentStart);
    // Must run before the plan-executor-vs-legacy-script branch decision and
    // before any filesystem work that assumes the agent may run, so it
    // gates BOTH the legacy .sh path and the PlanSpec executor path from a
    // single call site.
    expect(enabledCheckCall).toBeLessThan(libExtractorCall);
  });

  it('gates the check on unattended=true, not unconditionally, so the manual "Run now" override stays intact', () => {
    // Sidebar.tsx's agent-detail popup offers "Run now" as an action
    // independent from Pause/Resume: handleRunScheduledAgent (Run now) and
    // handleTogglePause (which flips `enabled` via setAgentEnabled) are two
    // separate buttons in the same Alert.alert, not gated on each other.
    // TerminalEmulatorModule.runAgent() (the native call that button makes)
    // passes no manual/interval/cron extras, so TerminalSessionService
    // computes unattended=false for it. An unconditional enabled check here
    // would silently break that intentional manual override for a paused
    // agent, so the re-check must be gated on `unattended` (true only for
    // AlarmManager-fired and widget-tap runs).
    expect(agentRuntime).toContain('if (unattended && !isAgentEnabled(homeDir, agentId))');
    expect(agentRuntime).not.toContain('if (!isAgentEnabled(homeDir, agentId))');
  });

  it('fails closed on the negative result: refuses the run, does not fall through', () => {
    const checkBlockStart = agentRuntime.indexOf('if (unattended && !isAgentEnabled(homeDir, agentId))');
    const checkBlockEnd = agentRuntime.indexOf('val libDir = try {', checkBlockStart);
    const block = agentRuntime.slice(checkBlockStart, checkBlockEnd);

    expect(block).toContain('val message = "agent disabled: $agentId"');
    expect(block).toContain('Log.i(TAG, "Agent $agentId refused: $message")');
    expect(block).toContain('writeReceiverLog(homeDir, agentId, "skipped", message)');
    // Returns directly — no continuation into script/plan dispatch.
    expect(block).toMatch(/return AgentRunResult\(agentId, 129, "", message\)/);
  });

  it('re-reads $HOME/.shelly/agents/<id>.json and requires id match + enabled=true, mirroring the widget/notification precedent', () => {
    const helperStart = agentRuntime.indexOf('private fun isAgentEnabled(');
    expect(helperStart).toBeGreaterThan(-1);
    const helperEnd = agentRuntime.indexOf('\n    }', helperStart);
    const helper = agentRuntime.slice(helperStart, helperEnd);

    expect(helper).toContain('File(homeDir, ".shelly/agents/$agentId.json")');
    expect(helper).toContain('if (!agentFile.isFile) return false');
    expect(helper).toContain('if (json.optString("id") != agentId) return false');
    expect(helper).toContain('json.optBoolean("enabled", false)');

    // Same disk path + `enabled` re-read shape already used by the two
    // call sites the audit found were already correct — this is the
    // established precedent this fix mirrors, not a new convention.
    expect(widgetAgentRepository).toContain('if (!json.optBoolean("enabled", false)) return null');
    expect(notificationListener).toContain('if (!json.optBoolean("enabled", false)) continue');
  });

  it('fails CLOSED (not enabled) on a read/parse error, unlike the fail-OPEN STOP-ALL sentinel check', () => {
    const helperStart = agentRuntime.indexOf('private fun isAgentEnabled(');
    const helperEnd = agentRuntime.indexOf('\n    }', helperStart);
    const helper = agentRuntime.slice(helperStart, helperEnd);

    expect(helper).toMatch(/catch \(e: Exception\) \{\s*\n\s*Log\.w\(TAG, "Failed to read enabled state for \$agentId; defaulting to disabled \(fail closed\)", e\)\s*\n\s*false\s*\n\s*\}/);
  });

  it('does not weaken or remove the existing global STOP-ALL kill-switch check in TerminalSessionService', () => {
    expect(terminalSessionService).toContain('isGloballyHalted()');
    expect(terminalSessionService).toContain('RUN_AGENT for $agentId suppressed: globally halted (STOP-ALL)');
    expect(terminalSessionService).toContain('File(homeDir, ".shelly/agents/.halted").exists()');
  });

  it('does not duplicate or remove the already-correct manual widget re-check', () => {
    expect(terminalSessionService).toContain('WidgetAgentRepository.scheduledById(applicationContext, agentId)');
    expect(terminalSessionService).toContain(
      'Manual widget RUN_AGENT for $agentId refused: registered scheduled agent not found',
    );
  });

  it('covers both the legacy .sh runner and the PlanSpec executor from the single runAgent() entry point', () => {
    const enabledCheckIdx = agentRuntime.indexOf('if (unattended && !isAgentEnabled(homeDir, agentId))');
    const shouldRunPlanExecutorCall = agentRuntime.indexOf('if (shouldRunPlanExecutor(homeDir, agentId))');
    const legacyMissingScriptCheck = agentRuntime.indexOf('val message = "missing script: $scriptPath"');

    expect(enabledCheckIdx).toBeGreaterThan(-1);
    expect(shouldRunPlanExecutorCall).toBeGreaterThan(enabledCheckIdx);
    expect(legacyMissingScriptCheck).toBeGreaterThan(shouldRunPlanExecutorCall);
  });

  it('confirms the manual "Run now" native call carries no manual/interval/cron extras (source basis for the unattended gate)', () => {
    const terminalEmulatorModule = fs.readFileSync(
      path.resolve(
        __dirname,
        '..',
        'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalEmulatorModule.kt',
      ),
      'utf8',
    );
    const start = terminalEmulatorModule.indexOf('AsyncFunction("runAgent")');
    const end = terminalEmulatorModule.indexOf('AsyncFunction("isIgnoringBatteryOptimizations")', start);
    const block = start >= 0 && end > start ? terminalEmulatorModule.slice(start, end) : '';

    expect(block).toContain('putExtra(TerminalSessionService.EXTRA_AGENT_ID, agentId)');
    // No EXTRA_MANUAL / EXTRA_INTERVAL_MS / EXTRA_CRON on this call, so
    // TerminalSessionService computes manual=false, scheduled=false, and
    // therefore unattended=false — this is what lets the enabled-gated check
    // stay a no-op for the in-app "Run now" button.
    expect(block).not.toContain('EXTRA_MANUAL');
    expect(block).not.toContain('EXTRA_INTERVAL_MS');
    expect(block).not.toContain('EXTRA_CRON');

    expect(terminalSessionService).toContain('val manual = intent.getBooleanExtra(EXTRA_MANUAL, false)');
    expect(terminalSessionService).toContain('val scheduled = intervalMs > 0 || !cron.isNullOrBlank()');
    expect(terminalSessionService).toContain('val unattended = scheduled || manual');
  });

  it('confirms Sidebar.tsx offers "Run now" as an action independent from Pause/Resume', () => {
    const sidebar = fs.readFileSync(
      path.resolve(__dirname, '..', 'components/layout/Sidebar.tsx'),
      'utf8',
    );
    expect(sidebar).toContain("{ text: t('sidebar.agent_run_now'), onPress: () => void handleRunScheduledAgent(agent.id, agent.name) }");
    expect(sidebar).toContain(
      "{ text: agent.enabled ? t('sidebar.agent_pause') : t('sidebar.agent_resume'), onPress: () => void handleTogglePause(agent) }",
    );
  });
});
