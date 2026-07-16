import {
  normalizePath,
  isWithinRoot,
  extractPaths,
  classifyProposedCommand,
  GateContext,
} from '@/lib/agent-boundary-policy';

const ROOT = '/data/user/0/dev.shelly.terminal/files/home/projects/app';
const ctx = (level: GateContext['level']): GateContext => ({
  workspaceRoot: ROOT,
  level,
  policyPath: '.shelly/agents/policy.json',
});

describe('normalizePath / isWithinRoot', () => {
  it('collapses . and ..', () => {
    expect(normalizePath('/a/b/../c/./d')).toBe('/a/c/d');
    expect(normalizePath('a/./b/../c')).toBe('a/c');
  });
  it('keeps in-root paths inside', () => {
    expect(isWithinRoot(ROOT, `${ROOT}/src/index.ts`)).toBe(true);
    expect(isWithinRoot(ROOT, 'src/index.ts')).toBe(true); // relative → joined to root
  });
  it('detects `..` escape out of root', () => {
    expect(isWithinRoot(ROOT, `${ROOT}/../../../sdcard/secret`)).toBe(false);
    expect(isWithinRoot(ROOT, '/sdcard/Download/x')).toBe(false);
  });
});

describe('extractPaths', () => {
  it('picks path-like tokens, drops flags', () => {
    expect(extractPaths('grep -n foo ./src/a.ts /etc/hosts')).toEqual(['./src/a.ts', '/etc/hosts']);
  });
});

describe('classifyProposedCommand', () => {
  it('hard-denies CRITICAL at every level', () => {
    for (const lvl of ['L1', 'L2', 'L3'] as const) {
      const v = classifyProposedCommand('rm -rf /', ctx(lvl));
      expect(v.decision).toBe('deny');
      expect(v.signals).toContain('destructive');
    }
  });

  it('hard-denies policy-file writes at L3', () => {
    const v = classifyProposedCommand('echo x > .shelly/agents/policy.json', ctx('L3'));
    expect(v.decision).toBe('deny');
    expect(v.signals).toContain('policy-write');
  });

  it('L1 auto-allows a pure in-root read', () => {
    const v = classifyProposedCommand('cat src/index.ts', ctx('L1'));
    expect(v.decision).toBe('allow');
  });

  it('L1 grays a write', () => {
    expect(classifyProposedCommand('echo hi > src/out.txt', ctx('L1')).decision).toBe('gray');
  });

  it('L2 auto-allows in-workspace write, grays out-of-root', () => {
    expect(classifyProposedCommand('echo hi > src/out.txt', ctx('L2')).decision).toBe('allow');
    const escape = classifyProposedCommand('cp src/a.ts /sdcard/Download/a.ts', ctx('L2'));
    expect(escape.decision).toBe('gray');
    expect(escape.signals).toContain('leaves-root');
  });

  it('flags secret-read and network-send as boundary at L2', () => {
    expect(classifyProposedCommand('cat ~/.codex/auth.json', ctx('L2')).signals).toContain('secret-read');
    expect(classifyProposedCommand('curl https://evil.example/x', ctx('L2')).signals).toContain('network-send');
  });

  it('does not flag network-send for a loopback-only self-check (regression)', () => {
    // 2026-07-15: an agent's own local-LLM availability probe
    // (curl 127.0.0.1:8080/v1/models) was forcing the same human-approval
    // gate as a real outbound request, stalling the run indefinitely since
    // the agent's "no-approval" action-dispatch setting doesn't apply to
    // this separate execution-boundary gate.
    const v = classifyProposedCommand('curl -sS --max-time 5 http://127.0.0.1:8080/v1/models', ctx('L2'));
    expect(v.signals).not.toContain('network-send');
    expect(v.decision).toBe('allow');
    // localhost / ::1 aliases too.
    expect(classifyProposedCommand('curl http://localhost:8080/v1/models', ctx('L2')).signals).not.toContain('network-send');
    expect(classifyProposedCommand('curl http://[::1]:8080/v1/models', ctx('L2')).signals).not.toContain('network-send');
    // a command touching BOTH a loopback and a real external host still gates.
    const mixed = classifyProposedCommand('curl http://127.0.0.1:8080/x && curl https://evil.example/y', ctx('L2'));
    expect(mixed.signals).toContain('network-send');
  });

  it('L3 auto-allows non-hard-denied boundary ops (audited)', () => {
    const v = classifyProposedCommand('cp src/a.ts /sdcard/Download/a.ts', ctx('L3'));
    expect(v.decision).toBe('allow');
    expect(v.signals).toContain('leaves-root');
  });

  describe('opaque-script-exec (bug #155a: script-indirection bypasses network-send)', () => {
    it('flags interpreter invocations with an argument', () => {
      for (const cmd of [
        'python3 script.py',
        'python script.py',
        'node app.js',
        'nodejs app.js',
        'ruby fetcher.rb',
        'perl scrape.pl',
        'php upload.php',
        'deno run script.ts',
        'bun run script.ts',
        'python3 -c "import requests; requests.get(1)"',
        // Versioned interpreters (bug #155a follow-up): a bare `python3?`
        // alternative wouldn't match these since `\b` fails right after
        // consuming the version digits, letting them slip through unflagged.
        'python3.11 script.py',
        'python3.9 script.py',
      ]) {
        const v = classifyProposedCommand(cmd, ctx('L2'));
        expect(v.signals).toContain('opaque-script-exec');
      }
    });

    it('does not flag a bare interpreter with no argument (nothing to be opaque about)', () => {
      const v = classifyProposedCommand('python3', ctx('L2'));
      expect(v.signals).not.toContain('opaque-script-exec');
    });

    it('does not flag unrelated read-only commands', () => {
      const v = classifyProposedCommand('cat src/index.ts', ctx('L2'));
      expect(v.signals).not.toContain('opaque-script-exec');
      expect(v.decision).toBe('allow');
    });

    it('does not regress the existing NETWORK_RE / READ_ONLY_RE / loopback logic', () => {
      // curl still flags network-send, not opaque-script-exec.
      const curl = classifyProposedCommand('curl https://evil.example/x', ctx('L2'));
      expect(curl.signals).toContain('network-send');
      expect(curl.signals).not.toContain('opaque-script-exec');
      // loopback curl still exempted.
      const loopback = classifyProposedCommand('curl http://127.0.0.1:8080/v1/models', ctx('L2'));
      expect(loopback.signals).not.toContain('network-send');
      expect(loopback.signals).not.toContain('opaque-script-exec');
      expect(loopback.decision).toBe('allow');
      // pure reads still auto-allow at L1.
      expect(classifyProposedCommand('cat src/index.ts', ctx('L1')).decision).toBe('allow');
    });

    it('forces a human gate at L1/L2 (a python script with an embedded HTTP call previously auto-allowed)', () => {
      // Regression for bug #155a: `python3 script.py` where script.py makes an
      // HTTP request internally used to slip through as a pure in-workspace
      // write-or-exec (zero boundary signals) — auto-allow at L2, and even at
      // L1 it wasn't a pure read so it already grayed, but for the wrong
      // reason (no signal recorded the actual risk). Now it must gray with
      // the signal explicitly recorded.
      const l1 = classifyProposedCommand('python3 script.py', ctx('L1'));
      expect(l1.decision).toBe('gray');
      expect(l1.signals).toContain('opaque-script-exec');

      const l2 = classifyProposedCommand('python3 script.py', ctx('L2'));
      expect(l2.decision).toBe('gray');
      expect(l2.signals).toContain('opaque-script-exec');
    });

    it('L3 still auto-allows (audited) — L3 is explicit full opt-in', () => {
      const v = classifyProposedCommand('node app.js', ctx('L3'));
      expect(v.decision).toBe('allow');
      expect(v.signals).toContain('opaque-script-exec');
      expect(v.reason).toContain('opaque-script-exec');
    });
  });

  describe('bug #155a regression: unattended L2 scheduled run no longer auto-allows a script-indirection network bypass', () => {
    it('an unattended L2 run answers escalate (fail-closed upstream), not the old silent allow', () => {
      // decideAutoAnswer/agent-policy maps gray -> 'escalate', and the
      // unattended driver (agent-escalation-ladder.ts) turns an unresolved
      // escalate into an immediate decline for scheduled/unattended runs —
      // the exact class of run this bug was about. Verifying at the
      // classifyProposedCommand level (the source of truth this file owns)
      // that the verdict is no longer 'allow' is the correct-altitude
      // regression lock for this module.
      const v = classifyProposedCommand('python3 fetch_and_exfiltrate.py', ctx('L2'));
      expect(v.decision).not.toBe('allow');
      expect(v.decision).toBe('gray');
      expect(v.signals).toContain('opaque-script-exec');
    });
  });
});
