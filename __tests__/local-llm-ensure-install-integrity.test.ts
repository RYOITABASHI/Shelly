import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 2026-08-04: real on-device symptom (Codex investigation + Fable5 independent
// verification) — a run's local-LLM auto-start reason file reported
// "CANNOT LINK EXECUTABLE ... library libllama-server-impl.so not found" for
// an install that had, in an earlier run, been reported healthy. The old
// find_llama_server_bin() (scripts/shelly-local-llm-ensure.sh) only tested
// `[ -x "$candidate" ]` before trusting a candidate binary — true even for a
// truncated/interrupted archive extract that left the llama-server ELF
// present while its .so dependencies are missing or incomplete, which then
// hard-fails at ELF-load time 90s later (after ensure_local_llm_server
// already burned its whole ready_seconds wait). This file exercises the new
// local_llm_install_looks_complete() integrity check and find_llama_server_bin's
// use of it directly against the real script (no network — install_llama_server_bin's
// own download/extract path is out of scope here; this only covers the
// "is an ALREADY-INSTALLED binary trustworthy" gate).

const scriptPath = path.join(__dirname, '..', 'scripts', 'shelly-local-llm-ensure.sh');

// The real script only ever runs on Android (forward-slash paths). On a
// Windows dev machine, Node's path.join produces backslash-separated paths,
// which the script's `case "$x" in "$HOME"/.local/llama.cpp/*` glob (forward
// slashes) would never match — a test-harness artifact, not a bash-script
// bug. Normalize every path handed to bash to forward slashes.
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Runs a snippet of bash after sourcing the real script, with $HOME pointed
 *  at a fresh temp dir. Returns stdout trimmed. */
function runSourced(home: string, snippet: string): { stdout: string; status: number } {
  const script = `set -eu
HOME=${JSON.stringify(toPosix(home))}
AGENT_ID="test-agent"
TMP_DIR=$(mktemp -d)
LOCKS_DIR="$TMP_DIR/locks"
mkdir -p "$LOCKS_DIR"
source ${JSON.stringify(toPosix(scriptPath))}
${snippet}
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-llm-integrity-')), 'run.sh');
  fs.writeFileSync(file, script);
  try {
    const stdout = execFileSync('bash', [file]).toString();
    return { stdout: stdout.trim(), status: 0 };
  } catch (err: any) {
    return { stdout: String(err.stdout ?? ''), status: err.status ?? 1 };
  }
}

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-llm-integrity-home-'));
}

/** A minimal executable "ELF" stand-in — just needs the exec bit; the script
 *  never actually runs it in these tests, only checks existence/executable. */
function writeFakeBinary(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(p, 0o755);
}

describe('local_llm_install_looks_complete — app-managed install integrity gate', () => {
  it('rejects a binary outside $HOME/.local/llama.cpp check scope as trivially "complete" (not second-guessed)', () => {
    const home = makeHome();
    const bin = path.join(home, 'some', 'other', 'path', 'llama-server');
    writeFakeBinary(bin);
    const { stdout, status } = runSourced(home, `local_llm_install_looks_complete ${JSON.stringify(toPosix(bin))} && echo OK || echo FAIL`);
    expect(status).toBe(0);
    expect(stdout).toBe('OK');
  });

  it('rejects an app-managed binary with NO .so files anywhere under the install tree', () => {
    const home = makeHome();
    const bin = path.join(home, '.local', 'llama.cpp', 'bin', 'llama-server');
    writeFakeBinary(bin);
    const { stdout } = runSourced(home, `local_llm_install_looks_complete ${JSON.stringify(toPosix(bin))} && echo OK || echo FAIL`);
    expect(stdout).toBe('FAIL');
  });

  it('accepts an app-managed binary once at least one .so file exists under the install tree', () => {
    const home = makeHome();
    const bin = path.join(home, '.local', 'llama.cpp', 'bin', 'llama-server');
    writeFakeBinary(bin);
    fs.writeFileSync(path.join(home, '.local', 'llama.cpp', 'bin', 'libllama-server-impl.so'), 'stub');
    const { stdout } = runSourced(home, `local_llm_install_looks_complete ${JSON.stringify(toPosix(bin))} && echo OK || echo FAIL`);
    expect(stdout).toBe('OK');
  });

  it('rejects a non-executable candidate regardless of .so presence', () => {
    const home = makeHome();
    const bin = path.join(home, '.local', 'llama.cpp', 'bin', 'llama-server');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, 'not executable');
    fs.writeFileSync(path.join(home, '.local', 'llama.cpp', 'bin', 'libllama-server-impl.so'), 'stub');
    const { stdout } = runSourced(home, `local_llm_install_looks_complete ${JSON.stringify(toPosix(bin))} && echo OK || echo FAIL`);
    expect(stdout).toBe('FAIL');
  });
});

describe('find_llama_server_bin — refuses a stale/incomplete app-managed install (real on-device symptom)', () => {
  it('does NOT return the .realpath-pointed binary when its install tree has no .so files (the exact broken shape from the on-device log)', () => {
    const home = makeHome();
    const realBin = path.join(home, '.local', 'llama.cpp', 'bin', 'llama-server');
    writeFakeBinary(realBin);
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'llama-server.realpath'), toPosix(realBin));
    const { stdout, status } = runSourced(home, `find_llama_server_bin && echo "FOUND:$?" || echo "NOTFOUND:$?"`);
    expect(stdout).toMatch(/^NOTFOUND/);
  });

  it('DOES return the .realpath-pointed binary once the install tree has a real .so alongside it', () => {
    const home = makeHome();
    const realBin = path.join(home, '.local', 'llama.cpp', 'bin', 'llama-server');
    writeFakeBinary(realBin);
    fs.writeFileSync(path.join(home, '.local', 'llama.cpp', 'bin', 'libllama-server-impl.so'), 'stub');
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'llama-server.realpath'), toPosix(realBin));
    const { stdout } = runSourced(home, `find_llama_server_bin`);
    expect(stdout.trim()).toBe(toPosix(realBin));
  });
});
