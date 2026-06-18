import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Behavioral guard for the escalation verifier-key PIN (security review finding #1).
// Threat: a same-uid agent can overwrite the verifier public-key DER and sign forged
// "accept" replies with its own key. The driver pins the DER's SHA-256 (injected by the
// native launcher via --escalation-public-key-sha256, which the agent cannot alter) and
// loads/caches it BEFORE spawning codex. A mismatching key MUST be rejected so every
// escalation/grant fails closed. These tests assert the audit signal for each case.
//
// We don't need a real codex: ensureEscalationVerifierKey runs at runDriver start, before
// the codex spawn, so the verifier-key audit events are emitted even though the codex bin
// is bogus and the run aborts immediately afterward.
describe('shelly-agent-driver escalation verifier-key pin', () => {
  const root = path.resolve(__dirname, '..');
  const driver = path.join(root, 'scripts', 'shelly-agent-driver.js');
  let dir: string;
  let keyPath: string;
  let realSha: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-pin-'));
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    keyPath = path.join(dir, 'pub.der');
    fs.writeFileSync(keyPath, der);
    realSha = crypto.createHash('sha256').update(der).digest('hex');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  type AuditObj = { kind?: string; escalationKeyPinned?: boolean; escalationKeyTrusted?: boolean };

  function runDriver(pin: string | null): { events: string[]; driverStart: AuditObj } {
    const auditLog = path.join(dir, `audit-${pin ?? 'none'}-${Math.random().toString(36).slice(2)}.jsonl`);
    const args = [
      driver,
      '--cwd', dir,
      '--prompt', 'x',
      '--codex-bin', 'shelly-nonexistent-codex-bin',
      '--escalation-public-key', keyPath,
      '--audit-log', auditLog,
      '--timeout-ms', '4000',
    ];
    if (pin) args.push('--escalation-public-key-sha256', pin);
    try {
      execFileSync(process.execPath, args, { timeout: 20000, stdio: 'ignore' });
    } catch {
      // The bogus codex bin makes the run abort; we only care about the early audit.
    }
    const lines = fs.existsSync(auditLog)
      ? fs.readFileSync(auditLog, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    const objs: AuditObj[] = lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return {};
      }
    });
    return {
      events: objs.map((o) => o.kind || '').filter((k) => k.startsWith('escalation_verifier_key')),
      driverStart: objs.find((o) => o.kind === 'driver_start') || {},
    };
  }

  it('accepts a key matching the pin (trusted, no warning)', () => {
    const { events, driverStart } = runDriver(realSha);
    expect(events).toHaveLength(0);
    expect(driverStart.escalationKeyPinned).toBe(true);
    expect(driverStart.escalationKeyTrusted).toBe(true);
  });

  it('rejects a key that does not match the pin → untrusted, fails closed', () => {
    const { events, driverStart } = runDriver('f'.repeat(64));
    expect(events).toContain('escalation_verifier_key_untrusted');
    expect(driverStart.escalationKeyPinned).toBe(true);
    expect(driverStart.escalationKeyTrusted).toBe(false);
  });

  it('audits an unpinned key as dev-only (loads, but flagged)', () => {
    const { events, driverStart } = runDriver(null);
    expect(events).toContain('escalation_verifier_key_unpinned');
    expect(driverStart.escalationKeyPinned).toBe(false);
    expect(driverStart.escalationKeyTrusted).toBe(true);
  });

  it('rejects a malformed pin at arg-parse time', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [driver, '--cwd', dir, '--prompt', 'x', '--escalation-public-key-sha256', 'not-hex'],
        { timeout: 20000, stdio: 'pipe' },
      ),
    ).toThrow();
  });
});
