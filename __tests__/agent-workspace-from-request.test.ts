/**
 * CLI workspace derived from the paths an NL request names —
 * lib/agent-workspace-from-request.ts (2026-11-01, on-device build 2772).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  deriveWorkspaceRootFromText,
  KNOWN_APP_HOME_PATHS,
  resolveWorkspaceRootForHome,
} from '@/lib/agent-workspace-from-request';
import { parseAgentNL } from '@/lib/agent-nl-parser';
import { draftToConfirmedAgentDraft, summarizeAgentDraftAsText } from '@/lib/agent-plan-summary';

const HOME = KNOWN_APP_HOME_PATHS[0];
const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const REHEARSAL =
  '@agent Right now, run without approval. At the same time: build a single-file brick breaker game in ~/demo/codex.html with Codex, build a single-file brick breaker game in ~/demo/claude.html with Claude Code, and finally list both file paths';

describe('deriveWorkspaceRootFromText — good cases', () => {
  it('two files in one directory → that directory (the on-device rehearsal)', () => {
    expect(deriveWorkspaceRootFromText(REHEARSAL)).toBe('~/demo');
  });

  it('a single file → its directory; a directory → itself', () => {
    expect(deriveWorkspaceRootFromText('write a summary to ~/notes/today.md')).toBe('~/notes');
    expect(deriveWorkspaceRootFromText('tidy up ~/work/site/')).toBe('~/work/site');
    expect(deriveWorkspaceRootFromText('list the files in ~/work/site')).toBe('~/work/site');
  });

  it('paths that disagree → the deepest common directory', () => {
    expect(deriveWorkspaceRootFromText('compare ~/proj/a/x.ts and ~/proj/b/y.ts')).toBe('~/proj');
    expect(deriveWorkspaceRootFromText('copy ~/proj/a/x.ts into ~/proj/a/sub/')).toBe('~/proj/a');
  });

  it('$HOME / ${HOME} / absolute app-home spellings count', () => {
    expect(deriveWorkspaceRootFromText('edit $HOME/demo/a.html')).toBe('~/demo');
    expect(deriveWorkspaceRootFromText('edit ${HOME}/demo/a.html')).toBe('~/demo');
    expect(deriveWorkspaceRootFromText(`edit ${HOME}/demo/a.html and ${KNOWN_APP_HOME_PATHS[1]}/demo/b.html`)).toBe('~/demo');
  });

  it('Japanese text around the paths', () => {
    expect(deriveWorkspaceRootFromText('承認なしで実行して。~/demo/codex.htmlにCodexでブロック崩しを、~/demo/claude.htmlにClaude Codeで作って')).toBe('~/demo');
    expect(deriveWorkspaceRootFromText('「~/ゲーム/a.html」に作って')).toBeNull();
  });

  it('trailing punctuation is not part of the path', () => {
    expect(deriveWorkspaceRootFromText('build it in ~/demo/codex.html.')).toBe('~/demo');
    expect(deriveWorkspaceRootFromText('files: ~/demo/a.html, ~/demo/b.html')).toBe('~/demo');
  });

  it('an explicit workspace wins over the derived one', () => {
    expect(deriveWorkspaceRootFromText('workspace ~/proj — write ~/proj/a/x.ts and ~/proj/b/y.ts')).toBe('~/proj');
    expect(deriveWorkspaceRootFromText('write ~/demo/a/x.ts and ~/demo/b/y.ts, project folder: ~/demo/a')).toBe('~/demo/a');
    expect(deriveWorkspaceRootFromText('ワークスペースは ~/site で、~/notes/a.md に要約を書いて')).toBe('~/site');
  });
});

describe('deriveWorkspaceRootFromText — refused cases', () => {
  it('$HOME itself (directly or as the only common directory) → none', () => {
    expect(deriveWorkspaceRootFromText('list ~')).toBeNull();
    expect(deriveWorkspaceRootFromText('list ~/')).toBeNull();
    expect(deriveWorkspaceRootFromText('write ~/a.md')).toBeNull();
    expect(deriveWorkspaceRootFromText('compare ~/a/x.ts and ~/b/y.ts')).toBeNull();
  });

  it('dot-dirs / Shelly control dirs anywhere → none (fail closed)', () => {
    expect(deriveWorkspaceRootFromText('edit ~/.shelly/agents/a.json')).toBeNull();
    expect(deriveWorkspaceRootFromText('read ~/.ssh/config')).toBeNull();
    expect(deriveWorkspaceRootFromText('write ~/.config/app/x.json')).toBeNull();
    expect(deriveWorkspaceRootFromText('write ~/demo/a.html and ~/.bashrc')).toBeNull();
    expect(deriveWorkspaceRootFromText('write ~/demo/../x/a.html')).toBeNull();
    expect(deriveWorkspaceRootFromText('replace ~/bin/git')).toBeNull();
    expect(deriveWorkspaceRootFromText('write ~/demo/.hidden/a.html')).toBeNull();
  });

  it('/sdcard, other absolute paths and URLs are ignored', () => {
    expect(deriveWorkspaceRootFromText('save to /sdcard/Download/a.txt')).toBeNull();
    expect(deriveWorkspaceRootFromText('fetch https://example.com/~/demo/a.html')).toBeNull();
    expect(deriveWorkspaceRootFromText('save to /sdcard/a.txt and ~/demo/b.txt')).toBe('~/demo');
  });

  it('no paths at all → none', () => {
    expect(deriveWorkspaceRootFromText('summarize the news every morning')).toBeNull();
    expect(deriveWorkspaceRootFromText('')).toBeNull();
    expect(deriveWorkspaceRootFromText(null)).toBeNull();
  });

  it('paths inside a fenced block / blockquote are pasted content', () => {
    expect(deriveWorkspaceRootFromText('summarize this:\n```\ncat ~/demo/a.html\n```')).toBeNull();
    expect(deriveWorkspaceRootFromText('summarize this:\n> see ~/demo/a.html')).toBeNull();
  });
});

describe('resolveWorkspaceRootForHome', () => {
  it('resolves ~/x to an absolute path under the home', () => {
    expect(resolveWorkspaceRootForHome('~/demo', HOME)).toBe(`${HOME}/demo`);
    expect(resolveWorkspaceRootForHome('~/demo', `${HOME}/`)).toBe(`${HOME}/demo`);
  });

  it('refuses $HOME, dot-dirs, control dirs and non-home-relative input', () => {
    expect(resolveWorkspaceRootForHome('~', HOME)).toBeNull();
    expect(resolveWorkspaceRootForHome('~/', HOME)).toBeNull();
    expect(resolveWorkspaceRootForHome('~/.shelly', HOME)).toBeNull();
    expect(resolveWorkspaceRootForHome('~/bin', HOME)).toBeNull();
    expect(resolveWorkspaceRootForHome('/sdcard', HOME)).toBeNull();
    expect(resolveWorkspaceRootForHome('~/demo', '')).toBeNull();
    expect(resolveWorkspaceRootForHome(undefined, HOME)).toBeNull();
  });
});

describe('NL draft → confirm text → createAgent', () => {
  it('the rehearsal draft carries ~/demo, shows it, and hands it to the confirmed draft', () => {
    const draft = parseAgentNL(REHEARSAL);
    expect(draft.workspaceRoot).toBe('~/demo');
    expect(summarizeAgentDraftAsText(draft)).toMatch(/Workspace: ~\/demo|ワークスペース: ~\/demo/);
    expect(draftToConfirmedAgentDraft(draft).workspaceRoot).toBe('~/demo');
  });

  it('a request without paths has no workspace line', () => {
    const draft = parseAgentNL('@agent summarize the news every morning at 8');
    expect(draft.workspaceRoot).toBeUndefined();
    expect(draftToConfirmedAgentDraft(draft).workspaceRoot).toBeUndefined();
  });

  it('the dispatcher resolves it, creates the directory and passes it to createAgent', () => {
    const src = read('hooks/use-ai-pane-dispatch.ts');
    expect(src).toMatch(/resolveWorkspaceRootForHome\(confirmed\.workspaceRoot, getHomePath\(\)\)/);
    expect(src).toMatch(/mkdir -p -- /);
    expect(src).toMatch(/\.\.\.\(resolvedWorkspaceRoot \? \{ workspaceRoot: resolvedWorkspaceRoot \} : \{\}\)/);
    // The serial chain's DRIVER_CWD and the plan spec's cliWorker.cwd both
    // read the (validated) agent.workspaceRoot.
    expect(read('lib/agent-executor.ts')).toMatch(/DRIVER_CWD="\\\$\{AGENT_WORKSPACE_ROOT:-\$PROJECT_DIR\}"/);
    expect(read('lib/agent-plan-spec.ts')).toMatch(/agent\.workspaceRoot &&\s+validateWorkspaceRoot\(agent\.workspaceRoot/);
  });

  it('i18n: the workspace line exists in both locales', () => {
    expect(read('lib/i18n/locales/en.ts')).toMatch(/'agentplan\.workspace_line': 'Workspace: \{\{path\}\}/);
    expect(read('lib/i18n/locales/ja.ts')).toMatch(/'agentplan\.workspace_line': 'ワークスペース: \{\{path\}\}/);
  });
});
