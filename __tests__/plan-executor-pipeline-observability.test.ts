/**
 * Pipeline observability batch A (2026-11-18), executor side.
 *
 * A3: writeDraftOutputs never fails silently. A failed draft write leaves a
 * `draft_write_failed` audit line, swallowed or not; the fatal path (the
 * terminal `draft` action, which is what a longform chain's assemble step
 * dispatches) still throws so the run ends in error; and a broker that answers
 * 0 without leaving the file is caught by the post-write check. A saved draft
 * leaves `draft_saved` with its folder and file name.
 *
 * A1: articleDigestStreamsMismatch names folder mismatches between the
 * owner's pipelines and the digest's streams (run-time audit line).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const assetCopy = path.join(root, 'modules', 'terminal-emulator', 'android', 'src', 'main', 'assets', 'shelly-plan-executor.js');
const realBroker = path.join(root, 'scripts', 'shelly-capability-broker.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(scriptCopy);

const AGENT_ID = 'agent-observability';

function setup() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-obs-')));
  const paths = executor.runtimePaths(home, AGENT_ID);
  fs.mkdirSync(paths.logDir, { recursive: true });
  fs.mkdirSync(paths.tmpDir, { recursive: true });
  const vault = path.join(home, 'Vault');
  const outputDir = path.join(vault, '50_Drafts', 'Steam');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(paths.resultFile, '# Title\n\nBody of the draft.\n');
  const plan = {
    agent: { id: AGENT_ID },
    tool: { type: 'gemini-api' },
    action: { type: 'draft' },
    output: { outputDir, outputNameTemplate: '{date}-steam.md' },
    steps: { longform: true, list: [] },
  };
  const config = { OBSIDIAN_VAULT_PATH: vault };
  const roots = [paths.tmpDir, vault];
  return { home, paths, plan, config, roots, outputDir };
}

function fakeBroker(home: string, body: string): string {
  const file = path.join(home, 'fake-broker.js');
  fs.writeFileSync(file, body);
  return file;
}

function audit(paths: { planAuditFile: string }): any[] {
  try {
    return fs.readFileSync(paths.planAuditFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('A3: writeDraftOutputs makes a failed draft write visible', () => {
  it('a saved draft leaves draft_saved with folder and file name only, and sets savedOutput', async () => {
    const { home, paths, plan, config, roots, outputDir } = setup();
    await expect(executor.writeDraftOutputs(paths, { broker: realBroker }, plan, config, roots, false)).resolves.toBe(true);
    expect(paths.savedOutput.savedPath.startsWith(outputDir)).toBe(true);
    expect(fs.readFileSync(paths.savedOutput.savedPath, 'utf8')).toContain('Body of the draft.');
    const saved = audit(paths).filter((l) => l.event === 'draft_saved');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ agentId: AGENT_ID, folder: 'Steam', bytes: fs.statSync(paths.resultFile).size, verified: 'bytes' });
    expect(saved[0].file).toMatch(/^\d{4}-\d{2}-\d{2}-steam\.md$/);
    expect(JSON.stringify(saved[0])).not.toContain(home);
    expect(audit(paths).some((l) => l.event === 'draft_write_failed')).toBe(false);
  });

  it('the fatal path throws and audits a broker refusal', async () => {
    const { home, paths, plan, config, roots } = setup();
    const broker = fakeBroker(home, "require('fs').writeFileSync(process.argv[process.argv.indexOf('--err') + 1], 'scoped.fs: denied for test'); process.exit(3);\n");
    await expect(executor.writeDraftOutputs(paths, { broker }, plan, config, roots, false)).rejects.toThrow(/scoped filesystem write denied/);
    expect(paths.savedOutput).toBeUndefined();
    const failed = audit(paths).filter((l) => l.event === 'draft_write_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ agentId: AGENT_ID, actionType: 'draft', target: 'primary', swallowed: false, code: 'broker-refused' });
    // A code only: the broker's text (which can name a path) stays out of the audit log.
    expect(JSON.stringify(failed[0])).not.toContain('denied for test');
    expect('error' in failed[0]).toBe(false);
  });

  it('a broker that answers 0 without leaving the file is caught, not called saved', async () => {
    const { home, paths, plan, config, roots } = setup();
    const broker = fakeBroker(home, 'process.exit(0);\n');
    await expect(executor.writeDraftOutputs(paths, { broker }, plan, config, roots, false)).rejects.toThrow(/draft not found after write/);
    expect(paths.savedOutput).toBeUndefined();
    const failed = audit(paths).filter((l) => l.event === 'draft_write_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].code).toBe('missing-after-write');
    expect(audit(paths).some((l) => l.event === 'draft_saved')).toBe(false);
  });

  it('a truncated file on disk is caught too', async () => {
    const { home, paths, plan, config, roots } = setup();
    const broker = fakeBroker(home, "const a = process.argv; require('fs').writeFileSync(a[a.indexOf('--path') + 1], 'x'); process.exit(0);\n");
    await expect(executor.writeDraftOutputs(paths, { broker }, plan, config, roots, false)).rejects.toThrow(/1 bytes on disk/);
    expect(audit(paths).filter((l) => l.event === 'draft_write_failed').map((l) => l.code)).toEqual(['size-mismatch']);
  });

  it('an older draft of the same length left in place is caught, not called saved', async () => {
    const { home, paths, plan, config, roots } = setup();
    const { dest } = executor.resolveDraftDestination(paths, plan, config);
    const size = fs.statSync(paths.resultFile).size;
    fs.writeFileSync(dest, 'x'.repeat(size));
    const broker = fakeBroker(home, 'process.exit(0);\n');
    await expect(executor.writeDraftOutputs(paths, { broker }, plan, config, roots, false)).rejects.toThrow(/not the draft written/);
    expect(audit(paths).filter((l) => l.event === 'draft_write_failed').map((l) => l.code)).toEqual(['content-mismatch']);
    expect(audit(paths).some((l) => l.event === 'draft_saved')).toBe(false);
  });

  it('a file outside the output roots, even with the right bytes, is not called saved', async () => {
    if (!fs.existsSync('/proc/self/fd')) return;
    const { home, paths, plan, config, roots } = setup();
    const { dest } = executor.resolveDraftDestination(paths, plan, config);
    const outside = path.join(home, 'elsewhere.md');
    fs.copyFileSync(paths.resultFile, outside);
    fs.symlinkSync(outside, dest);
    const broker = fakeBroker(home, 'process.exit(0);\n');
    await expect(executor.writeDraftOutputs(paths, { broker }, plan, config, roots, false)).rejects.toThrow(/outside the output roots/);
    expect(audit(paths).filter((l) => l.event === 'draft_write_failed').map((l) => l.code)).toEqual(['outside-roots']);
  });

  it('a source swapped for a FIFO or a link is refused, without stalling', async () => {
    if (process.platform === 'win32') return;
    const { home, paths, plan, config, roots } = setup();
    fs.unlinkSync(paths.resultFile);
    require('child_process').execFileSync('mkfifo', [paths.resultFile]);
    const started = Date.now();
    await expect(executor.writeDraftOutputs(paths, { broker: realBroker }, plan, config, roots, false)).rejects.toThrow(/draft source/);
    expect(Date.now() - started).toBeLessThan(5000);
    fs.unlinkSync(paths.resultFile);
    fs.writeFileSync(path.join(home, 'outside.md'), 'x');
    fs.symlinkSync(path.join(home, 'outside.md'), paths.resultFile);
    await expect(executor.writeDraftOutputs(paths, { broker: realBroker }, plan, config, roots, false)).rejects.toThrow(/draft source/);
    expect(audit(paths).filter((l) => l.event === 'draft_write_failed').map((l) => l.code)).toEqual(['other', 'other']);
  });

  it('the broker writes from a private copy, removed afterwards; the registry reads the saved bytes', async () => {
    const { home, paths, plan, config, roots } = setup();
    const seen = path.join(home, 'input-seen.txt');
    const broker = fakeBroker(home, `const a = process.argv; const fs = require('fs'); const input = a[a.indexOf('--input-file') + 1];
fs.writeFileSync(${JSON.stringify(seen)}, input);
fs.copyFileSync(input, a[a.indexOf('--path') + 1]);
// Replace the run's result file after the copy: nothing later may read it.
fs.writeFileSync(${JSON.stringify(paths.resultFile)}, 'https://evil.example/replaced\\n');
process.exit(0);
`);
    const registry = path.join(home, 'registry.tsv');
    fs.writeFileSync(registry, '');
    await expect(executor.writeDraftOutputs(paths, { broker }, plan, { ...config, SOURCE_REGISTRY_FILE: registry }, roots, false)).resolves.toBe(true);
    const input = fs.readFileSync(seen, 'utf8');
    expect(input).not.toBe(paths.resultFile);
    expect(path.dirname(input)).toBe(paths.tmpDir);
    expect(fs.existsSync(input)).toBe(false);
    expect(fs.readFileSync(registry, 'utf8')).not.toContain('evil.example');
  });

  it('a write-only existing destination the broker can overwrite still counts as saved (size-checked)', async () => {
    if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return;
    const { home, paths, plan, config, roots } = setup();
    const { dest } = executor.resolveDraftDestination(paths, plan, config);
    fs.writeFileSync(dest, 'old');
    fs.chmodSync(dest, 0o200);
    const broker = fakeBroker(home, "const a = process.argv; require('fs').writeFileSync(a[a.indexOf('--path') + 1], require('fs').readFileSync(a[a.indexOf('--input-file') + 1])); process.exit(0);\n");
    await expect(executor.writeDraftOutputs(paths, { broker }, plan, config, roots, false)).resolves.toBe(true);
    expect(audit(paths).filter((l) => l.event === 'draft_saved').map((l) => l.verified)).toEqual(['size']);
    fs.chmodSync(dest, 0o600);
  });

  it('a FIFO at the destination does not stall the check', async () => {
    if (process.platform === 'win32') return;
    const { home, paths, plan, config, roots } = setup();
    const { dest } = executor.resolveDraftDestination(paths, plan, config);
    require('child_process').execFileSync('mkfifo', [dest]);
    const broker = fakeBroker(home, 'process.exit(0);\n');
    const started = Date.now();
    await expect(executor.writeDraftOutputs(paths, { broker }, plan, config, roots, false)).rejects.toThrow(/not a plain file/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('a leaf link to a file inside the root, which the broker writes through, still counts as saved', async () => {
    const { paths, plan, config, roots, outputDir } = setup();
    const { dest } = executor.resolveDraftDestination(paths, plan, config);
    const real = path.join(outputDir, 'linked-target.md');
    fs.writeFileSync(real, 'old\n');
    fs.symlinkSync(real, dest);
    await expect(executor.writeDraftOutputs(paths, { broker: realBroker }, plan, config, roots, false)).resolves.toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toContain('Body of the draft.');
    expect(audit(paths).some((l) => l.event === 'draft_write_failed')).toBe(false);
    expect(audit(paths).filter((l) => l.event === 'draft_saved')).toHaveLength(1);
  });

  it('the best-effort path still goes on, but no longer silently', async () => {
    const { home, paths, plan, config, roots } = setup();
    const broker = fakeBroker(home, 'process.exit(3);\n');
    const suppressed = { ...plan, action: { type: '__suppressed__' } };
    // false: this write's own outcome, which the policy draft_only path reports on.
    await expect(executor.writeDraftOutputs(paths, { broker }, suppressed, config, roots, true)).resolves.toBe(false);
    expect(paths.savedOutput).toBeUndefined();
    const failed = audit(paths).filter((l) => l.event === 'draft_write_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ actionType: '__suppressed__', swallowed: true });
  });

  it('both executor copies stay byte-identical', () => {
    expect(fs.readFileSync(assetCopy, 'utf8')).toBe(fs.readFileSync(scriptCopy, 'utf8'));
  });
});

describe('A1: articleDigestStreamsMismatch (run-time audit of the config file)', () => {
  const VAULT = '/sdcard/Vault/50_Drafts';
  const FOLDERS = ['Steam', 'Dev', 'DevEn', 'Vintage', 'VintageEn'];
  const pipelines = FOLDERS.map((f) => ({ id: f.toLowerCase(), outputFolder: `${VAULT}/${f}/` }));
  const digest = { outputFolder: `${VAULT}/Digest/`, streams: FOLDERS.map((f) => ({ folder: f, label: f })) };

  function homeWith(file: unknown): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-obs-cfg-'));
    fs.mkdirSync(path.join(home, '.shelly', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.shelly', 'agents', 'article-pipelines.json'), JSON.stringify(file));
    return home;
  }
  const articlePlan = (folder: string) => ({ steps: { longform: true, list: [{ local: { kind: 'assemble' } }] }, output: { outputDir: `${VAULT}/${folder}/` } });
  const digestPlan = (folders: string[]) => ({
    steps: { longform: true, list: [{ local: { kind: 'list-drafts', streams: folders.map((f) => ({ folder: f, label: f })) } }, { local: { kind: 'assemble' } }] },
    output: { outputDir: `${VAULT}/Digest/` },
  });

  it('the current five-stream layout passes, for every article plan and the digest', () => {
    const home = homeWith({ version: 1, pipelines, digest });
    for (const f of FOLDERS) expect(executor.articleDigestStreamsMismatch(home, articlePlan(f))).toEqual([]);
    expect(executor.articleDigestStreamsMismatch(home, digestPlan(FOLDERS))).toEqual([]);
  });

  it('names a pipeline folder that is in no stream, and this plan\'s own folder', () => {
    const typo = pipelines.map((p) => (p.id === 'steam' ? { ...p, outputFolder: `${VAULT}/STEAM/` } : p));
    const home = homeWith({ version: 1, pipelines: typo, digest });
    const problems = executor.articleDigestStreamsMismatch(home, articlePlan('STEAM'));
    expect(problems).toEqual(expect.arrayContaining([
      'pipelines[0] folder "STEAM" is not in digest.streams',
      'digest.streams[0] folder "Steam" has no pipeline',
      'this agent\'s folder "STEAM" is not in the file\'s digest.streams',
    ]));
    expect(problems.join(' ')).not.toContain('/sdcard');
  });

  it('names a digest plan stream with no pipeline in the file', () => {
    const home = homeWith({ version: 1, pipelines, digest });
    expect(executor.articleDigestStreamsMismatch(home, digestPlan([...FOLDERS, 'Garden']))).toEqual([
      'this digest\'s stream folder "Garden" has no pipeline in the file',
    ]);
  });

  it('valid JSON with odd field values never throws (the check is audit-only)', () => {
    const odd = homeWith({ version: 1, pipelines: [{ id: 'x', outputFolder: { toString: null } }, null, 7], digest: { ...digest, outputFolder: 5, streams: [{ folder: { toString: null } }, ...digest.streams] } });
    let problems: string[] = [];
    expect(() => { problems = executor.articleDigestStreamsMismatch(odd, articlePlan('Steam')); }).not.toThrow();
    expect(problems).toContain('pipelines[0] has no usable outputFolder');
    expect(() => executor.articleDigestStreamsMismatch(homeWith({ digest: { streams: [{ folder: 'A' }] }, pipelines: { toString: null } }), { steps: { longform: true, list: 'x' } })).not.toThrow();
  });

  it('names a pipeline whose folder name matches but is not next to the digest', () => {
    const elsewhere = pipelines.map((p) => (p.id === 'dev' ? { ...p, outputFolder: '/sdcard/Vault/Archive/Dev/' } : p));
    const home = homeWith({ version: 1, pipelines: elsewhere, digest });
    expect(executor.articleDigestStreamsMismatch(home, articlePlan('Steam'))).toEqual(['pipelines[1] folder "Dev" is not next to the digest\'s folder']);
    // The same storage under another name is the same folder.
    const aliased = pipelines.map((p) => ({ ...p, outputFolder: p.outputFolder.replace('/sdcard', '/storage/emulated/0') }));
    expect(executor.articleDigestStreamsMismatch(homeWith({ version: 1, pipelines: aliased, digest }), articlePlan('Steam'))).toEqual([]);
  });

  it('names a digest plan whose folder moved away from the file\'s digest folder', () => {
    const moved = { ...digest, outputFolder: '/sdcard/NewVault/50_Drafts/Digest/' };
    const movedPipelines = pipelines.map((p) => ({ ...p, outputFolder: p.outputFolder.replace('/sdcard/Vault', '/sdcard/NewVault') }));
    const home = homeWith({ version: 1, pipelines: movedPipelines, digest: moved });
    expect(executor.articleDigestStreamsMismatch(home, digestPlan(FOLDERS))).toEqual([
      "this digest's folder is not next to the file's digest folder (re-create the digest)",
    ]);
  });

  it('names a stream that is the digest\'s own folder (the scan skips it)', () => {
    const shared = { ...digest, outputFolder: `${VAULT}/Steam/` };
    const home = homeWith({ version: 1, pipelines, digest: shared });
    expect(executor.articleDigestStreamsMismatch(home, articlePlan('Dev'))).toContain('digest.streams[0] folder "Steam" is the digest\'s own folder, which the digest skips');
  });

  it('names a saved digest plan that still saves into one of its own streams', () => {
    const home = homeWith({ version: 1, pipelines, digest });
    const stale = { ...digestPlan(FOLDERS), output: { outputDir: `${VAULT}/Steam/` } };
    expect(executor.articleDigestStreamsMismatch(home, stale)).toContain('this digest\'s stream folder "Steam" is the digest\'s own folder, which the digest skips');
  });

  it('the saved-plan collision is reported with no file, no digest section, a dot path, or many other problems', () => {
    const stale = { ...digestPlan(FOLDERS), output: { outputDir: `${VAULT}/Steam/` } };
    const line = 'this digest\'s stream folder "Steam" is the digest\'s own folder, which the digest skips';
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-obs-cfg-'));
    expect(executor.articleDigestStreamsMismatch(empty, stale)).toEqual([line]);
    expect(executor.articleDigestStreamsMismatch(homeWith({ version: 1, pipelines }), stale)).toEqual([line]);
    const dotted = { ...stale, output: { outputDir: `${VAULT}/Steam/.` } };
    const ok = homeWith({ version: 1, pipelines, digest: { ...digest, outputFolder: `${VAULT}/Digest/` } });
    expect(executor.articleDigestStreamsMismatch(ok, dotted)).toEqual([line]);
    const noisy = homeWith({ version: 1, pipelines: Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, outputFolder: `${VAULT}/X${i}/` })), digest });
    const problems = executor.articleDigestStreamsMismatch(noisy, stale);
    expect(problems).toHaveLength(20);
    expect(problems[0]).toBe(line);
  });

  it('names a stream added to the file that this digest plan does not list yet', () => {
    const home = homeWith({ version: 1, pipelines, digest });
    expect(executor.articleDigestStreamsMismatch(home, digestPlan(FOLDERS.filter((f) => f !== 'VintageEn')))).toEqual([
      'the file\'s stream folder "VintageEn" is not in this digest (re-create the digest to list it)',
    ]);
  });

  it('a linked agents folder is not followed to another config file', () => {
    if (!fs.existsSync('/proc/self/fd')) return;
    const other = homeWith({ version: 1, pipelines: pipelines.map((p) => ({ ...p, outputFolder: `${VAULT}/Other-${p.id}/` })), digest });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-obs-cfg-'));
    fs.mkdirSync(path.join(home, '.shelly'));
    fs.symlinkSync(path.join(other, '.shelly', 'agents'), path.join(home, '.shelly', 'agents'));
    expect(executor.articleDigestStreamsMismatch(other, articlePlan('Steam')).length).toBeGreaterThan(0);
    expect(executor.articleDigestStreamsMismatch(home, articlePlan('Steam'))).toEqual([]);
  });

  it('a hard-linked config file is not read', () => {
    const other = homeWith({ version: 1, pipelines: pipelines.map((p) => ({ ...p, outputFolder: `${VAULT}/Other-${p.id}/` })), digest });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-obs-cfg-'));
    fs.mkdirSync(path.join(home, '.shelly', 'agents'), { recursive: true });
    fs.linkSync(path.join(other, '.shelly', 'agents', 'article-pipelines.json'), path.join(home, '.shelly', 'agents', 'article-pipelines.json'));
    expect(executor.articleDigestStreamsMismatch(home, articlePlan('Steam'))).toEqual([]);
  });

  it('a FIFO in place of the config file does not stall the run', () => {
    if (process.platform === 'win32') return;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-obs-cfg-'));
    fs.mkdirSync(path.join(home, '.shelly', 'agents'), { recursive: true });
    require('child_process').execFileSync('mkfifo', [path.join(home, '.shelly', 'agents', 'article-pipelines.json')]);
    expect(executor.articleDigestStreamsMismatch(home, articlePlan('Steam'))).toEqual([]);
  });

  it('no file, no digest, a symlink or broken JSON: nothing to report, never throws', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-obs-cfg-'));
    expect(executor.articleDigestStreamsMismatch(empty, articlePlan('Steam'))).toEqual([]);
    expect(executor.articleDigestStreamsMismatch(homeWith({ version: 1, pipelines }), articlePlan('Nope'))).toEqual([]);
    const broken = homeWith({});
    fs.writeFileSync(path.join(broken, '.shelly', 'agents', 'article-pipelines.json'), '{');
    expect(executor.articleDigestStreamsMismatch(broken, articlePlan('Steam'))).toEqual([]);
    const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-obs-cfg-'));
    fs.mkdirSync(path.join(linked, '.shelly', 'agents'), { recursive: true });
    const real = path.join(homeWith({ version: 1, pipelines: [], digest }), '.shelly', 'agents', 'article-pipelines.json');
    fs.symlinkSync(real, path.join(linked, '.shelly', 'agents', 'article-pipelines.json'));
    expect(executor.articleDigestStreamsMismatch(linked, articlePlan('Steam'))).toEqual([]);
  });
});
