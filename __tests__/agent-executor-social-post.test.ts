jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { isSocialConnectorHostAllowed } from '@/lib/capability-envelope';
import {
  SOCIAL_PLATFORM_FIELDS,
  isSafeConnectorId,
  socialConnectorEnvPrefix,
  socialConnectorEnvVar,
} from '@/lib/social-connectors';
import { Agent, SocialPlatform } from '@/store/types';

/** bash -n the script via a temp FILE (a full script exceeds the Windows argv limit for `-c`). */
function bashParses(script: string): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'social-post-parse-')), 'run.sh');
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

const socialAgent = (platform: SocialPlatform, connectorId = 'my-conn', text?: string): Agent =>
  agent({ type: 'social-post', socialPost: { platform, connectorId, text } });

describe('generateRunScript — social-post action', () => {
  const s = generateRunScript(socialAgent('mastodon'));

  it('bumped the script version (originally to 23 for the new action case + helpers; now >= 23)', () => {
    expect(s).toContain('SHELLY_AGENT_SCRIPT_VERSION=29');
  });

  it('bakes ACTION_TYPE and the social-post variables, with the env-prefix derived from the connector id', () => {
    expect(s).toContain("ACTION_TYPE='social-post'");
    expect(s).toContain("ACTION_SOCIAL_PLATFORM='mastodon'");
    expect(s).toContain("ACTION_SOCIAL_CONNECTOR_ID='my-conn'");
    expect(s).toContain("ACTION_SOCIAL_ENV_PREFIX='SOCIAL_CONNECTOR_MY_CONN'");
    // Absent text defaults to posting the run result itself.
    expect(s).toContain("ACTION_SOCIAL_TEXT='{{result}}'");
  });

  it('bakes a custom text template verbatim (plain {{result}} string-replace, no template engine)', () => {
    const custom = generateRunScript(socialAgent('mastodon', 'my-conn', 'New post: {{result}} #shelly'));
    expect(custom).toContain("ACTION_SOCIAL_TEXT='New post: {{result}} #shelly'");
  });

  it('fails closed at generation time on an unsafe connector id (bakes empty id/prefix)', () => {
    const bad = generateRunScript(socialAgent('mastodon', 'evil;id$(x)'));
    expect(bad).toContain("ACTION_SOCIAL_CONNECTOR_ID=''");
    expect(bad).toContain("ACTION_SOCIAL_ENV_PREFIX=''");
    expect(bad).toContain('Social-post action is missing its platform or connector.');
  });

  it('resolves secrets ONLY via env-var indirection — never a literal assignment in the script', () => {
    // The dispatcher reads ${SOCIAL_CONNECTOR_<ID>_<FIELD>} through bash
    // indirect expansion on the baked prefix…
    expect(s).toContain('social_connector_env() {');
    expect(s).toContain('_sce_name="${ACTION_SOCIAL_ENV_PREFIX}_$1"');
    expect(s).toContain('"${!_sce_name:-}"');
    // …and the script never contains an assignment that would bake a secret
    // value (only the sourced $ENV_FILE provides these at runtime).
    expect(s).not.toMatch(/SOCIAL_CONNECTOR_MY_CONN_[A-Z]+=/);
  });

  it('a fake connector secret value never appears in the generated script static text', () => {
    // generateRunScript has no secret inputs by design; this canary guards the
    // invariant against future refactors that might thread secrets through.
    const canary = 'sk-FAKE-social-canary-123456789';
    expect(s).not.toContain(canary);
    const withText = generateRunScript(socialAgent('discord', 'my-conn', 'safe text {{result}}'));
    expect(withText).not.toContain(canary);
  });

  it('non-allowlisted destination host forces write+wait approval regardless of ACTION_APPROVAL_MODE', () => {
    const socialCase = s.slice(s.indexOf('\n    social-post)'), s.indexOf('\n    *)', s.indexOf('\n    social-post)')));
    expect(socialCase).toContain('social_host_is_allowlisted "$social_host"');
    // Allowlisted branch: the ordinary wrapper (skips the round trip when mode=auto).
    expect(socialCase).toContain('request_and_wait_approval "social-post" "$preview" "$result_file" "$social_host" "$social_payload" "$social_host_allowlisted" || return 1');
    // Non-allowlisted branch: mandatory write+wait, bypassing the auto-skip.
    expect(socialCase).toContain('write_action_approval_request "social-post"');
    expect(socialCase).toContain('wait_action_approval "social-post" || return 1');
    // Quality gate runs before any approval/dispatch. Match the actual call
    // sites (quoted args), not bare identifiers — the branch's own comment
    // block mentions "request_and_wait_approval" in prose earlier in the
    // case, which would otherwise make indexOf find the comment instead of
    // the real call and produce a false failure.
    expect(socialCase.indexOf('is_low_quality_completion "$preview"')).toBeLessThan(
      socialCase.indexOf('request_and_wait_approval "social-post"')
    );
    // Dispatch happens strictly after approval. Same comment-pollution caveat
    // as above — an earlier comment mentions "dispatch_social_post" in prose
    // ("composed post-approval inside dispatch_social_post."), so match the
    // real call site (quoted args) rather than the bare identifier.
    expect(socialCase.indexOf('wait_action_approval "social-post" || return 1')).toBeLessThan(
      socialCase.indexOf('dispatch_social_post "$social_host"')
    );
  });

  it('substitutes {{result}} with ESCAPED braces in the emitted bash pattern (unescaped braces terminate the ${var//…} expansion early and corrupt the posted text)', () => {
    // Emitted bash must be: ${ACTION_SOCIAL_TEXT//\{\{result\}\}/$preview}
    // (matching the intent-share line's escaping, NOT dm-reply's broken one).
    expect(s).toContain('social_text_resolved="${ACTION_SOCIAL_TEXT//\\{\\{result\\}\\}/$preview}"');
    expect(s).not.toContain('social_text_resolved="${ACTION_SOCIAL_TEXT//{{result}}/$preview}"');
  });

  it('reads the social opt-in list from SHELLY_SOCIAL_HOST_ALLOWLIST (webhook-allowlist twin)', () => {
    expect(s).toContain('social_host_is_allowlisted() {');
    expect(s).toContain('${SHELLY_SOCIAL_HOST_ALLOWLIST:-}');
  });

  it('emits parseable shell for a social-post agent', () => {
    expect(() => bashParses(s)).not.toThrow();
  });

  it('emits parseable shell + empty social bake for a plain draft agent', () => {
    const draft = generateRunScript(agent({ type: 'draft' }));
    expect(draft).toContain("ACTION_SOCIAL_PLATFORM=''");
    expect(draft).toContain("ACTION_SOCIAL_TEXT=''");
    expect(() => bashParses(draft)).not.toThrow();
  });
});

describe('generateRunScript — per-platform request composition (dispatch_social_post)', () => {
  const s = generateRunScript(socialAgent('mastodon'));

  it('discord: POSTs the webhook URL secret with a {"content":…} body', () => {
    expect(s).toContain('social_connector_env WEBHOOKURL');
    expect(s).toContain('printf \'{"content":"%s"}\' "$sp_text_json" > "$sp_body"');
  });

  it('slack: POSTs the webhook URL secret with a {"text":…} body', () => {
    expect(s).toContain('printf \'{"text":"%s"}\' "$sp_text_json" > "$sp_body"');
  });

  it('telegram: POSTs to api.telegram.org/bot<token>/sendMessage with chat_id+text', () => {
    expect(s).toContain('social_connector_env BOTTOKEN');
    expect(s).toContain('social_connector_env CHATID');
    expect(s).toContain('sp_url="https://api.telegram.org/bot$sp_token/sendMessage"');
    expect(s).toContain('printf \'{"chat_id":"%s","text":"%s"}\' "$sp_chat_json" "$sp_text_json" > "$sp_body"');
  });

  it('mastodon: POSTs /api/v1/statuses with a Bearer access token and {"status":…}', () => {
    expect(s).toContain('social_connector_env ACCESSTOKEN');
    expect(s).toContain('sp_url="https://$sp_host/api/v1/statuses"');
    expect(s).toContain('sp_auth_header="Bearer $sp_token"');
    expect(s).toContain('printf \'{"status":"%s"}\' "$sp_text_json" > "$sp_body"');
  });

  it('misskey: POSTs /api/notes/create with the token in the BODY ("i"), not a header', () => {
    expect(s).toContain('social_connector_env APITOKEN');
    expect(s).toContain('sp_url="https://$sp_host/api/notes/create"');
    expect(s).toContain('printf \'{"i":"%s","text":"%s"}\' "$sp_token_json" "$sp_text_json" > "$sp_body"');
  });

  it('wordpress: POSTs /wp-json/wp/v2/posts with Basic auth and title/content/status', () => {
    expect(s).toContain('social_connector_env USERNAME');
    expect(s).toContain('social_connector_env APPPASSWORD');
    expect(s).toContain('sp_url="https://$sp_host/wp-json/wp/v2/posts"');
    expect(s).toContain('sp_auth_header="Basic $sp_basic"');
    expect(s).toContain('printf \'{"title":"%s","content":"%s","status":"publish"}\'');
  });

  it('bluesky: two sequential calls — createSession strictly BEFORE createRecord, extracting accessJwt/did', () => {
    const sessionIdx = s.indexOf('com.atproto.server.createSession');
    const recordIdx = s.indexOf('com.atproto.repo.createRecord');
    expect(sessionIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeGreaterThan(-1);
    expect(sessionIdx).toBeLessThan(recordIdx);
    const between = s.slice(sessionIdx, recordIdx);
    expect(between).toContain('json_field_file "$sp_session_out" "accessJwt"');
    expect(between).toContain('json_field_file "$sp_session_out" "did"');
    // Fails closed with a clear error when either field is missing.
    expect(between).toContain('Bluesky session exchange failed');
    expect(s).toContain('"collection":"app.bsky.feed.post"');
  });

  it('binds the outbound URL to the connector-declared host (host-mismatch fail-closed)', () => {
    expect(s).toContain('social_require_url_host() {');
    expect(s).toContain('if ! social_require_url_host "$sp_url" "$sp_host"; then');
    expect(s).toContain("Social-post destination host does not match the connector's registered host");
  });

  it('redacts response/error text before it can reach a message (redact_secrets_text)', () => {
    const dispatchFn = s.slice(s.indexOf('dispatch_social_post() {'), s.indexOf('\ndispatch_agent_action()'));
    expect(dispatchFn).toContain('redact_secrets_text "$sp_error"');
  });
});

describe('buildAgentPlanSpec — social-post action plumbing', () => {
  it('carries platform/connectorId/text into the PlanSpec action (no host, no secrets)', () => {
    const spec = buildAgentPlanSpec(socialAgent('bluesky', 'my-bsky', 'hi {{result}}'));
    expect(spec.action.type).toBe('social-post');
    expect(spec.action.socialPost).toEqual({ platform: 'bluesky', connectorId: 'my-bsky', text: 'hi {{result}}' });
  });
});

describe('lib/social-connectors + capability-envelope social primitives', () => {
  it('env prefix/var naming is deterministic and shell-safe', () => {
    expect(socialConnectorEnvPrefix('my-mastodon')).toBe('SOCIAL_CONNECTOR_MY_MASTODON');
    expect(socialConnectorEnvVar('my-mastodon', 'accessToken')).toBe('SOCIAL_CONNECTOR_MY_MASTODON_ACCESSTOKEN');
    expect(() => socialConnectorEnvPrefix('bad id!')).toThrow();
    expect(() => socialConnectorEnvVar('ok-id', 'bad field')).toThrow();
  });

  it('connector ids follow the agent-id rigor (alphanumeric+hyphen only)', () => {
    expect(isSafeConnectorId('my-conn-2')).toBe(true);
    expect(isSafeConnectorId('my_conn')).toBe(false);
    expect(isSafeConnectorId('a;b')).toBe(false);
    expect(isSafeConnectorId('')).toBe(false);
  });

  it('no secret field name ends in HOST or META (the config-admission invariant)', () => {
    for (const fields of Object.values(SOCIAL_PLATFORM_FIELDS)) {
      for (const field of fields) {
        expect(field.toUpperCase().endsWith('HOST')).toBe(false);
        expect(field.toUpperCase().endsWith('META')).toBe(false);
      }
    }
  });

  it('isSocialConnectorHostAllowed: a connector host is definitionally its only allowed target', () => {
    const connector = { host: 'mastodon.social' };
    expect(isSocialConnectorHostAllowed(connector, 'mastodon.social')).toBe(true);
    expect(isSocialConnectorHostAllowed(connector, 'MASTODON.SOCIAL')).toBe(true);
    expect(isSocialConnectorHostAllowed(connector, 'evil.example')).toBe(false);
    expect(isSocialConnectorHostAllowed(connector, '')).toBe(false);
    expect(isSocialConnectorHostAllowed({ host: '' }, 'mastodon.social')).toBe(false);
  });
});

describe('PlanSpec executor + AgentRuntime.kt routing for social-post', () => {
  const root = path.resolve(__dirname, '..');
  const executorSrc = fs.readFileSync(path.join(root, 'scripts', 'shelly-plan-executor.js'), 'utf8');

  it('the plan executor and its APK asset mirror are byte-identical', () => {
    const assetSrc = fs.readFileSync(
      path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-plan-executor.js'),
      'utf8',
    );
    expect(assetSrc).toBe(executorSrc);
  });

  it('the capability broker and its APK asset mirror are byte-identical (--header-file addition)', () => {
    const brokerSrc = fs.readFileSync(path.join(root, 'scripts', 'shelly-capability-broker.js'), 'utf8');
    const brokerAsset = fs.readFileSync(
      path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-capability-broker.js'),
      'utf8',
    );
    expect(brokerAsset).toBe(brokerSrc);
    expect(brokerSrc).toContain("args['header-file']");
  });

  it('the plan executor dispatches social-post through the broker http primitive with per-platform shapes', () => {
    expect(executorSrc).toContain("actionType === 'social-post'");
    expect(executorSrc).toContain('function buildSocialPostRequest(');
    expect(executorSrc).toContain('com.atproto.server.createSession');
    expect(executorSrc).toContain('com.atproto.repo.createRecord');
    expect(executorSrc).toContain('SHELLY_SOCIAL_HOST_ALLOWLIST');
    // Only non-secret HOST/META connector keys are admitted into config.
    expect(executorSrc).toContain('function isSocialConnectorConfigKey(');
    expect(executorSrc).toContain('_(HOST|META)$');
  });

  it('AgentRuntime.kt routes social-post through the PlanSpec executor and bumped CURRENT_SCRIPT_VERSION in lockstep', () => {
    const kt = fs.readFileSync(
      path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentRuntime.kt'),
      'utf8',
    );
    expect(kt).toContain('"social-post"');
    expect(kt).toContain('CURRENT_SCRIPT_VERSION = 29');
  });
});
