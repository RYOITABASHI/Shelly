/**
 * The stored stream feed (put_stream_feed / get_stream_feed, launcher ingress
 * C7) is tainted external data shown to the launcher only: no run, prompt,
 * agent input, chat, log or repo may ever read it. This pins the places that
 * name the op, its target or the native store call; a new file that does is a
 * new path the feed could flow through and must be reviewed (and added here).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..');
const KT = 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator';

const ALLOWED = new Set([
  'scripts/shelly-mcp-server.js',
  'modules/terminal-emulator/android/src/main/assets/shelly-mcp-server.js',
  'lib/mcp-stream-feed.ts',
  'lib/mcp-always-allow.ts',
  // Settings always-allow rule labels for the op (PR #221); display strings only.
  'lib/i18n/locales/en.ts',
  'lib/i18n/locales/ja.ts',
  'lib/mcp-server-bridge.ts',
  'lib/ingress-origin.ts',
  'store/mcp-approval-store.ts',
  'modules/terminal-emulator/src/TerminalEmulatorModule.ts',
  `${KT}/StreamFeedCore.kt`,
  `${KT}/StreamFeedStore.kt`,
  `${KT}/McpTypedOpConsumer.kt`,
  `${KT}/McpAlwaysAllowStore.kt`,
  `${KT}/IngressAuditWriter.kt`,
  `${KT}/IngressDecision.kt`,
  `${KT}/TerminalEmulatorModule.kt`,
  `${KT}/LauncherIngressLimits.kt`,
  `${KT}/LauncherIngressProvider.kt`,
]);

/** Tests and docs may name it; they are not runtime paths. */
function exempt(rel: string): boolean {
  return rel.startsWith('__tests__/')
    || rel.startsWith('docs/')
    || rel.endsWith('.md')
    || /\/src\/test\//.test(rel);
}

function repoFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return out.toString('utf8').split('\0').filter((f) => f && !f.startsWith('node_modules/'));
}

const NEEDLES = ['streamFeedPut', 'stream-feed', 'put_stream_feed'];
const TEXT_EXT = /\.(ts|tsx|js|cjs|mjs|kt|java|c|h|json|sh|gradle|xml|ya?ml|toml)$/;

describe('the stored stream feed flows nowhere else', () => {
  const hits = repoFiles()
    .filter((rel) => TEXT_EXT.test(rel) && !exempt(rel))
    .filter((rel) => {
      const abs = path.join(root, rel);
      let text: string;
      try {
        if (!fs.statSync(abs).isFile()) return false;
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        return false;
      }
      return NEEDLES.some((n) => text.includes(n));
    });

  it('finds the files it is meant to check', () => {
    expect(hits).toEqual(expect.arrayContaining(['lib/mcp-stream-feed.ts', 'lib/mcp-server-bridge.ts', 'scripts/shelly-mcp-server.js']));
  });

  it('only the reviewed files name the op, its target or the native store call', () => {
    expect(hits.filter((rel) => !ALLOWED.has(rel))).toEqual([]);
  });

  it('agent, prompt, chat and executor code never names it', () => {
    for (const rel of hits) {
      expect(rel).not.toMatch(/agent-(?:manager|executor|orchestration)|plan-executor|agent-driver|chat|prompt/);
    }
  });
});
