/**
 * Source pins for the launcher ingress Settings section: it only calls the lib
 * wrappers, binds the exemption to the digest shown, ships no real values, and
 * every i18n key it (or the rule list) uses exists in both locales.
 */
import * as fs from 'fs';
import * as path from 'path';
import en from '@/lib/i18n/locales/en';
import ja from '@/lib/i18n/locales/ja';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const section = read('components/settings/LauncherIngressSection.tsx');
const dropdown = read('components/layout/SettingsDropdown.tsx');

describe('LauncherIngressSection', () => {
  it('goes through the lib wrappers only (no native module, no logging)', () => {
    expect(section).toMatch(/from '@\/lib\/launcher-ingress'/);
    expect(section).not.toMatch(/TerminalEmulator/);
    expect(section).not.toMatch(/trustedCaller(Set|SetExemption|Remove|List)/);
    expect(section).not.toMatch(/console\.|logInfo|logWarn|logError|debug-logger/);
    for (const fn of ['listTrustedCallers', 'setLauncherCaller', 'setLauncherExemption', 'removeLauncherCaller', 'parsePinList', 'isValidPackageName', 'digestLabel', 'pinsLabel']) {
      expect(section).toContain(fn);
    }
  });

  it('grants the exemption with the caller pinsDigest and withdraws with null', () => {
    expect(section).toMatch(/const digest = caller\.pinsDigest;/);
    expect(section).toMatch(/setLauncherExemption\(true, digest\)/);
    expect(section).toMatch(/setLauncherExemption\(false, null\)/);
    expect(section).toMatch(/digestLabel\(digest\)/);
    // The confirmation shows the pins themselves: what the owner can check against the signing certificate.
    expect(section).toContain('pins: pinsLabel(caller.pins)');
    expect(section).toMatch(/caller\.exemptionBound/);
  });

  it('contains no real package name or pin (only obvious placeholders)', () => {
    expect(section).not.toMatch(/[0-9a-f]{32,}/i);
    const pkgs = section.match(/\b[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}\b/g) ?? [];
    const allowed = pkgs.filter((p) => p !== 'com.example.launcher' && !/^(styles|theme|react|lib|launcher_ingress|common)\b/.test(p));
    expect(allowed.filter((p) => /^(com|org|net|io|dev|jp)\./.test(p))).toEqual([]);
  });

  it('is rendered from SettingsDropdown, and rules show their origin', () => {
    expect(dropdown).toContain("import { LauncherIngressSection } from '@/components/settings/LauncherIngressSection'");
    expect(dropdown).toContain('<LauncherIngressSection visible={visible} />');
    expect(dropdown).toMatch(/ruleOrigin\(r\.principal\)/);
    expect(dropdown).toMatch(/clientIdLabel\(r\.principal\)/);
  });

  it('every launcher_ingress key used exists in en and ja', () => {
    const used = new Set<string>();
    for (const m of (section + dropdown).matchAll(/'(launcher_ingress\.[a-z_.]+)'/g)) used.add(m[1]);
    for (const code of ['invalid', 'invalid_package', 'invalid_pin', 'full', 'no_caller', 'not_exemptable', 'digest_changed', 'failed', 'unavailable', 'generic', 'package', 'pins']) {
      used.add(`launcher_ingress.err.${code}`);
    }
    expect(used.size).toBeGreaterThan(20);
    for (const k of used) {
      expect(en[k]).toBeTruthy();
      expect(ja[k]).toBeTruthy();
    }
    const enKeys = Object.keys(en).filter((k) => k.startsWith('launcher_ingress.')).sort();
    const jaKeys = Object.keys(ja).filter((k) => k.startsWith('launcher_ingress.')).sort();
    expect(jaKeys).toEqual(enKeys);
  });

  it('known error codes in the component match the native refusal codes', () => {
    const m = section.match(/new Set\(\[([\s\S]*?)\]\)/);
    expect(m).not.toBeNull();
    const codes = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    for (const c of codes) expect(en[`launcher_ingress.err.${c}`]).toBeTruthy();
  });
});
