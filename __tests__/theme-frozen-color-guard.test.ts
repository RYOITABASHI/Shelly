/**
 * Guard against frozen / hardcoded colors in UI code (2026-10-09).
 *
 * Root problem: applyThemePreset() swaps the palette by mutating
 * theme.config's `colors` in place. Anything that copies those values at
 * MODULE LOAD — a module-level `StyleSheet.create({ x: { color: C.text1 } })`
 * or `const MAP = { a: C.accent }` — keeps the dark seed palette forever, so
 * the light Case File preset showed near-white ink on beige. Hardcoded dark
 * hex colors in components have the same effect.
 *
 * Rules enforced over components/ and app/:
 *  1. No module-level `StyleSheet.create(...)` whose body reads theme.config
 *     colors — use createThemedStyles(() => ({...})) (lib/themed-stylesheet)
 *     or build styles from useTheme() colors.
 *  2. No module-level non-function `const X = ...` initializer that reads
 *     theme.config colors — make it a getter function read at render time.
 *  3. Raw hex color literals only in allowlisted files, never more than the
 *     allowlisted count. New colors must come from useTheme() / theme.config.
 *     If you intentionally add one (brand/identity color, fixed overlay),
 *     bump the count below WITH a reason.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['components', 'app'];

/** file (posix, repo-relative) -> [max raw hex literals, reason] */
const HEX_ALLOWLIST: Record<string, [number, string]> = {
  // Fixed-identity / intentionally theme-independent surfaces.
  'app/_layout.tsx': [7, 'root ErrorBoundary crash screen (must render without theme) + Custom Tabs toolbarColor'],
  'components/CaseFileBootOverlay.tsx': [4, 'Case File boot flash: fixed Case File brand colors by design'],
  'components/scouter/ScouterDetailModal.tsx': [33, 'Scouter HUD: deliberate fixed green-phosphor device aesthetic'],
  'components/panes/TerminalPane.tsx': [2, 'terminal surface matches the native (separately themed) terminal palette; FAB glyph on fixed dark scrim'],
  'components/terminal/CommandKeyBar.tsx': [1, 'key bar matches the native terminal surface'],
  'components/layout/WorktreeAddModal.tsx': [2, 'agent identity colors (Codex green / None gray)'],
  'components/layout/CodexSessionsSection.tsx': [1, 'black scrim (withAlpha #000000) backdrop overlay'],
  // Dead code — not imported anywhere in the app (kept for history; delete or theme before reviving).
  'components/ChatOnboarding.tsx': [20, 'unreachable (no importers)'],
  'components/StatusIndicator.tsx': [14, 'unreachable (no importers)'],
  'components/SavepointBubble.tsx': [3, 'unreachable (no importers)'],
  'components/DiffViewerModal.tsx': [6, 'only reachable via unreachable SavepointBubble; #00000088 scrim'],
  'components/WebPreviewModal.tsx': [1, 'unreachable (no importers); #00000088 scrim'],
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}(),])\/\/.*$/gm, '$1');
}

/** Raw hex color literals, ignoring (text)shadowColor — a black drop
 *  shadow is theme-independent. */
function countHex(src: string): number {
  const noShadows = src.replace(/(?:textShadowColor|shadowColor)\s*:\s*(['"`])#[0-9a-fA-F]{3,8}\1/g, '');
  return (noShadows.match(/(['"`])#[0-9a-fA-F]{3,8}\1/g) || []).length;
}

function themeColorsAlias(src: string): string | null {
  const imp = src.match(/import\s*\{([^}]*)\}\s*from\s*'@\/theme\.config'/);
  if (!imp) return null;
  const m = imp[1].match(/\bcolors(?:\s+as\s+(\w+))?/);
  return m ? m[1] || 'colors' : null;
}

/** Slice from `open` (index just after an opening paren) to its matching close. */
function balanced(src: string, open: number): string {
  let i = open;
  let depth = 1;
  while (depth && i < src.length) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') depth--;
    i++;
  }
  return src.slice(open, i - 1);
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d))).map((abs) => ({
  rel: path.relative(ROOT, abs).split(path.sep).join('/'),
  src: stripComments(fs.readFileSync(abs, 'utf8')),
}));

describe('theme frozen-color guard', () => {
  it('has no module-level StyleSheet.create reading theme.config colors', () => {
    const offenders: string[] = [];
    for (const { rel, src } of files) {
      const alias = themeColorsAlias(src);
      if (!alias) continue;
      const re = /^(?:export )?const (\w+)\s*=\s*StyleSheet\.create\(/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const body = balanced(src, m.index + m[0].length);
        if (new RegExp(`\\b${alias}\\.\\w`).test(body)) offenders.push(`${rel}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no module-level constant initializers that copy theme.config colors', () => {
    const offenders: string[] = [];
    for (const { rel, src } of files) {
      const alias = themeColorsAlias(src);
      if (!alias) continue;
      const re = /^(?:export )?const (\w+)\s*(?::[^=\n]+)?=\s*/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const rest = src.slice(m.index + m[0].length);
        const firstLine = rest.split('\n')[0];
        // functions / hooks / components / lazy factories are fine
        if (/=>|^function\b|^async\b|^(React\.)?(memo|forwardRef)\(|^createThemedStyles\(|^create[<(]/.test(firstLine)) continue;
        // statement body = until the next column-0 line
        const end = rest.search(/\n(?=\S)/);
        const body = end < 0 ? rest : rest.slice(0, end + 3);
        if (/^\s*get \w+\(\)/m.test(body)) continue; // getter-based live object
        if (new RegExp(`\\b${alias}\\.\\w`).test(body)) offenders.push(`${rel}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps raw hex color literals within the allowlist', () => {
    const over: string[] = [];
    for (const { rel, src } of files) {
      const count = countHex(src);
      const allowed = HEX_ALLOWLIST[rel]?.[0] ?? 0;
      if (count > allowed) over.push(`${rel}: ${count} raw hex color literal(s) (allowed ${allowed})`);
    }
    expect(over).toEqual([]);
  });

  it('allowlist entries are not stale (tighten counts when colors are removed)', () => {
    const stale: string[] = [];
    for (const [rel, [allowed]] of Object.entries(HEX_ALLOWLIST)) {
      const f = files.find((x) => x.rel === rel);
      const count = f ? countHex(f.src) : 0;
      if (count < allowed) stale.push(`${rel}: allowlisted ${allowed}, found ${count}`);
    }
    expect(stale).toEqual([]);
  });
});
