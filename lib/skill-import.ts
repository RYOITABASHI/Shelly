/**
 * lib/skill-import.ts — SKILL-001: local import of external SKILL.md-format
 * skills (the open standard shared by Claude Code / Codex CLI / Gemini CLI)
 * with quarantine + explicit human approval before use.
 *
 * Sits alongside lib/agent-skills.ts's G3 skill registry (which distills the
 * user's OWN successful agent runs) — this module handles skills authored by
 * someone else and imported from disk. An imported skill only becomes usable
 * (readApprovedImportedSkillsAsRecipes) after the user explicitly promotes it
 * out of quarantine; nothing here auto-trusts external content.
 *
 * Same IO discipline as agent-skills.ts: writes/deletes/renames go through a
 * caller-supplied `runCommand` shell callback (crash-safe `set -e` + verified
 * postcondition), never a direct FileSystem write — this project never writes
 * agent-managed content by calling a filesystem-write API from JS directly,
 * for parity with how the underlying terminal/agent scripts read the same
 * files. Reads of already-imported, app-managed (absolute, non-`~`) paths use
 * expo-file-system directly, same as agent-skills.ts's readSkillRecipes.
 *
 * Pure helpers (frontmatter parse, content validation) are IO-free and
 * exported for direct unit testing.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { getHomePath } from '@/lib/home-path';
import { tokenizeForMatch } from '@/lib/agent-text-match';
import { deriveTrigger, type SkillRecipe } from '@/lib/agent-skills';

/** Lowercase letters, digits, hyphens; no leading/trailing hyphen; single char OK. */
export const SKILL_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
export const MAX_NAME_CHARS = 64;
export const MAX_DESCRIPTION_CHARS = 1024;

export interface ParsedSkillMd {
  name: string;
  description: string;
  body: string;
}

export interface QuarantinedSkill {
  name: string;
  description: string;
  sourcePath: string;
  importedAt: string;
  warnings: string[];
}

export interface ImportedSkill {
  name: string;
  description: string;
  body: string;
  importedAt: string;
  approvedAt: string;
}

/**
 * Same shape as TerminalEmulator.execCommand / hooks/use-native-exec's
 * execCommand: resolves with the raw result (never throws on a non-zero
 * exit), so callers pass e.g. `(cmd) => TerminalEmulator.execCommand(cmd, 30_000)`
 * directly. Every caller of this module (lib/pseudo-shell.ts, Sidebar.tsx)
 * passes exactly that.
 */
export type RunCommand = (cmd: string) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>;

/** Run [cmd], normalizing a thrown native-module error into a failed result
 *  (exitCode !== 0) so callers only need one failure path. */
async function safeRun(
  runCommand: RunCommand,
  cmd: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  try {
    return await runCommand(cmd);
  } catch (e: any) {
    return { stdout: '', stderr: String(e?.message ?? e), exitCode: -1 };
  }
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Shell-safe expression for a source path that may start with `~`. A plain
 * shellQuote() of the whole string would prevent tilde expansion (quoting
 * disables it), so a leading `~/` is left unquoted (tilde-prefix is only
 * recognized unquoted, at the start of a word, and POSIX shells stop the
 * tilde-prefix at the first `/`) while the remainder is quoted normally.
 */
function shellPathExpr(path: string): string {
  if (path === '~') return '~';
  if (path.startsWith('~/')) return '~/' + shellQuote(path.slice(2));
  return shellQuote(path);
}

function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

export function quarantineDir(home: string): string {
  return `${home}/.shelly/agents/skills-quarantine`;
}

export function importedDir(home: string): string {
  return `${home}/.shelly/agents/skills-imported`;
}

/**
 * Split a SKILL.md's frontmatter block from its body. NOT a full YAML parser
 * — v1 only needs two scalar top-level fields (name, description), so each
 * frontmatter line is parsed as a simple `key: value` pair.
 */
export function parseSkillMdFrontmatter(
  raw: string
): { fields: Record<string, string>; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const [, frontmatter, rest] = match;
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    fields[key] = value;
  }
  return { fields, body: rest.trim() };
}

/**
 * Validate a raw SKILL.md's content against the folder it's expected to live
 * in. Accumulates ALL applicable errors (does not short-circuit) so a human
 * importing a skill sees every problem in one pass.
 */
export function validateSkillMdContent(
  raw: string,
  folderName: string
): { valid: boolean; errors: string[]; warnings: string[] } {
  const parsed = parseSkillMdFrontmatter(raw);
  if (!parsed) {
    return {
      valid: false,
      errors: ['SKILL.md has no valid frontmatter block (missing --- delimiters)'],
      warnings: [],
    };
  }
  const { fields, body } = parsed;
  const errors: string[] = [];
  const warnings: string[] = [];

  const name = fields.name;
  if (!name) {
    errors.push('name is required');
  } else {
    const nameShapeValid = SKILL_NAME_RE.test(name);
    if (!nameShapeValid) {
      errors.push(
        `name "${name}" must be lowercase letters, numbers, and hyphens only, and cannot start or end with a hyphen`
      );
    }
    if (name.length > MAX_NAME_CHARS) {
      errors.push(`name must be ${MAX_NAME_CHARS} characters or fewer`);
    }
    if (nameShapeValid && name !== folderName) {
      errors.push(`name "${name}" must exactly match the folder name "${folderName}"`);
    }
  }

  // A `description: |` / `description: >` YAML block-scalar means the naive
  // line-parser above only captured the indicator char (or nothing useful) as
  // the value — diagnose that specifically instead of reporting a confusing
  // "description is required".
  const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const frontmatterText = frontmatterMatch ? frontmatterMatch[1] : '';
  const isBlockScalarDescription = /^description:\s*[|>]/m.test(frontmatterText);
  const description = fields.description;
  if (isBlockScalarDescription) {
    errors.push(
      'description must be a single-line scalar value, multi-line block scalars ("description: |") are not supported'
    );
  } else if (!description) {
    errors.push('description is required');
  } else if (description.length > MAX_DESCRIPTION_CHARS) {
    errors.push(`description must be ${MAX_DESCRIPTION_CHARS} characters or fewer`);
  }

  const estimatedTokens = body.length / 4;
  if (estimatedTokens > 5000) {
    warnings.push(
      `skill body is large (~${Math.round(estimatedTokens)} estimated tokens); recommended under 5000`
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Read + validate an already-resolved, app-managed SKILL.md path (absolute,
 * no `~`) via expo-file-system. For arbitrary user-typed paths (which may
 * contain `~`, unresolvable from pure JS), see importSkillToQuarantine's
 * shell-based read instead.
 */
export async function validateSkillMdAtPath(
  dirPath: string
): Promise<{ valid: boolean; errors: string[]; warnings: string[]; parsed?: ParsedSkillMd }> {
  const segments = dirPath.split('/').filter(Boolean);
  const folderName = segments[segments.length - 1] || '';
  let raw: string;
  try {
    const fileUri = toFileUri(`${dirPath.replace(/\/+$/, '')}/SKILL.md`);
    raw = await FileSystem.readAsStringAsync(fileUri);
  } catch {
    return { valid: false, errors: [`SKILL.md not found at ${dirPath}`], warnings: [] };
  }
  const result = validateSkillMdContent(raw, folderName);
  if (!result.valid) return result;
  const fm = parseSkillMdFrontmatter(raw);
  return {
    ...result,
    parsed: fm ? { name: fm.fields.name, description: fm.fields.description, body: fm.body } : undefined,
  };
}

/**
 * Copy an external skill folder into quarantine (never directly usable —
 * requires promoteSkillFromQuarantine before it's returned by
 * readApprovedImportedSkillsAsRecipes). Uses a shell round-trip to read the
 * source (so `~` and other shell-only path forms resolve correctly, unlike
 * expo-file-system) and a crash-safe `set -e` + verified-postcondition write,
 * mirroring lib/agent-skills.ts's buildSkillWriteCommand.
 */
export async function importSkillToQuarantine(
  sourcePath: string,
  runCommand: RunCommand
): Promise<{ ok: boolean; name?: string; errors: string[]; warnings: string[] }> {
  if (!sourcePath.startsWith('/') && !sourcePath.startsWith('~')) {
    return {
      ok: false,
      errors: ['use an absolute path or ~/... (relative paths are not supported)'],
      warnings: [],
    };
  }
  const srcExpr = shellPathExpr(sourcePath);

  const catResult = await safeRun(runCommand, `test -f ${srcExpr}/SKILL.md && cat ${srcExpr}/SKILL.md`);
  if (catResult.exitCode !== 0) {
    return { ok: false, errors: [`SKILL.md not found at ${sourcePath}`], warnings: [] };
  }
  const raw = catResult.stdout;

  const baseResult = await safeRun(runCommand, `basename ${srcExpr}`);
  if (baseResult.exitCode !== 0 || !baseResult.stdout.trim()) {
    return { ok: false, errors: [`could not resolve folder name for ${sourcePath}`], warnings: [] };
  }
  const folderName = baseResult.stdout.trim();

  const validation = validateSkillMdContent(raw, folderName);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors, warnings: validation.warnings };
  }
  const fm = parseSkillMdFrontmatter(raw);
  const name = fm!.fields.name;
  const description = fm!.fields.description;

  const home = getHomePath();
  const destDir = `${quarantineDir(home)}/${name}`;
  const metaFile = `${destDir}/.shelly-import-meta.json`;
  const meta = {
    name,
    description,
    sourcePath,
    importedAt: new Date().toISOString(),
    approvedAt: null as string | null,
    warnings: validation.warnings,
  };
  const marker = `SHELLY_SKILLMETA_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const script = [
    'set -e',
    `mkdir -p ${shellQuote(destDir)}`,
    `cp -r ${srcExpr}/. ${shellQuote(destDir)}/`,
    `cat > ${shellQuote(metaFile)} <<'${marker}'`,
    JSON.stringify(meta, null, 2),
    marker,
    `[ -f ${shellQuote(`${destDir}/SKILL.md`)} ] || { echo "skill import failed: ${name}" >&2; exit 1; }`,
  ].join('\n');

  const writeResult = await safeRun(runCommand, script);
  if (writeResult.exitCode !== 0) {
    return {
      ok: false,
      errors: [`import failed: ${writeResult.stderr || `exit ${writeResult.exitCode}`}`],
      warnings: [],
    };
  }
  return { ok: true, name, errors: [], warnings: validation.warnings };
}

interface ImportMeta {
  name: string;
  description: string;
  sourcePath: string;
  importedAt: string;
  approvedAt: string | null;
  warnings: string[];
}

/**
 * List subdirectories of [dir], each expected to hold a SKILL.md + a
 * .shelly-import-meta.json sidecar. Reads via expo-file-system (these are
 * already-resolved, app-managed absolute paths). Never lets one malformed
 * entry crash the list — matches agent-skills.ts's readSkillRecipes.
 */
async function listSkillMetaDir<T>(
  dir: string,
  build: (meta: ImportMeta, body: string) => T | null
): Promise<T[]> {
  try {
    const dirUri = toFileUri(dir);
    const info = await FileSystem.getInfoAsync(dirUri);
    if (!info.exists || !info.isDirectory) return [];
    const names = await FileSystem.readDirectoryAsync(dirUri);
    const out: T[] = [];
    for (const name of names) {
      try {
        const entryUri = `${dirUri}/${name}`;
        const entryInfo = await FileSystem.getInfoAsync(entryUri);
        if (!entryInfo.exists || !entryInfo.isDirectory) continue;
        const metaRaw = await FileSystem.readAsStringAsync(`${entryUri}/.shelly-import-meta.json`);
        const meta = JSON.parse(metaRaw) as ImportMeta;
        const skillMdRaw = await FileSystem.readAsStringAsync(`${entryUri}/SKILL.md`);
        const fm = parseSkillMdFrontmatter(skillMdRaw);
        const item = build(meta, fm ? fm.body : skillMdRaw);
        if (item) out.push(item);
      } catch {
        // Skip malformed or concurrently-written entries.
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function listQuarantinedSkills(home: string): Promise<QuarantinedSkill[]> {
  return listSkillMetaDir<QuarantinedSkill>(quarantineDir(home), (meta) => ({
    name: meta.name,
    description: meta.description,
    sourcePath: meta.sourcePath,
    importedAt: meta.importedAt,
    warnings: meta.warnings ?? [],
  }));
}

export async function listImportedSkills(home: string): Promise<ImportedSkill[]> {
  return listSkillMetaDir<ImportedSkill>(importedDir(home), (meta, body) => {
    if (!meta.approvedAt) return null;
    return {
      name: meta.name,
      description: meta.description,
      body,
      importedAt: meta.importedAt,
      approvedAt: meta.approvedAt,
    };
  });
}

/** Defense against path-traversal-shaped names even though callers should
 *  only ever pass names sourced from listQuarantinedSkills/listImportedSkills. */
function assertSafeSkillName(name: string): string | null {
  if (!SKILL_NAME_RE.test(name)) return `refusing unsafe skill name: ${name}`;
  return null;
}

export async function promoteSkillFromQuarantine(
  name: string,
  home: string,
  runCommand: RunCommand
): Promise<{ ok: boolean; error?: string }> {
  const nameError = assertSafeSkillName(name);
  if (nameError) return { ok: false, error: nameError };

  const src = `${quarantineDir(home)}/${name}`;
  const dest = `${importedDir(home)}/${name}`;
  const metaFile = `${dest}/.shelly-import-meta.json`;

  const moveResult = await safeRun(
    runCommand,
    [
      'set -e',
      `mkdir -p ${shellQuote(importedDir(home))}`,
      `mv ${shellQuote(src)} ${shellQuote(dest)}`,
      `[ -d ${shellQuote(dest)} ] || { echo "promote failed: ${name}" >&2; exit 1; }`,
      `cat ${shellQuote(metaFile)}`,
    ].join('\n')
  );
  if (moveResult.exitCode !== 0) {
    return { ok: false, error: moveResult.stderr || `exit ${moveResult.exitCode}` };
  }

  let meta: Partial<ImportMeta>;
  try {
    meta = JSON.parse(moveResult.stdout);
  } catch {
    meta = {};
  }
  meta.approvedAt = new Date().toISOString();
  const marker = `SHELLY_SKILLMETA_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  const writeResult = await safeRun(
    runCommand,
    [
      'set -e',
      `cat > ${shellQuote(metaFile)} <<'${marker}'`,
      JSON.stringify(meta, null, 2),
      marker,
      `[ -f ${shellQuote(metaFile)} ] || { echo "meta write failed: ${name}" >&2; exit 1; }`,
    ].join('\n')
  );
  if (writeResult.exitCode !== 0) {
    return { ok: false, error: writeResult.stderr || `exit ${writeResult.exitCode}` };
  }
  return { ok: true };
}

async function removeSkillDir(
  name: string,
  dir: string,
  runCommand: RunCommand
): Promise<{ ok: boolean; error?: string }> {
  const nameError = assertSafeSkillName(name);
  if (nameError) return { ok: false, error: nameError };

  const target = `${dir}/${name}`;
  const result = await safeRun(
    runCommand,
    [
      'set -e',
      `rm -rf ${shellQuote(target)}`,
      `[ ! -d ${shellQuote(target)} ] || { echo "delete failed: ${name}" >&2; exit 1; }`,
    ].join('\n')
  );
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr || `exit ${result.exitCode}` };
  }
  return { ok: true };
}

export async function rejectQuarantinedSkill(
  name: string,
  home: string,
  runCommand: RunCommand
): Promise<{ ok: boolean; error?: string }> {
  return removeSkillDir(name, quarantineDir(home), runCommand);
}

export async function deleteImportedSkill(
  name: string,
  home: string,
  runCommand: RunCommand
): Promise<{ ok: boolean; error?: string }> {
  return removeSkillDir(name, importedDir(home), runCommand);
}

export function importedSkillToRecipe(skill: ImportedSkill): SkillRecipe {
  const tags = [...tokenizeForMatch(skill.description)].slice(0, 6);
  return {
    id: 'imported-' + skill.name,
    name: skill.name,
    trigger: deriveTrigger(skill.description),
    prompt: skill.body,
    route: 'on-device',
    toolLabel: 'Imported skill',
    tags,
    successCount: 0,
    lastUsed: skill.importedAt,
    created: skill.importedAt,
    source: 'imported',
  };
}

export async function readApprovedImportedSkillsAsRecipes(home: string): Promise<SkillRecipe[]> {
  return (await listImportedSkills(home)).map(importedSkillToRecipe);
}
