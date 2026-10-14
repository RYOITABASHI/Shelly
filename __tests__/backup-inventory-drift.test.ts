// Fails when a new expo-secure-store key appears in the source tree without
// being added to lib/backup/secure-store-inventory.ts — otherwise a backup
// would silently drop it and a signing-key migration would lose that secret.
import * as fs from 'fs';
import * as path from 'path';

jest.mock('expo-secure-store', () => ({}));
import { API_KEY_NAMES } from '@/lib/secure-store';
import {
  FIXED_SECURE_KEYS,
  LEGACY_SECURE_KEYS,
  SYSTEM_CONNECTOR_SECRETS,
  apiKeySecureKey,
  buildSecureStoreInventory,
  isRestorableSecureKey,
} from '@/lib/backup/secure-store-inventory';

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['lib', 'store', 'hooks', 'components', 'app', 'modules'];

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '__tests__' || ent.name === 'android' || ent.name === 'ios' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js)$/.test(ent.name)) out.push(p);
  }
}

const files: string[] = [];
for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);

/** Resolve an identifier to `const IDENT = '…'` in the same file. */
function resolveConst(src: string, ident: string): string | null {
  const m = new RegExp(`const\\s+${ident}\\s*(?::\\s*string)?\\s*=\\s*['"\`]([^'"\`$]+)['"\`]`).exec(src);
  return m ? m[1] : null;
}

// Dynamic (non-literal) key expressions that are covered by the inventory by
// construction. Keyed by repo-relative file.
const ALLOWED_DYNAMIC: Record<string, string[]> = {
  'lib/secure-store.ts': ['`${KEY_PREFIX}${name}`', 'key'],
};

describe('SecureStore inventory drift', () => {
  const inventory = new Set(buildSecureStoreInventory([]));
  const legacy = new Set(LEGACY_SECURE_KEYS);

  it('finds the known SecureStore users (sanity)', () => {
    const users = files.filter((f) => /SecureStore\.(get|set|delete)ItemAsync\(/.test(fs.readFileSync(f, 'utf8')));
    expect(users.length).toBeGreaterThanOrEqual(6);
  });

  it('every SecureStore key used in the source tree is inventoried', () => {
    const problems: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      if (rel.startsWith('lib/backup/')) continue;
      const re = /SecureStore\.(?:get|set|delete)ItemAsync\(\s*([^,)]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const arg = m[1].trim();
        let key: string | null = null;
        const lit = /^['"]([^'"]+)['"]$/.exec(arg);
        if (lit) key = lit[1];
        else if (/^[A-Za-z_$][\w$]*$/.test(arg)) key = resolveConst(src, arg);
        if (key === null) {
          if ((ALLOWED_DYNAMIC[rel] ?? []).includes(arg)) continue;
          problems.push(`${rel}: unresolvable SecureStore key expression ${arg}`);
          continue;
        }
        if (!inventory.has(key) && !legacy.has(key)) problems.push(`${rel}: SecureStore key '${key}' missing from lib/backup/secure-store-inventory.ts`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every fixed-id connector secret is inventoried', () => {
    const problems: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      const re = /(?:get|save|delete)ConnectorSecret\(\s*([^,]+),\s*([^,)]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const idExpr = m[1].trim();
        const fieldExpr = m[2].trim();
        const idLit = /^['"]([^'"]+)['"]$/.exec(idExpr)?.[1] ?? (/^[A-Z_][A-Z0-9_]*$/.test(idExpr) ? resolveConst(src, idExpr) : null);
        if (idLit === null) continue; // dynamic id = user-registered connector (enumerated from AsyncStorage)
        const fieldLit = /^['"]([^'"]+)['"]$/.exec(fieldExpr)?.[1] ?? (/^[A-Z_][A-Z0-9_]*$/.test(fieldExpr) ? resolveConst(src, fieldExpr) : null);
        if (!SYSTEM_CONNECTOR_SECRETS.some((s) => s.id === idLit && (fieldLit === null || s.field === fieldLit))) {
          problems.push(`${rel}: connector secret ${idLit}.${fieldLit} missing from SYSTEM_CONNECTOR_SECRETS`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('inventory covers API keys, fixed keys and system connectors, and restore allows them', () => {
    for (const n of API_KEY_NAMES) {
      expect(inventory.has(apiKeySecureKey(n))).toBe(true);
      expect(isRestorableSecureKey(apiKeySecureKey(n))).toBe(true);
    }
    for (const k of Object.keys(FIXED_SECURE_KEYS)) {
      expect(inventory.has(k)).toBe(true);
      expect(isRestorableSecureKey(k)).toBe(true);
    }
    expect(inventory.has('shelly_memory_v2_dek')).toBe(true);
    expect(inventory.has('shelly_social-connector.mcp-server.token')).toBe(true);
    expect(isRestorableSecureKey('shelly_claudeAuthToken')).toBe(false);
    expect(isRestorableSecureKey('random_key')).toBe(false);
  });

  it('enumerates user social connectors from AsyncStorage', () => {
    const keys = buildSecureStoreInventory([{ id: 'my-x', platform: 'x' }, { id: 'tg', platform: 'telegram' }]);
    expect(keys).toEqual(expect.arrayContaining([
      'shelly_social-connector.my-x.refreshToken',
      'shelly_social-connector.my-x.clientId',
      'shelly_social-connector.tg.botToken',
      'shelly_social-connector.tg.chatId',
    ]));
  });
});
