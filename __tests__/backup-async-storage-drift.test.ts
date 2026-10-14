// Fails when an AsyncStorage key (or zustand persist name) appears in the
// source tree without an explicit restore decision in
// lib/backup/async-storage-allowlist.ts (restore / approval opt-in / deny).
import * as fs from 'fs';
import * as path from 'path';
import {
  ASYNC_STORAGE_APPROVAL_KEYS,
  ASYNC_STORAGE_RESTORE_ALLOWLIST,
  ASYNC_STORAGE_RESTORE_DENYLIST,
  asyncKeyDecision,
} from '@/lib/backup/async-storage-allowlist';

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['lib', 'store', 'hooks', 'components', 'app'];

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '__tests__' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p);
  }
}

const files: string[] = [];
for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);

function resolveConst(src: string, ident: string): string | null {
  const m = new RegExp(`const\\s+${ident}\\s*(?::\\s*string)?\\s*=\\s*['"\`]([^'"\`$]+)['"\`]`).exec(src);
  return m ? m[1] : null;
}

/** Dynamic key expressions whose possible values are enumerated elsewhere
 *  in the same file (checked below). */
const DYNAMIC_OK: Record<string, string[]> = {
  'lib/dotfiles-sync.ts': ['entry.storageKey'],
};

function collectKeys(): { keys: Map<string, string[]>; problems: string[] } {
  const keys = new Map<string, string[]>();
  const problems: string[] = [];
  const add = (k: string, where: string) => keys.set(k, [...(keys.get(k) ?? []), where]);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes('async-storage')) continue;
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (rel.startsWith('lib/backup/')) continue;
    const resolveArg = (arg: string): string | null => {
      const lit = /^['"`]([^'"`$]+)['"`]$/.exec(arg);
      if (lit) return lit[1];
      if (/^[A-Za-z_$][\w$]*$/.test(arg)) return resolveConst(src, arg);
      return null;
    };
    const re = /AsyncStorage\.(?:getItem|setItem|removeItem|mergeItem)\(\s*([^,)]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const arg = m[1].trim();
      const key = resolveArg(arg);
      if (key === null) {
        if ((DYNAMIC_OK[rel] ?? []).includes(arg)) continue;
        problems.push(`${rel}: unresolvable AsyncStorage key expression ${arg}`);
      } else add(key, rel);
    }
    const multi = /AsyncStorage\.multiRemove\(\s*\[([^\]]*)\]/g;
    while ((m = multi.exec(src))) {
      for (const part of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        const key = resolveArg(part);
        if (key === null) problems.push(`${rel}: unresolvable multiRemove key ${part}`);
        else add(key, rel);
      }
    }
    if (/createJSONStorage\(\s*\(\)\s*=>\s*AsyncStorage/.test(src)) {
      const pn = /\bname:\s*['"]([^'"]+)['"]/g;
      const found = [...src.matchAll(pn)].map((x) => x[1]);
      if (found.length === 0) problems.push(`${rel}: zustand persist without a literal name`);
      // a persist file's `name:` literals include the persist name; only the
      // one(s) adjacent to createJSONStorage are real keys.
      const near = /\bname:\s*['"]([^'"]+)['"],?\s*\n\s*storage:\s*createJSONStorage/g;
      for (const x of src.matchAll(near)) add(x[1], rel);
    }
    if (rel === 'lib/dotfiles-sync.ts') {
      for (const x of src.matchAll(/storageKey:\s*['"]([^'"]+)['"]/g)) add(x[1], rel);
    }
  }
  return { keys, problems };
}

describe('AsyncStorage restore allowlist drift', () => {
  const { keys, problems } = collectKeys();

  it('finds the known AsyncStorage users (sanity)', () => {
    expect(keys.has('shelly_settings')).toBe(true);
    expect(keys.has('pane-store-v1')).toBe(true);
    expect(keys.has('multi-pane-state-v1')).toBe(true);
    expect(keys.has('@shelly/keybindings')).toBe(true);
    expect(keys.size).toBeGreaterThan(30);
  });

  it('every AsyncStorage key in the source tree has an explicit restore decision', () => {
    const missing = [...keys.entries()].filter(([k]) => asyncKeyDecision(k) === 'unknown').map(([k, w]) => `${k} (${w.join(', ')})`);
    expect(problems).toEqual([]);
    expect(missing).toEqual([]);
  });

  it('lists are disjoint and the approval / install-specific keys are not in the allowlist', () => {
    const all = [...ASYNC_STORAGE_RESTORE_ALLOWLIST, ...ASYNC_STORAGE_APPROVAL_KEYS, ...ASYNC_STORAGE_RESTORE_DENYLIST];
    expect(new Set(all).size).toBe(all.length);
    expect(asyncKeyDecision('shelly_dm_pairings')).toBe('approval');
    expect(asyncKeyDecision('shelly_android_update_download')).toBe('deny');
    expect(asyncKeyDecision('@shelly/github_pat')).toBe('deny');
    expect(asyncKeyDecision('something_new')).toBe('unknown');
  });
});
