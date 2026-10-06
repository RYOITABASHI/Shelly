import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { generateRunScript } from '@/lib/agent-executor';
import { buildSetupSteps, LLAMA_CPP_PINNED_RELEASE } from '@/lib/llamacpp-setup';
import { Agent, ToolChoice } from '@/store/types';

// 2026-10-06: ggml-org/llama.cpp's releases/latest moved to a binary-less
// "v0.6.0" tag (b<N> builds became prereleases), which broke every fresh
// llama.cpp install / Repair. All three install paths now use the same pinned,
// sha256-verified asset. This suite keeps the three copies in lockstep and
// exercises the bash path's fail-closed behaviour without touching the network.

const root = path.resolve(__dirname, '..');
const ensurePath = path.join(root, 'scripts', 'shelly-local-llm-ensure.sh');
const ensureSrc = fs.readFileSync(ensurePath, 'utf8');
const pinnedUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_PINNED_RELEASE.tag}/${LLAMA_CPP_PINNED_RELEASE.asset}`;

const fixedAgent: Agent = {
  id: 'pin-agent',
  name: 'Pin Agent',
  description: 'fixture',
  prompt: 'Say hello.',
  schedule: null,
  tool: { type: 'local' } as ToolChoice,
  outputPath: '~/out/pin.md',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  action: { type: 'draft' },
};

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function runSourced(snippet: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-pin-home-'));
  const script = `set -u
HOME=${JSON.stringify(toPosix(home))}
AGENT_ID="pin"
TMP_DIR=$(mktemp -d)
LOCKS_DIR="$TMP_DIR/locks"
mkdir -p "$LOCKS_DIR"
source ${JSON.stringify(toPosix(ensurePath))}
${snippet}
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llama-pin-')), 'run.sh');
  fs.writeFileSync(file, script);
  try {
    return execFileSync('bash', [file]).toString();
  } catch (err: any) {
    return String(err.stdout ?? '') + String(err.stderr ?? '');
  }
}

describe('pinned llama.cpp release stays in lockstep across all install paths', () => {
  it('pins an exact plain android-arm64 asset with a sha256', () => {
    expect(LLAMA_CPP_PINNED_RELEASE.asset).toBe(
      `llama-${LLAMA_CPP_PINNED_RELEASE.tag}-bin-android-arm64.tar.gz`,
    );
    expect(LLAMA_CPP_PINNED_RELEASE.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('scripts/shelly-local-llm-ensure.sh carries the same tag/asset/sha256', () => {
    expect(ensureSrc).toContain(`llama_cpp_pinned_tag() { printf '%s\\n' '${LLAMA_CPP_PINNED_RELEASE.tag}'; }`);
    expect(ensureSrc).toContain(`'${LLAMA_CPP_PINNED_RELEASE.asset}'`);
    expect(ensureSrc).toContain(`'${LLAMA_CPP_PINNED_RELEASE.sha256}'`);
    expect(ensureSrc).not.toContain('api.github.com/repos/ggml-org/llama.cpp/releases/latest');
  });

  it('lib/agent-executor.ts generated script carries the same tag/asset/sha256', () => {
    const s = generateRunScript(fixedAgent);
    expect(s).toContain(`'${LLAMA_CPP_PINNED_RELEASE.tag}'`);
    expect(s).toContain(`'${LLAMA_CPP_PINNED_RELEASE.asset}'`);
    expect(s).toContain(`'${LLAMA_CPP_PINNED_RELEASE.sha256}'`);
    expect(s).not.toContain('api.github.com/repos/ggml-org/llama.cpp/releases/latest');
    expect(s).toContain('sha256 mismatch');
  });

  it('the in-app Setup install command uses the pinned URL + sha256 and is valid bash', () => {
    const step = buildSetupSteps().find((st) => st.id === 'install_llamacpp');
    expect(step).toBeDefined();
    const cmd = step!.command;
    expect(cmd).toContain(`PINNED_TAG="${LLAMA_CPP_PINNED_RELEASE.tag}"`);
    expect(cmd).toContain(`PINNED_SHA256="${LLAMA_CPP_PINNED_RELEASE.sha256}"`);
    expect(cmd).not.toContain('api.github.com/repos/ggml-org/llama.cpp/releases/latest');
    expect(cmd).toContain('refusing to install');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llama-pin-cmd-')), 'cmd.sh');
    fs.writeFileSync(file, cmd);
    expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
  });
});

describe('ensure.sh pinned install behaviour (no network)', () => {
  it('resolves the pinned URL and records its sha256', () => {
    const out = runSourced(`
url=$(resolve_llama_server_download_url)
echo "URL=$url"
echo "SHA=$(cat "$TMP_DIR/llama-server-sha256-pin.txt")"
`);
    expect(out).toContain(`URL=${pinnedUrl}`);
    expect(out).toContain(`SHA=${LLAMA_CPP_PINNED_RELEASE.sha256}`);
  });

  it('refuses an override URL without a valid sha256', () => {
    const out = runSourced(`
LLAMA_SERVER_DOWNLOAD_URL=https://example.invalid/x.tar.gz
resolve_llama_server_download_url >/dev/null; echo "RC=$?"
LLAMA_SERVER_DOWNLOAD_SHA256=nothex resolve_llama_server_download_url >/dev/null; echo "RC2=$?"
`);
    expect(out).toContain('RC=1');
    expect(out).toContain('RC2=1');
  });

  it('fails closed on a sha256 mismatch and never extracts', () => {
    const out = runSourced(`
download_file_node() { printf 'definitely not llama.cpp' > "$2"; }
extract_archive_file() { echo "EXTRACTED"; return 1; }
install_llama_server_bin; echo "RC=$?"
`);
    expect(out).toContain('sha256 mismatch');
    expect(out).toContain('refusing to install');
    expect(out).not.toContain('EXTRACTED');
    expect(out).toContain('RC=1');
  });

  it('extracts only when the hash matches (override path)', () => {
    const payload = 'pretend archive';
    const sha = crypto.createHash('sha256').update(payload).digest('hex');
    const out = runSourced(`
download_file_node() { printf '${payload}' > "$2"; }
extract_archive_file() { echo "EXTRACTED"; return 1; }
LLAMA_SERVER_DOWNLOAD_URL=https://example.invalid/x.tar.gz LLAMA_SERVER_DOWNLOAD_SHA256=${sha.toUpperCase()} install_llama_server_bin; echo "RC=$?"
`);
    expect(out).toContain('EXTRACTED');
    expect(out).not.toContain('sha256 mismatch');
  });

  it('falls back to the verified release scan only when the pinned download fails', () => {
    const payload = 'fallback archive';
    const sha = crypto.createHash('sha256').update(payload).digest('hex');
    const out = runSourced(`
download_file_node() {
  case "$1" in *${LLAMA_CPP_PINNED_RELEASE.tag}*) echo "HTTP 404" > "$3"; return 1 ;; esac
  echo "FETCH $1"
  printf '${payload}' > "$2"
}
resolve_llama_server_fallback_url() {
  printf '%s' '${sha}' > "$TMP_DIR/llama-server-sha256-$AGENT_ID.txt"
  printf '%s\\n' 'https://github.com/ggml-org/llama.cpp/releases/download/b99999/llama-b99999-bin-android-arm64.tar.gz'
}
extract_archive_file() { echo "EXTRACTED"; return 1; }
install_llama_server_bin; echo "RC=$?"
`);
    expect(out).toContain('FETCH https://github.com/ggml-org/llama.cpp/releases/download/b99999/');
    expect(out).toContain('EXTRACTED');
  });
});
