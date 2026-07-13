import * as fs from 'fs';
import * as path from 'path';

// Offline security gate for the widget RUN path. Jest cannot execute Android
// PendingIntents, so these checks keep the service contract and its fail-closed
// guards coupled until the device acceptance pass can exercise them end to end.
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

  it('binds RUN directly to the foreground-service contract with a distinct PendingIntent identity', () => {
    expect(provider).toContain('AgentAlarmScheduler.manualRunPendingIntent(context, target.agentId)');
    expect(scheduler).toContain('action = TerminalSessionService.ACTION_RUN_AGENT');
    expect(scheduler).toContain('putExtra(TerminalSessionService.EXTRA_AGENT_ID, agentId)');
    expect(scheduler).toContain('putExtra(TerminalSessionService.EXTRA_MANUAL, true)');
    expect(scheduler).toContain('getAgentRequestCode(context, "widget-run:$agentId")');
    expect(scheduler).toContain('PendingIntent.getForegroundService(context, rc, intent, piFlags())');
  });

  it('revalidates a scheduled, enabled, materialized agent from disk at render and tap time', () => {
    expect(provider).toContain('WidgetAgentRepository.nextScheduled(context)');
    expect(service).toContain('WidgetAgentRepository.scheduledById(applicationContext, agentId)');
    expect(repository).toContain('HomeInitializer.getHomeDir(context.applicationContext)');
    expect(repository).toContain('if (id != expectedId || !SAFE_AGENT_ID.matches(id)) return null');
    expect(repository).toContain('if (!json.optBoolean("enabled", false)) return null');
    expect(repository).toContain('AgentAlarmScheduler.nextTriggerAt(cron) ?: return null');
    expect(repository).toContain('run-agent-$id.sh');
    expect(repository).toContain('plans/plan-agent-$id.json');
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

  it('adds a dedicated status/RUN row without adding a schedule approval action', () => {
    expect(layout).toContain('@+id/scouter_agent_status');
    expect(layout).toContain('@+id/scouter_agent_run');
    expect(service).toContain('recordWidgetAgentRunStarted');
    expect(service).toContain('recordWidgetAgentRunFinished');
    expect(stateStore).toContain('widgetAgentRunStatus');

    const runBinding = provider.slice(
      provider.indexOf('private fun bindWidgetAgentRun'),
      provider.indexOf('private fun widgetAgentLastRunLabel'),
    );
    expect(runBinding).not.toContain('ALLOW');
    expect(runBinding).not.toContain('DENY');
    expect(runBinding).not.toContain('writeToSession');
    expect(runBinding).not.toContain('ScouterWidgetPromptActivity');
  });
});
