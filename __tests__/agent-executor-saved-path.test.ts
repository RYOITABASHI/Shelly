jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent, AgentActionType } from '@/store/types';

function bashParses(script: string): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'saved-path-parse-')), 'run.sh');
  fs.writeFileSync(file, script);
  execFileSync('bash', ['-n', file]);
}

function agent(actionType: AgentActionType = 'draft', orchestrated = false): Agent {
  return {
    id: 'saved-path-test',
    name: 'Saved path test',
    description: '',
    prompt: 'Write a concise draft.',
    schedule: null,
    tool: { type: 'cli', cli: 'codex' },
    autonomous: true,
    action: { type: actionType },
    outputPath: '/home/shelly-test/output',
    outputTemplate: '{date}_{slug}.md',
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    orchestration: orchestrated ? { steps: ['collect facts', 'write the draft'] } : undefined,
  } as Agent;
}

describe('generateRunScript — saved destination and live chain progress', () => {
  it('captures successful primary/mirror draft writes and flows them into the run log and notification', () => {
    const script = generateRunScript(agent());
    const logBlock = script.slice(script.indexOf('# Log run result'), script.indexOf('# Prune old logs'));

    expect(script).toContain('SAVED_PATH=$(resolve_saved_path "$SAVED_FILE")');
    expect(script).toContain('SAVED_PATH_MIRROR=$(resolve_saved_path "$OBSIDIAN_DEST")');
    expect(script).toContain('write_native_notification_request "success" "保存: $SAVED_DISPLAY_PATH $preview"');
    expect(logBlock).toContain('"savedPath":"$SAVED_PATH_JSON"');
    expect(logBlock).toContain('"savedPathMirror":"$SAVED_PATH_MIRROR_JSON"');
    expect(logBlock).toContain('routeDecision":$ROUTE_DECISION_JSON$SAVED_PATH_FIELDS');
    bashParses(script);
  });

  it('leaves a non-draft run-log JSON write free of savedPath keys', () => {
    const script = generateRunScript(agent('notify'));
    const logBlock = script.slice(script.indexOf('# Log run result'), script.indexOf('# Prune old logs'));

    expect(logBlock).not.toContain('savedPath');
    expect(logBlock).toContain('SAVED_PATH_FIELDS=""');
    bashParses(script);
  });

  it('writes current.json immediately before each real same-script step dispatch and removes it in cleanup', () => {
    const script = generateRunScript(agent('draft', true));
    const marker = script.indexOf('mv "$CURRENT_STEP_TMP" "$LOG_DIR/current.json"');
    const dispatch = script.indexOf('shelly_timeout_app_binary "$TIMEOUT" node "$HOME/.shelly-agent-driver.js"', marker);

    expect(script).toContain('"phase":"dispatch"');
    expect(marker).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(marker);
    expect(script.slice(script.indexOf('cleanup() {'), script.indexOf('shelly_app_binary_path()')))
      .toContain('rm -f "$LOG_DIR/current.json"');
    bashParses(script);
  });
});
