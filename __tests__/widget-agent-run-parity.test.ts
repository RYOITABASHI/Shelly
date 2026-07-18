import * as fs from 'fs';
import * as path from 'path';

// Offline security gate for the widget RUN path. Jest cannot execute Android
// PendingIntents, so these checks keep the service contract and its fail-closed
// guards coupled until the device acceptance pass can exercise them end to end.
//
// Widget redesign (2026-07-18, design review): the widget went from a single
// nearest-agent status row to up to 3 per-row RUN targets (agent-launcher
// redesign). These tests were extended in lockstep — see
// docs/superpowers/DEFERRED.md for the full rationale.
const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('Scouter widget registered-agent RUN security parity', () => {
  const scheduler = read(
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentAlarmScheduler.kt',
  );
  const service = read(
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalSessionService.kt',
  );
  const provider = read(
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/scouter/ScouterWidgetProvider.kt',
  );
  const repository = read(
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/scouter/WidgetAgentRepository.kt',
  );
  const stateStore = read(
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/scouter/ScouterStateStore.kt',
  );
  const layout = read(
    'modules/terminal-emulator/android/src/main/res/layout/scouter_widget_medium.xml',
  );

  it('binds RUN directly to the foreground-service contract with a distinct PendingIntent identity, per row', () => {
    expect(provider).toContain('AgentAlarmScheduler.manualRunPendingIntent(context, agent.agentId)');
    expect(scheduler).toContain('action = TerminalSessionService.ACTION_RUN_AGENT');
    expect(scheduler).toContain('putExtra(TerminalSessionService.EXTRA_AGENT_ID, agentId)');
    expect(scheduler).toContain('putExtra(TerminalSessionService.EXTRA_MANUAL, true)');
    expect(scheduler).toContain('getAgentRequestCode(context, "widget-run:$agentId")');
    expect(scheduler).toContain('PendingIntent.getForegroundService(context, rc, intent, piFlags())');
  });

  it('revalidates up to 3 scheduled, enabled, materialized agents from disk at render and tap time', () => {
    expect(provider).toContain('WidgetAgentRepository.nextScheduledAgents(context, MAX_WIDGET_AGENT_ROWS)');
    expect(service).toContain('WidgetAgentRepository.scheduledById(applicationContext, agentId)');
    expect(repository).toContain('fun nextScheduledAgents(context: Context, limit: Int = DEFAULT_WIDGET_AGENT_LIMIT)');
    expect(repository).toContain('HomeInitializer.getHomeDir(context.applicationContext)');
    expect(repository).toContain('if (id != expectedId || !SAFE_AGENT_ID.matches(id)) return null');
    expect(repository).toContain('if (!json.optBoolean("enabled", false)) return null');
    expect(repository).toContain('AgentAlarmScheduler.nextTriggerAt(cron) ?: return null');
    expect(repository).toContain('run-agent-$id.sh');
    expect(repository).toContain('plans/plan-agent-$id.json');
  });

  it('reads each agent last-result glyph from its own run-log directory, best-effort', () => {
    expect(repository).toContain('logs/$agentId');
    expect(repository).toContain('"success" || it == "error" || it == "skipped" || it == "unavailable"');
    expect(provider).toContain('fun glyphForLastRun(status: String?)');
  });

  it('keeps widget runs unattended and does not re-arm their schedule', () => {
    expect(service).toContain('val unattended = scheduled || manual');
    expect(service).toContain('if (!manual && scheduled)');
    expect(service).toContain(
      'runAgentInBackground(agentId, tainted, unattended, manual, widgetAgent?.name)',
    );
  });

  it('checks STOP-ALL before accepting the manual widget marker', () => {
    const haltCheck = service.indexOf('if (isGloballyHalted())');
    const manualRead = service.indexOf('getBooleanExtra(EXTRA_MANUAL, false)');
    const runtimeCall = service.indexOf(
      'runAgentInBackground(agentId, tainted, unattended, manual, widgetAgent?.name)',
    );
    expect(haltCheck).toBeGreaterThan(-1);
    expect(manualRead).toBeGreaterThan(haltCheck);
    expect(runtimeCall).toBeGreaterThan(manualRead);
  });

  it('adds up to 3 dedicated row/RUN slots without adding a schedule approval action', () => {
    expect(layout).toContain('@+id/scouter_agent_row_1');
    expect(layout).toContain('@+id/scouter_agent_row_1_run');
    expect(layout).toContain('@+id/scouter_agent_row_2');
    expect(layout).toContain('@+id/scouter_agent_row_2_run');
    expect(layout).toContain('@+id/scouter_agent_row_3');
    expect(layout).toContain('@+id/scouter_agent_row_3_run');
    expect(service).toContain('recordWidgetAgentRunStarted');
    expect(service).toContain('recordWidgetAgentRunFinished');
    expect(stateStore).toContain('widgetAgentRunStatus');

    const rowBinding = provider.slice(
      provider.indexOf('private fun bindAgentRows'),
      provider.indexOf('private fun glyphForLastRun'),
    );
    expect(rowBinding).not.toContain('ALLOW');
    expect(rowBinding).not.toContain('DENY');
    expect(rowBinding).not.toContain('writeToSession');
    expect(rowBinding).not.toContain('ScouterWidgetPromptActivity');
  });

  it('removed the Codex/local-LLM session monitor UI and its dead view-id references', () => {
    const removedIds = [
      'scouter_codex_title',
      'scouter_codex_badge',
      'scouter_codex_detail',
      'scouter_codex_doing',
      'scouter_codex_conversation',
      'scouter_codex_metrics',
      'scouter_codex_usage',
      'scouter_codex_timer',
      'scouter_codex_allow',
      'scouter_codex_deny',
      'scouter_codex_choice3',
      'scouter_codex_choice4',
      'scouter_codex_choice5',
      'scouter_codex_choice6',
      'scouter_codex_choice_row_extra',
      'scouter_local_dot',
      'scouter_local_title',
      'scouter_local_badge',
      'scouter_local_detail',
      'scouter_local_metrics',
      'scouter_footer',
      'scouter_codex_pet_toggle',
      'scouter_codex_pet_touch',
    ];
    for (const id of removedIds) {
      expect(layout).not.toContain(`@+id/${id}`);
      // Kotlin R.id references are the ones that would actually crash a
      // RemoteViews bind; a bare-word substring check catches both forms.
      expect(provider).not.toContain(id);
    }
  });

  it('keeps the pet image visible-but-non-interactive (no click target) in the new header', () => {
    expect(layout).toContain('@+id/scouter_codex_pet');
    expect(provider).not.toContain('setOnClickPendingIntent(R.id.scouter_codex_pet');
    expect(provider).toContain('fun bindPet(views: RemoteViews, context: Context)');
  });
});
