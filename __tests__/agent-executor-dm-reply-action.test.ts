jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import type { Agent } from '@/store/types';

function agent(action: Agent['action']): Agent {
  return {
    id: 'dm-test', name: 'DM Test', description: '', prompt: 'hello', schedule: null,
    tool: { type: 'local' }, outputPath: '~/out', outputTemplate: null, enabled: true,
    lastRun: null, lastResult: null, createdAt: 0, version: 1, action,
  };
}

describe('legacy executor dm-reply action', () => {
  const script = generateRunScript(agent({ type: 'dm-reply', dmPairingId: 'pair-1', dmReplyText: 'Reply: {{result}}' }));

  it('re-reads the live pairing mirror and requests per-instance approval', () => {
    expect(script).toContain('DM_PAIRINGS_FILE=');
    expect(script).toContain('dm_pairing_lookup "$DM_PAIRINGS_FILE" "$ACTION_DM_PAIRING_ID"');
    expect(script).toContain('request_and_wait_approval "dm-reply" "$preview" "$result_file" || return 1');
  });

  it('rejects autonomous execution before requesting attended Review approval', () => {
    const dmCase = script.slice(script.indexOf('\n    dm-reply)'), script.indexOf('\n    *)', script.indexOf('\n    dm-reply)')));
    expect(dmCase).toContain('[ "${AGENT_AUTONOMOUS:-0}" = "1" ]');
    expect(dmCase).toContain('DM-reply actions require an attended Review.');
    expect(dmCase).toContain('request_and_wait_approval "dm-reply" "$preview" "$result_file" || return 1');
    expect(dmCase.indexOf('AGENT_AUTONOMOUS')).toBeLessThan(dmCase.indexOf('request_and_wait_approval'));
    // No broker/native dispatch call after approval — RN sends natively before
    // the accept reply is published.
    expect(dmCase).not.toContain('cap_workspace_exec');
    expect(dmCase).not.toContain('http_post_json');
  });

  it('fails closed for absent, revoked, and unverifiable pairings', () => {
    expect(script).toContain('DM-reply target is no longer paired.');
    expect(script).toContain('Could not verify the DM-reply pairing.');
    expect(script).toContain('typeof found.revoked !== \'boolean\'');
  });

  it('includes bound approval fields and never executes a post-approval side effect', () => {
    expect(script).toContain('"dmPairingId":"$dm_pairing_id_json"');
    expect(script).toContain('"dmPairingLabel":"$dm_pairing_label_json"');
    expect(script).toContain('"dmReplyText":"$dm_reply_text_json"');
    const dmCase = script.slice(script.indexOf('\n    dm-reply)'), script.indexOf('\n    *)', script.indexOf('\n    dm-reply)')));
    expect(dmCase).not.toContain('cap_workspace_exec');
    expect(dmCase).not.toContain('http_post_json');
  });

  it('emits parseable bash', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-reply-')), 'run.sh');
    fs.writeFileSync(file, script);
    expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
  });
});
