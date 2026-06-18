import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const driver = require('../scripts/shelly-agent-driver.js');

// Driver-side of grant-consumption hardening (review finding #2). The agent runs at the same uid
// and can rewrite the grants file, so the file `used`-count is NOT a security gate anymore. These
// tests assert: the human signature binds grantKeyMode + per-grant key; expiry-only is honored
// within scope regardless of the file used-count; replay-dangerous signals are NOT grantable as
// expiry-only; keystore-maxuse fails closed until the native round-trip exists; tampering the
// signed fields breaks verification.
describe('shelly-agent-driver grant consumption (driver side)', () => {
  const WS = '/ws';
  const COMMAND = 'echo hi > a.txt';
  let dir: string;
  let priv: crypto.KeyObject;
  let pub: crypto.KeyObject;
  let cmdSha: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-grant-'));
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    priv = pair.privateKey;
    pub = pair.publicKey;
    cmdSha = driver.commandSha256(COMMAND);
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const noopAudit = () => {};

  function signGrant(over: Record<string, unknown>) {
    const base: Record<string, unknown> = {
      type: 'grant',
      id: 'g1',
      agentId: 'host',
      workspaceRoot: WS,
      commandSha256: cmdSha,
      signals: ['leaves-root'],
      expiresAt: Date.now() + 10 * 60 * 1000,
      createdAt: Date.now(),
      requestSha256: 'r',
      requestTs: 't',
      usesRemaining: 1,
      grantKeyMode: 'expiry-only',
      grantKeySpki: '',
      ...over,
    };
    const msg = driver.preapprovalGrantSignatureMessage(base);
    const signature = crypto.sign('RSA-SHA256', Buffer.from(msg, 'utf8'), priv).toString('base64');
    return { ...base, by: 'human', sigAlg: 'SHA256withRSA', signature };
  }

  function makeConfig() {
    const grantsFile = path.join(dir, `grants-${Math.random().toString(36).slice(2)}.jsonl`);
    return {
      config: {
        agentId: 'host',
        policy: { workspaceRoot: WS },
        preapprovalGrantsFile: grantsFile,
        escalationPublicKey: path.join(dir, 'unused.der'),
        escalationVerifierLoaded: true, // bypass file load
        escalationVerifierPublicKey: pub,
      },
      grantsFile,
    };
  }

  function write(grantsFile: string, records: unknown[]) {
    fs.writeFileSync(grantsFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  function find(records: unknown[], requestSignals: string[]) {
    const { config, grantsFile } = makeConfig();
    write(grantsFile, records);
    const request = { signals: requestSignals, command: COMMAND, commandSha256: cmdSha, reqId: '1' };
    return driver.findPreapprovalGrant(config, request, noopAudit);
  }

  it('honors a valid expiry-only grant for a replay-safe signal', () => {
    const got = find([signGrant({})], ['leaves-root']);
    expect(got).toBeTruthy();
    expect(got.id).toBe('g1');
    expect(got.grantKeyMode).toBe('expiry-only');
  });

  it('honors expiry-only regardless of file `used`-count (file is no longer a gate)', () => {
    const grant = signGrant({ usesRemaining: 1 });
    const used = Array.from({ length: 5 }, (_, i) => ({ type: 'used', grantId: 'g1', reqId: String(i) }));
    const got = find([grant, ...used], ['leaves-root']);
    expect(got).toBeTruthy(); // would have been blocked by the old usedCounts>=usesRemaining gate
  });

  it('refuses expiry-only for a replay-dangerous leaves-root WRITE', () => {
    expect(find([signGrant({})], ['leaves-root', 'write-or-exec'])).toBeNull();
  });

  it('refuses expiry-only for network-send (exfiltration)', () => {
    expect(find([signGrant({ signals: ['network-send'] })], ['network-send'])).toBeNull();
  });

  it('fails closed for keystore-maxuse (native round-trip not yet implemented)', () => {
    const g = signGrant({ grantKeyMode: 'keystore-maxuse', grantKeySpki: 'AAAA' });
    expect(find([g], ['leaves-root'])).toBeNull();
  });

  it('rejects an unknown/missing grantKeyMode', () => {
    expect(find([signGrant({ grantKeyMode: 'bogus' })], ['leaves-root'])).toBeNull();
  });

  it('rejects a grant whose signed grantKeyMode was tampered (downgrade attempt)', () => {
    const g = signGrant({ grantKeyMode: 'keystore-maxuse', grantKeySpki: 'AAAA' });
    // Attacker flips the field to expiry-only after signing → signature no longer matches.
    const tampered = { ...g, grantKeyMode: 'expiry-only' };
    expect(find([tampered], ['leaves-root'])).toBeNull();
  });

  it('rejects an expired grant', () => {
    expect(find([signGrant({ expiresAt: Date.now() - 1000 })], ['leaves-root'])).toBeNull();
  });

  it('rejects on scope mismatch (agentId / workspaceRoot / commandSha256)', () => {
    expect(find([signGrant({ agentId: 'other' })], ['leaves-root'])).toBeNull();
    expect(find([signGrant({ workspaceRoot: '/elsewhere' })], ['leaves-root'])).toBeNull();
    expect(find([signGrant({ commandSha256: 'deadbeef' })], ['leaves-root'])).toBeNull();
  });

  it('isReplayDangerousSignals: network-send and leaves-root+write are dangerous; bare leaves-root is not', () => {
    expect(driver.isReplayDangerousSignals(['network-send'])).toBe(true);
    expect(driver.isReplayDangerousSignals(['leaves-root', 'write-or-exec'])).toBe(true);
    expect(driver.isReplayDangerousSignals(['leaves-root'])).toBe(false);
  });

  it('signature message binds grantKeyMode and the per-grant key identity', () => {
    const a = driver.preapprovalGrantSignatureMessage({ id: 'g', grantKeyMode: 'expiry-only', grantKeySpki: 'X' });
    const b = driver.preapprovalGrantSignatureMessage({ id: 'g', grantKeyMode: 'keystore-maxuse', grantKeySpki: 'X' });
    const c = driver.preapprovalGrantSignatureMessage({ id: 'g', grantKeyMode: 'expiry-only', grantKeySpki: 'Y' });
    expect(a).not.toBe(b); // mode bound
    expect(a).not.toBe(c); // key identity bound
  });
});
