import * as fs from 'fs';
import * as path from 'path';
import {
  isWebhookHostAllowlisted,
  normalizeWebhookHost,
  normalizeWebhookHostAllowlist,
} from '@/lib/webhook-host-allowlist';

describe('webhook host allowlist', () => {
  it('normalizes exact hostnames and rejects URL-shaped or wildcard entries', () => {
    expect(normalizeWebhookHost(' Hooks.Example.COM. ')).toBe('hooks.example.com');
    expect(normalizeWebhookHost('https://hooks.example.com/path')).toBeNull();
    expect(normalizeWebhookHost('*.example.com')).toBeNull();
    expect(normalizeWebhookHost('hooks.example.com:443')).toBeNull();
    expect(normalizeWebhookHostAllowlist(['B.example', 'b.example', 'a.example'])).toEqual(['a.example', 'b.example']);
    expect(isWebhookHostAllowlisted('B.EXAMPLE', ['b.example'])).toBe(true);
    expect(isWebhookHostAllowlisted('sub.b.example', ['b.example'])).toBe(false);
  });

  it('keeps approval unconditional and surfaces known/new status in Review and notification copy', () => {
    const root = path.resolve(__dirname, '..');
    const legacy = fs.readFileSync(path.join(root, 'lib/agent-executor.ts'), 'utf8');
    const plan = fs.readFileSync(path.join(root, 'scripts/shelly-plan-executor.js'), 'utf8');
    const review = fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8');
    const notification = fs.readFileSync(
      path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/scouter/NotificationDispatcher.kt'),
      'utf8',
    );

    expect(legacy).toContain('webhook_host_allowlisted=false');
    expect(legacy).toContain('if webhook_host_is_allowlisted "$webhook_host"; then webhook_host_allowlisted=true; fi');
    expect(legacy).toContain('request_and_wait_approval "webhook" "$preview" "$result_file" "$webhook_host" "$webhook_payload" "$webhook_host_allowlisted" || return 1');
    expect(plan).toContain('requestActionApproval(paths, plan, actionType');
    expect(plan).toContain('destinationHostAllowlisted: webhookHostIsAllowlisted(host, config)');
    expect(review).toContain("'agent_action_confirm_webhook_known_host'");
    expect(review).toContain("'agent_action_confirm_webhook_new_host'");
    expect(notification).toContain('request.destinationHostAllowlisted');
    expect(notification).toContain('scouter_notification_agent_action_webhook_known_host');
    expect(notification).toContain('scouter_notification_agent_action_webhook_new_host');
  });
});
