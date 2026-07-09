jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent, ToolChoice } from '@/store/types';

/** bash -n the script via a temp FILE (a full script exceeds the Windows argv limit for `-c`). */
function bashParses(script: string): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'intent-parse-')), 'run.sh');
  fs.writeFileSync(file, script);
  execFileSync('bash', ['-n', file]);
}

const agent = (action: Agent['action']): Agent => ({
  id: 't',
  name: 'T',
  description: '',
  prompt: 'hi',
  schedule: null,
  tool: { type: 'local' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  action,
});

// Track C: legacy .sh executor support for the 'intent' agent action. The
// actual side effect (context.startActivity()) happens natively in RN
// (fireAgentIntent) at the moment the human taps Allow — BEFORE the accept
// reply is written. This case only requests approval, waits, and reports;
// it must never call a broker/native function after approval.
describe('generateRunScript — intent action (launch)', () => {
  const s = generateRunScript(agent({ type: 'intent', intentMode: 'launch', intentTarget: 'geo:35.0,139.0' }));

  it('threads ACTION_TYPE and the intent variables through, correctly quoted', () => {
    expect(s).toContain("ACTION_TYPE='intent'");
    expect(s).toContain("ACTION_INTENT_MODE='launch'");
    expect(s).toContain("ACTION_INTENT_TARGET='geo:35.0,139.0'");
    expect(s).toContain("ACTION_INTENT_SHARE_TEXT=''");
  });

  it('requests approval unconditionally — no AGENT_AUTONOMOUS bypass (mirrors webhook/cli)', () => {
    const intentCase = s.slice(s.indexOf('\n    intent)'), s.indexOf('\n    *)', s.indexOf('\n    intent)')));
    expect(intentCase).toContain('write_action_approval_request "intent" "$preview" "$result_file"');
    expect(intentCase).toContain('wait_action_approval "intent" || return 1');
    expect(intentCase).not.toContain('AGENT_AUTONOMOUS');
    // No broker/native dispatch call after approval — the side effect already
    // happened natively before the accept reply was written.
    expect(intentCase).not.toContain('cap_workspace_exec');
    expect(intentCase).not.toContain('http_post_json');
  });

  it('validates mode and launch target before requesting approval', () => {
    expect(s).toContain('Intent action has an invalid mode.');
    expect(s).toContain('Intent action is missing a launch target.');
  });

  it('emits parseable shell', () => {
    expect(() => bashParses(s)).not.toThrow();
  });
});

describe('generateRunScript — intent action (share, {{result}} substitution)', () => {
  it('resolves the {{result}} placeholder against the run preview at request-write time', () => {
    const s = generateRunScript(agent({ type: 'intent', intentMode: 'share', intentShareText: 'Check this out: {{result}}' }));
    expect(s).toContain("ACTION_INTENT_SHARE_TEXT='Check this out: {{result}}'");
    expect(s).toContain('intent_share_text_resolved="${ACTION_INTENT_SHARE_TEXT//\\{\\{result\\}\\}/$preview}"');
    expect(s).toContain('intent_share_text_json=$(json_escape_text "$intent_share_text_resolved")');
    expect(s).toContain('"intentMode":"$intent_mode_json","intentTarget":"$intent_target_json","intentShareText":"$intent_share_text_json"');
  });

  it('share mode does not require intentTarget', () => {
    const s = generateRunScript(agent({ type: 'intent', intentMode: 'share', intentShareText: 'hello' }));
    expect(() => bashParses(s)).not.toThrow();
  });
});
