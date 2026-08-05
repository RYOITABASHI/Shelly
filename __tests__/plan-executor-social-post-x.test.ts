import * as fs from 'fs';
import * as path from 'path';

// DEFERRED-tracked asymmetry: an orchestrated/scheduled X agent hard-failed
// with "Unsupported social platform: x" (scripts/shelly-plan-executor.js's
// buildSocialPostRequest had no 'x' case) while the same platform worked
// from the manual/.sh path (lib/agent-executor.ts's dispatch_social_post
// already has an x) case). This file locks the JS executor's new 'x' case.
//
// Mirrors this repo's own established convention for social-platform logic
// that talks to a real cloud host (api.x.com): __tests__/agent-executor-social-post.test.ts
// never opens a live HTTPS connection either — it asserts on generated
// source shape and exercises only the synchronous fail-closed paths.
// buildSocialPostRequest's success path performs a real network call
// (mirroring bluesky's inline createSession exchange) that this repo's own
// test suite has never exercised live for any real cloud host (every local/
// loopback network test here uses plain http://127.0.0.1, and every
// https://real-domain test either fails closed before dialing out or checks
// source text) — so the success path is covered here via source-shape
// assertions instead of a live HTTPS fixture server.

const root = path.resolve(__dirname, '..');
const executorSrc = fs.readFileSync(path.join(root, 'scripts', 'shelly-plan-executor.js'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildSocialPostRequest, xAccessTokenCache, updateEnvFileSecret } = require(path.join(
  root,
  'scripts',
  'shelly-plan-executor.js',
));

function makePaths() {
  const home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'shelly-plan-social-x-'));
  return {
    home,
    tmpDir: home,
    envFile: path.join(home, '.env'),
    brokerAuditFile: path.join(home, 'audit.jsonl'),
  };
}

const plan = {
  agent: { id: 'agent-social-x' },
  action: { type: 'social-post', socialPost: { platform: 'x', connectorId: 'x-test-connector' } },
};
const opts = { libDir: '', broker: path.join(root, 'scripts', 'shelly-capability-broker.js'), tainted: false };

describe('buildSocialPostRequest — x (Twitter) platform', () => {
  it('refuses immediately when the refresh token or client id secret is missing, without any network attempt', () => {
    let threw: any = null;
    try {
      buildSocialPostRequest(makePaths(), opts, plan, 'x', 'api.x.com', 'hello world', {}, false);
    } catch (e) {
      threw = e;
    }
    expect(threw).not.toBeNull();
    expect(threw.message).toContain('X connector is missing its refresh token or client id');
  });

  it('refuses article (long-form) posts for unattended runs with a clear, actionable message', () => {
    let threw: any = null;
    try {
      buildSocialPostRequest(
        makePaths(),
        opts,
        plan,
        'x',
        'api.x.com',
        'hello world',
        { REFRESHTOKEN: 'rt', CLIENTID: 'cid' },
        true,
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).not.toBeNull();
    expect(threw.message).toContain('article');
    expect(threw.message).toContain('not supported for unattended');
  });

  it('does not attempt any network call before validating credentials (fails synchronously, not via a timeout)', () => {
    const start = Date.now();
    expect(() => buildSocialPostRequest(makePaths(), opts, plan, 'x', 'api.x.com', 'hi', { REFRESHTOKEN: '', CLIENTID: '' }, false)).toThrow();
    // A real network attempt against a real host would take much longer than
    // this on any CI/dev machine; a synchronous validation failure is near-instant.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('reuses an already-refreshed access token for the same connector within one run, without re-checking credentials or hitting the network (2026-08-06 Codex review finding: multi-action fan-out posting to the same X connector twice would otherwise re-refresh and invalidate its own just-rotated token)', () => {
    xAccessTokenCache.set('x-test-connector', 'cached-access-token-from-a-prior-action-this-run');
    try {
      // Deliberately pass EMPTY secrets — if this reached the refresh branch
      // at all it would throw "missing its refresh token or client id"
      // immediately. Returning successfully proves the cache short-circuited
      // before that check.
      const result = buildSocialPostRequest(makePaths(), opts, plan, 'x', 'api.x.com', 'second post this run', {}, false);
      expect(result).toEqual({
        url: 'https://api.x.com/2/tweets',
        body: { text: 'second post this run' },
        headers: { Authorization: 'Bearer cached-access-token-from-a-prior-action-this-run' },
      });
    } finally {
      xAccessTokenCache.delete('x-test-connector');
    }
  });

  it('source shape: refreshes via /2/oauth2/token with a form-encoded grant_type=refresh_token body, then posts to /2/tweets with a Bearer header', () => {
    const xCase = executorSrc.slice(executorSrc.indexOf("if (platform === 'x')"), executorSrc.indexOf("throw new PlanFailure(`Unsupported social platform"));
    expect(xCase).toContain('/2/oauth2/token');
    expect(xCase).toContain('grant_type=refresh_token');
    expect(xCase).toContain('application/x-www-form-urlencoded');
    expect(xCase).toContain('/2/tweets');
    expect(xCase).toContain('Bearer ${accessToken}');
    // Rotated refresh token must be persisted BEFORE the tweet is attempted
    // (mirrors the .sh executor's own ordering rationale — see that file's
    // dispatch_social_post x) case comment).
    expect(xCase.indexOf('writePendingConnectorSecretUpdate')).toBeLessThan(
      xCase.indexOf("url: `https://${host}/2/tweets`"),
    );
    // 2026-08-06 Codex review finding: the rotated token must ALSO be written
    // synchronously to envFile (not only queued for RN's eventual drain) so
    // this executor's own NEXT scheduled invocation doesn't read the
    // now-invalid old refresh token and fail closed with invalid_grant.
    expect(xCase).toContain('updateEnvFileSecret(paths.envFile');
    expect(xCase).toContain('_REFRESHTOKEN');
  });

  it('the plan executor and its APK asset mirror are byte-identical (x social-post addition)', () => {
    const assetCopy = fs.readFileSync(
      path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-plan-executor.js'),
      'utf8',
    );
    expect(assetCopy).toBe(executorSrc);
  });
});

describe('updateEnvFileSecret — 2026-08-06 Codex review finding (X rotated refresh token must reach the NEXT executor invocation synchronously, not only via the RN/SecureStore drain)', () => {
  function makeEnvFile(content: string): string {
    const home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'shelly-plan-envsecret-'));
    const envFile = path.join(home, '.env');
    fs.writeFileSync(envFile, content);
    return envFile;
  }

  it('replaces an existing KEY=\'value\' line in place, leaving other lines untouched', () => {
    const envFile = makeEnvFile("LOCAL_LLM_URL='http://127.0.0.1:8080'\nSOCIAL_CONNECTOR_X_TEST_REFRESHTOKEN='old-token'\nOTHER_KEY='keep-me'\n");
    updateEnvFileSecret(envFile, 'SOCIAL_CONNECTOR_X_TEST_REFRESHTOKEN', 'new-rotated-token');
    const text = fs.readFileSync(envFile, 'utf8');
    expect(text).toContain("SOCIAL_CONNECTOR_X_TEST_REFRESHTOKEN='new-rotated-token'");
    expect(text).not.toContain('old-token');
    expect(text).toContain("LOCAL_LLM_URL='http://127.0.0.1:8080'");
    expect(text).toContain("OTHER_KEY='keep-me'");
  });

  it('appends a new line when the key does not already exist (defensive)', () => {
    const envFile = makeEnvFile("LOCAL_LLM_URL='http://127.0.0.1:8080'\n");
    updateEnvFileSecret(envFile, 'SOCIAL_CONNECTOR_X_NEW_REFRESHTOKEN', 'brand-new-token');
    const text = fs.readFileSync(envFile, 'utf8');
    expect(text).toContain("SOCIAL_CONNECTOR_X_NEW_REFRESHTOKEN='brand-new-token'");
  });

  it('escapes a literal single quote in the value so a read-modify-write round trip survives it', () => {
    const envFile = makeEnvFile("SOCIAL_CONNECTOR_X_TEST_REFRESHTOKEN='old'\n");
    updateEnvFileSecret(envFile, 'SOCIAL_CONNECTOR_X_TEST_REFRESHTOKEN', "it's got a quote");
    const text = fs.readFileSync(envFile, 'utf8');
    // Round-trip through the SAME unescape convention loadConnectorSecrets uses.
    const match = /SOCIAL_CONNECTOR_X_TEST_REFRESHTOKEN='(.*)'/.exec(text);
    expect(match).not.toBeNull();
    const roundTripped = (match as RegExpExecArray)[1].replace(/'\\''/g, "'");
    expect(roundTripped).toBe("it's got a quote");
  });

  // Windows NTFS ACLs don't map to POSIX mode bits — chmod is a near-no-op
  // there (see checkSecretFilePermissions' own doc comment for the same
  // caveat); this is enforced for real on Linux CI / the Android device.
  (process.platform === 'win32' ? it.skip : it)('sets file mode to 0600 after writing (secret file permission requirement)', () => {
    const envFile = makeEnvFile("SOCIAL_CONNECTOR_X_TEST_REFRESHTOKEN='old'\n");
    updateEnvFileSecret(envFile, 'SOCIAL_CONNECTOR_X_TEST_REFRESHTOKEN', 'new');
    const mode = fs.statSync(envFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('is a silent no-op when the env file does not exist (best-effort, never throws)', () => {
    const missing = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'shelly-plan-envsecret-missing-')), '.env');
    expect(() => updateEnvFileSecret(missing, 'SOME_KEY', 'value')).not.toThrow();
  });
});
